// Review timeline model (FR-FPR-53 / 54), pure: the crank of the mechanism, its unwrapped angle per sample (the crank axis of the shared
// timeline), the TDC-firing marks of cylinder 1 every cycle, the clickable events (collisions from the findings, reaction peaks) and the
// reaction-force magnitude of a chosen joint.

import type { DynamicsModel } from '@core/model/dynamics';
import type { SimulationData } from '@core/dynamics/simulationReport';
import type { ReactionsView } from '@core/dynamics/reactionsView';
import type { CheckResult } from './reviewTypes';

const DEG_PER_RAD = 180 / Math.PI;

/** The crank: the crank joint of the first cylinder, else the first revolute joint with a motor, else none. */
export function crankJointOf(dynamics: DynamicsModel | undefined): string | null {
  if (dynamics === undefined) return null;
  const cylinder = Object.values(dynamics.cylinders ?? {})[0];
  if (cylinder !== undefined) return cylinder.crank;
  const driven = Object.values(dynamics.motors).find((motor) => dynamics.joints[motor.joint]?.kind === 'revolute');
  return driven?.joint ?? null;
}

/** Crank angle per sample in degrees, ascending (null when the crank turns backwards or the series is missing). */
export function crankDegrees(result: SimulationData, crank: string | null): number[] | null {
  const series = crank === null ? undefined : result.series?.jointPosition[crank];
  if (series === undefined || series.length < 2) return null;
  const degrees = series.map((rad) => rad * DEG_PER_RAD);
  return degrees.every((value, i) => i === 0 || value > (degrees[i - 1] ?? -Infinity)) ? degrees : null;
}

/** TDC firing of cylinder 1 on the crank axis: its crank angle at TDC plus each cycle (720 deg four-stroke, 360 two-stroke). */
export function tdcMarks(dynamics: DynamicsModel | undefined, degrees: readonly number[]): { x: number; label: string }[] {
  const cylinder = Object.values(dynamics?.cylinders ?? {})[0];
  if (cylinder === undefined || degrees.length === 0) return [];
  const cycle = cylinder.cycle === 'four_stroke' ? 720 : 360;
  const tdc = (cylinder.tdcCrankAngleRad ?? 0) * DEG_PER_RAD + cylinder.firingOffsetDeg;
  const [first, last] = [degrees[0] ?? 0, degrees[degrees.length - 1] ?? 0];
  const marks: { x: number; label: string }[] = [];
  for (let k = Math.ceil((first - tdc) / cycle); tdc + k * cycle <= last; k++) marks.push({ x: tdc + k * cycle, label: 'TDC 1' });
  return marks;
}

export interface TimelineEvent {
  readonly id: string;
  readonly time: number;
  readonly label: string;
  readonly kind: 'collision' | 'peak';
}

/** Collisions of the motion-clearance findings (their witness time) and the peak reaction of each joint. */
export function timelineEvents(checks: readonly CheckResult[], reactions: ReactionsView | null): TimelineEvent[] {
  const collisions = checks
    .filter((check) => check.check === 'motion_clearance')
    .flatMap((check) => check.items)
    .flatMap((item): TimelineEvent[] =>
      item.witness?.timeS === undefined || item.status === 'pass'
        ? []
        : [{ id: item.findingKey, time: item.witness.timeS, label: item.ids.join(' / '), kind: 'collision' }],
    );
  const peaks = Object.entries(reactions?.peaks ?? {}).map(([joint, peak]) => ({
    id: `peak:${joint}`,
    time: peak.timeS,
    label: `${joint} peak ${Math.round(peak.value)} N`,
    kind: 'peak' as const,
  }));
  return [...collisions, ...peaks].sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
}

/** |F| of `joint` per sample, or null without a series. */
export function reactionMagnitude(reactions: ReactionsView | null, joint: string): number[] | null {
  const force = reactions?.forces[joint];
  return force === undefined || force.length === 0 ? null : force.map((f) => Math.hypot(f[0], f[1], f[2]));
}
