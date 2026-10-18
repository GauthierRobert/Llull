# Gap 08 DAT — Plant data, reports and interoperability: functional specification

Gap id: **DAT** · Status: specification (no implementation) · Written 2026-10-18 · Companion:
[TECHNICAL_SPEC.md](TECHNICAL_SPEC.md) · Validation: [validation/README.md](validation/README.md) · Agent-first rules:
[../../aerospace/AGENT_FIRST.md](../../aerospace/AGENT_FIRST.md) (`AF-nn`).

## 1. Summary

llull can already draw a small process area: `add_equipment` places tagged boxes and vessels, `add_pipe_run` routes
pipes with a line number, DN and from / to tags, `building_schedule` prints a pipe "line list" and an equipment
schedule as CSV, `quantity_takeoff` sums pipe length by service and diameter, and `export_ifc` writes IFC4 with
`IfcPipeSegment`, `IfcCableCarrierSegment` and `IfcBuildingElementProxy` for equipment and pipe supports. What is
missing is the **plant data layer** that turns geometry into a deliverable an owner-operator accepts:

- no plant object classes with typed, unit-carrying properties;
- no tag formats, no tag registry and no uniqueness rule beyond equipment marks;
- no plant hierarchy (site / plant / area / unit / system);
- no data-manager style editing of many objects at once;
- no line, valve, nozzle or instrument lists, and no MTO by piping spec;
- no XLSX output and no Excel round trip;
- no IFC 4.3 export: no `IfcPipeFitting`, `IfcValve`, `IfcTank`, `IfcPump`, no ports, no port connections, no
  distribution systems;
- no handover format (CFIHOS, ISO 15926) and no deliverable revision or status.

Plant 3D (Project Setup + Data Manager + reports), AVEVA E3D and Hexagon Smart 3D (with SmartPlant Foundation) all put
this layer between the 3D model and the documents. Without it llull can model a process unit but cannot deliver its
data. That blocks every EPC and owner-operator use, whatever the quality of the geometry built by the sibling gaps.

## 2. Plant context and value

| Who | Today, with which tool | What they need from this gap |
| --- | ---------------------- | ---------------------------- |
| EPC piping and process teams | Plant 3D: class definitions and tag formats in Project Setup, the Data Manager grid, export to XLSX / CSV with read-only columns protected, re-import with accept / reject of changes [R6][R7]. AVEVA E3D: database hierarchy WORLD → SITE → ZONE → EQUI / PIPE → BRAN [R8]. Smart 3D: Pipeline / Pipe Run objects [R8], tag loading through SmartPlant Foundation [R11] | tagged objects, line / equipment / valve lists, MTO, Excel round trip |
| Client BIM / information managers | IFC export checked in Solibri, BIMcollab, Navisworks or with IDS files; IFC 4.3 is ISO 16739-1:2024 [R1] | an IFC 4.3 file with typed piping and process elements, ports, systems and the client's required properties |
| Owner-operators (handover) | CFIHOS registers (IOGP JIP36) [R9]; ISO 15926 reference data [R10] | tag and equipment registers in the client's handover layout, one tag per physical item, properties with units |
| Procurement | MTO by piping spec from the model | quantities grouped by spec, size and item type |
| Document control | revision and status of each list (in work, issued for review, issued for construction) | revision letters, status history, a human sign-off |

## 3. Personas and user stories

| Persona | Role | Uses |
| ------- | ---- | ---- |
| **Operator (primary)** | AI agent with the `llull` CLI (`--doc` or `--app`), or MCP | plans, `plant_report`, `check_plant_data`, `export_ifc`, `--save` |
| **Owner** | asks for a result, not assumed to be an engineer | natural language; opens CSV / XLSX / IFC |
| **Qualified reviewer** | lead piping engineer, process engineer, document controller; a professional engineer where a deliverable carries a design pressure or test pressure | desktop review surfaces, `set_deliverable_status`, signature |

User stories:

