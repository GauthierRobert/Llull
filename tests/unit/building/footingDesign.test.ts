import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { BuildingElement, FootingElement } from '@core/model/building';
import { execute } from '@core/commands/registry';
import {
  designFootings,
  type FootingDesignRow,
} from '@core/commands/building/industrial/footingDesign';
import {
  foundationCheck,
  type FoundationRow,
} from '@core/commands/building/industrial/foundationCheck';
import type { TakeoffLine } from '@core/commands/building/quantities';
import { __resetIdCounter } from '@lib/id';

function hall(params: Record<string, unknown> = {}): CadDocument {
  return execute(createEmptyDocument(), 'add_portal_frame_building', {
    span: 24000,
    length: 30000,
    ...params,
  }).document;
}

const footingsOf = (doc: CadDocument): FootingElement[] =>
  Object.values(doc.building?.elements ?? {}).filter(
    (element: BuildingElement): element is FootingElement => element.category === 'footing',
  );

function withFootings(doc: CadDocument, patch: Partial<FootingElement>): CadDocument {
  const building = doc.building;
  if (!building) throw new Error('no building');
  const elements = Object.fromEntries(
    Object.entries(building.elements).map(([id, element]) => [
      id,
      element.category === 'footing' ? { ...element, ...patch } : element,
    ]),
  );
  return { ...doc, building: { ...building, elements } };
}

function design(doc: CadDocument, params: Record<string, unknown> = {}): FootingDesignRow[] {
  return (designFootings.run(doc, params).data as { footings: FootingDesignRow[] }).footings;
}

const steelMass = (doc: CadDocument): number =>
  footingsOf(doc).reduce((sum, footing) => {
    const bars = footing.reinforcement;
    return sum + (bars ? (bars.barDiameter ** 2 / bars.spacing) * footing.width : 0);
  }, 0);

beforeEach(() => __resetIdCounter());

