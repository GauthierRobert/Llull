/**
 * One engine operating point run through `simulate_motion` on a scratch copy of the document (never stored): a governed run holds the crank
 * at a speed (full throttle), a free run lets the engine find its own equilibrium against its load. Used by compare_to_reference and the
 * timestep-convergence check; both read the same engine report, so the numbers are the ones the user sees from simulate_motion.
 */

import type { CadDocument } from '@core/model/types';
import type { DynamicsModel } from '@core/model/dynamics';
import type { EngineData } from '../../sim/engineReport';
import type { RealismData } from '../../sim/engine/engineRealism';
import { RAD_PER_S_PER_RPM } from '../../sim/forceLaws';
import type { ExecutionContext } from '@core/commands/types';
import { simulateMotion } from '../simulate';

/** Cycles run before the measured ones so the governor and the held-speed curves settle (named). */
const SETTLE_CYCLES = 1;
const GOVERNOR_ID = 'operating-point-governor';

interface RunData {
  readonly engineReport?: EngineData & { realism?: RealismData };
  readonly loops?: { residualM: number | null; tier: string; solver: { timestepS: number } };
  readonly reactions?: unknown;
  readonly series?: { times: number[]; jointVelocity: Record<string, number[]> };
  readonly warnings: string[];
}

export interface PointRun {
  /** Crank speed asked for (governed) or the mean of the last cycle (free), rpm. */
  readonly rpm: number;
  readonly meanRpm: number;
  readonly timestepS: number;
  readonly loopTier: string | null;
  readonly warnings: string[];
  readonly report: EngineData & { realism?: RealismData };
  /** Mean speed over the last two cycles' halves differ by this relative amount: a free run is settled when it is small. */
  readonly drift: number | null;
}

export interface PointRefusal {
  readonly error: string;
}

/** The crank joint of the first cylinder pressure of `dynamics`, or undefined when there is none. */
export function crankOf(dynamics: DynamicsModel): string | undefined {
  return Object.values(dynamics.cylinders ?? {})[0]?.crank;
}

/** The dynamics with the crank held at `rpm` by a governor (any other drive of the crank removed) and started at that speed. */
function governed(dynamics: DynamicsModel, crank: string, rpm: number): DynamicsModel {
  const joint = dynamics.joints[crank];
  if (joint === undefined) return dynamics;
  const motors = Object.fromEntries(Object.entries(dynamics.motors).filter(([, motor]) => motor.joint !== crank));
  return {
    ...dynamics,
    joints: { ...dynamics.joints, [crank]: { ...joint, initialVelocity: rpm * RAD_PER_S_PER_RPM } },
    motors: { ...motors, [GOVERNOR_ID]: { id: GOVERNOR_ID, kind: 'speed', joint: crank, rpm, maxTorque: 1e6 } },
  };
}

/** The dynamics with the crank started at `rpm` and left free (its drive is the gas pressure, its load the propeller / friction). */
function free(dynamics: DynamicsModel, crank: string, rpm: number): DynamicsModel {
  const joint = dynamics.joints[crank];
  return joint === undefined
    ? dynamics
    : { ...dynamics, joints: { ...dynamics.joints, [crank]: { ...joint, initialVelocity: rpm * RAD_PER_S_PER_RPM } } };
}

/** Relative difference of the mean speed over the last and the previous quarter of the series, null when the series is too short. */
function speedDrift(data: RunData, crank: string): number | null {
  const times = data.series?.times;
  const velocity = data.series?.jointVelocity[crank];
  if (times === undefined || velocity === undefined || times.length < 8) return null;
  const quarter = Math.floor(times.length / 4);
  const mean = (from: number, to: number): number => velocity.slice(from, to).reduce((sum, v) => sum + v, 0) / Math.max(1, to - from);
  const [last, before] = [mean(times.length - quarter, times.length), mean(times.length - 2 * quarter, times.length - quarter)];
  return last !== 0 ? Math.abs(last - before) / Math.abs(last) : null;
}

export interface PointOptions {
  readonly mode: 'governed' | 'free';
  readonly rpm: number;
  /** Measured cycles after the settling cycle (governed), or the run length in cycles at `rpm` (free). */
  readonly cycles: number;
  readonly timestepS?: number;
}

/** Run one operating point on a scratch copy of `doc`; the document itself is never changed. */
export function runOperatingPoint(doc: CadDocument, options: PointOptions, ctx: ExecutionContext | undefined): PointRun | PointRefusal {
  const dynamics = doc.dynamics;
  const crank = dynamics === undefined ? undefined : crankOf(dynamics);
  if (dynamics === undefined || crank === undefined) return { error: 'the model has no cylinder pressure (add_cylinder_pressure first)' };
  const lead = Object.values(dynamics.cylinders ?? {})[0];
  const cycleSeconds = ((lead?.cycle === 'two_stroke' ? 1 : 2) * 60) / options.rpm;
  const duration = (options.mode === 'governed' ? SETTLE_CYCLES + options.cycles : options.cycles) * cycleSeconds;
  const scratch: CadDocument = {
    ...doc,
    dynamics: options.mode === 'governed' ? governed(dynamics, crank, options.rpm) : free(dynamics, crank, options.rpm),
  };
  const result = simulateMotion.run(
    scratch,
    {
      duration,
      detail: options.mode === 'free' ? 'series' : 'summary',
      reactions: 'peaks',
      ...(options.timestepS !== undefined ? { timestep: options.timestepS } : {}),
    },
    ctx,
  );
  const data = result.data as RunData | undefined;
  if (data === undefined) return { error: result.summary };
  const report = data.engineReport;
  if (report === undefined || report.lastCycle === null)
    return { error: `the run did not cover a full cycle at ${options.rpm} rpm (${data.warnings.join('; ') || result.summary})` };
  return {
    rpm: options.rpm,
    meanRpm: report.lastCycle.meanRpm,
    timestepS: data.loops?.solver.timestepS ?? options.timestepS ?? 0,
    loopTier: data.loops?.tier ?? null,
    warnings: data.warnings,
    report,
    drift: options.mode === 'free' ? speedDrift(data, crank) : null,
  };
}
