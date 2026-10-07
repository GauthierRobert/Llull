/**
 * @layer ui/viewport/2d
 *
 * Pure vertex builder for rendering many simple `line` entities as ONE LineSegments draw call.
 * World positions (entity rotation about Z + position applied) are stored relative to an anchor
 * so float32 vertex data stays precise far from the origin; per-line colour goes in a colour
 * attribute.
 */

import * as THREE from 'three';
import type { LineEntity } from '@core/model/types';
import { localToWorld2D } from './snapping/geometry';

interface LineBatch {
  /** Object position: world position of the first line's start (float64 on the CPU). */
  readonly anchor: [number, number, number];
  /** xyz per vertex (two vertices per line), relative to `anchor`. */
  readonly positions: number[];
  /** rgb per vertex, matching `positions`. */
  readonly colors: number[];
}

/**
 * @pure
 * @invariant positions.length === colors.length === 6 * lines.length
 */
export function buildLineBatch(lines: ReadonlyArray<LineEntity>): LineBatch {
  const first = lines[0];
  const [anchorX, anchorY] = first ? localToWorld2D(first, first.start[0], first.start[1]) : [0, 0];
  const anchorZ = first?.position[2] ?? 0;
  const positions: number[] = [];
  const colors: number[] = [];
  const color = new THREE.Color();
  for (const line of lines) {
    const [startX, startY] = localToWorld2D(line, line.start[0], line.start[1]);
    const [endX, endY] = localToWorld2D(line, line.end[0], line.end[1]);
    const z = line.position[2] - anchorZ;
    positions.push(startX - anchorX, startY - anchorY, z, endX - anchorX, endY - anchorY, z);
    color.set(line.color);
    colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
  }
  return { anchor: [anchorX, anchorY, anchorZ], positions, colors };
}
