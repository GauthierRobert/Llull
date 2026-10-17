/**
 * Browser material-library provider (08 MAT M3, TR-MAT-16): library files kept in this browser's IndexedDB behind the same
 * `MaterialLibraryProvider` port as the server's `~/.llull/libraries/`. `get` is synchronous, so the files are read into memory once
 * (`ready`) and `register` writes through. The store is an injected port; only `indexedDbLibraryStore` touches IndexedDB.
 */

import { parseMaterialLibrary } from '@core/commands/materials/libraryFormat';
import { setMaterialLibraryProvider } from '@core/commands/libraryPort';
import type { MaterialLibraryProvider } from '@core/commands/types';
import type { MaterialLibrary } from '@core/model/materialLibrary';

/** Persistent key/value store of library files, keyed `<id>@<version>`. */
export interface LibraryFileStore {
  loadAll(): Promise<readonly unknown[]>;
  save(key: string, file: unknown): Promise<void>;
}

type RegisterResult =
  | { readonly ok: true; readonly libraryId: string; readonly version: string; readonly sha256: string; readonly stored: boolean }
  | { readonly ok: false; readonly code: string; readonly message: string };

export interface BrowserLibraries {
  readonly provider: MaterialLibraryProvider;
  /** Resolves when the stored files are readable through `provider` (never rejects: an unreadable store leaves the provider empty). */
  readonly ready: Promise<void>;
  /**
   * Validate and store a library file. A registered `id@version` is immutable: other content under it is MAT_LIBRARY_EXISTS; the same
   * content is accepted without a second write.
   */
  register(file: unknown): Promise<RegisterResult>;
}

const keyOf = (libraryId: string, version: string): string => `${libraryId}@${version}`;

export function createBrowserLibraryProvider(store: LibraryFileStore): BrowserLibraries {
  const held = new Map<string, { readonly library: MaterialLibrary; readonly sha256: string }>();
  const ready = store.loadAll().then(
    (files) => {
      for (const file of files) {
        const parsed = parseMaterialLibrary(file);
        if (parsed.ok) held.set(keyOf(parsed.library.id, parsed.library.version), { library: parsed.library, sha256: parsed.sha256 });
      }
    },
    (error: unknown) => console.warn('Material libraries could not be read from the browser store', error),
  );
  return {
    provider: { get: (libraryId, version) => held.get(keyOf(libraryId, version))?.library ?? null },
    ready,
    async register(file): Promise<RegisterResult> {
      const parsed = parseMaterialLibrary(file);
      if (!parsed.ok) return { ok: false, code: parsed.code, message: `${parsed.path}: ${parsed.message}` };
      const { library, sha256 } = parsed;
      const key = keyOf(library.id, library.version);
      const known = held.get(key);
      const identity = { ok: true as const, libraryId: library.id, version: library.version, sha256 };
      if (known !== undefined)
        return known.sha256 === sha256
          ? { ...identity, stored: false }
          : {
              ok: false,
              code: 'MAT_LIBRARY_EXISTS',
              message: `${key} is already registered with other content (${known.sha256.slice(0, 12)}…)`,
            };
      await store.save(key, library);
      held.set(key, { library, sha256 });
      return { ...identity, stored: true };
    },
  };
}

const DB_NAME = 'llull-material-libraries';
const OBJECT_STORE = 'libraries';

const settled = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = (): void => resolve(request.result);
    request.onerror = (): void => reject(request.error ?? new Error('IndexedDB request failed'));
  });

/** The IndexedDB-backed store (object store `libraries`, out-of-line keys). */
function indexedDbLibraryStore(factory: IDBFactory = indexedDB): LibraryFileStore {
  const open = (): Promise<IDBDatabase> => {
    const request = factory.open(DB_NAME, 1);
    request.onupgradeneeded = (): void => void request.result.createObjectStore(OBJECT_STORE);
    return settled(request);
  };
  return {
    async loadAll() {
      const database = await open();
      try {
        return await settled(database.transaction(OBJECT_STORE).objectStore(OBJECT_STORE).getAll());
      } finally {
        database.close();
      }
    },
    async save(key, file) {
      const database = await open();
      try {
        await settled(database.transaction(OBJECT_STORE, 'readwrite').objectStore(OBJECT_STORE).put(file, key));
      } finally {
        database.close();
      }
    },
  };
}

/** Composition root: back `ctx.libraries` of every default-context `execute` in this tab by IndexedDB. Returns the handle (`register`, `ready`). */
export function installBrowserLibraries(factory?: IDBFactory | null): BrowserLibraries | null {
  const database = factory === undefined ? (typeof indexedDB === 'undefined' ? null : indexedDB) : factory;
  if (database === null) return null;
  const libraries = createBrowserLibraryProvider(indexedDbLibraryStore(database));
  setMaterialLibraryProvider(libraries.provider);
  return libraries;
}
