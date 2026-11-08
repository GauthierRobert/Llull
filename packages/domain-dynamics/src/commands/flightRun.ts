/** Flying a scenario (13 FLT M2): run_flight (numbers + series) and flight_report (verdict against named limits). */

import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { codedRejection, report } from '@core/commands/noop';
import type { CadDocument } from '@core/model/types';
import { gciTriplet } from '@lib/convergence';
import { flightMetrics, flightSeries, type FlightMetrics } from '../flight/flightMetrics';
import { MAX_FLIGHT_STEPS, runFlight, type FlightRefusal, type FlightRun } from '../flight/flightRun';
import { flightOf } from '../flight/model';
import { DEFAULT_FLIGHT_LIMITS, flightVerdict, type FlightLimits } from '../flight/flightVerdict';

/** Physics step of a run unless given, s (2 kHz: a 400 Hz controller updates every 5 steps). */
const DEFAULT_TIMESTEP = 0.0005;
/** Recorded samples per second unless given. */
const DEFAULT_SAMPLE_RATE = 50;
/** Gauge of the convergence check (Roache safety factor for three levels). */
const GCI_SAFETY_FACTOR = 1.25;

const REMEDIATION: Readonly<Record<FlightRefusal['code'], string>> = {
  FLT_SCENARIO_UNKNOWN: 'Define it with define_flight_scenario (list them with inspect_dynamics).',
  FLT_BODY_NOT_FREE: 'Fly a free rigid body: no joint to another body, not fixed.',
  FLT_VEHICLE_MULTIBODY:
    'Merge the parts into one rigid body (add_rigid_body over all their entities) or remove the joints below it; multi-body vehicles come with FLT-M4.',
  FLT_MIXER_ILL_CONDITIONED: 'Spread the rotors so their arms and spins separate roll, pitch and yaw clearly, or fix the mixer.',
  FLT_MIXER_RANK:
    'Give every controlled rotor static thrust and an arm / spin layout that separates roll, pitch and yaw, or fix the mixer.',
  FLT_CONTROL_RATE: 'Pick a timestep that divides 1/rateHz (e.g. 0.0005 s for 400 Hz), or change the controller rate.',
  FLT_RUN_TOO_LONG: 'Shorten durationS or raise the timestep (at most 600 000 physics steps per run).',
  FLT_DIVERGED: 'Lower the gains, raise maxRpm, reduce the gust, or check the rotor spins / mixer signs.',
  FLT_MODEL_INVALID: 'Fix the physics model (inspect_dynamics) and run again.',
  FLT_NO_ENGINE: 'Wait for the physics engine (MuJoCo loads at startup) and retry.',
};

const timestepSchema = z
  .number()
  .min(1e-5)
  .max(0.005)
  .optional()
  .describe('Physics step, s; must divide the controller period 1/rateHz into whole steps. Default 0.0005 (2 kHz).');

const sampleRateSchema = z
  .number()
  .positive()
  .max(10000)
  .optional()
  .describe(
    'Recorded samples per second (at most 6001 samples per run, never finer than the timestep); the recovery times are read on these samples. Default 50.',
  );

const reject = (doc: CadDocument, command: string, refused: FlightRefusal): CommandResult =>
  codedRejection(doc, command, refused.code, refused.message, REMEDIATION[refused.code], refused.ids);

/** The run of `scenario`, refusing a document whose closed loop tilted past 90° (FLT_DIVERGED with the time and state). */
function fly(
  doc: CadDocument,
  scenario: string,
  timestep: number,
  sampleRate: number,
  ctx: ExecutionContext | undefined,
): { run: FlightRun; metrics: FlightMetrics } | FlightRefusal {
  const engine = ctx?.physics ?? null;
  if (engine === null) return { code: 'FLT_NO_ENGINE', message: 'no physics engine is loaded yet', ids: [] };
  const run = runFlight(doc, scenario, { timestep, sampleInterval: 1 / sampleRate }, engine, ctx?.kernel ?? null);
  if ('code' in run) return run;
  return { run, metrics: flightMetrics(run) };
}

const format = (value: number): string => (Number.isFinite(value) ? value.toPrecision(4) : String(value));

