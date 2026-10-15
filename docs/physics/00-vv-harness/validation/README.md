# PHY-00 VNV: validation pack

This pack proves a future implementation of the physics V&V harness described in `../FUNCTIONAL_SPEC.md`
(`FR-VNV-*`) and `../TECHNICAL_SPEC.md` (`TR-VNV-*`). Every expected value is one of:

- **(a) Quoted** from a source in [`sources.md`](sources.md) (here: two open GCI implementations that publish worked
  numbers).
- **(b) Derived** by [`generate_vnv_reference.py`](generate_vnv_reference.py) from a cited formula. Python standard
  library only, deterministic: `python3 -I generate_vnv_reference.py` (run twice on 2026-10-15, byte-identical output).
- **(c) TBD**, with the tool that will measure it.

Grades follow `../../README.md` §6.3: **A** = exact derivation in the generator and/or ≥ 2 independent sources,
**B** = one secondary source, **C / TBD** = not a gate. Tolerances are llull acceptance choices.

## Files

| File | Kind | Content |
| ---- | ---- | ------- |
| `generate_vnv_reference.py` | generator | Writes the three files below. |
| `expected_results.json` | (b) + (a) | VC-VNV-01…11 in the README §6.3 schema; quoted numbers are kept next to the derived ones as `quotedBySource`. |
| `mms_poisson_1d.csv` | (b) | Method-of-manufactured-solutions error table: 1D Poisson, P1 elements, n = 4…64, L2 / H1 errors and observed orders. |
| `runner_fixtures.json` | (b) | RF-01…RF-08: measured vs expected pairs that pin the judge's verdicts and codes (pass, fail, warn on grade B, skip on TBD, unit conversion, unit mismatch, missing result). |
| `plans/vnv_check_convergence_examples.plan.json` | draft plan | Four `check_convergence` calls (NPARC example, oscillatory, gcat example with formal order 2, a refused two-sample call). Uses the **proposed** command of TECHNICAL_SPEC §4. |
| `plans/vnv_beamp_convergence.plan.json` | draft plan | The 05 FEA beamp cantilever plan with `set_parameter mesh_h` driving `set_mesh_controls.globalSize = "=mesh_h"` (parameter-driven refinement, an alternative to `run_convergence_study`). Uses the proposed 05 / 08 commands. |
| `sources.md` | register | Every source, how it was accessed and what was verified. |

No third-party file is stored here. `convergence` is GPL-3.0: only its published numbers are quoted, no code copied.

## Real use cases

| # | Use case | Who | Evidence | Cases |
| - | -------- | --- | -------- | ----- |
| U1 | Report the discretization error of a CFD/heat-transfer result for journal publication | Analysts publishing in ASME JFE | Celik et al. 2008 is the journal's procedure [S2]; implemented by gcat [S4] and `convergence` [S5] | VC-VNV-01…06 |
| U2 | Prove a stress or deflection is mesh-converged before it supports a margin | Stress engineers (05 FEA users) | V&V 10 distinguishes solution verification from code verification [S7] | VC-VNV-10, 13 |
| U3 | Catch a solver or mesher regression after an upgrade | llull maintainers, CI | Same role as the STEP quality gate (`docs/QUALITY_GATES.md`) | VC-VNV-12, all packs |
| U4 | Detect an order-reducing coding error in a new solver path | Developers of PHY packs | MMS finds any error that changes the order of accuracy [S6] | VC-VNV-07 |

## Validation cases

Status **P** (proposed). Values: `expected_results.json` (12 significant digits).

