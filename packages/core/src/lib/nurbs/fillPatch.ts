/**
 * N-sided fill (02 SRF M5 / M7): the boundary loop is grouped into the four sides of one Coons patch (a group of several curves becomes one
 * C0 composite side), and the poles next to a side can be re-placed to leave a neighbouring sheet with G1 (tangent plane, perpendicular
 * departure) or G2 (also the normal curvature across the edge).
 */

import type { Vec3 } from '../../model/vectors';
import { add3, dot3, len3, scale3, sub3 } from '../vec3';
import { coonsPatch } from './coons';
import { closestOnCurve } from './closest';
import { crossFrameAt, sideEdge, type PatchSide } from './crossFrame';
import { curveLength } from './curvature';
import { reverseCurve } from './edit';
import { curveDomain, evaluateCurve } from './evaluate';
import { joinCurves } from './joinCurves';
import { expandKnots } from './knotVector';
import { evaluateSurface } from './surface';
import { elevateSurface, insertSurfaceKnot } from './surfaceEdit';
import type { NurbsSurfaceData } from './surfaceTypes';
import type { NurbsCurveData } from './types';

export interface FilledLoop {
  readonly surface: NurbsSurfaceData;
  /** The side of the patch each loop curve lies on (index = loop curve index). */
  readonly sideOfCurve: ReadonlyArray<PatchSide>;
  /** The loop curve indices of each of the four sides in the order v0, u1, v1, u0 (a triangle has three: its fourth side is a point). */
  readonly groups: ReadonlyArray<ReadonlyArray<number>>;
}

const SIDE_ORDER: ReadonlyArray<PatchSide> = ['v0', 'u1', 'v1', 'u0'];

/** The partition of `count` consecutive curves into four groups with the smallest longest group (by length). */
function partition(lengths: ReadonlyArray<number>): number[][] {
  const count = lengths.length;
  let best: { cuts: [number, number, number]; worst: number } | null = null;
  for (let a = 1; a < count - 2; a++)
    for (let b = a + 1; b < count - 1; b++)
      for (let c = b + 1; c < count; c++) {
        const sums = [lengths.slice(0, a), lengths.slice(a, b), lengths.slice(b, c), lengths.slice(c)].map((part) =>
          part.reduce((s, x) => s + x, 0),
        );
        const worst = Math.max(...sums);
        if (best === null || worst < best.worst) best = { cuts: [a, b, c], worst };
      }
  const [a, b, c] = (best as NonNullable<typeof best>).cuts;
  const indices = Array.from({ length: count }, (_, i) => i);
  return [indices.slice(0, a), indices.slice(a, b), indices.slice(b, c), indices.slice(c)];
}

/** The loop (3..12 non-rational curves, oriented end to end, closed) as one Coons patch, or why it cannot be built. */
export function fillLoop(loop: ReadonlyArray<NurbsCurveData>): FilledLoop | string {
  const count = loop.length;
  if (count === 3) {
    const [c0, c1, c2] = loop as [NurbsCurveData, NurbsCurveData, NurbsCurveData];
    const corner = evaluateCurve(c0, curveDomain(c0)[0]);
    const patch = coonsPatch(c0, reverseCurve(c2), { degree: 1, poles: [corner, corner], knots: [0, 1], multiplicities: [2, 2] }, c1);
    return typeof patch === 'string' ? patch : { surface: patch, sideOfCurve: ['v0', 'u1', 'v1'], groups: [[0], [1], [2], []] };
  }
  const groups = count === 4 ? [[0], [1], [2], [3]] : partition(loop.map((curve) => curveLength(curve, ...curveDomain(curve))));
  const sides: NurbsCurveData[] = [];
  for (const group of groups) {
    const joined = joinCurves(group.map((index) => loop[index] as NurbsCurveData));
    if (typeof joined === 'string') return joined;
    sides.push(joined);
  }
  const [s0, s1, s2, s3] = sides as [NurbsCurveData, NurbsCurveData, NurbsCurveData, NurbsCurveData];
  const patch = coonsPatch(s0, reverseCurve(s2), reverseCurve(s3), s1);
  if (typeof patch === 'string') return patch;
  const sideOfCurve = loop.map((_, index) => SIDE_ORDER[groups.findIndex((group) => group.includes(index))] as PatchSide);
  return { surface: patch, sideOfCurve, groups };
}

/** A neighbouring sheet the fill must leave with G1 / G2 along one loop curve. */
export interface FillNeighbour {
  readonly curve: NurbsCurveData;
  readonly surface: NurbsSurfaceData;
  readonly side: PatchSide;
  readonly continuity: 'G1' | 'G2';
}

/** Pieces of each knot span inserted along a constrained side so that pole-wise matching follows the neighbour closely. */
const SIDE_REFINEMENT = 16;

const withInterior = (knots: ReadonlyArray<number>, parts: number): number[] => {
  const values: number[] = [];
  for (let k = 0; k + 1 < knots.length; k++)
    for (let s = 1; s < parts; s++) values.push((knots[k] as number) + (((knots[k + 1] as number) - (knots[k] as number)) * s) / parts);
  return values;
};

/** Greville abscissae of the poles of a clamped knot vector. */
const greville = (full: ReadonlyArray<number>, degree: number): number[] =>
  Array.from({ length: full.length - degree - 1 }, (_, i) => full.slice(i + 1, i + degree + 1).reduce((s, x) => s + x, 0) / degree);

/** Coefficients of S' and S'' at the start of a clamped B-spline in terms of its first three poles: S' = c1 (P1 - P0), S'' = c2 [(P2 - P1) / g2 - (P1 - P0) / g1]. */
function startDerivativeFactors(full: ReadonlyArray<number>, degree: number): { c1: number; c2: number; g1: number; g2: number } {
  const g1 = (full[degree + 1] as number) - (full[1] as number);
  const g2 = (full[degree + 2] as number) - (full[2] as number);
  return { c1: degree / g1, c2: (degree * (degree - 1)) / ((full[degree + 1] as number) - (full[2] as number)), g1, g2 };
}

