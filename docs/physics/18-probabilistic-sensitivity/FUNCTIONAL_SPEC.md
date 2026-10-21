# PHY-18: Probabilistic analysis & sensitivity — functional specification

Gap id **PRB** · status: specification · written 2026-10-15 · technical spec: [`TECHNICAL_SPEC.md`](TECHNICAL_SPEC.md)
· validation pack: [`validation/README.md`](validation/README.md) · sources register: [`validation/sources.md`](validation/sources.md)

## 1. Summary

Every llull result today is a single deterministic number: one mass, one margin of safety, one stress. Real inputs
scatter: material strength and stiffness (which is why A- and B-basis allowables are statistical [R8]), sheet
thickness within tolerance, load magnitudes, temperatures. An owner who is not an engineer asks two questions the
deterministic model cannot answer:

1. **How sure are we?** What is the probability that the part fails (or that the mass exceeds the budget), and how
   far is the design from that boundary (the reliability index β)?
2. **What matters?** Which parameter drives the result, so that tolerances, material choice or test effort go where
   they count?

PHY-18 adds random variables bound to document parameters, 08 material properties or 05 load scales; **seeded Monte
Carlo and Latin hypercube sampling** (reusing the 03 GDT seeded PRNG); **FORM** (Hasofer–Lind / Rackwitz–Fiessler)
with importance factors and the design point, plus a **SORM** (Breitung) correction [R1]–[R3]; **variance-based
global sensitivity** (Sobol first-order and total indices) [R6]; and **local parameter sensitivities** through the
feature history (perturb a parameter with `set_parameter`, regenerate, re-query) [L1]. Every result is a query that
returns data with units, provenance, named defaults and the review flag; probabilities never become an approval.

## 2. Aerospace context & value

| Context | Today (who / which tools) | What llull adds | Source |
| ------- | ------------------------- | --------------- | ------ |
| Statistical allowables | MMPDS: A-basis = value that at least 99 % of the population equals or exceeds with 95 % confidence; B-basis = 90 % with 95 % confidence. CMH-17 frames them as 95 % lower confidence bounds on the 1st / 10th percentile | Shows what a basis value means statistically (tolerance factor k(n)), and lets scatter on properties enter a reliability study; computing allowables from test data stays in 08 MAT V3 | [R8] |
| Structural reliability | FORM / SORM are the classical methods; the Hasofer–Lind index is invariant to the formulation of the limit state; Breitung's asymptotic formula corrects FORM with curvatures | `run_reliability_study` returning β, Pf, design point, importance factors, SORM correction | [R1]–[R3] |
| Sampling | Monte Carlo with a fixed seed for reproducibility; Latin hypercube sampling (McKay, Beckman, Conover 1979) reduces variance for the same budget | Seeded MC and LHS on any registry response (pure queries in MVP, FE responses through 05 transports in V1) | [R4], 03 GDT |
| Global sensitivity | Sobol indices with the Saltelli / Jansen estimators are standard (SALib MIT, OpenTURNS LGPL, UQpy MIT, Chaospy MIT); the Ishigami function is the usual benchmark with closed-form indices | `sensitivity_indices` with bootstrap confidence intervals, validated on Ishigami | [R5]–[R7] |
| Parametric CAD | Parameters drive the feature history; `set_parameter` regenerates dependent steps | Local derivatives and elasticities of any query result with respect to any document parameter | [L1] |

**Value statements** (sourced only): basis definitions are regulatory practice [R8]; the reliability and sensitivity
methods are classical and openly implemented [R1]–[R7]. No claimed savings.

## 3. Personas & user stories

| Role | Who | Uses | Main need |
| ---- | --- | ---- | --------- |
| **Operator (primary)** | AI agent on the `llull` CLI (MCP for cloud) | `llull define_random_variable`, `llull define_limit_state`, `llull propagate_uncertainty`, `llull run_reliability_study`, `llull sensitivity_indices`, `llull parameter_sensitivity`, `llull check_probabilistic` | Reproducible statistics with units and confidence bounds, stable codes, a check to close the job |
| **Owner** | Not an engineer | Natural language | "The mass stays under 22 g with 99.9 % probability; thickness drives 80 % of the scatter"; "this probability needs a qualified engineer before it supports any safety claim" |
| **Qualified reviewer** | Stress / reliability engineer | Desktop review: distributions, correlation, method, convergence | Approves the probabilistic model and any use of a Pf in a safety argument (human gate) |

