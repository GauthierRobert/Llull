# PHY-01 — Property models (multi-variable and fitted) — Functional spec

Gap id **PROP** · Status: specification (no implementation) · Written 2026-10-15
Companion: [TECHNICAL_SPEC.md](TECHNICAL_SPEC.md) · Validation: [validation/README.md](validation/README.md) ·
Sources: [validation/sources.md](validation/sources.md) · Gap list: [../README.md](../README.md) (row PHY-01)

---

## 1. Summary

After the aerospace packs, a llull material is the 08 MAT `MaterialRecord`: scalar `PropertyValue`s with unit,
basis and provenance, plus optional **temperature tables** (`TemperatureDependence`, linear interpolation, no
extrapolation; 08 TR-MAT-13). That is enough for room-temperature stress work. It is not enough for:

- **Cryogenic and hot parts.** Thermal conductivity of 6061-T6 changes by a factor of about 30 between 4 K and
  300 K (VC-PROP-01: 5.35 → 155 W/(m·K)); specific heat changes by more than three orders of magnitude
  (VC-PROP-02). The reference data for these ranges, the NIST cryogenic material database, is published as
  **fitted laws** (a degree-8 polynomial in log10 T, or a rational form for copper), each with a stated data
  range, an equation range and a curve-fit error [R1–R6]. A table cannot carry those facts.
- **Laws, not points.** Diffusion, creep rates and many polymer properties follow Arrhenius laws; strain-rate
  sensitivity follows multiplicative rate factors. These have parameters, not tables.
- **More than one variable.** Yield strength depends on temperature *and* strain rate; properties after
  exposure depend on time at temperature (08 only records an `exposureHours` qualifier).
- **Fitting.** A user with test points (their own or from a report) needs llull to fit a law, report how good
  the fit is, and keep the data hash and fit statistics with the model.
- **Guarding the edges.** An agent that asks for k at 2 K, or at 400 K, must get a refusal or a loud warning
  with a stable code, never a silently extrapolated polynomial (polynomials in log T diverge fast outside
  their range).

This gap adds a **`PropertyModel`** to the 08 record (`MaterialRecord.propertyModels?`): a fitted or tabulated
law `y = f(T, strain rate, time, …)` with units, validity ranges per variable, uncertainty kind, basis and
provenance; one evaluator that every physics pack uses; and the commands `define_property_model`,
`evaluate_property`, `sample_property`, `fit_property_model` and `check_property_models`. PHY-02
(constitutive models), PHY-03 (thermal), PHY-04 (thermo-mechanical), PHY-05 (nonlinear), PHY-11 (creep) and
PHY-19 (explicit) read material data only through this evaluator.

## 2. Aerospace context & value

### 2.1 Where operating-point properties drive the result

| Programme / workflow | Why a property model is needed | Range |
| -------------------- | ------------------------------ | ----- |
| Cryogenic propellant tanks, feed lines, struts (LH2 20 K, LOX 90 K) | Heat leak through supports is ∫ k dT; thermal contraction of Al vs stainless joints | 4–300 K |
| Spacecraft instruments, cryocoolers, superconducting magnets | Copper k depends on purity (RRR) by an order of magnitude at 20 K (VC-PROP-06: 1 368 vs 2 423 W/(m·K) at RRR 50 / 100) | 4–300 K |
| G-10 / fiberglass supports | Low k with strong direction dependence (normal vs warp) | 10–300 K |
| Hot structure, brakes, engine mounts | E, strength, CTE fall with temperature; MMPDS curves are "% of room temperature" vs T | 200–900 K |
| Bird strike, crash, forming | Flow stress rises with strain rate (multiplicative rate factor) | 10⁻⁴–10⁴ s⁻¹ |
| Polymer seals, adhesives | Arrhenius ageing / diffusion; WLF time-temperature shift (PHY-02) | −55…+150 °C |

### 2.2 Who does it today, with which tools

