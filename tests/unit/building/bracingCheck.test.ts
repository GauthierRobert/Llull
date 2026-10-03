import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { checkBracing, type BracingRow } from '@aec/industrial/bracingCheck';

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

  it('distributes roof truss shear over a multi-span hall (end panels carry ~bayForce/2)', () => {
    const doc = hall({ spans: [20000, 20000, 20000], length: 12000 });
    const result = checkBracing.run(doc, {});
    const data = result.data as { rows: BracingRow[]; roofForce: number; bracedBays: number };
    const roof = data.rows.filter((row) => row.kind === 'diagonal' && row.group === 'roof bracing');
    expect(roof).toHaveLength(6);
    const forces = roof.map((row) => row.force).sort((a, b) => a - b);
    const bayForce = data.roofForce / data.bracedBays;
    const largest = forces[forces.length - 1] ?? 0;
    const smallest = forces[0] ?? 0;
    expect(largest / smallest).toBeGreaterThanOrEqual(2.99);
    expect(largest / smallest).toBeLessThan(5.5);
    // wall-side panel: V = bayForce / 2; diagonal = V / cos θ, cos θ = bay / length
    const length = Math.hypot(10000, 6000, 10000 * Math.tan((6 * Math.PI) / 180));
    expect(largest).toBeCloseTo(((bayForce / 2) * length) / 6000, 0);
  });

  it('uses column height and purlin gap as strut buckling lengths', () => {
    const rows = rowsOf(hall(), { windPressure: 0 });
    const wall = rows.find((row) => row.kind === 'strut' && row.group.startsWith('wall'));
    const roof = rows.find(
      (row) => row.kind === 'strut' && row.group === 'roof bracing' && /rafter/.test(row.check),
    );
    expect(wall?.check).toMatch(/Lcr 7000 mm, column height/);
    expect(roof?.check).toMatch(/purlin gap/);
    expect(Number(/Lcr (\d+) mm/.exec(roof?.check ?? '')?.[1])).toBeLessThan(2000);
  });

  it('checks the eaves purlin and flags a missing one with utilisation 99', () => {
    const doc = hall();
    const eaves = rowsOf(doc).filter((row) => /eaves strut/.test(row.check));
    // 2 end bays x 2 walls
    expect(eaves).toHaveLength(4);
    for (const row of eaves) {
      expect(row.kind).toBe('strut');
      expect(row.force).toBeGreaterThan(0);
      expect(row.resistance).toBeGreaterThan(0);
      expect(row.check).toMatch(/Lcr 6000 mm bay/);
    }
    const missing = rowsOf(without(doc, 'purlin')).filter((row) =>
      /no eaves strut found/.test(row.check),
    );
    expect(missing).toHaveLength(4);
    expect(missing.every((row) => row.utilisation === 99)).toBe(true);
    const result = checkBracing.run(without(doc, 'purlin'), {});
    expect((result.data as { failures: string[] }).failures.length).toBeGreaterThan(0);
  });

  it('reports the same eaves-strut force on single- and two-span halls (internal lines are unbraced)', () => {
    const eavesOf = (spans: number[], roofType: string): BracingRow[] =>
      rowsOf(hall({ span: undefined, spans, length: 30000, roofType }), {
        windPressure: 0.7,
      }).filter((row) => /eaves strut/.test(row.check));
    for (const roofType of ['monopitch', 'duopitch']) {
      const single = eavesOf([24000], roofType);
      const double = eavesOf([12000, 12000], roofType);
      expect(double).toHaveLength(4);
      for (const row of double) {
        // monopitch: identical gable; duopitch: the ridge of two 12 m spans is lower (smaller gable)
        expect(row.force).toBeCloseTo(single[0]?.force ?? 0, roofType === 'monopitch' ? 6 : -1);
        expect(row.check).toMatch(/outer wall line, independent of the number of spans/);
      }
    }
    // the larger monopitch gable loads the default C200x75x2.5 eaves purlin harder than a duopitch one
    const monopitch = eavesOf([12000, 12000], 'monopitch');
    expect(monopitch[0]?.force).toBeGreaterThan(eavesOf([12000, 12000], 'duopitch')[0]?.force ?? 0);
    // a heavier eaves purlin carries it
    const heavy = rowsOf(
      hall({
        span: undefined,
        spans: [12000, 12000],
        length: 30000,
        roofType: 'monopitch',
        purlinProfile: 'C300x90x3.0',
      }),
      { windPressure: 1 },
    ).filter((row) => /eaves strut/.test(row.check));
    const light = rowsOf(
      hall({ span: undefined, spans: [12000, 12000], length: 30000, roofType: 'monopitch' }),
      { windPressure: 1 },
    ).filter((row) => /eaves strut/.test(row.check));
    expect(light.every((row) => row.utilisation > 1)).toBe(true);
    expect(heavy.every((row) => row.utilisation < 1)).toBe(true);
  });

  it('applies net pressure 1.0 to gable posts', () => {
    const post = rowsOf(hall(), { windPressure: 1 }).find((row) => row.kind === 'gable-post');
    expect(post?.check).toMatch(/q (\d+\.\d+) kN\/m/);
    const q = Number(/q (\d+\.\d+) kN\/m/.exec(post?.check ?? '')?.[1]);
    // 1.5 · qp 1.0 · cp 1.0 · tributary 6 m
    expect(q).toBeCloseTo(9, 1);
  });
});

