/**
 * 13 FLT M3b pure laws: Peukert drain of the pack (Peukert 1897, Linden's Handbook of Batteries §3.2), the ESC efficiency map (bilinear, one
 * fixed point shared by run_flight / trim / estimate_endurance) and the winding temperature of the motors (the drives' two-node network).
 */
import { describe, expect, it } from 'vitest';
import { constantLoadEndurance } from '@dynamics/flight/endurance';
import { compilePower, initialPowerAux, POWER, POWER_SLOTS, remainingS, stepPower } from '@dynamics/flight/powerBlock';
import { drainCurrentA, escEfficiencyAt, motorPoint, openCircuitVolts, packLaw, solveChain } from '@dynamics/flight/powerChain';
import type { FlightBattery, FlightPowertrain } from '@dynamics/flight/powerModel';
import { initialThermalAux, motorThermalMetrics, stepMotorThermal, thermalOffset, thermalSlotCount } from '@dynamics/flight/motorThermal';
import { trimPowertrains } from '@dynamics/flight/trimPower';
import { thermalParams, windingRiseAt, windingTemperatureSeries } from '@dynamics/sim/actuators/thermal';
import { pow } from '@lib/pow';

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
const powertrain = (overrides: Partial<FlightPowertrain> = {}): FlightPowertrain => ({
  id: 'pt',
  batteryId: 'b',
  rotorIds: ['r'],
  motor: { nominalVoltageV: 12, terminalResistanceOhm: 0.2, torqueConstantNmPerA: 0.02, rotorInertiaKgM2: 1e-5, noLoadCurrentA: 0.4 },
  motorSource: 't',
  escEfficiency: 0.9,
  auxiliaryPowerW: 2,
  defaulted: [],
  ...overrides,
});
const LOAD = [{ torqueNm: 0.05, rpm: 3000 }];

describe('Peukert drain (FLT-M3b item 1)', () => {
  it('k absent or 1 leaves the pack law and every result bit-identical', () => {
    expect(packLaw(battery()).peukert).toBeUndefined();
    expect(packLaw(battery({ peukertExponent: 1, peukertRatedHours: 20 }))).toEqual(packLaw(battery()));
    expect(drainCurrentA(packLaw(battery()), 7.3)).toBe(7.3);
    const plain = compilePower(powertrain(), battery(), ['r']);
    const unit = compilePower(powertrain(), battery({ peukertExponent: 1 }), ['r']);
    expect(constantLoadEndurance(unit, LOAD, 1)).toEqual(constantLoadEndurance(plain, LOAD, 1));
    const step = (feed: typeof plain): Float64Array => {
      const aux = new Float64Array(POWER_SLOTS);
      initialPowerAux(feed, aux, 0);
      for (let k = 0; k < 50; k++) stepPower(feed, aux, 0, LOAD, k * 0.1, 0.1);
      return aux;
    };
    expect(Array.from(step(unit))).toEqual(Array.from(step(plain)));
  });

  it('textbook case: 100 Ah at the C/20 rate, k = 1.2, 20 A gives t = H (C / (I H))^k = 3.789 h and C_eff = 75.79 Ah', () => {
    // flat 12 V pack without resistance and a 240 W auxiliary load only: the current is 20 A for the whole discharge
    const pack = battery({
      cellsSeries: 6,
      capacityMah: 100_000,
      internalResistanceOhm: 0,
      ocv: [
        [0, 2],
        [1, 2],
      ],
      cutoffVoltPerCell: 1.75,
      peukertExponent: 1.2,
      peukertRatedHours: 20,
    });
    const feed = compilePower(powertrain({ auxiliaryPowerW: 240 }), pack, []);
    const result = constantLoadEndurance(feed, [], 1);
    const hours = 20 * pow(100 / (20 * 20), 1.2);
    expect(hours).toBeCloseTo(3.78929, 5);
    expect(result.limitedBy).toBe('empty');
    expect(result.initial.currentA).toBeCloseTo(20, 12);
    expect(result.timeS ?? 0).toBeCloseTo(hours * 3600, 6);
    expect(result.capacityOverCurrentS ?? 0).toBeCloseTo(hours * 3600, 6);
    expect(result.usedMah).toBeCloseTo(100_000 * pow(5 / 20, 0.2), 3);
    // at the rated current the capacity is the rated one
    const rated = constantLoadEndurance(compilePower(powertrain({ auxiliaryPowerW: 60 }), pack, []), [], 1);
    expect(rated.timeS ?? 0).toBeCloseTo(20 * 3600, 6);
  });

  it('the run block drains the SoC at the Peukert rate and counts the real charge; remainingS uses the drain current', () => {
    const pack = battery({ peukertExponent: 1.1 });
    const feed = compilePower(powertrain(), pack, ['r']);
    expect(feed.pack.peukert).toEqual({ exponent: 1.1, ratedCurrentA: 1 });
    const aux = new Float64Array(POWER_SLOTS);
    initialPowerAux(feed, aux, 0);
    stepPower(feed, aux, 0, LOAD, 0, 0.5);
    const current = aux[POWER.current] ?? 0;
    expect(aux[POWER.chargeAs]).toBeCloseTo(current * 0.5, 12);
    expect(1 - (aux[POWER.soc] ?? 0)).toBeCloseTo((current * pow(current, 0.1) * 0.5) / 3600, 12);
    const plain = compilePower(powertrain(), battery(), ['r']);
    expect((remainingS(plain, 1, 4) ?? 0) / (remainingS(feed, 1, 4) ?? 1)).toBeCloseTo(pow(4, 0.1), 12);
    expect(drainCurrentA(feed.pack, 0)).toBe(0);
  });
});

