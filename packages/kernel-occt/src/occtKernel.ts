/**
 * OpenCascade.js (OCC WASM) geometry kernel, opt-in via `?kernel=occt` / `LLULL_KERNEL=occt`
 * (Manifold is the default). Measurements and API notes: docs/decisions/KI4-occt-spike.md.
 *
 * @layer kernel
 * @invariant implemented: booleanOp (every solid kind), filletEdges, chamferEdges, shellSolid (mesh -> sewn solid), tessellate (every solid kind)
 * @failure unsupported kind / non-manifold mesh / OCC refusal or failure -> null
 */

import type { GeometryKernel, MeshData, BooleanOp } from '@core/geometry/kernel';
import type { Entity } from '@core/model/types';
import { errorMessage } from '@lib/errorMessage';
import { clearTangentContact } from './tangentGuard';
import { entityToOccShape, meshDataToTopoDSShape } from './occtShapes';
import {
  explorer,
  release,
  type OccApi,
  type OccBuilder,
  type OccFilletMaker,
  type OccHandle,
  type OccOffsetMaker,
  type OccShape,
  type OccTopoDS,
  type OccTriangulation,
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

    return factory(opts);
  })();

  return _modulePromise;
}

function extractMeshData(api: OccApi, shape: OccShape): MeshData | null {
  const mesher = new api.BRepMesh_IncrementalMesh_2(shape, 0.1, false, 0.5, false) as OccHandle & {
    Perform(): void;
  };
  mesher.Perform();

  const positions: number[] = [];
  const indices: number[] = [];
  let vertexOffset = 0;

  const exp = explorer(api, shape, 'TopAbs_FACE');

  while (exp.More()) {
    const current = exp.Current();
    const face = (api.TopoDS as OccTopoDS).Face_1(current);
    const loc = new api.TopLoc_Location_1() as OccHandle & { Transformation(): OccHandle };
    const triangulation = api.BRep_Tool.Triangulation(face, loc) as OccTriangulation;

    if (!triangulation.IsNull()) {
      const tri = triangulation.get();
      const nNodes = tri.NbNodes();
      const nTris = tri.NbTriangles();

      // Nodes are stored in the face's own frame; `loc` carries the shape's placement (a prism's
      // top face, a transformed shape's faces), so bring them into world space.
      const placement = loc.Transformation();
      for (let i = 1; i <= nNodes; i++) {
        const node = tri.Node(i);
        node.Transform(placement);
        positions.push(node.X(), node.Y(), node.Z());
        release(node);
      }
      release(placement);

      // A REVERSED face's stored triangles wind against the solid's outward normal: flip them.
      const reversed = face.Orientation_1().value === api.TopAbs_Orientation.TopAbs_REVERSED.value;
      for (let i = 1; i <= nTris; i++) {
        const t = tri.Triangle(i);
        const [first, second, third] = [t.Value(1), t.Value(2), t.Value(3)];
        indices.push(
          vertexOffset + first - 1,
          vertexOffset + (reversed ? third : second) - 1,
          vertexOffset + (reversed ? second : third) - 1,
        );
        release(t);
      }

      vertexOffset += nNodes;
    }

    release(triangulation);
    release(face);
    release(current);
    loc.delete();
    exp.Next();
  }

  exp.delete();
  mesher.delete();

  if (positions.length === 0) return null;
  return { positions, indices };
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
 * shell. Booleans on near-tangent input are different: the same `___cxa_*` failure there leaves the
 * module returning spurious nulls (cone apex on a face), so it counts. A WASM trap
 * (`WebAssembly.RuntimeError`) or a thrown non-Error always counts; other JS Errors are
 * binding/programming faults that do not touch module state.
 */
function degradesModule(error: unknown, operation: OperationClass): boolean {
  if (!(error instanceof Error)) return true;
  if (error.constructor.name === 'RuntimeError') return true; // WebAssembly.RuntimeError (a trap)
  return (
    operation === 'boolean' && error instanceof ReferenceError && /___cxa_/.test(error.message)
  );
}

type OperationClass = 'boolean' | 'round';

/** Run `body`, mapping any OCC exception to null and releasing every handle it registered. */
function withHandles(
  operation: OperationClass,
  body: (own: <T extends OccHandle | null>(handle: T) => T) => MeshData | null,
): MeshData | null {
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
 * Fillet or chamfer the selected edges of a closed mesh solid (both builders share `Add_2(size,
 * edge)`): rebuild a sewn solid, add the edges, build, mesh the result.
 * @failure size <= 0, empty or non-closed mesh, builder not done -> null
 */
function roundEdges(
  api: OccApi,
  label: string,
  mesh: MeshData,
  edgeIndices: number[],
  size: number,
  makeBuilder: (solid: OccShape) => OccFilletMaker,
): MeshData | null {
  if (!(size > 0) || mesh.positions.length === 0) return null;
  return withHandles('round', (own) => {
    const solid = own(meshDataToTopoDSShape(api, mesh));
    if (!solid) {
      console.warn(
        `[occtKernel] ${label}: could not reconstruct a manifold solid from MeshData ` +
          '(non-manifold mesh, open shell, or degenerate triangles). Returning null.',
      );
      return null;
    }
    const maker = own(makeBuilder(solid));
    const edgeExp = explorer(api, solid, 'TopAbs_EDGE');
    const edgeSet = edgeIndices.length > 0 ? new Set(edgeIndices) : null;
    for (let edgeIdx = 0; edgeExp.More(); edgeIdx++, edgeExp.Next()) {
      if (edgeSet && !edgeSet.has(edgeIdx)) continue;
      const current = edgeExp.Current();
      const edge = (api.TopoDS as OccTopoDS).Edge_1(current);
      try {
        maker.Add_2(size, edge);
      } catch {
        // Degenerate or seam edge: skip.
      }
      release(edge);
      release(current);
    }
    edgeExp.delete();
    maker.Build();
    return maker.IsDone() ? extractMeshData(api, own(maker.Shape())) : null;
  });
}

/**
 * Create an OCC-backed geometry kernel.
 * @param options injected `wasmBinary` / `locateFile` (see OcctKernelOptions)
 */
export async function createOcctKernel(options: OcctKernelOptions = {}): Promise<GeometryKernel> {
  const api = await getOccModule(options);

  return {
    booleanOp(op: BooleanOp, a: Entity, b: Entity): MeshData | null {
      const [operandA, operandB] = clearTangentContact(a, b);
      return withHandles('boolean', (own) => {
        const shapeA = own(entityToOccShape(api, operandA));
        const shapeB = shapeA && own(entityToOccShape(api, operandB));
        if (!shapeA || !shapeB) return null;
        const builder = own(new api[BOOLEAN_BUILDERS[op]](shapeA, shapeB) as OccBuilder);
        return builder.IsDone() ? extractMeshData(api, own(builder.Shape())) : null;
      });
    },

    /** @param edgeIndices 0-based edge indices to fillet; empty = all edges */
    filletEdges(shape: MeshData, edgeIndices: number[], radius: number): MeshData | null {
      return roundEdges(api, 'filletEdges', shape, edgeIndices, radius, (solid) => {
        return new api.BRepFilletAPI_MakeFillet(solid, api.ChFi3d_FilletShape.ChFi3d_Rational);
      });
    },

    /** @param edgeIndices 0-based edge indices to chamfer; empty = all edges */
    chamferEdges(shape: MeshData, edgeIndices: number[], distance: number): MeshData | null {
      return roundEdges(api, 'chamferEdges', shape, edgeIndices, distance, (solid) => {
        return new api.BRepFilletAPI_MakeChamfer(solid);
      });
    },

    /** Closed hollow: the solid minus its inward offset by `thickness` (a sealed internal cavity). */
    shellSolid(shape: MeshData, thickness: number): MeshData | null {
      if (!(thickness > 0) || shape.positions.length === 0) return null;
      return withHandles('round', (own) => {
        const solid = own(meshDataToTopoDSShape(api, shape));
        if (!solid) return null;
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
        if (!offset.IsDone()) return null;
        const cavity = own(offset.Shape());
        const cut = own(new api.BRepAlgoAPI_Cut_3(solid, cavity) as OccBuilder);
        cut.Build();
        return cut.IsDone() ? extractMeshData(api, own(cut.Shape())) : null;
      });
    },

    tessellate(entity: Entity): MeshData | null {
      return withHandles('round', (own) => {
        const shape = own(entityToOccShape(api, entity));
        return shape && extractMeshData(api, shape);
      });
    },
  };
}
