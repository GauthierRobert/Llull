# 08 XCH — Exchange fidelity for daily files — Functional specification

Status: specification only (2026-10-28). Nothing in this pack is built. Gap id `XCH`, readiness level PRL 3 (daily-capable,
[`../VALIDATION.md`](../VALIDATION.md)). Template: [`../../aerospace/TEMPLATE.md`](../../aerospace/TEMPLATE.md),
[`../../plant/TEMPLATE.md`](../../plant/TEMPLATE.md); style: [`../../design/08-assembly-scale/`](../../design/08-assembly-scale/).

**Id numbering.** The aerospace pack [`../../aerospace/04-interop-ap242-jt-iges/`](../../aerospace/04-interop-ap242-jt-iges/)
already uses `FR-XCH-01..30`, `TR-XCH-01..27`, `VC-XCH-01..26`, and the code cites them (`TR-XCH-08`, `TR-XCH-12/13`). This
pack numbers from **101** (`FR-XCH-101…`, `TR-XCH-101…`, `VC-XCH-101…`) so that every id stays unique in the repository. It
does not restate aerospace 04 (AP242 PMI, GVP, JT, QIF, LOTAR) or plant 08 (IFC 4.3 export, plant data); it references them.

## 1. Summary

A professional receives and sends files every day: a DWG plan from the architect, a DXF from the laser cutter, a STEP
assembly from the supplier, an IFC model from the BIM manager, and sends back a PDF set at scale and a DWG the other office
can open in AutoCAD. Measured on origin/main `f1351cff` (2026-10-28):

