# 08 XCH — Exchange fidelity for daily files — Technical specification

Status: specification only (2026-10-28). Functional view: [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md). Validation:
[`validation/README.md`](validation/README.md). Laws: [`../../../.claude/rules/architecture.md`](../../../.claude/rules/architecture.md).
Ids start at 101 (aerospace 04 owns `TR-XCH-01..27`).

## 1. Current state in llull (origin/main `f1351cff`, 2026-10-28)

| Area | Where | Behaviour today | Limit |
| ---- | ----- | --------------- | ----- |
| DXF read | `packages/core/src/commands/exchange/importDxf.ts`; `lib/dxfRead.ts` (383 lines); `lib/dxfUnits.ts` | pure TS, ASCII only; LINE, POINT, LWPOLYLINE (bulges densified), POLYLINE 2D/3D, ARC, CIRCLE, TEXT, MTEXT (codes stripped), 3DFACE (one mesh per layer), INSERT exploded to depth 8; `MAX_DXF_ENTITIES = 20000`, 200,000 primitives; everything else counted as "skipped" in the summary text | measured M1: 70 records of 22 types skipped on `sample_AC1032_ascii.dxf`; ATTRIB dropped silently (`groupPolylines`), no error codes |
| DWG read | `packages/protocol/src/exchangeTools.ts` (`import_dwg`), `server/src/dwgConvert.ts` | external `dwg2dxf -y -o` (LibreDWG) or ODA File Converter `ACAD2018 DXF`, then `import_dxf`; 60 s / 50 MB caps; nothing bundled by `desktop/scripts/` | measured M2: refused on the owner's workstation |
| DXF write | `lib/dxfWriter.ts` (R12 `AC1009`, `$INSUNITS`, LTYPE + LAYER tables, LINE/CIRCLE/ARC/TEXT/POLYLINE/SOLID/POINT/3DFACE, 6-decimal rounding); used by `domain-aec/.../dxfExport.ts` (`export_building_dxf`, also writes the document's own 2D drafting), `civilDxf.ts`, `domain-aero/.../flatPatternDxf.ts`, `sheetmetal/dxfFlat.ts` | no generic `export_dxf`; dimensions exploded; R12 layer-name sanitising | no DWG, no blocks, no hatches, no MTEXT |
| Drafting model | `model/types.ts` `SHAPE2D_KINDS` = line, polyline, arc, circle, rectangle, point, ellipse, spline, text, dimension, image; `model/drawing.ts` (ISO 128 styles `cut/visible/thin/hidden/center/annotation`, fill `hatch \| solid`) | components / instances exist (`commands/assembly/assemblies.ts` `create_component`, `insert_instance`, `explode_instance`) | no hatch entity, no text / dimension styles, no linetype / lineweight table, no plot styles, no attributes, no xrefs |
| Sheets | `model/sheet.ts` (`PAPER_SIZES` A4–A0 landscape, views of 3D entities: projection / section / detail), `commands/drawings/*` (`create_sheet`, `export_sheet_svg`), `commands/drawings/sheetFrame.ts` (`font-family="Helvetica, Arial, sans-serif"`), `geometry/drawingSvg.ts` | SVG string, ISO line weights, hatched sections | no PDF, fonts not embedded, no ANSI / portrait / custom paper, no 2D model-space viewports |
| Fonts | `model/fonts.ts` (`FontRecord`: truetype, cff, `x-llull-stroke`; embedding permission from OS/2 `fsType`), `commands/wrap/importFont.ts` | fonts embedded in the document as blobs | no SHX |
| Underlays | `add_image_underlay`, `calibrate_underlay`, `set_underlay` | raster images | no PDF |
| STEP | `commands/exchange/importStepExact.ts` (exact healed B-rep blobs, XDE product tree, provenance, GVP; codes `KRN_STEP_*`, `KRN_NO_EXACT_KERNEL`); `exportStepAp242.ts`; UI `src/ui/components/ExchangeImport.tsx` dispatches `import_step_exact` / `import_iges`; CLI `import_step` → Python bridge → `import_mesh` | quality gate 1 runs the mesh path (`server/tests/quality/stepImport.gate.ts`) | two paths; CLI default is the mesh; known issues #3 names/colours, #14 face colours on the mesh path |
| B-rep editing | `commands/brep/` (`move_faces`, `delete_faces`, `push_pull_face`, `draft_faces`, `replace_face`, `split_face`, `fillet_edge`, `chamfer_edge`, `shell_solid`, `boolean`, `split_body`); `commands/features/recognizeFeatures.ts` | direct edit on exact bodies | not proved on imported bodies by a gate |
| IGES | `commands/exchange/igesExchange.ts` (`import_iges`, `export_iges` with self-check) | exact via kernel | corpus run on the desktop build not recorded |
| IFC | `domain-aec/src/building/exchange/ifcBuild.ts` (`export_ifc`) | export only | no import |
| Print / PDF | none in `desktop/src/menu.ts` (File: New, Open, Save, Save As, Vault, Data folder, Trust keys) | — | no print, no PDF |
| Corpus | `quality/corpus.json` (8 DXF files pinned with `"gate": "none: llull has no DXF importer yet"` — stale, `import_dxf` exists), `quality/fetchCorpus.mjs`, `quality/step_reference.py`, `quality/synthetic_step.py` | sha256-pinned, downloaded, never committed, `knownIssues` ratchet | no drawing gate, no export round-trip gate (QUALITY_GATES "proposed next gates" #1, #5) |

## 2. Target architecture

| Milestone | Layer | Placement | Laws |
| --------- | ----- | --------- | ---- |
| M1 drawing codec | `solver/crates/llull-drawing` (Rust, sidecar binary `llull-drawing`), host transport `server/src/nativeDrawing.ts`, core port `DrawingCodec` (`packages/core/src/geometry/drawingCodec.ts`, interface only) read from `ctx.drawingCodec` | bytes ⇄ **Drawing Interchange Model** (DIM, §3) in the sidecar; DIM ⇄ document inside pure commands | C7 (Rust default), L2, L9 pattern (injected port), L6 (host thin) |
| M2 drafting model | core `model/` (new kinds and tables), `commands/draw2d`, `commands/drawings`, render branches in `src/ui/viewport/2d` | L3 mapping of §5.2 | L4, L7, `add-entity-kind` skill |
| M3 STEP default | `packages/protocol/src/exchangeTools.ts` (`import_step` → `import_step_exact`), `quality/` gate on the exact path; bridge mesh path kept only as `mode: "mesh"` until LC1 removes it | one exact path | L9, LC1 |
| M4 pass-through | DIM `opaque` records stored as a document blob; codec re-emits them | L4 level | L3 (pure: blob is data) |
| M5 PDF + print | `solver/crates/llull-pdf` (Rust sidecar), sheet display list from core `geometry/` (shared with SVG); print in `desktop/` main process | vector writer; Electron print for devices | C7, L2 (no DOM in core), L6 |
| M6 IFC + PDF underlay | `llull-ifc` sidecar (IfcOpenShell C++, LGPL-3.0, separate executable) ; PDF underlay rendering in `llull-pdf` (PDFium) | reference model; underlay vectors | L9 pattern, licence isolation |

Commands stay pure: a command receives a DIM (or calls `ctx.drawingCodec.read(bytes)`, like `ctx.kernel`) and returns a new
document. Commands that need the codec declare `annotations: { requiresDrawingCodec: true }` and `execute` refuses with
`XCH_DRW_CODEC_UNAVAILABLE` when the host has none (same mechanism as `kernelRefusal.ts`). The TS `dxfRead.ts` /
`dxfWriter.ts` and `server/src/dwgConvert.ts` become legacy once M1 is the default and are removed then (product directive);
domain exporters (`export_building_dxf`, `export_civil_dxf`, flat patterns) re-target `export_drawing` with their own layers.
No architecture law changes.

### 2.1 Technical requirements

| Id | Pri | Requirement | FR | VC |
| -- | --- | ----------- | -- | -- |
| TR-XCH-101 | MUST | Rust sidecar `llull-drawing` (acadrust) reads / writes DWG AC1009–AC1032 and DXF ASCII + binary into / from the DIM (§3); host transport `server/src/nativeDrawing.ts`; core port `DrawingCodec` on `ctx.drawingCodec`; commands annotated `requiresDrawingCodec` are refused with `XCH_DRW_CODEC_UNAVAILABLE` without it | 101, 102, 115 | 101, 103, 117 |
| TR-XCH-102 | MUST | The codec fills `census` (every record, by type) before any mapping; the fidelity report satisfies `sum(levels[t]) == census[t]` for every type | 103, 117 | 104, 119 |
| TR-XCH-103 | MUST | Drafting model additions of §3 (hatch, leader kinds; styles, linetypes, plot styles; layer and entity properties; attributes; layouts as sheets with `model2d` views), each through the `add-entity-kind` checklist and one document migration | 104–113 | 105–113 |
| TR-XCH-104 | SHOULD | `sourceHandle` kept on imported entities; unmodelled records stored as a content-addressed `opaque` blob and re-emitted on export when their owner still exists | 116 | 115 |
| TR-XCH-105 | MUST | `export_drawing` re-reads what it wrote with the codec and refuses (`XCH_DRW_WRITE_SELFCHECK`, nothing written) when the census differs from the intended one | 115, 118 | 116, 117 |
| TR-XCH-106 | MUST | Parsers for MTEXT inline codes, `.lin`, `.pat`, SHX (user folders only) with substitution table and codes | 110, 111, 112 | 109, 110, 111, 112 |
| TR-XCH-107 | MUST | `import_step` defaults to `import_step_exact` when the exact kernel is present; XDE face colours and layers read; mesh only by `mode: "mesh"` or with `XCH_STEP_FALLBACK_MESH` | 122, 124 | 123, 126 |
| TR-XCH-108 | MUST | Every `commands/brep/*` command accepts imported exact bodies (one test per command on an imported file) | 123 | 124, 125 |
| TR-XCH-109 | MUST | One sheet display list (`geometry/sheetDisplayList.ts`) feeds both the SVG and the PDF writers | 128 | 130, 131, 132 |
| TR-XCH-110 | MUST | Rust `llull-pdf` writer: mm → pt exact, OCG per layer, embedded subset fonts with `ToUnicode`, PDF/A-2b mode, deterministic bytes | 128, 129 | 130–133, 139 |
| TR-XCH-111 | SHOULD | `print_sheet` through a host port `ctx.printer` (Electron `webContents.print`, physical size, no margins, no fit unless asked); CTB / STB parser | 114, 130 | 134, 135 |
| TR-XCH-112 | SHOULD | `llull-ifc` sidecar (IfcOpenShell, separate executable) → reference-model JSON + exact or mesh geometry | 127 | 129 |
| TR-XCH-113 | SHOULD | PDF underlay: PDFium in `llull-pdf` → raster tiles + vector path list with OCG names; calibration by two points | 131 | 136 |
| TR-XCH-114 | MUST | Drawing gate in `quality/` (corpus entries, independent oracles ezdxf / LibreDWG `dwgread` / ACadSharp on the test machine only, `knownIssues` ratchet) | 103, 118 | 102, 104, 116 |
| TR-XCH-115 | MUST | Sidecar limits (bytes, time, memory) and `cargo fuzz` targets on the DWG and DXF readers | 120, 121 | 121, 122 |
| TR-XCH-116 | MUST | Determinism: no clock or random values in any written file; stable object order | 134 | 139 |
| TR-XCH-117 | MUST | When the codec is the default: remove `lib/dxfRead.ts`, `lib/dxfWriter.ts` (domain exporters re-targeted), `server/src/dwgConvert.ts` and the bridge STEP mesh path (product directive) | 101, 115, 122 | 117, 123 |
| TR-XCH-118 | MUST | The packaging step emits a third-party licence inventory and fails on a GPL / AGPL component in the bundle | 132 | 137 |
| TR-XCH-119 | MUST | File menu items Open (dwg, dxf, step, iges, ifc), Save As (DWG / DXF versions), Export PDF, Print, each dispatching a registered command | 133 | 138 |
| TR-XCH-120 | MUST | Every code of §7 is emitted by at least one test; no code of aerospace 04 is redefined | 117, 134 | 140 |

## 3. Data model

```ts
// packages/core/src/model/drawingInterchange.ts — the DIM: neutral, versioned, JSON-serialisable
interface DimFile {
  readonly version: 1;
  readonly source: { format: 'dwg' | 'dxf'; acadVer: AcadVersion; binary: boolean; sha256: string; codePage?: string };
  readonly header: { insUnits?: number; measurement?: 0 | 1; ltScale: number; psLtScale: boolean; extents?: Box2 };
  readonly tables: { layers: DimLayer[]; lineTypes: DimLineType[]; textStyles: DimTextStyle[]; dimStyles: DimDimStyle[] };
  readonly blocks: DimBlock[];              // incl. *Model_Space, *Paper_Space*, anonymous *D / *U / *X blocks
  readonly layouts: DimLayout[];            // paper, plot settings, viewports, plot style table name
  readonly xrefs: DimXref[];
  readonly opaque: DimOpaque[];             // records llull does not model (L4 pass-through), with handle + owner + raw bytes ref
  readonly census: Record<string, number>;  // per DXF type name, counted by the codec before mapping
}
type AcadVersion = 'AC1009' | 'AC1012' | 'AC1014' | 'AC1015' | 'AC1018' | 'AC1021' | 'AC1024' | 'AC1027' | 'AC1032';
```

Document additions (one `migrate` step; owner rule: no backward-compat shims for removed values):

| Addition | Shape | Notes |
| -------- | ----- | ----- |
| `doc.drafting.lineTypes` | `{ name, description, pattern: number[], complex?: ShapeOrText[] }` | ISO 128 `LINE_PATTERNS` become entries |
| `doc.drafting.textStyles` | `{ name, fontId \| shxName, height, widthFactor, oblique, flags }` | fonts via `FontRecord` (+ `format: 'shx'`) |
| `doc.drafting.dimStyles` | DIMSTYLE subset: `dimasz, dimtxt, dimgap, dimexo, dimexe, dimdec, dimlunit, dimrnd, dimscale, dimtol, dimlim, dimtp, dimtm, dimblk*` | named; overrides per dimension |
| `doc.drafting.plotStyles` | parsed CTB / STB tables, `kind: 'ctb' \| 'stb'` | FR-XCH-114 |
| `Layer` | `+ frozen, plot, lineTypeName, lineWeight (hundredths mm, ByLayer/-3 default), transparency, plotStyleName, trueColor` | |
| `BaseEntity` | `+ lineTypeName?, lineTypeScale?, lineWeight?, trueColor?, transparency?, sourceHandle?` | `sourceHandle` = DWG handle (hex), kept across edits |
| new `Shape2DKind` `hatch` | `{ pattern: {name, lines[]} \| 'solid' \| gradient, scale, angle, origin, loops: Loop2[], associativeTo?: string[] }` | `add-entity-kind` checklist |
| new `Shape2DKind` `leader` | leader / multileader (V1 L3; MVP L1) | |
| `text` | `+ rich?: MTextRun[], attachment, styleName` | MTEXT |
| `dimension` | `+ styleName, overrides, measurement, textOverride, blockGeometry?` | associative |
| components / instances | `+ attributes: {tag, value, defId}[]`; component `+ attributeDefs`, `basePoint`, `sourceBlockName`; instance `+ array {cols, rows, dx, dy}` (MINSERT) | blocks |
| `DrawingSheet` | `+ paper: PaperSize \| {widthMm, heightMm}`, `orientation`, `plotStyle?`, `plotArea`, views kind `model2d` (center, scale, clip polygon, frozen layer ids) | layouts; ANSI A–E added to `PAPER_SIZES` |
| `doc.exchange.drawingSources` | per imported file: DIM header, `opaque` blob key, census, fidelity report | provenance |

## 4. Commands

| Command | Kind | Params sketch | Tags |
| ------- | ---- | ------------- | ---- |
| `open_drawing` | mutating (replace) | `{ fileBase64 \| path, format?: 'dwg'\|'dxf', sourceUnit?, layers?, recover?: boolean }` | `@affects` whole document · `@invariant` fidelity report sums to `census` · `@failure` `XCH_DWG_*`, `XCH_DRW_*` → no-op |
| `import_drawing` | mutating (append) | same + `asBlock?: string`, `at?: Vec3` | inserts as block / xref-like component |
| `export_drawing` | query (`writesArtifact`) | `{ format, version: AcadVersion, binary?, layouts?: 'all'\|ids }` | `@invariant` re-read by codec: census equal (self-check) · `@failure` `XCH_DRW_WRITE_SELFCHECK` |
| `fidelity_report` | query | `{ sourceId? }` | returns the stored report |
| `explode` | mutating | `{ ids }` | block → entities (explicit L3 → L1) |
| `attach_xref` / `reload_xref` / `bind_xref` | mutating | `{ path, mode: 'attach'\|'overlay', at, scale, rotation }` | V1 |
| `set_dim_style`, `set_text_style`, `set_line_type`, `load_line_types` (from `.lin` text), `load_hatch_patterns` (`.pat`) | mutating | table edits | |
| `add_hatch` | mutating | `{ boundaryIds \| loops, pattern, scale, angle }` | `@invariant` loops closed, islands nested |
| `load_plot_style` / `set_plot_style` | mutating | `{ fileBase64 }` CTB / STB → `doc.drafting.plotStyles` | V1 |
| `export_pdf` | query (`writesArtifact`) | `{ sheetIds \| 'all', pdfa?: '2b'\|'4', plotStyle?, lineWeightScale?, layers?: boolean, fonts: 'embed' }` | `@invariant` vector; scale exact · `@failure` `XCH_PDF_*` |
| `print_sheet` | query (host effect via `ctx.printer` port) | `{ sheetId \| window, printer, paper, orientation, scale \| 'fit', plotStyle?, copies }` | `@failure` `XCH_PLOT_DEVICE_UNAVAILABLE` |
| `add_pdf_underlay` | mutating | `{ fileBase64 \| path, page, scale, rotation, at, clip? }` | blob stored; vectors cached |
| `import_ifc` | mutating | `{ fileBase64 \| path, mode: 'reference' }` | `@failure` `XCH_IFC_*` |
| `import_step` (protocol) | exchange tool | default `mode: 'exact'` → `import_step_exact`; `mode: 'mesh'` explicit | FR-XCH-122 |

All are snake_case, defined with `defineCommand` + zod, registered in `commands/exchange/catalog.ts` (core) or the AEC plugin
(`import_ifc`), toolset `exchange`; UI File menu items call the same commands (FR-XCH-133).

## 5. Algorithms and libraries

### 5.1 DWG / DXF codec — recommendation

| Option | Licence | Coverage (as published) | Fit | Verdict |
| ------ | ------- | ----------------------- | --- | ------- |
| **acadrust** 0.6.8 (Rust) | MPL-2.0 [R10] | DXF ASCII/binary and DWG read/write AC1009 … AC1032; 48 entity types incl. dimensions, viewports, underlays, 3D solids; tables, layouts, dynamic blocks; failsafe recovery reads; DWG reader/writer ported from ACadSharp (MIT) [R10] | Rust (C7 default), in-process in a sidecar, no runtime to bundle | **Recommended primary**, qualified by VC-XCH-101…118 before it becomes default |
| ACadSharp (C#) | MIT [R8] | DXF read AC1009–AC1032, write AC1012–AC1032; DWG read AC1014–AC1032, write all of those but AC1021 [R8] | needs a .NET runtime in the installer | reference oracle for tests; fallback codec if acadrust fails and .NET is acceptable |
| ODA Drawings SDK (C++) | proprietary membership; Commercial: USD 3,000 first year / 2,250 recurring, "Commercial distribution w/100 seat limit"; Sustaining: 7,500 / 4,500, unlimited distribution; Founding: 37,500 / 18,000 with source; on termination "you lose the right to distribute the ODA-based product" [R4]; SDK may only be built into products of current members [R6] | industry-wide DWG SDK (fidelity not measured here) | native C++, fits a sidecar; recurring cost; closed source | **Contingency** if acadrust fails the corpus after M1 (owner decision, cost) |
| GNU LibreDWG 0.14 | GPL-3.0-or-later [R1] | reads all versions ("some very advanced R2010+ objects fail to read"); writer good "for everything but R2007", "R2010-R2018 writing leads to CRC errors"; `dwg2dxf` ~90 % coverage; `dxf2dwg` r2000 only, ~80 % [R1]; 0.14 released 2026-06-27 [R2] | cannot be linked into closed-source llull; separate-process use is today's path | keep only as a **user-installed** optional converter and as a **test oracle**; never bundled |
| ODA File Converter | free download for Windows / macOS / Linux; licence and bundling terms not stated on its page [R5] | DWG/DXF version conversion | external program | user-installed optional converter only, until its terms are read by counsel |
| `dxf` crate (ixmilia) | MIT [R11] | DXF and DXB read/write; versions not stated on docs.rs [R11] | DXF only | not needed if acadrust qualifies |
| libdxfrw | GPL-2.0 [R12] | DXF / DWG read (LibreCAD) | GPL | excluded |
| cadkit-dwg | Apache-2.0 [R13] | "clean-room DWG reader AC1014 … AC1032" | created 2026-10, 4 stars | watch list (grade C) |

**Why acadrust first.** It is the only option that is Rust, permissively usable in a closed-source product (MPL-2.0 is
per-file copyleft: only modified acadrust files must be published [R38]), covers read and write of every target version, and
has an MIT ancestor (ACadSharp) usable as an independent oracle. Its risk is maturity; the corpus decides. Changes llull needs
in acadrust are upstreamed (MPL obligation and maintenance).

**Mapping.** The sidecar parses bytes → DIM (counting every record in `census` before mapping). The pure command maps DIM →
document per §5.2 of the functional spec; every record not mapped at its target level produces a fidelity entry. Export maps
document → DIM, merges `opaque` records whose owners still exist, and the sidecar writes the version requested. Handles:
imported entities keep `sourceHandle`; new entities get handles above `$HANDSEED`; deleted ones release theirs.

**Fidelity report.**

```ts
interface FidelityReport {
  readonly direction: 'import' | 'export';
  readonly format: 'dwg' | 'dxf' | 'step' | 'iges' | 'ifc' | 'pdf';
  readonly version?: string;
  readonly census: Record<string, number>;                               // input, by source type
  readonly levels: Record<string, Record<'L0' | 'L1' | 'L2' | 'L3' | 'L4', number>>;
  readonly findings: { code: string; severity: 'info' | 'warn' | 'fail'; type: string; count: number; handles: string[]; detail: string }[];
  readonly selfCheck?: { reread: Record<string, number>; equal: boolean };   // export: census of the written file re-read
}
```

Invariant (unit-tested): for every type, `sum(levels[type]) == census[type]`.

### 5.2 Text, fonts, linetypes, hatches

- MTEXT: parse the inline codes (`\f \H \W \Q \T \C \c \L \O \S \P` …) into `MTextRun[]`; columns kept as metadata (L2 in MVP).
- SHX: Rust parser of shape / font / bigfont / Unicode SHX in `llull-drawing`, reading only folders the user lists
  (`settings.fontPaths`); glyphs become stroke paths (`FontRecord.format: 'shx'`, not embedded in the document unless the
  user allows). Shape description bytes: Autodesk "About Shape Descriptions" [R40]; the binary container layout has no
  Autodesk public description found (grade C) — validated against the codec's own reader and DWG TrueView rendering (review).
- Substitution table `doc.drafting.fontSubstitutions` (`{ from, to, reason }`), default from a bundled openly licensed
  single-line font (choice and licence: TBD).
- Linetypes: `.lin` text parser; complex elements with shapes require the SHX shape file; missing → simple pattern + finding
  `XCH_DRW_LINETYPE_SHAPE_MISSING`.
- Hatch patterns: `.pat` parser; a pattern named in the file but not defined → solid outline + `XCH_DRW_HATCH_PATTERN_MISSING`.
  DWG stores the pattern lines inside the HATCH entity, so most files are self-contained.

### 5.3 STEP exact by default

`import_step` (protocol tool) calls `import_step_exact` when `ctx.kernel` is the native exact kernel; the bridge mesh path
remains only for `mode: "mesh"` and is removed with LC1. XDE reading adds face colours (known issue #14) and layers
(`STEPCAFControl_Reader` ReadColor / ReadName / ReadLayer / ReadProps [R16]). Editability: imported bodies are `mesh`
entities whose `brep` points at the healed blob; every `commands/brep/*` command accepts them (test per command, VC-XCH-124).
Feature recognition boundary: `recognize_features` reports holes, pockets, fillets, chamfers, bends; a SHOULD command
`adopt_features` turns recognised holes into `hole` feature steps that cut a dumb body (history starts at the import step);
no attempt to recover sketches or design intent.

### 5.4 PDF writer (`llull-pdf`)

- Input: the sheet **display list** (paper-mm primitives with layer, style, colour, lineweight, fill, text runs with font id)
  produced by the same derivation as `export_sheet_svg` (refactor: `geometry/sheetDisplayList.ts`; SVG and PDF are two
  writers of one list, so they cannot disagree).
- Library: `krilla` (MIT OR Apache-2.0; OpenType subsetting, PDF 1.4–2.0, validated export modes PDF/A-1 … PDF/A-4 and
  PDF/UA-1 [R21]). Optional content groups are not listed in its README; if absent, layers are written with a lower-level
  PDF object writer (candidate: typst `pdf-writer`; licence and fit not yet checked) or contributed upstream. `printpdf` (MIT) has layers but
  "no conformance / error checking for various PDF standards" [R22]: second choice. `pdf-lib` (JS, MIT, last push
  2024-07 [R23]) is not chosen (C7, maintenance).
- Units: 1 mm = 72 / 25.4 pt. Paper A3 landscape = 1190.551 × 841.890 pt (derived). Lineweights from the plot style or the
  layer: stroke width (pt) = weight (mm) × 72 / 25.4 × `lineWeightScale`.
- Text: real text with embedded subset TrueType / CFF fonts and `ToUnicode`; SHX text drawn as strokes plus an invisible text
  layer for search (V1).
- PDF/A-2b: output intent sRGB, all fonts embedded, no encryption, XMP metadata; validated by veraPDF (GPL-3.0, test-only,
  never shipped [R29]).
- Determinism: no clock; `CreationDate` from the document or the caller; object order stable.

### 5.5 Print / plot

`print_sheet` asks the host through `ctx.printer` (desktop main process). The host renders the display list at physical size
in a hidden window (CSS mm units) and calls `webContents.print({ silent, deviceName, pageSize: { width, height } (µm),
margins: { marginType: 'none' }, landscape })` [R20]. Scale is never "fit" unless asked; a sheet larger than the printable
area returns `XCH_PLOT_CLIPPED` with the clipped margins. CTB: one entry per ACI colour (Autodesk help editions say 255
and 256 entries: the parser accepts both and reports the count) maps colour → output colour, lineweight, linetype, screening;
STB: named styles [R30]; Autodesk's editor offers 28 lineweights [R31]. File parsing follows the
published ezdxf `acadctb` description (zlib-compressed text body) [R32] (grade B, confirmed by round-tripping a file
generated with ezdxf, VC-XCH-135).

### 5.6 IFC import (`llull-ifc`)

IfcOpenShell C++ (LGPL-3.0 [R33]) built as its own executable linked against the same OCCT, called through a host transport;
llull never links it (separate process; the LGPL replaceability question still goes to counsel). Output: DIM-like JSON —
spatial tree, products (class, GlobalId, name, type, Psets, quantities), geometry as OCCT shapes (exact blobs) or meshes.
Alternative: web-ifc (MPL-2.0 [R34]). Plant 08 owns IFC 4.3 export and `ifc_summary`.

### 5.7 PDF underlay

PDFium (BSD-style licence [R24]) through `pdfium-render` (MIT OR Apache-2.0 [R25]) inside `llull-pdf`: page → raster tiles
for display and vector path list (lines, Béziers) for snapping, with optional-content layer names. `hayro` (pure-Rust PDF
rasteriser, Apache-2.0 OR MIT [R26]) is the alternative if a PDFium binary is unwanted.

## 6. Interop and persistence

- Imported files keep `doc.exchange.drawingSources[i] = { sha256, format, acadVer, census, report, opaqueBlob }`; `opaque`
  bytes are a content-addressed blob (`model/blobs`), so a document replays without the source file.
- Export is deterministic: same document → same bytes (DWG `$TDUPDATE` etc. from the document, never the clock).
- `quality/corpus.json` gains entries with `"format": "dwg"`, `"gate": "drawing"` and `knownIssues`; the 8 DXF entries move
  from `"gate": "none…"` to `"gate": "drawing"`.

## 7. Surfaces and stable error codes

| Code | Severity | Meaning | Remediation |
| ---- | -------- | ------- | ----------- |
| `XCH_DRW_CODEC_UNAVAILABLE` | fail | no drawing codec in this host | run in the desktop app or with the native sidecar |
| `XCH_DWG_VERSION_UNSUPPORTED` | fail | `AC10xx` code outside AC1009–AC1032 (or newer) | save as 2018 DWG in the source app |
| `XCH_DWG_CORRUPT` | fail | header / section CRC or structure invalid | retry with `recover: true` |
| `XCH_DRW_RECOVERED` | warn | recover mode skipped unreadable objects (listed) | review the listed handles |
| `XCH_DRW_TOO_LARGE` / `XCH_DRW_TIMEOUT` | fail | size / time cap (§8) | raise `LLULL_DRW_MAX_BYTES` / split the file |
| `XCH_DRW_ENTITY_DROPPED` | warn | records at L0 (type, count, handles) | none, or request support |
| `XCH_DRW_ENTITY_EXPLODED` | warn | records kept at L1 | edit as geometry |
| `XCH_DRW_APPROXIMATED` | info | records at L2 | — |
| `XCH_DRW_OPAQUE_PRESERVED` | info | records kept for pass-through only | — |
| `XCH_DRW_UNITS_ASSUMED` | warn | no `$INSUNITS`; unit assumed | pass `sourceUnit` |
| `XCH_DRW_FONT_SUBSTITUTED` | warn | font `from` → `to` | add the font folder |
| `XCH_DRW_SHX_MISSING` | warn | SHX not found in user folders | add the folder |
| `XCH_DRW_LINETYPE_SHAPE_MISSING` | warn | complex linetype shape file missing | add the shape file |
| `XCH_DRW_HATCH_PATTERN_MISSING` | warn | pattern undefined | `load_hatch_patterns` |
| `XCH_DRW_DIMSTYLE_APPROX` | info | style variables without L3 mapping (listed) | — |
| `XCH_DRW_XREF_UNRESOLVED` / `XCH_DRW_XREF_CYCLE` | warn | missing / circular xref | fix the path |
| `XCH_DRW_WRITE_SELFCHECK` | fail | re-read census of the written file ≠ intended | report a bug; nothing written |
| `XCH_DRW_ROUNDTRIP_DELTA` | fail | round-trip check over budget (gate only) | — |
| `XCH_STEP_FALLBACK_MESH` | warn | exact import impossible; mesh used (reason) | install / start the native kernel |
| `XCH_IFC_SCHEMA_UNSUPPORTED` / `XCH_IFC_GEOMETRY_FAILED` | fail / warn | schema not read / products without geometry | — |
| `XCH_PDF_FONT_NOT_EMBEDDABLE` | warn | OS/2 `fsType` restricted: text drawn as outlines | use another font |
| `XCH_PDFA_NONCONFORMANT` | fail | PDF/A self-check failed (rule ids) | — |
| `XCH_PLOT_DEVICE_UNAVAILABLE` / `XCH_PLOT_CLIPPED` | fail / warn | printer missing / sheet exceeds printable area | — |
| `XCH_CTB_UNREADABLE` | fail | plot style file not parsed | — |
| `XCH_UNDERLAY_PDF_UNREADABLE` | fail | PDF not opened / page out of range | — |

Existing codes of aerospace 04 (`XCH_GVP_*`, `XCH_SELFCHECK_RED`, `XCH_WRITER_UNAVAILABLE`, `XCH_CONVERTER_MISSING`, …) and
`KRN_STEP_*` keep their meaning; none is redefined here.

## 8. Performance and robustness budgets (spec budgets; machine profile `ref-win11`, confirmed on `office-min` by pack 03)

| Operation | Budget |
| --------- | ------ |
| Open `sample_AC1032.dwg` (1,081,979 bytes) to first frame | ≤ 2 s |
| Open a 20 MB DWG | ≤ 10 s, progress reported, memory ≤ 2 GB in the sidecar |
| Save AC1032 of the same | ≤ open time |
| `export_pdf` of an A1 sheet with 50,000 primitives | ≤ 3 s |
| Mutated-file fuzz run (1,000 mutants of the corpus) | 0 crashes of the app; sidecar may exit with a code; ≤ 30 s per file (`XCH_DRW_TIMEOUT`) |

## 9. Test strategy

| Level | What | VC |
| ----- | ---- | -- |
| unit (`tests/unit/exchange/`) | DIM → document mapping per class, fidelity sum invariant, MTEXT parser, PAT / LIN / CTB parsers, PDF unit conversion, codes table complete | 104–113, 119, 140 |
| native (`solver/crates/llull-drawing` tests, `cargo test`) | read/write per version on the corpus, fuzz targets (`cargo fuzz`) | 101, 117, 121 |
| quality gate (`quality/` + `server/tests/quality/drawing.gate.ts`, new) | corpus files → open → census vs oracle (ezdxf for DXF; LibreDWG `dwgread -O JSON` and ACadSharp for DWG, test-only) → export → re-read → metrics; `knownIssues` ratchet | 101–117, 120 |
| electron (pack 06 harness) | File › Open / Save As / Export PDF / Print | 134, 138 |
| review (`validation/records/`) | DWG TrueView opening; licence inventory; SHX rendering | 118, 128, 137 |

## 10. Delivery plan

| Milestone | Content | Depends on |
| --------- | ------- | ---------- |
| M0 | corpus entries + drawing gate skeleton running on today's `import_dxf` (records today's baselines as `knownIssues`) | — |
| M1 | `llull-drawing` sidecar on acadrust, DIM, `open_drawing` / `export_drawing`, fidelity report, version matrix | 05 INS (sidecar bundling) |
| M1-gate | **codec decision**: acadrust kept if VC-101…103, 115…117 pass; else owner decides ODA Drawings SDK (TECHNICAL §11 Q1) | M1 |
| M2 | drafting model to L3 (blocks/attributes, dimensions/styles, hatches, MTEXT, linetypes, lineweights, layouts) | `add-entity-kind` work, 02 UXD (editing gestures) |
| M3 | STEP exact default on CLI, face colours, editability tests | 01 KRN native kernel shipped (05 INS) |
| M4 | pass-through, xrefs, SHX, round-trip gate | M1 |
| M5 | `llull-pdf`, `export_pdf`, PDF/A, print, CTB | 06 E2E for print tests |
| M6 | IFC reference import, PDF underlay | licence decisions Q3, Q4 |

## 11. Open questions and proposed decisions (owner / counsel)

1. **Q1 DWG codec (owner).** Proposed: acadrust (MPL-2.0) as primary, qualified by the corpus at M1-gate; ODA Drawings SDK
   Commercial (USD 3,000 then 2,250 / year, 100-seat distribution limit) or Sustaining (7,500 then 4,500 / year, unlimited)
   as contingency [R4]. Decision needed only if the gate fails.
2. **Q2 llull's licence (owner + counsel).** No licence file exists. MPL-2.0 (acadrust), LGPL-3.0 (IfcOpenShell), BSD (PDFium),
   MIT / Apache (krilla, ACadSharp) are usable in a closed product with obligations; GPL (LibreDWG, libdxfrw, veraPDF) only as
   separately installed or test-only tools. Counsel to confirm: (a) MPL notices and source offer for modified files; (b)
   whether acadrust's derivation from the ODA specification creates obligations toward the ODA; (c) whether calling a
   user-installed GPL converter as a separate process is acceptable for a closed product (GPL FAQ criterion "mechanism and
   semantics of the communication" [R39], grade B); (d) the trademark use of "DWG" in UI and marketing [R7].
3. **Q3 IFC engine (owner).** IfcOpenShell (LGPL-3.0, OCCT-based, separate executable) vs web-ifc (MPL-2.0). Proposed:
   IfcOpenShell for exact geometry through the same OCCT; counsel to confirm LGPL-3 replaceability inside the Electron bundle.
4. **Q4 PDF underlay engine.** PDFium binary (BSD, mature) vs hayro (pure Rust). Proposed: PDFium.
5. **Q5 Parasolid.** No open reader found in this research; ODA lists MCAD formats in its SDK catalogue [R4]. Proposed: defer
   to V2, decide on supplier demand from the pilot (01 PIL).
6. **Q6 Substitute font and hatch-pattern sets** to ship (licence must allow redistribution): to be chosen and recorded.

## 12. References

See [`validation/sources.md`](validation/sources.md).
