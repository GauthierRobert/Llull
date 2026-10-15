# KRN — Exact B-rep kernel as the production basis — Technical specification

Gap id **KRN** · status: specification (no implementation) · written 2026-10-15 ·
functional counterpart: [FUNCTIONAL_SPEC.md](FUNCTIONAL_SPEC.md) · validation: [validation/README.md](validation/README.md)

Requirement ids `TR-KRN-nn` are grouped by decade: 0x kernel selection & build, 1x tolerance policy & booleans,
2x STEP → exact B-rep & healing, 3x persistent naming, 4x mass properties, 5x validity, 6x determinism,
7x large assemblies & display, 8x export.

## 1. Current state in llull

| Area | Where | Behaviour today | Limit for aerospace |
| ---- | ----- | --------------- | ------------------- |
| Kernel interface | `packages/core/src/geometry/kernel.ts` | `GeometryKernel` = `supports`, `evaluate(recipe) → ShapeHandle`, `tessellate`, `topology`, `exportStep`; synchronous; null = no-op | no import of external exact shapes, no validity / mass-property / history API |
| Recipe | `packages/core/src/geometry/shapeRecipe.ts`, `model/types.ts` (`ShapeRecipe`) | leaves `solid` (llull entity); nodes `boolean`, `fillet`, `chamfer`, `blend`, `shell`, `place`, `scale`; `recipeKey` content hash | no leaf for an imported B-rep; booleans have no tolerance option |
| Kernel choice | `packages/core/src/geometry/kernelChoice.ts`; `src/main.tsx`; `server/src/geometryKernel.ts` | `parseKernelChoice` → `'manifold'` unless `occt`; browser `?kernel=occt`; server `LLULL_KERNEL=occt` (falls back to Manifold) | Manifold is the default everywhere |
| Desktop | `desktop/src/backendEnv.ts` | passes `LLULL_PYTHON`, token, body limit …; strips inherited `LLULL_*`; sets **no** `LLULL_KERNEL` | desktop runs Manifold |
| OCC implementation | `packages/kernel-occt/src/occtKernel.ts` (+ `occtShapes`, `occtTopology`, `occtMesh`, `occtStep`, `occtCurves`, `occtPatches`, `tangentGuard`) | opencascade.js **1.1.1 = OCCT 7.4.0p1** [R11][R12]; no C++ exception support (`___cxa_*` ReferenceError classification); BRepCheck only after fillets (`validOrNull`); `ShapeUpgrade_UnifySameDomain` after booleans; display deflection 0.1 mm / 0.5 rad; tessellation in world space; STEP writer to fixed `/out.step` path | 6-year-old OCCT; no fuzzy/glue; no history; world-space meshes |
| Isolation | `server/src/isolatedKernel.ts`, `occtWorker.ts`, `geometryKernel.ts` (timeout) | OCC in a Node worker thread behind a synchronous call (`Atomics.wait`), timeout `LLULL_OCC_TIMEOUT_MS` (30 s), recycle on degrading failure | browser OCC (`src/ui/geometry/occtKernelBrowser.ts`) runs on the UI thread |
| STEP import | `packages/mcp/src/exchangeTools.ts` (`import_step`), `server/python/llull_bridge.py` (`op_import_step`) | CadQuery reads STEP (assembly walk, names, colours) and **tessellates** (tolerance 0.05) → `import_mesh` | imported parts are meshes: not editable as B-rep, faceted mass properties |
| Topology / naming | `packages/core/src/commands/brep/topology.ts` (`inspect_topology`), `brep/modify3d.ts` (`fillet_edge`, `chamfer_edge`) | edges by kernel index or `edgesNear` points re-resolved on replay to the nearest roundable edge mid point (KI5; `server/tests/occtParametricEdges.test.ts`) | heuristic: wrong edge possible after large moves; faces have no names |
| Mass properties | `packages/core/src/commands/inspect/measureSolid.ts`, `solidVolume.ts` | volume (`exact` via `topology().volume` under OCC, else closed form or display-mesh sum) and mass; instances summed | no area, centroid, inertia; no accuracy statement |
| Validity | `packages/core/src/commands/inspect/checkModel.ts` | parameter / structural lint (degenerate sizes, …) | no B-rep check |
| Viewport | `src/ui/viewport/3d/Viewport3D.tsx`, `InstancedRenderer.tsx` | perspective camera near 0.01 / far 1e8; InstancedMesh batches for box / cylinder / sphere only | depth range 1e10; no instancing of kernel results; no LOD |
| Python | `server/python/requirements.txt` (`cadquery>=2.4`), desktop bundles CadQuery (KI6) | CadQuery 2.8.0 pins `cadquery-ocp >=7.9.3.1,<8.0` [R13] | two OCCT versions in one product (7.4 WASM vs 7.9 native) |
| Quality | `quality/corpus.json`, `quality/step_reference.py`, `quality/synthetic_step.py`, `docs/QUALITY_GATES.md` | 32 STEP cases with independent OCCT reference and analytic synthetic cases; mesh import path | no exact-import, no kernel regression gate |

## 2. Target architecture

```
                       src/ui (viewport: RTC rendering, LOD, instancing)         llull CLI / MCP
                                   │ dispatch                                         │
                                   ▼                                                  ▼
            ┌──────────────── packages/core/src/commands ─────────────────────────────────────┐
            │ brep/: import_step_brep · heal_shape · validate_shape · boolean(+fuzzy) ·        │
            │        fillet_edge/chamfer_edge(+edgeNames) · inspect_topology(+names)           │
            │ inspect/: mass_properties(+centroid, inertia, principal) · kernel_info           │
            │ document/: set_modeling_tolerance        exchange/: export_step_exact(+GVP)       │
            └───────────────┬───────────────────────────────────────────────────────────────────┘
                            │ ctx.kernel (GeometryKernel, synchronous; requiresKernel)
            ┌───────────────▼───────────────────────────┐
            │ core/geometry: ShapeRecipe (+brep leaf,   │   shapeKernel.ts: recipe cache, naming map,
            │ +heal node, boolean.fuzzy), kernel.ts     │   provenance
            └───────────────┬───────────────────────────┘
                            │ KernelOps<S>
    ┌───────────────────────┴───────────────────────┐
    │ packages/kernel-occt (OCCT 7.9.x WASM build)   │  server: worker thread (isolatedKernel)
    │ import/heal/check/gprop/history                │  desktop: same server bundle, LLULL_KERNEL=occt
    └────────────────────────────────────────────────┘  browser-only: Web Worker proxy (V1)
```

