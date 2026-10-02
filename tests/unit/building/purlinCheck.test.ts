import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { findProfile } from '@core/commands/building/steel/profiles';
import {
  checkPurlins,
  effectiveModulusRatio,
  type PurlinRow,
  type ZoneSummary,
} from '@core/commands/building/industrial/purlinCheck';
import { __resetIdCounter } from '@lib/id';

interface PurlinData {
  rows: PurlinRow[];
  csv: string;
  maxUtilisation: number;
  failures: string[];
  zones: ZoneSummary[];
}

function hall(params: Record<string, unknown> = {}, base = createEmptyDocument()): CadDocument {
  return execute(base, 'add_portal_frame_building', { span: 24000, length: 30000, ...params })
    .document;
}

function check(doc: CadDocument, params: Record<string, unknown> = {}): PurlinData {
  return checkPurlins.run(doc, params).data as PurlinData;
}

function withoutRoles(doc: CadDocument, roles: readonly string[]): CadDocument {
  const building = doc.building;
  if (!building) throw new Error('no building');
  const elements = Object.fromEntries(
    Object.entries(building.elements).filter(
      ([, element]) => !(element.category === 'member' && roles.includes(element.role)),
    ),
  );
  return {
    ...doc,
    building: {
      ...building,
      elements,
      elementOrder: building.elementOrder.filter((id) => id in elements),
    },
  };
}

function withProfile(doc: CadDocument, role: string, profile: string): CadDocument {
  const building = doc.building;
  if (!building) throw new Error('no building');
  const elements = Object.fromEntries(
    Object.entries(building.elements).map(([id, element]) => [
      id,
      element.category === 'member' && element.role === role ? { ...element, profile } : element,
    ]),
  );
  return { ...doc, building: { ...building, elements } };
}

const purlinsOf = (data: PurlinData): PurlinRow[] =>
  data.rows.filter((row) => row.kind === 'purlin');
const railsOf = (data: PurlinData): PurlinRow[] => data.rows.filter((row) => row.kind === 'rail');
const uplift = (row: PurlinRow): number => row.upliftUtilisation ?? 0;
/** Interior purlins carry a full tributary width (edge purlins carry half). */
const interior = (rows: PurlinRow[]): PurlinRow[] =>
  rows.filter((row) => row.check.includes('tributary 1724'));

beforeEach(() => __resetIdCounter());

describe('effectiveModulusRatio', () => {
  it('reduces a slender C, keeps C200x75x2.5 fully effective and a stocky section gross', () => {
    const base = findProfile('C200x75x2.5');
    if (!base) throw new Error('profile');
    // hand check C200x75x2.5, S350: eps 0.819; flange lp = 28 / 46.5 = 0.60 (<0.673, rho 1);
    // web lp = 79 / 113.7 = 0.695 -> rho = (0.695 - 0.11) / 0.695^2 = 1.2 -> 1: fully effective
    expect(effectiveModulusRatio(base, 350)).toEqual({ ratio: 1, flangeRho: 1, webRho: 1 });
    // slender: t = 1.2: flange lp 1.30 -> rho 0.64 x 0.9, web lp 1.46 -> rho 0.64
    const slender = effectiveModulusRatio({ ...base, tw: 1.2, tf: 1.2 }, 350);
    expect(slender.flangeRho).toBeCloseTo(0.57, 2);
    expect(slender.webRho).toBeCloseTo(0.64, 1);
    expect(slender.ratio).toBeLessThan(0.95);
    expect(slender.ratio).toBeGreaterThan(0.6);
    const stocky = effectiveModulusRatio({ ...base, tw: 10, tf: 10 }, 235);
    expect(stocky.ratio).toBeCloseTo(1, 6);
  });

  it('lowers the resistance of a slender purlin in check_purlins', () => {
    const base = findProfile('C200x75x2.5');
    if (!base) throw new Error('profile');
    expect(effectiveModulusRatio(base, 460).ratio).toBeLessThanOrEqual(1);
    const doc = hall({ purlinProfile: 'C150x65x2.0' });
    expect(check(doc).rows.length).toBeGreaterThan(0);
  });
});

