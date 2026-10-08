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
import { positionsGeometry, rebaseToAnchor } from '../../lineGeometry';

interface ShapeLineProps {
  /** Flat xyz vertices; a line strip, or independent segment pairs when `segments` is set. */
  positions: number[];
  segments?: boolean;
  linewidth?: number;
  position: Vec3;
  /** Entity rotation; only the Z component applies in the top-down 2D view. */
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
  // Vertices are stored relative to an anchor (float32 precision far from the origin); the anchor
  // is applied through the object transform, which three.js composes in float64.
  const rebased = useMemo(() => rebaseToAnchor(positions), [positions]);
  const geometry = useMemo(() => positionsGeometry(rebased.local), [rebased]);
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

  return (
    <group position={position} rotation={[0, 0, rotation?.[2] ?? 0]}>
      <primitive object={object} position={rebased.anchor} />
    </group>
  );
}
