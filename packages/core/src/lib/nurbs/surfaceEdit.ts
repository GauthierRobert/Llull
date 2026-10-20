/**
 * Shape-preserving edits of a NURBS surface, built by applying the curve edits of `edit.ts` to every pole row (a homogeneous pole row is
 * an ordinary NURBS curve, and every curve edit is linear in the homogeneous poles, so all rows stay consistent): degree elevation, knot
 * insertion, common bases for sums of patches, parameter-rectangle extraction, reversal and transposition.
 */

import type { Vec3 } from '../../model/vectors';
import { elevateDegree, insertKnot, reverseCurve } from './edit';
import { expandKnots } from './knotVector';
import type { NurbsCurveData } from './types';
import type { NurbsSurfaceData } from './surfaceTypes';

export type Direction = 'u' | 'v';

const countOf = (surface: NurbsSurfaceData, direction: Direction): number =>
  direction === 'u' ? surface.poles.length : (surface.poles[0] as ReadonlyArray<Vec3>).length;

/** The curves of the patch that run along `direction` (one per pole row / column), with the patch's knot vector in that direction. */
function curvesAlong(surface: NurbsSurfaceData, direction: Direction): NurbsCurveData[] {
  const along = direction === 'u';
  const [degree, knots, multiplicities] = along
    ? [surface.degreeU, surface.knotsU, surface.multiplicitiesU]
    : [surface.degreeV, surface.knotsV, surface.multiplicitiesV];
  const others = countOf(surface, along ? 'v' : 'u');
  return Array.from({ length: others }, (_, k) => {
    const poles = along ? surface.poles.map((row) => row[k] as Vec3) : (surface.poles[k] as ReadonlyArray<Vec3>);
    const weights = surface.weights === undefined ? undefined : along ? surface.weights.map((row) => row[k] as number) : surface.weights[k];
    return { degree, poles, ...(weights === undefined ? {} : { weights }), knots, multiplicities };
  });
}

/** Inverse of `curvesAlong`: the patch whose `direction` curves are `curves` (all compatible); the other direction is taken from `base`. */
function fromCurvesAlong(base: NurbsSurfaceData, direction: Direction, curves: ReadonlyArray<NurbsCurveData>): NurbsSurfaceData {
  const first = curves[0] as NurbsCurveData;
  const along = direction === 'u';
  const rational = first.weights !== undefined;
  const poles = along
    ? first.poles.map((_, i) => curves.map((curve) => curve.poles[i] as Vec3))
    : curves.map((curve) => curve.poles as ReadonlyArray<Vec3>);
  const weights = rational
    ? along
      ? first.poles.map((_, i) => curves.map((curve) => (curve.weights as ReadonlyArray<number>)[i] as number))
      : curves.map((curve) => curve.weights as ReadonlyArray<number>)
    : undefined;
  const { weights: ignored, ...rest } = base;
  void ignored;
  return {
    ...rest,
    ...(along
      ? { degreeU: first.degree, knotsU: first.knots, multiplicitiesU: first.multiplicities }
      : { degreeV: first.degree, knotsV: first.knots, multiplicitiesV: first.multiplicities }),
    poles,
    ...(weights === undefined ? {} : { weights }),
  };
}

/** Applies a curve edit to every curve along `direction`; the first failure (a string) is returned. */
function editAlong(
  surface: NurbsSurfaceData,
  direction: Direction,
  edit: (curve: NurbsCurveData) => NurbsCurveData | string,
): NurbsSurfaceData | string {
  const edited: NurbsCurveData[] = [];
  for (const curve of curvesAlong(surface, direction)) {
    const result = edit(curve);
    if (typeof result === 'string') return result;
    edited.push(result);
  }
  return fromCurvesAlong(surface, direction, edited);
}

/** Raises the degree along `direction` by `by` without changing the shape. */
export function elevateSurface(surface: NurbsSurfaceData, direction: Direction, by: number): NurbsSurfaceData | string {
  return by === 0 ? surface : editAlong(surface, direction, (curve) => elevateDegree(curve, by));
}

/** Inserts the knot `value` `times` more times along `direction` without changing the shape. */
export function insertSurfaceKnot(
  surface: NurbsSurfaceData,
  direction: Direction,
  value: number,
  times: number,
): NurbsSurfaceData | string {
  return times === 0 ? surface : editAlong(surface, direction, (curve) => insertKnot(curve, value, times));
}

