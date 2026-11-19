/**
 * Verdict of a flight run against named, overridable limits (FR-FLT-07): each check PASS / MARGINAL (passes within 10 % of its limit) / FAIL
 * / not_applicable; the run is FAIL on any failed check or a divergence, MARGINAL on any marginal check, else PASS.
 */

import type { FlightMetrics } from './flightMetrics';
import { minOf } from '@lib/arrayExtrema';
import { appendAll } from '@lib/appendAll';

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
  /** Least battery endurance (cut-off time, or its estimate at the final current), s; no default: checked only when given (13 FLT M3b). */
  readonly minEnduranceS?: number;
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

/** `band`: the MARGINAL width, default MARGINAL_SHARE of |limit| (a temperature limit passes its own band: a share of the allowed rise). */
function check(
  name: string,
  value: number | null,
  limit: number,
  comparison: '>=' | '<=',
  note: string,
  band = Math.abs(limit) * MARGINAL_SHARE,
): FlightCheck {
  if (value === null) return { name, value, limit, comparison, status: 'not_applicable', note };
  const passes = comparison === '>=' ? value >= limit : value <= limit;
  const close = comparison === '>=' ? value < limit + band : value > limit - band;
  return { name, value, limit, comparison, status: !passes ? 'FAIL' : close ? 'MARGINAL' : 'PASS', note };
}

type Pack = FlightMetrics['battery'][string];

/** The opt-in endurance check (only with `limits.minEnduranceS`) and the winding check (only when a motor tracks its temperature). */
function powerLimitChecks(packs: readonly Pack[], limits: FlightLimits): FlightCheck[] {
  const checks: FlightCheck[] = [];
  const minimum = limits.minEnduranceS;
  if (minimum !== undefined) {
    const timed = packs.flatMap((pack) => (pack.enduranceS === null ? [] : [{ pack, enduranceS: pack.enduranceS }]));
    const shortest = timed.reduce<(typeof timed)[number] | null>(
      (least, entry) => (least === null || entry.enduranceS < least.enduranceS ? entry : least),
      null,
    );
    const found = check(
      'battery_endurance_s',
      shortest?.enduranceS ?? null,
      minimum,
      '>=',
      shortest === null
        ? packs.length === 0
          ? 'no powertrain: no battery is drawn'
          : 'no pack carries a load: no endurance'
        : `shortest endurance over the packs: battery '${shortest.pack.batteryId}' (${shortest.pack.enduranceBasis === 'cutoff_reached' ? 'cut-off reached in the run' : 'ESTIMATE: run time + the final current down to the cut-off floor; estimate_endurance integrates it'})`,
    );
    checks.push(found.status === 'FAIL' ? { ...found, note: `FLT_ENDURANCE_SHORT: ${found.note}` } : found);
  }
  const heated = packs.flatMap((pack) => (pack.motorThermal === undefined ? [] : [pack.motorThermal]));
  const hottest = heated.reduce<(typeof heated)[number] | null>(
    (most, entry) => (most === null || entry.peakWindingC - entry.maxWindingC > most.peakWindingC - most.maxWindingC ? entry : most),
    null,
  );
  if (hottest !== null)
    checks.push(
      check(
        'motor_winding_c',
        hottest.peakWindingC,
        hottest.maxWindingC,
        '<=',
        `hottest motor winding of the run (rotor '${hottest.hottestRotorId}', ambient ${hottest.ambientC} C; MARGINAL within 10 % of the allowed rise maxWindingC - ambient)${hottest.overLimitAtS === null ? '' : `: FLT_MOTOR_OVERTEMP from t = ${hottest.overLimitAtS.toFixed(3)} s`}`,
        Math.abs(hottest.maxWindingC - hottest.ambientC) * MARGINAL_SHARE,
      ),
    );
  return checks;
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
      packs.length === 0 ? null : minOf(packs.map((pack) => pack.finalSoc)),
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
  appendAll(checks, powerLimitChecks(packs, limits));
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
