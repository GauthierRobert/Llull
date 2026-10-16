# PHY-11: Creep, stress relaxation and viscoelastic time response — technical specification

Gap id **CRP** · status: specification · written 2026-10-15 · functional spec: [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md)
· validation: [`validation/README.md`](validation/README.md) · sources: [`validation/sources.md`](validation/sources.md)

Placement follows [`../README.md`](../README.md) §6.2 and is a **proposal** pending decision §5.1 there.

## 1. Current state in llull

### 1.1 Today's code (verified 2026-10-15)

| Area | What exists | Path | Limit for creep |
| ---- | ----------- | ---- | --------------- |
| Material | `Material { name, density, color, metalness, roughness, finish? }`; `create_material(name, density, …)`, `assign_material(materialName, entityIds)` | `packages/core/src/model/types.ts` (`interface Material`), `packages/core/src/commands/document/materials.ts` | No elastic, creep or viscoelastic data |
| Analyses | None. Packages are `core`, `domain-aec`, `kernel-manifold`, `kernel-occt`, `mcp`; no `domain-cae` / `domain-physics` | `packages/` | — |
| Motion | Kinematic joints, drives and `motion_study` (no forces, no time-dependent material) | `packages/core/src/commands/motion/` | — |
| Plan reports | `StepReport { index, path?, command, ok, summary, affected }` | `packages/core/src/commands/project/types.ts` | AF-14 adds `error?`, `data?`, `aliases` (aerospace prerequisite) |
| MCP toolsets | `TOOLSET_NAMES = core, 2d, 3d, measure, parametric, assembly, exchange, building, civil` | `packages/mcp/src/toolsets.ts` | `analysis` is added by 05 |
| Server processes | `pythonExchange.ts`, `childProcesses.ts` (tracked children) | `server/src/` | 05 adds `feaSolve.ts` |

A case-insensitive grep of `packages/`, `server/src` and `src/` (`*.ts`) for the whole words `creep`, `viscoelastic`,
`relaxation` (in the material sense) and `Prony` finds no capability.

### 1.2 Baseline assumed (aerospace packs and PHY-00/01/02 built first)

| From | What PHY-11 uses |
| ---- | ---------------- |
| 05 FEA (`@cae`) | `AnalysisModel` / `AnalysisCase` (`model/analysis.ts`), `FeaTarget`, constraints incl. `displacement` with DOF values, loads, mesh controls, probes, `record_fe_mesh` / `record_fea_results` with the artifact-store trust model, transports `fea_mesh` / `fea_solve` / `fea_export`, INP writer, FRD/DAT readers, `compute_margins`, `dispose_margin` (human gate), `check_analysis`, codes `FEA_*` |
| 08 MAT | `MaterialRecord`, `PropertyValue`, `Provenance`, `Basis`, private libraries (`storage: 'private'`, TR-MAT-31/32), `lib/quantity.ts` unit grammar |
| PHY-01 | `PropertyModel = table \| fit(form, coeffs, validRange)` with a refusal outside the range |
| PHY-02 | `MaterialModel` kinds referenced **by name** here: `norton` (A, n, m, temperature table), `garofalo`, `prony` (E∞, terms Eᵢ/τᵢ), `wlf` (C1, C2, Tr, valid range); query `material_point_response`; CalculiX export of `*CREEP` |
| PHY-00 | benchmark runner reading `expected_results.json` |

## 2. Target architecture

> **Placement erratum (coordinator, 2026-10-15).** `.dependency-cruiser.cjs` rule `plugins-and-kernels-depend-on-core-only` forbids `packages/domain-physics` importing `@cae` (or any other package). Wherever this spec says `@phys` imports or extends `@cae`, read: the plugin registers its analysis type, deck fragments and result readers through the **core analysis extension port** proposed in [`../03-thermal-analysis/TECHNICAL_SPEC.md`](../03-thermal-analysis/TECHNICAL_SPEC.md) §2; fallback: the discipline lives inside the 05 FEA package. Decision pending in [`../README.md`](../README.md) §5.


```
src/ui (creep step panel, history chart)       server/ (05 transports: fea_solve writes *VISCO decks, reads PEEQ histories)
        │ dispatch                                     │ bundled ccx
        ▼                                              ▼
src/app  installDefaultPlugins() + physics creep plugin
        ▼
packages/domain-physics/src (@phys)  ── CadPlugin "physics-creep", toolset "analysis"
   creep/commands/  set_creep_step, delete_creep_step, creep_closed_form, creep_report,
                    creep_rupture_life, creep_damage_summary, check_creep
   creep/closedForm.ts      pure formulas (§5.2), mirrors generate_creep_reference.py
   creep/deck.ts            INP fragment writer plugged into @cae/decks/inpWriter (step + material blocks)
   creep/history.ts         PEEQ / S / U history extraction from FRD/DAT artifacts (pure)
   creep/rupture.ts         Larson-Miller, time-fraction damage (pure)
   creep/units.ts           A conversion (TR-CRP-12)
        ▼ (public APIs only, L10)
@cae (05 plugin)          AnalysisCase, deck writer hooks, artifact port, margins provider registry
packages/core/src/model   analysis.ts (05) + AnalysisType members 'creep' | 'viscoelastic'; CreepStepSpec (data type)
                          materialModel.ts (PHY-02, read only), propertyModel.ts (PHY-01, read only)
```

