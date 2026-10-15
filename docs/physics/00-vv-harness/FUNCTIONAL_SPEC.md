# PHY-00: Physics V&V harness — functional specification

Gap id **VNV** · status: specification · written 2026-10-15 · technical spec: [`TECHNICAL_SPEC.md`](TECHNICAL_SPEC.md)
· validation pack: [`validation/README.md`](validation/README.md) · sources register: [`validation/sources.md`](validation/sources.md)

## 1. Summary

Once the aerospace packs are built, llull can run a linear finite-element analysis (05 FEA) and compare a handful of
its own cases with published values. It still cannot answer the two questions every analysis result must answer
before anyone trusts it:

1. **Is the number converged?** Nothing measures how much a result would change if the mesh (or time step) were
   refined. There is no observed order of convergence, no Richardson extrapolation and no discretization-error
   estimate such as Roache's Grid Convergence Index (GCI) [R1][R2].
2. **Does the solver still reproduce the benchmarks?** Each pack (05 FEA, and every PHY pack after this one) ships an
   `expected_results.json`, but there is no shared runner that executes the cases, converts units, applies the
   tolerances and grades, and reports pass / warn / fail in one place, the way `npm run quality` does for STEP import.

PHY-00 closes both. It adds a read-only `check_convergence` command (pure arithmetic over values the agent or a
transport measured), a `run_convergence_study` transport that re-meshes and re-solves an existing 05 analysis case at
several refinement levels, a `check_verification` readiness check, a pure `compare_to_expected` judge, and a
`run_benchmarks` host transport plus `npm run quality:physics` gate that runs every pack's validation cases through the
CLI. Vocabulary follows ASME V&V 10 (solid mechanics) and V&V 20 (fluids and heat transfer) [R3][R4]: **code
verification** (does the code solve the equations correctly: method of manufactured solutions, benchmarks with exact
answers [R5]), **solution verification** (how large is the discretization error of this particular result: GCI),
and **validation** (does the model match reality: out of scope for MVP, see §4).

This is the analysis equivalent of `npm run quality`. Every later physics pack depends on it (README §3), because the
operator is an AI agent and the owner is not an engineer (AGENT_FIRST §1): llull itself must prove its numbers.

## 2. Aerospace context & value

| Context | Today (who / which tools) | What llull adds | Source |
| ------- | ------------------------- | --------------- | ------ |
| Solution verification in CFD and heat transfer journals | The ASME Journal of Fluids Engineering requires a discretization-error estimate; the published procedure (Celik et al. 2008) uses three grids, an observed order, Richardson extrapolation and GCI with safety factor 1.25. | The same procedure as a query command over any scalar result, with the factor named and sourced. | [R1], [R2], [R6] |
| Grid convergence tutorial | NASA Glenn's NPARC tutorial "Examining Spatial (Grid) Convergence" and its `verify.f90` program are the reference worked example; a Python port (`convergence`, GPL-3.0) reproduces it. | The worked example (p = 1.78617, GCI12 = 0.103 %) becomes a pinned validation case. | [R7], [R8] |
| V&V standards | ASME V&V 10-2019 (R2025) gives the computational solid mechanics vocabulary and process; ASME V&V 20-2009 (R2016) quantifies the comparison of simulation and data at a validation point. Both are paid. | llull uses their vocabulary (code verification, solution verification, validation) and cites only what is public. | [R3], [R4] |
| Code verification | Sandia's method of manufactured solutions (Salari & Knupp 2000) finds any coding error that changes the observed order of accuracy. | An MMS case in the corpus (1D Poisson, P1 elements, order 2 in L2 and 1 in energy), and an `order` check in every solver pack that can use it. | [R5] |
| Vendor solver verification | Commercial FE vendors publish NAFEMS benchmark reproductions; 05 FEA already pins LE1 and LE10. | One runner that executes all packs' cases and grades them, so a solver or mesher upgrade cannot silently change results. | 05 FEA pack |
| Open-source GCI tools | `gcat` (MIT) and `convergence` (GPL-3.0) implement the three-grid procedure; neither is integrated with a CAD document or a solver. | The procedure becomes part of the design loop: a convergence study of a 05 analysis case is one CLI call. | [R8], [R9] |

