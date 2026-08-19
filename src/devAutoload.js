// [임시 · 검증용] ?autoload=1 이면 public/fmc/ 의 CSV 를 자동으로 물려 0번 프레임부터
// 끝까지 한 번 재생하고, 콘솔 출력을 dev 서버(/__devlog)로 그대로 흘려보낸다.
//
// 기존 로직은 하나도 안 건드린다 — 사용자가 파일 선택창에서 하던 동작(fmc.load → playAll)을
// 그대로 대신 눌러줄 뿐이다. 검증이 끝나면 이 파일과 App.jsx 의 훅 호출, vite.config.js 의
// devLogSink 플러그인, public/fmc/ 를 지우면 원상복구된다.

import { useEffect, useRef } from 'react';

const FILES = [
  'body_trajectories.csv',
  'left_hand_trajectories.csv',
  'right_hand_trajectories.csv',
];

export function isAutoload() {
  return typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('autoload') === '1';
}

// POST 를 직렬화한다. 안 그러면 4초 주기 로그와 완료 마커의 도착 순서가 뒤섞인다.
let chain = Promise.resolve();
export function post(line) {
  chain = chain.then(() =>
    fetch('/__devlog', { method: 'POST', body: line }).catch(() => {})
  );
  return chain;
}

function fmt(args) {
  return args.map((a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return `${a.name}: ${a.message}`;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
}

let teed = false;
export function teeConsole() {
  if (teed) return;
  teed = true;
  for (const level of ['log', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      orig(...args);
      post(level === 'log' ? fmt(args) : `[${level}] ${fmt(args)}`);
    };
  }
  window.addEventListener('error', (e) => post(`[error] ${e.message}`));
  window.addEventListener('unhandledrejection', (e) => post(`[error] ${e.reason}`));
}

export function waitFor(cond, label, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const tick = () => {
      let v;
      try { v = cond(); } catch { v = null; }
      if (v) return resolve(v);
      if (performance.now() - t0 > timeoutMs) return reject(new Error(`timeout: ${label}`));
      setTimeout(tick, 100);
    };
    tick();
  });
}

export function useDevAutoload({ fmc, playerRef, setMode }) {
  const ran = useRef(false);
  useEffect(() => {
    if (!isAutoload() || ran.current) return;
    ran.current = true;

    (async () => {
      await post('__RESET__');
      teeConsole();
      console.log('[autoload] 시작');

      setMode('fmc');

      // 무대가 마운트되고 VRM 이 올라올 때까지 기다린다.
      // VRM 없이 재생하면 리타깃 자체가 안 돌아 앞부분 프레임이 통계에서 빠진다.
      const player = await waitFor(() => playerRef.current, 'stage mount');
      console.log('[autoload] 무대 마운트됨');

      const texts = await Promise.all(
        FILES.map((n) => fetch(`/fmc/${n}`).then((r) => {
          if (!r.ok) throw new Error(`${n} ${r.status}`);
          return r.text();
        }))
      );
      const files = FILES.map((n, i) => new File([texts[i]], n, { type: 'text/csv' }));
      await fmc.load(files);

      const clip = await waitFor(() => fmc.clipRef.current, 'clip parsed');
      console.log(`[autoload] 클립 ${clip.frameCount} 프레임 로드`);

      await waitFor(() => player.vrm, 'vrm load');
      console.log('[autoload] VRM 준비됨 — 0번부터 재생');

      // playAll: seek(0) → loop 끄고 마지막 프레임까지 한 번만 → onEnd
      const started = fmc.playAll(() => {
        console.log('[autoload] 재생 종료 — 최종 통계');
        if (typeof window.__retargetStats === 'function') window.__retargetStats();
        post('__DONE__');
      });
      if (!started) {
        console.error('[autoload] playAll 실패');
        post('__DONE__');
      }
    })().catch((e) => {
      console.error('[autoload]', e);
      post('__DONE__');
    });
  }, [fmc, playerRef, setMode]);
}
