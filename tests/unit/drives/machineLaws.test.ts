/** VC-DRV-25 / 26 / 27 laws without a simulation: the PMSM envelope, the induction torque-slip curve and the stepper holding and pull-out torque against hand calculations. */
import { describe, expect, it } from 'vitest';
import type { InductionMotor, PmsmMotor, StepperMotor } from '@core/model/drives';
import { inductionCircuit, inductionParameters, inductionPoint, synchronousSpeed, voltsPerHertz } from '@dynamics/sim/actuators/induction';
import { phaseVoltageLimit, pmsmEnvelope, pmsmOperatingPoint, pmsmParameters } from '@dynamics/sim/actuators/pmsm';
import { periodsLost, pullOutTorque, stepperParameters, stepperTorque } from '@dynamics/sim/actuators/stepper';
import { section } from './fixtures';
import { INDUCTION_SHEET, MACHINE_SOURCE, PMSM_SHEET, STEPPER_SHEET } from './machineFixtures';

const pmsm = (sheet: Partial<typeof PMSM_SHEET> = {}): PmsmMotor => ({
  id: 'm',
  kind: 'pmsm',
  joint: 'j',
  datasheet: { ...PMSM_SHEET, ...sheet },
  source: MACHINE_SOURCE as PmsmMotor['source'],
});
const stepper = (sheet: Record<string, unknown> = {}): StepperMotor => ({
  id: 'm',
  kind: 'stepper',
  joint: 'j',
  datasheet: { ...STEPPER_SHEET, ...sheet } as StepperMotor['datasheet'],
  source: MACHINE_SOURCE as StepperMotor['source'],
});
const induction = (sheet: Record<string, unknown> = {}): InductionMotor => ({
  id: 'm',
  kind: 'induction',
  joint: 'j',
  datasheet: { ...INDUCTION_SHEET, ...sheet } as InductionMotor['datasheet'],
  source: MACHINE_SOURCE as InductionMotor['source'],
});

const relative = (value: number, expected: number): number => Math.abs(value / expected - 1);

