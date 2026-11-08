/**
 * The flight loop as an engine actuator block (TR-FLT-05): every physics step it applies the wrench of every rotor (controlled rotors at
 * their lagged commanded speed, the others at their own rpm) under the scenario wind, runs the controller every `stepsPerTick` steps, and
 * keeps the run's exact per-step metrics (peaks, integrals, saturation count, shaft energy) in its aux state.
 */

import type { ActuatorBlock, BodyKinematics, SimulationState } from '@core/dynamics/physicsEngine';
import type { Vec3 } from '@core/model/vectors';
import { add3, dot3, len3, scale3, sub3 } from '@lib/vec3';
import type { FlightScenario, FlightSetpoint } from './controlModel';
import { controllerUpdate, type ControllerMemory, type ControllerRuntime } from './controller';
import { rotate } from './frames';
import { rotorOutput, validatedRange, type RotorRuntime } from './rotorLaw';
import { airRelative, windAt } from './wind';

/** Aux slots of the block (per-rotor slots follow at ROTOR_BASE + ROTOR_SLOTS · i). */
export const SLOT = {
  step: 0,
  velocityIntegral: 1,
  rateIntegral: 4,
  previousVelocity: 7,
  previousRate: 10,
  hasPrevious: 13,
  lastSaturated: 14,
  saturatedTicks: 15,
  ticks: 16,
  shaftEnergy: 17,
  maxTilt: 18,
  maxTiltTime: 19,
  maxRate: 20,
  maxRateTime: 21,
  errorSquaredIntegral: 22,
  maxError: 23,
  maxErrorTime: 24,
  /** First time the tilt exceeded 90° with a controller, -1 = never. */
  divergedTime: 25,
  /** Largest total shaft power of a step, W, and when. */
  peakPower: 26,
  peakPowerTime: 27,
} as const;
const ROTOR_BASE = 28;
/** Per rotor: commanded rpm, rpm, thrust N, shaft power W, J, J min, J max, steps outside the validated J range. */
export const ROTOR = { command: 0, rpm: 1, thrust: 2, power: 3, advanceRatio: 4, minJ: 5, maxJ: 6, outsideSteps: 7 } as const;
const ROTOR_SLOTS = 8;
/** Mixer row of a rotor the controller does not command. */
export const NOT_CONTROLLED = -1;

export const rotorSlot = (rotor: number, field: number): number => ROTOR_BASE + ROTOR_SLOTS * rotor + field;

export interface FlightLoop {
  readonly scenario: FlightScenario;
  readonly vehicleId: string;
  /** Every rotor of the run (the block owns them all). */
  readonly rotors: readonly RotorRuntime[];
  /** Controller and, per entry of `rotors`, its row in the mixer (-1 = not controlled); null = open loop. */
  readonly control: {
    readonly runtime: ControllerRuntime;
    readonly rowOf: readonly number[];
    readonly initialRpm: readonly number[];
  } | null;
  /** Unit thrust axis, body axes (the tilt metric). */
  readonly thrustAxis: Vec3;
  /** World up (-g direction). */
  readonly up: Vec3;
  /** World centre of mass at t = 0, m. */
  readonly start: Vec3;
  readonly timestep: number;
  readonly stepsPerTick: number;
}

/** Row of rotor `i` of the loop in the controller's mixer, NOT_CONTROLLED when the controller does not command it (or there is none). */
export function mixerRow(loop: FlightLoop, i: number): number {
  const row = loop.control === null ? undefined : loop.control.rowOf[i];
  return row === undefined ? NOT_CONTROLLED : row;
}

/** Set-point active at time t (the last one with time <= t; a hold of the start pose when there is none). */
export function setpointAt(scenario: FlightScenario, t: number): FlightSetpoint {
  let active: FlightSetpoint = { t: 0, position: [0, 0, 0], yawDeg: 0 };
  for (const setpoint of scenario.setpoints) if (setpoint.t <= t + 1e-9) active = setpoint;
  return active;
}

const vecAt = (aux: Float64Array, offset: number): Vec3 => Array.from(aux.subarray(offset, offset + 3)) as unknown as Vec3;

function writeVec(aux: Float64Array, offset: number, value: Vec3): void {
  aux[offset] = value[0];
  aux[offset + 1] = value[1];
  aux[offset + 2] = value[2];
}

function readMemory(aux: Float64Array): ControllerMemory {
  return {
    velocityIntegral: vecAt(aux, SLOT.velocityIntegral),
    rateIntegral: vecAt(aux, SLOT.rateIntegral),
    previousVelocity: vecAt(aux, SLOT.previousVelocity),
    previousRate: vecAt(aux, SLOT.previousRate),
    hasPrevious: aux[SLOT.hasPrevious] === 1,
    saturated: aux[SLOT.lastSaturated] === 1,
  };
}

