# KRN — Exact B-rep kernel as the production basis — Technical specification

Gap id **KRN** · status: specification (no implementation) · written 2026-10-15 ·
functional counterpart: [FUNCTIONAL_SPEC.md](FUNCTIONAL_SPEC.md) · validation: [validation/README.md](validation/README.md)

Requirement ids `TR-KRN-nn` are grouped by decade: 0x kernel selection & build, 1x tolerance policy & booleans,
2x STEP → exact B-rep & healing, 3x persistent naming, 4x mass properties, 5x validity, 6x determinism,
7x large assemblies & display, 8x export, 9x face-query port, 10x agent-first (codes, units, defaults, unverified, review, human gates, loop).

## 1. Current state in llull

| Area               | Where                                                                                                                                          | Behaviour today                                                                                                                                                                                                                                                                                                               | Limit for aerospace                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kernel interface   | `packages/core/src/geometry/kernel.ts`                                                                                                         | `GeometryKernel` = `supports`, `evaluate(recipe) → ShapeHandle`, `tessellate`, `topology`, `exportStep`; synchronous; null = no-op                                                                                                                                                                                            | no import of external exact shapes, no validity / mass-property / history API                                                                                                                                                                                                                                                                                                         |
| Recipe             | `packages/core/src/geometry/shapeRecipe.ts`, `model/types.ts` (`ShapeRecipe`)                                                                  | leaves `solid` (llull entity); nodes `boolean`, `fillet`, `chamfer`, `blend`, `shell`, `place`, `scale`; `recipeKey` content hash                                                                                                                                                                                             | no leaf for an imported B-rep; booleans have no tolerance option                                                                                                                                                                                                                                                                                                                      |
| Kernel choice      | `packages/core/src/geometry/kernelChoice.ts`; `src/main.tsx`; `server/src/geometryKernel.ts`                                                   | `parseKernelChoice` → `'manifold'` unless `occt`; browser `?kernel=occt`; server `LLULL_KERNEL=occt` (falls back to Manifold)                                                                                                                                                                                                 | Manifold is the default everywhere                                                                                                                                                                                                                                                                                                                                                    |
| Desktop            | `desktop/src/backendEnv.ts`                                                                                                                    | passes `LLULL_PYTHON`, token, body limit …; strips inherited `LLULL_*`; sets **no** `LLULL_KERNEL`                                                                                                                                                                                                                            | desktop runs Manifold                                                                                                                                                                                                                                                                                                                                                                 |
| OCC implementation | `packages/kernel-occt/src/occtKernel.ts` (+ `occtShapes`, `occtTopology`, `occtMesh`, `occtStep`, `occtCurves`, `occtPatches`, `tangentGuard`) | opencascade.js **1.1.1 = OCCT 7.4.0p1** [R11][R12]; no C++ exception support (`___cxa_*` ReferenceError classification); BRepCheck only after fillets (`validOrNull`); `ShapeUpgrade_UnifySameDomain` after booleans; display deflection 0.1 mm / 0.5 rad; tessellation in world space; STEP writer to fixed `/out.step` path | 6-year-old OCCT; no fuzzy/glue; no history; world-space meshes                                                                                                                                                                                                                                                                                                                        |
| Isolation          | `server/src/isolatedKernel.ts`, `occtWorker.ts`, `geometryKernel.ts` (timeout)                                                                 | OCC in a Node worker thread behind a synchronous call (`Atomics.wait`), timeout `LLULL_OCC_TIMEOUT_MS` (30 s), recycle on degrading failure                                                                                                                                                                                   | browser OCC (`src/ui/geometry/occtKernelBrowser.ts`) runs on the UI thread                                                                                                                                                                                                                                                                                                            |
| STEP import        | `packages/mcp/src/exchangeTools.ts` (`import_step`), `server/python/llull_bridge.py` (`op_import_step`)                                        | CadQuery reads STEP (assembly walk, names, colours) and **tessellates** (tolerance 0.05) → `import_mesh`                                                                                                                                                                                                                      | imported parts are meshes: not editable as B-rep, faceted mass properties                                                                                                                                                                                                                                                                                                             |
| Topology / naming  | `packages/core/src/commands/brep/topology.ts` (`inspect_topology`), `brep/modify3d.ts` (`fillet_edge`, `chamfer_edge`)                         | edges by kernel index or `edgesNear` points re-resolved on replay to the nearest roundable edge mid point (KI5; `server/tests/occtParametricEdges.test.ts`)                                                                                                                                                                   | heuristic: wrong edge possible after large moves; faces have no names                                                                                                                                                                                                                                                                                                                 |
| Mass properties    | `packages/core/src/commands/inspect/measureSolid.ts`, `solidVolume.ts`                                                                         | volume (`exact` via `topology().volume` under OCC, else closed form or display-mesh sum) and mass; instances summed                                                                                                                                                                                                           | no area, centroid, inertia; no accuracy statement. _In flight_ (`feat/motion-dynamics`): `geometry/massProperties.ts` (polyhedral mass / CoM / inertia tensor, `combineMassProperties`) and `geometry/entityMassProperties.ts` (box / cylinder / sphere closed forms, instances) for `add_rigid_body`; still display triangles for every other kind, world coordinates, no exact path |
| Validity           | `packages/core/src/commands/inspect/checkModel.ts`                                                                                             | parameter / structural lint (degenerate sizes, …)                                                                                                                                                                                                                                                                             | no B-rep check                                                                                                                                                                                                                                                                                                                                                                        |
| Viewport           | `src/ui/viewport/3d/Viewport3D.tsx`, `InstancedRenderer.tsx`                                                                                   | perspective camera near 0.01 / far 1e8; InstancedMesh batches for box / cylinder / sphere only                                                                                                                                                                                                                                | depth range 1e10; no instancing of kernel results; no LOD                                                                                                                                                                                                                                                                                                                             |
| Python             | `server/python/requirements.txt` (`cadquery>=2.4`), desktop bundles CadQuery (KI6)                                                             | CadQuery 2.8.0 pins `cadquery-ocp >=7.9.3.1,<8.0` [R13]                                                                                                                                                                                                                                                                       | two OCCT versions in one product (7.4 WASM vs 7.9 native)                                                                                                                                                                                                                                                                                                                             |
| Quality            | `quality/corpus.json`, `quality/step_reference.py`, `quality/synthetic_step.py`, `docs/QUALITY_GATES.md`                                       | 32 STEP cases with independent OCCT reference and analytic synthetic cases; mesh import path                                                                                                                                                                                                                                  | no exact-import, no kernel regression gate                                                                                                                                                                                                                                                                                                                                            |

## 2. Target architecture

```
                       src/ui (viewport: RTC rendering, LOD, instancing)         llull CLI / MCP
                                   │ dispatch                                         │
                                   ▼                                                  ▼
            ┌──────────────── packages/core/src/commands ─────────────────────────────────────┐
            │ brep/: heal_shape · validate_shape · boolean(+fuzzy) ·                            │
            │        fillet_edge/chamfer_edge(+edgeNames) · inspect_topology(+names)           │
            │ inspect/: mass_properties(+centroid, inertia, principal) · kernel_info           │
            │ document/: set_modeling_tolerance                                                 │
            │ exchange/: import_step_exact (owned here; 04 XCH extends it) · export_step_ap242 (04) │
            └───────────────┬───────────────────────────────────────────────────────────────────┘
                            │ ctx.kernel (GeometryKernel, synchronous; requiresKernel)
            ┌───────────────▼───────────────────────────┐
            │ core/geometry: ShapeRecipe (+brep leaf,   │   shapeKernel.ts: recipe cache, naming map,
            │ +heal node, boolean.fuzzy), kernel.ts     │   provenance; optional ports: importShapes,
            │ (+faceQuery port §5.9)                    │   massProperties, validate, faceQuery
            └───────────────┬───────────────────────────┘
                            │ KernelOps<S> (worker protocol: requests by op name, key-only handles, blob resend)
    ┌───────────────────────┴──────────────────────────┐
    │ desktop / server (default, RS-1):                  │  server/src: kernel proxy (same pattern as
    │   solver/bins/llull-kernel — native OCCT 7.9       │  isolatedKernel) → child process over stdio;
    │   (crate llull-kernel-occt, Rust + cxx)            │  LLULL_KERNEL=occt
    │   import/heal/check/gprop/history/XCAF             │
    ├────────────────────────────────────────────────────┤
    │ browser-only: packages/kernel-occt                 │  Web Worker proxy (V1); opencascade.js 1.1.1
    │   (opencascade.js WASM, fallback)                  │  (OCCT 7.4) today, newer WASM build optional
    ├────────────────────────────────────────────────────┤
    │ packages/kernel-manifold                           │  mesh fallback (no OCC available)
    └────────────────────────────────────────────────────┘
```

### 2.A Stack amendment (RS1, 2026-10-18)

Decided by the owner in [RS1](../../decisions/RS1-native-compute.md) (programme step **RS-1**). It replaces the
earlier plan of a custom OCCT 7.9 Emscripten WASM build as the desktop kernel.

| Item | Before | Now |
| ---- | ------ | --- |
| Desktop / server kernel | OCCT 7.9.x WASM build in the Node worker thread | native OCCT 7.9 in the `llull-kernel` sidecar (`solver/bins/llull-kernel`, crate `llull-kernel-occt`, Rust + cxx bindings) |
| Protocol | `KernelOps` over the worker message channel | the same `KernelOps` worker protocol over stdio; `server/src` keeps a synchronous proxy like `isolatedKernel.ts` (timeout, recycle, blob resend) |
| Browser-only path | the same 7.9 WASM build | opencascade.js 1.1.1 (OCCT 7.4) stays as browser fallback; a newer WASM build is optional, low priority |
| Mesh fallback | Manifold | Manifold (unchanged) |
| Packaging | WASM in the npm bundle | `desktop/scripts/prepare-native.mjs` builds or fetches `llull-kernel` per OS / arch; missing binary → `NATIVE_TOOL_MISSING`, then the existing fallback chain |
| Gate | — | `npm run native:check` (`cargo test` + `cargo clippy -D warnings`) |

Why native: OCCT is C++; a native build has C++ exceptions, threads and the full toolkit set (TKDESTEP, TKXCAF)
without an Emscripten port, no 4 GB wasm32 memory ceiling, and it is the same OCCT minor as the bundled
CadQuery / OCP 7.9.3 that produced this pack's reference numbers. Why not a Rust B-rep kernel (truck, Fornjot):
no robust fillets, no shape healing, no STEP AP242 / XCAF reader. Layering is unchanged (L2, L6, L9): the native
process is reached only through `ctx.kernel`; nothing in `packages/*` imports it.

Laws respected:

- **L1/L5** — every capability is a `defineCommand` in a core feature catalog (`commands/brep`, `commands/inspect`,
  `commands/document`, `commands/exchange`) → UI button + MCP tool + CLI verb from one registration.
- **L2** — no DOM / fetch in `packages/*`: file bytes reach `import_step_exact` as a parameter (base64) or as a
  content-addressed blob id already in the document; reading the file from disk stays in `server/`
  (exchange directory) and in `src/ui` (file picker), as today for `import_step`.
- **L3/L8** — commands stay pure; an imported shape becomes a recipe leaf holding the **healed B-rep bytes**
  (content-addressed), so replay re-creates the identical shape without re-running the STEP reader.
- **L9** — the kernel is reached only through `ctx.kernel`; new kernel capabilities are optional methods on
  `GeometryKernel` (`importShapes`, `validate`, `massProperties`, …) returning null under Manifold.
- **L10** — nothing aerospace-specific in core: KRN is generic exact-modelling infrastructure; aerospace
  conventions (body-station axes, weights reports) belong to later plugins.

### 2.0 Ownership split with 04 XCH (decided 2026-10-15)

| Item                                                                                                                           | Owner                              | Other pack                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `import_step_exact` command (one STEP → exact B-rep import; the name `import_step_brep` is retired)                            | **01 KRN** (§4, TR-KRN-20..24)     | 04 XCH extends it: `verify` / `gvpPolicy`, `ImportProvenance`, XDE product tree → components / instances |
| `brep` recipe leaf + `heal` node + document blobs; `GeometryKernel.importShapes`                                               | **01 KRN** (§3, TR-KRN-20/21)      | 04 `import_iges` reuses the same leaf; 04 defines no other leaf and no `readExchange`                    |
| Healing, import report, tessellated-only detection, kernel provenance, llull-document v3 envelope + migration                  | **01 KRN** (TR-KRN-22/24/61, §3.1) | every pack adds its slice to §3.1                                                                        |
| `GeometryKernel.massProperties` (one superset method)                                                                          | **01 KRN** (TR-KRN-40)             | 04 `geometric_validation_properties` consumes it                                                         |
| `GeometryKernel.faceQuery` port                                                                                                | **01 KRN** (§5.9)                  | 02 / 03 / 05 / 06 / 07 consume it                                                                        |
| GVP band policy, `verify_exchange_file`, `geometric_validation_properties`, `export_step_ap242` (AP242 + assembly + GVP), IGES | **04 XCH**                         | KRN FR-KRN-13 / TR-KRN-23 / TR-KRN-80 point there                                                        |

### 2.1 Kernel selection & build

- **TR-KRN-01 (MUST, MVP)** `desktop/src/backendEnv.ts` sets `LLULL_KERNEL: 'occt'` (since KI7, 2026-10-19: `'occt-native'`
  when the bundle holds `llull-kernel`, else `'occt'`; an inherited `occt` is a second diagnostic override, see §13.D). `backendEnv` strips every
  inherited `LLULL_*` variable today, so a diagnostic override needs an explicit exception: an inherited
  `LLULL_KERNEL=manifold` is passed through (same pattern as the `LLULL_ALLOW_CODE_EXECUTION === '1'` pass-through),
  any other inherited value is ignored and `occt` is used; `desktop/tests` covers both. `server/src/geometryKernel.ts` already falls back to
  Manifold with a warning; the fallback reason is exposed through `kernel_info` and a UI status badge
  (`useKernelStatusStore`). `desktop/tests` asserts the active kernel.
