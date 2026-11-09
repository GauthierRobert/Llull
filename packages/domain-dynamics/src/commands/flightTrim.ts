/** Steady flight of a vehicle (13 FLT M5): trim_flight (the balanced state and controls) and linearize_flight (A, B, eigenvalues, mode labels). */

import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import { elementAt } from '@lib/elementAt';
import { codedRejection, report } from '@core/commands/noop';
import type { CadDocument } from '@core/model/types';
import { aeroDesignHash } from '../flight/aeroTable';
import { prepareVehicle, type FlightRefusal } from '../flight/flightRun';
import { analyseModes, type ModeSet } from '../flight/flightModes';
import { linearize } from '../flight/linearModel';
import { flightOf } from '../flight/model';
import { rotateInverse } from '../flight/frames';
import { bodyVelocity, solveTrim, trimAccelerations, TRIM_TOLERANCE, type TrimCondition, type TrimState } from '../flight/trimSolve';
import {
  orientationOf,
  STATE_NAMES,
  STATE_UNITS,
  trimProblem,
  trimVehicle,
  wrenchAt,
  type TrimVehicle,
  type Wrench,
} from '../flight/trimModel';

const DEG = 180 / Math.PI;
/** Airspeed (hover) and flight-path angle (level) of a condition that gives none. */
const HOVER = 0;
const LEVEL = 0;
/** Timestep given to the model builder (a trim runs no engine; the value only has to be valid). */
const BUILD_TIMESTEP = 0.0005;
/** Airspeed below which a vehicle with aero surfaces is labelled with the hover mode set under `modes: "auto"`, m/s. */
const HOVER_SPEED_MPS = 1;

type TrimCode = FlightRefusal['code'] | 'FLT_TRIM_NOT_CONVERGED' | 'FLT_TRIM_SATURATED' | 'FLT_TRIM_UNSUPPORTED' | 'FLT_LINEARIZE_FAILED';

const REMEDIATION: Readonly<Record<TrimCode, string>> = {
  FLT_SCENARIO_UNKNOWN:
    'Define it with define_flight_scenario (list them with inspect_dynamics): it names the vehicle body and its controller.',
  FLT_BODY_NOT_FREE: 'Trim a free rigid body: no joint to another body, not fixed.',
  FLT_VEHICLE_MULTIBODY:
    'Merge the parts into one rigid body, or remove the joints below it; a pivoting wing is an aero surface with a pivot servo.',
  FLT_MIXER_ILL_CONDITIONED: 'Spread the rotors so their arms and spins separate roll, pitch and yaw clearly, or fix the mixer.',
  FLT_MIXER_RANK:
    'Give every controlled rotor static thrust and an arm / spin layout that separates roll, pitch and yaw, or fix the mixer.',
  FLT_CONTROL_RATE: 'Fix the controller rate (add_flight_controller).',
  FLT_RUN_TOO_LONG: 'Shorten the scenario.',
  FLT_DIVERGED: 'Fix the physics model (inspect_dynamics).',
  FLT_MODEL_INVALID: 'Fix the physics model (inspect_dynamics) and try again.',
  FLT_NO_ENGINE: 'Wait for the physics engine and try again.',
  FLT_TRIM_NOT_CONVERGED:
    'Check the condition is flyable: the rotors / surfaces must be able to balance the weight and drag at this speed and flight-path angle (more thrust, a different airspeed, a servo surface to trim the pitch); try freeFlightPath for a glide.',
  FLT_TRIM_SATURATED:
    'The balance needs a control beyond its limit: raise the controller maxRpm, add thrust, widen the servo travel, or fly a milder condition (slower, lower climb angle).',
  FLT_TRIM_UNSUPPORTED: 'Model the vehicle with its aero surfaces travelling along +x (generate_aero_table forward "+x").',
  FLT_LINEARIZE_FAILED:
    'The state matrix has a non-finite entry or its eigenvalue iteration failed: check the vehicle model at this condition.',
};

