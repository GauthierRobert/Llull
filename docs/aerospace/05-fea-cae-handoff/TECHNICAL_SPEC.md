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
| MCP toolsets | `core, 2d, 3d, measure, parametric, assembly, exchange, building, …` | `packages/mcp/src/toolsets.ts` | No `analysis` toolset |
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
              record_fe_mesh, record_fea_results, set_result_view, add_result_probe, compute_margins, …
   decks/:    inpWriter.ts, bdfWriter.ts   (pure: AnalysisModel + FeMesh → text)
   results/:  frdReader.ts, datReader.ts, derivedFields.ts (von Mises, principal), margins.ts
   checks/:   analytic.ts (beam, plate k, Kirsch)
        ▼ (public core API only, L10)
packages/core/src
   model/analysis.ts      AnalysisModel types (like model/building.ts, model/civil.ts)
   model/types.ts         Material.elastic?, Material.allowables?, CadDocument.analysis?
   geometry/shapeRecipe   + recipe ops 'midsurface', 'defeature' (kernel boundary stays a SHAPE, KI5)
   geometry/kernel.ts     ShapeFace gains centroid + normal (planar) for face matching / facesNear
   lib/meshQuality.ts     Verdict metric port (pure)
   lib/vonMises.ts        tensor helpers (pure)
