# PHY-08: Fracture mechanics & damage tolerance — functional specification

Gap id **FRC** · status: specification · written 2026-10-15 · technical spec: [`TECHNICAL_SPEC.md`](TECHNICAL_SPEC.md)
· validation: [`validation/README.md`](validation/README.md) · sources: [`validation/sources.md`](validation/sources.md)

Citations `[Rn]` use the same numbers as the register ids `Sn` in `validation/sources.md`.

## 1. Summary

llull has nothing for cracks. After aerospace 05 (static FE, margins) and PHY-07 (fatigue initiation), a design can be
checked for strength and for the life to a first crack, but not for what damage-tolerance rules ask: **how fast a crack
grows from a detectable size to a critical size, how much strength remains with the crack present, and how often the
part must be inspected.** There is no stress-intensity factor (K) library, no K from FE results (CalculiX, bundled by
05, has no J-integral or interaction integral; its `*CRACK PROPAGATION` procedure uses simple shape factors on the
uncracked stress field [R9]), no crack-growth law, no residual-strength curve and no inspection interval.

14 CFR 25.571(b) requires a residual-strength evaluation with damage "consistent with the initial detectability and
subsequent growth under repeated loads" [R13]; the 1998 rulemaking based inspection thresholds on crack growth from
flaws likely to escape manufacturing inspection [R16]; NASA fracture control assumes flaws below the NDE detection
limit are present and requires the part to survive its service life with them [R17]. Damage tolerance is how most
metallic airframe and spaceflight structure is certified, so an aerospace design tool needs at least the analytic core
of it, traced and reviewable.

The pack delivers, as registry commands:

1. **K solutions**: a handbook library (centre and edge through cracks with finite-width corrections, Newman-Raju
   surface and corner cracks) with validity ranges, and **K from FE** by the interaction integral computed by llull from
   05 results on a crack-seamed mesh.
2. **Crack growth**: Paris, Walker, Forman and the NASGRO equation as PHY-02 material models, cycle-by-cycle or block
   integration over PHY-07 load histories, checked against closed-form Paris integration.
3. **Damage-tolerance results**: critical crack size and residual strength (K_c and net-section yield), crack-growth
   life, inspection threshold and interval with an explicit scatter factor, every result `reviewRequired`, and a human
   gate to accept an interval.

## 2. Aerospace context & value

| Context | Today | What llull adds | Source |
| ------- | ----- | --------------- | ------ |
| Part 25 damage tolerance | 25.571(b) residual strength at ultimate loads for listed limit conditions; damage size tied to detectability and growth. AC 25.571-1D is the guidance (WFD, LOV, discrete source) | Residual-strength curve, critical size, growth life and interval per crack location, traced to the design revision | [R13], [R14] |
| Inspection thresholds | 1998 NPRM: thresholds from crack growth from a manufacturing flaw likely to escape inspection ("rogue flaw") | Threshold = growth life from an initial flaw to critical / scatter factor, flaw size an explicit input | [R16] |
| EASA | CS 25.571 safe-life scatter factors; residual strength where damage is not readily detectable | Same commands; factors explicit | [R15] |
| Spaceflight fracture control | NASA-STD-5019: combined design, analysis, test, NDE and tracking of fracture-critical parts; critical initial flaw size; NDE at 90 % / 95 % for CIFS in one NASA presentation | `nasa_std_5019` profile (life factor from secondary sources, unconfirmed) | [R17] |
| Crack-growth tools | NASGRO (NASA / SwRI; standard in NASA, USAF and ESA fracture control) and AFGROW (originally AFRL, now LexTech; commercial licence, 5-day trial) | Analytic core inside the design loop; export for the stress office's NASGRO / AFGROW runs; no claim of equivalence | [R7], [R11] |
| FE fracture | Abaqus, Ansys, MOOSE compute K by the interaction integral; NAFEMS R0020 gives 2D LEFM benchmarks (Ansys VM-R020-t2a: 2.966 vs target 3) | Interaction integral as llull post-processing of CalculiX results, checked on NAFEMS 2.1 | [R4], [R10] |
| Test standards | ASTM E647 (da/dN from near threshold to instability, ΔK by linear elasticity), E399 (plane-strain K_Ic) | Material models carry the test standard and R in their provenance | [R18] |

