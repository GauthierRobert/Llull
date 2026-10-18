import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { RULE, apply, data, expectRefusal, meshBounds, meshVolume, ok, ruleParams } from './helpers';

interface FlatData {
  extents: [number, number];
  cutoutCount: number;
  bends: Array<{ ba: number }>;
}

const OSSB = RULE.insideRadius + RULE.thickness;

/** 200 x 150 base whose profile is the OUTSIDE of the tray; flanges 50 high to the outside mold line. */
function base(): { doc: CadDocument; part: string } {
  let doc = apply(createEmptyDocument(), 'create_sheet_metal_rule', ruleParams({ ...RULE }));
  const drawn = ok(doc, 'draw_rectangle', { width: 200, height: 150, position: [0, 0, 0] });
  const made = ok(drawn.document, 'add_sheet_metal_base', { profileId: drawn.affected[0], rule: RULE.name, side: 'up' });
  doc = made.document;
  return { doc, part: made.affected[0] as string };
}

const FLANGE_EDGES: Array<[number, number, number]> = [
  [100, 0, 0],
  [100, 150, 0],
  [200, 75, 0],
  [0, 75, 0],
];

function flange(doc: CadDocument, part: string, near: [number, number, number]): CadDocument {
  return apply(doc, 'add_flange', {
    id: part,
    edge: { near },
    angle: 90,
    length: 50,
    lengthReference: 'outside_mold_line',
    position: 'material_inside',
  });
}

function tray(): { doc: CadDocument; part: string } {
  const { doc, part } = base();
  return { doc: FLANGE_EDGES.reduce((next, near) => flange(next, part, near), doc), part };
}

describe('four material_inside flanges (tray dimensioned by its outside)', () => {
  it('accepts every flange and keeps the outside dimensions of the base profile', () => {
    const { doc, part } = tray();
    const { min, max } = meshBounds(doc, part);
    expect([max[0] - min[0], max[1] - min[1], max[2] - min[2]]).toEqual([
      expect.closeTo(200, 6),
      expect.closeTo(150, 6),
      expect.closeTo(50, 6),
    ]);
  });

  it('has a flat pattern consistent with the trimmed base and the four legs', () => {
    const { doc, part } = tray();
    const flat = data<FlatData>(doc, 'flat_pattern', { id: part });
    expect(flat.bends).toHaveLength(4);
    const ba = flat.bends[0]?.ba ?? 0;
    const leg = 50 - OSSB;
    expect(flat.extents[0]).toBeCloseTo(200 - 2 * OSSB + 2 * (leg + ba), 6);
    expect(flat.extents[1]).toBeCloseTo(150 - 2 * OSSB + 2 * (leg + ba), 6);
  });

  it('refuses an edge flange trimmed on a flange itself, saying why', () => {
    const { doc, part } = tray();
    const result = expectRefusal(
      doc,
      'add_flange',
      {
        id: part,
        edge: { near: [100, 0.8, 50] },
        angle: 90,
        length: 10,
        lengthReference: 'outside_mold_line',
        position: 'material_inside',
      },
      'FTR_PARAM_INVALID',
      'position',
    );
    expect(result.summary).toContain('itself a flange');
  });
});