function metricsSummary(metrics: FlightMetrics): string {
  const control =
    metrics.control === null
      ? 'open loop'
      : `thrust/weight ${format(metrics.control.thrustToWeight)} (margin ${format(100 * metrics.control.thrustMargin)} %), saturation ${format(100 * metrics.control.saturationFraction)} %`;
  return (
    `${format(metrics.durationS)} s at ${metrics.timestepS} s (${metrics.engine}), ${metrics.samples} samples: max tilt ${format(metrics.attitude.maxTiltDeg)}° ` +
    `at ${format(metrics.attitude.maxTiltTimeS)} s, max rate ${format(metrics.attitude.maxRateDegS)} °/s, position error rms ${format(metrics.tracking.rmsPositionErrorM)} m / ` +
    `max ${format(metrics.tracking.maxPositionErrorM)} m / final ${format(metrics.tracking.finalPositionErrorM)} m, recovery ${metrics.recoveryTimeS === null ? 'n/a' : `${format(metrics.recoveryTimeS)} s`}, ` +
    `${control}, shaft power mean ${format(metrics.power.meanShaftPowerW)} W / peak ${format(metrics.power.peakShaftPowerW)} W / final ${format(metrics.power.finalShaftPowerW)} W` +
    `${metrics.unverified ? `; unverified (${metrics.defaulted.length} input(s) defaulted, see data.defaulted)` : ''}${metrics.warnings.length > 0 ? `; warnings: ${[...new Set(metrics.warnings.map((warning) => warning.split(':')[0]))].join(', ')}` : ''}.`
  );
}

/**
 * @affects nothing — read-only; data = FlightMetrics (+ series with detail "series")
 * @invariant deterministic: the same document, scenario and timestep give bit-identical data; records nothing in the document
 * @invariant kernel-optional: body mass properties are exact with a kernel, mesh integration otherwise (as simulate_motion)
 * @failure no engine -> FLT_NO_ENGINE; unknown scenario, non-free body, mixer rank, timestep not dividing the controller period, more than
 *          600 000 steps, a vehicle body carrying jointed bodies (FLT_VEHICLE_MULTIBODY), an ill-conditioned mixer, an invalid physics model, a NaN state or a closed-loop tilt past 90° (FLT_DIVERGED, with time and state) -> rejected
 */
