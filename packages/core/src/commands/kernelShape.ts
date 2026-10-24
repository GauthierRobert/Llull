/**
 * Command-side bridge to the shape kernel: operand recipes (exact tree, or the mesh fallback when this kernel cannot rebuild it),
 * evaluation, and the `mesh` result entity that carries the recipe.
 */

import type { CadDocument, Entity, Vec3 } from '../model/types';
import type { GeometryKernel, ShapeHandle } from '../geometry/kernel';
import type { MeshData } from '../model/types';
import { meshRecipeOf, recipeOf } from '../geometry/shapeRecipe';
import { operandRecipe, unsupportedOp } from '../geometry/operandRecipe';
import type { ShapeRecipe } from '../model/types';
import { newEntity } from './entity/newEntity';
import { nextId } from '../lib/id';
import { referenceLossSuffix, replaceEntities, withEntities } from './entity/entityOps';
import { changed } from './noop';
import type { CommandResult } from './types';

const isZero = (v: Vec3): boolean => v.every((component) => component === 0);

/**
 * The shape to write for `entity`: a ply solid's exact slab (placed like the entity) when the kernel builds it, else its operand recipe (the triangles).
 * `faceted` is true for a solid that carries a slab the kernel could not use.
 */
export function exactOrMesh(kernel: GeometryKernel, entity: Entity): { shape: ShapeHandle | null; faceted: boolean } {
  const { recipe, faceted } = exactRecipe(kernel, entity);
  return { shape: kernel.evaluate(recipe), faceted };
}

/** The recipe `exactOrMesh` evaluates (so a caller can wrap it, e.g. scale a placed slab), with the same `faceted` flag. */
export function exactRecipe(kernel: GeometryKernel, entity: Entity): { recipe: ShapeRecipe; faceted: boolean } {
  if (entity.kind === 'mesh' && entity.stepSlab !== undefined && entity.brep === undefined) {
    const slab = entity.stepSlab;
    const recipe: ShapeRecipe =
      isZero(entity.position) && isZero(entity.rotation)
        ? slab
        : { op: 'place', source: slab, position: entity.position, rotation: entity.rotation };
    if (kernel.supports('faceSlab') && kernel.evaluate(recipe) !== null) return { recipe, faceted: false };
    return { recipe: operandRecipe(kernel, entity), faceted: true };
  }
  return { recipe: operandRecipe(kernel, entity), faceted: false };
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
export function kernelResultEntity(id: string, result: KernelResult, source: Entity): Entity {
  return newEntity('mesh', id, { mesh: result.mesh, brep: result.recipe }, [0, 0, 0], source.color, { layerId: source.layerId });
}

/** Summary suffix describing the exact topology kept by the kernel ('' for mesh-only kernels). */
function topologySuffix(kernel: GeometryKernel, shape: ShapeHandle): string {
  const topology = kernel.topology(shape);
  if (topology === null) return '';
  return ` Exact B-rep kept: ${topology.faces.length} faces, ${topology.edges.length} edges (inspect_topology lists them).`;
}

/**
 * Replace `operands` (the first one styles the result) by the kernel result's `mesh` entity. The
 * summary is `describe(newId, triangles)` plus the fallback / topology / lost-reference notes. `keep` leaves the operands in the document
 * (the result is added after them).
 */
export function commitKernelResult(
  doc: CadDocument,
  kernel: GeometryKernel,
  result: KernelResult,
  operands: readonly [Entity, ...Entity[]],
  describe: (newId: string, triangles: number) => string,
  keep = false,
): CommandResult {
  const newId = nextId('mesh');
  const ids = operands.map((operand) => operand.id);
  const created = kernelResultEntity(newId, result, operands[0]);
  const document = keep ? withEntities(doc, [created]) : replaceEntities(doc, ids, created);
  const notes = `${fallbackSuffix(kernel, operands)}${topologySuffix(kernel, result.shape)}`;
  const summary = `${describe(newId, result.mesh.indices.length / 3)}${notes}`;
  return changed(document, `${summary}${referenceLossSuffix(doc, document)}`, [newId]);
}
