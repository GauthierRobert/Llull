import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import type { AlignmentObject } from '@core/model/civil';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence';
import { surveyedDocument } from './fixtures';

const flat = (z: number) => () => z;
const line: [number, number][] = [
  [50, 200],
  [250, 200],
];

function withAlignment(
  doc: CadDocument,
  extra: Record<string, unknown> = {},
): { doc: CadDocument; id: string } {
  const result = execute(doc, 'add_alignment', { points: line, surfaceId: 'surface-1', ...extra });
  expect(result.affected.length, result.summary).toBeGreaterThan(0);
  return { doc: result.document, id: (result.data as { alignmentId: string }).alignmentId };
}

function designed(designZ: number, groundZ = 100): { doc: CadDocument; id: string } {
  const { doc, id } = withAlignment(surveyedDocument(flat(groundZ), 21, 20));
  const profile = execute(doc, 'set_alignment_profile', {
    alignmentId: id,
    pvis: [
      { station: 0, elevation: designZ },
      { station: 200, elevation: designZ },
    ],
  });
  const section = execute(profile.document, 'set_road_section', { alignmentId: id });
  expect(section.affected.length, section.summary).toBeGreaterThan(0);
  return { doc: section.document, id };
}

const alignmentOf = (doc: CadDocument, id: string): AlignmentObject =>
  doc.civil?.objects[id] as AlignmentObject;

describe('add_alignment / update_alignment', () => {
  it('creates centreline, ticks and curve labels with metric defaults', () => {
    const base = surveyedDocument(flat(100), 21, 20);
    const result = execute(base, 'add_alignment', {
      points: [
        [50, 100],
        [250, 100],
        [250, 300],
      ],
      radii: [40],
      name: 'Main St',
    });
    const data = result.data as { alignmentId: string; lengthM: number };
    expect(data.alignmentId).toBe('alignment-1');
    expect(data.lengthM).toBeCloseTo(320 + 20 * Math.PI, 2);
    expect(result.affected[0]).toBe('alignment-1');
    const ids = result.document.civil?.objects['alignment-1']?.entityIds ?? [];
    expect(ids).toContain('alignment-1:centreline');
    expect(ids.filter((id) => /:t\d+$/.test(id))).toHaveLength(Math.floor(data.lengthM / 20) + 1);
    expect(ids).toEqual(
      expect.arrayContaining([
        'alignment-1:pc0',
        'alignment-1:pt0',
        'alignment-1:r0',
        'alignment-1:pi0',
      ]),
    );
    const label = result.document.entities['alignment-1:t1'];
    expect(label?.name).toBe('Main St 0+020.00');
    expect(result.document.order).toContain('alignment-1:centreline');
    expect(alignmentOf(result.document, 'alignment-1').stationInterval).toBe(20);
    expect(result.summary).toContain('0+000.00');
  });

  it('is pure and refuses bad input without changing the document', () => {
    const base = surveyedDocument(flat(100), 21, 20);
    const before = JSON.stringify(base);
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ points: [[0, 0]] }, /at least 2/],
      [{ points: line, radii: [5] }, /radii needs 0/],
      [{ points: line, stationInterval: 0 }, /stationInterval/],
      [{ points: line, startStation: Number.POSITIVE_INFINITY }, /startStation|invalid/],
      [{ points: line, surfaceId: 'surface-9' }, /no surface/],
    ];
    for (const [params, message] of cases) {
      const result = execute(base, 'add_alignment', params);
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(base);
      expect(result.summary).toMatch(message);
    }
    expect(JSON.stringify(base)).toBe(before);
    expect(execute(base, 'add_alignment', { points: line }).document).not.toBe(base);
    expect(JSON.stringify(base)).toBe(before);
  });

  it('updates points, radii, station, surface link and name; refuses invalid edits', () => {
    const { doc, id } = withAlignment(surveyedDocument(flat(100), 21, 20));
    const bent = execute(doc, 'update_alignment', {
      alignmentId: id,
      points: [
        [50, 200],
        [200, 200],
        [250, 300],
      ],
      startStation: 500,
      stationInterval: 25,
      name: 'Bent',
    });
    const updated = alignmentOf(bent.document, id);
    expect(updated.radii).toEqual([0]);
    expect(updated.startStation).toBe(500);
    expect(updated.name).toBe('Bent');
    const curved = execute(bent.document, 'update_alignment', {
      alignmentId: id,
      radii: [30],
      surfaceId: '',
    });
    expect(alignmentOf(curved.document, id).surfaceId).toBeUndefined();
    expect(curved.document.civil?.objects[id]?.entityIds).toContain(`${id}:pc0`);
    const relink = execute(curved.document, 'update_alignment', {
      alignmentId: id,
      surfaceId: 'surface-1',
    });
    expect(alignmentOf(relink.document, id).surfaceId).toBe('surface-1');

    const before = JSON.stringify(doc);
    for (const params of [
      { alignmentId: 'nope', name: 'x' },
      { alignmentId: id, radii: [3] },
      { alignmentId: id, stationInterval: -1 },
      { alignmentId: id, startStation: Number.POSITIVE_INFINITY },
      { alignmentId: id, surfaceId: 'surface-7' },
      { alignmentId: id },
    ]) {
      const result = execute(doc, 'update_alignment', params);
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(doc);
    }
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('warns when a shorter alignment leaves the profile outside it', () => {
    const { doc, id } = designed(101);
    const shorter = execute(doc, 'update_alignment', {
      alignmentId: id,
      points: [
        [50, 200],
        [150, 200],
      ],
    });
    expect(shorter.summary).toContain('Warning');
  });
});