**Laws respected:** L1 every change is a command, solving stays a 05 transport; L2 `@phys` imports core public API
and `@cae` only, no fs/process; L3 pure commands; L4 the creep step is part of the `analysis` slice, histories live
in the 05 artifact store with a bounded summary in the document; L5 zod schemas, toolset `analysis`; L6 the server only
spawns ccx; L8 `set_creep_step` records a `FeatureStep`, results go stale on any input change (05 TR-FEA-06 hash gains
the creep step and the law); L9 no kernel use beyond 05 targeting; L10 plugin, core gets data types only.

**Plugin-to-plugin dependency.** `@phys` depends on `@cae` (05). This needs `.dependency-cruiser.cjs` to allow
`packages/domain-physics → packages/domain-cae` (one-way) — README §5.1 decision; if refused, the creep step and
deck hook move into `@cae` as an extension point and `@phys` only registers commands.

### 2.1 Technical requirements

| Id | Pri | Requirement |
| -- | --- | ----------- |
| TR-CRP-01 | MUST | `AnalysisType` (05, `model/analysis.ts`) gains **`creep`** (MVP) and **`viscoelastic`** (V2). `AnalysisCase` gains optional `creep?: CreepStepSpec`. Optional fields: no document version bump; rides the aerospace v3 envelope (README §6.2). |
| TR-CRP-02 | MUST | Plugin `physics-creep` (`CadPlugin { name, toolset: 'analysis', commands, document }`); `document.validate` checks `creep` blocks (finite numbers, units parse, duration > 0, cetol > 0, m > −1 is checked on the law by PHY-02). |
| TR-CRP-10 | MUST | `CreepLawView` (§3) is built per analysed part from the PHY-02 model on the part's 08 record; missing → `CRP_LAW_MISSING`; unresolved private library → `MAT_LIBRARY_UNRESOLVED` (08). |
| TR-CRP-11 | MUST | Range guard: every quick check and life query validates σ, T (and LMP) against the law's `validRange`; FE results are scanned (max von Mises over the hold, element temperatures) by `check_creep`. Outside → `CRP_LAW_OUT_OF_RANGE`. Never extrapolate. |
| TR-CRP-12 | MUST | `@phys/creep/units.ts` converts A: stress factor `A_new = A_old · c_s^(−n)`; time factor `A_new = A_old · c_t^(m+1)` where `t_old = c_t · t_new`. Round-trip 1e-12 rel (VC-CRP-16). |
| TR-CRP-20 | MUST | `closedForm.norton(A, n, m, σ, t) = A σⁿ t^(m+1)/(m+1)`; strain-hardening and time-hardening coincide at constant stress (§5.2). |
| TR-CRP-21 | MUST | Relaxation closed form `σ(t) = [σ0^(1−n) + (n−1) E′ A t]^(1/(1−n))`, `E′ = E k_m/(k_m + k_b)`; n = 1 branch `σ0 exp(−E′ A t)`. |
| TR-CRP-22 | MUST | Stationary creep closed forms of §5.2 (tube, beam), with the n = 1 limits unit-tested against Lamé / elastic beam (1e-12). |
| TR-CRP-30 | SHOULD | `rupture.ts`: LMP and iso-LMP extrapolation, master-curve inversion `t_r = 10^(LMP(σ)/T − C)` where `LMP(σ)` inverts the PHY-01 fit `log10 σ = f(LMP)` by bisection on its valid LMP range (tolerance 1e-10 relative on LMP). |
| TR-CRP-31 | SHOULD | Damage summary: D = Σ tᵢ/t_r,i over duty blocks; each block's t_r from TR-CRP-30 at the block's stress (end-of-hold max von Mises per region, or given) and temperature. |
| TR-CRP-40 | MUST | Viscoelastic closed forms (Maxwell, Kelvin–Voigt, SLS, Prony E(t), SLS J(t)) delegate the material-point integration to PHY-02 `material_point_response` when a strain history is given; the closed forms are only for the constant-strain / constant-stress cases (VC-CRP-30…32). |
| TR-CRP-41 | MUST | WLF from the PHY-02 `wlf` model: refuse ΔT < 0 or outside `validRange`; `C2 + ΔT ≤ 0` is a singularity → `CRP_WLF_OUT_OF_RANGE`. |
| TR-CRP-50 | MUST | Deck hook `creep/deck.ts` writes the material and step blocks of §5.3 into the 05 INP writer; byte-deterministic. |
| TR-CRP-51 | MUST | History reader: FRD blocks labelled **`PE`** (CalculiX writes CEEQ as PEEQ, label PE, in the FRD; PEEQ in the DAT) and `STRESS`, `DISP` per output time (from the `100CL` header); `*TIME POINTS … GENERATE` drives output times. |
| TR-CRP-52 | MUST | Summaries stored in the document are bounded: ≤ 200 history points per probe (deterministic log-spaced selection including the last point), ≤ 32 probes per case; full fields stay in the 05 artifact store. |
| TR-CRP-60 | MUST | Agent-first contract (AF-10/11/31–35): all results unit-suffixed, `provenance` with formula, inputs and law source; `unverified` = OR of law / curve / shift flags; `reviewRequired` always true on reports and life results; named defaults carry `source` + `defaulted`. |
| TR-CRP-61 | SHOULD | Creep-life and residual-preload rows register as a **margin provider** in 05 `compute_margins` (criterion `creep_life`, `creep_damage`, `residual_preload`) so `dispose_margin` and `check_analysis` handle them without new gate code. |

