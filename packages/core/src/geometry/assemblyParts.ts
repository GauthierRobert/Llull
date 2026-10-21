/**
 * Parts of an assembly check: 3D solid entities and assembly instances, built through the kernel.
 * @invariant order follows `doc.order`; an instance is ONE part (its entities unioned, nested instances expanded), named by the instance id
 */

import type { CadDocument, Entity, InstanceEntity, ShapeRecipe, Vec3 } from '../model/types';
import { is2D, is3D } from '../model/types';
import type { GeometryKernel } from './kernel';
import { expandInstance } from './instanceExpansion';
import type { AssemblyPart } from './assemblyCheck/partTypes';
import { operandRecipe } from './operandRecipe';

export interface PartScope {
  readonly ids?: readonly string[] | undefined;
  readonly body?: string | undefined;
  readonly component?: string | undefined;
}

interface RefusedPart {
  readonly id: string;
  /** 'kernel': the kernel refused a recipe; 'unbuildable': no solid to build (missing component, empty component, nesting too deep). */
  readonly reason: 'kernel' | 'unbuildable';
}

export interface CollectedParts {
  readonly parts: AssemblyPart[];
  readonly refused: RefusedPart[];
}

/** Deepest instance nesting expanded into one part. */
const MAX_NESTING = 8;

/** Union fold of recipes in order. */
function unionOf(recipes: readonly ShapeRecipe[]): ShapeRecipe | null {
  const [first, ...rest] = recipes;
  return first === undefined ? null : rest.reduce<ShapeRecipe>((a, b) => ({ op: 'boolean', boolean: 'union', a, b }), first);
}

/** The 3D solids of an instance, nested instances expanded; null when the nesting is too deep or a component is missing. */
function instanceSolids(doc: CadDocument, instance: InstanceEntity, depth: number): Entity[] | null {
  const component = doc.components[instance.componentId];
  if (component === undefined || depth > MAX_NESTING) return null;
  const solids: Entity[] = [];
  for (const member of expandInstance(instance, component).filter(is3D)) {
    if (member.kind !== 'instance') {
      solids.push(member);
      continue;
    }
    const nested = instanceSolids(doc, member as InstanceEntity, depth + 1);
    if (nested === null) return null;
    solids.push(...nested);
  }
  return solids;
}

function recipeOfPart(doc: CadDocument, kernel: GeometryKernel, entity: Entity): ShapeRecipe | 'unbuildable' {
  if (entity.kind !== 'instance') return operandRecipe(kernel, entity);
  const solids = instanceSolids(doc, entity as InstanceEntity, 0);
  return (solids === null ? null : unionOf(solids.map((member) => operandRecipe(kernel, member)))) ?? 'unbuildable';
}

function boundsOf(mesh: { positions: ReadonlyArray<number> } | null): { min: Vec3; max: Vec3 } {
  if (mesh === null || mesh.positions.length < 3) return { min: [0, 0, 0], max: [0, 0, 0] };
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < mesh.positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const value = mesh.positions[i + axis] ?? 0;
      min[axis] = Math.min(min[axis] ?? Infinity, value);
      max[axis] = Math.max(max[axis] ?? -Infinity, value);
    }
  }
  return { min: min as unknown as Vec3, max: max as unknown as Vec3 };
}

/** Ids selected by `scope`, or null for the whole document. */
export function scopedIds(doc: CadDocument, scope: PartScope): ReadonlySet<string> | null {
  if (scope.ids !== undefined) return new Set(scope.ids);
  if (scope.body !== undefined) return new Set(doc.dynamics?.bodies[scope.body]?.entityIds ?? []);
  if (scope.component !== undefined)
    return new Set(
      Object.values(doc.entities).flatMap((entity) =>
        entity.kind === 'instance' && entity.componentId === scope.component ? [entity.id] : [],
      ),
    );
  return null;
}

/** Every 3D entity / instance id in document order (nothing is evaluated), and the number of 2D entities left out. */
export function candidateIds(doc: CadDocument): { ids: string[]; skipped2D: number } {
  const ids: string[] = [];
  let skipped2D = 0;
  for (const id of doc.order) {
    const entity = doc.entities[id];
    if (entity === undefined) continue;
    if (is2D(entity)) skipped2D++;
    else ids.push(id);
  }
  return { ids, skipped2D };
}

/** Build the parts `ids` (a subset of `candidateIds`) with `kernel`. */
export function collectParts(doc: CadDocument, kernel: GeometryKernel, ids: ReadonlySet<string>): CollectedParts {
  const parts: AssemblyPart[] = [];
  const refused: RefusedPart[] = [];
  for (const id of doc.order) {
    const entity = doc.entities[id];
    if (entity === undefined || !ids.has(id)) continue;
    const recipe = recipeOfPart(doc, kernel, entity);
    if (recipe === 'unbuildable') {
      refused.push({ id, reason: 'unbuildable' });
      continue;
    }
    const shape = kernel.evaluate(recipe);
    if (shape === null) {
      refused.push({ id, reason: 'kernel' });
      continue;
    }
    const mesh = kernel.tessellate(shape);
    parts.push({ id, recipe, shape, mesh, ...boundsOf(mesh) });
  }
  return { parts, refused };
}