- **US-01 (operator)**: "Tag every pump, tank and line of unit 10 with the project's tag formats and give me the line
  list and the equipment list as Excel." The agent runs one plan, checks it with `check_plant_data`, saves two XLSX
  files.
- **US-02 (operator)**: "The tag P-101 already exists." The agent receives `DAT_TAG_DUPLICATE` with the id that holds
  it and the next free tag in the remediation, and does not guess.
- **US-03 (owner)**: "Send the client an IFC they can open in their BIM tool." The agent exports IFC 4.3, runs the
  client's IDS file, and reports in one sentence what passed and what is missing.
- **US-04 (process engineer, via owner)**: fills design pressures and temperatures in the exported Excel sheet and
  sends it back. The agent previews the import, lists accepted and rejected cells with reasons, then applies.
- **US-05 (qualified reviewer)**: reviews the line list revision A in the desktop app and issues it for construction
  with a signature. The agent cannot do this step.
- **US-06 (operator)**: "What is in the contractor's IFC?" `ifc_summary` returns schema, counts per class, systems and
  ports without importing anything.

## 4. Scope

| Phase | In scope | Out of scope (owner) |
| ----- | -------- | -------------------- |
| **MVP** | plant hierarchy; class definitions with typed properties and units; default process class library; tag formats, generation, registry, uniqueness; line records bound to `add_pipe_run` pipes; `assign_plant_object`, `set_plant_properties` (batch); `plant_data_table` (grid query); `plant_report` (line list, equipment list, nozzle schedule from inferred nozzles, tag register, MTO by spec from centreline lengths) to JSON / CSV / XLSX; `check_plant_data`; `export_ifc` `schema: "IFC4X3_ADD2"` with segments, bends, equipment classes, ports, connections, pipelines, facility hierarchy, Psets | spec-driven components (01 PSC), routing between real nozzles (02 RTE), nozzle objects (03 EQP), P&ID tags and DEXPI (04 PID), isometrics and PCF (05 ISO) |
| **V1** | valve list, instrument index (with 04 PID objects); MTO from 01 PSC components with take-outs; Excel / CSV round trip with preview and partial apply; reserved tags (tag before geometry); `renumber_tags`; report templates; IDS check of exports; `ifc_summary`; deliverable revision and status with human gate (on 09 PLM); property provenance and `unverified` | |
| **V2** | IFC 4.3 import of piping into plant objects; CFIHOS-like handover package with a CFIHOS class / property mapping imported from the IOGP release; ISO 15926 / POSC Caesar RDL identifiers on classes; multi-document project (several areas in several files) with a shared tag registry on the server host; change tracking between two IFC exports | a full ISO 15926 triple store; SmartPlant Foundation / AVEVA Net integrations |

## 5. Functional requirements

