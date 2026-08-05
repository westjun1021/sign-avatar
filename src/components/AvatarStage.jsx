import { useEffect, useRef } from 'react';
import { SkeletonAvatar } from '../three/SkeletonAvatar.js';

// VRM 아바타가 그려지는 메인 무대. landmarksRef / optionsRef 를 Three.js 로 넘겨
// React 리렌더 없이 매 프레임 갱신합니다.
// avatarRef: 부모에서 인스턴스 메서드(resetView 등)를 호출할 수 있게 노출하는 통로.
// debugContainerRef: 사이드에 따로 놓인 스켈레톤 디버그 창의 DOM. 같은 씬을
//   두 번째 렌더러로 그리기 때문에 여기서 함께 넘겨준다.
export default function AvatarStage({ landmarksRef, optionsRef, avatarRef, debugContainerRef }) {
  const containerRef = useRef(null);

  useEffect(() => {
    const avatar = new SkeletonAvatar(
      containerRef.current,
      debugContainerRef ? debugContainerRef.current : null,
      landmarksRef,
      optionsRef
    );
    if (avatarRef) avatarRef.current = avatar;
    return () => {
      if (avatarRef) avatarRef.current = null;
      avatar.dispose();
    };
  }, [landmarksRef, optionsRef, avatarRef, debugContainerRef]);

  return <div ref={containerRef} className="stage" />;
}