describe('check_bracing crane longitudinal path', () => {
  const crane = { crane: { capacity: 10, railHeight: 6000 } };
  const wallDiagonals = (rows: BracingRow[]): BracingRow[] =>
    rows.filter((row) => row.group.startsWith('wall bracing') && row.check.startsWith('tension'));
  type CraneData = {
    crane: {
      design: number;
      governing: string;
      driveGroup1: number;
      bufferGroup7: number;
      foundationHorizontalY: { perColumn: number; total: number }[];
    } | null;
  };

  it('raises the wall bracing utilisation versus a hall without a crane', () => {
    const plain = wallDiagonals(rowsOf(hall()));
    const craned = wallDiagonals(rowsOf(hall(crane)));
    expect(plain.length).toBeGreaterThan(0);
    expect(craned.length).toBe(plain.length);
    expect(Math.max(...craned.map((row) => row.utilisation))).toBeGreaterThan(
      Math.max(...plain.map((row) => row.utilisation)),
    );
    expect((checkBracing.run(hall(), {}).data as CraneData).crane).toBeNull();
  });

  it('reports the crane longitudinal rows and foundation forces', () => {
    const result = checkBracing.run(hall(crane), {});
    const data = result.data as CraneData;
    const rows = (result.data as { rows: BracingRow[] }).rows;
    const craneRows = rows.filter((row) =>
      row.check.startsWith('crane longitudinal (group 1 / group 7)'),
    );
    expect(craneRows.length).toBeGreaterThanOrEqual(2);
    expect(data.crane?.design).toBeCloseTo(
      Math.max(data.crane?.driveGroup1 ?? 0, data.crane?.bufferGroup7 ?? 0),
      9,
    );
    expect(data.crane?.bufferGroup7).toBeCloseTo(23.1, 0);
    expect(data.crane?.governing).toBe('group 7');
    expect(data.crane?.foundationHorizontalY.length).toBe(craneRows.length);
    for (const entry of data.crane?.foundationHorizontalY ?? []) {
      expect(entry.perColumn).toBeCloseTo(entry.total / 2, 9);
    }
  });

  it('scales with travelSpeed and is a no-op on bad crane params', () => {
    const doc = hall(crane);
    const design = (travelSpeed: number): number =>
      (checkBracing.run(doc, { travelSpeed }).data as CraneData).crane?.bufferGroup7 ?? 0;
    expect(design(0.6) / design(0.3)).toBeCloseTo(2, 6);
    for (const params of [{ travelSpeed: 0 }, { bufferStiffness: -5 }, { craneCapacity: 0 }]) {
      const result = checkBracing.run(doc, params);
      expect(result.document).toBe(doc);
      expect(result.data).toBeUndefined();
      expect(result.summary).toMatch(/failed/);
    }
    const override = checkBracing.run(hall(), { craneCapacity: 10 }).data as CraneData;
    expect(override.crane).toBeNull();
  });
});
