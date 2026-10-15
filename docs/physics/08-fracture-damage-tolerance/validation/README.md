# PHY-08 FRC: validation pack

Proves a future implementation of [`../FUNCTIONAL_SPEC.md`](../FUNCTIONAL_SPEC.md) (`FR-FRC-*`) and
[`../TECHNICAL_SPEC.md`](../TECHNICAL_SPEC.md) (`TR-FRC-*`). Values are (a) quoted from [`sources.md`](sources.md),
(b) derived by [`generate_fracture_reference.py`](generate_fracture_reference.py) (stdlib only, `python3 -I`,
byte-identical on re-run), or (c) `TBD`. Crack-growth constants (C = 1e-11 m/cycle·(MPa√m)^-3, m = 3), K_c = 60 MPa√m and
Fty = 300 MPa are **test inputs**, not material claims. Units: m, MPa, MPa√m, m/cycle. Tolerances are llull choices.

## Files

| File | Kind | Content |
| ---- | ---- | ------- |
| `generate_fracture_reference.py` | generator | Writes the files below; asserts Tada vs polynomial agreement (< 1 % for a/b ≤ 0.6) and cycle-by-cycle vs closed-form Paris (< 0.1 %), Simpson vs closed form (< 1e-10) |
| `expected_results.json` | (b) + (a) | VC-FRC cases, README §6.3 schema |
| `k_solutions_table.csv` | (b) | β for centre (secant, a/W ≤ 0.4) and edge (Tada, polynomial) cracks, ratio 0.1 … 0.6 |
| `newman_raju_table.csv` | (b), **grade C** | Q, F at φ = 90° / 0°, and F/√Q for a/c ∈ {0.2, 0.4, 1}, a/t ∈ {0.2, 0.5, 0.8}, c/b = 0.1 — not a gate (OQ-FRC-01) |
| `crack_growth_center_paris.csv` | (b) | a(N) every 50 000 cycles, cycle-by-cycle vs closed form |
| `plans/frc_paris_center_life.plan.json` | draft | Paris closed-form check (W = 100 000 mm approximates the infinite plate: secant correction < 3e-8) |
| `plans/frc_residual_interval.plan.json` | draft | Residual strength, critical size, growth life and interval with SF 2 |
| `plans/frc_nafems_r0020_t2_1.plan.json` | draft (V1) | NAFEMS 2.1 half model with crack seam and plane strain (05 extensions proposed by this pack) |

Plans use existing commands (`set_units`, `add_box`, `create_material`, `assign_material`), proposed aerospace 08 / 05
commands, PHY-02's proposed `add_material_model`, PHY-07's `define_load_history`, and this pack's commands.

## Real use cases

| # | Use case | Evidence | Cases |
| - | -------- | -------- | ----- |
| U1 | Residual strength with detectable damage (Part 25) | 25.571(b) [S13] | VC-FRC-10…12 |
| U2 | Inspection threshold from a rogue flaw, repeat interval from the detectable size | 1998 NPRM [S16]; CS 25.571 [S15] | VC-FRC-13, 14 |
| U3 | Spaceflight fracture control: assumed flaw below NDE limit survives service life × factor | NASA-STD-5019 concepts [S17] | VC-FRC-13, 20 |
| U4 | FE K for geometry not in handbooks | Interaction integral in commercial / open codes [S10]; NAFEMS 2.1 [S4] | VC-FRC-03, 17 |

## Validation cases

