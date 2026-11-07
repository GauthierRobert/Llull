/**
 * Permanent-magnet DC motor law (PHY-23 TR-DRV-05 / 06, D-DRV-01): ke = kt (SI), L·di/dt = u - R·i - kt·ω_m, torque kt·i on the motor shaft,
 * through a gearhead of ratio N (joint speed = motor speed / N) with forward / back efficiency. Exact exponential per step for ω frozen.
 */

import type { DcMotor } from '@core/model/drives';
import type { DynamicsModel } from '@core/model/dynamics';

export interface DcParameters {
  readonly resistanceOhm: number;
  readonly inductanceH: number;
  readonly torqueConstant: number;
  readonly gearRatio: number;
  readonly efficiencyForward: number;
  readonly efficiencyBack: number;
  /**
   * kg·m² about the joint: η_f · (rotor + gearhead) · N². The gear mesh sits between the rotor and the joint, so the rotor's own inertial torque
   * is upstream of the loss: J_o·α = η·N·(τ_em - J_r·N·α) gives (J_o + η·N²·J_r)·α = η·N·τ_em (exact while motoring).
   */
  readonly armatureKgM2: number;
  /** N·m about the joint: Coulomb friction kt · I0 of the motor, through the gearhead (η_f · N times at the joint). */
  readonly frictionNm: number;
  /** A: the largest current the drive commands (peak current, else U_nominal / R). */
  readonly currentLimitA: number;
}

export function dcParameters(motor: DcMotor): DcParameters {
  const sheet = motor.datasheet;
  // absent optional parts are neutral by definition: no gearhead is a 1:1 lossless coupling, no inductance / no-load current is zero
  const gearhead = motor.gearhead;
  const ratio = gearhead === undefined ? 1 : gearhead.ratio;
  const efficiency = gearhead === undefined ? 1 : gearhead.efficiency;
  const gearInertia = gearhead === undefined || gearhead.inertiaKgM2 === undefined ? 0 : gearhead.inertiaKgM2;
  const noLoadCurrent = sheet.noLoadCurrentA === undefined ? 0 : sheet.noLoadCurrentA;
  return {
    resistanceOhm: sheet.terminalResistanceOhm,
    inductanceH: sheet.terminalInductanceH === undefined ? 0 : sheet.terminalInductanceH,
    torqueConstant: sheet.torqueConstantNmPerA,
    gearRatio: ratio,
    efficiencyForward: efficiency,
    efficiencyBack: gearhead === undefined || gearhead.efficiencyBack === undefined ? efficiency : gearhead.efficiencyBack,
    armatureKgM2: efficiency * (sheet.rotorInertiaKgM2 + gearInertia) * ratio * ratio,
    frictionNm: efficiency * ratio * sheet.torqueConstantNmPerA * noLoadCurrent,
    currentLimitA: sheet.peakCurrentA ?? sheet.nominalVoltageV / sheet.terminalResistanceOhm,
  };
}

/** N·m of Coulomb friction the datasheet motors add to joint `jointId` (their no-load friction seen through the gearheads). */
export function motorFrictionOn(dynamics: DynamicsModel, jointId: string): number {
  return Object.values(dynamics.motors).reduce(
    (sum, motor) => (motor.kind === 'dc' && motor.joint === jointId ? sum + dcParameters(motor).frictionNm : sum),
    0,
  );
}

/** Largest torque (N·m) the motor puts on its joint at its current limit `currentLimitA` (default the motor's own). */
export function peakJointTorque(motor: DcMotor, currentLimitA?: number): number {
  const p = dcParameters(motor);
  return p.gearRatio * p.efficiencyForward * p.torqueConstant * (currentLimitA ?? p.currentLimitA);
}

/** Electrical time constant L / R, s. */
export const electricalTimeConstant = (p: DcParameters): number => p.inductanceH / p.resistanceOhm;

/** True when the current follows the voltage instantly at step `dt` (L = 0, or τe < dt / 50): DRV_ELECTRICAL_QUASI_STATIC. */
export const isQuasiStatic = (p: DcParameters, dt: number): boolean => p.inductanceH === 0 || electricalTimeConstant(p) < dt / 50;

export interface ElectricalStep {
  /** A at the end of the step. */
  readonly current: number;
  /** A: mean over the step. */
  readonly meanCurrent: number;
  /** J: ∫ R·i² dt over the step. */
  readonly copperJ: number;
  /** J: change of the stored magnetic energy ½·L·i². */
  readonly magneticJ: number;
}

/**
 * One step of the winding at terminal voltage `volts` with the motor shaft at `omegaMotor` (rad/s, frozen), from current `i0`:
 * i1 = i_ss + (i0 - i_ss)·e^(-dt/τe), mean current i_ss + (i0 - i_ss)·(τe/dt)·(1 - e^(-dt/τe)), copper loss the exact integral of R·i².
 */
export function electricalStep(p: DcParameters, volts: number, omegaMotor: number, i0: number, dt: number): ElectricalStep {
  const steady = (volts - p.torqueConstant * omegaMotor) / p.resistanceOhm;
  if (isQuasiStatic(p, dt)) return { current: steady, meanCurrent: steady, copperJ: p.resistanceOhm * steady * steady * dt, magneticJ: 0 };
  const tau = electricalTimeConstant(p);
  const decay = Math.exp(-dt / tau);
  const delta = i0 - steady;
  const current = steady + delta * decay;
  return {
    current,
    meanCurrent: steady + delta * (tau / dt) * (1 - decay),
    copperJ:
      p.resistanceOhm * (steady * steady * dt + 2 * steady * delta * tau * (1 - decay) + (delta * delta * tau * (1 - decay * decay)) / 2),
    magneticJ: 0.5 * p.inductanceH * (current * current - i0 * i0),
  };
}

export interface JointTorque {
  /** N·m on the joint. */
  readonly torque: number;
  /** J lost in the gearhead over a step of `dt` (always >= 0). */
  readonly gearLossJ: number;
}

/** Joint torque of the motor shaft torque `shaftTorque` (N·m) at motor speed `omegaMotor`: motoring pays the forward efficiency, braking the back one. */
export function jointTorque(p: DcParameters, shaftTorque: number, omegaMotor: number, dt: number): JointTorque {
  const power = shaftTorque * omegaMotor;
  if (power >= 0) return { torque: p.gearRatio * p.efficiencyForward * shaftTorque, gearLossJ: (1 - p.efficiencyForward) * power * dt };
  return { torque: (p.gearRatio * shaftTorque) / p.efficiencyBack, gearLossJ: -power * (1 / p.efficiencyBack - 1) * dt };
}

/** Motor shaft torque that puts joint torque `torque` on the joint at motor speed `omegaMotor` (inverse of `jointTorque`). */
export function shaftTorqueFor(p: DcParameters, torque: number, omegaMotor: number): number {
  return torque * omegaMotor >= 0 ? torque / (p.gearRatio * p.efficiencyForward) : (torque * p.efficiencyBack) / p.gearRatio;
}