describe('corner relief before material_inside flanges', () => {
  const CORNERS: Array<[number, number, number]> = [
    [0, 0, 0],
    [200, 0, 0],
    [200, 150, 0],
    [0, 150, 0],
  ];
  const SIZE = RULE.insideRadius + RULE.thickness;

  function relievedTray(): { doc: CadDocument; part: string; before: CadDocument } {
    const { doc: plain, part } = base();
    const relieved = CORNERS.reduce((next, near) => apply(next, 'add_corner_relief', { id: part, corner: { near } }), plain);
    return { doc: FLANGE_EDGES.reduce((next, near) => flange(next, part, near), relieved), part, before: relieved };
  }

  it('accepts all four flanges and folds to the outside dimensions', () => {
    const { doc, part } = relievedTray();
    const { min, max } = meshBounds(doc, part);
    expect([max[0] - min[0], max[1] - min[1], max[2] - min[2]]).toEqual([
      expect.closeTo(200, 6),
      expect.closeTo(150, 6),
      expect.closeTo(50, 6),
    ]);
  });

  it('keeps the four notches in the flat pattern with the same extents as the unrelieved tray', () => {
    const { doc, part } = relievedTray();
    const flat = data<FlatData & { outline?: unknown[] }>(doc, 'flat_pattern', { id: part });
    const plain = data<FlatData>(tray().doc, 'flat_pattern', { id: part });
    expect(flat.bends).toHaveLength(4);
    expect(flat.extents[0]).toBeCloseTo(plain.extents[0], 6);
    expect(flat.extents[1]).toBeCloseTo(plain.extents[1], 6);
    const model = (doc.sheetMetal?.parts ?? {})[part];
    const nodes = Object.values(model?.nodes ?? {});
    const root = nodes.find((node) => node.type === 'flat');
    expect(root?.type === 'flat' ? root.outline : []).toHaveLength(4 * 3);
    const reliefs = nodes.filter((node) => node.type === 'corner_relief');
    expect(reliefs).toHaveLength(4);
    for (const node of reliefs) expect(node.type === 'corner_relief' && node.size).toBeCloseTo(SIZE, 9);
  });

  it('is pure and refuses a relief too large to survive the trim with a specific message', () => {
    const { doc: plain, part } = base();
    const doc = apply(plain, 'add_corner_relief', { id: part, corner: { near: [0, 0, 0] }, size: 140 });
    const snapshot = JSON.stringify(doc);
    const first = flange(doc, part, [170, 0, 0]);
    const result = expectRefusal(
      first,
      'add_flange',
      { id: part, edge: { near: [170, 150, 0] }, angle: 90, length: 50, lengthReference: 'outside_mold_line', position: 'material_inside' },
      'FTR_PARAM_INVALID',
      'position',
    );
    expect(result.summary).toContain('no longer fits');
    expect(JSON.stringify(doc)).toBe(snapshot);
  });
});

describe('add_sheet_cutout on a flange', () => {
  const hole = {
    id: '',
    face: { near: [100, 0.8, 30] as [number, number, number] },
    circle: { center: [100, 0, 30] as [number, number, number], radius: 4 },
  };

  it('cuts a round hole from world points on a vertical flange, no drawn profile needed', () => {
    const { doc, part } = tray();
    const before = meshVolume(doc, part);
    const result = ok(doc, 'add_sheet_cutout', { ...hole, id: part });
    expect(result.affected).toEqual([part]);
    expect(data<FlatData>(result.document, 'flat_pattern', { id: part }).cutoutCount).toBe(1);
    expect(before - meshVolume(result.document, part)).toBeCloseTo(Math.PI * 16 * RULE.thickness, 0);
  });

  it('cuts a polygon given as world points on the flange', () => {
    const { doc, part } = tray();
    const points = [
      [90, 0, 20],
      [110, 0, 20],
      [110, 0, 30],
      [90, 0, 30],
    ];
    const result = ok(doc, 'add_sheet_cutout', { id: part, face: hole.face, polygon: { points } });
    expect(data<FlatData>(result.document, 'flat_pattern', { id: part }).cutoutCount).toBe(1);
  });

  it('refuses no shape, two shapes, and a hole in the bend zone', () => {
    const { doc, part } = tray();
    expectRefusal(doc, 'add_sheet_cutout', { id: part, face: hole.face }, 'FTR_PARAM_INVALID');
    expectRefusal(doc, 'add_sheet_cutout', { ...hole, id: part, profileId: 'rect-1' }, 'FTR_PARAM_INVALID');
    expectRefusal(doc, 'add_sheet_cutout', { id: part, face: hole.face, circle: { center: [100, 0, 8], radius: 4 } }, 'FTR_CUTOUT_INVALID');
  });
});
