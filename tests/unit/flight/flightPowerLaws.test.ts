/** Pure laws of the 13 FLT M3 power chain (pack, DC motor, ESC): closed forms and the edges (clamps, flat OCV, no load, voltage collapse). */
import { describe, expect, it } from 'vitest';
import { constantLoadEndurance } from '@dynamics/flight/endurance';
import {
  busPower,
  maxOmega,
  motorLaw,
  motorPoint,
  openCircuitVolts,
  packLaw,
  socAtOpenCircuit,
  solveBus,
} from '@dynamics/flight/powerChain';
import { compilePower, initialPowerAux, packRpm, POWER, POWER_SLOTS, remainingS, stepPower } from '@dynamics/flight/powerBlock';
import type { FlightBattery, FlightPowertrain } from '@dynamics/flight/powerModel';

const battery = (overrides: Partial<FlightBattery> = {}): FlightBattery => ({
  id: 'b',
  cellsSeries: 4,
  capacityMah: 1000,
  internalResistanceOhm: 0.05,
  ocv: [
    [0, 3],
    [0.5, 3.6],
    [1, 4.2],
  ],
  cutoffVoltPerCell: 3.2,
  initialSoc: 1,
  source: 't',
  defaulted: [],
  ...overrides,
});
const powertrain: FlightPowertrain = {
  id: 'pt',
  batteryId: 'b',
  rotorIds: ['r'],
  motor: { nominalVoltageV: 12, terminalResistanceOhm: 0.2, torqueConstantNmPerA: 0.02, rotorInertiaKgM2: 1e-5, noLoadCurrentA: 0.4 },
  motorSource: 't',
  escEfficiency: 0.9,
  auxiliaryPowerW: 2,
  defaulted: [],
};

describe('pack law', () => {
  const pack = packLaw(battery());
  it('scales the cell curve by the series count, holds it flat outside, and inverts it on its slope', () => {
    expect(pack.capacityAs).toBeCloseTo(3600, 9);
    expect(pack.cutoffV).toBeCloseTo(12.8, 9);
    expect(openCircuitVolts(pack, 0)).toBeCloseTo(12, 9);
    expect(openCircuitVolts(pack, 0.25)).toBeCloseTo(13.2, 9);
    expect(openCircuitVolts(pack, 1)).toBeCloseTo(16.8, 9);
    expect(openCircuitVolts(pack, -1)).toBeCloseTo(12, 9);
    expect(openCircuitVolts(pack, 2)).toBeCloseTo(16.8, 9);
    expect(socAtOpenCircuit(pack, 13.2)).toBeCloseTo(0.25, 9);
    expect(socAtOpenCircuit(pack, 1)).toBe(0);
    expect(socAtOpenCircuit(pack, 99)).toBe(1);
  });
  it('inverts a flat step of the OCV curve to its lower SoC', () => {
    const flat = packLaw(
      battery({
        ocv: [
          [0, 3],
          [0.4, 3.6],
          [0.6, 3.6],
          [1, 4.2],
        ],
      }),
    );
    expect(socAtOpenCircuit(flat, 14.4)).toBeCloseTo(0.4, 9);
  });
  it('solves V·I = P with V = OCV - R·I, is exact without resistance, and refuses a power the pack cannot deliver', () => {
    const solved = solveBus(pack, 16, 100);
    expect(solved).not.toBeNull();
    expect((solved?.terminalV ?? 0) * (solved?.currentA ?? 0)).toBeCloseTo(100, 9);
    expect((solved?.terminalV ?? 0) + 0.05 * (solved?.currentA ?? 0)).toBeCloseTo(16, 9);
    expect(solveBus(packLaw(battery({ internalResistanceOhm: 0 })), 16, 100)?.currentA).toBeCloseTo(6.25, 12);
    expect(solveBus(pack, 16, 0)).toEqual({ currentA: 0, terminalV: 16 });
    expect(solveBus(pack, 16, 16 ** 2 / (4 * 0.05) + 1)).toBeNull();
    expect(solveBus(pack, 0, 1)).toBeNull();
  });
});

describe('DC motor and ESC', () => {
  const law = motorLaw(powertrain.motor);
  it('reads kt, R, I0 and the default peak current U / R from the datasheet', () => {
    expect(law).toEqual({ kt: 0.02, resistanceOhm: 0.2, noLoadCurrentA: 0.4, peakCurrentA: 60 });
    expect(motorLaw({ ...powertrain.motor, noLoadCurrentA: undefined, peakCurrentA: 9 } as never)).toMatchObject({
      noLoadCurrentA: 0,
      peakCurrentA: 9,
    });
  });
  it('current from torque, voltage from back-EMF plus the resistive drop, nothing when stopped', () => {
    const point = motorPoint(law, 0.1, 100);
    expect(point.currentA).toBeCloseTo(5.4, 12);
    expect(point.voltageV).toBeCloseTo(0.02 * 100 + 0.2 * 5.4, 12);
    expect(motorPoint(law, 0.1, 0)).toEqual({ currentA: 0, voltageV: 0 });
  });
  it('the ESC divides the motor power by its efficiency and the auxiliary load is added', () => {
    expect(busPower(powertrain, [{ currentA: 5, voltageV: 9 }])).toBeCloseTo(45 / 0.9 + 2, 12);
  });
  it('maxOmega returns the speed whose voltage is the available one, for a quadratic and a torque-free load', () => {
    const omega = maxOmega(law, 0.1, 100, 8);
    const torque = 0.1 * (omega / 100) ** 2;
    expect(motorPoint(law, torque, omega).voltageV).toBeCloseTo(8, 9);
    expect(maxOmega(law, 0, 100, 8)).toBeCloseTo((8 - 0.2 * 0.4) / 0.02, 12);
    expect(maxOmega(law, 0.1, 0, 8)).toBeCloseTo((8 - 0.2 * 0.4) / 0.02, 12);
    expect(maxOmega(law, 0.1, 100, 0.05)).toBe(0);
  });
});

