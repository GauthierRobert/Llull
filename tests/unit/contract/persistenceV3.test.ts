/** llull-document v3 (aerospace 01 §3.1): kernelSettings + blobs, the v2 -> v3 migration, blob integrity and the kernel stamp on save. */
import { afterEach, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { defaultContext } from '@core/commands/context';
import { setGeometryKernel } from '@core/geometry/kernel';
import { makeBlob } from '@core/model/blobs';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { CENSUS, fakeExactKernel, importedSolid } from '../../helpers/fakeExactKernel';

afterEach(() => setGeometryKernel(null));

const OCC = { occtVersion: '7.4.0p1', build: 'opencascade.js@1.1.1', capabilities: ['brepBlobs'] } as const;

function importedDocument(): CadDocument {
  const fake = fakeExactKernel({ imported: { solids: [importedSolid({ brep: 'CASCADE Topology V1 box' })], census: CENSUS, skipped: [] } });
  const ctx = { ...defaultContext(), kernel: fake.kernel };
  return execute(createEmptyDocument(), 'import_step_exact', { text: 'ISO-10303-21;' }, ctx).document;
}

const envelope = (version: number, document: unknown): string => JSON.stringify({ format: 'llull-document', version, document });
const tampered = (edit: (doc: CadDocument) => CadDocument): string => envelope(3, edit(importedDocument()));
const loadError = (json: string): string => {
  try {
    deserializeDocument(json);
  } catch (error) {
    return (error as Error).message;
  }
  return '';
};

describe('llull-document v3', () => {
  it('writes version 3 and round-trips blobs, the brep leaf and kernelSettings exactly', () => {
    const doc = importedDocument();
    expect(Object.keys(doc.blobs ?? {})).toHaveLength(1);
    const text = serializeDocument(doc);
    expect(JSON.parse(text)).toMatchObject({ format: 'llull-document', version: 3 });
    const loaded = deserializeDocument(text);
    expect(loaded).toEqual(doc);
    expect(serializeDocument(loaded)).toBe(text);
  });

  it('omits absent slices instead of writing them empty', () => {
    const written = JSON.parse(serializeDocument(createEmptyDocument())) as { document: Record<string, unknown> };
    expect('blobs' in written.document).toBe(false);
    expect('kernelSettings' in written.document).toBe(false);
  });

  it('is refused by the version gate of a v2-era reader', () => {
    const V2_READABLE: ReadonlySet<unknown> = new Set([1, 2]); // the reader before this step
    const version = (JSON.parse(serializeDocument(createEmptyDocument())) as { version: number }).version;
    expect(V2_READABLE.has(version)).toBe(false);
    expect(loadError(envelope(4, createEmptyDocument()))).toMatch(/unsupported version 4 — expected 1, 2 or 3/);
  });
});

describe('migrate2to3', () => {
  const v2 = (doc: CadDocument = createEmptyDocument()): string => envelope(2, doc);

  it('leaves kernelSettings and blobs absent when no kernel is known', () => {
    const loaded = deserializeDocument(v2());
    expect(loaded.kernelSettings).toBeUndefined();
    expect(loaded.blobs).toBeUndefined();
  });

  it('leaves kernelSettings absent whatever kernel is running: an old file never recorded which kernel wrote it', () => {
    setGeometryKernel(fakeExactKernel({ info: OCC }).kernel);
    expect(deserializeDocument(v2()).kernelSettings).toBeUndefined();
    expect(deserializeDocument(envelope(1, createEmptyDocument())).kernelSettings).toBeUndefined();
  });

  it('is idempotent: migrating the migrated document changes nothing, and v3 files are never rewritten', () => {
    setGeometryKernel(fakeExactKernel({ info: OCC }).kernel);
    const once = deserializeDocument(v2());
    expect(deserializeDocument(envelope(3, once))).toEqual(once);
  });

  it('does not stamp when the active kernel cannot describe itself', () => {
    setGeometryKernel(fakeExactKernel({ info: null }).kernel);
    expect(deserializeDocument(v2()).kernelSettings).toBeUndefined();
  });
});

describe('save is a function of the document (no ambient-kernel stamp)', () => {
  const settingsOf = (text: string): unknown => (JSON.parse(text) as { document: { kernelSettings?: unknown } }).document.kernelSettings;

  it('writes the document kernelSettings as they are, under any installed kernel', () => {
    const tuned = execute(createEmptyDocument(), 'set_modeling_tolerance', { linear: 1e-5 }).document;
    for (const kernel of [
      fakeExactKernel({ info: OCC }).kernel,
      fakeExactKernel({ name: 'manifold', info: { capabilities: [] }, exact: false }).kernel,
    ]) {
      setGeometryKernel(kernel);
      expect(settingsOf(serializeDocument(createEmptyDocument()))).toBeUndefined();
      expect(settingsOf(serializeDocument(tuned))).toEqual(tuned.kernelSettings);
    }
  });
});

describe('blob integrity on load', () => {
  it('refuses bytes that do not hash to the key (KRN_BLOB_HASH_MISMATCH)', () => {
    const message = loadError(
      tampered((doc) => {
        const [sha, blob] = Object.entries(doc.blobs ?? {})[0] ?? ['', makeBlob('model/step', '')];
        return { ...doc, blobs: { [sha]: { ...blob, bytes: makeBlob('model/step', 'other bytes').bytes } } };
      }),
    );
    expect(message).toContain('KRN_BLOB_HASH_MISMATCH');
  });

  it('refuses a wrong key, a wrong size and undecodable bytes', () => {
    const wrongKey = loadError(
      tampered((doc) => {
        const blob = Object.values(doc.blobs ?? {})[0] ?? makeBlob('model/step', '');
        return { ...doc, blobs: { ['f'.repeat(64)]: blob } };
      }),
    );
    expect(wrongKey).toContain('KRN_BLOB_HASH_MISMATCH');
    const wrongSize = loadError(
      tampered((doc) => ({
        ...doc,
        blobs: Object.fromEntries(Object.entries(doc.blobs ?? {}).map(([k, b]) => [k, { ...b, size: b.size + 1 }])),
      })),
    );
    expect(wrongSize).toContain('KRN_BLOB_HASH_MISMATCH');
    const garbage = loadError(
      tampered((doc) => ({
        ...doc,
        blobs: Object.fromEntries(Object.entries(doc.blobs ?? {}).map(([k, b]) => [k, { ...b, bytes: '%%%' }])),
      })),
    );
    expect(garbage).toContain('KRN_BLOB_HASH_MISMATCH');
  });

  it('refuses a malformed blob and an unknown mediaType', () => {
    const unknown = loadError(
      tampered((doc) => ({
        ...doc,
        blobs: Object.fromEntries(Object.entries(doc.blobs ?? {}).map(([k, b]) => [k, { ...b, mediaType: 'text/plain' as never }])),
      })),
    );
    expect(unknown).toContain('is malformed');
    expect(loadError(tampered((doc) => ({ ...doc, blobs: { x: 3 as never } })))).toContain("blob 'x' is malformed");
    expect(loadError(tampered((doc) => ({ ...doc, blobs: [] as never })))).toContain('blobs must be an object');
  });

  it('refuses a brep leaf whose blob is absent (KRN_BLOB_MISSING), even nested in a boolean recipe', () => {
    const missing = loadError(tampered((doc) => ({ ...doc, blobs: {} })));
    expect(missing).toContain('KRN_BLOB_MISSING');
    expect(missing).toContain('mesh-1.1');
    const noBlobs = loadError(tampered(({ blobs: _blobs, ...doc }) => doc as CadDocument));
    expect(noBlobs).toContain('KRN_BLOB_MISSING');
  });

  it('refuses a recipe nested beyond the scan depth instead of skipping its blob check', () => {
    const message = loadError(
      tampered((doc) => {
        const [id, entity] = Object.entries(doc.entities)[0] ?? ['', doc.entities['']];
        let brep: unknown = { op: 'brep', blob: '0'.repeat(64), format: 'occt-brep-v1' };
        for (let level = 0; level < 1100; level++) brep = { op: 'scale', source: brep, factor: 1 };
        return { ...doc, entities: { [id]: { ...entity, brep } as never } };
      }),
    );
    expect(message).not.toBeNull();
    expect(message).toMatch(/nested deeper|brep recipe invalid|KRN_BLOB_MISSING/);
  });

  it('refuses a brep leaf that is not a lowercase sha256', () => {
    const message = loadError(
      tampered((doc) => {
        const [id, entity] = Object.entries(doc.entities)[0] ?? ['', doc.entities['']];
        return { ...doc, entities: { [id]: { ...entity, brep: { op: 'brep', blob: 'ABC', format: 'occt-brep-v1' } } as never } };
      }),
    );
    expect(message).toContain('brep recipe invalid');
  });

  it('through load_document the refusal is a no-op that names the code', () => {
    const doc = createEmptyDocument();
    const result = execute(doc, 'load_document', { json: tampered((d) => ({ ...d, blobs: {} })) });
    expect(result.document).toBe(doc);
    expect(result.summary).toContain('KRN_BLOB_MISSING');
  });
});

describe('kernelSettings validation on load', () => {
  it.each<[string, unknown]>([
    ['not an object', 3],
    ['unknown kernel', { kernel: 'parasolid', modelingTolerance: { linear: 1e-4, angular: 1e-9, maxImportTolerance: 0.01 } }],
    ['no tolerances', { kernel: 'occt' }],
    ['negative tolerance', { kernel: 'occt', modelingTolerance: { linear: -1, angular: 1e-9, maxImportTolerance: 0.01 } }],
    [
      'non-string version',
      { kernel: 'occt', occtVersion: 7, modelingTolerance: { linear: 1e-4, angular: 1e-9, maxImportTolerance: 0.01 } },
    ],
  ])('refuses %s', (_label, kernelSettings) => {
    expect(loadError(envelope(3, { ...createEmptyDocument(), kernelSettings }))).toContain('kernelSettings');
  });
});
