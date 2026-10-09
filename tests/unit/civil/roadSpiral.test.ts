import { describe, expect, it } from 'vitest';
import type { CadDocument, MeshSolidEntity } from '@core/model/types';
import type { AlignmentObject } from '@core/model/civil';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence';
import {
  horizontalElements,
  pointAtStation,
  centrelinePoints,
  sampleStations,
  stationOffset,
  validateHorizontal,
  type SpiralElement,
  type ArcElement,
} from '@aec/civil/alignmentGeometry';
import { clothoidLocal, spiralCurve } from '@aec/civil/alignmentSpiral';
import {
  crossSlopesAt,
  superelevationRate,
  superelevationStations,
} from '@aec/civil/superelevation';
import { crossSectionAt } from '@aec/civil/roadSection';
import { civilErrors } from '@aec/civil/validate';
import { surveyedDocument } from './fixtures';

const R = 100;
const LS = 60;
const POINTS: [number, number][] = [
  [0, 0],
  [300, 0],
  [300, 300],
];
const flat = (): number => 100;

function spiralDoc(extra: Record<string, unknown> = {}): { doc: CadDocument; id: string } {
  const base = surveyedDocument(flat, 31, 20);
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

const alignmentOf = (doc: CadDocument, id: string): AlignmentObject =>
  doc.civil?.objects[id] as AlignmentObject;

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
    expect(y).toBeCloseTo(
      length * (theta / 3 - theta ** 3 / 42 + theta ** 5 / 1320 - theta ** 7 / 75600),
      8,
    );
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
    const [, entry, arc, exit] = horizontalElements(input) as [
      unknown,
      SpiralElement,
      ArcElement,
      SpiralElement,
    ];
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
    const left: [number, number] = [
      placed.point[0] - Math.sin(placed.direction) * 3,
      placed.point[1] + Math.cos(placed.direction) * 3,
    ];
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
    const doubled = execute(surveyedDocument(flat, 31, 20), 'add_alignment', {
      points: shallow,
      radii: [R],
      spirals: [LS],
    });
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
    const plain = surveyedDocument(flat, 31, 20);
    const created = execute(plain, 'add_alignment', { points: POINTS, radii: [R] });
    const id = (created.data as { alignmentId: string }).alignmentId;
    expect('spirals' in alignmentOf(created.document, id)).toBe(false);
    const elements = horizontalElements(alignmentOf(created.document, id));
    expect(elements.map((e) => e.kind)).toEqual(['line', 'arc', 'line']);
    const zeros = execute(plain, 'add_alignment', { points: POINTS, radii: [R], spirals: [0] });
    expect(JSON.stringify(zeros.document.civil)).toBe(JSON.stringify(created.document.civil));
    const { doc } = spiralDoc();
    const before = JSON.stringify(doc);
    execute(doc, 'update_alignment', { alignmentId: id, spirals: [30] });
    execute(doc, 'set_superelevation', { alignmentId: 'alignment-1', maxRate: 0.06 });
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe('superelevation', () => {
  const alignment = (): AlignmentObject => {
    const { doc, id } = designedSpiral();
    return alignmentOf(doc, id);
  };

  it('follows crown, runout, runoff, full rate and back', () => {
    const a = alignment();
    const [, entry, arc, exit] = horizontalElements(a) as [
      unknown,
      SpiralElement,
      ArcElement,
      SpiralElement,
    ];
    const c = 0.025;
    const at = (s: number): ReturnType<typeof crossSlopesAt> => crossSlopesAt(a, c, 3.5, s);
    expect(at(10)).toEqual({ left: c, right: c });
    const runout = (c * LS) / 0.07;
    expect(at(entry.startStation - runout - 1)).toEqual({ left: c, right: c });
    const flat = at(entry.startStation);
    expect(flat.right).toBeCloseTo(0, 12);
    expect(flat.left).toBeCloseTo(c, 12);
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
    const right = {
      ...alignment(),
      points: [POINTS[0], POINTS[1], [300, -300]],
    } as AlignmentObject;
    const arc = horizontalElements(right).find((e) => e.kind === 'arc') as ArcElement;
    const slopes = crossSlopesAt(right, 0.025, 3.5, arc.startStation + arc.length / 2);
    expect(slopes).toEqual({ left: -0.07, right: 0.07 });
    const low = { ...right, superelevation: { maxRate: 0.01 } } as AlignmentObject;
    const lowSlopes = crossSlopesAt(low, 0.025, 3.5, arc.startStation + arc.length / 2);
    expect(lowSlopes.left).toBeCloseTo(-0.025, 12);
  });

  it('uses a 0.5 % relative gradient runoff and 30 % inside a curve without spirals', () => {
    const plain = surveyedDocument(flat, 31, 20);
    const created = execute(plain, 'add_alignment', { points: POINTS, radii: [R] });
    const id = (created.data as { alignmentId: string }).alignmentId;
    const set = execute(created.document, 'set_superelevation', { alignmentId: id, maxRate: 0.07 });
    const a = alignmentOf(set.document, id);
    const arc = horizontalElements(a).find((e) => e.kind === 'arc') as ArcElement;
    const runoff = (0.07 * 3.5) / 0.005;
    const fullAt = arc.startStation + 0.3 * runoff;
    expect(crossSlopesAt(a, 0.025, 3.5, fullAt).right).toBeCloseTo(-0.07, 9);
    expect(crossSlopesAt(a, 0.025, 3.5, fullAt - runoff).right).toBeCloseTo(0, 9);
    const custom = execute(set.document, 'set_superelevation', {
      alignmentId: id,
      maxRate: 0.05,
      runoffLength: 20,
    });
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
    const cross = crossSectionAt(
      a,
      a.section as NonNullable<typeof a.section>,
      null,
      station,
      101,
      1,
    );
    const nodes = cross?.template ?? [];
    const slope = (i: number, j: number): number =>
      ((nodes[j]?.z ?? NaN) - (nodes[i]?.z ?? NaN)) /
      ((nodes[j]?.offset ?? NaN) - (nodes[i]?.offset ?? NaN));
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
    const plainData = execute(plain.document, 'alignment_report', { alignmentId: id, interval: 10 })
      .data as {
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
    expect(
      execute(set.document, 'set_superelevation', { alignmentId: id, maxRate: 0.07 }).affected,
    ).toEqual([]);
    const removed = execute(set.document, 'set_superelevation', { alignmentId: id, maxRate: 0 });
    expect(removed.summary).toContain('Removed superelevation (was 7.00 %)');
    expect(alignmentOf(removed.document, id).superelevation).toBeUndefined();
    for (const params of [
      { alignmentId: 'nope', maxRate: 0.07 },
      { alignmentId: id, maxRate: 0.4 },
      { alignmentId: id, maxRate: -0.01 },
      { alignmentId: id, maxRate: 0.07, runoffLength: 0 },
    ]) {
      const result = execute(doc, 'set_superelevation', params);
      expect(result.affected).toEqual([]);
      expect(result.document).toBe(doc);
    }
    const kept = execute(set.document, 'update_alignment', { alignmentId: id, name: 'X' });
    expect(alignmentOf(kept.document, id).superelevation).toEqual({ maxRate: 0.07 });
  });

  it('survives save / load and rejects corrupt spirals or superelevation', () => {
    const { doc, id } = designedSpiral();
    const loaded = deserializeDocument(serializeDocument(doc));
    expect(alignmentOf(loaded, id)).toEqual(alignmentOf(doc, id));
    expect(Object.keys(loaded.entities).sort()).toEqual(Object.keys(doc.entities).sort());
    const report = (d: CadDocument): unknown =>
      execute(d, 'alignment_report', { alignmentId: id }).data;
    expect(report(loaded)).toEqual(report(doc));
    const withObject = (patch: Record<string, unknown>): NonNullable<CadDocument['civil']> => {
      const civil = doc.civil as NonNullable<typeof doc.civil>;
      return {
        ...civil,
        objects: { ...civil.objects, [id]: { ...alignmentOf(doc, id), ...patch } },
      };
    };
    expect(civilErrors(withObject({ spirals: 'x' })).join()).toMatch(/spirals must be numbers/);
    expect(civilErrors(withObject({ spirals: [5, 5] })).join()).toMatch(/spirals needs 1 value/);
    expect(civilErrors(withObject({ superelevation: { maxRate: 0.5 } })).join()).toMatch(
      /superelevation needs/,
    );
    expect(
      civilErrors(withObject({ superelevation: { maxRate: 0.06, runoffLength: -1 } })).join(),
    ).toMatch(/superelevation needs/);
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
    const run = (speed: number): Report =>
      execute(doc, 'alignment_report', { alignmentId: id, designSpeedKmh: speed }).data as Report;
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
    const text = (execute(doc, 'export_landxml', { date: '2026-10-09' }).data as { text: string })
      .text;
    const spirals = text.match(/<Spiral [^>]*>/g) ?? [];
    expect(spirals).toHaveLength(2);
    expect(spirals[0]).toContain('radiusStart="INF" radiusEnd="100"');
    expect(spirals[0]).toContain('length="60"');
    expect(spirals[0]).toContain('rot="ccw" spiType="clothoid"');
    expect(spirals[0]).toContain('theta="17.188734"');
    expect(spirals[1]).toContain('radiusStart="100" radiusEnd="INF"');
    expect(text).toContain('</Spiral>');
    expect(text.indexOf('<Spiral')).toBeLessThan(text.indexOf('<Curve'));
    expect(text.lastIndexOf('<Spiral')).toBeGreaterThan(text.indexOf('<Curve'));
    expect(text).toMatch(
      /<Spiral [^>]*><Start>[^<]+<\/Start><PI>[^<]+<\/PI><End>[^<]+<\/End><\/Spiral>/,
    );
  });
});

describe('set_alignment_profile end snapping', () => {
  it('snaps a PVI typed from a rounded end station onto the alignment end', async () => {
    const { execute } = await import('@core/commands/registry');
    const { metricDocument } = await import('./fixtures');
    const doc = execute(metricDocument(), 'add_alignment', {
      points: [
        [0, 0],
        [100.0135, 0],
      ],
    }).document;
    const snapped = execute(doc, 'set_alignment_profile', {
      alignmentId: 'alignment-1',
      pvis: [
        { station: 0, elevation: 10 },
        { station: 100.05, elevation: 11 },
      ],
    });
    const alignment = snapped.document.civil?.objects['alignment-1'];
    expect(alignment?.category === 'alignment' && alignment.profile[1]?.station).toBeCloseTo(
      100.0135,
      9,
    );
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
