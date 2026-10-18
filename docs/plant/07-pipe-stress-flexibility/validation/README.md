# Gap 07 PST — Validation pack

This pack proves that llull's pipe stress commands are right. Every reference value is either quoted from a source
in [sources.md](sources.md) (graded A/B/C), reproduced by an independent solver written for this pack
(`data/scripts/frame3d.py`, grade A as "reference code run"), or derived from a cited closed form whose derivation
is given below. **No expected value was produced by running llull** (nothing is built yet).

How the cases run once the commands exist:

- Unit tests read the JSON files in `data/` directly (`tests/unit/plant/stress/*.test.ts`).
- `tests/unit/plant/stress/scenarioPlans.test.ts` runs every plan in `plans/` through `build_project` — the same path as
  `llull run plan.json` (AF-23). Each plan lists the commands it needs that are not built yet in `unbuilt`.
- The reference scripts can be re-run by anyone: `cd data/scripts && python3 -I closed_forms.py`,
  `python3 -I lbend_flexibility.py`, `python3 -I psi_benchmarks.py .` (numpy only).

## Gate policy

Only **grade A** values and cited closed forms are pass / fail thresholds. Grade B values (tee SIF formulas, the
occasional 1.33 S_h factor, NEMA SM 23 and API 610 numbers, spring variability limit) are used as inputs: the gate is
the arithmetic of the rule applied to those inputs, and the result must name the rule's grade. Grade C values are
never used; their VCs are `TBD — measure with <tool>`.

## Files

| File | Content | Grade |
| ---- | ------- | ----- |
| `data/psi_benchmarks.json` | PSI test fixtures (3D NPS 10 two-anchor system, 10 ft cantilever) and asserted values, with the independent `frame3d` results | A where `frame3d` / closed form agrees, else B |
| `data/sif_flexibility.json` | SIF / k formulas by component and edition; elbow cases NPS 6 Sch 40 LR / SR, DN150 SI | A (bends), B (tees), C (B31J) |
| `data/thermal_expansion_carbon_steel.json` | carbon steel mean α from 70 °F and growth in/100 ft, 200–900 °F | A (400 °F row), B (others) |
| `data/pipe_dimensions_b3610.json` | NPS 3 / 6 / 10 Sch 40 OD and wall from `fluids` and PSI | A |
| `data/code_rules_b313.json` | B31.3 / B31.1 rules (SA 1a / 1b, f by edition, occasional, sustained, expansion), spring variability, NEMA SM 23, API 610 rule; derived values | per rule |
| `data/lbend_guided_cantilever.json` | guided cantilever and two-anchor L-bend closed forms with both solution methods | A (closed form) |
| `data/nozzle_limits_reference.json` | API 610 Table 5 NPS 6 values (B) and NEMA SM 23 worked examples | B inputs |
| `data/closed_forms_output.json` | raw output of `scripts/closed_forms.py` | — |
| `data/scripts/frame3d.py` | independent 3D Timoshenko pipe-frame solver (direct stiffness, thermal and distributed loads) | — |
| `data/scripts/closed_forms.py`, `lbend_flexibility.py`, `psi_benchmarks.py` | derivations of every computed expectation | — |
| `expected_results.json` | index of every VC | — |
| `plans/sc-pst-0*.json` | CLI scenarios (`build_project` actions + `expected` rows) | — |

## Real use cases

