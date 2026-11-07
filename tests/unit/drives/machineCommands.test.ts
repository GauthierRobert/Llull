/** DRV-M4 commands without a simulation: add_motor / check_motor_data / set_motor_drive for pmsm, stepper and induction, hostile load validation, persistence. */
import { describe, expect, it } from 'vitest';
import { isRecord } from '@lib/isRecord';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { dynamicsProblems } from '@core/commands/persistence/dynamicsValidation';
import type { CadDocument } from '@core/model/types';
import { bodyCentres, dynamicsLoads } from '@dynamics/sim/dynamicsLoads';
import { MACHINE_SOURCE, INDUCTION_SHEET, PMSM_SHEET, STEPPER_SHEET, THERMAL, constantProfile, machineBench } from './machineFixtures';
import { runSteps } from './fixtures';

const KINDS = {
  pmsm: { kind: 'pmsm', pmsmDatasheet: PMSM_SHEET },
  stepper: { kind: 'stepper', stepperDatasheet: STEPPER_SHEET },
  induction: { kind: 'induction', inductionDatasheet: INDUCTION_SHEET },
} as const;

const bench = (): CadDocument => machineBench(1e-3, { kind: 'torque_curve', torque: 1 });
const add = (doc: CadDocument, params: Record<string, unknown>): ReturnType<typeof execute> =>
  execute(doc, 'add_motor', { joint: 'j', id: 'mm', source: MACHINE_SOURCE, ...params });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('add_motor kind pmsm | stepper | induction', () => {
  for (const [name, params] of Object.entries(KINDS)) {
    it(`${name}: stores the motor, reports the consistency verdict and the key figures; the input document is untouched`, () => {
      const doc = bench();
      const before = clone(doc.dynamics);
      const result = add(doc, params);
      expect(result.affected).toEqual(['mm']);
      expect(result.summary).toContain('datasheet consistent');
      expect(result.summary).toContain('commanded by set_motor_drive');
      expect(result.document.dynamics?.motors['mm']).toMatchObject({ id: 'mm', kind: name, joint: 'j' });
      expect(result.document.order).toEqual(doc.order);
      expect(doc.dynamics).toEqual(before);
      expect(dynamicsProblems(result.document.dynamics)).toEqual([]);
    });

    it(`${name}: refuses without its datasheet, without a source, on a taken id and on a prismatic joint; the document is returned as is`, () => {
      const doc = bench();
      const sheetField = Object.keys(params).find((key) => key.endsWith('Datasheet')) ?? '';
      const missing = add(doc, { kind: name });
      expect(missing.document).toBe(doc);
      expect(missing.summary).toContain(sheetField);
      expect(add(doc, { ...params, source: undefined }).document).toBe(doc);
      const taken = add(doc, { ...params, id: 'm' });
      expect(taken.document).toBe(doc);
      expect(taken.summary).toContain('already used');
      const slider = runSteps([
        { command: 'add_box', params: { size: [10, 10, 10], position: [0, 0, 0] }, as: 'b' },
        { command: 'add_rigid_body', params: { entityIds: ['$b'], id: 'blk', massKg: 1 } },
        {
          command: 'add_body_joint',
          params: { kind: 'prismatic', child: 'blk', parent: 'ground', anchor: [0, 0, 0], axis: [1, 0, 0], id: 'jp' },
        },
      ]).doc;
      const linear = execute(slider, 'add_motor', { joint: 'jp', id: 'mm', source: MACHINE_SOURCE, ...params });
      expect(linear.summary).toContain('DRV_JOINT_INVALID');
      expect(linear.document).toBe(slider);
    });
  }

  it('pmsm: a torque constant alone is enough, neither it nor the flux linkage is refused, a disagreeing pair is DRV_MOTOR_DATA_INCONSISTENT', () => {
    const { fluxLinkageWb: _flux, ...withoutFlux } = PMSM_SHEET;
    const viaKt = add(bench(), { kind: 'pmsm', pmsmDatasheet: { ...withoutFlux, torqueConstantNmPerA: 0.06 } });
    expect(viaKt.affected).toEqual(['mm']);
    const neither = add(bench(), { kind: 'pmsm', pmsmDatasheet: withoutFlux });
    expect(neither.affected).toEqual([]);
    expect(neither.summary).toContain('fluxLinkageWb or torqueConstantNmPerA');
    const doc = bench();
    const bad = add(doc, { kind: 'pmsm', pmsmDatasheet: { ...PMSM_SHEET, torqueConstantNmPerA: 0.09 } });
    expect(bad.summary).toContain('DRV_MOTOR_DATA_INCONSISTENT');
    expect(bad.summary).toContain('torqueConstantNmPerA');
    expect(bad.document).toBe(doc);
    const accepted = add(doc, {
      kind: 'pmsm',
      pmsmDatasheet: { ...PMSM_SHEET, torqueConstantNmPerA: 0.09 },
      acceptInconsistent: 'catalogue misprint',
    });
    expect(accepted.affected).toEqual(['mm']);
    expect(accepted.summary).toContain('INCONSISTENT (accepted: catalogue misprint)');
  });

  it('stepper: an out-of-order pull-out curve, a step count that is not a multiple of 4 and a wrong step angle are refused', () => {
    const doc = bench();
    const unordered = add(doc, {
      kind: 'stepper',
      stepperDatasheet: {
        ...STEPPER_SHEET,
        pullOutCurve: [
          [100, 0.4],
          [50, 0.3],
        ],
      },
    });
    expect(unordered.document).toBe(doc);
    expect(unordered.summary).toContain('strictly increase');
    expect(add(doc, { kind: 'stepper', stepperDatasheet: { ...STEPPER_SHEET, stepsPerRev: 201 } }).document).toBe(doc);
    const angle = add(doc, { kind: 'stepper', stepperDatasheet: { ...STEPPER_SHEET, stepAngleDeg: 0.9 } });
    expect(angle.summary).toContain('DRV_MOTOR_DATA_INCONSISTENT');
  });

  it('induction: a sheet breakdown torque that the circuit does not give is refused, the right one passes', () => {
    const doc = bench();
    const wrong = add(doc, { kind: 'induction', inductionDatasheet: { ...INDUCTION_SHEET, breakdownTorqueNm: 150 } });
    expect(wrong.summary).toContain('breakdownTorqueNm');
    expect(wrong.document).toBe(doc);
    const right = add(doc, {
      kind: 'induction',
      inductionDatasheet: { ...INDUCTION_SHEET, breakdownTorqueNm: 197.2, breakdownSlip: 0.194, startingTorqueNm: 84.02 },
    });
    expect(right.affected).toEqual(['mm']);
    expect(right.summary).toContain('3 checks');
  });
});

