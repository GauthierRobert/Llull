/** import_step_exact over a scripted kernel: refusals with stable codes, blobs, brep leaves, units, replay (no WASM). */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import type { GeometryKernel } from '@core/geometry/kernel';
import type { ImportShapesResult } from '@core/geometry/kernelPorts';
import { blobText } from '@core/model/blobs';
import { createEmptyDocument, type CadDocument, type MeshSolidEntity } from '@core/model/types';
import { textToBase64 } from '@lib/base64';
import { CENSUS, fakeExactKernel, importedSolid } from '../helpers/fakeExactKernel';

const STEP = 'ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n';
const ctxOf = (kernel: GeometryKernel | null): ExecutionContext => ({ ...defaultContext(), kernel });
const found = (...texts: string[]): ImportShapesResult => ({
  solids: texts.map((brep) => importedSolid({ brep })),
  census: { ...CENSUS, solids: texts.length },
  skipped: [],
});
const importWith = (
  imported: ImportShapesResult | null,
  params: Record<string, unknown> = { text: STEP },
  doc: CadDocument = createEmptyDocument(),
): { result: CommandResult; fake: ReturnType<typeof fakeExactKernel> } => {
  const fake = fakeExactKernel({ imported });
  return { result: execute(doc, 'import_step_exact', params, ctxOf(fake.kernel)), fake };
};
const noChange = (result: CommandResult, doc: CadDocument): void => {
  expect(result.document).toBe(doc);
  expect(result.affected).toEqual([]);
};

describe('import_step_exact refusals', () => {
  it.each<[string, ImportShapesResult | null, string]>([
    ['unreadable', { error: 'unreadable', detail: 'bad file' }, 'KRN_STEP_UNREADABLE'],
    ['kernel gives no answer', null, 'KRN_STEP_UNREADABLE'],
    ['tessellated only', { error: 'tessellated_only', detail: 'TESSELLATED_SOLID' }, 'KRN_STEP_TESSELLATED_ONLY'],
    ['no solid', { error: 'no_solid', detail: '2 open shells' }, 'KRN_STEP_NO_SOLID'],
    [
      'a solid stays invalid',
      { ...found('a', 'b'), solids: [importedSolid(), importedSolid({ brep: 'b', validAfterHeal: false })] },
      'KRN_HEAL_FAILED',
    ],
  ])('%s -> %s, no-op', (_label, imported, code) => {
    const doc = createEmptyDocument();
    const { result } = importWith(imported, { text: STEP, fileName: 'p.step' }, doc);
    noChange(result, doc);
    expect(result.error?.code).toBe(code);
    expect(result.summary).toContain(code);
  });

  it('refuses a kernel without the exact ports (KRN_NO_EXACT_KERNEL) and a missing kernel (registry)', () => {
    const doc = createEmptyDocument();
    const mesh = fakeExactKernel({ exact: false, name: 'manifold' });
    const refused = execute(doc, 'import_step_exact', { text: STEP }, ctxOf(mesh.kernel));
    noChange(refused, doc);
    expect(refused.error?.code).toBe('KRN_NO_EXACT_KERNEL');
    const none = execute(doc, 'import_step_exact', { text: STEP }, ctxOf(null));
    expect(none.rejected).toBe(true);
    expect(none.document).toBe(doc);
  });

  it('refuses both or neither of stepBase64 / text, undecodable and empty content', () => {
    const doc = createEmptyDocument();
    const imported = found('a');
    for (const params of [{}, { text: STEP, stepBase64: textToBase64(STEP) }]) {
      const { result, fake } = importWith(imported, params, doc);
      noChange(result, doc);
      expect(result.error?.code).toBe('CMD_INVALID_PARAMS');
      expect(fake.imports).toEqual([]);
    }
    for (const params of [{ stepBase64: '!!!not base64' }, { text: '   ' }]) {
      const { result, fake } = importWith(imported, params);
      expect(result.error?.code).toBe('KRN_STEP_UNREADABLE');
      expect(fake.imports).toEqual([]);
    }
  });
});

