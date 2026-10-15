# PHY-19: High strain rate, impact and explicit dynamics (external solver hand-off) — technical specification

Gap id **EXP** · status: specification · written 2026-10-15 · functional spec: [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md)
· validation: [`validation/README.md`](validation/README.md) · sources: [`validation/sources.md`](validation/sources.md)

Placement follows [`../README.md`](../README.md) §6.2 and is a **proposal** pending decision §5.1 there. The
Johnson–Cook (and EOS) **law definitions** live in PHY-02 (`model/materialModel.ts`); this pack references them by
name and owns the explicit analysis, the deck writer, the run transport and the result reader.

## 1. Current state in llull

### 1.1 Today's code (verified 2026-10-15)

| Area | What exists | Path | Limit |
| ---- | ----------- | ---- | ----- |
| Material | `Material { name, density, color, metalness, roughness, finish? }` | `packages/core/src/model/types.ts` | no elastic, plastic or rate data |
| Analyses | none; packages `core`, `domain-aec`, `kernel-manifold`, `kernel-occt`, `mcp` | `packages/` | — |
| Motion | kinematic joints, drives, `motion_study` (no forces, no deformation) | `packages/core/src/commands/motion/` | rigid kinematics only |
| Child processes | tracked children killed on shutdown | `server/src/childProcesses.ts` | reusable for the solver run |
| Python bridge | one short-lived CPython per request, timeout, queue of 2 | `server/src/pythonExchange.ts`, `server/python/llull_bridge.py` | PyDyna check could run here (CI only) |
| MCP toolsets | `core, 2d, 3d, measure, parametric, assembly, exchange, building, civil` | `packages/mcp/src/toolsets.ts` | `analysis` added by 05 |

A case-insensitive grep of `packages/`, `server/src`, `src/` (`*.ts`) for `radioss`, `johnson-cook`, `explicit dynamics`
finds no capability.

### 1.2 Baseline assumed

| From | Used here |
| ---- | --------- |
| 05 FEA (`@cae`) | `AnalysisModel` / `AnalysisCase`, `FeaTarget` (`facesNear` …), idealizations, `MeshControls` (Gmsh, `hex_dominant`), probes, the artifact store and its trust model (`record_*` validated against `ctx.feaArtifacts`), `compute_margins` / `dispose_margin` (human gate), `check_analysis`, `FEA_*` codes |
| 08 MAT | `MaterialRecord`, `Provenance`, `Basis`, private libraries |
| PHY-02 | `MaterialModel` kinds referenced by name: `elastic_iso`, `johnson_cook` (A, B, n, C, ε̇0, m, Tm, Tr, valid ranges; optional failure D1–D5), requested addition `hydrodynamic_eos` (V1) |
| PHY-05 | `nonlinear_static` (not required, shares the J–C law) |
| PHY-00 | benchmark runner |

## 2. Target architecture

```
src/ui (explicit panel, energy chart, eps_p overlay)      server/ (transports: export_explicit_deck, explicit_run, explicit_import_results)
        │ dispatch                                           │ spawns: user-installed OpenCourant starter + engine, th_to_csv, anim_to_vtk
        ▼                                                    ▼
src/app  installDefaultPlugins() + physics explicit plugin
        ▼
packages/domain-physics/src (@phys) ── CadPlugin "physics-explicit", toolset "analysis"
   explicit/commands/   set_explicit_controls, set_initial_velocity, add_rigid_wall, delete_rigid_wall, add_imposed_motion,
                        add_contact (V1), add_time_history, record_explicit_results, explicit_quick_check,
                        explicit_report, explicit_energy_check, check_explicit
   explicit/decks/      radStarterWriter.ts, radEngineWriter.ts, kWriter.ts (COULD)       (pure: model + mesh → text)
   explicit/results/    listingReader.ts, thCsvReader.ts, vtkLegacyReader.ts, energy.ts  (pure)
   explicit/quick.ts    wave speeds, CFL, mass scaling, bar impact, Taylor, J-C, scenarios (mirrors the generator)
        ▼ (public APIs, L10)
@cae (05) + packages/core/src/model/analysis.ts  (AnalysisType 'explicit_dynamics'; ExplicitSpec data type; FeSolver 'opencourant' | 'ls_dyna')
```

**Laws respected.** L1: set-up is commands; export / run / import are transports like 05's, feeding back through the
validated `record_explicit_results`. L2: `@phys` has no process or file access. L3: pure. L4: the explicit spec is part
of the `analysis` slice; fields and histories live in the 05 artifact store, the document keeps bounded summaries and
hashes. L5: zod schemas, toolset `analysis`. L6: the server forwards and spawns; deck writing and parsing are pure
functions in `@phys`. L8: steps recorded; results go stale on any input change (the 05 input hash gains the explicit
spec, ICs/BCs and laws). L9: no kernel use beyond 05 targeting. L10: plugin; core gets data types only.