User stories:

- **US-1.** "How much does the mass vary with the machining tolerances?" The agent binds `w`, `h`, `d` to normal
  variables (σ from the tolerance), runs `propagate_uncertainty` (LHS, 10 000 samples, seed), and reports mean, σ,
  99.9 % quantile with a confidence interval.
- **US-2.** "Which dimension matters most?" `parameter_sensitivity` gives ∂m/∂w etc. and elasticities;
  `sensitivity_indices` gives Sobol shares when the response is non-linear.
- **US-3.** "What is the probability that the lug fails?" With 05 margins available, the agent defines
  g = allowable − applied, binds the allowable to the PHY-01 `PropertyModel.uncertainty` of the 08 record (statistical band with its coverage and provenance) and the load
  scale, runs `run_reliability_study` and checks it with Monte Carlo; it reports β, Pf, design point and importance
  factors, and says that a qualified engineer must review before the number is used.
- **US-4.** A variable is bound to an 08 `typical` value: every result carries `unverified` and
  `PRB_INPUT_UNVERIFIED`.
- **US-5.** FORM does not converge or the limit state is strongly non-linear (SORM/FORM ratio far from 1, or FORM
  and MC disagree): `check_probabilistic` warns `PRB_FORM_MC_DISAGREE`; the agent reports the MC value with its interval.
- **US-6.** The reviewer accepts a probabilistic result for use in a safety argument with a signature
  (`accept_reliability_result`); the agent cannot (`PRB_HUMAN_GATE`).

## 4. Scope / out of scope

| Phase | In scope |
| ----- | -------- |
| **MVP** | Random variables (normal, lognormal, uniform, truncated normal, Weibull, Gumbel) bound to parameters, 08 properties (as a distribution around the record value with a sourced CoV) or free symbols; Gaussian correlation (Nataf for non-normal marginals in V1; MVP: correlated normals only, independent otherwise). Limit states and responses as expressions over variables and **pure query results** (`mass_properties`, `measure_*`, 05 `compute_margins` on current results treated as fixed, analytic checks). Seeded MC and LHS with statistics, quantiles, Pf with Wilson / binomial interval. FORM (HL-RF) with design point, α, sensitivities of β to means and standard deviations; SORM (Breitung). Sobol first-order and total indices (Saltelli 2010 / Jansen) with bootstrap CI. Local parameter sensitivities by central differences through the feature history. `check_probabilistic`. Tolerance factor k(n) for basis interpretation. |
| **V1** | FE responses: `run_reliability_study` transport that re-runs 05 mesh + solve per sample (capped) or fits a response surface (quadratic / Kriging) on a design of experiments; Nataf transformation for correlated non-normal variables; importance sampling around the FORM design point; Morris screening; sensitivities used by PHY-17 shape optimisation. |
| **V2** | Subset simulation for very small Pf; system reliability (series / parallel limit states); random fields (thickness maps); polynomial chaos surrogates. |
| **Out of scope** | Computing A/B-basis allowables from raw test data (08 MAT V3, CMH-17 / MMPDS procedures). Certification credit for probabilistic arguments (human decision). Bayesian calibration. |

## 5. Functional requirements

