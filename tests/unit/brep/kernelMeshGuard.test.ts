import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { guardedKernel, KERNEL_MESH_LEAF_CAP } from '@core/commands/kernelMeshGuard';
import { type GeometryKernel, setGeometryKernel } from '@core/geometry/kernel';
import { setMeshProcessingEngine } from '@core/geometry/mesh/engine';
import { meshLeafTriangles } from '@core/geometry/operandRecipe';
import type { CadDocument, ShapeRecipe } from '@core/model/types';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { createManifoldMeshEngine } from '@kernel-manifold/manifoldMeshEngine';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { docWithMeshes, icosphere } from '../../helpers/meshFixtures';
import { installKernel } from '../deform/harness';

/** Icosphere level 5: 20,480 triangles, just above the cap; level 2 (320) is far below it. */
const LARGE = 5;
const SMALL = 2;

beforeAll(async () => setMeshProcessingEngine(await createManifoldMeshEngine()));
afterAll(() => {
  setMeshProcessingEngine(null);
  setGeometryKernel(null);
});

/** The stub exact kernel (`occt`), every recipe that reaches it (evaluate, blendReport, deformReport) recorded with its scan size. */
async function spiedExactKernel(): Promise<{ reached: number[] }> {
  const kernel = (await installKernel('exact')) as GeometryKernel;
  const reached: number[] = [];
  setGeometryKernel({
    ...kernel,
    evaluate: (recipe: ShapeRecipe) => {
      reached.push(meshLeafTriangles(recipe));
      return kernel.evaluate(recipe);
    },
    blendReport: (recipe: ShapeRecipe) => {
      reached.push(meshLeafTriangles(recipe));
      return kernel.blendReport?.(recipe) ?? null;
    },
    deformReport: (recipe: ShapeRecipe) => {
      reached.push(meshLeafTriangles(recipe));
      return kernel.deformReport?.(recipe) ?? null;
    },
  });
  return { reached };
}

/** A scan of icosphere `level` and a box beside it, in one document. */
function scanAndBox(level: number): { doc: CadDocument; scan: string; box: string } {
  const { doc, ids } = docWithMeshes(icosphere(10, level));
  const added = execute(doc, 'add_box', { size: [8, 8, 8], position: [0, 0, 10] });
  return { doc: added.document, scan: ids[0] as string, box: added.affected[0] as string };
}