Laws respected:

- **L1/L5** — every capability is a `defineCommand` in a core feature catalog (`commands/brep`, `commands/inspect`,
  `commands/document`, `commands/exchange`) → UI button + MCP tool + CLI verb from one registration.
- **L2** — no DOM / fetch in `packages/*`: file bytes reach `import_step_brep` as a parameter (base64) or as a
  content-addressed blob id already in the document; reading the file from disk stays in `server/`
  (exchange directory) and in `src/ui` (file picker), as today for `import_step`.
- **L3/L8** — commands stay pure; an imported shape becomes a recipe leaf holding the **healed B-rep bytes**
  (content-addressed), so replay re-creates the identical shape without re-running the STEP reader.
- **L9** — the kernel is reached only through `ctx.kernel`; new kernel capabilities are optional methods on
  `GeometryKernel` (`importShapes`, `validate`, `massProperties`, …) returning null under Manifold.
- **L10** — nothing aerospace-specific in core: KRN is generic exact-modelling infrastructure; aerospace
  conventions (body-station axes, weights reports) belong to later plugins.

### 2.1 Kernel selection & build

- **TR-KRN-01 (MUST, MVP)** `desktop/src/backendEnv.ts` sets `LLULL_KERNEL: 'occt'` (overridable by an explicit
  user setting `LLULL_KERNEL=manifold` for diagnostics). `server/src/geometryKernel.ts` already falls back to
  Manifold with a warning; the fallback reason is exposed through `kernel_info` and a UI status badge
  (`useKernelStatusStore`). `desktop/tests` asserts the active kernel.
- **TR-KRN-02 (MUST, MVP)** Replace `opencascade.js@1.1.1` (OCCT 7.4.0p1, 2020) by a **pinned OCCT 7.9.x build**:
  Emscripten build with WebAssembly exception handling (`-fwasm-exceptions`) so OCC `Standard_Failure` is
  catchable (removes the `___cxa_*` degraded-module class in `occtKernel.ts`), including the toolkits
  TKBO/TKBool/TKFillet/TKOffset/TKShHealing/TKXSBase/TKDESTEP (STEP)/TKXCAF/TKMesh and TKTopAlgo
  (which holds `BRepCheck` and `BRepGProp` [R33]). The binding layer keeps `KernelOps<OccShape>`; `occtTypes.ts` is
  regenerated. Size / init time / op latency are measured against KI4's baseline (63 MB, 0.8-1 s, 150-180 ms) and
  recorded in a new decision record (KI7).
- **TR-KRN-03 (SHOULD, V1)** Browser-only (web app without backend): OCC in a dedicated Web Worker. Because the
  `GeometryKernel` contract is synchronous and `Atomics.wait` cannot be used on the browser main thread [R32], the
  browser path executes **whole commands** in the worker (worker hosts `execute` + kernel; the main thread
  receives `CommandResult`) — the same split the desktop already has between renderer and backend (L6).
- **TR-KRN-04 (MUST, MVP)** `kernel_info` read-only command: `{ active: 'occt'|'manifold', occtVersion?, build?,
  wasmBytes?, capabilities: string[], modelingTolerance, isolation: 'worker'|'in-process', fallbackReason? }`.
- **TR-KRN-05 (SHOULD, V1)** Evaluate a **native OCCT** backend for the desktop through the bundled CPython + OCP
  (same OCCT 7.9.3 as CadQuery): a `KernelOps` implementation in a child process behind the existing
  synchronous worker proxy. Decision criterion: ≥ 2× faster on the KRN corpus and identical results within
  VC tolerances (open question Q1).

## 3. Data model

```ts
// packages/core/src/model/types.ts (sketch)

/** Kernel provenance and modelling tolerance; absent on old documents (migration fills defaults). */
export interface DocumentKernelSettings {
  readonly kernel: 'occt' | 'manifold';
  readonly occtVersion?: string;          // e.g. "7.9.3"
  readonly build?: string;                // sha256 of the kernel binary
  readonly modelingTolerance: {
    readonly linear: number;              // mm; default 1e-4 (heal / sew / import precision), range [1e-7, 1e-2]
    readonly angular: number;             // rad; default 1e-9 (> Precision::Angular 1e-12)
    readonly maxImportTolerance: number;  // mm; warn above, default 0.01
  };
}

/** Content-addressed binary payload (healed B-rep, original STEP). */
export interface DocumentBlob {
  readonly sha256: string;
  readonly mediaType: 'model/x-occt-brep' | 'model/step';
  readonly bytes: string;                 // base64; large blobs may live in a sidecar file (§6)
  readonly size: number;
}

export interface CadDocument {
  // ... existing fields ...
  kernelSettings?: DocumentKernelSettings;
  blobs?: Record<string, DocumentBlob>;   // keyed by sha256
}

/** Persistent topological name (§5.3), e.g. "F[s4:FLT]<E[s3:CUT]<F[s2:box:+X];:M>,F[s3:box:-Y];:M>>". */
export type TopoName = string & { readonly __topoName: unique symbol };

export type ShapeRecipe =
  | /* existing members */ ...
  | { readonly op: 'brep'; readonly blob: string; readonly format: 'occt-brep-v1'; readonly label?: string }
  | { readonly op: 'heal'; readonly source: ShapeRecipe; readonly precision: number; readonly maxTolerance: number;
      readonly sew: boolean }
  // boolean gains:  readonly fuzzy?: number   (mm, ≥ 0; recipeKey includes it)
  // fillet/chamfer gain: readonly edgeNames?: readonly TopoName[]   (resolved before `edges` indices)
;

/** Optional per-entity flags for the faceted-fallback rule (FR-KRN-16). */
// MeshSolidEntity gains: readonly faceted?: true
```

