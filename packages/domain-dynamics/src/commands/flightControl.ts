/** Flight controller and flight scenario records (13 FLT M2): add_flight_controller, define_flight_scenario. */

import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, vec3, z } from '@core/commands/schema';
import { changed, codedRejection, failer } from '@core/commands/noop';
import { toMetres } from '@core/model/units';
import type { Vec3 } from '@core/model/vectors';
import { idOrNext } from '@lib/explicitId';
import { scale3 } from '@lib/vec3';
import type { FlightController, FlightScenario, PidGains } from '../flight/controlModel';
import { turbulenceProblem } from '../flight/aeroDocument';
import { meanAxis } from '../flight/flightBlock';
import { mixerRotors, thrustPerRpmSquared } from '../flight/flightRun';
import { assessMixer, effectiveness } from '../flight/mixer';
import { flightOf, idTakenInDynamicsOrFlight } from '../flight/model';
import { compileRotor } from '../flight/rotorLaw';
import { dynamicsOf } from './bodies';

/** Defaults of the controller inputs (normalised gains: they suit any vehicle size, see FlightController). Each use is listed in `defaulted`. */
const CONTROLLER_DEFAULTS = {
  rateHz: 400,
  minRpm: 0,
  motorTimeConstantS: 0.03,
  position: [1, 1, 1.5] as Vec3,
  velocity: { p: [2, 2, 3] as Vec3, i: [0.5, 0.5, 1] as Vec3, d: [0, 0, 0] as Vec3 },
  attitude: [6, 6, 3] as Vec3,
  rate: { p: [20, 20, 10] as Vec3, i: [5, 5, 2] as Vec3, d: [0, 0, 0] as Vec3 },
  maxTiltDeg: 35,
  maxHorizontalSpeedMps: 5,
  maxVerticalSpeedMps: 3,
  maxRateDegS: [220, 220, 120] as Vec3,
} as const;

const SCENARIO_DEFAULTS = { settleBandM: 0.1, turbulenceAirspeedMps: 10, turbulenceLengthScaleM: [200, 200, 200] as Vec3 } as const;
/** Heading of a set-point without yawDeg: the start heading (not a modelling default: the documented hold of the start pose). */
const START_HEADING_DEG = 0;

const NON_NEGATIVE_VEC3 = z.tuple([z.number().min(0), z.number().min(0), z.number().min(0)]);

const PID_GAINS = z.object({
  p: NON_NEGATIVE_VEC3.optional().describe('Proportional gain per axis.'),
  i: NON_NEGATIVE_VEC3.optional().describe('Integral gain per axis (0 = no integrator).'),
  d: NON_NEGATIVE_VEC3.optional().describe('Derivative gain per axis, on the measurement (0 = none).'),
});

const pidSchema = (loop: string, units: string): z.ZodOptional<typeof PID_GAINS> =>
  PID_GAINS.optional().describe(`${loop} loop PID gains (${units}); each omitted one takes its default.`);

/** Why `bodyId` cannot fly (missing or fixed), or null. */
function bodyProblem(doc: CadDocument, bodyId: string): string | null {
  const bodies = dynamicsOf(doc).bodies;
  const body = Object.hasOwn(bodies, bodyId) ? bodies[bodyId] : undefined;
  if (body === undefined) return `body '${bodyId}' is not a rigid body (add_rigid_body first)`;
  return body.fixed ? `body '${bodyId}' is fixed to the ground; a flight vehicle is a free body` : null;
}

const format = (value: number): string => value.toPrecision(4);

/** A value and whether it was defaulted (the name goes to `defaulted`). */
function pick<T>(given: T | undefined, fallback: T, name: string, defaulted: string[]): T {
  if (given !== undefined) return given;
  defaulted.push(name);
  return fallback;
}

function pidOf(
  given: { p?: Vec3 | undefined; i?: Vec3 | undefined; d?: Vec3 | undefined } | undefined,
  fallback: PidGains,
  name: string,
  defaulted: string[],
): PidGains {
  return {
    p: pick(given?.p, fallback.p, `${name}.p`, defaulted),
    i: pick(given?.i, fallback.i, `${name}.i`, defaulted),
    d: pick(given?.d, fallback.d, `${name}.d`, defaulted),
  };
}

