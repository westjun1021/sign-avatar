import { useEffect, useRef, useState } from 'react';
import { useHolistic } from './mediapipe/useHolistic.js';
import { useRecorder } from './recording/useRecorder.js';
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

  const fileInputRef = useRef(null);
  const { status, sourceType, error, start, startFromFile, stop } = useHolistic(videoRef, landmarksRef);

  const startWebcam = () => {
    // 웹캠은 거울처럼 보는 게 자연스럽다
    setOptions((o) => ({ ...o, mirror: true }));
    start();
  };

  const pickFile = () => fileInputRef.current?.click();

  const onFileChosen = (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // 같은 파일을 다시 고를 수 있게 비운다
    if (!file) return;
    // 통역사 영상은 이미 정방향이라 거울 반전이 필요 없다
    setOptions((o) => ({ ...o, mirror: false }));
    startFromFile(file);
  };

  const recorder = useRecorder();
  const { isRecording, elapsed, supported: canRecord, error: recError } = recorder;

  const toggleRecord = () => {
    if (isRecording) {
      recorder.stop();
      return;
    }
    // 아바타만 그려지는 메인 캔버스. 스켈레톤·웹캠은 다른 캔버스라 안 들어간다.
    const canvas = avatarRef.current?.getMainCanvas();
    if (canvas) recorder.start(canvas);
  };

  // 카메라가 멈추면 캔버스가 더 이상 갱신되지 않으므로 녹화도 같이 정지
  useEffect(() => {
    if (status !== 'running' && isRecording) recorder.stop();
  }, [status, isRecording, recorder]);

  const elapsedText = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;

  const statusText = {
    idle: '대기 중',
    loading: '모델 불러오는 중…',
    running: '추적 중',
    error: '오류',
  }[status];

  return (
    <div className="app">
      {/* 소스 선택용 숨은 파일 입력 */}
      <input
        ref={fileInputRef}
        type="file"
        accept="video/*"
        style={{ display: 'none' }}
        onChange={onFileChosen}
      />
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
            <div className="stage-tools">
              <button
                className="tool-btn"
                onClick={() => avatarRef.current?.resetView()}
                title="드래그로 돌린 시점을 초기 정면 뷰로 되돌립니다"
              >
                정면으로
              </button>
              <button
                className={`tool-btn record${isRecording ? ' on' : ''}`}
                onClick={toggleRecord}
                disabled={!canRecord}
                title={
                  canRecord
                    ? '아바타 화면만 녹화해서 파일로 저장합니다 (스켈레톤·웹캠 제외)'
                    : '이 브라우저는 MediaRecorder 를 지원하지 않습니다'
                }
              >
                {isRecording ? `■ 정지 ${elapsedText}` : '● 녹화'}
              </button>
            </div>
          )}
          {recError && <div className="record-error">녹화 오류: {recError}</div>}
          {status !== 'running' && (
            <div className="overlay">
              {status === 'error' ? (
                <div className="overlay-card error">
                  <p>입력 영상을 시작할 수 없어요.</p>
                  <small>{error}</small>
                  <div className="source-buttons">
                    <button onClick={startWebcam}>웹캠으로 다시 시도</button>
                    <button className="secondary" onClick={pickFile}>영상 파일 열기</button>
                  </div>
                </div>
              ) : (
                <div className="overlay-card">
                  <p>상반신·손·얼굴을 추적해<br />3D 아바타가 그대로 따라 합니다.</p>
                  <div className="source-buttons">
                    <button onClick={startWebcam} disabled={status === 'loading'}>
                      {status === 'loading' ? '불러오는 중…' : '웹캠으로 시작'}
                    </button>
                    <button className="secondary" onClick={pickFile} disabled={status === 'loading'}>
                      영상 파일 열기
                    </button>
                  </div>
                  <small>드래그하면 아바타를 3D로 돌려볼 수 있어요.</small>
                </div>
              )}
            </div>
          )}
        </section>

        <aside className="side">
          <CameraPanel ref={videoRef} mirror={options.mirror} sourceType={sourceType} />
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
