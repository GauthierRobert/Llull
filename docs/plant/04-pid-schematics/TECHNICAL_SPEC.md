# Gap 04 PID — P&ID schematics, DEXPI exchange and P&ID ↔ 3D consistency: technical specification

Status: specification only, written 2026-10-18. Functional view: [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md).
Validation: [`validation/README.md`](validation/README.md). Laws: `.claude/rules/architecture.md` (L1–L10).

## 1. Current state in llull

| Area | What exists | Path | Limit for P&ID work |
| --- | --- | --- | --- |
| 2D drafting | `draw_polyline`, `draw_arc`, `draw_rectangle`, `draw_point`, `draw_ellipse`, `draw_spline`, `add_text`, `add_dimension`, underlays | `packages/core/src/commands/draw2d/{basic,curves,annotate,underlay}.ts`; kinds in `SHAPE2D_KINDS` (`packages/core/src/model/types.ts`) | graphics only; no connection points, no item data, no symbol semantics |
| Blocks | `create_component`, `insert_instance`, `explode_instance` (`InstanceEntity { componentId, scale }`) | `packages/core/src/commands/assembly/assemblies.ts` | a usable carrier for symbol graphics, but no ports and no attributes |
| Sheets | `create_sheet`, views, `export_sheet_svg` (title block, ISO 128 line types) | `packages/core/src/commands/drawings/*`, `packages/core/src/model/drawing.ts`, `sheet.ts` | sheets show orthographic views of 3D solids, not schematics |
| DXF | `import_dxf` (blocks exploded), `export_dxf` (building plans) | `packages/core/src/commands/exchange/importDxf.ts`, `packages/domain-aec/src/building/exchange/dxfExport.ts` | a P&ID in DXF arrives as lines and text, connectivity lost |
| XML | `escapeXml` only (writer helper) | `packages/core/src/lib/escapeXml.ts` | no XML reader in core; `DOMParser` is forbidden in packages (L2) |
| 3D equipment | `add_equipment` / `update_equipment`: name, `mark` (unique tag), box or vessel, clearance, weight | `packages/domain-aec/src/industrial/equipment/{equipment,equipmentUpdate}.ts`; `EquipmentElement` in `packages/core/src/model/building.ts` | no nozzles (03 EQP), no class |
| 3D pipes | `add_pipe_run`: points, `line`, `dn` (EN 10220 / B36.10 OD table 15–400), `from` / `to` equipment tags, service, material | same file; `PipeElement`; sizes in `packages/domain-aec/src/industrial/piping/pipeSizes.ts` | no piping class, no inline valves, no ports (02 RTE) |
| Lists | `building_schedule kind=pipe` (mark, line, DN, service, OD, material, length) | `packages/domain-aec/src/building/quantities/{takeoff,scheduleBuild}.ts` | a 3D pipe schedule, not a P&ID line list |
| Checks | `check_clashes`, `check_pipe_supports`; `CheckResult` envelope; `humanGate` | `packages/domain-aec/src/industrial/clash/clash.ts`; `packages/core/src/model/{checkResult,humanGate}.ts` | nothing checks schematic consistency |
| MCP toolsets | `building`, `piping` (industrial piping subset), … | `packages/mcp/src/toolsets.ts` | no P&ID toolset |
| CLI `file=` | maps a file to a content param for listed tools | `server/src/cli/exchange.ts` (`FILE_PARAMS`) | `import_dexpi` must be added there |

Gap = everything in FUNCTIONAL §5: a P&ID data model, connectivity, tags, checks, lists, DEXPI I/O, and the
P&ID ↔ 3D check. Nothing in the repository references DEXPI, ISA 5.1 or ISO 10628 today.

## 2. Target architecture

- **Domain plugin `pid`** in `packages/domain-aec/src/plant/pid/` (`catalog.ts`, `plugin.ts`), `toolset: 'pid'`,
  installed by `src/app/plugins.ts` (L10). Sub-folders: `model/` (pure helpers over `PidModel`), `authoring/`
  (mutating commands), `connectivity/` (graph, split / heal, flow), `tags/` (grammar, ISA table), `checks/`
  (`check_pid`, `check_pid_3d`), `reports/` (lists), `dexpi/` (`proteus/` 1.3 / 1.4 mapper, `dexpi2/` mapper,
  `census.ts`), `symbols/` (built-in library as data), `render/` (sheet primitives).
- **Model types in core**, like `building.ts` / `civil.ts`: `packages/core/src/model/pid.ts`, and
  `CadDocument.pid?: PidModel` ("absent until the first P&ID command"). Persistence validation through the plugin's
  `DocumentExtension.validate` (L8). This is the one core change; it goes through `cad-reviewer`.
- **XML reader** `packages/core/src/lib/xmlRead.ts`: a small pure parser (elements, attributes, text, CDATA,
  comments, processing instructions, the five predefined entities and numeric character references, UTF-8 input as a
  JS string) returning a plain tree. No DOM, no network (L2). The writer side reuses `escapeXml`.
- **Pure commands** (L1, L3): every mutation returns a new document; P&ID items are created only inside `pid`
  commands (L4). Imports are commands too (`import_dexpi` takes the XML text), so they replay from history (L8).
  Exports are read-only commands returning `data.text`; the CLI writes it with `--save` (AF-12).
- **No kernel** (L9): P&ID geometry is 2D sheet geometry computed in the plugin; `requiresKernel` is false for all
  commands. `check_pid_3d` reads 3D *data* (`building.elements`, later 02 / 03 items), not meshes.
- **2D view = presentation** (L7): P&ID sheets render in the 2D viewport and to SVG from the same model; symbol
  graphics are derived (not stored as entities) so editing data never desynchronises the drawing.
- **Cross-gap seams**: tag registry is plugin-local in the MVP and moves behind 08 DAT's project registry port
  (`TagRegistryPort`) in V1; piping class codes are free strings in the MVP and are validated against 01 PSC pipe
  classes when a class library exists; 3D matching reads 02 RTE lines / inline components and 03 EQP nozzles when
  they exist, and `add_equipment` / `add_pipe_run` before that.