**Value statements** (sourced only): residual strength and growth-based inspection are regulatory concepts [R13],
[R16]; computing them where the geometry lives removes manual re-entry into a separate crack-growth tool for each
design iteration (KPIs §9). The Paris closed form gives an exact check of the integrator, and NAFEMS 2.1 a check of the FE
K extraction that vendors also publish [R4].

## 3. Personas & user stories

Roles per [`../../aerospace/AGENT_FIRST.md`](../../aerospace/AGENT_FIRST.md). Damage-tolerance results set inspection
intervals, which are airworthiness data: **every** result is `reviewRequired`, and **accepting** an interval or a
threshold is a human-gated act (AF-34), even when the margin is positive.

| Role | Uses | Main need |
| ---- | ---- | --------- |
| **Operator** (AI agent, CLI / MCP) | `llull stress_intensity`, `compute_crack_growth`, `compute_residual_strength`, `compute_inspection_interval`, `check_damage_tolerance --json` | Deterministic numbers with units, validity flags, stable codes |
| **Owner** (not an engineer) | Natural language | "How often must this fitting be inspected?" answered with what was computed, what is unverified, and that a qualified engineer must accept it |
| **Qualified reviewer** (DT engineer, DOA signatory / DER, NASA fracture control board) | Desktop review, exported a-N curves, NASGRO/AFGROW cross-runs | Audits crack cases, data, factors; accepts intervals with a signature |

User stories:

- **US-1.** "How long does a 1.27 mm corner flaw at this hole take to become critical?" The agent defines the crack at the
  hole (handbook geometry), links the PHY-07 history and a NASGRO-equation model from the 08 record (PHY-02), runs
  `compute_crack_growth` and reports cycles to critical, the governing failure mode and the inputs, with `reviewRequired`.
- **US-2.** The agent proves its integrator on the closed-form Paris case (VC-FRC-05/06) and its K library on handbook
  values before trusting a run.
- **US-3.** With a 05 model, the agent seams the crack into the mesh, solves, and calls `compute_k_from_fe`; it checks
  the interaction-integral K against the handbook value and the contour-to-contour spread (VC-FRC-03, 17).
- **US-4.** The agent computes the residual-strength curve and the critical size at the required residual-strength load,
  and the inspection interval from the detectable size with an explicit scatter factor (VC-FRC-10…14).
- **US-5.** No scatter factor given → `FRC_SCATTER_FACTOR_UNSET`; geometry outside a K solution's validity →
  `FRC_K_SOLUTION_OUT_OF_RANGE`; the agent asks or changes method, never extrapolates silently.
- **US-6.** The agent prepares an interval for acceptance; only the reviewer can accept it
  (`dispose_damage_tolerance_result`, human signature).

## 4. Scope / out of scope

| Phase | In scope |
| ----- | -------- |
| **MVP (M1–M3)** | Crack definitions (handbook geometry + location); K library: centre through crack (secant), single edge crack (Tada / polynomial), Newman-Raju semi-elliptical surface crack in a plate (tension) — the latter gated on a human check of the equations (OQ-FRC-01); validity ranges. Crack-growth models (PHY-02): Paris, Walker, Forman, NASGRO equation (closure f as data or Newman function), tabular da/dN. Constant-amplitude and spectrum growth (PHY-07 histories; rainflow or cycle-by-cycle, no retardation), stop at K_max ≥ K_c, net-section yield or a target size. Residual strength (K_c, net-section yield), critical size. Inspection threshold / interval with explicit scatter factor; `reviewRequired`; human acceptance gate; `check_damage_tolerance`; a-N export. |
| **V1 (M4–M5)** | K from FE: crack seam in the 05 mesh (OCCT fragment in `llull-mesh`), quarter-point / ring refinement, interaction integral (2D, then 3D front) and J; plane-strain idealization contributed to 05; corner crack and cracks at holes (Newman-Raju family); bending terms; load-interaction (retardation) models as named options (Willenborg / Wheeler / closure-based, COULD); CalculiX `*CRACK PROPAGATION` read-back as an alternative. |
| **V2** | Weight-function K for arbitrary stress gradients from 05; multi-site / WFD screening; mixed-mode growth direction; R-curve residual strength (Feddersen-type plane-stress) ; probabilistic DT with PHY-18. |
| **Out of scope** | Elastic-plastic fracture beyond J reporting (FAD / BS 7910-type assessments), composite damage tolerance, generating da/dN allowables from test data, replacing NASGRO / AFGROW for certification, shipping licensed data (NASGRO materials database, MMPDS). |