describe('design_footings', () => {
  it('gives the default hall realistic bars and stores them on every analysed footing', () => {
    const doc = hall();
    const result = designFootings.run(doc, { windPressure: 0.7 });
    const rows = (result.data as { footings: FootingDesignRow[]; changes: string[] }).footings;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.status).toBe('designed');
      expect([12, 16, 20, 25]).toContain(row.barDiameter);
      expect(row.spacing).toBeGreaterThanOrEqual(100);
      expect(row.spacing).toBeLessThanOrEqual(250);
      expect(row.asProvided).toBeGreaterThanOrEqual(row.asRequired);
      expect(row.shearUtilisation).toBeLessThanOrEqual(1);
      expect(row.punchingUtilisation).toBeLessThanOrEqual(1);
    }
    const reinforced = footingsOf(result.document).filter((footing) => footing.reinforcement);
    expect(reinforced).toHaveLength(rows.length);
    expect(reinforced[0]?.reinforcement).toEqual({ barDiameter: 12, spacing: 150, cover: 50 });
    expect(result.affected.length).toBeGreaterThan(0);
    expect(result.summary).toMatch(/Designed \d+ of \d+ footing\(s\) on level/);
    expect(result.summary).toMatch(/F\d+ H12 @ 150 \(As \d+ ≤ \d+ mm²\/m, shear [\d.]+, punching/);
    expect(result.summary).toMatch(
      /Max shear [\d.]+, max punching [\d.]+; \d+ footing\(s\) changed/,
    );
    // Re-running is idempotent.
    const again = designFootings.run(result.document, { windPressure: 0.7 });
    expect(again.affected).toEqual([]);
    expect(again.summary).toContain('no change');
  });

  it('needs more steel under a heavy crane or large load', () => {
    const light = hall({ crane: { capacity: 5, railHeight: 6000 } });
    const wide = withFootings(light, { width: 5000, length: 5000, thickness: 500 });
    const lightResult = designFootings.run(wide, { craneCapacity: 0, snowLoad: 0.8 });
    const heavyResult = designFootings.run(wide, { craneCapacity: 0, snowLoad: 12 });
    const heavyRows = (heavyResult.data as { footings: FootingDesignRow[] }).footings;
    expect(heavyRows.every((row) => row.status === 'designed')).toBe(true);
    expect(steelMass(heavyResult.document)).toBeGreaterThan(steelMass(lightResult.document));
    const governing = (rows: FootingDesignRow[]): number =>
      Math.max(...rows.map((row) => row.asRequired));
    expect(governing(heavyRows)).toBeGreaterThan(
      governing((lightResult.data as { footings: FootingDesignRow[] }).footings),
    );
  });

  it('fails a thin footing on punching / shear and leaves its reinforcement unset', () => {
    const doc = hall();
    const thin = withFootings(doc, { thickness: 150, width: 2500, length: 2500 });
    const result = designFootings.run(thin, { snowLoad: 6 });
    const rows = (result.data as { footings: FootingDesignRow[] }).footings;
    expect(rows.some((row) => row.status === 'failed')).toBe(true);
    for (const row of rows.filter((item) => item.status === 'failed')) {
      expect(row.barDiameter).toBeNull();
      expect(Math.max(row.shearUtilisation, row.punchingUtilisation)).toBeGreaterThan(1);
    }
    expect(footingsOf(result.document).every((footing) => !footing.reinforcement)).toBe(true);
    expect(result.summary).toMatch(/not reinforced — increase thickness/);
  });

  it('removes a stale reinforcement from a footing that now fails', () => {
    const designed = designFootings.run(hall(), {}).document;
    const thin = withFootings(designed, { thickness: 150, width: 2500, length: 2500 });
    const result = designFootings.run(thin, { snowLoad: 6 });
    expect(footingsOf(result.document).every((footing) => !footing.reinforcement)).toBe(true);
    expect((result.data as { changes: string[] }).changes[0]).toContain('reinforcement removed');
    expect(result.affected.length).toBeGreaterThan(0);
  });

  it('is pure and stores bars in document units', () => {
    const doc = hall();
    const snapshot = JSON.stringify(doc);
    const result = designFootings.run(doc, {});
    expect(JSON.stringify(doc)).toBe(snapshot);
    expect(result.document).not.toBe(doc);
    const metres = execute({ ...createEmptyDocument(), units: 'm' }, 'add_portal_frame_building', {
      span: 24,
      length: 30,
    }).document;
    const bars = footingsOf(designFootings.run(metres, {}).document)[0]?.reinforcement;
    expect(bars?.barDiameter).toBeCloseTo(0.012, 6);
    expect(bars?.cover).toBeCloseTo(0.05, 6);
  });

  it('is a no-op for bad input, unknown level or no footings', () => {
    const doc = hall();
    for (const params of [{ snowLoad: -1 }, { deadLoad: Number.NaN }, { levelId: 'nope' }]) {
      const result = designFootings.run(doc, params);
      expect(result.document).toBe(doc);
      expect(result.affected).toEqual([]);
      expect(result.data).toBeUndefined();
      expect(result.summary).toContain('design_footings failed');
    }
    expect(designFootings.run(createEmptyDocument(), {}).summary).toContain(
      'design_footings failed',
    );
    const bare = hall({ footings: false });
    expect(designFootings.run(bare, {}).summary).toContain('no portal frame column with a footing');
  });

  it('reports a footing without net compression as unloaded', () => {
    const doc = hall();
    const result = designFootings.run(doc, { deadLoad: 0, snowLoad: 0, windPressure: 0 });
    const rows = (result.data as { footings: FootingDesignRow[] }).footings;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.status === 'designed' || row.status === 'unloaded')).toBe(true);
  });

  it('falls back to the column profile when there is no base plate and handles uplift-only wind', () => {
    const doc = hall({ basePlates: false });
    const rows = design(doc, { windPressure: 1.5, deadLoad: 0.1, snowLoad: 0 });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.status !== 'failed' || row.note.length > 0)).toBe(true);
  });

  it('flags bending beyond the singly-reinforced limit', () => {
    const slender = withFootings(hall(), { thickness: 150, width: 6000, length: 6000 });
    const rows = design(slender, { snowLoad: 8 });
    expect(rows.some((row) => row.status === 'failed')).toBe(true);
    expect(rows.some((row) => /K > 0\.167|shear or punching/.test(row.note))).toBe(true);
  });

  it('handles a heavily eccentric load with a triangular pressure block', () => {
    const doc = withFootings(hall(), { width: 900, length: 900, thickness: 500 });
    const rows = design(doc, { windPressure: 1.2, craneCapacity: 0 });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => Number.isFinite(row.punchingUtilisation))).toBe(true);
  });
});