describe('set_alignment_profile / set_road_section', () => {
  it('stores the profile sorted and reports grades and K', () => {
    const { doc, id } = withAlignment(surveyedDocument(flat(100), 21, 20));
    const result = execute(doc, 'set_alignment_profile', {
      alignmentId: id,
      pvis: [
        { station: 200, elevation: 101 },
        { station: 0, elevation: 100 },
        { station: 100, elevation: 102, curveLength: 40 },
      ],
    });
    expect(alignmentOf(result.document, id).profile.map((p) => p.station)).toEqual([0, 100, 200]);
    expect(result.summary).toContain('2.00%, -1.00%');
    expect(result.summary).toContain('crest');
    expect(result.summary).toContain('K=13.3');
    const flatProfile = execute(doc, 'set_alignment_profile', {
      alignmentId: id,
      pvis: [
        { station: 0, elevation: 100 },
        { station: 200, elevation: 100 },
      ],
    });
    expect(flatProfile.summary).toContain('No vertical curves');
  });

  it('refuses a missing alignment, short, overlapping, unordered or out-of-range profiles', () => {
    const { doc, id } = withAlignment(surveyedDocument(flat(100), 21, 20));
    const pvi = (
      station: number,
      curveLength?: number,
    ): { station: number; elevation: number; curveLength: number | undefined } => ({
      station,
      elevation: 100,
      curveLength,
    });
    for (const [alignmentId, pvis, message] of [
      ['nope', [pvi(0), pvi(10)], /no alignment/],
      [id, [pvi(0)], /at least 2/],
      [id, [pvi(0), pvi(50, 80), pvi(100, 80), pvi(200)], /overlap/],
      [id, [pvi(0), pvi(0)], /increase/],
      [id, [pvi(0), pvi(250)], /alignment runs/],
      [id, [pvi(-5), pvi(100)], /alignment runs/],
    ] as const) {
      const result = execute(doc, 'set_alignment_profile', { alignmentId, pvis });
      expect(result.affected).toEqual([]);
      expect(result.summary).toMatch(message);
      expect(result.document).toBe(doc);
    }
  });

  it('applies defaults, merges edits and refuses invalid templates', () => {
    const { doc, id } = withAlignment(surveyedDocument(flat(100), 21, 20));
    const first = execute(doc, 'set_road_section', { alignmentId: id });
    expect(alignmentOf(first.document, id).section).toEqual({
      laneWidth: 3.5,
      shoulderWidth: 1,
      crossfall: 0.025,
      cutSlope: 1.5,
      fillSlope: 2,
    });
    const second = execute(first.document, 'set_road_section', { alignmentId: id, laneWidth: 6 });
    expect(alignmentOf(second.document, id).section?.laneWidth).toBe(6);
    expect(alignmentOf(second.document, id).section?.fillSlope).toBe(2);
    for (const params of [
      { alignmentId: 'nope' },
      { alignmentId: id, laneWidth: 0 },
      { alignmentId: id, crossfall: 0.5 },
      { alignmentId: id, cutSlope: -1 },
      { alignmentId: id, shoulderWidth: -1 },
    ]) {
      const result = execute(doc, 'set_road_section', params);
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(doc);
    }
  });
});

