/**
 * Command-side bridge to the shape kernel: operand recipes (exact tree, or the mesh fallback when
 * this kernel cannot rebuild it), evaluation, and the `mesh` result entity that carries the recipe.
 */

import type { CadDocument, Entity } from '../../model/types';
import type { GeometryKernel, ShapeHandle } from '../../geometry/kernel';
import type { MeshData } from '../../model/types';
import { meshRecipeOf, recipeOf } from '../../geometry/shapeRecipe';
import type { ShapeRecipe } from '../../model/types';
import { newEntity } from '../entity/newEntity';
import { nextId } from '../../lib/id';
import { referenceLossSuffix, replaceEntities } from '../entity/entityOps';
import { changed } from '../noop';
import type { CommandResult } from '../types';

/** The first op of `recipe` this kernel cannot perform at all, or null. */
function unsupportedOp(kernel: GeometryKernel, recipe: ShapeRecipe): ShapeRecipe['op'] | null {
  if (!kernel.supports(recipe.op)) return recipe.op;
  switch (recipe.op) {
    case 'solid':
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
 * Recipe of an operand entity: its exact construction tree, or — only when this kernel lacks an op
 * of that tree (a fillet recipe loaded under Manifold) — its stored triangles. A transient refusal
 * never downgrades the exact tree.
 */
export function operandRecipe(kernel: GeometryKernel, entity: Entity): ShapeRecipe {
  const fallback = meshRecipeOf(entity);
  if (fallback !== null && unsupportedOp(kernel, recipeOf(entity)) !== null) return fallback;
  return recipeOf(entity);
}

/** Summary suffix naming operands used as triangles because this kernel lacks an op of their tree. */
function fallbackSuffix(kernel: GeometryKernel, operands: readonly Entity[]): string {
  const notes = operands.flatMap((entity) => {
    if (meshRecipeOf(entity) === null) return [];
    const op = unsupportedOp(kernel, recipeOf(entity));
    return op === null ? [] : [`'${entity.id}' (its exact tree needs ${op})`];
  });
  return notes.length === 0
    ? ''
    : ` This kernel cannot rebuild ${notes.join(', ')}: used its stored triangles, so the result is faceted there.`;
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
export function evaluateRecipe(kernel: GeometryKernel, recipe: ShapeRecipe): KernelResult | 'refused' | 'empty' {
  const shape = kernel.evaluate(recipe);
  if (shape === null) return 'refused';
  const mesh = kernel.tessellate(shape);
  if (mesh === null || mesh.indices.length === 0) return 'empty';
  return { recipe, shape, mesh };
}

/** The `mesh` entity of a kernel result (world space), styled after `source`. */
function kernelResultEntity(id: string, result: KernelResult, source: Entity): Entity {
  return newEntity('mesh', id, { mesh: result.mesh, brep: result.recipe }, [0, 0, 0], source.color, {
    layerId: source.layerId,
  });
}

/** Summary suffix describing the exact topology kept by the kernel ('' for mesh-only kernels). */
function topologySuffix(kernel: GeometryKernel, shape: ShapeHandle): string {
  const topology = kernel.topology(shape);
  if (topology === null) return '';
  return ` Exact B-rep kept: ${topology.faces.length} faces, ${topology.edges.length} edges (inspect_topology lists them).`;
}

/**
 * Replace `operands` (the first one styles the result) by the kernel result's `mesh` entity. The
 * summary is `describe(newId, triangles)` plus the fallback / topology / lost-reference notes.
 */
export function commitKernelResult(
  doc: CadDocument,
  kernel: GeometryKernel,
  result: KernelResult,
  operands: readonly [Entity, ...Entity[]],
  describe: (newId: string, triangles: number) => string,
): CommandResult {
  const newId = nextId('mesh');
  const ids = operands.map((operand) => operand.id);
  const document = replaceEntities(doc, ids, kernelResultEntity(newId, result, operands[0]));
  const notes = `${fallbackSuffix(kernel, operands)}${topologySuffix(kernel, result.shape)}`;
  const summary = `${describe(newId, result.mesh.indices.length / 3)}${notes}`;
  return changed(document, `${summary}${referenceLossSuffix(doc, document)}`, [newId]);
}