describe('import_step_exact result', () => {
  it('stores one blob and one brep-leaf mesh entity per solid, with step-scoped ids', () => {
    const { result, fake } = importWith(found('BREP one', 'BREP two'), {
      stepBase64: textToBase64(STEP),
      name: 'bracket',
      fileName: 'b.step',
    });
    expect(result.affected).toEqual(['mesh-1.1', 'mesh-1.2']);
    expect(result.document.order).toEqual(['mesh-1.1', 'mesh-1.2']);
    const [first, second] = result.affected.map((id) => result.document.entities[id] as MeshSolidEntity);
    expect(first?.name).toBe('bracket 1');
    expect(second?.name).toBe('bracket 2');
    expect(first?.mesh.indices.length).toBeGreaterThan(0);
    const blobs = Object.values(result.document.blobs ?? {});
    expect(blobs.map((blob) => blobText(blob))).toEqual(['BREP one', 'BREP two']);
    expect(first?.brep).toEqual({ op: 'brep', blob: blobs[0]?.sha256, format: 'occt-brep-v1' });
    expect(fake.loaded).toEqual(blobs.map((blob) => blob.sha256));
    expect(fake.imports[0]).toMatchObject({ text: STEP, options: { precision: 1e-4, maxTolerance: 0.1, heal: true, sew: true } });
    expect(result.document.kernelSettings).toMatchObject({ kernel: 'occt' });
    expect(result.document.featureHistory.map((step) => step.name)).toEqual(['import_step_exact']);
    const report = (result.data as { report: { census: unknown; solids: Array<{ id: string; blob: string }>; source: unknown } }).report;
    expect(report.solids.map((solid) => solid.id)).toEqual(result.affected);
    expect(report.source).toEqual({ fileName: 'b.step' });
    expect(result.summary).toContain('2 exact solids');
  });

  it('shares one blob between identical solids and stores the original STEP on request', () => {
    const { result } = importWith(found('same', 'same'), { text: STEP, keepOriginal: true, heal: false, sew: false });
    expect(Object.values(result.document.blobs ?? {}).map((blob) => blob.mediaType)).toEqual(['model/step', 'model/x-occt-brep']);
    expect(result.affected).toHaveLength(2);
  });

  it('wraps the leaf in a scale node when the document is not in mm', () => {
    const doc = { ...createEmptyDocument(), units: 'in' as const };
    const { result } = importWith(found('b'), { text: STEP }, doc);
    const entity = result.document.entities[result.affected[0] ?? ''] as MeshSolidEntity;
    expect(entity.brep).toMatchObject({ op: 'scale', factor: 1 / 25.4, source: { op: 'brep' } });
  });

  it('reports high tolerances and tolerance growth', () => {
    const imported: ImportShapesResult = {
      ...found('a'),
      solids: [importedSolid({ brep: 'a', maxToleranceMm: 0.08, actions: ['shape_fix', 'tolerance_grown'], faceted: true })],
      skipped: ['open shell with 2 free edges'],
    };
    const { result } = importWith(imported);
    const report = (
      result.data as {
        report: {
          warnings: Array<{ code: string; entityIds: string[] }>;
          reviewRequired: { value: boolean; reasons: string[] };
          skipped: string[];
        };
      }
    ).report;
    expect(report.warnings).toEqual([expect.objectContaining({ code: 'KRN_IMPORT_TOLERANCE_HIGH', entityIds: result.affected })]);
    expect(report.reviewRequired).toEqual({ value: true, reasons: ['tolerance_growth', 'import_tolerance_high'] });
    expect(report.skipped).toEqual(['open shell with 2 free edges']);
    expect(result.summary).toContain('KRN_IMPORT_TOLERANCE_HIGH');
  });

  it('uses the document tolerances for the import options and the warning threshold', () => {
    let doc = execute(createEmptyDocument(), 'set_modeling_tolerance', { linear: 1e-3, maxImportTolerance: 0.5 }).document;
    const imported: ImportShapesResult = { ...found('a'), solids: [importedSolid({ brep: 'a', maxToleranceMm: 0.08 })] };
    const { result, fake } = importWith(imported, { text: STEP }, doc);
    expect(fake.imports[0]?.options).toMatchObject({ precision: 1e-3, maxTolerance: 0.5 });
    expect((result.data as { report: { warnings: unknown[] } }).report.warnings).toEqual([]);
    doc = result.document;
    expect(doc.kernelSettings?.modelingTolerance.linear).toBe(1e-3);
  });

  it('replays to identical ids and blobs, and is pure', () => {
    const doc = createEmptyDocument();
    const before = structuredClone(doc);
    const first = importWith(found('x', 'y')).result;
    const second = importWith(found('x', 'y')).result;
    expect(second.affected).toEqual(first.affected);
    expect(Object.keys(second.document.blobs ?? {})).toEqual(Object.keys(first.document.blobs ?? {}));
    expect(second.document.entities).toEqual(first.document.entities);
    expect(doc).toEqual(before);
    const replay = execute(first.document, 'replay_history', {}, ctxOf(fakeExactKernel({ imported: found('x', 'y') }).kernel));
    expect(replay.document.order).toEqual(first.document.order);
    expect(Object.keys(replay.document.blobs ?? {})).toEqual(Object.keys(first.document.blobs ?? {}));
  });
});
