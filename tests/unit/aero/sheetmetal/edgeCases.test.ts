import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { SheetMetalModel, SheetMetalPart } from '@core/model/sheetMetal';
import type { FtrCheckData } from '@core/model/manufacturing';
import { RULE, bracket, meshBounds } from './helpers';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { ctxWith, sheetProfile, syntheticSolid, type Op, type SolidOptions } from './syntheticSolid';

function withModel(doc: CadDocument, edit: (model: SheetMetalModel) => SheetMetalModel): CadDocument {
  return { ...doc, sheetMetal: edit(doc.sheetMetal as SheetMetalModel) };
}

describe('parts whose rule or geometry went missing', () => {
  it('every command refuses with FTR_RULE_NOT_FOUND', () => {
    const { doc, part } = bracket();
    const orphan = withModel(doc, (model) => ({ ...model, rules: {} }));
    const flange = {
      id: part,
      edge: { near: [0, 25, 0] },
      angle: 90,
      length: 20,
      lengthReference: 'tangent',
      position: 'material_outside',
    };
    expectRefusal(orphan, 'add_flange', flange, 'FTR_RULE_NOT_FOUND');
    expectRefusal(
      orphan,
      'add_joggle',
      {
        id: part,
        face: { near: [10, 25, 0] },
        line: [
          [5, 50],
          [5, 0],
        ],
        offset: 3,
        angle: 30,
        side: 'up',
      },
      'FTR_RULE_NOT_FOUND',
    );
    expectRefusal(orphan, 'add_sheet_cutout', { id: part, face: { near: [10, 25, 0] }, profileId: 'x' }, 'FTR_RULE_NOT_FOUND');
    expectRefusal(orphan, 'add_relief', { id: part, bend: 'b1', end: 'end' }, 'FTR_RULE_NOT_FOUND');
    expectRefusal(orphan, 'flat_pattern', { id: part }, 'FTR_RULE_NOT_FOUND');
    expectRefusal(orphan, 'check_sheet_metal', { id: part }, 'FTR_RULE_NOT_FOUND');
    expectRefusal(orphan, 'export_flat_pattern_dxf', { id: part }, 'FTR_RULE_NOT_FOUND');
  });

  it('flat_pattern refuses a part without a root flat as non-developable', () => {
    const { doc, part } = bracket();
    const broken = withModel(doc, (model) => ({
      ...model,
      parts: { ...model.parts, [part]: { ...(model.parts[part] as SheetMetalPart), root: 'zz' } },
    }));
    expectRefusal(broken, 'flat_pattern', { id: part }, 'FTR_NON_DEVELOPABLE');
    expectRefusal(broken, 'materialize_flat_pattern', { id: part }, 'FTR_NON_DEVELOPABLE');
  });

  it('the pattern skips an invalid joggle record instead of failing', () => {
    const { doc, part } = bracket();
    const tweaked = withModel(doc, (model) => {
      const original = model.parts[part] as SheetMetalPart;
      const nodes = {
        ...original.nodes,
        j9: {
          id: 'j9',
          type: 'joggle' as const,
          on: 'f1',
          bends: ['b1', 'b1'] as [string, string],
          incline: 'f2',
          after: 'f2',
          line: [
            [0, 0],
            [1, 0],
          ] as [[number, number], [number, number]],
          offset: 0.001,
          angle: 1,
          insideRadius: 6,
        },
      };
      return { ...model, parts: { ...model.parts, [part]: { ...original, nodes, order: [...original.order, 'j9'] } } };
    });
    expect(data<{ joggles: unknown[] }>(tweaked, 'flat_pattern', { id: part }).joggles).toEqual([]);
  });
});

describe('sides of the material', () => {
  it.each([
    ['down', -1.6],
    ['mid', -0.8],
  ] as const)('a %s base keeps the flange on the same faces', (side, bottom) => {
    let doc = apply(createEmptyDocument(), 'create_sheet_metal_rule', RULE);
    const drawn = ok(doc, 'draw_rectangle', { width: 33.6, height: 50, position: [0, 0, 0] });
    const made = ok(drawn.document, 'add_sheet_metal_base', { profileId: drawn.affected[0], rule: RULE.name, side });
    const part = made.affected[0] as string;
    doc = apply(made.document, 'add_flange', {
      id: part,
      edge: { near: [33.6, 25, bottom + 0.8] },
      angle: 90,
      length: 30,
      lengthReference: 'outside_mold_line',
      position: 'material_outside',
    });
    const { min, max } = meshBounds(doc, part);
    expect(min[2]).toBeCloseTo(bottom, 6);
    expect(max[0]).toBeCloseTo(40, 6);
    expect(max[2]).toBeCloseTo(bottom + 30, 6);
    expect(data<{ extents: number[] }>(doc, 'flat_pattern', { id: part }).extents[0]).toBeCloseTo(65.845662983, 6);
  });

  it('draws the base into the first layer when the default layer is missing', () => {
    const drawn = ok(apply(createEmptyDocument(), 'create_sheet_metal_rule', RULE), 'draw_rectangle', {
      width: 10,
      height: 10,
      position: [0, 0, 0],
    });
    const noDefault: CadDocument = {
      ...drawn.document,
      layers: { 'layer-x': { id: 'layer-x', name: 'X', visible: true, locked: false } },
      layerOrder: ['layer-x'],
    };
    const made = ok(noDefault, 'add_sheet_metal_base', { profileId: drawn.affected[0], rule: RULE.name, side: 'up' });
    expect(made.document.entities[made.affected[0] as string]?.layerId).toBe('layer-x');
  });
});

