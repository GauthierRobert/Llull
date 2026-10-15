# PHY-05: Nonlinear structural analysis — functional specification

Gap id **PHY-05** · prefix **NLS** · status: specification · written 2026-10-15 · technical spec:
[`TECHNICAL_SPEC.md`](TECHNICAL_SPEC.md) · validation: [`validation/README.md`](validation/README.md) · sources:
[`validation/sources.md`](validation/sources.md)

## 1. Summary

Once the aerospace packs are built, llull analyses parts with linear static, modal and linear buckling cases
(aerospace 05 FEA, `../../aerospace/05-fea-cae-handoff/`). Everything is linear: stress is proportional to load,
geometry does not change while the load is applied, and the material never yields. Three questions that stress
engineers ask every week therefore cannot be answered:

1. **How much load can the part really carry before it collapses?** A ductile fitting has plastic reserve beyond
   first yield; a linear model stops at first yield and calls everything above it a failure.
2. **Does the part keep its shape after an overload?** 14 CFR 25.305 asks that limit loads cause no detrimental
   permanent deformation [R1]. Permanent set needs a load-unload analysis with plasticity.
3. **What happens after buckling, or when deflections are large?** Thin panels, clips and flexures carry load
   after the first buckle or rotate far enough that small-displacement theory is wrong. A linear buckling factor
   is not a collapse load, and it is unconservative for imperfection-sensitive shapes.

This pack adds a `nonlinear_static` analysis type to the 05 analysis model. It runs on the CalculiX solver that 05
already bundles (`*STEP, NLGEOM`, `*STATIC` with automatic incrementation, `*PLASTIC` and `*DEFORMATION
PLASTICITY` from the PHY-02 material models) [R2]. Results come back as **data first**: a load-displacement curve,
the limit load and how it was found, the plastic zone, permanent set after unloading, and convergence history.
Because CalculiX has no arc-length (Riks) control [R2], llull adds a small native corotational beam solver with
arc-length control for frames and slender members, so snap-through and snap-back can still be traced and the
solver itself can be verified against NAFEMS NL7 [R3].

## 2. Aerospace context & value

| Context | Today (who / which tools) | What llull adds | Source |
| ------- | ------------------------- | --------------- | ------ |
| Permanent deformation at limit load | Stress offices run an elastic-plastic analysis in Abaqus, Nastran SOL 400 or Ansys and check residual strain after unloading. | Load-unload steps in one plan, residual displacement and equivalent plastic strain as numbers, a check that names the threshold used. | [R1] |
| Ultimate strength with plastic reserve | Hand methods (plastic bending, Cozzone) or nonlinear FE for fittings and lugs. | Limit load from the computed curve (peak, or plateau) with the method recorded, fed into 05 margins as a reviewer-gated criterion. | [R1], [R4] |
| Post-buckling and imperfection sensitivity | Nonlinear buckling with a scaled first eigenmode as imperfection, in commercial codes. | `add_imperfection` from a 05 buckling case with an explicit amplitude (never defaulted), NLGEOM run, load-displacement curve. | [R2] |
| Large deflection of flexures and slender members | Elastica tables or nonlinear beam codes. | `beam_large_deflection` query (native corotational beam, arc-length), checked against the elastica closed form and NAFEMS NL7. | [R3], [R10] |
| Solver verification | Vendors publish NAFEMS NL benchmarks (Abaqus NL2, NL7 [R3]); Code_Aster ships its own nonlinear tests [R6]. | NL7 (Lee frame) and analytic plasticity cases in the PHY-00 benchmark corpus. | [R3], [R6] |
| Open-source nonlinear solvers | CalculiX: Newton increments, NLGEOM, J2 plasticity (isotropic, kinematic, combined), Ramberg-Osgood deformation plasticity, 638 regression decks including plasticity ones (`beampiso`, `beampkin`, `beampd`) [R2]. Code_Aster: `STAT_NON_LINE` with `PILOTAGE` types `DDL_IMPO`, `LONG_ARC`, `ANA_LIM` [R6]. | Uses CalculiX as the bundled solver; Code_Aster stays an optional, user-installed hand-off for arc-length on continua. | [R2], [R6] |

Value statements (sourced only, no invented ROI):