| Id | Pri | Requirement | Rationale | Source | AF |
| -- | --- | ----------- | --------- | ------ | -- |
| FR-DAT-01 | MUST | The document holds a **plant hierarchy** of typed nodes (site, plant, area, unit, system) with a code, a name and properties. Every plant object belongs to exactly one node; reports and exports filter and group by it. | E3D SITE / ZONE, Smart 3D site / area / unit; IFC 4.3 `IfcSite` / `IfcFacility` / `IfcFacilityPartCommon` | R8, R2 | AF-01 |
| FR-DAT-02 | MUST | **Plant classes** are document data: name, parent class (properties inherited), class code, IFC mapping, and typed properties (text, integer, real, boolean, enum, and physical quantities with a unit: length, pressure, temperature, mass, flow). Each property has a display name, `required`, `readOnly` / derived, default, allowed values or pattern. | Plant 3D class definitions and properties | R7 | AF-04, AF-30 |
| FR-DAT-03 | MUST | A **default process class library** ships with llull (equipment families, process line, valves, fittings, instruments, nozzle, pipe support) with a cited IFC mapping. A project can extend it; it cannot silently change a shipped class. | an agent must not have to invent a class model | R2, R3 | AF-30 |
| FR-DAT-04 | MUST | **Tag formats** per class: literal delimiters and fields taken from the object's properties, its class code and its hierarchy node, with zero padding. The tag is generated (next free sequence on request) and is read-only; changing a tag means changing its fields. | Plant 3D tag formats (subparts of properties and delimiters) | R7 | AF-13 |
| FR-DAT-05 | MUST | **Tag registry**: one tag per object, unique within a plant (same tag allowed in another plant), refusal `DAT_TAG_DUPLICATE` naming the holder; a tag can be **reserved** before its object exists (P&ID first, client tag lists). | one tag per physical item is the base of every handover | R9, R11 | AF-11 |
| FR-DAT-06 | MUST | **Line designation**: a process line is a plant object (line number fields, fluid code, piping spec, nominal size, from, to, design and operating pressure and temperature, insulation, test pressure) bound to one or more pipe runs. `from` / `to` resolve to a tag in the registry or to a declared battery limit / tie-in. | the line list is the first piping deliverable | R7 | AF-30 |
| FR-DAT-07 | MUST | **Data-manager editing** happens only through commands. A batch of property edits (many objects, many properties) is validated as a whole, applied as one feature step or refused as a whole, and is undoable. | architecture L1 / L3; Plant 3D Data Manager edits | R6 | AF-01, AF-42 |
| FR-DAT-08 | MUST | A read-only **grid query** returns objects of a class (and descendants) with chosen columns, filters, sort and paging, plus per-column metadata (unit, readOnly). The UI Data Manager panel is a view over it. | the agent and the UI see the same table | — | AF-10, AF-12 |
| FR-DAT-09 | MUST | **Line list**: one row per line with its designation fields, from / to, size, spec, length, bend count and the line properties. | — | R7 | AF-10 |
| FR-DAT-10 | MUST | **Equipment list** and **tag register**; **nozzle schedule** (MVP: nozzles inferred where a line end lies inside equipment named in `from` / `to`, flagged `inferred`; V1: 03 EQP nozzles). | — | — | AF-10 |
| FR-DAT-11 | SHOULD | **Valve list** and **instrument index** once valves (01 PSC / 02 RTE) and instruments (04 PID) exist as objects. | — | — | AF-10 |
| FR-DAT-12 | MUST | **MTO by piping spec**: quantities grouped by spec, item type and nominal size; pipe in metres, components in each. MVP uses centreline length and counts bends; V1 uses catalogue take-outs from 01 PSC. The method is named in the result. | procurement deliverable | — | AF-35 |
| FR-DAT-13 | MUST | Every report is returned as `data.rows` with typed columns and can be saved as **CSV and XLSX** (`--save line-list.xlsx`); report definitions (columns, filter, sort, grouping) can be saved in the document and re-run. | Plant 3D exports XLSX (default) or CSV | R6 | AF-10, AF-12 |
| FR-DAT-14 | SHOULD | **Excel round trip**: export a class table with an object key column and protected read-only columns; import it back as a **preview** (accepted changes, rejected cells with codes, document untouched), then apply only the accepted changes. | Plant 3D: read-only columns locked; import with accept / reject | R6 | AF-11, AF-42 |
| FR-DAT-15 | SHOULD | **CSV / XLSX tag-list import** creates reserved tags with properties (client or P&ID tag lists). | EPC tag pre-allocation | R11 | AF-05 |
| FR-DAT-16 | MUST | **IFC 4.3 export** (`IFC4X3_ADD2`): `IfcPipeSegment` per straight, `IfcPipeFitting` per fitting, `IfcValve`, equipment as its typed IFC class, the tag in `Tag`, the facility hierarchy, property sets from the IFC templates plus a project set. IFC4 stays the default for existing users. | ISO 16739-1:2024; client BIM requirements | R1, R2, R3 | AF-10 |
| FR-DAT-17 | MUST | Class → IFC mapping uses the IFC entity and `PredefinedType` of the schema; a class without a matching enum value uses `USERDEFINED` with `ObjectType`; `IfcBuildingElementProxy` is used only when no distribution class fits, and every proxy is listed in the export result. | typed exchange; EXPRESS rule `CorrectPredefinedType` | R2, R3 | AF-21 |
| FR-DAT-18 | MUST | **Ports and connectivity**: each distribution element exports its ports (`IfcDistributionPort`, nested with `IfcRelNests`); each physical connection is one `IfcRelConnectsPorts` from the SOURCE port to the SINK port; each line is an `IfcDistributionSystem` grouping its elements. | IFC Port Connectivity concept | R2 | AF-21 |
| FR-DAT-19 | SHOULD | **Requirement checking** of an export against a client IDS 1.0 file, read-only, with per-specification pass / fail and the failing GlobalIds. | clients deliver requirements as IDS | R4 | AF-20 |
| FR-DAT-20 | MUST | **Determinism**: same document → same tags, same report order, byte-identical CSV / XLSX / IFC (GlobalIds derived from stable ids, as today). | diffable deliverables, golden tests | — | AF-13 |
| FR-DAT-21 | MUST | `check_plant_data` (read-only) returns pass / warn / fail with codes: duplicate or malformed tags, missing required properties, unresolved line ends, objects outside the hierarchy, unconnected ports that are not battery limits, inferred data, unverified values. | an agent ends every job with a check | — | AF-20, AF-11 |
| FR-DAT-22 | SHOULD | `ifc_summary` (read-only) reads an IFC 2x3 / 4 / 4.3 text and returns schema, counts per class, systems with member counts, ports and connections. V2: import piping and equipment as plant objects. | incoming contractor models | R5 | AF-10 |
| FR-DAT-23 | COULD | **Handover package**: tag register, equipment register, tag property values and document register as CSV files in a CFIHOS-like layout, the class / property mapping held as data and flagged `unverified` until it is checked against the IOGP release. | CFIHOS JIP36 | R9 | AF-32 |
| FR-DAT-24 | SHOULD | **Deliverable revision and status** for reports and exports (in work → issued for review → issued for approval → issued for construction → as built); the issue for construction and approval steps are human gates; the status is printed in the report header and the IFC file header. | document control | 09 PLM | AF-33, AF-34 |
| FR-DAT-25 | SHOULD | **Property provenance**: each property value may carry a source (P&ID, vendor data sheet, calculation, agent entry) and an `unverified` flag that propagates into reports and checks. | AF-32 | — | AF-32, AF-35 |
| FR-DAT-26 | SHOULD | **Bulk renumbering** (`renumber_tags`) of a class within a hierarchy node, with an old → new mapping in the result and a refusal when the new range collides. | re-numbering after a unit split | — | AF-11 |
| FR-DAT-27 | COULD | Computed report columns from expressions over properties (the existing `=expr` evaluator), units converted explicitly. | custom reports without code | — | AF-04 |