**External solver policy.** OpenCourant is **not bundled** in MVP (AGPL-3.0 plus a binary `hm_reader` dependency of
unclear redistribution status, [R1]); the user installs a release or a container and sets `LLULL_OPENCOURANT`
(directory) or `LLULL_OPENCOURANT_CONTAINER` (image reference). llull never links, patches or redistributes it.

### 2.1 Technical requirements

| Id | Pri | Requirement |
| -- | --- | ----------- |
| TR-EXP-01 | MUST | `AnalysisType` gains **`explicit_dynamics`**; `FeSolver` gains **`opencourant`** (MVP) and **`ls_dyna`** (export only, COULD). `AnalysisCase` gains optional `explicit?: ExplicitSpec`. Optional fields: rides the aerospace v3 envelope, no migration. |
| TR-EXP-02 | MUST | Plugin `physics-explicit` (`toolset: 'analysis'`); `document.validate` checks the spec (finite, units parse, end time > 0, intervals ≤ end time, rigid-wall normal non-zero, added-mass limit present when mass scaling is on). |
| TR-EXP-10 | MUST | `radStarterWriter` writes `<Run>_0000.rad`: `#RADIOSS STARTER`, `/BEGIN` (run name, input version, unit lines from the analysis unit system: `Mg mm s` for N-mm-t-s, `kg m s` for N-m-kg-s; other systems refused `EXP_UNITS_UNSUPPORTED`), `/TITLE`, `/NODE`, elements (`/BRICK`, `/TETRA4`, `/TETRA10`, `/SHELL`, `/SH3N`), `/PART`, `/PROP/…`, `/MAT/…` (elastic or `/MAT/PLAS_JOHNS`), `/FAIL/JOHNSON`, `/GRNOD`, `/INIVEL`, `/GRAV`, `/IMPVEL`, `/BCS`, `/RWALL/PLANE`, `/TH/NODE`, `/TH/RWALL`, `/TH/PART`, `/END`. Card layouts follow the pinned `hm_cfg_files` versions recorded in `solver_format_reference.json`. |
| TR-EXP-11 | MUST | `radEngineWriter` writes `<Run>_0001.rad`: `/RUN/<Run>/1` + end time, `/TFILE` + history interval, `/ANIM/DT` + start / interval, `/ANIM/ELEM/VONM`, `/ANIM/ELEM/EPSP`, `/TH/TITLE` (so `th_to_csv` can derive forces [R2]), `/PRINT`, `/VERS`, time-step and mass-scaling control cards (exact card names pinned at M2 from the cfg / manual; open question §11 Q4). |
| TR-EXP-12 | MUST | Writers are byte-deterministic (fixed number format, sorted ids, `\n` line ends); header comments carry the llull version, analysis id, input hash and mesh hash. |
| TR-EXP-13 | COULD | `kWriter` (LS-DYNA keyword) for `*KEYWORD`, `*NODE`, `*ELEMENT_SOLID`, `*PART`, `*SECTION_SOLID`, `*MAT_ELASTIC`, `*MAT_JOHNSON_COOK`, `*EOS_*`, `*INITIAL_VELOCITY`, `*RIGIDWALL_PLANAR`, `*LOAD_BODY_Z`, `*CONTROL_TERMINATION`, `*DATABASE_*`; verified by parsing with PyDyna in CI [R8]. |
| TR-EXP-20 | MUST | J–C strength view from PHY-02; rate term uses max(ε̇/ε̇0, 1) (no softening below the reference rate), matching VC-EXP-20.c; the writer maps fields to `/MAT/PLAS_JOHNS` (a, b, n, c, EPS_DOT_0, m, T_melt, T_r) [R7]. |
| TR-EXP-21 | MUST | J–C failure view → `/FAIL/JOHNSON` (D1–D5, EPSILON_DOT_0, IFAIL_SH, IFAIL_SO); llull's own damage arithmetic (quick check) is linear accumulation D = Σ Δε/ε_f. |
| TR-EXP-30 | MUST | Quick check wave speeds and CFL: c0 = √(E/ρ), cd = √(E(1−ν)/((1+ν)(1−2ν)ρ)), dt = L_e/cd; L_e per element from the mesh artifact (shortest edge for tets in MVP; open question §11 Q5 on the solver's definition). |
| TR-EXP-31 | MUST | Mass-scaling estimate: per element ρ' = M dt_target²/L_e² with M = E(1−ν)/((1+ν)(1−2ν)); added mass = Σ max(ρ' − ρ, 0) V_e; reported before export and compared with the listing's `MASS ADDED` after the run. |
| TR-EXP-32 | MUST | Bar impact: σ = ρc0v (rigid wall), ρc0v/2 (identical bars), t_c = 2L/c0, v_y = σ_y/(ρc0). |
| TR-EXP-33 | MUST | Taylor estimate σ_d = ρv²(L0 − X)/(2(L0 − L1) ln(L0/X)) as a reported quick check (form grade B [R10]); refuses X ≥ L1 or L1 ≥ L0. |
| TR-EXP-34 | MUST | Scenario arithmetic: KE = ½mv², impulse = mv (normal, no rebound), v = √(2gh), t = √(2h/g), g = 9.80665 m/s², lb = 0.45359237 kg. |
| TR-EXP-40 | MUST | `energy.ts`: error = (E_kin + E_int + E_hg + E_contact − E_kin0 − W_ext)/(E_kin0 + W_ext); hourglass ratio E_hg/E_int; contact ratio E_contact/E_int; added-mass ratio M_added/M0; each with the threshold used and its provenance. |
| TR-EXP-41 | MUST | `listingReader.ts`: parses the cycle table (`CYCLE TIME TIME-STEP ELEMENT … ERROR I-ENERGY K-ENERGY T K-ENERGY R EXT-WORK MAS.ERR TOTAL MASS MASS ADDED`) and the `NORMAL TERMINATION` marker [R1]; tolerant of extra lines (`ANIMATION FILE … WRITTEN`). |
| TR-EXP-42 | MUST | `thCsvReader.ts` reads `th_to_csv` output (titles from `/TH/TITLE`), keeping impulses and derived forces with units; `vtkLegacyReader.ts` reads `anim_to_vtk` legacy VTK ASCII for von Mises, plastic strain and deleted-element flags (field names pinned at M3). |
| TR-EXP-50 | MUST | `server/src/explicitRun.ts` runs Starter then Engine with `trackChild`, `OMP_NUM_THREADS`, `OMP_STACKSIZE`, `RAD_CFG_PATH`, `RAD_H3D_PATH`, `LD_LIBRARY_PATH` (or `PATH` on Windows) as INSTALL.md prescribes [R1]; progress = last cycle time / end time from the listing; timeout and cancel; no shell interpolation. |
| TR-EXP-51 | MUST | Each run artifact records `ToolRecord` (name, version / tag, executable sha256, licence, source URL) and the deck sha256; `record_explicit_results` refuses an artifact whose deck sha256 ≠ the current export (`EXP_RESULTS_FOREIGN`) and stores it review-only. |
| TR-EXP-60 | MUST | Agent-first contract: unit-suffixed fields, `provenance`, `unverified` (OR of law / EOS flags and grade-B sources), `reviewRequired: true`, `certificationEvidence: false`, named defaults with `source` + `defaulted`. |
| TR-EXP-61 | SHOULD | Scenario rows (failed elements per part, penetration flag, health-check fails) register as a 05 margin provider (criterion `impact_damage`, `run_health`) so `dispose_margin` / `check_analysis` handle them. |