- 25.305 states the deformation requirement in words that only a nonlinear analysis can check directly [R1].
- A collapse load computed by llull with its method and curve attached replaces a hand transcription from a separate
  tool, and the curve is versioned with the design revision (05 staleness rules apply).
- The NL7 limit load 18.55 (normalised) quoted from NAFEMS through the Abaqus benchmark [R3] is reproduced by this
  pack's generator to 0.07 % (`validation/expected_results.json` VC-NLS-20.a), so the native solver is proven before
  any user relies on it.

## 3. Personas & user stories

Roles follow [`../../aerospace/AGENT_FIRST.md`](../../aerospace/AGENT_FIRST.md) §1. Nonlinear analysis is easier to
get wrong than linear analysis: a run can stop early, a load-controlled run cannot pass a peak, and a too-coarse mesh
shows fake hardening. The owner is not assumed to know any of this, so llull carries the rules (convergence
codes, limit-point detection, imperfection required for buckling-type collapse, mesh adequacy) and every result that
could support a strength claim is marked `reviewRequired` (AF-33).

| Role | Who | Uses | Main need |
| ---- | --- | ---- | --------- |
| **Operator (primary)** | AI agent through the `llull` CLI (MCP for cloud) | `llull run`, `fea_mesh`, `fea_solve`, `nonlinear_report`, `limit_load`, `check_nonlinear`, `beam_large_deflection` | Deterministic set-up, convergence and limit-point codes it can act on, curves as JSON |
| **Owner** | Person asking "how much can it take?" or "will it stay straight after the overload?". Not assumed to be an engineer | Natural language; may watch the desktop app | A plain answer with the limit load, how sure llull is, and what a qualified engineer must still check |
| **Qualified reviewer** | Stress engineer / DOA signatory | Desktop review: curve plot, plastic zone overlay, margin rows, disposition | Accepts or rejects a limit-load-based margin; owns the plastic-reserve judgement |

User stories:

- **US-1 (owner → operator).** "What is the collapse load of this bracket?" The agent copies the 05 static case into a
  `nonlinear_static` case, picks the PHY-02 plasticity model of the part's 08 material, switches to displacement control
  on the load face, adds a load-displacement probe, solves, and calls `limit_load`. It reports the limit load, the method
  (peak or plateau), the strain at the peak and "computed by llull, not approved".
- **US-2 (operator).** A load-controlled run stops with `NLS_LIMIT_POINT_REACHED`. The agent reads the remediation,
  switches to displacement control and re-runs; it does not report the last converged load as the collapse load.
- **US-3 (owner → operator).** "Will the fitting deform permanently at limit load?" The agent adds a load step to limit
  load and an unload step to zero, solves, and reads `permanentSet` (max residual displacement, max PEEQ) from
  `nonlinear_report`. `check_nonlinear` compares them with the thresholds the owner or the company rule supplied; if none
  are given it warns `NLS_PERMANENT_SET_THRESHOLD_UNSET` instead of inventing one.
- **US-4 (operator).** For a thin compression panel the agent runs the 05 buckling case, then `add_imperfection` with
  mode 1 and an amplitude the owner confirmed, and a `nonlinear_static` run with NLGEOM. Without an amplitude the command
  refuses with `NLS_IMPERFECTION_AMPLITUDE_UNSET`.
- **US-5 (operator).** For a flexure the agent calls `beam_large_deflection` with the frame idealisation and compares the
  tip rotation with `nonlinear_analytic_check check=elastica_cantilever` in the same JSON.
- **US-6 (reviewer).** The reviewer opens the curve, the plastic zone and the margin rows marked `criterion:
  "limit_load"`, and records an acceptance through 05 `dispose_margin` (human gate).

## 4. Scope / out of scope