| # | Daily need | llull today | Evidence |
| - | ---------- | ----------- | -------- |
| 1 | Open a DWG | `import_dwg` needs a third-party converter on `PATH` (LibreDWG `dwg2dxf` or ODA File Converter); none is bundled; on the owner's workstation it refuses | measured M2; `server/src/dwgConvert.ts` |
| 2 | Open a DXF with everything in it | `import_dxf` reads ASCII only (binary refused) and keeps 7 primitive kinds. On a 31-type AutoCAD 2018 sample drawing it imports 106 entities and **skips 70 records of 22 types**: HATCH, DIMENSION, MULTILEADER, SPLINE, ELLIPSE, ACAD_TABLE, ATTDEF, VIEWPORT, IMAGE, PDFUNDERLAY, 3DSOLID, … Blocks are exploded, attributes dropped, layouts ignored | measured M1; `packages/core/src/lib/dxfRead.ts` |
| 3 | Send a DXF / DWG | No DWG writer. DXF is written only by domain exporters (`export_building_dxf`, `export_civil_dxf`, flat patterns) in **R12 (AC1009)**, coordinates rounded to 6 decimals, dimensions exploded into lines and text, layer names sanitised to R12 characters | `packages/core/src/lib/dxfWriter.ts` |
| 4 | Open a STEP as an editable part | The UI import (`ExchangeImport.tsx`) dispatches `import_step_exact` (exact healed B-rep, product tree, provenance) when the native kernel runs; the CLI `import_step` still produces meshes through the Python bridge, which drops colours and names (quality-gate known issue #3) | `docs/QUALITY_GATES.md`; `packages/protocol/src/exchangeTools.ts` |
| 5 | Open an IFC | No IFC import; `export_ifc` only | code survey |
| 6 | Issue drawings as PDF at scale, print a sheet | Sheets export as SVG only (`export_sheet_svg`: ISO A0–A4 landscape, fonts named, not embedded); no PDF writer, no print command, no File › Print, no plot styles | `packages/core/src/model/sheet.ts`, `commands/drawings/sheetFrame.ts`, `desktop/src/menu.ts` |
| 7 | Trace over a PDF drawing | `add_image_underlay` takes raster images; no PDF underlay | code survey |

So a professional cannot do the first thing of the day (open the DWG they were sent) on a fresh install, and cannot send
back what the other office expects. This pack specifies how to make the daily files open, edit and round-trip with a
measured, reported loss of zero on the classes they use, and how to prove it on a public real-file corpus.

## 2. Context and value

- **What the incumbents promise.** AutoCAD and DWG TrueView define "opens correctly" for DWG; DWG TrueView is Autodesk's free
  viewer and version converter [R15]. DWG has no public specification from Autodesk; the Autodesk DXF Reference is public and
  lists the version codes AC1009 (R11/R12) … AC1032 (AutoCAD 2018) [R14]; its 2020 and 2021 editions still name AC1032 as the
  newest code, and ACadSharp / acadrust label AC1032 "2018+" [R8][R10]. Whether a later code exists is checked again at M1.
- **How other non-Autodesk CAD tools get DWG.** Through the ODA Drawings SDK (proprietary, annual membership [R4][R6]), through
  GNU LibreDWG (GPL-3.0-or-later; reads all versions, writes reliably only up to r2000/r2004 [R1]), or through MIT / MPL
  libraries derived from the public ODA specification: ACadSharp (C#, MIT, reads AC1014–AC1032, writes all but AC1021 [R8])
  and acadrust (Rust, MPL-2.0, ported from ACadSharp, claims read/write R12–R2018 DWG and DXF [R10]). LibreCAD and FreeCAD
  could not link LibreDWG because GPL-2 and GPL-3 are incompatible [R42].
- **STEP.** OCCT reads AP203, AP214 and parts of AP242, and its XDE layer (`STEPCAFControl_Reader`) transfers names, colours,
  layers, validation properties, GD&T and assembly structure [R16]. llull already runs OCCT 7.9 natively; the gap is making the
  exact, editable path the only default and proving it on real files.
- **PDF.** Offices issue drawing sets as PDF, increasingly PDF/A for archiving. PDF/A-1 forbids optional content (layers),
  PDF/A-2 allows it [R27]; PDF/A-2 is based on PDF 1.7 and PDF/A-4 on PDF 2.0 [R28]. Plot styles (CTB / STB) decide
  lineweight, colour and screening at print time in AutoCAD [R30]; a sheet sent at the wrong lineweight is not acceptable.
- **IFC.** IFC 4.3 is ISO 16739-1:2024 [R35]. Open readers exist: IfcOpenShell (LGPL-3.0) [R33] and web-ifc (MPL-2.0) [R34].
- **Licence position of llull.** The repository has no licence file and `package.json` is `"private": true`: llull is
  closed-source today. Any component under GPL cannot be linked into the shipped app; MPL-2.0 obligations apply per file
  [R38]; LGPL-3.0 needs dynamic linking and replaceability. Each choice below records its licence and the question for
  counsel (§10, TECHNICAL_SPEC §11).

## 3. Personas and user stories

The primary operator is a **professional engineer at the desktop app** ([`../README.md`](../README.md) authoring rules); every
gesture is one registered command with a CLI path.

- **Civil / site engineer** (persona `civil`).
  - US-1: "I double-click the surveyor's 2013 DWG. It opens with its layers, blocks with attributes, hatches, dimensions and
    layouts, and nothing on the fidelity report is red."
  - US-2: "I save my road plan as DWG 2018 and the contractor opens it in AutoCAD without a recovery prompt."
- **Structural steel engineer** (`steel`).
  - US-3: "I open the architect's IFC4 and see walls, slabs and grids as a reference model with their properties."
  - US-4: "I issue my general arrangement as a PDF set at 1:50 with the office CTB; the lineweights match what AutoCAD plots."
- **Plant engineer** (`plant`).
  - US-5: "I trace over the vendor's PDF GA drawing as an underlay and snap to its lines."
- **Mechanical engineer** (`mechanical`).
  - US-6: "I open a supplier STEP assembly as exact solids with its tree, names and colours, move a face, fillet an edge, and
    send it back as STEP."
  - US-7: "The flat pattern I send as DXF opens in the laser cutter's CAM with arcs as arcs and the right units."
- **Office CAD manager.**
  - US-8: "Every import and export tells me, by entity type, what was kept, approximated or lost, with a stable code I can
    put in our QA checklist."

## 4. Scope

| Phase | Content |
| ----- | ------- |
| **MVP** | M1 native drawing codec (DWG AC1009–AC1032 and DXF ASCII/binary read; DXF + DWG AC1032/AC1027/AC1024/AC1018/AC1015 write) with fidelity report · M2 drafting model to L3 for the MUST classes (blocks/attributes, dimensions + styles, hatches, MTEXT, linetypes, lineweights, true colour, layouts/viewports) · M3 STEP exact as the default import everywhere + editability proof · M5 vector PDF at true scale with embedded fonts and layers |
| **V1** | M4 pass-through of unmodelled objects (handle-preserving save) · xrefs · SHX fonts from the user's font folders · CTB/STB · print/plot to a system printer · PDF/A-2b · IFC 2x3 / 4 / 4.3 import as reference model · PDF underlay with vector snap |
| **V2** | dynamic-block parameters (read-only visibility states), multileader styles editing, IFC elements mapped to editable building objects, Parasolid x_t through a licensed translator (owner decision) |
| Out of scope | AP242 PMI, GVP, JT, QIF, LOTAR (aerospace 04) · IFC 4.3 export and plant data (plant 08) · LandXML (civil, `docs/CIVIL.md`) · DGN · Revit / native MCAD formats · 3D ACIS solids inside DWG beyond visual mesh (L1) |

## 5. Functional requirements

### 5.1 Fidelity levels (used by every requirement below)

| Level | Name | Meaning after import | Example |
| ----- | ---- | -------------------- | ------- |
| L0 | dropped | not in the document; counted and named in the fidelity report | (never allowed silently) |
| L1 | visual | looks the same, but as simpler llull entities (exploded geometry, mesh, raster) | a DIMENSION as lines + text |
| L2 | geometric | a native llull entity with exact geometry and its display properties; semantics partly lost | a HATCH as a filled region without its pattern definition |
| L3 | semantic | the native object with its behaviour: edits behave as in the source application | a block instance whose definition edit updates all inserts; an associative dimension re-measuring |
| L4 | lossless | L3, and an unmodified save writes back the same object (same handle, same data) | an untouched XRECORD, proxy entity or AEC object |

### 5.2 Format and entity-class matrix (target level per phase)

| Class (DWG/DXF) | Today | MVP | V1 | Notes |
| --------------- | ----- | --- | -- | ----- |
| LINE, ARC, CIRCLE, POINT, LWPOLYLINE (bulges), POLYLINE 2D/3D | L2 (3D polylines flattened) | L3 | L4 | 3D polylines keep Z (`spline`/`polyline` 3D curve kinds exist) |
| ELLIPSE, SPLINE (incl. rational) | L0 | L3 | L4 | llull has `ellipse`, `spline` kinds |
| TEXT, MTEXT (formatting codes, stacking, columns) | L1 (plain text) | L3 | L4 | |
| Text styles, SHX / TTF fonts | L0 | L2 (TTF; SHX substituted + reported) | L3 (SHX read from user folders) | Autodesk SHX files are never bundled |
| INSERT / BLOCK, MINSERT, nested blocks | L1 (exploded) | L3 | L4 | maps to llull components / instances |
| ATTDEF / ATTRIB | L0 | L3 | L4 | editable values, tag table |
| DIMENSION (all types) + DIMSTYLE | L0 | L3 for linear, aligned, radial, diameter, angular, ordinate; L1 (anonymous block geometry) for others | L4 | |
| LEADER, MULTILEADER, TOLERANCE | L0 | L1 | L3 | |
| HATCH (pattern, solid, gradient), boundaries, islands | L0 | L3 (pattern, solid); L2 (gradient) | L4 | |
| LTYPE (simple, complex), LTSCALE, lineweight, ACI / true colour / colour book, transparency | name only / ACI | L3 | L4 | |
| LAYER properties (on, frozen, locked, plot, colour, linetype, lineweight, plot style) | name, ACI, visibility | L3 | L4 | |
| Layouts, paper space, VIEWPORT (scale, clip, frozen layers) | L0 | L3 | L4 | maps to llull sheets |
| XREF (attach / overlay), image references | L0 | — | L3 (resolve, reload, bind) | V1 |
| IMAGE, WIPEOUT, PDFUNDERLAY | L0 | L2 | L3 | |
| SOLID (2D), 3DFACE, MESH, POLYFACE | 3DFACE only (L1) | L2 | L3 | |
| 3DSOLID, REGION, BODY (ACIS) | L0 | L1 (tessellated mesh) | L1 | ACIS→B-rep is out of scope |
| ACAD_TABLE, MLINE, XLINE, RAY, SHAPE | L0 | L1 | L3 (TABLE, XLINE, RAY) | |
| Proxy / custom / AEC objects, XDATA, dictionaries, XRECORD | L0 | L0 reported | L4 pass-through | |
| Plot styles CTB / STB | L0 | — | L3 | V1 |
| **STEP** AP203 / AP214 / AP242 solids, assemblies, names, part + face colours, layers | exact (UI) / mesh (CLI) | L3 exact B-rep everywhere | L4 for llull-authored files | PMI, GVP: aerospace 04 |
| **IGES** 5.3 | exact (import_iges / export_iges) | unchanged; corpus-proved | — | aerospace 04 FR-XCH-10/11 |
| **IFC** 2x3 / 4 / 4.3 | L0 | — | L2 reference model (geometry + class + GlobalId + Psets) | V2: editable building objects |
| **PDF** out | L0 | vector, scale, fonts, layers | PDF/A-2b | |
| **PDF** underlay | L0 | — | L2 (vector snap) | |
| **Parasolid** x_t | L0 | — | — | V2 COULD, licensed translator |

### 5.3 Requirements

| Id | Pri | Requirement | Rationale | Source | Persona |
| -- | --- | ----------- | --------- | ------ | ------- |
| FR-XCH-101 | MUST | Open DWG files of every version AC1009 (R11/12) … AC1032 (2018+) in the desktop app and the CLI with no third-party program installed and no network | today: converter on `PATH` required; refused on a fresh machine | M2; [R14] | all |
| FR-XCH-102 | MUST | Open ASCII and binary DXF of the same versions | binary refused today | M1; [R14] | all |
| FR-XCH-103 | MUST | Every DWG/DXF entity class reaches at least the MVP level of §5.2; no class is L0 except proxy / custom objects, which are counted | 22 types skipped today on the sample | M1 | all |
| FR-XCH-104 | MUST | Blocks stay blocks: definitions (with base point, units, nested blocks) become component definitions and INSERT / MINSERT become instances with position, scale (incl. non-uniform and mirrored), rotation and array; editing a definition updates every instance; `explode` is a separate explicit command | blocks exploded today | M1 | all |
| FR-XCH-105 | MUST | Attributes: ATTDEF (tag, prompt, default, flags) and ATTRIB (value, position, style) are kept, displayed, editable per instance, and listable as a table (block, tag, value) | ATTRIB dropped, ATTDEF skipped today | M1 | civil, plant |
| FR-XCH-106 | SHOULD | Xrefs (attach and overlay, nested) resolve relative to the host file, show read-only on their own layer namespace, can be reloaded and bound; a missing xref keeps its insert and is reported | daily in multi-discipline offices | — | civil, steel, plant |
| FR-XCH-107 | MUST | Layouts become llull sheets: paper size and orientation, plot scale, title-block content in paper space, and every viewport (centre, model view, scale, clip boundary, per-viewport frozen layers) | layouts ignored today; sheets are A-series landscape only | M1; `model/sheet.ts` | all |
| FR-XCH-108 | MUST | Dimensions are associative llull dimensions with their measured value, override text, and dimension style (arrows, text style/height/gap/position, extension offsets, units, precision, rounding, tolerances, scale); types without an L3 mapping show their stored block geometry (L1) and are reported | dimensions skipped today | M1 | all |
| FR-XCH-109 | MUST | Hatches keep pattern name, definition, scale, angle, origin, solid fill, boundary loops (line, arc, ellipse, spline, polyline edges), islands and associativity; gradients render (L2) | skipped today | M1; [R37] | all |
| FR-XCH-110 | MUST | Text and MTEXT keep content, formatting (font, height, width factor, oblique, colour, stacking, paragraphs, columns), attachment point, rotation and text style; Unicode and legacy code pages decode correctly | MTEXT flattened today | M1 | all |
| FR-XCH-111 | MUST | Fonts: TTF / OTF referenced by a style are resolved from the document, the system or user font folders; SHX fonts are read from folders the user names (never shipped by llull); a missing font is replaced by a declared substitute and reported with both names | Autodesk SHX files belong to Autodesk | [R40]; FR-XCH-132 | all |
| FR-XCH-112 | MUST | Linetypes (simple and complex with text / shapes), global and object linetype scale, paper-space linetype scaling, lineweights, ACI / true colour / colour-book colours and transparency are kept and displayed | not modelled today | M1 | all |
| FR-XCH-113 | MUST | Layer table: on/off, frozen, locked, plot flag, colour, linetype, lineweight, transparency, plot style, description | name + ACI only today | M1 | all |
| FR-XCH-114 | SHOULD | Plot styles: read CTB (colour-dependent) and STB (named) tables; a document or layout names its table; print and PDF apply colour, lineweight, screening and linetype from it | lineweights are decided at plot time in AutoCAD | [R30][R31] | all |
| FR-XCH-115 | MUST | Save as DWG AC1032 (default), AC1027, AC1024, AC1018, AC1015, and DXF (ASCII; binary SHOULD) of those versions plus R12; every llull 2D class is written as its native DWG/DXF object (associative DIMENSION with its block, HATCH, MTEXT, BLOCK/INSERT/ATTRIB, LAYOUT/VIEWPORT), not exploded | only R12 DXF today, exploded dimensions | code survey | all |
| FR-XCH-116 | SHOULD | Pass-through: objects llull does not model (proxy entities, custom objects, XDATA, extension dictionaries, XRECORDs, AEC objects) survive open → edit other things → save, with their handles; editing an entity keeps its handle | the receiving office's data must not vanish | — | all |
| FR-XCH-117 | MUST | Every import and export returns a fidelity report: per entity / object type the input count and the count at each level L0–L4, every approximation or loss with a stable code (TECHNICAL_SPEC §7), and the handles concerned; the report is stored with the document provenance and shown in the UI | AF-11; the CAD manager's QA | — | all |
| FR-XCH-118 | MUST | Round-trip: DWG/DXF → llull → same format keeps entity counts by type, geometry within 1e-9 × the drawing extent, layer / colour / linetype / lineweight / text / attribute values exactly, and block structure; llull → DWG → llull likewise | the definition of "no loss" | spec budget | all |
| FR-XCH-119 | MUST | Units are explicit: `$INSUNITS` / `$MEASUREMENT` are read and converted exactly; when absent the import uses the stated `sourceUnit` or the document unit and warns `XCH_DRW_UNITS_ASSUMED` | R12 files carry no `$INSUNITS` | M1 | all |
| FR-XCH-120 | MUST | Malformed, truncated, oversized or hostile files never crash or hang the app, never change the document, and return a coded refusal; a recover mode imports what is readable and lists what is not | files come from outside the trust boundary | aerospace 04 FR-XCH-15 | all |
| FR-XCH-121 | MUST | Opening a drawing reports progress and stays within the open budget of TECHNICAL_SPEC §8 | daily files are 1–50 MB | spec budget | all |
| FR-XCH-122 | MUST | STEP AP203 / AP214 / AP242 import is exact B-rep by default on every surface (UI, CLI, `--app`): product tree as components / instances, product names (Unicode), part and face colours, layers, units; a mesh result happens only on explicit request or with the code `XCH_STEP_FALLBACK_MESH` and its reason | CLI path is mesh today; colours / names dropped | [R16]; QUALITY_GATES #3, #14 | mechanical |
| FR-XCH-123 | MUST | Imported exact bodies are editable with the direct-edit and B-rep commands (move / push-pull / delete / replace faces, fillet, chamfer, shell, boolean, split); recognised features (`recognize_features`) are reported, and converting them into feature-history steps is SHOULD; the import never claims a parametric history it does not have | the supplier part must be modified | design 04, aerospace 07 | mechanical |
| FR-XCH-124 | MUST | STEP export of llull bodies and assemblies keeps tree, names (Unicode, not double-encoded), colours and placements on re-import | CadQuery double-encodes non-ASCII names | QUALITY_GATES | mechanical |
| FR-XCH-125 | SHOULD | IGES 5.3 import / export (existing commands) pass the corpus cases on the shipped desktop build | proven in dev only | aerospace 04 | mechanical |
| FR-XCH-126 | COULD | Parasolid x_t / x_b import through a licensed translator, decided by the owner | suppliers using Parasolid-based CAD | [R4] | mechanical |
| FR-XCH-127 | SHOULD | IFC 2x3 / IFC4 / IFC 4.3 import as a reference model: spatial structure, every product with class, GlobalId, name, type, property sets and quantities, geometry (exact when available, else mesh); queryable and hideable by class / storey; never edited in place in V1 | architect's model as reference | [R33][R35] | steel, plant, civil |
| FR-XCH-128 | MUST | PDF output of one sheet / layout or a set: vector geometry (no rasterised lines or text), true scale (a 1:N sheet prints model length L as L/N within 0.1 mm), paper sizes ISO A0–A4 and ANSI A–E both orientations plus custom, fonts embedded and subset, text searchable, one optional-content layer per drawing layer, document metadata, deterministic bytes | SVG only today | [R27][R28] | all |
| FR-XCH-129 | SHOULD | PDF/A-2b output option that passes an independent validator | archive of issued drawings | [R27][R28][R29] | all |
| FR-XCH-130 | SHOULD | Print / plot: a sheet, layout or window to a system printer or to PDF with paper, orientation, plot area (layout / extents / window), scale (or fit, reported), offset / centre, plot style table, lineweight scaling, preview, and a batch over several sheets | no print today | [R20][R30] | all |
| FR-XCH-131 | SHOULD | PDF underlay: attach a page of a PDF as an underlay with scale, rotation, clip, layer (optional-content) visibility and calibration by two points; snap to its vector geometry; convert a region of it to llull 2D entities (COULD) | vendor drawings arrive as PDF | [R24][R26] | plant, civil |
| FR-XCH-132 | MUST | No GPL-licensed code is linked into or shipped with the app; every bundled exchange component has a recorded licence, notice and obligations check; the product uses "DWG" only as a file-format name | llull is closed-source; DWG trademark history | [R7][R38][R42] | all |
| FR-XCH-133 | MUST | File › Open accepts `.dwg`, `.dxf`, `.step/.stp`, `.igs/.iges`, `.ifc` and opens them as a document (not only "import into"); File › Save As offers DWG and DXF versions; File › Export PDF and File › Print exist; each is one registered command with a CLI path | today exchange is in panels only | `desktop/src/menu.ts` | all |
| FR-XCH-134 | MUST | Every capability and refusal is a registered command or a coded finding, works offline, and is deterministic (same input → same document, same output bytes) | L1, AF-11, AF-41 | AGENT_FIRST | all |

## 6. Workflows

**Desktop (primary).** File › Open `site-survey.dwg` → progress → the drawing opens with its layouts as sheet tabs; a
fidelity badge in the status bar (green: nothing below target; amber: approximations; red: losses) opens the report table
(type, count, level, code, handles, "select"). Edit; File › Save As › DWG 2018. File › Export PDF › all layouts, PDF/A-2b,
plot style `office.ctb` → one PDF. File › Print › printer, A3, 1:100.

**CLI (agents and scripts).**

```text
llull open_drawing file=site.dwg --doc site.llull.json            # FR-XCH-101..119
llull fidelity_report --doc site.llull.json --json                 # FR-XCH-117
llull export_drawing format=dwg version=AC1032 --save out.dwg --doc site.llull.json
llull export_pdf sheets=all pdfa=2b plotStyle=@office.ctb --save set.pdf --doc site.llull.json
llull import_step file=supplier.step --app                         # exact by default (FR-XCH-122)
llull import_ifc file=arch.ifc mode=reference --app                # FR-XCH-127
llull add_pdf_underlay file=vendor-ga.pdf page=1 --app             # FR-XCH-131
llull print_sheet sheetId=S1 printer="Microsoft Print to PDF" scale=100 --app   # FR-XCH-130
```

## 7. Acceptance criteria

| Given | When | Then | VC |
| ----- | ---- | ---- | -- |
| the eight ACadSharp sample DWGs AC1014…AC1032 on a machine with no converter | open each | all open; identical census across versions of the same drawing | VC-XCH-101, 102 |
| the sample drawing as ASCII and binary DXF | open | census equals the independent oracle census | VC-XCH-103 |
| the AutoCAD 2018 sample (31 entity types) | open | 0 records of a MUST class below MVP level; the fidelity report sums to the input census | VC-XCH-104, 119 |
| the same drawing | inspect blocks, attributes, dimensions, hatches, MTEXT, linetypes, layers, layouts | counts and values equal the oracle | VC-XCH-105…113 |
| a host DXF with an xref, a missing xref and a cycle | open | resolved / `XCH_DRW_XREF_UNRESOLVED` / `XCH_DRW_XREF_CYCLE` | VC-XCH-114 |
| the sample DWG, one line moved | save as AC1032 | every other object unchanged with its handle | VC-XCH-115 |
| DXF and DWG round trips | open → save → independent re-read | counts, values and geometry within §5.3 FR-XCH-118 bounds | VC-XCH-116, 117 |
| the exported DWG | open in DWG TrueView (recorded review) | no recovery prompt; drawing matches | VC-XCH-118 |
| a truncated or mutated DWG | open | coded refusal, document unchanged, no crash | VC-XCH-121 |
| the supplier assembly `as1-oc-214` | `import_step` from the CLI | exact bodies, 18 placed parts, names and colours kept | VC-XCH-123 |
| an imported exact cube | push-pull a face by 5 mm | volume grows by face area × 5 | VC-XCH-124 |
| a 1:1 sheet with a 100 mm line on A3 | export PDF | MediaBox 1190.55 × 841.89 pt; line 283.465 pt; no raster; fonts embedded; layers as OCGs | VC-XCH-130…132 |
| the same with `pdfa=2b` | validate | 0 failed rules | VC-XCH-133 |
| a 1:50 sheet | print to "Microsoft Print to PDF" | 1000 mm model line measures 20.0 mm | VC-XCH-134 |

## 8. Standards and formats

- DWG: no public Autodesk specification; implementations use the ODA "Open Design Specification for .dwg files" [R10] (its
  terms are an open legal question, §10). DXF: Autodesk DXF Reference [R14].
- STEP: ISO 10303-21 / -203 / -214 / -242 through OCCT [R16]; CAx-IF recommended practices for styling and validation
  properties [R18]; NIST MBE PMI test models [R19]. Detailed AP242 work: aerospace 04.
- IGES 5.3 through OCCT [R17].
- IFC: ISO 16739-1:2024 (IFC 4.3) [R35]; IFC2x3 and IFC4 read.
- PDF: ISO 32000-2 (PDF 2.0) and PDF 1.7; PDF/A-2 (ISO 19005-2), PDF/A-4 (ISO 19005-4) [R28].
- Plot styles: Autodesk CTB / STB semantics [R30][R31].

## 9. KPIs

| KPI | Today | Target |
| --- | ----- | ------ |
| DWG versions opened on a fresh install (of 9: AC1009…AC1032) | 0 (converter required) | 9 |
| Records skipped on the AutoCAD 2018 sample (`sample_AC1032_ascii.dxf`) | 70 records, 22 types | 0 records of MUST classes; proxies counted |
| Blocks kept as blocks / attributes kept | 0 / 0 | 100 % / 100 % |
| DWG versions written | 0 | 5 (AC1015, AC1018, AC1024, AC1027, AC1032) |
| CLI STEP import exact with names and colours | no (mesh, names and colours dropped) | yes |
| PDF output | none | vector, true scale, embedded fonts, layers; PDF/A-2b passes |
| Round-trip deviation | R12 writer rounds to 1e-6 units | ≤ 1e-9 × extent |

## 10. Risks and assumptions

- **Codec maturity.** acadrust is young (repository created 2026-01-20 [R10]); its fidelity is not yet proved. The corpus
  (VC-XCH-101…118) is the qualification test; if it fails after M1, the fallback is the ODA Drawings SDK (cost, closed source,
  distribution right lost if the membership ends [R4]).
- **Legal.** (a) llull's own licence is undecided; (b) MPL-2.0 file-level obligations for acadrust [R38]; (c) whether code
  derived from the ODA specification carries obligations toward the ODA; (d) LGPL-3.0 compliance for IfcOpenShell inside an
  Electron bundle; (e) redistribution terms of the ODA File Converter (not stated on its page [R5]); (f) "DWG" as a trademark:
  Autodesk and the ODA settled in 2010, the ODA dropping DWG-based marks [R7] (grade B). Each needs counsel; see
  TECHNICAL_SPEC §11.
- **Oracles.** Fidelity is judged by readers independent of the codec: ezdxf (MIT) for DXF, LibreDWG `dwgread` (GPL-3.0,
  test-only, never shipped) and ACadSharp for DWG, DWG TrueView by a recorded human review. A shared misreading between codec
  and oracle stays possible; the cross-version equivalence check (VC-XCH-102) reduces it.
- **Fonts and patterns.** Autodesk SHX fonts and `acad.pat` belong to Autodesk; llull reads the user's copies and ships only
  openly licensed substitutes (licence of the substitute set: TBD — record in `sources.md` when chosen).
- **Scope creep.** Dynamic blocks, multileader styles and annotative scaling are deep; MVP keeps them at L1 with a code.

## 11. References

Grades and what was taken: [`validation/sources.md`](validation/sources.md). Ids R1–R42 and measurements M1–M4 are defined
there.
