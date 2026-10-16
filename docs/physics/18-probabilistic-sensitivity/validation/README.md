# PHY-18 PRB: validation pack

This pack proves a future implementation of probabilistic analysis and sensitivity described in `../FUNCTIONAL_SPEC.md`
(`FR-PRB-*`) and `../TECHNICAL_SPEC.md` (`TR-PRB-*`). Expected values are:

- **(b) Derived** by [`generate_prb_reference.py`](generate_prb_reference.py): Python standard library only,
  deterministic, `python3 -I generate_prb_reference.py` (≈ 10 s; run twice on 2026-10-15, byte-identical). Exact
  closed forms, 1D quadrature for exact failure probabilities, an HL-RF FORM implementation, non-central-t tolerance
  factors, and seeded reference runs (Python `random`, as in 03 GDT) that show the acceptance bounds hold.
- **(a) Quoted**: Ishigami Sobol indices also appear in OpenTURNS (formulas) and SALib (first-order values).
- **(c) TBD** with the tool that will measure it.

Grades: **A** = exact derivation in the generator and/or ≥ 2 independent sources; **B** = formula only from a search
extract; **TBD** = not a gate. Tolerances are llull acceptance choices.

## Files

| File | Kind | Content |
| ---- | ---- | ------- |
| `generate_prb_reference.py` | generator | Writes the three files below. |
| `expected_results.json` | (b) + (a) | VC-PRB-01…17 (§6.3 schema). Seeded reference runs are attached as `referenceRun`. |
| `beta_pf_table.csv` | (b) | β = 1…6 → Pf = Φ(−β). |
| `tolerance_factors.csv` | (b) | One-sided normal tolerance factors k(n) at 95 % confidence, 90 % (B-basis form) and 99 % (A-basis form) coverage, n = 5…100 and ∞. |
| `plans/prb_box_mass.plan.json` | draft plan | Parameters w, h, d → `add_box size ["=w","=h","=d"]`, material density 0.0027 g/mm³, then **proposed** `define_response` (mass from `mass_properties`), `define_random_variable` ×3, `define_limit_state` `22 - mass`, `parameter_sensitivity`, `propagate_uncertainty`. Existing commands verified in code. |
| `plans/prb_linear_r_minus_s.plan.json` | draft plan | VC-PRB-01 as free variables + FORM/SORM + MC. |
| `plans/prb_ishigami_sobol.plan.json` | draft plan | Ishigami as a limit-state expression (`pow`, `pi`: the parametric grammar has no `^`) + `sensitivity_indices`. |
| `plans/prb_rejections.plan.json` | draft plan | sd = 0, lognormal mean < 0, non-SPD correlation → VC-PRB-12 codes. |
| `sources.md` | register | Sources, access grade, verification. |

## Real use cases

| # | Use case | Who | Evidence | Cases |
| - | -------- | --- | -------- | ----- |
| U1 | Probability of failure of a component with scattered strength and load | Reliability / stress engineers | FORM/SORM are the classical methods [S1]–[S3]; OpenTURNS ships the axial stressed beam as a use case [S5] | VC-PRB-01…04 |
| U2 | Which input drives the output variance | Analysts, tolerance designers | Sobol indices with Saltelli/Jansen estimators, Ishigami benchmark in SALib and OpenTURNS [S6], [S7] | VC-PRB-05 |
| U3 | Mass / dimension scatter from tolerances on a parametric part | Designers, AI agents | llull feature history + parameters (L1) | VC-PRB-06, 07 |
| U4 | Understand what an A/B-basis value means | Owners, reviewers | MMPDS / CMH-17 basis definitions [S8] | VC-PRB-08 |
| U5 | Material scatter taken from the PHY-01 property model | Analysts | PHY-01 `PropertyModel.uncertainty` band (TECHNICAL_SPEC §5.6) | VC-PRB-17 |

## Validation cases

