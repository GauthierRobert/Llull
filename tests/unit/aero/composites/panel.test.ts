import { describe, expect, it } from 'vitest';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { derivedEntityIds } from '@core/plugins/host';
import type { CadDocument } from '@core/model/types';
import { apply, data, expectRefusal } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { BASE, HOLE, PAD, panel, panelPart } from './fixtures';

interface Sample {
  plyCount: number;
  thickness: number;
  laminate: string;
  unverified: boolean;
  plies: { name: string; sequence: string; angleRosetteDeg: number; angleGlobalDeg: number; z0: number; z1: number }[];
}

const countAt = (doc: CadDocument, part: string, x: number, y: number): number =>
  data<Sample>(doc, 'core_sample', { part, point: [x, y, 0] }).plyCount;

describe('flat skin panel with zones (VC-CMP-10, 11, 18)', () => {
  it('blends 8 / 16 / 24 ply zones into 24 master plies with deterministic ids', () => {
    const { doc, part } = panel();
    const plies = Object.values(doc.composites?.plies ?? {}).filter((ply) => ply.partId === part);
    expect(plies).toHaveLength(24);
    expect(plies.map((ply) => ply.name)).toEqual(Array.from({ length: 24 }, (_, i) => `S${i + 1}`));
    expect(plies.every((ply) => /^ply-\d+\.\d+$/.test(ply.id))).toBe(true);
    expect(plies.map((ply) => ply.order)).toEqual(Array.from({ length: 24 }, (_, i) => i));
  });

  it('core samples give 8 plies / 1.0 mm in the base zone and 24 plies / 3.0 mm at the hole', () => {
    const { doc, part } = panel();
    const base = data<Sample>(doc, 'core_sample', { part, point: [50, 50, 0] });
    expect(base.plyCount).toBe(8);
    expect(base.thickness).toBeCloseTo(1, 12);
    expect(base.plies.map((ply) => ply.angleRosetteDeg)).toEqual([45, -45, 0, 90, 90, 0, -45, 45]);
    expect(base.plies[3]?.z1).toBeCloseTo(0.5, 12);
    expect(base.laminate).toBe('[+-45/0/90]s');
    const hole = data<Sample>(doc, 'core_sample', { part, point: [300, 200, 0] });
    expect(hole.plyCount).toBe(24);
    expect(hole.thickness).toBeCloseTo(3, 12);
    expect(hole.plies[0]?.angleGlobalDeg).toBeCloseTo(45, 9);
    expect(hole.plies.map((ply) => ply.sequence)).toEqual(Array.from({ length: 24 }, (_, i) => `S${i + 1}`));
    expect(countAt(doc, part, 220, 120)).toBe(16);
  });

  it('ends the k-th dropped ply k * t * ramp ratio (2.5 mm steps) outside the full-thickness boundary', () => {
    const { doc, part } = panel();
    // Pad edge x = 200: 8 base plies + the 8 pad-only plies whose ramp (2.5 k mm) still reaches the point.
    expect([199, 197, 194, 185, 180.1, 179].map((x) => countAt(doc, part, x, 200))).toEqual([16, 15, 14, 11, 9, 8]);
    // Hole edge x = 260, inside the pad: 16 pad plies + hole-only plies with ramp >= distance.
    expect([259, 250, 241, 235].map((x) => countAt(doc, part, x, 200))).toEqual([24, 21, 17, 16]);
  });

  it('reports the laminate mass as the sum of ply piece area x thickness x density (ramps included)', () => {
    const { doc, part } = panel();
    const mass = data<{ mass: number; volume: number; area: number; plyCount: number; unverified: boolean }>(doc, 'laminate_mass', {
      part,
    });
    expect(mass.plyCount).toBe(24);
    const plies = Object.values(doc.composites?.plies ?? {});
    const areas = plies.map((ply) =>
      ply.boundary.kind === 'polygons' ? ply.boundary.polygons.reduce((sum, polygon) => sum + areaOf(polygon), 0) : 600 * 400,
    );
    expect(mass.area).toBeCloseTo(
      areas.reduce((a, b) => a + b, 0),
      6,
    );
    expect(mass.mass).toBeCloseTo(mass.volume * 0.0016, 9);
    expect(mass.volume).toBeCloseTo(mass.area * 0.125, 9);
    // The 8 base-wide plies alone weigh 600 x 400 x 1.0 mm x 0.0016 g/mm^3 = 384 g.
    expect(areas.filter((a) => a === 600 * 400)).toHaveLength(8);
    expect((600 * 400 * 1.0 * 0.0016).toFixed(1)).toBe('384.0');
    expect(mass.unverified).toBe(false);
  });

  it('refuses unblendable zones, naming both zones', () => {
    const { doc, part } = panelPart();
    let next = apply(doc, 'define_zone', { part, ...BASE });
    next = apply(next, 'define_zone', { part, name: 'Z-odd', boundary: PAD.boundary, laminate: '[0/90]s', priority: 1 });
    next = apply(next, 'define_zone', { part, name: 'Z-b', boundary: HOLE.boundary, laminate: '[45/-45]s', priority: 2 });
    const refused = expectRefusal(next, 'generate_plies_from_zones', { part, material: 'T300_5208' }, 'CMP_ZONES_NOT_BLENDABLE');
    expect(refused.error?.ids).toHaveLength(2);
    expect(refused.summary).toContain('Z-');
  });

  it('refuses equally thick zones with different stacks and ramps that do not fit', () => {
    const { doc, part } = panelPart();
    let next = apply(doc, 'define_zone', { part, name: 'A', boundary: BASE.boundary, laminate: '[0/90]s', priority: 0 });
    next = apply(next, 'define_zone', { part, name: 'B', boundary: HOLE.boundary, laminate: '[90/0]s', priority: 1 });
    expectRefusal(next, 'generate_plies_from_zones', { part, material: 'T300_5208' }, 'CMP_ZONES_EQUAL_THICKNESS_CONFLICT');
    // Pad and hole only 5 mm apart: the 20 mm ramp of the hole group does not fit.
    let tight = apply(doc, 'define_zone', { part, ...BASE });
    tight = apply(tight, 'define_zone', { part, ...PAD });
    tight = apply(tight, 'define_zone', {
      part,
      ...HOLE,
      boundary: [
        [205, 105],
        [395, 105],
        [395, 295],
        [205, 295],
      ],
    });
    expectRefusal(tight, 'generate_plies_from_zones', { part, material: 'T300_5208' }, 'CMP_RAMP_CONFLICT');
  });

  it('refuses regenerating without replaceGenerated, and replaces when asked', () => {
    const { doc, part } = panel();
    expectRefusal(doc, 'generate_plies_from_zones', { part, material: 'T300_5208' }, 'CMP_PARAM_INVALID');
    const again = apply(doc, 'generate_plies_from_zones', { part, material: 'T300_5208', replaceGenerated: true });
    expect(Object.keys(again.composites?.plies ?? {})).toHaveLength(24);
    expect(Object.keys(again.composites?.plies ?? {})).not.toEqual(Object.keys(doc.composites?.plies ?? {}));
  });

  it('refuses cover plies that a zone drops', () => {
    const { doc, part } = panelPart();
    let next = apply(doc, 'define_zone', { part, ...BASE });
    next = apply(next, 'define_zone', { part, ...PAD, laminate: '[45/-45/0/90/0/-45/45/0]s' });
    next = apply(next, 'set_ply_drop_rules', { part, coverPlies: 5 });
    expectRefusal(next, 'generate_plies_from_zones', { part, material: 'T300_5208' }, 'CMP_COVER_PLIES_DROPPED');
  });

  it('is pure', () => {
    const { doc, part } = panel();
    expectPure(doc, () => data(doc, 'core_sample', { part, point: [50, 50, 0] }));
    expectPure(doc, () => apply(doc, 'generate_plies_from_zones', { part, material: 'T300_5208', replaceGenerated: true }));
  });
});

