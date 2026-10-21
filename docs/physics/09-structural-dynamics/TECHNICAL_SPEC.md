# PHY-09: Structural dynamics beyond modal — technical specification

Gap id **DYN** · status: M1–M3 + RS-7 built 2026-10-19 (§13 as built) · written 2026-10-15 · functional spec: [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md)
· validation: [`validation/README.md`](validation/README.md) · sources: [`validation/sources.md`](validation/sources.md)

## 1. Current state in llull

| Area | What exists (today or after the aerospace packs) | Path / owner | Limit for dynamics |
| ---- | ------------------------------------------------ | ------------ | ------------------ |
| Dynamics in code today | Nothing. `grep -ril "damping\|psd\|spectral density\|frequency_response\|shock"` over `packages/*/src` and `server/src` returns no file | — | No damping, spectra, FRF, random, shock or transient anywhere |
| Kinematic motion | `motion_study`, joints, drive relations: kinematic sweeps without time, mass or force | `packages/core/src/commands/motion/*` | Not dynamics; PHY-10 adds forces |
| Animation | `animate` clips: declarative spin / oscillate, "No physics" (file header) | `packages/core/src/commands/motion/animation.ts` | Presentation only |
| FE analysis (aerospace 05, specified) | `AnalysisType = 'static' \| 'modal' \| 'buckling'`, `AnalysisCase`, `ResultsSummary.frequenciesHz`, INP writer (`*FREQUENCY`), FRD/DAT readers (EIGENVALUE OUTPUT table), artifact store, trust model for `record_fea_results`, `compute_margins`, `check_analysis`, stale hashing | `../../aerospace/05-fea-cae-handoff/TECHNICAL_SPEC.md` §3–§5 (`packages/domain-cae`, `@cae`) | Modal only; no damping, sweep, base motion, histories |
| Materials (08 MAT + PHY-01/02, specified) | `MaterialRecord` with `PropertyValue`s; PHY-01 `model/propertyModel.ts` (`PropertyModel`), `model/propertyCatalog.ts` (`PROPERTY_CATALOG`), `model/propertyModelEval.ts` (`resolvePropertyModel` / `evaluatePropertyModel` / `tabulatePropertyModel`); PHY-02 `model/materialModel.ts` (`MaterialModel`, `ConstitutiveSet`) | `packages/core/src/model/*` (proposed) | No damping property in the catalogue yet; PHY-09 adds one row and reads it through the PHY-01 API (TR-DYN-12) |
| V&V harness (PHY-00, specified) | `run_benchmarks`, `check_convergence`, time-step refinement in V1 | `../00-vv-harness/` | PHY-09 cases plug into it |
| Solver | Bundled CalculiX (05). The pinned manual documents `*STEADY STATE DYNAMICS`, `*MODAL DYNAMIC`, `*DYNAMIC`, `*MODAL DAMPING`, `*DAMPING`, `*BASE MOTION`, `*AMPLITUDE` [R1]. A search of the manual finds **no** PSD / random-response or response-spectrum procedure (the only "random" hits are `*ROBUST DESIGN` random fields) | `doc/CalculiX.tex` at commit fd58870 | Random response and SRS must be computed by llull |

Facts read in the CalculiX manual [R1] that this design depends on:

- `*MODAL DYNAMIC` and `*STEADY STATE DYNAMICS` need modes from a previous `*FREQUENCY,STORAGE=YES` step; the
  `.eig` file carries frequencies, modes, stiffness and mass matrices. Both are perturbation steps: earlier loading
  is removed.
- `*STEADY STATE DYNAMICS` second line: lower and upper frequency (cycles/time), number of points n (default 20,
  minimum 2), bias (default 3, minimum 1). With m eigenfrequencies in range it writes nm − m + n points, clustered
  at the eigenfrequencies by the bias. Output is complex (real then imaginary), or magnitude and phase with `PU`,
  `PHS`, `PNT` under `*NODE FILE` (not under `*NODE PRINT`). `HARMONIC=NO` expands a periodic time signal in
  Fourier terms.
- `*MODAL DAMPING`: `MODAL=DIRECT` (default; lines "lowest mode, highest mode, ζ"), or `RAYLEIGH` (line ",,α,β"),
  with ζ_j = α/(2ω_j) + βω_j/2. Direct damping is not allowed with nonzero SPCs in `*MODAL DYNAMIC` (it is in SSD).
- `*DAMPING,ALPHA=,BETA=` is global Rayleigh for `*DYNAMIC`; `*DAMPING,STRUCTURAL=ζ` is a material card giving
  element force iζ[K]{x} in SSD. (The manual's example text says "2·10⁻⁴" for `BETA=2.e-3`; the card value is what
  counts. Recorded as a manual typo in sources.md.)
- `*BASE MOTION,DOF=,AMPLITUDE=,TYPE=DISPLACEMENT|ACCELERATION` (default ACCELERATION) applies to every node with a
  homogeneous `*BOUNDARY` on that DOF; DOF 1–3 only; **acceleration only in steady-state dynamics**.
- `*DYNAMIC` uses the HHT α-method; `ALPHA` in [−1/3, 0], default −0.05; `DIRECT` fixes the increment;
  `EXPLICIT` selects explicit integration.
- `*AMPLITUDE` pairs are time–value in transient steps and frequency–value in SSD; loads without an amplitude are
  step loads in `*DYNAMIC` / `*MODAL DYNAMIC`.
- The frequency step writes participation factors P_i = {U_i}ᵀ[M]{R}, effective modal mass P_i², totals and
  fractions per rigid-body direction to `.dat` (seen in `beamdy8.dat.ref`).
- `*NODE FILE` / `*NODE PRINT` keys include `U`, `V` (velocity), `A` (acceleration), `PU`, `S`, `PHS`.

## 2. Target architecture

> **Placement erratum (coordinator, 2026-10-15).** `.dependency-cruiser.cjs` rule `plugins-and-kernels-depend-on-core-only` forbids `packages/domain-physics` importing `@cae` (or any other package). Wherever this spec says `@phys` imports or extends `@cae`, read: the plugin registers its analysis type, deck fragments and result readers through the **core analysis extension port** proposed in [`../03-thermal-analysis/TECHNICAL_SPEC.md`](../03-thermal-analysis/TECHNICAL_SPEC.md) §2; fallback: the discipline lives inside the 05 FEA package. Decision pending in [`../README.md`](../README.md) §5.


```
src/ui (FRF / ASD / SRS plots, damping badges)       server/ (05 transports fea_mesh / fea_solve learn the new types)
        │ dispatch                                            │ spawns bundled ccx; runs pure @phys post-processing;
        │                                                     │ nodal contraction → `llull-compute post` (RS1, §2.1)
        ▼                                                     ▼
src/app installDefaultPlugins() + caePlugin + physicsDynamicsPlugin
        ▼
packages/domain-physics/src/dynamics   (@phys/dynamics)   CadPlugin "physics-dynamics", toolset "analysis"
   commands/: set_dynamic_damping, set_frequency_sweep, set_base_excitation, define_vibration_spectrum,
              define_load_history, set_transient_controls, assign_load_history (V1),
              equivalent_static_load_case, analysis_report, check_dynamics,
              sdof_response, psd_rms, shock_response_spectrum, damping_coefficients
   decks/:    inpDynamics.ts         (extends @cae inpWriter: STORAGE=YES, SSD / MODAL DYNAMIC / DYNAMIC steps)
   results/:  datParticipation.ts    (participation + effective mass tables), frdComplex.ts (PU / PHS blocks)
   math/:     sdof.ts, psd.ts, srs.ts, modalFrf.ts, randomResponse.ts, peakFactor.ts   (pure, deterministic)
   library/:  spectra.ts             (sourced ASD library, each entry with source + grade)
        ▼ (public APIs only: core model/lib/commands/schema; @cae public types)
packages/domain-cae/src (@cae, aerospace 05)   AnalysisModel, AnalysisCase, writers, readers, artifacts, margins
packages/core/src/model  propertyCatalog.ts (+1 row structuralLossFactor) · propertyModelEval.ts (PHY-01 API, read only) · materialModel.ts (PHY-02, unused here)
```

