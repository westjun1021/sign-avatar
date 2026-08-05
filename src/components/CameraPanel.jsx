import { forwardRef } from 'react';

// 웹캠 원본 미리보기 (거울 반전). 아바타가 잘 따라오는지 대조용.
const CameraPanel = forwardRef(function CameraPanel({ mirror }, videoRef) {
  return (
    <div className="camera-panel">
      <video
        ref={videoRef}
        className="camera-video"
        style={{ transform: mirror ? 'scaleX(-1)' : 'none' }}
        playsInline
        muted
      />
      <span className="camera-tag">웹캠 원본</span>
    </div>
  );
});

export default CameraPanel;
