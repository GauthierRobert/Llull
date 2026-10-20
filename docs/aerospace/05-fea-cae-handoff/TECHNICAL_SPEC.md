# Gap 05: Structural analysis (CAE) hand-off — technical specification

Gap id **FEA** · status: specification · written 2026-10-15 · functional spec: [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md)
· validation: [`validation/README.md`](validation/README.md) · sources: [`validation/sources.md`](validation/sources.md)

## 1. Current state in llull

| Area | What exists | Path | Limit for FEA |
| ---- | ----------- | ---- | ------------- |
| Structural solver | 2D frame analysis with the direct stiffness method (3 DOF per node), hinges and uniform member loads | `packages/core/src/lib/frame2d.ts` | Beams only, 2D, linear. No continuum, plate or shell elements and no eigen solver |
| Steel design checks | EN 1993 frame, beam, column and bracing checks, ULS 1.35G + 1.5Q, Horne αcr | `packages/domain-aec/src/industrial/{frames,steelDesign,purlins}/*.ts` (≈4.9k lines) | AEC-specific. Members come from a frame definition, not from solid geometry |
| Materials | `Material { name, density, color, metalness, roughness, finish? }`, `create_material`, `assign_material` | `packages/core/src/model/types.ts` (`Material`), `packages/core/src/commands/document/materials.ts` | No E, ν or allowables. Density is in g/(doc unit)³, used by `mass_properties` |
| Exact geometry | `GeometryKernel` with `evaluate`, `tessellate`, `topology` (faces with surface type and area, edges with mid points and samples) and `exportStep` | `packages/core/src/geometry/kernel.ts`, `packages/kernel-occt/src/*` | No face normals or centroids in `ShapeFace`, and no midsurface or defeature recipe nodes |
| Topological targeting | `edgesNear` points re-resolved per replay (KI5) | `packages/core/src/commands/brep/edgeSelection.ts` | Edges only. No `facesNear` |
| Python bridge | One short-lived CPython process per request (CadQuery), hard timeout (default 120 s), at most 2 concurrent runs, environment allow-list | `server/src/pythonExchange.ts`, `server/python/llull_bridge.py` | No `gmsh` op |
| Child processes | `trackChild()` registry with SIGKILL on shutdown | `server/src/childProcesses.ts` | Ready to reuse for `ccx` |
| Exchange transport | `CadExchangePort` and hand-written MCP exchange tools that apply document changes through the command bus | `packages/mcp/src/exchangeTools.ts`, `server/src/exchangeRoutes.ts`, `server/src/cli/exchange.ts` | A pattern to copy for `fea_mesh` / `fea_solve` / `fea_import_results` |
| Desktop | Electron runs the unchanged server, and relocatable CPython plus CadQuery are staged by `desktop/scripts/prepare-python.mjs` (KI6) | `desktop/` | No `ccx` binary and no `gmsh` wheel |
| MCP toolsets | `TOOLSET_NAMES = core, 2d, 3d, measure, parametric, assembly, exchange, building, civil` | `packages/mcp/src/toolsets.ts` | No `analysis` toolset. `TOOLSET_NAMES` must gain `'analysis'` plus a getter returning `pluginToolNames('analysis')` and the ✱ transport names (invariant: every registered command and exchange tool belongs to exactly one toolset) |
| Plugins | `CadPlugin { name, toolset, commands, guards?, document? }`. `installDefaultPlugins()` installs building, industrial and civil | `packages/core/src/plugins/plugin.ts`, `src/app/plugins.ts` | — |

A `grep` of `packages/`, `server/src` and `server/python` for `nastran|calculix|gmsh|von mises|finite element`
finds nothing outside the AEC frame code: there is no FE capability today.

## 2. Target architecture

```
src/ui (Analysis panels, result overlay)          server/ (transport: fea_mesh, fea_solve, fea_import_results, CLI `llull fea …`)
        │ dispatch                                         │ spawns: bundled CPython (gmsh, pyNastran, meshio) · bundled ccx
        ▼                                                  ▼
src/app  installDefaultPlugins() + caePlugin       packages/mcp: exchangeTools-style FEA tools + toolset "analysis"
        ▼
packages/domain-cae/src  (@cae)  ── CadPlugin "cae", toolset "analysis"
   commands/: create_analysis, set_part_idealization, add_fea_constraint, add_fea_load, set_mesh_controls,
              record_fe_mesh, record_fea_results, set_result_view, add_result_probe, compute_margins,
              check_analysis, dispose_margin (human gate), …
   decks/:    inpWriter.ts, bdfWriter.ts   (pure: AnalysisModel + FeMesh → text)
   results/:  frdReader.ts, datReader.ts, derivedFields.ts (von Mises, principal), margins.ts
   checks/:   analytic.ts (beam, plate k, Kirsch)
        ▼ (public core API only, L10)
packages/core/src
   model/analysis.ts      AnalysisModel types (like model/building.ts, model/civil.ts)
   model/types.ts         CadDocument.analysis?   (materials: gap 08 MaterialRecord, read only — TR-FEA-04)
   geometry/shapeRecipe   + recipe ops 'midsurface', 'defeature' (kernel boundary stays a SHAPE, KI5)
   geometry/kernel.ts     (gap 01) GeometryKernel.faceQuery?.faceDetails → centroid + normal for face matching / facesNear
   lib/meshQuality.ts     Verdict metric port (pure)
   lib/vonMises.ts        tensor helpers (pure)
packages/kernel-occt/src  occtMidsurface.ts, occtDefeature.ts (KernelOps), face centroid/normal in occtTopology.ts
```

**Laws respected:**

- **L1.** Every document change is a command. Meshing and solving are *transports* outside the document, like
  `import_step` today. They feed results back through the pure commands `record_fe_mesh` and `record_fea_results` on the command
  bus (undo and broadcast), which check the artifact store through an injected read-only port (§4.1).
- **L2.** `@cae` imports only core's public API. Processes, files and the network live in `server/` and `desktop/`.
- **L3.** Commands return a new document.
- **L4.** The `analysis` slice is the only analysis state. The big arrays (mesh, full results) live in a
  content-addressed cache keyed by hashes stored in the document. The document stays the source of truth because the cache can be rebuilt
  from document data: meshes from geometry plus controls plus mesher version, and results from a re-solve.
- **L5.** Schemas come from zod. The MCP view uses toolset `analysis`.
- **L6.** The server forwards and spawns. It holds no FE logic: deck writing and result parsing are pure functions in `@cae`.
- **L8.** Analysis commands record `FeatureStep`s. Targets are point-based and re-resolve on replay. Derived idealization
  geometry (midsurface, defeatured shape) is read-only plugin geometry, re-derived on load, and protected by derivation guards.
- **L9.** Midsurface and defeature are `ShapeRecipe` nodes evaluated by `ctx.kernel` (`requiresKernel: true`), and OCC implements
  them. Manifold returns null and the commands say that OCC is needed.
- **L10.** CAE is a new domain plugin `packages/domain-cae` (alias `@cae/*` in `tsconfig.base.json`), installed in
  `src/app/plugins.ts`. Core gets data types only, as it does for `building`/`civil`.

**Requirements (technical)**

| Id | Pri | Requirement |
| -- | --- | ----------- |
| TR-FEA-01 | MUST | New workspace `packages/domain-cae` with a `CadPlugin { name: 'cae', toolset: 'analysis', commands, guards, document }`. `document.validate`, `restore` and `derivedEntityIds` handle the `analysis` slice. |
| TR-FEA-02 | MUST | `CadDocument.analysis?: AnalysisModel` stays absent until the first analysis command. A document version bump with migration is not needed because the field is optional. The persistence validation (`commands/persistence/validation.ts`) delegates to the plugin `validate`. |
| TR-FEA-03 | MUST | `FeaTarget` resolution: `facesNear` picks the face whose surface (sampled tessellation) is nearest to each point. `edgesNear` reuses `edgeSelection.ts`. `pointsNear` picks the nearest B-rep vertex, or a mesh node when no vertex is within tolerance. Ties within 1e-6 × model size are an error. |
| TR-FEA-04 | MUST | FEA defines **no material fields of its own**. It consumes the gap 08 MAT material record (`../08-materials-standards-libraries/TECHNICAL_SPEC.md` TR-MAT-11 record / `PropertyValue` / `Provenance`, TR-MAT-01 units, TR-MAT-10 density resolution, TR-MAT-12 allowable query with no basis substitution). FEA only **reads** a resolved view per part (§3 `FeaMaterialView`): `E`, `nu`, optional `G`, `density`, and for margins `Ftu`/`Fty` (optionally `Fsu`/`Fcy`) with their `basis` and `provenance`. Materials are created and edited only with the gap 08 commands. |
| TR-FEA-05 | MUST | The FE mesh and results are stored in `FeArtifactStore` (server/desktop: `~/.llull/cache/fea/<sha256>.{mesh,res}.json.gz`, web: IndexedDB) under a `meshHash`/`resultsHash`. The document stores only summaries plus hashes. A missing artifact gives the state `missing` and asks for a re-mesh or re-solve, with no silent recompute. |
| TR-FEA-06 | MUST | Staleness is computed, never stored: `analysisInputHash = sha256(canonical JSON of {geometry recipeKeys of the analysed entities, idealization, materials used, constraints, loads, mesh controls})`. A mesh is valid iff its `inputHash` equals the current hash minus the loads and BCs. Results are valid iff their `inputHash` equals the full current hash. |
| TR-FEA-07 | MUST | Units: `unitSystem` is fixed at `create_analysis` from the document unit (mm → `N-mm-t-s`, m → `N-m-kg-s`, in → `lbf-in-slinch-s`). The writers convert the gap 08 record quantities (any unit `@lib/quantity` parses, TR-MAT-01) into the analysis system once, in `@cae/units.ts`. |
| TR-FEA-20 | SHOULD | Midsurface as a `ShapeRecipe` node `midsurface`, evaluated by OCC: a recipe fast path, then face-pairing (§5.2). Manifold returns null. |
| TR-FEA-21 | SHOULD | Defeature as a recipe node `defeature` (OCC `BRepAlgoAPI_Defeaturing`, or the Gmsh `occ.defeature` fallback) (§5.3). |
| TR-FEA-30 | MUST | Meshing op in `server/python/llull_bridge.py` (`op: "mesh"`), deterministic (`General.NumThreads = 1`). `meshHash` = sha256 of the canonical node and element arrays (§5.4). |
| TR-FEA-31 | MUST | `@lib/meshQuality.ts` is a pure port of the Verdict metrics, cross-checked with Gmsh `getElementQualities` (§5.5). |
| TR-FEA-32 | MUST | llull face to Gmsh surface mapping by area and centroid. Ambiguity is an error (§5.1). |
| TR-FEA-33 | MUST | `record_fe_mesh` / `record_fea_results` stay registry commands (undo, replay, broadcast) but are **validated against the artifact store** (§4.1 trust model): the referenced artifact must exist in `FeArtifactStore` under `meshHash`/`resultsHash`, its content sha256 must equal that hash, and the summary must equal the one recomputed from the artifact. Otherwise the command is a no-op with a reason. |
| TR-FEA-40 | MUST | `@cae/decks/inpWriter.ts`: pure and deterministic. Output is byte-identical for identical inputs (§5.6). |
| TR-FEA-41 | MUST (V1) | `@cae/decks/bdfWriter.ts`: small-field fixed format, verified by pyNastran `read_bdf(xref=True)` (§5.6). |
| TR-FEA-50 | MUST | `@cae/results/{frdReader,datReader}.ts`: streaming, fixed-column parse (§5.7). |
| TR-FEA-60 | MUST | `@cae/results/margins.ts` implements §5.8. There is no averaging across parts, and singular zones are reported separately. |
| TR-FEA-70 | MUST | `server/src/feaSolve.ts` spawns `ccx` with `trackChild`, a timeout, cancel, and log capture (§5.9). |
| TR-FEA-80 | SHOULD | Performance budgets in §8 are enforced by the production-gate scenario VC-FEA-53. |
| TR-FEA-90 | MUST | Agent-first result contract (AF-10/11/31–35): `compute_margins`, `check_analysis` and `fea_report` follow §5.8/§7.1; factors carry `source`/`defaulted`; `unverified` is the OR of all gap 08 inputs' flags; `reviewRequired` is always true on margins. |
| TR-FEA-91 | MUST | `dispose_margin` verifies a human-held signature through the gap 09 signing port; the CLI/MCP agent path cannot supply one (AF-34). |
| TR-FEA-92 | SHOULD (V1, RS-5) | Headless field plots (`render_fea_results … --save plot.png`) get a GPU raster path through `llull-compute raster` (crate `llull-raster`, wgpu offscreen) per §2.1. The TS z-buffer `packages/domain-cae/src/results/fieldRaster.ts` stays the reference, the hash path and the small-case path. Native vs TS pixel agreement: VC-FEA-29. |

### 2.1 Stack amendment (RS1, 2026-10-18)

Decided by the owner in [RS1](../../decisions/RS1-native-compute.md) (programme step **RS-5**, shared with plant 09 VIS).

| Item | Before | Now |
| ---- | ------ | --- |
| Field-plot raster (`render_fea_results` → `fieldPlotSvg.ts` → `fieldRaster.ts`) | CPU z-buffer in TS (2× supersampling, PNG embedded in the SVG) | unchanged as the default, the reference and the hash path; small plots always use it |
| Headless CLI renders of large plots | same TS raster | host path in `server/`: the CLI writes the same `RasterInput` (faces, view, levels, area) to a job folder and runs `llull-compute raster` (crate `llull-raster`, wgpu offscreen, CPU twin per RS1 §2 rule 6); the returned PNG goes into the same SVG frame (legend, markers, title still from `fieldPlotSvg.ts`) |
| Selection | — | TS below a triangle threshold (TBD — measure the crossover on the reference machine), or when `--raster ts` is given; native above it or with `--raster gpu`; missing binary or no adapter → TS with a logged reason (`NATIVE_TOOL_MISSING`) |
| Provenance | — | `data.raster = { engine: 'ts' \| 'native-gpu' \| 'native-cpu', device?, deterministic }`; a GPU raster is a picture (`deterministic: false`); any image hash that a test or report pins comes from the TS raster |
| Viewport result colouring | WebGL (three.js, GPU attribute swap) | unchanged: the viewport stays WebGL; RS-5 is headless only |

The registry command stays pure and writes nothing to the document (L1); `packages/domain-cae` does not import native code (L2).

## 3. Data model