/** The patch with the parameter direction `direction` reversed (same surface, opposite orientation of that parameter). */
export function reverseSurface(surface: NurbsSurfaceData, direction: Direction): NurbsSurfaceData {
  const reversed = curvesAlong(surface, direction).map(reverseCurve);
  return fromCurvesAlong(surface, direction, reversed);
}

/** The patch with u and v exchanged (S'(v, u) = S(u, v)); the normal direction flips. */
export function transposeSurface(surface: NurbsSurfaceData): NurbsSurfaceData {
  const [countU, countV] = [countOf(surface, 'u'), countOf(surface, 'v')];
  return {
    degreeU: surface.degreeV,
    degreeV: surface.degreeU,
    poles: Array.from({ length: countV }, (_, j) =>
      Array.from({ length: countU }, (_, i) => (surface.poles[i] as ReadonlyArray<Vec3>)[j] as Vec3),
    ),
    ...(surface.weights === undefined
      ? {}
      : {
          weights: Array.from({ length: countV }, (_, j) =>
            Array.from({ length: countU }, (_, i) => (surface.weights?.[i] as ReadonlyArray<number>)[j] as number),
          ),
        }),
    knotsU: surface.knotsV,
    multiplicitiesU: surface.multiplicitiesV,
    knotsV: surface.knotsU,
    multiplicitiesV: surface.multiplicitiesU,
  };
}

/** Affine map of the knot values of one direction onto [0, 1] (shape and parameter speed ratios unchanged). */
export function normalizeKnots(surface: NurbsSurfaceData): NurbsSurfaceData {
  const unit = (knots: ReadonlyArray<number>): number[] => {
    const [a, b] = [knots[0] as number, knots[knots.length - 1] as number];
    return knots.map((knot) => (knot - a) / (b - a));
  };
  return { ...surface, knotsU: unit(surface.knotsU), knotsV: unit(surface.knotsV) };
}

const SNAP = 1e-9;

/** Distinct interior knots of all `lists` (values within SNAP merged) with the largest multiplicity found for each. */
function unionKnots(
  lists: ReadonlyArray<{ knots: ReadonlyArray<number>; multiplicities: ReadonlyArray<number> }>,
): Array<[number, number]> {
  const union: Array<[number, number]> = [];
  for (const { knots, multiplicities } of lists)
    knots.slice(1, -1).forEach((knot, index) => {
      const multiplicity = multiplicities[index + 1] as number;
      const found = union.find(([value]) => Math.abs(value - knot) <= SNAP);
      if (found === undefined) union.push([knot, multiplicity]);
      else found[1] = Math.max(found[1], multiplicity);
    });
  return union.sort((a, b) => a[0] - b[0]);
}

/**
 * The patches re-expressed on one basis in each direction (same degree, the union of all interior knots with the largest multiplicities),
 * all with knots normalised to [0, 1]; the shapes do not change. Mixed rational / non-rational input is not supported.
 * @failure rational and non-rational patches mixed, or a curve edit failing -> string reason
 */
export function commonBasis(surfaces: ReadonlyArray<NurbsSurfaceData>): NurbsSurfaceData[] | string {
  if (new Set(surfaces.map((surface) => surface.weights !== undefined)).size > 1)
    return 'cannot combine rational and non-rational surfaces';
  let current = surfaces.map(normalizeKnots);
  for (const direction of ['u', 'v'] as const) {
    const degreeOf = (surface: NurbsSurfaceData): number => (direction === 'u' ? surface.degreeU : surface.degreeV);
    const degree = Math.max(...current.map(degreeOf));
    const raised: NurbsSurfaceData[] = [];
    for (const surface of current) {
      const result = elevateSurface(surface, direction, degree - degreeOf(surface));
      if (typeof result === 'string') return result;
      raised.push(result);
    }
    const lists = raised.map((surface) =>
      direction === 'u'
        ? { knots: surface.knotsU, multiplicities: surface.multiplicitiesU }
        : { knots: surface.knotsV, multiplicities: surface.multiplicitiesV },
    );
    const union = unionKnots(lists);
    const refined: NurbsSurfaceData[] = [];
    for (const surface of raised) {
      let next: NurbsSurfaceData = surface;
      for (const [value, target] of union) {
        const knots = direction === 'u' ? surface.knotsU : surface.knotsV;
        const multiplicities = direction === 'u' ? surface.multiplicitiesU : surface.multiplicitiesV;
        const index = knots.findIndex((knot) => Math.abs(knot - value) <= SNAP);
        const have = index < 0 ? 0 : (multiplicities[index] as number);
        // the representative value replaces a near-equal knot so every patch ends up with identical knot values
        const snapped = index < 0 ? next : snapKnot(next, direction, knots[index] as number, value);
        const result = insertSurfaceKnot(snapped, direction, value, target - have);
        if (typeof result === 'string') return result;
        next = result;
      }
      refined.push(next);
    }
    current = refined;
  }
  return current;
}

