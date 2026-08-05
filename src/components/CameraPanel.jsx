import { forwardRef } from 'react';

// 입력 영상 미리보기. 웹캠 스트림과 업로드한 파일 재생을 모두 표시한다.
// 아바타가 잘 따라오는지 대조용.
const CameraPanel = forwardRef(function CameraPanel({ mirror, sourceType }, videoRef) {
  const isFile = sourceType === 'file';
  return (
    <div className="camera-panel">
      <video
        ref={videoRef}
        className="camera-video"
        style={{ transform: mirror ? 'scaleX(-1)' : 'none' }}
        // 파일 모드에선 재생/일시정지/탐색이 필요하다 (브라우저 기본 컨트롤)
        controls={isFile}
        playsInline
        muted
      />
      <span className="camera-tag">{isFile ? '영상 파일' : '웹캠 원본'}</span>
    </div>
  );
});

export default CameraPanel;
