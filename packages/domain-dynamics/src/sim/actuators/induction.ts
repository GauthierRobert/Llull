/**
 * Induction motor law (PHY-23 TR-DRV-08): the per-phase steady-state equivalent circuit with the magnetising branch at the terminals (the approximate
 * circuit, Fitzgerald, Kingsley and Umans, Electric Machinery, 6th ed., sec. 6.6; Chapman, Electric Machinery Fundamentals, 5th ed., ch. 6).
 * T(s) = 3·V²·R2·s / (ω_s·((R1·s + R2)² + (s·X)²)), X = (X1 + X2)·f/f_rated, s = (ω_s − ω)/ω_s, ω_s = 2π·f/p. Breakdown at s_b = R2/√(R1² + X²),
 * T_b = 3·V² / (2·ω_s·(R1 + √(R1² + X²))). Torque is the steady-state value at the instantaneous slip (no flux transients: model form, stated).
 * Power flow: P_ag = T·ω_s; rotor copper s·P_ag = 3·I2²·R2; stator copper 3·R1·(I2² + Im²), Im = V/Xm(f); iron 3·V²/R_c; electrical input = P_ag + stator copper + iron.
 */

import type { InductionMotor } from '@core/model/drives';
import { drivetrainOf, type Drivetrain } from './drivetrain';

export interface InductionParameters extends Drivetrain {
  readonly polePairs: number;
  readonly ratedVoltageV: number;
  readonly ratedFrequencyHz: number;
  readonly r1: number;
  /** Rotor resistance referred to the stator, ohm. */
  readonly r2: number;
  /** X1 + X2 at the rated frequency, ohm. */
  readonly leakageReactanceOhm: number;
  readonly magnetisingReactanceOhm: number;
  /** Iron-loss resistance, ohm; 0 = no iron loss. */
  readonly ironLossResistanceOhm: number;
}

export function inductionParameters(motor: InductionMotor): InductionParameters {
  const sheet = motor.datasheet;
  return {
    ...drivetrainOf(
      motor.gearhead,
      sheet.rotorInertiaKgM2,
      sheet.frictionNm === undefined ? 0 : sheet.frictionNm,
      sheet.peakCurrentA === undefined ? Number.POSITIVE_INFINITY : sheet.peakCurrentA,
    ),
    polePairs: sheet.polePairs,
    ratedVoltageV: sheet.ratedVoltageV,
    ratedFrequencyHz: sheet.ratedFrequencyHz,
    r1: sheet.statorResistanceOhm,
    r2: sheet.rotorResistanceOhm,
    leakageReactanceOhm: sheet.statorLeakageReactanceOhm + sheet.rotorLeakageReactanceOhm,
    magnetisingReactanceOhm: sheet.magnetisingReactanceOhm,
    ironLossResistanceOhm: sheet.ironLossResistanceOhm === undefined ? 0 : sheet.ironLossResistanceOhm,
  };
}

/** Constant volts-per-hertz supply: rated voltage at and above the rated frequency, proportional below (no low-frequency boost). */
export const voltsPerHertz = (p: InductionParameters, frequencyHz: number): number =>
  p.ratedVoltageV * Math.min(1, Math.abs(frequencyHz) / p.ratedFrequencyHz);

/** Synchronous mechanical speed ω_s = 2π·f/p, rad/s (signed with the frequency). */
export const synchronousSpeed = (p: InductionParameters, frequencyHz: number): number => (2 * Math.PI * frequencyHz) / p.polePairs;

/** The reactance X(f) = (X1 + X2)·|f| / f_rated. */
const reactanceAt = (p: InductionParameters, frequencyHz: number): number =>
  (p.leakageReactanceOhm * Math.abs(frequencyHz)) / p.ratedFrequencyHz;

export interface InductionPoint {
  /** N·m at the motor shaft, positive along the field rotation. */
  readonly torqueNm: number;
  /** s = (ω_s − ω) / ω_s (0 when the supply has no frequency). */
  readonly slip: number;
  /** Load (rotor-referred stator) current I2, A RMS per phase. */
  readonly currentA: number;
  readonly statorCopperW: number;
  readonly rotorCopperW: number;
  readonly ironW: number;
  /** W: electrical input of the three phases. */
  readonly powerW: number;
}

const DEAD = { torqueNm: 0, slip: 0, currentA: 0, statorCopperW: 0, rotorCopperW: 0, ironW: 0, powerW: 0 } as const;

/** The operating point at phase voltage `volts` (V RMS), supply frequency `frequencyHz` (signed) and motor speed `omega` (rad/s). A supply without frequency gives nothing (no DC injection). */
export function inductionPoint(p: InductionParameters, volts: number, frequencyHz: number, omega: number): InductionPoint {
  const omegaSync = synchronousSpeed(p, frequencyHz);
  if (Math.abs(frequencyHz) < 1e-9 * p.ratedFrequencyHz) return DEAD;
  const slip = (omegaSync - omega) / omegaSync;
  const x = reactanceAt(p, frequencyHz);
  const denominator = (p.r1 * slip + p.r2) ** 2 + (slip * x) ** 2;
  const current2 = (volts * volts * slip * slip) / denominator;
  const torque = (3 * volts * volts * p.r2 * slip) / (omegaSync * denominator);
  // the magnetising current V / Xm(f) also flows through the stator resistance (added as 3·R1·Im², the cross term with I2 is neglected: it is the lower-order part of the no-load copper loss)
  const magnetising = volts / ((p.magnetisingReactanceOhm * Math.abs(frequencyHz)) / p.ratedFrequencyHz);
  const stator = 3 * p.r1 * (current2 + magnetising * magnetising);
  const iron = p.ironLossResistanceOhm > 0 ? (3 * volts * volts) / p.ironLossResistanceOhm : 0;
  const rotor = 3 * current2 * p.r2;
  // P_ag = T·ω_s, so rotor copper = s·P_ag and the shaft power T·ω = P_ag − rotor copper; the input is the air-gap power plus stator copper and iron
  const input = torque * omegaSync + stator + iron;
  return { torqueNm: torque, slip, currentA: Math.sqrt(current2), statorCopperW: stator, rotorCopperW: rotor, ironW: iron, powerW: input };
}

export interface InductionCircuit {
  readonly syncSpeedRadS: number;
  readonly breakdownSlip: number;
  readonly breakdownTorqueNm: number;
  readonly startingTorqueNm: number;
}

/** Breakdown slip and torque and the starting torque (s = 1) at supply `volts`, `frequencyHz` (> 0): closed forms of the circuit. */
export function inductionCircuit(p: InductionParameters, volts: number, frequencyHz: number): InductionCircuit {
  const omegaSync = synchronousSpeed(p, frequencyHz);
  const x = reactanceAt(p, frequencyHz);
  const root = Math.hypot(p.r1, x);
  return {
    syncSpeedRadS: omegaSync,
    breakdownSlip: p.r2 / root,
    breakdownTorqueNm: (3 * volts * volts) / (2 * omegaSync * (p.r1 + root)),
    startingTorqueNm: (3 * volts * volts * p.r2) / (omegaSync * ((p.r1 + p.r2) ** 2 + x * x)),
  };
}
