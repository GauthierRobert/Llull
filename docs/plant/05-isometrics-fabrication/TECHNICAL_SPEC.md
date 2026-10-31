# Gap 05 ISO — Piping isometrics and fabrication: technical specification

Companion of [FUNCTIONAL_SPEC.md](FUNCTIONAL_SPEC.md). Laws: `.claude/rules/architecture.md` (L1–L10). Validation:
[validation/README.md](validation/README.md). Agent-first rules: [`AGENT_FIRST.md`](../../aerospace/AGENT_FIRST.md).

## 1. Current state in llull (before this gap)

What exists and is reused:

| Area | Where | What it gives this gap | Limit |
| ---- | ----- | ---------------------- | ----- |
| Pipe model | `packages/core/src/model/building.ts` `PipeElement` (`category: 'pipe'`, `points: Vec3[]`, `diameter`, `service`, `material`, `line?`, `dn?`, `from?`, `to?`) | line number, DN, route centreline | a polyline with "bends at every interior point"; no fittings, flanges, welds, spec, SKEY, item code; z relative to the level |
| Pipe command | `packages/domain-aec/src/industrial/equipment/equipment.ts` `add_pipe_run` | creates the line; DN → OD from `industrial/piping/pipeSizes.ts` (EN 10220 / B36.10, DN15–400) | no spec; no branch / tee; refuses duplicate routes |
| Supports | `industrial/piping/pipeSupports.ts` … `add_pipe_support`, `PipeSupportElement` (shoe / guide / anchor / hanger, `at` point, mark PS) | supports to show on isos and write as PCF `SUPPORT` | — |
| Piping checks | `check_pipe_supports`, `pipe_hydraulics` | — | no fabrication checks |
| Line list / takeoff | `building/quantities/takeoff.ts` `building_schedule` (kind `pipe`), takeoff `pipe length by service and diameter` | pipe length cross-check (VC-ISO-08) | no fittings / bolts |
| Plan / elevation drawings | `building/drawings/planDrawing.ts`, `planIndustrial.ts` (pipes on the plan with service), `planSupports.ts` (support symbols), `elevation.ts` (`export_elevation_sheet`, hidden-line, sections), `sheet.ts` (`export_plan_sheet`) | base of the piping GA (FR-ISO-15) | single-line pipes, no line label / elevations / flow arrows |
| Part sheets | `packages/core/src/model/sheet.ts` (`DrawingsModel`, `DrawingSheet`, `DrawingView` with `direction: 'iso'`), `commands/drawings/*` (`create_sheet`, `create_drawing_view`, `add_section_view`, `export_sheet_svg`) | title block, paper sizes, ISO 216 frames | the `iso` view is a hidden-line projection of solids, to scale; no piping symbols, no not-to-scale layout |
| Iso frame | `packages/core/src/geometry/viewDirections.ts` `AXES.iso` (right = (1,1,0)/√2, viewer at (+X, −Y, +Z)) | true isometric: +X → −30°, +Y (north) → +30°, +Z → 90°, scale √(2/3) (derived in `validation/data/pcf_reference_parse.py`) | — |
| SVG painter | `packages/core/src/geometry/drawingSvg.ts` (`DrawingPainter`, `svgText`, `paperDimension`) | iso sheet painting | — |
| DXF writer | `packages/core/src/lib/dxfWriter.ts`, `domain-aec/src/building/exchange/dxfWriter.ts` (`export_building_dxf`) | iso DXF | — |
| Fabrication export | `industrial/fabrication/ncExport.ts` `export_nc_files` (DSTV NC1, one file per distinct piece, `data.files[]` with `content`, grouped quantities) | pattern for `export_pcf` (files[], determinism, `confirmExportControlled` + `exportRefusal`) | steel only |
| Clash | `industrial/clash/clash.ts` `check_clashes` | — | — |
| CLI file I/O | `server/src/cli/saveFiles.ts` (`--save` writes `data.files[]`, text keys incl. `content`, `svg`, `dxf`), `server/src/cli/exchange.ts` `FILE_PARAMS` (`file=` → content param) | PCF / SVG out; PCF in needs one `FILE_PARAMS` row (`import_pcf: { key: 'text', encoding: 'utf8' }`) | — |
| MCP toolset | `packages/mcp/src/toolsets.ts`: toolset `piping` = `PIPING_TOOLS` filtered from the `building` plugin | this gap's commands join `piping` | the getter must also take the new plugin's commands |
| Errors | `CommandResult.error` `{ code, ids, paths, remediation }`, `codedRejection`, `report` in `packages/core/src/commands/noop.ts` (AF-11 / AF-14 plumbing) | stable `ISO_*` codes | — |

What does **not** exist: any PCF code, weld / spool / cut-piece / bolt-set concept, piping BOM, isometric symbol
library, not-to-scale layout, pipe annotation on plans, a fabrication check. `grep -ri "pcf\|spool\|isogen" packages`
finds no piping-fabrication code.

Upstream gaps this one consumes: `01-piping-specs-catalog` (PSC — spec, item codes, SKEYs, catalogue dimensions,
bolt tables) and `02-spec-driven-routing` (RTE — components with ports, fittings, branches, flanges, connectivity,
slope). ISO is designed to run on three inputs: an RTE network, a legacy `PipeElement` (fittings derived), or an
imported PCF.

## 2. Target architecture

```
src/app/plugins.ts  installDefaultPlugins() → … pipingFabricationPlugin
packages/domain-aec/src/plant/fabrication/        plugin `piping-fabrication`, toolset `piping`
  model.ts              FabricationModel (document extension): welds, spools, iso definitions, rules, issues
  network.ts            PipingNetwork read port: from RTE components | legacy PipeElement | imported PCF lines
  legacyNetwork.ts      PipeElement -> network with derived LR elbows (PSC bend rule), flagged derived
  pcf/pcfLexer.ts       line / record tokenizer, syntax checks (TAB, 1024, header) -> ISO_PCF_* codes
  pcf/pcfRead.ts        records -> PcfLine (header, pipeline attrs, components, materials, extras)
  pcf/pcfWrite.ts       PcfLine -> canonical text (deterministic numbers, ordering)
  pcf/pcfMap.ts         PcfLine <-> PipingNetwork (component type / SKEY / end types)
  welds.ts              joint detection, weld kinds, numbering (persistent, highest + 1)
  spools.ts             union-find over shop joints, limits (box, length, weight, count), names
  cutList.ts            pieces, gap / allowance, stock-length nesting (V1)
  bom.ts                line / spool / sheet BOM, bolting + gaskets per flanged joint
  iso/isoGraph.ts       network -> drawing graph (runs, nodes, branches) in plant axes
  iso/isoLayout.ts      not-to-scale layout: run lengths, collision, label placement, skew boxes
  iso/isoDimensions.ts  string / overall dims, elevations, coordinates, slope
  iso/isoSymbols.ts     SKEY -> 2D symbol strokes (ISO 6412-2 style, family + end type)
  iso/isoSheets.ts      sheet split, continuation marks, stable assignment
  iso/isoTables.ts      BOM / cut / weld / spool tables
  iso/isoRender.ts      DrawingPainter (SVG) + DxfWriter output
  ga/pipingGa.ts        annotations on top of building plan / elevation drawings
  check.ts              check_isometric rules
  codes.ts              ISO_* codes + remediation strings
  *Command.ts, catalog.ts, plugin.ts
```

Laws:

- **L1/L4/L5.** Every capability is a `defineCommand` in the plugin; the UI and MCP call the same commands; the CLI
  reaches them by name. Isometric sheets are generated by export commands (read-only) from document data; the
  persistent parts (weld numbers, spool names, iso split assignment, fabrication rules, issue records) live in the
  plugin's document slice and change only through commands.
- **L2.** Pure TypeScript, no DOM / fetch. File text in and out goes through params and `data.files[]`; the CLI host
  reads / writes files (`file=`, `--save`).
- **L3.** Commands return new documents; `is pure` test per mutating command.
- **L7.** Isos are 2D presentation derived from the 3D model; no second piping model. An imported PCF becomes a
  network through RTE commands (composition via `ctx.registry` / `execute`, L10), or, before RTE lands, a
  `pcfLines` record set in the fabrication slice that every query reads through the same `PipingNetwork` port.
- **L8.** Mutating commands append feature steps; weld numbers are step-scoped data, so replay reproduces them.
- **L9.** No kernel needed: the network is centrelines, ports and catalogue dimensions. `requiresKernel` is not set.
- **L10.** The plugin imports only core public API and reads the PSC / RTE data through their exported model types
  and read helpers (a shared `plant/` model module), never their command internals.

Decision needed (OQ-ISO-04): whether PSC / RTE / ISO are one `plant` plugin with several catalogs or separate
plugins. This spec assumes a separate `piping-fabrication` plugin depending on a shared `plant/model` module, so
ISO can ship before RTE using the legacy and PCF inputs.

### 2.1 Technical requirements

| Id | Pri | Requirement | FR | AF | VC |
| -- | --- | ----------- | -- | -- | -- |
| TR-ISO-01 | MUST | PCF lexer / reader for the §6.1 subset with unit scaling, `extra` preservation and coded syntax refusals with line paths (§5.1) | FR-ISO-01, 17 | AF-04, AF-11 | VC-ISO-01, 02 |
| TR-ISO-02 | MUST | Canonical PCF writer, one file per line, byte-deterministic, equal to the reference writer on the fixture (§5.2) | FR-ISO-02, 03, 18 | AF-12, AF-13 | VC-ISO-03, 17 |
| TR-ISO-03 | MUST | `PipingNetwork` read port over RTE components, legacy `PipeElement` (derived fittings, flagged) and imported PCF lines (§3, §5.3) | FR-ISO-03, 04 | AF-32 | VC-ISO-04 |
| TR-ISO-04 | MUST | Connectivity graph with 0.1 mm node keys, 1 mm disconnection guard, flow order (§5.4) | FR-ISO-06, 16 | AF-20 | VC-ISO-05, 16 |
| TR-ISO-05 | MUST | Spool union-find over shop joints, limits from user rules with source, deterministic `autoBreak` (§5.5) | FR-ISO-05 | AF-30, AF-31 | VC-ISO-06 |
| TR-ISO-06 | MUST | Weld detection and persistent numbering: highest + 1, orphaned numbers never reused, explicit renumber (§5.4) | FR-ISO-06, 07 | AF-13 | VC-ISO-05, 14 |
| TR-ISO-07 | MUST | Cut list with explicit gap / allowance (no silent default), short-piece check (§5.6) | FR-ISO-08 | AF-31, AF-35 | VC-ISO-07 |
| TR-ISO-08 | MUST | BOM per line / spool / sheet with bolting and gaskets from PSC tables, `unverified` propagation, sum identities (§5.7) | FR-ISO-09 | AF-10, AF-32 | VC-ISO-08, 09 |
| TR-ISO-09 | MUST | True isometric projection identical to `viewDirections.ts` iso frame; north arrow up-right / up-left (§5.8) | FR-ISO-10 | AF-21 | VC-ISO-10 |
| TR-ISO-10 | MUST | Not-to-scale layout with collision handling, symbols by SKEY family, centreline string dimensions, elevations and coordinates; every label listed in `data` with its 3D value (§5.8, §5.9) | FR-ISO-11, 12 | AF-21, AF-22 | VC-ISO-11 |
| TR-ISO-11 | MUST | Slope detection and annotation (ratio / percent / degrees, fall arrow) (§5.9) | FR-ISO-13 | AF-21 | VC-ISO-12 |
| TR-ISO-12 | SHOULD | Sheet split at welds / flanges with continuation marks and stored sheet assignment (§5.10) | FR-ISO-14 | AF-13 | VC-ISO-13 |
| TR-ISO-13 | SHOULD | Piping GA annotation layer on the existing plan / elevation drawings (§5.11) | FR-ISO-15 | AF-22 | VC-ISO-15 |
| TR-ISO-14 | MUST | `check_isometric` rule table with stable codes and remediation (§5.12, §7) | FR-ISO-16, 17 | AF-11, AF-20, AF-30 | VC-ISO-02, 16 |
| TR-ISO-15 | MUST | Determinism of every output (sorted iteration, fixed number formats, no clock) | FR-ISO-18 | AF-13 | VC-ISO-17 |
| TR-ISO-16 | SHOULD | Performance budgets of §8 | FR-ISO-14 | AF-40 | VC-ISO-18 |
| TR-ISO-17 | MUST | `issue_isometric` human gate (09 PLM signature), `reviewRequired: true` on every unissued iso, "NOT FOR CONSTRUCTION" stamp | FR-ISO-19 | AF-33, AF-34, AF-34a | VC-ISO-19 |

