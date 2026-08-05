// MediaPipe 랜드마크 인덱스와 뼈대(연결) 정의
// 스틱맨은 "위치를 그대로 선으로 잇는" 방식이라, 여기 정의된 연결만 있으면 됩니다.
// (뼈 회전 변환은 나중에 VRM 단계에서만 필요합니다.)

// --- 전신 포즈(BlazePose 33점) 중 상반신만 사용 ---
export const POSE = {
  NOSE: 0,
  // 귀: 머리 방향(yaw/pitch/roll) 추정용. 스켈레톤에는 그리지 않는다.
  LEFT_EAR: 7,   // 사람 기준 왼쪽 귀 = 카메라 원본 영상에서는 오른쪽에 보임
  RIGHT_EAR: 8,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
};

// 뉴스 수어 통역사 "흉상" 프레이밍: 골반 아래는 물론
// 어깨->골반, 골반->골반(사다리꼴 몸통)도 그리지 않습니다.
// 몸통은 SkeletonAvatar 쪽에서 "어깨 선 + 어깨 중점에서 내려오는 짧은 척추"로 표현합니다.
// (골반 인덱스는 몸통 중심 계산용 폴백으로만 남겨둡니다.)
export const POSE_UPPER_CONNECTIONS = [
  [POSE.LEFT_SHOULDER, POSE.RIGHT_SHOULDER],
  [POSE.LEFT_SHOULDER, POSE.LEFT_ELBOW],
  [POSE.LEFT_ELBOW, POSE.LEFT_WRIST],
  [POSE.RIGHT_SHOULDER, POSE.RIGHT_ELBOW],
  [POSE.RIGHT_ELBOW, POSE.RIGHT_WRIST],
];

// 관절 점으로 찍을 상반신 인덱스 (골반 제외)
export const POSE_UPPER_JOINTS = [
  POSE.NOSE,
  POSE.LEFT_SHOULDER,
  POSE.RIGHT_SHOULDER,
  POSE.LEFT_ELBOW,
  POSE.RIGHT_ELBOW,
  POSE.LEFT_WRIST,
  POSE.RIGHT_WRIST,
];

// --- 손(21점) 표준 연결 ---
export const HAND_CONNECTIONS = [
  // 엄지
  [0, 1], [1, 2], [2, 3], [3, 4],
  // 검지
  [0, 5], [5, 6], [6, 7], [7, 8],
  // 중지
  [5, 9], [9, 10], [10, 11], [11, 12],
  // 약지
  [9, 13], [13, 14], [14, 15], [15, 16],
  // 새끼
  [13, 17], [17, 18], [18, 19], [19, 20],
  // 손바닥 아래쪽
  [0, 17],
];