Laws respected:

- **L1/L5.** Every set-up change is a registry command; solving stays the 05 transport `fea_solve`, which applies
  results through 05 `record_fea_results` (trust model 05 §4.1). The dynamic summary is part of `ResultsSummary`
  and is recomputed from the artifact before it is accepted.
- **L2.** `@phys` imports core public API and `@cae` public types; no process, file or network code (server only).
- **L3.** Pure commands, `is pure` tests.
- **L4.** Dynamic inputs live in the 05 `analysis` slice (`AnalysisCase.dynamics`) and a new optional
  `CadDocument.physics.dynamics` library slice for spectra and load histories shared by cases.
- **L6.** `server/` spawns ccx and calls the pure `@phys` math (or, for the nodal field, the `llull-compute post` job,
  §2.1); no dynamics logic in the server.
- **L8.** Each command records a `FeatureStep`; spectra and histories are document data, so a replay re-derives
  the same results inputs; staleness extends 05 TR-FEA-06 with the dynamic inputs.
- **L9.** No kernel need beyond 05 (targets on exact faces).
- **L10.** Plugin in `packages/domain-physics` (README §6.2 proposal), alias `@phys/*`.

### 2.1 Stack amendment (RS1, 2026-10-18)

Decision [RS1](../../decisions/RS1-native-compute.md) step **RS-7** (medium, Rust CPU) moves the random and SSD
post-processing contraction (modes × frequencies × nodes) to `llull-compute post` (crate `llull-post`). CalculiX stays the
solver; the per-probe math, quick checks, SRS and deck writing stay in TS. `math/randomResponse.ts` and `modalFrf.ts` stay the
reference: the native field must match them (VC-DYN-48). Nothing in `packages/*` imports native code; the job runs inside the
05 `fea_solve` transport and its output enters the document only through `record_fea_results` (trust model 05 §4.1). Rust
CPU, not GPU, because the field numbers are recorded and must be bit-reproducible (RS1 §2 rule 3).

**Requirements (technical)**

| Id | Pri | Requirement |
| -- | --- | ----------- |
| TR-DYN-01 | MUST | `@phys/dynamics` plugin `{ name: 'physics-dynamics', toolset: 'analysis', commands, document }` validates and restores `physics.dynamics` and `AnalysisCase.dynamics`. |
| TR-DYN-02 | MUST | Adds the `AnalysisType` members `frequency_response`, `random_response`, `transient_dynamic` (owned by this pack, README §6.2); 05 `create_analysis` accepts them when the plugin is installed (05 keeps an extensible `AnalysisType` registry, open question 1). |
| TR-DYN-03 | MUST | A dynamic case always carries a modal basis `{ modes?: number; fMaxHz?: number }`; the INP writer emits a `*FREQUENCY,STORAGE=YES` step before the dynamic step in the same deck (initial conditions are not supported in MVP, so the single-deck form is valid [R1]). |
| TR-DYN-10 | MUST | Damping union (§3) with exactly one active model per case; `rayleigh_from_ratios` is resolved to α, β at command time (§5.2) and both the inputs and the result are stored. |
| TR-DYN-11 | MUST | The applied ζ per kept mode is computed after the solve (Rayleigh: ζ_j = α/(2ω_j) + βω_j/2; structural: ζ_eq = η/2 at resonance) and stored in `DynamicSummary.dampingPerMode`. |
| TR-DYN-12 | MUST | Structural damping reads the material property `structuralLossFactor` (η, dimensionless) through the PHY-01 consumer API: `resolvePropertyModel(record, { property: 'structuralLossFactor' })` then `evaluatePropertyModel(record, model, { T: caseTemperature })` (`model/propertyModelEval.ts`); the scalar goes to `*DAMPING,STRUCTURAL=η` (CalculiX takes one value per material). PHY-09 adds the row `{ name: 'structuralLossFactor', dimension: '1', canonicalUnit: '1', positive: false, ownerPack: 'PHY-09' }` to `model/propertyCatalog.ts` (value checked ≥ 0 by `set_dynamic_damping`); it defines no other material field. A refusal from the API (absent property, out of range) ⇒ `DYN_MATERIAL_NO_DAMPING` carrying the PHY-01 code; the evaluation's `unverified` propagates. |
| TR-DYN-20 | MUST | `math/sdof.ts`: receptance, mobility, accelerance, transmissibility, relative-motion FRFs (§5.1); exact peak and half-power points. |
| TR-DYN-22 | SHOULD | Half-power Q from any computed FRF magnitude (linear interpolation on the dense grid of §5.4). |
| TR-DYN-30 | MUST | INP dynamic steps (§5.6) match the manual keyword syntax; byte-identical output for identical input (05 TR-FEA-40). |
| TR-DYN-31 | MUST | `datParticipation.ts` parses PARTICIPATION FACTORS, EFFECTIVE MODAL MASS, TOTAL EFFECTIVE MASS and FRACTION OF TOTALS tables (fixed layout seen in `beamdy8.dat.ref`). |
| TR-DYN-40 | MUST | `math/randomResponse.ts`: response ASD by modal superposition with exact per-mode FRFs, integrated on the adaptive grid (§5.4); output rms of each probe quantity, nodal max rms, zero-crossing rate ν₀⁺ = √(m₂/m₀) (spectral moments). The nodal field (every node × component) may run in `llull-compute post` (TR-DYN-44); the TS module stays the probe path, the small-mesh path and the reference. |
| TR-DYN-41 | MUST | Base-excitation transfer functions use the participation factors of the frequency step and the probe mode-shape values from FRD; absolute acceleration and relative displacement both reported. |
| TR-DYN-42 | MUST | Peak factor `{ value, source, defaulted, rationale }`; default 3 with rationale "Gaussian 3-sigma (P(\|x\| > 3σ) = 0.27 %)". |
| TR-DYN-43 | MUST | `math/psd.ts`: exact log-log segment integration (§5.3); spectra validated (sorted, positive, ≥ 2 points). |
| TR-DYN-44 | SHOULD | RS1 RS-7: `fea_solve` hands the random / SSD nodal contraction (modes × frequencies × nodes × components) to `llull-compute post random\|ssd <job-folder>` (crate `llull-post`, Rust CPU, rayon over nodes, fixed reduction order per node, RS1 §2 rule 3). Same grid, FRFs and Simpson rule as §5.4. Output: a nodal rms field artifact; `record_fea_results` recomputes the summary (nodal max and its location) from it. Missing binary → TS path within the budget of §8, else `DYN_POST_TOO_LARGE` naming the node count. |
| TR-DYN-50 | MUST | `math/srs.ts`: Smallwood ramp-invariant recursive filter for absolute acceleration (and relative displacement, pseudo-velocity) (§5.5); maximax, positive, negative. |
| TR-DYN-51 | MUST | SRS sampling guard: Δt ≤ 1/(10 f_max) or refuse; residual tail of 1.5 periods of the lowest frequency appended with zeros (or a stated shorter tail with a warning). |
| TR-DYN-60 | MUST | `frdComplex.ts` reads SSD output: real/imaginary pairs or `PU`/`PHS` magnitude-phase blocks per frequency step (05 FRD reader extended). |
| TR-DYN-61 | SHOULD (V1) | Transient output: probe histories (`*NODE PRINT` at probes, `*EL PRINT`), peak with time; history arrays only in the artifact. |
| TR-DYN-70 | MUST | Staleness: 05 `analysisInputHash` additionally covers damping, sweep, base excitation, spectra and histories referenced by the case. |
| TR-DYN-80 | MUST | Agent-first contract (AF-10/11/31–35): every dynamic result has unit-suffixed fields, `provenance`, `unverified`, `reviewRequired`; codes §7.1. |