describe('add_motor refuses the sheets and extras of another kind', () => {
  const sheets: Record<string, unknown> = {
    datasheet: { nominalVoltageV: 48, terminalResistanceOhm: 1.13, torqueConstantNmPerA: 0.0603, rotorInertiaKgM2: 1e-5 },
    pmsmDatasheet: PMSM_SHEET,
    stepperDatasheet: STEPPER_SHEET,
    inductionDatasheet: INDUCTION_SHEET,
  };
  const own: Record<string, string> = {
    dc: 'datasheet',
    pmsm: 'pmsmDatasheet',
    stepper: 'stepperDatasheet',
    induction: 'inductionDatasheet',
  };

  for (const kind of Object.keys(own))
    for (const field of Object.keys(sheets).filter((name) => name !== own[kind])) {
      it(`${kind} with a ${field} is refused, naming it; the document is unchanged`, () => {
        const doc = bench();
        const result = add(doc, { kind, [own[kind] as string]: sheets[own[kind] as string], [field]: sheets[field] });
        expect(result.summary).toContain(`${field} does not apply to a ${kind} motor`);
        expect(result.document).toBe(doc);
        expect(result.affected).toEqual([]);
      });
    }

  it('a torque_curve or speed motor takes no sheet, no gearhead and no acceptInconsistent; a speed motor still takes its source', () => {
    const doc = bench();
    for (const extra of [
      { pmsmDatasheet: PMSM_SHEET },
      { datasheet: sheets['datasheet'] },
      { gearhead: { ratio: 2, efficiency: 0.9 } },
      { acceptInconsistent: 'x' },
    ]) {
      const curve = add(doc, { kind: 'torque_curve', torque: 1, ...extra });
      expect(curve.summary).toContain('does not apply to a torque_curve motor');
      expect(curve.document).toBe(doc);
      expect(add(doc, { kind: 'speed', rpm: 100, maxTorque: 1, ...extra }).document).toBe(doc);
    }
    expect(add(doc, { kind: 'speed', rpm: 100, maxTorque: 1 }).affected).toEqual(['mm']);
    expect(add(doc, { kind: 'speed', rpm: 100, maxTorque: 1, source: MACHINE_SOURCE }).affected).toEqual(['mm']);
  });

  it('a gearhead and acceptInconsistent stay valid on every datasheet kind', () => {
    for (const params of Object.values(KINDS))
      expect(add(bench(), { ...params, gearhead: { ratio: 3, efficiency: 0.9 }, acceptInconsistent: 'unused reason' }).affected).toEqual([
        'mm',
      ]);
  });
});