function areaOf(polygon: readonly (readonly [number, number])[]): number {
  return (
    Math.abs(
      polygon.reduce(
        (sum, [x, y], i) => sum + x * (polygon[(i + 1) % polygon.length]?.[1] ?? 0) - (polygon[(i + 1) % polygon.length]?.[0] ?? 0) * y,
        0,
      ),
    ) / 2
  );
}

describe('derived ply outlines and persistence', () => {
  it('derives one outline polyline per ply piece, omits it from the file and re-derives it on load', () => {
    const { doc, part } = panel();
    const derived = derivedEntityIds(doc);
    expect(derived.size).toBeGreaterThanOrEqual(24);
    for (const id of derived) expect(doc.entities[id]?.kind).toBe('polyline');
    const text = serializeDocument(doc);
    const saved = JSON.parse(text) as { document: { entities: Record<string, unknown> } };
    for (const id of derived) expect(saved.document.entities[id]).toBeUndefined();
    const loaded = deserializeDocument(text);
    expect(loaded.composites).toEqual(doc.composites);
    expect(Object.keys(loaded.entities).sort()).toEqual(Object.keys(doc.entities).sort());
    expect(loaded.entities[[...derived][0] as string]).toEqual(doc.entities[[...derived][0] as string]);
    expect(serializeDocument(loaded)).toBe(text);
    expect(data<Sample>(loaded, 'core_sample', { part, point: [300, 200, 0] }).plyCount).toBe(24);
  });

  it('keeps derived outlines read-only (derivation guard)', () => {
    const { doc } = panel();
    const outline = [...derivedEntityIds(doc)][0] as string;
    const refused = expectRefusal(doc, 'move_entities', { ids: [outline], delta: [5, 0, 0] }, 'CMD_DERIVED_GEOMETRY');
    expect(refused.summary).toContain('derived');
  });

  it('rejects files whose composites slice is malformed', () => {
    const { doc } = panel();
    const text = serializeDocument(doc);
    const broken = (edit: (model: Record<string, Record<string, Record<string, unknown>>>) => void): string => {
      const parsed = JSON.parse(text) as { document: { composites: Record<string, Record<string, Record<string, unknown>>> } };
      edit(parsed.document.composites);
      return JSON.stringify(parsed);
    };
    const materialKey = 'T300_5208';
    expect(() =>
      deserializeDocument(broken((m) => ((m['materials'] as Record<string, Record<string, unknown>>)[materialKey]!['E1'] = -1))),
    ).toThrow(/E1/);
    expect(() =>
      deserializeDocument(broken((m) => ((m['materials'] as Record<string, Record<string, unknown>>)[materialKey]!['nu12'] = 5))),
    ).toThrow(/nu12/);
    const plyId = Object.keys(doc.composites?.plies ?? {})[0] as string;
    expect(() =>
      deserializeDocument(broken((m) => ((m['plies'] as Record<string, Record<string, unknown>>)[plyId]!['materialName'] = 'nope'))),
    ).toThrow(/missing material/);
    expect(() =>
      deserializeDocument(
        broken(
          (m) => ((m['parts'] as Record<string, Record<string, unknown>>)[Object.keys(m['parts'] ?? {})[0] as string]!['outline'] = []),
        ),
      ),
    ).toThrow(/outline/);
  });
});
