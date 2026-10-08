/**
 * OpenCascade.js (OCC WASM) geometry kernel, opt-in via `?kernel=occt` / `LLULL_KERNEL=occt`
 * (Manifold is the default). Measurements and API notes: docs/decisions/KI4-occt-spike.md.
 *
 * The kernel boundary is the exact shape: recipes evaluate to TopoDS_Shapes cached by recipe key
 * (`kernelFromOps`); booleans, fillets, chamfers and shells run on those B-reps (true edges and faces,
 * never re-sewn triangles); meshes only come out for display; STEP is written from the B-rep.
 *
 * @layer kernel
 * @invariant exact for every solid kind but `mesh` without `brep` and `pyramid` (sewn planar triangles)
 * @failure unsupported kind / non-manifold mesh / OCC refusal or failure -> null
 */

import type { BooleanOp, ShapeRecipe } from '@core/geometry/shapeRecipe';
import type { Vec3 } from '@core/model/types';
import { kernelFromOps, type CachingKernel, type KernelOps } from '@core/geometry/shapeKernel';
import { errorMessage } from '@lib/errorMessage';
import { clearTangentContact } from './tangentGuard';
import { entityToOccShape, placementTransform, transformedCopy } from './occtShapes';
import { extractMeshData } from './occtMesh';
import { shapeTopology, uniqueSubShapes } from './occtTopology';
import { writeStep } from './occtStep';
import {
  release,
  type OccApi,
  type OccBuilder,
  type OccFilletMaker,
  type OccHandle,
  type OccOffsetMaker,
  type OccShape,
} from './occtTypes';

/** Injected loader inputs: core never fetches; the caller supplies WASM bytes or a locator. */
interface OcctKernelOptions {
  /** Pre-loaded WASM bytes (Node). */
  readonly wasmBinary?: ArrayBuffer | Uint8Array;
  /** Maps an asset path to a URL/path (browser). */
  readonly locateFile?: (path: string) => string;
  /** Emscripten factory of the OCC glue; defaults to `opencascade.js/dist/opencascade.wasm.js`. */
  readonly factory?: OcctFactory;
}

export type OcctFactory = (moduleOptions: Record<string, unknown>) => Promise<OccApi>;

let _modulePromise: Promise<OccApi> | null = null;

/**
 * Load and initialise the OpenCascade.js WASM module once, then cache.
 * Returns the OCC API object. Throws if the WASM cannot be loaded.
 *
 * Note: In a browser, the 63 MB WASM must be served as a static asset.
 * In Vite, add the WASM file to `publicDir` or use `vite-plugin-wasm`.
 * In Node.js (server/tests), pass the WASM as `wasmBinary` — see
 * server/src/occtNode.ts for the pattern.
 */
async function getOccModule(options: OcctKernelOptions): Promise<OccApi> {
  if (_modulePromise) return _modulePromise;

  _modulePromise = (async () => {
    const factory: OcctFactory =
      options.factory ?? (await import('opencascade.js/dist/opencascade.wasm.js')).default;

    const opts: Record<string, unknown> = {};
    if (options.wasmBinary) opts['wasmBinary'] = options.wasmBinary;
    if (options.locateFile) opts['locateFile'] = options.locateFile;
    opts['print'] = () => undefined; // OCC's stdout chatter (STEP transfer statistics)

    return factory(opts);
  })();

  return _modulePromise;
}

const BOOLEAN_BUILDERS: Readonly<Record<BooleanOp, string>> = {
  union: 'BRepAlgoAPI_Fuse_3',
  subtract: 'BRepAlgoAPI_Cut_3',
  intersect: 'BRepAlgoAPI_Common_3',
};

/**
 * Whether `error` (thrown by an OCC call) means the WASM module itself is degraded, as opposed to
 * OCC gracefully refusing the input. This build has no C++ exception support, so ANY thrown C++
 * exception (StdFail_NotDone, e.g. a fillet radius that is too large) surfaces as a JS
 * `ReferenceError` for a missing `___cxa_*` import; those are graceful refusals for fillet/chamfer/
 * shell. Booleans on near-tangent input are different: the same `___cxa_*` failure there (while
 * building, or later while meshing / exploring / writing the suspect result) leaves the module
 * returning spurious nulls (cone apex on a face), so it counts. A WASM trap
 * (`WebAssembly.RuntimeError`) or a thrown non-Error always counts; other JS Errors are
 * binding/programming faults that do not touch module state.
 */
/** `WebAssembly.RuntimeError` (a trap), read from the global: not every TS lib declares the value. */
const TrapError = (globalThis as { WebAssembly?: { RuntimeError?: new () => Error } }).WebAssembly
  ?.RuntimeError;

function degradesModule(error: unknown, operation: OperationClass): boolean {
  if (!(error instanceof Error)) return true;
  if (TrapError !== undefined && error instanceof TrapError) return true; // a WASM trap
  return (
    operation === 'fragile' && error instanceof ReferenceError && /___cxa_/.test(error.message)
  );
}

/** 'refusal': a C++ exception is a graceful no; 'fragile': it may have degraded the module. */
type OperationClass = 'fragile' | 'refusal';

/** Run `body`, mapping any OCC exception to null and releasing every handle it registered. */
function guarded<T>(
  operation: OperationClass,
  body: (own: <H extends OccHandle | null>(handle: H) => H) => T | null,
): T | null {
  const owned: Array<OccHandle | null> = [];
  try {
    return body((handle) => {
      owned.push(handle);
      return handle;
    });
  } catch (error) {
    if (degradesModule(error, operation)) nativeFailures++;
    if (error instanceof Error)
      console.warn(`[occtKernel] OCC operation failed: ${errorMessage(error)}`);
    return null;
  } finally {
    owned.forEach(release);
  }
}