const conditionSchema = {
  scenario: z
    .string()
    .describe(
      'Id of a flight scenario (define_flight_scenario): it names the vehicle body and the controller whose rotors (speeds within minRpm..maxRpm) and the servo surfaces (pivot within their travel) are the controls. Its set-points and wind are ignored: the trim is in still air.',
    ),
  airspeedMps: z
    .number()
    .min(0)
    .max(1000)
    .optional()
    .describe(
      'Speed of the centre of mass relative to the air along the flight path, m/s. Default 0 (hover). The vehicle travels along its body +x axis.',
    ),
  flightPathDeg: z
    .number()
    .min(-89)
    .max(89)
    .optional()
    .describe('Flight-path angle, deg, climb positive: 0 level flight (default), 90 - |value| near vertical. Ignored with freeFlightPath.'),
  freeFlightPath: z
    .boolean()
    .optional()
    .describe(
      'Solve the flight-path angle too: a glider (no thrust) or a vehicle whose thrust is fixed settles on the path it can hold. Default false.',
    ),
};

const reject = (
  doc: CadDocument,
  command: string,
  code: TrimCode,
  message: string,
  ids: readonly string[] = [],
  detail?: Record<string, unknown>,
): CommandResult => codedRejection(doc, command, code, message, REMEDIATION[code], ids, [], detail);

const format = (value: number): string => (Number.isFinite(value) ? value.toPrecision(5) : String(value));

interface Trimmed {
  readonly vehicle: TrimVehicle;
  readonly condition: TrimCondition;
  readonly state: TrimState;
  readonly iterations: number;
  readonly residual: number;
  readonly defaulted: readonly string[];
  readonly warnings: readonly string[];
  readonly scenarioId: string;
  readonly bodyId: string;
}

/** Trim the scenario's vehicle at the condition, or the rejection that says why not. */
function trimmed(
  doc: CadDocument,
  command: string,
  params: { scenario: string; airspeedMps?: number | undefined; flightPathDeg?: number | undefined; freeFlightPath?: boolean | undefined },
  ctx: ExecutionContext | undefined,
): Trimmed | CommandResult {
  const flight = flightOf(doc);
  const scenarios = flight.scenarios ?? {};
  const scenario = Object.hasOwn(scenarios, params.scenario) ? scenarios[params.scenario] : undefined;
  if (scenario === undefined) return reject(doc, command, 'FLT_SCENARIO_UNKNOWN', `no flight scenario '${params.scenario}'`);
  const controllers = flight.controllers ?? {};
  const controller = scenario.controllerId === null ? null : (controllers[scenario.controllerId] ?? null);
  if (scenario.controllerId !== null && controller === null)
    return reject(doc, command, 'FLT_MODEL_INVALID', `scenario '${scenario.id}' names a missing controller '${scenario.controllerId}'`, [
      scenario.id,
    ]);
  const prepared = prepareVehicle(doc, scenario, controller, ctx?.kernel ?? null, BUILD_TIMESTEP);
  if ('code' in prepared) return reject(doc, command, prepared.code, prepared.message, prepared.ids);
  const problem = trimProblem(prepared);
  if (problem !== null) return reject(doc, command, 'FLT_TRIM_UNSUPPORTED', problem, [scenario.bodyId]);
  const vehicle = trimVehicle(prepared);
  if (vehicle === null)
    return reject(doc, command, 'FLT_MODEL_INVALID', `body '${scenario.bodyId}' has a singular inertia tensor`, [scenario.bodyId]);
  const condition: TrimCondition = {
    airspeedMps: params.airspeedMps ?? HOVER,
    flightPathDeg: params.flightPathDeg ?? LEVEL,
    freeFlightPath: params.freeFlightPath === true,
  };
  const result = solveTrim(vehicle, condition);
  if (!result.ok)
    return reject(
      doc,
      command,
      result.code,
      `scenario '${scenario.id}' at ${condition.airspeedMps} m/s: ${result.message}`,
      [scenario.id, scenario.bodyId],
      { residual: result.residual },
    );
  const calm =
    scenario.wind.steady.every((component) => component === 0) &&
    scenario.wind.gusts.length === 0 &&
    scenario.wind.turbulence === undefined;
  const defaulted = [
    ...(controller?.defaulted ?? []).map((name) => `controller.${name}`),
    ...vehicle.aero.flatMap(({ surface }) => surface.defaulted.map((name) => `aero.${surface.id}.${name}`)),
    ...vehicle.aero
      .filter(({ surface }) => aeroDesignHash(doc, surface.bodyId, surface.inputsHash) !== surface.designHash)
      .map(({ surface }) => `aero.${surface.id}.stale`),
  ];
  return {
    vehicle,
    condition,
    state: result.state,
    iterations: result.iterations,
    residual: result.residual,
    defaulted,
    warnings: [
      ...(calm ? [] : [`scenario '${scenario.id}' has wind: ignored, the trim is in still air`]),
      ...(vehicle.controls.length === 0
        ? [`no controls: the scenario has no controller with rotors and no aero surface has a pivot servo, so only the attitude was solved`]
        : []),
    ],
    scenarioId: scenario.id,
    bodyId: scenario.bodyId,
  };
}

