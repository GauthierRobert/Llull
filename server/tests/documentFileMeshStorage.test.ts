/** readDocumentFile / writeDocumentFile with `meshStorage: 'recipe'`: the file omits kernel-result triangles, the host kernel rebuilds them. */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import { setGeometryKernel, type GeometryKernel } from '@core/geometry/kernel';
import { createEmptyDocument, type MeshSolidEntity } from '@core/model/types';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { readDocumentFile, writeDocumentFile } from '../src/documentFile';
import '../src/plugins';

let kernel: GeometryKernel;
beforeAll(async () => {
  kernel = await createManifoldKernel();
});
afterEach(() => setGeometryKernel(null));

describe('document file in recipe mesh storage', () => {
  it('rebuilds the omitted triangles with the installed kernel and refuses without one', () => {
    const ctx = { ...defaultContext(), kernel };
    const a = execute(createEmptyDocument(), 'add_box', { size: [10, 10, 10] }, ctx);
    const b = execute(a.document, 'add_box', { size: [4, 4, 4], position: [5, 0, 0] }, ctx);
    const cut = execute(b.document, 'boolean', { op: 'subtract', a: a.affected[0]!, b: b.affected[0]! }, ctx);
    const doc = execute(cut.document, 'set_mesh_storage', { mode: 'recipe' }, ctx).document;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llull-mesh-storage-'));
    const file = path.join(dir, 'part.llull');
    try {
      setGeometryKernel(kernel);
      writeDocumentFile(file, doc);
      expect(fs.readFileSync(file, 'utf8')).toContain('"derivedMeshes"');
      const id = cut.affected[0]!;
      expect((readDocumentFile(file).entities[id] as MeshSolidEntity).mesh.indices.length).toBeGreaterThan(0);
      setGeometryKernel(null);
      expect(() => readDocumentFile(file)).toThrow(/KRN_DERIVED_MESH_NO_KERNEL/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