## 3. Data model

```ts
/** Read port: what every ISO algorithm consumes, whatever the source. Coordinates are world mm (z absolute). */
export interface PipingNetwork {
  readonly lineId: string;                       // line number, e.g. "L-101"
  readonly attributes: LineAttributes;           // spec, insulation, painting, revision, area, project, slope rule
  readonly components: readonly NetworkComponent[]; // in flow order from the line start
  readonly source: 'route' | 'legacy' | 'pcf';
  readonly warnings: readonly IsoIssue[];        // e.g. ISO_LEGACY_FITTINGS_DERIVED
}

export type PcfComponentType =
  | 'PIPE' | 'ELBOW' | 'BEND' | 'TEE' | 'OLET' | 'REDUCER-CONCENTRIC' | 'REDUCER-ECCENTRIC' | 'FLANGE' | 'FLANGE-BLIND'
  | 'GASKET' | 'BOLT' | 'VALVE' | 'CAP' | 'WELD' | 'SUPPORT' | 'INSTRUMENT';

export type EndType = 'BW' | 'SW' | 'FL' | 'CP' | 'SC' | 'PL';   // validation/data/pcf_keywords.json endConnectionCodes

export interface NetworkPoint { readonly xyz: Vec3; readonly boreMm: number; readonly endType?: EndType }

export interface NetworkComponent {
  readonly id: string;                           // stable llull id (route component id or `pcf:<line>:<n>`)
  readonly type: PcfComponentType;
  readonly ends: readonly NetworkPoint[];        // 0..2 (SUPPORT: 0)
  readonly centre?: Vec3;
  readonly branch?: NetworkPoint;                // BRANCH1-POINT
  readonly coords?: Vec3;                        // SUPPORT CO-ORDS
  readonly skey?: string;                        // 4 chars; absent only for PIPE
  readonly itemCode?: string;
  readonly category?: 'fabrication' | 'erection' | 'offshore';
  readonly weldKind?: 'shop' | 'site' | 'field_fit';  // WELD only (WW / WS / WF)
  readonly weight?: number;                      // as written, in the file's UNITS-WEIGHT
  readonly derived?: true;                       // legacy-derived fitting
  readonly unverified?: true;                    // catalogue row not verified (AF-32, from PSC)
  readonly extra?: Readonly<Record<string, string>>; // unknown PCF attributes, written back verbatim
}

/**
 * Document slice: `CadDocument.fabrication?: FabricationModel`, type in a new core file `packages/core/src/model/fabrication.ts`
 * (same pattern as `fasteners?` / `sheetMetal?` in model/types.ts); validated by the plugin's DocumentExtension; absent until the
 * first fabrication command.
 */
export interface FabricationModel {
  readonly version: 1;
  readonly rules?: FabricationRules;
  readonly welds: Readonly<Record<string, WeldRecord>>;        // keyed by joint key (line + rounded xyz + component ids)
  readonly highestWeldNumber: Readonly<Record<string, number>>; // per line (PCF HIGHEST-WELD-NUMBER)
  readonly spools: Readonly<Record<string, SpoolRecord>>;
  readonly isometrics: Readonly<Record<string, IsoDefinition>>; // per line
  readonly pcfLines: Readonly<Record<string, PcfLine>>;        // imported lines not (yet) converted to RTE components
  readonly issues: Readonly<Record<string, IsoIssueRecord>>;    // human-gated issue stamps
}

export interface FabricationRules {
  readonly weldGapMm?: Quantity;                 // { value, source, defaulted? } (AF-31)
  readonly fieldFitAllowanceMm?: Quantity;
  readonly maxSpool?: { readonly lengthMm?: number; readonly boxMm?: Vec3; readonly weightKg?: number; readonly pieces?: number; readonly source: string };
  readonly minCutPieceMm?: Quantity;
  readonly weldPrefix?: { readonly fabrication?: string; readonly erection?: string };   // PCF WELD-PREFIX-*
  readonly spoolPrefix?: string;                 // PCF SPOOL-PREFIX
}

export interface WeldRecord {
  readonly number: string;                       // "W7" (prefix + n)
  readonly n: number;
  readonly lineId: string;
  readonly kind: 'shop' | 'site' | 'field_fit';
  readonly joint: { readonly xyz: Vec3; readonly componentIds: readonly string[]; readonly boreMm: number; readonly endType: EndType };
  readonly spoolId?: string;
  readonly status: 'active' | 'orphaned';        // joint disappeared after an edit: kept, never reused
}

export interface SpoolRecord { readonly name: string; readonly lineId: string; readonly componentIds: readonly string[] }

export interface IsoDefinition {
  readonly lineId: string;
  readonly style: 'check' | 'final' | 'spool' | 'stress';
  readonly paper: PaperSize;                     // from @core/model/sheet
  readonly maxPipePiecesPerSheet?: number;
  readonly northArrow: 'up_right' | 'up_left';
  readonly sheetAssignment: Readonly<Record<string, number>>;   // componentId -> sheet index (stability, FR-ISO-14)
}
```

Document version: one optional field on `CadDocument` (a type-only core change, like `sheetMetal?` for 07 FTR), validated
by the plugin's `DocumentExtension.validate`; absent = no fabrication data, so existing files need no migration and the
document version is unchanged. Units: the slice stores mm; command params take document units
for coordinates and state units for every length param (AF-04).

## 4. Commands (toolset `piping`)

All names snake_case; every command carries `@affects / @invariant / @failure` tags (C2). "Query" commands have
`annotations: { readOnly: true, idempotent: true }`. Export commands take `confirmExportControlled` and call
`exportRefusal` like `export_nc_files`.

| Name | Kind | Params (sketch) | data | Failure codes |
| ---- | ---- | --------------- | ---- | ------------- |
| `import_pcf` | mutating (query when `preview`) | `text` (PCF content; CLI `file=`), `preview?`, `lineIdOverride?`, `levelId?`, `as: 'route' \| 'pcf_line'` (default `route` when RTE is installed) | `{ lineId, units, componentCount, countsByType, totalPipeLengthMm, pipeLengthsMm[], bom[], unknownRecords[], warnings[] }` | `ISO_PCF_HEADER`, `ISO_PCF_TAB`, `ISO_PCF_LINE_TOO_LONG`, `ISO_PCF_UNITS_MISSING`, `ISO_PCF_RECORD_INVALID`, `ISO_PCF_LINE_EXISTS` |
| `export_pcf` | query (export) | `lineIds?` (default all), `units: 'mm' \| 'inch'`, `includeMaterials?` (true), `strictSkey?` (false), `includeSupports?` (M5), `confirmExportControlled` | `{ files: [{ name: "<line>.pcf", content, sha256, componentCount }], count }` | `ISO_LINE_NOT_FOUND`, `ISO_NO_PIPING`, `ISO_SKEY_MISSING` (refuses unless `allowMissingSkey`) |
| `add_field_weld` | mutating | `lineId`, `at` (point on a pipe, doc units), `type: 'site' \| 'field_fit'` | `{ weldId, splitPipeIds }` | `ISO_WELD_NOT_ON_PIPE`, `ISO_WELD_TOO_CLOSE` (< min cut piece from a joint) |
| `set_weld_type` | mutating | `weldId \| at`, `type: 'shop' \| 'site' \| 'field_fit'` | `{ weldId, previous }` | `ISO_WELD_NOT_FOUND` |
| `number_welds` | mutating | `lineId \| lineIds`, `renumber?: false` (true = explicit full renumber, reported) | `{ assigned[], kept[], orphaned[], highest }` | `ISO_LINE_NOT_FOUND` |
| `weld_list` | query | `lineId`, `spoolId?` | `{ welds: [{ number, kind, at, componentIds, boreMm, endType, spool }] }` | `ISO_LINE_NOT_FOUND`, `ISO_WELDS_UNNUMBERED` (warning) |
| `set_fabrication_rules` | mutating | `weldGapMm?`, `fieldFitAllowanceMm?`, `maxSpoolLengthMm?`, `maxSpoolWidthMm?`, `maxSpoolHeightMm?`, `maxSpoolWeightKg?`, `maxSpoolPieces?`, `minCutPieceMm?`, prefixes, `source` (required string) | `{ rules }` | `ISO_PARAM_INVALID` |
| `split_spools` | mutating | `lineId`, `breakAt: ('field_welds' \| 'flanged_joints' \| 'line_ends')[]`, `autoBreak?: false` (insert field welds to meet limits) | `{ spools: [{ name, componentIds, lengthMm, boxMm, weightKg }], insertedWelds[] }` | `ISO_SPOOL_TOO_LARGE` (no autoBreak), `ISO_LINE_NOT_FOUND` |
| `spool_list` | query | `lineId?` | `{ spools[] }` | — |
| `cut_list` | query | `lineId`, `spoolId?`, `weldGapMm?`, `fieldFitAllowanceMm?` (else rules; else refused) | `{ pieces: [{ piece, spool, componentId, boreMm, itemCode, centrelineLengthMm, cutLengthMm, adjustments[] }], totalMm, provenance }` | `ISO_GAP_UNDEFINED`, `ISO_CUT_LENGTH_SHORT` |
| `piping_bom` | query | `scope: 'line' \| 'spool' \| 'sheet' \| 'document'`, `lineId?`, `spoolId?`, `sheet?`, `includeBolting?`, `matingFlanges?: 'assume_in_scope' \| 'this_side_only'` | `{ rows: [{ itemCode, type, description, quantity, unit, unverified? }], bolting: { joints, gaskets, studBolts, diameter }, provenance }` | `ISO_ITEM_CODE_MISSING` (warning row) |
| `define_isometric` | mutating | `lineId`, `style`, `paper`, `maxPipePiecesPerSheet?`, `splitAt: 'weld' \| 'flange'`, `northArrow?` | `{ isoId }` | `ISO_LINE_NOT_FOUND` |
| `export_isometric` | query (export) | `lineId`, `style?`, `paper?`, `formats: ('svg' \| 'dxf')[]`, `tables?`, `spoolId?` (spool iso), `confirmExportControlled` | `{ files[], sheets: [{ index, svg?, dxf?, sha256, componentIds, continuation: { previous?, next? } }], projection: { axes }, northArrow, dimensions[], annotations[], dimensionMismatches, tables, reviewRequired: true }` | `ISO_LINE_NOT_FOUND`, `ISO_DISCONNECTED`, `ISO_SHEET_OVERFLOW` (warning) |
| `export_piping_ga` | query (export) | `view: 'plan' \| 'section'`, `levelId?`, `direction?`, `cutAt?`, `paper`, `scale`, `doubleLineFromDn?`, `annotate[]`, `confirmExportControlled` | `{ files[], labels[], arrows[] }` | `ISO_NO_PIPING`, building plan codes |
| `check_isometric` | query (check) | `lineId?` (default all lines) | `{ ok, issues: [{ code, severity, ids, paths, remediation }], counts }` | — (issues, not refusals) |
| `issue_isometric` | mutating (human gate) | `lineId`, `revision`, `purpose: 'for_construction' \| 'for_fabrication'`, `signatureId` | `{ issueId }` | `ISO_HUMAN_GATE`, `ISO_CHECK_FAILED` |

