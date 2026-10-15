# PHY-11: Creep, stress relaxation and viscoelastic time response — functional specification

Gap id **CRP** · status: specification · written 2026-10-15 · validation pack: [`validation/README.md`](validation/README.md)
· sources register: [`validation/sources.md`](validation/sources.md) · technical spec: [`TECHNICAL_SPEC.md`](TECHNICAL_SPEC.md)

## 1. Summary

After the aerospace packs (05 FEA, 08 MAT, 06 CMP) and PHY-02 (constitutive laws), llull can describe a creep or
viscoelastic law on a material, but it cannot **use it in time**. There is no analysis that holds a load for hours or
years and returns how much the part keeps deforming (creep), how much a clamped or bolted part loses its stress
(relaxation), how stresses redistribute in a hot tube or a bent member (stationary creep), how long a part lasts before
creep rupture (Larson–Miller life, damage fraction), or how a polymer part's stiffness depends on load duration and
temperature (Prony series with a WLF shift). A grep of `packages/`, `server/src` and `src/` for creep, viscoelastic and
relaxation terms finds nothing (TECHNICAL_SPEC §1).

This blocks every sustained-load question on hot structure (engine mounts, exhaust and APU parts, brake parts, heat
shields), on polymer and composite-matrix parts (clips, brackets, seals, potting), and on joints (bolt preload loss). The
owner asks "will it still hold in five years at 120 °C?" and today llull has no answer.

The gap closes in three steps:

1. **Quick checks first, as read-only commands.** Closed-form Norton creep, relaxation, bolt preload loss, stationary
   stresses in a thick tube and a beam, Maxwell / Kelvin / standard-linear-solid / Prony responses, the WLF shift and
   the Larson–Miller rupture parameter. They need no mesh, run in milliseconds, and are what the agent uses to sanity
   check every FE run (AF-21).
2. **A `creep` analysis type on the 05 analysis model.** The bundled CalculiX runs a preload `*STATIC` step and a
   `*VISCO` step with the PHY-02 Norton law (`*CREEP`, `ε̇ = A σⁿ tᵐ`) [R1]. Results come back as time histories,
   end-of-hold strains and stresses, and relaxation percentages, as data.
3. **Life and duty-cycle screening.** Larson–Miller rupture time at stress and temperature from a sourced master curve
   on the material (usually a private licensed library), and a time-fraction damage sum over a duty cycle. Every life
   result is `reviewRequired` and a negative outcome is a human disposition.

Linear viscoelastic **FE** analysis (Prony in a structural model) needs a user material in CalculiX, because CalculiX
has no Prony keyword [R1]; it is V2 through an MFront-generated library [R10].

## 2. Aerospace context & value

| Context | Today (who / which tools) | What llull adds | Source |
| ------- | ------------------------- | --------------- | ------ |
| Hot metallic structure under sustained load | Stress offices run creep in Abaqus, Ansys, Nastran SOL 400 or code_aster with a Norton or Lemaitre law from test data | The same Norton law (PHY-02) solved by the bundled CalculiX in a `*VISCO` step, offline, driven by the CLI | [R1], [R12] |
| Solver verification for creep | NAFEMS publishes creep benchmarks (R0027, Becker & Hyde) and a combined elastoplastic-creep tube benchmark that COMSOL reproduces | Closed-form stationary solutions and CalculiX reference decks in the quality gate; NAFEMS listed for later purchase | [R3]–[R5], [R2] |
| Creep rupture screening | Larson–Miller parameter `LMP = T (C + log t_r)` with C fitted, often near 20 | `creep_rupture_life` from a sourced master curve, with C and its source always named | [R6]–[R8] |
| High-temperature design codes (scope only) | ASME BPVC III-5 uses stress-to-rupture curves and a linear creep-fatigue damage summation; RCC-MRx is the AFCEN equivalent | A time-fraction damage summary as a screening number; llull claims no code compliance | [R9], [R14] |
| Polymer and matrix-dominated parts | Generalized Maxwell (Prony) fitted to DMA data and shifted with WLF; FE needs a user material | Prony and WLF quick checks and material-point responses now; FE via MFront `GeneralizedMaxwell` in V2 | [R10], [R11] |
| Creep data | National data sheets (NIMS) are free with registration but bulk download and redistribution are barred | Data stays in 08 private libraries; nothing ships with llull | [R13] |

