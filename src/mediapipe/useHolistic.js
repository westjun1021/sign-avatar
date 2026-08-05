import { useCallback, useEffect, useRef, useState } from 'react';
import { Holistic } from '@mediapipe/holistic';

// 입력 영상(웹캠 또는 업로드한 파일)을 MediaPipe Holistic 에 흘려
// 매 프레임 결과를 landmarksRef 에 써 넣는 훅.
//
// holistic.send({ image: video }) 는 video 가 웹캠 스트림이든 파일 재생이든
// 똑같이 동작한다. 그래서 입력 소스만 갈아끼우면 리타깃 파이프라인은 그대로다.
//
// React state 로 랜드마크를 넘기면 초당 30번 리렌더가 나므로,
// 랜드마크는 ref 로 흘리고 state 는 상태(status)에만 씁니다.
export function useHolistic(videoRef, landmarksRef) {
  const holisticRef = useRef(null);
  const rafRef = useRef(null);
  const streamRef = useRef(null);
  const objectUrlRef = useRef(null);
  const readyRef = useRef(false);
  const [status, setStatus] = useState('idle'); // idle | loading | running | error
  const [sourceType, setSourceType] = useState(null); // null | 'webcam' | 'file'
  const [error, setError] = useState(null);

  // 이전 소스의 흔적을 지운다 (웹캠 ↔ 파일 전환 시 필요)
  const releaseSource = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    const video = videoRef.current;
    if (video) {
      video.srcObject = null;
      video.removeAttribute('src');
      try { video.load(); } catch (e) { /* 정리 실패는 무시 */ }
    }
  }, [videoRef]);

  const setupHolistic = useCallback(() => {
    const holistic = new Holistic({
      locateFile: (file) =>
        `https://cdn.jsdelivr.net/npm/@mediapipe/holistic@0.5.1675471629/${file}`,
    });
    holistic.setOptions({
      modelComplexity: 1,
      smoothLandmarks: true,      // 시간 스무딩 (떨림 완화)
      refineFaceLandmarks: true,  // 눈/입 정밀 (표정 = 비수지 신호)
      minDetectionConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    holistic.onResults((results) => {
      landmarksRef.current = {
        pose: results.poseLandmarks || null,
        leftHand: results.leftHandLandmarks || null,
        rightHand: results.rightHandLandmarks || null,
        face: results.faceLandmarks || null,
      };
      if (!readyRef.current) {
        readyRef.current = true;
        setStatus('running');
      }
    });
    holisticRef.current = holistic;
  }, [landmarksRef]);

  // 프레임 루프: 비디오를 Holistic 으로 계속 보냄.
  // 일시정지/재생종료 상태면 추론을 건너뛴다 — 파일 모드에서 헛돌지 않게 하고,
  // 랜드마크가 마지막 값으로 남아 아바타가 마지막 자세로 멈춘다.
  const runLoop = useCallback((video) => {
    const loop = async () => {
      const h = holisticRef.current;
      if (h && video.readyState >= 2 && !video.paused) {
        try {
          await h.send({ image: video });
        } catch (e) {
          // 종료 중 send 가 겹치면 나는 에러는 무시
        }
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    loop();
  }, []);

  const start = useCallback(async () => {
    if (status === 'loading' || status === 'running') return;
    setStatus('loading');
    setError(null);
    readyRef.current = false;

    try {
      releaseSource();
      // 1) 카메라
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 1280, height: 720, facingMode: 'user' },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current;
      video.srcObject = stream;
      video.loop = false;
      await video.play();

      setSourceType('webcam');
      setupHolistic();
      runLoop(video);
    } catch (e) {
      console.error(e);
      setError(e?.message || String(e));
      setStatus('error');
    }
  }, [status, videoRef, releaseSource, setupHolistic, runLoop]);

  // 업로드한 영상 파일로 시작. 재생 제어(재생/일시정지/처음으로)는 사용자가 한다.
  const startFromFile = useCallback(async (file) => {
    if (!file) return;
    if (status === 'loading' || status === 'running') return;
    setStatus('loading');
    setError(null);
    readyRef.current = false;

    try {
      releaseSource();
      const video = videoRef.current;
      const url = URL.createObjectURL(file);
      objectUrlRef.current = url;
      video.srcObject = null;
      video.src = url;
      video.loop = false;
      video.muted = true; // 자동재생 차단을 피하려면 음소거여야 한다
      // 파일 선택 자체가 사용자 제스처라 여기서의 play() 는 보통 허용된다
      await video.play();

      setSourceType('file');
      setupHolistic();
      runLoop(video);
    } catch (e) {
      console.error(e);
      setError(e?.message || String(e));
      setStatus('error');
      releaseSource();
    }
  }, [status, videoRef, releaseSource, setupHolistic, runLoop]);

  const stop = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (holisticRef.current) {
      try { holisticRef.current.close(); } catch (e) { /* noop */ }
      holisticRef.current = null;
    }
    releaseSource();
    readyRef.current = false;
    setSourceType(null);
    setStatus('idle');
  }, [releaseSource]);

  useEffect(() => () => stop(), [stop]);

  return { status, sourceType, error, start, startFromFile, stop };
}
