/**
 * @layer ui/viewport/2d
 *
 * `ShapeLine` is the shared body of every 2D curve renderer: each renderer only supplies the flat
 * xyz vertex list.
 */

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { Vec3 } from '@core/model/types';
import { SELECTION_COLOR } from '../../viewportPalette';
import { positionsGeometry } from '../../lineGeometry';

interface ShapeLineProps {
  /** Flat xyz vertices; a line strip, or independent segment pairs when `segments` is set. */
  positions: number[];
  segments?: boolean;
  linewidth?: number;
  position: Vec3;
  color: string;
  selected: boolean;
}

export function ShapeLine({
  positions,
  segments = false,
  linewidth = 1,
  position,
  color,
  selected,
}: ShapeLineProps): React.ReactElement {
  const geometry = useMemo(() => positionsGeometry(positions), [positions]);
  const material = useMemo(
    () => new THREE.LineBasicMaterial({ color: selected ? SELECTION_COLOR : color, linewidth }),
    [color, selected, linewidth],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);
  useEffect(() => () => material.dispose(), [material]);

  // Wrapper only: geometry and material are owned (and disposed) above.
  const object = useMemo(
    () =>
      segments ? new THREE.LineSegments(geometry, material) : new THREE.Line(geometry, material),
    [geometry, material, segments],
  );

  return <primitive object={object} position={position} />;
}