function writeMemory(aux: Float64Array, memory: ControllerMemory): void {
  writeVec(aux, SLOT.velocityIntegral, memory.velocityIntegral);
  writeVec(aux, SLOT.rateIntegral, memory.rateIntegral);
  writeVec(aux, SLOT.previousVelocity, memory.previousVelocity);
  writeVec(aux, SLOT.previousRate, memory.previousRate);
  aux[SLOT.hasPrevious] = memory.hasPrevious ? 1 : 0;
  aux[SLOT.lastSaturated] = memory.saturated ? 1 : 0;
}

/** Tilt of the thrust axis from up, rad. */
export function tiltOf(loop: FlightLoop, body: BodyKinematics): number {
  return Math.acos(Math.min(1, Math.max(-1, dot3(rotate(body.orientation, loop.thrustAxis), loop.up))));
}

function initialAux(loop: FlightLoop): Float64Array {
  const aux = new Float64Array(ROTOR_BASE + ROTOR_SLOTS * loop.rotors.length);
  aux[SLOT.divergedTime] = -1;
  loop.rotors.forEach((rotor, i) => {
    const row = mixerRow(loop, i);
    const rpm = row >= 0 ? (loop.control?.initialRpm[row] ?? 0) : rotor.rotor.rpm;
    aux[rotorSlot(i, ROTOR.command)] = rpm;
    aux[rotorSlot(i, ROTOR.rpm)] = rpm;
    aux[rotorSlot(i, ROTOR.minJ)] = Infinity;
    aux[rotorSlot(i, ROTOR.maxJ)] = -Infinity;
  });
  return aux;
}

/** Peaks and integrals of the step (midpoint state, held for dt). */
function trackMetrics(loop: FlightLoop, aux: Float64Array, body: BodyKinematics, time: number, dt: number): void {
  const tilt = tiltOf(loop, body);
  if (tilt > (aux[SLOT.maxTilt] ?? 0)) {
    aux[SLOT.maxTilt] = tilt;
    aux[SLOT.maxTiltTime] = time;
  }
  if (loop.control !== null && tilt > Math.PI / 2 && (aux[SLOT.divergedTime] ?? 0) < 0) aux[SLOT.divergedTime] = time;
  const rate = len3(body.angularVelocity);
  if (rate > (aux[SLOT.maxRate] ?? 0)) {
    aux[SLOT.maxRate] = rate;
    aux[SLOT.maxRateTime] = time;
  }
  const error = len3(sub3(add3(loop.start, setpointAt(loop.scenario, time).position), body.position));
  aux[SLOT.errorSquaredIntegral] = (aux[SLOT.errorSquaredIntegral] ?? 0) + error * error * dt;
  if (error > (aux[SLOT.maxError] ?? 0)) {
    aux[SLOT.maxError] = error;
    aux[SLOT.maxErrorTime] = time;
  }
}

