import { describe, expect, it } from 'vitest';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { withoutPrivateValues } from '@core/commands/materials/libraryRecords';
import { parseMaterialLibrary } from '@core/commands/materials/libraryFormat';
import type { MaterialLibrary } from '@core/model/materialLibrary';
import type { CadDocument } from '@core/model/types';
import { boxOf, call, ctxWith, dataOf, hashOf, libraryFile, mmDocument, providerOf, step } from './support';

const SENTINEL = 123.456789;
const asLibrary = (file: Record<string, unknown>): MaterialLibrary => {
  const parsed = parseMaterialLibrary(file);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.library;
};

const privateFile = libraryFile({
  id: 'mmpds',
  version: '2024',
  storage: 'private',
  licence: 'licensed-no-redistribution',
  sentinel: SENTINEL,
});
const privateLibrary = asLibrary(privateFile);
const reference = { libraryId: 'mmpds', version: '2024', sha256: hashOf(privateFile) };
const withProvider = ctxWith(providerOf(privateLibrary));

/** A document that imported the private library by reference and assigned its record to a box. */
function privateDocument(): { doc: CadDocument; id: string } {
  const imported = step(mmDocument(), 'import_material_library', reference, withProvider);
  return boxOf(imported, 'aa7075_t6');
}

const mass = (doc: CadDocument, id: string, ctx = withProvider): Record<string, unknown> =>
  dataOf(call(doc, 'mass_properties', { entityId: id }, ctx));

