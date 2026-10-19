# PHY-04 Thermo-mechanical coupling & thermal fits: validation pack

Proves [`../FUNCTIONAL_SPEC.md`](../FUNCTIONAL_SPEC.md) (`FR-TMC-*`) and [`../TECHNICAL_SPEC.md`](../TECHNICAL_SPEC.md)
(`TR-TMC-*`). Values are **(a) quoted** ([`sources.md`](sources.md)), **(b) derived** by
[`generate_thermomech_reference.py`](generate_thermomech_reference.py) (stdlib only; `python3 -I generate_thermomech_reference.py`;
two runs byte-identical), or **(c) TBD**. Tolerances are llull acceptance choices.

## Files

| File | Kind | Content |
| ---- | ---- | ------- |
| `generate_thermomech_reference.py` | generator | Writes the files below; every closed form is checked against an independent form |
| `expected_results.json` | (a)+(b) | VC-TMC cases in the README §6.3 schema |
| `fit_at_temperature.csv` | (b) | 20 mm H7/g6 clearances at −55 / 20 / +85 °C for Al–steel, Ti–steel, steel–Al, CFRP–steel pairs |
| `thick_cylinder_profile.csv` | (b) | σr, σθ, σz through the wall (integral form and Simpson quadrature) |
| `cte_conversion.csv` | (b) | instantaneous, secant (ref 20 °C and 0 °C) CTE and thermal strain for a linear test law |
| `plans/tmc_nafems_le11.plan.json` | draft plan | LE11 quarter model: FeenoX profile revolved 90° about z; expression field `hypot(x, y) + z`; probe A |
| `plans/tmc_restrained_bar.plan.json` | draft plan | 100 × 10 × 10 mm bar, axial ends fixed, uniform 120 °C, reference 20 °C |
| `plans/tmc_thick_cylinder_sequential.plan.json` | draft plan | `heat_steady` quarter tube (bore 120 °C, outer 20 °C) then `thermo_static` reading it (same mesh) |
| `plans/tmc_bimetal_cantilever.plan.json` | plan (replayed by a unit test; FE run in `server/tests/feaThermomechTransient.test.ts`) | two bonded 50 x 1 x 0.5 mm layers (E 200 / 100 GPa, alpha 12 / 19 ppm per K), clamped at x = 0, uniform 120 °C, reference 20 °C, conformal mesh; tip uz and curvature vs VC-TMC-04 |
| `plans/tmc_fit_al_steel.plan.json` | draft plan | Al housing Ø20 H7 bore, steel shaft Ø20 g6 (03 PMI, explicit limits), `fit_at_temperature` at −55 / 20 / 85 °C |

Plans use existing commands (`set_units`, `add_box`, `add_cylinder`, `boolean`, `draw_arc`, `draw_polyline`,
`revolve_profile`, `create_material`, `assign_material`), proposed 08 / 05 / 03 / PHY-03 commands, and the commands of
TECHNICAL_SPEC §4. They stay drafts until those exist. The LE11 plan assumes `revolve_profile` with `angle: π/2` sweeps
from +x towards +y; the symmetry-face points must be re-checked when the plan is first run (golden test). All material
values are test inputs.

## Real use cases

| # | Use case | Evidence | Cases |
| - | -------- | -------- | ----- |
| U1 | Mixed-material fit across an operating range | 7–41 µm at 20 °C becomes −10.3 µm possible interference at −55 °C (Al housing, steel shaft) | VC-TMC-06 |
| U2 | Thermal stress in restrained or unevenly heated parts | NAFEMS LE11 and T1 [S1–S3]; classical restrained and thick-cylinder results | VC-TMC-01, 02, 03, 05 |
| U3 | Thermal distortion of flat mounting faces | gradient curvature closed form | VC-TMC-08 |
| U4 | Shrink-fitted bushes at temperature | Lamé; joint loose at 85 °C in the test case | VC-TMC-09 |

## Validation cases