## 3. Data model

```ts
// packages/core/src/model/analysis.ts (05) — members added by this pack
export type AnalysisType = 'static' | 'modal' | 'buckling' /* 05 */ | 'explicit_dynamics' /* PHY-19 */;
export type FeSolver = 'calculix' | 'nastran' /* 05 */ | 'opencourant' | 'ls_dyna' /* PHY-19; ls_dyna export-only */;

export interface ExplicitSpec {
  readonly endTimeS: number;
  readonly animationIntervalS: number;
  readonly historyIntervalS: number;
  readonly precision: 'double' | 'single_extended';
  readonly minTimeStepS?: number;                       // run stops (or flags) below it
  readonly timeStepScale?: { readonly value: number; readonly source: string };   // never defaulted silently
  readonly massScaling: { readonly mode: 'none' }
    | { readonly mode: 'selective'; readonly targetTimeStepS: number; readonly maxAddedMassRatio: number };
  readonly gravity?: Vec3;                              // analysis units (mm/s^2 for N-mm-t-s)
  readonly initialVelocities: Record<string, { readonly entityId: EntityId; readonly velocity: Vec3 }>;
  readonly rigidWalls: Record<string, { readonly name: string; readonly point: Vec3; readonly normal: Vec3;
                                        readonly friction: number; readonly moving?: { readonly velocity: Vec3; readonly massKg: number } }>;
  readonly imposedMotions: Record<string, { readonly target: FeaTarget; readonly dof: 'x' | 'y' | 'z';
                                            readonly kind: 'velocity'; readonly curve: readonly (readonly [number, number])[] }>;
  readonly contacts: Record<string, { readonly kind: 'self' | 'surface_to_surface'; readonly master?: FeaTarget;
                                      readonly slave: FeaTarget; readonly friction: number }>;   // V1
  readonly timeHistories: Record<string, { readonly name: string; readonly kind: 'node' | 'part' | 'rigid_wall';
                                           readonly target: string; readonly quantities: readonly string[] }>;
  readonly scenario?: ExplicitScenario;
}

export type ExplicitScenario =
  | { readonly kind: 'bird_strike'; readonly massKg: number; readonly massSource: string;      // e.g. "14 CFR 25.571(e)(1): 4 lb"
      readonly speedMS: number; readonly speedSource: string; readonly substitute: { readonly densityKgM3: number; readonly densitySource: string;
      readonly lengthOverDiameter: number } }
  | { readonly kind: 'drop_test'; readonly heightM: number; readonly heightSource: string; readonly orientation: Vec3 };

// 05 ResultsSummary gains (bounded: ≤ 500 points per history, ≤ 32 histories)
export interface ExplicitResultsSummary {
  readonly tool: ToolRecord; readonly deckSha256: string;
  readonly termination: 'normal' | 'abnormal' | 'timeout' | 'cancelled';
  readonly cycles: number; readonly finalTimeS: number; readonly minTimeStepS: number;
  readonly energy: { readonly errorFinal: number; readonly errorMaxAbs: number; readonly hourglassRatioMax: number;
                     readonly contactRatioMax: number; readonly addedMassRatioMax: number };
  readonly maxVonMises: { readonly value: number; readonly unit: string; readonly at: Vec3; readonly entityId: EntityId };
  readonly maxPlasticStrain: { readonly value: number; readonly at: Vec3; readonly entityId: EntityId };
  readonly failedElements: Record<EntityId, { readonly count: number; readonly firstTimeS?: number }>;
  readonly maxStrainRatePerS?: number; readonly maxTemperatureK?: number;      // for the range guard
  readonly histories: Record<string, { readonly quantity: string; readonly unit: string; readonly tS: readonly number[]; readonly values: readonly number[] }>;
}
export interface ToolRecord { readonly name: 'OpenCourant' | string; readonly version: string; readonly sourceUrl: string;
  readonly executablesSha256: Record<string, string>; readonly licence: string }

// @phys/explicit/lawView.ts — read-only view from the PHY-02 johnson_cook model
export interface JohnsonCookView {
  readonly A: number; readonly B: number; readonly n: number; readonly C: number; readonly m: number;   // stresses in the analysis unit system
  readonly refStrainRatePerS: number; readonly TmK: number; readonly TrK: number;
  readonly failure?: { readonly D: readonly [number, number, number, number, number] };
  readonly validRange: { readonly strainRatePerS: readonly [number, number]; readonly temperatureK: readonly [number, number] };
  readonly provenance: { readonly sourceId: string; readonly basis: string; readonly grade?: 'A' | 'B' | 'C' };
  readonly unverified: boolean; readonly unverifiedReasons: readonly string[];
}
```

