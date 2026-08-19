// [임시 · 검증용] ?stdview=1 이면 "수어 표준 뷰"와 배경 전환을 자동으로 점검하고
// 결과를 콘솔(→ /__devlog)로 흘린다. 앱 로직은 하나도 안 건드린다 — 사용자가
// 버튼으로 하는 조작을 그대로 대신 눌러보고 결과를 재는 것뿐이다.
// 검증이 끝나면 이 파일과 App.jsx 의 훅 호출을 지우면 원상복구된다.
//
// 점검 항목 (요청한 검증 목록 그대로):
//   1. 표준 뷰 pose 결정론 — 궤도를 돌린 뒤/프레임을 옮긴 뒤/resetView 뒤에 눌러도 동일한가
//   2. 아바타 배율이 다른 "다른 클립" 상황에서 화면상 프레이밍(NDC)이 동일한가
//   3. 클립 전체에서 손이 프레임 밖으로 안 나가는가 (좌우 마진 확인)
//   4. 배경 4색 전환이 배경·격자만 바꾸고 조명·아바타는 안 건드리는가

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { post, teeConsole, waitFor } from './devAutoload.js';
import { BACKGROUND_KEYS, BACKGROUNDS } from './freemocap/background.js';

const FILES = [
  'body_trajectories.csv',
  'left_hand_trajectories.csv',
  'right_hand_trajectories.csv',
];

export function isStdViewCheck() {
  return typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('stdview') === '1';
}

const frames = (n) => new Promise((resolve) => {
  let left = n;
  const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick));
  requestAnimationFrame(tick);
});

const f = (n) => (Number.isFinite(n) ? n.toFixed(6) : String(n));

// 카메라 pose 를 비교 가능한 문자열로. 렌즈 시프트(view offset)까지 포함한다.
function poseKey(camera) {
  const v = camera.view;
  const off = (v && v.enabled)
    ? `${f(v.fullWidth)}/${f(v.fullHeight)}/${f(v.offsetX)}/${f(v.offsetY)}/${f(v.width)}/${f(v.height)}`
    : 'none';
  return [
    `pos(${f(camera.position.x)},${f(camera.position.y)},${f(camera.position.z)})`,
    `up(${f(camera.up.x)},${f(camera.up.y)},${f(camera.up.z)})`,
    `fov ${f(camera.fov)}`,
    `shift ${off}`,
  ].join(' ');
}

// 손끝까지 포함한 아바타 말단. 화면 밖으로 나갈 수 있는 지점들이다.
const HAND_BONES = [
  'leftHand', 'rightHand',
  'leftThumbDistal', 'leftIndexDistal', 'leftMiddleDistal', 'leftRingDistal', 'leftLittleDistal',
  'rightThumbDistal', 'rightIndexDistal', 'rightMiddleDistal', 'rightRingDistal', 'rightLittleDistal',
  'leftLowerArm', 'rightLowerArm', 'head',
];

