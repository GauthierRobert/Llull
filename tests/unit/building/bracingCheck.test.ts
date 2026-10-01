import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { checkBracing, type BracingRow } from '@core/commands/building/industrial/bracingCheck';
import { __resetIdCounter } from '@lib/id';

function hall(params: Record<string, unknown> = {}, base = createEmptyDocument()): CadDocument {
  return execute(base, 'add_portal_frame_building', { span: 24000, length: 48000, ...params })
    .document;
}

function rowsOf(doc: CadDocument, params: Record<string, unknown> = {}): BracingRow[] {
  const data = checkBracing.run(doc, params).data as { rows: BracingRow[] };
  return data.rows;
}

function without(doc: CadDocument, role: string): CadDocument {
  const building = doc.building;
  if (!building) throw new Error('no building');
  const elements = Object.fromEntries(
    Object.entries(building.elements).filter(
      ([, element]) => !(element.category === 'member' && element.role === role),
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

beforeEach(() => __resetIdCounter());

describe('check_bracing', () => {
  it('passes the default hall and is read-only', () => {
    const doc = hall();
    const snapshot = JSON.stringify(doc);
    const result = checkBracing.run(doc, {});
    expect(JSON.stringify(doc)).toBe(snapshot);
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(checkBracing.annotations).toEqual({ readOnly: true, idempotent: true });
    const data = result.data as {
      rows: BracingRow[];
      csv: string;
      maxUtilisation: number;
      failures: string[];
      bracedBays: number;
      gableArea: number;
    };
    expect(data.failures).toEqual([]);
    expect(data.maxUtilisation).toBeGreaterThan(0);
    expect(data.maxUtilisation).toBeLessThan(1);
    expect(data.bracedBays).toBe(2);
    // 24 m x 7 m + roof triangle 24 m x 1.26 m / 2 (centrelines)
    expect(data.gableArea).toBeGreaterThan(180);
    expect(data.gableArea).toBeLessThan(186);
    const groups = new Set(data.rows.map((row) => row.group));
    expect(groups).toEqual(
      new Set(['roof bracing', 'wall bracing west', 'wall bracing east', 'gable posts']),
    );
    expect(data.csv.split('\n')[0]).toContain('Utilisation');
    expect(result.summary).toMatch(/gable 18\d\.\d m².*2 braced bay.*all OK/);
  });

  it('reports diagonal, strut and gable-post rows with forces and resistances', () => {
    const rows = rowsOf(hall());
    const diagonals = rows.filter((row) => row.kind === 'diagonal');
    // 2 end bays x (2 roof slopes + 2 walls)
    expect(diagonals).toHaveLength(8);
    for (const row of diagonals) {
      expect(row.elementIds).toHaveLength(2);
      expect(row.force).toBeGreaterThan(0);
      expect(row.resistance).toBeCloseTo(290, -1);
      expect(row.utilisation).toBeCloseTo(row.force / row.resistance, 6);
    }
    expect(rows.some((row) => row.kind === 'strut' && row.group === 'roof bracing')).toBe(true);
    expect(rows.some((row) => row.kind === 'strut' && row.group.startsWith('wall'))).toBe(true);
    const posts = rows.filter((row) => row.kind === 'gable-post');
    // 24 m span -> 3 posts per gable, both gables
    expect(posts).toHaveLength(6);
    for (const post of posts) {
      expect(post.moment).toBeGreaterThan(0);
      expect(post.momentResistance).toBeGreaterThan(post.moment);
      expect(post.utilisation).toBeLessThan(1);
    }
  });

  it('fails the light CHS under high wind, and a heavier brace passes', () => {
    const light = checkBracing.run(hall(), { windPressure: 3 });
    const lightData = light.data as { failures: string[]; maxUtilisation: number };
    expect(lightData.maxUtilisation).toBeGreaterThan(1);
    expect(lightData.failures.length).toBeGreaterThan(0);
    expect(light.summary).toMatch(/failure\(s\).*diagonal/);
    const heavy = checkBracing.run(hall({ braceProfile: 'CHS219.1x8' }), { windPressure: 3 });
    const heavyRows = (heavy.data as { rows: BracingRow[] }).rows.filter(
      (row) => row.kind === 'diagonal',
    );
    expect(heavyRows.every((row) => row.utilisation <= 1)).toBe(true);
    expect(Math.max(...heavyRows.map((row) => row.utilisation))).toBeLessThan(
      Math.max(
        ...rowsOf(hall(), { windPressure: 3 })
          .filter((row) => row.kind === 'diagonal')
          .map((row) => row.utilisation),
      ),
    );
  });

  it('flags overloaded gable posts and scales with windPressure', () => {
    const doc = hall({ gablePostProfile: 'HEA100' });
    const posts = rowsOf(doc, { windPressure: 1.5 }).filter((row) => row.kind === 'gable-post');
    expect(posts.some((row) => row.utilisation > 1)).toBe(true);
    const low = rowsOf(doc, { windPressure: 0.3 }).filter((row) => row.kind === 'gable-post');
    expect(low[0]?.moment).toBeCloseTo((posts[0]?.moment ?? 0) / 5, 6);
  });

  it('handles a single-bay hall and a document in metres', () => {
    const single = checkBracing.run(hall({ length: 6000 }), {});
    expect((single.data as { bracedBays: number }).bracedBays).toBe(1);
    const metres = hall(
      { span: 24, length: 48, baySpacing: 6, eaveHeight: 7, purlinSpacing: 1.8, railSpacing: 1.8 },
      {
        ...createEmptyDocument(),
        units: 'm',
      },
    );
    const inMetres = checkBracing.run(metres, {});
    const inMillimetres = checkBracing.run(hall(), {});
    expect((inMetres.data as { windForce: number }).windForce).toBeCloseTo(
      (inMillimetres.data as { windForce: number }).windForce,
      0,
    );
  });

  it('selects a level and rejects bad input without changing the document', () => {
    const doc = hall();
    for (const params of [
      { windPressure: -1 },
      { deadLoad: Number.NaN },
      { snowLoad: -0.1 },
      { levelId: 'nope' },
    ]) {
      const result = checkBracing.run(doc, params);
      expect(result.document).toBe(doc);
      expect(result.affected).toEqual([]);
      expect(result.data).toBeUndefined();
      expect(result.summary).toMatch(/check_bracing failed/);
    }
    const levelId = doc.building?.levelOrder[0] ?? '';
    expect(checkBracing.run(doc, { levelId }).data).toBeDefined();
  });

  it('is a no-op on an empty document, without bracing, or without rafters', () => {
    const empty = createEmptyDocument();
    expect(checkBracing.run(empty, {}).data).toBeUndefined();
    const doc = hall();
    const noBrace = checkBracing.run(without(doc, 'brace'), {});
    expect(noBrace.data).toBeUndefined();
    expect(noBrace.summary).toMatch(/no bracing/);
    const noRafter = checkBracing.run(without(doc, 'rafter'), {});
    expect(noRafter.data).toBeUndefined();
    expect(noRafter.summary).toMatch(/no rafters/);
  });

  it('buckles struts with the imperfection of their section family', () => {
    const struts = (params: Record<string, unknown>): number[] =>
      rowsOf(hall(params), { windPressure: 0 })
        .filter((row) => row.kind === 'strut' && row.group.startsWith('wall'))
        .map((row) => row.resistance);
    const slender = struts({ columnProfile: 'HEB300' });
    const tall = struts({ columnProfile: 'HEA400' });
    const channel = struts({ columnProfile: 'UPN200' });
    const hollow = struts({ columnProfile: 'SHS150x8' });
    for (const values of [slender, tall, channel, hollow]) {
      expect(values.length).toBeGreaterThan(0);
      expect(values[0]).toBeGreaterThan(0);
    }
  });
});