`set_part_idealization` (05) gains `sph` with `particleSpacing` (V1). Ids: rigid walls `rw-<step>.<k>`, initial velocity
`iv-…`, time histories `th-…`, contacts `ct-…` (step-scoped, L8).

## 4. Commands

Plugin `physics-explicit`, toolset `analysis`. ✱ = transport (05 pattern, not a registry command).

| Name | Kind | Params sketch | Tags |
| ---- | ---- | ------------- | ---- |
| (05) `create_analysis` | mutating (extended) | `analysisType: 'explicit_dynamics'`, `solver: 'opencourant' \| 'ls_dyna'` | @invariant explicit needs one of these solvers → else `EXP_SOLVER_UNSUPPORTED` |
| `set_explicit_controls` | mutating | `{ analysisId, endTime: {value, unit}, animationInterval, historyInterval, precision?='double', minTimeStep?, timeStepScale?: {value, source}, massScaling?: {mode, targetTimeStep?, maxAddedMassRatio?}, gravity?: {vector, unit} }` | @affects case.explicit · @invariant intervals ≤ end time; selective mass scaling requires `maxAddedMassRatio` · @failure `EXP_CASE_TYPE`, `EXP_TIME_INVALID`, `EXP_MASS_SCALING_LIMIT_MISSING` |
| `set_initial_velocity` | mutating | `{ analysisId, entityId, velocity: {vector, unit} }` | @affects explicit.initialVelocities · @failure part not in the case → `EXP_TARGET_NOT_IN_CASE` |
| `add_rigid_wall` / `delete_rigid_wall` | mutating | `{ analysisId, name, point, normal, friction?=0, moving?: {velocity, mass} }` | @failure zero normal → `EXP_RIGID_WALL_INVALID` |
| `add_imposed_motion` | mutating | `{ analysisId, name, target: FeaTarget, dof, curve: [[tS, value]...], unit }` | @failure non-monotonic time → `EXP_CURVE_INVALID` |
| `add_contact` (V1) | mutating | `{ analysisId, name, kind, master?, slave, friction?=0 }` | @failure unresolved targets (05 codes) |
| `add_time_history` | mutating | `{ analysisId, name, kind: 'node'\|'part'\|'rigid_wall', target, quantities[] }` | bounded to 32 per case |
| `set_explicit_scenario` | mutating | `{ analysisId, kind: 'bird_strike'\|'drop_test', … }` (all inputs with `source`) | @invariant bird mass from rule id or explicit; speed and height always explicit · @failure `EXP_SCENARIO_INPUT_MISSING` |
| `record_explicit_results` | mutating (validated, 05 §4.1 trust model) | `{ analysisId, summary: ExplicitResultsSummary }` | @invariant artifact exists in the store, sha256 matches, summary recomputed equal, deck sha256 = current export · @failure `EXP_RESULTS_FOREIGN` (review-only) or 05 `FEA_ARTIFACT_NOT_FOUND` / `FEA_SUMMARY_MISMATCH` |
| `explicit_quick_check` | query | `{ check?: 'wave_speed'\|'critical_time_step'\|'mass_scaling'\|'bar_impact'\|'taylor_dynamic_yield'\|'johnson_cook_flow'\|'johnson_cook_failure', scenario?: 'bird_strike'\|'drop_test', inputs, material? }` → value(s) with units, formula, inputs, provenance, `unverified` | @invariant identical to `generate_explicit_reference.py` within 1e-12 · @failure `EXP_INPUT_MISSING`, `EXP_LAW_OUT_OF_RANGE` |
| `explicit_report` | query | `{ analysisId, histories?: string[], maxPoints?=500 }` → §5.5 | @invariant refuses stale / missing (05 codes); `reviewRequired`, `certificationEvidence: false` |
| `explicit_energy_check` | query | `{ analysisId \| historyCsv?, hourglassLimit?, contactLimit?, energyErrorLimit?, addedMassLimit? }` | @invariant hourglass limit named default 0.10 [R13]; others no default → warnings |
| `check_explicit` | query | `{ analysisId }` → pass / warn / fail items | AF-20; runs 05 `check_analysis` items first |
| ✱ `export_explicit_deck` | transport | `{ analysisId, format: 'opencourant'\|'ls_dyna', path? }` → `{ files: [{ path, sha256 }] }` | refuses stale mesh, incomplete materials, unsupported units |
| ✱ `explicit_run` | transport | `{ analysisId, threads?, mpiRanks?, timeoutS?=3600 }` | exports, runs Starter + Engine, converts outputs, stores the artifact, dispatches `record_explicit_results`; `EXP_TOOL_MISSING` when not installed |
| ✱ `explicit_import_results` | transport | `{ analysisId, dir }` | reads listing + TH + animation files of a run made elsewhere; deck hash check |
| ✱ `explicit_result_field` | transport (read) | `{ analysisId, field: 'von_mises'\|'eps_p'\|'failed', time: number\|'last' }` | per-vertex scalars for UI/MCP rendering; nothing stored |

