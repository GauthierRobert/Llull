# PHY-18: Probabilistic analysis & sensitivity — technical specification

Gap id **PRB** · status: specification · written 2026-10-15 · functional spec: [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md)
· validation: [`validation/README.md`](validation/README.md) · sources: [`validation/sources.md`](validation/sources.md)

## 1. Current state in llull

| Area | What exists | Path | Limit for PRB |
| ---- | ----------- | ---- | ------------- |
| Parameters | `CadDocument.parameters: Record<string, Parameter { name, expression, value, error? }>`; `set_parameter` (`metaHistory: true`) re-evaluates parameters and regenerates dependent feature steps whose params hold `=expr` leaves | `packages/core/src/model/types.ts`, `commands/parametric/parameters.ts`, `commands/history/{regenerate,dependents}.ts` | Deterministic; one value per parameter |
| Configurations | `create_configuration` / `activate_configuration` (named sets of parameter expressions) | `commands/parametric/configurations.ts` | Discrete variants, no distributions |
| Replay cache | `ExecutionContext.replayCache` (prefix cache for replay) | `commands/types.ts`, `commands/history/replayCache.ts` | Reused to make repeated regenerations cheap |
| Queries | `mass_properties`, `measure_*`, `measure_bounding_box`, `check_model` return `data` | `commands/inspect/*` | Usable as responses |
| Plans | `build_project` with `=expr`, loops, `$alias` | `commands/project/*` | — |
| 03 GDT (aerospace, built first) | `lib/prng.ts` (xoshiro128** seeded by SplitMix32, Box–Muller), MC acceptance bounds, `analyze_stackup` with forward-mode AD on the expression grammar | `docs/aerospace/03-gdt-mbd-pmi/TECHNICAL_SPEC.md` §5.7 | Stack-ups only |
| 08 MAT / PHY-01 | `PropertyValue.basis` (A, B, S, typical, …); PHY-01 `PropertyModel.uncertainty: PropertyUncertainty { kind: 'fitErrorVsData' \| 'measurement' \| 'statistical', relative?, absolute?, coverage?, provenance }`; PHY-01 OQ-PROP-10 defers propagation to PHY-18 | `docs/aerospace/08-…/TECHNICAL_SPEC.md` §3.1, `docs/physics/01-property-models/TECHNICAL_SPEC.md` §3, §5.5 | Bands, no distributions |
| 05 FEA | `compute_margins` rows, transports, artifact store | 05 TECHNICAL_SPEC | One deterministic solve |

No probabilistic capability exists in `packages/` today (`grep -ri "monte carlo\|reliability\|sobol"` finds none).

## 2. Target architecture

```
server/ (host)       run_reliability_study ✱ (V1: 05 mesh+solve per sample / DOE point, artifact store, cache)
        │ dispatch record_reliability_study (validated)
packages/domain-physics/src (@phys) ── CadPlugin "probabilistic", toolset "analysis"
   probabilistic/commands/: define_random_variable, delete_random_variable, set_correlation, define_response,
      define_limit_state, propagate_uncertainty, run_reliability_study, sensitivity_indices, parameter_sensitivity,
      basis_tolerance_factor, describe_probabilistic_model, check_probabilistic, accept_reliability_result (human gate)
   probabilistic/evaluate.ts   sample → document overrides → response values (pure, uses execute + ctx.replayCache)
        ▼ public core API (L10)
packages/core/src/lib/
   prng.ts           (03 GDT) xoshiro128**, normal by Box–Muller
   distributions.ts  pdf / cdf / inverse cdf: normal, lognormal, uniform, truncated normal, Weibull, Gumbel   [pure]
   normalCdf.ts      Φ via erfc (rel. error < 1e-12), Φ⁻¹                                                 [pure]
   reliability.ts    HL-RF FORM, Breitung SORM, Rosenblatt / Cholesky transforms                           [pure]
   sobol.ts          Saltelli 2010 first-order, Jansen total, bootstrap                                     [pure]
   lhs.ts            Latin hypercube (random and centred)                                                   [pure]
   toleranceFactor.ts non-central-t one-sided tolerance factor                                              [pure]
```

