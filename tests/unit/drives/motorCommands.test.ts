/** add_motor (dc), check_motor_data, set_motor_drive guards, delete_dynamics_item cascade, persistence: VC-DRV-01, 02, 35 (commands part). */
import { describe, expect, it } from 'vitest';
import { isRecord } from '@lib/isRecord';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { dynamicsProblems } from '@core/commands/persistence/dynamicsValidation';
import type { CadDocument } from '@core/model/types';
import { MAXON_SHEET, MAXON_SOURCE, expectedResults, rotorBench, section } from './fixtures';

const add = (
  doc: CadDocument,
  extra: Record<string, unknown> = {},
  sheet: Record<string, unknown> = MAXON_SHEET,
): ReturnType<typeof execute> =>
  execute(doc, 'add_motor', { joint: 'j_shaft', kind: 'dc', id: 'm', datasheet: sheet, source: MAXON_SOURCE, ...extra });

const withMotor = (extra: Record<string, unknown> = {}): CadDocument => add(rotorBench(), extra).document;

const profile = (doc: CadDocument, params: Record<string, unknown>): CadDocument => execute(doc, 'add_motion_profile', params).document;

describe('check_motor_data (VC-DRV-01)', () => {
  it('maxon 148877: six checks pass, the largest gap is the mechanical time constant (0.523 %)', () => {
    const result = execute(rotorBench(), 'check_motor_data', { datasheet: MAXON_SHEET });
    const data = result.data as {
      checks: { quantity: string; derived: number; relativeGap: number; status: string }[];
      maxGap: number;
      consistent: boolean;
    };
    expect(data.checks).toHaveLength(6);
    expect(data.checks.every((check) => check.status === 'pass')).toBe(true);
    expect(data.consistent).toBe(true);
    const pinned = expectedResults.cases.find((entry) => entry.id === 'VC-DRV-01');
    expect(data.maxGap).toBeCloseTo(pinned?.value ?? Number.NaN, 8);
    for (const check of section<{ checks: { quantity: string; derived: number }[] }>('maxon148877').checks)
      expect(data.checks.find((entry) => entry.quantity === check.quantity)?.derived).toBeCloseTo(check.derived, 8);
    expect(data.checks.find((check) => check.quantity === 'stallCurrentA')?.derived).toBeCloseTo(42.478, 3);
    expect(data.checks.find((check) => check.quantity === 'noLoadSpeedRpm')?.derived).toBeCloseTo(7589.15, 2);
  });

  it('a stored motor is checked by id; absent sheet values are listed as notGiven, not failed', () => {
    const doc = add(
      rotorBench(),
      {},
      { nominalVoltageV: 48, terminalResistanceOhm: 1.13, torqueConstantNmPerA: 0.0603, rotorInertiaKgM2: 1.37e-5 },
    ).document;
    const result = execute(doc, 'check_motor_data', { motor: 'm' });
    const data = result.data as { checks: unknown[]; notGiven: string[]; consistent: boolean };
    expect(data.notGiven).toHaveLength(6);
    expect(data.consistent).toBe(true);
    expect(result.summary).toContain('0 check(s) made');
  });

  it('refuses without a verdict: unknown motor, a motor without a datasheet, neither or both inputs; the document is returned as is', () => {
    const doc = withMotor();
    const curve = execute(doc, 'add_motor', { joint: 'j_shaft', kind: 'torque_curve', torque: 1, id: 'curve' }).document;
    for (const params of [{ motor: 'nope' }, { motor: 'curve' }, {}, { motor: 'm', datasheet: MAXON_SHEET }]) {
      const result = execute(curve, 'check_motor_data', params);
      expect(result.data).toBeUndefined();
      expect(result.document).toBe(curve);
    }
  });

  it('is pure (document deep-equal, no step)', () => {
    const doc = withMotor();
    const before = JSON.stringify(doc);
    const result = execute(doc, 'check_motor_data', { motor: 'm' });
    expect(JSON.stringify(doc)).toBe(before);
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(doc);
  });
});

