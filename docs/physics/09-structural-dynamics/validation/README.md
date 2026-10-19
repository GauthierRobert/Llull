# PHY-09 DYN: validation pack

Proves a future implementation of [`../FUNCTIONAL_SPEC.md`](../FUNCTIONAL_SPEC.md) (`FR-DYN-*`) and
[`../TECHNICAL_SPEC.md`](../TECHNICAL_SPEC.md) (`TR-DYN-*`). Every expected value is one of:

- **(a) quoted** from a source in [`sources.md`](sources.md) (NAFEMS FV32 via two vendor manuals; CalculiX `.dat.ref`);
- **(b) derived** by [`generate_dynamics_reference.py`](generate_dynamics_reference.py) (Python 3 standard library,
  `python3 -I generate_dynamics_reference.py`, byte-identical on re-run, checked twice on 2026-10-15);
- **(c) TBD**, with the tool that will measure it.

Tolerances are llull acceptance choices, explained per case.

## Files

| File | Kind | Content |
| ---- | ---- | ------- |
| `generate_dynamics_reference.py` | generator | Writes the four files below |
| `expected_results.json` | (a)+(b)+(c) | 31 cases VC-DYN-01…47 in the PHY README §6.3 schema |
| `sdof_frf.csv` | (b) | SDOF k\|H\|, phase, \|T\| for ζ = 0.05, r = 0…3 |
| `gevs_profile.csv` | (b) from (a) breakpoints | GEVS component qual / acceptance ASD segments: slope n, dB/oct, area |
| `srs_half_sine.csv` | (b) | half-sine SRS / A at 12 frequencies, Q = 10, exact solution and Smallwood filter |
| `calculix_dynamics_cases.json` | (a)/(c) | five CalculiX test decks (URLs at the pinned commit, sha256) and the values extracted from `beamdy8.dat.ref` |
| `plans/dyn_beamdy8_ssd.plan.json` | draft plan | native 1 × 1.5 × 8 mm beam, SSD 12–14 kHz, Rayleigh α = 5000, 100 N tip force |
| `plans/dyn_cantilever_random_gevs.plan.json` | draft plan | 100 × 20 × 3 mm steel strip on the GEVS qual ASD, ζ = 0.02, probes tip / root |
| `plans/dyn_quick_checks.plan.json` | draft plan | pure quick checks (psd_rms, sdof_response, SRS, damping_coefficients) |

Plans use existing commands (`set_units`, `add_box`, `create_material`, `assign_material`), the proposed 08 MAT
and 05 FEA commands (as in the 05 pack) and the proposed PHY-09 commands of TECHNICAL_SPEC §4. They stay drafts
until those commands exist. No third-party file is stored here (CalculiX decks are GPL: pinned by URL + sha256).

## Real use cases

| # | Use case | Evidence | Cases |
| - | -------- | -------- | ----- |
| U1 | Component random-vibration qualification to GEVS | GEVS component levels (14.1 g rms qual) [S3][S4] | VC-DYN-10, 11, 21, 43 |
| U2 | Miles' quick estimate before FE, and its limits | Miles 1954 [S5]; Miles over-estimates in many payload cases [S6] | VC-DYN-07, 11 |
| U3 | Harmonic / sine response of a bracket with Rayleigh damping | CalculiX SSD + `*MODAL DAMPING` and its regression deck beamdy8 [S1][S2] | VC-DYN-05, 06, 17, 20 |
| U4 | Pyroshock / drop: SRS of a pulse | Smallwood recursive SRS [S7][S8] | VC-DYN-13, 14 |
| U5 | Modal basis adequacy | CalculiX effective-mass tables [S1][S2] | VC-DYN-12, 22 |

## Validation cases

Status **P** (proposed) for all. Gate: `unit` = pure TS, no solver; `integration` = desktop with bundled ccx.

