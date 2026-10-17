import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import expected from '../../../../docs/aerospace/07-sheet-metal-machined-features/validation/data/expected_flat_pattern.json';
import expectedParts from '../../../../docs/aerospace/07-sheet-metal-machined-features/validation/data/expected_test_parts.json';
import { apply, data, expectRefusal, meshBounds, meshVolume, ok } from './helpers';

interface FlatData {
  extents: [number, number];
  bends: Array<{ id: string; direction: string; angleDeg: number; ba: number }>;
  joggles: Array<{ id: string; allowance: number; run: number; inclinedStraight: number }>;
}

/** A 40 x 30 strip (T 1.6, R 1.6, K 0.44) with the rule of the joggle strip test part. */
function strip(rule: Record<string, unknown> = {}, width = 40, height = 30): { doc: CadDocument; part: string } {
  let doc = apply(createEmptyDocument(), 'create_sheet_metal_rule', {
    name: 'strip',
    material: '2024',
    thickness: 1.6,
    insideRadius: 1.6,
    kFactor: 0.44,
    ...rule,
  });
  const drawn = ok(doc, 'draw_rectangle', { width, height, position: [0, 0, 0] });
  doc = drawn.document;
  const made = ok(doc, 'add_sheet_metal_base', { profileId: drawn.affected[0], rule: 'strip', side: 'up' });
  return { doc: made.document, part: made.affected[0] as string };
}

const joggle = (part: string, extra: Record<string, unknown> = {}) => ({
  id: part,
  face: { near: [10, 15, 0] },
  line: [
    [20, 30],
    [20, 0],
  ],
  offset: 1.6,
  angle: 20,
  side: 'up',
  ...extra,
});

