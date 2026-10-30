import { afterEach, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { type GeometryKernel, setGeometryKernel } from '@core/geometry/kernel';
import { hasMeshLeaf } from '@core/geometry/operandRecipe';
import type { Entity, ShapeRecipe } from '@core/model/types';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { docWithMeshes, icosphere } from '../../helpers/meshFixtures';
import { addBox, installKernel, meshEntity, relative, volumeOf } from './harness';

afterEach(() => setGeometryKernel(null));

/**
 * The stub exact kernel with every `evaluate` recorded (and a face query, so face targets reach their checks): a recipe over a scan's triangles must
 * never reach it (DES-7d, FR-DEF-08), however deep the mesh leaf sits.
 */
async function spiedKernel(): Promise<{ evaluated: ShapeRecipe[] }> {
  const kernel = (await installKernel('exact')) as GeometryKernel;
  const evaluated: ShapeRecipe[] = [];
  setGeometryKernel({
    ...kernel,
    faceQuery: kernel.faceQuery ?? ({ projectOnFace: () => null } as unknown as NonNullable<GeometryKernel['faceQuery']>),
    evaluate: (recipe) => {
      evaluated.push(recipe);
      return kernel.evaluate(recipe);
    },
  });
  return { evaluated };
}

const scan = (level: number): { doc: ReturnType<typeof docWithMeshes>['doc']; id: string } => {
  const { doc, ids } = docWithMeshes(icosphere(10, level));
  return { doc, id: ids[0] as string };
};

describe('hasMeshLeaf', () => {
  const box = { op: 'solid', entity: { kind: 'box' } as Entity } as ShapeRecipe;
  const mesh = { op: 'solid', entity: { kind: 'mesh' } as Entity } as ShapeRecipe;
  it('finds the stored triangles of a mesh entity at any depth, and nothing else', () => {
    expect(hasMeshLeaf(mesh)).toBe(true);
    expect(hasMeshLeaf(box)).toBe(false);
    expect(hasMeshLeaf({ op: 'boolean', kind: 'union', a: box, b: mesh } as unknown as ShapeRecipe)).toBe(true);
    expect(hasMeshLeaf({ op: 'boolean', kind: 'union', a: box, b: box } as unknown as ShapeRecipe)).toBe(false);
    expect(hasMeshLeaf({ op: 'blend', sources: [box, mesh] } as unknown as ShapeRecipe)).toBe(true);
    expect(hasMeshLeaf({ op: 'deform', source: { op: 'shell', source: mesh } } as unknown as ShapeRecipe)).toBe(true);
    expect(hasMeshLeaf({ op: 'brep', blob: '', format: 'occt-brep-v1' } as ShapeRecipe)).toBe(false);
  });
});

describe('a body built on a mesh without an exact construction is deformed on the mesh path, the kernel installed or not (DES-7d)', () => {
  it('scale_nonuniform and twist_body never hand the stored triangles to the kernel, and say why', async () => {
    const { evaluated } = await spiedKernel();
    const { doc, id } = scan(3);
    const scaled = execute(doc, 'scale_nonuniform', { id, factors: [2, 1, 0.5] });
    expect(scaled.summary).toContain('mesh path');
    expect(relative(volumeOf(scaled.document, scaled.affected[0] as string), volumeOf(doc, id))).toBeLessThan(1e-12);
    const twisted = execute(doc, 'twist_body', { id, angleDeg: 30 });
    expect(twisted.summary).toContain('mesh path');
    expect(twisted.summary).toContain('The source is a mesh without an exact construction');
    expect(evaluated.filter(hasMeshLeaf)).toEqual([]);
    expectPure(doc, () => execute(doc, 'scale_nonuniform', { id, factors: [2, 1, 0.5] }));
  });

  it('a deformed scan deformed again, analyze_deformation and check_deformation on it never evaluate the scan either', async () => {
    const { evaluated } = await spiedKernel();
    const { doc, id } = scan(2);
    const first = execute(doc, 'scale_nonuniform', { id, factors: [2, 1, 1] });
    const firstId = first.affected[0] as string;
    expect(meshEntity(first.document, firstId).brep).toMatchObject({ op: 'deform', source: { op: 'solid' } });
    const again = execute(first.document, 'twist_body', { id: firstId, angleDeg: 20 });
    expect(again.summary).toContain('mesh path');
    const analysed = execute(again.document, 'analyze_deformation', { id: again.affected[0] as string });
    expect(analysed.summary).toContain('analyze_deformation');
    expect(analysed.data).toMatchObject({ path: 'mesh' });
    const checked = execute(again.document, 'check_deformation', { id: again.affected[0] as string });
    expect(checked.summary).toContain('check_deformation');
    expect(evaluated.filter(hasMeshLeaf)).toEqual([]);
  });

  it('a face of a scan is not a flow target: refused by name before the kernel builds it', async () => {
    const { evaluated } = await spiedKernel();
    const { doc, id } = scan(2);
    const plate = execute(doc, 'add_box', { size: [6, 2, 1], position: [0, 0, 0], anchor: 'min' });
    const plateId = plate.affected[0] as string;
    const base = { plane: { origin: [0, 0, 0], normal: [0, 0, 1], uDirection: [1, 0, 0] } };
    const refused = execute(plate.document, 'flow_on_surface', { id: plateId, base, target: { entityId: id, faceNear: [0, 0, 10] } });
    expectNoOp(refused, plate.document, 'DEF_FLOW_TARGET_INVALID');
    expect(refused.summary).toContain('without an exact construction');
    expect(evaluated.filter(hasMeshLeaf)).toEqual([]);
  });

  it('mode "exact" refuses by name; a solid and a deformed solid still take the exact path', async () => {
    const { evaluated } = await spiedKernel();
    const { doc, id } = scan(2);
    const refused = execute(doc, 'scale_nonuniform', { id, factors: [2, 1, 1], output: { mode: 'exact' } });
    expectNoOp(refused, doc, 'DEF_EXACT_UNAVAILABLE');
    expect(refused.summary).toContain('without an exact construction');
    const box = addBox();
    const first = execute(box.doc, 'scale_nonuniform', { id: box.id, factors: [2, 1, 1] });
    expect(first.summary).toContain('exact path');
    const again = execute(first.document, 'scale_nonuniform', { id: first.affected[0] as string, factors: [1, 2, 1] });
    expect(again.summary).toContain('exact path');
    expect(evaluated.filter(hasMeshLeaf)).toEqual([]);
  });
});