packages/kernel-occt/src  occtMidsurface.ts, occtDefeature.ts (KernelOps), face centroid/normal in occtTopology.ts
```

**Laws respected:**

- **L1.** Every document change is a command. Meshing and solving are *transports* outside the document, like
  `import_step` today. They feed results back through the pure commands `record_fe_mesh` and `record_fea_results` on the command
  bus (undo and broadcast).
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
| TR-FEA-04 | MUST | `Material` gains an optional `elastic` and an optional `allowables`. `create_material` gains the matching optional params. Old files load unchanged. |
| TR-FEA-05 | MUST | The FE mesh and results are stored in `FeArtifactStore` (server/desktop: `~/.llull/cache/fea/<sha256>.{mesh,res}.json.gz`, web: IndexedDB) under a `meshHash`/`resultsHash`. The document stores only summaries plus hashes. A missing artifact gives the state `missing` and asks for a re-mesh or re-solve, with no silent recompute. |
| TR-FEA-06 | MUST | Staleness is computed, never stored: `analysisInputHash = sha256(canonical JSON of {geometry recipeKeys of the analysed entities, idealization, materials used, constraints, loads, mesh controls})`. A mesh is valid iff its `inputHash` equals the current hash minus the loads and BCs. Results are valid iff their `inputHash` equals the full current hash. |
| TR-FEA-07 | MUST | Units: `unitSystem` is fixed at `create_analysis` from the document unit (mm → `N-mm-t-s`, m → `N-m-kg-s`, in → `lbf-in-slinch-s`). The writers convert materials stored in SI (Pa, kg/m³ from doc density) once, in `@cae/units.ts`. |
| TR-FEA-20 | SHOULD | Midsurface as a `ShapeRecipe` node `midsurface`, evaluated by OCC: a recipe fast path, then face-pairing (§5.2). Manifold returns null. |
| TR-FEA-21 | SHOULD | Defeature as a recipe node `defeature` (OCC `BRepAlgoAPI_Defeaturing`, or the Gmsh `occ.defeature` fallback) (§5.3). |
| TR-FEA-30 | MUST | Meshing op in `server/python/llull_bridge.py` (`op: "mesh"`), deterministic (`General.NumThreads = 1`). `meshHash` = sha256 of the canonical node and element arrays (§5.4). |
| TR-FEA-31 | MUST | `@lib/meshQuality.ts` is a pure port of the Verdict metrics, cross-checked with Gmsh `getElementQualities` (§5.5). |
| TR-FEA-32 | MUST | llull face to Gmsh surface mapping by area and centroid. Ambiguity is an error (§5.1). |
| TR-FEA-40 | MUST | `@cae/decks/inpWriter.ts`: pure and deterministic. Output is byte-identical for identical inputs (§5.6). |
| TR-FEA-41 | MUST (V1) | `@cae/decks/bdfWriter.ts`: small-field fixed format, verified by pyNastran `read_bdf(xref=True)` (§5.6). |
| TR-FEA-50 | MUST | `@cae/results/{frdReader,datReader}.ts`: streaming, fixed-column parse (§5.7). |
| TR-FEA-60 | MUST | `@cae/results/margins.ts` implements §5.8. There is no averaging across parts, and singular zones are reported separately. |
| TR-FEA-70 | MUST | `server/src/feaSolve.ts` spawns `ccx` with `trackChild`, a timeout, cancel, and log capture (§5.9). |
| TR-FEA-80 | SHOULD | Performance budgets in §8 are enforced by the production-gate scenario VC-FEA-53. |

## 3. Data model

```ts
// packages/core/src/model/types.ts (additions)
export interface ElasticProperties {
  /** Young's modulus, Pa (SI canonical; writers convert). @invariant > 0 */
  readonly youngsModulusPa: number;
  /** @invariant -1 < poissonRatio < 0.5 */
  readonly poissonRatio: number;
  /** Shear modulus, Pa; absent = E / (2 (1 + nu)) (isotropic). */
  readonly shearModulusPa?: number;
}
export interface MaterialAllowables {
  readonly ftuPa?: number; readonly ftyPa?: number; readonly fsuPa?: number; readonly fcyPa?: number;
  /** e.g. 'A' | 'B' | 'S' | 'typical' | 'user' — free label, shown in MS reports. */
  readonly basis: string;
  /** Provenance text (gap 08 MAT library id or user note); required for MS reports. */
  readonly source: string;
}
export interface Material { /* existing fields */ elastic?: ElasticProperties; allowables?: MaterialAllowables }
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
| `create_material` (extend) | mutating, core | `+ elastic?: { youngsModulusPa, poissonRatio, shearModulusPa? }`, `+ allowables?: { ftuPa?, ftyPa?, fsuPa?, fcyPa?, basis, source }` | @affects materials · @invariant E > 0, −1 < ν < 0.5, allowables > 0 · @failure invalid → rejected, doc unchanged |
| `create_analysis` | mutating | `{ name, analysisType, solver?='calculix', unitSystem?, modes?=10, factors?: { ultimate?=1.5, yield?=1.0, extra? } }` | @affects analysis.cases · @invariant unitSystem matches doc units unless explicit · @failure modes ∉ [1, 200] |
| `delete_analysis` | mutating | `{ analysisId }` | @affects analysis |
| `set_part_idealization` | mutating | `{ analysisId, entityId, idealization: 'solid'\|'plane_stress'\|'shell', thickness?, sourceFacesNear?, offset?, midsurface? }` | @affects case.parts · @failure non-3D entity, plane_stress source face not planar, shell on Manifold |
| `extract_midsurface` | query (requiresKernel) | `{ entityId, maxThickness, angularTolDeg?=1 }` → `data { faces, coverage, unpairedFaces[], thicknesses[] }` | preview for UI/agents. The geometry is derived when idealization = shell |
| `defeature_for_analysis` | mutating (requiresKernel) | `{ analysisId, entityId, maxFeatureSize?, facesNear? }` | @affects case.parts[e].defeature (recipe node) · @invariant design entity untouched · @failure OCC Defeaturing refused → summary names the faces |
| `add_fea_constraint` / `update_fea_constraint` / `delete_fea_constraint` | mutating | `{ analysisId, name, kind, dofs?, target }` | @affects case.constraints · @failure target unresolved / ambiguous |
| `add_fea_load` / `update_fea_load` / `delete_fea_load` | mutating | `{ analysisId, name, kind, loadCase, category, target?, vector?, magnitude?, distribution?, referencePoint? }` | @failure vector missing for force/gravity, magnitude missing for pressure |
| `set_analysis_factors` | mutating | `{ analysisId, ultimate?, yield?, extra? }` | @invariant every factor ≥ 1, extra needs a justification |
| `set_mesh_controls` | mutating | `{ analysisId, mesher?, elementFamily, order, globalSize, minSize?, refinements?, optimize? }` | @invariant globalSize > 0, refinement size ≤ globalSize |
| `record_fe_mesh` | mutating (bus only) | `{ analysisId, summary: MeshSummary }` | @affects case.meshSummary, clears results · @failure inputHash ≠ current (stale mesh) |
| `record_fea_results` | mutating (bus only) | `{ analysisId, summary: ResultsSummary }` | @failure no mesh, or meshHash mismatch |
| `set_result_view` | mutating (presentation, like `set_camera`) | `{ analysisId, field, loadCase?, mode?, deformationScale? }` | — |
| `add_result_probe` / `delete_result_probe` | mutating | `{ analysisId, name, point, quantity }` | — |
| `fea_report` | query | `{ analysisId }` → `data { state: 'unmeshed'\|'meshed'\|'solved'\|'stale'\|'missing', mesh, quality, results, probes }` | read-only |
| `compute_margins` | query | `{ analysisId, criterion?='von_mises', allowable?: 'ftu'\|'fty'\|number, groupBy?: 'part'\|'target', loadCases? }` → `data { rows[], minMS }` | @failure stale results, material without allowables (unless a number is given) |
| `analytic_check` | query | `{ check: 'cantilever'\|'ss_beam'\|'ss_plate_buckling'\|'kirsch_kt', inputs }` → value + formula | pure. Matches `generate_fea_analytic.py` |
| `export_solver_deck` | query (exports) | `{ analysisId, format: 'calculix_inp'\|'nastran_bdf', fileName? }` → `data { text \| path, sha256 }` | ✱ needs the mesh artifact, so in practice it is the `fea_export` transport (§7) |
| ✱ `fea_mesh` | transport | `{ analysisId }` | runs the Gmsh op, stores the artifact, dispatches `record_fe_mesh` |
| ✱ `fea_solve` | transport | `{ analysisId, timeoutS?=600, threads? }` | writes the INP, runs `ccx`, parses FRD/DAT, stores the artifact, dispatches `record_fea_results` |
| ✱ `fea_import_results` | transport | `{ analysisId, path, format: 'frd'\|'op2' }` | external results. They must match `meshHash`, or they are imported as a review-only `foreign` mesh |
| ✱ `fea_export` | transport | `{ analysisId, format: 'calculix_inp'\|'nastran_bdf'\|'vtu', path }` | pure writers in `@cae/decks` plus a file write |
| ✱ `fea_result_field` | transport (read) | `{ analysisId, field, loadCase?, mode? }` → per-vertex scalars of the skin mesh | for UI/MCP rendering. Nothing is stored |