describe('VC-MAT-14: private library values never leave the process', () => {
  it('the sentinel is in memory but in no saved, exported, logged or synced output', () => {
    const { doc } = privateDocument();
    const needle = String(SENTINEL);
    expect(JSON.stringify(doc.materials)).toContain(needle);
    expect(serializeDocument(doc)).not.toContain(needle);
    expect(serializeDocument(doc, { includeDerived: true })).not.toContain(needle);
    expect(JSON.stringify(doc.featureHistory)).not.toContain(needle);
    expect(JSON.stringify(withoutPrivateValues(doc))).not.toContain(needle);
    for (const language of ['cadquery', 'build123d', 'openscad', 'freecad']) {
      expect(String(dataOf(call(doc, 'export_code', { language }, withProvider))['text'])).not.toContain(needle);
    }
    const saved = JSON.parse(serializeDocument(doc)) as { document: CadDocument };
    expect(saved.document.materialLibraries?.['mmpds']).toMatchObject({ version: '2024', sha256: reference.sha256, storage: 'private' });
    expect(saved.document.materials['aa7075_t6']).toMatchObject({
      density: 0,
      record: { id: 'aa7075_t6', libraryRef: reference, unresolved: { reason: 'provider missing' } },
    });
    expect(saved.document.materials['aa7075_t6']?.propertyModels).toBeUndefined();
    expect(saved.document.featureHistory.map((entry) => entry.params)).toContainEqual(reference);
  });

  it('the same mass with the provider, and available:false without it or with another hash', () => {
    const { doc, id } = privateDocument();
    expect(mass(doc, id)['massG']).toBeCloseTo(140.5, 9);
    const reloaded = deserializeDocument(serializeDocument(doc));
    expect(reloaded.materials['aa7075_t6']?.record?.unresolved).toEqual({ reason: 'provider missing' });
    const refused = call(reloaded, 'mass_properties', { entityId: id }, ctxWith(null));
    expect(refused.error).toMatchObject({ code: 'MAT_LIBRARY_UNRESOLVED', ids: [id] });
    expect(refused.data).toBeUndefined();
    expect(refused.summary).not.toMatch(/\bmass\b.*\d+(\.\d+)? g\b/);

    const resolved = call(reloaded, 'resolve_material_libraries', {}, withProvider);
    expect(dataOf(resolved)).toMatchObject({ resolved: ['aa7075_t6'], unresolved: [] });
    expect(resolved.document.materials).toEqual(doc.materials);
    expect(mass(resolved.document, id)['massG']).toBeCloseTo(140.5, 9);
  });

  it('a different file under the same id and version leaves the record unresolved (hash mismatch)', () => {
    const { doc, id } = privateDocument();
    const reloaded = deserializeDocument(serializeDocument(doc));
    const changed = asLibrary(
      libraryFile({ id: 'mmpds', version: '2024', storage: 'private', licence: 'licensed-no-redistribution', sentinel: 1.5 }),
    );
    const result = call(reloaded, 'resolve_material_libraries', {}, ctxWith(providerOf(changed)));
    expect(dataOf(result)).toMatchObject({
      resolved: [],
      unresolved: [{ libraryId: 'mmpds', reason: 'hash mismatch', records: ['aa7075_t6'] }],
      warnings: [{ code: 'MAT_LIBRARY_UNRESOLVED', ids: ['aa7075_t6'] }],
    });
    expect(result.document.materials['aa7075_t6']?.record?.unresolved).toEqual({ reason: 'hash mismatch' });
    expect(result.document.materials['aa7075_t6']?.record?.libraryRef?.sha256).toBe(reference.sha256);
    expect(call(result.document, 'mass_properties', { entityId: id }, ctxWith(providerOf(changed))).error?.code).toBe(
      'MAT_LIBRARY_UNRESOLVED',
    );
  });

  it('reports a missing provider and a missing library; a later resolve recovers', () => {
    const { doc } = privateDocument();
    const reloaded = deserializeDocument(serializeDocument(doc));
    const none = call(reloaded, 'resolve_material_libraries', {}, ctxWith(null));
    expect(dataOf(none)['unresolved']).toEqual([{ libraryId: 'mmpds', reason: 'provider missing', records: ['aa7075_t6'] }]);
    expect(none.document).toBe(reloaded);
    const empty = call(reloaded, 'resolve_material_libraries', {}, ctxWith(providerOf()));
    expect(dataOf(empty)['unresolved']).toEqual([{ libraryId: 'mmpds', reason: 'library missing', records: ['aa7075_t6'] }]);
    expect(empty.document.materials['aa7075_t6']?.record?.unresolved).toEqual({ reason: 'library missing' });
    const recovered = call(empty.document, 'resolve_material_libraries', {}, withProvider);
    expect(recovered.document.materials['aa7075_t6']?.record?.unresolved).toBeUndefined();
    expect(recovered.document.materials['aa7075_t6']?.propertyModels).toHaveLength(4);
  });

  it('is a session command: no feature step, nothing for the log, idempotent', () => {
    const { doc } = privateDocument();
    const reloaded = deserializeDocument(serializeDocument(doc));
    const once = call(reloaded, 'resolve_material_libraries', {}, withProvider);
    expect(once.document.featureHistory).toEqual(reloaded.featureHistory);
    expect(once.document.nextStepNumber).toBe(reloaded.nextStepNumber);
    expect(once.summary).toContain('1 record(s) resolved');
    const twice = call(once.document, 'resolve_material_libraries', {}, withProvider);
    expect(twice.document).toBe(once.document);
  });

  it('is pure and leaves an embedded library alone', () => {
    const embedded = step(mmDocument(), 'import_material_library', { library: libraryFile() });
    const before = JSON.stringify(embedded);
    const result = call(embedded, 'resolve_material_libraries', {}, withProvider);
    expect(result.document).toBe(embedded);
    expect(JSON.stringify(embedded)).toBe(before);
    expect(result.summary).toContain('0 record(s) resolved');
  });

  it('TR-PROP-15 / VC-PROP-22: evaluate_property and sample_property answer MAT_LIBRARY_UNRESOLVED, then the value once resolved', () => {
    const { doc } = privateDocument();
    const reloaded = deserializeDocument(serializeDocument(doc));
    const evaluate = { material: 'aa7075_t6', property: 'Ftu', at: {}, basis: 'A' };
    const sample = { material: 'aa7075_t6', property: 'E', variable: 'T', from: { value: 250, unit: 'K' }, to: { value: 300, unit: 'K' } };
    for (const [name, params] of [
      ['evaluate_property', evaluate],
      ['sample_property', sample],
    ] as const) {
      const refused = call(reloaded, name, params, ctxWith(null));
      expect(refused.error, name).toMatchObject({ code: 'MAT_LIBRARY_UNRESOLVED', ids: ['aa7075_t6'], paths: ['material'] });
      expect(dataOf(refused), name).toMatchObject({ available: false, code: 'MAT_LIBRARY_UNRESOLVED' });
    }
    const resolved = call(reloaded, 'resolve_material_libraries', {}, withProvider).document;
    expect(dataOf(call(resolved, 'evaluate_property', evaluate))).toMatchObject({ available: true, value: SENTINEL, unit: 'ksi' });
  });

  it('replaying the history with the provider re-imports the same records', () => {
    const { doc } = privateDocument();
    const replayed = call(doc, 'replay_history', {}, withProvider);
    expect(replayed.rejected).toBeUndefined();
    expect(replayed.document.materials).toEqual(doc.materials);
    expect(replayed.document.materialLibraries).toEqual(doc.materialLibraries);
  });

  it('keeps a raised export marking when the library resolves', () => {
    const { doc } = privateDocument();
    const raised = step(doc, 'set_export_marking', { material: 'aa7075_t6', marking: { regime: 'EAR99' } });
    const reloaded = deserializeDocument(serializeDocument(raised));
    expect(reloaded.materials['aa7075_t6']?.record?.exportMarking).toEqual({ regime: 'EAR99' });
    const resolved = call(reloaded, 'resolve_material_libraries', {}, withProvider);
    expect(resolved.document.materials['aa7075_t6']?.record?.exportMarking).toEqual({ regime: 'EAR99' });
  });
});

