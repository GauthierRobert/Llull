/**
 * Where A13.1 pipe markers go on one pipe (plant 09 VIS §5.7 placement, grade B): one marker within 600 mm of each valve, flanged joint and direction change; two at each
 * wall / floor penetration (no model supplies penetrations yet: never planned, never required); between them the straight-run interval `spacingMm`. Valve, flange and bend
 * positions are read from the 02 RTE derivation of a routed run; a building pipe has direction changes only. Pure; positions are arc lengths along the centreline, absolute mm.
 * @invariant a valve marker wins over a flange marker, a flange over a bend, when two requirements lie within 600 mm of each other (one marker serves both)
 */

import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { getPiping } from '../piping/model';
import { isFailure } from '../piping/deriveTypes';
import { deriveRun } from '../piping/routeParts';
import type { SourcePipe } from '../common/pipeCentrelines';

/** A marker is "within" this distance of the component it serves (spec §5.7). */
export const NEAR_MM = 600;
/** Straight-run interval of the spec (§5.7): 25 ft, grade B named default. */
export const DEFAULT_SPACING_MM = 7620;
/** A direction change below this angle is a straight pipe (the legacy pipe model stores vertices, not elbows). */
const BEND_MIN_DEG = 1;

export type MarkerReason = 'valve' | 'flange' | 'bend' | 'interval';

export interface Requirement {
  readonly atMm: number;
  readonly reason: Exclude<MarkerReason, 'interval'>;
}

export interface Planned {
  readonly atMm: number;
  readonly reason: MarkerReason;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (v: Vec3): number => Math.hypot(v[0], v[1], v[2]);
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

export const lengthOf = (points: readonly Vec3[]): number =>
  points.slice(1).reduce((sum, p, i) => sum + norm(sub(p, points[i] as Vec3)), 0);

/** Arc length of the point of the polyline nearest to `p`. */
export function arcAt(points: readonly Vec3[], p: Vec3): number {
  let best = { distance: Number.POSITIVE_INFINITY, arc: 0 };
  let before = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as Vec3;
    const direction = sub(points[i] as Vec3, a);
    const length = norm(direction);
    const t = length === 0 ? 0 : Math.min(1, Math.max(0, dot(sub(p, a), direction) / (length * length)));
    const distance = norm(sub(p, [a[0] + t * direction[0], a[1] + t * direction[1], a[2] + t * direction[2]]));
    if (distance < best.distance) best = { distance, arc: before + t * length };
    before += length;
  }
  return best.arc;
}

/** Position and unit tangent at arc length `atMm` (clamped to the pipe). */
export function pointAt(points: readonly Vec3[], atMm: number): { positionMm: Vec3; tangent: Vec3 } {
  let before = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as Vec3;
    const direction = sub(points[i] as Vec3, a);
    const length = norm(direction);
    if (atMm - before <= length || i === points.length - 1) {
      const t = length === 0 ? 0 : Math.min(1, Math.max(0, (atMm - before) / length));
      return {
        positionMm: [round3(a[0] + t * direction[0]), round3(a[1] + t * direction[1]), round3(a[2] + t * direction[2])],
        tangent: length === 0 ? [1, 0, 0] : [round3(direction[0] / length), round3(direction[1] / length), round3(direction[2] / length)],
      };
    }
    before += length;
  }
  return { positionMm: [0, 0, 0], tangent: [1, 0, 0] };
}

function bendsOf(points: readonly Vec3[]): Requirement[] {
  const found: Requirement[] = [];
  let arc = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const before = sub(points[i] as Vec3, points[i - 1] as Vec3);
    const after = sub(points[i + 1] as Vec3, points[i] as Vec3);
    arc += norm(before);
    const cosine = dot(before, after) / (norm(before) * norm(after));
    if (Math.acos(Math.min(1, Math.max(-1, cosine))) * (180 / Math.PI) > BEND_MIN_DEG) found.push({ atMm: arc, reason: 'bend' });
  }
  return found;
}

/** Everything that wants a marker nearby: valves, flanged joints and direction changes of the pipe. */
export function requirements(doc: CadDocument, source: SourcePipe): Requirement[] {
  const run = source.kind === 'run' ? getPiping(doc).runs[source.id] : undefined;
  const derivation = run === undefined ? undefined : deriveRun(doc, run);
  if (derivation === undefined || isFailure(derivation)) return bendsOf(source.points);
  return [
    ...derivation.inline
      .filter((part) => part.type.startsWith('valve'))
      .map((part) => ({ atMm: arcAt(source.points, part.centre), reason: 'valve' as const })),
    ...derivation.joints
      .filter((joint) => joint.kind === 'flanged')
      .map((joint) => ({ atMm: arcAt(source.points, joint.position), reason: 'flange' as const })),
    ...derivation.turns.map((turn) => ({ atMm: arcAt(source.points, turn.point), reason: 'bend' as const })),
  ];
}

const PRIORITY: Readonly<Record<Requirement['reason'], number>> = { valve: 0, flange: 1, bend: 2 };

/** The markers that serve every requirement (priority order, none within NEAR_MM of a chosen one), sorted along the pipe. */
export function mandatory(required: readonly Requirement[]): Requirement[] {
  const chosen: Requirement[] = [];
  for (const item of [...required].sort((a, b) => PRIORITY[a.reason] - PRIORITY[b.reason] || a.atMm - b.atMm))
    if (!chosen.some((other) => Math.abs(other.atMm - item.atMm) <= NEAR_MM)) chosen.push(item);
  return chosen.sort((a, b) => a.atMm - b.atMm);
}

/** The full plan: the mandatory markers, and interval markers so that no stretch is longer than `spacingMm` (a pipe with no requirement gets markers at the middles of equal parts). */
export function planMarkers(required: readonly Requirement[], total: number, spacingMm: number): Planned[] {
  const fixed = mandatory(required);
  if (fixed.length === 0) {
    const count = Math.max(1, Math.ceil(total / spacingMm));
    return Array.from({ length: count }, (_, k) => ({ atMm: round3(((k + 0.5) * total) / count), reason: 'interval' as const }));
  }
  const bounds = [0, ...fixed.map((item) => item.atMm), total];
  const planned: Planned[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const [from, to] = [bounds[i] as number, bounds[i + 1] as number];
    if (i > 0) planned.push(fixed[i - 1] as Planned);
    const inserted = Math.max(0, Math.ceil((to - from) / spacingMm) - 1);
    for (let j = 1; j <= inserted; j++) planned.push({ atMm: round3(from + (j * (to - from)) / (inserted + 1)), reason: 'interval' });
  }
  return planned.map((item) => ({ ...item, atMm: round3(item.atMm) }));
}
