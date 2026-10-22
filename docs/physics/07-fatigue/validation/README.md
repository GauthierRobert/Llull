# PHY-07 FAT: validation pack

Proves a future implementation of [`../FUNCTIONAL_SPEC.md`](../FUNCTIONAL_SPEC.md) (`FR-FAT-*`) and
[`../TECHNICAL_SPEC.md`](../TECHNICAL_SPEC.md) (`TR-FAT-*`). Every expected value is (a) quoted from
[`sources.md`](sources.md), (b) derived by [`generate_fatigue_reference.py`](generate_fatigue_reference.py) (Python 3
standard library only, `python3 -I generate_fatigue_reference.py`, byte-identical on re-run), or (c) `TBD` with the tool
to measure it. Tolerances are llull acceptance choices.

Material parameters in the cases are **test inputs**, not material claims. The strain-life set (σ'f 1160 MPa, b −0.081,
ε'f 1.1, c −0.65, E 210 GPa, K' 1060 MPa, n' 0.14) is the textbook set used by S5 Example 1, which gives an independent
implementation to compare with.

## Files

| File | Kind | Content |
| ---- | ---- | ------- |
| `generate_fatigue_reference.py` | generator | Writes the four files below; asserts that its rainflow output equals the counts quoted by S2 and S3 |
| `expected_results.json` | (b) + (a) | VC-FAT cases in the README §6.3 schema (`pack`, `generatedBy`, `cases[] {id, quantity, value, unit, tolerance, source, grade, proves}`) plus `inputs`, `derivation`, `cross_check` |
| `rainflow_e1049.json` | (a) + (b) | E1049 history, three-point cycles, repeating-history cycles, four-point full cycles and residue, pinned source commits |
| `strain_life_table.csv` | (b) | 2Nf and Nf for εa = 0.002 … 0.02 (test set) |
| `mean_stress_table.csv` | (b) | σar for six mean-stress models, σa = 200 MPa, σm = −100 … 200 MPa (raw formulas; the command's `compressiveMean: no_benefit` rule replaces σm < 0 rows for Goodman/Gerber/Soderberg/Morrow by σa) |
| `plans/*.plan.json` | draft plans | `build_project` steps using existing commands (`set_units`, `add_box`, `add_cylinder`, `boolean`, `create_material`, `assign_material`), proposed aerospace 08 / 05 commands, the **proposed PHY-02** `add_material_model` (name to be fixed by PHY-02) and this pack's commands. Drafts until those exist |

## Real use cases

| # | Use case | Evidence | Cases |
| - | -------- | -------- | ----- |
| U1 | Fatigue evaluation of airframe structure | 14 CFR 25.571(a) requires showing catastrophic fatigue failure is avoided over the operational life [S12]; AC 25.571-1D is the guidance [S13] | VC-FAT-40…50 |
| U2 | Safe-life part with scatter factor | CS 25.571: replacement time ≤ test life / applicable scatter factor [S14] | VC-FAT-50, 60 |
| U3 | Counting a measured or flight-load history | ASTM E1049 [S1]; two open implementations agree on its example [S2, S3] | VC-FAT-01…04 |
| U4 | Notch low-cycle fatigue (lug, fillet) | Neuber + strain-life practice, reproduced by S5 | VC-FAT-20…24 |

## Validation cases

Gate column: **unit** = TS unit test, no external process; **integration** = needs 05 `llull-mesh` + CalculiX; **golden** = plan
snapshot. Grade from `expected_results.json`; only grade A cases are pass/fail gates.

| VC | Proves | Setup | Expected | Tol. | Grade | Gate |
| -- | ------ | ----- | -------- | ---- | ----- | ---- |
| VC-FAT-01 | FR-FAT-05; TR-FAT-20 | `count_cycles` on `[-2,1,-3,5,-1,3,-4,4,-2]`, 3-point | `[[3,0.5],[4,1.5],[6,0.5],[8,1],[9,0.5]]` | exact | A | unit |
| VC-FAT-02 | FR-FAT-05; TR-FAT-21 | 4-point on the negated history | one full cycle (1, −3, range 4); residue `[2,-1,3,-5,4,-4,2]`; full + residue half cycles = VC-FAT-01 totals | exact | B | unit |
| VC-FAT-03 | FR-FAT-05; TR-FAT-20 | repeating history | `[[3,1],[4,1],[7,1],[9,1]]` | exact | B | unit |
| VC-FAT-04 | FR-FAT-05 | S2 TEST_CASE_2 history | totals of S2 (10 ranges) | exact | B | unit |
| VC-FAT-10 | FR-FAT-01; TR-FAT-10 | Basquin σa = 400 MPa | 2Nf = 511 231.091036 | 1e-9 rel | A | unit |
| VC-FAT-11 | FR-FAT-01 | power law k 5, N_D 1e6, S_D 200, S = 300 MPa | N = 131 687.242798 | 1e-9 rel | A | unit |
| VC-FAT-12 | FR-FAT-02; TR-FAT-11 | CMB εa = 0.0075 | 2Nf = 4414.93208801 | 1e-6 rel | A | unit |
| VC-FAT-13 | FR-FAT-02 | transition life | 2Nt = 10 982.2778343 | 1e-9 rel | A | unit |
| VC-FAT-14 | FR-FAT-04 | Morrow εa 0.005, σm 100 MPa | 2Nf = 10 840.857018 | 1e-6 rel | A | unit |
| VC-FAT-20 | FR-FAT-03; TR-FAT-12 | Kt 2.41, q 0.9857 | Kf = 2.389837 | 1e-12 rel | A | unit |
| VC-FAT-21 | FR-FAT-03 | Neuber, Kf·S = 896.189 MPa, cyclic RO | σmax = 506.729085988 MPa (S5: 506.7291) | 1e-6 rel | A | unit |
| VC-FAT-22 | FR-FAT-02, 04 | SWT with σmax, εmax of VC-FAT-21 | 2919.91137196 cycles (S5: 2919.91) | 1e-4 rel | A | unit |
| VC-FAT-23 | FR-FAT-03 | q Peterson a = 0.25, Neuber ρ' = 0.25, r = 1 mm | 0.8 / 0.666666666667 | 1e-12 | A | unit |
| VC-FAT-24 | FR-FAT-03 | Masing Δσ = 800 MPa | Δε = 0.0057055537097 | 1e-12 rel | A | unit |
| VC-FAT-30 | FR-FAT-04; TR-FAT-13 | σa 200, σm 100, Su 500, Sy 400, σ'f 1160 MPa, γ 0.7 | Goodman 250, Gerber 208.333, Soderberg 266.667, Morrow 218.868, SWT 244.949, Walker 225.869 MPa | 1e-12 rel | A | unit |
| VC-FAT-40 | FR-FAT-06; TR-FAT-14 | `plans/fat_history_only_miner.plan.json` | D per block = 1.23426341718e-5 | 1e-9 rel | A | unit + golden |
| VC-FAT-41 | FR-FAT-06 | same | 81 019.9821 blocks | 1e-9 rel | A | unit |
| VC-FAT-42 | FR-FAT-07; TR-FAT-15 | `plans/fat_plate_hole_spectrum.plan.json`, mesh + solve (05) | hot spot at (0, 10) mm; local max-principal history `[-60, 30, -90, 150, -30, 90, -120, 120, -60]` MPa | 5 % (FE Kt vs 3) | A (analytic) | integration |
| VC-FAT-43 | FR-FAT-07; TR-FAT-15, 41 | native vs reference ([RS1](../../../decisions/RS1-native-compute.md) RS-7, planned): `fatigue_field` (`llull-compute post`) against the TS path with pre-selection off (all nodes) on the VC-FAT-42 mesh; then a 50k-node case for wall time | identical cycles per node; same damage, life and hot-spot ranking; wall time recorded (TBD — measure) | rainflow exact (on input values, as TR-FAT-20); damage and life 1e-12 rel (llull choice: same formulas in f64, only summation order may differ) | — (comparison, not in `expected_results.json`) | integration |
| VC-FAT-50 | FR-FAT-08, 09; TR-FAT-16 | VC-FAT-40 with N_req 1000 blocks, SF 3 | margin = 26.0066607091; `factors.scatter.defaulted: false` | 1e-9 abs | A | unit |
| VC-FAT-60 | FR-FAT-09…13; TR-FAT-30 | (i) no SF; (ii) agent dispose; (iii) `typical` curve; (iv) param change after a run; (v) any run | (i) `FAT_SCATTER_FACTOR_UNSET`; (ii) `FAT_HUMAN_GATE`, doc unchanged; (iii) `unverified` + `FAT_CURVE_UNVERIFIED`; (iv) `FAT_RESULTS_STALE`; (v) `reviewRequired: true`, summary "not approved" | exact | A | unit + CLI |
| VC-FAT-15 | FR-FAT-20; TR-FAT-10 | Basquin at 400 MPa, surface modifier 0.8 (justified) | 2Nf = 32 523.5051309; modifier listed in `factors.modifiers` | 1e-9 rel | A | unit |
| VC-FAT-61 | FR-FAT-14, 15 | (i) Basquin at 100 MPa with `testedLifeRange.maxCycles` 1e7; (ii) amplitude 1500 MPa with Ftu 1400 MPa | (i) 2Nf = 1.38502195292e13, `extrapolated: true`, warning `FAT_CURVE_EXTRAPOLATED`; (ii) row `FAT_STATIC_FAILURE`, no life | 1e-9 rel / exact | A | unit |
| VC-FAT-62 | FR-FAT-16 | deliberately wrong plans: history with 1 value, unknown unit, missing model, scatter 0.5, modifier without justification, delete history in use | `FAT_HISTORY_INVALID`, `FAT_HISTORY_INVALID`, `FAT_CURVE_MISSING`, `FAT_FACTOR_INVALID`, `FAT_FACTOR_INVALID`, `FAT_HISTORY_IN_USE`; each with `remediation` and ids/path; `describe` shows units on every numeric param | exact | A | unit + CLI |
| VC-FAT-63 | FR-FAT-17; TR-FAT-40 | `export_stress_spectrum` of the VC-FAT-42 hot spot `--save h1.csv` | CSV parses back to the VC-FAT-42 history with unit header `MPa`; refused when stale | exact | A | integration |
| VC-FAT-64 | FR-FAT-18, 19 | `fatigue_life … samples=true`; `define_load_history` from a CSV of the E1049 history | curve samples satisfy the Basquin equation to 1e-12; imported history equals the series; `count_cycles` = VC-FAT-01 | exact | A | unit |
| VC-FAT-65 | FR-FAT-23, 24 | same plan via CLI, MCP `build_project`, UI dispatch; a curve from a `storage: private` library | identical document hash and `compute_fatigue` data; saved file has no curve values; cloud MCP returns `FAT_CURVE_UNAVAILABLE` | exact | A | integration (server) |
| VC-FAT-70 | FR-FAT-21 | spectral fatigue from a PHY-09 PSD | TBD — reproduce a published Dirlik example (not yet sourced) | — | TBD | deferred |
| VC-FAT-71 | FR-FAT-22 | critical plane | TBD — source a published multiaxial benchmark | — | TBD | deferred |

## CLI harness (AF-23)

```bash
D="--doc case.llull.json --json"
llull run plans/fat_e1049_rainflow.plan.json $D > rf.json            # data.steps[1].data.totals vs VC-FAT-01
llull run plans/fat_notch_swt_s5.plan.json $D > notch.json            # steps[-3].data.cycles vs VC-FAT-22
fc=$(llull run plans/fat_history_only_miner.plan.json $D | jq -r '.data.aliases.fc[0]')   # AF-14 aliases
llull compute_fatigue caseId=$fc $D > fat.json                        # rows[0].damagePerBlock vs VC-FAT-40
python3 -I compare.py fat.json expected_results.json VC-FAT-40        # PHY-00 harness comparator
```

## Re-generating

```bash
cd docs/physics/07-fatigue/validation
python3 -I generate_fatigue_reference.py && python3 -I generate_fatigue_reference.py
git diff --stat .        # must be empty unless the generator changed
```
