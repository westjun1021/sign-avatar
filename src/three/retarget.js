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

// ===========================================================================
// 리타깃 튜닝 상수 — 떨림/펄럭임이 보이면 여기만 만지면 된다.
//
// 신호는 두 단계로 걸러진다:
//   랜드마크 → [z 가중치] → [방향벡터 EMA] → 회전 계산 → [회전 slerp] → 본
// 뒤쪽(회전 slerp)만으로는 z 가 한 프레임 튈 때의 방향 급변을 못 잡아서
// 앞단(방향벡터 EMA)에서 한 번 더 거른다.
// ===========================================================================

// [회전 slerp/EMA 계수] 낮추면 부드럽지만 둔해지고, 높이면 반응은 빠르지만 떨린다.
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
export function isVisible(lm) {
  if (!lm) return false;
  if (!VIS_GATING) return true;
  const v = lm.visibility;
  return v == null || v >= VIS_THRESHOLD;
}

export class BoneRetargeter {
  // place: (outVec3, lm) => void — 랜드마크를 three 좌표로 옮긴다.
  //   호출부가 자기 좌표계 규약(거울/원점/축정렬)을 여기에 가둬서 넘긴다.
  //   NaN 좌표는 호출부가 미리 null 로 걸러서 넘겨야 한다.
  constructor(place) {
    this._place = place;
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
  }

  // 한쪽 팔(위팔 + 아래팔). side 는 VRM 쪽 'left' | 'right'.
  // 위팔을 반드시 먼저. 아래팔은 부모(=위팔)의 "현재" 월드 회전을 읽어서
  // 목표 방향을 부모 공간으로 옮기므로, 순서가 뒤바뀌면 한 프레임 늦은
  // 부모 회전으로 계산돼 굽힘 방향이 틀어진다.
  applyArm(humanoid, shoulderLm, elbowLm, wristLm, side) {
    this._applyBoneDirection(humanoid, shoulderLm, elbowLm,
      `${side}UpperArm`, `${side}LowerArm`, Z_WEIGHT_ARM, DIR_SMOOTH_ARM, SMOOTH_ARM);
    this._applyBoneDirection(humanoid, elbowLm, wristLm,
      `${side}LowerArm`, `${side}Hand`, Z_WEIGHT_ARM, DIR_SMOOTH_ARM, SMOOTH_ARM);
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

  // 손목(Hand 본)의 방향 + roll(손바닥이 향하는 방향)을 맞춘다.
  // 방향 하나만 맞추는 setFromUnitVectors 로는 twist 가 결정되지 않으므로,
  // 손바닥 평면에서 3축 basis 를 만들어 회전을 통째로 지정한다.
  // 팔 뒤 / 손가락 앞에 불려야 한다.
  applyWrist(humanoid, hand, side, trusted) {
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

    if (!this._makeHandBasis(this._wF, this._wL, this._wM)) return;
    this._wTargetQ.setFromRotationMatrix(this._wM);

    // 목표 basis 는 월드, rest basis 는 부모 공간이므로
    //   parentQ * (qLocal * qRest) = qTarget  →  qLocal = parentQ⁻¹ · qTarget · qRest⁻¹
    bone.parent.getWorldQuaternion(this._armQ);
    this._wTargetQ.premultiply(this._armQ.invert()).multiply(this._wRestQ.invert());
    this._rememberTarget(`${side}Hand`, this._wTargetQ);
    bone.quaternion.slerp(this._wTargetQ, SMOOTH_WRIST);
  }

  // 손 하나의 손가락 전체. 손이 안 잡히면 건너뛰고 직전 각도를 유지한다.
  // 손목이 가려진(신뢰 불가) 프레임에는 마지막 신뢰 목표로만 수렴시킨다.
  // 팔·손목을 먼저 적용한 뒤에 불려야 한다 — 손가락의 부모(손)가 이미 회전돼 있어야
  // 부모 회전 제거가 최신 값으로 이뤄진다.
  applyFingers(humanoid, hand, side, trusted) {
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
          Z_WEIGHT_FINGER, DIR_SMOOTH_FINGER, SMOOTH_FINGER
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

  // 본 하나를 "fromLm → toLm 방향"으로 향하게 한다. 위팔/아래팔/손가락 공통.
  // childName 은 rest 방향을 얻기 위한 자식 본(위팔→아래팔, 아래팔→손).
  // 랜드마크가 없거나 길이가 0 이면 아무것도 안 하고 직전 회전을 유지한다.
  _applyBoneDirection(humanoid, fromLm, toLm, boneName, childName, zWeight, dirSmooth, smooth) {
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
    this._rememberTarget(boneName, this._armTargetQ);
    // 튀지 않게 slerp 로 보간
    bone.quaternion.slerp(this._armTargetQ, smooth);
  }
}