**Laws respected**

- **L1/L5.** Set-up is mutating commands; every analysis is a query (pure, same document back). A sample is evaluated
  by running registry commands (`set_parameter`, response query) through `execute` on an in-memory copy, so the same
  code paths as UI/MCP/CLI are used and nothing is special-cased.
- **L2.** All numerics are pure `@lib` modules; no DOM, no network; FE-backed studies are a host transport (V1).
- **L3.** Queries return the input document reference; samples never leak into the document.
- **L4.** The probabilistic model is document data (`CadDocument.probabilistic?`, plugin slice); results are not stored
  (queries are re-run; deterministic per seed). Only V1 FE studies record a validated summary.
- **L8.** Set-up commands record feature steps; random-variable bindings reference parameter names and PHY-01 model
  ids, re-resolved on replay.
- **L9.** Kernel only indirectly, through responses that need it (`mass_properties` on kernel shapes); such samples
  run with `ctx.kernel` and `requiresKernel` propagates (`PRB_KERNEL_REQUIRED`).
- **L10.** Plugin `probabilistic` in `packages/domain-physics`; core gets pure `lib` helpers only (README §5.1 proposal).
  `@phys` never imports 05's `@cae` (`.dependency-cruiser.cjs` rule `plugins-and-kernels-depend-on-core-only`): 05 margins
  and load cases are reached only as registry commands through `execute` and as core types (`model/analysis.ts`); the
  fallback placement (inside the 05 FEA package) follows PHY-03 TECHNICAL_SPEC §2.1.

**Requirements (technical)**

| Id | Pri | Requirement |
| -- | --- | ----------- |
| TR-PRB-01 | MUST | Plugin slice `probabilistic?: ProbabilisticModel` (§3), validated by the plugin `validate`; ids `rv-<step>.<k>`, `ls-…`, `rs-…`. Rides the aerospace v3 envelope as a plugin slice (no own migration). |
| TR-PRB-02 | MUST | `lib/distributions.ts`: each distribution exposes `cdf`, `invCdf`, `mean`, `sd`, parameter validation; lognormal by mean/sd (λ = ln μ − ζ²/2, ζ² = ln(1 + (σ/μ)²)); truncated normal by inverse-CDF on the truncated range; Weibull (k, λ); Gumbel (μ, β). |
| TR-PRB-03 | MUST | Monte Carlo: `lib/prng.ts` stream, u ∈ (0,1) as in 03 GDT; inverse-CDF sampling per variable (so MC, LHS and FORM share one transform); correlated normals by Cholesky of the correlation matrix (refuse if not SPD). Pf estimator with binomial standard error and Wilson 95 % interval; zero failures ⇒ rule-of-three upper bound 3/N (named). |
| TR-PRB-04 | MUST | LHS: per variable a random permutation of strata (prng) and a uniform offset within the stratum (`random`) or the midpoint (`centred`); exactly one point per stratum per variable (unit-tested). |
| TR-PRB-05 | MUST | FORM: HL-RF in standard normal space u, x = T(u) by Rosenblatt (independent: x_i = F_i⁻¹(Φ(u_i))) or Cholesky (correlated normals); gradients by central differences in u (step 1e-6, named) or exact for expression-only limit states via 03's dual-number AD; stop when ‖Δu‖∞ < 1e-10 (named) and \|g(u)\| < 1e-8·\|g(0)\|; max 100 iterations; Armijo-damped step when g increases (improved HL-RF). |
| TR-PRB-06 | SHOULD | SORM (Breitung): Hessian of g in u by central differences at u*, rotated so the last axis is α, curvatures κ_i = eigenvalues of the (n−1)×(n−1) block divided by ‖∇g‖; Pf = Φ(−β) Π(1 + βκ_i)^(−1/2); refuse if any 1 + βκ_i ≤ 0 (`PRB_SORM_INVALID`). Sign convention: positive κ when the failure surface curves away from the origin (VC-PRB-04). |
| TR-PRB-07 | MUST | Sobol: matrices A, B (N × d) from prng or LHS; A_B^(i); first order S_i = (1/N) Σ f(B)(f(A_B^i) − f(A)) / V (Saltelli 2010), total S_Ti = (1/(2N)) Σ (f(A) − f(A_B^i))² / V (Jansen); V from the 2N base runs; bootstrap (R = 200 named) percentile 95 % CI; cost N(d + 2) evaluations. |
| TR-PRB-08 | MUST | Sample evaluation (`probabilistic/evaluate.ts`): for each sample, overrides = { parameter name → value } and { material property → value } and { load scale → value }; apply by `execute(doc, 'set_parameter', …)` per changed parameter (regeneration through the feature history, using `ctx.replayCache`) and by an in-memory material/analysis override for the others; then run each response query and read its JSON pointer; failures recorded per sample (never dropped). |
| TR-PRB-09 | MUST | `parameter_sensitivity`: central differences with relative step h = 1e-3 (named; absolute step `1e-3` when the value is 0), forward and backward differences also computed; smoothness flag when \|D+ − D−\| > 1e-2·\|Dc\| + 1e-12 (named). Elasticity = (x/y)·Dc. |
| TR-PRB-10 | MUST | Material binding (FR-PRB-01a): resolve the 08 record's PHY-01 `PropertyModel` by id, evaluate it at the study condition (temperature etc., PHY-01 evaluation with range guard), derive the distribution from `uncertainty` (§5.6), carry `provenance` and the PHY-01 `unverified` flag. |
| TR-PRB-11 | MUST | Agent-first contract: units on every value, `settings` named defaults, `provenance` (method, formulas, seed, PRNG, N), `unverified` OR-ed over variables, `reviewRequired: true` on every Pf/β, codes §7.1. |
| TR-PRB-12 | MUST | `accept_reliability_result` verifies a human-held signature through the 09 signing port; records the model hash and result hash. |
| TR-PRB-13 | SHOULD (V1) | `run_reliability_study` transport: DOE (LHS) of FE solves through 05 transports, optional quadratic response surface with leave-one-out residual reported, then FORM / MC on the surface; artifacts content-addressed. |