describe('add_joggle (VC-FTR-11, 19)', () => {
  it('matches JG-01: allowance, run and inclined straight, and the joggle strip flat length', () => {
    const { doc, part } = strip();
    const joggled = apply(doc, 'add_joggle', joggle(part));
    const flat = data<FlatData>(joggled, 'flat_pattern', { id: part });
    const jg01 = expected.joggles[0] as (typeof expected.joggles)[number] & { allowance: number; run: number; inclined_straight: number };
    expect(flat.joggles).toHaveLength(1);
    expect(Math.abs((flat.joggles[0]?.allowance ?? 0) - jg01.allowance)).toBeLessThan(1e-6);
    expect(Math.abs((flat.joggles[0]?.run ?? 0) - jg01.run)).toBeLessThan(1e-6);
    expect(Math.abs((flat.joggles[0]?.inclinedStraight ?? 0) - jg01.inclined_straight)).toBeLessThan(1e-6);
    expect(flat.bends.map((bend) => bend.direction)).toEqual(['up', 'down']);
    expect(Math.abs((flat.extents[0] ?? 0) - expectedParts.parts['ftr_joggle_strip.step'].expected_flat_length_K044_mm)).toBeLessThan(1e-6);
    expect(flat.extents[1]).toBeCloseTo(30, 9);
  });

  it('folds to the joggle strip volume and offsets the far flat by the joggle height', () => {
    const { doc, part } = strip();
    const joggled = apply(doc, 'add_joggle', joggle(part));
    const strips = expectedParts.parts['ftr_joggle_strip.step'];
    expect(Math.abs(meshVolume(joggled, part) / strips.analytic_volume_mm3 - 1)).toBeLessThan(1e-3);
    const { min, max } = meshBounds(joggled, part);
    expect(max[0] - min[0]).toBeCloseTo(strips.expected_overall_run_mm, 3);
    expect(max[2]).toBeCloseTo(1.6 + 1.6, 6);
    expect(min[2]).toBeCloseTo(0, 6);
  });

  it('joggles down, keeps the side attached to the bend, and moves flanges with the offset piece', () => {
    const { doc, part } = strip({ insideRadius: 1.6 }, 40, 30);
    const withFlange = apply(doc, 'add_flange', {
      id: part,
      edge: { near: [40, 15, 0] },
      angle: 90,
      length: 15,
      lengthReference: 'outside_mold_line',
      position: 'material_outside',
    });
    const before = data<FlatData>(withFlange, 'flat_pattern', { id: part });
    const down = apply(withFlange, 'add_joggle', joggle(part, { side: 'down' }));
    const after = data<FlatData>(down, 'flat_pattern', { id: part });
    expect(after.bends).toHaveLength(3);
    expect(after.joggles).toHaveLength(1);
    expect((after.extents[0] ?? 0) - (before.extents[0] ?? 0)).toBeCloseTo(after.joggles[0]?.run === undefined ? 0 : 5.440212971, 6);
    expect(meshBounds(down, part).min[2]).toBeLessThan(-1);
    const reversed = apply(
      withFlange,
      'add_joggle',
      joggle(part, {
        line: [
          [20, 0],
          [20, 30],
        ],
      }),
    );
    expect(data<FlatData>(reversed, 'flat_pattern', { id: part }).bends).toHaveLength(3);
  });

  it('joggles a flat that hangs off a bend on its attached side', () => {
    const { doc, part } = strip({}, 40, 30);
    const withFlange = apply(doc, 'add_flange', {
      id: part,
      edge: { near: [40, 15, 0] },
      angle: 90,
      length: 40,
      lengthReference: 'tangent',
      position: 'material_outside',
    });
    const flange = withFlange.sheetMetal?.parts[part]?.nodes['f2'];
    expect(flange?.type).toBe('flat');
    // the flange is vertical at x = 40 + R + T = 43.2 .. 41.6; pick a point on it and cut across it
    const joggled = apply(withFlange, 'add_joggle', {
      id: part,
      face: { near: [42.4, 15, 20] },
      line: [
        [0, 20],
        [30, 20],
      ],
      offset: 1.6,
      angle: 20,
      side: 'up',
    });
    expect(data<FlatData>(joggled, 'flat_pattern', { id: part }).bends).toHaveLength(3);
  });

  it('refuses JG-04 (offset too small) with FTR_JOGGLE_OFFSET_TOO_SMALL (VC-FTR-11b, 37)', () => {
    const { doc, part } = strip({ insideRadius: 6 });
    const refused = expectRefusal(doc, 'add_joggle', joggle(part, { offset: 0.5, angle: 45 }), 'FTR_JOGGLE_OFFSET_TOO_SMALL', 'offset');
    expect(refused.error?.paths).toEqual(expect.arrayContaining(['offset', 'angle', 'insideRadius']));
    expect(refused.summary).toContain('needs offset >');
    expectRefusal(doc, 'add_joggle', joggle(part, { offset: 3.1, angle: 45 }), 'FTR_JOGGLE_OFFSET_TOO_SMALL');
  });

  it('refuses bad parts, angles, radii, faces and lines', () => {
    const { doc, part } = strip();
    expectRefusal(doc, 'add_joggle', joggle('nope'), 'FTR_PART_NOT_FOUND', 'id');
    expectRefusal(doc, 'add_joggle', joggle(part, { angle: 0 }), 'FTR_BEND_ANGLE_OUT_OF_RANGE', 'angle');
    expectRefusal(doc, 'add_joggle', joggle(part, { angle: 120 }), 'FTR_BEND_ANGLE_OUT_OF_RANGE');
    expectRefusal(doc, 'add_joggle', joggle(part, { insideRadius: 0 }), 'FTR_SHARP_BEND_FORBIDDEN', 'insideRadius');
    expectRefusal(doc, 'add_joggle', joggle(part, { insideRadius: -2 }), 'FTR_PARAM_INVALID', 'insideRadius');
    expectRefusal(doc, 'add_joggle', joggle(part, { face: { near: [10, 15, 50] } }), 'FTR_FACE_NOT_FOUND', 'face.near');
    expectRefusal(
      doc,
      'add_joggle',
      joggle(part, {
        line: [
          [20, 5],
          [20, 5],
        ],
      }),
      'FTR_JOGGLE_LINE_INVALID',
      'line',
    );
    expectRefusal(
      doc,
      'add_joggle',
      joggle(part, {
        line: [
          [100, 0],
          [100, 30],
        ],
      }),
      'FTR_JOGGLE_LINE_INVALID',
      'line',
    );
  });

  it('refuses a line through a cutout or through an existing bend', () => {
    const { doc, part } = strip();
    const hole = ok(doc, 'draw_arc', { center: [20, 15], radius: 3 });
    const cut = apply(hole.document, 'add_sheet_cutout', { id: part, face: { near: [10, 15, 0] }, profileId: hole.affected[0] });
    expectRefusal(cut, 'add_joggle', joggle(part), 'FTR_JOGGLE_LINE_INVALID');
    const flanged = apply(doc, 'add_flange', {
      id: part,
      edge: { near: [10, 0, 0] },
      angle: 90,
      length: 12,
      lengthReference: 'tangent',
      position: 'material_outside',
      widthStart: 5,
      widthEnd: 5,
    });
    expectRefusal(
      flanged,
      'add_joggle',
      joggle(part, {
        line: [
          [30, 0],
          [10, 0],
        ],
      }),
      'FTR_JOGGLE_LINE_INVALID',
    );
  });

  it('keeps cutouts on the side they were drawn and is pure', () => {
    const { doc, part } = strip();
    const hole = ok(doc, 'draw_arc', { center: [30, 15], radius: 3 });
    const cut = apply(hole.document, 'add_sheet_cutout', { id: part, face: { near: [10, 15, 0] }, profileId: hole.affected[0] });
    const before = JSON.stringify(cut);
    const joggled = ok(cut, 'add_joggle', joggle(part));
    expect(JSON.stringify(cut)).toBe(before);
    const flat = data<{ cutoutCount: number }>(joggled.document, 'flat_pattern', { id: part });
    expect(flat.cutoutCount).toBe(1);
    expect(execute(cut, 'add_joggle', joggle(part)).document).not.toBe(cut);
  });
});
