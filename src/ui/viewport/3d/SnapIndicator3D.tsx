/**
 * @layer ui/viewport/3d
 *
 * SnapIndicator3D — a small r3f marker rendered at the active snap point.
 *
 * Renders a diamond-shaped wireframe octahedron and a small sphere at the
 * snapped position during a translate gizmo drag. The colour encodes the snap
 * type:
 *   vertex      → gold  (#f5c842)
 *   edge        → cyan  (#42d4f5)
 *   face-center → green (#42f5a7)
 *   grid        → grey  (#8090a0)
 *
 * Visibility: only rendered when a snap point is active (type !== 'none').
 *
 * Position is passed in RENDER space (relative to the floating-origin group)
 * because this component lives inside the same <group position={groupOffset}>.
 *
 * Geometry and material are memoised; the mesh position is updated via a ref
 * + imperative set so r3f does not re-create the object on every frame (R9).
 * The indicator calls `invalidate()` on mount/unmount so demand-mode gets the
 * correct frames.
 */

import { useRef, useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { Snap3DType } from './snap3d';

// ---------------------------------------------------------------------------
// Type colour map
// ---------------------------------------------------------------------------

const SNAP_COLOUR: Record<Snap3DType, string> = {
  vertex:        '#f5c842',
  edge:          '#42d4f5',
  'face-center': '#42f5a7',
  grid:          '#8090a0',
  none:          '#ffffff',
};

const INDICATOR_SIZE = 0.18;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface SnapIndicator3DProps {
  /** Render-space position (world position minus renderOrigin). */
  position: readonly [number, number, number];
  /** Active snap type — component not rendered when 'none'. */
  snapType: Snap3DType;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SnapIndicator3D({ position, snapType }: SnapIndicator3DProps): React.ReactElement | null {
  const { invalidate } = useThree();
  const meshRef = useRef<THREE.Mesh>(null);

  const colour = SNAP_COLOUR[snapType];

  // Memoised geometry (octahedron) and line geometry (diamond wireframe).
  const geometry = useMemo(() => new THREE.OctahedronGeometry(INDICATOR_SIZE, 0), []);
  const material = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: colour,
        wireframe: true,
        depthTest: false,
        transparent: true,
        opacity: 0.9,
      }),
    [colour],
  );

  // Update mesh position imperatively when prop changes — avoids re-creating
  // the mesh every frame (R9 / react.md).
  useEffect(() => {
    const m = meshRef.current;
    if (!m) return;
    m.position.set(position[0], position[1], position[2]);
    invalidate();
  }, [position, invalidate]);

  // Invalidate on mount and unmount so demand-mode shows/hides correctly.
  useEffect(() => {
    invalidate();
    return () => invalidate();
  }, [invalidate]);

  // Dispose geometry on unmount (R9). Keyed separately from material because
  // geometry has no deps (stable for the lifetime of the component) while
  // material is recreated when `colour` changes. A shared cleanup would dispose
  // the still-live geometry when only the material changes.
  useEffect(() => () => geometry.dispose(), [geometry]);

  // Dispose material when colour changes (new material) or on unmount (R9).
  useEffect(() => () => material.dispose(), [material]);

  if (snapType === 'none') return null;

  return (
    <mesh
      ref={meshRef}
      geometry={geometry}
      material={material}
      position={[position[0], position[1], position[2]]}
      renderOrder={999}
    />
  );
}