Composition (L10): `import_pcf` with `as: 'route'` calls the RTE commands (`add_pipe_run` with spec, branch, flange,
valve placement) through `execute`, so the resulting document is identical to one routed by hand; with `as:
'pcf_line'` it stores the parsed line in `pcfLines` (read-only geometry, rendered as centrelines).

Example tag block:

```ts
/**
 * @affects none; data = { files: [{ name, content, sha256, componentCount }], count }
 * @invariant one file per line; components in flow order; numbers printed with 1 decimal; no TAB; lines <= 1024 chars
 * @failure unknown line / no piping / missing SKEY (with strictSkey) -> coded no-op, affected:[]
 */
export const exportPcf = defineCommand({ name: 'export_pcf', annotations: { readOnly: true, idempotent: true }, … });
```

## 5. Algorithms

### 5.1 PCF reading (TR-ISO-01)

1. Lexer: split on `\n` (accept `\r\n`); reject any `\t` (`ISO_PCF_TAB`, path `line N`) and any line > 1024
   characters (`ISO_PCF_LINE_TOO_LONG`) [S7]. First non-blank line must start with `ISOGEN-FILES`
   (`ISO_PCF_HEADER`) [S4][S5].
2. Records: a line starting at column 1 opens a record (header keyword, `PIPELINE-REFERENCE`, a component type,
   `MATERIALS`, or `ITEM-CODE` inside MATERIALS); indented lines are attributes of the open record [S3][S4][S7].
3. Points: `END-POINT x y z bore [endType]`, `BRANCH1-POINT x y z bore [endType]`, `CENTRE-POINT x y z`, `CO-ORDS x y z`.
   Missing numbers → `ISO_PCF_RECORD_INVALID` with the line. Coordinates are scaled by UNITS-CO-ORDS (MM 1, INCH 25.4),
   bores by UNITS-BORE; a missing unit → `ISO_PCF_UNITS_MISSING` (never assumed, AF-04).
4. Unknown component types and attributes are preserved in `extra` and listed in `data.unknownRecords` (FR-ISO-01).
5. Pipe length = Σ |E₂ − E₁| over PIPE; counts per type; BOM by `ITEM-CODE` joined to MATERIALS `DESCRIPTION`.

### 5.2 PCF writing (TR-ISO-02)

Canonical form, identical to `validation/data/pcf_reference_parse.py` `write()`:

```
<header lines in fixed order: ISOGEN-FILES, UNITS-BORE, UNITS-CO-ORDS, UNITS-WEIGHT, UNITS-BOLT-DIA, UNITS-BOLT-LENGTH>
PIPELINE-REFERENCE <line>
    <pipeline attributes, fixed order>
<TYPE>
    COMPONENT-IDENTIFIER <n>
    END-POINT <x.1f> <y.1f> <z.1f> <bore, trailing zeros stripped> <endType>
    CENTRE-POINT / BRANCH1-POINT / CO-ORDS …
    SKEY / ITEM-CODE / other attributes in stored order; flag attributes (ERECTION-ITEM) without value
MATERIALS
ITEM-CODE <code>
    DESCRIPTION <text>
```

Component order: flow order (depth-first from the line start, main run before BRANCH1, §5.4); `COMPONENT-IDENTIFIER`
is the 1-based position. Numbers: fixed 1 decimal (0.1 mm), `-0.0` printed `0.0`. No TAB; a description longer than
the 1024-char limit is truncated with a warning. Determinism (AF-13): same network → same bytes.

### 5.3 Legacy lines (TR-ISO-03)

For a `PipeElement` without RTE components: at each interior point with turn angle θ, place an elbow with
centre-to-end `A = R·tan(θ/2)` where `R` is the spec's bend radius (LR 90: A = 1.5 × NPS × 25.4 mm at θ = 90°, B16.9
[S26]); trim the adjacent pipes by A; θ not in the spec's elbow set (90°, 45°) → derived `BEND` with
`ISO_LEGACY_FITTINGS_DERIVED` warning; adjacent elbows overlapping (A₁ + A₂ > segment) → `ISO_SEGMENT_TOO_SHORT`.
Line ends become open ends (`ISO_OPEN_END` warning) unless the line's `from` / `to` names equipment.

### 5.4 Connectivity, welds and numbering (TR-ISO-04, TR-ISO-06)

- Nodes: connection points (END-POINT, BRANCH1-POINT) keyed by coordinates rounded to 0.1 mm (tolerance 0.05 mm,
  `ISO_DISCONNECTED` for points closer than 1 mm that do not coincide).
- Joint classification: a node with a WELD record → that weld's kind (WW shop, WS site, WF field-fit [S6]); else ≥ 2
  components all `BW` or `SW` → shop weld; one component → terminal (FL = flanged end, else open end); FL–FL pair →
  bolted joint (gasket + bolt set, §5.7).
- Flow order: depth-first from the line start (component flagged start by RTE, else the first PCF record), at a tee
  continue on END-POINT 2 before BRANCH1; welds are numbered in the order their node is first reached.
- Persistence: `number_welds` stores `WeldRecord`s. An existing joint (same component ids, same rounded position, or
  same component ids after a move) keeps its number; new joints get `highest + 1` [S3][S7]; vanished joints become
  `orphaned` and their numbers are never reused (NDE traceability). `renumber: true` is explicit and reported.
- Prefixes: `weldPrefix.fabrication` for shop, `.erection` for site / field-fit (PCF WELD-PREFIX-FABRICATION /
  -ERECTION [S3]).

Fixture result (VC-ISO-05): 13 welds W1..W13, W2 = site weld at (2500, 0, 3000), branch welds W12, W13 last.

### 5.5 Spools (TR-ISO-05)

Union-find over components joined by shop welds; site / field-fit welds, bolted joints and terminals separate spools
[S6][S7][S11]. Spools are named `<spoolPrefix|line>-SP<nn>` in flow order of their first component. Limits from
`FabricationRules.maxSpool`:

- length = longest centreline path in the spool; box = axis-aligned extent of all connection points + OD/2, compared
  after sorting dimensions (the spool may be turned on the truck); weight = Σ component weights (PSC unit weights ×
  lengths); pieces = PIPE count.
- Violation → `ISO_SPOOL_TOO_LARGE` / `ISO_SPOOL_TOO_HEAVY` with the spool id. With `autoBreak`, insert a site weld on
  the pipe that splits the spool closest to the middle of its longest path while keeping both cut pieces ≥
  `minCutPieceMm`; repeat; report inserted welds (deterministic).

### 5.6 Cut list (TR-ISO-07)

For each PIPE piece: `L = |E₂ − E₁|` (centreline between the joint points, which already exclude fitting take-outs);
`cut = L − Σ_ends(gap/2 if the end is a weld) + Σ_ends(allowance if the end is a WF weld)` [S23]. Gap and allowance
come from params, else from `FabricationRules` (each with `source`), else `ISO_GAP_UNDEFINED` (no silent default,
AF-31). `cut < minCutPieceMm` → `ISO_CUT_LENGTH_SHORT`. Fixture: gap 3 → every piece −3 mm (VC-ISO-07). V1 adds
stock-length nesting (first-fit decreasing on 6 m / 12 m random lengths given by the user).

### 5.7 BOM and bolting (TR-ISO-08)

- Rows grouped by item code: PIPE in m (Σ L / 1000, not cut lengths, so BOM = MTO quantity), others by count;
  descriptions from PSC (or PCF MATERIALS on import).
- Flanged joints: each FL–FL pair, or each FL terminal when `matingFlanges = 'assume_in_scope'`, adds 1 gasket and 1
  bolt set; bolts per set and diameter from the PSC flange table (class 150 NPS 4: 8 × 5/8 in [S27]); stud length from
  PSC (V1). Bolts and gaskets are erection items [S14].
- Scopes: line = all; spool = members; sheet = components assigned to the sheet; the spool sums and sheet sums equal
  the line (identity tested, VC-ISO-08).
- Every row inherits `unverified` from its catalogue row (AF-32) and the result names the catalogue (AF-35).

### 5.8 Isometric projection and layout (TR-ISO-09, TR-ISO-10)

- Projection: plant axes map to sheet directions east = (cos −30°, sin −30°), north = (cos 30°, sin 30°), up = (0, 1)
  — identical to `viewDirections.ts AXES.iso` (scale dropped because the drawing is not to scale). `northArrow:
  'up_left'` rotates plant directions by +90° about +Z before projection, so north projects at 150° (up-left) and east
  at +30°; the arrow is always drawn along the projected north. Inter-axis angle 120°, true-iso scale √(2/3) is reported for reference
  [S18][S19].
- Graph: maximal straight runs between nodes (elbows, tees, ends, direction changes); each run has a direction class
  (±E, ±N, ±U or skew).
- Not-to-scale lengths: drawn length ℓ = clamp(k · log(1 + L/L₀), ℓmin, ℓmax) with ℓmin fitting the run's symbols and
  dimension text; k chosen so the line fits the drawing area (bisection), else split (§5.10). Lengths are monotone in
  L, so longer pipes still look longer.
- Collision: a run whose drawn segment crosses another non-adjacent run is lengthened / its successors offset by the
  minimum shift along the run direction (deterministic, at most N passes); remaining crossings are drawn with a gap
  break on the farther run (depth = dot with the viewer direction).
- Skew runs (V1): a run not parallel to a plant axis is drawn at its projected angle inside a squaring-in triangle
  (horizontal skew: hatched triangle in the horizontal plane; vertical: in the vertical plane) with the two leg
  dimensions and the angle; a 45° horizontal offset is drawn at 22.5° from the axis [S20].
