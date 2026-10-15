# PHY-15 Electrical, magnetic, optical & radiative properties: validation pack

Proves [`../FUNCTIONAL_SPEC.md`](../FUNCTIONAL_SPEC.md) (`FR-EOP-*`) and [`../TECHNICAL_SPEC.md`](../TECHNICAL_SPEC.md)
(`TR-EOP-*`). Values are **(a) quoted** ([`sources.md`](sources.md)), **(b) derived** by
[`generate_eop_reference.py`](generate_eop_reference.py) (stdlib only; `python3 -I generate_eop_reference.py`; two runs
byte-identical), or **(c) TBD**. Every material, coating, joint and flux value is a **test input**, not a property claim:
this pack ships no property data (sources.md "Data policy findings").

## Files

| File | Kind | Content |
| ---- | ---- | ------- |
| `generate_eop_reference.py` | generator | Writes the files below |
| `expected_results.json` | (a)+(b) | VC-EOP cases (README §6.3 schema) plus the constants used |
| `skin_depth.csv` | (b) | δ(f) for 100 % IACS copper and a 61 % IACS test conductor, 50 Hz–1 GHz |
| `radiator_balance.csv` | (b) | sun-facing plate equilibrium temperature vs α/ε (flux 1361 W/m² as a test input) |
| `plans/eop_bonding_paths.plan.json` | draft plan | box + structure, two bond paths (pass / fail against a 2.5 mΩ test rule), `check_bonding` |
| `plans/eop_radiator_coating.plan.json` | draft plan | coating record (α BOL 0.2, ε 0.9 test inputs) on a panel face, `optical_balance`, `check_surface_properties` |

Plans use existing commands, proposed 08 commands, PHY-01 `define_property_model` (constant models with the `lifeState` /
`opticalKind` condition fields this pack requests from PHY-01, TECHNICAL §3.1) and the commands of TECHNICAL_SPEC §4.

## Validation cases

| VC | Proves | Setup | Expected | Tolerance | Grade | Gate |
| -- | ------ | ----- | -------- | --------- | ----- | ---- |
| VC-EOP-01 | FR-EOP-01; TR-EOP-10 | IACS conversions | 1.7241e-8 Ω·m; 5.80013e7 S/m; 61 % IACS → 2.82639e-8 Ω·m | 1e-12 / 1e-9 | A | unit |
| VC-EOP-02 | FR-EOP-02; TR-EOP-11 | 1 m × 1 mm² copper, 20 °C and 75 °C (αR 0.00393 /K test input) | 0.017241 Ω; 0.0209676 Ω | 1e-9 | A | unit |
| VC-EOP-03 | FR-EOP-03, 05; TR-EOP-12 | skin depth: copper 60 Hz, 1 MHz; ρ 1e-7, μr 100, 400 Hz | 8.53151 mm; 66.0848 µm; 0.795775 mm | 1e-6 | A | unit |
| VC-EOP-04 | FR-EOP-03; TR-EOP-12 | 2 mm copper wire at 1 MHz | R_ac/R_dc ≈ 7.566 (r/δ = 15.1, approximation valid) | 5 % (approximation) | A | unit |
| VC-EOP-05 | FR-EOP-04; TR-EOP-13 | 0.1 mm copper sheet, 1 MHz | 13.1436 dB absorption | 1e-6 | A | unit |
| VC-EOP-06 | FR-EOP-06, 07; TR-EOP-20, 21 | `plans/eop_bonding_paths.plan.json` | p1 1.723959 mΩ pass; p2 3.123959 mΩ fail + `EOP_BOND_RESISTANCE_EXCEEDED`; limit `unverified` | 1e-9 (values); exact (status, rule value grade B) | A / B | unit + golden |
| VC-EOP-07 | FR-EOP-01, 06; TR-EOP-20 | CFRP strip σx 1e4 S/m, 0.5 × 0.1 × 0.002 m | 0.25 Ω; `EOP_CFRP_IN_PATH` when used in a path | 1e-9 | A | unit |
| VC-EOP-08 | FR-EOP-08; TR-EOP-30 | `plans/eop_radiator_coating.plan.json` | 270.245 K (one face), 227.248 K (two faces), α/ε 0.2222 | 1e-6 | A | unit + golden |
| VC-EOP-09 | FR-EOP-09; TR-EOP-31 | n = 1.5 | R = 0.04; slab T = 0.923077 | 1e-12 | A | unit |
| VC-EOP-10 | FR-EOP-10; TR-EOP-02 | seven invalid property inputs | listed codes | exact | A | unit + CLI |
| VC-EOP-11 | FR-EOP-11; TR-EOP-32 | PHY-03 radiation BC `emissivity: 'material'` on the coated face | deck ε = 0.9 with provenance; `EOP_SURFACE_PROPERTY_MISSING` without coating | exact | A | integration |
| VC-EOP-12 | FR-EOP-07; TR-EOP-22 | agent `dispose_bond_check` on p2 | `EOP_HUMAN_GATE`, doc unchanged | exact | A | unit + CLI |

## CLI harness

```bash
D="--doc eop.llull.json --kernel occt --json"
llull run plans/eop_bonding_paths.plan.json $D | jq '.data.steps[-1].data.rows' > bond.json   # AF-14 step data
llull run plans/eop_radiator_coating.plan.json --doc r.llull.json --kernel occt --json > rad.json
# compare with expected_results.json through the PHY-00 benchmark runner
```

## Re-generating

```bash
cd docs/physics/15-electro-optical-properties/validation
python3 -I generate_eop_reference.py && python3 -I generate_eop_reference.py
git diff --stat .
```