describe('power block', () => {
  const feed = compilePower(powertrain, battery(), ['x', 'r']);
  const fresh = (): Float64Array => {
    const aux = new Float64Array(POWER_SLOTS);
    initialPowerAux(feed, aux, 0);
    return aux;
  };
  it('maps rotors to indexes and starts at the initial SoC with the open-circuit voltage', () => {
    expect(feed.rotorIndexes).toEqual([1]);
    const aux = fresh();
    expect(aux[POWER.soc]).toBe(1);
    expect(aux[POWER.voltage]).toBeCloseTo(16.8, 9);
    expect(aux[POWER.cutoffTime]).toBe(-1);
  });
  it('caps the speed on the pack voltage and counts the limited step; leaves a sustainable speed alone', () => {
    const aux = fresh();
    expect(packRpm(feed, aux, 0, 500, 0.01)).toBe(500);
    aux[POWER.voltage] = 3;
    const capped = packRpm(feed, aux, 0, 5000, 0.05);
    expect(capped).toBeLessThan(5000);
    expect(aux[POWER.limitedSteps]).toBe(1);
  });
  it('steps the charge, the energy and the cut-off, which latches and stops the motors', () => {
    const aux = fresh();
    stepPower(feed, aux, 0, [{ torqueNm: 0.05, rpm: 3000 }], 0.5, 0.5);
    const current = aux[POWER.current] ?? 0;
    expect(current).toBeGreaterThan(0);
    expect(aux[POWER.chargeAs]).toBeCloseTo(current * 0.5, 12);
    expect(aux[POWER.soc]).toBeCloseTo(1 - (current * 0.5) / 3600, 12);
    expect(aux[POWER.cutoffTime]).toBe(-1);
    expect(aux[POWER.overCurrentSteps]).toBe(0);
    // a motor over its peak current is counted; a collapsed pack cuts off
    const weak = compilePower({ ...powertrain, motor: { ...powertrain.motor, peakCurrentA: 5 } }, battery(), ['r']);
    stepPower(weak, aux, 0, [{ torqueNm: 0.2, rpm: 3000 }], 1, 0.5);
    expect(aux[POWER.overCurrentSteps]).toBe(1);
    stepPower(feed, aux, 0, [{ torqueNm: 50, rpm: 3000 }], 2, 0.5);
    expect(aux[POWER.cutoffTime]).toBe(2);
    expect(packRpm(feed, aux, 0, 3000, 0.05)).toBe(0);
    const charge = aux[POWER.chargeAs];
    stepPower(feed, aux, 0, [{ torqueNm: 0.05, rpm: 3000 }], 3, 0.5);
    expect(aux[POWER.chargeAs]).toBe(charge);
    expect(aux[POWER.current]).toBe(0);
  });
  it('an empty pack cuts off, remainingS gives charge over current to the SoC floor and nothing without a current', () => {
    const aux = fresh();
    aux[POWER.soc] = 1e-6;
    stepPower(feed, aux, 0, [{ torqueNm: 0.05, rpm: 3000 }], 7, 1);
    expect(aux[POWER.cutoffTime]).toBe(7);
    expect(aux[POWER.soc]).toBe(0);
    expect(remainingS(feed, 1, 0)).toBeNull();
    const floor = socAtOpenCircuit(feed.pack, feed.pack.cutoffV + 0.05 * 4);
    expect(remainingS(feed, 1, 4)).toBeCloseTo(((1 - floor) * 3600) / 4, 9);
    expect(remainingS(feed, 0, 4)).toBe(0);
  });
});

describe('constant-load endurance', () => {
  it('has no endurance without a load and reports a refused pack power at once', () => {
    const quiet = compilePower({ ...powertrain, auxiliaryPowerW: 0 }, battery(), ['r']);
    const idle = constantLoadEndurance(quiet, [{ torqueNm: 0, rpm: 0 }], 1);
    expect(idle).toMatchObject({ timeS: null, limitedBy: 'no_load', capacityOverCurrentS: null });
    const weak = compilePower(powertrain, battery({ internalResistanceOhm: 50 }), ['r']);
    expect(constantLoadEndurance(weak, [{ torqueNm: 0.1, rpm: 3000 }], 1)).toMatchObject({ timeS: 0, limitedBy: 'pack_power' });
  });
  it('an ideal flat pack empties at charge / current, and the used charge is the capacity', () => {
    const ideal = compilePower(
      powertrain,
      battery({
        internalResistanceOhm: 0,
        ocv: [
          [0, 3.7],
          [1, 3.7],
        ],
        cutoffVoltPerCell: 3,
      }),
      ['r'],
    );
    const result = constantLoadEndurance(ideal, [{ torqueNm: 0.05, rpm: 3000 }], 1);
    expect(result.limitedBy).toBe('empty');
    expect(result.timeS).toBeCloseTo(3600 / result.initial.currentA, 3);
    expect(result.usedMah).toBeCloseTo(1000, 3);
    expect(result.finalSoc).toBe(0);
  });
});
