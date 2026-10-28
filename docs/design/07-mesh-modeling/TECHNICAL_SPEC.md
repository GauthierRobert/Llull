# MSH — Mesh modelling for organic, scanned and printed parts — Technical specification

Gap id: **MSH** · Companion: [FUNCTIONAL_SPEC.md](FUNCTIONAL_SPEC.md) · Validation: [validation/README.md](validation/README.md) ·
Laws: `.claude/rules/architecture.md` L1–L10 · Decisions: KI5 (shape boundary), KI7 (native kernel default), RS1 (native
compute), LC1 (local only), LIM-1 (scale).

---

## 1. Current state in llull

### 1.1 Commands and code that touch meshes

| Capability       | Command / code                                                       | Files                                                                                                                                                   | What it really does                                                                                                                                                                                                        | Limit for this gap                                                                                                                                                                      |
| ---------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Land triangles   | `import_mesh`                                                        | `packages/core/src/commands/exchange/importMesh.ts`                                                                                                     | Caller passes `bodies[{positions, indices?, name?, color?}]`; stored as a **world-space soup** (`indices` 0..n-1, `soupIndices`); caps `MAX_IMPORT_BODIES` 10 000, `MAX_IMPORT_TRIANGLES` 2 000 000 (`commands/limits.ts`) | No file reading; no weld, no report; soup triples the JSON                                                                                                                              |
| STEP → mesh      | CLI tool `import_step`                                               | `packages/protocol/src/exchangeTools.ts`                                                                                                                | Tessellates STEP solids through the port, then `applyCommand('import_mesh', …)`                                                                                                                                            | The only caller of `import_mesh`                                                                                                                                                        |
| Mesh file import | —                                                                    | —                                                                                                                                                       | **None**: no STL / OBJ / PLY / 3MF reader in `packages/`, `server/src`, `src/ui`, `desktop/src`                                                                                                                            | FR-MSH-01                                                                                                                                                                               |
| Mesh entity      | `MeshSolidEntity` (`kind: 'mesh'`)                                   | `packages/core/src/model/types.ts`                                                                                                                      | `mesh: MeshData {positions, indices}`, optional `brep` recipe (kernel results), `stepSlab`, `threadTool`, `faceColors`                                                                                                     | Inline only; no provenance, no face groups, no asset reference                                                                                                                          |
| Prism recovery   | `mesh_to_solid`                                                      | `commands/exchange/meshToSolid.ts`, `geometry/prismRecognition.ts`                                                                                      | Constant-section prism → `extrude_profile` (+ subtracted hole tools)                                                                                                                                                       | Prisms only; arcs come back as polygons                                                                                                                                                 |
| Plane split      | `split_body`                                                         | `commands/brep/splitBody.ts`                                                                                                                            | `requiresKernel`; intersects with two huge half-space boxes; keeps **both** halves as meshes                                                                                                                               | No trim-keep-one, no open meshes, needs a kernel                                                                                                                                        |
| Booleans         | `boolean`, `blend_union`                                             | `commands/brep/boolean.ts`, `blend.ts`                                                                                                                  | `requiresKernel`; list form for many tools (LIM-1)                                                                                                                                                                         | On the native OCC kernel a mesh leaf becomes `make_sewn_solid` (one planar face per triangle, `solver/crates/llull-kernel-occt/src/recipe.rs` `mesh_solid`) — slow and fragile on scans |
| Hollow           | `shell_solid`                                                        | `commands/brep/modify3d.ts`                                                                                                                             | `requiresKernel`; Manifold lists `shell` as unsupported                                                                                                                                                                    | No mesh path                                                                                                                                                                            |
| Freeform solid   | `add_subdivision_solid`, `edit_subdivision_cage`                     | `commands/solids/subdivision*.ts`, `geometry/subdivision*.ts`                                                                                           | Catmull–Clark over a custom closed cage (`vertices` + `faces`), creases, levels 0..4 (`MAX_SUBDIVISION_LEVELS`); soft-falloff cage edits; on the native kernel **one exact bicubic B-spline face per refined quad**        | `MAX_CAGE_VERTICES` = 2000 — too small for a quad-remeshed scan cage (D5)                                                                                                               |
| Deviation        | `measure_deviation`                                                  | `commands/surface/checkJoints.ts`                                                                                                                       | One-way: points or `referenceId` samples → closest triangle of a solid target; max / mean / rms / p95 / histogram / `pass`                                                                                                 | No symmetric (Hausdorff) mode                                                                                                                                                           |
| Distance / rays  | `GeometryQueryEngine`                                                | `geometry/geometryQueries.ts`, `geometry/meshBvh.ts`; native `solver/crates/llull-geomq` via `server/src/native/geometryQueryEngine.ts` (spawnSync job) | Batched closest-point, ray, occlusion; native bit-identical to TS                                                                                                                                                          | Reused for projection, wall thickness, deviation                                                                                                                                        |
| Wall thickness   | assembly check                                                       | `geometry/assemblyCheck/thickness.ts`                                                                                                                   | Inward-normal rays, Halton samples, corner exclusion                                                                                                                                                                       | Reused by `check_mesh purpose=print`                                                                                                                                                    |
| Mesh health      | `openEdgeCount`, `isClosedMesh`, `orientOutward`, `signedMeshVolume` | `geometry/meshClosure.ts`, `geometry/meshVolume.ts`                                                                                                     | Weld on a 1e-5 grid (two shifted grids), open-edge count, outward orientation                                                                                                                                              | No half-edge structure, loops, components, genus, self-intersection                                                                                                                     |
| Exports          | `export_stl`, `export_obj`, `export_3mf`, `export_gltf`              | `commands/exchange/*`                                                                                                                                   | STL ASCII / binary (84 + 50·n bytes), 3MF with per-object `manifold` flag                                                                                                                                                  | Kept; must read assets at full resolution                                                                                                                                               |
| Point clouds     | plugin `scan`                                                        | `packages/domain-aec/src/scan/*`, `solver/crates/llull-cloud`                                                                                           | Content-addressed asset (sha256, manifest, octree) attached by key; native RANSAC + LM `fit_primitive` (plane / cylinder / sphere); `cloud_to_model_deviation`                                                             | Pattern for mesh assets; fit code reusable for `segment_mesh`                                                                                                                           |

`git grep -n "name: '<n>'" -- packages` returns nothing for every command this spec proposes (`import_mesh_file`,
`attach_mesh_asset`, `analyze_mesh`, `check_mesh`, `repair_mesh`, `fill_mesh_holes`, `decimate_mesh`, `remesh_mesh`,
`smooth_mesh`, `subdivide_mesh`, `convex_hull`, `minkowski_sum`, `offset_mesh`, `hollow_mesh`, `cut_mesh`, `sculpt_mesh`,
`segment_mesh`, `mesh_to_brep`, `quad_remesh`, `fit_subdivision_to_mesh`, `fit_surface_to_mesh`, `shrinkwrap_mesh`,
`displace_mesh`, `add_icosphere_mesh`, `add_grid_mesh`; checked 2026-10-22).

### 1.2 Kernels and what they already offer

| Engine                                                                                                                                                                                 | How llull uses it today                                                                                                                                                          | Available but unused (relevant here)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Source                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Manifold (`manifold-3d` 3.5.4, Apache-2.0; `packages/kernel-manifold/src/manifoldKernel.ts`; installed by `src/main.tsx` and as the server fallback in `server/src/geometryKernel.ts`) | `ofMesh` (welded at 1e-6), cube / cylinder / sphere / extrude, `add` / `subtract` / `intersect`, transforms, `getMesh`, `volume`, `surfaceArea`, `decompose`, `minGap`, `status` | `hull()` / `Manifold.hull(points)`, `minkowskiSum`, `minkowskiDifference`, `Manifold.levelSet(sdf, bounds, edgeLength, level, tolerance)` (marching tetrahedra on a BCC grid; **positive SDF = inside**), `Manifold.smooth(mesh, sharpenedEdges)`, `smoothOut(minSharpAngle, minSmoothness)`, `refine(n)`, `refineToLength`, `refineToTolerance`, `simplify(tolerance)`, `setTolerance`, `splitByPlane`, `trimByPlane`, `split(cutter)`, `slice(z)`, `project()`, `calculateCurvature`, `calculateNormals`, `genus()`, `warpBatch` | [R28] (type declarations of the installed package) |
| Native OCC (`llull-kernel`, OCCT 7.9, KI7 default on desktop)                                                                                                                          | Exact B-rep; mesh leaves sewn into polyhedral solids                                                                                                                             | Analytic surfaces + sewing for the prismatic B-rep builder (§5.9)                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | KI7, RS1                                           |
| `llull-compute` jobs (`solver/bins/llull-compute`, crates `llull-geomq`, `llull-cloud`, `llull-bvh`)                                                                                   | `spawnSync` job folders with LE f64 buffers, `report.json`, stable codes, determinism (RS1 rule 3)                                                                               | The pattern for `llull-compute meshops`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | RS1 §2                                             |

Manifold requires manifold input ("Imported meshes that aren't manifold return an error status"; `Merge` fixes slightly
non-manifold meshes) and promises "guaranteed manifold output" [R28]: it is the right engine for booleans, hull, Minkowski and
level sets, and the wrong one for repairing raw scans (that is the half-edge engine of §5.1–5.6).

## 2. Target architecture

### 2.1 Layer placement

| Piece                                                                                                                                                      | Layer                                                                                                                                                                    | Why (law)                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Half-edge / indexed mesh library (weld, adjacency, loops, shells, orientation, genus, quality, self-intersection broad phase)                              | `packages/core/src/geometry/mesh/*` (pure TS; uses `@lib/vec3`, `meshBvh`)                                                                                               | Pure geometry, reused by commands and plugins (L2)                                                                 |
| `MeshProcessingEngine` port (`ExecutionContext.meshProcessing`) + default TypeScript engine `tsMeshProcessing` (small meshes, oracle of the native engine) | `packages/core/src/geometry/mesh/engine.ts`                                                                                                                              | Same pattern as `GeometryQueryEngine` / `SurfaceAnalysisEngine` (RS1 rule 1)                                       |
| Mesh commands                                                                                                                                              | **new core feature catalog** `packages/core/src/commands/mesh/catalog.ts`                                                                                                | Domain-neutral (product design, printing, AEC scans, CAE all need it) → core, not a plugin (L10 decision shortcut) |
| Manifold-backed engine ops (hull, Minkowski, level-set offset / hollow / wrap, mesh booleans, smooth-refine, plane trim)                                   | `packages/kernel-manifold/src/manifoldMeshEngine.ts` implementing the core port                                                                                          | Kernel packages implement core ports; WASM stays out of core (L2, L9)                                              |
| Native engine `llull-meshops` (half-edge ops at scale, QEM, remesh, Taubin, Liepa, repair, segmentation, sculpt, quad remesh)                              | `solver/crates/llull-meshops`, job `llull-compute meshops <folder>`; host adapter `server/src/native/meshProcessingEngine.ts` (spawnSync, like `geometryQueryEngine.ts`) | Heavy numerics native (C7, RS1); reached only through the injected port (L9)                                       |
| Composite engine (route an op to native / Manifold / TS by capability and size)                                                                            | `server/src/native/meshEngineRouter.ts` (backend + CLI), `src/main.tsx` (renderer without backend: Manifold + TS)                                                        | Wiring is the host's job (L6)                                                                                      |
| Mesh assets (content-addressed full-resolution meshes)                                                                                                     | `ExecutionContext.meshAssets: MeshAssetPort` (core interface), store in `server/src/meshAssets/*`; CLI `llull mesh import <file>`                                        | Same as `PointCloudPort` (plant 10 TR-SCN-01)                                                                      |
| File readers STL / OBJ / PLY / 3MF                                                                                                                         | pure parsers in `packages/core/src/lib/meshFormats/*` (text / bytes in, arrays out); the CLI reads the file and passes base64 (exchange path)                            | Core may not read files (L2); exporters are already in core                                                        |
| Prismatic B-rep builder                                                                                                                                    | native kernel op `brepFromFaceGroups` (C++ in `solver/crates/llull-kernel-occt/cpp/mesh_brep.cxx`), reached through `GeometryKernel.meshToBrep?`                         | Exact B-rep only via `ctx.kernel` (L9)                                                                             |
| Review overlays                                                                                                                                            | `src/ui/viewport/3d/analysis/MeshReviewOverlay.tsx` from query `data`                                                                                                    | Presentation only (L1, L4)                                                                                         |

### 2.2 Data flow

```
CLI / UI ──execute──> decimate_mesh (core) ──> ctx.meshProcessing.run({op:'decimate', input, params})
                                                 ├─ TS engine (≤ MESH_TS_TRIANGLE_CAP)          ── same numbers ──┐
                                                 ├─ native llull-compute meshops (any size)                       │
                                                 └─ Manifold engine (hull / minkowski / level set / boolean ops)  │
                        <── MeshOpResult {mesh | assetKey + lod, report, deviation, provenance} <──────────────────┘
                 new MeshSolidEntity (indexed, provenance, faceGroups?) + FeatureStep (L8) ── replay = same op, same bytes
```

### 2.3 Laws check and tensions

- L1 / L5: every capability is a `defineCommand`; queries (`analyze_mesh`, `check_mesh`, `segment_mesh`) are read-only with
  `data`. The UI sculpt gesture commits `sculpt_mesh` (04 DIR).
- L3: commands return a new document; engine inputs are copied buffers.
- L8: params are design intent (target edge length, max deviation, brush radius and stamp points on the surface, plane, wall
  thickness), never agent-computed vertex lists — except the explicit `points` of `convex_hull` and stamp centres, which are the
  intent. Ids step-scoped (`mesh-<step>.<k>`).
- L9: Manifold and native code reach commands only through `ctx.meshProcessing` / `ctx.kernel`. `boolean` keeps
  `requiresKernel` for B-rep operands; for triangle-only operands it uses the mesh engine (§5.8).
- **Tension D1 (owner decision):** asset-backed results. A pure command cannot write files, but a 10⁶-triangle result cannot
  live inline. Proposal: the engine writes the result as a **content-addressed, immutable asset** (key = sha256 of the canonical
  bytes) and the command records the key — an idempotent cache write, like the kernel's `recipeKey` cache; replay recomputes
  the same key, so the document stays a pure function of its inputs. Without a `meshAssets` port, results above
  `MESH_INLINE_TRIANGLE_CAP` refuse with `MESH_ASSET_UNAVAILABLE`.
- **Tension D2:** the TS engine is both a runtime path (small meshes, no native binary) and the bit-exact oracle of
  `llull-meshops` (RS1 rule 4 keeps a TS path only with such a reason; this is the `meshBvh` / `llull-geomq` precedent).

## 3. Data model

```ts
// packages/core/src/model/types.ts — MeshSolidEntity, additive optional fields (no migration)
export interface MeshSolidEntity extends BaseEntity {
  readonly kind: 'mesh';
  mesh: MeshData; // inline triangles; for an asset-backed mesh: the display LOD
  brep?: ShapeRecipe;
  /** Full-resolution triangles in the local mesh asset store (FR-MSH-02); `mesh` is then a LOD (≤ MESH_LOD_TRIANGLES). */
  asset?: MeshAssetRef;
  /** Where the triangles came from and whether that source is pinned (AF-32); absent on kernel results (they derive from the recipe). */
  meshSource?: MeshSource;
  /** Face groups from segment_mesh / import (OBJ groups, 3MF objects), triangle index ranges over the canonical order. */
  faceGroups?: ReadonlyArray<FaceGroup>;
}
export interface MeshAssetRef {
  readonly key: string; // sha256 (64 hex) of the canonical asset bytes
  readonly triangles: number;
  readonly vertices: number;
  readonly bounds: { readonly min: Vec3; readonly max: Vec3 }; // document units, local frame
}
export interface MeshSource {
  readonly format: 'stl-ascii' | 'stl-binary' | 'obj' | 'ply' | '3mf' | 'triangles' | 'generated';
  readonly fileName?: string;
  readonly sourceSha256?: string; // sha256 of the file as read
  readonly unitScale: number; // file unit -> document unit factor applied once on import
  readonly verified: boolean; // true only with a pinned sourceSha256 the caller asserted (or 'generated')
}
export interface FaceGroup {
  readonly id: string;
  readonly faces: ReadonlyArray<readonly [number, number]>; // [start, end) ranges
  readonly fit?: PrimitiveFit; // from segment_mesh
}
export type PrimitiveFit =
  | { readonly type: 'plane'; readonly point: Vec3; readonly normal: Vec3; readonly rms: number; readonly max: number }
  | {
      readonly type: 'cylinder';
      readonly axisPoint: Vec3;
      readonly axis: Vec3;
      readonly radius: number;
      readonly rms: number;
      readonly max: number;
    }
  | {
      readonly type: 'cone';
      readonly apex: Vec3;
      readonly axis: Vec3;
      readonly halfAngleRad: number;
      readonly rms: number;
      readonly max: number;
    }
  | { readonly type: 'sphere'; readonly center: Vec3; readonly radius: number; readonly rms: number; readonly max: number }
  | {
      readonly type: 'torus';
      readonly center: Vec3;
      readonly axis: Vec3;
      readonly major: number;
      readonly minor: number;
      readonly rms: number;
      readonly max: number;
    }
  | { readonly type: 'freeform'; readonly rms: number; readonly max: number };

// packages/core/src/geometry/mesh/engine.ts — the port (synchronous, like GeometryQueryEngine)
export type MeshInput = { readonly mesh: MeshData } | { readonly assetKey: string };
export type MeshOp =
  | { readonly op: 'analyze'; readonly weldTolerance: number; readonly selfIntersections: boolean }
  | { readonly op: 'repair'; readonly mode: RepairMode; readonly maxGap: number; readonly smallComponent?: SmallComponentRule }
  | {
      readonly op: 'fill_holes';
      readonly loops: 'all' | ReadonlyArray<number>;
      readonly maxBoundaryEdges: number;
      readonly fairing: 'none' | 'tangent' | 'curvature';
    }
  | {
      readonly op: 'decimate';
      readonly targetTriangles?: number;
      readonly maxDeviation?: number;
      readonly preserveBoundary: boolean;
      readonly featureAngleRad?: number;
    }
  | {
      readonly op: 'remesh';
      readonly mode: 'isotropic' | 'adaptive';
      readonly targetEdge?: number;
      readonly minEdge?: number;
      readonly maxEdge?: number;
      readonly approxError?: number;
      readonly iterations: number;
      readonly featureAngleRad?: number;
      readonly preserveBoundary: boolean;
    }
  | {
      readonly op: 'smooth';
      readonly method: 'laplacian' | 'taubin';
      readonly lambda: number;
      readonly mu: number;
      readonly iterations: number;
      readonly weights: 'uniform' | 'cotangent';
      readonly fixBoundary: boolean;
      readonly volumeCorrection: boolean;
    }
  | { readonly op: 'subdivide'; readonly method: 'midpoint' | 'loop' | 'smooth'; readonly levels?: number; readonly maxEdge?: number }
  | { readonly op: 'hull'; readonly points: ReadonlyArray<Vec3> }
  | { readonly op: 'minkowski'; readonly kind: 'sum' | 'difference'; readonly other: MeshInput }
  | { readonly op: 'offset'; readonly distance: number; readonly method: 'level_set' | 'normal'; readonly tolerance: number }
  | { readonly op: 'hollow'; readonly wall: number; readonly tolerance: number }
  | {
      readonly op: 'cut';
      readonly origin: Vec3;
      readonly normal: Vec3;
      readonly keep: 'positive' | 'negative' | 'both';
      readonly cap: boolean;
    }
  | { readonly op: 'boolean'; readonly kind: BooleanOp; readonly others: ReadonlyArray<MeshInput> }
  | { readonly op: 'sculpt'; readonly stroke: SculptStroke }
  | {
      readonly op: 'segment';
      readonly featureAngleRad: number;
      readonly fitTolerance: number;
      readonly kinds: ReadonlyArray<PrimitiveFit['type']>;
    }
  | {
      readonly op: 'quad_remesh';
      readonly targetQuads: number;
      readonly adaptive: number;
      readonly hardEdgeRad: number;
      readonly symmetry?: 'x' | 'y' | 'z';
    }
  | { readonly op: 'project'; readonly target: MeshInput; readonly direction?: Vec3 };
export interface MeshOpResult {
  readonly mesh?: MeshData; // inline result (indexed, canonical vertex order)
  readonly asset?: MeshAssetRef;
  readonly lod?: MeshData; // large result
  readonly report: Readonly<Record<string, unknown>>; // op-specific counts (documented per command, §4)
  readonly deviation?: DeviationSummary; // symmetric, document units
  readonly provenance: {
    readonly engine: 'ts' | 'native' | 'manifold';
    readonly version: string;
    readonly algorithm: string;
    readonly reference: string;
    readonly device: 'cpu';
    readonly deterministic: true;
  };
}
export interface DeviationSummary {
  readonly forwardMax: number;
  readonly backwardMax: number;
  readonly hausdorff: number;
  readonly mean: number;
  readonly rms: number;
  readonly samples: number;
}
export interface MeshProcessingEngine {
  readonly name: string;
  /** Ops this engine answers, and its triangle cap per op (Infinity = none). */
  capabilities(): ReadonlyMap<MeshOp['op'], number>;
  run(input: MeshInput, op: MeshOp): MeshOpResult | MeshEngineFailure;
}
export interface MeshEngineFailure {
  readonly code: string;
  readonly message: string;
  readonly ids?: readonly number[];
}
export interface MeshAssetPort {
  manifest(key: string): MeshAssetRef | null;
  read(key: string): MeshData | null; // full resolution, for exports and the TS engine below its cap
}
```

Persistence: the new fields are optional; `commands/persistence` validates `asset.key` (64 hex), `faceGroups` ranges inside
the face count, `meshSource.unitScale > 0`. No version bump (unknown kinds are not introduced). Results of mesh commands are
stored **indexed** (`positions` per welded vertex), not as a soup; `import_mesh` keeps its soup invariant for compatibility.
`recipeKey` is unaffected (mesh results carry no `brep`).

Canonical order (AF-13): every engine outputs vertices in first-use order of a face traversal that starts at the lowest
original index and faces in ascending order of their smallest new vertex index; ties by the next index. TS and native engines
share this rule, so VC-MSH-32 can compare sha256 of the buffers.

## 4. Commands

All in `commands/mesh/catalog.ts`, toolset **`mesh`** (new; needs a design-language example per the SRF-3 rule, `tests/unit/design/examples.test.ts`),
`3d` keeps a pointer. Every mutating command: `id` of a `mesh` entity (or any 3D solid for constructive ops, tessellated first),
`keepSource?` (default false: replace in place, same id kept — the entity is rewritten, references survive), returns
`data.deviation` and `data.provenance`. Units: all lengths in document units; angles `…Deg`.