/**
 * @affects adds 1 flight controller to doc.flight.controllers (affected: [controllerId])
 * @invariant body is a non-fixed rigid body; every rotor is on it; minRpm < maxRpm; the mixer (given or geometric) commands 4 axes
 * @invariant gains are normalised (acceleration / angular acceleration out); every defaulted input is listed in the record's `defaulted`
 * @failure unknown / fixed body, no rotor, a rotor on another body or listed twice, minRpm >= maxRpm, a mixer row count that is not the rotor
 *          count, taken id -> no-op; a rotor without static thrust or a mixer of rank < 4 -> FLT_MIXER_RANK; a nearly singular one
 *          (Gram pivot ratio < 1e-8) -> FLT_MIXER_ILL_CONDITIONED
 */
export const addFlightController = defineCommand({
  name: 'add_flight_controller',
  description:
    'Give a free rigid body (a multirotor airframe with add_rotor rotors on it) a cascaded PID flight controller for run_flight (13 FLT). ' +
    'Every 1/rateHz s it reads the body state and runs: position error -> velocity set-point (P, limited to maxHorizontalSpeedMps / ' +
    'maxVerticalSpeedMps) -> acceleration (PID) -> thrust vector m·(a - g) with its tilt limited to maxTiltDeg -> attitude set-point (thrust ' +
    'axis along it, heading = the set-point yaw) -> body-rate set-point (P on the quaternion error, limited to maxRateDegS) -> angular ' +
    'acceleration (PID) -> torque J·α + ω × Jω -> mixer -> rotor thrusts within [minRpm, maxRpm] (yaw torque given up first, then clamped; ' +
    'integrators hold while saturated) -> rotor speeds by the inverse rotor law at J = 0, each following its command with a first-order lag ' +
    'motorTimeConstantS. Gains are NORMALISED (the velocity loop outputs m/s², the rate loop rad/s²; mass and inertia come from the body), ' +
    'so the defaults fly any size of multirotor; every defaulted input is listed in the record and makes results `unverified`. Mixer: by ' +
    'default the pseudo-inverse of the rotor geometry (thrust axis, arm about the centre of mass, reaction torque Cp·D/(2π·Ct) per newton); ' +
    "or give `mixer`. A mixer that cannot command collective thrust, roll, pitch and yaw is refused (FLT_MIXER_RANK), and so is a nearly singular one (rotors almost in a line: FLT_MIXER_ILL_CONDITIONED, smallest Gram pivot of the row-normalised effectiveness under 1e-8 of the largest). The rotors' own rpm " +
    'is ignored while the controller flies them. Define a scenario with define_flight_scenario, then run_flight / flight_report. Returns the ' +
    'controller id in affected[0].',
  params: z.object({
    body: z.string().describe('Id of the free rigid body (the airframe) the controller flies.'),
    rotors: z
      .array(z.string())
      .min(1)
      .optional()
      .describe('Ids of the rotors it commands, in mixer row order; default every rotor on the body (in creation order).'),
    maxRpm: z.number().positive().max(200000).describe('Largest rotor speed, rev/min (sets the maximum thrust and the thrust margin).'),
    minRpm: z.number().min(0).optional().describe('Smallest rotor speed (idle), rev/min. Default 0.'),
    rateHz: z
      .number()
      .min(1)
      .max(5000)
      .optional()
      .describe('Controller update rate, Hz. Default 400; run_flight needs a timestep dividing 1/rateHz.'),
    motorTimeConstantS: z
      .number()
      .min(0)
      .max(2)
      .optional()
      .describe('First-order lag of the rotor speed behind its command, s (0 = instantaneous). Default 0.03.'),
    gains: z
      .object({
        position: NON_NEGATIVE_VEC3.optional().describe('Position P gain, 1/s, world x, y, z. Default [1, 1, 1.5].'),
        velocity: pidSchema('Velocity', 'm/s² per m/s, world x, y, z; default p [2, 2, 3], i [0.5, 0.5, 1], d [0, 0, 0]'),
        attitude: NON_NEGATIVE_VEC3.optional().describe('Attitude P gain, 1/s, roll, pitch, yaw. Default [6, 6, 3].'),
        rate: pidSchema('Body-rate', 'rad/s² per rad/s, roll, pitch, yaw; default p [20, 20, 10], i [5, 5, 2], d [0, 0, 0]'),
      })
      .optional()
      .describe('Normalised cascade gains; each omitted one takes its default.'),
    limits: z
      .object({
        maxTiltDeg: z.number().positive().max(80).optional().describe('Largest commanded tilt from vertical, deg. Default 35.'),
        maxHorizontalSpeedMps: z.number().positive().optional().describe('Largest commanded horizontal speed, m/s. Default 5.'),
        maxVerticalSpeedMps: z.number().positive().optional().describe('Largest commanded climb / descent rate, m/s. Default 3.'),
        maxRateDegS: z
          .tuple([z.number().positive(), z.number().positive(), z.number().positive()])
          .optional()
          .describe('Largest commanded body rate about roll, pitch, yaw, deg/s. Default [220, 220, 120].'),
      })
      .optional()
      .describe('Set-point limits; each omitted one takes its default.'),
    mixer: z
      .array(z.tuple([z.number(), z.number(), z.number(), z.number()]))
      .optional()
      .describe(
        'Explicit mixer: one row per rotor (rotors order), thrust N = row · [collective N, roll N·m, pitch N·m, yaw N·m] (body axes). Default: pseudo-inverse of the geometry.',
      ),
    id: z.string().optional().describe('Optional explicit controller id (shares the id space of the dynamics records).'),
  }),
  run: (doc, params): CommandResult => {
    const fail = failer(doc, 'add_flight_controller');
    const problem = bodyProblem(doc, params.body);
    if (problem !== null) return fail(problem);
    const flight = flightOf(doc);
    const onBody = Object.values(flight.rotors).filter((rotor) => rotor.bodyId === params.body);
    const rotorIds = params.rotors ?? onBody.map((rotor) => rotor.id);
    if (rotorIds.length === 0) return fail(`body '${params.body}' has no rotor (add_rotor first)`);
    if (new Set(rotorIds).size !== rotorIds.length) return fail('a rotor is listed twice');
    const stray = rotorIds.find((id) => !onBody.some((rotor) => rotor.id === id));
    if (stray !== undefined) return fail(`'${stray}' is not a rotor on body '${params.body}'`);
    const defaulted: string[] = [];
    const minRpm = pick(params.minRpm, CONTROLLER_DEFAULTS.minRpm, 'minRpm', defaulted);
    if (!(minRpm < params.maxRpm)) return fail(`minRpm ${minRpm} must be below maxRpm ${params.maxRpm}`);
    if (params.mixer !== undefined && params.mixer.length !== rotorIds.length)
      return fail(`mixer has ${params.mixer.length} rows for ${rotorIds.length} rotors`);
    const id = idOrNext(params.id, 'controller');
    if (idTakenInDynamicsOrFlight(doc, id)) return fail(`id '${id}' is already used`);
    // rank on the geometry about the centroid of the hubs (the run checks it again about the actual centre of mass)
    const metres = toMetres(doc, 1);
    const own = rotorIds.flatMap((rotorId) => onBody.filter((rotor) => rotor.id === rotorId));
    const centroid = scale3(
      own.reduce<Vec3>((sum, rotor) => [sum[0] + rotor.hub[0], sum[1] + rotor.hub[1], sum[2] + rotor.hub[2]], [0, 0, 0]),
      metres / own.length,
    );
    const compiled = own.map((rotor) => compileRotor(rotor, centroid, metres));
    const dead = compiled.find((rotor) => !(thrustPerRpmSquared(rotor) > 0));
    if (dead !== undefined)
      return codedRejection(
        doc,
        'add_flight_controller',
        'FLT_MIXER_RANK',
        `rotor '${dead.rotor.id}' has no static thrust (Ct = 0 at J = 0), the controller cannot command it`,
        'Give the rotor measured coefficients (add_rotor) or leave it out of `rotors`.',
        [dead.rotor.id],
      );
    const b = effectiveness(mixerRotors(compiled), meanAxis(compiled));
    const assessed = assessMixer(b, params.mixer ?? null);
    if ('code' in assessed)
      return codedRejection(
        doc,
        'add_flight_controller',
        assessed.code,
        `the ${params.mixer === undefined ? 'rotor geometry' : 'mixer'} ${assessed.message}`,
        'Use at least 4 rotors whose arms and spins separate roll, pitch and yaw clearly (a quad X with alternating spins), or fix `mixer`.',
        rotorIds,
      );
    const gains = params.gains;
    const limits = params.limits;
    const controller: FlightController = {
      id,
      bodyId: params.body,
      rotorIds,
      rateHz: pick(params.rateHz, CONTROLLER_DEFAULTS.rateHz, 'rateHz', defaulted),
      gains: {
        position: pick(gains?.position, CONTROLLER_DEFAULTS.position, 'gains.position', defaulted),
        velocity: pidOf(gains?.velocity, CONTROLLER_DEFAULTS.velocity, 'gains.velocity', defaulted),
        attitude: pick(gains?.attitude, CONTROLLER_DEFAULTS.attitude, 'gains.attitude', defaulted),
        rate: pidOf(gains?.rate, CONTROLLER_DEFAULTS.rate, 'gains.rate', defaulted),
      },
      limits: {
        maxTiltDeg: pick(limits?.maxTiltDeg, CONTROLLER_DEFAULTS.maxTiltDeg, 'limits.maxTiltDeg', defaulted),
        maxHorizontalSpeedMps: pick(
          limits?.maxHorizontalSpeedMps,
          CONTROLLER_DEFAULTS.maxHorizontalSpeedMps,
          'limits.maxHorizontalSpeedMps',
          defaulted,
        ),
        maxVerticalSpeedMps: pick(
          limits?.maxVerticalSpeedMps,
          CONTROLLER_DEFAULTS.maxVerticalSpeedMps,
          'limits.maxVerticalSpeedMps',
          defaulted,
        ),
        maxRateDegS: pick(limits?.maxRateDegS, CONTROLLER_DEFAULTS.maxRateDegS, 'limits.maxRateDegS', defaulted),
      },
      minRpm,
      maxRpm: params.maxRpm,
      motorTimeConstantS: pick(params.motorTimeConstantS, CONTROLLER_DEFAULTS.motorTimeConstantS, 'motorTimeConstantS', defaulted),
      mixer: params.mixer ?? null,
      defaulted,
    };
    const maxThrust = compiled.reduce((sum, rotor) => sum + thrustPerRpmSquared(rotor) * params.maxRpm ** 2, 0);
    return changed(
      { ...doc, flight: { ...flight, controllers: { ...flight.controllers, [id]: controller } } },
      `add_flight_controller: '${id}' flies body '${params.body}' with ${rotorIds.length} rotors (${rotorIds.join(', ')}) at ${format(controller.rateHz)} Hz, ` +
        `${params.mixer === undefined ? 'geometric' : 'explicit'} mixer of rank 4, ${format(minRpm)}-${format(params.maxRpm)} rpm (max thrust ${format(maxThrust)} N at J = 0), ` +
        `motor lag ${format(controller.motorTimeConstantS)} s; ${defaulted.length === 0 ? 'no input defaulted' : `${defaulted.length} input(s) defaulted (results unverified): ${defaulted.join(', ')}`}.`,
      [id],
    );
  },
});

