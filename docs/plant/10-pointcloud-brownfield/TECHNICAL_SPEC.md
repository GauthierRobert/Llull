# Gap 10 SCN — Point clouds and brownfield revamps: technical specification

Companion of [FUNCTIONAL_SPEC.md](FUNCTIONAL_SPEC.md). Laws: `.claude/rules/architecture.md` (L1–L10). Operator model:
`docs/aerospace/AGENT_FIRST.md`. Validation: [validation/README.md](validation/README.md). Status: RS-3 / RS-4 built 2026-10-19
(M1, M2, M4, M5, M6, M7; M3 viewport and the V1 items not built): see §13 "As built". §1–§12 are the specification as written.

## 1. Current state in llull (2026-10-18)

There is **no point-cloud capability**. `docs/MARKET_READINESS.md` §6 says "no point clouds" for terrain. A search of
`packages/`, `src/` and `server/` for E57 / LAS / LAZ / point cloud / ICP / RANSAC finds only unrelated hits. The pieces
this gap builds on:

| Area | What exists | Path | Relevance |
| ---- | ----------- | ---- | --------- |
| External artifact pattern | Content-addressed, read-only artifact port in the execution context: `FeArtifactPort.get(hash)`. The host store is `<dir>/<sha256>.json.gz`; a file whose content no longer hashes to its name reads as absent | `packages/core/src/model/analysis.ts` (`FeArtifactPort`), `packages/core/src/commands/types.ts` (`ExecutionContext.feaArtifacts`), `server/src/fea/artifactStore.ts` (`LLULL_FEA_CACHE`) | The model for `PointCloudPort` and the cloud asset store (§2) |
| Host transport calling a registry command | `fea_import_field`: the host parses a CSV, stores an `fe_table` artifact, then calls `set_temperature_field` with the hash through the command bus | `server/src/fea/feaImportField.ts`, `server/src/fea/transports.ts` (`FeaToolsPort`) | The model for `scan_import` → `attach_point_cloud` |
| Python bridge | One short-lived CPython process per request (CadQuery / build123d), allow-listed environment, timeout | `server/src/pythonExchange.ts`, desktop bundled CPython | Optional fallback for exotic formats (V1), not used by the MVP readers |
| Survey points | `import_survey_points` stores a point group in the document (a marker per point up to 2 000 points), `create_surface` builds a TIN | `packages/domain-aec/src/civil/survey/surveyCommands.ts` | Shows why clouds must NOT be document data: survey groups are thousands of points, scans are 10⁶–10⁹ |
| CRS / site calibration | Grid ↔ local conversion, `coordinates: "grid"` refused without calibration | `packages/domain-aec/src/civil/crs/crs.ts`, `crsCommands.ts` | Georeferenced LAS / E57 placed next to a local plant |
| Image underlay | Raster stored inline as a data URL (`add_image_underlay`, size-capped) | `packages/core/src/commands/draw2d/underlay.ts` | Precedent for "reference media under the model", but the storage pattern does not scale to clouds |
| Mesh import | `import_mesh` triangle soup, capped at `MAX_IMPORT_TRIANGLES` = 2 000 000 | `packages/core/src/commands/exchange/importMesh.ts`, `commands/limits.ts` | Clouds cannot go through mesh entities either |
| Pipes | `add_pipe_run` (3D polyline, `dn` → OD from the EN 10220 / ASME B36.10M table, line number, service, level) | `packages/domain-aec/src/industrial/equipment/equipment.ts`, `industrial/piping/pipeSizes.ts` (`PIPE_SIZES`, `OUTSIDE_DIAMETER_TOLERANCE_MM` = 1.5) | Target of pipe extraction; the DN snap reuses the table |
| Steel | Catalogue (IPE, HEA, HEB, UPN, C, SHS, RHS, CHS, L) and `add_steel_member` | `packages/domain-aec/src/steel/profiles.ts`, `industrial/framing/memberSteelCommands.ts` | Target of steel fit |
| Clash | `check_clashes`: oriented-box separating-axis test between building elements, hard and clearance | `packages/domain-aec/src/industrial/clash/clash.ts`, `clashBoxes.ts` | Design-vs-design only. Design-vs-scan is new (§5.8) |
| Plane fit | Least-squares plane of a point set by cyclic Jacobi on the 3 × 3 covariance, deterministic | `packages/domain-cae/src/thermomech/plane.ts` | Same numerical method for PCA normals. Reference only: normals run in `llull-cloud` (§2.A), so no copy or move is needed (Q7 closed) |
| Viewport | Floating render origin (`RenderOriginSyncer.tsx`, `3d/floatingOrigin`), axis-aligned clipping plane (`3d/ClippingPlane.tsx`), instanced rendering, nearest snap (`viewport/nearestSnap.ts`) | `src/ui/viewport/**` | Cloud rendering plugs into these; LOD streaming is new |
| Agent plumbing | `CommandResult.error` (`{code, ids, paths, remediation}`), per-step `data` and `aliases` in `build_project` | `packages/core/src/commands/types.ts`, `commands/project/` | Used as is. A data binding between plan steps is new (TR-SCN-03) |

Sibling gaps own the size tables (`01-piping-specs-catalog`), routing and tie-in connectors (`02-spec-driven-routing`),
structures (`06-plant-structures-access`), as-built attributes in reports / IFC (`08-plant-data-reports-interop`), and the
renderer budget and review redlines (`09-plant-visualization-review`).

## 2. Target architecture

```
 file (.e57 .las .laz .xyz)                                        document (CadDocument)
   │                                                                 scan?: ScanModel  ← references, registrations, extractions
   ▼                                                                     ▲          (no points)
 server/src/scan/ (host)                                                 │ mutating scan commands (numbers only)
   scanImport.ts ── job ──► llull-compute cloud import                   │
   scanStore.ts             (solver/crates/llull-cloud: e57, las, laz,   packages/domain-aec/src/scan/ (plugin "scan", toolset "scan")
   pointCloudPort.ts        mmap, rayon; octree + asset writer)          │ queries read points and run ops through ctx.pointClouds
     │   └── compute(op) ─► llull-compute cloud <op>  (CPU; GPU = RS-4)  │ (PointCloudPort, read-only, keyed by content)
     ▼                                                                   │
 ~/.llull/cache/pointcloud/<assetKey>/  ◄────────────────────────────────┘
   manifest.json  hierarchy.bin  nodes.bin
 src/ui/viewport/3d/PointClouds.tsx (three.js Points, octree LOD) ── node requests ──► same store
   (server online / OPFS + llull-cloud WASM build offline)
```

Decisions:

1. **A cloud is an external, content-addressed asset (TR-SCN-01).** The asset key is
   `sha256(sourceSha256 ‖ importerVersion ‖ canonicalJson(importOptions))`, so the agent can compute it and re-imports
   are idempotent. The document stores only references (§3). This is the `FeArtifactPort` pattern, extended to a
   paged spatial asset.
2. **Read-only port in the execution context (TR-SCN-02).** `ExecutionContext.pointClouds?: PointCloudPort | null`
   (L9-style injection; core declares only the interface, in `packages/core/src/model/pointCloud.ts`). Hosts install it:
   `server/src/scan/pointCloudPort.ts` (Node: synchronous node reads with an LRU cache; `compute` runs
   `llull-compute cloud <op>`, §2.A) and `src/ui/services/pointCloudStore.ts` (browser offline: OPFS + worker + the
   `llull-cloud` WASM build, preloaded working set, see Q3). A null port makes every query no-op with
   `SCN_ASSET_UNAVAILABLE`.
3. **No mutating command reads points (TR-SCN-04).** Heavy work (fit, trace, registration, deviation, clash) is a
   **query**: `data` only, no document change. The agent then commits the numbers it got (`commit_asbuilt_extraction`,
   `apply_registration`), and those params hold every value needed. So feature-history replay (L8) and undo never need the
   asset, and a document travels without its multi-GB scans. The one exception is `attach_point_cloud`, which checks that the
   key exists when a port is present (§4).
4. **Native readers and numerics in the Rust crate `llull-cloud` (TR-SCN-05, RS-3, §2.A).** E57 (XML + binary
   sections + CRC-32C), LAS / LAZ header and records, ASCII, the octree builder and the asset writer, plus kd-tree,
   normals, RANSAC / LM fits, ICP and distances. It lives in the `solver/` Cargo workspace and runs as
   `llull-compute cloud <job>`. Nothing in `packages/*` imports it (L2): it is reached only through the `scan_import`
   transport and `PointCloudPort`. There is no `packages/pointcloud-io` package and no injected `LazDecoder`.
5. **Domain commands in the `scan` plugin** (`packages/domain-aec/src/scan/`, toolset `scan`, installed in
   `src/app/plugins.ts`; `@mcp/toolsets` gets a `scan` getter). It belongs in AEC because commits compose `add_pipe_run`
   and `add_steel_member` through `execute` (L10). The plugin keeps validation, entity → analytic primitive / triangle
   conversion, the DN snap (`PIPE_SIZES`), extraction hashing and the commits. The numerics run in `llull-cloud` behind
   the port (decision 2).
6. **Host import transport `scan_import`** (CLI `llull scan import`, MCP host tool, REST `POST /scan/import`). It reads the
   file, rejects proprietary formats, runs `llull-compute cloud import <job-folder>` (NDJSON progress, timeout) to parse and
   index it, writes the asset atomically (temp dir + rename), and returns `{ sourceSha256, assetKey, manifest }`. The command bus is not involved, because importing does not change the
   document. Desktop: same server. File > Import scan in Electron calls it.
7. **Kernel not required.** Distances to llull solids use the analytic primitive when the entity is one (cylinder, box,
   sphere, pipe run), otherwise the entity's display tessellation with the sagitta bound reported. Exact B-rep distance
   through `ctx.kernel` is V1 (OCC `BRepExtrema_DistShapeShape`), behind `requiresKernel` only in that mode.