```ts
// Materials: NO new core material fields (TR-FEA-04). Gap 08 owns MaterialRecord / PropertyValue / Provenance.
// @cae/materials.ts builds this read-only view per analysed part from the gap 08 record (Material.recordId):
export interface FeaMaterialView {
  readonly materialName: string; readonly recordId: string;
  /** Preferred PropertyValues, converted to the analysis unit system (TR-FEA-07). G absent = E / (2 (1 + nu)). */
  readonly E: number; readonly nu: number; readonly G?: number; readonly density: number;
  /** For compute_margins only; each carries the gap 08 basis + provenance unchanged (shown in MS reports). */
  readonly allowables: Partial<Record<'Ftu' | 'Fty' | 'Fsu' | 'Fcy', { value: number; basis: string; provenance: string }>>;
}
export interface CadDocument { /* existing fields */ analysis?: AnalysisModel }

// packages/core/src/model/analysis.ts (new)
export type AnalysisType = 'static' | 'modal' | 'buckling';
export type FeSolver = 'calculix' | 'nastran';
export type UnitSystem = 'N-mm-t-s' | 'N-m-kg-s' | 'lbf-in-slinch-s';
export type Idealization =
  | { readonly kind: 'solid' }
  | { readonly kind: 'plane_stress'; readonly thickness: number; readonly sourceFacesNear: readonly Vec3[] }
  | { readonly kind: 'shell'; readonly thickness: number | 'auto'; readonly offset: 'mid' | 'top' | 'bottom';
      readonly midsurface: { readonly maxThickness: number; readonly angularTolDeg: number } }
  | { readonly kind: 'beam'; readonly section: string };            // V2

export interface FeaTarget {
  readonly entityId: EntityId;
  readonly facesNear?: readonly Vec3[];
  readonly edgesNear?: readonly Vec3[];
  readonly pointsNear?: readonly Vec3[];
  /** Imprint: restrict to the curve where the target faces meet this plane (LE10 mid-plane edge). */
  readonly intersectPlane?: { readonly point: Vec3; readonly normal: Vec3 };
}
export interface FeaConstraint {
  readonly id: string; name: string; kind: 'fixed' | 'pinned' | 'symmetry' | 'displacement';
  /** displacement only; absent DOF = free. Values in analysis length unit (0 = fixed). */
  dofs?: Partial<Record<'ux' | 'uy' | 'uz' | 'rx' | 'ry' | 'rz', number>>;
  target: FeaTarget;
}
export type LoadCategory = 'limit' | 'ultimate';
export interface FeaLoad {
  readonly id: string; name: string; loadCase: string; category: LoadCategory;
  kind: 'force' | 'pressure' | 'gravity' | 'moment';
  target?: FeaTarget;                 // absent for gravity
  vector?: Vec3;                      // force N / moment N·mm (analysis units) / gravity accel
  magnitude?: number;                 // pressure, + = compressive (into the material)
  distribution?: 'total' | 'per_node';
  /** moment / remote force: distributing coupling reference point (RBE3 / *DISTRIBUTING COUPLING). */
  referencePoint?: Vec3;
}
export interface MeshControls {
  mesher: 'gmsh' | 'netgen'; elementFamily: 'tet' | 'tri' | 'quad' | 'shell_quad' | 'shell_tri' | 'hex_dominant';
  order: 1 | 2; globalSize: number; minSize?: number;
  refinements: { target: FeaTarget; size: number }[];
  optimize: 'default' | 'netgen' | 'high_order' | 'none';
}
export interface FactorSet {
  /** 14 CFR 25.303 default 1.5 on limit loads. */
  ultimate: number;
  /** Yield (limit) factor, default 1.0 (no detrimental permanent deformation at limit, 25.305). */
  yield: number;
  /** Additional multiplicative factors with mandatory justification (e.g. fitting factor). */
  extra: { name: string; value: number; justification: string }[];
}
export interface MeshSummary {
  readonly meshHash: string; readonly inputHash: string; readonly mesher: string; readonly mesherVersion: string;
  readonly nodes: number; readonly elements: Record<string, number>;     // e.g. { C3D10: 41233 }
  readonly quality: QualitySummary; readonly warnings: readonly string[];
  /** llull face index -> mesher surface tag, with match residuals (TR-FEA-32). */
  readonly faceMap: readonly { entityId: EntityId; faceIndex: number; tag: number; residual: number }[];
}
export interface QualitySummary {
  readonly metrics: Record<string, { min: number; max: number; p01: number; p99: number; outsideAcceptable: number }>;
  readonly inverted: number;
}
export interface ResultsSummary {
  readonly resultsHash: string; readonly inputHash: string; readonly solver: string; readonly solverVersion: string;
  readonly loadCases: readonly {
    name: string; category: LoadCategory;
    maxVonMises: { value: number; at: Vec3; entityId: EntityId };
    maxDisplacement: { value: number; at: Vec3 };
  }[];
  readonly frequenciesHz?: readonly number[]; readonly bucklingFactors?: readonly number[];
  readonly units: UnitSystem;
}
export interface AnalysisCase {
  readonly id: string; name: string; type: AnalysisType; solver: FeSolver; unitSystem: UnitSystem;
  modes?: number; factors: FactorSet;
  parts: Record<EntityId, Idealization>;
  constraints: Record<string, FeaConstraint>; constraintOrder: string[];
  loads: Record<string, FeaLoad>; loadOrder: string[];
  mesh: MeshControls; meshSummary?: MeshSummary; results?: ResultsSummary;
  probes: Record<string, { name: string; point: Vec3; quantity: string }>;
  view?: { field: 'von_mises' | 'u_mag' | 'u_x' | 'u_y' | 'u_z' | 's_xx' | 's_yy' | 's_zz' | 'mode';
           loadCase?: string; mode?: number; deformationScale: number };
}
export interface AnalysisModel { cases: Record<string, AnalysisCase>; caseOrder: string[] }

// Cache artifacts (not in the document) — @cae/artifacts.ts
export interface FeMesh {
  readonly nodes: Float64Array;                        // xyz, analysis units
  readonly blocks: readonly { type: FeElementType; partEntityId: EntityId; conn: Uint32Array }[];
  readonly nodeSets: Record<string, Uint32Array>; readonly faceSets: Record<string, Uint32Array>; // per target id
}
export type FeElementType = 'C3D4' | 'C3D10' | 'CPS3' | 'CPS6' | 'CPS4' | 'CPS8' | 'S3' | 'S6' | 'S4' | 'S8';
```

Ids follow the step-scoped convention: `an-<step>.<k>`, `fc-…` and `fl-…` (L8).
The canonical element naming is CalculiX/ABAQUS, and the BDF writer maps C3D4→CTETRA(4), C3D10→CTETRA(10), S4→CQUAD4,
S3→CTRIA3, S8→CQUAD8 and S6→CTRIA6 [R14]. The node order follows each code's convention, and it is unit-tested.

## 4. Commands

The plugin `cae` uses toolset `analysis`. ✱ marks a transport tool (MCP/CLI/REST), hand-written like the
`exchangeTools`. It is not a registry command, because it runs external processes, and it applies its result through the
pure commands in the table.

| Name | Kind | Params sketch | Tags |
| ---- | ---- | ------------- | ---- |
| (gap 08) `define_material_record`, `set_material_property`, `create_material` + `recordId` | mutating, core (owned by gap 08) | see gap 08 TECHNICAL_SPEC §4.1 | FEA adds only a validation rule on `set_material_property`: `E` > 0, `G` > 0, −1 < `nu` < 0.5 → otherwise no-op |
| `create_analysis` | mutating | `{ name, analysisType, solver?='calculix', unitSystem?, modes?=10, factors?: { ultimate?=1.5, yield?=1.0, extra? } }` | @affects analysis.cases · @invariant unitSystem matches doc units unless explicit · @failure modes ∉ [1, 200] |
| `delete_analysis` | mutating | `{ analysisId }` | @affects analysis |
| `set_part_idealization` | mutating | `{ analysisId, entityId, idealization: 'solid'\|'plane_stress'\|'shell', thickness?, sourceFacesNear?, offset?, midsurface? }` | @affects case.parts · @failure non-3D entity, plane_stress source face not planar, shell on Manifold |
| `extract_midsurface` | query (requiresKernel) | `{ entityId, maxThickness, angularTolDeg?=1 }` → `data { faces, coverage, unpairedFaces[], thicknesses[] }` | preview for UI/agents. The geometry is derived when idealization = shell |
| `defeature_for_analysis` | mutating (requiresKernel) | `{ analysisId, entityId, maxFeatureSize?, facesNear? }` | @affects case.parts[e].defeature (recipe node) · @invariant design entity untouched · @failure OCC Defeaturing refused → summary names the faces |
| `add_fea_constraint` / `update_fea_constraint` / `delete_fea_constraint` | mutating | `{ analysisId, name, kind, dofs?, target }` | @affects case.constraints · @failure target unresolved / ambiguous |
| `add_fea_load` / `update_fea_load` / `delete_fea_load` | mutating | `{ analysisId, name, kind, loadCase, category, target?, vector?, magnitude?, distribution?, referencePoint? }` | @failure vector missing for force/gravity, magnitude missing for pressure |
| `set_analysis_factors` | mutating | `{ analysisId, ultimate?, yield?, extra? }` | @invariant every factor ≥ 1, extra needs a justification |
| `set_mesh_controls` | mutating | `{ analysisId, mesher?, elementFamily, order, globalSize, minSize?, refinements?, optimize? }` | @invariant globalSize > 0, refinement size ≤ globalSize |
| `record_fe_mesh` | mutating (registry; validated, §4.1) | `{ analysisId, summary: MeshSummary }` | @affects case.meshSummary, clears results · @invariant artifact for `meshHash` exists in the store, its sha256 = `meshHash`, summary = recomputed summary · @failure artifact missing / hash or summary mismatch / inputHash ≠ current → no-op |
| `record_fea_results` | mutating (registry; validated, §4.1) | `{ analysisId, summary: ResultsSummary }` | @invariant as `record_fe_mesh` for `resultsHash` · @failure no mesh, meshHash mismatch, artifact missing, hash or summary mismatch → no-op |
| `set_result_view` | mutating (presentation, like `set_camera`) | `{ analysisId, field, loadCase?, mode?, deformationScale? }` | — |
| `add_result_probe` / `delete_result_probe` | mutating | `{ analysisId, name, point, quantity }` | — |
| `fea_report` | query | `{ analysisId }` (all values with units, AF-10) → `data { state: 'unmeshed'\|'meshed'\|'solved'\|'stale'\|'missing', mesh, quality, results, probes }` | read-only |
| `compute_margins` | query | `{ analysisId, criterion?='von_mises', allowable?: 'ftu'\|'fty'\|{ value, unit }, groupBy?: 'part'\|'target', loadCases?, marginalBand?: number (MS units, no default) }` → `data` shape §5.8 | @invariant every factor named with `source` + `defaulted` (AF-31); every row `reviewRequired: true` (AF-33); `unverified` propagated from gap 08 inputs (AF-32) · @failure `FEA_RESULTS_STALE`, `FEA_RESULTS_MISSING`, `FEA_MATERIAL_NO_ALLOWABLE` (unless an explicit allowable is given) |
| `check_analysis` | query | `{ analysisId }` → `data { status: 'pass'\|'warn'\|'fail', items: [{ code, severity, ids[], path?, message, remediation }], reviewRequired: true }` | read-only readiness check (AF-20) over set-up, mesh, results and margins; codes §7.1. The agent ends every FEA job with it |
| `dispose_margin` | mutating, **human gate** | `{ analysisId, rowId, decision: 'accepted'\|'rejected'\|'redesign', justification, signature }` | @affects case.dispositions · @invariant `signature` must verify against a human-held key through the gap 09 signing port (`humanSignatureRequired`); the disposition records rowId, the results hash and the signer · @failure agent caller or no valid human signature → `FEA_HUMAN_GATE`, doc unchanged; stale results → `FEA_RESULTS_STALE` |
| `analytic_check` | query | `{ check: 'cantilever'\|'ss_beam'\|'ss_plate_buckling'\|'kirsch_kt', inputs }` → value + formula | pure. Matches `generate_fea_analytic.py` |
| ✱ `fea_mesh` | transport | `{ analysisId }` | runs the Gmsh op, stores the artifact, dispatches `record_fe_mesh` |
| ✱ `fea_solve` | transport | `{ analysisId, timeoutS?=600, threads? }` | writes the INP, runs `ccx`, parses FRD/DAT, stores the artifact, dispatches `record_fea_results` |
| ✱ `fea_import_results` | transport | `{ analysisId, path, format: 'frd'\|'op2' }` | external results. They must match `meshHash`, or they are imported as a review-only `foreign` mesh |
| ✱ `fea_export` | transport | `{ analysisId, format: 'calculix_inp'\|'nastran_bdf'\|'vtu', path? }` → `{ text \| path, sha256 }` | the **only** solver-deck export (no registry command: a deck needs the mesh artifact, which is not document data). Pure writers in `@cae/decks` plus a file write. Refuses stale or missing meshes, materials without E/ν, and inverted elements |
| ✱ `fea_result_field` | transport (read) | `{ analysisId, field, loadCase?, mode? }` → per-vertex scalars of the skin mesh | for UI/MCP rendering. Nothing is stored |

### 4.1 Trust model for `record_fe_mesh` / `record_fea_results` (TR-FEA-33)

They are ordinary registry commands, so any caller (UI, CLI, MCP agent) can reach them through `execute` (L5).
They are therefore **never trusted on their params alone**:

1. `ctx.feaArtifacts` (an injected read-only port, like `ctx.kernel`; implemented by `server/`/`desktop/` over
   `FeArtifactStore` and by `src/ui` over IndexedDB) must return the artifact for `meshHash` / `resultsHash`. No port or
   no artifact → no-op, "artifact not found".
2. The artifact's content sha256 must equal the hash, and the summary (node/element counts, quality, max values,
   frequencies) must equal the summary recomputed from it by the pure `@cae` summarisers → otherwise no-op, "summary mismatch".
3. `inputHash` must equal the current analysis input hash (TR-FEA-06); results also need `meshHash` = the recorded mesh.
4. Only artifacts written by the host transports (`fea_mesh`, `fea_solve`, `fea_import_results`) enter the store, and each
   records its producer (mesher/solver name and version, `transport` or `foreign`). An imported foreign result is shown as
   review-only and is never used by `compute_margins`.

So an agent can replay or re-record a real artifact, but cannot inject a fabricated mesh or result summary. Replay on a
machine without the artifact leaves the step recorded and the state `missing` (TR-FEA-05), never a guessed value.

## 5. Kernel / algorithms

### 5.1 Face data and targeting (TR-FEA-03, TR-FEA-32)

- Face centroid and normal come from the gap 01 face-query port (`GeometryKernel.faceQuery?.faceDetails`, TR-KRN-90..92,
  docs/aerospace/01-exact-brep-kernel/TECHNICAL_SPEC.md §5.9); FEA requires `centroid: Vec3` and `normal?: Vec3` (planar faces) from `BRepGProp::SurfaceProperties`. OCC already uses
  `BRepGProp`/`GProp_GProps` (`occtTopology.ts`), and the plane comes from `BRepAdaptor_Surface`.
