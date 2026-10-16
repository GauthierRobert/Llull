# PHY-17: Topology & shape optimization — functional specification

Gap id **TOP** · status: specification · written 2026-10-15 · technical spec: [`TECHNICAL_SPEC.md`](TECHNICAL_SPEC.md)
· validation pack: [`validation/README.md`](validation/README.md) · sources register: [`validation/sources.md`](validation/sources.md)

## 1. Summary

After the aerospace packs, llull can analyse a part (05 FEA) but cannot tell the designer **where material is
needed**. "Make this bracket 30 % lighter and keep it as stiff as possible" is one of the most natural requests an
owner gives an AI agent, and today the agent can only guess pockets and re-run the analysis.

Topology optimization answers it: given a design domain, loads, supports and a material budget, find the material
layout that minimises compliance (maximises stiffness). The standard method is **SIMP** (solid isotropic material
with penalization): each element carries a density x ∈ [0, 1], stiffness is interpolated as E(x) = Emin + x^p (E0 −
Emin) with p = 3, the densities are updated by the optimality-criteria (OC) method or MMA, and a filter of radius
rmin removes checkerboards and mesh dependence. The 88-line MATLAB code of Andreassen et al. 2011 is the reference
formulation that every open implementation copies [R1][R2].

PHY-17 adds an optimization study to a 05 analysis case, a solver transport that runs SIMP in the bundled CPython,
and a **derived, read-only** result: a density field plus an iso-surface mesh that the derivation guard (L8) protects
from edits. The agent never ships that mesh as the part: it **rebuilds** a clean parametric part with ordinary llull
commands (sketch, extrude, fillet, booleans), guided by numeric descriptors (section contours, member widths, volume
fraction), and then **verifies** the rebuild with 05 FEA and `compare_to_topology`. Shape optimization (moving the
boundary of an existing parametric part through its parameters) is a V1 extension that reuses PHY-18's parameter
sensitivities.

## 2. Aerospace context & value

| Context | Today (who / which tools) | What llull adds | Source |
| ------- | ------------------------- | --------------- | ------ |
| Lightweight brackets and fittings | Commercial topology tools inside FE pre-processors; open codes from DTU (top88, top99) used for teaching and research | Topology optimization inside the CAD document, driven by a CLI agent, with the rebuild and verification loop | [R1], [R3] |
| Reference formulation | Andreassen et al. 2011: modified SIMP, OC, sensitivity or density filter, MBB benchmark; built on Sigmund's 99-line code | The same formulation, same MBB benchmark pinned in the validation pack | [R1], [R2] |
| Open-source implementations | topoptlab (GPL-3.0) re-implements top88 and extensions (MMA, projections, AM filter); ToPy (MIT, Python 2 stable); `topopt` (MIT, MMA via NLopt) | llull's own implementation with BSD/MIT dependencies only; the open codes serve as cross-checks | [R4]–[R6] |
| Solver | CalculiX (bundled by 05) offers sensitivity analysis for **node-coordinate** (shape) and **orientation** design variables (`*DESIGN VARIABLES, TYPE=COORDINATE / ORIENTATION`, `*SENSITIVITY`, `*FEASIBLE DIRECTION`), not density-based topology optimization | Density SIMP in llull's bridge; CalculiX sensitivities considered for shape optimization (V2) and CalculiX for verification of the rebuilt part | [R7] |
| Additive manufacturing | Topology results are often printed; overhang filters exist in research codes (topoptlab lists a 2D Langelaar AM filter) | Overhang and minimum-member-size controls as manufacturing constraints (V1/V2) | [R4] |

**Value statements** (sourced only): the method and benchmark are standard and openly documented [R1][R2]; the
rebuild-and-verify loop removes the classic failure where an optimised mesh is shipped without re-analysis. No ROI or
mass-saving figure is claimed.

## 3. Personas & user stories

| Role | Who | Uses | Main need |
| ---- | --- | ---- | --------- |
| **Operator (primary)** | AI agent on the `llull` CLI (MCP for cloud) | `llull create_topology_study`, `llull topology_solve`, `llull topology_report`, `llull suggest_rebuild`, `llull compare_to_topology`, `llull check_topology` | Deterministic optimisation with numbers it can turn into a parametric part, and a check that proves the rebuild |
| **Owner** | Person asking for a lighter part; **not an engineer** | Natural language | "This bracket can be 35 % lighter with the same stiffness; here is the new part; it still needs a stress check by an engineer" |
| **Qualified reviewer** | Stress engineer / DOA signatory | Desktop review: density view, rebuild vs density overlay, 05 margins of the rebuilt part | Accepts the rebuilt part for release (09 PLM), never the raw density |

