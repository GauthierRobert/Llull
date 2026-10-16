/**
 * Parts of an assembly check: 3D solid entities and assembly instances, built through the kernel.
 * @invariant order follows `doc.order`; an instance is ONE part (its entities unioned), named by the instance id
 */

import type { CadDocument, Entity, InstanceEntity, ShapeRecipe, Vec3 } from '../../model/types';
import { is2D, is3D } from '../../model/types';
import type { GeometryKernel } from '../../geometry/kernel';
import { expandInstance } from '../../geometry/instanceExpansion';
import type { AssemblyPart } from '../../geometry/assemblyCheck/partTypes';
import { operandRecipe } from '../brep/kernelShape';

export interface PartScope {
  readonly ids?: readonly string[] | undefined;
  readonly body?: string | undefined;
  readonly component?: string | undefined;
}

export interface CollectedParts {
  readonly parts: AssemblyPart[];
  /** Candidate part ids the kernel refused to build. */
  readonly refused: string[];
  /** 2D entities left out. */
  readonly skipped2D: number;
}

/** Union fold of recipes in order. */
function unionOf(recipes: readonly ShapeRecipe[]): ShapeRecipe | null {
  const [first, ...rest] = recipes;
  return first === undefined ? null : rest.reduce<ShapeRecipe>((a, b) => ({ op: 'boolean', boolean: 'union', a, b }), first);
}

function recipeOfPart(doc: CadDocument, kernel: GeometryKernel, entity: Entity): ShapeRecipe | null {
  if (entity.kind !== 'instance') return operandRecipe(kernel, entity);
  const component = doc.components[(entity as InstanceEntity).componentId];
  if (component === undefined) return null;
  const members = expandInstance(entity as InstanceEntity, component).filter((member) => is3D(member) && member.kind !== 'instance');
  return unionOf(members.map((member) => operandRecipe(kernel, member)));
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

/** Build every selected part with `kernel`. */
export function collectParts(doc: CadDocument, kernel: GeometryKernel, scope: PartScope): CollectedParts {
  const selected = scopedIds(doc, scope);
  const parts: AssemblyPart[] = [];
  const refused: string[] = [];
  let skipped2D = 0;
  for (const id of doc.order) {
    const entity = doc.entities[id];
    if (entity === undefined) continue;
    if (is2D(entity)) {
      skipped2D++;
      continue;
    }
    if (selected !== null && !selected.has(id)) continue;
    const recipe = recipeOfPart(doc, kernel, entity);
    const shape = recipe === null ? null : kernel.evaluate(recipe);
    if (recipe === null || shape === null) {
      refused.push(id);
      continue;
    }
    const mesh = kernel.tessellate(shape);
    parts.push({ id, recipe, shape, mesh, ...boundsOf(mesh) });
  }
  return { parts, refused, skipped2D };
}