| Tool | Public capability |
| ---- | ----------------- |
| NIST cryogenic material properties pages | Coefficients a…i per material and property, data range, equation range, fit error; plots [R1–R6] |
| Open-source cryogenic calculators (cryoheatflow, cryocalc, spacemat, ipmucmblab_genlib) | Re-type the NIST coefficients; cryoheatflow refuses outside the data range and only extrapolates on explicit request with a warning [R9] |
| FE solvers (CalculiX, Abaqus, Nastran) | Accept temperature *tables* only (CalculiX interpolates between temperature data points) [R14]; fitted laws must be tabulated by the user |
| Spreadsheets | Where most fits are done; no provenance, no range guard |

The weak points are the same everywhere: coefficients are re-typed (we found two open transcriptions of one
NIST Invar fit that differ in one coefficient, VC-PROP-09), the valid range is lost, and solvers get tables with
no record of the law behind them. llull's value is one model object that keeps the coefficients, ranges,
fit error and source together, evaluates them the same way for every analysis, refuses outside the range,
and tabulates them for the solver with a stated interpolation error.

## 3. Personas & user stories

Roles follow [`../../aerospace/AGENT_FIRST.md`](../../aerospace/AGENT_FIRST.md) §1. The owner is not assumed to know
what a log-polynomial fit or an equation range is. llull carries those rules itself.

| Role | Who | Uses | Main need |
| ---- | --- | ---- | --------- |
| **Operator (primary)** | AI agent driving the `llull` CLI (cloud: MCP) | `define_property_model`, `evaluate_property --json`, `sample_property`, `fit_property_model`, `check_property_models` | Values with units, range status, uncertainty kind, provenance and stable codes |
| **Owner** | Person asking "how much heat leaks through this strut?" or "what is E at −196 °C?" | Natural language | A number with a plain statement of where it comes from and how sure it is |
| **Qualified reviewer** | Thermal or M&P engineer, only where the value feeds a certification or safety decision | Desktop review surface | Accepts a fitted model for design use (human gate inherited from 08 FR-MAT-30) |

User stories:

- **US-1 (owner → operator).** "What is the thermal conductivity of 6061-T6 at liquid-nitrogen temperature?"
  The agent runs `evaluate_property material=aa6061_t6 property=k at.T=-196degC --json` and reports
  83.6 W/(m·K), the NIST source and page, "inside the measured range 4–300 K", and the fit error band
  (±0.5 %, *fit error relative to data*, not a confidence bound).
- **US-2 (operator).** The agent asks Ti-6Al-4V k at 10 K. It gets exit 1, `PROP_OUT_OF_RANGE`, the valid ranges
  (data 23–300 K, equation 20–300 K) and the remediation "supply a model sourced for this range". At 21 K it
  gets a value with `rangeStatus: "in_equation_range_only"`, `unverified: true` and warning
  `PROP_OUTSIDE_DATA_RANGE`.
- **US-3 (operator).** The owner hands over test points (T, strength). The agent runs `fit_property_model` with
  form `arrhenius` or `polynomial`, reads the residual statistics, picks the simplest form that meets the
  named quality threshold, then records it with `define_property_model` (the dataset hash and fit record are
  kept). `check_property_models` warns that the model is `unverified` until a source with a basis exists.
- **US-4 (operator, for PHY-03).** The thermal pack needs k(T) as a CalculiX table. It calls the shared
  tabulation helper (`sample_property mode=solverTable`), which returns the fewest points that keep the
  linear-interpolation error under the named default 0.1 %, and records that error in the deck header.
- **US-5 (operator).** "Heat leak through a 304 tube, 4 K to 300 K": `sample_property … integrate=true` returns
  ∫ k dT = 3 031 W/m (VC-PROP-20), which the agent multiplies by A/L and reports with the NIST source.
- **US-6 (reviewer).** The M&P engineer opens the model in the desktop app, sees source, coefficients hash,
  ranges and fit residuals, and marks it accepted for design use (09 signing, human gate).

## 4. Scope / out of scope