## 3. Data model

```ts
// packages/domain-physics/src/dynamics/model.ts  (plugin types; core references none of them)
import type { Vec3 } from '@core/model/types';

/** Added to @cae AnalysisType by this pack (README §6.2). */
export type DynamicAnalysisType = 'frequency_response' | 'random_response' | 'transient_dynamic';

export interface SourceNote { readonly citation: string; readonly grade?: 'A' | 'B' | 'C'; readonly url?: string }

export type DampingModel =
  | { readonly model: 'modal'; readonly ratios: readonly { fromMode: number; toMode: number; zeta: number }[]; readonly source: SourceNote }
  | { readonly model: 'rayleigh'; readonly alpha: number /* 1/s */; readonly beta: number /* s */; readonly source: SourceNote }
  | { readonly model: 'rayleigh_from_ratios'; readonly f1Hz: number; readonly f2Hz: number; readonly zeta1: number; readonly zeta2: number;
      readonly alpha: number; readonly beta: number /* resolved at command time */; readonly source: SourceNote }
  | { readonly model: 'structural_material'; readonly propertyName: 'structuralLossFactor' };  // PHY-01 catalogue row, read via resolvePropertyModel / evaluatePropertyModel

export interface FrequencySweep { readonly fMinHz: number; readonly fMaxHz: number; readonly pointsPerInterval: number; readonly bias: number }

export type BaseExcitation =
  | { readonly kind: 'acceleration'; readonly direction: 'x' | 'y' | 'z'; readonly amplitudeG?: number; readonly spectrum?: string }
  | { readonly kind: 'displacement'; readonly direction: 'x' | 'y' | 'z'; readonly history: string /* load history name, mm vs s */ };

export interface VibrationSpectrum {
  readonly name: string;
  readonly quantity: 'acceleration';
  readonly unit: 'g2/Hz' | '(m/s2)2/Hz';
  readonly points: readonly (readonly [fHz: number, level: number])[];   // log-log interpolation between points
  readonly source: SourceNote;                                            // library entries carry grade
  readonly unverified: boolean;                                           // true unless grade A
}

export interface LoadHistory {
  readonly name: string;
  readonly unit: 'factor' | 'N' | 'N*mm' | 'mm' | 'g';
  readonly timeS: readonly number[];
  readonly values: readonly number[];
  readonly source: SourceNote | { readonly fromPhy10: { studyHash: string; jointId: string; component: string } };
  readonly unverified: boolean;
}

export interface TransientControls {
  readonly method: 'modal' | 'direct';
  readonly durationS: number; readonly dtS: number;
  readonly hhtAlpha?: number;     // direct only; [-1/3, 0]; absent = CalculiX default -0.05, reported as defaulted
}

export interface PeakFactor { readonly value: number; readonly source: string; readonly defaulted: boolean; readonly rationale: string }

/** Stored on the 05 AnalysisCase as `dynamics` (optional field added by the plugin's document hook). */
export interface CaseDynamics {
  readonly basis: { readonly modes?: number; readonly fMaxHz?: number };
  readonly damping?: DampingModel;
  readonly sweep?: FrequencySweep;
  readonly base?: BaseExcitation;
  readonly loadHistories?: Readonly<Record<string /* 05 load id */, string /* history name */>>;
  readonly transient?: TransientControls;
  readonly modalTruncationThreshold?: number;   // fraction of total effective mass, no default (AF-31)
}

/** Document library slice, optional: CadDocument.physics?.dynamics (absent until first command). */
export interface DynamicsLibrary {
  readonly spectra: Readonly<Record<string, VibrationSpectrum>>; readonly spectrumOrder: readonly string[];
  readonly histories: Readonly<Record<string, LoadHistory>>; readonly historyOrder: readonly string[];
}

/** Added to @cae ResultsSummary.dynamics; recomputed from the artifact by the pure summariser (05 TR-FEA-33). */
export interface DynamicSummary {
  readonly type: DynamicAnalysisType;
  readonly modesKept: number; readonly highestModeHz: number;
  readonly massParticipation: Readonly<Record<'x' | 'y' | 'z', number>>;     // cumulative fraction
  readonly dampingPerMode: readonly { mode: number; fHz: number; zeta: number }[];
  readonly probes: readonly ProbeDynamicResult[];
  readonly nodalMax?: { readonly quantity: string; readonly rms: number; readonly unit: string; readonly at: Vec3 };
  readonly frequencyPointsHz?: readonly number[];      // CalculiX SSD points (cross-check)
  readonly unverified: boolean; readonly unverifiedReasons: readonly string[];
  readonly reviewRequired: true; readonly reviewReason: string;
}
export type ProbeDynamicResult =
  | { kind: 'frf'; probe: string; quantity: string; unit: string; peaks: readonly { fHz: number; magnitude: number; phaseDeg: number; mode: number }[];
      qHalfPower?: number }
  | { kind: 'random'; probe: string; quantity: string; unit: string; rms: number; peak: number; peakFactor: PeakFactor;
      zeroUpcrossingHz: number; spectrumGrms: number }
  | { kind: 'transient'; probe: string; quantity: string; unit: string; max: number; tMaxS: number; min: number; tMinS: number };
```

Ids: spectra and histories are keyed by user names (unique, `[a-z0-9_]+`); no step-scoped ids are minted except
the 05 load case created by `equivalent_static_load_case` (`fl-<step>.<k>`, 05 convention).

**Document version.** `physics.dynamics` is optional and absent until used; the `analysis` slice gains an optional
field. No migration (aerospace v3 envelope unchanged); persistence validation delegates to the plugin `validate`.

## 4. Commands

Plugin `physics-dynamics`, toolset `analysis`. All are pure `defineCommand`s; ✱ marks 05 transports reused.

