/** Running the duty cycle of a drive for sizing (PHY-23 TR-DRV-21 / 22): the window, the step the controller needs, and the model copy of a ratio sweep. */

import type { CadDocument } from '@core/model/types';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { compileProfile, isProfileRefusal } from '@core/geometry/motionProfile';
import type { MotorDrive } from '@core/model/drives';
import type { DynamicsModel } from '@core/model/dynamics';
import { transmissionRatio, type Transmission } from '@core/model/transmissions';
import { simulateMotion } from './simulate';
import { runDataOf, type RunData } from '../sim/runData';

/** Smallest step simulate_motion accepts, s. */
export const MIN_STEP = 5e-6;
/** Largest step of a drive run, s: the legacy default. */
const MAX_STEP = 1e-3;
/** Recorded samples per second of a sizing run (the RMS reads this grid). */
export const SIZING_SAMPLE_RATE = 1000;

/** Duration (s) of one whole run of the drive's profile (all its repeats), or why there is none. */
export function profileWindow(dynamics: DynamicsModel, drive: MotorDrive): { readonly seconds: number } | { readonly error: string } {
  if (drive.profile === undefined)
    return { error: `the drive of '${drive.id}' has no profile (a constant voltage has no duty cycle: give \`duration\`)` };
  const stored = dynamics.profiles?.[drive.profile];
  if (stored === undefined) return { error: `profile '${drive.profile}' of the drive of '${drive.id}' does not exist` };
  const compiled = compileProfile(stored);
  return isProfileRefusal(compiled)
    ? { error: `profile '${stored.id}': ${compiled.code} — ${compiled.error}` }
    : { seconds: compiled.duration };
}

/**
 * The step a run of `drives` uses when the caller gives none: half the controller period of the fastest sampled drive (a whole number of steps, and
 * halving it keeps it whole), at most 1 ms; undefined = let simulate_motion choose (no sampled drive).
 */
export function drivenTimestep(drives: Iterable<MotorDrive>): number | undefined {
  const rates = [...drives].flatMap((drive) => (drive.sampleHz === undefined ? [] : [drive.sampleHz]));
  return rates.length === 0 ? undefined : Math.max(MIN_STEP * 2, Math.min(MAX_STEP, 1 / (2 * Math.max(...rates))));
}

export interface SizingRunOptions {
  readonly duration: number;
  readonly timestep?: number;
  readonly sampleRate?: number;
}

/** One simulate_motion run with the drive series and the ledger; `data` is null when the simulation refused (its summary says why). */
export function runSizing(
  doc: CadDocument,
  options: SizingRunOptions,
  ctx: ExecutionContext | undefined,
): { readonly result: CommandResult; readonly data: RunData | null } {
  const result = simulateMotion.run(
    doc,
    {
      duration: options.duration,
      sampleRate: options.sampleRate ?? SIZING_SAMPLE_RATE,
      detail: 'drives',
      energy: true,
      ...(options.timestep === undefined ? {} : { timestep: options.timestep }),
    },
    ctx,
  );
  return { result, data: runDataOf(result) };
}

/** The gear that carries `motorJoint` to the load (its driver is the motor's joint), or undefined. */
export function gearOf(dynamics: DynamicsModel, motorJoint: string): Extract<Transmission, { kind: 'gear' }> | undefined {
  return Object.values(dynamics.transmissions ?? {}).find(
    (transmission): transmission is Extract<Transmission, { kind: 'gear' }> =>
      transmission.kind === 'gear' && transmission.driver === motorJoint,
  );
}

/** A copy of the document whose gear runs at reduction `reduction` (motor turns per output turn, sign of the stored ratio kept). Never the stored document. */
export function withReduction(doc: CadDocument, gearId: string, reduction: number): CadDocument | null {
  const dynamics = doc.dynamics;
  const gear = dynamics?.transmissions?.[gearId];
  if (dynamics === undefined || gear === undefined || gear.kind !== 'gear') return null;
  const sign = transmissionRatio(gear) < 0 ? -1 : 1;
  const { teeth: _teeth, ...rest } = gear;
  return {
    ...doc,
    dynamics: { ...dynamics, transmissions: { ...dynamics.transmissions, [gearId]: { ...rest, ratio: sign / reduction } } },
  };
}
