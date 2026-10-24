/**
 * Slope rules of `check_piping` (02 RTE §5.6): a leg that rises against its declared fall (RTE_ADVERSE_SLOPE) and a low or high point of the vertical
 * profile with no drain or vent (RTE_POCKET). Read from the stored points only; nothing is derived.
 * @invariant a leg is graded when it declares a slope (route_pipe legs[].slope) or its line declares one (create_pipeline slope); a flat graded leg is
 *   not adverse but reported as RTE_FLAT_ON_SLOPED_LINE (it does not drain); a pocket needs both of its adjacent non-flat legs graded; a branch on a leg from the first to the second of those legs
 *   (the low or high run between them) that leaves downward (low point: a drain) or upward (high point: a vent) relieves it
 */

import type { Vec3 } from '@core/model/vectors';
import type { PipeLine, PipeRun, PipingModel, Slope } from '@aec/plant/types';
import { sub3 } from '@lib/vec3';
import { unitVector } from './legs';
import type { DerivedInline } from './deriveTypes';
import { runPoints } from './model';

export interface SlopeFinding {
  readonly code: 'RTE_ADVERSE_SLOPE' | 'RTE_POCKET' | 'RTE_FLAT_ON_SLOPED_LINE';
  readonly ids: readonly string[];
  readonly message: string;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly paths: readonly string[];
}

/** Vertical component of the unit direction below which a leg counts as flat. */
const FLAT = 1e-9;
/** A branch leaves "downward" / "upward" when its direction has at least this vertical component (about 45 degrees). */
const RELIEF = Math.SQRT1_2;

const sign = (z: number): -1 | 0 | 1 => (z > FLAT ? 1 : z < -FLAT ? -1 : 0);

/** The slope leg `index` of `run` is held to: its own declaration, else the line's. */
const declaredSlope = (run: PipeRun, line: PipeLine, index: number): Slope | null => run.legSlopes?.[index] ?? line.slope ?? null;

function adverse(run: PipeRun, line: PipeLine, dirs: readonly Vec3[]): SlopeFinding[] {
  const findings: SlopeFinding[] = [];
  dirs.forEach((u, leg) => {
    const slope = declaredSlope(run, line, leg);
    const direction = sign(u[2]);
    if (slope !== null && direction === 0) {
      findings.push({
        code: 'RTE_FLAT_ON_SLOPED_LINE',
        ids: [run.id],
        message: `leg ${leg} of run ${run.id} is flat although the ${(run.legSlopes?.[leg] ?? null) === null ? 'line' : 'leg'} declares a ${slope.fall ? 'fall' : 'rise'} of ${slope.value} ${slope.unit}: it does not drain`,
        detail: { leg, declared: slope, source: (run.legSlopes?.[leg] ?? null) === null ? 'line' : 'leg' },
        paths: [`runs.${run.id}.legs.${leg}`],
      });
      return;
    }
    if (slope === null || direction === 0 || (direction === 1) !== slope.fall) return;
    findings.push({
      code: 'RTE_ADVERSE_SLOPE',
      ids: [run.id],
      message: `leg ${leg} of run ${run.id} ${direction === 1 ? 'rises' : 'falls'} along the flow, against the declared ${slope.fall ? 'fall' : 'rise'} of ${slope.value} ${slope.unit}`,
      detail: {
        leg,
        declared: slope,
        source: (run.legSlopes?.[leg] ?? null) === null ? 'line' : 'leg',
        direction: direction === 1 ? 'rises' : 'falls',
      },
      paths: [`runs.${run.id}.legs.${leg}`],
    });
  });
  return findings;
}

/** True when a branch taken off one of the legs `from`..`to` of `run` leaves vertically in the `wanted` direction (-1 down: a drain, +1 up: a vent). */
function relieved(piping: PipingModel, run: PipeRun, from: number, to: number, wanted: -1 | 1): boolean {
  return (run.branches ?? []).some((point) => {
    const direction = piping.runs[point.branchRunId]?.start.direction;
    return point.leg >= from && point.leg <= to && direction !== undefined && direction[2] * wanted >= RELIEF;
  });
}

