# Gap 04 PID — P&ID schematics, DEXPI exchange and P&ID ↔ 3D consistency: technical specification

Status: specification written 2026-10-18; M1 to M4 built (§13). Functional view: [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md).
Validation: [`validation/README.md`](validation/README.md). Laws: `.claude/rules/architecture.md` (L1–L10).

## 1. Current state in llull

| Area | What exists | Path | Limit for P&ID work |
| --- | --- | --- | --- |
| 2D drafting | `draw_polyline`, `draw_arc`, `draw_rectangle`, `draw_point`, `draw_ellipse`, `draw_spline`, `add_text`, `add_dimension`, underlays | `packages/core/src/commands/draw2d/{basic,curves,annotate,underlay}.ts`; kinds in `SHAPE2D_KINDS` (`packages/core/src/model/types.ts`) | graphics only; no connection points, no item data, no symbol semantics |
| Blocks | `create_component`, `insert_instance`, `explode_instance` (`InstanceEntity { componentId, scale }`) | `packages/core/src/commands/assembly/assemblies.ts` | a usable carrier for symbol graphics, but no ports and no attributes |
| Sheets | `create_sheet`, views, `export_sheet_svg` (title block, ISO 128 line types) | `packages/core/src/commands/drawings/*`, `packages/core/src/model/drawing.ts`, `sheet.ts` | sheets show orthographic views of 3D solids, not schematics |
| DXF | `import_dxf` (blocks exploded), `export_building_dxf` (building plans) | `packages/core/src/commands/exchange/importDxf.ts`, `packages/domain-aec/src/building/exchange/dxfExport.ts` | a P&ID in DXF arrives as lines and text, connectivity lost |
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
- **Model types in the plugin, slice `doc.plant.pid`** (plant README D2, decided 2026-10-23): `plant/pid/model.ts` and
  `PlantModel.pid?: PidModel` ("absent until the first P&ID command"), validated by the plugin's `DocumentExtension.validate`
  (L8). ~~`packages/core/src/model/pid.ts` and `CadDocument.pid`~~ (the first draft) is superseded: core gets no P&ID code
  (decision in §13.3).
- **XML reader** `packages/core/src/lib/xmlRead.ts` (`@lib/xmlRead`, **built in M1**, §13.2): a pure parser (elements,
  attributes, namespaces, text, CDATA, comments, processing instructions, the five predefined entities and numeric
  character references, UTF-8 input as a JS string) returning a plain tree. No DOM, no network (L2). The writer side
  reuses `escapeXml`.
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
packages/domain-aec/src/plant/pid/model.ts  ◄── `PidModel`, in `doc.plant.pid` (D2); core never imports the plugin
```

## 3. Data model

```ts
// packages/domain-aec/src/plant/pid/model.ts (sketch; as built in §13.1: readonly fields, no tagIndex)
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
  /** (sketch only, not built: derived from `items`, see §13.3) Full tag (normalised) -> item id. */
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
"segment between two items" and rebuilds DEXPI segments on export, §6.3). Document migration: new optional sub-record of `doc.plant`,
`version: 1`; no existing data changes.

## 4. Commands

All in plugin `pid`, toolset `pid`. Mutating commands append a feature step (L8); queries set
`annotations: { readOnly: true }` and return `data` (AF-10). Ids are step-scoped; tags are the user-facing handle
and every `tag` / `line` param also accepts an item id or a `$alias`.

### 4.1 Authoring (mutating)

