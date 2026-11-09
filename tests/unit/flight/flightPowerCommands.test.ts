/**
 * add_battery / add_flight_powertrain / estimate_endurance (13 FLT M3, TR-FLT-06): records, defaults, refusals, purity, delete cascade, load
 * validation, and the analytic checks of the power chain (capacity / current, momentum-theory hover, sag against an independent integration).
 */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { flightDocument } from '@dynamics/flight/document';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { G, quadDrone, step } from './flightFixture';

const CT = 0.1158;
const CP = 0.0466;
const D = 0.254;
const RHO = 1.225;
const MASS = 1.115;
const ETA = 0.95;
/** 920 Kv: kt = 60 / (2π · Kv). */
const KT = 60 / (2 * Math.PI * 920);
const MOTOR = {
  nominalVoltageV: 14.8,
  terminalResistanceOhm: 0.1,
  torqueConstantNmPerA: KT,
  rotorInertiaKgM2: 1e-5,
  noLoadCurrentA: 0.5,
  speedConstantRpmPerV: 920,
  peakCurrentA: 30,
};
const FLAT = [
  [0, 3.7],
  [1, 3.7],
];

const battery = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'pack',
  cellsSeries: 4,
  capacityMah: 5600,
  internalResistanceOhm: 0.04,
  source: 'test pack',
  ...overrides,
});
const powertrain = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'pt',
  battery: 'pack',
  rotors: ['r1', 'r2', 'r3', 'r4'],
  datasheet: MOTOR,
  motorSource: 'test motor',
  escEfficiency: ETA,
  ...overrides,
});

/** The reference quad with a battery and a powertrain (inline 920 Kv motor). */
function powered(batteryOverrides: Record<string, unknown> = {}, powertrainOverrides: Record<string, unknown> = {}): CadDocument {
  const withBattery = step(quadDrone(MASS), 'add_battery', battery(batteryOverrides)).doc;
  return step(withBattery, 'add_flight_powertrain', powertrain(powertrainOverrides)).doc;
}

/** Electrical bus power of the four hover motors from first principles (independent of the implementation). */
function hoverBusPower(): { power: number; shaft: number; ideal: number; rpm: number; volts: number } {
  const thrust = (MASS * G) / 4;
  const n = Math.sqrt(thrust / (CT * RHO * D ** 4));
  const omega = 2 * Math.PI * n;
  const torque = (CP * RHO * n ** 2 * D ** 5) / (2 * Math.PI);
  const current = torque / KT + 0.5;
  const volts = KT * omega + 0.1 * current;
  const area = Math.PI * (D / 2) ** 2;
  return {
    power: (4 * volts * current) / ETA,
    shaft: 4 * torque * omega,
    ideal: 4 * (thrust ** 1.5 / Math.sqrt(2 * RHO * area)),
    rpm: n * 60,
    volts,
  };
}

interface EnduranceData {
  rotors: { rpm: number }[];
  hover: { shaftPowerW: number; idealPowerW: number; figureOfMerit: number };
  bus: { electricalPowerW: number; currentA: number; terminalV: number; throttle: number };
  endurance: { timeS: number; limitedBy: string; usedMah: number; energyWh: number; finalSoc: number };
  capacityOverCurrentS: number;
  unverified: boolean;
  defaulted: string[];
}

interface BatteryJson {
  id: string;
  ocv: number[][];
}
interface PowertrainJson {
  batteryId: string;
  rotorIds: string[];
  motor: { torqueConstantNmPerA: number };
}

/** The slice of a serialized flight document the load-validation test edits. */
interface FlightJson {
  flight: { batteries: { pack: BatteryJson } & Record<string, BatteryJson>; powertrains: { pt: PowertrainJson } };
}

const endurance = (doc: CadDocument, params: Record<string, unknown> = {}): EnduranceData => {
  const result = execute(doc, 'estimate_endurance', { powertrain: 'pt', totalThrustN: MASS * G, ...params });
  if (result.data === undefined) throw new Error(result.summary);
  return result.data as EnduranceData;
};
const rel = (value: number, expected: number): number => Math.abs(value - expected) / Math.abs(expected);

