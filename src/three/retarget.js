// 관절 위치 → VRM 본 회전 리타깃. 실시간(MediaPipe) 모드와 FreeMoCap 재생 모드가 공유한다.
//
// 이 모듈은 SkeletonAvatar.js 에서 그대로 옮겨온 것이고, 로직은 한 줄도 바뀌지 않았다.
// 유일한 차이는 "랜드마크 → three 좌표" 변환을 밖에서 주입받는다는 점이다:
//
//   실시간   : place(out, lm, mirror, origin)  — 정규화 좌표 + 거울 + 몸통 중심
//   FreeMoCap: place3D(out, p, center, transform, basis) — 실제 3D + 축 정렬
//
// 리타깃이 쓰는 건 "위치의 차이 = 방향 벡터"뿐이라 스케일과 평행이동은 전부 상쇄된다.
// 그래서 축 방향만 맞으면 같은 코드가 두 소스에 모두 동작한다.
//
// 상태(방향 EMA 슬롯 · 본별 마지막 신뢰 목표)는 인스턴스마다 따로 들고 있으므로
// 두 모드가 같은 클래스를 써도 서로의 스무딩에 간섭하지 않는다.

import * as THREE from 'three';
import {
  QuatOneEuro, AngleStats, quatAngleDeg, isFiniteQuat,
} from './retargetSmoothing.js';

// ===========================================================================
// 리타깃 튜닝 상수 — 떨림/펄럭임이 보이면 여기만 만지면 된다.
//
// 신호는 세 단계로 걸러진다:
//   랜드마크 → [z 가중치] → [방향벡터 EMA] → 회전 계산 → [연속성 강제] → [One Euro] → 본
// 앞단(방향벡터 EMA)은 z 가 한 프레임 튈 때의 방향 급변을 잡고,
// 뒷단(One Euro)은 "위치 → 각도" 변환에서 증폭된 잔여 떨림을 흡수한다.
// 그 사이의 연속성 강제는 떨림이 아니라 "스냅"(홱 도는 것) 담당이다.
//
// 한때 여기 "팔 폄 구간 전완 roll 감쇠"가 있었지만 제거했다.
// 전제("팔이 펴지면 roll 은 물리적으로 미결정 = 노이즈")가 수어에서는 틀렸다:
// 수어는 팔을 뻗은 채 손목을 회내/회외로 돌려 의미를 만든다. 실측(613프레임)에서
// 팔 폄 구간이 전체의 45%인데 그 구간의 손목이 median 1.3~1.9°/프레임으로 실제
// 회전 중이었고, 감쇠는 그걸 얼렸다가 팔이 굽는 순간 튀어나오게 만들었다.
// roll 노이즈는 One Euro 가 적응형으로(느리면 스무딩·빠르면 통과) 이미 올바르게 처리한다.
// ===========================================================================

// ===========================================================================
// A/B 격리 토글 — 버벅임/떨림의 원인을 하나씩 끄면서 좁히기 위한 것.
// false 로 두면 그 로직만 우회하고 나머지는 그대로 간다(원래 경로로 복귀).
// ===========================================================================
const FIX_NORMAL_CONTINUITY = true;  // 손바닥 법선 부호 교정 (+ 아래 램프의 상위 스위치)
const FIX_ONE_EURO = true;           // 최종 회전 One Euro (끄면 예전 고정 slerp)
const FIX_BASIS_SNAP_REJECT = true;  // 퇴화 프레임의 기저 통째 회전 리젝트
// 램프만 따로 끄는 하위 토글. false 면 부호교정과 시드는 그대로 두고
// n.lerp(prev, 1-rel) 블렌드만 건너뛴다 — edge-on 흔들림을 출력단 One Euro 에 맡기는 실험.
// 배경(실측): 램프는 rel=0 구간에서 lerp(prev, 1) = 사실상 완전 홀드라, 손이 옆으로 선
// 정지 자세에서 법선을 직전 쪽으로 계속 끌어온다. 439클립 오른손 frame 114~124 에서
// 손목 이동 총합 0.051 · 굴곡 12°→1°(더 펴짐)인데 sin 0.29→0.075 구간을 지나며
// 법선이 136° 누적으로 끌려 데이터에 없는 손목 꺾임이 생겼다.
// 90°+ 뒤집힘이 아니라 flipLeft 카운터에는 안 잡힌다.
const FIX_NORMAL_REL_RAMP = false; // ← A/B 실험 중. 커밋 전 true 로 되돌릴 것.
// 켜지 말 것: 주먹(손 크기 축소)을 가림으로 오판해 손모양을 뭉갠다 — 실측 확인된 버그.
const FIX_OCCLUSION_FINGERS = false; // 가림 프레임의 손가락 타깃 완화

// [One Euro 필터] 최종 회전에 거는 적응형 저역통과. 아래 고정 slerp 계수를 대체한다.
//   minCutoff [Hz]         : 정지 상태의 세기. 낮출수록 조용하지만 둔해진다.
//   beta [Hz per (rad/s)]  : 빠를수록 컷오프를 얼마나 올릴지. 높이면 빠른 동작이 안 끌린다.
//
// 30fps 기준 정지 시 alpha = 1/(1 + 1/(2π·minCutoff·dt)):
//   minCutoff 1.0 → 0.17 (기존 팔 slerp 0.30 보다 조용)
//   minCutoff 4.0 → 0.46 (기존 손가락 slerp 0.40 과 거의 같음 = 수형 보존)
//
// beta 주의: 요청받은 시작값은 0.01/0.02 였지만, 이 구현의 speed 는 rad/s 단위다.
// 이 녹화의 빠른 구간(팔꿈치 p95 10°/프레임 ≈ 5.2 rad/s)에서도 fc 가 1.0 → 1.05 로만
// 올라가 사실상 비적응(=그냥 느린 저역통과)이 되고 지연만 남는다.
// 그래서 "5 rad/s 에서 fc 가 4 Hz 쯤으로 올라가도록" 역산한 값을 기본값으로 뒀다.
// 원래 값이 필요하면 이 두 줄만 0.01 / 0.02 로 바꾸면 된다.
// legacy = FIX_ONE_EURO 를 끌 때 쓸 예전 고정 slerp 계수 (아래 SMOOTH_* 재사용).
export const OE_ARM = { minCutoff: 1.0, beta: 0.6, legacy: 0.3 };
export const OE_WRIST = { minCutoff: 1.0, beta: 0.6, legacy: 0.3 };
// 손가락은 "거의 통과". 수어는 손가락이 빠르고 세밀해서 세게 걸면 지문자·수형이 뭉개진다.
export const OE_FINGER = { minCutoff: 4.0, beta: 1.0, legacy: 0.4 };
// 이보다 오래 이 본이 안 불렸으면 트래킹이 끊겼다 재개된 것으로 보고 상태를 스냅한다.
export const RESET_GAP_SEC = 0.5;

// [손바닥 법선 연속성] 손이 카메라에 옆으로 서면 세 점이 거의 일직선이 되어
// 법선 방향이 모호해지고, 부호가 뒤집히면서 손목이 홱 비틀리는 스냅이 나온다.
// f·l 이 둘 다 단위벡터라 ‖f×l‖ = sin(사잇각) → 손 크기와 무관한 척도다.
// 0.15 ≈ 8.6°. 지금은 이 값이 "통째로 hold" 하는 하드 컷이 아니라 아래 램프의 하한이다
// (스냅 리젝트가 검토할 "퇴화 프레임" 기준으로도 계속 쓰인다).
export const NORMAL_SIN_EPS = 0.15;