describe('check_purlins', () => {
  it('checks the default hall without touching the document', () => {
    const doc = hall();
    const snapshot = JSON.stringify(doc);
    const result = checkPurlins.run(doc, {});
    expect(JSON.stringify(doc)).toBe(snapshot);
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(checkPurlins.annotations).toEqual({ readOnly: true, idempotent: true });
    const data = result.data as PurlinData;
    // 5 bays x 2 slopes x 8 purlins, 5 bays x 2 walls x 3 rail rows
    expect(purlinsOf(data)).toHaveLength(80);
    expect(railsOf(data)).toHaveLength(30);
    expect(data.rows).toHaveLength(110);
    for (const row of purlinsOf(data)) {
      expect(row.span).toBeCloseTo(6, 3);
      expect(row.utilisation).toBeGreaterThan(0);
      expect(row.utilisation).toBeLessThan(1);
    }
    expect(data.csv.split('\n')[0]).toContain('Utilisation');
    expect(data.csv.trim().split('\n')).toHaveLength(111);
    expect(result.summary).toContain('80 purlin(s), 30 rail(s)');
    expect(result.summary).toMatch(/max utilisation purlins [\d.]+, rails [\d.]+/);
  });

  it('puts edge purlins in zones F / G and the middle in I with growing uplift', () => {
    const data = check(hall());
    expect(data.zones.map((zone) => `${zone.surface}:${zone.zone}`)).toEqual(
      expect.arrayContaining(['roof:F', 'roof:G', 'roof:H', 'roof:I']),
    );
    const cpes = (zone: string): number[] =>
      data.zones
        .filter((entry) => entry.surface === 'roof' && entry.zone === zone)
        .map((entry) => entry.cpe);
    // 6° pitch, Tab. 7.4a across the ridge: F -1.62 / G -1.16; Tab. 7.4b along it: F -1.57 / G -1.3 / H -0.69 / I -0.59
    expect(cpes('F')).toContain(-1.62);
    expect(cpes('G')).toEqual(expect.arrayContaining([-1.16]));
    expect(cpes('I')).toContain(-0.59);
    expect(Math.min(...cpes('G'))).toBeGreaterThanOrEqual(-1.3);
    const zoneRows = (zone: string): PurlinRow[] =>
      interior(purlinsOf(data)).filter((row) => row.zone === zone);
    const maxUplift = (zone: string): number => Math.max(...zoneRows(zone).map(uplift));
    expect(maxUplift('F')).toBeGreaterThan(maxUplift('G'));
    expect(maxUplift('G')).toBeGreaterThan(maxUplift('I'));
    // the eaves line of the end bay is corner zone F; an interior bay middle purlin is I
    const mark = (row: PurlinRow): number => Number(row.mark.replace(/\D/g, ''));
    const first = purlinsOf(data).find((row) => mark(row) === 1);
    expect(first?.zone).toBe('F');
  });

  it('is governed by snow at low wind and by uplift at high wind', () => {
    const doc = hall();
    const calm = purlinsOf(check(doc, { windPressure: 0.05 }));
    for (const row of calm) expect(uplift(row)).toBeLessThan(row.utilisation);
    expect(calm.every((row) => !row.combination.includes('W'))).toBe(true);
    const storm = purlinsOf(check(doc, { windPressure: 2.5 }));
    const stormy = storm.filter((row) => row.combination === '1.5W-1.0G');
    expect(stormy.length).toBeGreaterThan(0);
    expect(Math.max(...storm.map(uplift))).toBeGreaterThan(1);
    const noWind = purlinsOf(check(doc, { windPressure: 0 }));
    expect(noWind.every((row) => uplift(row) === 0)).toBe(true);
    const snowy = Math.max(
      ...purlinsOf(check(doc, { windPressure: 0, snowLoad: 2 })).map((row) => row.utilisation),
    );
    expect(snowy).toBeGreaterThan(Math.max(...noWind.map((row) => row.utilisation)));
  });

  it('fails a lighter purlin profile and passes a heavier one', () => {
    const light = check(hall({ purlinProfile: 'C150x65x2.0' }), { windPressure: 1 });
    expect(light.failures.length).toBeGreaterThan(0);
    expect(light.maxUtilisation).toBeGreaterThan(1);
    const result = checkPurlins.run(hall({ purlinProfile: 'C150x65x2.0' }), { windPressure: 1 });
    expect(result.summary).toMatch(/failure\(s\): PU\d+ purlin/);
    const heavy = check(hall({ purlinProfile: 'C300x90x3.0' }), { windPressure: 1 });
    expect(Math.max(...purlinsOf(heavy).map((row) => row.utilisation))).toBeLessThan(
      Math.max(...purlinsOf(light).map((row) => row.utilisation)),
    );
  });

  it('uses the lateral-torsional reduction of an I-section purlin', () => {
    const data = check(withProfile(hall(), 'purlin', 'IPE200'), { windPressure: 1.5 });
    const row = purlinsOf(data)[0];
    expect(row?.upliftUtilisation).toBeGreaterThan(0);
  });

  it('checks side rails with wall zones A / B / D', () => {
    const data = check(hall());
    const rails = railsOf(data);
    expect(rails.every((row) => row.mark.startsWith('SR'))).toBe(true);
    const wall = data.zones.filter((zone) => zone.surface === 'wall');
    expect(wall.map((zone) => zone.zone)).toEqual(expect.arrayContaining(['A', 'B']));
    expect(wall.find((zone) => zone.zone === 'A')?.cpe).toBe(-1.2);
    expect(wall.find((zone) => zone.zone === 'B')?.cpe).toBe(-0.8);
    const slim = railsOf(check(hall({ railProfile: 'C150x65x2.0' })));
    expect(slim.some((row) => row.check.includes('span/150'))).toBe(true);
    const lighter = railsOf(check(hall({ railProfile: 'C300x90x3.0' })));
    expect(Math.max(...lighter.map((row) => row.utilisation))).toBeLessThan(
      Math.max(...rails.map((row) => row.utilisation)),
    );
  });

  it('reduces rail bending resistance under suction (free inner flange) but not under pressure', () => {
    const rails = railsOf(check(hall(), { windPressure: 3 }));
    const suction = rails.filter((row) => row.zone !== 'D');
    expect(suction.length).toBeGreaterThan(0);
    // cold-formed C: simplified χ = 0.75 (span <= 6 m) or 0.6 (> 6 m)
    expect(suction.some((row) => /free flange\) \(χ 0\.(6|75)/.test(row.check))).toBe(true);
    const pressureOnly = railsOf(
      check(hall({ length: 6000, baySpacing: 6000 }), { windPressure: 3 }),
    );
    expect(pressureOnly.length).toBeGreaterThan(0);
  });

  it('classifies wall zone B and C on a long hall', () => {
    const data = check(hall({ length: 60000, baySpacing: 6000 }));
    const zones = data.zones.filter((zone) => zone.surface === 'wall').map((zone) => zone.zone);
    expect(zones).toEqual(expect.arrayContaining(['A', 'B']));
    const walls = railsOf(data);
    expect(new Set(walls.map((row) => row.zone)).size).toBeGreaterThan(1);
  });

  it('gives the same result in a metre-unit document', () => {
    const millimetres = check(hall());
    const metre = check(
      hall(
        {
          span: 24,
          length: 30,
          baySpacing: 6,
          purlinSpacing: 1.8,
          railSpacing: 1.8,
          eaveHeight: 7,
        },
        {
          ...createEmptyDocument(),
          units: 'm',
        },
      ),
    );
    expect(metre.rows).toHaveLength(millimetres.rows.length);
    expect(metre.maxUtilisation).toBeCloseTo(millimetres.maxUtilisation, 6);
    const counts = (data: PurlinData): string[] =>
      data.zones.map((zone) => `${zone.surface}${zone.zone}${zone.members}`);
    expect(counts(metre)).toEqual(counts(millimetres));
  });

  it('handles a flat roof, a multi-span hall and a hall without rafters', () => {
    const flat = check(hall({ roofPitch: 0 }));
    expect(purlinsOf(flat).length).toBeGreaterThan(0);
    const multi = check(hall({ spans: [18000, 18000] }));
    expect(purlinsOf(multi).length).toBeGreaterThan(80);
    const bare = check(withoutRoles(hall(), ['rafter']));
    expect(railsOf(bare)).toHaveLength(30);
  });

  it('uses a default tributary width for a lone purlin row', () => {
    const doc = withoutRoles(hall({ purlinSpacing: 30000, span: 2000 }), ['rail']);
    const data = check(doc);
    expect(purlinsOf(data).length).toBeGreaterThan(0);
  });

  it('reports a purlin check without rails', () => {
    const data = check(withoutRoles(hall(), ['rail']));
    expect(railsOf(data)).toHaveLength(0);
    expect(purlinsOf(data)).toHaveLength(80);
  });

  it('skips members with an unknown profile and says so', () => {
    const result = checkPurlins.run(withProfile(hall(), 'rail', 'NOPE'), {});
    expect(result.summary).toContain('Not checked: SR1');
    expect((result.data as PurlinData).rows.some((row) => row.kind === 'rail')).toBe(false);
  });

  it('is a no-op on bad input, an unknown level or a doc without purlins', () => {
    const doc = hall();
    for (const bad of [
      { windPressure: -1 },
      { snowLoad: Number.NaN },
      { roofDeadLoad: -0.1 },
      { windPressure: '1' as unknown as number },
    ]) {
      const result = checkPurlins.run(doc, bad);
      expect(result.document).toBe(doc);
      expect(result.affected).toEqual([]);
      expect(result.data).toBeUndefined();
      expect(result.summary).toContain('check_purlins failed');
    }
    const level = checkPurlins.run(doc, { levelId: 'nope' });
    expect(level.summary).toContain("no level 'nope'");
    expect(level.data).toBeUndefined();
    const empty = checkPurlins.run(createEmptyDocument(), {});
    expect(empty.document).toBeDefined();
    expect(empty.data).toBeUndefined();
    expect(empty.summary).toContain('no level');
    const stripped = checkPurlins.run(withoutRoles(doc, ['purlin']), {});
    expect(stripped.data).toBeUndefined();
    expect(stripped.summary).toContain('no purlins');
  });

  it('is exposed through the registry', () => {
    const doc = hall();
    const result = execute(doc, 'check_purlins', {});
    expect(result.document).toBe(doc);
  });
});