| Name | Kind | Params sketch (units in descriptions) | Tags |
| ---- | ---- | ------------------------------------- | ---- |
| (05) `create_analysis` | mutating | `analysisType` gains the three dynamic members; `modes` or `fMaxHz` (Hz) | @failure `DYN_BASIS_MISSING` if neither |
| `set_dynamic_damping` | mutating | `{ analysisId, model: 'modal'\|'rayleigh'\|'rayleigh_from_ratios'\|'structural_material', ratios?, alpha? (1/s), beta? (s), f1Hz?, f2Hz?, zeta1?, zeta2?, source: { citation, grade? } }` | @affects case.dynamics.damping · @invariant 0 ≤ ζ < 1, α ≥ 0, β ≥ 0, f1 < f2; `source.citation` non-empty except `structural_material` · @failure `DYN_DAMPING_INVALID` |
| `set_frequency_sweep` | mutating | `{ analysisId, fMinHz, fMaxHz, pointsPerInterval?=20, bias?=3 }` | @invariant 0 < fMin < fMax, points ≥ 2, bias ≥ 1 (CalculiX limits [R1]) · @failure `DYN_SWEEP_INVALID` |
| `set_base_excitation` | mutating | `{ analysisId, direction: 'x'\|'y'\|'z', kind: 'acceleration'\|'displacement', amplitudeG?, spectrum?, history? }` | @invariant acceleration only for frequency/random cases · @failure `DYN_BASE_ACCEL_TRANSIENT`, `DYN_SPECTRUM_UNKNOWN`, `DYN_BASE_NO_CONSTRAINT` (no homogeneous constraint on that DOF) |
| `define_vibration_spectrum` | mutating | `{ name, points?: [fHz, level][], unit?='g2/Hz', library?: 'gevs_component_qual'\|'gevs_component_accept', source? }` | @affects physics.dynamics.spectra · @invariant exactly one of points / library; library entries copy source + grade · @failure `DYN_SPECTRUM_INVALID` (unsorted, ≤ 0, < 2 points), `DYN_NAME_TAKEN` |
| `define_load_history` | mutating | `{ name, unit, timeS: number[], values: number[], source }` | @invariant equal lengths, strictly increasing time, finite · @failure `DYN_HISTORY_INVALID` |
| `set_transient_controls` | mutating (V1) | `{ analysisId, method, durationS, dtS, hhtAlpha? }` | @invariant hhtAlpha ∈ [−1/3, 0]; dtS ≤ 1/(20 f_highestKept) warned otherwise · @failure `DYN_TRANSIENT_INVALID` |
| `assign_load_history` | mutating (V1) | `{ analysisId, loadId, history }` | @affects case.dynamics.loadHistories · @failure unknown load / history |
| (PHY-10) `export_joint_load_history` | mutating (V1), owned by PHY-10 | `{ study, jointId, component: 'Fx'\|…\|'Mz', name }` | @affects physics.dynamics.histories · @invariant the PHY-10 study is re-computed and its `studyHash` matches (PHY-10 TR-RBD-60); the history keeps `source.fromPhy10` and the `unverified` flag · @failure `RBD_STUDY_STALE` (PHY-10 code) |
| `equivalent_static_load_case` | mutating | `{ analysisId, probe? \| nodalMax?: true, peakFactor?: number, targetAnalysisId, direction?, loadCase }` | @affects target static case loads (05 `FeaLoad` gravity kind, category `limit`) · @invariant source results not stale; provenance records case, spectrum, damping, peak factor (named, AF-31) · @failure `DYN_RESULTS_STALE`, `DYN_MILES_NOT_ANSWER`, `DYN_TARGET_NOT_STATIC` |
| `analysis_report` | query | `{ analysisId, probes?: string[] }` → `data: DynamicSummary` + state (05 states) | read-only |
| `export_response_psd` | ✱ transport-read (V1) | `{ analysisId, probe, quantity, path? }` → CSV (Hz, ASD, unit) | heavy output only via `--save` (AF-12); input to PHY-07 |
| `check_dynamics` | query | `{ analysisId }` → `{ status, items[{ code, severity, ids, message, remediation }], reviewRequired: true }` | AF-20, codes §7.1 |
| `sdof_response` | query | `{ fnHz, zeta? \| Q?, input: { kind: 'harmonic' } \| { kind: 'random', asdG2PerHz? \| spectrum? \| points? } \| { kind: 'shock', halfSine \| history } , bandHz? }` | pure; returns FRF peak, Miles and exact rms (answerOfRecord: 'exact'), relative displacement rms (mm), 3σ; @failure `DYN_DAMPING_UNSET` when neither zeta nor Q |
| `psd_rms` | query | `{ spectrum? \| points?, unit?, bandHz? }` → `{ grms, segments[{ f1Hz, f2Hz, slopeDbPerOct, areaG2 }], grade, unverified }` | pure |
| `shock_response_spectrum` | query | `{ input: { kind: 'half_sine', peakG, durationS } \| { kind: 'history', timeS[], accelG[] }, Q, frequenciesHz? \| octaveFraction?, fMinHz?, fMaxHz? }` → `{ fHz[], maximax[], positive[], negative[], method: 'smallwood_ramp_invariant', dtS }` | pure; @failure `DYN_SAMPLING_TOO_COARSE`, `DYN_HISTORY_INVALID` |
| `damping_coefficients` | query | `{ fromRatios: { f1Hz, f2Hz, zeta } \| { alpha, beta, fHz[] } }` → `{ alpha, beta, zetaAt[] }` | pure |
| ✱ `fea_mesh`, `fea_solve`, `fea_export` (05) | transport | unchanged params | `fea_solve` writes the dynamic deck, parses `.dat`/`.frd`, runs `@phys` post-processing, dispatches `record_fea_results` with `dynamics` |

Command descriptions follow AF-02 (what, when, units, refusals, next command). Example for `sdof_response`:
"Single-degree-of-freedom quick check. Give the natural frequency fnHz (Hz) and damping as zeta (fraction of
critical) or Q (= 1/(2 zeta)); there is no default damping. kind 'random' integrates the base ASD (g²/Hz) exactly
and also returns Miles' equation for comparison; the exact value is the answer of record. Use before and after a
random_response analysis; it never replaces one."

## 5. Kernel / algorithms

No geometry-kernel work beyond 05 (targets on exact faces). All math below is pure TypeScript in
`@phys/dynamics/math`, double precision, deterministic (fixed iteration counts, no `Math.random`).

### 5.1 SDOF and modal FRFs (TR-DYN-20, TR-DYN-41)

With r = f/fₙ and ζ the viscous ratio:

```
receptance        k·H(r) = 1 / (1 − r² + 2iζr)              peak r = √(1 − 2ζ²), |kH|max = 1/(2ζ√(1 − ζ²)), |kH(1)| = 1/(2ζ) = Q
transmissibility  T(r)  = (1 + 2iζr) / (1 − r² + 2iζr)       |T(√2)| = 1 for every ζ
relative motion   z/a_b = −1 / (ωₙ²(1 − r² + 2iζr))
half-power        r₁,₂² = 1 − 2ζ² ∓ 2ζ√(1 − ζ²)             Q_hp = 1/(r₂ − r₁)
```

Modal superposition with mass-normalised modes φⱼ (CalculiX normalisation [R1]) and participation Γⱼ = Pⱼ
(the `.dat` value for the excitation direction):

```
force input:   u(ω) = Σⱼ φⱼ φⱼᵀ F / (ωⱼ² − ω² + 2iζⱼωⱼω)
base input:    z(ω)/a_b = −Σⱼ φⱼ Γⱼ / (ωⱼ² − ω² + 2iζⱼωⱼω)          relative displacement
               a_abs(ω)/a_b = 1 + Σⱼ φⱼ Γⱼ ω² / (ωⱼ² − ω² + 2iζⱼωⱼω)
stress:        σ(ω) = Σⱼ σⱼ (modal stress from FRD) × modal coordinate
Rayleigh:      2ζⱼωⱼ = α + βωⱼ²     structural:  ωⱼ² → ωⱼ²(1 + iη)
```

VC-DYN-06 shows the single-mode form reproducing CalculiX's own modal coordinate at all nine beamdy8 points to
4 × 10⁻⁷ (limited by the 7 printed digits), which is the evidence that llull's post-processing and CalculiX's SSD
use the same convention.

### 5.2 Damping helpers (TR-DYN-10, TR-DYN-11)

Two target ratios ζ₁ at ω₁ and ζ₂ at ω₂: solve [1/(2ω₁) ω₁/2; 1/(2ω₂) ω₂/2][α β]ᵀ = [ζ₁ ζ₂]ᵀ. Equal ratios
give α = 2ζω₁ω₂/(ω₁ + ω₂), β = 2ζ/(ω₁ + ω₂) (VC-DYN-05). The report always lists ζ per kept mode, because
Rayleigh damping dips between the anchor frequencies and grows outside them.

