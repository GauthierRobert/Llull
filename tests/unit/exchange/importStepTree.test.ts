/** import_step_exact with an XDE product tree, provenance and GVP check; verify_exchange_file; tree clean-up (aerospace 04 M3). */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import type { GeometryKernel } from '@core/geometry/kernel';
import type { ImportedExchange } from '@core/geometry/kernelExchange';
import { createEmptyDocument, type CadDocument, type InstanceEntity, type MeshSolidEntity } from '@core/model/types';
import { simplifyTree } from '@core/commands/exchange/importSimplify';
import { placementOf } from '@core/commands/exchange/importTree';
import { sha256Hex } from '@lib/sha256';
import { textToBase64 } from '@lib/base64';
import { fakeExactKernel } from '../../helpers/fakeExactKernel';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import {
  fakeBrep,
  fakeIgesText,
  fakeStepText,
  fakeXdeKernel,
  importedBody,
  singlePartTree,
  type XdeFakeSpec,
} from '../../helpers/fakeXdeKernel';

const ctxOf = (kernel: GeometryKernel | null): ExecutionContext => ({ ...defaultContext(), kernel });
const run = (doc: CadDocument, name: string, params: Record<string, unknown>, spec: XdeFakeSpec = {}): CommandResult =>
  execute(doc, name, params, ctxOf(fakeXdeKernel(spec).kernel));

const PART = { volume: 1000, area: 600, centroid: [5, 5, 5] as [number, number, number] };
const part = (extra: Partial<Parameters<typeof importedBody>[1]> = {}) =>
  importedBody(fakeBrep(PART.volume, PART.area, PART.centroid), { name: 'Block', color: '#3366cc', ...extra });
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
const at = (x: number): number[] => [1, 0, 0, x, 0, 1, 0, 0, 0, 0, 1, 0];
const rotZ = [0, -1, 0, 100, 1, 0, 0, 0, 0, 0, 1, 0];

/** A root assembly placing the `Part` product twice. */
function assemblyTree(matrices: readonly number[][] = [identity, rotZ]): ImportedExchange {
  return {
    solids: [part()],
    census: { roots: 1, solids: 1, shells: 1, openShells: 0, faces: 6 },
    skipped: [],
    products: [
      { name: 'Asm', assembly: true, layers: [], solids: [] },
      { name: 'Part', assembly: false, layers: [], solids: [0] },
    ],
    occurrences: matrices.map((matrix, index) => ({ parent: 0, product: 1, name: `Part ${index + 1}`, matrix })),
    roots: [0],
  };
}

const reportOf = (result: CommandResult): any => (result.data as { report: any }).report;
const stepOf = (extra: Partial<{ volume: number; area: number; centroid: [number, number, number] }> = {}, name = 'Block'): string =>
  fakeStepText([{ name, ...PART, ...extra }]);

