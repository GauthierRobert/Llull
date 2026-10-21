import { describe, expect, it } from 'vitest';
import { parseMaterialLibrary } from '@core/commands/materials/libraryFormat';
import { call, ctxWith, dataOf, hashOf, libraryFile, mmDocument, providerOf, SOURCE, step } from './support';
import type { MaterialLibrary } from '@core/model/materialLibrary';

const asLibrary = (file: Record<string, unknown>): MaterialLibrary => {
  const parsed = parseMaterialLibrary(file);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.library;
};
const withMaterials = (
  file: Record<string, unknown>,
  change: (material: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> => ({ ...file, materials: (file['materials'] as Record<string, unknown>[]).map(change) });

describe('import_material_library', () => {
  it('imports an embedded library as read-only records with their values and a pinned hash', () => {
    const file = libraryFile();
    const result = call(mmDocument(), 'import_material_library', { library: file });
    expect(result.summary).toContain("import_material_library 'synthetic-lib@1': 1 record(s) (aa7075_t6)");
    const sha256 = hashOf(file);
    expect(result.document.materialLibraries?.['synthetic-lib']).toEqual({
      libraryId: 'synthetic-lib',
      version: '1',
      sha256,
      title: 'Synthetic library',
      storage: 'embedded',
      licence: 'company-proprietary',
      exportMarking: { regime: 'none' },
    });
    const material = result.document.materials['aa7075_t6'];
    expect(material?.record).toMatchObject({
      id: 'aa7075_t6',
      designation: '7075',
      libraryRef: { libraryId: 'synthetic-lib', version: '1', sha256 },
    });
    expect(material?.propertyModels?.map((m) => m.id)).toEqual(['density', 'E', 'Fbru.B']);
    expect(material?.propertyModels?.every((m) => m.coefficientsSha256.length === 64)).toBe(true);
    expect(material?.density).toBeCloseTo(0.00281, 12);
    expect(result.document.featureHistory.at(-1)?.name).toBe('import_material_library');
    expect(
      call(result.document, 'set_material_property', {
        material: 'aa7075_t6',
        source: SOURCE,
        property: 'E',
        value: 1,
        unit: 'Msi',
        basis: 'A',
      }).error?.code,
    ).toBe('MAT_RECORD_READONLY');
  });

  it('is pure', () => {
    const doc = mmDocument();
    const before = JSON.stringify(doc);
    call(doc, 'import_material_library', { library: libraryFile() });
    expect(JSON.stringify(doc)).toBe(before);
  });

  it('accepts a matching sha256 and refuses a different one (VC-MAT-24: hash mismatch)', () => {
    const file = libraryFile();
    const doc = mmDocument();
    expect(call(doc, 'import_material_library', { library: file, sha256: hashOf(file) }).rejected).toBeUndefined();
    const refused = call(doc, 'import_material_library', { library: file, sha256: 'f'.repeat(64) });
    expect(refused.error).toMatchObject({ code: 'MAT_LIBRARY_HASH_MISMATCH', ids: ['synthetic-lib'], paths: ['sha256'] });
    expect(refused.error?.remediation).not.toBe('');
    expect(refused.document).toBe(doc);
  });

  it('VC-MAT-24: a licensed library cannot be embedded, a private one cannot travel inline', () => {
    const doc = mmDocument();
    const licensed = call(doc, 'import_material_library', {
      library: libraryFile({ licence: 'licensed-no-redistribution', storage: 'embedded' }),
    });
    expect(licensed.error).toMatchObject({ code: 'MAT_LICENCE_EMBED_FORBIDDEN', ids: ['synthetic-lib'] });
    expect(licensed.error?.remediation).toContain('private');
    const inline = call(doc, 'import_material_library', {
      library: libraryFile({ licence: 'licensed-no-redistribution', storage: 'private' }),
    });
    expect(inline.error?.code).toBe('MAT_LIBRARY_PRIVATE_INLINE');
    expect(inline.document).toBe(doc);
  });

  it('refuses an embedded library holding a licensed-no-redistribution record (its values would travel with the document)', () => {
    const doc = mmDocument();
    const file = withMaterials(libraryFile(), (m) => ({ ...m, licence: 'licensed-no-redistribution' }));
    const refused = call(doc, 'import_material_library', { library: file });
    expect(refused.error).toMatchObject({ code: 'MAT_LICENCE_EMBED_FORBIDDEN', paths: ['library.materials'] });
    expect(refused.document).toBe(doc);
    expect(refused.affected).toEqual([]);
  });

  it('refuses a library that is not valid, with the JSON path and the code of the problem', () => {
    const doc = mmDocument();
    const file = libraryFile();
    expect(call(doc, 'import_material_library', { library: { ...file, schemaVersion: 2 } }).error).toMatchObject({
      code: 'MAT_LIBRARY_INVALID',
      paths: ['library.schemaVersion'],
    });
    const badUnit = withMaterials(file, (m) => ({
      ...m,
      propertyModels: (m['propertyModels'] as Record<string, unknown>[]).map((model) =>
        model['id'] === 'density' ? { ...model, unit: 'MPa' } : model,
      ),
    }));
    expect(call(doc, 'import_material_library', { library: badUnit }).error).toMatchObject({
      code: 'MAT_UNIT_DIMENSION',
      paths: ['library.materials[0].propertyModels[0].unit'],
    });
    const badSource = withMaterials(file, (m) => ({
      ...m,
      propertyModels: [{ ...(m['propertyModels'] as Record<string, unknown>[])[0], provenance: { sourceId: 'unlisted' } }],
    }));
    expect(call(doc, 'import_material_library', { library: badSource }).error?.code).toBe('MAT_PROVENANCE_MISSING');
    const twoPreferred = withMaterials(file, (m) => ({
      ...m,
      propertyModels: (m['propertyModels'] as Record<string, unknown>[])
        .map((model) => (model['property'] === 'density' ? { ...model, preferred: true } : model))
        .concat([{ ...(m['propertyModels'] as Record<string, unknown>[])[0], id: 'density.2', preferred: true }]),
    }));
    expect(call(doc, 'import_material_library', { library: twoPreferred }).error?.code).toBe('MAT_PREFERRED_CONFLICT');
    const duplicates = { ...file, materials: [...(file['materials'] as unknown[]), (file['materials'] as unknown[])[0]] };
    expect(call(doc, 'import_material_library', { library: duplicates }).error?.paths).toEqual(['library.materials[1].id']);
    const sameModel = withMaterials(file, (m) => ({
      ...m,
      propertyModels: (m['propertyModels'] as unknown[]).concat([(m['propertyModels'] as unknown[])[0]]),
    }));
    expect(call(doc, 'import_material_library', { library: sameModel }).error?.code).toBe('MAT_LIBRARY_INVALID');
    expect(parseMaterialLibrary(withMaterials(file, (m) => ({ ...m, id: 'toString' })))).toMatchObject({
      ok: false,
      code: 'MAT_LIBRARY_INVALID',
      path: 'materials[0].id',
    });
    expect(call(doc, 'import_material_library', { library: withMaterials(file, (m) => ({ ...m, color: 'red' })) }).error?.paths).toEqual([
      'library.materials[0].color',
    ]);
    expect(call(doc, 'import_material_library', { library: withMaterials(file, (m) => ({ ...m, metalness: 2 })) }).error?.paths).toEqual([
      'library.materials[0].metalness',
    ]);
  });

  it('asks for exactly one source', () => {
    const doc = mmDocument();
    expect(call(doc, 'import_material_library', {}).error).toMatchObject({ code: 'PROP_FORM_INVALID' });
    expect(call(doc, 'import_material_library', { library: libraryFile(), libraryId: 'x', version: '1', sha256: 'a' }).error?.code).toBe(
      'PROP_FORM_INVALID',
    );
    expect(call(doc, 'import_material_library', { libraryId: 'x', version: '1' }).error?.paths).toEqual(['sha256']);
    expect(call(doc, 'import_material_library', { libraryId: 'x', sha256: 'a' }).error?.code).toBe('PROP_FORM_INVALID');
  });

  it('reads a library by reference from the provider, and says so when there is none', () => {
    const file = libraryFile();
    const doc = mmDocument();
    const reference = { libraryId: 'synthetic-lib', version: '1', sha256: hashOf(file) };
    expect(call(doc, 'import_material_library', reference, ctxWith(null)).error).toMatchObject({
      code: 'MAT_LIBRARY_UNRESOLVED',
      paths: ['libraryId'],
    });
    expect(call(doc, 'import_material_library', reference, ctxWith(providerOf())).error?.code).toBe('MAT_LIBRARY_UNRESOLVED');
    const imported = call(doc, 'import_material_library', reference, ctxWith(providerOf(asLibrary(file))));
    expect(imported.document.materials['aa7075_t6']).toBeDefined();
    expect(imported.document.featureHistory.at(-1)?.params).toEqual(reference);
    const stale = call(doc, 'import_material_library', { ...reference, sha256: '0'.repeat(64) }, ctxWith(providerOf(asLibrary(file))));
    expect(stale.error?.code).toBe('MAT_LIBRARY_HASH_MISMATCH');
  });

  it('needs replace for a known library, replaces it with a new version, and protects used records', () => {
    const v1 = libraryFile({ version: '1', fbru: 156 });
    const v2 = libraryFile({ version: '2', fbru: 146 });
    let doc = step(mmDocument(), 'import_material_library', { library: v1 });
    expect(call(doc, 'import_material_library', { library: v2 }).error?.code).toBe('MAT_LIBRARY_EXISTS');
    const replaced = call(doc, 'import_material_library', { library: v2, replace: true });
    expect(replaced.summary).toContain('replaced 1');
    expect(replaced.document.materialLibraries?.['synthetic-lib']?.version).toBe('2');
    expect(replaced.document.materials['aa7075_t6']?.record?.libraryRef?.version).toBe('2');
    const added = call(doc, 'add_box', { size: [1, 1, 1] });
    doc = step(added.document, 'assign_material', { materialName: 'aa7075_t6', entityIds: [added.affected[0] ?? ''] });
    const otherMaterial = libraryFile({ version: '3', materialId: 'other' });
    const dropped = call(doc, 'import_material_library', { library: otherMaterial, replace: true });
    expect(dropped.error).toMatchObject({ code: 'MAT_RECORD_IN_USE', ids: [added.affected[0]] });
    expect(dropped.document).toBe(doc);
  });

  it('refuses a record id that is already a material of the document', () => {
    const doc = step(mmDocument(), 'create_material', {
      name: 'aa7075_t6',
      density: 0.0027,
      color: '#aaaaaa',
      metalness: 1,
      roughness: 0.4,
    });
    const refused = call(doc, 'import_material_library', { library: libraryFile() });
    expect(refused.error).toMatchObject({ code: 'MAT_RECORD_EXISTS', ids: ['aa7075_t6'] });
  });
});

describe('delete_material_library', () => {
  it('removes the library and its records, refuses while a record is assigned, and refuses an unknown id', () => {
    const imported = step(mmDocument(), 'import_material_library', { library: libraryFile() });
    const removed = call(imported, 'delete_material_library', { libraryId: 'synthetic-lib' });
    expect(removed.document.materials['aa7075_t6']).toBeUndefined();
    expect(removed.document.materialLibraries).toBeUndefined();
    expect(removed.summary).toContain('removed 1 record(s)');
    expect(call(imported, 'delete_material_library', { libraryId: 'ghost' }).error?.code).toBe('MAT_RECORD_NOT_FOUND');
    const box = call(imported, 'add_box', { size: [1, 1, 1] });
    const used = step(box.document, 'assign_material', { materialName: 'aa7075_t6', entityIds: [box.affected[0] ?? ''] });
    const refused = call(used, 'delete_material_library', { libraryId: 'synthetic-lib' });
    expect(refused.error).toMatchObject({ code: 'MAT_RECORD_IN_USE', ids: [box.affected[0]] });
    expect(refused.document).toBe(used);
  });

  it('keeps the other libraries', () => {
    let doc = step(mmDocument(), 'import_material_library', { library: libraryFile() });
    doc = step(doc, 'import_material_library', { library: libraryFile({ id: 'second', materialId: 'second_m' }) });
    const removed = call(doc, 'delete_material_library', { libraryId: 'synthetic-lib' });
    expect(Object.keys(removed.document.materialLibraries ?? {})).toEqual(['second']);
    expect(Object.keys(removed.document.materials)).toEqual(['second_m']);
  });

  it('is pure', () => {
    const doc = step(mmDocument(), 'import_material_library', { library: libraryFile() });
    const before = JSON.stringify(doc);
    call(doc, 'delete_material_library', { libraryId: 'synthetic-lib' });
    expect(JSON.stringify(doc)).toBe(before);
  });
});

describe('diff_material_libraries', () => {
  const v1 = libraryFile({ version: '1', fbru: 156 });
  const v2 = withMaterials(libraryFile({ version: '2', fbru: 146 }), (m) => ({
    ...m,
    propertyModels: (m['propertyModels'] as Record<string, unknown>[]).map((model) =>
      model['id'] === 'Fbru.B' ? { ...model, provenance: { citation: 'synthetic library', locator: 'Table 3.7.6.0(b) 2nd ed.' } } : model,
    ),
  }));

  it('VC-MAT-13: lists the one changed value with old and new value and both provenances', () => {
    const result = call(mmDocument(), 'diff_material_libraries', { a: { version: '1', library: v1 }, b: { version: '2', library: v2 } });
    const data = dataOf(result);
    expect(data['changed']).toHaveLength(1);
    expect((data['changed'] as Record<string, unknown>[])[0]).toMatchObject({
      material: 'aa7075_t6',
      modelId: 'Fbru.B',
      property: 'Fbru',
      fields: expect.arrayContaining(['form', 'provenance']),
      old: { value: 156, unit: 'ksi', provenance: { locator: 'Table 3.7.6.0(b)' } },
      new: { value: 146, unit: 'ksi', provenance: { locator: 'Table 3.7.6.0(b) 2nd ed.' } },
    });
    expect(data).toMatchObject({
      identical: false,
      added: [],
      removed: [],
      unchanged: 2,
      materialsAdded: [],
      materialsRemoved: [],
      recordChanges: [],
    });
    expect((data['a'] as { version: string }).version).toBe('1');
    expect(result.summary).toContain('1 changed');
  });

  it('lists added and removed values and materials and record changes', () => {
    const grown = {
      ...libraryFile({ version: '3', materialId: 'aa7075_t6' }),
      materials: [
        {
          ...(libraryFile({ version: '3' })['materials'] as Record<string, unknown>[])[0],
          designation: '7075-X',
          propertyModels: [
            ...(libraryFile()['materials'] as { propertyModels: Record<string, unknown>[] }[])[0]!.propertyModels.filter(
              (model) => model['id'] !== 'E',
            ),
            {
              id: 'G',
              property: 'G',
              unit: 'Msi',
              variables: [],
              validity: [],
              form: { kind: 'constant', value: 3.9 },
              basis: 'company',
              provenance: { citation: 'x' },
            },
          ],
        },
        (libraryFile({ materialId: 'extra' })['materials'] as unknown[])[0],
      ],
    };
    const data = dataOf(
      call(mmDocument(), 'diff_material_libraries', { a: { version: '1', library: v1 }, b: { version: '3', library: grown } }),
    );
    expect(data).toMatchObject({
      materialsAdded: ['extra'],
      materialsRemoved: [],
      added: [{ material: 'aa7075_t6', modelId: 'G' }],
      removed: [{ material: 'aa7075_t6', modelId: 'E' }],
      recordChanges: [{ material: 'aa7075_t6', fields: ['designation'] }],
    });
    const reverse = dataOf(
      call(mmDocument(), 'diff_material_libraries', { a: { version: '3', library: grown }, b: { version: '1', library: v1 } }),
    );
    expect(reverse['materialsRemoved']).toEqual(['extra']);
  });

  it('reports identical libraries and reads sides from the provider', () => {
    const same = dataOf(
      call(mmDocument(), 'diff_material_libraries', { a: { version: '1', library: v1 }, b: { version: '1', library: v1 } }),
    );
    expect(same).toMatchObject({ identical: true, changed: [], unchanged: 3 });
    const viaProvider = call(
      mmDocument(),
      'diff_material_libraries',
      { a: { libraryId: 'synthetic-lib', version: '1' }, b: { version: '2', library: v2 } },
      ctxWith(providerOf(asLibrary(v1))),
    );
    expect(dataOf(viaProvider)['changed']).toHaveLength(1);
  });

  it('refuses an unreadable or invalid side with its path', () => {
    const doc = mmDocument();
    expect(
      call(doc, 'diff_material_libraries', { a: { libraryId: 'ghost', version: '1' }, b: { version: '1', library: v1 } }).error,
    ).toMatchObject({ code: 'MAT_LIBRARY_UNRESOLVED', paths: ['a.libraryId'] });
    expect(
      call(doc, 'diff_material_libraries', { a: { version: '1', library: v1 }, b: { version: '1', library: { format: 'nope' } } }).error
        ?.code,
    ).toBe('MAT_LIBRARY_INVALID');
    expect(call(doc, 'diff_material_libraries', { a: { version: '1' }, b: { version: '1', library: v1 } }).error?.paths).toEqual([
      'a.libraryId',
    ]);
  });
});
