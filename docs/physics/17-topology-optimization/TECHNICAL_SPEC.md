# PHY-17: Topology & shape optimization — technical specification

Gap id **TOP** · status: specification · written 2026-10-15 · functional spec: [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md)
· validation: [`validation/README.md`](validation/README.md) · sources: [`validation/sources.md`](validation/sources.md)

## 1. Current state in llull

| Area | What exists | Path | Limit for topology optimization |
| ---- | ----------- | ---- | ------------------------------- |
| Derived geometry | `CadPlugin.document.derivedEntityIds(doc)`, `DerivationGuard { domain, check(previous, next) }` evaluated by `execute`; AEC plugins regenerate owned entities (`regenerateOwned`) | `packages/core/src/plugins/plugin.ts`, `packages/core/src/commands/derivation.ts`, `packages/domain-aec/src/shared/derived.ts` | Mechanism exists; no physics domain uses it |
| Triangle-mesh entities | `MeshSolidEntity { kind: 'mesh', mesh: MeshData, brep?: ShapeRecipe }` for kernel results, imports, plugin geometry | `packages/core/src/model/types.ts` | Suitable carrier for the iso-surface |
| Rebuild vocabulary | `draw_polyline` (closed loops), `extrude_profile` (inline `profile`, `id`/`ids`, `depth`), `boolean`, `fillet_edge`, `move_entities`, `set_parameter` with `=expr` regeneration | `commands/draw2d/basic.ts`, `commands/solids/profile.ts`, `commands/brep/boolean.ts`, `commands/brep/*`, `commands/edit/batch.ts`, `commands/parametric/parameters.ts` | Enough to rebuild 2.5D parts from contours |
| Mass / volume | `mass_properties` (volume, mass with density) | `commands/inspect/measureSolid.ts` | Used for mass saving reports |
| 05 FEA (aerospace, built first) | `AnalysisCase` (parts, constraints, loads on `facesNear` targets, `MeshControls`), artifact store, `FeaMaterialView` (E, ν from 08), transports `fea_mesh` / `fea_solve`, staleness hash | `docs/aerospace/05-fea-cae-handoff/TECHNICAL_SPEC.md` §3–§5 | No design variables, no optimiser |
| Python bridge | One short-lived CPython process per request, timeout, at most 2 concurrent runs (CadQuery today; 05 adds `gmsh`) | `server/src/pythonExchange.ts`, `server/python/llull_bridge.py` | No numpy/scipy op for SIMP |
| CalculiX optimisation | `*DESIGN VARIABLES, TYPE=COORDINATE` (surface nodes) or `ORIENTATION`; `*DESIGN RESPONSE`, `*SENSITIVITY`, `*FEASIBLE DIRECTION`, `*FILTER`, `*GEOMETRIC CONSTRAINT` | CalculiX manual [R7] | Shape / orientation sensitivities only; no density topology optimisation |

`grep -ri "simp\b\|topolog.*optim\|density filter"` over `packages/`, `server/` finds nothing relevant today.

## 2. Target architecture

```
server/ (host)                              src/app  installDefaultPlugins() + physics plugin "topology"
  topologyRoutes: topology_solve ✱  ─ spawns bundled CPython op "topopt" (numpy + scipy, permissive) ─ artifact store
        │ dispatch record_topology_result (validated)
        ▼
packages/domain-physics/src (@phys) ── CadPlugin "topology", toolset "analysis"
   topology/commands/: create_topology_study, set_topology_regions, set_topology_settings, delete_topology_study,
                       record_topology_result, topology_report, suggest_rebuild, compare_to_topology, check_topology
   topology/derive.ts       density field → iso-surface MeshData (marching squares / cubes, pure TS)  [derived geometry]
   topology/guard.ts        DerivationGuard 'topology' (edits of derived ids → TOP_DERIVED_READ_ONLY)
   topology/contours.ts     marching squares + Douglas–Peucker → closed polylines (pure)
   topology/grid.ts         voxelisation of the design domain (via kernel tessellation, pure point-in-mesh test)
        ▼ (public core API, L10) + 05 @cae types (AnalysisCase, FeaTarget, FeaMaterialView)
packages/core/src/lib/topology.ts   pure SIMP/OC/filter reference (small grids, used by tests and by the
                                    separable-problem check; the production solve runs in the bridge)
```