describe('add_battery', () => {
  it('stores a pack with its units, flags the default OCV curve and cut-off as unverified', () => {
    const doc = quadDrone();
    const result = execute(doc, 'add_battery', battery());
    expect(result.affected).toEqual(['pack']);
    const stored = result.document.flight?.batteries?.['pack'];
    expect(stored?.cellsSeries).toBe(4);
    expect(stored?.capacityMah).toBe(5600);
    expect(stored?.initialSoc).toBe(1);
    expect(stored?.cutoffVoltPerCell).toBe(3.3);
    expect(stored?.defaulted).toEqual(['ocv', 'cutoffVoltPerCell']);
    expect(result.summary).toContain('4S, 5600 mAh');
    expect(result.summary).toContain('16.80 V');
    expect(result.summary).toContain('defaulted: ocv, cutoffVoltPerCell');
  });

  it('keeps an explicit curve and cut-off, listing nothing as defaulted', () => {
    const result = execute(quadDrone(), 'add_battery', battery({ ocv: FLAT, cutoffVoltPerCell: 3, initialSoc: 0.5, id: undefined }));
    const stored = result.document.flight?.batteries?.[result.affected[0] ?? ''];
    expect(result.affected[0]).toMatch(/^battery-/);
    expect(stored?.defaulted).toEqual([]);
    expect(stored?.initialSoc).toBe(0.5);
    expect(stored?.ocv).toEqual(FLAT);
  });

  it('is pure', () => {
    const doc = quadDrone();
    expectPure(doc, () => execute(doc, 'add_battery', battery()));
  });

  it('refuses an empty source, a taken id and an unusable OCV curve without changing the document', () => {
    const doc = quadDrone();
    expectNoOp(execute(doc, 'add_battery', battery({ source: '  ' })), doc, 'source is empty');
    expectNoOp(execute(doc, 'add_battery', battery({ id: 'r1' })), doc, "id 'r1' is already used");
    const bad = (ocv: number[][], extra: Record<string, unknown> = {}): ReturnType<typeof execute> =>
      execute(doc, 'add_battery', battery({ ocv, ...extra }));
    for (const result of [
      bad([
        [0.1, 3.3],
        [1, 4.2],
      ]),
      bad([
        [0, 3.3],
        [0.5, 3.9],
        [0.5, 4],
        [1, 4.2],
      ]),
      bad([
        [0, 3.3],
        [0.5, 3.9],
        [1, 3.8],
      ]),
      bad(FLAT, { cutoffVoltPerCell: 3.7 }),
    ]) {
      expect(result.rejected).toBe(true);
      expect(result.error?.code).toBe('FLT_ECM_INVALID');
      expectNoOp(result, doc);
    }
  });
});