Technical requirements:

| Id | Pri | Requirement | VC |
| -- | --- | ----------- | -- |
| TR-SCN-01 | MUST | Content-addressed cloud asset; key = sha256(source ‖ importer version ‖ options); atomic write; per-block CRC | VC-SCN-10 |
| TR-SCN-02 | MUST | `PointCloudPort` in `ExecutionContext` (interface in core, implementations in server / ui); null port → `SCN_ASSET_UNAVAILABLE` | VC-SCN-50 |
| TR-SCN-03 | MUST | `build_project` `$fromStep` data binding (core, shared prerequisite) | SC-SCN-02, 03, 05 |
| TR-SCN-04 | MUST | No mutating command reads points; replay with the port removed gives identical documents and ids (golden test) | golden |
| TR-SCN-05 | MUST | `llull-cloud` native readers (E57, LAS, LAZ, ASCII) and octree builder, reached only through `scan_import` and `PointCloudPort`; the same crate built to WASM for the browser / no-binary path (≤ 10 M points) | VC-SCN-01..08, 60 |
| TR-SCN-06 | MUST | Host transport `scan_import` (CLI / MCP / REST) running the `llull-compute cloud import` job, with progress, timeout, proprietary refusal | VC-SCN-02, 03, 11 |
| TR-SCN-07 | MUST | Lossless int32 coordinates at the source quantum relative to grid-snapped node origins | VC-SCN-09 |
| TR-SCN-08 | MUST | Seeded RANSAC, canonical point order, deterministic kd-tree; identical results across runs and OSes (Rust-CPU path, §2.A) | VC-SCN-20, 30, 60 |
| TR-SCN-09 | MUST | Fit uncertainty (covariance, CRLB at σ̂, coverage) in every fit result | VC-SCN-20 |
| TR-SCN-10 | MUST | Deviation reports its model error bound; clash reports its sampling bound and named noise threshold | VC-SCN-42, 43, 52 |
| TR-SCN-11 | SHOULD | Viewport LOD with a hard point budget; parents before children; crop / section as clip planes | VC-SCN-10 (query twin) |
| TR-SCN-12 | MUST | Native vs reference: native and WASM builds give identical `data`; GPU paths (RS-4) never produce recorded numbers on their own (§2.A) | VC-SCN-60 |

Laws: L1 (every capability is a command; import is a host transport exactly like `fea_import_field`), L2 (native code
only behind the host transport and the port; I/O in server / ui), L3 (commands return new docs; queries return the input doc), L4 (no entity built outside commands;
as-built entities come from `add_pipe_run` / `add_steel_member` via `execute`), L5 (schemas derived from zod), L6 (server
is a host: store + transport only), L7 (slices commit as ordinary 2D entities), L8 (replay-safe by decision 3), L9
(injected port), L10 (plugin).

### 2.A Stack amendment (RS1, 2026-10-18)

Decided by the owner in [RS1](../../decisions/RS1-native-compute.md) (programme steps **RS-3** and **RS-4**). It
replaces the pure-TS readers, the `packages/pointcloud-io` package and the injected `LazDecoder` (lazrs WASM /
laz-perf) of the first draft.

| Item | Before | Now |
| ---- | ------ | --- |
| E57 / LAS / LAZ / ASCII import | pure TS readers in `packages/pointcloud-io` (`@pcio`); LAZ through an injected `LazDecoder`; parsing in `worker_threads` | `llull-compute cloud import` (crate `llull-cloud` in `solver/`): native `e57`, `las` and `laz` (laz-rs) crates, memory-mapped input, rayon over chunks |
| Octree build, asset writer | pure TS over typed arrays | `llull-cloud`, out of core; same asset layout (§3.1) |
| kd-tree, PCA normals, RANSAC, LM fits, ICP, batch pipe extraction (V1) | pure TS modules in `scan/geometry/` | `llull-cloud`, run by `llull-compute cloud <op>` behind `PointCloudPort.compute` |
| Deviation, design-vs-scan clash | pure TS, BVH, parallel | Rust CPU (`llull-cloud` + `llull-bvh`) gives the recorded numbers; GPU (wgpu) is an optional fast path (RS-4, below) |
| LAZ / COPC writing | blocked: the laz-perf WASM build decodes only (old Q2) | the `laz` crate writes LAZ, so COPC export is possible (V1) |
| Native E57 (old Q4) | open: libE57Format C++ + Xerces-C as a Node addon | closed: Rust `e57` crate; no C++ addon, no Xerces |
| Browser / no binary | TS readers, ≤ 10 M points | the same `llull-cloud` compiled to WASM (one thread), ≤ 10 M points per cloud |
| Viewport | three.js `Points` + octree LOD | unchanged |
| Gate | Vitest | `npm run native:check` (`cargo test` + `cargo clippy -D warnings`) for the crate; Vitest for the plugin and the host |

Seams (names unchanged; L2, L6, L9):

- **`scan_import`** runs `llull-compute cloud import <job-folder>` (RS1 job folder + NDJSON progress). The job writes
  the asset to a temp dir and the host renames it into the store. The command bus is not involved.
- **`PointCloudPort`** gains one method, `compute(assetKey, op)` (§3), for the heavy numerics. The server
  implementation runs `llull-compute cloud <op>` synchronously, like the `llull-kernel` proxy runs `KernelOps`
  (timeout, progress). The browser and the no-binary fallback run the WASM build. Query commands keep their names,
  params and `data` shapes. They still never write the document (decision 3); commits still go through
  `commit_asbuilt_extraction` and `apply_registration`.
- **Missing binary.** Clouds ≤ 10 M points fall back to the WASM build. Above that, `NATIVE_TOOL_MISSING` with an
  install hint (RS1 §2 rule 5).

Determinism (TR-SCN-08, AF-13) is met by the Rust-CPU path:

- seeded xorshift128+ RANSAC, canonical point order (`CloudPoints`), kd-tree with an index tie-break;
- rayon work is cut into fixed chunks and merged by chunk index, never by completion order, so results do not depend
  on the thread count;
- transcendental functions come from the pure-Rust `libm` crate, not the platform C library; no FMA contraction and no
  `target-cpu=native`. The native builds on each OS and the WASM build therefore give identical bits (VC-SCN-60).

GPU (RS-4, milestone M7, after the MVP):

- `cloud_to_model_deviation` and `check_asbuilt_clash` take `device?: 'cpu' | 'gpu'` (default `'cpu'`). The GPU path
  is a wgpu compute kernel (`llull-gpu`): analytic primitives (cylinder, box, sphere, pipe-run segments) are evaluated
  in the shader; tessellated entities go through the `llull-bvh` triangle BVH. Coordinates are sent in f32, relative
  to each entity's local frame.
- **Clash.** The GPU pass is a conservative prune: a point is dropped only when its f32 distance exceeds the clearance
  by more than a bound ε_gpu, derived from the f32 unit roundoff (2⁻²⁴) × the local extent × the operation count and
  fixed at M7. The kept points are re-evaluated on the CPU in f64, so clusters, gaps and statuses equal the CPU-only
  result (`deterministic: true`).
- **Deviation.** The GPU result (per-point colours, quick statistics) carries `device` and `deterministic: false` in
  provenance (RS1 §2 rule 3). Numbers that a report, a commit or a VC uses come from the Rust-CPU path.
- Every GPU kernel has a CPU twin, so VC-SCN-40..43 and 60 run in CI without a GPU adapter.

Native vs reference: VC-SCN-60 (validation README). The references are the pack's independent readers, pye57 /
laspy and `reference_check.py`; their tolerances do not change.

## 3. Data model