**Laws respected**

- **L1/L5.** Study set-up and every query are registry commands; the solve is a transport that applies its result via
  `record_topology_result`, validated against the artifact store (05 §4.1 trust model), so an agent cannot inject a
  fabricated optimum.
- **L2.** Process and file work in `server/`; deterministic numerics in the bridge op; geometry derivation in pure TS.
- **L3/L4.** Study data lives in the 05 `analysis` slice (`AnalysisCase.topology`); the density field lives in the
  content-addressed artifact store; the iso-surface is regenerated from it.
- **L8.** The iso-surface entity id is reported by `derivedEntityIds`; `topology/guard.ts` rejects any command that
  changes it (except the plugin's own regeneration); `restore` re-derives it on load from the artifact (or marks it
  `missing`).
- **L9.** Voxelisation reads `ctx.kernel.tessellate` of the design-domain entities (`requiresKernel: true` on
  `create_topology_study` when entity domains are used); the rebuild uses ordinary kernel commands.
- **L10.** Plugin `topology` in `packages/domain-physics` (proposal, README §5.1).

**Requirements (technical)**

| Id | Pri | Requirement |
| -- | --- | ----------- |
| TR-TOP-01 | MUST | `AnalysisCase.topology?: Record<string, TopologyStudy>` with `topologyOrder`; ids `ts-<step>.<k>` (L8). Plugin `validate` checks ranges (0 < volumeFraction < 1, p ≥ 1, rmin > 0, voxel > 0). |
| TR-TOP-02 | MUST | Design grid: axis-aligned voxels of size `voxel` over the AABB of the design-domain entities; an element is active iff its centre is inside the domain (ray-parity test on the kernel tessellation); keep-in / keep-out masks from `FeaTarget`s (faces → voxels within one voxel of the face) and from boxes/entities. 2D studies use a plane (`plane: 'XY'\|'XZ'\|'YZ'`, thickness from the extrusion depth). |
| TR-TOP-03 | MUST | Bridge op `topopt` (bundled CPython, numpy + scipy): Q4 plane-stress (2D) or H8 (3D) elements on the voxel grid, modified SIMP, OC (MVP) or MMA (V1), sensitivity / density filter as a sparse matrix, loads and supports transferred from the 05 targets to the nearest active voxel nodes. Single-threaded BLAS (`OMP_NUM_THREADS=1`) for determinism. |
| TR-TOP-04 | MUST | Linear solve: sparse direct (scipy `splu` / `factorized`) up to a DOF cap (default 2e5, named), preconditioned CG above (relative tolerance 1e-10 on the residual, stated in the report); 3D above 1e6 DOF refused (`TOP_GRID_TOO_LARGE`). |
| TR-TOP-05 | MUST | Element stiffness: closed forms of the reference formulation (2D: top88 KE for unit square, scaled by E0·t; 3D: 8-node hexahedron with 2×2×2 Gauss, unit-tested against the 2D/3D patch test and VC-TOP-01). |
| TR-TOP-06 | MUST | OC update exactly as §5.2 (move, bisection, stop); the pure reference in `@lib/topology.ts` reproduces VC-TOP-03 and VC-TOP-10/11 on small grids in tests. |
| TR-TOP-07 | MUST | Artifact `TopologyField { grid, density: Float32Array (xPhys), history[], settingsHash, inputHash }` in the 05 `FeArtifactStore`; `record_topology_result` recomputes the summary from the artifact. Resume: the op accepts a starting density artifact. |
| TR-TOP-08 | MUST | Derived iso-surface: marching cubes (3D) / extruded marching-squares contour (2D) at `threshold` (default 0.5), on xPhys after optional symmetric mirroring; deterministic vertex order; stored as `MeshSolidEntity` with `layerId` `layer-topology`, colour fixed, `concept: true` recorded in the study (not on the entity type). |
| TR-TOP-09 | MUST | `suggest_rebuild`: marching squares on the section plane through the field (trilinear interpolation for 3D), closed loops oriented CCW (outer) / CW (holes), Douglas–Peucker simplification with `tolerance` (document length unit, default = voxel size, named), minimum loop area filter (default 4 voxel², named); member widths by distance transform along the medial axis at sample points (V1 skeleton). Output in document units, plane-local 2D coordinates plus the plane placement, directly usable as `extrude_profile.profile`. |
| TR-TOP-10 | MUST | `compare_to_topology`: voxelise the rebuilt entity on the study grid (same test as TR-TOP-02); IoU = \|A∩B\| / \|A∪B\| against the thresholded field restricted to the design domain; volume ratio; if a current 05 result of the rebuild exists, compliance ratio Fᵀu(rebuild) / c(optimum) with both in the analysis unit system. |
| TR-TOP-11 | MUST | Agent-first contract: `settings` named defaults, units in every field, `unverified` OR-ed from the 08 inputs, `concept: true`, `reviewRequired` on rebuild comparisons that feed release, codes §7.1. |
| TR-TOP-12 | MUST | 09 PLM release hook: the plugin contributes a release check that fails with `TOP_RESULT_NOT_RELEASABLE` when a released item is a topology-derived entity. |
| TR-TOP-13 | SHOULD (V1) | Shape optimisation: objective gradient w.r.t. document parameters from PHY-18 `parameter_sensitivity` (finite differences through feature-history regeneration), bounded steepest descent / MMA on parameters, each accepted iterate one `set_parameter` step (replayable). |

