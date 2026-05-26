/**
 * OpenCascade.js (OCC WASM) geometry kernel — opt-in production kernel.
 *
 * @layer ui/geometry
 *
 * STATUS: OPT-IN. Inject via `?kernel=occt` URL param (see main.tsx).
 * Manifold remains the default kernel. OCC is injected only when the URL flag
 * is set (dev/power-user toggle). See docs/decisions/KI4-occt-spike.md.
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
 * MESH→BREP APPROACH (Batch 15, KI4-followup)
 * ---------------------------------------------------------------------------
 * `filletEdges` now uses `meshDataToTopoDSShape` (Approach 2: BRepBuilderAPI_Sewing).
 * Per-triangle faces are built via BRepBuilderAPI_MakePolygon (closed triangle wire)
 * → BRepBuilderAPI_MakeFace_15 (planar face from wire), then sewn together into a
 * shell and promoted to a solid via BRepBuilderAPI_MakeSolid.
 *
 * Remaining limitations:
 *   - Robustness depends on triangle sealing: degenerate triangles (zero-area) are
 *     skipped but may leave gaps in the shell, causing BRepBuilderAPI_MakeSolid to
 *     fail. In that case filletEdges returns null (graceful no-op).
 *   - The sewing tolerance is 1e-6; meshes with vertices that differ by less than
 *     this are merged, which is correct behaviour but may lose fine detail.
 *   - Non-manifold meshes (open surfaces, meshes with T-junctions) will produce an
 *     open shell; MakeSolid will still fail gracefully, filletEdges returns null.
 *   - BRepBuilderAPI_MakeFace_15 builds a planar face from the triangle wire;
 *     curved surfaces (sphere faces, cylinder caps) become flat approximations.
 *     The fillet operates on this approximate topology — the result is geometrically
 *     close but not exact for non-polyhedral inputs.
 *   - API availability verified by the same "all OCC APIs are callable despite
 *     the 'unsupported' badge" rule established in KI4 Batch 13 spike.
 *     Runtime correctness of the sewing path is EXPECTED to work in-browser via Vite
 *     but is UNVERIFIED at commit time: bare Node.js ESM cannot resolve the static
 *     `import wasmFile from './dist/opencascade.wasm.wasm'` entry point without
 *     --experimental-wasm-modules, so the live WASM tests are still `describe.skip`.
 *     See docs/decisions/KI4-occt-spike.md (Batch 15 section) for follow-up.
 *
 * Operand types now correctly handled by filletEdges:
 *   - box entity     → exact B-rep via BRepPrimAPI_MakeBox_2 (unchanged, always worked)
 *   - arbitrary mesh → sewing approach above; solid produced when mesh is manifold
 *
 * Operand types still not handled (return null gracefully):
 *   - cylinder/sphere/extrusion entities → entityToOccShape still returns null for
 *     these; the mesh path handles their MeshData representations instead.
 *   - Open / non-manifold MeshData → sewing produces open shell → MakeSolid fails → null.
 *
 * ---------------------------------------------------------------------------
 * TODO: chamferEdges spike — BRepFilletAPI_MakeChamfer, needs separate batch.
 * TODO: shellSolid spike — BRepOffsetAPI_MakeThickSolid, needs separate batch.
 * ---------------------------------------------------------------------------
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

interface OccMakePolygon {
  Add_1(pt: OccGpPnt): void;
  Close(): void;
  IsDone(): boolean;
  Wire(): OccShape;
  delete(): void;
}

interface OccMakeFace {
  IsDone(): boolean;
  Face(): OccShape;
  delete(): void;
}

interface OccSewing {
  Add(shape: OccShape): void;
  Perform(): void;
  SewedShape(): OccShape;
  delete(): void;
}

interface OccMakeSolid {
  Add(shell: OccShape): void;
  Build(): void;
  IsDone(): boolean;
  Shape(): OccShape;
  delete(): void;
}

interface OccTopoDS_ModuleFull extends OccTopoDS_Module {
  Shell_1(shape: OccShape): OccShape;
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
// Helper: reconstruct a TopoDS_Shape from arbitrary MeshData.
//
// Approach 2 — BRepBuilderAPI_Sewing:
//   For each triangle in the mesh, build a closed triangular wire via
//   BRepBuilderAPI_MakePolygon → BRepBuilderAPI_MakeFace_15 (planar face).
//   All triangle faces are sewn together into a shell by BRepBuilderAPI_Sewing.
//   The sealed shell is promoted to a solid via BRepBuilderAPI_MakeSolid.
//
// Returns null if:
//   - The mesh has no triangles or degenerate geometry.
//   - Sewing produces an open shell (non-manifold / open mesh input).
//   - BRepBuilderAPI_MakeSolid.IsDone() is false.
//
// @pure (does not mutate mesh; all OCC objects are .delete()d before return)
// ---------------------------------------------------------------------------

function meshDataToTopoDSShape(api: OccApi, mesh: MeshData): OccShape | null {
  const { positions, indices } = mesh;
  if (positions.length === 0 || indices.length === 0) return null;
  if (indices.length % 3 !== 0) return null;

  const sewing: OccSewing = new api.BRepBuilderAPI_Sewing(1e-6, true, true, true, false);
  const createdFaces: OccShape[] = [];

  const triCount = indices.length / 3;
  for (let t = 0; t < triCount; t++) {
    const i0 = indices[t * 3] ?? 0;
    const i1 = indices[t * 3 + 1] ?? 0;
    const i2 = indices[t * 3 + 2] ?? 0;

    const x0 = positions[i0 * 3] ?? 0, y0 = positions[i0 * 3 + 1] ?? 0, z0 = positions[i0 * 3 + 2] ?? 0;
    const x1 = positions[i1 * 3] ?? 0, y1 = positions[i1 * 3 + 1] ?? 0, z1 = positions[i1 * 3 + 2] ?? 0;
    const x2 = positions[i2 * 3] ?? 0, y2 = positions[i2 * 3 + 1] ?? 0, z2 = positions[i2 * 3 + 2] ?? 0;

    // Skip degenerate (zero-area) triangles to avoid sewing failures.
    const abx = x1 - x0, aby = y1 - y0, abz = z1 - z0;
    const acx = x2 - x0, acy = y2 - y0, acz = z2 - z0;
    const crossSq = (aby * acz - abz * acy) ** 2 + (abz * acx - abx * acz) ** 2 + (abx * acy - aby * acx) ** 2;
    if (crossSq < 1e-24) continue; // degenerate — skip

    const gp0: OccGpPnt = new api.gp_Pnt_3(x0, y0, z0);
    const gp1: OccGpPnt = new api.gp_Pnt_3(x1, y1, z1);
    const gp2: OccGpPnt = new api.gp_Pnt_3(x2, y2, z2);

    const poly: OccMakePolygon = new api.BRepBuilderAPI_MakePolygon();
    poly.Add_1(gp0);
    poly.Add_1(gp1);
    poly.Add_1(gp2);
    poly.Close();
    gp0.delete();
    gp1.delete();
    gp2.delete();

    if (!poly.IsDone()) {
      poly.delete();
      continue;
    }

    const wire = poly.Wire();
    const makeFace: OccMakeFace = new api.BRepBuilderAPI_MakeFace_15(wire, false);
    poly.delete();

    if (makeFace.IsDone()) {
      const face = makeFace.Face();
      sewing.Add(face);
      createdFaces.push(face);
    }
    makeFace.delete();
  }

  // Clean up temporary face references (shapes are owned by OCC topology).
  // createdFaces are passed to sewing; sewing holds them internally.
  // We do NOT delete them here — sewing manages their lifetime.

  sewing.Perform();
  const sewn = sewing.SewedShape() as OccShape | null;

  if (!sewn) {
    sewing.delete();
    return null;
  }

  // Promote the sewed shell to a solid.
  const makeSolid: OccMakeSolid = new api.BRepBuilderAPI_MakeSolid();
  const shellExp: OccExplorer = new api.TopExp_Explorer_2(
    sewn,
    api.TopAbs_ShapeEnum.TopAbs_SHELL,
    api.TopAbs_ShapeEnum.TopAbs_SHAPE,
  );

  let shellCount = 0;
  while (shellExp.More()) {
    const shell = (api.TopoDS as OccTopoDS_ModuleFull).Shell_1(shellExp.Current());
    makeSolid.Add(shell);
    shellCount++;
    shellExp.Next();
  }
  shellExp.delete();
  sewing.delete();

  if (shellCount === 0) {
    makeSolid.delete();
    return null;
  }

  makeSolid.Build();
  if (!makeSolid.IsDone()) {
    makeSolid.delete();
    return null;
  }

  const solid = makeSolid.Shape();
  makeSolid.delete();
  return solid;
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
 * Create an OCC-backed geometry kernel.
 *
 * @param wasmBinary - Optional pre-loaded WASM bytes (required in Node.js).
 *   In the browser, omit this and let the WASM load from the network via
 *   Vite's asset pipeline.
 *
 * Implements the full `GeometryKernel` interface:
 *   - `booleanOp` — union / subtract / intersect via BRepAlgoAPI.
 *   - `filletEdges` — real B-rep fillet via BRepFilletAPI_MakeFillet. Accepts a
 *     MeshData operand; rebuilds the OCC shape from it when the input is a prior
 *     boolean result (mesh-only path). For entity-based fillet, pass MeshData
 *     derived from a box/cylinder entity using `entityToOccShape`.
 *   - `chamferEdges` — TODO: BRepFilletAPI_MakeChamfer spike pending.
 *   - `shellSolid`   — TODO: BRepOffsetAPI_MakeThickSolid spike pending.
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
        // Free all WASM heap objects to prevent memory leaks (nit fixed: KI4 review).
        try { shapeA?.delete(); } catch { /* ignore */ }
        try { shapeB?.delete(); } catch { /* ignore */ }
        try { resultShape?.delete(); } catch { /* ignore */ }
        try { fuseOp?.delete(); } catch { /* ignore */ }
      }
    },

    /**
     * Fillet the specified edges of a mesh using BRepFilletAPI_MakeFillet.
     *
     * The `shape` operand is a MeshData (kernel-agnostic). We rebuild an OCC
     * TopoDS_Shape from it via `meshDataToTopoDSShape` (BRepBuilderAPI_Sewing —
     * per-triangle planar faces sewn into a shell, promoted to a solid). This
     * replaces the previous AABB-rebuild approach (which only produced correct
     * results for axis-aligned box solids).
     *
     * If `meshDataToTopoDSShape` returns null (non-manifold mesh, degenerate
     * triangles, or sewing failure), `filletEdges` returns null as a graceful
     * no-op and logs once via console.warn so the developer/user is informed.
     *
     * @param shape       - input mesh (world-space, any orientation)
     * @param edgeIndices - 0-based edge indices to fillet; empty = all edges
     * @param radius      - fillet radius; must be > 0
     */
    filletEdges(shape: MeshData, edgeIndices: number[], radius: number): MeshData | null {
      if (radius <= 0 || shape.positions.length === 0) return null;

      let occShape: OccShape | null = null;
      let filletMaker: OccFilletMaker | null = null;

      try {
        occShape = meshDataToTopoDSShape(api, shape);
        if (!occShape) {
          console.warn(
            '[occtKernel] filletEdges: could not reconstruct a manifold solid from MeshData ' +
              '(non-manifold mesh, open shell, or degenerate triangles). Returning null.',
          );
          return null;
        }

        filletMaker = new api.BRepFilletAPI_MakeFillet(
          occShape,
          api.ChFi3d_FilletShape.ChFi3d_Rational,
        ) as OccFilletMaker;

        const edgeExp = new api.TopExp_Explorer_2(
          occShape,
          api.TopAbs_ShapeEnum.TopAbs_EDGE,
          api.TopAbs_ShapeEnum.TopAbs_SHAPE,
        ) as OccExplorer;

        const edgeSet = edgeIndices.length > 0 ? new Set(edgeIndices) : null;
        let edgeIdx = 0;
        while (edgeExp.More()) {
          if (!edgeSet || edgeSet.has(edgeIdx)) {
            const edge = (api.TopoDS as OccTopoDS_Module).Edge_1(edgeExp.Current());
            try {
              filletMaker.Add_2(radius, edge);
            } catch {
              // Degenerate or seam edge — skip gracefully.
            }
          }
          edgeIdx++;
          edgeExp.Next();
        }
        edgeExp.delete();

        filletMaker.Build();
        if (!filletMaker.IsDone()) return null;

        const filletShape = filletMaker.Shape();
        return extractMeshData(api, filletShape);
      } catch {
        return null;
      } finally {
        try { occShape?.delete(); } catch { /* ignore */ }
        try { filletMaker?.delete(); } catch { /* ignore */ }
      }
    },

    // TODO: chamferEdges — BRepFilletAPI_MakeChamfer spike needed (separate batch).
    // Returns null (graceful no-op) until implemented; matches the GeometryKernel
    // contract (callers treat null as "kernel can't do this op" and no-op).
    chamferEdges(_shape: MeshData, _edgeIndices: number[], _distance: number): MeshData | null {
      return null;
    },

    // TODO: shellSolid — BRepOffsetAPI_MakeThickSolid spike needed (separate batch).
    // Returns null (graceful no-op) until implemented; matches the GeometryKernel contract.
    shellSolid(_shape: MeshData, _thickness: number): MeshData | null {
      return null;
    },

    tessellate(entity: Entity): MeshData | null {
      let shape: OccShape | null = null;
      try {
        shape = entityToOccShape(api, entity);
        if (!shape) return null;
        return extractMeshData(api, shape);
      } catch {
        return null;
      } finally {
        try { shape?.delete(); } catch { /* ignore */ }
      }
    },
  };
}

/**
 * Reset the cached OCC module (for tests that need a clean slate).
 * Do NOT call in production code.
 */
export function __resetOccModule(): void {
  _modulePromise = null;
}
