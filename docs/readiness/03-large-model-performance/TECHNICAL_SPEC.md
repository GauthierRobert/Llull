# 03 PRF — Large-model performance and robustness — Technical specification

Status: specification only (2026-10-28, origin/main f1351cff). Functional view: [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md).
Validation: [`validation/README.md`](validation/README.md). Laws: [`../../../.claude/rules/architecture.md`](../../../.claude/rules/architecture.md).
Sources `[Sn]`: [`validation/sources.md`](validation/sources.md). Related: [`../../design/08-assembly-scale/`](../../design/08-assembly-scale/)
(instances, kernel progress / `KRN_TIMEOUT`, `check_assembly` scale, `capture_viewport`), [`../../design/07-mesh-modeling/TECHNICAL_SPEC.md`](../../design/07-mesh-modeling/TECHNICAL_SPEC.md)
§13.5 (mesh asset store, display LOD), [`../../decisions/LIM1-scale.md`](../../decisions/LIM1-scale.md) (glTF indexing, display deflection).

## 1. Current state in llull (code survey, 2026-10-28)

### 1.1 Where the time and bytes go

| Area | Where | Behaviour today | Limit |
| ---- | ----- | --------------- | ----- |
| Document format | `packages/core/src/commands/persistence/serialization.ts:19-52` | one envelope `{format, version: 3, document}` written by `JSON.stringify`, no indentation; derived entities omitted | whole document is one string: V8 caps a string at 2²⁹−24 characters [S25] |
| Mesh in memory | `packages/core/src/model/types.ts:762-765` | `MeshData { positions: number[]; indices: number[] }` | numbers as JSON text on disk |
| Mesh import | `packages/core/src/commands/exchange/importMesh.ts:22-41,84-91` | stores a **world-space triangle soup**: 9 numbers per triangle + indices `0..n-1` (`soupIndices`) | no vertex sharing |
| Step recording | `packages/core/src/commands/execute.ts:79-88` | every mutating command's params are copied into `featureHistory[k].params` | `import_mesh` params hold the whole soup a second time |
| Binary blobs | `types.ts:668-697` (`DocumentBlob`) | sha256-keyed, **base64** text inside the JSON (B-rep, STEP, fonts) | +33 % size, still inside the one string |
| Large-mesh assets (07 MSH) | `server/src/meshAssets/store.ts:1-8`; `packages/core/src/geometry/mesh/assets.ts:12-15` | content-addressed `mesh.bin` (f64 positions, u32 indices) in `~/.llull/cache/mesh` (`LLULL_MESH_CACHE`); above `MESH_INLINE_TRIANGLE_CAP = 100_000` the document keeps a reference plus a `MESH_LOD_TRIANGLES = 50_000` vertex-clustering LOD (`geometry/mesh/lod.ts`) | per-machine cache: the file is not self-contained; only `import_mesh_file` / mesh-engine results use it, not STEP import |
| STEP mesh import | `packages/protocol/src/exchangeTools.ts:308-313`; `server/src/pythonExchange.ts:19,63`; `server/python/llull_bridge.py:89-112,241-262,293` | CadQuery bridge: `BRepMesh_IncrementalMesh(shape, 0.05, False, 0.3, True)` (absolute 0.05 mm, angular 0.3 rad), soup as Python floats, one `json.dumps` response; host caps output at 128 MB, timeout 120 s | defect 2 (≈ 0.8 M triangles), defect 13 (process killed) |
| Exact STEP import | `packages/core/src/commands/exchange/importStepExact.ts` | healed B-rep stored as a base64 blob + display mesh | display mesh from the native deflection below |
| Native display mesh | `solver/crates/llull-kernel-occt/src/mesh.rs:8-11` | `DISPLAY_DEFLECTION = (0.1, 0.5)` absolute mm / rad; retry `(0.02, 0.2)` for open solids | not size-aware (LIM1 "left" item) |
| Limits | `packages/core/src/commands/limits.ts` | `MAX_IMPORT_BODIES = 10_000`, `MAX_IMPORT_TRIANGLES = 2_000_000`, `MAX_IMPORT_BYTES = 256 MiB` | refusals are free text (`import_mesh: … no-op.`), no code |
| Open (desktop) | `desktop/src/documents.ts:65`; `desktop/src/backendEnv.ts:43,65` | main process reads the whole file as UTF-8 and posts it as `load_document {json}` (body limit raised to 512 MB) | three full copies in flight (file string, request body, parsed doc) |
| Live sync | `packages/protocol/src/liveSync.ts:23-43`; `server/src/liveDocument.ts:81-167`; `server/src/liveRoutes.ts:3-6` | SSE `command` events carry the command `params`; a `snapshot` (whole document JSON) is sent on connect, undo, redo and resync; slow subscribers dropped above 8 MB backlog | open / undo / redo cost O(document); `import_mesh` events carry the soup |
| Replay cache | `packages/core/src/commands/history/replayCache.ts:37-44` | LRU of 1,024 document states; memory "grows with steps × entities" | bounded by count, not bytes |
| Kernel cache | `packages/core/src/geometry/shapeKernel.ts:262` | LRU of native shapes (256, LIM1) | — |
| Renderer loop | `src/ui/viewport/3d/Viewport3D.tsx:187-190` | `frameloop="demand"`, `dpr={[1, 2]}`, antialias | good: no idle frames |
| Quality tiers | `src/ui/viewport/3d/useRenderQuality.ts:1-12` | tier by entity count (≤ 50 high, ≤ 200 medium, else low: no PCSS / contact shadows); internal budget "≤ 16 ms median frame at 500 entities on a mid-range laptop GPU" | by count, not by triangles or measured frame time |
| Instancing | `src/ui/viewport/3d/grouping.ts:1-2`, `InstancedRenderer.tsx` | `InstancedMesh` only for `box`, `cylinder`, `sphere` with identical params | imported meshes and B-rep parts: one draw call each |
| Batching | none for 3D (no `BatchedMesh` in `src/ui`); 2D: `BatchedLines2D.tsx` batches unselected `line` entities only | other 2D kinds render per entity | draw calls ∝ entities |
| LOD | `src/ui/viewport/3d/lodSegments.ts` (segment count of analytic primitives by size); 07 MSH document LOD for asset meshes | no screen-space LOD, no LOD chain | full triangles always drawn |
| Picking | `src/ui/viewport/3d/bvhSetup.ts`; `entities/SolidMeshShell.tsx:58-66` | three-mesh-bvh `acceleratedRaycast` + `computeBoundsTree` per geometry on the main thread; InstancedMesh not patched | BVH build cost on open is main-thread |
| Mesh build | `src/ui/viewport/3d/entities/meshSolidGeometry.ts:17-25` | `toCreasedNormals` (30°) on the main thread per mesh | main-thread work ∝ triangles on open |
| Motion degradation | `src/ui/viewport/3d/orbitSettle.ts` exists (settle detection) | not used to lower quality during motion | — |
| Electron | `desktop/package.json:23` (`electron ^38.8.6`); no `--js-flags` / heap switch in `desktop/src` | renderer heap capped at 4 GB by the V8 memory cage (Electron ≥ 21) [S24] | hard ceiling, not configurable by flags [S23][S24] |
| Perf gates | `scripts/scaleGate.mjs` (LIM1: plan time, GLB size); `tests/quality/display.gate.ts:247` records `loadMs`; no frame / pick / heap metric; no baseline | QUALITY_GATES proposed gates 2–3 not built | no regression stop |

