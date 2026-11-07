/**
 * Permanent-magnet DC motor law (PHY-23 TR-DRV-05 / 06, D-DRV-01): ke = kt (SI), L·di/dt = u - R·i - kt·ω_m, torque kt·i on the motor shaft,
 * through a gearhead of ratio N (joint speed = motor speed / N) with forward / back efficiency. Exact exponential per step for ω frozen.
 */

import type { DcMotor } from '@core/model/drives';
import { drivetrainOf, type Drivetrain } from './drivetrain';

export interface DcParameters extends Drivetrain {
  readonly resistanceOhm: number;
  readonly inductanceH: number;
  readonly torqueConstant: number;
}

export function dcParameters(motor: DcMotor): DcParameters {
  const sheet = motor.datasheet;
  // absent optional parts are neutral by definition: no inductance / no-load current is zero; Coulomb friction is kt · I0 at the shaft
  const noLoadCurrent = sheet.noLoadCurrentA === undefined ? 0 : sheet.noLoadCurrentA;
  const train = drivetrainOf(
    motor.gearhead,
    sheet.rotorInertiaKgM2,
    0,
    sheet.peakCurrentA ?? sheet.nominalVoltageV / sheet.terminalResistanceOhm,
  );
  return {
    ...train,
    frictionNm: train.efficiencyForward * train.gearRatio * sheet.torqueConstantNmPerA * noLoadCurrent,
    resistanceOhm: sheet.terminalResistanceOhm,
    inductanceH: sheet.terminalInductanceH === undefined ? 0 : sheet.terminalInductanceH,
    torqueConstant: sheet.torqueConstantNmPerA,
  };
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
