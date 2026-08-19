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
// 리타깃 뒤에 손목만 몸통 밖으로 밀어내는 보정(F-5). 재생 모드 전용이다 —
// 사람 몸통과 아바타 몸통의 두께 차이는 실측 3D 좌표를 쓸 때 특히 두드러진다.
import { BodyPusher } from '../three/bodyPush.js';
import {
  FMC_UPPER_CONNECTIONS, FMC_FULL_CONNECTIONS,
  FMC_UPPER_JOINTS, FMC_FULL_JOINTS,
  FMC_HAND_CONNECTIONS,
} from './fmcLandmarks.js';
import { place3D, frameCenter, transformHandedness, DEFAULT_TRANSFORM } from './transform.js';
import { BACKGROUNDS, DEFAULT_BACKGROUND } from './background.js';

// 카메라 프레이밍 — 뉴스 수어 통역사처럼 머리~허리 흉상만 크게 (실시간 모드 D-1 과 같은 방식).
//
// 이 무대의 원점은 바닥이 아니라 "몸통 중심(trunk_center)"이다. 자동 정렬 +
// AXIS_SCALE 2.0 기준으로 이 녹화의 전신이 y -1.61 ~ +0.87 에 들어온다(실측).
// 즉 키 H = 2.48 이고 바닥이 -1.61 이므로, 사람 비율로 환산하면:
//   머리끝 +0.87  어깨 +0.42  가슴 +0.18  골반 -0.30  무릎 -0.94  발 -1.61
// (_fitVrm 이 VRM 의 골반·어깨너비를 스켈레톤에 맞춰 세우므로 아바타도 같은 범위다)
//
// 흉상(골반 -0.30 ~ 머리끝 +0.87)은 높이 1.17, 세로 중심이 +0.285 다.
// fov 45 / z 2.0 이면 세로 반높이가 0.83 → 타깃 y 0.30 기준 -0.53 ~ +1.13 이 보인다.
//   머리 위 0.26 여백 (손을 머리 위로 들어도 여유) / 아래는 골반보다 0.23 더
//   내려간 허벅지 위쪽에서 잘림 → 무릎·발은 화면 밖(의도한 대로).
//   흉상이 화면 세로의 약 70% 를 채운다.
//
// 팔을 옆으로 뻗은 손이 좌우로 잘리면 FMC_FRAME_Z 를 키워 여유를 준다
// (2.0 → 2.2 면 좌우가 10% 넓어지는 대신 흉상 비중이 64% 로 내려간다).
// 크기 슬라이더(transform.scale)를 기본 2.0 에서 움직이면 아바타만 커지고
// 카메라는 그대로라 확대/축소처럼 동작한다 — 그건 원래 의도한 조작이다.
const FMC_FRAME_Y = 0.30;
const FMC_FRAME_Z = 2.0;
const FMC_FOV = 45;

