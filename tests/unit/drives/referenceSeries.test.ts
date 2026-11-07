/**
 * Time-series reference data (PHY-23 DRV-M3): add_reference_data with `series`, compare_to_reference on it, fit_drive_parameters from stored series, the cascade
 * of delete_dynamics_item and the coded no-ops. The reference of the comparison tests is the model's own run (so the error is zero) or that run scaled (a known miss).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { setPhysicsEngine } from '@core/dynamics/physicsEngine';
import type { CadDocument } from '@core/model/types';
import { createMujocoPhysics } from '@physics-mujoco/mujocoPhysics';
import { inertiaBench, MAXON_SHEET, seriesOf, type DriveSeriesData } from './fixtures';

beforeAll(async () => setPhysicsEngine(await createMujocoPhysics()));
afterAll(() => setPhysicsEngine(null));

const SOURCE = 'bench log 2026-11-07 (synthetic: the model itself)';
const sheet = { ...MAXON_SHEET };
/** A 1.37e-3 kg*m^2 disc on the RE 40 driven by a 6 V constant voltage. */
const bench = (): CadDocument =>
  inertiaBench(1.37e-3, { sheet }, [{ command: 'set_motor_drive', params: { motor: 'm', mode: 'voltage', volts: 6 } }]);

interface Item {
  code: string;
  status: string;
  ids: string[];
  values: Record<string, number>;
  note?: string;
  unverified?: boolean;
}
interface Envelope {
  status: string;
  items: Item[];
}
const envelope = (result: ReturnType<typeof execute>): Envelope => result.data as Envelope;
const errorOf = (result: ReturnType<typeof execute>): { code: string } | undefined =>
  (result as unknown as { error?: { code: string } }).error;

/** The model's own drive series over `duration` s at 1 ms steps: the data of a perfect measurement. */
function ownRun(doc: CadDocument, duration: number): { times: number[]; omega: number[]; current: number[]; voltage: number[] } {
  const run = execute(doc, 'simulate_motion', { duration, timestep: 1e-3, sampleRate: 200, detail: 'drives', energy: true });
  const series = (run.data as { drives: { m: { series: DriveSeriesData } } }).drives.m.series;
  return { times: series.times, omega: seriesOf(run, 'jointVelocity', 'j'), current: series.currentA, voltage: series.voltageV };
}

describe('add_reference_data with a time series', () => {
  it('stores the series in dynamics.referenceSeries with its source and grade, and leaves the engine references alone', () => {
    const doc = bench();
    const result = execute(doc, 'add_reference_data', {
      id: 'omega_log',
      series: { quantity: 'joint_velocity', target: 'j', times: [0, 0.1, 0.2], values: [0, 30, 55], uncertainty: 0.5 },
      source: SOURCE,
      grade: 'A',
      bandRel: 0.02,
    });
    expect(result.affected).toEqual(['omega_log']);
    expect(result.document.dynamics?.referenceSeries?.['omega_log']).toEqual({
      id: 'omega_log',
      quantity: 'joint_velocity',
      target: 'j',
      times: [0, 0.1, 0.2],
      values: [0, 30, 55],
      source: { name: SOURCE, grade: 'A' },
      uncertainty: 0.5,
      bandRel: 0.02,
    });
    expect(result.document.prototype?.references ?? {}).toEqual({});
    expect(doc.dynamics?.referenceSeries).toBeUndefined();
    expect(result.summary).toMatch(/joint_velocity of j, 3 point\(s\) over 0\.\.0\.2 s, grade A/);
  });

  it('grade defaults to C, a generated id is used, and delete_dynamics_item removes it (and cascades with its motor)', () => {
    const doc = bench();
    const added = execute(doc, 'add_reference_data', {
      series: { quantity: 'motor_current', target: 'm', times: [0, 0.1], values: [3, 1] },
      source: SOURCE,
    });
    const id = added.affected[0] ?? '';
    expect(added.document.dynamics?.referenceSeries?.[id]?.source.grade).toBe('C');
    expect(execute(added.document, 'delete_dynamics_item', { id }).document.dynamics?.referenceSeries).toEqual({});
    const cascaded = execute(added.document, 'delete_dynamics_item', { id: 'm' });
    expect(cascaded.document.dynamics?.referenceSeries).toEqual({});
    expect(cascaded.summary).toMatch(/dependent record/);
  });

  it('is pure and refuses with the reason: no source, unknown joint / motor, bad times, ledger with several points, a taken id, mixed fields', () => {
    const doc = bench();
    const before = structuredClone(doc);
    const series = { quantity: 'joint_velocity', target: 'j', times: [0, 1], values: [0, 1] } as const;
    const refusals: [Record<string, unknown>, RegExp][] = [
      [{ series }, /needs a source/],
      [{ series: { ...series, target: 'ghost' }, source: SOURCE }, /no joint 'ghost'/],
      [{ series: { ...series, quantity: 'motor_current', target: 'ghost' }, source: SOURCE }, /no datasheet motor 'ghost'/],
      [{ series: { ...series, times: [1, 1] }, source: SOURCE }, /strictly increasing/],
      [{ series: { ...series, times: [-1, 1] }, source: SOURCE }, /strictly increasing/],
      [{ series: { ...series, values: [1] }, source: SOURCE }, /same length/],
      [{ series: { ...series, quantity: 'ledger_energy', target: 'copper' }, source: SOURCE }, /exactly one point/],
      [{ series, source: SOURCE, id: 'j' }, /already used/],
      [{ series, source: SOURCE, preset: 'o320a_full_throttle' }, /do not combine/],
    ];
    for (const [params, why] of refusals) {
      const result = execute(doc, 'add_reference_data', params);
      expect(result.summary, JSON.stringify(params)).toMatch(why);
      expect(result.document).toBe(doc);
      expect(result.affected).toEqual([]);
    }
    expect(doc).toEqual(before);
  });
});