## 3. Data model

```ts
// packages/domain-physics/src/topology/types.ts — extends 05 AnalysisCase (README §6.2)
import type { FeaTarget } from '@cae/model';      // 05 type (facesNear / edgesNear / pointsNear)
export interface NamedValue { readonly value: number; readonly source: string; readonly defaulted: boolean }
export type TopologyObjective =
  | { readonly kind: 'min_compliance'; readonly loadCaseWeights: Record<string, number> }          // MVP
  | { readonly kind: 'min_volume'; readonly maxCompliance: number; readonly unit: string };        // V1
export type TopologyRegion =
  | { readonly kind: 'target'; readonly target: FeaTarget; readonly depthVoxels: number }
  | { readonly kind: 'entity'; readonly entityId: string }
  | { readonly kind: 'box'; readonly min: Vec3; readonly max: Vec3 };
export interface ManufacturingConstraints {
  readonly symmetry: readonly ('XY' | 'XZ' | 'YZ')[];       // planes through the domain AABB centre (MVP)
  readonly extrusion?: { readonly axis: 'x' | 'y' | 'z' };  // V1
  readonly minMemberSize?: number;                         // V1, document length unit; enforces rmin >= size / 2
  readonly overhang?: { readonly buildDirection: Vec3; readonly angleDeg: number };   // V2
}
export interface TopologySettings {
  readonly penal: NamedValue;            // 3, Andreassen et al. 2011
  readonly eminRatio: NamedValue;        // 1e-9 (Emin / E0)
  readonly move: NamedValue;             // 0.2
  readonly changeTol: NamedValue;        // 0.01
  readonly maxIterations: NamedValue;    // 300 (llull choice)
  readonly filter: { readonly kind: 'sensitivity' | 'density'; readonly radius: NamedValue };   // radius in doc units, default 1.5 voxel
  readonly threshold: NamedValue;        // 0.5 (llull choice) for derived geometry
  readonly greyLimit: NamedValue;        // 0.1 (llull choice)
  readonly optimizer: 'oc' | 'mma';
}
export interface TopologyStudy {
  readonly id: string; readonly name: string; readonly analysisId: string;
  readonly dimension: 2 | 3; readonly plane?: 'XY' | 'XZ' | 'YZ';
  readonly designDomain: readonly string[];                 // entity ids
  readonly keepIn: readonly TopologyRegion[]; readonly keepOut: readonly TopologyRegion[];
  readonly voxel: number;                                   // document length unit
  readonly volumeFraction: number;                          // of the active design voxels (keep-in counted, reported)
  readonly objective: TopologyObjective;
  readonly manufacturing: ManufacturingConstraints;
  readonly settings: TopologySettings;
  result?: TopologyResultSummary;
  derivedEntityId?: string;                                 // iso-surface mesh (read-only)
}
export interface TopologyResultSummary {
  readonly fieldHash: string; readonly inputHash: string; readonly settingsHash: string;
  readonly grid: { readonly nx: number; readonly ny: number; readonly nz: number; readonly active: number; readonly keepIn: number; readonly keepOut: number };
  readonly iterations: number; readonly status: 'converged' | 'max_iterations';
  readonly compliance: number; readonly complianceUnit: string;        // e.g. 'N*mm'
  readonly perLoadCase: Record<string, number>;
  readonly volumeFraction: number; readonly grey: number;
  readonly thresholdedVolume: number; readonly volumeUnit: string; readonly massG?: number;
  readonly history: readonly { it: number; compliance: number; volume: number; change: number }[];   // capped at 1000 rows
  readonly solver: { readonly op: string; readonly version: string; readonly numpy: string; readonly scipy: string };
  readonly unverified: boolean; readonly unverifiedReasons: readonly string[];
  readonly concept: true;
}
// Artifact (store, not document)
export interface TopologyField { readonly grid: TopologySummaryGrid; readonly xPhys: Float32Array; readonly x?: Float32Array }
```