- Symbols: SKEY family → stroke template (elbow arc, tee, flange double bar, weld dot shop / cross field, reducer
  trapezoid, valve bow-tie, support mark), end type → end marks; templates scaled to the pipe line weight, not to the
  bore.

### 5.9 Dimensions, elevations, slope (TR-ISO-10, TR-ISO-11)

- String dimensions per straight run between connection points along the run (flange face, weld point, fitting
  centre), plus an overall dimension per run; each label = the 3D distance rounded to the display precision; the
  string must close to the overall (`ISO_DIMENSION_MISMATCH` otherwise — impossible by construction, kept as a guard).
  Fixture east run: 76 + 2424 + 2348 + 152 = 5000 (VC-ISO-11).
- Elevations `EL +zzzz` (centreline, mm, sign shown) at each horizontal run and at line ends; coordinates
  `E xxxx N yyyy` at line ends, branches and continuation points [S20].
- Slope: for a run with horizontal length h > 0 and drop d: ratio `1:round(h/d)` when h/d is within 0.5 % of an
  integer, else the percent; percent = 100 d / h; angle = atan(d / h); arrow toward the falling end [S20]. Fixture
  drain: 1:100, 1 %, 0.5729386977° (VC-ISO-12). Lines whose RTE attributes require a slope and do not have it →
  `ISO_SLOPE_BELOW_MIN` (data from RTE).

### 5.10 Sheet splitting and continuation (TR-ISO-12)

Input: components in flow order, budget B = `maxPipePiecesPerSheet` (or a geometric budget from the layout).
Greedy: fill sheet i with components until adding the next PIPE would exceed B; cut at the last weld or flange joint
inside the sheet (never inside a component); the joint is printed on both sheets with "CONT. ON SHEET i+1 — W<n>" /
"CONT. FROM SHEET i — W<n>" and its coordinates. Branches go with their tee unless the branch alone exceeds B (then a
branch sheet). Stability: `IsoDefinition.sheetAssignment` stores componentId → sheet; on re-issue existing
components keep their sheet; new components go to the sheet of their upstream neighbour; an overflowing sheet spills
its new components to a new sheet appended at the end (Smart 3D style "1A" [S22]). VC-ISO-13: 20 pieces, B = 8 → 3
sheets.

### 5.11 Orthographic piping GA (TR-ISO-13)

Reuses `buildPlanDrawing` / elevation projection. Adds per pipe run: line label `<line>-DN<dn>-<spec>` placed parallel
to the longest run, `CL EL` per horizontal run, `BOP EL = CL − OD/2` (and `TOS` of supporting steel when known), flow
arrows every run > 1000 mm in the direction from `from` to `to`, double-line outline (OD) from `doubleLineFromDn`.
Fixture: BOP = 3000 − 114.3 / 2 = 2942.85 (VC-ISO-15).

### 5.12 check_isometric (TR-ISO-14)

Rules, each a data row with code, severity and source (AF-30): connectivity (`ISO_DISCONNECTED`), open ends
(`ISO_OPEN_END`), missing SKEY / item code, unnumbered welds before a final iso (`ISO_WELDS_UNNUMBERED`), spool limits,
short cut pieces, dimension closure, legacy-derived fittings (warning), unverified catalogue rows (warning, cannot be
hidden, AF-32), slope below the line's minimum, sheet overflow, iso not issued (`ISO_REVIEW_REQUIRED` info, AF-33).

## 6. Interop and persistence

### 6.1 PCF subset (MVP)

Read and written: header (`ISOGEN-FILES`, `UNITS-BORE`, `UNITS-CO-ORDS`, `UNITS-WEIGHT`, `UNITS-BOLT-DIA`,
`UNITS-BOLT-LENGTH`, `UNITS-WEIGHT-LENGTH`); pipeline (`PIPELINE-REFERENCE`, `PIPING-SPEC`, `INSULATION-SPEC`,
`TRACING-SPEC`, `PAINTING-SPEC`, `REVISION`, `PROJECT-IDENTIFIER`, `AREA`, `DATE-DMY`, `SPOOL-PREFIX`,
`WELD-PREFIX-*`, `HIGHEST-WELD-NUMBER`, `HIGHEST-SPOOL-NUMBER`); components PIPE, ELBOW, BEND, TEE, OLET,
REDUCER-CONCENTRIC / -ECCENTRIC, FLANGE, FLANGE-BLIND, GASKET, BOLT, VALVE, CAP, WELD, SUPPORT, INSTRUMENT with
`COMPONENT-IDENTIFIER`, `END-POINT`, `CENTRE-POINT`, `BRANCH1-POINT`, `CO-ORDS`, `SKEY`, `ITEM-CODE`, `WEIGHT`,
`FABRICATION-ITEM` / `ERECTION-ITEM`, `CATEGORY`, `COMPONENT-ATTRIBUTE1..10` (CAESAR II map, kept for
`07-pipe-stress-flexibility`); `MATERIALS` with `ITEM-CODE` + `DESCRIPTION`. Everything else: preserved verbatim
(`extra`) and reported. Keyword facts and grades: `validation/data/pcf_keywords.json`.

### 6.2 Other formats

- Isometric sheets: SVG (`DrawingPainter`) and DXF (R12 via `@lib/dxfWriter`), layers `ISO-PIPE`, `ISO-SYMB`,
  `ISO-DIM`, `ISO-TEXT`, `ISO-TABLE`, `ISO-FRAME`; PNG via the CLI rasterizer (`--save iso.png`).
- Weld / cut / spool / BOM tables: in `data` (JSON) and V1 CSV files in `data.files[]`.
- IFC: welds and spools are not exported in this gap (`08-plant-data-reports-interop` owns IFC piping); the PCF is the
  fabrication exchange.
- Document: the `fabrication` slice (§3) is saved with the document; `DocumentExtension.validate` checks ids,
  numbers (unique per line), and references to existing components.

## 7. CLI / MCP / UI surfaces and error codes

- CLI: every command by name; `import_pcf file=L-101.pcf` (one new `FILE_PARAMS` row in `server/src/cli/exchange.ts`,
  key `text`, utf8); `export_pcf --save out/` and `export_isometric --save out/iso/` write `data.files[]`
  (`saveFiles.ts`); `--save iso.png` rasterizes the first sheet SVG. `llull guide` gains a piping-fabrication section
  (axes and units, line / weld / spool naming, the minimal plan = sc-iso-01) (AF-03).
- MCP: toolset `piping`; `packages/mcp/src/toolsets.ts` getter `piping` becomes `PIPING_TOOLS` ∪
  `pluginToolNames('piping')`; the tool-schema snapshot gains the new tools.
- UI: sheet browser lists generated isos (SVG view); a weld / BOM row click selects the component; check results
  panel; approval dialog calling `issue_isometric` with the reviewer's signature (09 PLM).

| Code | Raised by | Meaning | Remediation |
| ---- | --------- | ------- | ----------- |
| `ISO_PCF_HEADER` | import_pcf | first line is not `ISOGEN-FILES …` | "export the PCF again from the source tool; the first line must be ISOGEN-FILES" |
| `ISO_PCF_TAB` | import_pcf | TAB character at `line N` | "replace TABs with spaces (PCF forbids TAB)" |
| `ISO_PCF_LINE_TOO_LONG` | import_pcf | line N > 1024 characters | "shorten the attribute on line N" |
| `ISO_PCF_UNITS_MISSING` | import_pcf | UNITS-BORE or UNITS-CO-ORDS absent | "add UNITS-CO-ORDS MM / INCH to the header" |
| `ISO_PCF_RECORD_INVALID` | import_pcf | point record with missing / non-numeric values at line N | "fix the END-POINT on line N: x y z bore [end type]" |
| `ISO_PCF_LINE_EXISTS` | import_pcf | a line with this reference already exists | "pass lineIdOverride or delete the line first" |
| `ISO_LINE_NOT_FOUND` | all line commands | unknown line id | "list lines with building_schedule kind=pipe" |
| `ISO_NO_PIPING` | export_pcf, export_piping_ga | the document has no piping | "route a line with add_pipe_run or import_pcf" |
| `ISO_SKEY_MISSING` | export_pcf, check | a non-pipe component has no SKEY | "set the spec item's skey (01 PSC) or drop strictSkey" |
| `ISO_ITEM_CODE_MISSING` | piping_bom, check | component without item code | "assign the spec item (01 PSC)" |
| `ISO_DISCONNECTED` | check, export_isometric | two connection points within 1 mm that do not coincide, or a component not reachable from the line start | "reconnect the component (02 RTE) — ids listed" |
| `ISO_OPEN_END` | check | a line end with no terminal component and no equipment / tie-in reference | "add an end flange, cap or set from / to" |
| `ISO_LEGACY_FITTINGS_DERIVED` | check, all queries (warning) | elbows derived from a polyline pipe | "re-route with the spec (02 RTE) to place real fittings" |
| `ISO_SEGMENT_TOO_SHORT` | legacy network | adjacent elbows overlap | "lengthen the segment or use a bend" |
| `ISO_WELD_NOT_ON_PIPE` | add_field_weld | `at` is not on a pipe centreline (tolerance 1 mm) | "pick a point on a pipe of the line" |
| `ISO_WELD_TOO_CLOSE` | add_field_weld | the new weld leaves a piece shorter than `minCutPieceMm` | "move the weld" |
| `ISO_WELD_NOT_FOUND` | set_weld_type | unknown weld | "list welds with weld_list" |
| `ISO_WELDS_UNNUMBERED` | weld_list, check (warning; error for style final) | joints without a stored number | "run number_welds" |
| `ISO_GAP_UNDEFINED` | cut_list | no weld gap given and no rule | "pass weldGapMm or set_fabrication_rules weldGapMm=… source=…" |
| `ISO_CUT_LENGTH_SHORT` | cut_list, check | a cut piece below `minCutPieceMm` | "move the weld or merge the pieces" |
| `ISO_SPOOL_TOO_LARGE` / `ISO_SPOOL_TOO_HEAVY` | split_spools, check | a spool exceeds the user's limit | "add a field weld (add_field_weld) or split_spools autoBreak=true" |
| `ISO_DIMENSION_MISMATCH` | export_isometric, check | a string does not close to its overall (guard) | "report a bug with the plan" |
| `ISO_SHEET_OVERFLOW` | export_isometric (warning) | layout could not fit without split | "define_isometric maxPipePiecesPerSheet=…" |
| `ISO_SLOPE_BELOW_MIN` | check | a run falls less than the line's required slope | "re-route with the slope (02 RTE)" |
| `ISO_UNVERIFIED_CATALOGUE` | check (warning, not hideable) | a catalogue row used is `unverified` (01 PSC) | "verify the spec rows (01 PSC) before issue" |
| `ISO_PARAM_INVALID` | all | out-of-range parameter | per param |
| `ISO_CHECK_FAILED` | issue_isometric | check_isometric has errors | "fix the listed issues first" |
| `ISO_HUMAN_GATE` | issue_isometric | caller is an agent / no human signature | "ask the reviewer to issue the iso in the desktop app" |

## 8. Performance and robustness budgets

