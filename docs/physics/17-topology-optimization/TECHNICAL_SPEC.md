# PHY-17: Topology & shape optimization — technical specification

Gap id **TOP** · status: specification · written 2026-10-15 · functional spec: [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md)
· validation: [`validation/README.md`](validation/README.md) · sources: [`validation/sources.md`](validation/sources.md)

## 1. Current state in llull

| Area                            | What exists                                                                                                                                                                              | Path                                                                                                                                                                   | Limit for topology optimization                                          |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Derived geometry                | `CadPlugin.document.derivedEntityIds(doc)`, `DerivationGuard { domain, check(previous, next) }` evaluated by `execute`; AEC plugins regenerate owned entities (`regenerateOwned`)        | `packages/core/src/plugins/plugin.ts`, `packages/core/src/commands/derivation.ts`, `packages/domain-aec/src/shared/derived.ts`                                         | Mechanism exists; no physics domain uses it                              |
| Triangle-mesh entities          | `MeshSolidEntity { kind: 'mesh', mesh: MeshData, brep?: ShapeRecipe }` for kernel results, imports, plugin geometry                                                                      | `packages/core/src/model/types.ts`                                                                                                                                     | Suitable carrier for the iso-surface                                     |
| Rebuild vocabulary              | `draw_polyline` (closed loops), `extrude_profile` (inline `profile`, `id`/`ids`, `depth`), `boolean`, `fillet_edge`, `move_entities`, `set_parameter` with `=expr` regeneration          | `commands/draw2d/basic.ts`, `commands/solids/profile.ts`, `commands/brep/boolean.ts`, `commands/brep/*`, `commands/edit/batch.ts`, `commands/parametric/parameters.ts` | Enough to rebuild 2.5D parts from contours                               |
| Mass / volume                   | `mass_properties` (volume, mass with density)                                                                                                                                            | `commands/inspect/measureSolid.ts`                                                                                                                                     | Used for mass saving reports                                             |
| 05 FEA (aerospace, built first) | `AnalysisCase` (parts, constraints, loads on `facesNear` targets, `MeshControls`), artifact store, `FeaMaterialView` (E, ν from 08), transports `fea_mesh` / `fea_solve`, staleness hash | `docs/aerospace/05-fea-cae-handoff/TECHNICAL_SPEC.md` §3–§5                                                                                                            | No design variables, no optimiser                                        |
| Python bridge                   | One short-lived CPython process per request, timeout, at most 2 concurrent runs (CadQuery; 05 meshes in the native `llull-mesh`)                                                         | `server/src/pythonExchange.ts`, `server/python/llull_bridge.py`                                                                                                        | No numpy/scipy op for SIMP                                               |
| CalculiX optimisation           | `*DESIGN VARIABLES, TYPE=COORDINATE` (surface nodes) or `ORIENTATION`; `*DESIGN RESPONSE`, `*SENSITIVITY`, `*FEASIBLE DIRECTION`, `*FILTER`, `*GEOMETRIC CONSTRAINT`                     | CalculiX manual [R7]                                                                                                                                                   | Shape / orientation sensitivities only; no density topology optimisation |

`grep -ri "simp\b\|topolog.*optim\|density filter"` over `packages/`, `server/` finds nothing relevant today.

## 2. Target architecture

```
server/ (host)                              src/app  installDefaultPlugins() + physics plugin "topology"
  topologyRoutes: topology_solve ✱  ─ spawns `llull-compute topopt <job-folder>` (Rust + wgpu, RS1; CPU twin) ─ artifact store
        │ dispatch record_topology_result (validated)
        ▼
packages/domain-physics/src (@phys) ── CadPlugin "topology", toolset "analysis"
   topology/commands/: create_topology_study, set_topology_regions, set_topology_settings, delete_topology_study,
                       record_topology_result, topology_report, suggest_rebuild, compare_to_topology, check_topology
   topology/derive.ts       density field → iso-surface MeshData (marching squares / cubes, pure TS)  [derived geometry]
   topology/guard.ts        DerivationGuard 'topology' (edits of derived ids → TOP_DERIVED_READ_ONLY)
   topology/contours.ts     marching squares + Douglas–Peucker → closed polylines (pure)
   topology/grid.ts         voxelisation of the design domain (via kernel tessellation, pure point-in-mesh test)
        ▼ (public core API only, L10 + dependency-cruiser rule): core model/analysis.ts (05 AnalysisCase, FeaTarget),
          PHY-01 resolvePropertyModel for E, nu (no @cae import)
packages/core/src/lib/topology.ts   pure SIMP/OC/filter reference (small 2D grids, used by tests, by the
                                    separable-problem check and as the native job's oracle; the production solve
                                    runs in `llull-compute topopt`)
solver/crates/llull-topopt          SIMP loop (FE solve + density filter + OC) on solver/crates/llull-voxfe (RS1 §2)
```

**Placement under the dependency rule** (aligned with PHY-03 TECHNICAL_SPEC §2.1): `.dependency-cruiser.cjs` rule `plugins-and-kernels-depend-on-core-only` forbids `packages/domain-physics` importing 05's `@cae`. The shared analysis data types (`AnalysisCase`, `FeaTarget`, `ResultsSummary`, mesh/result artifact shapes) live in core `model/analysis.ts` (05 TR-FEA-02), and this pack's additions go there too; behaviour that 05 must dispatch (staleness fields, check items) is registered through the core extension port proposed by PHY-03 (`CadPlugin.analysisExtensions`, `AnalysisTypeExtension`). **Proposal A (preferred):** `@phys` + core port, no package imports another package. **Proposal B (fallback):** the discipline lives inside the 05 FEA package (`packages/domain-cae/src/<discipline>/`). **Decision (owner, 2026-10-19): Proposal B.** The discipline lives in the CAE package, `packages/domain-cae/src/topology/`, as its own plugin `topology` (toolset `analysis`) installed next to `cae` in `src/app/plugins.ts`; a separate plugin because it owns derived geometry (`DocumentExtension.derivedEntityIds`) and a derivation guard, which the `cae` plugin's document extension does not. Everything below is written for A; read `@phys` as `@cae`, `packages/domain-physics` as `packages/domain-cae` and see §13 for what was built.

**Laws respected**

- **L1/L5.** Study set-up and every query are registry commands; the solve is a transport that applies its result via
  `record_topology_result`, validated against the artifact store (05 §4.1 trust model), so an agent cannot inject a
  fabricated optimum.
- **L2.** `@phys` imports core only (no `@cae`); process and file work in `server/`; deterministic numerics in the native job (reached only through the `server/`
  transport, RS1 §2 rule 1); geometry derivation in pure TS.
- **L3/L4.** Study data lives in the 05 `analysis` slice (`AnalysisCase.topology`); the density field lives in the
  content-addressed artifact store; the iso-surface is regenerated from it.
- **L8.** The iso-surface entity id is reported by `derivedEntityIds`; `topology/guard.ts` rejects any command that
  changes it (except the plugin's own regeneration); `restore` re-derives it on load from the artifact (or marks it
  `missing`).
- **L9.** Voxelisation reads `ctx.kernel.tessellate` of the design-domain entities (`requiresKernel: true` on
  `create_topology_study` when entity domains are used); the rebuild uses ordinary kernel commands.
- **L10.** Plugin `topology` in `packages/domain-physics` (proposal, README §5.1).

**Requirements (technical)**