describe('multi-span roof wind (EN 1991-1-4 Fig. 7.10 simplified)', () => {
  const rowAt = (doc: CadDocument, data: PurlinData, x: number, y: number): PurlinRow => {
    const elements = doc.building!.elements;
    const found = data.rows.find((row) => {
      const element = elements[row.elementId];
      return (
        element?.category === 'member' &&
        Math.abs(element.start[0] - x) < 20 &&
        Math.abs(element.start[1] - y) < 20
      );
    });
    if (!found) throw new Error(`no purlin at x ${x}, y ${y}`);
    return found;
  };

  it('reduces the downwind (internal) span next to a valley to zone I with 0.6 cpe', () => {
    const doc = hall({ spans: [20000, 20000, 20000] });
    const data = check(doc, { windPressure: 0.8 });
    // Same purlin row y; x = 19966 is the eaves-side purlin of the windward span (zone G),
    // x = 20034 the first purlin of the internal span.
    const windward = rowAt(doc, data, 19966, 12000);
    const internal = rowAt(doc, data, 20034, 12000);
    expect(windward.zone).toBe('G');
    expect(internal.zone).toBe('I');
    expect(internal.upliftUtilisation!).toBeLessThan(windward.upliftUtilisation!);
    expect(data.zones.some((zone) => zone.surface === 'roof' && zone.zone === 'I')).toBe(true);
  });

  it('leaves end spans, two-span and single-span halls unchanged', () => {
    const two = hall({ spans: [20000, 20000] });
    const twoData = check(two, { windPressure: 0.8 });
    expect(rowAt(two, twoData, 19966, 12000).zone).toBe('G');
    expect(rowAt(two, twoData, 20034, 12000).zone).toBe('G');
    const single = hall();
    const viaSpans = hall({ spans: [24000] });
    expect(check(viaSpans, { windPressure: 0.8 }).rows.map((row) => row.upliftUtilisation)).toEqual(
      check(single, { windPressure: 0.8 }).rows.map((row) => row.upliftUtilisation),
    );
  });
});
