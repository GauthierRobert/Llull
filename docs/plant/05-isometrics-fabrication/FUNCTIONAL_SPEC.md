# Gap 05 ISO — Piping isometrics and fabrication: functional specification

Companion of [TECHNICAL_SPEC.md](TECHNICAL_SPEC.md) and [validation/README.md](validation/README.md). Agent-first rules:
[`../../aerospace/AGENT_FIRST.md`](../../aerospace/AGENT_FIRST.md) (`AF-nn`). Plant template: [`../TEMPLATE.md`](../TEMPLATE.md).

## 1. Summary

A plant model is only useful to a contractor once it becomes **isometrics**: one drawing per pipeline (or part of
one), drawn in true isometric projection, not to scale, with every pipe length, elevation, weld, spool and bill of
material needed to buy the material, cut and weld the spools in the shop and erect them on site. In AutoCAD Plant 3D,
AVEVA E3D, Hexagon Smart 3D and CADMATIC this is produced by an isometric engine (ISOGEN, or the vendor's own) that
reads the **PCF** (Piping Component File), the de-facto neutral text format of the piping industry [R1][R2][R30].

llull today has drawing sheets (`create_sheet`, projection / section / detail views, `export_sheet_svg`), plan and
elevation sheets of the building model (`export_plan_sheet`, `export_elevation_sheet`), DXF and IFC export, DSTV NC1
files for steel (`export_nc_files`) and a polyline pipe run with line-list data (`add_pipe_run`). It has **no piping
isometric, no PCF import or export, no weld or spool concept, no cut list and no per-line bill of material**. A pipe
is a polyline with bends; it carries no fittings, flanges or welds (those arrive with `01-piping-specs-catalog` and
`02-spec-driven-routing`).

This gap adds, as registry commands reachable from the `llull` CLI, MCP and the UI: PCF export and import, weld
detection and persistent weld numbering, spool splitting (field welds, flanged joints, size / weight limits), cut
lists, per-line / per-spool / per-iso BOM with bolting and gaskets, isometric sheet generation (true isometric, north
arrow, string dimensions, elevations, slope, skew boxes, continuation sheets and sheet splitting, BOM / cut / weld /
spool tables), orthographic piping GA plans and sections with pipe annotation, and a read-only `check_isometric`
with stable codes.

Without this gap, a llull piping model cannot leave the design office: nobody can fabricate from it.

## 2. Plant context and value

- **Deliverable of record.** On a process plant each pipeline is issued as one or more isometric sheets; the final
  iso with its BOM is the document of record for fabrication and construction (Plant 3D "final" style) [R11]. A
  medium refinery unit has thousands of isos; they are produced automatically, never drawn by hand.
- **Tools in use.** Plant 3D (iso styles check / stress / final / spool, built-in ISOGEN, `PLANTPCFTOISO`) [R11];
  AVEVA E3D ISODRAFT with the SPOOL module (spool drawings, weld and spool numbers stored in the database) [R6];
  Smart 3D (ISOGEN with change management that keeps sheet content stable on re-issue) [R22]; CADMATIC (own
  isometrics, PCF export) [R13]; fabricator software (Spoolgen, PypeServer, M4 ISO FX) that reads PCF [R17][R31];
  CAESAR II reads PCF for stress models [R3].
- **Why PCF matters to llull.** A PCF writer lets a llull model feed every downstream fabrication and stress tool
  without llull drawing anything; a PCF reader lets llull ingest lines exported by those tools (fabrication
  estimating, as-built checks, model migration). PCF is plain text, one file per line, documented in a reference
  guide released for free use in 2015 [R2].
- **Who does the work today.** Piping designers run iso extraction; a piping checker reviews; the fabrication shop
  (spool shop) uses the spool isos, cut lists and weld maps; QA/QC tracks every weld number through NDE records.
  Weld numbers must therefore be stable across revisions [R6][R7].

## 3. Personas and user stories

| Persona | Who | Uses |
| ------- | --- | ---- |
| **Operator (primary)** | AI agent with the `llull` CLI (`--doc` headless or `--app` on the desktop window); MCP for cloud agents | plans, `--json` results, `--save` for PCF / SVG / DXF files |
| **Owner** | Person who asked for the line or the drawings (plant owner, small contractor, student); not assumed to be a piping engineer | plain-language summaries, the SVG / PDF sheets, the BOM |
| **Qualified reviewer** | Piping checker / lead piping engineer; for issue "for construction" a named, accountable person | desktop review of the iso, `check_isometric` report, issue approval (human gate) |
| **Consumer** | Fabrication shop, erection contractor, QA/QC inspector | the issued PCF, iso sheets, spool list, cut list, weld list |

User stories (operator first):

- US-01 (operator) "Export line L-101 as a PCF so the fabricator can load it in Spoolgen": `llull export_pcf
  lineIds=L-101 --save L-101.pcf` returns one file per line and the counts it wrote.
- US-02 (operator) "Here are 40 PCFs from the client's Plant 3D model; tell me how much pipe and how many flanges we
  need": `import_pcf preview=true` per file, then `piping_bom scope=document --json`.
- US-03 (operator) "Make the isometrics for unit 100": `export_isometric lineId=… style=final --save iso/` produces
  sheets with tables; `check_isometric` passes before the agent reports success.
- US-04 (operator) "The truck takes 12 × 2.5 × 2.5 m; split the spools and give me the cut list":
  `set_fabrication_rules`, `split_spools`, `cut_list --json`.
- US-05 (owner) "Is everything there for the shop?" — the agent answers from `check_isometric`: "13 welds, 2 spools,
  BOM complete; not approved — needs a piping checker".
- US-06 (reviewer) opens the iso sheets in the desktop app, checks dimensions, weld map and BOM, and records the
  approval (`issue_isometric`), which an agent cannot do (AF-34).
- US-07 (consumer, QA/QC) weld W7 keeps its number after a revision adds a support clip elsewhere on the line.

## 4. Scope

| Phase | In scope |
| ----- | -------- |
| **MVP** | PCF export (one file per line, MVP component subset, MATERIALS section, units mm / inch) and import (preview and create); weld detection (shop / site / field-fit) and persistent numbering; spool split at field welds and flanged joints; cut list with explicit weld gap and field-fit allowance; per-line / per-spool BOM with bolting and gaskets from the spec; isometric sheet (true iso, north arrow, centreline string dimensions, elevations, flow arrows, weld / spool marks, BOM / cut / weld / spool tables) as SVG + DXF, one or more sheets; slope annotation; `check_isometric`; works on legacy `add_pipe_run` lines by deriving elbows from the spec (flagged) |
| **V1** | Skew / offset boxes (squaring-in triangles) for non-orthogonal runs; sheet splitting with continuation marks and stable re-issue; spool split by size / weight / count; spool isometrics (one sheet per spool); orthographic piping GA plan / section with line labels, CL / BOP / TOS elevations, flow arrows, double-line above a DN threshold; supports on isos (marks and CO-ORDS in PCF); weld map export (CSV) for QA/QC; PCF reducers, olets, valves (with spindle direction), caps, blinds, instruments, supports; revision clouds between issues |
| **V2** | Stress isometric style (anchors, restraints, node numbers) for `07-pipe-stress-flexibility`; ISOGEN option-file compatibility (PCF `ISOGEN-FILES` reference, MESSAGE / reference dimensions); PCF `HIGHEST-*` repeatability round trip with external tools; IDF reading; welding procedure / NDE percentage per weld; hydro-test package drawings; system isometrics across lines |

Out of scope: the PCF engine of a third party (llull does not embed ISOGEN); catalogue data and fitting placement
(`01-piping-specs-catalog`, `02-spec-driven-routing`); P&ID (`04-pid-schematics`); stress calculation
(`07-pipe-stress-flexibility`); plant-wide reports and IFC piping (`08-plant-data-reports-interop`); rendering of
large models (`09-plant-visualization-review`).

## 5. Functional requirements

| Id | Priority | Requirement | Rationale | Source | AF |
| -- | -------- | ----------- | --------- | ------ | -- |
| FR-ISO-01 | MUST | Read a PCF: header units (UNITS-BORE / UNITS-CO-ORDS mm or inch), PIPELINE-REFERENCE and its header attributes, the MVP component types with END-POINT / CENTRE-POINT / BRANCH1-POINT / CO-ORDS, SKEY, ITEM-CODE, COMPONENT-IDENTIFIER, ERECTION-ITEM / FABRICATION-ITEM, and the MATERIALS section; `preview` mode returns counts, lengths and BOM without changing the document; unknown records are kept and reported, never silently dropped | ingest lines from Plant 3D / E3D / Smart 3D / CADMATIC | [R1][R3][R4][R7][R8] | AF-01, AF-10, AF-32 |
| FR-ISO-02 | MUST | Write a PCF per pipeline from the llull piping model: header, pipeline attributes (spec, insulation, revision, project, area), components in flow order, SKEY and ITEM-CODE from the spec, field welds as WELD records, MATERIALS section; no TAB, lines ≤ 1024 characters, attributes indented; canonical number format so the output is deterministic | feed ISOGEN, fabricators, CAESAR II | [R1][R3][R7][R12] | AF-12, AF-13 |
| FR-ISO-03 | MUST | Round trip: a PCF written by llull and read back gives the same components, coordinates (0.1 mm), bores, end types, SKEYs, item codes and line attributes | interop confidence | — | AF-23 |
| FR-ISO-04 | MUST | Work on legacy `add_pipe_run` lines: when a line has no explicit fittings, derive elbows from the spec's bend rule (LR 90 centre-to-end from the catalogue) and mark every derived item `derived: true` with warning `ISO_LEGACY_FITTINGS_DERIVED` | today's models must not be dead ends | [R26] | AF-31, AF-32 |
| FR-ISO-05 | MUST | Split each line into spools: breaks at field / site / field-fit welds, flanged (bolted) joints and line ends; optional limits (max length, envelope box, weight, component count) given by the user with a source string; a limit can insert field welds only when asked (`autoBreak`) | shop fabrication, shipping | [R6][R7][R11][R23] | AF-30, AF-31 |
| FR-ISO-06 | MUST | Detect every weld: butt / socket joints between components become shop welds, explicit WELD records keep their type (WW shop, WS site, WF field-fit); report position, joined components, bore, end type, spool | weld map, QA/QC | [R6][R8][R13] | AF-10 |
| FR-ISO-07 | MUST | Persistent weld numbering: numbers are stored in the document, assigned in a documented deterministic order, prefixed per category (fabrication / erection prefixes as in PCF WELD-PREFIX-*), and kept across model edits; new welds take highest + 1 | NDE traceability | [R3][R6][R7] | AF-13 |
| FR-ISO-08 | MUST | Cut list per spool: each pipe piece with centreline length, cut length = length − weld-gap share per welded end + field-fit allowance per WF end, bore, item code; gap and allowance are explicit parameters or named rule values, never silent defaults | shop cutting | [R23] | AF-31, AF-35 |
| FR-ISO-09 | MUST | Bill of material per line, per spool and per iso sheet: pipe length by item code, fittings / flanges / valves by count, bolting (stud bolts with diameter and count per flanged joint from the flange rating table) and gaskets; descriptions from the spec; the sum over spools equals the line | purchasing, final iso | [R11][R14][R27] | AF-10 |
| FR-ISO-10 | MUST | Isometric sheet in true isometric projection (axes 30° from horizontal, 120° apart), not to scale, plant north arrow (up-right by default, up-left on request), with title block, line number, spec, revision | the drawing of record | [R18][R19][R20][R25] | AF-21, AF-22 |
| FR-ISO-11 | MUST | Layout without scale: components placed along the projected axes with readable lengths (min / max symbol lengths), no overlapping text, labels on the side away from the pipe; every geometric value shown is exact (the picture is schematic, the numbers are not) | not-to-scale isos | [R20][R21] | AF-21 |
| FR-ISO-12 | MUST | Dimensions from the centreline / flange face: string dimensions per straight run that close to the overall, elevations (EL) at run changes and ends, coordinates at line ends and branch points; `data` lists every dimension with its 3D value | fabrication from the drawing | [R20] | AF-21 |
| FR-ISO-13 | MUST | Slope annotation (ratio and arrow) on lines that fall, with slope in data as ratio, percent and degrees | drains, gravity lines | [R20] | AF-21 |
| FR-ISO-14 | SHOULD | Split a line over several sheets (component / piece budget per sheet, split only at a weld or flange), with continuation marks naming the other sheet and the weld; sheet content stays stable on re-issue (overflow goes to a new sheet) | large lines | [R22] | AF-13 |
| FR-ISO-15 | SHOULD | Orthographic piping GA plan / section: pipes single-line (double-line from a DN threshold), line label line-DN-spec, CL and BOP elevations, flow arrows, equipment and steel as background, built on the existing plan / elevation sheets | erection and layout review | [R24] | AF-22 |
| FR-ISO-16 | MUST | `check_isometric`: read-only pass / warn / fail list with codes for connectivity, open ends, missing SKEY / item code, unnumbered welds, spool limits, dimension closure, short cut pieces, unverified catalogue data, legacy-derived fittings | the agent proves its own work | — | AF-20, AF-11 |
| FR-ISO-17 | MUST | Every refusal and every check item has a stable `ISO_*` code, the ids or file line numbers, and a one-line remediation | agent loop | — | AF-11 |
| FR-ISO-18 | MUST | Deterministic output: same model and options give the same PCF bytes, SVG bytes, numbers and order | diffable issues, golden tests | — | AF-13 |
| FR-ISO-19 | MUST | Issuing an isometric "for construction" is a human gate; the agent can produce a check or final iso, but the issue stamp needs the reviewer's signature; every iso carries `reviewRequired: true` until then | safety and contract | — | AF-33, AF-34 |
| FR-ISO-20 | SHOULD | Iso styles: check (no BOM, highlight issues), final (BOM and tables), spool (one sheet per spool, spool tables), stress (V2) | the four Plant 3D styles | [R11] | — |
| FR-ISO-21 | SHOULD | Supports on isos and in PCF (SUPPORT with CO-ORDS, mark, type) from `add_pipe_support` | erection, stress hand-off | [R3] | — |
| FR-ISO-22 | SHOULD | Skew / offset runs drawn inside squaring-in triangles with the three leg dimensions; 45° offsets drawn at 22.5° | non-orthogonal routing | [R20] | AF-21 |
| FR-ISO-23 | COULD | Weld map / weld list as CSV for QA/QC tracking (weld number, line, spool, size, type, shop / field) | QA/QC databases | [R11] | AF-12 |
| FR-ISO-24 | COULD | Revision clouds and a revision table between two issues of the same iso | change control | [R22] | — |

## 6. Workflows

### 6.1 CLI (primary and complete)

```bash
# A. model -> PCF + isos (after 01 PSC / 02 RTE have built the line)
llull --doc unit100.llull check_isometric lineId=L-101 --json            # must be ok before export
llull --doc unit100.llull number_welds lineId=L-101
llull --doc unit100.llull split_spools lineId=L-101 breakAt=field_welds,flanged_joints
llull --doc unit100.llull export_pcf lineIds=L-101 --save out/            # out/L-101.pcf
llull --doc unit100.llull export_isometric lineId=L-101 style=final paper=A3 formats=svg,dxf --save out/iso/
llull --doc unit100.llull cut_list lineId=L-101 weldGapMm=3 --json > out/L-101-cut.json
llull --doc unit100.llull piping_bom scope=line lineId=L-101 includeBolting=true --json

# B. PCF in -> quantities (no document change)
for f in client/*.pcf; do llull import_pcf file=$f preview=true --json; done

# C. everything as one plan, validated first (AF-05)
llull run docs/plant/05-isometrics-fabrication/validation/plans/sc-iso-01-parse-sample-pcf.json --validate
llull run docs/plant/05-isometrics-fabrication/validation/plans/sc-iso-01-parse-sample-pcf.json --json
```

The agent ends every job with `check_isometric` (AF-20) and reports in the order: what was produced, what passed,
what needs a human (AF-36). For a visual check it saves the sheet as PNG (`--save iso.png`, AF-22).

### 6.2 MCP

Same commands, toolset `plant` (TECHNICAL_SPEC §7). `export_*` return files in `data.files[]`; large outputs are
written by the host, not streamed (AF-12).

### 6.3 UI (review and approval only)

- Isos appear as sheets in the existing sheet browser; the reviewer pans / zooms the SVG, clicks a weld or BOM row to
  highlight the component in the 3D view.
- `check_isometric` results are listed with codes; clicking selects the offending component.
- The reviewer records "issued for construction" with a signature (09 PLM `record_signature`); the iso title block
  then shows the revision and approver. An agent caller gets `ISO_HUMAN_GATE`.

## 7. Acceptance criteria

| Given | When | Then | VC |
| ----- | ---- | ---- | -- |
| the pack's PCF fixture (line L-101, 15 records) | `import_pcf preview=true` | 15 components (FLANGE 3, PIPE 7, WELD 1, ELBOW 3, TEE 1), 13045 mm of pipe, document unchanged | VC-ISO-01 |
| the fixture with a TAB on line 14, or a 1025-char line, or no ISOGEN-FILES, or a short END-POINT | `import_pcf` | refused with `ISO_PCF_TAB` / `ISO_PCF_LINE_TOO_LONG` / `ISO_PCF_HEADER` / `ISO_PCF_RECORD_INVALID`, path `line N`, exit 1 | VC-ISO-02 |
| the fixture imported | `export_pcf` | byte-identical to the input (canonical writer) | VC-ISO-03 |
| L-101 routed in llull with the same geometry and spec | `export_pcf` then `import_pcf preview` | same topology; pipe 13045 = route 14500 − take-outs 1455 mm | VC-ISO-04 |
| the fixture | `weld_list` | 13 welds W1..W13, 12 shop, 1 field at (2500, 0, 3000) | VC-ISO-05 |
| the fixture | `split_spools`, `spool_list` | 2 spools: {1, 2} and the other 12 components | VC-ISO-06 |
| the fixture, gap 3 mm; or SKEY WF with 100 mm allowance | `cut_list` | cut lengths exactly as listed in expected_results.json | VC-ISO-07 |
| the fixture | `piping_bom` | 13.045 m pipe, 3 elbows, 1 tee, 3 flanges; equals MATERIALS totals and the cut-list sum; with bolting: 3 gaskets, 24 studs 5/8 in | VC-ISO-08, 09 |
| any line | `export_isometric` | east axis −30°, north +30°, vertical 90°, north arrow +30° | VC-ISO-10 |
| the fixture | `export_isometric` | every dimension label equals the 3D distance; east string 76 / 2424 / 2348 / 152 closes to 5000 | VC-ISO-11 |
| a DN50 drain falling 100 mm over 10 m | `export_isometric` | "SLOPE 1:100", 1 %, 0.5729386977°, arrow toward +X | VC-ISO-12 |
| a 20-piece line, max 8 pieces per sheet | `export_isometric` twice around an edit on sheet 3 | 3 sheets, matching continuation welds; sheets 1-2 unchanged on re-issue | VC-ISO-13 |
| numbered welds | a new weld is added | old numbers kept, new weld W14 | VC-ISO-14 |
| the fixture | `export_piping_ga view=plan` | label L-101-DN100-A1A, CL EL +3000 / +1000, BOP 2942.85 | VC-ISO-15 |
| a broken line | `check_isometric` | codes ISO_DISCONNECTED, ISO_SKEY_MISSING, ISO_OPEN_END, ISO_SPOOL_TOO_LARGE, `ok: false` | VC-ISO-16 |
| the same plan run twice | export | identical PCF / SVG hashes and weld numbers | VC-ISO-17 |

## 8. Standards and regulatory alignment

| Standard / format | Status in this gap | Public facts used |
| ----------------- | ------------------ | ----------------- |
| ISO 6412-1:2017 Simplified representation of pipelines — Part 1: General rules and orthogonal representation [R24] | GA plans / sections follow its scope; clause content not read (paywalled) | scope: all pipes, rigid or flexible, any material; also ducts |
| ISO 6412-2:2017 Part 2: Isometric projection [R25] | isometric sheets; clause content not read | supplementary rules to Part 1 for isometric representation, 12 pages, confirmed 2023 |
| ISO 6412-3 (terminal features of ventilation and drainage systems) | out of scope | — |
| PCF, Piping Component File Reference Guide 2016 (Alias / Hexagon) [R1][R2] | MVP subset, transcribed from secondary sources; to be re-checked against the guide (OQ-ISO-01) | released for free use (2015) |
| ISOGEN SKEY guide [R9] | SKEYs used by llull's symbols and PCF writer | family + end-condition coding |
| ASME B31.3 (process piping) | not checked by this gap; no maximum spool length in B31.3 [R23] | — |
| ASME B16.9 / B16.5 / B36.10M | dimensions read through `01-piping-specs-catalog` | LR90 C-E 1.5 × NPS; bolt count per flange |
| Company / project drafting standards | override conventions (north arrow side, prefixes, table columns) through style data | — |

## 9. KPIs

| KPI | Target |
| --- | ------ |
| VC pass rate | 18 / 18 (VC-ISO-18 measured) |
| PCF round trip on the MVP subset | byte-equal |
| Isos needing manual fixing before issue (pilot, 20 lines) | ≤ 10 % of sheets, 0 dimension errors |
| Time to produce one final iso (≤ 100 components) on the reference desktop | < 2 s |
| Welds with a number before issue | 100 % (`check_isometric` blocks otherwise) |
| BOM discrepancy between iso, spool sum and line | 0 |

## 10. Risks and assumptions

| Risk / assumption | Effect | Mitigation |
| ----------------- | ------ | ---------- |
| The PCF guide was not read in full (sandbox) | keyword details (WELD record form, MATERIALS layout, SKEY list) may differ | MVP subset only uses A-graded records; OQ-ISO-01: check the fixture with a licensed ISOGEN / Plant 3D or IsoAlgo; keep unknown records verbatim |
| Third-party PCF dialects (CADWorx, E3D, Plant 3D add their own attributes) | import loses data | keep unknown attributes in `extra` and write them back; report counts of unknown keys |
| Not-to-scale layout produces overlaps on dense lines | unreadable isos | deterministic layout with collision checks; `check_isometric` reports `ISO_SHEET_OVERFLOW`; split sheets |
| Weld numbers change after edits | broken QA/QC traceability | persistent numbering with highest + 1; renumber only on explicit command with a report |
| Owner trusts an unchecked iso | wrong fabrication | `reviewRequired: true` until a human issue; stamp "NOT FOR CONSTRUCTION" on unissued sheets |
| Dependency on 01 PSC and 02 RTE | MVP blocked | legacy-line path (FR-ISO-04) and PCF import give working isos before RTE lands |
| Catalogue values marked unverified in PSC | wrong cut lengths | AF-32 propagation: cut list and BOM rows carry `unverified` |

## 11. References

- [R1] Piping Component File Reference Guide, version 2016 (13.0), Alias Ltd / Intergraph (Hexagon) — catalogue copies on scribd.com / pdfcoffee.com (accessed 2026-10, search extracts) — sources.md S1, S7.
- [R2] Intergraph makes Isogen PCF documentation available — Chemical Processing, 2015 — https://www.chemicalprocessing.com/industrynews/2015/intergraph-makes-isogen-pcf-documentation-available-/ (accessed 2026-10).
- [R3] Revit PCF Exporter wiki (PCF compliance, Export to CAESAR II, Pipe supports) — shtirlitsDva — https://github.com/shtirlitsDva/Revit-PCF-Exporter/wiki (accessed 2026-10, downloaded).
- [R4] PCF/APCF/Super PCF — Far East Piping Reference — https://sites.google.com/site/fareastpiperreference/pcf (accessed 2026-10, search extract).
- [R6] AVEVA E3D 1.1 ISODRAFT user guide and reference: SPOOL, numbering, weld symbol keys — AVEVA — https://help.aveva.com/AVEVA_Everything3D/1.1/ISOUG/ISOUG6.06.02.html (accessed 2026-10, search extract).
- [R7] PCF Reference Guide copy (syntax rules, SPOOL-IDENTIFIER, HIGHEST-WELD-NUMBER) — pdfcoffee.com — https://pdfcoffee.com/pc-f-reference-guide-9-pdf-free.html (accessed 2026-10, search extract).
- [R8] Example: Weld Components in a PCF File; Creating Pipe Component Information — PTC Creo help — https://support.ptc.com/help/creo/creo_pma/r12/usascii/piping/piping/Example__Weld_Components_in_a_PCF_File.html (accessed 2026-10, search extract).
- [R9] ISOGEN Symbol Key (SKEY) Definitions Reference Guide, 2016 — Hexagon — https://pdfcoffee.com/isogen-symbol-key-skey-definitions-reference-guide-pdf-free.html (accessed 2026-10, search extract).
- [R11] AutoCAD Plant 3D help: About Iso Styles and Themes; Iso Style Setup; To Work with PCF Files — Autodesk — https://help.autodesk.com/cloudhelp/2025/ENU/Plant3D-UserGuide/files/GUID-6EDFD98B-9964-4AF8-8AC8-8BF585F5AE0C.htm (accessed 2026-10, search extract).
- [R12] To Work with PCF Files — Autodesk — https://knowledge.autodesk.com/support/autocad-plant-3d/learn-explore/caas/CloudHelp/cloudhelp/2021/ENU/Plant3D-UserGuide/files/GUID-2FE44F87-E696-4C21-B722-F1075166DA7B-htm.html (accessed 2026-10).
- [R13] PCF Export — CADMATIC — https://docs.cadmatic.com/plant/Content/Piping%20Isometrics/Application/Manage/link_pcf.htm (accessed 2026-10, search extract).
- [R14] PCF Component Guide; Isogen Files — pdfcoffee.com — https://pdfcoffee.com/pcf-component-guide-2-pdf-free.html (accessed 2026-10, search extract).
- [R17] Importing PCF files — PypeServer KB — https://pypeserver.zohodesk.com/portal/en/kb/articles/importing-pcf-files (accessed 2026-10, search extract).
- [R18] Isometric projection — Wikipedia — https://en.wikipedia.org/wiki/Isometric_projection (accessed 2026-10).
- [R19] Axonometric projections (lecture) — Carnegie Mellon University — https://www.andrew.cmu.edu/user/ramesh/teaching/course/48-175/lectures/10.AxonometricProjections.pdf (accessed 2026-10).
- [R20] Piping Isometrics: How to Read and Understand Them — Project Materials — https://blog.projectmaterials.com/epc-projects/engineering/piping-isometrics/ ; Piping isometric drawings — S. V. Lele — http://www.svlele.com/isoinfo.htm (accessed 2026-10).
- [R21] Piping isometric drawing: overview, tips and downloads — CADS Schroer — https://www.cad-schroer.com/news/articles/piping-isometric-drawing-overview-tips-and-downloads/ (accessed 2026-10).
- [R22] Smart 3D / Isogen documentation (change management, option switch 53) — Hexagon — https://docs.hexagonppm.com (accessed 2026-10, search extract).
- [R23] Section 13D: Locating Field Welds — Piping Designers — https://pipingdesigners.com/wp/2014/05/28/section-13d-locating-field-welds (accessed 2026-10, search extract).
- [R24] ISO 6412-1:2017 — ISO — https://www.iso.org/standard/73352.html (accessed 2026-10).
- [R25] ISO 6412-2:2017 — ISO — https://www.iso.org/standard/73353.html (accessed 2026-10).
- [R26] 01-piping-specs-catalog validation data (ASME B16.9 fittings) — llull docs — `../01-piping-specs-catalog/validation/data/asme_b16_9_buttweld_fittings.json`.
- [R27] 01-piping-specs-catalog validation data (ASME B16.5 flanges) — llull docs — `../01-piping-specs-catalog/validation/data/asme_b16_5_wn_rf_flanges.json`.
- [R30] Digital Isometrics — Bentley ConstructSim Executive help — https://docs.bentley.com/LiveContent/web/ConstructSim%20Executive%20Help-v5/en/GUID-0E7E3E62-2B9F-6919-A815-0233C1845AC9.html (accessed 2026-10, search extract).
- [R31] M4 ISO FX, isometrics from PCF files — CADS Schroer — https://www.cad-schroer.com/products/m4-iso/isometrics-from-pcf-files/ (accessed 2026-10).

Reference numbers follow the source ids of [validation/sources.md](validation/sources.md) (Rn = Sn).
