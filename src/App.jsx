import { useEffect, useRef, useState } from 'react';
import { useHolistic } from './mediapipe/useHolistic.js';
import { useRecorder } from './recording/useRecorder.js';
import { useFreeMocap } from './freemocap/useFreeMocap.js';
import AvatarStage from './components/AvatarStage.jsx';
import CameraPanel from './components/CameraPanel.jsx';
import SkeletonPanel from './components/SkeletonPanel.jsx';
import Controls from './components/Controls.jsx';
import FreeMocapStage from './components/FreeMocapStage.jsx';
import FreeMocapControls from './components/FreeMocapControls.jsx';

export default function App() {
  // 'live' = 웹캠/영상 실시간 추적 + VRM (기존)
  // 'fmc'  = FreeMoCap 3D CSV 재생 (F-2, 스틱맨만)
  // 무대는 한 번에 하나만 마운트한다 — WebGL 컨텍스트와 rAF 루프를 둘 다 띄우지 않기 위해.
  const [mode, setMode] = useState('live');

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

  // --- F-2: FreeMoCap 재생 모드 ---
  const fmc = useFreeMocap();
  const fmcPlayerRef = useRef(null);
  const csvInputRef = useRef(null);
  const csvFolderInputRef = useRef(null);

  const onCsvChosen = (e) => {
    const files = e.target.files;
    // 같은 파일을 다시 고를 수 있게 비운다 (files 는 위에서 이미 참조를 잡았다)
    const list = files ? Array.from(files) : [];
    e.target.value = '';
    if (list.length) fmc.load(list);
  };

  // 재생 모드로 갈 때 실시간 추적을 멈춘다.
  // MediaPipe 추론은 메인 스레드의 별도 rAF 루프라, 켜둔 채로 두면 재생이 끊긴다.
  const switchMode = (next) => {
    if (next === mode) return;
    if (next === 'fmc') {
      if (isRecording) recorder.stop();
      if (status === 'running' || status === 'loading') stop();
    } else {
      fmc.setPlaying(false);
    }
    setMode(next);
  };

  const statusText = mode === 'fmc'
    ? {
        idle: 'CSV 대기 중',
        loading: 'CSV 읽는 중…',
        ready: `${fmc.clip?.frameCount || 0} 프레임 재생 준비`,
        error: '오류',
      }[fmc.status]
    : {
        idle: '대기 중',
        loading: '모델 불러오는 중…',
        running: '추적 중',
        error: '오류',
      }[status];

  const dotStatus = mode === 'fmc'
    ? { idle: 'idle', loading: 'loading', ready: 'running', error: 'error' }[fmc.status]
    : status;

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
      {/* FreeMoCap CSV: 파일 여러 개 선택 / 폴더 통째로 선택 */}
      <input
        ref={csvInputRef}
        type="file"
        accept=".csv"
        multiple
        style={{ display: 'none' }}
        onChange={onCsvChosen}
      />
      <input
        ref={csvFolderInputRef}
        type="file"
        webkitdirectory=""
        directory=""
        style={{ display: 'none' }}
        onChange={onCsvChosen}
      />
      <header className="topbar">
        <div className="brand">
          <span className="dot" data-status={dotStatus} />
          <h1>Sign Avatar</h1>
          <span className="sub">사람 동작을 3D 스켈레톤이 따라 합니다</span>
        </div>
        <div className="topbar-right">
          <div className="mode-switch">
            <button className={mode === 'live' ? 'on' : ''} onClick={() => switchMode('live')}>
              실시간
            </button>
            <button className={mode === 'fmc' ? 'on' : ''} onClick={() => switchMode('fmc')}>
              FreeMoCap 재생
            </button>
          </div>
          <div className="status">{statusText}</div>
        </div>
      </header>

      {mode === 'fmc' ? (
        <main className="layout">
          <section className="stage-wrap">
            <FreeMocapStage
              clipRef={fmc.clipRef}
              stateRef={fmc.stateRef}
              playerRef={fmcPlayerRef}
            />
            <div className="stage-tools">
              <button
                className="tool-btn"
                onClick={() => fmcPlayerRef.current?.resetView()}
                title="드래그로 돌린 시점을 초기 정면 뷰로 되돌립니다"
              >
                정면으로
              </button>
            </div>
            {fmc.status !== 'ready' && (
              <div className="overlay">
                <div className={`overlay-card${fmc.status === 'error' ? ' error' : ''}`}>
                  <p>
                    FreeMoCap 이 뽑은 3D CSV 를 불러와<br />스켈레톤으로 재생합니다.
                  </p>
                  <div className="source-buttons">
                    <button onClick={() => csvInputRef.current?.click()} disabled={fmc.status === 'loading'}>
                      CSV 3개 선택
                    </button>
                    <button
                      className="secondary"
                      onClick={() => csvFolderInputRef.current?.click()}
                      disabled={fmc.status === 'loading'}
                    >
                      폴더 선택
                    </button>
                  </div>
                  {fmc.status === 'error' ? (
                    <small>{fmc.error}</small>
                  ) : (
                    <small>
                      saved_data/csv 의 body / right_hand / left_hand
                      _trajectories.csv 를 고르거나, 녹화 폴더를 통째로 고르세요.
                    </small>
                  )}
                </div>
              </div>
            )}
          </section>

          <aside className="side">
            <FreeMocapControls
              clip={fmc.clip}
              status={fmc.status}
              error={fmc.error}
              fileNames={fmc.fileNames}
              frame={fmc.frame}
              seek={fmc.seek}
              playing={fmc.playing}
              togglePlay={fmc.togglePlay}
              transform={fmc.transform}
              setTransform={fmc.setTransform}
              view={fmc.view}
              setView={fmc.setView}
              basis={fmc.basis}
              onPickFiles={() => csvInputRef.current?.click()}
              onPickFolder={() => csvFolderInputRef.current?.click()}
            />
            <p className="hint">
              VRM 아바타는 아직 안 붙였습니다 — 좌표계가 맞는지 스틱맨으로 먼저
              확인하는 단계입니다. 드래그로 돌려보며 사람이 똑바로 서서
              정면을 보는지 확인하세요.
            </p>
          </aside>
        </main>
      ) : (
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
      )}
    </div>
  );
}