describe('import_step_exact: flat part with embedded validation properties', () => {
  it('imports the part flat, keeps names and colours, checks the GVP (green) and records provenance', () => {
    const text = stepOf();
    const doc = createEmptyDocument();
    const result = run(doc, 'import_step_exact', { text, fileName: 'b.stp' }, { stepImport: singlePartTree('Block', [part()]) });
    expect(result.affected).toEqual(['mesh-1.1']);
    expect(Object.keys(result.document.components)).toEqual([]);
    const entity = result.document.entities['mesh-1.1'] as MeshSolidEntity;
    expect(entity).toMatchObject({ name: 'Block', color: '#3366cc' });
    const report = reportOf(result);
    expect(report.exchange.gvpCheck).toMatchObject({ band: 'green', verified: true, unit: 'mm' });
    expect(report.exchange.fileUnit).toEqual({ name: 'mm', mmPerUnit: 1 });
    expect(report.exchange.unitFactor).toBe(1);
    expect(report.exchange.products[0]).toMatchObject({ name: 'Block', band: 'green', solids: 1, entityIds: ['mesh-1.1'] });
    expect(report.exchange.policy.greenRel).toMatchObject({ value: 1e-3, unit: 'relative', defaulted: true });
    expect(report.exchange.policy.yellowCentroidMm.source).toContain('CATIA');
    expect(report.reviewRequired).toEqual({ value: false, reasons: [] });
    expect(report.warnings).toEqual([]);
    expect(result.document.exchange?.provenance['mesh-1.1']).toMatchObject({
      format: 'step',
      fileName: 'b.stp',
      sha256: sha256Hex(text),
      productName: 'Block',
      sourceUnit: 'mm',
      unverified: { value: false, reasons: [] },
      gvpCheck: { band: 'green' },
      embeddedGvp: [{ target: 'part', volume: 1000, area: 600, centroid: [5, 5, 5], placeholder: false }],
    });
    expect(result.summary).toContain('GVP check green');
    expectPure(doc, () => run(doc, 'import_step_exact', { text }, { stepImport: singlePartTree('Block', [part()]) }));
  });

  it('flags yellow and red senders without blocking, and marks red bodies unverified', () => {
    const tree = singlePartTree('Block', [part()]);
    const yellow = run(createEmptyDocument(), 'import_step_exact', { text: stepOf({ volume: 1005 }) }, { stepImport: tree });
    expect(reportOf(yellow).exchange.gvpCheck.band).toBe('yellow');
    expect(reportOf(yellow).warnings.map((w: { code: string }) => w.code)).toEqual(['XCH_GVP_YELLOW']);
    expect(reportOf(yellow).reviewRequired.reasons).toEqual(['import_gvp_yellow']);
    expect(yellow.document.exchange?.provenance['mesh-1.1']?.unverified.value).toBe(false);

    const red = run(
      createEmptyDocument(),
      'import_step_exact',
      { text: stepOf({ volume: 1500 }), sha256: 'host-hash' },
      { stepImport: tree },
    );
    expect(red.affected).toHaveLength(1);
    expect(reportOf(red).warnings[0]).toMatchObject({ code: 'XCH_GVP_RED', severity: 'fail', entityIds: ['mesh-1.1'] });
    expect(reportOf(red).reviewRequired.reasons).toContain('import_gvp_red');
    expect(red.document.exchange?.provenance['mesh-1.1']).toMatchObject({
      sha256: 'host-hash',
      unverified: { value: true, reasons: ['import_gvp_red'] },
    });
    expect(red.summary).toContain('XCH_GVP_RED');
  });

  it('reports a placeholder or missing sender GVP as not checkable (unverified) and honours gvpPolicy and verify: false', () => {
    const tree = singlePartTree('Block', [part()]);
    const zero = run(
      createEmptyDocument(),
      'import_step_exact',
      { text: stepOf({ volume: 0, area: 0, centroid: [0, 0, 0] }) },
      { stepImport: tree },
    );
    expect(reportOf(zero).warnings[0]).toMatchObject({ code: 'XCH_GVP_NOT_CHECKABLE' });
    expect(zero.document.exchange?.provenance['mesh-1.1']?.unverified).toEqual({ value: true, reasons: ['import_gvp_not_checkable'] });
    const none = run(
      createEmptyDocument(),
      'import_step_exact',
      { text: fakeStepText([{ name: 'Block', ...PART }], { withProperties: false }) },
      { stepImport: tree },
    );
    expect(reportOf(none).exchange.gvpCheck.band).toBe('not-checkable');
    const tolerant = run(
      createEmptyDocument(),
      'import_step_exact',
      { text: stepOf({ volume: 1005 }), gvpPolicy: { greenRel: 1e-2 } },
      { stepImport: tree },
    );
    expect(reportOf(tolerant).exchange.gvpCheck.band).toBe('green');
    const skipped = run(
      createEmptyDocument(),
      'import_step_exact',
      { text: stepOf({ volume: 1500 }), verify: false },
      { stepImport: tree },
    );
    expect(reportOf(skipped).exchange.gvpCheck).toMatchObject({ band: 'not-checkable', verified: false });
    expect(skipped.document.exchange?.provenance['mesh-1.1']?.unverified).toEqual({ value: true, reasons: ['verify_skipped'] });
    expect(skipped.summary).toContain('GVP check skipped');
    const noMass = run(createEmptyDocument(), 'import_step_exact', { text: stepOf() }, { stepImport: tree, noMass: true });
    expect(reportOf(noMass).exchange.gvpCheck.band).toBe('not-checkable');
  });

  it('converts an inch file exactly: values compared in millimetres, unit factor 25.4 reported', () => {
    const inches = fakeStepText(
      [{ name: 'Block', volume: 1000 / 25.4 ** 3, area: 600 / 25.4 ** 2, centroid: [5 / 25.4, 5 / 25.4, 5 / 25.4] }],
      { unit: 'inch' },
    );
    const doc = { ...createEmptyDocument(), units: 'in' as const };
    const result = run(doc, 'import_step_exact', { text: inches }, { stepImport: singlePartTree('Block', [part()]) });
    expect(reportOf(result).exchange.unitFactor).toBe(25.4);
    expect(reportOf(result).exchange.gvpCheck.band).toBe('green');
    const record = result.document.exchange?.provenance['mesh-1.1'];
    expect(record?.sourceUnit).toBe('in');
    expect(record?.embeddedGvp?.[0]?.volume).toBeCloseTo(1000 / 25.4 ** 3, 12);
    expect(result.document.entities['mesh-1.1']).toMatchObject({ brep: { op: 'scale', factor: 1 / 25.4 } });
  });
});

