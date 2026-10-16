# PHY-13 COR — Validation pack

External facts: [sources.md](sources.md). Derived numbers:
[generate_corrosion_reference.py](generate_corrosion_reference.py) → [expected_results.json](expected_results.json)
(schema `docs/physics/README.md` §6.3).

## Files

| File | What it is | Status |
| ---- | ---------- | ------ |
| `sources.md` | 19 sources with grades and the list of what is not verified | complete |
| `galvanic_anodic_index.csv` | Anodic index per group (non-889 screening); graphite `tbd` | B (secondary values) |
| `anodic_index_limits.csv` | 0.15 / 0.25 / 0.50 V per environment | A (two independent pages; rule of thumb) |
| `compatibility_rules.json` | Rule table COR-R-01…07 with method, threshold, scope limits, remedy vocabulary, grades | draft |
| `scc_classes.json` | MSFC-STD-3029A structure + the secondary facts found; every table row `tbd` | partial |
| `generate_corrosion_reference.py` | Stdlib generator; byte-identical re-runs checked 2026-10-15; `--check` | complete |
| `expected_results.json` | 26 cases VC-COR-01…16 | generated |
| `plans/contact_boxes_current.json` | The plate + block geometry; uses only existing commands (`add_box` with `anchor:"min"`, `measure_bounding_box`); not executed in this session (CLI dependencies not installed) | current commands |
| `plans/galvanic_plate_check_proposed.json` | Proposed end-to-end plan: materials, groups, environment, `find_contacts`, check, isolation, re-check | proposed |

## Validation cases

| VC | What | Expected | Tol. | Grade | Proves |
| -- | ---- | -------- | ---- | ----- | ------ |
| VC-COR-01.1 | Block on plate | face, 1800 mm², normal z | rel 1e-9 | A | FR-COR-01, 02 |
| VC-COR-01.2 | Block 0.5 mm into the plate | interference, 900 mm³ | rel 1e-9 | A | FR-COR-01 |
| VC-COR-01.3 | Gap 0.05 mm, tol 0.1 mm | face, 1800 mm², gap 0.05 | rel 1e-9 | A | FR-COR-01 |
| VC-COR-01.4 | Gap 0.2 mm, tol 0.1 mm | none | exact | A | FR-COR-01 |
| VC-COR-01.5 | Corner-to-corner along an edge | edge, area 0 | exact | A | FR-COR-01 |
| VC-COR-01.6 | Partial side face | face, 100 mm², normal x | rel 1e-9 | A | FR-COR-01 |
| VC-COR-02.1–6 | Anodic screening of 6 couples (ΔV, anode, verdict per environment), e.g. 7075/Ti ΔV 0.60 incompatible everywhere; 2024/Ti 0.45 compatible only controlled; 7075/Cd 0.05 compatible, Cd anodic | see JSON | abs 1e-12 | B | FR-COR-05, 06 |
| VC-COR-03 | Aa/Ac for a Cd-plated block (anode) on the 7075 plate | 0.346153846154 (4500/13000 mm²) + `COR_SMALL_ANODE` | rel 1e-9 | A | FR-COR-07 |
| VC-COR-04 | 889D compatible threshold | 0.2286 µm/yr (0.009 mil/yr) | rel 1e-9 | B | FR-COR-04 |
| VC-COR-05 | HE threshold | 1241.05631277 MPa (180 ksi) | rel 1e-9 | B | FR-COR-10, 14 |
| VC-COR-06 | HE flags | 4340 260 ksi Cd → true; 4130 670 MPa Cd → false; 4340 unplated → false | exact | A | FR-COR-10 |
| VC-COR-07 | CFRP on 7075, no isolation | `COR_CFRP_ALUMINIUM` | exact | B | FR-COR-08 |
| VC-COR-08 | After `declare_isolation glass_isolation_ply` | `pass_isolated`, `reviewRequired` | exact | A | FR-COR-09, 12 |
| VC-COR-09 | Graphite in anodic screening | `COR_GROUP_VALUE_MISSING` | exact | A | FR-COR-05, 13 |
| VC-COR-10 | 889D scheme, matrix not transcribed | `COR_889_TABLE_MISSING` | exact | A | FR-COR-04, 13 |
| VC-COR-11 | 7075-T6 in ST, no SCC row | `COR_SCC_UNCLASSIFIED` | exact | A | FR-COR-11, 13 |
| VC-COR-12 | Stack contacts (2 plates, bolt, washer nut side, nut) | 5 pairs, `source: "stack"` | exact | A | FR-COR-03 |
| VC-COR-13 | Cd-plated steel part group | `cadmium_plate` (outer layer) | exact | A | FR-COR-15 |
| VC-COR-14 | `anodicIndex` override 0.80 V vs Cd 0.95 V | ΔV 0.15 = harsh limit ⇒ compatible (≤) | abs 1e-12 | A | FR-COR-16 |
| VC-COR-15 | Review flags and human gate | `reviewRequired` on every item; agent acceptance ⇒ `COR_HUMAN_GATE` | exact | A | FR-COR-17, 18 |
| VC-COR-16 | CSV report header | 12 columns | exact | A | FR-COR-19 |

FR-COR-20 (environment zones, COULD, V2) gets its VC when the zone model is specified.

B-grade verdicts are reported, not gating, until the anodic indices are confirmed from a primary table (or
replaced by 889D cells). The A-grade code cases (VC-COR-08…12) gate the "missing data never passes" rule.

## Note on the 7075 / titanium verdict

The screening rule says 7075 with titanium is incompatible in every environment (ΔV 0.60). Aerospace practice
installs titanium fasteners in aluminium with a remedy (wet installation with sealant, S10, S16). llull's output
is therefore "fail by the screening rule, remedies: …", and a human decides — exactly the AF-33/34 split.

## CLI harness (AF-23)

```bash
python3 -I generate_corrosion_reference.py --check
llull run plans/galvanic_plate_check_proposed.json --doc /tmp/cor.llull.json --json > out.json
# assert: find_contacts step pairs[0].kind == "face", areaMm2 == 1800 (VC-COR-01.1)
# assert: first check item code == "COR_GALVANIC_INCOMPATIBLE", inputs.differenceV == 0.6 (VC-COR-02.2)
# assert: last check item status == "pass_isolated", reviewRequired == true (VC-COR-08)
```

## Known gaps

MIL-STD-889D cells, MSFC-STD-3029A rows, graphite index, any numeric area-ratio limit, and an HE threshold from
a NASA standard were not reached (see sources.md).
