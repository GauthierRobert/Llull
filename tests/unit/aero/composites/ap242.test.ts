/**
 * export_composite_ap242 / import_composite_ap242 (06 CMP M5) over a scripted XDE kernel (no OpenCascade): the composite records appended to the
 * writer's text, the reader, the validation properties and their bands, the refusals. The live round trip is server/tests/nativeCompositeAp242.test.ts.
 * The base text is a synthetic Part 21 file (one PRODUCT chain per product + a geometric context with global units): the CAx-IF composite test
 * cases are not available offline, so no third-party reference file is used.
 */

import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import { appendComposite } from '@aero/composites/ap242/writer';
import { readComposite } from '@aero/composites/ap242/reader';
import { quoted, real, unquoted } from '@aero/composites/ap242/part21';
import { readStandard, withoutCompositeUsages } from '@aero/composites/ap242/standardReader';
import { spherePatch } from './drapeFixtures';
import { expectNoOp, expectPure } from '../../../helpers/expectNoOp';
import { apply, ok } from '../../../helpers/commandAssertions';

import { createEmptyDocument } from '@core/model/types';
import { fakeStepText } from '../../../helpers/fakeXdeKernel';
import { WOVEN } from './drapeFixtures';
import type { CadDocument } from '@core/model/types';
import { AS4, withMaterials } from './fixtures';
import {
  ctxOf,
  exportOf,
  importOf,
  modelOf,
  panelDoc,
  pliesOfPart,
  rect,
  requestOf,
  treeOf,
  writeStep,
  type Imported,
} from './ap242Support';

describe('Part 21 values', () => {
  it('writes reals the reader accepts and strings with quotes, backslashes and non-ASCII characters', () => {
    expect(real(5)).toBe('5.');
    expect(real(0.25)).toBe('0.25');
    expect(real(1e-7)).toBe('1.E-7');
    expect(real(1.5e-7)).toBe('1.5E-7');
    expect(real(1e21)).toBe('1.E21');
    expect(real(-0)).toBe('0.');
    expect(real(Number.NaN)).toBe('0.');
    const text = "O'Brien \\ plié ✓";
    expect(quoted(text)).toBe("'O''Brien \\\\ pli\\X2\\00E9\\X0\\ \\X2\\2713\\X0\\'");
    expect(unquoted(quoted(text).slice(1, -1).replaceAll("''", "'"))).toBe(text);
  });
});

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

