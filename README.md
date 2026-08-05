# Sign Avatar

웹캠으로 사람의 **상반신·양손·얼굴**을 추적해서, 3D 스켈레톤 아바타가 실시간으로 따라 하는 React 앱입니다. (뉴스 좌측 하단 수어 통역사 느낌)

MediaPipe Holistic 으로 좌표를 뽑고 → Three.js 로 3D 스켈레톤에 그립니다. 스켈레톤은 나중에 VRM 아바타로 교체할 수 있도록 Three.js 씬을 분리해 두었습니다.

## 실행 방법

```bash
npm install
npm run dev
```

브라우저에서 안내되는 주소(보통 http://localhost:5173)를 열고 **카메라 시작**을 누르세요.
카메라 권한은 `localhost` 또는 `https` 에서만 허용됩니다. 다른 기기(폰 등)로 테스트하려면 https 로 띄워야 해요.

첫 실행 시 MediaPipe 모델 파일(수 MB)을 CDN에서 받으므로 잠깐 로딩이 있습니다.

## 조작

- **상반신 / 양손 / 얼굴** 토글: 추적·표시 부위 선택
- **거울 모드**: 좌우 반전(통역사가 나를 마주보는 느낌). 기본 켜짐
- 무대를 **드래그**하면 아바타를 3D로 돌려볼 수 있어요 (z축이 실제로 들어가 있다는 걸 확인용)

## 구조

```
src/
  App.jsx                     전체 조립 (카메라/상태/레이아웃)
  mediapipe/
    useHolistic.js            카메라 + Holistic 초기화, 랜드마크를 ref 로 흘림
    landmarks.js              포즈 상반신 / 손 뼈대 연결 정의
  three/
    SkeletonAvatar.js         3D 스켈레톤 렌더 (← 나중에 VRM 로더로 교체할 지점)
  components/
    AvatarStage.jsx           Three.js 무대 마운트
    CameraPanel.jsx           웹캠 원본 미리보기
    Controls.jsx              부위 토글
```

성능을 위해 랜드마크는 React state 가 아니라 **ref** 로 Three.js 에 전달합니다(초당 30fps 리렌더 방지).

## 알려진 한계 (설계상)

- **z축(깊이)**: 단일 웹캠의 z는 측정값이 아니라 추정값이라 앞뒤 동작에서 흔들릴 수 있습니다. `smoothLandmarks` 로 완화했지만 원리적 한계입니다.
- **폐색**: 주먹처럼 손가락이 서로를 가리면 그 좌표는 모델의 추측이라 손모양이 틀어질 수 있습니다.
- 카메라와 **평행한 평면 동작**(손 펴고 정면)은 잘 따라옵니다. 정밀한 수어까지 가려면 다중 카메라 캡처 또는 인식→클립 재생 방식이 필요합니다.

## 다음 단계

1. **스무딩 강화**: One Euro 필터 + 본 길이/관절 각도 제한으로 팔꿈치 꺾임 제거
2. **VRM 교체**: `SkeletonAvatar.js` 를 `@pixiv/three-vrm` 로더로 바꾸고, 랜드마크 위치 → 본 회전(IK) 리타깃 추가
3. **녹화/재생**: 전문가 동작을 캡처해 클립으로 저장하는 오프라인 제작 모드

## 기술 스택

React 18 · Vite 5 · Three.js 0.160 · @mediapipe/holistic