/** The trim result as data (attitude, velocity, controls, rotors, surfaces, residual). */
function trimData(trim: Trimmed): Record<string, unknown> {
  const { vehicle, condition, state } = trim;
  const velocity = bodyVelocity(condition.airspeedMps, state.flightPath, state.roll, state.pitch);
  const wrench: Wrench = wrenchAt(vehicle, { velocity, rates: [0, 0, 0], roll: state.roll, pitch: state.pitch }, state.controls);
  const accelerations = trimAccelerations(vehicle, condition, state);
  const weight = vehicle.massKg * Math.hypot(...vehicle.gravity);
  const world = rotateInverse(orientationOf(state.roll, state.pitch), [0, 0, 1]);
  return {
    scenario: trim.scenarioId,
    bodyId: trim.bodyId,
    converged: true,
    iterations: trim.iterations,
    condition: { airspeedMps: condition.airspeedMps, flightPathDeg: state.flightPath * DEG, flightPathFree: condition.freeFlightPath },
    attitude: { rollDeg: state.roll * DEG, pitchDeg: state.pitch * DEG, headingDeg: 0 },
    velocityBodyMps: velocity,
    angleOfAttackDeg: Math.atan2(velocity[2], velocity[0]) * DEG,
    sideslipDeg: Math.asin(Math.max(-1, Math.min(1, velocity[1] / Math.max(condition.airspeedMps, 1e-12)))) * DEG,
    worldUpInBody: world,
    controls: vehicle.controls.map((control, i) => {
      const value = state.controls[i] ?? control.initial;
      const margin = Math.min(value - control.min, control.max - value) / (control.max - control.min);
      return {
        kind: control.kind,
        id: control.id,
        value,
        unit: control.unit,
        min: control.min,
        max: control.max,
        limitMargin: margin,
        atLimit: margin <= 1e-6,
      };
    }),
    rotors: vehicle.rotors.map((rotor, i) => {
      const output = elementAt(wrench.rotors, i);
      return {
        id: rotor.rotor.id,
        thrustN: output.thrust,
        shaftPowerW: output.power,
        advanceRatio: output.advanceRatio,
        outsideValidatedRange: output.outsideRange,
      };
    }),
    totalShaftPowerW: wrench.rotors.reduce((sum, output) => sum + output.power, 0),
    aero: vehicle.aero.map(({ surface }, i) => {
      const output = elementAt(wrench.aero, i);
      return {
        id: surface.id,
        alphaDeg: output.alphaDeg,
        cl: output.cl,
        cd: output.cd,
        liftN: output.liftN,
        dragN: output.dragN,
        outsideTable: output.outside,
      };
    }),
    residual: {
      accelerationsMps2: accelerations.slice(0, 3),
      angularAccelerationsRadS2: accelerations.slice(3),
      forceN: wrench.force,
      momentNm: wrench.moment,
      relative: trim.residual,
      tolerance: TRIM_TOLERANCE,
    },
    weightN: weight,
    massKg: vehicle.massKg,
    defaulted: trim.defaulted,
    unverified: trim.defaulted.length > 0,
    warnings: trim.warnings,
  };
}

const summaryOf = (trim: Trimmed): string => {
  const { state, condition } = trim;
  return (
    `'${trim.scenarioId}' (body '${trim.bodyId}') at ${format(condition.airspeedMps)} m/s, flight path ${format(state.flightPath * DEG)}°${condition.freeFlightPath ? ' (solved)' : ''}: ` +
    `roll ${format(state.roll * DEG)}°, pitch ${format(state.pitch * DEG)}°` +
    trim.vehicle.controls.map((control, i) => `, ${control.id} ${format(state.controls[i] ?? control.initial)} ${control.unit}`).join('') +
    ` (${trim.iterations} iterations, residual ${trim.residual.toExponential(1)}${trim.defaulted.length > 0 ? '; unverified (defaulted inputs)' : ''})`
  );
};