| # | Use case | What llull must do | VC / plan |
| - | -------- | ------------------ | --------- |
| U1 | Is a DN150 hot line between two fixed points flexible enough? | model from the route, thermal case, S_E vs S_A with elbow SIFs | VC-PST-12, SC-PST-01 |
| U2 | Owner asks: "how much does this 30 m line grow at 204 °C, and does a 6 m leg absorb it?" | quick checks, no model | VC-PST-04, 06, SC-PST-03 |
| U3 | Stress engineer wants the same answer as the open-source reference on a 3D system | reproduce PSI fixture displacements | VC-PST-07, 08, SC-PST-02 |
| U4 | Pump discharge line: are the nozzle loads within API 610? | reactions at the nozzle, component ≤ 2 × Table 5 | VC-PST-15, SC-PST-04 |
| U5 | A hot riser lifts off its rest: choose a spring | restrained-weight + thermal runs, variability ≤ 25 % | VC-PST-11, 14, SC-PST-04 |
| U6 | Hand the line to CAESAR II for the PE's sign-off | `.cii` export, human approval gate | VC-PST-16, 18, SC-PST-05 |

## Validation cases

| VC | What | Reference | Tolerance | Grade | FR / TR |
| -- | ---- | --------- | --------- | ----- | ------- |
| VC-PST-01 | Elbow h, k, ii, io: NPS 6 Sch 40 LR (R1 9 in) h 0.250379, k 6.59002, ii 2.26557, io 1.88798; SR (R1 6 in) h 0.166919, k 9.88503, ii 2.96874, io 2.47395; DN150 SI 168.3 / 7.11 / 228.6 mm | App. D formulas [S5, S6, S3]; dims [S4] | 1e-4 rel | A | FR-08, 12; TR-03, 07, 10 |
| VC-PST-02 | Tee / olet SIF arithmetic: unreinforced 3.4795, welding tee (h 3.1 T/r) 1.6366, weldolet 1.5698 (NPS 3, T 0.216 in) | PSI `test_sifs.py` [S3] = closed form recomputation | 1e-4 rel on the formula; rule grade B reported | B | FR-08; TR-07 |
| VC-PST-03 | f by edition: N 7000 → 1.02125 (≤ 2020, fm 1.2), 1.0 with fm 1.0; 1.04552 (2022); N 100 000 → 0.6 / 0.430887; N 2e8 → 0.15 floor; crossings 3125 / 4630 cycles at 1.2 | S12, S13 | 1e-5 abs | A | FR-07, 12; TR-06, 10 |
| VC-PST-04 | Thermal growth carbon steel 70 → 400 °F: 2.70 in/100 ft; 30 m → 67.52 mm | S8 + S3 α 6.82e-6 /°F | ± 0.01 in/100 ft; ± 0.05 mm | A | FR-03, 12 |
| VC-PST-05 | SA eq. 1a / 1b: Sc = Sh = 137.9, SL = 40 MPa: f 1 → 206.85 / 304.75; f 0.6 → 124.11 / 182.85 MPa | S10, S11, S3 | 1e-6 rel | A | FR-07; TR-06 |
| VC-PST-06 | Guided cantilever NPS 6 Sch 40, E 200 GPa, L 6 m, Δ 50 mm: F 6509.017 N, M 1.9527e7 N·mm, S 140.25 MPa, L_min (SA 206.85) 4940.55 mm | beam theory [S24] | 1e-6 rel | A | FR-12; TR-10 |
| VC-PST-07 | PSI 3D fixture, thermal 900 °F, node 30: dy 0.758 in (19.25 mm), dz 1.891 in (48.03 mm), rx 0.1521° | PSI [S3] = frame3d [S7] (0.7578, 1.8911, 0.1521) | 1 % | A | FR-01, 04, 09, 20; TR-01, 02, 04, 12 |
| VC-PST-08 | PSI 3D fixture, weight: dy 0.33 in, dz −1.31 in, rx −0.40° | PSI [S3] (rounded) vs frame3d 0.3295 / −1.3051 / −0.3966 | 3 % (PSI's own rounding) | A | FR-04, 09; TR-04 |
| VC-PST-09 | Pressure 250 psi NPS 10 Sch 40: hoop 3681.51 psi, longitudinal (exact area) 1655.45 psi; simplified PD/4t 1840.75 psi | closed form = PSI [S3] | 1e-5 rel | A | FR-04, 07; TR-04, 06 |
| VC-PST-10 | Fully restrained axial thermal force, 10 ft NPS 10, 500 °F: 1.00290e6 lbf (= E A α ΔT; PSI 1.00235e6) | closed form; PSI [S3] | 0.1 % | A | FR-04; TR-02 |
| VC-PST-11 | One-way +vertical support: upward 10 000 lbf ⇒ reaction 0, lift-off flagged; downward ⇒ 5000 lbf each end | statics; PSI [S3] | exact (1e-6 rel) | A | FR-05; TR-05 |
| VC-PST-12 | Two-anchor L-bend 6 m × 3 m, NPS 6 Sch 40, ε 0.00225: reaction at C (−7872.99, −2406.95) N; \|M\| C 1.48686e7, B 8.75040e6, A 5.69132e6 N·mm; S_max 106.791 MPa; bending-only variant 107.291 MPa | unit-load flexibility = frame3d [S7] | 1e-4 rel | A | FR-01, 04, 19; TR-01, 02, 03 |
| VC-PST-13 | Occasional rule arithmetic: S_SUS 80 + S_OCC 60 MPa vs 1.33 × 137.9 = 183.407 MPa ⇒ ratio 0.76333, rule grade B named | S11, S15 | 1e-5 rel | B (rule) | FR-06, 15; TR-06 |
| VC-PST-14 | Spring variability: P_hot 10 kN, k 100 N/mm, 20 mm up ⇒ P_cold 12 kN, V 0.20 (≤ 0.25 pass); 30 mm ⇒ 0.30 fail `PST_SPRING_VARIABILITY` | closed form; limit S18 | exact | A (formula), B (limit) | FR-13; TR-08 |
| VC-PST-15 | Nozzle rule arithmetic: NEMA NPS 6 (F 500 lbf, M 1200 ft·lbf) ratio 0.9; NPS 10 (F 600, M 2000) De 8.6667 in, ratio 0.876923; API 610 NPS 6 top nozzle component limit 2 × 700 = 1400 lbf (Fz) | S19, S20, S21 | 1e-6 rel; grade B named in result | B (inputs) | FR-14; TR-09 |
| VC-PST-16 | `.cii` export imports into CAESAR II and gives the same node displacements as llull within 2 % on SC-PST-01 | CAESAR II (licensed reviewer) | 2 % | TBD — measure with CAESAR II | FR-16; TR-13 |
| VC-PST-17 | NUREG/CR-1677 Problem 1 modal frequencies (f1 ≈ 28.5 Hz per one extract) | S26 | TBD — measure when the report is obtained | C | FR-21; TR-15 |
| VC-PST-18 | Agent-first: refusals carry codes (§7 TECHNICAL); `reviewRequired: true` on every analysis; defaulted cycles / edition / friction listed; unsigned material ⇒ `PST_MATERIAL_UNVERIFIED`; edit after record ⇒ `PST_RESULTS_STALE`; agent approval ⇒ `PST_HUMAN_GATE` | AGENT_FIRST AF-11, 31–34 | exact codes | A (spec) | FR-02, 10, 11, 17, 18; TR-11, 12 |
| VC-PST-19 | B31J SIFs for B31.3 ≥ 2020 | licensed B31J copy | TBD — measure with a licensed B31J table or CAESAR II B31J option | C | FR-08, 22; TR-07 |

### Derivations used as expectations

- **VC-PST-01**: r2 = (Do − T)/2 = (6.625 − 0.280)/2 = 3.1725 in; h = T R1 / r2² = 0.280 × 9.0 / 3.1725² = 0.250379;
  k = 1.65 / h = 6.59002; ii = 0.9 / h^(2/3) = 2.26557; io = 0.75 / h^(2/3) = 1.88798. R1 = 1.5 × nominal 6 in (long
  radius); short radius R1 = 6 in. (`scripts/closed_forms.py`)
- **VC-PST-03**: 6 × 7000^-0.2 = 6 × e^(−0.2 ln 7000) = 1.021249; 6 × 10^5^(−0.2) = 6 × 0.1 = 0.6; 20 × 7000^(−1/3) =
  1.045516; 20 × 10^5^(−1/3) = 0.430887; 6 N^-0.2 = 1.2 ⇔ N = 5^5 = 3125; 20 N^(−1/3) = 1.2 ⇔ N = (50/3)^3 = 4629.6.
- **VC-PST-04**: ΔL/L = ᾱ (T − 70) = 6.82e-6 × 330 = 2.2506e-3 ⇒ 2.7007 in per 1200 in; 30 000 mm × 2.2506e-3 = 67.518 mm.
- **VC-PST-06**: Z = I / (Do/2), I = π/64 (168.3⁴ − 154.08⁴) = 1.17162e7 mm⁴; S = 3 E Do Δ / L² = 3 × 200 000 × 168.3 × 50 / 6000²
  = 140.25 MPa; F = 12 E I Δ / L³; L_min = √(3 E Do Δ / S_A).
- **VC-PST-07 / 08**: model inputs in `data/psi_benchmarks.json`; frame3d with shear area A/2 reproduces PSI to 4 digits; the
  Euler–Bernoulli variant differs by < 1 % on rotations (0.1534° vs 0.1521°), which sets the 1 % tolerance and pins the
  Timoshenko choice (TR-PST-02).
- **VC-PST-09**: Di = 10.75 − 2 × 0.365 = 10.02 in; 250 × 10.75 / (2 × 0.365) = 3681.51; 250 × 10.02² / (10.75² − 10.02²) = 1655.45.
- **VC-PST-10**: A = π/4 (10.75² − 10.02²) = 11.9083 in²; 27.9e6 × 11.9083 × 7.02e-6 × 430 = 1.002903e6 lbf (PSI asserts
  1 002 348.1, 0.055 % lower — inside its 3 % rule).
- **VC-PST-12**: redundants X, Y, M at anchor C from the unit-load flexibility matrix ∫ m mᵀ / EI ds + ∫ n nᵀ / EA ds over both legs,
  closing the free expansion (ε a, ε b, 0); identical to the stiffness solution (`scripts/lbend_flexibility.py`). The
  guided-cantilever approximation gives 151.47 MPa for the short leg: conservative, as the method neglects rotation (S24).
- **VC-PST-13**: 1.33 × 137.9 = 183.407; (80 + 60) / 183.407 = 0.763330.
- **VC-PST-14**: P_cold = P_hot + k d = 10 000 + 100 × 20 = 12 000 N; V = k d / P_hot = 0.20.
- **VC-PST-15**: De = (16 + 10)/3 = 8.6667 in; limit 500 De = 4333.33; 3 × 600 + 2000 = 3800; ratio 0.876923.

### Known biases (expected and documented, not failures)

- Euler–Bernoulli vs Timoshenko: 0.85 % on the PSI 3D rotation; llull uses Timoshenko (shear area A/2) like PSI.
- PSI asserts the reinforced-tee SIF 1.6366 while the closed form of its own formula gives 1.6256 (inside PSI's 3 %);
  llull follows the closed form; the case is context, not a gate.
- The guided-cantilever method over-predicts the L-bend stress (151 vs 107 MPa): it is a screening check, labelled so.
- PSI's thermal load uses α at the operating temperature and E at the reference temperature; llull does the same by
  default (named setting).

## What could not be verified

- NUREG/CR-1677 problem data (document host unreachable) — VC-PST-17 TBD.
- CAESAR II neutral file layout and an import test — VC-PST-16 TBD (needs a CAESAR II licence).
- B31J tables (paywalled) — VC-PST-19 TBD.
- B31.3 Table C-1 rows other than 400 °F, tee h factors by edition, NEMA cumulative limits, API 610 Table 5 beyond
  NPS 6 (grade B / C, see sources.md).