## 3. Data model

```ts
// packages/core/src/model/analysis.ts (05) — members added by this pack
export type AnalysisType = 'static' | 'modal' | 'buckling' /* 05 */ | 'creep' /* PHY-11 MVP */ | 'viscoelastic' /* PHY-11 V2 */;

export interface CreepStepSpec {
  /** Preload: a *STATIC step (creep off) applies loads and held displacements before the hold. */
  readonly preloadStep: boolean;
  readonly preloadPeriodS: number;            // default 1e-6 × duration; adds to CalculiX total time (§5.3)
  readonly durationS: number;                  // hold length, stored in s (input any time unit, TR-CRP-12 grammar)
  readonly initialIncrementS: number;
  readonly minIncrementS?: number; readonly maxIncrementS?: number;
  readonly maxIncrements: number;              // *STEP, INC=
  readonly cetol: number;                      // *VISCO, CETOL= (strain, > 0); required by CalculiX
  readonly nlgeom: boolean;
  readonly temperature: { readonly kind: 'uniform'; readonly valueK: number }
                      | { readonly kind: 'field'; readonly thermalAnalysisId: string; readonly timeS?: number };  // V1, PHY-03
  readonly holdBlocks?: readonly { readonly name: string; readonly durationS: number; readonly loadFactor: number }[]; // V1 *AMPLITUDE
  readonly outputTimes: { readonly kind: 'log'; readonly count: number } | { readonly kind: 'linear'; readonly everyS: number };
}

// @phys/creep/lawView.ts — read-only view built from the PHY-02 MaterialModel (never stored)
export interface CreepLawView {
  readonly materialRecordId: string;
  readonly form: 'norton';                      // MVP; 'garofalo' | 'user' via MFront in V2
  readonly table: readonly { readonly temperatureK: number; readonly A: number; readonly n: number; readonly m: number }[];
  readonly aUnit: string;                       // e.g. "MPa^-5 s^-1", converted to the analysis system (TR-CRP-12)
  readonly validRange: { readonly stressMPa: readonly [number, number]; readonly temperatureK: readonly [number, number] };
  readonly yieldForCreep: 'zero' | { readonly fromPlasticModel: string };   // CalculiX overstress model (§5.3)
  readonly provenance: { readonly sourceId: string; readonly basis: string; readonly locator?: string };
  readonly unverified: boolean; readonly unverifiedReasons: readonly string[];
  readonly licence: string;                     // 08 LicenceFlag; private → coefficients redacted in data for remote clients
}

// 05 ResultsSummary gains (bounded, TR-CRP-52):
export interface CreepResultsSummary {
  readonly holdComplete: boolean; readonly finalTimeS: number; readonly increments: number; readonly lastIncrementS: number;
  readonly maxCeeq: { readonly value: number; readonly at: Vec3; readonly entityId: EntityId };
  readonly maxVonMisesEndMPa: { readonly value: number; readonly at: Vec3; readonly entityId: EntityId };
  readonly maxVonMisesOverHoldMPa: number;     // for the range guard
  readonly probeHistories: Record<string, {
    readonly quantity: string; readonly unit: string;
    readonly tS: readonly number[]; readonly values: readonly number[];
  }>;
}

// 05 probe extension
export interface ResultProbe { name: string; point: Vec3; quantity: ProbeQuantity; history?: boolean;
  axis?: { point: Vec3; direction: Vec3 } }   // required for s_hoop / s_radial
export type ProbeQuantity = /* 05 */ 'u_x' | 'u_y' | 'u_z' | 'u_mag' | 's_xx' | 's_yy' | 's_zz' | 'von_mises'
  | /* PHY-11 */ 'ceeq' | 's_hoop' | 's_radial' | 'reaction_force';

// Rupture master curve: PHY-01 PropertyModel of form 'larson_miller' (requested addition, §11 Q2)
export interface LarsonMillerCurve {
  readonly C: { readonly value: number; readonly source: string };
  readonly log10StressMPa: { readonly form: 'polynomial'; readonly coeffs: readonly number[] };   // in LMP (K·log h)
  readonly validLmp: readonly [number, number]; readonly validStressMPa: readonly [number, number];
  readonly provenance: { readonly sourceId: string; readonly basis: string };
}
```

Ids: creep step lives inside the case (no own id); creep-life margin rows `crp-r<k>` (05 row namespace).

## 4. Commands

