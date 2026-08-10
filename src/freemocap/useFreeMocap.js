import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildClip } from './parseTrajectories.js';
import { computeBodyBasis, DEFAULT_TRANSFORM } from './transform.js';

// 촬영 fps. FreeMoCap 녹화가 15fps 라 그대로 재생한다(30 으로 돌리면 2배속이 된다).
export const PLAY_FPS = 15;

// 업로드한 파일 목록에서 body / right_hand / left_hand CSV 를 골라낸다.
// 폴더째 올리면 face_trajectories, center_of_mass_trajectories, output_data 의
// mediapipe_*_3d_xyz.csv 까지 섞여 들어오므로 이름으로 걸러야 한다.
export function classifyFiles(files) {
  const csv = files.filter((f) => f.name.toLowerCase().endsWith('.csv'));
  // 정확한 이름 → trajectories 가 붙은 이름 → 단순 포함 순으로 후보를 좁힌다.
  const pick = (exact, keyword) =>
    csv.find((f) => f.name.toLowerCase() === exact) ||
    csv.find((f) => {
      const n = f.name.toLowerCase();
      return n.includes(keyword) && n.includes('trajector');
    }) ||
    csv.find((f) => f.name.toLowerCase().includes(keyword));

  // 손을 먼저 찾고, body 는 손/얼굴 파일을 제외한 뒤에 찾는다
  const rightHand = pick('right_hand_trajectories.csv', 'right_hand');
  const leftHand = pick('left_hand_trajectories.csv', 'left_hand');
  const bodyCandidates = csv.filter((f) => {
    const n = f.name.toLowerCase();
    return !n.includes('hand') && !n.includes('face') && !n.includes('center_of_mass')
      && !n.includes('timestamp') && !n.includes('joint_angles');
  });
  const body =
    bodyCandidates.find((f) => f.name.toLowerCase() === 'body_trajectories.csv') ||
    bodyCandidates.find((f) => f.name.toLowerCase().includes('body'));

  return { body, rightHand, leftHand };
}

