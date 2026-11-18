import { describe, it, expect, vi, afterEach } from 'vitest';
import { DEFAULT_LAYER_ID, createEmptyDocument, type CadDocument, type Entity, type ShapeRecipe } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { makeBlob, withBlob } from '@core/model/blobs';
import { documentHash } from '@protocol/liveSync';

afterEach(() => vi.restoreAllMocks());

/** Total characters JSON.stringify produces while `work` runs: a proxy for how much of the document was re-serialized. */
function serializedChars(work: () => void): number {
  const real = JSON.stringify;
  let total = 0;
  vi.spyOn(JSON, 'stringify').mockImplementation(((...args: Parameters<typeof JSON.stringify>) => {
    const out = real(...args);
    total += out?.length ?? 0;
    return out;
  }) as typeof JSON.stringify);
  work();
  return total;
}

const reparse = (doc: CadDocument): CadDocument => JSON.parse(JSON.stringify(doc)) as CadDocument;

describe('documentHash is incremental over top-level fields', () => {
  const blobText = 'x'.repeat(2_000_000);
  const blob = makeBlob('model/x-occt-brep', blobText);
  const base = withBlob(execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document, blob);

  it('does not re-serialize an unchanged multi-MB blob after the next command', () => {
    documentHash(base);
    const next = execute(base, 'add_sphere', { radius: 1 }).document;
    expect(next.blobs).toBe(base.blobs);
    expect(serializedChars(() => documentHash(next))).toBeLessThan(50_000);
  });

  it('adding a second blob does not re-serialize the first', () => {
    documentHash(base);
    const second = makeBlob('model/step', 'ISO-10303-21;');
    const next = withBlob(base, second);
    expect(serializedChars(() => documentHash(next))).toBeLessThan(50_000);
  });

  it('equals the hash of a re-parsed copy and still detects blob changes', () => {
    const copy = reparse(base);
    expect(copy.blobs?.[blob.sha256]).not.toBe(base.blobs?.[blob.sha256]);
    expect(documentHash(copy)).toBe(documentHash(base));
    const tampered = { ...base, blobs: { [blob.sha256]: { ...blob, bytes: blob.bytes.slice(0, -4) + 'AAAA' } } };
    expect(documentHash(tampered)).not.toBe(documentHash(base));
    expect(documentHash({ ...base, blobs: {} })).not.toBe(documentHash(base));
  });

  it('is independent of top-level key order and of selection, and changes with any other field', () => {
    const shuffled = Object.fromEntries(Object.entries(base).reverse()) as unknown as CadDocument;
    expect(documentHash(shuffled)).toBe(documentHash(base));
    expect(documentHash({ ...base, selection: base.order })).toBe(documentHash(base));
    expect(documentHash({ ...base, displayPrecision: base.displayPrecision + 1 })).not.toBe(documentHash(base));
  });

  it('ignores the verified:false flag of analysis summaries like before', () => {
    const analysis = { ...createEmptyDocument().analysis } as NonNullable<CadDocument['analysis']>;
    const flagged = {
      ...base,
      analysis: { ...analysis, cases: { c: { meshSummary: { verified: false, a: 1 } } } },
    } as unknown as CadDocument;
    const unflagged = { ...flagged, analysis: { ...analysis, cases: { c: { meshSummary: { a: 1 } } } } } as unknown as CadDocument;
    expect(documentHash(flagged)).toBe(documentHash(unflagged));
  });
});