| VC | Proves | Setup | Expected | Tolerance (why) | Grade | Gate |
| -- | ------ | ----- | -------- | --------------- | ----- | ---- |
| VC-TMC-01 | FR-TMC-01, 03; TR-TMC-11 | `plans/tmc_restrained_bar.plan.json` (uniaxial); plate and block variants | −252 / −360 / −630 MPa | 0.5 % (uniform field, exact for any element) | A | integration |
| VC-TMC-02 | FR-TMC-01, 02; TR-TMC-10, 12 | `plans/tmc_nafems_le11.plan.json`, tet10 | σzz(A) = −105 MPa | 3 % (FeenoX tet10 −105.9, Abaqus C3D20 fine −103.3) | A | quality gate |
| VC-TMC-03 | FR-TMC-01, 17 | NAFEMS T1 (FeenoX statement), plane stress quarter plate, `thermal_stress_check inclusion` | σθ(a⁺) = 50 MPa; σy(1.005, 0) = 49.5037 MPa; inside −50 MPa | 2 % (finite plate, nodal averaging at the interface) | A (B statement) | integration + unit |
| VC-TMC-04 | FR-TMC-05, 17; TR-TMC-13 | `thermal_stress_check bimetal`; FE: `plans/tmc_bimetal_cantilever.plan.json` (conformal two-material mesh, M4b) | κ = 1.018182e-3 1/mm; cantilever tip 1.27273 mm | 2 % / 3 % (beam theory vs solid) | A | unit + FE (skips without Gmsh / CalculiX; not yet measured) |
| VC-TMC-05 | FR-TMC-02, 06; TR-TMC-10 | `plans/tmc_thick_cylinder_sequential.plan.json` | σθ(a) = −209.824, σθ(b) = 133.033, σz(a) = −209.824 MPa | 2 % (log field interpolated by quadratic elements) | A | integration |
| VC-TMC-06 | FR-TMC-07; TR-TMC-20 | `plans/tmc_fit_al_steel.plan.json` and the other pairs of the CSV | −55 °C c_min −0.0102560375 mm (`interference_possible`); +85 °C c_max 0.055996345 mm; steel/Al +85 °C c_min −0.007939535 mm; 20 °C 0.007 / 0.041 mm | 1e-7 mm (pure arithmetic) | A (limits B) | unit |
| VC-TMC-07 | FR-TMC-04, 09; TR-TMC-15 | CTE conversion unit test | α_sec(120; 20) = 2.25e-5, α_sec(120; 0) = 2.24e-5, ε_th(20→120) = 2.25e-3 for both references | 1e-9 | A | unit |
| VC-TMC-08 | FR-TMC-08; TR-TMC-16 | `thermal_stress_check gradient_beam`; FE beam with linear through-thickness field + `thermal_distortion_report` | κ = 9.2e-5 1/mm; mid-span bow 2.875 mm; tip 11.5 mm; stress 0 | 1–2 % | A | unit + integration |
| VC-TMC-09 | FR-TMC-07, 10; TR-TMC-21 | `fit_at_temperature` with `hubOuterDiameter = 40 mm` (V1) | p = 54.6468 MPa at max interference (20 °C); at 85 °C max interference 0.02005 mm, min −0.01395 mm → `clearance_possible`, `TMC_FIT_LOOSE` | 1 % / 1e-7 mm | A (limits B) | unit (V1) |
| VC-TMC-10 | FR-TMC-16; TR-TMC-23, 24 | native vs reference ([RS1](../../../decisions/RS1-native-compute.md) RS-7, planned): `llull-compute post map` against `thermomech/mapping.ts` on the VC-TMC-05 sequential meshes (3 mm thermal onto 2 mm mechanical) and a 200k-node case | same containing element per node, same outside-node count and `maxMappingDistance`, same mapped temperatures; wall time recorded (budget ≤ 5 s, §8; TBD — measure) | element and counts exact; temperatures ≤ 1e-9 of the field magnitude (the pack's own coincident-node check, TR-TMC-23 / §14) | — (comparison, not in `expected_results.json`) | integration |
| VC-TMC-50 | FR-TMC-14; TR-TMC-10 | VC-TMC-05, then edit the thermal BC | mechanical result stale; margins refused | exact | A | golden |
| VC-TMC-60 | FR-TMC-03, 11; TR-TMC-30 | missing reference / spec temperature | `TMC_REFERENCE_TEMPERATURE_MISSING`, `TMC_SPEC_TEMPERATURE_MISSING` | exact | A | unit + CLI |
| VC-TMC-61 | FR-TMC-12; TR-TMC-31 | the seven wrong set-ups listed in the JSON | each code with remediation | exact | A | unit + CLI |
| VC-TMC-62 | FR-TMC-07, 13 | VC-TMC-06 rows | `reviewRequired: true`, provenance formula, `unverified` OR | exact | A | unit |
| VC-TMC-63 | FR-TMC-13; TR-TMC-32 | agent `dispose_fit_result` | `TMC_HUMAN_GATE`, doc unchanged | exact | A | unit + CLI |

## CLI harness (AF-23)

```bash
D="--doc fit.llull.json --kernel occt --json"
llull run plans/tmc_fit_al_steel.plan.json $D > run.json            # last step data = FitResult
jq '.data.steps[-1].data.rows' run.json > rows.json                 # AF-14 step data
# compare rows with expected_results.json VC-TMC-06.* through the PHY-00 runner

an=$(llull run plans/tmc_restrained_bar.plan.json $D | jq -r '.data.aliases.an[0]')
llull fea_mesh analysisId=$an $D && llull check_thermo_mechanical analysisId=$an $D && llull fea_solve analysisId=$an $D
llull fea_report analysisId=$an $D > report.json                    # probe mid stress_xx vs VC-TMC-01.a
```

## Re-generating

```bash
cd docs/physics/04-thermo-mechanical/validation
python3 -I generate_thermomech_reference.py && python3 -I generate_thermomech_reference.py
git diff --stat .
```

## M4b checks (unit tests, not in `expected_results.json`)

| Check | Setup | Expected | Test |
| ----- | ----- | -------- | ---- |
| Transient coupled deck | `set_thermal_step` on a coupled case | `*COUPLED TEMPERATURE-DISPLACEMENT` with DELTMX / DIRECT / increment row, `*TIME POINTS`, amplitudes, specific heat, pre-heating `*STATIC` step iff start != T_ref | `tests/unit/cae/thermomech/coupledTransient.test.ts` |
| Per-increment results | hand-built FRD sets | series, peaks, time offset of a pre-heating step | same |
| Orthotropic CTE | cte / thermalStrain models per direction | `*EXPANSION, TYPE=ORTHO` rows, `*ORIENTATION`, codes | `tests/unit/cae/thermomech/orthoCte.test.ts` |
| Stack-up at temperature | housing 50 ±0.05 (23 ppm per K) − shaft 49.5 ±0.03 (12 ppm per K), 20 / 100 °C | closed form to 1e-12: mean 0.5 → 0.54448 mm, worst case ±0.0801208, RSS ±0.0584033 | `tests/unit/cae/thermomech/stackup.test.ts` |
| Bimetal plan | `plans/tmc_bimetal_cantilever.plan.json` | replays; inputs = VC-TMC-04; deck per layer | `tests/unit/cae/thermomech/bimetal.test.ts` |
