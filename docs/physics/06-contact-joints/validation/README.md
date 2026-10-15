# PHY-06 CNT: validation pack

Proves `../FUNCTIONAL_SPEC.md` (`FR-CNT-*`) and `../TECHNICAL_SPEC.md` (`TR-CNT-*`). Values are (a) quoted from
[`sources.md`](sources.md), (b) derived by [`generate_cnt_reference.py`](generate_cnt_reference.py) (stdlib only;
`python3 -I generate_cnt_reference.py`; byte-identical on re-run), or (c) TBD with the measuring tool. Tolerances are llull
acceptance choices.

## Files

| File | Kind | Content |
| ---- | ---- | ------- |
| `generate_cnt_reference.py` | generator | Writes the files below |
| `expected_results.json` | (a)+(b) | Cases in the physics README §6.3 schema |
| `hertz_line_ssnp154.csv` | (b) | Hertz pressure profile for SSNP154 (x from 0 to b) |
| `hertz_subsurface.csv` | (b, formulas unverified) | Axis stresses / p0 below sphere and line contacts, ζ = 0.1 … 3 |
| `bolted_joint_nasa5020.json` | (b) | NASA-STD-5020 (2012) worked example: inputs (test values), every intermediate, equation numbers |
| `plans/cnt_ssnp154_cylinder_block.plan.json` | draft plan | Half cylinder on block, 1 mm plane-strain slice, surface-to-surface contact, 35 000 N |
| `plans/cnt_pretension_bar.plan.json` | draft plan | Bar fixed at both ends, pretension section 10 kN |
| `plans/cnt_bolted_joint_check.query.json` | draft query | Input of `bolted_joint_check` matching `bolted_joint_nasa5020.json` |

## Real use cases

| # | Use case | Evidence | Cases |
| - | -------- | -------- | ----- |
| U1 | Separation and slip of preloaded spaceflight joints | NASA-STD-5020 §4.3, §6.4, §6.5 require them (S5) | VC-CNT-40 |
| U2 | Roller / ball contact stress | NAFEMS cylinder-roller benchmark as reproduced by code_aster SSNP154 (S2); SSNV104 (S3) | VC-CNT-10, 11 |
| U3 | Shrink-fit bushings | Lamé (derived) | VC-CNT-20 |
| U4 | Preloaded bolt in FE | CalculiX `*PRE-TENSION SECTION` (S1) | VC-CNT-50, 51 |

## Validation cases