| Id        | Pri         | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TR-TOP-01 | MUST        | `AnalysisCase.topology?: Record<string, TopologyStudy>` with `topologyOrder`; ids `ts-<step>.<k>` (L8). Plugin `validate` checks ranges (0 < volumeFraction < 1, p ≥ 1, rmin > 0, voxel > 0).                                                                                                                                                                                                                                                                                                                                                                   |
| TR-TOP-02 | MUST        | Design grid: axis-aligned voxels of size `voxel` over the AABB of the design-domain entities; an element is active iff its centre is inside the domain (ray-parity test on the kernel tessellation); keep-in / keep-out masks from `FeaTarget`s (faces → voxels within one voxel of the face) and from boxes/entities. 2D studies use a plane (`plane: 'XY'\|'XZ'\|'YZ'`, thickness from the extrusion depth).                                                                                                                                                  |
| TR-TOP-03 | MUST        | Native job `llull-compute topopt` (crate `llull-topopt` on `llull-voxfe`, RS1): Q4 plane-stress (2D) or H8 (3D) elements on the voxel grid, modified SIMP, OC (MVP) or MMA (V1), sensitivity / density filter applied as a fixed-stencil convolution (no assembled matrix), loads and supports transferred from the 05 targets to the nearest active voxel nodes. wgpu kernels with a Rust-CPU twin (rayon); the recorded field comes from the CPU twin or from GPU kernels with fixed-order reductions (RS1 §2 rule 3), and `solver.deterministic` says which. |
| TR-TOP-04 | MUST        | Linear solve: matrix-free element-by-element mat-vec (`llull-voxfe`), Jacobi-preconditioned CG (M2) then geometric-multigrid-preconditioned CG (M3), relative tolerance 1e-10 on the residual, stated in the report. DOF cap named and set per device from VC-TOP-34 (no fixed number until measured); above it `TOP_GRID_TOO_LARGE`. The pure-TS reference (`@lib/topology.ts`) stays limited to 2D grids.                                                                                                                                                     |
| TR-TOP-05 | MUST        | Element stiffness: closed forms of the reference formulation (2D: top88 KE for unit square, scaled by E0·t; 3D: 8-node hexahedron with 2×2×2 Gauss, unit-tested against the 2D/3D patch test and VC-TOP-01).                                                                                                                                                                                                                                                                                                                                                    |
| TR-TOP-06 | MUST        | OC update exactly as §5.2 (move, bisection, stop); the pure reference in `@lib/topology.ts` reproduces VC-TOP-03 and VC-TOP-10/11 on small grids in tests; the native job matches it on the 2D benchmark grids (VC-TOP-33).                                                                                                                                                                                                                                                                                                                                     |
| TR-TOP-07 | MUST        | Artifact `TopologyField { grid, density: Float32Array (xPhys), history[], settingsHash, inputHash }` in the 05 `FeArtifactStore`; `record_topology_result` recomputes the summary from the artifact. Resume: the op accepts a starting density artifact.                                                                                                                                                                                                                                                                                                        |
| TR-TOP-08 | MUST        | Derived iso-surface: marching cubes (3D) / extruded marching-squares contour (2D) at `threshold` (default 0.5), on xPhys after optional symmetric mirroring; deterministic vertex order; stored as `MeshSolidEntity` with `layerId` `layer-topology`, colour fixed, `concept: true` recorded in the study (not on the entity type).                                                                                                                                                                                                                             |
| TR-TOP-09 | MUST        | `suggest_rebuild`: marching squares on the section plane through the field (trilinear interpolation for 3D), closed loops oriented CCW (outer) / CW (holes), Douglas–Peucker simplification with `tolerance` (document length unit, default = voxel size, named), minimum loop area filter (default 4 voxel², named); member widths by distance transform along the medial axis at sample points (V1 skeleton). Output in document units, plane-local 2D coordinates plus the plane placement, directly usable as `extrude_profile.profile`.                    |
| TR-TOP-10 | MUST        | `compare_to_topology`: voxelise the rebuilt entity on the study grid (same test as TR-TOP-02); IoU = \|A∩B\| / \|A∪B\| against the thresholded field restricted to the design domain; volume ratio; if a current 05 result of the rebuild exists, compliance ratio Fᵀu(rebuild) / c(optimum) with both in the analysis unit system.                                                                                                                                                                                                                             |
| TR-TOP-11 | MUST        | Agent-first contract: `settings` named defaults, units in every field, `unverified` OR-ed from the 08 inputs, `concept: true`, `reviewRequired` on rebuild comparisons that feed release, codes §7.1.                                                                                                                                                                                                                                                                                                                                                           |
| TR-TOP-12 | MUST        | 09 PLM release hook: the plugin contributes a release check that fails with `TOP_RESULT_NOT_RELEASABLE` when a released item is a topology-derived entity.                                                                                                                                                                                                                                                                                                                                                                                                      |
| TR-TOP-13 | SHOULD (V1) | Shape optimisation: objective gradient w.r.t. document parameters from PHY-18 `parameter_sensitivity` (finite differences through feature-history regeneration), bounded steepest descent / MMA on parameters, each accepted iterate one `set_parameter` step (replayable).                                                                                                                                                                                                                                                                                     |

### 2.1 Stack amendment (RS1, 2026-10-18)

Decision [RS1](../../decisions/RS1-native-compute.md) step **RS-2** moves the SIMP loop from the planned CPython
numpy / scipy bridge to native code. What changes:

| Item                      | Before                                                           | Now                                                                                                                                                      |
| ------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Solver process            | bundled CPython op `topopt` (numpy + scipy)                      | `llull-compute topopt <job-folder>` (crate `llull-topopt` on `llull-voxfe`), job folder in, NDJSON progress out, sha256 result bundle (`llull-protocol`) |
| FE solve                  | sparse direct up to 2e5 DOF, PCG above, 3D refused above 1e6 DOF | matrix-free element-by-element mat-vec; Jacobi PCG, then geometric multigrid; no assembled matrix                                                        |
| Device                    | one CPU thread                                                   | wgpu (Vulkan / Metal / DX12) with a Rust-CPU twin for every kernel                                                                                       |
| DOF cap                   | 2e5 direct / 1e6 3D                                              | raised; target ≥ 1e7 DOF in 3D on a desktop GPU (target, TBD — measure, VC-TOP-34)                                                                       |
| Determinism               | single-threaded BLAS                                             | recorded numbers from the CPU twin or fixed-order GPU reductions; GPU-only fast runs say `deterministic: false`                                          |
| Reference                 | stdlib generator + `@lib/topology.ts`                            | unchanged; `@lib/topology.ts` stays the small 2D path and the oracle (VC-TOP-33)                                                                         |
| Marching cubes / contours | pure TS                                                          | unchanged (may stay TS; RS1 does not move them)                                                                                                          |
| Missing tool              | `TOP_TOOL_MISSING` (no numpy / scipy)                            | `TOP_TOOL_MISSING` when `llull-compute` is absent (generic `NATIVE_TOOL_MISSING`); 2D grids within the TS cap still solve in TS                          |

Layering is unchanged: the plugin never imports native code; `topology_solve` is a `server/` transport and the result
enters the document only through `record_topology_result` (RS1 §2 rule 1).

## 3. Data model

```ts
// packages/core/src/model/analysis.ts additions (data types in core; behaviour in @phys via the PHY-03 extension port)
import type { FeaTarget } from '@core/model/analysis'; // 05 type, core-owned (05 TR-FEA-02)
export interface NamedValue {
  readonly value: number;
  readonly source: string;
  readonly defaulted: boolean;
}
export type TopologyObjective =
  | { readonly kind: 'min_compliance'; readonly loadCaseWeights: Record<string, number> } // MVP
  | { readonly kind: 'min_volume'; readonly maxCompliance: number; readonly unit: string }; // V1
export type TopologyRegion =
  | { readonly kind: 'target'; readonly target: FeaTarget; readonly depthVoxels: number }
  | { readonly kind: 'entity'; readonly entityId: string }
  | { readonly kind: 'box'; readonly min: Vec3; readonly max: Vec3 };
export interface ManufacturingConstraints {
  readonly symmetry: readonly ('XY' | 'XZ' | 'YZ')[]; // planes through the domain AABB centre (MVP)
  readonly extrusion?: { readonly axis: 'x' | 'y' | 'z' }; // V1
  readonly minMemberSize?: number; // V1, document length unit; enforces rmin >= size / 2
  readonly overhang?: { readonly buildDirection: Vec3; readonly angleDeg: number }; // V2
}
export interface TopologySettings {
  readonly penal: NamedValue; // 3, Andreassen et al. 2011
  readonly eminRatio: NamedValue; // 1e-9 (Emin / E0)
  readonly move: NamedValue; // 0.2
  readonly changeTol: NamedValue; // 0.01
  readonly maxIterations: NamedValue; // 300 (llull choice)
  readonly filter: { readonly kind: 'sensitivity' | 'density'; readonly radius: NamedValue }; // radius in doc units, default 1.5 voxel
  readonly threshold: NamedValue; // 0.5 (llull choice) for derived geometry
  readonly greyLimit: NamedValue; // 0.1 (llull choice)
  readonly protectLoadSupport: { readonly value: boolean; readonly source: string; readonly defaulted: boolean }; // true (llull choice); false reproduces top88
  readonly optimizer: 'oc' | 'mma';
}
export interface TopologyStudy {
  readonly id: string;
  readonly name: string;
  readonly analysisId: string;
  readonly dimension: 2 | 3;
  readonly plane?: 'XY' | 'XZ' | 'YZ';
  readonly designDomain: readonly string[]; // entity ids
  readonly keepIn: readonly TopologyRegion[];
  readonly keepOut: readonly TopologyRegion[];
  readonly voxel: number; // document length unit
  readonly volumeFraction: number; // of the active design voxels (keep-in counted, reported)
  readonly objective: TopologyObjective;
  readonly manufacturing: ManufacturingConstraints;
  readonly settings: TopologySettings;
  result?: TopologyResultSummary;
  derivedEntityId?: string; // iso-surface mesh (read-only)
}
export interface TopologyResultSummary {
  readonly fieldHash: string;
  readonly inputHash: string;
  readonly settingsHash: string;
  readonly grid: {
    readonly nx: number;
    readonly ny: number;
    readonly nz: number;
    readonly active: number;
    readonly keepIn: number;
    readonly keepOut: number;
  };
  readonly iterations: number;
  readonly status: 'converged' | 'max_iterations';
  readonly compliance: number;
  readonly complianceUnit: string; // e.g. 'N*mm'
  readonly perLoadCase: Record<string, number>;
  readonly volumeFraction: number;
  readonly grey: number;
  readonly thresholdedVolume: number;
  readonly volumeUnit: string;
  readonly massG?: number;
  readonly history: readonly { it: number; compliance: number; volume: number; change: number }[]; // capped at 1000 rows
  readonly solver: {
    readonly job: 'topopt' | 'ts-reference';
    readonly version: string;
    readonly device: 'cpu' | 'gpu';
    readonly deterministic: boolean;
  };
  readonly unverified: boolean;
  readonly unverifiedReasons: readonly string[];
  readonly concept: true;
}
// Artifact (store, not document)
export interface TopologyField {
  readonly grid: TopologySummaryGrid;
  readonly xPhys: Float32Array;
  readonly x?: Float32Array;
}
```

Document version: rides the 05 `analysis` slice in the aerospace v3 envelope (01 KRN §3.1); no own migration.

## 4. Commands

Plugin `topology`, toolset `analysis`. ✱ = transport.