User stories:

- **US-1.** "Make this bracket 30 % lighter." The agent sets up a 05 analysis (loads, supports), declares the design
  domain and the keep-out/keep-in regions (bolt bosses, mating faces), creates a study with `volumeFraction` 0.7,
  runs `topology_solve`, reads `topology_report` (compliance history, final volume, grey level), rebuilds the part
  from `suggest_rebuild` contours, runs 05 FEA on the rebuild, and reports mass saving, stiffness ratio, and margins.
- **US-2.** The agent tries to `move_entities` or `boolean` the iso-surface mesh: the derivation guard rejects it with
  `TOP_DERIVED_READ_ONLY` and tells it to rebuild instead.
- **US-3.** After a load change, the density result is `stale`; `check_topology` says so; the agent re-runs.
- **US-4.** The rebuilt part deviates too much from the optimum (`compare_to_topology` IoU < target, or stiffness
  more than X % worse): `check_topology` fails with `TOP_REBUILD_DEVIATION`.
- **US-5.** The owner asks for a 3D-printable result: the agent adds an overhang constraint (V2) and a minimum
  member size; the report names both.
- **US-6 (reviewer).** Release of the rebuilt part goes through 05 margins and 09 signatures; the density result
  itself is marked "concept, not a design" and can never be released (`TOP_RESULT_NOT_RELEASABLE`).

## 4. Scope / out of scope

| Phase | In scope |
| ----- | -------- |
| **MVP** | Minimum compliance with a volume constraint, single and multiple load cases (weighted sum), 2D plane stress (thin/extruded parts) and 3D voxel grids over the design domain, modified SIMP (p = 3, Emin = 1e-9 E0), OC update, sensitivity and density filters, keep-in (frozen solid) and keep-out (frozen void) regions, symmetry planes, derived density field + iso-surface mesh (read-only), `topology_report`, `suggest_rebuild` (2D section contours, member widths), `compare_to_topology`, `check_topology`, MBB benchmark. |
| **V1** | MMA optimizer, Heaviside projection (crisper 0/1 designs), extrusion / casting direction constraint, minimum member size via filter radius with a stated rule, mass minimisation with a compliance or displacement constraint, shape optimization of parametric parts through parameter sensitivities (PHY-18), unstructured-mesh SIMP on the 05 tet mesh. |
| **V2** | Stress-constrained optimisation (aggregated p-norm), AM overhang filter, frequency (eigenvalue) objectives, CalculiX node-based shape optimisation hand-off, lattice infill grading. |
| **Out of scope** | Automatic conversion of a density field into a final released CAD part (the agent rebuilds; a human releases). Level-set and homogenisation methods. Topology optimisation of composites (06 CMP) and of thermal problems (later with PHY-03). |

## 5. Functional requirements

