/** Plant 01 PSC M1: catalogue lookup and listing (VC-PSC-01, 03, 04, 06, 12, 13, 18) read from the validation pack. */

import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { dnToNps, npsToDn, parseDn, parseNps, sizePair } from '@aec/plant/catalog/nominal';
import { data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { packJson, type PipePackRow } from './packData';

const doc = createEmptyDocument();
type Row = Record<string, unknown>;
type Dims = Record<string, { derived?: boolean; formula?: string }>;
const lookup = (params: Record<string, unknown>): Row => data<Row>(doc, 'lookup_piping_component', params);
const near = (actual: unknown, expected: number, tolerance = 1e-6): void =>
  expect(Math.abs((actual as number) - expected)).toBeLessThanOrEqual(tolerance);

describe('nominal sizes (TR-PSC-01)', () => {
  it('parses NPS designations exactly and canonically', () => {
    expect(parseNps('2-1/2')).toEqual({ system: 'NPS', key: '2-1/2', value: 2.5 });
    expect(parseNps(2.5)?.key).toBe('2-1/2');
    expect(parseNps('2 1/2')?.key).toBe('2-1/2');
    expect(parseNps('4/8')?.key).toBe('1/2');
    expect(parseNps(0.125)?.key).toBe('1/8');
    expect(parseNps(24)?.key).toBe('24');
  });

  it('refuses what is not a size', () => {
    for (const bad of ['', 'abc', '0', '1/0', -1, 0, 2.3, Number.NaN]) expect(parseNps(bad)).toBeNull();
    expect(parseDn('1.5')).toBeNull();
    expect(parseDn(0)).toBeNull();
    expect(sizePair({})).toBeNull();
    expect(sizePair({ dn: 'x' })).toBeNull();
  });

  it('maps DN <-> NPS both ways (ISO 6708 / B36.10M pairing)', () => {
    const pairs: Array<[string, number]> = [
      ['1/2', 15],
      ['3/4', 20],
      ['1', 25],
      ['1-1/4', 32],
      ['1-1/2', 40],
      ['2', 50],
      ['2-1/2', 65],
      ['3', 80],
      ['3-1/2', 90],
      ['4', 100],
      ['5', 125],
      ['6', 150],
      ['24', 600],
    ];
    for (const [nps, dn] of pairs) {
      expect(npsToDn(parseNps(nps)!)?.value).toBe(dn);
      expect(dnToNps(parseDn(dn)!)?.key).toBe(nps);
    }
    expect(npsToDn(parseNps('4-1/2')!)).toBeNull();
    expect(dnToNps(parseDn(110)!)).toBeNull();
  });
});

describe('lookup_piping_component: pipe (VC-PSC-01, VC-PSC-18)', () => {
  it('returns NPS 6 Sch 40 = 168.3 / 7.11 mm, ID derived, verified', () => {
    const row = lookup({ type: 'pipe', nps: 6, schedule: '40', standard: 'ASME B36.10M' });
    near(row['outsideDiameterMm'], 168.3);
    near(row['wallMm'], 7.11);
    near(row['insideDiameterMm'], 154.08);
    expect(row['verified']).toBe(true);
    expect((row['dims'] as Dims)['insideDiameter']?.derived).toBe(true);
  });

  it('reproduces every row of the pack exactly (382 rows) with verified = grade A (86 rows)', () => {
    const rows = packJson<{ rows: PipePackRow[] }>('asme_b36_pipe_schedules.json').rows;
    let verifiedRows = 0;
    for (const pack of rows) {
      const answer = lookup({ type: 'pipe', nps: pack.nps, schedule: pack.schedule, standard: pack.standard });
      expect(answer['outsideDiameterMm'], `${pack.standard} NPS ${pack.nps} ${pack.schedule}`).toBe(pack.odMm);
      expect(answer['wallMm']).toBe(pack.wallMm);
      expect(answer['verified']).toBe(pack.grade === 'A');
      if (pack.grade === 'A') verifiedRows += 1;
    }
    expect(rows).toHaveLength(382);
    expect(verifiedRows).toBe(86);
  });

  it('accepts DN and numeric NPS for the same row', () => {
    expect(lookup({ type: 'pipe', dn: 150, schedule: '40' })['wallMm']).toBe(7.11);
    expect(lookup({ type: 'pipe', nps: '2-1/2', schedule: '40' })['wallMm']).toBe(5.16);
    expect(lookup({ type: 'pipe', nps: 2.5, schedule: '40' })['outsideDiameterMm']).toBe(73);
  });

  it('keeps Sch 10 (B36.10M) and 10S (B36.19M) distinct at NPS 14 and says which standard answered', () => {
    const sch10 = lookup({ type: 'pipe', nps: 14, schedule: '10' });
    const sch10s = lookup({ type: 'pipe', nps: 14, schedule: '10S' });
    expect(sch10['wallMm']).toBe(6.35);
    expect(sch10['standard']).toBe('ASME B36.10M');
    expect(sch10['note']).toContain('B36.10M');
    expect(sch10s['wallMm']).toBe(4.78);
    expect(sch10s['standard']).toBe('ASME B36.19M');
    expect(lookup({ type: 'pipe', nps: 14, schedule: '10S', standard: 'B36.19M' })['wallMm']).toBe(4.78);
  });

  it('refuses a pipe without schedule as ambiguous, an unknown schedule, size or catalogue, with codes', () => {
    const ambiguous = expectRefusal(doc, 'lookup_piping_component', { type: 'pipe', nps: 6 }, 'PSC_AMBIGUOUS_COMPONENT');
    expect(ambiguous.summary).toContain('sch 40');
    const unknownSchedule = expectRefusal(
      doc,
      'lookup_piping_component',
      { type: 'pipe', nps: 6, schedule: '999' },
      'PSC_SCHEDULE_UNKNOWN',
    );
    expect(unknownSchedule.summary).toContain('schedules there');
    expectRefusal(doc, 'lookup_piping_component', { type: 'pipe', nps: 'six', schedule: '40' }, 'PSC_SIZE_UNKNOWN');
    expectRefusal(doc, 'lookup_piping_component', { type: 'pipe', schedule: '40' }, 'PSC_SIZE_UNKNOWN');
    expectRefusal(doc, 'lookup_piping_component', { type: 'pipe', nps: 6, smallNps: 'x', schedule: '40' }, 'PSC_SIZE_UNKNOWN');
    expectRefusal(doc, 'lookup_piping_component', { type: 'pipe', nps: 99, schedule: '40' }, 'PSC_CATALOG_ROW_MISSING');
    expectRefusal(doc, 'lookup_piping_component', { type: 'cap', nps: 6 }, 'PSC_CATALOG_ROW_MISSING');
    expectRefusal(doc, 'lookup_piping_component', { catalogId: 'nope', type: 'pipe', nps: 6 }, 'PSC_CATALOG_UNKNOWN', 'catalogId');
    expectRefusal(doc, 'lookup_piping_component', { catalogId: 'llull-open-piping@9.9', type: 'pipe', nps: 6 }, 'PSC_CATALOG_UNKNOWN');
  });

  it('is pure', () => {
    expectPure(doc, () => lookup({ type: 'pipe', nps: 6, schedule: '40' }));
  });
});

describe('lookup_piping_component: fittings (VC-PSC-03, VC-PSC-04)', () => {
  const b169 = packJson<{ lr90: Row[]; lr45: Row[] }>('asme_b16_9_buttweld_fittings.json');

  it('returns the LR 90 centre-to-end of the pack (2 / 4 / 6 in = 76.2 / 152.4 / 228.6 mm), verified, not derived', () => {
    for (const pack of b169.lr90) {
      const row = lookup({ type: 'elbow90', radius: 'LR', nps: pack['nps'] });
      near(row['centreToEndMm'], pack['mm'] as number, 0.01);
      expect(row['verified']).toBe(true);
      expect((row['dims'] as Dims)['centreToEnd']?.derived).toBeUndefined();
    }
  });

  it('returns the LR 45 rows (4 / 6 in = 63.5 / 95.25 mm)', () => {
    for (const pack of b169.lr45)
      near(lookup({ type: 'elbow45', radius: 'LR', nps: pack['nps'] })['centreToEndMm'], pack['mm'] as number, 0.01);
  });

  it('derives a missing LR 90 size from the 1.5 x NPS rule and flags it derived', () => {
    const row = lookup({ type: 'elbow90', radius: 'LR', nps: 8 });
    near(row['centreToEndMm'], 304.8, 0.01);
    const dim = (row['dims'] as Dims)['centreToEnd'];
    expect(dim?.derived).toBe(true);
    expect(dim?.formula).toContain('1.5');
    expect(row['note']).toContain('derived');
    expect(lookup({ type: 'elbow90', radius: 'SR', nps: 4 })['verified']).toBe(false);
    expectRefusal(doc, 'lookup_piping_component', { type: 'elbow90', radius: 'LR', nps: '1/2' }, 'PSC_CATALOG_ROW_MISSING');
  });

  it('returns concentric reducer lengths (NPS 4 x 2 = 102, NPS 8 x 6 = 152 mm)', () => {
    near(lookup({ type: 'reducerConcentric', nps: 4, smallNps: 2 })['lengthMm'], 102, 0.5);
    near(lookup({ type: 'reducerConcentric', nps: 8, smallNps: 6 })['lengthMm'], 152, 0.5);
    expect(lookup({ type: 'reducerConcentric', nps: 6 })['verified']).toBe(false);
  });

  it('flags a grade-B row unverified with PSC_DATA_UNVERIFIED', () => {
    const row = lookup({ type: 'tee', nps: 4 });
    expect(row['verified']).toBe(false);
    expect((row['warnings'] as Array<{ code: string }>)[0]?.code).toBe('PSC_DATA_UNVERIFIED');
    expect(ok(doc, 'lookup_piping_component', { type: 'tee', nps: 4 }).summary).toContain('UNVERIFIED');
  });
});

describe('lookup_piping_component: flanges, gaskets, valves (VC-PSC-06, 12, 13, 14)', () => {
  it('returns the NPS 4 Class 150 WN RF flange: OD 228.6, bolt circle 190.5, 8 x 5/8 in, hole 19.05 (derived)', () => {
    const row = lookup({ type: 'flangeWeldNeck', nps: 4, class: 150, facing: 'RF' });
    near(row['outsideDiameterMm'], 228.6, 0.01);
    near(row['boltCircleMm'], 190.5, 0.01);
    expect(row['boltCount']).toBe(8);
    expect(row['boltDiameterIn']).toBe('5/8');
    near(row['boltHoleMm'], 19.05, 0.01);
    expect(row['verified']).toBe(true);
    expect((row['dims'] as Dims)['boltHole']?.derived).toBe(true);
  });

  it('reproduces bolt count, bolt diameter and OD on all 24 pack rows; only NPS 4 Class 150 is verified', () => {
    const rows = packJson<{ rows: Row[] }>('asme_b16_5_wn_rf_flanges.json').rows;
    expect(rows).toHaveLength(24);
    for (const pack of rows) {
      const row = lookup({ type: 'flangeWeldNeck', nps: pack['nps'], class: pack['class'], standard: 'B16.5' });
      expect(row['boltCount']).toBe(pack['boltCount']);
      expect(row['boltDiameterIn']).toBe(pack['boltDiameterIn']);
      near(row['outsideDiameterMm'], pack['flangeOdMm'] as number);
      expect(row['verified']).toBe(pack['nps'] === '4' && pack['class'] === 150);
    }
  });

  it('flags the NPS 6 Class 600 flange thickness (sources 47.8 vs 47.6) unverified', () => {
    expect(lookup({ type: 'flangeWeldNeck', nps: 6, class: 600 })['unverifiedDims']).toContain('thickness');
  });

  it('returns the spiral-wound gasket NPS 4 Class 150 (inner ring 106.4, centering ring 174.8; sealing element 149.4 unverified)', () => {
    const row = lookup({ type: 'gasketSpiralWound', nps: 4, class: 150 });
    near(row['innerRingIdMm'], 106.4, 0.05);
    near(row['centeringRingOdMm'], 174.8, 0.05);
    near(row['sealingElementOdMm'], 149.4, 0.05);
    expect(row['unverifiedDims']).toEqual(['sealingElementOd']);
    expect(row['verified']).toBe(false);
  });

  it('returns B16.10 Class 150 gate valve face-to-face 178 / 229 / 267 mm', () => {
    const expected: Array<[number, number]> = [
      [2, 178],
      [4, 229],
      [6, 267],
    ];
    for (const [nps, mm] of expected)
      near(lookup({ type: 'valveGate', nps, class: 150, ends: 'FL', facing: 'RF' })['faceToFaceMm'], mm, 0.5);
  });

  it('returns the EN 1092-1 PN16 DN100 flange (D 220, K 180, unverified holes) and refuses an unlisted PN', () => {
    const row = lookup({ type: 'flangeWeldNeck', standard: 'EN 1092-1', dn: 100, pn: 16 });
    near(row['outsideDiameterMm'], 220, 0.01);
    near(row['boltCircleMm'], 180, 0.01);
    expect(row['dimensionalStandard']).toBe('EN');
    expect(row['unverifiedDims']).toEqual(['boltCount', 'boltHole']);
    near(lookup({ type: 'flangeWeldNeck', standard: 'EN 1092-1', dn: 100, pn: 40 })['thicknessMm'], 24, 0.01);
    expectRefusal(
      doc,
      'lookup_piping_component',
      { type: 'flangeWeldNeck', standard: 'EN 1092-1', dn: 100, pn: 25 },
      'PSC_CATALOG_ROW_MISSING',
    );
  });
});

describe('list_piping_catalogs', () => {
  interface Listed {
    catalogs: Array<{
      id: string;
      origin: string;
      families: Array<{ id: string; type: string; schedules?: string[]; verifiedValues: number; totalValues: number }>;
    }>;
    importOnly: string[];
    ratingTables: unknown[];
  }

  it('lists the bundled catalogue with families, trust counts and the import-only standards', () => {
    const listed = data<Listed>(doc, 'list_piping_catalogs', {});
    expect(listed.catalogs.map((c) => c.id)).toEqual(['llull-open-piping']);
    expect(listed.catalogs[0]?.origin).toBe('bundled');
    const pipe = listed.catalogs[0]?.families.find((f) => f.id === 'asme-b36.10m');
    expect(pipe?.schedules).toContain('STD');
    expect(pipe?.verifiedValues).toBeLessThan(pipe?.totalValues ?? 0);
    expect(listed.importOnly.join(' ')).toContain('B16.11');
    expect(listed.ratingTables).toHaveLength(1);
  });

  it('filters by type and standard, and refuses an unknown catalogue', () => {
    const only = data<Listed>(doc, 'list_piping_catalogs', { type: 'elbow90', standard: 'b16.9' });
    expect(only.catalogs[0]?.families.map((f) => f.type)).toEqual(['elbow90', 'elbow90']);
    expectRefusal(doc, 'list_piping_catalogs', { catalogId: 'nope' }, 'PSC_CATALOG_UNKNOWN', 'catalogId');
  });

  it('is pure', () => {
    expectPure(doc, () => ok(doc, 'list_piping_catalogs', {}));
  });
});
