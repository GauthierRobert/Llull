/**
 * @layer server/tests
 * Shape-kernel shorthands for the live-kernel tests: entity -> leaf recipe -> display mesh.
 */

import type { GeometryKernel, MeshData } from '@core/geometry/kernel';
import type { BooleanOp, ShapeRecipe } from '@core/geometry/shapeRecipe';
import type { Entity } from '@core/model/types';

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
