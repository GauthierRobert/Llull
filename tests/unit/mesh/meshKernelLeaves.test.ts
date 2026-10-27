/**
 * TECHNICAL_SPEC 13.11: a kernel command reads the stored mesh of an asset-backed operand, but its result never keeps that mesh inline in
 * the construction tree (`brep`): the leaf holds the display mesh and the asset reference, and the next command that evaluates the tree
 * is handed the stored mesh again. Replay re-runs the commands, so it gets the same result.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { serializeDocument } from '@core/commands/persistence/serialization';
import type { ExecutionContext } from '@core/commands/types';
import type { GeometryKernel } from '@core/geometry/kernel';
import { assetLeaves } from '@core/geometry/recipeLeaves';
import type { ShapeRecipe } from '@core/model/types';
import { type CadDocument, createEmptyDocument, type MeshData, type MeshSolidEntity } from '@core/model/types';
import { icosphere } from '../../helpers/meshFixtures';
import { memoryMeshAssets } from '../../helpers/memoryMeshAssets';
import { defaultContext } from '@core/commands/context';
import { fakeKernel, TETRA } from '../../helpers/fakeKernel';
import { scene } from '../../helpers/assetScene';

const sphere = icosphere(10, 3); // 1280 stored triangles, 12 in the display cube

function fixture(): { doc: CadDocument; ctx: ExecutionContext; evaluated: ShapeRecipe[]; display: MeshData } {
  const { doc, ctx } = scene([{ id: 'scan', fullMesh: sphere, claimed: 1280 }]);
  const box = execute(doc, 'add_box', { size: [1, 1, 1] });
  const base = fakeKernel({ solid: TETRA, boolean: TETRA, shell: TETRA });
  const evaluated: ShapeRecipe[] = [];
  const kernel: GeometryKernel = {
    ...base,
    evaluate: (recipe) => {
      evaluated.push(recipe);
      return base.evaluate(recipe);
    },
  };
  return { doc: box.document, ctx: { ...ctx, kernel }, evaluated, display: (doc.entities['scan'] as MeshSolidEntity).mesh };
}

/** The stored meshes that a kernel evaluation was handed as leaves. */
const leafMeshes = (recipes: readonly ShapeRecipe[]): MeshData[] =>
  recipes.flatMap((recipe) => assetLeaves(recipe).map((leaf) => leaf.mesh));

describe('a kernel result built from an asset-backed mesh', () => {
  it('shell_solid: the kernel is handed the stored mesh; the result keeps the display mesh and the asset in its tree', () => {
    const { doc, ctx, evaluated, display } = fixture();
    const result = execute(doc, 'shell_solid', { id: 'scan', thickness: 0.2 }, ctx);
    expect(result.rejected, result.summary).toBeUndefined();
    expect(leafMeshes(evaluated)).toContain(sphere);
    const shelled = result.document.entities[result.affected[0] as string] as MeshSolidEntity;
    const leaves = assetLeaves(shelled.brep as ShapeRecipe);
    expect(leaves).toHaveLength(1);
    expect(leaves[0]?.mesh).toBe(display);
    expect(leaves[0]?.asset.triangles).toBe(1280);
    expect(JSON.stringify(serializeDocument(result.document)).length).toBeLessThan(JSON.stringify(sphere).length);
  });

  it('boolean: the same, and a later command on the result is handed the stored mesh again (regeneration)', () => {
    const { doc, ctx, evaluated, display } = fixture();
    const toolId = doc.order.find((id) => id !== 'scan') as string;
    const first = execute(doc, 'boolean', { op: 'subtract', a: 'scan', b: toolId, engine: 'kernel' }, ctx);
    expect(first.rejected, first.summary).toBeUndefined();
    expect(leafMeshes(evaluated)).toContain(sphere);
    const resultId = first.affected[0] as string;
    const kept = first.document.entities[resultId] as MeshSolidEntity;
    expect(assetLeaves(kept.brep as ShapeRecipe).map((leaf) => leaf.mesh)).toEqual([display]);
    evaluated.length = 0;
    const second = execute(first.document, 'shell_solid', { id: resultId, thickness: 0.2 }, ctx);
    expect(second.rejected, second.summary).toBeUndefined();
    expect(leafMeshes(evaluated)).toContain(sphere);
    const again = second.document.entities[second.affected[0] as string] as MeshSolidEntity;
    expect(assetLeaves(again.brep as ShapeRecipe).map((leaf) => leaf.mesh)).toEqual([display]);
  });

  it('a 327,680-triangle import: the result stays small and replay_history gives the same document', () => {
    const assets = memoryMeshAssets();
    const base = fakeKernel({ solid: TETRA, boolean: TETRA });
    const ctx: ExecutionContext = { ...defaultContext(), meshAssets: assets, kernel: base };
    const scan = icosphere(10, 7);
    const triangles = scan.indices.length / 3;
    const bytes = new Uint8Array(84 + triangles * 50);
    const view = new DataView(bytes.buffer);
    view.setUint32(80, triangles, true);
    for (let t = 0; t < triangles; t++)
      for (let k = 0; k < 3; k++)
        for (let a = 0; a < 3; a++)
          view.setFloat32(84 + t * 50 + 12 + k * 12 + a * 4, scan.positions[(scan.indices[t * 3 + k] as number) * 3 + a] as number, true);
    const imported = execute(createEmptyDocument(), 'import_mesh_file', { fileKey: assets.putFile(bytes), units: 'mm', name: 'scan' }, ctx);
    const scanId = imported.affected[0] as string;
    const tool = execute(imported.document, 'add_box', { size: [1, 1, 1] }, ctx);
    const cut = execute(tool.document, 'boolean', { op: 'subtract', a: scanId, b: tool.affected[0] as string, engine: 'kernel' }, ctx);
    expect(cut.rejected, cut.summary).toBeUndefined();
    const result = cut.document.entities[cut.affected[0] as string] as MeshSolidEntity;
    const leaf = assetLeaves(result.brep as ShapeRecipe)[0];
    expect(leaf?.mesh).toBe((imported.document.entities[scanId] as MeshSolidEntity).mesh);
    expect(serializeDocument(cut.document).length).toBeLessThan(4_000_000);
    const replayed = execute(cut.document, 'replay_history', {}, ctx);
    expect(replayed.error).toBeUndefined();
    expect(replayed.document.entities).toEqual(cut.document.entities);
  });
});
