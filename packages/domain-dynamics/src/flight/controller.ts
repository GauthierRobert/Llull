/**
 * Cascaded PID flight controller (TR-FLT-05), one discrete update: position -> velocity (PID, acceleration out) -> thrust vector with a tilt
 * limit -> attitude (quaternion error, P) -> body rate (PID, angular acceleration out) -> torque J·α + ω × Jω -> mixer -> rotor speeds by the
 * inverse rotor law at J = 0. Pure: the integrators and the previous measurements are the `memory` the caller keeps.
 */

import type { BodyKinematics } from '@core/dynamics/physicsEngine';
import type { Quaternion, Vec3 } from '@core/model/vectors';
import { multiplyQuaternion } from '@lib/quaternion';
import { add3, cross3, dot3, len3, normalize3OrZero, scale3, sub3 } from '@lib/vec3';
import type { FlightController, FlightSetpoint, PidGains } from './controlModel';
import { allocate, type MixerRow } from './mixer';
import { conjugate, quaternionFromBasis, rotate, rotateInverse } from './frames';

/** 3 × 3 body inertia, kg·m², body axes (= world axes at the modelled pose). */
export type Inertia3 = readonly [Vec3, Vec3, Vec3];

/** A controller compiled against one run's vehicle. */
export interface ControllerRuntime {
  readonly controller: FlightController;
  /** N × 4 mixer, rows in controller.rotorIds order. */
  readonly mixer: readonly MixerRow[];
  /** Unit thrust axis of the vehicle, body axes (mean of the rotor axes). */
  readonly thrustAxis: Vec3;
  /** Rotation taking body +Z onto thrustAxis (the attitude set-point aligns thrustAxis, not body Z, with the thrust vector). */
  readonly axisOffset: Quaternion;
  readonly massKg: number;
  readonly inertia: Inertia3;
  /** World gravity, m/s². */
  readonly gravity: Vec3;
  /** World centre of mass at t = 0, m (set-points are offsets from it). */
  readonly start: Vec3;
  /** N at minRpm / maxRpm per controlled rotor (J = 0). */
  readonly minThrust: readonly number[];
  readonly maxThrust: readonly number[];
  /** N per (rev/min)² per controlled rotor at J = 0. */
  readonly thrustPerRpmSquared: readonly number[];
  /** Controller period, s. */
  readonly period: number;
}

/** Integrators and previous measurements carried between updates (12 numbers + 2 flags in the run's aux). */
export interface ControllerMemory {
  readonly velocityIntegral: Vec3;
  readonly rateIntegral: Vec3;
  readonly previousVelocity: Vec3;
  readonly previousRate: Vec3;
  readonly hasPrevious: boolean;
  /** The last update clamped a rotor: every integrator holds (conditional integration). */
  readonly clamped: boolean;
  /** The last update gave up yaw torque: only the yaw-rate integrator holds. */
  readonly yawCut: boolean;
}

export const RESTING_MEMORY: ControllerMemory = {
  velocityIntegral: [0, 0, 0],
  rateIntegral: [0, 0, 0],
  previousVelocity: [0, 0, 0],
  previousRate: [0, 0, 0],
  hasPrevious: false,
  clamped: false,
  yawCut: false,
};

export interface ControllerOutput {
  /** Commanded speed per controlled rotor, rev/min. */
  readonly rpm: number[];
  /** A limit clipped the demand (a rotor clamped or the yaw torque reduced): the saturation count of the run. */
  readonly saturated: boolean;
  readonly memory: ControllerMemory;
}

/** Share of the proportional authority an integrator may hold (anti-windup clamp). */
const INTEGRAL_SHARE = 0.5;

const DEG = Math.PI / 180;

const times = (a: Vec3, b: Vec3): Vec3 => [a[0] * b[0], a[1] * b[1], a[2] * b[2]];

const multiply = (m: Inertia3, v: Vec3): Vec3 => [dot3(m[0], v), dot3(m[1], v), dot3(m[2], v)];

/** Clamp each component of `value` to ±bound (bound <= 0 or not finite on an axis = 0 on it). */
const clampEach = (value: Vec3, bound: Vec3): Vec3 =>
  [0, 1, 2].map((i) => {
    const limit = bound[i] ?? 0;
    return limit > 0 && Number.isFinite(limit) ? Math.min(limit, Math.max(-limit, value[i] ?? 0)) : 0;
  }) as unknown as Vec3;

/** PID step with derivative on the measurement; the integral grows on the axes `integrate` allows and is clamped to ±integralBound. */
function pid(
  gains: PidGains,
  error: Vec3,
  integral: Vec3,
  derivative: Vec3,
  period: number,
  integrate: readonly [boolean, boolean, boolean],
  integralBound: Vec3,
): { output: Vec3; integral: Vec3 } {
  const grown = clampEach(add3(integral, scale3(error, period)), integralBound);
  const next: Vec3 = [integrate[0] ? grown[0] : integral[0], integrate[1] ? grown[1] : integral[1], integrate[2] ? grown[2] : integral[2]];
  return { output: sub3(add3(times(gains.p, error), times(gains.i, next)), times(gains.d, derivative)), integral: next };
}

/** Velocity set-point: P on the position error, horizontal speed and climb rate limited. */
function velocitySetpoint(runtime: ControllerRuntime, error: Vec3): Vec3 {
  const { gains, limits } = runtime.controller;
  const wanted = times(gains.position, error);
  const horizontal = Math.hypot(wanted[0], wanted[1]);
  const scale = horizontal > limits.maxHorizontalSpeedMps ? limits.maxHorizontalSpeedMps / horizontal : 1;
  const climb = Math.min(limits.maxVerticalSpeedMps, Math.max(-limits.maxVerticalSpeedMps, wanted[2]));
  return [wanted[0] * scale, wanted[1] * scale, climb];
}