```ts
// packages/core/src/model/pointCloud.ts  (core: interface + document slice types only)
export type CloudFormat = 'e57' | 'las' | 'laz' | 'xyz' | 'pts' | 'copc';
export type CloudAttribute = 'intensity' | 'rgb' | 'classification' | 'returnNumber' | 'numberOfReturns' | 'gpsTime' | 'normal' | 'rowColumn';

export interface CloudManifest {                     // written by the importer, immutable, part of the asset
  readonly assetKey: string;                         // sha256 hex (decision 1)
  readonly sourceSha256: string;
  readonly sourceName: string;
  readonly format: CloudFormat;
  readonly importerVersion: string;
  readonly unit: 'm';                                // assets are always metres; documents convert
  readonly pointCount: number;
  readonly scans: readonly {                         // E57 data3D / one per LAS file
    readonly guid: string | null;
    readonly pointCount: number;
    readonly pose: { readonly rotationWXYZ: readonly [number, number, number, number]; readonly translation: Vec3 };
    readonly stationOrigin: Vec3 | null;             // pose translation in the file frame
  }[];
  readonly bounds: { readonly min: Vec3; readonly max: Vec3 };       // recomputed from the data, never copied from a header
  readonly headerBounds?: { readonly min: Vec3; readonly max: Vec3 }; // LAS only, when it disagrees (SCN_LAS_HEADER_BOUNDS)
  readonly quantum: Vec3;                            // coordinate step of the stored ints (source scale, or 1e-5 m)
  readonly attributes: readonly CloudAttribute[];
  readonly crs?: { readonly wkt?: string; readonly epsg?: number };  // from LAS WKT / GeoTIFF VLR or E57 coordinateMetadata
  readonly octree: { readonly depth: number; readonly rootSpacing: number; readonly maxPointsPerNode: number; readonly nodeCount: number };
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
}

export interface CloudQuery {
  readonly box?: { readonly min: Vec3; readonly max: Vec3 };   // in asset (file) frame
  readonly slab?: { readonly origin: Vec3; readonly normal: Vec3; readonly thickness: number };
  readonly sphere?: { readonly centre: Vec3; readonly radius: number };
  readonly lod: 'full' | { readonly maxSpacing: number } | { readonly budget: number };
  readonly maxPoints: number;                        // hard cap, never exceeded
  readonly attributes?: readonly CloudAttribute[];
}

export interface CloudPoints {                        // canonical order: node id ascending, then in-node order (AF-13)
  readonly positions: Float64Array;                   // xyz in metres, asset frame
  readonly indices: Uint32Array | null;               // global record index when lod = 'full'
  readonly attributes: Partial<Record<CloudAttribute, Float32Array | Uint16Array | Uint8Array>>;
  readonly truncated: boolean;                        // maxPoints reached
  readonly spacing: number;                           // effective point spacing of the returned set
}

export interface PointCloudPort {                     // ExecutionContext.pointClouds
  manifest(assetKey: string): CloudManifest | null;
  query(assetKey: string, query: CloudQuery): CloudPoints | null;
  nearest(assetKey: string, point: Vec3, maxDistance: number): { readonly index: number; readonly position: Vec3; readonly distance: number } | null;
  compute(assetKey: string, op: CloudOp): CloudOpResult | null;   // heavy numerics in llull-cloud (§2.A)
}
// CloudOp: one variant per heavy query (fit, extract_pipes, slice, register, deviation, clash), params in metres in the
// asset frame; design entities travel as analytic primitives or triangles. CloudOpResult is the query's `data` before
// unit conversion, plus provenance (binary version, device, deterministic).

// document slice (absent until the first scan command), like `civil?`
export interface ScanModel {
  readonly clouds: Readonly<Record<string, CloudReference>>;
  readonly cloudOrder: readonly string[];
  readonly registrations: Readonly<Record<string, RegistrationRecord>>;
  readonly extractions: Readonly<Record<string, ExtractionRecord>>;
  readonly crops: Readonly<Record<string, CropBox>>;
}

export interface CloudReference {
  readonly id: string;                                // step-scoped id `cloud-<step>.<k>` (L8)
  readonly name: string;
  readonly assetKey: string;
  readonly sourceSha256: string;
  readonly placement: 'local' | 'grid';               // grid → via civil site calibration
  readonly transform: Mat4;                           // asset frame → document frame (registration applied), metres → doc unit applied at use
  readonly registrationId: string | null;
  readonly display: { readonly visible: boolean; readonly colorBy: 'rgb' | 'intensity' | 'elevation' | 'classification' | 'single'; readonly pointSize: number };
}

export interface RegistrationRecord {
  readonly id: string;
  readonly fixed: string; readonly moving: string;    // cloud ids (or 'document' for scan-to-model)
  readonly method: 'targets' | 'icp_point_to_point' | 'icp_point_to_plane' | 'targets+icp' | 'supplied';
  readonly transform: Mat4;                            // moving → fixed
  readonly quality: {
    readonly targetResiduals?: readonly { readonly name: string; readonly residual: number }[];
    readonly rms: number; readonly overlap?: number; readonly iterations?: number; readonly converged: boolean;
  } | null;                                            // null for 'supplied' → unverified
  readonly status: 'computed' | 'accepted' | 'unverified';
  readonly acceptedBy?: { readonly signer: string; readonly signatureId: string };   // human gate (AF-34a)
  readonly provenance: Provenance;
}

export interface ExtractionRecord {
  readonly id: string;
  readonly kind: 'pipe' | 'pipe_path' | 'steel_member';
  readonly cloudId: string; readonly assetKey: string; readonly region: RegionSpec;
  readonly fit: CylinderFit | PipePathFit | SteelFit;  // numbers only (axis, radius, covariance, inliers, rms, coverageDeg, …)
  readonly snapped?: { readonly table: 'en10220'; readonly dn: number | null; readonly odMm: number; readonly toleranceMm: number; readonly defaulted: boolean };
  readonly createdEntityIds: readonly string[];
  readonly unverified: boolean; readonly unverifiedReasons: readonly string[];
  readonly status: 'computed' | 'accepted';
  readonly extractionHash: string;                     // sha256 of the canonical fit + region + assetKey (tamper check on commit)
  readonly provenance: Provenance;                     // method, algorithm version, seed, thresholds (AF-35)
}
```

As-built entities: `add_pipe_run` and `add_steel_member` gain an optional `asBuilt: { extractionId }` field on the building
element (owned with 02 RTE / 06 STA). `check_clashes` and the line list then show "as-built". Persistence: `scan` is a new
optional slice. The document version is bumped and the migration is a no-op (absent = no clouds). Validation goes in
`scan/validate.ts` (plugin `DocumentExtension.validate`). The asset is never saved in the `.llull` file. **Pack and go**
(`llull pack --with-scans`) zips the document with the assets it references (V1).

### 3.1 Asset layout (MVP)

```
<LLULL_SCAN_CACHE or ~/.llull/cache/pointcloud>/<assetKey>/
  manifest.json            CloudManifest (canonical JSON)
  hierarchy.bin            node table: id (octree key: level + xyz), bbox, pointCount, byteOffset, byteSize, childMask
  nodes.bin                concatenated node blocks: int32 x/y/z relative to the node's grid origin at `quantum`,
                           then attribute columns (uint16 intensity, uint8×3 rgb, uint8 class, …)
  source.sha256            the source hash (cross-check)
```

Lossless coordinates: the node origin is snapped to the source grid (`offset + k·quantum`), and positions are stored as
int32 multiples of `quantum`. A LAS source is therefore exact, and any source is within quantum/2 (VC-SCN-09).
Absolute float32 would lose up to 0.0625 m at x ≈ 1.7e6 m (measured 0.062 m on `test1_4.las`). The cache keeps this own
format, so the synchronous port reads it without a LAZ decoder (Q2, settled); COPC is an export written by `llull-cloud`.

## 4. Commands (toolset `scan`)

Units: params are in **document units** (AF-04) unless named `…Deg`; assets are metres and every command converts. All
queries are bounded (AF-12) and deterministic (AF-13: canonical point order, seeded RNG with `seed` default 1). Codes are
in §7. The heavy queries (fits, extraction, slice, registration, deviation, clash) run their numerics through
`PointCloudPort.compute` (§2.A); the plugin converts units and shapes `data`.

### 4.1 Mutating (numbers only, replay-safe)

| Command | Params sketch | Tags |
| ------- | ------------- | ---- |
| `attach_point_cloud` | `{ sourceSha256?: string, assetKey?: string, name?, placement?: 'local'\|'grid', transform?: Mat4, applyStationPoses?: boolean = true }` (one of the two keys) | @affects adds 1 `CloudReference` to `doc.scan` (no entities). @invariant no points are copied into the document; the id is step-scoped. @failure key unknown to an installed port → `SCN_ASSET_MISSING`; `grid` without a site calibration → `SCN_CRS_NO_CALIBRATION`; duplicate asset already attached → `SCN_CLOUD_DUPLICATE` |
| `update_point_cloud` | `{ cloudId, name?, visible?, colorBy?, pointSize?, transform? }` | @affects 1 reference. @invariant a changed `transform` marks the extractions of that cloud stale (seen by `check_point_clouds`). @failure unknown id → `SCN_CLOUD_NOT_FOUND` |
| `detach_point_cloud` | `{ cloudId }` | @affects removes the reference; the asset stays in the cache. @invariant committed as-built entities remain, with provenance kept |
| `set_scan_crop` / `clear_scan_crop` | `{ cloudIds?: string[], name, box: { min, max }, keep: 'inside'\|'outside' }` | @affects 1 crop. @failure min ≥ max on any axis → `SCN_CROP_INVALID` |
| `apply_registration` | `{ record: RegistrationRecord-shaped }` (from `compute_registration`) | @affects sets `moving.transform` and `registrationId`; stores the record (status `computed`). @invariant moving ≠ fixed; transform is rigid (det = 1, orthonormal within 1e-9). @failure non-rigid → `SCN_REG_NOT_RIGID`; unknown clouds → `SCN_CLOUD_NOT_FOUND` |
| `mark_registration_supplied` | `{ cloudId, reportRef? }` | @affects records method `supplied`, status `unverified` (pre-registered contractor data) |
| `accept_registration` | `{ registrationId, signature }` | **Human gate** (AF-34a, uses `ctx.humanSignature`). @failure no verifier / agent caller → `SCN_HUMAN_GATE` |
| `commit_asbuilt_extraction` | `{ extraction: ExtractionRecord-shaped, line?, service?, levelId?, insulationThickness? }` | @affects 1 extraction record + N entities created by `add_pipe_run` / `add_steel_member` through `execute`, flagged `asBuilt`. @invariant `extractionHash` matches the canonical content, else refused; `unverified` is copied from the cloud's registration status and the fit quality. @failure hash mismatch → `SCN_EXTRACTION_TAMPERED`; unknown cloud → `SCN_CLOUD_NOT_FOUND` |
| `accept_asbuilt_extraction` | `{ extractionId, signature }` | **Human gate**: clears `reviewRequired` for fabrication use |
| `commit_slice_geometry` (SHOULD) | `{ slice: SliceResult-shaped, as: 'polyline'\|'circles', workPlane? }` | @affects 2D entities through `draw_polyline` / `draw_circle` (L7) |

### 4.2 Queries (read-only, `data` only)