describe('corridor and daylight', () => {
  it('draws the carriageway mesh at design level with crossfall and batters to daylight', () => {
    const { doc, id } = designed(101);
    const ids = doc.civil?.objects[id]?.entityIds ?? [];
    expect(ids).toEqual(
      expect.arrayContaining([`${id}:corridor`, `${id}:batters`, `${id}:daylight0`]),
    );
    const mesh = doc.entities[`${id}:corridor`];
    if (mesh?.kind !== 'mesh') throw new Error('corridor is not a mesh');
    const zs = mesh.mesh.positions.filter((_, i) => i % 3 === 2);
    expect(Math.max(...zs)).toBeCloseTo(101, 9);
    expect(Math.min(...zs)).toBeCloseTo(101 - 0.025 * 4.5, 9);
    expect(mesh.mesh.indices.length).toBeGreaterThan(0);
    const batters = doc.entities[`${id}:batters`];
    if (batters?.kind !== 'mesh') throw new Error('batters is not a mesh');
    const bz = batters.mesh.positions.filter((_, i) => i % 3 === 2);
    expect(Math.min(...bz)).toBeCloseTo(100, 3);
  });

  it('draws cut batters rising to the ground and omits daylight without a surface', () => {
    const { doc, id } = designed(99);
    expect(doc.civil?.objects[id]?.entityIds).toContain(`${id}:batters`);
    const bare = execute(doc, 'update_alignment', { alignmentId: id, surfaceId: '' });
    const ids = bare.document.civil?.objects[id]?.entityIds ?? [];
    expect(ids).toContain(`${id}:corridor`);
    expect(ids).not.toContain(`${id}:batters`);
  });

  it('survives terrain ending before the daylight and the survey covering only part', () => {
    const base = surveyedDocument(flat(100), 3, 10);
    const { doc, id } = withAlignment(base, {
      points: [
        [0, 10],
        [20, 10],
      ],
    });
    const result = execute(doc, 'set_alignment_profile', {
      alignmentId: id,
      pvis: [
        { station: 0, elevation: 105 },
        { station: 20, elevation: 105 },
      ],
    });
    const section = execute(result.document, 'set_road_section', { alignmentId: id });
    const ids = section.document.civil?.objects[id]?.entityIds ?? [];
    expect(ids).toContain(`${id}:corridor`);
    expect(ids).not.toContain(`${id}:batters`);
  });
});