| VC | Proves | Setup | Expected | Tolerance | Source | Grade | Gate |
| -- | ------ | ----- | -------- | --------- | ------ | ----- | ---- |
| VC-VNV-01 | FR-VNV-01, 02; TR-VNV-03 | `check_convergence` on h = 1, 2, 4; f = 0.9705, 0.96854, 0.96178 (NPARC example) | p = 1.78616959217; f_ext = 0.971300333333; GCI21 = 0.00103082603469; GCI32 = 0.00356249268659; AR = 0.997980422463. `convergence` README prints 1.786170 / 0.971300 / 0.001031 / 0.003562 / 0.997980 (and 0.997980422462648 to full precision) | 1e-9 rel vs generator | (b) + S5 | A | unit |
| VC-VNV-02 | FR-VNV-01, 02 | f = 10 + 0.5 h², h = 0.1 / 0.2 / 0.4 | p = 2, f_ext = 10, GCI21 = 6.24687656172e-4 | 1e-9 | (b) exact | A | unit |
| VC-VNV-03 | FR-VNV-01; TR-VNV-03 | same law, h = 0.1 / 0.15 / 0.3 (r21 = 1.5, r32 = 2) | p = 2, f_ext = 10 (iteration with q(p)) | 1e-9 abs | (b) exact | A | unit |
| VC-VNV-04 | FR-VNV-03; TR-VNV-04 | f = 1.00 / 1.02 / 0.99 | `oscillatory`, `VNV_OSCILLATORY`, no extrapolation | exact | (b) | A | unit |
| VC-VNV-05 | FR-VNV-03 | f = 1.00 / 1.10 / 1.15 | `divergent`, `VNV_DIVERGENT` | exact | (b) | A | unit |
| VC-VNV-06 | FR-VNV-01, 02, 04 | gcat README: h = 8.30 / 10.84 / 14.14, f = 1 / 1.02 / 1.08, `formalOrder = 2` | p = 4.14323863221 (gcat 4.143231), GCI21 fine 0.0123589345715 (gcat 1.235897e-2), coarse 0.0373589345715, GCI32 0.0366264064427, AR 1.02 (gcat 1.019998); warning `VNV_ORDER_MISMATCH` | 1e-5 rel (gcat iterates to 1e-5) | (b) + S4 | A | unit |
| VC-VNV-07 | FR-VNV-05; TR-VNV-06 | MMS: −u'' = π² sin πx on (0,1), P1, exact load; `mms_poisson_1d.csv` | L2(n=64) = 1.5552898473e-4; observed L2 order 1.99977 (→ 2); H1 order 0.99983 (→ 1); nodal error 0 (≤ 2e-14 measured) | 1e-6 rel; ±0.01; ±0.01; 1e-12 abs | (b) | A | unit / quality |
| VC-VNV-08 | FR-VNV-06 | GCI* = 0.1, GCI21 = 0.4, p = 2, h1 = 4 | h* = 2 (also the `convergence` unit test) | 1e-10 | (b) + S5 | A | unit |
| VC-VNV-09 | TR-VNV-02 | (a) 3D N = 1000, V = 1; (b) 2D N = 2900, A = 0.2 m² | (a) 0.1; (b) 8.30454798537 mm (gcat `check` prints 8.304548 mm) | 1e-12 / 1e-6 rel | (b) + S4 | A | unit |
| VC-VNV-10 | FR-VNV-07, 09 | 05 beamp (VC-FEA-10) with `run_convergence_study levels=3 ratio=2` from globalSize 0.25 | p, f_ext, GCI: **TBD — measure**; f_ext within 2 % of 0.0888411 mm (05 VC-FEA-10.b, EB + shear) | 2 % | TBD | TBD | integration |
| VC-VNV-11 | FR-VNV-07, 09 | NAFEMS LE10 (05 VC-FEA-31) tet10, 3 levels | p and GCI **TBD — measure**; f_ext within 3 % of −5.38 MPa | 3 % | TBD | TBD | integration |
| VC-VNV-12 | FR-VNV-10, 11 | `compare_to_expected` on `runner_fixtures.json` RF-01…08 | verdicts pass, fail, pass, warn, skip, pass (Pa→MPa), error (`VNV_UNIT_MISMATCH`), error (`VNV_RESULT_MISSING`) | exact | (b) | A | unit |
| VC-VNV-13 | FR-VNV-13 | VC-VNV-10, then `set_parameter L=10` (05 parametrised beamp) | `check_verification` → `VNV_STUDY_STALE` | exact | — | A | golden |
| VC-VNV-14 | FR-VNV-14; TR-VNV-12 | agent calls `accept_verification_exception` without signature | exit 1, `VNV_HUMAN_GATE`, document hash unchanged | exact | — | A | unit + CLI |
| VC-VNV-15 | FR-VNV-14 | study over a result whose material is 08 `unverified` | study `unverified: true`; `VNV_INPUT_UNVERIFIED`; `reviewRequired: true` | exact | — | A | unit |
| VC-VNV-16 | TR-VNV-09 | `record_convergence_study` with (i) a hash absent from the store, (ii) an edited value, (iii) genuine | (i) `VNV_ARTIFACT_NOT_FOUND`, (ii) `VNV_SUMMARY_MISMATCH`, (iii) accepted | exact | — | A | unit (fake port) |
| VC-VNV-17 | TR-VNV-10 | run VC-VNV-10 twice | identical study JSON and report hash | exact | — | A | integration |
| VC-VNV-18 | FR-VNV-16 | deliberately wrong inputs: 1 sample; duplicate h; h = 0; NaN value; 2 samples without `assumedOrder`; malformed expected case; unit mismatch | each returns the §7.1 code, path and remediation | exact | TECHNICAL_SPEC §7.1 | A | unit + CLI |

## CLI harness (AF-23)

```bash
D="--doc case.llull.json --kernel occt --json"
llull run plans/vnv_check_convergence_examples.plan.json $D > ex.json     # step data[] (AF-14) vs VC-VNV-01/04/06
an=$(llull run ../../../aerospace/05-fea-cae-handoff/validation/plans/fea_cantilever_static_beamp.plan.json $D \
     | jq -r '.data.aliases.an[0]')
llull run_convergence_study analysisId=$an quantity=probe:tip:u_y levels=3 ratio=2 $D --timeout 1800 > study.json
llull check_verification analysisId=$an gciTarget=0.01 $D > verify.json
llull run_benchmarks packs=00-vv-harness --save out/bench.json --json     # judges every case of this file
```

## Re-generating

```bash
cd docs/physics/00-vv-harness/validation
python3 -I generate_vnv_reference.py      # rewrites expected_results.json, mms_poisson_1d.csv, runner_fixtures.json
git diff --stat .                         # must be empty unless the generator changed
```
