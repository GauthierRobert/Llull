import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { type TakeoffLine } from '@aec/building/quantities/takeoffBasics';
import { run } from '../../helpers/runFixtures';

/** One bay: two 400×400 columns 6 m apart on a 3 m storey, a 300×500 beam between them, and (optionally) a 200 mm slab above. */
function bay(withSlab: boolean, shape: 'rectangular' | 'circular' = 'rectangular'): CadDocument {
  let doc = run(createEmptyDocument(), 'add_level', { name: 'L0', elevation: 0, height: 3000 });
  doc = run(doc, 'add_level', { name: 'L1', elevation: 3000, height: 3000 });
  if (withSlab) {
    doc = run(doc, 'add_slab', {
      boundary: [
        [-400, -400],
        [6400, -400],
        [6400, 400],
        [-400, 400],
      ],
      thickness: 200,
      levelId: 'level-2',
    });
  }
  doc = run(doc, 'add_column', { location: [0, 0], width: 400, depth: 400, shape, levelId: 'level-1' });
  doc = run(doc, 'add_column', { location: [6000, 0], width: 400, depth: 400, shape, levelId: 'level-1' });
  return run(doc, 'add_beam', { start: [0, 0], end: [6000, 0], width: 300, depth: 500, levelId: 'level-1' });
}

const quantity = (lines: ReadonlyArray<TakeoffLine>, key: string): number => lines.find((line) => line.key === key)?.quantity ?? NaN;

describe('quantity_takeoff net concrete', () => {
  it('measures columns to the slab soffit and beams below it between column faces', () => {
    const result = execute(bay(true), 'quantity_takeoff', {});
    const { lines, gross } = result.data as { lines: TakeoffLine[]; gross: Record<string, number> };
    // columns: 2 × 0.4 × 0.4 × (3.0 - 0.2) ; beam: (6.0 - 0.4) × 0.3 × (0.5 - 0.2)
    expect(quantity(lines, 'column.concrete.m3')).toBeCloseTo(0.896, 3);
    expect(quantity(lines, 'beam.concrete.m3')).toBeCloseTo(0.504, 3);
    expect(quantity(lines, 'beam.concrete.m')).toBeCloseTo(6, 3);
    expect(quantity(lines, 'slab-floor.concrete.m3')).toBeCloseTo(6.8 * 0.8 * 0.2, 3);
    expect(gross['column.concrete.m3']).toBeCloseTo(0.96, 3);
    expect(gross['beam.concrete.m3']).toBeCloseTo(0.9, 3);
    expect(gross['slab-floor.concrete.m3']).toBeUndefined();
    expect(result.summary).toMatch(/slab > column > beam/);
    expect(result.summary).toMatch(/beam\.concrete\.m3 0\.9/);
  });

  it('without a slab only the column joints are removed from the beam', () => {
    const lines = (execute(bay(false), 'quantity_takeoff', {}).data as { lines: TakeoffLine[] }).lines;
    expect(quantity(lines, 'column.concrete.m3')).toBeCloseTo(0.96, 3);
    expect(quantity(lines, 'beam.concrete.m3')).toBeCloseTo(5.6 * 0.3 * 0.5, 3);
  });

  it('ignores the part of a slab that is an opening', () => {
    let doc = bay(true);
    doc = run(doc, 'add_slab_opening', {
      slabId: 'slab-1',
      boundary: [
        [2000, -150],
        [4000, -150],
        [4000, 150],
        [2000, 150],
      ],
    });
    const lines = (execute(doc, 'quantity_takeoff', {}).data as { lines: TakeoffLine[] }).lines;
    // beam over the 2 m opening is measured full depth: 2 × 0.3 × 0.5 more than the slab-covered 3.6 m × 0.3 × 0.3
    expect(quantity(lines, 'beam.concrete.m3')).toBeCloseTo(3.6 * 0.3 * 0.3 + 2 * 0.3 * 0.5, 3);
    expect(quantity(lines, 'column.concrete.m3')).toBeCloseTo(0.896, 3);
  });

  it('handles circular columns', () => {
    const lines = (execute(bay(true, 'circular'), 'quantity_takeoff', {}).data as { lines: TakeoffLine[] }).lines;
    expect(quantity(lines, 'column.concrete.m3')).toBeCloseTo(2 * Math.PI * 0.2 ** 2 * 2.8, 2);
    expect(quantity(lines, 'beam.concrete.m3')).toBeGreaterThan(0.5);
  });

  it('is pure and reports no gross difference for a slab-only model', () => {
    const doc = bay(true);
    const before = JSON.stringify(doc);
    execute(doc, 'quantity_takeoff', {});
    expect(JSON.stringify(doc)).toBe(before);
    const empty = execute(createEmptyDocument(), 'quantity_takeoff', {});
    expect((empty.data as { gross: Record<string, number> }).gross).toEqual({});
  });
});

describe('building_schedule net concrete', () => {
  const rows = (doc: CadDocument, kind: 'column' | 'beam'): unknown[][] =>
    (execute(doc, 'building_schedule', { kind }).data as { rows: unknown[][] }).rows;

  it('column and beam rows carry the net volume and the gross prism, matching quantity_takeoff', () => {
    const doc = bay(true);
    const columns = rows(doc, 'column');
    const beams = rows(doc, 'beam');
    expect(columns.map((row) => row[6])).toEqual([0.448, 0.448]);
    expect(columns.map((row) => row[7])).toEqual([0.48, 0.48]);
    expect(beams[0]?.[5]).toBeCloseTo(0.504, 3);
    expect(beams[0]?.[6]).toBeCloseTo(0.9, 3);
    const total = columns.reduce((sum, row) => sum + Number(row[6]), 0);
    const lines = (execute(doc, 'quantity_takeoff', {}).data as { lines: TakeoffLine[] }).lines;
    expect(total).toBeCloseTo(quantity(lines, 'column.concrete.m3'), 3);
  });

  it('equals gross where members do not overlap and states the rule in the description', () => {
    const doc = run(run(createEmptyDocument(), 'add_level', { name: 'L0' }), 'add_column', { location: [0, 0], width: 400, depth: 400 });
    const [row] = rows(doc, 'column');
    expect(row?.[6]).toBe(row?.[7]);
    expect(execute(doc, 'building_schedule', { kind: 'room' }).summary).toMatch(/schedule/);
  });
});
