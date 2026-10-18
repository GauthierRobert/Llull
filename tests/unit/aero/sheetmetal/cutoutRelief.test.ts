import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { CadDocument, Entity } from '@core/model/types';
import type { SheetMetalPart } from '@core/model/sheetMetal';
import { type BuiltPart, RULE, bracket, meshVolume } from './helpers';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';

interface FlatData {
  area: number;
  cutoutCount: number;
  extents: [number, number];
}

/** The document with entity `id` rotated (draw commands place shapes on the XY plane only). */
const rotated = (doc: CadDocument, id: string, rotation: [number, number, number]): CadDocument => ({
  ...doc,
  entities: { ...doc.entities, [id]: { ...(doc.entities[id] as Entity), rotation } },
});

const cutoutParams = (part: string, profileId: unknown, near: number[] = [10, 25, 0]): Record<string, unknown> => ({
  id: part,
  face: { near },
  profileId,
});

describe('add_sheet_cutout', () => {
  it('cuts a circle: exact flat-pattern area, mesh volume and the exact circle in the recipe', () => {
    const { doc, part } = bracket();
    const before = data<FlatData>(doc, 'flat_pattern', { id: part });
    const circle = ok(doc, 'draw_arc', { center: [10, 25], radius: 4 });
    const cut = ok(circle.document, 'add_sheet_cutout', cutoutParams(part, circle.affected[0]));
    expect(cut.affected).toEqual([part]);
    const flat = data<FlatData>(cut.document, 'flat_pattern', { id: part });
    expect(flat.cutoutCount).toBe(1);
    expect(before.area - flat.area).toBeCloseTo(Math.PI * 16, 9);
    const volumeLoss = meshVolume(doc, part) - meshVolume(cut.document, part);
    expect(Math.abs(volumeLoss / (Math.PI * 16 * RULE.thickness) - 1)).toBeLessThan(2e-3);
    const model = cut.document.sheetMetal?.parts[part] as SheetMetalPart;
    const baseFlat = model.nodes['f1'];
    expect(baseFlat?.type === 'flat' && baseFlat.cutouts[0]?.circle).toEqual({ center: [10, 25], radius: 4 });
    expect(cut.summary).toContain('circle R=4');
  });

  it('cuts rectangles and polylines drawn on a parallel plane, and a cutout in a flange', () => {
    const { doc, part } = bracket();
    const rect = ok(doc, 'draw_rectangle', { width: 6, height: 4, position: [5, 5, 12] });
    const cutRect = apply(rect.document, 'add_sheet_cutout', cutoutParams(part, rect.affected[0], [6, 6, 0]));
    expect(data<FlatData>(cutRect, 'flat_pattern', { id: part }).area).toBeCloseTo(
      data<FlatData>(doc, 'flat_pattern', { id: part }).area - 24,
      9,
    );
    const tri = ok(cutRect, 'draw_polyline', {
      points: [
        [20, 10],
        [28, 10],
        [24, 18],
      ],
      closed: true,
    });
    const cutTri = apply(tri.document, 'add_sheet_cutout', cutoutParams(part, tri.affected[0], [24, 12, 0]));
    expect(data<FlatData>(cutTri, 'flat_pattern', { id: part }).cutoutCount).toBe(2);
    // a hole in the flange, drawn in the XZ-plane region of the flange face (x = 40 .. 38.4, z = 6.4 .. 30)
    const drawn = ok(cutTri, 'draw_arc', { center: [0, 0], radius: 3, position: [39, 25, 15] });
    const onFlange = { ...drawn, document: rotated(drawn.document, drawn.affected[0] as string, [0, Math.PI / 2, 0]) };
    const cutFlange = ok(onFlange.document, 'add_sheet_cutout', cutoutParams(part, onFlange.affected[0], [39.2, 25, 15]));
    expect(data<FlatData>(cutFlange.document, 'flat_pattern', { id: part }).cutoutCount).toBe(3);
    expect((cutFlange.document.sheetMetal?.parts[part]?.nodes['f2'] as unknown as { cutouts: unknown[] }).cutouts).toHaveLength(1);
  });

  it('refuses profiles that do not fit, overlap or are not closed', () => {
    const { doc, part } = bracket();
    const big = ok(doc, 'draw_arc', { center: [10, 25], radius: 20 });
    expectRefusal(big.document, 'add_sheet_cutout', cutoutParams(part, big.affected[0]), 'FTR_CUTOUT_INVALID');
    const crossing = ok(doc, 'draw_rectangle', { width: 10, height: 10, position: [30, 20, 0] });
    expectRefusal(crossing.document, 'add_sheet_cutout', cutoutParams(part, crossing.affected[0]), 'FTR_CUTOUT_INVALID');
    const first = ok(doc, 'draw_arc', { center: [10, 25], radius: 4 });
    const cut = apply(first.document, 'add_sheet_cutout', cutoutParams(part, first.affected[0]));
    const second = ok(cut, 'draw_arc', { center: [12, 25], radius: 4 });
    expectRefusal(second.document, 'add_sheet_cutout', cutoutParams(part, second.affected[0]), 'FTR_CUTOUT_INVALID');
    const inside = ok(cut, 'draw_arc', { center: [10, 25], radius: 1 });
    expectRefusal(inside.document, 'add_sheet_cutout', cutoutParams(part, inside.affected[0]), 'FTR_CUTOUT_INVALID');
    const open = ok(doc, 'draw_polyline', {
      points: [
        [1, 1],
        [5, 5],
        [9, 1],
      ],
    });
    expectRefusal(open.document, 'add_sheet_cutout', cutoutParams(part, open.affected[0]), 'FTR_PROFILE_NOT_CLOSED', 'profileId');
    const sideways = ok(doc, 'draw_arc', { center: [0, 0], radius: 3, position: [10, 25, 0] });
    const perpendicular = { ...sideways, document: rotated(sideways.document, sideways.affected[0] as string, [0, Math.PI / 2, 0]) };
    expectRefusal(perpendicular.document, 'add_sheet_cutout', cutoutParams(part, perpendicular.affected[0]), 'FTR_CUTOUT_INVALID');
  });

  it('refuses unknown parts, entities and faces', () => {
    const { doc, part } = bracket();
    expectRefusal(doc, 'add_sheet_cutout', cutoutParams('nope', 'x'), 'FTR_PART_NOT_FOUND', 'id');
    expectRefusal(doc, 'add_sheet_cutout', cutoutParams(part, 'ghost'), 'FTR_PARAM_INVALID', 'profileId');
    const circle = ok(doc, 'draw_arc', { center: [10, 25], radius: 4 });
    expectRefusal(
      circle.document,
      'add_sheet_cutout',
      cutoutParams(part, circle.affected[0], [10, 25, 80]),
      'FTR_FACE_NOT_FOUND',
      'face.near',
    );
  });

  it('is pure', () => {
    const { doc, part } = bracket();
    const circle = ok(doc, 'draw_arc', { center: [10, 25], radius: 4 });
    const before = JSON.stringify(circle.document);
    execute(circle.document, 'add_sheet_cutout', cutoutParams(part, circle.affected[0]));
    expect(JSON.stringify(circle.document)).toBe(before);
  });
});