| VC | Proves | Setup | Expected | Tolerance | Source | Grade | Gate |
| -- | ------ | ----- | -------- | --------- | ------ | ----- | ---- |
| VC-PRB-01 | FR-PRB-02…06 | R ~ N(300, 30), S ~ N(200, 40) MPa, g = R − S (`plans/prb_linear_r_minus_s.plan.json`) | β = 2; Pf = 0.0227501319482; α² = [0.36, 0.64]; MC (N = 200 000) within ±1.66705e-3 of exact (reference run: 0.022835) | 1e-9 rel; 1e-6 abs; 5σ binomial | (b) [S1, S2] | A | unit |
| VC-PRB-02 | FR-PRB-04 | lognormal R, S with the same moments | exact β = 1.89451599469; FORM on g = R − S converges to the same value (8 HL-RF iterations in the generator) | 1e-9 / 1e-6 rel | (b) | A | unit |
| VC-PRB-03 | FR-PRB-02, 04, 05, 06 | OpenTURNS axial stressed beam: R ~ LN(3e6, 3e5) Pa, F ~ N(750, 50) N, g = R − F/(π/1e4) | exact Pf = 0.0291981946248; β_FORM = 1.88104651853; Pf_FORM = 0.0299827955769; design point (2 546 286.83 Pa, 799.940 N) | 1e-6 rel (1e-5 design point) | (b) on the [S5] model | A | unit |
| VC-PRB-04 | FR-PRB-04, 07 | g = 3 − u1 + 0.1 u2² in standard space | β = 3; exact Pf = 1.04359875879e-3; Breitung Pf = 1.06718809723e-3 (ratio to exact 1.0226) | 1e-9; 1e-8; 1e-6 rel | (b) [S3] | A, A, B | unit |
| VC-PRB-05 | FR-PRB-08; TR-PRB-07 | Ishigami a = 7, b = 0.1, X ~ U(−π, π), N = 8192 | mean 3.5, variance 13.8445879407; S1 0.313905191148, S2 0.44241114479, S3 0, ST1 0.55758885521, ST2 0.44241114479, ST3 0.243683664062 (SALib quotes 0.3139 / 0.4424 / 0.0) | exact for the closed form; ±0.03 for the estimators | (b) + S6 + S7 | A | unit |
| VC-PRB-06 | FR-PRB-02, 03, 10; TR-PRB-09 | `plans/prb_box_mass.plan.json` | m = 21.6 g; ∂m/∂(w, h, d) = 0.54, 1.08, 2.16 g/mm; elasticities 1; with N(40, 0.1), N(20, 0.1), N(10, 0.05): E[m] = 21.6 g, sd = 0.16200135 g | 1e-12; 1e-6; 1e-6; MC bounds | (b) | A | unit + golden |
| VC-PRB-07 | FR-PRB-02; TR-PRB-04 | centred LHS, n = 10, two U(0,1) variables | one point per stratum per variable; marginal means exactly 0.5 | 1e-15 | (b) | A | unit |
| VC-PRB-08 | FR-PRB-12 | `basis_tolerance_factor` n = 10 | k(90 %, 95 %) = 2.35464013183; k(99 %, 95 %) = 3.98111784527; limits z = 1.28155156554, 2.32634787404 | 1e-6 / 1e-10 rel | (b) [S8 definitions] | A | unit |
| VC-PRB-09 | FR-PRB-05 | conversions | Φ(−3) = 1.34989803163e-3; β(Pf = 1e-6) = 4.75342430882 | 1e-10 rel | (b) | A | unit |
| VC-PRB-10 | FR-PRB-13 | same model / seed / N twice | bit-identical `data` | exact | — | A | unit |
| VC-PRB-11 | FR-PRB-15 | variable bound to a `typical` 08 / PHY-01 value | `PRB_INPUT_UNVERIFIED`, `unverified: true` | exact | — | A | unit |
| VC-PRB-12 | FR-PRB-17 | `plans/prb_rejections.plan.json` | `PRB_DISTRIBUTION_INVALID` ×2, `PRB_CORRELATION_INVALID` | exact | — | A | unit + CLI |
| VC-PRB-13 | FR-PRB-04 | limit state with zero gradient at u = 0 (g = 1 − u1² − u2², whose gradient vanishes at the start point u = 0) | `PRB_FORM_NOT_CONVERGED` with last iterate | exact | — | A | unit |
| VC-PRB-14 | FR-PRB-14, 16 | any Pf result without target | `PRB_TARGET_UNSET` warning; `reviewRequired: true` | exact | — | A | unit |
| VC-PRB-15 | FR-PRB-16 | agent `accept_reliability_result` without signature | exit 1, `PRB_HUMAN_GATE` | exact | — | A | unit + CLI |
| VC-PRB-16 | FR-PRB-11 | 05 bracket, Pf of min MS with E, load and thickness scatter | **TBD — measure** with `run_reliability_study` (V1) | — | TBD | TBD | integration |
| VC-PRB-17 | FR-PRB-01a; TR-PRB-10 | PHY-01 model with `uncertainty {statistical, relative 0.05, coverage 0.95}`, E = 70 000 MPa; and a `fitErrorVsData` model | sd = 1785.74709924 MPa; `PRB_SCATTER_KIND_UNSUITABLE` | 1e-10 rel; exact | (b) | A | unit |

## Requirement coverage supplement

| Requirement | Proved by |
| ----------- | --------- |
| FR-PRB-01, TR-PRB-01 (model as document data) | **VC-PRB-18**: run `plans/prb_box_mass.plan.json`, save, load, replay → `probabilistic` slice deep-equal; `is pure` per command |
| FR-PRB-09 (Morris, V1) | deferred |
| FR-PRB-18 (check_probabilistic) | VC-PRB-14 (`PRB_TARGET_UNSET`); **VC-PRB-19**: MC N = 1000 on VC-PRB-01 → `PRB_MC_NOT_CONVERGED` (CoV of the Pf estimate ≈ 0.21 > 0.1) |
| FR-PRB-19 (staleness, V1 recorded studies) | with VC-PRB-16 (V1) |
| FR-PRB-20 (summary, histogram) | VC-PRB-06 (`data.responses.mass.histogram` counts sum to N) |
| TR-PRB-02 (distributions) | VC-PRB-02, 03 (lognormal by moments), VC-PRB-05 (uniform), VC-PRB-12 |
| TR-PRB-06 (SORM) | VC-PRB-04 |
| TR-PRB-08 (sample evaluation through the feature history) | VC-PRB-06 |
| TR-PRB-11 (agent-first contract) | VC-PRB-11, 14 |
| TR-PRB-12 (human gate) | VC-PRB-15 |
| TR-PRB-13 (FE transport, V1) | VC-PRB-16 |

## CLI harness (AF-23)

```bash
D="--doc prb.llull.json --kernel occt --json"
llull run plans/prb_linear_r_minus_s.plan.json $D > rs.json        # step data (AF-14): FORM β, Pf; MC Pf
llull run plans/prb_ishigami_sobol.plan.json $D > ish.json
llull run plans/prb_box_mass.plan.json $D > box.json
llull check_probabilistic $D > check.json                          # PRB_TARGET_UNSET expected (no target set)
llull run plans/prb_rejections.plan.json --continue $D             # VC-PRB-12 codes in step errors
llull run_benchmarks packs=18-probabilistic-sensitivity --json     # PHY-00 judge
```

## Re-generating

```bash
cd docs/physics/18-probabilistic-sensitivity/validation
python3 -I generate_prb_reference.py
git diff --stat .           # must be empty unless the generator changed
```