describe('footing reinforcement in the takeoff and schedule', () => {
  it('adds footing.rebar.kg with 10% laps and a Reinforcement schedule column', () => {
    const plain = hall();
    const before = (execute(plain, 'quantity_takeoff', {}).data as { lines: TakeoffLine[] }).lines;
    expect(before.find((line) => line.key === 'footing.rebar.kg')).toBeUndefined();
    const doc = designFootings.run(plain, {}).document;
    const lines = (execute(doc, 'quantity_takeoff', {}).data as { lines: TakeoffLine[] }).lines;
    const rebar = lines.find((line) => line.key === 'footing.rebar.kg');
    expect(rebar?.unit).toBe('kg');
    // H12 @ 150 on 1.5 x 1.5 m pads, 50 mm cover: 10 bars x 1.4 m each way, x 1.1 laps.
    const count = footingsOf(doc).filter((footing) => footing.reinforcement).length;
    const perFooting = 2 * 10 * 1.4 * ((Math.PI * 0.012 ** 2) / 4) * 7850 * 1.1;
    expect(rebar?.quantity).toBeCloseTo(count * perFooting, 3);
    const schedule = execute(doc, 'building_schedule', { kind: 'footing' }).data as {
      columns: string[];
      rows: unknown[][];
    };
    const index = schedule.columns.indexOf('Reinforcement');
    expect(index).toBeGreaterThan(-1);
    expect(schedule.rows[0]?.[index]).toBe('H12 @ 150 B1/B2');
    const empty = execute(plain, 'building_schedule', { kind: 'footing' }).data as {
      rows: unknown[][];
    };
    expect(empty.rows[0]?.[index]).toBe('');
  });
});

describe('check_foundations settlement', () => {
  const rowsOf = (doc: CadDocument, params: Record<string, unknown> = {}): FoundationRow[] =>
    (foundationCheck.run(doc, params).data as { rows: FoundationRow[] }).rows;

  it('adds an elastic settlement row per footing and a differential row', () => {
    const rows = rowsOf(hall());
    const settlement = rows.filter((row) => row.check.startsWith('settlement'));
    expect(settlement.length).toBeGreaterThan(0);
    expect(settlement[0]?.unit).toBe('mm');
    expect(settlement[0]?.limit).toBe(25);
    expect(settlement[0]?.utilisation).toBeCloseTo((settlement[0]?.value ?? 0) / 25, 6);
    expect(settlement[0]?.combination).toBe('G+S');
    expect(rows.filter((row) => row.check.startsWith('differential settlement'))).toHaveLength(1);
  });

  it('settles less in stiffer soil and rejects a bad soilModulus', () => {
    const doc = hall();
    const soft = rowsOf(doc, { soilModulus: 5 }).find((row) => row.check.startsWith('settlement'));
    const stiff = rowsOf(doc, { soilModulus: 50 }).find((row) =>
      row.check.startsWith('settlement'),
    );
    expect(soft?.value).toBeGreaterThan(stiff?.value ?? Infinity);
    expect((soft?.value ?? 0) / (stiff?.value ?? 1)).toBeCloseTo(10, 6);
    expect(rowsOf(doc, { soilModulus: 1 }).some((row) => row.utilisation > 1)).toBe(true);
    for (const soilModulus of [0, Number.NaN]) {
      const result = foundationCheck.run(doc, { soilModulus });
      expect(result.data).toBeUndefined();
      expect(result.summary).toContain('soilModulus must be a number > 0');
    }
  });
});