| Command | Params sketch | `data` (AF-10, units in names) |
| ------- | ------------- | ------------------------------ |
| `describe_point_cloud` | `{ cloudId }` | manifest summary in document units: `pointCount`, `scans[]` (pose, count), `bounds`, `centroid`, `attributes`, `quantum`, `crs`, `registration` (status + RMS), `warnings[]` |
| `query_cloud_points` | `{ cloudId, box?, slab?, sphere?, lod: 'full'\|'budget'\|{maxSpacing}, maxPoints ≤ 200 000, attributes? }` | `points` (flat array), `indices?`, `truncated`, `spacing`, `totalPoints`, `maxQuantisationError` |
| `nearest_cloud_point` | `{ cloudId, point, maxDistance }` | `recordIndex`, `point`, `distance`, `secondNearestDistance` (ambiguity check) |
| `measure_cloud` | `{ cloudId, from: Vec3\|{nearest}, to: Vec3\|{nearest}\|{entityId} }` | `distance`, `delta`, snapped points |
| `slice_cloud` | `{ cloudId, origin, normal, thickness, fit?: 'none'\|'circle'\|'lines', maxPoints? }` | section points in plane coordinates (`u,v`), fitted `circles[]` (centre, radius, rms, n), `lines[]` |
| `fit_primitive` | `{ cloudId, kind: 'plane'\|'cylinder'\|'sphere'\|'circle', region: RegionSpec, noiseSigma?, distanceThreshold?, normalThresholdDeg = 20, seed = 1 }` | parameters, `covariance`, `inliers`, `rms`, `coverageDeg` (cylinder / sphere), `crlb`, `extraction` (ready to commit) |
| `extract_pipes` | `{ cloudId, region, sizeTable: 'en10220'\|'none', minRadius?, maxRadius?, insulationThickness?, maxPipes = 1 (MVP), seed = 1 }` | `extractions[]` (cylinder fit + DN snap + ends from the inlier extent), `rejected[]` with reasons |
| `trace_pipe_centreline` (V1) | `{ cloudId, seed: Vec3, sizeTable?, stepLength?, maxLength?, bendDetectionDeg = 3 }` | `straights[]`, `bends[]` (radius, angleDeg, centre), `reducers[]`, `intersectionPoints[]`, `extractions[]` |
| `fit_steel_member` (V1) | `{ cloudId, region, families?: string[], maxCandidates = 5 }` | `axis`, `measured` (hMm, bMm, twMm, tfMm, rollDeg), `candidates[]` (profile, score, residualRms), `extractions[]` |
| `compute_registration` | `{ fixed, moving, method, targets?: [{ name, fixedSeed\|fixedPoint, movingSeed\|movingPoint, kind: 'sphere'\|'point', radius? }], initial?: Mat4, maxIterations = 100, trimRatio = 0.9, seed = 1 }` | `record` (ready for `apply_registration`), `quality` (per-target residuals, RMS, overlap, iterations, converged) |
| `cloud_to_model_deviation` | `{ cloudId, entityIds, model: 'analytic'\|'tessellated', segments?, maxDistance, threshold, signed = true, histogramBins = 20 }` | per entity: `min/max/mean/rms`, `fractionBeyondThreshold`, `histogram`, `modelErrorBound`, `pointsUsed`; pipes add `fittedAxisOffset`, `radiusDelta`; `reviewRequired` |
| `check_asbuilt_clash` | `{ cloudId, entityIds, clearance, minPointsInVolume?, excludeExtractionsOf? }` | `results[]`: entity, status `hard`/`clearance`/`clear`, `minGap`, `points`, `location`, `cluster bbox`; `minPointsInVolume {value, source, defaulted}`; `reviewRequired` |
| `check_point_clouds` | `{ cloudIds? }` | AF-20 list `{ severity, code, ids, message, remediation }` |

`RegionSpec = { kind: 'all' } | { kind: 'box', min, max } | { kind: 'seed', point, radius } | { kind: 'crop', cropId }`.

**Plan data binding (TR-SCN-03, core prerequisite shared with other packs).** A `build_project` param value
`{ "$fromStep": "<alias>", "path": "a.b.0" }` resolves to the `data` of an earlier query step, read at the given path.
`--validate` checks that the alias is a query step that comes earlier. This lets one plan go fit → commit. Until it exists,
agents run the query with `--json` and write the commit plan from its output; `validation/plans` use the binding and are
marked DRAFT.

## 5. Algorithms

### 5.1 E57 reader (`llull-cloud`, on the `e57` crate)

The behaviour below is the contract. `llull-cloud` adds what the crate does not expose (checksum policy, `SCN_*`
codes); this is checked at M1.


- **Physical layer.** A 48-byte header: `ASTM-E57`, `versionMajor`, `versionMinor` (u32), `filePhysicalLength`,
  `xmlPhysicalOffset`, `xmlLogicalLength`, `pageSize` (u64, little-endian). Pages of `pageSize` (1024) bytes each end in
  a 4-byte big-endian CRC-32C (Castagnoli, polynomial 0x82F63B78 reflected) over the 1020 payload bytes. A logical offset
  maps to a physical one by skipping the CRC tails. Checksum policy: all pages by default, `sparse` on request, never
  `none` unless asked. A mismatch gives `SCN_E57_CHECKSUM` with the page number. Proven by `bad-crc.e57`.
- **XML.** A streaming SAX parse (no DOM), namespace `http://www.astm.org/COMMIT/E57/2010-e57-v1.0`. It reads
  `/data3D[i]`: guid, pose (rotation w,x,y,z + translation), `points` CompressedVector (`fileOffset`, `recordCount`,
  prototype), `cartesianBounds`, `intensityLimits`, `colorLimits`. `/images2D` is listed but ignored (V2). The 10 test files
  cover Cartesian float / double / ScaledInteger, intensity, colour, return index / count, normals extension, invalid states.
- **Binary section.** A CompressedVector section header followed by data packets (packet header, per-field bytestream
  buffers). Each prototype field is decoded by type:
  - Float: raw IEEE.
  - Integer: bit-packed with width ⌈log2(max − min + 1)⌉, value = min + raw.
  - ScaledInteger: bit-packed raw, value = raw·scale + offset.
  Streams are consumed in lock step per record. Spherical scans are converted:
  x = r cos(el) cos(az), y = r cos(el) sin(az), z = r sin(el).
- **Poses.** p_file = R(q)·p_local + t, with R from the unit quaternion (w, x, y, z). A non-unit quaternion (|‖q‖ − 1| > 1e-6)
  gives `SCN_E57_POSE_INVALID`. With `applyStationPoses: false`, local coordinates are kept and the pose is stored.
- **Invalid points.** `cartesianInvalidState` 2 (no data) is dropped. 1 (direction only) is dropped and counted in the manifest.
- Cross-check in CI: pye57 (VC-SCN-01..05) and our minimal Python reader (`validation/data/tools/e57_own_reader.py`).

### 5.2 LAS / LAZ reader (`llull-cloud`, on the `las` and `laz` crates)

- Public header 1.0–1.4 (offsets in `validation/data/tools/las_own_header.py`). The point count comes from the 64-bit
  field for 1.4, else the legacy 32-bit field. PDRF 0–10 record layouts. Extra bytes (VLR 4) are kept as named attributes.
  EVLRs are read for WKT. X = Xrec·scale_x + offset_x.
- **LAZ.** PDRF with bit 7 set (LASzip convention). The point data are decoded chunk by chunk by the native `laz`
  crate (laz-rs, the code behind lazrs). The chunk table allows parallel decoding with rayon. VC-SCN-07 proves bit
  equality with the LAS twin.
- **Bounds.** Always recomputed from the decoded records. A header that disagrees by more than one quantum gives the
  warning `SCN_LAS_HEADER_BOUNDS`. `simple1_3.las` stores its bounds unscaled.

### 5.3 Octree index and LOD (Potree-2 style, COPC-compatible ordering)

- Cubic root = bounds expanded to a cube. A node at level l has spacing s_l = s_0 / 2^l, with s_0 = rootEdge / 128 by
  default. Points are assigned by a counting-sort pass on Morton codes. Each node keeps ≤ `maxPointsPerNode` (default
  20 000) points chosen by grid / Poisson-disk sampling at s_l. The rest go to the children. Leaves keep all their points,
  so the full set is the union of all nodes (VC-SCN-10). Sampling is deterministic (no RNG; ties by Morton code, then
  record index).
- Out of core: a first pass counts per cell at a coarse level, then a chunked distribution. Memory stays bounded at about
  1 GB for any input size (Schütz 2020 [R7]). Input is memory-mapped; chunks run in parallel (rayon) and are merged in
  Morton order, so the asset bytes do not depend on the thread count.
- **LOD selection** (viewport and `lod: budget` queries): a priority queue on the projected node size
  w = (node diagonal / distance to the camera) · (screen height / (2 tan(fov/2))). Refine while
  Σ points ≤ budget and w > minimum pixel size. Frustum and crop culling apply. A coarser level is never skipped, so
  parents always load before children. `query_cloud_points` with `budget` uses the same rule with a virtual "camera" at the
  region centre, so it is deterministic.

### 5.4 Normals and kd-tree

- A static kd-tree over the query result (median split, deterministic tie-break by index).
- Normals by PCA on k = 20 neighbours: the eigenvector of the smallest eigenvalue of the 3 × 3 covariance (cyclic
  Jacobi, the method of `domain-cae/thermomech/plane.ts`, written again in `llull-cloud`). They are oriented toward the scan station when known, otherwise toward
  the region centroid. Curvature λ_min / Σλ is used as a planarity filter.

### 5.5 Primitive fitting (FR-SCN-12)

- **RANSAC** [R8]. The minimal oriented sample is: plane 1 point + normal (or 3 points); cylinder 2 points + normals
  (axis a = n1 × n2; the centre is the intersection of the two normal lines projected onto the plane ⊥ a; r = distance);
  sphere 2 points + normals; circle (2D) 3 points. An inlier has |d| < ε (default 3σ when `noiseSigma` is given, else
  2.5 × the median spacing) and a normal angle < α (20°). The iteration count is N = ⌈log(1 − p) / log(1 − wᵐ)⌉ with
  p = 0.999 and w the running inlier ratio, capped at 10 000. The PRNG is seeded (xorshift128+).
