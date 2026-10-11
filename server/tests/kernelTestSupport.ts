/**
 * @layer server/tests
 * Shape-kernel shorthands for the live-kernel tests: entity -> leaf recipe -> display mesh.
 */

import { beforeAll, expect } from 'vitest';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { createNodeOcctKernel } from '../src/occtNode';
import type { GeometryKernel, MeshData } from '@core/geometry/kernel';
import type { BooleanOp, ShapeRecipe } from '@core/geometry/shapeRecipe';
import type { Entity, Vec3 } from '@core/model/types';
import { meshBounds } from '../../tests/helpers/meshBounds';

export const leaf = (entity: Entity): ShapeRecipe => ({ op: 'solid', entity });

const asRecipe = (source: Entity | ShapeRecipe): ShapeRecipe =>
  'op' in source ? source : leaf(source);

/** Display mesh of a recipe (or of an entity's leaf); null when the kernel refuses it. */
export function meshOf(kernel: GeometryKernel, source: Entity | ShapeRecipe): MeshData | null {
  const shape = kernel.evaluate(asRecipe(source));
  return shape === null ? null : kernel.tessellate(shape);
}

export const booleanRecipe = (
  op: BooleanOp,
  a: Entity | ShapeRecipe,
  b: Entity | ShapeRecipe,
): ShapeRecipe => ({ op: 'boolean', boolean: op, a: asRecipe(a), b: asRecipe(b) });

/** Mesh of `a op b` (exact operands); null when the kernel refuses it. */
export function booleanMesh(
  kernel: GeometryKernel,
  op: BooleanOp,
  a: Entity | ShapeRecipe,
  b: Entity | ShapeRecipe,
): MeshData | null {
  return meshOf(kernel, booleanRecipe(op, a, b));
}

export const common = { layerId: 'layer-default', color: '#888888' };

export const box = (position: Vec3, size: Vec3): Entity =>
  ({ id: 'b', kind: 'box', position, rotation: [0, 0, 0], size, ...common }) as Entity;

export const bounds = meshBounds;

/** Signed volume by the divergence theorem: positive when the mesh is wound outward. */
export function volume(mesh: MeshData): number {
  let sum = 0;
  const p = mesh.positions;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => (mesh.indices[i + k] ?? 0) * 3) as [
      number,
      number,
      number,
    ];
    sum +=
      ((p[a] ?? 0) * ((p[b + 1] ?? 0) * (p[c + 2] ?? 0) - (p[b + 2] ?? 0) * (p[c + 1] ?? 0)) -
        (p[a + 1] ?? 0) * ((p[b] ?? 0) * (p[c + 2] ?? 0) - (p[b + 2] ?? 0) * (p[c] ?? 0)) +
        (p[a + 2] ?? 0) * ((p[b] ?? 0) * (p[c + 1] ?? 0) - (p[b + 1] ?? 0) * (p[c] ?? 0))) /
      6;
  }
  return sum;
}

/** Both live kernels, filled in `beforeAll` (the WASM load is slow); read them inside tests. */
export function liveKernels(): { occt: GeometryKernel; manifold: GeometryKernel } {
  const kernels = {} as { occt: GeometryKernel; manifold: GeometryKernel };
  beforeAll(async () => {
    kernels.occt = await createNodeOcctKernel();
    kernels.manifold = await createManifoldKernel();
  }, 120_000);
  return kernels;
}

/** Bounding boxes of `a` and `b` agree on every axis within `tolerance`. */
export function expectBoundsClose(a: MeshData, b: MeshData, tolerance: number): void {
  const [boundsA, boundsB] = [bounds(a), bounds(b)];
  for (let k = 0; k < 3; k++) {
    expect(Math.abs((boundsA.min[k] ?? 0) - (boundsB.min[k] ?? 0))).toBeLessThan(tolerance);
    expect(Math.abs((boundsA.max[k] ?? 0) - (boundsB.max[k] ?? 0))).toBeLessThan(tolerance);
  }
}

/** `entity op cutter` by OpenCascade has Manifold's volume within -8% / +8%. */
export function expectBooleanAgrees(
  kernels: { occt: GeometryKernel; manifold: GeometryKernel },
  op: BooleanOp,
  entity: Entity,
  cutter: Entity,
  label?: string,
): void {
  const fromOcct = booleanMesh(kernels.occt, op, entity, cutter);
  const fromManifold = booleanMesh(kernels.manifold, op, entity, cutter);
  expect(fromOcct, label).not.toBeNull();
  expect(fromManifold, label).not.toBeNull();
  expect(volume(fromOcct!) / volume(fromManifold!)).toBeGreaterThan(0.92);
  expect(volume(fromOcct!) / volume(fromManifold!)).toBeLessThan(1.08);
}

/** `[label, position, rotation]` placements shared by the OpenCascade-vs-Manifold comparisons. */
export type Placement = [string, Vec3, Vec3];
export const ORIGIN_PLACEMENT: Placement = ['origin', [0, 0, 0], [0, 0, 0]];
export const TRANSLATED_PLACEMENT: Placement = ['translated', [5, -3, 2], [0, 0, 0]];
export const ALL_AXES_PLACEMENT: Placement = [
  'rotated about all axes',
  [-2, 4, 1],
  [0.3, -0.5, 1.1],
];

/** Both kernels' meshes of `entity`; each must exist (`label` names the case on failure). */
export function bothMeshes(
  kernels: { occt: GeometryKernel; manifold: GeometryKernel },
  entity: Entity,
  label?: string,
): { fromOcct: MeshData; fromManifold: MeshData } {
  const fromOcct = meshOf(kernels.occt, entity);
  const fromManifold = meshOf(kernels.manifold, entity);
  expect(fromOcct, label).not.toBeNull();
  expect(fromManifold, label).not.toBeNull();
  return { fromOcct: fromOcct!, fromManifold: fromManifold! };
}
