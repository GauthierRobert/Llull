/**
 * Command-side bridge to the shape kernel: operand recipes (exact tree, or the mesh fallback when
 * this kernel cannot rebuild it), evaluation, and the `mesh` result entity that carries the recipe.
 *
 * @layer core/commands
 * @pure
 */

import type { Entity } from '../model/types';
import type { GeometryKernel, MeshData, ShapeHandle } from '../geometry/kernel';
import type { ShapeRecipe } from '../geometry/shapeRecipe';
import { meshRecipeOf, recipeOf } from '../geometry/shapeRecipe';
import { newEntity } from './newEntity';

/**
 * Recipe of an operand entity: its exact construction tree, or — when this kernel cannot rebuild
 * that tree (a fillet recipe loaded under a kernel without fillets) — its stored triangles.
 */
export function operandRecipe(kernel: GeometryKernel, entity: Entity): ShapeRecipe {
  const exact = recipeOf(entity);
  const fallback = meshRecipeOf(entity);
  if (fallback === null || kernel.evaluate(exact) !== null) return exact;
  return fallback;
}

export interface KernelResult {
  readonly recipe: ShapeRecipe;
  readonly shape: ShapeHandle;
  readonly mesh: MeshData;
}

/**
 * Evaluate `recipe` and tessellate it for display.
 * @failure kernel refuses the recipe -> 'refused'; it evaluates but yields no triangles -> 'empty'
 */
export function evaluateRecipe(
  kernel: GeometryKernel,
  recipe: ShapeRecipe,
): KernelResult | 'refused' | 'empty' {
  const shape = kernel.evaluate(recipe);
  if (shape === null) return 'refused';
  const mesh = kernel.tessellate(shape);
  if (mesh === null || mesh.indices.length === 0) return 'empty';
  return { recipe, shape, mesh };
}

/** The `mesh` entity of a kernel result (world space), styled after `source`. */
export function kernelResultEntity(id: string, result: KernelResult, source: Entity): Entity {
  return newEntity(
    'mesh',
    id,
    { mesh: result.mesh, brep: result.recipe },
    [0, 0, 0],
    source.color,
    {
      layerId: source.layerId,
    },
  );
}

/** Summary suffix describing the exact topology kept by the kernel ('' for mesh-only kernels). */
export function topologySuffix(kernel: GeometryKernel, shape: ShapeHandle): string {
  const topology = kernel.topology(shape);
  if (topology === null) return '';
  return ` Exact B-rep kept: ${topology.faces.length} faces, ${topology.edges.length} edges (inspect_topology lists them).`;
}