- **Refinement.** Levenberg–Marquardt on the orthogonal residual (cylinder: d_i = ‖(x_i − c) × a‖ − r [R12]) with a
  minimal parameterisation: 2 axis-point offsets in the plane ⊥ a, 2 axis tilts, r. Two passes of inlier re-selection.
- **Uncertainty.** cov ≈ σ̂²(JᵀJ)⁻¹ with σ̂² = Σd²/(n − 5). This is reported as `covariance` and as standard deviations
  (radius, axis angle, axis position) next to the CRLB at σ̂. These are the same formulas that produce the validation
  tolerances (validation README; reference run all pass).
- **Coverage.** The angular span of the inliers around the axis. Below 60° the radius is ill-conditioned:
  `SCN_FIT_LOW_COVERAGE` (warn) and `unverified`.
- **Circle in a slice.** Kasa algebraic fit, then LM (geometric).

### 5.6 Pipe extraction, DN snap, centreline (FR-SCN-13, 14)

- `extract_pipes` runs RANSAC cylinders in the region, accepts radii in [minRadius, maxRadius], and takes the ends from
  the extreme axial projections of the inliers (5th / 95th percentile + the 2.5 % tail as a margin).
- **DN snap.** OD = 2(r − t_ins), with t_ins the insulation thickness, default 0 and named. Choose the size table row with
  |OD − OD_table| ≤ tol. tol = `OUTSIDE_DIAMETER_TOLERANCE_MM` (1.5 mm, existing llull constant) by default, reported with
  `defaulted: true`. No match gives `SCN_FIT_NO_STANDARD_SIZE` and the measured OD is kept. Two matches cannot happen
  with the current table (adjacent ODs differ by ≥ 5.6 mm, more than twice the tolerance).
- **Centreline tracing** (V1). From the seed: fit a local cylinder in a sphere of radius 3r, then step along ±a by
  `stepLength` (default 2r). Re-fit in the new window, predicting the next window from the current axis. Stop when the
  inliers drop below 30 % or the radius changes by more than 15 % (reducer / flange candidate, reported). When the axis
  direction turns by more than `bendDetectionDeg` between windows, switch to a torus fit over the turning windows
  (parameters: centre, plane normal, bend radius R, tube radius r). This gives R, the angle and the tangent points. The
  intersection point (PI) of the two straight axes is the closest point between them (both straights must be within 1 mm
  of each other, else `SCN_TRACE_SKEW`).
- **Commit.** Straights and PIs become `add_pipe_run` points (bends at the interior points, as `add_pipe_run` does today).
  The measured bend radius is stored in the extraction for 02 RTE's fitting resolver.

### 5.7 Steel member fit (FR-SCN-15, V1)

The axis comes from the PCA of the region: the largest-variance direction, refined by fitting planes to the flange and
web faces and taking their common direction. Points are projected onto the section plane (2D). Each catalogue profile p
and roll θ ∈ {0°, 90°, 180°, 270°} ± 5° (searched by golden section) is scored by the one-sided chamfer distance of the
section points to the profile outline, aligned by its bounding-box centre on the visible extents:
score = RMS(min-distance). Candidates are ranked, and h and b are measured from the plane fits (top-to-bottom flange
faces, tip-to-tip). tw and tf are reported only when ≥ 10σ, otherwise `null` with a reason (STL-A: they are not gated).

### 5.8 Registration (FR-SCN-08..10)

- **Targets.** Each sphere is segmented within 2r of its seed and fitted algebraically (‖x‖² = 2c·x + k) then by LM. Pick
  points are used directly. With n ≥ 3 non-collinear pairs, the closed form [R11] is: centroids, H = Σ(p_i − p̄)(q_i − q̄)ᵀ,
  SVD H = UΣVᵀ, R = V diag(1, 1, det(VUᵀ)) Uᵀ, t = q̄ − R p̄. Degeneracy test: the second singular value of the centred
  target matrix must be > 1e-3 × the first. Otherwise `SCN_REG_DEGENERATE`; n < 3 gives `SCN_REG_TARGETS_INSUFFICIENT`.
  Residuals are reported per target, with RMS.
- **ICP** [R9, R10]. The moving points are a deterministic subsample (voxel 2 × spacing). Each iteration:
  1. nearest neighbours in the fixed kd-tree;
  2. rejection: d > 3 × median, and trimming to `trimRatio` [Chetverikov 2002];
  3. a closed-form update (point-to-point, Horn / SVD) or one linearised Gauss–Newton step (point-to-plane: minimise
     Σ((R p + t − q)·n_q)² with small-angle R).
  It stops when |ΔRMS| < 1e-9 m or after `maxIterations`. It reports `converged`, the RMS, and the overlap (the fraction
  of points kept). Overlap < 0.1 or no convergence gives `SCN_REG_NOT_CONVERGED`, and the record is returned with
  `converged: false`, never applied by default.
- **Quality gates** (named defaults, AF-31): target RMS ≤ 3 mm, ICP RMS ≤ 2 × the median spacing. Above them, `warn` +
  `unverified`. The thresholds are company-configurable later.

### 5.9 Cloud-to-model deviation (FR-SCN-17, 18)

- **Analytic primitives.** Cylinder (pipe run segments): signed d = ‖(x − c) × a‖ − r for points whose axial projection
  falls inside the segment, else the distance to the end cap. Box: the signed box distance. Sphere: ‖x − c‖ − r. This is
  exact (VC-SCN-41 to 1e-6 with µm-rounded input).
- **Tessellated.** A BVH over the display triangles (`llull-bvh`), point-to-triangle by Voronoi regions [Ericson §5.1.5],
  signed by the pseudo-normal. The reported `modelErrorBound` = max over curved faces of the sagitta r(1 − cos(π/n)) (VC-SCN-42).
- Only points within `maxDistance` of the entity's bounding box (inflated) are used. Each point is assigned to its nearest
  entity among those selected. Statistics: min, max, mean, RMS, histogram, fraction beyond the threshold.
- **Pipes.** Re-fit a cylinder to the assigned points and report the axis offset to the design axis (at mid-length) and
  Δr. DEV-A gives an offset of 25 mm.
- **GPU (RS-4).** `device: 'gpu'` gives per-point colours and quick statistics, marked `deterministic: false`; the
  recorded numbers come from the CPU path (§2.A).
- **V2.** M3C2 [R13] for rough surfaces.

### 5.10 Design-vs-scan clash (FR-SCN-19)

For each design entity, a query box = its AABB inflated by the clearance. Each point is classified by the analytic or
tessellated signed distance: d < 0 → hard, 0 ≤ d < clearance → clearance. Points within 3 × spacing of the entity's own
as-built source extraction (`excludeExtractionsOf`), or of the cloud the entity was extracted from at its region, are
excluded. A result is reported only when the connected cluster (voxel 2 × spacing, 26-connectivity) has ≥
`minPointsInVolume` points (default 10, named `defaulted`, AF-31). This avoids noise and stray points (people, rain).
The minimum gap is min d over the cluster, with sampling bound ≤ spacing/2 reported. Status per entity: worst of its
clusters. With `device: 'gpu'` the point classification starts with the conservative GPU prune of §2.A; the result is
the same. `reviewRequired: true` always, because a "clear" result from a scan is not proof of absence (occlusion), and the
summary says so.

## 6. Interop and persistence

| Format | Direction | Notes |
| ------ | --------- | ----- |
| E57 1.0 (ASTM E2807) | import MVP; export V1 | Native reader in `llull-cloud` (§5.1); export through the `e57` crate's writer. Export writes one `data3D` per cloud, ScaledInteger at `quantum`, pose identity (registration baked) or the original pose + transform |
| LAS 1.0–1.4 / LAZ | import MVP | LAZ via the native `laz` crate; WKT / GeoTIFF CRS kept in the manifest; classification kept |
| COPC 1.0 | import / export V1 | LAZ 1.4 PDRF 6/7/8 + `info` and `hierarchy` VLRs [R6]; written by `llull-compute cloud` with the `laz` encoder; readable by PDAL, QGIS and potree-core. Not the cache format (Q2) |
| XYZ / PTS / CSV | import MVP | Declared column order and unit; PTS first line = count (checked) |
| RCP / RCS (ReCap), FLS (Faro), native Leica / Trimble | refused | `SCN_FORMAT_PROPRIETARY` |
| PLY (binary / ascii) | import V1 | Common from photogrammetry / CloudCompare |
| Document `.llull` | `scan` slice (references + records) | Assets are never embedded; `pack --with-scans` (V1) |
| IFC 4.3 | via 08 DAT | As-built pipes and members export like any element, with property `Pset_llullAsBuilt` (extractionId, fit RMS, source) |

## 7. CLI / MCP / UI surfaces and error codes

- **CLI.** `llull scan import FILE [format=xyz|pts|csv] [sourceUnit=m] [columns=xyz] [applyStationPoses=true]
  [checksum=all|sparse] --json --progress`. `llull scan list` (cache), `llull scan gc` (unreferenced assets), and every
  command of §4 as usual. `render_view` draws clouds at a deterministic LOD (budget param) for AF-22.
- **MCP.** Toolset `scan` (all commands). Host tool `scan_import` (path inside `LLULL_EXCHANGE_DIR`, or an upload).
  Queries respect the existing output cap and page with `maxPoints`.
- **UI.** `src/ui/viewport/3d/PointClouds.tsx` (one `THREE.Points` per resident node, attribute buffers, size attenuation,
  EDL shading optional), `src/ui/panels/ScanPanel.tsx` (clouds, registrations, extractions, runs). The snap source is
  "scan point" (worker kd-tree per resident node). The section plane and crop boxes are shader clip planes. All edits
  dispatch commands (L1).

### 7.1 Requirements → AF mapping