| Name                     | Kind                      | Params sketch                                                                                                                                                                                                                                                                                    | Tags                                                                                                                                                                                                                                                                                                                         |
| ------------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create_topology_study`  | mutating (requiresKernel) | `{ analysisId, name, designDomain: string[], dimension: 2\|3, plane?, voxel: number (doc length unit), volumeFraction: number (0–1), objective?: { kind:'min_compliance', loadCaseWeights? } }`                                                                                                  | @affects `analysis.cases[a].topology` · @invariant settings filled with named defaults; load/support faces added as keep-in (named default) · @failure analysis missing, domain not a solid, voxel count > cap (`TOP_GRID_TOO_LARGE`), volumeFraction ∉ (0,1) → no-op                                                        |
| `set_topology_regions`   | mutating                  | `{ studyId, keepIn?: TopologyRegion[], keepOut?: TopologyRegion[] }`                                                                                                                                                                                                                             | @failure region outside domain (`TOP_REGION_OUTSIDE_DOMAIN`), keep-in ≥ budget (`TOP_KEEPIN_EXCEEDS_BUDGET`)                                                                                                                                                                                                                 |
| `set_topology_settings`  | mutating                  | `{ studyId, penal?, eminRatio?, move?, changeTol?, maxIterations?, filter?: { kind, radius? (doc length unit) }, threshold?, greyLimit?, protectLoadSupport?: boolean, optimizer?, manufacturing? }`                                                                                             | @invariant p ∈ [1, 5], 0 < move ≤ 1, radius > 0 · each given value stored `defaulted: false`                                                                                                                                                                                                                                 |
| `delete_topology_study`  | mutating                  | `{ studyId }`                                                                                                                                                                                                                                                                                    | removes study and its derived entity                                                                                                                                                                                                                                                                                         |
| `record_topology_result` | mutating (validated)      | `{ studyId, fieldHash }`                                                                                                                                                                                                                                                                         | @affects `study.result`, regenerates `derivedEntityId` · @invariant artifact exists, sha256 = hash, summary recomputed from the artifact, inputHash current · @failure `TOP_ARTIFACT_NOT_FOUND`, `TOP_SUMMARY_MISMATCH`, `TOP_RESULT_STALE` → no-op                                                                          |
| `topology_report`        | query                     | `{ studyId, historyRows?: integer }` → `data { state: 'unsolved'\|'solved'\|'stale'\|'missing', result, settings, manufacturing, provenance, concept: true, unverified }`                                                                                                                        | read-only                                                                                                                                                                                                                                                                                                                    |
| `suggest_rebuild`        | query                     | `{ studyId, plane?, offset?: number (doc unit), tolerance?: number (doc unit), minLoopArea?: number (doc unit²) }` → `data { plane, placement: { position, rotation }, loops: [{ points: [x,y][], orientation: 'outer'\|'hole', areaMm2 }], widthSamples: [{ at, widthMm }], enclosedFraction }` | @failure stale / missing result → `TOP_RESULT_STALE` / `TOP_RESULT_MISSING`                                                                                                                                                                                                                                                  |
| `compare_to_topology`    | query (requiresKernel)    | `{ studyId, entityId, iouTarget?: number, complianceRatioTarget?: number }` → `data { iou, volumeRatio, complianceRatio?, targets: { iou: NamedValue, complianceRatio: NamedValue }, status, codes[] }`                                                                                          | read-only                                                                                                                                                                                                                                                                                                                    |
| `check_topology`         | query                     | `{ studyId }` → `data { status, items: [{ code, severity, ids[], message, remediation }], reviewRequired }`                                                                                                                                                                                      | AF-20 readiness check                                                                                                                                                                                                                                                                                                        |
| ✱ `topology_solve`       | transport                 | `{ studyId, timeoutS?: number (default 1800), resumeFromLast?: boolean }`                                                                                                                                                                                                                        | builds the grid, transfers 05 loads/supports and E/ν (E, ν resolved from the 08 record through core PHY-01 `resolvePropertyModel` / 08 preferred values, the same resolution 05's `FeaMaterialView` uses), runs `llull-compute topopt` with progress per iteration, stores the artifact, dispatches `record_topology_result` |

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

| Default                 | Value                                 | Source                                                      |
| ----------------------- | ------------------------------------- | ----------------------------------------------------------- |
| p                       | 3                                     | reference code default call [R1]                            |
| Emin / E0               | 1e-9                                  | [R1]                                                        |
| move                    | 0.2                                   | [R1]                                                        |
| stop                    | max \|Δx\| ≤ 0.01                     | [R1]                                                        |
| filter radius           | 1.5 voxel                             | [R1] default call rmin = 1.5                                |
| maxIterations           | 300                                   | llull choice                                                |
| threshold               | 0.5                                   | llull choice                                                |
| grey limit              | 0.1                                   | llull choice                                                |
| IoU target              | 0.85                                  | llull choice (to calibrate on the production scenario, §11) |
| compliance-ratio target | 1.15                                  | llull choice (to calibrate)                                 |
| DOF cap (native job)    | per device, TBD — measure (VC-TOP-34) | llull choice after measurement                              |
| PCG residual tolerance  | 1e-10 relative                        | llull choice                                                |

### 5.7 Numerical tolerances

| Item                        | Value                                                                                                           |
| --------------------------- | --------------------------------------------------------------------------------------------------------------- |
| MBB compliance vs generator | 1e-6 relative (the native job uses an iterative solver; generator vs topoptlab agree to 1e-10)                  |
| Iteration count             | exact for the pure TS reference; ±2 for the native job (different solver rounding can shift the stop iteration) |
| KE entries                  | 1e-12 relative                                                                                                  |
| Contour simplification      | ≤ tolerance (Hausdorff, tested)                                                                                 |

## 6. Interop & persistence

| Item              | Format                                                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Study             | `analysis.cases[a].topology` in the `.llull` document                                                                               |
| Density field     | gzip JSON / binary in `FeArtifactStore` (`<sha256>.topo.json.gz`)                                                                   |
| Derived mesh      | regenerated on load; never written into STEP / release packages (TR-TOP-12)                                                         |
| Export for review | `export_stl` of the derived mesh allowed with a `concept` comment line; VTK image data of the field via `llull-compute topopt` (V1) |

## 7. CLI / MCP / UI surfaces

- **CLI**: registry commands as `llull <command>`; `topology_solve` like `fea_solve` (`--progress`, `--timeout`,
  resumable). `llull guide` gains a topology section: units, minimal plan, rebuild recipe, end with `check_topology`.
- **MCP**: toolset `analysis`; `topology_solve` only where `llull-compute` is installed (RS1: MCP is being removed; the CLI is the path).
- **UI**: `src/ui/panels/analysis/TopologyPanel.tsx` (settings, history plot, threshold slider), viewport overlay for
  the field and the rebuild deviation. Review only.

### 7.1 Stable error and check codes (AF-11)

| Code                          | Severity                   | When                                                                                              | Offending ids / path   | Remediation                                         |
| ----------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------- | --------------------------------------------------- |
| `TOP_ANALYSIS_MISSING`        | error                      | analysisId unknown                                                                                | path                   | create the 05 analysis first                        |
| `TOP_DOMAIN_INVALID`          | error                      | design domain empty or not a solid                                                                | entity ids             | pass solid entity ids                               |
| `TOP_GRID_TOO_LARGE`          | error                      | voxel count or DOFs above cap                                                                     | count, suggested voxel | increase `voxel`                                    |
| `TOP_VOLUME_FRACTION_INVALID` | error                      | ∉ (0, 1)                                                                                          | path                   | e.g. 0.7 for 30 % lighter                           |
| `TOP_REGION_OUTSIDE_DOMAIN`   | error                      | region does not intersect the domain                                                              | region index           | move the region                                     |
| `TOP_KEEPIN_EXCEEDS_BUDGET`   | error                      | keep-in volume ≥ budget                                                                           | volumes                | raise volumeFraction or shrink keep-in              |
| `TOP_TARGET_UNMAPPED`         | error                      | 05 load/support maps to no voxel node                                                             | 05 id                  | refine voxel or move the target                     |
| `TOP_LOAD_OUTSIDE_DOMAIN`     | error                      | load face outside the domain                                                                      | 05 id                  | include the face in the domain                      |
| `TOP_SETUP_INVALID`           | error                      | under-constrained (05 `FEA_UNDERCONSTRAINED`), no load case                                       | ids                    | add supports / loads                                |
| `TOP_FILTER_TOO_SMALL`        | warning                    | radius < 1 voxel                                                                                  | study id               | radius ≥ 1.5 voxel                                  |
| `TOP_NOT_CONVERGED`           | warning                    | `max_iterations`                                                                                  | study id               | raise the cap or relax the stop                     |
| `TOP_GREY_HIGH`               | warning                    | grey > greyLimit                                                                                  | study id               | density filter + projection (V1), larger p          |
| `TOP_RESULT_MISSING`          | error                      | no result / artifact absent                                                                       | study id               | `topology_solve`                                    |
| `TOP_RESULT_STALE`            | error                      | inputHash or settingsHash changed                                                                 | study id               | re-run `topology_solve`                             |
| `TOP_ARTIFACT_NOT_FOUND`      | error                      | record: hash not in store                                                                         | hash                   | run the transport                                   |
| `TOP_SUMMARY_MISMATCH`        | error                      | record: summary ≠ recomputed                                                                      | fields                 | same                                                |
| `TOP_DERIVED_READ_ONLY`       | error                      | an edit touches the derived mesh                                                                  | entity id              | rebuild with ordinary commands                      |
| `TOP_REBUILD_MISSING`         | warning                    | solved study without a compared rebuild                                                           | study id               | `suggest_rebuild`, rebuild, `compare_to_topology`   |
| `TOP_REBUILD_DEVIATION`       | fail                       | IoU < target or compliance ratio > target                                                         | entity id, values      | follow the contours more closely                    |
| `TOP_REBUILD_NOT_ANALYSED`    | warning                    | rebuild has no current 05 result                                                                  | entity id              | run 05 on the rebuild                               |
| `TOP_INPUT_UNVERIFIED`        | warning (not suppressible) | E/ν from an `unverified` 08 value                                                                 | material               | replace with a verified value                       |
| `TOP_RESULT_NOT_RELEASABLE`   | error                      | release includes a topology-derived item                                                          | entity id              | release the rebuilt part instead                    |
| `TOP_TOOL_MISSING`            | error                      | `llull-compute` absent and the grid is above the TS reference cap (generic `NATIVE_TOOL_MISSING`) | tool                   | desktop bundle / install hint, or a coarser 2D grid |
| `TOP_SOLVER_FAILED`           | error                      | native job error / singular system / PCG not converged                                            | log tail               | check supports and keep-out regions                 |
| `TOP_SOLVER_TIMEOUT`          | error                      | timeout                                                                                           | study id               | coarser voxel, `resumeFromLast`                     |

### 7.2 Agent-first compliance

| AF          | Where                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| AF-01…05    | registry commands, descriptions with units, guide section, plan in `validation/plans/`                  |
| AF-10/12/13 | unit-bearing `data`; field via artifact store, images via `render_view --save`; determinism (FR-TOP-18) |
| AF-11       | §7.1                                                                                                    |
| AF-20/21/22 | `check_topology`; report numbers; `render_view` field overlay                                           |
| AF-23       | VC cases through `run_benchmarks` (PHY-00)                                                              |
| AF-30/31    | §5.6 named defaults                                                                                     |
| AF-32/33/34 | `unverified`; `concept`, never releasable; release of the rebuild via 05/09 human gates                 |
| AF-35/36    | `provenance` (formulation, settings, solver versions); owner summary                                    |
| AF-40/41/42 | progress, timeout, resume, cache; `TOP_TOOL_MISSING`; `--dry-run` on set-up                             |

## 8. Performance & robustness budgets

| Budget                         | Target                                                                                                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2D 60×20 MBB (native job)      | ≤ 10 s total (stdlib generator: ~25 s per run on a laptop, measured 2026-10-15) — measured 2.1 s (sensitivity) / 3.2 s (density), §13.5: met                   |
| 2D 300×100                     | ≤ 60 s — measured 52 s for the 300-iteration cap on 4 cores (VC-TOP-12, §13.5): met                                                                            |
| 3D 100k voxels, 100 iterations | ≤ 10 min on the CPU twin (Jacobi PCG) — measured 2.6 min for 74×37×37 = 101 306 voxels with the default multigrid PCG (§13.5): met; Jacobi PCG not re-measured |
| 3D largest grid per device     | target ≥ 1e7 DOF on a desktop GPU with geometric multigrid, wall time recorded — TBD measure (VC-TOP-34)                                                       |
| Derived mesh                   | ≤ 2 s for 100k voxels (marching cubes, TS)                                                                                                                     |
| Memory                         | field ≤ 4 bytes / voxel in the document process; solver in the `llull-compute` child process (matrix-free: no assembled stiffness)                             |

## 9. Test strategy (VC mapping)

| Layer                                                                     | Tests                                                                                                                                                      | VC                 |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Unit core (`tests/unit/lib/topology.test.ts`)                             | KE, filter weights, OC separable problem, SIMP scaling, MBB 30×10 and 60×20 with the pure TS reference                                                     | 01–04, 10, 11      |
| Unit plugin (`tests/unit/physics/topology/*`)                             | every command happy/failure/`is pure`; guard; contours on synthetic fields; compare IoU on known shapes; release hook; unverified propagation              | 20–26              |
| Golden                                                                    | `validation/plans/top_mbb_60x20.plan.json` once commands exist (study set-up replay)                                                                       | 21                 |
| Native (`npm run native:check`: `cargo test` in `solver/`)                | `llull-voxfe` patch tests, KE, filter, OC; CPU twin vs GPU kernels where an adapter exists (skip logged otherwise); native vs TS reference on the 2D grids | 01–04, 33          |
| Integration (`server/tests`, needs `llull-compute`; CI uses the CPU twin) | native job MBB vs expected; determinism; resume; scaling measurement                                                                                       | 10, 11, 12, 27, 34 |
| Quality gate                                                              | `npm run quality:physics` runs VC-TOP-10/11 through `run_benchmarks`                                                                                       | 10, 11             |
| Production gate (V1)                                                      | "make the bracket 30 % lighter" agent scenario                                                                                                             | 23                 |

## 10. Delivery plan

| M       | Content                                                                                                                                                                   | Depends on                                                                                         | Effort |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------ |
| M1      | Types, plugin skeleton, study commands, pure `@lib/topology.ts` reference, VC 01–04, 10, 11 in unit tests                                                                 | 05 FEA M1 (AnalysisCase, targets)                                                                  | 2 w    |
| M2      | Native job `llull-compute topopt` (2D Q4, Jacobi PCG, CPU twin first), grid/targets mapping, `topology_solve`, record + artifact, report, derived mesh + guard, VC-TOP-33 | M1, 05 M2–M3 (artifact store), RS-0 (`solver/` workspace, `llull-gpu`, `llull-protocol`, bundling) | 3 w    |
| M3      | `suggest_rebuild`, `compare_to_topology`, `check_topology`, release hook, 3D H8, wgpu kernels, geometric multigrid, VC-TOP-34                                             | M2, 09 PLM release                                                                                 | 4 w    |
| M4 (V1) | MMA (licence decision), projection, extrusion constraint, min member size, shape optimisation via PHY-18                                                                  | PHY-18 M2                                                                                          | 3 w    |

## 11. Open questions / decisions needed

1. **MMA implementation licence**: mmapy is GPL-3.0; NLopt's Python wheel is listed as MIT on PyPI but NLopt itself
   mixes licences. Port MMA from the published algorithm (Svanberg 1987) into llull, or use NLopt as a separate
   process? Proposal: own port in V1, in Rust inside `llull-topopt`.
2. ~~**numpy + scipy in the desktop bundle**~~: closed by RS1 (2026-10-18); the solve no longer needs them. numpy / scipy stay only
   for the external topoptlab cross-check (§12 [R8]).
3. **Calibration of the rebuild targets** (IoU 0.85, compliance ratio 1.15): to be measured on the production scenario
   before they gate anything.
4. **Paper values**: the Andreassen et al. 2011 PDF and the DTU `top88.m` file were not reachable; the formulation
   was taken from the topoptlab transcription and confirmed by two independent implementations agreeing. A human
   should compare the pinned 60×20 values with `top88.m` output in MATLAB/Octave once (closes VC-TOP-10.a/11.a to A).
5. **Unstructured SIMP on the 05 tet mesh** (V1) vs voxels only: voxel grids are simpler and deterministic; tets follow
   the boundary. Proposal: voxels for MVP.
6. **Shape optimisation via CalculiX** `*SENSITIVITY` (node coordinates) vs parameter finite differences (PHY-18):
   the latter keeps the CAD parametric; CalculiX gives cheaper gradients for many variables. Decide in V2.
7. **GPU precision and multigrid design** (RS1): whether the GPU kernels store f32 with f64 accumulation or f64 throughout
   (not all adapters support f64), and the multigrid hierarchy (coarsening of inactive voxels, smoother). Decide on the VC-TOP-33 /
   34 measurements; until then the CPU twin is the recorded path.
   **Decided 2026-10-19 (RS-2 as built, §13):** the f64 Rust-CPU twin is the recorded path (`deterministic: true`); the GPU stores
   and computes in f32 (no f64 requirement on adapters) inside f64 iterative refinement on the CPU, as the exploration path
   (`deterministic: false`). Multigrid (§13.3, revised by the RS-2 performance pass the same day): Galerkin V-cycle with a
   Chebyshev smoother as the PCG preconditioner on both paths, run in f32 (the CPU twin's PCG, residual and answer stay f64);
   on the GPU the V-cycle preconditions the f32 inner PCG of the refinement.

## 12. References

- [R1] Andreassen et al. 2011, Struct. Multidisc. Optim. 43:1–16, doi:10.1007/s00158-010-0594-7 — https://www.topopt.mek.dtu.dk/apps-and-software/efficient-topology-optimization-in-matlab (search extract; host blocked)
- [R2] Sigmund 2001, Struct. Multidisc. Optim. 21:120–127 (cited by [R1], [R4]; not opened)
- [R4] topoptlab 1.0.0, GPL-3.0 — https://pypi.org/project/topoptlab/1.0.0/ (sdist sha256 4978a92ad52afff9f9211ae4da8a5901d9b7e5abc43b8463a9b03f77ff5c090e; read and run as an external cross-check)
- [R5] ToPy, MIT — https://github.com/williamhunter/topy (commit 3c461c4b65c0f5f0c5476a4711a26a7e1ff64e58)
- [R6] topopt (Python), MIT — https://github.com/zfergus/topopt (commit c3d3bd546327732b72ea3862d0283b324b25422f)
- [R7] CalculiX manual — https://github.com/Dhondtguido/CalculiX (commit fd588701edd6a92fde06e99b1bdf01f3b0f80f2c), `doc/CalculiX.tex` §\*DESIGN VARIABLES
- [R8] SciPy 1.18.1 (licence text: BSD-style, "Copyright (c) 2001-2002 Enthought, Inc. 2003, SciPy Developers"), NumPy 2.5.4 (PyPI licence expression `BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0`) — https://pypi.org/project/scipy/ , https://pypi.org/project/numpy/ (metadata read; SciPy wheel downloaded for the cross-check)
- [RS1] Native compute programme — [`../../decisions/RS1-native-compute.md`](../../decisions/RS1-native-compute.md) (step RS-2)
- llull: `.claude/rules/architecture.md` (L8, L9, L10), `packages/core/src/commands/derivation.ts`, `packages/core/src/plugins/plugin.ts`, `packages/domain-aec/src/shared/derived.ts`, 05 FEA TECHNICAL_SPEC.

## 13. As built: native job `llull-compute topopt` (RS-2, 2026-10-19)

Crates (RS1 §2): `solver/crates/llull-gpu` (wgpu device selection shared with `llull-raster`, buffer helpers, fixed-order
reductions with CPU twins), `solver/crates/llull-voxfe` (matrix-free voxel FE), `solver/crates/llull-topopt` (SIMP loop + job).
All three are workspace default-members, so `npm run native:check` (fmt, clippy `-D warnings`, test) covers them. The wgpu kernels
are behind cargo features (`llull-voxfe/gpu`, `llull-topopt/gpu`, on by default in the crates so the GPU tests compile and run in
`native:check`; `llull-compute --features gpu` for the binary, off by default like the raster GPU path, which keeps
`cargo build --profile compute -p llull-compute` free of wgpu, ~75 s on 4 cores).

### 13.1 Job contract

The authoritative schema is the module doc of `solver/crates/llull-topopt/src/job.rs`; summary:

| File                | Direction | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `job.json`          | in        | `version: 1`, `dimension: 2\|3`, `grid {nx, ny, nz?, voxel}`, `material {e0, nu}`, `thickness` (2D), `volumeFraction`, optional mask files `active` / `keepIn` / `keepOut` (u8 per voxel), `fixed [{node:[i,j(,k)], dofs:[c…]}]` + optional `fixedDofs` (u8 per DOF), `loadCases [{name, weight, loads:[{node, force}], forces?: f64 file}]`, `settings {penal, eminRatio, move, changeTol, maxIterations, filter {kind, radius (voxels)}, device cpu\|gpu\|auto, solver multigrid\|jacobi, pcgTolerance, pcgMaxIterations, ocTolerance}` (all optional, §5.6 defaults), optional `startDesign` (f64 x per voxel), optional `startDisplacements` (f64, load cases × DOFs: the warm start of the first solves), optional `dofCap` |
| `field.bin`         | out       | xPhys, little-endian f32 per voxel, voxel index `i + nx(j + ny k)` (x fastest, y up), inactive = 0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `design.f64`        | out       | design variables x, little-endian f64 (resume input `startDesign`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `displacements.f64` | out       | per load case (in `loadCases` order) the displacements of the last iteration's solve, little-endian f64, load cases × DOFs (resume input `startDisplacements`: with both files a resumed run continues bit for bit; with `startDesign` alone, to the PCG tolerance)                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `result.json`       | out       | `version`, `status`, `iterations`, `compliance` (final xPhys, weighted), `lastIterationCompliance` (top88's printed value), `perLoadCase`, `volumeFraction`, `grey`, `history [{it, compliance, volume, change}]` (every iteration; the host caps at 1000 rows), `device`, `deterministic`, `precision`, `adapter?`, `solver {kind, tolerance, pcgIterations}`, `grid {dimension, nx, ny, nz, voxel, elements, active, keepIn, keepOut, dofs}`, `settings` (resolved), `field`, `design`, `displacements`, `fieldSha256`, `warnings [{code, message}]`                                                                                                                                                                           |

Events on stdout (`llull-protocol` NDJSON): one `progress` per iteration carrying `it`, `compliance`, `volume`, `change` next to
`step` / `total` / `message`; `warning` `TOP_GPU_FALLBACK`; `done` with `outputs [{path, sha256}]`; or `error` with
`NATIVE_JOB_IO`, `NATIVE_JOB_INPUT`, `TOP_GRID_TOO_LARGE`, `TOP_SOLVER_FAILED`. Inactive voxels are removed (§5.4), keep-in /
keep-out are pinned in x and xPhys, the volume budget counts keep-in (`Σ xPhys ≤ volumeFraction · active`). Units are not
converted (consistent units: MPa, mm, N → N·mm).

### 13.2 Numerics

- Elements: top88 Q4 KE (closed form, VC-TOP-01 to 1e-12) scaled by E·t; H8 by 2×2×2 Gauss scaled by E·h (diagonal
  `(2−3ν)/(9(1+ν)(1−2ν))`, coupling `1/(24(1+ν)(1−2ν))`, six rigid modes, tested to 1e-12 / 1e-14).
- Mat-vec (`llull-voxfe` `scatter`): element products `s_e KE u_e` (all rows at once, each summed in element-DOF order, the
  element's nodes in memory order along the row so `u_e` is read and the product added back as 2 / 4 contiguous runs), scattered
  in two colours of element slabs (one element row in 2D, one element plane in 3D; a slab is one sequential task, the even slabs
  run in parallel, then the odd ones). No atomics, no product buffer: bit-identical for any thread count (tested 1 / 3 / 4
  threads). The WGSL kernel gathers the same terms per node in f32.
- PCG: relative residual 1e-10 in f64; each solve starts from that load case's displacements of the previous SIMP iteration
  (warm start: about a quarter fewer iterations on MBB 300×100); dots via fixed-chunk reductions, the `x`, `r`, `r·r` update in
  one pass. `TOP_SOLVER_FAILED` on pᵀKp ≤ 0 (singular: unsupported body), non-finite values or `pcgMaxIterations` (default
  10 000).
- Filters as fixed-stencil convolutions (half-width ⌈rmin⌉ − 1), OC exactly as §5.2 with `ocTolerance` 1e-3.

### 13.3 Multigrid

Geometric V-cycle as the PCG preconditioner (default `solver: multigrid`), `llull-voxfe` `multigrid` / `galerkin` / `transfer`:

- Hierarchy: axes halved (rounded up) per level until ≤ 256 free DOFs; the coarsest level is solved with a dense f64 Cholesky
  factor. Coarse operators are Galerkin, `K_c = Pᵀ K P`, stored as one matrix per coarse element (bilinear / trilinear P
  interpolates inside one coarse element, so `Pᵀ K P` is a sum of coarse element matrices: `Σ_c s_c P_cᵀ KE P_c` from the fine
  scales, the triple product of the stored child matrices below). Exact for any contrast, unlike averaging the element scales
  (which it replaced: 10–15 % fewer PCG iterations on optimised designs). Memory: ND² values per coarse element (f32), about
  1/8 · 576 · 4 B = 288 B per fine voxel in 3D for level 1.
- Transfer: bilinear / trilinear prolongation P, restriction R = Pᵀ, separable and row by row (fixed order); a coarse DOF is
  fixed when a fine fixed DOF of the same component lies in its support.
- Smoother: Chebyshev, degree 2 before and after the coarse correction, on [λ̂/6, λ̂] with λ̂ = 1.1 × a 10-step power-iteration
  estimate of λmax(D⁻¹K) per level (damped Jacobi ω = 4/(3λ̂) stays selectable). The same polynomial before and after, so the
  V-cycle is symmetric; the pre-smoother starts from zero and hands its residual to the restriction (ν mat-vecs per pass).
- Precision: the V-cycle is generic over f32 / f64; `llull-topopt` runs it in f32 (half the memory traffic, twice the SIMD lanes)
  inside the f64 PCG, which keeps the 1e-10 residual and the f64 answer (same PCG iteration count as an f64 V-cycle on the MBB
  300×100 and 3D cantilever designs; +33 % on the 24×12×12 soft-layer test case). Every step is element-wise, a fixed-order
  gather / scatter or a fixed-order dot: bit-identical for any thread count (tested).
- Per SIMP iteration the hierarchy is updated in place (scales, Galerkin matrices, diagonals, λ̂, coarse factor), shared by all
  load cases.
- GPU (`gpu_multigrid`): the CPU-built f32 hierarchy is mirrored to wgpu buffers (allocated once, rewritten per iteration) and the
  V-cycle (Galerkin element-matrix mat-vec, restriction / prolongation, Chebyshev or Jacobi smoothing, the coarsest level as a dense
  f32 mat-vec with the f64-computed inverse) is recorded into the f32 PCG's command encoder without host round trips. It
  preconditions the f32 inner PCG of the f64 refinement (VC-TOP-33).

On the solver test cantilever (24×12×12, a soft layer at 1e-3) multigrid PCG needs 53 iterations against 337 for Jacobi PCG
(tested: < 1/3).

### 13.4 Validation as run (`cargo test` in `solver/`)

| VC                      | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VC-TOP-01 / 02 / 03     | KE, filter weights, separable OC (bisection 1e-12: x = [0.2, 0.4, 0.6, 0.8] to 1e-6; at the production 1e-3: 6e-4 relative)                                                                                                                                                                                                                                                                                                                                                                              |
| VC-TOP-04               | 30×10 solid compliance 123.069351174 (1e-9, Jacobi and multigrid) and c(0.5)/c(1) (1e-8), also through the job's first iteration                                                                                                                                                                                                                                                                                                                                                                         |
| VC-TOP-10               | MBB 60×20 sensitivity filter: 94 iterations (exact), last-iteration compliance 203.192457640 (Δ 5e-12 rel), final 203.182593257, volume 0.4999701, grey 0.1741755; density digits vs `mbb_60x20_sensitivity.txt` (after the RS-2 performance pass: warm-started f32-V-cycle PCG, 2 345 PCG iterations in total instead of 3 619)                                                                                                                                                                         |
| VC-TOP-11               | density filter: 127 iterations (exact), 218.803221068 (Δ 2e-11 rel), final 218.815227560, grey 0.2683235; digits vs `mbb_60x20_density.txt`                                                                                                                                                                                                                                                                                                                                                              |
| VC-TOP-27 (crate level) | two runs and 1 / 3 / 4 threads: identical `field.bin`, `design.f64`, `displacements.f64`, `result.json` bytes; f32 V-cycle MG-PCG on a 32×16×16 cantilever: identical bits for 1 / 2 / 3 / 4 threads                                                                                                                                                                                                                                                                                                     |
| VC-TOP-31 (crate level) | resume from iterate 12 (`design.f64` → `startDesign`, `displacements.f64` → `startDisplacements`) = uninterrupted 30-iteration run, bit for bit (`design.f64`, `field.bin`, `displacements.f64`); `startDesign` alone: final compliance within 1e-6                                                                                                                                                                                                                                                      |
| VC-TOP-33 (GPU part)    | GPU vs CPU twin on lavapipe (software Vulkan): mat-vec 6e-8 / 8e-8 relative (2D / 3D), vector ops and fixed-order dot 1e-6, f32 PCG + f64 refinement to 1e-12, topopt `device: gpu` compliance within 1e-6 of the CPU run. GPU V-cycle as the f32 PCG preconditioner (to 1e-4): 2D 40×24 736 → 48 iterations, 3D 16×8×8 193 → 8 (tested: < 1/4 of Jacobi's), refinement to 1e-10 matching the CPU solve to 1e-7, in-place update after new scales. Skips with the logged reason where no adapter exists. |

### 13.5 Measurements (VC-TOP-12, VC-TOP-34; 2026-10-19)

Machine: 4-core x86-64 cloud container (Xeon 2.8 GHz, SSE2 baseline build, no `target-cpu`), 16 GB RAM, shared with other
agents' jobs (load average 2.5–3.5 during the runs; the first RS-2 measurements ran next to an OCCT build at load 10–30, so the
"before" column was re-run under the same conditions as the "after" column where marked). Binary: `cargo build --profile compute`;
bench: `cargo test --release -p llull-topopt --test scaling -- --ignored --nocapture` (3D cantilever `2n × n × n`, density
filter rmin 1.5, volume fraction 0.3, multigrid PCG 1e-10, from the uniform start) and `cargo test --release -p llull-voxfe
--test solve -- --ignored --nocapture` (one solve of a cantilever with a soft layer).

| Case                                                 | Device                   | DOFs           | Before (RS-2 as first built)                                                                                                   | After (performance pass)                                                                                                   |
| ---------------------------------------------------- | ------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| MBB 60×20 sensitivity (VC-TOP-10)                    | CPU                      | 2 562          | 3.3 s total (4.0 s re-run, release build), 94 iterations, 3 619 PCG iterations                                                 | 2.1 s, 94 iterations, 2 345 PCG iterations (budget ≤ 10 s: met)                                                            |
| MBB 60×20 density (VC-TOP-11)                        | CPU                      | 2 562          | 4.8 s                                                                                                                          | 3.2 s, 127 iterations                                                                                                      |
| MBB 300×100 sensitivity (VC-TOP-12)                  | CPU                      | 60 802         | 300 iterations in 496 s (OCCT build alongside); **280 s** re-run under the same load as the "after" run; 26 559 PCG iterations | **52 s**, 16 708 PCG iterations (budget ≤ 60 s: met); same history (final compliance 189.4953399, Δ 6e-11 rel)             |
| cantilever 74×37×37 (101 306 voxels), 100 iterations | CPU                      | 324 900        | **567 s** (re-run, 74 PCG iterations / solve)                                                                                  | **157 s** (41 PCG iterations / solve; budget "100k voxels, 100 iterations ≤ 10 min": met)                                  |
| cantilever 20×10×10, 5 iterations                    | CPU                      | 7 623          | 0.18 s / iteration, 28 PCG iterations / solve                                                                                  | 0.076 s, 18                                                                                                                |
| cantilever 40×20×20, 5 iterations                    | CPU                      | 54 243         | 1.8 s, 33                                                                                                                      | 0.26 s, 21                                                                                                                 |
| cantilever 60×30×30, 5 iterations                    | CPU                      | 175 863        | 7.7 s, 36                                                                                                                      | 0.76 s, 25                                                                                                                 |
| cantilever 80×40×40 (128k voxels), 5 iterations      | CPU                      | 408 483        | 18.8 s, 38                                                                                                                     | 1.53 s, 25                                                                                                                 |
| one solve, cantilever 120×60×60 with a soft layer    | CPU                      | 1 350 723      | mat-vec 0.18 s, MG build 2.2 s (6 levels), 117 PCG iterations in 131 s                                                         | mat-vec 15 ms, build 0.45 s, 96 iterations in 10.7 s (f32 V-cycle; f64 V-cycle: 96 in 15.2 s)                              |
| cantilever 20×10×10 / 40×20×20, 3 iterations         | GPU (lavapipe, software) | 7 623 / 54 243 | 5.7 s / 62 s per iteration (f32 Jacobi PCG, 580 / 1 130 inner iterations per solve)                                            | 1.2 s / 5.3 s (V-cycle PCG, 21 / 25 inner iterations per solve): correctness and iteration counts only, not a speed figure |

Where the time went (MBB 300×100, from callgrind and A/B runs): the mat-vec's inner loop summed each KE row as a dependent
chain (latency-bound; loop interchange made it vectorise, same bits), a separate gather pass and product buffer (replaced by the
two-colour slab scatter), weak coarse operators and Jacobi smoothing (Galerkin + Chebyshev: 20–30 % fewer PCG iterations on the optimised designs),
cold PCG starts (warm start; together 26 559 → 16 708 PCG iterations), the V-cycle in f64 (f32: −45 % single-thread time, same iteration count), and rayon
synchronisation: with ~100 parallel regions per PCG iteration on a 60k-DOF problem, small minimum task sizes (keeping the pool
busy) and fused passes beat running small levels inline (which put the workers to sleep and was 1.5× slower).

Caps (`solver/crates/llull-topopt/src/job.rs`): **CPU 1.5e6 DOF** kept (`device: cpu`; one cold solve at 1.35e6 DOF now takes
about 11 s, so 100 iterations take roughly 15–20 min with warm starts), **GPU 1e7 DOF provisional** (`device: gpu | auto`; no
hardware adapter measured; the GPU path now has the multigrid V-cycle; level-1 Galerkin matrices take about 288 B per voxel of
GPU memory in 3D). `job.json` `dofCap` overrides. Next: measure on a desktop GPU (VC-TOP-34), MMA (V1).

## 14. As built (RS-2 TypeScript side, M1 + TS parts of M2 / M3)

**Placement (Proposal B).** Types in core `model/topology.ts` (study, settings, summary, `FeTopologyArtifact`; `AnalysisCase.topology` / `topologyOrder` and the `FeArtifactPort` union extended in `model/analysis.ts`), pure reference in core `lib/topology.ts` + `lib/bandedCholesky.ts`, plugin `topology` in `packages/domain-cae/src/topology/` (`plugin`, `catalog`, `studyCommands`, `record`, `reportQuery`, `rebuildQueries`, `checkQuery`, `job`, `artifact`, `trust`, `voxel`, `mapping`, `regions`, `contours`, `derive`, `guard`, `hash`, `material`).

**Commands** (all registered, toolset `analysis`): `create_topology_study`, `set_topology_regions`, `set_topology_settings`, `delete_topology_study`, `record_topology_result`, `topology_report`, `suggest_rebuild`, `compare_to_topology`, `check_topology`.

**Deviations from the plan above**

- No `requiresKernel`: the design domain is voxelised from the world triangles of the entities already in the document (`entityToTriangles`, mesh entities carry their tessellation), so set-up and replay need no kernel.
- `record_topology_result` takes `{ studyId, fieldHash, summary? }`. The summary is always recomputed from the artifact; a given `summary` must equal it (TOP*SUMMARY_MISMATCH). Without the artifact a given summary is kept flagged `verified: false` (state `missing`), like `record_fe*\*`, so replay on another machine works; without a summary it is TOP_ARTIFACT_NOT_FOUND.
- The artifact is JSON (the store is JSON): `{ kind: 'fe_topology', inputHash, settingsHash, grid { nx, ny, nz, active, keepIn, keepOut, dimension, plane?, voxel, origin, thickness }, xPhys (base64 of the float32 LE `field.bin`, x fastest), compliance, perLoadCase, iterations, status, history, solver { job, version, device, deterministic } }`, hashed as `sha256(canonicalJson(artifact))`. The transport builds it with `buildTopologyArtifact(job, fieldBytes, result.json, 'topopt')`.
- The `ts-reference` path is NOT a command (a command cannot write the read-only artifact store and an agent could otherwise inject an optimum): the transport calls `runTopologyReference(job)` for 2D jobs up to `TS_REFERENCE_MAX_ELEMENTS` (2000) voxels, stores the artifact and dispatches `record_topology_result`.
- Iso-surface: marching tetrahedra (Kuhn split, welded, outward oriented) instead of marching cubes (no 256-case table); 2D is the extruded marching-squares contour. Both pad the field with zeros so the surface is closed. The mesh is omitted from saved files; `restore` cannot read the artifact store, so it only drops the id from order / selection and the surface is derived again by `record_topology_result` (replay) on a machine that holds the artifact (`topology_report.derivedGeometry` says `absent`).
- Settings that change the field (everything but `greyLimit`, plus `threshold`) are in `settingsHash`; domain geometry, material E / nu, idealization, study definition, constraints and loads (names excluded) are in `inputHash`.
- 05 mapping: only `force` loads (pressure, gravity, moments are TOP_SETUP_INVALID), displacement constraints with value 0, `symmetry` needs a `facesNear` point on an axis-aligned face. 05 `plane_stress` idealization is not built (FEA_IDEALIZATION_UNSUPPORTED): the validation plans run with `solid` and the study takes the thickness from the domain extent (or the `plane_stress` thickness when that idealization exists).
- TR-TOP-12: no PLM release extension point exists; `check_topology` takes `release: [entityIds]` and reports TOP_RESULT_NOT_RELEASABLE for topology-derived ids. `rebuildEntityIds` feeds TOP_REBUILD_MISSING / DEVIATION / NOT_ANALYSED.
- Added code `TOP_STUDY_NOT_FOUND`.

**Transport `topology_solve` (as built, `server/src/native/topologySolve.ts` + `topologyJobFiles.ts`, registered in `native/tools.ts` next to `fatigue_field`; toolset `analysis`; CLI `llull topology_solve studyId=ID [timeoutS=1800] [resumeFromLast=true] [device=cpu|gpu|auto] [--progress]`, `--doc` / `--app` / `--server` via `POST /exchange`).** `buildTopologyJob` -> job folder (`job.json`, `active.u8` / `keep_in.u8` / `keep_out.u8`, `fixed.u8` (one byte per dof), `lc<k>.f64` (dense dof forces per load case); the index conventions of the TS job and the native job are identical: voxel `i + nx(j + ny k)`, node `i + (nx+1)(j + (ny+1)k)`, dof `node * dim + c`, y up; units are not converted: E in the stress unit of the analysis unit system, thickness and the voxel size (converted from document units) in its length unit, forces in its force unit) -> `llull-compute topopt` (`NativeDeps.onProgress`: one stderr line per iteration with `--progress` / on a terminal; hard timeout `timeoutS`, default 1800, clamped 1..86400) -> `field.bin` + `design.f64` + `result.json` (sha256 re-checked against the `done` event) -> `buildTopologyArtifact(job, field, output, 'topopt')` (solver version = `llull-compute --version`) -> `FeArtifactStore.put` (hash `sha256(canonicalJson(artifact))`, `fe_topology` artifacts are accepted by the store) -> `record_topology_result { studyId, fieldHash, summary }` with the summary from `topologySummary` (so a replay without the store keeps it unverified). Errors: job refusals keep their TOP\_\* code; native `TOP_GRID_TOO_LARGE` stays, every other native error (`TOP_SOLVER_FAILED`, `NATIVE_JOB_INPUT`, protocol) is `TOP_SOLVER_FAILED` and `NATIVE_TIMEOUT` is `TOP_SOLVER_TIMEOUT` (`data.nativeCode` keeps the job's code, `data.log` the stderr tail); no `llull-compute`: a 2D job up to `TS_REFERENCE_MAX_ELEMENTS` runs `runTopologyReference` (`solver.job: 'ts-reference'`), anything else is `TOP_TOOL_MISSING` (message carries `NATIVE_TOOL_MISSING` and the install hint, `data.nativeCode`). **Resume**: after every native run the design variables are kept under `<LLULL_FEA_CACHE>/topology-resume/` (one state per study: `design.f64`, inputHash, iterations so far, history); `resumeFromLast` passes them as `startDesign` when the inputHash and voxel count match (settings may change: a raised `maxIterations` is the use case; the cap counts the iterations already done, iterations and history of the artifact accumulate, resumed = uninterrupted bit for bit, tested through the transport) and otherwise starts from the uniform design and says so. A killed run (timeout) writes nothing: its work is lost (the native job has no checkpoint / deadline yet; a `deadlineS` setting writing `design.f64` on expiry would make a timeout resumable). Tested: `server/tests/topologySolve.test.ts` (fake runner: folder + mapping, artifact / record, TS reference, TOP_TOOL_MISSING above the cap, error / timeout mapping, resume), `topologySolveNative.test.ts` (real binary: MBB 60 x 20 last-iteration compliance 203.19245764 within 1e-6, 94 iterations, same `fieldHash` twice, resume = uninterrupted). The desktop bundle ships the same `llull-compute` (`desktop/scripts/prepare-native.mjs`).

**Compliance ratio and width samples (as built, TR-TOP-10 / TR-TOP-09).** `compare_to_topology` finds the first `static` 05 analysis that has the rebuilt solid as a part and reads it through `trustedRecord` (the 05 staleness hashes and artifact re-verification: only a `solved`, non-stale, artifact-verified result counts). The external work F^T u is rebuilt from the artifacts, because 05 records neither strain energy nor external work: the `fe_results` DISP field of each load case of the optimum, times the nodal forces of the case's `force` loads (the vector split over the nodes of the mesh node set `L_<loadId>`, `distribution: 'total'` | `'per_node'`, as the deck writer does). The weighted sum uses the study's load case weights (the optimum's own weighting); both values go to N\*mm (`N-mm-t-s` 1, `N-m-kg-s` 1000, `lbf-in-slinch-s` 112.98) and `complianceRatio = F^T u(rebuild) / c(optimum)`. It is checked against `complianceRatioTarget` (default `COMPLIANCE_RATIO_TARGET` = 1.15, named, to calibrate; >= 1 else TOP_SETUP_INVALID): above it is TOP_REBUILD_DEVIATION (status fail), within it with the IoU met is pass. With no usable result `complianceRatio` is null, `complianceStatus { available: false, code: 'TOP_REBUILD_NOT_ANALYSED', reason, message }` with `reason` one of `no_analysis | not_solved | stale | unverified | unsupported | optimum_zero` and the status is warn. `unsupported` = a load of the case that is not a nodal `force` (pressure, gravity, moment), a force without mesh nodes, a node without displacement, or a load case of the optimum missing in the rebuild analysis. `check_topology` raises the same two items per `rebuildEntityIds` entry (target fixed at the default). `suggest_rebuild.widthSamples`: an exact Euclidean distance transform (Felzenszwalb-Huttenlocher) of the section nodes at the threshold; local maxima at least one node from the void are the medial-axis candidates, thinned so none lies in a wider sample's inscribed disc (at most 200); `width` = 2 x the exact distance to the contour (document units, plus `widthMm`), widest first.

**Open** (after §15): compliance ratio of rebuilds loaded by moments and of face / body loads on non-tetrahedral meshes, `massG`, the per-device DOF
cap (`TOPOLOGY_VOXEL_CAP` is provisional; VC-TOP-34 on a desktop GPU not measured).

## 15. As built: V1 (TOP-V1, 2026-10-22)

§10 M4 without the PHY-18 shape optimisation (that needs PHY-18 M2) and without unstructured SIMP (§11.5: voxels stay). Native in
`solver/crates/llull-topopt` (`mma.rs`, `projection.rs`, `design.rs`, `loads.rs`, `solver.rs`; the loop in `simp.rs`, the contract in
`job.rs`), TypeScript in the plugin `topology` (`objectiveCommand.ts`, `loads.ts`, `rules.ts`, `studyCommands.ts`, `job.ts`,
`rebuildCompliance.ts`) and the transport (`server/src/native/topologySolve.ts`, `topologyJobFiles.ts`).

### 15.1 MMA (FR-TOP-22; §11.1 decided: own port)

Svanberg's method of moving asymptotes written from the 1987 paper with the asymptote / bound rules of his 2002 / 2007 notes (asyinit 0.5,
asyincr 1.2, asydecr 0.7, albefa 0.1, raa0 1e-5, asymptote floor 0.01 (xmax − xmin), relaxation cost c = 1000, d = 1; no GCMMA inner loop);
no GPL code. The separable subproblem is solved exactly through its dual (1987 §4): `x(λ)` closed form per variable, the concave dual maximised by
projected Newton with an Armijo line search on `λ ≥ 0` (exact Hessian from the primal curvature; a scaled gradient step where it is singular),
to a projected-gradient tolerance of 1e-11 relative. The move limit is the study's `move` (0.2 of the range). Every sum over the variables is a
fixed-order reduction: bit-identical for any thread count. The state (`low`, `upp`, `xold1`, `xold2`, step count) is written as `mma.f64` and
named by `state.json`, so a run resumes bit for bit (tested with projection on). Validation: MBB 60×20 sensitivity filter, MMA final
compliance **203.130** in 84 iterations against OC's 203.183 in 94 (0.03 % apart; the test allows 5 %), volume 0.49999811; the
Rust unit tests check the KKT point of a two-constraint problem (x* = (1, 0.5)) and the VC-TOP-03 separable optimum to 1e-6. **Known
property**: plain MMA homes in on a *free\* stationary point (no active constraint, e.g. an unconstrained quadratic) only to the asymptote floor
(a two-cycle 0.01 (xmax − xmin) wide) — the reason GCMMA exists; it does not arise with an active volume / compliance constraint.

### 15.2 `min_volume` (TopologyObjective V1) and the constraint report

`set_topology_objective { studyId, objective }` (new command) and `create_topology_study.objective` take `{ kind: 'min_volume', maxCompliance,
loadCaseWeights? }`; `maxCompliance` is in the analysis compliance unit (`COMPLIANCE_UNIT`, stored as `unit`). Both switch
`settings.optimizer` to `mma` (said in the summary); `set_topology_settings optimizer=oc` on such a study and a job built with OC are
`TOP_OPTIMIZER_MISMATCH` (OC handles the volume constraint only). Native: `objective { kind: minVolume, maxCompliance }`, f0 = Σ xPhys /
N_active, constraint `c / maxCompliance − 1 ≤ 0`; for `minCompliance` under MMA f0 = c / c₁ (the first iteration's compliance, kept in
`state.json` as `objectiveScale`) and `Σ xPhys / target − 1 ≤ 0`. `result.json` reports `objective { kind, value }` and `constraints [{ name,
value, limit, satisfied }]`; the artifact and the summary carry `optimizer`, `objective`, `constraints` (artifacts of earlier binaries get the
volume constraint derived from the field), `check_topology` fails with **`TOP_CONSTRAINT_VIOLATED`** on an unsatisfied one. Validation: MBB
30×10 density filter, `maxCompliance` = 1.5 × the OC optimum → volume fraction 0.393 at compliance 373.24131 against the limit 373.24186,
converged in 45 iterations.

### 15.3 Loads: pressure and gravity (§14 open item)

`job.ts` → `loads.ts`: a `pressure` maps like a force to the boundary nodes of its planar face group; its total `magnitude × face area`
(`mapTarget` now returns `faceArea`, the sum of the planar group's triangle areas, converted to the analysis length unit²) acts along the inward
normal, spread equally over those nodes (total preserved, tested: 2 MPa on the 20 mm² MBB edge = 40 N over 21 nodes); a face parallel to a 2D
plane is refused as before, a face whose normal leaves the plane is `TOP_SETUP_INVALID`. `gravity` needs the domain material's density
(`densityOf`, `densityToAnalysis`; none → `TOP_SETUP_INVALID`) and becomes the **force a fully solid voxel weighs** per load case,
`ρ · a · V_voxel` in the grid axes (`loadCases[].gravity`; several gravity loads of one case add up; an out-of-plane component on a 2D grid is
refused). Native (`loads.rs`): `F(x) = F_fixed + Σ_e xPhys_e f_e`, `f_e = g / nodes_per_element` at each node of the voxel, gathered per node in
a fixed order; the compliance sensitivity gains `+2 Σ_lc w_lc u_eᵀ f_e` (from `dc = 2 Uᵀ ∂F/∂x − Uᵀ ∂K/∂x U`; the load is design dependent, the
term is exact, not dropped). The stiffness still scales with xPhys^p while the load scales with xPhys, so low densities carry a parasitic load
(Bruyneel & Duysinx 2005): the volume constraint may be inactive and sensitivities positive. **OC assumes non-positive sensitivities**: it now
ends its bisection when no multiplier reaches the target (`LAMBDA_FLOOR`, the constraint is inactive) instead of looping, and the settings
description advises `optimizer: mma` with gravity (tested: a self-weighted plate converges under MMA; `c(2g) = 4 c(g)` for one design). Moments
stay unsupported (`TOP_SETUP_INVALID`). **Compliance ratio** (`rebuildCompliance.ts`): F^T u of a pressure is `−p · A · (n_out · ū)` over the
tetrahedron faces of the mesh face set `L_<loadId>` (outward normal = away from the opposite corner, so no face-numbering convention is relied
on), of gravity `ρ · V_e · (a · ū_e)` over the solid's linear tetrahedra; both exact for linear shape functions and built for **C3D4 only** (a
C3D10 would need midside weights: face load 1/3 per midside, body load −1/20 corners / 1/5 midsides); C3D10, other element types and moments
stay `TOP_REBUILD_NOT_ANALYSED` (`unsupported`). The material **density enters `inputHash`** when the case has a gravity load (the solve reads
it then): a density change makes such a result stale and stops `resumeFromLast`; hashes of studies without gravity are unchanged.

### 15.4 Heaviside projection (TopologySettings.projection)

`set_topology_settings projection: { beta?, eta?, betaStart?, betaEvery? } | null` (density filter only, else `TOP_SETUP_INVALID`), named
defaults β 1 → 16 doubling every 50 iterations or when the design converged at the current β (Wang, Lazarov & Sigmund 2011 practice), η 0.5
(Guest 2004). `xPhys = (tanh(βη) + tanh(β(x̃ − η))) / (tanh(βη) + tanh(β(1 − η)))`, chain rule `β(1 − tanh²) / (…)` before the filter adjoint;
a run counts as converged only at the final β; the continuation level is in `state.json` (`projectionLevel`) and the iteration count the
schedule runs on is `startIteration` + the run's, so a resumed run continues the schedule. `result.json` / artifact / summary carry
`projection { beta, eta }`; the projection is in `settingsHash` only when set (earlier hashes unchanged). Validation: MBB 60×20 density filter,
grey **0.268 → 0.0094** (β 16, levels every 40 iterations), compliance 218.8 → 190.2 (sharper layout, same volume), 300 iterations.

### 15.5 Manufacturing V1 (FR-TOP-13): extrusion and minimum member size

`set_topology_settings manufacturing: { symmetry, extrusion?: { axis: 'x' | 'y' | 'z' }, minMemberSize? }`; `topology_report.rules` states each
one (and the projection and a min_volume objective), `topology_report.optimizer` / `.projection` are read directly. **Extrusion**: a world axis
(the normal of a 2D plane is refused), mapped to the grid axis for the job; native `design.rs`: one design variable per column of free voxels
along the axis (a variable reduction: ξ → x by expansion, gradients summed over the column, pinned voxels keep their value), and with the density
filter the filtered field is averaged along the column (the filter stencil is truncated at the grid ends, so the convolution of a uniform column
is not uniform) — an orthogonal projector, applied again in the chain rule. Without an extrusion axis the design space is the identity and
every per-voxel operation is a plain copy, so the OC path is bit-identical to RS-2 (VC-TOP-10 / 11 unchanged: 203.19245763987374,
218.80322106805878). A resumed extruded run rebuilds its variables from the first voxel of each column (`variables_of`; the mean of k equal
f64 values is not always that value), so it continues bit for bit. Tested: a 12×6×4 cantilever extruded along z gives a field exactly uniform
in k, the MBB extruded along y is uniform in j, and an extruded checkpoint resumed equals the whole run byte for byte.
**Minimum member size** (document units): the llull rule `rmin ≥ size / 2`; the job runs with the effective radius `max(radius, size / 2)`
(`settings.minMemberRule { minMemberSize, radiusVoxels, raised }`, the rule text in the report); a size below `MIN_MEMBER_VOXELS` = 2 voxels is
**`TOP_MEMBER_SIZE_UNRESOLVED`** at `set_topology_settings` (the grid cannot resolve it). `manufacturing` was already in `inputHash`; optional
keys are omitted when absent, so earlier hashes are unchanged.

### 15.6 `deadlineS` checkpoint

`settings.deadlineS` in `job.json`: after the iteration that crosses the wall-clock budget the loop stops with `status: "checkpoint"`, the
warning `TOP_DEADLINE`, and every output written (`field.bin`, `design.f64`, `displacements.f64`, `state.json` + `mma.f64`): resuming with
`startDesign` + `startDisplacements` + `startState` + `startIteration` continues bit for bit. Order inside an iteration: the convergence test
first (a converging iteration at the final β reports `converged`, deadline or not), then the β-continuation bump with its xPhys recompute, then
the deadline — so a checkpoint carries the level and xPhys the uninterrupted run would have; and the deadline is only looked at below the
iteration cap, so a checkpoint never coincides with `maxIterations` (the resume always has ≥ 1 iteration left). Tested: a run stopped after 1
iteration and resumed equals the 30-iteration run byte for byte (OC; MMA + projection likewise through the state), and so do a checkpoint on a
β-bump iteration (`betaEvery: 1`), on a converging intermediate-β iteration, and an extruded run. The transport passes `deadlineS = max(0,
min(⌊0.9 timeoutS⌋, timeoutS − 5))` — 0 below the 5 s margin, i.e. one iteration then the checkpoint, so the kill can never precede the
checkpoint's writes — and keeps the hard kill at `timeoutS`; a checkpoint keeps the resume state (`<LLULL_FEA_CACHE>/topology-resume/`,
now with `.state.json` and `.mma.f64`) and answers **`TOP_SOLVER_TIMEOUT` with `data.resumable: true`, `data.iterations`, `nativeCode:
TOP_DEADLINE`**; `resumeFromLast` continues it (iterations and history accumulate, the cap counts the iterations done). A kill before the
checkpoint (the final solve and the writes take longer than the margin) is still the lost-run timeout. Tested with the fake runner and with the
real binary (a 300-iteration MBB run stopped at a 3 s deadline and resumed equals the uninterrupted run's field and compliance).

### 15.7 Not built / left

PHY-18 shape optimisation (M4 line of §10; depends on PHY-18 M2), unstructured SIMP on the 05 tet mesh (§11.5), VC-TOP-34 on a desktop GPU (the
machine of this build was not measured: the cap stays provisional), displacement constraints for `min_volume` (compliance only), `massG`, a
`TOP_GREY_HIGH` remediation that suggests the projection is in place. `docs/FEATURES.md` and the tool-schema snapshot were regenerated for
`set_topology_objective` and the new parameters.