Document version: rides the 05 `analysis` slice in the aerospace v3 envelope (01 KRN §3.1); no own migration.

## 4. Commands

Plugin `topology`, toolset `analysis`. ✱ = transport.

| Name | Kind | Params sketch | Tags |
| ---- | ---- | ------------- | ---- |
| `create_topology_study` | mutating (requiresKernel) | `{ analysisId, name, designDomain: string[], dimension: 2\|3, plane?, voxel: number (doc length unit), volumeFraction: number (0–1), objective?: { kind:'min_compliance', loadCaseWeights? } }` | @affects `analysis.cases[a].topology` · @invariant settings filled with named defaults; load/support faces added as keep-in (named default) · @failure analysis missing, domain not a solid, voxel count > cap (`TOP_GRID_TOO_LARGE`), volumeFraction ∉ (0,1) → no-op |
| `set_topology_regions` | mutating | `{ studyId, keepIn?: TopologyRegion[], keepOut?: TopologyRegion[] }` | @failure region outside domain (`TOP_REGION_OUTSIDE_DOMAIN`), keep-in ≥ budget (`TOP_KEEPIN_EXCEEDS_BUDGET`) |
| `set_topology_settings` | mutating | `{ studyId, penal?, eminRatio?, move?, changeTol?, maxIterations?, filter?: { kind, radius? }, threshold?, greyLimit?, optimizer?, manufacturing? }` | @invariant p ∈ [1, 5], 0 < move ≤ 1, radius > 0 · each given value stored `defaulted: false` |
| `delete_topology_study` | mutating | `{ studyId }` | removes study and its derived entity |
| `record_topology_result` | mutating (validated) | `{ studyId, fieldHash }` | @affects `study.result`, regenerates `derivedEntityId` · @invariant artifact exists, sha256 = hash, summary recomputed from the artifact, inputHash current · @failure `TOP_ARTIFACT_NOT_FOUND`, `TOP_SUMMARY_MISMATCH`, `TOP_RESULT_STALE` → no-op |
| `topology_report` | query | `{ studyId, historyRows?: integer }` → `data { state: 'unsolved'\|'solved'\|'stale'\|'missing', result, settings, manufacturing, provenance, concept: true, unverified }` | read-only |
| `suggest_rebuild` | query | `{ studyId, plane?, offset?: number (doc unit), tolerance?: number (doc unit), minLoopArea?: number (doc unit²) }` → `data { plane, placement: { position, rotation }, loops: [{ points: [x,y][], orientation: 'outer'\|'hole', areaMm2 }], widthSamples: [{ at, widthMm }], enclosedFraction }` | @failure stale / missing result → `TOP_RESULT_STALE` / `TOP_RESULT_MISSING` |
| `compare_to_topology` | query (requiresKernel) | `{ studyId, entityId, iouTarget?: number, complianceRatioTarget?: number }` → `data { iou, volumeRatio, complianceRatio?, targets: { iou: NamedValue, complianceRatio: NamedValue }, status, codes[] }` | read-only |
| `check_topology` | query | `{ studyId }` → `data { status, items: [{ code, severity, ids[], message, remediation }], reviewRequired }` | AF-20 readiness check |
| ✱ `topology_solve` | transport | `{ studyId, timeoutS?: number (default 1800), resumeFromLast?: boolean }` | builds the grid, transfers 05 loads/supports and E/ν, runs the bridge op with progress per iteration, stores the artifact, dispatches `record_topology_result` |