describe('add_relief', () => {
  const narrow = (): BuiltPart => bracket({ relief: { type: 'rectangular', widthRatio: 0.5 } }, false);
  const flangeWith = (extra: Record<string, unknown>): Record<string, unknown> => ({
    edge: { near: [33.6, 25, 0] },
    angle: 90,
    length: 30,
    lengthReference: 'outside_mold_line',
    position: 'material_outside',
    autoRelief: false,
    ...extra,
  });

  it('cuts a notch of rule-derived size beside the bend end and names the defaults', () => {
    const { doc, part } = narrow();
    const flanged = apply(doc, 'add_flange', { id: part, ...flangeWith({ widthStart: 4 }) });
    const before = data<FlatData>(flanged, 'flat_pattern', { id: part });
    const result = ok(flanged, 'add_relief', { id: part, bend: 'b1', end: 'end' });
    expect(result.summary).toContain('0.8 x 6.4 notch');
    expect(result.summary).toContain('defaulted from rule');
    const after = data<FlatData>(result.document, 'flat_pattern', { id: part });
    expect(before.area - after.area).toBeCloseTo(0.8 * 6.4, 9);
    expect(after.extents).toEqual(before.extents);
    const model = result.document.sheetMetal?.parts[part] as SheetMetalPart;
    expect(model.nodes['r1']).toMatchObject({ type: 'relief', bend: 'b1', end: 'end', width: 0.8, depth: 6.4 });
    expect(Math.abs(meshVolume(flanged, part) - meshVolume(result.document, part) - 0.8 * 6.4 * 1.6)).toBeLessThan(1e-6);
  });

  it('accepts explicit sizes, including a notch that reaches the corner', () => {
    const { doc, part } = narrow();
    const flanged = apply(doc, 'add_flange', { id: part, ...flangeWith({ widthStart: 4 }) });
    const result = ok(flanged, 'add_relief', { id: part, bend: 'b1', end: 'end', width: 4, depth: 5 });
    expect(result.summary).not.toContain('defaulted');
    const baseFlat = (result.document.sheetMetal?.parts[part] as SheetMetalPart).nodes['f1'];
    expect(baseFlat?.type === 'flat' && baseFlat.outline).toHaveLength(6);
    const other = apply(flanged, 'add_flange', { id: part, ...flangeWith({ edge: { near: [0, 25, 0] }, widthEnd: 10 }) });
    expect(ok(other, 'add_relief', { id: part, bend: 'b2', end: 'start', width: 2, depth: 3 }).affected).toEqual([part]);
  });

  it('refuses bad requests with stable codes', () => {
    const { doc, part } = narrow();
    const flanged = apply(doc, 'add_flange', { id: part, ...flangeWith({ widthStart: 4 }) });
    expectRefusal(flanged, 'add_relief', { id: 'nope', bend: 'b1', end: 'end' }, 'FTR_PART_NOT_FOUND', 'id');
    expectRefusal(flanged, 'add_relief', { id: part, bend: 'b9', end: 'end' }, 'FTR_PARAM_INVALID', 'bend');
    expectRefusal(flanged, 'add_relief', { id: part, bend: 'b1', end: 'start' }, 'FTR_RELIEF_INVALID', 'end');
    expectRefusal(flanged, 'add_relief', { id: part, bend: 'b1', end: 'end', width: 6, depth: 3 }, 'FTR_RELIEF_INVALID');
    expectRefusal(flanged, 'add_relief', { id: part, bend: 'b1', end: 'end', depth: 400 }, 'FTR_RELIEF_INVALID');
    expectRefusal(flanged, 'add_relief', { id: part, bend: 'b1', end: 'end', width: 0, depth: 3 }, 'FTR_PARAM_INVALID', 'width');
    const once = apply(flanged, 'add_relief', { id: part, bend: 'b1', end: 'end' });
    expectRefusal(once, 'add_relief', { id: part, bend: 'b1', end: 'end' }, 'FTR_RELIEF_INVALID', 'end');
  });

  it('needs explicit sizes when the rule defines no rectangular relief', () => {
    const none = bracket({ name: 'norelief', relief: undefined }, false);
    const flanged = apply(none.doc, 'add_flange', { id: none.part, ...flangeWith({ widthStart: 4 }) });
    expectRefusal(flanged, 'add_relief', { id: none.part, bend: 'b1', end: 'end' }, 'FTR_PARAM_INVALID', 'width');
    expect(ok(flanged, 'add_relief', { id: none.part, bend: 'b1', end: 'end', width: 1, depth: 3 }).affected).toEqual([none.part]);
  });

  it('is pure', () => {
    const { doc, part } = narrow();
    const flanged = apply(doc, 'add_flange', { id: part, ...flangeWith({ widthStart: 4 }) });
    const before = JSON.stringify(flanged);
    execute(flanged, 'add_relief', { id: part, bend: 'b1', end: 'end' });
    expect(JSON.stringify(flanged)).toBe(before);
  });
});