## 3. Data model

```ts
// packages/domain-physics/src/probabilistic/types.ts (plugin slice; README §6.2)
export interface NamedValue { readonly value: number; readonly source: string; readonly defaulted: boolean }
export type Distribution =
  | { readonly kind: 'normal'; readonly mean: number; readonly sd: number }
  | { readonly kind: 'lognormal'; readonly mean: number; readonly sd: number }                 // by moments
  | { readonly kind: 'uniform'; readonly min: number; readonly max: number }
  | { readonly kind: 'truncated_normal'; readonly mean: number; readonly sd: number; readonly min: number; readonly max: number }
  | { readonly kind: 'weibull'; readonly shape: number; readonly scale: number }
  | { readonly kind: 'gumbel'; readonly location: number; readonly scale: number };
export type VariableBinding =
  | { readonly kind: 'parameter'; readonly parameter: string }                                  // CadDocument.parameters key
  | { readonly kind: 'materialProperty'; readonly material: string; readonly propertyModelId: string;   // 08 record + PHY-01 model
      readonly at?: Record<string, { readonly value: number; readonly unit: string }>;            // evaluation condition (e.g. T)
      readonly measurementCoverage?: number }                                                    // required for kind 'measurement'
  | { readonly kind: 'loadScale'; readonly analysisId: string; readonly loadId: string }         // 05 load multiplier (V1)
  | { readonly kind: 'free' };                                                                   // symbol for expressions only
export interface RandomVariable {
  readonly id: string; readonly name: string;              // name used in expressions
  readonly unit: string;
  readonly distribution?: Distribution;                    // absent for materialProperty bindings derived from uncertainty
  readonly binding: VariableBinding;
  readonly scatterSource: 'propertyModel' | 'caller';
  readonly citation?: { readonly text: string; readonly url?: string; readonly locator?: string };   // required when caller-sourced
}
export interface Response {
  readonly id: string; readonly name: string; readonly unit: string;
  readonly query: { readonly command: string; readonly params: Record<string, unknown>; readonly pointer: string };  // read-only registry command
}
export interface LimitState {
  readonly id: string; readonly name: string;
  readonly expression: string;                              // parametric/expression grammar over variable and response names; g < 0 = failure
  readonly unit: string;
  readonly targetBeta?: NamedValue; readonly targetPf?: NamedValue;   // no default (FR-PRB-14)
}
export interface ProbabilisticModel {
  variables: Record<string, RandomVariable>; variableOrder: string[];
  correlation?: { readonly names: readonly string[]; readonly matrix: readonly (readonly number[])[] };
  responses: Record<string, Response>; limitStates: Record<string, LimitState>;
  acceptances: Record<string, { readonly resultHash: string; readonly modelHash: string; readonly signer: string; readonly signedAt: string; readonly justification: string }>;
}

// query data shapes (all values carry units)
export interface PropagationData {
  readonly method: 'mc' | 'lhs' | 'lhs_centred'; readonly samples: number; readonly seed: NamedValue; readonly prng: 'xoshiro128**';
  readonly responses: Record<string, { unit: string; mean: number; sd: number; min: number; max: number;
    quantiles: Record<string, number>; histogram: { edges: number[]; counts: number[] }; failedSamples: number }>;
  readonly limitStates: Record<string, { pf: number; standardError: number; wilson95: [number, number]; betaEquivalent: number;
    belowResolution: boolean }>;
  readonly provenance: { readonly formulas: string[]; readonly modelHash: string; readonly inputHash: string };
  readonly unverified: boolean; readonly unverifiedReasons: readonly string[]; readonly reviewRequired: boolean;
}
export interface FormData {
  readonly beta: number; readonly pfForm: number; readonly pfSorm?: number; readonly curvatures?: number[];
  readonly designPointU: number[]; readonly designPointX: Record<string, { value: number; unit: string }>;
  readonly importance: Record<string, number>;              // alpha_i^2, sums to 1
  readonly iterations: number; readonly converged: boolean; readonly gradient: 'ad' | 'central_difference';
}
```

