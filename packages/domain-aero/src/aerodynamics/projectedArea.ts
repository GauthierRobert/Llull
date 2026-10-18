/**
 * Frontal (projected) area of triangles seen along a flow direction, by scan-line rasterisation of the projected triangles on a grid
 * (union of the silhouettes, overlaps counted once), plus wetted (surface) area and the body length along the flow.
 */

import type { Vec3 } from '@core/model/types';
import type { Triangle } from '@core/geometry/triangles';
import { tupleExtent } from '@lib/extent';

export interface ProjectedArea {
  readonly area: number;
  /** ± half the area of the boundary cells (silhouette resolution). */
  readonly uncertainty: number;
  readonly wettedArea: number;
  /** Extent along the flow direction. */
  readonly length: number;
  /** Extents of the silhouette across the flow [width, height]. */
  readonly extents: readonly [number, number];
  readonly cellSize: number;
  readonly cells: number;
}

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** Orthonormal (u, v) spanning the plane normal to the unit `direction`. */
function planeBasis(direction: Vec3): readonly [Vec3, Vec3] {
  const helper: Vec3 = Math.abs(direction[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = cross(helper, direction);
  const lu = Math.hypot(...u);
  const unit: Vec3 = [u[0] / lu, u[1] / lu, u[2] / lu];
  return [unit, cross(direction, unit)];
}

/**
 * @invariant `direction` is normalised here; resolution = cells along the larger silhouette extent (area error ~ perimeter × cell / 2)
 * @failure no triangles -> null
 */
export function projectedArea(triangles: readonly Triangle[], rawDirection: Vec3, resolution: number): ProjectedArea | null {
  if (triangles.length === 0) return null;
  const norm = Math.hypot(...rawDirection);
  const direction: Vec3 = [rawDirection[0] / norm, rawDirection[1] / norm, rawDirection[2] / norm];
  const [u, v] = planeBasis(direction);
  const flat = (point: Vec3): readonly [number, number] => [dot(point, u), dot(point, v)];
  const projected = triangles.map(([p0, p1, p2]) => [flat(p0), flat(p1), flat(p2)] as const);
  const box = tupleExtent(
    projected.flatMap((triangle) => triangle.flatMap(([pu, pv]) => [pu, pv, 0])),
    3,
  );
  const along = tupleExtent(
    triangles.flatMap((triangle) => triangle.map((point) => dot(point, direction))),
    1,
  );
  const [uMin, vMin] = box.min as [number, number];
  const [uMax, vMax] = box.max as [number, number];
  const wettedArea = triangles.reduce((sum, [a, b, c]) => sum + Math.hypot(...cross(sub(b, a), sub(c, a))) / 2, 0);
  const span = Math.max(uMax - uMin, vMax - vMin);
  const extents = [uMax - uMin, vMax - vMin] as const;
  const length = (along.max[0] as number) - (along.min[0] as number);
  if (!(span > 0)) return { area: 0, uncertainty: 0, wettedArea, length, extents, cellSize: 0, cells: 0 };
  const cell = span / resolution;
  const columns = Math.max(1, Math.ceil((uMax - uMin) / cell));
  const rows = Math.max(1, Math.ceil((vMax - vMin) / cell));
  const filled = new Uint8Array(columns * rows);
  for (const triangle of projected) {
    const [a, b, c] = triangle;
    const denominator = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (Math.abs(denominator) < 1e-300) continue;
    const r0 = Math.max(0, Math.floor((Math.min(a[1], b[1], c[1]) - vMin) / cell));
    const r1 = Math.min(rows - 1, Math.floor((Math.max(a[1], b[1], c[1]) - vMin) / cell));
    const c0 = Math.max(0, Math.floor((Math.min(a[0], b[0], c[0]) - uMin) / cell));
    const c1 = Math.min(columns - 1, Math.floor((Math.max(a[0], b[0], c[0]) - uMin) / cell));
    for (let row = r0; row <= r1; row += 1) {
      const pv = vMin + (row + 0.5) * cell;
      for (let column = c0; column <= c1; column += 1) {
        const pu = uMin + (column + 0.5) * cell;
        const w1 = ((b[1] - c[1]) * (pu - c[0]) + (c[0] - b[0]) * (pv - c[1])) / denominator;
        const w2 = ((c[1] - a[1]) * (pu - c[0]) + (a[0] - c[0]) * (pv - c[1])) / denominator;
        if (w1 >= 0 && w2 >= 0 && w1 + w2 <= 1) filled[row * columns + column] = 1;
      }
    }
  }
  let count = 0;
  let boundary = 0;
  const at = (row: number, column: number): number =>
    row < 0 || column < 0 || row >= rows || column >= columns ? 0 : (filled[row * columns + column] as number);
  for (let row = 0; row < rows; row += 1)
    for (let column = 0; column < columns; column += 1) {
      if (at(row, column) === 0) continue;
      count += 1;
      if (at(row - 1, column) === 0 || at(row + 1, column) === 0 || at(row, column - 1) === 0 || at(row, column + 1) === 0) boundary += 1;
    }
  return {
    area: count * cell * cell,
    uncertainty: (boundary * cell * cell) / 2,
    wettedArea,
    length,
    extents,
    cellSize: cell,
    cells: count,
  };
}