```
src/app/plugins.ts ──installs──> @aec/plant/pid (plugin 'pid', toolset 'pid')
                                     │ uses: @core/model/pid, @core/lib/xmlRead, @core/commands/{schema,types,noop,registry}
                                     │ reads: doc.building (3D equipment / pipes), later 02 RTE / 03 EQP data
packages/core/src/model/pid.ts  ◄── types only; core never imports the plugin
```

## 3. Data model

```ts
// packages/core/src/model/pid.ts (sketch)
export type PidConvention = 'ISA-5.1' | 'ISO-10628-2';
export type PidItemKind =
  | 'equipment' | 'nozzle' | 'line' | 'segment' | 'inline' | 'instrument' | 'loop'
  | 'signal' | 'actuating' | 'opc' | 'annotation';

export interface PidModel {
  readonly version: 1;
  convention: PidConvention;
  /** e.g. "{dn}-{fluid}-{seq}-{class}"; tokens: dn, fluid, seq, class, area, unit. */
  lineNumberFormat: string;
  /** Tag formats per kind: regex source + separator used when composing. */
  tagFormats: Readonly<Partial<Record<'equipment' | 'instrument' | 'valve', { pattern: string; separator: string }>>>;
  sheets: Record<string, PidSheet>;
  sheetOrder: string[];
  items: Record<string, PidItem>;        // keyed by step-scoped id `pid-<step>.<k>` (L8)
  itemOrder: string[];
  /** Full tag (normalised) -> item id; rebuilt by the plugin, validated on load. */
  tagIndex: Record<string, string>;
  /** Accepted findings: findingKey -> who / why (human gate when severity is error). */
  acceptances?: Record<string, { reason: string; by: string; at: string }>;
  /** Provenance of an import: format, version, sha256 of the source text, warnings. */
  imports?: PidImportRecord[];
  counters: Record<string, number>;
}

export interface PidSheet {
  readonly id: string;
  number: string;              // "PID-001"
  title: string;
  paper: 'A0' | 'A1' | 'A2' | 'A3' | 'A4';
  revision: string;            // "A", "0", …
  status: 'draft' | 'issued_for_review' | 'issued_for_hazop' | 'issued_for_construction';
  /** Set only by a human-gated issue (AF-34). */
  issuedBy?: { signer: string; at: string };
}

interface PidItemBase {
  readonly id: string;
  readonly kind: PidItemKind;
  sheetId: string;
  /** Sheet position, mm; rotation degrees CCW. */
  at: Vec2;
  rotationDeg: number;
  /** DEXPI class name, e.g. "CentrifugalPump", "GlobeValve"; "Custom" when unmapped. */
  dexpiClass: string;
  /** RDL URI kept verbatim from import / mapping. */
  classUri?: string;
  tag?: string;                // full tag, e.g. "P-101", "FIC-101", "HV-102"
  /** Attribute values with units; `defaulted`/`unverified` flags per value (AF-31/32). */
  attributes: Record<string, PidValue>;
  /** Unknown DEXPI attributes / custom attributes, round-tripped verbatim. */
  passthrough?: Record<string, string>;
  /** Source-file ID when imported (for round trip and diagnostics). */
  sourceId?: string;
}
export type PidValue =
  | { kind: 'text'; value: string; defaulted?: true; unverified?: true }
  | { kind: 'quantity'; value: number; unit: string; defaulted?: true; unverified?: true }
  | { kind: 'enum'; value: string; uri?: string };

export interface PidEquipment extends PidItemBase { kind: 'equipment'; parentId?: string /* sub-equipment */ }
export interface PidNozzle extends PidItemBase { kind: 'nozzle'; equipmentId: string; subTag: string; dn?: number; access?: boolean; port: Vec2 }
export interface PidLine extends PidItemBase {
  kind: 'line';                // DEXPI PipingNetworkSystem
  lineNumber?: string; dn?: number; pipingClass?: string; fluidCode?: string;
  segmentIds: string[];        // ordered as authored / imported
}
export type PidEndpoint =
  | { type: 'nozzle'; itemId: string }
  | { type: 'inline'; itemId: string; node: number }      // node = zero-based port index (DEXPI FromNode/ToNode)
  | { type: 'branch'; segmentId: string; at: Vec2 }        // tee on another segment
  | { type: 'opc'; itemId: string }
  | { type: 'free'; at: Vec2 }
  | { type: 'instrument'; itemId: string };               // information flows only
export interface PidSegment extends PidItemBase {
  kind: 'segment';             // DEXPI PipingNetworkSegment
  lineId: string; from: PidEndpoint; to: PidEndpoint;
  route: Vec2[];               // centre line, mm, includes both ends
  /** Inline items in flow order; segment splitting keeps this list empty, see §5.3. */
  flow: 'forward' | 'reverse' | 'none';
  dn?: number; pipingClass?: string; primary: boolean;
}
export interface PidInline extends PidItemBase { kind: 'inline'; ports: Vec2[]; dn?: number; pipingClass?: string; reversed?: boolean; operated?: boolean }
export interface PidInstrument extends PidItemBase {
  kind: 'instrument';          // DEXPI ProcessInstrumentationFunction
  category: string; functions: string; loopNumber: string;
  location: 'field' | 'central' | 'local_panel' | 'auxiliary';
  display: 'discrete' | 'shared' | 'plc' | 'software';
  loopId?: string;
}
export interface PidSignal extends PidItemBase { kind: 'signal'; signalKind: 'measuring' | 'electric' | 'pneumatic' | 'software' | 'capillary'; from: PidEndpoint; to: PidEndpoint; route: Vec2[] }
export interface PidActuating extends PidItemBase { kind: 'actuating'; valveId: string; actuator: 'diaphragm' | 'piston' | 'motor' | 'solenoid' | 'hydraulic' | 'general'; failAction?: 'FC' | 'FO' | 'FL' | 'FAI'; controllerId?: string }
export interface PidOffPage extends PidItemBase { kind: 'opc'; direction: 'in' | 'out'; pairKey: string; targetSheet?: string }
export type PidItem = PidEquipment | PidNozzle | PidLine | PidSegment | PidInline | PidInstrument | PidSignal | PidActuating | PidOffPage | (PidItemBase & { kind: 'loop' | 'annotation' });
```