**Value statements** (sourced only): the GCI procedure is the reporting requirement of a major engineering journal
[R6] and the basis of standard practice in V&V 20 [R4]; it needs only numbers that llull's transports already produce,
so the cost of reporting it is a few extra solves. KPIs in §9 measure adoption, not claimed savings.

## 3. Personas & user stories

Roles follow [`../../aerospace/AGENT_FIRST.md`](../../aerospace/AGENT_FIRST.md) §1.

| Role | Who | Uses | Main need |
| ---- | --- | ---- | --------- |
| **Operator (primary)** | AI agent on the `llull` CLI (cloud agents: MCP) | `llull run_convergence_study`, `llull check_convergence`, `llull check_verification`, `llull run_benchmarks --json` | A deterministic, numeric proof that a result is converged and that the solver reproduces the corpus; stable codes when it is not |
| **Owner** | Person asking for the result; **not assumed to be an engineer** | Natural language | One sentence: "this stress is converged to within 0.4 % (GCI), the solver passes 41 of 41 gated benchmarks" or the honest opposite |
| **Qualified reviewer** | Stress / thermal analyst or design-organisation signatory | Desktop review panel, the benchmark report | Audits the study (levels, order, extrapolation) before a result supports a certification decision; decides whether a non-asymptotic study is acceptable |
| **Maintainer** | llull developer or CI | `npm run quality:physics`, `npm run production:agent` | A gate that fails when any A-grade case regresses |

User stories:

- **US-1 (owner → operator).** "Is the stress at the lug converged?" The agent runs `run_convergence_study` on the
  05 analysis with three levels (ratio 2), reads `data.p`, `data.extrapolated`, `data.gci` and `data.status`, and
  reports "converged within 0.6 % (GCI, safety factor 1.25 per Roache)" or "not converged: oscillatory".
- **US-2 (operator).** A study comes back `oscillatory` or `divergent`. The agent gets `VNV_OSCILLATORY` /
  `VNV_DIVERGENT` with the remediation (refine further, check singularities, use a smoother quantity) and does not
  report an extrapolated value.
- **US-3 (operator).** The observed order is 4.1 where the element's formal order is 2. `check_convergence` warns
  `VNV_ORDER_MISMATCH`; the agent explains that the levels are probably not in the asymptotic range.
- **US-4 (operator).** The agent measured values itself (e.g. from a hand-off solver). It calls `check_convergence`
  with `samples=[{h, value}…]` and gets the same report; no document change.
- **US-5 (maintainer / agent).** After a CalculiX or Gmsh upgrade, `llull run_benchmarks --json` runs every pack's
  cases. All A-grade cases must pass; B-grade drift is reported as `warn`; `TBD` cases are `skip`.
- **US-6 (operator → reviewer).** Before a 05 margin of safety is shown to a reviewer, `check_verification` must not
  report `VNV_NO_CONVERGENCE_STUDY` or `VNV_GCI_ABOVE_TARGET` for the governing result, or the margin row carries the
  warning. The reviewer, not the agent, accepts a study that is not in the asymptotic range.
- **US-7 (operator).** After `set_parameter`, the stored study becomes `stale`; `check_verification` says so.

## 4. Scope / out of scope

| Phase | In scope |
| ----- | -------- |
| **MVP** | `check_convergence` (2 or 3+ samples, constant or variable refinement ratio, observed order, Richardson extrapolation, GCI fine/coarse, asymptotic ratio, classification monotone / oscillatory / divergent / converged-exactly, required spacing for a target GCI). `compare_to_expected` (one case, unit-aware). `run_benchmarks` host transport and `npm run quality:physics` over every `docs/physics/*/validation/expected_results.json` plus 05 FEA. `run_convergence_study` over 05 analysis cases (h-refinement of `globalSize`), recorded via `record_convergence_study`. `check_verification`. MMS 1D case and the GCI worked examples in the corpus. |
| **V1** | Time-step refinement for transient packs (PHY-03, PHY-09) with the same arithmetic. Element-order (p) refinement. Least-squares order fit over 4+ levels. Per-probe and per-field studies (max of a field, integral quantities). Production-gate agent scenario `physics-benchmarks`. Benchmark report as a sheet table. |
| **V2** | Validation against test data in the V&V 20 sense (comparison error E = S − D with validation uncertainty); MMS in 2D/3D through the bundled solver with source terms; error estimators inside the solver (Zienkiewicz-Zhu). |
| **Out of scope** | Writing a solver. Certification credit for the toolchain (tool qualification is a customer process). Statistical validation metrics beyond V&V 20 (area metric, Bayesian calibration): later, with PHY-18. |