/** The flight loop as the run's actuator block (no joints, no ledger: body wrenches only). */
export function flightBlock(loop: FlightLoop): ActuatorBlock {
  const tau = loop.control === null ? 0 : loop.control.runtime.controller.motorTimeConstantS;
  const dt = loop.timestep;
  const midDecay = tau > 0 ? Math.exp(-dt / (2 * tau)) : 0;
  const endDecay = tau > 0 ? Math.exp(-dt / tau) : 0;
  const ranges = loop.rotors.map(validatedRange);
  return {
    size: ROTOR_BASE + ROTOR_SLOTS * loop.rotors.length,
    aux0: initialAux(loop),
    joints: [],
    ledgerLayout: [],
    advance(state: SimulationState, auxIn: Float64Array) {
      const aux = auxIn.slice();
      const body = state.bodies?.[loop.vehicleId];
      const step = aux[SLOT.step] ?? 0;
      aux[SLOT.step] = step + 1;
      const none = { aux, jointForces: new Float64Array(0), bodyForces: [], ledger: new Float64Array(0) };
      if (body === undefined) return none;
      const control = loop.control;
      if (control !== null && step % loop.stepsPerTick === 0) {
        const out = controllerUpdate(control.runtime, body, setpointAt(loop.scenario, step * dt), readMemory(aux));
        writeMemory(aux, out.memory);
        aux[SLOT.ticks] = (aux[SLOT.ticks] ?? 0) + 1;
        if (out.saturated) aux[SLOT.saturatedTicks] = (aux[SLOT.saturatedTicks] ?? 0) + 1;
        control.rowOf.forEach((row, i) => {
          if (row >= 0) aux[rotorSlot(i, ROTOR.command)] = out.rpm[row] ?? 0;
        });
      }
      trackMetrics(loop, aux, body, state.time, dt);
      const wind = windAt(loop.scenario.wind, state.time);
      const air = airRelative(body, wind);
      const forces: Record<string, Vec3> = {};
      const moments: Record<string, Vec3> = {};
      let power = 0;
      loop.rotors.forEach((rotor, i) => {
        const command = aux[rotorSlot(i, ROTOR.command)] ?? 0;
        const now = aux[rotorSlot(i, ROTOR.rpm)] ?? 0;
        const rpm = command + (now - command) * midDecay;
        aux[rotorSlot(i, ROTOR.rpm)] = command + (now - command) * endDecay;
        const target = state.bodies?.[rotor.rotor.bodyId];
        if (target === undefined) return;
        const output = rotorOutput(rotor, rotor.rotor.bodyId === loop.vehicleId ? air : airRelative(target, wind), rpm);
        const id = rotor.rotor.bodyId;
        forces[id] = add3(forces[id] ?? [0, 0, 0], output.force);
        moments[id] = add3(moments[id] ?? [0, 0, 0], output.moment);
        power += output.power;
        aux[rotorSlot(i, ROTOR.thrust)] = output.thrust;
        aux[rotorSlot(i, ROTOR.power)] = output.power;
        aux[rotorSlot(i, ROTOR.advanceRatio)] = output.advanceRatio;
        aux[rotorSlot(i, ROTOR.minJ)] = Math.min(aux[rotorSlot(i, ROTOR.minJ)] ?? Infinity, output.advanceRatio);
        aux[rotorSlot(i, ROTOR.maxJ)] = Math.max(aux[rotorSlot(i, ROTOR.maxJ)] ?? -Infinity, output.advanceRatio);
        const [lo, hi] = ranges[i] ?? [0, 0];
        if (output.advanceRatio < lo || output.advanceRatio > hi)
          aux[rotorSlot(i, ROTOR.outsideSteps)] = (aux[rotorSlot(i, ROTOR.outsideSteps)] ?? 0) + 1;
      });
      aux[SLOT.shaftEnergy] = (aux[SLOT.shaftEnergy] ?? 0) + power * dt;
      if (power > (aux[SLOT.peakPower] ?? 0)) {
        aux[SLOT.peakPower] = power;
        aux[SLOT.peakPowerTime] = state.time;
      }
      return {
        ...none,
        bodyForces: Object.entries(forces).map(([id, force]) => ({ body: id, force })),
        bodyMoments: Object.entries(moments).map(([id, moment]) => ({ body: id, moment })),
      };
    },
  };
}

/** Two actuator blocks run as one (aux, joints and ledger concatenated; `first` keeps its slots, `second` follows at offset first.size). */
export function combineBlocks(first: ActuatorBlock, second: ActuatorBlock): ActuatorBlock {
  const aux0 = new Float64Array(first.size + second.size);
  aux0.set(first.aux0, 0);
  aux0.set(second.aux0, first.size);
  return {
    size: first.size + second.size,
    aux0,
    joints: [...first.joints, ...second.joints],
    ledgerLayout: [...first.ledgerLayout, ...second.ledgerLayout],
    advance(state, aux, dt) {
      const a = first.advance(state, aux.subarray(0, first.size).slice(), dt);
      const b = second.advance(state, aux.subarray(first.size).slice(), dt);
      const merged = new Float64Array(first.size + second.size);
      merged.set(a.aux, 0);
      merged.set(b.aux, first.size);
      const concat = (x: Float64Array, y: Float64Array): Float64Array => {
        const out = new Float64Array(x.length + y.length);
        out.set(x, 0);
        out.set(y, x.length);
        return out;
      };
      return {
        aux: merged,
        jointForces: concat(a.jointForces, b.jointForces),
        bodyForces: [...a.bodyForces, ...b.bodyForces],
        bodyMoments: [...(a.bodyMoments ?? []), ...(b.bodyMoments ?? [])],
        ledger: concat(a.ledger, b.ledger),
      };
    },
  };
}

/** Unit mean of the rotor axes (body axes), +Z when they cancel or there are none. */
export function meanAxis(rotors: readonly RotorRuntime[]): Vec3 {
  const sum = rotors.reduce<Vec3>((total, rotor) => add3(total, rotor.axis), [0, 0, 0]);
  const length = len3(sum);
  return length > 1e-9 ? scale3(sum, 1 / length) : [0, 0, 1];
}