// [손등(dorsal) 앵커] n = sign·(F × l). F×l 은 유사벡터라 좌우 손에서 반대 방향
// (한쪽은 손등·다른 쪽은 손바닥)을 가리킨다. 여기 부호를 걸면 n 의 의미가
// "해부학적 손등"으로 고정된다 — 는 게 원래 의도였는데, 실제로는 런타임 영향이 0이다:
// applyWrist 가 rest basis 와 목표 basis 에 같은 레시피를 쓰고
// qLocal = parentQ⁻¹·qTarget·qRest⁻¹ 에서 부호가 정확히 상쇄되기 때문이다
// (n 을 뒤집으면 basis 가 F 축 둘레로 180° 도는데, rest·목표 양쪽에 같은 180° 라 소거).
// 한쪽에만 걸면 그 손이 통째로 180° 비틀린다. 그래서 곱하지 않고 불변식 표시로만 남긴다.
export const DORSAL_SIGN = { left: -1, right: 1 };

// [법선 신뢰도 램프] 하드 컷("sin < NORMAL_SIN_EPS 면 직전 법선 통째 hold")을 대신한다.
//   rel = smoothstep(sin, LO, HI)
//     0 = 손이 카메라에 옆으로 서서 법선이 무의미 → 직전 법선에 전적으로 기댄다
//     1 = 충분히 안정 → 이번 프레임 법선 그대로 (실제 회전을 죽이지 않는다)
// 실측: 팔을 뻗으면 sin median 0.43~0.45, 굽히면 0.59~0.60. HI=0.40 이면 정상 구간은
// 양쪽 다 rel=1 로 통과하고, 진짜 edge-on 으로 무너지는 프레임만 램프에 걸린다.
export const NORMAL_REL_LO = NORMAL_SIN_EPS;
export const NORMAL_REL_HI = 0.40;

// 법선 부호를 고쳤는데도 기저 전체가 한 프레임에 이만큼 돌면(그런데 손이 향하는
// 방향은 거의 안 변했으면) 물리적으로 불가능한 비틀림 스냅으로 보고 그 프레임을 버린다.
//
// 단, "퇴화 프레임(‖F×l‖ < NORMAL_SIN_EPS = 손이 카메라에 옆으로 섬)"에서만 검토한다.
// 비퇴화 프레임의 큰 회전은 진짜 손목 동작일 수 있고(수어는 실제로 그렇게 빠르다),
// 그걸 홀드하면 그 홀드 자체가 버벅임이 된다. 실측상 raw 법선 100°+ 이벤트
// (왼손 18·오른손 17회)는 상당수가 퇴화 구간(sin<0.15: 왼손 62·오른손 84프레임)과 겹친다.
export const BASIS_SNAP_DEG = 100;
export const BASIS_SNAP_FWD_DEG = 45;
// 연속으로 이만큼 버렸으면 노이즈가 아니라 진짜 새 자세로 보고 받아들인다.
// 1 = 최대 한 프레임만 홀드. 빠른 손목 회전을 여러 프레임 얼리면 그게 버벅임이다.
export const BASIS_SNAP_MAX_HOLD = 1;

// ===========================================================================
// [손 가림(occlusion) 완화] — 손가락 전용 백스톱.
//
// 실측(613프레임): 가림은 손목 "위치"가 아니라 손 모양(손가락 재구성)을 깨뜨린다.
// 손 크기가 median 대비 25%+ 왜곡되는 프레임이 왼손 91 · 오른손 119 인데, 흩어져
// 있지 않고 뭉쳐 있다(166~182 · 564~584 처럼 17~21프레임 연속 = 지속적 가림).
// 그 구간에서 손목은 대충 맞는데 손가락만 쪼그라들거나 튀어 손 전체가 떨린다.
//
// 이건 복원이 아니라 "떨림을 짧은 정지/블렌드로 바꾸는" 백스톱이다. 20프레임 넘는
// 연속 가림은 정보 자체가 없어 복원 불가 — 그건 카메라 재배치 후 재촬영 문제다.
// ===========================================================================

// 손 스케일 s = mean(‖손끝_i − 손목‖). 기준 대비 이만큼 벗어나면 occ = 1 (완전 홀드).
export const OCC_DEV_THRESH = 0.25;
// occ 가 이 미만이면 "양호 프레임" — 완화를 아예 타지 않고(원본 통과) 기준을 갱신한다.
// 이 분기 덕분에 멀쩡한 프레임이 과완화될 구조적 여지가 없다.
export const OCC_GOOD_THRESH = 0.15;
// 손가락 벌어짐(손끝 거리들의 표준편차)이 기준의 이 배수 아래로 떨어지면 = 손이
// 뭉개져 한 점으로 모인 것. 크기가 우연히 맞아도 이건 가림이다 → occ 를 최소 0.8 로.
export const OCC_SPREAD_COLLAPSE = 0.4;
export const OCC_SPREAD_SCORE = 0.8;
// 기준 EMA 계수. 양호 프레임에서만 갱신하므로 가림이 기준을 오염시키지 못한다.
export const OCC_REF_SMOOTH = 0.2;
// 연속 가림이 이보다 길어지면 홀드를 서서히 푼다. 20프레임 ≈ 0.7s.
// 0.7초 넘게 얼려두면 그게 더 부자연스럽고, 가림이 풀리는 순간 크게 튄다.
// 떨림을 감수하더라도 무한 프리즈보다 낫다.
export const OCC_MAX_HOLD = 20;
export const OCC_DECAY_FRAMES = 15; // 이만큼에 걸쳐 홀드 가중치를 0 으로

// [검증 계측] true 면 STAT_INTERVAL_SEC 마다 필터 전/후 |ΔAngle| 통계와
// 법선 뒤집힘 카운트를 콘솔에 찍는다. 브라우저 콘솔에서 window.__retargetStats() 로도 부를 수 있다.
export const RETARGET_DEBUG = true;
export const STAT_INTERVAL_SEC = 4;
// 통계를 낼 본 (증폭 지점만 — 손가락 30본까지 찍으면 읽을 수가 없다)
const STAT_BONES = new Set(['leftHand', 'rightHand', 'leftLowerArm', 'rightLowerArm']);
// 가림 완화 전/후를 잴 손가락 본 (대표 몇 개만 — 30본 전부는 로그가 못 읽게 된다)
const STAT_OCC_BONES = new Set([
  'leftIndexProximal', 'leftMiddleProximal',
  'rightIndexProximal', 'rightMiddleProximal',
]);

// [회전 slerp 계수] One Euro 도입 전의 고정 계수. 지금은 쓰이지 않지만,
// One Euro 를 끄고 예전 거동으로 되돌려 비교할 때를 위해 값만 남겨둔다.
export const SMOOTH_ARM = 0.3;
export const SMOOTH_WRIST = 0.3;
export const SMOOTH_FINGER = 0.4; // 손가락은 작고 빨라서 팔보다 조금 높게