**Value statements** (sourced only): CalculiX, already bundled by 05, implements Norton creep and ships creep test decks
[R1][R2], so the solver cost is zero; the closed forms in the validation generator give exact references with no paid
benchmark; the time-fraction concept is the one high-temperature codes use [R9]. No ROI figure is claimed.

## 3. Personas & user stories

Roles follow [`../../aerospace/AGENT_FIRST.md`](../../aerospace/AGENT_FIRST.md) §1. Creep life and preload loss feed
structural and maintenance decisions, so a qualified reviewer appears for any life or margin result.

| Role | Who | Uses | Main need |
| ---- | --- | ---- | --------- |
| **Operator (primary)** | AI agent via the `llull` CLI (MCP for cloud agents) | `llull creep_closed_form`, `llull run plan.json`, `llull set_creep_step`, `llull fea_solve`, `llull creep_report --json`, `llull check_creep` | Deterministic commands with units, stable codes, time histories as JSON |
| **Owner** | Person asking (supplier designer, MRO planner, student). **Not assumed to be an engineer** | Natural language; may watch the desktop app | "Will it still hold?", answered with what was checked, what passed and what needs an engineer |
| **Qualified reviewer** | Stress / materials engineer, design-organisation signatory | Desktop review surfaces, `creep_report` tables, disposition dialog | Audits the law, its range and source; dispositions negative life or preload results; signs |

User stories:

- **US-1 (owner → operator).** "This polymer clip holds 20 N for 10 years at 60 °C — does it keep enough clamp force?"
  The agent checks the material has a PHY-02 Prony + WLF model with a valid temperature range, runs
  `creep_closed_form check=prony_relaxation` with the WLF-shifted time, reports the remaining force, every
  `unverified` input and "computed by llull, not approved — needs a qualified engineer".
- **US-2 (operator).** For a hot bracket under a bolt-load, the agent builds one plan (geometry, material, 05 analysis
  with `analysisType: "creep"`, `set_creep_step` with a 10 000 h hold at 600 K), runs `check_creep`, meshes, solves and
  reads `creep_report`: max equivalent creep strain with location, displacement at the probe versus time, stress at the
  bolt seat at the end of the hold.
- **US-3 (operator).** The agent compares the FE end-of-hold hoop stress of a pressurised tube to
  `creep_closed_form check=thick_cylinder_stationary` and reports the ratio (AF-21).
- **US-4 (operator → reviewer).** The agent computes a Larson–Miller rupture life at the operating stress and
  temperature from the material's master curve and a duty-cycle damage sum. A life below the required life, or D ≥ the
  named damage limit, is `fail` and stays `pending_human` until the reviewer dispositions it.
- **US-5 (operator).** The agent asks for a life at 900 K but the master curve covers 700–850 K: llull refuses with
  `CRP_LAW_OUT_OF_RANGE` and names the range; it never extrapolates.
- **US-6 (reviewer).** The reviewer opens the creep report in the desktop app, sees the time-history plot built on the
  same data, the law with its source, basis and valid range, and signs or rejects.

## 4. Scope / out of scope

