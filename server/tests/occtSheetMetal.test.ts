/**
 * Live OpenCascade: the sheet-metal plugin (aerospace 07 FTR M3/M5). The folded solid's union recipe is exact (VC-FTR-06, 08), and
 * convert_to_sheet_metal rebuilds the committed bracket and joggle strip from their STEP B-reps (VC-FTR-18, 19).
 */

import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import { setGeometryKernel, type GeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { liveKernels } from './kernelTestSupport';

const kernels = liveKernels();
afterAll(() => setGeometryKernel(null));

const PACK = path.resolve(__dirname, '../../docs/aerospace/07-sheet-metal-machined-features/validation/data');
const ctxOf = (kernel: GeometryKernel): ExecutionContext => ({ ...defaultContext(), kernel });

function run(kernel: GeometryKernel, doc: CadDocument, name: string, params: unknown): CommandResult {
  const result = execute(doc, name, params, ctxOf(kernel));
  expect(result.rejected, `${name}: ${result.summary}`).toBeUndefined();
  return result;
}

const RULE = { name: 'AL', material: '2024-T3', temper: 'T3', thickness: 1.6, kFactor: 0.44, kFactorStandard: 'ansi' };

function bracket(kernel: GeometryKernel, kFactor: number): { doc: CadDocument; part: string } {
  let doc = run(kernel, createEmptyDocument(), 'create_sheet_metal_rule', { ...RULE, insideRadius: 4.8, kFactor }).document;
  const drawn = run(kernel, doc, 'draw_rectangle', { width: 33.6, height: 50, position: [0, 0, 0] });
  const made = run(kernel, drawn.document, 'add_sheet_metal_base', { profileId: drawn.affected[0], rule: 'AL', side: 'up' });
  const part = made.affected[0] as string;
  doc = run(kernel, made.document, 'add_flange', {
    id: part,
    edge: { near: [33.6, 25, 0] },
    angle: 90,
    length: 30,
    lengthReference: 'outside_mold_line',
    position: 'material_outside',
  }).document;
  return { doc, part };
}

const volumeOf = (kernel: GeometryKernel, doc: CadDocument, id: string): number => {
  const mass = run(kernel, doc, 'mass_properties', { entityId: id }).data as { volume: number };
  return mass.volume;
};

interface Flat {
  extents: [number, number];
  area: number;
  bends: Array<{ angleDeg: number; insideRadius: number; ba: number; direction: string }>;
  joggles: Array<{ allowance: number; run: number }>;
}
const flatOf = (kernel: GeometryKernel, doc: CadDocument, id: string): Flat => run(kernel, doc, 'flat_pattern', { id }).data as Flat;

function importPart(kernel: GeometryKernel, file: string): { doc: CadDocument; solid: string } {
  const text = readFileSync(path.join(PACK, file), 'utf8');
  const imported = run(kernel, createEmptyDocument(), 'import_step_exact', { text, fileName: file });
  return { doc: imported.document, solid: imported.affected[0] as string };
}

describe('native bracket on OCC (VC-FTR-06, 08)', () => {
  it('folds to the exact analytic volume 5279.716754 mm3', () => {
    const { doc, part } = bracket(kernels.occt, 0.5);
    expect(Math.abs(volumeOf(kernels.occt, doc, part) / 5279.716754404115 - 1)).toBeLessThan(1e-6);
  });

  it('K = 0.5: flat area x T equals the exact folded volume (VC-FTR-08)', () => {
    const { doc, part } = bracket(kernels.occt, 0.5);
    const flat = flatOf(kernels.occt, doc, part);
    expect(Math.abs((flat.area * 1.6) / volumeOf(kernels.occt, doc, part) - 1)).toBeLessThan(1e-6);
  });

  it('an exact circular cutout removes exactly pi r^2 T', () => {
    const { doc, part } = bracket(kernels.occt, 0.44);
    const before = volumeOf(kernels.occt, doc, part);
    const circle = run(kernels.occt, doc, 'draw_arc', { center: [10, 25], radius: 4 });
    const cut = run(kernels.occt, circle.document, 'add_sheet_cutout', {
      id: part,
      face: { near: [10, 25, 0] },
      profileId: circle.affected[0],
    });
    expect(Math.abs(before - volumeOf(kernels.occt, cut.document, part) - Math.PI * 16 * 1.6)).toBeLessThan(1e-6);
  });

  it('a joggle strip folds to the analytic volume 2184.347214 mm3', () => {
    let doc = run(kernels.occt, createEmptyDocument(), 'create_sheet_metal_rule', { ...RULE, name: 'strip', insideRadius: 1.6 }).document;
    const drawn = run(kernels.occt, doc, 'draw_rectangle', { width: 40, height: 30, position: [0, 0, 0] });
    const made = run(kernels.occt, drawn.document, 'add_sheet_metal_base', { profileId: drawn.affected[0], rule: 'strip', side: 'up' });
    const part = made.affected[0] as string;
    doc = run(kernels.occt, made.document, 'add_joggle', {
      id: part,
      face: { near: [10, 15, 0] },
      line: [
        [20, 30],
        [20, 0],
      ],
      offset: 1.6,
      angle: 20,
      side: 'up',
    }).document;
    expect(Math.abs(volumeOf(kernels.occt, doc, part) / 2184.347213509194 - 1)).toBeLessThan(1e-6);
  });
});

describe('convert_to_sheet_metal on OCC (VC-FTR-18, VC-FTR-19)', () => {
  const converted = (file: string, rule: Record<string, unknown>, near: number[]): { doc: CadDocument; part: string; summary: string } => {
    const { doc, solid } = importPart(kernels.occt, file);
    const withRule = run(kernels.occt, doc, 'create_sheet_metal_rule', rule).document;
    const result = run(kernels.occt, withRule, 'convert_to_sheet_metal', { id: solid, stationaryFace: { near }, rule: rule['name'] });
    return { doc: result.document, part: result.affected[0] as string, summary: result.summary };
  };

  it('rebuilds the L bracket: T 1.6, one 90-degree bend R 4.8, flat 65.845663 x 50', () => {
    const bottom = converted('ftr_bracket_L.step', { ...RULE, insideRadius: 4.8 }, [10, 25, 0]);
    const flat = flatOf(kernels.occt, bottom.doc, bottom.part);
    expect(flat.bends).toHaveLength(1);
    expect(flat.bends[0]).toMatchObject({ angleDeg: 90, insideRadius: 4.8, direction: 'up' });
    expect(Math.abs(flat.extents[0] - 65.8456629826791)).toBeLessThan(0.01);
    expect(flat.extents[1]).toBeCloseTo(50, 6);
    const top = converted('ftr_bracket_L.step', { ...RULE, insideRadius: 4.8 }, [10, 25, 1.6]);
    const flatTop = flatOf(kernels.occt, top.doc, top.part);
    expect(flatTop.bends[0]).toMatchObject({ direction: 'down', insideRadius: 4.8 });
    expect(Math.abs(flatTop.extents[0] - 65.8456629826791)).toBeLessThan(0.01);
    const fromFlange = converted('ftr_bracket_L.step', { ...RULE, insideRadius: 4.8 }, [39.2, 25, 20]);
    expect(Math.abs(flatOf(kernels.occt, fromFlange.doc, fromFlange.part).extents[0] - 65.8456629826791)).toBeLessThan(0.01);
  });

  it('rebuilds the joggle strip: two R 1.6 bends of 20 degrees, one joggle, flat 45.440213', () => {
    const strip = converted('ftr_joggle_strip.step', { ...RULE, name: 'strip', insideRadius: 1.6 }, [5, 15, 0]);
    const flat = flatOf(kernels.occt, strip.doc, strip.part);
    expect(flat.bends).toHaveLength(2);
    expect(flat.bends.map((bend) => bend.direction).sort()).toEqual(['down', 'up']);
    for (const bend of flat.bends) expect(bend.insideRadius).toBeCloseTo(1.6, 9);
    expect(flat.bends[0]?.angleDeg).toBeCloseTo(20, 4);
    expect(Math.abs(flat.extents[0] - 45.44021297149828)).toBeLessThan(0.01);
    expect(flat.joggles).toHaveLength(1);
    expect(Math.abs((flat.joggles[0]?.allowance ?? 0) - 0.197879593)).toBeLessThan(1e-5);
    expect(strip.summary).toContain('1 joggle');
    const nodes = Object.values(strip.doc.sheetMetal?.parts[strip.part]?.nodes ?? {});
    const joggle = nodes.find((node) => node.type === 'joggle');
    expect(Math.abs(((joggle?.type === 'joggle' ? joggle.offset : Number.NaN) as number) - 1.6)).toBeLessThan(0.01); // pack: joggle offset 1.6
  });

  it('refuses a stepped solid, a wrong rule thickness, a curved face, an edge face and a mesh kernel', () => {
    const plate = run(kernels.occt, createEmptyDocument(), 'add_box', { size: [40, 40, 2], anchor: 'min' });
    const block = run(kernels.occt, plate.document, 'add_box', { size: [10, 10, 10], position: [10, 10, 2], anchor: 'min' });
    const stepped = run(kernels.occt, block.document, 'boolean', { op: 'union', a: plate.affected[0], b: block.affected[0] });
    const rule = run(kernels.occt, stepped.document, 'create_sheet_metal_rule', { ...RULE, thickness: 2, insideRadius: 4.8 }).document;
    const solidId = stepped.affected[0] as string;
    const refusal = execute(
      rule,
      'convert_to_sheet_metal',
      { id: solidId, stationaryFace: { near: [30, 30, 0] }, rule: 'AL' },
      ctxOf(kernels.occt),
    );
    expect(refusal.error?.code).toBe('FTR_NOT_SHEET_METAL');
    expect(refusal.document).toBe(rule);
    const { doc, solid } = importPart(kernels.occt, 'ftr_bracket_L.step');
    const thick = run(kernels.occt, doc, 'create_sheet_metal_rule', { ...RULE, thickness: 2, insideRadius: 4.8 }).document;
    expect(
      execute(thick, 'convert_to_sheet_metal', { id: solid, stationaryFace: { near: [10, 25, 0] }, rule: 'AL' }, ctxOf(kernels.occt)).error
        ?.code,
    ).toBe('FTR_PARAM_INVALID');
    const good = run(kernels.occt, doc, 'create_sheet_metal_rule', { ...RULE, insideRadius: 4.8 }).document;
    expect(
      execute(good, 'convert_to_sheet_metal', { id: solid, stationaryFace: { near: [36, 25, 3.5] }, rule: 'AL' }, ctxOf(kernels.occt)).error
        ?.code,
    ).toBe('FTR_FACE_NOT_PLANAR');
    expect(
      execute(good, 'convert_to_sheet_metal', { id: solid, stationaryFace: { near: [0, 25, 0.8] }, rule: 'AL' }, ctxOf(kernels.occt)).error
        ?.code,
    ).toBe('FTR_NOT_SHEET_METAL');
    expect(
      execute(good, 'convert_to_sheet_metal', { id: solid, stationaryFace: { near: [10, 25, 0] }, rule: 'AL' }, ctxOf(kernels.manifold))
        .error?.code,
    ).toBe('FTR_NEEDS_EXACT_KERNEL');
  });
});