Plugin `physics-creep`, toolset `analysis`. All pure (`(doc, params, ctx) → CommandResult`), zod params with
`.describe()` on every field (AF-02/04). Queries carry `annotations: { readOnly: true }` and return `data`.

| Name | Kind | Params sketch | Tags |
| ---- | ---- | ------------- | ---- |
| `set_creep_step` | mutating | `{ analysisId, duration: {value, unit}, initialIncrement?: {value, unit}, minIncrement?, maxIncrement?, maxIncrements?=1000, cetol: number (strain), preloadStep?=true, nlgeom?=false, temperature: {value, unit} \| { thermalAnalysisId, time? }, holdBlocks?, outputTimes?={kind:'log',count:50} }` | @affects analysis.cases[id].creep · @invariant case type is `creep`; every analysed part has a CreepLawView; durations stored in s · @failure case missing / wrong type → `CRP_CASE_TYPE`; no law → `CRP_LAW_MISSING`; duration ≤ 0 → `CRP_DURATION_INVALID`; cetol ≤ 0 → `CRP_CETOL_INVALID`; temperature outside every part's law range → `CRP_LAW_OUT_OF_RANGE` |
| `delete_creep_step` | mutating | `{ analysisId }` | @affects case.creep · @failure none set → no-op with reason |
| (05) `create_analysis` | mutating (extended) | `analysisType` accepts `creep` | @invariant `creep` needs `solver: 'calculix'` (Nastran SOL 400 creep is out of scope) → `CRP_SOLVER_UNSUPPORTED` |
| (05) `add_result_probe` | mutating (extended) | + `history?: boolean`, `axis?`, quantities `ceeq`, `s_hoop`, `s_radial`, `reaction_force` | @failure `s_hoop` without axis → `CRP_PROBE_AXIS_MISSING` |
| `creep_closed_form` | query | `{ check: 'norton_constant_stress' \| 'norton_relaxation' \| 'bolt_relaxation' \| 'thick_cylinder_stationary' \| 'beam_stationary' \| 'maxwell' \| 'kelvin_voigt' \| 'sls' \| 'prony_relaxation' \| 'wlf_shift' \| 'convert_norton_a', inputs: object (unit-suffixed keys or {value, unit}), material?: recordId }` → `data { check, value(s) with units, formula, inputs, provenance, unverified, warnings[] }` | @invariant pure, identical to `generate_creep_reference.py` within 1e-12 · @failure missing input → `CRP_INPUT_MISSING` (names the key); `material` given and value outside its range → `CRP_LAW_OUT_OF_RANGE` |
| `creep_report` | query | `{ analysisId, probes?: string[], maxPoints?=200 }` → `data` §5.5 | @invariant refuses stale (05 `FEA_RESULTS_STALE`) and missing results; `reviewRequired: true` · @failure `CRP_HOLD_INCOMPLETE` is reported in data (not a refusal) |
| `creep_rupture_life` | query | `{ material, stress: {value, unit}, temperature: {value, unit}, C?: {value, source}, requiredLife?: {value, unit} }` → `data { lmpK, ruptureLifeH, requiredLifeH?, status, C: {value, source, defaulted:false}, provenance, unverified, reviewRequired }` | @invariant no silent C (AF-31); refuses outside `validLmp` / `validStressMPa` · @failure no curve and no C → `CRP_LM_MODEL_MISSING`; out of range → `CRP_LAW_OUT_OF_RANGE` |
| `creep_damage_summary` | query | `{ analysisId?, material, blocks: [{ name, duration: {value, unit}, stress?: {value, unit} \| { region: 'max_end_of_hold' }, temperature: {value, unit} }], damageLimit?: number, requiredLife?: {value, unit} }` → `data { rows[], damage, damageLimit: {value, source, defaulted}, status, reviewRequired }` | @invariant damage limit named (default `{ value: 1.0, source: "time-fraction rule: rupture at D = 1", defaulted: true }`) · @failure any block out of range → `CRP_LAW_OUT_OF_RANGE`; D ≥ limit → row `fail`, code `CRP_DAMAGE_EXCEEDED` |
| `check_creep` | query | `{ analysisId }` → `data { status, items: [{ code, severity, ids[], path?, message, remediation }], reviewRequired: true }` | read-only readiness and result check (AF-20); codes §7.1; runs 05 `check_analysis` items first |
| (05) `compute_margins` | query (provider) | criterion `creep_life` \| `creep_damage` \| `residual_preload` with `requiredLife` / `requiredResidualPreload` explicit | rows `crp-r<k>`; FAIL / MARGINAL → `pending_human` |
| (05) `dispose_margin` | mutating, **human gate** | unchanged | accepts `crp-r<k>` rows; agent → `FEA_HUMAN_GATE` |
| ✱ (05) `fea_solve` | transport | unchanged | writes the creep deck via TR-CRP-50, reads histories via TR-CRP-51, dispatches `record_fea_results` with `CreepResultsSummary` |

Tag example (as it will appear in source):

