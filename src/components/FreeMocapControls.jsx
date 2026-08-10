import { PLAY_FPS } from '../freemocap/useFreeMocap.js';

// FreeMoCap 재생 모드의 사이드 패널: 파일 / 재생 / 보기 / 좌표축 튜닝.
export default function FreeMocapControls({
  clip, status, error, fileNames,
  frame, seek,
  playing, togglePlay,
  transform, setTransform,
  view, setView,
  basis,
  onPickFiles, onPickFolder,
  recorder,
}) {
  const total = clip?.frameCount || 0;
  const last = Math.max(0, total - 1);
  // 자동 녹화 중에는 재생 위치를 못 건드리게 잠근다 (중간에 튀면 영상이 망가진다)
  const locked = recorder.auto;
  const set = (patch) => setTransform((t) => ({ ...t, ...patch }));
  const toggleView = (key) => setView((v) => ({ ...v, [key]: !v[key] }));
  const flip = (key) => set({ [key]: transform[key] > 0 ? -1 : 1 });

  const seconds = total ? (total / PLAY_FPS).toFixed(1) : '0';

  return (
    <div className="fmc-panel">
      <div className="fmc-section">
        <div className="fmc-title">데이터</div>
        <div className="source-buttons">
          <button onClick={onPickFiles} disabled={status === 'loading' || locked}>CSV 3개 선택</button>
          <button className="secondary" onClick={onPickFolder} disabled={status === 'loading' || locked}>
            폴더 선택
          </button>
        </div>
        {status === 'loading' && <p className="fmc-note">불러오는 중…</p>}
        {status === 'error' && <p className="fmc-note error">{error}</p>}
        {status === 'ready' && (
          <ul className="fmc-files">
            <li>{fileNames?.body}</li>
            <li className={fileNames?.rightHand ? '' : 'missing'}>
              {fileNames?.rightHand || '오른손 CSV 없음'}
            </li>
            <li className={fileNames?.leftHand ? '' : 'missing'}>
              {fileNames?.leftHand || '왼손 CSV 없음'}
            </li>
            <li className="meta">{total} 프레임 · {PLAY_FPS}fps · {seconds}초</li>
          </ul>
        )}
      </div>

      <div className="fmc-section">
        <div className="fmc-title">재생</div>
        <div className="fmc-transport">
          <button className="secondary step" onClick={() => seek(frame - 1)} disabled={!total || locked} title="이전 프레임">◀</button>
          <button onClick={togglePlay} disabled={!total || locked}>{playing ? '❙❙ 일시정지' : '▶ 재생'}</button>
          <button className="secondary step" onClick={() => seek(frame + 1)} disabled={!total || locked} title="다음 프레임">▶</button>
        </div>
        <input
          className="fmc-slider"
          type="range"
          min={0}
          max={last}
          step={1}
          value={Math.min(frame, last)}
          onChange={(e) => seek(Number(e.target.value))}
          disabled={!total || locked}
        />
        <div className="fmc-frame">frame {total ? frame : 0} / {last}</div>
      </div>

      <div className="fmc-section">
        <div className="fmc-title">녹화</div>
        <div className="fmc-transport">
          <button
            className={recorder.isRecording && !recorder.auto ? '' : 'secondary'}
            onClick={recorder.toggle}
            disabled={!total || !recorder.supported || recorder.auto}
            title={recorder.supported
              ? '지금 보이는 화면을 파일로 녹화합니다'
              : '이 브라우저는 MediaRecorder 를 지원하지 않습니다'}
          >
            {recorder.isRecording && !recorder.auto ? '■ 정지' : '● 녹화'}
          </button>
          <button
            onClick={recorder.auto ? recorder.cancel : recorder.startAuto}
            disabled={!total || !recorder.supported || (recorder.isRecording && !recorder.auto)}
            title={`0 번 프레임부터 ${last} 번까지 재생하며 통째로 녹화하고 자동으로 멈춥니다`}
          >
            {recorder.auto ? '■ 자동 녹화 취소' : '⏺ 전체 자동 녹화'}
          </button>
        </div>
        <label className={`toggle ${recorder.cleanView ? 'on' : ''}`}>
          <input
            type="checkbox"
            checked={recorder.cleanView}
            onChange={() => recorder.setCleanView((v) => !v)}
            disabled={recorder.isRecording || recorder.auto}
          />
          <span>클린 뷰 (아바타만)</span>
        </label>
        {recorder.error ? (
          <p className="fmc-note error">녹화 오류: {recorder.error}</p>
        ) : (
          <p className="fmc-note">
            {recorder.auto
              ? `녹화 중 · frame ${frame} / ${last}`
              : recorder.isRecording
                ? '녹화 중 · 정지를 누르면 파일로 저장됩니다'
                : `클린 뷰로 녹화하면 스켈레톤·바닥선을 빼고 아바타만 담깁니다. 저장 fps 는 재생과 같은 ${PLAY_FPS}fps 입니다.`}
          </p>
        )}
      </div>

      <div className="fmc-section">
        <div className="fmc-title">보기</div>
        <div className="controls">
          <label className={`toggle ${view.showAvatar ? 'on' : ''}`}>
            <input type="checkbox" checked={view.showAvatar} onChange={() => toggleView('showAvatar')} />
            <span>아바타</span>
          </label>
          <label className={`toggle ${view.showSkeleton ? 'on' : ''}`}>
            <input type="checkbox" checked={view.showSkeleton} onChange={() => toggleView('showSkeleton')} />
            <span>스켈레톤</span>
          </label>
          <label className={`toggle ${view.showHands ? 'on' : ''}`}>
            <input type="checkbox" checked={view.showHands} onChange={() => toggleView('showHands')} />
            <span>양손</span>
          </label>
          <label className={`toggle ${view.showLower ? 'on' : ''}`}>
            <input type="checkbox" checked={view.showLower} onChange={() => toggleView('showLower')} />
            <span>하반신</span>
          </label>
          <label className={`toggle ${view.showGrid ? 'on' : ''}`}>
            <input type="checkbox" checked={view.showGrid} onChange={() => toggleView('showGrid')} />
            <span>바닥·축</span>
          </label>
          <label className={`toggle ${transform.mirror ? 'on' : ''}`}>
            <input type="checkbox" checked={transform.mirror} onChange={() => set({ mirror: !transform.mirror })} />
            <span>좌우 반전</span>
          </label>
        </div>
      </div>

      <div className="fmc-section">
        <div className="fmc-title">좌표축</div>
        <div className="fmc-seg">
          <button
            className={transform.mode === 'auto' ? 'on' : ''}
            onClick={() => set({ mode: 'auto' })}
            disabled={!basis}
            title={basis ? '데이터에서 몸의 위/좌우/앞 방향을 뽑아 자동으로 세웁니다' : '기준 관절이 없어 자동 정렬을 쓸 수 없습니다'}
          >
            자동 정렬
          </button>
          <button
            className={transform.mode === 'manual' ? 'on' : ''}
            onClick={() => set({ mode: 'manual' })}
          >
            수동
          </button>
        </div>

        {transform.mode === 'manual' && (
          <>
            <div className="fmc-row">
              <span className="fmc-label">축 부호</span>
              <div className="fmc-seg tight">
                {['signX', 'signY', 'signZ'].map((key) => (
                  <button key={key} className="on" onClick={() => flip(key)}>
                    {transform[key] > 0 ? '+' : '−'}{key.slice(-1)}
                  </button>
                ))}
              </div>
            </div>
            <div className="fmc-row">
              <span className="fmc-label">위 축</span>
              <div className="fmc-seg tight">
                {['x', 'y', 'z'].map((axis) => (
                  <button
                    key={axis}
                    className={transform.up === axis ? 'on' : ''}
                    onClick={() => set({ up: axis })}
                  >
                    {axis.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        <div className="fmc-row">
          <span className="fmc-label">크기 {transform.scale.toFixed(1)}</span>
          <input
            className="fmc-slider"
            type="range"
            min={0.5}
            max={6}
            step={0.1}
            value={transform.scale}
            onChange={(e) => set({ scale: Number(e.target.value) })}
          />
        </div>

        <p className="fmc-note">
          {transform.mode === 'auto' ? (
            <>
              골반→머리를 위, 오른어깨→왼어깨를 오른쪽으로 삼아 회전시킵니다.
              FreeMoCap 좌표계는 캘리브레이션에 따라 기울어 있어 축 부호만으로는
              안 세워지는 경우가 많습니다.
              {basis && (
                <>
                  <br />
                  원본 위 방향: ({basis.up.map((v) => v.toFixed(2)).join(', ')})
                </>
              )}
            </>
          ) : (
            '스켈레톤이 눕거나 뒤집혀 보이면 축 부호와 위 축을 바꿔가며 사람이 똑바로 서서 정면을 보게 맞추세요.'
          )}
        </p>
      </div>
    </div>
  );
}
