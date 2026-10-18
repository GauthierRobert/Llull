# Gap 04 PID — Validation pack

This pack proves that llull's P&ID commands are right: that a P&ID read from DEXPI keeps every plant item, tag,
attribute and connection; that a P&ID written by llull can be read back unchanged; that instrument tags are decoded
per ISA 5.1; and that the P&ID checks and the P&ID ↔ 3D consistency check find exactly the faults that are there.

Every reference value comes from a downloaded, licensed file (see [sources.md](sources.md), graded A/B/C), from a
closed form (topological equality, byte equality), or from a fault seeded by construction. **No expected value was
produced by running llull.** The object counts were computed by the scripts in `data/scripts/` (python3 -I,
`xml.etree`, read-only) directly from the DEXPI files, and cross-checked against a second, independent encoding of
the same P&ID (DEXPI 2.0 XML) and against assertions in the pyDEXPI test suite.

All cases run unattended (AF-23):

- Unit tests read the JSON files below directly (`tests/unit/plant/pid/*.test.ts`, table-driven).
- `tests/unit/plant/pid/scenarioPlans.test.ts` runs every plan in `plans/` through `build_project` — the same path
  as `llull run plan.json`. CLI-script plans (`cli` arrays, `file=`) run in `server/tests/packReplay04.test.ts`.

## Gate policy

Only **grade A** values and closed forms / constructed faults are pass / fail thresholds. Grade B items (some ISA
modifier letters, Autodesk wording) are documentation or design input only. Grade C items are never used.

## Files

| File | Content | Grade |
| --- | --- | --- |
| `data/dexpi13/*.xml` | 11 DEXPI 1.3 verification reference P&IDs (Proteus 4.1.1): the complete reference P&ID C01, BASF column C02, Equinor piping C03, and 8 small equipment / instrumentation / piping cases | A (S1) |
| `data/dexpi20/reference_pid.xml` | The same reference P&ID as C01 in the DEXPI 2.0.1 XML format; validates against `DEXPI_XML_Schema.xsd` (xmllint) | A (S2) |
| `data/dexpi20/DEXPI_XML_Schema.xsd` | DEXPI 2.0 XML schema | A (S2) |
| `data/dexpi_census.json` | Counts per file (equipment, nozzles, lines, segments, components, valves, instrument functions, loops, actuating systems, signal lines, off-page connectors, flow arrows, connections), tags, line attributes, the C01 connectivity census and the 1.3 ↔ 2.0 cross-encoding check (14 / 14 keys equal) | A |
| `data/scripts/census_proteus.py`, `census_dexpi20.py`, `connectivity_proteus.py` | The census scripts (data only, no llull imports) — the reference implementation the tests' expected values came from | — |
| `data/isa51_letters.json` | ISA 5.1 identification letters: 26 first letters with modifiers, 24 succeeding-letter rows, grade per row | A / B per row |
| `data/tag_parse_cases.json` | 16 tag-parsing cases: the brief's `FIC-101`, 9 tags taken from the DEXPI files, 6 constructed edge cases | A |
| `data/pid_validation_rules.json` | P&ID rule set and P&ID ↔ 3D rule set: llull code, Plant 3D category it mirrors, definition, severity | A (names) / design |
| `expected_results.json` | Index of every VC: inputs, expected value, tolerance, source, grade, plan / test | — |
| `plans/sc-pid-0*.json` | CLI scenarios; every plan lists its unbuilt commands in `status` | — |

## Real use cases

