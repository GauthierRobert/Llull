import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { recipeKey, recipeOf } from '@core/geometry/shapeRecipe';
import { createEmptyDocument } from '@core/model/types';
import type { SheetMetalPart } from '@core/model/sheetMetal';
import expectedParts from '../../../../docs/aerospace/07-sheet-metal-machined-features/validation/data/expected_test_parts.json';
import { RULE, apply, bracket, data, expectRefusal, folded, meshBounds, meshVolume, ok } from './helpers';

const bracketParts = expectedParts.parts['ftr_bracket_L.step'];

interface FlatData {
  extents: [number, number];
  area: number;
  bends: Array<{ id: string; ba: number; angleDeg: number; direction: string; kFactor: { value: number } }>;
  reviewRequired: boolean;
  unverified: boolean;
}

describe('sheet-metal bracket (VC-FTR-06, VC-FTR-07, VC-FTR-08, VC-FTR-41)', () => {
  it.each([
    [0.33, bracketParts.expected_flat_length_by_K['0.33']],
    [0.44, bracketParts.expected_flat_length_by_K['0.44']],
    [0.5, bracketParts.expected_flat_length_by_K['0.5']],
  ])('flat length at K %s is %s with width 50', (kFactor, length) => {
    const { doc, part } = bracket({ name: `K${kFactor}`, kFactor });
    const flat = data<FlatData>(doc, 'flat_pattern', { id: part });
    expect(Math.abs((flat.extents[0] ?? 0) - length)).toBeLessThan(1e-6);
    expect(flat.extents[1]).toBeCloseTo(50, 9);
    expect(flat.bends).toHaveLength(1);
    expect(flat.bends[0]?.angleDeg).toBeCloseTo(90, 9);
    expect(flat.bends[0]?.direction).toBe('up');
  });

  it('bend allowance of the bracket at K 0.44 is 8.645663', () => {
    const { doc, part } = bracket();
    expect(data<FlatData>(doc, 'flat_pattern', { id: part }).bends[0]?.ba).toBeCloseTo(8.645662983, 6);
  });

  it('folds to the analytic bracket volume (mesh) and bounding box', () => {
    const { doc, part } = bracket();
    expect(Math.abs(meshVolume(doc, part) / bracketParts.analytic_volume_mm3 - 1)).toBeLessThan(1e-3);
    const { min, max } = meshBounds(doc, part);
    expect(min[0]).toBeCloseTo(0, 6);
    expect(max[0]).toBeCloseTo(40, 6);
    expect(min[1]).toBeCloseTo(0, 6);
    expect(max[1]).toBeCloseTo(50, 6);
    expect(min[2]).toBeCloseTo(0, 6);
    expect(max[2]).toBeCloseTo(30, 6);
  });

  it('K = 0.5: flat area x T equals the folded volume (VC-FTR-08)', () => {
    const { doc, part } = bracket({ name: 'K05', kFactor: 0.5 });
    const flat = data<FlatData>(doc, 'flat_pattern', { id: part });
    expect(flat.area * RULE.thickness).toBeCloseTo(bracketParts.analytic_volume_mm3, 6);
    expect(Math.abs(meshVolume(doc, part) / (flat.area * RULE.thickness) - 1)).toBeLessThan(1e-3);
  });

  it('refold: unfolding never edits the part and re-derivation (rebuild, save / load) gives the same recipe key (VC-FTR-08)', () => {
    const { doc, part } = bracket({ name: 'K05', kFactor: 0.5 });
    const keyOf = (candidate: typeof doc): string => recipeKey(recipeOf(folded(candidate, part)));
    const original = keyOf(doc);
    expect(keyOf(apply(doc, 'materialize_flat_pattern', { id: part }))).toBe(original);
    expect(ok(doc, 'flat_pattern', { id: part }).document).toBe(doc);
    expect(keyOf(bracket({ name: 'K05', kFactor: 0.5 }).doc)).toBe(original);
    expect(keyOf(deserializeDocument(serializeDocument(doc)))).toBe(original);
  });

  it('stores the folded solid as a union recipe of flats and bend sectors', () => {
    const { doc, part } = bracket();
    const entity = folded(doc, part);
    expect(entity.brep?.op).toBe('boolean');
    const model = doc.sheetMetal?.parts[part] as SheetMetalPart;
    expect(model.order).toEqual(['f1', 'f2', 'b1']);
    expect(entity.tags).toContain(`sheetpart:${part}`);
  });

  it('reports review and provenance on the flat pattern (VC-FTR-41)', () => {
    const { doc, part } = bracket();
    const result = ok(doc, 'flat_pattern', { id: part });
    const flat = result.data as FlatData & { reviewReason: string; provenance: { formulas: Record<string, string> } };
    expect(flat.reviewRequired).toBe(true);
    expect(flat.reviewReason.length).toBeGreaterThan(0);
    expect(result.summary).toContain('not approved');
    expect(flat.provenance.formulas['ba']).toBe('theta*(R+K*T)');
    expect(flat.unverified).toBe(false);
  });

  it('is pure: the input document is untouched by every command', () => {
    const { doc, part } = bracket();
    const before = JSON.stringify(doc);
    execute(doc, 'add_flange', {
      id: part,
      edge: { near: [0, 25, 0] },
      angle: 45,
      length: 20,
      lengthReference: 'tangent',
      position: 'material_outside',
    });
    execute(doc, 'flat_pattern', { id: part });
    execute(doc, 'materialize_flat_pattern', { id: part });
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe('add_flange options', () => {
  const flange = (extra: Record<string, unknown>): Record<string, unknown> => ({
    edge: { near: [0, 25, 0] },
    angle: 90,
    length: 20,
    lengthReference: 'outside_mold_line',
    position: 'material_outside',
    ...extra,
  });

  it('measures the length to the inside mold line, the tangent or the outside mold line', () => {
    const { doc, part } = bracket({}, false);
    const extents = (reference: string, length: number): number => {
      const next = apply(doc, 'add_flange', { id: part, ...flange({ lengthReference: reference, length }) });
      return data<FlatData>(next, 'flat_pattern', { id: part }).extents[0] ?? 0;
    };
    // flat leg = length - setback: OML 20 - 6.4, IML 20 - 4.8, tangent 20
    const base = 33.6 + 8.645662983;
    expect(extents('outside_mold_line', 20)).toBeCloseTo(base + 20 - 6.4, 5);
    expect(extents('inside_mold_line', 20)).toBeCloseTo(base + 20 - 4.8, 5);
    expect(extents('tangent', 20)).toBeCloseTo(base + 20, 5);
  });

  it('trims the base for material_inside so the flange outer face is flush with the picked edge', () => {
    const { doc, part } = bracket({}, false);
    const next = apply(doc, 'add_flange', {
      id: part,
      ...flange({ edge: { near: [33.6, 25, 0] }, position: 'material_inside', length: 30 }),
    });
    const { max } = meshBounds(next, part);
    expect(max[0]).toBeCloseTo(33.6, 6);
    const model = next.sheetMetal?.parts[part] as SheetMetalPart;
    const baseFlat = model.nodes['f1'];
    expect(baseFlat?.type === 'flat' && Math.max(...baseFlat.outline.map((point) => point[0]))).toBeCloseTo(33.6 - 6.4, 9);
  });

  it('bends down, narrower flanges and 135-degree bends', () => {
    const { doc, part } = bracket({}, false);
    const down = apply(doc, 'add_flange', { id: part, ...flange({ direction: 'down', angle: 135 }) });
    expect(meshBounds(down, part).min[2]).toBeLessThan(-1);
    const bend = data<FlatData>(down, 'flat_pattern', { id: part }).bends[0];
    expect(bend?.direction).toBe('down');
    expect(bend?.angleDeg).toBeCloseTo(135, 9);
    const narrow = apply(doc, 'add_flange', { id: part, ...flange({ widthStart: 10, widthEnd: 5 }) });
    const width = (narrow.sheetMetal?.parts[part]?.nodes['f2'] as unknown as { outline: number[][] }).outline[1]?.[0];
    expect(width).toBeCloseTo(35, 9);
  });

  it('allows a second flange on another edge and nests flanges on flanges', () => {
    const { doc, part } = bracket();
    const second = apply(doc, 'add_flange', { id: part, ...flange({ edge: { near: [0, 25, 0] } }) });
    expect(data<FlatData>(second, 'flat_pattern', { id: part }).bends).toHaveLength(2);
    const nested = apply(second, 'add_flange', {
      id: part,
      ...flange({ edge: { near: [40, 25, 30] }, length: 10, angle: 90, direction: 'up' }),
    });
    expect(data<FlatData>(nested, 'flat_pattern', { id: part }).bends).toHaveLength(3);
  });

  it('refuses bad flanges with stable codes', () => {
    const { doc, part } = bracket();
    expectRefusal(doc, 'add_flange', { id: 'nope', ...flange({}) }, 'FTR_PART_NOT_FOUND', 'id');
    expectRefusal(doc, 'add_flange', { id: part, ...flange({ angle: 0 }) }, 'FTR_BEND_ANGLE_OUT_OF_RANGE', 'angle');
    expectRefusal(doc, 'add_flange', { id: part, ...flange({ angle: 180 }) }, 'FTR_BEND_ANGLE_OUT_OF_RANGE', 'angle');
    expectRefusal(doc, 'add_flange', { id: part, ...flange({ insideRadius: 0 }) }, 'FTR_SHARP_BEND_FORBIDDEN', 'insideRadius');
    expectRefusal(doc, 'add_flange', { id: part, ...flange({ edge: { near: [20, 25, 0] } }) }, 'FTR_EDGE_NOT_STRAIGHT', 'edge.near');
    expectRefusal(doc, 'add_flange', { id: part, ...flange({ edge: { near: [33.6, 25, 0] } }) }, 'FTR_EDGE_OCCUPIED');
    expectRefusal(doc, 'add_flange', { id: part, ...flange({ length: 5 }) }, 'FTR_FLANGE_TOO_SHORT', 'length');
    expectRefusal(doc, 'add_flange', { id: part, ...flange({ length: -1 }) }, 'FTR_PARAM_INVALID', 'length');
    expectRefusal(doc, 'add_flange', { id: part, ...flange({ widthStart: 30, widthEnd: 30 }) }, 'FTR_PARAM_INVALID');
    expectRefusal(doc, 'add_flange', { id: part, ...flange({ insideRadius: -1 }) }, 'FTR_PARAM_INVALID', 'insideRadius');
    expectRefusal(
      doc,
      'add_flange',
      { id: part, ...flange({ edge: { near: [0, 25, 0] }, position: 'material_inside', angle: 90, length: 2 }) },
      'FTR_FLANGE_TOO_SHORT',
    );
  });

  it('trims a flat that already has a bend, but refuses to trim a flange and a trim that does not fit', () => {
    const { doc, part } = bracket();
    expect(ok(doc, 'add_flange', { id: part, ...flange({ position: 'material_inside' }) }).affected).toEqual([part]);
    expectRefusal(
      doc,
      'add_flange',
      { id: part, ...flange({ edge: { near: [39.2, 25, 30] }, position: 'material_inside' }) },
      'FTR_PARAM_INVALID',
      'position',
    );
    const small = bracket({}, false);
    expectRefusal(
      small.doc,
      'add_flange',
      {
        id: small.part,
        ...flange({ edge: { near: [33.6, 25, 0] }, position: 'material_inside', lengthReference: 'tangent', length: 10, angle: 170 }),
      },
      'FTR_PARAM_INVALID',
      'position',
    );
  });

  it('accepts a 180-degree tangent flange', () => {
    const { doc, part } = bracket({}, false);
    const next = apply(doc, 'add_flange', { id: part, ...flange({ angle: 180, lengthReference: 'tangent', length: 10 }) });
    expect(data<FlatData>(next, 'flat_pattern', { id: part }).bends[0]?.angleDeg).toBeCloseTo(180, 9);
  });
});

describe('add_sheet_metal_base', () => {
  it('builds from a closed polyline, any side, and keeps the profile', () => {
    let doc = apply(createEmptyDocument(), 'create_sheet_metal_rule', RULE);
    const drawn = ok(doc, 'draw_polyline', {
      points: [
        [0, 0],
        [20, 0],
        [20, 10],
        [10, 10],
        [10, 20],
        [0, 20],
      ],
      closed: true,
    });
    doc = drawn.document;
    const profile = drawn.affected[0] as string;
    for (const side of ['up', 'down', 'mid'] as const) {
      const made = ok(doc, 'add_sheet_metal_base', { profileId: profile, rule: RULE.name, side });
      const part = made.affected[0] as string;
      expect(doc.entities[profile]).toBeDefined();
      expect(meshVolume(made.document, part)).toBeCloseTo(300 * RULE.thickness, 6);
      const { min, max } = meshBounds(made.document, part);
      const expectedMin = side === 'up' ? 0 : side === 'down' ? -1.6 : -0.8;
      expect(min[2]).toBeCloseTo(expectedMin, 9);
      expect(max[2]).toBeCloseTo(expectedMin + 1.6, 9);
    }
  });

  it('refuses unknown rules, missing / open / circular profiles', () => {
    const { doc } = bracket({}, false);
    const open = ok(doc, 'draw_polyline', {
      points: [
        [0, 0],
        [5, 0],
        [5, 5],
      ],
      closed: false,
    });
    const circle = ok(open.document, 'draw_arc', { center: [0, 0], radius: 5 });
    const line = ok(circle.document, 'draw_polyline', {
      points: [
        [0, 0],
        [4, 4],
      ],
    });
    const tangled = ok(line.document, 'draw_polyline', {
      points: [
        [0, 0],
        [10, 10],
        [10, 0],
        [0, 10],
      ],
      closed: true,
    });
    const target = tangled.document;
    expectRefusal(target, 'add_sheet_metal_base', { profileId: 'rect-2.1', rule: 'nope', side: 'up' }, 'FTR_RULE_NOT_FOUND', 'rule');
    expectRefusal(target, 'add_sheet_metal_base', { profileId: 'ghost', rule: RULE.name, side: 'up' }, 'FTR_PARAM_INVALID', 'profileId');
    expectRefusal(
      target,
      'add_sheet_metal_base',
      { profileId: open.affected[0], rule: RULE.name, side: 'up' },
      'FTR_PROFILE_NOT_CLOSED',
      'profileId',
    );
    expectRefusal(target, 'add_sheet_metal_base', { profileId: circle.affected[0], rule: RULE.name, side: 'up' }, 'FTR_PROFILE_NOT_CLOSED');
    expectRefusal(target, 'add_sheet_metal_base', { profileId: line.affected[0], rule: RULE.name, side: 'up' }, 'FTR_PROFILE_NOT_CLOSED');
    expectRefusal(
      target,
      'add_sheet_metal_base',
      { profileId: tangled.affected[0], rule: RULE.name, side: 'up' },
      'FTR_PROFILE_NOT_CLOSED',
    );
  });
});
