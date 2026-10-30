/**
 * Scalar fields (05 IMP FR-IMP-16): coordinate, distance, ramp, mix, arithmetic and seeded noise as registers of the tape, with a guaranteed range
 * where one is known. A scalar is a function of the point in the frame it is compiled in; it is used as a graded law (thickness, radius, offset, blend
 * radius) of other nodes.
 * @invariant noise is a value noise on integer lattice hashes built from fract / mul / add only (no sin), so every engine gives identical values
 */

import type { FieldBuilder } from '@core/geometry/field/build';
import type { Vec3 } from '@core/model/types';
import type { Frame } from './frame';
import type { Law, ScalarNode } from './model';

export interface ScalarPart {
  readonly reg: number;
  /** Guaranteed lower / upper bound of the value (infinite when unknown). */
  readonly lo: number;
  readonly hi: number;
}

/** What the scalar compiler needs from the field compiler. */
export interface ScalarHost {
  readonly b: FieldBuilder;
  law(law: Law, frame: Frame): ScalarPart;
  /** Register of another field's value in `frame`. */
  fieldValue(id: string, frame: Frame): number;
  /** Register of the signed distance to the closed solid of an entity. */
  solidDistance(entityId: string, frame: Frame): number;
  /** Register of the sampled result data of a `topology_density` / `fea_result` node at the frame point, with the range of the data. */
  sampledInput(node: Extract<ScalarNode, { kind: 'topology_density' | 'fea_result' }>, frame: Frame): ScalarPart;
}

const UNBOUNDED = { lo: -Infinity, hi: Infinity } as const;

const smoothstep = (b: FieldBuilder, t: number): number => b.mul(b.mul(t, t), b.sub(b.constant(3), b.scale(t, 2)));

/** Hash of three integer-valued registers into [0, 1): Hoskins' "hash without sine", exact in IEEE arithmetic. */
function hash(b: FieldBuilder, seed: number, ix: number, iy: number, iz: number): number {
  const fract = (a: number): number => b.op('fract', a);
  const px = fract(b.scale(b.shift(ix, seed * 31.7), 0.1031));
  const py = fract(b.scale(b.shift(iy, seed * 17.3), 0.103));
  const pz = fract(b.scale(b.shift(iz, seed * 47.1), 0.0973));
  const d = b.add(b.add(b.mul(px, b.shift(py, 33.33)), b.mul(py, b.shift(pz, 33.33))), b.mul(pz, b.shift(px, 33.33)));
  const [qx, qy, qz] = [b.add(px, d), b.add(py, d), b.add(pz, d)];
  return fract(b.mul(b.add(qx, qy), qz));
}

/** Smooth value noise in [0, 1) at the frame point scaled by `frequency` (cells per document unit). */
function valueNoise(b: FieldBuilder, seed: number, frame: Frame, frequency: number): number {
  const q = [b.scale(frame.x, frequency), b.scale(frame.y, frequency), b.scale(frame.z, frequency)] as const;
  const cell = q.map((c) => b.op('floor', c)) as [number, number, number];
  const weight = [0, 1, 2].map((axis) => smoothstep(b, b.sub(q[axis as 0 | 1 | 2], cell[axis as 0 | 1 | 2]))) as [number, number, number];
  const corner = (dx: number, dy: number, dz: number): number =>
    hash(b, seed, b.shift(cell[0], dx), b.shift(cell[1], dy), b.shift(cell[2], dz));
  const lerp = (a: number, c: number, w: number): number => b.add(a, b.mul(b.sub(c, a), w));
  const x00 = lerp(corner(0, 0, 0), corner(1, 0, 0), weight[0]);
  const x10 = lerp(corner(0, 1, 0), corner(1, 1, 0), weight[0]);
  const x01 = lerp(corner(0, 0, 1), corner(1, 0, 1), weight[0]);
  const x11 = lerp(corner(0, 1, 1), corner(1, 1, 1), weight[0]);
  return lerp(lerp(x00, x10, weight[1]), lerp(x01, x11, weight[1]), weight[2]);
}

