import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
// 굵은 선: three 기본 LineBasicMaterial 은 WebGL 에서 linewidth 가 무시되어 항상 1px.
// LineSegments2 + LineSegmentsGeometry + LineMaterial 로 실제 픽셀 두께를 낸다.
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import {
  VRMLoaderPlugin,
  VRMUtils,
  VRMExpression,
  VRMExpressionMorphTargetBind,
} from '@pixiv/three-vrm';
import {
  POSE,
  FACE,
  POSE_UPPER_CONNECTIONS,
  POSE_UPPER_JOINTS,
  HAND_CONNECTIONS,
} from '../mediapipe/landmarks.js';

// 색상
const COLOR_BONE = 0x34d399; // 뼈: 민트
const COLOR_JOINT = 0xfb7185; // 관절: 코랄
const COLOR_FACE = 0x7c8aa0; // 얼굴 점: 슬레이트

const SCALE = 3.6; // 정규화 좌표(0~1)를 화면 크기로 확대 (상반신 프레이밍용으로 키움)
const BONE_WIDTH = 3.5; // 뼈대 선 두께(px). LineMaterial 은 실제로 반영됨
const SPINE_RATIO = 0.55; // 척추 길이 = 어깨 너비 * 이 값

// 레이어로 두 뷰를 분리한다. 씬은 하나지만 카메라마다 보이는 게 다르다.
//   메인 무대  = VRM 아바타만 / 디버그 창 = 스켈레톤만
// three 의 레이어는 상속되지 않고 오브젝트별로 판정되므로,
// VRM 자식들은 기본값(레이어 0) 그대로 두면 된다.
const LAYER_AVATAR = 0;
const LAYER_SKELETON = 1;

// 메인 카메라(아바타 프레이밍) — 뉴스 수어 통역사처럼 머리~허리 흉상만 크게.
// 이 모델의 실측 본 위치(VRM_POS.y -2.0 / VRM_SCALE 1.7 적용 후):
//   머리끝 1.00  head 0.64  neck 0.48  upperChest 0.24  spine -0.18  hips -0.28
//   무릎 -1.01  발 -2.00
// fov 45 에서 z=2.05 → 세로 반높이 0.85, 화면 y 범위 -0.50~1.20.
//   머리 위 0.20 여백 / 아래는 골반보다 0.22 더 내려간 지점에서 잘림 → 다리는 화면 밖.
//   흉상(머리끝~골반)이 화면 세로의 약 75% 를 채운다.
// 타깃 y 0.35 는 흉상의 세로 중심이라 아바타가 화면 중앙에 온다.
// 더 당기려면 FRAME_Z 를 줄이고, 손이 좌우로 잘리면 다시 키우면 된다.
const FRAME_Y = 0.35;
const FRAME_Z = 2.05;

// 디버그 카메라(스켈레톤) — 손을 위아래로 크게 뻗어도 안 잘리게 더 넓게 잡는다
const DEBUG_FRAME_Y = -0.35;
const DEBUG_FRAME_Z = 3.6;

// 녹화(C-1) 관련.
// preserveDrawingBuffer 는 성능에 약간 손해지만, 없으면 captureStream 이
// 간헐적으로 검은 프레임을 집는다. 녹화를 안 쓸 거면 false 로 되돌리면 된다.
const PRESERVE_DRAWING_BUFFER = true;
// 메인 캔버스는 투명이면 녹화 파일에서 검게 찍힌다(mp4 는 알파가 없다).
// 그래서 메인 렌더러만 불투명 배경으로 지운다. 디버그 창은 투명 유지.
// null 로 두면 예전처럼 투명해지고, 대신 .stage-wrap 의 CSS 그라데이션이 보인다.
const MAIN_CLEAR_COLOR = 0x111825;

// 몸통 중심(원점)이 아직 없을 때 쓰는 기본값 = 화면 중앙
const DEFAULT_ORIGIN = { x: 0.5, y: 0.5, z: 0 };

// 원점 EMA 계수. 클수록 반응이 빠르고 작을수록 부드럽다(떨림 억제).
// 굼뜨게 느껴지면 0.4~0.5 로 올리면 된다.
const ORIGIN_SMOOTH = 0.3;

// --- VRM (B-1: 로드해서 세워두기만. 동작 리타깃은 아직 없음) ---
const VRM_URL = '/avatar.vrm';
// 스켈레톤이 디버그 창으로 빠졌으므로 메인 무대 한가운데에 크게 세운다.
// 이 모델은 키 1.76m / 폭 1.57m(A자세). SCALE 1.7 · y -2.0 이면
// 머리 끝이 화면 위쪽에 닿고 아래로는 허벅지쯤까지 보인다(상반신 프레이밍).
// 창이 좁아 팔이 잘리면 VRM_SCALE 을 줄이고, 더 크게 보고 싶으면 키우면 된다.
// (카메라 FRAME_Y/FRAME_Z 는 건드리지 않는다.)
const VRM_POS = { x: 0, y: -2.0, z: 0 };
const VRM_SCALE = 1.7;

// ===========================================================================
// 리타깃 튜닝 상수 — 떨림/펄럭임이 보이면 여기만 만지면 된다.
//
// 신호는 두 단계로 걸러진다:
//   랜드마크 → [z 가중치] → [방향벡터 EMA] → 회전 계산 → [회전 slerp] → 본
// 뒤쪽(회전 slerp)만으로는 z 가 한 프레임 튈 때의 방향 급변을 못 잡아서
// 앞단(방향벡터 EMA)에서 한 번 더 거른다.
// ===========================================================================

// [회전 slerp/EMA 계수] 낮추면 부드럽지만 둔해지고, 높이면 반응은 빠르지만 떨린다.
const SMOOTH_HEAD = 0.3;
const SMOOTH_ARM = 0.3;
const SMOOTH_WRIST = 0.3;
const SMOOTH_FINGER = 0.4; // 손가락은 작고 빨라서 팔보다 조금 높게

// [방향벡터 EMA 계수] 회전으로 바꾸기 "전"의 목표 방향 자체를 이전 프레임과 섞는다.
// 낮추면 부드럽지만 둔해지고, 높이면 반응이 빠르다. 1 = 스무딩 없음(B-4b 까지의 동작).
// 정지 상태 떨림과 앞뒤 펄럭임에 가장 직접적으로 듣는 값.
const DIR_SMOOTH_ARM = 0.4;
const DIR_SMOOTH_WRIST = 0.4;
const DIR_SMOOTH_FINGER = 0.4;

// [신뢰도 게이팅] MediaPipe pose 랜드마크에는 점마다 visibility(0~1) 가 있다.
// 가려지면 값이 떨어지는데, 그 상태의 좌표는 추측값이라 팔·손이 튄다.
// 임계 미만이면 그 본을 이번 프레임에 갱신하지 않고 "마지막 신뢰 목표"로만 수렴시킨다.
// (rest 로 리셋하는 게 아니라 마지막 신뢰 자세에서 부드럽게 멈춘다)
// 너무 높으면 정상 동작도 자주 멈춰 뻣뻣하고, 너무 낮으면 게이팅 효과가 없다.
// 손 랜드마크(21점)에는 visibility 가 없어서 게이팅되지 않는다 — 대신 pose 손목으로 막는다.
const VIS_GATING = true;
const VIS_THRESHOLD = 0.5;
const VIS_DEBUG = false; // true 면 60프레임마다 관절별 visibility 를 콘솔에 찍는다

