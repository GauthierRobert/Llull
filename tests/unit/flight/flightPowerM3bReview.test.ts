/**
 * FLT-M3b review fixes: the ESC map fixed point as a bracketed root (steep maps that a plain iteration cycles on), its named non-convergence
 * outcome, the MARGINAL band of the winding check on the allowed rise, and the run-time motorAmbientC flag of a pre-M3b thermal powertrain.
 */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { constantLoadEndurance } from '@dynamics/flight/endurance';
import type { FlightMetrics } from '@dynamics/flight/flightMetrics';
import { flightVerdict, DEFAULT_FLIGHT_LIMITS } from '@dynamics/flight/flightVerdict';
import { compilePower, initialPowerAux, POWER, POWER_SLOTS, powertrainDefaulted, stepPower } from '@dynamics/flight/powerBlock';
import { packLaw, solveBus, solveChain } from '@dynamics/flight/powerChain';
import type { FlightBattery, FlightPowertrain } from '@dynamics/flight/powerModel';
import { trimPowertrains } from '@dynamics/flight/trimPower';
import { quadDrone, step } from './flightFixture';

const battery: FlightBattery = {
  id: 'b',
  cellsSeries: 4,
  capacityMah: 1000,
  internalResistanceOhm: 0.2,
  ocv: [
    [0, 4.2],
    [1, 4.2],
  ],
  cutoffVoltPerCell: 2,
  initialSoc: 1,
  source: 't',
  defaulted: [],
};
const mapped = (throttle: readonly number[], efficiency: readonly (readonly number[])[], currentA = [0, 100]): FlightPowertrain => ({
  id: 'pt',
  batteryId: 'b',
  rotorIds: ['r'],
  motor: { nominalVoltageV: 12, terminalResistanceOhm: 0.2, torqueConstantNmPerA: 0.02, rotorInertiaKgM2: 1e-5 },
  motorSource: 't',
  escEfficiency: 0.9,
  auxiliaryPowerW: 0,
  defaulted: [],
  escEfficiencyMap: { throttle, currentA, efficiency },
});
const pack = packLaw(battery);
const OCV = 16.8;

/** Fixed-point residual |V - V_t(P(V))| at the pack voltage the throttle was read at; null when the pack cannot deliver. */
function residual(powertrain: FlightPowertrain, motors: readonly { voltageV: number; currentA: number }[]): number | null {
  const chain = solveChain(pack, powertrain, OCV, motors);
  return chain.solved === null ? null : Math.abs(chain.throttleVolts - chain.solved.terminalV);
}

/** Deterministic LCG in [0, 1). */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

describe('ESC map fixed point (bracketed root)', () => {
  it("the reviewer's steep seed (a 2-cycle of the plain iteration) meets V = V_t(P(V)) to 1e-9 V on the upper branch", () => {
    const steep = mapped(
      [0.7, 0.71],
      [
        [0.3, 0.3],
        [1, 1],
      ],
    );
    const motors = [{ voltageV: 10.58, currentA: 10 }];
    const chain = solveChain(pack, steep, OCV, motors);
    expect(chain.converged).toBe(true);
    expect(residual(steep, motors)).toBeLessThan(1e-9);
    expect(chain.solved?.terminalV ?? 0).toBeGreaterThan(OCV / 2);
    expect((chain.solved?.terminalV ?? 0) * (chain.solved?.currentA ?? 0)).toBeCloseTo(chain.powerW, 9);
  });

  it('a randomized sweep of steep maps: every deliverable point has a residual under 1e-9 V; the rest are true pack-power limits', () => {
    const next = random(7);
    let delivered = 0;
    for (let k = 0; k < 400; k++) {
      const start = 0.2 + 0.7 * next();
      const width = 0.001 + 0.05 * next();
      const corner = (): number => 0.2 + 0.8 * next();
      const powertrain = mapped(
        [start, start + width],
        [
          [corner(), corner()],
          [corner(), corner()],
        ],
        [0, 20 + 60 * next()],
      );
      const motors = [{ voltageV: 2 + 14 * next(), currentA: 1 + 40 * next() }];
      const chain = solveChain(pack, powertrain, OCV, motors);
      expect(chain.converged).toBe(true);
      const value = residual(powertrain, motors);
      if (value === null) {
        // the pack cannot carry the power at the fixed point: past OCV² / 4R, and the root sits at the collapse voltage OCV / 2
        expect(chain.powerW).toBeGreaterThan((OCV * OCV) / (4 * 0.2) - 1e-6);
        expect(solveBus(pack, OCV, chain.powerW)).toBeNull();
        continue;
      }
      delivered++;
      expect(value).toBeLessThan(1e-9);
    }
    expect(delivered).toBeGreaterThan(200);
  });

  it('a map steeper than the float resolution is the named outcome: converged false, counted by the run block, flagged by trim and endurance', () => {
    const cliff = mapped(
      [0.7, 0.7 + 1e-10],
      [
        [0.3, 0.3],
        [1, 1],
      ],
    );
    const motors = [{ voltageV: 10.58, currentA: 10 }];
    expect(solveChain(pack, cliff, OCV, motors).converged).toBe(false);
    const feed = compilePower(cliff, battery, ['r']);
    // a load whose motor point is 10.58 V / 10 A: kt 0.02, R 0.2 -> i = Q / kt, V = kt ω + R i
    const load = { torqueNm: 0.2, rpm: ((10.58 - 2) / 0.02) * (60 / (2 * Math.PI)) };
    const aux = new Float64Array(POWER_SLOTS);
    initialPowerAux(feed, aux, 0);
    stepPower(feed, aux, 0, [load], 0, 0.01);
    expect(aux[POWER.mapUnsolvedSteps]).toBe(1);
    expect(trimPowertrains([feed], ['r'], new Map([['r', load]]))[0]?.escMapNoFixedPoint).toBe(true);
    expect(constantLoadEndurance(feed, [load], 1).escMapUnsolvedSteps).toBeGreaterThan(0);
    // a regular map adds neither field
    const gentle = compilePower(
      mapped(
        [0, 1],
        [
          [0.8, 0.8],
          [0.95, 0.95],
        ],
      ),
      battery,
      ['r'],
    );
    expect(trimPowertrains([gentle], ['r'], new Map([['r', load]]))[0]).not.toHaveProperty('escMapNoFixedPoint');
    expect(constantLoadEndurance(gentle, [load], 1)).not.toHaveProperty('escMapUnsolvedSteps');
  });
});