/**
 * @affects nothing — read-only; data { attitude, velocityBodyMps, controls[], rotors[], aero[], residual, ... }
 * @invariant deterministic: same document and condition give bit-identical data; the force laws are those of run_flight (rotor law, body drag, aero tables, document loads)
 * @invariant kernel-optional: body mass properties are exact with a kernel, mesh integration otherwise (as run_flight)
 * @failure unknown scenario, non-free or multi-body vehicle, a mixer run_flight refuses, an aero surface not travelling along +x (FLT_TRIM_UNSUPPORTED),
 *          no balance within the control limits (FLT_TRIM_SATURATED), a stalled iteration (FLT_TRIM_NOT_CONVERGED) -> rejected with the code
 */
export const trimFlightCommand = defineCommand({
  name: 'trim_flight',
  annotations: { kernelOptional: true, readsMeshTriangles: true, readOnly: true },
  description:
    'Trim a flight vehicle (13 FLT): find the steady, straight flight (no body rates, no wind) at an airspeed and flight-path angle in which the force and ' +
    'moment of the same laws run_flight uses (rotors, body drag, aero surfaces, document loads) balance to the 1e-9 of the reference acceleration. Unknowns: ' +
    'roll and pitch, the flight-path angle with freeFlightPath, and the controls: the rotor speeds of the scenario controller within its minRpm..maxRpm and ' +
    'the pivot angle of every servo aero surface within its travel (an uncontrolled rotor keeps its own rpm). Damped Gauss-Newton with central-difference ' +
    'Jacobians; with more controls than the six equations the solution closest to the hover-speed start is taken (a symmetric vehicle keeps equal rotor speeds). ' +
    'The vehicle travels along its body +x axis, heading 0, in still air (scenario set-points and wind are ignored; battery and motor limits are not applied). ' +
    'Read-only, deterministic, no physics engine needed. data: attitude (roll / pitch deg), velocityBodyMps, angleOfAttackDeg, controls[] (value, unit rpm|deg, ' +
    'limits, limitMargin = share of the range to the nearest limit, atLimit), per rotor thrust N / shaft power W / advance ratio, per surface alpha / CL / CD / lift / drag, ' +
    'the residual force N and moment N·m, iterations. Refusals: FLT_TRIM_SATURATED (a control would pass its limit: untrimmable there), FLT_TRIM_NOT_CONVERGED, ' +
    'FLT_TRIM_UNSUPPORTED, plus the run_flight vehicle refusals (unknown scenario, non-free body, mixer). Next: linearize_flight for A, B and the modes.',
  params: z.object(conditionSchema),
  run: (doc, params, ctx): CommandResult => {
    const result = trimmed(doc, 'trim_flight', params, ctx);
    if (!('vehicle' in result)) return result;
    return report(doc, `trim_flight: ${summaryOf(result)}`, trimData(result));
  },
});

const modesSchema = z
  .enum(['auto', 'fixed_wing', 'hover'])
  .optional()
  .describe(
    'Mode labelling: "fixed_wing" (phugoid / short period / Dutch roll / roll subsidence / spiral), "hover" (heave, yaw, pitch_translation, roll_translation chains) or "auto" (default): fixed_wing when the vehicle has aero surfaces and flies faster than 1 m/s, else hover.',
  );

/**
 * @affects nothing — read-only; data { trim, states[], inputs[], a, b, eigenvalues[], modes[], stable, couplingRatio, ... }
 * @invariant A, B are central-difference Jacobians of the same state derivative trim_flight balances (rotors, drag, aero, document loads) about the trim; the
 *            eigenvalues are of the full 8 x 8 A, each mode label is a heuristic on the longitudinal / lateral blocks (couplingRatio says how decoupled they are)
 * @invariant deterministic; kernel-optional as trim_flight
 * @failure every trim_flight refusal; an eigenvalue iteration that fails (FLT_LINEARIZE_FAILED) -> rejected with the code
 */
