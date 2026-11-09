/**
 * The rigid-body state derivative of a flight vehicle for trim and linearisation (13 FLT M5): the SAME force laws as run_flight (rotor law, body drag,
 * aero surfaces, the document's own loads) evaluated at a body state with the controls given directly, no engine and no controller in the loop.
 * State x = [u, v, w, p, q, r, roll, pitch] (body-axis velocity of the centre of mass, m/s; body rates, rad/s; Euler roll and pitch, rad; the heading
 * and the position do not enter a flat-earth flight without wind, so they are not states).
 */

import type { AppliedLoads, BodyKinematics, SimulationState } from '@core/dynamics/physicsEngine';
import type { Quaternion, Vec3 } from '@core/model/vectors';
import { elementAt } from '@lib/elementAt';
import { invertDense } from '@lib/denseLinalg';
import { multiplyQuaternion } from '@lib/quaternion';
import { add3, cross3, scale3, vec3At } from '@lib/vec3';
import { aeroOutput, neutralPivotDeg, type AeroOutput, type AeroRuntime } from './aeroSurface';
import type { Inertia3 } from './controller';
import { rotate, rotateInverse } from './frames';
import { thrustPerRpmSquared, type PreparedVehicle } from './flightRun';
import type { BodyDrag } from './model';
import { bodyDragForce, rotorOutput, type RotorOutput, type RotorRuntime } from './rotorLaw';

/** Names of the 8 states, in order. */
export const STATE_NAMES = ['u', 'v', 'w', 'p', 'q', 'r', 'roll', 'pitch'] as const;
/** Units of the 8 states, in order. */
export const STATE_UNITS = ['m/s', 'm/s', 'm/s', 'rad/s', 'rad/s', 'rad/s', 'rad', 'rad'] as const;

/** A control the solver may move: the speed of a controlled rotor or the pivot angle of a servo surface. */
interface TrimControl {
  readonly kind: 'rotor_rpm' | 'pivot_deg';
  readonly id: string;
  readonly unit: 'rpm' | 'deg';
  readonly min: number;
  readonly max: number;
  readonly initial: number;
}

type Target = { readonly kind: 'rotor'; readonly index: number } | { readonly kind: 'aero'; readonly index: number };

export interface TrimVehicle {
  readonly vehicleId: string;
  readonly massKg: number;
  readonly inertia: Inertia3;
  readonly inertiaInverse: Inertia3;
  readonly gravity: Vec3;
  readonly start: Vec3;
  readonly rotors: readonly RotorRuntime[];
  readonly aero: readonly AeroRuntime[];
  readonly drags: readonly BodyDrag[];
  readonly base: (state: SimulationState) => AppliedLoads;
  readonly controls: readonly TrimControl[];
  readonly targets: readonly Target[];
}

export interface FlightState {
  /** Velocity of the centre of mass relative to the air, body axes, m/s. */
  readonly velocity: Vec3;
  /** Body rates, body axes, rad/s. */
  readonly rates: Vec3;
  readonly roll: number;
  readonly pitch: number;
}

export interface Wrench {
  /** Total force on the body, body axes, N (gravity included). */
  readonly force: Vec3;
  /** Total moment about the centre of mass, body axes, N·m. */
  readonly moment: Vec3;
  readonly rotors: readonly RotorOutput[];
  readonly aero: readonly AeroOutput[];
}

/** Why the vehicle cannot be trimmed as is, or null. */
export function trimProblem(prepared: PreparedVehicle): string | null {
  const odd = prepared.compiled?.aero.find(({ surface }) => surface.bodyId === prepared.vehicle.id && surface.forward !== '+x');
  return odd === undefined
    ? null
    : `aero surface '${odd.surface.id}' travels along ${odd.surface.forward}: trim flies along the body +x axis, so model the vehicle with forward +x`;
}

const row = (matrix: readonly (readonly number[])[], i: number): [number, number, number] => {
  const values = elementAt(matrix, i);
  return [elementAt(values, 0), elementAt(values, 1), elementAt(values, 2)];
};

