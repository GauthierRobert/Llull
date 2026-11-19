/**
 * Powertrain limits of a trim (13 FLT M5b): the hover operating point against estimate_endurance (the same pack / ESC / motor laws), and the
 * points run_flight could not hold (motor voltage above the pack, pack power, cut-off sag) as FLT_TRIM_SATURATED; over-current as a warning.
 */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { expectNoOp } from '../../helpers/expectNoOp';
import { G, quadDrone, step } from './flightFixture';

const MASS = 1.115;
const KT = 60 / (2 * Math.PI * 920);
const MOTOR = {
  nominalVoltageV: 14.8,
  terminalResistanceOhm: 0.1,
  torqueConstantNmPerA: KT,
  rotorInertiaKgM2: 1e-5,
  noLoadCurrentA: 0.5,
  peakCurrentA: 30,
};

/** Reference quad + controller + battery + powertrain + hover scenario `s`. */
function poweredQuad(battery: Record<string, unknown> = {}, motor: Record<string, unknown> = {}): CadDocument {
  let doc = step(quadDrone(MASS), 'add_flight_controller', { body: 'frame', maxRpm: 7000, id: 'fc' }).doc;
  doc = step(doc, 'add_battery', {
    id: 'pack',
    cellsSeries: 4,
    capacityMah: 5600,
    internalResistanceOhm: 0.04,
    ocv: [
      [0, 3.7],
      [1, 3.7],
    ],
    cutoffVoltPerCell: 3.3,
    source: 'test pack',
    ...battery,
  }).doc;
  doc = step(doc, 'add_flight_powertrain', {
    id: 'pt',
    battery: 'pack',
    rotors: ['r1', 'r2', 'r3', 'r4'],
    datasheet: { ...MOTOR, ...motor },
    motorSource: 'test motor',
    escEfficiency: 0.95,
  }).doc;
  return step(doc, 'define_flight_scenario', { body: 'frame', controller: 'fc', id: 's', durationS: 1 }).doc;
}

interface Powertrain {
  id: string;
  busPowerW: number;
  packCurrentA: number | null;
  terminalV: number | null;
  throttle: number | null;
  limit: string | null;
  motors: { rotorId: string; rpm: number; torqueNm: number; currentA: number; voltageV: number; overPeakCurrent: boolean }[];
}