| TR / FR | AF |
| ------- | -- |
| FR-SCN-01..07, 11, TR-SCN-05/06 (import transport) | AF-01 (`llull search scan`), AF-02 (descriptions), AF-40 (`--progress`, cached by asset key), AF-41 (`llull-compute` bundled per RS1 §2 rule 5, WASM fallback, offline) |
| All commands, TR-SCN-03 | AF-04 (units in schema), AF-05 (one plan; `$fromStep`), AF-14 (step `data`) |
| Queries | AF-10 (`data` with units), AF-12 (bounded, `--save` for CSV / PNG), AF-13 (seeded, canonical order) |
| FR-SCN-20 `check_point_clouds` | AF-20 |
| Deviation / clash / fit numbers | AF-21 (numbers instead of colour maps), AF-22 (`render_view`) |
| FR-SCN-21 | AF-11 (table below) |
| FR-SCN-10, 13, 19, 22 | AF-31 (named defaults: DN tolerance, clash noise threshold, registration RMS gates), AF-32 (`unverified` propagation), AF-33 (`reviewRequired`), AF-34 / 34a (`accept_registration`, `accept_asbuilt_extraction`), AF-35 (provenance) |

### 7.2 Error and warning codes (stable)

| Code | Sev | Raised by | Meaning | Remediation |
| ---- | --- | --------- | ------- | ----------- |
| `SCN_FORMAT_UNSUPPORTED` | fail | import | Unknown extension / signature | "Convert to E57, LAS or LAZ" |
| `SCN_FORMAT_PROPRIETARY` | fail | import | RCP / RCS / FLS / native | "Export E57 (or LAS) from the vendor tool, e.g. ReCap → Export → E57" |
| `SCN_E57_CHECKSUM` | fail | import | Page CRC-32C mismatch (page n) | "The file is corrupt; re-export or re-copy it" |
| `SCN_E57_STRUCTURE` | fail | import | XML or binary section invalid (path) | "Re-export from the scanner software; report the path" |
| `SCN_E57_POSE_INVALID` | fail | import | Non-unit quaternion | "Fix the pose in the source, or import with applyStationPoses=false" |
| `SCN_LAS_HEADER` | fail | import | Bad signature / version / record length | "The file is not LAS 1.0–1.4" |
| `SCN_LAS_HEADER_BOUNDS` | warn | import | Header bounds disagree with the data | "Bounds were recomputed; no action" |
| `NATIVE_TOOL_MISSING` | fail | import / queries | `llull-compute` not installed and the cloud is above the WASM fallback cap (10 M points) | "Install the desktop app (it bundles llull-compute), or crop at export" |
| `SCN_CLOUD_EMPTY` | fail | import / attach | 0 valid points | "Check the export settings (invalid points removed?)" |
| `SCN_IMPORT_TOO_LARGE` | fail | import | Over the host limit (browser 10 M) | "Use the desktop app or crop at export" |
| `SCN_ASSET_MISSING` | fail / warn | attach / check | Key not in the store | "Run `llull scan import <file>` on this machine" |
| `SCN_ASSET_UNAVAILABLE` | fail | queries | No point-cloud port in this host | "Run on the desktop app or the server" |
| `SCN_CLOUD_NOT_FOUND` | fail | all | Unknown cloud id | "List clouds with `describe_point_cloud` / Scan panel" |
| `SCN_CLOUD_DUPLICATE` | fail | attach | Asset already attached | "Use the existing cloud id" |
| `SCN_CRS_NO_CALIBRATION` | fail | attach | `grid` without a site calibration | "Call set_site_calibration first" |
| `SCN_CROP_INVALID` | fail | crop / region | min ≥ max on an axis | "Give min < max on every axis" |
| `SCN_QUERY_LIMIT` | warn | queries | `maxPoints` reached (`truncated`) | "Narrow the region or page" |
| `SCN_FIT_TOO_FEW_POINTS` | fail | fits | < 30 points (cylinder), < 10 (plane / circle) in the region | "Enlarge the region or lower the LOD spacing" |
| `SCN_FIT_NO_MODEL` | fail | fits | RANSAC found no model with ≥ 20 % inliers | "Tighten the region around one object" |
| `SCN_FIT_LOW_COVERAGE` | warn | cylinder / sphere | Angular coverage < 60° | "Add a scan from another side; result unverified" |
| `SCN_FIT_HIGH_RMS` | warn | fits | RMS > 3σ (given) or > 2 × spacing | "Check for insulation, clamps or two objects in the region" |
| `SCN_FIT_NO_STANDARD_SIZE` | warn | extract | No size-table OD within tolerance | "Kept the measured OD; check insulation thickness or the table" |
| `SCN_TRACE_SKEW` | warn | trace | Straights do not meet within 1 mm | "Possible offset or 2-plane bend; split the trace" |
| `SCN_STEEL_NO_MATCH` | warn | steel fit | Best score > 3σ | "Non-catalogue or built-up section; model manually" |
| `SCN_REG_TARGETS_INSUFFICIENT` | fail | registration | < 3 target pairs | "Add targets or use ICP with an initial transform" |
| `SCN_REG_DEGENERATE` | fail | registration | Collinear / coincident targets | "Use targets that span a plane" |
| `SCN_REG_TARGET_NOT_FOUND` | fail | registration | No sphere within 2r of a seed | "Move the seed onto the target" |
| `SCN_REG_NOT_CONVERGED` | fail | ICP | Not converged / overlap < 10 % | "Give an initial transform (targets) or a larger overlap region" |
| `SCN_REG_NOT_RIGID` | fail | apply | Transform not orthonormal / det ≠ 1 | "Pass the record from compute_registration unchanged" |
| `SCN_REGISTRATION_UNVERIFIED` | warn | check | Supplied / computed but not accepted, or gates exceeded | "Ask a reviewer to accept_registration" |
| `SCN_EXTRACTION_TAMPERED` | fail | commit | `extractionHash` mismatch | "Commit the extraction exactly as returned by the query" |
| `SCN_EXTRACTION_STALE` | warn | check | Cloud transform changed after the fit | "Re-run the fit and commit again" |
| `SCN_CLASH_FOUND` | fail | clash | Hard clash cluster | "Re-route or field-verify" |
| `SCN_CLEARANCE_VIOLATION` | warn | clash | Clearance cluster | "Re-route or accept with a reviewer" |
| `SCN_HUMAN_GATE` | fail | accept_* | Agent caller / no signature | "A qualified reviewer must sign" |

## 8. Performance and robustness budgets

| Item | Budget (desktop, 8 cores, NVMe, `llull-compute`) | Browser offline / no binary (WASM build) |
| ---- | ------------------------------- | --------------- |
| Import + index LAS / E57 uncompressed | ≥ 2 M points/s (100 M in < 60 s parse + < 60 s index) | ≥ 0.5 M points/s, ≤ 10 M points per cloud |
| Import LAZ | ≥ 1 M points/s (parallel chunks) | ≥ 0.3 M points/s |
| Peak memory during import | ≤ 1.5 GB regardless of size | ≤ 600 MB |
| Asset size | ≤ 14 bytes/point + attributes (int32 xyz + 2 B intensity) | same |
| Viewport | ≥ 30 fps at a 3 M budget; ≤ 150 ms node fetch p95 | ≥ 30 fps at a 1 M budget |
| `fit_primitive` cylinder, 50 k points in the region | < 300 ms | < 1 s |
| ICP 100 k × 100 k, 50 iterations | < 3 s | < 10 s |
| Deviation 10 M points × 500 entities | < 20 s on the Rust-CPU path (BVH, rayon); GPU path (M7) TBD — measure | n/a (desktop only above 2 M) |
| Design-vs-scan clash 10 M points × 500 entities | CPU TBD — measure; GPU prune + CPU exact (M7) TBD — measure | n/a |
| Determinism | Same asset key and same results on every run and OS (integer coding, seeded RNG, canonical order, `libm`, fixed-order merges) | same bits as native (VC-SCN-60) |

Robustness: every import writes to a temp dir and renames it atomically. A crash leaves no partial asset. The store
verifies `manifest.assetKey`. Node blocks carry a CRC32 that is checked on read (a corrupt block reads as missing →
`SCN_ASSET_MISSING`). Timeouts and progress follow AF-40.

## 9. Test strategy (mapped to VCs)

| Layer | Tests | VCs |
| ----- | ----- | --- |
| `llull-cloud` (`cargo test`, in `npm run native:check`) | `tests/e57.rs` (10 files vs `e57_reference.json`, CRC, empty, encodings, pose), `tests/las.rs` (10 files vs `las_reference.json`, LAZ = LAS, bounds warning), `tests/octree.rs` (lossless quantisation on `test1_4.las`, invariants and determinism on `autzen_trim.laz`); fits, ICP, deviation and clash on the synthetic CSVs | VC-SCN-01..10, 20..43 (native side) |
| `scan` plugin unit (`tests/unit/scan/`) | `nearest`, `cylinderFit`, `centreline`, `steelFit`, `slice`, `icp`, `targets`, `deviation`, `asbuiltClash`, `agentCodes`, `checkPointClouds`; a `PointCloudPort` fixture backed by the `llull-cloud` WASM build over the CSV / E57 files (no binary needed); each command has happy + failure + `is pure` tests (NN-1) | VC-SCN-12, 20..24, 30..32, 40..43, 50..52 |
| Contract | `toToolSchemas()` snapshot gains the `scan` toolset; `scan` document slice validation and migration; the `$fromStep` binding in `build_project` | TR-SCN-03 |
| Server | `server/tests/scanImport.test.ts` (transport: proprietary refusal, CRC, empty, atomic write, idempotent key); `server/tests/packReplay10scn.test.ts` runs `validation/plans/*.json` | VC-SCN-02, 03, 11, SC-SCN-01..05 |
| Golden | one plan per regression: attach + commit extraction replays to identical ids **with the port removed** (proves decision 3) | TR-SCN-04 |
| Native vs reference | the algorithm VCs on the native binary and on the WASM build, `data` compared bit for bit; GPU vs CPU on CLH-A / DEV-A where an adapter exists (CPU twin otherwise) | VC-SCN-60 |
| Coverage | `packages/domain-aec/src/scan/**` under the 90/85/90/90 gate; `llull-cloud` gated by `npm run native:check` | — |
| Reference cross-check (CI, optional job) | `validation/data/tools/reference_check.py` + pye57 / laspy in a venv; fails if the pack's references drift | all A-grade VCs |
| Production gate | SC-SCN-04 on a real customer tie-in scan with field-measured references (Q6) | — |