| Operation | Size | Budget (reference desktop, node 22) |
| --------- | ---- | ----------------------------------- |
| `import_pcf` preview | 1000 components | < 100 ms |
| `export_pcf` | 1000 components | < 200 ms, output ≤ 120 kB |
| welds + spools + cut list | 1000 components | < 50 ms |
| `export_isometric` SVG | 100 components, 1 sheet | < 500 ms |
| `export_isometric` SVG | 1000 components, auto split | < 2 s (VC-ISO-18 TBD) |
| `check_isometric` | whole document, 500 lines | < 1 s |

Robustness: PCF input capped at 16 MB and 200 000 lines (`ISO_PCF_TOO_LARGE`); coordinates must be finite;
layout iterations bounded (no infinite collision loops); all outputs deterministic (sorted maps, fixed number format).

## 9. Test strategy (mapped to VCs)

| Level | File | VCs |
| ----- | ---- | --- |
| Unit, PCF | `tests/unit/plant/fabrication/pcfRead.test.ts`, `pcfRoundTrip.test.ts` (fixture + mutated variants) | VC-ISO-01, 02, 03 |
| Unit, fabrication | `welds.test.ts`, `spools.test.ts`, `cutList.test.ts`, `bom.test.ts` against `iso-01-L101-dn100.expected.json` | VC-ISO-05, 06, 07, 08, 09, 14 |
| Unit, drawing | `isoProjection.test.ts`, `isoDimensions.test.ts`, `isoSlope.test.ts`, `isoSheets.test.ts`, `pipingGa.test.ts` (assert `data`, not SVG pixels) | VC-ISO-10, 11, 12, 13, 15 |
| Unit, check | `checkIsometric.test.ts` (hand-built broken networks) | VC-ISO-16 |
| Unit, styles / skew / gate | `isoStyles.test.ts`, `isoSkew.test.ts`, `issueIsometric.test.ts`; CSV and revision delta in `welds.test.ts` / `isoSheets.test.ts` | VC-ISO-19..23 |
| Purity / contract | `is pure` per mutating command; tool-schema snapshot; `DocumentExtension` validation of the slice | all mutating |
| Scenario | `server/tests/packReplay05.test.ts` runs `validation/plans/*.json` through `build_project` (`unbuilt` plans skipped until their commands exist) | VC-ISO-04, 13, 17 |
| Golden | `tests/golden/plant_iso_l101.json` (plan sc-iso-02; PCF + SVG sha256) | VC-ISO-17 |
| Quality gate | 1000-component synthetic line timing | VC-ISO-18 |
| Reference cross-check | CI step runs `python3 -I validation/data/pcf_reference_parse.py` and diffs with the `.expected.json` (guards the reference itself) | VC-ISO-01..08 |

Coverage gate 90/85/90/90 applies (`packages/domain-aec/src/**`).

## 10. Delivery plan

| Milestone | Content | Depends on | Effort |
| --------- | ------- | ---------- | ------ |
| ISO-M1 | **Built 2026-10-25 (§13).** network port + legacy network; PCF lexer / reader / writer; `import_pcf` (preview + `pcf_line`), `export_pcf`; codes; VC-ISO-01..03 | PSC bend radius rule (fallback: 1.5 × NPS LR90 from the B16.9 table) | 5 d |
| ISO-M2 | **Built 2026-10-31 (§13.2).** welds + persistent numbering, `add_field_weld`, `set_weld_type`, spools, `set_fabrication_rules`, cut list, BOM with bolting; VC-ISO-05..09, 14 | PSC flange / bolt tables | 5 d |
| ISO-M3 | **Built 2026-10-31 (§13.3).** iso graph, projection, not-to-scale layout, symbols, dimensions, elevations, slope, tables, SVG / DXF, single sheet; `check_isometric`; VC-ISO-10..12, 16, 17 | — | 8 d |
| ISO-M4 | **Built 2026-10-31 (§13.4); `compareToIssue` and revision clouds stay M6.** sheet split + continuation + stability, spool isos, `define_isometric`, `issue_isometric` (human gate) | 09 PLM signatures (aerospace) | 4 d |
| ISO-M5 | `import_pcf as=route` via RTE; supports in PCF / iso; skew boxes; piping GA (`export_piping_ga`); VC-ISO-04, 13, 15 | 02 RTE | 5 d |
| ISO-M6 | performance (VC-ISO-18), ISOGEN conformance check of the fixture (OQ-ISO-01), CSV weld map, revision clouds | licensed tool access | 3 d |

Total ≈ 30 developer-days. Cross-gap: `07-pipe-stress-flexibility` consumes `export_pcf` (COMPONENT-ATTRIBUTE map)
and the stress iso style; `08-plant-data-reports-interop` consumes the BOM and weld list; `09-plant-visualization-review`
highlights spools / welds; `04-pid-schematics` checks line numbers against the P&ID; `10-pointcloud-brownfield`
can export as-built lines through `export_pcf`.

## 11. Open questions / decisions needed

- **OQ-ISO-01** Conformance: run `validation/data/iso-01-L101-dn100.pcf` and an llull export through a licensed ISOGEN
  (Plant 3D `PLANTPCFTOISO`, Smart 3D) or IsoAlgo; read the PCF Reference Guide (free since 2015 [S2]) to confirm
  the WELD record form, MATERIALS layout and attribute order, then promote B rows of `pcf_keywords.json` to A.
- **OQ-ISO-02** SKEY coverage: obtain the SKEY guide and fill `skey_catalogue.json` (valves VT.., caps, gaskets);
  until then unknown SKEYs come only from the user's spec.
- **OQ-ISO-03** Symbol style: ISO 6412-2 conventions vs ISOGEN default look; buy ISO 6412-1/-2 for the drafting
  rules (paywalled), or follow ISOGEN defaults as the de-facto style.
- **OQ-ISO-04** Plugin layout with PSC / RTE (one `plant` plugin vs separate plugins sharing `plant/model`).
- **OQ-ISO-05** Weld gap / field-fit allowance defaults: none is sourced; keep them mandatory or ship a
  company-template file with a `source` string?
- **OQ-ISO-06** Weld identity across topology edits (a pipe split in two): match by component ids, position, or both
  (current proposal: position within 1 mm on the same line, else new number).
- **OQ-ISO-07** Should `import_pcf` default to creating RTE components (editable) or `pcf_line` (read-only) when
  both are available?

## 12. References

Rn = source Sn in [validation/sources.md](validation/sources.md) (graded table, URLs, hashes). Key ones:

- [R1] Piping Component File Reference Guide 2016 (13.0) — Alias / Hexagon — catalogue copies (scribd / pdfcoffee), accessed 2026-10.
- [R2] Intergraph makes Isogen PCF documentation available — Chemical Processing — https://www.chemicalprocessing.com/industrynews/2015/intergraph-makes-isogen-pcf-documentation-available-/ (accessed 2026-10).
- [R3] Revit PCF Exporter wiki — https://github.com/shtirlitsDva/Revit-PCF-Exporter/wiki (accessed 2026-10, downloaded).
- [R6] AVEVA E3D ISODRAFT user guide — https://help.aveva.com/AVEVA_Everything3D/1.1/ISOUG/ISOUG6.06.02.html (accessed 2026-10).
- [R7] PCF Reference Guide copy — https://pdfcoffee.com/pc-f-reference-guide-9-pdf-free.html (accessed 2026-10).
- [R8] PTC Creo, Example: Weld Components in a PCF File — https://support.ptc.com/help/creo/creo_pma/r12/usascii/piping/piping/Example__Weld_Components_in_a_PCF_File.html (accessed 2026-10).
- [R9] ISOGEN SKEY Definitions Reference Guide — https://pdfcoffee.com/isogen-symbol-key-skey-definitions-reference-guide-pdf-free.html (accessed 2026-10).
- [R11] AutoCAD Plant 3D help, iso styles — https://help.autodesk.com/cloudhelp/2025/ENU/Plant3D-UserGuide/files/GUID-6EDFD98B-9964-4AF8-8AC8-8BF585F5AE0C.htm (accessed 2026-10).
- [R13] CADMATIC PCF Export — https://docs.cadmatic.com/plant/Content/Piping%20Isometrics/Application/Manage/link_pcf.htm (accessed 2026-10).
- [R14] PCF Component Guide — https://pdfcoffee.com/pcf-component-guide-2-pdf-free.html (accessed 2026-10).
- [R18] Isometric projection — https://en.wikipedia.org/wiki/Isometric_projection (accessed 2026-10).
- [R19] Axonometric projections — CMU — https://www.andrew.cmu.edu/user/ramesh/teaching/course/48-175/lectures/10.AxonometricProjections.pdf (accessed 2026-10).
- [R20] Piping Isometrics — Project Materials — https://blog.projectmaterials.com/epc-projects/engineering/piping-isometrics/ (accessed 2026-10).
- [R22] Hexagon Smart 3D / Isogen documentation — https://docs.hexagonppm.com (accessed 2026-10).
- [R23] Locating Field Welds — https://pipingdesigners.com/wp/2014/05/28/section-13d-locating-field-welds (accessed 2026-10).
- [R24] ISO 6412-1:2017 — https://www.iso.org/standard/73352.html (accessed 2026-10).
- [R25] ISO 6412-2:2017 — https://www.iso.org/standard/73353.html (accessed 2026-10).
- [R26] / [R27] 01-piping-specs-catalog validation data (B16.9, B16.5) — `../01-piping-specs-catalog/validation/data/`.
- [R28] PipeCAD / IsoAlgo — https://github.com/eryar/PipeCAD (accessed 2026-10).
- [L1] llull source files cited in §1 (this repository).

## 13. As built

### 13.1 ISO-M1 (2026-10-25): network port, legacy network, PCF reader / writer, `import_pcf`, `export_pcf`

Plugin `piping-fabrication` (toolset `piping`), folder `packages/domain-aec/src/plant/fabrication/`, installed after `piping` in `installDefaultPlugins()`.

| File | Content |
| ---- | ------- |
| `model.ts` | the read port `PipingNetwork` / `NetworkComponent` / `NetworkPoint` (§3, mm), `IsoIssue`, and the stored form `PcfLineData` (plain JSON: header, pipeline attributes, components, MATERIALS, unknown records) and `FabricationModel` |
| `pcf/pcfLexer.ts`, `pcf/pcfRead.ts` | lines + limits (TAB, 1024, header, 16 MB / 200000 lines) then records; units scaling; `extra` / `unknownRecords` kept; coded refusals with `line N` |
| `pcf/pcfWrite.ts` | canonical writer (§5.2), mm (1 decimal) or inch (4 decimals) |
| `pcf/pcfMap.ts` | `networkOf` (data to network, MATERIALS descriptions joined), `dataOfNetwork`, `summarise` (counts, pipe lengths, BOM), `missingSkeyIds` |
| `routeNetwork.ts` | routed line (the derived parts of its runs) to network: the 02 RTE writer of its §13.10, moved here with unchanged output bytes |
| `legacyNetwork.ts` | building `PipeElement` lines to a network with derived elbows (§5.3) |
| `commands/` | `import_pcf`, `export_pcf`, `delete_pcf_line` |
| `validate.ts`, `plugin.ts`, `catalog.ts`, `state.ts`, `codes.ts` | slice validation (`DocumentExtension`), registration, `getFabrication` / `lineIdsInUse`, `ISO_*` remediation table |

