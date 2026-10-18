# Gap 08 DAT — Validation pack

This pack proves that llull's plant data layer (classes, tags, hierarchy, reports, Excel round trip, IFC 4.3 piping
export) is right. Every expected value comes from one of three places, listed in [sources.md](sources.md):

- a closed form of this pack (tag-format grammar, centreline lengths, row counts of a plan), with the derivation in
  the data file;
- a reference file built and checked with a reference implementation (IfcOpenShell 0.9.0 for IFC 4.3, ifctester 0.9.0
  for IDS, openpyxl 3.1.5 for XLSX);
- a third-party file measured with that reference implementation (buildingSMART IFC 4.3 ADD2 samples).

**No expected value was produced by running llull.** The plant data commands do not exist yet; the plans flag every
command that is not built (`"unbuilt": true`).

## How the cases run

- Unit tests read the JSON files below directly (`tests/unit/plant/data/*.test.ts`, `tests/unit/plant/exchange/*.test.ts`).
- `tests/unit/plant/scenarioPlans.test.ts` runs every plan in `plans/` through `build_project`, which is the path of
  `llull run plan.json`, and compares the `expected` rows (AF-23).
- The schema-validity case (VC-DAT-06) needs IfcOpenShell. It runs in the production gate when Python is available
  (`npm run production`, oracle `tests/production/oracle/ifc.ts` gains a `python3 -m ifcopenshell.validate --rules`
  call). Without Python it is skipped with a reason and the TypeScript structural checks of VC-DAT-07/08 still run.

## Gate policy

Only grade A values and closed forms are pass / fail thresholds. CFIHOS column names (grade C) are not gated: VC-DAT-16
gates only row counts and the `unverified` flag. Grade B sources (Plant 3D, E3D behaviour) shape requirements, not
numbers.

## Files

| File | Content | Grade |
| ---- | ------- | ----- |
| `data/bsi/IFC4X3_ADD2_Infra-Plumbing.ifc` | buildingSMART sample: 24 `IfcPipeSegment`, 1 `IfcDistributionSystem` (26 members), no ports (CC BY 4.0) | A |
| `data/bsi/IFC4X3_ADD2_Building-Hvac.ifc` | buildingSMART sample: duct segment, 2 air terminals, 1 system (3 members) | A |
| `data/reference/sc-dat-01-reference.ifc` | target IFC4X3_ADD2 of plan SC-DAT-01 (tank, pump, 5 segments, 3 bends, 19 ports, 9 connections, 2 pipelines), schema + EXPRESS-rule valid | A |
| `data/reference/sc-dat-02-reference.ifc` | target of SC-DAT-02 (2 valves ISOLATING / CHECK, 1 elbow) | A |
| `data/reference/sc-dat-02-negative.ifc` + `.validate.json` | SC-DAT-02 with a self-connected port, a USERDEFINED valve without ObjectType and a duplicate tag; the validator reports exactly 2 rule errors | A |
| `data/reference/*.stats.json`, `bsi_sample_stats.json` | entity counts, ports, connections, open ports, PredefinedTypes, duplicate tags, system members (IfcOpenShell) | A |
| `data/reference/plant-handover.ids` + `ids_results.json` | IDS 1.0 minimum handover requirements and the ifctester results on all five IFC files | A |
| `data/reference/equipment-list-sc-dat-01*.xlsx` | Excel round-trip fixtures (original and edited) | A |
| `data/reference/ifc4x3_add2_plant_schema_facts.json` | IFC4X3_ADD2 enumerations, attributes, subtypes and Pset templates used by the mapping tables, with the cross-check against the buildingSMART repository | A |
| `data/tag_format_cases.json` | tag formats, 9 generation cases, 13 validation cases, 3 uniqueness cases | closed form |
| `data/sc_dat_01_reports_expected.json` | line list, equipment list, nozzle schedule, MTO and tag register of SC-DAT-01, derivation inside | closed form |
| `data/scripts/*.py` | generators of the files above (run with `python3 -I`, see sources.md) | — |
| `expected_results.json` | index of every VC | — |
| `plans/sc-dat-0*.json` | CLI scenarios (`build_project` actions + `expected` rows) | — |

## Real use cases

| # | Use case | What llull must do | VC / plan |
| - | -------- | ------------------ | --------- |
| U1 | An owner asks for "the line list and equipment list of the feed unit as Excel" | tagged lines and equipment, reports to XLSX / CSV | VC-DAT-03, 04, SC-DAT-01 |
| U2 | Procurement needs a material take-off by piping spec | MTO grouped by spec, item type, size | VC-DAT-05 |
| U3 | The client's BIM manager requires IFC 4.3 with connected pipe systems for Navisworks / Solibri / BIMcollab | `export_ifc` IFC4X3_ADD2 with segments, fittings, valves, ports, systems | VC-DAT-06, 07, 08, 10, SC-DAT-01/02 |
| U4 | A process engineer fills design pressures in Excel and sends the sheet back | export, edit outside, preview, apply with refusals | VC-DAT-09, SC-DAT-04 |
| U5 | The agent hand-types a tag, reuses an existing one, or points a line to a tag that does not exist | stable refusal codes, `check_plant_data` findings | VC-DAT-02, 12, SC-DAT-03 |
| U6 | An operator receives a contractor's IFC and wants to know what is in it | read-only `ifc_summary` | VC-DAT-13, SC-DAT-05 |
| U7 | The line list is issued for construction | revision + status; human gate | VC-DAT-15 |
| U8 | Handover to the owner-operator's asset system | tag / equipment registers in a CFIHOS-like layout, flagged unverified | VC-DAT-16 |

