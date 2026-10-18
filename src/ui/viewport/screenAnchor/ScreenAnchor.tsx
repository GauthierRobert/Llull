// In-Canvas half of a DOM label pinned to a world position (replaces drei <Html>, which mounts a nested React root and
// triggers "synchronously unmount a root while React was already rendering"). Renders nothing visible: it projects its
// origin each frame and hands the label to <ScreenAnchorOverlay> beside the Canvas.

import { useLayoutEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { forgetAnchor, placeAnchor, useScreenAnchorStore } from './screenAnchorStore';
import { ndcToScreenPoint } from './screenPoint';

interface ScreenAnchorProps {
  id: string;
  position: readonly [number, number, number];
  /** Centre the label on the point instead of hanging it from its top-left corner. */
  center?: boolean;
  zIndex?: number;
  className?: string;
  children: React.ReactNode;
}

const scratch = new THREE.Vector3();

export function ScreenAnchor({
  id,
  position,
  center = false,
  zIndex = 10,
  className = '',
  children,
}: ScreenAnchorProps): React.ReactElement {
  const groupRef = useRef<THREE.Group>(null);
  const invalidate = useThree((s) => s.invalidate);
  const upsert = useScreenAnchorStore((s) => s.upsert);
  const remove = useScreenAnchorStore((s) => s.remove);

  // Every render: the label content (callbacks, text) must stay current.
  useLayoutEffect(() => {
    upsert({ id, content: children, centered: center, zIndex, className });
    invalidate();
  });
  useLayoutEffect(
    () => () => {
      remove(id);
      forgetAnchor(id);
    },
    [id, remove],
  );

  useFrame(({ camera, size }) => {
    const group = groupRef.current;
    if (group === null) return;
    camera.updateMatrixWorld();
    group.getWorldPosition(scratch).project(camera);
    placeAnchor(id, ndcToScreenPoint(scratch.x, scratch.y, scratch.z, size.width, size.height), center);
  });

  return <group ref={groupRef} position={[position[0], position[1], position[2]]} />;
}