describe('import_composite_ap242', () => {
  const exported = (): { doc: CadDocument; step: string; names: string[] } => {
    const { doc } = panelDoc();
    const { data } = exportOf(doc);
    return { doc, step: data.step, names: ['Panel tool', 'P1 piece 1', 'P2 piece 1', 'P3 piece 1'] };
  };

  it('rebuilds the part, plies, rosette and unverified materials; attaches the part to the imported tool solid', () => {
    const { doc, step, names } = exported();
    const result = importOf(createEmptyDocument(), { text: step }, { stepImport: treeOf(names) });
    expect(result.rejected).toBeUndefined();
    const data = result.data as Imported;
    expect(data.validation.band).toBe('green');
    expect(data.validation.findings).toHaveLength(56);
    expect(data.tool.imported).toBe(true);
    expect(data.solids.imported).toHaveLength(4);
    expect(data.solids.unlinked).toBe(0);
    expect(data.materials.created.sort()).toEqual([AS4.name, WOVEN.name].sort());
    expect(data.rosettes.created).toEqual(['R0']);
    expect(data.reviewRequired).toEqual({ value: true, reasons: ['composite_import_unverified'] });
    const back = pliesOfPart(result.document, 'Panel');
    const original = pliesOfPart(doc, 'Panel');
    expect(back.plies.map((ply) => [ply.name, ply.order, ply.orientation, ply.materialName, ply.sequence, ply.boundary])).toEqual(
      original.plies.map((ply) => [ply.name, ply.order, ply.orientation, ply.materialName, ply.sequence, ply.boundary]),
    );
    expect(back.part.outline).toEqual(original.part.outline);
    expect(back.part.surface).toEqual(original.part.surface);
    expect(back.part.toolFaces[0]?.entityId).toBe(data.tool.entityId);
    expect(result.document.entities[data.tool.entityId]?.name).toBe('Panel tool');
    expect(Object.values(modelOf(result.document).materials).every((material) => material.basis === 'unknown')).toBe(true);
    expect(result.affected).toEqual(expect.arrayContaining([data.part]));
    expect(result.summary).toContain('Review required');
  });

  it('builds the part without solids (importSolids false), keeping the tool id of the file; reuses materials and rosettes the document has', () => {
    const { doc, step } = exported();
    const result = importOf(doc, { stepBase64: Buffer.from(step).toString('base64'), name: 'Panel copy', importSolids: false });
    expect(result.rejected).toBeUndefined();
    const data = result.data as Imported;
    expect(data.tool.imported).toBe(false);
    expect(data.solids.imported).toEqual([]);
    expect(data.materials.reused.sort()).toEqual([AS4.name, WOVEN.name].sort());
    expect(data.rosettes.created).toEqual([]);
    expect(pliesOfPart(result.document, 'Panel copy').plies).toHaveLength(3);
    expect(Object.keys(modelOf(result.document).materials)).toHaveLength(Object.keys(modelOf(doc).materials).length);
    expectPure(doc, () => importOf(doc, { text: step, importSolids: false, name: 'Another' }));
  });

  it('flags a tampered ply area red, a small deviation yellow and a removed property not checkable; the import still completes for review', () => {
    const { step } = exported();
    const areaRecord = /#(\d+)=MEASURE_REPRESENTATION_ITEM\('ply area',AREA_MEASURE\(12800\.\),#\d+\);/.exec(step);
    expect(areaRecord, 'the P2 area record').not.toBeNull();
    const tampered = (value: string): string => step.replace(`'ply area',AREA_MEASURE(12800.)`, `'ply area',AREA_MEASURE(${value})`);
    const findingOf = (text: string, property: string, subject: string): { band: string } | undefined =>
      (
        (importOf(createEmptyDocument(), { text, importSolids: false }).data as Imported).validation.findings as {
          property: string;
          subject: string;
          band: string;
        }[]
      ).find((finding) => finding.property === property && finding.subject === subject);
    const red = importOf(createEmptyDocument(), { text: tampered('15000.'), importSolids: false });
    expect(red.rejected).toBeUndefined();
    expect((red.data as Imported).validation.band).toBe('red');
    expect((red.data as Imported).reviewRequired.reasons).toContain('validation_red');
    expect(findingOf(tampered('12800.5'), 'ply area', 'P2')?.band).toBe('yellow');
    const removed = step.replaceAll("'llull composite validation','ply area'", "'llull composite validation','other'");
    expect(findingOf(removed, 'ply area', 'P2')?.band).toBe('not_checkable');
  });

  it('refuses bad input: no text, other-system files, damaged records, a taken name, solids the kernel cannot import', () => {
    const { step } = exported();
    const empty = createEmptyDocument();
    expect(execute(empty, 'import_composite_ap242', {}, ctxOf().ctx).error?.code).toBe('CMP_PARAM_INVALID');
    const plain = fakeStepText([{ name: 'Plate', volume: 1, area: 1, centroid: [0, 0, 0] }]);
    expect(importOf(empty, { text: plain, importSolids: false }).error?.code).toBe('CMP_AP242_NO_COMPOSITE');
    expect(importOf(empty, { text: 'not a step file', importSolids: false }).error?.code).toBe('CMP_AP242_NO_COMPOSITE');
    const damaged: [string, (text: string) => string][] = [
      ['an unknown encoding', (text) => text.replace('llull-composite-2', 'llull-composite-9')],
      ['no tool name', (text) => text.replace("DESCRIPTIVE_REPRESENTATION_ITEM('tool'", "DESCRIPTIVE_REPRESENTATION_ITEM('toll'")],
      ['no part frame', (text) => text.replace('{"surface":', '{"surfacx":')],
      [
        'no rosette method',
        (text) => text.replace("DESCRIPTIVE_REPRESENTATION_ITEM('method'", "DESCRIPTIVE_REPRESENTATION_ITEM('methode'"),
      ],
      ['a rosette without axis0', (text) => text.replace("DIRECTION('axis0'", "DIRECTION('axisx'")],
      ['unreadable material data', (text) => text.replace('"source":"', '"source":')],
      [
        'a ply without orientation',
        (text) => text.replace("MEASURE_REPRESENTATION_ITEM('orientation'", "MEASURE_REPRESENTATION_ITEM('orientatio'"),
      ],
      [
        'a degenerate ply boundary',
        (text) => text.replace(/POLYLINE\('ply boundary 1',\((#\d+),(#\d+),#\d+,#\d+\)\)/, "POLYLINE('ply boundary 1',($1,$2))"),
      ],
      [
        'a part rosette the file lacks',
        (text) =>
          text.replace("DESCRIPTIVE_REPRESENTATION_ITEM('part rosette','R0')", "DESCRIPTIVE_REPRESENTATION_ITEM('part rosette','R9')"),
      ],
    ];
    for (const [what, damage] of damaged) {
      const text = damage(step);
      expect(text, what).not.toBe(step);
      expect(importOf(empty, { text, importSolids: false }).error?.code, what).toBe('CMP_AP242_MALFORMED');
    }
    const taken = importOf(empty, { text: step, importSolids: false });
    expect(taken.rejected).toBeUndefined();
    const again = importOf(taken.document, { text: step, importSolids: false });
    expect(again.error?.code).toBe('CMP_NAME_TAKEN');
    expectNoOp(again, taken.document);
    const noKernel = execute(empty, 'import_composite_ap242', { text: step }, { ...defaultContext(), kernel: null });
    expect(noKernel.rejected).toBe(true);
    const failing = importOf(empty, { text: step }, { stepImport: { error: 'no_solid', detail: 'nothing' } });
    expect(failing.error?.code).toBe('CMP_AP242_SOLIDS_FAILED');
    expectNoOp(failing, empty);
  });

  it('counts ply solids the file lists but the import did not yield under their names', () => {
    const { step } = exported();
    const result = importOf(createEmptyDocument(), { text: step }, { stepImport: treeOf(['Panel tool', 'P1 piece 1']) });
    expect((result.data as Imported).solids.unlinked).toBe(2);
  });

  it('keeps a ply rosette other than the part rosette and an unknown ply rosette falls back to the part rosette', () => {
    const { doc } = panelDoc();
    const withSecond = apply(doc, 'define_rosette', {
      name: 'R90',
      origin: [0, 0, 0],
      axis0: [0, 1, 0],
      normal: [0, 0, 1],
      method: 'translational',
    });
    const { data } = exportOf(withSecond);
    const result = importOf(createEmptyDocument(), { text: data.step.replace("'rosette','R0'", "'rosette','R404'"), importSolids: false });
    expect(result.rejected).toBeUndefined();
    const rosettes = Object.values(modelOf(result.document).rosettes);
    expect(rosettes.map((rosette) => rosette.name)).toEqual(['R0']);
    expect(pliesOfPart(result.document, 'Panel').plies.every((ply) => ply.rosetteId === rosettes[0]?.id)).toBe(true);
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

describe('the CAx-IF structure of the file', () => {
  const exportedText = (): string => exportOf(panelDoc().doc).data.step;

  it('writes the practice identification, the ply laminate table with ordered sequences, plies with material / angle / thickness and the practice validation property names', () => {
    const step = exportedText();
    expect(step).toContain("'CAx-IF Rec.Pracs.---Composite Materials---4.3---2025-10-02'");
    for (const entity of [
      'PLY_LAMINATE_TABLE(',
      'PLY_LAMINATE_SEQUENCE_DEFINITION(',
      'MAKE_FROM_USAGE_OPTION(',
      'NEXT_ASSEMBLY_USAGE_OCCURRENCE(',
      'REINFORCEMENT_ORIENTATION_BASIS(',
      'PLY_ORIENTATION_ANGLE(',
      'PLY_ANGLE_REPRESENTATION(',
      'CARTESIAN_11()',
      'ITEM_IDENTIFIED_REPRESENTATION_USAGE(',
      'ROW_REPRESENTATION_ITEM(',
      'GEOMETRICALLY_BOUNDED_SURFACE_SHAPE_REPRESENTATION(',
    ])
      expect(step, entity).toContain(entity);
    for (const category of ['part', 'ply_laminate', 'ply', 'woven_assembly', 'filament_assembly'])
      expect(step).toContain(`PRODUCT_RELATED_PRODUCT_CATEGORY('${category}'`);
    for (const name of [
      'number of tables',
      'number of sequences',
      'number of plies',
      'number of cores',
      'number of materials',
      'number of orientations',
      'number of rosettes',
      'total ply surface area',
      'ordered list of orientation values',
      'ordered sequences per laminate table',
      'curve length measure',
      'number of ply pieces per ply',
      'total boundary curve length',
    ])
      expect(step, name).toContain(`'${name}'`);
    expect(step).toMatch(/INTEGER_REPRESENTATION_ITEM\('number of plies',3\.\)/);
    expect(step).toContain("'ordered list of orientation values','-45 0 45'");
    const std = readComposite(step);
    if (!std.ok) throw new Error(std.reason);
    expect(std.standard.present).toBe(true);
    expect(std.standard.recPracId).toBe(true);
    expect(std.standard.table).toBe('Panel');
    expect(std.standard.sequences.map((sequence) => [sequence.name, sequence.plies])).toEqual([
      ['S1', ['P1']],
      ['S2', ['P2']],
      ['S3', ['P3']],
    ]);
    expect(std.standard.plies.map((ply) => [ply.name, ply.material, ply.rosette, ply.angle, ply.thickness, ply.pieces])).toEqual([
      ['P1', 'Woven', 'R0', 0, 0.25, ['P1 piece 1']],
      ['P2', 'AS4_3501_6', 'R0', 45, 0.125, ['P2 piece 1']],
      ['P3', 'Woven', 'R0', -45, 0.25, ['P3 piece 1']],
    ]);
    expect(std.standard.rosettes).toEqual(['R0']);
  });

  it('flags a changed number of plies, a changed ply angle and a changed sequence name red, and a removed property not checkable', () => {
    const step = exportedText();
    const bandOf = (text: string, property: string): string | undefined => {
      const bands = (importOf(createEmptyDocument(), { text, importSolids: false }).data as Imported).validation.findings
        .filter((finding) => finding.property === property)
        .map((finding) => finding.band);
      return bands.includes('red') ? 'red' : bands.includes('not_checkable') ? 'not_checkable' : bands[0];
    };
    const tamper = (from: string | RegExp, to: string): string => {
      const text = step.replace(from, to);
      expect(text).not.toBe(step);
      return text;
    };
    expect(
      bandOf(
        tamper("INTEGER_REPRESENTATION_ITEM('number of plies',3.)", "INTEGER_REPRESENTATION_ITEM('number of plies',4.)"),
        'number of plies',
      ),
    ).toBe('red');
    expect(
      bandOf(
        tamper(
          /MEASURE_REPRESENTATION_ITEM\('orientation',PLANE_ANGLE_MEASURE\(45\.\)/,
          "MEASURE_REPRESENTATION_ITEM('orientation',PLANE_ANGLE_MEASURE(40.)",
        ),
        'structure: ply orientation angle',
      ),
    ).toBe('red');
    expect(
      bandOf(
        tamper("DESCRIPTIVE_REPRESENTATION_ITEM('sequence name','S2')", "DESCRIPTIVE_REPRESENTATION_ITEM('sequence name','SX')"),
        'ordered sequences per laminate table',
      ),
    ).toBe('red');
    expect(
      bandOf(
        tamper("'ordered list of orientation values','-45 0 45'", "'ordered list of orientation values','-45 0 46'"),
        'ordered list of orientation values',
      ),
    ).toBe('red');
    expect(bandOf(tamper("'total ply surface area'", "'total ply surface areas'"), 'total ply surface area')).toBe('not_checkable');
    expect(bandOf(step, 'structure: ply material')).toBe('green');
  });

  it('reads files of the first encoding (no CAx-IF structure) and answers no structure for text without a table', () => {
    const step = exportedText();
    const legacy = step
      .replace('llull-composite-2', 'llull-composite-1')
      .replaceAll("'llull composite validation'", "'composite validation property'");
    const read = readComposite(legacy);
    expect(read.ok && read.embedded.plyCount).toBe(3);
    const stripped = legacy
      .split('\n')
      .filter((line) => !/PLY_LAMINATE|REINFORCEMENT_ORIENTATION|PLY_ORIENTATION_ANGLE|PLY_ANGLE_REP/.test(line))
      .join('\n');
    expect(readStandard(stripped).present).toBe(false);
    expect(readStandard('not a step file').present).toBe(false);
    const result = importOf(createEmptyDocument(), { text: stripped, importSolids: false });
    expect(result.rejected).toBeUndefined();
    expect((result.data as Imported).validation.band).toBe('green');
    expect(withoutCompositeUsages("ISO-10303-21;\nDATA;\n#1=PRODUCT('a','a','',());\nENDSEC;\n")).toContain('PRODUCT');
    expect(withoutCompositeUsages(step)).not.toContain('NEXT_ASSEMBLY_USAGE_OCCURRENCE');
  });

  it('writes the base surface of plane, cylinder, cone and sphere tools and none for a NURBS sheet; a radial rosette is a polar_11', () => {
    const surfaceOf = (doc: CadDocument, part: string): string => exportOf(doc, { part }).data.step;
    const panel = surfaceOf(panelDoc().doc, 'Panel');
    expect(panel).toMatch(/PLANE\('base_surface'/);
    expect(panel).toContain("DIRECTION('material side'");

    let doc = apply(withMaterials(), 'create_lamina_material', WOVEN);
    doc = apply(doc, 'define_rosette', {
      name: 'Rax',
      origin: [0, 0, 0],
      axis0: [0, 0, 1],
      normal: [1, 0, 0],
      method: 'cylindrical',
      axis: [0, 0, 1],
    });
    const tube = ok(doc, 'add_cylinder', { radius: 50, height: 200, position: [0, 0, 0] });
    const withTube = ok(tube.document, 'create_composite_part', {
      name: 'Tube',
      rosette: 'Rax',
      toolSurface: { entityId: tube.affected[0], faceNear: [50, 0, 0] },
    });
    doc = apply(withTube.document, 'add_ply', {
      part: 'Tube',
      name: 'T1',
      material: WOVEN.name,
      orientation: 0,
      boundary: { kind: 'whole_face' },
    });
    expect(surfaceOf(doc, 'Tube')).toMatch(/CYLINDRICAL_SURFACE\('base_surface'/);

    const cone = ok(doc, 'add_cone', { radius: 100, height: 100, position: [0, 0, 0] });
    const withCone = ok(cone.document, 'create_composite_part', {
      name: 'Funnel',
      rosette: 'Rax',
      toolSurface: { entityId: cone.affected[0], faceNear: [50, 0, 50] },
    });
    doc = apply(withCone.document, 'add_ply', {
      part: 'Funnel',
      name: 'F1',
      material: WOVEN.name,
      orientation: 0,
      boundary: { kind: 'whole_face' },
    });
    expect(surfaceOf(doc, 'Funnel')).toMatch(/CONICAL_SURFACE\('base_surface'/);

    let dome = apply(withMaterials(), 'create_lamina_material', WOVEN);
    dome = apply(dome, 'define_rosette', { name: 'R0', origin: [0, 0, 0], axis0: [1, 0, 0], normal: [0, 0, 1], method: 'radial' });
    const ball = ok(dome, 'add_sphere', { radius: 100, position: [0, 0, 0] });
    const withBall = ok(ball.document, 'create_composite_part', {
      name: 'Dome',
      rosette: 'R0',
      toolSurface: { entityId: ball.affected[0], faceNear: [0, 0, 100] },
    });
    dome = apply(withBall.document, 'add_ply', {
      part: 'Dome',
      name: 'D1',
      material: WOVEN.name,
      orientation: 0,
      boundary: { kind: 'whole_face' },
    });
    const domeText = surfaceOf(dome, 'Dome');
    expect(domeText).toMatch(/SPHERICAL_SURFACE\('base_surface'/);
    expect(domeText).toContain('POLAR_11()');

    let sheet = apply(withMaterials(), 'create_lamina_material', WOVEN);
    sheet = apply(sheet, 'define_rosette', { name: 'R0', origin: [0, 0, 0], axis0: [1, 0, 0], normal: [0, 0, 1], method: 'translational' });
    const patch = ok(sheet, 'create_nurbs_surface', spherePatch(100, 30, 90));
    const near = [100 * Math.sin(Math.PI / 3) * Math.SQRT1_2, 100 * Math.sin(Math.PI / 3) * Math.SQRT1_2, 50];
    const onPatch = ok(patch.document, 'create_composite_part', {
      name: 'Skin',
      rosette: 'R0',
      toolSurface: { entityId: patch.affected[0], faceNear: near },
    });
    sheet = apply(onPatch.document, 'add_ply', {
      part: 'Skin',
      name: 'K1',
      material: WOVEN.name,
      orientation: 0,
      boundary: { kind: 'whole_face' },
    });
    const nurbsText = surfaceOf(sheet, 'Skin');
    expect(nurbsText).not.toContain("'base_surface'");
    expect(nurbsText).toContain('PLY_LAMINATE_TABLE(');
  });
});