| Phase | In scope |
| ----- | -------- |
| **MVP** | `nonlinear_static` analysis type on the 05 model; NLGEOM on/off; load control with automatic incrementation and named convergence presets; displacement control on a target; multi-step load / unload; PHY-02 material models exported to CalculiX `*PLASTIC` (isotropic, kinematic, combined) and `*DEFORMATION PLASTICITY` (Ramberg-Osgood); load-displacement probes; FRD/DAT increment parsing; `nonlinear_report`, `limit_load`, `check_nonlinear`; analytic quick checks (plastic hinge, thick cylinder, elastica, imperfect column); stable codes; validation VC-NLS-10 … 63. |
| **V1** | `add_imperfection` from a 05 buckling mode (first or chosen mode, explicit amplitude) and combination of modes; `beam_large_deflection` native corotational 2D beam solver with arc-length (NL7); permanent-set check; limit-load-based rows in 05 `compute_margins` (reviewer-gated); restart / continuation of a run (`*RESTART`). |
| **V2** | 3D corotational beams in the native solver; shells with NLGEOM and plasticity through the 05 shell idealisation; Code_Aster export for arc-length on continua (user-installed, licence GPL-3.0); material models beyond PHY-02 MVP (Chaboche multi-backstress) when PHY-02 ships them. |
| **Out of scope** | Contact (PHY-06), creep (PHY-11), explicit dynamics and failure / damage (PHY-19), fatigue (PHY-07), writing a general nonlinear continuum solver in TypeScript. Certification sign-off (llull computes, humans approve). |

## 5. Functional requirements