| VC | Proves | Setup | Expected (`expected_results.json`) | Tol. | Grade | Gate |
| -- | ------ | ----- | ---------------------------------- | ---- | ----- | ---- |
| VC-DYN-01 | FR-DYN-04; TR-DYN-20 | `sdof_response` ζ = 0.05, harmonic | k\|H(fₙ)\| = 10 = Q | 1e-9 | A | unit |
| VC-DYN-02 | FR-DYN-04 | same | r_peak = 0.997496867163, k\|H\|max = 10.0125234864 | 1e-9 | A | unit |
| VC-DYN-03 | FR-DYN-05; TR-DYN-22 | same | r₁ = 0.946110500007, r₂ = 1.04636271043, Q_hp = 9.97484240779 | 1e-9 | A | unit |
| VC-DYN-04 | FR-DYN-06 | transmissibility | \|T(1)\| = 10.0498756211; \|T(√2)\| = 1 for ζ = 0.01, 0.05, 0.2 | 1e-9 | A | unit |
| VC-DYN-05 | FR-DYN-03; TR-DYN-10/11 | `damping_coefficients` ζ = 0.02 at 10 and 100 Hz | α = 2.28479465716 1/s, β = 5.78745247607e-5 s; ζ(31.6 Hz) = 0.0114991914915 | 1e-9 | A | unit |
| VC-DYN-06 | FR-DYN-02/03; TR-DYN-10/30 | SDOF modal coordinate vs CalculiX beamdy8 (9 points) | max relative deviation 3.9e-7 (≤ 2e-6) | 2e-6 abs | A | unit (numbers in JSON) |
| VC-DYN-07 | FR-DYN-08; TR-DYN-40/41 | fₙ 100 Hz, Q 10, W 0.04 g²/Hz | Miles 7.92665459521 g; exact 7.96618927735 g; quadrature 7.96618927077 g | 1e-6 | A | unit |
| VC-DYN-08 | FR-DYN-08 | same | relative displacement rms 0.196902338045 mm | 1e-9 | A | unit |
| VC-DYN-09 | FR-DYN-09; TR-DYN-42 | Gaussian | P(\|x\| > 3σ) = 0.00269979606326 | 1e-9 | A | unit |
| VC-DYN-10 | FR-DYN-07; TR-DYN-43 | `psd_rms` GEVS qual / accept | 14.1356137191 g / 9.99538831703 g | 1e-9 | A (breakpoints B) | unit |
| VC-DYN-11 | FR-DYN-07/08 | SDOF 200 Hz, Q 10 on GEVS qual | Miles 22.4199648656 g; exact 20–2000 Hz 22.4035959181 g | 1e-6 | A | unit |
| VC-DYN-12 | FR-DYN-10; TR-DYN-31 | clamped-free beam modal compliance | cumulative 0.970688…, 0.995404…, …, 0.999812… (modes 1–6) | 1e-9 | A | unit |
| VC-DYN-13 | FR-DYN-11; TR-DYN-50/51 | `shock_response_spectrum` half-sine 11 ms, Q 10 | 12 values in JSON (peak 1.648 at 80 Hz); exact vs Smallwood 1.7e-6 | 0.5 % | A | unit |
| VC-DYN-14 | FR-DYN-11 | SRS at 1 Hz | SRS/(ωₙΔV) = 0.931239519772 | 2 % | A | unit |
| VC-DYN-15 | FR-DYN-01, 16 | NAFEMS FV32 modal pre-step (geometry TBD from `nfv32f4f.inp`) | 44.623, 130.03, 162.70, 246.05, 379.90, 391.44 Hz | 1 % | A | integration |
| VC-DYN-16 | FR-DYN-16 | NAFEMS FV52 mode 7 | **excluded** (sources disagree) | — | C | none |
| VC-DYN-17 | TR-DYN-30 | SSD point count n = 5, m = 1 | 9 points | exact | A | unit (reader) |
| VC-DYN-20 | FR-DYN-02/03; TR-DYN-60 | re-run pinned beamdy8 (1e-4); native plan `dyn_beamdy8_ssd` (2 %) | \|u_x\| node 100: 3.705…, 4.056…, 6.243…, 9.996…, 10.300…, 9.954…, 6.626…, 4.358…, 3.971… mm | 1e-4 / 2 % | B | integration |
| VC-DYN-21 | FR-DYN-06/08/10; TR-DYN-40/41 | plan `dyn_cantilever_random_gevs` | tip 76.4330589827 g rms; tip rel 0.244136808267 mm rms; root σ 27.2299399808 MPa rms (EB, 6 modes; f₁ = 251.457 Hz, f₂ = 1575.85 Hz) | 5 % | A | integration |
| VC-DYN-22 | FR-DYN-10 | beamdy8 frequency step | effective mass fractions X/Y/Z 0.9374014 / 0.9087642 / 0.8287773 | 1e-4 | B | unit (DAT fixture) |
| VC-DYN-30…32 | FR-DYN-06/12; TR-DYN-60/61 | pinned beamdy1/3, beamdy10bm, beamdynamic | **TBD** — freeze on first parse with bundled ccx | 1e-4 | TBD | integration |
| VC-DYN-40 | FR-DYN-03, 18 | random case, no damping, `fea_solve` | exit 1, `DYN_DAMPING_UNSET` | exact | A | unit + CLI |
| VC-DYN-41 | FR-DYN-09, 14 | `equivalent_static_load_case` without peakFactor | `peakFactor` = {3, "llull named default", defaulted true, rationale} | exact | A | unit + CLI |
| VC-DYN-42 | FR-DYN-18 | seven wrong set-ups | the seven codes listed in the JSON | exact | A | unit + CLI |
| VC-DYN-43 | FR-DYN-07, 20 | GEVS library spectrum | `unverified: true`, `DYN_SPECTRUM_UNVERIFIED` | exact | A | unit |
| VC-DYN-44 | FR-DYN-21 | agent `dispose_margin` | exit 1, `DYN_HUMAN_GATE`, document unchanged | exact | A | unit + CLI |
| VC-DYN-45 | FR-DYN-01, 22; TR-DYN-01/02/03/70 | plugin contract, staleness, surface equality | flags in the JSON | exact | A | contract + golden |
| VC-DYN-46 | FR-DYN-13, 15; TR-DYN-61 | V1 joint history in a transient; stress ASD CSV for PHY-07 | shape only (values TBD) | exact | A | V1 |
| VC-DYN-47 | FR-DYN-03; TR-DYN-11/12 | `structural_material` damping via the PHY-01 property API | missing → `DYN_MATERIAL_NO_DAMPING`; η 0.02 → `*DAMPING,STRUCTURAL=0.02`, ζ_eq 0.01 | exact | A | unit |
| VC-DYN-48 | FR-DYN-08, 10; TR-DYN-40, 44 | native vs reference ([RS1](../../../decisions/RS1-native-compute.md) RS-7, planned): `llull-compute post random` against `math/randomResponse.ts` on the VC-DYN-21 case (all nodes, 3 components) and seeded synthetic modal bases; then a large mesh for wall time | same nodal rms field, same nodal max and location; wall time recorded (TBD — measure) | 1e-10 rel per node (llull choice: same grid and Simpson rule in f64, only summation order may differ); location exact | — (comparison, not in `expected_results.json`) | integration |

