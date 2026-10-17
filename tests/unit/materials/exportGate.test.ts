import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { exportDocumentHash, exportGate } from '@core/model/exportGate';
import type { ExecutionContext } from '@core/commands/types';
import type { GeometryKernel } from '@core/geometry/kernel';
import type { HumanSignaturePort } from '@core/model/analysis';
import { exportStepFile } from '@mcp/exchangeTools';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';
import type { CadDocument } from '@core/model/types';
import { boxOf, call, dataOf, hashOf, libraryFile, mmDocument, providerOf, step, ctxWith } from './support';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { parseMaterialLibrary } from '@core/commands/materials/libraryFormat';
import type { MaterialLibrary } from '@core/model/materialLibrary';

const record = (id: string, marking: Record<string, unknown>): Record<string, unknown> => ({
  id,
  designation: 'X',
  specs: [],
  licence: 'company-proprietary',
  exportMarking: marking,
});

/** A box whose material record carries `marking`. */
function markedBox(marking: Record<string, unknown>, id = 'secret'): { doc: CadDocument; id: string } {
  return boxOf(step(mmDocument(), 'define_material_record', record(id, marking)), id);
}

const fakeKernel = {} as unknown as GeometryKernel;
const contextWith = (humanSignature: HumanSignaturePort | null): ExecutionContext => ({
  ...defaultContext(),
  kernel: fakeKernel,
  humanSignature,
});
const NO_PORT = contextWith(null);

const EXPORTS: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
  ['export_stl', {}],
  ['export_obj', {}],
  ['export_gltf', {}],
  ['export_code', { language: 'cadquery' }],
  ['export_step_exact', {}],
];

describe('exportGate', () => {
  it('is open for a document without marked records, EAR99 and none included', () => {
    expect(exportGate(mmDocument(), 'step')).toEqual({ controlled: false });
    for (const regime of ['none', 'EAR99']) expect(exportGate(markedBox({ regime }).doc, 'step')).toEqual({ controlled: false });
  });

  it('names the marked records in use and the strictest marking', () => {
    const itar = markedBox({ regime: 'ITAR', category: 'XIII(g)' });
    expect(exportGate(itar.doc, 'stl')).toMatchObject({ controlled: true, marking: { regime: 'ITAR' }, ids: ['secret'] });
    const ear = markedBox({ regime: 'EAR', eccn: '1C002' });
    expect(exportGate(ear.doc, 'gltf')).toMatchObject({ controlled: true, marking: { regime: 'EAR', eccn: '1C002' } });
  });

  it('ignores a marked record no entity uses', () => {
    const doc = step(mmDocument(), 'define_material_record', record('unused', { regime: 'ITAR' }));
    expect(exportGate(doc, 'step')).toEqual({ controlled: false });
  });

  it('gates on the marking of the library of a record in use, with the library id', () => {
    const file = libraryFile({ marking: { regime: 'none' } });
    const marked = { ...file, exportMarking: { regime: 'EAR', eccn: '9E003' } };
    const imported = step(mmDocument(), 'import_material_library', { library: marked });
    const { doc } = boxOf(imported, 'aa7075_t6');
    expect(exportGate(doc, 'save')).toMatchObject({
      controlled: true,
      ids: ['synthetic-lib'],
      items: [{ kind: 'library', id: 'synthetic-lib' }],
    });
  });
});