```ts
/**
 * @affects analysis.cases[analysisId].creep
 * @invariant case.type === 'creep'; every analysed part resolves a PHY-02 creep law; durations stored in seconds
 * @failure unknown case / wrong type / no law / duration ≤ 0 / cetol ≤ 0 → no-op with code + remediation
 */
export const setCreepStep = defineCommand({ name: 'set_creep_step', description: '…', params: z.object({ … }), run });
```

## 5. Kernel / algorithms

No geometry-kernel use beyond 05 targeting. Formulas below are mirrored by `validation/generate_creep_reference.py`.

### 5.1 Law (PHY-02, consumed)

CalculiX Norton: `ε̇ = A σⁿ tᵐ`, ε = equivalent creep strain, σ = true von Mises stress, t = **total time** [R1].
Data lines `A, n, m, T`; CalculiX interpolates creep data at the `*ELASTIC` temperature points when they differ [R1].
code_aster's `LEMAITRE` with `UN_SUR_M = 0` is the same Norton form with `ε̇ = (σ/K)^N` [R12] — used only for
cross-solver checks (VC-CRP-47).

### 5.2 Closed forms (`closedForm.ts`)

| Check | Formula | Notes |
| ----- | ------- | ----- |
| Norton, constant σ | ε = A σⁿ t^(m+1)/(m+1) | m > −1; m = 0 → A σⁿ t |
| Relaxation, fixed strain | σ̇ = −E′Aσⁿ → σ = [σ0^(1−n) + (n−1)E′At]^(1/(1−n)); t_f = σ0^(1−n)(f^(1−n) − 1)/((n−1)E′A) | E′ = E (bar), E k_m/(k_m + k_b) (bolt + members) |
| Thick tube, stationary, plane strain | σr = −p[(b/r)^(2/n) − 1]/[(b/a)^(2/n) − 1]; σθ = p[1 + (2/n − 1)(b/r)^(2/n)]/[(b/a)^(2/n) − 1]; σz = (σr + σθ)/2; σeq = (√3/n) p (b/r)^(2/n)/[(b/a)^(2/n) − 1] | from equilibrium + incompressible flow + compatibility; n = 1 → Lamé |
| Beam, stationary bending | σ(y) = M y^(1/n)/Iₙ, Iₙ = 2b(h/2)^(2+1/n)/(2+1/n); σmax = (2n+1)/(3n)·6M/(bh²) | tension = compression law; n = 1 → elastic |
| Maxwell / Prony relaxation | E(t) = E∞ + Σ Eᵢ e^(−t/τᵢ) | |
| SLS creep compliance | J(t) = 1/E∞ − E1/(E0E∞)·e^(−t/τc), τc = τE0/E∞, E0 = E∞ + E1 | interconversion ∫E(t−s)dJ(s) + E(t)J(0) = 1 |
| Kelvin–Voigt | J(t) = (1 − e^(−t/τ))/E | |
| WLF | log10 aT = −C1(T − Tr)/(C2 + T − Tr); E(t, T) = E_ref(t/aT) | Tr ≤ T ≤ validRange max |
| Larson–Miller | LMP = T(C + log10 t_r) (T in K, t_r in h); iso-LMP t_r2 = 10^(LMP/T2 − C) | C from the curve or explicit |
| Damage sum | D = Σ tᵢ/t_r,i | limit named |

### 5.3 CalculiX deck (TR-CRP-50)

Syntax from the manual [R1] and the `beamcr*` decks [R2]:

```
*MATERIAL, NAME=<m>
*ELASTIC
 E, nu[, T]                                  (isotropic → large-strain viscoplastic theory [R1])
*PLASTIC                                     (only if CreepLawView.yieldForCreep = fromPlasticModel)
 sigma_y, eps_p[, T] …
*CREEP                                       (LAW=NORTON default)
 A, n, m, T                                  (one line per temperature point; A in the analysis unit system)
*INITIAL CONDITIONS, TYPE=TEMPERATURE
 NALL, <T0>
*TIME POINTS, NAME=TP_HOLD, GENERATE         (or an explicit log-spaced list, TR-CRP-52)
 0., <duration>, <every>
** step 1: preload (creep is switched off in *STATIC [R1])
*STEP
*STATIC
 <preloadPeriod>, <preloadPeriod>
*BOUNDARY  (held displacements: 05 'displacement' constraints)
*CLOAD / *DLOAD (loads)
*TEMPERATURE
 NALL, <T>
*END STEP
** step 2: hold (loads in *VISCO are step loads [R1])
*STEP, INC=<maxIncrements>[, NLGEOM]
*VISCO, CETOL=<cetol>
 <initialIncrement>, <duration>[, <minIncrement>, <maxIncrement>]
*NODE FILE, TIME POINTS=TP_HOLD
 U
*EL FILE, TIME POINTS=TP_HOLD
 S, CEEQ                                     (FRD label PE = PEEQ [R1])
*NODE PRINT / *EL PRINT for probes, TIME POINTS=TP_HOLD   (DAT: PEEQ)
*END STEP
```