## 5. Functional requirements

| Id | Pri | Requirement | Rationale | Source |
| -- | --- | ----------- | --------- | ------ |
| FR-VNV-01 | MUST | `check_convergence` computes the **observed order** p from three samples (h_i, f_i): closed form for a constant refinement ratio, fixed-point iteration with the sign term s for unequal ratios. | The procedure of [R2] as implemented in [R8][R9] | [R2], [R7]–[R9] |
| FR-VNV-02 | MUST | It returns the **Richardson-extrapolated** value, the approximate and extrapolated relative errors, **GCI21 fine and coarse**, GCI32, and the **asymptotic ratio** r21^p · GCI21 / GCI32, each with its unit (the quantity's unit, or fraction). | Standard GCI report | [R1], [R2], [R7] |
| FR-VNV-03 | MUST | It **classifies** the samples: `monotone`, `oscillatory` (e32/e21 < 0), `divergent` (\|e32/e21\| < 1), `converged_exactly` (a zero difference). Only `monotone` reports p, extrapolation and GCI; the others return a stable code and no extrapolated value. | An extrapolated value from non-monotone data is meaningless | [R2] |
| FR-VNV-04 | MUST | When the caller gives the **formal order** (or it is known from the 05 element type: tet4 / tri3 = 2 for displacement, tet10 = 3, see TECHNICAL_SPEC §5.4), a study with \|p − formal\| > `orderTolerance` (default 0.5, named) warns `VNV_ORDER_MISMATCH`; an asymptotic ratio outside [0.95, 1.05] (named default) warns `VNV_NOT_ASYMPTOTIC`. | Out-of-range order means the levels are not asymptotic | [R2], [R8] |
| FR-VNV-05 | MUST | The corpus includes **code-verification** cases built with the method of manufactured solutions; the harness checks the observed order against the formal order within 0.01. | MMS detects order-reducing coding errors | [R5] |
| FR-VNV-06 | SHOULD | `check_convergence` returns the **required spacing** h* = h1 / (GCI21 / GCI*)^(1/p) for a target `gciTarget`. | Lets the agent plan the next refinement | [R8] (corrected NASA formula) |
| FR-VNV-07 | MUST | `run_convergence_study` re-meshes and re-solves an existing 05 analysis case at N ≥ 3 levels (`globalSize` × ratio^k, default ratio 2, named), extracts the requested quantity (probe value, max of a field, frequency, buckling factor), and records the study through `record_convergence_study`. The case's own mesh controls are not changed. | Solution verification of a real result | [R2], 05 FEA |
| FR-VNV-08 | MUST | Safety factor **Fs = 1.25** for three or more levels and **Fs = 3** for a two-level study with an assumed order, both as named defaults (`{ value, source, defaulted }`). A two-level study is always flagged `VNV_TWO_LEVEL_ONLY`. | AF-31; Roache's recommendation as reported in [R1][R10] | [R1], [R10] |
| FR-VNV-09 | MUST | `check_verification` (AF-20) returns pass / warn / fail with codes per analysis case: no study, stale study, GCI above `gciTarget` (no default target: unset ⇒ `VNV_GCI_TARGET_UNSET` warning), non-monotone, order mismatch, not asymptotic, two-level only, benchmark regressions of the solver in use. | The agent ends every analysis job with it | AF-20 |
| FR-VNV-10 | MUST | `compare_to_expected` judges one measured value against one `expected_results.json` case: converts units with `lib/quantity`, applies `abs` / `rel` tolerance to every numeric leaf (scalars, lists, records; strings and booleans exactly; `value: null` cases judged on their `expected` contract), and maps grade to verdict (A ⇒ pass / fail; B ⇒ pass / warn; C or TBD ⇒ skip). | One shared comparison rule for every pack (README §6.3) | README §6.3 |
| FR-VNV-11 | MUST | `run_benchmarks` (host transport) discovers every `expected_results.json` under `docs/physics/*/validation/` (and the aerospace packs that adopt the schema), runs each case's `harness` recipe (plan + CLI calls + extraction path), and writes a report: per case verdict, measured value with unit, relative error, solver and mesher versions, duration. | Regression gate across packs | AF-23 |
| FR-VNV-12 | MUST | `npm run quality:physics` runs `run_benchmarks` on the desktop toolchain and fails on any A-grade `fail` or `error`. The production gate gains a `physics-benchmarks` scenario for the agent driver (V1). | A release gate, like `npm run quality` | AF-23, `docs/PRODUCTION_GATE.md` |
| FR-VNV-13 | MUST | **Staleness**: a recorded study stores the analysis input hash of each level (05 TR-FEA-06); any change to geometry, material, loads or base mesh controls marks it `stale`, and `check_verification` reports `VNV_STUDY_STALE`. | Results must match the design revision | 05 FR-FEA-22 |
| FR-VNV-14 | MUST | **Unverified and review propagation**: a study over results that carry `unverified` (05 FR-FEA-34) carries it too. Every study carries `reviewRequired: true` when its quantity feeds a margin (05 FR-FEA-32). Accepting a non-asymptotic or non-monotone study for a margin is a **human gate** (`accept_verification_exception`, signature required). | AF-32, AF-33, AF-34 | AGENT_FIRST |
| FR-VNV-15 | MUST | Every result in `data` carries units (quantity unit, `fraction` for relative values) and **provenance**: formulas, inputs, Fs with source, procedure id (`celik2008-gci`), sample list. | AF-10, AF-35 | AGENT_FIRST |
| FR-VNV-16 | MUST | Stable error and check codes (TECHNICAL_SPEC §7.1) with ids / paths and one-line remediation. | AF-11 | AGENT_FIRST |
| FR-VNV-17 | SHOULD | Plain-language summary for the owner: what was studied, whether it converged, by how much, what needs a human. | AF-36 | AGENT_FIRST |
| FR-VNV-18 | SHOULD | `render_view … field=…` can draw each level's result (AF-22); the UI shows a convergence plot (value vs h, extrapolated line) as a review surface built on `data`. | Review aid; numbers first (AF-21) | AF-21, AF-22 |
| FR-VNV-19 | COULD (V1) | Least-squares fit of f = f0 + C h^p over 4+ levels with residual reported. | Noisy studies | [R2] (discussion of more than three grids) |
| FR-VNV-20 | COULD (V2) | V&V 20-style validation comparison E = S − D with a validation uncertainty from numerical (GCI/2 as standard uncertainty), input and data uncertainty. | Validation step | [R4] (formula to confirm against the standard text, §11) |

## 6. Workflows

### 6.1 CLI (`llull`, the operator's primary path)

```bash
llull search convergence benchmark                    # discover (AF-01)
llull describe check_convergence run_convergence_study check_verification compare_to_expected

# A. numbers the agent already has (pure query, no document needed)
llull check_convergence quantity="tip u_y" unit=mm formalOrder=2 \
  'samples=[{"h":1,"value":0.9705},{"h":2,"value":0.96854},{"h":4,"value":0.96178}]' --json

# B. a real 05 analysis case (transports: --progress, --timeout, content-hash cache, AF-40)
llull run bracket.plan.json --doc bracket.llull.json --kernel occt --json          # 05 set-up (analysis id from affected)
llull run_convergence_study analysisId=an-5.1 quantity=probe:tip:u_y levels=3 ratio=2 \
  --doc bracket.llull.json --kernel occt --progress --timeout 1800 --json         # records the study
llull check_verification analysisId=an-5.1 gciTarget=0.01 --doc bracket.llull.json --json

# C. the regression gate (host transport; heavy artefacts with --save, AF-12)
llull run_benchmarks packs=00-vv-harness,05-fea-cae-handoff --save out/bench.json --json
npm run quality:physics
```

`--app` replaces `--doc` to act on the open desktop window. `--dry-run` works for `record_convergence_study` (AF-42).
The agent ends every analysis job with `check_verification` and reports, in this order: what was studied, the
verdict and GCI, every `unverified` input, what needs a human (AF-36).

### 6.2 MCP agent (cloud)

`check_convergence`, `compare_to_expected` and `check_verification` are registry tools (toolset `analysis`) and behave
exactly as on the CLI. `run_convergence_study` exists only where the host has Gmsh and CalculiX (else
`VNV_TOOL_MISSING`, AF-41). `run_benchmarks` is a host/CI transport, not exposed to cloud agents by default.

### 6.3 Desktop UI (review surface only)

1. Verification panel per analysis case: levels table (h, value, input hash, solver version), observed order,
   extrapolated value, GCI, status badge, codes.
2. Convergence plot (value vs h on log axes, extrapolated value line) built from `data`.
3. Benchmark report viewer (per pack, per case verdict).
4. **Exception dialog** (human gate): a qualified reviewer accepts a non-asymptotic or non-monotone study for use in a
   margin, with justification and signature (09 PLM `humanSignatureRequired`). Agents can prepare, never complete.

### 6.4 Surface matrix

| Capability | CLI (primary) | MCP (cloud) | UI (review) | Notes |
| ---------- | ------------- | ----------- | ----------- | ----- |
| Convergence arithmetic | `llull check_convergence --json` | same | — | pure, read-only |
| Convergence study of a 05 case | `llull run_convergence_study` | when host has Gmsh + ccx | progress, plot | transport + validated record command |
| Readiness | `llull check_verification --json` | same | panel | codes §7.1 |
| One-case judge | `llull compare_to_expected --json` | same | — | pure |
| Benchmark corpus | `llull run_benchmarks`, `npm run quality:physics` | host-only | report viewer | CI / desktop |
| Exception acceptance | prepare only (`VNV_HUMAN_GATE`) | prepare only | **complete** (signature) | human gate |

### 6.5 Error and edge behaviour

| Situation | Behaviour | FR |
| --------- | --------- | -- |
| Fewer than 2 samples, duplicate h, h ≤ 0, non-finite value | Rejected with `VNV_SAMPLES_INVALID`, the offending index | FR-VNV-01 |
| Refinement ratio < 1.1 between consecutive levels | Warning `VNV_RATIO_TOO_SMALL` (named default 1.3, Celik 2008 recommends > 1.3; see §11) | FR-VNV-01 |
| Two samples only | Requires `assumedOrder`; Fs = 3; flag `VNV_TWO_LEVEL_ONLY` | FR-VNV-08 |
| Oscillatory or divergent | No extrapolation, code, remediation | FR-VNV-03 |
| Quantity at a singularity (point load, re-entrant corner) | Study typically divergent; remediation names 05 `FEA_POINT_LOAD_SINGULAR` | FR-VNV-03 |
| A level fails to mesh or solve | Study stops, `VNV_LEVEL_FAILED` with the 05 code of that level; finished levels are kept in the artifact cache | FR-VNV-07 |
| Expected value is `TBD` | `skip` with `VNV_EXPECTED_TBD` | FR-VNV-10 |
| Units differ by dimension | `VNV_UNIT_MISMATCH` (no comparison) | FR-VNV-10 |

### 6.6 Glossary

| Term | Meaning |
| ---- | ------- |
| Code verification | Showing the software solves its equations correctly (exact solutions, MMS, observed = formal order) [R3][R5] |
| Solution verification | Estimating the numerical (discretization) error of one specific result [R3] |
| Validation | Comparing the model with physical test data at a validation point [R4] |
| Observed (apparent) order p | Rate at which the error falls with spacing h, measured from the solutions [R2] |
| Richardson extrapolation | Estimate of the h → 0 value from two solutions and p [R7] |
| GCI | Grid Convergence Index: Fs · e_a / (r^p − 1), a banded estimate of relative discretization error [R1] |
| Asymptotic ratio | r^p · GCI21 / GCI32; ≈ 1 when the levels are in the asymptotic range [R7] |
| MMS | Method of manufactured solutions: choose u, derive the source term, check the order [R5] |

## 7. Acceptance criteria

`D` = `--doc case.llull.json --kernel occt --json`. Values and tolerances: `validation/expected_results.json`.

| # | Given | When (CLI) | Then (JSON) | VC |
| - | ----- | ---------- | ----------- | -- |
| AC-1 | NASA tutorial samples h = 1, 2, 4; f = 0.9705, 0.96854, 0.96178 | `llull check_convergence samples=… --json` | `data.p` = 1.78616959217, `data.extrapolated` = 0.971300333333, `data.gci21.fine` = 0.00103082603469, `data.asymptoticRatio` = 0.997980422463 (rel 1e-9); `data.safetyFactor` = `{value: 1.25, source: "Roache 1994; Celik et al. 2008", defaulted: true}` | VC-VNV-01 |
| AC-2 | exact law f = 10 + 0.5 h², h = 0.1 / 0.15 / 0.3 | same | `data.p` = 2, `data.extrapolated` = 10 (abs 1e-9), `data.status` = `monotone` | VC-VNV-02, 03 |
| AC-3 | f = 1.00 / 1.02 / 0.99 | same | exit 0, `data.status` = `oscillatory`, `data.codes` contains `VNV_OSCILLATORY`, no `extrapolated` field | VC-VNV-04 |
| AC-4 | f = 1.00 / 1.10 / 1.15 | same | `data.status` = `divergent`, code `VNV_DIVERGENT` | VC-VNV-05 |
| AC-5 | gcat samples, `formalOrder=2` | same | `data.p` = 4.14324 (rel 1e-5); warning `VNV_ORDER_MISMATCH` | VC-VNV-06 |
| AC-6 | MMS corpus case | `llull run_benchmarks packs=00-vv-harness --json` | VC-VNV-07.a–d pass | VC-VNV-07 |
| AC-7 | `gciTarget=0.1`, GCI21 = 0.4, p = 2, h1 = 4 | `check_convergence` | `data.requiredSpacing` = 2 | VC-VNV-08 |
| AC-8 | runner fixtures RF-01…RF-08 | `llull compare_to_expected …` per fixture | verdicts and codes exactly as `runner_fixtures.json` | VC-VNV-12 |
| AC-9 | 05 beamp plan with `plans/vnv_beamp_convergence.plan.json` | `llull run_convergence_study … levels=3` then `check_verification` | study recorded; extrapolated tip u_y within 2 % of 0.0888411 mm (TBD measurement freezes p and GCI) | VC-VNV-10 |
| AC-10 | the study of AC-9, then `set_parameter L=10` | `check_verification` | `VNV_STUDY_STALE` | VC-VNV-13 |
| AC-11 | agent calls `accept_verification_exception` without signature | — | exit 1, `data.code` = `VNV_HUMAN_GATE`, document unchanged | VC-VNV-14 |
| AC-12 | a study over a result with an `unverified` material | `check_verification` | `unverified: true` and `VNV_INPUT_UNVERIFIED` warning; `reviewRequired: true` | VC-VNV-15 |
| AC-13 | a forged `record_convergence_study` (hash not in the artifact store) | `llull record_convergence_study …` | no-op, `VNV_ARTIFACT_NOT_FOUND` | VC-VNV-16 |

(AC-3 note: a non-monotone classification is a valid query result, not a refusal: exit 0 with the code in `data.codes`.
Refusals with exit 1 are reserved for invalid input, AF-11.)

## 8. Standards & regulatory alignment

| Reference | Use in llull | Status of what is claimed |
| --------- | ------------ | ------------------------- |
| ASME V&V 10-2019 (R2025) [R3] | Vocabulary: code verification, solution verification, validation; high-consequence focus | Catalogue and scope text via search. Clause content not seen (paid). |
| ASME V&V 20-2009 (R2016) [R4] | Validation comparison at a validation point (V2), numerical uncertainty as an input | Scope via search (ASME press release, ANSI, Sandia overview record). Formulas to confirm. |
| Roache 1994, JFE 116(3) [R1] | GCI definition and Fs | Bibliographic record via search; content via secondary sources [R7]–[R10]. |
| Celik et al. 2008, JFE 130(7) 078001 [R2] | Five-step procedure (h definition, p iteration, extrapolation, errors, GCI) | Formulas verified through the MIT `gcat` implementation that cites it [R9]; original PDF blocked. |
| Salari & Knupp 2000, SAND2000-1444 [R5] | MMS procedure | OSTI record and abstract via search. |
| NPARC "Examining Spatial (Grid) Convergence" [R7] | Worked example | Host blocked; reproduced by the `convergence` package README [R8]. |

llull claims **no** compliance with any of these standards; it implements the published arithmetic and reports which
procedure was used.

## 9. KPIs / success metrics

| KPI | Target | How measured |
| --- | ------ | ------------ |
| Gated corpus green | 100 % of A-grade cases across all packs pass on the desktop toolchain | `npm run quality:physics` |
| Silent extrapolation | 0 extrapolated values reported for non-monotone studies | VC-VNV-04/05 + production-gate scenario |
| Studies on margins | 100 % of 05 margin rows shown to a reviewer have a non-stale study or an explicit `VNV_NO_CONVERGENCE_STUDY` warning | `check_verification` over the production scenario |
| Agent usability | US-1 and US-5 completed unattended in ≥ 9 of 10 scripted agent runs | production gate agent driver |
| Determinism | Same plan and toolchain ⇒ same study values and report hash | VC-VNV-17 |

## 10. Risks & assumptions

| Risk / assumption | Impact | Mitigation |
| ----------------- | ------ | ---------- |
| GCI is an estimate, not a bound; the "95 % confidence" claim for Fs = 1.25 is not backed by published statistics [R10] | Over-trust | Report it as an estimate; summary wording "estimated discretization error"; reviewer gate for margins |
| Unstructured tet meshes do not refine systematically; `globalSize` × ratio does not give exact geometric similarity | Noisy p | Use the representative spacing h = (V/N)^(1/D) from the actual element count [R2][R9]; least-squares fit (V1) |
| Singular quantities never converge | Endless refinement | Divergent classification, cap on levels (default 4) and on element count |
| Original standards and papers are paywalled; this pack verified formulas through two open implementations | Formula slip | Generator cross-checks both implementations' published numbers (VC-VNV-01, 06); open question to read the originals |
| Runtime of studies (each level is a full solve) | Slow agent loop | Content-hash cache (05 TR-FEA-05), `--timeout`, levels reuse cached coarse results |

## 11. References

- [R1] P. J. Roache, "Perspective: A Method for Uniform Reporting of Grid Refinement Studies", J. Fluids Eng. 116(3), 405–413, 1994 — ASME — https://scholarhub.vn/publication/Perspective-A-Method-for-Uniform-Reporting-of-Grid-Refinement-Studies/247af627-5c87-4eb6-a231-d7018475d527 (accessed 2026-10; bibliographic record via search; DOI not confirmed)
- [R2] I. B. Celik, U. Ghia, P. J. Roache, C. J. Freitas, H. Coleman, P. E. Raad, "Procedure for Estimation and Reporting of Uncertainty Due to Discretization in CFD Applications", J. Fluids Eng. 130(7), 078001, 2008 — https://doi.org/10.1115/1.2960953 (accessed 2026-10; formulas via [R9], PDF host blocked)
- [R3] ASME V&V 10-2019 (R2025) Standard for Verification and Validation in Computational Solid Mechanics — ASME — https://www.asme.org/codes-standards/find-codes-standards/standard-for-verification-and-validation-in-computational-solid-mechanics (accessed 2026-10; catalogue via search)
- [R4] ASME V&V 20-2009 (R2016) Standard for Verification and Validation in Computational Fluid Dynamics and Heat Transfer — ASME / ANSI — https://webstore.ansi.org/standards/asme/asme202009 (accessed 2026-10; catalogue via search)
- [R5] K. Salari, P. Knupp, "Code Verification by the Method of Manufactured Solutions", SAND2000-1444, Sandia, 2000 — OSTI 759450 — https://www.osti.gov/biblio/759450 (accessed 2026-10; record via search)
- [R6] ASME Journal of Fluids Engineering numerical accuracy policy (Celik et al. 2008 procedure) — https://doi.org/10.1115/1.2960953 (accessed 2026-10; via search)
- [R7] NPARC Alliance, "Examining Spatial (Grid) Convergence" — NASA Glenn — https://www.grc.nasa.gov/WWW/wind/valid/tutorial/spatconv.html (accessed 2026-10; host blocked, example reproduced via [R8])
- [R8] `convergence` 0.6.7 (port of NPARC verify.f90) — M. Topper; GPL-3.0 — https://pypi.org/project/convergence/0.6.7/ (accessed 2026-10; sdist downloaded and read)
- [R9] `gcat` grid convergence analysis toolkit — G. B. Santos; MIT — https://github.com/gabrielbdsantos/gcat (commit 0b4f6fd839762bca6ad756b89c900296738f2b4e, accessed 2026-10; cloned and read)
- [R10] "On the quantification of discretization uncertainty: comparison of two paradigms" — arXiv 2103.14559 — https://arxiv.org/abs/2103.14559 (accessed 2026-10; search extract only)
- AGENT_FIRST: [`../../aerospace/AGENT_FIRST.md`](../../aerospace/AGENT_FIRST.md); 05 FEA: [`../../aerospace/05-fea-cae-handoff/`](../../aerospace/05-fea-cae-handoff/); laws: `.claude/rules/architecture.md`
