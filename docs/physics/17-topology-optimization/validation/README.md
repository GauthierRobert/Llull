# PHY-17 TOP: validation pack

This pack proves a future implementation of topology optimization described in `../FUNCTIONAL_SPEC.md` (`FR-TOP-*`)
and `../TECHNICAL_SPEC.md` (`TR-TOP-*`). Expected values are:

- **(b) Derived / reproduced** by [`generate_top_reference.py`](generate_top_reference.py): Python standard library
  only, deterministic, `python3 -I generate_top_reference.py` (≈ 50 s; run twice on 2026-10-15, byte-identical).
  It contains closed-form cases (element stiffness, filter weights, a separable optimum, SIMP scaling) and a full
  reproduction of the top88 MBB benchmark with an exact banded Cholesky solver.
- **(a) Cross-checked**: the MBB final compliances were reproduced independently by running topoptlab 1.0.0
  (GPL-3.0, numpy/scipy) outside llull on 2026-10-15; the two agree to 1e-10 relative. Values recorded in the
  generator's `TOPOPTLAB` table and in each case's `crossCheck`.
- **(c) TBD** with the tool that will measure it.

Grades (README §6.3): **A** = closed form in the generator, or two independent implementations agree; **B** = one
implementation only (iteration counts, grey levels); **TBD** = not a gate. Tolerances are llull acceptance choices.

## Files

| File | Kind | Content |
| ---- | ---- | ------- |
| `generate_top_reference.py` | generator | Writes the four files below. |
| `expected_results.json` | (b) + (a) | VC-TOP-01…04, 10…12, 20…27 in the §6.3 schema. |
| `mbb_history.csv` | (b) | Compliance, volume fraction and change per iteration for both MBB runs (sensitivity and density filter). |
| `mbb_60x20_sensitivity.txt`, `mbb_60x20_density.txt` | (b) | Final xPhys fields as 20 rows × 60 digits (density × 9 rounded; top row first, load at top-left). A visual and diffable check of the classic MBB truss layout. |
| `plans/top_mbb_60x20.plan.json` | draft plan | Domain box 60×20×1 mm, benchmark material E = 1 MPa / ν = 0.3 (08 commands), 05 plane-stress analysis with ux = 0 on the left edge, uy = 0 at the bottom-right corner, unit load down at the top-left corner, then the **proposed** `create_topology_study` + `set_topology_settings` (sensitivity filter, `protectLoadSupport: false` to match top88). |
| `plans/top_mbb_60x20_density.plan.json` | draft plan | Same with the density filter. |
| `plans/top_rejection_keepin_budget.plan.json` | draft plan | Keep-in box 40×20 (0.667 of the domain) with volume fraction 0.5: must fail with `TOP_KEEPIN_EXCEEDS_BUDGET`. |
| `sources.md` | register | Sources, access grade, what was verified. |

No third-party file is stored here (topoptlab is GPL-3.0: its code was run, not copied).

## Real use cases

| # | Use case | Who | Evidence | Cases |
| - | -------- | --- | -------- | ----- |
| U1 | Lighten a bracket or fitting under its load cases | Designers of machined / printed brackets | Minimum-compliance SIMP is the standard method, documented openly by DTU [S1] and re-implemented by several open codes [S3]–[S5] | VC-TOP-10, 11, 23 |
| U2 | Teach / verify a topology optimizer | Universities, tool developers | The MBB half-beam is the canonical benchmark of the 88-line code [S1]; topoptlab calls it "the standard case from the 88 line code paper" [S3] | VC-TOP-10, 11 |
| U3 | Hand a concept to a parametric rebuild and prove it | Design offices; AI agents | llull design: derived read-only geometry (L8) + `compare_to_topology` | VC-TOP-20…23 |

## Validation cases