Rules: units of every sheet coordinate are millimetres (DEXPI `Units="mm"`); DN is the integer nominal size, the
textual representation ("DN 80", "3\"") is kept in `attributes.nominalDiameterText`; inline items are separate
items between two segments (DEXPI 2.0 models items and `Pipe`s inside a segment; llull normalises to
"segment between two items" and rebuilds DEXPI segments on export, §6.3). Document migration: new optional field,
`version: 1`; no existing data changes.

## 4. Commands

All in plugin `pid`, toolset `pid`. Mutating commands append a feature step (L8); queries set
`annotations: { readOnly: true }` and return `data` (AF-10). Ids are step-scoped; tags are the user-facing handle
and every `tag` / `line` param also accepts an item id or a `$alias`.

### 4.1 Authoring (mutating)

| Command | Params sketch | Tags |
| --- | --- | --- |
| `create_pid_sheet` | `{ number, title?, paper?='A1', convention?='ISA-5.1', lineNumberFormat? }` | @affects creates sheet (+ `doc.pid` on first use) · @invariant sheet numbers unique · @failure duplicate number → `PID_SHEET_DUPLICATE` |
| `add_pid_equipment` | `{ sheet, class, tag, at:[x,y] mm, rotationDeg?, attributes?: Record<string,{value,unit}\|string>, nozzles?: [{ subTag, side:'left'\|'right'\|'top'\|'bottom'\|[dx,dy], dn?, access? }] }` | @affects creates equipment + nozzles · @invariant tag unique; nozzle sub-tags unique per equipment · @failure unknown class → `PID_CLASS_UNKNOWN` (lists close names); duplicate → `PID_TAG_DUPLICATE` |
| `add_pid_nozzle` | `{ equipment, subTag, side \| at, dn?, access? }` | @affects 1 nozzle · @failure equipment not found → `PID_ITEM_NOT_FOUND` |
| `add_pid_line` | `{ sheet, from: Endpoint, to: Endpoint, via?: Vec2[], lineNumber?, dn?, pipingClass?, fluidCode?, flow?='forward', insulation? }`, Endpoint = `{tag,nozzle}` \| `{line,at}` \| `{opc,targetSheet?}` \| `{free:[x,y]}` | @affects creates line + 1 segment (+ tee on a branch, + OPC) · @invariant a nozzle has ≤ 1 segment; orthogonal auto-route when `via` absent · @failure occupied nozzle → `PID_NOZZLE_OCCUPIED`; bad endpoint → `PID_LINE_ENDPOINT_INVALID`; lineNumber taken by another line → `PID_LINE_NUMBER_DUPLICATE` |
| `add_pid_inline` | `{ line, at:[x,y], class, tag?, dn?, pipingClass?, reversed?, operated?, attributes? }` | @affects splits 1 segment into 2, creates the item · @invariant item lies on the segment within 0.5 mm (snapped); DN / class default from the segment and are marked `defaulted` · @failure point off the line > 5 mm → `PID_POINT_OFF_LINE` |
| `add_pid_instrument` | `{ sheet, tag \| {category, functions, loop}, at, location, display?, measures?: {line,at}\|{tag,nozzle}, loop? }` | @affects instrument (+ loop, + measuring line) · @invariant tag parsed and stored split (category / functions / loop) · @failure unparseable without `{category…}` → `PID_TAG_FORMAT` |
| `add_pid_signal_line` | `{ from, to, kind, via? }` | @affects 1 information flow · @failure endpoint not an instrument / actuator → `PID_LINE_ENDPOINT_INVALID` |
| `add_pid_actuating_system` | `{ valve, actuator, failAction?, controller?, tag? }` | @affects actuating system + actuator symbol on the valve · @invariant one per valve · @failure valve not an inline valve → `PID_ITEM_KIND` |
| `add_pid_off_page_connector` | `{ line, end:'start'\|'end', pairKey, targetSheet? }` | @affects 1 OPC on a free line end |
| `update_pid_item` | `{ item, set: { tag?, attributes?, dn?, pipingClass?, fluidCode?, lineNumber?, at?, rotationDeg? } }` | @affects 1 item (moving equipment moves nozzle ports; attached segments re-route their end legs) |
| `delete_pid_item` | `{ item, heal?=true }` | @affects removes item (+ owned nozzles, + segments that lose both ends); deleting an inline item with `heal` merges its two segments |
| `reverse_pid_flow` | `{ line \| segment }` | @affects flips `flow` on the segment(s) |
| `renumber_pid_lines` | `{ format?, startSeq?=1, scope? }` | @affects line numbers per template, deterministic order (sheet, then y, then x) |
| `set_pid_conventions` | `{ convention?, lineNumberFormat?, tagFormats? }` | @affects `PidModel` settings |
| `define_pid_symbol` (V1) | `{ name, class, fromEntities: id[], ports: Vec2[] }` | @affects project symbol (graphics copied from 2D entities, normalised to its insertion point) |
| `link_pid_item` | `{ pidItem, element: string \| null }` | @affects records (or clears) an explicit P&ID ↔ 3D pair used by `check_pid_3d` before tag matching · @failure unknown element → `PID_ITEM_NOT_FOUND` |
| `accept_pid_finding` | `{ findingKey, reason, confirmation? }` | @affects records an acceptance; error-severity findings need a human signature (`humanGate`, AF-34) |
| `issue_pid_sheet` | `{ sheet, status, revision, confirmation }` | @affects sheet status; `issued_for_construction` is human-gated (`PID_HUMAN_GATE`) |
| `import_dexpi` | `{ text, version?:'auto'\|'1.2'\|'1.3'\|'1.4'\|'2.0', sheet? }` | @affects creates sheet(s) + items, records an import with sha256 · @invariant all-or-nothing on parse errors · @failure malformed → `DEXPI_PARSE_ERROR`; unknown root → `DEXPI_VERSION_UNSUPPORTED` |
| `place_from_pid` (V1) | `{ items?, level? }` | @affects calls 03 EQP / 02 RTE commands via `ctx.registry` to create placeholders (composition through `execute`, L10) |