| Id | Pri | Requirement | Rationale | Source |
| -- | --- | ----------- | --------- | ------ |
| FR-NLS-01 | MUST | A 05 analysis case can have type **`nonlinear_static`**, with `nlgeom: boolean` set explicitly (no default: the description says when it matters). All set-up is command data, replays and is versioned (05 FR-FEA-01, 22). | One analysis model, traceable | [R2], 05 |
| FR-NLS-02 | MUST | Each analysed part uses a **PHY-02 `MaterialModel`** (plasticity variants: bilinear / multilinear J2 with isotropic, kinematic or combined hardening; Ramberg-Osgood) attached to its 08 material record, chosen by id. llull stores no stress-strain data of its own. The deck writer maps them to `*PLASTIC, HARDENING=…` or `*DEFORMATION PLASTICITY`. | PHY-02 owns material data (README §6.2) | [R2], PHY-02 |
| FR-NLS-03 | MUST | **Load control** with automatic incrementation: initial, minimum and maximum increment and maximum increment count, plus a named convergence preset (`ccx_default`, quoted from the CalculiX manual) or explicit `*CONTROLS` values. Every value used is returned named (`{ value, source, defaulted }`). | Increment control decides whether a run finishes | [R2], AF-31 |
| FR-NLS-04 | MUST | **Displacement control** on a 05 target (face, edge, point) and DOF: the run prescribes a displacement history, and the reaction on that target is the load measure. **Arc-length control** is refused on CalculiX with `NLS_ARC_LENGTH_UNSUPPORTED` (CalculiX documents no RIKS / arc-length parameter [R2]) and offered by `beam_large_deflection` (frames) and, V2, the Code_Aster export. | Passing a limit point needs displacement or arc-length control | [R2], [R6] |
| FR-NLS-05 | MUST | **Limit load** (`limit_load`, read-only) from a load-displacement curve: `peak` (first maximum of load with increasing displacement), `plateau` (slope below a stated fraction of the initial slope over a stated displacement window, both explicit), or `not_reached` (curve still rising at the end). The method, inputs and curve hash are returned (AF-35). A load-controlled run that stops at a limit point reports `NLS_LIMIT_POINT_REACHED` and its last load as a **lower bound**, never as the limit load. | A collapse load must say how it was found | AF-35 |
| FR-NLS-06 | MUST | **Results as data** (`nonlinear_report`): converged increments with load factor and time, per-step summary, curve points per probe (load with unit, displacement with unit), max von Mises and max equivalent plastic strain (PEEQ) with location, plastic zone (element count and volume fraction with PEEQ > 0), convergence history (iterations, cutbacks), solver messages. | AF-10/21 | [R2] |
| FR-NLS-07 | MUST | **Multi-step load histories**: `add_analysis_step` with per-load-case multipliers and ramp/step amplitude, so load → unload → reload is one plan. `permanentSet` (max residual displacement, max residual PEEQ) after a step that returns all loads to zero. | 25.305 permanent deformation; PHY-16 springback reuses it | [R1], [R2] |
| FR-NLS-08 | MUST | **Load-displacement probes**: `add_curve_probe { load: load id \| reaction at constraint id, displacement: point + DOF }`; curves are stored in the 05 artifact store and summarised (point count, max load, displacement range, hash) in the document. | The curve is the primary result | 05 TR-FEA-05 |
| FR-NLS-09 | SHOULD (V1) | **Imperfections**: `add_imperfection` from a solved 05 `buckling` case (mode number, amplitude as a length, sign) or a sum of modes; the deck writer perturbs node coordinates. The amplitude has **no default** (AF-31); the owner or a company rule supplies it. | Imperfection-sensitive collapse | AF-31, [R2] |
| FR-NLS-10 | MUST | **Guardrails** applied by `check_nonlinear`: buckling-type collapse checked without an imperfection (`NLS_IMPERFECTION_MISSING`), NLGEOM off while max rotation or strain exceeds the stated small-deformation limits (`NLS_NLGEOM_RECOMMENDED`), PEEQ beyond the last point of the hardening curve (`NLS_STRAIN_BEYOND_CURVE`), elongation-at-break exceeded where the 08 record has it (`NLS_STRAIN_EXCEEDS_ELONGATION`), fewer than 2 elements through a yielding thickness (`NLS_MESH_PLASTIC_ADEQUACY`). | The operator is not an engineer | AF-20, AF-30 |
| FR-NLS-11 | MUST | **Analytic quick checks** (`nonlinear_analytic_check`, read-only): plastic hinge collapse of beams (cantilever, simply supported, propped, fixed-fixed), elastic-plastic moment-curvature of a rectangle, thick cylinder first-yield and collapse pressure (Tresca, von Mises), elastica cantilever, imperfect pinned column amplification. Same formulas as the generator. | Hand checks next to FE | [R10]–[R12] |
| FR-NLS-12 | SHOULD (V1) | **Native corotational beam solver** `beam_large_deflection` (2D frames, Euler-Bernoulli, arc-length or load control), pure and deterministic, returning the equilibrium path, limit points and snap-back flags. | No arc-length in CalculiX; NL7 proof | [R3] |
| FR-NLS-13 | MUST | **Stable codes** for non-convergence, increment below minimum, limit point, snap-back, unsupported control, missing material model, stale curve (TECHNICAL_SPEC §7.1). | AF-11 | AF-11 |
| FR-NLS-14 | SHOULD (V1) | **Limit-load margins**: 05 `compute_margins` accepts `criterion: "limit_load"` using `limit_load` output (MS = P_limit / (P_limit-case × FoS) − 1); rows are `reviewRequired` and FAIL/MARGINAL rows stay `pending_human` (05 FR-FEA-33). | Plastic reserve is an engineering judgement | [R4], 05 |
| FR-NLS-15 | MUST | **No silent safety values** (AF-31): convergence tolerances, increment limits, plateau slope fraction, permanent-set thresholds and imperfection amplitudes are explicit or named defaults with a source; thresholds that have no sourced default (permanent set, imperfection) have **no** default. | AF-31 | AF-31 |
| FR-NLS-16 | MUST | **Unverified propagation** (AF-32): a PHY-02 model fitted to `unverified` data, or an 08 property marked `unverified`, flags every curve, limit load and margin row computed from it. | AF-32 | AF-32 |
| FR-NLS-17 | MUST | **Review flag** (AF-33): `nonlinear_report`, `limit_load`, `check_nonlinear` carry `reviewRequired: true` with a reason and the plain sentence "computed by llull, not approved — needs a qualified engineer". | Strength claims | AF-33 |
| FR-NLS-18 | MUST | **Long runs** (AF-40): `fea_solve` streams increment progress (step, increment, load factor, iterations), respects `--timeout`, can be cancelled, and is cached by input hash. | Nonlinear runs take minutes | AF-40 |
| FR-NLS-19 | MUST | **Verification**: the pack's cases run through the PHY-00 harness (`run_benchmarks`); limit loads used in margins carry a PHY-00 `check_convergence` study (≥ 3 mesh levels) or the warning `VNV_NO_CONVERGENCE_STUDY`. | AF-23 | PHY-00 |
| FR-NLS-20 | COULD (V2) | **Code_Aster deck export** (`STAT_NON_LINE` with `PILOTAGE`) for arc-length on continua, run by a user-installed Code_Aster; results imported as review-only. | Arc-length on solids | [R6] |

## 6. Workflows