describe('PMSM envelope (VC-DRV-25, TR-DRV-07)', () => {
  const reference = section<{
    maxTorqueNm: number;
    baseSpeedRadS: number;
    maxSpeedRadS: number;
    phaseVoltageLimitV: number;
    envelope: { mechSpeedRadS: number; torqueNm: number; idA: number }[];
  }>('pmsm');
  const p = pmsmParameters(pmsm());
  const limits = { currentA: 20, busVoltageV: 24 };

  it('torque at rated current is 1.5 p lambda I = 1.2 N m, and Kt follows from lambda', () => {
    expect(p.torqueConstant).toBeCloseTo(1.5 * 4 * 0.01, 12);
    expect(pmsmEnvelope(p, limits, 0).torqueNm).toBeCloseTo(reference.maxTorqueNm, 12);
    expect(pmsmOperatingPoint(p, limits, 1.2, 100).iqA).toBeCloseTo(20, 12);
    expect(phaseVoltageLimit(24)).toBeCloseTo(reference.phaseVoltageLimitV, 9);
  });

  it('the envelope matches the reference table to 0.5 % (torque and field-weakening current)', () => {
    for (const row of reference.envelope) {
      const point = pmsmEnvelope(p, limits, row.mechSpeedRadS);
      expect(relative(point.torqueNm, row.torqueNm), `torque at ${row.mechSpeedRadS}`).toBeLessThan(0.005);
      expect(point.idA, `id at ${row.mechSpeedRadS}`).toBeCloseTo(row.idA, 3);
    }
  });

  it('base speed 321.634 rad/s and maximum speed 577.350 rad/s: torque is constant below, falls above, and is zero beyond', () => {
    expect(pmsmEnvelope(p, limits, reference.baseSpeedRadS * 0.9999).torqueNm).toBeCloseTo(1.2, 9);
    expect(pmsmEnvelope(p, limits, reference.baseSpeedRadS * 1.01).torqueNm).toBeLessThan(1.2 - 1e-4);
    expect(pmsmEnvelope(p, limits, reference.maxSpeedRadS * 0.9999).torqueNm).toBeGreaterThan(0);
    expect(pmsmEnvelope(p, limits, reference.maxSpeedRadS * 1.0001).torqueNm).toBe(0);
    const analyticBase = phaseVoltageLimit(24) / Math.hypot(0.01, 0.0002 * 20) / 4;
    expect(relative(analyticBase, reference.baseSpeedRadS)).toBeLessThan(0.005);
  });

  it('the envelope does not depend on the sign of the speed, and a torque above it is cut with the clipped flag', () => {
    expect(pmsmEnvelope(p, limits, -400).torqueNm).toBeCloseTo(pmsmEnvelope(p, limits, 400).torqueNm, 12);
    const cut = pmsmOperatingPoint(p, limits, 5, 100);
    expect(cut.clipped).toBe(true);
    expect(cut.torqueNm).toBeCloseTo(1.2, 12);
    expect(pmsmOperatingPoint(p, limits, -5, 100).torqueNm).toBeCloseTo(-1.2, 12);
    expect(pmsmOperatingPoint(p, limits, 0.5, 100).clipped).toBe(false);
  });

  it('electrical input = copper + torque x speed, and the stator voltage stays on the bus limit for R = 0 at the envelope', () => {
    const lossless = pmsmParameters(pmsm({ phaseResistanceOhm: 1e-9 }));
    for (const speed of [50, 300, 400, 500, 550]) {
      const full = pmsmOperatingPoint(lossless, limits, 1.2, speed);
      expect(full.powerW).toBeCloseTo(full.copperW + full.torqueNm * speed, 9);
      expect(full.voltageV).toBeLessThanOrEqual(phaseVoltageLimit(24) * (1 + 1e-6));
    }
    const field = pmsmOperatingPoint(lossless, limits, 1.2, 400);
    expect(field.voltageV).toBeCloseTo(phaseVoltageLimit(24), 6);
    expect(Math.hypot(field.idA, field.iqA)).toBeCloseTo(20, 6);
    // copper loss 1.5 R I^2 at the current limit
    expect(pmsmOperatingPoint(p, limits, 1.2, 100).copperW).toBeCloseTo(1.5 * 0.05 * 400, 9);
  });

  it('a partial torque in the field-weakening region uses the smallest |id| that keeps the voltage inside the bus', () => {
    const lossless = pmsmParameters(pmsm({ phaseResistanceOhm: 1e-9 }));
    const half = pmsmOperatingPoint(lossless, limits, 0.6, 450);
    const full = pmsmOperatingPoint(lossless, limits, pmsmEnvelope(lossless, limits, 450).torqueNm, 450);
    expect(Math.abs(half.idA)).toBeLessThan(Math.abs(full.idA));
    expect(half.voltageV).toBeLessThanOrEqual(phaseVoltageLimit(24) * (1 + 1e-6));
    // below the base speed there is no weakening at all
    expect(pmsmOperatingPoint(p, limits, 0.6, 200).idA).toBe(0);
  });

  it('a motor with lambda <= L I weakens its field without end: finite torque falling with speed, never an abrupt zero', () => {
    const wide = pmsmParameters(pmsm({ inductanceH: 0.001, fluxLinkageWb: 0.01 }));
    const before = pmsmEnvelope(wide, limits, 1000).torqueNm;
    const after = pmsmEnvelope(wide, limits, 4000).torqueNm;
    expect(before).toBeGreaterThan(after);
    expect(after).toBeGreaterThan(0);
    expect(pmsmEnvelope(wide, limits, 20000).torqueNm).toBeGreaterThan(0);
    // beyond the knee the torque is lambda-limited by V / (w L): T = 1.5 p lambda V / (w_e L)
    const high = pmsmEnvelope(wide, limits, 20000);
    expect(high.torqueNm).toBeCloseTo((wide.torqueConstant * phaseVoltageLimit(24)) / (4 * 20000 * 0.001), 9);
  });

  it('a torque constant can stand in for the flux linkage (lambda = Kt / (1.5 p))', () => {
    const viaKt = pmsmParameters({ ...pmsm(), datasheet: { ...PMSM_SHEET, torqueConstantNmPerA: 0.06 } });
    expect(viaKt.fluxLinkageWb).toBeCloseTo(0.01, 12);
    expect(viaKt.torqueConstant).toBeCloseTo(0.06, 12);
  });
});