describe('import_step_exact: assembly structure', () => {
  it('turns products into components and occurrences into instances; a part used twice is one component', () => {
    const result = run(createEmptyDocument(), 'import_step_exact', { text: stepOf({}, 'Part') }, { stepImport: assemblyTree() });
    const components = Object.values(result.document.components);
    expect(components.map((component) => component.name).sort()).toEqual(['Asm', 'Part']);
    expect(components.every((component) => component.id.startsWith('comp-stp-1.'))).toBe(true);
    const top = result.affected.map((id) => result.document.entities[id] as InstanceEntity);
    expect(top).toHaveLength(1);
    expect(top[0]).toMatchObject({ kind: 'instance', name: 'Asm', position: [0, 0, 0] });
    const asm = components.find((component) => component.name === 'Asm');
    const uses = Object.values(asm?.entities ?? {}) as InstanceEntity[];
    expect(uses.map((use) => use.name)).toEqual(['Part 1', 'Part 2']);
    expect(new Set(uses.map((use) => use.componentId)).size).toBe(1);
    expect(uses[1]?.position).toEqual([100, 0, 0]);
    expect(uses[1]?.rotation[2]).toBeCloseTo(Math.PI / 2, 9);
    const partComponent = components.find((component) => component.name === 'Part');
    expect(Object.values(partComponent?.entities ?? {})[0]).toMatchObject({ kind: 'mesh', name: 'Block' });
    expect(reportOf(result).exchange.products.map((product: { name: string; band: string }) => [product.name, product.band])).toEqual([
      ['Asm', 'not-checkable'],
      ['Part', 'green'],
    ]);
    expect(result.document.exchange?.provenance[Object.keys(result.document.components)[0] ?? '']).toBeDefined();
    expect(result.summary).toContain('Product tree: 2 products, 2 components, 2 occurrences');
  });

  it('converts placements to the document unit, keeps a mirrored occurrence unrotated and names it as skipped', () => {
    const mirrored = [-1, 0, 0, 7, 0, 1, 0, 0, 0, 0, 1, 0];
    const doc = { ...createEmptyDocument(), units: 'in' as const };
    const result = run(doc, 'import_step_exact', { text: stepOf({}, 'Part') }, { stepImport: assemblyTree([at(25.4), mirrored]) });
    const asm = Object.values(result.document.components).find((component) => component.name === 'Asm');
    const [first, second] = Object.values(asm?.entities ?? {}) as InstanceEntity[];
    expect(first?.position).toEqual([1, 0, 0]);
    expect(second?.rotation).toEqual([0, 0, 0]);
    expect(reportOf(result).skipped).toEqual(["occurrence 'Part 2' is mirrored or scaled: placed without rotation"]);
    expect(placementOf(mirrored, 1).rigid).toBe(false);
    expect(placementOf(identity, 1)).toEqual({ position: [0, 0, 0], rotation: [0, 0, 0], rigid: true });
  });

  it('flattens to world-space solids with assembly: false, and falls back to the flat reader when the tree reader has no answer', () => {
    const flat = { solids: [part()], census: { roots: 1, solids: 1, shells: 1, openShells: 0, faces: 6 }, skipped: [] };
    const result = run(
      createEmptyDocument(),
      'import_step_exact',
      { text: stepOf(), assembly: false, name: 'Imported' },
      { stepImport: assemblyTree(), flatImport: flat },
    );
    expect(result.affected).toEqual(['mesh-1.1']);
    expect(result.document.entities['mesh-1.1']).toMatchObject({ name: 'Imported' });
    expect(reportOf(result).exchange).toBeUndefined();
    expect(result.document.exchange).toBeUndefined();
    const fallback = run(createEmptyDocument(), 'import_step_exact', { text: stepOf() }, { stepImport: null, flatImport: flat });
    expect(fallback.affected).toHaveLength(1);
    expect(reportOf(fallback).warnings).toEqual([]);
    const several = run(
      createEmptyDocument(),
      'import_step_exact',
      { text: stepOf(), name: 'Part', assembly: false },
      { flatImport: { ...flat, solids: [part(), part()] } },
    );
    expect(several.affected.map((id) => several.document.entities[id]?.name)).toEqual(['Part 1', 'Part 2']);
  });

  it('keeps several free parts flat and drops empty products', () => {
    const tree: ImportedExchange = {
      solids: [part(), part({ name: 'Second' })],
      census: { roots: 2, solids: 2, shells: 2, openShells: 0, faces: 12 },
      skipped: [],
      products: [
        { name: 'First', assembly: false, layers: [], solids: [0] },
        { name: 'Second', assembly: false, layers: [], solids: [1] },
        { name: 'PMI only', assembly: false, layers: [], solids: [] },
      ],
      occurrences: [],
      roots: [0, 1, 2],
    };
    const result = run(createEmptyDocument(), 'import_step_exact', { text: stepOf() }, { stepImport: tree });
    expect(result.affected).toEqual(['mesh-1.1', 'mesh-1.2']);
    expect(Object.keys(result.document.components)).toEqual([]);
  });
});