Rules: (1) with no plasticity model, CalculiX assumes a zero yield surface without hardening [R1] — the default for creep
below yield; (2) if a PHY-02 plastic model is also attached, the overstress behaviour [R1] is reported by
`check_creep` (`CRP_OVERSTRESS_MODEL`, warning); (3) a `*VISCO` step without any creep material is refused before
writing (`CRP_NO_VISCOUS_MATERIAL`; the manual: a `*VISCO` step only makes sense with a viscous material [R1]);
(4) the preload period counts in CalculiX total time, so for m ≠ 0 the deck uses a preload period of 1e-6 × duration
and `creep_report` states the time origin; (5) orthotropic elasticity + `*CREEP` switches CalculiX to the
infinitesimal-strain model and forbids `LAW=USER` with `*PLASTIC` [R1] — MVP accepts isotropic elasticity only
(`CRP_ORTHOTROPIC_V2`).

### 5.4 Viscoelastic FE (V2)

CalculiX has no Prony keyword [R1]. V2 writes `*MATERIAL, NAME=ABAQUS<m>` or a native user-material name and
`*USER MATERIAL, CONSTANTS=…` calling a shared library generated by MFront from `GeneralizedMaxwell.mfront` [R10],
bundled per platform next to ccx (licence: TFEL GPL-3.0 / CeCILL-A, open question §11 Q4). Step: `*STATIC` with the
time period = hold duration (no creep law, so `*VISCO` is not needed — to confirm on the MFront example, §11 Q5).

### 5.5 `creep_report` data shape

```json
{
  "analysisId": "an-9.1", "state": "solved", "unitSystem": "N-mm-t-s",
  "hold": { "durationS": 1000, "finalTimeS": 1000, "complete": true, "increments": 37, "cetol": 1.0, "temperatureK": 293 },
  "law": { "materialRecordId": "norton_cube", "form": "norton", "A": { "value": 1e-10, "unit": "MPa^-5 s^-1" }, "n": 5, "m": 0,
           "validRange": { "stressMPa": [1, 400], "temperatureK": [293, 293] }, "basis": "company", "source": "…" },
  "maxCeeq": { "value": 0.32, "atMm": [0.5, 0.5, 0.5], "entityId": "box-2.1" },
  "maxVonMisesEndMPa": { "value": 20.0, "atMm": [0.5, 0.5, 1.0] },
  "probes": { "centre": { "quantity": "ceeq", "unit": "-", "history": [{ "tS": 0.1, "value": 3.2e-5 }, { "tS": 1000, "value": 0.32 }] } },
  "quickCheck": { "check": "norton_constant_stress", "value": 0.32, "ratioFeToClosedForm": 1.0 },
  "unverified": false, "unverifiedReasons": [],
  "reviewRequired": true, "reviewReason": "creep deformation and relaxation feed structural and maintenance decisions",
  "summary": "Held 1000 s at 293 K; max creep strain 0.32 (centre); quick check ratio 1.00. Computed by llull, not approved — needs a qualified engineer."
}
```

### 5.6 Numerical tolerances

| Item | Value |
| ---- | ----- |
| Closed forms vs generator | 1e-12 relative |
| A unit conversion round trip | 1e-12 relative |
| LMP inversion (bisection) | 1e-10 relative on LMP |
| FE vs closed form | 1 % (uniaxial, relaxation), 3 % (stationary tube, beam; ends excluded) — llull acceptance |
| Reference decks | 1e-4 relative on FRD values |

## 6. Interop & persistence

| Format | Direction | Implementation |
| ------ | --------- | -------------- |
| CalculiX INP (`*CREEP`, `*VISCO`, `*TIME POINTS`) | out | `@phys/creep/deck.ts` via the 05 writer hook |
| CalculiX FRD / DAT (PE, PEEQ, S, U per time point) | in | 05 readers + `@phys/creep/history.ts` |
| Nastran BDF creep (MATS1 / CREEP cards, SOL 400) | — | out of scope (not verified) |
| MFront shared library (V2) | runtime | bundled next to ccx, loaded by CalculiX |
| Document | persist | `analysis.cases[*].creep` + bounded `CreepResultsSummary`; private-library coefficients never serialized (08 TR-MAT-31) |

## 7. CLI / MCP / UI surfaces

- **CLI**: registry commands as `llull <command> …`; solving is `llull fea_solve` (05). `llull guide` gains a physics
  creep section: units of A (`MPa^-n s^-(m+1)`), what m means, why `*STATIC` has no creep, minimal creep plan, the
  closing `check_creep` (AF-03).
- **MCP**: toolset `analysis`; prompt `creep_quick_check` (quick check → set-up → solve → report → check).
- **UI** (review only): creep step panel, history chart, CEEQ contour, law card, 05 disposition dialog.
- **render_view**: 05's `analysisId` + `field` gain `ceeq`.

### 7.1 Stable error and check codes (AF-11)