// --- 수어 표준 뷰 (F-6) -------------------------------------------------
// 최종 산출물이 mp4 이고 여러 클립을 잘라 붙이므로, 카메라 각도가 클립마다
// 정확히 같아야 한다. 그래서 이 뷰는 "재생 중인 데이터"를 전혀 안 본다 —
// 오직 아바타 실측치(어깨너비·눈높이·머리끝·가슴)만으로 pose 를 계산한다.
// 같은 아바타·같은 크기 슬라이더 값이면 몇 번을 눌러도, 어떤 클립에서 눌러도,
// 궤도를 돌린 뒤에 눌러도 카메라 좌표가 정확히 같은 값으로 떨어진다.
//
// 표준 요건(UNICEF / WCAG 2.1 AAA 등 수어 영상 제작 가이드):
//   눈높이 · 완전 정면 · 올려다봄/내려다봄 0 · 가슴~머리 위 프레임 ·
//   좌우 신호 공간 + 마진 · 단색 배경
//
// "카메라를 눈높이에 두고 pitch 0" 과 "얼굴이 프레임 상단 1/3" 은 그냥은 동시에
// 성립하지 않는다(타깃을 내리는 순간 내려다보는 각이 생긴다). 그래서 카메라를
// 기울이는 대신 렌즈를 시프트한다 — 광축은 눈높이에 수평으로 둔 채 실제보다 큰
// 가상 프레임을 잡고 그 아래쪽만 잘라 쓴다(camera.setViewOffset). 건축사진의
// 시프트렌즈와 같은 원리다.
//
// 프레임은 위/아래 모서리를 직접 정하고, 눈높이가 프레임 어디쯤 오는지는 그 결과로
// 따라오게 한다(아래 두 상수의 비율로 정해진다 — 현재 값에서 위에서 약 29%).
// 눈높이 비율을 고정하고 높이를 max() 로 키우는 방식도 해봤는데, 아래를 넓히면
// 위쪽 여백이 같이 부풀어 머리 위 공백이 23% 까지 벌어졌다(방송 기준은 5~10%).
// 얼굴 위치는 STD_TOP_MARGIN 을 줄이면 위로, 늘리면 아래로 간다.
const STD_FOV = 45;
// 좌우 마진. 손을 옆으로 크게 뻗는 프레임이 잘리면 이 값(또는 아래 SPAN_W)을 올린다.
const STD_SIDE_MARGIN = 0.15;
// 신호 공간 가로폭 = 어깨너비 × 이 값. 수어는 몸 앞 신호 공간 전체를 쓴다.
// 실측(439 프레임)상 손은 중심에서 어깨너비 0.92 배까지만 벌어져 좌우는 늘 여유가
// 남는다 — 이 값이 실제로 작동하는 건 세로로 긴(세로형) 화면비일 때다.
const STD_SIGN_SPAN_W = 2.8;
// 프레임 위 = 머리끝 + 어깨너비 × 이 값 (머리 위 여백. 작을수록 얼굴이 위로 간다)
const STD_TOP_MARGIN = 0.55;
// 프레임 아래 = 가슴 + 어깨너비 × 이 값만큼 아래.
// 1.25 였을 때 실측 클립에서 손 내리는 구간(frame 412)이 2.6% 잘렸다. 1.55 면
// 그 최저점 아래로 프레임 높이의 14% 가 남는다 — 요청한 10~15% 마진.
const STD_BOTTOM_DROP = 1.55;
// 눈 본이 없는 VRM 의 폴백: head 본에서 어깨너비 × 이 값만큼 위를 눈높이로 본다.
const STD_EYE_FALLBACK = 0.35;

const BONE_WIDTH = 3.5;
const JOINT_SIZE = 0.06;

// 바닥 격자 + 축 표시. "사람이 똑바로 서 있나"를 눈으로 판단하는 기준선이다.
// 격자 높이는 자동 정렬일 때 데이터에서 잰 발 높이(basis.floorDrop)를 따라간다 —
// 크기 슬라이더를 돌려도 발밑에 붙어 있게.
const GRID_SIZE = 4;
const GRID_DIVISIONS = 8;
const GRID_FALLBACK_Y = -1.7; // 기준축을 못 구했을 때(수동 모드)의 고정 높이