| Id | Pri | Requirement | Rationale | Source |
| -- | --- | ----------- | --------- | ------ |
| FR-TOP-01 | MUST | A **topology study** belongs to a 05 analysis case and records: design domain (entity ids), keep-in and keep-out regions (`facesNear` / entity ids / boxes), objective, constraints, interpolation (p, Emin), filter (type, radius with unit), optimizer, voxel size, symmetry planes, load-case weights. All set by commands, replayed, saved. | L1/L4/L8 | 05 FR-FEA-01 |
| FR-TOP-02 | MUST | **Minimum compliance** subject to a **volume fraction** of the design domain, OC update with move limit 0.2 and bisection on the Lagrange multiplier, stop when max \|Δx\| ≤ 0.01 or `maxIterations` (named defaults). | Reference formulation | [R1] |
| FR-TOP-03 | MUST | **Modified SIMP**: E(x) = Emin + x^p (E0 − Emin), defaults p = 3 and Emin = 1e-9 E0, named. E0 and ν come from the 08 material record through 05's `FeaMaterialView`. | [R1] | [R1], 05 TR-FEA-04 |
| FR-TOP-04 | MUST | **Filters**: sensitivity filter and density filter with linear-hat weights max(0, rmin − distance); `rmin` in document length units, default 1.5 × voxel size (named, as the reference default rmin = 1.5 elements). | Mesh independence, no checkerboards | [R1], [R2] |
| FR-TOP-05 | MUST | The optimizer reproduces the analytic optimum of a separable test problem (springs in series, p = 1) and the MBB benchmark of the pack. | Code verification (PHY-00) | [R1], generator |
| FR-TOP-06 | MUST | **Keep-in / keep-out** regions are frozen at 1 / 0 every iteration and excluded from the volume budget accounting (reported separately). Load and support faces are keep-in by default (named default). | Bolt bosses and interfaces must stay | [R4] (passive elements) |
| FR-TOP-07 | MUST | **Result as derived, read-only geometry** (L8): the density field (artifact) and an iso-surface mesh entity at threshold 0.5 (named default) are regenerated from the study and protected by a derivation guard; any edit → `TOP_DERIVED_READ_ONLY`. | Concept geometry must not become the design by accident | architecture L8 |
| FR-TOP-08 | MUST | `topology_report` (AF-21) returns in `data`: iteration history (compliance, volume, change), final compliance with units, volume fraction, mass of the thresholded design, grey-level measure, per-load-case compliance, keep-in volume, filter radius in mm and in voxels, status (`converged`, `max_iterations`, `stale`). | Numbers first | AF-10, AF-21 |
| FR-TOP-09 | MUST | **Discreteness**: the report gives the grey-level measure mean(4x(1 − x)); `check_topology` warns `TOP_GREY_HIGH` above 0.1 (named llull default, no source). | Grey designs cannot be manufactured | — |
| FR-TOP-10 | MUST | `suggest_rebuild` (query) returns rebuild aids as data: for 2D / extruded studies, closed contours (polylines) of the thresholded field per section plane, simplified (Douglas-Peucker tolerance named), with member widths at sample points; for 3D, sections on N planes and a skeleton of members (V1). The agent turns them into `draw_polyline` + `extrude_profile` or other existing commands. | The rebuild stays parametric and editable | AGENT_FIRST AF-21 |
| FR-TOP-11 | MUST | `compare_to_topology` (query) compares a rebuilt solid with the thresholded density: volume ratio, intersection-over-union on the voxel grid, and — when a 05 result of the rebuild exists — compliance ratio rebuild/optimum. | Proof that the rebuild follows the optimum | AF-20 |
| FR-TOP-12 | MUST | `check_topology` (AF-20) returns pass / warn / fail with codes: set-up (no domain, no loads, keep-in exceeds budget, filter smaller than 1 voxel), result (stale, not converged, grey), rebuild (missing, deviation over targets, rebuild not analysed by 05, rebuild margins missing). | The agent ends every job with it | AF-20 |
| FR-TOP-13 | MUST | **Manufacturing constraints (MVP)**: symmetry planes (mirror the field). **V1**: extrusion direction (uniform density along an axis), minimum member size rule (filter radius ≥ half the minimum member size, stated as llull rule). **V2**: overhang angle for AM. Each constraint is listed in the report. | Manufacturable results | [R4] |
| FR-TOP-14 | MUST | **Staleness**: results store the analysis input hash (05 TR-FEA-06) plus the study hash; any change marks them stale; the derived mesh shows a stale flag and `suggest_rebuild` refuses stale results. | Results must match the design revision | 05 FR-FEA-22 |
| FR-TOP-15 | MUST | **Never releasable**: the density result and its mesh carry `concept: true`; 09 PLM release refuses a document whose released items include them (`TOP_RESULT_NOT_RELEASABLE`). The rebuilt part follows normal 05 margins, `reviewRequired` and human disposition. | AF-33/34: the optimiser does not decide strength | AGENT_FIRST |
| FR-TOP-16 | MUST | **Unverified propagation**: if E or ν are 08 `unverified`, the report and every rebuild comparison carry `unverified` (AF-32). | AF-32 | AGENT_FIRST |
| FR-TOP-17 | MUST | **Named defaults** (AF-31) for p, Emin, move, stop tolerance, filter radius, threshold, grey limit, iteration cap, each `{ value, source, defaulted }` in `data.settings`. | AF-31 | AGENT_FIRST |
| FR-TOP-18 | MUST | **Deterministic** results: same study, mesh and toolchain ⇒ identical densities (single-threaded solve or deterministic reductions) and identical report hash. | AF-13 | AGENT_FIRST |
| FR-TOP-19 | MUST | Long runs report progress per iteration, respect `--timeout`, can resume from the last stored iterate (artifact), and cache by content hash (AF-40). | Agent loop | AF-40 |
| FR-TOP-20 | MUST | Stable error codes with ids and remediation (TECHNICAL_SPEC §7.1). | AF-11 | AGENT_FIRST |
| FR-TOP-21 | SHOULD | `render_view` draws the density field and the rebuild overlay (AF-22); the UI shows an iteration slider. | Visual check for multimodal agents | AF-22 |
| FR-TOP-22 | SHOULD (V1) | **MMA** optimizer (Svanberg) for multiple constraints, with a permissively licensed implementation or a llull port. | OC handles one constraint only | [R4], [R6] |
| FR-TOP-23 | COULD (V1) | **Shape optimization** of a parametric part: objective and constraint gradients with respect to document parameters (PHY-18 `parameter_sensitivity`), bounded parameter update, each iteration a normal `set_parameter` step. | Clean CAD from the start | PHY-18 |
| FR-TOP-24 | COULD (V2) | Stress-constrained and eigenfrequency objectives. | Strength-driven design | — |