## 6. Workflows

### 6.1 CLI (primary, complete)

```bash
# 1. Build or open the model (sibling gaps), then classify and tag it in one plan
llull run plans/sc-dat-01-tank-pump-mvp.json --doc unit10.llull.json --validate   # AF-05: refuses unknown classes / bad formats before work
llull run plans/sc-dat-01-tank-pump-mvp.json --doc unit10.llull.json --json

# 2. Check, then deliver
llull check_plant_data --doc unit10.llull.json --json          # pass / warn / fail with codes
llull plant_report '{"kind":"line_list","format":"xlsx"}' --doc unit10.llull.json --save line-list.xlsx
llull plant_report '{"kind":"mto","groupBy":["spec","itemType","nominalSize"],"format":"csv"}' --doc unit10.llull.json --save mto.csv
llull export_ifc '{"schema":"IFC4X3_ADD2"}' --doc unit10.llull.json --save unit10.ifc
llull check_ifc_requirements '{"idsRef":"client.ids"}' --doc unit10.llull.json --json   # V1

# 3. Excel round trip (V1)
llull export_plant_data '{"classes":["Equipment"],"format":"xlsx"}' --doc unit10.llull.json --save equipment.xlsx
llull import_plant_data @import.json --doc unit10.llull.json --json        # mode "preview": diff only
llull import_plant_data @import-apply.json --doc unit10.llull.json         # mode "apply"

# 4. Issue (V1): the agent prepares, a human issues
llull set_deliverable_status '{"deliverable":"line_list","revision":"A","status":"issued_for_review"}' --doc unit10.llull.json
```