describe('induction equivalent circuit (VC-DRV-26, TR-DRV-08)', () => {
  const reference = section<{
    kloss: { breakdownTorqueNm: number; breakdownSlip: number; torqueAtSlip: Record<string, number> };
    circuit: { breakdownSlip: number; breakdownTorqueNm: number; startingTorqueNm: number; syncSpeedRadS: number };
  }>('induction');
  const p = inductionParameters(induction());

  it('breakdown 197.208 N m at slip 0.194029, starting 84.0179 N m, to 1e-6 (closed forms and the torque of the point)', () => {
    const circuit = inductionCircuit(p, 230, 50);
    expect(relative(circuit.breakdownTorqueNm, reference.circuit.breakdownTorqueNm)).toBeLessThan(1e-6);
    expect(relative(circuit.breakdownSlip, reference.circuit.breakdownSlip)).toBeLessThan(1e-6);
    expect(relative(circuit.startingTorqueNm, reference.circuit.startingTorqueNm)).toBeLessThan(1e-6);
    expect(relative(circuit.syncSpeedRadS, reference.circuit.syncSpeedRadS)).toBeLessThan(1e-9);
    const sync = synchronousSpeed(p, 50);
    const atBreakdown = inductionPoint(p, 230, 50, sync * (1 - circuit.breakdownSlip));
    expect(relative(atBreakdown.torqueNm, reference.circuit.breakdownTorqueNm)).toBeLessThan(1e-6);
    expect(relative(inductionPoint(p, 230, 50, 0).torqueNm, reference.circuit.startingTorqueNm)).toBeLessThan(1e-6);
  });

  it('the Kloss form reproduces the textbook values when the stator resistance is nil (T_b 100, s_b 0.1 by construction)', () => {
    // R1 = 0: s_b = R2 / X and T_b = 3 V^2 / (2 w_s X); pick R2 = 0.2 and X = 2 for s_b = 0.1 and V so that T_b = 100
    const kloss = inductionParameters(induction({ statorResistanceOhm: 1e-12, rotorResistanceOhm: 0.2 }));
    const sync = synchronousSpeed(kloss, 50);
    const volts = Math.sqrt((100 * 2 * sync * 2) / 3);
    for (const [slip, torque] of Object.entries(reference.kloss.torqueAtSlip))
      expect(relative(inductionPoint(kloss, volts, 50, sync * (1 - Number(slip))).torqueNm, torque), `slip ${slip}`).toBeLessThan(1e-6);
  });

  it('power flow: input = air-gap + stator copper + iron, shaft = air-gap - rotor copper, rotor copper = s x air-gap', () => {
    const lossy = inductionParameters(induction({ ironLossResistanceOhm: 800 }));
    const sync = synchronousSpeed(lossy, 50);
    for (const slip of [0.02, 0.1, 0.5, 1, -0.05]) {
      const omega = sync * (1 - slip);
      const point = inductionPoint(lossy, 230, 50, omega);
      const airGap = point.torqueNm * sync;
      expect(point.rotorCopperW, `slip ${slip}`).toBeCloseTo(slip * airGap, 6);
      expect(point.powerW).toBeCloseTo(point.torqueNm * omega + point.statorCopperW + point.rotorCopperW + point.ironW, 6);
      expect(point.ironW).toBeCloseTo((3 * 230 * 230) / 800, 9);
    }
  });

  it('generating above synchronous speed: negative torque and negative slip; at synchronous speed the torque is nil', () => {
    const sync = synchronousSpeed(p, 50);
    expect(inductionPoint(p, 230, 50, sync * 1.03).torqueNm).toBeLessThan(0);
    expect(inductionPoint(p, 230, 50, sync * 1.03).slip).toBeCloseTo(-0.03, 12);
    expect(inductionPoint(p, 230, 50, sync).torqueNm).toBe(0);
  });

  it('V/f: constant ratio below the rated frequency, rated voltage above; a reversed supply reverses the torque; no frequency gives nothing', () => {
    expect(voltsPerHertz(p, 25)).toBeCloseTo(115, 12);
    expect(voltsPerHertz(p, 80)).toBe(230);
    expect(voltsPerHertz(p, -10)).toBeCloseTo(46, 12);
    const reverse = inductionPoint(p, 230, -50, 0);
    expect(reverse.torqueNm).toBeCloseTo(-inductionPoint(p, 230, 50, 0).torqueNm, 9);
    expect(inductionPoint(p, 230, 0, 5)).toMatchObject({ torqueNm: 0, powerW: 0, currentA: 0 });
    // the reactance scales with the frequency; hand value at 25 Hz, 115 V: X = 1, sqrt(R1^2 + X^2) = 1.1180, w_s = 78.540: 3 * 115^2 / (2 * 78.540 * (0.5 + 1.1180)) = 156.10 N m
    expect(inductionCircuit(p, 115, 25).breakdownTorqueNm).toBeCloseTo(156.1, 1);
  });
});