## 6. Workflows

### 6.1 CLI (operator's primary path)

```bash
llull search topology lighter
llull describe create_topology_study topology_solve topology_report suggest_rebuild compare_to_topology check_topology

# 1. part + 05 analysis set-up + study in one plan (validate first, AF-05)
llull run bracket_topo.plan.json --validate --doc b.llull.json
llull run bracket_topo.plan.json --doc b.llull.json --kernel occt --json        # $study id via plan aliases (AF-14)

# 2. optimise (transport: --progress per iteration, --timeout, resumable, AF-40)
llull topology_solve studyId=ts-9.1 --doc b.llull.json --kernel occt --progress --timeout 1800 --json
llull topology_report studyId=ts-9.1 --doc b.llull.json --json                  # history, volume, grey, compliance
llull render_view view=front studyId=ts-9.1 field=density --save out/density.png --doc b.llull.json

# 3. rebuild as a parametric part from numeric aids, then verify
llull suggest_rebuild studyId=ts-9.1 plane=XY tolerance=0.5 --doc b.llull.json --json   # contours[] in mm
llull run rebuild.plan.json --doc b.llull.json --kernel occt --json             # draw_polyline + extrude_profile + fillet_edge
llull compare_to_topology studyId=ts-9.1 entityId=$rebuild --doc b.llull.json --json   # IoU, volume and compliance ratio
llull fea_mesh … ; llull fea_solve … ; llull compute_margins … --json           # 05 on the rebuild
llull check_topology studyId=ts-9.1 --doc b.llull.json --json                   # ends the job (AF-20)
```

The agent reports (AF-36): mass saved, stiffness ratio of the rebuild, margins and that they need a qualified
engineer, every `unverified` input, and that the density result is a concept only.

### 6.2 MCP agent

Same registry commands (toolset `analysis`); `topology_solve` exists only on hosts with the bundled CPython (numpy,
scipy); otherwise `TOP_TOOL_MISSING` (AF-41).

### 6.3 Desktop UI (review surface)

Density view (iso-surface, threshold slider, iteration slider), rebuild overlay with deviation colouring built from
`compare_to_topology` data, report table. No approval act is specific to this gap: release of the rebuilt part uses
05 disposition and 09 signatures.

### 6.4 Surface matrix

| Capability | CLI | MCP | UI | Notes |
| ---------- | --- | --- | -- | ----- |
| Study set-up | `llull run plan.json`, `llull <command>` | registry | study panel | pure commands |
| Solve | `llull topology_solve` | where configured | progress | transport → validated `record_topology_result` |
| Report / rebuild aids / compare / check | `--json` queries | same | panels | read-only |
| Derived density mesh | read-only entity | same | iso-surface | derivation guard |
| Release | refused for concept items | same | — | 09 PLM |

### 6.5 Error and edge behaviour