### 4.2 Queries (read-only)

| Command | Params sketch | Returns `data` |
| --- | --- | --- |
| `check_pid` | `{ sheet?, rules?: string[], includeAccepted?=false }` | `CheckResult` (`check: 'pid'`): `items[{ code, status, ids, tags, sheet, findingKey, remediation, values }]`, `countsByCode`, `summary { errors, warnings, infos, reviewRequired }` |
| `check_pid_3d` | `{ scope?: 'all'\|'equipment'\|'lines'\|'inline', normaliseTags?=true }` | `CheckResult` (`check: 'pid_3d'`) + `matched { equipment[], lines[], inline[] }`, `unmatchedPid[]`, `unmatched3d[]` |
| `pid_report` | `{ kind: 'counts'\|'line_list'\|'valve_list'\|'instrument_index'\|'equipment_list'\|'nozzle_list'\|'connectivity', sheet?, filter? }` | `{ kind, columns, rows, csv }` (counts: the census keys of `validation/data/dexpi_census.json`) |
| `parse_instrument_tag` | `{ tag, convention?='ISA-5.1' }` | `{ ok, firstLetter{letter,meaning}, modifier?, functions[{letter,role,meaning}], functionModifiers[], loop, suffix?, convention, grade, warnings[] }` |
| `describe_pid_item` | `{ item }` | item data, upstream / downstream items, line, loop, findings |
| `list_pid_symbols` | `{ convention?, class? }` | `[ { class, name, ports, convention, source } ]` |
| `export_dexpi` | `{ version: '1.3'\|'1.4'\|'2.0', sheets? }` | `{ text, version, sha256, counts, warnings }` (CLI `--save`) |
| `export_pid_svg` | `{ sheet, scale? }` | `{ svg, widthMm, heightMm }` (title block from `sheetFrame.ts`) |

Descriptions follow AF-02 (what, when, units — "sheet millimetres", "DN integer" — what it refuses, what to call
next). `import_dexpi` is added to `FILE_PARAMS` in `server/src/cli/exchange.ts` (`text`, utf8) so
`llull import_dexpi file=pid.xml` works; it stays a registry command.

## 5. Algorithms

### 5.1 Tag grammar (`parse_instrument_tag`)

Normalise: trim, map Unicode superscript `⁺` to `+`, collapse spaces. Default instrument pattern:

```
tag      := letters sep loop suffix?
letters  := FIRST FMOD? SUCC*            (FIRST, FMOD, SUCC from data/isa51_letters.json)
sep      := "-" | " " | ""                (configurable)
loop     := [0-9]+ ( "." [0-9]+ )?        (DEXPI examples use "4712.01")
suffix   := [A-Z]                         (parallel devices: FV-101A)
```

`FMOD` is taken only when the second letter is a first-letter modifier of the first letter's column (D, F, J, K, Q,
S, X, Y, Z) **and** the remaining letters still parse; otherwise it is a succeeding letter (ambiguity resolved by the
longest valid parse, left to right, reported in `warnings`). Succeeding `H`, `L`, `M` after `A` or `S` are
modifiers (alarm / switch high, low). Results: `ok: false` with `PID_TAG_FORMAT` when the shape fails,
`PID_TAG_NONSTANDARD` when characters outside the table occur (C02 `IS+Z+A`), info `PID_TAG_USER_LETTER` for C, D,
G, M, N, O first letters. Letters with grade B are returned with `grade: 'B'` and `unverified: true` (AF-32). The
parser never claims a convention it did not use (`convention: 'ISA-5.1'`); DEXPI's own category / functions fields
are kept verbatim because DEXPI does not restrict them (S3 §9.23.9).

### 5.2 Connectivity graph

Nodes: nozzles, inline items (one node per port), branch points, OPCs, free ends, instruments, actuators. Edges:
segments (process) and information flows (signal). Built on demand from `items` (pure, memoised by item-map
identity). Upstream / downstream follow `flow`. Invariants checked on every mutation: a nozzle port has ≤ 1 segment;
an inline port has ≤ 1 segment; a segment's `route[0]` / `route[n-1]` coincide (≤ 0.5 mm) with its endpoint
positions.

### 5.3 Inline insertion and healing

Given segment `s` with route `R` and point `p`: find the route leg with minimum distance d(p, leg); refuse when
d > 5 mm; snap `p` to the leg. Split `R` at `p` into `R1 = R[0..k] + p - g·u` and `R2 = p + g·u + R[k+1..]`, where
`u` is the leg direction and `g` half the symbol length (ports at ±g·u). New segments inherit `lineId`, `dn`,
`pipingClass`, `flow`, `primary`; the item's `dn` / `pipingClass` default to the segment's and are flagged
`defaulted`. Healing (delete with `heal`) concatenates `R1` and `R2` through `p` and removes the colinear point,
restoring `R` exactly when the item was inserted on a leg interior (VC-PID-13, 1e-9 mm). A reversed check valve
sets `reversed: true`, which the flow rule compares to the segment flow.

### 5.4 Flow direction

`flow` is per segment. An inline item passes flow port 0 → port 1. A conflict is: (a) at a two-port inline item or
a nozzle-free junction, the two adjacent segments are both `forward` into it or both out of it; (b) a check valve
whose `reversed` disagrees with its segment flow. Branches (tees) are checked for "all in" or "all out" only.

### 5.5 `check_pid` rules