## 5. Kernel / algorithms

### 5.1 Face data and targeting (TR-FEA-03, TR-FEA-32)

- `ShapeFace` gains `centroid: Vec3` and `normal?: Vec3` (planar faces only) from `BRepGProp::SurfaceProperties`. OCC already uses
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
[30°, 60°]. Outside the range raises a warning. **Inverted** (SJ ≤ 0 or minDetJac ≤ 0) **blocks** export and solve.
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

- **UI** (`src/ui/panels/analysis/*`, a viewport branch `src/ui/viewport/3d/AnalysisOverlay.tsx`). Panels: Analysis tree (cases,
  parts, constraints, loads, mesh, results), Target picker (records click points as `*Near`), Mesh quality histogram, Result legend,
  Margins table. The overlay draws the midsurface (translucent), constraint and load glyphs, the skin mesh with scalars, and probes.
  The 2D view shows plane-stress parts. UI work goes through the `viewport-feature` skill and is verified with Playwright (VC-FEA-17).
- **CLI** (`server/src/cli`). A new `fea` subcommand group (`mesh | quality | solve | margins | export | import | report`) is a thin client
  of the transports, in-process for `--doc` and over REST (`POST /fea/<op>`) for `--app`/`--server`, mirroring `cli/exchange.ts`.
  Output is compact JSON with `--json`.
- **MCP.** The `analysis` toolset holds the registry commands plus the ✱ transports. Hosts without Gmsh/ccx return a
  how-to-enable message, as `import_step` does when Python is off. There is a prompt `fea_quick_check` (set up, mesh, solve, margins).
- **REST.** `POST /fea/mesh|solve|import|export` live in `server/src/feaRoutes.ts` and reuse the token and security model (KI6).

## 8. Performance & robustness budgets

| Budget | Target |
| ------ | ------ |
| Mesh of a 20k-node tet10 bracket | ≤ 15 s (Gmsh, 1 thread) |
| Solve (CalculiX, static, 50k nodes, SPOOLES/PARDISO) | ≤ 30 s. TBD: measure (VC-FEA-53) |
| FRD parse | ≥ 50 MB/s in TS, streaming line reader, no full-file string when > 64 MB |
| Skin colour update when the field changes | ≤ 50 ms for 200k skin triangles (pre-computed per field, GPU attribute swap) |
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
| Production gate | LE10 timing scenario | 53 |