- **Document version / migration**: serialization `version: 2` (`commands/persistence/serialization.ts`) →
  `version: 3`. Loading v2: `kernelSettings` absent → `{ kernel: <active>, modelingTolerance: defaults }` and a
  provenance warning; `blobs` absent → `{}`. Recipes stay valid (new node kinds are additive). The loader's
  recipe validation (`MAX_RECIPE_DEPTH`, leaf validation) is extended: `brep` leaves must reference an existing
  blob whose sha256 matches its bytes.
- `recipeKey('brep') = brep(<sha256>)`; `heal` and `boolean.fuzzy` enter the key text.

## 4. Commands

All names snake_case, params one inline `z.object`, structured tags. "Kernel" = `annotations: { requiresKernel: true }`.
Toolset = MCP toolset in `packages/mcp/src/toolsets.ts` (`TOOLSET_NAMES`: core, 2d, 3d, measure, parametric, assembly,
exchange, …); existing commands keep their current toolset.

| Command | Kind | Params (sketch) | Data / effect | Toolset |
| ------- | ---- | --------------- | ------------- | ------- |
| `kernel_info` | query | `{}` | TR-KRN-04 payload | core |
| `set_modeling_tolerance` | mutating | `{ linear?: number, angular?: number, maxImportTolerance?: number }` | updates `kernelSettings.modelingTolerance` (validated range) | core |
| `import_step_brep` | mutating, kernel | `{ stepBase64?: string, blobId?: string, heal?: boolean = true, sew?: boolean = true, precisionMode?: 'file'|'document' = 'file', keepOriginal?: boolean = false, name?: string }` | one `mesh` entity per solid with `brep: { op:'heal'?, source: { op:'brep', blob } }`, placements/names/colours from XDE; components for repeated parts; `data.report` (§5.2) | exchange |
| `heal_shape` | mutating, kernel | `{ id: string, precision?: number, maxTolerance?: number, sew?: boolean, fixSmallEdges?: boolean }` | wraps the entity recipe in a `heal` node; `data.report` | 3d |
| `validate_shape` | query, kernel | `{ ids?: string[], selfIntersection?: boolean = false, exact?: boolean = false }` | `data: { results: [{ id, valid, issues: [{ code, subShape: TopoName, detail }], maxTolerance }] }` | measure |
| `boolean` (extended) | mutating, kernel | `+ fuzzy?: number` (mm, ≥ 0, ≤ 0.1) | recipe `boolean.fuzzy`; on failure `data.argumentCheck` | 3d |
| `fillet_edge` / `chamfer_edge` (extended) | mutating, kernel | `+ edgeNames?: TopoName[]` | names resolved first, then `edgeIndices`, then `edgesNear`; history stores names | 3d |
| `inspect_topology` (extended) | query, kernel | `+ withNames?: boolean = true` | each face/edge gains `name: TopoName` and `history: 'primitive'|'modified'|'generated'|'imported'` | 3d |
| `mass_properties` (extended) | query | `+ frame?: 'document'|'entity' = 'document', eps?: number = 1e-9, about?: Vec3` | §5.4 payload | measure |
| `export_step_exact` (extended) | query, kernel | `+ validationProperties?: boolean = true, assembly?: boolean = true` | AP214/AP242 text with GVP (TR-KRN-80) | exchange |
| `check_model` (extended) | query | — | adds `faceted_result`, `kernel_mismatch`, `invalid_brep` (when kernel present) issue codes | core |

Structured tags (example):

```ts
/**
 * @affects creates one mesh entity per imported solid (brep leaf + optional heal node), components for repeated
 *   definitions, document blobs for the healed B-rep; selection = created ids
 * @invariant replay re-creates identical shapes from the blob (the STEP reader never runs on replay)
 * @invariant every created solid passed BRepCheck after healing, or the command imported nothing
 * @failure no kernel / kernel without importShapes, unreadable STEP, no solid and no closable shell,
 *   tessellated-only content (report says so) -> no-op, affected:[]
 */
export const importStepBrep = defineCommand({ name: 'import_step_brep', annotations: { requiresKernel: true }, ... });
```

MCP: `import_step` (exchange tool) gains `mode: 'brep' | 'mesh'` (default `brep` when the OCC kernel is active),
forwarding to `import_step_brep`; the mesh path remains for Manifold. CLI: `llull import_step_brep file=<path>` —
`import_step_brep` is a registry command (in-process for `--doc`, `POST /command` for `--app`); the CLI's
`file=` → `stepBase64` mapping (`server/src/cli/exchange.ts` `FILE_PARAMS`, today exchange tools only) is extended to it.

## 5. Kernel / algorithms

### 5.1 Tolerance & precision policy (TR-KRN-10 .. 13)

- **TR-KRN-10 (MUST, MVP) — units and envelope.** The kernel works in **mm** (OCC is tuned for mm, Confusion =
  1e-7 [R1]). Documents in other units are scaled at the kernel boundary (`shapeKernel.ts` applies the factor on
  leaves and inverse on outputs) — or document units are restricted to display (Q3). **Guaranteed envelope:
  |x|, |y|, |z| ≤ 1e5 mm (100 m)** — covers a 72.6 m A380 [R24] in aircraft coordinates. Rationale (measured /
  computed): binary64 spacing at 1e5 mm is 1.46e-11 mm [R29], four orders below Confusion; booleans at 70 m are
  translation-invariant within tolerance (VC-KRN-02 plate-hole). Outside the envelope, commands succeed with a
  `precision_envelope` warning (quality case `syn-far-from-origin`, 1000 km, must import with that warning).