describe('ESC efficiency map (FLT-M3b item 3)', () => {
  // η = 0.7 + 0.2 throttle + 0.004 current: bilinear tables reproduce a bilinear function exactly
  const map = {
    throttle: [0, 0.5, 1],
    currentA: [0, 10, 20],
    efficiency: [0, 0.5, 1].map((t) => [0, 10, 20].map((i) => 0.7 + 0.2 * t + 0.004 * i)),
  };
  const mapped = powertrain({ escEfficiencyMap: map });

  it('is bilinear between the points, held at the ends, and the constant without a map', () => {
    expect(escEfficiencyAt(mapped, 0.3, 4)).toBeCloseTo(0.7 + 0.06 + 0.016, 12);
    expect(escEfficiencyAt(mapped, 0.8, 17)).toBeCloseTo(0.7 + 0.16 + 0.068, 12);
    expect(escEfficiencyAt(mapped, 1.4, 50)).toBeCloseTo(0.98, 12);
    expect(escEfficiencyAt(mapped, -1, -1)).toBeCloseTo(0.7, 12);
    expect(escEfficiencyAt(powertrain(), 0.3, 4)).toBe(0.9);
  });

  it('a map equal to the constant everywhere gives the constant-efficiency results exactly', () => {
    const flat = powertrain({
      escEfficiencyMap: {
        throttle: [0, 1],
        currentA: [0, 30],
        efficiency: [
          [0.9, 0.9],
          [0.9, 0.9],
        ],
      },
    });
    const plain = constantLoadEndurance(compilePower(powertrain(), battery(), ['r']), LOAD, 1);
    expect(constantLoadEndurance(compilePower(flat, battery(), ['r']), LOAD, 1)).toEqual(plain);
  });

  it('solves the throttle at the terminal voltage it produces (fixed point), the same law for the run, the trim and the endurance', () => {
    const feed = compilePower(mapped, battery(), ['r']);
    const ocv = openCircuitVolts(feed.pack, 1);
    const motors = LOAD.map((load) => motorPoint(feed.motor, load.torqueNm, (load.rpm * 2 * Math.PI) / 60));
    const { powerW, solved } = solveChain(feed.pack, mapped, ocv, motors);
    const terminal = solved?.terminalV ?? 0;
    const eta = escEfficiencyAt(mapped, (motors[0]?.voltageV ?? 0) / terminal, motors[0]?.currentA ?? 0);
    expect(powerW).toBeCloseTo(((motors[0]?.voltageV ?? 0) * (motors[0]?.currentA ?? 0)) / eta + 2, 9);
    expect(terminal * (solved?.currentA ?? 0)).toBeCloseTo(powerW, 9);
    // run block, trim and endurance read the same numbers
    const aux = new Float64Array(POWER_SLOTS);
    initialPowerAux(feed, aux, 0);
    stepPower(feed, aux, 0, LOAD, 0, 1e-6);
    expect(aux[POWER.current]).toBe(solved?.currentA);
    const trim = trimPowertrains([feed], ['r'], new Map([['r', LOAD[0] ?? { rpm: 0, torqueNm: 0 }]]));
    expect(trim[0]?.busPowerW).toBe(powerW);
    expect(constantLoadEndurance(feed, LOAD, 1).initial.busPowerW).toBe(powerW);
    // a collapsed pack has no solution with a map either
    const weak = compilePower(mapped, battery({ internalResistanceOhm: 80 }), ['r']);
    expect(solveChain(weak.pack, mapped, ocv, motors).solved).toBeNull();
  });
});