| Code | Severity | Rule (formal) |
| --- | --- | --- |
| `PID_LINE_NON_TERMINATING` | error | a segment endpoint of type `free` that is not marked as an end-of-line (vent / drain / blind / sample) |
| `PID_COMPONENT_UNCONNECTED` | error | an inline item port with no segment |
| `PID_NOZZLE_UNCONNECTED` | warn | a nozzle with no segment and `access !== true` |
| `PID_NOZZLE_UNCONNECTED_ACCESS` | info | the same for access nozzles (manholes): C01 T4750/N8 |
| `PID_EQUIPMENT_UNCONNECTED` | error | a tank / vessel class (Tank, PressureVessel, ProcessColumn, …) with no connected nozzle |
| `PID_SIZE_MISMATCH` | error | inline `dn` ≠ segment `dn` on either side (no reducer item between) |
| `PID_SPEC_MISMATCH` | error | inline `pipingClass` ≠ segment `pipingClass` and no spec-break item at that point |
| `PID_FLOW_DIRECTION_CONFLICT` | error | §5.4 |
| `PID_OPC_UNRESOLVED` | error | an OPC whose `pairKey` has no partner of opposite direction on another sheet |
| `PID_TAG_DUPLICATE` | error | two items with the same normalised full tag (imported data; authoring refuses) |
| `PID_SEGMENT_INVALID` | error | a segment whose items do not form one chain from source to target, or a node referenced twice (pyDEXPI validity codes, S4) |
| `PID_CONTROL_VALVE_NO_ACTUATOR` | warn | `operated` inline valve with no actuating system, or an actuating system without `controllerId` |
| `PID_SAFETY_VALVE_NO_SET_PRESSURE` | warn, `reviewRequired` | a safety / relief valve class without `setPressureHigh` |
| `PID_LINE_NUMBER_MISSING` | warn | a line without `lineNumber` |
| `PID_INSTRUMENT_UNCONNECTED` | warn | an instrument with no measuring line, signal line or loop |
| `PID_TAG_NONSTANDARD` | info | instrument letters that do not parse with the project convention |

Each item carries `findingKey = 'pid:' + code + ':' + sorted ids` (stable, AF-13) and a remediation, e.g.
"connect T-101/N2 with add_pid_line or mark it spare with update_pid_item set.attributes.spare=true".

### 5.6 P&ID ↔ 3D consistency (`check_pid_3d`)

1. **Collect** P&ID tagged items (equipment, lines by line number, inline items with tags) and 3D items: today
   `EquipmentElement.mark`, `PipeElement.line` (+ `dn`, `from`, `to`); from 02 RTE / 03 EQP: line, class, inline
   component tags, nozzle sub-tags.
2. **Normalise** tags: upper case, strip spaces / `-` / `_` when `normaliseTags` (rule reported in `provenance`).
   Explicit pairs from `link_pid_item` win over tag matching. Two candidates for one tag → `P3D_TAG_AMBIGUOUS`.
3. **Compare** each matched pair:

| Code | Condition |
| --- | --- |
| `P3D_UNPLACED` | P&ID item with no 3D match |
| `P3D_NOT_IN_PID` | 3D item with a tag / line number and no P&ID match |
| `P3D_SIZE_MISMATCH` | line: set of P&ID segment DNs ≠ set of 3D run DNs; inline: DN differs |
| `P3D_SPEC_MISMATCH` | P&ID piping class ≠ 3D class (needs 02 RTE) |
| `P3D_CONNECTIVITY_MISMATCH` | the unordered pair {from, to} of equipment tags (+ nozzle sub-tags when 3D has them) differs |
| `P3D_CLASS_MISMATCH` | inline / equipment DEXPI class ≠ 3D component class (mapping table, needs 01 PSC catalogue classes) |
| `P3D_INLINE_ORDER_MISMATCH` | the sequence of inline tags along a line differs; reported with the longest common subsequence and the out-of-place tags |

The result is drawing / model consistency only: `reviewRequired: false` (no safety verdict), status `fail` on any
mismatch so an agent cannot miss it.

### 5.7 Lists

| Kind | Columns (CSV header, fixed order) |
| --- | --- |
| `line_list` | lineNumber, sheet, dn, pipingClass, fluidCode, from, to, segments, insulation, inlineTags |
| `valve_list` | tag, class, lineNumber, dn, pipingClass, actuated, failAction, sheet |
| `instrument_index` | tag, category, functions, loop, location, display, measuredLine, controls, sheet |
| `equipment_list` | tag, class, nozzles, designPressure, designTemperature, sheet |
| `nozzle_list` | equipmentTag, subTag, dn, connectedLine, access |
| `counts` | the census keys and counting rules of `validation/data/dexpi_census.json` |
| `connectivity` | from, fromType, to, toType, via (segment / information flow), lineNumber |

Rows are sorted by tag (natural sort), ties by id, for determinism (AF-13). `from` / `to` in the line list are
`equipmentTag/nozzleSubTag`, `OPC:<pairKey>` or `free`.

## 6. Interop and persistence

### 6.1 DEXPI 1.2 / 1.3 / 1.4 (Proteus XML)

Root `<PlantModel>`, `<PlantInformation SchemaVersion Units …>` (C01: `SchemaVersion="4.1.1"`,
`ApplicationVersion="1.3.1"`); DEXPI 1.4 uses Proteus 4.2.0 (S3 §3). Mapping (S3 §3, §8.54):

| Proteus | llull |
| --- | --- |
| `<Equipment ComponentClass=…>` (top level, nested = sub-equipment) | `PidEquipment` (`parentId` for nested) |
| `<Nozzle>` inside equipment | `PidNozzle` (`SubTagNameAssignmentClass` → `subTag`; DN from `<Node>` generic attributes) |
| `<PipingNetworkSystem>` | `PidLine` (`LineNumberAssignmentClass`, `FluidCodeAssignmentClass`, `NominalDiameter*`, `PipingClassCodeAssignmentClass`) |
| `<PipingNetworkSegment>` with ordered children `<PipingComponent>`, `<CenterLine>`, `<PipeOffPageConnector>`, `<PipeFlowArrow>`, `<Connection FromID FromNode ToID ToNode>` | one or more `PidSegment`s split at each component + `PidInline` per component; `FromNode` / `ToNode` are zero-based indices into the owner's `<ConnectionPoints>` `<Node>` list |
| `<ProcessInstrumentationFunction>` (+ `ProcessInstrumentationFunctionCategory/Functions/Number`) | `PidInstrument` |
| `<InstrumentationLoopFunction>` | loop item; members by `<Association>` |
| `<InformationFlow ComponentClass=MeasuringLineFunction / SignalConveyingFunction / SignalLineFunction>` | `PidSignal` |
| `<ActuatingSystem>` (`ControlledActuator`, `OperatedValveReference`) | `PidActuating` |
| `<GenericAttributes Set="DexpiAttributes">` | `attributes` (typed by `Format`, unit from `Units` attribute); other sets → `passthrough` |
| `<Label>`, `<Text>`, `<Position>`, `<ShapeCatalogue>` | label positions kept for round trip; catalogue shapes mapped to built-in symbols by `ComponentName`, unknown shapes kept as passthrough geometry |