| VC | Proves | Set-up | Expected | Tol. | Grade / source | Gate |
| -- | ------ | ------ | -------- | ---- | -------------- | ---- |
| VC-CNT-01 | FR-CNT-01, 03; TR-CNT-01 | each plan: run, save, load, replay | contact slice deep-equal; ids step-scoped; `is pure` | exact | — | unit + golden |
| VC-CNT-10.a | FR-CNT-01, 08; TR-CNT-20 | `hertz_contact` (1e-9 vs generator) and `plans/cnt_ssnp154_cylinder_block.plan.json` → `contact_report` | half-width b = **6.21462786687 mm** (SSNP154 prints 6.21) | 2 % FE | A: S2 + generator | unit / integration |
| VC-CNT-10.b | FR-CNT-01, 08 | same | p0 = **3585.36223088 MPa** (SSNP154 3585.37) | 2 % FE | A: S2 + generator | unit / integration |
| VC-CNT-11.a–c | FR-CNT-01, 08 | `hertz_contact sphere_sphere approach 4 mm`; FE sphere model (V1 plan) | p0 = **2798.32866975 MPa** (SSNV104 2798.3), a = 10 mm, P = 586 080.586 N | 1e-9 analytic; FE 5 % (quadratic elements; code_aster's linear run is 13.5 % off) | A: S3 + generator | unit / integration |
| VC-CNT-12 | FR-CNT-08 | `hertz_contact sphere_plane`, R 10 mm, 1000 N, steel | a = 0.402072575859 mm, p0 = 2953.469 MPa | 1e-9 | A (generator) | unit |
| VC-CNT-13.a, b | FR-CNT-08 | subsurface max shear | sphere τmax/p0 = 0.3100 at z = 0.481a (ν 0.3); line τmax/p0 = 0.3003 at z = 0.786b | 1 % | B (formulas from Johnson 1985, not fetched) | unit |
| VC-CNT-20.a, b | FR-CNT-01, 09 | `interference_fit` + FE (solid shaft r 20, hub r_o 40, δr 0.01 mm, steel, plane stress) | p = 39.375 MPa; hub bore hoop 65.625 MPa | 1e-9 analytic; 2 % / 3 % FE | A (generator, Lamé) | unit / integration |
| VC-CNT-30.a | FR-CNT-02 | friction block, tangential displacement control, μ 0.2, N 1000 N | tangential force plateau 200 N | 2 % | A (Coulomb) | integration |
| VC-CNT-40.a–f | FR-CNT-05, 06, 12 | `plans/cnt_bolted_joint_check.query.json` | Pp-min(sep) 5329.72440945 N; Pp-min(slip) 6662.15551181 N; Pp-max 10334.6456693 N; MS_sep 1.22071850394; MS_slip 0.168799212598; P′sep 11811.023622 N | 1e-9 | A (S5 equations, generator) | unit |
| VC-CNT-40.g | FR-CNT-06, 14 | same with μ 0.3, uncoated metal, no test record | `fail`, `CNT_FRICTION_ABOVE_CAP` | exact | A (S5 §6.4) | unit |
| VC-CNT-40.h | FR-CNT-05, 14 | same without `gamma` | Γ 0.25 returned `defaulted: true`, source "NASA-STD-5020 6.1.d(1)A"; with `lubricated: false` 0.35 | exact | A (S5) | unit |
| VC-CNT-40.i | FR-CNT-05 | same with `separationCritical: true`, no Γ | exit 1, `CNT_GAMMA_TEST_DATA_REQUIRED` | exact | A (S5 §6.1.c) | unit |
| VC-CNT-50 | FR-CNT-01, 03; TR-CNT-10 | pinned ccx decks `pret1`, `pret2`, `bolt`, `contact1`, `friction1`, `hueeber1_mortar`, run + parse | equal to `.dat.ref` | 1e-4 | TBD (extract with the M2 reader, freeze) | integration |
| VC-CNT-51 | FR-CNT-03, 04 | `plans/cnt_pretension_bar.plan.json` | bolt force 10 000 N after preload; each end reaction 10 000 N | 0.5 % | A (exact by MPC construction, S1) | integration |
| VC-CNT-52 | FR-CNT-04, 07 | V1 flange plan (two plates, bolt, head / nut contact) | separation load and nφ: TBD — measure, then compare with `bolted_joint_check` P′sep | — | TBD | integration |
| VC-CNT-60 | FR-CNT-01, 13 | two pairs, different formulations | `CNT_MIXED_CONTACT_TYPES` | exact | A (S1) | unit |
| VC-CNT-61 | FR-CNT-02, 14 | friction without stick slope | `stickSlope` returned `{ value: E1/2, source: "CalculiX *FRICTION default", defaulted: true }` | exact | A (S1) | unit |
| VC-CNT-62 | FR-CNT-15 | any query | `reviewRequired: true`, "not approved" | exact | A (AF-33) | unit |
| VC-CNT-63 | FR-CNT-16 | nut factor `tested: false` | `unverified: true` on all margins | exact | A (AF-32) | unit |
| VC-CNT-64 | FR-CNT-10, 11 | V1 `joint_from_fastener_stack` on the 08 sample stack; pin-in-hole template | TBD — pairs and pretension created as listed; bearing pressure measured | — | TBD | integration |
| VC-CNT-65 | FR-CNT-17, 18 | `check_contact` on wrong set-ups (overclosure, contact-only restraint, tied with node-to-surface) | `CNT_INITIAL_OVERCLOSURE`, `CNT_RIGID_BODY_BY_CONTACT_ONLY`, `CNT_BEHAVIOUR_FORMULATION_MISMATCH` | exact | A (spec) | unit |

## CLI harness (AF-23)

```bash
D="--doc case.llull.json --kernel occt --json"
llull bolted_joint_check "$(cat plans/cnt_bolted_joint_check.query.json)" --json > joint.json   # VC-CNT-40
an=$(llull run plans/cnt_ssnp154_cylinder_block.plan.json $D | jq -r '.data.aliases.an[0]')
llull fea_mesh analysisId=$an $D --timeout 600 && llull check_contact analysisId=$an $D
llull fea_solve analysisId=$an $D --timeout 1800 --progress
llull contact_report analysisId=$an pair=roller_block $D > contact.json                        # VC-CNT-10
# judge with PHY-00 compare_to_expected / run_benchmarks
```

## Re-generating

```bash
cd docs/physics/06-contact-joints/validation && python3 -I generate_cnt_reference.py && git diff --stat .
```
