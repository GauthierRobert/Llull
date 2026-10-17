/** Browser material-library provider over an injected store (no IndexedDB): register, reload, immutability, and ctx.libraries wiring. */
import { afterEach, describe, expect, it } from 'vitest';
import { setMaterialLibraryProvider } from '@core/commands/libraryPort';
import { execute } from '@core/commands/registry';
import { createBrowserLibraryProvider, installBrowserLibraries, type LibraryFileStore } from '@ui/services/browserLibraries';
import { hashOf, libraryFile, mmDocument } from './materials/support';

class MemoryStore implements LibraryFileStore {
  readonly files = new Map<string, unknown>();
  saves = 0;
  loadAll(): Promise<readonly unknown[]> {
    return Promise.resolve([...this.files.values()]);
  }
  save(key: string, file: unknown): Promise<void> {
    this.saves += 1;
    this.files.set(key, file);
    return Promise.resolve();
  }
}

afterEach(() => setMaterialLibraryProvider(null));

const file = libraryFile({ id: 'company', version: '3', storage: 'private' });

describe('browser library provider', () => {
  it('registers a valid library, serves it synchronously and finds it again after a reload of the store', async () => {
    const store = new MemoryStore();
    const first = createBrowserLibraryProvider(store);
    await first.ready;
    expect(first.provider.get('company', '3')).toBeNull();
    const result = await first.register(file);
    expect(result).toEqual({ ok: true, libraryId: 'company', version: '3', sha256: hashOf(file), stored: true });
    expect(first.provider.get('company', '3')?.materials.map((m) => m.id)).toEqual(['aa7075_t6']);
    expect(first.provider.get('company', '4')).toBeNull();
    expect(first.provider.get('other', '3')).toBeNull();

    const reloaded = createBrowserLibraryProvider(store);
    await reloaded.ready;
    expect(reloaded.provider.get('company', '3')?.id).toBe('company');
  });

  it('refuses an invalid file and writes nothing', async () => {
    const store = new MemoryStore();
    const libraries = createBrowserLibraryProvider(store);
    const result = await libraries.register({ format: 'nope' });
    expect(result).toMatchObject({ ok: false, code: 'MAT_LIBRARY_INVALID' });
    expect(store.saves).toBe(0);
  });

  it('a registered id@version is immutable: the same content is accepted without a write, other content is MAT_LIBRARY_EXISTS', async () => {
    const store = new MemoryStore();
    const libraries = createBrowserLibraryProvider(store);
    await libraries.register(file);
    expect(await libraries.register(file)).toMatchObject({ ok: true, stored: false });
    expect(store.saves).toBe(1);
    const changed = await libraries.register({ ...file, title: 'edited' });
    expect(changed).toMatchObject({ ok: false, code: 'MAT_LIBRARY_EXISTS' });
    expect(store.saves).toBe(1);
    expect(libraries.provider.get('company', '3')?.title).toBe('Synthetic library');
  });

  it('skips corrupt stored entries and survives an unreadable store (empty provider)', async () => {
    const store = new MemoryStore();
    store.files.set('bad@1', { not: 'a library' });
    store.files.set('company@3', file);
    const libraries = createBrowserLibraryProvider(store);
    await libraries.ready;
    expect(libraries.provider.get('bad', '1')).toBeNull();
    expect(libraries.provider.get('company', '3')).not.toBeNull();

    const broken = createBrowserLibraryProvider({ loadAll: () => Promise.reject(new Error('blocked')), save: () => Promise.resolve() });
    await expect(broken.ready).resolves.toBeUndefined();
    expect(broken.provider.get('company', '3')).toBeNull();
  });

  it('is what ctx.libraries of a default-context execute reads: import_material_library by reference resolves through it', async () => {
    const libraries = createBrowserLibraryProvider(new MemoryStore());
    await libraries.register(file);
    const doc = mmDocument();
    const params = { libraryId: 'company', version: '3', sha256: hashOf(file) };
    expect(execute(doc, 'import_material_library', params).error?.code).toBe('MAT_LIBRARY_UNRESOLVED');
    setMaterialLibraryProvider(libraries.provider);
    const imported = execute(doc, 'import_material_library', params);
    expect(imported.error).toBeUndefined();
    expect(imported.document.materialLibraries?.['company']?.storage).toBe('private');
  });

  it('installBrowserLibraries does nothing without IndexedDB', () => {
    expect(installBrowserLibraries(null)).toBeNull();
    expect(execute(mmDocument(), 'import_material_library', { libraryId: 'company', version: '3', sha256: hashOf(file) }).error?.code).toBe(
      'MAT_LIBRARY_UNRESOLVED',
    );
  });
});
