/** Curve inputs shared by the sheet-building commands (loft, fill, trim, blend): world curves, loop chaining, deviation of curves from a patch. */

import type { CadDocument, NurbsCurveEntity, Vec3 } from '../../model/types';
import type { NurbsCurveData } from '../../lib/nurbs/types';
import type { NurbsSurfaceData } from '../../lib/nurbs/surfaceTypes';
import type { CommandResult } from '../types';
import { closestOnSurface, surfaceProbe } from '../../lib/nurbs/closest';
import { reverseCurve } from '../../lib/nurbs/edit';
import { curveDomain, evaluateCurve } from '../../lib/nurbs/evaluate';
import { distance3 } from '../../lib/vec3';
import { placedCurve } from '../../geometry/nurbsSurface';
import { poleExtent } from '../../geometry/nurbsCurve';
import { curveEntityOf, refuseSrf } from './shared';

/** The curves `ids` as world curves, or the first coded refusal. */
export function worldCurves(doc: CadDocument, command: string, ids: ReadonlyArray<string>, path: string): NurbsCurveData[] | CommandResult {
  const curves: NurbsCurveData[] = [];
  for (const [index, id] of ids.entries()) {
    const entity = curveEntityOf(doc, command, id);
    if (!('curve' in entity))
      return refuseSrf(doc, command, entity.error?.code ?? 'SRF_NOT_NURBS', entity.summary, [id], [`params.${path}.${index}`]);
    curves.push(placedCurve(entity as NurbsCurveEntity));
  }
  return curves;
}

/** Largest extent of the pole boxes of `curves`. */
export const sizeOfCurves = (curves: ReadonlyArray<NurbsCurveData>): number =>
  curves.reduce((size, curve) => {
    const { min, max } = poleExtent(curve);
    return Math.max(size, max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  }, 1e-9);

/** Largest distance from sample points of `curves` to `surface`. */
export function maxCurveDeviation(surface: NurbsSurfaceData, curves: ReadonlyArray<NurbsCurveData>): number {
  const probe = surfaceProbe(surface);
  let worst = 0;
  for (const curve of curves) {
    const [a, b] = curveDomain(curve);
    for (let s = 0; s <= 12; s++)
      worst = Math.max(worst, closestOnSurface(surface, evaluateCurve(curve, a + ((b - a) * s) / 12), probe).distance);
  }
  return worst;
}

export interface OrientedLoop {
  readonly curves: NurbsCurveData[];
  readonly gap: number;
}

/** End point of `curve`: `which` 0 = start, 1 = end. */
export const endOf = (curve: NurbsCurveData, which: 0 | 1): Vec3 => evaluateCurve(curve, curveDomain(curve)[which]);

/**
 * The curves chained end to end (each oriented along the chain), starting from `curves[0]`. `closed` demands the last end meet the first start;
 * null when a link or the closure exceeds `tolerance`.
 */
export function chainCurves(curves: ReadonlyArray<NurbsCurveData>, tolerance: number, closed: boolean): OrientedLoop | null {
  const remaining = curves.slice(1);
  const loop: NurbsCurveData[] = [curves[0] as NurbsCurveData];
  let gap = 0;
  while (remaining.length > 0) {
    const tail = endOf(loop[loop.length - 1] as NurbsCurveData, 1);
    let best: { index: number; reversed: boolean; distance: number } | null = null;
    remaining.forEach((curve, index) => {
      for (const [reversed, which] of [
        [false, 0],
        [true, 1],
      ] as const) {
        const distance = distance3(tail, endOf(curve, which));
        if (best === null || distance < best.distance) best = { index, reversed, distance };
      }
    });
    const pick = best as { index: number; reversed: boolean; distance: number } | null;
    if (pick === null || pick.distance > tolerance) return null;
    gap = Math.max(gap, pick.distance);
    const [curve] = remaining.splice(pick.index, 1) as [NurbsCurveData];
    loop.push(pick.reversed ? reverseCurve(curve) : curve);
  }
  if (!closed) return { curves: loop, gap };
  const close = distance3(endOf(loop[loop.length - 1] as NurbsCurveData, 1), endOf(loop[0] as NurbsCurveData, 0));
  return close > tolerance ? null : { curves: loop, gap: Math.max(gap, close) };
}

/** A zero-length curve at `point` (the collapsed fourth side of a triangular patch). */
export const pointCurve = (point: Vec3): NurbsCurveData => ({ degree: 1, poles: [point, point], knots: [0, 1], multiplicities: [2, 2] });