describe('alignment_report', () => {
  it('gives fill-only volumes for flat ground below a flat design', () => {
    const { doc, id } = designed(101);
    const result = execute(doc, 'alignment_report', { alignmentId: id });
    const data = result.data as {
      rows: Array<Record<string, number | string | null>>;
      totals: { cutM3: number; fillM3: number; lengthM: number; netM3: number };
      csv: string;
    };
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(doc);
    expect(data.rows).toHaveLength(11);
    const edgeDrop = 0.025 * 4.5;
    const height = 1 - edgeDrop;
    const area = 2 * 4.5 * ((1 + height) / 2) + 2 * (0.5 * height * height * 2);
    expect(data.rows[0]?.['fillAreaM2']).toBeCloseTo(area, 2);
    expect(data.rows[0]?.['cutAreaM2']).toBe(0);
    expect(data.rows[0]?.['groundM']).toBe(100);
    expect(data.rows[0]?.['designM']).toBe(101);
    expect(data.rows[0]?.['cutFillM']).toBe(1);
    expect(data.totals.fillM3).toBeCloseTo(area * 200, 0);
    expect(data.totals.cutM3).toBe(0);
    expect(data.totals.netM3).toBeCloseTo(-area * 200, 0);
    expect(data.totals.lengthM).toBe(200);
    expect(data.rows[10]?.['stationText']).toBe('0+200.00');
    expect(data.csv.split('\n')).toHaveLength(12);
    expect(data.csv.split('\n')[0]).toContain('massHaulM3');
  });

  it('gives cut-only volumes for a design below the ground and mixed cut / fill on a slope', () => {
    const cut = designed(99);
    const cutData = execute(cut.doc, 'alignment_report', { alignmentId: cut.id }).data as {
      totals: { cutM3: number; fillM3: number };
    };
    expect(cutData.totals.cutM3).toBeGreaterThan(1500);
    expect(cutData.totals.fillM3).toBe(0);

    const sloped = withAlignment(surveyedDocument((x) => 100 + (x - 150) * 0.05, 21, 20));
    const profile = execute(sloped.doc, 'set_alignment_profile', {
      alignmentId: sloped.id,
      pvis: [
        { station: 0, elevation: 100 },
        { station: 200, elevation: 100 },
      ],
    });
    const section = execute(profile.document, 'set_road_section', { alignmentId: sloped.id });
    const mixed = execute(section.document, 'alignment_report', {
      alignmentId: sloped.id,
      interval: 50,
    }).data as {
      rows: unknown[];
      totals: { cutM3: number; fillM3: number };
    };
    expect(mixed.rows).toHaveLength(5);
    expect(mixed.totals.cutM3).toBeGreaterThan(0);
    expect(mixed.totals.fillM3).toBeGreaterThan(0);
  });

  it('reports ground only without a profile, and nothing without a surface', () => {
    const { doc, id } = withAlignment(surveyedDocument(flat(100), 21, 20));
    const noProfile = execute(doc, 'alignment_report', { alignmentId: id, interval: 100 });
    const rows = (noProfile.data as { rows: Array<Record<string, unknown>> }).rows;
    expect(rows[0]?.['designM']).toBeNull();
    expect(rows[0]?.['cutAreaM2']).toBeNull();
    expect(noProfile.summary).toContain('earthworks need');
    const bare = withAlignment(surveyedDocument(flat(100), 21, 20), { surfaceId: undefined });
    const bareRows = (
      execute(bare.doc, 'alignment_report', { alignmentId: bare.id }).data as {
        rows: Array<Record<string, unknown>>;
      }
    ).rows;
    expect(bareRows[0]?.['groundM']).toBeNull();
  });

  it('checks horizontal radius and vertical K against the design speed', () => {
    const { doc, id } = withAlignment(surveyedDocument(flat(100), 21, 20), {
      points: [
        [50, 100],
        [250, 100],
        [250, 300],
      ],
      radii: [30],
    });
    const profile = execute(doc, 'set_alignment_profile', {
      alignmentId: id,
      pvis: [
        { station: 0, elevation: 100 },
        { station: 100, elevation: 102, curveLength: 40 },
        { station: 250, elevation: 101 },
        { station: 300, elevation: 101.5 },
        { station: 350, elevation: 101.4 },
      ],
    });
    const result = execute(profile.document, 'alignment_report', {
      alignmentId: id,
      designSpeedKmh: 80,
    });
    const checks = (
      result.data as {
        checks: {
          horizontal: Array<{ ok: boolean; minRadiusM: number }>;
          vertical: Array<{ ok: boolean }>;
          failures: string[];
          assumptions: string;
        };
      }
    ).checks;
    expect(checks.horizontal[0]?.minRadiusM).toBeCloseTo(6400 / (127 * 0.21), 1);
    expect(checks.horizontal[0]?.ok).toBe(false);
    expect(checks.vertical[0]?.ok).toBe(false);
    expect(checks.failures.some((f) => f.includes('Grade break'))).toBe(true);
    expect(checks.assumptions).toContain('e = 0.07');
    expect(result.summary).toContain('failure(s)');
    const gentle = execute(profile.document, 'alignment_report', {
      alignmentId: id,
      designSpeedKmh: 20,
    });
    expect(
      (gentle.data as { checks: { horizontal: Array<{ ok: boolean }> } }).checks.horizontal[0]?.ok,
    ).toBe(true);
    const fast = execute(profile.document, 'alignment_report', {
      alignmentId: id,
      designSpeedKmh: 200,
    });
    expect(fast.summary).toContain('200 km/h');
    const ok = designed(101);
    expect(
      execute(ok.doc, 'alignment_report', { alignmentId: ok.id, designSpeedKmh: 50 }).summary,
    ).toContain('all checks pass');
  });

  it('refuses unknown alignments, bad intervals, bad speeds', () => {
    const { doc, id } = designed(101);
    for (const params of [
      { alignmentId: 'nope' },
      { alignmentId: id, interval: 0 },
      { alignmentId: id, designSpeedKmh: 0 },
    ]) {
      const result = execute(doc, 'alignment_report', params);
      expect(result.data).toBeUndefined();
      expect(result.document).toBe(doc);
    }
  });
});

