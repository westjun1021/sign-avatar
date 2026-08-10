// FreeMoCap 의 saved_data/csv/*_trajectories.csv 파서.
//
// 헤더 규약 (실제 파일에서 확인):
//   "# nose_x, nose_y, nose_z,left_eye_inner_x, ... , left_hand_middle_z,"
//   - 맨 앞에 '# ' 가 붙는다
//   - 필드마다 앞 공백이 섞여 있다 (" nose_y")
//   - 줄 끝에 쉼표가 하나 더 있어서 "빈 필드"가 하나 생긴다
//     → body 는 118열(= 39관절 * 3 + 1), 손은 64열(= 21 * 3 + 1)
//   손 파일의 이름에는 left_hand_ / right_hand_ 접두사가 붙는다.
//
// 값은 정규화되지 않은 실제 3D 좌표(미터 단위로 보인다). 추적 실패 구간은
// 빈 칸이나 nan 으로 나올 수 있으므로 NaN 으로 만들어 두고 렌더 단계에서 건너뛴다.

// 손 21점 표준 순서 (MediaPipe). 접두사를 뗀 이름으로 검증한다.
export const HAND_LANDMARK_NAMES = [
  'wrist',
  'thumb_cmc', 'thumb_mcp', 'thumb_ip', 'thumb_tip',
  'index_finger_mcp', 'index_finger_pip', 'index_finger_dip', 'index_finger_tip',
  'middle_finger_mcp', 'middle_finger_pip', 'middle_finger_dip', 'middle_finger_tip',
  'ring_finger_mcp', 'ring_finger_pip', 'ring_finger_dip', 'ring_finger_tip',
  'pinky_mcp', 'pinky_pip', 'pinky_dip', 'pinky_tip',
];

// 빈 칸/nan 을 0 이 아니라 NaN 으로 만든다.
// Number('') === 0 이라 그냥 Number() 를 쓰면 추적 실패 구간이 원점으로 튄다.
function toNumber(cell) {
  const s = cell.trim();
  if (s === '') return NaN;
  return Number(s);
}

// "# a_x, a_y, a_z,b_x, ...," → ['a', 'b', ...]
function parseHeader(line) {
  const cells = line
    .replace(/^﻿/, '')   // 엑셀에서 다시 저장하면 BOM 이 붙는다
    .replace(/^\s*#\s*/, '')  // 맨 앞 '#'
    .split(',')
    .map((s) => s.trim());
  // 줄 끝 쉼표 때문에 생긴 빈 필드 제거
  while (cells.length && cells[cells.length - 1] === '') cells.pop();

  if (cells.length % 3 !== 0) {
    throw new Error(`열 개수(${cells.length})가 3의 배수가 아닙니다 — x,y,z 쌍이 맞지 않습니다.`);
  }

  const names = [];
  for (let i = 0; i < cells.length; i += 3) {
    const [cx, cy, cz] = [cells[i], cells[i + 1], cells[i + 2]];
    const base = cx.slice(0, -2);
    if (!cx.endsWith('_x') || cy !== `${base}_y` || cz !== `${base}_z`) {
      throw new Error(`헤더 ${i + 1}~${i + 3}번째 열이 x,y,z 순서가 아닙니다: "${cx}, ${cy}, ${cz}"`);
    }
    names.push(base);
  }
  return names;
}

// CSV 텍스트 → { names, rows }
// rows[f] 는 길이 names.length*3 의 Float64Array (x,y,z 가 이어서 들어있다).
export function parseTrajectoryCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) throw new Error('헤더 말고 데이터 행이 없습니다.');

  const names = parseHeader(lines[0]);
  const width = names.length * 3;

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(',');
    // 데이터 행도 헤더처럼 줄 끝 쉼표가 있을 수 있다. 앞에서부터 width 개만 쓴다.
    if (cells.length < width) {
      throw new Error(`${i + 1}번째 행의 열이 부족합니다 (${cells.length} < ${width}).`);
    }
    const row = new Float64Array(width);
    for (let c = 0; c < width; c++) row[c] = toNumber(cells[c]);
    rows.push(row);
  }
  return { names, rows };
}

// body CSV → 프레임별 { 관절이름: {x,y,z} }
export function toBodyFrames(parsed) {
  const { names, rows } = parsed;
  return rows.map((row) => {
    const frame = {};
    for (let j = 0; j < names.length; j++) {
      const o = j * 3;
      frame[names[j]] = { x: row[o], y: row[o + 1], z: row[o + 2] };
    }
    return frame;
  });
}

// hand CSV → 프레임별 [{x,y,z} * 21]. 순서는 표준 MediaPipe 손이라 인덱스로 쓴다.
// prefix 는 'left_hand_' / 'right_hand_'.
export function toHandFrames(parsed, prefix) {
  const { names, rows } = parsed;
  if (names.length !== 21) {
    throw new Error(`손 랜드마크가 21개가 아닙니다 (${names.length}개).`);
  }
  // 접두사를 떼고 표준 순서와 같은지 확인. 다르면 인덱스 기반 매핑이 틀어진다.
  const stripped = names.map((n) => (n.startsWith(prefix) ? n.slice(prefix.length) : n));
  const mismatch = stripped.findIndex((n, i) => n !== HAND_LANDMARK_NAMES[i]);
  if (mismatch >= 0) {
    console.warn(
      `[freemocap] 손 랜드마크 순서가 표준과 다릅니다: ${mismatch}번째가 ` +
      `"${stripped[mismatch]}" (기대: "${HAND_LANDMARK_NAMES[mismatch]}") — 순서대로 진행합니다.`
    );
  }
  return rows.map((row) => {
    const hand = new Array(21);
    for (let j = 0; j < 21; j++) {
      const o = j * 3;
      hand[j] = { x: row[o], y: row[o + 1], z: row[o + 2] };
    }
    return hand;
  });
}

// 세 파일을 합쳐 재생용 클립으로. 프레임 수가 다르면 짧은 쪽에 맞춘다.
//   frames[i] = { nose:{x,y,z}, ..., rightHand:[21], leftHand:[21] }
export function buildClip({ bodyText, rightHandText, leftHandText }) {
  const body = parseTrajectoryCsv(bodyText);
  const bodyFrames = toBodyFrames(body);

  let rightHandFrames = null;
  let leftHandFrames = null;
  if (rightHandText) rightHandFrames = toHandFrames(parseTrajectoryCsv(rightHandText), 'right_hand_');
  if (leftHandText) leftHandFrames = toHandFrames(parseTrajectoryCsv(leftHandText), 'left_hand_');

  const counts = [bodyFrames.length];
  if (rightHandFrames) counts.push(rightHandFrames.length);
  if (leftHandFrames) counts.push(leftHandFrames.length);
  const frameCount = Math.min(...counts);
  if (new Set(counts).size > 1) {
    console.warn(`[freemocap] 파일별 프레임 수가 다릅니다 (${counts.join(' / ')}) — ${frameCount} 프레임으로 자릅니다.`);
  }

  const frames = new Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    frames[i] = bodyFrames[i];
    frames[i].rightHand = rightHandFrames ? rightHandFrames[i] : null;
    frames[i].leftHand = leftHandFrames ? leftHandFrames[i] : null;
  }

  return {
    frameCount,
    frames,
    jointNames: body.names,
    hasHands: { right: !!rightHandFrames, left: !!leftHandFrames },
  };
}