// 녹화(F-4) 관련. 실시간 모드(SkeletonAvatar)와 같은 이유·같은 값이다.
// preserveDrawingBuffer 가 없으면 captureStream 이 간헐적으로 검은 프레임을 집는다.
const PRESERVE_DRAWING_BUFFER = true;
// 배경은 항상 불투명 단색(F-6)이라 녹화용 임시 배경 전환이 필요 없다 — 화면에
// 보이는 배경이 그대로 mp4 에 담긴다(크로마키 색을 고르면 그 색 그대로).

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
    // 몸통 파고듦 완화 (F-5). 리타깃과 별개의 후처리라 상태도 따로 둔다.
    this._pusher = new BodyPusher();
    // 재생 위치 점프 감지용 (스무딩 상태 리셋 판정 — _loop 참고)
    this._lastClip = null;
    this._lastIdx = -1;

    const w = container.clientWidth || 640;
    const h = container.clientHeight || 480;

    this.scene = new THREE.Scene();
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: PRESERVE_DRAWING_BUFFER, // 녹화 시 검은 프레임 방지
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(FMC_FOV, w / h, 0.1, 100);
    this.camera.position.set(0, FMC_FRAME_Y, FMC_FRAME_Z);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(0, FMC_FRAME_Y, 0);
    this.camera.lookAt(this.controls.target);
    this.controls.update();
    this._homePos = this.camera.position.clone();
    this._homeTarget = this.controls.target.clone();

    // 표준 뷰 상태. _viewShift 는 렌즈 시프트 비율(픽셀은 창 크기마다 다르므로
    // 비율만 들고 있다가 _applyViewOffset 에서 그때그때 픽셀로 환산한다).
    this._viewShift = null;
    this._standard = false;
    // 사용자가 궤도를 돌리면 "표준 뷰 고정"을 푼다 — 창 크기가 바뀔 때 사용자가
    // 맞춰둔 시점을 표준 pose 로 덮어쓰지 않기 위해서다.
    this.controls.addEventListener('start', () => { this._standard = false; });

    // 기준 격자/축 (X 빨강 · Y 초록 · Z 파랑).
    // 격자는 배경색에 따라 색이 달라져 _applyBackground 가 만든다.
    this.grid = new THREE.Group();
    this.gridHelper = null;
    this.grid.add(new THREE.AxesHelper(0.5)); // X 빨강 · Y 초록 · Z 파랑
    this.grid.position.y = GRID_FALLBACK_Y;
    this.scene.add(this.grid);

    this._bg = null;
    this._applyBackground(DEFAULT_BACKGROUND);

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
  //
  // 표준 뷰(F-6)용 세로 기준점(눈·가슴·머리끝)도 여기서 같이 잰다. 전부 rest 자세의
  // 로컬 Y 라, 나중에 `scene.position.y + y * scale` 로 현재 월드 높이가 나온다.
  // 리타깃은 팔·손목·손가락만 건드리므로(척추·목·머리는 rest 그대로) 이 값들은
  // 재생 프레임과 무관하게 항상 같다 — 표준 뷰가 결정론적인 이유다.
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

    // 눈높이: 눈 본이 있으면 그 평균, 없으면 head 본에서 조금 위 (VRM 의 head 본은
    // 두개골 아래쪽이라 그대로 쓰면 눈보다 낮다).
    const eyeL = world('leftEye');
    const eyeR = world('rightEye');
    const head = world('head');
    let eyeY = null;
    if (eyeL && eyeR) eyeY = (eyeL.y + eyeR.y) / 2;
    else if (eyeL || eyeR) eyeY = (eyeL || eyeR).y;
    else if (head) eyeY = head.y + shoulderWidth * STD_EYE_FALLBACK;

    // 가슴 중앙. upperChest 가 없는 모델이 흔해서 chest → spine 으로 폴백한다.
    const chest = world('upperChest') || world('chest') || world('spine');
    const chestY = chest ? chest.y : hips.y + shoulderWidth;

    // 머리끝: 본이 아니라 실제 메시 바운딩(머리카락 포함)을 쓴다 — 머리 위 여백을
    // "보이는 실루엣" 기준으로 잡아야 헤어가 잘리지 않는다.
    const box = new THREE.Box3().setFromObject(vrm.scene);
    const headTopY = Number.isFinite(box.max.y)
      ? box.max.y
      : (eyeY != null ? eyeY + shoulderWidth * 0.5 : hips.y + shoulderWidth * 3);

    return { shoulderWidth, hipsY: hips.y, eyeY, chestY, headTopY };
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
  // 몸통 파고듦 보정(F-5)은 아래팔 회전을 고쳐 쓰므로 그 사이(팔 뒤 · 손목 앞)에 들어간다.
  _retargetFrame(frame, transform, basis, bodyPush) {
    const humanoid = this.vrm.humanoid;
    if (!humanoid) return;

    const swapped = transformHandedness(transform, basis) < 0;
    const L = swapped ? 'right' : 'left';  // 사람의 왼쪽이 붙을 VRM 쪽
    const R = swapped ? 'left' : 'right';

    this._retarget.applyArm(humanoid,
      this._clean(frame.left_shoulder), this._clean(frame.left_elbow), this._clean(frame.left_wrist), L);
    this._retarget.applyArm(humanoid,
      this._clean(frame.right_shoulder), this._clean(frame.right_elbow), this._clean(frame.right_wrist), R);

    // 손목이 몸통 안으로 들어갔으면 아래팔을 앞으로 조금 돌려 표면에서 멈추게 한다.
    // 몸에서 먼 동작에는 아무 영향이 없다(몸통 상자 밖이면 밀기 세기가 0).
    if (bodyPush && this._pusher.update(this.vrm)) {
      this._pusher.push(humanoid, L);
      this._pusher.push(humanoid, R);
    }

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
    // 녹화용 클린 뷰: 아바타만 남기고 스켈레톤·격자를 뺀다.
    // 사용자의 보기 토글을 건드리지 않고 여기서만 덮어쓰므로, 녹화가 끝나면
    // 플래그를 내리는 것만으로 화면이 원래대로 돌아온다.
    const clean = st.cleanView === true;
    const showSkeleton = !clean && st.showSkeleton !== false;
    const showAvatar = clean || st.showAvatar !== false;

    // 배경색(F-6). 바뀔 때만 실제 작업을 한다 — 안 바뀌면 비교 한 번으로 끝난다.
    this._applyBackground(st.bg || DEFAULT_BACKGROUND);

    this.grid.visible = !clean && st.showGrid !== false;
    this.grid.position.y = (transform.mode === 'auto' && basis)
      ? -basis.floorDrop * transform.scale
      : GRID_FALLBACK_Y;
    if (this.vrm) this.vrm.scene.visible = showAvatar;

    // 이번 프레임의 좌표 규약을 리타깃터의 place 클로저가 읽을 수 있게 걸어둔다
    this._transform = transform;
    this._basis = basis;

    const idx = (clip && clip.frameCount > 0)
      ? Math.max(0, Math.min(clip.frameCount - 1, Math.round(st.frame || 0)))
      : -1;
    // 재생 위치가 뒤로 돌아가거나(처음부터 다시 재생) 크게 앞으로 뛰면(슬라이더 스크럽),
    // 또는 클립 자체가 바뀌면 리타깃 스무딩 상태를 비운다. 안 비우면 첫 프레임이
    // 직전 상태에 끌려 튄다. 정상 재생은 프레임당 1~2 칸이라 걸리지 않는다.
    if (clip !== this._lastClip || idx < this._lastIdx || idx > this._lastIdx + 10) {
      this._retarget.resetSmoothing();
    }
    this._lastClip = clip;
    this._lastIdx = idx;

    const frame = idx >= 0 ? clip.frames[idx] : null;
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
      if (frame && center && showAvatar) {
        this._retargetFrame(frame, transform, basis, st.bodyPush !== false);
      }
      this.vrm.update(this._clock.getDelta());
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  // 녹화 대상 캔버스 = 이 무대의 렌더러. 아바타·스켈레톤이 같은 씬에 있으므로
  // "아바타만" 담고 싶으면 stateRef.cleanView 를 켜서 스켈레톤·격자를 빼면 된다.
  getMainCanvas() {
    return this.renderer ? this.renderer.domElement : null;
  }

  // 배경색을 바꾼다 (검/흰/크로마 그린/크로마 블루). 조명·아바타·스켈레톤은 안 건드린다.
  // 격자는 정점 색으로 구워져 있어 머티리얼만 못 바꾸므로 헬퍼를 다시 만든다
  // (배경이 바뀔 때만 도는 경로라 비용은 무시할 수준).
  _applyBackground(key) {
    if (key === this._bg) return;
    const bg = BACKGROUNDS[key] || BACKGROUNDS[DEFAULT_BACKGROUND];
    this._bg = BACKGROUNDS[key] ? key : DEFAULT_BACKGROUND;

    // scene.background 가 알파 1 로 지우므로 녹화 파일에도 이 색이 그대로 담긴다.
    if (this.scene.background instanceof THREE.Color) this.scene.background.setHex(bg.color);
    else this.scene.background = new THREE.Color(bg.color);
    this.renderer.setClearColor(bg.color, 1);

    if (this.gridHelper) {
      this.grid.remove(this.gridHelper);
      this.gridHelper.geometry.dispose();
      this.gridHelper.material.dispose();
    }
    this.gridHelper = new THREE.GridHelper(GRID_SIZE, GRID_DIVISIONS, bg.grid[0], bg.grid[1]);
    this.grid.add(this.gridHelper);
  }

  // 렌즈 시프트를 현재 캔버스 크기에 맞춰 픽셀로 환산해 건다.
  // 가상 프레임(fullW × fullH)은 실제 프레임의 k 배이고, 실제로 그리는 창을
  // 그 안에서 아래로 down(프레임 높이 비율)만큼 내린 위치에서 잘라낸다.
  // 광축은 창 밖으로 나가지 않고 창 안 STD_EYE_LINE 지점에 남는다 → pitch 0 유지.
  _applyViewOffset() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    if (!this._viewShift) {
      this.camera.clearViewOffset(); // 내부에서 updateProjectionMatrix 까지 한다
      return;
    }
    const { k, down } = this._viewShift;
    const fullW = w * k;
    const fullH = h * k;
    this.camera.setViewOffset(fullW, fullH, (fullW - w) / 2, (fullH - h) / 2 + down * h, w, h);
  }

  // 수어 표준 뷰: 아바타 실측치만으로 카메라 pose 를 결정한다 (클립 무관·결정론적).
  // 눈높이 · 완전 정면 · pitch/roll 0 · 가슴~머리 위 · 좌우 신호 공간 + 마진.
  // 아바타 계측을 못 하면(VRM 로딩 전 등) 기존 홈 뷰로 폴백한다.
  standardView() {
    const fit = this._vrmFit;
    if (!this.vrm || !fit || fit.eyeY == null) {
      this.resetView();
      return false;
    }

    // _fitVrm 이 매 프레임 맞춰둔 현재 배율·높이. 이걸 통해 rest 실측치를 월드로 옮긴다.
    const s = this.vrm.scene.scale.x;
    const baseY = this.vrm.scene.position.y;
    const toWorld = (y) => baseY + y * s;

    const shoulderW = fit.shoulderWidth * s;
    const eyeY = toWorld(fit.eyeY);
    const top = toWorld(fit.headTopY) + shoulderW * STD_TOP_MARGIN;
    const bottom = toWorld(fit.chestY) - shoulderW * STD_BOTTOM_DROP;

    // 좌우 신호 공간 + 마진. 가로가 모자라면 그만큼 뒤로 빼서 프레임을 키운다
    // (프레임 중심은 그대로 두고 위아래로 같이 넓어진다).
    const needW = shoulderW * STD_SIGN_SPAN_W * (1 + STD_SIDE_MARGIN);
    const frameH = Math.max(top - bottom, needW / (this.camera.aspect || 1), 1e-4);
    const centerY = (top + bottom) / 2;

    // 광축을 눈높이에 수평으로 두고 프레임만 그 차이만큼 민다.
    // 가상 프레임을 k 배로 키우고 한쪽을 잘라 쓰므로 거리도 k 배가 된다
    // (= 더 긴 렌즈로 물러선 셈. 얼굴 원근 왜곡이 줄어 수어 영상에는 오히려 낫다).
    // 광축이 창 밖으로 나가면 구도가 뒤집히므로 프레임 반높이의 90% 로 묶는다
    // (현재 상수에서는 0.21 수준이라 걸릴 일이 없다 — 상수를 크게 바꿨을 때의 안전장치).
    const half = frameH / 2;
    const shift = Math.min(Math.max(eyeY - centerY, -half * 0.9), half * 0.9);
    const k = 1 + (2 * Math.abs(shift)) / frameH;
    const dist = (k * frameH) / 2 / Math.tan((STD_FOV * Math.PI) / 360);

    this.camera.fov = STD_FOV;
    this._viewShift = Math.abs(shift) > 1e-6 ? { k, down: shift / frameH } : null;
    this._applyViewOffset();
    this.camera.updateProjectionMatrix();

    // resetView 와 같은 이유로 damping 을 먼저 끈다 (직전 드래그의 잔여 회전량 제거).
    this.controls.enableDamping = false;
    this.controls.update();
    this.camera.up.set(0, 1, 0);                 // roll 0
    this.camera.position.set(0, eyeY, dist);     // 정면(+Z) · 눈높이
    this.controls.target.set(0, eyeY, 0);        // 카메라와 같은 높이 → pitch 0
    this.camera.lookAt(this.controls.target);
    this.controls.update();
    this.controls.enableDamping = true;

    // 창 크기가 바뀌면 프레이밍을 다시 계산해야 같은 구도가 유지된다.
    this._standard = true;
    return true;
  }

  resetView() {
    // SkeletonAvatar.resetView() 와 같은 이유로 순서가 중요하다: damping 을 끈 채
    // 홈 좌표를 먼저 넣으면 직전 드래그의 잔여 회전량이 통째로 더해져 카메라가 튄다.
    this._standard = false;
    this._viewShift = null;      // 표준 뷰의 렌즈 시프트 해제
    this.camera.fov = FMC_FOV;
    this._applyViewOffset();
    this.camera.updateProjectionMatrix();
    this.controls.enableDamping = false;
    this.controls.update();
    this.camera.up.set(0, 1, 0);
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
    // 표준 뷰가 걸려 있으면 새 종횡비로 거리를 다시 잡는다(좌우 마진 유지).
    // 그 사이 사용자가 궤도를 돌렸으면 _standard 가 꺼져 있으므로 시점을 안 건드리고
    // 렌즈 시프트만 새 픽셀 크기로 다시 건다.
    if (this._standard) this.standardView();
    else this._applyViewOffset();
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
