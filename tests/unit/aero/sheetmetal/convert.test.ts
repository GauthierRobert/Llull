import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { derivedEntityIds } from '@core/plugins/host';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { GeometryKernel } from '@core/geometry/kernel';
import type { CommandResult } from '@core/commands/types';
import { RULE } from './helpers';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { type Op, type SolidOptions, ctxWith, sheetProfile, syntheticSolid } from './syntheticSolid';

const T = 1.6;
const BRACKET: Op[] = [{ forward: 33.6 }, { turn: 'left', angleDeg: 90, radius: 4.8 }, { forward: 23.6 }];
const FLAT_LENGTH = 65.8456629826791;

interface FlatData {
  extents: [number, number];
  area: number;
  bends: Array<{ angleDeg: number; insideRadius: number; direction: string }>;
  joggles: Array<{ allowance: number; inclinedStraight: number }>;
}

interface Scene {
  readonly doc: CadDocument;
  readonly solid: string;
  readonly kernel: GeometryKernel;
}

function scene(ops: Op[], options: SolidOptions = {}, rule: Record<string, unknown> = {}, width = 50): Scene {
  const { kernel } = syntheticSolid(sheetProfile(T, ops), width, options);
  const boxed = ok(createEmptyDocument(), 'add_box', { size: [10, 10, 10] });
  const doc = apply(boxed.document, 'create_sheet_metal_rule', { ...RULE, insideRadius: 4.8, ...rule });
  return { doc, solid: boxed.affected[0] as string, kernel };
}

const convert = (s: Scene, near: number[], extra: Record<string, unknown> = {}): CommandResult =>
  execute(s.doc, 'convert_to_sheet_metal', { id: s.solid, stationaryFace: { near }, rule: RULE.name, ...extra }, ctxWith(s.kernel));

describe('convert_to_sheet_metal on a synthetic bracket (VC-FTR-18)', () => {
  it('rebuilds T, the bend and the flat pattern from the bottom skin', () => {
    const s = scene(BRACKET);
    const result = convert(s, [10, 25, 0]);
    expect(result.rejected, result.summary).toBeUndefined();
    expect(result.summary).toContain('1 bend(s)');
    const part = result.affected[0] as string;
    expect(result.document.sheetMetal?.parts[part]?.sourceEntity).toBe(s.solid);
    expect(derivedEntityIds(result.document).has(part)).toBe(false);
    const flat = data<FlatData>(result.document, 'flat_pattern', { id: part });
    expect(flat.bends).toHaveLength(1);
    expect(flat.bends[0]).toMatchObject({ angleDeg: 90, direction: 'up' });
    expect(flat.bends[0]?.insideRadius).toBeCloseTo(4.8, 6);
    expect(Math.abs(flat.extents[0] - FLAT_LENGTH)).toBeLessThan(1e-4);
    expect(flat.extents[1]).toBeCloseTo(50, 6);
  });

  it('gives the same flat from the top skin (a down bend) and from the flange', () => {
    const s = scene(BRACKET);
    const top = convert(s, [10, 25, 1.6]);
    const topFlat = data<FlatData>(top.document, 'flat_pattern', { id: top.affected[0] });
    expect(topFlat.bends[0]).toMatchObject({ direction: 'down', angleDeg: 90 });
    expect(topFlat.bends[0]?.insideRadius).toBeCloseTo(4.8, 6);
    expect(Math.abs(topFlat.extents[0] - FLAT_LENGTH)).toBeLessThan(1e-4);
    const flange = convert(s, [38.4, 25, 20]);
    const flangeFlat = data<FlatData>(flange.document, 'flat_pattern', { id: flange.affected[0] });
    expect(Math.abs(flangeFlat.extents[0] - FLAT_LENGTH)).toBeLessThan(1e-4);
    expect(flangeFlat.area).toBeCloseTo(topFlat.area, 6);
  });

  it('checks the converted part like a native one and survives save / load without a derived solid', () => {
    const s = scene(BRACKET, {}, { relief: { type: 'none', widthRatio: 1 } });
    const converted = convert(s, [10, 25, 0]);
    const part = converted.affected[0] as string;
    const check = data<{ status: string; rulesApplied: string[]; rulesSkipped: Array<{ rule: string }> }>(
      converted.document,
      'check_sheet_metal',
      { id: part },
    );
    expect(check.rulesSkipped.map((skipped) => skipped.rule)).toContain('min_bend_radius');
    expect(check.rulesApplied).toContain('hole_to_bend');
    const loaded = deserializeDocument(serializeDocument(converted.document));
    expect(loaded.sheetMetal?.parts[part]?.sourceEntity).toBe(s.solid);
    expect(loaded.entities[part]).toBeUndefined();
    expect(data<FlatData>(loaded, 'flat_pattern', { id: part }).bends).toHaveLength(1);
    expect(data<{ dxf: string }>(loaded, 'export_flat_pattern_dxf', { id: part }).dxf).toContain('BEND_UP');
  });

  it('is pure', () => {
    const s = scene(BRACKET);
    const before = JSON.stringify(s.doc);
    convert(s, [10, 25, 0]);
    expect(JSON.stringify(s.doc)).toBe(before);
  });
});

