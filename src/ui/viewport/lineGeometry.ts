/** @layer ui/viewport — vertex-data builders shared by the 2D and 3D line overlays. */

import * as THREE from 'three';
import type { Vec2 } from '@core/model/types';

/** Flat xyz list for `points` lying on the plane `z`. */
export function flattenPoints(points: ReadonlyArray<Vec2>, z = 0): number[] {
  return points.flatMap(([x, y]) => [x, y, z]);
}

/** BufferGeometry whose `position` attribute is the given flat xyz list. */
export function positionsGeometry(positions: ArrayLike<number>): THREE.BufferGeometry {
  return new THREE.BufferGeometry().setAttribute(
    'position',
    new THREE.BufferAttribute(Float32Array.from(positions), 3),
  );
}

/** LineSegments geometry (z = 0): every consecutive vertex pair is one segment. */
export function segmentsGeometry(vertices: ReadonlyArray<Vec2>): THREE.BufferGeometry {
  return positionsGeometry(flattenPoints(vertices));
}

/** Segment vertex pairs tracing `points` as an open chain. */
export function chainSegments(points: ReadonlyArray<Vec2>): Vec2[] {
  return points.flatMap((point, index) => {
    const next = points[index + 1];
    return next ? [point, next] : [];
  });
}

/** Segment vertex pairs tracing `points` as a closed loop. */
export function loopSegments(points: ReadonlyArray<Vec2>): Vec2[] {
  const [first] = points;
  return chainSegments(first ? [...points, first] : points);
}

/** Segment vertex pairs approximating an axis-aligned ellipse outline. */
export function ellipseOutline(
  cx: number,
  cy: number,
  radiusX: number,
  radiusY: number,
  segments: number,
): Vec2[] {
  const vertex = (index: number): Vec2 => {
    const angle = (index / segments) * Math.PI * 2;
    return [cx + radiusX * Math.cos(angle), cy + radiusY * Math.sin(angle)];
  };
  return Array.from({ length: segments }, (_, index) => [vertex(index), vertex(index + 1)]).flat();
}
