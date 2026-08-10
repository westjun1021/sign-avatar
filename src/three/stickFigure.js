// 스틱맨(점 + 굵은 선) 렌더 헬퍼.
//
// SkeletonAvatar 가 쓰는 것과 같은 방식이다: three 기본 LineBasicMaterial 은
// WebGL 에서 linewidth 가 무시돼 항상 1px 이라, LineSegments2 + LineSegmentsGeometry
// + LineMaterial 로 실제 픽셀 두께를 낸다.
//
// SkeletonAvatar 안의 _makeLine/_fillLine 은 mirror·origin 같은 실시간 전용 규약이
// 섞여 있어서 그대로는 재사용이 안 된다. 여기에는 좌표계와 무관한 "버퍼를 받아
// 그린다"만 남겨 두고, FreeMoCap 재생 모드가 이걸 쓴다.
// (실시간 파이프라인은 건드리지 않으려고 SkeletonAvatar 는 그대로 뒀다.)

import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';

export const COLOR_BONE = 0x34d399;  // 뼈: 민트 (실시간 모드와 동일)
export const COLOR_JOINT = 0xfb7185; // 관절: 코랄
export const COLOR_HAND = 0x60a5fa;  // 손뼈: 하늘색 (몸통과 구분해 보기 쉽게)

// maxSegments 개의 선분을 그릴 수 있는 굵은 선 오브젝트.
// 위치 버퍼는 line.userData.positions 에 붙여서 매 프레임 재사용한다.
export function makeFatLine(maxSegments, width, height, { color = COLOR_BONE, linewidth = 3.5 } = {}) {
  const material = new LineMaterial({ color, linewidth, worldUnits: false, dashed: false });
  material.resolution.set(width, height);
  const line = new LineSegments2(new LineSegmentsGeometry(), material);
  line.frustumCulled = false;
  line.userData.positions = new Float32Array(maxSegments * 6); // 선분당 (x,y,z) * 2
  line.visible = false;
  return line;
}

// positions 앞쪽 floatCount 개만 실제로 그린다. 0 이면 숨긴다.
export function setFatLineData(line, floatCount) {
  if (floatCount === 0) {
    line.visible = false;
    return;
  }
  line.geometry.setPositions(line.userData.positions.subarray(0, floatCount));
  line.visible = true;
}

export function makePointCloud(maxPoints, color, size) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(maxPoints * 3), 3));
  geometry.setDrawRange(0, 0);
  const points = new THREE.Points(geometry, new THREE.PointsMaterial({ color, size, sizeAttenuation: true }));
  points.frustumCulled = false;
  points.visible = false;
  return points;
}

export function setPointCloudData(points, floatCount) {
  points.geometry.attributes.position.needsUpdate = true;
  points.geometry.setDrawRange(0, floatCount / 3);
  points.visible = floatCount > 0;
}