The `--json` result of every query carries `data` (rows, counts, codes); the summary is one sentence for the owner
(AF-36): what was produced, what failed, what needs a human.

### 6.2 MCP

The same commands appear in a `plant` toolset (shared with the sibling plant gaps). `plant_report`, `plant_data_table`,
`check_plant_data`, `ifc_summary` are `readOnlyHint`; `import_plant_data` in `apply` mode and `renumber_tags` are
`destructiveHint`; `set_deliverable_status` to a gated state refuses agent callers.

### 6.3 UI (review and approval)

- A **Data Manager** panel shows `plant_data_table` per class and hierarchy node; a cell edit dispatches
  `set_plant_properties`; read-only cells are greyed; a selection highlights the objects in the viewport.
- A **Reports** panel runs saved report definitions and offers CSV / XLSX download.
- The **Issue** dialog shows the deliverable, its revision history and the `check_plant_data` result, and asks the
  qualified reviewer for a signature before `issued_for_construction`.

## 7. Acceptance criteria

| Id | Given | When | Then | VC |
| -- | ----- | ---- | ---- | -- |
| AC-01 | class `CentrifugalPump` with format `{classCode}-{area}{seq:2}` and unit `U10` (area 1) | `assign_plant_object` with `seq: 1` | `data.tag` = `P-101` | VC-DAT-01 |
| AC-02 | `P-101` exists in plant P1 | another object is assigned `P-101` in P1 | refused `DAT_TAG_DUPLICATE`, `ids` = the holder, document unchanged | VC-DAT-02, 12 |
| AC-03 | a hand-typed tag `P-1011` | `assign_plant_object` | refused `DAT_TAG_FORMAT`, `paths` = `tag`, remediation names the format | VC-DAT-02 |
| AC-04 | plan SC-DAT-01 | `plant_report line_list` | 2 rows; 150-P-1001-A1A 4.4 m, 2 bends; 100-P-1002-A1A 5.8 m, 1 bend | VC-DAT-03 |
| AC-05 | plan SC-DAT-01 | `plant_report mto` | pipe DN150 4.4 m, DN100 5.8 m, bends DN150 ×2, DN100 ×1, method `centreline` | VC-DAT-05 |
| AC-06 | plan SC-DAT-01 | `export_ifc schema IFC4X3_ADD2` | `ifcopenshell.validate --rules` reports 0 errors; 5 `IfcPipeSegment`, 3 `IfcPipeFitting` BEND, 1 `IfcTank` STORAGE, 1 `IfcPump`, 0 proxies | VC-DAT-06, 07 |
| AC-07 | idem | count relationships | 19 ports all nested; 9 `IfcRelConnectsPorts`, each SOURCE → SINK; 1 open port (battery limit BL-1); 2 `IfcDistributionSystem` with 5 and 3 members | VC-DAT-08 |
| AC-08 | the exported equipment sheet edited outside llull | `import_plant_data mode preview` | 1 accepted change; `DAT_IMPORT_READONLY_COLUMN` (tag) and `DAT_IMPORT_TYPE` (text in a pressure cell); document unchanged | VC-DAT-09 |
| AC-09 | the preview above | `mode apply` | 1 change applied as one feature step; undo restores the document | VC-DAT-09, 14 |
| AC-10 | `plant-handover.ids` | IDS check of the SC-DAT-01 export | 0 failed specifications | VC-DAT-10 |
| AC-11 | the same plan run twice | export IFC, CSV, XLSX | byte-identical files | VC-DAT-11 |
| AC-12 | plan SC-DAT-03 | `check_plant_data` | `fail` with exactly `DAT_REQUIRED_PROPERTY_MISSING` and `DAT_LINE_END_UNRESOLVED` | VC-DAT-12 |
| AC-13 | the bSI `Infra-Plumbing.ifc` | `ifc_summary` | `IFC4X3_ADD2`, 24 `IfcPipeSegment`, 1 system of 26 members, 0 ports | VC-DAT-13 |
| AC-14 | an agent caller | `set_deliverable_status issued_for_construction` | refused `DAT_HUMAN_GATE`; a human with a valid signature succeeds | VC-DAT-15 |
| AC-15 | plan SC-DAT-01 | `export_handover profile cfihos-subset` | tag register 4 rows, equipment register 2 rows, `unverified: true` | VC-DAT-16 |
| AC-16 | SC-DAT-01 and a client tag list P-103, P-104, P-101 | `import_tag_list`, then `renumber_tags` from 11 | 2 reserved, P-101 refused `DAT_TAG_DUPLICATE`; mapping P-101 → P-111, P-103 → P-112, P-104 → P-113 | VC-DAT-18 |
| AC-17 | a design pressure entered by the agent with `unverified` provenance | `plant_report equipment_list`, `check_plant_data` | the row carries `unverified: true`; the check lists `DAT_VALUE_UNVERIFIED` | VC-DAT-18 |
| AC-18 | SC-DAT-01 | custom report with column `=OperatingWeight/1000` | T-101 2.5, P-101 0.45 | VC-DAT-19 |

