/** The flow surface of a case (TECHNICAL_SPEC §5.1 steps 1-2): bodies collected from the document, unioned through the kernel when there is one. */

import type { GeometryKernel } from '@core/geometry/kernel';
import { entityBoundsInDoc } from '@core/geometry/bounds';
import { entityToTriangles } from '@core/geometry/entityTriangles';
import { expandInstance } from '@core/geometry/instanceExpansion';
import { soupIndices } from '@core/geometry/meshVolume';
import { buildMeshBvh, bvhIntersects, type MeshBvh } from '@core/geometry/meshBvh';
import { recipeOf } from '@core/geometry/shapeRecipe';
import { is3D, type CadDocument, type Entity, type ShapeRecipe, type Vec3 } from '@core/model/types';
import type { CfdCase } from '@core/model/cfd';

/** One solid of the flow body: a plain 3D entity (instances are expanded), with the case entity it comes from. */
export interface Leaf {
  readonly entity: Entity;
  readonly ownerId: string;
}

export interface CollectedBodies {
  readonly leaves: Leaf[];
  /** Case entities that are 2D sketches (skipped). */
  readonly skipped2D: string[];
}

const MAX_EXPANSION_DEPTH = 8;

function expandLeaves(doc: CadDocument, entity: Entity, ownerId: string, depth: number): Leaf[] {
  if (!is3D(entity)) return [];
  if (entity.kind !== 'instance') return [{ entity, ownerId }];
  const component = doc.components[entity.componentId];
  if (component === undefined || depth >= MAX_EXPANSION_DEPTH) return [];
  return expandInstance(entity, component).flatMap((child) => expandLeaves(doc, child, ownerId, depth + 1));
}

/**
 * Case bodies: `entityIds` minus `excludedEntityIds`, instances expanded, 2D shapes skipped.
 * @invariant order follows entityIds; ids that do not exist are ignored (the case validation reports them)
 */
export function collectBodies(doc: CadDocument, cfdCase: CfdCase): CollectedBodies {
  const leaves: Leaf[] = [];
  const skipped2D: string[] = [];
  for (const id of cfdCase.entityIds) {
    if (cfdCase.excludedEntityIds.includes(id) || !Object.hasOwn(doc.entities, id)) continue;
    const entity = doc.entities[id] as Entity;
    if (!is3D(entity)) skipped2D.push(id);
    else leaves.push(...expandLeaves(doc, entity, id, 0));
  }
  return { leaves, skipped2D };
}

export type UnionMethod = 'single_body' | 'kernel_union' | 'display_triangles';

export interface BuiltSurface {
  /** Flat xyz in document units, world axes. */
  readonly positions: number[];
  /** Triangle corner indices into `positions` (a soup when from display triangles). */
  readonly indices: number[];
  readonly method: UnionMethod;
  /** Pairs of owner ids whose solids overlap or touch (only without a kernel union). */
  readonly overlaps: ReadonlyArray<readonly [string, string]>;
  readonly notes: string[];
}

const MAX_OVERLAP_PAIRS = 20;

function unionRecipe(leaves: readonly Leaf[]): ShapeRecipe {
  const [first, ...rest] = leaves.map((leaf) => recipeOf(leaf.entity));
  return rest.reduce<ShapeRecipe>((a, b) => ({ op: 'boolean', boolean: 'union', a, b }), first as ShapeRecipe);
}

const soupOf = (triangles: ReadonlyArray<ReadonlyArray<Vec3>>): { positions: number[]; indices: number[] } => {
  const positions = triangles.flatMap((triangle) => triangle.flatMap((corner) => [...corner]));
  return { positions, indices: soupIndices(positions) };
};

function overlappingPairs(leaves: readonly Leaf[], doc: CadDocument): Array<readonly [string, string]> {
  const trees: Array<{ ownerId: string; tree: MeshBvh }> = leaves.map((leaf) => ({
    ownerId: leaf.ownerId,
    tree: buildMeshBvh(soupOf(entityToTriangles(leaf.entity, doc))),
  }));
  const pairs: Array<readonly [string, string]> = [];
  for (let i = 0; i < trees.length && pairs.length < MAX_OVERLAP_PAIRS; i++)
    for (let j = i + 1; j < trees.length && pairs.length < MAX_OVERLAP_PAIRS; j++) {
      const a = trees[i];
      const b = trees[j];
      if (a !== undefined && b !== undefined && bvhIntersects(a.tree, b.tree)) pairs.push([a.ownerId, b.ownerId]);
    }
  return pairs;
}

/**
 * One surface for the bodies. With a kernel the solids are unioned (internal faces vanish); a kernel that cannot build the union, or no
 * kernel, falls back to the display triangles of each solid and reports which solids overlap or touch.
 * @invariant a single solid never needs a union; the display triangles are the entity's own tessellation
 */
export function buildSurface(doc: CadDocument, leaves: readonly Leaf[], kernel: GeometryKernel | null): BuiltSurface {
  if (leaves.length === 1) {
    const { positions, indices } = soupOf(entityToTriangles((leaves[0] as Leaf).entity, doc));
    return { positions, indices, method: 'single_body', overlaps: [], notes: [] };
  }
  const notes: string[] = [];
  if (kernel !== null) {
    const handle = kernel.evaluate(unionRecipe(leaves));
    const mesh = handle === null ? null : kernel.tessellate(handle);
    if (mesh !== null) return { positions: [...mesh.positions], indices: [...mesh.indices], method: 'kernel_union', overlaps: [], notes };
    notes.push('the kernel could not union the bodies (open or invalid solid?): display triangles are used');
  } else notes.push('no geometry kernel installed: display triangles are used and overlaps cannot be removed');
  const { positions, indices } = soupOf(leaves.flatMap((leaf) => entityToTriangles(leaf.entity, doc)));
  return { positions, indices, method: 'display_triangles', overlaps: overlappingPairs(leaves, doc), notes };
}

/** World AABB of each leaf, in document units, for attributing a position to an entity. */
export function leafBounds(doc: CadDocument, leaves: readonly Leaf[]): Array<{ ownerId: string; min: Vec3; max: Vec3 }> {
  return leaves.map((leaf) => {
    const { min, max } = entityBoundsInDoc(doc, leaf.entity);
    return { ownerId: leaf.ownerId, min, max };
  });
}