describe('add_motor kind dc', () => {
  it('stores the motor with its sheet, gearhead and source and reports the check verdict', () => {
    const result = add(rotorBench(), { gearhead: { ratio: 10, efficiency: 0.9, efficiencyBack: 0.85, inertiaKgM2: 1e-6 } });
    const motor = result.document.dynamics?.motors['m'];
    expect(result.affected).toEqual(['m']);
    expect(motor).toMatchObject({
      kind: 'dc',
      joint: 'j_shaft',
      source: MAXON_SOURCE,
      gearhead: { ratio: 10, efficiency: 0.9, efficiencyBack: 0.85 },
    });
    expect(result.summary).toContain('datasheet consistent (6 checks');
    expect(result.summary).toContain('gear 10:1');
  });

  it('VC-DRV-02: kt +10 % is DRV_MOTOR_DATA_INCONSISTENT naming stall torque, ke and tau_m; acceptInconsistent keeps it unverified', () => {
    const bad = { ...MAXON_SHEET, torqueConstantNmPerA: 0.0663 };
    const doc = rotorBench();
    const refused = add(doc, {}, bad);
    expect(refused.document).toBe(doc);
    expect(refused.error?.code).toBe('DRV_MOTOR_DATA_INCONSISTENT');
    const failing = (refused.error?.detail?.['checks'] as { quantity: string; status: string }[])
      .filter((c) => c.status === 'fail')
      .map((c) => c.quantity);
    expect(failing).toEqual(expect.arrayContaining(['stallTorqueNm', 'keFromSpeedConstantVsPerRad', 'mechanicalTimeConstantS']));
    expect(refused.summary).toContain('stallTorqueNm');
    const accepted = add(doc, { acceptInconsistent: 'sheet typo, fitted on the bench' }, bad);
    expect(accepted.affected).toEqual(['m']);
    expect(accepted.document.dynamics?.motors['m']).toMatchObject({ acceptInconsistent: 'sheet typo, fitted on the bench' });
    expect(accepted.summary).toContain('INCONSISTENT');
  });

  it('refuses a missing sheet or source, an unknown or prismatic joint, a taken id; nothing changes', () => {
    const doc = rotorBench();
    const block = execute(doc, 'add_cylinder', { radius: 5, height: 5, position: [50, 0, 0], axis: [0, 0, 1] });
    const prismatic = execute(block.document, 'add_rigid_body', { entityIds: [block.affected[0] ?? ''], id: 'slider', massKg: 1 });
    const slide = execute(prismatic.document, 'add_body_joint', {
      kind: 'prismatic',
      child: 'slider',
      parent: 'ground',
      anchor: [50, 0, 0],
      axis: [1, 0, 0],
      id: 'j_slide',
    });
    const cases: [CadDocument, Record<string, unknown>][] = [
      [doc, { joint: 'j_shaft', kind: 'dc', source: MAXON_SOURCE }],
      [doc, { joint: 'j_shaft', kind: 'dc', datasheet: MAXON_SHEET }],
      [doc, { joint: 'nope', kind: 'dc', datasheet: MAXON_SHEET, source: MAXON_SOURCE }],
      [slide.document, { joint: 'j_slide', kind: 'dc', datasheet: MAXON_SHEET, source: MAXON_SOURCE }],
      [withMotor(), { joint: 'j_shaft', kind: 'dc', id: 'm', datasheet: MAXON_SHEET, source: MAXON_SOURCE }],
      [doc, { joint: 'j_shaft', kind: 'dc', datasheet: { ...MAXON_SHEET, terminalResistanceOhm: -1 }, source: MAXON_SOURCE }],
      [doc, { joint: 'j_shaft', kind: 'dc', datasheet: MAXON_SHEET, source: MAXON_SOURCE, gearhead: { ratio: 10, efficiency: 1.5 } }],
    ];
    for (const [start, params] of cases) {
      const result = execute(start, 'add_motor', params);
      expect(result.document).toBe(start);
      expect(result.affected).toEqual([]);
    }
    expect(
      execute(slide.document, 'add_motor', { joint: 'j_slide', kind: 'dc', datasheet: MAXON_SHEET, source: MAXON_SOURCE }).error?.code,
    ).toBe('DRV_JOINT_INVALID');
  });

  it('is pure', () => {
    const doc = rotorBench();
    const before = JSON.stringify(doc);
    add(doc);
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('a speed motor can carry the source of its torque bound', () => {
    const result = execute(rotorBench(), 'add_motor', {
      joint: 'j_shaft',
      kind: 'speed',
      rpm: 100,
      maxTorque: 2,
      source: { name: 'gearmotor sheet p3', grade: 'B' },
      id: 's',
    });
    expect(result.document.dynamics?.motors['s']).toMatchObject({ source: { name: 'gearmotor sheet p3', grade: 'B' } });
    expect(result.summary).toContain('source gearmotor sheet p3 grade B');
    expect(execute(rotorBench(), 'add_motor', { joint: 'j_shaft', kind: 'speed', rpm: 100, maxTorque: 2 }).summary).toContain(
      'bound unsourced',
    );
  });
});

describe('set_motor_drive', () => {
  const volts = (doc: CadDocument, params: Record<string, unknown>): ReturnType<typeof execute> =>
    execute(doc, 'set_motor_drive', { motor: 'm', ...params });
  const voltageProfile = (doc: CadDocument): CadDocument =>
    profile(doc, { id: 'v', quantity: 'voltage', unit: 'V', segments: [{ kind: 'dwell', duration: 1 }], start: 12 });
  const angular = (doc: CadDocument, quantity: 'velocity' | 'position'): CadDocument =>
    profile(doc, {
      id: quantity === 'velocity' ? 'w' : 'q',
      quantity,
      unit: quantity === 'velocity' ? 'rpm' : 'deg',
      start: 1,
      segments: [{ kind: 'dwell', duration: 1 }],
    });

  it('stores a voltage drive (constant or profile), a torque drive and replaces a previous drive', () => {
    const doc = withMotor();
    const first = volts(doc, { mode: 'voltage', volts: 48 });
    expect(first.affected).toEqual(['m']);
    expect(first.document.dynamics?.drives?.['m']).toMatchObject({ id: 'm', mode: 'voltage', volts: 48 });
    const second = volts(voltageProfile(first.document), { mode: 'voltage', profile: 'v', currentLimitA: 10 });
    expect(second.document.dynamics?.drives?.['m']).toMatchObject({ mode: 'voltage', profile: 'v', currentLimitA: 10 });
    expect(second.document.dynamics?.drives?.['m']).not.toHaveProperty('volts');
    const torque = profile(doc, { id: 't', quantity: 'torque', unit: 'N*m', start: 0.1, segments: [{ kind: 'dwell', duration: 1 }] });
    expect(volts(torque, { mode: 'torque', profile: 't' }).document.dynamics?.drives?.['m']?.mode).toBe('torque');
  });

  it('stores a tuned velocity loop and a gains position loop', () => {
    const doc = angular(angular(withMotor(), 'velocity'), 'position');
    const velocity = volts(doc, {
      mode: 'velocity',
      profile: 'w',
      tune: { bandwidthHz: 10, dampingRatio: 1 },
      sampleHz: 5000,
      feedforward: true,
    });
    expect(velocity.document.dynamics?.drives?.['m']).toMatchObject({
      mode: 'velocity',
      sampleHz: 5000,
      tune: { bandwidthHz: 10 },
      feedforward: true,
    });
    const position = volts(doc, { mode: 'position', profile: 'q', gains: { kp: 0.1, ki: 1, kpPosition: 30 }, sampleHz: 5000 });
    expect(position.document.dynamics?.drives?.['m']?.gains).toEqual({ kp: 0.1, ki: 1, kpPosition: 30 });
    const prescribed = volts(doc, { mode: 'prescribed', profile: 'q', effortLimit: 2 });
    expect(prescribed.document.dynamics?.drives?.['m']).toMatchObject({ mode: 'prescribed', effortLimit: 2 });
  });

  it('refuses with a stable code and leaves the document unchanged', () => {
    const base = angular(voltageProfile(withMotor()), 'velocity');
    const curve = execute(base, 'add_motor', { joint: 'j_shaft', kind: 'torque_curve', torque: 1, id: 'c' }).document;
    const linear = profile(base, { id: 'mm', quantity: 'position', unit: 'mm', start: 0, segments: [{ kind: 'dwell', duration: 1 }] });
    const cases: [CadDocument, Record<string, unknown>, string | RegExp][] = [
      [base, { motor: 'nope', mode: 'voltage', volts: 1 }, /not found/],
      [curve, { motor: 'c', mode: 'voltage', volts: 1 }, 'DRV_MOTOR_KIND_UNSUPPORTED'],
      [base, { mode: 'voltage' }, /needs `volts`/],
      [base, { mode: 'voltage', volts: 1, profile: 'v' }, /not both/],
      [base, { mode: 'torque' }, 'DRV_PROFILE_INVALID'],
      [base, { mode: 'torque', profile: 'ghost' }, 'DRV_PROFILE_INVALID'],
      [base, { mode: 'torque', profile: 'v' }, 'DRV_PROFILE_INVALID'],
      [linear, { mode: 'prescribed', profile: 'mm' }, 'DRV_PROFILE_INVALID'],
      [base, { mode: 'velocity', profile: 'w', gains: { kp: 1 } }, 'DRV_CONTROL_RATE'],
      [base, { mode: 'velocity', profile: 'w', sampleHz: 1000 }, /exactly one of/],
      [
        base,
        { mode: 'velocity', profile: 'w', gains: { kp: 1 }, tune: { bandwidthHz: 1, dampingRatio: 1 }, sampleHz: 1000 },
        /exactly one of/,
      ],
      [base, { mode: 'velocity', profile: 'w', tune: { bandwidthHz: 100, dampingRatio: 1 }, sampleHz: 1000 }, 'DRV_CONTROL_RATE'],
      [base, { mode: 'velocity', profile: 'w', gains: { kp: 1 }, sampleHz: 1000, target: 'ghost' }, 'DRV_JOINT_INVALID'],
      [base, { mode: 'position', profile: 'w', gains: { kp: 1 }, sampleHz: 1000 }, 'DRV_PROFILE_INVALID'],
    ];
    for (const [start, params, expected] of cases) {
      const result = execute(start, 'set_motor_drive', { motor: 'm', ...params });
      expect(result.document, JSON.stringify(params)).toBe(start);
      expect(result.affected).toEqual([]);
      if (typeof expected === 'string') expect(result.error?.code, JSON.stringify(params)).toBe(expected);
      else expect(result.summary).toMatch(expected);
    }
    const gainsWithoutPosition = angular(withMotor(), 'position');
    expect(volts(gainsWithoutPosition, { mode: 'position', profile: 'q', gains: { kp: 1 }, sampleHz: 1000 }).affected).toEqual([]);
  });

  it('tuning or prescribing a joint whose inertia cannot be computed is DRV_TUNE_NO_INERTIA', () => {
    const withProfile = angular(withMotor(), 'velocity');
    const hollow = execute(withProfile, 'delete_entities', { ids: Object.keys(withProfile.entities) }).document;
    expect(Object.keys(hollow.entities)).toHaveLength(0);
    const tuned = volts(hollow, { mode: 'velocity', profile: 'w', tune: { bandwidthHz: 1, dampingRatio: 1 }, sampleHz: 1000 });
    expect(tuned.error?.code).toBe('DRV_TUNE_NO_INERTIA');
    expect(tuned.document).toBe(hollow);
    expect(volts(hollow, { mode: 'prescribed', profile: 'w' }).error?.code).toBe('DRV_TUNE_NO_INERTIA');
  });

  it('is pure', () => {
    const doc = withMotor();
    const before = JSON.stringify(doc);
    volts(doc, { mode: 'voltage', volts: 12 });
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe('delete_dynamics_item and persistence of drive data', () => {
  const driven = (): CadDocument => {
    let doc = profile(withMotor(), { id: 'v', quantity: 'voltage', unit: 'V', start: 12, segments: [{ kind: 'dwell', duration: 1 }] });
    doc = execute(doc, 'set_motor_drive', { motor: 'm', mode: 'voltage', profile: 'v' }).document;
    return profile(doc, { id: 'spare', quantity: 'torque', unit: 'N*m', start: 1, segments: [{ kind: 'dwell', duration: 1 }] });
  };

  it('a profile in use is refused with its users; an unused one is removed', () => {
    const doc = driven();
    const refused = execute(doc, 'delete_dynamics_item', { id: 'v' });
    expect(refused.document).toBe(doc);
    expect(refused.summary).toContain("'m'");
    const removed = execute(doc, 'delete_dynamics_item', { id: 'spare' });
    expect(removed.document.dynamics?.profiles?.['spare']).toBeUndefined();
    expect(removed.document.dynamics?.profiles?.['v']).toBeDefined();
  });

  it('deleting the motor, or its joint, takes the drive with it', () => {
    const doc = driven();
    for (const id of ['m', 'j_shaft']) {
      const next = execute(doc, 'delete_dynamics_item', { id }).document;
      expect(next.dynamics?.drives?.['m']).toBeUndefined();
      expect(next.dynamics?.motors['m']).toBeUndefined();
    }
  });

  it('round-trips through save / load and replays from the history', () => {
    const doc = driven();
    expect(deserializeDocument(serializeDocument(doc)).dynamics).toEqual(doc.dynamics);
    expect(execute(doc, 'replay_history', {}).document.dynamics).toEqual(doc.dynamics);
    expect(dynamicsProblems(doc.dynamics)).toEqual([]);
  });

  it('load-time validation names a bad datasheet, profile or drive', () => {
    const doc = driven();
    const broken = (path: string[], value: unknown): string[] => {
      const copy = JSON.parse(JSON.stringify(doc.dynamics)) as Record<string, unknown>;
      let node: unknown = copy;
      for (const key of path.slice(0, -1)) node = isRecord(node) ? node[key] : undefined;
      if (!isRecord(node)) throw new Error(`no ${path.join('.')}`);
      node[path[path.length - 1] ?? ''] = value;
      return dynamicsProblems(copy);
    };
    expect(broken(['motors', 'm', 'datasheet', 'torqueConstantNmPerA'], -1)[0]).toContain('datasheet needs positive');
    expect(broken(['motors', 'm', 'gearhead'], { ratio: 2, efficiency: 2 })[0]).toContain('efficiencies');
    expect(broken(['motors', 'm', 'source'], { name: 'x', grade: 'Z' })[0]).toContain('source');
    expect(broken(['profiles', 'v', 'unit'], 'rpm')[0]).toContain('is not a voltage unit');
    expect(broken(['profiles', 'v', 'segments'], [{ kind: 'dwell', duration: -1 }])[0]).toContain('DRV_PROFILE_INVALID');
    expect(broken(['drives', 'm', 'mode'], 'warp')[0]).toContain('mode must be');
    expect(broken(['drives', 'm', 'tune'], { bandwidthHz: 0, dampingRatio: 1 })[0]).toContain('tune must be');
    expect(broken(['motors', 'm', 'kind'], 'ac')[0]).toContain("'torque_curve', 'speed', 'linear_speed' or 'dc'");
    expect(broken(['drives', 'm', 'profile'], 'ghost')[0]).toContain("profile 'ghost' does not exist");
    expect(broken(['drives', 'orphan'], { id: 'orphan', mode: 'voltage', volts: 1 })[0]).toContain("no datasheet (dc) motor 'orphan'");
    expect(
      broken(
        ['profiles', 'v', 'segments'],
        Array.from({ length: 10001 }, () => ({ kind: 'dwell', duration: 1 })),
      )[0],
    ).toContain('at most 10000 segments');
    const reserved = JSON.parse(
      '{"__proto__": {"id": "__proto__", "quantity": "voltage", "unit": "V", "segments": [{"kind": "dwell", "duration": 1}]}}',
    ) as unknown;
    const hostile = { ...(JSON.parse(JSON.stringify(doc.dynamics)) as Record<string, unknown>), profiles: reserved };
    expect(dynamicsProblems(hostile).join(' ')).toContain('reserved JavaScript property name');
  });
});