| VC | Proves | Setup | Expected | Tolerance | Source | Grade | Gate |
| -- | ------ | ----- | -------- | --------- | ------ | ----- | ---- |
| VC-TOP-01 | TR-TOP-05 | KE for ν = 0.3, E = 1, unit square | KE[0][0] = 0.494505494505 = (12 − 4ν)/(24(1−ν²)); KE[0][1] = 0.178571428571 = (3 + 3ν)/(24(1−ν²)); row sums 0 | 1e-12 rel; 1e-14 abs | (b) [S1] | A | unit |
| VC-TOP-02 | FR-TOP-04 | filter weights, rmin = 1.5 | centre 1.5; edge 0.5; diagonal 0.0857864376269; Hs (interior) 3.84314575051 | 1e-15 | (b) | A | unit |
| VC-TOP-03 | FR-TOP-05; TR-TOP-06 | minimise Σ a_i/x_i, a = [1, 4, 9, 16], Σ x = 2 (OC with p = 1) | x = [0.2, 0.4, 0.6, 0.8], objective 50 | 1e-6 | (b) Lagrange | A | unit |
| VC-TOP-04 | FR-TOP-03 | 30×10 MBB, uniform x = 1 and x = 0.5 | c(1) = 123.069351174; c(0.5)/c(1) = 7.99999994398 = 1/(Emin + 0.5³(1 − Emin)) | 1e-9 / 1e-8 rel | (b) exact solve | A | unit |
| VC-TOP-10 | FR-TOP-02, 03, 08, 09 | `plans/top_mbb_60x20.plan.json`, sensitivity filter | compliance at last iteration 203.192457639 (topoptlab 203.19245763914194); final-design compliance 203.182593258; volume 0.499970090278 (topoptlab 0.49997009027820527); iterations 94; grey 0.174175545817 | 1e-6 rel; 1e-6; 1e-3 abs; ±2 (bridge) / exact (TS reference); 1e-4 abs | (b) + S3 run | A (b, d), B (a, c, e) | unit (TS reference) + integration (bridge) + quality |
| VC-TOP-11 | same | `plans/top_mbb_60x20_density.plan.json`, density filter | compliance at last iteration 218.803221064 (topoptlab 218.80322107077228); final-design 218.815227557; volume 0.499980636009; iterations 127; grey 0.268323476248 | as VC-TOP-10 | (b) + S3 run | A (b), B (rest) | same |
| VC-TOP-12 | FR-TOP-02; budgets | 300×100 MBB | **TBD — measure** with the bridge op (too large for the stdlib generator) | — | TBD | TBD | integration |
| VC-TOP-20 | FR-TOP-07 | `move_entities` on the derived mesh | `TOP_DERIVED_READ_ONLY`, doc unchanged | exact | — | A | unit |
| VC-TOP-21 | FR-TOP-14 | solved study, then `set_parameter` changing the domain | `TOP_RESULT_STALE` from `check_topology` and `suggest_rebuild` | exact | — | A | golden |
| VC-TOP-22 | FR-TOP-10 | `suggest_rebuild` on VC-TOP-10 | closed loops; enclosed fraction within 0.02 of the thresholded fraction | 0.02 | (b) | A | unit |
| VC-TOP-23 | FR-TOP-11 | rebuild from VC-TOP-22 loops (`extrude_profile` + `boolean subtract`) | IoU and volume ratio **TBD — measure**; target IoU ≥ 0.85 to calibrate | — | TBD | TBD | integration |
| VC-TOP-24 | FR-TOP-06 | `plans/top_rejection_keepin_budget.plan.json` | `TOP_KEEPIN_EXCEEDS_BUDGET` | exact | — | A | unit + CLI |
| VC-TOP-25 | FR-TOP-16 | E from an 08 `typical` value | `unverified: true`; `TOP_INPUT_UNVERIFIED` | exact | — | A | unit |
| VC-TOP-26 | FR-TOP-15; TR-TOP-12 | 09 release including the derived mesh | `TOP_RESULT_NOT_RELEASABLE` | exact | — | A | unit |
| VC-TOP-27 | FR-TOP-18 | two identical solves | identical fieldHash and report | exact | — | A | integration |

