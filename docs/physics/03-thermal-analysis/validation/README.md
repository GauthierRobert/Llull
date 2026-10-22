# PHY-03 Thermal analysis: validation pack

Proves a future implementation of [`../FUNCTIONAL_SPEC.md`](../FUNCTIONAL_SPEC.md) (`FR-THM-*`) and
[`../TECHNICAL_SPEC.md`](../TECHNICAL_SPEC.md) (`TR-THM-*`). Every expected value is one of:

- **(a) quoted** from a source in [`sources.md`](sources.md);
- **(b) derived** by [`generate_thermal_reference.py`](generate_thermal_reference.py) (Python 3 standard library only,
  deterministic; run `python3 -I generate_thermal_reference.py` from this folder; two runs give byte-identical files);
- **(c) extracted** from a pinned public reference output (CalculiX `.dat.ref`), or **TBD** with the tool to measure it.

Tolerances are llull acceptance choices, justified per case below; no source claims them.

## Files

| File | Kind | Content |
| ---- | ---- | ------- |
| `generate_thermal_reference.py` | generator | Writes the four files below |
| `expected_results.json` | (a)+(b)+(c) | All VC-THM cases in the `docs/physics/README.md` §6.3 schema (`value`, `unit`, `tolerance`, `source`, `grade`, `proves`, inputs, derivation) |
| `t3_history.csv` | (b) | NAFEMS T3 analytic temperature history at x = 0.08 m and 0.05 m, t = 0…32 s |
| `t4_edge_profile.csv` | (b) | NAFEMS T4 analytic temperature along the convective edge x = 0.6 m and along y = 0.2 m |
| `view_factors.csv` | (b) | Closed-form view factors for parallel squares, perpendicular squares with a common edge, coaxial discs, over a range of aspect ratios |
| `plans/thm_nafems_t3.plan.json` | draft plan | T3 bar, transient, sine amplitude, probe at 0.08 m |
| `plans/thm_nafems_t4.plan.json` | draft plan | T4 plate as a 10 mm thick solid with adiabatic faces, two film BCs, probe E |
| `plans/thm_wall_convection.plan.json` | draft plan | VC-THM-01 wall with films on both faces |
| `plans/thm_parallel_plates_cavity.plan.json` | draft plan (V1) | Two black 1 m plates 1 m apart in an open cavity (VC-THM-09.a / 30) |
| `plans/thm_rejections.plan.json` | draft plan | Deliberately wrong set-up for VC-THM-61 |
| `sources.md` | register | Sources, access mode, grade, findings |

Plans use existing commands (`set_units`, `add_box`, `create_material`, `assign_material`), the **proposed** 08 MAT
commands (`define_material_record`, `set_material_property`, `create_material` with `name` = the record id), the **proposed** 05 commands
(`create_analysis`, `set_part_idealization`, `set_mesh_controls`, `add_result_probe`) and the thermal commands of
TECHNICAL_SPEC §4. They are drafts until those commands exist. `create_material.density` is in g per (document unit)³,
as today's command defines it (so 7.2e6 g/m³ for 7200 kg/m³ in a metre document); the 08 record carries the SI value.
Every material value is labelled "test input of this validation case (not a material claim)".

No third-party file is stored here: CalculiX decks (GPL-2.0), FeenoX and MOOSE inputs are pinned by commit in sources.md.

## Real use cases

| # | Use case | Evidence | Cases |
| - | -------- | -------- | ----- |
| U1 | Equipment stays below a temperature limit (avionics, batteries) | Owner question; convection + generation set-up identical to VC-THM-01/02 | VC-THM-01, 02, 62 |
| U2 | Transient heating (brakes, duty cycles) | NAFEMS T3 is the standard 1D transient benchmark, reproduced by Abaqus, MOOSE, FeenoX, FEATool [S1–S4] | VC-THM-03, 06, 07 |
| U3 | Radiating surfaces (spacecraft, hot structure) | CalculiX `*RADIATE` and cavity radiation exist and are tested (`oneel8ra`, `beamhtcr`) [S7]; NAFEMS T2 [S3] | VC-THM-05, 09, 10, 14 |
| U4 | Input to thermal stress | PHY-04 reads the temperature field | VC-THM-50 |

