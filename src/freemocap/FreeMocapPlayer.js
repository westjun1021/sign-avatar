// FreeMoCap 재생 모드의 Three.js 무대.
// 실시간 파이프라인(SkeletonAvatar / MediaPipe / 리타깃 / 녹화)과 완전히 분리돼 있다.
// VRM 은 아직 안 붙인다 — 좌표계가 맞는지 스틱맨으로 먼저 확인하는 단계(F-2).
//
// React 는 clipRef / stateRef 만 채우고, 프레임 갱신은 여기 애니메이션 루프가 한다.
// (슬라이더를 60fps 로 리렌더하지 않기 위해서다 — 실시간 모드와 같은 이유)

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import {
  makeFatLine, setFatLineData, makePointCloud, setPointCloudData,
  COLOR_BONE, COLOR_JOINT, COLOR_HAND,
} from '../three/stickFigure.js';
// 팔·손목·손가락 리타깃은 실시간 모드와 같은 코드다. 좌표 변환만 place3D 로 갈아끼운다.
import { BoneRetargeter } from '../three/retarget.js';
import {
  FMC_UPPER_CONNECTIONS, FMC_FULL_CONNECTIONS,
  FMC_UPPER_JOINTS, FMC_FULL_JOINTS,
  FMC_HAND_CONNECTIONS,
} from './fmcLandmarks.js';
import { place3D, frameCenter, transformHandedness, DEFAULT_TRANSFORM } from './transform.js';

// 카메라 프레이밍. 자동 정렬 + AXIS_SCALE 2.0 기준으로 이 녹화의 전신이
// y -1.61 ~ +0.87 에 들어온다(실측). fov 45 / z 3.6 이면 세로 반높이가 1.49 라
// 타깃 y -0.35 기준으로 -1.84 ~ +1.14 가 보인다 → 머리부터 발끝까지 다 들어온다.
const FRAME_Y = -0.35;
const FRAME_Z = 3.6;

const BONE_WIDTH = 3.5;
const JOINT_SIZE = 0.06;

// 바닥 격자 + 축 표시. "사람이 똑바로 서 있나"를 눈으로 판단하는 기준선이다.
// 격자 높이는 자동 정렬일 때 데이터에서 잰 발 높이(basis.floorDrop)를 따라간다 —
// 크기 슬라이더를 돌려도 발밑에 붙어 있게.
const GRID_SIZE = 4;
const GRID_DIVISIONS = 8;
const GRID_FALLBACK_Y = -1.7; // 기준축을 못 구했을 때(수동 모드)의 고정 높이

const VRM_URL = '/avatar.vrm';
// 기준축을 못 구해 실측 맞춤을 못 할 때의 폴백 (수동 모드에서 축이 엉망일 때)
const VRM_FALLBACK_SCALE = 1.0;
const VRM_FALLBACK_Y = -0.9;

export class FreeMocapPlayer {
  // clipRef: { current: clip | null }  — buildClip() 결과
  // stateRef: { current: { frame, transform, basis, showLower, showHands, showGrid } }
  constructor(container, clipRef, stateRef) {
    this.container = container;
    this.clipRef = clipRef;
    this.stateRef = stateRef;
    this._v = new THREE.Vector3();

    // --- 리타깃 (F-3) ---
    this.vrm = null;                  // _loadVRM() 이 비동기로 채움
    this._vrmFit = null;              // 로드 직후 실측한 어깨너비/골반높이
    this._clock = new THREE.Clock();  // vrm.update(delta) 용
    // 리타깃이 읽을 "이번 프레임의 좌표 규약". _loop 가 매 프레임 갱신한다.
    this._center = null;
    this._transform = DEFAULT_TRANSFORM;
    this._basis = null;
    // place3D 는 NaN 좌표에 false 를 돌려주고 out 을 안 건드린다 → 리타깃이 직전 값을
    // 그대로 읽어 엉뚱한 방향이 나온다. 그래서 NaN 은 아래 _clean 에서 미리 null 로 거른다.
    this._retarget = new BoneRetargeter((out, lm) => {
      place3D(out, lm, this._center, this._transform, this._basis);
    });
    // 손 21점의 NaN 을 걸러 담을 재사용 배열 (매 프레임 새로 만들지 않으려고)
    this._handL = new Array(21);
    this._handR = new Array(21);

    const w = container.clientWidth || 640;
    const h = container.clientHeight || 480;

    this.scene = new THREE.Scene();
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 100);
    this.camera.position.set(0, FRAME_Y, FRAME_Z);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(0, FRAME_Y, 0);
    this.camera.lookAt(this.controls.target);
    this.controls.update();
    this._homePos = this.camera.position.clone();
    this._homeTarget = this.controls.target.clone();

