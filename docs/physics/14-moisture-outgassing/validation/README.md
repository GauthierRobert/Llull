# PHY-14 ENV — Validation pack

External facts: [sources.md](sources.md). Derived numbers:
[generate_environment_reference.py](generate_environment_reference.py) → [expected_results.json](expected_results.json)
(schema `docs/physics/README.md` §6.3).

## Files

| File | What it is | Status |
| ---- | ---------- | ------ |
| `sources.md` | 17 sources with grades; what is not verified | complete |
| `environment_rules.json` | Test methods, outgassing limit profiles (NASA GSFC ≤ 1.0 / ≤ 0.10 %, ECSS RML < 1.00 / CVCM < 0.10 %), RML definition, Kapton H erosion yield, MISSE 2 fluence, moisture model statement | draft (NASA A, ECSS B) |
| `generate_environment_reference.py` | Stdlib generator (Fick series, inverse, short-time check, outgassing screening, budgets, AO); byte-identical re-runs checked 2026-10-15; `--check` | complete |
| `expected_results.json` | 21 cases VC-ENV-01…16 | generated |
| `plans/outgassing_check_proposed.json` | 200 g panel in synthetic `syn_low`, NASA profile, check | proposed |
| `plans/moisture_uptake_proposed.json` | VC-ENV-04/05 as a plan | proposed |
| `plans/ao_erosion_proposed.json` | VC-ENV-08/10 as a plan | proposed |

No real material outgassing row is included: the NASA database host was unreachable from this session, and
synthetic values (labelled) exercise the logic instead.

## Validation cases

| VC | What | Expected | Tol. | Grade | Proves |
| -- | ---- | -------- | ---- | ----- | ------ |
| VC-ENV-01.1–3 | τ = D t/h² for 50 / 90 / 99 % uptake (two faces) | 0.0491826848809 / 0.212021352012 / 0.445321998467 | rel 1e-9 | A | FR-ENV-06, TR-ENV-05 |
| VC-ENV-02 | G(τ) at τ = 0.001…1 | e.g. G(0.05) = 0.504087820203, G(0.5) = 0.994170478926 | rel 1e-9 | A | FR-ENV-06 |
| VC-ENV-03 | Short-time limit G/((4/√π)√τ) | 1.0 at τ = 1e-6, 1e-4, 1e-3 | abs 1e-6 | A | TR-ENV-05 |
| VC-ENV-04 | Synthetic plate h 2 mm, D 1e-6 mm²/s, Mm 1.5 %, 7 d | τ 0.1512, M 1.22660470969 %, t₅₀ 2.27697615189 d | rel 1e-9 | A | FR-ENV-06, 07 |
| VC-ENV-05 | Hygro strain and ΔT_eq (β 0.001 /%, α 30e-6 /K) | ε 1.22660470969e-3, ΔT_eq 40.8868236562 K | rel 1e-9 | A | FR-ENV-08 |
| VC-ENV-06.1–4 | Synthetic outgassing under both profiles | syn_low pass/pass; syn_water fail(TML)/pass; syn_cvcm fail/fail (CVCM); syn_edge pass (≤)/fail (<: RML, CVCM) | exact | A (B for the ECSS limits) | FR-ENV-01…03, 12 |
| VC-ENV-07 | Budget of a 200 g part in syn_low | 1.9 g mass loss, 0.1 g condensable | rel 1e-9 | A | FR-ENV-04 |
| VC-ENV-08 | Kapton H recession at 1e21 atoms/cm² | 30.0 µm | rel 1e-9 | A | FR-ENV-10 |
| VC-ENV-09 | Kapton H recession at the MISSE 2 fluence | 252.9 µm | rel 1e-9 | B | FR-ENV-10 |
| VC-ENV-10 | AO mass loss, synthetic ρ 1.0 g/cm³, 10 cm² | 0.03 g | rel 1e-9 | A | FR-ENV-10 |
| VC-ENV-11 | Material without TML/CVCM | `ENV_OUTGASSING_DATA_MISSING` | exact | A | FR-ENV-05, 12, 14 |
| VC-ENV-12 | No profile | `ENV_PROFILE_UNSET` | exact | A | FR-ENV-09, 14 |
| VC-ENV-13 | Orthotropic β/α not proportional | `ENV_EQUIVALENT_TEMPERATURE_INVALID` | exact | A | FR-ENV-08 |
| VC-ENV-14 | Flags and human gate | `unverified`, `reviewRequired`, `ENV_HUMAN_GATE` | exact | A | FR-ENV-13 |
| VC-ENV-15 | CSV import mapping | one record per row; TML/CVCM/WVR; sample id + dataset version | exact | A | FR-ENV-15 |
| VC-ENV-16 | One face sealed (h 2 mm, 7 d) ≡ two faces of 4 mm | τ 0.0378, M 0.65803499174 % | rel 1e-9 | A | FR-ENV-06 |

FR-ENV-11 (UV / radiation, COULD, V2) gets its VC when a data source is chosen. FR-ENV-16 (numeric default) is
covered by VC-ENV-03.

## CLI harness (AF-23)

```bash
python3 -I generate_environment_reference.py --check
llull run plans/moisture_uptake_proposed.json --json > out.json   # data.timesToFraction[0].tau vs VC-ENV-01.1
llull run plans/outgassing_check_proposed.json --doc /tmp/env.llull.json --json   # budget vs VC-ENV-07
```

## Known gaps

Real TML/CVCM rows, Kapton density, D/Mm/β of any real material, exact NASA-STD-6016 wording, UV/radiation data.