| Command                               | Kind                       | Params (sketch)                                                                                                                                                                                                                          | `@affects` / `@invariant` / `@failure`                                                                                                                                                                                                                                                                                               |
| ------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `import_mesh_file`                    | mutating                   | `format?: 'stl'\|'obj'\|'ply'\|'3mf'` (sniffed), `base64` or `text` (the CLI fills it from `file=PATH`), `units` (required unless 3MF), `weldTolerance?`, `name?`, `color?`, `sourceSha256?` (assert pin)                                | creates 1 mesh entity per body (3MF objects, OBJ groups as `faceGroups`); data {triangles, weldedVertices, droppedAttributes, openEdges, nonManifoldEdges, shells, unitScale}; failure `MESH_IMPORT_*`                                                                                                                               |
| `attach_mesh_asset`                   | mutating                   | `assetKey`, `name?`, `transform?`                                                                                                                                                                                                        | creates 1 asset-backed mesh with a LOD; `MESH_ASSET_MISSING`                                                                                                                                                                                                                                                                         |
| `analyze_mesh`                        | query                      | `id`, `weldTolerance?`, `selfIntersections?: boolean` (default true below 10⁶ triangles), `maxListed?` (default 20)                                                                                                                      | data per §FR-MSH-03; read-only                                                                                                                                                                                                                                                                                                       |
| `check_mesh`                          | query (AF-20)              | `ids`, `purpose: 'print'\|'boolean'\|'fit'\|'export'`, `minWallThickness?`, `maxTriangles?`, `smallShellFaces?`                                                                                                                          | data {status, findings[{code, severity, ids, where, value, limit, unit}], tolerances (named), unverified, reviewRequired?}                                                                                                                                                                                                           |
| `repair_mesh`                         | mutating                   | `id`, `mode: 'weld'\|'clean'\|'orient'\|'stitch'\|'close_holes'\|'wrap'`, `weldTolerance?`, `maxGap?`, `removeSmallComponents?: {maxFaces?\|maxVolume?}`, `tolerance?` (wrap)                                                            | data {changes:{welded, duplicatesRemoved, degenerateRemoved, flipped, stitched, holesFilled, componentsRemoved}, closed, deviation}; wrap: `innerStructuresDestroyed: true`                                                                                                                                                          |
| `fill_mesh_holes`                     | mutating                   | `id`, `holes: 'all'\|number[]\|{near: Vec3}[]`, `maxBoundaryEdges?` (default 1000), `fairing?: 'none'\|'tangent'\|'curvature'` (default curvature), `refine?: boolean` (default true), `refinementFactor?` (Liepa alpha 1..10, default 1.414)                                                    | data {filled[{loop, edges, triangles, area}], skipped[{loop, code}]}; `MESH_HOLE_NOT_FOUND`, `MESH_HOLE_TOO_LARGE`                                                                                                                                                                                                                   |
| `decimate_mesh`                       | mutating                   | `id`, one+ of `targetTriangles`, `ratio` (0..1), `maxDeviation`; `preserveBoundary?` (default true), `preserveFeatureAngleDeg?`, `lockedRegion?`                                                                                         | `@invariant` no fold-over, no new non-manifold edge, one-sided distance original→result ≤ maxDeviation; data {trianglesBefore, trianglesAfter, reachedTarget, deviation}; `MESH_TARGET_UNREACHABLE` is a **warning in data** when the stop rule halts first (the result is still applied), a refusal only with `requireTarget: true` |
| `remesh_mesh`                         | mutating                   | `id`, `targetEdgeLength` or `{minEdge, maxEdge, approxError}`, `iterations?` (default 5), `preserveFeatureAngleDeg?` (default 40), `preserveBoundary?` (default true), `project?` (default true), `region?`                              | data {edgeLength{min,max,mean,p5,p95}, fractionInBand, deviation}; `MESH_REMESH_EDGE_TOO_LARGE` (target > 0.25 × bbox diagonal)                                                                                                                                                                                                      |
| `smooth_mesh`                         | mutating                   | `id`, `method?: 'taubin'\|'laplacian'` (default taubin), `lambda?` (0.6307), `passBand?` (kPB 0.1), `iterations?` (10), `weights?` (uniform), `fixBoundary?` (true), `volumeCorrection?` (true for closed), `region?`                    | data {mu, volumeBefore, volumeAfter, meanDisplacement, maxDisplacement}                                                                                                                                                                                                                                                              |
| `subdivide_mesh`                      | mutating                   | `id`, `method`, `levels?` or `maxEdgeLength?`, `featureAngleDeg?`                                                                                                                                                                        | faces × 4 per level (midpoint / loop)                                                                                                                                                                                                                                                                                                |
| `convex_hull`                         | mutating                   | `ids?`, `points?` (≥ 4 non-coplanar), `keepSources?` (default true)                                                                                                                                                                      | creates 1 mesh; data {vertices, faces, volume, area}; `MESH_HULL_DEGENERATE`                                                                                                                                                                                                                                                         |
| `minkowski_sum`                       | mutating                   | `a`, `b` (closed meshes or solids), `op: 'sum'\|'difference'`, `keepSources?`                                                                                                                                                            | replaces `a` unless keepSources; `MESH_NOT_CLOSED`, `MESH_ENGINE_UNSUPPORTED` (non-convex on an engine without Manifold)                                                                                                                                                                                                             |
| `offset_mesh`                         | mutating                   | `id`, `distance` (signed), `method?: 'level_set'\|'normal'`, `tolerance?` (vertex error, default 0.002 × bbox diagonal, named), `maxCells?`                                                                                              | data {method, errorBound, volume?}; `MESH_OFFSET_RESOLUTION`                                                                                                                                                                                                                                                                         |
| `hollow_mesh`                         | mutating                   | `id`, `wallThickness`, `tolerance?`, `drainHoles?: [{near: Vec3, diameter}]`                                                                                                                                                             | data {materialVolume, cavityVolume, drainHoles}; `MESH_NOT_CLOSED`                                                                                                                                                                                                                                                                   |
| `cut_mesh`                            | mutating                   | `id`, `plane {origin, normal}`, `keep`, `cap?` (default true for closed input)                                                                                                                                                           | `keep: both` creates 2 meshes (positive first, like `split_body`); data {volumes?, capArea, loops}; `MESH_CUT_MISSES`                                                                                                                                                                                                                |
| `sculpt_mesh`                         | mutating                   | `id`, `brush`, `stamps?: [{center: Vec3}]` or `along?: {curveId, spacing}`, `radius`, `strength`, `falloff?` (smooth), `direction?: 'normal'\|'area_normal'\|Vec3`, `symmetry?: {plane: 'yz'\|'xz'\|'xy'}`, `maskRegion?`, `refineEdge?` | data {movedVertices, displacedVolume (signed, closed or height-field), maxDisplacement, symmetryError}; `MESH_SCULPT_STAMP_OFF_SURFACE` (stamp farther than radius from the mesh)                                                                                                                                                    |
| `segment_mesh`                        | query                      | `id`, `featureAngleDeg?` (30), `fitTolerance?`, `kinds?`                                                                                                                                                                                 | data {groups[{id, faces, area, fit}], adjacency, unassignedFaces}; with `store: true` it is mutating and writes `faceGroups`                                                                                                                                                                                                         |
| `mesh_to_brep`                        | mutating, `requiresKernel` | `id`, `mode: 'faceted'\|'prismatic'`, `fitTolerance?`, `maxFaces?` (faceted cap, default 50 000)                                                                                                                                         | replaces the mesh by a mesh entity with an exact `brep` (`op: 'brep'` blob); data {faces{plane,cylinder,…,faceted}, maxResidual, volumeExact}; `MESH_BREP_SEW_FAILED`                                                                                                                                                                |
| `quad_remesh`                         | mutating                   | `id`, `targetQuadCount` or `targetEdgeLength`, `adaptiveSize?` (0..100), `detectHardEdgesDeg?` (30), `symmetry?`, `output?: 'subdivision'\|'mesh'`                                                                                       | creates a `subdivision` entity (cage = quads, creases = hard edges, levels 2) or a quad-dominant mesh; `MESH_QUAD_REMESH_FAILED`, `MESH_NON_MANIFOLD`                                                                                                                                                                                |
| `fit_subdivision_to_mesh`             | mutating                   | `cageId`, `targetId`, `levels?`, `maxDeviation`, `iterations?`, `interpolate?`                                                                                                                                                           | rewrites the cage vertices; data {maxDeviation, rms, iterations, converged}; `MESH_FIT_NOT_CONVERGED` (warning, result applied)                                                                                                                                                                                                      |
| `fit_surface_to_mesh`                 | mutating                   | `id`, `region?`, `degree?` (3), `controlPoints?: [nu, nv]`, `smoothing?`                                                                                                                                                                 | creates a `nurbs_surface` (02 SRF kind); data {maxDeviation, rms}                                                                                                                                                                                                                                                                    |
| `shrinkwrap_mesh`                     | mutating                   | `id`, `targetId`, `mode: 'nearest'\|'direction'`, `direction?`, `offset?`                                                                                                                                                                | moves vertices; data {moved, maxDistance}                                                                                                                                                                                                                                                                                            |
| `displace_mesh`                       | mutating                   | `id`, `heightMap?: {imageBase64, range: [lo, hi], projection: 'planar'}` or `expression?`, `refineEdge?`                                                                                                                                 | data {displacedVolume, maxDisplacement}                                                                                                                                                                                                                                                                                              |
| `add_icosphere_mesh`, `add_grid_mesh` | mutating                   | `radius`, `level` (0..7) / `size`, `cells`, `position?`                                                                                                                                                                                  | creates 1 mesh (`meshSource.format: 'generated'`, verified)                                                                                                                                                                                                                                                                          |

Changed existing commands: `boolean` gains `engine?: 'auto'|'kernel'|'mesh'` (§5.8); `measure_deviation` gains
`symmetric?: boolean` and mesh targets read the asset; `split_body` is unchanged (it stays the B-rep-aware split; `cut_mesh` is
the mesh tool); `export_*` read `asset` at full resolution; `mesh_to_solid` gains a pointer to `mesh_to_brep` in its refusal text.

## 5. Kernel / algorithms

### 5.1 Mesh library (TR-MSH-01)

- **Weld**: quantise to `weldTolerance` on two grids half a cell apart (the `meshClosure.ts` technique), union-find of
  coincident corners, canonical order (§3). Default `weldTolerance` = 1e-6 × bbox diagonal (named default `llull`), reported.
- **Half-edge**: built from the welded index buffer; non-manifold edges (> 2 incident faces) are split into separate fans
  before the half-edge build and reported; boundary loops by following `next` around boundary half-edges.
- **Shells** by union-find over shared edges; **orientation** by BFS flipping each face to agree with its neighbour, then
  per closed shell the sign of `signedMeshVolume` makes it outward; **genus** per closed shell `g = (2 − χ)/2`.
- **Self-intersections**: BVH (`meshBvh.ts` / `llull-bvh`) broad phase over triangle pairs that share no vertex, exact
  triangle–triangle test (Möller); count and the first `maxListed` pairs.
- **Quality**: aspect ratio = longest edge / (2√3 · inradius) (1 for equilateral), min angle.

### 5.2 Repair (FR-MSH-05, 07)

