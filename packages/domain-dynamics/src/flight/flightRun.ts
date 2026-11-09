/**
 * One closed-loop (or open-loop) flight run of a scenario (13 FLT M2): the document's physics model without its flight records, the rotors
 * moved into the flight block (controller + mixer + lags), body drag in the loads under the scenario wind, the vehicle's initial twist, then
 * the engine. Pure apart from the injected engine; deterministic.
 */

import {
  SimulationDivergedError,
  type ActuatorBlock,
  type PhysicsEngine,
  type SimulationBody,
  type SimulationTrace,
} from '@core/dynamics/physicsEngine';
import type { GeometryKernel } from '@core/geometry/kernel';
import type { CadDocument } from '@core/model/types';
import { toMetres } from '@core/model/units';
import type { Vec3 } from '@core/model/vectors';
import { errorMessage } from '@lib/errorMessage';
import { len3, scale3, sub3 } from '@lib/vec3';
import { buildSimulationModel } from '../sim/simulationModel';
import type { FlightController, FlightScenario } from './controlModel';
import type { ControllerRuntime, Inertia3 } from './controller';
import { combineBlocks, flightBlock, meanAxis, NOT_CONTROLLED, type FlightLoop } from './flightBlock';
import { compileFlight, withFlightLoads } from './flightLoads';
import { shortestArc } from './frames';
import { assessMixer, effectiveness, type MixerRotor } from './mixer';
import { flightOf, type FlightModel } from './model';
import { aeroDesignHash } from './aeroTable';
import { compilePower, type PowerRuntime } from './powerBlock';
import { staticCoefficients, type RotorRuntime } from './rotorLaw';
import { isCalm, windSource } from './wind';
import { RESTING_MEMORY, controllerUpdate } from './controller';

/** Largest number of physics steps of one run (a 60 s flight at 2 kHz is 120 000). */
export const MAX_FLIGHT_STEPS = 600_000;
/** Largest number of recorded samples of one run. */
const MAX_FLIGHT_SAMPLES = 6001;

type FlightRefusalCode =
  | 'FLT_SCENARIO_UNKNOWN'
  | 'FLT_BODY_NOT_FREE'
  | 'FLT_VEHICLE_MULTIBODY'
  | 'FLT_MIXER_RANK'
  | 'FLT_MIXER_ILL_CONDITIONED'
  | 'FLT_CONTROL_RATE'
  | 'FLT_RUN_TOO_LONG'
  | 'FLT_DIVERGED'
  | 'FLT_MODEL_INVALID'
  | 'FLT_NO_ENGINE';

export interface FlightRefusal {
  readonly code: FlightRefusalCode;
  readonly message: string;
  readonly ids: readonly string[];
}

export interface FlightRun {
  readonly scenario: FlightScenario;
  readonly controller: FlightController | null;
  readonly loop: FlightLoop;
  readonly trace: SimulationTrace;
  /** First aux slot of the flight block in `trace.aux`. */
  readonly auxOffset: number;
  readonly massKg: number;
  /** |g|, m/s². */
  readonly gravityMps2: number;
  readonly inertia: Inertia3;
  readonly timestep: number;
  readonly sampleInterval: number;
  readonly engine: string;
  /** Inputs that took a default (controller + scenario + aero profile drag) or a stale aero table. */
  readonly defaulted: readonly string[];
  /** Aero surfaces whose table was generated on another design of their body (aeroDesignHash). */
  readonly staleAero: readonly string[];
}

const refusal = (code: FlightRefusalCode, message: string, ids: readonly string[] = []): FlightRefusal => ({ code, message, ids });

const inertia3 = (t: readonly [number, number, number, number, number, number]): Inertia3 => [
  [t[0], t[3], t[4]],
  [t[3], t[1], t[5]],
  [t[4], t[5], t[2]],
];

/** Bodies carried by `rootId` (itself and every body whose parent chain reaches it). */
function subtreeOf(bodies: readonly SimulationBody[], rootId: string): SimulationBody[] {
  const inside = new Set([rootId]);
  for (const body of bodies) if (body.parentId !== null && inside.has(body.parentId)) inside.add(body.id);
  return bodies.filter((body) => inside.has(body.id));
}

