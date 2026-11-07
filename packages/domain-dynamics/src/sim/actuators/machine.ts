/** What the rest of the plugin asks of any datasheet motor kind (PHY-23 DRV-M4): its drivetrain, peak torque, capacity limits, thermal network and ledger layout. */

import type { DatasheetMotor } from '@core/model/drives';
import type { DynamicsModel, Motor } from '@core/model/dynamics';
import type { LedgerKind } from '@core/dynamics/physicsEngine';
import { dcParameters } from './dcMotor';
import type { Drivetrain } from './drivetrain';
import { inductionCircuit, inductionParameters } from './induction';
import { pmsmParameters } from './pmsm';
import { stepperParameters } from './stepper';
import { thermalNetwork, type ThermalParams } from './thermal';

export const isDatasheetMotor = (motor: Motor): motor is DatasheetMotor =>
  motor.kind === 'dc' || motor.kind === 'pmsm' || motor.kind === 'stepper' || motor.kind === 'induction';

/** The gearhead, rotor inertia and shaft friction of a datasheet motor as seen at its joint. */
export function drivetrainOfMotor(motor: DatasheetMotor): Drivetrain {
  switch (motor.kind) {
    case 'dc':
      return dcParameters(motor);
    case 'pmsm':
      return pmsmParameters(motor);
    case 'stepper':
      return stepperParameters(motor);
    case 'induction':
      return inductionParameters(motor);
  }
}

/** N·m of Coulomb friction the datasheet motors add to joint `jointId` (their rotor friction seen through the gearheads). */
export function motorFrictionOn(dynamics: DynamicsModel, jointId: string): number {
  return Object.values(dynamics.motors).reduce(
    (sum, motor) => (isDatasheetMotor(motor) && motor.joint === jointId ? sum + drivetrainOfMotor(motor).frictionNm : sum),
    0,
  );
}

/**
 * Largest torque (N·m) the motor puts on its joint: dc and pmsm at the current limit `currentLimitA` (default the motor's own), a stepper at its holding
 * torque scaled by the set current, an induction motor at its breakdown torque at the rated voltage and frequency.
 */
export function peakJointTorque(motor: DatasheetMotor, currentLimitA?: number): number {
  const train = drivetrainOfMotor(motor);
  const through = train.gearRatio * train.efficiencyForward;
  switch (motor.kind) {
    case 'dc':
      return through * dcParameters(motor).torqueConstant * (currentLimitA ?? train.currentLimitA);
    case 'pmsm':
      return through * pmsmParameters(motor).torqueConstant * (currentLimitA ?? train.currentLimitA);
    case 'stepper':
      return through * motor.datasheet.holdingTorqueNm * ((currentLimitA ?? motor.datasheet.ratedCurrentA) / motor.datasheet.ratedCurrentA);
    case 'induction': {
      const sheet = motor.datasheet;
      return through * inductionCircuit(inductionParameters(motor), sheet.ratedVoltageV, sheet.ratedFrequencyHz).breakdownTorqueNm;
    }
  }
}

export interface Capacity {
  readonly peakCurrentA: { readonly value: number; readonly basis: string } | null;
  readonly continuousCurrentA: { readonly value: number; readonly basis: string } | null;
  readonly maxSpeedRpm: number | null;
  readonly windingMaxC: number | null;
}

const given = (value: number | undefined, basis: string): { value: number; basis: string } | null =>
  value === undefined ? null : { value, basis };

/** The datasheet limits a duty cycle is held against (the recorded current is the one each kind records: see `thermalNetwork`). */
export function motorCapacity(motor: DatasheetMotor): Omit<Capacity, 'windingMaxC'> {
  switch (motor.kind) {
    case 'dc': {
      const sheet = motor.datasheet;
      return {
        peakCurrentA:
          sheet.peakCurrentA === undefined
            ? { value: sheet.nominalVoltageV / sheet.terminalResistanceOhm, basis: 'stall current U / R (the sheet gives no peak current)' }
            : { value: sheet.peakCurrentA, basis: 'datasheet peak current' },
        continuousCurrentA: given(sheet.nominalCurrentA, 'datasheet nominal (continuous) current'),
        maxSpeedRpm: sheet.maxSpeedRpm === undefined ? null : sheet.maxSpeedRpm,
      };
    }
    case 'pmsm': {
      const sheet = motor.datasheet;
      return {
        peakCurrentA: { value: sheet.peakCurrentA, basis: 'datasheet peak phase-current amplitude' },
        continuousCurrentA: given(sheet.nominalCurrentA, 'datasheet nominal phase-current amplitude'),
        maxSpeedRpm: sheet.maxSpeedRpm === undefined ? null : sheet.maxSpeedRpm,
      };
    }
    case 'stepper': {
      const sheet = motor.datasheet;
      return {
        peakCurrentA: { value: sheet.ratedCurrentA, basis: 'rated phase current (a stepper is current-limited by its chopper)' },
        continuousCurrentA: { value: sheet.ratedCurrentA, basis: 'rated phase current' },
        maxSpeedRpm: sheet.maxSpeedRpm === undefined ? null : sheet.maxSpeedRpm,
      };
    }
    case 'induction': {
      const sheet = motor.datasheet;
      return {
        peakCurrentA: given(sheet.peakCurrentA, 'datasheet peak load current'),
        continuousCurrentA: given(sheet.nominalCurrentA, 'datasheet rated load current I2 of the equivalent circuit'),
        maxSpeedRpm: sheet.maxSpeedRpm === undefined ? null : sheet.maxSpeedRpm,
      };
    }
  }
}

/** The thermal network of the motor's winding, or null without thermal data (effective resistance: see `thermalNetwork`). */
export function thermalOf(motor: DatasheetMotor): ThermalParams | null {
  switch (motor.kind) {
    case 'dc':
      return thermalNetwork(motor.datasheet.thermal, motor.datasheet.terminalResistanceOhm);
    case 'pmsm':
      return thermalNetwork(motor.datasheet.thermal, 1.5 * motor.datasheet.phaseResistanceOhm);
    case 'stepper':
      return thermalNetwork(motor.datasheet.thermal, 2 * motor.datasheet.phaseResistanceOhm);
    case 'induction':
      return thermalNetwork(motor.datasheet.thermal, 3 * (motor.datasheet.statorResistanceOhm + motor.datasheet.rotorResistanceOhm));
  }
}

const BASE_LEDGER: readonly LedgerKind[] = ['electrical_input', 'copper', 'magnetic', 'transmission_loss', 'regeneration'];

/** The ledger entries a motor kind records per step: the shared five, plus rotor damping loss (stepper) or iron and rotor copper loss (induction). */
export function ledgerKindsOf(kind: DatasheetMotor['kind']): readonly LedgerKind[] {
  if (kind === 'stepper') return [...BASE_LEDGER, 'rotor'];
  if (kind === 'induction') return [...BASE_LEDGER, 'iron', 'rotor'];
  return BASE_LEDGER;
}