// [z(깊이) 기여도] 방향 벡터의 z 성분에만 곱한다.
// MediaPipe 의 z 는 단일 웹캠 추정이라 앞뒤 펄럭임의 주원인이다.
// 1 = 그대로 사용. 낮추면 팔·손이 화면 평면에 가깝게 눕는 대신 앞뒤 흔들림이 준다.
// (팔은 pose z, 손가락·손목은 손목 기준 상대 z 라 스케일이 서로 다르다 — 따로 둔 이유)
const Z_WEIGHT_ARM = 1;
const Z_WEIGHT_WRIST = 1;
const Z_WEIGHT_FINGER = 1;

// ===========================================================================
// 성능 계측 (측정 전용 — 로직에 영향 없음)
// PERF_FRAMES 프레임마다 구간별 평균(ms)을 콘솔에 한 줄로 찍는다.
// fps 는 실제 벽시계 기준(rAF 간격)이라 total(CPU 작업량)과 따로 봐야 한다:
//   total 은 작은데 fps 가 낮으면 우리 루프가 아니라 다른 게 프레임을 먹고 있다는 뜻
//   (MediaPipe holistic.send 가 같은 메인 스레드의 별도 rAF 루프에서 돈다).
// ===========================================================================
const PERF_LOG = true;
const PERF_FRAMES = 60;
const PERF_KEYS = ['read', 'head', 'arms', 'wrist', 'fingers', 'face', 'vrm', 'mainR', 'dbgR'];

// --- B-2: 머리 회전 ---
// (머리는 방향벡터가 아니라 각도를 직접 만들고 z 를 쓰지 않아 위 두 블록과 무관하다)
// normalized head bone 의 부호 규약(이 모델에서 실측):
//   rotation.x > 0 → 위를 봄 / rotation.y > 0 → 화면 오른쪽을 봄
//   rotation.z > 0 → 머리 위쪽이 화면 오른쪽으로 갸웃
// 계수는 "귀 사이 거리"로 정규화한 값에 곱하므로 카메라 거리와 무관하다.
// 방향이 반대면 GAIN 부호를, 과하거나 둔하면 크기를 조정.
const HEAD_YAW_GAIN = 1.8;
const HEAD_PITCH_GAIN = 1.2;
const HEAD_ROLL_GAIN = 1.0;
// 정면을 볼 때도 코는 귀 선보다 약간 아래에 잡힌다. 웹캠이 눈높이보다 위/아래에
// 있으면 이 값도 달라진다. 머리가 계속 숙여져(젖혀져) 보이면 이 값을 키우거나(줄이거나) 조정.
const HEAD_PITCH_BIAS = 0.35;
const HEAD_MAX_ANGLE = 0.6; // rad, 과회전 방지

// --- B-5a: 표정 (입 벌림만) ---
// 이 모델이 가진 expression: neutral, aa, ih, ou, ee, oh, blink, blinkLeft,
// blinkRight, angry, relaxed, happy, sad, Surprised (실측). 표준 VRM 프리셋.
const MOUTH_EXPRESSION = 'aa';
// openRatio = 입 세로거리 / 가로거리. 얼굴 크기로 정규화되므로 카메라 거리와 무관하다.
// 다만 MediaPipe 는 x 를 영상 폭으로, y 를 높이로 각각 정규화하므로 영상 종횡비가
// 상수배로 섞여 들어간다 — 아래 두 값이 그걸 흡수한다.
// 입을 다물어도 벌어져 보이면 BIAS 를 키우고, 크게 벌려도 덜 벌어지면 GAIN 을 키운다.
const MOUTH_OPEN_BIAS = 0.10;
const MOUTH_OPEN_GAIN = 2.0;
const MOUTH_SMOOTH = 0.5; // 입 벌림 EMA

// --- B-5b: 눈 깜빡임 (양눈 공통. 윙크는 아직 안 함) ---
const BLINK_EXPRESSION = 'blink';
// openness = 눈 세로거리 / 가로거리(EAR). 눈 뜨면 크고 감으면 작다.
// blink 는 그 반대라 1 에서 빼서 만든다.
// 평소에 눈이 반쯤 감겨 보이면 BIAS 를 낮추고, 감아도 안 감기면 BIAS 를 높인다.
const EYE_CLOSE_BIAS = 0.15;
const EYE_OPEN_GAIN = 3.0;
// 깜빡임은 0.1초대의 빠른 동작이라 입보다 반응을 빠르게 둔다.
// 너무 낮추면 깜빡임이 뭉개져서 안 감긴 것처럼 보인다.
const EYE_SMOOTH = 0.65;

// --- B-5c: 눈썹 올림/내림 (수어 의문문 표지가 주 목적) ---
// 이 모델엔 눈썹 본도, 눈썹 전용 expression 도 없다. Fcl_BRW_* morph 5개가 있는데
// 어떤 expression 에도 안 묶여 있어서(사전확인), 커스텀 expression 을 만들어 붙인다.
// 이름은 기존 프리셋 14개(neutral/aa/ih/ou/ee/oh/blink/blinkLeft/blinkRight/
// angry/relaxed/happy/sad/Surprised)와 겹치지 않는다.
const BROW_UP_EXPRESSION = 'browUp';
const BROW_DOWN_EXPRESSION = 'browDown';
const BROW_UP_MORPH = 'Fcl_BRW_Surprised';
const BROW_DOWN_MORPH = 'Fcl_BRW_Angry';
// browRaise = (눈썹~눈 거리) / 얼굴크기. 중립값을 빼고 스케일해서 ±로 만든다.
// 평소에도 눈썹이 올라가 있으면 BIAS 를 키우고, 올려도 반응이 약하면 GAIN 을 키운다.
// (중립 기준값. 눈썹~눈꺼풀 18mm / 눈 바깥끝 사이 90mm 에 16:9 종횡비를 반영해 역산.
//  사람마다 눈썹 위치 편차가 커서 실사용에서 제일 먼저 만지게 될 값이다.)
const BROW_BIAS = 0.36;
const BROW_GAIN = 6.0;
// 올림이 주 목적이라 내림은 약하게. 찡그림이 과해 보이면 더 낮춘다.
const BROW_UP_SCALE = 1.0;
const BROW_DOWN_SCALE = 0.7;
const BROW_SMOOTH = 0.4; // 입(0.5)과 눈(0.65) 중간

// 손가락 마디 매핑 테이블: 랜드마크 인덱스 체인 ↔ VRM 본 접미사 체인.
// lm[i] → lm[i+1] 방향이 bones[i] 본의 방향이 된다.
// (three-vrm v3 는 VRM0 모델도 VRM1.0 본 이름으로 정규화해준다 — 실측 확인.
//  그래서 엄지는 Metacarpal/Proximal/Distal 이고 ThumbIntermediate 는 없다.)
const FINGER_CHAINS = [
  { lm: [1, 2, 3, 4], bones: ['ThumbMetacarpal', 'ThumbProximal', 'ThumbDistal'] },
  { lm: [5, 6, 7, 8], bones: ['IndexProximal', 'IndexIntermediate', 'IndexDistal'] },
  { lm: [9, 10, 11, 12], bones: ['MiddleProximal', 'MiddleIntermediate', 'MiddleDistal'] },
  { lm: [13, 14, 15, 16], bones: ['RingProximal', 'RingIntermediate', 'RingDistal'] },
  { lm: [17, 18, 19, 20], bones: ['LittleProximal', 'LittleIntermediate', 'LittleDistal'] },
];

