/** Kernel-result meshes as a derived cache: set_mesh_storage + llull-document v4 `derivedMeshes` (roadmap v0.5 constructive vs evaluated). */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { setGeometryKernel, type GeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type CadDocument, type MeshSolidEntity } from '@core/model/types';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { fakeKernel } from '../helpers/fakeKernel';
import { expectNoOp, expectPure } from '../helpers/expectNoOp';

let manifold: GeometryKernel;
beforeAll(async () => {
  manifold = await createManifoldKernel();
});
afterEach(() => setGeometryKernel(null));

function drilledBlock(): { doc: CadDocument; id: string } {
  const ctx = { ...defaultContext(), kernel: manifold };
  let doc = createEmptyDocument();
  doc = execute(doc, 'add_box', { size: [20, 20, 20] }, ctx).document;
  const a = Object.keys(doc.entities)[0]!;
  const cyl = execute(doc, 'add_cylinder', { radius: 4, height: 30, position: [0, 0, 0] }, ctx);
  const b = cyl.affected[0]!;
  const cut = execute(cyl.document, 'boolean', { op: 'subtract', a, b }, ctx);
  expect(cut.affected).toHaveLength(1);
  return { doc: cut.document, id: cut.affected[0]! };
}

const meshOf = (doc: CadDocument, id: string): MeshSolidEntity => doc.entities[id] as MeshSolidEntity;
const recipeDoc = (): { doc: CadDocument; id: string } => {
  const { doc, id } = drilledBlock();
  return { doc: execute(doc, 'set_mesh_storage', { mode: 'recipe' }, { ...defaultContext(), kernel: manifold }).document, id };
};

describe('set_mesh_storage', () => {
  it('sets recipe mode and states how many meshes the file will omit', () => {
    const { doc } = drilledBlock();
    const result = execute(doc, 'set_mesh_storage', { mode: 'recipe' });
    expect(result.document.kernelSettings?.meshStorage).toBe('recipe');
    expect(result.affected).toEqual([]);
    expect(result.summary).toContain('omit the triangles of 1 kernel-result mesh');
    expectPure(doc, () => execute(doc, 'set_mesh_storage', { mode: 'recipe' }));
  });

  it('is a no-op when the mode already holds, and rejects an unknown mode', () => {
    const doc = createEmptyDocument();
    expectNoOp(execute(doc, 'set_mesh_storage', { mode: 'full' }), doc, 'already');
    expect(execute(doc, 'set_mesh_storage', { mode: 'sparse' }).affected).toEqual([]);
  });
});

