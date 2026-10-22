/**
 * Pole paths through stations: given, at stations t_k = k / N, the position of every pole of a section edge, the cubic B-spline in t that
 * passes through each pole's positions (one shared knot vector, so the poles form a tensor-product surface patch with the edge's own u basis).
 */

import type { Vec3 } from '../../model/vectors';
import { basisFunctions, findSpan } from './basis';
import { solveBanded, type SparseRow } from './bandSolve';
import { compressKnots } from './knotVector';

/** Degree of the interpolation across stations. */
export const STATION_DEGREE = 3;

/** Clamped knot vector by averaging uniform parameters t_k = k / count (Piegl & Tiller eq. 9.8). */
function averagedKnots(count: number, degree: number): number[] {
  const interior: number[] = [];
  for (let j = 1; j <= count - degree; j++) {
    let sum = 0;
    for (let i = j; i < j + degree; i++) sum += i / count;
    interior.push(sum / degree);
  }
  return [...new Array<number>(degree + 1).fill(0), ...interior, ...new Array<number>(degree + 1).fill(1)];
}

export interface PolePaths {
  /** `poles[i][k]`: pole i of the edge across the interpolation poles k. */
  readonly poles: Vec3[][];
  readonly knots: number[];
  readonly multiplicities: number[];
}

/**
 * Interpolates `values[k][i]` (station k = 0..N, pole i) in t = k / N.
 * @failure fewer than degree + 1 stations or a singular system -> null
 */
export function interpolatePolePaths(values: ReadonlyArray<ReadonlyArray<Vec3>>, degree = STATION_DEGREE): PolePaths | null {
  const count = values.length - 1;
  const poleCount = values[0]?.length ?? 0;
  if (count < degree || poleCount === 0) return null;
  const full = averagedKnots(count, degree);
  const rows: SparseRow[] = values.map((_, k) => {
    const u = k / count;
    const span = findSpan(count + 1, degree, u, full);
    return basisFunctions(span, u, degree, full).map((value, j) => [span - degree + j, value] as const);
  });
  const rhs = values.map((station) => station.flatMap((p) => [...p]));
  const solved = solveBanded(rows, rhs);
  if (solved === null) return null;
  const poles = Array.from({ length: poleCount }, (_, i) =>
    solved.map((row): Vec3 => [row[3 * i] as number, row[3 * i + 1] as number, row[3 * i + 2] as number]),
  );
  return { poles, ...compressKnots(full) };
}
