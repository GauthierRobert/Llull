import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import {
  foundationCheck,
  type FoundationRow,
} from '@core/commands/building/industrial/foundationCheck';
import { __resetIdCounter } from '@lib/id';

const HALL = { span: 24000, length: 30000 };

function hall(params: Record<string, unknown> = {}, units?: 'm'): CadDocument {
  const base = createEmptyDocument();
  return execute(units ? { ...base, units } : base, 'add_portal_frame_building', {
    ...(units ? { span: 24, length: 30 } : HALL),
    ...params,
  }).document;
}

function rowsOf(doc: CadDocument, params: Record<string, unknown> = {}): FoundationRow[] {
  const result = foundationCheck.run(doc, params);
  return (result.data as { rows: FoundationRow[] }).rows;
}

const maxOf = (rows: FoundationRow[], check: string): number =>
  Math.max(...rows.filter((row) => row.check.startsWith(check)).map((row) => row.utilisation));

beforeEach(() => __resetIdCounter());

describe('check_foundations', () => {
  it('checks footings and base plates of the default hall (read-only)', () => {
    const doc = hall();
    const snapshot = JSON.stringify(doc);
    const result = foundationCheck.run(doc, {});
    expect(JSON.stringify(doc)).toBe(snapshot);
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    const data = result.data as {
      rows: FoundationRow[];
      csv: string;
      maxUtilisation: number;
      failures: string[];
    };
    expect(data.rows.length).toBeGreaterThan(0);
    expect(data.csv.split('\n')[0]).toContain('Utilisation');
    const checks = new Set(
      data.rows.map((row) => row.check.split(' ')[0] + ' ' + row.check.split(' ')[1]),
    );
    expect(checks.has('soil bearing')).toBe(true);
    expect(data.rows.some((row) => row.check.startsWith('sliding'))).toBe(true);
    expect(data.rows.some((row) => row.check.startsWith('plate concrete'))).toBe(true);
    expect(data.rows.some((row) => row.check.startsWith('anchor shear'))).toBe(true);
    expect(data.rows.every((row) => row.utilisation >= 0 && row.column.length > 0)).toBe(true);
    expect(data.maxUtilisation).toBe(Math.max(...data.rows.map((row) => row.utilisation)));
    expect(result.summary).toMatch(/Checked \d+ footing\(s\) and \d+ base plate\(s\)/);
    expect(result.summary).toContain('max utilisation');
    // No wind: no uplift / anchor tension rows.
    expect(data.rows.some((row) => row.check.startsWith('uplift'))).toBe(false);
    expect(data.rows.some((row) => row.check.startsWith('anchor tension'))).toBe(false);
  });

  it('increases soil bearing with snow', () => {
    const doc = hall();
    const light = maxOf(rowsOf(doc, { snowLoad: 0 }), 'soil bearing');
    const heavy = maxOf(rowsOf(doc, { snowLoad: 3 }), 'soil bearing');
    expect(heavy).toBeGreaterThan(light);
  });

  it('adds uplift and anchor tension rows with wind', () => {
    const doc = hall();
    const rows = rowsOf(doc, { windPressure: 1 });
    const uplift = rows.filter((row) => row.check.startsWith('uplift'));
    expect(uplift.length).toBeGreaterThan(0);
    expect(uplift[0]?.combination).toMatch(/W/);
    expect(rows.some((row) => row.check.startsWith('anchor tension'))).toBe(true);
    const windy = rowsOf(doc, { windPressure: 2 });
    expect(maxOf(windy, 'uplift')).toBeGreaterThan(maxOf(rows, 'uplift'));
  });

  it('fails a small footing on soil bearing and lists it', () => {
    const base = hall();
    const building = base.building;
    if (!building) throw new Error('no building');
    const elements = Object.fromEntries(
      Object.entries(building.elements).map(([id, element]) => [
        id,
        element.category === 'footing' ? { ...element, width: 300, length: 300 } : element,
      ]),
    );
    const doc = { ...base, building: { ...building, elements } };
    const result = foundationCheck.run(doc, {});
    const data = result.data as { failures: string[]; maxUtilisation: number };
    expect(data.maxUtilisation).toBeGreaterThan(1);
    expect(data.failures.length).toBeGreaterThan(0);
    expect(result.summary).toMatch(/\d+ failure\(s\): .*soil bearing/);
  });

  it('respects soilBearing and the crane cases', () => {
    const doc = hall({ crane: { capacity: 16, railHeight: 6000 } });
    const strong = rowsOf(doc, { soilBearing: 500, craneCapacity: 10 });
    const weak = rowsOf(doc, { soilBearing: 50, craneCapacity: 10 });
    expect(maxOf(weak, 'soil bearing')).toBeGreaterThan(maxOf(strong, 'soil bearing'));
    expect(strong.some((row) => /C\(/.test(row.combination))).toBe(true);
  });

  it('handles documents in metres', () => {
    const mm = maxOf(rowsOf(hall(), { windPressure: 0.8 }), 'soil bearing');
    const m = maxOf(rowsOf(hall({}, 'm'), { windPressure: 0.8 }), 'soil bearing');
    expect(m).toBeCloseTo(mm, 3);
  });

  it('is a no-op for bad input, unknown level or no footings', () => {
    const doc = hall();
    for (const params of [
      { soilBearing: 0 },
      { soilBearing: Number.NaN },
      { snowLoad: -1 },
      { levelId: 'nope' },
    ]) {
      const result = foundationCheck.run(doc, params);
      expect(result.document).toBe(doc);
      expect(result.affected).toEqual([]);
      expect(result.data).toBeUndefined();
      expect(result.summary).toContain('check_foundations failed');
    }
    const empty = foundationCheck.run(createEmptyDocument(), {});
    expect(empty.data).toBeUndefined();
    expect(empty.summary).toContain('check_foundations failed');
    const bare = hall({ footings: false, basePlates: false });
    expect(foundationCheck.run(bare, {}).summary).toContain('no portal frame column');
  });

  it('shares the thrust through a tie when tied and uses pad friction otherwise', () => {
    const doc = hall();
    const tied = rowsOf(doc, { windPressure: 0.7 });
    const untied = rowsOf(doc, { windPressure: 0.7, thrustTie: false });
    expect(maxOf(untied, 'sliding')).toBeGreaterThan(1);
    expect(maxOf(tied, 'sliding')).toBeLessThan(maxOf(untied, 'sliding'));
    expect(tied.some((row) => row.check.startsWith('thrust tie force'))).toBe(true);
    expect(untied.some((row) => row.check.startsWith('thrust tie force'))).toBe(false);
    const summary = foundationCheck.run(doc, {}).summary;
    expect(summary).toContain('thrust taken by a tie');
    expect(summary).toMatch(/\d+ footing\(s\) not checked/);
    expect(foundationCheck.run(doc, { thrustTie: false }).summary).toContain('pad friction');
    const weakTie = rowsOf(doc, { tieCapacity: 1 }).filter((row) => row.check.startsWith('thrust'));
    expect(weakTie[0]?.utilisation).toBeGreaterThan(1);
  });

  it('defaults thrustTie to false without a ground slab and rejects bad tie params', () => {
    const doc = hall({ floorSlab: false });
    expect(foundationCheck.run(doc, {}).summary).toContain('pad friction');
    expect(foundationCheck.run(doc, { thrustTie: true }).summary).toContain(
      'thrust taken by a tie',
    );
    for (const params of [{ tieCapacity: 0 }, { thrustTie: 'yes' }] as Record<string, unknown>[]) {
      const result = foundationCheck.run(doc, params);
      expect(result.data).toBeUndefined();
      expect(result.summary).toContain('check_foundations failed');
    }
  });
});

describe('slab friction with a thrust tie', () => {
  it('lets the ground slab resist the net wind shear of tied frames', () => {
    const doc = execute(createEmptyDocument(), 'add_portal_frame_building', {
      span: 24000,
      length: 30000,
    }).document;
    const tied = execute(doc, 'check_foundations', { windPressure: 0.7 });
    const untied = execute(doc, 'check_foundations', { windPressure: 0.7, thrustTie: false });
    const max = (result: ReturnType<typeof execute>): number =>
      (result.data as { maxUtilisation: number }).maxUtilisation;
    expect(max(tied)).toBeLessThan(1);
    expect(max(untied)).toBeGreaterThan(1);
  });
});