export const linearizeFlightCommand = defineCommand({
  name: 'linearize_flight',
  annotations: { kernelOptional: true, readsMeshTriangles: true, readOnly: true },
  description:
    'Linearise a flight vehicle about its trim (13 FLT): trims it like trim_flight, then takes central-difference Jacobians of the rigid-body state derivative ' +
    '(the same rotor / drag / aero / document-load laws) for A and B and the eigenvalues of A with mode labels. States x = [u, v, w (m/s, body axes), p, q, r (rad/s), ' +
    'roll, pitch (rad)] (heading and position do not enter a flat-earth, still-air flight, so they are neutral and left out); inputs = the trim controls in ' +
    'order, per rpm for a rotor and per degree for a pivot (the airframe alone: the flight controller is NOT in the loop, so a quad without its rate loop shows ' +
    'the open-loop integrators). data: states / inputs with units, a (8 x 8), b (8 x inputs), eigenvalues (re, im, 1/s), modes[] (one per mode: label, ' +
    'dampingRatio, naturalFrequencyRadS, periodS, timeConstantS, timeToDoubleS, stability stable|neutral|unstable), stable (no unstable mode), couplingRatio, and the trim data. ' +
    'Labels are heuristics on the decoupled longitudinal (u, w, q, pitch) and lateral (v, p, r, roll) blocks: fixed wing: phugoid (the lower-frequency longitudinal pair), ' +
    'short_period, dutch_roll, roll_subsidence (largest real lateral root), spiral (smallest); hover: heave, yaw, pitch_translation, roll_translation; "coupled" when ' +
    'the full-matrix root has no block root within 10 %. A repeated zero eigenvalue (integrator chain) is defective: its numerical roots spread by the cube root of the round-off, so read it as "about zero". ' +
    'Read-only, deterministic, same refusals as trim_flight.',
  params: z.object({ ...conditionSchema, modes: modesSchema }),
  run: (doc, params, ctx): CommandResult => {
    const result = trimmed(doc, 'linearize_flight', params, ctx);
    if (!('vehicle' in result)) return result;
    const { vehicle, state, condition } = result;
    const velocity = bodyVelocity(condition.airspeedMps, state.flightPath, state.roll, state.pitch);
    const x0 = [...velocity, 0, 0, 0, state.roll, state.pitch];
    const { a, b } = linearize(vehicle, x0, state.controls);
    const wanted = params.modes ?? 'auto';
    const modeSet: ModeSet =
      wanted === 'auto' ? (vehicle.aero.length > 0 && condition.airspeedMps >= HOVER_SPEED_MPS ? 'fixed_wing' : 'hover') : wanted;
    const analysed = analyseModes(a, modeSet);
    if (analysed === null)
      return reject(
        doc,
        'linearize_flight',
        'FLT_LINEARIZE_FAILED',
        `the state matrix at '${result.scenarioId}' has no finite eigenvalues`,
        [result.scenarioId],
      );
    const unstable = analysed.modes.filter((mode) => mode.stability === 'unstable');
    const modeText = analysed.modes
      .map(
        (mode) =>
          `${mode.label} ${mode.kind === 'oscillatory' ? `${format(mode.re)} ± ${format(mode.im)}i (ζ ${format(mode.dampingRatio ?? 0)}, T ${format(mode.periodS ?? 0)} s)` : format(mode.re)} ${mode.stability}`,
      )
      .join('; ');
    return report(
      doc,
      `linearize_flight: ${summaryOf(result)}; ${modeSet} modes: ${modeText}; ${unstable.length === 0 ? 'no unstable mode' : `${unstable.length} unstable mode(s)`}.`,
      {
        trim: trimData(result),
        warnings: [
          ...result.warnings,
          ...(vehicle.aero.length === 0
            ? []
            : [
                'the aero tables have no sideslip, roll-rate or yaw-rate dependence (FLT-D30): the lateral modes (dutch_roll, roll_subsidence, spiral) of an aero vehicle are neutral by construction, not a stability result',
              ]),
        ],
        modeSet,
        states: STATE_NAMES.map((name, i) => ({ name, unit: STATE_UNITS[i] })),
        inputs: vehicle.controls.map((control) => ({
          id: control.id,
          kind: control.kind,
          unit: control.unit,
          trim: state.controls[vehicle.controls.indexOf(control)],
        })),
        a,
        b,
        eigenvalues: analysed.eigenvalues,
        modes: analysed.modes,
        stable: unstable.length === 0,
        couplingRatio: analysed.couplingRatio,
        method: 'central differences about the trim; state steps [1e-3 m/s x3, 1e-4 rad/s x3, 1e-5 rad x2], control step 1e-4 of its range',
      },
    );
  },
});