- **TR-KRN-11 (MUST, MVP) — tolerance roles.** `Precision::Confusion` (1e-7 mm) stays the kernel's internal
  coincidence. Document `modelingTolerance.linear` (default 1e-4 mm, the OCCT STEP reader's default
  `read.precision.val` [R5]) drives: STEP import precision when the file has no uncertainty, ShapeFix precision,
  sewing tolerance (today hard-coded 1e-6 in `meshDataToTopoDSShape`), and the upper bound of automatic fuzzy
  retries. `maxImportTolerance` (default 0.01 mm) is the warning threshold on sub-shape tolerances after
  import / heal (`BRep_Tool::Tolerance` on vertices / edges / faces). The OCCT `read.maxprecision.val` is set to
  `max(0.1 mm, maxImportTolerance)` so healing may grow tolerances but the report shows by how much.
- **TR-KRN-12 (SHOULD, MVP) — fuzzy booleans.** `BRepAlgoAPI_BooleanOperation::SetFuzzyValue(fuzzy)` when
  `fuzzy > 0` [R2]; `SetNonDestructive(true)` always (inputs are cached shapes shared across steps);
  `SetRunParallel(false)` by default (determinism, TR-KRN-60); `SetUseOBB(true)` for assemblies (V1 measure).
  Measured: a 1e-5 mm gap fuses into 1 valid solid with fuzzy 2e-5, stays 2 solids without (VC-KRN-08).
  Automatic retry ladder (opt-in `autoFuzzy`): on BOP failure retry with fuzzy = linear tolerance, report it.
- **TR-KRN-13 (SHOULD, MVP) — argument analysis on failure.** On a failed boolean, run
  `BOPAlgo_ArgumentAnalyzer` (self-interference, small edges, rebuilt faces) and `BRepCheck_Analyzer` on both
  arguments [R2][R9]; return named issues in `data.argumentCheck`.

### 5.2 STEP → exact B-rep, healing (TR-KRN-20 .. 24)

- **TR-KRN-20 (MUST, MVP) — reader.** New optional kernel method
  `importShapes(format: 'step', bytes: Uint8Array, options): ImportedShapes | null` implemented with
  `STEPCAFControl_Reader` → XDE document (names, colours, assembly structure, instances [R6]);
  `xstep.cascade.unit = MM`, `read.precision.mode` = file (uncertainty) or document [R5]. Each free shape
  becomes a definition; each XDE instance a placement (`TopLoc_Location`) → llull `components` +
  `insert_instance` for repeated definitions, plain entities for singletons.
- **TR-KRN-21 (MUST, MVP) — persistence of imported geometry.** After healing, each definition is serialized
  with `BRepTools::Write` (text, versioned format) into a document blob keyed by sha256; the recipe leaf
  `{ op: 'brep', blob }` is what `evaluate` reads (`BRepTools::Read`). Optionally (`keepOriginal`) the STEP bytes
  are kept as a `model/step` blob for audit. Replay and reload never depend on the STEP reader version.
- **TR-KRN-22 (MUST, MVP) — content classification.** Before transfer, count roots by type: solids, closed
  shells, open shells, faces, wires, tessellated items (`TESSELLATED_*`, AP242). Tessellated-only files (NIST
  FTC 08 `-tg`, measured: plain reader returns a void shape) → no-op with diagnostic and suggestion to use mesh
  import; mixed → import B-rep, list skipped items.
- **TR-KRN-23 (SHOULD, V1) — GVP comparison.** Read STEP geometric validation properties (volume, area,
  centroid; CAx-IF practice [R21]) with `STEPCAFControl_Reader::SetPropsMode(true)` and the `XCAFDoc_Volume` / `XCAFDoc_Area` / `XCAFDoc_Centroid` attributes [R33]; recompute with §5.4 on the healed
  shape; report `volumeRelDiff`, `areaRelDiff`, `centroidAbsDiff`, in file units converted to mm (two NIST
  AP203 files and one AP242 file carry GVP in inches — measured). Thresholds: info ≤ 1e-6, warning > 1e-4
  (volume) / > 1e-3 (area) / > 0.05 mm (centroid).
- **TR-KRN-24 (MUST, MVP) — healing pipeline.** Per definition: `BRepCheck_Analyzer` (as read) →
  `ShapeFix_Shape` (`SetPrecision(linear)`, `SetMaxTolerance(maxprecision)`, `SetMinTolerance(linear/10)` [R4])
  → if shells are open and `sew`: `BRepBuilderAPI_Sewing(linear·10)` [R3] + `ShapeFix_Solid` /
  `BRepBuilderAPI_MakeSolid` when the sewn shell is closed → `ShapeUpgrade_UnifySameDomain` (optional) →
  `BRepCheck_Analyzer` (after). Report per body: `validAsRead`, `validAfterHeal`, actions (from ShapeFix status
  flags / `ShapeExtend_MsgRegistrator`), `maxTolerance`, free edges count, `faceted` (all faces planar triangles
  → likely a mesh in disguise). Measured on NIST: 27/27 B-rep files valid as read with OCCT 7.9.3, max tolerance
  up to 0.108 mm (`nist_ctc_02_asme1_rc.stp`).

### 5.3 Persistent topological naming (TR-KRN-30 .. 33)

