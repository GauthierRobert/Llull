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

/** `points` with the first point repeated at the end (a closed chain); empty stays empty. */
export function closeLoop<P>(points: ReadonlyArray<P>): P[] {
  return [...points, ...points.slice(0, 1)];
}

/** Segment vertex pairs tracing `points` as a closed loop. */
export function loopSegments(points: ReadonlyArray<Vec2>): Vec2[] {
  return chainSegments(closeLoop(points));
}

/** Corners of a `width` x `height` rectangle with its lower-left at the origin (CCW). */
export function rectangleCorners(width: number, height: number): Vec2[] {
  return [
    [0, 0],
    [width, 0],
    [width, height],
    [0, height],
  ];
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

/**
 * Geometry for `vertices` (on plane `z`) stored relative to the first vertex, plus the anchor to
 * apply as the object's position — float32-safe far from the origin (see `rebaseToAnchor`).
 */
export function anchoredGeometry(
  vertices: ReadonlyArray<Vec2>,
  z = 0,
): { geometry: THREE.BufferGeometry; anchor: [number, number, number] } {
  const { anchor, local } = rebaseToAnchor(flattenPoints(vertices, z));
  return { geometry: positionsGeometry(local), anchor };
}

/**
 * Vertices re-expressed relative to the first vertex's XY. GPU vertex attributes are float32
 * (about 0.06 units of resolution at 1e6); the anchor is added back on the CPU in float64 through
 * the object transform, so geometry far from the origin keeps its full precision.
 *
 * @pure
 * @invariant local[i] + anchor reproduces positions[i] (x, y); z is unchanged
 */
export function rebaseToAnchor(positions: ReadonlyArray<number>): {
  anchor: [number, number, number];
  local: number[];
} {
  const anchorX = positions[0] ?? 0;
  const anchorY = positions[1] ?? 0;
  const local = positions.map((value, index) =>
    index % 3 === 0 ? value - anchorX : index % 3 === 1 ? value - anchorY : value,
  );
  return { anchor: [anchorX, anchorY, 0], local };
}
