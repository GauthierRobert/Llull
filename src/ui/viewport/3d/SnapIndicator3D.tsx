/**
 * @layer ui/viewport/3d
 *
 * SnapIndicator3D — a small wireframe octahedron marking the active snap point during a translate
 * gizmo drag. The colour encodes the snap type:
 *   vertex      → gold  (#f5c842)
 *   edge        → cyan  (#42d4f5)
 *   face-center → green (#42f5a7)
 *   grid        → grey  (#8090a0)
 *
 * Not rendered when `snapType` is 'none'. `position` is in RENDER space (relative to the
 * floating-origin group this component lives in). Geometry and material are disposed on unmount
 * (R9); invalidate() is called on mount, move and unmount so the demand frameloop shows and
 * hides the marker promptly.
 */

import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useDisposable } from '../useDisposable';
import type { Snap3DType } from './snap3d';

const SNAP_COLOUR: Record<Snap3DType, string> = {
  vertex: '#f5c842',
  edge: '#42d4f5',
  'face-center': '#42f5a7',
  grid: '#8090a0',
  none: '#ffffff',
};

const INDICATOR_SIZE = 0.18;

interface SnapIndicator3DProps {
  /** Render-space position (world position minus renderOrigin). */
  position: readonly [number, number, number];
  /** Active snap type — component not rendered when 'none'. */
  snapType: Snap3DType;
}

export function SnapIndicator3D({
  position,
  snapType,
}: SnapIndicator3DProps): React.ReactElement | null {
  const invalidate = useThree((s) => s.invalidate);

  const geometry = useDisposable(() => new THREE.OctahedronGeometry(INDICATOR_SIZE, 0), []);
  const material = useDisposable(
    () =>
      new THREE.MeshBasicMaterial({
        color: SNAP_COLOUR[snapType],
        wireframe: true,
        depthTest: false,
        transparent: true,
        opacity: 0.9,
      }),
    [snapType],
  );

  useEffect(() => {
    invalidate();
    return invalidate;
  }, [position, invalidate]);

  if (snapType === 'none') return null;

  return (
    <mesh
      geometry={geometry}
      material={material}
      position={[position[0], position[1], position[2]]}
      renderOrder={999}
    />
  );
}
