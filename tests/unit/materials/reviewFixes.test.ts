import { describe, expect, it } from 'vitest';
import { serializeDocument } from '@core/commands/persistence/serialization';
import { withoutPrivateValues } from '@core/commands/materials/libraryRecords';
import { parseMaterialLibrary } from '@core/commands/materials/libraryFormat';
import type { MaterialLibrary } from '@core/model/materialLibrary';
import type { CadDocument } from '@core/model/types';
import { defaultContext } from '@core/commands/context';
import type { ExecutionContext } from '@core/commands/types';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';
import { boxOf, call, ctxWith, hashOf, libraryFile, mmDocument, providerOf, step } from './support';

const SENTINEL = 123.456789;
const privateFile = libraryFile({
  id: 'mmpds',
  version: '2024',
  storage: 'private',
  licence: 'licensed-no-redistribution',
  sentinel: SENTINEL,
});
const parsed = parseMaterialLibrary(privateFile);
if (!parsed.ok) throw new Error(parsed.message);
const privateLibrary: MaterialLibrary = parsed.library;
const reference = { libraryId: 'mmpds', version: '2024', sha256: hashOf(privateFile) };
const withProvider = ctxWith(providerOf(privateLibrary));
const needle = String(SENTINEL);

const privateDocument = (): CadDocument => boxOf(step(mmDocument(), 'import_material_library', reference, withProvider), 'aa7075_t6').doc;

describe('review fix 1: apply_code_trace replace keeps the library declarations', () => {
  it('keeps materialLibraries so private values are stripped on save and the file loads', () => {
    const doc = privateDocument();
    const result = call(doc, 'apply_code_trace', {
      trace: { parameters: [], features: [{ command: 'add_box', params: { size: [1, 1, 1] } }] },
    });
    expect(result.rejected).toBeUndefined();
    expect(result.document.materialLibraries).toEqual(doc.materialLibraries);
    expect(serializeDocument(result.document)).not.toContain(needle);
  });

  it('withoutPrivateValues fails closed: a pinned record without a declared library becomes a stub', () => {
    const doc = privateDocument();
    const { materialLibraries: _dropped, ...undeclared } = doc;
    void _dropped;
    const stripped = withoutPrivateValues(undeclared);
    expect(JSON.stringify(stripped)).not.toContain(needle);
    expect(stripped.materials['aa7075_t6']?.record?.unresolved).toEqual({ reason: 'library missing' });
    expect(stripped.materials['aa7075_t6']?.propertyModels).toBeUndefined();
  });

  it('keeps the values of a record of a declared embedded library', () => {
    const doc = step(mmDocument(), 'import_material_library', { library: libraryFile() });
    expect(withoutPrivateValues(doc)).toBe(doc);
  });
});

const stepIdOf = (doc: CadDocument, name: string): string => doc.featureHistory.find((entry) => entry.name === name)?.id ?? '';

describe('review fix 2: replay regenerates records instead of carrying them', () => {
  it('suppressing or deleting the library import leaves no private value in the saved file', () => {
    const doc = privateDocument();
    const importId = stepIdOf(doc, 'import_material_library');
    const suppressed = call(doc, 'set_step_suppressed', { stepId: importId, suppressed: true }, withProvider).document;
    expect(JSON.stringify(suppressed.materials)).not.toContain(needle);
    expect(serializeDocument(suppressed)).not.toContain(needle);
    const deleted = call(doc, 'delete_step', { stepId: importId }, withProvider).document;
    expect(deleted.materialLibraries).toBeUndefined();
    expect(JSON.stringify(deleted.materials)).not.toContain(needle);
  });

  const record = { id: 'alloy', designation: 'X', specs: [], licence: 'company-proprietary', exportMarking: { regime: 'none' } };
  const density = (value: number): Record<string, unknown> => ({
    material: 'alloy',
    source: { citation: 'c' },
    property: 'density',
    value,
    unit: 'g/cm^3',
    basis: 'company',
  });

  it('editing a set_material_property step takes effect (no PROP_MODEL_EXISTS); deleting it removes the value', () => {
    const base = step(step(mmDocument(), 'define_material_record', record), 'set_material_property', density(2.7));
    const propertyId = stepIdOf(base, 'set_material_property');
    const edited = call(base, 'edit_step_params', { stepId: propertyId, params: density(8.1) });
    expect(edited.rejected).toBeUndefined();
    expect(edited.document.materials['alloy']?.density).toBeCloseTo(0.0081, 9);
    expect(edited.document.materials['alloy']?.propertyModels).toHaveLength(1);
    const deleted = call(edited.document, 'delete_step', { stepId: propertyId }).document;
    expect(deleted.materials['alloy']?.propertyModels ?? []).toHaveLength(0);
  });
});

const signingContext = (seen: string[] = [], accept = true): ExecutionContext => ({
  ...defaultContext(),
  humanSignature: {
    verify: (_signature, payload) => {
      seen.push(payload);
      return accept ? { signer: 'alice', signatureId: 's1' } : null;
    },
  },
});
const SIGNATURE = { signature: 'x', nonce: 'n-1' };

