/**
 * Recipe evaluator shared by every concrete kernel: a kernel implements `KernelOps<S>` on its own native shape type `S` (an OCC
 * TopoDS_Shape, a Manifold solid) and `kernelFromOps` turns it into a `GeometryKernel` that walks recipes, caches native shapes by
 * `recipeKey` (so an unchanged prefix of the feature tree is never rebuilt) and hands out opaque `ShapeHandle`s.
 * @invariant a handle carries its recipe: an evicted (or restarted-kernel) shape is rebuilt on use
 * @invariant a native shape is released exactly once, never while a call still reads it: eviction is deferred to the end of the outermost
 *   call (the cache may exceed `capacity` by that call's nodes)
 * @invariant a cached failure (null) is dropped as soon as the native module reports degradation (`failureEpoch` grows), so a spurious null
 *   is retried instead of sticking
 * @failure an op returning null or throwing -> that recipe (and every recipe built on it) is null
 */

import type { BooleanOp, EdgeRadius, Entity, MeshData, ShapeRecipe, Vec3 } from '../model/types';
import type { FaceOpParams } from '../model/faceOps';
import type { GeometryKernel, ShapeAnalysis, ShapeDistance, ShapeHandle, ShapeTopology, StepAssemblyPart, StepOccurrence } from './kernel';
import type { ExactMassProperties, FaceQueryPort, ImportShapesOptions, ImportShapesResult, KernelInfo } from './kernelPorts';
import { recipeKey } from './shapeRecipe';
import { faceOpParamsOf } from './faceOpRecipe';
import { lowerFeature, needsReach, throughReach } from './featureLowering';
import { floorEdgeIndices } from './featureFillet';
import { errorMessage } from '../lib/errorMessage';
import { sha256Hex } from '../lib/sha256';

/** `FaceQueryPort` over native shapes: every method takes the native shape where the port takes a handle. */
export type FaceQueryOps<S> = {
  [K in keyof FaceQueryPort]: FaceQueryPort[K] extends (shape: ShapeHandle, ...rest: infer R) => infer T
    ? (shape: S, ...rest: R) => T
    : never;
};

/**
 * Native operations of a concrete kernel. Each returns a NEW native shape (never one of its inputs: the cache owns and releases every
 * returned native exactly once).
 */