/** Replaces the distinct knot `from` by `to` (a difference below SNAP) in one direction. */
function snapKnot(surface: NurbsSurfaceData, direction: Direction, from: number, to: number): NurbsSurfaceData {
  if (from === to) return surface;
  const swap = (knots: ReadonlyArray<number>): number[] => knots.map((knot) => (knot === from ? to : knot));
  return direction === 'u' ? { ...surface, knotsU: swap(surface.knotsU) } : { ...surface, knotsV: swap(surface.knotsV) };
}

/** Index range of the poles kept when cutting a clamped knot vector (degree `p`, full vector `full`) to [a, b] after both are at multiplicity p. */
function cutRange(full: ReadonlyArray<number>, p: number, a: number, b: number): { start: number; end: number; knots: number[] } {
  const first = full[0] as number;
  const last = full[full.length - 1] as number;
  const start = a > first ? full.indexOf(a) - 1 : 0;
  const end = b < last ? full.indexOf(b) : full.length - p - 1;
  const middle = full.filter((knot) => knot > a && knot < b);
  return { start, end, knots: [...new Array<number>(p + 1).fill(a), ...middle, ...new Array<number>(p + 1).fill(b)] };
}

/**
 * The part of the patch inside the parameter rectangle `u` x `v` (each `[from, to]` inside the domain, from < to), as its own patch whose
 * domain is that rectangle. Exact: knots are inserted to full multiplicity at the cuts and the surplus poles dropped.
 * @failure an empty or out-of-domain interval -> string reason
 */
export function extractSubSurface(
  surface: NurbsSurfaceData,
  u: readonly [number, number],
  v: readonly [number, number],
): NurbsSurfaceData | string {
  let current = surface;
  for (const [direction, [a, b]] of [
    ['u', u],
    ['v', v],
  ] as const) {
    const [knots, multiplicities, p] =
      direction === 'u'
        ? [current.knotsU, current.multiplicitiesU, current.degreeU]
        : [current.knotsV, current.multiplicitiesV, current.degreeV];
    const [first, last] = [knots[0] as number, knots[knots.length - 1] as number];
    if (!(a >= first && b <= last && b - a > 1e-12 * (last - first)))
      return `${direction} interval [${a}, ${b}] must lie inside the domain [${first}, ${last}] and have a positive length`;
    for (const cut of [a, b]) {
      if (cut <= first || cut >= last) continue;
      const index = knots.findIndex((knot) => Math.abs(knot - cut) <= SNAP);
      const have = index < 0 ? 0 : (multiplicities[index] as number);
      const result = insertSurfaceKnot(current, direction, index < 0 ? cut : (knots[index] as number), p - have);
      if (typeof result === 'string') return result;
      current = result;
    }
    const refinedKnots = direction === 'u' ? current.knotsU : current.knotsV;
    const refinedMults = direction === 'u' ? current.multiplicitiesU : current.multiplicitiesV;
    const full = expandKnots(refinedKnots, refinedMults);
    const snap = (value: number): number => refinedKnots.find((knot) => Math.abs(knot - value) <= SNAP) ?? value;
    const { start, end, knots: sliced } = cutRange(full, p, snap(a), snap(b));
    const pieces = curvesAlong(current, direction).map((curve): NurbsCurveData => {
      const kept = curve.poles.slice(start, end);
      const keptWeights = curve.weights?.slice(start, end);
      return {
        degree: p,
        poles: kept,
        ...(keptWeights === undefined ? {} : { weights: keptWeights }),
        knots: [...new Set(sliced)],
        multiplicities: [...new Set(sliced)].map((knot) => sliced.filter((value) => value === knot).length),
      };
    });
    if (pieces.some((piece) => piece.poles.length !== sliced.length - p - 1)) return `could not cut the ${direction} range [${a}, ${b}]`;
    current = fromCurvesAlong(current, direction, pieces);
  }
  return current;
}
