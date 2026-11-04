/** Plant 01 PSC: private libraries through the `PipingLibraryProvider` port (`import_piping_library`, PSC_LIBRARY_UNRESOLVED). */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { sha256Hex } from '@lib/sha256';
import { pipingCatalogErrors } from '@aec/plant/catalog/document';
import { setPipingLibraryProvider, type PipingLibraryProvider } from '@aec/plant/catalog/libraryPort';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';

const libraryFile = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  format: 'llull-piping-catalog',
  schemaVersion: 1,
  id: 'acme-private',
  version: '2',
  licence: 'licensed-no-redistribution',
  families: [
    {
      id: 'acme-pipe',
      type: 'pipe',
      standard: 'ACME 1',
      unit: 'mm',
      sizes: [{ dn: 175, outsideDiameter: 190, wall: 5, schedule: 'S', provenance: { citation: 'ACME catalogue 2026' } }],
    },
  ],
  ...over,
});
const text = JSON.stringify(libraryFile());
const files = new Map<string, string>();
const provider: PipingLibraryProvider = { get: (id, version) => files.get(`${id}@${version}`) ?? null };
const spec = {
  format: 'llull-pipe-spec',
  schemaVersion: 1,
  id: 'ACME-1',
  dimensionalStandard: 'company',
  rating: { system: 'EN 1092-1', pn: 16 },
  corrosionAllowance: { value: 1, unit: 'mm' },
  sizeRange: { fromDn: 150, toDn: 200 },
  catalogs: ['acme-private'],
  components: [{ id: 'P', type: 'pipe', fromDn: 150, toDn: 200, catalogRef: 'acme-pipe', schedule: 'S' }],
};
const doc0 = createEmptyDocument();
const referenced = (): CadDocument => apply(doc0, 'import_piping_library', { libraryId: 'acme-private', version: '2' });
const hash = 'a'.repeat(64);

beforeEach(() => {
  files.set('acme-private@2', text);
  setPipingLibraryProvider(provider);
});
afterEach(() => setPipingLibraryProvider(null));

describe('import_piping_library', () => {
  it('stores only { libraryId, version, sha256 } and resolves the values through the provider', () => {
    const result = ok(doc0, 'import_piping_library', { libraryId: 'acme-private', version: '2' });
    expect(result.document.plant?.catalog?.libraries).toEqual({
      'acme-private': { libraryId: 'acme-private', version: '2', sha256: sha256Hex(text) },
    });
    expect(JSON.stringify(result.document.plant)).not.toContain('ACME catalogue');
    expect(result.summary).toContain('licensed-no-redistribution');
    const listed = data<{ catalogs: Array<{ id: string; origin: string }> }>(result.document, 'list_piping_catalogs', {});
    expect(listed.catalogs.map((c) => `${c.id}:${c.origin}`)).toEqual(['llull-open-piping:bundled', 'acme-private:library']);
    const withSpec = apply(result.document, 'import_pipe_spec', { spec });
    const row = data<Record<string, unknown>>(withSpec, 'resolve_spec_component', { specId: 'ACME-1', type: 'pipe', dn: 175 });
    expect(row['wallMm']).toBe(5);
    expectPure(doc0, () => execute(doc0, 'import_piping_library', { libraryId: 'acme-private', version: '2' }));
  });

  it('is idempotent, and a different file needs replace', () => {
    const again = execute(referenced(), 'import_piping_library', { libraryId: 'acme-private', version: '2' });
    expect(again.summary).toContain('nothing changed');
    files.set('acme-private@3', JSON.stringify(libraryFile({ version: '3' })));
    expectRefusal(referenced(), 'import_piping_library', { libraryId: 'acme-private', version: '3' }, 'PSC_CATALOG_CONFLICT');
    const replaced = ok(referenced(), 'import_piping_library', { libraryId: 'acme-private', version: '3', replace: true });
    expect(replaced.document.plant?.catalog?.libraries?.['acme-private']?.version).toBe('3');
  });

  it('refuses with PSC_LIBRARY_UNRESOLVED: no provider, file absent, hash mismatch, invalid file, id mismatch', () => {
    const args = { libraryId: 'acme-private', version: '2' };
    expectRefusal(doc0, 'import_piping_library', { ...args, version: '9' }, 'PSC_LIBRARY_UNRESOLVED', 'libraryId');
    expectRefusal(doc0, 'import_piping_library', { ...args, sha256: hash }, 'PSC_LIBRARY_UNRESOLVED');
    files.set('acme-private@2', '{not json');
    expectRefusal(doc0, 'import_piping_library', args, 'PSC_LIBRARY_UNRESOLVED');
    files.set('acme-private@2', JSON.stringify({ format: 'nope' }));
    expectRefusal(doc0, 'import_piping_library', args, 'PSC_LIBRARY_UNRESOLVED');
    files.set('acme-private@2', JSON.stringify(libraryFile({ id: 'other' })));
    expectRefusal(doc0, 'import_piping_library', args, 'PSC_LIBRARY_UNRESOLVED');
    setPipingLibraryProvider(null);
    const none = expectRefusal(doc0, 'import_piping_library', args, 'PSC_LIBRARY_UNRESOLVED');
    expect(none.summary).toContain('no piping library provider');
  });

  it('refuses a bad id and the id of the bundled or an imported catalogue', () => {
    expectRefusal(doc0, 'import_piping_library', { libraryId: 'bad id!', version: '2' }, 'PSC_CATALOG_INVALID');
    expectRefusal(doc0, 'import_piping_library', { libraryId: 'llull-open-piping', version: '2' }, 'PSC_CATALOG_CONFLICT');
    const imported = apply(doc0, 'import_piping_catalog', { catalog: libraryFile({ licence: 'company-proprietary' }) });
    expectRefusal(imported, 'import_piping_library', { libraryId: 'acme-private', version: '2' }, 'PSC_CATALOG_CONFLICT');
  });
});