| Situation | Behaviour | FR |
| --------- | --------- | -- |
| Keep-in volume ≥ volume budget | Refused before solve, `TOP_KEEPIN_EXCEEDS_BUDGET` with both volumes | FR-TOP-06 |
| No support / under-constrained domain | 05 `FEA_UNDERCONSTRAINED` surfaces as `TOP_SETUP_INVALID` | FR-TOP-12 |
| Filter radius below one voxel | Warning `TOP_FILTER_TOO_SMALL` (checkerboards likely) | FR-TOP-04 |
| Iteration cap reached | Result stored with `status: max_iterations`, `TOP_NOT_CONVERGED` warning | FR-TOP-02 |
| Load face not inside the design domain | Refused, `TOP_LOAD_OUTSIDE_DOMAIN` | FR-TOP-01 |
| Edit of the derived mesh | Rejected, `TOP_DERIVED_READ_ONLY` | FR-TOP-07 |
| Voxel count above cap | Refused, `TOP_GRID_TOO_LARGE` with the count and a suggested voxel size | FR-TOP-19 |

### 6.6 Glossary

| Term | Meaning |
| ---- | ------- |
| Design domain | Region where material may be placed |
| Compliance | Work of external loads, Fᵀu; lower = stiffer [R1] |
| SIMP | Solid isotropic material with penalization; E(x) = Emin + x^p (E0 − Emin) [R1] |
| OC | Optimality-criteria update with a bisection on the volume multiplier [R1] |
| Sensitivity / density filter | Smoothing of derivatives or densities over radius rmin [R1] |
| Grey level | Fraction of intermediate densities, mean(4x(1 − x)) |
| Keep-in / keep-out | Passive regions frozen solid / void |
| Rebuild | Parametric part modelled with ordinary commands to follow the optimum |

## 7. Acceptance criteria

`D` = `--doc case.llull.json --kernel occt --json`; values in `validation/expected_results.json`.

| # | Given | When (CLI) | Then (JSON) | VC |
| - | ----- | ---------- | ----------- | -- |
| AC-1 | `plans/top_mbb_60x20.plan.json` (2D, 60×20 voxels, volfrac 0.5, p 3, rmin 1.5 voxel, sensitivity filter, `protectLoadSupport: false`) | `topology_solve`, `topology_report` | last-iteration compliance 203.192457639 (rel 1e-6), volume 0.49997 (abs 1e-3), iterations 94 (±2, grade B) | VC-TOP-10 |
| AC-2 | `plans/top_mbb_60x20_density.plan.json` | same | compliance 218.803221064 (rel 1e-6), iterations 127 (±2, grade B) | VC-TOP-11 |
| AC-3 | separable problem a = [1, 4, 9, 16], V = 2, p = 1 | optimizer unit test | x = [0.2, 0.4, 0.6, 0.8] (abs 1e-6), objective 50 | VC-TOP-03 |
| AC-4 | uniform x = 0.5 on 30×10 | one analysis | c(0.5)/c(1) = 7.99999994398 | VC-TOP-04 |
| AC-5 | the derived mesh of AC-1 | `llull move_entities 'ids=["$topoMesh"]' delta=[1,0,0] D` | exit 1, `TOP_DERIVED_READ_ONLY`, doc unchanged | VC-TOP-20 |
| AC-6 | AC-1 result, then `set_parameter` on the domain | `check_topology` | `TOP_RESULT_STALE`; `suggest_rebuild` refuses with the same code | VC-TOP-21 |
| AC-7 | AC-1 result | `suggest_rebuild plane=XY` | contours closed, total enclosed area / domain area within 0.02 of the thresholded volume fraction | VC-TOP-22 |
| AC-8 | a rebuild plan from AC-7 contours | `compare_to_topology` | IoU ≥ 0.85 (llull target, TBD measure), volume ratio within 0.05 | VC-TOP-23 |
| AC-9 | `plans/top_rejection_keepin_budget.plan.json` (keep-in box 40×20 = 0.667 of the domain, volfrac 0.5) | `llull run <plan> D` | step `set_topology_regions` fails, `error.code` = `TOP_KEEPIN_EXCEEDS_BUDGET` (AF-14), doc unchanged by that step | VC-TOP-24 |
| AC-10 | material E from an 08 `typical` value | `topology_report` | `unverified: true`; `check_topology` warning `TOP_INPUT_UNVERIFIED` | VC-TOP-25 |
| AC-11 | 09 release of a configuration that includes the density mesh | release command | refused, `TOP_RESULT_NOT_RELEASABLE` | VC-TOP-26 |
| AC-12 | AC-1 run twice | compare report hashes | identical | VC-TOP-27 |

## 8. Standards & regulatory alignment

No standard governs topology optimization itself. Relevant alignment:

