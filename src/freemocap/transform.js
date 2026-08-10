// FreeMoCap 좌표 → Three.js 좌표 변환.
//
// Three.js 규약: +X 화면 오른쪽 / +Y 위 / +Z 화면 앞(카메라 쪽).
//
// FreeMoCap 이 뱉는 좌표계는 "카메라 보정에서 나온 임의의 방향"이라 축이 우리와
// 안 맞는다. 이 프로젝트의 실제 녹화(session_2026-08-07)를 재보니 몸의 위 방향
// (hips_center → head_center)이 프레임 전체 평균으로 (0.155, -0.719, 0.678) 이었다.
// 즉 -Y 와 +Z 에 걸쳐 45도쯤 기울어져 있어서, 부호를 뒤집거나 축을 바꾸는 것만으로는
// 사람이 절대 똑바로 서지 않는다. 그래서 두 가지 모드를 둔다:
//
//   'auto'   — 데이터에서 해부학적 기준축(위/좌우/앞)을 뽑아 그대로 회전시킨다.
//              녹화가 어떤 각도로 캘리브레이션됐든 사람이 서서 정면을 본다. (기본값)
//   'manual' — 요청대로 축 부호/스왑을 손으로 돌려가며 맞추는 모드.
//              축이 이미 정렬된 데이터거나 auto 결과가 마음에 안 들 때 쓴다.

export const DEFAULT_TRANSFORM = {
  mode: 'auto',        // 'auto' | 'manual'
  scale: 2.0,          // AXIS_SCALE — 미터 단위를 화면 크기로
  // --- manual 모드 전용 ---
  signX: 1,            // FMC_X_SIGN
  signY: -1,           // FMC_Y_SIGN (y 가 음수일수록 위 → 뒤집어야 위가 위)
  signZ: 1,            // FMC_Z_SIGN
  up: 'y',             // 부호를 적용한 뒤 어느 축을 Three 의 +Y(위)로 볼지
  // --- 공통 ---
  mirror: false,       // 좌우 반전 (거울처럼 보고 싶을 때)
};

const EPS = 1e-9;

const sub = (a, b) => [a.x - b.x, a.y - b.y, a.z - b.z];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
function normalize(v) {
  const m = Math.hypot(v[0], v[1], v[2]);
  return m > EPS ? [v[0] / m, v[1] / m, v[2] / m] : null;
}
const finite = (p) => !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);

// 두 관절 사이 벡터를 전체 프레임에 대해 평균낸다.
// 프레임마다 계산하면 몸통이 도는 동작까지 지워버리므로 반드시 "한 번만" 구한다.
function meanVector(frames, fromName, toName) {
  let sx = 0, sy = 0, sz = 0, n = 0;
  for (const f of frames) {
    const a = f[fromName], b = f[toName];
    if (!finite(a) || !finite(b)) continue;
    const d = sub(b, a);
    sx += d[0]; sy += d[1]; sz += d[2];
    n++;
  }
  return n > 0 ? [sx / n, sy / n, sz / n] : null;
}

// 클립 전체에서 해부학적 기준축을 구한다.
//   up  = 골반 → 머리       (사람의 위쪽)
//   lat = 오른어깨 → 왼어깨 (사람의 왼쪽 = 마주 봤을 때 화면 오른쪽 = +X)
//   fwd = lat × up          (오른손 좌표계에서 X×Y=Z → 사람이 바라보는 쪽 = +Z)
// 마주 보고 서 있으면 코가 fwd 쪽으로 튀어나오므로, 그 부호로 앞뒤를 검산한다.
// 실패하면 null 을 돌려주고 호출부가 manual 로 폴백한다.
export function computeBodyBasis(frames) {
  const upRaw =
    meanVector(frames, 'hips_center', 'head_center') ||
    meanVector(frames, 'hips_center', 'neck_center') ||
    meanVector(frames, 'hips_center', 'nose');
  const latRaw = meanVector(frames, 'right_shoulder', 'left_shoulder');
  if (!upRaw || !latRaw) return null;

  const up = normalize(upRaw);
  if (!up) return null;
  // 어깨선에서 up 성분을 빼서 직교화 (어깨가 기울어 있어도 축이 안 틀어지게)
  const latOrtho = normalize([
    latRaw[0] - up[0] * dot(latRaw, up),
    latRaw[1] - up[1] * dot(latRaw, up),
    latRaw[2] - up[2] * dot(latRaw, up),
  ]);
  if (!latOrtho) return null;

  let lat = latOrtho;
  let fwd = cross(lat, up);

  // 검산: 코는 몸통 중심보다 얼굴 앞쪽에 있다. 반대로 나오면 등을 보이는 셈이니
  // 좌우와 앞뒤를 함께 뒤집는다(오른손 좌표계를 유지하려면 두 축을 같이 뒤집어야 한다).
  const noseOffset = meanVector(frames, 'trunk_center', 'nose');
  if (noseOffset && dot(noseOffset, fwd) < 0) {
    lat = [-lat[0], -lat[1], -lat[2]];
    fwd = cross(lat, up);
  }

  // VRM 자동 맞춤용 실측값. 아바타를 스켈레톤과 같은 크기·높이에 세워
  // 겹쳐 놓고 팔 방향을 대조할 수 있게 한다. (리타깃 자체와는 무관 — 리타깃은 방향만 쓴다)
  const shoulder = meanVector(frames, 'right_shoulder', 'left_shoulder');
  const hips = meanVector(frames, 'trunk_center', 'hips_center');

  return {
    lat, up, fwd,
    floorDrop: measureFloorDrop(frames, up),
    shoulderWidth: shoulder ? Math.hypot(shoulder[0], shoulder[1], shoulder[2]) : 0,
    // 몸통 중심(원점) 기준 골반 높이. 대개 음수(중심보다 아래).
    hipsOffset: hips ? dot(hips, up) : 0,
  };
}

