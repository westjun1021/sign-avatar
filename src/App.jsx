import { useEffect, useRef, useState } from 'react';
import { useHolistic } from './mediapipe/useHolistic.js';
import AvatarStage from './components/AvatarStage.jsx';
import CameraPanel from './components/CameraPanel.jsx';
import SkeletonPanel from './components/SkeletonPanel.jsx';
import Controls from './components/Controls.jsx';

export default function App() {
  const videoRef = useRef(null);
  // 랜드마크는 ref 로 흘림 (초당 30fps 리렌더 방지)
  const landmarksRef = useRef({ pose: null, leftHand: null, rightHand: null, face: null });
  // SkeletonAvatar 인스턴스 (AvatarStage 가 채워줌) — 카메라 리셋 등 명령용
  const avatarRef = useRef(null);
  // 사이드에 있는 스켈레톤 디버그 창의 DOM. 두 번째 렌더러가 여기에 붙는다.
  const debugContainerRef = useRef(null);

  const [options, setOptions] = useState({
    showPose: true,
    showHands: true,
    showFace: true,
    mirror: true,
  });
  const optionsRef = useRef(options);
  useEffect(() => { optionsRef.current = options; }, [options]);

  const { status, error, start, stop } = useHolistic(videoRef, landmarksRef);

  const statusText = {
    idle: '대기 중',
    loading: '모델 불러오는 중…',
    running: '추적 중',
    error: '오류',
  }[status];

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="dot" data-status={status} />
          <h1>Sign Avatar</h1>
          <span className="sub">사람 동작을 3D 스켈레톤이 따라 합니다</span>
        </div>
        <div className="status">{statusText}</div>
      </header>

      <main className="layout">
        <section className="stage-wrap">
          <AvatarStage
            landmarksRef={landmarksRef}
            optionsRef={optionsRef}
            avatarRef={avatarRef}
            debugContainerRef={debugContainerRef}
          />
          {status === 'running' && (
            <button
              className="reset-view"
              onClick={() => avatarRef.current?.resetView()}
              title="드래그로 돌린 시점을 초기 정면 뷰로 되돌립니다"
            >
              정면으로
            </button>
          )}
          {status !== 'running' && (
            <div className="overlay">
              {status === 'error' ? (
                <div className="overlay-card error">
                  <p>카메라를 시작할 수 없어요.</p>
                  <small>{error}</small>
                  <button onClick={start}>다시 시도</button>
                </div>
              ) : (
                <div className="overlay-card">
                  <p>웹캠으로 상반신·손·얼굴을 추적해<br />3D 아바타가 실시간으로 따라 합니다.</p>
                  <button onClick={start} disabled={status === 'loading'}>
                    {status === 'loading' ? '불러오는 중…' : '카메라 시작'}
                  </button>
                  <small>드래그하면 아바타를 3D로 돌려볼 수 있어요.</small>
                </div>
              )}
            </div>
          )}
        </section>

        <aside className="side">
          <CameraPanel ref={videoRef} mirror={options.mirror} />
          <SkeletonPanel ref={debugContainerRef} />
          <Controls options={options} setOptions={setOptions} />
          {status === 'running' && (
            <button className="stop" onClick={stop}>중지</button>
          )}
          <p className="hint">
            손을 폈을 때(정면·평면 동작)는 잘 따라오고, 주먹을 쥐거나
            손을 앞뒤로 움직이면 정확도가 떨어져요 — 단일 웹캠의 z축·폐색 한계입니다.
          </p>
        </aside>
      </main>
    </div>
  );
}