Example description (AF-02) for `create_topology_study`: "Creates a minimum-compliance topology optimization study
on an existing 05 analysis case. `voxel` is the grid spacing in document length units (e.g. 1 for 1 mm voxels);
`volumeFraction` is the share of the design domain that may stay solid (0.7 = 30 % lighter). Refuses domains that are
not solids and grids above the voxel cap. Next: `set_topology_regions` to protect bosses and interfaces, then
`topology_solve`."

## 5. Kernel / algorithms

### 5.1 Interpolation and sensitivity (reference formulation [R1])

```
E_e(x) = Emin + x_e^p (E0 − Emin),   Emin = eminRatio · E0
c(x)   = Σ_lc w_lc F_lcᵀ U_lc = Σ_lc w_lc Σ_e E_e(x) u_eᵀ k0 u_e        (k0: element stiffness for E = 1)
∂c/∂x_e = − Σ_lc w_lc p (E0 − Emin) x_e^(p−1) u_eᵀ k0 u_e
∂V/∂x_e = v_e (voxel volume; 1 on a unit grid)
```

### 5.2 Filters and OC update [R1]

```
H_ei = max(0, rmin − ‖c_e − c_i‖),  Hs_e = Σ_i H_ei            (rmin in voxels = radius / voxel)
sensitivity filter:  dc_e ← Σ_i H_ei x_i dc_i / (Hs_e · max(1e-3, x_e));   xPhys = x
density filter:      xPhys_e = Σ_i H_ei x_i / Hs_e;  dc_e ← Σ_i H_ei dc_i / Hs_i;  dv likewise
OC:  l1 = 0, l2 = 1e9, move = 0.2
     while (l2 − l1)/(l1 + l2) > 1e-3:
        λ = (l1 + l2)/2
        x_new = clamp(x · sqrt(−dc / (dv λ)), max(0, x − move), min(1, x + move))
        xPhys from x_new (filter rule);  keep-in → 1, keep-out → 0
        if Σ xPhys > volfrac · N_active: l1 = λ else l2 = λ
     change = max |x_new − x|;  stop when change ≤ changeTol or iterations = maxIterations
```

The generator `validation/generate_top_reference.py` implements exactly this on the MBB half-beam; an independent
run of topoptlab 1.0.0 gives the same final compliances to 1e-10 relative (VC-TOP-10.b, 11.b).

### 5.3 Element stiffness

2D Q4 plane stress, unit square, E = 1 (top88): KE = (1/(1 − ν²)/24) ([A11 A12; A12ᵀ A11] + ν [B11 B12; B12ᵀ B11]) with
the integer blocks of the reference code; KE[0][0] = (12 − 4ν)/(24(1 − ν²)), KE[0][1] = (3 + 3ν)/(24(1 − ν²)),
rows sum to zero (VC-TOP-01). Scaled by E0 · t · (voxel/voxel) (a square element's in-plane stiffness is size
independent). 3D H8: 2×2×2 Gauss integration of Bᵀ D B on a unit cube, scaled by E0 · voxel.

### 5.4 Grid, loads and supports

1. Voxel centres inside the design domain are active (TR-TOP-02). Inactive voxels are removed from the system
   (not modelled as Emin), so the domain boundary is exact to one voxel.
2. 05 constraints map to the nodes of active voxels whose faces lie within half a voxel of the target face; 05 loads
   are distributed equally over those nodes (total preserved, unit-tested). A target that maps to no node →
   `TOP_TARGET_UNMAPPED`.
3. Load/support voxels (one layer) are keep-in by default (`settings` names it).

### 5.5 Derived geometry and rebuild aids

- Iso-surface: marching cubes on xPhys with node values averaged from the 8 adjacent voxels; 2D: marching squares
  contour extruded by the study thickness. Output welded, consistently oriented, closed (boundary voxels padded with 0).
- Contours (TR-TOP-09): marching squares at `threshold`; loops closed; Douglas–Peucker with `tolerance`; loops with
  area < `minLoopArea` dropped (reported count); orientation by signed area. `enclosedFraction` = Σ outer − Σ holes
  areas / design-domain section area.