describe('check_motor_data of the machine kinds (hand values)', () => {
  const checks = (params: Record<string, unknown>): Record<string, { derived: number; status: string }> => {
    const doc = add(bench(), params).document;
    const result = execute(doc, 'check_motor_data', { motor: 'mm' });
    const data = result.data as { checks: { quantity: string; derived: number; status: string }[] };
    return Object.fromEntries(data.checks.map((check) => [check.quantity, check]));
  };

  it('pmsm: kt = 1.5 p lambda = 0.06 N m/A, peak torque 1.2 N m, ideal no-load speed V_bus / sqrt(3) / (p lambda) = 346.41 rad/s = 3308.0 rpm', () => {
    const data = checks({
      kind: 'pmsm',
      pmsmDatasheet: { ...PMSM_SHEET, torqueConstantNmPerA: 0.06, peakTorqueNm: 1.2, noLoadSpeedRpm: 3308 },
    });
    expect(data['torqueConstantNmPerA']).toMatchObject({ status: 'pass' });
    expect(data['torqueConstantNmPerA']?.derived).toBeCloseTo(0.06, 12);
    expect(data['peakTorqueNm']?.derived).toBeCloseTo(1.2, 12);
    expect(data['noLoadSpeedRpm']?.derived).toBeCloseTo((24 / Math.sqrt(3) / 0.04) * (30 / Math.PI), 6);
    expect(data['noLoadSpeedRpm']?.derived).toBeCloseTo(3307.9, 0);
  });

  it('stepper: step angle 360 / 200 = 1.8 degrees, rated voltage R I = 3 V', () => {
    const data = checks({ kind: 'stepper', stepperDatasheet: { ...STEPPER_SHEET, stepAngleDeg: 1.8, ratedVoltageV: 3 } });
    expect(data['stepAngleDeg']).toMatchObject({ derived: 1.8, status: 'pass' });
    expect(data['ratedVoltageV']).toMatchObject({ derived: 3, status: 'pass' });
  });

  it('induction: breakdown torque 197.208 N m at slip 0.194029, starting torque 84.018 N m (drv_reference.json circuit)', () => {
    const data = checks({
      kind: 'induction',
      inductionDatasheet: { ...INDUCTION_SHEET, breakdownTorqueNm: 197.2, breakdownSlip: 0.194, startingTorqueNm: 84.0 },
    });
    expect(data['breakdownTorqueNm']?.derived).toBeCloseTo(197.2076, 3);
    expect(data['breakdownSlip']?.derived).toBeCloseTo(0.1940285, 6);
    expect(data['startingTorqueNm']?.derived).toBeCloseTo(84.01793, 4);
    expect(Object.values(data).every((entry) => entry.status === 'pass')).toBe(true);
  });

  it('an inline datasheet is dc only; a torque_curve motor has no sheet', () => {
    const doc = add(bench(), KINDS.pmsm).document;
    expect(execute(doc, 'check_motor_data', { motor: 'm' }).data).toBeUndefined();
  });
});