    // 기준 격자/축 (X 빨강 · Y 초록 · Z 파랑)
    this.grid = new THREE.Group();
    this.grid.add(
      new THREE.GridHelper(GRID_SIZE, GRID_DIVISIONS, 0x3a4557, 0x232c3a),
      new THREE.AxesHelper(0.5) // X 빨강 · Y 초록 · Z 파랑
    );
    this.grid.position.y = GRID_FALLBACK_Y;
    this.scene.add(this.grid);

    // 뼈대 선 — 최대 개수로 잡아두고 매 프레임 앞쪽만 채운다
    this.bodyLine = makeFatLine(FMC_FULL_CONNECTIONS.length, w, h, { color: COLOR_BONE, linewidth: BONE_WIDTH });
    this.leftHandLine = makeFatLine(FMC_HAND_CONNECTIONS.length, w, h, { color: COLOR_HAND, linewidth: BONE_WIDTH });
    this.rightHandLine = makeFatLine(FMC_HAND_CONNECTIONS.length, w, h, { color: COLOR_HAND, linewidth: BONE_WIDTH });
    this._fatLines = [this.bodyLine, this.leftHandLine, this.rightHandLine];
    for (const line of this._fatLines) this.scene.add(line);

    this.jointPoints = makePointCloud(FMC_FULL_JOINTS.length + 21 + 21, COLOR_JOINT, JOINT_SIZE);
    this.scene.add(this.jointPoints);

    // 컨테이너 크기는 창 크기와 따로 논다(사이드 패널 접힘 등). ResizeObserver 가 정확하다.
    this._resize = this._resize.bind(this);
    this._observer = new ResizeObserver(this._resize);
    this._observer.observe(container);

    // 스켈레톤·격자는 Basic/Points 계열이라 조명이 필요 없지만 VRM 은 없으면 새까맣다.
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
    keyLight.position.set(0.5, 2, 2.5); // 정면 위쪽
    this.scene.add(keyLight, new THREE.AmbientLight(0xffffff, 0.6));

    this._running = true;
    this._loop = this._loop.bind(this);
    this.renderer.setAnimationLoop(this._loop);