Slice: `doc.plant.fabrication?: FabricationModel = { version: 1, pcfLines }` (plant README D2: a sub-record of `doc.plant`, type in the plugin, not in core;
the core file `model/fabrication.ts` of §3 was not needed). `pcfLines[lineId]` is a `PcfLineData` in mm. Later milestones add welds, spools and isometric definitions.

**How `export_pcf` evolved.** The 02 RTE V1 part 2 command (`piping/commands/exportPcf.ts` + `piping/pcf.ts`) was moved, not duplicated: the part-to-record mapping is now
`routeNetwork.ts` (route line to `PipingNetwork`), the text is produced by the one canonical writer `pcf/pcfWrite.ts`, and the command lives in the 05 plugin. For routed lines the output is
byte-identical to before (both golden files `tests/golden/__snapshots__/piping_pcf_*.pcf` unchanged). It gained: the two other line sources (imported lines are written back from their stored
data, legacy pipes through the legacy network), `units: 'mm' | 'inch'`, `includeMaterials`, `strictSkey`, per-file `source` and `warnings`, and the ISO codes in place of RTE_UNKNOWN_LINE / RTE_NO_RUNS
(`ISO_LINE_NOT_FOUND`, `ISO_NO_PIPING`; the `RTE_*` code of a run that no longer derives is still returned as is). `data.files[]` keeps every key it had.

**Deviations from §4 (all decided, see below).** `import_pcf`: `as` has the single value `pcf_line` (routed components arrive with M5); `levelId` is not taken (PCF coordinates are world, z is absolute);
the data adds `units` (the declared ones), `withoutItemCode`, `stored`. `export_pcf`: `strictSkey` replaces `allowMissingSkey` (inverted default); `includeSupports` waits for M5 (supports and welds are not written).
New: `delete_pcf_line` (the remediation of `ISO_PCF_LINE_EXISTS` needs a way to delete). New codes: `ISO_PCF_TOO_LARGE` (the §8 cap), `ISO_PCF_UNKNOWN_RECORD`, `ISO_PCF_BORE_UNMAPPED` and
`ISO_PCF_LINE_TRUNCATED` (warnings), `ISO_PCF_UNITS_VERBATIM` and `ISO_LINE_DUPLICATE` (refusals).

**Reader rules beyond §5.1.** One `PIPELINE-REFERENCE` per file (a second one is `ISO_PCF_RECORD_INVALID`). `COMPONENT-IDENTIFIER` is dropped and renumbered on write; `UNIQUE-COMPONENT-IDENTIFIER` is the component id
(absent: `pcf:<line>:<n>`, which the writer does not write back). A duplicated attribute, a point with a stray token, more than two `END-POINT`s, a `PIPE` / `ELBOW` / `BEND` / `TEE` / `REDUCER` without two
`END-POINT`s, a non-numeric weight, a unit other than MM / INCH(ES) and a repeated MATERIALS item are `ISO_PCF_RECORD_INVALID` with the line (lossless storage is impossible otherwise). Unknown records are kept
verbatim at their position (`after` = number of known components before them) and reported; unknown component attributes go to `extra` in file order. UNITS-BORE / -CO-ORDS are required; the four length
units are chosen by the writer, `ISOGEN-FILES`, `UNITS-WEIGHT` and `UNITS-WEIGHT-LENGTH` pass through. SKEY WW / WS / WF on a WELD sets `weldKind`; FABRICATION-ITEM / ERECTION-ITEM / OFFSHORE-ITEM set `category`.

**Writer attribute order** (a refinement of §5.2 "stored order"): `COMPONENT-IDENTIFIER`, `UNIQUE-COMPONENT-IDENTIFIER` (llull ids only), `END-POINT`s, `CENTRE-POINT`, `BRANCH1-POINT`, `CO-ORDS`,
the unknown attributes in stored order, `SKEY`, the category flag, `ITEM-CODE`, `WEIGHT`. This reproduces the reference writer on the fixture (sha256 `56d1b90a...`, VC-ISO-03) and the 02 RTE output
(UNIQUE-COMPONENT-IDENTIFIER right after the identifier, SPINDLE-DIRECTION before SKEY). A file that orders SKEY / ITEM-CODE differently is normalised, not preserved. Pipeline attributes are written in
the fixed order PIPING-SPEC, INSULATION-SPEC, TRACING-SPEC, PAINTING-SPEC, PROJECT-IDENTIFIER, AREA, REVISION, DATE-DMY, SPOOL-PREFIX, WELD-PREFIX-*, HIGHEST-*, then the others in stored order.

**Legacy network as built.** Elbows at every interior vertex whose turn is at least 0.5 degree (a smaller turn is straight pipe, the vertex is ignored). A turn within 1 degree of 90 / 45 is an ELBOW
(SKEY ELBW, flagged `derived`) with the centre-to-end of the bundled B16.9 long-radius catalogue (`resolveCatalogRow` elbow90 / elbow45 LR; DN100: 152.4 and 63.5 mm: the PSC table value, not the 152 rounding of the
02 RTE stub spec); any other turn is a derived BEND with A = R x tan(theta / 2), R the 90 degree value, and no SKEY. A size the catalogue does not know uses R = 1.5 x DN and is flagged `unverified`.
Findings: one `ISO_LEGACY_FITTINGS_DERIVED` naming all derived fittings; `ISO_SEGMENT_TOO_SHORT` (error) when a pipe piece would be shorter than -0.05 mm, the piece is not emitted; `ISO_OPEN_END` per line end without
`from` / `to`. Pipes sharing a line number form one network in element order with no joins inferred between elements; a pipe without a line number is its own line (keyed by its id). z = level elevation + point z.

**Decisions (owner delegated quality-first, 2026-10-25).**

- **OQ-ISO-04** separate plugin `piping-fabrication` in `plant/fabrication/`, slice `doc.plant.fabrication`, using PSC / RTE through their exported types and the catalogue lookup. Done as in §2.
- **OQ-ISO-07** `import_pcf` stores a read-only `pcf_line` by default, and `as: route` (M5) will be explicit: matching a foreign PCF to spec rows can fail or change dimensions, so editable routed components must be a deliberate act,
  while the lossless copy is always available and exports back to the same bytes.
- **OQ-ISO-02 (partial)** a component without a confirmed SKEY is written without one and listed in `missingSkey` by default (the 02 behaviour: a routed line with a valve must stay exportable); `strictSkey: true` refuses with
  `ISO_SKEY_MISSING`. llull never invents a key.
- **Bore units** with UNITS-BORE INCH the bore is the nominal NPS (4, 0.75, 2.5), not 3.937: it maps to the DN (100, 20, 65) through the catalogue NPS / DN pairing on read and write (`pcf/pcfUnits.ts`); an inch value that is no nominal size is converted by value (25.4) and reported (`ISO_PCF_BORE_UNMAPPED`, warning). Stored bores are DN in mm.
- **Declared units are kept** `PcfLineData.units` stores the four declared units (bore, coords, bolt diameter, bolt length; bolt units absent when undeclared). `export_pcf` writes a stored line in its own units by default (byte-equal round trip, also for an INCH file or a metric file with inch bolt units); `units: mm | inch` sets all four. Attributes and unknown records are kept verbatim and never scaled, so changing a declared unit on a line that has any is refused with `ISO_PCF_UNITS_VERBATIM`. The guard applies to imported lines only and to length-bearing content: unknown records and any unknown attribute with a value except SPINDLE-DIRECTION (COMPONENT-ATTRIBUTEn may hold lengths); bare flags and routed / legacy lines convert freely. WEIGHT is stored as written (`weight`, in UNITS-WEIGHT, not converted).
- **Imported lines are not drawn** in M1 (no derived entities, no viewport change); they are data for `export_pcf` and the later fabrication commands. Rendering as centrelines belongs with the iso / GA work (M3, M5).
- **Line ids** a line id is unique across routed lines (id and line number), imported lines and legacy line numbers; `import_pcf` refuses an id in use (`ISO_PCF_LINE_EXISTS`), its preview warns instead. create_pipeline / add_pipe_run do not know imported lines, so `export_pcf` keys every file by its PIPELINE-REFERENCE (routed: the line number) across the three sources and refuses a clash with `ISO_LINE_DUPLICATE` naming both owners (no file is overwritten or dropped); the comparison is on the sanitized file stem, so `L/100` and `L_100` clash. A legacy pipe whose level no longer exists is read at elevation 0 with an `ISO_LEVEL_MISSING` warning.
- **Legacy findings** an error-severity finding (`ISO_SEGMENT_TOO_SHORT`, which also catches turns near 180 degrees) refuses `export_pcf` with its code. SKEY ELBW is inferred only from DN 50 up (butt weld); a smaller legacy elbow has none and is listed in `missingSkey`. Legacy points, elevations and the diameter fallback are converted from the document unit to mm before the (mm) bend radius is applied.

**Tests.** `tests/unit/plant/fabrication/{pcfRead,pcfRoundTrip,legacyNetwork}.test.ts` (VC-ISO-01 counts / lengths / BOM, VC-ISO-02 every refusal with its line path, VC-ISO-03 byte-equal round trip and sha256 of the
fixture, route to export to import preview, inch, unknown records, slice persistence and validation, legacy network cases, export refusals); `tests/unit/plant/piping/pcf.test.ts` (the 02 goldens, unchanged bytes);
`server/tests/cliImportPcf.test.ts` (`import_pcf file=`, `export_pcf --save`). The CLI reads the file through one `FILE_PARAMS` row (`import_pcf: text`, utf8) in `server/src/cli/exchange.ts`.

**Open.** Conformance of the fixture and of an llull export with a licensed ISOGEN (OQ-ISO-01, M6). SKEYs beyond ELBW, ELSW, TEBW, FLWN, REBW (OQ-ISO-02). Connectivity-based `openEnds` for imported and legacy lines (M3; routed lines
use the RTE graph). Routed components from a PCF and supports in the PCF (M5). The pack plans `sc-iso-01/02/08` needed the M2+ commands to run end to end (sc-iso-01 now runs up to `check_isometric`, §13.2).

### 13.2 ISO-M2 (2026-10-31): welds, persistent numbering, spools, cut list, BOM with bolting

Nine commands in the plugin `piping-fabrication` (toolset `piping`): `add_field_weld`, `set_weld_type`, `number_welds`, `weld_list`, `set_fabrication_rules`, `split_spools`, `spool_list`, `cut_list`, `piping_bom`.
All read a line through one function, `lineNetwork.ts loadLine`: routed line, imported PCF line or legacy pipe line (the M1 network port), with the stored field welds applied.

