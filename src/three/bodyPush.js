// 손이 아바타 몸통을 파고드는 걸 완화한다 (F-5).
//
// FreeMoCap 3D 좌표는 "실제 사람"의 관절 위치라 정확하지만, VRM 아바타의 몸통 두께는
// 그 사람과 다르다. 리타깃은 방향만 쓰기 때문에(길이·두께는 아바타 것을 그대로 씀)
// 사람 기준으로 가슴에 살짝 닿는 손이 아바타에서는 몸통 안으로 들어가 버린다.
//
// 그래서 리타깃이 끝난 "아바타 자신의" 자세를 보고, 손목이 몸통 앞면보다 안쪽에
// 있으면 아래팔을 앞으로 조금 돌려서 손목을 표면까지 밀어낸다.
// 사람 좌표가 아니라 아바타 좌표에서 판정하는 이유가 이것이다 — 파고드는 주체가 아바타다.
//
// 이건 완벽한 충돌 해결이 아니라 "파고듦 완화"다:
//   - 팔꿈치는 그대로 두고 아래팔 방향만 다시 잡는다(단순 버전).
//     그래서 손목이 앞으로 나오는 만큼 손이 몸 중심선 쪽으로는 덜 오게 된다.
//   - 손가락 끝이 파고드는 건 보지 않는다. 손목만 본다.
//   - 세게 밀수록 확실히 막지만 손이 몸에서 떠 보인다 → PUSH_STRENGTH 로 절충.
//
// 몸통은 척추선(골반→목)을 축으로 한 상자로 근사한다. 손이 몸통 옆이나 머리 위로
// 정상적으로 지나갈 때는 밀면 안 되므로, 상자 밖으로 나가면 밀기 세기가 0 으로
// 부드럽게 사라진다(딱 잘라 끄면 경계에서 손이 튄다).

import * as THREE from 'three';

// ===========================================================================
// 튜닝 상수 — 전부 "아바타 어깨너비(양 위팔 본 사이 거리)" 대비 비율이다.
// 크기 슬라이더로 아바타가 커져도 같은 비율로 따라가라고 이렇게 뒀다.
//
// 기본값은 public/avatar.vrm 의 메시를 직접 재서 넣었다 (어깨너비 0.298m 기준,
// 가슴 높이 띠의 정점 범위): 척추선 → 앞면 0.47 · 뒷면 0.29 · 옆면 0.59 배.
// 다른 아바타로 바꾸면 비율이 조금 달라지겠지만 사람 몸 비율이라 크게 벗어나지 않는다.
// ===========================================================================

// [BODY_DEPTH] 척추선 → 몸통 앞면. 손목이 여기서 멈춘다.
// 실측 가슴 표면이 0.47 이고, 손목 뼈는 표면보다 손 두께만큼 앞에 있어야 손이
// 가슴에 "얹힌" 것처럼 보이므로 조금 더 준다.
// 작으면 여전히 파고들고, 크면 손이 가슴 앞에 떠 있는 것처럼 보인다.
export const BODY_DEPTH = 0.55;

// [PUSH_STRENGTH] 0~1. 필요한 밀기량의 몇 %를 실제로 적용할지.
// 낮으면 살짝만 보정(자연스럽지만 조금 파고듦), 높으면 확실히 막지만 부자연스러울 수 있다.
export const PUSH_STRENGTH = 0.8;

// [몸통 상자 크기] 여기 밖으로 나간 손은 "몸통 옆/위/뒤를 지나가는 중"이라 안 민다.
const TORSO_HALF_WIDTH = 0.6;  // 척추선 → 몸통 옆면 (실측 0.59)
const BACK_DEPTH = 0.3;        // 척추선 → 몸통 뒷면 (실측 0.29). 이보다 뒤 = 등 뒤 = 몸 밖
const HIP_DROP = 0.3;          // 골반보다 이만큼 아래까지 몸통으로 본다
// [페이드 폭] 상자 경계에서 밀기가 0 으로 잦아드는 구간. 넓을수록 전환이 부드럽다.
const SIDE_FADE = 0.3;
const BACK_FADE = 0.25;
const END_FADE = 0.4;          // 골반 아래 / 목 위

// [MAX_PUSH] 한 번에 밀어낼 수 있는 최대 거리. 안전장치다.
// 손이 몸통 깊숙이(특히 등 뒤에서) 들어온 이상한 자세에서는 앞면까지 20cm 넘게
// 밀어야 하는데, 그대로 두면 팔이 통째로 앞으로 튀어나온다. 그런 프레임은
// 어차피 완벽히 살릴 수 없으니 "조금 덜 파고드는" 선에서 자른다.
// 가슴에 손을 대는 정상 동작의 밀기량은 보통 0.2 * 어깨너비 안쪽이라 여기 안 걸린다.
const MAX_PUSH = 0.35;