    this._loadVRM();
  }

  _loadVRM() {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    loader.load(
      VRM_URL,
      (gltf) => {
        const vrm = gltf.userData.vrm;
        if (!vrm) {
          console.error('VRM load error: VRM 확장이 없는 glTF 입니다 —', VRM_URL);
          return;
        }
        // 로딩(12MB) 중에 dispose 된 경우 — React StrictMode 의 mount/unmount/mount
        // 왕복에서 실제로 발생한다. 씬에 붙이지 말고 바로 정리해야 누수가 안 생긴다.
        if (!this._running) {
          VRMUtils.deepDispose(vrm.scene);
          return;
        }
        // VRM0 모델은 +Z(뒤)를 보고 있어서 180° 돌려야 정면이 된다. (public/avatar.vrm 은 VRM 0.0)
        if (typeof VRMUtils.rotateVRM0 === 'function') VRMUtils.rotateVRM0(vrm);
        this.scene.add(vrm.scene);
        // 회전이 들어가기 전 rest 자세에서 재야 한다 → this.vrm 대입(=리타깃 시작)보다 먼저.
        this._vrmFit = this._measureVrm(vrm);
        this.vrm = vrm;
      },
      undefined,
      (err) => console.error('VRM load error', err)
    );
  }

  // rest 자세에서 어깨 너비와 골반 높이를 잰다 (scale 1 / position 0 기준).
  // 이 값으로 아바타를 스켈레톤과 같은 크기·높이에 세워서 겹쳐 볼 수 있게 한다.
  _measureVrm(vrm) {
    const humanoid = vrm.humanoid;
    if (!humanoid) return null;
    vrm.scene.updateMatrixWorld(true);
    const world = (name) => {
      const bone = humanoid.getNormalizedBoneNode(name);
      return bone ? bone.getWorldPosition(new THREE.Vector3()) : null;
    };
    const la = world('leftUpperArm');
    const ra = world('rightUpperArm');
    const hips = world('hips');
    if (!la || !ra || !hips) return null;
    const shoulderWidth = la.distanceTo(ra);
    if (!(shoulderWidth > 1e-6)) return null;
    return { shoulderWidth, hipsY: hips.y };
  }

  // 아바타를 이번 transform 기준으로 스켈레톤과 같은 크기·높이에 맞춘다.
  // (리타깃은 방향만 쓰므로 자세와는 무관하다 — 순전히 겹쳐 보기 위한 것)
  _fitVrm(transform, basis) {
    const fit = this._vrmFit;
    if (!fit) return;
    if (basis && basis.shoulderWidth > 1e-6) {
      const scale = (basis.shoulderWidth * transform.scale) / fit.shoulderWidth;
      this.vrm.scene.scale.setScalar(scale);
      // 스켈레톤의 골반은 원점에서 hipsOffset*scale 만큼 아래에 있다. 거기에 맞춘다.
      this.vrm.scene.position.y = basis.hipsOffset * transform.scale - fit.hipsY * scale;
    } else {
      this.vrm.scene.scale.setScalar(VRM_FALLBACK_SCALE);
      this.vrm.scene.position.y = VRM_FALLBACK_Y;
    }
  }

  // NaN 좌표를 null 로. 리타깃은 null 을 "이번 프레임 건너뜀"으로 처리한다.
  _clean(p) {
    return (p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) ? p : null;
  }

  _cleanHand(hand, out) {
    if (!hand) return null;
    for (let i = 0; i < 21; i++) out[i] = this._clean(hand[i]);
    return out;
  }

  // 현재 프레임의 관절 위치를 기존 리타깃에 그대로 먹인다.
  //
  // 좌우 매핑: place3D 가 반사 변환이면(수동 부호 조합이나 좌우 반전) 사람의 왼쪽이
  // 화면 오른쪽으로 가므로 VRM 의 반대쪽 팔에 붙여야 한다 — 실시간 모드의
  // "mirror 면 왼팔 → VRM 오른팔" 규칙과 같은 판정을 transformHandedness 로 일반화했다.
  //
  // 순서는 실시간 모드와 동일: 팔(위→아래) → 손목 → 손가락.
  // 자식이 부모의 "현재" 월드 회전을 읽어 부모 공간으로 옮기므로 순서가 바뀌면 안 된다.
  _retargetFrame(frame, transform, basis) {
    const humanoid = this.vrm.humanoid;
    if (!humanoid) return;

    const swapped = transformHandedness(transform, basis) < 0;
    const L = swapped ? 'right' : 'left';  // 사람의 왼쪽이 붙을 VRM 쪽
    const R = swapped ? 'left' : 'right';

    this._retarget.applyArm(humanoid,
      this._clean(frame.left_shoulder), this._clean(frame.left_elbow), this._clean(frame.left_wrist), L);
    this._retarget.applyArm(humanoid,
      this._clean(frame.right_shoulder), this._clean(frame.right_elbow), this._clean(frame.right_wrist), R);

    const leftHand = this._cleanHand(frame.leftHand, this._handL);
    const rightHand = this._cleanHand(frame.rightHand, this._handR);
    // FreeMoCap 좌표에는 visibility 가 없다. 삼각측량으로 나온 값이라 그대로 신뢰한다
    // (실시간 모드의 폐색 게이팅에 해당하는 게 없음 → trusted = true).
    this._retarget.applyWrist(humanoid, leftHand, L, true);
    this._retarget.applyWrist(humanoid, rightHand, R, true);
    this._retarget.applyFingers(humanoid, leftHand, L, true);
    this._retarget.applyFingers(humanoid, rightHand, R, true);
  }

  // 연결 목록을 선 버퍼에 채우고 실제 채운 float 개수를 돌려준다.
  // getPoint(key) 가 null/NaN 을 주면 그 선분은 통째로 건너뛴다(추적 실패 구간).
  _fillConnections(line, connections, getPoint, center, transform, basis) {
    const pos = line.userData.positions;
    let o = 0;
    for (const [ka, kb] of connections) {
      const a = getPoint(ka);
      const b = getPoint(kb);
      if (!place3D(this._v, a, center, transform, basis)) continue;
      const ax = this._v.x, ay = this._v.y, az = this._v.z;
      if (!place3D(this._v, b, center, transform, basis)) continue;
      pos[o++] = ax; pos[o++] = ay; pos[o++] = az;
      pos[o++] = this._v.x; pos[o++] = this._v.y; pos[o++] = this._v.z;
    }
    setFatLineData(line, o);
    return o;
  }

  // 스켈레톤 오브젝트 전부 숨기기 (데이터 없음 / 토글 off)
  _hideSkeleton() {
    for (const line of this._fatLines) line.visible = false;
    this.jointPoints.visible = false;
  }

  _loop() {
    if (!this._running) return;
    const clip = this.clipRef.current;
    const st = this.stateRef.current || {};
    const transform = st.transform || DEFAULT_TRANSFORM;
    const basis = st.basis || null;
    const showSkeleton = st.showSkeleton !== false;
    const showAvatar = st.showAvatar !== false;

    this.grid.visible = st.showGrid !== false;
    this.grid.position.y = (transform.mode === 'auto' && basis)
      ? -basis.floorDrop * transform.scale
      : GRID_FALLBACK_Y;
    if (this.vrm) this.vrm.scene.visible = showAvatar;

    // 이번 프레임의 좌표 규약을 리타깃터의 place 클로저가 읽을 수 있게 걸어둔다
    this._transform = transform;
    this._basis = basis;

    const frame = (clip && clip.frameCount > 0)
      ? clip.frames[Math.max(0, Math.min(clip.frameCount - 1, Math.round(st.frame || 0)))]
      : null;
    // 중심을 못 구한 프레임(전신 추적 실패)에는 직전 중심을 그대로 쓴다 — 몸이 튀지 않게.
    const center = frame ? (frameCenter(frame) || this._center) : null;
    this._center = center;

    if (!frame || !center || !showSkeleton) {
      this._hideSkeleton();
    } else {
      const showLower = st.showLower !== false;
      const showHands = st.showHands !== false;
      const connections = showLower ? FMC_FULL_CONNECTIONS : FMC_UPPER_CONNECTIONS;

      this._fillConnections(this.bodyLine, connections, (k) => frame[k], center, transform, basis);

      if (showHands && frame.leftHand) {
        this._fillConnections(this.leftHandLine, FMC_HAND_CONNECTIONS, (k) => frame.leftHand[k], center, transform, basis);
      } else {
        this.leftHandLine.visible = false;
      }
      if (showHands && frame.rightHand) {
        this._fillConnections(this.rightHandLine, FMC_HAND_CONNECTIONS, (k) => frame.rightHand[k], center, transform, basis);
      } else {
        this.rightHandLine.visible = false;
      }

      // 관절 점: 몸통 + 양손 21점씩
      const pos = this.jointPoints.geometry.attributes.position.array;
      let o = 0;
      const push = (p) => {
        if (!place3D(this._v, p, center, transform, basis)) return;
        pos[o++] = this._v.x; pos[o++] = this._v.y; pos[o++] = this._v.z;
      };
      for (const name of showLower ? FMC_FULL_JOINTS : FMC_UPPER_JOINTS) push(frame[name]);
      if (showHands) {
        if (frame.leftHand) for (const p of frame.leftHand) push(p);
        if (frame.rightHand) for (const p of frame.rightHand) push(p);
      }
      setPointCloudData(this.jointPoints, o);
    }

    // --- 리타깃 → vrm.update 순서. 본 회전을 먼저 넣어야 스프링본 등에 반영된다. ---
    // 일시정지 중에도 계속 돈다: 같은 프레임을 반복해서 먹으면 EMA/slerp 가 그 자세로
    // 수렴하므로, 슬라이더로 멈춘 프레임의 최종 자세를 그대로 볼 수 있다.
    if (this.vrm) {
      this._fitVrm(transform, basis);
      if (frame && center && showAvatar) this._retargetFrame(frame, transform, basis);
      this.vrm.update(this._clock.getDelta());
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  resetView() {
    // SkeletonAvatar.resetView() 와 같은 이유로 순서가 중요하다: damping 을 끈 채
    // 홈 좌표를 먼저 넣으면 직전 드래그의 잔여 회전량이 통째로 더해져 카메라가 튄다.
    this.controls.enableDamping = false;
    this.controls.update();
    this.camera.position.copy(this._homePos);
    this.controls.target.copy(this._homeTarget);
    this.controls.update();
    this.controls.enableDamping = true;
  }

  _resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    // LineMaterial 은 px 두께 계산에 렌더러 해상도를 쓴다
    for (const line of this._fatLines) line.material.resolution.set(w, h);
  }

  dispose() {
    this._running = false;
    this.renderer.setAnimationLoop(null);
    this._observer.disconnect();
    this.controls.dispose();
    // VRM 은 아래 traverse 로 정리하면 안 된다 — 멀티머티리얼 메시의 material 이
    // 배열이라 텍스처가 안 지워진다. 먼저 떼어내고 deepDispose 로 통째로 정리한다.
    if (this.vrm) {
      this.scene.remove(this.vrm.scene);
      VRMUtils.deepDispose(this.vrm.scene);
      this.vrm = null;
    }
    this.scene.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) m.dispose();
      }
    });
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode === this.container) {
      this.container.removeChild(this.renderer.domElement);
    }
  }
}