| Code | Severity | When | Ids / path | Remediation |
| ---- | -------- | ---- | ---------- | ----------- |
| `CRP_CASE_TYPE` | error | creep command on a case that is not `creep` | analysis id | `create_analysis analysisType=creep` |
| `CRP_SOLVER_UNSUPPORTED` | error | `creep` with a solver other than CalculiX | analysis id | use `solver: calculix` |
| `CRP_LAW_MISSING` | error | an analysed part's material has no PHY-02 creep model | entity id, record id | `add_material_model` with a Norton law (PHY-02) |
| `CRP_LAW_OUT_OF_RANGE` | error (query) / fail (check) | σ, T or LMP outside the law / curve range | element ids or param path, extreme value, range | change load / temperature, or supply a law valid there |
| `CRP_LAW_UNVERIFIED` | warning (not suppressible) | law, curve or shift with basis typical / supplier_unstated / unspecified | record id | replace with a sourced, verified law |
| `CRP_DURATION_INVALID` | error | duration ≤ 0 or not a time unit | param path | give `{value > 0, unit: s\|min\|h\|d\|yr}` |
| `CRP_CETOL_INVALID` | error | cetol ≤ 0 | param path | e.g. allowed stress change per increment / E |
| `CRP_NO_VISCOUS_MATERIAL` | error | creep case with no creep law on any part | analysis id | attach a law or use `static` |
| `CRP_ORTHOTROPIC_V2` | error | orthotropic elasticity with creep (MVP) | record id | isotropic elastic model, or wait for V2 |
| `CRP_OVERSTRESS_MODEL` | warning | plastic model with yield > 0 together with creep | record id | creep only above yield in CalculiX; use zero yield for creep below yield |
| `CRP_TEMPERATURE_TABLE_COARSE` | warning | A changes > 10× between neighbouring temperature points | record id, temperatures | add temperature points |
| `CRP_HOLD_INCOMPLETE` | fail | solve ended before `durationS` | analysis id, final time | smaller initial increment, larger `maxIncrements`, check the log |
| `CRP_PROBE_AXIS_MISSING` | error | `s_hoop` / `s_radial` probe without axis | probe name | add `axis` |
| `CRP_INPUT_MISSING` | error | quick check without a required input | input key | supply it with its unit |
| `CRP_LM_MODEL_MISSING` | error | life query without a master curve and without C | material | add a PHY-01 Larson–Miller curve or pass `C` with a source |
| `CRP_DAMAGE_EXCEEDED` | fail | D ≥ damage limit | row id | redesign or reduce duty; qualified reviewer only |
| `CRP_LIFE_SHORT` | fail | rupture life < required life | row id | same |
| `CRP_WLF_OUT_OF_RANGE` | error | T < Tr, beyond range, or C2 + ΔT ≤ 0 | param path | use an Arrhenius / measured shift below Tr |
| `CRP_REQUIRED_LIFE_UNSET` | warning | life / damage computed without `requiredLife` | analysis id | ask the owner for the required life |
| (05) `FEA_RESULTS_STALE`, `FEA_HUMAN_GATE`, `FEA_TOOL_MISSING`; (08) `MAT_LIBRARY_UNRESOLVED` | — | reused | — | — |

### 7.2 Agent-first compliance

| AF | Where |
| -- | ----- |
| AF-01/02/03 | registry commands; descriptions state units of A and time; `llull guide` creep section |
| AF-04 | `{value, unit}` durations, stresses, temperatures; A unit string (FR-CRP-23, TR-CRP-12) |
| AF-05 | all set-up in one plan (`validation/plans/*`) |
| AF-10/12 | `creep_report` shape §5.5, bounded histories (TR-CRP-52) |
| AF-11 | §7.1 |
| AF-13 | deterministic deck, history selection, closed forms |
| AF-20 | `check_creep` |
| AF-21 | histories and maxima as numbers; quick-check ratio |
| AF-22 | `render_view field=ceeq` |
| AF-23 | validation CLI harness |
| AF-30 | range guard, coarse-table rule, overstress rule as data with sources |
| AF-31 | damage limit, C, WLF constants named (FR-CRP-14) |
| AF-32 | FR-CRP-16 |
| AF-33 | FR-CRP-15 |
| AF-34 | 05 `dispose_margin` on `crp-r*` rows |
| AF-35 | `provenance` with formula, inputs, law source |
| AF-40/41 | 05 transport progress / timeout; bundled ccx |
| AF-42 | `--dry-run` on `set_creep_step` |

## 8. Performance & robustness budgets

| Budget | Target |
| ------ | ------ |
| Quick check | ≤ 5 ms (pure) |
| Creep solve, 20k-node tet10, 100 increments | ≤ 5 min on the reference desktop — TBD: measure (production-gate scenario) |
| History summary in document | ≤ 200 points × 32 probes |
| Artifact | 05 cap (512 MB); output at time points only, never every increment by default |
| Robustness | every failure is a no-op with code; a hold that stops early is recorded with `holdComplete: false`, never extrapolated |

## 9. Test strategy

