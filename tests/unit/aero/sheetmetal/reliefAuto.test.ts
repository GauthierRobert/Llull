import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { SheetMetalPart } from '@core/model/sheetMetal';
import type { FtrCheckData } from '@core/model/manufacturing';
import { type BuiltPart, apply, data, expectRefusal, meshVolume, ok } from './helpers';
import { plate } from './plates';

interface Named {
  value: number;
  defaulted: boolean;
  source: string;
}
interface ReliefData {
  reliefId: string;
  end: string;
  width: Named;
  depth: Named;
  depthExtra: Named;
}
interface FlatData {
  area: number;
}

const flangeParams = (part: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: part,
  edge: { near: [33.6, 25, 0] },
  angle: 90,
  length: 30,
  lengthReference: 'outside_mold_line',
  position: 'material_outside',
  ...extra,
});

describe('automatic relief on add_flange (VC-FTR-12)', () => {
  it('cuts the rule relief at the free bend end: width = ratio*T, depth = R + T + extra, extra a named default', () => {
    const { doc, part } = plate(33.6, 50);
    const result = ok(doc, 'add_flange', flangeParams(part, { widthStart: 4 }));
    const reliefs = (result.data as { reliefs: ReliefData[] }).reliefs;
    expect(reliefs).toHaveLength(1);
    const [relief] = reliefs as [ReliefData];
    expect(relief.width.value).toBeCloseTo(0.5 * 1.6, 12);
    expect(relief.depth.value).toBeCloseTo(4.8 + 1.6 + 0, 12);
    expect(relief.depthExtra).toMatchObject({ value: 0, defaulted: true });
    expect(relief.width.defaulted && relief.depth.defaulted).toBe(true);
    expect(result.summary).toContain('Automatic relief r1');
    const model = result.document.sheetMetal?.parts[part] as SheetMetalPart;
    expect(model.nodes['r1']).toMatchObject({ type: 'relief', bend: 'b1', end: relief.end, width: 0.8, depth: 6.4 });
    const flat = data<FlatData>(result.document, 'flat_pattern', { id: part });
    const unrelieved = data<FlatData>(apply(doc, 'add_flange', flangeParams(part, { widthStart: 4, autoRelief: false })), 'flat_pattern', {
      id: part,
    });
    expect(unrelieved.area - flat.area).toBeCloseTo(0.8 * 6.4, 9);
    const check = data<FtrCheckData>(result.document, 'check_sheet_metal', { id: part });
    expect(check.findings.filter((finding) => finding.code === 'FTR_RELIEF_MISSING')).toHaveLength(0);
  });

  it('adds the rule depthExtra to the depth and reports it as not defaulted', () => {
    const { doc, part } = plate(33.6, 50, { name: 'extra', relief: { type: 'rectangular', widthRatio: 1, depthExtra: 1 } });
    const result = ok(doc, 'add_flange', flangeParams(part, { widthStart: 4, widthEnd: 4 }));
    const reliefs = (result.data as { reliefs: ReliefData[] }).reliefs;
    expect(reliefs).toHaveLength(2);
    for (const relief of reliefs) {
      expect(relief.width.value).toBeCloseTo(1.6, 12);
      expect(relief.depth.value).toBeCloseTo(7.4, 12);
      expect(relief.depthExtra).toMatchObject({ value: 1, defaulted: false });
    }
  });

  it('leaves the bend ends alone with autoRelief false, with relief none or with a full-width flange', () => {
    const { doc, part } = plate(33.6, 50);
    const off = ok(doc, 'add_flange', flangeParams(part, { widthStart: 4, autoRelief: false }));
    expect((off.data as { reliefs: unknown[] }).reliefs).toEqual([]);
    const missing = data<FtrCheckData>(off.document, 'check_sheet_metal', { id: part });
    expect(missing.findings.some((finding) => finding.code === 'FTR_RELIEF_MISSING')).toBe(true);
    const none = plate(33.6, 50, { name: 'none', relief: { type: 'none', widthRatio: 1 } });
    expect((ok(none.doc, 'add_flange', flangeParams(none.part, { widthStart: 4 })).data as { reliefs: unknown[] }).reliefs).toEqual([]);
    const full = ok(doc, 'add_flange', flangeParams(part));
    expect((full.data as { reliefs: unknown[] }).reliefs).toEqual([]);
  });

  it('keeps the flange and says so when the relief does not fit the free stretch', () => {
    const { doc, part } = plate(33.6, 50);
    const tight = ok(doc, 'add_flange', flangeParams(part, { widthStart: 0.3 }));
    expect((tight.data as { reliefs: unknown[] }).reliefs).toEqual([]);
    expect(tight.summary).toContain('no automatic relief');
    expect(tight.affected).toEqual([part]);
  });

  it('is pure and refuses an unknown part', () => {
    const { doc, part } = plate(33.6, 50);
    const before = JSON.stringify(doc);
    execute(doc, 'add_flange', flangeParams(part, { widthStart: 4 }));
    expect(JSON.stringify(doc)).toBe(before);
    expectRefusal(doc, 'add_flange', flangeParams('nope'), 'FTR_PART_NOT_FOUND', 'id');
  });
});

