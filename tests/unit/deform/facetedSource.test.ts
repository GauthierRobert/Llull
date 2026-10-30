import { afterEach, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { type GeometryKernel, setGeometryKernel } from '@core/geometry/kernel';
import type { ShapeRecipe } from '@core/model/types';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { docWithMeshes, icosphere } from '../../helpers/meshFixtures';
import { addBox, installKernel, meshEntity, relative, volumeOf } from './harness';

afterEach(() => setGeometryKernel(null));

/** The stub exact kernel with every `evaluate` recorded: a mesh entity's solid leaf must never reach it (DES-7d, FR-DEF-08). */
async function spiedKernel(): Promise<{ evaluated: ShapeRecipe[] }> {
  const kernel = (await installKernel('exact')) as GeometryKernel;
  const evaluated: ShapeRecipe[] = [];
  setGeometryKernel({
    ...kernel,
    evaluate: (recipe) => {
      evaluated.push(recipe);
      return kernel.evaluate(recipe);
    },
  });
  return { evaluated };
}

const isMeshLeaf = (recipe: ShapeRecipe): boolean => recipe.op === 'solid' && recipe.entity.kind === 'mesh';

describe('a mesh entity without an exact construction is deformed on the mesh path, the kernel installed or not (DES-7d)', () => {
  it('scale_nonuniform and twist_body never hand the stored triangles to the kernel, and say "mesh path"', async () => {
    const { evaluated } = await spiedKernel();
    const { doc, ids } = docWithMeshes(icosphere(10, 3));
    const id = ids[0] as string;
    const scaled = execute(doc, 'scale_nonuniform', { id, factors: [2, 1, 0.5] });
    expect(scaled.summary).toContain('mesh path');
    expect(relative(volumeOf(scaled.document, scaled.affected[0] as string), volumeOf(doc, id))).toBeLessThan(1e-12);
    const twisted = execute(doc, 'twist_body', { id, angleDeg: 30 });
    expect(twisted.summary).toContain('mesh path');
    expect(twisted.summary).toContain('The source is a mesh without an exact construction');
    expect(evaluated.filter(isMeshLeaf)).toEqual([]);
    expectPure(doc, () => execute(doc, 'scale_nonuniform', { id, factors: [2, 1, 0.5] }));
  });

  it('mode "exact" refuses by name; a solid and a deformed mesh (it has a recipe) still take the exact path', async () => {
    const { evaluated } = await spiedKernel();
    const { doc, ids } = docWithMeshes(icosphere(10, 2));
    const id = ids[0] as string;
    const refused = execute(doc, 'scale_nonuniform', { id, factors: [2, 1, 1], output: { mode: 'exact' } });
    expectNoOp(refused, doc, 'DEF_EXACT_UNAVAILABLE');
    expect(refused.summary).toContain('without an exact construction');
    const box = addBox();
    const first = execute(box.doc, 'scale_nonuniform', { id: box.id, factors: [2, 1, 1] });
    expect(first.summary).toContain('exact path');
    const again = execute(first.document, 'scale_nonuniform', { id: first.affected[0] as string, factors: [1, 2, 1] });
    expect(again.summary).toContain('exact path');
    expect(meshEntity(again.document, again.affected[0] as string).brep).toMatchObject({ op: 'deform' });
    expect(evaluated.filter(isMeshLeaf)).toEqual([]);
  });
});