## 8. Standards and formats

| Standard / format | Use here | What is public / used |
| ----------------- | -------- | --------------------- |
| ISO 16739-1:2024 (IFC 4.3 ADD2, schema id `IFC4X3_ADD2`) | export target; `ifc_summary` input | title, edition 2 (2024-03), scope incl. infrastructure [R1]; the schema and docs are published openly by buildingSMART [R2]; enumerations and Pset templates read from the compiled schema [R3] |
| ISO 16739-1:2018 (IFC4 ADD2 TC1) | today's export, kept as default | — |
| buildingSMART IDS 1.0 | requirement files from clients | `ids.xsd` 1.0.0 (bundled with ifctester) [R4] |
| ISO/IEC 29500 (Office Open XML, SpreadsheetML) | XLSX reports and round trip | written / read by a minimal in-repo writer; fixtures produced with openpyxl [R5] |
| RFC 4180 CSV | CSV reports | existing `toCsv` |
| CFIHOS (IOGP JIP36) | handover layout (V2) | purpose, ownership and RDL scope from extracts; version and columns **not verified** [R9] |
| ISO 15926 (parts 2, 4, 8) | class identifiers (V2) | part titles and roles from extracts [R10] |
| ISA-5.1 / ISO 10628-2 | instrument and P&ID tags | owned by 04 PID; this gap only stores and formats tags |

## 9. KPIs

| KPI | Target |
| --- | ------ |
| Validation cases passing | 18 of 19 VCs gated (VC-DAT-17 measured) |
| IFC 4.3 exports of the plans with 0 validator errors | 100 % |
| Proxies (`IfcBuildingElementProxy`) in an export of the default class library | 0 for equipment, lines, valves, fittings; pipe supports until a mapping is decided (open question) |
| Agent steps from "model built" to "line list + equipment list + IFC delivered and checked" | ≤ 6 CLI calls |
| Round-trip import refusals with a stable code | 100 % |
| Report generation on 20 000 objects | budget in TECHNICAL_SPEC §8 |

## 10. Risks and assumptions

