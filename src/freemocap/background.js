// 수어 영상 배경색 (F-6).
//
// 수어 영상 제작 표준은 "단색 배경"을 요구한다. 검정이 기본이고, 초록·파랑은
// 크로마키 합성용 표준색이다 (방송용 chroma green / chroma blue).
//
// grid: [중심선, 격자선] — 배경이 밝으면 어두운 선, 어두우면 밝은 선을 써야
// 바닥 격자가 배경에 묻히거나 반대로 눈을 찌르지 않는다. GridHelper 는 색을
// 정점 색으로 굽기 때문에 나중에 머티리얼만 바꿀 수 없다 → 배경이 바뀌면
// FreeMocapPlayer._applyBackground 가 헬퍼를 통째로 다시 만든다.
export const BACKGROUNDS = {
  black: { label: '검정',        css: '#000000', color: 0x000000, grid: [0x3a4557, 0x232c3a] },
  white: { label: '흰색',        css: '#ffffff', color: 0xffffff, grid: [0x8c98aa, 0xbfc7d4] },
  green: { label: '크로마 그린', css: '#00b140', color: 0x00b140, grid: [0x00702a, 0x008c35] },
  blue:  { label: '크로마 블루', css: '#0047bb', color: 0x0047bb, grid: [0x002b73, 0x00379a] },
};

// UI 스와치 순서
export const BACKGROUND_KEYS = ['black', 'white', 'green', 'blue'];

export const DEFAULT_BACKGROUND = 'black';