describe('add_flight_powertrain', () => {
  it('connects a battery to four rotors with an inline datasheet and flags the default ESC efficiency', () => {
    const doc = step(quadDrone(), 'add_battery', battery()).doc;
    const result = execute(doc, 'add_flight_powertrain', powertrain({ escEfficiency: undefined }));
    const stored = result.document.flight?.powertrains?.['pt'];
    expect(result.affected).toEqual(['pt']);
    expect(stored?.escEfficiency).toBe(0.95);
    expect(stored?.defaulted).toEqual(['escEfficiency']);
    expect(stored?.motor.torqueConstantNmPerA).toBeCloseTo(KT, 12);
    expect(stored?.rotorIds).toEqual(['r1', 'r2', 'r3', 'r4']);
    expect(result.summary).toContain('defaulted: escEfficiency');
  });

  it('takes the datasheet of a stored dc motor and marks an accepted inconsistent sheet', () => {
    let doc = step(quadDrone(), 'add_battery', battery()).doc;
    doc = step(doc, 'add_cylinder', { radius: 5, height: 5, position: [500, 0, 0], axis: [0, 0, 1] }).doc;
    const cylinder = doc.order[doc.order.length - 1] ?? '';
    doc = step(doc, 'add_rigid_body', { entityIds: [cylinder], id: 'spinner', massKg: 0.01 }).doc;
    doc = step(doc, 'add_body_joint', {
      kind: 'revolute',
      child: 'spinner',
      parent: 'ground',
      anchor: [500, 0, 0],
      axis: [0, 0, 1],
      id: 'j',
    }).doc;
    const add = (id: string, extra: Record<string, unknown>): CadDocument =>
      step(doc, 'add_motor', { joint: 'j', kind: 'dc', id, datasheet: { ...MOTOR, ...extra }, source: { name: 'bench', grade: 'B' } }).doc;
    const result = execute(add('m1', {}), 'add_flight_powertrain', { battery: 'pack', rotors: ['r1'], motor: 'm1', escEfficiency: 0.9 });
    expect(result.document.flight?.powertrains?.[result.affected[0] ?? '']?.motorSource).toBe('bench');
    const odd = step(doc, 'add_motor', {
      joint: 'j',
      kind: 'dc',
      id: 'm2',
      datasheet: { ...MOTOR, speedConstantRpmPerV: 500 },
      source: { name: 'bench', grade: 'B' },
      acceptInconsistent: 'catalogue typo',
    }).doc;
    const accepted = execute(odd, 'add_flight_powertrain', { battery: 'pack', rotors: ['r1'], motor: 'm2', escEfficiency: 0.9 });
    expect(accepted.document.flight?.powertrains?.[accepted.affected[0] ?? '']?.defaulted).toEqual(['motor.datasheetInconsistent']);
  });

  it('is pure', () => {
    const doc = step(quadDrone(), 'add_battery', battery()).doc;
    expectPure(doc, () => execute(doc, 'add_flight_powertrain', powertrain()));
  });

  it('refuses a missing battery or rotor, a double use, a bad motor and an inconsistent sheet', () => {
    const base = step(quadDrone(), 'add_battery', battery()).doc;
    expectNoOp(execute(base, 'add_flight_powertrain', powertrain({ battery: 'nope' })), base, "battery 'nope' not found");
    expectNoOp(execute(base, 'add_flight_powertrain', powertrain({ rotors: ['r1', 'zz'] })), base, "rotor 'zz' not found");
    expectNoOp(execute(base, 'add_flight_powertrain', powertrain({ rotors: ['r1', 'r1'] })), base, 'listed twice');
    expectNoOp(execute(base, 'add_flight_powertrain', powertrain({ id: 'r2' })), base, "id 'r2' is already used");
    expectNoOp(execute(base, 'add_flight_powertrain', powertrain({ datasheet: undefined })), base, 'exactly one of');
    expectNoOp(execute(base, 'add_flight_powertrain', powertrain({ motor: 'm' })), base, 'exactly one of');
    expectNoOp(execute(base, 'add_flight_powertrain', powertrain({ motor: 'm', datasheet: undefined })), base, "motor 'm' not found");
    expectNoOp(execute(base, 'add_flight_powertrain', powertrain({ motorSource: undefined })), base, 'needs `motorSource`');
    const inconsistent = execute(base, 'add_flight_powertrain', powertrain({ datasheet: { ...MOTOR, speedConstantRpmPerV: 500 } }));
    expect(inconsistent.error?.code).toBe('DRV_MOTOR_DATA_INCONSISTENT');
    expectNoOp(inconsistent, base);
    const once = step(base, 'add_flight_powertrain', powertrain({ rotors: ['r1', 'r2'] })).doc;
    expectNoOp(execute(once, 'add_flight_powertrain', powertrain({ id: 'other' })), once, "battery 'pack' already feeds powertrain 'pt'");
    const second = step(once, 'add_battery', battery({ id: 'pack2' })).doc;
    expectNoOp(
      execute(second, 'add_flight_powertrain', powertrain({ id: 'other', battery: 'pack2', rotors: ['r2', 'r3'] })),
      second,
      "rotor 'r2' is already on a powertrain",
    );
  });

  it('refuses a non-dc or geared stored motor', () => {
    let doc = step(quadDrone(), 'add_battery', battery()).doc;
    doc = step(doc, 'add_cylinder', { radius: 5, height: 5, position: [500, 0, 0], axis: [0, 0, 1] }).doc;
    const cylinder = doc.order[doc.order.length - 1] ?? '';
    doc = step(doc, 'add_rigid_body', { entityIds: [cylinder], id: 'spinner', massKg: 0.01 }).doc;
    doc = step(doc, 'add_body_joint', {
      kind: 'revolute',
      child: 'spinner',
      parent: 'ground',
      anchor: [500, 0, 0],
      axis: [0, 0, 1],
      id: 'j',
    }).doc;
    const source = { name: 'bench', grade: 'B' };
    const curve = step(doc, 'add_motor', { joint: 'j', kind: 'torque_curve', id: 'mc', torque: 1 }).doc;
    expectNoOp(execute(curve, 'add_flight_powertrain', { battery: 'pack', rotors: ['r1'], motor: 'mc' }), curve, 'torque_curve motor');
    const geared = step(doc, 'add_motor', {
      joint: 'j',
      kind: 'dc',
      id: 'mg',
      datasheet: MOTOR,
      gearhead: { ratio: 5, efficiency: 0.9 },
      source,
    }).doc;
    expectNoOp(execute(geared, 'add_flight_powertrain', { battery: 'pack', rotors: ['r1'], motor: 'mg' }), geared, 'has a gearhead');
  });
});