- The agent rebuild recipe (documented in `llull guide`): outer loop → `extrude_profile profile=[…] depth=t`;
  each hole loop → `extrude_profile` + `boolean op=subtract`; then `fillet_edge` on sharp re-entrant corners; then
  05 analysis of the rebuild; then `compare_to_topology`.

### 5.6 Named defaults (AF-31)

| Default | Value | Source |
| ------- | ----- | ------ |
| p | 3 | reference code default call [R1] |
| Emin / E0 | 1e-9 | [R1] |
| move | 0.2 | [R1] |
| stop | max \|Δx\| ≤ 0.01 | [R1] |
| filter radius | 1.5 voxel | [R1] default call rmin = 1.5 |
| maxIterations | 300 | llull choice |
| threshold | 0.5 | llull choice |
| grey limit | 0.1 | llull choice |
| IoU target | 0.85 | llull choice (to calibrate on the production scenario, §11) |
| compliance-ratio target | 1.15 | llull choice (to calibrate) |
| DOF cap direct solve | 2e5 | llull choice |

### 5.7 Numerical tolerances

| Item | Value |
| ---- | ----- |
| MBB compliance vs generator | 1e-6 relative (bridge uses a different linear solver; generator vs topoptlab agree to 1e-10) |
| Iteration count | exact for the pure TS reference; ±2 for the bridge (different solver rounding can shift the stop iteration) |
| KE entries | 1e-12 relative |
| Contour simplification | ≤ tolerance (Hausdorff, tested) |

## 6. Interop & persistence

| Item | Format |
| ---- | ------ |
| Study | `analysis.cases[a].topology` in the `.llull` document |
| Density field | gzip JSON / binary in `FeArtifactStore` (`<sha256>.topo.json.gz`) |
| Derived mesh | regenerated on load; never written into STEP / release packages (TR-TOP-12) |
| Export for review | `export_stl` of the derived mesh allowed with a `concept` comment line; VTK image data of the field via the bridge (V1) |

## 7. CLI / MCP / UI surfaces

- **CLI**: registry commands as `llull <command>`; `topology_solve` like `fea_solve` (`--progress`, `--timeout`,
  resumable). `llull guide` gains a topology section: units, minimal plan, rebuild recipe, end with `check_topology`.
- **MCP**: toolset `analysis`; `topology_solve` only where the bridge has numpy/scipy.
- **UI**: `src/ui/panels/analysis/TopologyPanel.tsx` (settings, history plot, threshold slider), viewport overlay for
  the field and the rebuild deviation. Review only.

### 7.1 Stable error and check codes (AF-11)