describe('PSC_LIBRARY_UNRESOLVED is raised on reads of a spec that names a library this machine lacks', () => {
  it('answers PSC_LIBRARY_UNRESOLVED (not PSC_CATALOG_UNKNOWN), check_pipe_spec fails with it, and the document still loads', () => {
    const withSpec = apply(referenced(), 'import_pipe_spec', { spec });
    setPipingLibraryProvider(null);
    const refused = expectRefusal(
      withSpec,
      'resolve_spec_component',
      { specId: 'ACME-1', type: 'pipe', dn: 175 },
      'PSC_LIBRARY_UNRESOLVED',
    );
    expect(refused.summary).toContain('private library');
    const checked = data<{ issues: Array<{ code: string; status: string }> }>(withSpec, 'check_pipe_spec', { specId: 'ACME-1' });
    expect(checked.issues.find((issue) => issue.code === 'PSC_LIBRARY_UNRESOLVED')?.status).toBe('fail');
    expect(checked.issues.map((issue) => issue.code)).not.toContain('PSC_CATALOG_UNKNOWN');
    const listed = data<{ unresolvedLibraries: Array<{ libraryId: string }> }>(withSpec, 'list_piping_catalogs', {});
    expect(listed.unresolvedLibraries.map((l) => l.libraryId)).toEqual(['acme-private']);
    expect(() => deserializeDocument(serializeDocument(withSpec))).not.toThrow();
  });

  it('a file whose hash changed after the reference is unresolved; an unreferenced unknown catalogue stays PSC_CATALOG_UNKNOWN', () => {
    const withSpec = apply(referenced(), 'import_pipe_spec', { spec });
    files.set('acme-private@2', JSON.stringify(libraryFile({ title: 'edited' })));
    expectRefusal(withSpec, 'resolve_spec_component', { specId: 'ACME-1', type: 'pipe', dn: 175 }, 'PSC_LIBRARY_UNRESOLVED');
    const unknown = apply(doc0, 'import_pipe_spec', { spec: { ...spec, catalogs: ['nowhere'] } });
    expectRefusal(unknown, 'resolve_spec_component', { specId: 'ACME-1', type: 'pipe', dn: 175 }, 'PSC_CATALOG_UNKNOWN');
  });

  it('a licensed library is not exported; load validation rejects a malformed or clashing reference', () => {
    expectRefusal(referenced(), 'export_piping_catalog', { catalogId: 'acme-private' }, 'PSC_LICENCE_EMBED_FORBIDDEN');
    const base = { catalogs: {}, catalogOrder: [] };
    const reference = (id: string, sha256: string): Record<string, unknown> => ({ [id]: { libraryId: id, version: '2', sha256 } });
    expect(pipingCatalogErrors({ ...base, libraries: { x: { libraryId: 'y', version: '1', sha256: 'zz' } } })).toHaveLength(1);
    expect(pipingCatalogErrors({ ...base, libraries: reference('llull-open-piping', hash) })).toHaveLength(1);
    expect(pipingCatalogErrors({ ...base, libraries: 3 })).toHaveLength(1);
    expect(pipingCatalogErrors({ ...base, libraries: reference('acme-private', hash) })).toEqual([]);
  });
});
