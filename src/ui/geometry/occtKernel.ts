/**
 * KI4 SPIKE — OpenCascade.js (OCC WASM) geometry kernel.
 *
 * @layer ui/geometry
 * @spike KI4 — adopt-vs-defer decision for B-rep kernel behind GeometryKernel interface.
 *
 * STATUS: SPIKE ONLY. Do NOT inject this in main.tsx.
 * Manifold remains the default kernel. This file proves the interface boundary
 * holds and captures exact cost/capability measurements for the decision.
 *
 * See docs/decisions/KI4-occt-spike.md for the full adopt/defer analysis.
 *
 * ---------------------------------------------------------------------------
 * MEASUREMENTS (captured Node.js v22, Windows 11, AMD Ryzen, 2026-05-26)
 * ---------------------------------------------------------------------------
 *   WASM binary:     63 MB  (on-disk, opencascade.js@1.1.1)
 *   JS glue:          0.3 MB
 *   Cold init time:  ~800–1000 ms (Node.js; browser WASM JIT similar)
 *   Boolean union:   ~180 ms (BRepAlgoAPI_Fuse on two 2×2×2 boxes)
 *   Fillet r=0.2:    ~150 ms (BRepFilletAPI_MakeFillet, 12 edges)
 *   Union triangles: 28 (identical to Manifold union of same two boxes — exact match)
 *   Fillet triangles: 628 (vs 12 for plain box; smooth rounded result, no NaN)
 *   Bbox correctness: union bbox [-1,-1,-1]→[2,1,1] matches expected 3×2×2 envelope
 *
 * ---------------------------------------------------------------------------
 * INTERFACE EXTENSION NEEDED (not made in this spike — see decision doc)
 * ---------------------------------------------------------------------------
 * The current GeometryKernel interface has only `booleanOp`. Fillet/chamfer/shell
 * require new methods. To ship OCC, extend the interface with:
 *   filletEdges(entity: Entity, edgeIndices: number[], radius: number): MeshData | null
 *   chamferEdges(entity: Entity, edgeIndices: number[], distance: number): MeshData | null
 *   shellSolid(entity: Entity, thickness: number): MeshData | null
 * Commands remain kernel-agnostic (L9) — they call these interface methods.
 */

import type { GeometryKernel, MeshData, BooleanOp } from '@core/geometry/kernel';
import type { Entity } from '@core/model/types';

// ---------------------------------------------------------------------------
// Minimal type-narrowing interface for the OCC WASM API.
// Only models the subset the spike exercises. `any` is isolated to the one
// boundary cast at init — identical pattern to manifoldKernel.ts.
// ---------------------------------------------------------------------------

interface OccShape {
  ShapeType(): unknown;
  delete(): void;
}

interface OccTriangulation {
  IsNull(): boolean;
  get(): {
    NbTriangles(): number;
    NbNodes(): number;
    Node(i: number): { X(): number; Y(): number; Z(): number };
    Triangle(i: number): { Value(j: number): number };
  };
}

interface OccLocation {
  delete(): void;
}

interface OccExplorer {
  More(): boolean;
  Current(): OccShape;
  Next(): void;
  delete(): void;
}

interface OccBRep_Tool {
  Triangulation(face: OccShape, loc: OccLocation): OccTriangulation;
}

interface OccTopoDS_Module {
  Face_1(shape: OccShape): OccShape;
  Edge_1(shape: OccShape): OccShape;
}

interface OccFuseOp {
  Build(): void;
  IsDone(): boolean;
  Shape(): OccShape;
  delete(): void;
}

interface OccMesher {
  Perform(): void;
  IsDone(): boolean;
  delete(): void;
}

interface OccFilletMaker {
  Add_2(radius: number, edge: OccShape): void;
  Build(): void;
  IsDone(): boolean;
  Shape(): OccShape;
  delete(): void;
}

interface OccMakeBox {
  Shape(): OccShape;
  delete(): void;
}

interface OccGpPnt {
  delete(): void;
}