## Validation cases

| VC | What | Reference | Tolerance | Grade | Test |
| -- | ---- | --------- | --------- | ----- | ---- |
| VC-DAT-01 | Tag generated from class format + fields (9 cases: `T-101`, `150-P-1001-A1A`, `XV-1001`, …) | `tag_format_cases.json` | exact string | closed form | `tagFormat.test.ts` |
| VC-DAT-02 | Tag validation (13 cases → `DAT_TAG_FORMAT`) and uniqueness per plant (3 cases → `DAT_TAG_DUPLICATE`) | idem | exact code | closed form | `tagFormat.test.ts` |
| VC-DAT-03 | Line list of SC-DAT-01: 2 rows, 4.4 m and 5.8 m, 2 and 1 bends | `sc_dat_01_reports_expected.json` | rows exact, 1e-9 m | closed form | `reports.test.ts` |
| VC-DAT-04 | Equipment list 2, nozzle schedule 3 (inferred), valve list 0 / 2, tag register 4 | idem + SC-DAT-02 | exact | closed form | `reports.test.ts` |
| VC-DAT-05 | MTO by spec: pipe DN150 4.4 m, DN100 5.8 m, bends DN150 ×2, DN100 ×1 | idem | 1e-9 m, counts exact | closed form | `reports.test.ts` |
| VC-DAT-06 | IFC4X3_ADD2 export is schema- and rule-valid | `ifcopenshell.validate --rules` [S3] | 0 errors | A | production oracle |
| VC-DAT-07 | Entity counts and PredefinedType per class equal the reference files | `sc-dat-0*-reference.stats.json` | exact | A | `ifc4x3.test.ts` |
| VC-DAT-08 | Port connectivity: 19 ports all nested (10 `IfcRelNests`), 9 `IfcRelConnectsPorts` = 9 connections, RelatingPort SOURCE / RelatedPort SINK, 1 open port; the negative file's 2 rule errors are found | stats + `sc-dat-02-negative.validate.json`, concept text [S2] | exact | A | `ifc4x3.test.ts` |
| VC-DAT-09 | Excel round trip: export equals fixture; preview = 1 change + `DAT_IMPORT_READONLY_COLUMN` + `DAT_IMPORT_TYPE`, document unchanged; apply = 1 change | xlsx fixtures [S5] | exact | A | `roundTrip.test.ts` |
| VC-DAT-10 | IDS minimum handover: 0 failures on SC-DAT-01/02 exports; the check discriminates (24/24 failures on the bSI plumbing sample) | `plant-handover.ids`, `ids_results.json` [S4] | exact | A | `ids.test.ts` |
| VC-DAT-11 | Determinism: same plan twice → byte-identical IFC, CSV and tags; replay of the feature history re-mints the same tags | — | byte-identical | A (AF-13) | golden `plant-data-sc-dat-01` |
| VC-DAT-12 | SC-DAT-03 error codes: `DAT_TAG_FORMAT`, `DAT_TAG_DUPLICATE`, `DAT_REQUIRED_PROPERTY_MISSING`, `DAT_LINE_END_UNRESOLVED` with ids and paths | plan | exact | closed form | `check.test.ts` |
| VC-DAT-13 | `ifc_summary` of the two bSI samples: schema, counts, system members, ports | `bsi_sample_stats.json` [S1, S3] | exact | A | `ifcSummary.test.ts` |
| VC-DAT-14 | Data Manager edits are atomic commands: an invalid batch applies nothing (`DAT_PROPERTY_TYPE`), a valid batch is one feature step, undo restores a deep-equal document, `is pure` | L1 / L3 | exact | A | `properties.test.ts` |
| VC-DAT-15 | Deliverable status: an agent can issue for review but not for construction (`DAT_HUMAN_GATE`), the result carries `reviewRequired` | AF-34, 09 PLM | exact | A | `deliverables.test.ts` |
| VC-DAT-16 | CFIHOS-like handover export: tag register 4 rows, equipment register 2 rows, `unverified: true` | plan; CFIHOS columns grade C | row counts exact | C / A | `handover.test.ts` |
| VC-DAT-17 | Performance on 20 000 tagged objects | — | TBD — measure with `vitest bench` | — | `plantData.bench.ts` |

## Acceptance scripts (AF-23)

```bash
llull run plans/sc-dat-01-tank-pump-mvp.json --doc /tmp/dat.llull.json --json > /tmp/sc01.json
llull plant_report '{"kind":"line_list","format":"csv"}' --doc /tmp/dat.llull.json --save /tmp/line-list.csv
llull export_ifc '{"schema":"IFC4X3_ADD2","timestamp":"2026-10-18T00:00:00"}' --doc /tmp/dat.llull.json --save /tmp/sc01.ifc
python3 -m ifcopenshell.validate --rules /tmp/sc01.ifc            # VC-DAT-06: 0 error(s) found
python3 -I data/scripts/plant_stats.py /tmp/sc01.ifc | diff - <(jq . data/reference/sc-dat-01-reference.stats.json)  # VC-DAT-07/08
python3 -I data/scripts/run_ids.py data/reference/plant-handover.ids /tmp/sc01.ifc   # VC-DAT-10
```

The comparison in the fifth line gates only the keys named in VC-DAT-07/08 (product counts, PredefinedTypes, ports,
connections, nests, systems, open ports, duplicate tags). Property-set and spatial-relationship counts are printed
for information: llull may attach more property sets than the reference (for example `Pset_ValveTypeCommon` when the
catalogue gives a size), which is not an error. The stats script prints no GlobalIds.