/** Thrust vector F = m (a - g) with its tilt from `up` limited to maxTiltDeg (the horizontal part is shortened, never the vertical). */
function thrustVector(runtime: ControllerRuntime, acceleration: Vec3, up: Vec3): Vec3 {
  const force = scale3(sub3(acceleration, runtime.gravity), runtime.massKg);
  const vertical = Math.max(0, dot3(force, up));
  const horizontal = sub3(force, scale3(up, dot3(force, up)));
  const reach = vertical * Math.tan(runtime.controller.limits.maxTiltDeg * DEG);
  const length = len3(horizontal);
  const kept = length > reach ? scale3(horizontal, length > 0 ? reach / length : 0) : horizontal;
  return add3(scale3(up, vertical), kept);
}

/** Attitude set-point: the thrust axis along `direction`, heading yawDeg (body x towards [cos ψ, sin ψ, 0] projected). */
function attitudeSetpoint(runtime: ControllerRuntime, direction: Vec3, yawDeg: number): Quaternion {
  const heading: Vec3 = [Math.cos(yawDeg * DEG), Math.sin(yawDeg * DEG), 0];
  const b2 = normalize3OrZero(cross3(direction, heading));
  const side = len3(b2) > 0 ? b2 : normalize3OrZero(cross3(direction, [0, 1, 0]));
  const b1 = cross3(side, direction);
  return multiplyQuaternion(quaternionFromBasis(b1, side, direction), conjugate(runtime.axisOffset));
}

/** Rate-integrator clamp per axis: the integral term may reach INTEGRAL_SHARE of the proportional term at the rate limit (0 without an integrator). */
function integralBounds(gains: PidGains, maxRate: Vec3): Vec3 {
  const bound = (axis: 0 | 1 | 2): number => {
    const ki = gains.i[axis];
    return ki > 0 ? (INTEGRAL_SHARE * gains.p[axis] * maxRate[axis]) / ki : 0;
  };
  return [bound(0), bound(1), bound(2)];
}

/** One controller update from the measured body state and the active set-point. */
export function controllerUpdate(
  runtime: ControllerRuntime,
  body: BodyKinematics,
  setpoint: FlightSetpoint,
  memory: ControllerMemory,
): ControllerOutput {
  const { controller, period } = runtime;
  const { gains, limits } = controller;
  const gravityLength = len3(runtime.gravity);
  const up: Vec3 = gravityLength > 0 ? scale3(runtime.gravity, -1 / gravityLength) : [0, 0, 1];
  // conditional integration: a clamped rotor holds every integrator, a yaw cut only the yaw-rate one (thrust, roll, pitch were delivered)
  const free = !memory.clamped;
  const integrate = [free, free, free] as const;
  const integrateRate = [free, free, free && !memory.yawCut] as const;
  // position -> velocity -> acceleration
  const target = add3(runtime.start, setpoint.position);
  const velocitySp = velocitySetpoint(runtime, sub3(target, body.position));
  const acceleration = memory.hasPrevious ? scale3(sub3(body.linearVelocity, memory.previousVelocity), 1 / period) : ([0, 0, 0] as Vec3);
  const accelerationBound = Math.max(gravityLength, 1) * INTEGRAL_SHARE;
  const velocityLoop = pid(
    gains.velocity,
    sub3(velocitySp, body.linearVelocity),
    memory.velocityIntegral,
    acceleration,
    period,
    integrate,
    gains.velocity.i.map((ki) => (ki > 0 ? accelerationBound / ki : 0)) as unknown as Vec3,
  );
  // thrust vector -> collective + attitude set-point
  const force = thrustVector(runtime, velocityLoop.output, up);
  const direction = len3(force) > 0 ? normalize3OrZero(force) : up;
  const collective = Math.max(0, dot3(force, rotate(body.orientation, runtime.thrustAxis)));
  const desired = attitudeSetpoint(runtime, direction, setpoint.yawDeg);
  // attitude -> body rate -> angular acceleration -> torque
  const error = multiplyQuaternion(conjugate(body.orientation), desired);
  const sign = error[0] < 0 ? -1 : 1;
  const maxRate = scale3(limits.maxRateDegS, DEG);
  const rateSp = clampEach(times(gains.attitude, [2 * sign * error[1], 2 * sign * error[2], 2 * sign * error[3]]), maxRate);
  const rate = rotateInverse(body.orientation, body.angularVelocity);
  const angularAcceleration = memory.hasPrevious ? scale3(sub3(rate, memory.previousRate), 1 / period) : ([0, 0, 0] as Vec3);
  const rateLoop = pid(
    gains.rate,
    sub3(rateSp, rate),
    memory.rateIntegral,
    angularAcceleration,
    period,
    integrateRate,
    integralBounds(gains.rate, maxRate),
  );
  const torque = add3(multiply(runtime.inertia, rateLoop.output), cross3(rate, multiply(runtime.inertia, rate)));
  const allocation = allocate(runtime.mixer, [collective, torque[0], torque[1], torque[2]], runtime.minThrust, runtime.maxThrust);
  return {
    rpm: allocation.thrusts.map((thrust, i) => {
      const k = runtime.thrustPerRpmSquared[i] ?? 0;
      return k > 0 ? Math.sqrt(Math.max(0, thrust) / k) : 0;
    }),
    saturated: allocation.clamped || allocation.yawCut,
    memory: {
      velocityIntegral: velocityLoop.integral,
      rateIntegral: rateLoop.integral,
      previousVelocity: body.linearVelocity,
      previousRate: rate,
      hasPrevious: true,
      clamped: allocation.clamped,
      yawCut: allocation.yawCut,
    },
  };
}