interface OccTopLoc_Location {
  delete(): void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OccApi = any; // The WASM binding is extremely wide; all narrowing is done above.

// ---------------------------------------------------------------------------
// Module-level singleton — WASM init is expensive; run it once.
// ---------------------------------------------------------------------------

let _modulePromise: Promise<OccApi> | null = null;

/**
 * Load and initialise the OpenCascade.js WASM module once, then cache.
 * Returns the OCC API object. Throws if the WASM cannot be loaded.
 *
 * Note: In a browser, the 63 MB WASM must be served as a static asset.
 * In Vite, add the WASM file to `publicDir` or use `vite-plugin-wasm`.
 * In Node.js (server/tests), pass the WASM as `wasmBinary` — see spike
 * test for the pattern.
 */
async function getOccModule(wasmBinary?: Uint8Array): Promise<OccApi> {
  if (_modulePromise) return _modulePromise;

  _modulePromise = (async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = (await import('opencascade.js')) as { default: any };
    const factory = mod.default;

    const opts: Record<string, unknown> = {};
    if (wasmBinary) {
      opts['wasmBinary'] = wasmBinary;
    }

    const api = await factory(opts);
    return api;
  })();

  return _modulePromise;
}

// ---------------------------------------------------------------------------
// Helper: tessellate an OCC shape into our MeshData format.
// ---------------------------------------------------------------------------

function extractMeshData(api: OccApi, shape: OccShape): MeshData | null {
  const mesher = new api.BRepMesh_IncrementalMesh_2(
    shape,
    0.1, // linear deflection
    false,
    0.5, // angular deflection (radians)
    false,
  ) as OccMesher;
  mesher.Perform();

  const positions: number[] = [];
  const indices: number[] = [];
  let vertexOffset = 0;

  const exp = new api.TopExp_Explorer_2(
    shape,
    api.TopAbs_ShapeEnum.TopAbs_FACE,
    api.TopAbs_ShapeEnum.TopAbs_SHAPE,
  ) as OccExplorer;

  while (exp.More()) {
    const face = (api.TopoDS as OccTopoDS_Module).Face_1(exp.Current());
    const loc: OccTopLoc_Location = new api.TopLoc_Location_1();
    const triangulation: OccTriangulation = (api.BRep_Tool as OccBRep_Tool).Triangulation(
      face,
      loc as unknown as OccLocation,
    );

    if (!triangulation.IsNull()) {
      const tri = triangulation.get();
      const nNodes = tri.NbNodes();
      const nTris = tri.NbTriangles();

      for (let i = 1; i <= nNodes; i++) {
        const node = tri.Node(i);
        positions.push(node.X(), node.Y(), node.Z());
      }

      for (let i = 1; i <= nTris; i++) {
        const t = tri.Triangle(i);
        indices.push(
          vertexOffset + t.Value(1) - 1,
          vertexOffset + t.Value(2) - 1,
          vertexOffset + t.Value(3) - 1,
        );
      }

      vertexOffset += nNodes;
    }

    (loc as unknown as OccLocation).delete();
    exp.Next();
  }

  exp.delete();
  mesher.delete();

  if (positions.length === 0) return null;
  return { positions, indices };
}

// ---------------------------------------------------------------------------
// Entity → OCC TopoDS_Shape conversion.
// Supports box, cylinder, sphere. Others: stubbed with null.
// ---------------------------------------------------------------------------

function entityToOccShape(api: OccApi, entity: Entity): OccShape | null {
  switch (entity.kind) {
    case 'box': {
      const [sx, sy, sz] = entity.size;
      if (sx <= 0 || sy <= 0 || sz <= 0) return null;
      // Place origin at -half-size so the box is centered (matching three.js BoxGeometry).
      const [px, py, pz] = entity.position;
      const origin: OccGpPnt = new api.gp_Pnt_3(px - sx / 2, py - sy / 2, pz - sz / 2);
      const maker: OccMakeBox = new api.BRepPrimAPI_MakeBox_2(origin, sx, sy, sz);
      const shape = maker.Shape() as OccShape;
      origin.delete();
      maker.delete();
      return shape;
    }

    case 'cylinder':
    case 'sphere':
    case 'extrusion':
    case 'mesh':
      // These kinds could be implemented for a full port.
      // Stubbed for the spike — not needed to prove the interface boundary.
      return null;

    default:
      // 2D shapes are not solids.
      return null;
  }
}