| Reference | Use | Status |
| --------- | --- | ------ |
| Andreassen et al. 2011 [R1] | Formulation and MBB benchmark | Bibliographic record and DTU page via search; algorithm as transcribed by topoptlab [R4] |
| Sigmund 2001 99-line code [R2] | Origin of the sensitivity filter and OC | Search (cited by [R1]/[R4]) |
| 14 CFR 25.303 / 05 margins | The rebuilt part is substantiated by 05 margins, not by the optimiser | via 05 pack |
| 09 PLM release | Concept items not releasable | 09 pack |

## 9. KPIs / success metrics

| KPI | Target | How measured |
| --- | ------ | ------------ |
| Benchmark reproduction | VC-TOP-10/11 match (B-grade until a second implementation agrees, then gate) | `npm run quality:physics` |
| Rebuild quality | IoU ≥ target and compliance ratio ≤ 1.15 on the production scenario (targets TBD) | `compare_to_topology` |
| Concept leakage | 0 releases containing a density result | VC-TOP-26 |
| Agent usability | US-1 completed unattended in ≥ 8 of 10 agent runs | production gate (V1) |
| Runtime | 2D 60×20 ≤ 10 s; 3D 100k voxels ≤ 10 min on desktop | §8 TECHNICAL_SPEC |

## 10. Risks & assumptions

| Risk / assumption | Impact | Mitigation |
| ----------------- | ------ | ---------- |
| Owners read the density mesh as a finished part | Unsafe parts | Read-only, `concept: true`, never releasable, mandatory rebuild + 05 check |
| Rebuild from contours needs judgement | Poor parts | Numeric aids, `compare_to_topology` targets, reviewer gate for release |
| 3D voxel SIMP in Python is slow | Long agent loops | Voxel cap, PCG with multigrid preconditioning (scipy), resumable iterates; V1 unstructured mesh |
| Only one implementation (the generator) pins the MBB values | Formula slip undetected | Cross-check against topoptlab (GPL, run outside llull) or the DTU MATLAB code; values B-grade until then |
| GPL implementations (topoptlab, mmapy) cannot be bundled into llull's bridge process | Licence | Own implementation on numpy/scipy (permissive licences); GPL codes only as external cross-checks |

## 11. References

- [R1] E. Andreassen, A. Clausen, M. Schevenels, B. S. Lazarov, O. Sigmund, "Efficient topology optimization in MATLAB using 88 lines of code", Struct. Multidisc. Optim. 43(1):1–16, 2011, doi:10.1007/s00158-010-0594-7 — DTU TopOpt group page https://www.topopt.mek.dtu.dk/apps-and-software/efficient-topology-optimization-in-matlab (accessed 2026-10; search extract, host blocked)
- [R2] O. Sigmund, "A 99 line topology optimization code written in Matlab", Struct. Multidisc. Optim. 21:120–127, 2001 — cited by [R1] and [R4] (accessed 2026-10; not opened)
- [R3] DTU TopOpt group, "Topology optimization codes written in Python" — https://www.topopt.mek.dtu.dk/apps-and-software/topology-optimization-codes-written-in-python (accessed 2026-10; search extract)
- [R4] topoptlab 1.0.0 — S. Hiemer; GPL-3.0 — https://pypi.org/project/topoptlab/1.0.0/ (sdist downloaded and read; `example_bc/lin_elast.py` `mbb_2d`, `optimizer/optimality_criterion.py`, README feature list)
- [R5] ToPy — W. Hunter; MIT — https://github.com/williamhunter/topy (commit 3c461c4b65c0f5f0c5476a4711a26a7e1ff64e58, cloned; stable release Python 2.7)
- [R6] topopt (Python) — Z. Ferguson; MIT — https://github.com/zfergus/topopt (commit c3d3bd546327732b72ea3862d0283b324b25422f, cloned; MMA through NLopt)
- [R7] CalculiX User's Manual (`doc/CalculiX.tex`, sections *DESIGN VARIABLES, *SENSITIVITY, *FEASIBLE DIRECTION) — G. Dhondt; GPL-2.0 — https://github.com/Dhondtguido/CalculiX (commit fd588701edd6a92fde06e99b1bdf01f3b0f80f2c, accessed 2026-10)
- AGENT_FIRST, 05 FEA, 09 PLM packs; architecture laws `.claude/rules/architecture.md` (L8 derivation guards).