### 1.2 Derivation: why 350 bytes per triangle

QUALITY_GATES measured ≈ 350 B/triangle (125k triangles, 44 MB). Re-derived (2026-10-28, Node, random coordinates in
±100 mm, 100,000 triangles):

- `JSON.stringify({bodies:[{positions: soup}]})` (the recorded `import_mesh` step params) = **168.2 B/triangle**
  (9 doubles × ≈ 18.7 characters).
- `JSON.stringify({mesh:{positions: soup, indices: 0..n-1}})` (the entity) = **188.0 B/triangle**.
- Sum **356.2 B/triangle**, matching the measurement within 2 %. The mesh is stored twice, as text, unshared.

Binary indexed storage of the same mesh: a closed triangle mesh has V ≈ T/2 vertices (Euler, genus 0: V − E + F = 2,
E = 3F/2 ⇒ V = F/2 + 2). f64 positions + u32 indices = 0.5 × 24 + 12 = **24 B/triangle** (the 07 asset layout); f32
positions = 0.5 × 12 + 12 = **18 B/triangle**. LIM1 measured **15.9–17.5 B/triangle** for indexed GLB (A). Creased
normals are recomputed, not stored.

### 1.3 Derivation: limits that fail before memory does

- Bridge reply cap 128 MB at ≈ 18.7 characters per double and 9 doubles per triangle ⇒ 128 × 2²⁰ / 168 ≈ **0.80 M
  triangles**, matching defect 2 (≈ 0.8 M).
- One-string document limit 2²⁹ − 24 = 536,870,888 characters [S25] ⇒ at 356 B/triangle **≈ 1.5 M triangles** per
  document before `JSON.stringify` throws, below T2 (5 M).
- `syn-huge-sphere` (R = 10 m) at d = 0.05 mm: sagitta s = ℓ²/(8R) ⇒ edge ℓ = √(8Rd) = √(8 × 10⁴ × 0.05) = 63.2 mm;
  equilateral triangle area (√3/4)ℓ² = 1,732 mm²; sphere area 4πR² = 1.257 × 10⁹ mm² ⇒ **≈ 7.26 × 10⁵ triangles**
  (closed-form estimate, angular limit ignored), i.e. ≈ 122 MB of reply, at the 128 MB cap: consistent with the killed
  bridge.

## 2. Target architecture