export const runFlightCommand = defineCommand({
  name: 'run_flight',
  annotations: { kernelOptional: true, readsMeshTriangles: true, readOnly: true },
  description:
    'Fly a flight scenario (define_flight_scenario) on the rigid-body physics (MuJoCo) with its flight controller in the loop (13 FLT): the ' +
    'controller (add_flight_controller) updates at its rate between physics steps and commands the rotor speeds, every rotor (add_rotor) ' +
    'thrusts along its body axis with J from the body state under the scenario wind, body drag (set_body_drag) turns with the body. Read-only, ' +
    'deterministic (bit-identical on replay). data: vehicle mass / inertia; attitude (max tilt of the thrust axis from vertical and when, ' +
    'max body rate, final roll / pitch / yaw); tracking (rms / max / final position error to the set-point in m, final yaw error); events ' +
    '(each set-point change and gust with its recovery time into the settle band and peak error); recoveryTimeS; control (controller ' +
    'updates, saturationFraction = share clipped by a rotor limit, max thrust, thrust/weight, thrustMargin = 1 - weight / max thrust); power ' +
    '(shaft energy J, mean / peak / final shaft power W); per rotor the final rpm, thrust, shaft power, advance ratio, momentum-theory ideal ' +
    'power and figure of merit (hover only), J range against the validated range of its coefficients (FLT_OUTSIDE_VALIDATED_RANGE); ' +
    'defaulted inputs (unverified). Peaks and integrals are exact per physics step; recovery uses the samples. detail "series" adds per-sample ' +
    'position offset, set-point, velocity, attitude, tilt, body rates, wind and per-rotor rpm / thrust / power. A closed loop tilting past ' +
    '90° or a NaN state is refused as FLT_DIVERGED with the time. The vehicle is ONE free rigid body: a body with other bodies jointed below it is refused (FLT_VEHICLE_MULTIBODY, until FLT-M4); a rotor layout whose mixer is nearly singular is refused (FLT_MIXER_ILL_CONDITIONED). Use flight_report for a PASS / MARGINAL / FAIL verdict.',
  params: z.object({
    scenario: z.string().describe('Id of the flight scenario (define_flight_scenario).'),
    timestep: timestepSchema,
    sampleRate: sampleRateSchema,
    detail: z.enum(['summary', 'series']).optional().describe('"summary" (default): numbers only; "series" adds the per-sample series.'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const flown = fly(doc, params.scenario, params.timestep ?? DEFAULT_TIMESTEP, params.sampleRate ?? DEFAULT_SAMPLE_RATE, ctx);
    if ('code' in flown) return reject(doc, 'run_flight', flown);
    const { run, metrics } = flown;
    if (metrics.divergedAtS !== null) {
      const at = metrics.attitude;
      return codedRejection(
        doc,
        'run_flight',
        'FLT_DIVERGED',
        `the closed loop tilted past 90° at t = ${metrics.divergedAtS.toFixed(4)} s (max tilt ${format(at.maxTiltDeg)}° at ${format(at.maxTiltTimeS)} s, final offset [${metrics.tracking.finalOffsetM.map(format).join(', ')}] m)`,
        REMEDIATION.FLT_DIVERGED,
        [params.scenario],
        [],
        {
          divergedAtS: metrics.divergedAtS,
          maxTiltDeg: at.maxTiltDeg,
          finalOffsetM: metrics.tracking.finalOffsetM,
          finalAttitude: at.final,
        },
      );
    }
    const data = params.detail === 'series' ? { ...metrics, series: flightSeries(run) } : metrics;
    return report(doc, `run_flight: '${params.scenario}' — ${metricsSummary(metrics)}`, data);
  },
});

const limitsSchema = z
  .object({
    minThrustMargin: z.number().optional().describe('Least share of the max thrust left at hover. Default 0.3.'),
    maxSaturationFraction: z.number().min(0).max(1).optional().describe('Largest share of clipped controller updates. Default 0.05.'),
    maxAttitudeDeg: z.number().positive().optional().describe('Largest tilt from vertical, deg. Default 45.'),
    maxFinalPositionErrorM: z.number().positive().optional().describe('Largest position error at the end, m. Default 0.1.'),
    maxRecoveryTimeS: z.number().positive().optional().describe('Largest recovery time after an event, s. Default 5.'),
  })
  .optional()
  .describe('Named limits of the verdict; each omitted one takes its default (listed in data.limitsDefaulted).');

/**
 * @affects nothing — read-only; data { verdict, checks[], limits, limitsDefaulted, hover, metrics, timestepCheck? }
 * @invariant runs the scenario exactly as run_flight at the same timestep and sampleRate (same numbers); a closed loop past 90° is a FAIL
 *            verdict with a `diverged` check; a timestep check is bounded by the summed steps of its three runs (FLT_RUN_TOO_LONG)
 * @invariant kernel-optional: body mass properties are exact with a kernel, mesh integration otherwise (as simulate_motion)
 * @failure no engine, unknown scenario, a run run_flight refuses (except a tilt past 90°), a timestep check whose three runs sum to more than
 *          600 000 steps (FLT_RUN_TOO_LONG) -> rejected with the code
 */
export const flightReportCommand = defineCommand({
  name: 'flight_report',
  annotations: { kernelOptional: true, readsMeshTriangles: true, readOnly: true },
  description:
    'Verdict of a flight scenario (13 FLT): runs it exactly as run_flight and judges the numbers against named limits, each overridable: ' +
    'thrust_margin >= 0.3 (1 - weight / max thrust), saturation_fraction <= 0.05, max_attitude_deg <= 45, final_position_error_m <= 0.1, ' +
    'recovery_time_s <= 5 (largest recovery after a set-point change or gust; an event that never recovers fails). Each check is PASS, ' +
    'MARGINAL (passes within 10 % of its limit), FAIL or not_applicable (e.g. thrust margin of an open-loop flight); verdict FAIL on any ' +
    'failure or a divergence (thrust axis past 90°), MARGINAL on any marginal check, else PASS. data.hover: total final shaft power, ' +
    'momentum-theory ideal power T^1.5 / sqrt(2ρA) summed over the rotors and the figure of merit (ideal / shaft) — meaningful once the ' +
    'vehicle hovers. data.metrics is the run_flight data at the same timestep and sampleRate (no series). `timestepCheck: true` also flies ' +
    'the scenario at timestep/2 and timestep/4 and gives the observed order and the GCI (Celik, Fs 1.25) of the max tilt (FR-FLT-16); the ' +
    'three runs together (7× the steps of one) must stay within the 600 000-step budget of a run, else FLT_RUN_TOO_LONG with the summed count. ' +
    'Read-only, deterministic.',
  params: z.object({
    scenario: z.string().describe('Id of the flight scenario (define_flight_scenario).'),
    timestep: timestepSchema,
    sampleRate: sampleRateSchema,
    limits: limitsSchema,
    timestepCheck: z.boolean().optional().describe('Also run at timestep/2 and /4 and report the GCI of the max tilt. Default false.'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const timestep = params.timestep ?? DEFAULT_TIMESTEP;
    const sampleRate = params.sampleRate ?? DEFAULT_SAMPLE_RATE;
    const check = params.timestepCheck === true;
    const scenarios = flightOf(doc).scenarios ?? {};
    const durationS = Object.hasOwn(scenarios, params.scenario) ? scenarios[params.scenario]?.durationS : undefined;
    if (check && durationS !== undefined) {
      const total = [timestep, timestep / 2, timestep / 4].reduce((sum, step) => sum + Math.round(durationS / step), 0);
      if (total > MAX_FLIGHT_STEPS)
        return reject(doc, 'flight_report', {
          code: 'FLT_RUN_TOO_LONG',
          message: `the timestep check flies ${total} physics steps in total over timestep, timestep/2 and timestep/4 (at most ${MAX_FLIGHT_STEPS}): shorten the scenario, raise the timestep or drop timestepCheck`,
          ids: [params.scenario],
        });
    }
    const finest = check ? fly(doc, params.scenario, timestep / 4, sampleRate, ctx) : null;
    if (finest !== null && 'code' in finest) return reject(doc, 'flight_report', finest);
    const flown = fly(doc, params.scenario, timestep, sampleRate, ctx);
    if ('code' in flown) return reject(doc, 'flight_report', flown);
    const { metrics } = flown;
    const given = params.limits ?? {};
    const limitsDefaulted = (Object.keys(DEFAULT_FLIGHT_LIMITS) as (keyof FlightLimits)[]).filter((key) => given[key] === undefined);
    const limits: FlightLimits = {
      ...DEFAULT_FLIGHT_LIMITS,
      ...Object.fromEntries(Object.entries(given).filter(([, value]) => value !== undefined)),
    };
    const { verdict, checks } = flightVerdict(metrics, limits);
    const rotors = Object.values(metrics.rotors);
    const shaft = rotors.reduce((sum, rotor) => sum + rotor.finalShaftPowerW, 0);
    const ideal = rotors.reduce((sum, rotor) => sum + rotor.idealPowerW, 0);
    const hover = {
      totalShaftPowerW: shaft,
      totalIdealPowerW: ideal,
      figureOfMerit: shaft > 0 && rotors.every((rotor) => rotor.figureOfMerit !== null) ? ideal / shaft : null,
    };
    let timestepCheck: Record<string, unknown> | undefined;
    if (finest !== null) {
      const half = fly(doc, params.scenario, timestep / 2, sampleRate, ctx);
      if ('code' in half) return reject(doc, 'flight_report', half);
      const levels = [metrics, half.metrics, finest.metrics].map((entry) => entry.attitude.maxTiltDeg);
      timestepCheck = {
        quantity: 'attitude.maxTiltDeg',
        timestepsS: [timestep, timestep / 2, timestep / 4],
        values: levels,
        gci: gciTriplet(
          [
            { h: timestep / 4, value: finest.metrics.attitude.maxTiltDeg },
            { h: timestep / 2, value: half.metrics.attitude.maxTiltDeg },
            { h: timestep, value: metrics.attitude.maxTiltDeg },
          ],
          GCI_SAFETY_FACTOR,
        ),
      };
    }
    const failedChecks = checks.filter((entry) => entry.status === 'FAIL' || entry.status === 'MARGINAL');
    const gci = timestepCheck?.['gci'] as { gci21Fine?: number } | undefined;
    return report(
      doc,
      `flight_report: '${params.scenario}' — ${verdict}` +
        `${failedChecks.length === 0 ? '' : ` (${failedChecks.map((entry) => `${entry.name} ${entry.status} ${entry.value === null ? 'n/a' : format(entry.value)} vs ${entry.comparison} ${format(entry.limit)}`).join('; ')})`}; ` +
        `hover shaft ${format(shaft)} W, ideal ${format(ideal)} W, FM ${hover.figureOfMerit === null ? 'n/a' : format(hover.figureOfMerit)}` +
        `${timestepCheck === undefined ? '' : `; max-tilt GCI ${gci?.gci21Fine === undefined ? 'not monotone' : `${format(100 * gci.gci21Fine)} %`}`}. ${metricsSummary(metrics)}`,
      { verdict, checks, limits, limitsDefaulted, hover, metrics, ...(timestepCheck === undefined ? {} : { timestepCheck }) },
    );
  },
});