## 5. Functional requirements

| Id | Pri | Requirement | Rationale | Source |
| -- | --- | ----------- | --------- | ------ |
| FR-FRC-01 | MUST | **Handbook K library** for through cracks: centre crack K = σ√(πa)·√sec(πa/W); single edge crack Tada form (stated 0.5 % for any a/b) and polynomial (0.5 % for a/b ≤ 0.6). Each solution declares its validity range and accuracy statement with source; outside → `FRC_K_SOLUTION_OUT_OF_RANGE`. | Most DT checks start from handbook K | [R1], [R2] |
| FR-FRC-02 | MUST | **Surface crack** (Newman-Raju 1981) K along the front (parametric angle φ) for 0.2 ≤ a/c ≤ 2, a/t < 1 within the published limits; results flagged `unverified` until OQ-FRC-01 is closed. | Part-through flaws at surfaces are the common initial flaw | [R5] |
| FR-FRC-03 | MUST (V1) | **K from FE** by the interaction integral (domain form) on 05 results with a crack seam: K_I, K_II (2D), K_III and per-node values along a 3D front; J for reporting; plane stress / plane strain E'. Reports contour-to-contour spread and refuses if > 5 % (`FRC_CONTOUR_SPREAD`). | Geometry not covered by handbooks | [R10], [R4] |
| FR-FRC-04 | MUST | **Crack-growth models as material data** (PHY-02 owns them): `da_dn_paris`, `da_dn_walker`, `da_dn_forman`, `da_dn_nasgro`, `da_dn_table`, plus `fracture_toughness` (K_Ic, K_c vs thickness, orientation L-T/T-L…) and threshold data; each with R, environment, test standard and provenance. Licensed data (NASGRO database, MMPDS) only in 08 private libraries. | One material model for the document | [R6], [R7], [R18], 08 MAT |
| FR-FRC-05 | MUST | **Constant-amplitude growth** a(N) with stop criteria: K_max ≥ K_c (fracture), net-section stress ≥ Fty (yield), a ≥ a_target, a ≥ geometry limit. | Basic DT calculation | [R6] |
| FR-FRC-06 | MUST | **Spectrum growth** over PHY-07 load histories: cycle-by-cycle (default) or block integration with an adaptive step limited to Δa/a ≤ 1 %; R per cycle from the counted cycle; no retardation in MVP (named default `retardation: none`, conservative assumption stated). | Real spectra | PHY-07 |
| FR-FRC-07 | MUST | **Residual strength** σ_rs(a) = min(K_c/(β√(πa)), net-section yield), critical size at a given residual-strength stress, governing mode named. | 25.571(b) | [R13] |
| FR-FRC-08 | MUST | **Inspection threshold and interval**: threshold = N(a_initial → a_crit)/SF_threshold, interval = N(a_detectable → a_crit)/SF_interval; a_initial and a_detectable are explicit inputs with source (NDE method / POD statement); results in cycles and in the history unit (flights, blocks, hours). | Damage-tolerance inspection programme | [R16], [R17] |
| FR-FRC-09 | MUST | **Named safety values (AF-31)**: scatter factors, residual-strength load, initial and detectable flaw sizes, K_c basis are explicit or from a sourced, named default. No built-in aviation scatter factor (OQ-FRC-03) → `FRC_SCATTER_FACTOR_UNSET`. Profile `nasa_std_5019` life factor 4 is `sourceStatus: "unconfirmed"` and marks results `unverified`. | No silent safety value | AF-31, [R17] |
| FR-FRC-10 | SHOULD (V1) | **CalculiX `*CRACK PROPAGATION` hand-off**: write the material constants in CalculiX's 8-constant form ((da/dN)_ref, ΔK_ref, m, ε, ΔK_th, δ, K_c, w) from a llull model and read back crack-front K / da/dN; llull's own K / growth remains the reference. | Reuse the bundled solver where it fits | [R9] |
| FR-FRC-11 | MUST | **Review flag (AF-33)**: every K, growth, residual-strength and interval result carries `reviewRequired: true` and "computed by llull, not approved". | Airworthiness data | AF-33 |
| FR-FRC-12 | MUST | **Human gate (AF-34)**: accepting an inspection interval / threshold, or a negative DT margin, is `dispose_damage_tolerance_result` with a human-held signature (09); agents get `FRC_HUMAN_GATE`. | Approval act | AF-34, 09 PLM |
| FR-FRC-13 | MUST | **Unverified propagation (AF-32)** from material models (basis typical / unstated), unconfirmed K solutions (Newman-Raju until checked), profile factors, PHY-07 histories or 05 results. `check_damage_tolerance` warns `FRC_DATA_UNVERIFIED` (not suppressible). | Typical data is not design data | AF-32 |
| FR-FRC-14 | MUST | **Staleness**: results bind to `dtInputHash` (crack, models, history hashes, 05 resultsHash); changes → `FRC_RESULTS_STALE`. | Revision traceability | 05 FR-FEA-22 |
| FR-FRC-15 | MUST | **Readiness check (AF-20)** `check_damage_tolerance`: crack definitions, validity ranges, model coverage of the ΔK / R range used (`FRC_RATE_EXTRAPOLATED`), units, factors, stale results, pending dispositions. | Agent proves its own work | AF-20 |
| FR-FRC-16 | MUST | **Numeric equivalents (AF-21)**: a-N, K-a, residual-strength curves and da/dN samples returned as data (bounded, paged); plots are optional views. | Agents read numbers | AF-21 |
| FR-FRC-17 | SHOULD | **Export** a-N and K-a tables (CSV / JSON) and a crack-case summary for NASGRO / AFGROW cross-runs by the stress office (no proprietary file formats claimed). | Hand-off | [R7], [R11] |
| FR-FRC-18 | MUST | Units (AF-04, AF-10): K in MPa·√m or ksi·√in, da/dN in m/cycle or in/cycle, explicit on every param and field; conversions tested. | Unit mistakes are classic DT errors | AF-04 |
| FR-FRC-19 | MUST | Stable codes (AF-11) per TECHNICAL_SPEC §7.1; a whole DT job fits one plan (AF-05); every capability reachable from CLI, MCP and UI (AF-01). | Agent operation | AF-01/05/11 |
| FR-FRC-20 | COULD | Retardation models (Willenborg, Wheeler, closure-based) as named options with the parameters explicit. | Spectrum effects | — |
| FR-FRC-21 | COULD | Weight-function K for arbitrary 1D stress profiles from 05 along the crack path. | Cracks in stress gradients | — |