## 5. Algorithms

### 5.1 Deck generation

1. Resolve the 05 mesh artifact (hex-dominant or tet), part idealizations and materials; refuse inverted elements
   (05 `FEA_MESH_INVERTED`).
2. Map element types: C3D8 → `/BRICK`, C3D4 → `/TETRA4`, C3D10 → `/TETRA10`, S4 → `/SHELL`, S3 → `/SH3N`
   (cfg files for `/BRICK`, `/TETRA4`, `/TETRA10` seen in `hm_cfg_files` [R1]).
3. One `/PART` + `/PROP` + `/MAT` per (part, material); `/FAIL/JOHNSON` attached to the material id when the law has
   failure data.
4. Node groups (`/GRNOD/NODE`) for every target (initial velocity, imposed motion, rigid-wall slave nodes, histories).
5. Engine file: run time, outputs, `/TH/TITLE`.
6. Header comments with hashes; files sorted and written with fixed formats (`%20.12g`-style within 20-character fields
   for the 2025 cfg layouts).

### 5.2 Quick checks

Formulas of TR-EXP-30…34 and the generator. Example (steel-like test material, VC-EXP-10/11/12): c0 = 5047.54 m/s,
cd = 5856.36 m/s, dt(2 mm) = 3.415e-7 s, σ(10 m/s) = 396.23 MPa.

### 5.3 Run (TR-EXP-50)

```
dir = tmp/<analysisId>/<deckSha8>
write <Run>_0000.rad, <Run>_0001.rad
env: OPENCOURANT_PATH, RAD_CFG_PATH=$OPENCOURANT_PATH/hm_cfg_files, RAD_H3D_PATH=…/extlib/h3d/lib/<os>,
     OMP_STACKSIZE=400m, OMP_NUM_THREADS=<threads>, LD_LIBRARY_PATH (Linux) / PATH (Windows) += extlib/hm_reader/<os>
spawn starter_<os>_gf -i <Run>_0000.rad -np <ranks>           (trackChild, timeout)
spawn engine_<os>_gf -i <Run>_0001.rad   | mpiexec -n <ranks> engine_<os>_gf_ompi -i <Run>_0001.rad
tail <Run>_0001.out → progress (TIME / endTime); stop on timeout / cancel (SIGKILL)
on exit: require "NORMAL TERMINATION"; run th_to_csv on T01, anim_to_vtk on A### (OpenCourant exec dir)
parse (pure readers), build the artifact, store, dispatch record_explicit_results
```

Container variant: `docker|podman run --rm -v <dir>:/work -e OMP_NUM_THREADS ghcr.io/opencourant/opencourant starter -i …`
then `engine -i …` (image names per INSTALL.md [R1]).

### 5.4 Energy and health (TR-EXP-40)

Status rules: `fail` if termination ≠ normal, |energy error| > `energyErrorLimit` (when given), added-mass ratio >
`maxAddedMassRatio`, or (scenario) impulse deviates from m·v by more than the scenario tolerance; `warn` if hourglass or
contact ratio > limit, any limit unset, minimum time step < `minTimeStepS`. Each item lists the threshold, its source and
`defaulted`.

