/**
 * @layer ui/viewport/2d
 *
 * `ShapeLine` is the shared body of every 2D curve renderer: each renderer only supplies the flat
 * xyz vertex list.
 */

import { useMemo } from 'react';
import * as THREE from 'three';
import type { Vec3 } from '@core/model/types';
import { SELECTION_COLOR } from '../../viewportPalette';
import { positionsGeometry } from '../../lineGeometry';
import { PlacedLineObject } from './PlacedLineObject';

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
  const object = useMemo(() => {
    const geometry = positionsGeometry(positions);
    const material = new THREE.LineBasicMaterial({
      color: selected ? SELECTION_COLOR : color,
      linewidth,
    });
    return segments
      ? new THREE.LineSegments(geometry, material)
      : new THREE.Line(geometry, material);
  }, [positions, segments, linewidth, color, selected]);

  return <PlacedLineObject object={object} position={position} />;
}
