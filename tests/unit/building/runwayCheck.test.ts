import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import {
  runwayCheck,
  wheelMoment,
  wheelShear,
  type RunwayCheckRow,
} from '@core/commands/building/industrial/runwayCheck';
import { __resetIdCounter } from '@lib/id';

function hall(capacity = 10): CadDocument {
  return execute(createEmptyDocument(), 'add_portal_frame_building', {
    span: 24000,
    length: 30000,
    crane: { capacity, railHeight: 6000 },
  }).document;
}

function rowsOf(doc: CadDocument, params = {}): RunwayCheckRow[] {
  const result = runwayCheck.run(doc, params);
  return (result.data as { rows: RunwayCheckRow[] }).rows;
}

const find = (rows: RunwayCheckRow[], kind: string, check = ''): RunwayCheckRow => {
  const match = rows.find((row) => row.kind === kind && row.check.includes(check));
  if (!match) throw new Error(`no ${kind} row`);
  return match;
};

beforeEach(() => __resetIdCounter());

describe('check_crane_runways', () => {
  it('checks the default 10 t runway with realistic utilisations', () => {
    const doc = hall();
    const result = runwayCheck.run(doc, {});
    const data = result.data as {
      rows: RunwayCheckRow[];
      csv: string;
      maxUtilisation: number;
      failures: string[];
    };
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(data.failures).toEqual([]);
    expect(data.rows.length % 6).toBe(0);
    for (const kind of ['strength', 'ltb', 'deflection', 'fatigue']) {
      expect(data.rows.some((row) => row.kind === kind)).toBe(true);
    }
    expect(find(data.rows, 'deflection', 'vertical').unit).toBe('mm');
    expect(find(data.rows, 'deflection', 'lateral').limit).toBeGreaterThan(0);
    for (const row of data.rows) {
      expect(row.utilisation).toBeGreaterThan(0.005);
      expect(row.utilisation).toBeLessThan(1);
    }
    expect(find(data.rows, 'fatigue').utilisation).toBeGreaterThan(0.2);
    expect(find(data.rows, 'ltb').utilisation).toBeGreaterThanOrEqual(
      find(data.rows, 'strength', 'bending').utilisation,
    );
    expect(data.csv).toContain('Utilisation');
    expect(result.summary).toMatch(/Checked \d+ crane runway beam\(s\).*10 t, class S3.*all OK/);
    expect(runwayCheck.annotations).toEqual({ readOnly: true, idempotent: true });
  });

  it('fails a 32 t crane on the same beams, and the override matches the real one', () => {
    const result = runwayCheck.run(hall(), { craneCapacity: 32 });
    const data = result.data as { maxUtilisation: number; failures: string[] };
    expect(data.maxUtilisation).toBeGreaterThan(1);
    expect(data.failures.length).toBeGreaterThan(0);
    expect(result.summary).toMatch(/failure\(s\)/);
    const built = hall(32);
    expect(runwayCheck.run(built, {}).data).toEqual(result.data);
  });

  it('gives class S4 a higher fatigue utilisation than S2', () => {
    const doc = hall();
    const s2 = find(rowsOf(doc, { craneClass: 'S2' }), 'fatigue').utilisation;
    const s4 = find(rowsOf(doc, { craneClass: 'S4' }), 'fatigue').utilisation;
    expect(s4 / s2).toBeCloseTo(0.5 / 0.315, 2);
  });

  it('increases moment with a short wheelBase and uses single-wheel PL/4 when long', () => {
    const doc = hall();
    const short = find(rowsOf(doc, { wheelBase: 1000 }), 'strength', 'bending').utilisation;
    const long = find(rowsOf(doc, { wheelBase: 5000 }), 'strength', 'bending').utilisation;
    expect(short).toBeGreaterThan(long);
    expect(wheelMoment(10, 6000, 6000)).toBe(15000);
    expect(wheelMoment(10, 0, 6000)).toBe(30000);
    expect(wheelShear(10, 1000, 6000)).toBeCloseTo(18.33, 1);
    expect(wheelShear(10, 9000, 6000)).toBe(10);
  });

  it('reports non-I profiles as not susceptible to LTB and skips unknown profiles', () => {
    const doc = hall();
    const members = Object.values(doc.building?.elements ?? {}).filter(
      (element) => element.category === 'member' && element.role === 'crane',
    );
    const swap = (profile: string): CadDocument => ({
      ...doc,
      building: {
        ...doc.building!,
        elements: Object.fromEntries(
          Object.entries(doc.building!.elements).map(([id, element]) => [
            id,
            members.some((member) => member.id === id) ? { ...element, profile } : element,
          ]),
        ),
      },
    });
    const hollow = rowsOf(swap('RHS300x200x10'));
    expect(find(hollow, 'ltb').check).toMatch(/not susceptible/);
    const unknown = runwayCheck.run(swap('NOPE'), {});
    expect(unknown.data).toBeUndefined();
    expect(unknown.summary).toMatch(/no crane runway beam/);
  });

  it('is a graceful no-op for bad input', () => {
    const doc = hall();
    for (const params of [
      { craneCapacity: -1 },
      { craneCapacity: Number.NaN },
      { wheelBase: 0 },
      { craneClass: 'S9' as 'S2' },
      { levelId: 'nope' },
    ]) {
      const result = runwayCheck.run(doc, params);
      expect(result.document).toBe(doc);
      expect(result.affected).toEqual([]);
      expect(result.data).toBeUndefined();
      expect(result.summary).toMatch(/^check_crane_runways failed/);
    }
  });

  it('is a graceful no-op without cranes', () => {
    const plain = execute(createEmptyDocument(), 'add_portal_frame_building', {
      span: 24000,
      length: 30000,
    }).document;
    const result = runwayCheck.run(plain, {});
    expect(result.data).toBeUndefined();
    expect(result.summary).toMatch(/no crane runway beam/);
    const empty = createEmptyDocument();
    expect(runwayCheck.run(empty, {}).summary).toMatch(/failed/);
  });
});

describe('metre documents', () => {
  it('gives the same utilisations in a document drawn in metres', () => {
    const metres = execute({ ...createEmptyDocument(), units: 'm' }, 'add_portal_frame_building', {
      span: 24,
      length: 30,
      crane: { capacity: 10, railHeight: 6 },
    }).document;
    const max = (doc: CadDocument): number =>
      (runwayCheck.run(doc, {}).data as { maxUtilisation: number }).maxUtilisation;
    expect(max(metres)).toBeCloseTo(max(hall()), 6);
  });
});
