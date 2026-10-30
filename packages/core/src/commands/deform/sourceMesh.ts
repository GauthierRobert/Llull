/** The world triangles of a recipe, for the read-only deformation queries: the kernel builds them, else the core evaluates solid leaves and deform nodes. */

import type { CadDocument, MeshData, ShapeRecipe } from '../../model/types';
import { warpMesh } from '../../geometry/deform/meshWarp';
import { entityToTriangles } from '../../geometry/entityTriangles';
import type { GeometryKernel } from '../../geometry/kernel';
import { isUnverified } from '../mesh/meshCommon';
import { hasMeshLeaf } from '../../geometry/operandRecipe';

/**
 * Triangles of `recipe` (indexed; welded by the consumers). With a kernel it tessellates the kernel shape; without one only `solid` leaves and
 * chains of `deform` nodes over them can be evaluated. A recipe over a scan's triangles (`hasMeshLeaf`) is never handed to the kernel.
 * @failure a recipe the kernel refuses, or a node the core cannot evaluate without a kernel -> null
 */
export function sourceMeshOf(kernel: GeometryKernel | null, recipe: ShapeRecipe, doc: CadDocument): MeshData | null {
  if (kernel !== null && !hasMeshLeaf(recipe)) {
    const shape = kernel.evaluate(recipe);
    const mesh = shape === null ? null : kernel.tessellate(shape);
    if (mesh !== null && mesh.indices.length > 0) return mesh;
  }
  if (recipe.op === 'solid') {
    const positions = entityToTriangles(recipe.entity, doc).flatMap((triangle) => triangle.flat());
    return positions.length === 0 ? null : { positions, indices: Array.from({ length: positions.length / 3 }, (_, i) => i) };
  }
  if (recipe.op !== 'deform') return null;
  const inner = sourceMeshOf(null, recipe.source, doc);
  const warped = inner === null ? null : warpMesh(inner, recipe, { tolerance: recipe.output.tolerance });
  return warped?.ok === true ? warped.mesh : null;
}

/** The outermost `deform` node of an entity's recipe, or null. */
export function deformNodeOf(entity: {
  readonly kind: string;
  readonly brep?: ShapeRecipe;
}): Extract<ShapeRecipe, { op: 'deform' }> | null {
  return entity.kind === 'mesh' && entity.brep?.op === 'deform' ? entity.brep : null;
}

/** True when an unpinned imported mesh (no verified source hash) is a leaf of the recipe (01 DEF AF-32: computed on read, never stored). */
export function hasUnverifiedLeaf(recipe: ShapeRecipe): boolean {
  switch (recipe.op) {
    case 'solid':
      return isUnverified(recipe.entity);
    case 'boolean':
      return hasUnverifiedLeaf(recipe.a) || hasUnverifiedLeaf(recipe.b);
    case 'blend':
      return recipe.sources.some(hasUnverifiedLeaf);
    case 'brep':
    case 'faceSlab':
    case 'sheetSolid':
      return false;
    default:
      return hasUnverifiedLeaf(recipe.source);
  }
}