/**
 * @affects adds 1 flight scenario to doc.flight.scenarios (affected: [scenarioId])
 * @invariant set-point times strictly increase from 0 and stay below durationS; gusts start inside the run with a positive duration
 * @failure unknown / fixed body, unknown controller or a controller of another body, set-points not starting at 0 / not increasing / past
 *          the end, a gust starting after the end, taken id -> no-op
 */
export const defineFlightScenario = defineCommand({
  name: 'define_flight_scenario',
  description:
    'Define a flight for run_flight / flight_report (13 FLT): the vehicle body, the controller flying it (add_flight_controller; omit for an ' +
    'open-loop flight where rotors keep their own rpm, e.g. a torque-free tumbling body), the duration, set-points over time, the initial ' +
    'velocity and angular velocity of the body, and the wind. Set-points hold from their time until the next one (steps): `position` is the ' +
    'OFFSET of the centre of mass from where it starts, in METRES, world axes (Z up), `yawDeg` the heading about world Z from the start ' +
    'heading; the first set-point must be at t = 0 (default: one hold at the start pose). Wind (world, m/s): `steady` plus 1-cosine gusts ' +
    'v = (peak/2)(1 - cos(2π(t - startS)/durationS)) during [startS, startS + durationS]; it acts on rotor inflow (advance ratio) and ' +
    'body drag (set_body_drag) and aero surfaces (generate_aero_table); `wind.turbulence` adds seeded Dryden turbulence (same seed, same series). Set-points may carry `pivotDeg` per aero surface with a pivot servo (the servo slews at its rate limit). `settleBandM` (default 0.1 m) is the position error under which the vehicle counts as recovered after each ' +
    'event (a set-point change or a gust start). Example hover + 1 m climb + side gust: durationS 10, setpoints [{t: 0}, {t: 4, position: ' +
    '[0, 0, 1]}], wind {gusts: [{startS: 6, durationS: 1, peak: [3, 0, 0]}]}. Returns the scenario id in affected[0].',
  params: z.object({
    body: z.string().describe('Id of the free rigid body that flies.'),
    controller: z.string().optional().describe('Id of the flight controller of that body; omit for an open-loop flight.'),
    durationS: z.number().positive().max(600).describe('Simulated seconds (run_flight refuses more than 600 000 physics steps).'),
    setpoints: z
      .array(
        z.object({
          t: z.number().min(0).describe('Time the set-point starts, s.'),
          position: vec3('Centre-of-mass offset from the start, METRES, world axes. Default [0, 0, 0].').optional(),
          yawDeg: z.number().optional().describe('Heading about world Z from the start heading, deg. Default 0.'),
          pivotDeg: z
            .record(z.string(), z.number())
            .optional()
            .describe(
              'Pivot angle commanded to aero surfaces with a servo (generate_aero_table pivotsDeg), deg, keyed by surface id; the servo slews toward it at its rate limit and holds it until a later set-point names the surface. Values must lie inside the servo limits.',
            ),
        }),
      )
      .min(1)
      .max(1000)
      .optional()
      .describe('Set-points in time order, the first at t = 0. Default one hold of the start pose.'),
    initialVelocity: vec3('Velocity of the centre of mass at t = 0, m/s, world. Default at rest.').optional(),
    initialAngularVelocity: vec3('Angular velocity at t = 0, rad/s, world. Default none.').optional(),
    wind: z
      .object({
        steady: vec3('Steady wind, m/s, world. Default [0, 0, 0].').optional(),
        gusts: z
          .array(
            z.object({
              startS: z.number().min(0).describe('Gust start, s.'),
              durationS: z.number().positive().describe('Gust length, s.'),
              peak: vec3('Peak gust air velocity, m/s, world.'),
            }),
          )
          .max(100)
          .optional()
          .describe('1-cosine gusts.'),
        turbulence: z
          .object({
            sigmaMps: vec3('Standard deviation of the u (x), v (y), w (z) turbulence components, m/s, world axes.'),
            airspeedMps: z
              .number()
              .positive()
              .optional()
              .describe('Airspeed the frozen-field spectrum is evaluated at, m/s (Ω = ω / V). Default 10 (listed in defaulted).'),
            lengthScaleM: vec3('Dryden scale lengths Lu, Lv, Lw, m. Default [200, 200, 200] (listed in defaulted).').optional(),
            seed: z
              .number()
              .int()
              .min(0)
              .max(Number.MAX_SAFE_INTEGER)
              .describe('Seed of the white noise: the same seed gives the same series.'),
          })
          .optional()
          .describe(
            'Dryden turbulence (MIL-HDBK-1797 spectra, realised by forming filters on seeded Gaussian noise every 5 ms, linear between samples), added to steady + gusts.',
          ),
      })
      .optional()
      .describe('World air velocity; default calm.'),
    settleBandM: z.number().positive().optional().describe('Recovery band on the position error, m. Default 0.1.'),
    id: z.string().optional().describe('Optional explicit scenario id (shares the id space of the dynamics records).'),
  }),
  run: (doc, params): CommandResult => {
    const fail = failer(doc, 'define_flight_scenario');
    const problem = bodyProblem(doc, params.body);
    if (problem !== null) return fail(problem);
    const flight = flightOf(doc);
    const controllers = flight.controllers ?? {};
    const controllerId = params.controller ?? null;
    if (controllerId !== null) {
      const controller = Object.hasOwn(controllers, controllerId) ? controllers[controllerId] : undefined;
      if (controller === undefined) return fail(`no flight controller '${controllerId}' (add_flight_controller first)`);
      if (controller.bodyId !== params.body)
        return fail(`controller '${controllerId}' flies body '${controller.bodyId}', not '${params.body}'`);
    }
    const setpoints = (params.setpoints ?? [{ t: 0 }]).map((setpoint) => ({
      t: setpoint.t,
      position: setpoint.position ?? ([0, 0, 0] as Vec3),
      yawDeg: setpoint.yawDeg ?? START_HEADING_DEG,
      ...(setpoint.pivotDeg === undefined ? {} : { pivotDeg: setpoint.pivotDeg }),
    }));
    for (const setpoint of setpoints)
      for (const [surfaceId, angle] of Object.entries(setpoint.pivotDeg ?? {})) {
        const surface = Object.hasOwn(flight.aeroSurfaces ?? {}, surfaceId) ? flight.aeroSurfaces?.[surfaceId] : undefined;
        if (surface === undefined || surface.servo === null)
          return fail(`'${surfaceId}' is not an aero surface with a pivot servo (generate_aero_table first)`);
        if (surface.bodyId !== params.body) return fail(`aero surface '${surfaceId}' is on body '${surface.bodyId}', not '${params.body}'`);
        if (!(angle >= surface.servo.minDeg && angle <= surface.servo.maxDeg))
          return fail(
            `pivot command ${angle}° of '${surfaceId}' at t = ${setpoint.t} s is outside its servo limits [${surface.servo.minDeg}, ${surface.servo.maxDeg}]°`,
          );
      }
    if (setpoints[0]?.t !== 0) return fail('the first set-point must be at t = 0');
    if (setpoints.some((setpoint, i) => i > 0 && setpoint.t <= (setpoints[i - 1]?.t ?? Infinity)))
      return fail('set-point times must strictly increase');
    const late = setpoints.find((setpoint) => setpoint.t >= params.durationS);
    if (late !== undefined) return fail(`a set-point at t = ${late.t} s is not inside the ${params.durationS} s run`);
    const gusts = params.wind?.gusts ?? [];
    const lateGust = gusts.find((gust) => gust.startS >= params.durationS);
    if (lateGust !== undefined) return fail(`a gust starting at ${lateGust.startS} s is not inside the ${params.durationS} s run`);
    const id = idOrNext(params.id, 'scenario');
    if (idTakenInDynamicsOrFlight(doc, id)) return fail(`id '${id}' is already used`);
    const defaulted: string[] = [];
    const turbulenceInput = params.wind?.turbulence;
    if (
      turbulenceInput !== undefined &&
      (turbulenceInput.sigmaMps.some((sigma) => !(sigma >= 0)) || turbulenceInput.lengthScaleM?.some((length) => !(length > 0)))
    )
      return fail('turbulence sigmaMps must be >= 0 and lengthScaleM > 0');
    const slow =
      turbulenceInput === undefined
        ? null
        : turbulenceProblem({
            lengthScaleM: turbulenceInput.lengthScaleM ?? SCENARIO_DEFAULTS.turbulenceLengthScaleM,
            airspeedMps: turbulenceInput.airspeedMps ?? SCENARIO_DEFAULTS.turbulenceAirspeedMps,
          });
    if (slow !== null) return fail(slow);
    const turbulence =
      turbulenceInput === undefined
        ? undefined
        : {
            sigmaMps: turbulenceInput.sigmaMps,
            airspeedMps: pick(turbulenceInput.airspeedMps, SCENARIO_DEFAULTS.turbulenceAirspeedMps, 'turbulence.airspeedMps', defaulted),
            lengthScaleM: pick(
              turbulenceInput.lengthScaleM,
              SCENARIO_DEFAULTS.turbulenceLengthScaleM,
              'turbulence.lengthScaleM',
              defaulted,
            ),
            seed: turbulenceInput.seed,
          };
    const scenario: FlightScenario = {
      id,
      bodyId: params.body,
      controllerId,
      durationS: params.durationS,
      setpoints,
      initialVelocity: params.initialVelocity ?? [0, 0, 0],
      initialAngularVelocity: params.initialAngularVelocity ?? [0, 0, 0],
      wind: { steady: params.wind?.steady ?? [0, 0, 0], gusts, ...(turbulence === undefined ? {} : { turbulence }) },
      settleBandM: pick(params.settleBandM, SCENARIO_DEFAULTS.settleBandM, 'settleBandM', defaulted),
      defaulted,
    };
    const loop = controllerId === null ? 'open loop (rotors at their own rpm)' : `flown by '${controllerId}'`;
    return changed(
      { ...doc, flight: { ...flight, scenarios: { ...flight.scenarios, [id]: scenario } } },
      `define_flight_scenario: '${id}' — body '${params.body}' ${loop}, ${format(params.durationS)} s, ${setpoints.length} set-point(s), ` +
        `${gusts.length} gust(s)${turbulence === undefined ? '' : `, Dryden turbulence σ [${turbulence.sigmaMps.join(', ')}] m/s seed ${turbulence.seed}`}, steady wind [${scenario.wind.steady.join(', ')}] m/s, settle band ${format(scenario.settleBandM)} m` +
        `${controllerId === null && setpoints.length > 1 ? ' (open loop: set-points only score the tracking error)' : ''}.`,
      [id],
    );
  },
});