Coverage 90/85/90/90 extends to `packages/domain-cae/src/**` (CLAUDE.md non-negotiable 3).

## 10. Delivery plan

| M | Content | Depends on | Effort |
| - | ------- | ---------- | ------ |
| M1 | Data model (core types, `Material.elastic/allowables`), plugin skeleton, commands create/idealize(solid, plane_stress)/constraint/load/mesh controls/factors, `facesNear`, face centroid/normal in OCC topology, staleness hashes, unit tests | 01 KRN (exact faces on desktop) | 3 w |
| M2 | Bridge op `mesh` (Gmsh), face map, artifact store, `record_fe_mesh`, Verdict port + quality gate, CLI `fea mesh/quality`, desktop wheel staging | M1 | 3 w |
| M3 | INP writer, bundled `ccx` (`desktop/scripts/prepare-ccx.mjs`), `fea_solve`, FRD/DAT readers, `record_fea_results`, result overlay, probes, margins, analytic checks, VC-10…14, 20–22, 30, 31, 40–44 | M2 | 4 w |
| M4 | MCP toolset and prompt, REST routes, golden plans, quality:fea, production-gate scenario, licence packaging | M3 | 2 w |
| M5 (V1) | BDF writer + pyNastran check, OP2 import, VTU export, RBE3/distributing coupling, Netgen option | M4 | 3 w |
| M6 (V1) | Shell idealization: midsurface (fast path, then face-pairing), defeaturing, shell decks (S8/CQUAD8), shell result mapping | M4, 07 FTR (sheet metal recipes help the fast path) | 4 w |
| V2 | beams (CBAR/B32), composites (06 CMP → PCOMP / `*SHELL SECTION, COMPOSITE`), tied contact, user Nastran/MYSTRAN runner | 06 CMP, 08 MAT | — |

Cross-gap: **08 MAT** supplies allowables (`MaterialAllowables.source` holds the MAT library id). **01 KRN** supplies stable
exact faces and STEP. **06 CMP** supplies laminates. **09 PLM** stamps results with the revision.

## 11. Open questions / decisions needed

1. **GPL in the desktop installer** (Gmsh GPL-2.0+ with exception [R10], CalculiX GPL-2.0 [R30]). Do we ship them bundled as separate
   programs with source archives, or download them on first use? This needs a legal decision. Netgen (LGPL-2.1) [R11] is the fallback mesher.
2. **CalculiX binaries per OS.** Do we build from source in CI (SPOOLES/ARPACK, optional PARDISO), or use third-party builds? Provenance
   and reproducibility for tool qualification have to be settled either way.
3. **Mesh in the document versus the cache.** TR-FEA-05 proposes the cache, with a `.llullz` bundle for sharing. Live sync (L6) does not carry artifacts, so
   collaborators re-mesh. Is that acceptable?
4. **opencascade.js 1.1.1 bindings**: is `BRepAlgoAPI_Defeaturing` available? If not, rebuild the WASM or delegate to Gmsh.
5. Should **web/cloud** offer meshing at all (server-side Gmsh), or is FEA desktop-only? The proposal: MCP transports are available only where configured.
6. **Nastran conformance**: get access to an official MSC or Simcenter QRG, or a MYSTRAN install (licence not verified), to check BDF beyond pyNastran.
7. **Shell stress output**: decide how top and bottom fibre stresses are extracted from CalculiX shell expansion for MS.
8. **Singularity policy** for MS: what the default exclusion radius is, and whether it is user-overridable with a mandatory note.
9. **Search-verified sources** (eCFR, NASA-STD-5001B, the NAFEMS vendor manuals) must be re-checked by a human with direct page access
   before the MS report wording is frozen (sources.md marks each one).

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
- L1 llull: `.claude/rules/architecture.md`, `docs/decisions/KI5-shape-kernel-boundary.md`, `docs/decisions/KI6-desktop-app-cli-first.md`, `packages/core/src/geometry/kernel.ts`, `server/src/pythonExchange.ts`.