## 6. Workflows

### 6.1 CLI

```bash
llull search crack damage tolerance                       # discover
llull describe stress_intensity compute_crack_growth compute_residual_strength compute_inspection_interval

# 0. self-checks: K library and integrator (VC-FRC-01, 05)
llull stress_intensity geometry=center_through 'dims={"a":{"value":10,"unit":"mm"},"W":{"value":100,"unit":"mm"}}' \
  'stress={"value":100,"unit":"MPa"}' --json
llull run plans/frc_paris_center_life.plan.json --doc check.llull.json --json

# 1. real job: crack at a hole, PHY-07 history, NASGRO-equation model from the 08 record
llull run fitting_dt.plan.json --validate --doc fitting.llull.json
llull run fitting_dt.plan.json --doc fitting.llull.json --json
llull compute_crack_growth caseId=$cg --doc fitting.llull.json --json          # a(N) summary, stop reason, life
llull compute_residual_strength crackId=$cr --doc fitting.llull.json --json     # curve + critical size
llull compute_inspection_interval caseId=$cg --doc fitting.llull.json --json    # threshold / interval, factors named
llull check_damage_tolerance caseId=$cg --doc fitting.llull.json --json

# 2. V1: K from FE (05 mesh with crack seam)
llull fea_mesh analysisId=$an … ; llull fea_solve analysisId=$an …
llull compute_k_from_fe analysisId=$an crackId=$cr method=interaction_integral --json

# 3. hand-off
llull export_crack_growth caseId=$cg format=csv --save out/a_N.csv --doc fitting.llull.json
```