Notes on specific cases:

- **VC-DYN-06** is the key consistency proof: the modal coordinate printed by CalculiX ("PARTICIPATION FACTORS FOR
  FREQUENCY …", mode 1) at the resonance point fixes the modal force; the SDOF formula with ζ₁ = α/(2ω₁) then
  predicts the other eight complex values to 3.9 × 10⁻⁷. llull's random post-processing uses the same formula.
- **VC-DYN-10/11/21** depend on the GEVS breakpoints, which are grade B (secondary sources). The integration is
  exact, so the cases are gated as solver/math checks; the spectrum itself carries `unverified` (VC-DYN-43).
- **VC-DYN-13** uses an 11 ms half-sine purely as an input; no claim is made about any test standard.
- **VC-DYN-15** geometry: the vertex coordinates of the FV32 membrane were not available from the sources reached
  (only 5 m root, 1 m tip, t = 0.05 m, E = 200 GPa, ν = 0.3, ρ = 8000 kg/m³); no plan is shipped until the Abaqus
  input `nfv32f4f.inp` or the NAFEMS original is read.

## CLI harness (AF-23)

```bash
D="--doc case.llull.json --kernel occt --json"
llull run plans/dyn_quick_checks.plan.json $D > quick.json                 # VC-DYN-01..14 via data.steps[*].data (AF-14)
an=$(llull run plans/dyn_cantilever_random_gevs.plan.json $D | jq -r '.data.aliases.an[0]')
llull fea_mesh analysisId=$an $D --timeout 300
llull check_dynamics analysisId=$an $D > check.json                       # no severity "error"
llull fea_solve analysisId=$an $D --timeout 900
llull dynamic_report analysisId=$an $D > report.json                      # probes tip / tip_rel / root_top vs VC-DYN-21
python3 -I compare.py report.json expected_results.json VC-DYN-21         # PHY-00 compare_to_expected
```

PHY-00's `run_benchmarks` reads `expected_results.json` directly; grade B / C / TBD cases are reported, not gated.

## Re-generating

```bash
cd docs/physics/09-structural-dynamics/validation
python3 -I generate_dynamics_reference.py   # rewrites expected_results.json and the three CSVs (~6 s)
```