## 4. Commands

Plugin `probabilistic`, toolset `analysis`. All analysis commands are `readOnly` queries.

| Name | Kind | Params sketch | Tags |
| ---- | ---- | ------------- | ---- |
| `define_random_variable` | mutating | `{ name, unit, distribution?, binding, citation? }` | @affects `probabilistic.variables` · @invariant parameter exists / PHY-01 model exists; distribution parameters valid · @failure `PRB_DISTRIBUTION_INVALID`, `PRB_BINDING_UNRESOLVED`, `PRB_SCATTER_KIND_UNSUITABLE` → no-op |
| `delete_random_variable` | mutating | `{ name }` | @failure unknown → no-op |
| `set_correlation` | mutating | `{ names: string[], matrix: number[][] }` | @invariant symmetric, unit diagonal, SPD (Cholesky) · @failure `PRB_CORRELATION_INVALID` |
| `define_response` | mutating | `{ name, unit, query: { command, params, pointer } }` | @invariant command is registered and `readOnly` · @failure `PRB_RESPONSE_NOT_QUERY` |
| `define_limit_state` | mutating | `{ name, expression, unit, targetBeta?, targetPf? }` | @invariant expression parses (03/parametric grammar), every symbol is a variable or response · @failure `PRB_EXPRESSION_INVALID` |
| `describe_probabilistic_model` | query | `{}` → variables with resolved distributions (incl. those derived from PHY-01 uncertainty), sources, flags | read-only |
| `propagate_uncertainty` | query | `{ method?: 'mc'\|'lhs'\|'lhs_centred' (default 'lhs'), samples?: integer (default 10 000; cap 2e6 for expression-only, 2e4 when responses regenerate geometry), seed: integer, quantiles?: number[] }` → `PropagationData` | @invariant deterministic for (model, seed, samples, method) · @failure `PRB_BUDGET_EXCEEDED`, `PRB_MODEL_EMPTY` |
| `run_reliability_study` | query | `{ limitState, sorm?: boolean, maxIterations?, tolerance? }` → `FormData` | @failure `PRB_FORM_NOT_CONVERGED` (data has last iterate), `PRB_SORM_INVALID` |
| `sensitivity_indices` | query | `{ response \| limitState, samples: integer (N), seed: integer, bootstrap?: integer }` → `{ S: Record<name, {value, ci95}>, ST: …, variance, unit, evaluations }` | @failure budget |
| `parameter_sensitivity` | query | `{ parameters: string[], response: string \| { command, params, pointer }, relativeStep? }` → `{ rows: [{ parameter, value, unit, derivative, derivativeUnit, elasticity, forward, backward, smooth }] }` | uses the feature history (TR-PRB-08/09) · @failure unknown parameter, response refused for a perturbed value → `PRB_RESPONSE_FAILED` |
| `basis_tolerance_factor` | query | `{ n: integer ≥ 2, coverage: 0.90\|0.99\|number, confidence?: number (0.95) }` → `{ k, method: 'non-central t', note }` | never computes an allowable from data (08 MAT V3) |
| `check_probabilistic` | query | `{ limitState?, mcPfCovLimit?: number (0.1, named) }` → `{ status, items[{ code, severity, ids[], message, remediation }], reviewRequired }` | AF-20 |
| `accept_reliability_result` | mutating, **human gate** | `{ limitState, resultHash, justification, signature }` | @failure agent caller / invalid signature → `PRB_HUMAN_GATE` |
| ✱ `run_reliability_study` (V1) | transport | `{ limitState, design: 'lhs', points: integer, surrogate?: 'quadratic' \| 'none', timeoutS? }` | 05 transports per point; records a validated summary |