## 10. Delivery plan

| Milestone | Content | Depends on | Effort |
| --------- | ------- | ---------- | ------ |
| M1 Readers | `llull-cloud` E57 + LAS + LAZ + ASCII readers, `llull-compute cloud import`, WASM build, VC-SCN-01..08, 11 | RS-0 (`solver/` workspace) | 3 wk |
| M2 Asset + port | Native octree builder, asset store, `PointCloudPort` (Node, `compute` proxy), `scan_import` transport + CLI, `attach / describe / query / nearest`, VC-SCN-09, 10, 12 | M1 | 3 wk |
| M3 Viewport | `PointClouds.tsx` LOD streaming, colour modes, crop / section clip, scan-point snap, Scan panel (read-only) | M2, 09 VIS budgets | 3 wk |
| M4 Fit + pipes | RANSAC / LM fits in `llull-cloud`, slice, `extract_pipes`, DN snap, `commit_asbuilt_extraction`, `$fromStep` binding (core), VC-SCN-20, 21, 24 | M2, 01 PSC table API | 3 wk |
| M5 Registration | targets, ICP (`llull-cloud`), records, human gates, VC-SCN-30..32 | M2 | 2 wk |
| M6 Compare | deviation, design-vs-scan clash (Rust CPU), `check_point_clouds`, AF flags, VC-SCN-40..43, 50..52, 60 (native vs WASM) | M4 | 2 wk |
| M7 GPU compare (RS-4) | wgpu deviation and clash prune, `device` param, VC-SCN-60 GPU rows | M6, RS-0 `llull-gpu` / `llull-bvh` | 2 wk |
| V1 | centreline tracing, steel fit, batch extraction (native, parallel), COPC / E57 export (native writers), global registration, OCC exact distance, browser offline store | M4–M6, 02 RTE, 06 STA | 8 wk |

MVP (M1–M6) is about 16 engineer-weeks. RS1's RS-3 (≈ 6 wk) is the native part of M1, M2, M4 and M5, not extra work; RS-4
is M7 (2 wk, after the MVP).

## 11. Open questions / decisions needed

1. **Q1 — Plan data binding.** Adopt `{ "$fromStep", "path" }` in core `build_project` (TR-SCN-03)? It is needed by every
   pack that has a query-then-commit split (FEA, scan, routing). Owner: core.
2. **Q2 — Cache format. Settled (RS1).** The cache stays the own `nodes.bin` (lossless int32, read by the synchronous
   port without a decoder). The native `laz` crate can encode, so COPC import / export is no longer blocked; it ships
   in V1.