// 몸통 중심에서 발까지의 거리(양수). 바닥 격자를 발밑에 놓는 데만 쓴다.
// 못 재면 0 → 격자가 몸통 중심 높이에 놓인다.
const FOOT_NAMES = ['left_foot_index', 'right_foot_index', 'left_heel', 'right_heel', 'left_ankle', 'right_ankle'];
function measureFloorDrop(frames, up) {
  let sum = 0, n = 0;
  for (const f of frames) {
    const c = frameCenter(f);
    if (!c) continue;
    let lowest = Infinity;
    for (const name of FOOT_NAMES) {
      const p = f[name];
      if (!finite(p)) continue;
      lowest = Math.min(lowest, dot([p.x - c[0], p.y - c[1], p.z - c[2]], up));
    }
    if (lowest === Infinity) continue;
    sum += lowest;
    n++;
  }
  return n > 0 ? Math.abs(sum / n) : 0;
}

// place3D 가 좌우를 뒤집는(반사) 변환인지. +1 = 그대로, -1 = 거울상.
//
// 리타깃에서 이게 왜 중요하냐면: 반사 변환을 거치면 사람의 왼손 좌표가 "오른손 형상"이
// 된다(손바닥 법선 f × l 이 유사벡터라 부호가 뒤집힌다). 그 손을 VRM 왼손에 붙이면
// 손등과 손바닥이 뒤집힌 채로 리타깃된다. 그래서 반사일 때는 좌우를 바꿔 붙여야 한다.
// 실시간 모드의 "mirror 면 사람 왼팔 → VRM 오른팔" 규칙과 정확히 같은 이야기다
// (거기서는 place() 가 x 만 뒤집으니 mirror == 반사).
//
//   자동 정렬: [lat, up, fwd] 는 fwd = lat × up 으로 만들어 항상 det = +1 (순수 회전)
//   수동:      축 스왑(up=x/z)은 전부 회전이라 det = +1 → 부호 셋의 곱만 남는다
//   mirror 는 어느 쪽이든 x 를 뒤집으므로 -1 을 한 번 더 곱한다
export function transformHandedness(transform, basis) {
  const base = (transform.mode === 'auto' && basis)
    ? 1
    : Math.sign(transform.signX * transform.signY * transform.signZ) || 1;
  return (transform.mirror ? -1 : 1) * base;
}

// 이번 프레임의 몸통 중심. trunk_center → hips_center → 어깨 중점 순으로 폴백.
// 못 구하면 null (호출부가 직전 중심을 유지한다).
export function frameCenter(frame) {
  for (const name of ['trunk_center', 'hips_center']) {
    const p = frame[name];
    if (finite(p)) return [p.x, p.y, p.z];
  }
  const ls = frame.left_shoulder, rs = frame.right_shoulder;
  if (finite(ls) && finite(rs)) {
    return [(ls.x + rs.x) / 2, (ls.y + rs.y) / 2, (ls.z + rs.z) / 2];
  }
  return null;
}

// place3D: FreeMoCap 점 하나를 Three.js 좌표로. out 은 THREE.Vector3.
// center 는 frameCenter() 가 준 [x,y,z] (이 프레임의 몸통 중심).
// 유효하지 않은 점이면 false 를 돌려주고 out 은 건드리지 않는다.
export function place3D(out, p, center, transform, basis) {
  if (!finite(p)) return false;
  const dx = p.x - center[0];
  const dy = p.y - center[1];
  const dz = p.z - center[2];
  const s = transform.scale;

  let x, y, z;
  if (transform.mode === 'auto' && basis) {
    // 매 프레임 수십 번 불리므로 배열을 만들지 않고 성분을 직접 곱한다
    const { lat, up, fwd } = basis;
    x = dx * lat[0] + dy * lat[1] + dz * lat[2];
    y = dx * up[0] + dy * up[1] + dz * up[2];
    z = dx * fwd[0] + dy * fwd[1] + dz * fwd[2];
  } else {
    // 부호 먼저, 그 다음 "어느 축이 위인가"에 따라 축을 돌린다.
    const ax = dx * transform.signX;
    const ay = dy * transform.signY;
    const az = dz * transform.signZ;
    switch (transform.up) {
      case 'z': // FMC 의 z 가 위 — X 축 기준 -90도
        x = ax; y = az; z = -ay;
        break;
      case 'x': // FMC 의 x 가 위 — Z 축 기준 +90도
        x = -ay; y = ax; z = az;
        break;
      default:  // 'y' — 그대로
        x = ax; y = ay; z = az;
        break;
    }
  }

  out.set((transform.mirror ? -x : x) * s, y * s, z * s);
  return true;
}