### 5.3 PSD integration (TR-DYN-43)

Between breakpoints (f₁, W₁) and (f₂, W₂) the level is W₁(f/f₁)ⁿ with n = ln(W₂/W₁)/ln(f₂/f₁) (slope
10·n·log₁₀2 dB/oct). Area = W₁f₁/(n + 1)·((f₂/f₁)ⁿ⁺¹ − 1), or W₁f₁ ln(f₂/f₁) for n = −1. g rms = √ΣA. The
library GEVS qualification breakpoints integrate to 14.1356 g (prints as 14.1 [R4a]); acceptance to 9.995 g.

### 5.4 Random response (TR-DYN-40)

1. Read modes (FRD), frequencies and participation (DAT) from the modal step of the solved deck.
2. Build the transfer function H_q(f) of each probe quantity q from §5.1 (closed form, any frequency).
3. Integrate S_q(f) = |H_q(f)|² W(f) over the spectrum band on an adaptive grid: log-spaced base grid of 200
   points per decade, refined around every kept mode to ≥ 40 points inside [fⱼ(1 − 5ζⱼ), fⱼ(1 + 5ζⱼ)]; Simpson
   per sub-interval; convergence check by halving the grid (relative change ≤ 1e-4, else `DYN_PSD_GRID_NOT_CONVERGED`).
4. rms = √m₀, ν₀⁺ = √(m₂/m₀) with mₖ = ∫ fᵏ S df; peak = peak factor × rms.
5. Nodal max rms: same per node for the requested field (von Mises rms is reported as the rms of the
   component-wise stress PSD combination given in PHY-07's input contract; MVP reports component rms and the
   **equivalent von Mises rms** by the Segalman-type quadratic form only once PHY-07 fixes the definition — open
   question 4; until then component rms only).
6. Single-input, fully correlated base motion only in MVP (V2: cross-spectra).

The CalculiX SSD run with unit base acceleration over the same band is kept as a cross-check: the llull transfer
function at the CalculiX points must agree within 1 % (VC-DYN-20/31 pattern).

Miles' equation √(π/2 · fₙ · Q · W(fₙ)) [R5] is computed by `sdof_response` and reported beside the exact SDOF
integral √(W fₙ π (1 + 4ζ²)/(4ζ)) for white input (VC-DYN-07); it is never the answer of record.

### 5.5 Shock response spectrum (TR-DYN-50, TR-DYN-51)

Smallwood ramp-invariant recursive filter [R7], coefficients as implemented in pyYeti `absacce` [R8]:

```
ζ = 1/(2Q), ω_d = ωₙ√(1 − ζ²), E = e^(−ζωₙΔt), B = ω_dΔt, C = E cos B, S = E sin B
b = [1 − S/B, 2(S/B − C), E² − S/B],  a = [1, −2C, E²];   y_k = b₀x_k + b₁x_{k−1} + b₂x_{k−2} − a₁y_{k−1} − a₂y_{k−2}
```

SRS(fₙ) = max |y| over the input plus a residual tail (maximax); positive/negative maxima reported separately.
The generator checks this filter against the exact piecewise solution of the SDOF under a half-sine to 1.7 × 10⁻⁶
(VC-DYN-13); the low-frequency asymptote is ωₙΔV (VC-DYN-14).

### 5.6 Deck writing (TR-DYN-30)

```
** llull … analysis <name> type random_response units N-mm-t-s inputHash <h>
… 05 model data (*NODE, *ELEMENT, *MATERIAL [+ *DAMPING,STRUCTURAL=η for structural_material], *BOUNDARY on base targets)
*AMPLITUDE,NAME=A_<history|base>        (time–value, or frequency–value for SSD; flat 1.0 over the sweep for unit base input)
*STEP
*FREQUENCY,STORAGE=YES
<modes>
*NODE FILE
U
*EL FILE
S
*END STEP
*STEP
*STEADY STATE DYNAMICS                    | *MODAL DYNAMIC                 | *DYNAMIC[,ALPHA=<a>][,DIRECT]
<fMin>,<fMax>,<pointsPerInterval>,<bias>  | <dt>,<duration>                | <dt>,<duration>
*MODAL DAMPING[,RAYLEIGH]                 (modal: "m1,m2,ζ" lines; rayleigh: ",,α,β")   (*DYNAMIC: *DAMPING,ALPHA=,BETA= in model data)
*BASE MOTION,DOF=<d>,AMPLITUDE=A_base[,TYPE=DISPLACEMENT]
*CLOAD / *DLOAD [,AMPLITUDE=A_<h>]
*NODE PRINT,NSET=P_<probe>   U (and V, A in transients)
*NODE FILE  PU | U        *EL FILE  PHS | S
*END STEP
```

Constraints for base motion are written in model data (before the steps), as the manual advises [R1]. Random
cases write the same SSD step with unit base acceleration; llull's own transfer functions are the result of
record and the SSD output is the cross-check.

### 5.7 Numerical tolerances

| Item | Value |
| ---- | ----- |
| SDOF closed forms vs implementation | 1e-12 relative |
| PSD segment integration | exact closed form; 1e-12 relative |
| Random-response grid convergence | 1e-4 relative change on halving |
| SRS vs exact half-sine solution | 0.5 % gate (generator agreement 1.7e-6) |
| Native FE vs analytic beam (VC-DYN-21) | 5 % (shear, rotary inertia, mesh) |
| Re-run of pinned CalculiX decks | 1e-4 relative (05 convention) |

## 6. Interop & persistence

| Format | Direction | Implementation |
| ------ | --------- | -------------- |
| CalculiX INP dynamic steps | out | `@phys/dynamics/decks/inpDynamics.ts` extending 05 `inpWriter` |
| CalculiX DAT participation tables, FRD complex / PU blocks | in | `datParticipation.ts`, `frdComplex.ts` |
| Nastran BDF SOL 111 / 112 (FREQ1, RLOAD1, TABLED1, TABDMP1, RANDPS) | out (V1) | extends 05 `bdfWriter`; cards checked with pyNastran as in 05 (layouts to verify, open question 5) |
| Response ASD CSV (Hz, level, unit header) | out | `export_response_psd` → PHY-07 input |
| Spectrum / history import | in | plain JSON / CSV through `define_vibration_spectrum` / `define_load_history` params (no file reading in commands) |
| Document | persist | `physics.dynamics` slice + `AnalysisCase.dynamics`; artifacts in the 05 store |

## 7. CLI / MCP / UI surfaces

- **CLI**: registry commands as `llull <command> …`; 05 transports unchanged. `llull guide` gains a dynamics
  section: g = 9.80665 m/s², g²/Hz, damping must be explicit, 3-sigma is a named default, Miles is a quick check,
  minimal random-response plan (AF-03).
- **MCP**: `analysis` toolset gains the commands; prompt `random_vibration_quick_check` (spectrum → sdof → FE →
  equivalent static → margins → check).
- **UI** (review only): FRF magnitude/phase, response ASD and SRS plots (log-log, `dataviz` rules), damping per
  mode table, provenance badges, 05 disposition dialog.

### 7.1 Stable error and check codes (AF-11)