### 6.1 CLI (operator, primary)

```bash
llull search nonlinear limit load                           # AF-01
llull describe set_nonlinear_controls add_curve_probe limit_load
llull guide                                                 # nonlinear section: NLGEOM, controls, limit point (AF-03)

# 1. one plan: geometry, 08 record + PHY-02 plasticity model, nonlinear case, displacement control, probe
llull run plans/nls_cantilever_plastic_collapse.plan.json --validate --doc c.llull.json
llull run plans/nls_cantilever_plastic_collapse.plan.json --doc c.llull.json --kernel occt --json

# 2. mesh, check, solve (progress per increment, --timeout, cached by input hash)
llull fea_mesh analysisId=$an --doc c.llull.json --kernel occt --json
llull check_nonlinear analysisId=$an --doc c.llull.json --json          # set-up codes before solving
llull fea_solve analysisId=$an --doc c.llull.json --progress --timeout 1800 --json

# 3. numbers first
llull nonlinear_report analysisId=$an --doc c.llull.json --json         # curve, PEEQ, convergence history
llull limit_load analysisId=$an probe=tip method=plateau 'plateau={"slopeFraction":0.02,"windowMm":5}' --json
llull nonlinear_analytic_check check=plastic_hinge_beam 'inputs={"support":"cantilever","b_mm":10,"h_mm":20,"sigmaY_MPa":250,"L_mm":500}' --json
llull check_nonlinear analysisId=$an --doc c.llull.json --json          # end of every job

# 4. frames: native arc-length (no mesh, no external tool)
llull beam_large_deflection --json "$(cat plans/nls_lee_frame.query.json)"
```

The agent reports, in order (AF-36): what was run (controls, NLGEOM, material model id), the limit load and method, any
`unverified` input, codes needing a human, and "computed by llull, not approved — needs a qualified engineer".

### 6.2 MCP (cloud)

Same commands in toolset `analysis`. `fea_solve` exists only where the host provides `ccx`; otherwise
`FEA_TOOL_MISSING` (05). `beam_large_deflection` and `nonlinear_analytic_check` need no external tool and work everywhere.

### 6.3 Desktop UI (review and approval only)

Curve plot per probe (built on `nonlinear_report` data), PEEQ contour and deformed shape at a chosen increment (05 overlay),
increment slider, limit-load marker with method label, margin rows with `criterion: limit_load`, and the 05 disposition
dialog (human gate). The UI adds no capability.

### 6.4 Error and edge behaviour

| Situation | Behaviour | FR |
| --------- | --------- | -- |
| Load-controlled run reaches a limit point (increment cut below minimum while load factor < 1 and stiffness → 0) | Run ends; `NLS_LIMIT_POINT_REACHED` with last converged load as `lowerBound`; remediation "switch to displacement control" | FR-NLS-05 |
| Displacement-controlled run where the reaction decreases while the controlled displacement increases | Normal: the curve has a peak; `limit_load` method `peak` | FR-NLS-05 |
| Path turns back in the controlled displacement (snap-back) | `NLS_SNAP_BACK_DETECTED`; remediation "use beam_large_deflection (frames) or a Code_Aster arc-length export" | FR-NLS-04 |
| Arc-length requested on CalculiX | Refused, `NLS_ARC_LENGTH_UNSUPPORTED` | FR-NLS-04 |
| PEEQ exceeds the last tabulated hardening point | Warning `NLS_STRAIN_BEYOND_CURVE` (CalculiX holds the curve flat beyond the last point; llull does not extrapolate) | FR-NLS-10 |
| Material record has no plasticity model | Solve refused, `NLS_MATERIAL_MODEL_MISSING` naming part and record | FR-NLS-02 |
| Results from an earlier input hash | `NLS_CURVE_STALE` / 05 `FEA_RESULTS_STALE`; `limit_load` refuses | FR-NLS-08 |

## 7. Acceptance criteria

`D` = `--doc case.llull.json --kernel occt --json`. Values and tolerances from `validation/expected_results.json`.