/** The vehicle compiled for evaluation: its rotors, surfaces and drag, and the controls (rotors of the controller, servo surfaces); null for a singular inertia. */
export function trimVehicle(prepared: PreparedVehicle): TrimVehicle | null {
  const id = prepared.vehicle.id;
  const rotors = (prepared.compiled?.rotors ?? []).filter((rotor) => rotor.rotor.bodyId === id);
  const aero = (prepared.compiled?.aero ?? []).filter(({ surface }) => surface.bodyId === id);
  const inverse = invertDense(prepared.inertia);
  if (inverse === null) return null;
  const controls: TrimControl[] = [];
  const targets: Target[] = [];
  const controller = prepared.runtime?.controller;
  if (controller !== undefined) {
    const own = controller.rotorIds.flatMap((rotorId) => {
      const index = rotors.findIndex((rotor) => rotor.rotor.id === rotorId);
      return index < 0 ? [] : [index];
    });
    const stiffness = own.reduce((sum, index) => sum + thrustPerRpmSquared(rotors[index] as RotorRuntime), 0);
    const weight = prepared.massKg * Math.hypot(...prepared.gravity);
    const guess = stiffness > 0 ? Math.sqrt(weight / stiffness) : 0.5 * (controller.minRpm + controller.maxRpm);
    for (const index of controller.maxRpm > controller.minRpm ? own : []) {
      controls.push({
        kind: 'rotor_rpm',
        id: (rotors[index] as RotorRuntime).rotor.id,
        unit: 'rpm',
        min: controller.minRpm,
        max: controller.maxRpm,
        initial: Math.min(controller.maxRpm, Math.max(controller.minRpm, guess)),
      });
      targets.push({ kind: 'rotor', index });
    }
  }
  aero.forEach(({ surface }, index) => {
    if (surface.servo === null || !(surface.servo.maxDeg > surface.servo.minDeg)) return;
    controls.push({
      kind: 'pivot_deg',
      id: surface.id,
      unit: 'deg',
      min: surface.servo.minDeg,
      max: surface.servo.maxDeg,
      initial: neutralPivotDeg(surface),
    });
    targets.push({ kind: 'aero', index });
  });
  return {
    vehicleId: id,
    massKg: prepared.massKg,
    inertia: prepared.inertia,
    inertiaInverse: [row(inverse, 0), row(inverse, 1), row(inverse, 2)],
    gravity: prepared.gravity,
    start: prepared.start,
    rotors,
    aero,
    drags: (prepared.compiled?.drags ?? []).filter((drag) => drag.bodyId === id),
    base: prepared.built.model.loads,
    controls,
    targets,
  };
}

/** Orientation of the body for Euler roll (about +x) and pitch (nose up positive: a rotation of −pitch about +y), heading 0: q = q_y(−pitch) · q_x(roll). */
export function orientationOf(roll: number, pitch: number): Quaternion {
  return multiplyQuaternion([Math.cos(pitch / 2), 0, -Math.sin(pitch / 2), 0], [Math.cos(roll / 2), Math.sin(roll / 2), 0, 0]);
}

/** The force and moment of every law at `state` with the controls `values` (rpm / deg, in `vehicle.controls` order); uncontrolled rotors at their own rpm. */
export function wrenchAt(vehicle: TrimVehicle, state: FlightState, values: readonly number[]): Wrench {
  const orientation = orientationOf(state.roll, state.pitch);
  const body: BodyKinematics = {
    position: vehicle.start,
    orientation,
    linearVelocity: rotate(orientation, state.velocity),
    angularVelocity: rotate(orientation, state.rates),
  };
  const rpm = vehicle.rotors.map((rotor) => rotor.rotor.rpm);
  const pivot = vehicle.aero.map(({ surface }) => neutralPivotDeg(surface));
  vehicle.targets.forEach((target, i) => {
    const value = values[i] ?? 0;
    if (target.kind === 'rotor') rpm[target.index] = value;
    else pivot[target.index] = value;
  });
  const rotors = vehicle.rotors.map((rotor, i) => rotorOutput(rotor, body, rpm[i]));
  const aero = vehicle.aero.map((surface, i) => aeroOutput(surface, body, pivot[i] ?? 0));
  const base = vehicle.base({ time: 0, jointPosition: {}, jointVelocity: {}, bodies: { [vehicle.vehicleId]: body } });
  let force: Vec3 = add3(base.bodyForces[vehicle.vehicleId] ?? [0, 0, 0], scale3(vehicle.gravity, vehicle.massKg));
  let moment: Vec3 = base.bodyMoments?.[vehicle.vehicleId] ?? [0, 0, 0];
  for (const output of [...rotors, ...aero]) {
    force = add3(force, output.force);
    moment = add3(moment, output.moment);
  }
  for (const drag of vehicle.drags) force = add3(force, bodyDragForce(drag, body));
  return { force: rotateInverse(orientation, force), moment: rotateInverse(orientation, moment), rotors, aero };
}

const times = (matrix: Inertia3, v: Vec3): Vec3 => [
  matrix[0][0] * v[0] + matrix[0][1] * v[1] + matrix[0][2] * v[2],
  matrix[1][0] * v[0] + matrix[1][1] * v[1] + matrix[1][2] * v[2],
  matrix[2][0] * v[0] + matrix[2][1] * v[1] + matrix[2][2] * v[2],
];

/**
 * x-dot of the 8 states: v-dot = F / m − ω × v; ω-dot = I⁻¹ (M − ω × I ω); roll-dot, pitch-dot from the Euler kinematics. Axes are the document's (x forward,
 * y left, z up): q is about +y, so a nose-up pitch is a negative q.
 */
export function stateDerivative(vehicle: TrimVehicle, x: readonly number[], values: readonly number[]): number[] {
  const velocity = vec3At(x, 0);
  const rates = vec3At(x, 3);
  const roll = elementAt(x, 6);
  const pitch = elementAt(x, 7);
  const { force, moment } = wrenchAt(vehicle, { velocity, rates, roll, pitch }, values);
  const acceleration = add3(scale3(force, 1 / vehicle.massKg), scale3(cross3(rates, velocity), -1));
  const angular = times(vehicle.inertiaInverse, add3(moment, scale3(cross3(rates, times(vehicle.inertia, rates)), -1)));
  const [p, q, r] = rates;
  return [
    ...acceleration,
    ...angular,
    p - (q * Math.sin(roll) + r * Math.cos(roll)) * Math.tan(pitch),
    -(q * Math.cos(roll) - r * Math.sin(roll)),
  ];
}
