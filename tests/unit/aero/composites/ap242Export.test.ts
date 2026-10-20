/** ap242Export: composite AP242 export / import (06 CMP M5), split from the former ap242.test.ts. Fixtures in ap242Support.ts. */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { appendComposite } from '@aero/composites/ap242/writer';
import { readComposite } from '@aero/composites/ap242/reader';
import { expectNoOp, expectPure } from '../../../helpers/expectNoOp';
import { apply, ok } from '../../../helpers/commandAssertions';
import { createEmptyDocument } from '@core/model/types';
import { fakeStepText } from '../../../helpers/fakeXdeKernel';
import { WOVEN } from './drapeFixtures';
import { AS4 } from './fixtures';
import { ctxOf, exportOf, importOf, modelOf, panelDoc, pliesOfPart, rect, requestOf, writeStep, type Imported } from './ap242Support';

describe('export_composite_ap242', () => {
  it('appends the ply table, rosettes, materials, part frame and validation properties to the writer text', () => {
    const { doc } = panelDoc();
    const { result, data } = exportOf(doc);
    expect(result.rejected, result.summary).toBeUndefined();
    expect(result.affected).toEqual([]);
    expect(result.document).toBe(doc);
    expect(data.selfCheck.band).toBe('green');
    expect(data.selfCheck.findings).toHaveLength(56);
    expect(data.plies.map((ply) => [ply.name, ply.order, ply.solids])).toEqual([
      ['P1', 0, ['P1 piece 1']],
      ['P2', 1, ['P2 piece 1']],
      ['P3', 2, ['P3 piece 1']],
    ]);
    expect(data.validation.plyCount).toBe(3);
    expect(data.validation.thickness).toBeCloseTo(WOVEN.plyThickness * 2 + AS4.plyThickness, 12);
    expect(data.validation.mass).toBeCloseTo(
      (200 * 100 * WOVEN.plyThickness + 160 * 80 * AS4.plyThickness + 80 * 60 * WOVEN.plyThickness) * 0.0016,
      6,
    );
    expect(data.solids).toEqual({ exact: 0, faceted: expect.any(Array) });
    expect(data.solids.faceted).toHaveLength(3);
    for (const marker of ['composite laminate', 'composite ply', 'composite rosette', 'composite material', 'composite ply piece']) {
      expect(data.step).toContain(`'${marker}'`);
    }
    expect(data.step).toContain("'composite validation property'");
    expect(data.step).toContain("'number of plies'");
    expect(data.step).toContain("CONVERSION_BASED_UNIT('DEGREE'");
    expect(result.summary).toContain('3 ply(ies) in the table');
    expectPure(doc, () => execute(doc, 'export_composite_ap242', { part: 'Panel' }, ctxOf().ctx));
  });

  it('is deterministic: the same document and timestamp give the same bytes', () => {
    const { doc } = panelDoc();
    expect(exportOf(doc).data.step).toBe(exportOf(doc).data.step);
  });

  it('writes the implicit table alone with includeSolids false (the tool solid stays the anchor)', () => {
    const { doc } = panelDoc();
    const { data } = exportOf(doc, { includeSolids: false });
    expect(data.plies.every((ply) => ply.solids.length === 0)).toBe(true);
    expect(data.step).not.toContain("'composite ply piece'");
    expect(data.solids).toEqual({ exact: 0, faceted: [] });
  });

  it('round-trips through the reader: plies, orientations, boundaries, rosette, material and areas', () => {
    const { doc } = panelDoc();
    const { data } = exportOf(doc);
    const read = readComposite(data.step);
    if (!read.ok) throw new Error(read.reason);
    expect(read.record.name).toBe('Panel');
    expect(read.record.units).toBe('mm');
    expect(read.record.tool.name).toBe('Panel tool');
    expect(read.record.plies.map((ply) => [ply.name, ply.order, ply.orientation, ply.material, ply.sequence, ply.rosette])).toEqual(
      pliesOfPart(doc, 'Panel').plies.map((ply) => [ply.name, ply.order, ply.orientation, ply.materialName, ply.sequence, 'R0']),
    );
    expect(read.record.plies[1]?.boundary).toEqual({ kind: 'polygons', polygons: [rect(20, 10, 180, 90)] });
    expect(read.record.plies[0]?.boundary).toEqual({ kind: 'whole_face' });
    expect(read.record.rosettes).toEqual([{ name: 'R0', origin: [0, 0, 0], axis0: [1, 0, 0], normal: [0, 0, 1], method: 'translational' }]);
    expect(read.record.materials.map((material) => material.name).sort()).toEqual([AS4.name, WOVEN.name].sort());
    expect(read.embedded.plyCount).toBe(3);
    expect(read.embedded.plyAreas['P2']).toBeCloseTo(160 * 80, 9);
    expect(read.linkedSolids).toEqual({ P1: ['P1 piece 1'], P2: ['P2 piece 1'], P3: ['P3 piece 1'] });
    expect(read.laminates).toBe(1);
  });

  it('refuses an unknown part, a part without plies, a missing tool solid, clashing names and a kernel without a writer', () => {
    const { doc, part, tool } = panelDoc();
    const unknown = execute(doc, 'export_composite_ap242', { part: 'Nope' }, ctxOf().ctx);
    expect(unknown.error?.code).toBe('CMP_REF_MISSING');
    expect(unknown.error?.paths).toContain('params.part');
    const empty = apply(panelDoc(false).doc, 'delete_ply', { part: 'Panel', ply: 'P1' });
    const bare = (() => {
      let current = empty;
      for (const name of ['P2', 'P3']) current = apply(current, 'delete_ply', { part: 'Panel', ply: name });
      return current;
    })();
    const { ctx } = ctxOf();
    const none = execute(bare, 'export_composite_ap242', { part: 'Panel' }, ctx);
    expect(none.error?.code).toBe('CMP_NO_PLIES');
    expectNoOp(none, bare);

    const noTool = apply(doc, 'delete_entities', { ids: [tool] });
    expect(execute(noTool, 'export_composite_ap242', { part }, ctx).error?.code).toBe('CMP_AP242_TOOL_MISSING');

    const clash = apply(doc, 'set_entity_name', { id: tool, name: 'P1 piece 1' });
    expect(execute(clash, 'export_composite_ap242', { part }, ctx).error?.code).toBe('CMP_AP242_NAME_CLASH');

    const { ctx: noWriter } = ctxOf({ noWriter: true });
    const refused = execute(doc, 'export_composite_ap242', { part }, noWriter);
    expect(refused.rejected).toBe(true);
    expect(refused.error?.code).toBe('XCH_WRITER_UNAVAILABLE');
    expectNoOp(refused, doc);
  });

  it('the writer refuses a text without a DATA section, without the tool product or without a representation context', () => {
    const { doc } = panelDoc(false);
    const { data } = exportOf(doc);
    const read = readComposite(data.step);
    if (!read.ok) throw new Error(read.reason);
    const record = { ...read.record, validation: { plyCount: 3, thickness: 0.625 } };
    const plain = (names: string[]): string =>
      fakeStepText(
        names.map((name) => ({ name, volume: 1, area: 1, centroid: [0, 0, 0] })),
        { withProperties: false },
      );
    expect(appendComposite('nothing', record)).toEqual({ ok: false, reason: 'the STEP text has no DATA section' });
    const missingProduct = appendComposite(writeStep(requestOf(['Other'])), record);
    expect(missingProduct.ok || missingProduct.reason).toContain('no product named "Panel tool"');
    const noContext = appendComposite(plain(['Panel tool']), record);
    expect(noContext.ok || noContext.reason).toContain('representation context');
  });

  it('writes lengths with SI or conversion-based units and reads them back', () => {
    const { doc } = panelDoc(false);
    const { data } = exportOf(doc);
    const read = readComposite(data.step);
    if (!read.ok) throw new Error(read.reason);
    const base = writeStep(requestOf(['Panel tool']));
    for (const [units, marker] of [
      ['in', "CONVERSION_BASED_UNIT('INCH'"],
      ['ft', "CONVERSION_BASED_UNIT('FOOT'"],
      ['cm', 'SI_UNIT(.CENTI.,.METRE.)'],
      ['m', 'SI_UNIT($,.METRE.)'],
    ] as const) {
      const written = appendComposite(base, { ...read.record, units, validation: { plyCount: 3, thickness: 0.625 } });
      if (!written.ok) throw new Error(written.reason);
      expect(written.text).toContain(marker);
      const back = readComposite(written.text);
      expect(back.ok && back.record.units).toBe(units);
      expect(back.ok && back.embedded.mass).toBeUndefined();
    }
  });
});