| Id | Pri | Requirement | Rationale | Source |
| -- | --- | ----------- | --------- | ------ |
| FR-PRB-01 | MUST | A **probabilistic model** in the document holds random variables (name, distribution with parameters and units, binding: `parameter` / `materialProperty` / `loadScale` / `free`, source of the scatter), a correlation matrix, responses and limit states, all set by commands and replayed. | L1/L4/L8; traceable to the revision | — |
| FR-PRB-01a | MUST | **Material scatter comes from PHY-01**: a `materialProperty` binding names the 08 record and a PHY-01 `PropertyModel` id; its distribution is derived from `PropertyModel.uncertainty` (`statistical` with `coverage` → normal sd = half-band / Φ⁻¹((1 + coverage)/2); `measurement` only with an explicit caller coverage, named; `fitErrorVsData` is **refused** as a distribution, `PRB_SCATTER_KIND_UNSUITABLE`, mirroring PHY-01 `PROP_UNCERTAINTY_KIND`). A caller-supplied distribution for a material property is allowed but marked `scatterSource: 'caller'` and needs a citation, else `PRB_SCATTER_UNSOURCED`. PRB defines no material data of its own (README §6.2). | One owner of material data; PHY-01 OQ-PROP-10 defers propagation to PHY-18 | PHY-01 TECHNICAL_SPEC §3, §5.5 |
| FR-PRB-02 | MUST | `propagate_uncertainty` runs **seeded Monte Carlo** or **LHS** (N, seed) over the variables and returns per response: mean, sd, min, max, quantiles (named list), histogram bins, and for each limit state Pf with a confidence interval; deterministic for (seed, N, method, model). | Reproducible statistics (AF-13) | [R4], 03 GDT |
| FR-PRB-03 | MUST | Moments of a response must match closed forms where they exist within statistical acceptance bounds (mean ± 5 sd/√N, sd ± 5 sd/√(2N), p ± max(5√(p(1−p)/N), 1e-5)), as 03 GDT does. | Self-verification | 03 GDT §5.7 |
| FR-PRB-04 | MUST | `run_reliability_study`: HL-RF iteration in standard normal space (independent marginals by Rosenblatt; correlated normals by Cholesky), returns β, Pf_FORM = Φ(−β), design point in u and x space with units, importance factors α² (sum 1), iterations, convergence flag; exact on linear limit states in normal variables. | Classical reliability method | [R1], [R2] |
| FR-PRB-05 | MUST | Probabilities are computed with a double-precision Φ (relative error < 1e-12 in the tested range); β ↔ Pf conversions are exposed in `data`. | Small probabilities | 03 GDT §5.7 (same rule) |
| FR-PRB-06 | MUST | FORM reports the **design point** (most probable failure point) and **importance factors** so the owner learns which variable drives failure. | Explanation (AF-35) | [R1] |
| FR-PRB-07 | SHOULD | **SORM** (Breitung): principal curvatures at the design point by finite differences, Pf_SORM = Φ(−β) Π(1 + β κ_i)^(−1/2), refused when 1 + β κ_i ≤ 0. | FORM error on curved limit states | [R3] |
| FR-PRB-08 | MUST | `sensitivity_indices`: Sobol first-order S_i and total S_Ti (Saltelli 2010 / Jansen estimators), bootstrap confidence intervals, sample budget N(d + 2), seed; reproduces the Ishigami closed form within the stated tolerance. | Global sensitivity of non-linear responses | [R5]–[R7] |
| FR-PRB-09 | COULD (V1) | Morris elementary-effects screening for many variables. | Cheap screening | [R5] (SALib lists Morris) |
| FR-PRB-10 | MUST | `parameter_sensitivity`: for named document parameters and a response query (+ JSON pointer), central differences through the feature history (pure `set_parameter` + regeneration in memory), derivatives with units, elasticities (x/y) ∂y/∂x, and a smoothness flag (forward vs backward difference mismatch above a named tolerance). | "What matters" for parametric models | [L1] |
| FR-PRB-11 | MUST (V1) | FE responses through `run_reliability_study` (05 mesh + solve per sample or per DOE point, cached by content hash, capped), with a response-surface option and its fit residual reported. | Margins under scatter | 05 FEA |
| FR-PRB-12 | SHOULD | `basis_tolerance_factor` returns the one-sided normal tolerance factor k(n, coverage, confidence) (B: 90 %/95 %, A: 99 %/95 %) and explains a record's basis; it never computes an allowable from raw data. | Link to basis A/B | [R8] |
| FR-PRB-13 | MUST | **Determinism**: same model, seed, N and method ⇒ bit-identical results; PRNG named (`xoshiro128**`, 03 GDT `lib/prng.ts`). | AF-13 | 03 GDT |
| FR-PRB-14 | MUST | **Named defaults** (AF-31): N, seed (no default seed: required, or `seed` defaulted to 1 with `defaulted: true`), quantile list, FD step, FORM tolerance, bootstrap resamples, each `{ value, source, defaulted }`. **No default target** Pf or β: unset ⇒ `PRB_TARGET_UNSET` warning. | No silent safety value | AF-31 |
| FR-PRB-15 | MUST | **Unverified propagation**: a variable whose distribution or binding comes from an 08 `unverified` value, or whose scatter has no source, marks every result `unverified` with reasons; `check_probabilistic` warns `PRB_INPUT_UNVERIFIED` / `PRB_SCATTER_UNSOURCED`. | AF-32 | AGENT_FIRST |
| FR-PRB-16 | MUST | **Review and human gate**: every Pf / β result carries `reviewRequired: true` with reason; `accept_reliability_result` (signature) is the only way to mark a result accepted for a safety argument; agents get `PRB_HUMAN_GATE`. | AF-33, AF-34 | AGENT_FIRST |
| FR-PRB-17 | MUST | Stable error codes (TECHNICAL_SPEC §7.1) with ids/paths and remediation; invalid distributions and non-positive-definite correlation are refused. | AF-11 | AGENT_FIRST |
| FR-PRB-18 | MUST | `check_probabilistic` (AF-20): model completeness, unverified/unsourced scatter, MC convergence (CoV of the Pf estimator above a named limit 0.1), FORM convergence, FORM vs MC disagreement, SORM/FORM ratio, Sobol CI width, stale results. | The agent ends every job with it | AF-20 |
| FR-PRB-19 | MUST | **Staleness**: results store the model hash and the document input hash; any change marks them stale. | Traceability | 05 FR-FEA-22 |
| FR-PRB-20 | SHOULD | Plain-language summary (AF-36) and numeric histogram bins for plotting (AF-21); `render_view` not needed. | Owner communication | AF-21, AF-36 |