| Milestone | Layer | Placement | Laws |
| --------- | ----- | --------- | ---- |
| M0 perf corpus, runner, baselines | `scripts/perf/`, `quality/`, `server/` CLI | runner drives the CLI and (later) the 06 E2E harness; results per machine profile | L6 (host only) |
| M1 binary single-file container, mesh stored once | core `persistence/serialization.ts` (definition JSON), host `server/src/documentContainer/*` (read/write ZIP + blobs), `MeshAssetPort` | core stays pure: it serializes the definition and names blob keys; the host packs bytes | L1, L2, L3, L8 |
| M2 tessellation budget, native binary STEP mesh import | native `llull-kernel` (Rust + C++ facade), `server/src/nativeKernel.ts`, `import_step` tool | tessellation policy in native code; the Python bridge import path retired for meshes (C7, LC1) | L9, C7 |
| M3 progress + cancel | `packages/protocol` (NDJSON progress exists in `liveRoutes.ts:99`), `server/src/commandBus.ts`, ctx | `ctx.signal` (AbortSignal) + `ctx.progress`; cancel route; native jobs honour cancel (08 TR-ASC-04) | L1, L3 (a cancelled command returns the input doc) |
| M4 renderer scaling | `src/ui/viewport/3d/**`, workers in `src/ui/viewport/workers/` | batching, instancing by geometry hash, LOD chain, motion degradation, BVH in worker | L2 (UI only), L7 |
| M5 lazy open, binary transport, O(change) sync | `server/src/assetRoutes.ts` (new), `packages/protocol/src/liveSync.ts`, `src/ui/store` | assets by key over HTTP octet-stream; snapshot carries refs; undo / redo as events | L6 (thin host), L5 |
| M6 memory budgets, large-model mode | core `commands/limits.ts` + estimator in `geometry/`, host memory probe, UI badge | estimate-before-allocate refusals; mode is a view setting (not a document change) | L1, L4 |
| M7 occlusion culling, 2D batching, leak gate, T3 | `src/ui/viewport/**`, perf runner | — | — |

No law changes. Two ports are added for the agent path: `ctx.viewportStats` (desktop host reports frame / pick / memory
statistics to the read-only command `viewport_stats`) and the existing `MeshAssetPort` extended with LOD reads. Absent port
⇒ named refusal, as `ctx.viewportCapture` in 08 ASC.

### Technical requirements