/** The mixer rotors of a controller (arms from the centre of mass `center`, m). */
export function mixerRotors(rotors: readonly RotorRuntime[]): MixerRotor[] {
  return rotors.map((rotor) => {
    const { ct, cp } = staticCoefficients(rotor);
    return {
      arm: rotor.arm,
      axis: rotor.axis,
      spin: rotor.rotor.spin === 'ccw' ? 1 : -1,
      torquePerThrust: ct > 0 ? (cp * rotor.rotor.diameter) / (2 * Math.PI * ct) : 0,
    };
  });
}

/** Thrust per (rev/min)² at J = 0, N. */
export function thrustPerRpmSquared(rotor: RotorRuntime): number {
  const { ct } = staticCoefficients(rotor);
  return (ct * rotor.rotor.airDensity * rotor.rotor.diameter ** 4) / 3600;
}

/** The powertrains of `flight` compiled against the run's rotors, or the one whose battery is missing. */
function compilePowertrains(flight: FlightModel, rotors: readonly RotorRuntime[]): PowerRuntime[] | FlightRefusal {
  const batteries = flight.batteries ?? {};
  const ids = rotors.map((rotor) => rotor.rotor.id);
  const compiled: PowerRuntime[] = [];
  for (const powertrain of Object.values(flight.powertrains ?? {})) {
    const battery = Object.hasOwn(batteries, powertrain.batteryId) ? batteries[powertrain.batteryId] : undefined;
    if (battery === undefined)
      return refusal('FLT_MODEL_INVALID', `powertrain '${powertrain.id}' names a missing battery '${powertrain.batteryId}'`, [
        powertrain.id,
      ]);
    compiled.push(compilePower(powertrain, battery, ids));
  }
  return compiled;
}

/** The controller compiled for the run, or why it cannot fly this vehicle. */
function compileController(
  controller: FlightController,
  rotors: readonly RotorRuntime[],
  vehicle: { massKg: number; inertia: Inertia3; gravity: Vec3; start: Vec3; timestep: number },
): ControllerRuntime | FlightRefusal {
  const byId = new Map(rotors.map((rotor) => [rotor.rotor.id, rotor]));
  const own = controller.rotorIds.flatMap((id) => {
    const rotor = byId.get(id);
    return rotor === undefined ? [] : [rotor];
  });
  if (own.length !== controller.rotorIds.length) return refusal('FLT_MODEL_INVALID', `controller '${controller.id}' names a missing rotor`);
  const k = own.map(thrustPerRpmSquared);
  const dead = own.find((_, i) => !((k[i] ?? 0) > 0));
  if (dead !== undefined)
    return refusal('FLT_MIXER_RANK', `rotor '${dead.rotor.id}' has no static thrust (C_T = 0 at J = 0): the mixer cannot command it`, [
      dead.rotor.id,
    ]);
  const thrustAxis = meanAxis(own);
  const b = effectiveness(mixerRotors(own), thrustAxis);
  const assessed = assessMixer(b, controller.mixer);
  if ('code' in assessed)
    return refusal(assessed.code, `controller '${controller.id}': about the vehicle's centre of mass the mixer ${assessed.message}`, [
      controller.id,
    ]);
  return {
    controller,
    mixer: assessed.mixer,
    thrustAxis,
    axisOffset: shortestArc([0, 0, 1], thrustAxis),
    massKg: vehicle.massKg,
    inertia: vehicle.inertia,
    gravity: vehicle.gravity,
    start: vehicle.start,
    minThrust: k.map((value) => value * controller.minRpm ** 2),
    maxThrust: k.map((value) => value * controller.maxRpm ** 2),
    thrustPerRpmSquared: k,
    period: 1 / controller.rateHz,
  };
}

/** Steps of the physics per controller update, or null when the timestep does not divide the controller period. */
export function stepsPerTick(rateHz: number, timestep: number): number | null {
  const ratio = 1 / (rateHz * timestep);
  const steps = Math.round(ratio);
  return steps >= 1 && Math.abs(ratio - steps) <= 1e-6 * steps ? steps : null;
}

/** Sample interval: `requested` (s) rounded to whole steps, coarsened so the run keeps at most MAX_FLIGHT_SAMPLES. */
function sampleIntervalOf(duration: number, timestep: number, requested: number): number {
  const wanted = Math.max(requested, duration / (MAX_FLIGHT_SAMPLES - 1));
  return Math.max(1, Math.ceil(wanted / timestep - 1e-9)) * timestep;
}

