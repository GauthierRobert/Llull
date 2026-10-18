# Gap 04 PID — P&ID schematics, DEXPI exchange and P&ID ↔ 3D consistency: functional specification

Status: specification only, written 2026-10-18 (nothing built). Authoring rules: [`../TEMPLATE.md`](../TEMPLATE.md).
Operator model: [`../../aerospace/AGENT_FIRST.md`](../../aerospace/AGENT_FIRST.md). Validation:
[`validation/README.md`](validation/README.md).

## 1. Summary

A process plant is designed twice: once as a piping and instrumentation diagram (P&ID), the schematic that fixes
every piece of equipment, nozzle, line, valve and instrument with its tag and its connections, and once as the 3D
model that places them. The P&ID comes first and stays the reference: the line list, the valve list and the
instrument index are read from it, the 3D model is checked against it, and owners exchange it between CAE tools as
DEXPI XML.

llull has none of this. It has 2D drafting (`draw_polyline`, `draw_arc`, `add_text`, `add_dimension`, …), drawing
sheets (`create_sheet`), components and instances (`create_component`, `insert_instance`), DXF import, and on the 3D
side `add_equipment` and `add_pipe_run` with a line number, DN and from / to tags. A P&ID drawn with those tools is
lines and text: a valve does not know its line, a line does not know its nozzles, a tag is a string nobody checks,
and nothing can be exported to another P&ID tool or compared with the 3D model.

This gap adds **intelligent P&IDs**: plant items that are data first and graphics second (equipment, nozzles,
piping network systems and segments, inline components, instrument functions, loops, signal lines, actuating
systems, off-page connectors), smart connectivity (lines end on nozzles, an inline valve splits its line and
inherits size and class, flow direction), a tag registry with ISA 5.1 tag parsing, line numbering, P&ID validation
with stable codes, the standard lists, **DEXPI import / export** (DEXPI 1.3 / 1.4 Proteus XML and DEXPI 2.0 XML) and
a **P&ID ↔ 3D consistency check** of the kind Plant 3D runs with *Validate*. It blocks plant use because without it
an agent cannot build, read or exchange the document every process plant project starts from.

## 2. Plant context and value

| Who | Typical job | Tool used today | What llull adds |
| --- | --- | --- | --- |
| Process / instrument engineer (EPC) | draw P&IDs to ISO 10628-2 or ISA 5.1, keep tags unique, issue line list and instrument index | AutoCAD P&ID / Plant 3D P&ID, AVEVA Diagrams, Smart P&ID, COMOS | the same objects and lists, authored and checked by an agent from the CLI |
| Owner-operator | receive vendor and EPC P&IDs, keep them as data, hand them to the next contractor | DEXPI XML via add-ins (Autodesk DEXPI Data Bridge [R13]) or PDF | lossless DEXPI 1.3 / 1.4 / 2.0 import and export, no add-in, no mapping file |
| Piping designer | model the 3D plant and close the gap to the P&ID | Plant 3D *Validate* (P&ID vs 3D) [R9], Smart 3D / E3D integrity checks | `check_pid_3d` with codes per mismatch, on llull's own 3D model |
| Researcher / AI developer | process P&IDs as graphs | pyDEXPI [R4], DEXPI2graph | a scriptable P&ID graph with stable ids and JSON output |
| Small plant builder (skid, utility package) | a correct, readable P&ID without a P&ID licence | hand drafting in AutoCAD | symbols, tags and lists generated from one plan |

Plant 3D and the other suites keep P&ID objects and 3D objects as separate records that do not share data, so a
change on one side is found only by validation [R9]. llull keeps both in one document; the consistency check is a
read-only query over that document.

## 3. Personas and user stories

- **Operator: an AI agent driving the `llull` CLI** (AF-01..05). It authors a P&ID with one `build_project` plan,
  runs `check_pid`, reads lists as JSON, imports and exports DEXPI files, and ends every job with `check_pid` and,
  when a 3D model exists, `check_pid_3d` (AF-20).