The agent ends with `check_damage_tolerance` and reports (AF-36): what was computed, life / interval / critical size,
unverified inputs, defaulted values, what needs the reviewer, "computed by llull, not approved".

### 6.2 MCP

Same tools (toolset `durability`). Handbook K, growth, residual strength and intervals need no external process and
work on every host; `compute_k_from_fe` needs 05 artifacts (`FRC_RESULTS_MISSING` otherwise).

### 6.3 Desktop UI (review only)

Crack glyphs at locations, DT table (life, interval, critical size, badges), a-N / residual-strength plots from the same
data, acceptance dialog with signature (human gate).

### 6.4 Surface matrix

| Capability | CLI | MCP | UI |
| ---------- | --- | --- | -- |
| Crack / case definition | plan, `llull <command>` | registry | tree, glyphs |
| Handbook K, growth, residual strength, interval | queries | same | tables, plots |
| FE K (V1) | `compute_k_from_fe` | same, if artifacts | contour-spread table |
| Accept interval / negative result | prepare only (`FRC_HUMAN_GATE`) | prepare only | **complete** (signature) |
| Export | `export_crack_growth --save` | exchange dir | Export menu |

### 6.5 Error and edge behaviour

| Situation | Behaviour | FR |
| --------- | --------- | -- |
| a/W, a/c or a/t outside the solution's range | `FRC_K_SOLUTION_OUT_OF_RANGE`; no value | 01, 02 |
| ΔK below the model's tested range / above it | growth uses the model only inside its range; outside → `FRC_RATE_EXTRAPOLATED` warning, or zero growth below a declared threshold | 04, 15 |
| K_max ≥ K_c at the initial size | `FRC_INITIAL_CRITICAL` (no growth life) | 05 |
| Net-section yield before fracture | stop reason `net_section_yield` | 05, 07 |
| More than 1e8 cycles without reaching a stop | `FRC_RUNOUT`; reports the size reached | 06 |
| Scatter factor unset | `FRC_SCATTER_FACTOR_UNSET` | 09 |

### 6.6 Glossary

| Term | Meaning |
| ---- | ------- |
| K, ΔK, K_max, R | Stress-intensity factor, its range and maximum per cycle, stress ratio |
| β (or Y) | Geometry factor, K = β σ √(πa) |
| K_Ic / K_c | Plane-strain / thickness-dependent fracture toughness |
| Interaction integral | Domain integral giving K_I, K_II, K_III from the FE field and auxiliary crack-tip fields [R10] |
| Residual strength | Stress the cracked part carries before fracture or net-section yield |
| Threshold / interval | First inspection time / repeat inspection period |

## 7. Acceptance criteria

`D = --doc case.llull.json --json`; expected values in `validation/expected_results.json`.

| # | Given | When | Then | VC |
| - | ----- | ---- | ---- | -- |
| AC-1 | centre crack a 10 mm, W 100 mm, 100 MPa | `llull stress_intensity …` | `data.KMPaSqrtM` = 18.1748892684 (1e-12 rel) | VC-FRC-01 |
| AC-2 | edge crack a/b 0.5 | `stress_intensity geometry=edge_through form=tada` / `polynomial` | β = 2.82658060837 / 2.829125 | VC-FRC-02 |
| AC-3 | `plans/frc_nafems_r0020_t2_1.plan.json` solved (V1) | `compute_k_from_fe … method=interaction_integral` | K_I/(σ√(πa)) within 3 % of 3.0; spread ≤ 5 % | VC-FRC-03 |
| AC-4 | Paris centre crack 1 → 10 mm | `compute_crack_growth` (cycle-by-cycle) | life = 776 637 cycles; closed form 776 634.44 within 0.1 % | VC-FRC-05, 06 |
| AC-5 | secant case W 200 mm, 5 → 40 mm | `compute_crack_growth` | 92 454.92 cycles within 1e-6 rel (reference quadrature) / 0.1 % (integrator) | VC-FRC-07 |
| AC-6 | K_c 60, Fty 300, W 200, σ 150 MPa | `compute_residual_strength` | a_crit = 40.8158761 mm; a_net-yield = 50 mm; curve VC-FRC-12 with governing modes | VC-FRC-10…12 |
| AC-7 | a_det 5 mm, SF 2 | `compute_inspection_interval` | interval = 46 420.576 cycles; `factors.scatter.defaulted: false` | VC-FRC-13, 14 |
| AC-8 | no scatter factor | same | exit 1, `FRC_SCATTER_FACTOR_UNSET` | VC-FRC-20 |
| AC-9 | agent accepts the interval | `dispose_damage_tolerance_result … decision=accepted` | exit 1, `FRC_HUMAN_GATE`, doc unchanged | VC-FRC-20 |
| AC-10 | K_c with basis `typical` | `check_damage_tolerance` | `FRC_DATA_UNVERIFIED` warning; results `unverified` | VC-FRC-20 |
| AC-11 | any result | any DT query | `reviewRequired: true`, summary "not approved" | VC-FRC-20 |
| AC-12 | a/W = 0.6 centre crack | `stress_intensity` | `FRC_K_SOLUTION_OUT_OF_RANGE` | VC-FRC-20 |