## 5. Kernel / algorithms

### 5.1 Normal functions and conversions

Φ(x) = ½ erfc(−x/√2) (double-precision erfc, relative error < 1e-12 for x ∈ [−37, 8]); Φ⁻¹ by bisection + Newton;
β_equivalent = −Φ⁻¹(Pf). `validation/beta_pf_table.csv` pins β = 1…6.

### 5.2 Monte Carlo and LHS acceptance (as 03 GDT)

mean ± 5 σ/√N, sd ± 5 σ/√(2N), Pf ± max(5√(p(1−p)/N), 1e-5). Wilson interval for reporting. Bit equality only
within llull (same PRNG); cross-implementation tests use the bounds (VC-PRB-01.d, 06.e).

### 5.3 FORM (HL-RF) [R1], [R2]

```
u0 = 0
repeat: x = T(u); g = g(x); ∇g(u) (AD or central differences, step h_u = 1e-6)
        u_new = ((∇g·u − g) / ‖∇g‖²) ∇g          (projection onto the linearised limit state)
        if g(T(u_new)) increases vs previous: halve the step (Armijo, at most 10 halvings)
until ‖u_new − u‖∞ < 1e-10 and |g| < 1e-8 |g(0)|
β = ‖u*‖ (sign: −β if g(0) < 0, origin in failure domain);  α = −∇g/‖∇g‖;  importance α_i²;  Pf = Φ(−β)
```

The origin-in-failure-domain case is handled explicitly (OpenTURNS discussion shows the naive formula is wrong there;
sources.md S10).

### 5.4 SORM (Breitung) [R3]

As TR-PRB-06; VC-PRB-04: g = 3 − u1 + 0.1 u2² gives κ = 0.2, Pf_SORM = Φ(−3)/√1.6 = 1.06718809723e-3 vs exact
1.04359875879e-3 (ratio 1.0226; FORM 1.29 × exact).

### 5.5 Sobol estimators [R6]

TR-PRB-07. Bias / variance: N = 8192 base samples gives |error| ≤ 0.03 on Ishigami in the generator's reference run
(largest deviation 0.0144 on S1); tolerance 0.03 is a llull choice, CI reported.

### 5.6 Material scatter from PHY-01 `PropertyModel.uncertainty` (TR-PRB-10)