| # | Use case | What llull must do | VC |
| --- | --- | --- | --- |
| U1 | An owner receives a vendor P&ID as DEXPI XML and wants the line list and instrument index | import DEXPI 1.3 / 1.4 / 2.0, list lines, valves, instruments, equipment | VC-PID-01..05, 12, SC-PID-01 |
| U2 | An agent drafts a pump-and-control-loop P&ID from a process description | author equipment, nozzles, lines, inline valves, instruments, signal lines, actuating system; check | VC-PID-10, 13, 14, SC-PID-02 |
| U3 | The EPC hands the P&ID to another CAE tool | export DEXPI 1.3 Proteus and DEXPI 2.0 XML that round-trip | VC-PID-06, 07, SC-PID-04 |
| U4 | A piping designer models the 3D plant and needs to know what is not yet placed or differs from the P&ID | `check_pid_3d` by tag / line number | VC-PID-11, SC-PID-03 |
| U5 | A reviewer reads an unfamiliar instrument tag | `parse_instrument_tag` with ISA 5.1 meanings and the convention used | VC-PID-08, SC-PID-05 |

## Validation cases

| VC | What | Reference | Tolerance | Grade |
| --- | --- | --- | --- | --- |
| VC-PID-01 | Import C01 (DEXPI 1.3): 5 top-level / 16 total equipment, 19 nozzles, 11 lines (PipingNetworkSystem), 23 segments, 19 piping components of which 11 valves, 4 instrument functions, 4 loops, 3 actuating systems, 3 signal generating functions, 6 information flows, 2 off-page connectors, 8 flow arrows, 24 catalogue shapes, 29 connections | census [S1]; same 14 keys in the DEXPI 2.0 encoding [S2]; PNS 11 / actuating systems 3 / shapes 24 also asserted by pyDEXPI [S4] | exact | A |
| VC-PID-02 | Import `reference_pid.xml` (DEXPI 2.0.1): same counts and same lists as VC-PID-01 | census [S2] | exact | A |
| VC-PID-03 | Import the 10 smaller DEXPI 1.3 files: per-file counts (`expected_results.json`) | census [S1] | exact | A |
| VC-PID-04 | Tag and attribute fidelity on C01: equipment tags H1007, H1008, P4711, P4712, T4750; 11 line numbers 47121…47141 with DN (DN 25 / 50 / 80), piping class (75HB13, 73HG12) and fluid code; instrument tags PI 4712.01, PICSA 4712.02, HS 4750.01, TICSA 4750.03 | census [S1] | exact strings | A |
| VC-PID-05 | Connectivity graph of C01: 23 piping connections + 6 information-flow connections, 0 dangling references, 17 nozzles connected, T4750 N3 and N8 (manhole) unconnected; endpoint-type histogram | `connectivity_proteus.py` [S1] | exact | A |
| VC-PID-06 | DEXPI 1.3 round trip: census of export equals census of C01; export → import → export is byte-identical | closed form | exact | A |
| VC-PID-07 | DEXPI 2.0 export validates against `DEXPI_XML_Schema.xsd` and has the census of `reference_pid.xml` | XSD [S2] | exact | A |
| VC-PID-08 | Tag parsing: `FIC-101` → F = flow, I = indicate (readout), C = control (output), loop 101; 15 more cases from DEXPI files and edge cases | ISA 5.1 letters [S5][S6], grade-A rows | exact | A |
| VC-PID-09 | `check_pid` on imported C01: no `PID_SEGMENT_INVALID`; `PID_NOZZLE_UNCONNECTED` = T4750/N3; manhole N8 info only; any other finding frozen as golden after review | pyDEXPI validity test [S4]; census [S1] | exact for listed codes | A |
| VC-PID-10 | `check_pid` finds each of 6 seeded faults exactly once (size, spec, non-terminating line, flow direction, control valve without actuator, unresolved off-page connector); duplicate tag refused with `PID_TAG_DUPLICATE` | construction; categories after Plant 3D [S8] | exact counts | A |
| VC-PID-11 | `check_pid_3d` finds 4 seeded mismatches exactly once (unplaced, not in P&ID, size, connectivity) and only the known unplaced valve in the clean variant | construction; categories after Plant 3D [S9] | exact counts | A |
| VC-PID-12 | Lists on C01: line list 11 rows, valve list 11 rows (5 ball, 3 globe, 1 butterfly, 1 swing check, 1 spring-loaded globe safety), instrument index 4 rows, equipment list 5 rows; CSV header stable | census [S1] | exact | A |
| VC-PID-13 | Inline insertion splits a segment (+1, attributes inherited); deletion with heal restores the route | closed form | exact / 1e-9 mm | A |
| VC-PID-14 | Agent loop: `--validate` names the step and param of a bad reference; duplicate tag refusal carries code, ids, remediation; two runs give identical ids and order | AGENT_FIRST AF-05/11/13 | exact | A |
| VC-PID-15 | Robust import: truncated XML → `DEXPI_PARSE_ERROR` (document unchanged); dangling `ToID` → `DEXPI_DANGLING_REFERENCE`; unknown class → `DEXPI_UNMAPPED_CLASS`; unknown root → `DEXPI_VERSION_UNSUPPORTED` | construction (mutated copies of S1 files) | exact codes | A |
| VC-PID-16 | Symbol coverage: every equipment / piping class in the 11 files (12 equipment + 12 piping classes) has a built-in symbol; importing all 11 files yields 0 `DEXPI_UNMAPPED_CLASS` | census [S1] | exact | A |
| VC-PID-17 | Performance: import C01 ≤ 1.0 s; `check_pid` on a 5 000-item synthetic P&ID ≤ 1.0 s | budget | TBD — measure with `llull … --json` timing | n/a |
| VC-PID-18 | Sheet rendering: one SVG group per item with the item id; bubble variant per location; the two conventions give different equipment symbols | closed form over the model | exact structure | A |
| VC-PID-19 | Guardrails: agent cannot issue for construction (`PID_HUMAN_GATE`); relief valve without set pressure is `reviewRequired`; defaulted DN flagged; accepted finding hidden unless asked | AF-31..34 | exact | A |
| VC-PID-20 | Reducer / spec break suppress mismatches; OPC pair resolves across sheets; renumbering is deterministic; list filters | construction | exact | A |

