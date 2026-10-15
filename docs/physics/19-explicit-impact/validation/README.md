# PHY-19 EXP: validation pack

This pack proves a future implementation of the explicit-dynamics hand-off described in
[`../FUNCTIONAL_SPEC.md`](../FUNCTIONAL_SPEC.md) (`FR-EXP-*`) and [`../TECHNICAL_SPEC.md`](../TECHNICAL_SPEC.md)
(`TR-EXP-*`). Every expected value is one of:

- **(a) Quoted** from a source in [`sources.md`](sources.md).
- **(b) Derived** by [`generate_explicit_reference.py`](generate_explicit_reference.py) (standard library only,
  deterministic; `python3 -I generate_explicit_reference.py` run twice gives byte-identical files, checked 2026-10-15).
- **(c) Extracted** from a pinned public file, or **TBD** with the tool that will measure it.

Tolerances are **llull acceptance choices**. Material numbers are **test inputs** unless a source id is given; the only
quoted material set (Ti-6Al-4V Johnson–Cook strength, [S9]) is **grade B** and therefore reported, never a pass/fail gate.
No OpenCourant QA deck is copied: they are © Siemens under CC BY-NC 4.0 ([S1]); the listing fixture here is synthetic.

## Files

| File | Kind | Content |
| ---- | ---- | ------- |
| `generate_explicit_reference.py` | generator | Writes the files below. |
| `expected_results.json` | (b) | VC values in the README §6.3 schema plus `derivation`, `inputs`. |
| `wave_speed_cfl.csv` | (b) | c_bar, c_dil and dt_crit = L_e/c_dil for three test materials and L_e = 0.5 … 10 mm. |
| `bar_impact_history.csv` | (b) | Ideal 1D square-wave stress at the wall and at mid-length for the bar of VC-EXP-12. |
| `johnson_cook_curves.csv` | (b) | J–C flow stress vs plastic strain at 1, 1e3 and 1e5 s⁻¹ with the grade-B Ti-6Al-4V set. |
| `energy_balance_sample.csv` | fixture | Synthetic energy history (kinetic, internal, hourglass, contact, external work, added mass) for the energy checker. |
| `engine_listing_sample.txt` | fixture | Synthetic Engine listing in the documented column layout, ending with `NORMAL TERMINATION`. |
| `solver_format_reference.json` | (a)/(c) | OpenCourant commit, licence, provenance, run commands, card layouts (`/MAT/PLAS_JOHNS`, `/FAIL/JOHNSON`), listing columns, Tools usage; LS-DYNA `*MAT_JOHNSON_COOK` layout via PyDyna. |
| `plans/*.plan.json` | draft plans | `build_project` lists. Geometry uses existing commands (`set_units`, `add_box`, `add_cylinder`, `create_material`, `assign_material`). Proposed commands: 08 MAT material record, PHY-02 `set_material_model` (`johnson_cook`, `hydrodynamic_eos` — the latter is a requested PHY-02 addition), 05 `create_analysis` (`analysisType: "explicit_dynamics"`, `solver: "opencourant"`), `set_part_idealization` (+ `sph`), `set_mesh_controls`, `add_result_probe`, and this pack's `set_explicit_controls`, `set_initial_velocity`, `add_rigid_wall`, `add_time_history`. |
| `sources.md` | register | Sources, access, grades. |

## Real use cases (sourced)

| # | Use case | Evidence | Cases |
| - | -------- | -------- | ----- |
| U1 | Bird strike on airframe structure | 14 CFR 25.571(e)(1) 4-lb bird at VC (sea level) or 0.85 VC (8000 ft); 25.631 8-lb bird on the empennage at VC; the FAA has a certification-by-analysis presentation [S11] | VC-EXP-30, 31, 53 |
| U2 | Engine bird ingestion and blade-out (scope only) | CS-E 800 and CS-E 810 exist with AMC [S12]; llull prepares models and reads results, the engine applicant certifies | VC-EXP-55 |
| U3 | Drop test of equipment or a package | Free-fall kinematics (derivation) | VC-EXP-32, 51 |
| U4 | Dynamic material behaviour | Johnson–Cook strength and failure are the common open-literature form, implemented by Radioss and LS-DYNA with the same parameters [S6–S8]; FAA-funded reports give Ti-6Al-4V / 2024-T3 constants [S9] | VC-EXP-20, 21, 52 |
| U5 | Trusting an explicit run | Energy balance, hourglass and contact energy ratios, added mass are the standard health checks [S13]; the Engine listing reports them per cycle [S1] | VC-EXP-40, 41, 42 |

## Validation cases

Gate: `unit` (no external process), `integration` (desktop with an installed OpenCourant, `npm --prefix server test`,
skipped with a reason when `LLULL_OPENCOURANT` is unset), `CLI` (agent driver, AF-23).