`clean` removes faces with a repeated vertex or zero area (< 1e-12 × diagonal²) and exact duplicates (same vertex set,
either winding). `stitch` merges boundary vertices closer than `maxGap` (default = weld tolerance × 100, named) when it
reduces boundary edges, then re-welds. `close_holes` = `stitch` + `fill_mesh_holes all`. `wrap` = level-set rebuild: SDF of
the soup = unsigned distance (BVH) − `tolerance`/2 with the sign from the generalized winding number (> 0.5 = inside), meshed by
the shared field mesher (05 IMP; until it exists `Manifold.levelSet`, which takes positive = inside, so the engine passes −SDF;
cell cap `MESH_LEVEL_SET_MAX_CELLS` = 2·10⁷, named). The result says `innerStructuresDestroyed: true` (Fusion's wording [R3]).

### 5.3 Decimation — quadric error metrics (FR-MSH-08) [R23]

- Plane of each face p = [a b c d], a²+b²+c² = 1; fundamental quadric K_p = p pᵀ; vertex quadric Q_v = Σ K_p over incident
  faces ("the initial error estimate for each vertex is 0, since each vertex lies in the planes of all its incident
  triangles" [R23]). Pair cost Δ(v̄) = v̄ᵀ(Q₁+Q₂)v̄; v̄ solves the 3×3 system when its determinant > 1e-12 × scale, else the best
  of the endpoints and midpoint (Garland's fallback).
- Boundary preservation: either lock boundary vertices (`preserveBoundary: true`, default) or add penalty planes
  perpendicular to each boundary edge weighted 10³ (Garland §6 "Preserving Boundaries" [R23]); feature edges above
  `preserveFeatureAngleDeg` get the same penalty.
- Validity per collapse: link condition (manifold kept), no face normal turning by ≥ 90°, no degenerate face; contractions are
  edge-only (no "virtual pairs", which join separate shells — not wanted in CAD).
- **`maxDeviation` stop rule (one-sided bound)**: every original vertex is assigned to the result face it projects onto; a
  collapse is rejected when any original vertex in the affected faces' neighbourhood would end farther than `maxDeviation` from
  the new faces. The final `data.deviation` measures both directions (BVH), so the bound is proven, not assumed (VC-MSH-07).
- Determinism: binary heap keyed (cost, min vertex id, max vertex id); costs recomputed only for the edges around a collapse.
- Optional fast path `algorithm: 'meshopt'` (meshoptimizer `meshopt_simplify`, MIT, `meshopt` crate 0.7.0 [R29] [R35]) — COULD:
  its `target_error` is relative to the mesh extent and its stop count is "not guaranteed" [R29], so the llull bound is checked
  after and reported.

### 5.4 Isotropic / adaptive remeshing (FR-MSH-09) [R25] [R27]

Given target edge length L, per iteration [R25]: "1. Split all edges at their midpoint that are longer than 4/3 L. 2. Collapse
all edges shorter than 4/5 L into their midpoint. 3. Flip edges in order to minimize the deviation from valence 6 (or 4 on
boundaries). 4. Relocate vertices on the surface" (tangential relaxation: move to the area-weighted 1-ring centroid projected on
the tangent plane), then project onto the input (closest point, BVH). A collapse that would create an edge longer than 4/3 L is
skipped. Feature edges (dihedral > `preserveFeatureAngleDeg`) are never flipped or collapsed across; feature vertices relax
along the feature line; corner vertices (≥ 3 feature edges) are fixed. Adaptive mode: L(x) from a sizing field
L = √(6 ε / κ_max − 3 ε²) clamped to [minEdge, maxEdge] (chord error ε, PMP adaptive remeshing after Dunyach et al. [R27]; the
formula is the standard chord-error relation and is verified by VC-MSH-10's bound, not quoted). Bound used by the VC: with
all edges ≤ ℓ and vertices on a sphere of radius R, Jung's theorem (disc radius ≤ ℓ/√3 [R37]) gives distance ≤
R − √(R² − ℓ²/3).

### 5.5 Smoothing (FR-MSH-10) [R24]

Umbrella operator Δx_i = Σ_j w_ij (x_j − x_i), Σ_j w_ij = 1 (uniform w = 1/valence; cotangent COULD). Laplacian: x ← x + λΔx.
Taubin: x ← x + λΔx, then x ← x + μΔx with μ < −λ < 0; transfer f(k) = (1 − λk)(1 − μk), pass-band frequency
"kPB = 1/λ + 1/μ > 0" [R24 eq. 9]; "Values from 0.01 to 0.1 produce good results" [R24]; the paper's figures use kPB 0.1 and
λ 0.6307 [R24], hence μ = 1/(kPB − 1/λ) = −0.6731559455 (named defaults, source [R24]). Found by the reference script
(`data/smoothing_reference.json`): on a clean icosphere Taubin enlarges the mean radius by +0.116 % in 10 iterations and
+0.584 % in 50 (f(k) > 1 inside the pass band), while Laplacian shrinks it by −1.78 % in 10; hence `volumeCorrection`
(rescale about the centroid by (V₀/V)^{1/3}, closed shells only) defaults to on and is reported.

### 5.6 Hole filling (FR-MSH-06) [R26]

Liepa's four stages "boundary identification, hole triangulation, refinement, and fairing" [R26]: (1) boundary loops from §5.1;
(2) triangulation by O(n³) dynamic programming over the loop with a lexicographic weight (maximum dihedral angle to the
neighbours, then area) — the min-area special case is implemented by the reference script (`generate_mesh_algorithms.mjs`,
planar loop of 8 edges → 6 triangles, area exact); (3) refinement: split patch triangles whose edges exceed the mean
edge length of the loop's 1-ring, with edge swaps toward Delaunay; (4) fairing: solve Δx = 0 (`tangent`, membrane) or
Δ²x = 0 (`curvature`, thin plate) for the interior patch vertices with the 2-ring of the boundary fixed (sparse SPD system,
conjugate gradients, tolerance 1e-10 relative). The weight details of stages 2–4 are as commonly implemented; the paper's PDF
could not be read (encrypted), so they are grade B and verified only through VC-MSH-04 / 05.

### 5.7 Sculpt brushes (FR-MSH-18)

For a stamp centre c (projected onto the mesh), radius ρ, strength s, falloff f(t), t = |x_i − c| / ρ (Euclidean distance;
geodesic COULD) and only t < 1: `constant` f = 1, `linear` 1 − t, `smooth` (1 − t²)², `sphere` √(1 − t²).

| Brush     | Update                                                               | Notes                                                                |
| --------- | -------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `draw`    | x_i += s f(t) n̄                                                      | n̄ = area-weighted normal of the faces in the brush                   |
| `inflate` | x_i += s f(t) n_i                                                    | per-vertex normal                                                    |
| `grab`    | x_i += f(t) v                                                        | v = `direction` vector (s ignored); the stroke's displacement        |
| `smooth`  | x_i += s f(t) Δx_i (s ≤ 1), Taubin pair when `taubin: true`          | local §5.5                                                           |
| `flatten` | x_i −= s f(t) ((x_i − p)·n̄) n̄                                        | plane (p, n̄) = area-weighted fit of the brush region at stroke start |
| `pinch`   | x*i += s f(t) (c − x_i)*⊥                                            | tangential pull toward the centre                                    |
| `crease`  | `draw` with −s, then `pinch` with s/2                                | Blender "draw-style brush with a pinching effect" [R15]              |
| `layer`   | x_i = x_i⁰ + min(s f(t), h_max) n̄, no accumulation within one stroke | fixed height [R15]                                                   |

Stamps apply in the given order (deterministic); `along` places stamps every `spacing` along a curve entity projected onto the
mesh. Symmetry applies each stamp and its mirror image in the same pass (mirrored direction). `refineEdge` first splits edges in
the brush region longer than the value (local §5.4 split step) so detail is possible. Displaced volume on a closed mesh =
V_after − V_before; on an open height-field patch = Σ_faces area × mean vertex displacement along +n̄ (exact for piecewise-linear
surfaces; VC-MSH-19 data).

### 5.8 Constructive operations (FR-MSH-12..17)

- **Hull**: Manifold `hull` when installed (in-process WASM, any size it can hold); TS / native quickhull with an epsilon of
  1e-12 × diameter and coplanar-point merging; ≥ 4 non-coplanar points or `MESH_HULL_DEGENERATE`.
- **Minkowski**: both convex (checked: every edge dihedral ≤ 180° + ε) → hull of all vertex sums a_i + b_j (exact; TS ok);
  otherwise Manifold `minkowskiSum` / `minkowskiDifference` [R28], `MESH_ENGINE_UNSUPPORTED` without Manifold. Validation
  uses the zonotope identity V(P + [0,a]³) = V(P) + a(A_x + A_y + A_z) + a²(w_x + w_y + w_z) + a³ (validation/README §4.3).
- **Offset**: `level_set` = SDF of the mesh (BVH distance, winding-number sign) at `distance`, meshed with vertex tolerance
  `tolerance`; error bound |ΔV| ≤ A·ε reported; outward corners round, inward corners stay sharp (it is the parallel body).
  `normal` = x_i + d·n_i (angle-weighted normals), allowed on open meshes, reports self-intersections created.
- **Hollow**: inner shell = level-set offset −wall, reversed, added as a second shell (sealed cavity); drain holes = mesh
  boolean subtract of cylinders along the local surface normal at the nearest point to `near`, length 3 × wall.
- **Cut**: closed manifold input → Manifold `splitByPlane` / `trimByPlane` (caps implicit); open or non-manifold input → TS /
  native triangle clipping, section loops chained, caps triangulated with `@lib/triangulate` `triangulatePolygon` (holes =
  inner loops by containment), cap faces oriented along −normal of the kept side.
- **Mesh booleans (routing, TR-MSH-09)**: `boolean` with `engine: 'auto'` uses `ctx.meshProcessing` when every operand is a
  `mesh` entity without `brep` (triangle-only) or when no B-rep kernel is installed; `kernel` forces `ctx.kernel` (today's path);
  `mesh` forces the mesh engine (B-rep operands are tessellated). Results carry no `brep`. Non-manifold operands refuse with
  `MESH_NON_MANIFOLD` and the remediation "run `repair_mesh mode=stitch`, or `mode=wrap`".

### 5.9 Back to exact B-rep (FR-MSH-20..24)

- **`segment_mesh`**: region growing from the flattest unassigned face; a neighbour joins when its normal is within
  `featureAngleDeg` of the region's running fit normal (planes) or its distance to the running primitive fit is ≤
  `fitTolerance`; candidate primitives fitted with the scan plugin's native RANSAC + Levenberg–Marquardt (`llull-cloud` `fit`
  module moved into a shared crate `llull-fit` used by `llull-cloud` and `llull-meshops`) on the region's vertices + normals;
  the lowest-BIC primitive under `fitTolerance` wins, else `freeform`.
- **`mesh_to_brep prismatic`**: native kernel op `brepFromFaceGroups(groups)`: one OCC surface per analytic group (`gp_Pln`,
  `gp_Cylinder`, `gp_Cone`, `gp_Sphere`, `gp_Torus` → `Geom_*Surface`), edges from surface–surface intersections between
  adjacent groups (`GeomAPI_IntSS`) restricted to the group boundary polyline (closest branch), faces built and sewn with
  `BRepBuilderAPI_Sewing` at the fit tolerance, `ShapeFix_Shape`, `BRepCheck_Analyzer`; any group whose face cannot be built
  stays faceted (its triangles as planar faces) and is listed. Result: a mesh entity with `brep: { op: 'brep', blob }` (the existing
  document blob path), so `mass_properties` reports `method: exact`. `faceted` = today's `make_sewn_solid`, capped at `maxFaces`.
- **`quad_remesh`**: QuadriFlow (BSD-3-Clause plus an Enhancements grant, checked in 13.6.1: not plain MIT; LEMON BSL; Eigen MPL-2.0 with `EIGEN_MPL2_ONLY`,
  which turns any LGPL include into a compile error [R34]) vendored in the crate `llull-quadflow`, enabled in `llull-meshops` by cargo feature `quad`, through `cxx` (as built: 13.6); input must
  be manifold ("takes a manifold triangle mesh and outputs a manifold quad mesh" [R34]); `-sharp` maps to `detectHardEdgesDeg`.
  Instant Meshes (BSD-3 with an "enhancements" paragraph [R33]) is the alternative if QuadriFlow fails on a corpus.
  The quad cage becomes a `subdivision` entity: needs `MAX_CAGE_VERTICES` raised from 2000 (D5).
- **`fit_subdivision_to_mesh`** (as built: 13.7.2, two-sided rows and a fairing on the displacement): the Catmull–Clark limit position of each cage vertex is a fixed linear combination of the
  cage (limit stencil); iterate: closest points P on the target for the limit samples (BVH), solve
  min ‖S C − P‖² + α‖L C‖² (L = cage umbrella, α = 1e-3 named) by CG, until max deviation ≤ `maxDeviation` or `iterations`;
  `interpolate: true` targets the target's vertices nearest each cage vertex (Rhino "Interpolate SubD" [R6]). The existing
  native path then yields exact B-spline faces.
- **`fit_surface_to_mesh`** (as built: 13.7.4, plane projection only): least-squares B-spline surface approximation (02 SRF `lib/nurbs`, parameterisation by projection
  onto the region's best-fit plane, or by harmonic map for curved regions), smoothing term; result `nurbs_surface`.

### 5.10 Native engine `llull-meshops` (TR-MSH-03)

`solver/crates/llull-meshops` (Rust, `rayon` only for independent items — BVH builds, per-shell work; the collapse / flip
loops stay sequential for determinism), job `llull-compute meshops <folder>`: `job.json` `{op, params}`, `mesh.f64`
(vertex count, positions) + `faces.u32`, out `result.f64` / `result.u32`, `report.json` `{op, items, ms, deviation,
provenance}`; codes as §7.1. Depends on `llull-bvh`, `llull-jsmath` (bit-exact transcendental functions with the TS engine),
`llull-protocol`, `llull-fit` (§5.9). Asset store I/O: the job may read `assetKey` inputs and write the result asset
(content-addressed, immutable, §2.3 D1). `--progress` NDJSON lines for long ops (AF-40).

### 5.11 Library choice and licence policy (C7, TR-MSH-15)

| Candidate                            | Licence (as fetched)                                                                                             | Use                                                                        | Decision                                                                                                                                                   |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Manifold / `manifold-3d` 3.5.4       | Apache-2.0 [R28]                                                                                                 | booleans, hull, Minkowski, level set, smooth / refine, plane split         | **Keep** (already bundled); native `manifold-csg` 0.4.1 crate (Apache-2.0 OR MIT, builds manifold3d C++ with cmake [R35]) COULD lift the WASM memory limit |
| Own Rust (`llull-meshops`) + TS twin | project                                                                                                          | half-edge, repair, QEM, remesh, Taubin, Liepa, sculpt                      | **Build**: bit-exact twin needed (RS1 rule 3), algorithms are short and published                                                                          |
| PMP library                          | MIT [R27]                                                                                                        | reference implementation of remeshing, decimation, smoothing, hole filling | Algorithmic reference (reading / porting allowed by MIT); not linked                                                                                       |
| meshoptimizer / `meshopt` 0.7.0      | MIT / MIT OR Apache-2.0 [R29] [R35]                                                                              | fast simplification, `simplifySloppy`                                      | COULD fast path (§5.3)                                                                                                                                     |
| QuadriFlow                           | BSD-3-Clause + Enhancements grant (+ BSL, MPL-2.0, Apache-2.0 deps) [R34]                                                                                | quad remesh                                                                | **Use** behind feature `quad`                                                                                                                              |
| Instant Meshes                       | BSD-3 + enhancement paragraph [R33]                                                                              | quad remesh alternative                                                    | Fallback                                                                                                                                                   |
| geogram                              | BSD-3-Clause [R30]                                                                                               | remeshing, Delaunay, reconstruction                                        | Not needed now; option for CVT remeshing                                                                                                                   |
| baby_shark 0.3.12                    | MIT [R35]                                                                                                        | voxel remesh, isotropic remesh, decimation in Rust                         | Watch (young); not a dependency                                                                                                                            |
| parry3d-f64 0.31.1                   | Apache-2.0 [R35]                                                                                                 | convex hull, BVH                                                           | Not needed (Manifold hull, own quickhull)                                                                                                                  |
| libigl                               | MPL-2.0 core; `copyleft/` modules (cgal, comiso, cork, tetgen — AGPLv3) under their terms [R32]                  | —                                                                          | **Excluded** for copyleft modules; core not needed                                                                                                         |
| CGAL                                 | "most geometric algorithms and data structures are under the GPL", commercial licence from GeometryFactory [R31] | —                                                                          | **Excluded** (RS1 rule 7: nothing GPL linked)                                                                                                              |
| OpenMesh                             | not confirmed (site unreachable in this session)                                                                 | —                                                                          | Not used                                                                                                                                                   |

Every linked component's licence text goes to `resources/native/licenses/` (RS1 rule 5), checked by VC-MSH-29.

### 5.12 Named defaults and tolerances (AF-31)

| Name                                              | Value                                            | Source                                                         |
| ------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------- |
| `weldTolerance`                                   | 1e-6 × bbox diagonal                             | llull default (Manifold kernel already welds at 1e-6 units)    |
| `maxGap` (stitch)                                 | 100 × weldTolerance                              | llull default                                                  |
| `preserveFeatureAngleDeg`                         | 40 (remesh), 30 (segment, quad hard edges)       | llull default; Rhino QuadRemesh hard edges "> 30 degrees" [R6] |
| Taubin λ, kPB                                     | 0.6307, 0.1                                      | [R24]                                                          |
| remesh split / collapse                           | 4/3 L, 4/5 L                                     | [R25]                                                          |
| level-set `tolerance`                             | 0.002 × bbox diagonal                            | llull default                                                  |
| `MESH_TS_TRIANGLE_CAP`                            | 200 000 per op (provisional, TBD on measurement) | llull                                                          |
| `MESH_INLINE_TRIANGLE_CAP` / `MESH_LOD_TRIANGLES` | 100 000 / 50 000 (provisional)                   | llull; LIM-1 document sizes                                    |

Every result lists the defaults it used as `{value, unit, source, defaulted: true}`.

## 6. Interop & persistence

| Format     | Read                                                                                                                                                             | Notes                       |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------ | ------------------------ |
| STL binary | 80-byte header (ignored; a header starting with `solid` is still binary when 84 + 50·n = file size), u32 count, 50 bytes per facet; normals ignored (recomputed) | the inverse of `export_stl` |
| STL ASCII  | `facet` / `vertex` tokens, any whitespace, several `solid` blocks = several bodies                                                                               |                             |
| OBJ        | `v`, `f` (polygons fan-triangulated, negative indices), `g` / `o` → face groups; `vt` / `vn` / materials dropped and reported                                    |                             |
| PLY        | header `format ascii                                                                                                                                             | binary_little_endian        | binary_big_endian 1.0`, `element vertex`(x, y, z float / double),`element face` list | other properties dropped |
| 3MF        | ZIP (`@lib/zip`), `3D/3dmodel.model`, `<model unit=…>` → unitScale, objects → bodies, build transforms applied                                                   | beam lattices: 05 IMP       |

Asset store layout (host): `<llull data dir>/assets/mesh/<key>/manifest.json` (`MeshAssetRef` + source + LOD triangle count),
`positions.f64`, `faces.u32`, `lod.json`. Written by `llull mesh import` and by engine results; never edited.

## 7. CLI / UI surfaces and stable codes

- **CLI**: `llull search mesh`, `llull list mesh`, `llull describe <cmd>`, `import_mesh_file file=PATH` (the CLI reads the file,
  computes its sha256 and sends `base64`), `llull mesh import <file> --units mm` (asset), `--progress`, `--timeout`,
  `--dry-run`, `render_view isolate=<id> --save` (AF-22). `llull guide` gains the mesh section of FR-MSH-36.
- **UI**: menus from `listCommands()`; review overlays from `analyze_mesh` / `check_mesh` / `segment_mesh` / deviation `data`;
  sculpt gesture → one `sculpt_mesh` (04 DIR).

### 7.1 Error and finding codes (AF-11)

| Code                                                                                                                                                                                                                                                        | Raised by                                             | When                                                                                           | Remediation                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `MESH_ENTITY_NOT_FOUND`                                                                                                                                                                                                                                     | all                                                   | unknown id                                                                                     | `llull describe_scene` to list ids                                   |
| `MESH_NOT_A_MESH`                                                                                                                                                                                                                                           | mesh-only ops                                         | 2D / curve / sheet entity                                                                      | pass a mesh, or tessellate a solid with `keepSource`                 |
| `MESH_NOT_CLOSED`                                                                                                                                                                                                                                           | minkowski, hollow, offset (level set), volume reports | open shell                                                                                     | `fill_mesh_holes` or `repair_mesh mode=close_holes`                  |
| `MESH_NON_MANIFOLD`                                                                                                                                                                                                                                         | Manifold-backed ops, quad remesh                      | edges with > 2 faces                                                                           | `repair_mesh mode=stitch`, else `mode=wrap`                          |
| `MESH_PARAM_INVALID`                                                                                                                                                                                                                                        | all                                                   | value outside its range not caught by zod (e.g. ratio and target both inconsistent)            | named param path                                                     |
| `MESH_IMPORT_UNITS_REQUIRED`                                                                                                                                                                                                                                | `import_mesh_file`                                    | STL / OBJ / PLY without `units`                                                                | give `units` (mm, cm, m, in, ft)                                     |
| `MESH_IMPORT_FORMAT_UNKNOWN` / `MESH_IMPORT_PARSE` / `MESH_IMPORT_EMPTY`                                                                                                                                                                                    | `import_mesh_file`                                    | not sniffable / byte or line offset of the bad record / no triangles                           | pass `format`; fix the file                                          |
| `MESH_IMPORT_TOO_LARGE`                                                                                                                                                                                                                                     | `import_mesh_file`                                    | triangles > inline cap and no asset store                                                      | `llull mesh import` then `attach_mesh_asset`                         |
| `MESH_ASSET_MISSING` / `MESH_ASSET_UNAVAILABLE`                                                                                                                                                                                                             | asset reads                                           | key not in this machine's store / no `meshAssets` port                                         | re-import the source file (sha256 in `meshSource`)                   |
| `MESH_ENGINE_UNSUPPORTED`                                                                                                                                                                                                                                   | port                                                  | no installed engine answers the op                                                             | run in the desktop / CLI host (Manifold + native)                    |
| `MESH_ENGINE_CAP_EXCEEDED` (+ `NATIVE_TOOL_MISSING`)                                                                                                                                                                                                        | port                                                  | over the TS cap and no `llull-compute`                                                         | install the native bundle; or decimate a copy first                  |
| `MESH_TARGET_UNREACHABLE`                                                                                                                                                                                                                                   | `decimate_mesh` (`requireTarget`)                     | stop rule halted before the target                                                             | raise `maxDeviation` or lower the target                             |
| `MESH_HOLE_NOT_FOUND` / `MESH_HOLE_TOO_LARGE`                                                                                                                                                                                                               | `fill_mesh_holes`                                     | loop index / point not on a loop; loop above `maxBoundaryEdges`                                | `analyze_mesh` for loop ids; raise the limit or `wrap`               |
| `MESH_REMESH_EDGE_TOO_LARGE`                                                                                                                                                                                                                                | `remesh_mesh`                                         | target > 0.25 × bbox diagonal (Rhino: fails "if the target edge length is set too large" [R6]) | lower `targetEdgeLength`                                             |
| `MESH_OFFSET_RESOLUTION`                                                                                                                                                                                                                                    | offset, hollow, wrap                                  | grid cells > cap                                                                               | raise `tolerance`                                                    |
| `MESH_CUT_MISSES`                                                                                                                                                                                                                                           | `cut_mesh`                                            | plane does not cross the mesh                                                                  | move the plane                                                       |
| `MESH_BOOLEAN_FAILED`                                                                                                                                                                                                                                       | boolean (mesh engine)                                 | engine status ≠ ok (Manifold status text included)                                             | `check_mesh purpose=boolean`                                         |
| `MESH_HULL_DEGENERATE`                                                                                                                                                                                                                                      | `convex_hull`                                         | < 4 non-coplanar points                                                                        | add points                                                           |
| `MESH_SCULPT_STAMP_OFF_SURFACE`                                                                                                                                                                                                                             | `sculpt_mesh`                                         | stamp farther than `radius` from the mesh                                                      | pick a point on the surface (`analyze_mesh` bounds, `nearest` query) |
| `MESH_SEGMENT_NO_GROUPS`                                                                                                                                                                                                                                    | `segment_mesh`                                        | nothing fits within tolerance                                                                  | raise `fitTolerance`; use `mode=faceted`                             |
| `MESH_BREP_SEW_FAILED` / `MESH_BREP_GROUP_FACETED` (warn)                                                                                                                                                                                                   | `mesh_to_brep`                                        | sewing left free edges / a group fell back to facets                                           | report groups; adjust `fitTolerance`                                 |
| `MESH_QUAD_REMESH_FAILED` / `MESH_FIT_NOT_CONVERGED` (warn)                                                                                                                                                                                                 | quad / fit                                            | solver failure / deviation above target after `iterations`                                     | remesh + smooth first; raise iterations                              |
| `MESH_TIMEOUT`                                                                                                                                                                                                                                              | native jobs                                           | `--timeout` reached                                                                            | raise the timeout; decimate a copy                                   |
| `MESH_CHECK_NOT_CLOSED`, `MESH_CHECK_NON_MANIFOLD`, `MESH_CHECK_INCONSISTENT_ORIENTATION`, `MESH_CHECK_INVERTED`, `MESH_CHECK_SELF_OVERLAP`, `MESH_CHECK_DEGENERATE`, `MESH_CHECK_SMALL_SHELLS`, `MESH_CHECK_WALL_THIN`, `MESH_CHECK_TRIANGLES_ABOVE_LIMIT` | `check_mesh` (fail / warn per purpose)                | the named defect, with ids, worst location, value, limit                                       | the repair command named in the finding                              |
| `MESH_CHECK_TOLERANCE_DEFAULTED` (warn), `MESH_CHECK_INPUT_UNVERIFIED` (warn, not suppressible)                                                                                                                                                             | `check_mesh`                                          | a named default was used / an input is `unverified`                                            | give the value / pin the source sha256                               |

### 7.2 Result conventions (AF-10, AF-31..35)

Lengths in document units with a top-level `unit`; areas `areaUnit`, volumes `volumeUnit`; angles `…Deg`. Every result:
`unverified` (true when any input mesh's `meshSource.verified` is false, walking `keepSource` chains and FeatureStep inputs),
`provenance` (§3 `MeshOpResult.provenance` + params + input sha256), `defaults[]`. `measure_deviation` and `check_mesh` with
`purpose: "inspection"` carry `reviewRequired: true` ("as-built acceptance is a quality decision: needs a qualified person").
Lists are capped (`maxListed`, default 20) with totals.

### 7.3 Agent-first compliance

| AF            | Where                                                                |
| ------------- | -------------------------------------------------------------------- |
| AF-01, 02, 05 | FR-MSH-35; §4 descriptions name units, refusals and the next command |
| AF-03         | FR-MSH-36 guide section                                              |
| AF-04         | units in every param description; `units` required on import         |
| AF-10, 12, 35 | §7.2                                                                 |
| AF-11         | §7.1                                                                 |
| AF-13         | canonical order §3, VC-MSH-21 / 32                                   |
| AF-20, 21, 30 | `check_mesh`; `analyze_mesh` is the numeric inspector                |
| AF-22         | `render_view` in the workflow                                        |
| AF-31, 32, 33 | §5.12, §7.2                                                          |
| AF-40, 41, 42 | §5.10 progress / timeout, bundled native, `--dry-run`                |

## 8. Performance & robustness budgets (desktop, targets to confirm by VC-MSH-29)

| Operation                                   | TS engine                                                                                                                                             | Native engine        | Notes                                   |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | --------------------------------------- |
| `import_mesh_file` binary STL 1 M triangles | — (asset path)                                                                                                                                        | ≤ 2 s                | TBD measure                             |
| `analyze_mesh` 200 k                        | ≤ 1 s                                                                                                                                                 | ≤ 0.2 s              | self-intersection broad phase dominates |
| `decimate_mesh` 1.3 M → 100 k               | refuses (cap)                                                                                                                                         | ≤ 10 s               | 4.8 s measured (13.10)                            |
| `remesh_mesh` 200 k, 5 iterations           | ≤ 10 s                                                                                                                                                | ≤ 2 s                |                                         |
| `smooth_mesh` taubin 10 it, 1.3 M           | refuses (cap)                                                                                                                                         | ≤ 2 s                |                                         |
| `minkowski_sum` cube ⊕ icosphere l2         | Manifold ≤ 0.5 s                                                                                                                                      | —                    | TBD                                     |
| `offset_mesh` level set, 10⁶ cells          | Manifold ≤ 5 s                                                                                                                                        | shared 05 IMP mesher |                                         |
| Robustness                                  | every engine failure returns a code; no crash on NaN, empty, all-degenerate, 2-manifold-with-boundary input; fuzz corpus of malformed STL / OBJ / PLY |                      |                                         |

## 9. Test strategy

| Level           | Location                                                                   | Content                                                                                 | VC                  |
| --------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------- |
| Unit (mesh lib) | `tests/unit/mesh/lib/*.test.ts`                                            | weld, half-edge, loops, shells, genus, orientation, self-intersections on `data/*.json` | 01, 02, 04          |
| Unit (readers)  | `tests/unit/mesh/formats/*.test.ts`                                        | the pinned STL fixtures, OBJ / PLY / 3MF made in the test, fuzz cases                   | 03                  |
| Unit (commands) | `tests/unit/mesh/*.test.ts`                                                | happy + failure per command, `is pure`, codes of §7.1                                   | 05–21, 25–28, 35–39 |
| Contract        | `tests/unit/contract/`                                                     | tool-schema snapshot, toolset `mesh` + design-language example, units audit             | 33                  |
| Golden          | `tests/golden/plans.ts` + `validation/plans/target_*.json`                 | id-normalised snapshots + replay equality                                               | 21, 30              |
| Native          | `solver/crates/llull-meshops` `cargo test`; `server/tests/meshops.test.ts` | TS vs native sha256 equality; caps; licences present                                    | 29, 32              |
| Kernel          | `server/tests/meshToBrep.test.ts`                                          | prismatic B-rep, faceted, subdivision fit → B-spline                                    | 22–24               |
| Component       | `tests/component/MeshReviewOverlay.test.tsx`                               | overlays never mutate                                                                   | 34                  |

### 9.1 Technical requirements

| Id        | Requirement                                                                                                                        | Spec        | VCs        |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------- | ---------- |
| TR-MSH-01 | Pure mesh library in `geometry/mesh/` (weld, half-edge, loops, shells, orientation, genus, quality, self-intersection)             | §5.1        | 01, 02     |
| TR-MSH-02 | `MeshProcessingEngine` port, TS engine with caps, composite routing by capability and size, canonical output order                 | §2, §3      | 32         |
| TR-MSH-03 | Native `llull-meshops` crate + `llull-compute meshops` job, bit-identical to the TS engine on shared ops                           | §5.10       | 29, 32     |
| TR-MSH-04 | Manifold-backed engine ops in `kernel-manifold` (hull, Minkowski, level set, boolean, split)                                       | §1.2, §5.8  | 11, 12, 15 |
| TR-MSH-05 | `MeshSolidEntity` fields `asset`, `meshSource`, `faceGroups`; indexed storage of results; persistence checks                       | §3          | 31         |
| TR-MSH-06 | `MeshAssetPort`, host store, `llull mesh import`, STL / OBJ / PLY / 3MF readers in `lib/meshFormats`                               | §6          | 03, 31     |
| TR-MSH-07 | Catalog `commands/mesh/catalog.ts`, toolset `mesh` with a design-language example, agent-written descriptions                      | §4          | 33         |
| TR-MSH-08 | Algorithms: repair, Liepa fill, QEM with the one-sided bound, Botsch–Kobbelt remesh, Taubin with volume correction, sculpt brushes | §5.2–5.7    | 04–10, 19  |
| TR-MSH-09 | `boolean` engine routing; triangle-only meshes never go through polyhedral OCC solids under `auto`                                 | §5.8        | 18         |
| TR-MSH-10 | Segmentation (shared `llull-fit`), native `brepFromFaceGroups`, QuadriFlow, subdivision cage fit                                   | §5.9        | 22, 23     |
| TR-MSH-11 | Stable codes of §7.1 with paths, ids and remediation                                                                               | §7.1        | 26         |
| TR-MSH-12 | `check_mesh` purposes and findings                                                                                                 | §4, §7.1    | 28         |
| TR-MSH-13 | `meshSource` provenance, `unverified` propagation, named defaults, `reviewRequired` for inspection                                 | §5.12, §7.2 | 27         |
| TR-MSH-14 | Budgets and caps of §8, progress and timeout                                                                                       | §8          | 29         |
| TR-MSH-15 | Licence policy of §5.11; notices bundled                                                                                           | §5.11       | 29         |
| TR-MSH-16 | Tests and golden plans of §9                                                                                                       | §9          | 30, 32     |

## 10. Delivery plan

| Milestone | Content                                                                                                                                            | Depends on                 | Effort (eng-weeks) |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------ |
| M0        | D1–D6 decisions; `geometry/mesh` library; readers; `import_mesh_file`; `analyze_mesh`; `check_mesh`; port + TS engine skeleton; toolset `mesh`     | —                          | 3                  |
| M1        | `repair_mesh` (all but wrap), `fill_mesh_holes`, `decimate_mesh`, `remesh_mesh`, `smooth_mesh`, `cut_mesh`, symmetric `measure_deviation`, helpers | M0                         | 4                  |
| M2        | Manifold engine: `convex_hull`, `minkowski_sum`, `boolean` routing, `offset_mesh`, `hollow_mesh`, `repair_mesh mode=wrap`, `subdivide_mesh`        | M0; 05 IMP mesher optional | 3                  |
| M3        | Native `llull-meshops` (+ `llull-fit` extraction from `llull-cloud`), asset store, `llull mesh import`, `attach_mesh_asset`, LOD                   | M1                         | 5                  |
| M4        | `sculpt_mesh` (+ 04 DIR gesture), `shrinkwrap_mesh`, `displace_mesh`                                                                               | M1                         | 3                  |
| M5        | `segment_mesh`, `mesh_to_brep` (faceted, prismatic) on the native kernel                                                                           | M3                         | 5                  |
| M6        | `quad_remesh` (QuadriFlow), `fit_subdivision_to_mesh` (cage cap raised), `fit_surface_to_mesh`                                                     | M3, M5, 02 SRF surface fit | 5                  |

Total ≈ 28 eng-weeks. Cross-gap: **05 IMP** (shared field → mesh mesher), **04 DIR** (sculpt gesture), **02 SRF**
(`nurbs_surface`, `lib/nurbs` fitting), plant **10 SCN** (fits, asset pattern), **01 DEF** (may reuse §5.4 refinement before
deforming meshes).

## 11. Open questions / decisions needed

| #   | Question                                                                                                       | Proposal                                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| D1  | Engine-written content-addressed result assets for large meshes (§2.3)                                         | Accept: idempotent, content-addressed, document stays pure in its inputs                                                |
| D2  | Keep a TS engine (runtime below the cap + oracle)                                                              | Yes, `meshBvh` / `llull-geomq` precedent                                                                                |
| D3  | New toolset `mesh` (needs a design-language example) vs listing under `3d`                                     | New toolset `mesh`; `3d` lists `convex_hull`, `minkowski_sum`, `offset_mesh` too                                        |
| D4  | `boolean engine=auto` changes today's behaviour for imported meshes on the native kernel (no polyhedral B-rep) | Accept: results become mesh-only (no `brep`), faster and robust; `engine=kernel` keeps the old path                     |
| D5  | `MAX_CAGE_VERTICES` 2000 blocks quad-remeshed cages                                                            | Raise to 50 000 for cages created by `quad_remesh` (B-spline face count = quads × 4^(levels−1) — keep levels ≤ 2 there) |
| D6  | Mesh results stored indexed (not soup)                                                                         | Yes for new commands; `import_mesh` unchanged                                                                           |
| D7  | Recorded results from Manifold WASM (version-bound determinism)                                                | Record `manifold-3d@<version>` in provenance; goldens pinned per version                                                |
| D8  | Liepa weight details (paper not readable here)                                                                 | Implement as §5.6, confirm against the paper before M1 closes                                                           |

## 12. References

Same numbering as FUNCTIONAL_SPEC §11 ([R1]–[R39]). llull internal: `docs/decisions/RS1-native-compute.md`,
`docs/decisions/LIM1-scale.md`, `docs/decisions/KI7-native-kernel-default.md`, `docs/plant/10-pointcloud-brownfield/TECHNICAL_SPEC.md`,
`docs/aerospace/02-advanced-surfacing/TECHNICAL_SPEC.md` §13, `.claude/rules/architecture.md`.

## 13. As built (DES-7: M0 and M2, 2026-10-22)

Built in the working tree (not committed by the author agent); toolset **`mesh`** (9 commands). Not built: M1, M3–M6 (everything else in §4).

### 13.1 What exists

| Piece                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Where                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Readers STL ascii + binary, OBJ (concave polygons ear-clipped), PLY (ascii, LE, BE), 3MF (stored + DEFLATE ZIP, components, build transforms, unit); `inflateRaw`, `unzip`                                                                                                                                                                                                                                                                                                | `packages/core/src/lib/meshFormats/*`, `lib/inflate.ts`, `lib/zipRead.ts`                                                                 |
| Mesh library: weld (first-use canonical order), edge/shell/loop topology, analysis, crossing-triangle search, quickhull (adjacency walk), midpoint + Loop subdivision, BVH distance + generalized winding number (`MeshField`), wall thickness                                                                                                                                                                                                                            | `packages/core/src/geometry/mesh/*`                                                                                                       |
| Port `MeshProcessingEngine` (`engineTypes.ts`), registry + composite (`engine.ts`), TS engine (analyze, hull, convex Minkowski sum, normal offset, midpoint/Loop)                                                                                                                                                                                                                                                                                                         | `packages/core/src/geometry/mesh/` ; `ExecutionContext.meshProcessing`                                                                    |
| Manifold engine (Minkowski sum/difference, booleans, level-set offset / hollow / wrap, smooth refinement) pinned to `manifold-3d@3.5.4` in every provenance (D7; a unit test compares it with `node_modules`); every WASM object of a call is freed in one `finally`                                                                                                                                                                                                      | `packages/kernel-manifold/src/manifoldMeshEngine.ts`, `manifoldModule.ts`; installed by `server/src/geometryKernel.ts` and `src/main.tsx` |
| Commands `import_mesh_file`, `analyze_mesh`, `check_mesh`, `convex_hull`, `minkowski_sum`, `offset_mesh`, `hollow_mesh`, `repair_mesh` (mode `wrap` only), `subdivide_mesh`                                                                                                                                                                                                                                                                                               | `packages/core/src/commands/mesh/*`                                                                                                       |
| `boolean` gains `engine: auto \| kernel \| mesh` (D4 accepted) and becomes **kernel-optional**: `auto` is decided from the operands alone (mesh entities without `brep` go to the mesh engine on every host, so replay does not depend on what the host installed; without a mesh engine they refuse `MESH_ENGINE_UNSUPPORTED`); results are plain meshes; operands are consumed through `withoutEntities` (selection, groups, constraints, joints, pattern seeds follow) | `commands/brep/boolean.ts`, `meshBoolean.ts`                                                                                              |
| Model: `MeshSolidEntity.meshSource`, `.faceGroups`, validated on load                                                                                                                                                                                                                                                                                                                                                                                                     | `model/types.ts`, `model/meshProvenance.ts`, `persistence/guards.ts`                                                                      |
| CLI: `file=PATH` fills `base64` of `import_mesh_file`, also inside plan actions (loops included)                                                                                                                                                                                                                                                                                                                                                                          | `server/src/cli/exchange.ts` `withPlanFileContent`                                                                                        |

### 13.2 Decisions taken where the spec was open

- **File reading stays on the host** (existing `import_iges` pattern): the command takes `base64` or `text`, computes the sha256 itself and is pure.
- **Result assets (D1) are not built.** Results are inline; the import step records the file bytes as `base64` in the FeatureStep, so a saved document carries the file size until the M3 asset store replaces it by a key. The reader caps bound memory, not document size.
- **Hull and convex Minkowski sums run in the TS engine in doubles** (exact to 1e-12), not through Manifold (float32 positions would miss the 1e-9 gates). Manifold answers non-convex sums and every difference. The `hull` op counts points against `MESH_HULL_POINT_LIMIT`, other ops count input triangles.
- **Mesh result commands rewrite the source in place** (same id, order slot and base fields: layer, colour, name, tags, material, pattern seed; decals only while the source sat at the identity transform) unless `keepSource` / `keepSources`; `minkowski_sum` never changes `b`. Results are world-space (`position`/`rotation` zero) with `meshSource {format:'generated', verified: !unverified}`; `unverified` propagates from the inputs.
- **Level-set grid**: the cell edge is the requested `tolerance` (a vertex of a 1-Lipschitz distance field then lies within one edge of the surface, so |dV| <= area x tolerance is rigorous). When that needs more than `maxCells` (default 40 000, ceiling 2e7: a JS field callback costs about 30 us per sample, so the default call stays near 1-2 s) the edge grows to fit and the result says so: `toleranceMet` false, `edgeLength`, `errorBound` = area x edge (rigorous but loose for smooth surfaces, whose measured deviation is far smaller). A grid with fewer than 4 cells across the bounding-box diagonal refuses `MESH_OFFSET_RESOLUTION`.
- **Offset / hollow / wrap use `MeshField`** (typed-array BVH: distance, generalized winding number > 1/2, dipole approximation far away), `wrap` as specified in §5.2. `hollow` = input minus the level-set parallel body at -wall (outer surface kept).
- **Import limits**: bodies and triangles are counted while 3MF components expand (`MESH_IMPORT_TOO_LARGE`); only `*.model` ZIP entries are inflated, capped at `MAX_IMPORT_BYTES` (256 MiB) in total; stored-block `NLEN` and entry sizes are checked; PLY element counts above the file size are refused; an `end_header` inside a comment is ignored.
- **`check_mesh`**: the two notes about the check itself (`MESH_CHECK_TOLERANCE_DEFAULTED`, `MESH_CHECK_INPUT_UNVERIFIED`) are listed in `findings` with severity `warn` but never change `status`; severities per purpose are the table in `commands/mesh/checkMesh.ts`. Wall thickness probes inward rays from at most 20 000 evenly strided triangle centroids.
- **Analysis**: degenerate faces belong to no shell and add nothing to χ; a shell whose faces disagree on orientation reports no volume and no genus; self-intersections count transversal crossings only (shared-vertex pairs, coplanar overlaps and touching contacts are not counted; huge triangles are tested against everything instead of filling the grid).
- **Toolset pointer**: every tool is in exactly one toolset (contract test), so `3d` does not also list `convex_hull`, `minkowski_sum`, `offset_mesh` (the `TOOLSET_SEE_ALSO` slot of `3d` already points to `manufacturing`).
- `mesh.lld` design-language example added (SRF-3 rule).

### 13.3 Measured values (document mm; tests assert the bounds)

| VC     | Measured                                                                                                                                                                                                                                                                                                                             | Expected / bound                           |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| 01     | icosphere l0-l4 area and volume equal the table                                                                                                                                                                                                                                                                                      | 1e-9 relative (levels 5-6 not run)         |
| 02     | l3: V 642, F 1280, chi 2, genus 0; torus 32x16: chi 0, genus 1, V 382.248110338, A 390.680247285; upper half: 624 faces, 1 loop of 48 edges                                                                                                                                                                                          | exact                                      |
| 03     | ascii: 80 tri, 42 vertices, V 3658.712208 (sha256 pinned); binary: V 3658.712165; inch file x 25.4: V x 16387.064                                                                                                                                                                                                                    | 1e-9                                       |
| 11     | cube + interior points: 8 vertices, 12 triangles, V 1000, A 600; icosahedron V 17.453559925; torus hull below 545.0617 within 1.6 %                                                                                                                                                                                                  | 1e-9 / bound                               |
| 12     | cube 10 (+) icosphere r2 l1/l2/l3: pack polyhedral volumes                                                                                                                                                                                                                                                                           | 1e-9                                       |
| 13, 14 | 2197 (1e-12); cube (-) cube 343 and cube (-) ball 216 via Manifold                                                                                                                                                                                                                                                                   | 1e-9                                       |
| 15     | icosphere l5 R10, tolerance 0.01, maxCells 100 000 (edge 0.53 / 0.49, `toleranceMet` false): +1 -> 5568.954 (dV -6.33, pack bound 15.19, reported errorBound 810.9); -1 -> 3049.304 (dV -4.32, bound 10.17); cube, tolerance 0.15 (met): +1 -> 1698.211 (dV -0.23); -1 -> 512.000000 (dV -5e-12 against (a - 2d)^3, errorBound 57.6) | area x 0.01 (pack), area x edge (reported) |
| 16     | sphere R10 wall 1 -> material 1137.221 (dV +2.06, bound 22.73)                                                                                                                                                                                                                                                                       | area x 0.01                                |
| 18     | two cubes: union 15 / A 42, subtract 7 / 24, intersect 1 / 6, no brep                                                                                                                                                                                                                                                                | 1e-12                                      |
| 35     | two icosphere l5 soups: closed, 0 crossings, V 7068.966 (dV +0.38, bound 18.85), A 1887.78 (pack 1884.96)                                                                                                                                                                                                                            | area x 0.01                                |
| 36     | icosahedron midpoint x1: 80 faces, A 34.6410161514, V 17.453559925                                                                                                                                                                                                                                                                   | 1e-12                                      |

Pack plans run with `node server/bin/llull.cjs run <plan> --continue` (native kernel, cwd `docs/design/07-mesh-modeling`): `target_hull_minkowski_offset` now runs 13/13 steps (hull V 1000; cube (+) ball l2 2601.81399007 from float32 STL coordinates, 6e-10 relative to the pack value; cube (+) cube 2197; cube (-) cube 343; fine-icosphere offset +1 -> 5568.954 against 5575.280, inside the plan's 0.27 % bound). The plan imports two generated binary STLs (`data/icosphere_r10_l5_binary.stl`, `data/icosphere_r2_l2_binary.stl`, section 6 of `generate_mesh_algorithms.mjs`) instead of `add_sphere` / `add_icosphere_mesh`. `target_scan_cleanup_to_print` imports the binary STL (V 3658.712165), analyzes it, `check_mesh purpose=print` PASS (unverified noted), exports 3MF; the M1 steps fail as unknown commands. `target_bad_plan_codes`: step 3 `MESH_ENTITY_NOT_FOUND`, step 5 `MESH_IMPORT_UNITS_REQUIRED` as specified.

### 13.4 Findings and open items

1. **VC-15 on `add_sphere`** (fixed in the pack): the display tessellation of an exact sphere is 4.2 % short of the sphere (V 4012.41), so its offset misses the closed form by -208 whatever the engine does; the plan now offsets an imported fine icosphere.
2. **Plan parameters differ from the built commands**: `hollow_mesh` takes `tolerance` / `maxCells`, not `resolution`, and no `drainHoles` yet; `repair_mesh` has only `mode: wrap`; the pack plans use `stitch`, `orient`, `removeSmallComponents`, `weldTolerance` (M1).
3. Not built from M0/M2 wording: `repair_mesh` modes weld / clean / orient / stitch / close_holes (M1), hollow `drainHoles`, `subdivide_mesh` `smooth` on open meshes (Manifold refuses: `MESH_NON_MANIFOLD`), `check_mesh purpose=inspection`, `meshSource.format: 'triangles'`, native engine. The CLI progress announcer lists commands that `requiresKernel`, so `boolean` is no longer announced as a kernel command.
4. Pack-error to fix in the data: VC-MSH-35 expects the smooth lens-union volume; a polyhedral icosphere l3 pair misses the bound by itself (0.86 % per sphere), the test uses l5.
5. `import_mesh_file` records the file bytes in the FeatureStep (see 13.2): large scans wait for M3.
6. Removed a bug found by the zlib cross-check: `inflateRaw` mis-indexed canonical Huffman tables with unused symbols (fixed, tested against `node:zlib` output).

## 13.5 As built (DES-7b: M1, M3, M4, M5, 2026-10-23)

### 13.5.1 What exists

- **M1 commands** (all pure, mesh-engine port, refusals coded): `repair_mesh` modes weld, clean, orient, stitch, close_holes, wrap; `fill_mesh_holes`; `decimate_mesh`; `remesh_mesh`; `smooth_mesh`; `cut_mesh`; `measure_deviation symmetric`; `hollow_mesh drainHoles` (M2 leftover); `segment_mesh`; `attach_mesh_asset`. Library in `packages/core/src/geometry/mesh/` (`editMesh`, `repair`, `holeFill` + `holeTriangulate` + `holeRefine`, `decimate`, `remesh`, `smooth`, `planeCut` + `capTriangulate`, `deviation` + `surfaceIndex`, `segment` + `primitiveFit` + `linear`, `sculpt`, `primitives`, `fastMeasure`, `lod`, `assets`).
- **M3**: native crate `solver/crates/llull-meshops` (job `llull-compute meshops <folder>`: decimate, smooth, deviation), bit-identical to the TS oracle (sha256 compared in `server/tests/meshopsNative.test.ts`; `llull-jsmath` gained a V8-exact `cbrt`); host adapter `server/src/native/meshProcessingEngine.ts` composed with Manifold by `composeMeshEngines`; content-addressed asset store (`server/src/meshAssets/`, canonical bytes u32 vertices, u32 triangles, f64 positions, u32 indices, key sha256; cache dir `LLULL_MESH_CACHE`), `llull mesh import|list`, `import_mesh_file file=PATH` (`fileKey` replaces the inline base64), `attach_mesh_asset`, exporters read the full-resolution asset (`MESH_ASSET_MISSING` when absent). Documents keep a display LOD (vertex clustering, 50k triangles) above 100k triangles.
- **M4**: `sculpt_mesh` (brushes draw, inflate, grab, smooth (+ taubin), flatten, pinch, crease, layer; falloffs constant, linear, smooth, sphere; symmetry planes; `maskRegion`, `refineEdge`, `planePoint`, `maxHeight`), `add_grid_mesh`, `add_icosphere_mesh`. TS engine only.
- **M5**: `segment_mesh` (read-only; plane, cylinder, cone, sphere fits) and `mesh_to_brep` (`faceted`: one planar face per triangle; `prismatic`: one exact face per fitted region, `requiresKernel`, kernel op `meshToBrep` in `llull-kernel`, C++ in `solver/crates/llull-kernel-occt/cpp/mesh_brep.cxx`).

### 13.5.2 Decisions

1. `segment_mesh` is a pure query; the groups become `faceGroups` only through `mesh_to_brep` (a command that both reads and mutates would break replay semantics).
2. `mesh_to_brep` stores the OCCT B-rep text as a document blob (`occt-brep-v1`, like `import_shapes`) and the entity keeps `brep: {op: 'brep', blob}`; the mesh is the display tessellation.
3. Prismatic faces: group boundaries are chains of boundary edges; a chain between two analytic groups becomes the exact `GeomAPI_IntSS` curve (line, circle, ellipse) when every chain vertex is within `fitTolerance` of it, else polyline edges and the groups fall back to triangle faces (`MESH_BREP_GROUP_FACETED`). Faces: `BRep_Builder::MakeFace` + `ShapeFix_Face` (wire orientation tried both ways), sewn, made a solid, validated; free edges or an invalid solid refuse with `MESH_BREP_SEW_FAILED`.
4. `direction` of `draw`: `area_normal` (default) is the n-bar of 5.7, `normal` the per-vertex normal (identical on a plane), a vector fixes it. `grab` requires the vector.
5. Flatten: the plane passes through the area-weighted centroid of the brush region at the start of each stamp (5.7). VC-MSH-20 as worded ("max |z| 0 after flatten") cannot hold from that definition, because the bump raises the centroid; `planePoint` was added and the VC is met with `planePoint [0,0,0]`.
6. A stamp and its mirror are computed from the same positions and added (not applied one after the other), which makes a symmetric stroke symmetric to rounding; a stamp on the mirror plane applies once.
7. Not natively accelerated: analyze, remesh, cut, fill, repair (TS cap 200k triangles, `MESH_ENGINE_CAP_EXCEEDED` above).

### 13.5.3 Measured values

| VC | Result |
| -- | ------ |
| 04 | defect mesh 326 -> 320 faces, closed, V 4047.04467998, A 1232.98485952 (1e-9) |
| 05 | planar 8-loop: 6 triangles, area 4; sphere pole flat fill 4152.554046689 against 4152.74081709, alpha 3 + curvature fairing 4152.7629 |
| 06 | planar and tilted 12x12 grids: 46 faces, area exact (1e-9), planarity 1e-12, `reachedTarget` false |
| 07 | icosphere l5 maxDeviation 0.05: 926 triangles, forward max 0.04982, backward 0.04996 |
| 08, 09 | Laplacian / Taubin / noisy smoothing match the reference (1e-9) |
| 10 | l4 -> L 1, 5 iterations: max edge <= 1.3333, mean 1.05, 75 % in band; Hausdorff 0.0314 to the polyhedral input. AC-08 is amended (FUNCTIONAL_SPEC): the pack bound 0.0296737 assumes input vertices on the true sphere, so the test measures max (10 - r) over vertices (<= input sag) and triangle centres (<= 0.0296737 + input sag) |
| 17 | cube cuts exact (1e-12) |
| 19 | draw on the 80x80 grid, discrete volumes of the four falloffs equal `sculpt_cases.json` (1e-9 relative); smooth case 8.377689362 in the plan run |
| 20 | flatten to z = 0 after draw: max abs z < 1e-12; grab [0,0,s] equals draw exactly |
| 21 | mirrored stroke symmetry error <= 1e-12; replay and re-run give the same sha256 |
| 23 | plate with a 64-gon hole: 6 planes + 1 cylinder, radius error < 1e-9; B-rep (native kernel) 6 plane + 1 cylinder faces, volume 5607.3009183, 7 B-rep faces |
| 24 | icosphere l2 faceted: 320 faces, V 4047.04467998 (1e-9), `mass_properties` method exact |
| 25 | parallel grids: Hausdorff = mean = rms = 0.5 |
| 32 | native decimate, smooth, deviation byte-identical to the TS engine |

Scale (1,310,720-triangle noisy sphere, 65 MB STL): `mesh import` 4.1 s, `attach_mesh_asset` about 2.4 s, document 1.8 MB, native taubin x10 with volume correction 1.0 s (CLI 8.6 s), native decimate to 100k 16.6 s (CLI 23 s; the TBD 10 s budget is not met), decimate maxDeviation 0.05 -> 238,798 triangles (forward 0.04999), symmetric deviation 13.5 s, full-resolution binary STL export 1.56 s (65,536,084 bytes).

Plans (`node server/bin/llull.cjs run <plan> --continue`, cwd `docs/design/07-mesh-modeling`): `target_defect_repair` 7/7; `target_scan_cleanup_to_print` 12/12 (the plan now cuts before hollowing and drains at z = -8; its hollow step changed from `resolution 0.2` to `tolerance 0.4, maxCells 150000`: the built command has no `resolution`; `tolerance` and `maxCells` bound the level-set grid, and 0.4 / 150000 keeps the step fast while `check_mesh purpose=print` still passes (measured, 12/12)); `target_bad_plan_codes` refuses with the expected codes; `target_hull_minkowski_offset` 13/13; `target_sculpt_quad_brep` is PARTIAL (the same status as in the plan file): steps 0-4 pass, steps 5-7 fail because `quad_remesh` / `fit_subdivision_to_mesh` do not exist (M6).

### 13.5.4 Left

- **M6**: `quad_remesh` is built (13.6); `fit_subdivision_to_mesh`, `fit_surface_to_mesh` and the fit half of VC-22 are built (13.7).
- `sculpt_mesh` `along` (curve stamps) and the 04 DIR gesture; `shrinkwrap_mesh`, `displace_mesh` (COULD); torus fit; native `analyze` / `remesh` / `cut` / `fill` / `repair` / `sculpt`. (Native decimate speed: built, 13.10.) (`--progress` events and the async native engine are built: 13.8.)
- The native mesh engine no longer blocks the backend: a job is awaited on the event loop (13.8), capped by `LLULL_MESH_OP_TIMEOUT_S` (600 s, `MESH_TIMEOUT`).
- `mesh_to_brep` follows exact curves only for line, circle and ellipse chains; regions bounded by other intersections (cone-cylinder with tilted axes, free-form) stay triangles.

## 13.6 As built (DES-7c step 1: M6 `quad_remesh`, 2026-10-27)

`quad_remesh` (toolset `mesh`) is built on the native mesh engine. `fit_subdivision_to_mesh` and `fit_surface_to_mesh` belong to M6 in the delivery plan but are separate commands with their own algorithms; they were built in the next step (13.7).

### 13.6.1 Stack decision (C7) and licences

- **QuadriFlow, vendored C++, built by `cc` through a `cxx` facade, in a new crate `solver/crates/llull-quadflow`.** The spec said "in `llull-meshops`". A separate crate keeps 5 MB of third-party C++ and a C++ compiler requirement out of the crate whose ops are bit-identical to the TypeScript engine; `llull-meshops` enables it with its cargo feature `quad`, and `llull-compute` turns the feature on. The facade is one call: an indexed triangle mesh in, an indexed quad mesh out. Why QuadriFlow and not Instant Meshes or a new Rust remesher: it is the spec's choice, it is a robust integer-grid quadrangulation that returns manifold quads with few singularities (measured below), and writing a field-aligned quad remesher is months of work, not a step. Instant Meshes stays the fallback.
- **Native only, no TypeScript twin.** Unlike decimate and smooth, the result is not bit-identical to anything in TypeScript. Without the native engine `execute` returns `MESH_ENGINE_UNSUPPORTED` (engine port, L9). The op is deterministic: single thread, and the random numbers come from the vendored pcg32 (the upstream `srand` / `rand`, `mt19937` and `std::shuffle` have implementation-defined sequences and are replaced by pcg32 and our own Fisher-Yates), so no library sequence enters the result. Two runs give identical bytes (tested in Rust and through the CLI). Floating-point code generation can still differ between compilers and CPUs, so a result is reproducible **per platform build**: `provenance.version` carries `<platform>-<arch>` and the command's `@invariant` says so. (Upstream's `pcg32::shuffle` returns at once because of a reversed bounds test, so the colouring order of the hierarchy is not shuffled; kept, as the behaviour is deterministic and measured.)
- **Licences, checked in the sources (not taken from the spec).** QuadriFlow (commit `810b7a09`, 2019-12-07): `LICENSE.txt` is the BSD-3-Clause text plus a paragraph granting a licence to "Enhancements". The "MIT" of the spec [R34] was wrong (that wording is Instant Meshes'). It is compatible with bundling; the notice is kept in the repo and staged into the desktop bundle. Eigen 3.4.0 is MPL-2.0 and is built with `EIGEN_MPL2_ONLY` (an LGPL include is a compile error); the vendored subset is the 273 headers the build includes (`BFloat16.h` is Apache-2.0, `IncompleteLUT.h` was relicensed to MPL-2.0 by its author). LEMON 1.3.1 (Boost Software License) and pcg32 (Apache-2.0) come from QuadriFlow's own `3rd/`. Not vendored: Boost, TBB, OpenMP, CUDA, Gurobi, ceres, the MapleCOMSPS SAT solver, `pss`. Texts: `solver/crates/llull-quadflow/vendor/licenses/`, staged by `desktop/scripts/prepare-native.mjs` into `licenses/quadflow/` (VC-MSH-29 licence bundling).
- **Build on Windows MSVC.** MSVC 2022 BuildTools compiles it in about 75 s (release, and debug with the package's `opt-level = 3`); `cc` gets `/bigobj /EHsc` and a force-included prelude (`/FI`, `-include`). GCC 14 passes `-fsyntax-only` on every translation unit (docker `gcc:14`); the Linux and macOS builds themselves were not run here. `solver/Cargo.toml` lists the crate in `default-members`, so `native:check` and CI compile it: a C++17 compiler is now needed for `cargo test` of the workspace.
- **Changes to the upstream code** (full list in `vendor/README.md`): the Boost max-flow helper is replaced by LEMON Edmonds-Karp (a push-relabel flow carries circulations that corrupt the integer offsets: the first try returned a third of the requested quads); `printf` is silenced, and `exit(0)`, `assert`, Eigen's `eigen_assert` and LEMON's `LEMON_ASSERT` (`LEMON_ASSERT_CUSTOM`) become exceptions (`QFLOW_FAIL`, `QFLOW_ASSERT`) from one force-included prelude, and the C `assert` itself is shadowed by `vendor/shim/assert.h` and `cassert` (first on the include path), so every assert in the vendored code throws and a bad mesh is an `Err`, not a dead process (the cargo test trips the Eigen path with an inconsistently wound box; the LEMON and flow handlers are not reachable through the facade, where the network simplex is never selected); the `system("minisat")` path (`-sat`) is removed; the sharp-edge angle is a parameter instead of 60 degrees. A target too small for the mesh (a tetrahedron asked for 6 quads) used to kill the process with an integer division by zero (exit code 0xC0000094). Bisecting probes through `ComputeIndexMap` found it: the extraction leaves no quad (`O_compact` empty), and Eigen's sparse LU divided by zero on the empty position system. It is now a `QFLOW_FAIL` after `FixValence` ("extracted no quad"), an `Err` in the Rust call (cargo test `tetrahedron_six_quads_is_an_error`); through the host, which renumbers the vertices, the same tetrahedron returns 3 faces and the cage validation refuses it (native test), both as `MESH_QUAD_REMESH_FAILED`.

### 13.6.2 What exists

| Piece | Where |
| ----- | ----- |
| Vendored QuadriFlow, facade, Rust wrapper, 6 cargo tests | `solver/crates/llull-quadflow` |
| Job op `quad_remesh` (`{targetFaces, hardEdgeRad?, adaptive}`; out `result_positions.f64` and `result_indices.u32` with FOUR indices per quad), cargo feature `quad` | `solver/crates/llull-meshops/src/quad.rs`, `lib.rs` |
| Port: `MeshOp quad_remesh`, `MeshOpResult.quads`, `QuadMeshData` | `geometry/mesh/engineTypes.ts` |
| Host adapter: capability with a 500 000-triangle cap (`MESH_ENGINE_CAP_EXCEEDED`), `editableProblem` (manifold, winding, degenerate), the `LLULL_MESH_OP_TIMEOUT_S` cap (`MESH_TIMEOUT`), every other failure `MESH_QUAD_REMESH_FAILED`, provenance `llull-compute@x + QuadriFlow@810b7a0` | `server/src/native/meshProcessingEngine.ts` |
| Command `quad_remesh`; cage helpers (outward winding, valence, hard-edge creases, triangulation) | `commands/mesh/quadRemesh.ts`, `geometry/mesh/quadCage.ts` |
| `MAX_CAGE_VERTICES` 2000 to 50 000 (D5) and a new `MAX_REFINED_QUADS` = 1 000 000 (cage faces x 4^levels) in `sizeProblem`, so every cage command refuses a dense cage at a high level (`DIR_CAGE_TOO_LARGE`, remediation "lower levels or the cage size"); the topology commands check it in `finishedCage`. The command's own cap is 40 000 quads, because the engine can overshoot its target by 15 % | `commands/subdivision/shared.ts`, `topologyResult.ts` |
| Plans `target_quad_remesh.json` (runnable), `target_sculpt_quad_brep.json` (steps 0-5 now run) | `validation/` |
| Tests | `tests/unit/mesh/quadRemesh.test.ts` (stub engine), `server/tests/quadRemeshNative.test.ts` (native engine, native kernel), `solver/crates/llull-quadflow/tests/remesh.rs`, a lifecycle design `seed/quad_remesh` with the stub engine in `tests/action_matrix/lifecycleCorpus.ts` (replay, undo, delete, clear) |

### 13.6.3 Decisions where the spec was open or wrong

1. **The source is kept** and a new entity is created (`subd-<step>.<k>` or `mesh-<step>.<k>`). The spec's convention "rewrite in place" would delete the target that `fit_subdivision_to_mesh {cageId, targetId}` and the plan need. There is no `keepSource`.
2. **Closed meshes only** (`MESH_NOT_CLOSED` otherwise). The spec says only "manifold". QuadriFlow does run on open meshes, but the result has valence-1 and -2 vertices all along the boundary and would need the open-cage `boundary` mode. Open input is a later extension.
3. **`symmetry` is not offered** (FR-MSH-22 lists it): QuadriFlow has no symmetry, and an accepted-but-ignored parameter is worse than none.
4. **`adaptiveSize` 0..100 is an on / off switch** (QuadriFlow's `-adaptive` is a flag); the description says any value above 0 is the same.
5. **`detectHardEdgesDeg`** does two things: it aligns the field to sharp edges of the source (`-sharp`, with the angle as a parameter), and for the subdivision output it makes cage edges creases when they follow a source edge sharper than the angle. The first version judged creases from the cage's own dihedral angles; a coarse cage of a torus got 184 creases on a smooth surface. Now a cage edge needs a sharp edge of the SOURCE under it: five samples along the edge (ends, midpoint, two more) must each lie within a quarter of the edge length (at most half a grid cell) of a sharp source segment that runs within 20 degrees of the edge. Every sample is matched on its own, so the source tessellation may be finer or coarser than the cage (the first rule needed one source segment to cover the whole edge and found 0 creases on a box tessellated 8 x 8 per face). The segments sit in a uniform grid with the median turned-edge length as the cell: linear time.
6. **Output `mesh`** splits the quads along the shorter diagonal into a triangle mesh (`MeshData` has no quads). `subdivision` (default) has `levels` 2 (D5: B-spline faces = quads x 4^(levels-1)); the refined surface is capped at 10^6 quads.
7. **The deviation is measured on the cage faces** (symmetric, native), not on the smooth limit surface, which lies inside the cage (-2 % volume on a sphere). Closing that gap is `fit_subdivision_to_mesh` (13.7).
8. **The result is re-validated** in TypeScript before anything is committed (`cageProblem`: closed, 2-manifold, consistent winding, no pinch; the winding of each connected shell is reversed on its own when its signed volume is negative, so two spheres with one inside out come out outward). Before that, a result whose indices are out of range or whose coordinates are not finite is refused, and so is one that cannot be a remesh of the source (all `MESH_QUAD_REMESH_FAILED` with the measured value): its box sticks out of the source box by more than 5 % of the source diagonal on some side (one-sided: a valid coarse cage lies inside the box, the 6-quad cube on a sphere about 12 % of the diagonal inside on every side, so the first two-sided 5 % rule wrongly refused it), its diagonal is under 10 % of the source diagonal (collapsed), or, after `cageProblem` and before the crease search, a vertex is farther from the source surface than the longest quad edge next to it, i.e. an edge of an incident quad that does not touch it (per vertex, so a strongly graded cage with adaptiveSize passes, and a vertex pulled off the surface cannot excuse itself with its own stretched edges; a closest-point query per vertex on a bounding-box tree, linear in the vertices); the crease grid cell is at least 1e-3 of the source diagonal and a segment is walked in at most 4096 steps, so a tiny or broken cage cannot make the search run for minutes (a 1e-7-scaled cage hung for 30 s before). A result that fails is `MESH_QUAD_REMESH_FAILED`, never a corrupt cage.

### 13.6.4 Measured (release build, Windows MSVC, one machine; timings include the TypeScript validation and the deviation job)

| Case (R 10 sphere unless noted) | Quads (ratio to target) | Valence (vertices per number of quads around them) | Cage Hausdorff / mean | Time |
| --- | --- | --- | --- | --- |
| icosphere l4 (5120 tris), 600 | 614 (1.023) | {3: 8, 4: 608}, all quads | 0.0663 / 0.0294 mm | 0.7 s |
| icosphere l5 (20480), 600 | 609 (1.015) | {3: 8, 4: 603} | 0.0624 / 0.0312 | 0.7 s |
| icosphere l5, 600, adaptiveSize 50 | 538 (0.897) | {3: 9, 4: 530, 5: 1} | 0.0751 / 0.0357 | 0.9 s |
| icosphere l5, 2000 | 1788 (0.894) | {3: 8, 4: 1782} | 0.0230 / 0.0099 | 1.3 s |
| icosphere l5, 8000 | 6914 (0.864) | {3: 9, 4: 6906, 5: 1} | 0.0081 / 0.0027 | 6.9 s |
| l5 through the plan's float32 STL, 600 | 545 (0.908) | {3: 9, 4: 537, 5: 1} | 0.0824 | 0.7 s |
| box 10 mm (12 tris), 300 | 294 (0.98) | {3: 8, 4: 288}, 84 creases | 0.0183 / 0.0006 | 0.22 s |
| box tessellated 20 x 20 per face (4800 tris), 300 | 294 (0.98) | {3: 8, 4: 288}, 84 creases | 0.0551 / 0.0014 | 0.32 s |
| box tessellated 8 x 8 per face, 300 | 294 (0.98) | {3: 8, 4: 288}, 84 creases | 0.0246 / 0.0010 | 0.22 s |
| torus R 10 r 3 (48 x 24), 400 | 347 (0.868) | {3: 7, 4: 333, 5: 7}; vertices = quads (chi 0); 0 creases | 0.2908 / 0.0778 | 0.31 s |
| cube (12 tris), 6 | 6 (1.0) | {3: 8}; 12 creases | 0.0326 | 0.09 s |
| two disjoint spheres (l3, R 5, 20 apart), 200 | 188 (0.94) | {3: 16, 4: 176} | 0.2686 | 0.5 s |
| the same, the second sphere inside out | 206 (1.03) | {3: 16, 4: 194}; two shells, both outward, volume within 10 % of two spheres | 0.2139 | 0.2 s |
| icosphere l2 (320 tris), 40 000 (the cap; output mesh) | 40 807 (1.020) | n/a | 0.0219 | 122 s |
| icosphere l2 (320 tris), 6 | 8 (accepted, though 6 were asked) | {3: 8, 4: 2} | 3.2871 | 0.1 s |
| tetrahedron (4 tris), 6 | `MESH_QUAD_REMESH_FAILED`: the engine returns 3 faces, "a closed cage needs at least 4 faces" (the Rust call with the raw vertex numbering returns "extracted no quad" under both windings, so the host's renumbering decides) | n/a | n/a | 0.1 s |
| tetrahedron (4 tris), 100 | 61 (0.61) | {3: 8, 4: 55} | 0.2167 | 0.2 s |

The on-source check (one closest-point query per result vertex, including the index build) costs 0.47 s for a 40 000-vertex cage against an 82 000-triangle source and 1.6 s against a 328 000-triangle one (about 2.4 s extrapolated to the 500 000-triangle cap), measured once, not a test. That is small beside the engine job on such a source, and the deviation summary carries no per-vertex distances to reuse, so the check keeps its own index. Changing the random numbers to pcg32 moved the counts by a few quads (l4: 610 to 614) and the corner count of some runs (8 to 9 or 10, with one valence-5 vertex): the sum of (4 - valence) is 8 on every sphere-like result. That Euler check is a topology-consistency check (true of any closed genus-0 quad mesh), so the tests also assert at most 12 irregular vertices and valences 3 to 5, and pin the exact histogram for the reference build only (win32-x64, MSVC): {3: 8, 4: 608} on the l4 icosphere at 600 quads in the TypeScript test (614 quads), {3: 9, 4: 584, 5: 1} on the Rust icosphere (592 quads); other platforms may land on another valid histogram. The 50 000 row of the first build is replaced by 40 000, the cap (50 000 is now refused by the parameter range). Cylinder rims (radius 5, 64 segments, 300 quads): the largest gap between a rim circle and the nearest quad edge is 0.71 mm without sharp alignment and 0.15 mm with it (`preserve_sharp`), which is what the cargo test asserts; on a box the unaligned result is already as good (0.05 mm both ways).

The quad ratio is 1.0 by construction: every output face has four indices, and the output is validated as a closed quad surface. Target adherence on the sphere runs is 0.86 to 1.02, and 0.70 on the coarsest input; the command says "usually within 15 %" and returns `targetRatio`. Time grows faster than linearly with the quad count (7 s at 7 000 quads, 188 s at 51 000); the `LLULL_MESH_OP_TIMEOUT_S` default of 600 s covers the 40 000-quad cap; a timeout is `MESH_TIMEOUT` (remediation: raise the variable, lower the target, `decimate_mesh` first).

**VC-MSH-22, the quad_remesh half.** Icosphere l4 to 600 quads, cage as a subdivision solid at levels 2, native kernel: 614 quads give 2456 B-spline faces (= 614 x 4), all `bspline`, one closed solid. `mass_properties surfaceModel limit_patches` is exact: volume 4097.719 (sphere 4188.790, -2.17 %), area 1238.371 (1256.637, -1.45 %); through the plan's float32 STL, 4090.195 and 1236.858. The fit half is in 13.7.3 (max deviation 0.0078, exact volume -0.10 %).

Plans (`node server/bin/llull.cjs run <plan> --continue`, cwd `docs/design/07-mesh-modeling`, native kernel): `target_quad_remesh` 6/7 in about 9 s (the last step is the expected `CMD_INVALID_PARAMS` refusal; step 2 is `quad_remesh`: 545 quads, valence {3: 9, 4: 537, 5: 1}, Hausdorff 0.0824); `target_sculpt_quad_brep` steps 0-5 ok (step 5: 631 quads in the first build), steps 6-7 failed on the then unbuilt `fit_subdivision_to_mesh`; the plan runs 9/9 since 13.7.

### 13.6.5 Left

- `fit_subdivision_to_mesh`, `fit_surface_to_mesh` and the fit half of VC-22: built, see 13.7.
- Open (boundary) input with an open-cage output; symmetry.
- No known crash remains. (The one-cell box that crashed at 6 quads in a probe was its inconsistently wound variant, which the host refuses before the engine; the outward box gives 6 quads.)
- Time at 40 000 quads (about 2 minutes) no longer blocks the backend event loop (13.8).

### 13.6.6 Cage commands at 50 000 vertices (review round 1)

A closed cage of 48 602 vertices and 48 600 faces (box cage, 90 segments, level 1), one `execute` each on this machine: `add_subdivision_solid` 1.06 s; `edit_subdivision_cage` (move, soft falloff, change levels) 0.22 to 0.28 s; `set_cage_crease` 0.21 s; `inset_cage_faces` 0.64 s; `select_cage_elements` 0.55 s; `set_cage_symmetry` 0.42 s; `slide_cage_edges` 0.59 s; `bevel_cage_edges` 0.69 s (was quadratic in the number of new element ids: `includes` on arrays, now a Set); `weld_cage_vertices` 0.74 s; `loop_cut_cage` 0.75 s; `extrude_cage_faces` 0.75 s; `delete_cage_faces` 0.87 s; `check_subdivision` 2.5 s (0.9 s of it self-intersection of the 97 000-triangle level mesh, 0.56 s the level-mesh volume, 0.16 s topology; 5 400 vertices 0.14 s, 21 600 vertices 0.78 s, 48 600 vertices 2.5 s: linear with large constants, no quadratic loop). Nothing else was above 1 s except the creation.

## 13.7 As built (DES-7c step 2: M6 `fit_subdivision_to_mesh` and `fit_surface_to_mesh`, 2026-10-27)

Both commands are built (toolset `mesh`), pure TypeScript, no kernel and no native engine. VC-MSH-22 is complete: `quad_remesh` (13.6) then `fit_subdivision_to_mesh` brings the cage to a maximum deviation of 0.0078 mm (limit 0.05) on the l4 icosphere, and the exact B-spline solid of the fitted cage has the sphere volume to 0.10 %.

### 13.7.1 Stack decision (C7)

- **TypeScript, not a native sidecar.** The measured worst case (a 40 000-sample fit plus the verification mesh of 157 000 vertices) is 6 s, and a typical 600-face fit at level 2 is 1.3 to 1.7 s, so a native solver would buy nothing the user would see. The real argument is the other side: the fit needs the limit surface as a LINEAR operator of the cage (stencils), and the Catmull-Clark rules (semi-sharp creases with Uniform / Chaikin decay, the blend between parent and child rule, boundary corners) already exist once, in `refineOnce`. A Rust copy would have to repeat every rule bit for bit. Instead `refineOnce` became generic over its vertex algebra (`RefineOps<T>`: `add`, `scale`, `centroid`, `lerp`); the Vec3 path is unchanged (same functions, same bytes), and a sparse-stencil algebra (`geometry/subd/stencil.ts`) turns the same code into the subdivision matrix S^k row by row. The limit masks (Halstead for smooth vertices, (4v + a + b) / 6 on creases, v at corners; `geometry/subd/limitMasks.ts`) are applied to the stencils of the refined level, giving the CSR matrix A of `limit = A * cage` (`geometry/subd/fitOperator.ts`). If a larger sample cap is ever needed, the sparse solve is the part to move (Eigen is already vendored in `llull-quadflow`).
- **Solver:** Jacobi-preconditioned conjugate gradient on the normal equations, matrix-free (`lib/conjugateGradient.ts`), one run per coordinate, warm-started at the current cage; about 150 iterations for 3 x 600 unknowns per round at a 1e-8 relative residual (it was 1e-12 and about 340 iterations in the first version: the fitted cages and every number below are unchanged to the reported digits; `data.cgConverged` and `data.cgRelativeResidual` report the worst solve, and a solve that stops at its cap warns `MESH_FIT_SOLVER_RESIDUAL`). `interpolate` solves a square system (below) with CG on its normal equations to 1e-13.
- **Closest points:** the existing `SurfaceIndex` (median-split AABB tree).
- **`fit_surface_to_mesh`:** own least-squares tensor B-spline (`geometry/mesh/surfaceLsq.ts`) on the existing `lib/nurbs` basis, foot-point correction by `refineOnSurface`. OCCT `GeomAPI_PointsToBSplineSurface` was not used: it fits a point GRID, has no fairing, and would need a new sidecar op plus the parameterisation anyway.

### 13.7.2 `fit_subdivision_to_mesh`: what was built and where it differs from the spec

| Spec text | Built |
| --- | --- |
| min ‖S C − P‖² + α‖L C‖² with L the cage umbrella, α = 1e-3 | TWO-SIDED rows: forward (limit samples to their closest target points) and backward (target vertices, at most 20 000, to their closest points on the limit mesh, as barycentric combinations of three operator rows); each half has total weight 1. The fairing acts on the DISPLACEMENT from the input cage, α/N · ‖L (C − C0)‖² (N cage vertices), because the absolute form pulls a sphere cage inward and discards the cage the user gave; `smoothing` (default 1e-3) is α |
| CG until max deviation <= maxDeviation or `iterations` | rounds of (measure, solve) with fresh closest points; stops when the largest distance in either direction is <= `maxDeviation`, at `iterations` (default 10, max 30), or when a round gains under 1 % of the best; the best cage seen is returned, so a fit never worsens its input on the fit samples |
| `levels?` | the sampling level k >= 1 (default the cage's, else 2): limit points at the vertices of the level-k refinement; raised to the settle level of the cage when it has semi-sharp edges or corners (`fullSettleLevels`: ceil of the largest finite sharpness, NOT capped at 3 as `settleLevels` is for the budgeted exact paths: above 3 a residual sharpness would be treated as an infinite crease although `refineOnce` makes the edge smooth later; round 3), because the crease mask is exact only on edges that are infinitely sharp at that level (review round 1: a cube with sharpness 2.5 on four edges was fitted to a surface 0.094 off at level 1 or 2; the oracle test now compares the operator rows with `cageVertexLimits` and with a deeper level for uniform and Chaikin edges, sharp vertices and both boundary modes at levels 1..3); lowered (reported as `data.fitLevel`) until `faces x 4^k` <= 120 000 samples but never below the settle level, and `MESH_FIT_TOO_LARGE` names the semi-sharp edges when the settle level alone exceeds the cap; the verification mesh is one level finer than the fit level; given explicitly `levels` also sets the display `levels` of the solid |
| `interpolate?` | EXACT pins: the limit point of every cage vertex (the first N rows of the operator) equals the true nearest target vertex of its initial limit point (`geometry/mesh/vertexGrid.ts`, an exact hash-grid search: the first version took a corner of the closest triangle, which is not the nearest vertex). The N constraints in the N unknown cage vertices are a square, well-conditioned system (the limit masks), so the pins determine the cage and a fairing term has nothing left to decide; `smoothing` and `iterations` do not apply, there is one solve (`stop: "pinned"`), and `data.pinResidual` is the round-off miss (measured under 1e-9, asserted). Two cage vertices share a target vertex when the cage is denser than the target: `data.sharedPins` counts the cage vertices that got a vertex an earlier one already has, and warning `MESH_FIT_PIN_SHARED` ("use the least-squares fit (interpolate off) or a coarser cage") fires on open and closed targets (round 2: cages of 98 and 218 vertices pinned to 42 and 162 target vertices collapsed to a deviation of 0.89 and 0.28 without a word) |
| rewrite the cage vertices | in place (same id, topology, `elementIds`, creases, semi-sharp edges and `boundary` untouched); the target is kept; `affected` is the cage id, so the plan `as: subd` binds the cage |
| `MESH_FIT_NOT_CONVERGED` (warning, result applied) | `data.warnings[0].code`; the summary says `NOT converged`; also `data.converged`, `data.stalled` |
| creases | the stencils use the cage creases and sharpness, so a crease vertex follows the sharp edge of the target (box test: 48 creases kept, limit volume 1000 within 0.5 %, corners within 0.03 mm) |

`data`: `maxDeviation`, `mean`, `rms`, `forwardMax`, `backwardMax`, `worst` (point), measured with `symmetricDeviation` on the limit mesh of the RETURNED cage at level fitLevel + 1 (so points that were not fit samples are included) at the vertices, the EDGE MIDPOINTS (new, option `edgeMidpoints`) and the triangle centres of both meshes, each against the other surface: a lower bound of the Hausdorff distance, tight for a fine mesh (the description says so); `stop` (`met`, `met_on_samples`, `stalled`, `rounds`, `budget`, `pinned`) with the summary and the warning built from it (`met_on_samples`: within `maxDeviation` on the fit samples but not on the finer verification mesh, reported as not converged); `foldedTriangles` / `foldedChecked` and warning `MESH_FIT_FOLDED` (below); `initial` = the same quantities on the input cage at the fit level; `rounds`, `cgIterations`, `samples`, `fitLevel`, `verifyLevel`, `requestedMaxDeviation`, `targetTriangles`, and the cage `vertices` in world coordinates with ids (as the other cage commands).

Refusals (all `MESH_*` / `DIR_*`, document unchanged): `MESH_ENTITY_NOT_FOUND`, `MESH_NOT_A_MESH`, `DIR_ENTITY_NOT_FOUND` (cage), `MESH_PARAM_INVALID` (target = cage, `levels` above 4), `MESH_FIT_SYMMETRY` (a mirror-symmetric cage would lose its mirror), `MESH_FIT_CAGE_INVALID` (`cageProblem`, non-finite vertex), `MESH_FIT_TOO_LARGE` (cage over 50 000 vertices or 10^6 refined quads, over 120 000 samples at level 1, target over 500 000 triangles), `MESH_FIT_CAGE_FAR` (size / place rule, or the work cap below), `MESH_FIT_FAILED` (non-finite solution or target, nothing to measure). Warnings in `data.warnings`: `MESH_FIT_NOT_CONVERGED`, `MESH_FIT_FOLDED`, `MESH_FIT_SOLVER_RESIDUAL`, `MESH_FIT_PIN_RESIDUAL`. The numbers are in the remediation texts.

**Hostile-input finding.** A cage collapsed to a point (scale 0) hung the process: all limit samples coincide, every box of the closest-point tree is equally far from a query, nothing prunes, and each of 10 000 queries visits every triangle (scale 1e-12 took 33 s, scale 0 over 50 s). The fix is a rule before any work: box diagonals of cage and target within a factor 10 and box centres within one target diagonal, else `MESH_FIT_CAGE_FAR` ("move and scale the cage onto the target first, or make it with `quad_remesh`"). Tested at scales 0, 1e-12, 1e150 and a 500 mm shift. **Work cap (review round 1).** A cage that passes the size rule but sits badly (a cage 9 times smaller than the target, centred in it: 3 215 triangle tests per query on a 20 480-triangle target against 12 for a cage on the surface) still made every query scan a sixth of the tree: 46 s against 6 s at 327 000 triangles. `SurfaceIndex` now counts its triangle tests (`tests`; the strict `>` pruning and the lower-index tie rule are unchanged), and a measurement round may spend `WORK_PER_QUERY` = 600 tests per query (about 50 times the healthy average) on average. One counter covers both halves of a round (the forward queries on the target and the backward ones on the limit mesh; round 2 found the backward half compared with the whole budget, so a round could spend twice as much, and the refusal message put the backward distances into the rms of the forward rows). Over the cap in the FIRST measurement the command refuses `MESH_FIT_CAGE_FAR` with the number of samples answered and their rms distance ("quad_remesh the target, or place the cage on it"; the 9x-small cage is refused after 2 484 of 3 458 samples in 1.8 s); over it in a LATER round the fit stops with `stop: "budget"`, keeps the best cage and warns. Tested with the 9x cage (the message rms is that of the answered forward rows only: 8.8 for a cage 8.8 inside a sphere), for the later round with a stubbed `SurfaceIndex.closest` (isolated suite), and with a stub that makes each half cost 60 % of the budget (neither over it alone, 120 % together: `budget`, which the per-half comparison would not have caught).

**Folded cages (review round 1).** With a closed target (oriented outward) the verification counts limit triangles, on a stride of at most 50 000, whose normal makes more than about 100 degrees with the normal of the target triangle at their closest point: `MESH_FIT_FOLDED` in `data.warnings` (and a clause in the summary) with `foldedTriangles` of `foldedChecked`; the fit is still applied. An inside-out cage warns on 90 % or more of the triangles (test); the good fits above count 0. An open target is not checked (`foldedChecked` 0).

**Dart vertices (round 2).** A dart is an interior vertex with exactly one infinite crease edge. Its vertex rule is the smooth one but its sharp edge gives a plain midpoint edge point, so the Halstead mask is not its limit. Measured on a lumpy cube cage (size 4) with one crease edge: the smooth mask applied at level L is off from the level-7 vertex by 3.6e-2, 1.5e-2, 6.5e-3, 2.8e-3, 1.1e-3, 3.5e-4 for L = 1..6 (it does not give one limit surface), against a level independence of 1e-12 for the exact mask. The exact mask comes from the structure of the refinement: the vertex v, its n edge points E_i and its n face points F_j (2n + 1 values) are closed under one step (v' = (mean c_j + mean (v + E_i) + (n - 3) v) / n with c_j the centre of face j, E'_i = (v + E_i + c_i + c_{i+1}) / 4 or (v + E_i) / 2 on the sharp edge, F'_j = c_j), and at level 0 the same state is (v, e_i, d_j) in the order of `fanOf`; the limit is the left eigenvector of that matrix for eigenvalue 1 (power iteration of the row of v to 1e-16, memoised by valence and sharp index: `subd/dartMask.ts`), applied to the cage. Without a sharp edge it reproduces Halstead exactly (test). It is used in `limitMasks` (so in the operator and in `limitSurfaceMesh`) and in `cageVertexLimits`, so both are exact. Evidence: a dart case in the operator oracle test (rows equal to `cageVertexLimits` at 1e-12 and to level 4 at 1e-9 for levels 1..3); against brute-force refinement of fans of n = 3, 4, 5 quads with `subdivide` up to level 8, the error of the vertex falls by a constant factor below 0.6 per level to 1.2e-5 .. 5e-4 at level 8, and Aitken extrapolation of levels 6..8 agrees with the mask to 2.4e-6 .. 6.6e-5 (the smooth mask is 10 times or more further off). A 1e-9 comparison with brute-force refinement is not possible (4^k faces: level 8 of a 4-quad fan is 262 000 quads and the error decays by about 0.4 per level); the 1e-9 statement is the level independence and the agreement with `cageVertexLimits`. The normal of `cageVertexLimits` at a dart still uses the smooth tangent masks (not used by the fit).

### 13.7.3 Measured (win32-x64, one machine; native `quad_remesh` makes each cage; exact masses from the native OCC kernel, `surfaceModel limit_patches`)

| Case | Cage quads | Rounds (CG iterations) | Max deviation before / after | Mean / rms after | Exact volume vs analytic before / after | Exact area vs analytic before / after | Fit time |
| --- | --- | --- | --- | --- | --- | --- | --- |
| VC-MSH-22: icosphere l4 R 10, 600 quads, levels 3 (39 298 samples), maxDeviation 0.05 | 614 | 1 (149) | 0.0951 / 0.00783 | 0.00387 / 0.00422 | -2.17 % / -0.10 % | -1.45 % / -0.067 % | 6.3 s |
| sphere diameter 1 mm (R 0.5), maxDeviation 0.0025, levels 2 | 623 | 1 (154) | 0.00482 / 0.000448 | 0.000212 / 0.000230 | -2.18 % / -0.075 % | -1.45 % / -0.050 % | 2.2 s |
| diameter 10 mm | 614 | 1 (153) | 0.0492 / 0.00451 | 0.00213 / 0.00231 | -2.17 % / -0.075 % | -1.45 % / -0.050 % | 2.1 s |
| diameter 100 mm | 613 | 1 (155) | 0.505 / 0.0453 | 0.0213 / 0.0231 | -2.19 % / -0.075 % | -1.46 % / -0.050 % | 2.0 s |
| diameter 1000 mm | 608 | 1 (155) | 4.52 / 0.440 | 0.213 / 0.231 | -2.18 % / -0.075 % | -1.46 % / -0.050 % | 2.0 s |
| box 10 mm, 300 quads, 84 creases, levels 2 | 294 | 0 | 0.0183 / 0.0183 (already within 0.05) | 0.00059 / 0.00135 | -0.016 % / -0.016 % | -0.038 % / -0.038 % | 0.9 s |
| torus R 10 r 3 (96 x 48 target), 400 quads, levels 2 | 457 | 1 (181) | 0.324 / 0.0321 | 0.00398 / 0.00485 | -9.6 % / -0.040 % | -5.2 % / -0.024 % | 1.9 s |

All seven rows stop with `stop: "met"` (the box at round 0), the solver converged to 1e-8 (worst relative residual 1.0e-8), and no limit triangle is folded (0 of 29 000 to 45 000 checked). The times include the folded check and the edge-midpoint samples (0.3 to 0.6 s more than the first version). The relative deviation is the same at 1, 10, 100 and 1000 mm to three digits (the objective is scale-free; unit test: equal within 1e-3 relative). What is left after the fit is mostly the target itself: a chord of the l4 icosphere lies 0.012 inside the sphere (sagitta), so the fitted limit surface sits inside the exact sphere by about that much. Other runs (unit scale, TypeScript only): a sphere cage of 8 x 8 faces per cube side (384) to the l5 icosphere, level 2: 0.204 to 0.0067 in one round, 1.2 s; 12 x 12 (864) at level 2: 0.093 to 0.0039, 2.7 s; at level 3 (55 298 samples): 0.0025, 9.3 s including the level-4 verification (operator 1.1 s, verification mesh 3.2 s, symmetric deviation 3.1 s); a box cage shrunk to 0.9 with 0.4 mm of noise and 48 creases, to a box tessellated 8 x 8 per face: 1.05 to 0.035 in 4 rounds, 0.3 s; an open 6 x 6 cage (`edge_and_corner`) on a sculpted patch: 1.00 to 0.072, `NOT converged` for 0.02 and converged for 0.2.

**The sculpt plan (`target_sculpt_quad_brep`, runnable 9/9, about 25 s).** Its first version imported the 80-triangle l1 icosphere and remeshed it to 1.5 mm: the target was a polyhedron with 18-degree dihedral edges, which no smooth surface follows within 0.05 (10 rounds gave 0.101 in 17 s). The plan now imports the l5 binary STL (smooth to 0.005) and remeshes to 1 mm edges, and it gains a `fit_surface_to_mesh` step on the sculpted bump. Measured: step 3 `fit_surface_to_mesh` 24 x 24 poles, 0.00936, 3.4 s; step 6 `quad_remesh` 629 quads; step 7 fit 0.100 to 0.0201 in 1 round (6.1 s); step 8 exact limit-patch volume 4177.361 (-0.27 % of the sphere: the 1 mm chords lie inside it).

### 13.7.4 `fit_surface_to_mesh`: what was built

- **Region:** the whole mesh or a sphere `region` (the `remesh_mesh` schema; triangle centres inside it). The size cap applies to the REGION after the filter (`MESH_FIT_TOO_LARGE`, "pick a smaller region or decimate_mesh first", over 200 000 triangles; review round 1 had it on the whole mesh with the wrong code). Tested on an asset-backed 205 000-triangle grid: refused whole, fitted inside a radius-3 region. Parameterisation by orthogonal projection onto the area-weighted best-fit plane (exact surface second moments, so a rectangle gets exactly its own axes); a region with more than 2 % of its area folded back or vertical against that plane is refused (`MESH_FIT_NOT_PROJECTABLE`: a closed body, a wall; 55 % for the closed sphere in the test). **The spec harmonic map for strongly curved regions is not built.** The rule is bracketed by tests: a 60-degree cap of the R 10 sphere is fitted (folded fraction under 2 %), the hemisphere is refused (10.4 %).
- **Surface:** clamped uniform knots, one degree 1..5 (default 3) in both directions, `controlPoints` [nu, nv] (u along the long axis of the region) or chosen: with `maxDeviation` the long side grows through 6, 8, 12, 16, 24, 32, 40 poles until met; with neither, about sqrt(vertices) / 3, at most 16. At least 2 samples per pole (`MESH_FIT_TOO_FEW_SAMPLES`).
- **Fit:** area-weighted least squares (at most 15 000 vertices, strided) with a fairing on the second DIVIDED differences of the poles over their Greville abscissae, so that a plane costs nothing (plain second differences made the end poles drift 0.024 mm outside the data on a 30 mm plane); the (u, v) bounds come from ALL region vertices, not from the strided fit vertices (review round 1: with more than 15 000 region vertices an extreme vertex could be dropped by the stride and left outside the patch; tested with a 16 900-vertex grid and an extra vertex in either parity); up to 6 rounds of foot-point parameter correction (Newton, `refineOnSurface`), stopping at `maxDeviation` or when a round gains under 1 %. The normal (du x dv) faces the side the triangles face (u and v are swapped, with a flip, when the long axis is the second axis of the plane).
- **Deviation:** distance from region vertices, edge midpoints and triangle centres (up to 30 000) to the patch (a lower bound of the Hausdorff distance); the patch covers the bounding rectangle of the region in its plane, and parts beyond a non-rectangular region are NOT measured (stated in the description).
- **Measured:** spherical cap (R 10, region radius 5 about the pole, icosphere l5): 12 x 12 poles, 0.0071 (maxDeviation 0.01 grew 6, 8, 12 in 0.46 s); fixed 6 x 6: 0.0353; radius 8: 14 x 14, 0.0133, 6 rounds, 1 s; the patch interior lies on the sphere to 0.015 (the mesh chords are 0.005 inside); a plane: exact (poles on z = 0 to 1e-9, end poles on the bounding rectangle to 1e-6); the relative deviation of a 12 x 12 cap is equal at R 0.5 / 5 / 50 / 500 to 1e-3.
- Result: `nurbs_surface` `surf-<step>.<k>` in world coordinates; the mesh is kept.

### 13.7.5 Tests

`tests/unit/mesh/fitSubdivision.test.ts` (sphere with the analytic limit radius and volume, scale sweep, creased box, torus volume, moved and rotated cage, interpolation, non-convergence, open cage, hostile input, level lowering, refusals, purity, replay), `tests/unit/mesh/fitSurface.test.ts`, `server/tests/fitSubdivisionNative.test.ts` (native `quad_remesh` cages and native kernel masses: the table above as bounds, B-spline faces = 4 x quads, replay), `tests/unit/mesh/fitSubdivisionGuards.test.ts` (stop reasons, exact interpolation, semi-sharp sampling level and its cap refusal, folded cage, open target, the 9x-small cage, edge midpoints), `tests/unit/mesh/fitSubdivisionBudget.test.ts` (later-round work cap, isolated), `tests/unit/mesh/fitOperator.test.ts` (operator rows against `cageVertexLimits` and a deeper level for seven cages at levels 1..3; the nearest-vertex grid against brute force), `tests/unit/lib/conjugateGradient.test.ts`, lifecycle design `seed/fit_to_mesh` (replay, undo, delete, clear), the tool-schema snapshot, `blockedPlanCommands.json` (the sculpt plan is no longer blocked), `FEATURES.md`.

### 13.7.6 Left

- Harmonic-map parameterisation and a `faceGroups` region for `fit_surface_to_mesh`; a patch trimmed to the region.
- `fit_subdivision_to_mesh` on cages over 30 000 faces (the 120 000-sample cap lowers the fit level instead; a native sparse solve would lift it).
- A fit warns of folded limit triangles (13.7.2) but does not look for self-intersection of the cage (`check_subdivision` does).
- A semi-sharp cage whose settle level (ceil of its largest sharpness, up to 10) times the face count exceeds 120 000 samples is refused by name, with the sharpness and the remediation "lower the sharpness or use a cage with fewer faces". The other exact paths still cap the settling at 3 (`settleLevels`): limit patches / B-spline export (`subdivisionPatches`, `toNurbs`), `cageVertexLimits` and the surface evaluator (`evaluate_subdivision`), and code export (`featureProgram`) treat the sharpness left after 3 levels as infinite, so for a sharpness above 3 they differ from the level mesh; not changed here (reported to the coordinator).
- `shrinkwrap_mesh`, `displace_mesh` (the rest of DES-7c).

## 13.8 As built (DES-7c step 3: async native mesh jobs and `--progress`, 2026-10-27)

### 13.8.1 The problem and the decision

The native mesh engine ran `llull-compute meshops` through `runComputeSync` behind the synchronous `MeshProcessingEngine.run`: the backend event loop stopped for the whole job (a `quad_remesh` of 40 000 quads: 110 s of QuadriFlow, no HTTP, no SSE, no live sync). Options weighed:

| Option | Verdict |
| ------ | ------- |
| Async `execute` (every command `run` returns a promise) | Rejected: it rewrites the contract of every command, replay, plans and every plugin for the sake of four ops (L1, L3, the `CommandResult` contract). |
| Run the whole command in a worker thread and block it with `Atomics.wait` (as the OCC kernel does) | Rejected: the document, plugin registry, mesh asset store and kernel sidecar live in the main thread; no streaming progress from a blocked call; the document would be copied both ways. |
| Commands that declare an async prepare phase | Rejected: a second, hand-written two-phase form for each command that can reach a native op (`fit_*` chain several), and the prepare would have to predict the op the command is about to make. |
| **Deferred answer, then run again** (built) | A command stays a pure synchronous function of (document, params, result table). The native engine answers from a result table, or asks the host for the job and answers a named refusal (`deferMeshOp`, code `MESH_ENGINE_PENDING`); the host discards that run, awaits the job on the event loop and runs the command again, which now finds the result. No architecture law changes. |

The mechanism (server side; core gained `deferMeshOp` / `deferralCount` in `geometry/mesh/engine.ts` and one rule in replay):

- `server/src/native/deferredRun.ts`: `resolveDeferred(attempt, { onProgress, signal, commit })` runs `attempt` (one synchronous run of the command) in a scope; the jobs a run requested are awaited concurrently, then `attempt` runs again, until a run requests nothing. That run is the only one committed (`commit` runs synchronously in the same tick as the run, so no other command can change the document between the run and its commit), audited and returned. A run that requested a job is discarded whatever it returned (a command may have swallowed the refusal into a success, as `deviationSkipped` does).
- Jobs have a content key (sha256 of `job.json` and the mesh bytes). One job per key runs at a time and concurrent commands share it; its result is kept in a byte-bounded LRU (`LLULL_MESH_CACHE_MB`, default 512), so `replay_history`, undo, a retry and a plan that runs again find it. A failed job (`MESH_TIMEOUT`, crash, cancel) is remembered only for the resolve that saw it, so the next run reports its code instead of asking again.
- Each run of the command asks for at most one job: the first native op it cannot answer. Later misses of the same run work on a placeholder input, so they defer without asking (and replay memoizes none of their states). The resolve loops while each run asks for a key it does not hold yet, and stops at 256 jobs (`MESH_JOB_LIMIT`, remediation: split the plan or decimate first). A run that defers without asking, or asks again for a result it holds, is an engine bug and is refused by name (`MESH_DEFER_PROTOCOL`). `quad_remesh` on a mesh over the TypeScript cap was three runs when this step was built (the quad job, the deviation job, the final run); it is two since 13.9 (the deviation comes with the quad job); a plan of 19 native steps is 20 runs and 19 jobs (test).
- Cost of running again: a plan re-runs from its first step in each round, so k native steps cost about (k + 1) / 2 times the plan. Measured with a 2 ms fake job: a 10-step `build_project` (7 `add_box`, 3 `quad_remesh` at steps 3, 6 and 9) is 4 runs, 31 step executions instead of 10 (counted again in 13.9.4; 13 since 13.9), and 9 engine calls instead of 3; 44 to 72 ms cold against 4 to 9 ms with the results kept. History is cheaper: `replay_history` of the same 10 steps with the results cleared takes 9 engine calls (12 without the replay prefix cache: each round reuses the states before the first deferral), and the next replay takes 0 (the whole history is cached). On a 328k-triangle mesh one run of the command is 1 to 6 s, so a plan with many native steps on big meshes pays that per round; this was cut in 13.9 (steps executed once, the deviation in the job).
- Replay (L8): a step that saw a deferred answer is not memoized in the replay prefix cache, and every later state is keyed apart (`replay.ts`, `deferralCount`); otherwise the placeholder state of the first run would be served after the job finished. Test: `tests/unit/mesh/deferredEngine.test.ts` (fails without the rule).
- Live sync (`@protocol/liveSync`): a command takes effect when it finishes, against the document as it is then (a command that arrives meanwhile commits first; the job's command re-reads the document, and a job whose input changed is simply a new job). The log and `stateHash` see one ordinary `command` event. The renderer still re-runs the command without the native engine and resyncs from `/live/snapshot` (sync.md, unchanged).
- Undo: the finished command is one history entry, like any other.
- The synchronous `runComputeSync` path of `meshops` is gone. A finished result answers without a scope (a hit needs no job); a miss outside `resolveDeferred` is refused with `MESH_ENGINE_NEEDS_HOST`. `POST /command` and `POST /preview` (async, aborted when the client closes the connection) resolve jobs. These host paths stay synchronous: the bus `applyCommand` of the export routes (`export_stl`, `export_code`), the DWG import route (`import_dxf`, `import_survey_dxf`), the exchange and native-tool follow-ups (`import_mesh`, `apply_code_trace`, `record_fe_mesh`, `record_fea_results`, `record_cfd_results`, `record_topology_result`, `record_explicit_results`, `set_temperature_field`, `compute_fatigue`, `route_problem`, `route_lines_order`, `auto_route_pipe`, `auto_route_lines`), the PLM routes and vault (`release_manifest`, `plm_act_payload`, `export_sheet_svg`, `checkpoint_iteration`, `externalize_snapshots`, `load_document`), and the CLI benchmark and fuzz runners. None of those commands calls the mesh engine (the commands that do are the mesh, boolean and surface commands listed by `resolveMeshEngine` in `packages/core`); if one ever did, the answer is a named refusal, never a stall (tests: `meshJobsRefusals`, `meshJobsNative`). The other synchronous ports (`ctx.raster`, `ctx.pointCloud`, the field and geometry-query engines) are unchanged.
- A resolve that ends without a standing run commits NOTHING: it returns a refusal on the unchanged document (`changed: false`, `error.code`), audited, with no live event, no undo entry, no `commandId` result, no file save. That covers a cancel (signal aborted, or a job ended `MESH_CANCELLED`: `MESH_CANCELLED`, or the abort reason's code, e.g. `MESH_TIMEOUT` for `--timeout`), the job limit and the protocol bug. This matters for commands that report success after a failed step (a history edit upstream of a native step, `build_project` with `onError: "continue"`): the run after an abort would have been committed. Tests: abort during `edit_step_params` over a `quad_remesh` step and during a `continue` plan, over the bus and the CLI.

### 13.8.2 Transport and cancellation

- `POST /command` answers JSON as before. With `Accept: application/x-ndjson` it streams `{"type":"progress", op, stage, message, step, total, fraction, elapsedMs, etaMs, heartbeat}` lines, then one `{"type":"result","result":<body>}`. A silent job (QuadriFlow's max-flow stage takes over a minute) repeats its last report every `LLULL_MESH_HEARTBEAT_MS` (5 s) with the clock advanced, which also keeps an idle timeout of a client from firing. `etaMs` is `elapsed * (1 - fraction) / fraction` once 5 % is done.
- The job side is the existing NDJSON `progress` event of `llull-compute` (`llull-protocol`), now emitted by `meshops`: `read`, the op's stages, `write`, with `stage`, `fraction`, `elapsedMs`. `decimate` ticks every 250 ms during the collapse loop (share of the triangle target reached); `smooth` ticks per iteration; `quad_remesh` reports the ten QuadriFlow stages (`prepare`, `orientation_field`, `scale`, `position_field`, `integer_constraints`, `max_flow`, `fix_flips`, `final_positions`, `extract_quads`, `fix_valence`; a `stage_hook` in the vendored `Parametrizer::ComputeIndexMap`, vendor README change 9) with their wall-clock shares. The shares were measured on a 327 680-triangle sphere asked for 40 000 quads (110 s): `max_flow` 61 %, the tail after `fix_valence` 19 %, `position_field` 9 %. The result does not depend on the reporting (test `stages_come_in_order_with_rising_fractions_and_do_not_change_the_result`).
- `remesh` and `analyze` have native twins since 13.12; `cut`, `fill`, `repair` and `sculpt` do not yet. They will report through the same `Progress` type of `llull-meshops` and the same host path when they land.
- CLI: `--progress` prints `[quad_remesh] max flow 15% (stage 7/12), 16.5s elapsed, ~1m33s left` lines on stderr (local `--doc`, `--app`, `--server`); stdout stays one JSON object. With `--server`, no report for 120 s (or `--timeout` for the whole request) abandons the request.
- Cancellation (built, because the design makes it natural): the request's `AbortSignal` (an HTTP connection closed before the answer, or Ctrl-C in the CLI) reaches `runProcess`, which kills the process tree of `llull-compute` by PID; the command answers `MESH_CANCELLED` and nothing is applied. A job shared with another waiter keeps running until its last waiter leaves. Requests that join a running `commandId` each keep their own signal; the shared resolve is aborted when all of them have aborted. `llull-compute` is started in its own process group (detached, no console, still no window) so a console Ctrl-C reaches only the CLI, which then kills the tree; a job that dies in the instant of the abort is still reported as the cancellation.
- - Lifecycle rule: a native job never outlives its host. The detach that removes the Ctrl-C race also takes the child out of the host's kill-on-close job on Windows, so a hard kill of the backend (the desktop app's `child.kill()`, `process.exit` in the fatal-error handler, any crash) would leave `llull-compute` running for up to its 600 s timeout. Three layers: (a) primary, robust against every kind of death: the host starts each async `llull-compute` job with `LLULL_EXIT_ON_STDIN_EOF=1` and a stdin pipe it never writes to or closes; `llull-compute` reads that pipe on its own thread and exits (code 4) at end of input, which the OS delivers when the host dies however it died. Stdin was free (no job reads it); the variable is opt-in because other callers run the binary with a null stdin, which is at end of input from the start. Tests: `solver/bins/llull-compute/tests/host_death.rs` (closing the pipe stops a running job within 2 s; an open pipe or no variable leaves it alone) and `server/tests/hostDeath.test.ts` (a host process killed with SIGKILL while its job runs: the `llull-compute` pid is gone within 3 s; it fails without the variable). (b) The desktop `stop()` kills the server's whole tree (`killPidTree`: `taskkill /T /F /PID` on Windows, the process group elsewhere, SIGTERM when the server leads no group, where its shutdown handler runs `killAllChildren`); `onFatalError` and a `process.on('exit')` hook of the CLI call `killAllChildren` too. Test: `desktop/tests/backendStop.e2e.test.ts` (the real server bundle, a running `quad_remesh`, `stop()`: the job pid is gone). (c) The synchronous ports (`runComputeSync`) are not covered by (a): their host blocks while they run and the helper node process, not detached, dies with it.
- `--timeout` on a local run: the supervisor hands the child one absolute deadline (`LLULL_CLI_DEADLINE_MS`, epoch milliseconds from the supervisor's own start, so a slow boot cannot let the kill come before the clean refusal) and the child aborts its signal at that instant with reason `MESH_TIMEOUT`, which stops a job it awaits (refusal, nothing saved). A blocking synchronous step is stopped by the supervisor, which now kills the child's whole process tree (`killProcessTree`: `taskkill /T` by PID on Windows) instead of orphaning `llull-compute`. Ctrl-C is armed only while a job is awaited (`onWaitStart` / `onWaitEnd` of `resolveDeferred`): during a synchronous run the OS default ends the process. `--server`: the cancel message says the server was asked to stop and that nothing is applied if it had not committed yet (`llull exec describe_scene --app`, `GET /live/snapshot`).

### 13.8.3 Measured (win32-x64, release build, one machine)

`quad_remesh` of a 327 680-triangle sphere to 40 000 quads (38 577 delivered), `POST /command` with NDJSON, while a second client polled `/health` every 50 ms and `/live/snapshot` every 500 ms:

| | Before (synchronous job) | After |
| - | ------------------------ | ----- |
| Backend unreachable during the job | the whole job, about 110 s | none |
| `/health` p50 | no answer | 2.5 ms |
| Longest stall | about 110 s | 5.7 s (the command's own synchronous work, below) |
| Wall time of the command | about 120 s (estimate: the 110 s job plus one run of the command) | 144 s |
| Progress lines | none | 35 (18 heartbeats), 16 stages |

What still blocks is the command's own TypeScript work around the job, not the job. On this mesh a run of `quad_remesh` costs 1.2 s before the quad job, 5.7 s after it (cage checks, then the deviation job request) and 5.5 s in the final run, because the command runs again from the start each time. A stall longer than the 5 s keep-alive timeout of Node also drops idle keep-alive connections (the client sees `ECONNRESET`).

### 13.8.4 Tests

`tests/unit/mesh/deferredEngine.test.ts` (refusal, composite, replay); `server/tests/deferredRun.test.ts` (rounds, sharing, kept results, failures, cancellation commits nothing, job limit, protocol bug, wait hooks, heartbeats, ETA); `server/tests/meshJobsRefusals.test.ts` (cancel during a history edit and a `continue` plan, 19-step plan, one job per replay round, joined `commandId` signals, `/preview`, the synchronous bus); `server/tests/supervisor.test.ts` (tree kill, absolute deadline); `server/tests/hostDeath.test.ts`, `desktop/tests/backendStop.e2e.test.ts` and `host_death.rs` (lifecycle rule); `server/tests/meshJobsAsync.test.ts` (a fake engine on the real host: another request and another command served while a job runs, commit-time ordering, NDJSON order and result, heartbeat, connection close kills the job, `commandId` joins a running command, named failure codes, undo, replay); `server/tests/cliMeshJobs.test.ts` and `cliProgress.test.ts` (`--progress` output order on stderr and clean stdout for `--doc`, `--server` and plain-JSON servers, Ctrl-C); `server/tests/meshJobsNative.test.ts` (the real binary: `/health` under 250 ms during a 2 s job, the stage names in order, `MESH_TIMEOUT`, a crash is `MESH_QUAD_REMESH_FAILED` with `NATIVE_PROTOCOL`, process killed on disconnect, the kept result); `llull-meshops` and `llull-quadflow` cargo tests (event order, fractions, no effect on the result).

### 13.8.5 Left

- Done in 13.9: the steps of a plan executed inside one resolve are memoized, the command's own load / validation / packing is kept for its next run, and the deviation of a result is measured by the same native job. What is still synchronous in the final run is the work that has to happen once after the job (the checks of the result: 1.5 s on the 40 000-quad case).
- The UI shows no progress yet: `/live` SSE does not carry job reports (a `progress` event keyed by `commandId` would). Viewport/shell lane.
- Done in 13.10: `decimate_mesh` of 1.3M triangles takes 4.8 s of native time (was 16.6 s).
- Native `remesh` and `analyze` are done (13.12); `cut`, `fill_holes`, `repair`, `sculpt` (the rest of DES-7c) report through `Progress` when they exist.
- The raster, point-cloud, field and geometry-query ports still block on `runComputeSync`.

## 13.9 As built (DES-7c step 4: less repeated work per resolve, 2026-10-27)

### 13.9.1 The problem (13.8.3, 13.8.5)

The host runs a command again after each native job and commits the last run. Three costs came from that, all measured before this step:

1. every run repeated the command's own TypeScript work on the mesh (load, weld, measure, orient, the editable-mesh check, packing the job files, hashing the job key);
2. the deviation of a `quad_remesh` result was a second job, so a command needed a second round;
3. `build_project` ran again from step 1 after each native step: k native steps cost about (k + 1) / 2 times the plan, and an OCCT boolean in the prefix ran every time.

### 13.9.2 Decision

**A resolve-scoped memo, handed through the execution context** (`ExecutionContext.resolveMemo`, `commands/resolveMemo.ts`; no architecture law changes). `resolveDeferred` makes one per resolve (`DeferredScope.memo`), calls `beginRun()` before each run and `dispose()` when the resolve ends however it ends; `serverContext()` puts it in the context of the commands that run inside the scope (null outside). `once(owner, tag, compute, weight?)` keeps a value under (identity of `owner`, `tag`).

- **Plan steps (`build_project`, every `onError` mode, loops, nested plans).** `execStep` runs `executeRecorded` through `memo.once(run.current, "step|<depth>|<command>|<params>|<recorded params>", ...)`. The key is the identity of the document the step starts from: a step that was served returns the very document object of the earlier run, so the next step finds its input by identity too, and the chain of steps before the first deferral is reused with no hashing of any document. The params go into the key through a JSON that tells `NaN` / `Infinity` from `null`. A step whose command is `build_project` is never served whole (it runs again so its inner steps report to `onStep` in every run; they are memoized one by one). Only plans that run as top-level recorded steps share (`ctx.stepKey` undefined): a plan replayed inside a running step mints ids from that step's id source, which a skipped step would not advance. A step that failed is shared like one that succeeded (the failure is a function of the same input).
- **The command's mesh preparation (`quad_remesh`, and every `runMeshOp` command: decimate, smooth, remesh, repair, fill holes, ...).** `prepareSolidMesh` (load, weld, measure, orient) is kept under the *entity object* and the weld / orientation options. The entity, not the document, because `replay_history` and `edit_step_params` hand each run a new document object (the replay cache spreads it) that still holds the same entity objects; in a plan the entity is the same too. The native engine keeps, under the *input `MeshData` object* (which is now the same object in every run), its editable-mesh check and the packed job files with their SHA-256 digests; the job key is a hash of the file names and digests, so the mesh bytes are hashed once.
- **The deviation in the same job.** Ops `decimate`, `smooth` and `quad_remesh` take `withDeviation: maxSamples` (`WithDeviation`, `engineTypes.ts`); `job.json` carries `deviationSamples`, `llull-meshops` measures the symmetric deviation of the result from the input after the op (stage `deviation`, before `write`) and writes it as `deviation` in `report.json`; the engine returns it in `MeshOpResult.deviation`. `runMeshOp` and `quad_remesh` use it and measure separately only when the engine gave none (the TypeScript engine, a stub, a native failure to measure). For `quad_remesh` the measured mesh is what the command commits (the quads wound outward per shell and split along the shorter diagonal), so the job carries Rust twins of `outwardQuads` and `triangulateQuads` (`quad_mesh.rs`, same operation order, `llull-jsmath` hypot): the deviation is the number the separate job on the committed triangles gives (tests below).

What is NOT memoized, by rule (`ResolveMemo`): anything computed in a run after an engine deferred an answer in it (`deferralCount()` moved since `beginRun`): from there on a run works on placeholders, and the step that deferred is the one that runs again. Entries are bounded by count (1024) and by weight (32 million numbers, about 250 MB). The weight is exactly this: for a kept plan step the length of its key plus the numbers (positions and indices) of the meshes of the entities it created or replaced; for a kept mesh preparation the positions and indices of the loaded mesh plus the second index array of the outward copy. A step result otherwise shares structure with the documents around it (spread entity tables), and its `data` is not weighed: those are bounded by the entry count only. Beyond a bound a value is computed but not kept, and the earliest entries stay, because the next run reads the prefix first (an LRU would evict exactly that prefix).

History (`replay_history`, `edit_step_params` and the other meta-commands) keeps its replay prefix cache, which already reused the states before the first deferral; what a native step repeated there was its own preparation, now kept by entity.

### 13.9.3 Rejected

| Option | Why not |
| ------ | ------- |
| Memoize at `execute` (document, command, params) | A nested `execute` inside a step shares that step's id source; skipping one would shift the ids of the next (L8). Only top-level recorded steps are independent. |
| Hash-keyed prefix cache like `replay.ts` for plans | It needs the hash of the starting document and of each step's result; the identity chain costs nothing and cannot collide. The replay cache stays for history, where documents are rebuilt and identity is lost. |
| Process-wide `WeakMap` for packed meshes | Lifetime follows the garbage collector, not the resolve; no budget; cannot be asserted. |
| An ambient module slot for the memo | Breaks "a command reads its dependencies only from its context" (`context.ts`). The context field costs one line in `serverContext`. |
| A second job for the deviation, asked in the same round | Its input (the committed triangles) is made from the first job's output; it cannot be asked before. |
| Make the native job write the committed (outward, triangulated) result | Changes the engine contract and the cage the TypeScript checks see; only the measurement needs the outward triangles. |
| Make `build_project` resumable (a generator) | Changes the `CommandResult` contract for one host feature. |

`fit_subdivision_to_mesh` and `fit_surface_to_mesh` never called the engine (pure TypeScript, 13.7): one pass, nothing to fix. `decimate_mesh` and `smooth_mesh` had the same two-round pattern on a mesh above the TypeScript cap (native op, then native deviation) and are fixed by the same change. `remesh_mesh`, `repair_mesh` and `fill_mesh_holes` run in TypeScript and only the deviation can be native: one job, one extra round, unchanged.

### 13.9.4 Measured (win32-x64, release build, one machine; `runHostCommandResolved` in process, no HTTP, event-loop stall sampled every 5 ms)

`quad_remesh` of the 327 680-triangle sphere (icosphere level 7, R 10) to 40 000 quads (38 577 delivered):

| | Before | After |
| - | ------ | ----- |
| Runs of the command | 3 | 2 |
| Native jobs | 2 (quad, then deviation) | 1 |
| Engine calls (quad / deviation) | 3 / 2 | 2 / 0 |
| Longest event-loop stall | 5.82 s | 1.53 s |
| Wall time | 126.4 s | 122.7 s |

The wall time is the 110 s QuadriFlow job; the saving is the repeated TypeScript work and the deviation job. What is left in the stall is the work that must happen once: the first run's preparation (about 1.2 s) and the final run's checks of the result (cage validity, on-source check, creases).

A 10-step `build_project` (7 `add_box`, 3 `quad_remesh` at steps 3, 6 and 9, fake 2 ms job, bus `applyCommandAsync`):

| | Before | After |
| - | ------ | ----- |
| Runs | 4 | 4 |
| `add_box` executions | 22 | 7 |
| `quad_remesh` executions | 9 | 6 |
| Step executions | 31 | 13 |
| Wall time (one cold sample) | 102 ms | 58 ms |

Executions are now 10 + the number of native steps for any plan (a native step runs once to ask for its job and once to use it); the unit test checks 1, 3 and 6 native steps in 10.

### 13.9.5 Tests

`tests/unit/resolveMemo.test.ts` (identity keys, throw, deferral rule, entry and weight bounds, dispose); `tests/unit/mesh/resolveMemoPlan.test.ts` (executions linear in the plan for 1, 3 and 6 native steps, the 10-step measurement plan, 24 seeded random plans in both error modes with refused and unknown steps: same document, ids, summary, report and jobs asked with and without the memo, a nested plan, another input document is a fresh execution, `edit_step_params` and `replay_history` over a native step: same document, and the engine gets the same prepared mesh object in every run); `tests/unit/mesh/withDeviation.test.ts` (the op asks with `withDeviation`, the engine's number is used and no separate deviation is asked, the fallback when the engine gave none, for `quad_remesh`, `decimate_mesh` and `smooth_mesh`); `server/tests/deferredRun.test.ts` (one memo per resolve shared by its runs, none from a deferred run, dropped after a normal end, a cancel, the job limit and a throw, `serverContext` hands it out only inside a resolve); `server/tests/meshJobsRefusals.test.ts` (bus: 7 + 6 executions for the measurement plan, memo empty afterwards; a cancel after the first job of a plan commits nothing and drops the memo); `server/tests/quadRemeshNative.test.ts` (real binary: two runs, one pending quad job, no deviation call, deviation equal to `measure_deviation` on the committed mesh); `server/tests/meshopsNative.test.ts` (decimate and smooth: the deviation in the answer equals the separate native job and the TypeScript engine, result bytes and report unchanged); `solver/crates/llull-meshops` cargo tests (decimate / smooth / quad deviation equal to the separate job, stages, absent without the request, the Rust twins of `outwardQuads` and `triangulateQuads`).

### 13.9.6 Left

- A plan replayed inside a running step (a recorded `build_project` re-expanded by `replay_history`) is not memoized; the replay prefix cache covers it up to the first deferral.
- The first run's preparation (1.2 s on 327k triangles) and the final run's result checks (1.5 s on 40 000 quads) are synchronous. Chunking them onto the event loop would remove the remaining stall; not needed for the keep-alive limit (5 s).
- The memo shares objects between runs: a command must not mutate the mesh it loads or the result of a step (commands are pure, L3).

## 13.10 As built (DES-7c step 5: native decimate speed, 2026-10-27)

### 13.10.1 The problem (13.5.3, 13.8.5)

`decimate_mesh` of 1,310,720 triangles to 100,000 took 16.6 s of native time against the 10 s budget. Measured again before the change on the same kind of input (icosphere level 8, radius 10, radial noise +-0.1, seed 42; `preserveBoundary`, `targetTriangles 100000`, `deviationSamples 20000`): decimate stage 21.1 s, in-job deviation 3.3 s, read and write about 0.1 s. Profile of the decimate stage: set-up 0.55 s (adjacency, quadrics, 2 M initial queue entries); the collapse loop 20.2 s, of which the queue was the bulk: 605,360 collapses pushed 24 M entries and popped 22.5 M (each collapse re-queued every edge at its 6 to 8 ring vertices and left the old entries to surface later as stale ones). The deviation stage took 3.3 s because building the closest-point tree over the 1.3 M input triangles sorted the whole range at every level (2.8 s); its 40,000 queries cost 0.3 s.

### 13.10.2 Decision

The output stays bit-identical to the previous native implementation, hence to the TypeScript engine (VC-MSH-32): the same candidate is collapsed at every step. Only the way the work is done changed.

1. **One queue entry per edge** (`edge_heap.rs`): an indexed 4-ary min-heap ordered by (cost, a, b), an open-addressing table from the packed edge to its slot, `upsert` / `remove` / `pop`, and a bulk O(n) build for the initial queue. A collapse updates the edges at the surviving vertex, removes the edges of the removed vertex, and puts back the edges that were refused earlier (`refused` lists per vertex, listed under both ends) when a collapse changes a neighbourhood: exactly the entries that the versioned stream left valid. The edges between other ring vertices keep their entry (their cost depends on their two vertices only). 22.5 M pops become 0.6 M, 24 M pushes become 4.3 M updates.
2. **No allocation per attempt** (`collapse_check.rs`, `edit.rs`): the link, fold-over and deviation tests use reusable buffers, merge the sorted rings instead of searching them, and read the boundary flag from the ring computation.
3. **The closest-point tree** (`surface.rs`) is built with a selection (`select_nth_unstable_by`, the same total order: centre along the axis with -0 = +0, then index) instead of a full sort per level, stores 64-byte nodes (one cache line), builds its halves with `rayon::join` and answers queries without a heap allocation. The tree is a function of the mesh alone (same split axis and halves as the TypeScript tree), so the distances are the same on any thread count. `deviation` builds the two trees in parallel and runs its queries with `par_iter` (each distance depends on its point only; the sums stay sequential).
4. **Parallel set-up** (`decimate.rs`): the boundary / feature edge scan and the initial costs run over chunks of 4096 vertices; the chunks are concatenated in vertex order, so the queue is the same on any thread count.
5. **The deviation guard** (`maxDeviation`): a probe is satisfied by the first triangle within the bound (the nearest triangle is farther than the bound exactly when none is within it), the probes are tested before the original-surface queries (the tests are independent, the order only decides how early a refusal is found), and the original-surface query stops as soon as a triangle within the bound is known (`SurfaceIndex::farther_than`; the answer cannot change after that).

Defined rules, the same in the TypeScript engine (`decimate.ts`) and the native one (review round 1 of this step changed the TypeScript side too):

- **`stoppedBy` is a function of the final state**: `"target"` iff `targetTriangles > 0` and the result has at most that many triangles (also when the mesh already was at the target, or when the last collapse left no valid edge); else `"deviation_or_validity"` when a `maxDeviation` run ended with an empty queue after at least one deviation refusal; else `"exhausted"`. The old TypeScript loop decided it from whether the queue still held entries when the target was met, which depends on stale entries; it said `"exhausted"` for a concave flat fan that reached its 4-triangle target with its last collapse. No golden or snapshot of the repository changed.
- **A NaN cost orders as +Infinity** (quadrics that overflow, from coordinates of about 3e153 and more): such edges are tried last and ties are settled by (a, b); the order is total, so it no longer depends on the shape of the heap. `maxCollapseCost` is `null` (type `number | null`) in both engines when a NaN-cost edge was collapsed, since JSON has no NaN; no adapter mapping is needed.
- **A normal or an area that is not a number refuses the collapse** as a fold-over (`dot <= 0`, `area <= floor` and their NaN cases): with overflowing coordinates the fold-over test used to pass on NaN. A NaN cost alone cannot produce a non-finite position (the optimal position is used only when it is within twice the edge length of the midpoint, which fails for a NaN), and no collapse is accepted when the normals overflow (coordinates of about 1e155 and more: nothing collapses).
- A candidate whose edge has no face any more is dropped without being counted (`Verdict::Gone`, as before).

### 13.10.3 Rejected

| Option | Why not |
| ------ | ------- |
| Keep the versioned stream and make it cheaper (smaller entries, arity 8, reserve) | The 24 M pushes and 22 M pops are the cost; arity 8 gained 3 %. |
| Lazy deletion by edge generation | Needs the same edge table and still pops one stale entry per update; no fewer sifts than an indexed remove. |
| Renumber vertices in space order for cache locality | The vertex ids decide ties (a, b), which vertex survives and the output order: the result would change. A storage permutation behind the logical ids would keep it and is the next step if the loop must go lower (it is memory bound: about 7 microseconds per collapse). |
| Half-edge structure replacing the per-vertex face lists | Rewrites the mesh core for the loop's remaining quarter (rings, collapse); the non-manifold input the Rust side must survive needs a list per edge anyway. |
| A different cost or tie rule for speed | Changes the output; quality (deviation, topology) was the constraint. |
| Parallel collapses | The order of collapses is the algorithm. |
| Approximate deviation (fewer samples, coarser tree) | The deviation must equal the `measure_deviation` definition; the exact tree is now cheap. |

### 13.10.4 Measured (win32-x64, release build, 22 cores, one machine; `llull-compute meshops` on a job folder, wall clock of the process; the same input and parameters before and after)

Icosphere l8 + noise, 1,310,720 triangles to 100,000, `deviationSamples 20000`:

| | Before | After |
| - | ------ | ----- |
| Decimate stage | 21.1 s | 4.6 s |
| Deviation stage (in job) | 3.3 s | 0.17 s |
| Read / write | 0.1 s | 0.1 s |
| Job wall time | 24.5 s | 4.8 s |
| Collapses / triangles | 605,360 / 100,000 | 605,360 / 100,000 |
| Rejected (link, fold-over, deviation) | 212, 1,014, 0 | 212, 1,014, 0 |
| Deviation forward max / backward max / mean | 0.15497453646136367 / 0.06085093714670365 / 0.020897252523607364 | the same, bit for bit |
| SHA-256 of positions, indices | feda4584..., 22b10e9b... (first 8 hex digits) | the same |

Icosphere l6 + noise, 81,920 to 5,000 triangles: job 776 ms before, 174 ms after (decimate 660 to 161 ms, deviation 116 to 13 ms); same bytes, same report (forward max 0.1515, backward max 0.1320, mean 0.03362).

With one thread (`RAYON_NUM_THREADS=1`) the 1.3 M job takes 5.6 s; 1, 3 and 22 threads give the same bytes. The same input with `maxDeviation 0.05` and no target (269,452 triangles, 945,831 deviation refusals): decimate 80.3 s before, 17.9 s after, same bytes and counts. That path is not under the 10 s budget; its remaining time is the probe checks (45 M probe tests over 1.5 M attempts) and the 520 k collapses; a witness triangle per probe would skip most of the tests and is left.

The earlier 16.6 s (13.5.3) was measured on another machine and a real STL; on this one the same code measured 21.1 s, so the factors above are the comparable figures.

### 13.10.5 Tests

Cargo (`llull-meshops`): `edge_heap` (order by cost then ids, move both ways, bulk equals one-by-one, 50,000 random operations against a sorted map with ties); `surface` (distance equals the minimum over all triangles for 0 to 9,000 triangles, the early exit equals the full search around the bound to the ulp, node counts); `collapse_check` (gone, non-manifold edge, tetrahedron, bridge between boundaries, fold-over, deviation guard); `edit` and `quadric` units; `tests/decimate.rs` (closed sphere stays a closed manifold without fold-over, locked boundaries keep every loop and vertex, free boundary keeps its loops and Euler characteristic, slivers, tetrahedron, non-manifold edge and random soups do not panic, four results pinned to the digest of the previous implementation, same bytes on every run and on 1, 2 and 7 threads); `tests/job.rs` (a whole job with its deviation gives the same files on 1 and 6 threads); `tests/perf.rs` (ignored timing gate of 10 s for the 1.3 M case: `cargo test --release -p llull-meshops --test perf -- --ignored --nocapture`). Differential runs against the previous binary (not committed): 108 meshes x parameter sets and 450 random triangle soups, bytes and reports equal. Server: `meshopsNative.test.ts` (native equals the TypeScript engine when everything collapses, when the target exhausts the candidates, on the concave fan, and on grids scaled to 3e153, 1e154 and 1e155 where costs are NaN); TypeScript: `tests/unit/mesh/meshEditLibrary.test.ts` (stoppedBy from the final state, NaN costs). The pins of `tests/decimate_pins.rs` are the old binary's results (flat grid, locked region and bound + target included; how to redo them is in the file). `meshopsNative.test.ts` is skipped, with a logged reason, when `llull-compute` is not built (`cargo build --release -p llull-compute` in `solver/`; `npm --prefix server test` finds it in `solver/target/release`): it is the parity oracle against the TypeScript engine and runs wherever that binary exists (the full server suite of a dev machine with the release build); `native:check` does not build it (a clean release build of the workspace is minutes long), so the cargo pins are what `native:check` keeps.

### 13.10.6 Left

- `maxDeviation`-only decimation of a million triangles (17.9 s): a witness triangle per probe.
- Fewer cache misses in the collapse loop (it is memory bound): a storage permutation behind the logical ids.

## 13.11 As built (DES-7c step 6: full-resolution reads through every indirection, 2026-10-27)

### 13.11.1 The problem (FR-MSH-02, 13.5)

A command annotated `readsMeshTriangles` runs on the stored mesh of an asset-backed entity (the document keeps only a display level of detail). `execute` chose those entities by looking for **entity ids written in the params**. Everything else read the display mesh and returned a wrong number without a word. Measured on the old resolver (display cube of edge 1, stored cube of edge 10): `mass_properties` of an **instance** gave volume 1 (the asset sits in the component definition, which was never looked at); a mutating reader whose params name no entity read nothing at full resolution; a read-only command naming only a non-mesh entity loaded **every** asset of the document and was refused if any unrelated asset was missing on this machine. Review round 1 found three more of the same class: the three drawing-view commands carried the annotation without reading triangles (so a document holding an asset this machine lacks could not replay), `export_stl` / `3mf` / `gltf` / `obj` of an instance wrote the display mesh, and about thirty commands computed from triangles or bounds without any annotation.

### 13.11.2 Decision

**1. One resolver in the choke point**, before the asset loader decides what to load: `commands/meshReach.ts` (`reachedMeshes(doc, params, wholeDocument)`), used by `runWithFullMeshes` (`commands/meshAssetView.ts`), which `execute` calls for every command with `annotations.readsMeshTriangles`. It is a pure function of the document and the params, so it is the same on every path that calls `execute` (UI local fallback, `POST /command`, `--doc`, `--server`, `--app`, `build_project`, `replay_history`, `edit_step_params`: nested and replayed executes pass the choke point with the context they were given). No architecture law changes, no per-command code, no change to recorded step params.

The annotation has two forms: `true` (the reach below) and `'document'` (every asset-backed mesh whatever the params name: `bill_of_materials`, the building drawing exports; `export_sheet_svg` is `true` with `wholeDocumentWhen`, 13.11.7). The reach of `true` is the closure of the references in the params (string values; object keys, for params keyed by entity id), always a **superset** of what a command reads:

1. a token that is an entity id: the entity; an asset-backed mesh is reached; an `instance` reaches its component; any other entity reaches what its own fields name (a dimension's `entityIds`; `id kind layerId materialId color name mesh` are not references);
2. a group id: its members; a layer id: the entities on it; a component id: the entities in its definition (nested instances recurse, cycles are cut);
3. a **real record** of the document: a table entry whose key equals its own `id` field, or an array item with an `id`, under any field except the core tables (joints, constraints, drawings and their sheets and views, every plugin slice: CFD cases, fastener stacks, ...). Its tokens are followed recursively. Only string values look up records (object keys only look up entities, groups, layers and components), and a nested key that is not a record id (`settings`, `dynamics`) is never one. Records are indexed once per slice object (a `WeakMap`, so an untouched slice is not walked again). Numeric arrays and typed arrays are never walked (a record holding a million samples costs a handful of reads; tested by counting element reads);
4. **default scope**: when no token resolves to any entity, group, layer, component or record, the command works on the selection or the whole document, so every asset-backed mesh is reached. The selection is a subset of that, which is why it needs no rule of its own.

Asset-backed meshes in component definitions are swapped and restored like the document's (`BackedMesh` has a `componentId`). The display mesh is put back wherever the result still carries the stored one. `Object.hasOwn` guards every table lookup (`constructor`, `__proto__` are not ids).

**2. Bounds come from the asset.** `geometry/bounds.ts` `localBounds` of a mesh with an `asset` is `asset.bounds` (exact, entity-local, written by the store at import). Every caller of `entityBoundsInDoc` is therefore exact with no read and no cap: `measure_bounding_box` (annotation removed), `place` / `align` / `snap`, `transform` pivots, `describe_scene`, `query_*`, `section_box_report`, `check_model`, `measure_distance` / `measure_angle`, `create_cfd_case`, the dimension bounds, the viewport framing. The annotation is for commands that read triangles.

**3. Annotation audit** (below, 13.11.4) and a contract test, `tests/unit/contract/meshReaders.test.ts`: it scans `packages/*/src` for the triangle readers (`entityToTriangles`, `entityTrianglePositions`, `solidTriangles`, `localTriangles`, `meshTriangles`, `collectExportParts`) and fails when a file is not in the audit list, or when a command the list names lacks the annotation. A new reader cannot land unaccounted.

**4. Exports of an instance** (`collectExportParts`, `withFullResolution`): an instance is expanded through `fullComponentsOf`, the reachable components with every asset-backed entity at its stored mesh read through the port; an unreadable one is listed in `unreadable` (`MESH_ASSET_MISSING` / `MESH_ASSET_UNAVAILABLE`) like the direct path. The cap does not apply (exports stream or build on demand).

**5. Drawing views** (`create_drawing_view`, `add_section_view`, `add_detail_view`) store ids and read no triangle: no annotation, so they succeed and replay on a machine without the asset. `export_sheet_svg` is the reader (whole document only when a view shows every solid).

**Too large**: the sum of the triangles of the reached assets (once per key, from the asset reference, before anything is read) above `MESH_FULL_READ_TRIANGLE_CAP` refuses with `MESH_ASSET_TOO_LARGE`, naming the biggest meshes and their counts, ids in `error.ids`, remediation "name fewer meshes, or decimate_mesh them first". The cap protects memory, not policy: **16,000,000 triangles** (about 600 MB of JavaScript arrays at 3 positions and 3 indices per triangle across vertices), because a document of several imports, each under `MAX_IMPORT_TRIANGLES` (2,000,000), must keep its ordinary whole-document reads; with bounds answered from the asset, `measure_bounding_box` of three 1.5M-triangle scans takes no read at all (test). An unreadable asset is `MESH_ASSET_LOD_ONLY` naming the entity (and the component). Never a silent fall back to the display mesh. A first value of 4,000,000 was refused in review: it would have turned reads that work today into refusals.

### 13.11.3 Indirection table (every way a command can reach a mesh; what it read before and now)

| Indirection | Example | Read before | Read now |
| ----------- | ------- | ----------- | -------- |
| Entity id in params | `mass_properties entityId` | stored | stored (an unrelated asset is no longer loaded or required) |
| Selection | a selection-driven reader | stored (read-only: all assets) | stored (default scope) |
| No param (whole document) | `export_urdf`, `check_cfd` without ids | stored for read-only commands; **display for mutating ones** | stored for both |
| Whole document by definition | `export_sheet_svg`, `bill_of_materials` | display or all by accident | stored (`'document'`) |
| Instance of a component | `mass_properties entityId=<instance>`, exports | **display** | stored |
| Component id, nested instance | a param naming a component | **display** | stored |
| Group | an id of `group_entities` in an id param | display unless a member was also named | stored (members) |
| Layer | a layer id | display | stored (entities on the layer) |
| Entity that refers to entities | dimension `entityIds` | display | stored |
| Map keyed by entity id | `{ perEntity: { "mesh-1.0": ... } }` | display | stored |
| Real record (joint, constraint, sheet, view, CFD case, study, fastener stack) | `prepare_cfd_case caseId` | stored only by accident (read-only: all) | stored (the case's bodies) |
| Bounds only | `measure_bounding_box`, place, align, scene, query | display | `asset.bounds` (exact, no read) |
| Plan reference | `build_project` step with `"$alias"` | stored if the alias resolved to the asset id | same: params are resolved before the nested `execute`, which passes the choke point |
| Replay / `edit_step_params` | recorded step | as the original run | same code path, same result (tested) |
| Live sync in the renderer | `applyLiveCommand` | no store: refused | unchanged: refused, `stateHash` mismatch, resync from the snapshot |
| Named selection | (not a document concept) | - | - |

### 13.11.4 Audit of the readers of triangles (the contract test holds this list)

| Reader (file) | Commands | Answer |
| ------------- | -------- | ------ |
| `deform/sourceMesh`, `deform/target` | `bend_body twist_body taper_body stretch_body scale_nonuniform deform_by_point flow_on_surface flow_along_curve deform_lattice deform_curve_to_curve morph_bodies` | annotated (already) |
| `exchange/exportUrdf` | `export_urdf` | annotated (already) |
| `exchange/meshToSolid` | `mesh_to_solid` | annotated (already) |
| `surface/surfaceShared` | `analyze_draft check_continuity measure_deviation` | annotated (already) |
| `geometry/resolveMassProperties` | `mass_properties`, `geometric_validation_properties`, `bill_of_materials` | `mass_properties` already; **gvp annotated; BOM `'document'`** |
| `geometry/technicalView` | `export_sheet_svg` | **annotated `'document'`**; the three view commands lose the annotation |
| `codegen/featureProgram`, `codegen/skinLowering` | `export_code` | **annotated** |
| `edit/decals` | `add_decal` | **annotated** |
| `scan/designPrimitives` | `cloud_to_model_deviation`, `check_asbuilt_clash` | annotated (already) |
| `aerodynamics/geometryArea` | `frontal_area compute_aero_drag road_load_power` | annotated (already) |
| `cfd/flowSurface` | `prepare_cfd_case check_cfd` | annotated (already) |
| `fasteners/stackMeasure` | `insert_fastener_stack insert_fastener_row check_fastener_layout select_fastener` | annotated (already) |
| `topology/job voxel regions rebuild` | `create_topology_study set_topology_regions suggest_rebuild compare_to_topology` | `create_topology_study` **annotated**, others already |
| `implicit/solidMesh` | `field_from_solid create_implicit_body edit_field regenerate_implicit_bodies check_implicit implicit_properties evaluate_field section_field lattice_properties create_scalar_field add_voronoi_lattice combine_fields infill_solid` | **annotated** (only `field_from_solid` and `infill_solid` were); on-load re-derivation reads the stored mesh (13.11.7) |
| `exchange/export3mf exportFormats exportGltf exportStl`, `gltfScene` | `export_stl export_obj export_3mf export_gltf` | read the port themselves; **instances fixed** (13.11.2 item 4) |
| `mesh/meshCommon` | the mesh commands | read the port themselves (`loadSolidMesh`) |
| `render/polygons` | `render_view render_motion render_walkthrough` | display by design: a picture of the display mesh |
| `protocol/preview` | `/preview` | display by design |
| `geometry/instanceExpansion`, `kernel-manifold` | (helpers) | covered by their commands |
| `sheetmetal/foldPiece` | sheet-metal commands | derived solids, never asset-backed |

Round 2 added the families the tripwire and the second guard found: the dynamics commands that integrate mass (`add_rigid_body add_spring check_dynamics check_motion_clearance check_prototype inspect_dynamics list_dynamics_loads simulate_motion engine_quick_check` and the time-step convergence check), `export_building_dxf` and `export_elevation_sheet` (`'document'`), `infill_solid`, `check_assembly`, `set_thread`, `convert_to_sheet_metal`, `scale_entity`, the face operations (`fillet_faces fillet_full_round move_faces delete_faces draft_faces push_pull_face split_face replace_face`), the wrap commands (`add_knurl create_curve_on_face split_face_by_curves unwrap_face wrap_to_face check_wrap`), `holes_from_recognition recognize_features create_sketch_plane place_on_sketch_plane` and the PMI commands that pick faces (`add_surface_texture apply_pmi_set add_datum_feature add_datum_target add_size_dimension add_location_dimension add_geometric_tolerance update_pmi check_pmi list_pmi`).

Kernel commands (`requiresKernel`) that take a solid operand also feed its triangles when it has no B-rep recipe: **annotated** `blend_union fillet_edge chamfer_edge shell_solid split_body add_hole add_pocket add_rib add_external_thread inspect_faces inspect_topology probe_fillet check_machining hole_table project_to_face project_edges_to_sketch export_step_ap242 export_iges`.

### 13.11.5 Rejected

| Option | Why not |
| ------ | ------- |
| Per-command `meshTargets(params)` hook | 45 commands and every future plugin command would have to say it right; forgetting it is the bug being fixed. The annotation is one declarative flag and the contract test lists the readers. |
| Load lazily inside the command (a getter or a `Proxy` on `doc.entities`) | A spread of `doc.entities` (every mutating command does one) would load everything; a throw from inside `run` is not a refusal; the result document would hold proxies. |
| Always load every asset-backed mesh | Correct but turns an unrelated missing or huge asset into a refusal of every reader. Kept only for the default scope and `'document'`. |
| Infer "all solids" from a sheet record | Heuristic, and it breaks the day a record stores its default elsewhere; the explicit `'document'` form says it. |
| A plugin-contributed resolver on `CadPlugin` | Changes the plugin interface for what a generic scan of the record gives; revisit if a record names entities by a computed rule instead of by id. |
| Swap in the stored mesh for bounds-only commands | A read of up to 600 MB to get six numbers the store already holds (`asset.bounds`). |
| Resolve in `server/` or in the UI | `--doc`, replay and the renderer fallback would differ (L1, L6). |

### 13.11.6 Known limits and left, by name

- **Native STEP / IGES paths in `server/src/native/`** take the document as it is: an asset-backed body is its display mesh there (the commands `export_step_ap242` / `export_iges` are annotated, the sidecar paths are not). Host work (Lane 4): hand them `withFullResolution` or refuse with `MESH_ASSET_LOD_ONLY`, as the CFD and topology solves now do.
- A reference spelled as a compound string (`<entityId>:face3`) is not split; only exact ids count.
- A record that is not stored under its own id (a table entry whose key differs from its `id`, a record with no `id`) is not found; a command that names one gets the default scope only when nothing else resolves. Over-reach is by design: a record that mentions an unreadable asset makes the command refuse by name.
- The cap is one number for every command.
- `add_pmi_note`, `delete_pmi` and the other metadata-only commands are not annotated (they read no triangle). The tripwire (13.11.8) runs several hundred of the registry's commands on its fixture (the test asserts more than 100); the commands whose generated params the schema check refuses before their `run` are skipped and listed in the failure message, so a command with no generated happy path is covered only by the source guard (annotated or excused, command by command).
- Performance, not correctness: `scale_nonuniform` (and the other TypeScript deform commands) on a 327,680-triangle mesh ran more than 580 s without finishing (BOARD DES-7d).

### 13.11.7 Round 2 of review: kernel results, stale assets, host jobs, the tripwire

**Kernel results never keep a stored mesh inline.** A command that builds a construction tree from an asset-backed operand (`boolean`, `shell_solid`, `add_hole`, ...) was handed the stored mesh in the view, so the leaf of the new `brep` held 327k triangles inline and bypassed `MESH_INLINE_TRIANGLE_CAP`. `runWithFullMeshes` now swaps the stored mesh into the asset-backed leaves of the construction trees of the entities it reaches (`geometry/recipeLeaves.ts`: `assetLeaves`, `mapSolidLeaves`; a kernel result built from a scan is a reached holder like the scan itself) and, after the run, replaces every swapped mesh in the result with its display mesh, in the entity and in the leaves of any new tree, keeping the `asset` reference. Re-evaluating a stored tree (the next kernel command on the result, replay) is therefore handed the stored mesh again, at the same choke point.

**Replay bypassed the view.** `replayStep` and the inert-step probe of `history.ts` called `cmd.run` directly, so a replayed `readsMeshTriangles` step read the display mesh. Both now call `runCommand` (`commands/runCommand.ts`, the function `execute` uses). Found by the `scale_entity` replay test.

**An `asset` reference is valid only while the geometry is what the asset describes.** Audit of the commands that change the positions of an existing mesh entity: `scale_entity` (via `scaleGeometry`) was the only one that kept a stale reference. Per command: `scale_entity` runs on the stored mesh (annotated) and writes the scaled mesh through `storeMesh`, i.e. a new asset with its display mesh and bounds (option a; refuses `MESH_ASSET_UNAVAILABLE` without a store); `scaleGeometry` itself returns a mesh without `asset` (instance expansion scales a stored mesh in the view, never a stale reference). `mirror_entity`, `move_entities`, `rotate_entity` and the copies change `position` / `rotation`, which the asset frame is relative to: the reference stays true. The deformations (`scale_nonuniform`, `bend_body`, ...) make a new mesh entity with no asset and a `deform` tree over the operand. The mesh commands (`cut`, `decimate`, `remesh`, ...) write their result through `storeMesh`. No affine transform is carried on the reference (option b) and no command needs the refusal (option c): `MESH_ASSET_EDIT_UNSUPPORTED` is not defined.

**Host-built jobs refuse or are handed full resolution.** `buildTopologyJob` and `buildFlowJob` (pure, run by the server without `execute`) refuse `MESH_ASSET_LOD_ONLY` naming the body when a design domain, region or case body is an asset-backed mesh that still holds only its display mesh (`geometry/mesh/displayOnly.ts`: fewer triangles than the asset). The server (`runTopologySolve`, `runCfdSolve`) hands them `withFullResolution(doc, ids, store)` so they work; a body whose asset the store lacks is refused. Both `displayOnlyMeshIds` and `withFullResolution` also follow the asset-backed mesh leaves of the construction tree (`brep`) of a kernel result, so a CFD body that is a boolean of a scan is detected and handed at full resolution. The mesh request and the other bounds-only readers (`hash/meshRequest`, `shared/target`) use `asset.bounds` and need nothing.

**The trust boundary of `asset.bounds`.** Bounds, triangle and vertex counts of an `asset` reference are read from the document and trusted by `localBounds` and by the cap. `persistence/guards.ts` checks their shape at load and, where this machine holds the asset (`getMeshAssetPort().manifest`), compares them with the store's manifest and refuses a mismatch by name (`MESH_ASSET_REF_MISMATCH`). Where the asset is not held there is nothing to compare and the reference is trusted: a hand-edited file can mislead the bounds of an asset this machine does not hold, and the command that reads it refuses (`MESH_ASSET_LOD_ONLY`) as before.

**`export_sheet_svg` reaches the whole document only when it must.** `annotations.wholeDocumentWhen(doc, params)` is true when a non-detail view of the sheet has no `entityIds`; otherwise the reach is the listed ids (through the sheet record). `readsMeshTriangles: 'document'` stays for commands that are whole-document by definition (`bill_of_materials`, `export_building_dxf`, `export_elevation_sheet`).

**Behaviour changes (a document holding an asset this machine lacks).** Refusing is right for what writes a result; a listing must stay usable, but never silently wrong. The rule (`runCommand`): a command that is `readOnly` and not `writesArtifact` is *degradable*; every other command that reads triangles refuses.

- **Degradable query** (`mass_properties`, `list_pmi`, `check_pmi`, `inspect_dynamics`, `list_dynamics_loads`, `simulate_motion`, `check_assembly`, `check_motion_clearance`, `frontal_area`, `prepare_cfd_case`, `bill_of_materials`, `geometric_validation_properties`, ...): for each reached entity whose asset this machine cannot read, the entity stays its display mesh (the other entities are swapped as usual), and the result carries a named warning: the summary ends `WARNING MESH_ASSET_LOD_ONLY: 'id' (asset <key prefix>...) not held on this machine: computed from the display level of detail`, `data.lodOnly` is the entity ids, and `data.warnings` gains `{ code: 'MESH_ASSET_LOD_ONLY', ids, assetKeys, message }`. An agent detects it with `data.lodOnly`. A command that has its own check of an asset-backed input (`measure_deviation`, the mesh commands) still refuses by its own code (`MESH_ASSET_MISSING`).
- **Export** (`annotations.writesArtifact`: `export_urdf export_code export_step_ap242 export_iges export_sheet_svg export_building_dxf export_elevation_sheet`; they are `readOnly` because they do not change the document, but their `data` is a file): refuse `MESH_ASSET_LOD_ONLY` naming the entity. The contract test requires `writesArtifact` on every annotated `export_*` command and on nothing that is not a readOnly reader of triangles. The exports that read the port themselves (`export_stl obj 3mf gltf`) refuse `MESH_ASSET_MISSING` / `MESH_ASSET_UNAVAILABLE` as before.
- **Mutating command** (`scale_entity`, `add_rigid_body`, `add_spring`, `add_decal`, `infill_solid`, the kernel feature and face commands, the PMI authoring commands): refuse `MESH_ASSET_LOD_ONLY`; a replay on a machine without the asset refuses rather than record a wrong step.
- **Too large** (`MESH_ASSET_TOO_LARGE`): a refusal for every command; it protects memory.

| Command | Before this step | Now, asset not held |
| ------- | ---------------- | ------------------- |
| `mass_properties`, `list_pmi`, `inspect_dynamics`, `check_assembly`, `simulate_motion`, ... | display mesh, silently | display mesh + `WARNING MESH_ASSET_LOD_ONLY`, `data.lodOnly` |
| `export_step_ap242`, `export_iges`, `export_code`, `export_urdf`, `export_sheet_svg`, `export_building_dxf`, `export_elevation_sheet` | display mesh (a wrong file) | `MESH_ASSET_LOD_ONLY` |
| mutating readers | display mesh, recorded | `MESH_ASSET_LOD_ONLY` |
| `measure_bounding_box`, `describe_scene`, place / align / snap, `section_box_report`, `check_model` | display mesh | `asset.bounds`, no read, no refusal |

**Degrading happens only at the outermost call.** `runCommand` marks the context it hands a command `nested` (`ExecutionContext.nested`, also the active context), so a command that `execute`s another sees it. A read-only query that is called by another command refuses `MESH_ASSET_LOD_ONLY` like a command that writes: its figure would be archived or used as an anchor by the caller. Two callers were found: `lotar_validation_properties` (the archive of mass figures: a body whose asset is lacking is archived `unmeasured`, and `validationPropertiesOf` also maps any `lodOnly` answer to null figures) and `apply_design` (the anchor of a placed body comes from `inspect_faces`; refused, it falls back to the side centre of the exact asset bounds). build_project and replay are commands too, so the steps they run refuse rather than degrade.

**Implicit bodies.** A solid node of a field (`field_from_solid`, and any field built on it through the field graph: boolean, offset, shell, transform, scalar distance, graph, lattices, Voronoi) stores only `entityId`; the triangles are read when the field is compiled, by every command that compiles one: `create_implicit_body edit_field regenerate_implicit_bodies check_implicit implicit_properties evaluate_field section_field lattice_properties create_scalar_field add_voronoi_lattice combine_fields infill_solid field_from_solid`. They are annotated; the reach follows the DAG because a field node is a real record whose tokens (operand ids, `entityId`) are followed (13.11.2 item 3). Before, a stored 10-cube compiled to a body of volume 0.4985 (the display cube) instead of 1000. **On load** the implicit extension re-realises the omitted body meshes (`restore` in `domain-implicit/src/document.ts`): for each solid node of the body's field it now reads an asset-backed mesh through the mesh asset port (`getMeshAssetPort`) and realises from the stored mesh, so the content hash is the original one; without the asset the body stays unrealised and the record and hash are untouched, reported by `afterLoad` as `IMP_BODY_STALE` naming the entity and the remediation "run regenerate_implicit_bodies on a machine that holds the asset". No silent rehash from the display mesh.

**Plans refuse, they do not degrade.** `build_project` is a command, so the queries a plan runs are nested and refuse an unreadable asset (`MESH_ASSET_LOD_ONLY`). Reason: a plan's steps feed each other and its report is the record of what was measured; a figure marked as a warning inside a step's data is easy to lose, and a plan that continues past a measured-wrong step builds on it. `onError: 'continue'` lets a measure-only plan finish with the failed step reported by name. Degrading inside a plan would need an explicit plan-level opt-in, which is not added.

**Persisted bakes of a scaled or mirrored instance.** `scaleGeometry` (and the `bakedMeshChild` path of a non-uniform or mirroring scale) returns a mesh without `asset`: what it describes is no longer the stored mesh. A command that *persists* such an expansion must write the stored mesh itself. Audit of the commands that persist an expansion or a baked copy of an instance or entity: `explode_instance` is the only one that bakes a scale (annotated; each reshaped child with an asset is written through `storeMesh`, a new content-addressed asset with its display mesh, refusing `MESH_ASSET_UNAVAILABLE` without a store; a child the instance only places keeps its asset, with the display mesh restored in the result by the choke point for every new mesh entity); `duplicate_entities`, the array commands and `addCopies` copy the entity and change only `position` / `rotation`; `create_component` moves entities unchanged; `insert_instance` makes an instance; `mirror_entity` negates a position; the expansions of `stepTargets`, glTF, BOM, mass and the renderers are transient. The probe fixture has a [2,2,2] and a [2,1,1] instance and runs `explode_instance` on both.

**Round 5 refinements.** (1) `annotations.readsMeshTrianglesWhen(doc, params)` (next to `wholeDocumentWhen`; the two answer different questions: how wide the reach is, and whether there is a reach at all) lets a command that reads triangles only in some cases skip the stored meshes: `explode_instance` of an instance with scale [1,1,1] only places its component, so it explodes wherever the document is, an unheld asset included, and keeps the asset; a scaled or mirrored instance reads. (2) The choke point restores an entity's own mesh to its display mesh only when the entity carries the asset of the swapped stored mesh (key compared, not just the mesh object). A new entity that holds a stored mesh without that reference is written through `storeMesh` (a new asset and display mesh, inline below the cap), replacing a stale reference; a store that cannot take it refuses the command by name. (3) Persistence accepts a dangling `order` entry only when an extension reports it through the optional `DocumentExtension.staleEntityIds(doc)` (implicit: bodies whose entity is not realised); an id that an extension merely derives, or that nobody knows, refuses the file as before.

**Stale implicit bodies stay in the draw order.** A body that `restore` cannot realise on this machine (the asset it measures is not held, or the engine cannot realise it) keeps its id in `order` (not in `selection`) and its record and hash untouched; the document validation accepts an `order` entry that is a derived entity id of an extension. Saving loses nothing, and a later load on a machine that holds the asset realises the body in place with the same hash (a body whose id was dropped from `order` made that file unloadable: `order is missing entity`). `restore` also reads the stored meshes of a solid node that is an instance, through the components (nested ones included).

### 13.11.8 The runtime tripwire and the source guard

`tests/unit/contract/meshAssetProbe.test.ts`: every registered command is run, with params generated from its schema (ids and id lists point at the asset-backed mesh; numbers are 2; an instance of a component holding a second asset and a kernel that reads the leaf meshes it is handed are in the fixture), on a document whose display arrays are a recording `Proxy`. A read counts when an unannotated command's `run` reads the display triangles (the guard's finiteness walk and the content hash are infrastructure and are told apart by their stack frame); commands that draw the display mesh by design are listed (`render_view`, `render_motion`, `render_walkthrough`, `set_face_color`). The same run checks the asset reference of every result: a mesh that keeps its asset keeps its positions, a mesh with a new asset has it in the store with agreeing bounds. Review round 3 found that the first version recorded no indexed read (the index test had lost a backslash) and seeded no record: the Proxy now has a self-test that an indexed read and an iteration are recorded, the trap covers the whole `execute` (reconcile, derive and after-load hooks included; only the guard's finiteness walk and the content hash are excused), and the fixture seeds a field, a CFD case and a sheet with a view, each under the id `scan`, so that the generated id-like params resolve to records that name the scan. A topology study and PMI items need a whole analysis set-up and are not seeded; they are covered by the command-by-command source guard. It found `scale_entity` (stale), `add_rigid_body`, `infill_solid`, `check_assembly`, `fillet_full_round`, `export_building_dxf` and `export_elevation_sheet`, which now carry the annotation, and was the reason the PMI, wrap, face-operation, dynamics and sketch-plane command families were annotated as a group. `tests/unit/contract/meshReaders.test.ts` is the second guard: the file audit (13.11.4) plus a command-by-command check of every file that defines commands and builds or integrates solids (`recipeOf`, `operandRecipe`, `exactRecipe`, `exactOrMesh`, `meshRecipeOf`, `bodyMassProperties`, `resolveMassProperties`, `technicalView`, `assemblyParts`, direct `.mesh.positions` reads): each command is annotated or excused with a reason.

### 13.11.9 Tests

`tests/unit/mesh/meshReach.test.ts` (26 tests; display cube 1, stored cube 10 so every value differs; the instance, group, layer, dimension, CFD case, key-only, `build_project` alias, array-of-records (a drawing view), nested-key, export and drawing tests fail on the old resolver, which was run against the first 16): baseline and bounds from the asset with no read; selection and default scope and the `'document'` form; instance (`mass_properties` 1000), component and nested instance, a mutating reader on an instance gets the stored mesh and the display mesh is back in the component (`toBe`, input unchanged), refusal inside a component by name; group, layer, dimension, CFD case (`frontalAreaM2` 100 against 1), map keys, non-mesh entity and `constructor` / `__proto__` tokens, the default scope refusing by name; a nested slice key equal to a param value does not shrink the scope, a real record is followed, a view id reaches its `entityIds`, a million-sample array is not walked (element reads counted); `build_project` with `$alias`; the cap (one mesh, the sum, once per asset, three 1.5M-triangle scans read normally); `replay_history` on the 327,680-triangle import; view commands succeed without the asset and `export_sheet_svg` of a stored-10 / display-1 cube equals the svg of an inline 10-cube and differs from the 1-cube; instance exports in four formats write 320 stored triangles and refuse by code. `tests/unit/contract/meshReaders.test.ts` (the audit list and the command-by-command second guard); `tests/unit/contract/meshAssetProbe.test.ts` (the tripwire); `tests/unit/mesh/meshKernelLeaves.test.ts` (`shell_solid` and `boolean` on an asset: the kernel is handed the stored mesh, the result keeps the display mesh in its tree, the next command is handed the stored mesh again, a 327,680-triangle import stays small and replays to the same document); `tests/unit/mesh/meshAssetEdits.test.ts` (`scale_entity` writes a new asset with agreeing bounds, mass x8 and replays to the same document, refuses without the asset; `mirror_entity`; a deformation; the load-time check of a recorded reference); `tests/unit/mesh/hostJobsLod.test.ts` (the two builders and `displayOnlyMeshIds`); `server/tests/meshReachHost.test.ts` also runs `cfd_solve` on a body held only in the store. `server/tests/meshReachHost.test.ts` (real store, no fake engine): synchronous and resolving bus, `llull --doc` and `llull --server` read the stored mesh through an instance and refuse a missing asset and an over-cap reach by name. `--app` sends the same `POST /command` as `--server`.

## 13.12 As built (DES-7c step 7: measured plan for the native mesh ops, and slice 1: `remesh` and `analyze`, 2026-10-28)

### 13.12.1 Measured: the TypeScript ops on this machine (win32-x64, 22 cores, node 24, one process per case)

Input: an icosphere of radius 10 (20 x 4^level triangles) with every coordinate moved by up to +-0.02 (LCG seed 42, the noise of 13.10). Icosphere sizes come in steps of four, so the "100k" column is level 6 (81,920); the other two are the 327,680 and 1,310,720 of 13.10. Call `tsMeshEngine.run`, wall clock; the engine cap is NOT applied (the call goes straight to the engine, to find the cost the cap protects). Parameters: `analyze` weld 0, without and with the pair search; `remesh` target edge 1.3 x the mean edge, 3 iterations, project, feature angle 30 degrees; `cut` through z = 1 with a cap; `sculpt` one `draw` stamp of radius 3 on the pole; `repair` mode `weld`, and mode `close_holes` on the same sphere with 50 holes of 6 triangles; `fill_holes` all 50 holes, curvature fairing, refine.

| Op | 81,920 | 327,680 | 1,310,720 | Where the time goes (profiled for `remesh` only; the rest read from the code) |
| -- | ------ | ------- | --------- | ------------------- |
| `remesh` | 10.8 s | 63.6 s | 301.2 s | the Botsch-Kobbelt passes: every edge test recomputes sorted rings and face lists of its vertices (profile of the Rust twin before tuning: `flip_edges` 460 of 640 ms per iteration at 82k; the TypeScript has the same structure) |
| `analyze` (no pair search) | 0.31 s | 1.77 s | 7.8 s | one object per edge and per face; Map / Set of numbers |
| `analyze` with `selfIntersections` | 0.79 s | 5.4 s | threw a `RangeError` (a `Set` of pairs past 2^24 entries; fixed in 13.12.7, the search then takes 2.5 s) | string-keyed grid, `tested` Set of pairs |
| `repair` `close_holes` | 0.53 s | 3.1 s | 15.3 s | weld, clean, orient, stitch, then the Liepa fill |
| `sculpt` | 0.43 s | 2.05 s | 10.6 s | the closest-point tree, per-vertex rings and per-stamp passes |
| `fill_holes` | 0.18 s | 0.99 s | 4.5 s | topology of the whole mesh for 50 small loops |
| `repair` `weld` | 0.12 s | 0.63 s | 3.1 s | the weld and the clean passes |
| `cut` | 0.07 s | 0.19 s | 0.76 s | one pass over the triangles (the 1.3M case came back with `capTriangles` 0: correct, see 13.12.7) |

Caps: every one of these ops has the TypeScript cap `MESH_TS_TRIANGLE_CAP` = 200,000 triangles (`tsEngine.ts`, `EDIT_OPS`), and before this step no native engine listed any of them, so at 327,680 and 1,310,720 triangles all eight were refused with `MESH_ENGINE_CAP_EXCEEDED` (the native ops were `decimate`, `smooth`, `deviation` and `quad_remesh`, the last capped at 500,000). `check_mesh` and `analyze_mesh` could therefore not inspect the scans (1M+ triangles) that every other mesh command takes through the asset store since 13.11.

### 13.12.2 Decision: what justifies a native port, and the slices

Rule: over about 1 s at 327,680 triangles, or refused by the cap where users need it.

| Op | Reason | Slice |
| -- | ------ | ----- |
| `remesh` | 63.6 s at 327k and 301 s at 1.3M; refused by the cap; the one op whose cost is a pipeline, not a pass | 1 (built) |
| `analyze` (`analyze_mesh`, `check_mesh`) | 1.8 s at 327k; refused by the cap; "end every mesh job with `check_mesh`" was impossible on a scan; the weld and topology built for it are the base of slice 2 | 1 (built) |
| `repair` (weld, clean, orient, stitch, close_holes) and `fill_holes` | 3.1 s and 0.99 s at 327k, 15 s and 4.5 s at 1.3M; a scan is exactly what has holes; both start with the weld and the topology of slice 1 | 2 |
| `sculpt` | 2.05 s at 327k, 10.6 s at 1.3M; refused by the cap; 8 brushes, symmetry, refinement | 3 |
| `cut` | 0.19 s at 327k: fast, only the cap refuses it. Either port it with the cap triangulator, or (cheaper, and enough for 1.3M at 0.76 s) lift its cap in the TypeScript engine; decide when slice 4 starts | 4 |
| the self-intersection search of `analyze` | 5.4 s at 327k and fails at 1.3M; stays TypeScript until a user needs it above 200,000 (it is off by default there) | 4 |

Each slice is one commit: Rust op + `llull-compute` wiring + engine capability + parity tests + pins + host test + measured numbers.

### 13.12.3 Slice 1 as built: `remesh` and `analyze`

Files: `solver/crates/llull-meshops/src/{remesh,remesh_quality,remesh_types,analyze,topology,weld}.rs` (new), `edit.rs` / `surface.rs` / `geom.rs` / `lib.rs` (extended), `solver/crates/llull-jsmath/src/acos.rs` (new); `server/src/native/meshProcessingEngine.ts` (capabilities `remesh` 2,000,000 and `analyze` unlimited, job parameters, result parsing); core `geometry/mesh/{remesh,tsEngineEdit,editable,analysis,engineTypes}.ts`, `commands/mesh/{runMeshOp,meshCommon,remeshMesh,analyzeMesh}.ts`.

Both ops go through the deferred host path of 13.8 unchanged: the engine answers from the result table or defers the job; `read` / op / `deviation` / `write` arrive as `progress` events; the abort signal kills the process; `LLULL_MESH_OP_TIMEOUT_S` gives `MESH_TIMEOUT`.

**Parity (13.10 discipline).** Result bytes and report equal the TypeScript engine's. How the Rust twin keeps it:

- `Math.acos` has a V8 twin (`llull-jsmath::acos`, fdlibm `e_acos.c` as in V8's `ieee754::acos`): the platform `acos` differs from V8 on 30 of the 6,017 corpus arguments. `Math.hypot` is the existing Kahan twin; `Math.min` / `Math.max` / `x || 1` have NaN- and -0-exact twins in `geom.rs`.
- Per-vertex face lists keep JavaScript `Set` order (`edit.rs`), because the tangential relaxation sums the areas in that order; `ring`, `facesOnEdge` and the edge visit order are ascending as in `editMesh.ts`.
- The relaxation is computed for all vertices in parallel against the mesh before any move (the TypeScript loop does the same: it fills a Map and applies it afterwards) and applied in vertex order, so the result does not depend on the thread count. The flip pass keeps the valence / boundary statistics of a vertex until a flip touches the vertex (a flip changes nothing else they read).
- `analyze` sums the face metrics in face order and the shell metrics in shell order, as `analysis.ts` does; the edges are found by sorting the corner uses by (edge, corner) instead of a Map, which gives the same use counts, first faces and orientation counts.

**Defined rules (the same in both engines where they apply to both):**

- A remesh whose working mesh passes `maxTriangles` (default `REMESH_MAX_TRIANGLES` = 4,000,000; a field of the op that only tests set) stops splitting and is refused with `MESH_REMESH_RESULT_TOO_LARGE`, naming the size reached and the limit. Without the rule a target edge of 1e-6 fills the memory (the Rust test with the rule disabled reached 20 GB before it was killed). The TypeScript engine applies the same rule (its result carries `tooLarge`).
- Native `remesh` input cap: 2,000,000 triangles (`MESH_ENGINE_CAP_EXCEEDED`; the working mesh keeps per-vertex face lists, about 1 GB at that size).
- Native `analyze` welds exact duplicates only (`weldTolerance` 0, what both commands pass; another value is `MESH_ENGINE_UNSUPPORTED`, so the composite falls back to the TypeScript engine; over its cap the command is refused by name: no engine left, the TypeScript one is over its cap) and never searches self-intersections: `selfIntersections: true` above the TypeScript cap is `MESH_ENGINE_CAP_EXCEEDED` with the remedy in the message (`analyze_mesh` and `check_mesh` turn it off above 200,000 by default). Coordinates above 1e100 are refused by the job (the sums would overflow, which JSON cannot carry); below the TypeScript cap the TypeScript engine answers first, so this concerns meshes it would refuse anyway.
- A native analysis is validated field by field (`isMeshAnalysis`) before a command sees it, as the deviation summary is; a native triangle-mesh result (decimate, smooth, remesh) is checked by `meshProblem` (whole xyz triples, whole triangles, finite coordinates, every index below the vertex count) and refused by name (`MESH_ENGINE_UNSUPPORTED`, "the result mesh is malformed") otherwise. Test: `server/tests/meshopsMalformedResult.test.ts`, with a stand-in job (`fixtures/fakeMeshopsJob.cjs`, node preloaded in place of the binary).
- `remesh_mesh` now asks for `withDeviation` (decimate, smooth and quad_remesh already did, 13.9): the job measures the deviation of its result, one round instead of two.

**Stored meshes (13.11).** A stored mesh is read at full resolution through the reach (the host test shows `trianglesBefore` = 327,680 with an 80-triangle display level of detail in the document). A result above `MESH_INLINE_TRIANGLE_CAP` goes through `storeMesh` and the entity gets the new asset reference; a result that fits inline replaces the entity without any `asset`, so the source reference cannot survive.

### 13.12.4 Measured (same inputs and parameters as 13.12.1; engine call through `resolveDeferred`, so it includes packing the job files, the process, JSON and unpacking; `remesh` includes the in-job deviation of 20,000 samples)

| Op | Size | TypeScript | Native | Factor |
| -- | ---- | ---------- | ------ | ------ |
| `remesh` | 81,920 | 10.8 s | 0.53 s | 20 |
| `remesh` | 327,680 | 63.6 s (refused by the cap) | 2.33 s | 27 |
| `remesh` | 1,310,720 | 301 s (refused by the cap) | 12.2 s | 25 |
| `analyze` | 81,920 | 0.31 s | 0.10 s | 3 (process start included) |
| `analyze` | 327,680 | 1.77 s (refused by the cap) | 0.15 s | 12 |
| `analyze` | 1,310,720 | 7.8 s (refused by the cap) | 0.43 s | 18 |

The first translation of `remesh` took 1.8 / 12.2 / 59.8 s: `flip_edges` was 70 % of it (about 30 ring computations per candidate edge: the valence, boundary and constraint tests of its four vertices). One ring pass per vertex (`neighbours_into` returns the neighbours with their face counts, so the valence, the boundary flag and the constrained count come from one pass), the statistics cache and the parallel relaxation gave the further 3 to 5 times. At command level on a stored 327,680-triangle sphere `analyze_mesh` and `check_mesh` answer in 0.15 s (they were refused), and `remesh_mesh` (target 0.13, 2 iterations, 233k triangles stored back) in 2.2 s including the store write.

### 13.12.5 Tests

Cargo: `tests/remesh.rs` (closed manifold in the edge band with the volume kept, coarsening keeps a boundary loop, same bytes on 1 / 2 / 7 threads, the triangle limit, 60 hostile meshes with repeated corners, duplicate faces and coordinates up to 1e150 without a panic or an index past the vertices, job refusals with stable codes, stages and rising fractions, the deviation in the same job), `tests/analyze.rs` (octahedron closed forms, boundary loops, damaged meshes counted, shells, thread counts, 80 hostile soups, job welding and refusals), `tests/ts_pins.rs` with `tests/data/ts_pins.json` (ten cases pinned to the digests and reports of the TypeScript engine; the steps to regenerate them, with `server/tests/meshopsPinsRegen.test.ts`, are in the file), the `weld` unit test (-0 equals +0), `llull-jsmath` `tests/acos_reference.rs` against `tests/data/acos_corpus.txt` (6,017 V8 results; `gen_acos_corpus.mjs` regenerates it). Server: `tests/meshopsNative.test.ts` (native == TypeScript, bit for bit: remesh isotropic / adaptive / feature edges / free boundary / region / projection off / the limit; analyze on closed, open, multi-shell, flipped, damaged and unwelded meshes with the list length 0, 1 and 1000; the composite caps), `tests/meshEditNativeHost.test.ts` (the real binary and store: full-resolution input, the asset rules, the NDJSON stages, `MESH_TIMEOUT`, closing the connection kills the process, `analyze_mesh` / `check_mesh` on 327,680 triangles). Core: `tests/unit/mesh/nativeEditOps.test.ts` (the limit in the TypeScript engine, `isMeshAnalysis` on 17 broken analyses), `tests/unit/mesh/withDeviation.test.ts` (`remesh_mesh` asks with the job). Differential runs, not committed: 300 random remesh cases (spheres, grids, waves, noise, adaptive, regions, feature angles 10 to 130 degrees) and 140 random analysis cases (soups, flipped, damaged, unwelded, two shells) are all bit-identical.

Each fails without its fix (shown by disabling the fix): the platform `acos` fails the corpus test; a reversed face order in the relaxation sum and a flip cache that is not invalidated fail the pins; removing the triangle limit fails `remesh.rs` (and fills the memory); removing the `+ 0.0` of the weld fails its unit test; dropping `remesh` from `withDeviationRequest`, the TypeScript limit, the `REMESH_TOO_LARGE` mapping of the host and the `analyze` capability each fail one named test. The pins do not see the platform `acos` (their meshes happen not to hit one of the 30 arguments): the corpus test is the guard.

### 13.12.6 Left, by name

- Slice 2: `repair_mesh` (weld, clean, orient, stitch, close_holes) and `fill_mesh_holes` (Liepa); slice 3: `sculpt_mesh`; slice 4: `cut_mesh` (or lift its TypeScript cap) and the self-intersection search of `analyze_mesh`.
- `maxDeviation`-only decimation and the memory-bound collapse loop (13.10.6) are unchanged.
- The command-level TypeScript work around the job (`prepareSolidMesh`, `measureMesh` of the result) is synchronous: a 1.3M-triangle `remesh_mesh` spends it on the event loop.

### 13.12.7 Review items of slice 1 (2026-10-28)

- **The pair search no longer throws.** `findSelfIntersections` kept a `Set` of the pairs it had tested; on the 1,310,720-triangle noisy sphere it reached 2^24 entries and V8 threw a `RangeError` ("an engine never throws"). A pair is now a candidate once, in the lowest grid cell its two cell ranges share (the maximum of the two lowest cells per axis); two large triangles are paired once by order. Same count and same pairs as testing every pair (`tests/unit/mesh/selfIntersectionDedupe.test.ts`: four random soups with large triangles against a brute-force definition, the candidate count never above the number of pairs, and the 1.3M sphere: 20.4 million candidates, 1,219 crossing pairs, 2.5 s). Disabling the rule doubles the counts and fails the soups.
- **`cut_mesh` of the 1.3M sphere left no cap, and that is correct.** The noise (+-0.02 on edges of about 0.047, about 0.4 edge) makes neighbouring triangles cross at the plane: the section is not a simple outline, the cap triangulator reports the loops as `uncapped` and adds no triangle. `cut_mesh` now says so in its summary ("N section loop(s) left uncapped: the input crosses itself near the plane ... run check_mesh, then repair_mesh") when a cap was asked for (`tests/unit/mesh/cutUncapped.test.ts`); `cap: false` and a clean section say nothing.
- **One source of truth for the feature cosine.** The jobs take the angle (`featureAngleRad` for decimate and remesh, `hardEdgeRad` for `quad_remesh`) and compute its cosine with `llull_jsmath::cos`; `featureCos` and `sharpCos` are gone from the protocol, the host and the pins. An angle outside [0, pi] is refused by the job. The pins and the parity tests are unchanged.
- **Prefer native above a per-op size.** Between 82k and 200k triangles the TypeScript engine answered `remesh` in about 25 s although the native engine was installed. `MeshProcessingEngine.preferredAbove()` lets an engine go first above a size; the composite then asks it before the earlier engines, still falls through on `MESH_ENGINE_UNSUPPORTED` and now on `MESH_ENGINE_NEEDS_HOST` (the synchronous host paths keep their in-process answer), and reports the refusal of the last listed engine that refused. Results are identical by the parity rule: only the speed changes. Measured on the reference machine, a cold native job (spawn, files, JSON) costs 25 to 45 ms, in-process TypeScript against the native job, noisy icosphere, milliseconds:

| triangles | analyze | decimate (to a quarter) | smooth (Taubin, 10) | remesh | deviation |
| --------- | ------- | ----------------------- | ------------------- | ------ | --------- |
| 1,280 | 9 / 38 | 76 / 46 | 8 / 44 | 48 / 58 | 38 / 54 |
| 5,120 | 28 / 43 | 304 / 49 | 30 / 47 | 150 / 57 | 83 / 59 |
| 20,480 | 70 / 42 | 1,609 / 71 | 117 / 45 | 631 / 91 | 245 / 70 |
| 81,920 | 265 / 59 | 8,709 / 218 | 408 / 99 | 2,916 / 220 | 813 / 88 |

  The thresholds, the smallest sizes at which native is no slower with a margin: `decimate` 1,000, `remesh` 2,000, `deviation` 3,000, `smooth` 10,000, `analyze` 15,000 (`quad_remesh` has no TypeScript twin). Tests: `tests/unit/mesh/engineRouting.test.ts` (order, fall-through, refusal choice) and `server/tests/meshopsNative.test.ts` (native chosen above the threshold, in-process below it and outside the resolving path, the same bytes and report either way).
- Smaller: the result of `remeshMesh` is a union (`{ tooLarge }` is returned before the edge statistics and the compact copy); `isMeshAnalysis` checks each self-intersection entry as a pair of counts and the genus fields as integers; the descriptions of `analyze_mesh` and its `@failure` name the refusal without the native engine; `remesh.rs` is 460 code lines (the edge statistics and the `Kind` / `Sizing` helpers moved to `remesh_quality.rs`).
- **Round 2 of the review.**
  - *The pair search stays in TypeScript up to its cap.* Both commands default `selfIntersections` to true up to 200,000 triangles, and the native engine (preferred above 15,000) refused it with `MESH_ENGINE_CAP_EXCEEDED`, which the composite does not fall through. The native engine now answers `MESH_ENGINE_UNSUPPORTED` for `selfIntersections: true` up to the TypeScript cap, so the TypeScript engine answers; above the cap it is still `MESH_ENGINE_CAP_EXCEEDED`. When the native pair search exists (slice 4) the rule goes. Tests: `engineRouting.test.ts` (`analyze_mesh` and `check_mesh` at 20,480 triangles through a native-like engine) and `meshopsNative.test.ts` (the real binary).
  - *Cell indices are doubles.* `lowCell` was an `Int32Array` and wrapped past 2^31 cells (coordinates 1e10 away from the lowest corner with unit triangles) while the grid key did not, so the pair was never tested; it is a `Float64Array`. `selfIntersectionDedupe.test.ts` has the far pair with a small triangle at the origin (1e6, 1e10, 3e11; it fails with the Int32Array) and shifted clusters against the brute-force definition. No other narrowing of an unbounded index is in the diff (Rust vertex and face indices are `u32` by the job format).
  - *The job budget.* With small meshes preferred for native, a plan of more than 256 small mesh steps ended in `MESH_JOB_LIMIT` where the TypeScript engine had run them in process. Once a resolve has used its `maxJobs`, a native op whose input is within the TypeScript cap answers `MESH_ENGINE_NEEDS_HOST` (after the held-results lookup, so finished jobs still answer) and the composite hands it to the TypeScript engine; only ops it cannot take (`quad_remesh`, meshes above its cap) still count against the hard limit. The remediation text of `MESH_JOB_LIMIT` says so. Test: `server/tests/deferredBudget.test.ts` (maxJobs + 3 small steps all succeed, three native and three in process; `quad_remesh` past the budget still refuses).
  - *Provenance differs by path.* A result is identical whichever engine produced it, but `data.provenance` (`engine`: `ts` or `native`, the version) records which one did: the same command can report `ts` on a synchronous host path and `native` on the resolving one.