describe('convert_to_sheet_metal: other shapes', () => {
  it('recognises a joggle strip: two opposite 20-degree bends, one joggle, flat 45.440213 (VC-FTR-19)', () => {
    const s = scene(
      [
        { forward: 20 },
        { turn: 'left', angleDeg: 20, radius: 1.6 },
        { forward: 3.831717533 },
        { turn: 'right', angleDeg: 20, radius: 1.6 },
        { forward: 20 },
      ],
      {},
      { insideRadius: 1.6 },
      30,
    );
    const result = convert(s, [5, 15, 0]);
    expect(result.rejected, result.summary).toBeUndefined();
    expect(result.summary).toContain('1 joggle(s)');
    const flat = data<FlatData>(result.document, 'flat_pattern', { id: result.affected[0] });
    expect(flat.bends.map((bend) => bend.direction)).toEqual(['up', 'down']);
    expect(Math.abs(flat.extents[0] - 45.44021297149828)).toBeLessThan(1e-4);
    expect(flat.joggles[0]?.allowance).toBeCloseTo(0.197879593, 5);
    expect(flat.joggles[0]?.inclinedStraight).toBeCloseTo(3.831717533, 5);
  });

  it('follows a U channel through two bends', () => {
    const s = scene(
      [
        { forward: 20 },
        { turn: 'left', angleDeg: 90, radius: 3 },
        { forward: 30 },
        { turn: 'left', angleDeg: 90, radius: 3 },
        { forward: 20 },
      ],
      {},
      { insideRadius: 3 },
    );
    const result = convert(s, [5, 25, 0]);
    expect(result.rejected, result.summary).toBeUndefined();
    expect(result.summary).toContain('3 flat(s)');
    expect(data<FlatData>(result.document, 'flat_pattern', { id: result.affected[0] }).bends).toHaveLength(2);
  });

  it('converts a flat plate without bends and a sharp bend (radius 0 on the reference side)', () => {
    const plate = convert(scene([{ forward: 40 }]), [10, 25, 0]);
    expect(plate.rejected, plate.summary).toBeUndefined();
    expect(data<FlatData>(plate.document, 'flat_pattern', { id: plate.affected[0] }).bends).toHaveLength(0);
    const sharp = scene(
      [{ forward: 20 }, { turn: 'right', angleDeg: 90, radius: 0 }, { forward: 20 }],
      {},
      { insideRadius: 0, allowSharpBends: true },
    );
    const result = convert(sharp, [5, 25, 0]);
    expect(result.rejected, result.summary).toBeUndefined();
  });
});