describe('stepper torque (VC-DRV-27, TR-DRV-08)', () => {
  const reference = section<{ naturalFrequencyHz: number; staticDeflectionDegAtHalfHoldingTorque: number; rotorTeeth: number }>('stepper');
  const p = stepperParameters(stepper());

  it('N_r = steps / 4 = 50; the full step is pi/2 electrical = 1.8 degrees', () => {
    expect(p.rotorTeeth).toBe(reference.rotorTeeth);
    expect(((2 * Math.PI) / p.stepsPerRev) * p.rotorTeeth).toBeCloseTo(Math.PI / 2, 12);
  });

  it('half the holding torque deflects the rotor by 0.6 degrees (sin(N_r theta) = 1/2), the small-angle ringing is 251.646 Hz', () => {
    const theta = ((reference.staticDeflectionDegAtHalfHoldingTorque * Math.PI) / 180) as number;
    // rotor behind the field by theta: the torque is T_h sin(N_r theta) = 0.25
    expect(stepperTorque(p, 0, theta, 0, 1).fieldNm).toBeCloseTo(0.25, 12);
    const stiffness = 0.5 * 50;
    expect(Math.sqrt(stiffness / 1e-5) / (2 * Math.PI)).toBeCloseTo(reference.naturalFrequencyHz, 6);
  });

  it('pull-out torque from L/R: T_h / sqrt(1 + (N_r w L/R)^2) (hand value at 100 rad/s: 0.5 / sqrt(1 + 100) )', () => {
    // tau = 0.003 / 1.5 = 2 ms; N_r w tau = 50 * 100 * 0.002 = 10
    expect(pullOutTorque(p, 0)).toBe(0.5);
    expect(pullOutTorque(p, 100)).toBeCloseTo(0.5 / Math.sqrt(101), 12);
    expect(pullOutTorque(p, -100)).toBeCloseTo(0.5 / Math.sqrt(101), 12);
  });

  it('a datasheet curve replaces L/R: linear between points, the holding torque below the first, zero beyond the last', () => {
    const curved = stepperParameters(
      stepper({
        pullOutCurve: [
          [60, 0.4],
          [600, 0.1],
        ],
      }),
    );
    const rad = (rpm: number): number => (rpm * 2 * Math.PI) / 60;
    expect(pullOutTorque(curved, 0)).toBeCloseTo(0.5, 12);
    expect(pullOutTorque(curved, rad(60))).toBeCloseTo(0.4, 12);
    expect(pullOutTorque(curved, rad(330))).toBeCloseTo(0.25, 12);
    expect(pullOutTorque(curved, rad(601))).toBe(0);
    expect(pullOutTorque(stepperParameters(stepper({ pullOutCurve: [[0, 0.45]] })), 0)).toBeCloseTo(0.45, 12);
  });

  it('detent and damping act without the field; the current scale scales the field torque only', () => {
    const rough = stepperParameters(stepper({ detentTorqueNm: 0.02, dampingNmsPerRad: 0.001 }));
    const theta = Math.PI / (8 * 50);
    const torque = stepperTorque(rough, theta, theta, 10, 0.5);
    expect(torque.fieldNm).toBe(0);
    expect(torque.detentNm).toBeCloseTo(-0.02 * Math.sin(4 * 50 * theta), 12);
    expect(torque.dampingNm).toBeCloseTo(-0.01, 12);
    expect(stepperTorque(p, 0, 0.01, 0, 0.5).fieldNm).toBeCloseTo(0.5 * 0.5 * Math.sin(0.5), 12);
  });

  it('steps lost count whole electrical periods (4 full steps): a lag inside the stable range loses none', () => {
    expect(periodsLost(0.9 * Math.PI)).toBe(0);
    expect(periodsLost(Math.PI * 0.51 * 2)).toBe(1);
    expect(periodsLost(-2.2 * Math.PI)).toBe(-1);
    expect(periodsLost(0)).toBe(0);
  });
});