| Phase | In scope |
| ----- | -------- |
| **MVP** | `PropertyModel` type on the 08 record; forms `constant`, `table1d` (linear / loglinear / loglog / step), `polynomial`, `log10Polynomial`, `nistRational`, `arrhenius`, `powerLaw`, `piecewise`; validity ranges with data vs equation range; range guard and codes; units incl. °C/°F/K; `evaluate_property`, `sample_property` (incl. integral and derivative), `define_property_model`, `remove_property_model`, `check_property_models`; 08 temperature tables evaluated through the same command; unverified / reviewRequired propagation |
| **V1** | Multi-variable: `product` (separable f(T)·g(rate)), `table2d` (bilinear, log axes), rate factors (Johnson-Cook, Cowper-Symonds); `fit_property_model` (linear least squares forms); uncertainty bands; solver tabulation helper; seed library of NIST cryogenic fits re-verified against the primary pages |
| **V2** | Non-linear fits (Levenberg-Marquardt for forms not linear in parameters); exposure-time families; environment variables (humidity, fluence) once a pack needs them; uncertainty propagation into analyses (with PHY-18) |

**Out of scope.** Computing statistical allowables (A/B basis) from test data (08 V3 / CMH-17 / MMPDS process);
shipping MMPDS or other licensed curves (08 private libraries carry them); constitutive laws (stress–strain,
hyperelastic, creep, rate laws in stress space): those are PHY-02 `MaterialModel`s, which reuse this pack's
evaluator for their temperature-dependent parameters.

## 5. Functional requirements

