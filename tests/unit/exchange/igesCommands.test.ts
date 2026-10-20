/** import_iges / export_iges over a scripted XDE kernel (aerospace 04 M4): sewing options, census, provenance, self-check, refusals. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import type { GeometryKernel } from '@core/geometry/kernel';
import type { ImportedIges } from '@core/geometry/kernelExchange';
import { createEmptyDocument, type CadDocument, type MeshSolidEntity } from '@core/model/types';
import { textToBase64 } from '@lib/base64';
import { fakeExactKernel } from '../../helpers/fakeExactKernel';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { fakeBrep, fakeIgesText, fakeXdeKernel, importedBody, type XdeFakeSpec } from '../../helpers/fakeXdeKernel';

const ctxOf = (kernel: GeometryKernel | null): ExecutionContext => ({ ...defaultContext(), kernel });
const IGES = fakeIgesText([186, 514, 510, 214, 406], { unitFlag: 1, resolution: 0.001 });
const body = (volume = 6000, area = 2200) => importedBody(fakeBrep(volume, area, [0, 0, 0]), { name: 'Block' });
const read = (extra: Partial<ImportedIges> = {}): ImportedIges => ({
  solids: [body()],
  census: { roots: 3, solids: 0, shells: 1, openShells: 0, faces: 6 },
  skipped: [],
  sewingToleranceMm: 0.0254,
  diagonalMm: 40,
  ...extra,
});
const run = (doc: CadDocument, name: string, params: Record<string, unknown>, spec: XdeFakeSpec = {}) => {
  const fake = fakeXdeKernel(spec);
  return { result: execute(doc, name, params, ctxOf(fake.kernel)), fake };
};
const data = (result: CommandResult): any => result.data;

describe('import_iges', () => {
  it('imports sewn solids, converts the file resolution, records census, warnings and unverified provenance', () => {
    const doc = createEmptyDocument();
    const imported = read({
      census: { roots: 3, solids: 0, shells: 2, openShells: 1, faces: 9 },
      skipped: ['open shell with 2 free edges after sewing at 0.254 mm'],
    });
    const { result, fake } = run(doc, 'import_iges', { text: IGES, fileName: 'p.igs', name: 'Plate' }, { igesImport: imported });
    expect(result.affected).toEqual(['mesh-1.1']);
    expect(result.document.entities['mesh-1.1']).toMatchObject({ name: 'Plate' });
    expect(fake.imports[0]).toMatchObject({
      format: 'iges',
      options: { sew: true, heal: true, precision: 1e-4, fileResolutionMm: 0.001 * 25.4 },
    });
    const d = data(result);
    expect(d.iges).toMatchObject({
      unitFactor: 25.4,
      entities: 5,
      geometricEntities: 3,
      openShells: 1,
      sewingToleranceMm: 0.0254,
      diagonalMm: 40,
    });
    expect(d.iges.untranslated).toEqual({ '214 leader (arrow)': 1, '406 property': 1 });
    expect(d.iges.policy.sewingTolerance).toMatchObject({ value: 0.0254, unit: 'mm', defaulted: true });
    expect(d.report.warnings.map((warning: { code: string }) => warning.code)).toEqual(['XCH_IGES_OPEN_SHELL', 'XCH_IGES_UNTRANSLATED']);
    expect(d.report.reviewRequired).toEqual({ value: true, reasons: ['iges_no_validation_properties'] });
    expect(d.report.solids[0]).toMatchObject({ id: 'mesh-1.1', validAfterHeal: true });
    expect(result.document.exchange?.provenance['mesh-1.1']).toMatchObject({
      format: 'iges',
      fileName: 'p.igs',
      sourceUnit: 'in',
      unverified: { value: true, reasons: ['import_gvp_not_checkable'] },
    });
    expect(result.summary).toContain('1 exact solid');
    expect(result.summary).toContain('XCH_IGES_OPEN_SHELL');
    expect(Object.keys(result.document.blobs ?? {})).toHaveLength(1);
    expectPure(doc, () => run(doc, 'import_iges', { text: IGES }, { igesImport: imported }));
  });

  it('passes sew / heal through, accepts base64 and names the file unit in the provenance', () => {
    const { result, fake } = run(
      createEmptyDocument(),
      'import_iges',
      { igesBase64: textToBase64(fakeIgesText([186], { unitFlag: 10 })), sew: false, heal: false, sha256: 'host' },
      { igesImport: read() },
    );
    expect(fake.imports[0]?.options).toMatchObject({ sew: false, heal: false });
    expect(result.document.exchange?.provenance['mesh-1.1']).toMatchObject({ sha256: 'host', sourceUnit: 'cm' });
    const odd = run(createEmptyDocument(), 'import_iges', { text: fakeIgesText([186], { unitFlag: 99 }) }, { igesImport: read() }).result;
    expect(odd.document.exchange?.provenance['mesh-1.1']?.sourceUnit).toBe('unknown');
    const feet = run(createEmptyDocument(), 'import_iges', { text: fakeIgesText([186], { unitFlag: 4 }) }, { igesImport: read() }).result;
    expect(feet.document.exchange?.provenance['mesh-1.1']?.sourceUnit).toBe('ft');
    const metres = run(createEmptyDocument(), 'import_iges', { text: fakeIgesText([186], { unitFlag: 6 }) }, { igesImport: read() }).result;
    expect(metres.document.exchange?.provenance['mesh-1.1']?.sourceUnit).toBe('m');
  });

  it('scales the healed solid from millimetres into the document unit', () => {
    const doc = { ...createEmptyDocument(), units: 'in' as const };
    const { result } = run(doc, 'import_iges', { text: IGES }, { igesImport: read() });
    expect((result.document.entities['mesh-1.1'] as MeshSolidEntity).brep).toMatchObject({ op: 'scale', factor: 1 / 25.4 });
  });

  it('refuses unreadable input and every refusal of the kernel, leaving the document alone', () => {
    const doc = createEmptyDocument();
    const refuse = (params: Record<string, unknown>, spec: XdeFakeSpec, code: string): void => {
      const { result } = run(doc, 'import_iges', params, spec);
      expectNoOp(result, doc);
      expect(result.error?.code, JSON.stringify(params)).toBe(code);
    };
    refuse({}, { igesImport: read() }, 'CMD_INVALID_PARAMS');
    refuse({ text: IGES, igesBase64: 'YQ==' }, { igesImport: read() }, 'CMD_INVALID_PARAMS');
    refuse({ text: '  ' }, { igesImport: read() }, 'KRN_STEP_UNREADABLE');
    refuse({ igesBase64: '!!' }, { igesImport: read() }, 'KRN_STEP_UNREADABLE');
    refuse({ text: 'x'.repeat(100) }, { igesImport: read() }, 'KRN_STEP_UNREADABLE');
    refuse({ text: IGES }, { igesImport: null }, 'KRN_STEP_UNREADABLE');
    refuse({ text: IGES }, { igesImport: { error: 'unreadable', detail: 'd' } }, 'KRN_STEP_UNREADABLE');
    refuse({ text: IGES }, { igesImport: { error: 'no_solid', detail: 'd' } }, 'KRN_STEP_NO_SOLID');
    refuse({ text: IGES }, { igesImport: { error: 'unavailable', detail: 'd' } }, 'XCH_WRITER_UNAVAILABLE');
    refuse({ text: IGES }, { igesImport: { error: 'tessellated_only', detail: 'd' } }, 'KRN_STEP_UNREADABLE');
    refuse(
      { text: IGES },
      { igesImport: { solids: [], census: read().census, skipped: [], products: [], occurrences: [], roots: [] } },
      'KRN_STEP_UNREADABLE',
    );
    refuse(
      { text: IGES },
      { igesImport: read({ solids: [importedBody(fakeBrep(1, 1, [0, 0, 0]), { validAfterHeal: false })] }) },
      'KRN_HEAL_FAILED',
    );
    refuse({ text: IGES }, { noImporter: true }, 'KRN_NO_EXACT_KERNEL');
    const mesh = execute(doc, 'import_iges', { text: IGES }, ctxOf(fakeExactKernel({ exact: false }).kernel));
    expect(mesh.error?.code).toBe('KRN_NO_EXACT_KERNEL');
    expect(execute(doc, 'import_iges', { text: IGES }, ctxOf(null)).rejected).toBe(true);
  });
});

describe('export_iges', () => {
  const doc = (): CadDocument => {
    let d = createEmptyDocument();
    d = execute(d, 'add_box', { size: [10, 20, 30] }).document;
    return execute(d, 'set_entity_name', { id: d.order[0] as string, name: 'Plate' }).document;
  };

  it('writes IGES for the exact solids, reads it back and reports a green self-check', () => {
    const model = doc();
    const { result, fake } = run(model, 'export_iges', {}, { igesImport: read() });
    expect(fake.requests[0]).toMatchObject({
      format: 'iges',
      unit: 'mm',
      occurrences: [],
      igesMode: 'brep',
      header: { fileName: 'llull.igs' },
    });
    expect(fake.imports[0]).toMatchObject({ format: 'iges' });
    const d = data(result);
    expect(d).toMatchObject({ format: 'iges', mode: 'brep', unit: 'mm', solidCount: 1, entityIds: model.order, entities: 5 });
    expect(d.selfCheck).toMatchObject({
      band: 'green',
      volume: { model: 6000, file: 6000 },
      area: { model: 2200, file: 2200 },
      solids: { model: 1, file: 1 },
    });
    expect(d.iges).toContain('fake start');
    expect(result.summary).toContain('IGES 5.3 brep');
    expect(result.document).toBe(model);
    expectPure(model, () => run(model, 'export_iges', {}, { igesImport: read() }));
  });

  it('skips the read-back in faces mode and when the kernel cannot re-read', () => {
    expect(data(run(doc(), 'export_iges', { mode: 'faces' }, { igesImport: read() }).result).selfCheck).toEqual({ band: 'green' });
    expect(data(run(doc(), 'export_iges', {}, { noImporter: true }).result).selfCheck).toEqual({ band: 'green' });
  });

  it('refuses a file that disagrees with the model after re-reading, and a re-read that fails', () => {
    const model = doc();
    const wrong = run(model, 'export_iges', {}, { igesImport: read({ solids: [body(5999, 2200)] }) }).result;
    expect(wrong.error?.code).toBe('XCH_SELFCHECK_RED');
    expect(wrong.summary).toContain('"band":"red"');
    expect(wrong.data).toBeUndefined();
    expect(run(model, 'export_iges', {}, { igesImport: { error: 'unreadable', detail: 'x' } }).result.error?.code).toBe(
      'XCH_SELFCHECK_RED',
    );
    expect(run(model, 'export_iges', {}, { igesImport: null }).result.error?.code).toBe('XCH_SELFCHECK_RED');
  });

  it('refuses without a kernel, without a writer, with nothing to write and when the kernel cannot write', () => {
    const model = doc();
    expect(execute(model, 'export_iges', {}, ctxOf(null)).rejected).toBe(true);
    expect(run(model, 'export_iges', {}, { noWriter: true }).result.error?.code).toBe('XCH_WRITER_UNAVAILABLE');
    expect(run(createEmptyDocument(), 'export_iges', {}).result.error?.code).toBe('XCH_NO_SOLIDS');
    const written = run(model, 'export_iges', {}, { writeIges: () => null }).result;
    expect(written.error?.code).toBe('XCH_WRITER_UNAVAILABLE');
    expectNoOp(written, model);
    const unbuildable = fakeXdeKernel().kernel;
    const refusing = { ...unbuildable, evaluate: () => null } as GeometryKernel;
    expect(execute(model, 'export_iges', {}, ctxOf(refusing)).error?.code).toBe('XCH_NO_SOLIDS');
  });
});