describe('check_sheet_metal rules on flanges and converted parts', () => {
  const thresholds = {
    holeToBend: { value: 3, source: 'r7', verification: 'verified' },
    holeToEdge: { value: 3, source: 'r8', verification: 'verified' },
  };

  it('measures a hole in a flange against its own bend line and free edges', () => {
    const { doc, part } = bracket({ thresholds });
    const hole = ok(doc, 'draw_arc', { center: [0, 0], radius: 1, position: [39, 25, 8] });
    const rotated = {
      ...hole.document,
      entities: {
        ...hole.document.entities,
        [hole.affected[0] as string]: { ...(hole.document.entities[hole.affected[0] as string] as object), rotation: [0, Math.PI / 2, 0] },
      },
    } as CadDocument;
    const cut = apply(rotated, 'add_sheet_cutout', { id: part, face: { near: [39.2, 25, 8] }, profileId: hole.affected[0] });
    const check = data<FtrCheckData>(cut, 'check_sheet_metal', { id: part });
    const near = check.findings.find((finding) => finding.code === 'FTR_HOLE_TO_BEND_TOO_CLOSE');
    expect(near?.ids).toEqual([part, 'f2/cutout1', 'b1']);
    expect(near?.value).toBeCloseTo(8 - 6.4 - 1, 6);
  });

  it('flags a sharp bend on a converted part whose rule forbids it, and a rule with obround relief', () => {
    const ops: Op[] = [{ forward: 20 }, { turn: 'right', angleDeg: 90, radius: 0 }, { forward: 20 }];
    const { kernel } = syntheticSolid(sheetProfile(1.6, ops), 30);
    const boxed = ok(createEmptyDocument(), 'add_box', { size: [10, 10, 10] });
    const rule = apply(boxed.document, 'create_sheet_metal_rule', {
      ...RULE,
      insideRadius: 0,
      allowSharpBends: true,
      relief: { type: 'obround', widthRatio: 1 },
    });
    const converted = execute(
      rule,
      'convert_to_sheet_metal',
      { id: boxed.affected[0], stationaryFace: { near: [5, 15, 0] }, rule: RULE.name },
      ctxWith(kernel),
    );
    expect(converted.rejected, converted.summary).toBeUndefined();
    const forbidden = withModel(converted.document, (model) => ({
      ...model,
      rules: { ...model.rules, [RULE.name]: { ...(model.rules[RULE.name] as object), allowSharpBends: false } as never },
    }));
    const check = data<FtrCheckData>(forbidden, 'check_sheet_metal', { id: converted.affected[0] });
    expect(check.findings.map((finding) => finding.code)).toContain('FTR_SHARP_BEND_FORBIDDEN');
    expect(check.status).toBe('fail');
  });
});

describe('convert_to_sheet_metal on awkward B-reps', () => {
  const near = [10, 25, 0];
  const BRACKET: Op[] = [{ forward: 33.6 }, { turn: 'left', angleDeg: 90, radius: 4.8 }, { forward: 23.6 }];

  function attempt(
    options: SolidOptions,
    ops: Op[] = BRACKET,
    width = 50,
  ): { code: string | undefined; result: ReturnType<typeof execute> } {
    const { kernel } = syntheticSolid(sheetProfile(1.6, ops), width, options);
    const boxed = ok(createEmptyDocument(), 'add_box', { size: [10, 10, 10] });
    const doc = apply(boxed.document, 'create_sheet_metal_rule', { ...RULE, insideRadius: 4.8 });
    const result = execute(
      doc,
      'convert_to_sheet_metal',
      { id: boxed.affected[0], stationaryFace: { near }, rule: RULE.name },
      ctxWith(kernel),
    );
    return { code: result.error?.code, result };
  }

  it('keeps a circular hole as an exact circular cutout', () => {
    const full = syntheticSolid(sheetProfile(1.6, BRACKET), 50).topology.volume;
    const { result } = attempt({ hole: { center: [10, 25], radius: 3 }, volume: full - Math.PI * 9 * 1.6 });
    expect(result.rejected, result.summary).toBeUndefined();
    const flat = data<{ cutoutCount: number }>(result.document, 'flat_pattern', { id: result.affected[0] });
    expect(flat.cutoutCount).toBe(1);
    const part = result.document.sheetMetal?.parts[result.affected[0] as string];
    const root = part?.nodes['f1'];
    expect(root?.type === 'flat' && root.cutouts[0]?.circle?.radius).toBeCloseTo(3, 6);
  });

  it('refuses geometry that breaks the sheet-metal assumptions', () => {
    expect(attempt({ tweak: ({ faces }) => (faces[0] = { ...faces[0]!, loops: [faces[0]!.loops[0]!.slice(0, 3)] }) }).code).toBe(
      'FTR_NOT_SHEET_METAL',
    );
    expect(attempt({ tweak: ({ faces }) => (faces[1] = { ...faces[1]!, loops: [faces[1]!.loops[0]!.slice(0, 1)] }) }).code).toBe(
      'FTR_NOT_SHEET_METAL',
    );
    expect(
      attempt({
        tweak: ({ faces }) =>
          (faces[1] = { ...faces[1]!, surface: { ...(faces[1]!.surface as { type: 'cylinder' }), radius: 1 } as never }),
      }).code,
    ).toBe('FTR_NOT_SHEET_METAL');
  });

  it('refuses an open outer wire of a flange (the child face does not continue the bend)', () => {
    const result = attempt({
      tweak: ({ edges, faces }) => {
        const flangeOuter = faces[2]!;
        for (const index of flangeOuter.loops[0]!)
          edges[index] = {
            ...edges[index]!,
            start: [edges[index]!.start[0], edges[index]!.start[1], edges[index]!.start[2] + 0.5],
            end: [edges[index]!.end[0], edges[index]!.end[1], edges[index]!.end[2] + 0.5],
          };
      },
    });
    expect(result.code).toBe('FTR_NOT_SHEET_METAL');
  });
});