| Command | Params sketch | Tags |
| --- | --- | --- |
| `create_pid_sheet` | `{ number, title?, paper?='A1', convention?='ISA-5.1', lineNumberFormat? }` | @affects creates sheet (+ `doc.plant.pid` on first use) · @invariant sheet numbers unique · @failure duplicate number → `PID_SHEET_DUPLICATE` |
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
- Persistence: `doc.plant.pid` saved with the document; `DocumentExtension.validate` checks referential integrity (every
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
| M1 Model + XML | `plant/pid/model.ts`, `doc.plant.pid` (D2), persistence validation, `xmlRead`, plugin skeleton, toolset — **built 2026-10-25 (PID-M1), §13**; no command (none is listed for M1) | — | 4 d |
| M2 DEXPI import | Proteus 1.3 mapper, census-equal import of 11 files, `pid_report kind=counts / connectivity`, DEXPI codes — **built 2026-10-31 (PID-M2), §13.4** | M1 | 6 d |
| M3 Authoring + connectivity | sheets, equipment / nozzles, lines, inline split / heal, instruments, signals, actuating systems, OPC, flow — **built 2026-10-31 (PID-M3), §13.5** | M1 | 8 d |
| M4 Tags + checks + lists | grammar + ISA table, tag registry, `check_pid` (16 rules), five lists, CSV — **built 2026-10-31 (PID-M4), §13.7** | M3 | 6 d |
| M5 Export + rendering | DEXPI 1.3 export (round trip), symbol library, `export_pid_svg`, 2D viewport branch | M2, M3 | 8 d |
| M6 DEXPI 2.0 | 2.0 import / export, XSD check | M2, M5 | 5 d |
| M7 P&ID ↔ 3D (MVP subset) | `check_pid_3d` on `add_equipment` / `add_pipe_run`, `link_pid_item` | M4 | 3 d |
| V1 | DEXPI 1.4 (Proteus 4.2.0), `check_pid_3d` on 02 RTE / 03 EQP, `place_from_pid`, project symbols, DXF export, human-gated issue | 01 PSC, 02 RTE, 03 EQP, 08 DAT, 09 PLM signing port | 15 d |

MVP total ≈ 40 developer-days, lanes: Core (M1–M4, M6, M7), 2D (M5 rendering), MCP (toolset, CLI `file=`).

## 11. Open questions

1. XML parser: in-house `@lib/xmlRead` (proposed) or a dependency such as `fast-xml-parser` (stack change needs the
   owner's approval). **Decided (PID-M1, owner delegated): in-house**, §13.3.
2. One `pid` toolset, or a shared `plant` toolset with 02 / 03 / 08? Proposed: `pid` now, merged by 08 DAT if a
   plant-wide toolset is introduced. **Decided (PID-M1): `pid`**, §13.3 (03 built `plant_equipment`, 06 `plant_structures`, 08 `plant_data`: one toolset per plugin is the plant convention).
3. Default convention for new projects: ISA 5.1 bubbles with ISO 10628-2-style equipment / valve symbols (common in
   European EPC practice), or one family per project?
4. Tag uniqueness scope: document (MVP) vs project registry across documents (08 DAT). **Decided (PID-M1): document**; the tag index is derived, not stored, so it can move behind the 08 DAT registry without a data migration, §13.3.
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

## 13. As built

### 13.1 PID-M1 (2026-10-25): model, XML reader, plugin skeleton

Plugin `pid` (toolset `pid`, installed after `plant-data` in `installDefaultPlugins()`), folder `packages/domain-aec/src/plant/pid/`, slice `doc.plant.pid` (plant README D2). Hosts need only `pidPlugin` from `@aec/index`. **No command is registered in M1**: §10 lists none for it (`import_dexpi` and `pid_report` are M2, authoring M3), and none was invented; the toolset is empty (`TOOLSETS.pid = []`, hidden from `docs/FEATURES.md` until M2) and its `.lld` example `pid.lld` draws the A1 sheet frame with core 2D commands.

| File | Content |
| ---- | ------- |
| `model.ts` | the §3 types as stored: `PidModel`, `PidSheet`, the ten item kinds (`PidItem` union), `PidEndpoint`, `PidValue`, `PidImportRecord`, `PidAcceptance`; the literal lists (`PID_ITEM_KINDS`, papers, statuses, actuators, ...) the validator reads |
| `state.ts` | `EMPTY_PID`, `getPid(doc)` (empty model when the slice is absent), `withPid(doc, pid)` (keeps the other `doc.plant` slices) |
| `validate.ts`, `validateItems.ts` | `pidErrors(raw)`: settings, sheets, accepted findings, import records, counters, then every item and the references between items |
| `plugin.ts`, `catalog.ts` | the plugin (`name: 'pid'`, `toolset: 'pid'`, `document` extension: `validate`, no derived entities, identity `restore`) and the empty catalogue |

`PlantModel` (`plant/types.ts`) gains `pid?: PidModel`; `TOOLSET_NAMES` gains `pid` (`@protocol/toolsets`), the palette label is "P&ID schematics".

**Load validation (refuses the file with a path):** version 1; convention in the two values; non-empty line-number format; tag formats only for `equipment` / `instrument` / `valve` with a compilable pattern; sheet id = key, unique non-empty number, paper A0..A4, status, `issuedBy` shape, an `issued_for_construction` sheet carries `issuedBy` (AF-34); `sheetOrder` / `itemOrder` list every id once; ids that are `Object.prototype` names are refused; every item: kind, existing sheet, finite position and rotation, non-empty `dexpiClass`, attribute values typed (`text` / `quantity` with unit / `enum`), `passthrough` strings only; per kind the references: a nozzle names an equipment, sub-equipment names an equipment and the chain has no cycle, a line's segments are segments whose `lineId` is that line and appear once, and a segment is listed by its line, a segment names a line and both ends exist with the right kind (an `inline` end names a port index that exists, a `branch` end a segment), routes have at least two finite points, an instrument's loop is a loop, an actuating system names an inline valve (and an instrument as controller), an OPC's `targetSheet` is a sheet; record keys (attributes, passthrough, acceptances, counters) are not `Object.prototype` names; tag-format patterns are at most 200 characters, with no backreference, lookaround or quantified group containing a quantifier (`patternSafety.ts`; **M4 must** still match only tags of at most 64 characters and prefer the bounded grammar of §5.1, since overlapping alternations such as `(a|a)*` are not detected); acceptances and import records (64 lowercase hex `sha256`) are well-formed. **Not a load error:** a repeated tag (imported data; `check_pid` reports `PID_TAG_DUPLICATE` in M4), dangling DEXPI references (the import turns them into `free` ends with a warning, `DEXPI_DANGLING_REFERENCE`).

### 13.2 `@lib/xmlRead` (`packages/core/src/lib/xmlRead.ts`)

`readXml(text, limits?)` returns `{ ok: true, root, declaration? }` or `{ ok: false, error: { code, message, line, column, offset } }`; it never throws. Helpers `xmlChildren(el, local?, ns?)`, `xmlAttr(el, qualifiedName)`, `xmlText(el)`. Tree: `XmlElement { name, prefix, local, namespace, attributes[] (namespace declarations included, namespace `XMLNS_NAMESPACE`), children[] (elements and text), line, column }`; the namespace is resolved for elements and prefixed attributes (an unprefixed attribute has none); CDATA is merged into text; comments and processing instructions are dropped; whitespace-only text between child elements is dropped, a text-only element keeps its text verbatim; CRLF / CR become LF; literal tab / LF in attribute values become spaces (character references are kept); a leading BOM is removed. Positions are 1-based, UTF-16 units, a CR, LF or CRLF is one break; references are decoded on the raw text, so an error offset is exact after CRLF.

**Safety properties** (VC-PID-15, TR-PID-11; all tested in `tests/unit/lib/xmlRead.test.ts`):

| Property | How |
| -------- | --- |
| no XXE, no billion laughs | any `<!DOCTYPE` is refused (`XML_DTD_FORBIDDEN`); only `lt gt amp apos quot` and numeric references are decoded, any other `&name;` is `XML_ENTITY_UNDEFINED`; a decoded value is never longer than its source, and nothing is fetched or re-scanned |
| bounded size | 50 000 000 UTF-16 units (`XML_TOO_LARGE`), 5 000 000 elements (`XML_TOO_MANY_ELEMENTS`), 1024 attributes per element (`XML_TOO_MANY_ATTRIBUTES`; namespace declarations count), 100 000 namespace declarations in the whole document (`XML_TOO_MANY_NAMESPACES`), names of 1024 characters; all overridable per call |
| bounded depth | 256 (`XML_TOO_DEEP`); the parser is iterative, so even a million `<a>` cannot overflow the stack, and the check fires before any deep structure is built |
| linear time and memory | namespace scopes are a prefix -> stack of URIs with a per-element undo list (no scope copies: an element costs its own declarations only); one pass of `indexOf` / char-code scans, no backtracking regex (the few regexes have no nested quantifiers or backtracking, and the declaration and reference ones run on bounded tokens); eight hostile shapes (200 000 `&`, 100 000 `&#x`, 50 000 `<!--`, 20 000 `<![CDATA[`, 200 000 attributes, 100 000 `<?`, ...) end in a coded refusal in well under a second |
| strict well-formedness | one root, matched tags (the message names both elements and where the open one started), quoted attributes separated by space, no duplicate attribute (also after namespace expansion), `<` never in an attribute, `]]>` never in text, `--` never in a comment, control characters, unpaired surrogates and U+FFFE / U+FFFF refused, the XML and xmlns namespace URIs bound only to their own prefixes, character references must name an XML Char, unbound prefixes refused, `xmlns` / `xml` prefixes protected, the XML declaration only first |
| all-or-nothing | the result is a tree or an error, never a partial tree |
| codes | `XML_EMPTY XML_TOO_LARGE XML_TOO_DEEP XML_TOO_MANY_ELEMENTS XML_TOO_MANY_ATTRIBUTES XML_TOO_MANY_NAMESPACES XML_SYNTAX XML_DTD_FORBIDDEN XML_ENTITY_UNDEFINED XML_CHAR_INVALID XML_MISMATCHED_TAG XML_UNCLOSED XML_DUPLICATE_ATTRIBUTE XML_NAMESPACE_UNBOUND XML_TRAILING_CONTENT`; M2 maps every one to `DEXPI_PARSE_ERROR` with `line N, column M` in `paths` ("too large" for the first three limits) |

All 12 DEXPI files of the validation pack read (element count = number of start tags, an independent regex count), each cut in the middle is refused with a position, and C01 (446 KB) reads well inside the 150 ms budget of §8 (the test allows 300 ms for a loaded machine). The input is a JS string: decoding bytes (and an `encoding="..."` other than UTF-8) is the caller's job; the declaration is returned as data and never refused.

### 13.3 Decisions (owner delegated, quality-first)

1. **D2 over the first draft (`CadDocument.pid`, core `model/pid.ts`).** The slice lives in `doc.plant.pid`, typed in the plugin. Reasons: the owner decided D2 on 2026-10-23 and 02, 05 and 08 already follow it; core stays free of P&ID types (L10: a domain is a plugin); the persistence round trip, load validation and the future migration are the plugin's. Cost: none (`doc.pid` was never released). The spec's other mentions of `doc.pid` mean `doc.plant.pid`.
2. **Q1 XML parser: in-house `@lib/xmlRead`**, not `fast-xml-parser`: DEXPI needs positions in errors, a hard refusal of DTDs and namespace-resolved names; a small reader is cheaper than auditing a dependency's prototype-pollution and entity options, and nothing in the repository read XML before. The reader is generic (BCF / 3MF / IFC-XML readers can use it), hence `@lib`.
3. **DOCTYPE is refused outright**, not skipped: the DEXPI files of the pack have none, a Proteus file never needs one, and "refuse" is the only rule that cannot be bypassed.
4. **Q2 toolset `pid`** (not a shared `plant`): see §11.2.
5. **Q4 tag scope: document; the tag index is derived, not stored.** The sketch's `PidModel.tagIndex` is dropped: a stored copy of what `items` already says is a second source of truth (L4) that every mutation must keep in step and a hand-edited file can falsify. M3 / M4 derive it (`normalised tag -> ids`, so duplicates stay visible) from `items`; when 08 DAT's `TagRegistryPort` arrives (V1) the derivation moves behind it with no data migration.
6. **Q3 default convention: `ISA-5.1`** (the `EMPTY_PID` value; `set_pid_conventions`, M3, changes it per project): ISA 5.1 bubbles are the instrument convention the DEXPI cases use; equipment and valve symbols follow `ISO-10628-2` from the symbol library (M5) whichever is chosen.
7. **No placeholder command.** An empty toolset still needs a `.lld` example (`tests/unit/design/examples.test.ts`), so `pid.lld` is an A1 frame drawn with core commands, marked in its header as the stand-in until M2 / M3.
8. Still open (§11): Q5 (Proteus 4.2.0 XSD), Q6 (imported symbol graphics).

### 13.4 PID-M2 (2026-10-31): DEXPI 1.3 import, `pid_report` counts / connectivity

Commands `import_dexpi` and `pid_report` (toolset `pid`, now listed in `docs/FEATURES.md`), `server/src/cli/exchange.ts` `FILE_PARAMS` gains `import_dexpi` (`text`, utf8). Code in `packages/domain-aec/src/plant/pid/`: `dexpi/` (`codes.ts` the `DEXPI_*` / `PID_SHEET_*` remediation table, `proteusClasses.ts` known classes / units as data, `proteusContext.ts` readers, `proteusEquipment|Piping|Instruments|Segments|Flows|Connect.ts` the mapper in two passes, `proteusRead.ts` the entry: `readXml` -> checks -> items), `lists/{counts,connectivity}.ts` (not `reports/`: that folder name is git-ignored), `commands/{importDexpi,pidReport}.ts`.

| Topic | As built |
| ----- | -------- |
| Parse errors | every `XML_*` code of `@lib/xmlRead` is `DEXPI_PARSE_ERROR`, `paths[0] = "line N, column M"`, `detail.xmlCode` keeps the XML code; the size / depth / attribute-count limits read "file too large or too complex". Nothing else reads the text (no DTD, no entity, no network) |
| Version | root `<PlantModel>` and `PlantInformation SchemaVersion` 4.1.x = DEXPI 1.3; any other root, `<Model>` (2.0), a missing SchemaVersion or 4.2.x (1.4) is `DEXPI_VERSION_UNSUPPORTED`. The `version` param is `auto` or `1.3` for now (1.2 / 1.4 / 2.0 join with their milestones, a value that cannot work is not offered) |
| Sheet | one new sheet per import (`sheet` param = its number, default first free `PID-nnn`, `PID_SHEET_DUPLICATE` otherwise); paper from `Drawing/Extent/Max`, title from `Drawing Name`; coordinates scaled to mm by `PlantInformation Units` (mm cm m in ft; unknown = mm with `DEXPI_ATTRIBUTE_UNIT`) |
| Segments | a DEXPI segment is split at each `PipingComponent` into `PidSegment`s between two items (ports picked by distance, or by the `FromNode` / `ToNode` the Connection names); every piece carries `passthrough['dexpi:segment']` (the DEXPI id), only the first keeps `sourceId`; a Connection end that is a component of the segment itself adds no extra piece; no Connection = free ends, `flow: 'none'`, otherwise `forward` |
| Other items | `Equipment` (+ sub-equipment, nozzles with sub tag / DN / manhole = access), `PipingNetworkSystem` = line, off-page connector (`pairKey` = `PipeConnectorNumber…`, else the reference number, else the id), `PipeFlowArrow`, `ProcessSignalGeneratingFunction`, `PlantStructureItem`, `MetaData` = `annotation` items (so the census counts them), instrument tag = category + functions + number, loop members -> `loopId`, `ActuatingSystem` on the valve its `OperatedValveReference` names (the valve becomes `operated`, the controller is the instrument whose actuating function it fulfils; an unresolvable valve drops the system with `DEXPI_DANGLING_REFERENCE`), `InformationFlow` = signal (ends from the Connection, else from the logical start / end associations; a function located in a segment ends as a `branch`). Presentation (labels, text, shape catalogue, drawing) is counted in one `DEXPI_GRAPHICS_DROPPED` info. Attributes: `DexpiAttributes` -> typed `attributes` (double + known unit = quantity; unknown unit / non-number = text, `unverified`, `DEXPI_ATTRIBUTE_UNIT`), other sets -> `passthrough["<Set>:<Name>"]`, reserved names stored as `attr:<name>`. An unknown Equipment / PipingComponent class is `Custom` (source class in `passthrough['dexpi:ComponentClass']`, `DEXPI_UNMAPPED_CLASS`), so are unknown root elements (warned, not read). At most 200 findings are listed, then one summary |
| Census | `PidImportRecord` gains `sheetId` and `census` (the three counters no item carries: `connections`, `danglingConnections`, `shapeCatalogueEntries`; validated on load). `pid_report kind=counts` applies the `countingRules` of `dexpi_census.json` to the items (segments folded per `dexpi:segment`, valves by source class). Census equality holds for all 17 keys of the 11 files (`tests/unit/plant/pid/dexpiImport.test.ts`) |
| Connectivity | one row per DEXPI segment (first piece's `from`, last piece's `to`) and per information flow, in model order (not sorted); `fromType` / `toType` = `<DEXPI element>:<class>` or `open`; `summary.endpointTypes` is the census histogram of C01 entry for entry, 17 of 19 nozzles reached, `T4750/N3` and `T4750/N8` not |

Deviations: `version` offers `auto` / `1.3` only (§4.1 lists more); `pid_report` offers `counts` / `connectivity` only (the lists are M4) and has no `filter`; connectivity rows are in import order, not natural-sorted (§5.7 sorts lists). `check_pid` stays unbuilt, so SC-PID-01 steps 2 to 6 stay blocked (`blockedPlanCommands.json` now lists only `check_pid` for that plan). `pid.lld` is unchanged.

### 13.5 PID-M3 (2026-10-31): authoring and connectivity

Fourteen commands (toolset `pid`, `docs/FEATURES.md` lists 16 with M2), code in `packages/domain-aec/src/plant/pid/`: `commands/` (one file per command), `authoring/` (`refs.ts` lookups, derived tag index, tag rules, `Draft` working copy, `mintFree`; `geometry.ts` legs, split, heal, orthogonal route; `split.ts` split / heal of segments with tee follow; `remove.ts` delete closure; `move.ts` equipment move and end-leg re-route; `endpoints.ts`, `nozzles.ts`, `classes.ts`, `values.ts`, `lineNumber.ts`, `instrumentTag.ts`).

| Command | One line |
| ------- | -------- |
| `create_pid_sheet` | sheet (`PID-001`, paper, convention, line-number template); `PID_SHEET_DUPLICATE` |
| `add_pid_equipment` / `add_pid_nozzle` | equipment with nozzles on the symbol box (half extents by class, +y is top, rotation about the centre); `PID_CLASS_UNKNOWN` lists close names |
| `add_pid_line` | line + first segment between `{tag, nozzle}`, `{line, at}` (tee, snapped within 5 mm), `{opc}` (connector created with the line) or `{free}`; orthogonal auto-route (straight, L, Z) or `via` |
| `add_pid_inline` | splits the segment at the snapped point, ports at +/-5 mm, pieces inherit line / dn / class / flow / primary; dn and class default from the segment and are flagged `defaulted` |
| `add_pid_instrument` | instrument, tag stored split, shared loop item `<letter>-<number>`, optional measuring signal from a line tap or a nozzle |
| `add_pid_signal_line` | information flow between instruments / actuating systems |
| `add_pid_actuating_system` | one per valve (`PID_ACTUATOR_EXISTS`), valve marked `operated`, controller = instrument |
| `add_pid_off_page_connector` | OPC on a free line start (in) or end (out) |
| `update_pid_item` | tag, attributes, dn, class, fluid, line number, `at`, `rotationDeg`; equipment takes nozzles and sub-equipment, attached segments / signals re-route their end legs |
| `delete_pid_item` | removes the item and what depends on it; an inline item with `heal` (default) merges its two segments, restoring the route to 1e-9 mm (VC-PID-13) |
| `reverse_pid_flow` | flips forward / reverse per line or segment (`none` becomes forward) |
| `renumber_pid_lines` | template numbering in sheet, y, x order; lines lacking a needed field are skipped and listed |
| `set_pid_conventions` | convention, line-number template, tag formats (pattern checked by `patternSafety`; enforced on later tags, at most 64 characters) |

Connectivity (§5.2) is the M2 module `lists/connectivity.ts`, reused: authored segments carry `passthrough['dexpi:segment']` (their own id, shared by the pieces an inline item splits), so counts and connectivity rows fold them exactly like imported DEXPI segments; the module now folds the pieces in the order of `line.segmentIds` (inline insertion appends new segments to `itemOrder`, so model order no longer is flow order). Branch (tee) ends follow a split / heal: a `branch` end moves to the piece that carries its point. Ids are minted with `nextId` through `mintFree`, which skips an id a hand-edited file already uses (the slice fuzz found a collision with a seeded `pid-1.1`).

Deviations from §4.1: `define_pid_symbol` (V1), `link_pid_item` (M7), `accept_pid_finding` and `issue_pid_sheet` (human gate, M4 / V1) are not built. Flat endpoint objects (`tag`, `nozzle`, `line`, `at`, `opc`, `targetSheet`, `free`; exactly one form, else `PID_LINE_ENDPOINT_INVALID`) instead of a union. `add_pid_instrument` splits the tag with a minimal letters + loop number + suffix pattern (`FIC-101`, `PDIT 12.01`, `FV-101A`); the ISA 5.1 letter table and `parse_instrument_tag` are M4 (an unparseable tag needs `parts`). An OPC `targetSheet` that is not a sheet yet cannot be stored (the model requires a sheet id): the number is kept in `passthrough['pid:targetSheet']` and `check_pid` (M4) reports the connector unresolved; a known sheet is stored as its id. Signal ends on an actuating system use the `instrument` endpoint type (the model allows `instrument` or `actuating` items there). `add_pid_inline` also refuses a point closer than 5 mm to a bend or to the end of its straight run (`PID_POINT_OFF_LINE`, there is no room for the two ports). `update_pid_item` cannot move inline items (delete and re-insert) and a moved equipment re-routes only the end legs (a jog may appear next to the moved nozzle). New codes (all with remediation in `dexpi/codes.ts`): `PID_PARAM_INVALID`, `PID_ACTUATOR_EXISTS`, `PID_LINE_NUMBER_FORMAT`; `PID_CLASS_UNKNOWN` closes on the classes of `proteusClasses.ts` until the M5 symbol library. Equipment sizes are defaults per class (`authoring/classes.ts`), not stored. `delete_pid_item` accepts a line number; a segment alone is refused (`PID_ITEM_KIND`). `renumber_pid_lines` with nothing to renumber is a no-op. Validation plans: `size` in SC-PID-02 / 03 became `paper` (the §4.1 name); `blockedPlanCommands.json` keeps `check_pid` for SC-PID-01 / 02 and `check_pid_3d` for SC-PID-03.

Tests (`tests/unit/plant/pid/`): `authoringScenario.test.ts` (the SC-PID-02 plan file run step by step: 4 + 4 segments, seeded attributes, connectivity, counts, replay, plugin validation; check_pid and `line_list` stay M4), `authoringBasics.test.ts` (sheet, equipment, nozzle, line, conventions), `authoringInline.test.ts` (split, heal to 1e-9, tee follow, cascades, instruments, signals, actuating systems, OPC, flow), `authoringEdit.test.ts` (update, renumber, and for every command: `is pure`, valid after the step, save / load equality, replay equality, refusals leave the same document object). The slice fuzz seed of `pid` now has a query and a mutating command.

### 13.6 Tests

`tests/unit/lib/xmlRead.test.ts` (documents, namespaces, entities, CDATA, BOM, UTF-8 names, line ends, 46 coded refusals with line / column, limits, hostile shapes, never throws), `tests/unit/lib/xmlReadFiles.test.ts` (the 12 DEXPI files, truncated copies, budget), `tests/unit/plant/pid/persistence.test.ts` (state helpers, exact save / load round trip with all ten item kinds, about 90 refusals with their paths, repeated tags load), `tests/unit/plant/pid/plugin.test.ts` (skeleton, toolset, extension). M1 had no command, so no `is pure` test beyond `withPid`; the golden corpus and the tool-schema snapshot were unchanged.

M2: `dexpiImport.test.ts` (census equality of the 11 files, tags / lines / instruments / loops, C01 details), `dexpiMapping.test.ts` (constructed files: units, attributes, classes, segment splitting, instruments, actuating systems, signals, warning cap), `dexpiRefusals.test.ts` (every `XML_*` class, DTD / entity bomb, too large / deep, versions, sheet numbers), `dexpiReports.test.ts` (connectivity vs census, counts, sheet filter, purity, replay, save / load, SC-PID-01 steps 0 and 1).

### 13.7 PID-M4 (2026-10-31): tags, checks, lists

Two commands added (`check_pid`, `parse_instrument_tag`) and `pid_report` extended to the five lists (toolset `pid`, 18 commands). Code in `packages/domain-aec/src/plant/pid/`: `tags/` (`isa51Letters.ts` the letter table as data, a test compares it with `isa51_letters.json`; `parseTag.ts` the grammar; `registry.ts` the derived tag registry), `checks/` (`finding.ts`, `context.ts`, `ruleConnection|Consistency|Devices.ts`, `runChecks.ts`), `lists/{lineList,valveList,instrumentIndex,equipmentList,lookup,sort}.ts`, `commands/{checkPid,parseInstrumentTag,pidReport}.ts`. `authoring/instrumentTag.ts` now calls the parser: M3's minimal split is gone.

| Topic | As built |
| ----- | -------- |
| Parser | linear scan, no regex over the tag, at most 64 characters. Letters: first letter, then a first-letter modifier (D F J K Q S X Y Z) only when at least one succeeding letter follows and all of them parse; H L M are modifiers after A, S or another modifier (`TAHH`), L is Light elsewhere. When both readings parse, the plain one wins if it uses a high / low / middle modifier (`PSH`, `TSL`), else the modifier reading (`PSV` = pressure, Safety, valve); the other reading is the warning `PID_TAG_AMBIGUOUS_LETTERS` (not in §7). `+ * / &` in the letters give `PID_TAG_NONSTANDARD`, every other shape fault `PID_TAG_FORMAT`. A first letter alone (`T-101`) parses. The result adds `letters`, `separator`, `grade` / `unverified` (grade B rows: I, J, K, X, M). A failed parse is a coded refusal with the parse in `data` (`ok: false`). `convention` offers `ISA-5.1` only. `add_pid_instrument` / `update_pid_item` refuse a tag that does not parse with ISA 5.1 (`PID_TAG_FORMAT`, the parser's reason in the summary); `parts` keeps a nonstandard tag and `check_pid` then reports it as info |
| Tag registry | `buildTagRegistry`: normalised tag -> items of the unique-tag kinds (equipment, inline, instrument, actuating), derived per call, not stored (§13.3.5); the 08 DAT registry is untouched |
| `check_pid` | the 16 rules of §5.5, one linear pass each over a shared index of segment ends; `data` = `{ check, status, items, countsByCode (all rules run, zeros kept), summary { errors, warnings, infos, reviewRequired, accepted }, rulesRun, provenance }`; findings sorted errors first, then rule order, natural label, key; `findingKey = pid:<code>:<sorted ids>`; each finding also carries `severity` and a short `item` label (`T4750/N3`). Params `sheet`, `rules`, `includeAccepted` (reads `acceptances`; `accept_pid_finding` stays unbuilt: human gate, V1) |
| Rule definitions the spec left open | **marked end of line**: segment attribute `endOfLine` set (vent, drain, blind, sample; `false` / `none` / empty do not count). **Spare nozzle**: attribute `spare` set, reported as the info code `PID_NOZZLE_UNCONNECTED_ACCESS`; a nozzle reached only by a measuring line counts as connected. **Spec break**: class containing `SpecBreak` or attribute `specBreak`. Reducers (`Reducer`, `Swage`, `Expander`) skip the size rule; a tee (more than two ports) is compared on ports 0 and 1 only (its branch may leave in another size or class); a blind flange / cap / plug may leave its far port open. **Vessel** classes: Tank, PressureVessel, ProcessColumn (nozzles of sub-equipment count). **Flow conflict**: segments with flow meeting at an inline item all into it or all out of it, or a check valve (class contains `Check`) against the flow (`reversed` swaps the entry port); a segment with flow `none` never conflicts. **PID_SEGMENT_INVALID**: consecutive pieces of one drawn segment must meet at the same item, and no nozzle / inline port / OPC is used by two segment ends. **OPC**: partner = same `pairKey`, opposite direction, another sheet (the target sheet when known); a target sheet number that is no sheet is unresolved. **PID_INSTRUMENT_UNCONNECTED**: no signal end, not a controller, and no other instrument in its loop (a lone auto-created loop does not count, else the rule could never fire for authored instruments). **PID_CONTROL_VALVE_NO_ACTUATOR**: operated valve without actuating system, or actuating system without controller. **PID_SAFETY_VALVE_NO_SET_PRESSURE**: class containing Safety or Relief without an attribute `SetPressureHigh`. **PID_TAG_NONSTANDARD** (info): instrument tags that do not parse |
| C01 baseline (VC-PID-09) | 0 `PID_SEGMENT_INVALID`; `PID_NOZZLE_UNCONNECTED` = `T4750/N3`; `PID_NOZZLE_UNCONNECTED_ACCESS` = `T4750/N8`. Other findings, reviewed and frozen in `checkScenario.test.ts` / `checkRules.test.ts`: 4 `PID_LINE_NON_TERMINATING` (lines 47130, 47131, 47140, 47141 end free), 1 `PID_COMPONENT_UNCONNECTED` (BallValve-2, a drain valve whose far port is open), 1 `PID_SPEC_MISMATCH` (SwingCheckValve-1, class 75HB13 between a 75HB13 and a 73HG12 segment: the class break of line 47124), 2 `PID_OPC_UNRESOLVED` (one sheet, the partners are on sheets not in the file) |
| Lists | `pid_report` kinds `line_list`, `valve_list`, `instrument_index`, `equipment_list`, `nozzle_list` with the §5.7 columns, natural sort by tag / line number (ties by id), CSV; new param `filter` (column -> text, case-insensitive, all must match; unknown column `PID_PARAM_INVALID`). `dn` is the integer (the plan's `nominalDiameter` text became `dn`); `segments` counts the stored segments of the line (an inline item splits one drawn segment in two), the DEXPI segment count of the census stays `pid_report kind=counts`; `equipment_list` lists top-level equipment, design pressure / temperature from the equipment or its first sub-equipment (`DesignPressure` / `UpperLimitDesignPressure`, ...); an item without a tag shows its source-file id; a branch end reads `tee:<line number>` |

Deviations: `PID_TAG_AMBIGUOUS_LETTERS` is a new parser warning; the spec's `tags` / `values` finding fields are kept and `item`, `severity`, `message` added; the validation plans SC-PID-01 / 02 were aligned with §4.2 / §5.7 (`data.findings` -> `data.items`, `nominalDiameter` -> `dn`, instrument rows sorted); `blockedPlanCommands.json` lost the SC-PID-01 / 02 / 05 entries (SC-PID-03 keeps `check_pid_3d`). No golden plan added: the P&ID plans run as scenario tests, like the plant 03 and 08 plans (`tests/golden` holds only the piping-run plans). Existing tool texts changed in the schema snapshot: `pid_report` (kinds, `filter`) and `add_pid_instrument` (the letters must parse with ISA 5.1).

Tests (`tests/unit/plant/pid/`): `tagParse.test.ts` (the 16 cases of `tag_parse_cases.json`, the letter table vs the JSON, grammar details, authoring integration, registry), `checkRules.test.ts` (one positive and one negative fixture per rule, options, envelope, purity, replay), `checkScenario.test.ts` (SC-PID-01 / 02 / 05 run step by step, every `expected` row compared), `pidLists.test.ts` (the lists on all 11 files against the census, CSV, filters, refusals, authored lists), `checkPerf.test.ts` (5 040 items under 1.0 s, 36 000 items under 1.5 s so a quadratic pass fails, lists likewise; time ratios between sizes were too noisy under GC and coverage to gate on).

## 14. References

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