| VC | Proves | Setup | Expected | Tol. | Grade | Gate |
| -- | ------ | ----- | -------- | ---- | ----- | ---- |
| VC-FRC-01 | FR-FRC-01; TR-FRC-10 | centre crack a 10 mm, W 100 mm, 100 MPa | K = 18.1748892684 MPa√m | 1e-12 rel | A | unit |
| VC-FRC-02 | FR-FRC-01; TR-FRC-10 | edge crack a/b = 0.5 | β Tada 2.82658060837; polynomial 2.829125 | 1e-12 rel | A | unit |
| VC-FRC-03 | FR-FRC-03; TR-FRC-20 | `plans/frc_nafems_r0020_t2_1.plan.json`, interaction integral | K/(σ√(πa)) = 3.0 (Ansys 2.966 / J 2.965) | 3 % | B | integration (V1) |
| VC-FRC-04 | FR-FRC-02; TR-FRC-11 | Newman-Raju a/t 0.5, c/b 0.1 | F deepest / surface: a/c 0.2 → 1.49973 / 0.796456; 0.4 → 1.30559 / 0.980553; 1.0 → 1.08714 / 1.29098 | 1e-9 rel | **C** | not a gate |
| VC-FRC-05 | FR-FRC-05, 06; TR-FRC-30 | `plans/frc_paris_center_life.plan.json` | 776 634.44445 cycles (closed form) | 1e-9 rel (closed-form path) | A | unit + golden |
| VC-FRC-06 | FR-FRC-06; TR-FRC-31 | same, cycle-by-cycle | 776 637 cycles | 0.1 % | A | unit |
| VC-FRC-07 | FR-FRC-06; TR-FRC-31 | secant, W 200 mm, 5 → 40 mm, Δσ 150 MPa | 92 454.9203271 cycles | 1e-6 rel (reference) / 0.1 % (integrator) | A | unit |
| VC-FRC-08 | FR-FRC-04; TR-FRC-32 | rates at ΔK 10 MPa√m | Paris 1e-8; Walker (R 0.5, γ 0.5) 2.82842712475e-8; Forman (R 0.1, K_c 60) 2.27272727273e-10; NASGRO (R 0.1, f 0.1, ΔK_th 2, p = q = 0.25) 9.95423220853e-9 m/cycle | 1e-12 rel | B | unit |
| VC-FRC-09 | FR-FRC-04 | Newman f(R), α 2, S_max/σ0 0.3 | R −1: 0.243756; 0: 0.325656; 0.1: 0.342172; 0.5: 0.548066; 0.8: 0.804489 | 1e-12 rel | **C** | not a gate |
| VC-FRC-10 | FR-FRC-07; TR-FRC-40 | `plans/frc_residual_interval.plan.json`, σ 150 MPa | a_crit = 0.0408158761182 m | 1e-9 rel | A | unit |
| VC-FRC-11 | FR-FRC-07 | same | a_net-yield = 0.05 m | 1e-12 rel | A | unit |
| VC-FRC-12 | FR-FRC-07 | residual strength at a = 10 / 20 / 40 mm | 270 (net-section yield) / 233.434197 / 152.238726 MPa (fracture) | 1e-9 rel | A | unit |
| VC-FRC-13 | FR-FRC-08; TR-FRC-41 | growth 5 mm → a_crit | 92 841.1526827 cycles | 1e-6 rel | A | unit |
| VC-FRC-14 | FR-FRC-08, 09 | interval with SF 2 (explicit) | 46 420.5763414 cycles; `factors.scatterInterval.defaulted: false` | 1e-6 rel | A | unit |
| VC-FRC-15 | FR-FRC-10; TR-FRC-21 | CalculiX shape factors, K_eq(10, 5, 0) | 1.12, 1.0976, 0.636619772368, 0.662084563262, 1.36236631287; K_eq 12.6387580797 | 1e-12 rel | B | unit |
| VC-FRC-16 | FR-FRC-10; TR-FRC-21 | (da/dN)_ref 1e-8 m with C 1e-11, m 3 | ΔK_ref = 10 MPa√m | 1e-12 rel | A | unit |
| VC-FRC-17 | FR-FRC-03; TR-FRC-20 | FE centre crack a 20 mm, W 200 mm, 100 MPa | K = 25.703174898 MPa√m (secant reference); FE value TBD (M4) | 2 % | A (reference) | integration (V1) |
| VC-FRC-20 | FR-FRC-09, 11–13; TR-FRC-50 | (i) no SF; (ii) agent accepts interval; (iii) K_c basis `typical`; (iv) a/W 0.6 centre crack; (v) param change; (vi) any result | (i) `FRC_SCATTER_FACTOR_UNSET`; (ii) `FRC_HUMAN_GATE`, doc unchanged; (iii) `unverified` + `FRC_DATA_UNVERIFIED`; (iv) `FRC_K_SOLUTION_OUT_OF_RANGE`; (v) `FRC_RESULTS_STALE`; (vi) `reviewRequired: true`, "not approved" | exact | A | unit + CLI |
| VC-FRC-21 | FR-FRC-14, 15, 16 | `check_damage_tolerance` on VC-FRC-14 set-up; ΔK above the model's `dKRange` | pass/warn/fail list with `FRC_DISPOSITION_PENDING`, `FRC_MARGINAL_BAND_UNSET`; `FRC_RATE_EXTRAPOLATED` when ΔK exceeds the range; curves returned as bounded `curve[]` arrays | exact | A | unit |
| VC-FRC-22 | FR-FRC-17, 18, 19 | `export_crack_growth --save a_N.csv`; same case in ksi·√in / in units; deliberately wrong plans (a ≥ t, missing model, factor 0.5) | CSV equals `data.curve`; results equal after unit conversion (1e-12 rel); codes `FRC_CRACK_INVALID`, `FRC_MODEL_MISSING`, `FRC_FACTOR_INVALID` with remediation | exact | A | unit + CLI |
| VC-FRC-23 | FR-FRC-20, 21 | retardation / weight function | TBD — source a published benchmark | — | TBD | deferred |

## CLI harness (AF-23)

```bash
D="--doc dt.llull.json --json"
llull run plans/frc_paris_center_life.plan.json $D > paris.json       # last step data.lifeCycles vs VC-FRC-05/06
llull run plans/frc_residual_interval.plan.json $D > dt.json          # residual / interval vs VC-FRC-10…14
python3 -I compare.py dt.json expected_results.json VC-FRC-14         # PHY-00 harness comparator
```

## Re-generating

```bash
cd docs/physics/08-fracture-damage-tolerance/validation
python3 -I generate_fracture_reference.py && python3 -I generate_fracture_reference.py
git diff --stat .        # must be empty unless the generator changed
```