| Id | Pri | Requirement | Rationale | Source |
| -- | --- | ----------- | --------- | ------ |
| FR-PROP-01 | MUST | A material record carries zero or more **property models**. Each names the property, output unit, input variables with units, form, validity ranges, basis, optional direction and condition (temper, RRR, environment), uncertainty, provenance, and at most one `preferred` per (property, direction, basis, condition). Models coexist with 08 `PropertyValue`s. | One record, one provenance system (08 FR-MAT-04) | 08 TR-MAT-11; README §6.2 |
| FR-PROP-02 | MUST | Supported forms: constant, 1D table, polynomial, polynomial in log10 of the variable (NIST), NIST rational form (copper), Arrhenius `A·T^m·exp(−Q/RT)`, power law, piecewise. V1: separable product, 2D table, rate factors. | These cover the published cryogenic, thermal and rate data | R1–R6; VC-PROP-01…12 |
| FR-PROP-03 | MUST | `evaluate_property` returns the value at an explicit operating point (every variable given with its unit) with unit, model id, range status, basis, provenance, method and `unverified`. Evaluation is deterministic. | Agents need numbers with context (AF-10, AF-35) | VC-PROP-01…07 |
| FR-PROP-04 | MUST | Every model has a **validity range per variable**, split into the data range (measurements) and the equation range (where the source allows the fit, ⊇ data range). Outside the equation range the query is refused (`PROP_OUT_OF_RANGE`) with the ranges. Between the two it returns the value with warning `PROP_OUTSIDE_DATA_RANGE` and `unverified: true`. There is **no extrapolation mode**. | Polynomials in log T diverge outside the range; NIST states both ranges | R2–R4; VC-PROP-08 |
| FR-PROP-05 | MUST | Tables are strictly increasing in the variable and declare their interpolation mode (`linear`, `loglinear`, `loglog`, `step`); no mode is defaulted. Piecewise models declare their breakpoints; at a breakpoint the left segment applies; a jump larger than the named tolerance (1e-3 relative) is reported by the check. | NIST 304 E is split at 57 K (VC-PROP-09); silent jumps break solvers | VC-PROP-09, 11 |
| FR-PROP-06 | SHOULD | Multi-variable models: a separable product of single-variable forms, a 2D table (bilinear, optional log axis), and multiplicative rate factors (Johnson-Cook `1 + C ln(ε̇/ε̇0)`, Cowper-Symonds `1 + (ε̇/D)^(1/q)`). | Yield vs T and rate; MMPDS-style curve families | VC-PROP-12 |
| FR-PROP-07 | SHOULD | Derived quantities: the analytic derivative with respect to any variable; instantaneous CTE from a thermal-strain model `α = (ds/dT)/(1 + s)`; secant (mean) CTE between a reference temperature and T. | NIST publishes thermal strain ΔL/L293; analyses need α | VC-PROP-07 |
| FR-PROP-08 | MUST | Provenance per model: source document, page or table locator, access date, and a hash of the coefficients as entered. Two models that cite the same source and locator but have different coefficients raise `PROP_SOURCE_CONFLICT`. | Re-typed coefficients drift (Invar example) | VC-PROP-09 |
| FR-PROP-09 | SHOULD | `fit_property_model` fits a form to (x, y) data by least squares (forms linear in their parameters in V1), returns the model ready for `define_property_model`, residuals (RMS, max absolute, max relative, R²), conditioning, and the dataset hash. It never attaches the model itself. | Fit is a proposal the agent or reviewer accepts | VC-PROP-13, 14 |
| FR-PROP-10 | SHOULD | Uncertainty is typed: `fitErrorVsData` (NIST "curve fit % error relative to data"), `measurement`, or `statistical` (with coverage). A band is returned on request and labelled with its kind; a fit error is never presented as a confidence bound. | NIST fit errors are not uncertainties of the property | R2; VC-PROP-15 |
| FR-PROP-11 | MUST | Units: every variable and output carries a unit from the 08 unit grammar. Absolute temperatures convert affinely (°C, °F, K, °R); temperature differences use the delta units. Results state both the requested and the model unit. | No unit inferred silently (AF-04) | VC-PROP-16 |
| FR-PROP-12 | MUST | 08 `PropertyValue`s with a `TemperatureDependence` table are evaluated by `evaluate_property` with the same result shape (adapter, no data migration); 08 `get_material_allowable` keeps its contract. | One query for all temperature data | VC-PROP-17 |
| FR-PROP-13 | MUST | **Unverified propagation** (AF-32): a result is `unverified` when the model's basis is `typical`, `supplier_unstated` or `unspecified`, the source is not verified (08 rule), the point lies outside the data range, or the model came from `fit_property_model` on data without a cited source. The reasons list follows every result computed from it (PHY-02…19). | The owner cannot tell typical data from verified data | AF-32; VC-PROP-18 |
| FR-PROP-14 | MUST | **Stable error codes** (AF-11) from TECHNICAL_SPEC §7.1 on every refusal and check item, with ids or param paths and a remediation. | Agents act on codes | VC-PROP-19 |
| FR-PROP-15 | MUST | **Readiness check** (AF-20): `check_property_models` lists, with codes and severities, models used by an analysis that are unverified, have no equation range, conflict with another transcription, have discontinuities, have non-positive values inside their range for a positive-only property (k, cp, E), or whose fit record fails the named quality threshold. 08 `check_materials` includes these items. | The agent proves its own work | VC-PROP-19 |
| FR-PROP-16 | MUST | **Named defaults** (AF-31): every threshold applied without an explicit param (discontinuity tolerance 1e-3, solver-table interpolation error 1e-3, fit quality max relative residual 0.05, sample count 101) is named in `data.defaults[]` with `source` and `defaulted: true`. | No silent engineering choice | VC-PROP-18 |
| FR-PROP-17 | MUST | All physics packs read property values through the one evaluator (TECHNICAL_SPEC §3.3); no pack defines its own property storage or interpolation. | One law, one answer, everywhere | README §6.2 |
| FR-PROP-18 | SHOULD | `sample_property` returns a bounded table (≤ 1 000 points, linear or log spacing) for review and plots (AF-21), the integral ∫ y dx over the range (conductivity integral), and a **solver table**: the fewest breakpoints such that linear interpolation stays within the named error. | Heat-leak sizing; FE solvers take tables | VC-PROP-20 |
| FR-PROP-19 | MUST | Models from a `private` library are never serialized (08 TR-MAT-31); a fit record stores the dataset hash, never private data points. | Licensed data stays local | 08 FR-MAT-08 |
| FR-PROP-20 | SHOULD | A seed library of NIST cryogenic fits (US Government work) ships only after each coefficient set is re-read from the primary NIST page, pinned by URL + sha256 in `sources.lock.json` (08 TR-MAT-41), and flagged with its range and fit error. Until then the coefficients live in this validation folder only. | Primary not reached from the authoring sandbox | R1; VC-PROP-01…07 |
| FR-PROP-21 | COULD | Further variables (exposure time, humidity, fluence) are added by extending one core union and the property catalogue; packs PHY-11/13/14/15 list their additions. | Open/closed (C6) | — |
| FR-PROP-22 | MUST | Property-model edits are pure commands recorded in feature history and replayable; queries are read-only. | L1, L3, L8 | — |
| FR-PROP-23 | MUST | `reviewRequired: true` (AF-33) on every evaluation made with `forCertification: true`, and on every fitted model until a qualified reviewer accepts it (human gate, 08 FR-MAT-30 / 09 signing). | Fits can feed safety decisions | VC-PROP-18 |

