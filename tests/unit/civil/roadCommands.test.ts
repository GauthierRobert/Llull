import { describe, expect, it } from 'vitest';
import type { CadDocument, Vec2, MeshSolidEntity } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { alignmentOf, expectSaveLoadRoundTrip, surveyedDocument } from './fixtures';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { xy } from '../../helpers/xy';
import {
  alignmentLength,
  centrelinePoints,
  horizontalElements,
  pointAtStation,
  sampleStations,
  stationOffset,
  validateHorizontal,
  type ArcElement,
  type SpiralElement,
} from '@aec/civil/alignment/alignmentGeometry';
import { designElevation, grades, validateProfile, verticalCurves, verticalCurveStations } from '@aec/civil/alignment/profileGeometry';
import type { AlignmentObject } from '@core/model/civil';
import { clothoidLocal, spiralCurve } from '@aec/civil/alignment/alignmentSpiral';
import { crossSlopesAt, superelevationRate, superelevationStations } from '@aec/civil/alignment/superelevation';
import { crossSectionAt } from '@aec/civil/road/roadSection';
import { civilErrors } from '@aec/civil/validate';

const flat = (z: number) => () => z;
const line: [number, number][] = [
  [50, 200],
  [250, 200],
];

function withAlignment(doc: CadDocument, extra: Record<string, unknown> = {}): { doc: CadDocument; id: string } {
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

describe('add_alignment / update_alignment', () => {
  it('creates centreline, ticks and curve labels with metric defaults', () => {
    const base = surveyedDocument(flat(100), 21, 20);
    const result = execute(base, 'add_alignment', { points: xy(50, 100, 250, 100, 250, 300), radii: [40], name: 'Main St' });
    const data = result.data as { alignmentId: string; lengthM: number };
    expect(data.alignmentId).toBe('alignment-1');
    expect(data.lengthM).toBeCloseTo(320 + 20 * Math.PI, 2);
    expect(result.affected[0]).toBe('alignment-1');
    const ids = result.document.civil?.objects['alignment-1']?.entityIds ?? [];
    expect(ids).toContain('alignment-1:centreline');
    expect(ids.filter((id) => /:t\d+$/.test(id))).toHaveLength(Math.floor(data.lengthM / 20) + 1);
    expect(ids).toEqual(expect.arrayContaining(['alignment-1:pc0', 'alignment-1:pt0', 'alignment-1:r0', 'alignment-1:pi0']));
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
      expectNoOp(result, base);
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
      points: xy(50, 200, 200, 200, 250, 300),
      startStation: 500,
      stationInterval: 25,
      name: 'Bent',
    });
    const updated = alignmentOf(bent.document, id);
    expect(updated.radii).toEqual([0]);
    expect(updated.startStation).toBe(500);
    expect(updated.name).toBe('Bent');
    const curved = execute(bent.document, 'update_alignment', { alignmentId: id, radii: [30], surfaceId: '' });
    expect(alignmentOf(curved.document, id).surfaceId).toBeUndefined();
    expect(curved.document.civil?.objects[id]?.entityIds).toContain(`${id}:pc0`);
    const relink = execute(curved.document, 'update_alignment', { alignmentId: id, surfaceId: 'surface-1' });
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
      expectNoOp(execute(doc, 'update_alignment', params), doc);
    }
    expect(JSON.stringify(doc)).toBe(before);
  });
  it('warns when a shorter alignment leaves the profile outside it', () => {
    const { doc, id } = designed(101);
    const shorter = execute(doc, 'update_alignment', { alignmentId: id, points: xy(50, 200, 150, 200) });
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
    for (const s of ['2.00%, -1.00%', 'crest', 'K=13.3']) expect(result.summary).toContain(s);
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
    const pvi = (station: number, curveLength?: number): { station: number; elevation: number; curveLength: number | undefined } => ({
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
      expectNoOp(execute(doc, 'set_road_section', params), doc);
    }
  });
});

