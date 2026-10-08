/**
 * Recipe evaluator shared by every concrete kernel: a kernel implements `KernelOps<S>` on its own
 * native shape type `S` (an OCC TopoDS_Shape, a Manifold solid) and `kernelFromOps` turns it into a
 * `GeometryKernel` that walks recipes, caches native shapes by `recipeKey` (so an unchanged prefix of
 * the feature tree is never rebuilt) and hands out opaque `ShapeHandle`s.
 *
 * @layer core/geometry
 * @invariant a handle carries its recipe: an evicted (or restarted-kernel) shape is rebuilt on use
 * @invariant a native shape is released exactly once, never while an evaluation still reads it
 * @failure an op returning null or throwing -> that recipe (and every recipe built on it) is null
 */

import type { Entity, Vec3 } from '../model/types';
import type { GeometryKernel, MeshData, ShapeHandle, ShapeTopology } from './kernel';
import type { BooleanOp, ShapeRecipe } from './shapeRecipe';
import { recipeKey } from './shapeRecipe';

/** Native operations of a concrete kernel. Each returns a NEW native shape (inputs untouched). */
export interface KernelOps<S> {
  solid(entity: Entity): S | null;
  boolean(op: BooleanOp, a: S, b: S): S | null;
  /** Optional rewrite of a boolean's operand recipes before they are built (degenerate-contact guards). */
  prepareBoolean?(a: ShapeRecipe, b: ShapeRecipe): [ShapeRecipe, ShapeRecipe];
  /** `edges`: 0-based unique-edge indices ([] = all). */
  fillet(shape: S, edges: readonly number[], radius: number): S | null;
  chamfer(shape: S, edges: readonly number[], distance: number): S | null;
  shell(shape: S, thickness: number): S | null;
  place(shape: S, position: Vec3, rotation: Vec3): S | null;
  scale(shape: S, factor: number): S | null;
  tessellate(shape: S): MeshData | null;
  topology(shape: S): ShapeTopology | null;
  exportStep(shapes: readonly S[]): string | null;
  release(shape: S): void;
}

/** What a handle really is; only this module (and kernels proxying it verbatim) see through it. */
interface HandleBody {
  readonly key: string;
  readonly recipe: ShapeRecipe;
}

const toHandle = (body: HandleBody): ShapeHandle => body as unknown as ShapeHandle;
const bodyOf = (handle: ShapeHandle): HandleBody => handle as unknown as HandleBody;

export interface CachingKernel extends GeometryKernel {
  /** Native shapes currently cached (observability/tests). */
  cachedShapeCount(): number;
  /** Number of recipe nodes actually built by the native kernel (cache misses). */
  buildCount(): number;
  /** Release every cached native shape (kernel restart, tests). */
  clear(): void;
}

function build<S>(
  ops: KernelOps<S>,
  recipe: ShapeRecipe,
  child: (r: ShapeRecipe) => S | null,
): S | null {
  switch (recipe.op) {
    case 'solid':
      return ops.solid(recipe.entity);
    case 'boolean': {
      const [left, right] = ops.prepareBoolean?.(recipe.a, recipe.b) ?? [recipe.a, recipe.b];
      const a = child(left);
      const b = a === null ? null : child(right);
      return a === null || b === null ? null : ops.boolean(recipe.boolean, a, b);
    }
    case 'fillet':
    case 'chamfer': {
      const source = child(recipe.source);
      if (source === null) return null;
      return recipe.op === 'fillet'
        ? ops.fillet(source, recipe.edges, recipe.size)
        : ops.chamfer(source, recipe.edges, recipe.size);
    }
    case 'shell': {
      const source = child(recipe.source);
      return source === null ? null : ops.shell(source, recipe.thickness);
    }
    case 'place': {
      const source = child(recipe.source);
      return source === null ? null : ops.place(source, recipe.position, recipe.rotation);
    }
    case 'scale': {
      const source = child(recipe.source);
      return source === null ? null : ops.scale(source, recipe.factor);
    }
  }
}

/**
 * Wrap native ops as a recipe-evaluating `GeometryKernel` with an LRU of `capacity` native shapes.
 * Failed recipes (null) are cached too, so a refused fillet is not retried on every replay.
 */
export function kernelFromOps<S>(ops: KernelOps<S>, capacity = 128): CachingKernel {
  const shapes = new Map<string, S | null>();
  const meshes = new Map<string, MeshData | null>();
  const pinned = new Set<string>();
  let builds = 0;

  const safeRelease = (shape: S): void => {
    try {
      ops.release(shape);
    } catch {
      /* already released */
    }
  };

  const evict = (): void => {
    for (const key of shapes.keys()) {
      if (shapes.size <= capacity) return;
      if (pinned.has(key)) continue;
      const shape = shapes.get(key);
      shapes.delete(key);
      meshes.delete(key);
      if (shape !== null && shape !== undefined) safeRelease(shape);
    }
  };

  const evaluateNative = (recipe: ShapeRecipe): S | null => {
    const key = recipeKey(recipe);
    if (shapes.has(key)) {
      const hit = shapes.get(key) ?? null;
      shapes.delete(key);
      shapes.set(key, hit); // most recent
      return hit;
    }
    pinned.add(key);
    let shape: S | null = null;
    try {
      builds++;
      shape = build(ops, recipe, (sub) => {
        const native = evaluateNative(sub);
        pinned.add(recipeKey(sub));
        return native;
      });
    } catch (error) {
      console.warn(
        `[kernel] ${recipe.op} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      shape = null;
    }
    shapes.set(key, shape);
    return shape;
  };

  /** Evaluate with every shape it touches pinned; unpin and evict once it is done. */
  const withPins = <T>(body: () => T): T => {
    const outermost = pinned.size === 0;
    try {
      return body();
    } finally {
      if (outermost) {
        pinned.clear();
        evict();
      }
    }
  };

  const nativeOf = (handle: ShapeHandle): S | null => evaluateNative(bodyOf(handle).recipe);

  return {
    evaluate: (recipe) =>
      withPins(() => {
        const shape = evaluateNative(recipe);
        return shape === null ? null : toHandle({ key: recipeKey(recipe), recipe });
      }),
    tessellate: (handle) =>
      withPins(() => {
        const { key } = bodyOf(handle);
        if (meshes.has(key)) return meshes.get(key) ?? null;
        const shape = nativeOf(handle);
        const mesh = shape === null ? null : ops.tessellate(shape);
        meshes.set(key, mesh);
        return mesh;
      }),
    topology: (handle) =>
      withPins(() => {
        const shape = nativeOf(handle);
        return shape === null ? null : ops.topology(shape);
      }),
    exportStep: (handles) =>
      withPins(() => {
        const natives = handles.map(nativeOf);
        if (natives.some((shape) => shape === null)) return null;
        return ops.exportStep(natives as S[]);
      }),
    cachedShapeCount: () => shapes.size,
    buildCount: () => builds,
    clear: () => {
      for (const shape of shapes.values()) if (shape !== null) safeRelease(shape);
      shapes.clear();
      meshes.clear();
    },
  };
}