// MediaPipe 정규화 좌표 -> Three.js 좌표
// x: 0(왼)~1(오), y: 0(위)~1(아래), z: 상대 깊이(음수=카메라에 가까움)
// origin: 이번 프레임의 "몸통 중심". 모든 좌표에서 빼서 아바타를 화면 중앙에 고정한다.
// mirror=true 면 거울처럼 좌우 반전(통역사가 나를 마주보는 느낌)
// 이 랜드마크를 리타깃에 써도 되는지.
// visibility 가 없는 랜드마크(손 21점)는 잴 수 없으니 통과시킨다.
function isVisible(lm) {
  if (!lm) return false;
  if (!VIS_GATING) return true;
  const v = lm.visibility;
  return v == null || v >= VIS_THRESHOLD;
}

function place(target, lm, mirror, origin) {
  const dx = lm.x - origin.x;
  const dy = lm.y - origin.y;
  const dz = (lm.z || 0) - origin.z;
  const x = mirror ? -dx : dx;
  target.set(x * SCALE, -dy * SCALE, -dz * SCALE);
}

export class SkeletonAvatar {
  // mainContainer: VRM 아바타 무대 / debugContainer: 스켈레톤 디버그 창
  constructor(mainContainer, debugContainer, landmarksRef, optionsRef) {
    this.mainContainer = mainContainer;
    this.debugContainer = debugContainer;
    this.landmarksRef = landmarksRef;
    this.optionsRef = optionsRef;
    this._v = new THREE.Vector3();
    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
    this._c = new THREE.Vector3();
    // 매 프레임 갱신되는 몸통 중심(정규화 좌표계). 포즈가 없는 프레임에는 직전 값을 유지.
    this._origin = { ...DEFAULT_ORIGIN };
    this._originReady = false; // 첫 유효 측정 전인지 (EMA 대신 스냅)
    this.vrm = null;           // _loadVRM() 이 비동기로 채움
    this._clock = new THREE.Clock(); // vrm.update(delta) 용
    // 위팔 리타깃용 스크래치 (스켈레톤이 쓰는 _a/_b 와 섞이지 않게 따로 둔다)
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
    this._visLogCount = 0;
    // 성능 계측 누적기 (PERF_LOG 가 false 면 쓰이지 않는다)
    this._perfAcc = Object.fromEntries(PERF_KEYS.map((k) => [k, 0]));
    this._perfCount = 0;
    this._perfLast = 0;
    this._perfWallStart = null; // null = 아직 시작 안 함 (0 은 유효한 타임스탬프라 못 씀)
    this._mouthOpen = 0; // 입 벌림 EMA 상태 (0 = 다문 입)
    this._eyeBlink = 0;  // 눈 감김 EMA 상태 (0 = 눈 뜬 상태)
    this._browUp = 0;    // 눈썹 올림 EMA 상태
    this._browDown = 0;  // 눈썹 내림 EMA 상태
    this._browReady = false; // 커스텀 눈썹 expression 등록 성공 여부
    // 굵은 선 오브젝트 모음 (resolution 갱신 / dispose 용)
    this._fatLines = [];

    const w = mainContainer.clientWidth || 640;
    const h = mainContainer.clientHeight || 480;
    // 디버그 창은 작으므로 픽셀 비율을 낮춰도 된다
    const dw = (debugContainer && debugContainer.clientWidth) || 320;
    const dh = (debugContainer && debugContainer.clientHeight) || 180;

    this.scene = new THREE.Scene();

    // --- 메인 렌더러/카메라: VRM 아바타만 (레이어 0) ---
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: PRESERVE_DRAWING_BUFFER, // 녹화 시 검은 프레임 방지
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    if (MAIN_CLEAR_COLOR !== null) this.renderer.setClearColor(MAIN_CLEAR_COLOR, 1);
    mainContainer.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100);
    this.camera.position.set(0, FRAME_Y, FRAME_Z);
    this.camera.layers.set(LAYER_AVATAR);

    // --- 디버그 렌더러/카메라: 스켈레톤만 (레이어 1) ---
    if (debugContainer) {
      this.debugRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      this.debugRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
      this.debugRenderer.setSize(dw, dh);
      debugContainer.appendChild(this.debugRenderer.domElement);

      this.debugCamera = new THREE.PerspectiveCamera(45, dw / dh, 0.1, 100);
      this.debugCamera.position.set(0, DEBUG_FRAME_Y, DEBUG_FRAME_Z);
      this.debugCamera.lookAt(0, DEBUG_FRAME_Y, 0);
      this.debugCamera.layers.set(LAYER_SKELETON);
    } else {
      this.debugRenderer = null;
      this.debugCamera = null;
    }

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(0, FRAME_Y, 0);
    this.camera.lookAt(this.controls.target); // 방향 확정
    this.controls.update();                   // OrbitControls 내부 상태 동기화

    // 드래그로 돌린 뒤 되돌아올 "정면(초기 뷰)" 상태
    this._homePos = this.camera.position.clone();
    this._homeTarget = this.controls.target.clone();

    // 조명 — VRM 은 조명이 없으면 새까맣게 보인다.
    // 레이어는 조명에도 적용되므로 두 레이어 모두 켜 둔다.
    // (스켈레톤은 Basic/Points 계열이라 실제로 조명 영향을 받지는 않는다)
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
    keyLight.position.set(0.5, 2, 2.5); // 정면 위쪽
    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    for (const light of [keyLight, ambient]) {
      light.layers.enable(LAYER_AVATAR);
      light.layers.enable(LAYER_SKELETON);
      this.scene.add(light);
    }

    // --- 뼈대(선) 3개: 포즈 / 왼손 / 오른손 ---
    // LineMaterial 의 resolution 은 "실제로 그려지는" 렌더러 크기여야 한다.
    // 스켈레톤은 디버그 렌더러에만 그려지므로 디버그 창 크기를 넘긴다.
    this.poseLine = this._makeLine(POSE_UPPER_CONNECTIONS.length + 2, dw, dh); // +2: 목, 척추
    this.leftHandLine = this._makeLine(HAND_CONNECTIONS.length, dw, dh);
    this.rightHandLine = this._makeLine(HAND_CONNECTIONS.length, dw, dh);

    // --- 관절 점: 포즈 + 양손 --- (선이 굵어진 만큼 점도 키움)
    this.jointPoints = this._makePoints(POSE_UPPER_JOINTS.length + 21 + 21, COLOR_JOINT, 0.07);

    // --- 얼굴 점 구름 ---
    this.facePoints = this._makePoints(500, COLOR_FACE, 0.018);

    this._onResize = this._onResize.bind(this);
    window.addEventListener('resize', this._onResize);

    this._running = true;
    this._loop = this._loop.bind(this);
    this.renderer.setAnimationLoop(this._loop);