// FreeMoCap 재생 모드의 상태 전부.
// 렌더 루프가 읽는 값은 stateRef 에 모아 두고, React state 는 UI 표시용으로만 쓴다.
export function useFreeMocap() {
  const clipRef = useRef(null);
  const frameRef = useRef(0);
  // 재생이 끝에서 처음으로 돌아갈지 여부. 전체 녹화(F-4)만 false 로 쓴다.
  const loopRef = useRef(true);
  // 끝까지 재생했을 때 한 번만 부를 콜백 (녹화 정지용)
  const onEndRef = useRef(null);

  const [clip, setClip] = useState(null);
  const [status, setStatus] = useState('idle'); // idle | loading | ready | error
  const [error, setError] = useState(null);
  const [fileNames, setFileNames] = useState(null);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [transform, setTransform] = useState(DEFAULT_TRANSFORM);
  // 아바타와 스켈레톤을 둘 다 켜두는 게 기본 — 팔 방향이 맞는지 겹쳐서 대조하려면 필요하다.
  const [view, setView] = useState({
    showAvatar: true, showSkeleton: true,
    showLower: true, showHands: true, showGrid: true,
  });

  // 자동 정렬 기준축은 클립 전체에서 한 번만 구한다 (프레임마다 구하면 몸통 회전이 지워진다)
  const basis = useMemo(() => (clip ? computeBodyBasis(clip.frames) : null), [clip]);

  const stateRef = useRef({
    frame: 0,
    transform: DEFAULT_TRANSFORM,
    basis: null,
    cleanView: false, // 녹화용 클린 뷰(F-4). 보기 토글과 별개로 렌더 루프에서만 덮어쓴다.
    ...view,
  });

  // 렌더 루프용 스냅샷 갱신. frame 은 재생 루프가 따로 직접 쓴다.
  useEffect(() => {
    stateRef.current.transform = transform;
    stateRef.current.basis = basis;
    Object.assign(stateRef.current, view);
  }, [transform, basis, view]);

  // 자동 정렬을 쓸 수 없는 데이터면(기준 관절이 전부 NaN 등) 조용히 수동으로 내린다
  useEffect(() => {
    if (clip && !basis && transform.mode === 'auto') {
      console.warn('[freemocap] 기준축을 구하지 못해 수동 모드로 전환합니다.');
      setTransform((t) => ({ ...t, mode: 'manual' }));
    }
  }, [clip, basis, transform.mode]);

  const seek = useCallback((next) => {
    const total = clipRef.current?.frameCount || 0;
    const i = total ? Math.max(0, Math.min(total - 1, Math.round(next))) : 0;
    frameRef.current = i;
    stateRef.current.frame = i;
    setFrame(i);
  }, []);

  const load = useCallback(async (fileList) => {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;

    setStatus('loading');
    setError(null);
    setPlaying(false);

    const { body, rightHand, leftHand } = classifyFiles(files);
    if (!body) {
      setError('body_trajectories.csv 를 찾지 못했습니다. 세 파일(body / right_hand / left_hand)을 함께 골라주세요.');
      setStatus('error');
      return;
    }

    try {
      const [bodyText, rightHandText, leftHandText] = await Promise.all([
        body.text(),
        rightHand ? rightHand.text() : Promise.resolve(null),
        leftHand ? leftHand.text() : Promise.resolve(null),
      ]);
      const next = buildClip({ bodyText, rightHandText, leftHandText });
      clipRef.current = next;
      frameRef.current = 0;
      stateRef.current.frame = 0;
      setFrame(0);
      setClip(next);
      setFileNames({
        body: body.name,
        rightHand: rightHand?.name || null,
        leftHand: leftHand?.name || null,
      });
      setStatus('ready');
    } catch (e) {
      console.error(e);
      clipRef.current = null;
      setClip(null);
      setFileNames(null);
      setError(e?.message || String(e));
      setStatus('error');
    }
  }, []);

  // 재생 루프. 슬라이더 표시용 setFrame 은 초당 PLAY_FPS 번만 돈다.
  useEffect(() => {
    if (!playing || !clip || clip.frameCount === 0) return;
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    const step = (now) => {
      acc += (now - last) / 1000;
      last = now;
      const advance = Math.floor(acc * PLAY_FPS);
      if (advance > 0) {
        acc -= advance / PLAY_FPS;
        let nextFrame = frameRef.current + advance;
        let ended = false;
        if (nextFrame >= clip.frameCount) {
          // 기본은 끝나면 처음으로 (동작을 반복해서 보며 축을 맞추기 좋다).
          // playAll() 로 들어왔으면 마지막 프레임에 멈추고 콜백을 부른다.
          if (loopRef.current) nextFrame %= clip.frameCount;
          else { nextFrame = clip.frameCount - 1; ended = true; }
        }
        frameRef.current = nextFrame;
        stateRef.current.frame = nextFrame;
        setFrame(nextFrame);
        if (ended) {
          const onEnd = onEndRef.current;
          onEndRef.current = null;
          loopRef.current = true;
          setPlaying(false); // 이 effect 의 cleanup 이 rAF 를 취소한다
          if (onEnd) onEnd();
          return;
        }
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, clip]);

  const togglePlay = useCallback(() => setPlaying((p) => !p), []);

  // 0번 프레임부터 끝까지 한 번만 재생한다. 마지막 프레임에서 멈추고 onEnd 를 부른다.
  // 프레임이 없으면 아무것도 안 하고 false 를 돌려준다.
  const playAll = useCallback((onEnd) => {
    if (!(clipRef.current?.frameCount > 0)) return false;
    seek(0);
    loopRef.current = false;
    onEndRef.current = onEnd || null;
    setPlaying(true);
    return true;
  }, [seek]);

  // playAll 을 중간에 접는다 (모드 전환·사용자 취소). 다음 재생은 다시 루프.
  const stopPlayAll = useCallback(() => {
    loopRef.current = true;
    onEndRef.current = null;
    setPlaying(false);
  }, []);

  // 녹화용 클린 뷰 on/off. React state 를 안 거치고 렌더 루프가 읽는 ref 에 바로 써서
  // 다음 프레임부터 곧바로 반영되게 한다(녹화 시작 직전에 켜야 하므로 한 박자도 늦으면 안 된다).
  const setCleanView = useCallback((on) => {
    stateRef.current.cleanView = !!on;
  }, []);

  return {
    clipRef, stateRef,
    clip, status, error, fileNames,
    frame, seek,
    playing, setPlaying, togglePlay,
    playAll, stopPlayAll,
    setCleanView,
    transform, setTransform,
    view, setView,
    basis,
    load,
  };
}