| Id | Pri | Requirement | FR | AF |
| -- | --- | ----------- | -- | -- |
| TR-PRF-01 | MUST | Perf corpus manifest `validation/data/perf_corpus.json` (sources, sha256, licence, tier, persona) + generator specs; `llull perf corpus verify|fetch|generate` | 01 | AF-41 |
| TR-PRF-02 | MUST | Perf runner `scripts/perf/run.mjs`: CLI timings, `viewport_stats` sampling through the 06 harness, 1 warm-up + 5 measured runs, median of per-run p95, results in `.cache/readiness/results/perf/<VC>.json` (VALIDATION.md §4), baselines per machine profile, +20 % rule (§9) | 02–06, 15 | AF-40 |
| TR-PRF-03 | MUST | Document container v4 (§6): ZIP, `document.json` (definition, no geometry payload) + `blobs/<sha256>.<kind>.zst` (meshes, LODs, B-reps, source files, fonts); stored ZIP entries, each blob zstd-compressed [S20]; random access by key; atomic write (temp + rename, with 04 DSF) | 08, 09 | AF-41 |
| TR-PRF-04 | MUST | `MeshData` of every mesh entity is persisted as a blob reference (`MeshRef`, §3); inline numbers are no longer written; display LOD chain stored as blobs | 08 | — |
| TR-PRF-05 | MUST | Large command inputs are recorded by key: `import_mesh`, `import_mesh_file`, `import_step` record `{ asset: <sha256>, name, color }` per body in the `FeatureStep`, never the coordinates (generalises 07's `fileKey`) | 08, 14 | AF-13 |
| TR-PRF-06 | MUST | Self-containment: save copies every referenced asset from the machine cache into the container; open registers container blobs as a read-only `MeshAssetPort` layer above the cache; a missing blob refuses open with `PRF_CONTAINER_BLOB_MISSING` | 09 | AF-11 |
| TR-PRF-07 | MUST | Tessellation policy (§5.1): relative linear deflection, angular deflection, estimate-before-mesh, coarsen-then-refuse, per-body and per-import budgets, `PRF_TESSELLATION_COARSENED` / `PRF_TESSELLATION_BUDGET` with body name; applied to STEP mesh import and to native display meshes | 10 | AF-11, AF-31 |
| TR-PRF-08 | MUST | STEP mesh import through the native `llull-kernel` (XDE names and colours as `import_step_exact`), streaming bodies as binary (f64 positions, u32 indices) into the asset store; no JSON number arrays; progress per body | 11 | AF-40, C7 |
| TR-PRF-09 | MUST | Progress and cancel (§5.4): `ctx.progress({stage, done, total})`, `ctx.signal`; CLI `--progress`, `llull cancel <commandId>`; REST `POST /command/cancel`; open, save, import, export, `check_assembly`, mesh engine jobs and kernel ops honour it; `PRF_CANCELLED` | 12 | AF-40 |
| TR-PRF-10 | MUST | Renderer batching (§5.2): unique parts in `BatchedMesh` per material [S13][S14]; repeated geometry (same blob key or same primitive key) in `InstancedMesh`; draw calls ≤ 200 at T2 | 03 | — |
| TR-PRF-11 | MUST | LOD chain per mesh blob (QEM decimation from `llull-meshops`, or meshoptimizer [S16]), selected by screen-space error (§5.2); motion degradation via `orbitSettle.ts`; small-object culling during motion | 03, 13, 18 | — |
| TR-PRF-12 | MUST | Picking on batches with three-mesh-bvh (`computeBatchedBoundsTree`) built in a worker (`GenerateMeshBVHWorker`), BVH serialized and cached by blob key [S15]; pick latency instrumented | 04 | — |
| TR-PRF-13 | MUST | Geometry decode off the main thread: blob → `Float32Array` / `Uint32Array` in a worker, creased normals in the worker (or native, stored as a blob), transferred as `ArrayBuffer`s | 02, 03 | — |
| TR-PRF-14 | MUST | Progressive open (§5.3): `document.json` → coarsest LOD of every part → first frame → finer LODs by screen importance → full res; `data.timings.firstFrameMs/fullResMs` | 02 | AF-40 |
| TR-PRF-15 | SHOULD | Asset transport `GET /assets/:key?lod=n` (octet-stream, loopback, same auth as `/command`); live `snapshot` carries `MeshRef`s only; undo / redo broadcast as `history` events re-applied by clients from their local history (with 04 DSF), snapshot only on hash mismatch | 05, 14 | — |
| TR-PRF-16 | MUST | Memory estimator (§5.5) before every import / open / mesh job; `PRF_MEMORY_BUDGET` refusal; renderer heap and process RSS reported by `viewport_stats`; no `--js-flags` heap change (the 4 GB cage is the ceiling [S24]) | 07, 19 | AF-11 |
| TR-PRF-17 | MUST | Coded limits: every limit in `commands/limits.ts` refuses with `PRF_LIMIT_<NAME>` (`data: {limit, requested, cure}`); serialization guards the 2²⁹−24 string limit with `PRF_DOCUMENT_TOO_LARGE` (cannot trigger once TR-PRF-03 lands; kept as a guard) | 19 | AF-11 |
| TR-PRF-18 | MUST | Timings: `CommandResult.data.timings` (`totalMs`, `kernelMs`, `serializeMs` …) when `--timings` / `timings: true`; `viewport_stats` query (`frameMs` histogram, `drawCalls`, `triangles`, `geometries`, `heapUsedBytes`, `pickMs`); `llull perf report` | 16 | AF-10, AF-11 |
| TR-PRF-19 | SHOULD | Replay cache bounded by estimated bytes (default 25 % of the heap budget) as well as count | 07 | — |
| TR-PRF-20 | SHOULD | 2D: every 2D kind batched into `LineSegments` / `LineSegments2` per (layer, style); text glyphs instanced | 17 | — |
| TR-PRF-21 | SHOULD | Large-model mode: view setting (`useViewportStore`), auto-on above the T1 limits, badge, override; sets quality tier `low`, motion degradation on, LOD bias +1 | 18 | — |
| TR-PRF-22 | SHOULD | Leak check: `viewport_stats.geometries` and heap after open / close × 5 | 20 | — |
| TR-PRF-23 | COULD | Occlusion culling with WebGL2 occlusion queries (`ANY_SAMPLES_PASSED_CONSERVATIVE`, asynchronous) on batch bounding boxes [S26] | 03 | — |

## 3. Data model

```ts
// packages/core/src/model/types.ts — mesh payload by reference (v4)
interface MeshRef {
  readonly asset: string;                 // sha256 of the canonical full-resolution bytes (07 store layout)
  readonly triangles: number;
  readonly vertices: number;
  readonly bounds: { min: Vec3; max: Vec3 };
  readonly lods: readonly { asset: string; triangles: number; geometricError: number }[]; // coarsest last; error in document units
}
// MeshSolidEntity.mesh becomes MeshData | MeshRef. In memory a MeshRef resolves through MeshAssetPort.readMesh (full res, for
// commands) or readLod (display). Small meshes (≤ MESH_INLINE_TRIANGLE_CAP) may stay MeshData in memory; on disk they are blobs too.

// FeatureStep params of mesh-creating imports (TR-PRF-05)
interface RecordedMeshBody { asset: string; name?: string; color?: string }

// Tessellation request (import_step, native display)
interface TessellationPolicy {
  relative: number;                       // linear deflection / body bbox diagonal; named default §5.1
  absoluteMinMm: number;                  // floor (never below shape tolerance)
  angularRad: number;
  maxTrianglesPerBody: number;
  maxTrianglesPerImport: number;          // ≤ MAX_IMPORT_TRIANGLES
  onBudget: 'coarsen' | 'refuse';
}
```

Document version **4** (container). Version 3 `.llull.json` reading: decision Q3 (§11). The definition JSON keeps every
other field unchanged.

## 4. Commands and surfaces

| Command / tool | Kind | Change | Annotations |
| -------------- | ---- | ------ | ----------- |
| `import_step` (CLI tool, `@protocol/exchangeTools`) | mutating via `import_mesh` | new `tessellation?: Partial<TessellationPolicy>`; native path; records asset keys | `@failure PRF_TESSELLATION_BUDGET, PRF_LIMIT_IMPORT_TRIANGLES, PRF_MEMORY_BUDGET, PRF_CANCELLED` |
| `import_mesh` | mutating | accepts `{ asset }` bodies (preferred) or inline numbers (small, agent use); records keys | `@invariant step params never hold > MESH_INLINE_TRIANGLE_CAP triangles of coordinates` |
| `load_document` / `save_document` (host) | session | container v4; progress; cancel | `@failure PRF_CONTAINER_BLOB_MISSING, PRF_CONTAINER_CORRUPT (sha mismatch; owned by 04 DSF), PRF_CANCELLED` |
| `viewport_stats` | query, toolset `core` | `{ reset?: boolean, sampleMs?: number }` → frame / pick / memory statistics | needs `ctx.viewportStats`; else `VIEWPORT_UNAVAILABLE` (08 code) |
| `set_large_model_mode` | session (view) | `{ mode: 'auto' \| 'on' \| 'off' }` | not a document change (L4: view state) |
| `cancel_command` (REST `POST /command/cancel`, CLI `llull cancel`) | host verb | `{ commandId }` | idempotent; unknown id → `PRF_CANCEL_UNKNOWN` (info) |
| `llull perf run|report|corpus` | CLI (host) | runner front-end (§9) | — |

## 5. Algorithms

### 5.1 Tessellation policy (TR-PRF-07)

1. `D` = diagonal of the body's optimal bounding box (08 TR-ASC-15 path). Linear deflection
   `d = max(relative × D, absoluteMinMm, shapeTolerance)`; angular `a = angularRad`. OCCT: `IMeshTools_Parameters`
   `{Deflection: d, Angle: a, Relative: false, InParallel: true}` (we compute the relative value ourselves so it is
   reported) [S21][S22].
2. **Estimate before meshing.** For each face, `N_f ≈ A_f / ((√3/4) · ℓ_f²)` with `ℓ_f = min(√(8 · R_f · d), ℓ_ang)`,
   `R_f` the minimum radius of curvature sampled on the face (planar faces: boundary triangulation only, `N_f ≈ V_boundary`),
   `ℓ_ang = 2 R_f sin(a/2)`. Derivation of the sagitta form in §1.3. Calibration factor `k` measured on the corpus
   (`TBD — measure with the perf runner, VC-PRF-21 / 22`: ratio actual / estimate per face type).
3. If `Σ N_f > maxTrianglesPerBody`: `coarsen` multiplies `d` by `(Σ N_f / budget)` (N ∝ 1/d from the area formula) and
   re-estimates, at most 3 times, then meshes and emits `PRF_TESSELLATION_COARSENED {body, dRequested, dUsed, triangles}`;
   `refuse` (or still over budget after 3 steps) emits `PRF_TESSELLATION_BUDGET {body, estimate, budget, cure}` and skips
   the body (import continues; the summary lists it). The import total is checked the same way against
   `maxTrianglesPerImport`.
4. Meshing runs in the native sidecar with progress and user break (08 TR-ASC-04). The sidecar never exceeds its memory
   estimate: it streams each body's buffers to the asset store as soon as the body is meshed.
5. **Named defaults (to calibrate, AF-31).** Start values: `relative` from LIM1's proposal `max(0.1, 1e-4 × D)` reproduced
   as `relative = 1e-4, absoluteMinMm = 0.1` for native display meshes (LIM1); for STEP import `absoluteMinMm` 0.05 (today's
   bridge value) and `relative` `TBD — calibrate so that every QUALITY_GATES volume (1.5 %) and bounding-box (0.5 %) check
   stays green on the corpus (VC-PRF-21)`; `angularRad 0.5` (current native display value; OCCT examples [S21]);
   `maxTrianglesPerBody` and `maxTrianglesPerImport` `TBD — measure` with defaults no higher than `MAX_IMPORT_TRIANGLES`
   (2,000,000).

### 5.2 Renderer scaling (TR-PRF-10..13, 21, 23)

- **Grouping key.** `(geometry key, material key)`: geometry key = blob sha256 for meshes, today's `entityRenderKey` for
  primitives. Count ≥ 2 → `InstancedMesh` (matrices via `setMatrixAt`) [S14]; count 1 → appended to the `BatchedMesh` of
  its material (`addGeometry` / `addInstance`, `perObjectFrustumCulled` and `sortObjects` default `true`, multi-draw
  path [S13]). Patterns from 08 ASC instance sets use the same path.
- **Selection / ghost / tint.** Per-instance colour (`setColorAt`) and visibility instead of per-mesh materials;
  selected items are drawn a second time in an overlay pass (outline), not removed from the batch.
- **LOD chain.** For each mesh blob: levels at about ¼ of the previous triangle count down to ≤ 1 % or ≤ 64 triangles,
  each with its geometric error (Hausdorff bound from the decimator, 07 MSH `measure_deviation`). Selection per object per
  frame: projected error `ε_px = e · H_px / (2 · z · tan(fov/2))` (perspective; ortho: `e · H_px / viewHeight`), choose
  the coarsest level with `ε_px ≤ τ`. `τ` named default `TBD — tune` (1 px start value: below one pixel the change is not
  visible; choice). BatchedMesh holds all levels as geometries and switches the instance's geometry id.
- **Motion degradation.** While the camera moves (`orbitSettle.ts`): LOD bias +1, objects with projected bounding-sphere
  diameter < 2 px skipped, shadows off; full quality on settle. Precedents: Navisworks Guarantee Frame Rate [S9],
  AutoCAD adaptive degradation [S11]. The "Simplified display" badge shows whenever any object is below full res.
- **Occlusion (COULD).** Batch-level boxes queried with `ANY_SAMPLES_PASSED_CONSERVATIVE`, results used one frame late
  (asynchronous) [S26].

### 5.3 Progressive open (TR-PRF-14)

1. Host opens the ZIP, reads `document.json` (definition only) and validates it (`load_document`). Live snapshot to the
   renderer: definition + `MeshRef`s.
2. Renderer requests the **coarsest LOD** of every visible part (`GET /assets/:key?lod=last`) in screen-importance order
   (projected size in the initial framing), decodes in workers, builds batches → **first frame** (`firstFrameMs`).
3. Finer levels stream while idle (chunks ≤ 50 ms of main-thread work each [S1]); `fullResMs` when the selected LODs of
   the settled view are all loaded. Orbit and pick work throughout; picking uses the loaded level, then refines the hit on
   the full-res BVH when it is ready.
4. Commands that need full resolution read it through `MeshAssetPort.readMesh` on the host, never through the renderer.

### 5.4 Progress and cancel (TR-PRF-09)

`ExecutionContext` gains `progress?: (e) => void` and `signal?: AbortSignal`. Pure commands poll `signal.aborted` between
units of work and return `noop(doc, 'PRF_CANCELLED …')`: the input document is returned unchanged (L3). Host work (file
read / write, native jobs) wires the same signal; native kernel and mesh jobs map it to their cancel message (08
TR-ASC-04, 07 MSH `MESH_TIMEOUT` machinery). Progress cadence: at least one event per second during any operation over
1 s (FR-PRF-12); `{stage, done, total}` so the UI shows percent done [S2].

### 5.5 Memory estimate (TR-PRF-16)

Bytes per displayed triangle per copy: f64 indexed in core ≈ 24 B (§1.2) plus JS array overhead; f32 GPU / renderer
buffers ≈ 18 B plus normals (non-indexed creased normals worst case 3 vertices × 12 B). Estimator = Σ over copies
(host document, renderer document, renderer buffers, BVH) × triangles, with the per-copy constants `TBD — measure with
viewport_stats` (VC-PRF-14, 15). Refuse when `current + estimate > budget` (§8). The renderer budget is checked against the
4 GB cage [S24], the process budget against `office-min` RAM.

## 6. Interop and persistence

- **`.llull` container (v4).** ZIP with stored (uncompressed) entries so the central directory gives random access:
  `document.json` (UTF-8, the v4 envelope without geometry payloads), `blobs/<sha256>.mesh.zst` (07 canonical `mesh.bin`:
  u32 vertex count, u32 triangle count, f64 positions, u32 indices), `blobs/<sha256>.lod.zst` (f32 positions, u32
  indices), `blobs/<sha256>.brep.zst`, `blobs/<sha256>.src.zst` (source STEP / STL kept for re-import), fonts. Each blob
  is zstd-compressed [S20]; the key is the sha256 of the **uncompressed** bytes, checked on read (`PRF_CONTAINER_CORRUPT`,
  shared with 04 DSF). Save rewrites `document.json` and appends only new blobs (unchanged blobs copied raw), which is
  what makes T2 save ≤ 5 s possible.
- **Machine cache.** `~/.llull/cache/mesh` (07) stays as a cache, never the only copy.
- **Exports.** Unchanged; glTF export already indexes and reuses meshes (LIM1); `EXT_meshopt_compression` [S17] is a
  COULD for export size, not for the document.
- **Why not glTF as the document.** A `.llull` document is a recipe (L8) with ~30 model slices; glTF/GLB [S19] has no
  place for them. GLB's idea (one JSON + binary chunks) is reused; the ZIP adds random access and per-blob compression.

## 7. Surfaces and stable error codes

| Code | Kind | Raised by | Meaning / cure |
| ---- | ---- | --------- | -------------- |
| `PRF_TESSELLATION_COARSENED` | warn | import_step, native display mesh | body meshed coarser than requested; `{body, dRequested, dUsed, triangles}` |
| `PRF_TESSELLATION_BUDGET` | refusal (per body) | same | body over budget at the coarsest allowed deflection; cure: raise `maxTrianglesPerBody`, use `import_step_exact` |
| `PRF_LIMIT_IMPORT_TRIANGLES` / `PRF_LIMIT_IMPORT_BODIES` / `PRF_LIMIT_IMPORT_BYTES` (and one per `limits.ts` constant) | refusal | import commands | limit, requested, cure |
| `PRF_MEMORY_BUDGET` | refusal | import, open, mesh jobs | estimate exceeds the budget; `{estimateBytes, availableBytes, process}` |
| `PRF_DOCUMENT_TOO_LARGE` | refusal | serialization guard | a single serialized part would exceed the V8 string limit [S25] |
| `PRF_CANCELLED` | refusal | any cancellable operation | cancelled by the user / agent; document unchanged |
| `PRF_CANCEL_UNKNOWN` | info | cancel verb | no running command with that id |
| `PRF_CONTAINER_BLOB_MISSING` / `PRF_CONTAINER_CORRUPT` | refusal | open | a referenced blob is absent / its sha256 differs |
| `PRF_DISPLAY_SIMPLIFIED` | info (UI + `viewport_stats`) | renderer | some objects drawn below full resolution |
| `PRF_LARGE_MODEL_MODE` | info | renderer | large-model mode active (auto or forced) |
| `PRF_BASELINE_REGRESSION` | gate finding | perf runner | metric > 1.20 × baseline on this profile |
| `PRF_BUDGET_EXCEEDED` | gate finding | perf runner | metric over its absolute budget |

CLI: `--progress`, `--timings`, `llull cancel`, `llull perf …`. UI: loading indicator with Cancel, "Simplified display" and
"Large model" badges, import dialog quality + estimate. Agent-first: every code above is in `data.code` (AF-11).

## 8. Performance and robustness budgets

### 8.1 Machine profiles

`ref-win11` (baselines, owner workstation): Intel Core Ultra 9 185H (16 cores / 22 threads), 31.4 GB RAM, NVIDIA GeForce
RTX 4080 Laptop GPU + Intel Arc iGPU, Windows 11 Home 10.0.26200 (read 2026-10-28 with `Get-CimInstance`; the reported
GPU memory is capped by WMI and not recorded).

**`office-min` — proposed minimum supported engineering PC (budgets gate here; copy to `readiness_gate.json`):**

| Item | Proposed minimum | Basis |
| ---- | ---------------- | ----- |
| OS | Windows 11 64-bit | product target (desktop app); 05 INS owns the exact build floor |
| RAM | 16 GB | SOLIDWORKS minimum 16 GB (resellers agree, B) [S7]; Inventor recommends ≥ 24 GB for > 1,000 unique parts (A) [S4]: llull's T2 process budget (8 GB) is set so that 16 GB suffices |
| GPU | D3D11-capable (Chromium ANGLE / WebGL2), ≥ 4 GB video memory, vendor driver ≤ 12 months old | Inventor: DirectX 11 card with at least 4 GB video RAM (A) [S4] |
| Storage | SSD, ≥ 20 GB free | Inventor: SSDs reduce open / save time of large assemblies (A) [S4]; free space: choice (container + cache + autosave) |
| CPU | x86-64, 4 physical cores / 8 threads | choice (owner question Q2); OCCT edge discretization and mesh jobs run in parallel [S21]; 05 INS sets the instruction-set floor |
| Display | 1920 × 1080 at 100 % scaling; the perf viewport is measured at a fixed 1600 × 900 canvas | choice, so frame budgets are comparable across machines |

A budget measured on another machine is reported, never used to pass a case (VALIDATION.md §8).

### 8.2 Budgets (office-min; T3 reported on `ref-win11`)

| Metric | T1 | T2 | T3 (report) | Derivation |
| ------ | -- | -- | ----------- | ---------- |
| Open → first navigable frame | ≤ 2 s | ≤ 5 s | ≤ 10 s | RAIL: interactive < 5 s, repeat load < 2 s [S1]; Nielsen 10 s [S2] |
| Open → full resolution (settled view) | ≤ 5 s | ≤ 10 s | TBD — measure | RAIL load [S1]; Nielsen 10 s [S2]; progress + cancel mandatory beyond 1 s / 10 s |
| Orbit frame time p95 | ≤ 16.7 ms | ≤ 33.3 ms | ≤ 33.3 ms | 60 fps = 1000/60 [S1]; 30 fps = 1000/30, the "> 30 fps" large-assembly target [S8] |
| Draw calls (settled, shaded) | TBD — measure | ≤ 200 | TBD | same budget as 08 VC-ASC-08 |
| Pick → highlighted frame p95 | ≤ 100 ms | ≤ 100 ms | ≤ 100 ms | RAIL response 100 ms; input handling 50 ms [S1] |
| Local edit → repaint p95 | ≤ 100 ms | ≤ 100 ms | ≤ 1 s | RAIL response [S1]; Nielsen 1 s [S2] |
| Explicit save | ≤ 1 s | ≤ 5 s | ≤ 10 s | Nielsen 1 s / 10 s [S2]; T2: RAIL load bound reused (choice) |
| Longest main-thread task during autosave / save | ≤ 50 ms | ≤ 50 ms | ≤ 50 ms | RAIL idle chunks 50 ms [S1] |
| Renderer V8 heap after open | TBD — measure | ≤ 2 GB | ≤ 3 GB | half of the 4 GB cage for transient copies (undo, replay) [S24]; derivation choice |
| All llull processes RSS | TBD — measure | ≤ 8 GB | ≤ 16 GB | half of `office-min` RAM (16 GB); T3 on a 32 GB workstation |
| Document bytes per displayed triangle (before zstd) | ≤ 32 | ≤ 32 | ≤ 32 | f64 indexed 24 B + f32 LOD chain (geometric ¼ series ≤ ⅓ × 18 B = 6 B) = 30 B (§1.2) |
| STEP mesh import `part-11752` (125k tri) | ≤ 5 s | — | — | baseline 12–21 s (A); T1 open budget reused |
| STEP mesh import `rc-buggy-suspension` (211 parts, 1.2 M tri) | — | succeeds; time TBD — measure | — | baseline: fails (defect 2) |
| Leak (open / close × 5) | geometries and heap ± 5 % | same | — | QUALITY_GATES proposed gate 3; tolerance choice |
| Regression | ≤ 1.20 × baseline per metric | same | same | readiness_gate.json `regression.budgetWorseningPercent` |

Robustness: no process killed by input size; every limit coded (TR-PRF-17); a cancelled or refused command leaves the
document unchanged (L3).

## 9. Test strategy and perf runner

| Level | What | VC |
| ----- | ---- | -- |
| unit (`tests/unit`) | corpus manifest, step params by key, coded limits, tessellation estimator vs closed form, memory refusal under an injected budget, cancel returns the input doc, LOD invariance of measurement / export, gate arithmetic (+20 %) | 01, 16, 18, 22, 25, 28, 32 |
| cli (`server/tests` + CLI scripts on the corpus) | container bytes per triangle, self-contained open, native STEP mesh import (coarsening, volume, large files, progress), cancel, live-sync bytes on undo / redo, `--timings` | 17, 19, 20, 21, 23, 24, 27, 29 |
| perf (perf runner on `office-min`, baselines on `ref-win11`) | open, orbit, pick, edit, save, heap, RSS, 2D pan | 02–07, 09–12, 14, 15, 30 |
| electron (06 E2E harness, reference only) | draw calls, autosave long tasks, simplified-display badge, large-model mode, leak | 08, 13, 26, 31, 33 |

**Perf runner (`scripts/perf/run.mjs`, driver `perf`).**

1. Takes the heavy lock (`scripts/heavyLock.mjs`); refuses to run if another heavy job holds it. Records machine profile
   id, CPU / RAM / GPU, commit, build (dev / packaged).
2. Per (model, metric): one warm-up run (discarded), five measured runs. CLI metrics from `--timings`; viewport metrics
   from `viewport_stats` sampled while the 06 harness plays a scripted camera path (one 360° orbit about the model's
   bounding-sphere centre in 10 s with continuous invalidation, ≥ 600 frames) and a scripted pick list (200 picks at
   pre-computed screen positions of part centroids).
3. Statistic: p95 within a run; median across the five runs. Coefficient of variation across runs > 10 % ⇒ re-run up to
   twice, then the case is `fail` with note `noisy` (fail-closed).
4. Verdict: `fail` if `median > budget` (`PRF_BUDGET_EXCEEDED`) or `median > 1.20 × baseline` (`PRF_BASELINE_REGRESSION`)
   on the same profile. Baselines are stored per profile in `.cache/readiness/perf-baselines/<profile>.json` and promoted
   only by an explicit `llull perf baseline --accept` with a recorded reason (improvements ratchet down automatically).
5. Writes one result per VC (VALIDATION.md §4) plus artefacts (raw samples CSV, sha256).

## 10. Delivery plan

| Milestone | Content | Depends on | Effort (agent-days) |
| --------- | ------- | ---------- | ------------------- |
| M0 | perf corpus manifest + generators, runner (CLI metrics), `--timings`, baselines on `ref-win11` | — | 3 |
| M1 | container v4, `MeshRef`, blobs, step params by key, self-contained save / open, coded limits | 04 DSF atomic save / integrity | 6 |
| M2 | tessellation policy + estimator, native binary STEP mesh import, retire bridge import path | 08 TR-ASC-04 (native progress / cancel) | 5 |
| M3 | progress + cancel in ctx, host, CLI, UI | 08 M1a | 3 |
| M4 | batching, geometry-hash instancing, LOD chain + selection, motion degradation, worker decode, BVH in worker | M1 (blob keys), 08 M2 (instance sets) | 8 |
| M5 | progressive open, asset routes, O(change) live sync and undo events | M1, M4; 04 DSF undo model | 5 |
| M6 | memory estimator + refusals, `viewport_stats`, large-model mode | M4 | 3 |
| M7 | occlusion culling, 2D batching of every kind, leak gate, T3 budgets on a workstation profile | M4, 06 E2E | 4 |

Total ≈ 37 agent-days. Order: M0 → M1 → M2 → M3 → M4 → M5 → M6 → M7. Viewport metrics (VC-PRF-02..10, 13, 14, 26, 30,
31, 33) cannot run before the 06 E2E harness (M-G3 of VALIDATION.md); until then they are `skipped` and block PRL 2.

## 11. Open questions and proposed decisions

| # | Question | Proposed |
| - | -------- | -------- |
| Q1 | Are the tier sizes (T1 500 parts / 1 M triangles / 20k 2D entities; T2 2,500 / 5 M / 100k) right for the target customers? | adopt as spec budgets now; re-check against the first pilot models (01 PIL) and adjust once |
| Q2 | `office-min` hardware (16 GB, 4 GB VRAM, 4C/8T, SSD): buy or rent one reference machine of that profile? | yes, buy one fixed machine (budget gates need a stable machine); until then `office-min` cases stay `skipped` |
| Q3 | Container v4 replaces `.llull.json`. Keep reading v3? | owner rule says no backward compatibility; propose a one-shot `llull migrate <file>` converter shipped for one release, then removed, so users' existing files are not lost |
| Q4 | Full-resolution positions: f64 (07 asset layout, exact for mesh engines) or f32 (half the bytes)? | f64 for full res (engines are bit-exact on f64), f32 for LODs only; budget 32 B/triangle holds |
| Q5 | Should STEP mesh import move fully to the native kernel and drop the Python bridge path? | yes (C7, LC1 native direction); Python stays only for CadQuery code import / STEP export until 05 INS removes that dependency |
| Q6 | Single-file ZIP container vs folder-per-document | ZIP: one file to e-mail (US-7), random access, inspectable |

## 12. References

[S1]–[S28] as in [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md) §11; grades and extracts in
[`validation/sources.md`](validation/sources.md). Internal: QUALITY_GATES defects 2 and 13 and proposed gates 2–3; LIM1;
07 MSH §13.5; 08 ASC TR-ASC-04, TR-ASC-06, VC-ASC-08.