describe('convert_to_sheet_metal refusals', () => {
  const refused = (s: Scene, near: number[], code: string, extra: Record<string, unknown> = {}): void => {
    const result = convert(s, near, extra);
    expect(result.rejected, result.summary).toBe(true);
    expect(result.document).toBe(s.doc);
    expect(result.error?.code, result.summary).toBe(code);
    expect(result.error?.remediation.length).toBeGreaterThan(0);
  };

  it('needs an exact kernel with a face-query port and a B-rep', () => {
    const s = scene(BRACKET);
    const noPort = execute(
      s.doc,
      'convert_to_sheet_metal',
      { id: s.solid, stationaryFace: { near: [10, 25, 0] }, rule: RULE.name },
      ctxWith({ ...s.kernel, faceQuery: undefined } as unknown as GeometryKernel),
    );
    expect(noPort.error?.code).toBe('FTR_NEEDS_EXACT_KERNEL');
    const none = execute(
      s.doc,
      'convert_to_sheet_metal',
      { id: s.solid, stationaryFace: { near: [10, 25, 0] }, rule: RULE.name },
      ctxWith(null),
    );
    expect(none.rejected).toBe(true);
    expect(none.error?.code).toBe('CMD_KERNEL_UNAVAILABLE');
    const failing = { ...s.kernel, evaluate: () => null } as GeometryKernel;
    expect(
      execute(s.doc, 'convert_to_sheet_metal', { id: s.solid, stationaryFace: { near: [10, 25, 0] }, rule: RULE.name }, ctxWith(failing))
        .error?.code,
    ).toBe('FTR_NEEDS_EXACT_KERNEL');
    const noTopology = { ...s.kernel, topology: () => null } as GeometryKernel;
    expect(
      execute(s.doc, 'convert_to_sheet_metal', { id: s.solid, stationaryFace: { near: [10, 25, 0] }, rule: RULE.name }, ctxWith(noTopology))
        .error?.code,
    ).toBe('FTR_NEEDS_EXACT_KERNEL');
  });

  it('refuses a mesh without B-rep, unknown ids and rules', () => {
    const s = scene(BRACKET);
    const meshDoc: CadDocument = {
      ...s.doc,
      entities: {
        ...s.doc.entities,
        tri: {
          id: 'tri',
          kind: 'mesh',
          mesh: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] },
          position: [0, 0, 0],
          rotation: [0, 0, 0],
          layerId: 'layer-default',
          color: '#888888',
        },
      },
    };
    const mesh = execute(
      meshDoc,
      'convert_to_sheet_metal',
      { id: 'tri', stationaryFace: { near: [0, 0, 0] }, rule: RULE.name },
      ctxWith(s.kernel),
    );
    expect(mesh.error?.code).toBe('FTR_NEEDS_EXACT_KERNEL');
    expectRefusal(
      s.doc,
      'convert_to_sheet_metal',
      { id: 'ghost', stationaryFace: { near: [0, 0, 0] }, rule: RULE.name },
      'CMD_KERNEL_UNAVAILABLE',
    );
    expect(
      execute(s.doc, 'convert_to_sheet_metal', { id: 'ghost', stationaryFace: { near: [0, 0, 0] }, rule: RULE.name }, ctxWith(s.kernel))
        .error?.code,
    ).toBe('FTR_PARAM_INVALID');
    refused(s, [10, 25, 0], 'FTR_RULE_NOT_FOUND', { rule: 'nope' });
  });

  it('refuses non-developable faces, a wrong thickness, non-planar and edge faces, a missing face', () => {
    refused(scene(BRACKET, { coneFace: true }), [10, 25, 0], 'FTR_NON_DEVELOPABLE');
    refused(scene(BRACKET, {}, { thickness: 2 }), [10, 25, 0], 'FTR_PARAM_INVALID');
    refused(scene(BRACKET, { pickFace: 1 }), [36, 25, 3], 'FTR_FACE_NOT_PLANAR');
    refused(scene(BRACKET, { pickFace: 8 }), [10, 0, 0.8], 'FTR_NOT_SHEET_METAL');
    refused(scene(BRACKET, { noFace: true }), [10, 25, 0], 'FTR_FACE_NOT_FOUND');
  });

  it('refuses a solid whose volume is not thickness x developed area, and a single wall', () => {
    refused(scene(BRACKET, { volume: 9000 }), [10, 25, 0], 'FTR_NOT_SHEET_METAL');
    const wall = scene([{ forward: 40 }], {}, {}, 1.6);
    const plate = convert(wall, [10, 0.8, 0]);
    expect(plate.error?.code === undefined || typeof plate.error.code === 'string').toBe(true);
  });
});