## 6. Workflows

### 6.1 CLI

```bash
llull search probability sensitivity reliability
llull describe define_random_variable propagate_uncertainty run_reliability_study sensitivity_indices parameter_sensitivity

# 1. model in a plan (variables bound to parameters; responses are registry queries)
llull run plans/prb_box_mass.plan.json --validate --doc box.llull.json
llull run plans/prb_box_mass.plan.json --doc box.llull.json --kernel occt --json

# 2. statistics, sensitivities, reliability (queries; deterministic per seed)
llull propagate_uncertainty method=lhs samples=10000 seed=7 --doc box.llull.json --json
llull parameter_sensitivity parameters='["w","h","d"]' response=mass --doc box.llull.json --json
llull sensitivity_indices response=mass samples=4096 seed=7 --doc box.llull.json --json
llull run_reliability_study limitState=mass_budget --doc box.llull.json --json
llull check_probabilistic --doc box.llull.json --json          # ends the job (AF-20)
```

### 6.2 MCP

Same registry queries (toolset `analysis`). FE-response studies (`run_reliability_study`, V1) only where 05 transports
are configured.

### 6.3 Desktop UI (review)

Variables table (distribution, binding, source, unverified badge), correlation matrix, histogram and CDF from
`data.histogram`, tornado chart from `parameter_sensitivity`, Sobol bars with CI, FORM design point table; acceptance
dialog (human gate).

### 6.4 Surface matrix

| Capability | CLI | MCP | UI | Notes |
| ---------- | --- | --- | -- | ----- |
| Model set-up | plan / commands | registry | tables | pure |
| MC / LHS / FORM / SORM / Sobol / local | `--json` queries | same | plots | read-only, deterministic |
| FE responses (V1) | `run_reliability_study` | where configured | progress | transport |
| Acceptance for a safety argument | prepare (`PRB_HUMAN_GATE`) | prepare | **complete** | signature |

### 6.5 Error and edge behaviour

| Situation | Behaviour | FR |
| --------- | --------- | -- |
| sd ≤ 0, lognormal mean ≤ 0, Weibull shape ≤ 0, a > b uniform | `PRB_DISTRIBUTION_INVALID`, path | FR-PRB-17 |
| Correlation not symmetric / not positive definite | `PRB_CORRELATION_INVALID` | FR-PRB-17 |
| Response query fails for a sample (kernel refusal, invalid geometry) | Sample recorded as failed; above 1 % failed samples → `PRB_RESPONSE_FAILED`; failures never silently dropped from Pf | FR-PRB-02 |
| Pf = 0 in N samples | Report the upper bound 3/N (rule of three, named) and `PRB_PF_BELOW_RESOLUTION` | FR-PRB-02 |
| FORM gradient zero / no convergence | `PRB_FORM_NOT_CONVERGED` with the last iterate | FR-PRB-04 |
| Sample cap exceeded (regenerating responses) | `PRB_BUDGET_EXCEEDED`; suggests LHS or a surrogate | FR-PRB-02 |

### 6.6 Glossary