| Code | Severity | When | Ids / path | Remediation |
| ---- | -------- | ---- | ---------- | ----------- |
| `DYN_BASIS_MISSING` | error | dynamic case without `modes` or `fMaxHz` | analysis id | set `modes` (e.g. enough to pass 1.5 × fMax) |
| `DYN_DAMPING_UNSET` | error | solve or quick check without damping | analysis id / param `zeta` | `set_dynamic_damping` with a cited value, or pass `zeta`/`Q` |
| `DYN_DAMPING_INVALID` | error | ζ ∉ [0, 1), α or β < 0, f1 ≥ f2, empty citation | param path | correct the value; cite its source |
| `DYN_MATERIAL_NO_DAMPING` | error | `structural_material` but `resolvePropertyModel` refuses `structuralLossFactor` (absent, out of range) | material id, PHY-01 code | add a `structuralLossFactor` property model (PHY-01 / 08 commands) or use modal damping |
| `DYN_POST_TOO_LARGE` | error | nodal random / SSD field above the TS budget and `llull-compute` absent (RS1) | node count | install the desktop bundle (`llull-compute`), or request probes only |
| `DYN_SWEEP_INVALID` | error | fMin ≥ fMax, points < 2, bias < 1 | param path | correct the sweep |
| `DYN_SWEEP_UNSET` | error | frequency/random case without sweep | analysis id | `set_frequency_sweep` |
| `DYN_BASE_ACCEL_TRANSIENT` | error | acceleration base motion in a transient | analysis id | give a displacement history (CalculiX limit [R1]) |
| `DYN_BASE_NO_CONSTRAINT` | error | base direction has no homogeneous constraint | analysis id, direction | add a fixed / displacement-zero constraint on the base faces |
| `DYN_SPECTRUM_INVALID` | error | unsorted, non-positive, < 2 points, unknown unit | spectrum name, index | fix the breakpoint |
| `DYN_SPECTRUM_UNKNOWN` | error | spectrum name not defined | name | `define_vibration_spectrum` |
| `DYN_SPECTRUM_UNVERIFIED` | warning (not suppressible) | spectrum grade below A or user `unverified` | spectrum name | replace with the primary standard values |
| `DYN_HISTORY_INVALID` | error | lengths differ, time not increasing, non-finite | history name, index | fix the table |
| `DYN_SAMPLING_TOO_COARSE` | error | SRS Δt > 1/(10 f_max) | input | resample or lower fMaxHz |
| `DYN_BAND_ABOVE_MODES` | warning | excitation top > 1.5 × highest kept mode | analysis id | increase `modes` |
| `DYN_MODAL_TRUNCATION` | warning | cumulative effective mass < threshold | direction | increase `modes`; residual vectors (V2) |
| `DYN_TRUNCATION_THRESHOLD_UNSET` | warning | no threshold given | analysis id | set `modalTruncationThreshold` (company rule) |
| `DYN_PSD_GRID_NOT_CONVERGED` | error | adaptive grid fails 1e-4 | probe | report; increase points (internal bug signal) |
| `DYN_RESULTS_STALE` | error | inputs changed since solve | analysis id, changed inputs | `fea_mesh` / `fea_solve` |
| `DYN_MILES_NOT_ANSWER` | error | Miles result used as an equivalent load | param path | run a random_response case |
| `DYN_TARGET_NOT_STATIC` | error | equivalent load target is not a static case | target id | create a static case |
| `DYN_TRANSIENT_INVALID` | error | hhtAlpha ∉ [−1/3, 0], dt ≤ 0, duration ≤ dt | param path | correct |
| `DYN_HISTORY_UNKNOWN` | error | `assign_load_history` names a history that does not exist (e.g. a PHY-10 export not yet made) | name | `define_load_history` or PHY-10 `export_joint_load_history` |
| `DYN_REVIEW_PENDING` | warning | result used for a qualification decision without disposition | case id | qualified reviewer disposition (05 `dispose_margin`) |
| `DYN_HUMAN_GATE` | error | agent tries to complete a qualification disposition | row id | hand over to the qualified reviewer |

### 7.2 Agent-first compliance

| AF | Where |
| -- | ----- |
| AF-01/02/03 | registry commands (§4), descriptions with units, `llull guide` section |
| AF-04 | Hz, s, g (stated as 9.80665 m/s²), g²/Hz, mm, MPa in every schema description |
| AF-05 | all set-up in one plan (`validation/plans/*.plan.json`) |
| AF-10 | `DynamicSummary`, quick-check `data` with unit-suffixed fields |
| AF-11 | §7.1 |
| AF-12 | histories / ASD tables only via `--save` |
| AF-13 | fixed grids, fixed iteration counts, deterministic deck |
| AF-20 | `check_dynamics` |
| AF-21 | peaks, rms, SRS as numbers; plots optional |
| AF-23 | `validation/README.md` CLI harness |
| AF-30 | spectrum library and the 1.5 × band rule held as data with sources |
| AF-31 | no default damping; peak factor named; HHT α default named |
| AF-32 | spectrum/damping/material `unverified` propagation |
| AF-33 | `reviewRequired` on every dynamic result |
| AF-34 | 05 disposition with human signature (`DYN_HUMAN_GATE`) |
| AF-35 | provenance: formula, spectrum, damping, modes kept |
| AF-36 | plain-language summary order |
| AF-40/41 | 05 transports (progress, timeout, bundled ccx) |
| AF-42 | `--dry-run` on mutating set-up commands |

## 8. Performance & robustness budgets

| Budget | Target |
| ------ | ------ |
| Pure quick checks (`sdof_response`, `psd_rms`, `damping_coefficients`) | ≤ 20 ms |
| `shock_response_spectrum`, 30 frequencies, 50 k samples | ≤ 300 ms |
| Random post-processing, 30 modes, 50 probes, nodal max over 50 k nodes, 3 components | ≤ 10 s (TBD: measure); nodal part in `llull-compute post` when installed |
| Native nodal contraction (`llull-post`), largest mesh in the same time | target ≥ 10× the TS node count (target, TBD — measure, VC-DYN-48) |
| SSD solve 50 k nodes, 30 modes, 200 points | ≤ 60 s (TBD: measure, production gate) |
| Memory | modal stress per node streamed from FRD; never more than one mode field resident per component |

## 9. Test strategy (VC mapping)

| Layer | Tests | VC |
| ----- | ----- | -- |
| Unit `tests/unit/physics/dynamics/*` | every command happy / failure / `is pure`; sdof, psd, srs, damping math against `expected_results.json` | 01–05, 07–14, 17 |
| Unit (fixtures by hash) | DAT participation parser and FRD complex reader on pinned beamdy8 / beamdy10bm outputs | 06, 22, 31 |
| Contract | `toToolSchemas()` snapshot grows; AnalysisType extension; plugin validate/restore | 01 |
| Golden | the three draft plans once commands exist; replay equality | 20, 21, 40 |
| Integration (server, needs ccx) | re-run pinned decks (1e-4), native beamdy8 model (2 %), EB strip random (5 %), FV32 modal | 15, 20, 21, 30–32 |
| Native (`npm run native:check`; `server/tests` with `llull-compute`) | `llull-post` random / SSD contraction vs `randomResponse.ts` on the VC-DYN-21 case and seeded synthetic modal bases | 48 |
| Agent-first | codes, named defaults, unverified, review, human gate | 40–44 |
| PHY-00 harness | `run_benchmarks` reads this pack's `expected_results.json` | all A-grade |

## 10. Delivery plan