// [방향벡터 EMA 계수] 회전으로 바꾸기 "전"의 목표 방향 자체를 이전 프레임과 섞는다.
// 낮추면 부드럽지만 둔해지고, 높이면 반응이 빠르다. 1 = 스무딩 없음(B-4b 까지의 동작).
// 정지 상태 떨림과 앞뒤 펄럭임에 가장 직접적으로 듣는 값.
export const DIR_SMOOTH_ARM = 0.4;
export const DIR_SMOOTH_WRIST = 0.4;
export const DIR_SMOOTH_FINGER = 0.4;

// [신뢰도 게이팅] MediaPipe pose 랜드마크에는 점마다 visibility(0~1) 가 있다.
// 가려지면 값이 떨어지는데, 그 상태의 좌표는 추측값이라 팔·손이 튄다.
// 임계 미만이면 그 본을 이번 프레임에 갱신하지 않고 "마지막 신뢰 목표"로만 수렴시킨다.
// (rest 로 리셋하는 게 아니라 마지막 신뢰 자세에서 부드럽게 멈춘다)
// 너무 높으면 정상 동작도 자주 멈춰 뻣뻣하고, 너무 낮으면 게이팅 효과가 없다.
// 손 랜드마크(21점)에는 visibility 가 없어서 게이팅되지 않는다 — 대신 pose 손목으로 막는다.
// FreeMoCap 좌표에도 visibility 가 없다 → 삼각측량된 값은 그대로 신뢰한다.
export const VIS_GATING = true;
export const VIS_THRESHOLD = 0.5;

// [z(깊이) 기여도] 방향 벡터의 z 성분에만 곱한다.
// MediaPipe 의 z 는 단일 웹캠 추정이라 앞뒤 펄럭임의 주원인이다.
// 1 = 그대로 사용. 낮추면 팔·손이 화면 평면에 가깝게 눕는 대신 앞뒤 흔들림이 준다.
// (팔은 pose z, 손가락·손목은 손목 기준 상대 z 라 스케일이 서로 다르다 — 따로 둔 이유)
// FreeMoCap 은 다중 카메라 삼각측량이라 z 가 실제 값이다 → 1 그대로가 맞다.
export const Z_WEIGHT_ARM = 1;
export const Z_WEIGHT_WRIST = 1;
export const Z_WEIGHT_FINGER = 1;

// 손가락 마디 매핑 테이블: 랜드마크 인덱스 체인 ↔ VRM 본 접미사 체인.
// lm[i] → lm[i+1] 방향이 bones[i] 본의 방향이 된다.
// (three-vrm v3 는 VRM0 모델도 VRM1.0 본 이름으로 정규화해준다 — 실측 확인.
//  그래서 엄지는 Metacarpal/Proximal/Distal 이고 ThumbIntermediate 는 없다.)
export const FINGER_CHAINS = [
  { lm: [1, 2, 3, 4], bones: ['ThumbMetacarpal', 'ThumbProximal', 'ThumbDistal'] },
  { lm: [5, 6, 7, 8], bones: ['IndexProximal', 'IndexIntermediate', 'IndexDistal'] },
  { lm: [9, 10, 11, 12], bones: ['MiddleProximal', 'MiddleIntermediate', 'MiddleDistal'] },
  { lm: [13, 14, 15, 16], bones: ['RingProximal', 'RingIntermediate', 'RingDistal'] },
  { lm: [17, 18, 19, 20], bones: ['LittleProximal', 'LittleIntermediate', 'LittleDistal'] },
];

// 이 랜드마크를 리타깃에 써도 되는지.
// visibility 가 없는 랜드마크(손 21점, FreeMoCap 좌표)는 잴 수 없으니 통과시킨다.
// 표준 smoothstep. lo 이하 0, hi 이상 1, 사이는 S 자로 부드럽게.
function smoothstep(x, lo, hi) {
  const t = THREE.MathUtils.clamp((x - lo) / (hi - lo), 0, 1);
  return t * t * (3 - 2 * t);
}

export function isVisible(lm) {
  if (!lm) return false;
  if (!VIS_GATING) return true;
  const v = lm.visibility;
  return v == null || v >= VIS_THRESHOLD;
}

// 인스턴스 구분용(실시간 / FreeMoCap 두 개가 동시에 살아 있을 수 있다)
let _instanceSeq = 0;

export class BoneRetargeter {
  // place: (outVec3, lm) => void — 랜드마크를 three 좌표로 옮긴다.
  //   호출부가 자기 좌표계 규약(거울/원점/축정렬)을 여기에 가둬서 넘긴다.
  //   NaN 좌표는 호출부가 미리 null 로 걸러서 넘겨야 한다.
  constructor(place, label = `r${++_instanceSeq}`) {
    this._place = place;
    this._label = label;
    // 위팔 리타깃용 스크래치
    this._armA = new THREE.Vector3();
    this._armB = new THREE.Vector3();
    this._armRest = new THREE.Vector3();
    this._armQ = new THREE.Quaternion();
    this._armTargetQ = new THREE.Quaternion();
    // 손목 basis 계산용 스크래치
    this._wF = new THREE.Vector3();
    this._wL = new THREE.Vector3();
    this._wX = new THREE.Vector3();
    this._wY = new THREE.Vector3();
    this._wZ = new THREE.Vector3();
    this._wM = new THREE.Matrix4();
    this._wRestQ = new THREE.Quaternion();
    this._wTargetQ = new THREE.Quaternion();
    // 방향벡터 EMA 슬롯: 키(본 이름 등) → 직전 프레임의 정규화된 방향.
    // 팔 4 + 손목 4(양손 f/l) + 손가락 30 정도가 들어간다.
    // 첫 유효 방향은 스냅해서, 0 에서 미끄러져 들어오는 게 안 보이게 한다.
    this._dirSlots = new Map();
    // 본별 "마지막으로 신뢰할 수 있었던 목표 회전". 신뢰도가 떨어진 프레임에는
    // 새 목표를 만들지 않고 이 값으로만 계속 수렴시킨다.
    this._boneTargets = new Map();

    // --- 스무딩/연속성 상태 (본별·손별로 완전히 독립) ---
    // 두 주입 경로는 서로 다른 BoneRetargeter 인스턴스를 쓰므로 여기서 또 갈릴 일은 없다.
    this._quatFilters = new Map(); // 본 이름 → QuatOneEuro
    this._normals = new Map();     // `${side}Hand` → Vector3  직전 손바닥 법선
    this._basisPrev = new Map();   // `${side}Hand` → {q, f}   직전 목표 기저(스냅 판정용)
    // 이번 프레임의 손바닥 평면이 퇴화했는지(손이 카메라에 옆으로 섰는지).
    // _makeHandBasis 가 재서 넣고, 바로 뒤의 _checkBasisContinuity 가 읽는다.
    this._basisDegen = false;
    // 손 가림 상태 (손별). applyFingers 가 프레임당 1회 갱신하고 손가락 본만 읽는다.
    this._occ = new Map();
    // 가림 감지용 스크래치
    this._occW = new THREE.Vector3();
    this._occT = new THREE.Vector3();
    this._occD = new Float64Array(5);
    this._occQ = new THREE.Quaternion();
    this._occStatPrev = new Map(); // 계측 전용: 본 이름 → 직전 프레임의 완화 전/후 타깃

    // --- 검증 계측 ---
    this._stats = new AngleStats();
    this._statsAt = 0;
    if (RETARGET_DEBUG && typeof window !== 'undefined') {
      // 여러 인스턴스가 있으면 마지막 것이 잡히지만, 실제로 동시에 도는 무대는 하나다.
      window.__retargetStats = () => this.logStats(true);
    }
  }

