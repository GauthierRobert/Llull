/** Operand recipes: an entity's exact construction tree, or its stored triangles when the kernel cannot rebuild the tree. */

import type { Entity, ShapeRecipe } from '../model/types';
import type { GeometryKernel } from './kernel';
import { meshRecipeOf, recipeOf } from './shapeRecipe';

/** The first op of `recipe` this kernel cannot perform at all, or null. */
export function unsupportedOp(kernel: GeometryKernel, recipe: ShapeRecipe): ShapeRecipe['op'] | null {
  if (!kernel.supports(recipe.op)) return recipe.op;
  switch (recipe.op) {
    case 'solid':
    case 'brep':
    case 'faceSlab':
      return null;
    case 'boolean':
      return unsupportedOp(kernel, recipe.a) ?? unsupportedOp(kernel, recipe.b);
    case 'blend':
      for (const source of recipe.sources) {
        const missing = unsupportedOp(kernel, source);
        if (missing !== null) return missing;
      }
      return null;
    default:
      return unsupportedOp(kernel, recipe.source);
  }
}

/**
 * Recipe of an operand entity: its exact construction tree, or — only when this kernel lacks an op of that tree (a fillet recipe loaded
 * under Manifold) — its stored triangles. A transient refusal never downgrades the exact tree.
 */
export function operandRecipe(kernel: GeometryKernel, entity: Entity): ShapeRecipe {
  const fallback = meshRecipeOf(entity);
  if (fallback !== null && unsupportedOp(kernel, recipeOf(entity)) !== null) return fallback;
  return recipeOf(entity);
}
