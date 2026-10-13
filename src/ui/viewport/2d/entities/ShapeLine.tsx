// Shared body of every 2D curve renderer, which supplies only the flat xyz vertices.

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { Vec3 } from '@core/model/types';
import { SELECTION_COLOR } from '../../viewportPalette';
import { positionsGeometry, rebaseToAnchor } from '../../lineGeometry';

interface ShapeLineProps {
  /** Line strip, or independent pairs when `segments` is set. */
  positions: number[];
  segments?: boolean;
  linewidth?: number;
  position: Vec3;
  /** Only Z applies in the top-down view. */
  rotation?: Vec3;
  color: string;
  selected: boolean;
}

export function ShapeLine({
  positions,
  segments = false,
  linewidth = 1,
  position,
  rotation,
  color,
  selected,
}: ShapeLineProps): React.ReactElement {
  // Float32-safe: vertices relative to an anchor, re-added by the (float64) object transform.
  const rebased = useMemo(() => rebaseToAnchor(positions), [positions]);
  const geometry = useMemo(() => positionsGeometry(rebased.local), [rebased]);
  const material = useMemo(
    () => new THREE.LineBasicMaterial({ color: selected ? SELECTION_COLOR : color, linewidth }),
    [color, selected, linewidth],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);

  // Wrapper only: geometry and material are owned and disposed above.
  const object = useMemo(
    () => (segments ? new THREE.LineSegments(geometry, material) : new THREE.Line(geometry, material)),
    [geometry, material, segments],
  );

  return (
    <group position={position} rotation={[0, 0, rotation?.[2] ?? 0]}>
      <primitive object={object} position={rebased.anchor} />
    </group>
  );
}