describe('trim_flight: powertrain at the trimmed point (FLT-M5b)', () => {
  it('the hover point is the estimate_endurance hover point: same bus power, pack current, terminal voltage, motor current', () => {
    const doc = poweredQuad();
    const result = execute(doc, 'trim_flight', { scenario: 's' });
    const data = result.data as { powertrains: Powertrain[]; controls: { value: number }[]; warnings: string[] };
    const [powertrain] = data.powertrains;
    const endurance = execute(doc, 'estimate_endurance', { powertrain: 'pt', totalThrustN: MASS * G }).data as {
      bus: { electricalPowerW: number; currentA: number; terminalV: number };
      rotors: { rpm: number; motorCurrentA: number }[];
    };
    expect(powertrain?.limit).toBeNull();
    expect(powertrain?.busPowerW).toBeCloseTo(endurance.bus.electricalPowerW, 6);
    expect(powertrain?.packCurrentA).toBeCloseTo(endurance.bus.currentA, 8);
    expect(powertrain?.terminalV).toBeCloseTo(endurance.bus.terminalV, 8);
    expect(powertrain?.motors[0]?.rpm).toBeCloseTo(endurance.rotors[0]?.rpm ?? Number.NaN, 4);
    expect(powertrain?.motors[0]?.currentA).toBeCloseTo(endurance.rotors[0]?.motorCurrentA ?? Number.NaN, 6);
    expect(powertrain?.throttle).toBeGreaterThan(0);
    expect(powertrain?.throttle).toBeLessThan(1);
    expect(data.warnings.join(' ')).not.toContain('peak');
  });

  it('a 270 KV motor needs more than the 4S pack gives at the hover speed: FLT_TRIM_SATURATED (motor voltage), the operating point in the detail', () => {
    const doc = poweredQuad({}, { torqueConstantNmPerA: 60 / (2 * Math.PI * 270) });
    const result = execute(doc, 'trim_flight', { scenario: 's' });
    expect(result.error?.code).toBe('FLT_TRIM_SATURATED');
    expect(result.summary).toContain("powertrain 'pt'");
    expect(result.summary).toContain('throttle');
    const detail = result.error?.detail as { reason: string; powertrains: Powertrain[] } | undefined;
    expect(detail?.reason).toBe('powertrain');
    expect(detail?.powertrains[0]?.limit).toBe('motor_voltage');
    expect(detail?.powertrains[0]?.throttle).toBeGreaterThan(1);
    expectNoOp(result, doc);
    expect(execute(doc, 'linearize_flight', { scenario: 's' }).error?.code).toBe('FLT_TRIM_SATURATED');
  });

  it('a pack that cannot deliver the power (P > OCV² / 4R) and one that sags under its cut-off are FLT_TRIM_SATURATED', () => {
    const starved = execute(poweredQuad({ internalResistanceOhm: 5 }), 'trim_flight', { scenario: 's' });
    expect(starved.error?.code).toBe('FLT_TRIM_SATURATED');
    expect((starved.error?.detail as { powertrains: Powertrain[] }).powertrains[0]?.limit).toBe('pack_power');
    expect(starved.summary).toContain('cannot deliver');
    const sagging = execute(poweredQuad({ internalResistanceOhm: 0.3 }), 'trim_flight', { scenario: 's' });
    expect(sagging.error?.code).toBe('FLT_TRIM_SATURATED');
    expect((sagging.error?.detail as { powertrains: Powertrain[] }).powertrains[0]?.limit).toBe('cutoff_voltage');
    expect(sagging.summary).toContain('cut-off');
  });

  it('an empty pack (initialSoc 0): run_flight cuts off at t = 0, so the trim is FLT_TRIM_SATURATED (empty_pack, reason powertrain)', () => {
    const doc = poweredQuad({ initialSoc: 0 });
    const result = execute(doc, 'trim_flight', { scenario: 's' });
    expect(result.error?.code).toBe('FLT_TRIM_SATURATED');
    const detail = result.error?.detail as { reason: string; powertrains: Powertrain[] };
    expect(detail.reason).toBe('powertrain');
    expect(detail.powertrains[0]?.limit).toBe('empty_pack');
    expect(result.summary).toContain('is empty');
    expectNoOp(result, doc);
  });

  it('a control at its limit keeps reason controls in the detail', () => {
    const doc = poweredQuad();
    const weak = execute(doc, 'add_flight_controller', { body: 'frame', maxRpm: 3000, id: 'fc2' }).document;
    const scenario = execute(weak, 'define_flight_scenario', { body: 'frame', controller: 'fc2', id: 's2', durationS: 1 }).document;
    const result = execute(scenario, 'trim_flight', { scenario: 's2' });
    expect(result.error?.code).toBe('FLT_TRIM_SATURATED');
    expect((result.error?.detail as { reason: string }).reason).toBe('controls');
  });

  it('a motor over its peak current is a warning, not a refusal (run_flight counts it, it does not limit it)', () => {
    const result = execute(poweredQuad({}, { peakCurrentA: 1 }), 'trim_flight', { scenario: 's' });
    expect(result.rejected).not.toBe(true);
    const data = result.data as { powertrains: Powertrain[]; warnings: string[] };
    expect(data.powertrains[0]?.motors.every((motor) => motor.overPeakCurrent)).toBe(true);
    expect(data.warnings.filter((warning) => warning.includes('over its peak'))).toHaveLength(4);
  });

  it('a vehicle without powertrains reports none', () => {
    const doc = step(
      step(quadDrone(MASS), 'add_flight_controller', { body: 'frame', maxRpm: 7000, id: 'fc' }).doc,
      'define_flight_scenario',
      { body: 'frame', controller: 'fc', id: 's', durationS: 1 },
    ).doc;
    expect((execute(doc, 'trim_flight', { scenario: 's' }).data as { powertrains: Powertrain[] }).powertrains).toEqual([]);
  });
});
