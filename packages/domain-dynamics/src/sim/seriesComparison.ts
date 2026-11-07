/**
 * Comparison of a run with a stored reference time series (PHY-23 TR-DRV-23 (f)): the simulated value at each reference time (linear interpolation of the
 * recorded series), the error, its RMS and peak, and the pass band of the RMS against the largest reference value. SI units throughout.
 */

import type { ReferenceSeries } from '@core/model/drives';
import { RAD_PER_S_PER_RPM } from './forceLaws';
import { peakAbs } from './sizing';
import type { RunData } from './runData';
import { elementAt } from '@lib/elementAt';

const DEFAULT_BAND = 0.05;

export interface SeriesComparison {
  readonly reference: string;
  readonly quantity: ReferenceSeries['quantity'];
  readonly target: string;
  readonly points: number;
  readonly rmsError: number;
  readonly peakError: number;
  /** The largest |reference| (the largest |simulated| when the reference is identically zero): the scale the band is relative to. */
  readonly scale: number;
  readonly relativeRms: number;
  readonly band: number;
  readonly status: 'pass' | 'fail' | 'warn';
  /** Reading uncertainty of the reference; null = unknown (the validation uncertainty is then incomplete, listed by the caller). */
  readonly uncertainty: number | null;
  /** Largest error against the reading uncertainty, when it is known: below 1 the miss is inside the reading error. */
  readonly peakErrorOverUncertainty: number | null;
}

export interface SeriesRefusal {
  readonly refusal: string;
}

/** The simulated series (or end value) a reference quantity reads, or why the run has none. */
function simulatedOf(
  reference: ReferenceSeries,
  run: RunData,
): { readonly times: readonly number[]; readonly values: readonly number[] } | SeriesRefusal {
  const { quantity, target } = reference;
  const series = run.series;
  if (quantity === 'ledger_energy') {
    if (run.ledger === undefined) return { refusal: 'the run recorded no ledger' };
    const [element, kind] = target.includes('/') ? target.split('/') : [undefined, target];
    const entries = run.ledger.entries.filter((entry) => (element === undefined || entry.element === element) && entry.kind === kind);
    if (entries.length === 0)
      return {
        refusal: `the ledger has no entry '${target}' (use <kind> or <element>/<kind>; kinds: ${[...new Set(run.ledger.entries.map((entry) => entry.kind))].join(', ')})`,
      };
    return { times: [run.duration], values: [entries.reduce((sum, entry) => sum + entry.joules, 0)] };
  }
  if (quantity === 'joint_position' || quantity === 'joint_velocity') {
    const values = series?.[quantity === 'joint_position' ? 'jointPosition' : 'jointVelocity'][target];
    return series === undefined || values === undefined ? { refusal: `the run has no joint '${target}'` } : { times: series.times, values };
  }
  const drive = run.drives?.[target]?.series;
  if (drive === undefined) return { refusal: `the run has no drive series for motor '${target}' (a datasheet motor with set_motor_drive)` };
  switch (quantity) {
    case 'motor_current':
      return { times: drive.times, values: drive.currentA };
    case 'motor_voltage':
      return { times: drive.times, values: drive.voltageV };
    case 'motor_torque':
      return { times: drive.times, values: drive.jointTorqueNm };
    case 'motor_speed':
      return { times: drive.times, values: drive.shaftSpeedRpm.map((rpm) => rpm * RAD_PER_S_PER_RPM) };
  }
}

/**
 * `values` (at increasing `times`) interpolated linearly at the increasing instants `at`, in one pass over both (linear in their lengths, however many
 * points a stored reference has); the caller keeps every instant inside the recorded span.
 */
function interpolateAll(times: readonly number[], values: readonly number[], at: readonly number[]): number[] {
  let high = 1;
  return at.map((instant) => {
    while (high < times.length - 1 && elementAt(times, high) < instant) high++;
    const low = Math.max(0, high - 1);
    const [t0, t1, v0, v1] = [elementAt(times, low), elementAt(times, high), elementAt(values, low), elementAt(values, high)];
    return t1 === t0 ? v1 : v0 + ((v1 - v0) * (instant - t0)) / (t1 - t0);
  });
}

/** The comparison of `reference` with `run`, or the reason it cannot be made (target missing, reference longer than the run). */
export function compareSeries(reference: ReferenceSeries, run: RunData): SeriesComparison | SeriesRefusal {
  const simulated = simulatedOf(reference, run);
  if ('refusal' in simulated) return simulated;
  const last = elementAt(reference.times, reference.times.length - 1);
  const recordedEnd = elementAt(simulated.times, simulated.times.length - 1);
  if (reference.quantity !== 'ledger_energy' && simulated.times.length < 2)
    return { refusal: 'the run recorded fewer than two samples: simulate longer or sample faster' };
  if (reference.quantity !== 'ledger_energy' && last > recordedEnd + 1e-9)
    return { refusal: `the reference runs to ${last} s, the run only to ${recordedEnd} s: simulate longer` };
  const modelled =
    reference.quantity === 'ledger_energy'
      ? reference.times.map(() => elementAt(simulated.values, 0))
      : interpolateAll(simulated.times, simulated.values, reference.times);
  const errors = modelled.map((value, k) => value - elementAt(reference.values, k));
  const scaleOfReference = peakAbs(reference.values);
  const scale = scaleOfReference > 0 ? scaleOfReference : peakAbs(simulated.values);
  const rmsError = Math.sqrt(errors.reduce((sum, e) => sum + e * e, 0) / errors.length);
  const peakError = peakAbs(errors);
  const band = reference.bandRel === undefined ? DEFAULT_BAND : reference.bandRel;
  const relativeRms = scale > 0 ? rmsError / scale : rmsError;
  const uncertainty = reference.uncertainty === undefined ? null : reference.uncertainty;
  return {
    reference: reference.id,
    quantity: reference.quantity,
    target: reference.target,
    points: errors.length,
    rmsError,
    peakError,
    scale,
    relativeRms,
    band,
    status: relativeRms <= band ? 'pass' : reference.source.grade === 'C' ? 'warn' : 'fail',
    uncertainty,
    peakErrorOverUncertainty: uncertainty !== null && uncertainty > 0 ? peakError / uncertainty : null,
  };
}