3. **Q3 — Synchronous port in the browser.** Commands are synchronous. The browser store must therefore preload the region
   a query touches (the store's `dispatch` awaits `prefetch(region)` before running the command), or offline mode is
   limited to clouds resident in memory (≤ 10 M points). The numerics run in the `llull-cloud` WASM build either way.
   Decide the UX.
4. **Q4 — Native E57 reader. Settled (RS1).** The Rust `e57` crate in `llull-cloud`; no libE57Format / Xerces-C Node
   addon. The browser uses the WASM build of the same crate.
5. **Q5 — Insulation.** Is the insulation thickness per line (from 08 DAT line list) or given per extraction? It affects
   the DN snap.
6. **Q6 — Real-scan validation set.** No public plant scan with surveyed pipe truth under 5 MB was reachable. The owner
   should supply one anonymised tie-in scan + field measurements for the production gate.
7. **Q7 — Shared numerics. Closed (RS1).** Scan normals run in `llull-cloud`, so the TS solver in
   `domain-cae/thermomech/plane.ts` stays where it is.
8. **Q8 — Scan-to-model registration.** Register a cloud to the *design model* (ICP against the tessellated design) for
   plants whose design model is trusted. Useful but risky: it hides real deviations. V1 behind a reviewer gate?

## 13. As built (RS-3 / RS-4, 2026-10-19)

### 13.1 Layout

| Layer | Path | Content |
| ----- | ---- | ------- |
| Native crate | `solver/crates/llull-cloud` | readers (`read/{e57,las,ascii}.rs`), octree + asset (`octree.rs`, `asset.rs`, `manifest.rs`, `store.rs`), `kdtree.rs` (+ seeded xorshift128+), `linalg.rs` (cyclic Jacobi, LU), `lm.rs`, `normals.rs`, `fit/{cylinder,plane,sphere,circle}.rs`, `slice.rs`, `register.rs`, `distance.rs`, `compare.rs`, `compare_op.rs`, `gpu.rs` (feature `gpu`), `job.rs` / `ops.rs` |
| Job binary | `llull-compute cloud import <folder>`, `llull-compute cloud op <folder>` | job contracts in the module docs of `job.rs` and `ops.rs`; NDJSON events of `llull-protocol` |
| Core | `packages/core/src/model/pointCloud.ts` | `PointCloudPort`, `CloudManifest`, `CloudOp`, the `ScanModel` slice (`CadDocument.scan`); `ExecutionContext.pointClouds` |
| Plugin | `packages/domain-aec/src/scan/` (plugin `scan`, toolset `scan`) | 24 commands (below), `document.ts` (slice validation) |
| Host | `server/src/scan/` | `scanStore.ts` (store, asset key), `assetReader.ts` (synchronous TS reader of the asset), `pointCloudPort.ts` (Node port: reads in TS, `compute` = `spawnSync llull-compute cloud op`), `scanImport.ts` + `scanTools.ts` (`scan_import`, `scan_list`; CLI `llull scan import FILE`, `llull scan list`); installed by `server/src/fea/context.ts` `serverContext()` |

Commands: mutating `attach_point_cloud`, `update_point_cloud`, `detach_point_cloud`, `set_scan_crop`, `clear_scan_crop`,
`apply_registration`, `mark_registration_supplied`, `accept_registration` (human gate), `commit_asbuilt_extraction`,
`accept_asbuilt_extraction` (human gate); queries `describe_point_cloud`, `query_cloud_points`, `nearest_cloud_point`,
`measure_cloud`, `slice_cloud`, `fit_primitive`, `extract_pipes`, `compute_registration`, `cloud_to_model_deviation`,
`check_asbuilt_clash`, `check_point_clouds`. `add_pipe_run` gained the optional `asBuilt { extractionId, unverified }`.

### 13.2 Decisions and deviations from §1–§11

1. **No WASM build (owner directive LC1, CLAUDE.md "PRODUCT DIRECTIVE").** TR-SCN-05's browser / no-binary WASM path, the
   `src/ui/services/pointCloudStore.ts` port and Q3 are dropped: llull runs only in the desktop app and the CLI. Without
   `llull-compute`, `scan_import` and every heavy query answer `NATIVE_TOOL_MISSING` with the install hint; the reads that the Node
   port does in TypeScript (`describe_point_cloud`, `query_cloud_points`, `nearest_cloud_point`, `measure_cloud`) work on any asset
   already in the store. VC-SCN-60 (a) "native vs WASM" becomes "native reproducibility": identical asset bytes, fits, ICP
   transforms and deviation sums for any thread count (`tests/octree.rs`, `fits.rs`, `registration.rs`, `compare.rs`).
2. **M3 (viewport) not built** (CLI-first scope). `render_view` does not draw clouds yet.
3. **Asset key** (decision 1): `sha256("<sourceSha256>\n<importerVersion>\n<canonicalJson(importOptions with defaults)>")`,
   `importerVersion = "llull-cloud@<crate version>/asset-1"`. Options in the key: `format`, `sourceUnit`, `columns`,
   `applyStationPoses`, `checksum`, `maxPointsPerNode`.
4. **Asset layout v1** (§3.1): node offsets are **u32** from the node's grid origin (not i32: the root node's samples span the whole cube),
   then a u32 record-index column, then the attribute columns. LAS / LAZ keep the raw record integers (bit-exact, VC-SCN-09). Float
   sources (E57, ASCII) use quantum **1e-7 m**, ×10 until the extent is below 2^30 codes (finer than §3.1's 1e-5 m, which could not
   meet VC-SCN-12's ±1e-6 m). `sourceUnit` now also scales LAS / LAZ grids (quantum and offset × the unit, the codes stay exact);
   a CRS declaring feet with `sourceUnit=m` warns `SCN_LAS_UNIT_FEET` (`autzen_trim.laz` is in US feet).
5. **In-core octree build.** Counting-sort on 96-bit Morton codes, grid sampling of 128³ cells per node (first point per cell in
   Morton order, no RNG), deterministic for any thread count. Not out of core and no memory map (the workspace forbids `unsafe`, which
   `memmap2` needs): ≈ 60 B/point during import, so §8's 1.5 GB peak is not met above ~25 M points (follow-up).
6. **Fit refinement**: inliers are re-selected until the set is stable (2 to 10 passes) rather than exactly twice: with the adaptive
   RANSAC count, two passes left CYL-B at a fixed point of a mediocre model (axis error 0.076°, 4 500 of 6 000 inliers); iterating
   (local optimisation, Chum, Matas & Kittler, DAGM 2003) gives 0.004° for every seed. `fit_primitive` fits plane / cylinder / sphere;
   circles are fitted in `slice_cloud` (`fit: "circle"`).
7. **Registration frames.** `RegistrationRecord.transform` maps the moving asset frame to the fixed asset frame; `apply_registration`
   sets `moving.transform = fixed.transform · record.transform`. Target seeds are in the document frame. ICP: rejection
   d > max(3 × median, 1e-4 m), trimming to `trimRatio`, overlap = fraction of moving points within 3 × the fixed spacing at the end.
8. **Replay without the asset (TR-SCN-04)**: `attach_point_cloud` takes `assetKey` (sourceSha256 is an optional cross-check) and stores
   nothing derived from the port (name default `scan <key prefix>`, colour mode `rgb`), so a replay with no port gives the same document
   (unit test and server test). A `grid` placement is the site calibration's 2D Helmert (scale included): `CloudReference.transform`
   is affine; registration records are rigid.
9. **Extraction records** keep the native fit in metres in the document frame; `extractionHash` = sha256 of canonical
   `{ kind, cloudId, assetKey, region, fit, snapped, cloudTransform, unverified, unverifiedReasons, provenance }`.
   Unverified = the cloud's registration is `unverified`, or the fit warned `SCN_FIT_LOW_COVERAGE` / `SCN_FIT_HIGH_RMS`.
10. **DN snap (01 PSC not built)**: `packages/domain-aec/src/industrial/piping/pipeSizes.ts` `PIPE_SIZES` (DN 15–600) and
    `OUTSIDE_DIAMETER_TOLERANCE_MM`; insulation thickness per extraction (Q5: a parameter, named default 0). When 01 PSC's table API
    lands, `snapDn` (`scan/extraction.ts`) is the one place to switch.
11. **Distances**: a pipe segment is an open tube (radial distance while the axial projection is inside, distance to the end disk
    beyond); an entity is the union of its primitives (minimum); a mesh is signed by the normal of its nearest triangle (per mesh part;
    no angle-weighted pseudo-normal). Tessellated mode facets pipes / cylinders at `segments` (bound r(1 − cos(π/n)), VC-SCN-42);
    spheres and general solids use display triangles with `modelErrorBound: null` and a reason.
12. **Clash**: the gap of a clear entity is the minimum over points within `searchDistance` (named default 1 m) — required for the
    exact GPU prune; an as-built run committed from the same cloud ignores points within 3 × its fit's median spacing of itself.
13. **GPU (RS-4, M7)**: one WGSL kernel (`gpu.rs`) gives per-point signed distances in f32 relative to the entities' centre; triangles
    are brute force per entity (GPU BVH traversal is RS-6). ε_gpu = 64 · 2⁻²⁴ · L (L the largest local coordinate). Measured on an
    NVIDIA GeForce RTX 4080 Laptop GPU (Vulkan): DEV-A analytic max |d_gpu − d_cpu| = 1.5e-8 m, 64-facet mesh 1.4e-8 m, ε_gpu ≈ 4e-6 m;
    the CLH-A clash with the GPU prune equals the CPU result byte for byte. Ericson's barycentric closest point lost 3.8e-4 m in f32 on
    the 2 m × 1 cm facets, so the shader projects on the plane (edge-side tests) else takes the nearest edge segment. `llull-compute`
    supports `device: "gpu"` only when built with `--features gpu` (else `SCN_GPU_FALLBACK`, CPU numbers unchanged).
14. **Not built**: `$fromStep` plan binding (TR-SCN-03, a core prerequisite: plans stay DRAFT, agents run queries with `--json`),
    `trace_pipe_centreline` (VC-SCN-22), `fit_steel_member` (VC-SCN-23), `commit_slice_geometry`, COPC / E57 export, `llull scan gc`,
    `server/tests/packReplay10scn.test.ts`, M3 viewport.

### 13.3 Validation status

| VC | Status | Test |
| -- | ------ | ---- |
| 01–05 E57 inventory, CRC, empty, encodings, pose | pass | `solver/crates/llull-cloud/tests/e57.rs`; 02, 03 also `server/tests/scanImport.test.ts` |
| 06–08 LAS / LAZ inventory, LAZ ≡ LAS, header bounds | pass | `tests/las.rs` |
| 09 large coordinates (bit-exact through the asset) | pass | `tests/octree.rs`, `server/tests/scanImport.test.ts` (TS reader) |
| 10 octree / LOD invariants, identical bytes | pass | `tests/octree.rs`, `server/tests/scanImport.test.ts` |
| 11 proprietary refusal | pass | `server/tests/scanImport.test.ts`, `tests/e57.rs` |
| 12 nearest on the coloured cube | pass | `tests/octree.rs`, `server/tests/scanImport.test.ts` (registry command) |
| 20a–c cylinders within the CRLB tolerances | pass | `tests/fits.rs`, `server/tests/scanNative.test.ts` |
| 21 DN snap | pass | `tests/unit/scan/extraction.test.ts`, `server/tests/scanNative.test.ts` |
| 22, 23 | not built (V1) | — |
| 24 slice circle | pass | `tests/fits.rs`, `server/tests/scanNative.test.ts` |
| 30 ICP-A | pass (own seeded 70 % / σ 0.2 mm draw; the pack's numpy draw is not reproducible in Rust) | `tests/registration.rs` |
| 31 TGT-A | pass | `tests/registration.rs`, `server/tests/scanNative.test.ts` |
| 32 degenerate registrations | pass | `tests/registration.rs`, `tests/unit/scan/registration.test.ts` |
| 40–43 C2M-A, DEV-A, 64-facet bound, CLH-A | pass | `tests/compare.rs`, `server/tests/scanNative.test.ts` |
| 50–52 codes, unverified propagation, review flags | pass | `tests/unit/scan/*.test.ts` |
| 60 (a) reproducibility, (b) GPU clash, (c) GPU deviation | pass (a re-scoped, decision 1) | `tests/*.rs`, `tests/gpu_parity.rs`, `server/tests/scanNative.test.ts` |

### 13.4 Open questions (§11) decided

Q1 deferred (core). Q2 settled (own cache, u32 offsets). Q3 dropped (no browser, LC1). Q4 settled (`e57` crate). Q5 decided: a
parameter per extraction (`insulationThickness`, named default 0). Q6 open (owner). Q7 closed. Q8 deferred to V1.

### 13.5 Crates and licences (RS1 §2 rule 7)

`e57` 0.11.13 (MIT), `las` 0.11.1 (MIT) with `laz` 0.13.0 (Apache-2.0), `libm` 0.2 (MIT / Apache-2.0), `chrono` (via `las`,
MIT / Apache-2.0), `wgpu` 25 (MIT / Apache-2.0, feature `gpu`). Nothing GPL. Test data: the pack's files (licences in
`validation/data/licenses/`) and clouds generated in the tests.

## 12. References

- [R1] ASTM E2807-11(2019)e1, 3D Imaging Data Exchange, Version 1.0 — ASTM — https://www.astm.org/e2807-11r19e01.html (catalogue page, not reachable; accessed 2026-10)
- [R2] libE57Format (BSL-1.0) — https://github.com/asmaloney/libE57Format (sources in the pye57 0.4.19 sdist, accessed 2026-10); test data https://github.com/asmaloney/libE57Format-test-data
- [R3] ASPRS LAS 1.4 R15 — https://github.com/ASPRSorg/LAS, https://lasformat.org (accessed 2026-10)
- [R4] laspy 2.7.0 (BSD-2), lazrs 0.8.2 (MIT) — https://pypi.org/project/laspy/, https://pypi.org/project/lazrs/ ; laz-perf 0.0.7 (Apache-2.0) — https://www.npmjs.com/package/laz-perf (accessed 2026-10; no longer planned, RS1)
- [R5] pye57 0.4.19 (MIT) — https://pypi.org/project/pye57/ (accessed 2026-10)
- [R6] COPC 1.0 — Hobu, Inc. — https://copc.io (accessed 2026-10)
- [R7] Potree / PotreeConverter 2.0 (BSD-2) — https://github.com/potree/PotreeConverter; Schütz, Ohrhallinger, Wimmer, Fast Out-of-Core Octree Generation for Massive Point Clouds, CGF 39(7), 2020
- [R8] Schnabel R., Wahl R., Klein R., Efficient RANSAC for Point-Cloud Shape Detection, CGF 26(2), 2007
- [R9] Besl P. J., McKay N. D., A Method for Registration of 3-D Shapes, IEEE PAMI 14(2), 1992
- [R10] Chen Y., Medioni G., Object modelling by registration of multiple range images, IVC 10(3), 1992; Rusinkiewicz S., Levoy M., Efficient variants of the ICP algorithm, 3DIM 2001; Chetverikov D. et al., The Trimmed ICP algorithm, ICPR 2002
- [R11] Horn B. K. P., Closed-form solution of absolute orientation using unit quaternions, JOSA A 4(4), 1987; Umeyama S., IEEE PAMI 13(4), 1991
- [R12] Lukács G., Martin R., Marshall D., Faithful least-squares fitting of spheres, cylinders, cones and tori, ECCV 1998
- [R13] Lague D., Brodu N., Leroux J., M3C2, ISPRS J. Photogramm. 82, 2013
- [R14] Ericson C., Real-Time Collision Detection, 2005, §5.1.5
- [R15] Kay S. M., Fundamentals of Statistical Signal Processing: Estimation Theory, 1993, ch. 3 (CRLB)
- [R16] Rust crates for `llull-cloud`: `e57` https://crates.io/crates/e57, `las` https://crates.io/crates/las, `laz` (laz-rs) https://crates.io/crates/laz, `rayon`, `memmap2`, `libm`, `wgpu` (versions and licences recorded at M1; RS1 §2 rule 7)
- [R17] RS1 native compute programme — [../../decisions/RS1-native-compute.md](../../decisions/RS1-native-compute.md)
- llull: `.claude/rules/architecture.md`, `docs/aerospace/AGENT_FIRST.md`, paths in §1