  // 모든 필터/연속성 상태를 비운다.
  // 호출해야 하는 곳: FreeMoCap 재생을 처음부터 다시 틀 때(또는 슬라이더로 크게 점프할 때),
  // 실시간 트래킹이 끊겼다 재개될 때. 초기화하지 않으면 클립 첫 프레임이 이전 상태에 끌려 튄다.
  // (실시간 경로는 dt > RESET_GAP_SEC 자동 감지로도 커버된다 — QuatOneEuro.filter 참고)
  resetSmoothing() {
    for (const f of this._quatFilters.values()) f.reset();
    this._normals.clear();
    this._basisPrev.clear();
    this._basisDegen = false;
    this._occ.clear();
    this._occStatPrev.clear();
    this._dirSlots.clear();
    this._boneTargets.clear();
    this._stats.reset();
    this._statsAt = 0;
  }

  // 한쪽 팔(위팔 + 아래팔). side 는 VRM 쪽 'left' | 'right'.
  // 위팔을 반드시 먼저. 아래팔은 부모(=위팔)의 "현재" 월드 회전을 읽어서
  // 목표 방향을 부모 공간으로 옮기므로, 순서가 뒤바뀌면 한 프레임 늦은
  // 부모 회전으로 계산돼 굽힘 방향이 틀어진다.
  applyArm(humanoid, shoulderLm, elbowLm, wristLm, side) {
    this._applyBoneDirection(humanoid, shoulderLm, elbowLm,
      `${side}UpperArm`, `${side}LowerArm`, Z_WEIGHT_ARM, DIR_SMOOTH_ARM, OE_ARM);
    this._applyBoneDirection(humanoid, elbowLm, wristLm,
      `${side}LowerArm`, `${side}Hand`, Z_WEIGHT_ARM, DIR_SMOOTH_ARM, OE_ARM);
  }

  // f(손목→중지뿌리)와 l(검지뿌리→새끼뿌리)로 직교정규 basis 를 만든다.
  // 두 벡터가 평행하면(손바닥 평면이 안 나오면) false.
  //
  // key 가 있으면 프레임 간 법선 연속성을 강제한다. rest basis 는 key 없이(=null) 불러야
  // 한다 — 정적인 값이라 연속성이 필요 없고, 목표 쪽 상태를 오염시키면 안 된다.
  // 좌우 손은 key 가 다르므로 상태가 섞이지 않는다.
  //
  // 목표 경로는 두 가지를 분리해서 한다:
  //   부호교정  — prev 가 있으면 항상. 반구를 손등 쪽으로 맞추기만 한다.
  //   블렌드    — rel < 1 (손이 옆으로 서서 법선을 못 믿는 구간)에서만 prev 쪽으로 당긴다.
  // 안정 프레임에서 블렌드를 안 하는 게 핵심이다. 그래야 앵커가 "첫 프레임 부호"가 아니라
  // 매 프레임 데이터에서 다시 유도되는 해부학적 법선이 되고, 틀린 반구에 잠기지 않는다.
  _makeHandBasis(f, l, out, key = null) {
    const F = this._wX.copy(f);
    if (!(F.lengthSq() > 1e-12)) return false;
    F.normalize();
    const n = this._wY.crossVectors(F, l);

    if (key === null) {
      // rest 경로: 예전 그대로
      if (!(n.lengthSq() > 1e-12)) return false;
      n.normalize();
      out.makeBasis(this._wZ.crossVectors(n, F), n, F);
      return true;
    }

    // --- 목표 경로 ---
    // f, l 이 둘 다 단위벡터로 들어오므로 ‖f×l‖ = sin(사잇각). 손 크기와 무관하다.
    // 퇴화 여부는 FIX_NORMAL_CONTINUITY 와 무관하게 항상 기록한다 —
    // 뒤의 스냅 리젝트가 이 값으로 게이트되므로, 두 토글이 서로 얽히면 A/B 격리가 안 된다.
    const sin = n.length();
    this._basisDegen = !(sin > NORMAL_SIN_EPS);

    if (!FIX_NORMAL_CONTINUITY) {
      // 원래 경로: 부호 교정도 퇴화 홀드도 없이 그대로 쓴다
      if (!(sin > 1e-6)) return false;
      n.divideScalar(sin);
      out.makeBasis(this._wZ.crossVectors(n, F), n, F);
      return true;
    }

    const prev = this._normals.get(key);
    // 신뢰도 rel: 0 = 손이 카메라에 옆으로 서서 법선이 무의미, 1 = 충분히 안정.
    const rel = smoothstep(sin, NORMAL_REL_LO, NORMAL_REL_HI);

    if (sin > 1e-6) n.divideScalar(sin);
    else if (prev) n.copy(prev);   // 완전 퇴화 → 직전 법선에서 출발
    else return false;

    if (prev) {
      // 부호교정: rel 과 무관하게 항상 한다. 같은 반구면 조건이 거짓이라 no-op 이고,
      // 안정 프레임(sin>0.40)에서도 나는 오른손 90°+ 뒤집힘(실측 9회)을 여기서 잡는다.
      // n 을 뒤집으면 l2 = n×F 도 같이 뒤집혀서 basis 는 계속 우수계로 남는다
      // (F 축 둘레 180° 회전만 사라진다) — 이게 손목 스냅의 근본 원인.
      if (n.dot(prev) < 0) {
        n.negate();
        this._stats.count(`${key}:flipFix`);
      }
      // 블렌드: 불안정 구간에서만. 신뢰도가 낮을수록 직전 법선에 더 기댄다.
      // rel=1 인 안정 프레임은 섞지 않으므로 해부학적 법선을 그대로 되찾는다
      // (= 앵커가 "첫 프레임"이 아니라 손등 방향. 예전의 "손목 꺾인 채 굳음"이 구조적으로 불가능).
      if (rel < 1) {
        // 램프를 꺼도 카운터는 그대로 센다 — A/B 양쪽에서 "램프에 걸렸을 프레임 수"를
        // 같은 기준으로 비교해야 하므로. 끈 상태의 relBlend/퇴화홀드 는 "실제로 섞인 수"가
        // 아니라 "켰다면 섞였을 수" 라는 뜻이 된다.
        if (FIX_NORMAL_REL_RAMP) n.lerp(prev, 1 - rel);
        this._stats.count(`${key}:${rel > 0 ? 'relBlend' : 'degenHold'}`);
      }
    }

    // prev 를 섞었으면 F 와의 직교가 깨져 있다 → F 성분을 빼고 재정규화한다
    // (손이 향하는 방향 F 는 믿을 수 있고, 흔들리는 건 l 쪽이다).
    n.addScaledVector(F, -n.dot(F));
    if (!(n.lengthSq() > 1e-12)) return false;
    n.normalize();

    if (prev) {
      // 교정 후에도 90° 넘게 돌았으면 남은 이벤트로 센다(목표는 0)
      if (n.dot(prev) < 0.001) this._stats.count(`${key}:flipLeft`);
      prev.copy(n);
    } else if (rel >= 1) {
      // 시드는 안정 프레임에서만 잡는다. 램프가 있어서 퇴화 프레임은 prev 의 반구를
      // 뒤집지 못하므로, 틀린 반구가 유입될 경로는 시드뿐이다. 이 클립도 첫 프레임이
      // sin=0.00 완전 퇴화라 무조건 시드하면 거기에 눌러앉는다(실측: 양손 10~11프레임 뒤 첫 안정).
      this._normals.set(key, n.clone());
    }
    out.makeBasis(this._wZ.crossVectors(n, F), n, F);
    return true;
  }