- **TR-KRN-30 (MUST, V1) — history-derived names.** Every recipe node evaluation produces, beside the shape, an
  **element map** `Map<TopoName, SubShapeIndex>` for faces, edges, vertices, derived from the OCC builder history
  (`Modified`, `Generated`, `IsDeleted` [R3]; booleans: `BRepAlgoAPI_BooleanOperation` history, fillets:
  `BRepFilletAPI_MakeFillet` history, transforms: modified copies, `BRepTools_History` to merge multi-stage
  histories such as boolean + `UnifySameDomain` [R3]). Naming grammar (FreeCAD-1.0-like element map [R15]):
  - primitive faces get canonical names from the generator (`box:+X`, `cyl:side`, `cyl:top`, `ext:cap0`,
    `ext:side<k>` from profile segment k, `rev:<k>`), imported faces `imp<k>` (order of the stored BRep blob,
    stable because the blob is immutable);
  - a modified face: `<input name>;:M` tagged with the step (`[s<n>:<op>]`); a generated face (fillet face from an
    edge, boolean section edge from two faces): `<op>(<source names>);:G`;
  - one input split into several outputs: suffix `#k`, with k ordered by a deterministic geometric key
    (centroid projected on the input's principal axis, then area) — never by kernel enumeration order;
  - edges: if not generated, the sorted pair (or n-tuple) of adjacent face names + `#k` for multiple shared edges;
    vertices: sorted triple of adjacent face names.
  Measured on OCCT 7.9.3: a single-edge fillet on a box reports 1 face Generated from the edge and 4 of 6 input
  faces Modified (`occt_behaviour_probe.json`) — the inputs this grammar needs.
- **TR-KRN-31 (MUST, V1) — resolution order and failure.** `fillet_edge` / `chamfer_edge` / later hole, shell
  opening, sketch-on-face and PMI anchors store `TopoName`s. On replay: (1) exact name match; (2) history-trace
  match: same generator chain with a changed `#k` → choose the candidate closest to the stored mid point / face
  centroid (the current `edgesNear` data becomes the tie-breaker, KI5); (3) none → the step reports
  `broken_reference` with the name and the step is **suppressed with an error badge**, never re-targeted
  silently. The command summary lists re-resolved and broken references.
- **TR-KRN-32 (SHOULD, V1)** Names are exposed in `inspect_topology`, in viewport picking (hover shows the
  name), and in MCP results, so agents select by name instead of index.
- **TR-KRN-33 (COULD, V2)** Persistent names survive `export_code` / `apply_code_trace` (CadQuery round trip)
  by carrying names as selection tags; today mid points are used (KI5).

### 5.4 Mass properties (TR-KRN-40 .. 42)

- **TR-KRN-40 (MUST, MVP) — exact properties.** New optional kernel method
  `massProperties(handle, { eps, reference }) → { volume, area, centroid, inertiaAtCentroid: Mat3,
  relError }` with `BRepGProp::VolumeProperties(shape, props, eps, onlyClosed=true)` (adaptive Gauss; `eps`
  default 1e-9 relative per face; the returned error estimate is reported) and
  `BRepGProp::SurfaceProperties` [R8]. `GProp_GProps::MatrixOfInertia()` is about the centre of mass;
  principal moments/axes by symmetric 3×3 Jacobi eigen-decomposition in `@lib`; radii of gyration
  k = √(I/m). Payload of `mass_properties` (extended):
  `{ volume, volumeUnit, area, areaUnit, centroid, inertia: { atCentroid: Mat3, atOrigin: Mat3, principal:
  { moments: Vec3, axes: [Vec3,Vec3,Vec3] }, unit: 'g·mm²' | 'mm⁵ (per unit density)' }, density?, mass?,
  method: 'exact'|'closed-form'|'mesh', relErrorEstimate? }`.
- **TR-KRN-41 (MUST, MVP) — part-frame evaluation.** Before integration, the shape is **copied** (geometry, not
  only location) to a local frame centred on its bounding-box centre `c`, rounded to 1 mm
  (`BRepBuilderAPI_Transform(shape, T(−c), copy=true)`); results are shifted back: centroid += c; inertia at the
  centroid is translation-invariant; inertia about the origin by the parallel-axis theorem
  I_O = I_G + m(|r|²E − r rᵀ), r = centroid. Measured on OCCT 7.9.3 for a 100×50×20 box: raw Iyy relative error
  5e-16 at the origin, 3.8e-11 at 10 m, **1.2e-9 at 70 m**, 1.2e-7 at 1 km; moving back by `TopLoc_Location` only
  does not help (1.2e-9); geometry copied to the origin: 5e-16; part authored at origin and placed by location:
  3.3e-14 (`occt_behaviour_probe.json`). Target: ≤ 1e-12 relative at 70 m (VC-KRN-02).
- **TR-KRN-42 (SHOULD, V1) — assemblies.** Instance properties are computed once per component definition in
  its own frame and combined: m = Σmᵢ; c = Σmᵢcᵢ/m with cᵢ = Rᵢĉᵢ + tᵢ; I_G = Σ[RᵢÎᵢRᵢᵀ + mᵢ(|dᵢ|²E − dᵢdᵢᵀ)],
  dᵢ = cᵢ − c. Densities from materials (existing resolution order in `measureSolid.ts`). Display-mesh volume is
  never used when an exact handle exists.

### 5.5 Validity (TR-KRN-50 .. 51)

- **TR-KRN-50 (MUST, MVP) — commit gate.** `shapeKernel.ts` (`kernelFromOps`) runs `validate` (BRepCheck
  geometric controls [R9]) on every node result before caching it; invalid → the node evaluates to null with
  reason `invalid_result` (today only fillets are checked, `validOrNull`). Cost is bounded by caching: each
  recipe node is validated once per `recipeKey`.
- **TR-KRN-51 (MUST, MVP) — `validate_shape`.** Checks: `BRepCheck_Analyzer` (topology + geometry, optional
  `exact` mode), optional `BOPAlgo_ArgumentAnalyzer` self-interference, small edges (< 10·linear), sliver faces
  (area / perimeter² below threshold), tolerance excess (> maxImportTolerance), free edges / open shells,
  orientation (negative volume). Issues carry `TopoName`s (V1) or indices (MVP).

### 5.6 Determinism & regression (TR-KRN-60 .. 62)

- **TR-KRN-60 (MUST, MVP)** Single-threaded BOP and meshing by default; deterministic ordering in llull code
  (sorted maps, no `Date.now`, no `Math.random`); a **topology signature** per shape = sha256 of the sorted list
  of (surface type, area rounded to 1e-6 relative, centroid rounded to 1e-6 mm) per face plus counts. Measured:
  the same plate-minus-cylinder cut gives the identical signature twice in one process (7 faces,
  `1125f7464525c4f6`, OCCT 7.9.3).
- **TR-KRN-61 (MUST, MVP)** Kernel provenance (`kernelSettings.occtVersion`, `build`) written on save and
  compared on load; the WASM build and the CadQuery/OCP version are pinned to the **same OCCT minor** (7.9.x)
  in `package.json` / `server/python/requirements.txt` / `desktop/scripts/prepare-python.mjs`.
- **TR-KRN-62 (MUST, MVP)** `npm run quality:kernel`: rebuilds the golden plans with kernel results, the KRN
  plans and the KRN STEP set; compares to a committed baseline — same build: signatures equal; other build:
  counts equal and measures within VC-KRN-01 tolerances; drift report per model; baseline updates are reviewed.

### 5.7 Large assemblies & display (TR-KRN-70 .. 74)

- **TR-KRN-70 (SHOULD, V1) — shared definitions.** A component definition evaluates to one kernel shape;
  instances are `TopLoc_Location`-placed references (XDE model [R6]) — never copied geometry — so 10 000
  fasteners cost 1 evaluation and 1 tessellation. Exact-mode `import_step_brep` creates components for repeated
  STEP definitions (quality case `syn-bolt-grid`: 400 instances).
- **TR-KRN-71 (SHOULD, V1/V2) — display.** Extend `InstancedRenderer.tsx` from box/cylinder/sphere to any
  `mesh` result: one `InstancedMesh` per (definition, material, LOD) [R26]; `BatchedMesh` for many distinct small
  parts sharing a material [R26]; `LOD` with a tessellation ladder per definition (deflection 0.01 / 0.1 / 1 mm
  relative to bounding box, angular 0.5 → 0.2 rad) and a bounding-box proxy level; tessellations cached by
  `(recipeKey, deflection)`.
- **TR-KRN-72 (MUST, MVP) — local-frame tessellation.** `tessellate` returns vertices in the definition's local
  frame (`occtMesh.ts` currently emits world space), with the placement carried by the entity/instance matrix;
  three.js composes model-view matrices on the CPU in float64 before uploading float32 [R31], so vertex precision is
  bounded by part size, not by station (float32 ulp at 70 000 = 0.0078 mm [R29], at 300 mm part size 3e-5 mm).
- **TR-KRN-73 (SHOULD, MVP) — depth precision.** Replace near 0.01 / far 1e8 (`Viewport3D.tsx`) by near/far
  fitted to the scene bounds each frame, plus `logarithmicDepthBuffer` or reversed-Z; acceptance: no z-fighting
  between faces 0.01 mm apart at 70 m viewed from 1 m (display gate screenshot).
- **TR-KRN-74 (COULD, V2) — streaming.** Lazy evaluation of component definitions outside the view frustum;
  bounding boxes from the stored blobs; memory budget enforced by the existing recipe cache eviction (KI5).

### 5.8 Export (TR-KRN-80)

- **TR-KRN-80 (SHOULD, V1)** `export_step_exact` via `STEPCAFControl_Writer` (assembly structure, names,
  colours) and GVP (volume, area, centroid of each solid, §5.4) [R21]; replace the fixed `/out.step` scratch path
  workaround once the new build is verified (KI5 gotcha).

## 6. Interop & persistence

| Item | Format | Notes |
| ---- | ------ | ----- |
| Imported definition | OCCT BRep text (`BRepTools::Write`, versioned) in `document.blobs` | content-addressed; base64 in JSON; gzip in the desktop file container when > 1 MB (Q4) |
| Original STEP (optional) | `model/step` blob | audit / re-import; not used on replay |
| Document | `llull-document` v3 | `kernelSettings`, `blobs`; v2 migration (§3) |
| Exact export | STEP AP214 (today) → AP242 geometry + GVP (V1) | full AP242 PMI is gap XCH |
| Lightweight | glTF (existing `export_gltf`), JT (gap XCH, ISO 14306 [R23]) | LOD ladder reused |
| Code | CadQuery / build123d via `export_code` | `brep` leaves lowered to `cq.importers.importBrep`-style loading of the blob (Q5) |

Desktop files larger than the 512 MB body limit (`backendEnv.ts`) must use a sidecar blob directory next to the
document instead of inline base64 (V2).

## 7. UI / CLI / MCP surfaces

- **UI**: kernel badge in the status bar (`OCC 7.9.x` / `Manifold (fallback: <reason>)`); Import dialog option
  "Exact B-rep (editable)" default on desktop, with the healing report panel (per body: valid, actions, max
  tolerance, GVP deltas); Tools → Validate shape; Measure → Mass properties panel with tensor, principal axes
  gizmo and CSV copy; Document settings → Modelling tolerance; broken-reference badges in the feature tree
  with "re-pick" action (re-pick = `edit_step_params` with new names).
- **CLI**: `llull kernel_info`, `llull import_step_brep file=<path>`, `llull validate_shape`,
  `llull mass_properties '{"entityId":…}'` — compact JSON output (llull-cli skill); `--kernel occt` becomes the
  CLI default for `--doc` runs on desktop installs.
- **MCP**: tools from the registry (`toToolSchemas`); `import_step` exchange tool `mode` param; toolsets:
  core (kernel_info, set_modeling_tolerance), measure (validate_shape, mass_properties), exchange (import/export),
  3d (heal_shape).

## 8. Performance & robustness budgets

Reference machine for budgets: the desktop CI runner (to be fixed in KI7). Values marked TBD are measured
once in M2 and then ratcheted.

| Operation | Budget | Basis |
| --------- | ------ | ----- |
| OCC kernel cold start (desktop worker) | ≤ 2 s | KI4: 0.8-1 s for OCCT 7.4 WASM; TBD for 7.9 build |
| Boolean on primitives | ≤ 200 ms | KI4: ~180 ms (7.4) |
| STEP read + heal, ≤ 2 MB / ≤ 700 faces single part | ≤ 2 s in the worker | measured native OCP 7.9.3 read: 0.01-0.84 s on the 28 NIST files (`nist_occt_reference.json`); WASM factor TBD |
| `mass_properties` exact, ≤ 700 faces | ≤ 300 ms | TBD measure |
| `validate_shape` (no self-intersection), ≤ 700 faces | ≤ 300 ms | TBD measure |
| Topology naming overhead per node | ≤ 20 % of node evaluation time | FreeCAD reports negligible impact (search summary [R16]); TBD measure |
| Instancing | 10 000 instances of one 300-face part: 1 evaluation, ≤ 1 draw call per LOD/material, ≥ 30 fps | TBD — display gate |
| Single OCC call timeout | 30 s default (`LLULL_OCC_TIMEOUT_MS`) | existing |
| Kernel memory | recipe cache eviction (existing) + blob cache cap 1 GB on desktop | TBD |
| Robustness | 0 server crashes on the quality corpus in exact mode; every WASM abort recycles the worker (existing) | `isolatedKernel.ts` |

## 9. Test strategy

| Layer | Test | VC |
| ----- | ---- | -- |
| Unit (core, no kernel) | `kernel_info` / `set_modeling_tolerance` schema + purity + failure; recipe `brep`/`heal`/`fuzzy` key & validation; v2→v3 migration; parallel-axis / principal-axes helpers in `@lib` against `analytic_solids.json` | VC-KRN-01 (math), VC-KRN-11 |
| Unit (server, real OCC: `server/tests/occt*.test.ts` pattern) | analytic solids and far-box mass properties; fuzzy boolean; commit validity gate; `import_step_brep` on a small committed synthetic STEP; naming grammar on box/fillet/boolean | VC-KRN-01, 02, 08, 09 |
| Golden (`tests/golden/plans.ts`) | KRN plans from `validation/plans/` (aliases, id-normalised snapshots, replay equality); renaming plan expected to fail until V1 (registered as known issue) | VC-KRN-03, 03b, 07 |
| Quality gate | `quality:step` gains `--mode brep` (validity after heal, exact volume vs `quality/step_reference.py`, save/load of blobs) over `quality/corpus.json`; NIST set pinned as a new `aerospace` group (archive URL + sha256, see `validation/README.md`); GVP comparison | VC-KRN-04, 04x, 05, 06 |
| Kernel regression (new `quality:kernel`) | signatures + measures vs baseline; cross-version tolerance mode | VC-KRN-10 |
| Display gate | 10 000-instance scene, 70 m station z-fighting screenshot | VC-KRN-12, TR-KRN-73 |
| Desktop (`npm --prefix desktop test`) | backend env contains `LLULL_KERNEL=occt`; `kernel_info.active === 'occt'`; forced failure → fallback warning | VC-KRN-11 |
| Production-gate scenario | "Supplier STEP round trip": import NIST CTC 01 AP242 → drill + pocket + fillet → validate → mass → export STEP with GVP → re-import → GVP within 1e-6 of the exported values | VC-KRN-04, 09, TR-KRN-80 |

Coverage gate (90/85/90/90) applies to new code in `packages/core/src/{commands,geometry}`.

## 10. Delivery plan

| Milestone | Content | TRs | Effort (eng-weeks) | Depends on |
| --------- | ------- | --- | ------------------ | ---------- |
| M1 OCC default | desktop env, `kernel_info`, status badge, provenance fields + migration, faceted flag | 01, 04, 61 (fields), FR-KRN-16 | 1.5 | — |
| M2 Kernel build | OCCT 7.9.x WASM with exceptions, regenerated bindings, KI7 decision with measurements, version alignment with OCP | 02, 61 | 4-6 | M1 |
| M3 Precision & mass | tolerance policy + command, part-frame mass properties, inertia/principal, local-frame tessellation, depth precision | 10, 11, 40, 41, 72, 73 | 3 | M1 (M2 for exception-safe GProp) |
| M4 Exact import | `importShapes`, blobs, `import_step_brep`, healing, classification, report, MCP/CLI wiring, quality `--mode brep` | 20, 21, 22, 24 | 5-7 | M2 |
| M5 Robustness | commit validity gate, `validate_shape`, fuzzy booleans, argument analysis | 12, 13, 50, 51 | 2 | M2 |
| M6 Regression | signatures, `quality:kernel`, baselines | 60, 62 | 2 | M4 |
| M7 Persistent naming | element maps, naming grammar, resolution, UI repair, golden renaming plan green | 30, 31, 32 | 8-12 | M2, M6 |
| M8 Assemblies & export | shared definitions, assembly mass properties, instancing of results, LOD, GVP import/export | 23, 42, 70, 71, 80 | 5-7 | M4, M7 (names for PMI later) |
| M9 Browser worker / native evaluation | Web Worker command execution; native OCP kernel spike | 03, 05 | 3-4 | M2 |

Total ≈ 34-45 engineer-weeks. Downstream gaps: 07 FTR (holes/pockets need M4, M7), 03 GDT and 04 XCH (face names
M7, GVP M8), 05 FEA (exact faces M4, names M7), 02 SRF (NURBS ops need M2), 09 PLM (provenance M1/M6).

## 11. Open questions / decisions needed

| # | Question | Options | Recommendation |
| - | -------- | ------- | -------------- |
| Q1 | Desktop kernel binary | (a) OCCT 7.9.x WASM in the Node worker (one code path with browser); (b) native OCCT via bundled CPython OCP 7.9.3 child process; (c) native Node addon | (a) for MVP, measure (b) in M9 — (b) is already shipped (KI6) and is the OCCT used to produce this pack's references |
| Q2 | Default modelling tolerance | 1e-4 mm (OCCT STEP default) vs 1e-3 mm vs per-document | 1e-4 mm, user-settable in [1e-7, 1e-2] |
| Q3 | Non-mm documents | scale at kernel boundary vs store kernel geometry in mm and treat units as display | store kernel geometry in mm (OCC is mm-tuned [R1]); decision needed on existing `units` semantics |
| Q4 | Blob storage | inline base64 vs gzip container vs sidecar directory | inline ≤ 1 MB, gzip container above, sidecar for > 512 MB documents |
| Q5 | Code export of imported parts | embed blob path in CadQuery code vs emit STEP next to the script | emit the healed BRep file next to the script and load it |
| Q6 | Naming grammar compatibility | own grammar vs FreeCAD-compatible element names | own grammar, documented; FreeCAD's shows feasibility [R15] but is GPL/LGPL-coupled to its data structures |
| Q7 | GVP disagreement policy | warn vs block | warn; block only on exact-export round trip (production scenario) |
| Q8 | Parallel BOP | off (determinism) vs on (speed) | off by default, on for large assemblies after determinism is proven equal |

## 12. References

- [R1] OCCT `Precision.hxx` — https://raw.githubusercontent.com/Open-Cascade-SAS/OCCT/V7_8_0/src/Precision/Precision.hxx (accessed 2026-10)
- [R2] OCCT Boolean Operations specification — https://raw.githubusercontent.com/Open-Cascade-SAS/OCCT/V7_8_0/dox/specification/boolean_operations/boolean_operations.md (accessed 2026-10)
- [R3] OCCT Modeling Algorithms (history, BRepTools_History, sewing) — https://raw.githubusercontent.com/Open-Cascade-SAS/OCCT/V7_8_0/dox/user_guides/modeling_algos/modeling_algos.md (accessed 2026-10)
- [R4] OCCT Shape Healing — https://raw.githubusercontent.com/Open-Cascade-SAS/OCCT/V7_8_0/dox/user_guides/shape_healing/shape_healing.md (accessed 2026-10)
- [R5] OCCT STEP translator — https://raw.githubusercontent.com/Open-Cascade-SAS/OCCT/V7_8_0/dox/user_guides/step/step.md (accessed 2026-10)
- [R6] OCCT XDE — https://raw.githubusercontent.com/Open-Cascade-SAS/OCCT/V7_8_0/dox/user_guides/xde/xde.md (accessed 2026-10)
- [R7] OCCT Modeling Data (TopLoc_Location) — https://raw.githubusercontent.com/Open-Cascade-SAS/OCCT/V7_8_0/dox/user_guides/modeling_data/modeling_data.md (accessed 2026-10)
- [R8] OCCT `BRepGProp.hxx` — https://raw.githubusercontent.com/Open-Cascade-SAS/OCCT/V7_8_0/src/BRepGProp/BRepGProp.hxx (accessed 2026-10)
- [R9] OCCT `BRepCheck_Analyzer.hxx` — https://raw.githubusercontent.com/Open-Cascade-SAS/OCCT/V7_8_0/src/BRepCheck/BRepCheck_Analyzer.hxx (accessed 2026-10)
- [R10] OCCT README (licence) — https://raw.githubusercontent.com/Open-Cascade-SAS/OCCT/master/README.md (accessed 2026-10)
- [R11] opencascade.js v1.1.1 README — https://raw.githubusercontent.com/donalffons/opencascade.js/v1.1.1/README.md (accessed 2026-10)
- [R12] npm opencascade.js metadata — https://registry.npmjs.org/opencascade.js (accessed 2026-10)
- [R13] PyPI cadquery / cadquery-ocp metadata — https://pypi.org/pypi/cadquery/json ; https://pypi.org/pypi/cadquery-ocp/json (accessed 2026-10)
- [R14] OCCT 7.9.0 release news — https://dev.opencascade.org/content/open-cascade-technology-790-released (search summary only, accessed 2026-10)
- [R15] FreeCAD 1.0.0 element map sources — https://raw.githubusercontent.com/FreeCAD/FreeCAD/1.0.0/src/App/ElementNamingUtils.h ; https://raw.githubusercontent.com/FreeCAD/FreeCAD/1.0.0/src/Mod/Part/App/TopoShapeOpCode.h (accessed 2026-10)
- [R16] FreeCAD 1.0 release notes / Ondsel blog — https://wiki.freecad.org/Release_notes_1.0 ; https://ondsel.com/blog/toponaming-problem-is-history/ (search summary only, accessed 2026-10)
- [R17] Kripac 1997, Computer-Aided Design 29(2):113-122 — via https://patents.justia.com/patent/6445388 (search summary only, accessed 2026-10)
- [R20] NIST-PMI-STEP-Files.zip — https://raw.githubusercontent.com/usnistgov/SFA/72375d17c09cf7072c30d9393b5c08b7aa272285/Release/NIST-PMI-STEP-Files.zip (accessed 2026-10)
- [R21] CAx-IF Recommended Practices for Geometric and Assembly Validation Properties v4.6 — https://www.mbx-if.org/documents/rec_prac_gvp_v46.pdf (search summary only, accessed 2026-10)
- [R23] ISO 14306 catalogue — https://www.iso.org/standard/89233.html (search summary only, accessed 2026-10)
- [R24] ICAO APANPIRG/15 WP12 (A380 dimensions) — https://www.icao.int/sites/default/files/Meetings/AMC/MA/2004/APANPIRG15/wp12.pdf (search summary only, accessed 2026-10)
- [R26] three.js docs r170 (InstancedMesh, BatchedMesh, LOD) — https://raw.githubusercontent.com/mrdoob/three.js/r170/docs/api/en/objects/BatchedMesh.html (accessed 2026-10)
- [R29] IEEE-754 spacing — computed with Python `math.ulp` (validation/sources.md)
- [R31] three.js WebGLRenderer.js r170 — https://raw.githubusercontent.com/mrdoob/three.js/r170/src/renderers/WebGLRenderer.js (accessed 2026-10)
- [R32] MDN Atomics.wait() — https://raw.githubusercontent.com/mdn/content/main/files/en-us/web/javascript/reference/global_objects/atomics/wait/index.md (accessed 2026-10)
- [R33] OCCT V7_8_0 toolkit PACKAGES and XCAFDoc / STEPCAFControl / BOPAlgo headers — https://raw.githubusercontent.com/Open-Cascade-SAS/OCCT/V7_8_0/src/TKTopAlgo/PACKAGES (accessed 2026-10)
- llull code and decisions cited by path in §1 (KI4, KI5, KI6); measured data: `validation/occt_behaviour_probe.json`,
  `validation/occt_crosscheck.json`, `validation/nist_occt_reference.json`, `validation/nist_gvp_vs_occt.json`
