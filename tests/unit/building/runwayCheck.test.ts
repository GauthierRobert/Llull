import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { GRAVITY } from '@aec/numeric';
import { runwayCheck } from '@aec/industrial/runwayCheckRun';
import {
  bufferForce,
  wheelMoment,
  wheelShear,
  type RunwayCheckRow,
} from '@aec/industrial/runwayCheckModel';
import { craneActions } from '@aec/industrial/frameModelTypes';

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
    expect(data.rows.length % 12).toBe(0);
    for (const kind of ['strength', 'ltb', 'deflection', 'fatigue', 'local']) {
      expect(data.rows.some((row) => row.kind === kind)).toBe(true);
    }
    expect(find(data.rows, 'deflection', 'vertical').unit).toBe('mm');
    expect(find(data.rows, 'deflection', 'lateral').limit).toBeGreaterThan(0);
    for (const row of data.rows.filter((candidate) => !candidate.check.includes('longitudinal'))) {
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

  it('applies the EN 1991-3 load groups: hoisting class, hook approach, HT / HS and HL', () => {
    const doc = hall();
    const base = rowsOf(doc);
    const longitudinal = find(base, 'strength', 'longitudinal');
    // HL = φ5 K / nr (K = 0.2 Rmin), checked as 1.35 HL axial force against Npl.
    const actions = craneActions(10, 22610);
    expect(longitudinal.value).toBeCloseTo(1.35 * actions.group1.longitudinal, -1);
    expect(longitudinal.check).toMatch(/HL \d+(\.\d)? kN, φ2 1\.134/);
    expect(longitudinal.utilisation).toBeLessThan(0.05);
    const hc4 = rowsOf(doc, { hoistingClass: 'HC4', hoistingSpeed: 0.5 });
    expect(find(hc4, 'strength', 'bending').value).toBeGreaterThan(
      find(base, 'strength', 'bending').value,
    );
    expect(find(hc4, 'strength', 'longitudinal').check).toContain('φ2 1.54');
    const far = rowsOf(doc, { minHookApproach: 5 });
    expect(find(far, 'strength', 'shear').value).toBeLessThan(
      find(base, 'strength', 'shear').value,
    );
    const spanned = rowsOf(doc, { craneSpan: 12000, craneSelfWeight: 30 });
    expect(find(spanned, 'strength', 'shear').value).not.toBe(
      find(base, 'strength', 'shear').value,
    );
  });

  it('falls back to a 20 m bridge span for a runway without a paired beam', () => {
    const doc = hall();
    const kept = Object.values(doc.building!.elements).filter(
      (element) =>
        !(element.category === 'member' && element.role === 'crane' && element.start[0] > 10000),
    );
    const single = {
      ...doc,
      building: { ...doc.building!, elements: Object.fromEntries(kept.map((e) => [e.id, e])) },
    };
    const actions = craneActions(10, 20000);
    const lonely = rowsOf(single);
    expect(find(lonely, 'strength', 'longitudinal').value).toBeCloseTo(
      1.35 * actions.group1.longitudinal,
      -1,
    );
  });

  it('is a graceful no-op for bad input', () => {
    const doc = hall();
    for (const params of [
      { craneCapacity: -1 },
      { craneCapacity: Number.NaN },
      { wheelBase: 0 },
      { hoistingSpeed: -1 },
      { minHookApproach: -1 },
      { craneSpan: 0 },
      { craneSelfWeight: 0 },
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

describe('local wheel stresses (EN 1993-6 §5.7.1)', () => {
  const stress = (rows: RunwayCheckRow[]): RunwayCheckRow => find(rows, 'local', 'σoz');
  const fatigue = (rows: RunwayCheckRow[]): RunwayCheckRow => find(rows, 'local', 'fatigue');

  it('matches a hand calculation for HEB300 + A55', () => {
    const rows = rowsOf(hall());
    expect(rows[0]?.profile).toBe('HEB300');
    // beff = min(300, 150+65+19) = 234; If = 139*19^3/12; Irf = 0.75*1.78e6 + If; leff = 3.25 (Irf/11)^(1/3)
    const irf = 0.75 * 1.78e6 + (234 * 19 ** 3) / 12;
    const leff = 3.25 * (irf / 11) ** (1 / 3);
    expect(leff).toBeCloseTo(166.1, 0);
    // Paired runway beams at x = 695 / 23305 mm: bridge span 22610 mm.
    const wheel = craneActions(10, 22610).group1.max / 2;
    const sigma = (1.35 * wheel) / (leff * 11);
    expect(stress(rows).value).toBeCloseTo(sigma, 1);
    expect(stress(rows).limit).toBe(355);
    expect(stress(rows).check).toContain('leff 166 mm');
    expect(stress(rows).check).toContain('EN 1993-6 §5.7.1');
  });

  it('lowers σoz with a heavier rail', () => {
    const doc = hall();
    const light = stress(rowsOf(doc, { railSize: 'flat50x30' })).value;
    const heavy = stress(rowsOf(doc, { railSize: 'A100' })).value;
    expect(heavy).toBeLessThan(light);
  });

  it('uses category 71 / 36 for welded girders, raising the local fatigue utilisation', () => {
    const doc = hall();
    const rolled = fatigue(rowsOf(doc));
    const full = fatigue(rowsOf(doc, { girder: 'welded-full' }));
    const fillet = fatigue(rowsOf(doc, { girder: 'welded-fillet' }));
    expect(rolled.check).toContain('cat 160');
    expect(full.check).toContain('cat 71');
    expect(fillet.check).toContain('cat 36');
    expect(full.utilisation / rolled.utilisation).toBeCloseTo(160 / 71, 1);
    expect(fillet.utilisation / rolled.utilisation).toBeCloseTo(160 / 36, 1);
  });

  it('passes the local checks for a 32 t crane on HEB300 (the beam fails elsewhere)', () => {
    // 32 t: σoz ≈ 158 N/mm² vs fy 355 (util ~0.45): the 11 mm web is not governing; LTB is.
    const rows = rowsOf(hall(), { craneCapacity: 32 });
    expect(stress(rows).utilisation).toBeGreaterThan(0.4);
    expect(stress(rows).utilisation).toBeLessThan(1);
    expect(fatigue(rows).utilisation).toBeLessThan(1);
    expect(find(rows, 'ltb').utilisation).toBeGreaterThan(1);
  });

  it('rejects enum values outside the schema', () => {
    const doc = hall();
    for (const params of [
      { girder: 'cast' },
      { railSize: 'X9' },
      { craneClass: 'S9' },
      { hoistingClass: 'HC9' },
    ]) {
      const result = execute(doc, 'check_crane_runways', params);
      expect(result.document).toBe(doc);
      expect(result.summary).toMatch(/^check_crane_runways rejected: invalid params/);
    }
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

describe('check_crane_runways longitudinal actions (EN 1991-3 groups 7 and 8)', () => {
  it('hand-checks HB,1 = φ7 v1 √(mc SB) for a 10 t crane', () => {
    // Gc = 0.5·98.0665 + 20 = 69.03 kN, mc = Gc / g, v1 = 0.7·0.63, SB = 1000 kN/m
    const expected = 1.25 * 0.441 * Math.sqrt((69033.25 / GRAVITY) * 1e6);
    expect(bufferForce(69033.25, 0.63, 1000)).toBeCloseTo(expected, 6);
    expect(bufferForce(69033.25, 0.63, 1000)).toBeCloseTo(46250, -1);
    const rows = rowsOf(hall());
    const stop = find(rows, 'strength', 'buffer stop HB,1/nr');
    expect(stop.value).toBeCloseTo(expected / 2, -1);
    expect(stop.check).toContain('SB 1000 kN/m');
    expect(stop.utilisation).toBeGreaterThan(0);
    expect(stop.utilisation).toBeLessThan(1);
    expect(find(rows, 'strength', 'buffer end-bay').utilisation).toBeGreaterThan(0);
    expect(rows.some((row) => row.check.startsWith('longitudinal stop force'))).toBe(true);
  });

  it('scales the buffer rows with travelSpeed and bufferStiffness', () => {
    const doc = hall();
    const slow = find(rowsOf(doc, { travelSpeed: 0.3 }), 'strength', 'buffer stop').value;
    const fast = find(rowsOf(doc, { travelSpeed: 0.6 }), 'strength', 'buffer stop').value;
    expect(fast / slow).toBeCloseTo(2, 2);
    const soft = find(rowsOf(doc, { bufferStiffness: 250 }), 'strength', 'buffer stop').value;
    const stiff = find(rowsOf(doc, { bufferStiffness: 1000 }), 'strength', 'buffer stop').value;
    expect(stiff / soft).toBeCloseTo(2, 2);
    const eccSlow = find(rowsOf(doc, { travelSpeed: 0.3 }), 'strength', 'buffer end-bay');
    const eccFast = find(rowsOf(doc, { travelSpeed: 0.6 }), 'strength', 'buffer end-bay');
    expect(eccFast.utilisation).toBeGreaterThan(eccSlow.utilisation);
  });

  it('adds a test load bending row governed by max(φ6·1.1, 1.25) Qh with γ 1.1', () => {
    const rows = rowsOf(hall());
    const test = find(rows, 'strength', 'test load');
    expect(test.check).toContain('γ 1.1');
    expect(test.check).toContain('Qtest 1.25 Qh');
    expect(test.utilisation).toBeGreaterThan(0.05);
    expect(test.utilisation).toBeLessThan(1);
    const heavier = find(rowsOf(hall(), { craneCapacity: 16 }), 'strength', 'test load');
    expect(heavier.utilisation).toBeGreaterThan(test.utilisation);
  });

  it('is a no-op on bad travelSpeed / bufferStiffness', () => {
    const doc = hall();
    for (const params of [
      { travelSpeed: 0 },
      { travelSpeed: -1 },
      { bufferStiffness: 0 },
      { bufferStiffness: Number.NaN },
    ]) {
      const result = runwayCheck.run(doc, params);
      expect(result.document).toBe(doc);
      expect(result.affected).toEqual([]);
      expect(result.data).toBeUndefined();
      expect(result.summary).toMatch(/failed/);
    }
  });
});
