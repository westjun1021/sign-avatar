import { useCallback, useEffect, useRef, useState } from 'react';
import { Holistic } from '@mediapipe/holistic';

// 카메라 + MediaPipe Holistic 을 켜고, 매 프레임 결과를 landmarksRef 에 써 넣는 훅.
// React state 로 랜드마크를 넘기면 초당 30번 리렌더가 나므로,
// 랜드마크는 ref 로 흘리고 state 는 상태(status)에만 씁니다.
export function useHolistic(videoRef, landmarksRef) {
  const holisticRef = useRef(null);
  const rafRef = useRef(null);
  const streamRef = useRef(null);
  const readyRef = useRef(false);
  const [status, setStatus] = useState('idle'); // idle | loading | running | error
  const [error, setError] = useState(null);

  const start = useCallback(async () => {
    if (status === 'loading' || status === 'running') return;
    setStatus('loading');
    setError(null);
    readyRef.current = false;

    try {
      // 1) 카메라
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 1280, height: 720, facingMode: 'user' },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current;
      video.srcObject = stream;
      await video.play();

      // 2) Holistic (얼굴 + 양손 + 포즈 한 번에)
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

      // 3) 프레임 루프: 비디오를 Holistic 으로 계속 보냄
      const loop = async () => {
        const h = holisticRef.current;
        if (h && video.readyState >= 2) {
          try {
            await h.send({ image: video });
          } catch (e) {
            // 종료 중 send 가 겹치면 나는 에러는 무시
          }
        }
        rafRef.current = requestAnimationFrame(loop);
      };
      loop();
    } catch (e) {
      console.error(e);
      setError(e?.message || String(e));
      setStatus('error');
    }
  }, [status, videoRef, landmarksRef]);

  const stop = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (holisticRef.current) {
      try { holisticRef.current.close(); } catch (e) { /* noop */ }
      holisticRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    readyRef.current = false;
    setStatus('idle');
  }, []);

  useEffect(() => () => stop(), [stop]);

  return { status, error, start, stop };
}
