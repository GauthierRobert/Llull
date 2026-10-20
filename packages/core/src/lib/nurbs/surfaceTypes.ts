/** NURBS surface data (SRF §3.3): a clamped tensor-product B-spline patch in 3D, optionally rational. Poles are local to the owning entity. */

import type { Vec3 } from '../../model/vectors';
import { nurbsViolation } from './knotVector';
import type { NurbsCurveData } from './types';

/**
 * `poles[i][j]`: i runs along u (rows), j along v (columns); every row has the same length. Each direction is a clamped knot vector exactly
 * like `NurbsCurveData` (distinct knots + multiplicities, first / last multiplicity degree + 1, Σ multiplicities = pole count + degree + 1).
 * @invariant weights, when present, have the shape of `poles` and are finite > 0
 */
export interface NurbsSurfaceData {
  readonly degreeU: number;
  readonly degreeV: number;
  readonly poles: ReadonlyArray<ReadonlyArray<Vec3>>;
  readonly weights?: ReadonlyArray<ReadonlyArray<number>>;
  readonly knotsU: ReadonlyArray<number>;
  readonly multiplicitiesU: ReadonlyArray<number>;
  readonly knotsV: ReadonlyArray<number>;
  readonly multiplicitiesV: ReadonlyArray<number>;
}

/**
 * One closed boundary of a trimmed sheet in the (u, v) parameter plane: a polygon through exact samples of the trimming curve (fine enough
 * that its chordal error is far below the model tolerance). The trimmed region is the even-odd union of all loops of a sheet (an outer loop
 * and the holes inside it).
 * @invariant the vertex count is even and every vertex at an even index is also a vertex of the coarse polygon (Richardson-ready area)
 */
export interface UvTrimLoop {
  readonly outer: boolean;
  readonly polygon: ReadonlyArray<readonly [number, number]>;
}

/** Highest supported pole count per direction (a 10 000 pole curve limit would give 10^8 poles). */
export const MAX_SURFACE_POLES = 400;

/** A direction of the patch as a curve (the iso-parametric structure): the poles of row / column `index`, with its knot vector. */
function directionCurve(surface: NurbsSurfaceData, direction: 'u' | 'v'): NurbsCurveData {
  const rows = surface.poles;
  return direction === 'u'
    ? { degree: surface.degreeU, poles: rows.map((row) => row[0] as Vec3), knots: surface.knotsU, multiplicities: surface.multiplicitiesU }
    : { degree: surface.degreeV, poles: rows[0] as ReadonlyArray<Vec3>, knots: surface.knotsV, multiplicities: surface.multiplicitiesV };
}

/**
 * Why `surface` is not a valid clamped NURBS patch, or null: `{ path, message }` with `path` relative to the surface (`degreeU`, `poles.3.2`,
 * `weights.1.1`, `knotsU`, `multiplicitiesV`...).
 */
export function surfaceViolation(surface: NurbsSurfaceData): { readonly path: string; readonly message: string } | null {
  const { poles, weights } = surface;
  const countU = poles.length;
  const countV = poles[0]?.length ?? 0;
  if (countU < 2 || countV < 2) return { path: 'poles', message: 'poles needs at least 2 rows of at least 2 poles' };
  if (countU > MAX_SURFACE_POLES || countV > MAX_SURFACE_POLES)
    return { path: 'poles', message: `at most ${MAX_SURFACE_POLES} poles per direction` };
  if (poles.some((row) => row.length !== countV)) return { path: 'poles', message: 'every row of poles needs the same number of poles' };
  const check = (direction: 'u' | 'v'): { path: string; message: string } | null => {
    const violation = nurbsViolation(directionCurve(surface, direction));
    if (violation === null) return null;
    const suffix = direction.toUpperCase();
    const path = violation.path.startsWith('poles') ? 'poles' : violation.path.replace(/^(degree|knots|multiplicities)/, `$1${suffix}`);
    return { path, message: `${direction}: ${violation.message}` };
  };
  const bad = check('u') ?? check('v');
  if (bad !== null) return bad;
  for (let i = 0; i < countU; i++)
    for (let j = 0; j < countV; j++)
      if (!(poles[i]?.[j] as readonly number[]).every(Number.isFinite))
        return { path: `poles.${i}.${j}`, message: `pole ${i},${j} is not finite` };
  if (weights !== undefined) {
    if (weights.length !== countU || weights.some((row) => row.length !== countV))
      return { path: 'weights', message: 'weights needs the same shape as poles' };
    for (let i = 0; i < countU; i++)
      for (let j = 0; j < countV; j++) {
        const weight = weights[i]?.[j] as number;
        if (!(Number.isFinite(weight) && weight > 0))
          return { path: `weights.${i}.${j}`, message: `weight ${i},${j} must be finite and > 0` };
      }
  }
  return null;
}