- **TR-KRN-02 (MUST, MVP)** On desktop and server, replace `opencascade.js@1.1.1` (OCCT 7.4.0p1, 2020) by
  **native OCCT 7.9.x** (pinned) in the `llull-kernel` sidecar (§2.A, RS1): crate `llull-kernel-occt` binds OCCT
  with cxx and implements the existing `KernelOps` worker protocol (op names, key-only handles, `SHAPE_NOT_CACHED`
  resend, blobs, `info`, `importShapes`, `massProperties`, `faceQuery.*`) over stdio. OCC `Standard_Failure` is
  caught in C++ and returned as a protocol error (removes the `___cxa_*` degraded-module class). Toolkits linked:
  TKBO/TKBool/TKFillet/TKOffset/TKShHealing/TKXSBase/TKDESTEP (STEP)/TKXCAF/TKMesh and TKTopAlgo (which holds
  `BRepCheck` and `BRepGProp` [R33]). `server/src` gets a proxy with the `isolatedKernel.ts` behaviour (synchronous
  call, timeout `LLULL_OCC_TIMEOUT_MS`, recycle on failure). Cold start, op latency and memory are measured against
  KI4's WASM baseline (63 MB, 0.8-1 s, 150-180 ms) and recorded in a decision record (KI7). OCCT is linked
  dynamically (LGPL-2.1 with exception, RS1 §2 rule 7).
- **TR-KRN-03 (SHOULD, V1)** Browser-only (web app without backend): OCC in a dedicated Web Worker. Because the
  `GeometryKernel` contract is synchronous and `Atomics.wait` cannot be used on the browser main thread [R32], the
  browser path executes **whole commands** in the worker (worker hosts `execute` + kernel; the main thread
  receives `CommandResult`) — the same split the desktop already has between renderer and backend (L6). The
  browser uses the WASM binding (opencascade.js 1.1.1 today; a newer WASM build is optional, §2.A).