- `facesNear` resolution measures the distance from the point to each face's sampled tessellation triangles (reusing `tessellate`) and takes the
  argmin. Ambiguity means a second-best face within `1e-6 × diag(AABB)`.
- **TR-FEA-32 face mapping** from llull to Gmsh after `exportStep` → `gmsh.model.occ.importShapes(file)` [R10]:
  for every llull face, the candidate Gmsh surfaces are those with `|area − area'| ≤ 1e-6·area` (`occ.getMass(2, tag)`) and centroid distance
  ≤ 1e-6·diag (`occ.getCenterOfMass`). Exactly one candidate is required, otherwise the run fails with `AMBIGUOUS_FACE_MAP`.
  The residuals go into `MeshSummary.faceMap`. Element and node sets for each target are then built from Gmsh physical groups
  (`model.addPhysicalGroup`) [R10].
- `intersectPlane` (LE10 mid-plane edge) is applied in Gmsh with `occ.fragment` of the volume against a plane surface before
  meshing. This imprints the curve, and the physical group takes the new curves that lie in the plane on the target faces.

### 5.2 Midsurface (FR-FEA-05, TR-FEA-20)

This is llull's design. No source was verified for it (see sources.md, "Not verified").

1. Classify the faces of the solid's exact B-rep as `plane` / `cylinder` / other (`FaceSurface`).
2. **Pairing.** Two planar faces form a pair when their normals are antiparallel within `angularTolDeg`, their plane gap t is ≤ `maxThickness`, and
   their projections overlap (`BRepAlgoAPI_Common` of the projected faces has area > 0). Two cylindrical faces form a pair when they are coaxial
   with radius difference t ≤ `maxThickness` and their angular and axial spans overlap.
3. **Mid faces.** Planar pairs get a face on the mid plane bounded by the projected overlap region. Cylindrical pairs get a
   cylinder of radius (r1 + r2)/2 over the overlap spans. Thickness per mid face = t.
4. **Connection.** Each mid face is extended up to its neighbours' mid planes (`BRepAlgoAPI_Splitter`/`Section`), the faces are
   sewn (`BRepBuilderAPI_Sewing`, tolerance = 0.5 × min t) and `ShapeUpgrade_UnifySameDomain` runs (already used after booleans).
5. **Coverage** = Σ area(paired faces) / Σ area(all faces except edge-strip faces of width ≤ maxThickness).
   Unpaired faces are listed. Shell export needs coverage ≥ 0.98, or the user overrides it.