## 6. Workflows

### 6.1 CLI (`llull`, the operator's primary path)

```bash
llull search property model ; llull describe evaluate_property           # discover; units of every param (AF-01..04)

# 1. a record (08) and a NIST-style model, in one plan (AF-05)
llull run validation/plans/cryo_6061_k_proposed.json --validate --doc tank.llull.json
llull run validation/plans/cryo_6061_k_proposed.json --doc tank.llull.json --json

# 2. numbers with context (AF-10)
llull evaluate_property '{"material":"aa6061_t6","property":"k","at":{"T":{"value":-196,"unit":"degC"}},"band":true}' --doc tank.llull.json --json
llull evaluate_property '{"material":"ti6al4v","property":"k","at":{"T":{"value":10,"unit":"K"}}}' --doc tank.llull.json --json ; echo "exit $?"   # 1, PROP_OUT_OF_RANGE
llull sample_property '{"material":"ss304","property":"k","variable":"T","from":{"value":4,"unit":"K"},"to":{"value":300,"unit":"K"},"integrate":true}' --doc tank.llull.json --json

# 3. fit owner data, inspect, then record
llull fit_property_model --params validation/plans/fit_arrhenius_params.json --json > fit.json
llull define_property_model "$(jq '{material:"seal_epdm", model:.data.model}' fit.json)" --doc tank.llull.json --json

# 4. prove, then hand off
llull check_property_models --doc tank.llull.json --json                 # pass / warn / fail with codes (AF-20)
```

`--dry-run` works for `define_property_model` and `remove_property_model` (AF-42). Every refusal exits 1 with
`data.code` and `data.remediation`. The agent's report to the owner lists, in order: the value and unit, the
source, the range status, the uncertainty kind, `unverified` reasons, and what needs a reviewer.

### 6.2 MCP (cloud)

The `materials` toolset (08) gains `define_property_model`, `remove_property_model`, `evaluate_property`,
`sample_property`, `fit_property_model`, `check_property_models`. Queries are read-only (MCP `readOnlyHint`).
Private-library models are redacted for cloud clients exactly like 08 values (08 TR-MAT-32).

### 6.3 Desktop UI (review surface only)

Material inspector gains a "Models" tab: per model, the form, coefficients, ranges (data / equation), fit error,
source link and coefficient hash; a chart drawn from `sample_property` data with the data range shaded and the
equation-only band hatched; badges `unverified`, `conflict`, `fitted`. Accepting a fitted model for design use
is a human gate (09 signing).

## 7. Acceptance criteria

`D` = `--doc case.llull.json --json`. Values are in `validation/expected_results.json` under the VC id.