| `uncertainty.kind` | Distribution derived | Rule |
| ------------------ | -------------------- | ---- |
| `statistical` with `coverage` c | normal(mean = y, sd = h / Φ⁻¹((1 + c)/2)) | h = relative·y or absolute value (PHY-01 band half-width); y = model value at the study condition |
| `statistical` without `coverage` | refused | `PRB_SCATTER_KIND_UNSUITABLE` (remediation: add coverage in PHY-01 or supply a cited distribution) |
| `measurement` | as statistical, only if the binding gives `measurementCoverage` (named, `defaulted: false`) | otherwise refused |
| `fitErrorVsData` | refused | fit quality is not population scatter (PHY-01 `PROP_UNCERTAINTY_KIND`) |
| none | refused unless caller distribution + citation | `PRB_SCATTER_UNSOURCED` warning if citation missing |

Lognormal is offered instead of normal on request (`distributionShape: 'lognormal'`, same mean and sd) for strictly
positive properties. A-/B-basis values are **not** turned into means by llull: `basis_tolerance_factor` only explains
k(n); converting a basis value into a distribution needs n and the sample sd from the source and is a reviewer
decision (open question 2).

### 5.7 Tolerance factor

k = t'_{conf}(n − 1, z_p √n) / √n with z_p = Φ⁻¹(coverage); non-central t CDF by integration over the scaled chi
density (Simpson, 8000 panels) and bisection; `validation/tolerance_factors.csv` for n = 5…100 and ∞.

### 5.8 Named defaults (AF-31)

| Default | Value | Source |
| ------- | ----- | ------ |
| samples | 10 000 | llull choice |
| method | `lhs` | llull choice (variance reduction [R4]) |
| seed | none (required) | AF-13 |
| quantiles | 0.001, 0.01, 0.05, 0.5, 0.95, 0.99, 0.999 | llull choice |
| FD step (u space) | 1e-6 | llull choice |
| FORM tolerance | 1e-10 (u), 1e-8 relative (g) | llull choice |
| relative step `parameter_sensitivity` | 1e-3 | llull choice |
| smoothness tolerance | 1e-2 | llull choice |
| bootstrap resamples | 200 | llull choice |
| MC Pf CoV limit for `check_probabilistic` | 0.1 | llull choice |
| zero-failure upper bound | 3/N | rule of three (textbook; to cite, §11) |
| target β / Pf | **none** | owner / company rule; unset ⇒ `PRB_TARGET_UNSET` |

### 5.9 Numerical tolerances

| Item | Value |
| ---- | ----- |
| Closed-form β, Pf | 1e-9 relative |
| FORM vs exact (linear in u) | 1e-6 relative |
| Sobol estimates (N = 8192) | 0.03 absolute |
| Local derivatives (trilinear response) | 1e-6 relative |
| Tolerance factors | 1e-6 relative |

## 6. Interop & persistence

| Item | Format |
| ---- | ------ |
| Model | `probabilistic` plugin slice in the `.llull` document |
| Results | not stored (queries); `--save` writes the full sample table as CSV for review (AF-12) |
| Exchange (V1) | export of the model to an OpenTURNS / UQpy script for an analyst (text, `--save`) |

## 7. CLI / MCP / UI surfaces

- **CLI**: `llull <command> … --json`; `--save samples.csv` on `propagate_uncertainty`. `llull guide` gains a
  probabilistic section: what β and Pf mean, scatter must cite a source, end with `check_probabilistic`.
- **MCP**: toolset `analysis`; all queries available offline; FE transport where configured.
- **UI**: `src/ui/panels/analysis/ProbabilisticPanel.tsx`: variables, correlation, histogram/CDF, tornado, Sobol bars,
  acceptance dialog (human gate). Review only.

### 7.1 Stable error and check codes (AF-11)

