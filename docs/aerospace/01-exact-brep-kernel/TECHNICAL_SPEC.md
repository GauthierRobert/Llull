# KRN — Exact B-rep kernel as the production basis — Technical specification

Gap id **KRN** · status: specification (no implementation) · written 2026-10-15 ·
functional counterpart: [FUNCTIONAL_SPEC.md](FUNCTIONAL_SPEC.md) · validation: [validation/README.md](validation/README.md)

Requirement ids `TR-KRN-nn` are grouped by decade: 0x kernel selection & build, 1x tolerance policy & booleans,
2x STEP → exact B-rep & healing, 3x persistent naming, 4x mass properties, 5x validity, 6x determinism,
7x large assemblies & display, 8x export, 9x face-query port, 10x agent-first (codes, units, defaults, unverified, review, human gates, loop).

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
                            │ KernelOps<S>
    ┌───────────────────────┴───────────────────────┐
    │ packages/kernel-occt (OCCT 7.9.x WASM build)   │  server: worker thread (isolatedKernel)
    │ import/heal/check/gprop/history                │  desktop: same server bundle, LLULL_KERNEL=occt
    └────────────────────────────────────────────────┘  browser-only: Web Worker proxy (V1)
```

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

| Item | Owner | Other pack |
| ---- | ----- | ---------- |
| `import_step_exact` command (one STEP → exact B-rep import; the name `import_step_brep` is retired) | **01 KRN** (§4, TR-KRN-20..24) | 04 XCH extends it: `verify` / `gvpPolicy`, `ImportProvenance`, XDE product tree → components / instances |
| `brep` recipe leaf + `heal` node + document blobs; `GeometryKernel.importShapes` | **01 KRN** (§3, TR-KRN-20/21) | 04 `import_iges` reuses the same leaf; 04 defines no other leaf and no `readExchange` |
| Healing, import report, tessellated-only detection, kernel provenance, llull-document v3 envelope + migration | **01 KRN** (TR-KRN-22/24/61, §3.1) | every pack adds its slice to §3.1 |
| `GeometryKernel.massProperties` (one superset method) | **01 KRN** (TR-KRN-40) | 04 `geometric_validation_properties` consumes it |
| `GeometryKernel.faceQuery` port | **01 KRN** (§5.9) | 02 / 03 / 05 / 06 / 07 consume it |
| GVP band policy, `verify_exchange_file`, `geometric_validation_properties`, `export_step_ap242` (AP242 + assembly + GVP), IGES | **04 XCH** | KRN FR-KRN-13 / TR-KRN-23 / TR-KRN-80 point there |

### 2.1 Kernel selection & build

- **TR-KRN-01 (MUST, MVP)** `desktop/src/backendEnv.ts` sets `LLULL_KERNEL: 'occt'`. `backendEnv` strips every
  inherited `LLULL_*` variable today, so a diagnostic override needs an explicit exception: an inherited
  `LLULL_KERNEL=manifold` is passed through (same pattern as the `LLULL_ALLOW_CODE_EXECUTION === '1'` pass-through),
  any other inherited value is ignored and `occt` is used; `desktop/tests` covers both. `server/src/geometryKernel.ts` already falls back to
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

- **Document version / migration**: see §3.1 — 01 KRN owns the single `llull-document` v3 envelope. The loader's
  recipe validation (`MAX_RECIPE_DEPTH`, leaf validation) is extended: `brep` leaves must reference an existing
  blob whose sha256 matches its bytes.
- `recipeKey('brep') = brep(<sha256>)`; `heal` and `boolean.fuzzy` enter the key text.

### 3.1 The `llull-document` v3 envelope (one version, one migration, owned by 01 KRN)

Today `commands/persistence/serialization.ts` writes `{ format: 'llull-document', version: 2, document }`
(`CURRENT_SCHEMA_VERSION = 2`) and refuses any other version ("unsupported version … expected 1 or 2"). Several packs
add document data; instead of each bumping the version on its own, they share **one** step to `version: 3`:

| Slice | Added by | Kind | Declared through | Notes |
| ----- | -------- | ---- | ---------------- | ----- |
| `kernelSettings`, `blobs` | 01 KRN (§3) | core root fields | core persistence guards | provenance + content-addressed B-rep / STEP payloads |
| `exchange.provenance` (`ImportProvenance`) | 04 XCH (TECHNICAL_SPEC §3.1) | core root field | core persistence guards | embedded GVP and band of each import |
| `aero` (`AeroModel`) + entity kinds `nurbs_curve`, `nurbs_surface`, `loft` v3 fields | 02 SRF (§3; resolves its D3) | core model types, plugin data | plugin `DocumentExtension` (`aero`); kinds in core guards | old readers must refuse new kinds — the version bump does that |
| `pmi` | 03 GDT (§3) | core root field | core `pmiValidation.ts` | |
| `analysis` (`AnalysisModel`) | 05 FEA (TR-FEA-02) | plugin data | plugin `DocumentExtension` | |
| `composites` (`CompositesModel`) | 06 CMP (§3) | plugin data | plugin `DocumentExtension` | |
| `sheetMetal` | 07 FTR (§3) | plugin data | plugin `DocumentExtension` | |
| `materialRecords`, `materialLibraries`; `Material.recordId?` | 08 MAT (§3.5, TR-MAT-14) | core root fields | core guards (`validateMaterialRecord`) | private-library values never serialized (TR-MAT-31) |
| `plm` (`PlmModel`) | 09 PLM (TR-PLM-10) | plugin data | plugin `DocumentExtension` (+ carried through `replayHistory`, TR-PLM-02) | |

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

| Command | Kind | Params (sketch) | Data / effect | Toolset |
| ------- | ---- | --------------- | ------------- | ------- |
| `kernel_info` | query | `{}` | TR-KRN-04 payload | core |
| `set_modeling_tolerance` | mutating | `{ linear?: number (mm), angular?: number (rad), maxImportTolerance?: number (mm) }` | updates `kernelSettings.modelingTolerance` (validated range) | core |
| `import_step_exact` (owned by 01; extended by 04) | mutating, kernel | exactly one of `stepBase64?: string`, `text?: string` (Part 21, ASCII), `blobId?: string`; `fileName?: string`, `heal?: boolean = true`, `sew?: boolean = true`, `precisionMode?: 'file'|'document' = 'file'`, `keepOriginal?: boolean = false`, `name?: string`; **04 extension**: `verify?: boolean = true`, `gvpPolicy?: Partial<GvpPolicy>`, `mode?: 'append'|'replace'`, `tessellated?: boolean` | MVP (01): one `mesh` entity per solid with `brep: { op:'heal'?, source: { op:'brep', blob } }`, world placement, names, colours; `data.report` (§5.2). 04 extension: XDE product tree → components / instances, `doc.exchange.provenance`, `data.gvpCheck` (04 TECHNICAL_SPEC §3–§5) | exchange |
| `heal_shape` | mutating, kernel | `{ id: string, precision?: number (mm), maxTolerance?: number (mm), sew?: boolean, fixSmallEdges?: boolean }` | wraps the entity recipe in a `heal` node; `data.report` | 3d |
| `validate_shape` | query, kernel | `{ entityIds?: string[], selfIntersection?: boolean = false, exact?: boolean = false }` | `data: { results: [{ id, valid, issues: [{ code, subShape: TopoName, detail }], maxTolerance }] }` | measure |
| `boolean` (extended) | mutating, kernel | `+ fuzzy?: number` (mm, ≥ 0, ≤ 0.1) | recipe `boolean.fuzzy`; on failure `data.argumentCheck` | 3d |
| `fillet_edge` / `chamfer_edge` (extended) | mutating, kernel | `+ edgeNames?: TopoName[]` | names resolved first, then `edgeIndices`, then `edgesNear`; history stores names | 3d |
| `inspect_topology` (extended) | query, kernel | `+ withNames?: boolean = true` | each face/edge gains `name: TopoName` and `history: 'primitive'|'modified'|'generated'|'imported'` | 3d |
| `mass_properties` (extended) | query | `+ frame?: 'document'|'entity' = 'document', eps?: number = 1e-9 (relative), about?: Vec3 (document unit), purpose?: 'general'|'weight-and-balance' = 'general'` | §5.4 payload + `unverified`, `reviewRequired`, `provenance`, named defaults (TR-KRN-102..104) | measure |
| `export_step_exact` (unchanged) / `export_step_ap242` (04 XCH) | query, kernel | — / see 04 TECHNICAL_SPEC §4 | `export_step_exact` stays AP214, flat, no GVP; exact AP242 export with assembly structure and GVP is 04's `export_step_ap242` (TR-KRN-80) | exchange |
| `check_model` (extended) | query | — | adds `KRN_FACETED_RESULT`, `KRN_KERNEL_MISMATCH`, `KRN_INVALID_BREP` (when kernel present), `KRN_MASS_INPUT_UNVERIFIED`, `KRN_BROKEN_REFERENCE`, `KRN_KERNEL_FALLBACK` issues (§7.2) | core |

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
  (KI5 gotcha) is removed once the M2 build is verified. `export_step_exact` stays AP214 / flat / no GVP.

### 5.9 Face-query port (TR-KRN-90 .. 92) — one optional kernel port for every pack

Five packs asked for face-level kernel queries independently. They merge into **one** optional port owned here;
the other packs consume it and define no `GeometryKernel` member of their own.

| Request (source pack, section) | Merged into |
| ------------------------------ | ----------- |
| 03 GDT TR-GDT-03: `ShapeFace` + centroid / normal / axis / radius / samples; §5.1 `faceContains?` | `faceDetails`, `faceContains` |
| 05 FEA §5.1: `ShapeFace` + centroid / normal (planar) for `facesNear` | `faceDetails` (same record) |
| 07 FTR §3.2: `faceGraph?(shape): FaceGraph` (surface params, loops, edge→faces, convexity) | `faceGraph` |
| 06 CMP §5.5: `faceGeometry?`, `projectOnFace?`, `evaluateFace?`, `tessellateFace?` | same names |
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
  readonly centroid: Vec3;                                  // BRepGProp::SurfaceProperties
  readonly normal?: Vec3;                                   // planes (outward, material side)
  readonly axis?: { readonly origin: Vec3; readonly dir: Vec3 }; // cylinder / cone / sphere / torus
  readonly radius?: number;                                 // cylinder, sphere; torus minor; cone at the face centroid
  readonly samples: readonly Vec3[];                        // <= options.samples (default 64) points inside the trimmed face
}

/** 07 §3.2. */
export interface FaceGraphFace {
  readonly index: number; readonly surface: SurfaceParams; readonly reversed: boolean; readonly area: number;
  readonly loops: readonly (readonly number[])[];           // edge indices, outer loop first
  readonly uvBounds: readonly [number, number, number, number];
}
export interface FaceGraph {
  readonly faces: readonly FaceGraphFace[];
  readonly edgeFaces: readonly (readonly number[])[];
  readonly edgeConvexity: readonly ('convex' | 'concave' | 'smooth' | 'unknown')[];
}

/** 06 §5.5. */
export interface FaceProjection { readonly point: Vec3; readonly normal: Vec3; readonly uv: Vec2; readonly distance: number }

/** 02 §5.8 (types SurfaceSample, EdgeCurveSample, EdgeContinuitySample, NurbsSurfaceData as defined in 02 §5.8). */
export interface FaceQueryPort {
  faceDetails(shape: ShapeHandle, options?: { readonly samples?: number }): readonly FaceDetail[] | null;
  faceContains(shape: ShapeHandle, face: number, point: Vec3, tolerance?: number): boolean | null;
  faceGraph(shape: ShapeHandle): FaceGraph | null;
  faceGeometry(shape: ShapeHandle, face: number): { readonly surface: SurfaceParams; readonly uvBounds: readonly [Vec2, Vec2] } | null;
  projectOnFace(shape: ShapeHandle, face: number, points: readonly Vec3[]): readonly (FaceProjection | null)[] | null;
  evaluateFace(shape: ShapeHandle, face: number, uv: readonly Vec2[]): readonly { readonly point: Vec3; readonly normal: Vec3 }[] | null;
  tessellateFace(shape: ShapeHandle, face: number, deflection: number): (MeshData & { readonly uv: readonly number[] }) | null;
  faceSamples(shape: ShapeHandle, face: number, uv: ReadonlyArray<readonly [number, number]> | { readonly nu: number; readonly nv: number }): readonly SurfaceSample[] | null; // k1, k2, gaussian K, mean H
  edgeSamples(shape: ShapeHandle, edge: number, count: number): readonly EdgeCurveSample[] | null;
  edgeContinuity(shape: ShapeHandle, edge: number, count: number): readonly EdgeContinuitySample[] | null;
  distance(shape: ShapeHandle, points: readonly Vec3[]): readonly { readonly distance: number; readonly signed: number; readonly face: number }[] | null;
  bspline(shape: ShapeHandle, face: number): NurbsSurfaceData | null;
}

export interface GeometryKernel { /* … existing … */ readonly faceQuery?: FaceQueryPort }
```

