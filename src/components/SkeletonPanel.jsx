import { forwardRef } from 'react';

// 스켈레톤(뼈대·관절·얼굴점) 디버그 뷰포트.
// 실제 렌더링은 SkeletonAvatar 가 이 div 안에 canvas 를 붙여서 담당한다.
const SkeletonPanel = forwardRef(function SkeletonPanel(props, containerRef) {
  return (
    <div className="skeleton-panel">
      <div className="skeleton-view" ref={containerRef} />
      <span className="camera-tag">스켈레톤</span>
    </div>
  );
});

export default SkeletonPanel;