| Code | Severity | When | Offending ids / path | Remediation |
| ---- | -------- | ---- | -------------------- | ----------- |
| `PRB_DISTRIBUTION_INVALID` | error | sd ≤ 0, lognormal mean ≤ 0, min ≥ max, shape ≤ 0 | path | fix the parameters |
| `PRB_CORRELATION_INVALID` | error | not symmetric / unit diagonal / SPD | path | correct the matrix |
| `PRB_BINDING_UNRESOLVED` | error | parameter, record or PHY-01 model missing | binding | create it first |
| `PRB_SCATTER_KIND_UNSUITABLE` | error | PHY-01 uncertainty is `fitErrorVsData`, or lacks coverage | model id | add a statistical band with coverage, or a cited distribution |
| `PRB_SCATTER_UNSOURCED` | warning (not suppressible) | caller distribution without citation | variable | add a citation |
| `PRB_INPUT_UNVERIFIED` | warning (not suppressible) | PHY-01 / 08 input `unverified` | variable, reasons | use verified data |
| `PRB_RESPONSE_NOT_QUERY` | error | response command not read-only | response | use a query command |
| `PRB_EXPRESSION_INVALID` | error | limit-state expression does not parse / unknown symbol | path | fix the expression |
| `PRB_MODEL_EMPTY` | error | no variables or no response | — | define them |
| `PRB_BUDGET_EXCEEDED` | error | samples above cap | samples | fewer samples, LHS, or surrogate (V1) |
| `PRB_RESPONSE_FAILED` | warning / error > 1 % | response failed for samples | sample indices | check geometry validity over the range |
| `PRB_KERNEL_REQUIRED` | error | a response needs the kernel and none is installed | response | `--kernel occt` |
| `PRB_PF_BELOW_RESOLUTION` | warning | zero failures | limit state | use FORM/SORM or more samples |
| `PRB_MC_NOT_CONVERGED` | warning | CoV of Pf estimate > limit | limit state | more samples |
| `PRB_FORM_NOT_CONVERGED` | warning | HL-RF stopped without convergence | limit state | check smoothness, use MC |
| `PRB_SORM_INVALID` | warning | 1 + βκ ≤ 0 | limit state | use MC |
| `PRB_FORM_MC_DISAGREE` | warning | FORM Pf outside the MC Wilson interval | limit state | report MC; consider SORM |
| `PRB_NOT_SMOOTH` | warning | forward/backward differences disagree | parameter | smaller step or non-smooth response |
| `PRB_TARGET_UNSET` | warning | no target β/Pf | limit state | ask the owner / company rule |
| `PRB_TARGET_NOT_MET` | fail | β < target or Pf > target | limit state | redesign; human review |
| `PRB_RESULT_STALE` | error | (V1 recorded studies) hash changed | study | re-run |
| `PRB_HUMAN_GATE` | error | acceptance by an agent / no signature | limit state | hand to the qualified reviewer |

### 7.2 Agent-first compliance

| AF | Where |
| -- | ----- |
| AF-01…05 | registry commands, units in params, guide section, `validation/plans/` |
| AF-10/12/13 | unit-bearing `data`; sample tables via `--save`; deterministic per seed |
| AF-11 | §7.1 |
| AF-20/21 | `check_probabilistic`; histogram bins and tornado data |
| AF-23 | VC cases via PHY-00 `run_benchmarks` |
| AF-30/31 | §5.6 scatter rules, §5.8 named defaults |
| AF-32/33/34 | `unverified`, `reviewRequired`, `accept_reliability_result` |
| AF-35/36 | `provenance` (method, formulas, seed, PRNG), owner summary |
| AF-40/41/42 | sample caps and progress (V1 transport), offline, `--dry-run` on set-up |

## 8. Performance & robustness budgets

| Budget | Target |
| ------ | ------ |
| 1e6 MC samples, expression-only limit state, 5 variables | < 2 s (Node) |
| 10 000 LHS samples with a regenerating parametric response (box + fillet) | < 5 min — TBD measure; replay cache required |
| FORM, 10 variables, expression-only | < 50 ms |
| Sobol N = 8192, d = 3, expression-only | < 1 s |

## 9. Test strategy (VC mapping)