  // 손목(Hand 본)의 방향 + roll(손바닥이 향하는 방향)을 맞춘다.
  // 방향 하나만 맞추는 setFromUnitVectors 로는 twist 가 결정되지 않으므로,
  // 손바닥 평면에서 3축 basis 를 만들어 회전을 통째로 지정한다.
  // 팔 뒤 / 손가락 앞에 불려야 한다.
  applyWrist(humanoid, hand, side, trusted) {
    if (!hand) return;
    if (!trusted) {
      this._coastBone(humanoid, `${side}Hand`, OE_WRIST);
      return;
    }
    const bone = humanoid.getNormalizedBoneNode(`${side}Hand`);
    const mid = humanoid.getNormalizedBoneNode(`${side}MiddleProximal`);
    const idx = humanoid.getNormalizedBoneNode(`${side}IndexProximal`);
    const lit = humanoid.getNormalizedBoneNode(`${side}LittleProximal`);
    if (!bone || !bone.parent || !mid || !idx || !lit) return;
    const wrist = hand[0], middleMCP = hand[9], indexMCP = hand[5], pinkyMCP = hand[17];
    if (!wrist || !middleMCP || !indexMCP || !pinkyMCP) return;

    // rest basis: 자식 본 위치에서 유도한다. 손 rest 로컬 회전이 identity 라서
    // 손 로컬 공간 = 부모 공간이고, 랜드마크 쪽과 "같은 물리량"을 재게 된다.
    //
    // n = f × l 은 유사벡터라 왼손/오른손에서 손바닥/손등으로 뒤집힌다.
    // 하지만 rest 와 목표를 "같은 해부학적 손"에 같은 레시피로 적용하므로 부호가 상쇄된다.
    // (place 가 좌우를 반전시키는 좌표계라면 왼손 좌표가 오른손 형상이 되는데,
    //  그때는 호출부가 그 손을 VRM 반대쪽에 붙이므로 여기서도 짝이 맞는다 — 실측 확인.)
    this._wF.copy(mid.position);
    this._wL.copy(idx.position).sub(lit.position);
    if (!this._makeHandBasis(this._wF, this._wL, this._wM)) return;
    this._wRestQ.setFromRotationMatrix(this._wM);

    // 목표 basis: 랜드마크를 place 규약으로 옮겨서 같은 방식으로 구성.
    // 두 축 모두 z 가중치 + 방향 EMA 를 거친다. 손바닥 평면은 z 노이즈에
    // 특히 약해서(손이 카메라와 평행하면 법선이 z 로만 결정됨) 여기 필터가 중요하다.
    this._place(this._armA, wrist);
    this._place(this._armB, middleMCP);
    this._wF.copy(this._armB).sub(this._armA);
    this._wF.z *= Z_WEIGHT_WRIST;
    if (!(this._wF.lengthSq() > 1e-8)) return;
    this._wF.normalize();
    this._smoothDir(`${side}Hand:f`, this._wF, DIR_SMOOTH_WRIST);

    this._place(this._armA, indexMCP);
    this._place(this._armB, pinkyMCP);
    this._wL.copy(this._armA).sub(this._armB);
    this._wL.z *= Z_WEIGHT_WRIST;
    if (!(this._wL.lengthSq() > 1e-8)) return;
    this._wL.normalize();
    this._smoothDir(`${side}Hand:l`, this._wL, DIR_SMOOTH_WRIST);

    if (!this._makeHandBasis(this._wF, this._wL, this._wM, `${side}Hand`)) return;
    this._wTargetQ.setFromRotationMatrix(this._wM);

    // 법선 부호를 고쳐도 한 프레임에 기저가 통째로 도는 경우가 남을 수 있다
    // (l 이 통째로 다른 방향으로 튄 프레임 등). "손이 향하는 방향은 거의 그대로인데
    // 회전만 100° 넘게 변했다" = 물리적으로 불가능 → 그 프레임은 버리고 직전 자세를 유지한다.
    if (!this._checkBasisContinuity(side)) return;

    // 목표 basis 는 월드, rest basis 는 부모 공간이므로
    //   parentQ * (qLocal * qRest) = qTarget  →  qLocal = parentQ⁻¹ · qTarget · qRest⁻¹
    bone.parent.getWorldQuaternion(this._armQ);
    this._wTargetQ.premultiply(this._armQ.invert()).multiply(this._wRestQ.invert());

    // 여기서 손목 회전을 더 손대지 않는다. 전완 roll(회내/회외)은 수어의 실제 의미
    // 성분이라 감쇠 대상이 아니고, 잔여 roll 노이즈는 아래 One Euro 가 처리한다.
    this._writeBone(bone, `${side}Hand`, this._wTargetQ, OE_WRIST);
  }

  // 완성된 목표 기저(월드)가 직전 프레임 대비 물리적으로 불가능하게 튀었는지 본다.
  // 튀었으면 false(이번 프레임 버림). 상태가 없으면 통과시키고 기준만 저장한다.
  //
  // 퇴화 프레임(손이 카메라에 옆으로 서서 손바닥 평면이 안 나오는 프레임)에서만 검토한다.
  // 비퇴화 프레임의 큰 회전은 진짜 손목 동작이다 — 수어는 실제로 그렇게 빠르고,
  // 그걸 홀드하면 홀드 자체가 버벅임이 된다.
  _checkBasisContinuity(side) {
    const key = `${side}Hand`;
    let prev = this._basisPrev.get(key);
    if (!prev) {
      this._basisPrev.set(key, {
        q: this._wTargetQ.clone(),
        f: this._wF.clone(),
        rejects: 0,
      });
      return true;
    }
    // 기준은 어느 경로로 빠지든 항상 갱신해 둔다(다음 프레임 판정이 최신 자세 기준이 되게).
    const accept = () => {
      prev.rejects = 0;
      prev.q.copy(this._wTargetQ);
      prev.f.copy(this._wF);
      return true;
    };
    if (!FIX_BASIS_SNAP_REJECT || !this._basisDegen) return accept();

    const dq = quatAngleDeg(prev.q, this._wTargetQ);
    // 손이 향하는 방향(forward)이 얼마나 변했는지 — 이건 믿을 수 있는 축이다
    const dot = THREE.MathUtils.clamp(prev.f.dot(this._wF), -1, 1);
    const df = Math.acos(dot) * THREE.MathUtils.RAD2DEG;
    // 연속 리젝트 상한(BASIS_SNAP_MAX_HOLD = 1): 기준을 갱신하지 않고 계속 버리면
    // 정말로 그쪽으로 간 경우 손이 멈춰버린다. 한 프레임까지만 버리고 그 다음은 받아들인다.
    if (dq > BASIS_SNAP_DEG && df < BASIS_SNAP_FWD_DEG && prev.rejects < BASIS_SNAP_MAX_HOLD) {
      prev.rejects++;
      this._stats.count(`${key}:snapReject`);
      return false;
    }
    return accept();
  }

