# Gap 10 AER — Validation pack

This pack proves that llull's aerodynamics commands are right. Every reference value comes from a published,
freely accessible source (see [sources.md](sources.md), graded A/B/C), or from a closed-form solution whose
formula is cited. **No expected value was produced by running llull.** A value computed here is a closed form
of a cited model, and its derivation is given.

All cases run automatically:

- Unit tests read the JSON files below directly.
- `tests/unit/aero/scenarioPlans.test.ts` runs every plan in `plans/` through `build_project`. That is the same
  path as the CLI command `llull run plan.json`.

## Files

| File | Content | Grade |
| ---- | ------- | ----- |
| `data/us1976_pdas_table.json` | U.S. Standard Atmosphere 1976, −2..86 km geometric every 2 km: T, p, ρ, a, μ, printed to 5 significant figures (PDAS table) | A |
| `data/bassett1999_table7.json` | 13 world hour records 1967–1996: rider height, mass, distance, Kd/Kp/Kb/Kc/Kh/K1 and power (Bassett et al. 1999 Table 7, read from the paper) | A |
| `data/cycling_references.json` | Martin 1998 constants and validation statistics; Defraeye 2010 CdA by position; Blocken 2013 / 2018 drafting reductions | A / B per row |
| `data/airfoil_wing_references.json` | NACA 0012 Ladson / McCroskey data, NACA 2412 thin-airfoil zero-lift angle, Joukowski exact cases, lifting-line closed forms, skin-friction check values, bluff-body Cd | A / B per row |
| `expected_results.json` | Index of every VC: inputs, expected value, tolerance, source and test file | — |
| `plans/sc-aer-0*.json` | CLI scenarios (`build_project` actions + `expected` rows) | — |

## Real use cases

| # | Use case | What llull must do | VC |
| - | -------- | ------------------ | -- |
| U1 | Max-q of a sounding rocket: ρ, a, q at altitude | the atmosphere + flow quantities from the 1976 standard | VC-AER-01, SC-AER-01 |
| U2 | Light-aircraft wing: NACA 2412, 10 m span, washout | section, incidence, wing CL / CDi / e, forces | VC-AER-11, 13, SC-AER-04 |
| U3 | Wind load on a panel / sign | frontal area from the model × Cd 1.28 | VC-AER-02, 04, SC-AER-05 |
| U4 | Cyclist: watts saved by a time-trial position | Martin 1998 with published CdA | VC-AER-21, 22, SC-AER-03 |
| U5 | Hour-record planning: power for a distance, effect of altitude | Bassett 1999 model, inverse distance | VC-AER-20, SC-AER-02 |

## Validation cases

| VC | What | Reference | Tolerance | Test |
| -- | ---- | --------- | --------- | ---- |
| VC-AER-01 | Atmosphere at 45 altitudes | PDAS USSA76 table [S1] | T ±0.006 K; p, ρ, a, μ 1e-4 rel (5 printed digits) | `atmosphere.test.ts` |
| VC-AER-02 | Frontal area of a box along x and z | exact geometry | within the reported uncertainty / 1e-3 | `drag.test.ts` |
| VC-AER-03 | Frontal area of a sphere | πr² | −1.5 %..+0.1 % (display tessellation) | `drag.test.ts` |
| VC-AER-04 | D = ½ρV²CdA, P = DV; flat plate Cd 1.28 | NASA GRC [S8] | 1e-6 rel | `drag.test.ts` |
| VC-AER-05 | Skin friction Cf at Re 1e6 / 1e7 for Blasius, Prandtl-Schlichting, ITTC-1957 | closed forms [S9] | 5e-4 rel | `drag.test.ts` |
| VC-AER-10 | Joukowski airfoils (3 cases): panel cl vs exact potential flow cl = 8πR sin(α+β)/c | conformal-map closed form [S6] | 1 % at 300 panels / side | `airfoil.test.ts` |
| VC-AER-11 | NACA 2412 zero-lift angle | thin airfoil −2.077° [S5]; measured ≈ −2° | 1e-3° (thin airfoil), 0.4° (panel vs measured) | `airfoil.test.ts` |
| VC-AER-12 | NACA 0012 vs experiment (inviscid bias) | Ladson TM-4074 cl(10°) 1.0586–1.0672 [S3]; McCroskey slope 0.1063 /deg at Re 6e6 [S4] | inviscid / measured in 1.05..1.15 | `airfoil.test.ts` |
| VC-AER-13 | Elliptical wing: e = 1, CL_α = a0/(1+a0/πAR), CDi = CL²/πAR | Prandtl / Glauert closed form [S7] | 1e-6 rel | `wing.test.ts` |
| VC-AER-14 | NACA ordinates | 02 SRF generator checked against UIUC naca2412.dat [S2] | 1e-7 c | `airfoil.test.ts` |
| VC-AER-20 | Hour-record power, 13 rows | Bassett et al. 1999 Table 7 [S10] | ±2 W (Boardman 1996: the paper's model value 452 W) | `cycling.test.ts` |
| VC-AER-21 | Martin model terms | Martin et al. 1998 [S11] | closed form 1e-3 W | `cycling.test.ts` |
| VC-AER-22 | Position ranking upright > drops > TT at 40 km/h | Defraeye 2010 CdA [S12] | strict order; inverse speed 1e-4 km/h | `cycling.test.ts` |
| VC-AER-23 | Altitude, grade, wind effects; model-measured CdA | Martin 1998 terms, Bassett Kd | sign and closed form | `cycling.test.ts` |

### Derivations used as expectations

- **SC-AER-03** compares three positions at 45 km/h, using the Martin closed form with m = 80 kg, ρ = 1.225,
  Crr 0.0032, Fw 0.0044, E_c 0.976, g = 9.80665. The power is
  P = [½ρ(CdA + Fw)V³ + V Crr m g + V(91 + 8.7V)e-3]/E_c, with V = 12.5 m/s.
- **SC-AER-05** uses D = ½ · 1.225 · 20² · 1.28 · 0.24 = 75.264 N.
- **VC-AER-10** uses a Joukowski airfoil: the circle of radius R = |b + m_x + i m_y| centred at (−m_x, m_y),
  mapped by z = ζ + b²/ζ. The Kutta circulation Γ = 4πV R sin(α + β), with β = asin(m_y/R), gives
  cl = 8πR sin(α+β)/c, where c is the mapped chord.

### Known biases (expected and documented, not failures)

- Inviscid section lift is higher than measured. On NACA 0012 the computed slope is 0.1195 /deg against a measured
  0.1063 /deg (+12 %). VC-AER-12 pins this band so that a regression in either direction is caught.
- A Joukowski airfoil's cusped trailing edge converges at first order: 1.3 % error at 150 panels/side, 0.46 % at
  300, 0.21 % at 600.
- Bassett's Table 7 for Boardman 1996 lists the SRM-measured 442 W. The model gives 452 W, as the paper itself
  states.

## What could not be verified

- The Abbott & von Doenhoff tabulated v/V of NACA 0012 (NACA Report 824 Appendix I). The primary PDF could not
  be fetched, so no Cp table is used. The Joukowski exact solution replaces it.
- Martin 1998's own CdA, wheel inertia and worked example. Only the model structure, its constants and its
  validation statistics (R² 0.97, SE 2.7 W) are used.
- Finite-wing experimental lift slopes (Glauert δ/τ tables, NACA rectangular-wing reports): not used as gates.
