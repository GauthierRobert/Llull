// Wireframe octahedron at the active translate-drag snap (color = type), in RENDER space; invalidates on mount, move
// and unmount so the demand frameloop shows/hides it promptly.

import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useDisposable } from '../useDisposable';
import { SNAP_COLORS_3D } from '../viewportPalette';
import type { Snap3DType } from './snap3d';

const INDICATOR_SIZE = 0.18;

interface SnapIndicator3DProps {
  /** World position minus renderOrigin. */
  position: readonly [number, number, number];
  /** Not rendered for 'none'. */
  snapType: Snap3DType;
}

export function SnapIndicator3D({ position, snapType }: SnapIndicator3DProps): React.ReactElement | null {
  const invalidate = useThree((s) => s.invalidate);

  const geometry = useDisposable(() => new THREE.OctahedronGeometry(INDICATOR_SIZE, 0), []);
  const material = useDisposable(
    () =>
      new THREE.MeshBasicMaterial({ color: SNAP_COLORS_3D[snapType], wireframe: true, depthTest: false, transparent: true, opacity: 0.9 }),
    [snapType],
  );

  useEffect(() => {
    invalidate();
    return invalidate;
  }, [position, invalidate]);

  if (snapType === 'none') return null;

  return <mesh geometry={geometry} material={material} position={[position[0], position[1], position[2]]} renderOrder={999} />;
}
