# Gap 11 FLD — Validation pack

This pack proves llull's compressible-flow and rocket-propulsion commands. The reference values come from:

- published tables: NACA Report 1135;
- published engine data: RS-25 and NASA SP-125;
- outputs of NASA's own reference code (CEA), which are labelled as such and were cross-checked against the 2004
  CEA2 Fortran output of an RP-1311 sample problem;
- cited closed forms.

No expected value was produced by running llull. Sources and grades are in [sources.md](sources.md).

## Files

| File | Content | Grade |
| ---- | ------- | ----- |
| `data/compressible_naca1135.json` | 13 cases (isentropic M 0.5 / 2 / 3 + two inverses, normal shock M 2 / 3, oblique shock M 2 / 3 at θ 10°, Fanno M 0.5 / 2, Rayleigh M 0.5 / 2), γ 1.4 | A / B per row |
| `data/nasa_cea_reference.json` | NASA CEA (official `cea` 3.3.4 package) runs: RP-1311 Example 8 (with the matching CEA2 Fortran values), LOX/LH2 206.4 bar MR 6 ε 69, LOX/RP-1 70 bar MR 2.27 ε 16, with chamber / throat / exit states and frozen + equilibrium Isp | A (code-to-code) |
| `data/engines_published.json` | RS-25, F-1 and the NASA SP-125 A-1 example engine; which rows gate and why | A / B per row |
| `data/nozzle_contour_references.json` | conical λ, Rao throat arcs, Huzel & Huang 80 % bell angle chart (digitised), Summerfield criterion | A / B |
| `expected_results.json` | index of every VC | — |
| `plans/sc-fld-0*.json` | CLI scenarios with `expected` rows | — |

## Real use cases

| # | Use case | VC |
| - | -------- | -- |
| U1 | LOX/LH2 upper-stage or core engine concept: performance, nozzle wall, stage Δv | VC-FLD-10, 13, 20, 30, SC-FLD-02 |
| U2 | LOX/RP-1 booster engine at sea level: over-expansion and separation risk, conical vs bell | VC-FLD-11, 21, SC-FLD-03 |
| U3 | Supersonic inlet / wind tunnel: shock losses, area ratios | VC-FLD-01..05, SC-FLD-01 |
| U4 | Gas line with friction or heating (Fanno / Rayleigh choking length) | VC-FLD-04/05 |

## Validation cases

| VC | What | Reference | Tolerance | Test |
| -- | ---- | --------- | --------- | ---- |
| VC-FLD-01 | Isentropic ratios and inverses | NACA 1135 [S1] | 5e-4 rel, 0.01° | `compressible.test.ts` |
| VC-FLD-02 | Normal shock | NACA 1135 | 5e-4 rel | idem |
| VC-FLD-03 | Oblique shock θ-β-M, θmax | NACA 1135 / reproductions | 0.01°, 5e-4 | idem |
| VC-FLD-04 | Fanno | NACA 1135 closed form | 5e-4 | idem |
| VC-FLD-05 | Rayleigh | NACA 1135 closed form | 5e-4 | idem |
| VC-FLD-10 | LOX/LH2 206.4 bar, ε 69: c*, T_t, Isp vac / SL | NASA CEA [S2] | c* 0.5 %, T_t 1.5 %, Isp 3 % (equilibrium) | `nozzle.test.ts` |
| VC-FLD-11 | LOX/RP-1 70 bar, ε 16: same | NASA CEA | same | idem |
| VC-FLD-12 | RP-1311 Example 8: c*, T_t, Isp at ε 25 | CEA2 Fortran 2004 output + `cea` 3.3.4 [S2] | same | idem |
| VC-FLD-13 | RS-25: ideal ≥ 452.3 s by < 6 %, separation flagged at sea level | L3Harris / NASA [S5] | band | idem |
| VC-FLD-14 | C_F,vac − C_F,SL = ε p_a/p_c (SP-125 A-1: 1.768 → 1.562) | NASA SP-125 [S4] | 1e-3 | idem |
| VC-FLD-15 | Sizing: F = C_F p_c A_t, ṁ = F/(Isp g0), D_e = D_t √ε | closed form | 1e-3 rel | idem |
| VC-FLD-20 | 80 % bell at ε 25: R_e, L = 0.8 L15, θn / θe from the chart, throat at R_t, monotone divergent | Rao / Huzel & Huang [S3] | 1e-9 geometry, 0.2° θn, 0.05° θe | `designNozzle.test.ts` |
| VC-FLD-21 | Conical λ(15°) = 0.98296 | Malina / Sutton [S6] | 1e-5 | `nozzle.test.ts` |
| VC-FLD-22 | Wall volume = Pappus of the wall section (96 segments) | closed form | 0.2 % | `designNozzle.test.ts` |
| VC-FLD-30 | Δv, burn time, inverse | Tsiolkovsky | 1e-6 | `designNozzle.test.ts` |

### Why the Isp gate is "equilibrium ± 3 %" and not frozen

llull uses one γ for the whole expansion. Given CEA's chamber γ:

- c* matches CEA to 0.02 % (for the LOX/LH2 case: 2323.14 vs 2322.77 m/s).
- Isp lands 1.3–2.7 % above CEA's shifting-equilibrium value.
- CEA's frozen-at-throat Isp is 4–6 % lower, because the frozen γ rises from 1.15 to about 1.27 along the nozzle.

That frozen gap is documented in `nasa_cea_reference.json` and is a V1 item (a two-γ model), not a defect being
hidden.

### Not gated

- F-1: ideal Isp is about 11 % above the published 304 s. This is the gas-generator cycle (turbine exhaust dumped
  into the nozzle extension) plus film cooling, and its chamber pressure sources conflict.
- SP-125 A-1 thrust: the book applies correction factors whose γ is not stated. Only the C_F identity is used.