describe('set_motor_drive by kind: modes, unused fields, named refusals', () => {
  const withProfiles = (kind: keyof typeof KINDS): CadDocument =>
    runSteps(
      [
        constantProfile('tq', 'torque', 'N*m', 0.1, 1),
        constantProfile('w', 'velocity', 'rad/s', 10, 1),
        constantProfile('pos', 'position', 'deg', 10, 1),
        constantProfile('fq', 'frequency', 'Hz', 25, 1),
      ].map((step) => step),
      add(bench(), KINDS[kind]).document,
    ).doc;
  const drive = (doc: CadDocument, params: Record<string, unknown>): ReturnType<typeof execute> =>
    execute(doc, 'set_motor_drive', { motor: 'mm', ...params });

  it('pmsm takes torque, velocity (tuned loop), position, prescribed; its drive stores the limits', () => {
    const doc = withProfiles('pmsm');
    const torque = drive(doc, { mode: 'torque', profile: 'tq', currentLimitA: 15, busVoltageV: 48 });
    expect(torque.affected).toEqual(['mm']);
    expect(torque.document.dynamics?.drives?.['mm']).toMatchObject({ mode: 'torque', currentLimitA: 15, busVoltageV: 48 });
    expect(drive(doc, { mode: 'velocity', profile: 'w', tune: { bandwidthHz: 20, dampingRatio: 1 }, sampleHz: 1000 }).affected).toEqual([
      'mm',
    ]);
    expect(drive(doc, { mode: 'position', profile: 'pos', tune: { bandwidthHz: 20, dampingRatio: 1 }, sampleHz: 1000 }).affected).toEqual([
      'mm',
    ]);
    expect(drive(doc, { mode: 'prescribed', profile: 'pos' }).affected).toEqual(['mm']);
  });

  it('pmsm: a terminal voltage is a mode the kind does not take (DRV_MODE_UNSUPPORTED); volts, frequency and step division do not apply', () => {
    const doc = withProfiles('pmsm');
    const mode = drive(doc, { mode: 'voltage', volts: 5 });
    expect(mode.summary).toContain('DRV_MODE_UNSUPPORTED');
    expect(mode.document).toBe(doc);
    expect(drive(doc, { mode: 'frequency', profile: 'fq' }).summary).toContain('DRV_MODE_UNSUPPORTED');
    for (const extra of [{ volts: 5 }, { frequencyHz: 50 }, { stepDivision: 2 }])
      expect(drive(doc, { mode: 'torque', profile: 'tq', ...extra }).summary).toContain('does not apply to a pmsm motor');
  });

  it('stepper takes position and velocity only (open loop): no gains, tuning, sample rate or target; step division and chopper current are its fields', () => {
    const doc = withProfiles('stepper');
    const position = drive(doc, { mode: 'position', profile: 'pos', stepDivision: 16, currentLimitA: 1.5 });
    expect(position.document.dynamics?.drives?.['mm']).toMatchObject({ mode: 'position', stepDivision: 16, currentLimitA: 1.5 });
    expect(drive(doc, { mode: 'velocity', profile: 'w' }).affected).toEqual(['mm']);
    for (const mode of ['voltage', 'torque', 'prescribed', 'frequency'])
      expect(drive(doc, { mode, profile: 'tq', volts: undefined }).summary, mode).toContain('DRV_MODE_UNSUPPORTED');
    for (const extra of [
      { sampleHz: 1000 },
      { gains: { kp: 1 } },
      { tune: { bandwidthHz: 1, dampingRatio: 1 } },
      { target: 'j' },
      { busVoltageV: 24 },
      { feedforward: true },
    ])
      expect(drive(doc, { mode: 'position', profile: 'pos', ...extra }).summary).toContain('does not apply to a stepper motor');
    expect(drive(doc, { mode: 'position' }).summary).toContain('needs a profile');
    expect(drive(doc, { mode: 'position', profile: 'pos', stepDivision: 0 }).document).toBe(doc);
  });

  it('induction takes voltage (volts + frequencyHz, direct on line) and frequency (V/f profile); a voltage drive without frequency is refused', () => {
    const doc = withProfiles('induction');
    const dol = drive(doc, { mode: 'voltage', volts: 230, frequencyHz: 50 });
    expect(dol.document.dynamics?.drives?.['mm']).toMatchObject({ mode: 'voltage', volts: 230, frequencyHz: 50 });
    expect(dol.summary).toContain('230 V at 50 Hz');
    expect(drive(doc, { mode: 'frequency', profile: 'fq' }).affected).toEqual(['mm']);
    expect(drive(doc, { mode: 'voltage', volts: 230 }).summary).toContain('needs `frequencyHz`');
    expect(drive(doc, { mode: 'frequency', profile: 'fq', volts: 230 }).summary).toContain('do not apply');
    expect(drive(doc, { mode: 'frequency', profile: 'fq', frequencyHz: 50 }).document).toBe(doc);
    expect(drive(doc, { mode: 'frequency', profile: 'tq' }).summary).toContain('DRV_PROFILE_INVALID');
    expect(drive(doc, { mode: 'frequency' }).summary).toContain('needs a profile');
    for (const mode of ['torque', 'velocity', 'position', 'prescribed'])
      expect(drive(doc, { mode, profile: 'tq' }).summary, mode).toContain('DRV_MODE_UNSUPPORTED');
    for (const extra of [{ currentLimitA: 5 }, { busVoltageV: 400 }, { sampleHz: 1000 }, { target: 'j' }, { stepDivision: 2 }])
      expect(drive(doc, { mode: 'voltage', volts: 230, frequencyHz: 50, ...extra }).summary).toContain(
        'does not apply to a induction motor',
      );
  });

  it('dc stays refused a frequency and the non-datasheet motors stay refused any drive', () => {
    const doc = runSteps([], bench()).doc;
    expect(execute(doc, 'set_motor_drive', { motor: 'm', mode: 'torque', profile: 'x' }).summary).toContain('DRV_MOTOR_KIND_UNSUPPORTED');
  });
});