describe('review fix 3 / 6: replace-import never lowers a marking without a human', () => {
  const itar = { regime: 'ITAR' };
  const imported = (): CadDocument => step(mmDocument(), 'import_material_library', { library: libraryFile({ marking: itar }) });
  const next = (marking: Record<string, unknown>, materialMarking = marking): Record<string, unknown> => {
    const file = libraryFile({ version: '2', marking });
    const materials = (file['materials'] as Record<string, unknown>[]).map((material) => ({ ...material, exportMarking: materialMarking }));
    return { library: { ...file, materials }, replace: true };
  };

  it('VC-MAT-25: lowering the library marking (and its records) is MAT_HUMAN_GATE for an agent; nothing changes', () => {
    const doc = imported();
    const refused = call(doc, 'import_material_library', next({ regime: 'none' }), signingContext());
    expect(refused.error).toMatchObject({ code: 'MAT_HUMAN_GATE', paths: ['confirmation'] });
    expect(refused.error?.ids).toEqual(['synthetic-lib', 'aa7075_t6']);
    expect(refused.document).toBe(doc);
    const unverified = call(
      doc,
      'import_material_library',
      { ...next({ regime: 'none' }), confirmation: SIGNATURE },
      signingContext([], false),
    );
    expect(unverified.error?.code).toBe('MAT_HUMAN_GATE');
  });

  it('lowering only a record is gated too', () => {
    const refused = call(imported(), 'import_material_library', next(itar, { regime: 'EAR99' }), signingContext());
    expect(refused.error).toMatchObject({ code: 'MAT_HUMAN_GATE', ids: ['aa7075_t6'] });
  });

  it('a verified signature bound to the from / to markings lets it through; the stored step carries no signature', () => {
    const seen: string[] = [];
    const result = call(
      imported(),
      'import_material_library',
      { ...next({ regime: 'none' }), confirmation: SIGNATURE },
      signingContext(seen),
    );
    expect(result.rejected).toBeUndefined();
    expect(result.document.materialLibraries?.['synthetic-lib']?.exportMarking).toEqual({ regime: 'none' });
    const lowered = [
      { id: 'synthetic-lib', from: itar, to: { regime: 'none' } },
      { id: 'aa7075_t6', from: itar, to: { regime: 'none' } },
    ];
    const ids = ['aa7075_t6', 'synthetic-lib'];
    expect(seen).toEqual([sha256Hex(canonicalJson({ act: 'lowering an export marking', ids, details: { lowered }, nonce: 'n-1' }))]);
    expect(JSON.stringify(result.document.featureHistory.at(-1)?.params)).not.toContain('"signature"');
    expect(result.document.featureHistory.at(-1)?.params).toMatchObject({ confirmation: { verified: true } });
  });

  it('keeping or raising a marking needs no confirmation', () => {
    expect(call(imported(), 'import_material_library', next(itar), signingContext()).rejected).toBeUndefined();
    const none = step(mmDocument(), 'import_material_library', { library: libraryFile() });
    expect(call(none, 'import_material_library', next(itar), signingContext()).rejected).toBeUndefined();
  });

  it('set_export_marking binds the signature to the from / to markings and stores no signature', () => {
    const record = { id: 'secret', designation: 'X', specs: [], licence: 'company-proprietary', exportMarking: itar };
    const doc = boxOf(step(mmDocument(), 'define_material_record', record), 'secret').doc;
    const seen: string[] = [];
    const lower = { material: 'secret', marking: { regime: 'none' }, confirmation: SIGNATURE };
    const applied = call(doc, 'set_export_marking', lower, signingContext(seen));
    expect(applied.rejected).toBeUndefined();
    const details = { lowered: [{ id: 'secret', from: itar, to: { regime: 'none' } }] };
    expect(seen).toEqual([sha256Hex(canonicalJson({ act: 'lowering an export marking', ids: ['secret'], details, nonce: 'n-1' }))]);
    expect(JSON.stringify(applied.document.featureHistory)).not.toContain('"signature"');
    const noNonce = call(doc, 'set_export_marking', { ...lower, confirmation: { signature: 'x' } }, signingContext());
    expect(noNonce.summary).toContain('nonce');
  });
});

describe('review fix 5: material-model commands refuse library records', () => {
  const imported = (): CadDocument => step(mmDocument(), 'import_material_library', { library: libraryFile() });
  it.each([
    [
      'define_property_model',
      {
        material: 'aa7075_t6',
        model: {
          id: 'k',
          property: 'k',
          unit: 'W/(m*K)',
          variables: [],
          form: { kind: 'constant', value: 1 },
          validity: [],
          basis: 'B',
          source: { citation: 'c' },
        },
      },
    ],
    ['delete_property_model', { material: 'aa7075_t6', modelId: 'density' }],
    ['add_material_model', { material: 'aa7075_t6', id: 'sy', model: { kind: 'elastic' }, basis: 'B', source: { citation: 'c' } }],
    ['delete_material_model', { material: 'aa7075_t6', id: 'sy' }],
    ['define_constitutive_set', { material: 'aa7075_t6', set: { id: 'set1' } }],
  ])('%s -> MAT_RECORD_READONLY', (name, params) => {
    const start = imported();
    const result = call(start, name, params);
    expect(result.error?.code, result.summary).toBe('MAT_RECORD_READONLY');
    expect(result.document).toBe(start);
  });
});