describe('composite records that carry optional data', () => {
  it('keeps rules, drop rules, drape settings, cuts, a rosette axis and leaves the mass out for a material without density', () => {
    let doc = apply(createEmptyDocument(), 'set_units', { units: 'mm' });
    doc = apply(doc, 'create_lamina_material', { ...WOVEN, name: 'Dry', density: undefined });
    const tool = ok(doc, 'add_box', { size: [600, 400, 10], anchor: 'min', position: [0, 0, -10] });
    doc = apply(tool.document, 'set_entity_name', { id: tool.affected[0], name: 'Tool' });
    doc = apply(doc, 'define_rosette', {
      name: 'Rax',
      origin: [0, 0, 0],
      axis0: [1, 0, 0],
      normal: [0, 0, 1],
      method: 'cylindrical',
      axis: [1, 0, 0],
    });
    const part = ok(doc, 'create_composite_part', {
      name: 'Panel',
      toolSurface: { entityId: tool.affected[0], faceNear: [300, 200, 0] },
      rosette: 'Rax',
    });
    doc = apply(part.document, 'set_laminate_rules', { part: 'Panel', symmetric: false, maxAngleChange: 60 });
    doc = apply(doc, 'set_ply_drop_rules', { part: 'Panel', rampRatio: 10 });
    doc = apply(doc, 'add_ply', {
      part: 'Panel',
      name: 'P1',
      material: 'Dry',
      orientation: 30,
      boundary: { kind: 'whole_face' },
      drape: { method: 'developable', stepLength: 5 },
    });
    doc = apply(doc, 'split_ply', {
      ply: 'P1',
      part: 'Panel',
      kind: 'splice',
      path: [
        [300, -10],
        [300, 410],
      ],
      overlap: 8,
    });
    const { data } = exportOf(doc, {}, {});
    expect(data.validation.mass).toBeUndefined();
    const read = readComposite(data.step);
    if (!read.ok) throw new Error(read.reason);
    expect(read.record.rules).toMatchObject({ symmetric: false, maxAngleChange: 60 });
    expect(read.record.plyDropRules).toMatchObject({ rampRatio: 10 });
    expect(read.record.rosettes[0]?.axis).toEqual([1, 0, 0]);
    expect(read.record.plies[0]?.drape).toEqual({ method: 'developable', stepLength: 5 });
    expect(read.record.plies[0]?.cuts).toHaveLength(1);
    expect(read.embedded.mass).toBeUndefined();
    const imported = importOf(createEmptyDocument(), { text: data.step, importSolids: false });
    expect(imported.rejected).toBeUndefined();
    const back = pliesOfPart(imported.document, 'Panel');
    expect(back.plies[0]?.drape).toEqual({ method: 'developable', stepLength: 5 });
    expect(back.plies[0]?.cuts).toHaveLength(1);
    expect(back.part.rules).toMatchObject({ symmetric: false });
    expect(back.part.plyDropRules).toMatchObject({ rampRatio: 10 });
    expect((imported.data as Imported).validation.band).toBe('green');
    expect(Object.values(modelOf(imported.document).rosettes)[0]?.axis).toEqual([1, 0, 0]);
  });
});