describe('the exact kernel is never asked to rebuild a large imported mesh (DES-7e)', () => {
  it('meshLeafTriangles counts every imported-mesh leaf of a recipe, nothing else', () => {
    const { doc, scan, box } = scanAndBox(SMALL);
    const mesh = { op: 'solid', entity: doc.entities[scan] } as ShapeRecipe;
    const solid = { op: 'solid', entity: doc.entities[box] } as ShapeRecipe;
    expect(meshLeafTriangles(mesh)).toBe(320);
    expect(meshLeafTriangles(solid)).toBe(0);
    expect(
      meshLeafTriangles({ op: 'boolean', boolean: 'union', a: mesh, b: { op: 'place', source: mesh } } as unknown as ShapeRecipe),
    ).toBe(640);
    expect(meshLeafTriangles({ op: 'blend', sources: [solid, mesh] } as unknown as ShapeRecipe)).toBe(320);
  });

  it('boolean engine "kernel" over a large scan: the kernel never sees it, nothing changes, and the summary names the cap', async () => {
    const { reached } = await spiedExactKernel();
    const { doc, scan, box } = scanAndBox(LARGE);
    const refused = execute(doc, 'boolean', { op: 'subtract', a: box, b: scan, engine: 'kernel' });
    expect(refused.document).toBe(doc);
    expect(refused.summary).toContain(`above ${KERNEL_MESH_LEAF_CAP}`);
    expect(reached.filter((triangles) => triangles > KERNEL_MESH_LEAF_CAP)).toEqual([]);
    expectPure(doc, () => execute(doc, 'boolean', { op: 'subtract', a: box, b: scan, engine: 'kernel' }));
  });

  it('boolean engine "auto" with a large scan operand runs the mesh engine and says why; a small one still goes to the kernel', async () => {
    const { reached } = await spiedExactKernel();
    const large = scanAndBox(LARGE);
    const merged = execute(large.doc, 'boolean', { op: 'subtract', a: large.box, b: large.scan });
    expect(merged.affected).toHaveLength(1);
    expect(merged.summary).toContain(`built on 20480 imported-mesh triangles ('${large.scan}' 20480)`);
    expect(reached).toEqual([]);
    const small = scanAndBox(SMALL);
    const exact = execute(small.doc, 'boolean', { op: 'subtract', a: small.box, b: small.scan });
    expect(exact.summary).not.toContain('imported-mesh triangles');
    expect(reached.length).toBeGreaterThan(0);
  });

  it('a mesh-path deform result counts as triangles: boolean "auto" of two of them runs the mesh engine', async () => {
    const { reached } = await spiedExactKernel();
    const { doc, ids } = docWithMeshes(icosphere(10, SMALL), icosphere(10, SMALL));
    const first = execute(doc, 'scale_nonuniform', { id: ids[0] as string, factors: [1.5, 1, 1] });
    const second = execute(first.document, 'twist_body', { id: ids[1] as string, angleDeg: 10 });
    const union = execute(second.document, 'boolean', { op: 'union', a: first.affected[0] as string, b: second.affected[0] as string });
    expect(union.affected).toHaveLength(1);
    expect(reached.filter((triangles) => triangles > 0)).toEqual([]);
  });

  it('the guard leaves a mesh kernel alone: Manifold builds a large scan recipe itself', async () => {
    setGeometryKernel(await createManifoldKernel());
    const { doc, scan, box } = scanAndBox(LARGE);
    const merged = execute(doc, 'boolean', { op: 'union', a: box, b: scan, engine: 'kernel' });
    expect(merged.affected).toHaveLength(1);
    expect(merged.summary).not.toContain('was not asked to rebuild');
  });

  it('an exact feature command on a large scan is refused by name instead of sewing it', async () => {
    const { reached } = await spiedExactKernel();
    const { doc, scan } = scanAndBox(LARGE);
    const result = execute(doc, 'inspect_topology', { id: scan });
    expect(result.summary).toContain('was not asked to rebuild 20480 triangles');
    expect(reached).toEqual([]);
    expectNoOp(execute(doc, 'boolean', { op: 'subtract', a: scan, b: scan, engine: 'kernel' }), doc);
  });

  it('blend_union over a large scan: neither the build nor the explanation (blendReport) reaches the kernel', async () => {
    const { reached } = await spiedExactKernel();
    const { doc, scan, box } = scanAndBox(LARGE);
    const blended = execute(doc, 'blend_union', { ids: [box, scan], radius: 1 });
    expect(blended.document).toBe(doc);
    expect(blended.summary).toContain('was not asked to rebuild 20480 triangles');
    expect(reached.filter((triangles) => triangles > KERNEL_MESH_LEAF_CAP)).toEqual([]);
  });

  it('boolean "auto" counts the operands together: five scans each under the cap, above it in total, run the mesh engine', async () => {
    const { reached } = await spiedExactKernel();
    const { doc, ids } = docWithMeshes(...Array.from({ length: 5 }, (_, k) => icosphere(4, 4, [k * 3, 0, 0])));
    const added = execute(doc, 'add_box', { size: [4, 4, 4], position: [6, 0, 0] });
    const box = added.affected[0] as string;
    const merged = execute(added.document, 'boolean', { op: 'union', a: box, b: ids });
    expect(merged.affected).toHaveLength(1);
    expect(merged.summary).toContain('built on 25600 imported-mesh triangles');
    expect(reached).toEqual([]);
  });

  it('the note is written once, on the outermost summary, and the next execute starts clean', async () => {
    await spiedExactKernel();
    const { doc, scan, box } = scanAndBox(LARGE);
    const plan = [{ command: 'boolean', params: { op: 'subtract', a: box, b: scan, engine: 'kernel' } }];
    const nested = execute(doc, 'build_project', { actions: plan });
    expect(nested.summary.split('was not asked to rebuild')).toHaveLength(2);
    const clean = execute(doc, 'add_box', { size: [1, 1, 1] });
    expect(clean.summary).not.toContain('was not asked to rebuild');
  });

  it('the view names its own refusal (lastRefusal), and hands back the kernel reason after a recipe it let through', async () => {
    const kernel = (await installKernel('exact')) as GeometryKernel;
    const view = guardedKernel({ ...kernel, lastRefusal: () => 'OCC_FAILURE: from the kernel' });
    const { doc, scan } = scanAndBox(LARGE);
    const recipe = { op: 'solid', entity: doc.entities[scan] } as ShapeRecipe;
    expect(view.evaluate(recipe)).toBeNull();
    expect(view.lastRefusal?.()).toContain(`above ${KERNEL_MESH_LEAF_CAP}`);
    const small = scanAndBox(SMALL);
    view.evaluate({ op: 'solid', entity: small.doc.entities[small.scan] } as ShapeRecipe);
    expect(view.lastRefusal?.()).toBe('OCC_FAILURE: from the kernel');
  });
});