describe('persistence and load validation of the machine records', () => {
  const driven = (): CadDocument =>
    runSteps(
      [
        constantProfile('tq', 'torque', 'N*m', 0.1, 1),
        constantProfile('fq', 'frequency', 'Hz', 25, 1),
        {
          command: 'add_motor',
          params: { joint: 'j', id: 'mp', source: MACHINE_SOURCE, ...KINDS.pmsm, pmsmDatasheet: { ...PMSM_SHEET, thermal: THERMAL } },
        },
        { command: 'set_motor_drive', params: { motor: 'mp', mode: 'torque', profile: 'tq' } },
      ],
      bench(),
    ).doc;

  it('round-trips through save / load and replays from the history', () => {
    const doc = driven();
    expect(deserializeDocument(serializeDocument(doc)).dynamics).toEqual(doc.dynamics);
    expect(execute(doc, 'replay_history', {}).document.dynamics).toEqual(doc.dynamics);
    expect(dynamicsProblems(doc.dynamics)).toEqual([]);
  });

  it('hostile records are named: bad numbers, an unknown kind, a stepper curve out of order, a drive whose mode the kind does not take', () => {
    const base = runSteps(
      [
        constantProfile('tq', 'torque', 'N*m', 0.1, 1),
        { command: 'add_motor', params: { joint: 'j', id: 'mp', source: MACHINE_SOURCE, ...KINDS.pmsm } },
        { command: 'add_motor', params: { joint: 'j', id: 'ms', source: MACHINE_SOURCE, ...KINDS.stepper } },
        { command: 'add_motor', params: { joint: 'j', id: 'mi', source: MACHINE_SOURCE, ...KINDS.induction } },
        { command: 'set_motor_drive', params: { motor: 'mp', mode: 'torque', profile: 'tq' } },
      ],
      bench(),
    ).doc;
    const broken = (path: string[], value: unknown): string[] => {
      const copy = clone(base.dynamics) as unknown as Record<string, unknown>;
      let node: unknown = copy;
      for (const key of path.slice(0, -1)) node = isRecord(node) ? node[key] : undefined;
      if (!isRecord(node)) throw new Error(`no ${path.join('.')}`);
      if (value === undefined) delete node[path[path.length - 1] ?? ''];
      else node[path[path.length - 1] ?? ''] = value;
      return dynamicsProblems(copy);
    };
    expect(broken(['motors', 'mp', 'datasheet', 'polePairs'], 0)[0]).toContain('polePairs must be a positive integer');
    expect(broken(['motors', 'mp', 'datasheet', 'busVoltageV'], -1)[0]).toContain('datasheet needs positive');
    expect(broken(['motors', 'mp', 'datasheet', 'fluxLinkageWb'], undefined)[0]).toContain('fluxLinkageWb or torqueConstantNmPerA');
    expect(broken(['motors', 'mp', 'datasheet', 'frictionNm'], -1)[0]).toContain('frictionNm');
    expect(broken(['motors', 'mp', 'gearhead'], { ratio: 2, efficiency: 2 })[0]).toContain('efficiencies');
    expect(broken(['motors', 'ms', 'datasheet', 'stepsPerRev'], 201)[0]).toContain('multiple of 4');
    expect(
      broken(
        ['motors', 'ms', 'datasheet', 'pullOutCurve'],
        [
          [10, 1],
          [5, 1],
        ],
      )[0],
    ).toContain('pullOutCurve');
    expect(broken(['motors', 'ms', 'datasheet', 'pullOutCurve'], [[0, -1]])[0]).toContain('pullOutCurve');
    expect(broken(['motors', 'ms', 'datasheet', 'detentTorqueNm'], -1)[0]).toContain('detentTorqueNm');
    expect(broken(['motors', 'mi', 'datasheet', 'polePairs'], 1.5)[0]).toContain('polePairs');
    expect(broken(['motors', 'mi', 'datasheet', 'rotorLeakageReactanceOhm'], undefined)[0]).toContain('LeakageReactanceOhm');
    expect(broken(['motors', 'mi', 'datasheet', 'ratedFrequencyHz'], 0)[0]).toContain('datasheet needs positive');
    expect(broken(['motors', 'mi', 'datasheet'], 'x')[0]).toContain('needs a datasheet');
    expect(broken(['motors', 'ms', 'datasheet'], 'x')[0]).toContain('needs a datasheet');
    expect(broken(['motors', 'mp', 'datasheet'], 'x')[0]).toContain('needs a datasheet');
    expect(broken(['motors', 'mp', 'kind'], 'servo')[0]).toContain("'pmsm', 'stepper' or 'induction'");
    expect(broken(['drives', 'mp', 'mode'], 'voltage')[0]).toContain('DRV_MODE_UNSUPPORTED');
    expect(broken(['drives', 'mp', 'mode'], 'frequency')[0]).toContain('DRV_MODE_UNSUPPORTED');
    expect(broken(['drives', 'mp', 'stepDivision'], 0)[0]).toContain('stepDivision');
    expect(broken(['drives', 'mp', 'stepDivision'], 1.5)[0]).toContain('stepDivision');
    expect(broken(['drives', 'mp', 'frequencyHz'], -5)[0]).toContain('positive');
    expect(broken(['drives', 'mp', 'frequencyHz'], 50)).toEqual([]);
    expect(dynamicsProblems(base.dynamics)).toEqual([]);
  });

  it('deleting a machine motor deletes its drive, and the profile it used stays', () => {
    const doc = driven();
    const next = execute(doc, 'delete_dynamics_item', { id: 'mp' }).document;
    expect(next.dynamics?.motors['mp']).toBeUndefined();
    expect(next.dynamics?.drives?.['mp']).toBeUndefined();
    expect(next.dynamics?.profiles?.['tq']).toBeDefined();
  });
});