    this._loadVRM();
  }

  // VRM 로드 (비동기). 아직 랜드마크 리타깃은 하지 않고 무대에 세워두기만 한다.
  _loadVRM() {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    loader.load(
      VRM_URL,
      (gltf) => {
        const vrm = gltf.userData.vrm;
        if (!vrm) {
          console.error('VRM load error: VRM 확장이 없는 glTF 입니다 —', VRM_URL);
          return;
        }
        // 로딩(12MB) 중에 dispose 된 경우 — React StrictMode 의 mount/unmount/mount
        // 왕복에서 실제로 발생한다. 씬에 붙이지 말고 바로 정리해야 누수가 안 생긴다.
        if (!this._running) {
          VRMUtils.deepDispose(vrm.scene);
          return;
        }
        // VRM0 모델은 +Z(뒤)를 보고 있어서 180° 돌려야 정면이 된다. (public/avatar.vrm 은 VRM 0.0)
        if (typeof VRMUtils.rotateVRM0 === 'function') VRMUtils.rotateVRM0(vrm);
        this.vrm = vrm;
        vrm.scene.position.set(VRM_POS.x, VRM_POS.y, VRM_POS.z);
        vrm.scene.scale.setScalar(VRM_SCALE);
        this.scene.add(vrm.scene);

        // VRM 마다 표정 프리셋이 달라서 한 번 찍어둔다.
        // MOUTH_EXPRESSION 이 여기 없으면 setValue 가 조용히 무시되므로 확인용.
        const em = vrm.expressionManager;
        const names = em ? em.expressions.map((e) => e.expressionName) : [];
        console.log('[expressions]', names);
        if (!em || !em.getExpression(MOUTH_EXPRESSION)) {
          console.warn(`[vrm] '${MOUTH_EXPRESSION}' expression 이 없습니다 — 입 벌림이 동작하지 않습니다.`);
        }

        this._registerBrowExpressions(vrm);
      },
      undefined,
      (err) => console.error('VRM load error', err)
    );
  }

  _makeLine(maxSegments, w, h) {
    const geom = new LineSegmentsGeometry();
    const mat = new LineMaterial({
      color: COLOR_BONE,
      linewidth: BONE_WIDTH, // px 단위 (worldUnits: false)
      worldUnits: false,
      dashed: false,
    });
    mat.resolution.set(w, h);
    const line = new LineSegments2(geom, mat);
    line.frustumCulled = false;
    line.layers.set(LAYER_SKELETON);
    // setPositions() 에 넘길 재사용 버퍼: 세그먼트당 (x,y,z) * 2
    line.userData.positions = new Float32Array(maxSegments * 6);
    this.scene.add(line);
    this._fatLines.push(line);
    return line;
  }

  _makePoints(maxPoints, color, size) {
    const geom = new THREE.BufferGeometry();
    const positions = new Float32Array(maxPoints * 3);
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setDrawRange(0, 0);
    const mat = new THREE.PointsMaterial({ color, size, sizeAttenuation: true });
    const pts = new THREE.Points(geom, mat);
    pts.frustumCulled = false;
    pts.layers.set(LAYER_SKELETON);
    this.scene.add(pts);
    return pts;
  }

  // 이번 프레임의 몸통 중심을 갱신. 양 어깨 중점 우선, 없으면 골반 중점.
  // 둘 다 없으면(포즈가 빠진 프레임) 새 값 없이 기존 this._origin 을 그대로 유지.
  // 측정값은 그대로 쓰지 않고 EMA 로 섞어서 어깨 추정 흔들림에 아바타 전체가 떨리는 걸 막는다.
  // (showPose 토글과 무관하게 항상 계산 — 손만 켜져 있어도 같은 원점을 써야 하므로)
  _updateOrigin(pose) {
    if (!pose) return;
    const pairs = [
      [pose[POSE.LEFT_SHOULDER], pose[POSE.RIGHT_SHOULDER]],
      [pose[POSE.LEFT_HIP], pose[POSE.RIGHT_HIP]],
    ];
    for (const [a, b] of pairs) {
      if (!a || !b) continue;
      const nx = (a.x + b.x) / 2;
      const ny = (a.y + b.y) / 2;
      const nz = ((a.z || 0) + (b.z || 0)) / 2;
      // 첫 측정은 기본값(화면 중앙)에서 흘러들어오는 게 보이므로 그냥 스냅
      const t = this._originReady ? ORIGIN_SMOOTH : 1;
      this._origin.x += (nx - this._origin.x) * t;
      this._origin.y += (ny - this._origin.y) * t;
      this._origin.z += (nz - this._origin.z) * t;
      this._originReady = true;
      return;
    }
  }

  // 연결 리스트를 선 버퍼에 채움. group = 랜드마크 배열
  _fillLine(line, connections, group, mirror, extraSegments = []) {
    if (!group) {
      line.visible = false;
      return;
    }
    const pos = line.userData.positions;
    let o = 0;
    const write = (lm) => {
      place(this._v, lm, mirror, this._origin);
      pos[o++] = this._v.x; pos[o++] = this._v.y; pos[o++] = this._v.z;
    };
    for (const [i, j] of connections) {
      if (!group[i] || !group[j]) continue;
      write(group[i]);
      write(group[j]);
    }
    // 추가 세그먼트 (예: 목/척추 — 이미 좌표가 계산된 두 점)
    for (const [pa, pb] of extraSegments) {
      pos[o++] = pa.x; pos[o++] = pa.y; pos[o++] = pa.z;
      pos[o++] = pb.x; pos[o++] = pb.y; pos[o++] = pb.z;
    }
    if (o === 0) {
      line.visible = false;
      return;
    }
    // 위치가 매 프레임 바뀌므로 setPositions 로 갱신 (실제 그릴 길이만 잘라서 전달)
    line.geometry.setPositions(pos.subarray(0, o));
    line.visible = true;
  }

  _fillPoints(points, entries, mirror) {
    const pos = points.geometry.attributes.position.array;
    let o = 0;
    for (const lm of entries) {
      if (!lm) continue;
      place(this._v, lm, mirror, this._origin);
      pos[o++] = this._v.x; pos[o++] = this._v.y; pos[o++] = this._v.z;
    }
    points.geometry.attributes.position.needsUpdate = true;
    points.geometry.setDrawRange(0, o / 3);
    points.visible = o > 0;
  }

  _loop() {
    if (!this._running) return;
    this._perfStart();
    const lm = this.landmarksRef.current || {};
    const opt = this.optionsRef.current || {};
    const mirror = opt.mirror !== false;

    // 모든 좌표를 몸통 중심 기준으로 그리기 위해 먼저 원점부터 갱신
    this._updateOrigin(lm.pose);

    // 포즈 + 목(어깨 중점 -> 코) + 짧은 척추(어깨 중점 -> 아래)
    if (opt.showPose !== false && lm.pose) {
      const extra = [];
      const ls = lm.pose[POSE.LEFT_SHOULDER];
      const rs = lm.pose[POSE.RIGHT_SHOULDER];
      const nose = lm.pose[POSE.NOSE];
      if (ls && rs) {
        // 어깨 중점(= 대개 원점) 과 어깨 너비
        place(this._a, {
          x: (ls.x + rs.x) / 2,
          y: (ls.y + rs.y) / 2,
          z: ((ls.z || 0) + (rs.z || 0)) / 2,
        }, mirror, this._origin);
        place(this._b, ls, mirror, this._origin);
        place(this._c, rs, mirror, this._origin);
        const shoulderWidth = this._b.distanceTo(this._c);

        if (nose) {
          const neckTop = this._b.copy(this._a);
          place(this._c, nose, mirror, this._origin);
          extra.push([neckTop.clone(), this._c.clone()]);
        }
        // 골반 대신 어깨 중점에서 아래로 내려가는 짧은 척추만 (흉상 느낌)
        extra.push([
          this._a.clone(),
          this._a.clone().setY(this._a.y - shoulderWidth * SPINE_RATIO),
        ]);
      }
      this._fillLine(this.poseLine, POSE_UPPER_CONNECTIONS, lm.pose, mirror, extra);
    } else {
      this.poseLine.visible = false;
    }

    // 손
    if (opt.showHands !== false) {
      this._fillLine(this.leftHandLine, HAND_CONNECTIONS, lm.leftHand, mirror);
      this._fillLine(this.rightHandLine, HAND_CONNECTIONS, lm.rightHand, mirror);
    } else {
      this.leftHandLine.visible = false;
      this.rightHandLine.visible = false;
    }

    // 관절 점 (포즈 + 양손)
    const jointEntries = [];
    if (opt.showPose !== false && lm.pose) {
      for (const idx of POSE_UPPER_JOINTS) jointEntries.push(lm.pose[idx]);
    }
    if (opt.showHands !== false) {
      if (lm.leftHand) for (const p of lm.leftHand) jointEntries.push(p);
      if (lm.rightHand) for (const p of lm.rightHand) jointEntries.push(p);
    }
    this._fillPoints(this.jointPoints, jointEntries, mirror);

    // 얼굴
    if (opt.showFace !== false && lm.face) {
      this._fillPoints(this.facePoints, lm.face, mirror);
    } else {
      this.facePoints.visible = false;
    }

    // 여기까지가 랜드마크 읽기 + 좌표 변환(스켈레톤 버퍼 채우기)
    this._perfMark('read');

    // VRM: 본 회전을 먼저 적용하고 나서 update() 를 불러야 스프링본 등에 반영된다.
    // (머리 추적은 스켈레톤 토글과 무관하게 항상 동작 — VRM 은 별개 오브젝트)
    this._updateVrmHead(lm.pose, mirror);
    this._perfMark('head');
    this._updateVrmArms(lm.pose, mirror);
    this._perfMark('arms');
    // 손목 → 손가락 순서. 손가락의 부모(손)가 먼저 최신이어야 한다.
    // pose 를 같이 넘기는 건 손목 visibility 로 손 전체를 게이팅하기 위해서다.
    this._updateVrmWrists(lm.leftHand, lm.rightHand, lm.pose, mirror);
    this._perfMark('wrist');
    this._updateVrmFingers(lm.leftHand, lm.rightHand, lm.pose, mirror);
    this._perfMark('fingers');
    if (VIS_DEBUG) this._logVisibility(lm.pose);
    this._updateVrmMouth(lm.face);
    this._updateVrmEyes(lm.face);
    this._updateVrmBrows(lm.face);
    this._perfMark('face');
    const delta = this._clock.getDelta();
    if (this.vrm) this.vrm.update(delta);
    this._perfMark('vrm');

    // 같은 씬을 두 시점으로. 레이어 덕분에 서로 상대 오브젝트는 안 그려진다.
    this.controls.update(); // 가벼워서 mainR 에 같이 잡힌다
    this.renderer.render(this.scene, this.camera);
    this._perfMark('mainR');
    if (this.debugRenderer) this.debugRenderer.render(this.scene, this.debugCamera);
    this._perfMark('dbgR');

    this._perfFlush();
  }

  // 입 벌린 정도(0~1)를 얼굴 랜드마크에서 뽑아 VRM expression 에 넣는다.
  // 눈·기타 표정은 아직 안 함. (스켈레톤의 showFace 토글과는 무관 — VRM 은 별개)
  // 얼굴이 안 잡히면 목표 0(다문 입)으로 부드럽게 닫는다.
  _updateVrmMouth(face) {
    if (!this.vrm) return;
    const em = this.vrm.expressionManager;
    if (!em) return;

    let target = 0;
    if (face) {
      const up = face[FACE.UPPER_LIP_INNER];
      const low = face[FACE.LOWER_LIP_INNER];
      const cl = face[FACE.MOUTH_CORNER_L];
      const cr = face[FACE.MOUTH_CORNER_R];
      if (up && low && cl && cr) {
        const width = Math.hypot(cl.x - cr.x, cl.y - cr.y);
        // 0 으로 나누면 NaN 이 되고 EMA 를 타고 영구히 오염된다. 반드시 차단.
        if (width > 1e-6) {
          const openRatio = Math.hypot(up.x - low.x, up.y - low.y) / width;
          target = THREE.MathUtils.clamp((openRatio - MOUTH_OPEN_BIAS) * MOUTH_OPEN_GAIN, 0, 1);
        }
      }
    }

    this._mouthOpen += (target - this._mouthOpen) * MOUTH_SMOOTH;
    // 실제 morph 반영은 vrm.update(delta) 에서 일어난다 — 그래서 update 앞에 있어야 한다
    em.setValue(MOUTH_EXPRESSION, this._mouthOpen);
  }

  // Fcl_BRW_* morph 를 커스텀 expression 으로 등록해서 입·눈과 같은 setValue 로 쓴다.
  // morph 인덱스는 메시마다 다를 수 있으므로 메시별로 bind 를 하나씩 만든다.
  // 실패하면 경고만 남기고 눈썹은 조용히 비활성(_browReady = false).
  _registerBrowExpressions(vrm) {
    this._browReady = false;
    const em = vrm.expressionManager;
    if (!em) {
      console.warn('[brow] expressionManager 가 없어 눈썹을 건너뜁니다.');
      return;
    }

    const make = (name, morphName) => {
      // 기존 프리셋과 이름이 겹치면 덮어써서 다른 표정을 망가뜨린다
      if (em.getExpression(name)) {
        console.warn(`[brow] '${name}' 이 이미 있어 등록하지 않습니다.`);
        return false;
      }
      const expression = new VRMExpression(name);
      let bound = 0;
      vrm.scene.traverse((obj) => {
        const dict = obj.morphTargetDictionary;
        if (!dict) return;
        const index = dict[morphName];
        if (index === undefined) return;
        expression.addBind(new VRMExpressionMorphTargetBind({ primitives: [obj], index, weight: 1 }));
        bound++;
      });
      if (bound === 0) {
        console.warn(`[brow] morph '${morphName}' 을 가진 메시가 없어 '${name}' 을 건너뜁니다.`);
        return false;
      }
      em.registerExpression(expression);
      return true;
    };

    const up = make(BROW_UP_EXPRESSION, BROW_UP_MORPH);
    const down = make(BROW_DOWN_EXPRESSION, BROW_DOWN_MORPH);
    this._browReady = up && down;
    console.log(`[brow] ${this._browReady ? '등록 완료' : '등록 실패 — 눈썹 비활성'}:`,
      `${BROW_UP_EXPRESSION}→${BROW_UP_MORPH}, ${BROW_DOWN_EXPRESSION}→${BROW_DOWN_MORPH}`);
  }

  // 눈썹 높이(0~1 양방향)를 커스텀 expression 에 넣는다.
  // 얼굴이 안 잡히면 둘 다 0(중립)으로 되돌린다.
  _updateVrmBrows(face) {
    if (!this.vrm || !this._browReady) return;
    const em = this.vrm.expressionManager;
    if (!em) return;

    let raw = 0;
    if (face) {
      const bl = face[FACE.BROW_L], br = face[FACE.BROW_R];
      const el = face[FACE.EYE_L_UPPER], er = face[FACE.EYE_R_UPPER];
      const fa = face[FACE.EYE_L_OUTER], fb = face[FACE.EYE_R_OUTER];
      if (bl && br && el && er && fa && fb) {
        // 얼굴 크기로 정규화 → 카메라 거리와 무관
        const faceWidth = Math.hypot(fa.x - fb.x, fa.y - fb.y);
        // 0 으로 나누면 NaN → EMA 가 영구 오염된다. 반드시 차단.
        if (faceWidth > 1e-6) {
          const raiseL = Math.hypot(bl.x - el.x, bl.y - el.y);
          const raiseR = Math.hypot(br.x - er.x, br.y - er.y);
          const browRaise = (raiseL + raiseR) / 2 / faceWidth;
          raw = (browRaise - BROW_BIAS) * BROW_GAIN; // + 올림 / - 내림
        }
      }
    }

    const targetUp = THREE.MathUtils.clamp(raw, 0, 1);
    const targetDown = THREE.MathUtils.clamp(-raw, 0, 1);
    this._browUp += (targetUp - this._browUp) * BROW_SMOOTH;
    this._browDown += (targetDown - this._browDown) * BROW_SMOOTH;
    em.setValue(BROW_UP_EXPRESSION, this._browUp * BROW_UP_SCALE);
    em.setValue(BROW_DOWN_EXPRESSION, this._browDown * BROW_DOWN_SCALE);
  }

  // 한쪽 눈의 EAR(세로/가로). 못 재면 null.
  _eyeOpenness(face, upIdx, lowIdx, aIdx, bIdx) {
    const up = face[upIdx], low = face[lowIdx], a = face[aIdx], b = face[bIdx];
    if (!up || !low || !a || !b) return null;
    const width = Math.hypot(a.x - b.x, a.y - b.y);
    if (!(width > 1e-6)) return null; // 0 으로 나누면 NaN → EMA 가 영구 오염된다
    return Math.hypot(up.x - low.x, up.y - low.y) / width;
  }

  // 눈 감긴 정도(0~1)를 VRM 'blink' 에 넣는다. 좌우 공통(윙크는 아직 안 함).
  // 얼굴이 안 잡히면 0(눈 뜬 상태)으로 되돌린다.
  _updateVrmEyes(face) {
    if (!this.vrm) return;
    const em = this.vrm.expressionManager;
    if (!em) return;

    let target = 0;
    if (face) {
      const l = this._eyeOpenness(face, FACE.EYE_L_UPPER, FACE.EYE_L_LOWER, FACE.EYE_L_OUTER, FACE.EYE_L_INNER);
      const r = this._eyeOpenness(face, FACE.EYE_R_UPPER, FACE.EYE_R_LOWER, FACE.EYE_R_INNER, FACE.EYE_R_OUTER);
      // 한쪽만 잡혀도 그 값으로 간다 (양쪽 다 없으면 눈 뜬 상태 유지)
      const openness = l !== null && r !== null ? (l + r) / 2 : (l !== null ? l : r);
      if (openness !== null) {
        // 뜨면 openness 큼 → blink 0 / 감으면 작음 → blink 1
        target = 1 - THREE.MathUtils.clamp((openness - EYE_CLOSE_BIAS) * EYE_OPEN_GAIN, 0, 1);
      }
    }

    this._eyeBlink += (target - this._eyeBlink) * EYE_SMOOTH;
    em.setValue(BLINK_EXPRESSION, this._eyeBlink);
  }

  // --- 성능 계측 헬퍼 (측정 전용) ---
  _perfStart() {
    if (!PERF_LOG) return;
    if (this._perfWallStart === null) this._perfWallStart = performance.now();
    this._perfLast = performance.now();
  }

  // 직전 마크 이후 걸린 시간을 해당 구간에 누적
  _perfMark(key) {
    if (!PERF_LOG) return;
    const now = performance.now();
    this._perfAcc[key] += now - this._perfLast;
    this._perfLast = now;
  }

  _perfFlush() {
    if (!PERF_LOG) return;
    if (++this._perfCount < PERF_FRAMES) return;
    const n = this._perfCount;
    const wall = performance.now() - this._perfWallStart;
    let total = 0;
    const parts = [];
    for (const k of PERF_KEYS) {
      const avg = this._perfAcc[k] / n;
      total += avg;
      parts.push(`${k} ${avg.toFixed(2)}`);
      this._perfAcc[k] = 0;
    }
    // total = 우리 루프의 CPU 작업량 / fps = 실제 프레임 간격 기준
    console.log(
      `[perf] ${parts.join(' | ')} | total ${total.toFixed(2)}ms | fps ${(1000 * n / wall).toFixed(0)}`
    );
    this._perfCount = 0;
    this._perfWallStart = performance.now();
  }

  // VRM 머리를 사람 머리 방향에 맞춰 회전시킨다. (팔·손가락·표정은 아직 안 함)
  // pose 는 mirror 반영 전 "원본" 정규화 좌표를 그대로 쓴다.
  // 랜드마크가 없거나 이상하면 아무것도 안 하고 직전 각도를 유지한다.
  _updateVrmHead(pose, mirror) {
    if (!this.vrm || !pose) return;
    const humanoid = this.vrm.humanoid;
    if (!humanoid) return;
    // 정규화 공간이라 모델마다 좌표계가 일관됨 (raw 아님)
    const headBone = humanoid.getNormalizedBoneNode('head');
    if (!headBone) return;

    const nose = pose[POSE.NOSE];
    const earL = pose[POSE.LEFT_EAR];
    const earR = pose[POSE.RIGHT_EAR];
    if (!nose || !earL || !earR) return;

    // 귀 사이 거리로 정규화 → 카메라에서 멀어져도 회전량이 같게
    const ex = earL.x - earR.x;
    const ey = earL.y - earR.y;
    const earDist = Math.hypot(ex, ey);
    // 0 으로 나누면 NaN 이 나오고, EMA 를 타고 본 회전이 영구히 NaN 이 된다. 반드시 차단.
    if (!(earDist > 1e-4)) return;

    const earMidX = (earL.x + earR.x) / 2;
    const earMidY = (earL.y + earR.y) / 2;

    // 코가 귀 중점에서 좌우로 치우친 정도 (+ = 원본 영상 기준 오른쪽)
    const yawRaw = (nose.x - earMidX) / earDist;
    // 코가 귀 선보다 아래인 정도 (+ = 고개 숙임)
    const pitchRaw = (nose.y - earMidY) / earDist - HEAD_PITCH_BIAS;
    // 두 귀를 잇는 선의 기울기. earL 이 영상 오른쪽이라 dx > 0 → 정면일 때 0 근처
    const rollRaw = Math.atan2(ey, ex);

    // mirror 면 사람이 보이는 방향과 같아지도록 좌우 계열(yaw/roll)만 부호 반전.
    // (스켈레톤의 world_x = mirror ? -(x-원점) : +(x-원점) 규칙과 동일한 이유)
    const s = mirror ? -1 : 1;
    const clamp = THREE.MathUtils.clamp;
    const targetPitch = clamp(-HEAD_PITCH_GAIN * pitchRaw, -HEAD_MAX_ANGLE, HEAD_MAX_ANGLE);
    const targetYaw = clamp(s * HEAD_YAW_GAIN * yawRaw, -HEAD_MAX_ANGLE, HEAD_MAX_ANGLE);
    const targetRoll = clamp(s * HEAD_ROLL_GAIN * rollRaw, -HEAD_MAX_ANGLE, HEAD_MAX_ANGLE);

    // 튀지 않게 현재 각도에서 목표로 EMA 보간
    const r = headBone.rotation;
    r.x += (targetPitch - r.x) * SMOOTH_HEAD;
    r.y += (targetYaw - r.y) * SMOOTH_HEAD;
    r.z += (targetRoll - r.z) * SMOOTH_HEAD;
  }

  // VRM 팔(위팔 + 아래팔)을 사람 팔 방향에 맞춘다. 손가락은 아직 안 함.
  _updateVrmArms(pose, mirror) {
    if (!this.vrm || !pose) return;
    const humanoid = this.vrm.humanoid;
    if (!humanoid) return;

    // MediaPipe 의 left/right 는 "사람 기준"이다.
    // 캐릭터는 카메라를 보고 서 있으므로 캐릭터의 왼팔은 화면 오른쪽(+X), 오른팔은 왼쪽(-X).
    // 거울 모드에서는 사람의 왼팔이 화면 왼쪽에 오므로 VRM 의 "오른팔"과 짝이 된다.
    const chains = mirror
      ? [
          [POSE.LEFT_SHOULDER, POSE.LEFT_ELBOW, POSE.LEFT_WRIST, 'right'],
          [POSE.RIGHT_SHOULDER, POSE.RIGHT_ELBOW, POSE.RIGHT_WRIST, 'left'],
        ]
      : [
          [POSE.LEFT_SHOULDER, POSE.LEFT_ELBOW, POSE.LEFT_WRIST, 'left'],
          [POSE.RIGHT_SHOULDER, POSE.RIGHT_ELBOW, POSE.RIGHT_WRIST, 'right'],
        ];

    for (const [si, ei, wi, side] of chains) {
      // 위팔을 반드시 먼저. 아래팔은 부모(=위팔)의 "현재" 월드 회전을 읽어서
      // 목표 방향을 부모 공간으로 옮기므로, 순서가 뒤바뀌면 한 프레임 늦은
      // 부모 회전으로 계산돼 굽힘 방향이 틀어진다.
      this._applyBoneDirection(humanoid, pose[si], pose[ei], `${side}UpperArm`, `${side}LowerArm`, mirror, Z_WEIGHT_ARM, DIR_SMOOTH_ARM, SMOOTH_ARM);
      this._applyBoneDirection(humanoid, pose[ei], pose[wi], `${side}LowerArm`, `${side}Hand`, mirror, Z_WEIGHT_ARM, DIR_SMOOTH_ARM, SMOOTH_ARM);
    }
  }

  // 손목(Hand 본)의 방향 + roll(손바닥이 향하는 방향)을 맞춘다.
  // 방향 하나만 맞추는 setFromUnitVectors 로는 twist 가 결정되지 않으므로,
  // 손바닥 평면에서 3축 basis 를 만들어 회전을 통째로 지정한다.
  // 팔 뒤 / 손가락 앞에 불려야 한다.
  _updateVrmWrists(leftHand, rightHand, pose, mirror) {
    if (!this.vrm) return;
    const humanoid = this.vrm.humanoid;
    if (!humanoid) return;
    this._applyWrist(humanoid, leftHand, mirror ? 'right' : 'left', mirror,
      this._handTrusted(pose, POSE.LEFT_WRIST));
    this._applyWrist(humanoid, rightHand, mirror ? 'left' : 'right', mirror,
      this._handTrusted(pose, POSE.RIGHT_WRIST));
  }

  // 손 랜드마크에는 visibility 가 없다. 팔이 가려지면 손 좌표도 못 믿으므로
  // pose 쪽 손목 신뢰도로 그 손 전체(손목 + 손가락)를 막는다.
  // pose 자체가 없으면(손만 잡힌 경우) 막지 않는다.
  _handTrusted(pose, wristIdx) {
    if (!VIS_GATING || !pose) return true;
    return isVisible(pose[wristIdx]);
  }

  // f(손목→중지뿌리)와 l(검지뿌리→새끼뿌리)로 직교정규 basis 를 만든다.
  // 두 벡터가 평행하면(손바닥 평면이 안 나오면) false.
  _makeHandBasis(f, l, out) {
    const F = this._wX.copy(f);
    if (!(F.lengthSq() > 1e-12)) return false;
    F.normalize();
    const n = this._wY.crossVectors(F, l);
    if (!(n.lengthSq() > 1e-12)) return false;
    n.normalize();
    const l2 = this._wZ.crossVectors(n, F);
    out.makeBasis(l2, n, F);
    return true;
  }

  _applyWrist(humanoid, hand, side, mirror, trusted) {
    if (!hand) return;
    if (!trusted) {
      this._coastBone(humanoid, `${side}Hand`, SMOOTH_WRIST);
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
    // (거울 모드에서는 place() 의 x 반전이 왼손 좌표를 오른손 형상으로 바꾸고,
    //  그 손을 VRM 오른손에 붙이므로 여기서도 짝이 맞는다 — 실측 확인.)
    this._wF.copy(mid.position);
    this._wL.copy(idx.position).sub(lit.position);
    if (!this._makeHandBasis(this._wF, this._wL, this._wM)) return;
    this._wRestQ.setFromRotationMatrix(this._wM);

    // 목표 basis: 랜드마크를 기존 place() 규약으로 옮겨서 같은 방식으로 구성.
    // 두 축 모두 z 가중치 + 방향 EMA 를 거친다. 손바닥 평면은 z 노이즈에
    // 특히 약해서(손이 카메라와 평행하면 법선이 z 로만 결정됨) 여기 필터가 중요하다.
    place(this._armA, wrist, mirror, this._origin);
    place(this._armB, middleMCP, mirror, this._origin);
    this._wF.copy(this._armB).sub(this._armA);
    this._wF.z *= Z_WEIGHT_WRIST;
    if (!(this._wF.lengthSq() > 1e-8)) return;
    this._wF.normalize();
    this._smoothDir(`${side}Hand:f`, this._wF, DIR_SMOOTH_WRIST);

    place(this._armA, indexMCP, mirror, this._origin);
    place(this._armB, pinkyMCP, mirror, this._origin);
    this._wL.copy(this._armA).sub(this._armB);
    this._wL.z *= Z_WEIGHT_WRIST;
    if (!(this._wL.lengthSq() > 1e-8)) return;
    this._wL.normalize();
    this._smoothDir(`${side}Hand:l`, this._wL, DIR_SMOOTH_WRIST);

    if (!this._makeHandBasis(this._wF, this._wL, this._wM)) return;
    this._wTargetQ.setFromRotationMatrix(this._wM);

    // 목표 basis 는 월드, rest basis 는 부모 공간이므로
    //   parentQ * (qLocal * qRest) = qTarget  →  qLocal = parentQ⁻¹ · qTarget · qRest⁻¹
    bone.parent.getWorldQuaternion(this._armQ);
    this._wTargetQ.premultiply(this._armQ.invert()).multiply(this._wRestQ.invert());
    this._rememberTarget(`${side}Hand`, this._wTargetQ);
    bone.quaternion.slerp(this._wTargetQ, SMOOTH_WRIST);
  }

  // VRM 손가락을 손 랜드마크(21점)에 맞춰 굽힌다.
  // 팔을 먼저 적용한 뒤에 불려야 한다 — 손가락의 부모(손/아래팔)가 이미 회전돼 있어야
  // 부모 회전 제거가 최신 값으로 이뤄진다.
  _updateVrmFingers(leftHand, rightHand, pose, mirror) {
    if (!this.vrm) return;
    const humanoid = this.vrm.humanoid;
    if (!humanoid) return;
    // 팔과 같은 규칙: 사람의 왼손은 거울 모드에서 화면 왼쪽 = 캐릭터의 오른손
    this._applyHand(humanoid, leftHand, mirror ? 'right' : 'left', mirror,
      this._handTrusted(pose, POSE.LEFT_WRIST));
    this._applyHand(humanoid, rightHand, mirror ? 'left' : 'right', mirror,
      this._handTrusted(pose, POSE.RIGHT_WRIST));
  }

  // 손 하나. 손이 안 잡히면 그 손 손가락 전체를 건너뛰고 직전 각도를 유지한다.
  // 손목이 가려진(신뢰 불가) 프레임에는 마지막 신뢰 목표로만 수렴시킨다.
  _applyHand(humanoid, hand, side, mirror, trusted) {
    if (!hand) return;
    for (const { lm, bones } of FINGER_CHAINS) {
      for (let i = 0; i < bones.length; i++) {
        const boneName = `${side}${bones[i]}`;
        if (!trusted) {
          this._coastBone(humanoid, boneName, SMOOTH_FINGER);
          continue;
        }
        // 끝마디(Distal)는 자식 본이 없다 → childName 을 null 로 넘겨 폴백을 쓰게 한다
        const childName = i + 1 < bones.length ? `${side}${bones[i + 1]}` : null;
        this._applyBoneDirection(
          humanoid, hand[lm[i]], hand[lm[i + 1]],
          boneName, childName,
          mirror, Z_WEIGHT_FINGER, DIR_SMOOTH_FINGER, SMOOTH_FINGER
        );
      }
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

  // 본 하나를 "fromLm → toLm 방향"으로 향하게 한다. 위팔/아래팔 공통.
  // childName 은 rest 방향을 얻기 위한 자식 본(위팔→아래팔, 아래팔→손).
  // 랜드마크가 없거나 길이가 0 이면 아무것도 안 하고 직전 회전을 유지한다.
  // VIS_DEBUG 용: 임계값 감을 잡으려고 60프레임마다 관절별 visibility 를 찍는다.
  _logVisibility(pose) {
    if (++this._visLogCount < 60) return;
    this._visLogCount = 0;
    if (!pose) {
      console.log('[vis] pose 없음');
      return;
    }
    const f = (i) => {
      const v = pose[i]?.visibility;
      return v == null ? ' -- ' : `${v < VIS_THRESHOLD ? '!' : ' '}${v.toFixed(2)}`;
    };
    console.log(
      `[vis] 어깨 L${f(POSE.LEFT_SHOULDER)} R${f(POSE.RIGHT_SHOULDER)}` +
      ` | 팔꿈치 L${f(POSE.LEFT_ELBOW)} R${f(POSE.RIGHT_ELBOW)}` +
      ` | 손목 L${f(POSE.LEFT_WRIST)} R${f(POSE.RIGHT_WRIST)}` +
      `  (임계 ${VIS_THRESHOLD}, ! = 게이팅됨)`
    );
  }

  // 신뢰 불가 프레임용: 새 목표를 만들지 않고 마지막 신뢰 목표로만 계속 수렴시킨다.
  // 아직 한 번도 신뢰 값이 없었다면 아무것도 안 한다(rest 유지).
  _coastBone(humanoid, boneName, smooth) {
    const target = this._boneTargets.get(boneName);
    if (!target) return;
    const bone = humanoid.getNormalizedBoneNode(boneName);
    if (bone) bone.quaternion.slerp(target, smooth);
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

  _applyBoneDirection(humanoid, fromLm, toLm, boneName, childName, mirror, zWeight, dirSmooth, smooth) {
    if (!fromLm || !toLm) return;
    // 양 끝 중 하나라도 신뢰도가 낮으면 이 본은 이번 프레임에 갱신하지 않는다.
    // (위팔은 어깨+팔꿈치, 아래팔은 팔꿈치+손목이 자동으로 검사된다)
    if (!isVisible(fromLm) || !isVisible(toLm)) {
      this._coastBone(humanoid, boneName, smooth);
      return;
    }
    const bone = humanoid.getNormalizedBoneNode(boneName);
    if (!bone || !bone.parent) return;
    const child = childName ? humanoid.getNormalizedBoneNode(childName) : null;
    if (childName && !child) return;

    // 목표 방향: 기존 place() 규약 그대로 (mirror·원점 반영된 three 좌표)
    place(this._armA, fromLm, mirror, this._origin);
    place(this._armB, toLm, mirror, this._origin);
    const dir = this._armB.sub(this._armA);
    // z 가중치는 "차이 벡터"의 z 에 건다. place() 가 z 에 대해 선형이라
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
    this._rememberTarget(boneName, this._armTargetQ);
    // 튀지 않게 slerp 로 보간
    bone.quaternion.slerp(this._armTargetQ, smooth);
  }

  // 녹화 대상 캔버스 = 메인 렌더러(아바타만 그려짐). 스켈레톤·웹캠은 다른 캔버스라 안 들어간다.
  getMainCanvas() {
    return this.renderer ? this.renderer.domElement : null;
  }

  // 카메라를 초기 정면 뷰로 되돌린다.
  // OrbitControls 는 target 기준으로 도니까 position/target 둘 다 되돌려야 한다.
  //
  // 순서가 중요하다. OrbitControls.update() 는 damping 이 꺼져 있으면 남아 있던
  // sphericalDelta 를 "전부" 한 번에 적용한다(켜져 있을 때는 dampingFactor 만큼만).
  // 그래서 홈 좌표를 먼저 넣고 damping 을 끈 채 update() 하면, 직전 드래그의 잔여
  // 회전량이 통째로 더해져 카메라가 엉뚱한 각도(아바타를 올려다보는 위치)로 튄다.
  // → 잔여분을 먼저 비운 뒤에 홈으로 스냅해야 한다.
  resetView() {
    this.controls.enableDamping = false;
    this.controls.update(); // 1) 잔여 sphericalDelta/panOffset 소진 + 0으로 리셋

    // 2) 홈 상태로 스냅. update() 가 position-target 으로 구면좌표를 다시 계산하고
    //    마지막에 object.lookAt(target) 까지 해주므로 방향도 함께 맞춰진다.
    this.camera.position.copy(this._homePos);
    this.controls.target.copy(this._homeTarget);
    this.controls.update();

    this.controls.enableDamping = true;
  }

  _onResize() {
    const w = this.mainContainer.clientWidth;
    const h = this.mainContainer.clientHeight;
    if (w && h) {
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
    }

    if (!this.debugRenderer) return;
    const dw = this.debugContainer.clientWidth;
    const dh = this.debugContainer.clientHeight;
    if (!dw || !dh) return;
    this.debugCamera.aspect = dw / dh;
    this.debugCamera.updateProjectionMatrix();
    this.debugRenderer.setSize(dw, dh);
    // LineMaterial 은 px 두께 계산에 해상도를 쓴다. 선은 디버그 렌더러에만
    // 그려지므로 메인이 아니라 디버그 창 크기로 갱신해야 두께가 맞는다.
    for (const line of this._fatLines) line.material.resolution.set(dw, dh);
  }

  dispose() {
    this._running = false;
    this.renderer.setAnimationLoop(null);
    window.removeEventListener('resize', this._onResize);
    this.controls.dispose();
    // 굵은 선 geometry/material 정리
    for (const line of this._fatLines) {
      line.geometry.dispose();
      line.material.dispose();
    }
    this._fatLines.length = 0;
    // VRM 은 아래 traverse 로 정리하면 안 된다 — 멀티머티리얼 메시의 material 이
    // 배열이라 material.dispose() 가 터지고, 텍스처도 안 지워진다. 먼저 떼어내고
    // deepDispose 로 지오메트리/머티리얼/텍스처를 통째로 정리한다.
    if (this.vrm) {
      this.scene.remove(this.vrm.scene);
      VRMUtils.deepDispose(this.vrm.scene);
      this.vrm = null;
    }
    this.scene.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) obj.material.dispose();
    });
    // 렌더러 2개 = WebGL 컨텍스트 2개. 둘 다 정리하고 canvas 도 둘 다 떼어낸다.
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode === this.mainContainer) {
      this.mainContainer.removeChild(this.renderer.domElement);
    }
    if (this.debugRenderer) {
      this.debugRenderer.dispose();
      if (this.debugRenderer.domElement.parentNode === this.debugContainer) {
        this.debugContainer.removeChild(this.debugRenderer.domElement);
      }
      this.debugRenderer = null;
    }
  }
}
