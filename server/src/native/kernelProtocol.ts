/**
 * Wire vocabulary of the native `llull-kernel` sidecar (RS-1; Rust side: solver/bins/llull-kernel/src/session.rs). One JSON object per
 * line both ways: request `{ id, op, args }`, reply `{ id, result, error? }`. Ops and argument shapes are the `KernelOps` worker protocol
 * (`occtWorkerProtocol.ts`) with two rewrites made here: `evaluate` takes a handle `{ key, recipe }` instead of a bare recipe (the
 * sidecar caches by the host's recipe key), and `tessellate` answers base64 little-endian arrays (decoded by `decodeMesh`).
 * @invariant pure: no process, no I/O
 */

import type { Entity, MeshData, ShapeRecipe, Vec3 } from '@core/model/types';
import { createEmptyDocument } from '@core/model/types';
import { entityTrianglePositions } from '@core/geometry/entityTriangles';
import { orientOutward } from '@core/geometry/meshVolume';
import { recipeKey } from '@core/geometry/shapeRecipe';
import { clearTangentContact } from '@kernel-occt/tangentGuard';
import { nativeLeaf } from './kernelLeaves';

/** The op or recipe node is not native yet: the host answers it with the WASM kernel. */
const NATIVE_UNSUPPORTED = 'NATIVE_UNSUPPORTED';
/** The sidecar process died or could not be reached during a call. */
export const NATIVE_DIED = 'NATIVE_DIED';

export interface NativeReply {
  readonly id: number;
  readonly result: unknown;
  readonly error?: string;
}

/** What the sidecar answers to `info`. */
export interface NativeInfo {
  readonly occtVersion: string;
  readonly build: string;
  readonly capabilities: readonly string[];
  readonly ops: readonly string[];
}

export function encodeRequest(id: number, op: string, args: readonly unknown[]): string {
  return `${JSON.stringify({ id, op, args })}\n`;
}

/** A reply line, or null for anything else on stdout (a stray library print must not break the session). */
export function parseReplyLine(line: string): NativeReply | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || !('id' in value) || !('result' in value)) return null;
  const { id, result, error } = value as { id: unknown; result: unknown; error?: unknown };
  if (typeof id !== 'number') return null;
  return typeof error === 'string' ? { id, result, error } : { id, result };
}

export function isUnsupported(error: string | undefined): boolean {
  return error?.startsWith(NATIVE_UNSUPPORTED) === true;
}

export function parseNativeInfo(value: unknown): NativeInfo | null {
  if (typeof value !== 'object' || value === null) return null;
  const { occtVersion, build, capabilities, ops } = value as Record<string, unknown>;
  const strings = (list: unknown): list is string[] => Array.isArray(list) && list.every((item) => typeof item === 'string');
  if (typeof occtVersion !== 'string' || typeof build !== 'string' || !strings(capabilities) || !strings(ops)) return null;
  return { occtVersion, build, capabilities, ops };
}

/** `tessellate` reply -> MeshData (plain arrays, like the WASM kernel's); other values pass through (null stays null). */
export function decodeMesh(result: unknown): MeshData | null {
  if (typeof result !== 'object' || result === null) return null;
  const { encoding, positions, indices } = result as Record<string, unknown>;
  if (encoding !== 'base64-le' || typeof positions !== 'string' || typeof indices !== 'string') return null;
  const read = <T extends Float64Array | Uint32Array>(text: string, View: new (buffer: ArrayBuffer) => T, size: number): number[] => {
    const bytes = Buffer.from(text, 'base64');
    if (bytes.length % size !== 0) throw new Error('native mesh: truncated array');
    const copy = new ArrayBuffer(bytes.length);
    new Uint8Array(copy).set(bytes);
    return Array.from(new View(copy));
  };
  return { positions: read(positions, Float64Array, 8), indices: read(indices, Uint32Array, 4) };
}

const NO_COMPONENTS = createEmptyDocument();

/**
 * Pyramids are sewn from their triangles by the WASM kernel too (occtShapes.ts TRIANGULATED_KINDS): send the same triangles. Curved
 * profiles, lofts, sweeps and subdivision solids carry their host-computed geometry (`nativeLeaf`).
 */
function asNativeLeaf(entity: Entity): Entity {
  if (entity.kind !== 'pyramid') return nativeLeaf(entity);
  const positions = entityTrianglePositions(entity, NO_COMPONENTS);
  const { id, layerId, color } = entity;
  return {
    id,
    kind: 'mesh',
    layerId,
    color,
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    mesh: { positions, indices: orientOutward(positions, []) },
  };
}

