import { useEffect, useRef } from 'react';
import { FreeMocapPlayer } from '../freemocap/FreeMocapPlayer.js';

// FreeMoCap 재생 무대. AvatarStage 와 같은 구조지만 씬/렌더러가 완전히 별개다.
// (모드 전환 시 한쪽만 마운트되므로 WebGL 컨텍스트도 하나만 산다)
export default function FreeMocapStage({ clipRef, stateRef, playerRef }) {
  const containerRef = useRef(null);

  useEffect(() => {
    const player = new FreeMocapPlayer(containerRef.current, clipRef, stateRef);
    if (playerRef) playerRef.current = player;
    return () => {
      if (playerRef) playerRef.current = null;
      player.dispose();
    };
  }, [clipRef, stateRef, playerRef]);

  return <div ref={containerRef} className="stage" />;
}