| Risk / assumption | Effect | Mitigation |
| ----------------- | ------ | ---------- |
| Sibling gaps name their objects differently (nozzle, component, instrument) | DAT cannot classify them | DAT classifies by an object reference `{kind, id}`; each sibling registers a provider of its objects (TECHNICAL_SPEC §2) |
| IFC viewers handle `IfcFacility` / `IfcFacilityPartCommon` unevenly | an IFC 4.3 file may look flat in an older viewer | keep IFC4 export; the IFC 4.3 hierarchy is optional (`plantHierarchy: true` by default only for IFC4X3) |
| IfcOpenShell writes two `IfcRelConnectsPorts` per connection, the IFC text asks for SOURCE → SINK | counts differ between tools | llull writes one per connection (text of the concept); `ifc_summary` counts physical connections (unordered port pairs) |
| CFIHOS content cannot be verified from the sandbox | a "CFIHOS" export could be wrong | V2 only, `unverified` flag, mapping held as data |
| Excel files edited by people contain merged cells, formulas, extra sheets | import errors | import reads values only, ignores formulas' cached values unless present, refuses unknown columns with a code |
| XLSX import needs inflate (zip) in core | a dependency | a pure inflate in `@lib` (deflate exists already) or decompression in the CLI host before the command (open question) |
| A non-engineer owner accepts a line list whose design pressures were typed by the agent | unsafe data | provenance + `unverified` on agent-entered values; `reviewRequired` on issued deliverables |

## 11. References

- [R1] ISO 16739-1:2024, Industry Foundation Classes — Part 1: Data schema, ed. 2, 2024-03 — ISO — https://www.iso.org/standard/84123.html (accessed 2026-10)
- [R2] buildingSMART International, IFC4.3.x-development repository (IfcDistributionPort, IfcRelConnectsPorts, enumerations) — https://github.com/buildingSMART/IFC4.3.x-development (accessed 2026-10); official HTML https://standards.buildingsmart.org/IFC/RELEASE/IFC4_3/
- [R3] IfcOpenShell 0.9.0 (schema IFC4X3_ADD2, validate, api) — https://pypi.org/project/ifcopenshell/ (accessed 2026-10)
- [R4] ifctester 0.9.0 and buildingSMART IDS 1.0 — https://pypi.org/project/ifctester/ (accessed 2026-10)
- [R5] buildingSMART Sample-Test-Files, IFC 4.3.2.0 Simple-Scene — https://github.com/buildingSMART/Sample-Test-Files (accessed 2026-10)
- [R6] Autodesk, AutoCAD Plant 3D 2026 User's Guide, "To Export Data from the Data Manager" — https://help.autodesk.com/cloudhelp/2026/ENU/Plant3D-UserGuide/files/GUID-C09E92A6-D79A-4E9C-871E-2D34326C6237.htm (accessed 2026-10, search extract)
- [R7] Autodesk, AutoCAD Plant 3D 2026 User's Guide, "To Work with Properties" and "To Set Up a Tag Format" — https://help.autodesk.com/cloudhelp/2026/ENU/Plant3D-UserGuide/files/project_create_properties_wrkflw.htm, …/GUID-94841151-975B-425B-BC63-4D8CBE7EC7AA.htm (accessed 2026-10, search extract)
- [R8] AVEVA, E3D Design documentation (hierarchy) and AVEVA E3D 2.1 Model Conversion User Guide — https://docs.aveva.com/bundle/e3d-design/page/994926.html, https://help.aveva.com/AVEVA_Everything3D/2.1/ModConv/ModConv2.03.5.html (accessed 2026-10, search extract)
- [R9] IOGP JIP36 CFIHOS — https://www.iogp.org/blog/news/year-of-renewal-for-cfihos/ ; MIMOSA meeting presentation March 2021 — https://www.mimosa.org/wp-content/uploads/presentations/2021/04/cfihos-overview/CFIHOS-Mimosa-meeting-March-2021.pdf (accessed 2026-10, search extracts)
- [R10] ISO 15926 overview — https://en.wikipedia.org/wiki/ISO_15926 ; POSC Caesar "ISO 15926 as OWL" — https://production.posccaesar.org/svn/pub/ISO15926asOWL/20110923_ISO15926_OWL2_Native_V2.pdf (accessed 2026-10, search extracts)
- [R11] Hexagon, SmartPlant Foundation Help, "Loading Tags Work Process" — https://docs.hexagonppm.com/r/en-US/SmartPlant-Foundation-Help/644339 (accessed 2026-10, search extract)
- [R12] llull: `docs/INDUSTRIAL.md`, `packages/domain-aec/src/building/exchange/ifcBuild.ts`, `…/quantities/scheduleBuild.ts` (this repository)