## 8. Standards & regulatory alignment

| Reference | Use | Status |
| --------- | --- | ------ |
| 14 CFR 25.571 [R13] | Residual strength with damage consistent with detectability and growth | Search (LII, FAA Amdt 54) |
| AC 25.571-1D [R14] | Guidance location; no values used | Search; values not seen |
| CS 25.571 [R15] | Scatter factors, detectability wording | Search extract |
| FAA 1998 NPRM / 2010 WFD rule [R16] | Threshold concept, WFD definition, LOV | Search (govinfo) |
| NASA-STD-5019 [R17] | Fracture control concepts (CIFS, NDE flaw, life factor) | Standard page; factor 4 secondary only |
| ASTM E647, E399 [R18] | Provenance fields of da/dN and K_Ic data | Catalogue scope (search) |
| NAFEMS R0020 [R4] | 2D LEFM benchmark 2.1 | Paid; values via Ansys VM |

llull claims no certification credit; DT reports read "pre-sizing; not a certified damage-tolerance analysis".

## 9. KPIs / success metrics

| KPI | Target | How measured |
| --- | ------ | ------------ |
| Grade-A reference cases | 100 % pass | PHY-00 harness |
| Integrator error vs closed form | ≤ 0.1 % | VC-FRC-05/06 |
| FE K on NAFEMS 2.1 (V1) | within 3 % of 3.0 | VC-FRC-03 |
| Silent safety values | 0 | VC-FRC-20 |
| Agent-accepted intervals | 0 | VC-FRC-20 |

## 10. Risks & assumptions

| Risk / assumption | Impact | Mitigation |
| ----------------- | ------ | ---------- |
| Newman-Raju equations transcribed from memory and partial search extracts (NTRS blocked) | Wrong surface-crack K | Grade C, `unverified` until a human checks TM-83200 (OQ-FRC-01) |
| NASGRO closure-function coefficients and Walker exponent conventions differ between sources (e.g. py-fatigue writes the Walker intercept with m/(1−γ)) | Wrong rates | Models store the convention explicitly; tests pin one convention per model (OQ-FRC-02, OQ-FRC-04) |
| No retardation in MVP | Conservative (usually) but may be very conservative with overloads | Named default with statement; V1 options |
| Licensed data (NASGRO database, MMPDS da/dN) | Users cannot run without data | 08 private libraries; `FRC_MODEL_UNAVAILABLE` on cloud |
| FE crack seam support depends on 05 meshing extensions | V1 delay | MVP is handbook-based |
| Scatter factor values unconfirmed | Users want defaults | Explicit input only |

## 11. References

