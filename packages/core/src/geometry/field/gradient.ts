/**
 * Forward-mode gradient of a FieldProgram (value + d/dx, d/dy, d/dz per register). `mesh_sdf` and `strut_set` differentiate by central
 * differences of the operand (their closed-form gradient is the unit direction to the closest point, which the difference reproduces to ~1e-6).
 * @invariant the value channel equals `evaluateAt`
 */

import type { Vec3 } from '../../model/types';
import { OPS, type PreparedProgram, SLOTS, chamferMin, smoothMinExp, smoothMinQuad } from './interpret';

export interface Dual {
  readonly value: number;
  readonly gradient: Vec3;
}

const STEP = 1e-6;

/** Gradient-carrying evaluation at (x, y, z). */
export function evaluateWithGradient(prepared: PreparedProgram, x: number, y: number, z: number): Dual {
  const { opcodes, operands, program } = prepared;
  const count = opcodes.length;
  const v = new Float64Array(count);
  const gx = new Float64Array(count);
  const gy = new Float64Array(count);
  const gz = new Float64Array(count);
  const set = (i: number, value: number, dx: number, dy: number, dz: number): void => {
    v[i] = value;
    gx[i] = dx;
    gy[i] = dy;
    gz[i] = dz;
  };
  for (let i = 0; i < count; i += 1) {
    const base = i * SLOTS;
    const [ia, ib, ic] = [operands[base] as number, operands[base + 1] as number, operands[base + 2] as number];
    const [a, b, c] = [v[ia] as number, v[ib] as number, v[ic] as number];
    const [ax, ay, az] = [gx[ia] as number, gy[ia] as number, gz[ia] as number];
    const [bx, by, bz] = [gx[ib] as number, gy[ib] as number, gz[ib] as number];
    const [cx, cy, cz] = [gx[ic] as number, gy[ic] as number, gz[ic] as number];
    switch (OPS[opcodes[i] as number]) {
      case 'const':
        set(i, program.constants[ia] as number, 0, 0, 0);
        break;
      case 'x':
        set(i, x, 1, 0, 0);
        break;
      case 'y':
        set(i, y, 0, 1, 0);
        break;
      case 'z':
        set(i, z, 0, 0, 1);
        break;
      case 'add':
        set(i, a + b, ax + bx, ay + by, az + bz);
        break;
      case 'sub':
        set(i, a - b, ax - bx, ay - by, az - bz);
        break;
      case 'mul':
        set(i, a * b, ax * b + a * bx, ay * b + a * by, az * b + a * bz);
        break;
      case 'div':
        set(i, a / b, (ax - (a / b) * bx) / b, (ay - (a / b) * by) / b, (az - (a / b) * bz) / b);
        break;
      case 'neg':
        set(i, -a, -ax, -ay, -az);
        break;
      case 'abs': {
        const s = a < 0 ? -1 : 1;
        set(i, Math.abs(a), s * ax, s * ay, s * az);
        break;
      }
      case 'min':
        if (a <= b) set(i, a, ax, ay, az);
        else set(i, b, bx, by, bz);
        break;
      case 'max':
        if (a >= b) set(i, a, ax, ay, az);
        else set(i, b, bx, by, bz);
        break;
      case 'sqrt': {
        const root = Math.sqrt(a);
        const scale = root > 0 ? 1 / (2 * root) : 0;
        set(i, root, ax * scale, ay * scale, az * scale);
        break;
      }
      case 'square':
        set(i, a * a, 2 * a * ax, 2 * a * ay, 2 * a * az);
        break;
      case 'sin':
        set(i, Math.sin(a), Math.cos(a) * ax, Math.cos(a) * ay, Math.cos(a) * az);
        break;
      case 'cos':
        set(i, Math.cos(a), -Math.sin(a) * ax, -Math.sin(a) * ay, -Math.sin(a) * az);
        break;
      case 'atan2': {
        const r2 = a * a + b * b;
        const k = r2 > 0 ? 1 / r2 : 0;
        set(i, Math.atan2(a, b), (b * ax - a * bx) * k, (b * ay - a * by) * k, (b * az - a * bz) * k);
        break;
      }
      case 'floor':
        set(i, Math.floor(a), 0, 0, 0);
        break;
      case 'fract':
        set(i, a - Math.floor(a), ax, ay, az);
        break;
      case 'clamp': {
        const [mid, mx, my, mz] = a >= b ? [a, ax, ay, az] : [b, bx, by, bz];
        if (mid <= c) set(i, mid, mx, my, mz);
        else set(i, c, cx, cy, cz);
        break;
      }
      case 'select':
        if (a < 0) set(i, b, bx, by, bz);
        else set(i, c, cx, cy, cz);
        break;
      case 'smin_quad': {
        const delta = Math.abs(a - b);
        const value = smoothMinQuad(a, b, c);
        if (!(c > 0) || delta >= c) {
          const [ex, ey, ez] = a <= b ? [ax, ay, az] : [bx, by, bz];
          set(i, value, ex, ey, ez);
          break;
        }
        const h = (c - delta) / c;
        const [wa, wb] = a <= b ? [1 - h / 2, h / 2] : [h / 2, 1 - h / 2];
        const dk = -(c * c - delta * delta) / (4 * c * c);
        set(i, value, wa * ax + wb * bx + dk * cx, wa * ay + wb * by + dk * cy, wa * az + wb * bz + dk * cz);
        break;
      }
      case 'smin_exp': {
        const value = smoothMinExp(a, b, c);
        if (!(c > 0)) {
          const [ex, ey, ez] = a <= b ? [ax, ay, az] : [bx, by, bz];
          set(i, value, ex, ey, ez);
          break;
        }
        const m = Math.min(a, b);
        const [ea, eb] = [Math.exp(-(a - m) / c), Math.exp(-(b - m) / c)];
        const [wa, wb] = [ea / (ea + eb), eb / (ea + eb)];
        const dk = (value - (wa * a + wb * b)) / c;
        set(i, value, wa * ax + wb * bx + dk * cx, wa * ay + wb * by + dk * cy, wa * az + wb * bz + dk * cz);
        break;
      }
      case 'chamfer_min': {
        const m = Math.min(a, b);
        const chamfer = (a + b - c) * Math.SQRT1_2;
        if (chamfer < m)
          set(i, chamferMin(a, b, c), (ax + bx - cx) * Math.SQRT1_2, (ay + by - cy) * Math.SQRT1_2, (az + bz - cz) * Math.SQRT1_2);
        else if (a <= b) set(i, m, ax, ay, az);
        else set(i, m, bx, by, bz);
        break;
      }
      case 'mesh_sdf':
      case 'strut_set': {
        const radiusRegister = operands[base + 4] as number;
        const sdf = (px: number, py: number, pz: number): number =>
          OPS[opcodes[i] as number] === 'mesh_sdf'
            ? (prepared.meshes[operands[base + 3] as number]?.distance(px, py, pz) ?? Infinity)
            : (prepared.struts[operands[base + 3] as number]?.distance(
                px,
                py,
                pz,
                radiusRegister >= 0 ? (v[radiusRegister] as number) : -1,
              ) ?? Infinity);
        const [gxi, gyi, gzi] = [
          (sdf(a + STEP, b, c) - sdf(a - STEP, b, c)) / (2 * STEP),
          (sdf(a, b + STEP, c) - sdf(a, b - STEP, c)) / (2 * STEP),
          (sdf(a, b, c + STEP) - sdf(a, b, c - STEP)) / (2 * STEP),
        ];
        set(i, sdf(a, b, c), gxi * ax + gyi * bx + gzi * cx, gxi * ay + gyi * by + gzi * cy, gxi * az + gyi * bz + gzi * cz);
        break;
      }
      case 'sample_field': {
        const field = prepared.sampled[operands[base + 3] as number];
        const sample = (px: number, py: number, pz: number): number => field?.value(px, py, pz) ?? NaN;
        const [gxi, gyi, gzi] = [
          (sample(a + STEP, b, c) - sample(a - STEP, b, c)) / (2 * STEP),
          (sample(a, b + STEP, c) - sample(a, b - STEP, c)) / (2 * STEP),
          (sample(a, b, c + STEP) - sample(a, b, c - STEP)) / (2 * STEP),
        ];
        set(i, sample(a, b, c), gxi * ax + gyi * bx + gzi * cx, gxi * ay + gyi * by + gzi * cy, gxi * az + gyi * bz + gzi * cz);
        break;
      }
      default:
        set(i, NaN, NaN, NaN, NaN);
    }
  }
  const out = program.output;
  return { value: v[out] as number, gradient: [gx[out] as number, gy[out] as number, gz[out] as number] };
}