describe('documentHash memoizes shared recipe subtrees', () => {
  function chain(length: number): ShapeRecipe {
    let recipe: ShapeRecipe = { op: 'brep', blob: 'b0', format: 'occt-brep-v1' };
    for (let i = 0; i < length; i++)
      recipe = {
        op: 'boolean',
        boolean: 'subtract',
        a: recipe,
        b: { op: 'scale', source: { op: 'brep', blob: `t${i}`, format: 'occt-brep-v1' }, factor: 1 },
      };
    return recipe;
  }
  const meshEntity = (brep: ShapeRecipe): Entity =>
    ({ kind: 'mesh', mesh: { positions: [0, 0, 0], indices: [] }, brep, position: [0, 0, 0] }) as unknown as Entity;
  const docWith = (brep: ShapeRecipe, id = 'm'): CadDocument => ({
    ...createEmptyDocument(),
    entities: { [id]: meshEntity(brep) },
    order: [id],
  });

  it('a chain link costs O(1) serialization once its operand was hashed', () => {
    const deep = chain(800);
    documentHash(docWith(deep));
    const longer: ShapeRecipe = { op: 'boolean', boolean: 'union', a: deep, b: { op: 'brep', blob: 'z', format: 'occt-brep-v1' } };
    const full = JSON.stringify(docWith(longer)).length;
    expect(serializedChars(() => documentHash(docWith(longer, 'n')))).toBeLessThan(full / 20);
  });

  it('equals the hash of a re-parsed copy and changes when a deep node changes', () => {
    const doc = docWith(chain(20));
    expect(documentHash(reparse(doc))).toBe(documentHash(doc));
    const other = docWith(chain(20));
    const brep = (other.entities['m'] as unknown as { brep: { a: { b: { factor: number } } } }).brep;
    brep.a.b.factor = 2;
    expect(documentHash(other)).not.toBe(documentHash(doc));
  });
});

describe('documentHash folds long numeric arrays instead of printing them (PERF1)', () => {
  const positions = Array.from({ length: 900_000 }, (_, index) => Math.sin(index) * 100);
  const indices = Array.from({ length: 300_000 }, (_, index) => index);
  const withMesh = (mesh: { positions: number[]; indices: number[] }, name = 'scan'): CadDocument => {
    const base = createEmptyDocument();
    const entity = { id: 'mesh-1', kind: 'mesh', name, position: [0, 0, 0], rotation: [0, 0, 0], layerId: DEFAULT_LAYER_ID, mesh };
    return { ...base, entities: { 'mesh-1': entity as unknown as Entity }, order: ['mesh-1'] };
  };
  const doc = withMesh({ positions, indices });

  it('hashes a 300k-triangle mesh entity without serializing its numbers', () => {
    expect(serializedChars(() => documentHash(doc))).toBeLessThan(50_000);
  });

  it('equals the hash of a re-parsed copy, -0 included, and detects one changed coordinate, a swap and a different length', () => {
    const signed = withMesh({ positions: [-0, ...positions.slice(1)], indices });
    expect(documentHash(reparse(doc))).toBe(documentHash(doc));
    expect(documentHash(reparse(signed))).toBe(documentHash(signed));
    const moved = [...positions];
    moved[450_000] = (moved[450_000] ?? 0) + 1e-9;
    expect(documentHash(withMesh({ positions: moved, indices }))).not.toBe(documentHash(doc));
    const swapped = [...positions];
    [swapped[10], swapped[11]] = [swapped[11] ?? 0, swapped[10] ?? 0];
    expect(documentHash(withMesh({ positions: swapped, indices }))).not.toBe(documentHash(doc));
    expect(documentHash(withMesh({ positions: positions.slice(0, -3), indices }))).not.toBe(documentHash(doc));
    expect(documentHash(withMesh({ positions: indices, indices: positions }))).not.toBe(documentHash(doc));
  });

  it('writes an array holding a non-finite number or a non-number as text, like before', () => {
    const odd = withMesh({ positions: [Number.NaN, ...positions.slice(1, 200)], indices: indices.slice(0, 90) });
    expect(documentHash(reparse(odd))).toBe(documentHash(odd));
    expect(documentHash(odd)).not.toBe(
      documentHash(withMesh({ positions: [0, ...positions.slice(1, 200)], indices: indices.slice(0, 90) })),
    );
  });

  it('renaming the entity costs nothing for its arrays: their fold is remembered by identity', () => {
    documentHash(doc);
    const renamed = withMesh({ positions, indices }, 'renamed');
    const started = performance.now();
    expect(documentHash(renamed)).not.toBe(documentHash(doc));
    expect(performance.now() - started).toBeLessThan(20);
  });
});