describe('import_step_exact: refusals of the tree reader', () => {
  it.each([
    ['unreadable', 'KRN_STEP_UNREADABLE'],
    ['tessellated_only', 'KRN_STEP_TESSELLATED_ONLY'],
    ['no_solid', 'KRN_STEP_NO_SOLID'],
    ['unavailable', 'KRN_NO_EXACT_KERNEL'],
  ] as const)('%s -> %s, no-op', (error, code) => {
    const doc = createEmptyDocument();
    const result = run(doc, 'import_step_exact', { text: stepOf() }, { stepImport: { error, detail: 'why' } });
    expectNoOp(result, doc);
    expect(result.error?.code).toBe(code);
  });

  it('refuses when neither reader answers', () => {
    const doc = createEmptyDocument();
    expect(run(doc, 'import_step_exact', { text: stepOf() }, { stepImport: null }).error?.code).toBe('KRN_STEP_UNREADABLE');
    const mesh = execute(doc, 'import_step_exact', { text: stepOf() }, ctxOf(fakeExactKernel({ exact: false }).kernel));
    expect(mesh.error?.code).toBe('KRN_NO_EXACT_KERNEL');
  });
});

describe('simplifyTree', () => {
  const tree = (
    products: ImportedExchange['products'],
    occurrences: ImportedExchange['occurrences'],
    roots: number[],
  ): ImportedExchange => ({
    solids: [part(), part()],
    census: { roots: 1, solids: 2, shells: 2, openShells: 0, faces: 12 },
    skipped: [],
    products,
    occurrences,
    roots,
  });
  const use = (parent: number, product: number, matrix: readonly number[] = identity) => ({
    parent,
    product,
    name: `u${parent}${product}`,
    matrix,
  });

  it('folds a single-child identity wrapper into its child, keeping the outer name and every alias', () => {
    const simplified = simplifyTree(
      tree(
        [
          { name: 'Outer', assembly: true, layers: ['A'], solids: [] },
          { name: 'SOLID', assembly: false, color: '#112233', layers: ['B'], solids: [0] },
          { name: 'COMPOUND', assembly: false, layers: [], solids: [] },
        ],
        [use(0, 1), use(0, 2)],
        [0],
      ),
    );
    expect(simplified.products).toHaveLength(1);
    expect(simplified.products[0]).toMatchObject({
      name: 'Outer',
      assembly: false,
      solids: [0],
      color: '#112233',
      layers: ['A', 'B'],
      aliases: ['Outer', 'SOLID'],
    });
    expect(simplified.occurrences).toEqual([]);
    expect(simplified.roots).toEqual([0]);
  });

  it('keeps real structure: placed children, shared children and non-identity wrappers', () => {
    const real = simplifyTree(
      tree(
        [
          { name: 'Asm', assembly: true, layers: [], solids: [] },
          { name: 'Part', assembly: false, layers: [], solids: [0] },
        ],
        [use(0, 1, at(10)), use(0, 1, at(20))],
        [0],
      ),
    );
    expect(real.products).toHaveLength(2);
    expect(real.occurrences).toHaveLength(2);
    const shifted = simplifyTree(
      tree(
        [
          { name: 'Wrapper', assembly: true, layers: [], solids: [] },
          { name: 'Part', assembly: false, layers: [], solids: [0] },
        ],
        [use(0, 1, at(10))],
        [0],
      ),
    );
    expect(shifted.products).toHaveLength(2);
    const shared = simplifyTree(
      tree(
        [
          { name: 'A', assembly: true, layers: [], solids: [] },
          { name: 'B', assembly: true, layers: [], solids: [] },
          { name: 'Part', assembly: false, layers: [], solids: [0] },
        ],
        [use(0, 2), use(1, 2), use(1, 2, at(5))],
        [0, 1],
      ),
    );
    expect(shared.products.map((product) => product.name)).toEqual(['A', 'B', 'Part']);
  });

  it('survives a reference cycle and an empty tree', () => {
    const cyclic = simplifyTree(
      tree(
        [
          { name: 'A', assembly: true, layers: [], solids: [] },
          { name: 'B', assembly: true, layers: [], solids: [] },
        ],
        [use(0, 1), use(1, 0)],
        [0],
      ),
    );
    expect(cyclic.roots).toEqual([]);
    expect(simplifyTree(tree([], [], [])).products).toEqual([]);
  });
});

