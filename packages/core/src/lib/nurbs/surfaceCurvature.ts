/** Differential geometry of a NURBS surface (SRF §5.7): normal, first / second fundamental forms, Gaussian, mean and principal curvatures. */

import type { Vec3 } from '../../model/vectors';
import { cross3, dot3, len3, scale3 } from '../vec3';
import { surfaceDerivatives } from './surface';
import type { NurbsSurfaceData } from './surfaceTypes';

export interface SurfaceSample {
  readonly u: number;
  readonly v: number;
  readonly point: Vec3;
  /** Unit normal S_u x S_v / |S_u x S_v|; the zero vector where the patch is singular. */
  readonly normal: Vec3;
  readonly su: Vec3;
  readonly sv: Vec3;
  /** First fundamental form E = Su.Su, F = Su.Sv, G = Sv.Sv. */
  readonly e: number;
  readonly f: number;
  readonly g: number;
  /** Second fundamental form L = Suu.n, M = Suv.n, N = Svv.n (sign follows the normal). */
  readonly l: number;
  readonly m: number;
  readonly n: number;
  readonly gaussian: number;
  readonly mean: number;
  /** Principal curvatures, k1 >= k2 (signed about the normal). */
  readonly k1: number;
  readonly k2: number;
  /** True where |Su x Sv| vanishes (pole, collapsed edge): the curvature fields are zero and must not be over-read. */
  readonly degenerate: boolean;
}

const EPSILON = 1e-12;

/** Local geometry of `surface` at (u, v). */
export function surfaceSample(surface: NurbsSurfaceData, u: number, v: number): SurfaceSample {
  const d = surfaceDerivatives(surface, u, v, 2);
  const at = (k: number, l: number): Vec3 => (d[k] as Vec3[])[l] as Vec3;
  const [point, su, sv, suu, suv, svv] = [at(0, 0), at(1, 0), at(0, 1), at(2, 0), at(1, 1), at(0, 2)];
  const normalDirection = cross3(su, sv);
  const area = len3(normalDirection);
  const [e, f, g] = [dot3(su, su), dot3(su, sv), dot3(sv, sv)];
  if (area <= EPSILON * Math.max(1, e, g))
    return { u, v, point, normal: [0, 0, 0], su, sv, e, f, g, l: 0, m: 0, n: 0, gaussian: 0, mean: 0, k1: 0, k2: 0, degenerate: true };
  const normal = scale3(normalDirection, 1 / area);
  const [l, m, n] = [dot3(suu, normal), dot3(suv, normal), dot3(svv, normal)];
  const determinant = e * g - f * f;
  const gaussian = (l * n - m * m) / determinant;
  const mean = (e * n + g * l - 2 * f * m) / (2 * determinant);
  const spread = Math.sqrt(Math.max(0, mean * mean - gaussian));
  return { u, v, point, normal, su, sv, e, f, g, l, m, n, gaussian, mean, k1: mean + spread, k2: mean - spread, degenerate: false };
}

/** Normal curvature of the surface along the parameter direction `a * Su + b * Sv` (1/length, signed about the normal). */
export function normalCurvature(sample: SurfaceSample, a: number, b: number): number {
  const first = sample.e * a * a + 2 * sample.f * a * b + sample.g * b * b;
  return first === 0 ? 0 : (sample.l * a * a + 2 * sample.m * a * b + sample.n * b * b) / first;
}
