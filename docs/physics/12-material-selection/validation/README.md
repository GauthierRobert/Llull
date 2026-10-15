# PHY-12 SEL — Validation pack

How to prove that a future implementation of material selection and substitution is correct. External facts:
[sources.md](sources.md) (S-ids). Derived numbers: [generate_selection_reference.py](generate_selection_reference.py)
→ [expected_results.json](expected_results.json) (schema: `docs/physics/README.md` §6.3).

## Files

| File | What it is | Status |
| ---- | ---------- | ------ |
| `sources.md` | Sources with grades and what could not be verified | complete |
| `performance_indices.csv` | The rule table (AF-30): 7 cases, constraint, free variable, exponent, index, derivation | complete (A, re-derived) |
| `selection_materials.json` | Synthetic materials (labelled, algorithm tests) and the worked-example inputs with source, basis and status | partial (CFRP density, 4130 ν `tbd`) |
| `generate_selection_reference.py` | Stdlib generator; `python3 -I generate_selection_reference.py` writes the JSON, `--check` fails when stale. Re-runs are byte-identical (checked 2026-10-15) | complete |
| `expected_results.json` | 39 cases VC-SEL-01…22 | generated |
| `plans/compare_bracket_materials_proposed.json` | Proposed plan: library import, `compare_materials`, `check_material_selection` | proposed (commands do not exist yet) |
| `plans/substitute_block_ti_proposed.json` | The 08 7075 block (runs today up to `mass_properties`, 140.5 g) followed by `substitute_material` | first 5 steps run on today's llull |

## Validation cases

| VC | What | Expected (from JSON) | Tolerance | Grade | Proves |
| -- | ---- | -------------------- | --------- | ----- | ------ |
| VC-SEL-01.1–7 | Mass exponent n of each index, measured from a numerical minimum-mass solve | 1, 1, 0.5, 0.666…, 0.333…, 0.5, 0.5 | abs 1e-9 | A (analytic) | FR-SEL-01, TR-SEL-03 |
| VC-SEL-02.* | Beam stiffness index of 5 synthetic materials | e.g. syn_a 4.18330013267 GPa^½/(Mg/m³) | rel 1e-9 | A | FR-SEL-01, 02 |
| VC-SEL-03 | Ranking by beam stiffness | syn_d, syn_a, syn_e, syn_b, syn_c | exact | A | FR-SEL-03 |
| VC-SEL-04 | Constraints strength ≥ 550 MPa, T ≥ 110 °C | syn_b, syn_c, syn_d | exact | A | FR-SEL-04 |
| VC-SEL-05 | Pareto (relative mass, relative cost) | syn_a, syn_c, syn_d | exact | A | FR-SEL-05, 14 |
| VC-SEL-06 | Weighted 0.7 / 0.3 | syn_d, syn_a, syn_e, syn_b, syn_c | exact | A | FR-SEL-05 |
| VC-SEL-07.* | syn_a → syn_b ratios: mass 2, stiffness 1.571…, deflection 0.636…, beam 1.59545, panel 1.72028, tie strength 1.111…, modal frequency 0.886405, buckling 1.571… | — | rel 1e-9 | A | FR-SEL-07, TR-SEL-08 |
| VC-SEL-08 | Rescaled MS 0.25 → 1.25 | 1.25 | rel 1e-9 | A | FR-SEL-08, TR-SEL-09 |
| VC-SEL-09 | Two-bar indeterminate forces: equal for Al and steel (666.67 / 333.33 N), different when mixed (857.14 / 142.86 N) | — | rel 1e-9 | A | FR-SEL-09 |
| VC-SEL-10 | 7075-T6 block mass (typical 2.81 g/cm³) | 140.5 g, `unverified: true` | rel 1e-9 | B | FR-SEL-07, 11 |
| VC-SEL-11 | Ti-6Al-4V block mass (0.160 lb/in³) | 221.439237682 g | rel 1e-9 | B | FR-SEL-07, 11 |
| VC-SEL-12 | Ti vs 7075 equal-stiffness beam mass ratio | 1.25102705013 | rel 1e-9 | B (E Ti secondary) | FR-SEL-07 |
| VC-SEL-13 | 4130 vs 7075 equal-stiffness beam mass ratio | 1.70518325871 | rel 1e-9 | B | FR-SEL-07 |
| VC-SEL-14 | CFRP row excluded | `SEL_PROPERTY_MISSING`, missing density | exact | A | FR-SEL-10 |
| VC-SEL-15 | Yield MS at 300 MPa: 7075 0.676667, Ti 1.895798, 4130 0.466667, CFRP null | — | rel 1e-9 | B | FR-SEL-08, 11 |
| VC-SEL-16 | Mixed bases in the worked example | `SEL_BASIS_MIXED` | exact | A | FR-SEL-12, 17, 19 |
| VC-SEL-17 | CFRP via layup Ex 69.6757 GPa | `SEL_ANISOTROPIC` | exact | A | FR-SEL-15 |
| VC-SEL-18 | Chart guide slopes 1, 2, 3, 2 (E-based cases) | — | abs 1e-12 | A | FR-SEL-18 |
| VC-SEL-19 | User index without derivation note | `SEL_DERIVATION_NOTE_MISSING` | exact | A | FR-SEL-06 |
| VC-SEL-20 | Temperature outside a PHY-01 model range | excluded, PHY-01 `PROP_*` code forwarded, nothing imputed | exact | A | FR-SEL-13 |
| VC-SEL-21 | Material changed on a released item without ECO | `SEL_SUBSTITUTION_RELEASED` | exact | A | FR-SEL-16, 17 |
| VC-SEL-22 | Named defaults (weights, ν tolerance, yield factor) | `defaulted: true` with source | exact | A | FR-SEL-20 |

**B-grade cases are reported, not gating** (README §6.3) until the inputs are re-verified from a primary
source. They also demonstrate AF-32: every worked-example result carries `unverified: true`.

## Worked example (what the owner would hear)

"Same shape in Ti-6Al-4V: 221 g instead of 140.5 g (+57.6 %). For the same bending stiffness a re-sized Ti
beam would still be 25 % heavier; 4130 steel 71 % heavier. Ti has the highest strength-per-weight (196 vs 179
MPa/(g/cm³)). Inputs are typical or secondary values (Ti modulus from one secondary page), so none of this is
an allowable; a qualified engineer must decide." Numbers: VC-SEL-10…15.

## CLI harness (AF-23)

```bash
cd docs/physics/12-material-selection/validation
python3 -I generate_selection_reference.py --check
llull run plans/substitute_block_ti_proposed.json --doc /tmp/sel.llull.json --json > out.json
# compare out.json last-step data.mass.afterG with VC-SEL-11 (rel 1e-9 on closed-form volume)
```

## Known gaps

- CFRP density and laminate strength (06 owns FPF) → `tbd`.
- No A/B-basis worked example: MMPDS is licensed; the M&P reviewer re-runs the example with a licensed library.
- No cost or CO₂ figures (ICE licence, S7); only synthetic.
