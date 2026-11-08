/**
 * Body-frame rotor law (TR-FLT-02) and body drag (TR-FLT-03), pure functions of the body state: the engine calls them every step through the
 * `loads` callback, the report re-evaluates them on the recorded samples.
 */

import type { BodyKinematics } from '@core/dynamics/physicsEngine';
import type { Vec3 } from '@core/model/vectors';
import { pchipEvaluate, pchipSlopes } from '@lib/pchip';
import { add3, cross3, dot3, normalize3OrZero, scale3, sub3 } from '@lib/vec3';
import type { BodyDrag, Rotor } from './model';
import { rotate, rotateInverse } from './frames';

/** |J| above which a static (J = 0) coefficient pair is outside its validated range (FLT_OUTSIDE_VALIDATED_RANGE). */
export const STATIC_ADVANCE_RATIO_LIMIT = 0.05;

interface Curve {
  readonly xs: readonly number[];
  readonly ys: readonly number[];
  readonly slopes: readonly number[];
}

const curveOf = (xs: readonly number[], ys: readonly number[]): Curve => ({ xs, ys, slopes: pchipSlopes(xs, ys) });

/** A rotor compiled for one run: body-fixed vectors in metres from the body's centre of mass, PCHIP slopes computed once. */
export interface RotorRuntime {
  readonly rotor: Rotor;
  /** Hub minus centre of mass at the modelled pose, m (fixed in the body). */
  readonly arm: Vec3;
  /** Unit thrust axis, fixed in the body. */
  readonly axis: Vec3;
  readonly law:
    | { readonly kind: 'static'; readonly thrustCoefficient: number; readonly powerCoefficient: number }
    | { readonly kind: 'table'; readonly thrust: Curve; readonly power: Curve };
}

export function compileRotor(rotor: Rotor, centerOfMass: Vec3, metresPerUnit: number): RotorRuntime {
  const { coefficients } = rotor;
  const js = coefficients.kind === 'table' ? coefficients.points.map((point) => point[0]) : [];
  const law: RotorRuntime['law'] =
    coefficients.kind === 'table'
      ? {
          kind: 'table',
          thrust: curveOf(
            js,
            coefficients.points.map((point) => point[1]),
          ),
          power: curveOf(
            js,
            coefficients.points.map((point) => point[2]),
          ),
        }
      : { kind: 'static', thrustCoefficient: coefficients.thrustCoefficient, powerCoefficient: coefficients.powerCoefficient };
  return { rotor, arm: sub3(scale3(rotor.hub, metresPerUnit), centerOfMass), axis: normalize3OrZero(rotor.axis), law };
}

export interface RotorOutput {
  /** N along the axis. */
  readonly thrust: number;
  /** N·m aerodynamic torque magnitude (the reaction on the body is -spin · torque about the axis). */
  readonly torque: number;
  /** W absorbed from the shaft. */
  readonly power: number;
  /** m/s: hub velocity along the thrust axis (inflow through the disc, positive when moving the way the thrust points). */
  readonly axialVelocity: number;
  readonly advanceRatio: number;
  /** J outside the table (coefficients held at its end) or, for a static pair, |J| > STATIC_ADVANCE_RATIO_LIMIT. */
  readonly outsideRange: boolean;
  /** World force at the hub, N. */
  readonly force: Vec3;
  /** World moment about the body's centre of mass, N·m: r × F, the reaction torque and the gyroscopic torque. */
  readonly moment: Vec3;
}

function coefficientsAt(runtime: RotorRuntime, j: number): { ct: number; cp: number; outside: boolean } {
  const { law } = runtime;
  if (law.kind === 'static')
    return { ct: law.thrustCoefficient, cp: law.powerCoefficient, outside: Math.abs(j) > STATIC_ADVANCE_RATIO_LIMIT };
  const { thrust, power } = law;
  const first = thrust.xs[0] ?? 0;
  const last = thrust.xs[thrust.xs.length - 1] ?? 0;
  return {
    ct: pchipEvaluate(thrust.xs, thrust.ys, thrust.slopes, j).value,
    cp: pchipEvaluate(power.xs, power.ys, power.slopes, j).value,
    outside: j < first || j > last,
  };
}

/** C_T and C_P at J = 0 (the hover / static coefficients the mixer inverts the rotor law with). */
export function staticCoefficients(runtime: RotorRuntime): { readonly ct: number; readonly cp: number } {
  const { ct, cp } = coefficientsAt(runtime, 0);
  return { ct, cp };
}

/** Validated advance-ratio range of a rotor's coefficients (FR-FLT-08): ±STATIC_ADVANCE_RATIO_LIMIT for a static pair, the table span else. */
export function validatedRange(runtime: RotorRuntime): readonly [number, number] {
  const { law } = runtime;
  if (law.kind === 'static') return [-STATIC_ADVANCE_RATIO_LIMIT, STATIC_ADVANCE_RATIO_LIMIT];
  const first = law.thrust.xs[0] ?? 0;
  const last = law.thrust.xs[law.thrust.xs.length - 1] ?? 0;
  return [first, last];
}

/**
 * Rotor wrench at body state `body`: V_axial = (v + ω × r) · a, J = V_axial / (n D); T = C_T ρ n² D⁴ along a at the hub;
 * Q = C_P ρ n² D⁵ / (2π), reaction -s·Q·a; gyroscopic -ω × (I_s · 2πn · s · a); s = +1 for 'ccw'. `rpm` is the rotor's own constant speed
 * unless a flight controller commands it; `body.linearVelocity` is relative to the air (`airRelative` under wind).
 */
export function rotorOutput(runtime: RotorRuntime, body: BodyKinematics, rpm: number = runtime.rotor.rpm): RotorOutput {
  const { rotor } = runtime;
  const n = rpm / 60;
  const spin = rotor.spin === 'ccw' ? 1 : -1;
  const axis = rotate(body.orientation, runtime.axis);
  const arm = rotate(body.orientation, runtime.arm);
  const omega = body.angularVelocity;
  const axialVelocity = dot3(add3(body.linearVelocity, cross3(omega, arm)), axis);
  const advanceRatio = n > 0 ? axialVelocity / (n * rotor.diameter) : 0;
  const { ct, cp, outside } = coefficientsAt(runtime, advanceRatio);
  const rho = rotor.airDensity;
  const thrust = ct * rho * n * n * rotor.diameter ** 4;
  const torque = (cp * rho * n * n * rotor.diameter ** 5) / (2 * Math.PI);
  const force = scale3(axis, thrust);
  const momentum = scale3(axis, rotor.spinInertiaKgM2 * 2 * Math.PI * n * spin);
  const moment = sub3(add3(cross3(arm, force), scale3(axis, -spin * torque)), cross3(omega, momentum));
  return { thrust, torque, power: torque * 2 * Math.PI * n, axialVelocity, advanceRatio, outsideRange: outside, force, moment };
}

/** World drag force (N) at the centre of mass: -½ ρ CdA_i |v| v_i in the body axes (v relative to the air). */
export function bodyDragForce(drag: BodyDrag, body: BodyKinematics): Vec3 {
  const local = rotateInverse(body.orientation, body.linearVelocity);
  const speed = Math.hypot(local[0], local[1], local[2]);
  const k = -0.5 * drag.airDensity * speed;
  return rotate(body.orientation, [k * drag.cdaM2[0] * local[0], k * drag.cdaM2[1] * local[1], k * drag.cdaM2[2] * local[2]]);
}