describe('VC-MAT-15 / VC-MAT-25: exports of controlled content', () => {
  it.each(EXPORTS)('%s refuses an ITAR-marked document and returns nothing', (name, params) => {
    const { doc } = markedBox({ regime: 'ITAR' });
    const result = call(doc, name, params, NO_PORT);
    expect(result.rejected).toBe(true);
    expect(result.error).toMatchObject({ code: 'MAT_EXPORT_CONTROLLED', ids: ['secret'], paths: ['document'] });
    expect(result.error?.remediation).toContain('export-control officer');
    expect(result.data).toBeUndefined();
    expect(result.document).toBe(doc);
  });

  it.each(EXPORTS)('%s: confirmExportControlled=true from an agent is MAT_HUMAN_GATE', (name, params) => {
    const { doc } = markedBox({ regime: 'ITAR' });
    const result = call(doc, name, { ...params, confirmExportControlled: true }, NO_PORT);
    expect(result.error).toMatchObject({ code: 'MAT_HUMAN_GATE', ids: ['secret'], paths: ['confirmExportControlled'] });
    expect(result.data).toBeUndefined();
  });

  it('a bare true is refused even when a signing port is installed', () => {
    const port: HumanSignaturePort = { verify: () => ({ signer: 'alice', signatureId: 's1' }) };
    const { doc } = markedBox({ regime: 'ITAR' });
    expect(call(doc, 'export_stl', { confirmExportControlled: true }, contextWith(port)).error?.code).toBe('MAT_HUMAN_GATE');
  });

  it('a signature without a port, or one that does not verify, is MAT_HUMAN_GATE', () => {
    const { doc } = markedBox({ regime: 'ITAR' });
    const signature = { signature: 'x', nonce: 'n1' };
    const none = call(doc, 'export_stl', { confirmExportControlled: signature }, NO_PORT);
    expect(none.error?.code).toBe('MAT_HUMAN_GATE');
    expect(none.summary).toContain('no signing port');
    const rejecting = call(doc, 'export_stl', { confirmExportControlled: signature }, contextWith({ verify: () => null }));
    expect(rejecting.summary).toContain('did not verify');
  });

  it('a signature verified over the act and the marked ids lets the export through', () => {
    const { doc } = markedBox({ regime: 'ITAR' });
    const seen: string[] = [];
    const port: HumanSignaturePort = {
      verify: (_signature, payloadSha256) => {
        seen.push(payloadSha256);
        return { signer: 'alice', signatureId: 's1' };
      },
    };
    const result = call(doc, 'export_stl', { confirmExportControlled: { signature: 'x', nonce: 'n1' } }, contextWith(port));
    expect(result.rejected).toBeUndefined();
    expect(dataOf(result)['format']).toBe('ascii');
    const details = { command: 'export_stl', documentHash: exportDocumentHash(doc) };
    expect(seen).toEqual([sha256Hex(canonicalJson({ act: 'export of ITAR-controlled content', ids: ['secret'], details, nonce: 'n1' }))]);
  });

  it('a confirmation without a nonce is MAT_HUMAN_GATE; the signed payload changes with the document', () => {
    const { doc } = markedBox({ regime: 'ITAR' });
    const hashes: string[] = [];
    const port: HumanSignaturePort = {
      verify: (_signature, payload) => {
        hashes.push(payload);
        return { signer: 'alice', signatureId: 's1' };
      },
    };
    const noNonce = call(doc, 'export_stl', { confirmExportControlled: { signature: 'x' } }, contextWith(port));
    expect(noNonce.error?.code).toBe('MAT_HUMAN_GATE');
    expect(noNonce.summary).toContain('nonce');
    expect(hashes).toEqual([]);
    const other = step(doc, 'add_box', { size: [1, 2, 3] });
    call(doc, 'export_stl', { confirmExportControlled: { nonce: 'n1' } }, contextWith(port));
    call(other, 'export_stl', { confirmExportControlled: { nonce: 'n1' } }, contextWith(port));
    expect(new Set(hashes).size).toBe(2);
  });

  it('an unmarked document exports as before (VC-MAT-15 core part)', () => {
    const { doc } = markedBox({ regime: 'EAR99' });
    for (const [name, params] of EXPORTS.filter(([exportName]) => exportName !== 'export_step_exact')) {
      const result = call(doc, name, params, NO_PORT);
      expect(result.rejected, name).toBeUndefined();
      expect(result.data, name).toBeDefined();
    }
    expect(call(mmDocument(), 'export_stl', {}).rejected).toBeUndefined();
  });

  it('a private library keeps its marking through save and load, so the stub still gates', () => {
    const file = libraryFile({ id: 'mmpds', storage: 'private', licence: 'licensed-no-redistribution', marking: { regime: 'ITAR' } });
    const library = parseMaterialLibrary(file) as { ok: true; library: MaterialLibrary };
    const ref = { libraryId: 'mmpds', version: '1', sha256: hashOf(file) };
    const { doc } = boxOf(step(mmDocument(), 'import_material_library', ref, ctxWith(providerOf(library.library))), 'aa7075_t6');
    expect(call(doc, 'export_stl', {}, ctxWith(providerOf(library.library))).error?.code).toBe('MAT_EXPORT_CONTROLLED');
    const reloaded = deserializeDocument(serializeDocument(doc));
    expect(reloaded.materials['aa7075_t6']?.record?.unresolved).toBeDefined();
    expect(call(reloaded, 'export_stl', {}, ctxWith(null)).error).toMatchObject({
      code: 'MAT_EXPORT_CONTROLLED',
      ids: ['aa7075_t6', 'mmpds'],
    });
  });
});