| M | Content | Depends on | Effort |
| - | ------- | ---------- | ------ |
| M1 | Plugin skeleton, data model, damping / sweep / spectrum / history commands, quick checks (sdof, psd, srs, damping), check_dynamics static items, unit tests VC-01…14 | 05 M1 (AnalysisModel), PHY-00 harness skeleton | 2.5 w |
| M2 | INP dynamic steps, DAT participation + FRD complex readers, `frequency_response` end-to-end, VC-06, 17, 20, 22 | 05 M3 (ccx, readers) | 2.5 w |
| M3 | Random response post-processing (adaptive grid, base input, probes, nodal max), equivalent static load case into 05 margins, VC-21, 40–44 | M2 | 3 w |
| M4 | MCP prompt, guide section, golden plans, quality:dyn, production-gate scenario | M3 | 1 w |
| RS-7 | `llull-post` random / SSD nodal contraction, `fea_solve` hand-off, nodal rms artifact, VC-DYN-48 | M3, RS-0 (`solver/` workspace) | 1.5 w (share of RS1 RS-7) |
| M5 (V1) | Transient modal + direct, histories, PHY-10 joint histories, SRS of probe history, stress ASD export to PHY-07, BDF SOL 111/112 | M4, PHY-10 M3, PHY-07 | 3 w |
| V2 | Cross-spectra, response spectrum analysis, residual vectors, acoustic loads from PHY-20 | PHY-20 | — |

Total MVP ≈ 9 weeks of one engineer-equivalent agent lane (Lane 1 core/plugin + Lane 4 for transport changes).

## 11. Open questions / decisions needed

1. **AnalysisType extension point.** 05 declares a closed union; this pack needs plugins to add members. Proposal:
   05 keeps `AnalysisType` as a string union in `@cae` plus a plugin-contributed registry of extra types (and
   validation of `create_analysis` against it). Needs the 05 owner's agreement.
   **Decided (2026-10-19, as built):** the placement-erratum fallback — the discipline lives inside the 05 package (`packages/domain-cae`,
   plugin `cae`), like PHY-03/04/05/07; `frequency_response` and `random_response` are members of the core `AnalysisType` union
   (`transient_dynamic` waits for M5). No extension registry was needed.
2. **Frequency-dependent loss factor.** PHY-01 property models can carry η(T); a dependence on frequency would need a
   `frequency` variable in PHY-01's `PropertyVariable` set (owner PHY-01). MVP evaluates η at the case temperature only.
3. **GEVS / NASA-STD-7001 values** must be read from the primary documents by a human before the library entries
   lose their B grade (fetch was blocked from this session).
4. **Equivalent von Mises rms** definition for random stress: coordinate with PHY-07 (fatigue owns the stress
   PSD contract).
5. **Nastran SOL 111/112 card subset** (FREQ1, RLOAD1, TABLED1, TABDMP1, RANDPS): layouts not verified; check with
   pyNastran before V1.
6. **Modal truncation default threshold.** Industry practice often cites a percentage of effective mass, but no
   source was verified, so llull ships no default (warning only).
7. **Single-deck vs two-deck** CalculiX runs: initial conditions in `*MODAL DYNAMIC` need the frequency step in a
   separate deck [R1]; MVP has zero initial conditions, V1 decides whether to support non-zero ones.

8. **Native field outputs (RS1).** Should the `llull-post` job also produce the stress ASD per node for PHY-07 spectral
   fatigue (M5), or only rms fields? Proposal: rms fields in RS-7, ASD export with M5.
   **Decided (2026-10-19, as built):** rms fields only in RS-7 (12 components per node, §13); the per-node stress ASD export stays with M5.

## 12. References

- [R1] CalculiX CrunchiX User's Manual, `doc/CalculiX.tex` — G. Dhondt, GPL-2.0 — https://github.com/Dhondtguido/CalculiX/tree/fd588701edd6a92fde06e99b1bdf01f3b0f80f2c (accessed 2026-10)
- [R2] CalculiX test decks beamdy1/3/8/10bm, beamdynamic — same commit, `test/` (accessed 2026-10)
- [R3] GSFC-STD-7000B GEVS — NASA — https://standards.nasa.gov/standard/GSFC/GSFC-STD-7000 (accessed 2026-10, search)
- [R4a] Vibration Research, GEVS case study quoting Table 2.4-3 — https://vibrationresearch.com/?p=20548 (accessed 2026-10, search)
- [R4b] wobbl `modal.py` (MIT) — https://github.com/sohan-bhat/wobbl/blob/1df4cee6a480a8e3aadbe029f614db3508933bb0/src/wobbl/life/modal.py (accessed 2026-10)
- [R5] J. W. Miles, J. Aeronautical Sciences 21(11):753–762, 1954 (citation, accessed 2026-10, search)
- [R6] Thampi & Vidyasagar, NASA NTRS 19900015329 — https://ntrs.nasa.gov/citations/19900015329 (accessed 2026-10, search)
- [R7] D. Smallwood, 51st Shock and Vibration Bulletin, 1980 — as cited in [R8]
- [R8] pyYeti `srs.py`, BSD-3 — https://github.com/twmacro/pyyeti/blob/39c5af215e0e45f1ebce9a83040ba95541b3f6a9/pyyeti/srs.py (accessed 2026-10)
- [R9] NASA-STD-7001 — https://standards.nasa.gov/standard/NASA/NASA-STD-7001 (accessed 2026-10, search)
- [R13] Abaqus Benchmarks FV32 — https://abaqus-docs.mit.edu/2017/English/SIMACAEBMKRefMap/simabmk-c-fv32.htm (accessed 2026-10, search)
- [R14] Altair OS-V:0440 — https://help.altair.com/hwsolvers/os/topics/solvers/os/cantilevered_tapered_membrane_fv32_r.htm (accessed 2026-10, search)
- [R15] Miranda, Ferencz, Hughes 1989 (HHT implementation reference of CalculiX) — as cited by [R1]
- llull: `.claude/rules/architecture.md`, `.claude/context/command-layer.md`, `../../aerospace/05-fea-cae-handoff/TECHNICAL_SPEC.md`, `../00-vv-harness/TECHNICAL_SPEC.md`, `../README.md`

## 13. As built — M1, M2, M3 and RS-7 (2026-10-19)

