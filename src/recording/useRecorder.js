import { useCallback, useEffect, useRef, useState } from 'react';
import fixWebmDuration from 'fix-webm-duration';

// 캔버스를 MediaRecorder 로 녹화해서 파일로 내려주는 훅. 서버 없음.
//
// 주의: captureStream 은 캔버스가 "실제로 그려지고 있을 때"만 프레임을 낸다.
// SkeletonAvatar 가 setAnimationLoop 로 매 프레임 그리고 있으므로 괜찮지만,
// 카메라를 멈추면 그림이 안 바뀌므로 호출부에서 녹화도 같이 멈춰야 한다.

// 녹화 프레임레이트 기본값. 캔버스 렌더 fps 가 16~28 로 출렁여도 이 간격으로 고정해서 넣는다.
// (불규칙한 프레임 타임스탬프가 길이와 어긋나면서 긴 영상에서 탐색이 깨졌다.)
// start(canvas, { fps }) 로 덮어쓸 수 있다 — FreeMoCap 재생은 소스가 15fps 라 그 값을 넘긴다.
const RECORD_FPS = 24;

// 저장 파일 이름 앞부분 기본값. start(canvas, { name }) 로 덮어쓸 수 있다.
const DEFAULT_NAME = 'sign-avatar';

// --- 탐색(seek) 개선 ---
// MediaRecorder 로 만든 webm 은 키프레임이 드물어서 재생기에서 중간을 못 짚는다.
// duration 은 이미 measureBlobDuration → fixWebmDuration 으로 심어 뒀으니(C-1c)
// 남은 문제는 "짚을 지점 자체가 없다"는 것이다. 두 가지로 완화한다.
//
// 1) timeslice 를 짧게 준다. ondataavailable 이 끊는 지점마다 새 Cluster 가
//    열리고, 크로미움은 Cluster 를 키프레임으로 시작한다 → 탐색 포인트가 늘어난다.
//    1000ms 로는 1초에 하나뿐이라 250ms 로 줄인다(초당 4개). 대신 파일이 조금 커진다.
//    (파이어폭스는 timeslice 가 키프레임 생성에 영향을 주지 않는다 — bugzilla 1666487)
const TIMESLICE_MS = 250;
// 2) 키프레임 간격을 직접 요청한다. W3C MediaStream Recording 의
//    MediaRecorderOptions.videoKeyFrameIntervalDuration 으로, 크로미움이 구현했다.
//    모르는 키는 WebIDL 규칙상 무시되므로 미지원 브라우저에서도 안전하다(1번만 적용됨).
const KEY_FRAME_INTERVAL_MS = 250;
//
// 그래도 webm + MediaRecorder 조합의 구조적 한계라 완벽한 탐색은 안 된다
// (Cues/SeekHead 색인이 아예 없어서 재생기가 클러스터를 순차로 훑어야 한다).
// 완전한 탐색은 mp4 로 변환(ffmpeg.wasm)해서 moov/stss 를 만들어야 한다 — 후속 과제.
// 사파리 등에서 mimeType 이 video/mp4 로 잡히면 이 문제 자체가 없다.

// 브라우저마다 지원이 다르다. 크롬은 보통 webm, 사파리·일부 크롬은 mp4.
const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
];

function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const type of MIME_CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(type)) return type;
    } catch (e) {
      // isTypeSupported 자체가 없는 구형 브라우저
    }
  }
  return null;
}

// 측정이 끝나지 않으면 저장이 영영 안 끝난다. 반드시 상한을 둔다.
const DURATION_MEASURE_TIMEOUT = 3000;