describe('verify_exchange_file', () => {
  const verify = (
    params: Record<string, unknown>,
    spec?: XdeFakeSpec,
    kernel: GeometryKernel | null | undefined = undefined,
  ): CommandResult =>
    execute(createEmptyDocument(), 'verify_exchange_file', params, ctxOf(kernel === undefined ? fakeXdeKernel(spec).kernel : kernel));

  it('reports the file claims without a kernel: schema, unit factor, census, embedded GVP, not-checkable', () => {
    const result = verify({ text: stepOf(), fileName: 'f.stp' }, undefined, null);
    const data = result.data as any;
    expect(data).toMatchObject({ format: 'step', fileName: 'f.stp', unitFactor: 1, band: 'not-checkable', products: ['Block'] });
    expect(data.schemaName).toContain('AP242');
    expect(data.embeddedGvp[0]).toMatchObject({
      product: 'Block',
      volumeMm3: 1000,
      areaMm2: 600,
      centroidMm: [5, 5, 5],
      placeholder: false,
    });
    expect(data.unverified).toEqual({ value: true, reasons: ['verify_skipped'] });
    expect(data.reviewRequired.value).toBe(true);
    expect(data.issues).toEqual([]);
    expect(result.summary).toContain('not compared (no exact kernel)');
    expect(result.document).toBeDefined();
  });

  it('compares with the recomputed geometry through the kernel: green, yellow and red with issues', () => {
    const spec = { stepImport: singlePartTree('Block', [part()]) };
    const green = verify({ text: stepOf() }, spec).data as any;
    expect(green).toMatchObject({
      band: 'green',
      unverified: { value: false, reasons: [] },
      reviewRequired: { value: false, reasons: [] },
    });
    expect(green.recomputed[0]).toMatchObject({ product: 'Block', band: 'green' });
    const yellow = verify({ text: stepOf({ volume: 1005 }) }, spec).data as any;
    expect(yellow.band).toBe('yellow');
    expect(yellow.issues[0]).toMatchObject({ code: 'XCH_GVP_YELLOW', severity: 'warn', productKey: 'Block' });
    const red = verify({ text: stepOf({ volume: 1500 }), gvpPolicy: { yellowRel: 0.2 } }, spec).data as any;
    expect(red).toMatchObject({ band: 'red', unverified: { value: true, reasons: ['import_gvp_red'] } });
    expect(red.issues[0]).toMatchObject({ code: 'XCH_GVP_RED', severity: 'fail' });
    expect(red.reviewRequired.reasons).toEqual(['gvp_red']);
  });

  it('lists placeholder properties, unknown schemas and units, and kernel refusals as issues', () => {
    const placeholder = verify({ text: stepOf({ volume: 0, area: 0, centroid: [0, 0, 0] }) }, undefined, null).data as any;
    expect(placeholder.issues.map((issue: { code: string }) => issue.code)).toEqual(['XCH_GVP_NOT_CHECKABLE']);
    const odd = fakeStepText([{ name: 'Block', ...PART }], { schema: 'SOMETHING_ELSE' }).replace(/^.*LENGTH_UNIT.*\n/gm, '');
    expect((verify({ text: odd }, undefined, null).data as any).issues.map((issue: { code: string }) => issue.code)).toEqual([
      'XCH_SCHEMA_UNKNOWN',
      'XCH_UNIT_UNKNOWN',
    ]);
    const refused = verify({ text: stepOf() }, { stepImport: { error: 'unreadable', detail: 'bad' } }).data as any;
    expect(refused.issues[0]).toMatchObject({ code: 'KRN_STEP_UNREADABLE', severity: 'fail' });
    expect((verify({ text: stepOf() }, { stepImport: null }).data as any).issues[0].message).toContain('could not read');
    expect((verify({ text: stepOf() }, { noImporter: true }).data as any).band).toBe('not-checkable');
    expect((verify({ text: stepOf() }, { stepImport: singlePartTree('Block', [part()]), noMass: true }).data as any).band).toBe(
      'not-checkable',
    );
  });

  it('reads an IGES file: unit, census and untranslated types', () => {
    const iges = fakeIgesText([186, 514, 510, 214, 406], { unitFlag: 1 });
    const result = verify({ text: iges });
    expect(result.data).toMatchObject({ format: 'iges', unitFactor: 25.4, entities: 5, geometricEntities: 3, band: 'not-checkable' });
    expect((result.data as any).issues.map((issue: { code: string }) => issue.code)).toEqual(['XCH_IGES_UNTRANSLATED']);
    expect((result.data as any).reviewRequired).toEqual({ value: true, reasons: ['untranslated_entities'] });
    const unknownUnit = verify({ text: fakeIgesText([110], { unitFlag: 99 }), format: 'iges' }).data as any;
    expect(unknownUnit.issues.map((issue: { code: string }) => issue.code)).toContain('XCH_UNIT_UNKNOWN');
    expect(unknownUnit.reviewRequired.value).toBe(false);
  });

  it('refuses unreadable input with a code and leaves the document alone', () => {
    const doc = createEmptyDocument();
    const refuse = (params: Record<string, unknown>, code: string): void => {
      const result = execute(doc, 'verify_exchange_file', params, ctxOf(null));
      expectNoOp(result, doc);
      expect(result.error?.code, JSON.stringify(params)).toBe(code);
    };
    refuse({}, 'CMD_INVALID_PARAMS');
    refuse({ text: 'a', stepBase64: 'YQ==' }, 'CMD_INVALID_PARAMS');
    refuse({ text: '   ' }, 'KRN_STEP_UNREADABLE');
    refuse({ stepBase64: '!!!' }, 'KRN_STEP_UNREADABLE');
    refuse({ text: 'not a model at all' }, 'KRN_STEP_UNREADABLE');
    refuse({ text: fakeIgesText([186]).slice(0, 250), format: 'iges' }, 'KRN_STEP_UNREADABLE');
    const viaBase64 = execute(doc, 'verify_exchange_file', { stepBase64: textToBase64(stepOf()) }, ctxOf(null));
    expect((viaBase64.data as any).products).toEqual(['Block']);
  });
});