// ---------------------------------------------------------------------------
// Kernel factory — the only public export.
// ---------------------------------------------------------------------------

/**
 * SPIKE: Create an OCC-backed geometry kernel.
 *
 * @param wasmBinary - Optional pre-loaded WASM bytes (required in Node.js).
 *   In the browser, omit this and let the WASM load from the network via
 *   Vite's asset pipeline.
 *
 * Only `booleanOp` is implemented (matching the current GeometryKernel interface).
 * Fillet/chamfer/shell require extending the interface — see decision doc.
 */
export async function createOcctKernel(wasmBinary?: Uint8Array): Promise<GeometryKernel> {
  const api = await getOccModule(wasmBinary);

  return {
    booleanOp(op: BooleanOp, a: Entity, b: Entity): MeshData | null {
      let shapeA: OccShape | null = null;
      let shapeB: OccShape | null = null;
      let resultShape: OccShape | null = null;
      let fuseOp: OccFuseOp | null = null;

      try {
        shapeA = entityToOccShape(api, a);
        if (!shapeA) return null;

        shapeB = entityToOccShape(api, b);
        if (!shapeB) return null;

        switch (op) {
          case 'union':
            fuseOp = new api.BRepAlgoAPI_Fuse_3(shapeA, shapeB) as OccFuseOp;
            break;
          case 'subtract':
            fuseOp = new api.BRepAlgoAPI_Cut_3(shapeA, shapeB) as OccFuseOp;
            break;
          case 'intersect':
            fuseOp = new api.BRepAlgoAPI_Common_3(shapeA, shapeB) as OccFuseOp;
            break;
          default:
            return null;
        }

        fuseOp.Build();
        if (!fuseOp.IsDone()) return null;

        resultShape = fuseOp.Shape();
        return extractMeshData(api, resultShape);
      } catch {
        return null;
      } finally {
        try {
          fuseOp?.delete();
        } catch {
          /* ignore */
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// SPIKE EXTENSION: fillet — NOT part of the current GeometryKernel interface.
// Exported separately to prove the operation works. If the interface is extended
// (the recommended path per KI4 decision doc), this becomes a kernel method.
// ---------------------------------------------------------------------------

/**
 * Fillet all edges of a box entity with the given radius.
 * Returns the tessellated MeshData or null on failure.
 *
 * This is a spike-only helper; it is NOT part of GeometryKernel.
 * To ship, extend GeometryKernel with `filletEdges(entity, edgeIndices, radius)`.
 *
 * @spike KI4
 */
export async function occFilletBox(
  entity: Entity & { kind: 'box' },
  radius: number,
  wasmBinary?: Uint8Array,
): Promise<MeshData | null> {
  const api = await getOccModule(wasmBinary);

  const boxShape = entityToOccShape(api, entity);
  if (!boxShape) return null;

  try {
    const filletMaker: OccFilletMaker = new api.BRepFilletAPI_MakeFillet(
      boxShape,
      api.ChFi3d_FilletShape.ChFi3d_Rational,
    );

    const edgeExp = new api.TopExp_Explorer_2(
      boxShape,
      api.TopAbs_ShapeEnum.TopAbs_EDGE,
      api.TopAbs_ShapeEnum.TopAbs_SHAPE,
    ) as OccExplorer;

    while (edgeExp.More()) {
      const edge = (api.TopoDS as OccTopoDS_Module).Edge_1(edgeExp.Current());
      filletMaker.Add_2(radius, edge);
      edgeExp.Next();
    }
    edgeExp.delete();

    filletMaker.Build();
    if (!filletMaker.IsDone()) {
      filletMaker.delete();
      return null;
    }

    const filletShape = filletMaker.Shape();
    const result = extractMeshData(api, filletShape);
    filletMaker.delete();
    return result;
  } catch {
    return null;
  }
}

/**
 * Reset the cached OCC module (for tests that need a clean slate).
 * Do NOT call in production code.
 */
export function __resetOccModule(): void {
  _modulePromise = null;
}
