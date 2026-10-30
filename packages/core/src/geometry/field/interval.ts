/**
 * Interval evaluation of a FieldProgram over an axis-aligned box (05 IMP TR-IMP-01): [lo, hi] of the output for every point of the box.
 * @invariant sound: for every point p of the box, lo <= f(p) <= hi (non-finite results widen to +-Infinity); used to prune empty / full tiles
 * @invariant `mesh_sdf` / `strut_set` are 1-Lipschitz in the point, so their interval is value(centre) +- half the box diagonal (radius register: widened by its interval)
 */

import type { Vec3 } from '../../model/types';
import { OPS, type PreparedProgram, SLOTS } from './interpret';

export interface FieldBox {
  readonly min: Vec3;
  readonly max: Vec3;
}

const safeMul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : a * b);
const HALF_PI = Math.PI / 2;
const TWO_PI = 2 * Math.PI;

/** Range of sin over [lo, hi]. */
function sinRange(lo: number, hi: number): [number, number] {
  if (!(hi - lo < TWO_PI)) return [-1, 1];
  const containsMax = Math.floor((hi - HALF_PI) / TWO_PI) >= Math.ceil((lo - HALF_PI) / TWO_PI);
  const containsMin = Math.floor((hi + HALF_PI) / TWO_PI) >= Math.ceil((lo + HALF_PI) / TWO_PI);
  const ends = [Math.sin(lo), Math.sin(hi)];
  return [containsMin ? -1 : Math.min(...ends), containsMax ? 1 : Math.max(...ends)];
}

/** Interval [lo, hi] of the output over `box`. Tolerates non-finite inputs by answering [-Infinity, Infinity]. */
export function evaluateInterval(prepared: PreparedProgram, box: FieldBox): [number, number] {
  const { opcodes, operands, program } = prepared;
  const count = opcodes.length;
  const lo = new Float64Array(count);
  const hi = new Float64Array(count);
  const set = (i: number, low: number, high: number): void => {
    lo[i] = Number.isNaN(low) ? -Infinity : low;
    hi[i] = Number.isNaN(high) ? Infinity : high;
  };
  const halfDiagonal = (ix: number, iy: number, iz: number): number =>
    Math.hypot(
      ((hi[ix] as number) - (lo[ix] as number)) / 2,
      ((hi[iy] as number) - (lo[iy] as number)) / 2,
      ((hi[iz] as number) - (lo[iz] as number)) / 2,
    );
  const centre = (i: number): number => ((lo[i] as number) + (hi[i] as number)) / 2;
  for (let i = 0; i < count; i += 1) {
    const base = i * SLOTS;
    const [ia, ib, ic] = [operands[base] as number, operands[base + 1] as number, operands[base + 2] as number];
    const [al, ah, bl, bh, cl, ch] = [
      lo[ia] as number,
      hi[ia] as number,
      lo[ib] as number,
      hi[ib] as number,
      lo[ic] as number,
      hi[ic] as number,
    ];
    switch (OPS[opcodes[i] as number]) {
      case 'const': {
        const value = program.constants[ia] as number;
        set(i, value, value);
        break;
      }
      case 'x':
        set(i, box.min[0], box.max[0]);
        break;
      case 'y':
        set(i, box.min[1], box.max[1]);
        break;
      case 'z':
        set(i, box.min[2], box.max[2]);
        break;
      case 'add':
        set(i, al + bl, ah + bh);
        break;
      case 'sub':
        set(i, al - bh, ah - bl);
        break;
      case 'mul': {
        const products = [safeMul(al, bl), safeMul(al, bh), safeMul(ah, bl), safeMul(ah, bh)];
        set(i, Math.min(...products), Math.max(...products));
        break;
      }
      case 'div': {
        if (bl <= 0 && bh >= 0) {
          set(i, -Infinity, Infinity);
          break;
        }
        const products = [safeMul(al, 1 / bl), safeMul(al, 1 / bh), safeMul(ah, 1 / bl), safeMul(ah, 1 / bh)];
        set(i, Math.min(...products), Math.max(...products));
        break;
      }
      case 'neg':
        set(i, -ah, -al);
        break;
      case 'abs':
        set(i, al <= 0 && ah >= 0 ? 0 : Math.min(Math.abs(al), Math.abs(ah)), Math.max(Math.abs(al), Math.abs(ah)));
        break;
      case 'min':
        set(i, Math.min(al, bl), Math.min(ah, bh));
        break;
      case 'max':
        set(i, Math.max(al, bl), Math.max(ah, bh));
        break;
      case 'sqrt':
        if (ah < 0) set(i, Infinity, Infinity);
        else set(i, Math.sqrt(Math.max(al, 0)), Math.sqrt(ah));
        break;
      case 'square':
        set(i, al <= 0 && ah >= 0 ? 0 : Math.min(al * al, ah * ah), Math.max(al * al, ah * ah));
        break;
      case 'sin': {
        const [low, high] = sinRange(al, ah);
        set(i, low, high);
        break;
      }
      case 'cos': {
        const [low, high] = sinRange(al + HALF_PI, ah + HALF_PI);
        set(i, low, high);
        break;
      }
      case 'atan2':
        set(i, -Math.PI, Math.PI);
        break;
      case 'floor':
        set(i, Math.floor(al), Math.floor(ah));
        break;
      case 'fract':
        if (Math.floor(al) === Math.floor(ah)) set(i, al - Math.floor(al), ah - Math.floor(ah));
        else set(i, 0, 1);
        break;
      case 'clamp':
        set(i, Math.min(Math.max(al, bl), cl), Math.min(Math.max(ah, bh), ch));
        break;
      case 'select':
        if (ah < 0) set(i, bl, bh);
        else if (al >= 0) set(i, cl, ch);
        else set(i, Math.min(bl, cl), Math.max(bh, ch));
        break;
      case 'smin_quad':
        set(i, Math.min(al, bl) - Math.max(ch, 0) / 4, Math.min(ah, bh));
        break;
      case 'smin_exp':
        set(i, Math.min(al, bl) - Math.max(ch, 0) * Math.LN2, Math.min(ah, bh));
        break;
      case 'chamfer_min': {
        const chamferLow = (al + bl - ch) * Math.SQRT1_2;
        const chamferHigh = (ah + bh - cl) * Math.SQRT1_2;
        set(i, Math.min(Math.min(al, bl), chamferLow), Math.min(Math.min(ah, bh), chamferHigh));
        break;
      }
      case 'mesh_sdf': {
        const middle = prepared.meshes[operands[base + 3] as number]?.distance(centre(ia), centre(ib), centre(ic)) ?? Infinity;
        const slack = halfDiagonal(ia, ib, ic);
        set(i, middle - slack, middle + slack);
        break;
      }
      case 'strut_set': {
        const radiusRegister = operands[base + 4] as number;
        const evaluator = prepared.struts[operands[base + 3] as number];
        const middle = evaluator?.distance(centre(ia), centre(ib), centre(ic), radiusRegister >= 0 ? 0 : -1) ?? Infinity;
        const slack = halfDiagonal(ia, ib, ic);
        if (radiusRegister >= 0) set(i, middle - slack - (hi[radiusRegister] as number), middle + slack - (lo[radiusRegister] as number));
        else set(i, middle - slack, middle + slack);
        break;
      }
      case 'sample_field': {
        const field = prepared.sampled[operands[base + 3] as number];
        if (field === undefined) set(i, -Infinity, Infinity);
        else set(i, field.lo, field.hi);
        break;
      }
      default:
        set(i, -Infinity, Infinity);
    }
  }
  return [lo[program.output] as number, hi[program.output] as number];
}