// 아래팔이 향할 수 있는 최대 "앞" 성분. 팔꿈치가 몸통보다 뒤에 있으면 아무리 돌려도
// 손목이 앞면까지 못 오는데, 그때 방향이 발산하지 않게 여기서 자른다(≈18° 여유).
const MAX_FORWARD_COS = 0.95;

const smoothstep = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

// x 가 [lo, hi] 안이면 1, 바깥으로 fade 만큼 벗어나면 0. 그 사이는 부드럽게.
function band(x, lo, hi, fade) {
  if (x < lo) return smoothstep(1 - (lo - x) / fade);
  if (x > hi) return smoothstep(1 - (x - hi) / fade);
  return 1;
}

export class BodyPusher {
  constructor() {
    // 이번 프레임의 몸통 좌표계 (전부 월드 기준)
    this._hips = new THREE.Vector3();  // 척추선의 아래 끝 = 높이 0
    this._up = new THREE.Vector3();    // 골반 → 목
    this._lat = new THREE.Vector3();   // 아바타의 왼쪽
    this._fwd = new THREE.Vector3();   // 아바타가 바라보는 쪽
    this.spineLen = 0;
    this.width = 0;
    this.ready = false;
    // 스크래치
    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
    this._rel = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._perp = new THREE.Vector3();
    this._rest = new THREE.Vector3();
    this._q = new THREE.Quaternion();
  }

  // 후보 이름 중 처음 있는 본의 월드 위치를 out 에 담는다. 하나도 없으면 false.
  _world(humanoid, names, out) {
    for (const name of names) {
      const bone = humanoid.getNormalizedBoneNode(name);
      if (bone) {
        bone.getWorldPosition(out);
        return true;
      }
    }
    return false;
  }

  // 이번 프레임의 몸통 좌표계를 다시 잰다. 리타깃(팔 회전) 뒤에 부르면 된다 —
  // 몸통 본은 리타깃이 건드리지 않지만 _fitVrm 의 크기/높이는 매 프레임 바뀐다.
  // 필요한 본이 없으면 false → 호출부가 밀기를 건너뛴다.
  update(vrm) {
    this.ready = false;
    const humanoid = vrm && vrm.humanoid;
    if (!humanoid) return false;

    if (!this._world(humanoid, ['hips'], this._hips)) return false;
    // 목이 없는 모델을 위해 위쪽 척추 본으로 순서대로 폴백한다
    if (!this._world(humanoid, ['neck', 'upperChest', 'chest', 'spine'], this._a)) return false;

    // 세로축(척추선)
    this._up.copy(this._a).sub(this._hips);
    const spineLen = this._up.length();
    if (!(spineLen > 1e-6)) return false;
    this._up.divideScalar(spineLen);

    // 좌우축 = 오른위팔 → 왼위팔. 어깨가 기울어도 축이 안 틀어지게 척추 성분을 뺀다.
    if (!this._world(humanoid, ['leftUpperArm'], this._a)) return false;
    if (!this._world(humanoid, ['rightUpperArm'], this._b)) return false;
    this._lat.copy(this._a).sub(this._b);
    const width = this._lat.length();
    if (!(width > 1e-6)) return false;
    this._lat.addScaledVector(this._up, -this._lat.dot(this._up));
    if (!(this._lat.lengthSq() > 1e-12)) return false;
    this._lat.normalize();

    // 앞축 = lat × up. transform.js 의 기준축과 같은 레시피다(오른손계에서 X×Y=Z).
    // 본에서 뽑으므로 아바타 루트가 어떻게 돌아 있든(VRM0 의 180° 회전 포함) 맞는다.
    this._fwd.crossVectors(this._lat, this._up);

    this.spineLen = spineLen;
    this.width = width;
    this.ready = true;
    return true;
  }

