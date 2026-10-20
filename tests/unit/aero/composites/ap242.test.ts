/**
 * export_composite_ap242 / import_composite_ap242 (06 CMP M5) over a scripted XDE kernel (no OpenCascade): the composite records appended to the
 * writer's text, the reader, the validation properties and their bands, the refusals. The live round trip is server/tests/nativeCompositeAp242.test.ts.
 * The base text is a synthetic Part 21 file (one PRODUCT chain per product + a geometric context with global units): the CAx-IF composite test
 * cases are not available offline, so no third-party reference file is used.
 */

import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import type { GeometryKernel } from '@core/geometry/kernel';
import type { ExchangeWriteRequest, ImportedExchange } from '@core/geometry/kernelExchange';
import type { CompositePart, CompositesModel, Ply } from '@core/model/composites';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { appendComposite } from '@aero/composites/ap242/writer';
import { readComposite } from '@aero/composites/ap242/reader';
import { quoted, real, unquoted } from '@aero/composites/ap242/part21';
import { expectNoOp, expectPure } from '../../../helpers/expectNoOp';
import { fakeBrep, fakeStepText, fakeXdeKernel, importedBody, type XdeFakeSpec } from '../../../helpers/fakeXdeKernel';
import { apply, ok } from '../../../helpers/commandAssertions';
import { WOVEN } from './drapeFixtures';
import { AS4, ROSETTE, withMaterials } from './fixtures';

/** The fake writer's text plus a geometric context with global units, the one the composite records borrow. */
const writeStep = (request: Pick<ExchangeWriteRequest, 'products'>): string => {
  const base = fakeStepText(
    request.products.map((product) => ({
      name: product.name,
      volume: product.validation?.volume ?? 1,
      area: product.validation?.area ?? 1,
      centroid: product.validation?.centroid ?? [0, 0, 0],
    })),
  );
  const context = [
    "#9000 = ( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNIT_ASSIGNED_CONTEXT((#1)) REPRESENTATION_CONTEXT('ctx','3D') );",
    "#9001 = REPRESENTATION('',(#9002),#9000);",
    "#9002 = MEASURE_REPRESENTATION_ITEM('x',VOLUME_MEASURE(1.),#1);",
  ].join('\n');
  return base.replace('ENDSEC;\nEND-ISO', `${context}\nENDSEC;\nEND-ISO`);
};

const requestOf = (names: readonly string[]): Pick<ExchangeWriteRequest, 'products'> => ({
  products: names.map((name) => ({ key: name, name, solids: [] })),
});

const ctxOf = (spec: XdeFakeSpec = {}): { ctx: ExecutionContext; kernel: GeometryKernel } => {
  const { kernel } = fakeXdeKernel({ writeStep, ...spec });
  return { ctx: { ...defaultContext(), kernel }, kernel };
};

const rect = (x0: number, y0: number, x1: number, y1: number): number[][] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

/** A 200 x 100 panel on a named tool box: a full ply, a +45 polygon of another material and a -45 polygon; with ply solids when asked. */
function panelDoc(withSolids = true): { doc: CadDocument; part: string; tool: string } {
  let doc = apply(withMaterials(), 'create_lamina_material', WOVEN);
  const tool = ok(doc, 'add_box', { size: [200, 100, 10], anchor: 'min', position: [0, 0, -10] });
  doc = apply(tool.document, 'set_entity_name', { id: tool.affected[0], name: 'Panel tool' });
  doc = apply(doc, 'define_rosette', ROSETTE);
  const part = ok(doc, 'create_composite_part', {
    name: 'Panel',
    toolSurface: { entityId: tool.affected[0], faceNear: [100, 50, 0] },
    rosette: 'R0',
  });
  doc = part.document;
  const id = part.affected[0] as string;
  doc = apply(doc, 'add_ply', { part: id, name: 'P1', material: WOVEN.name, orientation: 0, boundary: { kind: 'whole_face' } });
  doc = apply(doc, 'add_ply', {
    part: id,
    name: 'P2',
    material: AS4.name,
    orientation: 45,
    boundary: { kind: 'polygon', polygons: [rect(20, 10, 180, 90)] },
  });
  doc = apply(doc, 'add_ply', {
    part: id,
    name: 'P3',
    material: WOVEN.name,
    orientation: -45,
    boundary: { kind: 'polygon', polygons: [rect(60, 20, 140, 80)] },
  });
  if (withSolids) doc = apply(doc, 'create_ply_solids', { part: id });
  return { doc, part: id, tool: tool.affected[0] as string };
}

interface Exported {
  readonly step: string;
  readonly selfCheck: { readonly band: string; readonly findings: readonly unknown[] };
  readonly plies: readonly {
    readonly name: string;
    readonly order: number;
    readonly area: number;
    readonly thickness: number;
    readonly solids: string[];
  }[];
  readonly validation: { readonly plyCount: number; readonly thickness: number; readonly mass?: number };
  readonly solids: { readonly exact: number; readonly faceted: readonly string[] };
  readonly records: number;
}

const exportOf = (
  doc: CadDocument,
  params: Record<string, unknown> = {},
  spec: XdeFakeSpec = {},
): { result: CommandResult; data: Exported } => {
  const { ctx } = ctxOf(spec);
  const result = execute(doc, 'export_composite_ap242', { part: 'Panel', ...params }, ctx);
  return { result, data: result.data as Exported };
};

const importOf = (doc: CadDocument, params: Record<string, unknown>, spec: XdeFakeSpec = {}): CommandResult =>
  execute(doc, 'import_composite_ap242', params, ctxOf(spec).ctx);

interface Imported {
  readonly part: string;
  readonly validation: {
    readonly band: string;
    readonly findings: readonly {
      readonly property: string;
      readonly subject: string;
      readonly band: string;
      readonly embedded: number | null;
    }[];
  };
  readonly materials: { readonly created: string[]; readonly reused: string[] };
  readonly rosettes: { readonly created: string[] };
  readonly tool: { readonly entityId: string; readonly imported: boolean };
  readonly solids: { readonly imported: string[]; readonly unlinked: number; readonly perPly: { readonly solids: string[] }[] };
  readonly reviewRequired: { readonly value: boolean; readonly reasons: string[] };
}

/** The solids an import_step_exact of the exported file would yield: one product per name, a tetra B-rep each. */
const treeOf = (names: readonly string[]): ImportedExchange => ({
  solids: names.map((name) => importedBody(fakeBrep(10, 10, [0, 0, 0]), { name })),
  census: { roots: names.length, solids: names.length, shells: names.length, openShells: 0, faces: 6 * names.length },
  skipped: [],
  products: names.map((name, index) => ({ name, assembly: false, layers: [], solids: [index] })),
  occurrences: [],
  roots: names.map((_, index) => index),
});

const modelOf = (doc: CadDocument): CompositesModel => doc.composites as CompositesModel;
const pliesOfPart = (doc: CadDocument, name: string): { part: CompositePart; plies: Ply[] } => {
  const model = modelOf(doc);
  const part = Object.values(model.parts).find((candidate) => candidate.name === name) as CompositePart;
  return {
    part,
    plies: model.plyOrder
      .map((id) => model.plies[id] as Ply)
      .filter((ply) => ply.partId === part.id)
      .sort((a, b) => a.order - b.order),
  };
};

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
    expect(data.selfCheck.findings).toHaveLength(9);
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
    expect(data.validation.findings).toHaveLength(9);
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
    const removed = step.replaceAll("'composite validation property','ply area'", "'composite validation property','other'");
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
      ['an unknown encoding', (text) => text.replace('llull-composite-1', 'llull-composite-9')],
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