6. **Fast path.** When the recipe proves a constant wall, the midsurface comes straight from the recipe: a `shell_solid` result
   (offset by t/2 of the kept faces through `BRepOffsetAPI_MakeOffsetShape`, already bound in `occtKernel.ts`), or an
   `extrude_profile` of a thin closed polyline (an extrusion of the profile's midline). This fast path is what VC-FEA-03 tests.
7. The result is a new `ShapeRecipe` node `{ op: 'midsurface', source, maxThickness, angularTolDeg }`. The kernel returns a
   handle to an open shell (a `TopoDS_Shell`/compound), and `tessellate` renders it as an overlay. `exportStep` writes it for Gmsh.

### 5.3 Defeaturing (FR-FEA-06)

Recipe node `{ op: 'defeature', source, faces: Vec3[] | { maxFeatureSize } }`. On OCC it uses `BRepAlgoAPI_Defeaturing`.
**Open question:** is it exposed in the opencascade.js 1.1.1 build (`packages/kernel-occt/package.json`)? If not, the fallback is the
Gmsh op `gmsh.model.occ.defeature(volumeTags, surfaceTags)` in the bridge [R10]. Feature detection by size: a cylindrical face
of radius ≤ s/2 that forms a through-hole loop, a fillet (cylinder or torus blend face, radius ≤ s), or a chamfer (planar strip of width ≤ s).

### 5.4 Meshing op (Gmsh, bundled CPython): `server/python/llull_bridge.py` op `mesh`

```
request { stepBase64, targets: [{id, faces:[...], edges:[...], points:[...], intersectPlane?}], controls, faceRefs:[{entityId, faceIndex, area, centroid}] }
gmsh.initialize(); gmsh.option.setNumber("General.NumThreads", 1)   # determinism (VC-FEA-06)
gmsh.model.occ.importShapes(step); occ.synchronize(); [occ.fragment for intersectPlane]
face map (5.1) → addPhysicalGroup per target; size fields: Distance + Threshold per refinement (as FeenoX LE10 .geo [R43])
Mesh.ElementOrder = order; Mesh.SecondOrderIncomplete = 0; Mesh.Algorithm3D (HXT=10 or Delaunay=1); recombine for quads
gmsh.model.mesh.generate(dim); mesh.optimize("Netgen"|"HighOrder") per controls  [R10]
qualities = mesh.getElementQualities(tags, "minSJ") and "gamma"  → cross-check with the TS Verdict port
response { nodes, blocks, sets, gmshVersion, qualities histograms }  (gzip+base64; MAX_OUTPUT_BYTES applies)
```

The bridge's existing limits (timeout, a queue of 2 concurrent runs, environment allow-list) apply. The mesher version string goes into the summary.

### 5.5 Quality (FR-FEA-10, TR-FEA-31)

`@lib/meshQuality.ts` is a pure port of the Verdict definitions [R12]: tet aspect ratio `Lmax/(2√6·r_in)`, tet scaled
Jacobian `J√2/λmax`, quad aspect ratio `Lmax·ΣL/(4A)`, quad scaled Jacobian, skew, warpage, triangle minimum angle. For quadratic
elements it uses the corner nodes, plus Gmsh `minSJ` (the sampled Jacobian, which covers curvature) [R10]. Acceptable ranges come from Verdict:
tet AR [1, 3], tet SJ [0.5, 1], quad AR [1, 1.3], quad SJ [0.3, 1], skew [0, 0.5], warpage [0.3, 1], tri min angle
[30°, 60°]. Outside the range raises a warning, **except warpage**: Verdict quotes its acceptable range as [0.3, 1], but by its own definition (1 − min(n̂0·n̂2, n̂1·n̂3)³) a flat quad scores 0, so the quoted range would flag every planar quad. Warpage is reported in the histogram only, never as a warning, until open question 10 is settled. **Inverted** (SJ ≤ 0 or minDetJac ≤ 0) **blocks** export and solve.
Adequacy warnings: fewer than 2 elements through a thickness (solid) or span (the CalculiX simplebeam example is 10 % stiff with 1 element [R30]).

### 5.6 Deck writers (pure, `@cae/decks`)

**CalculiX INP** (keywords from the manual [R30]):

```
** llull <version> analysis <name> units N-mm-t-s  inputHash <h>  meshHash <m>
*NODE, NSET=NALL
*ELEMENT, TYPE=C3D10, ELSET=P_<entity>
*NSET, NSET=C_<constraint>      *ELSET / *SURFACE, NAME=S_<load>, TYPE=ELEMENT  (face ids S1..S4 per element face)
*MATERIAL, NAME=<material>  *ELASTIC  E, nu   *DENSITY rho
*SOLID SECTION, ELSET=P_<e>, MATERIAL=<m>   |   *SHELL SECTION, ELSET=..., MATERIAL=..., OFFSET=0  <t>
*BOUNDARY  C_<c>, 1, 3 (fixed) | per DOF value     (symmetry: normal DOF of a planar face)
*STEP  *STATIC | *FREQUENCY  <modes> | *BUCKLE  <modes>
*CLOAD (force total -> equal split on nodes for 'per_node'; 'total' -> consistent nodal loads from face integration)
*DLOAD  S_<load>, P<k>, <p>      (pressure, + = into the face: matches the llull convention)
*DLOAD  ELSET, GRAV, g, nx, ny, nz
*DISTRIBUTING COUPLING (moment/remote load; test deck distcoup.inp exists in the suite [R30])
*NODE FILE  U   *EL FILE  S, E   *NODE PRINT / *EL PRINT for probes    *END STEP
```

The test-suite name `test/distcoup.inp` was checked in the pinned tree. Each keyword's exact syntax is unit-tested
against a CalculiX run (VC-FEA-15/40), so the writer does not depend on prose descriptions.

**Nastran BDF** (V1). This is small-field fixed format: 8-character fields, 10 per line, continuation lines. Reals use
`%8.7g`-style formatting with Nastran-legal exponent forms, and every entry is round-trip checked with pyNastran [R14]:

```
SOL 101 | 103 | 105
CEND
TITLE = <analysis>   SUBCASE n / LABEL = <loadCase>  SPC = 1  LOAD = n   (103: METHOD = 10; 105: STATSUB + METHOD)
DISP(PLOT)=ALL  STRESS(PLOT)=ALL
BEGIN BULK
GRID    NID CP X1 X2 X3 CD PS SEID                      [R14]
CTETRA  EID PID G1..G4 (G5..G10)                         [R14]
CQUAD4  EID PID N1 N2 N3 N4 THETA/MCID ZOFFS ; TFLAG T1..T4   [R14][R14a]
PSOLID  PID MID CORDM IN STRESS ISOP FCTN               [R14]
PSHELL  PID MID1 T MID2 12I/T**3 MID3 TS/T NSM          [R14]
MAT1    MID E G NU RHO A TREF GE ; ST SC SS MCSID       [R14]
SPC1    SID C G1 G2 …  (C = DOF digits, e.g. 123456)     [R14]
FORCE   SID G CID F N1 N2 N3                             [R14]
PLOAD4  SID EID P1 … (solid faces: G1 G3/G4)             [R14]
GRAV    SID CID A N1 N2 N3 MB                            [R14]
EIGRL   SID V1 V2 ND …                                   [R14]
ENDDATA
```

`$ llull:` comment lines map Nastran ids back to llull names (materials, targets, load cases). There is no official QRG check yet
(open question 6). G (shear modulus) is written only when it is given explicitly, so Nastran derives it.

### 5.7 Result readers and derived fields

- **FRD** (`@cae/results/frdReader.ts`). The fixed-column ASCII format follows the reader in FreeCAD [R15]: `2C` node block,
  `3C` element block, `-4  DISP` / `STRESS` / `TOSTRAIN` blocks, `-1` record = node id in cols 4–13 then 12-character values.
  The stress order is Sxx, Syy, Szz, Sxy, Syz, Szx. `PMODE` and `1PSTEP` mark eigenmodes and steps. CalculiX writes nodal
  values that are extrapolated and averaged [R30]. Buckling factors come from the `.dat` file ("B U C K L I N G   F A C T O R   O U T P U T").
  Frequencies come from the `.dat` "E I G E N V A L U E   O U T P U T" table (cycles/time column). Both layouts were checked in `beamb.dat.ref` / `beamf.dat.ref`.
- **OP2** (V1) uses pyNastran in the bundled Python (`op2 = OP2(); op2.read_op2(path)`), reduced to the same JSON artifact.
- **Shell expansion.** CalculiX expands S4/S8 shells into C3D8I/C3D20R volumes [R30]. FRD output for shells is therefore 3D
  (`*NODE FILE, OUTPUT=3D` as in `shell1.inp`) or 2D (`OUTPUT=2D`). The reader requests `OUTPUT=2D` for shells and maps the
  results back to midsurface nodes. Top and bottom fibre stresses come from `*EL FILE` section points (open question 7).
- **von Mises:** σvm = √(½[(σxx−σyy)² + (σyy−σzz)² + (σzz−σxx)²] + 3(τxy² + τyz² + τzx²)). Principal stresses come from the cubic
  invariants (closed-form trigonometric solution, tested against eigen decomposition).
- **Skin mesh** for display: the boundary faces of the volume elements (faces seen once). Quadratic faces are split into 4 linear
  triangles. Per-vertex scalars are mapped through a perceptually uniform colormap (`dataviz` palette rules). Deformation is
  `x + s·u`.

### 5.8 Margins (FR-FEA-18)

```
for each load case LC, each group g (part or target region):
  applied = max over nodes in g of σvm (or a component per criterion)          [element-nodal, averaged within the part only]
  if LC.category == 'limit':
      MS_ult   = Ftu / (applied × FoS_ult × Π extra) − 1        (NASA-STD-5001B form [R3]; FoS_ult default 1.5 per 25.303 [R1])
      MS_yield = Fty / (applied × FoS_yield × Π extra) − 1      (25.305(a): no detrimental permanent deformation at limit [R2])
  if LC.category == 'ultimate':  MS_ult = Ftu / (applied × Π extra) − 1   (25.303: no further factor on ultimate loads [R1])
row = { group, LC, criterion, applied, allowable, basis, factors, MS, status: MS ≥ 0 ? 'PASS' : 'FAIL', at: Vec3 }
```

Averaging is never done across material or part boundaries. Nodes within `singularityRadius` of a point-load node or a re-entrant
sharp edge are reported separately as `singular: true` and do not set the MS by default (open question 8).
Expected values: `fea_analytic_expected.json` VC-FEA-20.

Status: `FAIL` if MS < 0; `MARGINAL` if 0 ≤ MS < `marginalBand` (only when the caller set one; there is no default band, AF-31);
otherwise `PASS`. `FAIL` and `MARGINAL` rows get `disposition: "pending_human"` until `dispose_margin` (human gate, AF-34).

`compute_margins` `data` shape (AF-10, AF-31…35):

```json
{
  "analysisId": "an-5.1", "unitSystem": "N-mm-t-s", "resultsHash": "…", "minMs": -0.0666667,
  "factors": {
    "ultimate": { "value": 1.5, "source": "14 CFR 25.303", "defaulted": true },
    "yield":    { "value": 1.0, "source": "derived from 14 CFR 25.305(a) (limit load, no detrimental permanent deformation)", "defaulted": true },
    "extra": []
  },
  "rows": [{
    "rowId": "r4", "part": "box-3.1", "region": "part", "loadCase": "LC1", "category": "limit", "criterion": "von_mises",
    "appliedMPa": 200, "allowableMPa": 280, "allowable": { "property": "Ftu", "basis": "B", "provenance": "MAT:<id> Table …" },
    "ms": -0.0666667, "status": "FAIL", "code": "FEA_MS_NEGATIVE", "atMm": [0, 10, 0], "singular": false,
    "provenance": { "formula": "MS = allowable / (applied × FoS × Π extra) − 1", "standard": ["NASA-STD-5001B", "14 CFR 25.303"] },
    "unverified": false, "unverifiedReasons": [],
    "reviewRequired": true, "reviewReason": "margin of safety supports a structural substantiation decision",
    "disposition": "pending_human"
  }],
  "reviewRequired": true,
  "summary": "4 rows, min MS −0.067 (FAIL, LC1). Computed by llull, not approved — needs a qualified engineer."
}
```

Field names carry units for the analysis unit system (`…MPa`, `…Mm` for N-mm-t-s; `…Psi`, `…In` for lbf-in). Expected values of
this shape: `fea_analytic_expected.json` VC-FEA-60…64.

### 5.9 Solve (FR-FEA-16)

`server/src/feaSolve.ts` writes `job.inp` into a temp dir and spawns `ccx -i job` (`LLULL_CCX`, default: the bundled path on desktop),
with `OMP_NUM_THREADS`/`CCX_NPROC_*` as the user chose (the CalculiX manual covers parallel runs [R30]). It tracks the process with `trackChild`,
applies the timeout (default 600 s) and supports cancel through the REST/CLI ticket. Exit code ≠ 0, or `*ERROR` in stdout, means failure with the
last 64 KB of log. On success it parses `job.frd` and `job.dat`, then stores the artifact and dispatches `record_fea_results`.

### 5.10 Numerical tolerances

| Item | Value |
| ---- | ----- |
| Face-map area / centroid match | 1e-6 relative to the area / model diagonal |
| Unit conversion round-trip | 1e-12 relative |
| FRD parse | exact string-to-float (IEEE double) |
| Midsurface sewing tolerance | 0.5 × min thickness |
| Benchmarks | see validation README (1–8 %, each justified) |

## 6. Interop & persistence

| Format | Direction | Implementation | Licence of the dependency |
| ------ | --------- | -------------- | ------------------------- |
| STEP AP214 (geometry → mesher) | out | existing `exportStep` (KI5) | — |
| Gmsh API / MSH | internal | bundled CPython `gmsh` wheel 4.15.2 [R10] | GPL-2.0-or-later with an exception |
| CalculiX/Abaqus INP | out | `@cae/decks/inpWriter.ts` (pure TS) | — |
| Nastran BDF | out | `@cae/decks/bdfWriter.ts` (pure TS), checked with pyNastran [R14] | pyNastran BSD-3 (test/import only) |
| CalculiX FRD + DAT | in | `@cae/results/frdReader.ts`, `datReader.ts` (pure TS) | — |
| Nastran OP2 | in | pyNastran in the bridge [R14] | BSD-3 |
| VTU | out | meshio in the bridge [R13], or a TS writer | MIT |
| Document | persist | `analysis` slice in `.llull` JSON. The artifacts sit in the cache (TR-FEA-05) and can be bundled into a `.llullz` package on "Save with results" (V1) | — |

**Document validation** (plugin `validate`): ids unique, targets reference existing entities, every number finite, factors ≥ 1,
summaries well formed. Recipes inside `midsurface`/`defeature` nodes are checked like other recipes (KI5).

## 7. UI / CLI / MCP surfaces

- **UI** (review and approval surface only; `src/ui/panels/analysis/*`, a viewport branch `src/ui/viewport/3d/AnalysisOverlay.tsx`). Panels: Analysis tree (cases,
  parts, constraints, loads, mesh, results), Target picker (records click points as `*Near`), Mesh quality histogram, Result legend,
  Margins table, **disposition dialog** (human gate: the reviewer's signature, gap 09). The overlay draws the midsurface (translucent), constraint and load glyphs, the skin mesh with scalars, and probes.
  The 2D view shows plane-stress parts. UI work goes through the `viewport-feature` skill and is verified with Playwright (VC-FEA-17).
- **CLI** (primary operator surface, AF-01). **No `fea` subcommand group**: registry commands run as `llull <command> …` and the ✱
  transports run like the existing exchange tools (`llull fea_mesh analysisId=… --progress --timeout 300`, `llull fea_import_results
  file=run.frd …`, `llull fea_export … --save out/x.bdf`), in-process for `--doc` and over REST (`POST /fea/<op>`) for
  `--app`/`--server`, mirroring `cli/exchange.ts`. Long transports stream progress and respect `--timeout` (AF-40). `llull guide` gains an
  FEA section: analysis unit systems, FoS defaults and their sources, the minimal static plan, the end-of-job `check_analysis` (AF-03).
- **render_view.** Proposed optional params `analysisId`, `field`, `loadCase`, `mode` so `llull render_view … --save vm.png` draws the
  skin mesh with scalars for multimodal agents (AF-22); the host supplies the field from the artifact store, nothing is stored. Built
  today as `render_fea_results` (SVG with a TS z-buffer raster); large headless renders may use the native GPU raster (§2.1, TR-FEA-92).
- **MCP.** The `analysis` toolset holds the registry commands plus the ✱ transports. Hosts without Gmsh/ccx return a
  how-to-enable message, as `import_step` does when Python is off. There is a prompt `fea_quick_check` (set up, mesh, solve, margins).
- **REST.** `POST /fea/mesh|solve|import|export` live in `server/src/feaRoutes.ts` and reuse the token and security model (KI6).

### 7.1 Stable error and check codes (AF-11)

Exit code 1 on every refusal; `data.code`, `data.ids` (or `data.path` for plan validation) and `data.remediation` are always set.
Check items from `check_analysis` use the same codes with a severity.

| Code | Severity | When | Offending ids / path | Remediation |
| ---- | -------- | ---- | -------------------- | ----------- |
| `FEA_TARGET_UNRESOLVED` | error | a `facesNear`/`edgesNear`/`pointsNear` point matches no face/edge/vertex (also after a parametric edit) | constraint/load id, point | move the point onto the intended face, then re-run |
| `FEA_TARGET_AMBIGUOUS` | error | two candidates within 1e-6 × model size | constraint/load id, candidate face indices | pick a point farther from the shared edge |
| `FEA_MATERIAL_MISSING` | error | an analysed part has no material | entity id | `assign_material` with a gap 08 record |
| `FEA_MATERIAL_NO_ELASTIC` | error | the record has no E or ν | material name, record id | `set_material_property property=E …` / `nu` |
| `FEA_MATERIAL_NO_ALLOWABLE` | error | margins need Ftu/Fty and none is given | material name | `set_material_property property=Ftu …` or pass `allowable={value,unit}` |
| `FEA_MATERIAL_UNVERIFIED` | warning (not suppressible) | a used property is gap 08 `unverified` | material, property ids | replace with a verified, sourced value (gap 08) |
| `FEA_PROPERTY_INVALID` | error | E ≤ 0, G ≤ 0, ν ∉ (−1, 0.5) | material, property | correct the value |
| `FEA_UNITS_MISMATCH` | error | explicit `unitSystem` disagrees with the document unit, or a `{value, unit}` has the wrong dimension | param path | drop `unitSystem` or fix the unit |
| `FEA_UNDERCONSTRAINED` | warning | < 6 independent restrained DOFs per connected part | part id | add constraints |
| `FEA_POINT_LOAD_SINGULAR` | warning | force on a single node / re-entrant sharp edge | load id | distribute over a face; singular zone excluded from MS |
| `FEA_KERNEL_OCC_REQUIRED` | error | midsurface, defeature or face targeting on Manifold | command | `--kernel occt` (desktop default) |
| `FEA_MIDSURFACE_COVERAGE` | error | shell export with coverage < 0.98 | entity id, unpaired face indices | fix geometry or use solid idealization |
| `FEA_TOOL_MISSING` | error | Gmsh or ccx not found | tool name | install hint (desktop bundle / `LLULL_CCX`) (AF-41) |
| `FEA_FACE_MAP_AMBIGUOUS` | error | llull face → Gmsh surface not unique | face indices | heal geometry and re-mesh |
| `FEA_MESH_INVERTED` | error | any element with scaled Jacobian ≤ 0 | element ids | refine, or change `order`/`optimize` |
| `FEA_MESH_ADEQUACY` | warning | < 2 elements through a thickness or span | part id | reduce `globalSize` or add a refinement |
| `FEA_MESH_STALE` | error | mesh `inputHash` ≠ current | analysis id | `fea_mesh` |
| `FEA_RESULTS_MISSING` | error | no results, or artifact absent on this machine | analysis id | `fea_solve` |
| `FEA_RESULTS_STALE` | error | results `inputHash` ≠ current | analysis id, changed inputs | `fea_mesh` then `fea_solve` |
| `FEA_ARTIFACT_NOT_FOUND` | error | `record_*` hash not in the store | hash | run the transport; never hand-write summaries |
| `FEA_SUMMARY_MISMATCH` | error | `record_*` summary ≠ recomputed | hash, differing fields | same |
| `FEA_FOREIGN_RESULTS` | warning | imported results do not match the mesh | analysis id | review-only; not used for margins |
| `FEA_SOLVER_FAILED` | error | ccx exit ≠ 0 or `*ERROR` | `data.logTail` | read the log tail; usually constraints or material |
| `FEA_SOLVER_TIMEOUT` | error | `--timeout` / `timeoutS` reached | analysis id | coarser mesh or longer timeout |
| `FEA_FACTOR_INVALID` | error | a factor < 1, or an extra factor without justification | param path | correct the factor |
| `FEA_MS_NEGATIVE` | fail | a margin row with MS < 0 | row id, part, load case | redesign; only a qualified reviewer can disposition it |
| `FEA_MS_MARGINAL` | warning | 0 ≤ MS < `marginalBand` | row id | same |
| `FEA_MARGINAL_BAND_UNSET` | warning | `marginalBand` not given | analysis id | ask the owner / company rule for a band |
| `FEA_DISPOSITION_PENDING` | warning | FAIL/MARGINAL row without a human disposition | row ids | qualified reviewer: `dispose_margin` in the desktop app |
| `FEA_HUMAN_GATE` | error | `dispose_margin` by an agent or without a valid human signature | row id | hand over to the qualified reviewer |

### 7.2 Agent-first compliance (`../AGENT_FIRST.md`)

| AF | Where satisfied |
| -- | --------------- |
| AF-01 | set-up and query capabilities are registry commands (§4); transports run like exchange tools, no CLI subcommand group (§7) |
| AF-02, AF-03 | command descriptions state units and the next command; `llull guide` FEA section (§7) |
| AF-04 | FR-FEA-37; analysis unit system fixed at `create_analysis` (TR-FEA-07); `{value, unit}` for explicit allowables |
| AF-05 | all set-up in one plan (`validation/plans/*`), `llull run --validate` |
| AF-10 | `fea_report`, `compute_margins` (§5.8 shape), `check_analysis`: unit-suffixed fields |
| AF-11 | §7.1 codes (FR-FEA-36; VC-FEA-65) |
| AF-12 | decks and meshes only via `fea_export --save` / the artifact store |
| AF-13 | TR-FEA-30/40 determinism (VC-FEA-06, 51) |
| AF-20 | `check_analysis` (FR-FEA-35) |
| AF-21 | FR-FEA-17 numbers first; overlays FR-FEA-17b SHOULD |
| AF-22 | `render_view` with `analysisId` / `field` (§7) |
| AF-23 | validation README "CLI harness" |
| AF-30 | Verdict ranges, FoS rule, adequacy rule held as data with sources (§5.5, §5.8) |
| AF-31 | FR-FEA-31; named factors in §5.8 (VC-FEA-60) |
| AF-32 | FR-FEA-34 (VC-FEA-64) |
| AF-33 | FR-FEA-32 (VC-FEA-61) |
| AF-34 | FR-FEA-33, `dispose_margin`, TR-FEA-91 (VC-FEA-62, 63) |
| AF-35 | `provenance` in every margin row (§5.8); method and inputs in `analytic_check` |
| AF-36 | `compute_margins.summary`: done, passed, needs a human |
| AF-40 | `fea_mesh` / `fea_solve` progress, `--timeout`, content-hash cache (TR-FEA-05) |
| AF-41 | bundled ccx/gmsh; `FEA_TOOL_MISSING` |
| AF-42 | `--dry-run` on every set-up command (pure) |

## 8. Performance & robustness budgets

| Budget | Target |
| ------ | ------ |
| Mesh of a 20k-node tet10 bracket | ≤ 15 s (Gmsh, 1 thread) |
| Solve (CalculiX, static, 50k nodes, SPOOLES/PARDISO) | ≤ 30 s. TBD: measure (VC-FEA-53) |
| FRD parse | ≥ 50 MB/s in TS, streaming line reader, no full-file string when > 64 MB |
| Skin colour update when the field changes | ≤ 50 ms for 200k skin triangles (pre-computed per field, GPU attribute swap; viewport WebGL, unchanged by RS1) |
| Headless field-plot raster (`render_fea_results --save`) | TS raster below the crossover; native `llull-compute raster` above it (§2.1). Crossover and native time: TBD — measure on the reference machine |
| Artifact size | gzip JSON. Cap 512 MB per artifact, refuse above with advice to coarsen |
| Process safety | Every child is tracked and killed on shutdown. Timeouts on mesh (120 s default, configurable) and solve (600 s). No shell interpolation of paths |
| Determinism | `General.NumThreads = 1` for meshing. The hash covers canonical sorted sets |

## 9. Test strategy (VC mapping)

| Layer | Tests | VC |
| ----- | ----- | -- |
| Unit (`tests/unit/cae/*`) | every command happy, failure and `is pure`. Units, von Mises, principal stresses, MS, Verdict port, FRD/DAT readers on pinned fixtures (download by hash), INP/BDF writers on a tiny hand-built mesh (golden text) | 01, 02, 07, 08, 09, 16, 20, 21, 22 |
| Contract | `toToolSchemas()` snapshot gains the `analysis` toolset. Plugin `validate`/`restore`. Toolset membership invariant | 01 |
| Golden (`tests/golden/plans.ts`) | the five draft plans in `validation/plans/` once their commands exist. Id-normalised snapshots plus replay equality | 01, 05, 50 |
| Kernel (OCC, `server/tests`) | midsurface fast path and face-pairing, defeature, face centroids, face map against Gmsh | 03, 04 |
| Integration (`server/tests`, needs Python + ccx; skipped otherwise with a reason) | mesh determinism, solve loop, analytic benchmarks, CalculiX reference decks, BDF with pyNastran, VTU with meshio | 06, 10–15, 19, 40–44, 51 |
| Quality gate (`npm run quality:fea`) | NAFEMS LE1/LE10, analytic table, report markdown | 30, 31 |
| E2E (Playwright) | result overlay screenshot, margins table | 17 |
| Desktop (`npm --prefix desktop test`) | bundled `ccx --version`, `python -c "import gmsh"`, licence files | 52 |
| Agent-first (`tests/unit/cae/agentFirst.test.ts` + CLI harness) | named factors, `reviewRequired`, human gate, unverified propagation, error codes, driven by `fea_analytic_expected.json` | 28, 60–65 |
| Native (`npm run native:check` + `server/tests`, skipped with a logged reason without the binary or a GPU adapter; the CPU twin always runs) | `llull-raster` on the VC-FEA-17 plot and a large plot: native PNG vs TS PNG | 29 |
| Production gate | LE10 timing scenario; the agent driver runs the whole CLI scenario unattended except the human gate (AF-23) | 53 |

Coverage 90/85/90/90 extends to `packages/domain-cae/src/**` (CLAUDE.md non-negotiable 3).

## 10. Delivery plan

| M | Content | Depends on | Effort |
| - | ------- | ---------- | ------ |
| M1 | Data model (`CadDocument.analysis`, `FeaMaterialView` over gap 08 records), plugin skeleton, commands create/idealize(solid, plane_stress)/constraint/load/mesh controls/factors, `facesNear`, face centroid/normal in OCC topology, staleness hashes, unit tests | 01 KRN (exact faces on desktop) | 3 w |
| M2 | Bridge op `mesh` (Gmsh), face map, artifact store, `record_fe_mesh`, Verdict port + quality gate, CLI `fea mesh/quality`, desktop wheel staging | M1 | 3 w |
| M3 | INP writer, bundled `ccx` (`desktop/scripts/prepare-ccx.mjs`), `fea_solve`, FRD/DAT readers, `record_fea_results`, result overlay, probes, margins, analytic checks, VC-10…14, 20–22, 30, 31, 40–44 | M2 | 4 w |
| M4 | MCP toolset and prompt, REST routes, golden plans, quality:fea, production-gate scenario, licence packaging | M3 | 2 w |
| M5 (V1) | BDF writer + pyNastran check, OP2 import, VTU export, RBE3/distributing coupling, Netgen option | M4 | 3 w |
| M6 (V1) | Shell idealization: midsurface (fast path, then face-pairing), defeaturing, shell decks (S8/CQUAD8), shell result mapping | M4, 07 FTR (sheet metal recipes help the fast path) | 4 w |
| M7 (V1, RS-5) | `llull-compute raster` field-plot job (crate `llull-raster`, shared with plant 09 VIS), CLI selection + provenance, VC-FEA-29 | M3; RS-0 (`solver/` workspace); RS-5 renderer | 1 w (the renderer itself is costed in RS-5) |
| V2 | beams (CBAR/B32), composites (06 CMP → PCOMP / `*SHELL SECTION, COMPOSITE`), tied contact, user Nastran/MYSTRAN runner | 06 CMP, 08 MAT | — |

**Status (2026-10-17):** the static-solid part of M1–M3 is built (§13) as the minimal slice for PHY-03 / PHY-04: data model, plugin `cae`, Gmsh mesh op, artifact store, INP writer, ccx solve, FRD/DAT readers, record commands, margins. The remaining items (face map, M4 prompt + golden plans, M5, M6) form **FEA-REST** (part 1, 2026-10-19: modal / buckling hardening, `dispose_margin`, `analytic_check`, moment loads, consistent forces and a Verdict subset (the metrics listed in §13), see §13), in step **AERO-5** of the aerospace story (`../README.md`). The face map needs the 01 `FaceQueryPort` (AERO-2). The `FeaMaterialView` over 08 records needs 08 M2 (AERO-3); until then the decks read PHY-01 / PHY-02 models on `Material`.

Cross-gap: **08 MAT** owns the material record (E, ν, G, density, allowables with basis and provenance); FEA M1 depends on 08 M1–M2. **01 KRN** supplies stable
exact faces and STEP. **06 CMP** supplies laminates. **09 PLM** stamps results with the revision.

## 11. Open questions / decisions needed

1. **GPL in the desktop installer** (Gmsh GPL-2.0+ with exception [R10], CalculiX GPL-2.0 [R30]). Do we ship them bundled as separate
   programs with source archives, or download them on first use? This needs a legal decision. Netgen (LGPL-2.1) [R11] is the fallback mesher.
2. **CalculiX binaries per OS.** Do we build from source in CI (SPOOLES/ARPACK, optional PARDISO), or use third-party builds? Provenance
   and reproducibility for tool qualification have to be settled either way.
3. **Mesh in the document versus the cache.** TR-FEA-05 proposes the cache, with a `.llullz` bundle for sharing. Live sync (L6) does not carry artifacts, so
   collaborators re-mesh. Is that acceptable?
4. **`BRepAlgoAPI_Defeaturing` availability**: on desktop, settled by RS1 (01 KRN M2: native OCCT 7.9 in `llull-kernel`, full toolkit
   set). In the browser-only path (opencascade.js 1.1.1) it may be missing: delegate to Gmsh `occ.defeature` there.
5. Should **web/cloud** offer meshing at all (server-side Gmsh), or is FEA desktop-only? The proposal: MCP transports are available only where configured.
6. **Nastran conformance**: get access to an official MSC or Simcenter QRG, or a MYSTRAN install (licence not verified), to check BDF beyond pyNastran.
7. **Shell stress output**: decide how top and bottom fibre stresses are extracted from CalculiX shell expansion for MS.
8. **Singularity policy** for MS: what the default exclusion radius is, and whether it is user-overridable with a mandatory note.
9. **Search-verified sources** (eCFR, NASA-STD-5001B, the NAFEMS vendor manuals) must be re-checked by a human with direct page access
   before the MS report wording is frozen (sources.md marks each one).
10. **Verdict warpage range**: the manual's acceptable range [0.3, 1] contradicts the metric (flat quad = 0). Decide a llull threshold
   (with a cited source) or keep warpage informational only (current proposal, §5.5).

## 12. References

- [R1] 14 CFR §25.303 — eCFR — https://www.ecfr.gov/current/title-14/chapter-I/subchapter-C/part-25/subpart-C/subject-group-ECFR6dd5e5c4b86d1bc/section-25.303 (accessed 2026-10, search)
- [R2] 14 CFR §25.301, §25.305 — GPO — https://www.govinfo.gov/content/pkg/CFR-2010-title14-vol1/pdf/CFR-2010-title14-vol1-sec25-305.pdf (accessed 2026-10, search)
- [R3] NASA-STD-5001B (w/ Change 3) — NASA — https://standards.nasa.gov/sites/default/files/standards/NASA/B-w/CHANGE-3/3/2022-10-24-NASA-STD-5001B-w-Change-3-Approved.pdf (accessed 2026-10, search)
- [R10] Gmsh 4.15.2 wheel (gmsh.py API, LICENSE.txt, CHANGELOG.txt) — https://pypi.org/project/gmsh/4.15.2/ (accessed 2026-10)
- [R11] Netgen — https://github.com/NGSolve/netgen (accessed 2026-10)
- [R12] Verdict Library Reference Manual SAND2007-2853 — Sandia — https://github.com/sandialabs/verdict (accessed 2026-10)
- [R13] meshio — https://github.com/nschloe/meshio (accessed 2026-10)
- [R14] pyNastran (card docstrings) — https://github.com/SteveDoyle2/pyNastran (accessed 2026-10); [R14a] Altair CQUAD4 — https://help.altair.com/hwsolvers/os/topics/solvers/os/cquad4_bulk_r.htm (search)
- [R15] FreeCAD FEM (`importCcxFrdResults.py`, gmshtools, CalculiX tools) — https://github.com/FreeCAD/FreeCAD/tree/4a1904f8db57d4a31e44cdb1dd984d4c98447c10/src/Mod/Fem (accessed 2026-10)
- [R30] CalculiX source / manual / tests — https://github.com/Dhondtguido/CalculiX/tree/fd588701edd6a92fde06e99b1bdf01f3b0f80f2c (accessed 2026-10)
- [R43] FeenoX NAFEMS examples — https://github.com/seamplex/feenox/tree/3759eb2426a9e9a77ab8a9ce97db93071a389776/examples (accessed 2026-10)
- Other references (R4–R6, R20–R22, R31, R40–R45): see [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md) §11 and [`validation/sources.md`](validation/sources.md).
- [RS1] Native compute programme — [../../decisions/RS1-native-compute.md](../../decisions/RS1-native-compute.md) (owner decision 2026-10-18)
- L1 llull: `.claude/rules/architecture.md`, `docs/decisions/KI5-shape-kernel-boundary.md`, `docs/decisions/KI6-desktop-app-cli-first.md`, `packages/core/src/geometry/kernel.ts`, `server/src/pythonExchange.ts`.

## 13. Implementation status (2026-10-19)

**Built: a minimal slice**, driven by physics packs PHY-03 / PHY-04 (owner decision; design `docs/physics/FE_PIPELINE_DESIGN.md`).

| Item | Where |
| ---- | ----- |
| Analysis types, artifacts, ports (`feaArtifacts`, `humanSignature` on `ExecutionContext`) | `packages/core/src/model/analysis.ts`, `commands/types.ts` |
| Plugin `cae` (toolset `analysis`): `create_analysis` (static, heat_*, thermo_static), `delete_analysis`, `describe_analysis`, `set_part_idealization` (solid), constraints, loads (force, pressure, gravity), `set_mesh_controls` (tet 1/2), probes, `record_fe_mesh` / `record_fea_results` (§4.1 trust model), `fea_report`, `check_analysis` | `packages/domain-cae/src/commands/` |
| INP writer §5.6 (model block, mechanical cards, `*STATIC` per load case), FRD / DAT readers §5.7, summaries, staleness TR-FEA-06 | `packages/domain-cae/src/{decks,results,hash}/` |
| Transports `fea_mesh` (bridge op `mesh`, Gmsh 4.15.2), `fea_solve` (ccx), `fea_export`; content-addressed `FeArtifactStore` | `server/src/fea/`, `server/python/llull_mesh.py`, `packages/mcp/src/feaTools.ts` |

Verified end to end with real Gmsh + ccx 2.21 (axial bar σ = F/A within 1 %, pressure sign, load-case reset) and by the PHY-03 / PHY-04
benchmarks.

**Bonded multi-part meshes (V1, built 2026-10-17):** `set_mesh_controls { bonding: 'separate' | 'conformal' }` (default `separate`, stored as absent so existing mesh hashes are unchanged; `conformal` is part of the mesh input hash). `separate` meshes every analysed part in its own Gmsh model (no shared nodes; contact needs this). `conformal` puts all parts in ONE model and `occ.fragment`s them, so touching parts share their interface nodes and faces; ids stay global and contiguous, element blocks (and so ELSETs / materials) stay per entity, and a target still resolves against the faces of its own part. It needs exact STEP geometry (OCC kernel): any STL part is refused with `FEA_BONDING_UNSUPPORTED`; parts that overlap in volume (a fragment owned by two parts) are refused with `FEA_BONDING_OVERLAP` (subtract one from the other so that they only touch). Used by PHY-04 NAFEMS T1 (`docs/physics/04-thermo-mechanical/TECHNICAL_SPEC.md` §14). Tests: `tests/unit/cae/{setup,hash}.test.ts`, `server/tests/feaMeshBridge.test.ts` (shared interface nodes, refusals).

**Deviations:** targets are resolved by the mesher (closest Gmsh surface / node to the given points), not by the TR-FEA-32 face map,
because the 01 face-query port (`faceDetails`) does not exist; without STEP (Manifold) the mesher rebuilds the geometry from the
tessellation (`classifySurfaces` 40°), so faces are crease regions; `edgesNear` works with STEP only; `intersectPlane` is ignored.
Forces on edges / points are split equally over the target nodes (faces: area-consistent since 2026-10-19, see below). Probes use the nearest node
(temperature: element interpolation). Case lengths are in document units, loads in the case unit system. The FE tools run synchronously in the
server process (no ticket cancel yet).

**Not built (05 backlog):** beams, `*DISTRIBUTING COUPLING` for CalculiX, `.llullz` result bundling (shells, plane stress, midsurface, defeature,
composite shells and the UI panels are built in FEA-REST part 3; BDF, OP2, VTU, `set_result_view`, `fea_import_results`, `fea_result_field` and the face map in part 2, below). Modal, buckling,
`dispose_margin`, `analytic_check`, moment loads, area-consistent forces and a Verdict subset (the metrics listed under "Verdict quality" below) are built (FEA-REST part 1, below).

**FEA-REST part 1 (2026-10-19): modal, buckling, human gate, analytic checks, loads, quality.**

- **Modal** (`analysisType: 'modal'`; first built in the round-5 audit, hardened here). `create_analysis { modes (default 6, 1..100), frequencyRangeHz?: { min?, max? } }`;
  the deck writes `*FREQUENCY` with the data line `n` or `n, [min], [max]` (band in Hz = CalculiX cycles/time), the constraints (loads are ignored: warning
  `FEA_LOADS_IGNORED`) and `*NODE FILE U`. A modal case WITHOUT supports is written (free-free; `check_analysis` warns `FEA_UNDERCONSTRAINED`, the first six modes are
  rigid-body). Not run against a real `ccx` (none is installed on the dev machine): a solver refusal of a singular free model would surface as `FEA_SOLVER_FAILED`.
  Readers: the `.dat` eigenvalue table gives `frequenciesHz`; the participation-factor, effective-modal-mass and total-effective-mass tables
  (`P A R T I C I P A T I O N  F A C T O R S`, `E F F E C T I V E  M O D A L  M A S S`, `T O T A L  E F F E C T I V E  M A S S`, translations x / y / z) are parsed
  tolerantly into `dat.tables`; the layout (six components per row, mode number first, a `TOTAL` row after the effective masses that is not a mode) is confirmed
  against a real ccx 2.21 run (SOLVER-VERIFY below; fixture `tests/unit/cae/fixtures/ccx221_modal_cantilever.dat`) (a heading without rows is dropped). The mode shapes are the `.frd` result sets (`render_fea_results mode=n`). `fea_report` returns `data.eigen`
  `{ kind: 'modal', modes [{ mode, frequencyHz, participation?, effectiveMass?, effectiveMassFraction? }], totalEffectiveMass, cumulativeMassFraction, massUnit, rigidBodyModes }`,
  recomputed from the verified artifact (it is not part of the trusted summary, so records made earlier stay trusted); the `describe_analysis` and `fea_report` summaries list the
  frequencies. Rigid-body modes = frequency <= max(1e-3 Hz, 1e-4 x the highest extracted frequency) (a llull heuristic).
- **Buckling** (`analysisType: 'buckling'`). One `*BUCKLE` step with the constraints and the loads of the FIRST load case as the reference (deviation from "after a static
  preload": no `*STATIC` pre-stress step is written; a second load case is ignored and flagged `FEA_BUCKLING_LOAD_CASE_IGNORED`). Factors come from the `.dat`
  (`bucklingFactors`, multiples of the applied load); `data.eigen { kind: 'buckling', factors, criticalFactor (smallest factor above 1e-3), criticalMode, negativeFactors,
  nearZeroFactors }`. Guards in `check_analysis`: `FEA_NO_CONSTRAINTS` / `FEA_NO_LOADS`, `FEA_BUCKLING_NEAR_ZERO` and `FEA_BUCKLING_NO_POSITIVE` (errors),
  `FEA_BUCKLING_NEGATIVE_FACTOR` and `FEA_BUCKLING_BELOW_APPLIED` (factor < 1: the applied load exceeds the linear buckling load; warnings). Linear buckling is an upper bound
  (no imperfections): the summary says so and `reviewRequired` is always true.
- **`check_analysis` additions.** `FEA_UNDERCONSTRAINED` from the mesh artifact: the restrained (node, dof) rows of every support are projected on the six rigid-body motions of each part
  (rank by Gram-Schmidt: a fixed face 6, a fixed point 3, a fixed edge 5; parts that share mesh nodes under conformal bonding form one group); `FEA_MESH_ADEQUACY` when fewer than 2 element edges fit across the thinnest bounding-box side of a
  part (bounding box over the mean tet edge: a heuristic, VC-FEA-09); margin items for a solved static / thermo_static case with allowables: `FEA_MS_NEGATIVE` (error, also after
  a disposition: a FAIL never becomes a pass), `FEA_MARGINAL_BAND_UNSET` (warning, VC-FEA-62) and `FEA_DISPOSITION_PENDING` (the check runs the default query without a band, so
  `FEA_MS_MARGINAL` stays a code of `compute_margins` rows). Because of the last two a solved
  case with allowables reads `warn` at best until a band is stated.
- **`dispose_margin`** (registry command, human gate, `margins/disposeMargin.ts`). `{ analysisId, rowId, decision: accepted | rejected | redesign, justification, signature?, + the
  compute_margins query (criterion, allowable, groupBy, loadCases, marginalBand) }`: the query reproduces the table the reviewer saw, because `rN` depends on it. Every
  row carries a stable `rowKey` = `loadCase|part|region|check|criterion`; the disposition is stored under it in `AnalysisCase.dispositions` with decision,
  justification, `resultsHash`, signer, signatureId and the verified signature. The signature is verified through `ctx.humanSignature` over
  sha256 of the canonical JSON of `{ kind: 'margin_disposition', analysisId, rowKey, status, ms, decision, justification, resultsHash }`. No port, no signature or a signature
  that does not verify gives `FEA_HUMAN_GATE` with the document unchanged (VC-FEA-63: an agent always lands there); other refusals: `FEA_ANALYSIS_NOT_FOUND`, `FEA_PARAM_INVALID` (empty justification),
  `FEA_RESULTS_STALE` / `FEA_RESULTS_MISSING`, `FEA_MARGIN_ROW_NOT_FOUND`, `FEA_MARGIN_PARAM_INVALID` (a PASS row). A stored disposition is a claim: `compute_margins` honours it only
  while it binds to the current results hash and its signature still verifies over the row as computed now; otherwise the row stays `pending_human` with a
  `dispositionNote`. It never changes `status`: the row reads `statusLabel: 'FAIL (accepted)'`, `disposition: accepted` and carries `dispositionRecord`. Case dispositions are not part of the input hash.
- **`analytic_check`** (registry query, pure, `analytic/`). `{ check, inputs, compare?: { quantity, value, toleranceRel? } }` with checks `cantilever` (tip deflection EB and
  Timoshenko, root moment and stress, stiffness; VC-FEA-10), `cantilever_frequency` (n-th clamped-free bending frequency, weak and strong axis; VC-FEA-11), `ss_beam` (central point
  and / or uniform load), `euler_column` (`K` stated, no default; VC-FEA-12), `ss_plate_buckling` (k(a/b), half waves, sigma_cr; VC-FEA-13), `kirsch_kt` (Kt = 3, transverse profile and
  hoop stress; VC-FEA-14). Rectangular sections, N-mm-t-s units in the key suffix; every result has its unit and formula, and the data lists assumptions and sources (AF-35);
  `compare` returns the relative difference and, with a tolerance, `withinTolerance`. The values are asserted against `validation/fea_analytic_expected.json` in `tests/unit/cae/analyticCheck.test.ts`.
- **Moment loads.** `add_fea_load kind: 'moment'` (`vector` = [mx, my, mz] in force x length of the unit system, `target` a face, an edge or at least three points).
  Deviation from the spec (`*DISTRIBUTING COUPLING` / RBE3 with a reference node): the deck applies a statically equivalent couple of `*CLOAD` nodal forces
  `F_i = omega x d_i` (`decks/loadDistribution.ts`; zero resultant force, the exact moment about any point), because the CalculiX keyword syntax could not be checked against a
  real run here. `referencePoint` is not used (a pure couple has none); a moment about the line of collinear nodes, or on fewer than 2 nodes, is refused with `FEA_LOAD_INVALID`. The face is
  not constrained (no rigid coupling), so stresses near the patch differ from an RBE3 / rigid coupling within the St-Venant zone.
- **Area-consistent forces.** A `total` force on a target that has faces in the mesh artifact (`faceSets` of `L_<id>`) is split by face integration: a linear face gives each corner
  A / 3, a quadratic face its three mid-edge nodes A / 3 and the corners nothing (corner-triangle area for curved faces). Targets of edges or points (no faces) and `per_node` are unchanged.
- **Verdict quality** (`results/verdict.ts`, `results/meshQuality.ts`). Tet scaled Jacobian, tet aspect ratio (`Lmax / (2 sqrt(6) r_in)`), tet edge ratio (a llull screen, above 3), triangle minimum
  angle, quad aspect ratio, scaled Jacobian, skew and warpage on corner nodes, against the Verdict ranges of §5.5. Warpage is reported in the histogram only
  (open question 10) and never counts as outside. `inverted` counts tets and quads with SJ <= 0 and zero-area triangles (the export / solve gate). Checked against `validation/mesh_quality_reference.json`
  (VC-FEA-07). The solid-tet deck still refuses 2D element types; the 2D metrics are ready for the shell / plane-stress part. The quality summary stays a diagnostic outside the trust comparison.
- **Tests.** `tests/unit/cae/{verdict,eigenChecks,disposeMargin,analyticCheck,loadDistribution}.test.ts`, golden plans `fea_modal_cantilever` and `fea_buckling_column_moment`,
  `server/tests/feaEigen.test.ts` (real Gmsh + ccx, skipped without them; it now also cross-checks `data.eigen` and `analytic_check`). Not run on this machine (no `ccx` / `gmsh`): VC-FEA-11 / 12 / 41 / 42 against
  a real solver, the free-free modal deck, the participation-table layout and the `*FREQUENCY n, min, max` band.

**Review fixes (2026-10-17), documented behaviour changes:**

- **Trust model §4.1 completed on the read side.** A recorded summary in the document (also one that arrived through `load_document` or a
  live snapshot) is a *claim*. `fea_report`, `check_analysis`, `describe_analysis` and the thermal / thermo-mechanical read paths call
  `trustedRecord` (`domain-cae/src/shared/trust.ts`): the summary is recomputed from the artifact in `ctx.feaArtifacts` with the same
  summariser the record commands use. State `solved` / `meshed` only when it matches; a difference gives state **`untrusted`** with
  `FEA_SUMMARY_MISMATCH` (`data.problem`), no port / artifact absent / recorded without it gives **`missing`**. In both cases the mesh and
  results are `null` (numbers withheld) and the results of a `stale` case are not shown. `stateOf` (hash only) is used where no number is read.
- **Replay without artifacts (TR-FEA-05).** `record_fe_mesh` / `record_fea_results` keep the given summary flagged `verified: false` when the
  port is absent or the artifact is not in it (step recorded, document changed, state `missing`, never read by any query); with the artifact
  present every check of §4.1 still applies (mismatch, `FEA_INPUT_STALE`, `FEA_MESH_MISMATCH` refuse). A summary without a text `inputHash`
  is refused. The replay cache key includes whether a port is injected. The live-sync state hash ignores the flag, so a replica without the
  store converges with the server instead of requesting a snapshot after every FE command.
- **Input hash (TR-FEA-06).** Hashes `parts[entity] = { idealization, geometry, materialId }`, the physical part of each used material
  (density, property / material models, constitutive sets, default set - not name, colour, PBR, finish) and `documentUnit`: swapping the
  materials of two parts or `set_units` makes results stale; a recolour does not.
- **Deck text (§5.6).** Every free-text fragment written to the INP goes through `commentText` (control characters stripped, length capped);
  load case names must match `[A-Za-z0-9_]{1,40}` (`FEA_LOAD_INVALID`), cavity names `[A-Za-z0-9_]{1,3}` (`THM_CAVITY_INVALID`). `*MATERIAL`
  names are `M_<n>` by first appearance with the id in a `** material M_n = '<id>'` comment; element / node set names that coincide after
  sanitising are refused (`FEA_DECK_NAME_COLLISION`).
- **Limits.** `fea_solve` `timeoutS` is clamped to [1, 86400] (schema `minimum` / `maximum`); a `.frd` above 256 MiB is `FEA_RESULTS_TOO_LARGE`;
  non-finite result values are `FEA_SOLVER_FAILED` ("non-finite results"); the recorded results summary is built from the artifact read back
  from the store; `meshRequest` refuses an estimated element count above 2e6 (bbox volume / globalSize^3 x 6 per part, refinements ignored)
  with `FEA_MESH_TOO_LARGE`.

**`compute_margins` (2026-10-17, PHY-04 closure).** Read-only registry command of the plugin `cae` (toolset `analysis`, `packages/domain-cae/src/margins/`),
§5.8 shape. `{ analysisId, criterion?, allowable?, groupBy?, loadCases?, marginalBand? }` -> `data { analysisId, unitSystem, resultsHash, criterion, groupBy,
marginalBand, minMs, minMsRow, factors, rows, singularScreening, warnings, reviewRequired }`, field names carrying the stress / length unit (`appliedMPa`,
`allowableMPa`, `atMm`; `Pa` / `M`, `Psi` / `In` in the other unit systems).

- **Trust.** Numbers come from the results artifact re-verified by `trustedRecord` (§4.1), never from the document summary: stale -> `FEA_RESULTS_STALE`
  (also when the cause is an edited thermal source of a thermo_static case), no verified artifact -> `FEA_RESULTS_MISSING`, summary differs from its artifact
  -> `FEA_SUMMARY_MISMATCH`. Static and thermo_static cases only (`FEA_ANALYSIS_TYPE_UNSUPPORTED` otherwise).
- **Applied stress.** `von_mises` (default) or the largest magnitude of `s_xx` / `s_yy` / `s_zz` over the nodes of a group: `groupBy part` (all nodes of the part's
  elements) or `target` (the nodes of each constraint / load node set `C_` / `L_`, split by owning part). Nodal values are the solver's averages: the artifact
  carries no per-element stresses, so averaging is not restricted to one part where parts share nodes (one mesh per part shares none).
- **Allowables.** Omitted: Ftu and Fty from the PHY-01 property models of the part material, evaluated in MPa at the case reference temperature (thermo_static)
  or 20 degC; `'ftu'` / `'fty'` run one check; `{ value, unit, against? }` is explicit (against `ultimate` by default, always `unverified`). A model missing, ambiguous
  or outside its validity at that temperature -> `FEA_MATERIAL_NO_ALLOWABLE` with the PHY-01 code in the message. `Material` changes make the results stale (the input hash
  holds the property models), so strengths are defined before the solve.
- **Margins.** Limit load case: `MS_ult = Ftu / (applied x FoS_ult x prod(extra)) - 1` and `MS_yield = Fty / (applied x FoS_yield x prod(extra)) - 1`; ultimate load
  case: `MS_ult = Ftu / (applied x prod(extra)) - 1`, no yield check (`allowable 'fty'` on it -> `FEA_MARGIN_PARAM_INVALID`). Applied = 0 gives `ms: null`, PASS. The
  factors come from the case; each is listed with `source` and `defaulted` (a value equal to 1.5 / 1.0 is `defaulted: true`, source 14 CFR 25.303 / 25.305(a);
  anything else is `defaulted: false`, source `create_analysis factors`; extras keep their justification). thermo_static results are one limit load case named
  `loadCaseName`.
- **Status.** FAIL if MS < 0 (`FEA_MS_NEGATIVE`), MARGINAL only when `marginalBand` is given and MS < band (`FEA_MS_MARGINAL`; no default, warning
  `FEA_MARGINAL_BAND_UNSET` in `data.warnings`), else PASS. FAIL / MARGINAL rows are `disposition: pending_human` until `dispose_margin` records a verified human decision (the status never changes; every row has a stable `rowKey`); every row has
  `reviewRequired: true`; `unverified` = OR of the allowable's PHY-01 flags, the E / nu flags (and, for thermo_static, the CTE flags of `check_thermo_mechanical`).
- **Singular zones are not screened.** Every row has `singular: false` and `data.singularScreening` says so; peak stresses at point loads, supports and re-entrant
  corners must be judged by the reader (a node in a constraint set is visible with `groupBy target`).

**Native raster, TR-FEA-92 (2026-10-19).** `fieldRaster.ts` is split into `prepareRaster` (per face: supersampled screen points, depth, value,
light, normal, part), `rasterPixels` (z-buffer, edges, bands, resolve: the reference) and `finishRaster` (PNG, depth-tested visibility);
`fieldPlotSvg` into `fieldPlotLayout` + `finish`; the plot set-up of `render_fea_results` moved to `results/plotRequest.ts` (behaviour and schema
unchanged) so a host can draw the same plot. `llull-compute raster` (crate `solver/crates/llull-raster`): a CPU twin of `rasterPixels`
(bit-identical RGBA and float32 depth: `solver/crates/llull-raster/tests/reference.rs`, fixtures from `tests/unit/native/rasterReference.test.ts`)
and a wgpu path behind the cargo feature `gpu` (GPU z-buffer, CPU resolve). Transport `fea_render` (CLI on a local document, and through `POST /exchange` for `--app` / `--server` since 2026-10-19, same SVG remotely: `server/tests/nativeExchange.test.ts`; same params and data
as `render_fea_results` plus `raster: auto | ts | cpu | gpu` and `data.raster = { engine, deterministic, device?, reason?, elapsedMs }`;
`server/src/native/renderField.ts`); a missing binary or GPU falls back to the TS raster with the reason.

VC-FEA-29: the native CPU twin gives the identical SVG (same bytes) as the TS raster (`server/tests/nativeRender.test.ts`); the GPU path on
llvmpipe (software Vulkan, lavapipe) differs from the twin on 0.000–0.001 % of the pixels (rasterisation rule at triangle edges); without an
adapter the GPU tests skip with the logged reason. Measured raster stage (4 vCPU, a 16k-node block): TS 0.21 / 0.42–0.53 / 1.30–1.35 s vs native
CPU 0.06–0.08 / 0.22–0.42 / 0.52–0.55 s (incl. process start) at 480×320 / 960×640 / 2000×2000; `auto` goes native from 1e6 supersampled pixels.
The whole render is 2–4 s, dominated by the TS plot set-up (artifact trust, faces), which stays in TS.

**FEA-REST part 2 (2026-10-20): M5 interop, face map, result access.** None of this ran against Nastran, ParaView, ccx or Gmsh on the dev machine (none installed);
what is verified is stated per item.

- **Nastran BDF** (`decks/bdfWriter.ts`, `decks/bdf/{fields,model,loads}.ts`; `fea_export format=nastran_bdf`). Small-field fixed format (8-character fields, blank
  continuation markers). SOL 101 / 103 / 105 for static / modal / buckling. Cards: GRID, CTETRA (4 / 10 nodes), CTRIA3 / CQUAD4 / CTRIA6 / CQUAD8 (shell element types,
  PSHELL with a numeric thickness; the mesher produces tets only today), PSOLID, MAT1 (G left blank), SPC1, SPCD (enforced displacements, selected by `LOAD`), FORCE,
  PLOAD4 (CTETRA: `G1` = a corner of the face, `G4` = the corner not on it), GRAV, MOMENT, EIGRL (modes, `frequencyRangeHz` as V1 / V2). Buckling is a preload-free
  pair of subcases (LOAD, then METHOD + STATSUB 1); a case with `set_buckling_preload` is refused (`FEA_BDF_UNSUPPORTED`). Node and element ids are the mesh ids.
  Reals use at most 8 characters (`.3`, `7.85E-9`, `-9.81-12`); `data.warnings` `FEA_BDF_ROUNDED` when that rounds a value by more than 1e-6 (large-field `GRID*` is not
  written). Golden text in `tests/unit/cae/bdfWriter.test.ts`; the pyNastran `read_bdf(xref=True)` round trip is in the same file and **skips with a logged reason**
  when Python or pyNastran is absent (it was skipped here). PLOAD4 sign (positive = into the element) and the STRESS request (`CUBIC`) are from memory of the QRG, unchecked.
- **Moments with `referencePoint`.** `add_fea_load` / `update_fea_load` accept `referencePoint` for a moment. The BDF writes a reference GRID there (default: centroid of the
  target nodes), an RBE3 over the target nodes and a MOMENT on it. The CalculiX deck **keeps the part-1 nodal couple** and ignores the point: `*DISTRIBUTING COUPLING`
  could not be checked against a real ccx run (deferred, not replaced).
- **OP2 import** (`results/op2Reader.ts`, `results/op2Results.ts`; `fea_import_results format=op2|frd`). Pure TS reader of the pyNastran record / marker layout:
  `LAMA` eigenvalues, `OUG*` displacements / eigenvectors, `OES*` CTETRA stresses (element type 39, 109 words), single precision, either endianness; anything else
  (double precision, other element types, a broken marker) is a `warnings` entry, never a guess. Hand-built fixtures only (`tests/unit/cae/op2Fixture.ts`): **not verified against
  a real MSC / NX OP2**. The OP2 must belong to the current mesh (every mesh node has a displacement; grid ids above the mesh ids are the moment reference grids and are dropped),
  else `FEA_OP2_MESH_MISMATCH`; the result is recorded through `record_fea_results` (the §4.1 trust path), solver `nastran`. A foreign-mesh, review-only import is **not** built.
  `.frd` goes the same way (`FEA_RESULTS_MESH_MISMATCH`). The CLI reads a local file with `file=<path>`.
- **VTU** (`results/vtuWriter.ts`; `fea_export format=vtu [encoding=base64]`): UnstructuredGrid with points, cells (tets, quadratic tets, shells), `part` and `element_id`
  cell arrays and, when current verified results are recorded, `U_k`, `S_k`, `von_mises_k` per result set; ASCII or inline base64 binary (header and data encoded separately).
  Not opened in ParaView here.
- **Netgen mesher: deferred.** The bridge only knows Gmsh; `MeshControls.mesher` stays `gmsh`.
- **Face map (TR-FEA-32).** The server asks `kernel.faceQuery.faceDetails` for each STEP part's faces (area, centroid) and `faceQuery.distance` for the kernel face nearest to each
  `facesNear` point (`server/src/fea/faceRefs.ts`); the bridge request carries `parts[].faces` and `targets[].faceIndices`. `llull_mesh.py` matches faces to Gmsh surfaces by area and
  centroid (1e-6, `AMBIGUOUS_FACE_MAP` when two match), resolves such a target to the mapped surfaces and returns `faceMap` (stored in the mesh artifact, shown in `MeshSummary.faceMap`).
  Fallbacks, all to today's nearest-surface resolution: no face query (Manifold), a point farther than 1e-3 of the diagonal from every face, a face with no Gmsh match, conformal bonding
  (fragmentation splits faces), STL parts. The point resolution still runs first, so `FEA_TARGET_UNRESOLVED` / `FEA_TARGET_AMBIGUOUS` are unchanged. **The Python side could not be run or
  even compiled here (no Python, no Gmsh)**; the TS side is tested with a fake kernel and a fake bridge (`tests/unit/cae/faceMapRequest.test.ts`). `edgesNear` / `intersectPlane` unchanged.
- **Result access.** `set_result_view` (presentation data on the case, not in the input hash), `fea_result_field` (read-only registry query: a field at the extreme nodes, named nodes,
  nearest nodes of points or probes, with min / max / mean over the whole result set, from the verified artifact), and `set_buckling_preload` (a load case applied in a `*STATIC` step
  before `*BUCKLE`; the reference is the first other load case; measured with ccx 2.21: the factors multiply preload + reference, see SOLVER-VERIFY; the preload is in the input hash). Without a preload the deck is unchanged (one `*BUCKLE` step).
- **Other part-1 review follow-ups** (`fix(cae)` commit): six-component ccx mass tables with a warning for unreadable ones (layout still unconfirmed against a real run),
  `fractionOfExtractedSum` instead of "of the model mass", force weights only when every target node is a face node, a `-1 Hz` lower bound for supportless modal cases,
  `set_margin_band`, `inputHash` in the signed disposition payload, a bounding-box note on `FEA_MESH_ADEQUACY`, element-type guard in `meshQuality`.
- **Not done:** large-field BDF, `*DISTRIBUTING COUPLING`, Netgen, foreign-mesh review-only imports, double-precision OP2, OP2 shell / hex stresses, `.llullz` result bundling, UI panels (part 3).

**FEA-REST part 3 (2026-10-20): M6 shells, plane stress, composites, M4 leftovers, UI, part-2 review fixes.** No Gmsh, CalculiX, Nastran or Python on the dev
machine: every deck is proven by text tests, every reader by hand-built fixtures, and the Python side (`server/python/llull_shell.py`, the `llull_mesh.py`
changes) was **not run or even compiled**. Real-tool tests skip with a logged reason.

- **Shell idealization** (`set_part_idealization idealization=shell`, `shell/idealize.ts`). Optional `thickness`, `offset` mid | top | bottom, `maxThickness`,
  `angularTolDeg` (default 1), `midsurfaceMinCoverage` (default 0.98), `compositePartId` + `laminateSectionId`. The thickness is stored resolved (given, the laminate's,
  or the single wall thickness of the midsurface; several walls without an explicit thickness -> `FEA_MIDSURFACE_THICKNESS_VARIES`); a thick shell (t / span > 0.1)
  is a summary warning. Shell and plane-stress parts are for static, modal and buckling cases (`FEA_PART_INVALID` otherwise; the thermal / nonlinear decks stay tet-only).
- **Midsurface (TR-FEA-20, deviation).** Not a `ShapeRecipe` node evaluated by the kernel (core geometry is outside this plugin's write scope): `shell/midsurface.ts`
  computes planar mid faces (polygons with holes, document frame, normal = top of the wall) and the mesher builds OCC plane surfaces from them. Order: (1) **sheet-metal
  fast path** from `CadDocument.sheetMetal` (core data; the `sheetmetal` plugin is not imported): each flat's outline + cutouts on the mid plane (zBottom + T/2), each
  bend as faceted mid-radius strips of at most 15 degrees joining the two flats (an arc that misses its child flat -> `FEA_MIDSURFACE_FAILED`); forms (flanged holes,
  beads) are not on the midsurface (warning). (2) **box-plate fast path**: the mid rectangle across the single thinnest side (`FEA_MIDSURFACE_NOT_THIN`,
  `FEA_MIDSURFACE_NOT_A_PLATE`). (3) **face pairing** on the exact kernel (`faceQuery`): planar faces with reversed outward normals within angularTolDeg, depth
  0 < t <= maxThickness, overlapping projections (`faceContains` of projected samples), smallest gap first; the mid face is the SMALLER face's outline (boundary loops
  of `tessellateFace`) projected on the mid plane. Coverage = paired area / area of the faces that are not edge strips (area <= maxThickness x extent); below
  minCoverage -> `FEA_MIDSURFACE_COVERAGE` at set time and at `fea_mesh`. Not built: cylinder pairs (curved walls stay unpaired, warning), step 4 extension / sewing
  (warning: mid faces join only where their edges coincide, so the two mid faces of a face-paired L-bracket do NOT meet; the sheet-metal path has no such gap),
  `BRepAlgoAPI_Common` overlap regions. No kernel -> `FEA_KERNEL_OCC_REQUIRED`. `extract_midsurface` (read-only) previews it: `data { method, faces [{ source,
  thickness, normal, area, outer, holes }], thicknesses, coverage, unpairedFaces, warnings }`. The sheet-metal part and its rule are in the mesh input hash.
- **Plane stress** (`idealization=plane_stress`, `thickness`, `sourceFacesNear`): the faces near the points (boxes analytically, other solids through `faceQuery`) must
  lie in z = 0 with normal +-Z (CalculiX plane elements live in the global x-y plane; `FEA_PLANE_STRESS_NOT_XY`), meshed CPS3 / CPS6 / CPS4 / CPS8 oriented +Z,
  `*SOLID SECTION` with the thickness line; fixed / pinned write dofs 1-2. Pressure on a plane-stress part is refused (`FEA_LOAD_INVALID`: edge labels are not built;
  use a force). plane_strain is not in the 05 data model: not built.
- **Meshing (`llull_shell.py`, geometry kind `midsurface`).** All mid faces of a part are fragmented together (`occ.fragment`) so shared edges are conformal, then
  meshed in 2D: triangles (S3 / S6, CPS3 / CPS6) or, with `set_mesh_controls elementFamily=shell_quad`, all quadrilaterals by subdivision (S4 / S8, CPS4 / CPS8);
  every element is re-ordered so its corner normal follows the face normal. A `facesNear` point resolves to the nearest mid face, or to the nearest boundary curve
  when that curve is as near (a point on a side wall of the solid = the shell edge there); tolerance max(1e-3 x size, 0.75 t). Face targets carry a side label
  (1 = point on the +normal side, 2 = below) used for pressure. Conformal bonding with 2D parts -> `FEA_BONDING_UNSUPPORTED`; 2D and solid parts are meshed
  separately (no shell-solid coupling).
- **Decks.** INP: `*SHELL SECTION, ELSET, MATERIAL, OFFSET=0 | 0.5 | -0.5` + thickness; shells fixed = dofs 1-6, pinned 1-3, symmetry = the normal translation + the
  rotations about the two in-plane axes (the symmetry-plane test now ignores an axis the whole mesh is flat in), displacement rx / ry / rz allowed on shells (radians);
  pressure `*DLOAD elem, P, -+p` (label 1 -> -p, label 2 -> +p: ccx 2.21 moves a shell ALONG its normal under a positive P, **measured**, SOLVER-VERIFY; the first
  build wrote the opposite sign); forces on shell
  faces are split equally over the target nodes. An element type that does not fit the part idealization is refused (`FEA_PART_INVALID`). BDF: PSHELL (plain shells:
  offset mid only, else `FEA_BDF_UNSUPPORTED`), shell `PLOAD4 SID EID P` with P = -p for label 1 (Nastran: positive along the element normal, **unverified**),
  shell symmetry adds the rotations.
- **Composite shells** (06 CMP through core data only). `compositePartId` = a composite part laid up on the entity; its laminate is a stored `LaminateSection`
  (`laminateSectionId`, from `create_laminate_sections`, merged from feat/eng-depth: per-zone sections, angles from the part rosette) or the part's plies when all
  are whole-face (`FEA_COMPOSITE_ZONES_UNSUPPORTED` otherwise); core plies -> `FEA_COMPOSITE_CORE_UNSUPPORTED`. ONE ply frame is written per part, so the part's
  elements must be coplanar and consistently oriented (within 1 degree; a sheet-metal bend or an L-shaped face-paired part -> `FEA_COMPOSITE_NOT_PLANAR`, split it);
  plies are written bottom to top along that common element normal (reversed when the stacking direction, rosette normal x laminateSide, opposes it). The rosette
  0-degree axis is projected on the shell plane (normal to it -> `FEA_COMPOSITE_INVALID`). INP: per lamina `*MATERIAL` + `*ELASTIC, TYPE=ENGINEERING CONSTANTS`
  (transversely isotropic: E3 = E2, nu13 = nu12, G13 = G13 ?? G12, nu23 = E2 / (2 G23) - 1 with G23 REQUIRED: a defaulted G23 gives a negative nu23 for CFRP),
  per ply `*ORIENTATION` (projected rosette axis, normal x axis, `3, angle`), `*SHELL SECTION, COMPOSITE, OFFSET` with `t,, material, orientation` lines;
  S8 elements are written `S8R` (other types -> `FEA_COMPOSITE_ELEMENT`: use shell_quad, order 2). BDF: MAT8 per lamina, PCOMP (Z0 = -(1/2 + offset) t, SOUT YES),
  CORD2R 100 + pid (x = projected rosette axis, z = element normal) named as MCID on the part's elements. Lamina density is read as grams per cubic document unit and
  must lie in [50, 25 000] kg/m^3 (else `FEA_COMPOSITE_INVALID`: entered in another unit). None of the composite cards ran in ccx or Nastran. **Composite parts get
  ply-failure rows, not an isotropic von Mises row** (see "Ply-failure margins of composite shells (CMP-2, 2026-10-20)" below; they were refused with
  `FEA_COMPOSITE_MARGINS_UNSUPPORTED` before that).
- **Shell results (open question 7, decided).** CalculiX expands shells into volume elements and writes the .frd on the expanded nodes. `shell/shellResults.ts`
  reads the .frd node block and finds, for each 2D mesh node, the expanded nodes at x + (1/2 - offset) t n (top fibre) and x - (1/2 + offset) t n (bottom) within t / 4
  (n = averaged element normal): geometric, independent of the expansion numbering. Candidates are .frd node numbers that are NOT mesh nodes (never a solid node or a
  node of another part) and each is used once. The node gets the mean of both (midsurface displacement, membrane stress) and the fibre stresses in `STRESS_TOP` /
  `STRESS_BOT`; a node without its own pair (a kink, where ccx may join nodes into a knot) keeps STRESS written under its own number; with neither ->
  `FEA_SHELL_RESULTS_UNMAPPED`. `fea_solve` and `fea_import_results` (`.frd`) both map before any mesh check. The results summary takes the max von Mises over
  STRESS and both fibres. The deck keeps the default `*NODE FILE` (no OUTPUT=): the default is the expanded output (**measured** with ccx 2.21, SOLVER-VERIFY); the knot
  behaviour at kinks is still unverified (only flat parts were run). **Margins on shells:** for 2D-part nodes `compute_margins` takes the largest of STRESS, STRESS_TOP and STRESS_BOT per node
  (criterion evaluated on each; the row names the governing `fibre`), so bending is not averaged away.
- **Defeaturing** (`defeature_for_analysis { analysisId, entityId, maxFeatureSize?, facesNear?, clear? }`, `AnalysisCase.defeature`, in the mesh input hash). The
  kernel path (`BRepAlgoAPI_Defeaturing` as a recipe node) is not reachable through the kernel interface: Gmsh `occ.defeature` in the bridge on STEP parts removes
  cylinder / torus faces of radius <= maxFeatureSize (principal curvature at the parametric centre) and the faces nearest to `facesNear`; a failure is
  `FEA_DEFEATURE_FAILED` naming the faces; STL parts are refused; the face map is skipped for a defeatured part; `fea_mesh` reports `data.defeatured`. Chamfer strips
  are not detected. **Unverified** (no Gmsh here).
- **Singularity policy (open question 8, decided)** in `compute_margins` / `dispose_margin`: sources = nodes of force / moment loads and of SOLID-part supports whose
  target has no mesh face (points, edges). Supports of shell / plane-stress parts are never sources: a side-wall point resolves to the shell edge, and the clamped root
  is where the peak bending is (the first build excluded it: review finding, fixed). Default exclusion radius 2 x mesh globalSize (`data.singularScreening.radius`,
  named llull default, `defaulted: true`); override `singularityRadius` (document units, 0 = none) REQUIRES `singularityNote` (else `FEA_MARGIN_PARAM_INVALID`).
  Excluded nodes form separate rows (region `singular`, `singular: true`, rowKey + `|singular`) that never set minMs. They are not silent: `check_analysis` keeps
  FEA_MS_NEGATIVE / FEA_DISPOSITION_PENDING for regular rows and adds `FEA_MS_SINGULAR_FAIL` (warning) for failing singular rows, `FEA_MS_ALL_SINGULAR` (error) for a
  group whose every node is excluded (it has no margin), and `FEA_SINGULAR_EXCLUSION_LARGE` (warning) when more than 25 % of a part's nodes are excluded (also in
  `data.warnings`). Re-entrant edges are not screened (needs geometry): deferred. The default radius can still cover a small part entirely; it is then flagged, not
  hidden.
- **Part-3 review fixes (2026-10-20).** Besides the three items above: idealization values (shell thickness / offset / midsurface / laminate, plane-stress thickness
  and source points) and `defeature` are validated on load; sheet-metal bends use min(15-degree strips, arc length / mesh globalSize) strips, at least one (no
  slivers below the element size); the Analysis panel reads `singularScreening` as the object it is, no longer claims re-entrant corners are screened, and turns the
  min-MS chip to a warning when only a singular row fails.
- **M4 leftovers.** Golden plans `fea_buckling_preload_view` (preload, moment with referencePoint, result view) and `fea_static_margin_band_view`; golden text of the
  BDF and the VTU (with and without results) in `tests/golden/feaExports.test.ts`; `llull guide` section 11 "Structural analysis".
- **UI** (`src/ui/panels/analysis/*`, presentation only): state badges (not meshed, meshed, solved, stale, missing, untrusted, with their meaning), idealization per
  part, mesh line with element family and bonding, per-load-case peaks, the margins table of `compute_margins` (statusLabel such as "FAIL (accepted)", disposition,
  singular rows apart, min MS, review notice), field / load case / mode / deformation changes dispatched as `set_result_view`, `set_margin_band` and
  `delete_analysis` actions; the disposition stays a disabled affordance (no signing port). Component tests `tests/component/AnalysisRest.test.tsx` (no Playwright).
- **Part-2 review fixes.** `Math.max(...array)` replaced by loops (BDF ids, OP2). Preloaded `*BUCKLE`: the reference step writes preload + reference summed per node /
  dof, element / face and GRAV (a modifying `*CLOAD` / `*DLOAD` replaces the earlier value); measured with ccx 2.21: the factor multiplies the WHOLE *BUCKLE step load (preload + reference), see SOLVER-VERIFY.
  A supportless modal case writes a lower bound of -1 Hz; measured with ccx 2.21: accepted, six rigid-body modes at about 0 Hz then the free-free modes. Decks carry `llull inputHash <16 hex>`
  (INP `*HEADING`, BDF `SUBTITLE`); import refuses a different marker (`FEA_RESULTS_INPUT_MISMATCH`), a file without one is `binding: 'imported-unbound'` with
  `FEA_RESULTS_UNBOUND` (import and `check_analysis` warnings); measured: ccx 2.21 copies `*HEADING` into the .frd header (`1U` record), so a re-import of its own .frd binds; unverified: where Nastran puts SUBTITLE in the OP2.
  Plugin validation of `preloadLoadCase`, `marginalBand` and `view`. RBE3 needs >= 3 nodes that carry the moment (`FEA_LOAD_INVALID`). OP2: at most 1e6 records,
  text decoded only from records <= 128 bytes. The VTU export applies the deck export-control gate (`MAT_EXPORT_CONTROLLED`). The face map raises
  `AMBIGUOUS_FACE_MAP` only for a target that names the ambiguous face. Adding inputHash to the `dispose_margin` payload (part 2) makes dispositions signed before it
  fail verification on replay.
- **Tests.** `tests/unit/cae/{shellSetup,shellDeck,shellTransports,marginsSingularity,reviewFixesPart2}.test.ts`, `tests/golden/feaExports.test.ts`,
  `tests/component/AnalysisRest.test.tsx`. Not run anywhere: a real shell / plane-stress / composite solve, the shell pressure signs, the expansion mapping on a real
  .frd, Gmsh 2D meshing and defeaturing, PCOMP / MAT8 / CORD2R in Nastran.
- **Not done:** beams (V2), cylinder pairing and mid-face extension / sewing, composites on non-planar parts, shell-solid coupling, pressure on plane-stress edges, plane
  strain, chamfer detection, offsets of plain PSHELL in the BDF, sandwich cores, `*DISTRIBUTING COUPLING`, Netgen, large-field BDF, `.llullz` bundling.

**Ply-failure margins of composite shells (CMP-2, 2026-10-20).** `compute_margins` no longer leaves composite shells out. For a part whose idealization carries a
laminate (`packages/domain-cae/src/margins/plyMargins.ts`), per load case and node group it gives ONE ROW PER PLY (criterion `ply_failure`, rowKey
`<case>|<entity>|<region>|ultimate|ply_failure|<plyId>`), each with `reviewRequired: true`, `unverified` from the lamina basis, the standard disposition flow
(`pending_human` for FAIL / MARGINAL) and the singular split.
- **Recovery.** The laminate is read from core data (`laminateOf`, `CadDocument.composites`; no import of the composites plugin). The pure math moved to `@lib/laminate`
  (`clt.ts`, `failure.ts`, `provenance.ts`, new `recover.ts`; `@aero` and `@cae` both import it). From the global `STRESS_TOP` / `STRESS_BOT` of the shell nodes
  (components [xx, yy, zz, xy, yz, zx], analysis stress unit) the in-plane stress is rotated into the ply frame (rosette 0-degree axis projected on the planar shell,
  `compositePlane`), converted to MPa, and mapped to strains at z = +-h/2 through the Qbar of the top and bottom plies; strain is linear through the thickness
  (Kirchhoff-Love), so every ply stress at its two surfaces follows from CLT (`recoverPlyStresses`, verified to reproduce a CLT solution to round-off). Plies are
  taken bottom to top along the shell element normal (reversed when the laminate stacks the other way), as in the deck writers.
- **Margin.** R = the lower of the max-stress and Tsai-Wu strength ratios (both reported, plus `plyCriterion`, `failureMode`, the ply stresses, F12* with its default
  flag) over the group's nodes and the ply's two surfaces; MS = R / (FoS x extras) - 1 with the ULTIMATE factor of the case category (strengths are failure strengths:
  there is no yield check, and the `allowable` / `criterion` params do not apply to these rows). No stress in a ply gives `ms: null`.
- **Still refused.** A laminate whose lamina lacks any of Xt, Xc, Yt, Yc, S (no default exists), a non-planar shell, a rosette normal to the shell, a zoned laminate
  without a section (the deck refusals), or results without both fibre stresses leave the part out with `FEA_COMPOSITE_MARGINS_UNSUPPORTED` and the reason in the
  warning; the command refuses with the same code only when no other row exists.
- **Limits.** First-ply failure only, linear, in-plane stresses (no interlaminar / transverse-shear failure, no wrinkling or buckling), no hygrothermal state, no
  progressive failure. The section forces are not used; the fibre stresses are. Whether CalculiX writes the expanded composite shell stresses of the outer plies
  in the global frame for `*SHELL SECTION, COMPOSITE` is CONFIRMED with ccx 2.21 (SOLVER-VERIFY: [90/0/0/90] strip, top-fibre sigma_x / sigma_y in the global frame
  within 0.5 % / 1.2 % of CLT; the expansion is one layer of nodes per ply, so the outer-surface node carries the outer ply).
- **Tests.** `tests/unit/cae/plyMargins.test.ts` (+ `plyMarginsFixtures.ts`): recovery against CLT, rows against `strengthRatio` on the CLT truth, factors, FAIL
  / disposition, refusals and the skip reasons.

**SOLVER-VERIFY (2026-10-20): measured with Gmsh 4.15.2 (pip wheel) + CalculiX 2.21 (conda-forge `calculix 2.21 h27aae45_3`) + pyNastran 1.4.1 on Windows 11**
(install record `docs/decisions/SV1-solver-toolchain-windows.md`). Every FE suite in `server/tests/` that needs only Gmsh + ccx now runs (the native-kernel ones: see
that record). Findings, each with a test that runs when the tools are present:

| Item (was unverified) | Measured | Consequence |
| --- | --- | --- |
| `.dat` participation / effective-mass layout | six components per row (x, y, z, rx, ry, rz), mode number first; the effective-mass table ends with a `TOTAL` row; parsed as built | fixture `ccx221_modal_cantilever.dat`, `tests/unit/cae/eigenChecks.test.ts` |
| `TOTAL EFFECTIVE MASS` | it is the MODEL mass (rho V: 1.555e-4 t for a 200 x 10 x 10 steel bar), not the sum over the extracted modes | **defect fixed**: the per-mode share is `fractionOfModelMass` (was `fractionOfExtractedSum`), summary "of the model mass" |
| `*FREQUENCY n, -1` (supportless modal) | accepted; 6 rigid-body modes (<= 0.004 Hz), then the free-free bending pair at 1321.7 Hz (Euler-Bernoulli 1333 Hz, -0.8 %) | `server/tests/feaBucklingPreload.test.ts` |
| Cantilever modal / Euler column | f1 209.73 Hz (EB 209.5), P_cr factor 4.8025 x 1000 N (pi^2 E I / 4 L^2 = 4797.8 N) | as `feaEigen` (that suite also needs the native kernel) |
| Buckling preload + `*BUCKLE` | 2000 N preload + 1000 N reference: factor 1.6008 = P_cr / 3000 N. The factor scales the WHOLE `*BUCKLE` step load; the preceding `*STATIC` stress is not a base state (same with NLGEOM, and a reference-only `*BUCKLE` load gives 4.80, ignoring the preload) | **defect fixed (semantics)**: `data.eigen.factorsMultiply = preload_and_reference`, summary "x (preload + reference)", `set_buckling_preload` description; a constant preload is NOT expressible with ccx `*BUCKLE` |
| Shell expansion mapping | ccx writes the .frd on the expanded nodes only (none of the 2D ids); the geometric top / bottom mapping finds them for S8 and composite S8R; plate cantilever tip 3.503 mm between plate and beam bounds (beam 3.571), top fibre +, bottom -, membrane about 0 | `server/tests/feaShellSolve.test.ts` |
| Shell pressure sign | a positive `P` moves the shell ALONG its element normal | **defect fixed**: label 1 (load from the +normal side) writes -p, label 2 +p (`decks/mechanical.ts`) |
| `*HEADING` in the .frd | copied as the `1U` header record; `fea_import_results` of the solver's own .frd binds (no `FEA_RESULTS_UNBOUND`) | `feaShellSolve` |
| Composite S8R section | `*SHELL SECTION, COMPOSITE` with `*ELASTIC, TYPE=ENGINEERING CONSTANTS` and per-ply `*ORIENTATION` runs; [90/0/0/90] strip (E1 140, E2 10, G12 5 GPa, ply 0.25 mm), 1 N tip load, at x = 50: top sigma_x 5.6964 (CLT 5.694), sigma_y -0.2234 (CLT -0.226), u_z -2.3647 mm (CLT -2.371); stresses are in the GLOBAL frame (the 90-degree outer ply shows its transverse stress as sigma_x), one node layer per ply | the ply-failure margin assumption above holds |
| Thermal suites (PHY-03), restrained / coupled thermo-mechanical (PHY-04) | pass unchanged | `server/tests/feaThermal*.test.ts`, `feaThermomech*.test.ts` |
| pyNastran `read_bdf(xref=True)` round trip | passes (pyNastran 1.4.1) | `tests/unit/cae/bdfWriter.test.ts` |
| Harness / host on Windows | the child-process environment allowlist was case-sensitive, so ccx ran without `Path` (DLLs not found) and Python without `SystemRoot`; the FE suites ran a bare `python3` / `ccx` instead of the probed tools | **defects fixed** (`server/src/pythonExchange.ts`, `server/tests/feaTestSupport.ts`) |

With the native kernel (MinGW build, see the record): `feaEigen`, conformal bonding (`feaMeshBridge`, bimetal, NAFEMS T1) pass. Still not run here: Nastran itself
(PLOAD4 sign, PCOMP / MAT8 / CORD2R, OP2 from a real solver), ParaView on the VTU, defeaturing, and the face map (TR-FEA-32): its `faceQuery.distance` call
crashes the MinGW-built sidecar (`NATIVE_DIED`), so meshing fell back to the nearest-surface resolution; re-run on an MSVC or Linux kernel.