  // 한쪽 팔의 손목을 몸통 앞면 밖으로 밀어낸다.
  // applyArm 뒤 / applyWrist 앞에 불러야 한다:
  //   - 뒤: 밀기는 리타깃이 만든 "현재" 아래팔 방향을 고쳐 쓰는 것이라 팔이 먼저 서야 한다.
  //   - 앞: 손목·손가락은 부모(아래팔)의 월드 회전을 읽어 자기 회전을 푸는데,
  //         그 부모 회전이 여기서 바뀌기 때문이다. 순서가 뒤바뀌면 손 방향이 틀어진다.
  // side 는 VRM 쪽 'left' | 'right'. 손목이 실제로 밀려난 거리를 돌려준다(0 = 안 밀었음).
  push(humanoid, side) {
    if (!this.ready) return 0;
    const lower = humanoid.getNormalizedBoneNode(`${side}LowerArm`);
    const hand = humanoid.getNormalizedBoneNode(`${side}Hand`);
    if (!lower || !lower.parent || !hand) return 0;

    lower.getWorldPosition(this._a); // 팔꿈치 (밀어도 안 움직인다 — 회전의 중심)
    hand.getWorldPosition(this._b);  // 손목
    this._dir.copy(this._b).sub(this._a);
    const forearm = this._dir.length();
    if (!(forearm > 1e-6)) return 0;
    this._dir.divideScalar(forearm);

    const w = this.width;
    const depth = BODY_DEPTH * w;

    // 손목을 몸통 좌표로: 앞(front) / 옆(side) / 높이(골반 = 0, 목 = spineLen)
    this._rel.copy(this._b).sub(this._hips);
    const front = this._rel.dot(this._fwd);
    if (front >= depth) return 0; // 이미 몸통 앞면 바깥 → 건드릴 이유가 없다

    const lateral = Math.abs(this._rel.dot(this._lat));
    const height = this._rel.dot(this._up);
    // 몸통 상자 안일수록 1 에 가깝다. 옆·위아래·등 뒤로 나가면 부드럽게 0.
    const strength = PUSH_STRENGTH
      * band(lateral, 0, TORSO_HALF_WIDTH * w, SIDE_FADE * w)
      * band(height, -HIP_DROP * w, this.spineLen, END_FADE * w)
      * band(front, -BACK_DEPTH * w, depth, BACK_FADE * w);
    if (!(strength > 1e-3)) return 0;

    // 팔꿈치를 고정한 채 아래팔만 돌린다. 손목이 앞면(depth)에 정확히 닿으려면
    // 아래팔 방향의 앞 성분이 need 여야 한다:  팔꿈치앞 + 아래팔길이 * need = depth
    this._rel.copy(this._a).sub(this._hips);
    const elbowFront = this._rel.dot(this._fwd);
    const cur = this._dir.dot(this._fwd);
    // 앞 성분 1 단위 = 손목이 아래팔 길이만큼 앞으로 간다 → MAX_PUSH 도 같은 자로 잰다.
    const need = Math.min(
      (depth - elbowFront) / forearm,
      cur + (MAX_PUSH * w) / forearm,
      MAX_FORWARD_COS
    );
    // front < depth 였으므로 클램프에 걸리지 않는 한 need > cur 이 보장된다.
    const target = cur + (need - cur) * strength;
    if (target <= cur) return 0;

    // 앞쪽으로 "최소 회전": 방향을 앞 성분과 그 수직 성분으로 나눠 앞 성분만 키운다.
    // (앞축 쪽으로 통째로 lerp 하면 팔이 몸 중심선 쪽으로도 딸려 와서 자세가 무너진다)
    this._perp.copy(this._dir).addScaledVector(this._fwd, -cur);
    const perpLen = this._perp.length();
    if (!(perpLen > 1e-6)) return 0; // 이미 정확히 앞/뒤를 향함 → 회전축이 없다
    this._perp.divideScalar(perpLen);
    this._dir.copy(this._fwd).multiplyScalar(target)
      .addScaledVector(this._perp, Math.sqrt(Math.max(0, 1 - target * target)));

    // 새 월드 방향 → 아래팔 본의 로컬 회전. retarget._applyBoneDirection 과 같은 식이다:
    // rest 방향(부모 공간)은 자식 본의 로컬 위치, 목표 방향은 부모 월드 회전을 벗겨서 쓴다.
    this._rest.copy(hand.position);
    if (!(this._rest.lengthSq() > 1e-12)) return 0;
    this._rest.normalize();
    lower.parent.getWorldQuaternion(this._q);
    this._dir.applyQuaternion(this._q.invert());
    // slerp 를 안 거는 이유: 입력(리타깃된 팔 자세)이 이미 스무딩된 값이고
    // 이 보정은 그 값의 연속 함수라, 여기서 또 걸면 밀기만 한 박자 늦게 따라온다.
    lower.quaternion.setFromUnitVectors(this._rest, this._dir);

    return (target - cur) * forearm;
  }
}