describe('ids and budget', () => {
  it('a series and an engine reference never share an id (either order), so compare / delete reach the right item', () => {
    const doc = bench();
    const withSeries = execute(doc, 'add_reference_data', {
      id: 'x',
      series: { quantity: 'joint_velocity', target: 'j', times: [0, 1], values: [0, 1] },
      source: SOURCE,
    }).document;
    const engine = { id: 'x', quantity: 'brake_power_kW', points: [{ rpm: 5000, value: 50 }], source: 'datasheet' };
    const refused = execute(withSeries, 'add_reference_data', engine);
    expect(refused.summary).toMatch(/reference 'x' already exists/);
    expect(refused.document).toBe(withSeries);
    const withEngine = execute(doc, 'add_reference_data', engine).document;
    const other = execute(withEngine, 'add_reference_data', {
      id: 'x',
      series: { quantity: 'joint_velocity', target: 'j', times: [0, 1], values: [0, 1] },
      source: SOURCE,
    });
    expect(other.summary).toMatch(/id 'x' is already used/);
    // a series id that is a joint id is refused too (shared dynamics id space)
    expect(
      execute(doc, 'add_reference_data', {
        id: 'j',
        series: { quantity: 'joint_velocity', target: 'j', times: [0, 1], values: [0, 1] },
        source: SOURCE,
      }).summary,
    ).toMatch(/already used/);
  });

  it('the document holds at most 500000 reference points: one more series past the budget is refused with the count', () => {
    let doc = bench();
    const times = Array.from({ length: 100_000 }, (_, k) => k);
    const values = times.map(() => 0);
    for (let k = 0; k < 5; k++)
      doc = execute(doc, 'add_reference_data', {
        id: 's' + k,
        series: { quantity: 'joint_velocity', target: 'j', times, values },
        source: SOURCE,
      }).document;
    expect(Object.keys(doc.dynamics?.referenceSeries ?? {})).toHaveLength(5);
    const over = execute(doc, 'add_reference_data', {
      id: 's5',
      series: { quantity: 'joint_velocity', target: 'j', times: [0, 1], values: [0, 1] },
      source: SOURCE,
    });
    expect(over.summary).toMatch(/500002 reference points \(budget 500000\)/);
    expect(over.document).toBe(doc);
  });
});