describe('powertrain records in the document', () => {
  it('delete_dynamics_item on a battery, a rotor or a powertrain takes the powertrain with it', () => {
    const doc = powered();
    expect(execute(doc, 'delete_dynamics_item', { id: 'pack' }).document.flight?.powertrains).toEqual({});
    const rotorGone = execute(doc, 'delete_dynamics_item', { id: 'r3' }).document.flight;
    expect(rotorGone?.powertrains).toEqual({});
    expect(rotorGone?.batteries?.['pack']).toBeDefined();
    const trainGone = execute(doc, 'delete_dynamics_item', { id: 'pt' }).document.flight;
    expect(trainGone?.powertrains).toEqual({});
    expect(trainGone?.batteries?.['pack']).toBeDefined();
  });

  it('load validation names a dangling battery, a bad curve, a shared rotor and a taken id', () => {
    const doc = powered();
    const clone = JSON.parse(JSON.stringify(doc)) as FlightJson;
    expect(flightDocument.validate(clone as unknown as Record<string, unknown>)).toEqual([]);
    const errors = (mutate: (copy: FlightJson) => void): string[] => {
      const copy = JSON.parse(JSON.stringify(doc)) as FlightJson;
      mutate(copy);
      return flightDocument.validate(copy as unknown as Record<string, unknown>);
    };
    expect(errors((c) => (c.flight.powertrains.pt.batteryId = 'ghost')).join('|')).toContain('is not a battery');
    expect(
      errors(
        (c) =>
          (c.flight.batteries.pack.ocv = [
            [0, 4],
            [1, 3],
          ]),
      ).join('|'),
    ).toContain('must not decrease');
    expect(errors((c) => (c.flight.powertrains.pt.rotorIds = ['r1', 'r1'])).join('|')).toContain('listed twice');
    expect(errors((c) => (c.flight.powertrains.pt.rotorIds = ['r1', 'ghost'])).join('|')).toContain('is not a rotor');
    expect(errors((c) => (c.flight.batteries.r1 = { ...c.flight.batteries.pack, id: 'r1' })).join('|')).toContain('also a dynamics record');
    expect(errors((c) => (c.flight.batteries.pack.id = 'other')).join('|')).toContain('id must equal its key');
    expect(errors((c) => (c.flight.powertrains.pt.motor.torqueConstantNmPerA = -1)).length).toBeGreaterThan(0);
    expect(errors((c) => Object.defineProperty(c.flight.batteries, '__proto__', { value: {}, enumerable: true })).join('|')).toContain(
      'reserved key',
    );
  });
});

