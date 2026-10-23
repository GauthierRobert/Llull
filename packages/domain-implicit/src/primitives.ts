/**
 * Exact signed distance functions of the primitives (05 IMP §5.2), emitted on the tape in the primitive's local frame (centred at the origin,
 * axis +Z; the cone has its base at z = 0 and its apex at z = height).
 * @invariant every shape is an exact SDF (|grad| = 1 almost everywhere), negative inside
 */

import type { FieldBuilder } from '@core/geometry/field/build';
import type { Vec3 } from '@core/model/types';
import type { Box, Frame } from './frame';
import type { PrimitiveNode } from './model';

const num = (dims: PrimitiveNode['dims'], key: string): number => {
  const value = dims[key];
  return typeof value === 'number' ? value : 0;
};

const vec = (dims: PrimitiveNode['dims'], key: string, fallback: Vec3): Vec3 => {
  const value = dims[key];
  return Array.isArray(value) ? (value as unknown as Vec3) : fallback;
};

/** Distance from point (u, v) to the segment (u1, v1)-(u2, v2), in registers. */
function segmentDistance(b: FieldBuilder, u: number, v: number, a: readonly [number, number], c: readonly [number, number]): number {
  const [ex, ey] = [c[0] - a[0], c[1] - a[1]];
  const lengthSq = ex * ex + ey * ey;
  const du = b.shift(u, -a[0]);
  const dv = b.shift(v, -a[1]);
  const along = b.scale(b.add(b.scale(du, ex), b.scale(dv, ey)), 1 / lengthSq);
  const t = b.op('clamp', along, b.constant(0), b.constant(1));
  return b.sqrt(b.add(b.square(b.sub(du, b.scale(t, ex))), b.square(b.sub(dv, b.scale(t, ey)))));
}

/** Register of the SDF of `node` at `frame` (already placed) and the local bounding box (null for an unbounded shape). */
export function primitiveField(b: FieldBuilder, node: PrimitiveNode, frame: Frame): { reg: number; box: Box | null } {
  const { x, y, z } = frame;
  const { dims } = node;
  switch (node.shape) {
    case 'sphere': {
      const r = num(dims, 'radius');
      return { reg: b.shift(b.length3(x, y, z), -r), box: { min: [-r, -r, -r], max: [r, r, r] } };
    }
    case 'box': {
      const size = vec(dims, 'size', [1, 1, 1]);
      const rounding = node.rounding ?? 0;
      const half = size.map((s) => s / 2 - rounding);
      const q = [
        b.shift(b.abs(x), -(half[0] as number)),
        b.shift(b.abs(y), -(half[1] as number)),
        b.shift(b.abs(z), -(half[2] as number)),
      ] as const;
      const zero = b.constant(0);
      const outside = b.length3(b.max(q[0], zero), b.max(q[1], zero), b.max(q[2], zero));
      const inside = b.min(b.max(b.max(q[0], q[1]), q[2]), zero);
      return {
        reg: b.shift(b.add(outside, inside), -rounding),
        box: { min: [-size[0] / 2, -size[1] / 2, -size[2] / 2], max: [size[0] / 2, size[1] / 2, size[2] / 2] },
      };
    }
    case 'cylinder': {
      const [r, h] = [num(dims, 'radius'), num(dims, 'height')];
      const d = [b.shift(b.sqrt(b.add(b.square(x), b.square(y))), -r), b.shift(b.abs(z), -h / 2)] as const;
      const zero = b.constant(0);
      const outside = b.sqrt(b.add(b.square(b.max(d[0], zero)), b.square(b.max(d[1], zero))));
      return { reg: b.add(b.min(b.max(d[0], d[1]), zero), outside), box: { min: [-r, -r, -h / 2], max: [r, r, h / 2] } };
    }
    case 'capsule': {
      const [r, h] = [num(dims, 'radius'), num(dims, 'height')];
      const t = b.op('clamp', z, b.constant(-h / 2), b.constant(h / 2));
      return { reg: b.shift(b.length3(x, y, b.sub(z, t)), -r), box: { min: [-r, -r, -h / 2 - r], max: [r, r, h / 2 + r] } };
    }
    case 'torus': {
      const [big, small] = [num(dims, 'ringRadius'), num(dims, 'tubeRadius')];
      const ring = b.shift(b.sqrt(b.add(b.square(x), b.square(y))), -big);
      const reach = big + small;
      return {
        reg: b.shift(b.sqrt(b.add(b.square(ring), b.square(z))), -small),
        box: { min: [-reach, -reach, -small], max: [reach, reach, small] },
      };
    }
    case 'cone': {
      const [r, h] = [num(dims, 'radius'), num(dims, 'height')];
      const rho = b.sqrt(b.add(b.square(x), b.square(y)));
      const base = segmentDistance(b, rho, z, [0, 0], [r, 0]);
      const slant = segmentDistance(b, rho, z, [r, 0], [0, h]);
      const distance = b.min(base, slant);
      const norm = Math.hypot(h, r);
      const side = b.scale(b.shift(b.add(b.scale(rho, h), b.scale(z, r)), -r * h), 1 / norm);
      const inside = b.max(b.neg(z), side);
      return { reg: b.op('select', inside, b.neg(distance), distance), box: { min: [-r, -r, 0], max: [r, r, h] } };
    }
    case 'plane': {
      const n = vec(dims, 'normal', [0, 0, 1]);
      const length = Math.hypot(...n);
      const dot = b.add(b.add(b.scale(x, n[0] / length), b.scale(y, n[1] / length)), b.scale(z, n[2] / length));
      return { reg: b.shift(dot, -num(dims, 'offset')), box: null };
    }
  }
}
