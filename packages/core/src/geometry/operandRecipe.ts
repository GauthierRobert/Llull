/** Operand recipes: an entity's exact construction tree, or its stored triangles when the kernel cannot rebuild the tree. */

import type { Entity, ShapeRecipe } from '../model/types';
import type { GeometryKernel } from './kernel';
import { meshRecipeOf, recipeOf } from './shapeRecipe';

/** The first op of `recipe` this kernel cannot perform at all, or null. */
export function unsupportedOp(kernel: Pick<GeometryKernel, 'supports' | 'supportsDeform'>, recipe: ShapeRecipe): ShapeRecipe['op'] | null {
  if (!kernel.supports(recipe.op)) return recipe.op;
  if (recipe.op === 'deform' && kernel.supportsDeform?.(recipe.law, recipe.region) === false) return recipe.op;
  switch (recipe.op) {
    case 'solid':
    case 'brep':
    case 'faceSlab':
    case 'sheetSolid':
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
 * True when a leaf of `recipe` is the stored triangles of a `mesh` entity (an import or scan: no exact construction). A kernel would sew one face per
 * triangle to rebuild it (superlinear: a 327k-triangle scan never finishes), so the deformation paths keep such recipes on the core mesh path.
 */
export function hasMeshLeaf(recipe: ShapeRecipe): boolean {
  switch (recipe.op) {
    case 'solid':
      return recipe.entity.kind === 'mesh';
    case 'brep':
    case 'faceSlab':
    case 'sheetSolid':
      return false;
    case 'boolean':
      return hasMeshLeaf(recipe.a) || hasMeshLeaf(recipe.b);
    case 'blend':
      return recipe.sources.some(hasMeshLeaf);
    default:
      return hasMeshLeaf(recipe.source);
  }
}

/** Triangles of the scans under `recipe`: every `mesh` leaf counts its stored asset (full resolution) or, without one, its inline triangles. */
export function meshLeafTriangles(recipe: ShapeRecipe): number {
  switch (recipe.op) {
    case 'solid':
      return recipe.entity.kind !== 'mesh' ? 0 : (recipe.entity.asset?.triangles ?? recipe.entity.mesh.indices.length / 3);
    case 'brep':
    case 'faceSlab':
    case 'sheetSolid':
      return 0;
    case 'boolean':
      return meshLeafTriangles(recipe.a) + meshLeafTriangles(recipe.b);
    case 'blend':
      return recipe.sources.reduce((sum, source) => sum + meshLeafTriangles(source), 0);
    default:
      return meshLeafTriangles(recipe.source);
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