function arithmetic(
  b: FieldBuilder,
  operation: 'add' | 'subtract' | 'multiply' | 'divide' | 'min' | 'max',
  x: ScalarPart,
  y: ScalarPart,
): ScalarPart {
  switch (operation) {
    case 'add':
      return { reg: b.add(x.reg, y.reg), lo: x.lo + y.lo, hi: x.hi + y.hi };
    case 'subtract':
      return { reg: b.sub(x.reg, y.reg), lo: x.lo - y.hi, hi: x.hi - y.lo };
    case 'multiply': {
      const products = [x.lo * y.lo, x.lo * y.hi, x.hi * y.lo, x.hi * y.hi].map((p) => (Number.isNaN(p) ? 0 : p));
      return { reg: b.mul(x.reg, y.reg), lo: Math.min(...products), hi: Math.max(...products) };
    }
    case 'divide':
      return { reg: b.div(x.reg, y.reg), ...UNBOUNDED };
    case 'min':
      return { reg: b.min(x.reg, y.reg), lo: Math.min(x.lo, y.lo), hi: Math.min(x.hi, y.hi) };
    case 'max':
      return { reg: b.max(x.reg, y.reg), lo: Math.max(x.lo, y.lo), hi: Math.max(x.hi, y.hi) };
  }
}

const unit = (v: Vec3): Vec3 => {
  const length = Math.hypot(...v);
  return [v[0] / length, v[1] / length, v[2] / length];
};

/** Compile a scalar node in `frame`. */
export function compileScalar(host: ScalarHost, node: ScalarNode, frame: Frame): ScalarPart {
  const b = host.b;
  switch (node.kind) {
    case 'coordinate':
      return { reg: frame[node.axis], ...UNBOUNDED };
    case 'distance': {
      const to = node.to;
      if ('point' in to) {
        const d = [b.shift(frame.x, -to.point[0]), b.shift(frame.y, -to.point[1]), b.shift(frame.z, -to.point[2])] as const;
        return { reg: b.length3(d[0], d[1], d[2]), lo: 0, hi: Infinity };
      }
      if ('plane' in to) {
        const n = unit(to.plane.normal);
        const o = to.plane.origin;
        const dot = b.add(
          b.add(b.scale(b.shift(frame.x, -o[0]), n[0]), b.scale(b.shift(frame.y, -o[1]), n[1])),
          b.scale(b.shift(frame.z, -o[2]), n[2]),
        );
        return { reg: dot, ...UNBOUNDED };
      }
      if ('entityId' in to) return { reg: host.solidDistance(to.entityId, frame), ...UNBOUNDED };
      return { reg: host.fieldValue(to.field, frame), ...UNBOUNDED };
    }
    case 'ramp': {
      const input = host.law(node.input, frame);
      const t0 = b.scale(b.shift(input.reg, -node.inMin), 1 / (node.inMax - node.inMin));
      const t1 = node.clamp ? b.op('clamp', t0, b.constant(0), b.constant(1)) : t0;
      const eased = node.easing === 'smoothstep' ? smoothstep(b, t1) : t1;
      const reg = b.shift(b.scale(eased, node.outMax - node.outMin), node.outMin);
      return node.clamp ? { reg, lo: Math.min(node.outMin, node.outMax), hi: Math.max(node.outMin, node.outMax) } : { reg, ...UNBOUNDED };
    }
    case 'mix': {
      const [x, y, f] = [host.law(node.a, frame), host.law(node.b, frame), host.law(node.factor, frame)];
      const reg = b.add(b.mul(x.reg, b.sub(b.constant(1), f.reg)), b.mul(y.reg, f.reg));
      const bounded = f.lo >= 0 && f.hi <= 1;
      return bounded ? { reg, lo: Math.min(x.lo, y.lo), hi: Math.max(x.hi, y.hi) } : { reg, ...UNBOUNDED };
    }
    case 'arith':
      return arithmetic(b, node.operation, host.law(node.a, frame), host.law(node.b, frame));
    case 'topology_density':
    case 'fea_result':
      return host.sampledInput(node, frame);
    case 'noise': {
      let sum = b.constant(0);
      let amplitudes = 0;
      for (let octave = 0; octave < node.octaves; octave += 1) {
        const amplitude = 0.5 ** octave;
        sum = b.add(sum, b.scale(valueNoise(b, node.seed + octave, frame, node.frequency * 2 ** octave), amplitude));
        amplitudes += amplitude;
      }
      return { reg: b.scale(sum, 1 / amplitudes), lo: 0, hi: 1 };
    }
  }
}