| # | Given | When (CLI) | Then (JSON) | VC |
| - | ----- | ---------- | ----------- | -- |
| AC-1 | 6061-T6 k model (NIST log-polynomial) | `llull evaluate_property … at.T=77K D` | `data.value` 83.5314419471 W/(m·K) (rel 1e-9), `rangeStatus: "in_data_range"`, `provenance.sourceId` set | VC-PROP-01 |
| AC-2 | same model | `at.T=-196degC` and `at.T=-320degF` | 83.6343787049 and 83.9384687781 W/(m·K); `data.at.T` echoes 77.15 K / 77.5944 K | VC-PROP-16 |
| AC-3 | OFHC Cu RRR 50 model (rational form) | `at.T=20K` | 1 367.85481145 W/(m·K) | VC-PROP-06 |
| AC-4 | Ti-6Al-4V k (data 23–300 K, equation 20–300 K) | `at.T=10K`; `at.T=21K` | exit 1 `PROP_OUT_OF_RANGE` with both ranges; at 21 K a value, `rangeStatus: "in_equation_range_only"`, `unverified: true`, warning `PROP_OUTSIDE_DATA_RANGE` | VC-PROP-08, 18 |
| AC-5 | 6061-T6 thermal-strain model (piecewise, constant below 18 K) | `evaluate_property property=cte at.T=293K derivative=T` | α = 2.26423649957e-5 1/K, `method` names the derivation | VC-PROP-07 |
| AC-6 | 304 E piecewise split at 57 K | `check_property_models D` | no `PROP_DISCONTINUITY` (jump 0.0373 GPa = 1.7e-4 relative < 1e-3); with tolerance 1e-5 given explicitly: warning listed | VC-PROP-09 |
| AC-7 | two Invar models citing the same NIST page with different `e` | `check_property_models D` | warning `PROP_SOURCE_CONFLICT` naming both model ids; difference at 300 K = 8.1e-7 | VC-PROP-09 |
| AC-8 | synthetic table (100,10),(200,40),(400,160) | evaluate at 300 K in each mode | linear 100, loglinear 80, loglog 90, step 40 | VC-PROP-11 |
| AC-9 | 27 samples of the 6061 k fit | `fit_property_model form=log10Polynomial degree=7` | refit within 1e-8 relative at every sample; coefficients within 1e-5 of NIST | VC-PROP-13 |
| AC-10 | synthetic Arrhenius data | `fit_property_model form=arrhenius` | Q = 150 000 J/mol, A = 1e-3 1/s (rel 1e-9) | VC-PROP-14 |
| AC-11 | 304 k model | `sample_property integrate=true 4–300 K` | ∫ k dT = 3 030.84358308 W/m (rel 1e-8) | VC-PROP-20 |
| AC-12 | 08 percentOfRT table on a 60 ksi RT value | `evaluate_property … at.T=400degF` | 39 ksi, same as 08 VC-MAT-16 | VC-PROP-17 |
| AC-13 | the wrong inputs of VC-PROP-19 | each command | exit 1, the listed `data.code`, non-empty `data.remediation` | VC-PROP-19 |

## 8. Standards & regulatory alignment

- **No regulation prescribes a property-model format.** 14 CFR 25.613 and MMPDS govern *allowables* (08); this
  gap carries physical properties and laws, and inherits 08's basis and unverified rules for any strength
  property it touches (08 FR-MAT-03, FR-MAT-25).
- **MMPDS / MIL-HDBK-5 elevated-temperature curves** are "% of room-temperature value vs temperature, after
  exposure time" (08 R24): the `ratioOf` + `table1d` / `table2d` (T, exposure) forms represent them; licensed
  values stay in private libraries.
- **NIST cryogenic database** [R1–R7]: public US Government data; llull cites page, coefficients, ranges and fit
  error exactly as published.
- **SI 2019 exact constants** (R = N_A·k_B) for Arrhenius forms [R10].
- **Solver conventions.** CalculiX interpolates material data linearly between temperature data points [R14];
  the solver table (FR-PROP-18) makes that interpolation error explicit.

## 9. KPIs / success metrics

| KPI | Target |
| --- | ------ |
| Evaluation agrees with the generator for every VC-PROP-01…07 point | rel ≤ 1e-9 |
| Evaluations outside the equation range that return a number | 0 |
| Results computed outside the data range or from unverified models without `unverified: true` | 0 |
| Seed-library models with primary URL + sha256 + range + fit error | 100 % |
| `evaluate_property` latency (single point, desktop) | ≤ 1 ms |
| Solver table for a 4–300 K log-polynomial at 1e-3 | ≤ 60 points |
| Agent completes the "cryogenic strut heat leak" scenario unattended | ≥ 9 of 10 runs (AF-23) |

## 10. Risks & assumptions