  // 손 하나의 손가락 전체. 손이 안 잡히면 건너뛰고 직전 각도를 유지한다.
  // 손목이 가려진(신뢰 불가) 프레임에는 마지막 신뢰 목표로만 수렴시킨다.
  // 팔·손목을 먼저 적용한 뒤에 불려야 한다 — 손가락의 부모(손)가 이미 회전돼 있어야
  // 부모 회전 제거가 최신 값으로 이뤄진다.
  applyFingers(humanoid, hand, side, trusted) {
    if (!hand) return;
    // 가림 판정은 손별로 프레임당 한 번. applyFingers 가 그 유일한 지점이다.
    // occSide 를 넘기는 것도 여기뿐이라, 팔·손목은 완화 로직을 아예 통과하지 않는다.
    const occSide = this._updateOcclusion(hand, side) ? side : null;
    for (const { lm, bones } of FINGER_CHAINS) {
      for (let i = 0; i < bones.length; i++) {
        const boneName = `${side}${bones[i]}`;
        if (!trusted) {
          this._coastBone(humanoid, boneName, OE_FINGER);
          continue;
        }
        // 끝마디(Distal)는 자식 본이 없다 → childName 을 null 로 넘겨 폴백을 쓰게 한다
        const childName = i + 1 < bones.length ? `${side}${bones[i + 1]}` : null;
        this._applyBoneDirection(
          humanoid, hand[lm[i]], hand[lm[i + 1]],
          boneName, childName,
          Z_WEIGHT_FINGER, DIR_SMOOTH_FINGER, OE_FINGER, occSide
        );
      }
    }
  }

  // 이번 프레임 이 손이 가려졌는지 판정하고 상태를 갱신한다. 완화를 걸 수 있으면 true.
  //
  // 척도는 "손 크기" s = mean(‖손끝_i − 손목‖) 과 "손가락 벌어짐" spread = std(같은 거리들).
  // 기준(sRef/spreadRef)은 양호 프레임에서만 EMA 로 갱신한다 — 가림 프레임이 기준을
  // 끌어내리면 그 다음부터 가림을 정상으로 인식해 감지기가 통째로 무력해진다.
  _updateOcclusion(hand, side) {
    if (!FIX_OCCLUSION_FINGERS) return false;
    let st = this._occ.get(side);
    if (!st) {
      st = { sRef: 0, spreadRef: 0, occ: 0, occEff: 0, run: 0, frame: -1,
             fresh: false, lastGood: new Map(), lw: null };
      this._occ.set(side, st);
    }
    // fresh = "이번 호출이 새 클립 프레임인가". 계측이 중복 프레임을 두 번 세지 않게 한다.
    st.fresh = false;

    const wrist = hand[0];
    if (!wrist) return st.lastGood.size > 0;
    this._place(this._occW, wrist);
    const w = this._occW;
    if (!Number.isFinite(w.x) || !Number.isFinite(w.y) || !Number.isFinite(w.z)) {
      return st.lastGood.size > 0; // 손목을 못 놓으면 판정 보류(직전 occ 유지)
    }

    // 같은 클립 프레임이 rAF 두 번에 걸쳐 들어오는 경우(재생 60fps vs 클립 30fps).
    // 좌표가 비트 단위로 같으면 같은 프레임이다 — 실측 모션이 정확히 같은 값을
    // 두 번 낼 일은 없다. 카운터를 안 올려야 OCC_MAX_HOLD 가 "클립 프레임 20개"가 된다.
    const repeat = st.lw !== null && st.lw[0] === w.x && st.lw[1] === w.y && st.lw[2] === w.z;
    if (repeat) return st.lastGood.size > 0;
    st.lw = [w.x, w.y, w.z];
    st.frame++;
    st.fresh = true;

    // 손끝 5개까지의 거리. NaN 손끝은 통계에서 제외한다.
    let n = 0;
    for (const tipIdx of [4, 8, 12, 16, 20]) {
      const tip = hand[tipIdx];
      if (!tip) continue;
      this._place(this._occT, tip);
      const d = this._occT.distanceTo(w);
      if (Number.isFinite(d)) this._occD[n++] = d;
    }
    // 손끝이 2개 미만이면 s 를 못 믿는다 → 직전 occ 를 그대로 유지
    if (n < 2) { st.fresh = false; return st.lastGood.size > 0; }

    let sum = 0;
    for (let i = 0; i < n; i++) sum += this._occD[i];
    const s = sum / n;
    let varSum = 0;
    for (let i = 0; i < n; i++) varSum += (this._occD[i] - s) ** 2;
    const spread = Math.sqrt(varSum / n);

    // 첫 유효 프레임: 기준을 스냅하고 양호로 본다
    if (!(st.sRef > 0)) {
      st.sRef = s;
      st.spreadRef = spread;
      st.occ = 0;
      st.occEff = 0;
      st.run = 0;
      return true;
    }

    const relDev = Math.abs(s - st.sRef) / st.sRef;
    let occ = Math.min(1, Math.max(0, relDev / OCC_DEV_THRESH));
    // 크기가 우연히 맞아도 손가락이 한 점으로 뭉쳤으면 그건 가림이다
    if (st.spreadRef > 0 && spread < OCC_SPREAD_COLLAPSE * st.spreadRef) {
      occ = Math.max(occ, OCC_SPREAD_SCORE);
    }
    st.occ = occ;

    if (occ < OCC_GOOD_THRESH) {
      // 양호 프레임 — 기준을 갱신하고 완화 가중치는 0 (원본 그대로 통과)
      st.sRef += (s - st.sRef) * OCC_REF_SMOOTH;
      st.spreadRef += (spread - st.spreadRef) * OCC_REF_SMOOTH;
      st.run = 0;
      st.occEff = 0;
    } else {
      st.run++;
      // 장기 가림 가드: 20프레임(≈0.7s)을 넘기면 15프레임에 걸쳐 홀드를 풀고
      // 라이브 데이터로 복귀한다. 무한 프리즈 방지.
      const over = st.run - OCC_MAX_HOLD;
      const decay = over > 0 ? Math.max(0, 1 - over / OCC_DECAY_FRAMES) : 1;
      st.occEff = occ * decay;
      if (RETARGET_DEBUG) this._stats.occFrame(side, st.frame, occ);
    }
    return true;
  }