| Layer | Tests | VC |
| ----- | ----- | -- |
| Unit core (`tests/unit/lib/{distributions,normalCdf,reliability,sobol,lhs,toleranceFactor}.test.ts`) | closed forms vs generator | 01–05, 07–09, 17 |
| Unit plugin (`tests/unit/physics/probabilistic/*`) | commands happy/failure/`is pure`, determinism, unverified, human gate, PHY-01 binding | 10–15, 17 |
| Golden | `validation/plans/prb_box_mass.plan.json` (parameters + response + variables replay) | 06 |
| Integration | parameter sensitivity through the real feature history (OCC kernel for fillets) | 06 |
| Quality gate | `npm run quality:physics` | all A-grade |
| V1 integration | `run_reliability_study` on the 05 bracket | 16 |

## 10. Delivery plan

| M | Content | Depends on | Effort |
| - | ------- | ---------- | ------ |
| M1 | `@lib` normal/distributions/LHS/FORM/SORM/Sobol/tolerance factor, unit tests (VC 01–05, 07–09) | 03 GDT `lib/prng.ts` | 2 w |
| M2 | Plugin slice, set-up commands, `evaluate.ts`, `propagate_uncertainty`, `parameter_sensitivity`, `sensitivity_indices`, `run_reliability_study`, `check_probabilistic`, human gate (VC 06, 10–15) | M1, 09 signing port | 2.5 w |
| M3 | PHY-01 material binding (VC 17), 05 margin responses on fixed results | PHY-01 M2, 05 M3 | 1 w |
| M4 (V1) | `run_reliability_study`, response surfaces, Nataf, importance sampling, Morris | M2, 05 transports | 3 w |

## 11. Open questions / decisions needed

1. **Package placement** (README §5.1): `domain-physics` plugin `probabilistic` (proposed) vs core (parameters are core
   data; sensitivities could be a core `parametric` feature). The pure `lib` modules are core either way.
2. **Basis values as distributions**: should llull ever derive a mean/sd from an A/B-basis value (needs n and s from
   the source)? Proposal: no automatic conversion; the reviewer supplies a cited distribution.
3. **Rackwitz–Fiessler 1978 and McKay 1979** citations were not verified this session (sources.md).
4. **Rule-of-three** bound and the improved HL-RF damping rule need a cited reference before freezing.
5. **Tolerance-factor tables**: the generator's k(10) = 2.35464 / 3.98112 match commonly quoted table values (2.355 /
   3.981) from memory only; confirm against CMH-17 Vol. 1 tables.
6. **FE responses**: per-sample FE solves (expensive, exact) vs response surfaces (cheap, approximate). Proposal: DOE +
   quadratic surface with residual gate in V1.

## 12. References

- [R1] Hasofer & Lind 1974, J. Eng. Mech. Div. 100(1):111–121 — https://ascelibrary.com/doi/10.1061/JMCEA3.0001848 (record, search)
- [R2] Rackwitz & Fiessler 1978, Computers & Structures 9:489–494 (not verified)
- [R3] Breitung 1984, J. Eng. Mech. 110(3):357–366 — https://ascelibrary.com/doi/10.1061/%28ASCE%290733-9399%281984%29110%3A3%28357%29 (record + abstract, search)
- [R4] McKay, Beckman, Conover 1979, Technometrics 21(2):239–245 (not verified)
- [R5] SALib, MIT — https://github.com/SALib/SALib (commit 748cf169e82227bcc56dcfc961fcfb03a1e0df45)
- [R6] Saltelli et al. 2010, Comput. Phys. Commun. 181:259–270 (cited in [R5])
- [R7] OpenTURNS, LGPL-3.0+ — https://github.com/openturns/openturns (commit 829e678d78400544bd0849199caefd3f62cbeadd)
- [R8] MMPDS statistical overview — https://www.mmpds.org/wp-content/uploads/2015/03/mmpds_2015_statistical_property_analysis_overview.pdf (search)
- PHY-01 `PropertyModel` / `PropertyUncertainty`: `docs/physics/01-property-models/TECHNICAL_SPEC.md` §3, §5.5; 03 GDT §5.7; llull `commands/parametric/parameters.ts`, `commands/history/regenerate.ts`, `commands/types.ts` (`replayCache`).