describe('estimate_endurance', () => {
  it('hovers the 1.115 kg quad at 4082.5 rpm with the momentum-theory figure of merit and the electrical power of the DC + ESC chain', () => {
    const data = endurance(powered());
    const expected = hoverBusPower();
    expect(rel(data['rotors'][0]!.rpm, 4082.5)).toBeLessThan(1e-3);
    expect(rel(data['hover'].shaftPowerW, 76.05)).toBeLessThan(1e-3);
    expect(rel(data['hover'].idealPowerW, expected.ideal)).toBeLessThan(1e-9);
    expect(rel(data['hover'].figureOfMerit, CT ** 1.5 / (CP * Math.sqrt(Math.PI / 2)))).toBeLessThan(1e-9);
    expect(rel(data['bus'].electricalPowerW, expected.power)).toBeLessThan(1e-9);
    expect(rel(data['bus'].throttle, expected.volts / data['bus'].terminalV)).toBeLessThan(1e-9);
    // V · I = P and V = OCV - R · I at the pack terminals
    expect(rel(data['bus'].terminalV * data['bus'].currentA, expected.power)).toBeLessThan(1e-9);
  });

  it('constant-current endurance is capacity / current: an ideal flat pack (no resistance) runs exactly 5.6 Ah / I', () => {
    const doc = powered({ ocv: FLAT, cutoffVoltPerCell: 3, internalResistanceOhm: 0 });
    const data = endurance(doc);
    const current = hoverBusPower().power / (4 * 3.7);
    expect(rel(data['bus'].currentA, current)).toBeLessThan(1e-9);
    expect(data['endurance'].limitedBy).toBe('empty');
    expect(rel(data['endurance'].timeS, (5.6 * 3600) / current)).toBeLessThan(2e-3);
    expect(rel(data['capacityOverCurrentS'], (5.6 * 3600) / current)).toBeLessThan(1e-9);
    expect(rel(data['endurance'].usedMah, 5600)).toBeLessThan(2e-3);
    expect(rel(data['endurance'].energyWh, 5.6 * 14.8)).toBeLessThan(2e-3);
  });

  it('a pack with resistance and a sloping OCV curve cuts off earlier than capacity / current and matches an independent 1 s integration', () => {
    const doc = powered({ internalResistanceOhm: 0.05, cutoffVoltPerCell: 3.4 });
    const data = endurance(doc);
    expect(data['endurance'].limitedBy).toBe('cutoff_voltage');
    expect(data['endurance'].timeS).toBeLessThan(data['capacityOverCurrentS']);
    const ocv = (soc: number): number => {
      const table = doc.flight?.batteries?.['pack']?.ocv ?? [];
      const hi = table.findIndex((point) => point[0] >= soc);
      const a = table[Math.max(hi - 1, 0)] ?? [0, 0];
      const b = table[hi] ?? a;
      return 4 * (b[0] === a[0] ? a[1] : a[1] + ((soc - a[0]) / (b[0] - a[0])) * (b[1] - a[1]));
    };
    const power = hoverBusPower().power;
    let soc = 1;
    let t = 0;
    for (;;) {
      const v0 = ocv(soc);
      const current = (v0 - Math.sqrt(v0 * v0 - 4 * 0.05 * power)) / (2 * 0.05);
      if (v0 - 0.05 * current < 4 * 3.4) break;
      soc -= (current * 1) / (5600 * 3.6);
      t += 1;
    }
    expect(rel(data['endurance'].timeS, t)).toBeLessThan(5e-3);
    expect(data['endurance'].finalSoc).toBeGreaterThan(0);
    expect(data['endurance'].finalSoc).toBeLessThan(0.5);
  });

  it('flags a defaulted battery as unverified, takes rpm or the rotors own speed, and starts from a given SoC', () => {
    const doc = powered();
    const data = endurance(doc, { rpm: 3000, totalThrustN: undefined });
    expect(data['unverified']).toBe(true);
    expect(data['defaulted']).toContain('battery.pack.ocv');
    expect(data['rotors'].every((rotor: { rpm: number }) => rotor.rpm === 3000)).toBe(true);
    const own = endurance(doc, { totalThrustN: undefined });
    expect(own['endurance'].limitedBy).toBe('no_load');
    expect(own['endurance'].timeS).toBeNull();
    const half = endurance(doc, { initialSoc: 0.6 });
    expect(half['endurance'].timeS).toBeLessThan(endurance(doc)['endurance'].timeS);
  });

  it('reports a pack that cannot spin the rotors or deliver the power', () => {
    const oneCell = powered({ cellsSeries: 1, ocv: FLAT, cutoffVoltPerCell: 3, internalResistanceOhm: 0 });
    const limited = endurance(oneCell);
    expect(limited['endurance'].limitedBy).toBe('motor_voltage');
    expect(limited['endurance'].timeS).toBe(0);
    const weak = powered({ internalResistanceOhm: 5 });
    expect(endurance(weak)['endurance'].limitedBy).toBe('pack_power');
  });

  it('is read-only and refuses an unknown powertrain, both speed inputs, and a rotor without static thrust', () => {
    const doc = powered();
    expectPure(doc, () => execute(doc, 'estimate_endurance', { powertrain: 'pt', totalThrustN: 10 }));
    expectNoOp(execute(doc, 'estimate_endurance', { powertrain: 'zz' }), doc, "powertrain 'zz' not found");
    expectNoOp(execute(doc, 'estimate_endurance', { powertrain: 'pt', rpm: 100, totalThrustN: 10 }), doc, 'not both');
    let dead = step(quadDrone(), 'add_battery', battery()).doc;
    dead = step(dead, 'add_rotor', {
      body: 'frame',
      hub: [0, 0, 0],
      axis: [0, 0, 1],
      spin: 'ccw',
      rpm: 1000,
      diameter: 0.2,
      thrustCoefficient: 0,
      powerCoefficient: 0.01,
      source: 't',
      id: 'rz',
    }).doc;
    dead = step(dead, 'add_flight_powertrain', powertrain({ rotors: ['rz'] })).doc;
    expectNoOp(execute(dead, 'estimate_endurance', { powertrain: 'pt', totalThrustN: 5 }), dead, 'no static thrust');
  });
});
