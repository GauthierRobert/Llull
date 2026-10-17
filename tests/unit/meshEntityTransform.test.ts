/**
 * A `mesh` entity honours its `position` / `rotation` everywhere (renderer, exact recipe and the Manifold kernel already did): moving or
 * rotating one must move its triangles, bounds and mass properties too. Regression guard: those readers used to ignore `position`, so a
 * mesh moved by move_entities drew in the new place but measured, exported and simulated in the old one.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument, type Entity, type MeshData, type Vec3 } from '@core/model/types';
import { entityToTriangles } from '@core/geometry/entityTriangles';
import { entityBounds } from '@core/geometry/bounds';
import { rotatedEntityBounds } from '@core/geometry/rotatedBounds';
import { recipeOf } from '@core/geometry/shapeRecipe';
import { resolveMassProperties } from '@core/geometry/resolveMassProperties';
import type { GeometryKernel } from '@core/geometry/kernel';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';

let kernel: GeometryKernel;
beforeAll(async () => {
  kernel = await createManifoldKernel();
});

/** A world-space 10 × 20 × 30 box mesh with its min corner at (100, 0, 0), as booleans and imports create meshes (position 0). */
function boxMesh(): MeshData {
  const [x0, y0, z0, x1, y1, z1] = [100, 0, 0, 110, 20, 30];
  const corners: Vec3[] = [
    [x0, y0, z0],
    [x1, y0, z0],
    [x1, y1, z0],
    [x0, y1, z0],
    [x0, y0, z1],
    [x1, y0, z1],
    [x1, y1, z1],
    [x0, y1, z1],
  ];
  const faces = [
    [0, 2, 1],
    [0, 3, 2],
    [4, 5, 6],
    [4, 6, 7],
    [0, 1, 5],
    [0, 5, 4],
    [1, 2, 6],
    [1, 6, 5],
    [2, 3, 7],
    [2, 7, 6],
    [3, 0, 4],
    [3, 4, 7],
  ];
  return { positions: corners.flat(), indices: faces.flat() };
}

function documentWithMesh(): CadDocument {
  const doc = createEmptyDocument();
  const mesh: Entity = {
    id: 'm',
    kind: 'mesh',
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    layerId: doc.layerOrder[0] ?? 'layer-default',
    color: '#888888',
    mesh: boxMesh(),
  };
  return { ...doc, entities: { m: mesh }, order: ['m'] };
}

const extent = (points: readonly Vec3[]): { min: Vec3; max: Vec3 } => ({
  min: [0, 1, 2].map((i) => Math.min(...points.map((p) => p[i] ?? 0))) as unknown as Vec3,
  max: [0, 1, 2].map((i) => Math.max(...points.map((p) => p[i] ?? 0))) as unknown as Vec3,
});

const triangleExtent = (e: Entity, doc: CadDocument): { min: Vec3; max: Vec3 } => extent(entityToTriangles(e, doc).flat());

function kernelExtent(e: Entity): { min: Vec3; max: Vec3 } {
  const shape = kernel.evaluate(recipeOf(e));
  const mesh = shape === null ? null : kernel.tessellate(shape);
  if (mesh === null) throw new Error('kernel could not evaluate the mesh');
  const points: Vec3[] = [];
  for (let i = 0; i + 2 < mesh.positions.length; i += 3)
    points.push([mesh.positions[i] ?? 0, mesh.positions[i + 1] ?? 0, mesh.positions[i + 2] ?? 0]);
  return extent(points);
}

const expectExtent = (actual: { min: Vec3; max: Vec3 }, expected: { min: readonly number[]; max: readonly number[] }): void => {
  actual.min.forEach((v, i) => expect(v).toBeCloseTo(expected.min[i] ?? NaN, 4));
  actual.max.forEach((v, i) => expect(v).toBeCloseTo(expected.max[i] ?? NaN, 4));
};

describe('mesh entities honour their transform', () => {
  it('move_entities moves a mesh’s triangles, bounds and centre of mass, exactly as the kernel places it', () => {
    const moved = execute(documentWithMesh(), 'move_entities', { ids: ['m'], delta: [0, 0, 200] }).document;
    const mesh = moved.entities['m'] as Entity;
    const expected = { min: [100, 0, 200], max: [110, 20, 230] };
    expectExtent(kernelExtent(mesh), expected);
    expectExtent(triangleExtent(mesh, moved), expected);
    expectExtent(entityBounds(mesh), expected);
    const props = resolveMassProperties(moved, mesh, () => 1, {})?.properties;
    expect(props?.centerOfMass).toEqual([105, 10, 215]);
    expect(props?.mass).toBeCloseTo(6000, 9);
  });

  it('a moved AND rotated mesh: triangles and rotated bounds agree with the kernel (rotate, then translate)', () => {
    const doc = documentWithMesh();
    const placed: Entity = { ...(doc.entities['m'] as Entity), position: [5, -7, 50], rotation: [0, 0, Math.PI / 2] };
    const truth = kernelExtent(placed);
    expectExtent(triangleExtent(placed, doc), truth);
    expectExtent(rotatedEntityBounds(placed), truth);
  });

  it('an unmoved mesh is unchanged (position [0,0,0], as every creator makes them)', () => {
    const doc = documentWithMesh();
    const mesh = doc.entities['m'] as Entity;
    expectExtent(triangleExtent(mesh, doc), { min: [100, 0, 0], max: [110, 20, 30] });
    expectExtent(entityBounds(mesh), { min: [100, 0, 0], max: [110, 20, 30] });
  });
});
