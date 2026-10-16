/**
 * Joint and loop reactions of a run (FR-FPR-14): force and moment on the DECLARED child body of every joint, at the joint anchor, world
 * axes, with peak magnitude, time and crank angle. Tree joints come from the engine's `jointReaction` (sign reversed for flipped tree
 * joints), loop joints from `loopForce`.
 */

import type { Vec3 } from '../model/vectors';
import type { SimulationTrace } from './physicsEngine';
import type { Topology } from './topology';

export type ReactionMode = 'off' | 'peaks' | 'series';
export type ResidualTier = 'pass' | 'warn' | 'fail';

export interface Peak {
  /** Peak magnitude: N or N·m. */
  readonly value: number;
  readonly timeS: number;
  /** Crank angle (deg) at the peak on the run's angle axis, null when there is none. */
  readonly angleDeg: number | null;
}

export interface JointReactionPeaks {
  readonly forceN: Peak;
  readonly momentNm: Peak;
}

export interface ReactionsData {
  readonly mode: 'peaks' | 'series';
  readonly frame: 'world axes; force on the declared child body of each joint, moment about the joint anchor';
  /** `exact` within the pass residual tier, `approximate` in the warn tier, `unreliable` above it. */
  readonly quality: 'exact' | 'approximate' | 'unreliable';
  readonly joints: Record<string, JointReactionPeaks>;
  readonly loops: Record<string, { readonly forceN: Peak }>;
  readonly series?: {
    readonly times: number[];
    readonly joints: Record<string, { force: Vec3[]; moment: Vec3[] }>;
    readonly loops: Record<string, Vec3[]>;
  };
}

const magnitude = (v: Vec3): number => Math.hypot(v[0], v[1], v[2]);
const negate = (v: Vec3): Vec3 => [-v[0], -v[1], -v[2]];

/** Peak of the magnitude of a vector series. */
export function peakOf(values: readonly Vec3[], times: readonly number[], angleDeg: readonly number[] | null): Peak {
  let best = 0;
  let at = 0;
  values.forEach((v, i) => {
    const m = magnitude(v);
    if (m > best) [best, at] = [m, i];
  });
  return { value: best, timeS: times[at] ?? 0, angleDeg: angleDeg?.[at] ?? null };
}

/** Force on the declared child of `jointId` at each sample (tree or loop joint), or null when the engine did not report it. */
export function childForceSeries(topology: Topology, trace: SimulationTrace, jointId: string): Vec3[] | null {
  const loop = trace.loopForce?.[jointId];
  if (loop !== undefined) return loop;
  const tree = topology.tree.find((entry) => entry.joint.id === jointId);
  const reaction = trace.jointReaction?.[jointId];
  if (tree === undefined || reaction === undefined) return null;
  return tree.flipped ? reaction.force.map(negate) : reaction.force;
}

/** Moment about the anchor on the declared child of tree joint `jointId` at each sample, or null. */
export function childMomentSeries(topology: Topology, trace: SimulationTrace, jointId: string): Vec3[] | null {
  const tree = topology.tree.find((entry) => entry.joint.id === jointId);
  const reaction = trace.jointReaction?.[jointId];
  if (tree === undefined || reaction === undefined) return null;
  return tree.flipped ? reaction.moment.map(negate) : reaction.moment;
}

/** Peaks (and series on request) of every joint reaction in `trace`; null when the engine reported none. */
export function reactionsData(args: {
  topology: Topology;
  trace: SimulationTrace;
  mode: 'peaks' | 'series';
  angleDeg: readonly number[] | null;
  tier: ResidualTier;
}): ReactionsData | null {
  const { topology, trace, mode, angleDeg, tier } = args;
  if (trace.jointReaction === undefined) return null;
  const joints: Record<string, JointReactionPeaks> = {};
  const loops: Record<string, { forceN: Peak }> = {};
  const seriesJoints: Record<string, { force: Vec3[]; moment: Vec3[] }> = {};
  const seriesLoops: Record<string, Vec3[]> = {};
  for (const entry of topology.tree) {
    const force = childForceSeries(topology, trace, entry.joint.id);
    const moment = childMomentSeries(topology, trace, entry.joint.id);
    if (force === null || moment === null) continue;
    joints[entry.joint.id] = { forceN: peakOf(force, trace.times, angleDeg), momentNm: peakOf(moment, trace.times, angleDeg) };
    seriesJoints[entry.joint.id] = { force, moment };
  }
  for (const loop of topology.loops) {
    const force = childForceSeries(topology, trace, loop.id);
    if (force === null) continue;
    loops[loop.id] = { forceN: peakOf(force, trace.times, angleDeg) };
    seriesLoops[loop.id] = force;
  }
  return {
    mode,
    frame: 'world axes; force on the declared child body of each joint, moment about the joint anchor',
    quality: tier === 'pass' ? 'exact' : tier === 'warn' ? 'approximate' : 'unreliable',
    joints,
    loops,
    ...(mode === 'series' ? { series: { times: trace.times, joints: seriesJoints, loops: seriesLoops } } : {}),
  };
}

/** Residual tiers of FR-FPR-15: pass <= passM, warn <= failM, fail above. */
export function residualTier(residualM: number, passM: number, failM: number): ResidualTier {
  return residualM <= passM ? 'pass' : residualM <= failM ? 'warn' : 'fail';
}