| # | Given | When (CLI) | Then (JSON) | VC |
| - | ----- | ---------- | ----------- | -- |
| AC-1 | — | `llull nonlinear_analytic_check check=elastica_cantilever 'inputs={"lambda":1}' --json` | `data.deltaVOverL` = 0.30172077 ± 1e-6 | VC-NLS-10.a |
| AC-2 | `plans/nls_lee_frame.query.json` (20 elements per leg) | `llull beam_large_deflection … --json` | first limit point `loadNorm` within 1 % of 18.55, `vOverL` within 0.004 of 0.407; `snapBack: true` | VC-NLS-20 |
| AC-3 | `plans/nls_thick_cylinder.plan.json` (axisymmetric, ν = 0.49) | run, `fea_mesh`, `fea_solve`, `limit_load method=not_reached\|peak` | first-yield pressure within 2 % of the generator; pressure at the last converged increment ≤ p_c and within 2 % of 166.398 MPa when the run is displacement-controlled | VC-NLS-30 |
| AC-4 | `plans/nls_cantilever_plastic_collapse.plan.json` | run, mesh, solve, `limit_load method=plateau` | limit load within 3 % of 500 N | VC-NLS-40.b |
| AC-5 | the same case but load-controlled to 1.2 × 500 N | `fea_solve`; `nonlinear_report` | exit 0, `data.code: "NLS_LIMIT_POINT_REACHED"`, `lowerBound` ≤ 500 N, `limitLoad` absent | VC-NLS-60 |
| AC-6 | `plans/nls_column_imperfection.plan.json` | buckling case then `add_imperfection` without amplitude | exit 1, `NLS_IMPERFECTION_AMPLITUDE_UNSET`, doc unchanged | VC-NLS-62 |
| AC-7 | same with amplitude 0.5 mm, P = 0.5 P_cr | solve, `nonlinear_report` | mid-span additional deflection within 5 % of 0.5 mm | VC-NLS-50.b |
| AC-8 | a case with `control.kind = "arc_length"` and solver `calculix` | `llull set_nonlinear_controls …` | exit 1, `NLS_ARC_LENGTH_UNSUPPORTED` | VC-NLS-63 |
| AC-9 | any solved nonlinear case | `nonlinear_report`, `limit_load`, `check_nonlinear` | `reviewRequired: true`, `summary` contains "not approved"; every control value is a named value | VC-NLS-64, 65 |
| AC-10 | a PHY-02 model whose source is `unverified` | `limit_load` | `unverified: true` with reasons; `check_nonlinear` warning `NLS_MATERIAL_MODEL_UNVERIFIED` | VC-NLS-66 |

## 8. Standards & regulatory alignment

| Reference | Use in llull | Status of what is claimed |
| --------- | ------------ | ------------------------- |
| 14 CFR 25.305 [R1] | Wording of the permanent-set check (limit load: no detrimental permanent deformation; ultimate: no failure 3 s). llull reports residual values; the threshold for "detrimental" is supplied by the owner or reviewer. | Quoted through the 05 register (search-verified). |
| NASA-STD-5001B [R4] | Margin equation reused for limit-load rows. | Through 05 register (search-verified). |
| NAFEMS NNB Rev. 1 (1989), tests NL2, NL7 [R3] | Benchmarks. | Paid; values only as quoted by the Abaqus benchmark pages (search extract) and, for NL7, reproduced by the generator. |
| CalculiX User's Manual [R2] | Keywords, controls, convergence criteria, output variables. | Read in the repository at a pinned commit. |

llull claims no certification credit for nonlinear results. Reports carry "for design / pre-sizing; not a certified
stress report".

## 9. KPIs / success metrics

| KPI | Target | How measured |
| --- | ------ | ------------ |
| Benchmarks passing | 100 % of A-grade VC-NLS cases on the desktop build | PHY-00 `run_benchmarks` |
| Limit-point honesty | 0 runs where a load-controlled stop is reported as `limitLoad` | VC-NLS-60 in CI + production-gate scenario |
| Silent values | 0 control values, thresholds or amplitudes without `value/source/defaulted` | VC-NLS-65 |
| Agent completion | US-1 and US-3 finished unattended (except human gates) in ≥ 9 of 10 scripted runs | agent driver (AF-23) |
| Run time | cantilever collapse (≈ 20k nodes, C3D20R) ≤ 5 min on the reference desktop | TBD — measure (VC-NLS-70) |

## 10. Risks & assumptions