/** Run scenario `scenarioId` of `doc` at physics step `timestep` (s), recording a sample every `sampleInterval` (s, rounded to steps). */
export function runFlight(
  doc: CadDocument,
  scenarioId: string,
  options: { readonly timestep: number; readonly sampleInterval: number },
  engine: PhysicsEngine,
  kernel: GeometryKernel | null,
): FlightRun | FlightRefusal {
  const flight = flightOf(doc);
  const scenarios = flight.scenarios ?? {};
  const scenario = Object.hasOwn(scenarios, scenarioId) ? scenarios[scenarioId] : undefined;
  if (scenario === undefined) return refusal('FLT_SCENARIO_UNKNOWN', `no flight scenario '${scenarioId}' (define_flight_scenario first)`);
  const controllers = flight.controllers ?? {};
  const controller = scenario.controllerId === null ? null : (controllers[scenario.controllerId] ?? null);
  if (scenario.controllerId !== null && controller === null)
    return refusal('FLT_MODEL_INVALID', `scenario '${scenario.id}' names a missing controller '${scenario.controllerId}'`);
  const { timestep } = options;
  const steps = Math.round(scenario.durationS / timestep);
  if (steps > MAX_FLIGHT_STEPS)
    return refusal(
      'FLT_RUN_TOO_LONG',
      `${scenario.durationS} s at ${timestep} s is ${steps} physics steps (at most ${MAX_FLIGHT_STEPS}): shorten the scenario or raise the timestep`,
      [scenario.id],
    );
  const tick = controller === null ? 1 : stepsPerTick(controller.rateHz, timestep);
  if (tick === null)
    return refusal(
      'FLT_CONTROL_RATE',
      `the timestep ${timestep} s does not divide the controller period 1/${controller?.rateHz ?? 0} s into whole physics steps`,
      [controller?.id ?? ''],
    );
  const { flight: _ignored, ...withoutFlight } = doc;
  const built = buildSimulationModel(withoutFlight, timestep, kernel);
  if ('error' in built) return refusal('FLT_MODEL_INVALID', built.error);
  const vehicle = built.model.bodies.find((body) => body.id === scenario.bodyId);
  if (vehicle === undefined || vehicle.fixed || vehicle.joint !== null)
    return refusal(
      'FLT_BODY_NOT_FREE',
      `body '${scenario.bodyId}' is ${vehicle === undefined ? 'not a rigid body' : vehicle.fixed ? 'fixed to the ground' : 'jointed to another body'}: a flight vehicle is a free body`,
      [scenario.bodyId],
    );
  const centers = Object.fromEntries(Object.entries(built.mass).map(([id, props]) => [id, props.centerOfMass]));
  const compiled = compileFlight(doc, centers, toMetres(doc, 1));
  if (compiled !== null && 'error' in compiled) return refusal('FLT_MODEL_INVALID', compiled.error);
  const rotors = compiled?.rotors ?? [];
  // the controller's mass, centre of mass and inertia are the vehicle body's own: a body jointed below it would make them disagree with the
  // dynamics silently, so a vehicle is one rigid body; pivoting surfaces are aero surfaces with a servo (generate_aero_table), not bodies
  const carried = subtreeOf(built.model.bodies, vehicle.id).filter((body) => body.id !== vehicle.id);
  if (carried.length > 0)
    return refusal(
      'FLT_VEHICLE_MULTIBODY',
      `body '${vehicle.id}' carries ${carried.length} jointed bod${carried.length === 1 ? 'y' : 'ies'} (${carried.map((body) => `'${body.id}'`).join(', ')}): a flight vehicle is one rigid body (model a pivoting wing as an aero surface with a pivot servo, generate_aero_table)`,
      [vehicle.id, ...carried.map((body) => body.id)],
    );
  const massKg = vehicle.mass;
  const inertia = inertia3(vehicle.inertia);
  const gravity = built.model.gravity;
  const start = vehicle.centerOfMass;
  const runtime =
    controller === null
      ? null
      : compileController(
          controller,
          rotors.filter((rotor) => controller.rotorIds.includes(rotor.rotor.id)),
          { massKg, inertia, gravity, start, timestep },
        );
  if (runtime !== null && 'code' in runtime) return runtime;
  const power = compilePowertrains(flight, rotors);
  if ('code' in power) return power;
  const rowOf = rotors.map((rotor) => (controller === null ? NOT_CONTROLLED : controller.rotorIds.indexOf(rotor.rotor.id)));
  const ordered = controller?.rotorIds.flatMap((id) => rotors.filter((rotor) => rotor.rotor.id === id)) ?? [];
  const gravityLength = len3(gravity);
  const thrustAxis = runtime?.thrustAxis ?? meanAxis(rotors.filter((rotor) => rotor.rotor.bodyId === vehicle.id));
  const control = runtime === null ? null : { runtime, rowOf, initialRpm: hoverRpm(runtime, ordered.length) };
  const wind = windSource(scenario.wind, scenario.durationS);
  const loop: FlightLoop = {
    scenario,
    wind,
    aero: compiled?.aero ?? [],
    vehicleId: vehicle.id,
    rotors,
    control,
    power,
    thrustAxis,
    up: gravityLength > 0 ? scale3(gravity, -1 / gravityLength) : [0, 0, 1],
    start,
    timestep,
    stepsPerTick: tick,
  };
  const drags = compiled?.drags ?? [];
  const loads =
    drags.length === 0
      ? built.model.loads
      : withFlightLoads(
          built.model.loads,
          { rotors: [], drags, aero: [], bodies: compiled?.bodies ?? [] },
          isCalm(scenario.wind) ? undefined : wind,
        );
  const block = flightBlock(loop);
  const existing: ActuatorBlock | undefined = built.model.actuators;
  const bodies = built.model.bodies.map((body) =>
    body.id === vehicle.id
      ? { ...body, initialTwist: { linear: scenario.initialVelocity, angular: scenario.initialAngularVelocity } }
      : body,
  );
  const model = {
    ...built.model,
    bodies,
    loads,
    actuators: existing === undefined ? block : combineBlocks(existing, block),
    bodyStates: [...new Set([...(compiled?.bodies ?? []), vehicle.id])],
  };
  const staleAero = loop.aero
    .filter(({ surface }) => aeroDesignHash(doc, surface.bodyId, surface.inputsHash) !== surface.designHash)
    .map(({ surface }) => surface.id);
  const sampleInterval = sampleIntervalOf(scenario.durationS, timestep, options.sampleInterval);
  try {
    const trace = engine.simulate(model, { duration: steps * timestep, timestep, sampleInterval });
    return {
      scenario,
      controller,
      loop,
      trace,
      auxOffset: existing === undefined ? 0 : existing.size,
      massKg,
      gravityMps2: gravityLength,
      inertia,
      timestep,
      sampleInterval,
      engine: engine.name,
      staleAero,
      defaulted: [
        ...staleAero.map((id) => `aero.${id}.stale`),
        ...(controller?.defaulted ?? []).map((name) => `controller.${name}`),
        ...scenario.defaulted.map((name) => `scenario.${name}`),
        ...(compiled?.aero ?? []).flatMap((entry) => entry.surface.defaulted.map((name) => `aero.${entry.surface.id}.${name}`)),
        ...power.flatMap((feed) => [
          ...feed.battery.defaulted.map((name) => `battery.${feed.battery.id}.${name}`),
          ...feed.powertrain.defaulted.map((name) => `powertrain.${feed.powertrain.id}.${name}`),
        ]),
      ],
    };
  } catch (error) {
    return error instanceof SimulationDivergedError
      ? refusal('FLT_DIVERGED', `the flight diverged: the state stopped being finite at t = ${error.timeS.toFixed(4)} s`, [scenario.id])
      : refusal('FLT_MODEL_INVALID', `the physics engine rejected the model: ${errorMessage(error)}`);
  }
}

/** Rotor speeds of the first controller update at rest at the start pose (the run starts trimmed instead of spinning up). */
function hoverRpm(runtime: ControllerRuntime, count: number): number[] {
  const out = controllerUpdate(
    runtime,
    { position: runtime.start, orientation: [1, 0, 0, 0], linearVelocity: [0, 0, 0], angularVelocity: [0, 0, 0] },
    { t: 0, position: [0, 0, 0], yawDeg: 0 },
    RESTING_MEMORY,
  );
  return Array.from({ length: count }, (_, i) => out.rpm[i] ?? 0);
}

/** Position of the vehicle relative to its start, m, at sample k. */
export function offsetAt(run: FlightRun, k: number): Vec3 {
  const position = run.trace.bodyPosition[run.loop.vehicleId]?.[k] ?? run.loop.start;
  return sub3(position, run.loop.start);
}