  // 손가락 타깃 하나를 직전 유효 포즈 쪽으로 완화한다. One Euro "이전" 단계다.
  // 양호 프레임(occ < OCC_GOOD_THRESH)은 여기서 즉시 빠져나가므로 원본이 그대로 간다.
  _relaxOccluded(q, side, boneName) {
    const st = this._occ.get(side);
    if (!st) return;
    if (st.occ < OCC_GOOD_THRESH) {
      // 양호 프레임의 타깃을 "직전 유효 포즈"로 저장해 둔다(가림 때 여기로 수렴)
      let slot = st.lastGood.get(boneName);
      if (!slot) { slot = new THREE.Quaternion(); st.lastGood.set(boneName, slot); }
      slot.copy(q);
      return;
    }
    const good = st.lastGood.get(boneName);
    // 클립 시작부터 가려서 기준 포즈가 없으면 완화하지 않는다(원본 통과)
    if (!good || !(st.occEff > 0)) return;
    // 계측: 가림 블록에서 "완화 전" 프레임 간 타깃 흔들림 (같은 클립 프레임 중복은 제외)
    const stat = RETARGET_DEBUG && st.fresh && STAT_OCC_BONES.has(boneName);
    let prev = null;
    if (stat) {
      prev = this._occStatPrev.get(boneName);
      if (!prev) {
        prev = { raw: new THREE.Quaternion(), out: new THREE.Quaternion(), ready: false };
        this._occStatPrev.set(boneName, prev);
      }
      if (prev.ready) this._stats.push(`${boneName}:occBefore`, quatAngleDeg(prev.raw, q));
      prev.raw.copy(q);
    }

    // 반구 정렬 — q 와 -q 는 같은 회전이라, 안 맞추면 slerp 가 먼 길로 돈다
    this._occQ.copy(good);
    if (q.dot(this._occQ) < 0) {
      this._occQ.set(-this._occQ.x, -this._occQ.y, -this._occQ.z, -this._occQ.w);
    }
    q.slerp(this._occQ, st.occEff);
    if (!isFiniteQuat(q)) q.copy(good); // slerp 결과가 깨지면 직전 유효 포즈 그대로

    // 계측: "완화 후" 프레임 간 흔들림. 이게 낮아야 백스톱이 일한 것이다.
    if (stat) {
      if (prev.ready) this._stats.push(`${boneName}:occAfter`, quatAngleDeg(prev.out, q));
      prev.out.copy(q);
      prev.ready = true;
    }
  }

  // 정규화된 방향 벡터에 EMA 를 건다. dir 을 제자리에서 갱신하고 그대로 돌려준다.
  // alpha = 새 값의 비중(1 이면 스무딩 없음).
  _smoothDir(key, dir, alpha) {
    if (alpha >= 1) return dir;
    let prev = this._dirSlots.get(key);
    if (!prev) {
      // 첫 유효 방향은 스냅 (원점 EMA 의 _originReady 와 같은 패턴)
      this._dirSlots.set(key, dir.clone());
      return dir;
    }
    prev.lerp(dir, alpha);
    const len = prev.length();
    // 거의 정반대 방향이 섞여 0 이 되면 방향이 무의미해진다 → 이번 값으로 리셋
    if (!(len > 1e-6)) {
      prev.copy(dir);
      return dir;
    }
    prev.divideScalar(len);
    return dir.copy(prev);
  }

  // 신뢰 불가 프레임용: 새 목표를 만들지 않고 마지막 신뢰 목표로만 계속 수렴시킨다.
  // 아직 한 번도 신뢰 값이 없었다면 아무것도 안 한다(rest 유지).
  _coastBone(humanoid, boneName, oe) {
    const target = this._boneTargets.get(boneName);
    if (!target) return;
    const bone = humanoid.getNormalizedBoneNode(boneName);
    if (bone) this._writeBone(bone, boneName, target, oe);
  }

  // 본에 실제로 회전을 쓰는 유일한 지점. 모든 경로가 여기로 모인다.
  //
  //   목표 회전 → [NaN 가드] → [One Euro] → 본
  //
  // One Euro 는 기존 고정 slerp 를 대체한다(같은 slerp 인데 alpha 가 적응형).
  // 필터가 null 을 주면(첫 프레임 NaN 등) 쓰지 않고 직전 회전을 유지한다.
  _writeBone(bone, boneName, targetQ, oe) {
    if (!isFiniteQuat(targetQ)) return; // NaN/Inf 입력 → 이 본은 직전 유효 회전을 hold

    // 계측: 필터 "전" 프레임 간 변화 = 직전 목표 ↔ 이번 목표.
    // _rememberTarget 보다 반드시 먼저 재야 한다(먼저 기억하면 자기 자신과 비교하게 된다).
    const stat = RETARGET_DEBUG && STAT_BONES.has(boneName);
    if (stat) {
      const prevTarget = this._boneTargets.get(boneName);
      if (prevTarget) this._stats.push(`${boneName}:before`, quatAngleDeg(prevTarget, targetQ));
    }
    // 가려진 프레임에 수렴시킬 "마지막 신뢰 목표"도 여기서 갱신한다(쓰기 경로가 한 곳이므로).
    this._rememberTarget(boneName, targetQ);

    if (!FIX_ONE_EURO) {
      // 원래 경로: 고정 계수 slerp. 계측의 "후" 계열은 이 경로에서도 재도록 직접 잰다.
      const before = stat ? bone.quaternion.clone() : null;
      bone.quaternion.slerp(targetQ, oe.legacy);
      if (stat) {
        this._stats.push(`${boneName}:after`, quatAngleDeg(before, bone.quaternion));
        this.logStats(false);
      }
      return;
    }

    let filter = this._quatFilters.get(boneName);
    if (!filter) {
      filter = new QuatOneEuro(oe.minCutoff, oe.beta, RESET_GAP_SEC);
      this._quatFilters.set(boneName, filter);
    }
    const q = filter.filter(targetQ, performance.now() / 1000);
    if (!q) return;

    // 계측: 필터 "후" = 본에 실제로 들어간 회전이 이번에 움직인 각
    if (stat) {
      this._stats.push(`${boneName}:after`, filter.lastDelta * THREE.MathUtils.RAD2DEG);
      this.logStats(false);
    }
    bone.quaternion.copy(q);
  }

  // 검증용 통계 출력. force=false 면 STAT_INTERVAL_SEC 마다 한 번만 찍는다.
  logStats(force) {
    if (!RETARGET_DEBUG) return;
    const now = performance.now() / 1000;
    if (!this._statsAt) { this._statsAt = now; return; }
    if (!force && now - this._statsAt < STAT_INTERVAL_SEC) return;
    this._statsAt = now;

    const lines = [];
    for (const name of STAT_BONES) {
      const line = this._stats.line(name, `${name}:before`, `${name}:after`);
      if (line) lines.push('  ' + line);
    }
    const c = (k) => this._stats.counters.get(k) || 0;
    const flip = ['left', 'right'].map((s) => {
      const k = `${s}Hand`;
      return `${s} 부호교정 ${c(`${k}:flipFix`)} · 잔존90°+ ${c(`${k}:flipLeft`)}`
        + ` · 스냅리젝트 ${c(`${k}:snapReject`)}`;
    });
    // 램프 관여 프레임: relBlend = 부분 의존(0<rel<1), 퇴화홀드 = 완전 의존(rel=0)
    const ramp = ['left', 'right'].map((s) => {
      const k = `${s}Hand`;
      return `${s} relBlend ${c(`${k}:relBlend`)} · 퇴화홀드 ${c(`${k}:degenHold`)}`;
    });
    if (lines.length === 0) return;
    console.log(
      `[retarget:${this._label}] 프레임 간 |ΔAngle| deg (필터 전 → 후)\n`
      + lines.join('\n')
      + `\n  법선 이벤트: ${flip.join(' | ')}`
      + `\n  법선 램프: ${ramp.join(' | ')}`
      + this._occReport()
    );
    // 각도 계열만 비우고 카운터는 누적 유지 (클립 전체의 flip 총합을 보기 위해)
    for (const name of STAT_BONES) {
      this._stats.series.delete(`${name}:before`);
      this._stats.series.delete(`${name}:after`);
    }
  }