/**
 * The patch with the poles next to each constrained side re-placed to leave the neighbours with G1 (second pole row on the tangent plane,
 * perpendicular to the edge) or G2 (third row also fixing the normal curvature across the edge). Sides without neighbours are untouched.
 * @failure a failing knot insertion or degree elevation -> string reason
 */
export function constrainPatch(
  patch: NurbsSurfaceData,
  neighbours: ReadonlyArray<FillNeighbour & { patchSide: PatchSide }>,
  gapTolerance: number,
): NurbsSurfaceData | string {
  let surface = patch;
  const sides = [...new Set(neighbours.map((n) => n.patchSide))];
  // refine along the constrained sides, and make the across direction cubic with enough poles for independent rows on both ends
  for (const direction of ['u', 'v'] as const) {
    const along = sides.some((side) => (direction === 'u' ? side.startsWith('v') : side.startsWith('u')));
    const across = sides.some((side) => (direction === 'u' ? side.startsWith('u') : side.startsWith('v')));
    if (across && (direction === 'u' ? surface.degreeU : surface.degreeV) < 3) {
      const raised = elevateSurface(surface, direction, 3 - (direction === 'u' ? surface.degreeU : surface.degreeV));
      if (typeof raised === 'string') return raised;
      surface = raised;
    }
    const knots = direction === 'u' ? surface.knotsU : surface.knotsV;
    const wanted = along ? withInterior(knots, SIDE_REFINEMENT) : across ? withInterior(knots, 3) : [];
    for (const value of wanted) {
      const inserted = insertSurfaceKnot(surface, direction, value, 1);
      if (typeof inserted === 'string') return inserted;
      surface = inserted;
    }
  }
  const poles = surface.poles.map((row) => [...row]) as Vec3[][];
  const [countU, countV] = [poles.length, (poles[0] as Vec3[]).length];
  const fullU = expandKnots(surface.knotsU, surface.multiplicitiesU);
  const fullV = expandKnots(surface.knotsV, surface.multiplicitiesV);
  const bounds = {
    u0: surface.knotsU[0] as number,
    u1: surface.knotsU[surface.knotsU.length - 1] as number,
    v0: surface.knotsV[0] as number,
    v1: surface.knotsV[surface.knotsV.length - 1] as number,
  };
  for (const side of sides) {
    const alongU = side.startsWith('v');
    const [alongKnots, alongDegree, acrossKnots, acrossDegree] = alongU
      ? [fullU, surface.degreeU, fullV, surface.degreeV]
      : [fullV, surface.degreeV, fullU, surface.degreeU];
    const atStart = side.endsWith('0');
    const reversedAcross = atStart
      ? acrossKnots
      : acrossKnots
          .slice()
          .reverse()
          .map((k) => -k);
    const { c1, c2, g1, g2 } = startDerivativeFactors(reversedAcross, acrossDegree);
    const countAlong = alongU ? countU : countV;
    const countAcross = alongU ? countV : countU;
    const pole = (i: number, depth: number): Vec3 => {
      const k = atStart ? depth : countAcross - 1 - depth;
      return alongU ? ((poles[i] as Vec3[])[k] as Vec3) : ((poles[k] as Vec3[])[i] as Vec3);
    };
    const setPole = (i: number, depth: number, value: Vec3): void => {
      const k = atStart ? depth : countAcross - 1 - depth;
      if (alongU) (poles[i] as Vec3[])[k] = value;
      else (poles[k] as Vec3[])[i] = value;
    };
    const parameters = greville(alongKnots, alongDegree);
    const constraints = neighbours.filter((n) => n.patchSide === side);
    // the end poles of a side also control the adjacent boundary curves: they are left alone so every boundary stays exact
    for (let i = 1; i + 1 < countAlong; i++) {
      const xi = parameters[i] as number;
      const boundary = alongU
        ? evaluateSurface(surface, xi, atStart ? bounds.v0 : bounds.v1)
        : evaluateSurface(surface, atStart ? bounds.u0 : bounds.u1, xi);
      let best: { n: (typeof constraints)[number]; foot: { t: number; distance: number } } | null = null;
      for (const n of constraints) {
        const foot = closestOnCurve(n.curve, boundary);
        if (best === null || foot.distance < best.foot.distance) best = { n, foot };
      }
      if (best === null || best.foot.distance > gapTolerance) continue;
      const neighbour = best.n;
      const edge = sideEdge(neighbour.surface, neighbour.side);
      const edgeFoot = closestOnCurve(edge.curve, boundary);
      const frame = crossFrameAt(neighbour.surface, neighbour.side, edgeFoot.t);
      if (frame.degenerate) continue;
      const p0 = pole(i, 0);
      const offset = sub3(pole(i, 1), p0);
      const reach = Math.max(dot3(offset, frame.across), 0.25 * len3(offset));
      const p1 = add3(p0, scale3(frame.across, reach));
      setPole(i, 1, p1);
      if (neighbour.continuity === 'G2') {
        const p2 = pole(i, 2);
        const speed = len3(scale3(sub3(p1, p0), c1));
        const second = scale3(sub3(scale3(sub3(p2, p1), 1 / g2), scale3(sub3(p1, p0), 1 / g1)), c2);
        const delta = (frame.curvature * speed * speed - dot3(second, frame.normal)) / (c2 / g2);
        setPole(i, 2, add3(p2, scale3(frame.normal, delta)));
      }
    }
  }
  return { ...surface, poles };
}