describe('winding check band and the pre-M3b thermal powertrain', () => {
  const metricsWith = (peakWindingC: number): FlightMetrics =>
    ({
      control: null,
      events: [],
      recoveryTimeS: null,
      attitude: { maxTiltDeg: 0 },
      tracking: { finalPositionErrorM: 0 },
      durationS: 1,
      divergedAtS: null,
      battery: {
        pt: {
          batteryId: 'b',
          finalSoc: 1,
          cutoffAtS: null,
          enduranceS: null,
          enduranceBasis: 'no_load',
          motorThermal: {
            ambientC: 25,
            maxWindingC: 125,
            peakWindingC,
            hottestRotorId: 'r',
            motors: [],
            overLimitAtS: null,
            overLimitFraction: 0,
          },
        },
      },
    }) as unknown as FlightMetrics;
  const status = (peak: number): string | undefined =>
    flightVerdict(metricsWith(peak), DEFAULT_FLIGHT_LIMITS).checks.find((check) => check.name === 'motor_winding_c')?.status;

  it('motor_winding_c is MARGINAL within 10 % of the allowed rise (125 - 25 C: from 115 C), not of the limit in C', () => {
    expect(status(114)).toBe('PASS');
    expect(status(116)).toBe('MARGINAL');
    expect(status(126)).toBe('FAIL');
  });

  it('a powertrain saved before FLT-M3b (thermal datasheet, no ambient, no flag) is flagged motorAmbientC when it is read', () => {
    let doc = step(quadDrone(), 'add_battery', {
      id: 'pack',
      cellsSeries: 4,
      capacityMah: 5600,
      internalResistanceOhm: 0.04,
      source: 't',
    }).doc;
    doc = step(doc, 'add_flight_powertrain', {
      id: 'pt',
      battery: 'pack',
      rotors: ['r1', 'r2', 'r3', 'r4'],
      datasheet: {
        nominalVoltageV: 14.8,
        terminalResistanceOhm: 0.1,
        torqueConstantNmPerA: 0.01038,
        rotorInertiaKgM2: 1e-5,
        thermal: { rthWindingHousingKPerW: 5, rthHousingAmbientKPerW: 5, tauWindingS: 6, tauMotorS: 200, maxWindingC: 125 },
      },
      motorSource: 'm',
      escEfficiency: 0.95,
    }).doc;
    const stored = doc.flight?.powertrains?.['pt'];
    if (stored === undefined) throw new Error('no powertrain');
    const old: FlightPowertrain = { ...stored, defaulted: [] };
    expect(powertrainDefaulted(old)).toEqual(['motorAmbientC']);
    expect(powertrainDefaulted(stored)).toEqual(['motorAmbientC']);
    expect(powertrainDefaulted({ ...old, motorAmbientC: 30 })).toEqual([]);
    const flight = doc.flight;
    if (flight === undefined) throw new Error('no flight slice');
    const legacy = { ...doc, flight: { ...flight, powertrains: { pt: old } } };
    const estimate = execute(legacy, 'estimate_endurance', { powertrain: 'pt', rpm: 4000 }).data as {
      defaulted: string[];
      unverified: boolean;
    };
    expect(estimate.defaulted).toContain('powertrain.pt.motorAmbientC');
    expect(estimate.unverified).toBe(true);
  });
});
