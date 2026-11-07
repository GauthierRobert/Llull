/**
 * Hybrid stepper law (PHY-23 TR-DRV-08): two-phase, N_r = steps per revolution / 4 rotor teeth, one full step = π/2 electrical = 2π / steps rad.
 * T = T_h(ω)·sin(N_r·(θ_cmd − θ)) − T_det·sin(4·N_r·θ) − c·ω (Acarnley, Stepping Motors: a Guide to Theory and Practice, 4th ed., IET 2002, ch. 2-3;
 * Kenjo and Sugawara, Stepping Motors and Their Microprocessor Controls, 2nd ed., ch. 2). The pull-out torque T_h(ω) is the datasheet curve, else the
 * first-order roll-off of a phase driven at electrical frequency N_r·ω: T_h / √(1 + (N_r·ω·L/R)²).
 */

import type { StepperMotor } from '@core/model/drives';
import { drivetrainOf, type Drivetrain } from './drivetrain';

export interface StepperParameters extends Drivetrain {
  readonly stepsPerRev: number;
  /** Rotor teeth N_r = stepsPerRev / 4: electrical angle = N_r · mechanical angle. */
  readonly rotorTeeth: number;
  readonly holdingTorqueNm: number;
  readonly detentNm: number;
  readonly dampingNmsPerRad: number;
  readonly ratedCurrentA: number;
  readonly resistanceOhm: number;
  /** L / R, s. */
  readonly timeConstantS: number;
  /** Pull-out curve [rad/s, N·m] (first point at 0), or null for the L/R roll-off. */
  readonly pullOut: readonly (readonly [number, number])[] | null;
}

const RAD_PER_S_PER_RPM = (2 * Math.PI) / 60;

export function stepperParameters(motor: StepperMotor): StepperParameters {
  const sheet = motor.datasheet;
  const curve = sheet.pullOutCurve;
  const points: [number, number][] | null =
    curve === undefined ? null : curve.map(([rpm, torque]) => [rpm * RAD_PER_S_PER_RPM, torque] as [number, number]);
  const first = points === null ? undefined : points[0];
  if (points !== null && first !== undefined && first[0] > 0) points.unshift([0, sheet.holdingTorqueNm]);
  return {
    ...drivetrainOf(motor.gearhead, sheet.rotorInertiaKgM2, 0, sheet.ratedCurrentA),
    stepsPerRev: sheet.stepsPerRev,
    rotorTeeth: sheet.stepsPerRev / 4,
    holdingTorqueNm: sheet.holdingTorqueNm,
    detentNm: sheet.detentTorqueNm === undefined ? 0 : sheet.detentTorqueNm,
    dampingNmsPerRad: sheet.dampingNmsPerRad === undefined ? 0 : sheet.dampingNmsPerRad,
    ratedCurrentA: sheet.ratedCurrentA,
    resistanceOhm: sheet.phaseResistanceOhm,
    timeConstantS: sheet.phaseInductanceH / sheet.phaseResistanceOhm,
    pullOut: points,
  };
}

/** Pull-out torque (N·m, at the rated phase current) at motor-shaft speed `omega` (rad/s, sign ignored): the datasheet curve (0 beyond its last point), else L/R. */
export function pullOutTorque(p: StepperParameters, omega: number): number {
  const speed = Math.abs(omega);
  const curve = p.pullOut;
  if (curve === null) return p.holdingTorqueNm / Math.sqrt(1 + (p.rotorTeeth * speed * p.timeConstantS) ** 2);
  const last = curve[curve.length - 1];
  if (last === undefined || speed > last[0]) return 0;
  for (let k = 1; k < curve.length; k++) {
    const [a, b] = [curve[k - 1], curve[k]];
    if (a !== undefined && b !== undefined && speed <= b[0]) return a[1] + ((b[1] - a[1]) * (speed - a[0])) / (b[0] - a[0]);
  }
  return last[1];
}

export interface StepperTorque {
  /** N·m, the energised field: T_h(ω)·scale·sin(N_r·(θ_cmd − θ)). */
  readonly fieldNm: number;
  /** N·m: −T_det·sin(4·N_r·θ). */
  readonly detentNm: number;
  /** N·m: −c·ω. */
  readonly dampingNm: number;
  /** Electrical lag N_r·(θ_cmd − θ), rad (signed). */
  readonly lagRad: number;
}

/** Torque at the motor shaft at angle `theta`, speed `omega`, with the field at `thetaCmd`; `currentScale` = set current / rated current. */
export function stepperTorque(p: StepperParameters, theta: number, thetaCmd: number, omega: number, currentScale: number): StepperTorque {
  const lag = p.rotorTeeth * (thetaCmd - theta);
  return {
    fieldNm: pullOutTorque(p, omega) * currentScale * Math.sin(lag),
    detentNm: -p.detentNm * Math.sin(4 * p.rotorTeeth * theta),
    dampingNm: -p.dampingNmsPerRad * omega,
    lagRad: lag,
  };
}

/** Whole electrical periods (4 full steps each) the rotor has fallen behind the field: round(lag / 2π). Zero while the rotor holds a stable equilibrium. */
export const periodsLost = (lagRad: number): number => Math.round(lagRad / (2 * Math.PI));