/** 40 x 30 base with two flanges whose bends stop 5 short of the corner at [40, 0]. */
function cornerPart(): BuiltPart {
  const built = plate(40, 30);
  const bottom = apply(built.doc, 'add_flange', {
    id: built.part,
    edge: { near: [20, 0, 0] },
    angle: 90,
    length: 12,
    lengthReference: 'outside_mold_line',
    position: 'material_outside',
    widthEnd: 5,
    autoRelief: false,
  });
  const right = apply(bottom, 'add_flange', {
    id: built.part,
    edge: { near: [40, 15, 0] },
    angle: 90,
    length: 12,
    lengthReference: 'outside_mold_line',
    position: 'material_outside',
    widthStart: 5,
    autoRelief: false,
  });
  return { ...built, doc: right };
}

describe('add_corner_relief', () => {
  it('cuts a square notch at the picked corner, removes size^2 from the flat pattern and records the node', () => {
    const { doc, part } = cornerPart();
    const before = data<FlatData>(doc, 'flat_pattern', { id: part });
    const result = ok(doc, 'add_corner_relief', { id: part, corner: { near: [40, 0, 0] }, size: 4 });
    expect(result.affected).toEqual([part]);
    const flat = data<FlatData>(result.document, 'flat_pattern', { id: part });
    expect(before.area - flat.area).toBeCloseTo(16, 9);
    expect(Math.abs(meshVolume(doc, part) - meshVolume(result.document, part) - 16 * 1.6)).toBeLessThan(1e-6);
    const node = (result.document.sheetMetal?.parts[part] as SheetMetalPart).nodes['c1'];
    expect(node).toMatchObject({ type: 'corner_relief', on: 'f1', corner: [40, 0], size: 4 });
    const base = (result.document.sheetMetal?.parts[part] as SheetMetalPart).nodes['f1'];
    expect(base?.type === 'flat' && base.outline).toHaveLength(6);
    expect((result.data as { size: Named }).size).toMatchObject({ value: 4, defaulted: false });
    expect(result.document.order).toEqual(doc.order);
  });

  it('defaults the size to R + T + depthExtra and names it', () => {
    const { doc, part } = cornerPart();
    const result = ok(doc, 'add_corner_relief', { id: part, corner: { near: [0, 30, 0] } });
    expect((result.data as { size: Named }).size).toMatchObject({ value: 4.8 + 1.6, defaulted: true });
    expect(result.summary).toContain('size defaulted');
  });

  it('refuses a notch that would cut a bend, a bad corner, an oversized notch and unknown ids', () => {
    const { doc, part } = cornerPart();
    expectRefusal(doc, 'add_corner_relief', { id: part, corner: { near: [40, 0, 0] }, size: 6 }, 'FTR_RELIEF_INVALID', 'size');
    expectRefusal(doc, 'add_corner_relief', { id: part, corner: { near: [40, 0, 0] }, size: 0 }, 'FTR_PARAM_INVALID', 'size');
    expectRefusal(doc, 'add_corner_relief', { id: part, corner: { near: [20, 15, 0] }, size: 2 }, 'FTR_FACE_NOT_FOUND', 'corner.near');
    expectRefusal(doc, 'add_corner_relief', { id: part, corner: { near: [0, 30, 0] }, size: 40 }, 'FTR_RELIEF_INVALID');
    expectRefusal(doc, 'add_corner_relief', { id: 'nope', corner: { near: [0, 0, 0] }, size: 2 }, 'FTR_PART_NOT_FOUND', 'id');
  });

  it('is pure', () => {
    const { doc, part } = cornerPart();
    const before = JSON.stringify(doc);
    execute(doc, 'add_corner_relief', { id: part, corner: { near: [40, 0, 0] }, size: 4 });
    expect(JSON.stringify(doc)).toBe(before);
  });
});
