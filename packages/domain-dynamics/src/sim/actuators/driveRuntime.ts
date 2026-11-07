/** The run-time form of a driven datasheet motor (PHY-23 TR-DRV-01): its kind's parameters, its drive, its profile and controller, and where its state lives. */

import type { CompiledProfile } from '@core/geometry/motionProfile';
import type { DatasheetMotor, MotorDrive } from '@core/model/drives';
import type { LoopSpec } from './controller';
import type { DcParameters } from './dcMotor';
import type { Drivetrain } from './drivetrain';
import type { InductionParameters } from './induction';
import type { PmsmLimits, PmsmParameters } from './pmsm';
import type { StepperParameters } from './stepper';

/** A profile resolved for a run: compiled, with its unit scale to SI. */
export interface ResolvedProfile {
  readonly profile: CompiledProfile;
  readonly scale: number;
  readonly quantity: string;
}

/** The electrical law of a motor with the numbers it needs, by kind. */
export type MachineRuntime =
  | { readonly kind: 'dc'; readonly params: DcParameters }
  | { readonly kind: 'pmsm'; readonly params: PmsmParameters; readonly limits: PmsmLimits }
  | {
      readonly kind: 'stepper';
      readonly params: StepperParameters;
      /** Steps per full step (1 full, 2 half, n micro). */
      readonly division: number;
      /** Set phase current, A (the chopper setpoint). */
      readonly setCurrentA: number;
    }
  | { readonly kind: 'induction'; readonly params: InductionParameters; readonly frequencyHz: number | null };

/** A motor with a drive, ready to run. */
export interface DriveRuntime {
  readonly motor: DatasheetMotor;
  readonly drive: MotorDrive;
  readonly machine: MachineRuntime;
  /** The gearhead / rotor numbers shared by every kind (the same object as `machine.params`). */
  readonly params: Drivetrain;
  /** Index of the motor's first slot in `aux`. */
  readonly base: number;
  /** Index of the motor's first entry in the ledger. */
  readonly ledgerBase: number;
  /** Joint the controller measures. */
  readonly target: string;
  readonly currentLimitA: number;
  readonly busVoltageV: number;
  /** Constant terminal voltage (voltage mode without a profile), V. */
  readonly constantVolts: number;
  /** The profile the drive follows (any mode), null for a constant voltage. */
  readonly resolved: ResolvedProfile | null;
  readonly loop: LoopSpec | null;
}