Null vs absent (S3 §2): an attribute present with empty value imports as `null` and is exported again as present /
empty; an absent attribute stays absent.

### 6.2 DEXPI 2.0 XML

Root `<Model>` with `<Import prefix="Core" source=".../2.0.1/Core.xml"/>` and `Plant`; content is `<Object type="Plant/…">`
with `<Data property>` (typed children `String`, `Double`, `Integer`, `Boolean`, `DataReference`,
`AggregatedDataValue`), `<Components property>` (composition) and `<References property objects="#id …">`
(S2 `metamodel_and_exchange_format.rst`). Mapping by type: `Plant/ProcessEquipment.*` → equipment (nozzle types
`ProcessNozzle`, `AccessNozzle`, `InstrumentNozzle` → `PidNozzle`, `access: true` for `AccessNozzle`),
`Plant/Piping.PipingNetworkSystem` / `PipingNetworkSegment` / valve and fitting types, `Plant/Instrumentation.*`,
`Core/Diagram.*` → presentation. The model files referenced by `Import` are **not fetched** (offline, AF-41): the
mapper carries the class list it needs as data, generated once from the published model and pinned by version.

### 6.3 Export

`export_dexpi` builds the target tree from `PidModel` deterministically: items in `itemOrder`, IDs = `sourceId` when
present else `<Class>-<n>` numbered per class in order, numbers printed with the shortest round-trip decimal,
attributes in a fixed order (DEXPI order of the spec tables, then passthrough sorted by name), two-space indentation,
LF line ends. Consequences: export → import → export is byte-identical (VC-PID-06). DEXPI segments are rebuilt by
walking each line's segment chain and folding inline items back into one `PipingNetworkSegment` between branch points
/ nozzles / OPCs. 2.0 output must validate against `DEXPI_XML_Schema.xsd` (VC-PID-07); a test-only validator runs
`xmllint` when present, otherwise a structural check of the XSD's element / attribute rules.

### 6.4 Other formats

- SVG / PNG through `export_pid_svg` and the existing sheet frame; DXF export of P&ID sheets in V1 (layers per kind:
  `PID-EQPT`, `PID-PIPE`, `PID-INST`, `PID-SIGN`, `PID-TEXT`).
- Lists as CSV in `data.csv` (RFC 4180, header row, UTF-8).
- Persistence: `doc.pid` saved with the document; `DocumentExtension.validate` checks referential integrity (every
  endpoint id exists, tag index matches items) and refuses a corrupt file.

## 7. CLI / MCP / UI surfaces and error codes

- CLI: every command above via `llull <command>`; `import_dexpi file=` (FILE_PARAMS); `export_dexpi … --save`,
  `pid_report kind=line_list --save lines.csv`, `export_pid_svg … --save`; `llull guide` gains a P&ID section (AF-03):
  sheet mm, DN integers, tag grammar, the minimal plan (sheet → equipment with nozzles → line → inline → instrument →
  check).
- MCP: toolset `pid` (new entry in `packages/mcp/src/toolsets.ts`, contributed by the plugin like `building`); the
  prompt for the toolset carries the same guide text.
- UI: 2D viewport branch for P&ID sheets (symbols from `symbols/` data, selection by item id), findings panel,
  lists as tables, *Issue* button calling `issue_pid_sheet` with a desktop signature.

| Code | Raised by | Meaning | Remediation |
| --- | --- | --- | --- |
| `PID_SHEET_DUPLICATE` | `create_pid_sheet` | sheet number exists | choose another number |
| `PID_SHEET_NOT_FOUND` | authoring | unknown sheet | `create_pid_sheet` first |
| `PID_CLASS_UNKNOWN` | `add_pid_equipment`, `add_pid_inline` | class not in the library | use `list_pid_symbols`; close names listed |
| `PID_ITEM_NOT_FOUND` | all | tag / id / alias unknown | check `pid_report kind=…` |
| `PID_ITEM_KIND` | authoring | item of the wrong kind (e.g. actuator on a fitting) | pass a valve |
| `PID_TAG_DUPLICATE` | authoring, `check_pid` | tag already used | pick a new loop / sequence number |
| `PID_TAG_FORMAT` | `parse_instrument_tag`, `add_pid_instrument` | tag does not match the grammar | give `{category, functions, loop}` |
| `PID_TAG_NONSTANDARD` | parser, check (info) | letters outside the convention | keep, or set the project convention |
| `PID_TAG_USER_LETTER` | parser (info) | user's-choice first letter | define it in the project legend |
| `PID_NOZZLE_OCCUPIED` | `add_pid_line` | nozzle already has a line | branch from the line instead |
| `PID_LINE_ENDPOINT_INVALID` | `add_pid_line`, `add_pid_signal_line` | endpoint cannot take this connection | see allowed endpoints |
| `PID_LINE_NUMBER_DUPLICATE` | `add_pid_line`, `update_pid_item` | line number used by another line | `renumber_pid_lines` |
| `PID_POINT_OFF_LINE` | `add_pid_inline` | point > 5 mm from the line | pick a point on the line |
| `PID_LINE_NON_TERMINATING`, `PID_COMPONENT_UNCONNECTED`, `PID_NOZZLE_UNCONNECTED`, `PID_NOZZLE_UNCONNECTED_ACCESS`, `PID_EQUIPMENT_UNCONNECTED`, `PID_SIZE_MISMATCH`, `PID_SPEC_MISMATCH`, `PID_FLOW_DIRECTION_CONFLICT`, `PID_OPC_UNRESOLVED`, `PID_SEGMENT_INVALID`, `PID_CONTROL_VALVE_NO_ACTUATOR`, `PID_SAFETY_VALVE_NO_SET_PRESSURE`, `PID_LINE_NUMBER_MISSING`, `PID_INSTRUMENT_UNCONNECTED` | `check_pid` | §5.5 | per finding |
| `PID_HUMAN_GATE` | `issue_pid_sheet`, `accept_pid_finding` | act needs a human signature | ask the owner / reviewer in the desktop app |
| `DEXPI_PARSE_ERROR` | `import_dexpi` | not well-formed XML (line / column in `paths`) | fix or re-export the file |
| `DEXPI_VERSION_UNSUPPORTED` | `import_dexpi`, `export_dexpi` | root / schema version not handled | export 1.3 / 1.4 / 2.0 from the source tool |
| `DEXPI_DANGLING_REFERENCE` | `import_dexpi` (warn) | `FromID` / `ToID` / `#id` names no object | ends imported as `free`; check the source |
| `DEXPI_UNMAPPED_CLASS` | `import_dexpi` (warn) | class without a llull mapping | imported as `Custom` with class URI kept |
| `DEXPI_GRAPHICS_DROPPED` | `import_dexpi` (info) | presentation element not reproduced | data intact; drawing simplified |
| `DEXPI_ATTRIBUTE_UNIT` | `import_dexpi` (warn) | value with a unit llull does not know | kept as text, flagged `unverified` |
| `P3D_UNPLACED`, `P3D_NOT_IN_PID`, `P3D_SIZE_MISMATCH`, `P3D_SPEC_MISMATCH`, `P3D_CONNECTIVITY_MISMATCH`, `P3D_CLASS_MISMATCH`, `P3D_INLINE_ORDER_MISMATCH`, `P3D_TAG_AMBIGUOUS` | `check_pid_3d` | §5.6 | place / correct the 3D item or the P&ID, or `link_pid_item` |

