/**
 * The railing gap and gate a through-exit ladder needs (06 STA FR-STA-03): the guard-rail of the arrival level that the ladder's facing ray meets
 * within the arrival reach gets a gap centred on the ladder with a self-closing gate. Lengths in document units.
 */

import type { CadDocument, Vec2 } from '@core/model/types';
import { fromMm } from '@core/model/units';
import { segmentIntersection } from '@lib/polygon';
import type { BuildingModel, RailingElement } from '@aec/building/types';
import { elementsOf, withElement } from '../../../building/model';
import { findProfile } from '../../../steel/profiles';
import { cumulativeLengths } from '../railing/railingLayout';
import { railingProblem } from '../railing/railingValidate';
import type { WalkingSurface } from './ladderSurface';

export interface GateResult {
  readonly building: BuildingModel;
  /** 'cut' a new gap with a gate; 'existing' a gated gap was already there; 'none' no railing in front; 'skipped' a railing is there but no gap could be cut. */
  readonly status: 'cut' | 'existing' | 'none' | 'skipped';
  readonly railingId?: string;
  readonly reason?: string;
}

interface Hit {
  readonly railing: RailingElement;
  readonly distance: number;
  /** Distance along the railing path (3D) of the crossing. */
  readonly station: number;
}

/** Vertical tolerance for a railing to stand on the arrival surface, mm. */
const RAILING_Z_MM = 50;

function nearestHit(
  doc: CadDocument,
  building: BuildingModel,
  origin: Vec2,
  direction: Vec2,
  reach: number,
  arrival: WalkingSurface,
): Hit | null {
  const end: Vec2 = [origin[0] + direction[0] * reach, origin[1] + direction[1] * reach];
  let best: Hit | null = null;
  for (const railing of elementsOf(building, 'railing')) {
    const level = building.levels[railing.levelId];
    if (level === undefined || railing.role !== 'guardrail' || railing.levelId !== arrival.levelId) continue;
    const cumulative = cumulativeLengths(railing.path);
    railing.path.slice(1).forEach((next, index) => {
      const start = railing.path[index] as (typeof railing.path)[number];
      if (Math.abs(level.elevation + start[2] - arrival.top) > fromMm(doc, RAILING_Z_MM)) return;
      const hit = segmentIntersection(origin, end, [start[0], start[1]], [next[0], next[1]]);
      if (hit === null) return;
      const planLength = Math.hypot(next[0] - start[0], next[1] - start[1]);
      const share = planLength === 0 ? 0 : Math.hypot(hit[0] - start[0], hit[1] - start[1]) / planLength;
      const distance = Math.hypot(hit[0] - origin[0], hit[1] - origin[1]);
      const segment = (cumulative[index + 1] as number) - (cumulative[index] as number);
      if (best === null || distance < best.distance) best = { railing, distance, station: (cumulative[index] as number) + share * segment };
    });
  }
  return best;
}

/**
 * Cuts the gap into the railing in front of the ladder. `base` is the absolute plan point of the ladder, `gap` the clear opening wanted between
 * the ends of the gap posts' centres.
 */
export function cutRailingGate(
  doc: CadDocument,
  building: BuildingModel,
  ladder: { base: Vec2; facing: number; clearWidth: number; stileThickness: number },
  arrival: WalkingSurface,
  reach: number,
): GateResult {
  const direction: Vec2 = [Math.cos(ladder.facing), Math.sin(ladder.facing)];
  const found = nearestHit(doc, building, ladder.base, direction, reach, arrival);
  if (found === null) return { building, status: 'none' };
  const { railing, station } = found;
  const post = findProfile(railing.postProfile);
  const width = ladder.clearWidth + 2 * ladder.stileThickness + fromMm(doc, post?.h ?? 0);
  const containing = railing.openings.find((opening) => station >= opening.from && station <= opening.to);
  if (containing !== undefined)
    return containing.gate
      ? { building, status: 'existing', railingId: railing.id }
      : { building, status: 'skipped', railingId: railing.id, reason: `the ladder meets an open gap of ${railing.id} without a gate` };
  const gap = { from: station - width / 2, to: station + width / 2, gate: true };
  const length = (cumulativeLengths(railing.path).at(-1) as number) ?? 0;
  if (gap.from < 0 || gap.to > length || railing.openings.some((opening) => opening.from < gap.to && opening.to > gap.from))
    return {
      building,
      status: 'skipped',
      railingId: railing.id,
      reason: `the gap ${gap.from.toFixed(1)}..${gap.to.toFixed(1)} does not fit inside ${railing.id} (length ${length.toFixed(1)}) beside its other gaps`,
    };
  const next: RailingElement = { ...railing, openings: [...railing.openings, gap].sort((a, b) => a.from - b.from) };
  const problem = railingProblem(doc, next);
  if (problem !== null) return { building, status: 'skipped', railingId: railing.id, reason: problem.message };
  return { building: withElement(building, next), status: 'cut', railingId: railing.id };
}