describe('long section and cross sections', () => {
  it('draws the long section with ground, design, curve info and the table band', () => {
    const base = withAlignment(surveyedDocument((x) => 100 + x * 0.01, 21, 20));
    const profile = execute(base.doc, 'set_alignment_profile', {
      alignmentId: base.id,
      pvis: [
        { station: 0, elevation: 99 },
        { station: 100, elevation: 102, curveLength: 60 },
        { station: 200, elevation: 100 },
      ],
    });
    const result = execute(profile.document, 'export_long_section', { alignmentId: base.id });
    const data = result.data as { text: string; fileName: string };
    expect(result.document).toBe(profile.document);
    expect(data.fileName).toBe('Alignment_1_long_section.svg');
    expect(data.text.startsWith('<svg')).toBe(true);
    expect(data.text).toContain('Long section - Alignment 1');
    expect(data.text).toContain('VC L=60.0');
    expect(data.text).toContain('3.00%');
    expect(data.text).toContain('Cut(-)/Fill(+)');
    expect(data.text).toContain('0+100.00');
    const exaggerated = execute(profile.document, 'export_long_section', {
      alignmentId: base.id,
      verticalExaggeration: 1,
      interval: 100,
    });
    expect((exaggerated.data as { text: string }).text).toContain('vertical exaggeration x1');
    const noGround = execute(profile.document, 'update_alignment', {
      alignmentId: base.id,
      surfaceId: '',
    });
    expect(
      (
        execute(noGround.document, 'export_long_section', { alignmentId: base.id }).data as {
          text: string;
        }
      ).text,
    ).toContain('<polyline');
  });

  it('refuses a long section without a profile or with bad inputs', () => {
    const { doc, id } = withAlignment(surveyedDocument(flat(100), 21, 20));
    for (const params of [
      { alignmentId: id },
      { alignmentId: 'nope' },
      { alignmentId: id, verticalExaggeration: 0 },
    ]) {
      const result = execute(doc, 'export_long_section', params);
      expect(result.data).toBeUndefined();
    }
  });

  it('draws one panel per station with areas, and thins to 60 sections', () => {
    const { doc, id } = designed(101);
    const result = execute(doc, 'export_cross_sections', { alignmentId: id, interval: 50 });
    const data = result.data as { text: string; fileName: string; stations: number };
    expect(data.stations).toBe(5);
    expect(data.fileName).toBe('Alignment_1_cross_sections.svg');
    expect(data.text).toContain('Cut 0.00 m2');
    expect(data.text).toContain('Fill 10.07 m2');
    expect(data.text).toContain('0+150.00');
    const many = execute(doc, 'update_alignment', { alignmentId: id, stationInterval: 1 });
    const thinned = execute(many.document, 'export_cross_sections', { alignmentId: id });
    expect((thinned.data as { stations: number }).stations).toBeLessThanOrEqual(60);
    const noGround = execute(doc, 'update_alignment', { alignmentId: id, surfaceId: '' });
    expect(
      (
        execute(noGround.document, 'export_cross_sections', { alignmentId: id }).data as {
          text: string;
        }
      ).text,
    ).toContain('no existing ground');
  });

  it('refuses cross sections without profile and section', () => {
    const { doc, id } = withAlignment(surveyedDocument(flat(100), 21, 20));
    expect(execute(doc, 'export_cross_sections', { alignmentId: id }).data).toBeUndefined();
    expect(execute(doc, 'export_cross_sections', { alignmentId: 'nope' }).data).toBeUndefined();
  });
});

describe('persistence and derivation', () => {
  it('round-trips through save / load with identical derived geometry', () => {
    const { doc, id } = designed(101);
    const loaded = deserializeDocument(serializeDocument(doc));
    expect(alignmentOf(loaded, id)).toEqual(alignmentOf(doc, id));
    expect(Object.keys(loaded.entities).sort()).toEqual(Object.keys(doc.entities).sort());
    const report = (d: CadDocument): unknown =>
      execute(d, 'alignment_report', { alignmentId: id }).data;
    expect(report(loaded)).toEqual(report(doc));
  });

  it('refuses deleting a generated entity', () => {
    const { doc, id } = designed(101);
    const result = execute(doc, 'delete_entity', { id: `${id}:corridor` });
    expect(result.rejected).toBe(true);
    expect(result.document).toBe(doc);
  });

  it('removes the alignment with delete_civil_object', () => {
    const { doc, id } = designed(101);
    const result = execute(doc, 'delete_civil_object', { id });
    expect(result.document.civil?.objects[id]).toBeUndefined();
    expect(result.document.entities[`${id}:centreline`]).toBeUndefined();
  });
});