let nativeFailures = 0;

/**
 * Operations that left the WASM module degraded since load (a trap, a non-Error throw, or a boolean
 * that died in a C++ exception). After one, later booleans on the same module can fail spuriously,
 * so a host that can restart the module (the worker-thread kernel) should do so when this count
 * grows. Graceful refusals (fillet radius too large, boolean `IsDone() == false`) are not counted.
 */
export function nativeFailureCount(): number {
  return nativeFailures;
}

/**
 * Fillet or chamfer the selected unique edges of an exact solid (both builders share
 * `Add_2(size, edge)`); the input shape is left untouched.
 * @failure size <= 0, a selected index out of range, no edge, builder not done -> null
 */
function roundEdges(
  api: OccApi,
  shape: OccShape,
  edgeIndices: readonly number[],
  size: number,
  makeBuilder: (solid: OccShape) => OccFilletMaker,
): OccShape | null {
  if (!(size > 0)) return null;
  return guarded('refusal', (own) => {
    const edges = uniqueSubShapes(api, shape, 'TopAbs_EDGE').map(own);
    if (edgeIndices.some((index) => edges[index] === undefined)) return null;
    const selected =
      edgeIndices.length > 0
        ? edgeIndices.flatMap((index) => {
            const edge = edges[index];
            return edge === undefined ? [] : [edge];
          })
        : edges;
    if (selected.length === 0) return null;
    const maker = own(makeBuilder(shape));
    for (const current of selected) {
      try {
        maker.Add_2(size, own(api.TopoDS.Edge_1(current) as OccShape));
      } catch {
        // Degenerate or seam edge: skip.
      }
    }
    maker.Build();
    return maker.IsDone() ? maker.Shape() : null;
  });
}

/** Closed hollow: the solid minus its inward offset by `thickness` (a sealed internal cavity). */
function hollow(api: OccApi, solid: OccShape, thickness: number): OccShape | null {
  if (!(thickness > 0)) return null;
  const cavity = guarded('refusal', (own) => {
    const offset = own(new api.BRepOffsetAPI_MakeOffsetShape_1() as OccOffsetMaker);
    offset.PerformByJoin(
      solid,
      -thickness,
      1e-4,
      api.BRepOffset_Mode.BRepOffset_Skin,
      false,
      false,
      api.GeomAbs_JoinType.GeomAbs_Arc,
      false,
    );
    return offset.IsDone() ? offset.Shape() : null;
  });
  if (cavity === null) return null;
  // The cut is a boolean: a native failure there may degrade the module (see degradesModule).
  return guarded('fragile', (own) => {
    own(cavity);
    const cut = own(new api.BRepAlgoAPI_Cut_3(solid, cavity) as OccBuilder);
    cut.Build();
    return cut.IsDone() ? cut.Shape() : null;
  });
}

/** Copy of `shape` under a transform built by `makeTransform` (released afterwards). */
function transformed(
  api: OccApi,
  shape: OccShape,
  makeTransform: () => OccHandle,
): OccShape | null {
  return guarded('refusal', (own) => transformedCopy(api, shape, own(makeTransform())));
}

/** Booleans of two primitive leaves: open a hair-gap at a sphere/box point contact (tangentGuard). */
function untangle(a: ShapeRecipe, b: ShapeRecipe): [ShapeRecipe, ShapeRecipe] {
  if (a.op !== 'solid' || b.op !== 'solid') return [a, b];
  const [entityA, entityB] = clearTangentContact(a.entity, b.entity);
  return [
    entityA === a.entity ? a : { op: 'solid', entity: entityA },
    entityB === b.entity ? b : { op: 'solid', entity: entityB },
  ];
}

/** Native OCC operations behind the recipe evaluator. */
export function occtOps(api: OccApi): KernelOps<OccShape> {
  return {
    failureEpoch: nativeFailureCount,
    solid: (entity) => guarded('refusal', () => entityToOccShape(api, entity)),
    prepareBoolean: untangle,
    boolean: (op: BooleanOp, a, b) =>
      guarded('fragile', (own) => {
        const builder = own(new api[BOOLEAN_BUILDERS[op]](a, b) as OccBuilder);
        return builder.IsDone() ? builder.Shape() : null;
      }),
    fillet: (shape, edges, radius) =>
      roundEdges(api, shape, edges, radius, (solid) => {
        return new api.BRepFilletAPI_MakeFillet(solid, api.ChFi3d_FilletShape.ChFi3d_Rational);
      }),
    chamfer: (shape, edges, distance) =>
      roundEdges(api, shape, edges, distance, (solid) => new api.BRepFilletAPI_MakeChamfer(solid)),
    shell: (shape, thickness) => hollow(api, shape, thickness),
    place: (shape, position: Vec3, rotation: Vec3) =>
      transformed(api, shape, () => placementTransform(api, rotation, position)),
    scale: (shape, factor) =>
      factor > 0
        ? transformed(api, shape, () => {
            const transform = new api.gp_Trsf_1();
            const origin: OccHandle = new api.gp_Pnt_3(0, 0, 0);
            transform.SetScale(origin, factor);
            release(origin);
            return transform as OccHandle;
          })
        : null,
    tessellate: (shape) => guarded('fragile', () => extractMeshData(api, shape)),
    topology: (shape) => guarded('fragile', () => shapeTopology(api, shape)),
    exportStep: (shapes) => guarded('fragile', () => writeStep(api, shapes)),
    release,
  };
}

/**
 * Create an OCC-backed geometry kernel.
 * @param options injected `wasmBinary` / `locateFile` (see OcctKernelOptions)
 */
export async function createOcctKernel(options: OcctKernelOptions = {}): Promise<CachingKernel> {
  const api = await getOccModule(options);
  return kernelFromOps(occtOps(api));
}