## 8. Performance and robustness budgets

| Operation | Budget | Note |
| --- | --- | --- |
| `xmlRead` of C01 (446 KB) | ≤ 150 ms | single pass, no regex backtracking |
| `import_dexpi` C01 / `reference_pid.xml` (1.48 MB) | ≤ 1.0 s / ≤ 2.0 s | VC-PID-17 |
| `check_pid` 5 000 items | ≤ 1.0 s | graph built once, O(n log n) |
| `check_pid_3d` 2 000 tags each side | ≤ 0.5 s | hash join on normalised tags |
| `export_dexpi` C01 | ≤ 0.5 s | |
| Import size limit | 50 MB text | above → `DEXPI_PARSE_ERROR` with "too large", no partial document |
| Nesting depth | 256 | deeper → parse error (hostile input) |

Robustness: no external entity resolution, no DTD processing (XXE-safe by construction); IDs that collide with
JavaScript property names are rejected (`CMD_RESERVED_ID` pattern); every import is all-or-nothing.

## 9. Test strategy

| Layer | Test | VC |
| --- | --- | --- |
| lib | `tests/unit/lib/xmlRead.test.ts`: entities, CDATA, comments, attributes with quotes, malformed inputs, depth limit | VC-PID-15 |
| unit | `tests/unit/plant/pid/dexpiImport.test.ts` table-driven over `validation/data/dexpi13/*.xml` against `dexpi_census.json` | VC-PID-01, 03, 04, 05, 16 |
| unit | `dexpiImport20.test.ts` on `reference_pid.xml`; cross-encoding equality with C01 | VC-PID-02 |
| unit | `dexpiRoundTrip.test.ts`: 1.3 and 2.0 export, re-import, census equality, byte-identical second export, XSD check | VC-PID-06, 07 |
| unit | `tagParse.test.ts` over `tag_parse_cases.json` | VC-PID-08 |
| unit | `checkPid.test.ts`: one fixture per rule (happy + failure), C01 baseline | VC-PID-09, 10 |
| unit | `checkPid3d.test.ts`: seeded mismatches over `add_equipment` / `add_pipe_run` | VC-PID-11 |
| unit | `reports.test.ts`: list rows / CSV headers on C01 | VC-PID-12 |
| unit | `inlineSplit.test.ts`: split / heal geometry and attributes; `is pure` test for every mutating command | VC-PID-13 |
| golden | `tests/golden/pid-*.json`: SC-PID-02 and SC-PID-03 plans, id-normalised snapshot + replay equality | VC-PID-10, 11, 14 |
| contract | `toToolSchemas()` snapshot gains the `pid` commands; toolset `pid` lists them | AF-01 |
| server | `server/tests/packReplay04.test.ts`: CLI scripts of SC-PID-01 and SC-PID-04 (`file=`, `--save`, `--json`) | VC-PID-01, 06, 07 |
| perf | `tests/perf/pid.bench.ts` (not in `check`) | VC-PID-17 |

Coverage gate 90/85/90/90 applies to `packages/domain-aec/src/plant/pid/**` (NON-NEGOTIABLE 3).

## 10. Delivery plan

| Milestone | Content | Depends on | Effort |
| --- | --- | --- | --- |
| M1 Model + XML | `model/pid.ts`, `CadDocument.pid`, persistence validation, `xmlRead`, plugin skeleton, toolset | — | 4 d |
| M2 DEXPI import | Proteus 1.3 mapper, census-equal import of 11 files, `pid_report kind=counts / connectivity`, DEXPI codes | M1 | 6 d |
| M3 Authoring + connectivity | sheets, equipment / nozzles, lines, inline split / heal, instruments, signals, actuating systems, OPC, flow | M1 | 8 d |
| M4 Tags + checks + lists | grammar + ISA table, tag registry, `check_pid` (16 rules), five lists, CSV | M3 | 6 d |
| M5 Export + rendering | DEXPI 1.3 export (round trip), symbol library, `export_pid_svg`, 2D viewport branch | M2, M3 | 8 d |
| M6 DEXPI 2.0 | 2.0 import / export, XSD check | M2, M5 | 5 d |
| M7 P&ID ↔ 3D (MVP subset) | `check_pid_3d` on `add_equipment` / `add_pipe_run`, `link_pid_item` | M4 | 3 d |
| V1 | DEXPI 1.4 (Proteus 4.2.0), `check_pid_3d` on 02 RTE / 03 EQP, `place_from_pid`, project symbols, DXF export, human-gated issue | 01 PSC, 02 RTE, 03 EQP, 08 DAT, 09 PLM signing port | 15 d |

