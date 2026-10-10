/**
 * @layer server/tests
 * Shape-kernel shorthands for the live-kernel tests: entity -> leaf recipe -> display mesh.
 */

import type { GeometryKernel, MeshData } from '@core/geometry/kernel';
import type { BooleanOp, ShapeRecipe } from '@core/geometry/shapeRecipe';
import type { Entity, Vec3 } from '@core/model/types';

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

export function bounds(mesh: MeshData): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k] ?? 0, mesh.positions[i + k] ?? 0);
      max[k] = Math.max(max[k] ?? 0, mesh.positions[i + k] ?? 0);
    }
  }
  return { min, max };
}

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