| Layer | Tests | VC |
| ----- | ----- | -- |
| Unit (`tests/unit/physics/creep/*`) | every command happy + failure + `is pure`; closed forms against `expected_results.json`; A conversion; LMP; damage; WLF; deck fragment golden text; history reader on the pinned `beamcr3.frd.ref` | 02, 10–16, 20, 21, 30–34 |
| Contract | `toToolSchemas()` snapshot (new commands, extended enums), plugin validate/restore | 01 |
| Golden | the four draft plans once commands exist; replay equality | 01 |
| Integration (`server/tests`, needs ccx) | native plans and pinned decks | 40–44, 47 |
| Agent-first | named defaults, review flag, unverified, range guard, human gate, codes, private-data fuzz | 60–66 |
| Quality (`quality:physics`, PHY-00) | VC-CRP-40…43 table | 40–43 |

Coverage 90/85/90/90 extends to `packages/domain-physics/src/**`.

## 10. Delivery plan

| M | Content | Depends on | Effort |
| - | ------- | ---------- | ------ |
| M1 | `closedForm.ts`, `units.ts`, `creep_closed_form`, unit tests VC-10…16, 30–34 | PHY-02 law types | 1 w |
| M2 | `AnalysisType` members, `CreepStepSpec`, `set_creep_step` / `delete_creep_step`, deck hook, history reader, `CreepResultsSummary`, `creep_report`, `check_creep`, probe extension | 05 M3, PHY-02 export | 2.5 w |
| M3 | Integration VC-40…44, plans to golden, CLI harness, guide section, MCP prompt | M2, PHY-00 | 1.5 w |
| M4 (V1) | temperature tables + coarse guard, PHY-03 field, hold blocks, NLGEOM | PHY-03 | 1.5 w |
| M5 (V1) | `creep_rupture_life`, `creep_damage_summary`, margin provider, PHY-01 Larson–Miller form | PHY-01, 05 margins | 1.5 w |
| V2 | MFront GeneralizedMaxwell / Garofalo libraries, `viscoelastic` type, orthotropic creep, creep–fatigue with PHY-07 | MFront build, licence decision | 3 w |

Total MVP ≈ 5 w; V1 ≈ 3 w.

## 11. Open questions / decisions needed

1. **Plugin dependency** `@phys → @cae` (README §5.1): allow in `.dependency-cruiser.cjs`, or host creep inside `@cae`?
2. **Larson–Miller master curve** as a PHY-01 `PropertyModel` form `larson_miller` — PHY-01 owner to accept.
3. **Time-hardening across steps**: CalculiX t is total time [R1]. Keep m ≠ 0 to single-hold cases, or switch to a
   strain-hardening user law (V2)?
4. **MFront licence** (GPL-3.0 / CeCILL-A with linking exception) for bundling generated libraries in the desktop installer.
5. **Viscoelastic step type**: confirm on an MFront CalculiX example whether `*STATIC` with a long period is enough for
   a rate-dependent user material.
6. **Benchmarks**: buy NAFEMS R0027 / Linkens vol. 2 to add external creep targets; confirm the COMSOL tube constants.
7. **Damage limit and life factors**: no default life factor is proposed; confirm the named default D = 1.0 is acceptable
   or require it explicitly.
8. **Stationary-creep closed forms**: a reviewer confirms them against a creep textbook (sources.md "Not verified").

## 12. References

- [R1] CalculiX User's Manual — https://github.com/Dhondtguido/CalculiX/tree/fd588701edd6a92fde06e99b1bdf01f3b0f80f2c (accessed 2026-10)
- [R2] CalculiX tests `beamcr*` — same commit (accessed 2026-10)
- [R3] NAFEMS R0027 / R0049 — https://nafems.org/publications/resource_center/r0027 (accessed 2026-10, search, catalogue)
- [R5] COMSOL model 12397 — https://www.comsol.com/model/combining-elastoplastic-and-creep-material-models-12397 (accessed 2026-10, search)
- [R6] NEML Larson–Miller docs — https://github.com/Argonne-National-Laboratory/neml/tree/65ab2a648a975e2e9de8e1371be270567f9683ac (accessed 2026-10)
- [R7] reliability 0.9.0 — https://pypi.org/project/reliability/0.9.0/ (accessed 2026-10)
- [R9] ASME BPVC III-5 — https://standards.nimonik.com/products/asme/bpvcptiiipt5/ (accessed 2026-10, search, catalogue)
- [R10] MFront / TFEL — https://github.com/thelfer/tfel/tree/ff0959eceb602a0ab0e2e455afd9193a2cd725db (accessed 2026-10)
- [R11] WLF — https://en.wikipedia.org/wiki/Williams%E2%80%93Landel%E2%80%93Ferry_equation (accessed 2026-10, search)
- [R12] code_aster tests — https://gitlab.com/codeaster/src/-/tree/94bf28a308de5a77587675a598aacdddb722f84e/astest (accessed 2026-10)
- [R13] NIMS MatNavi — https://mits.nims.go.jp/en/ (accessed 2026-10, search)
- Others ([R4], [R8], [R14]): [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md) §11 and [`validation/sources.md`](validation/sources.md).
- L1 llull: `.claude/rules/architecture.md`, `.claude/context/command-layer.md`, `packages/core/src/model/types.ts`, `packages/core/src/commands/project/types.ts`, `packages/mcp/src/toolsets.ts`, `docs/aerospace/05-fea-cae-handoff/TECHNICAL_SPEC.md`.