| Term | Meaning |
| ---- | ------- |
| Limit state g | Function of the variables; g < 0 is failure |
| Pf | Probability of failure P(g < 0) |
| β (reliability index) | Distance from the origin to the limit state in standard normal space (Hasofer–Lind) [R1] |
| Design point | Most probable failure point on g = 0 |
| Importance factor α² | Share of the variance of the linearised g due to each variable |
| FORM / SORM | First- / second-order reliability method [R1][R3] |
| LHS | Latin hypercube sampling: one sample per equal-probability stratum per variable [R4] |
| Sobol index | Share of output variance due to a variable alone (S_i) or including interactions (S_Ti) [R6] |
| Elasticity | (x/y) ∂y/∂x, dimensionless local sensitivity |
| Tolerance factor k | Multiplier in mean − k·s for a one-sided tolerance bound; A/B basis [R8] |

## 7. Acceptance criteria

Values: `validation/expected_results.json`. `D` = `--doc case.llull.json --json`.

| # | Given | When (CLI) | Then (JSON) | VC |
| - | ----- | ---------- | ----------- | -- |
| AC-1 | R ~ N(300, 30), S ~ N(200, 40) MPa, g = R − S | `llull run_reliability_study limitState=g D` | β = 2.0, Pf = 0.0227501319482 (rel 1e-9), α² = [0.36, 0.64] | VC-PRB-01 |
| AC-2 | same, `propagate_uncertainty method=mc samples=200000 seed=…` | — | Pf within ±1.67e-3 of 0.0227501319482 | VC-PRB-01.d |
| AC-3 | lognormal R, S (same means / sd) | `run_reliability_study` | β = 1.89451599469 (rel 1e-6) | VC-PRB-02 |
| AC-4 | OpenTURNS stressed beam model | `run_reliability_study`, `propagate_uncertainty` (MC 1e6) | β_FORM = 1.88104651853; MC Pf within 5σ of the exact 0.0291981946248 | VC-PRB-03 |
| AC-5 | g = 3 − u1 + 0.1 u2² | `run_reliability_study sorm=true` | β = 3; Pf_SORM = 0.00106718809723 (rel 1e-6); exact 0.00104359875879 reported for reference | VC-PRB-04 |
| AC-6 | Ishigami, N = 8192 | `sensitivity_indices` | S1 0.3139, S2 0.4424, S3 0, ST1 0.5576, ST2 0.4424, ST3 0.2437 within ±0.03 | VC-PRB-05 |
| AC-7 | `plans/prb_box_mass.plan.json` | `parameter_sensitivity parameters=["w","h","d"] response=mass` | ∂m/∂w = 0.54, ∂m/∂h = 1.08, ∂m/∂d = 2.16 g/mm (rel 1e-6); elasticities 1 | VC-PRB-06 |
| AC-8 | same with normal w, h, d | `propagate_uncertainty method=lhs samples=10000` | mean 21.6 g, sd 0.16200135 g within the acceptance bounds | VC-PRB-06 |
| AC-9 | n = 10 | `basis_tolerance_factor n=10 coverage=0.90` / `0.99` | 2.35464013183 / 3.98111784527 (rel 1e-6) | VC-PRB-08 |
| AC-10 | same model, seed, N twice | `propagate_uncertainty` | bit-identical `data` | VC-PRB-10 |
| AC-11 | variable bound to an 08 `typical` value | any query | `unverified: true`, `PRB_INPUT_UNVERIFIED` | VC-PRB-11 |
| AC-12 | sd = 0; non-PD correlation | `define_random_variable` / `set_correlation` | `PRB_DISTRIBUTION_INVALID` / `PRB_CORRELATION_INVALID`, exit 1 | VC-PRB-12 |
| AC-13 | agent acceptance | `accept_reliability_result` without signature | exit 1, `PRB_HUMAN_GATE` | VC-PRB-15 |
| AC-14 | 08 record with PHY-01 model `E.ref`, uncertainty `{statistical, relative 0.05, coverage 0.95}`, E = 70000 MPa | `define_random_variable name=E binding={kind:materialProperty, material, propertyModelId:"E.ref"}` then `describe_probabilistic_model` | normal, sd = 1785.74709924 MPa (rel 1e-10), `scatterSource: 'propertyModel'`; a `fitErrorVsData` model → `PRB_SCATTER_KIND_UNSUITABLE` | VC-PRB-17 |

## 8. Standards & regulatory alignment