OCC classes (union of the consumer packs' lists, to be added to the M2 binding list, TR-KRN-02):
`BRepGProp::SurfaceProperties`, `BRepAdaptor_Surface` (`GetType`, `Plane`/`Cylinder`/`Cone`/`Sphere`/`Torus`),
`BRepTools::UVBounds`, `BRepClass_FaceClassifier` / `BRepTopAdaptor_FClass2d`, `GeomAPI_ProjectPointOnSurf`,
`BRepLProp_SLProps` (normals, principal curvatures), `BRepExtrema_DistShapeShape`, `TopExp::MapShapesAndAncestors`
(edge → faces), `BRepMesh_IncrementalMesh` + `Poly_Triangulation` UV nodes, `GeomConvert` / `Geom_BSplineSurface`.

## 6. Interop & persistence

| Item | Format | Notes |
| ---- | ------ | ----- |
| Imported definition | OCCT BRep text (`BRepTools::Write`, versioned) in `document.blobs` | content-addressed; base64 in JSON; gzip in the desktop file container when > 1 MB (Q4) |
| Original STEP (optional) | `model/step` blob | audit / re-import; not used on replay |
| Document | `llull-document` v3 | single envelope for every pack's slice; v2 → v3 migration (§3.1) |
| Exact export | STEP AP214 (`export_step_exact`, today) → AP242 geometry + assembly + GVP (`export_step_ap242`, 04 XCH) | full AP242 PMI is gap XCH |
| Lightweight | glTF (existing `export_gltf`), JT (gap XCH, ISO 14306 [R23]) | LOD ladder reused |
| Code | CadQuery / build123d via `export_code` | `brep` leaves lowered to `cq.importers.importBrep`-style loading of the blob (Q5) |

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

| Code | Severity | Raised by | When | Offending ids / paths | Remediation |
| ---- | -------- | --------- | ---- | --------------------- | ----------- |
| `KRN_NO_EXACT_KERNEL` | fail | every `requiresKernel` KRN command | no kernel, or a kernel without the needed port (`importShapes`, `massProperties`, `validate`, `faceQuery`) | command name | run on the desktop backend or with `--kernel occt`; `kernel_info` shows the active kernel |
| `KRN_KERNEL_FALLBACK` | warn | `kernel_info`, `check_model` | OCC failed to start; Manifold active | `fallbackReason` | restart the app; report the reason; exact results are unavailable until fixed |
| `KRN_KERNEL_MISMATCH` | warn | load, `kernel_info`, `check_model` | document written by another kernel / OCCT version | `kernelSettings.occtVersion` both values | re-run the KRN plans and compare (`quality:kernel`) before relying on stored measures |
| `KRN_STEP_UNREADABLE` | fail | `import_step_exact` | Part 21 parse / transfer failure, truncated file | `fileName` | check the file (sha256, size); try `verify_exchange_file` (04) for a census |
| `KRN_STEP_TESSELLATED_ONLY` | fail | `import_step_exact` | file holds only `TESSELLATED_*` geometry | `fileName` | import as mesh with `import_step` (`mode: 'mesh'`) or 04's tessellated import |
| `KRN_STEP_NO_SOLID` | fail | `import_step_exact` | no solid and no closable shell after sewing | `fileName`, open-shell count | retry with `sew: true` and a larger `precision` (mm) within `maxImportTolerance`; else import as surfaces (02 SRF) |
| `KRN_IMPORT_TOLERANCE_HIGH` | warn | `import_step_exact`, `heal_shape`, `validate_shape` | a sub-shape tolerance > `maxImportTolerance` | entity id, sub-shape | `heal_shape` with a smaller `maxTolerance`; check the result with `validate_shape`; reviewer if it remains |
| `KRN_GVP_MISMATCH` | warn | `import_step_exact` (04 `verify`) | recomputed GVP outside the green band (04 §5.3) | entity id, property, sender / recomputed values | do not deliver as-is; report both values; qualified reviewer decides |
| `KRN_HEAL_FAILED` | fail | `heal_shape`, `import_step_exact` | shape still invalid after the healing pipeline | entity id, BRepCheck statuses | try `sew: false` / other `precision`; else keep the original and report |
| `KRN_BLOB_MISSING` / `KRN_BLOB_HASH_MISMATCH` | fail | load, `brep` leaf evaluation | `brep` leaf references an absent blob or bytes whose sha256 differ | blob sha256, entity id | re-import the STEP file (`import_step_exact`); never edit the document by hand |
| `KRN_BOOLEAN_FAILED` | fail | `boolean` | BOP returned no valid result | `a`, `b`, `data.argumentCheck` issues | retry with `fuzzy` (mm, ≤ 0.1) or `heal_shape` the operands |
| `KRN_INVALID_RESULT` | fail | any kernel node (commit gate) | a result fails BRepCheck | entity id, node op | change the parameters (smaller fillet radius, …); see `validate_shape` |
| `KRN_BROKEN_REFERENCE` | fail | replay of `fillet_edge` / `chamfer_edge` / later naming users | a stored `TopoName` resolves to no entity | step path, `TopoName` | re-pick with `edit_step_params` (new `edgeNames` / `edgesNear`) |
| `KRN_REFERENCE_RERESOLVED` | info | replay | a reference was re-resolved by history trace | step path, old / new name | none; listed for audit |
| `KRN_TOLERANCE_OUT_OF_RANGE` | fail | `set_modeling_tolerance`, `boolean` (`fuzzy`) | value outside policy (`linear` ∉ [1e-7, 1e-2] mm, `fuzzy` > 0.1 mm) | param path | pass a value inside the range |
| `KRN_PRECISION_ENVELOPE` | warn | build, import, `mass_properties` | geometry beyond \|x\|,\|y\|,\|z\| ≤ 1e5 mm | entity ids, bbox | move the part frame near the origin and place it by instance |
| `KRN_FACETED_RESULT` | warn (fail for exact export) | `check_model`, exports | an exact recipe fell back to triangles | entity id | run on OCC; or a qualified reviewer accepts it (human gate) |
| `KRN_INVALID_BREP`, `KRN_SELF_INTERSECTION`, `KRN_SMALL_EDGE`, `KRN_SLIVER_FACE`, `KRN_OPEN_SHELL`, `KRN_NEGATIVE_VOLUME` | fail / warn | `validate_shape`, `check_model` | the TR-KRN-51 checks | entity id, sub-shape (index MVP, `TopoName` V1) | `heal_shape`; rebuild the feature; reviewer if it is imported data |
| `KRN_MASS_INPUT_UNVERIFIED` | warn | `mass_properties`, `check_model` | TR-KRN-103 reasons | entity ids, reasons | assign a verified material record (08 MAT `assign_material` with a record), use the exact kernel |
| `KRN_HUMAN_GATE` | fail | kernel-baseline accept (`quality:kernel --accept`) | agent caller on a human-gated act (the faceted-delivery gate is 04's `export_step_ap242 { acceptUnverified }` → `XCH_HUMAN_GATE`) | act, entity ids | hand the prepared request to a qualified reviewer in the desktop app |
| `KRN_DRIFT_TOPOLOGY` / `KRN_DRIFT_MEASURE` | fail / warn | `quality:kernel` | cross-build drift beyond tolerance | model id, measure | review the drift report; baseline change is a human gate |

Existing lowercase `check_model` codes (`degenerate_size`, …) stay unchanged; new KRN findings use the `KRN_*` codes.

### 7.3 Agent-first compliance (AGENT_FIRST.md)

| AF | Where satisfied |
| -- | --------------- |
| AF-01 | §4: every capability is a registry command; FR-KRN-17; VC-KRN-17 |
| AF-02, AF-03 | §7 CLI bullet (descriptions, `llull guide` KRN section) |
| AF-04, AF-10 | TR-KRN-101; FR-KRN-21; VC-KRN-17, VC-KRN-23 |
| AF-05 | `validation/plans/*.json` validate with `llull run … --validate` (checked in review: all valid against the real zod schemas) |
| AF-11 | TR-KRN-100, §7.2; FR-KRN-19; VC-KRN-19 |
| AF-12 | heavy outputs via `--save` (STEP, PNG); import report bounded per body |
| AF-13 | TR-KRN-60 determinism; FR-KRN-10; VC-KRN-10 |
| AF-20 | `validate_shape` + `check_model`; FR-KRN-20; VC-KRN-09, VC-KRN-19 |
| AF-21 | numeric equivalents: validity issues, tolerance values, inertia tensor and principal axes, `data.instancing` instead of viewport inspection (FR-KRN-11) |
| AF-22 | `render_view … --save view.png` in W1 / W2 |
| AF-23 | FUNCTIONAL_SPEC §7 (CLI + JSON assertions), `validation/README.md` §3.1 |
| AF-30 | tolerance policy and validity rules as data (TR-KRN-10/11/51) applied by the check commands |
| AF-31, AF-35 | TR-KRN-102; FR-KRN-22; VC-KRN-23 |
| AF-32 | TR-KRN-103; FR-KRN-23; VC-KRN-20 |
| AF-33, AF-36 | TR-KRN-104; FR-KRN-24; VC-KRN-21 |
| AF-34 | TR-KRN-105; FR-KRN-25; VC-KRN-22 |
| AF-40, AF-42 | TR-KRN-106; FR-KRN-26; VC-KRN-24 |
| AF-41 | desktop OCC + bundled CPython, no network (KI6); `KRN_NO_EXACT_KERNEL` when unavailable |

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
| Unit (server, real OCC: `server/tests/occt*.test.ts` pattern) | analytic solids and far-box mass properties; fuzzy boolean; commit validity gate; `import_step_exact` on a small committed synthetic STEP; naming grammar on box/fillet/boolean | VC-KRN-01, 02, 08, 09 |
| Golden (`tests/golden/plans.ts`) | KRN plans from `validation/plans/` (aliases, id-normalised snapshots, replay equality); renaming plan expected to fail until V1 (registered as known issue) | VC-KRN-03, 03b, 07 |
| Quality gate | `quality:step` gains `--mode brep` (validity after heal, exact volume vs `quality/step_reference.py`, save/load of blobs) over `quality/corpus.json`; NIST set pinned as a new `aerospace` group (archive URL + sha256, see `validation/README.md`); GVP comparison | VC-KRN-04, 04x, 05, 06 |
| Kernel regression (new `quality:kernel`) | signatures + measures vs baseline; cross-version tolerance mode | VC-KRN-10 |
| Display gate | 10 000-instance scene, 70 m station z-fighting screenshot | VC-KRN-12, TR-KRN-73 |
| Desktop (`npm --prefix desktop test`) | backend env contains `LLULL_KERNEL=occt`; `kernel_info.active === 'occt'`; forced failure → fallback warning | VC-KRN-11 |
| Agent-first (CLI scripts, `--json` + exit codes) | wrong calls → codes; legacy-material rib → `unverified`; weight-and-balance purpose → `reviewRequired`; agent `acceptUnverified` → `KRN_HUMAN_GATE`; named defaults + provenance; `--dry-run` / `--timeout` on import | VC-KRN-19 .. 24 |
| Production-gate scenario | "Supplier STEP round trip": import NIST CTC 01 AP242 → drill + pocket + fillet → validate → mass → `export_step_ap242` with GVP (04) → re-import → GVP within 1e-6 of the exported values | VC-KRN-04, 09, TR-KRN-80 |

Coverage gate (90/85/90/90) applies to new code in `packages/core/src/{commands,geometry}`.

## 10. Delivery plan

| Milestone | Content | TRs | Effort (eng-weeks) | Depends on |
| --------- | ------- | --- | ------------------ | ---------- |
| M1 OCC default | desktop env, `kernel_info`, status badge, provenance fields + migration, faceted flag | 01, 04, 61 (fields), FR-KRN-16 | 1.5 | — |
| M2 Kernel build | OCCT 7.9.x WASM with exceptions, regenerated bindings, KI7 decision with measurements, version alignment with OCP | 02, 61 | 4-6 | M1 |
| M3 Precision & mass (merged with 04 XCH M1: KRN owns `massProperties`; XCH M1 adds only `geometric_validation_properties` + `lib/step21`) | tolerance policy + command, part-frame mass properties (incl. area, bbox for GVP), inertia/principal, local-frame tessellation, depth precision | 10, 11, 40, 41, 72, 73 | 3 | M1 (M2 for exception-safe GProp) |
| M4 Exact import (merged with 04 XCH M3: KRN owns the command, reader, blob leaf; XCH M3 adds verify / provenance / product tree on top) | `importShapes` (STEP; IGES entry point for 04), blobs, `import_step_exact`, healing, classification, report, MCP/CLI wiring, quality `--mode brep`, v3 envelope + migration (§3.1) | 20, 21, 22, 23 (GVP attributes), 24 | 5-7 | M2 |
| M5 Robustness | commit validity gate, `validate_shape`, fuzzy booleans, argument analysis | 12, 13, 50, 51 | 2 | M2 |
| M6 Regression | signatures, `quality:kernel`, baselines | 60, 62 | 2 | M4 |
| M7 Persistent naming | element maps, naming grammar, resolution, UI repair, golden renaming plan green | 30, 31, 32 | 8-12 | M2, M6 |
| M8 Assemblies | shared definitions, assembly mass properties, instancing of results, LOD (GVP comparison and `export_step_ap242` moved to 04 XCH M2/M3) | 42, 70, 71 | 4-6 | M4, M7 (names for PMI later), 04 XCH M3 (product tree) |
| M9 Browser worker / native evaluation | Web Worker command execution; native OCP kernel spike | 03, 05 | 3-4 | M2 |
| M10 Face-query port | `GeometryKernel.faceQuery` (§5.9): faceDetails, faceContains, faceGraph, faceGeometry, projectOnFace, evaluateFace, tessellateFace, faceSamples, edgeSamples, edgeContinuity, distance, bspline (OCC); contract tests | 90, 91, 92 | 3 | M2 |

Total ≈ 35.5-46.5 engineer-weeks (M8 −1 after moving GVP/export to 04; +3 for the face-query port M10, which removes the
per-pack kernel work from 02/03/05/06/07). Downstream gaps: 07 FTR (holes/pockets need M4, M7), 03 GDT and 04 XCH (face names
M7; `massProperties` M3 and `import_step_exact` M4 for XCH M1/M3), 02 / 03 / 05 / 06 / 07 (face-query port M10), 05 FEA (exact faces M4, names M7), 02 SRF (NURBS ops need M2), 09 PLM (provenance M1/M6).

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