**Placement.** Open question 1 fallback: everything lives in the 05 package (`packages/domain-cae/src/dynamics/`, plugin `cae`, toolset
`analysis`), data types in `packages/core/src/model/structuralDynamics.ts`: `AnalysisCase.dynamics` (`CaseDynamics`), the library
`AnalysisModel.vibration` (spectra, time histories, equivalent-load provenance; the spec's `CadDocument.physics.dynamics`),
`ResultsSummary.dynamics` (`DynamicSummary`) and `FeResultsArtifact.nodalRms`. `AnalysisType` gains `frequency_response` and `random_response`;
`ProbeQuantity` gains `a_x/y/z` and `u_x/y/z_rel`; `propertyCatalog` gains `structuralLossFactor` (owner PHY-09).

| Item | Where |
| ---- | ----- |
| SDOF FRFs, half-power, Miles, exact white-noise integrals (§5.1) | `dynamics/math/sdof.ts` |
| PSD log-log segments, band clipping (§5.3) | `dynamics/math/psd.ts` |
| Smallwood SRS, half-sine and sampled histories (§5.5) | `dynamics/math/srs.ts` |
| Rayleigh from ratios, zeta per mode, damping terms of D_j (§5.2) | `dynamics/math/damping.ts` |
| Gaussian exceedance, named 3-sigma peak factor (TR-DYN-42) | `dynamics/math/gaussian.ts` |
| Adaptive grid + Simpson, modal quadratic forms, nodal rms reference (§5.4, TR-DYN-40) | `dynamics/math/randomResponse.ts` |
| Set-up / library / quick-check / report commands | `dynamics/{setupCommands,libraryCommands,quickChecks,srsCommand,check,reportCommands}.ts` |
| Deck: constraints in model data, `*AMPLITUDE A_BASE`, `*FREQUENCY, STORAGE=YES`, `*STEADY STATE DYNAMICS`, `*MODAL DAMPING`, `*BASE MOTION`, `*DAMPING,STRUCTURAL=eta` (§5.6) | `dynamics/deck.ts` (+ one `DisciplineTable.dynamics` row in `decks/deckBuilder.ts`) |
| DAT tables: participation, effective modal mass, total effective mass, fraction of totals, modal coordinates per SSD frequency (TR-DYN-31) | `results/datReader.ts` (`DAT_TITLES`), `dynamics/results/modalData.ts` |
| FRD complex output: DISP + DISPI / STRESS + STRESSI per SSD frequency (block names read in CalculiX `frd.c` at the pinned commit) | `dynamics/results/modalData.ts` (`steadyStatePoints`) |
| Summary recomputed from the artifact by `record_fea_results` and every trusted read | `dynamics/summary.ts` (called from `results/summary.ts`) |
| Nodal rms field: job builder, TS reference, artifact field | `dynamics/nodalField.ts` |
| `llull-compute post random` (RS-7) | `solver/crates/llull-post/src/random.rs` |
| fea_solve post-step: native when installed, TS within budget, else `DYN_POST_TOO_LARGE` before CalculiX | `server/src/native/randomField.ts`, `server/src/fea/feaSolve.ts` (`randomPost`) |

**Commands as built** (names that differ from §4 are marked): `set_dynamic_damping`, `set_frequency_sweep`, `set_base_excitation`
(acceleration only; `kind` accepted for the plans), **`set_dynamic_basis`** (new: modes, fMaxHz, modalTruncationThreshold),
`define_vibration_spectrum`, **`delete_vibration_spectrum`**, **`define_time_history`** / **`delete_time_history`** (PHY-07 owns
`define_load_history`), **`describe_vibration_library`**, `sdof_response`, `psd_rms`, `damping_coefficients`, `shock_response_spectrum`,
`analysis_report`, `equivalent_static_load_case`, **`check_structural_dynamics`** (the rigid-body `check_dynamics` of
`domain-dynamics/src/commands` owns that name). `create_analysis` takes the two types with `modes` or `fMaxHz` (`DYN_BASIS_MISSING` without
either; `fMaxHz` alone extracts 100 modes and keeps those up to fMaxHz — CalculiX computes the requested count, not a range, manual
`*FREQUENCY`). `add_result_probe` refuses quantities of the wrong case type (`DYN_PROBE_QUANTITY`).

**Result of record and conventions.** random_response: llull's transfer functions on the adaptive grid are the answer; the steady-state step
is the CalculiX cross-check at 1 g (it writes only probe prints, no full-field FRD). frequency_response: CalculiX's complex steady-state output
is the answer (peaks, phase, nearest mode, half-power Q by linear interpolation between output points). Relative motion is damped (textbook,
generator of VC-DYN-21). Finding recorded in a test: with `*BASE MOTION` and Rayleigh alpha, CalculiX applies alpha M to the ABSOLUTE base
velocity — its beamdy10bm modal coordinates equal -G (1 - i alpha / w) / D to 2e-6 over all nine points, -G / D misses by > 5 %. llull keeps
the relative-damping convention; the CalculiX cross-check of a Rayleigh base-motion case therefore differs by that factor (modal damping
ratios are unaffected).

**Nodal field (RS-7, TR-DYN-44).** 12 components per node (u_x/y/z_rel, a_x/y/z, s_xx..s_zx when the frequency step wrote S), units
length / g / stress. The contraction is reorganised as quadratic forms: A_jl = sum_k w_k Re(g_jk conj g_lk) is built once (K x J^2), then each
node and component costs J^2 — mathematically the modes x frequencies x nodes contraction of §5.4 with the same grid, FRFs and Simpson rule,
only the summation order changed (so the TS reference uses the same order). Only `+ - * /` and `sqrt` (the grid with its `Math.pow` is built
in TypeScript and passed as data), so the native field is **bit-identical** to the TypeScript one, not just within 1e-10. Stored in the
results artifact (`nodalRms { engine, solver, gridPoints, components, units, values }`), so `record_fea_results` recomputes `nodalMax` from it
and the trust model is unchanged. The summary's probes use the same forms plus an f^2-weighted set (zero up-crossing rate) and a halved-grid
check (`DYN_PSD_GRID_NOT_CONVERGED` in `unverifiedReasons` above 1e-4).

**Validation as built.**

| VC | Status | Evidence |
| -- | ------ | -------- |
| 01–05, 07–11, 13, 14 | pass (stated tolerances) | `tests/unit/cae/dynamics/math.test.ts`, `quickChecks.test.ts` (plan `dyn_quick_checks` through the registry) |
| 06 | pass (max deviation 3.9e-7 ≤ 2e-6) | `math.test.ts` |
| 12 | not built (residual-flexibility share; the effective-mass bookkeeping is tested instead) | — |
| 17 | pass (9 SSD headings for n = 5, m = 1) | `deck.test.ts` (synthetic CalculiX-layout DAT) |
| 21 | pass at 1e-6 (not only 5 %) on exact Euler-Bernoulli modal data recorded through `record_fea_results`; the FE run needs ccx + Gmsh (absent here) | `results.test.ts`, `server/tests/dynamicsRandomField.test.ts` |
| 22 | reader pass on the quoted fractions (synthetic table body) | `deck.test.ts` |
| 31 (partial) | pass: base-motion convention vs beamdy10bm modal coordinates (above) | `math.test.ts` |
| 40, 41, 42 (5 of 7 codes; `DYN_BASE_ACCEL_TRANSIENT` waits for transients, M5), 43, 45 | pass | `setup.test.ts`, `deck.test.ts`, `report.test.ts`, `server/tests/dynamicsRandomField.test.ts` |
| 44 | not built: 05 `dispose_margin` does not exist yet | — |
| 47 | pass (`*DAMPING,STRUCTURAL=0.02`, refusal without the property, zeta_eq = eta / 2) | `deck.test.ts`, `math.test.ts` |
| 48 | pass, bit-identical: crate fixtures (EB strip + seeded viscous / structural bases, any thread count) and end to end through fea_solve | `solver/crates/llull-post/tests/random_reference.rs`, `tests/unit/native/dynamicsReference.test.ts`, `server/tests/dynamicsRandomField.test.ts` |
| 15, 20, 30, 32 | not run: CalculiX and Gmsh are not installed on the build machine (integration gate) | — |

**Measured (Windows laptop, `compute` profile, GNU toolchain, 2026-10-19):** 20 000 nodes x 60 modes x 12 components: TypeScript reference
1.32 s, `llull-compute post random` 0.44 s including the 86 MB job folder I/O (bit-identical); 29 547 nodes x 6 modes: TS 0.15 s, native 0.31 s
(spawn and I/O dominate). The quadratic-form rewrite makes the TypeScript path meet the §8 budget well beyond 50k nodes for typical mode counts,
so the native job is the large-mesh / many-mode path: `TS_NODAL_WORK_LIMIT` = 4e9 multiply-adds (≈ 6 s TS) is the refusal threshold without the
binary. fea_solve uses the native job whenever it is installed (`LLULL_NATIVE_RANDOM_MIN_NODES` raises the threshold).

**Not built (M4 / M5 / V1):** transient_dynamic and `set_transient_controls` / `assign_load_history`, `export_response_psd`, Nastran SOL 111/112,
`post ssd` (a frequency-response nodal envelope; CalculiX already writes the complex field), the stress-ASD export, PHY-10 joint histories,
the human gate on dispositions (`DYN_HUMAN_GATE`, needs 05 `dispose_margin`). The spec's MCP prompt `random_vibration_quick_check` is the
`llull guide` section 10 (MCP was removed, LC1).
