import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import {
  rateFor,
  toCsv,
  type TakeoffLine,
  type CostLine,
} from '@core/commands/building/quantities';
import { __resetIdCounter } from '@lib/id';

function run(doc: CadDocument, name: string, params: unknown): CadDocument {
  return execute(doc, name, params).document;
}

/** A 10 m × 8 m single-storey house shell. */
function house(): CadDocument {
  let doc = run(createEmptyDocument(), 'add_level', { name: 'Ground floor' });
  doc = run(doc, 'draw_walls', {
    points: [
      [0, 0],
      [10000, 0],
      [10000, 8000],
      [0, 8000],
    ],
    closed: true,
    thickness: 300,
  });
  doc = run(doc, 'add_door', { wallId: 'wall-1', offset: 2000 });
  doc = run(doc, 'add_window', { wallId: 'wall-1', offset: 6000 });
  doc = run(doc, 'add_window', { wallId: 'wall-3', offset: 5000, material: 'glass' });
  doc = run(doc, 'add_slab', { wallIds: ['wall-1', 'wall-2', 'wall-3', 'wall-4'], thickness: 200 });
  doc = run(doc, 'add_column', { location: [5000, 4000], height: 3000 });
  doc = run(doc, 'add_beam', { start: [0, 4000], end: [10000, 4000] });
  doc = run(doc, 'add_stair', { start: [1000, 1000] });
  doc = run(doc, 'add_room', {
    name: 'Open space',
    wallIds: ['wall-1', 'wall-2', 'wall-3', 'wall-4'],
  });
  return doc;
}

function line(lines: ReadonlyArray<TakeoffLine>, key: string): TakeoffLine {
  const found = lines.find((candidate) => candidate.key === key);
  if (!found) throw new Error(`missing ${key}`);
  return found;
}

beforeEach(() => __resetIdCounter());

describe('quantity_takeoff', () => {
  it('computes metric quantities with the centerline method', () => {
    const doc = house();
    const result = execute(doc, 'quantity_takeoff', {});
    expect(result.document).toBe(doc);
    const lines = (result.data as { lines: TakeoffLine[] }).lines;
    expect(line(lines, 'wall.concrete.m').quantity).toBeCloseTo(36);
    // gross 36 × 3 = 108 m²; openings: door 0.9×2.1 + 2 windows 1.2×1.2 = 4.77 m²
    expect(line(lines, 'wall.concrete.m2').quantity).toBeCloseTo(103.23);
    expect(line(lines, 'wall.concrete.m3').quantity).toBeCloseTo(30.969);
    expect(line(lines, 'door.timber.ea').quantity).toBe(1);
    expect(line(lines, 'window.glass.ea').quantity).toBe(2);
    expect(line(lines, 'slab-floor.concrete.m2').quantity).toBeCloseTo(80);
    expect(line(lines, 'column.concrete.m3').quantity).toBeCloseTo(0.27);
    expect(line(lines, 'beam.concrete.m3').quantity).toBeCloseTo(1.5);
    expect(line(lines, 'stair.concrete.ea').quantity).toBe(1);
    expect(line(lines, 'room.floor.m2').quantity).toBeCloseTo(9.7 * 7.7);
    expect(result.summary).toMatch(/Walls, concrete: 30\.969 m³/);
    expect((result.data as { csv: string }).csv.split('\n')[0]).toBe(
      'Key,Description,Quantity,Unit',
    );
  });

  it('reports an empty model and converts from metre documents', () => {
    expect(execute(createEmptyDocument(), 'quantity_takeoff', {}).summary).toMatch(/empty/);
    let doc = run(createEmptyDocument(), 'set_units', { units: 'm' });
    doc = run(doc, 'add_wall', { start: [0, 0], end: [5, 0] });
    const lines = (execute(doc, 'quantity_takeoff', {}).data as { lines: TakeoffLine[] }).lines;
    expect(line(lines, 'wall.concrete.m3').quantity).toBeCloseTo(5 * 3 * 0.2);
  });
});

