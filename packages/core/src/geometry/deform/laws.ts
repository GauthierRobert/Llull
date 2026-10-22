/**
 * Deformation laws (01 DEF §5.2, Barr 1984): maps from local frame coordinates q = (x, y, z) to q' and their Jacobian determinants, closed form.
 * @invariant twist det J = 1; taper det J = s² (s when flat); stretch det J = factor inside the region; bend det J = (R − y) / R inside the
 *   region and 1 elsewhere (rigid continuation past the end); affine det J = det M
 */

import type { DeformLaw, DeformRegion } from '../../model/deform';
import type { ShapeRecipe } from '../../model/types';
import type { Vec3 } from '../../model/vectors';
import { type LocalFrame, resolveFrame, toLocal, toWorld } from './frame';
import { rampAt } from './region';

/** The `deform` member of `ShapeRecipe`. */
export type DeformNode = Extract<ShapeRecipe, { op: 'deform' }>;

type Rows = readonly [Vec3, Vec3, Vec3];

const apply = (rows: Rows, q: Vec3): Vec3 => [
  rows[0][0] * q[0] + rows[0][1] * q[1] + rows[0][2] * q[2],
  rows[1][0] * q[0] + rows[1][1] * q[1] + rows[1][2] * q[2],
  rows[2][0] * q[0] + rows[2][1] * q[1] + rows[2][2] * q[2],
];

export function determinant(rows: Rows): number {
  const [a, b, c] = rows;
  return a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
}

/** Bend of the region about the axis parallel to local x through (y = R, z = start), rigid past the end; `symmetric` keeps the region middle fixed. */
function bendMap(radius: number, symmetric: boolean, region: DeformRegion, [x, y, z]: Vec3): Vec3 {
  const { start, end } = region;
  const clamped = Math.min(Math.max(z, start), end);
  const theta = (clamped - start) / radius;
  const over = z < start ? z - start : z - clamped;
  const [sin, cos] = [Math.sin(theta), Math.cos(theta)];
  const dy = cos * (y - radius) + sin * over;
  const dz = -sin * (y - radius) + cos * over;
  if (!symmetric) return [x, radius + dy, start + dz];
  const half = (end - start) / (2 * radius);
  const [hs, hc] = [Math.sin(half), Math.cos(half)];
  return [x, radius + hc * dy - hs * dz, start + hs * dy + hc * dz + (end - start) / 2];
}

/** The law applied to local coordinates `q`; `region` is ignored by the affine law. */
export function mapLocal(law: DeformLaw, region: DeformRegion, q: Vec3): Vec3 {
  const [x, y, z] = q;
  switch (law.kind) {
    case 'affine': {
      const image = apply(law.matrix, q);
      return [image[0] + law.translation[0], image[1] + law.translation[1], image[2] + law.translation[2]];
    }
    case 'twist': {
      const theta = law.angleRad * rampAt(region, z).w;
      const [sin, cos] = [Math.sin(theta), Math.cos(theta)];
      return [x * cos - y * sin, x * sin + y * cos, z];
    }
    case 'taper': {
      const s = 1 + (law.scaleEnd - 1) * rampAt(region, z).w;
      return [s * x, law.flat ? y : s * y, z];
    }
    case 'stretch': {
      if (z <= region.start) return q;
      if (z <= region.end) return [x, y, region.start + law.factor * (z - region.start)];
      return [x, y, z + (law.factor - 1) * (region.end - region.start)];
    }
    case 'bend':
      return bendMap(law.radius, law.symmetric, region, q);
  }
}

/** det J of the law at local coordinates `q`. */
export function localDeterminant(law: DeformLaw, region: DeformRegion, q: Vec3): number {
  switch (law.kind) {
    case 'affine':
      return determinant(law.matrix);
    case 'twist':
      return 1;
    case 'taper': {
      const s = 1 + (law.scaleEnd - 1) * rampAt(region, q[2]).w;
      return law.flat ? s : s * s;
    }
    case 'stretch':
      return q[2] > region.start && q[2] <= region.end ? law.factor : 1;
    case 'bend':
      return q[2] > region.start && q[2] <= region.end ? (law.radius - q[1]) / law.radius : 1;
  }
}

/** Region used by laws that ignore it (affine): a unit placeholder. */
const NO_REGION: DeformRegion = { start: 0, end: 1, falloff: 'none', beyond: 'rigid' };

export interface Warp {
  readonly frame: LocalFrame;
  /** World point -> deformed world point. */
  readonly point: (p: Vec3) => Vec3;
  /** det J at a world point. */
  readonly determinant: (p: Vec3) => number;
}

/**
 * The world-space map of a `deform` node.
 * @failure degenerate frame -> null
 */
export function warpOf(node: Pick<DeformNode, 'law' | 'frame' | 'region'>): Warp | null {
  const frame = resolveFrame(node.frame);
  if (frame === null) return null;
  const region = node.region ?? NO_REGION;
  return {
    frame,
    point: (p) => toWorld(frame, mapLocal(node.law, region, toLocal(frame, p))),
    determinant: (p) => localDeterminant(node.law, region, toLocal(frame, p)),
  };
}

/** The affine law of `node` as a world map p' = M p + t (rows), or null for another law / a degenerate frame. */
export function affineWorld(node: Pick<DeformNode, 'law' | 'frame'>): { matrix: Rows; translation: Vec3 } | null {
  const { law } = node;
  if (law.kind !== 'affine') return null;
  const frame = resolveFrame(node.frame);
  if (frame === null) return null;
  const { x, y, z } = frame;
  const basis: Rows = [
    [x[0], y[0], z[0]],
    [x[1], y[1], z[1]],
    [x[2], y[2], z[2]],
  ];
  const world = (column: Vec3): Vec3 => {
    const local: Vec3 = [
      x[0] * column[0] + x[1] * column[1] + x[2] * column[2],
      y[0] * column[0] + y[1] * column[1] + y[2] * column[2],
      z[0] * column[0] + z[1] * column[1] + z[2] * column[2],
    ];
    return apply(basis, apply(law.matrix, local));
  };
  const columns = [world([1, 0, 0]), world([0, 1, 0]), world([0, 0, 1])] as const;
  const matrix: Rows = [
    [columns[0][0], columns[1][0], columns[2][0]],
    [columns[0][1], columns[1][1], columns[2][1]],
    [columns[0][2], columns[1][2], columns[2][2]],
  ];
  const shifted = apply(matrix, frame.origin);
  const own = apply(basis, law.translation);
  return {
    matrix,
    translation: [frame.origin[0] - shifted[0] + own[0], frame.origin[1] - shifted[1] + own[1], frame.origin[2] - shifted[2] + own[2]],
  };
}
