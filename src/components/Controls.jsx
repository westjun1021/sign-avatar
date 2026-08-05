// 추적 부위 토글. 값은 optionsRef 에 직접 쓰고, 체크 표시용으로만 state 를 씁니다.
export default function Controls({ options, setOptions }) {
  const toggle = (key) => setOptions((o) => ({ ...o, [key]: !o[key] }));

  const items = [
    ['showPose', '상반신'],
    ['showHands', '양손'],
    ['showFace', '얼굴'],
    ['mirror', '거울 모드'],
  ];

  return (
    <div className="controls">
      {items.map(([key, label]) => (
        <label key={key} className={`toggle ${options[key] ? 'on' : ''}`}>
          <input
            type="checkbox"
            checked={!!options[key]}
            onChange={() => toggle(key)}
          />
          <span>{label}</span>
        </label>
      ))}
    </div>
  );
}