describe('motor winding temperature (FLT-M3b item 4)', () => {
  const thermal = { rthWindingHousingKPerW: 3, rthHousingAmbientKPerW: 6, tauWindingS: 20, tauMotorS: 400, maxWindingC: 120 };
  const hot = powertrain({ motor: { ...powertrain().motor, thermal }, motorAmbientC: 30, rotorIds: ['a', 'b'] });

  it('reuses the drives network: the in-loop step equals windingTemperatureSeries at a constant current', () => {
    const feed = compilePower(hot, battery(), ['a', 'b']);
    expect(feed.thermal).toEqual(thermalParams(hot.motor));
    expect(feed.ambientC).toBe(30);
    expect(thermalSlotCount([feed])).toBe(10);
    expect(thermalOffset([feed], 0, 1)).toBe(5);
    const aux = new Float64Array(thermalSlotCount([feed]));
    initialThermalAux([feed], aux, 0);
    const times = Array.from({ length: 201 }, (_, k) => k * 0.5);
    for (let k = 1; k < times.length; k++) stepMotorThermal(feed, aux, 0, 8, times[k - 1] ?? 0, 0.5);
    const series = windingTemperatureSeries(
      thermalParams(hot.motor) ?? (null as never),
      times,
      times.map(() => 8),
      30,
    );
    const metrics = motorThermalMetrics([feed], 0, 0, ['a', 'b'], (slot) => aux[slot] ?? 0, 200);
    expect(metrics?.motors[0]?.finalWindingC).toBeCloseTo(series.windingC.at(-1) ?? 0, 9);
    expect(metrics?.motors[0]?.finalHousingC).toBeCloseTo(series.housingC.at(-1) ?? 0, 9);
    expect(metrics?.motors[1]?.finalWindingC).toBe(30);
    expect(metrics).toMatchObject({ hottestRotorId: 'a', overLimitAtS: null, overLimitFraction: 0, maxWindingC: 120 });
  });

  it('with a negligible copper coefficient the rise is the closed-form network response; over the limit it records when and how long', () => {
    const cold = powertrain({ motor: { ...powertrain().motor, thermal: { ...thermal, alphaPerK: 1e-12, maxWindingC: 31 } } });
    const feed = compilePower(cold, battery(), ['r']);
    const aux = new Float64Array(thermalSlotCount([feed]));
    initialThermalAux([feed], aux, 0);
    for (let k = 0; k < 100; k++) stepMotorThermal(feed, aux, 0, 5, k * 0.2, 0.2);
    const network = thermalParams(cold.motor) ?? (null as never);
    const rise = windingRiseAt(network, 25 * network.r25, 20);
    const metrics = motorThermalMetrics([feed], 0, 0, ['r'], (slot) => aux[slot] ?? 0, 100);
    expect(metrics?.peakWindingC).toBeCloseTo(25 + rise, 6);
    expect(metrics?.overLimitAtS).not.toBeNull();
    expect(metrics?.overLimitFraction).toBeGreaterThan(0);
  });

  it('a powertrain without thermal data has no slots, no metrics and is skipped by the step', () => {
    const feed = compilePower(powertrain(), battery(), ['r']);
    expect(feed.thermal).toBeNull();
    expect(thermalSlotCount([feed])).toBe(0);
    expect(thermalOffset([feed], 0, 0)).toBe(-1);
    expect(thermalOffset([feed], 0, -1)).toBe(-1);
    expect(motorThermalMetrics([feed], 0, 0, ['r'], () => 0, 1)).toBeNull();
    const aux = new Float64Array(2);
    stepMotorThermal(feed, aux, 0, 10, 0, 1);
    expect(Array.from(aux)).toEqual([0, 0]);
    // the second powertrain's offset skips the first one's motors
    const heated = compilePower(hot, battery(), ['a', 'b']);
    expect(thermalOffset([heated, feed, heated], 2, 0)).toBe(10);
  });
});