- **TR-KRN-04 (MUST, MVP)** `kernel_info` read-only command: `{ active: 'occt'|'manifold', occtVersion?, build?,
wasmBytes?, capabilities: string[], modelingTolerance, isolation: 'process'|'worker'|'in-process', fallbackReason? }`
(`process` = the native `llull-kernel` sidecar, §2.A; `wasmBytes` only for a WASM kernel).
- **TR-KRN-05 (MUST, MVP)** The native kernel SHALL give the same results as the OCP 7.9.3 reference that
  produced this pack's numbers: counts equal and measures within VC tolerances on the analytic solids, the
  probe cases and the NIST set (VC-KRN-25). Fallback order on desktop: `llull-kernel` → opencascade.js WASM in
  the worker → Manifold, each step with a `fallbackReason` in `kernel_info`. (Was: "SHOULD V1, evaluate a native
  backend via CPython OCP"; superseded by RS1.) **Status 2026-10-19: VC-KRN-25 passed** on OCCT 7.9.2 (§13.D, validation/README.md §6);
  the desktop default is the native kernel when bundled (KI7).

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

- **Document version / migration**: see §3.1 — 01 KRN owns the single `llull-document` v3 envelope. The loader's
  recipe validation (`MAX_RECIPE_DEPTH`, leaf validation) is extended: `brep` leaves must reference an existing
  blob whose sha256 matches its bytes.
- `recipeKey('brep') = brep(<sha256>)`; `heal` and `boolean.fuzzy` enter the key text.

### 3.1 The `llull-document` v3 envelope (one version, one migration, owned by 01 KRN)

Today `commands/persistence/serialization.ts` writes `{ format: 'llull-document', version: 2, document }`
(`CURRENT_SCHEMA_VERSION = 2`) and refuses any other version ("unsupported version … expected 1 or 2"). Several packs
add document data; instead of each bumping the version on its own, they share **one** step to `version: 3`:

| Slice                                                                                | Added by                                                                     | Kind                          | Declared through                                                          | Notes                                                                               |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `kernelSettings`, `blobs`                                                            | 01 KRN (§3)                                                                  | core root fields              | core persistence guards                                                   | provenance + content-addressed B-rep / STEP payloads                                |
| `exchange.provenance` (`ImportProvenance`)                                           | 04 XCH (TECHNICAL_SPEC §3.1)                                                 | core root field               | core persistence guards                                                   | embedded GVP and band of each import                                                |
| `aero` (`AeroModel`) + entity kinds `nurbs_curve`, `nurbs_surface`, `loft` v3 fields | 02 SRF (§3; resolves its D3)                                                 | core model types, plugin data | plugin `DocumentExtension` (`aero`); kinds in core guards                 | old readers must refuse new kinds — the version bump does that                      |
| `pmi`                                                                                | 03 GDT (§3)                                                                  | core root field               | core `pmiValidation.ts`                                                   |                                                                                     |
| `analysis` (`AnalysisModel`)                                                         | 05 FEA (TR-FEA-02)                                                           | plugin data                   | plugin `DocumentExtension`                                                |                                                                                     |
| `composites` (`CompositesModel`)                                                     | 06 CMP (§3)                                                                  | plugin data                   | plugin `DocumentExtension`                                                |                                                                                     |
| `sheetMetal`                                                                         | 07 FTR (§3)                                                                  | plugin data                   | plugin `DocumentExtension`                                                |                                                                                     |
| `materialRecords`, `materialLibraries`; `Material.recordId?`                         | 08 MAT (§3.5, TR-MAT-14)                                                     | core root fields              | core guards (`validateMaterialRecord`)                                    | private-library values never serialized (TR-MAT-31)                                 |
| `plm` (`PlmModel`)                                                                   | 09 PLM (TR-PLM-10)                                                           | plugin data                   | plugin `DocumentExtension` (+ carried through `replayHistory`, TR-PLM-02) |                                                                                     |
| `dynamics` (`DynamicsModel`)                                                         | motion / rigid-body dynamics (`feat/motion-dynamics`, not an aerospace pack) | core root field               | core `persistence/dynamicsValidation.ts`                                  | lands on v2 before this envelope (optional field, no bump); v3 carries it unchanged |

Rules:

- **Writer**: always writes `version: 3` once this lands (`CURRENT_SCHEMA_VERSION = 3`), whichever slices are present;
  absent slices are omitted, never written empty.
- **Reader**: accepts 1, 2, 3. One migration function `migrate2to3` (after the existing 1 → 2 and retired-command
  rewrites): `kernelSettings` absent → `{ kernel: <active kernel>, modelingTolerance: defaults }` plus a provenance
  warning (FR-KRN-14); `blobs` absent → `{}`; legacy `Material`s unchanged (no `recordId`, 08); every other slice
  stays absent. No slice needs data rewriting, so the migration is total and idempotent.
- **Plugin slices** go through `DocumentExtension.validate` / `restore`; a plugin slice whose plugin is not installed is
  kept verbatim (today's behaviour of `migrate()`), but the file is still v3, so pre-v3 builds refuse it (09's
  release-lock concern).
- **Tests**: one contract test per slice (round trip v3), one v2 → v3 migration golden, one "v3 refused by a v2 reader"
  fixture; packs add their slice rows here rather than bumping the version themselves.

## 4. Commands

All names snake_case, params one inline `z.object`, structured tags. "Kernel" = `annotations: { requiresKernel: true }`.
Toolset = MCP toolset in `packages/mcp/src/toolsets.ts` (`TOOLSET_NAMES`: core, 2d, 3d, measure, parametric, assembly,
exchange, …); existing commands keep their current toolset.

| Command                                                        | Kind             | Params (sketch)                                                                                                                                                                          | Data / effect                                                                                                                                                                        | Toolset                             |
| -------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | --- |
| `kernel_info`                                                  | query            | `{}`                                                                                                                                                                                     | TR-KRN-04 payload                                                                                                                                                                    | core                                |
| `set_modeling_tolerance`                                       | mutating         | `{ linear?: number (mm), angular?: number (rad), maxImportTolerance?: number (mm) }`                                                                                                     | updates `kernelSettings.modelingTolerance` (validated range)                                                                                                                         | core                                |
| `import_step_exact` (owned by 01; extended by 04)              | mutating, kernel | exactly one of `stepBase64?: string`, `text?: string` (Part 21, ASCII), `blobId?: string`; `fileName?: string`, `heal?: boolean = true`, `sew?: boolean = true`, `precisionMode?: 'file' | 'document' = 'file'`, `keepOriginal?: boolean = false`, `name?: string`; **04 extension**: `verify?: boolean = true`, `gvpPolicy?: Partial<GvpPolicy>`, `mode?: 'append'             | 'replace'`, `tessellated?: boolean` | MVP (01): one `mesh` entity per solid with `brep: { op:'heal'?, source: { op:'brep', blob } }`, world placement, names, colours; `data.report` (§5.2). 04 extension: XDE product tree → components / instances, `doc.exchange.provenance`, `data.gvpCheck` (04 TECHNICAL_SPEC §3–§5) | exchange    |
| `heal_shape`                                                   | mutating, kernel | `{ id: string, precision?: number (mm), maxTolerance?: number (mm), sew?: boolean, fixSmallEdges?: boolean }`                                                                            | wraps the entity recipe in a `heal` node; `data.report`                                                                                                                              | 3d                                  |
| `validate_shape`                                               | query, kernel    | `{ entityIds?: string[], selfIntersection?: boolean = false, exact?: boolean = false }`                                                                                                  | `data: { results: [{ id, valid, issues: [{ code, subShape: TopoName, detail }], maxTolerance }] }`                                                                                   | measure                             |
| `boolean` (extended)                                           | mutating, kernel | `+ fuzzy?: number` (mm, ≥ 0, ≤ 0.1)                                                                                                                                                      | recipe `boolean.fuzzy`; on failure `data.argumentCheck`                                                                                                                              | 3d                                  |
| `fillet_edge` / `chamfer_edge` (extended)                      | mutating, kernel | `+ edgeNames?: TopoName[]`                                                                                                                                                               | names resolved first, then `edgeIndices`, then `edgesNear`; history stores names                                                                                                     | 3d                                  |
| `inspect_topology` (extended)                                  | query, kernel    | `+ withNames?: boolean = true`                                                                                                                                                           | each face/edge gains `name: TopoName` and `history: 'primitive'                                                                                                                      | 'modified'                          | 'generated'                                                                                                                                                                                                                                                                          | 'imported'` | 3d  |
| `mass_properties` (extended)                                   | query            | `+ frame?: 'document'                                                                                                                                                                    | 'entity' = 'document', eps?: number = 1e-9 (relative), about?: Vec3 (document unit), purpose?: 'general'                                                                             | 'weight-and-balance' = 'general'`   | §5.4 payload + `unverified`, `reviewRequired`, `provenance`, named defaults (TR-KRN-102..104)                                                                                                                                                                                        | measure     |
| `export_step_exact` (unchanged) / `export_step_ap242` (04 XCH) | query, kernel    | — / see 04 TECHNICAL_SPEC §4                                                                                                                                                             | `export_step_exact` stays AP214, flat, no GVP; exact AP242 export with assembly structure and GVP is 04's `export_step_ap242` (TR-KRN-80)                                            | exchange                            |
| `check_model` (extended)                                       | query            | —                                                                                                                                                                                        | adds `KRN_FACETED_RESULT`, `KRN_KERNEL_MISMATCH`, `KRN_INVALID_BREP` (when kernel present), `KRN_MASS_INPUT_UNVERIFIED`, `KRN_BROKEN_REFERENCE`, `KRN_KERNEL_FALLBACK` issues (§7.2) | core                                |

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
export const importStepExact = defineCommand({ name: 'import_step_exact', annotations: { requiresKernel: true }, ... });
```

MCP: `import_step` (exchange tool) gains `mode: 'exact' | 'mesh'` (default `exact` when the OCC kernel is active),
forwarding to `import_step_exact`; the mesh path remains for Manifold. CLI: `llull import_step_exact file=<path>` —
`import_step_exact` is a registry command (in-process for `--doc`, `POST /command` for `--app`); the CLI's
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
  `xstep.cascade.unit = MM`, `read.precision.mode` = file (uncertainty) or document [R5]. `ImportedShapes` returns
  the healed definitions (BRep bytes for the blob leaf) **and** the XDE product tree (definitions, occurrences with
  `TopLoc_Location`, names, colours, embedded GVP attributes) so no second reader exists. MVP (01): one llull solid per
  placed STEP solid (world placement, names, colours). The mapping of the product tree onto `components` +
  `insert_instance`, and the embedded-GVP check, are 04 XCH's extension of the same command (04 TR-XCH-07/-08).
  04's `import_iges` calls `importShapes(format: 'iges', …)` and stores the same `brep` blob leaf.
- **TR-KRN-21 (MUST, MVP) — persistence of imported geometry.** After healing, each definition is serialized
  with `BRepTools::Write` (text, versioned format) into a document blob keyed by sha256; the recipe leaf
  `{ op: 'brep', blob }` is what `evaluate` reads (`BRepTools::Read`). Optionally (`keepOriginal`) the STEP bytes
  are kept as a `model/step` blob for audit. Replay and reload never depend on the STEP reader version.
- **TR-KRN-22 (MUST, MVP) — content classification.** Before transfer, count roots by type: solids, closed
  shells, open shells, faces, wires, tessellated items (`TESSELLATED_*`, AP242). Tessellated-only files (NIST
  FTC 08 `-tg`, measured: plain reader returns a void shape) → no-op with diagnostic and suggestion to use mesh
  import; mixed → import B-rep, list skipped items.
- **TR-KRN-23 (SHOULD, V1) — GVP attributes for 04.** `importShapes` reads STEP geometric validation properties
  (volume, area, centroid; CAx-IF practice [R21]) with `STEPCAFControl_Reader::SetPropsMode(true)` and the
  `XCAFDoc_Volume` / `XCAFDoc_Area` / `XCAFDoc_Centroid` attributes [R33] and returns them, in file units, with the
  file length unit (two NIST AP203 files and one AP242 file carry GVP in inches — measured). The comparison, the unit
  conversion before comparison and the **single green / yellow / red band policy** are owned by 04 XCH
  (04 TECHNICAL_SPEC §5.3, `verify` of `import_step_exact`). KRN's VC-KRN-04 tolerances (1e-4 volume, 1e-3 area,
  0.05 mm centroid) are test tolerances for the pinned NIST files, not user-facing bands.
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

- **TR-KRN-40 (MUST, MVP) — exact properties.** New optional kernel method — the **one** mass-property method of
  `GeometryKernel` (superset of 04 XCH's GVP needs, which no longer defines its own):
  `massProperties(handle, { eps, reference }) → { volume, area, centroid, inertiaAtCentroid: Mat3,
bbox: [xmin, ymin, zmin, xmax, ymax, zmax] (optimal, `BRepBndLib::AddOptimal`), relError }` with `BRepGProp::VolumeProperties(shape, props, eps, onlyClosed=true)` (adaptive Gauss; `eps`
  default 1e-9 relative per face; the returned error estimate is reported) and
  `BRepGProp::SurfaceProperties` [R8]. `GProp_GProps::MatrixOfInertia()` is about the centre of mass;
  principal moments/axes by symmetric 3×3 Jacobi eigen-decomposition in `@lib`; radii of gyration
  k = √(I/m). Payload of `mass_properties` (extended):
  `{ volume, volumeUnit, area, areaUnit, centroid, inertia: { atCentroid: Mat3, atOrigin: Mat3, principal:
{ moments: Vec3, axes: [Vec3,Vec3,Vec3] }, unit: 'g·mm²' | 'mm⁵ (per unit density)' }, density?, mass?,
method: 'exact'|'closed-form'|'mesh', relErrorEstimate?, eps: Named<number>, densitySource?, provenance,
unverified: { value, reasons[] }, reviewRequired: { value, reasons[] } }` (`Named<T> = { value: T, unit, source,
defaulted }`, TR-KRN-102..104).
- **TR-KRN-40a (MUST, MVP) — one resolver, two callers.** The non-kernel path is the dynamics work's
  `geometry/massProperties.ts` (`MassProperties`, `InertiaTensor` `[Ixx,Iyy,Izz,Ixy,Ixz,Iyz]` with Ixy = −∫xy dm,
  `combineMassProperties`) and `geometry/entityMassProperties.ts`; this pack does not write another. M3 merges
  today's `inspect/solidVolume.ts` closed forms (sweep, loft, revolution/Pappus) into it and adds one
  `resolveMassProperties(doc, entity, densityOf, ctx)` in `geometry/` with the order exact kernel
  (`GeometryKernel.massProperties`, when a `brep` exists) → closed form → mesh, returning `method`. `mass_properties`
  (`commands/inspect/measureSolid.ts`) and dynamics (`dynamics/simulationModel.ts` `bodyMassProperties`) both call it,
  so a rigid body made of an OCC part gets exact inertia. `MassProperties` gains optional `area`, `bbox`, `relError`;
  `Mat3` / `atOrigin` / principal axes in the payload are derived from `InertiaTensor` (Jacobi in `@lib`).
- **TR-KRN-41 (MUST, MVP) — part-frame evaluation.** Before integration, the shape is **copied** (geometry, not
  only location) to a local frame centred on its bounding-box centre `c`, rounded to 1 mm
  (`BRepBuilderAPI_Transform(shape, T(−c), copy=true)`); results are shifted back: centroid += c; inertia at the
  centroid is translation-invariant; inertia about the origin by the parallel-axis theorem
  I_O = I_G + m(|r|²E − r rᵀ), r = centroid. Measured on OCCT 7.9.3 for a 100×50×20 box: raw Iyy relative error
  5e-16 at the origin, 3.8e-11 at 10 m, **1.2e-9 at 70 m**, 1.2e-7 at 1 km; moving back by `TopLoc_Location` only
  does not help (1.2e-9); geometry copied to the origin: 5e-16; part authored at origin and placed by location:
  3.3e-14 (`occt_behaviour_probe.json`). Target: ≤ 1e-12 relative at 70 m (VC-KRN-02). The mesh path
  (`meshMassProperties`) applies the same shift: triangles are translated by −c before integration and the result
  is moved back with `combineMassProperties`' parallel-axis term.
- **TR-KRN-42 (SHOULD, V1) — assemblies.** Instance properties are computed once per component definition in
  its own frame and combined: m = Σmᵢ; c = Σmᵢcᵢ/m with cᵢ = Rᵢĉᵢ + tᵢ; I_G = Σ[RᵢÎᵢRᵢᵀ + mᵢ(|dᵢ|²E − dᵢdᵢᵀ)],
  dᵢ = cᵢ − c — already implemented as `combineMassProperties` (dynamics work); this TR adds the per-definition
  cache (by `recipeKey`). Densities from 08's single `resolveDensity` (TR-MAT-10), passed as `densityOf`.
  Display-mesh volume is never used when an exact handle exists.

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
  compared on load; the native `llull-kernel` OCCT and the CadQuery/OCP version are pinned to the **same OCCT
  minor** (7.9.x) in `solver/` (Cargo / build script) / `server/python/requirements.txt` /
  `desktop/scripts/prepare-native.mjs` / `desktop/scripts/prepare-python.mjs`. The browser WASM kernel (7.4 today)
  is recorded as a different build, so TR-KRN-62's cross-build tolerance mode applies to it.
- **TR-KRN-62 (MUST, MVP)** `npm run quality:kernel`: rebuilds the golden plans with kernel results, the KRN
  plans and the KRN STEP set; compares to a committed baseline — same build: signatures equal; other build:
  counts equal and measures within VC-KRN-01 tolerances; drift report per model; baseline updates are reviewed.

### 5.7 Large assemblies & display (TR-KRN-70 .. 74)

- **TR-KRN-70 (SHOULD, V1) — shared definitions.** A component definition evaluates to one kernel shape;
  instances are `TopLoc_Location`-placed references (XDE model [R6]) — never copied geometry — so 10 000
  fasteners cost 1 evaluation and 1 tessellation. `import_step_exact` with 04's product-tree extension creates
  components for repeated STEP definitions (quality case `syn-bolt-grid`: 400 instances).
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

- **TR-KRN-80 (SHOULD, V1)** Exact export with assembly structure, names, colours and GVP is **04 XCH's
  `export_step_ap242`** (`STEPCAFControl_Writer`, 04 TR-XCH-01/-06/-07), computing GVP with TR-KRN-40. KRN only
  requires that it exists for the VC-KRN-14 round trip, and that the fixed `/out.step` scratch-path workaround
  (KI5 gotcha) is removed once the M2 native kernel is verified. `export_step_exact` stays AP214 / flat / no GVP.

### 5.9 Face-query port (TR-KRN-90 .. 92) — one optional kernel port for every pack

Five packs asked for face-level kernel queries independently. They merge into **one** optional port owned here;
the other packs consume it and define no `GeometryKernel` member of their own.

| Request (source pack, section)                                                                                        | Merged into                      |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 03 GDT TR-GDT-03: `ShapeFace` + centroid / normal / axis / radius / samples; §5.1 `faceContains?`                     | `faceDetails`, `faceContains`    |
| 05 FEA §5.1: `ShapeFace` + centroid / normal (planar) for `facesNear`                                                 | `faceDetails` (same record)      |
| 07 FTR §3.2: `faceGraph?(shape): FaceGraph` (surface params, loops, edge→faces, convexity)                            | `faceGraph`                      |
| 06 CMP §5.5: `faceGeometry?`, `projectOnFace?`, `evaluateFace?`, `tessellateFace?`                                    | same names                       |
| 02 SRF §5.8: `analysis?: SurfaceAnalysisPort` (`faceSamples`, `edgeSamples`, `edgeContinuity`, `distance`, `bspline`) | same names, folded into the port |

- **TR-KRN-90 (MUST, V1)** `GeometryKernel` gains one optional member `readonly faceQuery?: FaceQueryPort`. Manifold
  omits it (every consumer then reports "requires the OCC kernel"); the OCC kernel implements it in
  `packages/kernel-occt/src/occtFaceQuery.ts`. Face and edge indices are those of `ShapeTopology` (same `recipeKey`,
  same explorer order); persistent names (§5.3) resolve to these indices before a call. Every method returns null on
  an unsupported request and never throws (guarded like `topology`). Results are cached by `(recipeKey, method, args)`
  in the existing recipe cache.
- **TR-KRN-91 (MUST, V1)** One surface-parameter type for the whole port (merges 06 `FaceGeometry` and 07
  `SurfaceParams`; 06's `halfAngle` = `semiAngle`, 06's `'freeform'` = `'other'`).
- **TR-KRN-92 (SHOULD, V1)** Contract tests: one analytic fixture per surface type (plane, cylinder, cone, sphere,
  torus, B-spline) checked against closed forms (centroid, normal, curvature k = 1/r, projection distance) in
  `server/tests/occtFaceQuery.test.ts`; the consumer packs' VCs reuse it.

```ts
// packages/core/src/geometry/kernel.ts (sketch)
export type SurfaceParams =
  | { readonly type: 'plane'; readonly origin: Vec3; readonly normal: Vec3; readonly xDir: Vec3 }
  | { readonly type: 'cylinder'; readonly origin: Vec3; readonly axis: Vec3; readonly xDir: Vec3; readonly radius: number }
  | { readonly type: 'cone'; readonly apex: Vec3; readonly axis: Vec3; readonly xDir: Vec3; readonly semiAngle: number }
  | { readonly type: 'sphere'; readonly center: Vec3; readonly radius: number }
  | { readonly type: 'torus'; readonly center: Vec3; readonly axis: Vec3; readonly major: number; readonly minor: number }
  | { readonly type: 'other'; readonly kind: FaceSurface };

/** 03 TR-GDT-03 + 05 §5.1: located face record (index = ShapeTopology.faces index). */
export interface FaceDetail {
  readonly index: number;
  readonly surface: FaceSurface;
  readonly area: number;
  readonly centroid: Vec3; // BRepGProp::SurfaceProperties
  readonly normal?: Vec3; // planes (outward, material side)
  readonly axis?: { readonly origin: Vec3; readonly dir: Vec3 }; // cylinder / cone / sphere / torus
  readonly radius?: number; // cylinder, sphere; torus minor; cone at the face centroid
  readonly samples: readonly Vec3[]; // <= options.samples (default 64) points inside the trimmed face
}

/** 07 §3.2. */
export interface FaceGraphFace {
  readonly index: number;
  readonly surface: SurfaceParams;
  readonly reversed: boolean;
  readonly area: number;
  readonly loops: readonly (readonly number[])[]; // edge indices, outer loop first
  readonly uvBounds: readonly [number, number, number, number];
}
export interface FaceGraph {
  readonly faces: readonly FaceGraphFace[];
  readonly edgeFaces: readonly (readonly number[])[];
  readonly edgeConvexity: readonly ('convex' | 'concave' | 'smooth' | 'unknown')[];
}

/** 06 §5.5. */
export interface FaceProjection {
  readonly point: Vec3;
  readonly normal: Vec3;
  readonly uv: Vec2;
  readonly distance: number;
}

/** 02 §5.8 (types SurfaceSample, EdgeCurveSample, EdgeContinuitySample, NurbsSurfaceData as defined in 02 §5.8). */
export interface FaceQueryPort {
  faceDetails(shape: ShapeHandle, options?: { readonly samples?: number }): readonly FaceDetail[] | null;
  faceContains(shape: ShapeHandle, face: number, point: Vec3, tolerance?: number): boolean | null;
  faceGraph(shape: ShapeHandle): FaceGraph | null;
  faceGeometry(shape: ShapeHandle, face: number): { readonly surface: SurfaceParams; readonly uvBounds: readonly [Vec2, Vec2] } | null;
  projectOnFace(shape: ShapeHandle, face: number, points: readonly Vec3[]): readonly (FaceProjection | null)[] | null;
  evaluateFace(shape: ShapeHandle, face: number, uv: readonly Vec2[]): readonly { readonly point: Vec3; readonly normal: Vec3 }[] | null;
  tessellateFace(shape: ShapeHandle, face: number, deflection: number): (MeshData & { readonly uv: readonly number[] }) | null;
  faceSamples(
    shape: ShapeHandle,
    face: number,
    uv: ReadonlyArray<readonly [number, number]> | { readonly nu: number; readonly nv: number },
  ): readonly SurfaceSample[] | null; // k1, k2, gaussian K, mean H
  edgeSamples(shape: ShapeHandle, edge: number, count: number): readonly EdgeCurveSample[] | null;
  edgeContinuity(shape: ShapeHandle, edge: number, count: number): readonly EdgeContinuitySample[] | null;
  distance(
    shape: ShapeHandle,
    points: readonly Vec3[],
  ): readonly { readonly distance: number; readonly signed: number; readonly face: number }[] | null;
  bspline(shape: ShapeHandle, face: number): NurbsSurfaceData | null;
}

export interface GeometryKernel {
  /* … existing … */ readonly faceQuery?: FaceQueryPort;
}
```

OCC classes (union of the consumer packs' lists, to be added to the M2 `llull-kernel-occt` cxx bindings, TR-KRN-02):
`BRepGProp::SurfaceProperties`, `BRepAdaptor_Surface` (`GetType`, `Plane`/`Cylinder`/`Cone`/`Sphere`/`Torus`),
`BRepTools::UVBounds`, `BRepClass_FaceClassifier` / `BRepTopAdaptor_FClass2d`, `GeomAPI_ProjectPointOnSurf`,
`BRepLProp_SLProps` (normals, principal curvatures), `BRepExtrema_DistShapeShape`, `TopExp::MapShapesAndAncestors`
(edge → faces), `BRepMesh_IncrementalMesh` + `Poly_Triangulation` UV nodes, `GeomConvert` / `Geom_BSplineSurface`.

## 6. Interop & persistence

| Item                     | Format                                                                                                  | Notes                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Imported definition      | OCCT BRep text (`BRepTools::Write`, versioned) in `document.blobs`                                      | content-addressed; base64 in JSON; gzip in the desktop file container when > 1 MB (Q4) |
| Original STEP (optional) | `model/step` blob                                                                                       | audit / re-import; not used on replay                                                  |
| Document                 | `llull-document` v3                                                                                     | single envelope for every pack's slice; v2 → v3 migration (§3.1)                       |
| Exact export             | STEP AP214 (`export_step_exact`, today) → AP242 geometry + assembly + GVP (`export_step_ap242`, 04 XCH) | full AP242 PMI is gap XCH                                                              |
| Lightweight              | glTF (existing `export_gltf`), JT (gap XCH, ISO 14306 [R23])                                            | LOD ladder reused                                                                      |
| Code                     | CadQuery / build123d via `export_code`                                                                  | `brep` leaves lowered to `cq.importers.importBrep`-style loading of the blob (Q5)      |

Desktop files larger than the 512 MB body limit (`backendEnv.ts`) must use a sidecar blob directory next to the
document instead of inline base64 (V2).

## 7. CLI / MCP / UI surfaces

- **CLI (primary, AGENT_FIRST §1)**: every KRN capability is a registry command, found by `llull search exact
kernel` / `llull search step import` and documented by `llull describe <cmd>` (agent-written descriptions: what,
  when, units, refusals, next command — AF-02). Typical calls: `llull kernel_info --json`,
  `llull import_step_exact file=<path> --progress --json`, `llull validate_shape '{"entityIds":[…]}' --json`,
  `llull mass_properties entityId=<id> --json`, `llull check_model --json`. Heavy artefacts go to files with
  `--save` (STEP via 04's `export_step_ap242`, PNG via `render_view`). `--kernel occt` becomes the CLI default for
  `--doc` runs on desktop installs. `llull guide` gains a KRN section (AF-03): units (mm internal, document unit for
  params), aircraft axes / precision envelope (|x|,|y|,|z| ≤ 1e5 mm), id conventions for imported bodies, and the
  minimal correct plans (`validation/plans/krn-rib-pocket.json`, the W2 import sequence).
- **MCP**: same tools from the registry (`toToolSchemas`); `import_step` exchange tool `mode` param; toolsets:
  core (kernel_info, set_modeling_tolerance, check_model), measure (validate_shape, mass_properties),
  exchange (import/export), 3d (heal_shape).
- **UI (review / approval surface)**: kernel badge (`OCC 7.9.x` / `Manifold (fallback: <reason>)`), import report
  table, validation results, mass-property table with principal-axes gizmo, broken-reference badges; reviewer-only
  acts: accept a faceted body into an exact delivery and accept a kernel baseline (human gates, TR-KRN-105). The
  UI renders the same `data` the CLI returns; no KRN capability is UI-only.

### 7.1 Agent-first technical requirements (TR-KRN-100 .. 106)

- **TR-KRN-100 (MUST, MVP) — stable codes.** Every KRN refusal / finding returns `data.issues[]` (check commands) or
  `data.error` (refusals) as `{ code, severity: 'fail'|'warn'|'info', entityIds?, subShape?, paramPath?,
remediation }` with the codes of §7.2; the CLI exits 1 on a refusal (AF-11).
- **TR-KRN-101 (MUST, MVP) — units.** Param descriptions state units (lengths in the document length unit; `fuzzy`,
  `precision`, `maxTolerance`, `linear`, `maxImportTolerance` in mm; `angular` in rad; `eps` dimensionless relative);
  `data` numbers carry a unit suffix (`maxToleranceMm`, `centroidMm`) or a sibling `…Unit` field (`volumeUnit`,
  `inertia.unit`), as `mass_properties` already does for `volumeUnit` (AF-04, AF-10).
- **TR-KRN-102 (MUST, MVP) — named defaults + provenance.** `{ value, unit, source, defaulted }` for
  `modelingTolerance.linear` (1e-4 mm, source "OCCT STEP reader `read.precision.val` default [R5]"),
  `modelingTolerance.angular`, `maxImportTolerance` (0.01 mm, "llull policy TR-KRN-11"), `eps` (1e-9, "llull policy
  TR-KRN-40; BRepGProp adaptive Gauss [R8]"), boolean `fuzzy` (Precision::Confusion 1e-7 mm [R1] when omitted) and
  density (`densitySource`: material record id / legacy material / param). `data.provenance = { method, occtClass,
kernel: { name, occtVersion, build }, inputs: { entityIds, recipeKey, density } }` (AF-31, AF-35).
- **TR-KRN-103 (MUST, MVP) — `unverified` propagation.** `mass_properties` returns `unverified: { value, reasons[] }`
  with reasons `density_unverified` (no verified 08 MAT record, or record basis `typical` / `supplier_unstated` /
  `unspecified`), `method_mesh`, `faceted_body`, `import_gvp_red`, `import_gvp_not_checkable`; assembly totals OR
  the flags of their parts. `check_model` emits `KRN_MASS_INPUT_UNVERIFIED` (warn, cannot be filtered out) (AF-32).
- **TR-KRN-104 (MUST, MVP) — `reviewRequired`.** `mass_properties` and the `import_step_exact` report return
  `reviewRequired: { value, reasons[] }`: true for `purpose: 'weight-and-balance'` (new optional param), any
  `unverified` reason, `outside_precision_envelope`, `import_gvp_mismatch`, `tolerance_growth`. The summary appends
  "computed by llull, not approved — needs a qualified engineer" when true; summaries follow AF-36 order (done /
  passed / needs a human) (AF-33, AF-36).
- **TR-KRN-105 (MUST, V1) — human gates.** Accepting a faceted body into an exact delivery (`acceptUnverified` on 04's
  `export_step_ap242`) and accepting a kernel-regression baseline (`quality:kernel --accept`) require
  `ctx.caller.kind === 'human'` (09 TR-PLM-16; advisory in local CLI runs, enforced on an authenticated server);
  an agent gets `XCH_HUMAN_GATE` (04 export) / `KRN_HUMAN_GATE` (baseline) with the prepared request (AF-34).
- **TR-KRN-106 (SHOULD, MVP) — loop behaviour.** `import_step_exact` reports progress per stage (read, heal, sew,
  validate, blob) to the CLI `--progress` stream, respects `--timeout` (worker recycled on timeout, existing
  `LLULL_OCC_TIMEOUT_MS`), re-uses blobs by sha256 on re-run; `import_step_exact`, `heal_shape`,
  `set_modeling_tolerance` are pure commands, so `--dry-run` works unchanged (AF-40, AF-42).

### 7.2 Stable error codes (AF-11)

| Code                                                                                                                      | Severity                     | Raised by                                                     | When                                                                                                                              | Offending ids / paths                           | Remediation                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `KRN_NO_EXACT_KERNEL`                                                                                                     | fail                         | every `requiresKernel` KRN command                            | no kernel, or a kernel without the needed port (`importShapes`, `massProperties`, `validate`, `faceQuery`)                        | command name                                    | run on the desktop backend or with `--kernel occt`; `kernel_info` shows the active kernel                          |
| `KRN_KERNEL_FALLBACK`                                                                                                     | warn                         | `kernel_info`, `check_model`                                  | OCC failed to start; Manifold active                                                                                              | `fallbackReason`                                | restart the app; report the reason; exact results are unavailable until fixed                                      |
| `KRN_KERNEL_MISMATCH`                                                                                                     | warn                         | load, `kernel_info`, `check_model`                            | document written by another kernel / OCCT version                                                                                 | `kernelSettings.occtVersion` both values        | re-run the KRN plans and compare (`quality:kernel`) before relying on stored measures                              |
| `KRN_STEP_UNREADABLE`                                                                                                     | fail                         | `import_step_exact`                                           | Part 21 parse / transfer failure, truncated file                                                                                  | `fileName`                                      | check the file (sha256, size); try `verify_exchange_file` (04) for a census                                        |
| `KRN_STEP_TESSELLATED_ONLY`                                                                                               | fail                         | `import_step_exact`                                           | file holds only `TESSELLATED_*` geometry                                                                                          | `fileName`                                      | import as mesh with `import_step` (`mode: 'mesh'`) or 04's tessellated import                                      |
| `KRN_STEP_NO_SOLID`                                                                                                       | fail                         | `import_step_exact`                                           | no solid and no closable shell after sewing                                                                                       | `fileName`, open-shell count                    | retry with `sew: true` and a larger `precision` (mm) within `maxImportTolerance`; else import as surfaces (02 SRF) |
| `KRN_IMPORT_TOLERANCE_HIGH`                                                                                               | warn                         | `import_step_exact`, `heal_shape`, `validate_shape`           | a sub-shape tolerance > `maxImportTolerance`                                                                                      | entity id, sub-shape                            | `heal_shape` with a smaller `maxTolerance`; check the result with `validate_shape`; reviewer if it remains         |
| `KRN_GVP_MISMATCH`                                                                                                        | warn                         | `import_step_exact` (04 `verify`)                             | recomputed GVP outside the green band (04 §5.3)                                                                                   | entity id, property, sender / recomputed values | do not deliver as-is; report both values; qualified reviewer decides                                               |
| `KRN_HEAL_FAILED`                                                                                                         | fail                         | `heal_shape`, `import_step_exact`                             | shape still invalid after the healing pipeline                                                                                    | entity id, BRepCheck statuses                   | try `sew: false` / other `precision`; else keep the original and report                                            |
| `KRN_BLOB_MISSING` / `KRN_BLOB_HASH_MISMATCH`                                                                             | fail                         | load, `brep` leaf evaluation                                  | `brep` leaf references an absent blob or bytes whose sha256 differ                                                                | blob sha256, entity id                          | re-import the STEP file (`import_step_exact`); never edit the document by hand                                     |
| `KRN_BOOLEAN_FAILED`                                                                                                      | fail                         | `boolean`                                                     | BOP returned no valid result                                                                                                      | `a`, `b`, `data.argumentCheck` issues           | retry with `fuzzy` (mm, ≤ 0.1) or `heal_shape` the operands                                                        |
| `KRN_INVALID_RESULT`                                                                                                      | fail                         | any kernel node (commit gate)                                 | a result fails BRepCheck                                                                                                          | entity id, node op                              | change the parameters (smaller fillet radius, …); see `validate_shape`                                             |
| `KRN_BROKEN_REFERENCE`                                                                                                    | fail                         | replay of `fillet_edge` / `chamfer_edge` / later naming users | a stored `TopoName` resolves to no entity                                                                                         | step path, `TopoName`                           | re-pick with `edit_step_params` (new `edgeNames` / `edgesNear`)                                                    |
| `KRN_REFERENCE_RERESOLVED`                                                                                                | info                         | replay                                                        | a reference was re-resolved by history trace                                                                                      | step path, old / new name                       | none; listed for audit                                                                                             |
| `KRN_TOLERANCE_OUT_OF_RANGE`                                                                                              | fail                         | `set_modeling_tolerance`, `boolean` (`fuzzy`)                 | value outside policy (`linear` ∉ [1e-7, 1e-2] mm, `fuzzy` > 0.1 mm)                                                               | param path                                      | pass a value inside the range                                                                                      |
| `KRN_PRECISION_ENVELOPE`                                                                                                  | warn                         | build, import, `mass_properties`                              | geometry beyond \|x\|,\|y\|,\|z\| ≤ 1e5 mm                                                                                        | entity ids, bbox                                | move the part frame near the origin and place it by instance                                                       |
| `KRN_FACETED_RESULT`                                                                                                      | warn (fail for exact export) | `check_model`, exports                                        | an exact recipe fell back to triangles                                                                                            | entity id                                       | run on OCC; or a qualified reviewer accepts it (human gate)                                                        |
| `KRN_INVALID_BREP`, `KRN_SELF_INTERSECTION`, `KRN_SMALL_EDGE`, `KRN_SLIVER_FACE`, `KRN_OPEN_SHELL`, `KRN_NEGATIVE_VOLUME` | fail / warn                  | `validate_shape`, `check_model`                               | the TR-KRN-51 checks                                                                                                              | entity id, sub-shape (index MVP, `TopoName` V1) | `heal_shape`; rebuild the feature; reviewer if it is imported data                                                 |
| `KRN_MASS_INPUT_UNVERIFIED`                                                                                               | warn                         | `mass_properties`, `check_model`                              | TR-KRN-103 reasons                                                                                                                | entity ids, reasons                             | assign a verified material record (08 MAT `assign_material` with a record), use the exact kernel                   |
| `KRN_HUMAN_GATE`                                                                                                          | fail                         | kernel-baseline accept (`quality:kernel --accept`)            | agent caller on a human-gated act (the faceted-delivery gate is 04's `export_step_ap242 { acceptUnverified }` → `XCH_HUMAN_GATE`) | act, entity ids                                 | hand the prepared request to a qualified reviewer in the desktop app                                               |
| `KRN_DRIFT_TOPOLOGY` / `KRN_DRIFT_MEASURE`                                                                                | fail / warn                  | `quality:kernel`                                              | cross-build drift beyond tolerance                                                                                                | model id, measure                               | review the drift report; baseline change is a human gate                                                           |

Existing lowercase `check_model` codes (`degenerate_size`, …) stay unchanged; new KRN findings use the `KRN_*` codes.

### 7.3 Agent-first compliance (AGENT_FIRST.md)

| AF           | Where satisfied                                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AF-01        | §4: every capability is a registry command; FR-KRN-17; VC-KRN-17                                                                                        |
| AF-02, AF-03 | §7 CLI bullet (descriptions, `llull guide` KRN section)                                                                                                 |
| AF-04, AF-10 | TR-KRN-101; FR-KRN-21; VC-KRN-17, VC-KRN-23                                                                                                             |
| AF-05        | `validation/plans/*.json` validate with `llull run … --validate` (checked in review: all valid against the real zod schemas)                            |
| AF-11        | TR-KRN-100, §7.2; FR-KRN-19; VC-KRN-19                                                                                                                  |
| AF-12        | heavy outputs via `--save` (STEP, PNG); import report bounded per body                                                                                  |
| AF-13        | TR-KRN-60 determinism; FR-KRN-10; VC-KRN-10                                                                                                             |
| AF-20        | `validate_shape` + `check_model`; FR-KRN-20; VC-KRN-09, VC-KRN-19                                                                                       |
| AF-21        | numeric equivalents: validity issues, tolerance values, inertia tensor and principal axes, `data.instancing` instead of viewport inspection (FR-KRN-11) |
| AF-22        | `render_view … --save view.png` in W1 / W2                                                                                                              |
| AF-23        | FUNCTIONAL_SPEC §7 (CLI + JSON assertions), `validation/README.md` §3.1                                                                                 |
| AF-30        | tolerance policy and validity rules as data (TR-KRN-10/11/51) applied by the check commands                                                             |
| AF-31, AF-35 | TR-KRN-102; FR-KRN-22; VC-KRN-23                                                                                                                        |
| AF-32        | TR-KRN-103; FR-KRN-23; VC-KRN-20                                                                                                                        |
| AF-33, AF-36 | TR-KRN-104; FR-KRN-24; VC-KRN-21                                                                                                                        |
| AF-34        | TR-KRN-105; FR-KRN-25; VC-KRN-22                                                                                                                        |
| AF-40, AF-42 | TR-KRN-106; FR-KRN-26; VC-KRN-24                                                                                                                        |
| AF-41        | desktop OCC (bundled native `llull-kernel`, RS1) + bundled CPython, no network (KI6); `NATIVE_TOOL_MISSING` → WASM / Manifold fallback; `KRN_NO_EXACT_KERNEL` when no exact kernel is available |

## 8. Performance & robustness budgets

Reference machine for budgets: the desktop CI runner (to be fixed in KI7). Values marked TBD are measured
once in M2 and then ratcheted. Budgets apply to the native `llull-kernel` sidecar (§2.A). It has no wasm32 4 GB
address-space ceiling (kernel memory is bounded by the caps below, not by the runtime) and may use OS threads;
BOP / meshing parallelism stays off by default for determinism (TR-KRN-60, Q8). The browser WASM fallback has no
budget beyond FR-KRN-02 / VC-KRN-13.

| Operation                                            | Budget                                                                                                | Basis                                                                                                          |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| OCC kernel cold start (desktop `llull-kernel`)       | ≤ 2 s                                                                                                 | KI4: 0.8-1 s for OCCT 7.4 WASM; TBD — measure for the native 7.9 sidecar                                       |
| Boolean on primitives                                | ≤ 200 ms                                                                                              | KI4: ~180 ms (7.4)                                                                                             |
| STEP read + heal, ≤ 2 MB / ≤ 700 faces single part   | ≤ 2 s in the sidecar                                                                                  | measured native OCP 7.9.3 read: 0.01-0.84 s on the 28 NIST files (`nist_occt_reference.json`); sidecar TBD     |
| `mass_properties` exact, ≤ 700 faces                 | ≤ 300 ms                                                                                              | TBD measure                                                                                                    |
| `validate_shape` (no self-intersection), ≤ 700 faces | ≤ 300 ms                                                                                              | TBD measure                                                                                                    |
| Topology naming overhead per node                    | ≤ 20 % of node evaluation time                                                                        | FreeCAD reports negligible impact (search summary [R16]); TBD measure                                          |
| Instancing                                           | 10 000 instances of one 300-face part: 1 evaluation, ≤ 1 draw call per LOD/material, ≥ 30 fps         | TBD — display gate                                                                                             |
| Single OCC call timeout                              | 30 s default (`LLULL_OCC_TIMEOUT_MS`)                                                                 | existing                                                                                                       |
| Kernel memory                                        | recipe cache eviction (existing) + blob cache cap 1 GB on desktop                                     | TBD                                                                                                            |
| Robustness                                           | 0 server crashes on the quality corpus in exact mode; every kernel crash / abort recycles the process | `isolatedKernel.ts` pattern (existing for the worker); same for `llull-kernel`                                 |

## 9. Test strategy

| Layer                                                         | Test                                                                                                                                                                                                                                                                | VC                          |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Unit (core, no kernel)                                        | `kernel_info` / `set_modeling_tolerance` schema + purity + failure; recipe `brep`/`heal`/`fuzzy` key & validation; v2→v3 migration; parallel-axis / principal-axes helpers in `@lib` against `analytic_solids.json`                                                 | VC-KRN-01 (math), VC-KRN-11 |
| Unit (server, real OCC: `server/tests/occt*.test.ts` pattern) | analytic solids and far-box mass properties; fuzzy boolean; commit validity gate; `import_step_exact` on a small committed synthetic STEP; naming grammar on box/fillet/boolean                                                                                     | VC-KRN-01, 02, 08, 09       |
| Golden (`tests/golden/plans.ts`)                              | KRN plans from `validation/plans/` (aliases, id-normalised snapshots, replay equality); renaming plan expected to fail until V1 (registered as known issue)                                                                                                         | VC-KRN-03, 03b, 07          |
| Quality gate                                                  | `quality:step` gains `--mode brep` (validity after heal, exact volume vs `quality/step_reference.py`, save/load of blobs) over `quality/corpus.json`; NIST set pinned as a new `aerospace` group (archive URL + sha256, see `validation/README.md`); GVP comparison | VC-KRN-04, 04x, 05, 06      |
| Kernel regression (new `quality:kernel`)                      | signatures + measures vs baseline; cross-version tolerance mode; native `llull-kernel` vs the committed OCP 7.9.3 reference files                                                                                                                                    | VC-KRN-10, VC-KRN-25        |
| Native (`npm run native:check`)                               | `cargo test` + `cargo clippy -D warnings` on `llull-kernel-occt`; protocol round trip per `KernelOps` op                                                                                                                                                            | VC-KRN-25                   |
| Display gate                                                  | 10 000-instance scene, 70 m station z-fighting screenshot                                                                                                                                                                                                           | VC-KRN-12, TR-KRN-73        |
| Desktop (`npm --prefix desktop test`)                         | backend env contains `LLULL_KERNEL=occt`; `kernel_info.active === 'occt'`; forced failure → fallback warning                                                                                                                                                        | VC-KRN-11                   |
| Agent-first (CLI scripts, `--json` + exit codes)              | wrong calls → codes; legacy-material rib → `unverified`; weight-and-balance purpose → `reviewRequired`; agent `acceptUnverified` → `XCH_HUMAN_GATE`, agent baseline accept → `KRN_HUMAN_GATE`; named defaults + provenance; `--dry-run` / `--timeout` on import     | VC-KRN-19 .. 24             |
| Production-gate scenario                                      | "Supplier STEP round trip": import NIST CTC 01 AP242 → drill + pocket + fillet → validate → mass → `export_step_ap242` with GVP (04) → re-import → GVP within 1e-6 of the exported values                                                                           | VC-KRN-04, 09, TR-KRN-80    |

Coverage gate (90/85/90/90) applies to new code in `packages/core/src/{commands,geometry}`.

## 10. Delivery plan

| Milestone                                                                                                                                 | Content                                                                                                                                                                                                               | TRs                                 | Effort (eng-weeks) | Depends on                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------ | ------------------------------------------------------------------- |
| M1 OCC default                                                                                                                            | desktop env, `kernel_info`, status badge, provenance fields + migration, faceted flag                                                                                                                                 | 01, 04, 61 (fields), FR-KRN-16      | 1.5                | —                                                                   |
| M2 Native kernel (RS-1)                                                                                                                   | `llull-kernel` sidecar: crate `llull-kernel-occt` (Rust + cxx, OCCT 7.9.x), `KernelOps` over stdio, `server/src` proxy (timeout, recycle, blob resend), fallback chain, bundling (`prepare-native.mjs`), `native:check`, KI7 measurements, version alignment with OCP | 02, 05, 61                          | 6-8                | M1, RS-0 (`solver/` workspace)                                      |
| M3 Precision & mass (merged with 04 XCH M1: KRN owns `massProperties`; XCH M1 adds only `geometric_validation_properties` + `lib/step21`) | tolerance policy + command, part-frame mass properties (incl. area, bbox for GVP), inertia/principal, local-frame tessellation, depth precision; one resolver over the dynamics mass engine (TR-KRN-40a)              | 10, 11, 40, 40a, 41, 72, 73         | 3                  | M1 (M2 for exception-safe GProp); **`feat/motion-dynamics` merged** |
| M4 Exact import (merged with 04 XCH M3: KRN owns the command, reader, blob leaf; XCH M3 adds verify / provenance / product tree on top)   | `importShapes` (STEP; IGES entry point for 04), blobs, `import_step_exact`, healing, classification, report, MCP/CLI wiring, quality `--mode brep`, v3 envelope + migration (§3.1)                                    | 20, 21, 22, 23 (GVP attributes), 24 | 5-7                | M2                                                                  |
| M5 Robustness                                                                                                                             | commit validity gate, `validate_shape`, fuzzy booleans, argument analysis                                                                                                                                             | 12, 13, 50, 51                      | 2                  | M2                                                                  |
| M6 Regression                                                                                                                             | signatures, `quality:kernel`, baselines                                                                                                                                                                               | 60, 62                              | 2                  | M4                                                                  |
| M7 Persistent naming                                                                                                                      | element maps, naming grammar, resolution, UI repair, golden renaming plan green                                                                                                                                       | 30, 31, 32                          | 8-12               | M2, M6                                                              |
| M8 Assemblies                                                                                                                             | shared definitions, assembly mass properties, instancing of results, LOD (GVP comparison and `export_step_ap242` moved to 04 XCH M2/M3)                                                                               | 42, 70, 71                          | 4-6                | M4, M7 (names for PMI later), 04 XCH M3 (product tree)              |
| M9 Browser worker                                                                                                                         | Web Worker command execution on the WASM binding (opencascade.js 1.1.1; a newer WASM build optional, low priority)                                                                                                     | 03                                  | 2-3                | M2                                                                  |
| M10 Face-query port                                                                                                                       | `GeometryKernel.faceQuery` (§5.9): faceDetails, faceContains, faceGraph, faceGeometry, projectOnFace, evaluateFace, tessellateFace, faceSamples, edgeSamples, edgeContinuity, distance, bspline (OCC); contract tests | 90, 91, 92                          | 3                  | M2                                                                  |

Total ≈ 36.5-48.5 engineer-weeks (RS1: M2 4-6 → 6-8 for the native sidecar, M9 3-4 → 2-3 without the native spike; M8 −1 after moving GVP/export to 04; +3 for the face-query port M10, which removes the
per-pack kernel work from 02/03/05/06/07). Downstream gaps: 07 FTR (holes/pockets need M4, M7), 03 GDT and 04 XCH (face names
M7; `massProperties` M3 and `import_step_exact` M4 for XCH M1/M3), 02 / 03 / 05 / 06 / 07 (face-query port M10), 05 FEA (exact faces M4, names M7), 02 SRF (NURBS ops need M2), 09 PLM (provenance M1/M6).

## 11. Open questions / decisions needed

| #   | Question                      | Options                                                                                                                                                 | Recommendation                                                                                                       |
| --- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Q1  | Desktop kernel binary         | (a) OCCT 7.9.x WASM in the Node worker (one code path with browser); (b) native OCCT via bundled CPython OCP 7.9.3 child process; (c) native Node addon | **Resolved by RS1 (2026-10-18):** native OCCT 7.9 in the Rust `llull-kernel` sidecar (§2.A); WASM for the browser only |
| Q2  | Default modelling tolerance   | 1e-4 mm (OCCT STEP default) vs 1e-3 mm vs per-document                                                                                                  | 1e-4 mm, user-settable in [1e-7, 1e-2]                                                                               |
| Q3  | Non-mm documents              | scale at kernel boundary vs store kernel geometry in mm and treat units as display                                                                      | store kernel geometry in mm (OCC is mm-tuned [R1]); decision needed on existing `units` semantics                    |
| Q4  | Blob storage                  | inline base64 vs gzip container vs sidecar directory                                                                                                    | inline ≤ 1 MB, gzip container above, sidecar for > 512 MB documents                                                  |
| Q5  | Code export of imported parts | embed blob path in CadQuery code vs emit STEP next to the script                                                                                        | emit the healed BRep file next to the script and load it                                                             |
| Q6  | Naming grammar compatibility  | own grammar vs FreeCAD-compatible element names                                                                                                         | own grammar, documented; FreeCAD's shows feasibility [R15] but is GPL/LGPL-coupled to its data structures            |
| Q7  | GVP disagreement policy       | warn vs block                                                                                                                                           | warn; block only on exact-export round trip (production scenario)                                                    |
| Q8  | Parallel BOP                  | off (determinism) vs on (speed)                                                                                                                         | off by default, on for large assemblies after determinism is proven equal (native threads available since RS1)       |

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
- [RS1] Native compute programme — [../../decisions/RS1-native-compute.md](../../decisions/RS1-native-compute.md) (owner decision 2026-10-18)
- [R33] OCCT V7_8_0 toolkit PACKAGES and XCAFDoc / STEPCAFControl / BOPAlgo headers — https://raw.githubusercontent.com/Open-Cascade-SAS/OCCT/V7_8_0/src/TKTopAlgo/PACKAGES (accessed 2026-10)
- llull code and decisions cited by path in §1 (KI4, KI5, KI6); measured data: `validation/occt_behaviour_probe.json`,
  `validation/occt_crosscheck.json`, `validation/nist_occt_reference.json`, `validation/nist_gvp_vs_occt.json`

## 13. Implementation status (AERO-2)

### 13.A Mass properties (M3)

Built:

- `GeometryKernel.massProperties` for OCC: `packages/kernel-occt/src/occtMass.ts`, wired in `kernelFromOps` (`KernelOps.massProperties`). The worker proxy forwards it (`server/src/isolatedKernel.ts`); the worker entry dispatches by operation name and needed no change. Manifold omits it.
- Part-frame evaluation (TR-KRN-41): the shape is copied and translated by the bounding-box centre rounded to 1 mm, integrated there, and the centroid is shifted back. The mesh path does the same in `meshMassProperties`.
- `@lib/symmetricEigen`: Jacobi eigen-decomposition of a symmetric 3×3 (ascending moments, right-handed unit axes, fixed sign rule). `shiftInertia` (parallel axis) is now exported from `geometry/massProperties.ts`.
- `geometry/resolveMassProperties.ts` (TR-KRN-40a): exact kernel, then closed form, then mesh. The closed-form volumes moved to `geometry/closedFormVolume.ts`; `solidVolume` and the resolver share them. Box, cylinder and sphere moved to `geometry/primitiveMass.ts`; `entityMassProperties.ts` is gone. Instances combine children with `combineMassProperties`; a child without a material inherits the instance material.
- `bodyMassProperties` and `buildSimulationModel` take an optional kernel; `add_rigid_body`, `simulate_motion` and `inspect_dynamics` pass `ctx.kernel`.
- `mass_properties` (extended, nothing removed): `centroid`, `area`/`areaUnit`, `inertia { atCentroid, atOrigin, about, principal, radiiOfGyration, unit, frame }`, `method` (`exact`/`closed-form`/`mesh`), `relErrorEstimate`, `provenance`, `reviewRequired`, `warnings` (`KRN_PRECISION_ENVELOPE`), and params `frame`, `about`, `purpose`. Reasons `method_mesh` and `faceted_body` go into `reviewRequired.reasons`; `unverified` / `unverifiedReasons` stay about the density, as AERO-1 shipped them (review fix). The summary appends "computed by llull, not approved — needs a qualified engineer" when review is required.

Tests: `tests/unit/massResolver.test.ts` (Jacobi, analytic corpus, mesh part frame at 70 m, payload, failure paths, `is pure`, exact path with a fake kernel, dynamics) and `server/tests/occtMassProperties.test.ts` (real OCC: box 100×50×20 at the origin and at 70 m to 1e-12, cylinder and sphere to 1e-9, `mass_properties` on a kernel result).

Deviations:

- The adaptive integration uses `VolumeProperties_2` with eps 1e-12, not 1e-9: at 1e-9 the cylinder transverse inertia was off by 4e-8. There is no `eps` parameter yet. (VC-KRN-25 later showed the adaptive rule itself drifting on toroidal / freeform faces, up to 2.7e-4 in inertia; the native kernel uses the default Gauss rule, §13.D, validation/README.md §5 finding 7; `occtMass.ts` still adaptive.)
- `method` is `closed-form` where it was absent before. Loft, subdivision, non-round sweep and a revolution that crosses its axis now report `mesh` (their volume is a triangle sum).
- Cone, torus, wedge, pyramid, extrusion, round sweep and revolution have a closed-form volume only; their centroid and inertia come from the triangles, scaled by closed-form volume / mesh volume.
- A kernel with `topology` but no `massProperties` gives an exact volume with mesh inertia scaled to it (`method` stays `exact`; `method_mesh` is added to the review reasons).
- `unverified` stays a boolean with `unverifiedReasons`, as AERO-1 shipped it, and only carries density reasons; `reviewRequired` is an object.
- Behaviour change without a kernel: cone, torus, wedge, pyramid, extrusion and revolution bodies now take their volume (and so their mass) from the closed form, with mesh inertia scaled to it. Their dynamics masses move by the display-mesh error (about 1 % or less); box, cylinder and sphere are unchanged. A `brep` mesh measured on the server (OCC, exact) and in a browser on Manifold (mesh) can differ by the same amount: `method` says which.
- Bounds in the envelope check come from the kernel (exact) or `entityBoundsInDoc`; the OCC bounds use `BRepBndLib.Add`, not `AddOptimal`.
- No worker-proxy test: the OCC worker does not start in the build sandbox (`isolatedKernel.test.ts` times out there too).

### 13.B Face-query port (M10)

Built: the OCC face-query port (TR-KRN-90..92), the worker proxy, and one agent command, `inspect_faces` (AF-01).

- Port contract: `packages/core/src/geometry/kernelPorts.ts` (`FaceQueryPort`, unchanged except the notes below). `KernelOps.faceQuery` (`FaceQueryOps<S>`, the same methods on native shapes) is wired in `kernelFromOps` (`shapeKernel.ts`): handles resolve through the recipe cache, every call runs inside the kernel `call(...)` and any throw becomes null with a warning. A key-only handle that is no longer cached still throws `SHAPE_NOT_CACHED`, so the worker proxy can resend the recipe. Manifold omits the port.
- OCC implementation: `packages/kernel-occt/src/occtFaceQuery.ts` (the ops), `occtFaceSurface.ts` (surface parameters, normals, curvature), `occtFaceDistance.ts` (point distance), `occtFaceGraph.ts` (adjacency and convexity). Face and edge indices come from `uniqueSubShapes`, the enumeration `ShapeTopology` uses; `occtTopology.ts` now also exports `subShapeIndexer` and `surfaceKindOf`.
- Worker: `server/src/isolatedKernel.ts` forwards the 12 methods as `faceQuery.<method>` requests (key-only handles first, resend on `SHAPE_NOT_CACHED`); `occtWorker.ts` dispatches them.
- Command: `inspect_faces` in `packages/core/src/commands/brep/faces.ts`, toolset `3d`. Refusals carry `error.code`: `KRN_NO_EXACT_KERNEL`, `KRN_SHAPE_UNAVAILABLE`, `KRN_FACE_INDEX`, `KRN_FACE_QUERY_FAILED`, `ENTITY_NOT_FOUND`, `ENTITY_NOT_SOLID`. With no kernel installed at all the registry answers first with `CMD_KERNEL_UNAVAILABLE`.

Behaviour worth knowing:

- Normals and curvature signs are relative to the outward face normal (face orientation applied): a convex sphere has k1 = k2 = +1/r, a bore has k2 = -1/r. k1 >= k2; Gaussian = k1 k2, mean = (k1 + k2) / 2.
- `faceContains` and `projectOnFace` use the exact distance to the trimmed face (`BRepExtrema_DistShapeShape` from a vertex), not the untrimmed surface. A point beyond the trim projects onto the face boundary.
- `distance` measures against the shells, because OCC reports 0 for a point inside a solid. `signed` is negative inside a solid (`BRepClass3d_SolidClassifier`). `face` is the nearest face index; -1 when the nearest point is on an edge shared by two faces or on a vertex (a seam edge counts as its single face).
- `faceGraph` convexity is taken at the edge mid point: smooth when the outward normals agree within 1e-6 rad, else convex or concave from the sign of (n0 x t) . n1 with the edge walked in face 0's loop orientation. A seam is smooth; degenerate edges, edges with a number of faces other than 2, and anti-parallel normals are unknown.
- A cone with a negative OCC semi angle is reported as the equivalent cone opening along +axis with a positive angle.
- Samples are the centres of a uv grid kept when `BRepClass_FaceClassifier` says IN, thinned evenly to the requested count.

Returns null (not implemented in this kernel build): `tessellateFace` (OCC 7.4 bindings give no UV access to the triangulation), `edgeSamples` and `edgeContinuity` (need third derivatives and continuity along an edge), `bspline` (no `Geom_BSplineSurface` pole readout verified). B-spline faces are therefore reported as surface `bspline` / `other` only.

Tests: `server/tests/occtFaceQuery.test.ts` (real OCC; one fixture per surface type: box, cylinder, cone, sphere, torus; closed forms for centroid, area, normal, curvature, projection distance, signed distance, graph counts; a bore, a stepped union and a filleted box; the worker proxy). `tests/unit/brepFaces.test.ts` (command: happy path, filters, samples, graph, every refusal, purity) and `tests/unit/contract/faceQueryOps.test.ts` (`kernelFromOps` wiring). The tool-schema snapshot gained one entry, `inspect_faces`. The B-spline fixture of TR-KRN-92 is skipped for lack of a verified B-spline readout.

Deviations from the sketch in 5.9:

- `FaceGraphFace.uvBounds` is `[uMin, uMax, vMin, vMax]` (OCC order); `faceGeometry.uvBounds` stays `[[uMin, vMin], [uMax, vMax]]`.
- `ShapeHandle` and `FaceSurface` moved to `packages/core/src/geometry/kernelTypes.ts` (re-exported by `kernel.ts`) because `kernel.ts` and `kernelPorts.ts` imported each other and `npm run arch` rejected the cycle.
- `EdgeCurveSample`, `EdgeContinuitySample` and `NurbsSurfaceData` are no longer exported (knip: no consumer yet); export them again when a pack uses them.
- Results are not cached by `(recipeKey, method, args)`; the shapes are cached and each query is cheap.

### 13.C Kernel provenance, v3 envelope, exact STEP import (M1 + M4 MVP)

Built (lane C of AERO-2). All of it runs on the bundled opencascade.js 1.1.1 (OCCT 7.4.0p1); the native 7.9 kernel of TR-KRN-02 (M2, RS-1) is not part of this step.

Built items and where they live:

- **M1, kernel selection (TR-KRN-01).** `desktop/src/backendEnv.ts` sets `LLULL_KERNEL: 'occt'`. An inherited `LLULL_KERNEL=manifold` is passed through, any other inherited value is ignored. Tests: `desktop/tests/units.test.ts`; the e2e test `desktop/tests/backend.e2e.test.ts` asserts the active kernel with `kernel_info`.
- **`kernel_info` (TR-KRN-04, TR-KRN-102).** `packages/core/src/commands/document/kernelInfo.ts`, read-only, toolset core. Payload: `active`, `occtVersion`, `build`, `capabilities`, `isolation`, `fallbackReason`, `modelingTolerance` as named defaults `{ value, unit, source, defaulted }`, `documentKernel`, `issues[]` with `KRN_KERNEL_FALLBACK` and `KRN_KERNEL_MISMATCH`. `wasmBytes` is not reported.
- **Kernel descriptions.** `GeometryKernel.info()` on OCC (`occtKernel.ts`: `7.4.0p1`, `opencascade.js@1.1.1`) and on Manifold (capabilities only). `server/src/geometryKernel.ts` wraps the installed kernel and adds `isolation` (`worker` or `in-process`) and, after a failed OCC start, `fallbackReason`. The worker proxy forwards `info`, `importShapes` and `loadBlob`.
- **`set_modeling_tolerance` (TR-KRN-11).** `commands/document/modelingTolerance.ts`, mutating, toolset core. Ranges: linear 1e-7 to 1e-2 mm (the spec value), angular 1e-12 to 1e-3 rad and maxImportTolerance 1e-7 to 1 mm (chosen here, the spec gives none), maxImportTolerance not below linear. Refusal: `KRN_TOLERANCE_OUT_OF_RANGE` with the offending param paths.
- **Model.** `CadDocument.kernelSettings` and `CadDocument.blobs` (`model/types.ts`), helpers in `model/kernelSettings.ts` and `model/blobs.ts` (sha256 over the UTF-8 text, base64 bytes, `size`).
- **Persistence v3 (section 3.1).** `commands/persistence/serialization.ts` writes `version: 3` and reads 1, 2 and 3. The v2 → v3 step needs no rewrite: `kernelSettings` stays absent on an old file (it never recorded which kernel wrote it; tolerances default through `modelingToleranceOf`), whatever kernel is running, so loading stays a pure function of the file (review fix: an earlier version stamped the ambient kernel, which broke live-sync hashes and invented provenance). A v3 file is not rewritten. `blobs` stays absent when absent (the writer never writes an empty slice; this differs from the sketch "blobs absent becomes {}"). `persistence/kernelValidation.ts` validates the slices on load: every blob must hash to its key (with matching `mediaType` and `size`) and every `brep` leaf must reference an existing blob; otherwise the load is refused with `KRN_BLOB_HASH_MISMATCH` or `KRN_BLOB_MISSING` in the message. The recipe validator (`geometry/shapeRecipe.ts`) now accepts the `brep` leaf.
- **Kernel provenance (TR-KRN-61).** Written into the document by the commands that use the exact kernel, from their own `ctx`: `import_step_exact` stamps `kernelSettings.kernel/occtVersion/build` on the first exact import, `set_modeling_tolerance` too (`persistence/kernelStamp.ts`). `serializeDocument` is a function of the document alone (review fix: it no longer reads the ambient kernel at save time). `KRN_KERNEL_MISMATCH` compares the stored kernel and OCCT version with the active ones.
- **Hardening (review fixes).** `loadBlob` refuses text whose sha256 differs from its key (`KRN_BLOB_HASH_MISMATCH` warning), so a document that bypasses `deserializeDocument` (live snapshot, store hydrate) cannot poison a shared kernel. `import_step_exact` accepts at most 64 MiB of Part 21 text. A recipe nested deeper than the blob scan (4 × `MAX_RECIPE_DEPTH` JSON levels) is refused on load instead of skipping its blob check. The worker proxy stops a blob re-send as soon as a reply recycles the worker. Open: the STEP text also sits in the step params (replay re-runs the reader); storing it as a blob referenced by sha (`blobId`, §4) is the follow-up.
- **Blobs reach the kernel.** `execute` gives the kernel every B-rep blob it has not seen (`GeometryKernel.loadBlob`, tracked per kernel in a WeakMap) before any command runs. `kernelFromOps` forgets cached failures when a new blob arrives. The OCC ops keep the blob text and rebuild the shape with `BRepTools.Read_2` after a cache eviction; the worker proxy keeps its own copy and re-sends it to a respawned worker.
- **M4 MVP, `importShapes('step', ...)`.** `packages/kernel-occt/src/occtImport.ts`: STEPControl*Reader_1, census (solids, shells, open shells, faces), tessellated-only detection (void transfer plus a `TESSELLATED*`text scan), per solid BRepCheck as read, ShapeFix_Shape (precision, max, min tolerance), sewing of loose shells and faces with`ShapeFix_Solid.SolidFromShell`, BRepCheck after, maximum sub-shape tolerance, free edges (ShapeAnalysis_FreeBounds), faceted flag, `BRepTools.Write_2` text.
- **`import_step_exact`.** `commands/exchange/importStepExact.ts` and `stepImportReport.ts`, toolset exchange, `requiresKernel`. Params: exactly one of `stepBase64` or `text`; `fileName`, `heal`, `sew`, `name`, `keepOriginal`. One `mesh` entity per solid, `brep` = `{ op: 'brep', blob }`, wrapped in a `scale` node (1 / mm per unit) when the document unit is not mm. `data.report`: census, per body `validAsRead`, `validAfterHeal`, `actions`, `maxToleranceMm`, `freeEdges`, `faces`, `faceted`, `skipped`, `warnings` (`KRN_IMPORT_TOLERANCE_HIGH` above the document `maxImportTolerance`), `reviewRequired`. Refusal codes: `KRN_NO_EXACT_KERNEL`, `KRN_STEP_UNREADABLE`, `KRN_STEP_TESSELLATED_ONLY`, `KRN_STEP_NO_SOLID`, `KRN_HEAL_FAILED` (any solid still invalid after healing: nothing is imported). CLI: `llull import_step_exact file=part.step` (`server/src/cli/exchange.ts`).

Tests: `tests/unit/kernelProvenance.test.ts`, `tests/unit/importStepExact.test.ts` (fake kernel from `tests/helpers/fakeExactKernel.ts`), `tests/unit/contract/persistenceV3.test.ts`; live OCC in `server/tests/occtStepImport.test.ts` (kernel-exported box 100x50x20 and cylinder with volumes equal to the closed form within 1e-9; shell-only files sewn or refused; the three committed 07-pack parts against their analytic volumes within 1e-6; NIST CTC-01 AP242; save, load into a fresh kernel and `replay_history` give identical ids and blob hashes; CLI `file=`), `server/tests/isolatedKernelBlobs.test.ts` (blobs survive a worker abort), `server/tests/kernelChoice.test.ts` (isolation and fallback reason). Snapshot changes: the tool-schema snapshot gains `kernel_info`, `set_modeling_tolerance`, `import_step_exact` and the `load_document` description names v3; the golden snapshots change only `"version": 2` to `3`.

Deviations from the plan:

- OCCT 7.4.0p1 binding instead of the native 7.9 kernel (M2). No `read.*` statics exist in this build, so the reader runs with its defaults (millimetres, precision from the file); the document tolerance drives ShapeFix and sewing only.
- No XDE product tree: names and colours of the STEP are not read (`name` sets the entity name), no component or instance mapping, no GVP attributes (04 XCH). `STEPCAFControl_Reader` is bound but not used.
- Replay re-runs the STEP reader from the stored step params (`stepBase64` or `text`) instead of reading the blob only; the blob text is deterministic across two imports of one file in one process (tested). `blobId` and `precisionMode` are not implemented.
- STEP input must be valid UTF-8 text (Part 21 is ASCII with escapes); anything else is `KRN_STEP_UNREADABLE`.
- `heal_shape`, `validate_shape` and the `heal` recipe node are not built; `import_step_exact` fails with `KRN_HEAL_FAILED` instead.

Open items: set `LLULL_KERNEL` in the browser-only build (TR-KRN-03), the UI status badge for the fallback reason (`useKernelStatusStore`), `check_model` issues for the mismatch and fallback codes, `quality:kernel` (TR-KRN-62), and the rest of the native kernel (`llull-kernel`, M2 / RS-1; first slice in §13.D).

### 13.D Native kernel sidecar, first two slices (M2 / RS-1)

Built (`LLULL_KERNEL=occt-native`; opt-in on server and CLI; the desktop default since the full VC-KRN-25 suite passed on 2026-10-19,
KI7):

- **OCCT 7.9.2, shared, linked dynamically (LGPL-2.1 with exception, RS1 §2 rule 7).** `solver/scripts/build-occt.mjs` is the one
  recipe: source `http://archive.ubuntu.com/ubuntu/pool/universe/o/opencascade/opencascade_7.9.2+dfsg.orig.tar.xz` (the upstream
  `V7_9_2` tag, Debian dfsg repack; sha256 `f6e272b6aaa14743a611eb4b8d7affa98986cdcaa60f5a91ca7ac46b177b7181`, verified), cmake
  `BUILD_LIBRARY_TYPE=Shared`, Release, every module off and `BUILD_ADDITIONAL_TOOLKITS` = the facade's toolkits (TKernel … TKFeat,
  TKMesh, TKShHealing, TKXSBase, TKDE, TKDESTEP, TKCDF, TKLCAF, TKCAF, TKXCAF; cmake adds TKVCAF, TKV3d, TKService, TKHLR for XCAF),
  `USE_XLIB/OPENGL/GLES2/FREETYPE/FREEIMAGE/TK/TCL/VTK/TBB/…` off, so the toolkits need only libc / libm / libstdc++ / libgcc_s
  (`ldd`); each toolkit carries RUNPATH `$ORIGIN` (macOS: install name `@rpath`, rpath `@loader_path`). Install prefix
  `include/opencascade`, `lib/`, the LGPL text, the exception and a `llull-occt.json` stamp (version + sha); default prefix per user
  (`~/.cache/llull/occt-7.9.2`, macOS `~/Library/Caches`, Windows `%LOCALAPPDATA%`), shared by every checkout, or `LLULL_OCCT_DIR`.
  Same prefix for local dev, CI (cached by version + sha + recipe hash) and desktop bundling. 7.9.2 is the newest 7.9 source
  reachable here; the VC-KRN-25 reference files are OCP 7.9.3 (one maintenance release apart): no deviation found (the reference
  procedure on plain 7.9.2 reproduces all 27 NIST rows bit for bit; VC-KRN-25 below).
- **Crate `solver/crates/llull-kernel-occt`.** `build.rs` builds nothing: it requires the prefix (clear panic naming the script
  otherwise), links the toolkit list (`OCCT_LIBS`, the one place) as `dylib`, compiles every `cpp/*.cxx` (glob: new facade files
  need no build-script edit) and exports `DEP_OCCT_LIB_DIR` (`links = "occt"`). `solver/bins/llull-kernel/build.rs` sets the
  runtime search path: `$ORIGIN/occt/lib` (macOS `@loader_path/occt/lib`; Windows loads the DLLs next to the exe) plus the
  prefix's absolute `lib/` for development, left out when `LLULL_OCCT_RPATH_BUNDLE_ONLY=1` (the desktop bundle build).
  A narrow C++ facade (`cpp/facade.{hxx,cxx}`, about 15 coarse functions) behind a `cxx` bridge: Rust never sees OCCT
  classes. Every C++ throw, `Standard_Failure` included, comes back as an `Err` (custom `rust::behavior::trycatch`), so an OCC
  exception is a refusal, never a degraded module. The bridge module is the only `unsafe` surface (generated code, local
  `allow(unsafe_code)` with its reason). The makers mirror `packages/kernel-occt` (same builders, placement order
  M = T·Rx·Ry·Rz·anchor, post-boolean `ShapeUpgrade_UnifySameDomain`, display deflections 0.1 / 0.5 rad, part-frame mass
  properties; since VC-KRN-25 with BRepGProp's default Gauss rule, as the OCP reference, no longer the adaptive eps 1e-12 rule). `recipe.rs` evaluates `ShapeRecipe` JSON with a sub-recipe LRU (sha256 of the canonical JSON).
- **Binary `solver/bins/llull-kernel`.** Long-lived; NDJSON on stdin/stdout. Request `{ id, op, args }`, reply
  `{ id, result, error? }`. Shapes travel as handles `{ key, recipe? }` (the host's `recipeKey`); a key-only handle the sidecar no
  longer holds answers `shape not cached: <key>` and the host resends the recipe, exactly like the worker protocol. `tessellate`
  answers `{ encoding: 'base64-le', positions: <f64[]>, indices: <u32[]> }` (half the bytes of JSON numbers, bit-exact). Error
  codes: `NATIVE_UNSUPPORTED` (op or recipe node not native yet), `NATIVE_BAD_REQUEST`, `NATIVE_OCC_FAILURE`, `NATIVE_PANIC`.
  OCCT's console printers are removed and `std::cout` goes to stderr, so stdout carries only the protocol (the host also skips
  any non-JSON line). stdin is read on its own thread: with `--exit-on-eof` (what the server passes) the process exits as soon
  as the host closes the pipe, even mid-operation, so a hung OCCT call never outlives a killed worker.
- **Native ops.** `info`, `evaluate`, `tessellate`, `massProperties`, `analyze`, `exportStep`, `topology`, `distance`, every
  `faceQuery.<method>`, `exportStepAssembly`, `importShapes` (STEP read + heal) and `loadBlob`. Recipe nodes `solid`,
  `boolean`, `place`, `scale`, `brep` (document blobs), `fillet`, `chamfer`, `blend`, `shell` (sealed and open) and `feature` (as `featureCut`, below);
  solid kinds box, cylinder, sphere, cone, torus, wedge, extrusion and revolution (polygon or exact arc / Bézier profile), triangle
  mesh (sewn; modelled-thread groove tools included), pyramid (the host sends its triangles, as the WASM kernel sews them), loft,
  sweep (constant section and variable stations) and subdivision (B-spline patches, triangles at level 0 or on a patch failure).
- **Second slice: feature nodes and freeform kinds.** C++ in `cpp/features.{hxx,cxx}` behind a second cxx bridge
  (`src/features.rs`, reusing the facade's opaque `Shape`), evaluated by `src/recipe/nodes.rs`; `build.rs` compiles every
  `cpp/*.cxx` and links `TKFeat`. Each builder is the `packages/kernel-occt` one with its parameters: `BRepFilletAPI_MakeFillet`
  (`ChFi3d_Rational`, constant or linear radius) / `MakeChamfer` on unique edges in explorer order (`TopExp::MapShapes`, the
  `uniqueSubShapes` rule; out-of-range index → refusal; `BRepCheck` validity), blend = one multi-argument `BRepAlgoAPI_Fuse` whose
  non-degenerate section edges still on the result are filleted, sealed shell = `MakeOffsetShape::PerformByJoin(−t, 1e-4, Skin,
  Arc)` cut from the solid (a bare offset shell closed by `ShapeFix_Solid`), open shell = `MakeThickSolidByJoin(−t, 1e-3)` on the
  faces nearest each point (`BRepExtrema_DistShapeShape`), curve chains = `MakeEdge` (line) / `GC_MakeArcOfCircle` / 4-pole
  `Geom_BezierCurve` → `MakeWire` → `MakeFace(wire, OnlyPlane)`, loft and variable sweep = `ThruSections(solid, ruled, 1e-6)`
  without compatibility check, sweep = `MakePipe(spine, section, GeomFill_IsCorrectedFrenet)`, subdivision = Coons
  `GeomFill_BSplineCurves` on the unit-square placeholders with the 16 poles set, `MakeFace(1e-7)`, sewing at span × 1e-7, one
  shell. The pure TypeScript geometry those builders read is computed by the host with the same core helpers and sent with the
  leaf (`server/src/native/kernelLeaves.ts`): oriented, lifted curve chains, Catmull-Rom ring curves, sweep frames and station
  rings, subdivision patches plus the fallback triangles. A `feature` node is lowered on the host
  (`server/src/native/kernelFeatures.ts`): the through reach from the sidecar's own display mesh of the source, `lowerFeature`,
  and the BRepFeat inputs of `occtFeatures.ts` (one `BRepFeat_MakeRevol` cut per hole position up to 8 positions without a
  modelled thread; `BRepFeat_MakePrism` of the outline from the supporting planar face for a pocket without islands); the sidecar
  tries the BRepFeat cut (valid → unified) and otherwise builds source op lowered tool. A thread-bearing operand skips
  UnifySameDomain, like the WASM thread mark.
- **Fillet / chamfer routing.** Both slices landed separately: fillet, chamfer and floor-filleted pockets were gated to WASM
  (`kernelFeatures.ts`) while `topology` was a WASM op. With native `topology` numbering edges index for index like the WASM
  kernel, the gate is lifted and fillet / chamfer evaluate natively (the feature parity suite covers the same edge indices).
- **Query / exchange facade (slice 2).** New translation units `cpp/queries.cxx` (topology, surface parameters, distances),
  `cpp/face_queries.cxx` (face-query port), `cpp/exchange.cxx` (STEP assembly, import, blobs) behind a second cxx bridge
  (`src/queries.rs`, reusing the opaque `Shape`); `build.rs` compiles every `cpp/*.cxx`. Each query answers JSON text in the WASM
  kernel's result shape (`cpp/json_writer.hxx`: shortest round-trip doubles, so values cross bit-exact) that Rust parses once, so the
  bridge stays ~20 coarse functions. Every function mirrors one `packages/kernel-occt` module call for call (same OCC algorithms, same
  sample grids, same arithmetic order).
- **Index rule (topology numbering, fillet / chamfer edges, face queries).** Face / edge / vertex index k is the k-th distinct
  sub-shape in `TopExp_Explorer` order, distinct = `TopoDS_Shape::IsSame` (same TShape and location, any orientation), keeping the
  first occurrence and its orientation: `TopExp::MapShapes` into a `TopTools_IndexedMapOfShape` (index k + 1), which is exactly
  `uniqueSubShapes` of `occtTopology.ts`. Measured: identical numbering (every face and edge, index for index) on the 11 primitives
  and the 4 boolean recipes (union, subtract, intersect, nested + place + scale), so the 7.4 / 7.8 concern of slice 1 did not
  materialise on this corpus; boolean results still depend on the BOP of each version, so the parity test stays the guard.
- **Blobs.** `loadBlob` verifies the sha256 (mismatch → refused, `KRN_BLOB_HASH_MISMATCH` on stderr) and forgets cached refusals (one
  may have been "blob missing"). Imported and written blobs use `BRepTools::Write` in the legacy V1 format (`occt-brep-v1`), read by
  every OCCT including the 7.4 WASM fallback (tested both ways). The router sends each blob to the sidecar at once (again after a
  respawn) and to the WASM fallback before its first request, since a `brep` leaf may evaluate on either engine.
- **STEP assembly.** Same construction as the WASM kernel (a compound per part, `Moved` references per occurrence, written by
  `STEPControl_Writer`), not XCAF: same product structure, no new libraries. On the wire the host flattens part objects to indices
  (`{ parts, occurrences }`; JSON has no object identity), so a shared part stays one product.
- **Server proxy.** `server/src/nativeKernel.ts` + worker entry `server/src/nativeKernelWorker.ts`, driven by the unchanged
  `isolatedKernel.ts` (synchronous call, `LLULL_OCC_TIMEOUT_MS`, recycle, blob resend; new option `workerData`). Pure parts in
  `server/src/native/`: `kernelProtocol.ts` (framing, mesh decoding, recipe rewrites: `evaluate` as a handle, pyramid as
  triangles, the WASM tangent-sphere guard), `kernelSession.ts` (id-matched replies, death handling), `kernelRouter.ts` (per-op
  routing). Per-op fallback: an op the sidecar does not list, a `NATIVE_UNSUPPORTED` reply or a sidecar death mid-call is
  answered by the WASM OCC kernel loaded lazily in the same worker; each op's first fallback is logged once
  (`[occt-native] <op>: answered by the WASM OCC kernel (<reason>)`); a dead sidecar is respawned on the next call.
  `kernel_info`: `active: 'occt'`, `occtVersion: '7.9.2'`, `build: 'llull-kernel@0.1.0 (OCCT 7.9.2, native) +
  opencascade.js@1.1.1 for ops it lacks'`, `isolation: 'process'` (own OS process; `KernelInfo.isolation` gained `'process'`). Selection (`server/src/geometryKernel.ts`): missing binary →
  `NATIVE_TOOL_MISSING: llull-kernel not found: …` (`nativeInstallHint`) as `fallbackReason`, then the WASM kernel, then Manifold.
  `server/src/kernelInvoke.ts` holds the op dispatch now shared by both workers. The server bundle gains the worker entry.
- **Tests.** Rust: 24 unit tests (facade, closure check, LRU, recipe evaluation, session protocol). Server, always run:
  `nativeKernelProtocol`, `nativeKernelSession` (fake process), `nativeKernelRouter` (fake session and fallback),
  `nativeKernel` (the real worker path against a scripted sidecar, `fixtures/fakeKernel.cjs`: native and fallback ops, crash
  recovery, a sidecar that does not speak, NATIVE_TOOL_MISSING fallback). With the binary built: `nativeKernelParity` (VC-KRN-25
  slice): 11 primitives (translated, rotated about all axes), 4 boolean recipes (union, subtract, intersect, nested + place +
  scale): volume, area and inertia within 1e-6 relative, centroid 1e-6, bounds 1e-3 of the WASM kernel; display meshes closed,
  mesh volume within 6 % of the exact one and 3 % of the WASM mesh; `analyze` validity / closure / lumps equal; STEP solid count
  equal; refusals equal; plus the proxy end to end (fillet and topology served by WASM on a native session, abort recovery).
  It skips with a logged reason without the binary; `LLULL_REQUIRE_NATIVE_KERNEL=1` (CI) makes that a failure.
  `nativeKernelFeatureParity` (second slice, 41 cases): curved extrusions and revolutions (all three axes, clockwise input),
  smooth and ruled lofts, tube / profile / variable sweeps, smooth, creased and faceted subdivision solids, sealed and open shells,
  blends, holes (BRepFeat and the 12-position lowering, counterbore, countersink, blind drill), pockets (BRepFeat, through,
  island lowering), a rib, a modelled M6x1 thread (1997 faces, no unify), fillet / chamfer edge numbering on boxes, a cylinder and
  a boolean result, plus the proxy end to end. Measured worst relative deviations (native vs WASM): volume 8.9e-12 and inertia
  7.0e-12 (blend of a plate and a post: the 7.8 and 7.4 rolling-ball surfaces differ in the last digits), area 7.2e-10 (profile
  sweep along a Bézier); fillets ≤ 1.1e-12; curves, lofts, subdivision, shells and features ≤ 3e-16 in volume; face counts
  (ADVANCED_FACE of each STEP export), validity and lump counts equal in every case.
  `nativeKernelLeaves` (always run) covers the host payloads and the feature gate.
  Slice 2 (shared fixtures in `nativeParitySupport.ts`): `nativeKernelQueryParity` — `topology` deep-equal to the WASM kernel's
  (same lengths, every string / flag equal, numbers within 1e-6 relative) on all 15 corpus shapes; `faceDetails` (64 and 5 samples),
  `faceGraph`, and per face `faceGeometry`, `evaluateFace`, `faceSamples` (uv list and 3 x 2 grid), `projectOnFace`, `faceContains`
  on 8 shapes (box, rotated cylinder, sphere, cone, torus, revolution, subtract, nested); port `distance`; the nulls (bad indices,
  `tessellateFace`, `edgeSamples`, `edgeContinuity`, `bspline`); shape `distance` on 6 pairs (apart, touching, overlapping, contained
  both ways, boolean result): distance within 1e-6, `inside` equal, the native point pair realises the distance. At umbilic points
  (sphere) the principal directions are arbitrary and OCC's pick differs between versions: the test checks an orthonormal tangent
  frame there instead of values. `nativeKernelExchangeParity` — `exportStepAssembly` (shared parts, nested children): same
  MANIFOLD_SOLID_BREP / NEXT_ASSEMBLY_USAGE_OCCURRENCE / PRODUCT / ITEM_DEFINED_TRANSFORMATION counts, re-imported solid counts
  equal; `importShapes` on the four committed 07-pack STEP files (three llull parts, NIST CTC-01 AP242): census, skipped list, solid
  count, faces, `validAsRead`, `validAfterHeal`, `faceted`, `freeEdges` equal, healing actions equal, exact volume within 1e-4 and area
  1e-3 (VC-KRN-04) of the WASM kernel, native blobs read by the WASM kernel and WASM blobs read natively; refusal codes equal; own
  exports round-trip; `brep` leaves under booleans. Proxy end to end: native `topology` / `faceDetails`, native import + blob
  evaluation surviving a worker restart (blob resend). Router: blobs to both engines, resend after a respawn. Rust: +16 unit tests
  (facade queries, LRU retain, blob leaves, session dispatch).
- **Gates.** `LLULL_NATIVE_KERNEL=1 npm run native:check` (fmt, clippy `-D warnings`, tests on the whole workspace). CI job
  `native-kernel` (`.github/workflows/check.yml`): OCCT prefix from `build-occt.mjs`, cached by version + source sha + recipe hash,
  then native:check, release build, the parity suite, `prepare-native.mjs` and an `ldd` check of the bundled binary. The plain
  `native` job (default members, no OCCT) is unchanged. ESLint ignores `solver/target/**`.
- **Desktop bundle.** `desktop/scripts/prepare-native.mjs` (`npm run prepare:native`, part of `dist`; extraResources
  `build/native` → `resources/native`) builds `llull-compute` WITH the `gpu` feature (wgpu raster, CPU-twin fallback with a
  warning) and `llull-kernel` (`LLULL_OCCT_RPATH_BUNDLE_ONLY=1`) into `desktop/build/cargo-target`, or takes
  `LLULL_NATIVE_PREBUILT_DIR`; builds or reuses the OCCT prefix; stages `llull-compute`, `llull-kernel`, `occt/lib/libTK*.so.7.9`
  (the SONAME files only; macOS `libTK*.7.9.dylib`; Windows `TK*.dll` next to the executables), `licenses/` (OCCT LGPL-2.1 text,
  exception, a notice with the source URL + sha256 and how to replace the libraries; fdlibm + V8 BSD notice for `llull-jsmath`;
  every linked third-party Rust crate with its licence files from `cargo metadata`) and `LLULL_NATIVE.json`; then smoke-runs both
  binaries (`--version`, must name OCCT 7.9.2). `LLULL_NATIVE_GPU=0` / `LLULL_NATIVE_KERNEL=0` trim it. `desktop/src/backendEnv.ts`
  passes `LLULL_NATIVE_DIR` only when the folder holds a binary (`nativeBundleDir`); an inherited one is dropped; the kernel is
  `occt-native` when the folder holds `llull-kernel` (`hasNativeKernel`, KI7), else `occt` (WASM). Linux measured: 66 MB bundle (OCCT 27 toolkits 59 MB, `llull-compute` 5.3 MB, `llull-kernel`
  0.9 MB, 87 crates in the notice); the relocated bundle passes the parity, compute-job and render suites through
  `LLULL_NATIVE_DIR`. Windows is built and tested by the CI job `native-bundle`; macOS paths are written but deferred (owner, 2026-10-19).

Measured (4-core Xeon 2.8 GHz container, Linux x86_64, release build; native times include the JSON round trip, WASM times are
in-process calls of opencascade.js 1.1.1; medians; timing rows measured on the 7.8.1 static build):

| Item | Native `llull-kernel` | WASM OCC |
| ---- | --------------------- | -------- |
| OCCT build from source (cold, `-j4`) | 7.8.1 static: 58 min (machine busy); 7.9.2 shared, 27 toolkits: 105 min at load 13-22 | — |
| Binary / install size | 7.9.2: 0.9 MB binary + 59 MB shared toolkits (prefix 99 MB with headers 35 MB; build tree 287 MB); 7.8.1 static: 25.9 MB | — |
| Cold start | 12 ms to the `info` reply, 9 MB RSS | 1.73 s, +371 MB RSS |
| Box: evaluate / tessellate / massProperties | 0.8 / 1.7 / 1.8 ms | 0.8 / 9.2 / 9.6 ms |
| Plate − cylinder | 5.5 / 3.3 / 3.8 ms | 48 / 16 / 15 ms |
| Plate − 25 holes (25 chained subtracts) | 228 / 64 / 66 ms | 2315 / 209 / 161 ms |
| RSS after the runs | 23 MB | — |
| Plate − cylinder: topology / faceGraph / distance to the union | 1.5 / 1.7 / 12 ms | 14 / 3.7 / 109 ms |
| STEP import + heal: bracket (10 faces) / joggle (14) / machined plate (51) / NIST CTC-01 (117) | 23 / 60 / 125 / 636 ms | 1589 / 636 / 1327 / 4230 ms |
| NIST CTC-01: topology / faceDetails (64 samples per face) | 58 / 2020 ms | 161 / 17 913 ms |

Import parity numbers (slice 2): all four files give 1 solid on both kernels, faces 10 / 14 / 51 / 117, exact volumes 5279.717 /
2184.347 / 55 978.529 / 14 644 823.285 mm³ with a relative volume and area difference of 0 (to the last bit) between the native and
the WASM blob, healing action `shape_fix` on both, max tolerance equal (1e-7 mm; 0.00335 mm on CTC-01).

Deviations and decisions to confirm:

- **OCCT 7.9.2, not 7.9.3** (the OCP reference): 7.9.2 is the newest 7.9 source reachable from the build hosts (Ubuntu archive;
  GitHub blocked). Bump when a 7.9.3 tarball is pinned: change `OCCT_VERSION` / URL / sha in `build-occt.mjs` and `build.rs`.
  Linked dynamically (shared toolkits, LGPL-2.1 with exception; RS1 §2 rule 7); `kernel_info.isolation` is `'process'`.
- The development binary keeps the prefix's absolute `lib/` as a second RUNPATH entry; only the bundle build drops it. Prebuilt
  binaries given through `LLULL_NATIVE_PREBUILT_DIR` keep whatever they were linked with.
- `occtVersion` is the sidecar's (7.9.2) although ops it lacks run on 7.4.0p1; `build` names both engines. Documents stamped by
  `import_step_exact` on this kernel record 7.9.2.
- The pure TypeScript geometry of curved profiles, lofts, sweeps, subdivision patches and feature lowering stays in TypeScript and
  is sent with the recipe (one implementation, no Rust port to drift); the sidecar therefore needs the llull host for those
  recipes. A through feature's reach comes from the native display mesh (the WASM kernel reads its own mesh): the tool overshoot
  differs by the mesh tolerance, the cut result does not.
- `faceQuery.tessellateFace`, `edgeSamples`, `edgeContinuity` and `bspline` answer null natively, exactly like the WASM kernel
  (whose opencascade.js build lacks the bindings), so a call answers the same whichever engine serves it. Real implementations
  (BRepMesh UV nodes, BRepLProp_CLProps, GeomConvert) are easy natively and should land when the WASM fallback leaves the desktop path.
- `importShapes` blobs are written by 7.9 natively: the same file now yields a different blob text (hence sha256) on the native
  and the WASM kernel; geometry is identical (volume difference 0 on the 07 files). TR-KRN-21's "same file + options -> same text"
  holds per engine, not across engines.
- STEP assembly export keeps the WASM kernel's compound construction rather than XCAF (TR-KRN-20 names XCAF for import); the
  linked OCCT 7.9.2 install has TKXCAF / TKLCAF, so an XCAF writer (names, colours) is possible natively as a follow-up.
- A closed solid whose display mesh comes out open is re-meshed finer (0.02 / 0.2 rad) for every solid, not only freeform-heavy
  or thread-bearing ones as in `occtMesh.ts`; still open → null.
- Exceptions are refusals (null result, `NATIVE_OCC_FAILURE` logged), not WASM fallbacks.

**Full VC-KRN-25 suite (2026-10-19).** `server/tests/nativeKernelReference.test.ts` (the 10 solids of `occt_crosscheck.json`, an
arc-profile revolution against its closed form, the behaviour probe) and `nativeKernelReferenceNist.test.ts` (the 28 NIST files of
`nist_occt_reference.json`, fetched and sha256-checked by `validation/fetch_nist_step_files.py` into `~/.cache/llull/nist-pmi-step-files`;
`LLULL_REQUIRE_NIST_CORPUS=1` makes a missing corpus a failure), with `import_step_exact`'s default options. Because the reference
measured the whole transferred shape (loose shells, faces, PMI wires and points included) and `import_step_exact` keeps the solid, the
census is compared with the whole-file row and the solid with `validation/nist_occt_solid_reference.json` / `nist_occt_solid_faces.json`
(the first solid of the same healed shape, measured by the C++ port `measure_step_brep.cxx` on the OCCT 7.9.3 libraries of the
cadquery-ocp 7.9.3.1 wheel, whose whole-file rows reproduce `nist_occt_reference.json` bit for bit). Result, all within the VC-KRN-01
tolerances: analytic volume 7.5e-15, area 1.4e-16, centroid 1.5e-11 mm, inertia 1.6e-15 (1.7e-16 against the closed form at 70 m,
where the raw OCP reference is itself 2.2e-9 off); NIST 27 B-rep files: census, faces / edges / vertices, validity and max tolerance
equal on all, volume 1.6e-12, area 2.0e-12, centroid 4.0e-10 mm, inertia 7.6e-13, per-face area / centroid within tolerance on all
(the %.6f sha256 signature itself is equal on 8 files, the others differ only in the sign of values within 1e-15 of zero and two
areas on a rounding boundary); the tessellated file `tessellated_only`; probe: fuzzy 0 → 2 solids / 12 faces, plate − cylinder 7 faces
with signature `1125f7464525c4f6` equal to the reference and across two processes, fillet 1 generated + 4 modified faces, Iyy error
1.7e-16 from 0 to 1000 m. Not runnable: the fuzzy 2e-5 run (no fuzzy value on the boolean recipe, TR-KRN-12). Defects found and
fixed natively (Rust + server tests): (1) mass properties switched from the adaptive eps rule to the default Gauss rule — the adaptive
rule drifts on toroidal / freeform faces with a ~1e-15 error estimate (arc-profile ring Ixx 2.7e-4 off and Ixx ≠ Iyy, NIST up to 1.6e-6
in volume); the WASM kernel keeps the adaptive rule, so `nativeKernelFeatureParity` tolerates its documented inertia error on two
curved revolutions, and the native kernel no longer reports `relError`; (2) OCCT 7.9 transfers AP242 tessellated geometry as
surface-less faces: such pieces are now skipped and a tessellated-only file answers `tessellated_only` (7.4 never transferred them).
Known, not native: stc_07 e3's B-rep text blob reads back BRepCheck-invalid on 7.4 and 7.9 alike (TR-KRN-21 follow-up). Findings in
validation/README.md §5 (6 to 9) and §6.

**Desktop default flipped (KI7, `docs/decisions/KI7-native-kernel-default.md`).** `desktopKernel` in `desktop/src/backendEnv.ts`:
inherited `manifold` or `occt` → kept (diagnostic overrides), else `occt-native` when the bundle holds `llull-kernel`, else `occt`.
Server, CLI and browser defaults unchanged. `desktop/tests`: unit cases for the choice and `hasNativeKernel`, and the e2e backend
started with the local release binary as its bundle answers `kernel_info` with OCCT 7.9.2 and `isolation: 'process'`.

Pending (rest of M2): floor-filleted pockets natively; Windows bundle (CI `native-bundle`); macOS deferred (owner, 2026-10-19); align
`occtMass.ts` (WASM) on the Gauss rule; fuzzy booleans (TR-KRN-12) to run the last probe case.
