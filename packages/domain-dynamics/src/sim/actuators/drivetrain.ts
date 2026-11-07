/**
 * What every datasheet motor shares (PHY-23 TR-DRV-05 / 12): the gearhead between the motor shaft and the joint (joint speed = motor speed / N), the
 * rotor inertia and Coulomb friction seen at the joint, and the largest phase current the drive commands.
 */

import type { Gearhead } from '@core/model/drives';

export interface Drivetrain {
  readonly gearRatio: number;
  readonly efficiencyForward: number;
  readonly efficiencyBack: number;
  /**
   * kg·m² about the joint: η_f · (rotor + gearhead) · N². The gear mesh sits between the rotor and the joint, so the rotor's own inertial torque
   * is upstream of the loss: J_o·α = η·N·(τ_em - J_r·N·α) gives (J_o + η·N²·J_r)·α = η·N·τ_em (exact while motoring).
   */
  readonly armatureKgM2: number;
  /** N·m about the joint: the rotor's Coulomb friction at the motor shaft, through the gearhead (η_f · N times at the joint). */
  readonly frictionNm: number;
  /** A: the largest current the drive commands by default. */
  readonly currentLimitA: number;
}

/** The drivetrain of a motor with `gearhead` (absent = a 1:1 lossless coupling), rotor inertia and shaft friction `shaftFrictionNm` (N·m). */
export function drivetrainOf(
  gearhead: Gearhead | undefined,
  rotorInertiaKgM2: number,
  shaftFrictionNm: number,
  currentLimitA: number,
): Drivetrain {
  const ratio = gearhead === undefined ? 1 : gearhead.ratio;
  const efficiency = gearhead === undefined ? 1 : gearhead.efficiency;
  const gearInertia = gearhead === undefined || gearhead.inertiaKgM2 === undefined ? 0 : gearhead.inertiaKgM2;
  return {
    gearRatio: ratio,
    efficiencyForward: efficiency,
    efficiencyBack: gearhead === undefined || gearhead.efficiencyBack === undefined ? efficiency : gearhead.efficiencyBack,
    armatureKgM2: efficiency * (rotorInertiaKgM2 + gearInertia) * ratio * ratio,
    frictionNm: efficiency * ratio * shaftFrictionNm,
    currentLimitA,
  };
}

export interface JointTorque {
  /** N·m on the joint. */
  readonly torque: number;
  /** J lost in the gearhead over a step of `dt` (always >= 0). */
  readonly gearLossJ: number;
}

/** Joint torque of the motor shaft torque `shaftTorque` (N·m) at motor speed `omegaMotor`: motoring pays the forward efficiency, braking the back one. */
export function jointTorque(p: Drivetrain, shaftTorque: number, omegaMotor: number, dt: number): JointTorque {
  const power = shaftTorque * omegaMotor;
  if (power >= 0) return { torque: p.gearRatio * p.efficiencyForward * shaftTorque, gearLossJ: (1 - p.efficiencyForward) * power * dt };
  return { torque: (p.gearRatio * shaftTorque) / p.efficiencyBack, gearLossJ: -power * (1 / p.efficiencyBack - 1) * dt };
}

/** Motor shaft torque that puts joint torque `torque` on the joint at motor speed `omegaMotor` (inverse of `jointTorque`). */
export function shaftTorqueFor(p: Drivetrain, torque: number, omegaMotor: number): number {
  return torque * omegaMotor >= 0 ? torque / (p.gearRatio * p.efficiencyForward) : (torque * p.efficiencyBack) / p.gearRatio;
}
