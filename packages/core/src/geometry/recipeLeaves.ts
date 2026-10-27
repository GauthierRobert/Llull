/**
 * The solid leaves of a shape recipe. A kernel result keeps the construction tree of its operands in `mesh.brep`; a leaf that is an
 * asset-backed mesh holds that mesh's display level of detail and its asset reference (07 MSH FR-MSH-02, TECHNICAL_SPEC 13.11).
 */

import type { Entity, MeshSolidEntity, ShapeRecipe } from '../model/types';
import type { MeshAssetRef } from '../model/meshProvenance';

/** A mesh leaf with a stored asset. */
export type AssetLeaf = MeshSolidEntity & { readonly asset: MeshAssetRef };

const isRecipe = (value: unknown): value is ShapeRecipe =>
  typeof value === 'object' && value !== null && typeof (value as { readonly op?: unknown }).op === 'string';

function visit(recipe: ShapeRecipe, found: AssetLeaf[]): void {
  if (recipe.op === 'solid') {
    const leaf = recipe.entity;
    if (leaf.kind === 'mesh' && leaf.asset !== undefined) found.push(leaf as AssetLeaf);
    return;
  }
  for (const value of Object.values(recipe)) {
    if (Array.isArray(value)) for (const item of value) if (isRecipe(item)) visit(item, found);
    if (isRecipe(value)) visit(value, found);
  }
}

const leafCache = new WeakMap<ShapeRecipe, readonly AssetLeaf[]>();

/** The asset-backed mesh leaves of `recipe`, in tree order. */
export function assetLeaves(recipe: ShapeRecipe): readonly AssetLeaf[] {
  const cached = leafCache.get(recipe);
  if (cached !== undefined) return cached;
  const found: AssetLeaf[] = [];
  visit(recipe, found);
  leafCache.set(recipe, found);
  return found;
}

/** `recipe` with each solid leaf entity replaced by what `swap` returns for it (undefined keeps it); the same object when nothing changes. */
export function mapSolidLeaves(recipe: ShapeRecipe, swap: (entity: Entity) => Entity | undefined): ShapeRecipe {
  if (recipe.op === 'solid') {
    const replaced = swap(recipe.entity);
    return replaced === undefined ? recipe : { op: 'solid', entity: replaced };
  }
  let next: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(recipe)) {
    let mapped: unknown = value;
    if (Array.isArray(value)) {
      const items = value.map((item): unknown => (isRecipe(item) ? mapSolidLeaves(item, swap) : item));
      if (items.some((item, index) => item !== value[index])) mapped = items;
    } else if (isRecipe(value)) mapped = mapSolidLeaves(value, swap);
    if (mapped !== value) {
      next ??= { ...recipe };
      next[key] = mapped;
    }
  }
  return next === undefined ? recipe : (next as unknown as ShapeRecipe);
}