- **Owner: not an engineer** (a plant owner, a skid vendor's project manager). They want "the P&ID, the line list,
  and what is missing in 3D" and a sentence saying what is still open. They never have to know ISA letters: tags
  are decoded in the output (AF-35, AF-36).
- **Qualified reviewer**: a process or instrument engineer who issues the P&ID for construction, and the
  safety-review team (HAZOP). A P&ID is a safety document (relief devices, fail actions, interlocks). llull marks
  every issued revision `reviewRequired` and cannot set the status *Issued for construction* itself (AF-33, AF-34).

User stories:

1. As an agent, I import the vendor's DEXPI file and give the owner the equipment list, the line list and the
   instrument index (FR-PID-20, FR-PID-60).
2. As an agent, I draw a tank → pump → control-valve P&ID from a process description, and `check_pid` tells me what is
   unconnected, mismatched or untagged before anyone looks at it (FR-PID-03..15, FR-PID-40).
3. As an agent, I insert a globe valve in a DN 80 line; it takes DN 80 and the line's piping class, and the line
   keeps its number on both sides (FR-PID-12).
4. As an owner, I ask "what does FIC-101 mean?" and get "flow — indicate, control — loop 101" (FR-PID-31).
5. As a piping designer agent, I run `check_pid_3d` and get the list of P&ID items not yet in 3D, 3D items not on
   the P&ID, and lines whose size, class or ends differ (FR-PID-50).
6. As an owner, I hand the P&ID to an EPC that uses another tool: `export_dexpi version=2.0 --save pid.xml`
   (FR-PID-24, FR-PID-25).
7. As a reviewer, I see which items carry unverified or defaulted data and sign the revision only through a human
   gate (FR-PID-70, FR-PID-71).

## 4. Scope

| Phase | Content |
| --- | --- |
| **MVP** | P&ID model and sheets; equipment with nozzles (DEXPI equipment classes); piping network systems / segments with nozzle-to-nozzle connectivity, DN, piping class, fluid code, flow direction; inline valves and fittings that split lines; instrument functions (bubble: field / central / local panel, shared display), loops, signal and measuring lines, actuating systems (control valves with fail action); off-page connectors between sheets; built-in symbol library covering every class in the DEXPI verification examples; tag registry with uniqueness; ISA 5.1 tag parsing; line numbering template; `check_pid` (13 rules); line list, valve list, instrument index, equipment list, nozzle list (JSON + CSV); DEXPI 1.3 Proteus import / export; DEXPI 2.0 XML import / export; P&ID rendering to sheet SVG / PNG |
| V1 | DEXPI 1.4 (Proteus 4.2.0) import / export; `check_pid_3d` against 02 RTE routed piping and 03 EQP equipment (size, class, ends, inline order, class of component); `place_from_pid` (create 3D placeholders from P&ID items for 02 / 03); custom symbols from 2D entities; ISO 10628-2-style and ISA-style symbol sets selectable per project; spec break and insulation symbols; revision clouds and revision table on the sheet; multi-sheet line continuation |
| V2 | PFD / BFD (DEXPI 2.0 Process model) and stream tables; IEC 62424 PCE requests and CAEX hand-off; P&ID-from-drawing recognition (raster / PDF to DEXPI, research-grade); cause-and-effect matrices; HAZOP node export |
| Out of scope | Control-system configuration (DCS / PLC programming), SIL calculation (IEC 61511), loop diagrams and wiring (electrical CAE), hydraulic or process simulation |

Sibling gaps own adjacent work and are referenced, not re-specified: pipe classes and the component catalogue
(**01-piping-specs-catalog**, PSC), 3D routing and 3D inline components (**02-spec-driven-routing**, RTE), 3D
equipment and nozzles (**03-parametric-equipment**, EQP), isometrics (**05-isometrics-fabrication**, ISO), the
project-wide tag registry, lists across all disciplines and IFC / CFIHOS hand-over (**08-plant-data-reports-interop**,
DAT), service colour coding in 3D (**09-plant-visualization-review**, VIS).

## 5. Functional requirements

| Id | Priority | Requirement | Rationale | Source |
| --- | --- | --- | --- | --- |
| FR-PID-01 | MUST | A built-in symbol library: one symbol per supported class (equipment, nozzle, valve, fitting, instrument bubble variants, actuator, off-page connector, flow arrow, reducer, blind, spec break), with connection points; coverage of every class used in the DEXPI verification examples | P&IDs are read through symbols | ISO 10628-2 scope [R10]; DEXPI examples [R1] |
| FR-PID-02 | SHOULD | Two symbol conventions per project: ISO 10628-2 style and ISA 5.1 style for instrument bubbles (field, central / DCS, local panel, shared display / PLC / software) | European and US projects differ | [R10], [R12] |
| FR-PID-03 | MUST | Equipment as data: class (DEXPI class names, e.g. `CentrifugalPump`, `Tank`, `PlateHeatExchanger`), tag, nozzles (sub-tag, DN, rating, side), design data (pressure, temperature, capacity) with units | lists and 3D need the data, not the drawing | DEXPI 1.4 [R3] |
| FR-PID-04 | MUST | Nozzles are connection points with sub-tag (N1, N2…), DN and an optional rating; a nozzle takes at most one line | nozzle-to-line connectivity | [R3] |
| FR-PID-05 | MUST | Piping network systems (lines) with line number, DN, piping class, fluid code, insulation, flow direction; made of segments between items | the line list is a P&ID product | [R3], [R1] |
| FR-PID-06 | MUST | Instrument functions with category letter, function letters, loop number, location (field / central / local panel), display (discrete / shared / PLC / software); loops group them | instrument index | [R3], ISA 5.1 [R12] |
| FR-PID-07 | MUST | Measuring lines (instrument to process point) and signal lines (electric, pneumatic, software / data link, capillary) as data with endpoints | control loops are read from them | [R3] |
| FR-PID-08 | MUST | Actuating systems: operated valve + actuator type + fail action (FC / FO / FL / FAI) + controlling instrument | control valve schedule; safety relevance | [R3], [R1] C01 |
| FR-PID-09 | MUST | Off-page connectors pairing a line end on one sheet with a line end on another | multi-sheet P&IDs | Plant 3D [R8] |
| FR-PID-10 | MUST | Smart connectivity: a line ends on a nozzle, on another line (tee / branch), on an inline item, on an off-page connector, or explicitly free (flagged); moving equipment keeps its lines attached | connectivity is the P&ID's meaning | [R3] §8.54 |
| FR-PID-11 | MUST | The connectivity graph is queryable: for any item, upstream / downstream items, line, loop | agents reason over graphs, not pictures (AF-21) | [R4] |
| FR-PID-12 | MUST | Inserting an inline item splits the segment; the item inherits DN and piping class unless given; both parts keep the line number. Deleting it heals the segment | Plant 3D inline behaviour | [R8] |
| FR-PID-13 | MUST | Flow direction per segment, flow arrows generated from it; reversing a line flips it | flow conflicts are a check | [R8] |
| FR-PID-14 | SHOULD | Reducers change DN along a line; spec breaks change piping class along a line, both explicit | size / spec mismatch checks need them | [R8] |
| FR-PID-15 | SHOULD | Line numbering template per project (e.g. `{dn}-{fluid}-{seq}-{class}`), auto-numbering and `renumber_pid_lines` | consistent line numbers | Plant 3D practice [R8] |
| FR-PID-20 | MUST | Import DEXPI 1.3 Proteus XML (and 1.2 where compatible): every plant item, attribute, connection and the drawing geometry (positions, labels) | owners exchange DEXPI | [R1], [R3] |
| FR-PID-21 | MUST | Import keeps object counts, tags and attributes exactly (VC-PID-01, 04) | lossless exchange | [R1] |
| FR-PID-22 | MUST | Import DEXPI 2.0 XML (`<Model>` root, imports of `Core` / `Plant` models) | DEXPI 2.0 released 2025-10 | [R2] |
| FR-PID-23 | SHOULD | Import DEXPI 1.4 (Proteus 4.2.0) | current Proteus-based edition | [R3] |
| FR-PID-24 | MUST | Export DEXPI 1.3 Proteus XML that round-trips (export → import gives the same model) | hand-over to tools on 1.3 | [R1] |
| FR-PID-25 | MUST | Export DEXPI 2.0 XML valid against the published XSD | hand-over to 2.0 tools | [R2] |
| FR-PID-26 | MUST | Import never fails silently: unknown classes, dangling references and dropped graphics are reported with codes; malformed XML leaves the document unchanged | agent must know what was lost (AF-11) | — |
| FR-PID-30 | MUST | Tag registry: every tagged item (equipment, line, valve, instrument, actuating system) has one unique full tag; duplicates are refused at creation and reported by the check for imported data | tags are the join key to 3D, lists and other systems | [R8] |
| FR-PID-31 | MUST | `parse_instrument_tag`: first letter (measured variable), first-letter modifier, succeeding letters (readout / output / modifier) with their ISA 5.1 meanings, loop number, suffix; non-standard tags reported, not rejected | owners and agents read tags | ISA 5.1 [R5][R6] |
| FR-PID-32 | SHOULD | Tag format per item type is configurable (separator, loop digits, prefix with area / unit) | company standards differ | — |
| FR-PID-40 | MUST | `check_pid`: non-terminating lines, unconnected components / nozzles / vessels, size mismatch, spec mismatch, flow direction conflict, unresolved off-page connector, duplicate tag, invalid segment chain, control valve without actuator, safety valve without set pressure, missing line number | the P&ID's own quality gate | Plant 3D categories [R8]; pyDEXPI [R4] |
| FR-PID-41 | MUST | Every finding has a stable code, severity, item ids / tags, sheet, and a one-line remediation | AF-11 | — |
| FR-PID-42 | SHOULD | Rules can be switched per project (as Plant 3D *Validate Config*), and findings can be accepted with a reason by a human | false positives (spare nozzles, manholes) | [R8] |
| FR-PID-50 | MUST (V1) | `check_pid_3d`: P&ID items not placed in 3D, 3D items not on the P&ID, size / class / end-point / component-class / inline-order mismatches, matched by tag and line number | the P&ID ↔ 3D gate | Plant 3D Validate [R9] |
| FR-PID-51 | MUST | MVP subset of `check_pid_3d` on today's 3D objects: `add_equipment` marks and `add_pipe_run` line / DN / from / to | value before 02 / 03 land | llull `add_pipe_run` |
| FR-PID-52 | COULD | `place_from_pid`: create 3D placeholders (equipment boxes / vessels, pipe stubs on nozzles) from P&ID items | speeds up 3D start | Plant 3D "place from P&ID line list" |
| FR-PID-60 | MUST | Lists: line list, valve list, instrument index, equipment list, nozzle list, as JSON rows and CSV with stable headers | P&ID deliverables | [R8] |
| FR-PID-61 | SHOULD | Lists span all sheets of the project and can be filtered by sheet, area, line, loop | — | — |
| FR-PID-62 | MUST | Render a P&ID sheet to SVG / PNG with title block, symbols, labels, line numbers, flow arrows | humans review drawings; multimodal agents look (AF-22) | — |
| FR-PID-70 | MUST | Revisions: a P&ID sheet has a revision and status (draft, issued for review, issued for HAZOP, issued for construction); moving to *issued for construction* is a human gate | P&IDs are safety documents | AF-34 |
| FR-PID-71 | MUST | Items whose data are defaulted (e.g. DN from the line) or imported without source are marked; safety items (relief valves, fail actions, interlocks) carry `reviewRequired` | AF-31..33 | — |

## 6. Workflows

### 6.1 CLI (primary, complete)

Author and check:

```bash
llull --doc unit.llull run validation/plans/sc-pid-02-author-and-validate.json --validate   # names step + param on error
llull --doc unit.llull run validation/plans/sc-pid-02-author-and-validate.json --json
llull --doc unit.llull check_pid --json                                  # pass / warn / fail list with codes
llull --doc unit.llull pid_report kind=line_list --save lines.csv
llull --doc unit.llull pid_report kind=instrument_index --json
llull --doc unit.llull export_pid_svg sheet=PID-001 --save pid-001.svg  # or render to PNG to look at it
```

Exchange:

```bash
llull --doc vendor.llull import_dexpi file=vendor.xml --json   # data.counts, data.warnings (DEXPI_* codes)
llull --doc vendor.llull export_dexpi version=2.0 --save vendor-dexpi20.xml
llull --doc vendor.llull export_dexpi version=1.3 --save vendor-proteus.xml
```

Consistency with 3D (V1, MVP subset on `add_equipment` / `add_pipe_run`):

```bash
llull --doc plant.llull check_pid_3d --json      # P3D_* findings, matched / unmatched tags
```

The agent ends each job with `check_pid` (and `check_pid_3d` when 3D exists) and reports to the owner in the
order: what was done, what passed, what needs a human (AF-36).

### 6.2 MCP

The same commands appear in a new `pid` toolset (plugin `pid`, `toolset: 'pid'`). Read-only commands (`check_pid`,
`check_pid_3d`, `pid_report`, `parse_instrument_tag`, `list_pid_symbols`, `export_dexpi`) are safe tools.
`import_dexpi` takes the XML text as a parameter (cloud agents upload content, not paths).

### 6.3 UI (review and approval)

The 2D viewport shows P&ID sheets (orthographic, the same store). The review surface lists `check_pid` findings
(click to zoom), the lists as tables, and the revision status. Placing symbols by hand in the UI is a SHOULD (V1):
it gathers parameters for the same commands. The *Issue for construction* button is the human gate (FR-PID-70).

## 7. Acceptance criteria

| Id | Given | When | Then | VC |
| --- | --- | --- | --- | --- |
| AC-01 | the DEXPI 1.3 reference P&ID `C01V04-VER.EX01.xml` | `import_dexpi` then `pid_report kind=counts` | 5 / 16 equipment, 19 nozzles, 11 lines, 23 segments, 11 valves, 4 instrument functions, 3 actuating systems, 6 information flows, 2 off-page connectors | VC-PID-01 |
| AC-02 | the DEXPI 2.0.1 `reference_pid.xml` | `import_dexpi` | the same counts and lists as AC-01 | VC-PID-02 |
| AC-03 | the 10 smaller verification examples | `import_dexpi` each | per-file counts equal the census | VC-PID-03 |
| AC-04 | the imported C01 | `pid_report kind=line_list` | 11 rows; line 47125 is DN 25, class 73HG12 | VC-PID-04, 12 |
| AC-05 | the imported C01 | `pid_report kind=connectivity` | 23 piping + 6 information-flow connections, 0 dangling, T4750 N3 and N8 unconnected | VC-PID-05 |
| AC-06 | the imported C01 | `export_dexpi version=1.3`, re-import, re-export | same census, second export byte-identical | VC-PID-06 |
| AC-07 | the imported C01 | `export_dexpi version=2.0` | the file validates against `DEXPI_XML_Schema.xsd` and has the census of `reference_pid.xml` | VC-PID-07 |
| AC-08 | tag `FIC-101` | `parse_instrument_tag` | F = flow, I = indicate (readout), C = control (output), loop 101 | VC-PID-08 |
| AC-09 | the imported C01 | `check_pid` | no `PID_SEGMENT_INVALID`; `PID_NOZZLE_UNCONNECTED` lists T4750/N3 | VC-PID-09 |
| AC-10 | the SC-PID-02 plan with 6 seeded faults | `check_pid` | each seeded code exactly once; second `FIC-101` refused with `PID_TAG_DUPLICATE` | VC-PID-10 |
| AC-11 | the SC-PID-03 plan with 4 seeded P&ID ↔ 3D faults | `check_pid_3d` | each seeded `P3D_*` code exactly once | VC-PID-11 |
| AC-12 | a DN 80 line | `add_pid_inline class=GlobeValve` then `delete_pid_item heal=true` | +1 segment with inherited DN / class, then the original route | VC-PID-13 |
| AC-13 | a plan referencing an unknown tag | `llull run --validate` | the error names the step path and the param | VC-PID-14 |
| AC-14 | a truncated DEXPI file | `import_dexpi` | `DEXPI_PARSE_ERROR`, document unchanged | VC-PID-15 |
| AC-15 | the 11 DEXPI example files | `import_dexpi` each | 0 `DEXPI_UNMAPPED_CLASS` | VC-PID-16 |

## 8. Standards and regulatory alignment

| Standard | Use in this gap | Public facts used |
| --- | --- | --- |
| ISO 10628-1:2014 / ISO 10628-2:2012 *Diagrams for the chemical and petrochemical industry* [R10] | symbol convention "ISO 10628-2 style"; symbol shapes drawn by llull, not copied | scope, ISO 14617 relationship, IEC 60617 exclusion, edition status |
| ANSI/ISA-5.1 *Instrumentation Symbols and Identification* (2009, 2022, 2024) [R12] | tag grammar and letter meanings (from two or more secondary extracts per letter), bubble conventions | identification-letter meanings as reproduced by secondary sources [R5][R6] |
| IEC 62424:2016 *PCE requests in P&IDs; P&ID ↔ PCE-CAE exchange (CAEX)* [R11] | V2 hand-off; recognises that DEXPI examples use IEC 62424-style letter strings | scope only |
| DEXPI P&ID Specification 1.3 / 1.4, DEXPI Specification 2.0.x [R2][R3] | exchange model and formats; class and attribute names reused in llull's model | the specification text (CC BY 4.0) |
| ISO 15926 (via DEXPI RDL URIs) | `ComponentClassURI` / `AttributeURI` kept verbatim | — |

No regulatory approval is computed. A P&ID is an input to HAZOP and to pressure-equipment conformity work; llull
states that its checks are drawing-consistency checks, not a safety review (FR-PID-71, AF-33).

## 9. KPIs

| KPI | Target |
| --- | --- |
| Import fidelity on the 11 DEXPI verification examples | 100 % of census keys equal (VC-PID-01..03) |
| DEXPI round trip | 0 lost items, attributes or connections; byte-identical second export |
| Seeded-fault recall / precision (`check_pid`, `check_pid_3d`) | 100 % / 100 % on SC-PID-02 and SC-PID-03 |
| Agent effort | the SC-PID-02 P&ID authored in 1 plan file, ≤ 25 actions, no UI step |
| Time | import of C01 ≤ 1 s; `check_pid` on 5 000 items ≤ 1 s (VC-PID-17) |
| Owner comprehension | every finding's remediation is one sentence without letter codes the owner must look up |

## 10. Risks and assumptions

| Risk | Effect | Mitigation |
| --- | --- | --- |
| DEXPI dialects: vendors export different subsets and custom attributes | import loses data | keep unknown classes as generic items with their raw class / URI; keep `DexpiCustomAttributes`; report `DEXPI_UNMAPPED_CLASS` |
| DEXPI 1.3 vs 1.4 (Proteus 4.1 vs 4.2) vs 2.0 (new XML) — three formats | maintenance | one internal model; three thin mappers; the census scripts as test oracles |
| ISA 5.1 text is paywalled; secondary tables differ on a few letters | wrong meaning shown | gate only on letters where two extracts agree; show "user's choice" letters as such; never reject a tag for its letters |
| Symbol shapes of ISO 10628-2 cannot be copied | symbols look "close", not identical | draw generic shapes from public conventions; allow project symbols (V1) |
| P&ID ↔ 3D matching depends on tags typed identically | false "unplaced" | normalise tags (case, separators) with a reported rule; `link_pid_item` for manual pairs |
| Owner treats a clean `check_pid` as a safety approval | unsafe reliance | `reviewRequired`, wording "drawing consistency only", human gate for IFC status |
| 02 / 03 not yet built | `check_pid_3d` limited | MVP subset on `add_equipment` / `add_pipe_run` (FR-PID-51) |

Assumptions: sheet coordinates in millimetres (as DEXPI `Units="mm"`); one P&ID model per document; tags unique
across all sheets of the document (project scope belongs to 08 DAT).

## 11. References

- [R1] DEXPI e.V., TrainingTestCases (DEXPI 1.3 verification examples), CC BY 4.0 — https://gitlab.com/dexpi/TrainingTestCases (accessed 2026-10)
- [R2] DEXPI e.V., DEXPI Specification repository, releases 1.2–2.0.1, `reference_pid.xml`, `DEXPI_XML_Schema.xsd` — https://gitlab.com/dexpi/Specification (accessed 2026-10)
- [R3] DEXPI e.V., DEXPI P&ID Specification 1.4 (2024-12-11), CC BY 4.0 — https://gitlab.com/dexpi/Specification/-/releases (accessed 2026-10)
- [R4] Process Intelligence Research, pyDEXPI 1.2.0 (AGPL-3.0) — https://pypi.org/project/pydexpi/ ; https://github.com/process-intelligence-research/pyDEXPI (accessed 2026-10)
- [R5] Engineering ToolBox, Process Instrumentation — ISA Codes — https://www.engineeringtoolbox.com/isa-intrumentation-codes-d_415.html (accessed 2026-10, search extract)
- [R6] ISA 5.1 letter tables: instrumentationblog.in, tagsight.io, pathnovo.com, mechcodex.com, instrunexus.com (accessed 2026-10, search extracts)
- [R7] industrialmonitordirect.com, PLC and DCS tag naming conventions ISA-5.1 (accessed 2026-10, search extract)
- [R8] Autodesk, AutoCAD Plant 3D Help — P&ID Validation Error Reference; P&ID Validation Settings — https://help.autodesk.com/view/PLNT3D/2022/ENU/?guid=GUID-DF42724D-EB2E-497F-8A33-0E8C42C3D279 (accessed 2026-10, search extracts)
- [R9] Autodesk, AutoCAD Plant 3D Help — About Validating P&ID Drawings and Plant 3D Models; To validate a Plant 3D model against a P&ID drawing — https://help.autodesk.com/cloudhelp/2027/ENU/Plant3D-UserGuide/files/GUID-E3FE36AC-BEA3-4C0C-93CE-EC1A93104D23.htm (accessed 2026-10, search extracts)
- [R10] ISO 10628-2:2012, catalogue — https://www.iso.org/standard/51841.html ; iteh / SIS records (accessed 2026-10)
- [R11] IEC 62424:2016, catalogue — https://webstore.iec.ch/publication/25442 (accessed 2026-10)
- [R12] ISA, ANSI/ISA-5.1-2024 Instrumentation and Control Symbols and Identification, product page — https://www.isa.org/products/ansi-isa-5-1-2024-instrumentation-and-control-symb (accessed 2026-10)
- [R13] Autodesk App Store, DEXPI Data Bridge — https://marketplace.autodesk.com/apps/75fd9d89-871a-4ea9-833d-cd172a9a8184 (accessed 2026-10, search extract)
- [R14] OPC Foundation, OPC UA for DEXPI (OPC 30250) — https://reference.opcfoundation.org/DEXPI/ (accessed 2026-10)