export interface KernelOps<S> {
  /** Kernel name exposed as `GeometryKernel.name`. */
  readonly name?: string;
  /** Recipe ops this kernel cannot perform at all (a capability gap, not a refusal of one input). */
  readonly unsupported?: ReadonlySet<ShapeRecipe['op']>;
  /** Face draft / push-pull / split (SC-F1); absent = `faceOp` nodes are unsupported. */
  readonly faceOp?: (source: S, params: FaceOpParams) => S | null;
  /** Grows whenever the native module may have been left degraded (cached failures are then retried). */
  failureEpoch?(): number;
  solid(entity: Entity): S | null;
  boolean(op: BooleanOp, a: S, b: S): S | null;
  /**
   * Optional NATIVE form of a `feature` node (07 FTR M7): the cut result of a hole / pocket on `source` (before any floor fillet), or null when
   * this node needs the lowering to booleans. `reach` = the source's extent below the face plane (through-all / through depth).
   */
  feature?(source: S, node: Extract<ShapeRecipe, { op: 'feature' }>, reach: number): S | null;
  /** Optional rewrite of a boolean's operand recipes before they are built (degenerate-contact guards). */
  prepareBoolean?(a: ShapeRecipe, b: ShapeRecipe): [ShapeRecipe, ShapeRecipe];
  /** `edges`: 0-based unique-edge indices ([] = all); `radiusEnd` varies the radius along each edge. */
  fillet(shape: S, edges: readonly number[], radius: number, radiusEnd?: number): S | null;
  /** Optional per-edge radius laws (`edges[i]` rounded with `laws[i]`) in one builder; absent = only uniform laws can be built (via `fillet`). */
  filletEach?(shape: S, edges: readonly number[], laws: readonly EdgeRadius[]): S | null;
  /** Union of `shapes` with the new intersection (joint) edges filleted by `radius`. */
  blend(shapes: readonly S[], radius: number): S | null;
  chamfer(shape: S, edges: readonly number[], distance: number): S | null;
  /** `openNear`: points, each removing the face of `shape` nearest to it (an open pocket); absent/empty = a sealed cavity. */
  shell(shape: S, thickness: number, openNear?: readonly Vec3[]): S | null;
  place(shape: S, position: Vec3, rotation: Vec3): S | null;
  scale(shape: S, factor: number): S | null;
  tessellate(shape: S): MeshData | null;
  topology(shape: S): ShapeTopology | null;
  exportStep(shapes: readonly S[]): string | null;
  /** Optional assembly STEP writer; a kernel without it leaves `GeometryKernel.exportStepAssembly` undefined. */
  exportStepAssembly?(occurrences: readonly StepOccurrence<S>[]): string | null;
  /** Optional validity / lump report; a kernel without it leaves `GeometryKernel.analyze` undefined. */
  analyze?(shape: S): ShapeAnalysis | null;
  /** Optional exact mass properties at unit density; a kernel without it leaves `GeometryKernel.massProperties` undefined. */
  massProperties?(shape: S): ExactMassProperties | null;
  /** Optional minimum distance (searched up to `maxDistance`); a kernel without it leaves `GeometryKernel.distance` undefined. */
  distance?(a: S, b: S, maxDistance: number): ShapeDistance | null;
  /** Optional face-level queries (01 §5.9); a kernel without it leaves `GeometryKernel.faceQuery` undefined. */
  readonly faceQuery?: FaceQueryOps<S>;
  release(shape: S): void;
  /** Shape of the loaded blob `sha256` (`loadBlob`); absent = `brep` leaves are unsupported. */
  brep?(sha256: string): S | null;
  /** Keep the B-rep text of blob `sha256` (idempotent) so `brep(sha256)` can build, and rebuild after a cache eviction. */
  loadBlob?(sha256: string, brep: string): void;
  /** Exact import of an exchange file (`GeometryKernel.importShapes`); the ops own the native reader, no recipe is involved. */
  importShapes?(format: 'step' | 'iges', text: string, options: ImportShapesOptions): ImportShapesResult | null;
  /** Kernel description (`GeometryKernel.info`). */
  info?(): KernelInfo;
}