function pockets(piping: PipingModel, run: PipeRun, line: PipeLine, dirs: readonly Vec3[]): SlopeFinding[] {
  const findings: SlopeFinding[] = [];
  const steep = dirs.map((u, leg) => ({ leg, direction: sign(u[2]) })).filter((entry) => entry.direction !== 0);
  for (let k = 0; k + 1 < steep.length; k++) {
    const [a, b] = [steep[k], steep[k + 1]];
    if (a === undefined || b === undefined || a.direction === b.direction) continue;
    if (declaredSlope(run, line, a.leg) === null || declaredSlope(run, line, b.leg) === null) continue;
    const low = a.direction === -1;
    if (relieved(piping, run, a.leg, b.leg, low ? -1 : 1)) continue;
    findings.push({
      code: 'RTE_POCKET',
      ids: [run.id],
      message: `run ${run.id} has a ${low ? 'low' : 'high'} point after leg ${a.leg} (legs ${a.leg} to ${b.leg}) with no ${low ? 'drain' : 'vent'}`,
      detail: { kind: low ? 'low' : 'high', pi: a.leg, legs: [a.leg, b.leg], needs: low ? 'drain' : 'vent' },
      paths: [`runs.${run.id}.pis.${a.leg}`],
    });
  }
  return findings;
}

/** Steps of the pipe bottom below this are geometric noise (the flush bottoms of a sloped pipe differ by the offset's tilt), mm. */
const INVERT_STEP_NOISE_MM = 0.05;

/** Largest vertical component of a leg direction for an eccentric reducer's invert step to count (steeper pipes have no bottom to keep flush). */
const HORIZONTAL_ENOUGH = 0.5;

/**
 * Eccentric reducers whose downstream pipe bottom (invert) is higher than the upstream one on a graded line that falls: the liquid stops at the step, a
 * low point without a drain (flat on top does this; flat on bottom keeps the bottoms flush).
 */
export function invertFindings(piping: PipingModel, run: PipeRun, inline: readonly DerivedInline[]): SlopeFinding[] {
  const line = piping.lines[run.lineId];
  if (line === undefined) return [];
  const findings: SlopeFinding[] = [];
  for (const placed of inline) {
    const step = placed.flat?.invertStepMm ?? 0;
    const slope = declaredSlope(run, line, placed.leg);
    if (placed.flat === undefined || !(step > INVERT_STEP_NOISE_MM) || slope === null || !slope.fall) continue;
    const points = runPoints(run);
    const [from, to] = [points[placed.leg], points[placed.leg + 1]];
    if (from === undefined || to === undefined || Math.abs(unitVector(sub3(to, from))[2]) > HORIZONTAL_ENOUGH) continue;
    findings.push({
      code: 'RTE_POCKET',
      ids: [placed.id, run.id],
      message: `eccentric reducer ${placed.id} on leg ${placed.leg} of run ${run.id} is flat on ${placed.flat.label}: the pipe bottom steps up ${+step.toFixed(4)} mm along the flow, so a line declared to fall holds liquid there (flat on bottom keeps the bottoms flush)`,
      detail: { kind: 'eccentric-invert-step', leg: placed.leg, invertStepMm: step, flat: placed.flat.label, needs: 'flat on bottom' },
      paths: [`runs.${run.id}.inline`],
    });
  }
  return findings;
}

/** Adverse legs, flat legs on a sloped line and pockets of `run` (nothing when no leg is graded). */
export function slopeFindings(piping: PipingModel, run: PipeRun): SlopeFinding[] {
  const line = piping.lines[run.lineId];
  if (line === undefined) return [];
  const points = runPoints(run);
  const dirs = points.slice(1).map((p, i) => unitVector(sub3(p, points[i] as Vec3)));
  return [...adverse(run, line, dirs), ...pockets(piping, run, line, dirs)];
}