  // 가림 완화 리포트. 프레임 번호는 이 리타깃터가 본 "새 클립 프레임"의 일련번호라
  // 0번부터 끊김 없이 재생했을 때 CSV 인덱스와 일치한다(스크럽하면 어긋난다).
  _occReport() {
    if (!FIX_OCCLUSION_FINGERS) return '';
    let out = '';
    for (const side of ['left', 'right']) {
      const st = this._occ.get(side);
      const blocks = this._stats.occBlocks(side);
      if (!st && blocks.length === 0) continue;
      const total = blocks.reduce((a, [s, e]) => a + (e - s + 1), 0);
      // 긴 블록부터 최대 8개만 (짧은 단발은 로그를 채우기만 한다)
      const top = blocks.slice().sort((a, b) => (b[1] - b[0]) - (a[1] - a[0])).slice(0, 8)
        .sort((a, b) => a[0] - b[0])
        .map(([s, e]) => (s === e ? `${s}` : `${s}~${e}`)).join(' ');
      out += `\n  가림 ${side}: ${total}프레임 / ${blocks.length}블록`
        + ` (본 프레임 ${st ? st.frame + 1 : 0}, 현재 occ ${st ? st.occ.toFixed(2) : '—'}`
        + `, 연속 ${st ? st.run : 0})`
        + (top ? `\n    긴 블록: ${top}` : '');
    }
    const occLines = [];
    for (const name of STAT_OCC_BONES) {
      const line = this._stats.line(name, `${name}:occBefore`, `${name}:occAfter`);
      if (line) occLines.push('    ' + line);
    }
    if (occLines.length) {
      out += `\n  가림 구간 손가락 타깃 |ΔAngle| (완화 전 → 후)\n` + occLines.join('\n');
      for (const name of STAT_OCC_BONES) {
        this._stats.series.delete(`${name}:occBefore`);
        this._stats.series.delete(`${name}:occAfter`);
      }
    }
    return out;
  }

  // 이번 프레임의 목표 회전을 본별로 기억해 둔다 (다음에 가려지면 여기로 수렴)
  _rememberTarget(boneName, q) {
    let slot = this._boneTargets.get(boneName);
    if (!slot) {
      slot = new THREE.Quaternion();
      this._boneTargets.set(boneName, slot);
    }
    slot.copy(q);
  }

  // 본 하나를 "fromLm → toLm 방향"으로 향하게 한다. 위팔/아래팔/손가락 공통.
  // childName 은 rest 방향을 얻기 위한 자식 본(위팔→아래팔, 아래팔→손).
  // 랜드마크가 없거나 길이가 0 이면 아무것도 안 하고 직전 회전을 유지한다.
  // occSide: 손가락 경로만 넘긴다(가림 완화 대상). 팔·손목은 null 이라 완화를 안 탄다.
  _applyBoneDirection(humanoid, fromLm, toLm, boneName, childName, zWeight, dirSmooth, oe, occSide = null) {
    if (!fromLm || !toLm) return;
    // 양 끝 중 하나라도 신뢰도가 낮으면 이 본은 이번 프레임에 갱신하지 않는다.
    // (위팔은 어깨+팔꿈치, 아래팔은 팔꿈치+손목이 자동으로 검사된다)
    if (!isVisible(fromLm) || !isVisible(toLm)) {
      this._coastBone(humanoid, boneName, oe);
      return;
    }
    const bone = humanoid.getNormalizedBoneNode(boneName);
    if (!bone || !bone.parent) return;
    const child = childName ? humanoid.getNormalizedBoneNode(childName) : null;
    if (childName && !child) return;

    // 목표 방향: place 규약 그대로 (좌표계가 반영된 three 좌표)
    this._place(this._armA, fromLm);
    this._place(this._armB, toLm);
    const dir = this._armB.sub(this._armA);
    // z 가중치는 "차이 벡터"의 z 에 건다. place 가 z 에 대해 선형이라
    // 랜드마크 z 차이를 그대로 줄이는 것과 같다.
    dir.z *= zWeight;
    const len = dir.length();
    // 0 으로 나누면 NaN → slerp 를 타고 본 회전이 영구히 NaN 이 된다. 반드시 차단.
    if (!(len > 1e-4)) return;
    dir.divideScalar(len);
    // 회전으로 바꾸기 전에 방향 자체를 한 번 걸러준다
    this._smoothDir(boneName, dir, dirSmooth);

    // rest 방향(부모 공간 기준) = 자식 본의 로컬 위치.
    // 정규화 골격은 rest 로컬 회전이 identity 라서 이 등식이 성립한다(실측 확인).
    //
    // 자식이 없는 끝마디(손가락 Distal)는 자기 자신의 로컬 위치로 대체한다.
    // 이 값은 "부모 마디의 방향"이고, rest 에서 손가락은 곧게 펴져 있으므로
    // 끝마디 방향과 거의 같다(이 모델에서 실측 오차 0.0~2.6°).
    // 주의: 이 폴백은 끝마디에만 쓸 수 있다. Proximal 에 쓰면 그 값은 손가락 축이
    // 아니라 손등에서 마디로 벌어진 방향이라 19~45° 어긋난다.
    const rest = this._armRest.copy((child || bone).position);
    if (!(rest.lengthSq() > 1e-12)) return;
    rest.normalize();

    // 목표 방향도 같은 부모 공간으로 옮긴다. 이 변환은 생략할 수 없다:
    //  - 위팔: rotateVRM0 때문에 부모(어깨)가 월드에서 Y축 180° 돌아 있다.
    //  - 아래팔: 부모(위팔)가 매 프레임 회전하므로 아예 고정값이 아니다.
    // getWorldQuaternion 은 내부에서 조상 매트릭스를 갱신하므로,
    // 바로 앞에서 위팔에 넣은 회전이 여기 즉시 반영된다(vrm.update 를 기다릴 필요 없음).
    bone.parent.getWorldQuaternion(this._armQ);
    dir.applyQuaternion(this._armQ.invert());

    this._armTargetQ.setFromUnitVectors(rest, dir);
    // 가림 완화는 One Euro "이전"에 건다 — 완화된 타깃을 그 다음 One Euro 가 스무딩한다.
    if (occSide !== null) this._relaxOccluded(this._armTargetQ, occSide, boneName);
    // 튀지 않게 보간 (One Euro — 정지 시엔 세게, 빠를 땐 지연 없이 통과)
    this._writeBone(bone, boneName, this._armTargetQ, oe);
  }
}

// 요청된 이름의 진입점. 두 재생/추적 경로 어디서든 이걸로 리셋하면 된다.
// (BoneRetargeter.resetSmoothing() 을 그대로 부른다 — 인스턴스 상태라 대상이 필요하다)
export function resetRetargetSmoothing(retargeter) {
  if (retargeter && typeof retargeter.resetSmoothing === 'function') {
    retargeter.resetSmoothing();
  }
}