| Code | Severity | When | Offending ids / path | Remediation |
| ---- | -------- | ---- | -------------------- | ----------- |
| `TOP_ANALYSIS_MISSING` | error | analysisId unknown | path | create the 05 analysis first |
| `TOP_DOMAIN_INVALID` | error | design domain empty or not a solid | entity ids | pass solid entity ids |
| `TOP_GRID_TOO_LARGE` | error | voxel count or DOFs above cap | count, suggested voxel | increase `voxel` |
| `TOP_VOLUME_FRACTION_INVALID` | error | ∉ (0, 1) | path | e.g. 0.7 for 30 % lighter |
| `TOP_REGION_OUTSIDE_DOMAIN` | error | region does not intersect the domain | region index | move the region |
| `TOP_KEEPIN_EXCEEDS_BUDGET` | error | keep-in volume ≥ budget | volumes | raise volumeFraction or shrink keep-in |
| `TOP_TARGET_UNMAPPED` | error | 05 load/support maps to no voxel node | 05 id | refine voxel or move the target |
| `TOP_LOAD_OUTSIDE_DOMAIN` | error | load face outside the domain | 05 id | include the face in the domain |
| `TOP_SETUP_INVALID` | error | under-constrained (05 `FEA_UNDERCONSTRAINED`), no load case | ids | add supports / loads |
| `TOP_FILTER_TOO_SMALL` | warning | radius < 1 voxel | study id | radius ≥ 1.5 voxel |
| `TOP_NOT_CONVERGED` | warning | `max_iterations` | study id | raise the cap or relax the stop |
| `TOP_GREY_HIGH` | warning | grey > greyLimit | study id | density filter + projection (V1), larger p |
| `TOP_RESULT_MISSING` | error | no result / artifact absent | study id | `topology_solve` |
| `TOP_RESULT_STALE` | error | inputHash or settingsHash changed | study id | re-run `topology_solve` |
| `TOP_ARTIFACT_NOT_FOUND` | error | record: hash not in store | hash | run the transport |
| `TOP_SUMMARY_MISMATCH` | error | record: summary ≠ recomputed | fields | same |
| `TOP_DERIVED_READ_ONLY` | error | an edit touches the derived mesh | entity id | rebuild with ordinary commands |
| `TOP_REBUILD_MISSING` | warning | solved study without a compared rebuild | study id | `suggest_rebuild`, rebuild, `compare_to_topology` |
| `TOP_REBUILD_DEVIATION` | fail | IoU < target or compliance ratio > target | entity id, values | follow the contours more closely |
| `TOP_REBUILD_NOT_ANALYSED` | warning | rebuild has no current 05 result | entity id | run 05 on the rebuild |
| `TOP_INPUT_UNVERIFIED` | warning (not suppressible) | E/ν from an `unverified` 08 value | material | replace with a verified value |
| `TOP_RESULT_NOT_RELEASABLE` | error | release includes a topology-derived item | entity id | release the rebuilt part instead |
| `TOP_TOOL_MISSING` | error | bridge lacks numpy/scipy | tool | desktop bundle / install hint |
| `TOP_SOLVER_FAILED` | error | bridge op error / singular system | log tail | check supports and keep-out regions |
| `TOP_SOLVER_TIMEOUT` | error | timeout | study id | coarser voxel, `resumeFromLast` |

### 7.2 Agent-first compliance

| AF | Where |
| -- | ----- |
| AF-01…05 | registry commands, descriptions with units, guide section, plan in `validation/plans/` |
| AF-10/12/13 | unit-bearing `data`; field via artifact store, images via `render_view --save`; determinism (FR-TOP-18) |
| AF-11 | §7.1 |
| AF-20/21/22 | `check_topology`; report numbers; `render_view` field overlay |
| AF-23 | VC cases through `run_benchmarks` (PHY-00) |
| AF-30/31 | §5.6 named defaults |
| AF-32/33/34 | `unverified`; `concept`, never releasable; release of the rebuild via 05/09 human gates |
| AF-35/36 | `provenance` (formulation, settings, solver versions); owner summary |
| AF-40/41/42 | progress, timeout, resume, cache; `TOP_TOOL_MISSING`; `--dry-run` on set-up |

## 8. Performance & robustness budgets

| Budget | Target |
| ------ | ------ |
| 2D 60×20 MBB (bridge) | ≤ 10 s total (stdlib generator: ~25 s per run on a laptop, measured 2026-10-15) |
| 2D 300×100 | ≤ 60 s — TBD measure (VC-TOP-12) |
| 3D 100k voxels, 100 iterations | ≤ 10 min (PCG + AMG-free Jacobi baseline; V1 multigrid) — TBD measure |
| Derived mesh | ≤ 2 s for 100k voxels (marching cubes, TS) |
| Memory | field ≤ 4 bytes / voxel in the document process; solver in the child process |

## 9. Test strategy (VC mapping)

| Layer | Tests | VC |
| ----- | ----- | -- |
| Unit core (`tests/unit/lib/topology.test.ts`) | KE, filter weights, OC separable problem, SIMP scaling, MBB 30×10 and 60×20 with the pure TS reference | 01–04, 10, 11 |
| Unit plugin (`tests/unit/physics/topology/*`) | every command happy/failure/`is pure`; guard; contours on synthetic fields; compare IoU on known shapes; release hook; unverified propagation | 20–26 |
| Golden | `validation/plans/top_mbb_60x20.plan.json` once commands exist (study set-up replay) | 21 |
| Integration (`server/tests`, needs bundled CPython numpy/scipy) | bridge op MBB vs expected; determinism; resume | 10, 11, 27 |
| Quality gate | `npm run quality:physics` runs VC-TOP-10/11 through `run_benchmarks` | 10, 11 |
| Production gate (V1) | "make the bracket 30 % lighter" agent scenario | 23 |

