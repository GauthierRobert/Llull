# PHY-05: Nonlinear structural analysis — technical specification

Gap id **PHY-05** · prefix **NLS** · status: specification · written 2026-10-15 · functional spec:
[`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md) · validation: [`validation/README.md`](validation/README.md) · sources:
[`validation/sources.md`](validation/sources.md)

## 1. Current state in llull

Today's code (verified by reading the repository on 2026-10-15) and the baseline the aerospace packs add.

| Area | What exists | Path | Limit for this gap |
| ---- | ----------- | ---- | ------------------ |
| Structural solver (today) | 2D linear direct-stiffness frame solver: `solveFrame(nodes, members)` | `packages/core/src/lib/frame2d.ts` | Linear, small displacement, no plasticity, no path following |
| Plastic section data (today) | `plasticModulus` of steel profiles, used by EN 1993 checks | `packages/domain-aec/src/steel/profiles.ts` | AEC section property only; no FE plasticity |
| Materials (today) | `Material { name, density, color, metalness, roughness, finish? }` | `packages/core/src/model/types.ts` | No constitutive data |
| Aerospace 08 MAT (baseline) | `MaterialRecord` with `PropertyValue`s, basis, provenance, `unverified` | `docs/aerospace/08-materials-standards-libraries/TECHNICAL_SPEC.md` §3.1 | Scalars and temperature tables only |
| PHY-01 / PHY-02 (baseline) | PHY-01 `PropertyModel` (`model/propertyModel.ts`, on `MaterialRecord.propertyModels?`, read via `resolvePropertyModel` / `evaluatePropertyModel` / `tabulatePropertyModel`). PHY-02 `MaterialModel { model: MaterialLaw }` with snake_case kinds (`elastic_isotropic`, `j2_plasticity` with isotropic perfect / linear / multilinear / voce and kinematic none / linear / chaboche, `ramberg_osgood`, `hyper_*`, `visco_prony`, `creep_norton`, `creep_garofalo`, `rate_johnson_cook`, `rate_cowper_symonds`) grouped into `ConstitutiveSet { elastic?, hyperelastic?, plastic?, viscoelastic?, creep?, rate? }` on the 08 record (`MaterialRecord.constitutiveSets?`, `defaultConstitutiveSet?`; `packages/core/src/model/materialModel.ts`), attached with `add_material_model` / `define_constitutive_set`; analyses reference a set, never loose parameters (FR-MATL-01); CalculiX writers produce the material cards from a set (FR-MATL-15, `MATL_EXPORT_UNSUPPORTED`) | `docs/physics/01-property-models/TECHNICAL_SPEC.md` §3, `docs/physics/02-constitutive-models/TECHNICAL_SPEC.md` §3 | Owns all stress-strain data and the material cards; this pack references a set by id |
| Aerospace 05 FEA (baseline) | `AnalysisModel` / `AnalysisCase` (`type: 'static' \| 'modal' \| 'buckling'`), Gmsh meshing, INP writer, bundled `ccx`, FRD/DAT readers, artifact store, staleness, margins, `check_analysis`, transports `fea_mesh` / `fea_solve` / `fea_import_results` / `fea_export` | `docs/aerospace/05-fea-cae-handoff/TECHNICAL_SPEC.md` §2–§5; core types in `packages/core/src/model/analysis.ts` (proposed there) | Linear only. FRD reader reads one step |
| PHY-00 (baseline) | `check_convergence`, `compare_to_expected`, `run_benchmarks`, `ExpectedCase` schema | `docs/physics/00-vv-harness/TECHNICAL_SPEC.md` §3–§4 | — |
| MCP toolsets (today) | `TOOLSET_NAMES = core, 2d, 3d, measure, parametric, assembly, exchange, building, civil` | `packages/mcp/src/toolsets.ts` | 05 adds `analysis`; this pack adds no toolset |

A case-insensitive grep of `packages/` for `nlgeom` finds nothing, and `plastic` appears only in the AEC section data and a
material colour comment (`commands/document/materials.ts`): there is no nonlinear analysis today.

**CalculiX capabilities relied on** (User's Manual at commit `fd588701…` [R2]):

- `*STEP, NLGEOM` (Lagrangian strain, Newton iterations per increment, Cauchy stresses printed), `INC` (max increments,
  default 100).
- `*STATIC` second line: initial increment, step time, minimum and maximum increment; `DIRECT` turns automatic
  incrementation off. Five optional parameters (SOLVER, DIRECT, EXPLICIT, TIME RESET, TOTAL TIME AT START) — **no RIKS
  or arc-length parameter**; a grep of the manual for "riks", "arc-length" and "arc length" returns nothing, and the
  LOGBOOK only records "looked into the equations for the arc length method" (25 Oct 2019).
- `*CONTROLS, PARAMETERS=TIME INCREMENTATION | FIELD | LINE SEARCH | CONTACT` with the convergence criteria of section
  "Convergence criteria" (defaults R_n = 0.005, C_n = 0.02, R_p = 0.02, ε = 1e-5, C_ε = 0.001, I_p = 9; up to 5
  cutbacks per increment; cutback factor D_f = 0.25 on divergence).
- `*PLASTIC, HARDENING=ISOTROPIC | KINEMATIC | COMBINED | USER | JOHNSON COOK` with (von Mises stress, equivalent plastic
  strain, temperature) rows; first row must be at zero plastic strain; `*CYCLIC HARDENING` for the isotropic part of
  COMBINED. With isotropic elasticity and NLGEOM, the large-strain theory of Simo is used.
- `*DEFORMATION PLASTICITY`: generalised Ramberg-Osgood E ε = σ + α(|σ|/σ0)^(n−1) σ with (E, ν, σ0, n, α, T).
- Output variables `PEEQ` (equivalent plastic strain, frd name `PE`), `RF` (reaction forces), `U`; `*NODE FILE` /
  `*EL FILE` `FREQUENCY` (default every increment) or `TIME POINTS`.
- Example decks with reference outputs: `beampiso` (isotropic hardening, NLGEOM, DIRECT), `beampkin`, `beampd`
  (kinematic hardening under forced displacement), `beampl` (deformation plasticity).

## 2. Target architecture

```
packages/core/src/model/analysis.ts      (05)  AnalysisType += 'nonlinear_static'; AnalysisCase.nonlinear?: NonlinearSettings
packages/core/src/model/materialModel.ts (PHY-02) MaterialModel / ConstitutiveSet — read only here
packages/domain-physics/src/nonlinear/   CadPlugin 'nonlinear', toolset 'analysis'  (@phys; Proposal A §2.1)
   extension.ts AnalysisTypeExtension for 'nonlinear_static' (pure)
   commands/  set_nonlinear_controls, add_analysis_step, update_analysis_step, delete_analysis_step,
              set_part_constitutive_set, add_curve_probe, delete_curve_probe, add_imperfection, delete_imperfection,
              nonlinear_report, limit_load, check_nonlinear, nonlinear_analytic_check, beam_large_deflection
   decks/     nonlinearInp.ts   (pure deck sections returned through the extension: steps, controls, imperfections)
   results/   incrementReader.ts (FRD/DAT per increment), curves.ts, limitLoad.ts, permanentSet.ts
   solver/    corotationalFrame2d.ts, arcLength.ts, bandedLu.ts    (pure, deterministic)
   checks/    analytic.ts   (same formulas as validation/generate_nls_reference.py)
server/       (05) fea_solve transport: progress per increment parsed from ccx stdout, cancel, timeout
```

### 2.1 Placement decision forced by the dependency rule (pending README §5.1)

`docs/physics/README.md` §6.2 proposes a `packages/domain-physics` plugin (`@phys`) that extends 05's analysis stack. The
enforced rule `plugins-and-kernels-depend-on-core-only` (`.dependency-cruiser.cjs`, part of `npm run check`) forbids
`domain-physics → domain-cae` imports, and architecture L2 says never to loosen a rule. This pack therefore uses the
shared proposal of PHY-03 (`../03-thermal-analysis/TECHNICAL_SPEC.md` §2.1), **pending decision** (README §5.1, §11 q1):

- **Proposal A (preferred): analysis extension port in core.** Shared analysis types live in core `model/analysis.ts`
  (05 TR-FEA-02). Core gains `AnalysisTypeExtension` (validateCase · inputHashFields · writeDeckSections ·
  summariseResults · checkItems) and `CadPlugin.analysisExtensions?`; `plugins/host.ts` exposes `analysisExtension(type)`.
  05's deck writer, summariser, staleness hash and `check_analysis` dispatch on that lookup for types they do not own.
  This pack registers the extension for `nonlinear_static` from `@phys`; PHY-02's material cards arrive through its
  `MaterialCardWriter` in the same way. No package imports another package.
- **Proposal B (fallback): discipline inside the 05 FEA package** (`packages/domain-cae/src/nonlinear/`, its own `CadPlugin`
  exported from the same package; intra-package imports are allowed).

Paths below are written for Proposal A (`packages/domain-physics/src/nonlinear/`); under B only the package changes.

**Laws respected:** L1 (every change is a command; meshing and solving are 05 transports that record results through
05's validated `record_fea_results`), L2 (no DOM / process code in packages; `ccx` runs in `server/`), L3 (pure
commands), L4 (curves and increment results in the 05 artifact store, summaries and hashes in the document), L5 (zod
schemas), L8 (feature steps; ids `nls-<step>.<k>`, `stp-…`, `prb-…`, `imp-…`), L9 (no kernel needed except through 05
targeting), L10 (plugin; core gets data types only).

### 2.2 Technical requirements

| Id | Pri | Requirement |
| -- | --- | ----------- |
| TR-NLS-01 | MUST | `AnalysisType` gains `'nonlinear_static'` (owned by this pack, listed in §3). `AnalysisCase.nonlinear?: NonlinearSettings` is present iff the type is `nonlinear_static`; plugin `validate` enforces it. |
| TR-NLS-02 | MUST | The deck sections (via `AnalysisTypeExtension.writeDeckSections`) are pure and byte-deterministic: same `AnalysisModel` + mesh artifact + material models ⇒ same text (05 TR-FEA-40). |
| TR-NLS-03 | MUST | Material cards come from the PHY-02 writer for the selected constitutive set (§5.2); no stress-strain values are stored in the analysis slice. |
| TR-NLS-04 | MUST | `fea_solve` for a nonlinear case parses ccx stdout increment lines into progress events and stores per-increment probe values and the selected increments' fields in the artifact (§5.4). |
| TR-NLS-05 | MUST | `limit_load` and `permanentSet` are pure functions of the stored curve / fields (`results/limitLoad.ts`, `results/permanentSet.ts`), unit-tested on synthetic curves. |
| TR-NLS-06 | MUST | Staleness: the 05 `analysisInputHash` additionally covers `nonlinear` settings and the referenced `MaterialModel` content hashes; a change marks curves `stale`. |
| TR-NLS-10 | MUST | Convergence presets are data with sources (§5.3); explicit values are range-checked (all > 0, `minIncrement ≤ initialIncrement ≤ maxIncrement ≤ stepTime`). |
| TR-NLS-20 | SHOULD | `solver/corotationalFrame2d.ts` + `arcLength.ts`: Crisfield corotational Euler-Bernoulli beam, spherical arc-length, Newton corrector, banded LU; reproduces `generate_nls_reference.py` to 1e-6 relative on the same inputs (same algorithm, same ordering). |
| TR-NLS-21 | MUST | `checks/analytic.ts` implements the generator formulas exactly; unit tests compare with `expected_results.json` at 1e-9. |
| TR-NLS-30 | SHOULD | Imperfection: node coordinates perturbed by `Σ a_i · φ_i / max|φ_i|` (normalised so the largest nodal displacement of the mode equals the amplitude) using the buckling case's mode artifact; requires the same `meshHash`. |
| TR-NLS-40 | MUST | Agent contract (AF-10/11/31–36) on every query: named controls, `unverified`, `reviewRequired`, `provenance`, `summary` sentence. |

## 3. Data model

```ts
// packages/core/src/model/analysis.ts — additions owned by PHY-05 (05 owns the file)
export type AnalysisType = 'static' | 'modal' | 'buckling'          // 05
  | 'nonlinear_static';                                             // PHY-05 (this pack)
// FeSolver: 05 'calculix' | 'nastran'; PHY-05 adds 'code_aster' (V2, export / foreign import only)

export interface NamedNumber { readonly value: number; readonly source: string; readonly defaulted: boolean }

export type SolutionControl =
  | { readonly kind: 'load'; readonly initialIncrement: number; readonly minIncrement: number;
      readonly maxIncrement: number; readonly maxIncrements: number }            // fractions of step time (step time = 1)
  | { readonly kind: 'displacement'; readonly target: FeaTarget; readonly dof: 'ux' | 'uy' | 'uz';
      readonly value: number;                                                     // analysis length unit, at step end
      readonly initialIncrement: number; readonly minIncrement: number; readonly maxIncrement: number;
      readonly maxIncrements: number }
  | { readonly kind: 'arc_length'; readonly initialArcLength: number; readonly maxSteps: number }; // refused on calculix

export interface ConvergencePreset {
  readonly name: 'ccx_default' | 'custom';
  /** Only for 'custom'; keys of the ccx *CONTROLS FIELD line (R_n, C_n, q0, q_u, R_p, eps, C_eps, R_l). */
  readonly field?: Readonly<Partial<Record<'Rn' | 'Cn' | 'q0' | 'qu' | 'Rp' | 'eps' | 'Ceps' | 'Rl', number>>>;
  /** Only for 'custom'; keys of *CONTROLS TIME INCREMENTATION (I0, IR, IP, IC, IL, IG, IS, IA, IJ, IT). */
  readonly timeIncrementation?: Readonly<Partial<Record<'I0' | 'IR' | 'IP' | 'IC' | 'IL' | 'IG' | 'IS' | 'IA' | 'IJ' | 'IT', number>>>;
}

export interface AnalysisStep {
  readonly id: string; name: string;
  /** Load-case multipliers active at the END of this step (0 = removed). Ramp from the previous step's values. */
  multipliers: Readonly<Record<string, number>>;
  amplitude: 'ramp' | 'step';
  control: SolutionControl;
}

export interface CurveProbe {
  readonly id: string; name: string;
  load: { readonly kind: 'load'; readonly loadId: string } | { readonly kind: 'reaction'; readonly constraintId: string;
          readonly component: 'x' | 'y' | 'z' | 'magnitude' };
  displacement: { readonly point: Vec3; readonly dof: 'ux' | 'uy' | 'uz' | 'magnitude' };
}

export interface Imperfection {
  readonly id: string;
  readonly fromAnalysisId: string;               // a solved 05 'buckling' case on the same meshHash
  readonly modes: readonly { readonly mode: number; readonly amplitude: number /* analysis length unit, signed */ }[];
  readonly amplitudeSource: string;              // mandatory text: owner instruction or company rule id (AF-31)
}

export interface NonlinearSettings {
  nlgeom: boolean;
  steps: Record<string, AnalysisStep>; stepOrder: string[];
  convergence: ConvergencePreset;
  constitutiveSets: Record<EntityId, string>;   // part -> PHY-02 ConstitutiveSet.id on its 08 record (absent => record's defaultConstitutiveSet)
  probes: Record<string, CurveProbe>; probeOrder: string[];
  imperfections: Record<string, Imperfection>; imperfectionOrder: string[];
  outputIncrements: 'all' | 'last_per_step' | { readonly every: number };
  thresholds?: {                                  // AF-31: no defaults; absent => NLS_*_THRESHOLD_UNSET warnings
    readonly permanentDisplacement?: NamedNumber; readonly permanentPeeq?: NamedNumber;
    readonly smallRotationRad?: NamedNumber; readonly smallStrain?: NamedNumber;
  };
  results?: NonlinearResultsSummary;              // set by 05 record_fea_results (validated against the artifact)
}

export interface NonlinearResultsSummary {
  readonly resultsHash: string; readonly inputHash: string; readonly solverVersion: string;
  readonly completed: boolean;                    // false = stopped early (code says why)
  readonly stopCode?: 'NLS_NOT_CONVERGED' | 'NLS_INCREMENT_TOO_SMALL' | 'NLS_LIMIT_POINT_REACHED' | 'NLS_MAX_INCREMENTS';
  readonly steps: readonly { stepId: string; increments: number; cutbacks: number; lastLoadFactor: number; completed: boolean }[];
  readonly curves: readonly { probeId: string; points: number; maxLoad: number; loadUnit: string; dispUnit: string;
                              dispRange: readonly [number, number]; snapBack: boolean; curveHash: string }[];
  readonly maxVonMises: { value: number; at: Vec3; increment: number };
  readonly maxPeeq: { value: number; at: Vec3; increment: number; beyondCurve: boolean };
  readonly plasticVolumeFraction: number;
  readonly permanentSet?: { stepId: string; maxResidualDisplacement: number; at: Vec3; maxResidualPeeq: number };
  readonly unverified: boolean; readonly unverifiedReasons: readonly string[];
}
```

Native solver input (query only, never stored):

```ts
export interface BeamFrameInput {
  units: { length: 'mm' | 'm' | 'in'; force: 'N' | 'kN' | 'lbf' };
  nodes: readonly { id: string; x: number; y: number }[];
  members: readonly { from: string; to: string; E: number; A: number; I: number; elements: number }[]; // E in force/length²
  supports: readonly { node: string; ux?: boolean; uy?: boolean; rz?: boolean }[];
  referenceLoad: readonly { node: string; fx?: number; fy?: number; mz?: number }[];
  control: { kind: 'arc_length'; arcLength: number; maxSteps: number } | { kind: 'load'; increments: number; maxFactor: number };
  stop?: { maxLoadFactor?: number; node?: string; dof?: 'ux' | 'uy'; maxAbsDisplacement?: number };
  report: { node: string; dofs: readonly ('ux' | 'uy' | 'rz')[]; every?: number };
}
```

Document version: the `nonlinear` field rides the 05 `analysis` slice inside the aerospace v3 envelope (01 KRN §3.1). No
migration: the field is optional (README §6.2).

## 4. Commands

Plugin `nonlinear`, toolset `analysis`. All are `defineCommand({ name, description, params: z.object(...), run })`, pure,
snake_case. **M** = mutating (feature step), **Q** = query (`readOnly`, `data`). Every numeric param's `.describe()` names
its unit (analysis unit system of the case, fractions of step time, or radians) (AF-04).

| Name | Kind | Params sketch | Tags |
| ---- | ---- | ------------- | ---- |
| `set_nonlinear_controls` | M | `{ analysisId, nlgeom: boolean (required), convergence?: { name: 'ccx_default' \| 'custom', field?, timeIncrementation? }, outputIncrements?, thresholds? }` | @affects case.nonlinear (created on first call; case.type must be `nonlinear_static`) · @invariant nlgeom always explicit; thresholds carry `source` · @failure case not nonlinear → `NLS_CASE_NOT_NONLINEAR`; custom values ≤ 0 → `NLS_CONTROL_INVALID` |
| `add_analysis_step` / `update_analysis_step` / `delete_analysis_step` | M | `{ analysisId, name, multipliers: Record<loadCase, number>, amplitude?: 'ramp' (default named), control: SolutionControl }` | @affects nonlinear.steps · @invariant ≥ 1 step; `min ≤ initial ≤ max ≤ 1`; displacement target resolves (05 TR-FEA-03) · @failure arc_length on `calculix` → `NLS_ARC_LENGTH_UNSUPPORTED`; unknown load case → `NLS_LOAD_CASE_UNKNOWN`; target unresolved → `FEA_TARGET_UNRESOLVED` |
| `set_part_constitutive_set` | M | `{ analysisId, entityId, constitutiveSetId? (ConstitutiveSet.id; omitted = the record's defaultConstitutiveSet, returned named) }` | @affects nonlinear.constitutiveSets · @invariant the set exists on the part's 08 record (PHY-02) and contains only behaviours a static nonlinear step accepts (§5.2) · @failure missing → `NLS_MATERIAL_MODEL_MISSING`; creep / viscoelastic / rate laws in the set → `NLS_MATERIAL_MODEL_UNSUPPORTED` |
| `add_curve_probe` / `delete_curve_probe` | M | `{ analysisId, name, load: {kind:'load', loadId} \| {kind:'reaction', constraintId, component}, displacement: { point (length unit), dof } }` | @affects nonlinear.probes · @failure unknown load/constraint → `NLS_PROBE_REFERENCE_UNKNOWN` |
| `add_imperfection` / `delete_imperfection` | M (V1) | `{ analysisId, fromAnalysisId, modes: [{ mode, amplitude (length unit, signed) }], amplitudeSource: string }` | @affects nonlinear.imperfections · @invariant `amplitude` and `amplitudeSource` required, no default (AF-31) · @failure missing amplitude → `NLS_IMPERFECTION_AMPLITUDE_UNSET`; source case not buckling / not solved / different meshHash → `NLS_IMPERFECTION_SOURCE_INVALID` |
| `nonlinear_report` | Q | `{ analysisId, probe?, increments?: 'summary' \| 'all' (paged, AF-12) }` | → `data` §5.5 · @failure no results → `FEA_RESULTS_MISSING`; stale → `NLS_CURVE_STALE` |
| `limit_load` | Q | `{ analysisId, probe, method: 'peak' \| 'plateau' \| 'auto', plateau?: { slopeFraction: number (no default), window: number (displacement unit, no default) } }` | → `{ limitLoad?, lowerBound?, method, atDisplacement, curveHash, provenance, reviewRequired }` · @invariant `auto` = peak if a maximum exists, else `not_reached`; plateau needs both params · @failure plateau params missing → `NLS_PLATEAU_PARAMS_UNSET`; stale → `NLS_CURVE_STALE` |
| `check_nonlinear` | Q | `{ analysisId }` | → pass/warn/fail items with codes §7.1, `reviewRequired: true`; includes 05 `check_analysis` items for the case |
| `nonlinear_analytic_check` | Q | `{ check: 'plastic_hinge_beam' \| 'moment_curvature_rectangle' \| 'thick_cylinder_pressure' \| 'elastica_cantilever' \| 'imperfect_column', inputs: Record<string, number \| string> }` (input keys carry units: `b_mm`, `sigmaY_MPa`) | pure; formulas §5.6; returns value, formula, inputs, source id |
| `beam_large_deflection` | Q (V1) | `BeamFrameInput` (§3) | → `{ path: [{ loadFactor, u: {…} }], limitPoints: [...], snapBack: boolean, converged, steps, provenance }` · @invariant deterministic; bounded output (`report.every`, AF-12) · @failure singular start, non-convergence → `NLS_NOT_CONVERGED` with the last converged step |
| (05) ✱ `fea_solve` | transport | unchanged params; nonlinear cases add progress events | records through 05 `record_fea_results` |
| (05) `compute_margins` | Q | V1: `criterion: 'limit_load'` + `limitLoadProbe` | rows per §5.7; reviewer-gated as in 05 |

`@affects`/`@invariant`/`@failure` tags go on each command file (C2). Descriptions follow AF-02, e.g. `limit_load`:
"Finds the limit (collapse) load of a solved nonlinear_static case from a load-displacement probe. method=peak takes the
first maximum; method=plateau needs slopeFraction and window. Refuses stale results. A load-controlled run that stopped
at a limit point gives only a lowerBound. Next: compute_margins criterion=limit_load or check_nonlinear."

## 5. Kernel / algorithms

### 5.1 Deck (pure extension of the 05 INP writer)

```
** llull … analysis <name> type nonlinear_static nlgeom <true|false> units N-mm-t-s inputHash <h> meshHash <m>
*NODE (perturbed by imperfections, TR-NLS-30)
*MATERIAL, NAME=<record>__<modelId>
*ELASTIC  E, nu                         (from the 08 record via PHY-02 elastic part)
*PLASTIC, HARDENING=ISOTROPIC|KINEMATIC|COMBINED  rows (sigma_vM, eps_p, T)    | *DEFORMATION PLASTICITY E,nu,s0,n,alpha,T
*CYCLIC HARDENING (isotropic part when COMBINED)
*AMPLITUDE, NAME=A_<step>  (only when amplitude differs from the ccx step default)
*STEP, NLGEOM[=NO], INC=<maxIncrements>
*STATIC[, DIRECT]   initialIncrement, 1.0, minIncrement, maxIncrement
*CONTROLS, PARAMETERS=FIELD / TIME INCREMENTATION   (only for preset 'custom')
*BOUNDARY  (constraints; displacement control: target node set, dof, value)
*CLOAD / *DLOAD  (load cases × step multipliers, OP=NEW when a load is removed)
*NODE PRINT, NSET=PRB_<probe>  U   |  *NODE PRINT, NSET=C_<constraint>, TOTALS=ONLY  RF
*NODE FILE, FREQUENCY=<n>  U   *EL FILE, FREQUENCY=<n>  S, PEEQ
*END STEP   (repeat per AnalysisStep)
```

The probe uses `*NODE PRINT … TOTALS=ONLY` to get the summed reaction per increment in the `.dat` file, and the
displacement of the probe node (the mesh node nearest to `point`, distance reported). Keyword spellings are tested
against a real ccx run (VC-NLS-41) rather than prose.

### 5.2 Material cards (PHY-02 writers) and the checks this pack adds

The material cards are written by the PHY-02 CalculiX writer (`MaterialCardWriter` extension point of the 05 deck writer,
PHY-02 TECHNICAL_SPEC §2) from the selected `ConstitutiveSet { elastic?, hyperelastic?, plastic?, viscoelastic?, creep?,
rate? }` (FR-MATL-15); this
pack embeds that text in its deck and does not map laws itself. The table states what a nonlinear static step needs
from the writer and which extra checks `check_nonlinear` runs.


| PHY-02 law (by name) | CalculiX card (PHY-02 writer) | Check added by this pack |
| ------------------------ | -------- | ---- |
| `elastic_isotropic` (slot `elastic`) | `*ELASTIC` | — |
| `elastic_orthotropic` + `j2_plasticity` | `*ELASTIC,TYPE=ORTHO` + `*PLASTIC` | PHY-02 allows at most linear hardening (ccx infinitesimal orthotropic model); NLGEOM large-strain theory not used — reported in `provenance` |
| `j2_plasticity { isotropic: perfect \| linear \| multilinear \| voce, kinematic: none }` | `*PLASTIC, HARDENING=ISOTROPIC` | rows true stress vs equivalent plastic strain, first row at 0 (PHY-02 validates) |
| `j2_plasticity { isotropic: perfect, kinematic: linear }` | `*PLASTIC, HARDENING=KINEMATIC` | — |
| `j2_plasticity` combined (isotropic + kinematic, PHY-02 V1) | `*PLASTIC, HARDENING=COMBINED` + `*CYCLIC HARDENING` | `kinematic: chaboche` → `MATL_EXPORT_UNSUPPORTED` from the PHY-02 writer, passed through unchanged |
| `ramberg_osgood { theory: 'deformation' }` (slot `plastic`, carries E, ν; no `elastic` slot) | `*DEFORMATION PLASTICITY` (E, ν, σ0, n, α) | monotonic only: an unloading step raises `NLS_DEFORMATION_PLASTICITY_UNLOAD` (PHY-02 also warns `MATL_DEFORMATION_THEORY_PATH`) |
| temperature-dependent parameters (PHY-01 `PropertyModel` via `tabulatePropertyModel`) | rows per temperature | ccx interpolates hardening curves at the `*ELASTIC` temperatures (manual) — the PHY-02 writer emits identical temperature sets |
| `hyper_*` (slot `hyperelastic`) | `*HYPERELASTIC` (PHY-02 writer) | accepted with NLGEOM on only (else `NLS_NLGEOM_RECOMMENDED` as an error) |
| slots `viscoelastic` (`visco_prony`), `creep` (`creep_norton`, `creep_garofalo`), `rate` (`rate_johnson_cook`, `rate_cowper_symonds`) | — | `NLS_MATERIAL_MODEL_UNSUPPORTED` in a static step (PHY-11 / PHY-19 own them) |

Engineering-to-true conversion is PHY-02's job (FR-MATL-05); this pack only reads the conversion record PHY-02 keeps
and reports it in `provenance`.

### 5.3 Convergence presets (named values, AF-31)

| Name | Values | Source |
| ---- | ------ | ------ |
| `ccx_default` | no `*CONTROLS` card; ccx defaults apply: R_n 0.005, C_n 0.02, R_p 0.02, ε 1e-5, C_ε 0.001, I_p 9; ≤ 5 cutbacks; D_f 0.25 | CalculiX manual §"Convergence criteria" and `*CONTROLS` [R2] |
| increments (no preset) | initial / min / max increment and `maxIncrements` are **required** on every step; the ccx defaults (initial 1, min = min(initial, 1e-6 × step), max 1e30, INC 100) are listed in the description and returned named if the agent passes `useSolverDefaults: true` | [R2] |

### 5.4 Increment parsing and progress

- **stdout.** ccx prints one block per increment ("increment … attempt … iteration …", "convergence"); the transport turns
  them into `--progress` events `{ step, increment, attempt, iterations, loadFactor }`. Exact line formats are captured from
  the pinned `beampiso` run and unit-tested as fixtures (VC-NLS-41); no format is assumed from prose.
- **FRD.** `1PSTEP` blocks carry step and increment numbers (05 §5.7 reader). The reader yields one record per stored
  increment; `outputIncrements` limits storage.
- **DAT.** `*NODE PRINT` tables per increment ("displacements (vx,vy,vz) for set … and time …", "total force (fx,fy,fz) for
  set … and time …"), parsed into curve points `(time, load, displacement)`.
- **Stop classification.** Run ends normally ⇒ `completed`. Increment size below minimum ⇒ `NLS_INCREMENT_TOO_SMALL`;
  `INC` reached ⇒ `NLS_MAX_INCREMENTS`; divergence after max cutbacks ⇒ `NLS_NOT_CONVERGED`. Under load control,
  `NLS_LIMIT_POINT_REACHED` replaces the first two when the last three converged increments show the tangent stiffness of the
  probe curve (Δload/Δdisp) below 1 % of the initial tangent (llull rule, named in `data.provenance`), so the agent knows
  the stop is physical, not numerical.
- **Snap-back flag.** On a displacement-controlled curve, `snapBack: true` if the controlled displacement is monotone but a
  monitored probe displacement reverses while the load decreases (indicator only; it cannot be traced on ccx).

### 5.5 `nonlinear_report` data shape (AF-10)

```json
{
  "analysisId": "an-7.1", "state": "solved", "completed": true, "nlgeom": true, "unitSystem": "N-mm-t-s",
  "controls": { "convergence": { "name": "ccx_default", "source": "CalculiX manual, Convergence criteria", "defaulted": false },
                "steps": [{ "stepId": "stp-9.1", "control": "displacement", "initialIncrement": { "value": 0.02, "source": "plan", "defaulted": false } }] },
  "steps": [{ "stepId": "stp-9.1", "increments": 64, "cutbacks": 3, "lastLoadFactor": 1.0, "completed": true }],
  "curves": [{ "probeId": "prb-10.1", "name": "tip", "loadN": [0, 120.4], "dispMm": [0, 0.41], "points": 65, "maxLoadN": 498.7, "snapBack": false, "curveHash": "…" }],
  "maxPeeq": { "value": 0.031, "atMm": [0, 10, 0], "beyondCurve": false }, "plasticVolumeFraction": 0.12,
  "permanentSet": null,
  "provenance": { "solver": "CalculiX 2.2x", "deck": "sha256:…", "limitPointRule": "tangent < 1 % of initial over 3 increments (llull rule)" },
  "unverified": false, "unverifiedReasons": [],
  "reviewRequired": true, "reviewReason": "nonlinear result may support a strength or permanent-set claim",
  "summary": "Displacement-controlled run completed (64 increments). Max load 498.7 N. Computed by llull, not approved — needs a qualified engineer."
}
```

Curve arrays are paged (`increments: 'all'` + cursor) beyond 1 000 points (AF-12). Numbers in the JSON above illustrate
the shape only; they are not expected values.

### 5.6 Analytic checks (FR-NLS-11; identical to the generator)

| Check | Formula | Source |
| ----- | ------- | ------ |
| Plastic moment, rectangle | M_p = σy b h²/4, M_y = σy b h²/6, shape factor 1.5 | textbook; [R12] (search) |
| Moment-curvature | M/M_y = κ/κ_y (κ ≤ κ_y); 1.5 (1 − (κ_y/κ)²/3) (κ > κ_y) | derived (stress block) |
| Beam collapse loads (virtual work) | cantilever tip P = M_p/L; SS central 4M_p/L; propped central 6M_p/L; fixed-fixed central 8M_p/L | [R12] (search), derived |
| Thick cylinder | Tresca p_y = (σy/2)(1 − a²/b²), p_c = σy ln(b/a); von Mises incompressible k = σy/√3: p(c) = k(1 − c²/b² + 2 ln(c/a)), p_c = (2/√3) σy ln(b/a); von Mises first yield with plane-strain σz = ν(σr + σθ) solved exactly at r = a | [R11] (problem class, search); derived |
| Elastica | k² = (1 + sin θ0)/2, sin φ1 = 1/(k√2), αL = K(k) − F(φ1,k), λ = (αL)², δv/L = 1 − 2(E(k) − E(φ1,k))/(αL), x_tip/L = √(2 sin θ0)/(αL) | [R10]; derived in generator |
| Imperfect pinned column | w = w0/(1 − P/P_cr), P_cr = π²EI/L² | derived (small deflection) |

### 5.7 Limit load and margins (FR-NLS-05, FR-NLS-14)

```
peak:     first index i with load[i] ≥ load[i-1] and load[i+1] < load[i] (displacement increasing); refine by a parabola
          through (i-1, i, i+1) in (disp, load); report both the sample and the refined value
plateau:  first displacement d where secant slope over [d, d + window] < slopeFraction × initial slope; limit = load(d)
not_reached: neither found; report maxLoad as lowerBound with NLS_LIMIT_NOT_REACHED (warning)
load-controlled stop (NLS_LIMIT_POINT_REACHED): lowerBound = last converged load; limitLoad absent
margin row (V1): MS = P_limit / (P_case × FoS_ult × Π extra) − 1, criterion "limit_load", reviewRequired, 05 disposition rules
```

The limit-load row records `curveHash`, `method`, parameters and, if present, the PHY-00 convergence study id; without a
study it adds `VNV_NO_CONVERGENCE_STUDY` (FR-NLS-19).

### 5.8 Native corotational beam solver (TR-NLS-20)

- **Element.** 2D Euler-Bernoulli corotational beam (Crisfield): basic deformations u_l = (L² − L0²)/(L + L0), θ1, θ2
  relative to the chord; local forces N = EA/L0·u_l, M1 = EI/L0(4θ1 + 2θ2), M2 = EI/L0(2θ1 + 4θ2); tangent = BᵀDB +
  N/L·r rᵀ + (M1 + M2)/L²(r zᵀ + z rᵀ). Exactly as in `validation/generate_nls_reference.py` (`element`).
- **Path following.** Spherical arc-length (ψ = 0): predictor along the tangent with the sign of the previous increment,
  corrector solves the quadratic constraint and picks the root closest to the previous direction. Load control for
  monotone problems.
- **Linear algebra.** DOFs ordered along member chains; banded LU without pivoting (bandwidth 6 for a chain). Frames that are
  not chains (branches) use a reverse Cuthill-McKee ordering; a zero pivot raises `NLS_NOT_CONVERGED` with the step.
- **Tolerances.** Residual norm < 1e-9 × max(1, |λ|); ≤ 60 corrector iterations; deterministic arithmetic order.
- **Verification.** Lee frame (NL7) peak 18.5632 / v/L 0.40616 at 40 elements per leg, 18.5825 / 0.40625 at 20, 18.6588 /
  0.40663 at 10 (generator), against 18.55 / 0.407 [R3]; elastica λ = 1: 0.301740 vs closed form 0.301721.

### 5.9 Numerical tolerances

| Item | Value |
| ---- | ----- |
| Analytic checks vs generator | 1e-9 relative |
| Native solver vs generator | 1e-6 relative (same algorithm) |
| FE benchmarks | per case in `expected_results.json` (1–5 %, justified in the README) |
| Curve parse | exact string → IEEE double |

## 6. Interop & persistence

| Format | Direction | Implementation | Licence |
| ------ | --------- | -------------- | ------- |
| CalculiX INP (nonlinear keywords) | out | `decks/nonlinearInp.ts` (pure TS) | — |
| CalculiX FRD / DAT (multi-increment) | in | `results/incrementReader.ts` | — |
| Code_Aster `.comm` + MED mesh (V2) | out | COULD; writer to be designed (MED is HDF5: needs a Python lib in the bridge, licence TBD) | code_aster GPL-3.0 (external program, not linked) |
| Curves | artifact | gzip JSON in the 05 store; CSV export with `--save` | — |

## 7. CLI / MCP / UI surfaces

- **CLI.** All commands as `llull <command> …`; long runs through 05 `fea_solve --progress --timeout`. `llull guide` gains a
  nonlinear section: when to use NLGEOM, why load control cannot pass a peak, plateau parameters, imperfection amplitude
  must come from the owner or a rule, end with `check_nonlinear` (AF-03).
- **MCP.** Toolset `analysis`; prompt `nonlinear_collapse_check` (set-up → solve → limit_load → check).
- **UI (review).** `src/ui/panels/analysis/NonlinearPanel.tsx` (curve plot from `nonlinear_report`, increment slider),
  05 overlay field `peeq`. Built with the `viewport-feature` skill.

### 7.1 Stable error and check codes (AF-11)

| Code | Severity | When | Offending ids / path | Remediation |
| ---- | -------- | ---- | -------------------- | ----------- |
| `NLS_CASE_NOT_NONLINEAR` | error | nonlinear command on a case whose type is not `nonlinear_static` | analysis id | `create_analysis analysisType=nonlinear_static` |
| `NLS_CONTROL_INVALID` | error | increment values ≤ 0 or out of order, custom control ≤ 0 | param path | fix the values (min ≤ initial ≤ max ≤ 1) |
| `NLS_ARC_LENGTH_UNSUPPORTED` | error | `control.kind = arc_length` with solver `calculix` | step id | use displacement control, `beam_large_deflection` (frames) or the Code_Aster export (V2) |
| `NLS_LOAD_CASE_UNKNOWN` | error | step multiplier names an absent load case | step id, name | add the load case or fix the name |
| `NLS_MATERIAL_MODEL_MISSING` | error | analysed part has no PHY-02 constitutive set selected, or the record has none | entity id, record id | PHY-02 `add_material_model` + `define_constitutive_set`, then `set_part_constitutive_set` |
| `NLS_MATERIAL_MODEL_UNSUPPORTED` | error | model variant not mappable (§5.2), or first hardening row not at zero plastic strain | model id | choose a J2 or Ramberg-Osgood model |
| `NLS_MATERIAL_MODEL_UNVERIFIED` | warning (not suppressible) | model or its source data `unverified` | model id, reasons | use a verified, sourced model (PHY-02 / 08) |
| `NLS_DEFORMATION_PLASTICITY_UNLOAD` | error | Ramberg-Osgood deformation plasticity with an unloading step | step id | use an incremental J2 model for load-unload |
| `NLS_PROBE_REFERENCE_UNKNOWN` | error | probe references a missing load or constraint | probe id | fix the reference |
| `NLS_IMPERFECTION_AMPLITUDE_UNSET` | error | `add_imperfection` without amplitude or `amplitudeSource` | param path | ask the owner or company rule for the amplitude |
| `NLS_IMPERFECTION_SOURCE_INVALID` | error | source case not a solved buckling case on the same mesh | analysis ids | solve the buckling case on the same mesh first |
| `NLS_IMPERFECTION_MISSING` | warning | NLGEOM run with compressive members / a solved buckling case of the same part and no imperfection | analysis id | `add_imperfection` |
| `NLS_NLGEOM_RECOMMENDED` | warning | NLGEOM off and max rotation / strain above the stated thresholds | analysis id, values | `set_nonlinear_controls nlgeom=true` |
| `NLS_THRESHOLD_UNSET` | warning | small-rotation / strain threshold not given (so the NLGEOM check is skipped) | analysis id | give thresholds with a source |
| `NLS_NOT_CONVERGED` | error | divergence after the maximum cutbacks | step, increment, `logTail` | smaller initial increment, check constraints / material |
| `NLS_INCREMENT_TOO_SMALL` | error | increment below the minimum | step, increment | lower minIncrement or switch to displacement control |
| `NLS_MAX_INCREMENTS` | error | `INC` reached | step | raise maxIncrements |
| `NLS_LIMIT_POINT_REACHED` | warning | load-controlled run stopped at a limit point (§5.4 rule) | step, lowerBound | switch to displacement control to find the limit load |
| `NLS_LIMIT_NOT_REACHED` | warning | curve still rising at the end | probe id | extend the controlled displacement |
| `NLS_SNAP_BACK_DETECTED` | warning | snap-back indicator on a displacement-controlled run | probe id | `beam_large_deflection` (frames) or Code_Aster export (V2) |
| `NLS_PLATEAU_PARAMS_UNSET` | error | `method=plateau` without both parameters | param path | give slopeFraction and window |
| `NLS_STRAIN_BEYOND_CURVE` | warning | PEEQ above the last hardening row | element ids, PEEQ | extend the PHY-02 curve with test data |
| `NLS_STRAIN_EXCEEDS_ELONGATION` | fail | PEEQ above the 08 elongation value (when present) | element ids | redesign; reviewer decides |
| `NLS_MESH_PLASTIC_ADEQUACY` | warning | < 2 elements through a thickness with PEEQ > 0 | part id | refine (05 refinement) |
| `NLS_PERMANENT_SET_THRESHOLD_UNSET` | warning | unload step present, no permanent-set threshold | analysis id | ask the owner / company rule |
| `NLS_PERMANENT_SET_EXCEEDED` | fail | residual displacement or PEEQ above the threshold | step id, values | redesign; qualified reviewer decides |
| `NLS_CURVE_STALE` | error | curve `inputHash` ≠ current | probe id | `fea_mesh` / `fea_solve` again |

Reused 05 codes: `FEA_TOOL_MISSING`, `FEA_RESULTS_MISSING`, `FEA_RESULTS_STALE`, `FEA_TARGET_UNRESOLVED`,
`FEA_HUMAN_GATE`, `FEA_MS_NEGATIVE`. Reused PHY-00 code: `VNV_NO_CONVERGENCE_STUDY`.

### 7.2 Agent-first compliance

| AF | Where |
| -- | ----- |
| AF-01/02/03/04 | registry commands §4; descriptions with units and next command; guide section §7 |
| AF-05 | plans in `validation/plans/` validated with `llull run --validate` |
| AF-10/12/13 | `nonlinear_report` §5.5, paged curves, deterministic deck and native solver |
| AF-11 | §7.1 |
| AF-20/21 | `check_nonlinear`; curve and limit load as numbers, plot optional |
| AF-22 | `render_view … analysisId field=peeq increment=n --save` (05 render params) |
| AF-23 | PHY-00 harness entries in `expected_results.json` |
| AF-30/31 | presets with sources §5.3; thresholds and amplitudes without defaults |
| AF-32/33/35/36 | `unverified`, `reviewRequired`, `provenance`, summary sentence |
| AF-34 | limit-load margin acceptance through 05 `dispose_margin` (human gate) |
| AF-40/41 | progress per increment, timeout, cache; ccx bundled (05) |
| AF-42 | `--dry-run` on all M commands |

## 8. Performance & robustness budgets

| Budget | Target |
| ------ | ------ |
| Native beam solver | NL7, 40 elements per leg, ≈ 900 arc steps: ≤ 2 s in TS (the Python generator takes about a minute for 10 + 20 + 40 elements; TS is expected to be far faster — TBD measure) |
| Nonlinear ccx run, 20k-node C3D20R cantilever, 50 increments | ≤ 5 min (TBD — measure, VC-NLS-70) |
| Artifact | per-increment fields only for `outputIncrements`; probe curves always; cap 512 MB (05) |
| Process safety | 05 rules (tracked child, timeout, cancel) |

## 9. Test strategy

| Layer | Tests | VC |
| ----- | ----- | -- |
| Unit | every command happy / failure / `is pure`; deck golden text on a 2-element mesh with each material mapping; increment reader on pinned `beampiso`/`beampkin` `.dat.ref`; `limit_load` on synthetic curves (peak, plateau, rising); analytic checks vs JSON | 10, 30, 40, 50, 60–66 |
| Native solver | `beam_large_deflection` vs generator (Lee frame, elastica) | 10, 20 |
| Golden | the draft plans of `validation/plans/` once commands exist | 01 |
| Integration (`server/tests`, needs ccx) | pinned ccx decks `beampiso`, `beampkin`, `beampd` run and compared with their `.dat.ref`; native plans: thick cylinder, cantilever collapse, column imperfection | 30, 40, 41, 50 |
| Harness | PHY-00 `run_benchmarks` over this pack | all A-grade |
| Production gate | US-1 unattended (except human gate); VC-NLS-70 timing | 70 |

Coverage 90/85/90/90 extends to the plugin folder.

## 10. Delivery plan

| M | Content | Depends on | Effort |
| - | ------- | ---------- | ------ |
| M1 | Types, `set_nonlinear_controls`, steps, probes, `set_part_constitutive_set`, analytic checks, `limit_load`/`permanentSet` pure functions, codes | 05 M1–M3, PHY-02 MVP (MaterialModel, constitutive sets, CalculiX writers), placement decision §2.1 | 2 w |
| M2 | INP extension, material mapping, increment reader, `fea_solve` progress, `nonlinear_report`, `check_nonlinear`, VC-NLS-30/40/41/60–66 | M1, 05 M3 | 3 w |
| M3 (V1) | `beam_large_deflection` (native solver), imperfections, limit-load margins, VC-NLS-10/20/50 | M2, 05 buckling | 2 w |
| M4 (V1) | Guide, MCP prompt, UI curve panel, production-gate scenario | M3 | 1.5 w |
| V2 | 3D corotational beams, shells with plasticity, Code_Aster export, `kinematic: chaboche` (PHY-02 MFront route) | PHY-02 V1 | — |

Cross-pack: PHY-06 contact and PHY-16 springback build on `nonlinear_static`, steps and probes defined here.

## 11. Open questions / decisions needed

1. **Placement (§2.1, README §5.1).** Proposal A (core `AnalysisTypeExtension` port, shared with PHY-03 and PHY-02's `MaterialCardWriter`) vs Proposal B (discipline inside the 05 FEA package). Loosening the dependency rule is not an option (L2).
2. **Limit-point rule.** The "tangent < 1 % of initial over 3 increments" classifier is a llull rule with no external source;
   confirm or replace with a reviewer-agreed criterion.
3. **Permanent-set threshold.** 25.305 gives no number; who supplies the "detrimental" threshold (company rule table)?
4. **Imperfection amplitude.** No default by design; should llull ship a company-rule table format (amplitude as a fraction
   of length or thickness, with source) for agents to cite?
5. **Code_Aster hand-off** (V2): MED writing needs a Python library in the bundled CPython; licence and size to check.
6. **NAFEMS NL2 tables and radii** were not obtained (search only); buy NNB or confirm from an independent reproduction
   before using NL2 as a gate.
7. **ccx stdout increment format** must be captured from a real run (fixture) — the manual does not specify it.

## 12. References

- [R1] 14 CFR §25.305 — GPO — https://www.govinfo.gov/content/pkg/CFR-2010-title14-vol1/pdf/CFR-2010-title14-vol1-sec25-305.pdf (accessed 2026-10, search via 05 S1a)
- [R2] CalculiX User's Manual and test suite — https://github.com/Dhondtguido/CalculiX/tree/fd588701edd6a92fde06e99b1bdf01f3b0f80f2c (accessed 2026-10, git)
- [R3] Abaqus Benchmarks NL7 / NL2 (NAFEMS NNB 1989) — https://docs.software.vt.edu/abaqusv2024/English/SIMACAEBMKRefMap/simabmk-c-nl7.htm (accessed 2026-10, search only)
- [R4] NASA-STD-5001B — https://standards.nasa.gov/sites/default/files/standards/NASA/B-w/CHANGE-3/3/2022-10-24-NASA-STD-5001B-w-Change-3-Approved.pdf (search via 05 S2)
- [R6] code_aster `c_pilotage.py` (PILOTAGE types DDL_IMPO, LONG_ARC, PRED_ELAS, DEFORMATION, ANA_LIM) — https://gitlab.com/codeaster/src/-/blob/94bf28a308de5a77587675a598aacdddb722f84e/code_aster/Cata/Commons/c_pilotage.py (accessed 2026-10, raw)
- [R7] suanPan manual, Lee's frame — https://github.com/TLCFEM/suanPan-manual/tree/4af0f1a39fb5abc19962c907aeded0d7eec797b4 (accessed 2026-10, git)
- [R10] Bisshopp & Drucker 1945, QAM 3:272 — https://www.ams.org/qam (citation via search)
- [R11] Abaqus Benchmarks 3.2.14 Cylinder under internal pressure — https://abaqus-docs.mit.edu/2017/English/SIMACAEBMKRefMap/simabmk-c-cylinderunderpress.htm (search)
- [R12] Caprani, Plastic Analysis notes — https://www.colincaprani.com/files/notes/SAIII/Plastic%20Analysis%200809%20-%20Update.pdf (search)
- Repo: `.dependency-cruiser.cjs`, `packages/core/src/lib/frame2d.ts`, `packages/mcp/src/toolsets.ts`, `.claude/rules/architecture.md`, `docs/aerospace/05-fea-cae-handoff/TECHNICAL_SPEC.md`, `docs/physics/00-vv-harness/TECHNICAL_SPEC.md`.