describe('persistence of records and libraries (v3)', () => {
  it('an embedded library round-trips equal', () => {
    const doc = step(mmDocument(), 'import_material_library', { library: libraryFile() });
    const text = serializeDocument(doc);
    expect(deserializeDocument(text)).toEqual(doc);
    expect(serializeDocument(deserializeDocument(text))).toBe(text);
  });

  it('a record defined with define_material_record round-trips', () => {
    let doc = step(mmDocument(), 'define_material_record', {
      id: 'ti',
      designation: 'Ti-6Al-4V',
      specs: [{ body: 'SAE', id: 'AMS 4911', revision: 'P' }],
      licence: 'vendor-catalogue',
      exportMarking: { regime: 'EAR', eccn: '1C002' },
      superseded: { by: 'MMPDS', note: 'n' },
    });
    doc = step(doc, 'set_material_property', {
      material: 'ti',
      source: { citation: 'c' },
      property: 'density',
      value: 0.16,
      unit: 'lb/in^3',
      basis: 'supplier_unstated',
    });
    expect(deserializeDocument(serializeDocument(doc))).toEqual(doc);
  });

  const tamper = (change: (document: Record<string, unknown>) => void): string => {
    const { doc } = privateDocument();
    const saved = JSON.parse(serializeDocument(doc)) as { document: Record<string, unknown> };
    change(saved.document);
    return JSON.stringify(saved);
  };
  const material = (document: Record<string, unknown>): Record<string, unknown> =>
    (document['materials'] as Record<string, Record<string, unknown>>)['aa7075_t6'] ?? {};
  const record = (document: Record<string, unknown>): Record<string, unknown> => material(document)['record'] as Record<string, unknown>;
  const libraries = (document: Record<string, unknown>): Record<string, Record<string, unknown>> =>
    document['materialLibraries'] as Record<string, Record<string, unknown>>;

  it.each([
    ['a record whose id is not its name', (d: Record<string, unknown>) => (record(d)['id'] = 'other'), 'record.id must equal'],
    ['a record with a bad licence', (d: Record<string, unknown>) => (record(d)['licence'] = 'free'), 'record.licence'],
    ['a record with a bad marking', (d: Record<string, unknown>) => (record(d)['exportMarking'] = { regime: 'EAR' }), 'needs an eccn'],
    [
      'a record with a bad regime',
      (d: Record<string, unknown>) => (record(d)['exportMarking'] = { regime: 'secret' }),
      'exportMarking.regime',
    ],
    ['a record with bad specs', (d: Record<string, unknown>) => (record(d)['specs'] = [{}]), 'record.specs'],
    ['a record with a bad superseded', (d: Record<string, unknown>) => (record(d)['superseded'] = { by: 1 }), 'record.superseded'],
    [
      'a record with a bad library ref',
      (d: Record<string, unknown>) => (record(d)['libraryRef'] = { libraryId: 'mmpds' }),
      'libraryRef must be',
    ],
    ['an unresolved record without a reason', (d: Record<string, unknown>) => (record(d)['unresolved'] = {}), 'record.unresolved'],
    ['a record that is not an object', (d: Record<string, unknown>) => (material(d)['record'] = 3), 'record must be an object'],
    ['a record without a designation', (d: Record<string, unknown>) => delete record(d)['designation'], 'designation'],
    [
      'a pin that matches no declared library',
      (d: Record<string, unknown>) => delete libraries(d)['mmpds'],
      'does not match a declared library',
    ],
    [
      'a pin with another hash',
      (d: Record<string, unknown>) => (libraries(d)['mmpds']!['sha256'] = 'abc'),
      'does not match a declared library',
    ],
    [
      'a library entry under another key',
      (d: Record<string, unknown>) => (libraries(d)['mmpds']!['libraryId'] = 'x'),
      'libraryId must equal its key',
    ],
    [
      'a library entry without a title',
      (d: Record<string, unknown>) => delete libraries(d)['mmpds']!['title'],
      'needs version, sha256 and title',
    ],
    [
      'a library entry with bad storage',
      (d: Record<string, unknown>) => (libraries(d)['mmpds']!['storage'] = 'cloud'),
      'storage is embedded | private',
    ],
    [
      'a library entry with a bad marking',
      (d: Record<string, unknown>) => (libraries(d)['mmpds']!['exportMarking'] = {}),
      'exportMarking.regime',
    ],
    [
      'a reserved library id',
      (d: Record<string, unknown>) => (d['materialLibraries'] = JSON.parse('{"__proto__":{}}')),
      'materialLibraries',
    ],
    [
      'libraries that are not an object',
      (d: Record<string, unknown>) => (d['materialLibraries'] = []),
      'materialLibraries must be an object',
    ],
    [
      'values of a private library stored in the file',
      (d: Record<string, unknown>) => (material(d)['propertyModels'] = []),
      'must not be stored',
    ],
    [
      'a density of zero on a legacy material',
      (d: Record<string, unknown>) => delete material(d)['record'],
      'density must be finite and > 0',
    ],
  ])('refuses %s', (_name, change, message) => {
    expect(() => deserializeDocument(tamper(change))).toThrow(message);
  });
});

describe('parseMaterialLibrary', () => {
  it('hashes the library content, not its key order', () => {
    const reverseKeys = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(reverseKeys)
        : value !== null && typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value)
                .reverse()
                .map(([key, entry]) => [key, reverseKeys(entry)]),
            )
          : value;
    const reordered = reverseKeys(privateFile) as Record<string, unknown>;
    expect(hashOf(reordered)).toBe(hashOf(privateFile));
    expect(parseMaterialLibrary(privateFile)).toMatchObject({ ok: true, sha256: reference.sha256 });
    expect(parseMaterialLibrary(null)).toMatchObject({ ok: false, code: 'MAT_LIBRARY_INVALID' });
  });
});
