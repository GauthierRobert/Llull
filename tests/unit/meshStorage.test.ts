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
    expect(() => deserializeDocument(JSON.stringify(broken), { kernel: manifold })).toThrow(/KRN_DERIVED_MESH_UNBUILT.*mesh-/);
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
