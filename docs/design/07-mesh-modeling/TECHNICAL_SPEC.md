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
- **`fit_subdivision_to_mesh`**: the Catmull–Clark limit position of each cage vertex is a fixed linear combination of the
  cage (limit stencil); iterate: closest points P on the target for the limit samples (BVH), solve
  min ‖S C − P‖² + α‖L C‖² (L = cage umbrella, α = 1e-3 named) by CG, until max deviation ≤ `maxDeviation` or `iterations`;
  `interpolate: true` targets the target's vertices nearest each cage vertex (Rhino "Interpolate SubD" [R6]). The existing
  native path then yields exact B-spline faces.
- **`fit_surface_to_mesh`**: least-squares B-spline surface approximation (02 SRF `lib/nurbs`, parameterisation by projection
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
| `decimate_mesh` 1.3 M → 100 k               | refuses (cap)                                                                                                                                         | ≤ 10 s               | TBD measure                             |
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

- **M6**: `quad_remesh` is built (13.6); `fit_subdivision_to_mesh`, `fit_surface_to_mesh` and the fit half of VC-22 are not.
- `sculpt_mesh` `along` (curve stamps) and the 04 DIR gesture; `shrinkwrap_mesh`, `displace_mesh` (COULD); torus fit; native `analyze` / `remesh` / `cut` / `fill` / `repair` / `sculpt`; `--progress` events; native decimate speed.
- The native mesh engine runs behind a synchronous port (`runComputeSync`): a job blocks the backend event loop (1.3M-triangle decimate 16.6 s), capped by `LLULL_MESH_OP_TIMEOUT_S` (600 s, `MESH_TIMEOUT`). An async `MeshProcessingEngine` port would remove the stall.
- `mesh_to_brep` follows exact curves only for line, circle and ellipse chains; regions bounded by other intersections (cone-cylinder with tilted axes, free-form) stay triangles.

## 13.6 As built (DES-7c step 1: M6 `quad_remesh`, 2026-10-27)

`quad_remesh` (toolset `mesh`) is built on the native mesh engine. `fit_subdivision_to_mesh` and `fit_surface_to_mesh` belong to M6 in the delivery plan but are separate commands with their own algorithms; they are the next steps and nothing of them is built.

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
| Job op `quad_remesh` (`{targetFaces, preserveSharp, sharpCos, adaptive}`; out `result_positions.f64` and `result_indices.u32` with FOUR indices per quad), cargo feature `quad` | `solver/crates/llull-meshops/src/quad.rs`, `lib.rs` |
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
7. **The deviation is measured on the cage faces** (symmetric, native), not on the smooth limit surface, which lies inside the cage (-2 % volume on a sphere). Closing that gap is `fit_subdivision_to_mesh`.
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

**VC-MSH-22, the quad_remesh half.** Icosphere l4 to 600 quads, cage as a subdivision solid at levels 2, native kernel: 614 quads give 2456 B-spline faces (= 614 x 4), all `bspline`, one closed solid. `mass_properties surfaceModel limit_patches` is exact: volume 4097.719 (sphere 4188.790, -2.17 %), area 1238.371 (1256.637, -1.45 %); through the plan's float32 STL, 4090.195 and 1236.858. The fit half (max deviation <= 0.05) waits for `fit_subdivision_to_mesh`.

Plans (`node server/bin/llull.cjs run <plan> --continue`, cwd `docs/design/07-mesh-modeling`, native kernel): `target_quad_remesh` 6/7 in about 9 s (the last step is the expected `CMD_INVALID_PARAMS` refusal; step 2 is `quad_remesh`: 545 quads, valence {3: 9, 4: 537, 5: 1}, Hausdorff 0.0824); `target_sculpt_quad_brep` steps 0-5 ok (step 5: 631 quads in the first build), steps 6-7 fail on the unbuilt `fit_subdivision_to_mesh`.

### 13.6.5 Left

- `fit_subdivision_to_mesh`, `fit_surface_to_mesh` and the fit half of VC-22.
- Open (boundary) input with an open-cage output; symmetry.
- No known crash remains. (The one-cell box that crashed at 6 quads in a probe was its inconsistently wound variant, which the host refuses before the engine; the outward box gives 6 quads.)
- Time at 40 000 quads (about 2 minutes) blocks the backend event loop; the async engine port (13.5.4) would remove that.

### 13.6.6 Cage commands at 50 000 vertices (review round 1)

A closed cage of 48 602 vertices and 48 600 faces (box cage, 90 segments, level 1), one `execute` each on this machine: `add_subdivision_solid` 1.06 s; `edit_subdivision_cage` (move, soft falloff, change levels) 0.22 to 0.28 s; `set_cage_crease` 0.21 s; `inset_cage_faces` 0.64 s; `select_cage_elements` 0.55 s; `set_cage_symmetry` 0.42 s; `slide_cage_edges` 0.59 s; `bevel_cage_edges` 0.69 s (was quadratic in the number of new element ids: `includes` on arrays, now a Set); `weld_cage_vertices` 0.74 s; `loop_cut_cage` 0.75 s; `extrude_cage_faces` 0.75 s; `delete_cage_faces` 0.87 s; `check_subdivision` 2.5 s (0.9 s of it self-intersection of the 97 000-triangle level mesh, 0.56 s the level-mesh volume, 0.16 s topology; 5 400 vertices 0.14 s, 21 600 vertices 0.78 s, 48 600 vertices 2.5 s: linear with large constants, no quadratic loop). Nothing else was above 1 s except the creation.