Note on the reference problem: the MBB setup is the top88 default call `top88(60, 20, 0.5, 3, 1.5, ft)` as transcribed
by topoptlab (`mbb_2d`: unit load at DOF 2, ux = 0 on the left edge, uy = 0 at the last DOF). The paper's own printed
results were not reachable (open question 4 of TECHNICAL_SPEC).

## How the cross-check was run (not part of the generator)

On 2026-10-15, in an isolated scratch directory: topoptlab 1.0.0 sdist (sha256 `4978a92a…090e`), NumPy 2.5.3 and the
SciPy 1.18.1 wheel; optional imports that MBB does not use (matplotlib, mmapy, cvxopt, pyamg, gmsh, meshio, symfem,
sympy) were stubbed; called `main(nelx=60, nely=20, volfrac=0.5, rmin=1.5, ft=0|1, optimizer="oc", bcs=mbb_2d)` and
read the returned objective. topoptlab's `ft=0` is the sensitivity filter and `ft=1` the density filter (its own
numbering differs from top88's 1/2).

## Requirement coverage supplement

| Requirement | Proved by |
| ----------- | --------- |
| FR-TOP-01, TR-TOP-01 (study as document data, replay) | **VC-TOP-28**: run `plans/top_mbb_60x20.plan.json`, save, load, `replay_history` → `topology` slice deep-equal, ids `ts-<step>.<k>` identical; `is pure` per command |
| FR-TOP-12 (check_topology) | VC-TOP-21, 23, 24, 25 (codes); **VC-TOP-29**: solved study without rebuild → `TOP_REBUILD_MISSING` warning |
| FR-TOP-13 (symmetry) | **VC-TOP-30**: full 120×20 MBB (central load, two end supports) with a YZ symmetry plane → xPhys mirror-symmetric to 1e-12 and compliance within 1 % of 2 × VC-TOP-10.b (not exact: the filter crosses the symmetry line in the full model but is truncated at the boundary of the half model); TBD measure, grade B until then |
| FR-TOP-17 (named defaults) | VC-TOP-10 (`settings` each `{value, source, defaulted}`) |
| FR-TOP-19 (progress / resume / cache) | VC-TOP-27 + **VC-TOP-31**: resume from iterate 50 gives the same final field as an uninterrupted run |
| FR-TOP-20 (codes) | VC-TOP-20, 21, 24, 25, 26 |
| FR-TOP-21 (render) | manual review (UI) |
| FR-TOP-22…24 (V1/V2) | deferred; VCs added with the milestone |
| TR-TOP-02 (grid / masks) | VC-TOP-24, 28 |
| TR-TOP-03, 04 (bridge op, solver) | VC-TOP-10, 11 (integration) |
| TR-TOP-07 (artifact + validated record) | **VC-TOP-32**: `record_topology_result` with absent hash / edited summary / genuine → `TOP_ARTIFACT_NOT_FOUND`, `TOP_SUMMARY_MISMATCH`, accepted |
| TR-TOP-08 (derived mesh) | VC-TOP-20, 27 |
| TR-TOP-09 (contours) | VC-TOP-22 |
| TR-TOP-10 (compare) | VC-TOP-23 |
| TR-TOP-11 (agent-first contract) | VC-TOP-25, 26 |
| TR-TOP-13 (shape optimisation, V1) | deferred |

## CLI harness (AF-23)

```bash
D="--doc topo.llull.json --kernel occt --json"
ts=$(llull run plans/top_mbb_60x20.plan.json $D | jq -r '.data.aliases.ts[0]')
llull topology_solve studyId=$ts $D --timeout 600 > solve.json
llull topology_report studyId=$ts $D > report.json        # VC-TOP-10 via compare_to_expected (PHY-00)
llull check_topology studyId=$ts $D > check.json          # REBUILD_MISSING expected at this point
llull run plans/top_rejection_keepin_budget.plan.json $D  # VC-TOP-24 code in the failing step's error
```

## Re-generating

```bash
cd docs/physics/17-topology-optimization/validation
python3 -I generate_top_reference.py
git diff --stat .           # must be empty unless the generator changed
```