describe('corridor and daylight', () => {
  it('draws the carriageway mesh at design level with crossfall and batters to daylight', () => {
    const { doc, id } = designed(101);
    const ids = doc.civil?.objects[id]?.entityIds ?? [];
    expect(ids).toEqual(expect.arrayContaining([`${id}:corridor`, `${id}:batters`, `${id}:daylight0`]));
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
    const { doc, id } = withAlignment(base, { points: xy(0, 10, 20, 10) });
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
    expectNoOp(result, doc);
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
    const cutData = execute(cut.doc, 'alignment_report', { alignmentId: cut.id }).data as { totals: { cutM3: number; fillM3: number } };
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
    const mixed = execute(section.document, 'alignment_report', { alignmentId: sloped.id, interval: 50 }).data as {
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
    const bareRows = (execute(bare.doc, 'alignment_report', { alignmentId: bare.id }).data as { rows: Array<Record<string, unknown>> })
      .rows;
    expect(bareRows[0]?.['groundM']).toBeNull();
  });
  it('checks horizontal radius and vertical K against the design speed', () => {
    const { doc, id } = withAlignment(surveyedDocument(flat(100), 21, 20), { points: xy(50, 100, 250, 100, 250, 300), radii: [30] });
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
    const result = execute(profile.document, 'alignment_report', { alignmentId: id, designSpeedKmh: 80 });
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
    const gentle = execute(profile.document, 'alignment_report', { alignmentId: id, designSpeedKmh: 20 });
    expect((gentle.data as { checks: { horizontal: Array<{ ok: boolean }> } }).checks.horizontal[0]?.ok).toBe(true);
    const fast = execute(profile.document, 'alignment_report', { alignmentId: id, designSpeedKmh: 200 });
    expect(fast.summary).toContain('200 km/h');
    const ok = designed(101);
    expect(execute(ok.doc, 'alignment_report', { alignmentId: ok.id, designSpeedKmh: 50 }).summary).toContain('all checks pass');
  });
  it('refuses unknown alignments, bad intervals, bad speeds', () => {
    const { doc, id } = designed(101);
    for (const params of [{ alignmentId: 'nope' }, { alignmentId: id, interval: 0 }, { alignmentId: id, designSpeedKmh: 0 }]) {
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
    for (const s of ['Long section - Alignment 1', 'VC L=60.0', '3.00%', 'Cut(-)/Fill(+)', '0+100.00']) expect(data.text).toContain(s);
    const exaggerated = execute(profile.document, 'export_long_section', { alignmentId: base.id, verticalExaggeration: 1, interval: 100 });
    expect((exaggerated.data as { text: string }).text).toContain('vertical exaggeration x1');
    const noGround = execute(profile.document, 'update_alignment', { alignmentId: base.id, surfaceId: '' });
    expect((execute(noGround.document, 'export_long_section', { alignmentId: base.id }).data as { text: string }).text).toContain(
      '<polyline',
    );
  });
  it('refuses a long section without a profile or with bad inputs', () => {
    const { doc, id } = withAlignment(surveyedDocument(flat(100), 21, 20));
    for (const params of [{ alignmentId: id }, { alignmentId: 'nope' }, { alignmentId: id, verticalExaggeration: 0 }]) {
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
    for (const s of ['Cut 0.00 m2', 'Fill 10.07 m2', '0+150.00']) expect(data.text).toContain(s);
    const many = execute(doc, 'update_alignment', { alignmentId: id, stationInterval: 1 });
    const thinned = execute(many.document, 'export_cross_sections', { alignmentId: id });
    expect((thinned.data as { stations: number }).stations).toBeLessThanOrEqual(60);
    const noGround = execute(doc, 'update_alignment', { alignmentId: id, surfaceId: '' });
    expect((execute(noGround.document, 'export_cross_sections', { alignmentId: id }).data as { text: string }).text).toContain(
      'no existing ground',
    );
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
    expectSaveLoadRoundTrip(doc, id);
  });
  it('refuses deleting a generated entity', () => {
    const { doc, id } = designed(101);
    const result = execute(doc, 'delete_entities', { ids: [`${id}:corridor`] });
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

const corner: { points: Vec2[]; radii: number[]; startStation: number } = {
  points: xy(0, 0, 100, 0, 100, 100),
  radii: [30],
  startStation: 1000,
};

describe('horizontal geometry', () => {
  const elements = horizontalElements(corner);
  it('builds line - arc - line with R*delta curve length and R*tan(delta/2) tangents', () => {
    expect(elements.map((e) => e.kind)).toEqual(['line', 'arc', 'line']);
    const arc = elements[1] as ArcElement;
    expect(arc.length).toBeCloseTo(30 * (Math.PI / 2), 9);
    expect(arc.deflection).toBeCloseTo(Math.PI / 2, 9);
    expect(arc.rotation).toBe('ccw');
    expect(arc.start[0]).toBeCloseTo(70, 9);
    expect(arc.end[1]).toBeCloseTo(30, 9);
    expect(arc.center[0]).toBeCloseTo(70, 9);
    expect(arc.center[1]).toBeCloseTo(30, 9);
    expect(arc.startStation).toBeCloseTo(1070, 9);
    expect(alignmentLength(corner)).toBeCloseTo(140 + 15 * Math.PI, 9);
  });
  it('turns clockwise for a right-hand deflection', () => {
    const right = horizontalElements({ ...corner, points: xy(0, 0, 100, 0, 100, -100) });
    expect((right[1] as ArcElement).rotation).toBe('cw');
    const mid = pointAtStation({ ...corner, points: xy(0, 0, 100, 0, 100, -100) }, 1070 + (15 * Math.PI) / 2);
    expect(mid?.point[0]).toBeCloseTo(70 + 30 * Math.sin(Math.PI / 4), 6);
    expect(mid?.point[1]).toBeCloseTo(-(30 - 30 * Math.cos(Math.PI / 4)), 6);
  });
  it('keeps a sharp corner for radius 0 and merges collinear PIs', () => {
    const sharp = horizontalElements({ ...corner, radii: [0] });
    expect(sharp.map((e) => e.kind)).toEqual(['line', 'line']);
    const straight = horizontalElements({ points: xy(0, 0, 50, 0, 100, 0), radii: [25], startStation: 0 });
    expect(straight.map((e) => e.kind)).toEqual(['line', 'line']);
  });
  it('round-trips station -> point -> station on the arc, with signed offsets', () => {
    const station = 1070 + 20;
    const placed = pointAtStation(corner, station);
    expect(placed).not.toBeNull();
    const back = stationOffset(corner, placed?.point as Vec2);
    expect(back?.station).toBeCloseTo(station, 6);
    expect(back?.offset).toBeCloseTo(0, 6);
    const inside = stationOffset(corner, [70, 30]);
    expect(inside?.offset).toBeCloseTo(30, 6);
    const outside = stationOffset(corner, [70 + 38 * Math.cos(-Math.PI / 4), 30 + 38 * Math.sin(-Math.PI / 4)]);
    expect(outside?.offset).toBeCloseTo(-8, 6);
  });
  it('clamps stations and finds points beyond the ends and before the arc', () => {
    expect(pointAtStation(corner, -5000)?.point).toEqual([0, 0]);
    expect(pointAtStation(corner, 9999)?.point[1]).toBeCloseTo(100, 9);
    const before = stationOffset(corner, [30, 5]);
    expect(before?.station).toBeCloseTo(1030, 9);
    expect(before?.offset).toBeCloseTo(5, 9);
    const nearEnd = stationOffset(corner, [100, 150]);
    expect(nearEnd?.station).toBeCloseTo(1000 + alignmentLength(corner), 6);
    const wide = stationOffset(corner, [-40, 80]);
    expect(wide?.distance).toBeGreaterThan(0);
    const exact = stationOffset(corner, [0, 0]);
    expect(exact?.offset).toBe(0);
  });
  it('reports invalid geometry with the offending PI and returns no elements', () => {
    expect(validateHorizontal([[0, 0]], [])).toMatch(/at least 2/);
    expect(validateHorizontal(xy(0, 0, Number.NaN, 1), [])).toMatch(/finite/);
    expect(validateHorizontal(xy(0, 0, 0, 0), [])).toMatch(/coincide/);
    expect(validateHorizontal(xy(0, 0, 1, 0, 1, 1), [])).toMatch(/radii needs 1/);
    expect(validateHorizontal(xy(0, 0, 1, 0, 1, 1), [-1])).toMatch(/radii must/);
    expect(validateHorizontal(xy(0, 0, 10, 0, 0, 0.0000001), [1])).toMatch(/doubles back/);
    const tight = [
      [0, 0],
      [50, 0],
      [50, 50],
      [100, 50],
    ] as Vec2[];
    const message = validateHorizontal(tight, [30, 30]);
    expect(message).toMatch(/PI 1/);
    expect(horizontalElements({ points: tight, radii: [30, 30], startStation: 0 })).toEqual([]);
    expect(pointAtStation({ points: tight, radii: [30, 30], startStation: 0 }, 5)).toBeNull();
    expect(stationOffset({ points: tight, radii: [30, 30], startStation: 0 }, [0, 0])).toBeNull();
    expect(validateHorizontal(tight, [20, 20])).toBeNull();
    expect(validateHorizontal(tight, [0, 60])).toMatch(/PI 2/);
  });
  it('samples stations with PC / PT and densified arcs; caps the count', () => {
    const stations = sampleStations(corner, 50);
    expect(stations[0]).toBe(1000);
    expect(stations).toContain(1070);
    expect(stations.some((s) => Math.abs(s - (1070 + 15 * Math.PI)) < 1e-9)).toBe(true);
    const arcStations = stations.filter((s) => s > 1070 && s < 1070 + 15 * Math.PI);
    expect(arcStations.length).toBeGreaterThanOrEqual(17);
    expect(sampleStations(corner, 50, [1100, 5000])).toContain(1100);
    expect(sampleStations(corner, 0.001).length).toBeLessThan(2400);
    expect(sampleStations({ points: [[0, 0]], radii: [], startStation: 0 }, 10)).toEqual([]);
    expect(centrelinePoints(corner).length).toBeGreaterThan(18);
  });
});

describe('vertical geometry', () => {
  const profile = [
    { station: 0, elevation: 100, curveLength: 0 },
    { station: 100, elevation: 102, curveLength: 40 },
    { station: 200, elevation: 101, curveLength: 0 },
  ];
  it('evaluates tangents and the parabola analytically', () => {
    expect(grades(profile)).toEqual([0.02, -0.01]);
    expect(designElevation(profile, 50)).toBeCloseTo(101, 9);
    expect(designElevation(profile, 150)).toBeCloseTo(101.5, 9);
    expect(designElevation(profile, 100)).toBeCloseTo(101.85, 9);
    expect(designElevation(profile, 80)).toBeCloseTo(101.6, 9);
    expect(designElevation(profile, 120)).toBeCloseTo(101.8, 9);
    expect(designElevation(profile, 0)).toBe(100);
    expect(designElevation(profile, -1)).toBeNull();
    expect(designElevation(profile, 201)).toBeNull();
    expect(designElevation([], 5)).toBeNull();
  });
  it('computes K, kind and the high point of a crest', () => {
    const [curve] = verticalCurves(profile);
    expect(curve?.kind).toBe('crest');
    expect(curve?.k).toBeCloseTo(40 / 3, 9);
    expect(curve?.turning?.station).toBeCloseTo(80 + 80 / 3, 9);
    expect(curve?.turning?.elevation).toBeCloseTo(101.8667, 3);
    const sag = verticalCurves([
      { station: 0, elevation: 100, curveLength: 0 },
      { station: 100, elevation: 99, curveLength: 60 },
      { station: 200, elevation: 101, curveLength: 0 },
    ]);
    expect(sag[0]?.kind).toBe('sag');
    expect(sag[0]?.turning?.elevation).toBeLessThan(99.2);
    const noTurn = verticalCurves([
      { station: 0, elevation: 100, curveLength: 0 },
      { station: 100, elevation: 101, curveLength: 20 },
      { station: 200, elevation: 103, curveLength: 0 },
    ]);
    expect(noTurn[0]?.turning).toBeNull();
    expect(
      verticalCurves([
        { station: 0, elevation: 1, curveLength: 0 },
        { station: 10, elevation: 2, curveLength: 0 },
        { station: 20, elevation: 3, curveLength: 5 },
      ]),
    ).toEqual([]);
    expect(verticalCurveStations(profile)).toHaveLength(9);
  });
  it('validates stations, lengths and overlapping curves', () => {
    const pvi = (station: number, curveLength = 0): { station: number; elevation: number; curveLength: number } => ({
      station,
      elevation: 0,
      curveLength,
    });
    expect(validateProfile([pvi(0)])).toMatch(/at least 2/);
    expect(validateProfile([pvi(0), { station: Number.NaN, elevation: 0, curveLength: 0 }])).toMatch(/finite/);
    expect(validateProfile([pvi(0), pvi(5, -1), pvi(10)])).toMatch(/curveLength/);
    expect(validateProfile([pvi(0), pvi(0)])).toMatch(/increase/);
    expect(validateProfile([pvi(0, 10), pvi(10)])).toMatch(/first and last/);
    expect(validateProfile([pvi(0), pvi(10, 12), pvi(20, 12), pvi(30)])).toMatch(/overlap/);
    expect(validateProfile([pvi(0), pvi(10, 10), pvi(20, 10), pvi(30)])).toBeNull();
  });
});

const R = 100;
const LS = 60;
const POINTS: [number, number][] = [
  [0, 0],
  [300, 0],
  [300, 300],
];
const flat2 = (): number => 100;

function spiralDoc(extra: Record<string, unknown> = {}): { doc: CadDocument; id: string } {
  const base = surveyedDocument(flat2, 31, 20);
  const result = execute(base, 'add_alignment', {
    points: POINTS,
    radii: [R],
    spirals: [LS],
    surfaceId: 'surface-1',
    stationInterval: 10,
    ...extra,
  });
  expect(result.affected.length, result.summary).toBeGreaterThan(0);
  return { doc: result.document, id: (result.data as { alignmentId: string }).alignmentId };
}

function designedSpiral(maxRate = 0.07): { doc: CadDocument; id: string } {
  const { doc, id } = spiralDoc();
  const profiled = execute(doc, 'set_alignment_profile', {
    alignmentId: id,
    pvis: [
      { station: 0, elevation: 101 },
      { station: 500, elevation: 101 },
    ],
  });
  const sectioned = execute(profiled.document, 'set_road_section', { alignmentId: id });
  const result = execute(sectioned.document, 'set_superelevation', { alignmentId: id, maxRate });
  expect(result.affected.length, result.summary).toBeGreaterThan(0);
  return { doc: result.document, id };
}

describe('clothoid geometry', () => {
  it('matches the Fresnel series for A^2 = R L', () => {
    const radius = 200;
    const length = 80;
    const a2 = radius * length;
    const [x, y] = clothoidLocal(length, radius, length);
    const theta = length ** 2 / (2 * a2);
    expect(x).toBeCloseTo(length - length ** 5 / (40 * a2 ** 2), 2);
    expect(y).toBeCloseTo(length ** 3 / (6 * a2) - length ** 7 / (336 * a2 ** 3), 2);
    expect(x).toBeCloseTo(length * (1 - theta ** 2 / 10 + theta ** 4 / 216 - theta ** 6 / 9360), 8);
    expect(y).toBeCloseTo(length * (theta / 3 - theta ** 3 / 42 + theta ** 5 / 1320 - theta ** 7 / 75600), 8);
  });
  it('computes shift, tangent length and arc angle', () => {
    const curve = spiralCurve(R, LS, Math.PI / 2);
    expect(curve).not.toBeNull();
    const c = curve as NonNullable<typeof curve>;
    expect(c.theta).toBeCloseTo(0.3, 12);
    expect(c.shift).toBeCloseTo(c.ys - R * (1 - Math.cos(0.3)), 12);
    expect(c.shift).toBeCloseTo(LS ** 2 / (24 * R), 2);
    expect(c.tangent).toBeCloseTo((R + c.shift) * Math.tan(Math.PI / 4) + c.k, 12);
    expect(c.arcAngle).toBeCloseTo(Math.PI / 2 - 0.6, 12);
    expect(spiralCurve(R, LS, 0.5)).toBeNull();
    expect(spiralCurve(R, LS, 0.6)).not.toBeNull();
  });
  it('builds line, spiral, arc, spiral, line with continuous position and heading', () => {
    const input = { points: POINTS, radii: [R], spirals: [LS], startStation: 1000 };
    const elements = horizontalElements(input);
    expect(elements.map((e) => e.kind)).toEqual(['line', 'spiral', 'arc', 'spiral', 'line']);
    const curve = spiralCurve(R, LS, Math.PI / 2) as NonNullable<ReturnType<typeof spiralCurve>>;
    const [entry, arc, exit] = elements.slice(1, 4) as [SpiralElement, ArcElement, SpiralElement];
    expect(entry.start[0]).toBeCloseTo(300 - curve.tangent, 9);
    expect(entry.radiusStart).toBe(Infinity);
    expect(entry.radiusEnd).toBe(R);
    expect(exit.radiusStart).toBe(R);
    expect(exit.radiusEnd).toBe(Infinity);
    expect(exit.end[1]).toBeCloseTo(curve.tangent, 9);
    expect(arc.length).toBeCloseTo(R * (Math.PI / 2 - 0.6), 9);
    expect(entry.length).toBe(LS);
    expect(entry.pi).toEqual([300, 300 - 300 + 0]);
    for (let i = 0; i + 1 < elements.length; i++) {
      const a = elements[i] as (typeof elements)[number];
      const b = elements[i + 1] as (typeof elements)[number];
      expect(b.start[0]).toBeCloseTo(a.end[0], 9);
      expect(b.start[1]).toBeCloseTo(a.end[1], 9);
      expect(b.startStation).toBeCloseTo(a.startStation + a.length, 9);
      const before = pointAtStation(input, b.startStation - 1e-7);
      const after = pointAtStation(input, b.startStation + 1e-7);
      expect(before?.direction).toBeCloseTo(after?.direction ?? NaN, 6);
      expect(before?.point[0]).toBeCloseTo(after?.point[0] ?? NaN, 5);
    }
    const sc = pointAtStation(input, entry.startStation + LS);
    expect(sc?.direction).toBeCloseTo(0.3, 9);
    expect(sc?.point[0]).toBeCloseTo(arc.start[0], 9);
    const st = pointAtStation(input, exit.startStation + LS);
    expect(st?.direction).toBeCloseTo(Math.PI / 2, 9);
    const end = elements[4] as (typeof elements)[number];
    expect(end.start[1]).toBeCloseTo(curve.tangent, 9);
  });
  it('has curvature linear in station and 1/R on the circle', () => {
    const input = { points: POINTS, radii: [R], spirals: [LS], startStation: 0 };
    const [, entry, arc, exit] = horizontalElements(input) as [unknown, SpiralElement, ArcElement, SpiralElement];
    const curvature = (station: number): number => {
      const h = 1e-4;
      const a = pointAtStation(input, station - h)?.direction ?? NaN;
      const b = pointAtStation(input, station + h)?.direction ?? NaN;
      return (b - a) / (2 * h);
    };
    for (const fraction of [0.1, 0.25, 0.5, 0.9]) {
      expect(curvature(entry.startStation + LS * fraction)).toBeCloseTo(fraction / R, 6);
      expect(curvature(exit.startStation + LS * fraction)).toBeCloseTo((1 - fraction) / R, 6);
    }
    expect(curvature(arc.startStation + arc.length / 2)).toBeCloseTo(1 / R, 6);
  });
  it('finds the station and offset of a point beside a spiral and densifies it', () => {
    const input = { points: POINTS, radii: [R], spirals: [LS], startStation: 0 };
    const [, entry] = horizontalElements(input) as [unknown, SpiralElement];
    const at = pointAtStation(input, entry.startStation + 25);
    const placed = at as NonNullable<typeof at>;
    const left: [number, number] = [placed.point[0] - Math.sin(placed.direction) * 3, placed.point[1] + Math.cos(placed.direction) * 3];
    const found = stationOffset(input, left);
    expect(found?.station).toBeCloseTo(entry.startStation + 25, 5);
    expect(found?.offset).toBeCloseTo(3, 5);
    const polyline = centrelinePoints(input);
    expect(polyline.length).toBeGreaterThan(8);
    const stations = sampleStations(input, 50);
    expect(stations).toContain(entry.startStation);
    expect(stations).toContain(entry.startStation + LS);
  });
  it('refuses spirals the deflection cannot hold or the legs cannot fit', () => {
    const shallow: [number, number][] = [
      [0, 0],
      [300, 0],
      [600, 52],
    ];
    expect(validateHorizontal(shallow, [R], [LS])).toMatch(/smaller than twice the spiral angle/);
    expect(validateHorizontal(shallow, [R], [0])).toBeNull();
    expect(validateHorizontal(POINTS, [0], [LS])).toMatch(/needs a curve radius/);
    expect(validateHorizontal(POINTS, [R], [LS, 5])).toMatch(/spirals needs 1 value/);
    expect(validateHorizontal(POINTS, [R], [-1])).toMatch(/spirals must be finite/);
    const short: [number, number][] = [
      [0, 0],
      [100, 0],
      [100, 300],
    ];
    expect(validateHorizontal(short, [R], [LS])).toMatch(/total .* but the leg is only/);
    const doubled = execute(surveyedDocument(flat2, 31, 20), 'add_alignment', { points: shallow, radii: [R], spirals: [LS] });
    expect(doubled.affected).toEqual([]);
    expect(doubled.summary).toMatch(/add_alignment failed: PI 1/);
  });
});

describe('alignment commands with spirals', () => {
  it('stores spirals, edits them and keeps old documents unchanged', () => {
    const { doc, id } = spiralDoc();
    expect(alignmentOf(doc, id).spirals).toEqual([LS]);
    const edited = execute(doc, 'update_alignment', { alignmentId: id, spirals: [40] });
    expect(alignmentOf(edited.document, id).spirals).toEqual([40]);
    expect(edited.affected).toContain(`${id}:centreline`);
    const removed = execute(edited.document, 'update_alignment', { alignmentId: id, spirals: [0] });
    expect(alignmentOf(removed.document, id).spirals).toBeUndefined();
    const kept = execute(doc, 'update_alignment', { alignmentId: id, name: 'Renamed' });
    expect(alignmentOf(kept.document, id).spirals).toEqual([LS]);
    const noCurve = execute(doc, 'update_alignment', { alignmentId: id, radii: [0] });
    expect(alignmentOf(noCurve.document, id).spirals).toBeUndefined();
    const refused = execute(doc, 'update_alignment', { alignmentId: id, spirals: [500] });
    expect(refused.affected).toEqual([]);
  });
  it('labels TS / SC / CS / ST and omits PC / PT on a spiralled curve', () => {
    const { doc, id } = spiralDoc();
    const texts = Object.values(doc.entities)
      .filter((entity) => entity.id.startsWith(`${id}:`) && entity.kind === 'text')
      .map((entity) => (entity as unknown as { content: string }).content);
    expect(texts.filter((t) => /^(TS|SC|CS|ST) /.test(t))).toHaveLength(4);
    expect(texts.some((t) => t.startsWith('PC '))).toBe(false);
    expect(texts).toContain('R=100');
  });
  it('is pure and identical to before without spirals', () => {
    const plain = surveyedDocument(flat2, 31, 20);
    const created = execute(plain, 'add_alignment', { points: POINTS, radii: [R] });
    const id = (created.data as { alignmentId: string }).alignmentId;
    expect('spirals' in alignmentOf(created.document, id)).toBe(false);
    const elements = horizontalElements(alignmentOf(created.document, id));
    expect(elements.map((e) => e.kind)).toEqual(['line', 'arc', 'line']);
    const zeros = execute(plain, 'add_alignment', { points: POINTS, radii: [R], spirals: [0] });
    expect(JSON.stringify(zeros.document.civil)).toBe(JSON.stringify(created.document.civil));
    const { doc } = spiralDoc();
    expectPure(doc, () => {
      execute(doc, 'update_alignment', { alignmentId: id, spirals: [30] });
      execute(doc, 'set_superelevation', { alignmentId: 'alignment-1', maxRate: 0.06 });
    });
  });
});

describe('superelevation', () => {
  const alignment = (): AlignmentObject => {
    const { doc, id } = designedSpiral();
    return alignmentOf(doc, id);
  };
  it('follows crown, runout, runoff, full rate and back', () => {
    const a = alignment();
    const [, entry, arc, exit] = horizontalElements(a) as [unknown, SpiralElement, ArcElement, SpiralElement];
    const c = 0.025;
    const at = (s: number): ReturnType<typeof crossSlopesAt> => crossSlopesAt(a, c, 3.5, s);
    expect(at(10)).toEqual({ left: c, right: c });
    const runout = (c * LS) / 0.07;
    expect(at(entry.startStation - runout - 1)).toEqual({ left: c, right: c });
    const flat2 = at(entry.startStation);
    expect(flat2.right).toBeCloseTo(0, 12);
    expect(flat2.left).toBeCloseTo(c, 12);
    const crown = at(entry.startStation - runout);
    expect(crown.right).toBeCloseTo(c, 12);
    const reversed = at(entry.startStation + runout);
    expect(reversed.right).toBeCloseTo(-c, 12);
    expect(reversed.left).toBeCloseTo(c, 12);
    const half = at(entry.startStation + LS / 2);
    expect(half.right).toBeCloseTo(-0.035, 12);
    expect(half.left).toBeCloseTo(0.035, 12);
    const full = at(arc.startStation + arc.length / 2);
    expect(full).toEqual({ left: 0.07, right: -0.07 });
    expect(at(exit.startStation).right).toBeCloseTo(-0.07, 12);
    expect(at(exit.startStation + LS).right).toBeCloseTo(0, 12);
    expect(at(exit.startStation + LS + runout + 1)).toEqual({ left: c, right: c });
    expect(superelevationRate(full)).toBe(0.07);
    expect(superelevationRate(at(10))).toBe(0);
    const keys = superelevationStations(a, c, 3.5);
    expect(keys).toContain(entry.startStation);
    expect(keys).toContain(arc.startStation);
  });
  it('banks right-hand curves the other way and raises a low rate to the crossfall', () => {
    const right = { ...alignment(), points: [POINTS[0], POINTS[1], [300, -300]] } as AlignmentObject;
    const arc = horizontalElements(right).find((e) => e.kind === 'arc') as ArcElement;
    const slopes = crossSlopesAt(right, 0.025, 3.5, arc.startStation + arc.length / 2);
    expect(slopes).toEqual({ left: -0.07, right: 0.07 });
    const low = { ...right, superelevation: { maxRate: 0.01 } } as AlignmentObject;
    const lowSlopes = crossSlopesAt(low, 0.025, 3.5, arc.startStation + arc.length / 2);
    expect(lowSlopes.left).toBeCloseTo(-0.025, 12);
  });
  it('uses a 0.5 % relative gradient runoff and 30 % inside a curve without spirals', () => {
    const plain = surveyedDocument(flat2, 31, 20);
    const created = execute(plain, 'add_alignment', { points: POINTS, radii: [R] });
    const id = (created.data as { alignmentId: string }).alignmentId;
    const set = execute(created.document, 'set_superelevation', { alignmentId: id, maxRate: 0.07 });
    const a = alignmentOf(set.document, id);
    const arc = horizontalElements(a).find((e) => e.kind === 'arc') as ArcElement;
    const runoff = (0.07 * 3.5) / 0.005;
    const fullAt = arc.startStation + 0.3 * runoff;
    expect(crossSlopesAt(a, 0.025, 3.5, fullAt).right).toBeCloseTo(-0.07, 9);
    expect(crossSlopesAt(a, 0.025, 3.5, fullAt - runoff).right).toBeCloseTo(0, 9);
    const custom = execute(set.document, 'set_superelevation', { alignmentId: id, maxRate: 0.05, runoffLength: 20 });
    const b = alignmentOf(custom.document, id);
    expect(b.superelevation).toEqual({ maxRate: 0.05, runoffLength: 20 });
    expect(crossSlopesAt(b, 0.025, 3.5, arc.startStation + 6).right).toBeCloseTo(-0.05, 9);
    expect(custom.summary).toContain('runoff 20 m');
  });
  it('gives the corridor a cross slope of maxRate on the circle', () => {
    const { doc, id } = designedSpiral();
    const a = alignmentOf(doc, id);
    const arc = horizontalElements(a).find((e) => e.kind === 'arc') as ArcElement;
    const station = arc.startStation + arc.length / 2;
    const cross = crossSectionAt(a, a.section as NonNullable<typeof a.section>, null, station, 101, 1);
    const nodes = cross?.template ?? [];
    const slope = (i: number, j: number): number =>
      ((nodes[j]?.z ?? NaN) - (nodes[i]?.z ?? NaN)) / ((nodes[j]?.offset ?? NaN) - (nodes[i]?.offset ?? NaN));
    expect(slope(0, 2)).toBeCloseTo(-0.07, 12);
    expect(slope(2, 4)).toBeCloseTo(-0.07, 12);
    expect(nodes[0]?.z).toBeCloseTo(101 + 0.07 * 4.5, 12);
    expect(nodes[4]?.z).toBeCloseTo(101 - 0.07 * 4.5, 12);
    const mesh = doc.entities[`${id}:corridor`] as MeshSolidEntity;
    const zs = mesh.mesh.positions.filter((_, i) => i % 3 === 2);
    expect(Math.max(...zs)).toBeCloseTo(101 + 0.07 * 4.5, 6);
    expect(Math.min(...zs)).toBeCloseTo(101 - 0.07 * 4.5, 6);
  });
  it('reports superelevationPercent per row and changes the section areas', () => {
    const { doc, id } = designedSpiral();
    const rows = (
      execute(doc, 'alignment_report', { alignmentId: id, interval: 10 }).data as {
        rows: Array<{ station: number; superelevationPercent: number | null; fillAreaM2: number }>;
        csv: string;
      }
    ).rows;
    expect(rows[0]?.superelevationPercent).toBe(0);
    const peak = rows.find((row) => Math.abs(row.station - 390) < 1e-6);
    expect(Math.abs(peak?.superelevationPercent ?? 0)).toBeGreaterThan(0);
    expect(Math.max(...rows.map((r) => r.superelevationPercent ?? 0))).toBe(7);
    const plain = execute(doc, 'set_superelevation', { alignmentId: id, maxRate: 0 });
    const plainData = execute(plain.document, 'alignment_report', { alignmentId: id, interval: 10 }).data as {
      rows: Array<{ superelevationPercent: number | null; fillAreaM2: number }>;
      csv: string;
    };
    expect(plainData.rows.every((row) => row.superelevationPercent === null)).toBe(true);
    expect(plainData.csv.split('\n')[0]).toContain('superelevationPercent');
    const withAreas = rows.map((r) => r.fillAreaM2).join();
    const withoutAreas = plainData.rows.map((r) => r.fillAreaM2).join();
    expect(withAreas).not.toBe(withoutAreas);
  });
  it('sets, replaces and removes the design with clear failures', () => {
    const { doc, id } = spiralDoc();
    const set = execute(doc, 'set_superelevation', { alignmentId: id, maxRate: 0.07 });
    expect(set.summary).toContain('7.00 %');
    expect(set.affected.length).toBeGreaterThan(0);
    expect(execute(set.document, 'set_superelevation', { alignmentId: id, maxRate: 0.07 }).affected).toEqual([]);
    const removed = execute(set.document, 'set_superelevation', { alignmentId: id, maxRate: 0 });
    expect(removed.summary).toContain('Removed superelevation (was 7.00 %)');
    expect(alignmentOf(removed.document, id).superelevation).toBeUndefined();
    for (const params of [
      { alignmentId: 'nope', maxRate: 0.07 },
      { alignmentId: id, maxRate: 0.4 },
      { alignmentId: id, maxRate: -0.01 },
      { alignmentId: id, maxRate: 0.07, runoffLength: 0 },
    ]) {
      expectNoOp(execute(doc, 'set_superelevation', params), doc);
    }
    const kept = execute(set.document, 'update_alignment', { alignmentId: id, name: 'X' });
    expect(alignmentOf(kept.document, id).superelevation).toEqual({ maxRate: 0.07 });
  });
  it('survives save / load and rejects corrupt spirals or superelevation', () => {
    const { doc, id } = designedSpiral();
    expectSaveLoadRoundTrip(doc, id);
    const withObject = (patch: Record<string, unknown>): NonNullable<CadDocument['civil']> => {
      const civil = doc.civil as NonNullable<typeof doc.civil>;
      return { ...civil, objects: { ...civil.objects, [id]: { ...alignmentOf(doc, id), ...patch } } };
    };
    expect(civilErrors(withObject({ spirals: 'x' })).join()).toMatch(/spirals must be numbers/);
    expect(civilErrors(withObject({ spirals: [5, 5] })).join()).toMatch(/spirals needs 1 value/);
    expect(civilErrors(withObject({ superelevation: { maxRate: 0.5 } })).join()).toMatch(/superelevation needs/);
    expect(civilErrors(withObject({ superelevation: { maxRate: 0.06, runoffLength: -1 } })).join()).toMatch(/superelevation needs/);
    expect(civilErrors(withObject({ superelevation: 3 })).join()).toMatch(/superelevation needs/);
    expect(civilErrors(withObject({}))).toEqual([]);
  });
});

describe('design checks and LandXML', () => {
  it('checks spiral length (Barnett) and required superelevation against maxRate', () => {
    const { doc, id } = designedSpiral(0.04);
    interface Report {
      checks: {
        assumptions: string;
        spirals: Array<{ lengthM: number; minLengthM: number; ok: boolean }>;
        horizontal: Array<{ requiredSuperelevation: number; ok: boolean }>;
        failures: string[];
      };
    }
    const run = (speed: number): Report => execute(doc, 'alignment_report', { alignmentId: id, designSpeedKmh: speed }).data as Report;
    const slow = run(40).checks;
    expect(slow.spirals).toHaveLength(2);
    expect(slow.spirals[0]?.minLengthM).toBeCloseTo(40 ** 3 / (46.656 * 0.6 * 100), 1);
    expect(slow.spirals.every((s) => s.ok)).toBe(true);
    expect(slow.assumptions).toContain('46.656 C R');
    expect(slow.assumptions).toContain('e = 0.04');
    const fast = run(80).checks;
    expect(fast.spirals.every((s) => !s.ok)).toBe(true);
    expect(fast.failures.some((f) => f.startsWith('Spiral at'))).toBe(true);
    expect(fast.failures.some((f) => f.includes('needs e='))).toBe(true);
    expect(fast.horizontal[0]?.requiredSuperelevation).toBeGreaterThan(0.04);
  });
  it('writes Spiral / Curve / Spiral elements to LandXML', () => {
    const { doc } = spiralDoc();
    const text = (execute(doc, 'export_landxml', { date: '2026-10-09' }).data as { text: string }).text;
    const spirals = text.match(/<Spiral [^>]*>/g) ?? [];
    expect(spirals).toHaveLength(2);
    for (const s of ['radiusStart="INF" radiusEnd="100"', 'length="60"', 'rot="ccw" spiType="clothoid"', 'theta="17.188734"'])
      expect(spirals[0]).toContain(s);
    expect(spirals[1]).toContain('radiusStart="100" radiusEnd="INF"');
    expect(text).toContain('</Spiral>');
    expect(text.indexOf('<Spiral')).toBeLessThan(text.indexOf('<Curve'));
    expect(text.lastIndexOf('<Spiral')).toBeGreaterThan(text.indexOf('<Curve'));
    expect(text).toMatch(/<Spiral [^>]*><Start>[^<]+<\/Start><PI>[^<]+<\/PI><End>[^<]+<\/End><\/Spiral>/);
  });
});

describe('set_alignment_profile end snapping', () => {
  it('snaps a PVI typed from a rounded end station onto the alignment end', async () => {
    const { execute } = await import('@core/commands/registry');
    const { metricDocument } = await import('./fixtures');
    const doc = execute(metricDocument(), 'add_alignment', { points: xy(0, 0, 100.0135, 0) }).document;
    const snapped = execute(doc, 'set_alignment_profile', {
      alignmentId: 'alignment-1',
      pvis: [
        { station: 0, elevation: 10 },
        { station: 100.05, elevation: 11 },
      ],
    });
    const alignment = snapped.document.civil?.objects['alignment-1'];
    expect(alignment?.category === 'alignment' && alignment.profile[1]?.station).toBeCloseTo(100.0135, 9);
    const far = execute(doc, 'set_alignment_profile', {
      alignmentId: 'alignment-1',
      pvis: [
        { station: 0, elevation: 10 },
        { station: 100.2, elevation: 11 },
      ],
    });
    expect(far.document).toBe(doc);
    expect(far.summary).toMatch(/alignment runs 0 to 100.0135/);
  });
});
