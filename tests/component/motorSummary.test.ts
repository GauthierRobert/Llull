/** Display of the DRV-M4 motor kinds and of the frequency / step-division drive fields (pure presentation of src/ui/panels/motorSummary.ts). */
import { describe, expect, it } from 'vitest';
import type { InductionMotor, MotorDrive, PmsmMotor, StepperMotor } from '@core/model/drives';
import { driveFacts, driveHeadline, motorFacts, motorHeadline } from '@ui/panels/motorSummary';

const source = { name: 'test sheet', grade: 'B' } as const;

const pmsm: PmsmMotor = {
  id: 'mp',
  kind: 'pmsm',
  joint: 'j',
  datasheet: {
    polePairs: 4,
    phaseResistanceOhm: 0.05,
    inductanceH: 0.0002,
    fluxLinkageWb: 0.01,
    rotorInertiaKgM2: 1e-5,
    busVoltageV: 24,
    peakCurrentA: 20,
    nominalCurrentA: 9,
  },
  gearhead: { ratio: 5, efficiency: 0.9, efficiencyBack: 0.85 },
  source,
};
const stepper: StepperMotor = {
  id: 'ms',
  kind: 'stepper',
  joint: 'j',
  datasheet: {
    stepsPerRev: 200,
    holdingTorqueNm: 0.5,
    ratedCurrentA: 2,
    phaseResistanceOhm: 1.5,
    phaseInductanceH: 0.003,
    rotorInertiaKgM2: 1e-5,
    pullOutCurve: [
      [0, 0.5],
      [600, 0.2],
    ],
  },
  source,
  acceptInconsistent: 'misprint',
};
const induction: InductionMotor = {
  id: 'mi',
  kind: 'induction',
  joint: 'j',
  datasheet: {
    polePairs: 2,
    ratedVoltageV: 230,
    ratedFrequencyHz: 50,
    statorResistanceOhm: 0.5,
    rotorResistanceOhm: 0.4,
    statorLeakageReactanceOhm: 1,
    rotorLeakageReactanceOhm: 1,
    magnetisingReactanceOhm: 40,
    ironLossResistanceOhm: 800,
    rotorInertiaKgM2: 0.2,
  },
  source,
};

const value = (facts: readonly { label: string; value: string }[], label: string): string | undefined =>
  facts.find((fact) => fact.label === label)?.value;

describe('motor facts and headlines of the machine kinds', () => {
  it('pmsm: kind label, electrical rows, gearhead with the back efficiency, source; the headline names bus, current and gearhead', () => {
    const facts = motorFacts(pmsm);
    expect(value(facts, 'Kind')).toBe('datasheet PMSM / BLDC motor (field-oriented)');
    expect(value(facts, 'Pole pairs')).toBe('4');
    expect(value(facts, 'Bus voltage')).toBe('24 V');
    expect(value(facts, 'Peak current')).toBe('20 A');
    expect(value(facts, 'Flux linkage')).toBe('0.01 Wb');
    expect(value(facts, 'Torque constant Kt')).toBeUndefined();
    expect(value(facts, 'Gearhead')).toBe('5:1, efficiency 0.9 (back 0.85)');
    expect(value(facts, 'Source')).toBe('test sheet (grade B)');
    expect(motorHeadline(pmsm)).toBe('PMSM · 24 V bus · 20 A · 5:1');
  });

  it('stepper: the pull-out source, the unverified reason of an accepted sheet', () => {
    const facts = motorFacts(stepper);
    expect(value(facts, 'Kind')).toBe('datasheet hybrid stepper');
    expect(value(facts, 'Steps per revolution')).toBe('200');
    expect(value(facts, 'Pull-out torque')).toBe('datasheet curve, 2 points');
    expect(value(facts, 'Unverified')).toBe('datasheet accepted as inconsistent: misprint');
    expect(motorHeadline(stepper)).toBe('stepper · 200 steps · 0.5 N·m holding');
    const { pullOutCurve: _curve, ...withoutCurve } = stepper.datasheet;
    expect(value(motorFacts({ ...stepper, datasheet: withoutCurve }), 'Pull-out torque')).toBe('L/R roll-off');
  });

  it('induction: the supply, both resistances and reactances, the optional iron-loss resistance', () => {
    const facts = motorFacts(induction);
    expect(value(facts, 'Kind')).toBe('datasheet induction motor');
    expect(value(facts, 'Rated supply')).toBe('230 V per phase, 50 Hz');
    expect(value(facts, 'Stator R1 / X1')).toBe('0.5 Ω / 1 Ω');
    expect(value(facts, 'Iron-loss Rc')).toBe('800 Ω');
    expect(value(facts, 'Source')).toBe('test sheet (grade B)');
    expect(motorHeadline(induction)).toBe('induction · 230 V / 50 Hz');
  });
});

describe('drive facts of the machine drives', () => {
  it('a V/f drive reads as a supply, a direct-on-line drive shows volts and frequency, a stepper drive its step division', () => {
    const vf: MotorDrive = { id: 'mi', mode: 'frequency', profile: 'fp' };
    expect(value(driveFacts(vf), 'Mode')).toBe('V/f supply');
    expect(driveHeadline(vf)).toBe('V/f supply drive (profile fp)');
    const dol: MotorDrive = { id: 'mi', mode: 'voltage', volts: 230, frequencyHz: 50 };
    expect(value(driveFacts(dol), 'Terminal voltage')).toBe('230 V');
    expect(value(driveFacts(dol), 'Supply frequency')).toBe('50 Hz');
    const stepping: MotorDrive = { id: 'ms', mode: 'position', profile: 'pp', stepDivision: 16, currentLimitA: 1.5 };
    expect(value(driveFacts(stepping), 'Step division')).toBe('1/16');
    expect(value(driveFacts(stepping), 'Current limit')).toBe('1.5 A');
  });
});
