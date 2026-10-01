import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import {
  checkPurlins,
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

  it('puts edge purlins in zones F / G and the middle in H/I with growing uplift', () => {
    const data = check(hall());
    expect(data.zones.map((zone) => `${zone.surface}:${zone.zone}`)).toEqual(
      expect.arrayContaining(['roof:F', 'roof:G', 'roof:H/I']),
    );
    const roof = Object.fromEntries(
      data.zones.filter((zone) => zone.surface === 'roof').map((zone) => [zone.zone, zone]),
    );
    expect(roof['F']?.cpe).toBe(-1.7);
    expect(roof['G']?.cpe).toBe(-1.2);
    expect(roof['H/I']?.cpe).toBe(-0.6);
    const zoneRows = (zone: string): PurlinRow[] =>
      interior(purlinsOf(data)).filter((row) => row.zone === zone);
    const maxUplift = (zone: string): number => Math.max(...zoneRows(zone).map(uplift));
    expect(maxUplift('F')).toBeGreaterThan(maxUplift('G'));
    expect(maxUplift('G')).toBeGreaterThan(maxUplift('H/I'));
    // the eaves line of the end bay is corner zone F; an interior bay middle purlin is H/I
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
    expect(wall.map((zone) => zone.zone)).toEqual(expect.arrayContaining(['A', 'D']));
    expect(wall.find((zone) => zone.zone === 'A')?.cpe).toBe(-1.2);
    expect(wall.find((zone) => zone.zone === 'D')?.cpe).toBe(0.8);
    expect(rails.some((row) => row.check.includes('span/150'))).toBe(true);
    const lighter = railsOf(check(hall({ railProfile: 'C300x90x3.0' })));
    expect(Math.max(...lighter.map((row) => row.utilisation))).toBeLessThan(
      Math.max(...rails.map((row) => row.utilisation)),
    );
  });

  it('classifies wall zone B and C on a long hall', () => {
    const data = check(hall({ length: 60000, baySpacing: 6000 }));
    const zones = data.zones.filter((zone) => zone.surface === 'wall').map((zone) => zone.zone);
    expect(zones).toEqual(expect.arrayContaining(['A', 'D']));
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
