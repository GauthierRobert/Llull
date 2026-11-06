/**
 * Guard-rails as barriers between touching surfaces (06 STA §5.7, STA-FU). Two surfaces that touch stay connected unless a guard-rail stands on their whole
 * shared boundary. The outline of one surface is sampled every 50 mm (every length/2000 beyond a 100 m outline) where it lies within 10 mm of the other. A sample is
 * covered by a stretch of a `guardrail` railing standing on one of the two tops (50 mm) when its foot point lies on the stretch (25 mm slack at each end) and its
 * plan distance to the stretch is at most 150 mm: the same 150 mm that edge protection allows between a rail and the edge line (`edgeChecks`), so a rail set back
 * from the edge by up to 150 mm still separates; one set back further does not. A gap or a gate is passable (a gate swings): a gap of 100 mm or more is always
 * detected (it holds a sample 25 mm or more from both rail ends) on outlines up to 100 m; a narrower gap, or 2 x length/2000 on a longer outline, may be missed. A
 * hand-rail is not a barrier. Pure, bounded (2000 samples per pair).
 */

import type { CadDocument, Vec2 } from '@core/model/types';
import { toMm } from '@core/model/units';
import { elementsOf, getBuilding } from '@aec/building/model';
import { guardedSegments } from '../../railing/railingLayout';
import { boxesNear, boxOf, distanceToRegion, type Box } from './regions';
import { CONNECT_Z_MM, CONTACT_GAP_MM, type SurfaceNode } from './types';

const SAMPLE_MM = 50;
const COVER_MM = 150;
const END_SLACK_MM = 25;
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

/** The foot of `point` lies on the stretch (with the end slack) and is at most 150 mm from it. */
function covers(run: BarrierRun, point: Vec2): boolean {
  const [dx, dy] = [run.b[0] - run.a[0], run.b[1] - run.a[1]];
  const length = Math.hypot(dx, dy);
  if (length === 0) return Math.hypot(point[0] - run.a[0], point[1] - run.a[1]) <= END_SLACK_MM;
  const [px, py] = [point[0] - run.a[0], point[1] - run.a[1]];
  const along = (px * dx + py * dy) / length;
  const across = Math.abs(px * dy - py * dx) / length;
  return along >= -END_SLACK_MM && along <= length + END_SLACK_MM && across <= COVER_MM;
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
  return samples.every((point) => near.some((run) => covers(run, point)));
}