describe('recipe mesh storage round trip', () => {
  it('shrinks the file, writes v4 derivedMeshes and re-derives an equal-triangle mesh on load', () => {
    const { doc: full } = drilledBlock();
    const { doc, id } = recipeDoc();
    setGeometryKernel(manifold);
    const text = serializeDocument(doc);
    const written = JSON.parse(text) as { version: number; derivedMeshes: Record<string, { triangles: number; sha256: string }> };
    expect(written.version).toBe(4);
    expect(written.derivedMeshes[id]?.triangles).toBe(meshOf(doc, id).mesh.indices.length / 3);
    expect(written.derivedMeshes[id]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(text.length).toBeLessThan(serializeDocument(full).length);
    expect(serializeDocument(doc)).toBe(text);
    const loaded = deserializeDocument(text, { kernel: manifold });
    expect(meshOf(loaded, id).mesh.indices.length).toBe(meshOf(doc, id).mesh.indices.length);
    expect(meshOf(loaded, id).brep).toEqual(meshOf(doc, id).brep);
    const viaCommand = execute(createEmptyDocument(), 'load_document', { json: text }, { ...defaultContext(), kernel: manifold });
    expect(meshOf(viaCommand.document, id).mesh.indices.length).toBeGreaterThan(0);
  });

  it('keeps full meshes for includeDerived and full mode byte-for-byte (version 3, no derivedMeshes)', () => {
    const { doc, id } = recipeDoc();
    const withDerived = JSON.parse(serializeDocument(doc, { includeDerived: true })) as { version: number; derivedMeshes?: unknown };
    expect(withDerived.version).toBe(3);
    expect(withDerived.derivedMeshes).toBeUndefined();
    const fullDoc = { ...doc, kernelSettings: { ...doc.kernelSettings!, meshStorage: 'full' as const } };
    expect(JSON.parse(serializeDocument(fullDoc)).document.entities[id].mesh.indices.length).toBeGreaterThan(0);
    const plain = drilledBlock().doc;
    expect(JSON.parse(serializeDocument(plain)).version).toBe(3);
  });

  it('refuses to load without a kernel (KRN_DERIVED_MESH_NO_KERNEL) and load_document no-ops', () => {
    const { doc } = recipeDoc();
    const text = serializeDocument(doc);
    expect(() => deserializeDocument(text)).toThrow(/KRN_DERIVED_MESH_NO_KERNEL.*1 kernel-result mesh/);
    const target = createEmptyDocument();
    expectNoOp(execute(target, 'load_document', { json: text }), target, 'KRN_DERIVED_MESH_NO_KERNEL');
  });

  it('refuses a kernel that cannot rebuild a recipe (KRN_DERIVED_MESH_UNBUILT) and a malformed table', () => {
    const { doc, id } = recipeDoc();
    const text = serializeDocument(doc);
    expect(() => deserializeDocument(text, { kernel: fakeKernel({ solid: null }) })).toThrow(/KRN_DERIVED_MESH_UNBUILT.*occt-native/);
    const broken = JSON.parse(text) as { document: { entities: Record<string, { brep?: unknown }> } };
    delete broken.document.entities[id]!.brep;
    expect(() => deserializeDocument(JSON.stringify(broken), { kernel: manifold })).toThrow(/KRN_DERIVED_MESH_INVALID.*mesh-/);
    expect(() => deserializeDocument(JSON.stringify({ ...JSON.parse(text), derivedMeshes: 5 }), { kernel: manifold })).toThrow(
      /derivedMeshes/,
    );
  });

  it('rejects a bad kernelSettings.meshStorage on load', () => {
    const { doc } = drilledBlock();
    const bad = {
      ...doc,
      kernelSettings: {
        ...(doc.kernelSettings ?? { kernel: 'manifold', modelingTolerance: { linear: 1e-4, angular: 1e-9, maxImportTolerance: 0.01 } }),
        meshStorage: 'sparse',
      },
    };
    expect(() => deserializeDocument(JSON.stringify({ format: 'llull-document', version: 3, document: bad }))).toThrow(/meshStorage/);
  });
});

type Envelope = {
  format: string;
  version: number;
  document: CadDocument;
  derivedMeshes?: Record<string, { triangles: number; sha256: string }>;
};
const envelopeOf = (text: string): Envelope => JSON.parse(text) as Envelope;
const contentHash = (doc: CadDocument): unknown => execute(doc, 'document_content_hash', {}).data;

describe('recipe mesh storage hardening (review)', () => {
  it('reloads identical triangles and the same document content hash', () => {
    const { doc, id } = recipeDoc();
    const loaded = deserializeDocument(serializeDocument(doc), { kernel: manifold });
    expect(meshOf(loaded, id).mesh).toEqual(meshOf(doc, id).mesh);
    expect(contentHash(loaded)).toEqual(contentHash(doc));
  });

  it('keeps the triangles of a recipe with an imported exact leaf ({ op: brep }) stored', () => {
    const { doc, id } = recipeDoc();
    const leaf = { op: 'brep', blob: 'a'.repeat(64) } as unknown as MeshSolidEntity['brep'];
    const imported = { ...doc, entities: { ...doc.entities, [id]: { ...meshOf(doc, id), brep: leaf } } } as CadDocument;
    const written = envelopeOf(serializeDocument(imported));
    expect(written.version).toBe(3);
    expect(written.derivedMeshes).toBeUndefined();
    expect((written.document.entities[id] as MeshSolidEntity).mesh.indices.length).toBeGreaterThan(0);
    expect(execute(imported, 'set_mesh_storage', { mode: 'full' }).summary).toContain('keep every');
  });

  it('keepKernelMeshes writes full meshes (recovery, autosave, vault)', () => {
    const { doc, id } = recipeDoc();
    const written = envelopeOf(serializeDocument(doc, { keepKernelMeshes: true }));
    expect(written.version).toBe(3);
    expect((written.document.entities[id] as MeshSolidEntity).mesh.indices.length).toBeGreaterThan(0);
    expect(deserializeDocument(JSON.stringify(written)).entities[id]).toEqual(doc.entities[id]);
  });

  it('never hands a hostile listed entity to the kernel (KRN_DERIVED_MESH_INVALID)', () => {
    const { doc, id } = recipeDoc();
    const text = serializeDocument(doc);
    let evaluated = 0;
    const counting: GeometryKernel = { ...manifold, evaluate: (recipe) => ((evaluated += 1), manifold.evaluate(recipe)) };
    const record = envelopeOf(text).derivedMeshes![id]!;
    const variants: Array<(envelope: Envelope) => void> = [
      (e) => (e.derivedMeshes = { __proto__x: record, ...e.derivedMeshes, missing: record }),
      (e) => (e.derivedMeshes = { [Object.keys(e.document.entities).find((key) => key !== id) ?? 'x']: record }),
      (e) => ((e.document.entities[id] as unknown as { brep: unknown }).brep = { op: 'boolean', kind: 'xor', a: null, b: null }),
      (e) => ((e.document.entities[id] as unknown as { brep: unknown }).brep = { op: 'brep', blob: 'b'.repeat(64) }),
    ];
    for (const mutate of variants) {
      const envelope = envelopeOf(text);
      mutate(envelope);
      expect(() => deserializeDocument(JSON.stringify(envelope), { kernel: counting })).toThrow(/KRN_DERIVED_MESH_INVALID/);
    }
    const proto = envelopeOf(text);
    proto.derivedMeshes = JSON.parse(`{"__proto__": ${JSON.stringify(record)}}`) as NonNullable<Envelope['derivedMeshes']>;
    expect(() => deserializeDocument(JSON.stringify(proto), { kernel: counting })).toThrow(/KRN_DERIVED_MESH_INVALID/);
    expect(evaluated).toBe(0);
  });

  it('refuses rebuilt triangles that differ from the saved ones unless drift is accepted', () => {
    const { doc, id } = recipeDoc();
    const envelope = envelopeOf(serializeDocument(doc));
    envelope.derivedMeshes![id] = { ...envelope.derivedMeshes![id]!, sha256: '0'.repeat(64) };
    const text = JSON.stringify(envelope);
    expect(() => deserializeDocument(text, { kernel: manifold })).toThrow(/KRN_DERIVED_MESH_DRIFT.*acceptMeshDrift/);
    expect(meshOf(deserializeDocument(text, { kernel: manifold, acceptMeshDrift: true }), id).mesh).toEqual(meshOf(doc, id).mesh);
    const ctx = { ...defaultContext(), kernel: manifold };
    const target = createEmptyDocument();
    expectNoOp(execute(target, 'load_document', { json: text }, ctx), target, 'KRN_DERIVED_MESH_DRIFT');
    expect(
      meshOf(execute(target, 'load_document', { json: text, acceptMeshDrift: true }, ctx).document, id).mesh.indices.length,
    ).toBeGreaterThan(0);
  });

  it('honours derivedMeshes only in a version 4 envelope, and requires it there', () => {
    const { doc } = recipeDoc();
    const envelope = envelopeOf(serializeDocument(doc));
    expect(() => deserializeDocument(JSON.stringify({ ...envelope, version: 3 }), { kernel: manifold })).toThrow(
      /only valid in a version 4/,
    );
    const { derivedMeshes: _table, ...bare } = envelope;
    expect(() => deserializeDocument(JSON.stringify(bare), { kernel: manifold })).toThrow(/version 4 file needs derivedMeshes/);
  });
});
