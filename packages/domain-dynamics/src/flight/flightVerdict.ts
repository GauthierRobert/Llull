/**
 * Verdict of a flight run against named, overridable limits (FR-FLT-07): each check PASS / MARGINAL (passes within 10 % of its limit) / FAIL
 * / not_applicable; the run is FAIL on any failed check or a divergence, MARGINAL on any marginal check, else PASS.
 */

import type { FlightMetrics } from './flightMetrics';

export interface FlightLimits {
  /** Least share of the maximum thrust left at hover. */
  readonly minThrustMargin: number;
  /** Largest share of controller updates where a limit clipped the demand. */
  readonly maxSaturationFraction: number;
  /** Largest tilt of the thrust axis from vertical, deg. */
  readonly maxAttitudeDeg: number;
  /** Largest position error at the end of the run, m. */
  readonly maxFinalPositionErrorM: number;
  /** Largest recovery time after an event (set-point change, gust), s. */
  readonly maxRecoveryTimeS: number;
  /** Least state of charge left at the end of the run (the reserve), 0..1. */
  readonly minFinalSoc: number;
}

/** Default limits (TECHNICAL_SPEC §4: thrust margin >= 30 %, saturation < 5 %). */
export const DEFAULT_FLIGHT_LIMITS: FlightLimits = {
  minThrustMargin: 0.3,
  maxSaturationFraction: 0.05,
  maxAttitudeDeg: 45,
  maxFinalPositionErrorM: 0.1,
  maxRecoveryTimeS: 5,
  minFinalSoc: 0.2,
};

/** A check passing by less than this share of its limit is MARGINAL. */
const MARGINAL_SHARE = 0.1;

type CheckStatus = 'PASS' | 'MARGINAL' | 'FAIL' | 'not_applicable';

export interface FlightCheck {
  readonly name: string;
  readonly value: number | null;
  readonly limit: number;
  readonly comparison: '>=' | '<=';
  readonly status: CheckStatus;
  readonly note: string;
}

function check(name: string, value: number | null, limit: number, comparison: '>=' | '<=', note: string): FlightCheck {
  if (value === null) return { name, value, limit, comparison, status: 'not_applicable', note };
  const passes = comparison === '>=' ? value >= limit : value <= limit;
  const band = Math.abs(limit) * MARGINAL_SHARE;
  const close = comparison === '>=' ? value < limit + band : value > limit - band;
  return { name, value, limit, comparison, status: !passes ? 'FAIL' : close ? 'MARGINAL' : 'PASS', note };
}

/** Checks and verdict of `metrics` under `limits`. */
export function flightVerdict(
  metrics: FlightMetrics,
  limits: FlightLimits,
): { readonly verdict: 'PASS' | 'MARGINAL' | 'FAIL'; readonly checks: readonly FlightCheck[] } {
  const { control } = metrics;
  const recoveryNote =
    metrics.events.length === 0
      ? 'no set-point change or gust in the scenario'
      : metrics.recoveryTimeS === null
        ? 'an event never recovered inside the settle band before the next one: see events'
        : 'largest recovery over the events';
  const neverRecovered = metrics.events.length > 0 && metrics.recoveryTimeS === null;
  const packs = Object.values(metrics.battery);
  const cutoffs = packs.flatMap((pack) => (pack.cutoffAtS === null ? [] : [{ pack, at: pack.cutoffAtS }]));
  const cutoff = cutoffs[0];
  const checks: FlightCheck[] = [
    check(
      'thrust_margin',
      control?.thrustMargin ?? null,
      limits.minThrustMargin,
      '>=',
      control === null ? 'open loop: no rotor limit' : '1 - weight / maximum thrust',
    ),
    check(
      'saturation_fraction',
      control?.saturationFraction ?? null,
      limits.maxSaturationFraction,
      '<=',
      'share of controller updates clipped by a rotor limit',
    ),
    check('max_attitude_deg', metrics.attitude.maxTiltDeg, limits.maxAttitudeDeg, '<=', 'largest tilt of the thrust axis from vertical'),
    check(
      'final_position_error_m',
      control === null ? null : metrics.tracking.finalPositionErrorM,
      limits.maxFinalPositionErrorM,
      '<=',
      control === null ? 'open loop: no set-point is tracked' : 'distance to the last set-point at the end of the run',
    ),
    neverRecovered
      ? { name: 'recovery_time_s', value: null, limit: limits.maxRecoveryTimeS, comparison: '<=', status: 'FAIL', note: recoveryNote }
      : check('recovery_time_s', control === null ? null : metrics.recoveryTimeS, limits.maxRecoveryTimeS, '<=', recoveryNote),
  ];
  checks.push(
    check(
      'battery_final_soc',
      packs.length === 0 ? null : Math.min(...packs.map((pack) => pack.finalSoc)),
      limits.minFinalSoc,
      '>=',
      packs.length === 0 ? 'no powertrain: no battery is drawn' : 'lowest state of charge over the packs at the end of the run',
    ),
  );
  if (cutoff !== undefined) {
    const at = cutoff.at;
    checks.push({
      name: 'battery_cutoff',
      value: at,
      limit: metrics.durationS,
      comparison: '>=',
      status: 'FAIL',
      note: `battery '${cutoff.pack.batteryId}' reached its cut-off at t = ${at.toFixed(3)} s: the motors stopped (FLT_BATTERY_CUTOFF)`,
    });
  }
  if (metrics.divergedAtS !== null)
    checks.push({
      name: 'diverged',
      value: metrics.divergedAtS,
      limit: 90,
      comparison: '<=',
      status: 'FAIL',
      note: `the thrust axis tilted past 90° at t = ${metrics.divergedAtS.toFixed(3)} s (FLT_DIVERGED)`,
    });
  const verdict = checks.some((entry) => entry.status === 'FAIL')
    ? 'FAIL'
    : checks.some((entry) => entry.status === 'MARGINAL')
      ? 'MARGINAL'
      : 'PASS';
  return { verdict, checks };
}