// 녹화된 blob 의 "실제 재생시간"(ms)을 브라우저로 재서 돌려준다. 못 재면 null.
//
// 벽시계 시간(Date.now 차이)을 쓰면 프레임 드랍만큼 어긋나고, 길게 녹화할수록
// 오차가 쌓여 탐색 위치가 밀린다. 그래서 실제 길이를 재서 심는다.
function measureBlobDuration(blob) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const url = URL.createObjectURL(blob);
    const video = document.createElement('video');

    const finish = (ms) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        video.onloadedmetadata = null;
        video.onseeked = null;
        video.ontimeupdate = null;
        video.onerror = null;
        video.removeAttribute('src');
        video.load();
      } catch (e) {
        // 정리 실패는 무시 — 측정값 반환이 우선
      }
      URL.revokeObjectURL(url);
      resolve(ms);
    };

    timer = setTimeout(() => finish(null), DURATION_MEASURE_TIMEOUT);

    const readDuration = () => {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        finish(video.duration * 1000);
        return true;
      }
      return false;
    };

    video.preload = 'metadata';
    video.muted = true;
    video.onerror = () => finish(null);
    video.onloadedmetadata = () => {
      if (readDuration()) return;
      // webm 은 loadedmetadata 에서 duration 이 Infinity 로 나오는 알려진 버그가 있다.
      // 끝으로 한 번 seek 하면 브라우저가 실제 길이를 채운다.
      try {
        video.currentTime = Number.MAX_SAFE_INTEGER;
      } catch (e) {
        finish(null);
      }
    };
    const onUpdate = () => {
      if (readDuration()) return;
      // duration 이 끝내 Infinity 인 구현도 있다 → seek 이 멈춘 지점을 길이로 쓴다
      if (Number.isFinite(video.currentTime) && video.currentTime > 0) {
        finish(video.currentTime * 1000);
      }
    };
    video.onseeked = onUpdate;
    video.ontimeupdate = onUpdate;

    try {
      video.src = url;
    } catch (e) {
      finish(null);
    }
  });
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function useRecorder() {
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const timerRef = useRef(null);
  const frameTimerRef = useRef(null); // 고정 간격 프레임 요청 타이머
  const streamRef = useRef(null);
  const startedAtRef = useRef(0); // duration 주입용 녹화 시작 시각(ms)
  const [isRecording, setIsRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0); // 초
  const [error, setError] = useState(null);
  // 지원 형식은 한 번만 탐색 (useState 초기화 함수)
  const [mimeType] = useState(pickMimeType);
  const supported = mimeType !== null;

  const clearTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  // 프레임 요청 타이머는 어떤 경로로 끝나든 반드시 정리해야 한다(누수 방지)
  const clearFrameTimer = () => {
    if (frameTimerRef.current) {
      clearInterval(frameTimerRef.current);
      frameTimerRef.current = null;
    }
  };

  const releaseStream = () => {
    if (streamRef.current) {
      try {
        streamRef.current.getTracks().forEach((t) => t.stop());
      } catch (e) {
        // 이미 끝난 트랙은 무시
      }
      streamRef.current = null;
    }
  };

  // options (전부 선택): { fps, name }
  //  - fps  : 프레임을 밀어 넣는 간격. 소스 fps 와 맞춰야 영상 길이가 실제와 같아진다.
  //  - name : 저장 파일 이름 앞부분.
  // 안 주면 지금까지와 똑같이 동작한다(실시간 녹화 경로는 그대로).
  const start = useCallback((canvas, options) => {
    if (!canvas || !supported || recorderRef.current) return;
    const fps = options?.fps > 0 ? options.fps : RECORD_FPS;
    const name = options?.name || DEFAULT_NAME;
    try {
      // 고정 프레임레이트 강제:
      // captureStream(0) 은 브라우저 자동 캡처를 끄고, 우리가 requestFrame() 을
      // 부를 때만 프레임이 들어간다. 일정 간격으로 부르면 캔버스 렌더 fps 가
      // 출렁여도 녹화 타임스탬프는 규칙적으로 유지된다.
      // (렌더가 그 순간 안 끝났으면 직전 캔버스 상태가 그대로 캡처된다 — 허용 범위)
      let stream = canvas.captureStream(0);
      let track = stream.getVideoTracks()[0];
      const manual = !!track && typeof track.requestFrame === 'function';
      if (!manual) {
        // 파이어폭스 등 requestFrame 미지원 → 브라우저 자동 캡처로 폴백
        stream.getTracks().forEach((t) => t.stop());
        stream = canvas.captureStream(fps);
        track = stream.getVideoTracks()[0];
      }
      streamRef.current = stream;

      const recorder = new MediaRecorder(stream, {
        mimeType,
        videoKeyFrameIntervalDuration: KEY_FRAME_INTERVAL_MS,
      });
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        const raw = new Blob(chunksRef.current, { type: mimeType });
        chunksRef.current = [];
        recorderRef.current = null;
        clearFrameTimer();
        releaseStream();
        if (raw.size === 0) {
          setError('녹화된 프레임이 없습니다.');
          return;
        }
        const isMp4 = mimeType.startsWith('video/mp4');
        const ext = isMp4 ? 'mp4' : 'webm';

        // MediaRecorder 가 만든 webm 에는 Duration 태그가 없어서 재생기에서
        // 탐색(seek)이 안 된다. 헤더에 duration 만 심는다 — 재인코딩이 아니라
        // 화질 손실 없고 수십 ms 면 끝난다. mp4 는 애초에 문제가 없어 건너뛴다.
        let blob = raw;
        if (!isMp4) {
          // 벽시계 시간은 프레임 드랍만큼 어긋나서 길게 녹화할수록 탐색이 밀린다.
          // 실제 재생시간을 재서 쓰고, 못 재면 벽시계로 폴백한다.
          let durationMs = Date.now() - startedAtRef.current;
          try {
            const measured = await measureBlobDuration(raw);
            if (measured !== null && measured > 0) durationMs = measured;
            else console.warn('[recorder] 재생시간 측정 실패 — 벽시계 시간으로 대체합니다.');
          } catch (e) {
            console.warn('[recorder] 재생시간 측정 오류 — 벽시계 시간으로 대체합니다.', e);
          }
          try {
            // 참고: 이 라이브러리(1.0.6)는 Duration 이 이미 있고 값이 0보다 크면
            // 덮어쓰지 않고 그냥 반환한다. MediaRecorder 는 Duration 을 아예 안 넣어서
            // 보통 문제가 안 되지만, 이미 고쳐진 파일을 다시 넣으면 무시된다.
            blob = await fixWebmDuration(raw, durationMs);
          } catch (e) {
            // 실패해도 저장은 되어야 한다 — 원본으로 폴백(탐색만 안 될 뿐)
            console.warn('[recorder] duration 주입 실패, 원본으로 저장합니다.', e);
            blob = raw;
          }
        }

        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${name}-${timestamp()}.${ext}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        // 다운로드가 시작된 뒤에 해제 (바로 revoke 하면 저장이 취소될 수 있다)
        setTimeout(() => URL.revokeObjectURL(url), 10000);
      };
      recorder.onerror = (e) => setError(e?.error?.message || '녹화 중 오류');

      // 청크를 자주 받아 메모리에 한 번에 쌓이지 않게 하고, 동시에 탐색 포인트도 늘린다
      recorder.start(TIMESLICE_MS);
      recorderRef.current = recorder;

      if (manual) {
        const requestFrame = () => {
          try {
            track.requestFrame();
          } catch (e) {
            // 트랙이 이미 끝났으면 무시 (정지 직후 한 번 더 불릴 수 있다)
          }
        };
        requestFrame(); // 첫 프레임은 바로
        frameTimerRef.current = setInterval(requestFrame, 1000 / fps);
      }
      setError(null);
      setIsRecording(true);
      setElapsed(0);

      const t0 = Date.now();
      startedAtRef.current = t0;
      // 500ms 마다 확인하되 초가 바뀔 때만 값이 달라져 리렌더는 초당 1회
      timerRef.current = setInterval(() => {
        setElapsed(Math.floor((Date.now() - t0) / 1000));
      }, 500);
    } catch (e) {
      setError(e?.message || String(e));
      recorderRef.current = null;
      setIsRecording(false);
      clearTimer();
      clearFrameTimer();
      releaseStream();
    }
  }, [mimeType, supported]);

  const stop = useCallback(() => {
    clearTimer();
    clearFrameTimer(); // 프레임 요청부터 멈춘다
    setIsRecording(false);
    const recorder = recorderRef.current;
    // 파일 저장은 onstop 에서 일어난다
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    else releaseStream(); // 녹화 중이 아니었다면 여기서 정리
  }, []);

  // 언마운트 시 녹화 중이면 정지 (onstop 은 그대로 둬서 저장은 시도한다)
  useEffect(() => () => {
    clearTimer();
    clearFrameTimer();
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    else releaseStream();
  }, []);

  return { isRecording, elapsed, supported, error, start, stop, mimeType };
}