| File | Content |
| ---- | ------- |
| `fieldWelds.ts` | `splitComponents`: a stored field weld splits the PIPE it lies on (1 mm tolerance) into `<pipeId>.s1`, `.s2` with a WELD (SKEY WS / WF, ERECTION-ITEM) between; a weld on no pipe is stale and ignored (`ISO_FIELD_WELD_STALE`) |
| `joints.ts` | connection nodes keyed at 0.1 mm, iterative depth-first walk from the line start (run before branch), joint classes shop / site / field_fit / bolted / other, terminals |
| `welds.ts` | numbering plan: match stored welds to joints (same position and components, else position, else components), new = highest + 1, vanished = orphaned, `renumber` |
| `spools.ts` | union-find spools, names `<line or spoolPrefix>-SP<nn>`, metrics, limit violations, `suggestSplit` for autoBreak |
| `cutList.ts`, `bom.ts` | cut pieces; BOM rows and bolting (ASME B16.5 table of the bundled catalogue) |
| `analysis.ts` | one line read + graph + numbering plan + spools: what the commands call |

Slice `doc.plant.fabrication` gained optional `rules`, `fieldWelds`, `welds` (key `<lineId>#<n>`), `highestWeldNumber`, `spoolBreaks`; `validate.ts` checks them (key = id, number unique per line). `delete_pcf_line` also removes the line's field welds, weld numbers and spool breaks. `export_pcf` writes the field welds as WELD records for all three line sources (its description lost "welds and spools are not written yet": a changed sentence of an existing tool).

**Deviations from §3 / §4 / §5 (all decided).**

- Spools and cut pieces are **derived, not stored** (`SpoolRecord` is not persisted): they follow every edit and their names are stable from the flow order; the stored part is the break choice per line (`split_spools`) and the inserted welds. `WeldRecord` is keyed `<lineId>#<n>` (not by joint key, which changes when a joint moves) and carries `kindSet` (a `set_weld_type` override).
- **Field welds are a layer over the line**, not an edit of it: a routed or legacy line cannot be edited by a weld, and an imported line must keep its lossless bytes. `add_field_weld` takes `type: site | field_fit` only (default `site`); the pack plans said `field`, corrected in sc-iso-02 / 05. Weld kind is `site` (not the reference script's `field`); `weld_list` adds `field: true` for site and field-fit, and sc-iso-01 / VC-ISO-05 now expect `site` for W2.
- `weld_list` of an unnumbered line shows the numbers `number_welds` would give (`numbered: false`, warning `ISO_WELDS_UNNUMBERED` in data, not a refusal): sc-iso-01 reads welds before numbering. Numbers are `<prefix><n>` with prefixes from the rules (default `W` for both shop and erection); the file's `HIGHEST-WELD-NUMBER` raises the starting point. `number_welds` returns `highest` as a map by line and takes `lineId` and / or `lineIds`; `weld_list` has no `format: csv` (M6, VC-ISO-22).
- `set_weld_type` finds a weld by `weldId` or `lineId` + `at` and only works on numbered welds (`ISO_WELD_NOT_FOUND` otherwise); the number is re-prefixed for the new kind and keeps its n.
- Spool limits: `maxSpoolLengthMm / WidthMm / HeightMm` form the envelope compared with the spool envelope after sorting both triples (an omitted side is unlimited); `lengthMm` of a spool is its longest centreline path (reported, not limited). Weight is the sum of the `WEIGHT`s the components carry (`weightComplete: false` when some carries none; no unit weights are invented); pieces = PIPE count. `line_ends` in `breakAt` is accepted and has no effect (a line end always ends a spool). An OLET without END-POINTs joins by its branch point only. The longest path is a double sweep (exact on a tree, a bound on a loop).
- `autoBreak` needs `field_welds` in `breakAt`, inserts site welds one at a time at the pipe nearest the middle of the longest path of the first violating spool (both pieces at least max(1 mm, minCutPieceMm); fallback: the middle of the longest pipe of the spool), at most 200 passes, and refuses with the violation code when it cannot fit. The inserted welds are ordinary field welds (ids `fw-<step>.<k>`).
- `cut_list`: the gap is always required (param or rule); the allowance only when the line has a field-fit weld; `ISO_CUT_LENGTH_SHORT` is a refusal (a piece not longer than max(0, minCutPieceMm)); stock-length nesting (V1) is not built. `data` adds `centrelineTotalMm` and the per-end `adjustments`.
- `piping_bom`: scopes `line | spool | document` (`sheet` arrives with the sheets, M4). Bolting: a flange pair (FL-FL joint) or, with `matingFlanges: assume_in_scope`, each FL line end gives one gasket and one bolt set (default `this_side_only`: pairs only); bolts per set and diameter come from the bundled ASME B16.5 weld-neck table by DN and class, the class being parsed from the flange item code (`FLWN-100-150`); a flange without a readable class or size is counted as a joint and gasket, listed in `bolting.unresolved` and warned (`ISO_BOLTING_UNRESOLVED`). A bolted joint belongs to the spool of its first component, so the spool BOMs add up to the line. Components without item code are warned (`ISO_ITEM_CODE_MISSING`), not refused. Stud length is not computed (V1).
- New codes: `ISO_SPOOL_NOT_FOUND`, `ISO_BOLTING_UNRESOLVED`, `ISO_FIELD_WELD_STALE`, `ISO_SPOOL_WEIGHT_INCOMPLETE` (table only, not raised yet); `ISO_NO_PIPING` is also raised by the new queries for a routed line without a run.
- No kernel (L9): none of the commands sets `requiresKernel`. No text reader was added (no hostile-input entry).

**Tests.** `tests/unit/plant/fabrication/{welds,spools,cutList,bom,lineSources,scenarioPlans}.test.ts`: VC-ISO-05 (13 welds against the reference script, branch welds last), VC-ISO-06 (2 spools; 1 without the WELD record), VC-ISO-07 (gap 0 / 3, WF allowance 100, both gaps), VC-ISO-08 / 09 (BOM identities, 3 gaskets and 24 studs 5/8 in), VC-ISO-14 (W14 after a new weld, old numbers kept), orphans and renumber, coded refusals with the document unchanged, `is pure`, replay equality, routed and legacy sources, a 1000-component timing check (bound 3 x the budget plus runner slack), and the pack plans SC-ISO-01 and SC-ISO-07 run step by step (the `check_isometric` steps skipped until M3). `blockedPlanCommands.json` lost `weld_list`, `split_spools`, `spool_list`, `cut_list`, `piping_bom`, `add_field_weld`, `set_fabrication_rules`; still blocked: `check_isometric` (sc-iso-01, 07), `add_end_flange` (sc-iso-02, RTE), `define_isometric` / `export_isometric` (sc-iso-03..05, 08), `export_piping_ga`.

**Open.** VC-ISO-22 (CSV weld map) and the isometric timing of VC-ISO-18 are M6; stock-length nesting and stud lengths are V1; the sheet-scope BOM waits for M4; the sc-iso-02 BOM step waits for RTE flanges and branches.

### 13.3 ISO-M3 (2026-10-31): iso graph, projection, layout, symbols, dimensions, tables, SVG / DXF single sheet, `check_isometric`

Two commands in the plugin `piping-fabrication` (toolset `piping`): `export_isometric` (query / export, one sheet, SVG and / or DXF) and `check_isometric` (query). Both read a line through `analysis.ts analyseLine` (M2), so routed, imported and legacy lines draw alike.

| File | Content |
| ---- | ------- |
| `iso/isoProjection.ts` | east -30 / north +30 / up 90 degrees (the `viewDirections.ts` iso frame, tested against it), `up_left` (plant turned +90 degrees), depth for crossings |
| `iso/isoGraph.ts` | components to segments (an elbow, bend or tee through its centre point; an elbow without centre through the L corner), depth-first walk (run before branch), maximal straight runs, direction classes `+E .. -U | slope | skew` |
| `iso/isoDimensions.ts` | string + overall dimension per run (3D distances, label = value rounded to 0.1 mm), `EL`, `E .. N ..`, slope (`SLOPE 1:n` or percent, degrees, fall direction) |
| `iso/isoLayout.ts` | `l = clamp(k ln(1 + L / 200), 9, 110)` paper mm, k by bisection to fit, crossing passes (at most 12), uniform shrink + `overflow` below 70 % |
| `iso/isoSymbols.ts`, `iso/isoLabels.ts` | symbols by family and joint class; dimension lines; label placement on the first candidate that meets no box / line |
| `iso/isoTables.ts`, `iso/isoSheet.ts`, `iso/isoRender.ts` | bom / cut_list / weld_list / spool_list as text tables; sheet assembly (frame, title block, north arrow, NOT FOR CONSTRUCTION); primitives printed as SVG and DXF R12 (layers `ISO-PIPE`, `-SYMB`, `-DIM`, `-TEXT`, `-TABLE`, `-FRAME`) |
| `check.ts` | the rule table below |

**`check_isometric` rules** (code, severity): `ISO_DISCONNECTED` error (components not reachable from the line start; two connection points under 1 mm apart with different 0.1 mm keys), `ISO_OPEN_END` warning,
`ISO_SKEY_MISSING` error, `ISO_ITEM_CODE_MISSING` warning, `ISO_WELDS_UNNUMBERED` warning (error with `style: final`), `ISO_SPOOL_TOO_LARGE` / `ISO_SPOOL_TOO_HEAVY` error (ids = spool names), `ISO_CUT_LENGTH_SHORT` error (only when a weld gap is stored),
`ISO_DIMENSION_MISMATCH` error (guard), `ISO_UNVERIFIED_CATALOGUE` warning, `ISO_LEGACY_FITTINGS_DERIVED` warning, `ISO_SHEET_OVERFLOW` warning, `ISO_FIELD_WELD_STALE` warning, `ISO_REVIEW_REQUIRED` info (always); a line that cannot be read
(`ISO_SEGMENT_TOO_SHORT` ...) is an error finding carrying its own code. `ok` = no error. **Connectivity-based open ends (the ISO-M1 note) are built**: on imported and routed lines a terminal whose end type is not `FL` / `CP` / `PL` and whose component is not a
CAP / FLANGE-BLIND is an open end; legacy pipes keep the open ends of their network (they know `from` / `to`), so none is reported twice.

**Deviations from §4 / §5 (all decided).**

- `check_isometric` takes two optional params more: `style` (`check` default | `final`, only the severity of `ISO_WELDS_UNNUMBERED`) and `paper` (the sheet the overflow rule is evaluated for, default A3, without tables). An unknown `lineId` is a coded refusal `ISO_LINE_NOT_FOUND` (and a document without piping `ISO_NO_PIPING`), not an issue row; every defect of a line is a finding.
- `export_isometric` has `style` `check | final` (the `spool` and `stress` styles, `spoolId`, `compareToIssue` arrive with M4+), `tables` (default: all four for final, none for check) and `northArrow` (an `IsoDefinition` does not exist before `define_isometric`, M4). `sheets[]` lists file names and the sha256 of the first file; the text of every file is in `files[]` only (`name`, `format`, `content`, `sha256`), as for `export_pcf`.
  One sheet always: a line too large is shrunk (`layout.scale`) and warned (`ISO_SHEET_OVERFLOW`); no continuation marks, no `sheetAssignment`. A disconnected line is refused (`ISO_DISCONNECTED`, ids of the unreachable components); the dimension guard `ISO_DIMENSION_MISMATCH` is a warning row in `data.warnings` (`dimensionMismatches` > 0).
- The sheet is built from paper-mm primitives printed by one SVG and one DXF writer (`iso/isoRender.ts`), not through `DrawingPainter` and `composeSheetSvg`: they carry a scale bar and "1:N" that an isometric must not show. The title block is drawn from `sheetLayout` metrics.
- `ISO_SLOPE_BELOW_MIN` is not raised: 02 RTE has per-leg declared slopes (`check_piping`, `RTE_*_SLOPE`) but no required slope on a line. A run is a slope run when its direction is within 0.02 % of a horizontal axis in plan and falls at most 25 % (else skew, drawn at its projected angle; squaring-in triangles and the 22.5 degree rule are M5). Slope arrow and text are placed beside the run; `fallDirection` is the plan axis of the fall (`+X`, `-Y` ...).
- Weld marks show the provisional number of an unnumbered joint (`numbered: false`, warning `ISO_WELDS_UNNUMBERED`); the cut list table is left out, with `ISO_GAP_UNDEFINED` as a warning, while no weld gap is stored (no silent default). Tables print at most 30 rows per table (the sheet says how many more; `data.tables` has all).
- Supports are not drawn (M5). Gaps in a crossing are drawn on the farther pipe in SVG only. Label placement is greedy and can overlap in dense lines (reported by nothing but the picture).
- No kernel (L9): `requiresKernel` is not set. No text reader was added (no hostile-input entry).

**Tests.** `tests/unit/plant/fabrication/{isoDrawing,exportIsometric,checkIsometric,scenarioPlans}.test.ts`: VC-ISO-10 (axes against `viewDirections.ts`, `up_left`), VC-ISO-11 (76 / 2424 / 2348 / 152 = 5000, north 4000, every label = 3D distance), VC-ISO-12 (1:100, 1 %, 0.5729386977 degrees, +X; a percent case, rising and Y falls, no slope on level / vertical / steep / diagonal),
VC-ISO-16 (one positive and one negative per rule on hand-mutated fixtures and legacy lines), VC-ISO-17 (same sha256 twice, after `replay_history`), layout (monotone, minimum length, fit, overflow, crossing search), refusals with the document unchanged, `is pure`, budgets (a 100 component sheet, a 120 line check, bounds 3 x the spec).
The pack plans SC-ISO-01 (now every step, `check_isometric` ok), 03, 04 and 07 (step 4: `E-401-SP01` over the limit, open ends, `ok: false`) run step by step with every expected row. `blockedPlanCommands.json` lost sc-iso-01, 03, 04, 07 and 08 (sc-iso-08 still needs `add_pipe_support` / `includeSupports`, M5; its isometric step has no check yet);
still blocked: `add_end_flange` (sc-iso-02), `define_isometric` (sc-iso-05), `export_piping_ga` (sc-iso-06).

**Open.** The picture was checked by eye on the fixture (SVG rendered in a browser), not by a golden SVG hash; `tests/golden/plant_iso_l101.json` (VC-ISO-17 golden) and the 1000-component timing (VC-ISO-18) are M6; sheet split, continuation and spool isometrics are M4 (built, §13.4); skew boxes and supports M5. The 500-line `check_isometric` budget is exercised with 120 lines.

### 13.4 ISO-M4 (2026-10-31): sheet split, continuation marks, stable re-issue, spool isometrics, `define_isometric`, `issue_isometric`

Two new commands in `piping-fabrication` (toolset `piping`): `define_isometric` (mutating) and `issue_isometric` (mutating, human gate). Changed existing tools: `export_isometric` (several sheets, style `spool`, `spoolId`, the stored definition applies, issue stamp; description and the `style`, `paper`, `tables`, `northArrow` param texts), `piping_bom` (scope `sheet`, param `sheet`; description and `scope` text), `delete_pcf_line` (also removes the definition and issue stamps), `check_isometric` (rules below, description unchanged).

| File | Content |
| ---- | ------- |
| `iso/isoSheets.ts` | `planSheets`: component-to-sheet assignment (budget mode or spool mode), continuation joints, `continuationOf`, `definedPlan` |
| `issues.ts` | `basisOf` (SHA-256 of the line components and numbered weld joints), `issueState` (latest stamp; current when the basis still matches) |
| `commands/defineIsometric.ts`, `commands/issueIsometric.ts` | the two commands |
| `iso/isoSheet.ts`, `isoTables.ts`, `isoGraph.ts` | take a sheet scope: graph of the sheet's components, tables of its components, continuation marks, "n OF m", issue stamp |

Slice `doc.plant.fabrication` gained optional `isometrics` (by line id: style, paper, `maxPipePiecesPerSheet`, `splitAt`, `northArrow`, `sheetAssignment`) and `issues` (by id `iso-issue-<step>.<k>`: line, revision, purpose, signer, signatureId, `basisSha256`); `validate.ts` checks them.

**Split algorithm (§5.10 as built).** Components are walked in flow order. A component takes the sheet of its latest upstream joint partner (a branch follows its tee). A PIPE that makes the sheet exceed the budget triggers the cut: the latest component of the sheet from which the tail (this PIPE included) can move to a new sheet such that every joint the move crosses is a weld joint (`splitAt weld`: shop, site, field-fit) or a bolted pair (`splitAt flange`) and the moved tail stays connected. No such cut: the sheet stays over budget and `ISO_SHEET_OVERFLOW` is a warning (export, define, check). Every joint whose components lie on two sheets is a continuation, printed on both sheets as `CONT. ON SHEET n - W<number>` / `CONT. FROM SHEET n - W<number>` (`FLANGE` for a bolted joint) with its E/N/EL, listed in `data.sheets[].continuation { previous, next, all }`. WELD, GASKET and BOLT records follow the sheet of the joint they sit on. VC-ISO-13: 20 pipe pieces, budget 8 gives 8 + 8 + 4 with the same weld on both sides of each cut.

**Stability.** `define_isometric` stores the component-to-sheet assignment; `export_isometric` (read-only) applies it: a stored component keeps its sheet, a new one takes the sheet of its upstream neighbour, and a new PIPE that overflows a sheet spills (with the new components after it) to a new sheet appended at the end. Running `define_isometric` again stores the new assignment (`resetSheets` cuts afresh). A sheet's content depends only on its own components: after a field weld on the last sheet, sheets 1 and 2 are byte-identical (SC-ISO-05, sha256). Tables are per sheet (BOM, cut list and weld list of the sheet's components; the spool list counts pieces and pipe length on the sheet), so they do not move either. The text "SHEET n OF m" changes on every sheet when a sheet is appended (m).