| Phase | In scope |
| ----- | -------- |
| **MVP (M1–M3)** | `creep_closed_form` quick checks (Norton constant stress with time hardening, relaxation, bolt relaxation, thick-cylinder and beam stationary creep, Maxwell, Kelvin–Voigt, SLS, Prony relaxation and creep compliance, WLF shift). `creep` analysis type on 05: preload `*STATIC` + `*VISCO` hold with Norton (isotropic elasticity), constant uniform temperature, step-held loads and held displacements, CEEQ and stress histories at probes, end-of-hold fields. `creep_report`, `check_creep`, stable codes, unverified propagation, review flags. Unit conversion of A. |
| **V1 (M4–M5)** | Temperature-dependent Norton tables (CalculiX interpolation) with a guard on steep tables. Temperature field from a PHY-03 thermal analysis. Multi-block hold histories (load / unload / hold) with `*AMPLITUDE`. `creep_rupture_life` (Larson–Miller from the material's master curve) and `creep_damage_summary` (time-fraction sum over a duty cycle). Creep-life rows in the 05 margin table with human disposition. NLGEOM option. |
| **V2** | Linear viscoelastic FE (`analysisType: "viscoelastic"`) through an MFront `GeneralizedMaxwell` library loaded by CalculiX [R10]. Garofalo / sinh and primary–secondary laws via MFront. Orthotropic elastic + creep. Creep–fatigue interaction with PHY-07. Composite matrix creep with 06 CMP laminates. |
| **Out of scope** | Writing a creep integrator in TypeScript for FE (llull drives CalculiX). Tertiary creep / continuum damage FE (Kachanov–Rabotnov) beyond a screening damage sum. Code compliance with ASME III-5 or RCC-MRx (scope references only). Fitting laws from raw test curves (PHY-02 `fit_material_model`). Shipping any creep data (licensed). |

## 5. Functional requirements

| Id | Pri | Requirement | Rationale | Source |
| -- | --- | ----------- | --------- | ------ |
| FR-CRP-01 | MUST | A 05 analysis case can have type **`creep`**. It holds an ordered creep step definition (preload, hold duration, increments, CETOL, temperature), uses the 05 loads, constraints, mesh and probes, and is created and edited only by commands that replay and save with the document. | L1/L4/L8 | [R1], L1 |
| FR-CRP-02 | MUST | The creep law is read from the **PHY-02 material model** attached to the 08 record (Norton `ε̇ = A σⁿ tᵐ` with A, n, m, optional temperature table, valid stress and temperature range, provenance). PHY-11 never stores law coefficients itself. A creep case on a material without a creep law is refused. | One law definition per material (README §6.2) | [R1], PHY-02 |
| FR-CRP-03 | MUST | **Stress relaxation**: a held displacement (05 `displacement` constraint applied in the preload step) stays fixed through the hold, and the stress history is returned. | Bolted / clamped joints, interference fits | derivation |
| FR-CRP-04 | MUST | **Bolt preload relaxation quick check** with bolt and member stiffness (series springs), returning the remaining preload fraction versus time. | Preload loss is a classic sustained-load failure | derivation |
| FR-CRP-05 | MUST | **Time histories as data** (AF-21): per probe, a bounded list of `{tS, ceeq, sMises, component values, displacement}` points; end-of-hold max equivalent creep strain and max von Mises with location and unit. | Numbers first | AF-10, AF-21 |
| FR-CRP-06 | MUST | **Closed-form quick checks** as one read-only command: Norton constant stress (time hardening), relaxation, bolt relaxation, thick-cylinder stationary creep (plane strain, internal pressure), beam stationary creep bending, Maxwell, Kelvin–Voigt, SLS, Prony relaxation and creep compliance, WLF shift, A-unit conversion. Each returns the value, the formula and the inputs (AF-35). | The agent checks FE against hand calculations | generator |
| FR-CRP-07 | MUST | The CalculiX deck written for a creep case follows the manual: `*CREEP` after `*ELASTIC` (and after `*PLASTIC` when present), preload `*STATIC` step (creep off), `*VISCO, CETOL=…` hold step with step-applied loads, creep strain requested and read back. | Creep is off in `*STATIC`; `*VISCO` loads are step loads | [R1] |
| FR-CRP-08 | SHOULD (V1) | **Creep-rupture life** from a Larson–Miller master curve on the material: `LMP = T (C + log10 t_r)` with T in K and t_r in h, `log10 σ = f(LMP)` as a fitted polynomial with valid LMP and stress range. C is part of the sourced curve or given explicitly with a source; there is **no silent C = 20**. | Rupture screening | [R6]–[R8], AF-31 |
| FR-CRP-09 | SHOULD (V1) | **Duty-cycle damage sum** D = Σ tᵢ / t_r,i over blocks of (hours, stress, temperature), with a damage limit that is either explicit or the named default 1.0 (time-fraction rule, rupture at D = 1). D ≥ limit → `fail`. | Time-fraction concept of high-temperature codes | [R9] |
| FR-CRP-10 | MUST | **Linear viscoelastic responses** (Maxwell, Kelvin–Voigt, SLS, generalized Maxwell / Prony) at a material point: relaxation modulus E(t), creep compliance J(t), stress under a strain history. The material-point integration is PHY-02's `material_point_response`; PHY-11 adds the structural quick checks that use it. | Polymer stiffness depends on load duration | [R10] |
| FR-CRP-11 | MUST | **Time–temperature superposition** with the WLF shift `log10 aT = −C1 (T − Tr)/(C2 + T − Tr)` from the material's PHY-02 shift model. Below Tr or above the model's valid range → refused. The "universal" constants 17.44 / 51.6 K are allowed only when given explicitly with their source and are flagged `unverified`. | Polymers above Tg | [R11] |
| FR-CRP-12 | COULD (V2) | **Viscoelastic FE** (`analysisType: "viscoelastic"`) through an MFront `GeneralizedMaxwell` user material loaded by CalculiX. | CalculiX has no Prony keyword | [R1], [R10] |
| FR-CRP-13 | MUST | Every capability is reachable from the CLI, MCP and the desktop UI through the same registry; transports are the 05 ones (`fea_mesh`, `fea_solve`, `fea_export`). | L1/L5 | L1 |
| FR-CRP-14 | MUST | **Named safety defaults** (AF-31): damage limit, required life, Larson–Miller C, WLF constants and any life factor are explicit or a named default with `source` and `defaulted: true`. There is no default life factor. | No silent safety value | AF-31 |
| FR-CRP-15 | MUST | **Review flag** (AF-33): every `creep_report`, `creep_rupture_life` and `creep_damage_summary` result carries `reviewRequired: true` with a reason and the plain sentence "computed by llull, not approved — needs a qualified engineer". | Life and preload feed safety decisions | AF-33 |
| FR-CRP-16 | MUST | **Unverified propagation** (AF-32): a law, master curve or shift model whose provenance basis is `typical`, `supplier_unstated` or `unspecified` flags every result built from it `unverified` with reasons; `check_creep` warns `CRP_LAW_UNVERIFIED` (not suppressible). | Typical creep data are not design data | AF-32 |
| FR-CRP-17 | MUST | **Range guard** (AF-30): a quick check or life query outside the law's valid stress, temperature or LMP range is refused; after a solve, `check_creep` fails when any element's von Mises stress or temperature left the range, naming the elements and the extreme value. No extrapolation. | Creep laws are strongly non-linear and extrapolate badly | AF-30, PHY-01 policy |
| FR-CRP-18 | MUST | **Human disposition** (AF-34): a creep-life row with life below the required life or D ≥ limit, or a preload row below a required residual preload, is a 05 margin row with `disposition: "pending_human"`; only 05 `dispose_margin` with a human signature records acceptance. | Accepting a negative result is an approval act | AF-34 |
| FR-CRP-19 | MUST | **Stable codes** (AF-11) for every refusal and check item (TECHNICAL_SPEC §7.1), with ids or paths and a one-line remediation. | Agents act on codes | AF-11 |
| FR-CRP-20 | MUST | **Licensed data stays private**: creep laws and master curves from licensed sources (NIMS, MMPDS, supplier) are only in 08 `storage: private` libraries; their coefficients never appear in saved documents, live sync, exports or cloud MCP replies (08 TR-MAT-31/32). | Redistribution is barred | [R13], 08 MAT |
| FR-CRP-21 | SHOULD | **Increment and convergence report**: number of increments, last increment size, CETOL used, whether the hold reached the requested duration; a hold that stopped early is `CRP_HOLD_INCOMPLETE` and results are not used for life. | Silent early stops give wrong lives | [R1] |
| FR-CRP-22 | SHOULD | **Steep temperature table guard**: CalculiX interpolates Norton data linearly between temperature points [R1]; when A changes by more than 10× between neighbouring points, `check_creep` warns `CRP_TEMPERATURE_TABLE_COARSE` and asks for more points. | Linear interpolation of an exponential quantity is crude | [R1] (llull rule) |
| FR-CRP-23 | MUST | **Units** (AF-04): duration and increments take `{ value, unit }` (s, min, h, d, yr); A is stored with its unit string and converted for the deck (A·c_s⁻ⁿ for stress units, A·c_t^(m+1) for time units). | A's unit depends on n and m | generator §8 |

## 6. Workflows

### 6.1 CLI (operator's primary path)

```bash
llull search creep relaxation viscoelastic              # discover (AF-01)
llull describe set_creep_step creep_closed_form creep_report check_creep
llull guide                                             # physics section: units of A, m, duration; minimal creep plan (AF-03)

# 0. quick check before any mesh (seconds)
llull creep_closed_form check=bolt_relaxation \
  'inputs={"E_MPa":200000,"A":{"value":1e-18,"unit":"MPa^-5 s^-1"},"n":5,"sigma0_MPa":100,"kbOverKm":0.3333,"t":{"value":1e6,"unit":"s"}}' --json

# 1. one plan: geometry + 08 record + PHY-02 Norton model + 05 analysis (type creep) + set_creep_step
llull run bracket_creep.plan.json --validate --doc bracket.llull.json
llull run bracket_creep.plan.json --doc bracket.llull.json --kernel occt --json      # data.aliases.an -> analysis id

# 2. check, mesh, solve (05 transports; long ops report progress and honour --timeout)
llull check_creep analysisId=$an --doc bracket.llull.json --json
llull fea_mesh analysisId=$an --doc bracket.llull.json --progress --timeout 300 --json
llull fea_solve analysisId=$an --doc bracket.llull.json --progress --timeout 3600 --json

# 3. numbers first
llull creep_report analysisId=$an --doc bracket.llull.json --json     # histories, end-of-hold maxima, relaxation %
llull creep_rupture_life material=in718_bar stress='{"value":600,"unit":"MPa"}' temperature='{"value":923,"unit":"K"}' --json
llull creep_damage_summary analysisId=$an dutyCycle=@duty.json requiredLife='{"value":20000,"unit":"h"}' --json
llull check_creep analysisId=$an --doc bracket.llull.json --json      # ends every job

# 4. look and hand off
llull render_view view=iso analysisId=$an field=ceeq --save out/ceeq.png --doc bracket.llull.json
llull fea_export analysisId=$an format=calculix_inp --save out/bracket_creep.inp --doc bracket.llull.json
```

The agent reports in this order (AF-36): what was held and for how long, end-of-hold creep strain and stress, the quick
check ratio, every `unverified` input, every row needing a human, and "computed by llull, not approved — needs a
qualified engineer".

### 6.2 MCP (cloud)

Same commands through `build_project` and the `analysis` toolset. `fea_solve` exists only where the host provides
CalculiX, otherwise `FEA_TOOL_MISSING` (05). Quick checks and life queries work everywhere. Private-library laws are
redacted for non-local clients (08 TR-MAT-32); the reply says `available: false, reason: "licensed data not
available to this client"`.

### 6.3 Desktop UI (review and approval only)

Creep step panel (read-only view of the step definition), time-history chart over `creep_report` data, CEEQ contour
(optional, AF-21), law card (form, coefficients or "private", valid range, source, basis), and the 05 disposition dialog
for creep-life rows (human gate).

### 6.4 Surface matrix

| Capability | CLI (primary) | MCP | UI (review) |
| ---------- | ------------- | --- | ----------- |
| Quick checks | `llull creep_closed_form` | same | — |
| Creep set-up | `llull run`, `llull set_creep_step` | registry tools | step panel |
| Solve | `llull fea_solve` (05) | where configured | progress |
| Results | `llull creep_report` | same | history chart, contours |
| Life / damage | `llull creep_rupture_life`, `creep_damage_summary` | same | table |
| Disposition | prepare only (`FEA_HUMAN_GATE`) | prepare only | **complete** (signature) |

### 6.5 Error and edge behaviour

| Situation | Behaviour | FR |
| --------- | --------- | -- |
| Creep case on a material with no creep law | `set_creep_step` refused, `CRP_LAW_MISSING` | FR-CRP-02 |
| Stress or temperature outside the law range during a solve | Results recorded; `check_creep` fails `CRP_LAW_OUT_OF_RANGE` with element ids; life refused | FR-CRP-17 |
| Hold stopped before the requested duration (increment cut-backs exhausted) | `CRP_HOLD_INCOMPLETE`; results flagged, not used for life | FR-CRP-21 |
| Creep law with plasticity and a non-zero yield (overstress model) | Warning `CRP_OVERSTRESS_MODEL`: creep only above yield in CalculiX [R1]; suggest zero yield for creep below yield | FR-CRP-07 |
| Life query with no C and no master curve | Refused `CRP_LM_MODEL_MISSING` | FR-CRP-08, 14 |
| WLF below Tr | Refused `CRP_WLF_OUT_OF_RANGE` | FR-CRP-11 |
| Licensed library absent on this machine | Quick checks and solve refused with `MAT_LIBRARY_UNRESOLVED` (08) | FR-CRP-20 |

## 7. Acceptance criteria

`D` = `--doc case.llull.json --kernel occt --json`. Values and tolerances: `validation/expected_results.json`.

| # | Given | When (CLI) | Then (JSON) | VC |
| - | ----- | ---------- | ----------- | -- |
| AC-1 | A = 1e-10, n = 5, σ = 20 MPa, t = 1000 s | `llull creep_closed_form check=norton_constant_stress …` | `data.creepStrain` = 0.32 ± 0.5 % | VC-CRP-10 |
| AC-2 | relaxation inputs of VC-CRP-12 | `check=norton_relaxation` | `data.sigmaMPa` = 93.8687 ± 0.5 %; `data.timeToFractionS(0.5)` = 187 500 ± 1 % | VC-CRP-12 |
| AC-3 | tube a = 0.16, b = 0.25 m, p = 10 MPa, n = 5 | `check=thick_cylinder_stationary` | hoop at a 14.4666, at b 20.4666 MPa ± 3 % | VC-CRP-14 |
| AC-4 | `plans/crp_norton_unit_cube.plan.json` | run, `fea_mesh`, `fea_solve`, `creep_report` | probe `centre` last history point `ceeq` = 0.32 ± 1 % at `tS` = 1000 | VC-CRP-40 |
| AC-5 | `plans/crp_bar_relaxation.plan.json` | same | `sZzMPa` at 3600 s = 93.8687 ± 1 % | VC-CRP-41 |
| AC-6 | `plans/crp_thick_cylinder_stationary.plan.json` | same | end-of-hold hoop stresses ± 3 % of VC-CRP-14 | VC-CRP-42 |
| AC-7 | LM model with C = 20 explicit | `llull creep_rupture_life …` | LMP 18 400 K; iso-LMP t_r(850 K) 44.3669 h | VC-CRP-20 |
| AC-8 | no C, no master curve | same | exit 1, `CRP_LM_MODEL_MISSING` | VC-CRP-60 |
| AC-9 | any life / report result | — | `reviewRequired: true`, summary contains "not approved" | VC-CRP-61 |
| AC-10 | law with basis `typical` | `creep_report`, `check_creep` | `unverified: true`; warning `CRP_LAW_UNVERIFIED` | VC-CRP-62 |
| AC-11 | σ above the law range | `creep_closed_form`, `check_creep` after solve | `CRP_LAW_OUT_OF_RANGE` with ids and the extreme value | VC-CRP-63 |
| AC-12 | D ≥ limit row | agent `dispose_margin … decision=accepted` | exit 1, `FEA_HUMAN_GATE`, document unchanged | VC-CRP-64 |
| AC-13 | private-library law | save, reload without library | no coefficients in file; `available: false` | VC-CRP-66 |

## 8. Standards & regulatory alignment

| Reference | Use in llull | Status |
| --------- | ------------ | ------ |
| CalculiX `*CREEP` / `*VISCO` [R1] | Deck syntax, law form, step semantics | Verified in the manual at a pinned commit |
| NAFEMS R0027, R0049, Linkens 1993 [R3], [R4] | Future benchmark targets | Catalogue only (paid) |
| ASME BPVC III-5 [R9], RCC-MRx [R14] | Scope reference for time-fraction damage and inelastic-strain limits; **no compliance claim** | Search / catalogue only |
| Larson & Miller 1952 [R6] | Parameter definition | Via NEML docs and `reliability`; original not seen |
| WLF 1955 [R11] | Shift form and the universal constants | Search-verified secondary sources |
| NIMS creep data sheets [R13] | Data policy (private libraries only) | Terms search-verified |

llull claims no certification credit. Results say "for design / pre-sizing; not a certified creep assessment".

## 9. KPIs / success metrics

| KPI | Target | How measured |
| --- | ------ | ------------ |
| Quick-check correctness | 100 % of VC-CRP-10…34 within tolerance | unit tests driven by `expected_results.json` |
| FE agreement | VC-CRP-40…43 within tolerance on desktop | `npm --prefix server test`, `quality:physics` |
| Time to a first creep answer | ≤ 5 s for a quick check; ≤ 10 min agent wall time for a 20k-node bracket hold | agent driver timer |
| Silent safety values | 0 C, damage limits or factors used without a source or explicit value | VC-CRP-60 |
| Extrapolation leaks | 0 results outside a law range without a refusal or `check_creep` failure | VC-CRP-63 + production-gate scenario |
| Licensed-data leaks | 0 private coefficients in saved files, logs or cloud replies | VC-CRP-66 fuzz |

## 10. Risks & assumptions

| Risk / assumption | Impact | Mitigation |
| ----------------- | ------ | ---------- |
| Users treat a typical or fitted-elsewhere creep law as design data | Non-conservative life | `unverified` propagation, range guard, `reviewRequired`, no shipped data |
| CalculiX's viscoplastic model is an overstress model (creep only above yield) [R1] | No creep predicted below yield if a real yield is given | `CRP_OVERSTRESS_MODEL` warning; default deck writes a zero yield when only creep is wanted, as the manual suggests |
| "t" in `ε̇ = A σⁿ tᵐ` is total time [R1]; multi-step histories shift the time origin | Wrong primary-creep strain in later steps | m ≠ 0 limited to one hold step in MVP; open question TS §11 |
| Stationary solutions are reached only asymptotically | FE vs closed form mismatch | Hold long enough (creep strain ≫ elastic) and compare with the 3 % tolerance; report the ratio of creep to elastic strain |
| No Prony keyword in CalculiX [R1] | Viscoelastic FE delayed | Quick checks now; MFront `GeneralizedMaxwell` in V2 [R10]; GPL/CeCILL licence to clear |
| Paid benchmarks (NAFEMS) not available | Fewer external targets | Exact closed forms + CalculiX reference decks; buy R0027 later |

## 11. References

- [R1] CalculiX User's Manual (`*CREEP`, `*VISCO`, viscoplasticity, user materials) — G. Dhondt — https://github.com/Dhondtguido/CalculiX/tree/fd588701edd6a92fde06e99b1bdf01f3b0f80f2c (accessed 2026-10)
- [R2] CalculiX test suite `test/beamcr*.inp` and references — same URL (accessed 2026-10)
- [R3] NAFEMS R0027 Benchmarks for creep; R0049 background — NAFEMS — https://nafems.org/publications/resource_center/r0027 (accessed 2026-10, search, catalogue)
- [R4] D. Linkens, Selected Benchmarks for Material Non-Linearity vol. 2, NAFEMS 1993 — cited by [R5] (not reached)
- [R5] COMSOL model 12397 "Combining Elastoplastic and Creep Material Models" — COMSOL — https://www.comsol.com/model/combining-elastoplastic-and-creep-material-models-12397 (accessed 2026-10, search)
- [R6] Larson & Miller (1952) via NEML documentation — Argonne National Laboratory — https://github.com/Argonne-National-Laboratory/neml/tree/65ab2a648a975e2e9de8e1371be270567f9683ac (accessed 2026-10)
- [R7] `reliability` 0.9.0 `creep_failure_time` — https://pypi.org/project/reliability/0.9.0/ (accessed 2026-10)
- [R8] NASA NTRS 19930084003 — https://ntrs.nasa.gov/api/citations/19930084003/downloads/19930084003.pdf (accessed 2026-10, search)
- [R9] ASME BPVC Section III Division 5 — catalogue https://standards.nimonik.com/products/asme/bpvcptiiipt5/ ; ANL report https://www.osti.gov/biblio/1480531 (accessed 2026-10, search)
- [R10] MFront / TFEL (CalculiX interface, GeneralizedMaxwell) — https://github.com/thelfer/tfel/tree/ff0959eceb602a0ab0e2e455afd9193a2cd725db (accessed 2026-10)
- [R11] Williams–Landel–Ferry equation — https://en.wikipedia.org/wiki/Williams%E2%80%93Landel%E2%80%93Ferry_equation ; https://www.stevenabbott.co.uk/practical-rheology/WLF.php (accessed 2026-10, search)
- [R12] code_aster test suite (LEMAITRE / Norton) — EDF — https://gitlab.com/codeaster/src/-/tree/94bf28a308de5a77587675a598aacdddb722f84e/astest (accessed 2026-10)
- [R13] NIMS Creep Data Sheets / MatNavi — https://cds.nims.go.jp/en/ ; https://mits.nims.go.jp/en/ (accessed 2026-10, search)
- [R14] RCC-MRx (AFCEN) — scope only, no page reached
- L1 llull laws and packs — `.claude/rules/architecture.md`, `docs/aerospace/05-fea-cae-handoff/`, `docs/aerospace/08-materials-standards-libraries/`, `docs/physics/README.md`
