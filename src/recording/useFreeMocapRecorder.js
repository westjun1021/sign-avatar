import { useEffect, useRef, useState } from 'react';
import { useRecorder } from './useRecorder.js';
import { PLAY_FPS } from '../freemocap/useFreeMocap.js';

// F-4: FreeMoCap 재생 화면을 파일로 녹화한다.
// 캔버스 녹화 자체는 실시간 모드와 똑같은 useRecorder 를 그대로 쓰고(캔버스만 다르다),
// 여기서는 "재생과 녹화의 시작·끝을 맞추는 일"만 한다.

const FILE_NAME = 'sign-avatar-freemocap';

// 마지막 프레임이 스트림에 실릴 때까지 두는 여유. 15fps 면 한 프레임이 67ms 라
// 그보다 넉넉히 잡는다. 이 시간만큼 영상이 길어지지만 마지막 동작이 잘리는 것보다 낫다.
const TAIL_MS = 400;

export function useFreeMocapRecorder(fmc, playerRef) {
  const recorder = useRecorder();
  const [auto, setAuto] = useState(false);      // 전체 자동 녹화 진행 중
  const [cleanView, setCleanView] = useState(true); // 스켈레톤·격자를 빼고 아바타만 담기

  const rafRef = useRef(0);
  const tailRef = useRef(null);

  // 이벤트 핸들러가 항상 최신 값을 보게 한다 (fmc 는 매 렌더 새 객체다)
  const fmcRef = useRef(fmc);
  fmcRef.current = fmc;
  const cleanRef = useRef(cleanView);
  cleanRef.current = cleanView;

  const clearTimers = () => {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
    if (tailRef.current) { clearTimeout(tailRef.current); tailRef.current = null; }
  };

  // 두 프레임 뒤에 실행. 녹화용으로 바꾼 화면(클린 뷰·단색 배경·프레임 0)이
  // 실제로 한 번 그려진 뒤에 녹화를 열기 위해서다 — 바로 열면 직전 화면이
  // 첫 프레임으로 들어간다.
  const afterRepaint = (fn) => {
    clearTimers(); // 앞서 예약해둔 게 있으면 버린다 (연타 대비)
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        fn();
      });
    });
  };

  const openRecorder = () => {
    const canvas = playerRef.current?.getMainCanvas();
    if (!canvas) return false;
    // 재생 fps 와 녹화 fps 를 맞춰야 영상 길이가 실제 동작 길이와 같아진다.
    recorder.start(canvas, { fps: PLAY_FPS, name: FILE_NAME });
    return true;
  };

  const beginView = () => {
    if (cleanRef.current) fmcRef.current.setCleanView(true);
    playerRef.current?.setRecordingBackground(true);
  };

  // 녹화를 닫고 화면을 원래대로 되돌린다. 녹화 중이 아니어도 안전하다.
  // cancelPlayback: 자동 녹화를 중간에 접을 때만 true (재생도 같이 멈춘다)
  const finish = (cancelPlayback) => {
    clearTimers();
    if (cancelPlayback) fmcRef.current.stopPlayAll();
    setAuto(false);
    recorder.stop();
    fmcRef.current.setCleanView(false);
    playerRef.current?.setRecordingBackground(false);
  };

  // 수동 녹화 토글 (실시간 모드의 ● 녹화 / ■ 정지 와 같은 동작)
  const toggle = () => {
    if (recorder.isRecording || auto) {
      finish(auto);
      return;
    }
    if (!recorder.supported) return;
    beginView();
    afterRepaint(() => { openRecorder(); });
  };

  // 전체 자동 녹화: 0번 프레임부터 끝까지 재생하면서 녹화하고 자동으로 멈춘다.
  const startAuto = () => {
    const f = fmcRef.current;
    if (auto || recorder.isRecording || !recorder.supported) return;
    if (!(f.clip?.frameCount > 0)) return;

    f.setPlaying(false);
    f.seek(0);
    setAuto(true);
    beginView();

    afterRepaint(() => {
      if (!openRecorder()) { finish(true); return; }
      const started = f.playAll(() => {
        tailRef.current = setTimeout(() => finish(false), TAIL_MS);
      });
      if (!started) finish(true);
    });
  };

  // 언마운트 / 모드 전환 시 타이머 정리. MediaRecorder 정지는 useRecorder 가 알아서 한다.
  useEffect(() => clearTimers, []);

  return {
    isRecording: recorder.isRecording,
    elapsed: recorder.elapsed,
    supported: recorder.supported,
    error: recorder.error,
    auto,
    cleanView,
    setCleanView,
    toggle,
    startAuto,
    cancel: () => finish(true),
  };
}