/** The WASM kernel's boolean pre-flight (occtKernel.ts `untangle`): a sphere tangent to a box face is shrunk by a hair. */
function untangle(a: ShapeRecipe, b: ShapeRecipe): [ShapeRecipe, ShapeRecipe] {
  if (a.op !== 'solid' || b.op !== 'solid') return [a, b];
  const [entityA, entityB] = clearTangentContact(a.entity, b.entity);
  return [entityA === a.entity ? a : { op: 'solid', entity: entityA }, entityB === b.entity ? b : { op: 'solid', entity: entityB }];
}

type FeatureRecipe = Extract<ShapeRecipe, { op: 'feature' }>;

/**
 * A `feature` node lowered by the host (`kernelFeatures.ts`): the lowered compound `tool` (null = the lowering refused the node), its
 * boolean `mode`, and the inputs of the native BRepFeat cut tried first, like the WASM kernel (occtFeatures.ts).
 */
export interface FeatureLowering {
  readonly tool: ShapeRecipe | null;
  readonly mode: 'subtract' | 'union';
  readonly holes?: { readonly profiles: readonly number[][]; readonly origins: readonly Vec3[]; readonly normal: Vec3 };
  readonly pocket?: {
    readonly chain: readonly number[];
    readonly origin: Vec3;
    readonly normal: Vec3;
    readonly probes: readonly number[];
    readonly length: number;
  };
}

export type FeatureLowerings = ReadonlyMap<FeatureRecipe, FeatureLowering>;

const NO_LOWERINGS: FeatureLowerings = new Map();

/**
 * The recipe the sidecar builds: the same B-rep inputs the WASM kernel would build from `recipe`. A `feature` node with an entry in
 * `features` becomes a `featureCut` node; one without stays a `feature` node, which the sidecar answers NATIVE_UNSUPPORTED.
 */
export function nativeRecipe(recipe: ShapeRecipe, features: FeatureLowerings = NO_LOWERINGS): ShapeRecipe {
  const child = (node: ShapeRecipe): ShapeRecipe => nativeRecipe(node, features);
  switch (recipe.op) {
    case 'solid': {
      const entity = asNativeLeaf(recipe.entity);
      return entity === recipe.entity ? recipe : { op: 'solid', entity };
    }
    case 'boolean': {
      const [a, b] = untangle(recipe.a, recipe.b);
      return { ...recipe, a: child(a), b: child(b) };
    }
    case 'blend':
      return { ...recipe, sources: recipe.sources.map(child) };
    case 'brep':
      return recipe;
    case 'feature': {
      const lowering = features.get(recipe);
      if (lowering === undefined) return { ...recipe, source: child(recipe.source) };
      const cut = {
        ...lowering,
        op: 'featureCut',
        source: child(recipe.source),
        tool: lowering.tool === null ? null : child(lowering.tool),
      };
      return cut as unknown as ShapeRecipe;
    }
    default:
      return { ...recipe, source: child(recipe.source) };
  }
}

interface WireHandle {
  readonly key: string;
  readonly recipe?: ShapeRecipe;
}

function nativeHandle(handle: unknown, features: FeatureLowerings): unknown {
  if (typeof handle !== 'object' || handle === null || !('key' in handle)) return handle;
  const { key, recipe } = handle as WireHandle;
  return recipe === undefined ? { key } : { key, recipe: nativeRecipe(recipe, features) };
}

export const SINGLE_SHAPE_OPS: ReadonlySet<string> = new Set(['tessellate', 'massProperties', 'analyze']);

/** Arguments of a `KernelOps` request rewritten for the sidecar (see the module comment); `features` lowers its feature nodes. */
export function nativeArgs(op: string, args: readonly unknown[], features: FeatureLowerings = NO_LOWERINGS): readonly unknown[] {
  if (op === 'evaluate') {
    const recipe = args[0] as ShapeRecipe;
    return [{ key: recipeKey(recipe), recipe: nativeRecipe(recipe, features) }];
  }
  if (SINGLE_SHAPE_OPS.has(op)) return [nativeHandle(args[0], features), ...args.slice(1)];
  if (op === 'exportStep' && Array.isArray(args[0])) return [args[0].map((handle) => nativeHandle(handle, features))];
  return args;
}
