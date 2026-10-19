/** Row-major 4 × 4 rigid transforms of the scan plugin (translation in metres, column 3). */

import type { Mat4 } from '@core/model/pointCloud';
import type { Vec3 } from '@core/model/vectors';

export const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const at = (m: Mat4, row: number, column: number): number => m[row * 4 + column] ?? 0;

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out: number[] = [];
  for (let row = 0; row < 4; row++)
    for (let column = 0; column < 4; column++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += at(a, row, k) * at(b, k, column);
      out.push(sum);
    }
  return out;
}

export function applyPoint(m: Mat4, p: Vec3): Vec3 {
  return [0, 1, 2].map((row) => at(m, row, 0) * p[0] + at(m, row, 1) * p[1] + at(m, row, 2) * p[2] + at(m, row, 3)) as unknown as Vec3;
}

/** Inverse of an affine transform [A | t] (A invertible): [A⁻¹ | −A⁻¹t]. Null when A is singular. */
export function invertAffine(m: Mat4): Mat4 | null {
  const a = (row: number, column: number): number => at(m, row, column);
  const cofactor = (r: number, c: number): number => {
    const rows = [0, 1, 2].filter((i) => i !== r);
    const cols = [0, 1, 2].filter((i) => i !== c);
    const [r0 = 0, r1 = 0] = rows;
    const [c0 = 0, c1 = 0] = cols;
    return ((r + c) % 2 === 0 ? 1 : -1) * (a(r0, c0) * a(r1, c1) - a(r0, c1) * a(r1, c0));
  };
  const det = a(0, 0) * cofactor(0, 0) + a(0, 1) * cofactor(0, 1) + a(0, 2) * cofactor(0, 2);
  if (!(Math.abs(det) > 1e-300)) return null;
  const inverse = (r: number, c: number): number => cofactor(c, r) / det;
  const t: Vec3 = [a(0, 3), a(1, 3), a(2, 3)];
  const out: number[] = [];
  for (let row = 0; row < 3; row++)
    out.push(
      inverse(row, 0),
      inverse(row, 1),
      inverse(row, 2),
      -(inverse(row, 0) * t[0] + inverse(row, 1) * t[1] + inverse(row, 2) * t[2]),
    );
  out.push(0, 0, 0, 1);
  return out;
}

/** Whether `m` is 16 finite numbers with the last row [0 0 0 1] and an invertible 3 × 3 part. */
export const isAffine = (m: Mat4): boolean =>
  m.length === 16 &&
  m.every(Number.isFinite) &&
  at(m, 3, 0) === 0 &&
  at(m, 3, 1) === 0 &&
  at(m, 3, 2) === 0 &&
  at(m, 3, 3) === 1 &&
  invertAffine(m) !== null;

/**
 * Whether `m` is a rigid transform: 16 finite numbers, last row [0 0 0 1], rotation orthonormal within `tolerance` and det = +1.
 */
export function isRigid(m: Mat4, tolerance = 1e-9): boolean {
  if (m.length !== 16 || !m.every(Number.isFinite)) return false;
  if (Math.abs(at(m, 3, 0)) > tolerance || Math.abs(at(m, 3, 1)) > tolerance || Math.abs(at(m, 3, 2)) > tolerance) return false;
  if (Math.abs(at(m, 3, 3) - 1) > tolerance) return false;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      const dot = at(m, 0, i) * at(m, 0, j) + at(m, 1, i) * at(m, 1, j) + at(m, 2, i) * at(m, 2, j);
      if (Math.abs(dot - (i === j ? 1 : 0)) > tolerance) return false;
    }
  const det =
    at(m, 0, 0) * (at(m, 1, 1) * at(m, 2, 2) - at(m, 1, 2) * at(m, 2, 1)) -
    at(m, 0, 1) * (at(m, 1, 0) * at(m, 2, 2) - at(m, 1, 2) * at(m, 2, 0)) +
    at(m, 0, 2) * (at(m, 1, 0) * at(m, 2, 1) - at(m, 1, 1) * at(m, 2, 0));
  return Math.abs(det - 1) <= tolerance;
}

/** Rotation angle of a rigid transform in degrees. */
export function rotationAngleDeg(m: Mat4): number {
  const trace = at(m, 0, 0) + at(m, 1, 1) + at(m, 2, 2);
  return (Math.acos(Math.min(1, Math.max(-1, (trace - 1) / 2))) * 180) / Math.PI;
}

export const translationOf = (m: Mat4): Vec3 => [at(m, 0, 3), at(m, 1, 3), at(m, 2, 3)];

export const sameTransform = (a: Mat4, b: Mat4): boolean => a.length === b.length && a.every((value, i) => value === b[i]);