MVP total ≈ 40 developer-days, lanes: Core (M1–M4, M6, M7), 2D (M5 rendering), MCP (toolset, CLI `file=`).

## 11. Open questions

1. XML parser: in-house `@lib/xmlRead` (proposed) or a dependency such as `fast-xml-parser` (stack change needs the
   owner's approval).
2. One `pid` toolset, or a shared `plant` toolset with 02 / 03 / 08? Proposed: `pid` now, merged by 08 DAT if a
   plant-wide toolset is introduced.
3. Default convention for new projects: ISA 5.1 bubbles with ISO 10628-2-style equipment / valve symbols (common in
   European EPC practice), or one family per project?
4. Tag uniqueness scope: document (MVP) vs project registry across documents (08 DAT).
5. Proteus 4.2.0 XSD (S15) could not be fetched; DEXPI 1.4 export is accepted on round-trip equality until it is
   available.
6. Should imported DEXPI presentation (exact symbol graphics from `ShapeCatalogue`) be rendered verbatim, or always
   replaced by llull symbols? Proposed: llull symbols by default, verbatim as an option (licence: DEXPI files CC BY).

## 12. Agent-first mapping

| AF | Where |
| --- | --- |
| AF-01, AF-02, AF-04 | all commands registry-defined, units in descriptions (sheet mm, DN integer, pressures `{value, unit}`) |
| AF-03 | `llull guide` P&ID section (§7) |
| AF-05 | SC-PID-02 / 03 plans validate with `--validate` (VC-PID-14) |
| AF-10, AF-12, AF-13 | `data` shapes §4.2, CSV via `--save`, deterministic ids / sort / export (§5.7, §6.3) |
| AF-11 | error table §7 (FR-PID-26, FR-PID-41) |
| AF-20, AF-21 | `check_pid`, `check_pid_3d`; connectivity as data instead of a picture (FR-PID-11) |
| AF-22 | `export_pid_svg` → PNG (FR-PID-62) |
| AF-31, AF-32 | `defaulted` / `unverified` on values; grade-B ISA letters flagged (TR-PID-12) |
| AF-33, AF-34 | `reviewRequired` on safety items; `issue_pid_sheet` / `accept_pid_finding` human-gated (FR-PID-70/71) |
| AF-35 | `provenance` in check results (rule set, tag normalisation, import sha256) |
| AF-41 | no network: DEXPI model imports not fetched; ISA / symbol data shipped |

TR ids used by `validation/expected_results.json`: TR-PID-05 connectivity graph (§5.2), TR-PID-07 symbol library,
TR-PID-08 Proteus import mapper (§6.1), TR-PID-09 DEXPI 2.0 mapper (§6.2), TR-PID-10 deterministic export (§6.3),
TR-PID-11 robust import (§8), TR-PID-12 tag grammar (§5.1), TR-PID-14 `check_pid` rules (§5.5), TR-PID-16
`check_pid_3d` (§5.6), TR-PID-20 performance budgets (§8).

## 13. References

- [R1] DEXPI e.V., TrainingTestCases — https://gitlab.com/dexpi/TrainingTestCases (CC BY 4.0, accessed 2026-10)
- [R2] DEXPI e.V., Specification repository (2.0.1 `reference_pid.xml`, `DEXPI_XML_Schema.xsd`, `metamodel_and_exchange_format.rst`, changelog) — https://gitlab.com/dexpi/Specification (accessed 2026-10)
- [R3] DEXPI P&ID Specification 1.4, §2 (null / absent), §3 (Proteus 4.2.0 mapping), §8.54 (PipingNetworkSegment SourceItem / SourceNode), §9.23 (ProcessInstrumentationFunction) — https://gitlab.com/dexpi/Specification/-/releases (CC BY 4.0, accessed 2026-10)
- [R4] pyDEXPI 1.2.0, `toolkits/piping_toolkit.py` validity codes and integration tests — https://pypi.org/project/pydexpi/1.2.0/ (AGPL-3.0, accessed 2026-10)
- [R5] Engineering ToolBox, ISA codes — https://www.engineeringtoolbox.com/isa-intrumentation-codes-d_415.html (accessed 2026-10, extract)
- [R6] ISA 5.1 letter tables (instrumentationblog.in, tagsight.io, pathnovo.com, mechcodex.com) (accessed 2026-10, extracts)
- [R8] Autodesk Plant 3D Help, P&ID Validation Error Reference / Validation Settings — https://help.autodesk.com/view/PLNT3D/2022/ENU/?guid=GUID-DF42724D-EB2E-497F-8A33-0E8C42C3D279 (accessed 2026-10, extracts)
- [R9] Autodesk Plant 3D Help, About Validating P&ID Drawings and Plant 3D Models — https://help.autodesk.com/cloudhelp/2027/ENU/Plant3D-UserGuide/files/GUID-E3FE36AC-BEA3-4C0C-93CE-EC1A93104D23.htm (accessed 2026-10, extracts)
- [R10] ISO 10628-2:2012 catalogue — https://www.iso.org/standard/51841.html (accessed 2026-10)
- [R11] IEC 62424:2016 catalogue — https://webstore.iec.ch/publication/25442 (accessed 2026-10)
- [R12] ANSI/ISA-5.1-2024 product page — https://www.isa.org/products/ansi-isa-5-1-2024-instrumentation-and-control-symb (accessed 2026-10)
- [R13] Autodesk App Store, DEXPI Data Bridge — https://marketplace.autodesk.com/apps/75fd9d89-871a-4ea9-833d-cd172a9a8184 (accessed 2026-10)
- [R15] ProteusXML schema — https://github.com/ProteusXML (not reached, accessed 2026-10)