describe('export_step transport', () => {
  it('refuses a controlled document before the Python bridge runs, and an agent confirmation is MAT_HUMAN_GATE', async () => {
    const { doc } = markedBox({ regime: 'ITAR' });
    let ran = false;
    const port = {
      runProgram: () => {
        ran = true;
        return Promise.reject(new Error('must not run'));
      },
      importStep: () => Promise.reject(new Error('unused')),
    };
    const plain = await exportStepFile(() => doc, port, {});
    expect('error' in plain && plain.error).toContain('MAT_EXPORT_CONTROLLED');
    const confirmed = await exportStepFile(() => doc, port, { confirmExportControlled: true });
    expect('error' in confirmed && confirmed.error).toContain('MAT_HUMAN_GATE');
    expect(ran).toBe(false);
  });
});

describe('set_export_marking', () => {
  const ITAR_BOX = markedBox({ regime: 'ITAR' }).doc;
  const port = (accept: boolean): ExecutionContext =>
    contextWith({ verify: () => (accept ? { signer: 'alice', signatureId: 's1' } : null) });

  it('VC-MAT-25: raising a marking is allowed to any caller', () => {
    const { doc } = markedBox({ regime: 'none' });
    const result = call(doc, 'set_export_marking', { material: 'secret', marking: { regime: 'EAR99' } }, NO_PORT);
    expect(result.rejected).toBeUndefined();
    expect(result.document.materials['secret']?.record?.exportMarking).toEqual({ regime: 'EAR99' });
    expect(result.summary).toBe("set_export_marking 'secret': none → EAR99.");
    expect(
      call(result.document, 'set_export_marking', { material: 'secret', marking: { regime: 'ITAR', category: 'VIII' } }, NO_PORT).document
        .materials['secret']?.record?.exportMarking,
    ).toEqual({ regime: 'ITAR', category: 'VIII' });
  });

  it('VC-MAT-25: lowering ITAR to none by an agent is MAT_HUMAN_GATE and changes nothing', () => {
    const refused = call(ITAR_BOX, 'set_export_marking', { material: 'secret', marking: { regime: 'none' } }, NO_PORT);
    expect(refused.error).toMatchObject({ code: 'MAT_HUMAN_GATE', ids: ['secret'], paths: ['confirmation'] });
    expect(refused.document).toBe(ITAR_BOX);
    expect(refused.summary).toContain('ITAR → none');
  });

  it('lowering needs a signature the port verifies', () => {
    const lower = { material: 'secret', marking: { regime: 'EAR', eccn: '9A610' }, confirmation: { signature: 'x', nonce: 'n1' } };
    expect(call(ITAR_BOX, 'set_export_marking', lower, port(false)).error?.code).toBe('MAT_HUMAN_GATE');
    const applied = call(ITAR_BOX, 'set_export_marking', lower, port(true));
    expect(applied.rejected).toBeUndefined();
    expect(applied.document.materials['secret']?.record?.exportMarking).toEqual({ regime: 'EAR', eccn: '9A610' });
  });

  it('keeping the rank (another category) is not lowering; the same marking is a no-op change', () => {
    const result = call(ITAR_BOX, 'set_export_marking', { material: 'secret', marking: { regime: 'ITAR', category: 'XV' } }, NO_PORT);
    expect(result.document.materials['secret']?.record?.exportMarking).toEqual({ regime: 'ITAR', category: 'XV' });
  });

  it('refuses an unknown material, a legacy material and EAR without an eccn', () => {
    const legacy = step(mmDocument(), 'create_material', {
      name: 'steel',
      density: 0.00785,
      color: '#aaaaaa',
      metalness: 1,
      roughness: 0.4,
    });
    expect(call(legacy, 'set_export_marking', { material: 'steel', marking: { regime: 'ITAR' } }).error?.code).toBe('MAT_RECORD_NOT_FOUND');
    expect(call(legacy, 'set_export_marking', { material: 'ghost', marking: { regime: 'ITAR' } }).error?.code).toBe('MAT_RECORD_NOT_FOUND');
    expect(call(ITAR_BOX, 'set_export_marking', { material: 'secret', marking: { regime: 'EAR' } }).error?.paths).toEqual(['marking.eccn']);
  });

  it('is pure', () => {
    const before = JSON.stringify(ITAR_BOX);
    call(ITAR_BOX, 'set_export_marking', { material: 'secret', marking: { regime: 'ITAR', category: 'II' } });
    expect(JSON.stringify(ITAR_BOX)).toBe(before);
  });
});
