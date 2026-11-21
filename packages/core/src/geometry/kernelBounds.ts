import type { Entity } from '../model/types';
import type { GeometryKernel } from './kernel';
import type { Bounds } from './bounds';
import { recipeOf } from './shapeRecipe';

/** Where a bounds answer came from: the kernel's tight box of the placed shape, or the analytic / corner estimate (a superset of the geometry). */
export type BoundsSource = 'exact' | 'conservative';

/** Kinds the kernel builds from the entity alone and whose analytic bounds are loose once placed (box, cylinder and sphere are closed-form). */
const KERNEL_BOUNDS_KINDS: ReadonlySet<Entity['kind']> = new Set([
  'extrusion',
  'revolution',
  'sweep',
  'loft',
  'wedge',
  'pyramid',
  'cone',
  'torus',
]);

/**
 * Tight world AABB of a kernel-backed solid: `BRepBndLib::AddOptimal` of its exact shape as placed (position and rotation applied), through
 * `kernel.shapeBounds`. Null when there is no such kernel, the entity has no exact shape (box, mesh without B-rep, 2D, instance), or the
 * kernel refuses; callers then keep `orientedEntityBounds` and report `'conservative'`.
 * @invariant kernel-optional: never throws for a kernel failure
 */
export function kernelEntityBounds(e: Entity, kernel: GeometryKernel | null | undefined): Bounds | null {
  if (kernel?.shapeBounds === undefined) return null;
  const backed = e.kind === 'mesh' ? e.brep !== undefined : KERNEL_BOUNDS_KINDS.has(e.kind);
  if (!backed) return null;
  try {
    const shape = kernel.evaluate(recipeOf(e));
    const box = shape === null ? null : kernel.shapeBounds(shape);
    return box === null ? null : { min: box.min, max: box.max };
  } catch {
    return null;
  }
}
