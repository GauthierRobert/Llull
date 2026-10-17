/**
 * Material libraries on the server (08 MAT M3): the library store behind ctx.libraries and register_material_library, the session command
 * resolve_material_libraries on the live document, and the live snapshot that never carries private values (TR-MAT-31, VC-MAT-14).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { serializeDocument, deserializeDocument } from '@core/commands/persistence/serialization';
import { libraryHash } from '@core/commands/materials/libraryFormat';
import type { MaterialLibrary } from '@core/model/materialLibrary';
import { applyExchangeToolCall } from '@mcp/exchangeTools';
import { makeFakeRes, parseSseFrame } from './sseTestHelpers';
import { applyCommand, canUndo, _resetHistory } from '../src/commandBus';
import { getLiveDoc, getLiveSnapshot, _resetLiveDoc, subscribeLive } from '../src/liveDocument';
import { createLibraryProvider, createLibraryStorePort } from '../src/libraries/libraryStore';
import { serverContext } from '../src/fea/context';
import { takesFileParam, withFileContent } from '../src/cli/exchange';

const SENTINEL = 123.456789;
const model = (id: string, property: string, value: number, unit: string, basis: string): Record<string, unknown> => ({
  id,
  property,
  unit,
  variables: [],
  validity: [],
  form: { kind: 'constant', value },
  basis,
  provenance: { citation: 'synthetic' },
});
const file = {
  format: 'llull-material-library',
  schemaVersion: 1,
  id: 'mmpds',
  version: '2024',
  title: 'Licensed',
  licence: 'licensed-no-redistribution',
  exportMarking: { regime: 'none' },
  storage: 'private',
  sources: {},
  materials: [
    {
      id: 'aa7075_t6',
      name: 'aa7075_t6',
      designation: '7075',
      specs: [],
      licence: 'licensed-no-redistribution',
      exportMarking: { regime: 'none' },
      propertyModels: [model('density', 'density', 2.81, 'g/cm^3', 'company'), model('Ftu.A', 'Ftu', SENTINEL, 'ksi', 'A')],
    },
  ],
};
const sha256 = libraryHash(file as unknown as MaterialLibrary);

let directory = '';
const previousDirectory = process.env['LLULL_LIBRARIES_DIR'];

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'llull-libs-'));
  process.env['LLULL_LIBRARIES_DIR'] = directory;
  _resetLiveDoc();
  _resetHistory();
});

afterEach(() => {
  if (previousDirectory === undefined) delete process.env['LLULL_LIBRARIES_DIR'];
  else process.env['LLULL_LIBRARIES_DIR'] = previousDirectory;
  rmSync(directory, { recursive: true, force: true });
});

const register = (libraryJson: string, storage?: string): ReturnType<typeof applyExchangeToolCall> =>
  applyExchangeToolCall(
    'register_material_library',
    { libraryJson, ...(storage !== undefined ? { storage } : {}) },
    {
      port: null,
      libraries: createLibraryStorePort(),
      getDoc: getLiveDoc,
      applyCommand: () => ({ summary: '', affected: [], isError: false }),
      allowCodeExecution: false,
    },
  );

describe('library store', () => {
  it('register_material_library copies the file into LLULL_LIBRARIES_DIR and the provider reads it back', async () => {
    const result = await register(JSON.stringify(file), 'private');
    expect(result?.isError).toBe(false);
    expect(result?.structuredContent).toMatchObject({
      libraryId: 'mmpds',
      version: '2024',
      sha256,
      storage: 'private',
      licence: 'licensed-no-redistribution',
    });
    const stored = path.join(directory, 'mmpds@2024.llull-matlib.json');
    expect(statSync(stored).mode & 0o777).toBe(0o600);
    expect(libraryHash(JSON.parse(readFileSync(stored, 'utf8')) as MaterialLibrary)).toBe(sha256);
    const provider = createLibraryProvider();
    expect(libraryHash(provider.get('mmpds', '2024') as MaterialLibrary)).toBe(sha256);
    expect(provider.get('mmpds', '2025')).toBeNull();
    expect(provider.get('other', '2024')).toBeNull();
  });

  it('refuses an invalid file and stores nothing; the provider ignores corrupt or mislabelled files', async () => {
    expect((await register('{"format":"nope"}'))?.isError).toBe(true);
    expect((await register(JSON.stringify(file), 'embedded'))?.isError).toBe(true);
    writeFileSync(path.join(directory, 'mmpds@2024.llull-matlib.json'), '{not json');
    expect(createLibraryProvider().get('mmpds', '2024')).toBeNull();
    writeFileSync(path.join(directory, 'mmpds@2024.llull-matlib.json'), JSON.stringify({ ...file, version: '1999' }));
    expect(createLibraryProvider().get('mmpds', '2024')).toBeNull();
  });

  it('a registered version is immutable: other content under the same id@version is refused and the stored file is kept', async () => {
    expect((await register(JSON.stringify(file), 'private'))?.isError).toBe(false);
    expect((await register(JSON.stringify(file), 'private'))?.isError).toBe(false);
    const changed = { ...file, title: 'Licensed, edited' };
    const refused = await register(JSON.stringify(changed), 'private');
    expect(refused?.isError).toBe(true);
    expect(JSON.stringify(refused)).toContain('MAT_LIBRARY_EXISTS');
    const stored = JSON.parse(readFileSync(path.join(directory, 'mmpds@2024.llull-matlib.json'), 'utf8')) as MaterialLibrary;
    expect(libraryHash(stored)).toBe(sha256);
    expect((await register(JSON.stringify({ ...changed, version: '2025' }), 'private'))?.isError).toBe(false);
  });

  it('refuses an id or version that is not its own file-safe name, writing nothing', () => {
    const port = createLibraryStorePort();
    for (const [id, version] of [
      ['a b', '1'],
      ['../evil', '1'],
      ['lib', '1/2'],
      ['_hidden', '1'],
    ] as const) {
      const library = { ...file, id, version } as unknown as MaterialLibrary;
      expect(() => port.register(library, libraryHash(library)), `${id}@${version}`).toThrow('MAT_LIBRARY_INVALID');
    }
    expect(readdirSync(directory)).toEqual([]);
  });

  it('the CLI reads file=<path> into libraryJson', () => {
    expect(takesFileParam('register_material_library')).toBe(true);
    const source = path.join(directory, 'in.json');
    writeFileSync(source, JSON.stringify(file));
    expect(withFileContent('register_material_library', { file: source })).toEqual({ libraryJson: JSON.stringify(file) });
  });

  it('serverContext carries the provider, which reads the directory named by the environment', async () => {
    await register(JSON.stringify(file));
    expect(serverContext().libraries?.get('mmpds', '2024')).not.toBeNull();
  });
});

describe('the live document and private libraries', () => {
  const importAndAssign = async (): Promise<string> => {
    await register(JSON.stringify(file));
    expect(applyCommand('import_material_library', { libraryId: 'mmpds', version: '2024', sha256 }).isError).toBe(false);
    const added = applyCommand('add_box', { size: [100, 50, 10] });
    const id = added.affected[0] ?? '';
    applyCommand('assign_material', { materialName: 'aa7075_t6', entityIds: [id] });
    return id;
  };

  it('the snapshot sent to clients carries no private value; the live document does', async () => {
    await importAndAssign();
    expect(JSON.stringify(getLiveDoc().materials)).toContain(String(SENTINEL));
    expect(JSON.stringify(getLiveSnapshot())).not.toContain(String(SENTINEL));
    expect(getLiveSnapshot().document.materials['aa7075_t6']?.record?.unresolved).toBeDefined();
  });

  it('resolve_material_libraries fills a loaded document, is not logged and leaves no undo entry', async () => {
    const id = await importAndAssign();
    _resetLiveDoc(deserializeDocument(serializeDocument(getLiveDoc())));
    _resetHistory();
    const refused = applyCommand('mass_properties', { entityId: id });
    expect(refused.error?.code).toBe('MAT_LIBRARY_UNRESOLVED');
    expect(refused.data).toBeUndefined();

    const response = makeFakeRes();
    const unsubscribe = subscribeLive(response);
    const resolved = applyCommand('resolve_material_libraries', {});
    expect(resolved.isError).toBe(false);
    expect(resolved.changed).toBe(true);
    expect(canUndo()).toBe(false);
    expect(getLiveDoc().featureHistory.map((step) => step.name)).not.toContain('resolve_material_libraries');
    const events = response.written.slice(1).map((frame) => parseSseFrame(frame).event);
    expect(events).toEqual(['snapshot']);
    unsubscribe();
    expect((applyCommand('mass_properties', { entityId: id }).data as { massG: number }).massG).toBeCloseTo(140.5, 9);
  });

  it('a library registered after the load is picked up by the next resolve', async () => {
    const id = await importAndAssign();
    rmSync(path.join(directory, 'mmpds@2024.llull-matlib.json'));
    _resetLiveDoc(deserializeDocument(serializeDocument(getLiveDoc())));
    expect(applyCommand('resolve_material_libraries', {}).summary).toContain('library missing');
    await register(JSON.stringify(file));
    expect(applyCommand('resolve_material_libraries', {}).summary).toContain('1 record(s) resolved');
    expect((applyCommand('mass_properties', { entityId: id }).data as { massG: number }).massG).toBeCloseTo(140.5, 9);
  });
});