- [R1] Centre-crack secant finite-width correction — FITNET MK7 Annex A (2006) — https://ocw.unican.es/pluginfile.php/2189/course/section/2048/soluciones_fit__fitnet_.pdf (search)
- [R2] Single-edge-crack geometry factors (Tada form and polynomial, 0.5 % statements) — arXiv 2009.06588, arXiv 2608.18766 (search); Tada, Paris, Irwin, The Analysis of Cracks Handbook, ASME Press (catalogue)
- [R3] Feddersen, residual strength of centre-cracked panels (secant attribution), ASTM STP symposium paper (1971) — https://store.astm.org/stp26673s.html (catalogue, search)
- [R4] Ansys Mechanical APDL Verification Manual VM-R020-t2a, NAFEMS "2D Test Cases in LEFM" test 2.1 — https://ansyshelp.ansys.com/public/Views/Secured/corp/v261/en/ans_vm/VMR020t2a.html (search; accessed 2026-10)
- [R5] Newman & Raju, Stress-Intensity Factor Equations for Cracks in Three-Dimensional Finite Bodies, NASA TM-83200 (1981) — https://ntrs.nasa.gov/api/citations/19810023035/downloads/19810023035.pdf ; Eng. Fract. Mech. 15 (1981) 185–192; NASA TM-85793 — https://ntrs.nasa.gov/api/citations/19840015857/downloads/19840015857.pdf (search; fetch blocked)
- [R6] Paris law: CalculiX manual ("the first part of the law corresponds to the Paris law") — https://github.com/Dhondtguido/CalculiX (git); reliability `fracture_mechanics_crack_growth` — https://github.com/MatthewReid854/reliability (git); py-fatigue `ParisCurve` — https://pypi.org/project/py-fatigue/2.1.1/ (pypi)
- [R7] NASGRO equation and Newman closure function — NASA NTRS 19950008059 https://ntrs.nasa.gov/citations/19950008059 ; Klysz papers https://yadda.icm.edu.pl/baztech/element/bwmeta1.element.baztech-article-BWM6-0030-0004/c/httpwww_ptmts_org_pl2012-4-klysz-in.pdf (search)
- [R8] Walker / Forman crack-growth forms — py-fatigue `crack_growth_curve.py` (Walker, pypi); textbook forms otherwise (to confirm)
- [R9] CalculiX User's Manual, "Crack propagation", `*CRACK PROPAGATION`, `*HCF` — https://github.com/Dhondtguido/CalculiX/tree/fd588701edd6a92fde06e99b1bdf01f3b0f80f2c (git)
- [R10] Interaction / J integral: MOOSE Fracture Integrals — https://mooseframework.inl.gov/releases/moose/v1.0.0/modules/tensor_mechanics/FractureIntegrals.html ; Abaqus Theory "Stress intensity factor extraction" — https://docs.software.vt.edu/abaqusv2023/English/SIMACAETHERefMap/simathe-c-stressintfact.htm (search)
- [R11] AFGROW — LexTech — https://www.afgrow.net/support/faq.aspx , https://www.afgrow.net/purchase.aspx (search)
- [R12] NASGRO fracture mechanics software (NASA / SwRI), described as the standard code for NASA, USAF and ESA fracture control in NTRS 19950008059 (search); licence terms not checked
- [R13] 14 CFR 25.571 — https://www.law.cornell.edu/cfr/text/14/25.571 ; https://www.faa.gov/sites/faa.gov/files/2022-11/25.571amdt54.pdf (search)
- [R14] FAA AC 25.571-1D — https://www.faa.gov/documentLibrary/media/Advisory_Circular/AC_25_571-1D_.pdf (search)
- [R15] EASA CS 25.571 — https://www.easa.europa.eu/en/document-library/easy-access-rules/online-publications/easy-access-rules-large-aeroplanes-cs-25 (search)
- [R16] FAA NPRM 98-8379 (1998) https://www.govinfo.gov/content/pkg/FR-1998-03-31/html/98-8379.htm ; WFD final rule (2010) https://www.govinfo.gov/content/pkg/FR-2010-11-15/pdf/2010-28363.pdf (search)
- [R17] NASA-STD-5019 — https://standards.nasa.gov/standard/NASA/NASA-STD-5019 ; NESC risk-informed NDE TM — https://ntrs.nasa.gov/citations/20250004074 ; ICAM 2022 fracture control for AM — https://ntrs.nasa.gov/citations/20220015942 (search)
- [R18] ASTM E647 (fatigue crack growth rates), ASTM E399 (K_Ic) — https://store.astm.org/products-services/standards-and-publications/standards/fatigue-standards-and-fracture-standards.html (catalogue, search)
- [R19] llull PHY-07 fatigue pack (histories, counting) — `docs/physics/07-fatigue/`; aerospace 05 / 08 / 09 packs — `docs/aerospace/`