| Risk / assumption | Impact | Mitigation |
| ----------------- | ------ | ---------- |
| No arc-length in CalculiX [R2] | Snap-back of continua cannot be traced | Displacement control (covers snap-through), native beam solver (frames), Code_Aster export V2; `NLS_SNAP_BACK_DETECTED` makes the limit visible |
| Mesh-dependent collapse (localisation, coarse meshes) | Unconservative limit loads | `NLS_MESH_PLASTIC_ADEQUACY`, PHY-00 convergence study required before limit-load margins (FR-NLS-19) |
| NAFEMS values come second-hand (Abaqus pages, search only) | A quoted target could be mis-transcribed | NL7 cross-checked by the generator; NL2 kept grade C until the tables are obtained |
| NL7B (a variant) target reported mesh dependent and about 17 % high in the gap list | Wrong gate | NL7B is not used (README gap list caution) |
| Plastic reserve used for ultimate strength without review | Unsafe sign-off | `reviewRequired`, human disposition (05) |
| Assumption: PHY-02 delivers `MaterialModel` with J2 multilinear and Ramberg-Osgood variants | Dependency | Interface named in TECHNICAL_SPEC §3; this pack defines no material data |
| Assumption: 05 artifact store holds per-increment results | Size | Store only probe curves and selected increments by default (`outputIncrements`) |

## 11. References

- [R1] 14 CFR §25.305 Strength and deformation — GPO — https://www.govinfo.gov/content/pkg/CFR-2010-title14-vol1/pdf/CFR-2010-title14-vol1-sec25-305.pdf (accessed 2026-10, search; via aerospace 05 register S1a)
- [R2] CalculiX CrunchiX User's Manual (`doc/CalculiX.tex`) and test suite — G. Dhondt, GPL-2.0 — https://github.com/Dhondtguido/CalculiX/tree/fd588701edd6a92fde06e99b1bdf01f3b0f80f2c (accessed 2026-10, git)
- [R3] Abaqus Benchmarks Guide, NL7 "Lee's frame buckling problem" and NL2 "Axisymmetric thick cylinder" (quoting NAFEMS NNB Rev. 1, 1989) — Dassault Systèmes — https://docs.software.vt.edu/abaqusv2024/English/SIMACAEBMKRefMap/simabmk-c-nl7.htm ; https://docs.software.vt.edu/abaqusv2024/English/SIMACAEBMKRefMap/simabmk-c-nl2.htm (accessed 2026-10, search only)
- [R4] NASA-STD-5001B — NASA — https://standards.nasa.gov/sites/default/files/standards/NASA/B-w/CHANGE-3/3/2022-10-24-NASA-STD-5001B-w-Change-3-Approved.pdf (accessed 2026-10, search; via 05 register S2)
- [R6] code_aster source and test base (`code_aster/Cata/Commons/c_pilotage.py`, `astest/`) — EDF, GPL-3.0 — https://gitlab.com/codeaster/src/-/tree/94bf28a308de5a77587675a598aacdddb722f84e (accessed 2026-10, raw files)
- [R7] suanPan manual, Lee's frame example (arc-length, normalised geometry) — T. L. Chang — https://github.com/TLCFEM/suanPan-manual/blob/4af0f1a39fb5abc19962c907aeded0d7eec797b4/docs/Example/Structural/Statics/lees-frame.md (accessed 2026-10, git)
- [R10] Bisshopp & Drucker, "Large deflection of cantilever beams", Quarterly of Applied Mathematics 3 (1945) 272–275 — AMS — https://www.ams.org/qam (citation via search; closed form re-derived in the generator)
- [R11] Abaqus Benchmarks Guide 3.2.14 "Cylinder under internal pressure" (Prager & Hodge 1951 cited) — https://abaqus-docs.mit.edu/2017/English/SIMACAEBMKRefMap/simabmk-c-cylinderunderpress.htm (accessed 2026-10, search)
- [R12] C. Caprani, Plastic Analysis lecture notes (collapse mechanisms) — https://www.colincaprani.com/files/notes/SAIII/Plastic%20Analysis%200809%20-%20Update.pdf (accessed 2026-10, search)
- Repo laws: `.claude/rules/architecture.md`; aerospace packs 05, 08 (`docs/aerospace/`); physics README §6.
