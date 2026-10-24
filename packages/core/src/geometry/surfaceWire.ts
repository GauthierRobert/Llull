/**
 * Wire form of an exact surface face for an exact kernel (`nurbs_surface` sheets and `faceSlab` recipes): the flat number lists the native
 * kernel reads (solver/crates/llull-kernel-occt/cpp/features.hxx `surface_face`), and the validation of those lists for stored recipes.
 * @invariant pure; the lists carry every field the face depends on
 */

import type { NurbsSurfaceData, UvTrimLoop } from '../lib/nurbs/surfaceTypes';

/**
 * B-spline surface: degree u, degree v, pole counts u / v, distinct knot counts u / v, rational flag, the xyz poles (u index outermost), the weights
 * (rational only), then the distinct knots and multiplicities of u and of v.
 */
export function encodeSurface(surface: NurbsSurfaceData): number[] {
  const rational = surface.weights !== undefined;
  return [
    surface.degreeU,
    surface.degreeV,
    surface.poles.length,
    surface.poles[0]?.length ?? 0,
    surface.knotsU.length,
    surface.knotsV.length,
    rational ? 1 : 0,
    ...surface.poles.flatMap((row) => row.flatMap((pole) => [...pole])),
    ...(surface.weights?.flatMap((row) => [...row]) ?? []),
    ...surface.knotsU,
    ...surface.multiplicitiesU,
    ...surface.knotsV,
    ...surface.multiplicitiesV,
  ];
}

/** Trim loops: the loop count, then per loop its point count, an outer flag (1 / 0) and its (u, v) points. Empty = the natural boundary. */
export function encodeLoops(loops: ReadonlyArray<UvTrimLoop>): number[] {
  if (loops.length === 0) return [];
  return [loops.length, ...loops.flatMap((loop) => [loop.polygon.length, loop.outer ? 1 : 0, ...loop.polygon.flatMap(([u, v]) => [u, v])])];
}

/** Largest count a stored recipe may declare (poles, knots, loop points, loops): far above any real face, far below overflow. */
const MAX_COUNT = 100_000;
const isCount = (value: unknown, minimum: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= MAX_COUNT;

/** Why `loops` is not a valid `encodeLoops` list of exactly one outer loop plus holes (>= 3 points each), or null. Empty = the natural boundary. */
export function loopsProblem(loops: readonly number[]): string | null {
  if (loops.length === 0) return null;
  const count = loops[0];
  if (!isCount(count, 1)) return 'loops: the loop count must be an integer >= 1';
  let offset = 1;
  let outer = 0;
  for (let k = 0; k < count; k++) {
    const points = loops[offset];
    const flag = loops[offset + 1];
    if (!isCount(points, 3)) return `loops: loop ${k} needs an integer point count >= 3`;
    if (flag !== 0 && flag !== 1) return `loops: loop ${k} outer flag must be 0 or 1`;
    outer += flag;
    offset += 2 + 2 * points;
    if (offset > loops.length) return `loops: loop ${k} runs past the end of the list`;
  }
  if (offset !== loops.length) return 'loops: the list is longer than its loops';
  return outer === 1 ? null : 'loops: exactly one outer loop is required';
}

/** Why `data` is not a valid description of a `type` surface (the layouts of `encodeSurface` and the `faceSlab` recipe), or null. */
export function surfaceDataProblem(
  type: 'bspline' | 'plane' | 'cylinder' | 'cone' | 'sphere' | 'torus' | 'face',
  data: readonly number[],
): string | null {
  if (type === 'plane') return data.length === 9 ? null : 'plane surface data must hold 9 numbers';
  if (type === 'face') return data.length === 0 ? null : 'face surface data must be empty';
  if (type === 'torus')
    return data.length === 11 && (data[9] ?? 0) > 0 && (data[10] ?? 0) > 0
      ? null
      : 'torus surface data must hold 11 numbers (the last two > 0)';
  if (type !== 'bspline')
    return data.length === 10 && (data[9] ?? 0) > 0 ? null : `${type} surface data must hold 10 numbers (the last > 0)`;
  const [degreeU, degreeV, countU, countV, knotsU, knotsV, rational] = data;
  if (
    !isCount(degreeU, 1) ||
    !isCount(degreeV, 1) ||
    !isCount(countU, 2) ||
    !isCount(countV, 2) ||
    !isCount(knotsU, 2) ||
    !isCount(knotsV, 2)
  )
    return 'bspline surface data: degrees and counts must be integers in range';
  if (rational !== 0 && rational !== 1) return 'bspline surface data: the rational flag must be 0 or 1';
  const poles = countU * countV;
  const head = 7 + 3 * poles + (rational === 1 ? poles : 0);
  const expected = head + 2 * (knotsU + knotsV);
  if (data.length !== expected) return `bspline surface data: expected ${expected} numbers, got ${data.length}`;
  const multiplicities = [...data.slice(head + knotsU, head + 2 * knotsU), ...data.slice(head + 2 * knotsU + knotsV)];
  return multiplicities.every((m) => isCount(m, 1)) ? null : 'bspline surface data: multiplicities must be positive integers';
}