## 10. Delivery plan

| M | Content | Depends on | Effort |
| - | ------- | ---------- | ------ |
| M1 | Types, plugin skeleton, study commands, pure `@lib/topology.ts` reference, VC 01–04, 10, 11 in unit tests | 05 FEA M1 (AnalysisCase, targets) | 2 w |
| M2 | Bridge op `topopt` (2D), grid/targets mapping, `topology_solve`, record + artifact, report, derived mesh + guard | M1, 05 M2–M3 (artifact store, bridge), desktop numpy/scipy staging | 3 w |
| M3 | `suggest_rebuild`, `compare_to_topology`, `check_topology`, release hook, 3D H8 + PCG | M2, 09 PLM release | 3 w |
| M4 (V1) | MMA (licence decision), projection, extrusion constraint, min member size, shape optimisation via PHY-18 | PHY-18 M2 | 3 w |

## 11. Open questions / decisions needed

1. **MMA implementation licence**: mmapy is GPL-3.0; NLopt's Python wheel is listed as MIT on PyPI but NLopt itself
   mixes licences. Port MMA from the published algorithm (Svanberg 1987) into llull, or use NLopt as a separate
   process? Proposal: own port in V1.
2. **numpy + scipy in the desktop bundle** (permissive licences, §12 [R8]): size impact on the installer (CadQuery and Gmsh already bundled).
3. **Calibration of the rebuild targets** (IoU 0.85, compliance ratio 1.15): to be measured on the production scenario
   before they gate anything.
4. **Paper values**: the Andreassen et al. 2011 PDF and the DTU `top88.m` file were not reachable; the formulation
   was taken from the topoptlab transcription and confirmed by two independent implementations agreeing. A human
   should compare the pinned 60×20 values with `top88.m` output in MATLAB/Octave once (closes VC-TOP-10.a/11.a to A).
5. **Unstructured SIMP on the 05 tet mesh** (V1) vs voxels only: voxel grids are simpler and deterministic; tets follow
   the boundary. Proposal: voxels for MVP.
6. **Shape optimisation via CalculiX** `*SENSITIVITY` (node coordinates) vs parameter finite differences (PHY-18):
   the latter keeps the CAD parametric; CalculiX gives cheaper gradients for many variables. Decide in V2.

## 12. References

- [R1] Andreassen et al. 2011, Struct. Multidisc. Optim. 43:1–16, doi:10.1007/s00158-010-0594-7 — https://www.topopt.mek.dtu.dk/apps-and-software/efficient-topology-optimization-in-matlab (search extract; host blocked)
- [R2] Sigmund 2001, Struct. Multidisc. Optim. 21:120–127 (cited by [R1], [R4]; not opened)
- [R4] topoptlab 1.0.0, GPL-3.0 — https://pypi.org/project/topoptlab/1.0.0/ (sdist sha256 4978a92ad52afff9f9211ae4da8a5901d9b7e5abc43b8463a9b03f77ff5c090e; read and run as an external cross-check)
- [R5] ToPy, MIT — https://github.com/williamhunter/topy (commit 3c461c4b65c0f5f0c5476a4711a26a7e1ff64e58)
- [R6] topopt (Python), MIT — https://github.com/zfergus/topopt (commit c3d3bd546327732b72ea3862d0283b324b25422f)
- [R7] CalculiX manual — https://github.com/Dhondtguido/CalculiX (commit fd588701edd6a92fde06e99b1bdf01f3b0f80f2c), `doc/CalculiX.tex` §*DESIGN VARIABLES
- [R8] SciPy 1.18.1 (licence text: BSD-style, "Copyright (c) 2001-2002 Enthought, Inc. 2003, SciPy Developers"), NumPy 2.5.4 (PyPI licence expression `BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0`) — https://pypi.org/project/scipy/ , https://pypi.org/project/numpy/ (metadata read; SciPy wheel downloaded for the cross-check)
- llull: `.claude/rules/architecture.md` (L8, L9, L10), `packages/core/src/commands/derivation.ts`, `packages/core/src/plugins/plugin.ts`, `packages/domain-aec/src/shared/derived.ts`, 05 FEA TECHNICAL_SPEC.