### 5.5 `explicit_report` data shape

```json
{
  "analysisId": "an-7.1", "state": "solved", "unitSystem": "N-mm-t-s",
  "tool": { "name": "OpenCourant", "version": "latest-20261011", "licence": "AGPL-3.0-or-later",
            "sourceUrl": "https://github.com/OpenCourant/OpenCourant", "executablesSha256": { "starter_linux64_gf": "…", "engine_linux64_gf": "…" } },
  "deckSha256": "…", "termination": "normal", "cycles": 465, "finalTimeS": 1.6e-4, "minTimeStepS": 3.4e-7,
  "energy": { "errorFinal": -0.001, "hourglassRatioMax": 0.02, "contactRatioMax": 0.0, "addedMassRatioMax": 0.0,
              "limits": { "hourglass": { "value": 0.1, "source": "rule of thumb, validation/sources.md S13", "defaulted": true },
                          "energyError": null, "addedMass": null } },
  "maxVonMisesMPa": { "value": 401.0, "atMm": [5, 5, 0] }, "maxPlasticStrain": { "value": 0.0, "atMm": [0, 0, 0] },
  "failedElements": {},
  "histories": { "wall_impulse": { "quantity": "force_z", "unit": "N", "points": 465 } },
  "quickChecks": [{ "check": "bar_impact", "sigmaPa": 396232255.123, "ratioRunToClosedForm": 1.01 }],
  "unverified": false, "reviewRequired": true, "certificationEvidence": false,
  "reviewReason": "impact response supports structural and certification decisions",
  "summary": "Bar impact run finished normally; energy error −0.1 %; wall stress within 1 % of ρc₀v. Computed by llull, not approved — needs a qualified engineer."
}
```

### 5.6 Numerical tolerances

| Item | Value |
| ---- | ----- |
| Quick checks vs generator | 1e-12 relative |
| Deck numbers | 12 significant digits, re-read equality 1e-12 |
| Listing parse | exact string → float |
| Run vs closed form | 3 % (bar plateau, duration), 0.5 % (drop kinematics), 5 % (bird impulse) — llull acceptance |

## 6. Interop & persistence