| Reference | Use | Status |
| --------- | --- | ------ |
| MMPDS / CMH-17 basis definitions [R8] | Meaning of A/B basis; tolerance factor | MMPDS overview PDF and CMH-17 text via search extracts; handbooks paid |
| 14 CFR 25.613 (material strength properties) | Same 99 %/90 % with 95 % confidence | Search extract only (quoted on a forum); cite the regulation number only |
| Hasofer & Lind 1974 [R1], Rackwitz & Fiessler 1978 [R2], Breitung 1984 [R3] | Methods | Bibliographic records (ASCE) via search |
| McKay et al. 1979 [R4] | LHS | Citation only |
| Saltelli et al. 2010 [R6] | Estimators | Cited by SALib source (downloaded) |

llull claims no compliance with any reliability standard; probabilistic results are decision aids that need review.

## 9. KPIs / success metrics

| KPI | Target | How measured |
| --- | ------ | ------------ |
| Reference cases | 100 % of A-grade VC-PRB cases pass | `npm run quality:physics` |
| Reproducibility | identical `data` for identical inputs | VC-PRB-10 |
| Unflagged probabilities | 0 Pf/β results without `reviewRequired` | unit tests + production scenario |
| Agent usability | US-1 and US-2 completed unattended in ≥ 9 of 10 runs | production gate (V1) |
| Runtime | 10 000 LHS samples of a pure-expression response < 1 s; of a regenerating parametric response < 5 min (TBD measure) | §8 TECHNICAL_SPEC |

## 10. Risks & assumptions

| Risk / assumption | Impact | Mitigation |
| ----------------- | ------ | ---------- |
| Distributions and CoVs are guessed | Meaningless Pf | Scatter must name its source; unsourced ⇒ unverified warning; reviewer gate |
| FORM misleads on non-linear limit states | Wrong Pf | SORM ratio, MC cross-check, `PRB_FORM_MC_DISAGREE` |
| Small Pf need huge N | Slow or zero estimates | FORM/SORM, importance sampling (V1), rule-of-three upper bound |
| Regenerating the feature history per sample is slow | Long runs | Caps, replay cache (`ctx.replayCache`), surrogates (V1) |
| Owners read Pf as certification | Unsafe claims | `reviewRequired`, summary wording, human gate |

## 11. References

- [R1] A. M. Hasofer, N. C. Lind, "Exact and Invariant Second-Moment Code Format", J. Eng. Mech. Div. ASCE 100(1):111–121, 1974 — https://ascelibrary.com/doi/10.1061/JMCEA3.0001848 (accessed 2026-10; record via search)
- [R2] R. Rackwitz, B. Fiessler, "Structural reliability under combined random load sequences", Computers & Structures 9:489–494, 1978 (accessed 2026-10; citation from general knowledge, not verified — see sources.md)
- [R3] K. Breitung, "Asymptotic Approximations for Multinormal Integrals", J. Eng. Mech. 110(3):357–366, 1984 — https://ascelibrary.com/doi/10.1061/%28ASCE%290733-9399%281984%29110%3A3%28357%29 (accessed 2026-10; record and abstract via search)
- [R4] M. D. McKay, R. J. Beckman, W. J. Conover, "A comparison of three methods for selecting values of input variables in the analysis of output from a computer code", Technometrics 21(2):239–245, 1979 (citation not verified this session)
- [R5] SALib 1.6.0 — MIT — https://github.com/SALib/SALib (commit 748cf169e82227bcc56dcfc961fcfb03a1e0df45, accessed 2026-10; cloned and read)
- [R6] A. Saltelli et al., "Variance based sensitivity analysis of model output. Design and estimator for the total sensitivity index", Comput. Phys. Commun. 181:259–270, 2010 — cited in SALib `test_functions/Sobol_G.py` [R5]
- [R7] OpenTURNS — LGPL-3.0+ — https://github.com/openturns/openturns (commit 829e678d78400544bd0849199caefd3f62cbeadd, `python/src/usecases/ishigami_function.py`, `stressed_beam.py`; accessed 2026-10)
- [R8] MMPDS statistical property analysis overview — Battelle / MMPDS — https://www.mmpds.org/wp-content/uploads/2015/03/mmpds_2015_statistical_property_analysis_overview.pdf (accessed 2026-10; search extract)
- [L1] llull: `packages/core/src/commands/parametric/parameters.ts` (`set_parameter` regenerates dependent steps), `commands/history/regenerate.ts` (`=expr` resolution), 03 GDT TECHNICAL_SPEC §5.7 (seeded MC).