describe('building_schedule', () => {
  it.each([
    ['wall', 4],
    ['door', 1],
    ['window', 2],
    ['room', 1],
    ['slab', 1],
    ['column', 1],
    ['beam', 1],
    ['stair', 1],
  ])('%s schedule has one row per element', (kind, rows) => {
    const result = execute(house(), 'building_schedule', { kind });
    const data = result.data as { rows: unknown[][]; columns: string[]; csv: string };
    expect(data.rows).toHaveLength(rows);
    expect(data.csv.split('\n')[0]).toBe(
      data.columns.map((c) => (c.includes(',') ? `"${c}"` : c)).join(','),
    );
  });

  it('door schedule lists host wall and swing; window lists area', () => {
    const doc = house();
    const door = execute(doc, 'building_schedule', { kind: 'door' }).data as { rows: unknown[][] };
    expect(door.rows[0]).toEqual(['D1', 'Ground floor', 'W1', 900, 2100, 0, 'left', 'timber']);
    const windows = execute(doc, 'building_schedule', { kind: 'window' }).data as {
      rows: unknown[][];
    };
    expect(windows.rows[0]?.[6]).toBeCloseTo(1.44);
    const columns = execute(
      run(doc, 'add_column', { location: [1, 1], shape: 'circular' }),
      'building_schedule',
      { kind: 'column' },
    ).data as { rows: unknown[][] };
    expect(columns.rows[1]?.[3]).toBe('Ø300');
  });

  it('rejects an unknown kind', () => {
    const doc = house();
    const result = execute(doc, 'building_schedule', { kind: 'roof' });
    expect(result.summary).toMatch(/kind must be/);
    expect(result.data).toBeUndefined();
  });
});

describe('cost estimate', () => {
  it('prices takeoff lines from stored + override rates with wildcard fallbacks', () => {
    let doc = house();
    doc = run(doc, 'set_cost_rates', {
      rates: { 'wall.concrete.m3': 200, 'door.*.ea': 500 },
      currency: 'EUR',
    });
    expect(doc.building!.costRates).toEqual({ 'wall.concrete.m3': 200, 'door.*.ea': 500 });
    const result = execute(doc, 'estimate_cost', { rates: { '*.glass.ea': 300 } });
    const data = result.data as {
      total: number;
      lines: CostLine[];
      unpriced: string[];
      csv: string;
    };
    expect(data.total).toBeCloseTo(30.969 * 200 + 500 + 600, 1);
    expect(data.unpriced).toContain('slab-floor.concrete.m3');
    expect(result.summary).toMatch(/EUR/);
    expect(data.csv.trim().split('\n').pop()).toMatch(/^TOTAL/);
    const allPriced = execute(doc, 'estimate_cost', {
      rates: { '*.glass.ea': 300, ...Object.fromEntries(data.unpriced.map((k) => [k, 1])) },
    });
    expect(allPriced.summary).not.toMatch(/unpriced/);
  });

  it('replace mode and validation', () => {
    let doc = run(house(), 'set_cost_rates', { rates: { a: 1 } });
    doc = run(doc, 'set_cost_rates', { rates: { b: 2 }, replace: true });
    expect(doc.building!.costRates).toEqual({ b: 2 });
    expect(doc.building!.currency).toBe('EUR');
    expect(execute(doc, 'set_cost_rates', { rates: {} }).document).toBe(doc);
    expect(execute(doc, 'set_cost_rates', { rates: { a: -1 } }).document).toBe(doc);
    expect(execute(doc, 'estimate_cost', { rates: [] }).summary).toMatch(/failed/);
  });

  it('rateFor and toCsv helpers', () => {
    const takeoffLine: TakeoffLine = {
      key: 'wall.brick.m2',
      group: 'wall',
      category: 'wall',
      material: 'brick',
      description: '',
      unit: 'm2',
      quantity: 1,
    };
    expect(rateFor({ '*.brick.m2': 3 }, takeoffLine)).toBe(3);
    expect(rateFor({}, takeoffLine)).toBeNull();
    expect(toCsv(['a'], [['x,"y"']])).toBe('a\n"x,""y"""\n');
  });
});