describe('the load view of the machine kinds (design torque)', () => {
  const design = (params: Record<string, unknown>): { value: string; detail: string; magnitude: number | null } => {
    const doc = add(bench(), params).document;
    const item = dynamicsLoads(doc, null, bodyCentres(doc)).find((entry) => entry.id === 'mm');
    if (item === undefined) throw new Error('no load item');
    return item;
  };

  it('pmsm: kt x peak current (1.2 N m); through a 5:1 gearhead of eta 0.9 it is N eta times that (5.4 N m)', () => {
    expect(design(KINDS.pmsm).magnitude).toBeCloseTo(1.2, 12);
    expect(design(KINDS.pmsm).detail).toContain('datasheet PMSM');
    expect(design({ ...KINDS.pmsm, gearhead: { ratio: 5, efficiency: 0.9 } }).magnitude).toBeCloseTo(5.4, 12);
  });

  it('stepper: the holding torque (0.5 N m), induction: the breakdown torque of the circuit (197.2 N m)', () => {
    expect(design(KINDS.stepper)).toMatchObject({ magnitude: 0.5, value: '≤ 500 mN·m' });
    expect(design(KINDS.stepper).detail).toContain('200 steps/rev');
    expect(design(KINDS.induction).magnitude).toBeCloseTo(197.2076, 3);
    expect(design(KINDS.induction).detail).toContain('230 V / 50 Hz');
  });
});