## Requirement coverage


| FR | VC |
| --- | --- |
| FR-PID-01, 02 | VC-PID-16, 18 |
| FR-PID-03..08 | VC-PID-01, 04, 10, 12 |
| FR-PID-09 | VC-PID-10, 20 |
| FR-PID-10, 11 | VC-PID-05 |
| FR-PID-12, 13 | VC-PID-10, 13 |
| FR-PID-14, 15 | VC-PID-20 |
| FR-PID-20, 21, 23 | VC-PID-01, 03, 04 (1.4: V1, same census once a 1.4 file is available) |
| FR-PID-22 | VC-PID-02 |
| FR-PID-24, 25 | VC-PID-06, 07 |
| FR-PID-26 | VC-PID-15 |
| FR-PID-30..32 | VC-PID-08, 10, 20 |
| FR-PID-40..42 | VC-PID-09, 10, 19 |
| FR-PID-50..52 | VC-PID-11 |
| FR-PID-60, 61 | VC-PID-12, 20 |
| FR-PID-62 | VC-PID-18 |
| FR-PID-70, 71 | VC-PID-19 |

## How the census was produced (reproducible)

```bash
python3 -I validation/data/scripts/census_proteus.py validation/data/dexpi13/*.xml
python3 -I validation/data/scripts/census_dexpi20.py validation/data/dexpi20/reference_pid.xml
python3 -I validation/data/scripts/connectivity_proteus.py validation/data/dexpi13/C01V04-VER.EX01.xml
xmllint --noout --schema validation/data/dexpi20/DEXPI_XML_Schema.xsd validation/data/dexpi20/reference_pid.xml
```

Counting rules (instances only, `ShapeCatalogue` excluded; nested sub-equipment counted in `equipmentAll`; a valve is
a piping component whose class contains `Valve`) are stated in `data/dexpi_census.json` `countingRules`. llull's
`pid_report kind=counts` must apply the same rules.