**Spool style (VC-ISO-20).** `style: spool` (param or stored style) gives one sheet per spool in `spool_list` order with the whole-spool tables; spool boundary joints are continuations. `spoolId` draws one spool (implies the style; with another style `ISO_PARAM_INVALID`; unknown name `ISO_SPOOL_NOT_FOUND`). `check` prints no tables, `final` the four (cut list when a gap is stored).

**`piping_bom scope=sheet`** (`lineId` + `sheet`) sums to the line (identity tested, bolting included: a bolted joint belongs to the sheet of its first component). Refusals `ISO_ISOMETRIC_NOT_DEFINED`, `ISO_SHEET_NOT_FOUND`.

**Human gate (`issue_isometric`, VC-ISO-19).** Uses the core human gate (`@core/model/humanGate`, the port of the export gate and 09 PLM): `confirmation` is a signature object with a nonce, verified and spent by `ctx.humanSignature` over `{ act: "plant:issue_isometric", ids: [line], details: { revision, purpose, basisSha256 } }`. An agent (no value, `true`, no port, a bad signature, no nonce) gets `ISO_HUMAN_GATE`. `check_isometric` (style final) runs first: errors give `ISO_CHECK_FAILED` without spending the signature. Success stores the stamp; `export_isometric` then prints `ISSUED FOR <purpose> REV <rev>` and `APPROVED BY <signer>` instead of NOT FOR CONSTRUCTION, with `reviewRequired: false` and `data.issue`. The stamp is bound to the line content: any later edit makes it stale, the iso is NOT FOR CONSTRUCTION with `reviewRequired: true` again, and `ISO_ISSUE_STALE` is a warning (export and check).

**Check rules changed.** `ISO_SHEET_OVERFLOW` also reports a defined budget that cannot be met; the one-sheet shrink test is skipped for a line with a `maxPipePiecesPerSheet` definition (the split is the answer); `ISO_REVIEW_REQUIRED` (info) is not raised while a current issue exists; new `ISO_ISSUE_STALE` warning.

**Deviations from §3 / §4 (all decided).**

- `issue_isometric` takes `confirmation` (the signature object of the core gate) instead of `signatureId`; the signature id is read from the verified signature and stored. 09 PLM is not imported (the gate is in core); the signer is the identity the port reports.
- `IsoDefinition.style` is `check | final | spool` (`stress` is V2); `SpoolRecord` is not stored (M2). `define_isometric` params: `lineId`, `style`, `paper`, `maxPipePiecesPerSheet`, `splitAt`, `northArrow`, plus `resetSheets`; `isoId` in the data is the line id (one definition per line). The assignment is stored only by `define_isometric`; `export_isometric` is read-only and applies it.
- The budget counts PIPE pieces (a field weld splits a pipe, so it adds one). The cut joint for `splitAt flange` is a bolted FL-FL pair.
- A stored component is never moved: when new components lie before stored components of a full sheet, the sheet stays over budget with the warning (remediation: `resetSheets`).
- `export_isometric` data: `dimensions[]` and `annotations[]` carry `sheetIndex`; `sheets[]` gain `pipes`, `spool`, `tables`, `layout`; `continuation` is `{ previous?, next?, all }` (a one-sheet iso: `{ all: [] }`, formerly `{}`); file names `<line>_iso_sheet<n>.<fmt>`; top-level `tables` cover the whole line, `layout` is that of sheet 1. `compareToIssue` and revision clouds (VC-ISO-23) are not built (M6).
- New codes: `ISO_HUMAN_GATE`, `ISO_CHECK_FAILED`, `ISO_SHEET_NOT_FOUND`, `ISO_ISOMETRIC_NOT_DEFINED`, `ISO_ISSUE_STALE`. No kernel (L9); no text reader added (no hostile-input entry); no file params (no `FILE_PARAMS` row).

**Tests.** `tests/unit/plant/fabrication/isoSheets.test.ts` (VC-ISO-13: 8 + 8 + 4, matching welds, stable re-issue by sha256, spill, flange warning, reset, determinism and replay; VC-ISO-20; VC-ISO-19 gate cases, stale stamp, check before gate; sheet BOM identity; refusals with the document unchanged; `is pure`; save/load and corrupt slices; a 200-leg budget) and `scenarioPlans.test.ts` (SC-ISO-05: 3 sheets, continuation pair, sheets 1 and 2 unchanged). `blockedPlanCommands.json` lost sc-iso-05 (`define_isometric`); still blocked: `add_end_flange` (sc-iso-02), `export_piping_ga` (sc-iso-06).

**Open.** Supports, skew boxes, piping GA (M5); `compareToIssue`, revision clouds, CSV weld map, VC-ISO-18 timing (M6); the split pictures were not checked by eye in a browser.
