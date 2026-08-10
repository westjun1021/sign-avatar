// FreeMoCap body 관절 이름 ↔ 뼈대 연결.
// 앞 33개는 표준 MediaPipe pose 와 같고, 뒤에 FreeMoCap 이 계산한 가상 관절
// (head_center / neck_center / trunk_center / hips_center / *_hand_middle) 6개가 붙는다.
// 가상 관절 덕분에 실시간 모드처럼 어깨 중점을 직접 만들 필요 없이 척추를 바로 그릴 수 있다.

// 몸통 중심 후보. 앞에서부터 유효한 걸 쓴다.
export const CENTER_CANDIDATES = ['trunk_center', 'hips_center'];

// 상반신 (뉴스 통역사 흉상 프레이밍과 같은 범위 + 척추/골반)
export const FMC_UPPER_CONNECTIONS = [
  ['head_center', 'nose'],
  ['neck_center', 'head_center'],
  ['trunk_center', 'neck_center'],
  ['hips_center', 'trunk_center'],
  ['left_shoulder', 'right_shoulder'],
  ['left_shoulder', 'left_elbow'],
  ['left_elbow', 'left_wrist'],
  ['right_shoulder', 'right_elbow'],
  ['right_elbow', 'right_wrist'],
  ['left_shoulder', 'left_hip'],
  ['right_shoulder', 'right_hip'],
  ['left_hip', 'right_hip'],
];

// 하반신. 축이 맞았는지("똑바로 서 있나")는 다리가 보여야 판단이 빠르다.
export const FMC_LOWER_CONNECTIONS = [
  ['left_hip', 'left_knee'],
  ['left_knee', 'left_ankle'],
  ['left_ankle', 'left_heel'],
  ['left_heel', 'left_foot_index'],
  ['left_ankle', 'left_foot_index'],
  ['right_hip', 'right_knee'],
  ['right_knee', 'right_ankle'],
  ['right_ankle', 'right_heel'],
  ['right_heel', 'right_foot_index'],
  ['right_ankle', 'right_foot_index'],
];

export const FMC_FULL_CONNECTIONS = [...FMC_UPPER_CONNECTIONS, ...FMC_LOWER_CONNECTIONS];

// 점으로 찍을 관절 (눈·귀·입처럼 촘촘한 얼굴 점은 스틱맨을 지저분하게 만들어 제외)
export const FMC_UPPER_JOINTS = [
  'nose', 'head_center', 'neck_center', 'trunk_center', 'hips_center',
  'left_shoulder', 'right_shoulder',
  'left_elbow', 'right_elbow',
  'left_wrist', 'right_wrist',
  'left_hip', 'right_hip',
];

export const FMC_LOWER_JOINTS = [
  'left_knee', 'right_knee',
  'left_ankle', 'right_ankle',
  'left_heel', 'right_heel',
  'left_foot_index', 'right_foot_index',
];

export const FMC_FULL_JOINTS = [...FMC_UPPER_JOINTS, ...FMC_LOWER_JOINTS];

// 손 21점 연결 — 실시간 모드의 HAND_CONNECTIONS 와 같은 표준 배열이다.
// (mediapipe/landmarks.js 를 import 하지 않고 따로 두는 이유: 재생 모드가
//  실시간 파이프라인에 의존하지 않게 해서 서로 영향을 안 주게 한다)
export const FMC_HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];