## Validation cases

Status: **P** (proposed). "FE" = run through `fea_mesh` / `fea_solve` on the desktop with the bundled CalculiX.

| VC | Proves | Setup | Expected (`expected_results.json`) | Tolerance (why) | Grade | Gate |
| -- | ------ | ----- | ---------------------------------- | --------------- | ----- | ---- |
| VC-THM-01 | FR-THM-01, 03, 12; TR-THM-10, 31 | FE `plans/thm_wall_convection.plan.json` (tet10, h = 0.05 m) + `thermal_analytic_check plane_wall` | q = 1459.46 W/m²; Ts1 = 170.811 °C; Ts2 = 165.946 °C; heat-balance residual 0 | 0.5 % / 0.05 K (1D linear field: quadratic elements are exact up to round-off); residual ≤ 1e-3 | A | integration + unit |
| VC-THM-02 | FR-THM-04; TR-THM-12 | slab with q''' = 1e7 W/m³, half thickness 10 mm, k = 20, faces at 50 °C | Tmax = 75.0 °C | 0.5 % (parabolic field, exact for quadratic elements) | A | integration + unit |
| VC-THM-03 | FR-THM-02, 07; TR-THM-13 | FE `plans/thm_nafems_t3.plan.json`, fixed 0.5 s increments | 36.6 °C at x = 0.08 m, t = 32 s (analytic series: 36.6031 °C) | 2 % (MOOSE / Abaqus quadratic fine meshes are within 1.4–3 % [S1, S2]) | A | quality gate |
| VC-THM-04 | FR-THM-01, 03; TR-THM-10 | FE `plans/thm_nafems_t4.plan.json` | 18.2538 °C at (0.6, 0.2) m (NAFEMS 18.3 rounded) | 1 % (smooth steady field) | A | quality gate |
| VC-THM-05 | FR-THM-05; TR-THM-14 | FE 1D slab 0.1 m (any cross-section, side faces adiabatic), left 1000 K, right radiates ε = 0.98 to 300 K, σ = 5.67e-8 | T(0.1) = 927.008 K | 0.1 % (linear field, nonlinear BC solved to convergence) | A (B statement) | integration |
| VC-THM-06 | FR-THM-02 | `thermal_analytic_check semi_infinite` (+ optional FE on a 0.1 m bar, 10 s) | 106.310 °C | 1 % | A | unit |
| VC-THM-07 | FR-THM-02, 14; TR-THM-40 | `thermal_analytic_check lumped` | T(60 s) = 153.493 °C; Bi = 4.17e-4 (valid) | 1 % / 1e-9 | A | unit |
| VC-THM-08 | FR-THM-03, 14 | `thermal_analytic_check fin` (pin fin) | η = 0.761594 | 1 % | A | unit |
| VC-THM-09 | FR-THM-06; TR-THM-20 | `compute_view_factors` on `plans/thm_parallel_plates_cavity.plan.json`, and synthetic cube faces | F = 0.199825 (parallel), 0.200044 (perpendicular), cube sum = 1, discs 0.381966 | 0.002 abs (facet discretisation), 1e-9 on the closed-form sum | A | unit (OCC) |
| VC-THM-10 | FR-THM-05, 06; TR-THM-21 | `thermal_analytic_check parallel_plates`; FE two large plates (V1) | q = 441.029 W/m² | 1 % | A | unit / integration |
| VC-THM-11 | FR-THM-08; TR-THM-15 | FE two stacked slabs with tied contact + gap conductance 2000 W/(m² K) (V1) | q = 64 864.9 W/m²; interface jump 32.43 K | 0.5 % / 1 % | A | integration (V1) |
| VC-THM-12 | FR-THM-09; TR-THM-16 | FE 1D melting with the apparent-heat-capacity table (V2) | λ = 0.245731; front 11.15 mm at 3600 s | 3 % on the front (smearing over the melting range) | A | integration (V2) |
| VC-THM-13 | FR-THM-05; TR-THM-14 | deck writer | σ = 5.670 374 419 18e-8 W/(m² K⁴) (SI); 5.670 374 419e-11 in N-mm-t-s | 1e-9 | A | unit |
| VC-THM-14 | FR-THM-05, 11, 12; TR-THM-14, 30, 31 | run the pinned CalculiX `test/oneel8ra.inp` (sha256 in JSON) and parse | radiating face −0.950739 °C; Σ RFL 47.5369 W (CalculiX ref −9.507386E-01, 4 × 11.88423) | 1e-4 | A | integration |
| VC-THM-30 | FR-THM-06; TR-THM-20, 21 | VC-THM-09.a geometry: CalculiX cavity F12 (inferred from the cavity heat flow) vs llull | 0.199824895698 (ccx 2.21: 0.1998337 converged) | 0.0005 abs | A (pinned 2026-10-17) | integration (V1) |
| VC-THM-50 | FR-THM-15, 18; TR-THM-32 | solved T3, then `set_parameter` on the bar length | `state: "stale"`; limits refused with `FEA_RESULTS_STALE`; dependent PHY-04 case stale | exact | A | golden |
| VC-THM-60 | FR-THM-20; TR-THM-50 | any radiation case, `analysis_report` | `physicalConstants` equals the JSON (σ, absolute zero, sources, `defaulted: true`) | exact | A | unit + CLI |
| VC-THM-61 | FR-THM-21; TR-THM-51 | `plans/thm_rejections.plan.json` + the listed variants | each returns its code, non-empty `remediation`, ids or path | exact | A | unit + CLI |
| VC-THM-62 | FR-THM-13, 22, 23; TR-THM-52 | VC-THM-01 with a 150 °C max limit (test input) | row FAIL, margin −20.8108 K, `reviewRequired`, `pending_human`; agent disposition → `THM_HUMAN_GATE`, doc unchanged | exact (margin 1e-6) | A | unit + CLI |
| VC-THM-63 | FR-THM-22; TR-THM-50 | VC-THM-01 with k at basis `typical` | `unverified: true` on report and rows; `THM_MATERIAL_UNVERIFIED` | exact | A | unit |
| VC-THM-64 | FR-THM-06; TR-THM-20 | native vs reference ([RS1](../../../decisions/RS1-native-compute.md) RS-6, built 2026-10-21: bit-identical, crate fixture + `server/tests/geomqNative.test.ts`; 12 416 facets in 104 s on the CPU): `llull-compute geomq` against `computeViewFactors.ts` on the VC-THM-09 geometries and seeded cavities ≤ 400 facets, centroid obstruction test; then the largest cavity per device | same face matrix and row sums as TS; max facet count and wall time recorded (target ~10⁴ facets) | Rust-CPU twin: 1e-9 abs per face factor (llull choice: same quadrature in f64, only summation order differs); GPU: TBD — measure | — (comparison, not in `expected_results.json`) | native + integration |

## CLI harness (AF-23)

```bash
D="--doc case.llull.json --kernel occt --json"
an=$(llull run plans/thm_nafems_t3.plan.json $D | jq -r '.data.aliases.an[0]')    # AF-14 aliases
llull fea_mesh analysisId=$an $D --timeout 300 > mesh.json
llull check_thermal analysisId=$an $D > check.json             # no severity "error"
llull fea_solve analysisId=$an $D --timeout 900 > solve.json
llull analysis_report analysisId=$an $D > report.json           # probes[x080].series at t = 32
# compare with expected_results.json VC-THM-03 through the PHY-00 benchmark runner (command name owned by PHY-00)
```

The PHY-00 runner reads `value`, `tolerance` and `unit` from `expected_results.json`; cases with `grade` `B`, `C` or
`TBD` are reported but never fail the gate.

## Re-generating

```bash
cd docs/physics/03-thermal-analysis/validation
python3 -I generate_thermal_reference.py && python3 -I generate_thermal_reference.py
git diff --stat .        # empty unless the generator changed
```