/**
 * What a handle really is; only this module and kernel proxies (via the helpers below) see through it. `recipe` is absent on a key-only
 * handle (sent to a worker that probably still caches the shape).
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

const lawsEqual = (a: EdgeRadius, b: EdgeRadius): boolean => JSON.stringify(a) === JSON.stringify(b);

function build<S>(ops: KernelOps<S>, recipe: ShapeRecipe, child: (r: ShapeRecipe) => S | null): S | null {
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
      if (recipe.op === 'chamfer') return ops.chamfer(source, recipe.edges, recipe.size);
      if (recipe.radii === undefined) return ops.fillet(source, recipe.edges, recipe.size, recipe.sizeEnd);
      const [first] = recipe.radii;
      const uniform = first !== undefined && recipe.radii.every((law) => lawsEqual(law, first));
      if (ops.filletEach !== undefined && !uniform) return ops.filletEach(source, recipe.edges, recipe.radii);
      return uniform && first.sizes === undefined ? ops.fillet(source, recipe.edges, first.size, first.sizeEnd) : null;
    }
    case 'blend': {
      const shapes: S[] = [];
      for (const source of recipe.sources) {
        const shape = child(source);
        if (shape === null) return null;
        shapes.push(shape);
      }
      return ops.blend(shapes, recipe.radius);
    }
    case 'shell': {
      const source = child(recipe.source);
      return source === null ? null : ops.shell(source, recipe.thickness, recipe.openNear);
    }
    case 'place': {
      const source = child(recipe.source);
      return source === null ? null : ops.place(source, recipe.position, recipe.rotation);
    }
    case 'faceOp': {
      const source = child(recipe.source);
      return source === null || ops.faceOp === undefined ? null : ops.faceOp(source, faceOpParamsOf(recipe));
    }
    case 'scale': {
      const source = child(recipe.source);
      return source === null ? null : ops.scale(source, recipe.factor);
    }
    case 'brep':
      return ops.brep?.(recipe.blob) ?? null;
    case 'feature': {
      const source = child(recipe.source);
      const mesh = source !== null && needsReach(recipe) ? ops.tessellate(source) : null;
      if (source === null || (needsReach(recipe) && mesh === null)) return null;
      const reach = mesh === null ? 0 : throughReach(mesh, recipe.frame);
      const lowered = lowerFeature(recipe, reach);
      if (lowered === null) return null;
      const epochBefore = ops.failureEpoch?.() ?? 0;
      const native = ops.feature?.(source, recipe, reach) ?? null;
      if (native === null && (ops.failureEpoch?.() ?? 0) !== epochBefore) return null;
      const tool = native === null ? child(lowered.tool) : null;
      if (native === null && tool === null) return null;
      const cut = native ?? (tool === null ? null : ops.boolean(lowered.mode, source, tool));
      const fillet = recipe.feature === 'pocket' ? recipe.pocket.floorFillet : 0;
      if (cut === null || fillet <= 0 || lowered.pocket === undefined) return cut;
      try {
        const topology = ops.topology(cut);
        const edges = topology === null ? [] : floorEdgeIndices(topology, lowered.pocket, recipe.frame);
        return edges.length === 0 ? null : ops.fillet(cut, edges, fillet);
      } finally {
        ops.release(cut);
      }
    }
  }
}

type OnNative<S> = <T>(handle: ShapeHandle, query: (shape: S) => T | null) => T | null;

/** The public port over `ops`: handles resolve to natives (null shape or any throw -> null, never an exception). */
function faceQueryPort<S>(ops: FaceQueryOps<S> | undefined, onNative: OnNative<S>): FaceQueryPort | undefined {
  if (ops === undefined) return undefined;
  const guard =
    <A extends unknown[], T>(query: (shape: S, ...args: A) => T | null) =>
    (handle: ShapeHandle, ...args: A): T | null => {
      try {
        return onNative(handle, (shape) => query(shape, ...args));
      } catch (error) {
        if (error instanceof Error && error.message.startsWith(SHAPE_NOT_CACHED)) throw error;
        console.warn(`[kernel] face query failed: ${errorMessage(error)}`);
        return null;
      }
    };
  return {
    faceDetails: guard(ops.faceDetails),
    faceContains: guard(ops.faceContains),
    faceGraph: guard(ops.faceGraph),
    faceGeometry: guard(ops.faceGeometry),
    projectOnFace: guard(ops.projectOnFace),
    evaluateFace: guard(ops.evaluateFace),
    tessellateFace: guard(ops.tessellateFace),
    faceSamples: guard(ops.faceSamples),
    edgeSamples: guard(ops.edgeSamples),
    edgeContinuity: guard(ops.edgeContinuity),
    distance: guard(ops.distance),
    bspline: guard(ops.bspline),
  };
}