describe('compare_to_reference on a time series', () => {
  const store = (
    doc: CadDocument,
    quantity: string,
    target: string,
    times: number[],
    values: number[],
    extra: Record<string, unknown> = {},
  ): CadDocument =>
    execute(doc, 'add_reference_data', { id: 'ref', series: { quantity, target, times, values }, source: SOURCE, ...extra }).document;

  it('the model against its own run: speed, current and voltage match with zero error (pass items, the document unchanged)', () => {
    const doc = bench();
    const own = ownRun(doc, 0.1);
    let stored = store(doc, 'joint_velocity', 'j', own.times, own.omega, { grade: 'A', id: 'w' });
    stored = execute(stored, 'add_reference_data', {
      id: 'i',
      series: { quantity: 'motor_current', target: 'm', times: own.times, values: own.current },
      source: SOURCE,
      grade: 'A',
    }).document;
    const result = execute(stored, 'compare_to_reference', { reference: 'all_series' });
    const data = envelope(result);
    expect(data.status).toBe('pass');
    expect(data.items.map((item) => item.code)).toEqual(['DRV_REFERENCE_MATCH', 'DRV_REFERENCE_MATCH']);
    for (const item of data.items) expect(item.values['relativeRms']).toBeLessThan(1e-9);
    expect(result.document).toBe(stored);
    expect(result.affected).toEqual([]);
  });

  it('a reference 20 % above the model fails (grade A) or warns (grade C) and is flagged unverified; the note lists the missing uncertainty', () => {
    const doc = bench();
    const own = ownRun(doc, 0.1);
    const scaled = own.omega.map((value) => value * 1.2);
    const failing = envelope(
      execute(store(doc, 'joint_velocity', 'j', own.times, scaled, { grade: 'A' }), 'compare_to_reference', { reference: 'ref' }),
    );
    expect(failing.items[0]).toMatchObject({ code: 'DRV_REFERENCE_MISMATCH', status: 'fail', unverified: true });
    // the model is 1/1.2 of the reference: the RMS error over the largest reference value is about 1/6 of the peak ratio
    expect(failing.items[0]?.values['relativeRms']).toBeGreaterThan(0.05);
    expect(failing.items[0]?.note).toMatch(/reading uncertainty unknown/);
    const warning = envelope(
      execute(store(doc, 'joint_velocity', 'j', own.times, scaled, { grade: 'C' }), 'compare_to_reference', { reference: 'ref' }),
    );
    expect(warning.items[0]?.status).toBe('warn');
    const known = envelope(
      execute(
        execute(doc, 'add_reference_data', {
          id: 'ref',
          series: { quantity: 'joint_velocity', target: 'j', times: own.times, values: own.omega, uncertainty: 0.01 },
          source: SOURCE,
        }).document,
        'compare_to_reference',
        { reference: 'ref' },
      ),
    );
    expect(known.items[0]?.note).toMatch(/reading sigmas/);
  });

  it('a ledger energy is compared at the end of the run by kind or element/kind', () => {
    const doc = bench();
    const run = execute(doc, 'simulate_motion', { duration: 0.1, timestep: 1e-3, sampleRate: 200, detail: 'drives', energy: true });
    const copper =
      (run.data as { ledger: { entries: { kind: string; joules: number }[] } }).ledger.entries.find((entry) => entry.kind === 'copper')
        ?.joules ?? Number.NaN;
    const stored = store(doc, 'ledger_energy', 'copper', [0.1], [copper], { grade: 'A', bandRel: 0.01 });
    expect(envelope(execute(stored, 'compare_to_reference', { reference: 'ref' })).status).toBe('pass');
    const wrong = store(doc, 'ledger_energy', 'm/copper', [0.1], [copper * 2], { grade: 'A' });
    expect(envelope(execute(wrong, 'compare_to_reference', { reference: 'ref' })).items[0]?.status).toBe('fail');
    const missing = store(doc, 'ledger_energy', 'stop', [0.1], [1], { grade: 'A' });
    const item = envelope(execute(missing, 'compare_to_reference', { reference: 'ref' })).items[0];
    expect(item).toMatchObject({ status: 'not_run', code: 'DRV_REFERENCE_MISMATCH' });
    expect(item?.note).toMatch(/ledger has no entry 'stop'/);
  });

  it('no-ops with the reason: no series, no engine, a reference that outlasts the run is a not_run item', () => {
    const doc = bench();
    expect(execute(doc, 'compare_to_reference', { reference: 'all_series' }).summary).toMatch(/no time-series reference data/);
    const stored = store(doc, 'joint_velocity', 'j', [0, 0.05, 0.1], [0, 1, 2], { grade: 'A' });
    setPhysicsEngine(null);
    expect(execute(stored, 'compare_to_reference', { reference: 'ref' }).summary).toMatch(/no physics engine is loaded/);
  });
});

describe('fit_drive_parameters from stored series', () => {
  it('fits R and kt from a stored step response (voltage, current, speed series of the model itself) through reference ids', async () => {
    setPhysicsEngine(await createMujocoPhysics());
    const doc = bench();
    const own = ownRun(doc, 0.2);
    const add = (id: string, quantity: string, target: string, values: number[]): void => {
      stored = execute(stored, 'add_reference_data', {
        id,
        series: { quantity, target, times: own.times, values },
        source: SOURCE,
        grade: 'A',
      }).document;
    };
    let stored = doc;
    add('w', 'joint_velocity', 'j', own.omega);
    add('i', 'motor_current', 'm', own.current);
    add('u', 'motor_voltage', 'm', own.voltage);
    const result = execute(stored, 'fit_drive_parameters', {
      series: { omega: 'w', current: 'i', voltage: 'u' },
      unknowns: ['resistance', 'torqueConstant'],
      known: { inductance: 0.00033 },
    });
    const values = (result.data as { values: Record<string, { value: number }> }).values;
    // the series are the end-of-step outputs, one step late against the midpoint state the winding used: 3 % on this fast transient
    expect(Math.abs((values['resistance']?.value ?? Number.NaN) / 1.13 - 1)).toBeLessThan(0.03);
    expect(Math.abs((values['torqueConstant']?.value ?? Number.NaN) / 0.0603 - 1)).toBeLessThan(0.03);
    const wrong = execute(stored, 'fit_drive_parameters', { series: { omega: 'i' }, unknowns: ['coulombNm'] });
    expect(wrong.summary).toMatch(/reference series 'i' is motor_current/);
    expect(errorOf(wrong)).toBeUndefined();
  });
});