| Format | Direction | Implementation | Licence of dependency |
| ------ | --------- | -------------- | --------------------- |
| OpenCourant / Radioss `.rad` (Starter `_0000`, Engine `_0001`) | out | `@phys/explicit/decks` (pure TS) | — (format only) |
| LS-DYNA `.k` (COULD) | out | `kWriter.ts`; PyDyna parse check in CI | PyDyna MIT (test only) |
| Engine listing `_0001.out` | in | `listingReader.ts` | — |
| Time history (T01) → CSV | in | OpenCourant `th_to_csv` (user install) + `thCsvReader.ts` | Tools MIT |
| Animation (A###) → VTK legacy | in | `anim_to_vtk` + `vtkLegacyReader.ts` | Tools MIT |
| Solver | runtime | user-installed OpenCourant / container | AGPL-3.0-or-later; `hm_reader` binary status open |
| Document | persist | `analysis.cases[*].explicit` + bounded `ExplicitResultsSummary`; fields in the 05 artifact store | — |

## 7. CLI / MCP / UI surfaces

- **CLI**: registry commands as `llull <command>`; transports as `llull export_explicit_deck … --save`, `llull explicit_run`,
  `llull explicit_import_results dir=…` (05 pattern, no subcommand group). `llull guide` gains an explicit section: unit
  systems allowed, how the time step is set by the smallest element, why mass scaling needs a limit, the health checks,
  the scenario inputs that must come from the owner.
- **MCP**: toolset `analysis`; prompt `impact_screening` (quick check → set-up → export / run → report → check).
- **UI** (review only): explicit panel, energy and history charts, `eps_p` / failed-element overlays, tool card.
- **render_view**: 05's `analysisId` + `field` gain `eps_p`, `failed`, and `time`.

### 7.1 Stable error and check codes (AF-11)

| Code | Severity | When | Ids / path | Remediation |
| ---- | -------- | ---- | ---------- | ----------- |
| `EXP_CASE_TYPE` | error | explicit command on a non-explicit case | analysis id | `create_analysis analysisType=explicit_dynamics` |
| `EXP_SOLVER_UNSUPPORTED` | error | explicit case with another solver | analysis id | `solver: opencourant` |
| `EXP_UNITS_UNSUPPORTED` | error | unit system other than N-mm-t-s / N-m-kg-s | analysis id | set document units mm or m |
| `EXP_TIME_INVALID` | error | end time ≤ 0 or an interval > end time | param path | fix times |
| `EXP_MASS_SCALING_LIMIT_MISSING` | error | selective mass scaling without `maxAddedMassRatio` | param path | give the limit (owner / company rule) |
| `EXP_TARGET_NOT_IN_CASE` | error | IC / wall / history on a part not in the case | entity id | `set_part_idealization` first |
| `EXP_RIGID_WALL_INVALID` | error | zero normal or friction < 0 | wall name | fix the wall |
| `EXP_CURVE_INVALID` | error | imposed-motion curve not increasing in time | param path | sort the curve |
| `EXP_MATERIAL_INCOMPLETE` | error | part without elastic constants / law, or J–C without ε̇0 | entity, record | complete the PHY-02 model |
| `EXP_LAW_OUT_OF_RANGE` | error (query) / fail (check) | strain rate or temperature outside the law range | element ids or path, extreme value | supply a law valid there |
| `EXP_LAW_UNVERIFIED` | warning (not suppressible) | law / EOS unverified or grade B | record id | confirm constants against the primary source |
| `EXP_NO_EXCITATION` | fail | no IC, imposed motion, gravity or load | analysis id | add one |
| `EXP_SMALL_TIME_STEP` | warning | element dt < `minTimeStepS` or 1e-3 × median | element ids | remesh the small elements |
| `EXP_ADDED_MASS_HIGH` | fail | added-mass ratio > limit | part ids | refine time step target or remesh |
| `EXP_HOURGLASS_HIGH` | warning | hourglass / internal > limit | part ids | finer mesh, other hourglass control, fully integrated elements |
| `EXP_CONTACT_ENERGY_HIGH` | warning | contact / internal > limit | contact ids | check penetration, friction |
| `EXP_ENERGY_ERROR_HIGH` | fail | \|energy error\| > `energyErrorLimit` | analysis id | inspect the listing; smaller time step |
| `EXP_ENERGY_LIMIT_UNSET` | warning | energy-error or added-mass limit not given | analysis id | ask the owner / company rule |
| `EXP_ABNORMAL_TERMINATION` | fail | no `NORMAL TERMINATION` | log tail | read the listing |
| `EXP_TOOL_MISSING` | error | OpenCourant / container not found | tool | install a release or container; set `LLULL_OPENCOURANT` |
| `EXP_RUN_TIMEOUT` | error | timeout reached | analysis id | longer timeout or coarser mesh |
| `EXP_RESULTS_FOREIGN` | warning | imported results from a different deck hash | analysis id | re-export and re-run; review-only |
| `EXP_SCENARIO_INPUT_MISSING` | error | bird speed / drop height / source missing | param path | ask the owner for the value and its source |
| `EXP_FAILED_ELEMENTS` | fail | scenario with eroded elements | part ids, counts | qualified reviewer disposition |
| `EXP_IMPULSE_MISMATCH` | fail | rigid-wall impulse vs m·v beyond tolerance | wall name | check bird model, contact, output interval |
| `EXP_INPUT_MISSING` | error | quick check without an input | key | supply it with its unit |
| (05) `FEA_HUMAN_GATE`, `FEA_RESULTS_STALE`, `FEA_MESH_INVERTED` | — | reused | — | — |

### 7.2 Agent-first compliance

| AF | Where |
| -- | ----- |
| AF-01/02/03 | registry commands + 05-style transports; descriptions state units; guide section |
| AF-04 | `{value, unit}` on every time, speed, height, gravity |
| AF-05 | whole set-up in one plan (`validation/plans/*`) |
| AF-10/12 | `explicit_report` §5.5; decks and fields only via `--save` / artifact store |
| AF-11 | §7.1 |
| AF-13 | deterministic decks (TR-EXP-12) |
| AF-20 | `check_explicit` |
| AF-21 | energies, ratios, histories, failed-element counts as numbers |
| AF-22 | `render_view field=eps_p` |
| AF-23 | validation CLI harness |
| AF-30 | health thresholds and range guards as data with sources |
| AF-31 | FR-EXP-22 (only the hourglass limit has a named default) |
| AF-32 | FR-EXP-24 |
| AF-33 | FR-EXP-23 (+ `certificationEvidence: false`) |
| AF-34 | 05 `dispose_margin` on `impact_damage` / `run_health` rows |
| AF-35 | `provenance` in quick checks and reports; `ToolRecord` |
| AF-40 | progress from the listing, `--timeout`, re-run cached by deck hash |
| AF-41 | `EXP_TOOL_MISSING` with install hint; export works offline |
| AF-42 | `--dry-run` on set-up commands |

## 8. Performance & robustness budgets

| Budget | Target |
| ------ | ------ |
| Quick check | ≤ 5 ms |
| Deck export, 200k elements | ≤ 5 s, streaming writer |
| Listing / CSV parse | ≥ 50 MB/s |
| Run | solver-bound; llull overhead ≤ 2 s plus converters — TBD measure on the reference desktop (bar plan) |
| Summary | ≤ 500 points × 32 histories in the document |
| Robustness | every failure is a no-op with a code; killed runs leave no results; a foreign result is never used for dispositions |

## 9. Test strategy

| Layer | Tests | VC |
| ----- | ----- | -- |
| Unit (`tests/unit/physics/explicit/*`) | every command happy / failure / `is pure`; quick checks vs `expected_results.json`; energy checker on the CSV fixture; listing parser on the synthetic listing; writer golden text on a one-element model; determinism | 01, 02, 10–12, 20–22, 30–32, 40–42, 56, 57, 60–65 |
| Contract | `toToolSchemas()` snapshot; plugin validate / restore | 01 |
| Golden | the four plans once commands exist | 01 |
| Integration (`server/tests`, needs OpenCourant) | Starter acceptance, bar and drop runs, import, range guard | 50–55, 66 |
| CI Python | PyDyna parse of `.k` (COULD) | 54 |
| Quality (`quality:physics`) | VC-EXP-50/51 table | 50, 51 |

Coverage 90/85/90/90 extends to `packages/domain-physics/src/**`.

## 10. Delivery plan

| M | Content | Depends on | Effort |
| - | ------- | ---------- | ------ |
| M1 | `quick.ts`, `explicit_quick_check`, `energy.ts`, `listingReader.ts`, unit tests | PHY-02 J–C types | 1 w |
| M2 | `AnalysisType` / `FeSolver` members, `ExplicitSpec`, set-up commands, `.rad` writers, determinism tests, `export_explicit_deck` | 05 M2 (mesh artifact), PHY-02 | 2.5 w |
| M3 | `explicit_run` (local + container), converters, readers, `record_explicit_results`, `explicit_report`, `explicit_energy_check`, `check_explicit`, integration VC-50…55 | M2, OpenCourant install on CI | 2.5 w |
| M4 | plans to golden, CLI harness, guide, MCP prompt, UI review overlays | M3 | 1.5 w |
| V1 | contacts, SPH bird with EOS (PHY-02 addition), scenario templates, shells with J–C | PHY-02 EOS | 3 w |
| V2 | LS-DYNA `.k` export + PyDyna check, blade-out templates, composites | 06 CMP, PHY-08 | 3 w |

MVP ≈ 7.5 w.

## 11. Open questions / decisions needed

1. **Solver dependency.** OpenCourant is weeks old after the OpenRadioss takedown [R1][R3]. Accept it as the default
   target, or design the writer against the Radioss format only and treat any compatible engine as a user choice?
2. **Licensing.** AGPL-3.0-or-later solver plus the binary `hm_reader` "recovered from a community-donated source
   checkout" [R1]: legal decision before any bundling or cloud hosting (AGPL network clause).
3. **macOS.** No macOS build listed [R1]: container-only, remote run, or unsupported?
4. **Engine control cards** for time-step scale, minimum time step and mass scaling: pin exact card names and defaults from
   the cfg files / manual at M2 (not verified here).
5. **Characteristic length** per element type used by the Engine (for llull's pre-run dt estimate).
6. **EOS / substitute-bird model** as a PHY-02 law kind (`hydrodynamic_eos`): PHY-02 owner to accept; bird density and EOS
   values need a primary source (Wilbeck reports not reached [R14]).
7. **J–C constants**: a human extracts Lesuer / Kay tables with locators [R9]; until then no constants in any public library.
8. **Hourglass default** 0.10 is a rule of thumb [R13]: keep it as a named default or require it explicitly?
9. **Results artifact size** for large animation sets: cap and down-sampling policy (05 cap 512 MB).

## 12. References

- [R1] OpenCourant — https://github.com/OpenCourant/OpenCourant/tree/b19ec63f372474aa52dbbff41bd2e5288cf5b04e (accessed 2026-10)
- [R2] OpenCourant Tools — https://github.com/OpenCourant/Tools/tree/c58c805696f7364f0efe80b5dd1585f70670232e (accessed 2026-10)
- [R3] Phoronix (2026-10-04) — https://phoronix.com/news/OpenRadioss-OpenCourant (accessed 2026-10, search)
- [R4] Altair Radioss help — https://help.altair.com/hwsolvers/rad/topics/solvers/rad/starter_input_r.htm (accessed 2026-10, search)
- [R6] Johnson & Cook (1985) — https://doi.org/10.1016/0013-7944(85)90052-9 (citation)
- [R7] Radioss cfg `/MAT/PLAS_JOHNS`, `/FAIL/JOHNSON` — in [R1]
- [R8] PyDyna 0.12.1 — https://pypi.org/project/ansys-dyna-core/0.12.1/ (accessed 2026-10)
- [R9] Lesuer DOT/FAA/AR-00/25; Kay DOT/FAA/AR-03/57 — https://www.osti.gov/biblio/15006359 (accessed 2026-10, search)
- [R10] Taylor (1948) — https://doi.org/10.1098/rspa.1948.0081 (citation)
- [R13] Energy-balance practice — https://ftp.lstc.com/anonymous/outgoing/jday/faq/energy_balance (accessed 2026-10, search)
- [R14] Wilbeck — https://apps.dtic.mil/sti/pdfs/ADA061313.pdf (accessed 2026-10, search)
- Others ([R5], [R11], [R12]): [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md) §11 and [`validation/sources.md`](validation/sources.md).
- L1 llull: `.claude/rules/architecture.md`, `.claude/context/command-layer.md`, `packages/core/src/model/types.ts`, `packages/mcp/src/toolsets.ts`, `server/src/childProcesses.ts`, `docs/aerospace/05-fea-cae-handoff/TECHNICAL_SPEC.md`.