/**
 * Wrap native ops as a recipe-evaluating `GeometryKernel` with an LRU of `capacity` native shapes. Failed recipes (null) are cached too, so
 * a refused fillet is not retried on every replay.
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
    let shape: S | null;
    try {
      builds++;
      shape = build(ops, recipe, evaluateNative);
    } catch (error) {
      console.warn(`[kernel] ${recipe.op} failed: ${errorMessage(error)}`);
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
  const analyzeOps = ops.analyze?.bind(ops);
  const distanceOps = ops.distance?.bind(ops);
  const faceQuery = faceQueryPort(ops.faceQuery, (handle, query) =>
    call(() => {
      const shape = nativeOf(handle);
      return shape === null ? null : query(shape);
    }),
  );
  const massOps = ops.massProperties?.bind(ops);
  const loadBlobOps = ops.loadBlob?.bind(ops);
  const loadedBlobs = new Set<string>();
  const importOps = ops.importShapes?.bind(ops);
  const assemblyOps = ops.exportStepAssembly?.bind(ops);
  const infoOps = ops.info?.bind(ops);
  return {
    ...(faceQuery === undefined ? {} : { faceQuery }),
    ...(ops.name === undefined ? {} : { name: ops.name }),
    ...(infoOps === undefined
      ? {}
      : {
          info: (): KernelInfo => {
            const own = infoOps();
            const wired = [
              ...(analyzeOps === undefined ? [] : ['analyze']),
              ...(distanceOps === undefined ? [] : ['distance']),
              ...(massOps === undefined ? [] : ['massProperties']),
              ...(importOps === undefined ? [] : ['importShapes']),
              ...(assemblyOps === undefined ? [] : ['exportStepAssembly']),
              ...(faceQuery === undefined ? [] : ['faceQuery']),
              ...(ops.brep === undefined ? [] : ['brepBlobs']),
            ];
            return { ...own, capabilities: [...new Set([...own.capabilities, ...wired])] };
          },
        }),
    ...(assemblyOps === undefined
      ? {}
      : {
          exportStepAssembly: (occurrences: readonly StepOccurrence[]): string | null =>
            call(() => {
              const parts = new Map<StepAssemblyPart, StepAssemblyPart<S> | null>();
              const nativePart = (source: StepAssemblyPart): StepAssemblyPart<S> | null => {
                const known = parts.get(source);
                if (known !== undefined) return known;
                parts.set(source, null);
                const natives = source.shapes.map(nativeOf);
                if (natives.some((shape) => shape === null)) return null;
                const children: StepOccurrence<S>[] = [];
                for (const child of source.children ?? []) {
                  const part = nativePart(child.part);
                  if (part === null) return null;
                  children.push({ ...child, part });
                }
                const native: StepAssemblyPart<S> = { shapes: natives as S[], ...(children.length > 0 ? { children } : {}) };
                parts.set(source, native);
                return native;
              };
              const placed: StepOccurrence<S>[] = [];
              for (const occurrence of occurrences) {
                const part = nativePart(occurrence.part);
                if (part === null) return null;
                placed.push({ ...occurrence, part });
              }
              return assemblyOps(placed);
            }),
        }),
    ...(importOps === undefined ? {} : { importShapes: (format, text, options) => call(() => importOps(format, text, options)) }),
    ...(loadBlobOps === undefined
      ? {}
      : {
          loadBlob: (sha256: string, brep: string): void => {
            if (loadedBlobs.has(sha256)) return;
            if (sha256Hex(brep) !== sha256) {
              console.warn(`[kernel] KRN_BLOB_HASH_MISMATCH: blob ${sha256} refused (its text hashes differently)`);
              return;
            }
            loadBlobOps(sha256, brep);
            loadedBlobs.add(sha256);
            for (const [key, shape] of shapes) if (shape === null) shapes.delete(key); // a null may have been "blob missing"
            for (const [key, mesh] of meshes) if (mesh === null) meshes.delete(key);
          },
        }),
    ...(analyzeOps === undefined
      ? {}
      : {
          analyze: (handle: ShapeHandle): ShapeAnalysis | null =>
            call(() => {
              const shape = nativeOf(handle);
              return shape === null ? null : analyzeOps(shape);
            }),
        }),
    ...(massOps === undefined
      ? {}
      : {
          massProperties: (handle: ShapeHandle): ExactMassProperties | null =>
            call(() => {
              const shape = nativeOf(handle);
              return shape === null ? null : massOps(shape);
            }),
        }),
    ...(distanceOps === undefined
      ? {}
      : {
          distance: (a: ShapeHandle, b: ShapeHandle, maxDistance: number): ShapeDistance | null =>
            call(() => {
              const [first, second] = [nativeOf(a), nativeOf(b)];
              return first === null || second === null ? null : distanceOps(first, second, maxDistance);
            }),
        }),
    supports: (op) =>
      op === 'brep' ? ops.brep !== undefined : op === 'faceOp' ? ops.faceOp !== undefined : !(ops.unsupported?.has(op) ?? false),
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