| VC | Proves | Setup | Expected | Tolerance | Source / grade | Gate |
| -- | ------ | ----- | -------- | --------- | -------------- | ---- |
| VC-EXP-01 | FR-EXP-01, 02, 20; TR-EXP-01, 02 | Run each plan, save, load, `replay_history`. | `analysis` slice deep-equal; ids identical; `is pure` for every new command. | exact | L1 | unit + golden |
| VC-EXP-02 | FR-EXP-04 | `export_explicit_deck` on a case whose part has no elastic constants, or a J–C law without a valid strain-rate range. | Refused `EXP_MATERIAL_INCOMPLETE` / `EXP_LAW_OUT_OF_RANGE`, nothing written. | exact | — | unit |
| VC-EXP-10 | FR-EXP-11; TR-EXP-30 | `explicit_quick_check check=wave_speed`, steel-like test material. | c0 = **5047.54465125 m/s**; cd = **5856.35665562 m/s**. | 1e-9 | (b) · **A** | unit |
| VC-EXP-11 | FR-EXP-11, 12; TR-EXP-30, 31 | `check=critical_time_step` (L_e = 2 mm) and `check=mass_scaling` (target 1e-6 s). | dt = **3.4150925526e-7 s**; added-mass ratio **7.57422831945**. | 1e-9 | (b) · **A** | unit |
| VC-EXP-12 | FR-EXP-11, 15; TR-EXP-32 | `check=bar_impact`, v = 10 m/s, L = 0.2 m, σy = 500 MPa. | σ = **396.232255123 MPa** (wall); t_c = **79.2464510246 µs**; two bars **198.116127562 MPa**; v_y = **12.6188616281 m/s**. | 1e-9 (quick check) | (b) · **A** | unit |
| VC-EXP-20 | FR-EXP-05; TR-EXP-20 | `check=johnson_cook_flow` with the Ti-6Al-4V set [S9], ε_p = 0.1, 1000 s⁻¹, ε̇0 = 1 s⁻¹. | **1344.89242239 MPa** (T = Tr); **1127.16040566 MPa** at 600 K with test-input Tm = 1900 K; rate below ε̇0 clamped (factor 1). | 1e-9 | (b) with **B** inputs | unit (reported) |
| VC-EXP-21 | FR-EXP-06; TR-EXP-21 | `check=johnson_cook_failure`, test-input D1–D5 = (0.05, 3.44, −2.12, 0.002, 0.61), triaxiality 1/3. | ε_f = **1.74690296571**; damage reaches 1 at the same strain. | 1e-9 / 1e-6 | (b) · **A** | unit |
| VC-EXP-22 | FR-EXP-15; TR-EXP-33 | `check=taylor_dynamic_yield` with ρ = 4430, v = 200 m/s, L0 = 25.4, L1 = 22.0, X = 18.0 mm (test inputs). | **559.953368271 MPa**. | 1e-9 | (b), form **B** [S10] | unit (reported) |
| VC-EXP-30 | FR-EXP-16 | `scenario=bird_strike` masses. | 4 lb = **1.81436948 kg**; 8 lb = **3.62873896 kg**. | 1e-12 | S11 + exact lb · **A** | unit |
| VC-EXP-31 | FR-EXP-16, 09; TR-EXP-34 | 4 lb at 150 m/s (test speed). | KE = **20 411.65665 J**; impulse on a rigid plate **272.155422 N·s**; L = 2D cylinder at 1000 kg/m³: D = **104.922497164 mm**, L = **209.844994328 mm**. | 1e-12 (quick check) | (b) · **A** | unit |
| VC-EXP-32 | FR-EXP-17; TR-EXP-34 | `scenario=drop_test`, h = 1.2 m. | v = **4.85138743042 m/s**; t = **0.494703841823 s**. | 1e-9 (quick check) | (b) · **A** | unit |
| VC-EXP-40 | FR-EXP-09; TR-EXP-40 | `explicit_energy_check` on `energy_balance_sample.csv`. | energy error **−0.002**; hourglass/internal **0.05**; contact/internal **0.03**; status `pass` against the named hourglass limit 0.10 [S13]. | 1e-12 | fixture · **A** | unit |
| VC-EXP-41 | FR-EXP-09, 22; TR-EXP-40 | Same fixture with hourglass energy ×3 (ratio 0.15), and with `energyErrorLimit` unset. | `EXP_HOURGLASS_HIGH` warning naming `{value: 0.10, source: "S13 rule of thumb", defaulted: true}`; `EXP_ENERGY_LIMIT_UNSET` warning. | exact | (b) | unit |
| VC-EXP-42 | FR-EXP-09; TR-EXP-41 | Parse `engine_listing_sample.txt`. | last energy error **−0.2 %**, 21 cycle lines, `normalTermination: true`, max added mass 0. | 0.05 % abs | fixture · **A** | unit |
| VC-EXP-50 | FR-EXP-07, 08, 10, 15 | `plans/exp_bar_rigid_wall.plan.json` → `explicit_run` → `explicit_import_results` → `explicit_report`. | rigid-wall force plateau **39 623 N** (396.23 MPa × 100 mm²); contact duration **79.2 µs**; mid-bar σzz plateau 396.2 MPa; energy error within the user limit. | 3 % (plateau mean), 3 % (duration) | (b) · **A** | integration |
| VC-EXP-51 | FR-EXP-07, 17 | `plans/exp_drop_box.plan.json`. | first contact at **0.4947 s**, centre v_z just before contact **−4851.4 mm/s**. | 0.5 % | (b) · **A** | integration |
| VC-EXP-52 | FR-EXP-05, 15 | `plans/exp_taylor_rod.plan.json`. | TBD: final length L1 and undeformed length X measured from the imported mesh; `explicit_quick_check check=taylor_dynamic_yield` on them reported next to the J–C flow stress. No gate (B inputs). | — | TBD | integration |
| VC-EXP-53 | FR-EXP-16, 09 | `plans/exp_bird_rigid_plate.plan.json` (V1, needs the PHY-02 EOS model). | total plate impulse = 272.155 N·s (m·v). | 5 % | (b) · **A** (bird model TBD) | integration (V1) |
| VC-EXP-54 | FR-EXP-04, 05, 06, 14; TR-EXP-10, 11 | Deck writers on a one-element model with the Ti J–C set and test D1–D5. | `.rad`: OpenCourant Starter exits normally and its `_0000.out` echoes a, b, n, c, m, D1–D5; `.k` (COULD): PyDyna parses `*MAT_JOHNSON_COOK` with identical field values. | exact | S1, S8 | integration / unit (PyDyna in CI Python) |
| VC-EXP-55 | FR-EXP-08, 10 | Import the VC-EXP-50 run (`th_to_csv`, `anim_to_vtk`). | time histories with units, `maxPlasticStrain`, `failedElements[]` (empty here), energies; artifact hash recorded. TBD freeze after the first M3 run. | exact (structure) | (c) TBD | integration |
| VC-EXP-56 | FR-EXP-04; TR-EXP-12 | Export the same plan twice. | identical deck sha256. | exact | — | unit |
| VC-EXP-57 | FR-EXP-19 | Host without OpenCourant (e.g. macOS, no container runtime). | `explicit_run` → `EXP_TOOL_MISSING` with install hint; export still works. | exact | S1 platforms | unit |
| VC-EXP-60 | FR-EXP-22 | `explicit_energy_check` with no limits given. | hourglass limit named and `defaulted: true`; no energy-error or added-mass default (warnings). | exact | AF-31 | unit + CLI |
| VC-EXP-61 | FR-EXP-23 | Any `explicit_report` or scenario result. | `reviewRequired: true`, `certificationEvidence: false`, summary contains "not approved". | exact | AF-33 | unit + CLI |
| VC-EXP-62 | FR-EXP-24 | J–C law with basis `typical` or grade-B provenance. | `unverified: true` on every result; `check_explicit` warning `EXP_LAW_UNVERIFIED`. | exact | AF-32 | unit |
| VC-EXP-63 | FR-EXP-25 | Agent calls `dispose_margin` on a bird-strike row (`EXP_FAILED_ELEMENTS` or penetration). | Exit 1, `FEA_HUMAN_GATE`, document unchanged. | exact | AF-34 | unit + CLI |
| VC-EXP-64 | FR-EXP-26 | The wrong set-ups of TECHNICAL_SPEC §7.1 (no end time, no initial condition or load, rigid wall normal zero, mass scaling above the limit, run results from another deck hash, ABNORMAL termination listing). | Each returns its code, ids/path and remediation. | exact | §7.1 | unit + CLI |
| VC-EXP-65 | FR-EXP-21 | Run record. | `tool: { name: "OpenCourant", version, commit/tag, sha256 of executables, licence: "AGPL-3.0-or-later" }`; results without a matching deck hash refused (`EXP_RESULTS_FOREIGN`). | exact | S1 | unit |
| VC-EXP-66 | FR-EXP-18 | Strain rate or temperature outside the law range in the imported results. | `check_explicit` fail `EXP_LAW_OUT_OF_RANGE` with element ids and the extreme value. | exact | AF-30 | integration |

## CLI harness (AF-23)

```bash
D="--doc case.llull.json --kernel occt --json"
an=$(llull run plans/exp_bar_rigid_wall.plan.json $D | jq -r '.data.aliases.an[0]')
llull check_explicit analysisId=$an $D > check.json
llull fea_mesh analysisId=$an $D --timeout 300 > mesh.json
llull explicit_run analysisId=$an $D --progress --timeout 3600 > run.json         # or: export, run elsewhere, import
llull explicit_report analysisId=$an $D > report.json
python3 -I compare.py report.json expected_results.json VC-EXP-12.a --field rigidWalls.anvil.forcePlateauN --scale 1e-4
llull explicit_quick_check check=bar_impact 'inputs={"E_Pa":2e11,"rho_kg_m3":7850,"v_m_s":10,"L_m":0.2}' --json
```

## Re-generating

```bash
cd docs/physics/19-explicit-impact/validation
python3 -I generate_explicit_reference.py   # rewrites expected_results.json, 4 CSV files, engine_listing_sample.txt
git diff --stat .                           # must be empty unless the generator changed
```
