/**
 * Guard-rails as barriers between touching surfaces (06 STA §5.7, STA-FU). Two surfaces that touch stay connected unless a guard-rail stands on their whole
 * shared boundary: every sample of the contact (every 50 mm along the outline of one surface that lies within 10 mm of the other) is within 50 mm in plan of a
 * guarded stretch of a `guardrail` railing standing on one of the two tops (50 mm). A gap or a gate in the rail is passable (a gate swings), so a sample
 * in a gap that is wider than the 100 mm of two samples opens the connection. A hand-rail is not a barrier. Pure, bounded (2000 samples per pair).
 */

import type { CadDocument, Vec2 } from '@core/model/types';
import { toMm } from '@core/model/units';
import { projectOntoSegment } from '@lib/polygon';
import { elementsOf, getBuilding } from '@aec/building/model';
import { guardedSegments } from '../../railing/railingLayout';
import { boxesNear, boxOf, distanceToRegion, type Box } from './regions';
import { CONNECT_Z_MM, CONTACT_GAP_MM, type SurfaceNode } from './types';

const SAMPLE_MM = 50;
const COVER_MM = 50;
const MAX_SAMPLES = 2000;

/** A guarded stretch of a guard-rail, plan end points and absolute height of the surface it stands on, mm. */
export interface BarrierRun {
  readonly a: Vec2;
  readonly b: Vec2;
  readonly zMm: number;
  readonly box: Box;
}

/** Every stretch of every guard-rail with ALL its openings (gated or not) left out: the stretches nobody walks through. */
export function barrierRuns(doc: CadDocument): BarrierRun[] {
  const building = getBuilding(doc);
  return elementsOf(building, 'railing').flatMap((railing): BarrierRun[] => {
    const level = building.levels[railing.levelId];
    if (level === undefined || railing.role !== 'guardrail') return [];
    const openings = railing.openings.map((opening) => ({ ...opening, gate: false }));
    return guardedSegments(railing.path, openings).map(([p, q]): BarrierRun => {
      const [a, b]: [Vec2, Vec2] = [
        [toMm(doc, p[0]), toMm(doc, p[1])],
        [toMm(doc, q[0]), toMm(doc, q[1])],
      ];
      return { a, b, zMm: toMm(doc, level.elevation + (p[2] + q[2]) / 2), box: boxOf([a, b]) };
    });
  });
}

/** Sample points along the outlines of `from` that lie within the contact gap of `to`. */
function contactSamples(from: SurfaceNode, to: SurfaceNode): Vec2[] {
  const samples: Vec2[] = [];
  let length = 0;
  for (const region of from.regions)
    for (let index = 0; index < region.outer.length; index++) {
      const [p, q] = [region.outer[index] as Vec2, region.outer[(index + 1) % region.outer.length] as Vec2];
      length += Math.hypot(q[0] - p[0], q[1] - p[1]);
    }
  const step = Math.max(SAMPLE_MM, length / MAX_SAMPLES);
  for (const region of from.regions)
    for (let index = 0; index < region.outer.length; index++) {
      const [p, q] = [region.outer[index] as Vec2, region.outer[(index + 1) % region.outer.length] as Vec2];
      const pieces = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / step));
      for (let piece = 0; piece <= pieces; piece++) {
        const t = piece / pieces;
        const point: Vec2 = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
        if (
          to.regions.some(
            (other) =>
              boxesNear(other.box, [point[0], point[1], point[0], point[1]], CONTACT_GAP_MM) &&
              distanceToRegion(point, other) <= CONTACT_GAP_MM,
          )
        )
          samples.push(point);
      }
    }
  return samples;
}

/** True when the shared boundary of `a` and `b` is covered along its whole length by guard-rails (see the file comment); false when they merely overlap. */
export function separatedByRailing(a: SurfaceNode, b: SurfaceNode, runs: readonly BarrierRun[]): boolean {
  const near = runs.filter(
    (run) =>
      (Math.abs(run.zMm - a.topMm) <= CONNECT_Z_MM || Math.abs(run.zMm - b.topMm) <= CONNECT_Z_MM) &&
      boxesNear(run.box, a.box, COVER_MM) &&
      boxesNear(run.box, b.box, COVER_MM),
  );
  if (near.length === 0) return false;
  const samples = contactSamples(a, b);
  if (samples.length === 0) return false;
  return samples.every((point) => near.some((run) => projectOntoSegment(point, run.a, run.b).distance <= COVER_MM));
}