export function useDevStdView({ fmc, playerRef, setMode }) {
  const ran = useRef(false);
  useEffect(() => {
    if (!isStdViewCheck() || ran.current) return;
    ran.current = true;

    (async () => {
      await post('__RESET__');
      teeConsole();
      console.log('[stdview] 시작');
      setMode('fmc');

      const player = await waitFor(() => playerRef.current, 'stage mount');
      const texts = await Promise.all(FILES.map((n) => fetch(`/fmc/${n}`).then((r) => {
        if (!r.ok) throw new Error(`${n} ${r.status}`);
        return r.text();
      })));
      await fmc.load(FILES.map((n, i) => new File([texts[i]], n, { type: 'text/csv' })));
      const clip = await waitFor(() => fmc.clipRef.current, 'clip parsed');
      await waitFor(() => player.vrm, 'vrm load');
      await frames(4);
      console.log(`[stdview] 클립 ${clip.frameCount} 프레임 · VRM 준비됨`);

      const camera = player.camera;
      const fit = player._vrmFit;
      console.log(`[stdview] 캔버스 ${player.container.clientWidth}×${player.container.clientHeight} (종횡비 ${f(camera.aspect)})`);
      console.log(`[stdview] 아바타 실측(rest): 어깨너비 ${f(fit.shoulderWidth)} 눈 ${f(fit.eyeY)} 가슴 ${f(fit.chestY)} 머리끝 ${f(fit.headTopY)}`);

      // ---- 1. 표준 뷰 pose 결정론 --------------------------------------
      const poses = [];
      const press = async (tag) => {
        player.standardView();
        await frames(2);
        const key = poseKey(camera);
        poses.push({ tag, key });
        console.log(`[stdview] ${tag.padEnd(22)} ${key}`);
      };

      await press('① 첫 호출');

      // 궤도를 크게 돌린 상황을 흉내 (드래그와 같은 결과: 카메라·타깃 이동)
      camera.position.set(1.73, 2.41, -1.12);
      player.controls.target.set(0.31, -0.22, 0.44);
      player.controls.update();
      await frames(2);
      await press('② 궤도 회전 후');

      // 재생 위치를 끝으로 (손 자세가 완전히 다른 프레임)
      fmc.seek(clip.frameCount - 1);
      await frames(4);
      await press('③ 마지막 프레임에서');

      player.resetView();
      await frames(3);
      await press('④ resetView 후');

      const same = poses.every((p) => p.key === poses[0].key);
      console.log(`[stdview] 결정론: ${same ? 'PASS — 4회 모두 동일한 pose' : 'FAIL — pose 가 달라짐'}`);

      // pitch / yaw / roll 실측
      const dir = new THREE.Vector3();
      camera.getWorldDirection(dir);
      const pitch = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1)));
      const yaw = THREE.MathUtils.radToDeg(Math.atan2(dir.x, dir.z));
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
      const roll = THREE.MathUtils.radToDeg(Math.asin(THREE.MathUtils.clamp(right.y, -1, 1)));
      // 시선 벡터가 (0,0,-1) 이면 아바타 정면(+Z)을 정확히 마주 본 것.
      // yaw 는 +Z 를 0 으로 잰 값이라 정면일 때 ±180° 로 나온다 — dir 로 판정하는 게 명확하다.
      console.log(`[stdview] 시선 ${f(dir.x)},${f(dir.y)},${f(dir.z)} (0,0,-1 이어야 정면)`);
      console.log(`[stdview] 각도: pitch ${f(pitch)}° roll ${f(roll)}° (0 이어야 함) · yaw ${f(yaw)}° (정면 = ±180)`);

      // 카메라 Y 가 아바타 눈높이와 같은가
      const eyeWorld = player.vrm.scene.position.y + fit.eyeY * player.vrm.scene.scale.x;
      console.log(`[stdview] 눈높이: 카메라 Y ${f(camera.position.y)} vs 아바타 눈 Y ${f(eyeWorld)} · 차 ${f(camera.position.y - eyeWorld)}`);

      // ---- 2. "다른 클립"(어깨너비가 다른 녹화) 상황의 화면상 프레이밍 --------
      // _fitVrm 은 basis.shoulderWidth × transform.scale 로 아바타 배율을 정한다.
      // 즉 크기 슬라이더를 움직이면 어깨너비가 다른 클립을 문 것과 수학적으로 같다.
      const landmarkNdc = () => {
        const s = player.vrm.scene.scale.x;
        const base = player.vrm.scene.position.y;
        const at = (y) => new THREE.Vector3(0, base + y * s, 0).project(camera);
        return {
          eye: at(fit.eyeY).y, chest: at(fit.chestY).y, top: at(fit.headTopY).y,
        };
      };
      const ndcA = landmarkNdc();
      const scaleA = player.vrm.scene.scale.x;

      fmc.setTransform((t) => ({ ...t, scale: 3.1 })); // 원래 2.0
      await frames(6);
      player.standardView();
      await frames(2);
      const ndcB = landmarkNdc();
      const scaleB = player.vrm.scene.scale.x;
      const dNdc = Math.max(
        Math.abs(ndcA.eye - ndcB.eye), Math.abs(ndcA.chest - ndcB.chest), Math.abs(ndcA.top - ndcB.top)
      );
      console.log(`[stdview] 아바타 배율 ${f(scaleA)} → ${f(scaleB)} (다른 클립 상황)`);
      console.log(`[stdview]   화면 세로 위치 NDC 눈 ${f(ndcA.eye)}→${f(ndcB.eye)} / 가슴 ${f(ndcA.chest)}→${f(ndcB.chest)} / 머리끝 ${f(ndcA.top)}→${f(ndcB.top)}`);
      console.log(`[stdview]   프레이밍 불변: ${dNdc < 1e-6 ? 'PASS' : 'FAIL'} (최대 차 ${f(dNdc)})`);
      // 눈이 화면 위에서 몇 % 지점인가 (NDC +1 = 위) → 상단 1/3 확인
      console.log(`[stdview]   눈높이 위치: 화면 위에서 ${f((1 - ndcB.eye) / 2 * 100)}% (상단 1/3 목표)`);
      console.log(`[stdview]   머리 위 여백: 프레임 높이의 ${f((1 - ndcB.top) / 2 * 100)}% (방송 기준 5~10%)`);

      fmc.setTransform((t) => ({ ...t, scale: 2.0 }));
      await frames(6);
      player.standardView();
      await frames(2);

      // ---- 3. 클립 전체에서 손이 잘리는가 -------------------------------
      // 실제 브라우저 창 비율에 결과가 좌우되면 안 되므로(첫 검증이 752×83 = 9:1 에서
      // 돌아 세로가 기형적으로 병목이 됐다) 대표 비율 3개를 동시에 잰다.
      //
      // 방법: 각 비율로 camera.aspect 를 바꿔 player.standardView() 를 시켜 그 비율에
      // 맞는 거리·시프트를 "실제 구현이" 계산하게 하고, 그 pose 를 복제 카메라에 담는다.
      // 복제본에는 그 비율의 가상 픽셀 박스로 시프트를 다시 걸어준다 — 계산식은 전부
      // 구현 것을 쓰고 픽셀 수만 합성하는 것이라 자기검증이 되지 않는다.
      const ASPECTS = [
        { label: '16:9', a: 16 / 9, w: 1280, h: 720 },
        { label: '4:3', a: 4 / 3, w: 960, h: 720 },
        { label: '1:1', a: 1, w: 720, h: 720 },
      ];
      const origAspect = camera.aspect;
      const rigs = ASPECTS.map((A) => {
        camera.aspect = A.a;
        player.standardView();
        const cam = camera.clone();
        cam.aspect = A.a;
        const vs = player._viewShift;
        if (vs) {
          const fw = A.w * vs.k, fh = A.h * vs.k;
          cam.setViewOffset(fw, fh, (fw - A.w) / 2, (fh - A.h) / 2 + vs.down * A.h, A.w, A.h);
        } else cam.clearViewOffset();
        cam.updateMatrixWorld(true);
        cam.updateProjectionMatrix();
        return {
          A, cam, dist: cam.position.z,
          ext: { maxAbsX: 0, atX: -1, boneX: '', minY: Infinity, atMinY: -1, boneMinY: '', maxY: -Infinity, atMaxY: -1, boneMaxY: '' },
        };
      });
      camera.aspect = origAspect;   // 라이브 카메라는 원래 비율로 되돌린다
      player.standardView();
      for (const r of rigs) console.log(`[stdview] 검사 비율 ${r.A.label} → 거리 ${f(r.dist)}`);

      const bones = HAND_BONES
        .map((n) => ({ name: n, node: player.vrm.humanoid.getRawBoneNode(n) }))
        .filter((b) => b.node);
      console.log(`[stdview] 말단 본 ${bones.length}/${HAND_BONES.length} 개로 잘림 검사 (${clip.frameCount} 프레임)`);

      // 해부학적 타당성 판정용: 몸 중심축에서 어깨너비 몇 배까지 벌어졌나.
      // 사람은 한쪽으로 어깨너비 1.7배 정도가 한계라, 그보다 크면 리타깃 튐을 의심한다.
      const reach = { max: 0, at: -1, bone: '' };
      const worldX = new THREE.Vector3();
      const shoulderWorld = fit.shoulderWidth * player.vrm.scene.scale.x;

      for (let i = 0; i < clip.frameCount; i++) {
        fmc.seek(i);
        await frames(2); // 리타깃 → vrm.update → render 가 한 번 돌게
        for (const b of bones) {
          b.node.getWorldPosition(worldX);
          const spread = Math.abs(worldX.x) / shoulderWorld;
          if (spread > reach.max) { reach.max = spread; reach.at = i; reach.bone = b.name; }
          for (const r of rigs) {
            const p = worldX.clone().project(r.cam);
            const e = r.ext;
            if (Math.abs(p.x) > e.maxAbsX) { e.maxAbsX = Math.abs(p.x); e.atX = i; e.boneX = b.name; }
            if (p.y < e.minY) { e.minY = p.y; e.atMinY = i; e.boneMinY = b.name; }
            if (p.y > e.maxY) { e.maxY = p.y; e.atMaxY = i; e.boneMaxY = b.name; }
          }
        }
        if (i % 100 === 0) console.log(`[stdview]   … ${i}/${clip.frameCount}`);
      }

      console.log(`[stdview] 최대 좌우 벌어짐 = 어깨너비 × ${f(reach.max)} (frame ${reach.at}, ${reach.bone}) — 1.7 을 크게 넘으면 리타깃 튐`);
      for (const r of rigs) {
        const e = r.ext;
        const okX = e.maxAbsX <= 1, okY = e.minY >= -1 && e.maxY <= 1;
        console.log(`[stdview] [${r.A.label}] 좌우 |x|max ${f(e.maxAbsX)} (frame ${e.atX} ${e.boneX}) 여백 ${f((1 - e.maxAbsX) * 100)}% → ${okX ? 'PASS' : 'FAIL'}`);
        console.log(`[stdview] [${r.A.label}] 세로 y ${f(e.minY)} (frame ${e.atMinY} ${e.boneMinY}) ~ ${f(e.maxY)} (frame ${e.atMaxY} ${e.boneMaxY}) → ${okY ? 'PASS' : 'FAIL'}`);
      }

      // ---- 4. 배경 4색 전환 --------------------------------------------
      const lights = [];
      player.scene.traverse((o) => { if (o.isLight) lights.push(`${o.type}:${o.intensity}:${o.color.getHexString()}`); });
      const vrmBefore = `${f(player.vrm.scene.scale.x)}/${f(player.vrm.scene.position.y)}/${player.vrm.scene.visible}`;

      for (const key of BACKGROUND_KEYS) {
        fmc.setView((v) => ({ ...v, bg: key }));
        await frames(6);
        const bgHex = player.scene.background?.getHexString?.() ?? 'none';
        const clear = player.renderer.getClearColor(new THREE.Color()).getHexString();
        const alpha = player.renderer.getClearAlpha();
        const gridOk = !!player.gridHelper && player.grid.children.includes(player.gridHelper);
        const want = BACKGROUNDS[key].color.toString(16).padStart(6, '0');
        console.log(`[stdview] 배경 ${key.padEnd(5)} scene=#${bgHex} clear=#${clear} alpha=${alpha} 기대=#${want} 격자재생성=${gridOk} ${bgHex === want && clear === want && alpha === 1 ? 'PASS' : 'FAIL'}`);
      }

      const lightsAfter = [];
      player.scene.traverse((o) => { if (o.isLight) lightsAfter.push(`${o.type}:${o.intensity}:${o.color.getHexString()}`); });
      const vrmAfter = `${f(player.vrm.scene.scale.x)}/${f(player.vrm.scene.position.y)}/${player.vrm.scene.visible}`;
      console.log(`[stdview] 조명 불변: ${lights.join('|') === lightsAfter.join('|') ? 'PASS' : 'FAIL'} (${lightsAfter.join(' | ')})`);
      console.log(`[stdview] 아바타 불변: ${vrmBefore === vrmAfter ? 'PASS' : 'FAIL'} (${vrmAfter})`);

      fmc.setView((v) => ({ ...v, bg: 'black' }));
      console.log('[stdview] 완료');
      post('__DONE__');
    })().catch((e) => {
      console.error('[stdview]', e);
      post('__DONE__');
    });
  }, [fmc, playerRef, setMode]);
}
