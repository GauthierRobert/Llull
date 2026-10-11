/**
 * Recipe evaluator shared by every concrete kernel: a kernel implements `KernelOps<S>` on its own
 * native shape type `S` (an OCC TopoDS_Shape, a Manifold solid) and `kernelFromOps` turns it into a
 * `GeometryKernel` that walks recipes, caches native shapes by `recipeKey` (so an unchanged prefix of
 * the feature tree is never rebuilt) and hands out opaque `ShapeHandle`s.
 *
 * @layer core/geometry
 * @invariant a handle carries its recipe: an evicted (or restarted-kernel) shape is rebuilt on use
 * @invariant a native shape is released exactly once, never while a call still reads it: eviction is
 *   deferred to the end of the outermost call (the cache may exceed `capacity` by that call's nodes)
 * @invariant a cached failure (null) is dropped as soon as the native module reports degradation
 *   (`failureEpoch` grows), so a spurious null is retried instead of sticking
 * @failure an op returning null or throwing -> that recipe (and every recipe built on it) is null
 */

import type { Entity, Vec3 } from '../model/types';
import type { GeometryKernel, MeshData, ShapeHandle, ShapeTopology } from './kernel';
import { type BooleanOp, type ShapeRecipe, recipeKey } from './shapeRecipe';

/**
 * Native operations of a concrete kernel. Each returns a NEW native shape (never one of its inputs:
 * the cache owns and releases every returned native exactly once).
 */
export interface KernelOps<S> {
  /** Recipe ops this kernel cannot perform at all (a capability gap, not a refusal of one input). */
  readonly unsupported?: ReadonlySet<ShapeRecipe['op']>;
  /** Grows whenever the native module may have been left degraded (cached failures are then retried). */
  failureEpoch?(): number;
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

/**
 * What a handle really is; only this module and kernel proxies (via the helpers below) see through it.
 * `recipe` is absent on a key-only handle (sent to a worker that probably still caches the shape).
 */
interface HandleBody {
  readonly key: string;
  readonly recipe?: ShapeRecipe;
}

const toHandle = (body: HandleBody): ShapeHandle => body as unknown as ShapeHandle;
const bodyOf = (handle: ShapeHandle): HandleBody => handle as unknown as HandleBody;

/** Error message prefix of a key-only handle whose shape is no longer cached (resend with recipe). */
export const SHAPE_NOT_CACHED = 'shape not cached';

/** The handle without its recipe: cheap to send to a kernel that likely still caches the shape. */
export function keyOnlyHandle(handle: ShapeHandle): ShapeHandle {
  return toHandle({ key: bodyOf(handle).key });
}

/** A full handle for `recipe` (proxies rebuild it locally from a key-only reply). */
export function handleOf(recipe: ShapeRecipe): ShapeHandle {
  return toHandle({ key: recipeKey(recipe), recipe });
}

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
  let depth = 0;
  let builds = 0;
  let epoch = ops.failureEpoch?.() ?? 0;

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
      const shape = shapes.get(key);
      shapes.delete(key);
      meshes.delete(key);
      if (shape !== null && shape !== undefined) safeRelease(shape);
    }
  };

  /** After a degrading failure every cached null may be spurious: forget them. */
  const forgetFailuresIfDegraded = (): void => {
    const now = ops.failureEpoch?.() ?? 0;
    if (now === epoch) return;
    epoch = now;
    for (const [key, shape] of shapes) if (shape === null) shapes.delete(key);
    for (const [key, mesh] of meshes) if (mesh === null) meshes.delete(key);
  };

  const evaluateNative = (recipe: ShapeRecipe): S | null => {
    const key = recipeKey(recipe);
    if (shapes.has(key)) {
      const hit = shapes.get(key) ?? null;
      shapes.delete(key);
      shapes.set(key, hit); // most recent
      return hit;
    }
    let shape: S | null = null;
    try {
      builds++;
      shape = build(ops, recipe, evaluateNative);
    } catch (error) {
      console.warn(
        `[kernel] ${recipe.op} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      shape = null;
    }
    shapes.set(key, shape);
    return shape;
  };

  /** Run one public call; evict (and retry-proof cached failures) only once the outermost ends. */
  const call = <T>(body: () => T): T => {
    if (depth === 0) forgetFailuresIfDegraded();
    depth++;
    try {
      return body();
    } finally {
      depth--;
      if (depth === 0) {
        evict();
        forgetFailuresIfDegraded();
      }
    }
  };

  const nativeOf = (handle: ShapeHandle): S | null => {
    const { key, recipe } = bodyOf(handle);
    if (recipe !== undefined) return evaluateNative(recipe);
    if (!shapes.has(key)) throw new Error(`${SHAPE_NOT_CACHED}: ${key}`);
    return shapes.get(key) ?? null;
  };

  return {
    supports: (op) => !(ops.unsupported?.has(op) ?? false),
    evaluate: (recipe) => call(() => (evaluateNative(recipe) === null ? null : handleOf(recipe))),
    tessellate: (handle) =>
      call(() => {
        const { key } = bodyOf(handle);
        if (meshes.has(key)) return meshes.get(key) ?? null;
        const shape = nativeOf(handle);
        const mesh = shape === null ? null : ops.tessellate(shape);
        meshes.set(key, mesh);
        return mesh;
      }),
    topology: (handle) =>
      call(() => {
        const shape = nativeOf(handle);
        return shape === null ? null : ops.topology(shape);
      }),
    exportStep: (handles) =>
      call(() => {
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