| Risk | Mitigation |
| ---- | ---------- |
| NIST coefficients re-typed wrong | Cross-checked transcriptions (≥ 2 agree for every A-grade set); coefficient hash; `PROP_SOURCE_CONFLICT`; seed library only after primary re-read (FR-PROP-20) |
| Agents treat the fit error as a confidence bound | Typed uncertainty; result label "fit error relative to data"; check warning |
| Extrapolation pressure ("just give me 2 K") | No extrapolation mode; the agent must source a model for that range |
| Ill-conditioned polynomial fits | Scaled basis and QR (TECHNICAL_SPEC §5.4); conditioning reported; `PROP_FIT_ILL_CONDITIONED` |
| Unit confusion between absolute and delta temperatures | Separate unit kinds in the grammar; tests at °C/°F/K |
| Assumption | 08 MAT (record, provenance, unit grammar, private libraries) and 09 signing are implemented first |

## 11. References

Direct fetches of NIST were blocked from the authoring sandbox (DNS / proxy 403); NIST facts come from search
extracts of the pages and from four independent open-source transcriptions. Grades are in
[validation/sources.md](validation/sources.md).

- [R1] NIST Cryogenics Technologies Group, Material Properties index — https://trc.nist.gov/cryogenics/materials/materialproperties.htm (accessed 2026-10; search extract)
- [R2] NIST, Material Properties: 6061-T6 Aluminum (UNS A96061) — https://trc.nist.gov/cryogenics/materials/6061%20Aluminum/6061_T6Aluminum_rev.htm (accessed 2026-10; search extract)
- [R3] NIST, Material Properties: 304 Stainless (UNS S30400) — https://trc.nist.gov/cryogenics/materials/304Stainless/304Stainless_rev.htm (accessed 2026-10; search extract)
- [R4] NIST, Material Properties: Ti 6Al 4V (UNS R56400) — https://trc.nist.gov/cryogenics/materials/Ti6Al4V/Ti6Al4V_rev.htm (accessed 2026-10; search extract)
- [R5] NIST, Material Properties: OFHC Copper — https://trc.nist.gov/cryogenics/materials/OFHC%20Copper/OFHC_Copper_rev1.htm (accessed 2026-10; via transcriptions)
- [R6] NIST, Material Properties: G-10 CR Fiberglass Epoxy — https://trc.nist.gov/cryogenics/materials/G-10%20CR%20Fiberglass%20Epoxy/G10CRFiberglassEpoxy_rev.htm (accessed 2026-10; via transcriptions)
- [R7] Marquardt, Le, Radebaugh, "Cryogenic Material Properties Database" (2000) — https://trc.nist.gov/cryogenics/Papers/Material_Properties/2000-Cryogenic_Material_Properties_Database.pdf (accessed 2026-10; search listing only)
- [R8] Cryogenic Materials Repository: A Public Resource and New Measurements for Cryogenic Research Applications — arXiv 2509.23422 — https://arxiv.org/pdf/2509.23422 (accessed 2026-10; search extract: new 6061-T6 data consistent with NIST fits ≥ 4 K)
- [R9] Transcriptions: circuitqed/cryocalc, Krataios14/spacemat, amccaugh/cryoheatflow, ipmu-lab/ipmucmblab_genlib — GitHub raw files listed in `validation/nist_cryogenic_fits.json` (accessed 2026-10-15, downloaded)
- [R10] SI Brochure, 9th edition (2019): exact values of N_A and k — BIPM — https://www.bipm.org/en/publications/si-brochure (definitional; not fetched)
- [R11] 08 MAT pack — llull — `docs/aerospace/08-materials-standards-libraries/`
- [R12] 05 FEA pack — llull — `docs/aerospace/05-fea-cae-handoff/`
- [R13] AGENT_FIRST / TEMPLATE — llull — `docs/aerospace/AGENT_FIRST.md`, `docs/aerospace/TEMPLATE.md`
- [R14] CalculiX ccx 2.23 manual, *ELASTIC / *PLASTIC (temperature data points, interpolation) — mirror https://raw.githubusercontent.com/WonhoLee1/WHT_Calculixent/HEAD/wht_calculixent_doc/CalculiX/ccx_2.23/doc/ccx/node274.html and node333.html (accessed 2026-10-15, downloaded)
- [R15] Physics gap list — llull — `docs/physics/README.md`
