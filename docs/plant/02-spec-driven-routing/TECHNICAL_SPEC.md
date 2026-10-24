# Gap 02 RTE — Spec-driven pipe routing: technical specification

Companion of [FUNCTIONAL_SPEC.md](FUNCTIONAL_SPEC.md). Laws: `.claude/rules/architecture.md` (L1–L10). Agent-first
requirements: [`../../aerospace/AGENT_FIRST.md`](../../aerospace/AGENT_FIRST.md). Validation:
[`validation/README.md`](validation/README.md). Sibling gaps are referenced by folder name and not re-specified.

## 1. Current state in llull

| Area                             | What exists                                                                                                                                                             | File(s)                                                                        | Limit for plant routing                                              |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Pipe element                     | `PipeElement` in the **building** model: `points: Vec3[]` (z relative to the level), `diameter`, `service`, `material`, optional `line`, `dn`, `from`, `to` (free text) | `packages/core/src/model/building.ts` (`PipeElement`, l. 251)                  | No ports, spec, components, joints; `from` / `to` are not references |
| `add_pipe_run`                   | Validates points (2..1000), DN → OD from the EN 10220 / B36.10M table (DN15-400), refuses a twin route; summary counts "bends" = interior points                        | `packages/domain-aec/src/industrial/equipment/equipment.ts`                    | Any angle accepted; no fittings; no cut-back                         |
| Pipe geometry                    | Circle (16 segments) swept along the polyline (`sweepRun`) + a sphere of pipe radius at each interior vertex                                                            | `packages/domain-aec/src/industrial/evaluate.ts` `evaluatePipe`                | Mitred look, no elbows / flanges / valves; no insulation             |
| Sizes                            | `PIPE_SIZES` [DN, OD, STD wall, MSS SP-69 span] DN15-600                                                                                                                | `industrial/piping/pipeSizes.ts`, `pipeWeight.ts`                              | STD wall only; no schedules, no fittings (catalogue = 01 PSC)        |
| Route helpers                    | parse / length / snap to polyline / segments                                                                                                                            | `industrial/piping/routeSupport.ts`                                            | Reusable for runs                                                    |
| Supports                         | `add_pipe_support`, `check_pipe_supports` (MSS SP-69 spans, risers, re-attachment on edit)                                                                              | `industrial/piping/pipeSupport*.ts`, `supportParts.ts`, `pipeSupportAttach.ts` | Work on `PipeElement` centrelines only                               |
| Hydraulics                       | `pipe_hydraulics` (Darcy-Weisbach, Colebrook, K per bend from deflection)                                                                                               | `industrial/piping/pipeHydraulics.ts`, `pipeFlow.ts`                           | Would gain real fittings K from components                           |
| Equipment                        | `add_equipment` (box / vertical / horizontal vessel, clearance, weight), `update_equipment`                                                                             | `industrial/equipment/equipment.ts`, `equipmentUpdate.ts`                      | No nozzles (03 EQP)                                                  |
| Clashes                          | `check_clashes`: pipes, trays, equipment, steel…; a pipe end inside equipment or on another pipe is a "connection", not a clash                                         | `industrial/clash/clash.ts`, `clashBoxes.ts`                                   | Connections guessed by geometry; no insulation envelope              |
| Gravity pipes                    | Civil drainage `add_drainage_pipe` / `update_drainage_pipe` with inverts, adverse-slope warning                                                                         | `packages/domain-aec/src/civil/drainage/drainagePipeCommands.ts`               | Network between manholes, not plant piping; slope check idea reused  |
| Exchange                         | IFC `IFCPIPESEGMENT(... .RIGIDSEGMENT.)` per pipe; plan sheets / DXF show pipes with service                                                                            | `building/exchange/ifcIndustrialExport.ts`                                     | No fittings, ports or `IfcRelConnectsPorts`; no PCF                  |
| Toolset                          | MCP `piping` = `add_pipe_run add_pipe_support add_cable_tray check_pipe_supports pipe_hydraulics`                                                                       | `packages/mcp/src/toolsets.ts` `PIPING_TOOLS`                                  | Grows with this gap                                                  |
| Plugin pattern for a model slice | `civil` plugin: `doc.civil` typed in `@core/model/civil`, `derivedModelExtension` regenerates entities, derivation guard                                                | `packages/domain-aec/src/civil/plugin.ts`, `shared/derived.ts`                 | Template for `doc.plant`                                             |
| Plan reports                     | `build_project` steps carry `error { code, ids, paths, remediation }` and `data`; `data.aliases`                                                                        | `packages/core/src/commands/project/` (AF-14, done)                            | Ready for `RTE_*` codes                                              |

Gap: everything from §3 on. Nothing in `packages/` is changed by this pack.

## 2. Target architecture

- **Plugin `piping`** in `packages/domain-aec/src/plant/piping/` (new folder `plant/`, shared later with 03 EQP,
  06 STA, 08 DAT), installed by `src/app/plugins.ts` `installDefaultPlugins()`, toolset `piping`
  (`packages/mcp/src/toolsets.ts`: the toolset getter returns the `piping` plugin's commands plus the legacy
  `PIPING_TOOLS`). Domain capability in a plugin, never in core (L10).
- **Document slice `doc.plant`**, typed in `packages/core/src/model/plant.ts` (types only, like `@core/model/civil`),
  holding `plant.piping` (this gap), `plant.specs` (01 PSC) and later `plant.equipment` (03) and `plant.tags` (08).
  A `DocumentExtension` (`shared/derived.ts` `derivedModelExtension`) validates it, regenerates derived entities on
  load and protects them with a derivation guard (L8).
- **Stored intent, derived parts.** The document stores what the operator decided: lines, run ends, PIs (points of
  intersection), leg slopes, inline components, branch points and explicit overrides. Fittings, flange sets, pipe
  pieces and their geometry are **derived** deterministically from that intent plus the spec on every evaluation.
  A spec change re-derives every affected run; replay re-mints identical ids (L8). An override
  (`set_component_override`, V1) freezes one derived choice, e.g. a short-radius elbow.
- **Pure commands** (L1, L3). Mutating commands return a new document; queries (`check_piping`,
  `piping_connectivity`, `piping_takeoff`, `line_heat_loss`) are `readOnly` and return `data`.
- **Spec through a port.** Routing reads specs only through `SpecLookup` (§3.3), implemented by 01 PSC's plugin
  over `doc.plant.specs`. The plans import the PSC-format stand-ins `validation/data/catalog_stub_cs150.json` + `spec_cs150.json` (§13.6).
- **Ports through a port.** `PortSource` collects ports from tie-in points (this gap), equipment nozzles (03 EQP)
  and run ends; routing never reads equipment geometry directly.
- **Kernel optional** (L9). Routing, cut-back, graph and checks are plain vector maths. Display geometry is built
  as today (swept tubes, revolved profiles as meshes). With a kernel (`ctx.kernel`, `requiresKernel` only on the
  B-rep export path) components become exact solids for STEP / clash refinement.
- **Equipment edits.** `update_equipment` / nozzle edits (03) call no piping code; the `piping` document extension
  reconciles runs during regeneration (same pattern as `reconcilePipeSupports` in
  `industrial/piping/pipeSupportAttach.ts`), and the editing command's summary reports re-routed / broken runs.

```
packages/core/src/model/plant.ts                 PlantModel, PipingModel, Port, PipeLine, PipeRun … (types only)
packages/domain-aec/src/plant/piping/
  plugin.ts            CadPlugin { name: 'piping', toolset: 'piping', commands, guards, document }
  catalog.ts           commandCatalog(...)
  model.ts             getPiping, withRun, nextPipingId, line-number template
  ports.ts             PortSource registry: tie-ins, nozzles (03), run ends
  specLookup.ts        SpecLookup interface + stub loader for tests
  legs.ts              compass legs / via points / closing leg -> PIs; slope vectors
  fittings.ts          turn angles, elbow selection, tolerance, centre-to-end
  jointStack.ts        occupied lengths along a leg -> pipe pieces, cut lengths, welds
  branches.ts          branch table, tee / olet / stub-in placement
  derive.ts            run -> RoutedPart[] (deterministic ids)
  stretch.ts           orthogonal stretch on port moves
  graph.ts             connectivity graph, open ends, mismatches
  checks.ts            check_piping rules + codes
  takeoff.ts           counts, cut list, welds, studs
  geometry.ts          RoutedPart -> display entities (tube, torus, cone, flange, valve, insulation)
  heatLoss.ts          V1 line_heat_loss
  autoRoute/           V2: route_problem builder, solution validator, small-grid TS A* (reference, §2.A)
  commands/*.ts        one file per command (≤ 500 lines each)
```

### 2.A Stack amendment (RS1, 2026-10-18)

Decided by the owner in [RS1](../../decisions/RS1-native-compute.md) (programme step **RS-7**, medium). It changes
only the V2 auto-router. `route_pipe`, derivation, `check_piping` and the takeoff stay TypeScript.

| Item                                      | Before                                       | Now                                                                                                                                                                |
| ----------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| V2 search (3D grid A\*)                   | TS in `autoRoute/`, inside `auto_route_pipe` | `llull-compute route` (crate `llull-route`, Rust CPU): sparse / implicit obstacle grid, ≤ 2·10⁶ expansions in ≤ 5 s, candidate routes searched in parallel (rayon) |
| TS search                                 | the only path                                | kept as the reference and the small-grid path (expansion cap TBD — measure at V2)                                                                                  |
| Problem and commit                        | inside one command                           | `route_problem` (query, TS) builds the canonical problem; `auto_route_pipe` (mutating, TS) validates a supplied solution and commits it as an ordinary run         |
| `route_pipe`, derivation, checks, takeoff | TS                                           | unchanged                                                                                                                                                          |
| Gate                                      | Vitest                                       | plus `npm run native:check` (`cargo test` + `cargo clippy -D warnings`) for `llull-route`                                                                          |

Flow (L1, L2, L6). The host transport `auto_route` (CLI `llull route auto lineId=… from=… to=…`) runs `route_problem`,
writes its `data` to a job folder, runs `llull-compute route <job-folder>` (RS1 job folder + NDJSON progress) and
dispatches `auto_route_pipe { …, solution }`. Native code never writes the document. Before it commits,
`auto_route_pipe` checks that:

- `solution.problemHash` equals the hash of the problem rebuilt from the current document (a stale solution is refused);
- every leg is axis-aligned on the grid, clear of every inflated obstacle box and keep-out, and the path starts and
  ends with the required port stubs;
- the reported length, bend count and cost match the PIs.

A failure gives `RTE_AUTOROUTE_SOLUTION_INVALID` with the failing leg in `paths`. A solution from any source (native,
TS or hand-written) is held to the same rule. Without `solution`, `auto_route_pipe` runs the TS A\* under its small cap
and refuses above it with `RTE_AUTOROUTE_BUDGET` (remediation: run `llull route auto`). A missing binary gives
`NATIVE_TOOL_MISSING` from the transport (RS1 §2 rule 5).

Determinism (AF-13). Both searches use the same state, cost and total order of the open set (§5.12). Costs are
quantised to integer micrometres before the search, so both sums are exact integers and both searches expand states
in the same order. Parallel candidates (arrival directions, rack elevations, multi-line orders) are compared by
(cost, candidate index), never by finish time. Native vs reference: VC-RTE-25.

## 3. Data model

### 3.1 Stored types (`@core/model/plant`)

```ts
export type EndType = 'BW' | 'FL' | 'SW' | 'SC' | 'PL' | 'WAF' | 'LUG'; // butt weld, flanged, socket, screwed, plain, wafer, lug
export type Facing = 'RF' | 'FF' | 'RTJ';

/** A connection point. Direction = outward unit normal of the connection face, pointing toward the pipe. */
export interface PortSpec {
  position: Vec3; // world coordinates, document units (mm in plant documents)
  direction: Vec3; // unit vector
  dn: number; // nominal size, DN integer (NPS mapped by 01)
  endType: EndType;
  rating?: string; // 'CL150', 'PN16' …
  facing?: Facing;
}

export interface TieInPoint {
  readonly id: string;
  tag: string;
  kind: 'tie_in' | 'battery_limit';
  port: PortSpec;
}

export type PortRef =
  | { kind: 'tieIn'; id: string }
  | { kind: 'nozzle'; equipmentId: string; nozzleId: string }
  | { kind: 'runEnd'; runId: string; end: 'start' | 'end' }
  | { kind: 'branch'; runId: string; branchId: string };

export interface Slope {
  value: number;
  unit: 'percent' | 'ratio' | 'deg';
  fall: boolean;
} // fall = descends along flow

export interface PipeLine {
  readonly id: string; // 'line-3'
  lineNumber: string; // '100-P-1001-CS150' (template, §5.9)
  fields: { dn: number; service: string; sequence: string; spec: string; insulationCode?: string };
  spec: string; // spec name (01 PSC)
  dn: number;
  designPressureBarG?: number;
  designTempC?: number;
  insulation?: { code: string; thicknessMm: number; material: string; source: 'spec' | 'explicit' };
  tracing?: { type: 'electric' | 'steam'; tracers: number; maintainTempC?: number };
  slope?: Slope;
  from?: string; // tag text kept for the line list; checked against the graph
  to?: string;
  runIds: string[];
}

export interface RunEnd {
  ref?: PortRef;
  point: Vec3;
  direction?: Vec3;
} // ref absent = open end at point

export interface InlineComponent {
  readonly id: string; // 'valve-2' (step-scoped)
  type: string; // catalogue type: 'valveGate', 'strainerY', 'reducerConcentric' …
  tag?: string; // 'XV-1001'
  leg: number; // leg index in the run
  centreDistance: number; // from the leg start PI, document units
  dn2?: number; // reducers: outlet DN
  stemDirection?: Vec3; // valves
}

export interface BranchPoint {
  readonly id: string;
  leg: number;
  distance: number;
  branchRunId: string;
  fitting?: string;
}

export interface PipeRun {
  readonly id: string; // 'run-4'
  lineId: string;
  start: RunEnd;
  end: RunEnd;
  pis: Vec3[]; // interior points of intersection; legs = [start, ...pis, end]
  legDn?: number[]; // per-leg DN when sizes change (reducers derived at the change)
  legSlopes?: (Slope | null)[];
  inline: InlineComponent[];
  branches: BranchPoint[];
  angleToleranceDeg?: number; // overrides the spec tolerance for this run (named in results)
  broken?: { code: 'RTE_STRETCH_FAILED'; reason: string };
}

export interface PipingModel {
  counters: Record<string, number>;
  lines: Record<string, PipeLine>;
  lineOrder: string[];
  runs: Record<string, PipeRun>;
  runOrder: string[];
  tieIns: Record<string, TieInPoint>;
  entityIds: Record<string, string[]>; // derived entity ids per run (regeneration)
}
export interface PlantModel {
  piping?: PipingModel;
  specs?: unknown /* 01 PSC */;
  equipment?: unknown; /* 03 EQP */
}
```

`CadDocument` gains `plant?: PlantModel` (optional, absent = no plant data; old files load unchanged). The building
`PipeElement` stays; `convert_pipe_run` creates a `PipeRun` from it (§4) and deletes the element only when
`replace: true`.

### 3.2 Derived types (not stored)

```ts
export interface PartPort {
  position: Vec3;
  direction: Vec3;
  dn: number;
  endType: EndType;
  rating?: string;
  facing?: Facing;
}
export interface RoutedPart {
  id: string; // `${runId}/${kind}-${k}` deterministic in route order
  runId: string;
  kind: 'pipe' | 'elbow' | 'tee' | 'olet' | 'stubIn' | 'reducer' | 'flange' | 'gasket' | 'boltSet' | 'valve' | 'inline' | 'cap';
  catalogueKey: string; // 01 PSC row id, e.g. 'CS150/elbow90LR/4'
  dn: number;
  dn2?: number;
  ports: PartPort[]; // 2 (pipe, elbow, flange…), 3 (tee), 1 (cap)
  centre?: Vec3; // elbow / tee centre (PCF CENTRE-POINT)
  cutLength?: number; // pipe pieces only
  angleDeg?: number; // elbows: actual turn; nominal in catalogueKey
  unverified?: boolean; // from the catalogue row / spec status (AF-32)
}
export interface Joint {
  id: string;
  kind: 'buttWeld' | 'socketWeld' | 'threaded' | 'flanged' | 'fittingToFitting';
  parts: [string, string];
  position: Vec3;
  gapMm: number;
}
```

### 3.3 `SpecLookup` (implemented by 01 PSC)

```ts
export interface CatalogueRow {
  key: string;
  type: string;
  dn: number;
  dn2?: number;
  rating?: string;
  ends: EndType[];
  dims: Record<string, number>; // centreToEnd, C, M, H, Y, faceToFace, thickness, height, studs …
  unverified: boolean;
  source: string;
}
export interface SpecLookup {
  status(spec: string): 'approved' | 'draft' | 'stub' | null; // null = unknown spec
  pipe(spec: string, dn: number): CatalogueRow | SpecMiss;
  component(spec: string, q: { type: string; dn: number; dn2?: number; rating?: string; angleDeg?: number }): CatalogueRow | SpecMiss;
  elbowAngles(spec: string, dn: number): { anglesDeg: number[]; toleranceDeg: number; trimmedAllowed: boolean };
  connection(spec: string, a: EndType, b: EndType): { joint: Joint['kind']; gapMm: number; requires: string[] } | null;
  branch(spec: string, headerDn: number, branchDn: number): { fitting: 'tee' | 'teeReducing' | 'olet' | 'stubIn'; row: string } | null;
  insulation(spec: string, dn: number, tempC: number): { thicknessMm: number; material: string; row: string } | null;
}
export type SpecMiss = { miss: 'RTE_SPEC_NO_COMPONENT' | 'RTE_SPEC_AMBIGUOUS' | 'RTE_SPEC_UNKNOWN'; detail: string };
```

Binding to 01-piping-specs-catalog: `SpecLookup` is a thin adapter over the pure functions behind 01's
`resolve_spec_component` and `resolve_branch` (01 TECHNICAL §4-5), called in-process (not through `execute`, as
derivation runs inside every regeneration). 01's codes are carried in `detail` and mapped:
`PSC_SPEC_UNKNOWN` → `RTE_SPEC_UNKNOWN`, `PSC_BRANCH_UNDEFINED` → `RTE_BRANCH_NO_TABLE_ROW`, any "no component"
miss → `RTE_SPEC_NO_COMPONENT`. `status()` reads 01's revision / approval state (`approve_pipe_spec` is 01's
human gate, AF-34). Specs enter the document with 01's `import_pipe_spec` or `create_pipe_spec`.

### 3.4 Document version and migration

No version bump: `plant` is a new optional key validated by its extension (unknown keys inside `plant.piping` are
errors). Legacy `PipeElement`s are untouched; conversion is an explicit, undoable command (FR-RTE-19).

## 4. Commands

Mutating commands append a `FeatureStep` (L8). Ids are step-scoped. Units: document units (mm in plant
documents) unless stated; angles in degrees; temperatures °C; pressure bar g. Every refusal sets
`CommandResult.error` (AF-11) and returns the input document unchanged.

| Command                   | Kind          | Params sketch                                                                                                                                                                                                    | Tags                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `add_tie_in_point`        | mutating      | `{ tag, position: [x,y,z], direction: [dx,dy,dz], dn, endType, rating?, facing?, kind?: 'tie_in'\|'battery_limit' }`                                                                                             | @affects creates 1 tie-in (port marker on layer P-TIE) · @invariant direction normalised; tag unique · @failure zero direction / dn ≤ 0 / duplicate tag → `RTE_INVALID_PORT`, `RTE_DUPLICATE_TAG`                                                                                                                                                                                                                                                                                           |
| `create_pipeline`         | mutating      | `{ service, sequence, spec, dn, lineNumber?, designPressureBarG?, designTempC?, insulation?: { code, thickness: number\|'fromSpec', material? }, tracing?, slope?, from?, to? }`                                 | @affects creates 1 line (no geometry) · @invariant lineNumber = explicit or template; unique · @failure unknown spec `RTE_SPEC_UNKNOWN`; duplicate `RTE_DUPLICATE_LINE_NUMBER`; insulation fromSpec without table row `RTE_SPEC_NO_COMPONENT`                                                                                                                                                                                                                                               |
| `update_pipeline`         | mutating      | `{ lineId, …same optional fields }`                                                                                                                                                                              | @affects line + re-derivation of its runs (spec change re-selects parts) · @failure as above; parts missing in the new spec → refused, nothing changed                                                                                                                                                                                                                                                                                                                                      |
| `route_pipe`              | mutating      | `{ lineId, from: { portId } \| { point, direction? }, to?: { portId } \| { point }, legs?: [{ direction: '+X'…'-Z' \| [dx,dy,dz], length? , planLength?, slope? }], via?: [[x,y,z]…], dn?, angleToleranceDeg? }` | @affects creates 1 run + derived parts · @invariant legs from the start port; a final straight closing leg to `to` is added when collinear with the arrival direction; consecutive collinear legs merge · @failure §7 codes (`RTE_UNKNOWN_PORT`, `RTE_PORT_IN_USE`, `RTE_CLOSING_LEG_IMPOSSIBLE`, `RTE_NO_FITTING_FOR_ANGLE`, `RTE_SEGMENT_TOO_SHORT`, `RTE_SIZE_MISMATCH`, `RTE_RATING_MISMATCH`, `RTE_NO_CONNECTION_RULE`, `RTE_SPEC_NO_COMPONENT`, `RTE_ZERO_LEG`, `RTE_PORT_DIRECTION`) |
| `insert_inline_component` | mutating      | `{ runId, type, tag?, at: { leg, centreDistance } \| { point }, dn2?, stemDirection? }`                                                                                                                          | @affects run.inline + derived split / flange sets · @failure does not fit between neighbours `RTE_INLINE_DOES_NOT_FIT`; not in spec `RTE_SPEC_NO_COMPONENT`                                                                                                                                                                                                                                                                                                                                 |
| `move_inline_component`   | mutating      | `{ runId, componentId, centreDistance \| delta }`                                                                                                                                                                | @affects one inline position · @failure as above                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `add_branch`              | mutating      | `{ runId, at: { leg, distance } \| { point }, dn, to?: { portId } \| { point }, legs?: […] }`                                                                                                                    | @affects header run.branches + new branch run (same line unless `lineId`) · @invariant fitting from the branch table, reported in `data.fitting` · @failure on a fitting `RTE_BRANCH_ON_FITTING`; no table row `RTE_BRANCH_NO_TABLE_ROW`                                                                                                                                                                                                                                                    |
| `edit_route`              | mutating      | `{ runId, op: 'move_pi' \| 'stretch_leg' \| 'insert_pi' \| 'delete_pi', index, delta? \| point? \| length? }`                                                                                                    | @affects PIs; re-derivation · @failure any derived failure → refused with that code                                                                                                                                                                                                                                                                                                                                                                                                         |
| `delete_pipe_run`         | mutating      | `{ runId, heal?: boolean }`                                                                                                                                                                                      | @affects removes run (and its branch runs if `cascade`) · @failure branch runs exist and no cascade `RTE_HAS_BRANCHES`                                                                                                                                                                                                                                                                                                                                                                      |
| `convert_pipe_run`        | mutating      | `{ pipeId, spec, lineId?, replace?: boolean }`                                                                                                                                                                   | @affects creates line (from `PipeElement.line`) + run; deletes the element when `replace` · @failure untranslatable angle `RTE_NO_FITTING_FOR_ANGLE` (lists vertex indices)                                                                                                                                                                                                                                                                                                                 |
| `set_line_insulation`     | mutating      | `{ lineId, code, thickness: number\|'fromSpec', material? }`                                                                                                                                                     | V1; same validation as `create_pipeline`                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `set_heat_tracing`        | mutating      | `{ lineId, type?, tracers?, maintainTempC?, allowances?: { valveM, flangeM, supportM }, remove? }`                                                                                                           | V1 (built, §13.10); data only: stores `line.tracing`; omitted fields keep their value, `remove: true` deletes it; the takeoff lists the tracer length per line (tracers x (centreline + valves x valveM + flanges x flangeM + supports x supportM)); `line_heat_loss` reads `maintainTempC` · @failure unknown line `RTE_UNKNOWN_LINE`; first setting without type or tracers `RTE_TRACING_INVALID` |
| `export_pcf`              | query (V1)    | `{ lineIds?, confirmExportControlled }`                                                                                                                                                                          | `data = { files: [{ name, content, sha256, componentCount, countsByType, skipped, missingSkey, bolts, openEnds }], count, reviewRequired }`: one PCF per line (§6); refusals `RTE_UNKNOWN_LINE`, `RTE_NO_RUNS`, a broken run's code |
| `export_pipe_step`        | query (V1, `requiresKernel`) | `{ lineIds?, runIds?, schema?, includeValidationProperties?, fileName?, timestamp?, confirmExportControlled }`                                                                                     | exact STEP solids of the derived parts through `export_step_ap242` (§5.11); `data` = its data + `{ runs, lineIds }`; refusals as `export_pcf`, `XCH_WRITER_UNAVAILABLE` |
| `piping_connectivity`     | query         | `{ lineIds?, from?: portId, to?: portId }`                                                                                                                                                                       | `data = { nodes, edges, openEnds, path? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `check_piping`            | query         | `{ lineIds?, maxHandwheelCentreHeight?, minWeldSpacing?, include?: string[] }`                                                                                                                                   | `data = { status, issues: [{ code, severity, ids, paths, detail, remediation }], counts, unverified, reviewRequired }`                                                                                                                                                                                                                                                                                                                                                                      |
| `piping_takeoff`          | query         | `{ runId? , lineId? }`                                                                                                                                                                                           | `data = { counts, parts[], pipePieces[{ id, dn, cutLengthMm, leg }], joints[], totalPipeMm, centrelineLengthMm, legs[], turns[], studs, unverified }`                                                                                                                                                                                                                                                                                                                                       |
| `line_heat_loss`          | query (V1, built) | `{ lineId, fluidTempC, ambientTempC, outsideFilmWm2K, insideFilmWm2K?, steelConductivityWmK, insulationConductivityWmK? }`                                                                                       | `data = { heatLossWPerM, surfaceTempC, steelOuterTempC, resistances, diametersMm, lengthM, totalHeatLossW, tracing, defaults, provenance, reviewRequired: true }`; every defaulted input named (inside film neglected, conductivity from the spec row, bare pipe); `insideFilmWm2K` and `insulationConductivityWmK` are optional; refusals `RTE_UNKNOWN_LINE`, `RTE_SPEC_NO_COMPONENT`, `RTE_HEAT_LOSS_INPUT` |
| `route_problem`           | query (V2)    | `{ lineId, from, to, grid?, bendCost?, clearance?, preferElevations?, keepOut?: ids[] }`                                                                                                                         | `data = { problem, problemHash }`: grid box, cell size, inflated obstacle boxes, keep-outs, port stubs, integer-µm costs (input of `llull-compute route`, §2.A)                                                                                                                                                                                                                                                                                                                             |
| `auto_route_pipe`         | mutating (V2) | `{ lineId, from, to, grid?, bendCost?, clearance?, preferElevations?, keepOut?: ids[], maxExpansions?, solution?: { problemHash, pis, lengthMm, bends, cost, optimal, expansions, provenance } }`                | @affects creates 1 ordinary run · @invariant a supplied `solution` is validated against the current problem (§2.A) · @failure `RTE_AUTOROUTE_NO_PATH`, `RTE_AUTOROUTE_BUDGET`, `RTE_AUTOROUTE_SOLUTION_INVALID`                                                                                                                                                                                                                                                                             |

Descriptions follow AF-02: what, when, units, refusals, next command (e.g. `route_pipe` → "then run
`check_piping`; add valves with `insert_inline_component`").

Equipment nozzles: `add_nozzle` / `update_nozzle` belong to 03-parametric-equipment and only have to expose
`PortSpec` through `PortSource`. Supports: `add_pipe_support` gains `runId` (V1, **built in part 2, §13.10**) using the run centreline
(`piping_takeoff.legs`), so `check_pipe_supports` works on both pipe kinds; every reader of a support's carrier goes through one lookup
(`industrial/piping/pipeCarrier.ts`).

## 5. Algorithms

Notation: legs `L_i` from `P_i` to `P_{i+1}` (`P_0` = start point, `P_n` = end point), unit directions `u_i`,
lengths `ℓ_i`. Tolerances: geometric `ε = 1e-6 × max(1, |coordinates|)` in document units; angles `1e-9` rad
before the spec tolerance applies.

### 5.1 Legs from the compass

1. Start at the `from` port position. The first leg must leave along the port direction within the spec tolerance:
   `acos(u_0 · d_port) ≤ τ` (§5.2), else `RTE_PORT_DIRECTION` (a pipe cannot leave a nozzle sideways; V1 allows an
   immediate elbow at the face only when the spec allows flange-elbow fitting-to-fitting). A sloped first leg
   (SC-RTE-04, 0.573° off the horizontal port direction) is accepted with `deviationDeg` reported. The same rule
   applies to the arrival at the `to` port.
2. Axis legs `'+X'…'-Z'` map to unit vectors; vector legs are normalised. `planLength` + `slope` (§5.6) gives
   `u` and `ℓ`.
3. `via` points become PIs directly.
4. Closing leg: if `to` is a port at `T` with direction `d_T`, the pipe must arrive along `−d_T`. If
   `(T − P_last) × d_T = 0` and `(T − P_last) · (−d_T) > 0`, append the leg; otherwise `RTE_CLOSING_LEG_IMPOSSIBLE`
   with the remaining offset in `detail` (the agent adds a leg). SC-RTE-01: `T − P_last = (3000, 0, 0)`, `−d_T = +X`.
5. Collinear consecutive legs merge; a leg with `ℓ < ε` → `RTE_ZERO_LEG`.

### 5.2 Turns and elbow choice

Turn angle at `P_i`: `θ_i = acos(clamp(u_{i−1} · u_i, −1, 1))`. With spec angles `A` and tolerance `τ`:
pick `a ∈ A` minimising `|θ_i − a|`; accept when `|θ_i − a| ≤ τ`, report `deviationDeg`; otherwise
`RTE_NO_FITTING_FOR_ANGLE` (or a trimmed elbow when `trimmedAllowed`, V1, flagged `RTE_NONSTANDARD_FITTING`).
`θ ≥ 180° − τ` (reversal) is refused. Elbow occupies `c(a)` = catalogue centre-to-end on each adjacent leg.

- Standard elbows: `c` from the catalogue (B16.9 90° LR A, 45° LR B). B is **not** `R tan(22.5°)`: the
  difference reaches 3.4 mm at NPS 2 (`validation/data/b16_9_fitting_dimensions.json`), so formulas are never
  used for standard parts.
- Trimmed elbows / pulled bends (V1): `c = R tan(θ/2)` with `R` from the catalogue (1.5 D LR) or the bend radius.
- Elbow centreline arc: `s = R θ` (rad). Run centreline length = `Σ ℓ_i − Σ 2 c_i + Σ R_i θ_i`
  (SC-RTE-01: `12000 − 4·2·152 + 4·(π/2)·152 = 11 739.044` mm with `R = A` for a 90° elbow).
- Elbow centre (PCF CENTRE-POINT) = the PI; its ports at `P_i − c u_{i−1}` and `P_i + c u_i`.

### 5.3 Joint stack and cut-back

Along each leg, build the ordered list of **occupied intervals** `[s_k, e_k]` measured from `P_i`:

- leg start at a port: flanged → gasket `g` + mating flange length through hub `Y` (so pipe starts at `g + Y`);
  butt-weld → weld gap `w`; socket-weld → `−(socket depth − gap)` (V1, pipe enters the socket, B31.3 gap ≈ 1.6 mm
  [S18]);
- an elbow at the leg end: `[ℓ − c, ℓ]`; at the start: `[0, c]`;
- a tee on the leg (header): `[x − C, x + C]`; the branch leg starts at `M`;
- an olet: header not split; the branch run starts at the olet outlet (`height` from the catalogue);
- an inline flanged component of face-to-face `F` centred at `x`: `[x − F/2 − g − Y, x + F/2 + g + Y]` (component,
  two gaskets, two mating flanges); butt-weld inline (e.g. reducer `H`): `[x − H/2, x + H/2]`.

Sort by `s_k`; overlapping intervals → `RTE_INLINE_DOES_NOT_FIT` (inline) or `RTE_SEGMENT_TOO_SHORT` (fittings).
Each gap between consecutive intervals is a pipe piece with `cut = s_{k+1} − e_k − w_{joint}` (weld gaps from
the connection rule, default 0 = "centre-to-end includes the gap", named in the result). `cut < 0` → refuse;
`cut = 0` (|cut| ≤ ε) → `fittingToFitting` joint, warning `RTE_FITTING_TO_FITTING`; `0 < cut < minWeldSpacing`
→ warning `RTE_WELD_SPACING` with the named default `max(4 t, 50 mm)` (t = pipe wall) [S22] unless the line or
check gives `minWeldSpacing`.

SC-RTE-01 leg 0: `1500 − (3 + 76) − 152 = 1269`; leg 4: `3000 − 152 − 76 − 3 = 2769`.
SC-RTE-02 leg 0 with a 229 mm valve at 800 from the start (z 1800): `527.5` and `354.5`.

Joints: every interval boundary that is not a pipe piece end against another fitting is a joint; butt-weld count =
joints of kind `buttWeld`; flanged joints carry one gasket and one bolt set (`studs` from the catalogue row).

### 5.4 Flange sets and connection rules

For a joint between ends `a`, `b`: `rule = spec.connection(a, b)`; `null` → `RTE_NO_CONNECTION_RULE` (SC-RTE-05g).
`FL–FL` requires `gasket` and `boltSet` rows for (DN, rating); a missing row → `RTE_SPEC_NO_COMPONENT` naming the
row. Ratings / facings of both sides must match (`RTE_RATING_MISMATCH`, `RTE_FACING_MISMATCH`). At a port of
endType FL the routed side gets a mating flange chosen by `component(spec, { type: 'flange', dn, rating })`
(weld-neck default; slip-on / lap-joint by spec preference).

### 5.5 Branches

`fitting = spec.branch(spec, headerDn, branchDn)`. Tee / reducing tee: header leg split at `x` (§5.3), branch run
starts at the tee's third port `x + M · n` with `n ⟂ u_header` the branch direction (must be ⟂ within tolerance,
else `RTE_NO_FITTING_FOR_ANGLE`; laterals V1). Olet: branch port at `x + (OD_header/2 + height) n`. Stub-in: branch
pipe starts at the header surface; adds `RTE_STUB_IN_REVIEW` (`reviewRequired`, reinforcement per B31.3 is
checked in 07-pipe-stress-flexibility). A branch point inside another fitting's interval → `RTE_BRANCH_ON_FITTING`.

### 5.6 Slope

Slope `s` = percent/100, ratio, or `tan(deg)`. For a plan direction `h` (unit, horizontal) and plan length `ℓ_p`:
`u = normalise(h − s·sign·ẑ)` (sign +1 when `fall`), `ℓ = ℓ_p √(1 + s²)`, drop `= ℓ_p s`, slope angle `atan s`.
SC-RTE-04: `s = 0.01`, `ℓ_p = 8000` → drop 80, `ℓ = 8000.39999`, angle 0.572939°; turn into the vertical
`acos(80 / 8000.4) = 89.427061°`, deviation 0.572939° ≤ τ = 1° → standard 90° elbow. `check_piping`:
`RTE_ADVERSE_SLOPE` when a sloped line's leg rises along flow; V1 `RTE_POCKET` when the vertical profile has an
interior minimum (low point without a drain) or maximum (high point without a vent) on a line flagged
`gravity: true`.

### 5.7 Orthogonal stretch (move with connected)

When the port at the end of a run moves by `Δ` (equipment or nozzle edit), walk back from the moved end:

```
for i = n−1 down to 0:                 # leg i joins P_i -> P_{i+1}; P_{i+1} already moved by Δ
    a   = Δ · u_i                      # part absorbed by this leg
    ℓ_i = ℓ_i + a                      # leg i gets longer / shorter
    Δ   = Δ − a u_i                    # remainder, perpendicular to u_i
    if |Δ| ≤ ε: stop                   # fully absorbed
    P_i = P_i + Δ                      # carry the remainder to the previous PI
if |Δ| > ε at the start port  -> RTE_STRETCH_FAILED (run kept, marked broken, reported)
re-derive; any leg now too short -> RTE_STRETCH_FAILED
```

SC-RTE-06: `Δ = (500,0,0)` is absorbed by leg 4 (+X): cut 3269. `Δ = (0,500,0)` passes legs 4 (+X), 3 (+Z),
2 (+X) (their PIs move +500 Y) and is absorbed by leg 1 (+Y): cut `3500 − 304 = 3196`. Both ends moving (start
port too) apply the same walk forward from the start first. Deterministic and order-independent for one moved
end; documented as not minimal-change for both-ends moves.

### 5.8 Connectivity graph and checks

Nodes: every `PartPort` and every external port; edges: parts (internal) and joints (between parts) and
attachments (part port ↔ external port when positions agree within `ε` and directions are opposite within the
spec tolerance). Union-find gives connected components per line. Open end = part port of degree 0 not
attached (`RTE_OPEN_END`); external port of a nozzle with no run (`RTE_DISCONNECTED_PORT`, info). Across every
joint compare DN, rating, facing, end type (`RTE_*_MISMATCH`). `from` / `to` text vs the equipment tags reached by
the graph → `RTE_FROM_TO_MISMATCH`. Line numbers unique (`RTE_DUPLICATE_LINE_NUMBER`). Spec status ≠ approved or
any part `unverified` → `RTE_SPEC_UNVERIFIED` (warning; `unverified: true` on the line, AF-32).
Valve operators: handwheel centre = valve centre + stem direction × catalogue stem height; height above the
owning level > limit → `RTE_VALVE_OPERATOR_HEIGHT`; operator envelope (cylinder) vs other parts / steel →
`RTE_VALVE_OPERATOR_CLASH` (reusing `check_clashes` boxes). The limit has no built-in number (no public code
value, [S24]): it is a param or a project table, and the result names it.

Status = `fail` if any severity `error`, else `warn` if any warning, else `pass`.

### 5.9 Line-number template

Default template `{dn}-{service}-{sequence}-{spec}[-{insulationCode}{insulationThickness}]`, stored in
`plant.piping.settings.lineNumberTemplate` (V1 command `set_piping_settings`); results name it
(`"template": { "value": "...", "defaulted": true }`). Parsing a given `lineNumber` back into fields is
best-effort and reported, never silently corrected. SC-RTE-07: `80-HO-4001-CS150-H50`.

### 5.10 Insulation and heat loss

Envelope diameter `D_ins = OD + 2 t_ins` used by `check_clashes` (new clash kind `insulation`) and by
`check_pipe_supports` weight (insulation density from 01 when present). Heat loss per metre (V1), steady state,
series resistances (Bergman et al.; ht 1.2.0 [S19]; ISO 12241 calculation rules [S34]):

`Q' = (T_i − T_a) / [ ln(D_1/D_0)/(2π k_s) + ln(D_2/D_1)/(2π k_ins) + 1/(h_o π D_2) + 1/(h_i π D_0) ]`

Reference: NPS 3 Sch 40 with 50 mm insulation (k 0.0598535), 180 °C / 28 °C, `h_o` 22.697193 → 73.120 W/m.
Radiation and temperature-dependent k are V2. Result carries `reviewRequired: true` (AF-33).

### 5.11 Geometry (display)

Pipe piece: tube (existing `sweepRun` with a circle). Elbow: circle swept along the arc (24 steps per 90°).
Tee: two tubes + saddle approximation. Reducer: frustum. Flange: revolved profile (hub, plate, raised face) with
bolt-hole count from the row. Gasket: thin ring. Valve: body (box/cylinder by type) + stem + handwheel disc
(diameter from catalogue). Insulation: translucent tube / torus of `D_ins`. Layers `P-PIPE`, `P-FITT`, `P-FLNG`,
`P-VALV`, `P-INSU`, `P-TIE`. Exact solids (STEP) via `ctx.kernel` recipes in V1 (`requiresKernel` on that export
only).

### 5.12 Automatic routing (V2)

State = (grid cell, incoming axis); 6 axis moves; cost `g = Σ length + bendCost × bends + Σ penalties` (rack
elevation preference, keep-out, proximity). Heuristic `h = |Δx| + |Δy| + |Δz| + bendCost × b_min`, where `b_min`
is the minimum number of turns to reach the target arrival direction from the current direction over the axes
still to cover (lower bound ⇒ admissible, A* optimal [S28]). Obstacles = model boxes inflated by
`OD/2 + t_ins + clearance`; the first and last cells force a straight stub along the port direction of at least
the flange-set length + one elbow centre-to-end. Ties broken by axis order (+X, −X, +Y, −Y, +Z, −Z) for
determinism (AF-13); the open set is ordered by the total key (f, h, x, y, z, incoming axis), so any heap gives the same
expansion order. Result path → PIs (collinear merge) → an ordinary `route_pipe` run, so every check applies.
The production search runs natively in `llull-route` (§2.A): obstacles are not rasterised into a dense grid (2.4·10⁹
cells for 100 × 100 × 30 m at 50 mm); a cell is tested against a BVH of the inflated boxes and visited states live in
a hash map. The TS search in `autoRoute/` is the same algorithm, used for small grids and as the reference.
Literature: Lee maze routing [S27], A* [S28], ship engine-room routing [S29][S31], MILP / network flow with bend
costs [S30][S32], orthogonal visibility graphs [S33] (the latter as a speed-up when the grid is large).
SC-RTE-08: free space, length = Manhattan 6000, bends = 2 (three axes need three directions).

## 6. Interop and persistence

| Format                                | Direction             | What                                                                                                                                                                                                                                        | Owner                         |
| ------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| llull document JSON                   | read / write          | `plant.piping` (lines, runs, tie-ins, settings); derived parts not stored                                                                                                                                                                   | this gap                      |
| PCF (Alias, licensed spec [S26][S35]) | write (V1, built: `export_pcf`, §13.10), read (V2) | from `piping_takeoff.parts` + graph: PIPE / ELBOW / TEE / FLANGE / GASKET / BOLT / VALVE records with END-POINT (+ size), CENTRE-POINT (elbows, tees), BRANCH1-POINT; pipeline header with line number                                      | 05-isometrics-fabrication     |
| IFC 4.3                               | write (V1 built as IFC4, §13.10) | `IfcPipeSegment`, `IfcPipeFitting` (BEND, JUNCTION, TRANSITION, CONNECTOR), `IfcValve`, `IfcDistributionPort` + `IfcRelNests` / `IfcRelConnectsPorts`, `IfcDistributionSystem` per line; extends `building/exchange/ifcIndustrialExport.ts` | 08-plant-data-reports-interop |
| Stress neutral file (CAESAR II / PCF) | write                 | nodes at PIs, elbow radii, rigid valves / flanges with weights                                                                                                                                                                              | 07-pipe-stress-flexibility    |
| DEXPI                                 | read                  | line numbers, from / to, inline valves order for P&ID ↔ 3D check                                                                                                                                                                            | 04-pid-schematics             |
| DXF / sheets                          | write                 | plan sheets draw runs with fittings (existing `export_plan_sheet` extended)                                                                                                                                                                 | 05 / 09                       |

## 7. CLI / MCP / UI surfaces and error codes

- CLI: every command above via `llull <command> key=value` or `@params.json`; `llull run plan.json --validate`
  checks params and aliases (AF-05); `--json` returns `data`; `--dry-run` on every mutating command (AF-42).
- MCP: toolset `piping`; `search_tools "route pipe"` finds them; the toolset prompt holds the port convention
  and SC-RTE-01 as the minimal plan (AF-03).
- UI: route markers, open-end markers, issue list from `check_piping`, line list panel (08). Interactive compass
  emits `route_pipe` legs (viewport-engineer lane); no UI-only capability.

| Code                                                                                          | Severity                   | Raised by                                                        | Meaning                                                                                                                                            | Remediation                                                                                  |
| --------------------------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `RTE_UNKNOWN_LINE`                                                                            | error                      | all run commands                                                 | `lineId` not found                                                                                                                                 | `create_pipeline` first                                                                      |
| `RTE_UNKNOWN_PORT`                                                                            | error                      | `route_pipe`, `add_branch`                                       | port id not found                                                                                                                                  | list ports with `piping_connectivity` / `add_tie_in_point`                                   |
| `RTE_PORT_IN_USE`                                                                             | error                      | `route_pipe`                                                     | port already connected                                                                                                                             | route from the run end, or `add_branch`                                                      |
| `RTE_INVALID_PORT`                                                                            | error                      | `add_tie_in_point`                                               | zero direction, DN ≤ 0                                                                                                                             | give a unit direction toward the pipe and a DN                                               |
| `RTE_DUPLICATE_TAG` / `RTE_DUPLICATE_LINE_NUMBER`                                             | error                      | create commands, check                                           | not unique                                                                                                                                         | choose another tag / sequence                                                                |
| `RTE_SPEC_UNKNOWN`                                                                            | error                      | `create_pipeline`                                                | spec not loaded                                                                                                                                    | `import_pipe_spec` (01)                                                                      |
| `RTE_SPEC_NO_COMPONENT`                                                                       | error                      | derivation                                                       | no catalogue row for (type, DN, rating…)                                                                                                           | add the row to the spec or change size / rating                                              |
| `RTE_SPEC_AMBIGUOUS`                                                                          | error                      | derivation                                                       | several rows match, no preference                                                                                                                  | set a preference in the spec                                                                 |
| `RTE_NO_CONNECTION_RULE`                                                                      | error                      | derivation                                                       | end-type pair without a rule (e.g. BW–SW)                                                                                                          | add the rule in the spec or change the end type                                              |
| `RTE_NO_FITTING_FOR_ANGLE`                                                                    | error                      | `route_pipe`, `add_branch`, `convert_pipe_run`                   | turn angle not in spec ± tolerance                                                                                                                 | use 90 / 45 legs, or allow trimmed elbows in the spec                                        |
| `RTE_SEGMENT_TOO_SHORT`                                                                       | error                      | derivation                                                       | negative cut length (`detail.cutLengthMm`)                                                                                                         | lengthen the leg to ≥ sum of centre-to-ends                                                  |
| `RTE_ZERO_LEG`                                                                                | error                      | `route_pipe`                                                     | leg length 0                                                                                                                                       | remove the leg                                                                               |
| `RTE_PORT_DIRECTION`                                                                          | error                      | `route_pipe`                                                     | first / last leg not along the port direction                                                                                                      | start with a leg along the port direction                                                    |
| `RTE_CLOSING_LEG_IMPOSSIBLE`                                                                  | error                      | `route_pipe`                                                     | target port not reachable by one straight leg                                                                                                      | add legs; `detail.offset` gives the remaining vector                                         |
| `RTE_SIZE_MISMATCH` / `RTE_RATING_MISMATCH` / `RTE_FACING_MISMATCH` / `RTE_END_TYPE_MISMATCH` | error                      | `route_pipe`, check                                              | ports disagree and the spec has no transition                                                                                                      | add a reducer / change spec / fix the nozzle                                                 |
| `RTE_INLINE_DOES_NOT_FIT`                                                                     | error                      | inline commands                                                  | component overlaps a fitting                                                                                                                       | move it (`centreDistance`) or lengthen the leg                                               |
| `RTE_BRANCH_ON_FITTING` / `RTE_BRANCH_NO_TABLE_ROW`                                           | error                      | `add_branch`                                                     | branch point inside a fitting / no branch-table cell                                                                                               | move the point / extend the branch table                                                     |
| `RTE_HAS_BRANCHES`                                                                            | error                      | `delete_pipe_run`                                                | branch runs depend on it                                                                                                                           | `cascade: true`                                                                              |
| `RTE_STRETCH_FAILED`                                                                          | error (run marked broken)  | regeneration after an edit, `edit_route`                         | displacement not absorbable orthogonally                                                                                                           | re-route the run (`edit_route`)                                                              |
| `RTE_SLOPE_INVALID`                                                                           | error                      | `route_pipe`, `add_branch`, `create_pipeline`, `update_pipeline` | slope not > 0 and <= 100 %, on a non-horizontal leg, or without `planLength`                                                                       | give `planLength` and a slope up to 45 degrees on a horizontal leg                           |
| `RTE_FLAT_ON_SLOPED_LINE`                                                                     | warning                    | `check_piping`                                                   | a horizontal leg on a line or leg that declares a slope: it does not drain                                                                         | give the leg its fall, or accept the flat stretch                                            |
| `RTE_SUPPORT_OFF_RUN` | error | `convert_pipe_run` with `replace` | a support of the legacy pipe is farther than one outside diameter of the run from the new centreline (V1c: the other supports move onto the run) | keep the legacy pipe, or move / delete that support and convert again |
| `RTE_SUPPORT_ORPHAN` | reported (data.orphans, `ok` false) | `check_pipe_supports` | a pipe support names a pipe or run that no longer exists; the file still loads (V1c) | `delete_building_element` the support, or re-create the run and place it again |
| `RTE_TRACING_INVALID`                                                                         | error                      | `set_heat_tracing`                                               | the first tracing of a line without type or tracers                                                                                                | give type and tracers (1 to 6)                                                               |
| `RTE_HEAT_LOSS_INPUT`                                                                         | error                      | `line_heat_loss`                                                 | a film coefficient or conductivity not > 0, or a spec pipe row with no usable outside diameter and wall                                            | give positive inputs; fix the spec pipe row                                                  |
| `RTE_NO_RUNS`                                                                                 | error                      | `export_pcf`, `export_pipe_step`                                 | no routed run on the selected lines                                                                                                                | `route_pipe` first                                                                           |
| `RTE_EDIT_INVALID`                                                                            | error                      | `edit_route`                                                     | op parameters that do not fit, index out of range, a component or branch that cannot be re-placed                                                  | fix the params; move the component first                                                     |
| `RTE_TEMPLATE_INVALID`                                                                        | error                      | `set_piping_settings`                                            | line-number template unusable                                                                                                                      | `{sequence}` required, known placeholders only, no nested `[...]`                            |
| `RTE_OPEN_END`                                                                                | warning                    | `check_piping`                                                   | part port connected to nothing                                                                                                                     | route to a port, add a cap / blind, or a tie-in                                              |
| `RTE_DISCONNECTED_PORT`                                                                       | info                       | `check_piping`                                                   | nozzle / tie-in without a run                                                                                                                      | route it or mark it spare                                                                    |
| `RTE_FITTING_TO_FITTING`                                                                      | warning                    | check                                                            | zero cut length                                                                                                                                    | accept or lengthen                                                                           |
| `RTE_WELD_SPACING`                                                                            | warning                    | check                                                            | pipe piece shorter than the weld-spacing rule (named)                                                                                              | lengthen or accept per project spec                                                          |
| `RTE_ADVERSE_SLOPE` / `RTE_POCKET`                                                            | warning                    | check                                                            | sloped line rises along flow / low or high point                                                                                                   | fix the slope / add drain or vent                                                            |
| `RTE_FROM_TO_MISMATCH`                                                                        | warning                    | check                                                            | line from / to text ≠ connected equipment                                                                                                          | update the line or the route                                                                 |
| `RTE_VALVE_OPERATOR_HEIGHT` / `RTE_VALVE_OPERATOR_CLASH`                                      | warning                    | check                                                            | handwheel above the given limit / operator envelope clashes                                                                                        | rotate the stem, add a platform (06 STA), chain wheel                                        |
| `RTE_NONSTANDARD_FITTING`                                                                     | warning                    | check                                                            | trimmed elbow, pipe bend (V1 part 1, §13.9)                                                                                                        | reviewer accepts                                                                             |
| `RTE_ECCENTRIC_INVALID`                                                                       | error                      | `route_pipe`, `insert_inline_component`                          | an eccentric reducer without exactly one of `flat` / `flatDirection`, a flat on another component, top / bottom on a vertical pipe (V1)            | give `flat` "top" / "bottom" or a `flatDirection`                                            |
| `RTE_ECCENTRIC_OFFSET`                                                                        | error / warning            | derivation, `check_piping`                                       | the offset of an eccentric reducer cannot be taken up by the next leg (error), or only within the angle tolerance (warning, residual dropped) (V1) | turn the flat toward the next leg, move the reducer, or cancel it with an expander           |
| `RTE_STUB_IN_REVIEW`                                                                          | warning + `reviewRequired` | check                                                            | stub-in needs reinforcement check                                                                                                                  | 07 PST                                                                                       |
| `RTE_SPEC_UNVERIFIED`                                                                         | warning (cannot be hidden) | check                                                            | spec not approved / rows unverified                                                                                                                | reviewer approves the spec (01)                                                              |
| `RTE_AUTOROUTE_NO_PATH` / `RTE_AUTOROUTE_BUDGET`                                              | error                      | `auto_route_pipe`                                                | no path / expansion budget hit                                                                                                                     | widen the grid box, lower clearance, add via points; above the TS cap run `llull route auto` |
| `RTE_AUTOROUTE_SOLUTION_INVALID`                                                              | error                      | `auto_route_pipe` with `solution`                                | stale `problemHash`, leg off-grid / through an obstacle or keep-out, or length / bends / cost do not match the PIs                                 | re-run `llull route auto` on the current document                                            |
| `NATIVE_TOOL_MISSING`                                                                         | error                      | `auto_route` transport                                           | `llull-compute` not installed                                                                                                                      | install the desktop app, or route without `solution` under the TS cap                        |

## 8. Performance and robustness budgets

| Operation                                                        | Budget (desktop, Node 22, no kernel)                                                                                                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `route_pipe` 10 legs, derivation + geometry                      | ≤ 50 ms                                                                                                                                                                   |
| Regeneration of 1 000 runs (load)                                | ≤ 1.5 s                                                                                                                                                                   |
| `check_piping` 1 000 lines / 20 000 parts                        | ≤ 2 s (graph O(n α(n)); clash via existing boxes)                                                                                                                         |
| `piping_takeoff` one line                                        | ≤ 10 ms                                                                                                                                                                   |
| `auto_route_pipe` (V2) 100 m × 100 m × 30 m at 50 mm grid        | native `llull-compute route`: ≤ 5 s, `maxExpansions` default 2·10⁶, `--timeout` respected (AF-40); TS reference path: cap and time TBD — measure                          |
| Slope-preserving stretch fallback (V1, `solveKeepingDirections`) | dense solve, O(m³) in the leg count m; 60 legs ≈ 16 ms. Runs only when the orthogonal walk fails; beyond ~200 sloped legs per run it needs a sparse solve (measure first) |
| Supports on runs (V1 part 2)                                     | 100 runs with a shoe each (100 `add_pipe_support`, the building regenerated each time) ≤ 60 s; `check_pipe_supports`, `building_schedule`, `check_steel_members` ≤ 20 s each; any plant command re-checks the supports of the runs it changed ≤ 10 s; `export_pcf`, `export_ifc` of 100 lines ≤ 20 s |
| Document size                                                    | stored intent ≤ 1 kB per run; derived parts never stored                                                                                                                  |

Robustness: inputs with NaN / Infinity refused by the guard (`CMD_CORRUPT_RESULT` exists); all comparisons use
`ε`; ids depend only on route order (AF-13); a spec change that would invalidate a run is refused atomically.

## 9. Test strategy

| Level                                                                                                               | Content                                                                                         | VC                    |
| ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------- |
| Unit `tests/unit/plant/piping/legs.test.ts`                                                                         | compass legs, closing leg, collinear merge, port direction                                      | VC-RTE-01, 09         |
| Unit `fittings.test.ts`                                                                                             | turn angles, tolerance accept / refuse, catalogue centre-to-end, arc length                     | VC-RTE-03, 08, 11, 15 |
| Unit `jointStack.test.ts`                                                                                           | cut lengths (flanged, BW, inline valve), fitting-to-fitting, weld spacing                       | VC-RTE-01, 04, 10     |
| Unit `branches.test.ts`                                                                                             | branch table, tee / olet cuts                                                                   | VC-RTE-06             |
| Unit `stretch.test.ts`                                                                                              | +X / +Y moves, failure case                                                                     | VC-RTE-12             |
| Unit `graph.test.ts` / `checks.test.ts`                                                                             | open ends, mismatches, from / to, operator height, unverified                                   | VC-RTE-05, 07, 09     |
| Unit `heatLoss.test.ts`                                                                                             | ht example                                                                                      | VC-RTE-14             |
| Data test `catalogueConsistency.test.ts`                                                                            | reads `validation/data/*.json`: OD / wall agree with `PIPE_SIZES`; 90 LR A ≈ 1.5 NPS (≤ 0.4 mm) | VC-RTE-15, 16         |
| Golden `tests/golden/plans.ts`                                                                                      | SC-RTE-01, 02, 03, 06 as plans (id-normalised snapshots + replay equality)                      | VC-RTE-17             |
| Scenario `tests/unit/plant/scenarioPlans.test.ts`                                                                   | runs every `validation/plans/*.json` through `build_project` and compares `expected`            | all                   |
| Contract                                                                                                            | toolset `piping` membership, schema snapshot, plugin document extension (validate / restore)    | AF-01                 |
| Integration `tests/integration/`                                                                                    | `update_equipment` → run stretched; undo restores                                               | VC-RTE-12             |
| Server / CLI `server/tests/`                                                                                        | `llull run` on SC-RTE-01 with `--json` assertions                                               | VC-AF-02              |
| Native vs reference (`server/tests/routeNativeParity.test.ts`; `llull-route` cargo tests in `npm run native:check`) | TS and native searches give identical PIs, bends and cost; tampered solutions refused           | VC-RTE-18, 25         |

Coverage gate 90/85/90/90 applies to `packages/domain-aec/src/plant/**`.

## 10. Delivery plan

| Milestone | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Depends on                          | Effort                             |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ---------------------------------- |
| M0        | `@core/model/plant` types, `piping` plugin skeleton, document extension, `SpecLookup` + test stub                                                                                                                                                                                                                                                                                                                                                       | —                                   | 2 d                                |
| M1        | tie-in points, `create_pipeline`, `route_pipe` (legs, closing leg), elbows, BW joints, cut-back, `piping_takeoff`, display geometry                                                                                                                                                                                                                                                                                                                     | M0                                  | 6 d                                |
| M2        | flange sets + connection rules, inline components, reducers, branches (tee / olet), `check_piping` core codes, `piping_connectivity`, `convert_pipe_run`                                                                                                                                                                                                                                                                                                | M1; 01 PSC lookup (stub until then) | 7 d                                |
| M3        | stretch on equipment / nozzle edits, `edit_route`, slope + adverse slope, insulation envelope in `check_clashes`, line-number template, supports on runs                                                                                                                                                                                                                                                                                                | M2; 03 EQP nozzles (`PortSource`)   | 6 d                                |
| V1        | socket / threaded engagement, eccentric reducers, trimmed elbows / bends, pockets, valve operators, heat tracing data, `line_heat_loss`, PCF writer hand-off (05), IFC ports (08), exact solids via kernel; **part 1 built** (§13.9: socket / threaded, eccentric reducers, trimmed elbows / bends, valve operators + clash, clash bodies, slope-preserving stretch), **part 2 built** (§13.10: supports on runs through one carrier lookup, heat tracing, `line_heat_loss`, `export_pcf`, IFC with ports, `export_pipe_step`), **V1c review follow-ups built** (§13.11) | M3                                  | 12 d                               |
| V2        | `route_problem`, `auto_route_pipe` (TS grid A\* + solution validation), `llull-compute route` (RS-7), rack preference, keep-outs, multi-line ordering                                                                                                                                                                                                                                                                                                   | V1; RS-0 (`solver/` workspace)      | 15 d (+ `llull-route` inside RS-7) |

Total MVP (M0-M3) ≈ 21 developer-days.

## 11. Open questions

1. **Where equipment lives.** `EquipmentElement` is in the building model today; 03 EQP may move it to
   `doc.plant.equipment`. Routing only needs `PortSource`, so either works; the decision belongs to 03 / 08.
2. **Stored vs derived fittings.** This spec derives fittings (Smart 3D "features" [S21]); E3D stores components
   [S20]. Derived is simpler to keep consistent; overrides (V1) cover hand-picked parts. Confirm with 05 (weld
   numbers must stay stable: they key on joint ids, which are deterministic in route order).
3. **Weld gap default.** 0 ("centre-to-end includes the root gap") or a spec value (typ. 1.6-3 mm). Default 0,
   named in results; fabrication allowances belong to 05 ISO.
4. **Line-number template** per project: one template or per-service templates? Proposed one per document.
5. **Size keys.** DN integers internally; NPS display by 01. Metric-only (EN) specs map through the same keys.
6. **`add_pipe_run` future.** Keep for utilities and quick sketches, or retire behind `convert_pipe_run`?
   Proposed: keep, flag in `describe` that plant work should use `route_pipe`.
7. **Toolset size.** `piping` may exceed a comfortable MCP tool count with 01 / 05 commands; split
   `piping-route` / `piping-spec` if needed.
8. **Nozzle loads.** 07 PST needs nozzle ids on run ends; the `PortRef` already carries them.
9. **Nozzles on generic equipment.** 03 EQP's `add_nozzle` places shell nozzles by elevation + orientation angle
   and names ports `<tag>:<mark>` (`V-101:N1`). Pumps and `add_equipment` blocks also need an explicit
   `{ position, direction }` form, which the RTE plans use; to be agreed with 03. `PortRef.kind: 'nozzle'` resolves
   either form through `PortSource`.

## 12. References

- [R1] Autodesk, AutoCAD Plant 3D User Guide — About the Compass and Snaps; About Piping; About Placing Components and Valves — https://help.autodesk.com/cloudhelp/2023/ENU/Plant3D-UserGuide/ (accessed 2026-10) [S1]
- [R2] Autodesk, Plant 3D Spec Editor — About Branch Tables — https://help.autodesk.com/cloudhelp/2026/ENU/Plant3D-SpecEditor/files/GUID-7F6BEC75-9909-47D5-8BB3-67B956E22604.htm (accessed 2026-10) [S2]
- [R3] Hexagon, CADWorx documentation (bolts / gaskets) — https://docs.hexagonppm.com/r/en-US/CADWorx-Equipment/22/793347; Autodesk support "Cannot connect parts…"; IMAGINiT HDPE connection rules (accessed 2026-10) [S3][S4]
- [R4] AVEVA, Everything3D Model Reference / Design — https://help.aveva.com/AVEVA_Everything3D/2.1/DRMPGC/DRMPCM24.09.07.html (accessed 2026-10) [S20]
- [R5] Hexagon, Intergraph Smart 3D Piping — pipe features — https://docs.hexagonppm.com/r/en-US/Intergraph-Smart-3D-Piping/13.1/65730 (accessed 2026-10) [S21]
- [R6] ASME B31.3-2024; ASME B16.9-2024; ASME B16.5; ASME B16.10; ASME B36.10M — catalogue facts [S34]; dimension rows from manufacturer tables [S7]-[S17]
- [R7] ASTM C585-22; ISO 12241:2022 (https://www.iso.org/standard/74655.html); IEEE 515-2017 (accessed 2026-10) [S34]
- [R8] C. Bell, fluids 1.3.1 and ht 1.2.0 (MIT) — https://pypi.org/project/fluids/, https://pypi.org/project/ht/ (accessed 2026-10) [S5][S19]
- [R9] Bergman T. L., Lavine A. S., Incropera F. P., DeWitt D. P., Introduction to Heat Transfer, 6th ed., Wiley, 2011 [S19]
- [R10] Lee C. Y., IRE Trans. Electronic Computers EC-10(3):346-365, 1961 [S27]
- [R11] Hart P. E., Nilsson N. J., Raphael B., IEEE Trans. SSC 4(2):100-107, 1968 [S28]
- [R12] Park J. H., Storch R. L., Expert Systems with Applications 23(3):299-309, 2002 [S29]
- [R13] Blanco V. et al., Omega 111:102659, 2022; arXiv 2108.00416 [S30]
- [R14] Stanczak M. et al., ICORES 2020 — https://www.scitepress.org/Papers/2020/89233/ [S32]; Marriott K. et al., Diagrams 2014 [S33]; Wu H. et al., BIT improved A\* [S31]
- [R15] CADMATIC PCF export; SST CAEPIPE PCF data types — https://www.sstusa.com/docs/users_manual/data_types_from_caepipe.htm (accessed 2026-10) [S26]
- [R16] RS1 native compute programme — [../../decisions/RS1-native-compute.md](../../decisions/RS1-native-compute.md)

## 13. As built (RS1 RS-7 plant slice 2026-10-19; RTE-M1, RTE-M2, RTE-M3, RTE-V1 parts 1 and 2 2026-10-24)

Built: the V2 auto-router (§2.A, §5.12) end to end (2026-10-19), and **M1 (2026-10-24, §13.6)**: spec-driven `route_pipe`
(compass legs, closing leg, spec elbows with deviation, joint stack and cut-back, flange sets at flanged ports), `piping_takeoff`,
one derivation of parts and joints for every run (auto-routed runs included), per-part display geometry, `SpecLookup` over
01 PSC and `PortSource` over tie-ins, equipment nozzles and run ends. **M2 (2026-10-24, §13.7)** added inline valves and reducers, branches (tee / olet / stub-in), `check_piping`, `piping_connectivity`, `convert_pipe_run` and `update_pipeline`. **M3 (2026-10-24, §13.8)** added orthogonal stretch on equipment / nozzle / tie-in moves, `edit_route`, sloped legs with `RTE_ADVERSE_SLOPE` / `RTE_POCKET`, line insulation from the spec table with its envelope in `check_clashes`, and the line-number template (`set_piping_settings`). Not built: supports on runs (V1, §13.8), `line_heat_loss` (V1), eccentric reducers, trimmed elbows, valve operator clash.

### 13.1 What exists

| Part                                                                 | Where                                                                                                       | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CadDocument.plant` (`PlantModel { piping? }`)                       | `packages/core/src/model/plant.ts`                                                                          | Types only. `PipingModel` = tie-ins, lines, runs (+ order lists); `clear_document` removes the slice                                                                                                                                                                                                                                                                                                                                 |
| Plugin `piping`, toolset `piping`                                    | `packages/domain-aec/src/plant/piping/` (installed in `src/app/plugins.ts`)                                 | Toolset getter = legacy `PIPING_TOOLS` + plugin commands + the `auto_route` transport                                                                                                                                                                                                                                                                                                                                                |
| `add_tie_in_point`, `create_pipeline`                                | `commands/tieIn.ts`, `commands/pipeline.ts`                                                                 | §4 params subset; `RTE_INVALID_PORT`, `RTE_DUPLICATE_TAG`, `RTE_DUPLICATE_LINE_NUMBER`; `create_pipeline` resolves the spec through `SpecLookup` (`RTE_SPEC_UNKNOWN`, `RTE_SPEC_NO_COMPONENT` for a DN without a pipe row); line number from the §5.9 template (named in `data.template`)                                                                                                                                            |
| `route_problem` (query)                                              | `commands/autoRoute.ts`, `autoRoute/problem.ts`                                                             | `data = { problem, problemHash, defaults, elbowCentreToEnd, flangeSetLengths, portOwners, unverified, unverifiedReasons, tsMaxExpansions }` (since M1 the elbow A and flange sets come from the line spec); `problemHash` = sha256 of the canonical problem JSON                                                                                                                                                                     |
| `auto_route_pipe` (mutating)                                         | `commands/autoRoute.ts`, `autoRoute/search.ts`, `autoRoute/solution.ts`                                     | TS A\* under `TS_MAX_EXPANSIONS` = 200 000, or `solution` checked by `checkSolution` (§2.A list) and committed; `data` per SC-RTE-08 (`centrelineToPiLengthMm`, `bends`, `cost`, `optimal`, `expansions`, `engine`, `problemHash`) plus `parts`, `totalPipeMm`, `unverified`, `unverifiedReasons`; since M1 the committed run must derive (else refused with the derivation code) and the elbow A and flange sets come from the spec |
| Run geometry                                                         | `derive.ts`, `routeParts.ts`, `geometry.ts`                                                                 | One derived read-only revolution entity per drawable part of every run (id `<runId>/<kind>-<k>`, §13.6); omitted from saved files, re-derived on load; derivation guard (replaces the single mitred mesh per run of the V2 slice)                                                                                                                                                                                                    |
| Native search                                                        | `solver/crates/llull-route` (`llull-compute route <folder>`)                                                | Contract in `llull_route::job` (job.json `{ problemHash, problem, maxExpansions }` → result.json `{ status, pisUm, lengthUm, bends, cost, optimal, expansions, engine, version }`)                                                                                                                                                                                                                                                   |
| Transport `auto_route` (CLI `llull auto_route lineId=… from=… to=…`) | `server/src/native/autoRoute.ts`, `tools.ts`                                                                | `route_problem` → job → `auto_route_pipe { …, solution }`; `NATIVE_TOOL_MISSING` without the binary                                                                                                                                                                                                                                                                                                                                  |
| Tests                                                                | `tests/unit/plant/piping/*.test.ts`, `server/tests/routeNativeParity.test.ts`, cargo tests of `llull-route` | VC-RTE-18 (SC-RTE-08 data), VC-RTE-25 (parity, validation, budget)                                                                                                                                                                                                                                                                                                                                                                   |

### 13.2 Algorithm as built (both engines)

- **Lattice and units.** Every length of the problem is an integer number of µm (`round(mm × 1000)`; inflated boxes rounded
  outward). Lattice points = `originUm + cell × cellUm`; origin = end of the `from` stub. A problem whose two stub ends are not
  on one lattice is refused (`RTE_AUTOROUTE_NO_PATH`, path `grid`). Ports must face an axis (`RTE_PORT_DIRECTION`).
- **Stubs and minimum legs.** Stub = LR 90 elbow centre-to-end A (+ gasket + hub length of the spec flange set on an FL port, M1), rounded up to whole
  cells. A turn moves `minLegCells = ceil(2A / cell)` cells along the new axis in one step, so every leg that starts with a
  bend holds two elbows; straight moves are one cell. Reversals are never generated. This replaces "force a straight stub" of
  §5.12 with an exact graph: the search is optimal over routes whose legs fit their elbows.
- **State, cost, heuristic.** State = (cell, incoming axis). `g` = lattice length + `bendCost × bends` +
  `offElevationPenaltyPerCell × horizontal cells off every preferred elevation` (stubs are a constant and are not counted).
  `h` = Manhattan µm + `bendCost × b_min`, `b_min` = number of signed directions still needed (each non-zero axis offset
  plus the arrival direction) minus 1 when the current direction is one of them (a lower bound ⇒ admissible).
- **Determinism (AF-13).** Moves in axis order +X, −X, +Y, −Y, +Z, −Z; the open set is ordered by the total key
  (f, h, i, j, k, axis); an entry is stale when its g is not the state's best g; a state's best g / parent change only on a
  strictly smaller g (re-expansion allowed, so optimality does not need a consistent heuristic). `expansions` counts states
  whose moves were generated; the budget stops before the next expansion. TS and Rust give identical PIs, cost and expansion
  count on every tested problem (VC-RTE-25).
- **Obstacles.** Every 3D entity's world AABB (run meshes excluded), every leg of an existing run (inflated by both radii,
  so lines routed one after the other avoid each other — the "multi-line ordering" of V2 is sequential calls in the agent's
  order), `keepOut` entity ids and `keepOutBoxes`, all inflated by OD/2 + insulation + clearance. A move is blocked when the
  segment enters the open box (touching a face is clear). An obstacle whose inflated box strictly contains a port point is
  that port's owner: it is listed in `portOwners` and ignored for the stub check only (the search still avoids it); a
  `keepOut` entity is never an owner. A stub that runs into another obstacle is refused before searching. The TS search scans
  the boxes linearly; `llull-route` uses an integer AABB tree (same boolean) and a paged sparse state store (4×4×4-cell pages,
  nothing allocated for unvisited space). The problem keeps every obstacle that touches the lattice box or either stub;
  inverted `keepOutBoxes` corners are normalised.
- **Limits and trust.** A grid box of more than 2⁵³ − 1 states (cells × 6) is refused (`RTE_AUTOROUTE_BUDGET`, path
  `gridMargin`; the TS keys are exact numbers only up to there, and `llull-route` validates the same limit). Every route,
  the in-process search's included, passes `checkSolution` before it is committed; committed PIs are snapped to whole µm.
  `optimal`, `expansions` and `engine` of a supplied solution are caller-asserted and recorded as given (the route itself is
  checked). Native `maxExpansions` is clamped to 2·10⁷. A route may bend at the start cell (leg 0 lattice length 0) but not
  at the goal cell, as in the search graph.

### 13.3 Measured (2026-10-19, development laptop, Windows 11, `compute` profile, GNU toolchain 1.97.0)

| Case                                                                                                  | Expansions | Time                                                                       |
| ----------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------- |
| SC-RTE-08 free space (TS and native)                                                                  | 110        | < 1 s incl. process start                                                  |
| 200 × 100 × 100 m box at 50 mm (1.6·10¹⁰ cells), wall at x = 50 m with a window 1 m off the port line | 1 761 410  | native 3.65–3.98 s; TS refuses `RTE_AUTOROUTE_BUDGET` at 200 000 (≈ 1.7 s) |

The TS cap (§8 "TBD") is set to 200 000 expansions: ≈ 1.7 s in Node 24 on the same machine. Native ≈ 2.1–2.3 µs per
expansion, so 2·10⁶ expansions ≈ 4.5 s (inside the 5 s budget here; the reference-machine time stays TBD).

### 13.4 Decisions (provisional unless stated)

- **D2 (one plant home), provisional.** Followed the README recommendation with the least commitment: one optional core slice
  `doc.plant` holding `piping` only; folder `packages/domain-aec/src/plant/piping/`; plugin `piping`. Other plant areas add
  their own sub-record and plugin. Revisit when 01 PSC / 03 EQP land.
- **D1 (`pipeSizes.ts` ASME / EN mix): not needed by routing.** The router reads only the OD of the line DN (DN50–200 are equal
  in EN 10220 and B36.10M; DN65 / DN125 differ by ≤ 3.1 / 1.6 mm, which only shifts the clearance envelope). Walls are not
  used. The bug stays open for its own fix (README D1).
- **Spec catalogue absent (01 PSC not built): superseded by M1 (§13.6).** The V2 slice read the elbow A from a private table
  (`sizes.ts`) or the `elbowCentreToEnd` / `flangeSetLength` params; both are removed. Every dimension now comes from the line's
  spec through `SpecLookup`.
- **Data model subset.** `PipingModel` has no `counters` (ids come from `nextId`); since M1 it has `entityIds` (§13.6) and `PortRef`
  has `tieIn`, `nozzle` and `runEnd`; `PipeRun` has no `inline` / `branches` / `legDn` / `legSlopes` yet; `PipeLine` has
  no `runIds` (derivable). Tie-ins have no marker geometry yet. Runs record `autoRoute { problemHash, cost, bends,
expansions, optimal, engine }`.
- **CLI verb.** The transport is `llull auto_route …` (one tool name like the other native transports), not the two-word
  `llull route auto` of §2.A.
- **Rack preference.** `preferElevations` (z list, mm) + `elevationPenalty` (extra cost per mm of horizontal pipe off every
  preferred elevation, named default 0.5). Penalties are ≥ 0, so the heuristic stays admissible.
- **Not done in V2:** parallel candidate searches (rayon) and automatic ordering of several lines (the agent routes them in
  sequence); orthogonal visibility graphs [S33].

### 13.5 Open questions answered

- §11.3 weld gap (M1): default 0 ("centre-to-end includes the root gap"), read from the connection rule, named in every `route_pipe`
  result as `weldGap { valueMm, defaulted: true }`; a gap `w` is deducted from the piece at each butt-weld end.
- §11.7 toolset size: `piping` holds 13 tools after M1; no split needed yet.
- §11.1 (2026-10-23, README D6): equipment stays a building `EquipmentElement` with `plant` data; routing reads it through
  `PortSource`. §11.9 (README D3): `add_nozzle` takes the angle or the free `{ position, direction }` form; `PortRef.kind:
'nozzle'`, id `<tag>:<mark>`. §11.2: derived fittings (01 §11 Q6).

### 13.6 RTE-M1 as built (2026-10-24, plant 02 milestone M1 plus what SC-RTE-01 needs end to end)

| Part             | Where (`packages/domain-aec/src/plant/piping/`)                                                                                                                      | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `SpecLookup`     | `specLookup.ts`                                                                                                                                                      | In-process adapter over 01 PSC `resolveComponent` over `doc.plant.spec` and the catalogues the spec names (`specCatalogs`). `pipe(dn)`, `component({ types, dn, rating?, facing? })`, `elbowAngles()`, `connection(a, b)`, `status()`. PSC `PSC_AMBIGUOUS_COMPONENT` → `RTE_SPEC_AMBIGUOUS`, every other miss → `RTE_SPEC_NO_COMPONENT`, no spec → `RTE_SPEC_UNKNOWN` (the PSC code stays in `detail`). Rows carry `unverified` (not every dimension grade A) |
| `PortSource`     | `ports.ts`                                                                                                                                                           | `resolvePortId(doc, id)` → `PortSpec` + `PortRef`: tie-in id, equipment nozzle `<tag>:<mark>` (through `equipmentPorts`, end type FL), run end `<runId>:start                                                                                                                                                                                                                                                                                                 | end`(a BW pipe end that continues the pipe).`portOccupant`gives`RTE_PORT_IN_USE` for all three |
| `route_pipe`     | `commands/routePipe.ts`, `legs.ts`                                                                                                                                   | §4 params without `dn`, `planLength`, `slope` (M2, M3). Compass or vector legs, `via` points, straight closing leg to a port on its axis, collinear merge, port direction within the tolerance (deviation reported)                                                                                                                                                                                                                                           |
| Elbows           | `fittings.ts`                                                                                                                                                        | Nearest spec angle within the tolerance, catalogue centre-to-end, `deviationDeg` reported, 60° or a reversal → `RTE_NO_FITTING_FOR_ANGLE` (`error.detail.anglesDeg`)                                                                                                                                                                                                                                                                                          |
| Joint stack      | `jointStack.ts`, `routeParts.ts`                                                                                                                                     | Occupied intervals per leg → pipe pieces with cut lengths; `RTE_SEGMENT_TOO_SHORT` (`error.detail.cutLengthMm`), fitting-to-fitting (no piece, warning), weld spacing warning with the named default `max(4 t, 50 mm)`. `Interval.kind: 'inline'` and `RTE_INLINE_DOES_NOT_FIT` exist for M2 and are unit-tested with the SC-RTE-02 numbers (527.5 / 354.5)                                                                                                   |
| Flange set       | `flangeSet.ts`                                                                                                                                                       | At an FL port: weld-neck flange + gasket + bolt set from the spec; `RTE_RATING_MISMATCH`, `RTE_FACING_MISMATCH`, `RTE_SPEC_NO_COMPONENT` naming the missing dimension                                                                                                                                                                                                                                                                                         |
| Derivation       | `routeParts.ts`                                                                                                                                                      | `deriveRun(doc, run)` → `RoutedPart[]`, `Joint[]`, legs, turns, warnings, totals; ids `<runId>/<kind>-<k>` (k per kind, route order; the start flange set is numbered before the end one) and `<runId>/joint-<k>`. One derivation for `route_pipe` and `auto_route_pipe` runs                                                                                                                                                                                 |
| Display          | `geometry.ts`, `derive.ts`                                                                                                                                           | One `revolution` entity per pipe piece, elbow, flange and gasket (bolt sets have none); layers `P-PIPE`, `P-FITT`, `P-FLNG`; ids kept in `plant.piping.entityIds`; guard, load-time re-derivation                                                                                                                                                                                                                                                             |
| `piping_takeoff` | `takeoff.ts`, `commands/pipingTakeoff.ts`                                                                                                                            | `runId` / `lineId` / neither; counts by `typeKey` + `pipePieces`, `studs`, joint kinds; `parts`, `pipePieces` (cut lengths), `joints`, `totalPipeMm`, `centrelineLengthMm`, `legs`, `turns`, `warnings`, `unverified` + reasons                                                                                                                                                                                                                               |
| Validation data  | `docs/plant/02-spec-driven-routing/validation/data/catalog_stub_cs150.json`, `spec_cs150.json`                                                                       | The PSC-format stand-in of `spec_stub_cs150.json`: catalogue `rte-validation-stub` (the plans' input dimensions) searched before `llull-open-piping`, and spec CS150 (draft). Plans SC-RTE-01, 02, 03, 04, 05, 07, 08 import both first                                                                                                                                                                                                                       |
| Tests            | `tests/unit/plant/piping/{legs,fittings,jointStack,specLookup,ports,routeParts,routePipe,takeoff,geometry,rteScenarioPlans}.test.ts`, golden `piping_pump_to_vessel` | SC-RTE-01: cuts 1269 / 2696 / 2696 / 1196 / 2769, total 10 626, centreline 11 739.044, 4 elbows, 2 weld-neck flanges, 2 gaskets, 2 bolt sets (16 studs), 10 butt welds, 2 flanged joints (VC-RTE-01..03, 17, 23)                                                                                                                                                                                                                                              |

Decisions (owner delegated: long-term quality over the cheap path; no backward compatibility):

- **Dimensions only from the catalogue.** The stub catalogue gives the plans' inputs (elbow A 152, hub Y 76, gasket 3.0, 8 studs); it is
  `unverified` except the quoted grade A flange dimensions, so every SC-RTE-01 result says so (AF-32). The bundled `llull-open-piping`
  has A = 152.4 and no hub length or gasket thickness: a flanged port on a spec that resolves only to it is refused with
  `RTE_SPEC_NO_COMPONENT` naming `lengthThroughHub` / `thickness`, never guessed. Dimension names read: `centreToEnd`, `lengthThroughHub`
  (new, flange), `thickness` (gasket), `boltCount` (bolt set, else the flange row, named in the result), `outsideDiameter`, `wall`.
- **Unknown spec is an error** (`create_pipeline` → `RTE_SPEC_UNKNOWN`), and so is a spec that names a catalogue that is not loaded:
  routing would silently read the next catalogue's dimensions. `elbowCentreToEnd` / `flangeSetLength` params and `sizes.ts` are removed
  (no compatibility); every test and plan that creates a line imports the stub catalogue and spec first.
- **Elbow arc radius** `R = c / tan(θ / 2)` from the catalogue centre-to-end `c` and the actual turn, so the arc is tangent to both ports;
  R = A for 90° (centreline formula of §5.2 unchanged), and a 45° elbow uses its tabulated B (64), not `R tan 22.5°`.
- **Tolerance** = run `angleToleranceDeg`, else the spec's `elbowAngles.toleranceDeg`, else the named default 1° (the override is bounded at 22.5°; when the spec declares
  no `elbowAngles` the angles come from its elbow90 / elbow45 components). It also bounds the port-direction deviation of the first and last leg.
- **Connection rules** are a small built-in table (`BW–BW` butt weld, `FL–FL` flanged; gap 0 named) because the PSC spec format has no
  connection rules yet; any other end-type pair (e.g. a socket-weld tie-in) → `RTE_NO_CONNECTION_RULE`. A nozzle's end type is always FL.
- **Weld gap** `w` is deducted from a pipe piece at each of its butt-weld ends (a piece between two welds loses `2 w`); default 0.
- **Derivation failures** after the fact (a port, line or spec changed under a stored run): `piping_takeoff` with `runId` refuses with the
  code, without it skips the run and lists it; `restore` marks such a run broken without geometry instead of throwing. Failure paths name the merged leg: `legs.<n>`.
- **Reconcile (L8: derived entities always equal what a load re-derives).** Core gains an optional `DocumentExtension.reconcile(previous, next)`
  returning `{ document, notes, affected }`, applied by ONE helper, `applyReconcile(before, result)` (`plugins/host.ts`), to every mutating result:
  `execute` at top level and nested inside a running step (build_project loops, composite commands), and history replay after each replayed step
  (`runReplayStep`), always after the command and before the guards. Notes are appended to the summary and the re-derived ids to `affected` (and so
  to the recorded step). It is skipped for queries, session / meta-history commands, rejections and no-ops, and costs nothing when no extension
  depends on the change (same document object). The piping extension re-derives a run when the spec, a catalogue, the run's line, a tie-in it
  connects, or the port of a nozzle it connects changed (a building edit is first short-circuited when the equipment element and its level are the same
  objects); runs a command created itself are not skipped, their ports are compared like any other. A run that no longer derives is marked
  `broken { code, reason }` (stored, spec §3.1) and its entities are dropped: a port that moved or was turned away from the routed end gives
  `RTE_STRETCH_FAILED` (position, or direction beyond 1e-4°; stretch is M3), a gone port `RTE_UNKNOWN_PORT`, a resized / re-rated nozzle
  `RTE_SIZE_MISMATCH` / `RTE_RATING_MISMATCH`; a later edit that makes it derivable again clears the mark and redraws it. Live reconcile and `restore` share
  one guarded run-state function (a throw on corrupt data breaks the run, never the command), so a load shows the same state. The note lists only
  runs whose broken code changed. `piping_takeoff` without `runId` skips broken runs and lists them in `data.brokenRuns`. The guard still refuses
  atomically a spec or catalogue edit that would leave a derivable run underivable; benign edits are re-derived, not refused. A composite command is reconciled nested and again
  as a whole (idempotent; the second pass is cheap when nothing relevant changed, and surviving parts keep their draw-order position); the guard derives
  runs again on a spec edit only. Contract test:
  `tests/unit/contract/reconcile.test.ts` (stub extension); piping: `tests/unit/plant/piping/reconcile.test.ts` (live = replay = load).
- **`CommandError.detail`** (core, additive): machine-readable facts of a refusal (`detail.offset`, `detail.angleDeg`, `detail.cutLengthMm`)
  as §7 and the SC-RTE-05 rows name them; `tableRejection` takes it as an optional last argument.
- **`route_pipe` data stays compact** (a mutating step's `data` over 4000 characters is dropped from `build_project` reports): legs with
  cut lengths, turns, counts, pipe pieces, totals, warnings, trust and `partIds`; parts and joints are in `piping_takeoff`.
- **Display geometry is revolution entities**, not meshes: exact torus segment for the elbow (16-point section, 24 steps per quarter, the
  Pappus volume of VC-RTE-23), solid cylinders for pipe pieces (display envelope, no bore), bored flange and gasket. Closed-form mass
  properties and the kernel recipes of `revolution` apply.
- **Ports.** Port id grammar: tie-in id, then `<runId>:start|end`, then `<tag>:<mark>`. A run end that is already connected to a port counts
  as in use. `delete_pipe_run` refuses a run another run continues from (`RTE_HAS_BRANCHES`, delete the dependent first) and deletes all its entities.
- **Counts keys** are the PSC component types (`elbow90LR`, `flangeWeldNeck`, `gasketSpiralWound`, `boltSet`) plus `pipePieces`, `studs`
  and joints by kind (`buttWelds`, `flangedJoints`, `fittingToFitting`, ...); the plans' old names (`flangeWN`, `gasket`) were renamed.

Not built in M1 (M2 built most of it, see §13.7; stretch, slope, `edit_route`, insulation and supports on runs stay open): `insert_inline_component` / `move_inline_component`, reducers and `legDn`, `add_branch`, `check_piping`,
`piping_connectivity`, `edit_route`, `convert_pipe_run`, `update_pipeline`, slope legs (`planLength`, `slope`, §5.6), orthogonal stretch
(§5.7), insulation envelope, supports on runs, `RTE_FROM_TO_MISMATCH`. SC-RTE-02 steps 8+ (valve), SC-RTE-03, 04, 06, 07, 09 and the `check_piping`
steps of SC-RTE-01, 05, 08 stay blocked; their plans say so (`unbuilt`, `blockedFrom`) and `rteScenarioPlans.test.ts` keeps those lists honest.

### 13.7 RTE-M2 as built (2026-10-24, plant 02 milestone M2)

Built: flange sets on valve faces, inline valves and concentric reducers, branches (tee, reducing tee, olets, stub-in), `check_piping` core codes,
`piping_connectivity`, `convert_pipe_run`, `update_pipeline`. SC-RTE-01, 02, 03, 05 and 09 run end to end; the `check_piping` steps of SC-RTE-04 and 08 run
(SC-RTE-04 stays blocked at its slope legs, SC-RTE-06 at stretch, SC-RTE-07 at insulation and `line_heat_loss`: M3 / V1).

| Part                    | Where (`packages/domain-aec/src/plant/piping/`)                                                                                                                                                                                                                                                                                                 | Notes                                                                                                                                                                                                                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run state               | `routeEnv.ts`, `routeEnds.ts`, `routeInline.ts`, `routeBranch.ts`, `routeParts.ts`, `deriveTypes.ts`, `runSizes.ts`                                                                                                                                                                                                                             | `deriveRun` splits each leg into slots (end sets, elbows, valves, reducers, tees) sorted along the leg and cuts the pipe between them with the M1 joint stack; olets and stub-ins sit on a pipe piece afterwards. `PipeRun` gains `dn?`, `inline?`, `branches?`; `PortRef` gains `branch`                 |
| Valves                  | `routeInline.ts`                                                                                                                                                                                                                                                                                                                                | Catalogue `faceToFace`; `FL` ends give a weld-neck flange + gasket + bolt set per face (the same `resolveFlangeSet` as a nozzle, with the valve row's rating and facing), `BW` ends none; any other end type is `RTE_NO_CONNECTION_RULE`. Occupies `F + 2 (g + Y)` (flanged) or `F`                       |
| Reducers                | `routeInline.ts`, `runSizes.ts`                                                                                                                                                                                                                                                                                                                 | Concentric, row `length` (`H`), occupies it centred; the run continues at `dn2`                                                                                                                                                                                                                           |
| Branches                | `routeBranch.ts`, `commands/addBranch.ts`                                                                                                                                                                                                                                                                                                       | Fitting = branch-table cell of the HEADER line's spec for (header size at the point, branch size): `SpecLookup.branch()` over PSC `resolveBranch` (`PSC_BRANCH_UNDEFINED` -> `RTE_BRANCH_NO_TABLE_ROW`)                                                                                                   |
| Checks, graph           | `checks.ts`, `graph.ts`, `commands/checkPiping.ts`, `commands/pipingConnectivity.ts`                                                                                                                                                                                                                                                            | See the rules below                                                                                                                                                                                                                                                                                       |
| Conversion, line update | `commands/convertPipeRun.ts`, `commands/updatePipeline.ts`                                                                                                                                                                                                                                                                                      |                                                                                                                                                                                                                                                                                                           |
| Run commands            | `commands/inlineComponents.ts` (`insert_inline_component`, `move_inline_component`, `remove_inline_component`), `commands/addBranch.ts`, `commands/deleteRun.ts` (`cascade`), `commands/routePipe.ts` (`inline`), `runUpdate.ts` (`rederive`: derive the changed runs and every run attached to them and rebuild their entities, or fail whole) |                                                                                                                                                                                                                                                                                                           |
| Display                 | `geometryInline.ts`                                                                                                                                                                                                                                                                                                                             | Valve = body + stem + handwheel disc on layer `P-VALV` (ids `<valve>`, `<valve>/stem`, `<valve>/wheel`), reducer frustum, tee = header cylinder + `<tee>/branch` stub, olet cylinder, stub-in none. Schematic: the proportions are named display constants, a catalogue `stemHeight` sets the stem length |
| Tests                   | `tests/unit/plant/piping/{inlineComponents,inlineVariants,branches,branchPorts,checks,convertPipeRun,updatePipeline,rteScenarioPlans}.test.ts`, golden `piping_gate_valve`, `piping_header_branches`, `piping_reducer_run`, `piping_legacy_conversion`                                                                                          | Coverage of `plant/piping/**`: 97.96 % statements, 92.57 % branches, 99.11 % functions, 99.36 % lines (measured 2026-10-24 with `tests/unit/plant`)                                                                                                                                                       |

Validation numbers (hand calculations from the stub catalogue, never copied from an output of llull):

- SC-RTE-02: valve F-F 229 centred at 800 on a leg starting at z 1000: faces z 1685.5 / 1914.5; cuts `(1685.5 - 3 - 76) - (1000 + 3 + 76) = 527.5` and
  `(2500 - 152) - (1914.5 + 3 + 76) = 354.5`; the run then has 6 pieces (527.5, 354.5, 2696, 2696, 1196, 2769), 4 flange sets (4 WN, 4 gaskets, 4 bolt
  sets, 32 studs), 12 butt welds and 4 flanged joints; the handwheel centre z 1800 is over the explicit 1500 limit: one `RTE_VALVE_OPERATOR_HEIGHT` on the valve id.
- SC-RTE-03: 6x6x4 reducing tee at 4000 (C 143, M 130): header 3857 / 5857, branch `2000 - 130 = 1870`; weldolet 6x2 at 7000 with the outlet face A = 144 from the
  header centreline: branch `1000 - 144 = 856`, header unchanged; 4 pieces, 1 tee, 1 olet; exactly one `RTE_OPEN_END` (the free DN50 end), status warn.
- SC-RTE-05b / c: the `check_piping` steps give one `RTE_FITTING_TO_FITTING` (304) and `RTE_WELD_SPACING` with `cutLengthMm 36`, `minWeldSpacingMm 50`.
- SC-RTE-09: 3848 / 2696 / 2348, 2 elbows, 4 welds, line number `L-1`, 2 open ends.
- Reducer run (VC-RTE-26): 6x4 H 140 centred at 3000 on 6000: 2930 / 2930.

Decisions (owner delegated: long-term quality over the cheap path):

- **Reducers are inline components, the run size is derived.** There is no `legDn`: a run stores its start size (`dn`, default the line DN; branch runs carry their own)
  and its concentric reducers (`dn2`); the size at any point is a function of those (`runSizes.ts`). A port of another size is met by a reducer in the same call
  (`route_pipe.inline`) or by inserting one into an open run; nothing inserts a reducer by itself. `RTE_SIZE_MISMATCH` stays the code for a run end at the wrong size.
- **A branch is a run.** `add_branch` stores a `BranchPoint { id, leg, distance, branchRunId }` on the header and a branch run whose `start.ref` is
  `{ kind: 'branch', runId, branchId }`, at the branch size (`dn`); it belongs to the header line unless `lineId` is given (the fitting always comes from the header spec). The
  branch point is a port (`portOfRef`: on the header axis, facing along the branch), so a header edit that moves it breaks the branch with `RTE_STRETCH_FAILED` like any port.
  The leg indices of `inline` and `branches` are indices of the merged legs; `edit_route` (M3) has to remap them.
- **Fitting ids and lengths.** Fitting part ids are `<headerRun>/<tee|olet|stubIn>-<k>` (k per kind in route order). A tee splits the header leg by C each side and the branch pipe
  starts at M (reducing tee: both from the row; an equal tee row with only `centreToEndRun` takes M = C, B16.9, named in `data.branchStartSource`). An olet leaves the header
  whole and needs a straight header piece with the branch pipe radius to each end (else `RTE_BRANCH_ON_FITTING`). **Olet outlet:** the catalogue dimension is `centreToOutlet`
  (MSS SP-97 dimension A, from the header centreline, how the tables publish it); a row with only `height` is read as `OD_header / 2 + height` (§5.5). The stub's weldolet 6x2 is a declared input
  (A 144, unverified); sockolet and threadolet rows have an SW / THD outlet and are refused by the connection rule (`RTE_NO_CONNECTION_RULE`). A stub-in (`SI`, `SIR`) has no row: the branch pipe starts at the header
  surface (`OD / 2`), the part is `stubIn`, `reviewRequired` is true and `check_piping` reports `RTE_STUB_IN_REVIEW`.
- **Olets and stub-ins must not overlap.** On one header leg the footprints (discs of radius = half the row `baseDiameter`, else the branch pipe radius) must clear:
  `sqrt(dx^2 + (R angle)^2) >= r1 + r2`, dx the axial distance, R the header outside radius, angle the angle between the two branch directions. The same olet twice or 10 mm apart is
  `RTE_BRANCH_ON_FITTING`; the opposite side of the header or 100 mm further is allowed. Checked in `layoutBranches`, so every command that derives the header refuses it.
- **Stub-in welds.** The stub-in is set on the header by its single branch weld; the first branch piece has no butt weld to the part (butt welds are not counted twice).
- **Cycles and cost.** A branch run derives its header first; the walk carries the path, so a header that (through stored data) hangs on its own branch fails with `RTE_UNKNOWN_RUN` "branch cycle", and `pipingErrors` rejects such a model on load. Derivations and
  header layouts are memoised (`derivationMemo.ts`) per run object and per the slices a derivation reads (`plant.piping.{runs, lines, tieIns}`, `plant.spec`, `plant.catalog`, `building`; never entities, layers, units or the run order), so the memo
  keeps hitting across the documents a command builds step by step and a header with k branches is derived once (200 branches: `check_piping` ~50 ms, `add_branch` + `update_pipeline` ~120 ms; the "performance budgets" tests bound each at 20 s). Retention is bounded by
  the slices alive (WeakMaps), not by every document. Cached results are deep-frozen copies that share nothing with the document, so a caller cannot alter what the next one reads (a query answer that is mutated throws; regression test in `checks.test.ts`).
- **`convert_pipe_run` transparency.** `data.straightenedMaxOffsetMm` is the largest sideways distance of a merged vertex from the leg that now runs past it (0.29 deg kink: 5000 / 2000.00625 = 2.499992 mm).
- **Set-on welds.** The olet / stub-in to header weld is a `branchWeld` joint, counted as `branchWelds` in the takeoff, apart from `buttWelds`. SC-RTE-03: 7 butt welds + 1 branch weld.
- **A branch is broken with its header.** `deriveRun` of a branch run first derives its header and fails with `header <id>: <header message>` and the header's code, so a header
  that lost its port (`RTE_STRETCH_FAILED`) breaks the branch too (parts removed) and the branch comes back when the header does.
- **Weld spacing in the derivation** is judged per pipe piece against its own wall, as `check_piping` does. `convert_pipe_run` treats a vertex that bends by no more than the spec angle tolerance as straight
  (merged, `data.mergedPoints`) and refuses the whole conversion if the nested `delete_building_element` of `replace` is rejected.
- **Codes for overlaps.** A tee overlapping an elbow set, a valve or another tee is `RTE_BRANCH_ON_FITTING`; a valve or reducer overlapping anything is `RTE_INLINE_DOES_NOT_FIT`
  (the inline commands report a tee collision with this code too); two plain fittings (elbows, flange sets) `RTE_SEGMENT_TOO_SHORT`.
- **Added codes and commands.** `RTE_UNKNOWN_COMPONENT` (inline component id not on the run), `RTE_UNKNOWN_PIPE` (`convert_pipe_run`: not a legacy pipe) and `RTE_END_TYPE_MISMATCH`
  (raised by `check_piping` when two connected ports disagree in end type). `remove_inline_component` and `delete_pipe_run { cascade }` are new surface that §4 does not list (a valve must be removable; deleting a
  header with branches needs a way out).
- **`check_piping` built / not built.** Built: `RTE_OPEN_END`, `RTE_DISCONNECTED_PORT` (info; only without `lineIds`: a nozzle or tie-in with no run), `RTE_FITTING_TO_FITTING`, `RTE_WELD_SPACING`
  (recomputed per pipe piece against `minWeldSpacing` or `max(4 t, 50 mm)` of its own wall; the source is named in `detail`), `RTE_SIZE_MISMATCH` / `RTE_RATING_MISMATCH` / `RTE_FACING_MISMATCH` /
  `RTE_END_TYPE_MISMATCH` across connections, `RTE_FROM_TO_MISMATCH` (the line's `from` / `to` text must equal an id or tag of a tie-in or nozzle that the line's connected group reaches; case-insensitive), `RTE_DUPLICATE_LINE_NUMBER`,
  `RTE_SPEC_UNVERIFIED` (one per line), `RTE_STUB_IN_REVIEW`, `RTE_VALVE_OPERATOR_HEIGHT`, and the code of any run that no longer derives as an error issue (never a refusal). Not built: `RTE_VALVE_OPERATOR_CLASH` (operator
  envelope against steel: V1), `RTE_ADVERSE_SLOPE` / `RTE_POCKET` (slope: M3), `RTE_NONSTANDARD_FITTING` (trimmed elbows: V1). The handwheel limit has no default (no public code value): the check is skipped without
  `maxHandwheelCentreHeight` and the result says so (`limits`); the height is measured from the highest building level at or below the handwheel centre, else z = 0 (named in `detail.referenceLevel`); the centre is
  the valve centre + stem x catalogue `stemHeight` (0 and flagged when the row has none). `lineIds` pulls in the runs attached to those lines (headers, branches, continuations), so a tee outlet is not reported open
  because its branch is on another line.
- **Graph rules** (`graph.ts`): parts and the tie-ins / nozzles that runs attach to are nodes; a part port is connected when another part port or an external port lies within 0.01 mm with an opposite direction (within 1 degree), or within the
  gap of a joint of its part; bolt sets join their flange through the joint accessories. `piping_connectivity` returns `{ nodes, edges, openEnds, components, mismatches, path?, runs, brokenRuns }`; `path` is the shortest chain
  of node ids between `from` and `to` (port ids or part ids), `null` when they are not connected.
- **`convert_pipe_run`.** Vertices become PIs (collinear merge, z = level elevation + vertex z), both ends open, every bend must have a spec elbow (all failing vertices listed in `detail.vertices`, one refusal), the line number is the
  legacy `line` text verbatim (the template when there is none), service / from / to are copied, the DN is the pipe `dn`, else the DN of its diameter in the pipe size table (else `RTE_SIZE_MISMATCH`). The legacy pipe stays unless `replace: true`
  (then `delete_building_element`, which takes the hosted pipe supports with it). `spec` is optional when `lineId` names a line.
- **`update_pipeline`.** Service, sequence, spec, line number, conditions, insulation (`null` clears), from / to (`""` clears); the size never changes. A number that followed the template follows it again; a changed spec re-derives every run
  of the line (and what is attached) and is refused whole with the code of the first run that fails.
- **Ids.** Flange sets are numbered in route order including valve sets (the end set of a run with one valve is `gasket-4`, not `gasket-2`); derived ids are not stored, so only entity ids shift.
- **Reconcile.** `reconcile` re-derives the runs attached to a stale run (a header's branch runs, a run continuing from an end).
- **Plans.** `facePositions` replaces `valveFacesZ`; `teeReducing` is the PSC type name `reducingTee`; `$alias` in an expected value stands for the first id the step with `as` produced; SC-RTE-09 imports the stub first. The test harness `pick`
  accepts numeric filters (`[?dn==150]`) and maps a property over a list.

TODO (data): the weldolet 6x2 `centreToOutlet` 144 is an invented stub input, so the DN50 cut 856 is only "derived from a declared input". Before a real catalogue maps MSS SP-97, source dimension A and its datum
(header centreline, as assumed here, or header surface) and set `verified`.

Open after M2: stretch for branches and inline components, `edit_route`, slope, insulation envelope, line-number settings (all built in M3, §13.8); still open for V1: supports on runs, eccentric reducers, trimmed elbows, valve operator clash, PCF / IFC output of valves and branches (05 / 08).

### 13.8 RTE-M3 as built (2026-10-24, plant 02 milestone M3)

Built: orthogonal stretch when a connected port moves, `edit_route`, sloped legs and the slope checks, insulation from the spec table with the envelope in `check_clashes`, the line-number template and `set_piping_settings`. SC-RTE-04 and SC-RTE-06 run end to end; SC-RTE-07 runs through step 7 (`check_clashes`).
`line_heat_loss` was **V1** and unbuilt in M3 (built in V1 part 2, §13.10: SC-RTE-07 step 8 runs). Supports on runs were not built in M3 (decision below; built in V1 part 2).

| Part         | Where (`packages/domain-aec/src/plant/piping/`)                                                                                                                                                        | Notes                                                                                                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Stretch walk | `stretchWalk.ts`, `stretch.ts`, `derive.ts` (`reconcile`)                                                                                                                                              | `walkChain` (§5.7 generalised to both ends and to a moved interior point), `stretchRun` (port difference, walk, displaced run, trial derivation), applied by the piping `reconcile` in run order |
| `edit_route` | `editRoute.ts` (pure), `commands/editRoute.ts`                                                                                                                                                         | `move_pi` (orthogonal or free), `stretch_leg`, `insert_pi`, `delete_pi`                                                                                                                          |
| Slope        | `slope.ts`, `legs.ts`, `slopeChecks.ts`                                                                                                                                                                | `route_pipe` legs take `planLength` + `slope`; stored as `run.legSlopes`; `line.slope` declares a gravity line                                                                                   |
| Insulation   | `insulation.ts`, `specLookup.ts` (`insulation()`), `spec/types.ts` + `spec/file.ts` (`insulation` table), `clashBodies.ts`, `industrial/clash/clashSources.ts` + `clashPlant.ts`                       | table in the spec file; envelope in `check_clashes` through a registered clash source                                                                                                            |
| Line number  | `lineNumber.ts`, `commands/pipingSettings.ts`                                                                                                                                                          | template engine, best-effort parse, `plant.piping.settings.lineNumberTemplate`                                                                                                                   |
| Tests        | `tests/unit/plant/piping/{stretch,editRoute,slope,slopeChecks,insulation,lineNumber,stretchPerformance}.test.ts`, golden `piping_gravity_drain`, `piping_move_with_connected`, `piping_insulated_line` |                                                                                                                                                                                                  |

Validation numbers (hand calculations from the stub catalogue and the spec rows, never copied from an output of llull):

- SC-RTE-04: 1 % over 8000 plan: drop 80, length 8000.39999, 0.572939 deg; the vertical leg 1000 - 80 = 920; turn acos(80 / 8000.39999) = 89.427061 deg, deviation 0.572939 deg (accepted at 1 deg, refused at 0.5 deg with `RTE_NO_FITTING_FOR_ANGLE`); DN50 A = 76: cuts 7924.39999 and 844. A line declared 1 % fall whose profile falls, runs flat and rises (+X plan 4000 at 1 %, -Z 500, +X 1000, +Z 600) gives one `RTE_ADVERSE_SLOPE` (leg 3) and one low-point `RTE_POCKET`.
- SC-RTE-06 (README D6): +500 X on the vessel gives 3269; then +500 Y gives 3196; the other pieces are unchanged, 4 elbows, total 11 626.
- SC-RTE-07: spec row H, DN <= 100, T <= 200 C gives 50 mm (the 100 C row does not cover 180 C, the 150 / 200 row is looser); line number 80-HO-4001-CS150-H50; envelope 88.9 + 2 x 50 = 188.9; IPE200 axis at z 2830 (confirmed against `add_steel_member`): top 2930, insulation bottom 3000 - 94.45 = 2905.55, bare pipe bottom 2955.55: one insulation clash of 24.45 mm, no hard clash. Insulation area of the straight 6 m: pi x 0.1889 x 6 = 3.5607 m2.
- Edits (README D12): PI 0 up 500 gives 1769 / 2696 / 2696 / 696 / 2769; leg 2 to 3500 gives 3196 and 2269; the valve of the jog example goes from leg 1 @ 1800 to leg 5 @ 500.

Decisions (owner delegated: long-term quality over the cheap path; no backward compatibility):

- **Stretch is derived from the port, not from the edit.** A run stores where it was routed; the displacement of a connected end is `port - stored point`, so a stretch that failed (run kept, marked broken) is retried from the same stored geometry by the next edit, and moving the equipment back clears the mark. Both ends moving: walk forward from the start (each point takes what the leg before did not absorb), then walk back from the end with what is still missing; a remainder that reaches the other connected end is `RTE_STRETCH_FAILED`. An open end follows freely (it takes the remainder). The walk keeps every leg direction, so a slope is kept. A stretched run must still derive (trial derivation), else the stretch fails with the derivation code in the reason. The broken reason is the same live and after a load (`brokenReason` re-runs the stretch). A port turned away (direction beyond 1e-4 deg) is `RTE_STRETCH_FAILED`.
- **Components and branches keep their position along the leg axis.** `centreDistance` / `distance` become `d - (start displacement . u)`: a leg whose end moved keeps them, a leg whose start moved along its axis (the equipment at that end moved) keeps the world position; one that would leave its leg fails the stretch (named in the reason). Branch runs and runs that continue from an end are stretched after their header in run order (their port is the moved branch point or run end), also by `edit_route` (a dependent that cannot follow refuses the edit).
- **Not built: a horizontal move of a sloped leg.** The walk absorbs a displacement in the legs parallel to it. A sloped leg is not parallel to a horizontal move, so the vertical remainder it leaves breaks the run unless another leg is parallel to it (lowering the drain hub works; moving it sideways needs `edit_route`). A slope-preserving solve (plan length and elevation adjusted together) is V1: **built in §13.9** (a move along the heading of the sloped leg; across it still needs `edit_route`).
- **`edit_route`.** PI index = `run.pis` index; leg index = merged-leg index. `move_pi` / `stretch_leg` are orthogonal by default (the stretch walk applied to the moved point, ends fixed; a connected end cannot be moved, move the equipment); `mode: "free"` moves exactly one point and lets the two legs turn (the derivation then judges the elbows). `insert_pi` takes `points` (a whole jog at once, so every elbow is valid) instead of the single `point` of the sketch; `delete_pi` takes `count`. Points that became collinear merge. Remap rule: a component or branch keeps its distance from the end of its leg that did not move; when legs merge the distance grows by the length of the part before it; one on a leg the edit removes, or that would leave its leg, refuses the edit (`RTE_EDIT_INVALID`, move it first). Declared leg slopes follow the legs (a merged leg keeps the first one; new legs of an insertion or deletion have none; a free move keeps them, so a tilt against the declaration is reported as adverse). The first / last leg must still leave / arrive along the port direction (`RTE_PORT_DIRECTION`, plan direction for a sloped leg). A run broken by a moved port can be repaired by an edit: its connected ends follow their ports as part of the edit. An edit that changes nothing is a no-op.
- **Slope.** A leg takes `planLength` + `slope { value, unit, fall }` and a horizontal direction (`RTE_SLOPE_INVALID` otherwise: 0 < s <= 100 %). `u = normalise(h - s z)`, length = plan x sqrt(1 + s^2), as §5.6. A sloped first / last leg is judged against the port on its **plan direction** (the slope is intended and reported in `portDeviationDeg`), so the tolerance applies only at the elbow (AC-07: 0.5 deg gives `RTE_NO_FITTING_FOR_ANGLE`). The declared slope is stored per merged leg (`legSlopes`) and optionally per line (`slope` on `create_pipeline` / `update_pipeline`); route data reports `planLengthMm`, `dropMm` (positive = descends), `slopeDeg` on sloped legs, and every turn its `fitting` key.
- **`RTE_ADVERSE_SLOPE` and `RTE_POCKET` are both in M3** (§10 had pockets in V1). A leg is graded by its own declaration, else by the line slope; a graded leg that moves against its declaration (rises when it must fall) is adverse; flat legs are never adverse. A pocket is two consecutive non-flat legs of opposite sign, both graded (a low point after a fall, a high point after a rise); it is relieved by a branch taken off a leg from the first to the second that leaves downward (drain) or upward (vent) at 45 deg or steeper. Warnings, never errors.
- **Insulation lives in the spec.** The PSC spec file gains an optional `insulation` array (`code, dnMax, tempMaxC, thicknessMm, material, conductivityWmK?`); the row for a line is the tightest one (smallest `dnMax`, then `tempMaxC`) with the code that covers its DN and design temperature; a missing table, code or row is `RTE_SPEC_NO_COMPONENT` naming what exists. The line stores `insulation { code, thicknessMm, material?, source: "spec" | "explicit", row? }`; `create_pipeline` / `update_pipeline` take `insulation { code, thickness: number | "fromSpec", material? }` (the M2 `thicknessMm` parameter is replaced, no compatibility); a spec-read thickness is read again when the spec or `designTempC` changes. The CS150 validation spec carries the (illustrative, non-standard) rows of the old stub. `route_pipe` and `create_pipeline` report `envelopeDiameterMm`; `piping_takeoff.insulation` gives, per insulated line, the straight-piece length and the outer area (fittings not counted).
- **`check_clashes` extension.** There was no extension point (the industrial clash code only knew building elements), so `industrial/clash/clashSources.ts` adds one: a plugin registers a pure source of bodies when it is installed (the piping plugin does, in `onInstall`) and the clash code never imports the plugin. Bodies: one box per pipe piece and per elbow leg (pipe outside diameter, circumscribing square), plus the same widened by the insulation (kind `envelope`). A hit of a body is a hard clash with the part id (`run-4/pipe-2`); a hit of an envelope that the bare pipe clears is kind `insulation`; a pair with a hard clash reports only that. Never checked: a run against its own parts, the runs attached to it, the equipment its nozzles sit on. Valves, flanges and tees have bodies since V1 part 1 (§13.9); no bodies in a non-mm document. A sweep along x keeps the pair search near linear.
- **Line-number template** is one per document (open question §11.4), in `plant.piping.settings.lineNumberTemplate`: placeholders `{dn} {service} {sequence} {spec} {insulationCode} {insulationThickness}`, literal text, optional `[...]` groups that vanish when a field inside is empty; `{sequence}` is required and no placeholder repeats (`RTE_TEMPLATE_INVALID`). `set_piping_settings` renumbers the lines that followed the old template and keeps explicit numbers (listed); two lines getting one number refuses the change (`RTE_DUPLICATE_LINE_NUMBER`). An explicit number is parsed with the template and the differences are reported in `data.lineNumberParse`, never corrected. Derived part names carry the line number and are rebuilt by the reconcile.
- **Supports on runs: not built in M3, built in V1 part 2 (§13.10).** §4 itself labels `runId` on `add_pipe_support` as V1. A support is a building element whose `pipeId` names a legacy pipe element, and about ten places (building validation, geometry evaluation, plan sheets, IFC, clash boxes, schedule, copy / delete, re-attachment, the span and load checks) look the pipe up in the building model; a run is in `plant.piping`. Doing it half would silently skip run supports in some of them. V1 needs one carrier lookup (legacy pipe or run, with the run's supports re-attached after a stretch or `edit_route`) used by all of them.
- **Memo key unchanged.** A derivation still reads only `plant.piping.{runs, lines, tieIns}`, `plant.spec`, `plant.catalog`, `building` and the run: `legSlopes` is on the run, `slope` / `insulation` on the line (already keyed, not read by a derivation), the settings, the spec insulation table (inside `plant.spec`), supports and units are not read. `derivationMemo.test.ts` checks that the settings are a hit and that insulation / slope give an equal result.
- **Branch angle is a derivation rule (review fix).** `layoutBranches` checks that every branch leaves its header leg perpendicular within the run tolerance (tee, olet, stub-in), else `RTE_NO_FITTING_FOR_ANGLE` naming the branch (`detail.branch`). `add_branch` already did at creation; a free `edit_route` that tilts the header leg is now refused, and a stored model that violates it is marked broken.
- **Spec-sourced insulation follows the spec (review fix).** When `plant.spec` or `plant.catalog` changes, the piping `reconcile` reads the table row again for every line with `insulation.source = "spec"` (new revision, edited rows): the line is updated, its runs and entities re-derived, the note says `50 -> 55 mm`. A row that can no longer be found keeps the stored thickness and the note says so. A derivation still does not read the insulation, so the memo key is unchanged.
- **`RTE_FLAT_ON_SLOPED_LINE` (review fix).** A graded leg (own declaration or the line slope) that is horizontal is reported as a warning: it does not drain. Vertical legs are not flat. Adverse and pocket rules are unchanged.
- **Clash source is registered at install (review fix).** `CadPlugin.onInstall` (new, generic: core calls it from `installPlugin` and knows nothing of clashes) lets the piping plugin register its clash source with `industrial/clash/clashSources`; importing `@aec/index` alone registers nothing.
- **`convert_pipe_run { replace: true }` with supports (review fix, superseded in V1c, §13.11).** Was refused with `RTE_PIPE_HAS_SUPPORTS` (supports on runs were V1); since V1c the supports move onto the run and the code is removed.
- **`edit_route` summary (review fix).** When legs merge or split the summary and the leg list report `legs n -> m` with the new lengths instead of "no leg changed length".
- **`onInstall` runs after the listeners (second review).** `installPlugin` calls `plugin.onInstall` only once every install listener accepted the plugin, so a rejected plugin (command-name collision) has no side effect; contract test in `tests/unit/contract/plugins.test.ts`. The field is listed in ARCHITECTURE.md and rules L10.
- **Branch tolerance, one rule (second review).** A branch is judged perpendicular within `branchRun.angleToleranceDeg ?? header tolerance` (header run override, else spec), both in `add_branch` and in every derivation, so the `angleToleranceDeg` given at add time holds on every later edit and reconcile.
- **Spec-read insulation keeps the user's material and its number (second review).** `LineInsulation.materialExplicit` marks a material the user gave; re-reading the table (the reconcile on a spec change, `update_pipeline`) keeps it. The reconcile renumbers a line whose number followed the template (like `update_pipeline`), unless another line already has the new number (kept, noted).
- **`edit_pipe_spec` edits the insulation table (second review).** Ops `setInsulationRow` (add, or replace the row with the same code, `dnMax`, `tempMaxC`) and `removeInsulationRow`; the result is validated like an import (`PSC_SPEC_INVALID`, an unknown row to remove is refused), a draft is edited in place, an approved spec gets a new draft revision. End to end: edit row -> the spec-sourced lines read it again -> parts, takeoff and clash envelope follow; `replay_history` gives the same plant.
- **Added codes:** `RTE_SLOPE_INVALID`, `RTE_EDIT_INVALID`, `RTE_TEMPLATE_INVALID`, `RTE_FLAT_ON_SLOPED_LINE` (and `RTE_PIPE_HAS_SUPPORTS`, removed in V1c). New commands: `edit_route`, `set_piping_settings`.

Performance (2026-10-24, development laptop, Windows 11, Node 24, no kernel): stretching 200 runs (every end tie-in moved) 114 ms (0.6 ms per run, so about 0.6 s for 1 000 runs against the §8 1.5 s for regenerating 1 000); one `edit_route` on a run of that 200-run document 4 ms; `piping_takeoff` of the 200 runs 20 ms. The "performance budgets" test bounds them at 1 s / 250 ms / 500 ms.

### 13.9 RTE-V1 part 1 as built (2026-10-24, plant 02 milestone V1: fittings and geometry)

Built: socket-weld and threaded engagement, eccentric reducers, trimmed elbows and pipe bends, valve operators with `RTE_VALVE_OPERATOR_CLASH`, clash bodies for valves, flanges, tees, olets and reducers, and the slope-preserving stretch. No command is new; these changed: `route_pipe` (`bendRadius`, `inline` types and fields), `insert_inline_component` / `move_inline_component` / `remove_inline_component` (`reducerEccentric`, `flat`, `flatDirection`, `data.operator`), `add_branch` (sockolet / threadolet outlets), `convert_pipe_run` (bends), `check_piping` (`clashToleranceMm`, new codes), `piping_takeoff`, `check_clashes` (bodies), `import_pipe_spec` / `edit_pipe_spec` (`elbowAngles.bendRadiusD`), `add_tie_in_point` (SW / SC ports are joined). Not in part 1 (built in part 2, §13.10): supports on runs, heat tracing, `line_heat_loss`, the PCF hand-off, IFC ports, exact solids via the kernel.

| Part                    | Where (`packages/domain-aec/src/plant/piping/`)                                                                                                                                                                                                                                                                                                                                                       | Notes                                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Connection rules, joins | `connections.ts`, `specLookup.ts` (`connection`, `CatalogueRow.pipeEnd`), `routeEnv.ts` (`joinOf`), `jointStack.ts` (`Interval.join`), `routeParts.ts`, `routeEnds.ts`, `routeInline.ts`, `routeBranch.ts`, `flangeSet.ts`                                                                                                                                                                            | One `Join` per fitting end: joint kind, stack gap, engagement. SW-PL and SC-SC join the BW-BW and FL-FL rules |
| Eccentric reducers      | `eccentric.ts`, `legShifts.ts`, `routeInline.ts`, `slopeChecks.ts` (`invertFindings`)                                                                                                                                                                                                                                                                                                                 | `InlineComponent.flatDirection`; `Slot.offset`; `DerivedInline.flat`                                          |
| Turn fittings           | `fittings.ts` (`chooseElbow`), `routeTurns.ts`                                                                                                                                                                                                                                                                                                                                                        | `ElbowChoice.kind` `standard` / `trimmed` / `bend`; `PipeRun.bendRadiusMm`                                    |
| Valve operators         | `operator.ts`, `operatorChecks.ts`, `clashBodies.ts`, `industrial/clash/clashPlant.ts` (`accessoryClashes`), `clashSources.ts` (`accessoryOf`)                                                                                                                                                                                                                                                        | `DerivedInline.operator`; display from the same bodies                                                        |
| Stretch                 | `stretchWalk.ts` (`solveKeepingDirections`)                                                                                                                                                                                                                                                                                                                                                           | fallback and exactness test inside `walkChain`                                                                |
| Tests                   | `tests/unit/plant/piping/{socketThreaded,eccentricReducers,trimmedBends,valveOperators,slopeStretch,v1Performance,jointStack,derivationMemo}.test.ts`, plans SC-RTE-10 .. 15 (`validation/plans`), golden `piping_socket_weld_line`, `piping_threaded_branch`, `piping_eccentric_riser`, `piping_trimmed_and_bend`, `piping_valve_operator`, `piping_slope_stretch` (`tests/golden/pipingPlansV1.ts`) |                                                                                                               |

Validation numbers (hand calculations from the stub inputs, README D13 .. D18, never copied from an output of llull):

- SC-RTE-10 (VC-RTE-30): NPS 1 SW elbow centre-to-mouth 41, socket depth J 13, socket gap g 1.6, so the pipe sits J - g = 11.4 inside every socket. Leg 0: 1000 - 41 + 2 x 11.4 = 981.8; leg 1: 1500 - 41 + 11.4 = 1470.4; a SW gate valve (F-F 79) at 500 splits leg 0 into 483.3 / 442.3; 3 (5 with the valve) socket welds, no butt weld; centreline 2500 - 2 x 28 + 28 pi / 2 = 2487.9823 (the bend ends at the socket bottom, R = 41 - 13). A SW flange (hub 17.5, gasket 3) starts the pipe 3 + 17.5 - 11.4 = 9.1 from the nozzle face: first cut 961.3.
- SC-RTE-11 (VC-RTE-31): threaded elbow 38, engagement 17.3: 1000 - 38 + 2 x 17.3 = 996.6 and 1500 - 38 + 17.3 = 1479.3; a threadolet 2x1 (outlet face 50 from the header axis): branch 1000 - (50 - 17.3) = 967.3, header whole.
- SC-RTE-12 (VC-RTE-33): 6x4 eccentric reducer, OD 168.3 / 114.3, offset e = 27, H 140 centred at 2000 on a 4000 leg: flat on top: pieces 1930 / 1778 / 821 and a 973 mm riser (it starts 27 higher), centreline 4907.761, bottom (invert) step 54; flat on bottom: 1930 / 1778 / 875, riser 1027, step 0; reducer + expander: 930 / 1860 / 1930.
- SC-RTE-13 (VC-RTE-34): a 60 degree turn: trimmed 90 LR NPS 4 (R = A = 152): c = 152 tan 30 = 87.7572, pieces 2912.2428 / 1912.2428, centreline 4983.6595; pipe bend R 500: c = 288.6751, pieces 2711.3249 / 1711.3249, developed length 523.5988; spec bendRadiusD 5 (R = 571.5): c = 329.9557.
- SC-RTE-14 (VC-RTE-35): globe valve with an actuator (cylinder 250 x 500 topping at 900) under an IPE200 at z 700: clash depth 125 + 50 = 175 mm; a beam over a CL150 flange plate (OD 228.6) clashes by 114.3 + 100 - 200 = 14.3 mm while the pipe (57.15) clears it.
- SC-RTE-15 (VC-RTE-36): the pump of a 1 % drain moves 500 along the run: plan 8000 -> 7500, drop 80 -> 75, corner z 925; cuts 7500 sqrt(1 + 0.01^2) - 231 = 7269.3750 and 925 - 152 = 773.

Decisions (owner delegated: long-term quality over the cheap path; no backward compatibility):

- **The pipe end comes from the spec's pipe component.** `ends` of the spec `pipe` component (`BE` butt weld, `PE` plain end, `THD` threaded) gives `CatalogueRow.pipeEnd` (absent = butt weld). A fitting end joins it by the built-in table (still not in the PSC spec format): BW-BW butt weld, SW-PL socket weld (socket gap 1.6 mm, a named default [S18], B31.3 328.5.2), SC-SC threaded, FL-FL flanged. Any other pair is `RTE_NO_CONNECTION_RULE`. The catalogue pipe family offers both `BW` and `PL` ends, so the family cannot decide; the spec does (a spec whose pipe component declares nothing is butt weld, as before). The socket gap is not yet overridable per spec (open: connection rules in the PSC format).
- **Dimension convention.** `centreToEnd` of a SW fitting is to the socket mouth and of a threaded one to the end face, like a butt-weld one, so the joint stack is unchanged: the stack gap of a socket join is `-(socketDepth - 1.6)`, of a threaded join `-threadEngagement` (the pipe piece starts inside the fitting, so its cut includes the engagement). B16.11 tabulates the distance to the socket bottom A; a catalogue maps it as `centreToEnd = A + socketDepth`. A row without `socketDepth` / `threadEngagement` is `RTE_SPEC_NO_COMPONENT` naming it (never a guessed depth). Joints carry `engagementMm`; the graph bridges `gap + engagement`; `Joint.gapMm` of a socket weld is the 1.6 root gap.
- **SW / SC ports have no depth of their own.** A SW or screwed tie-in takes the depth of the spec's own socket (thread) fittings of that size (elbow90, else coupling, else tee); none -> `RTE_SPEC_NO_COMPONENT` naming the dimension. The pipe of a flanged nozzle on a SW spec meets a socket-weld flange (`flangeSocketWeld`; threaded: `flangeThreaded`) instead of a weld neck.
- **Overlap of fittings.** With negative stack gaps a piece can be positive while the fittings overlap, so `stackLeg` also refuses when the faces overlap (`RTE_SEGMENT_TOO_SHORT` / `RTE_INLINE_DOES_NOT_FIT`). The weld-spacing rule is about butt welds: a piece with no butt-weld end gets no `RTE_WELD_SPACING` (derivation and `check_piping`).
- **Socket elbows bend to the socket bottom.** `ElbowChoice.radius` of a socket-weld elbow is `(centreToEnd - socketDepth) / tan(turn / 2)`; the centreline length uses the tangent length `R tan(turn / 2)` (equal to `c` for a butt-weld elbow); the display torus starts one tangent length before the elbow centre.
- **Eccentric reducers (`reducerEccentric`).** The two outer surfaces line up on the flat side: the downstream axis is offset by `(OD in - OD out) / 2 x flat` (an expander offsets the other way). `flat` is `top` (+Z) / `bottom` (-Z), projected perpendicular to a horizontal or sloped pipe, or `flatDirection` (any side, needed on a vertical pipe); exactly one is required (`RTE_ECCENTRIC_INVALID`), the stored intent is the unit `flatDirection`. The stored points of intersection stay the run geometry. The offset sum D of a leg must run along the next leg: that leg then starts `D . u` further along its own axis (shorter or longer), the corner (elbow centre) moves by D, and nothing else moves; within the run angle tolerance of parallel the sideways residual is dropped and reported as an `RTE_ECCENTRIC_OFFSET` warning (a sloped pipe's perpendicular offset is 0.573 degrees off a vertical riser); beyond it, or on the last leg, the derivation fails with `RTE_ECCENTRIC_OFFSET` (a reducer + expander pair cancels). A branch downstream of the reducer on the same leg is `RTE_BRANCH_ON_FITTING` (its port would sit off the stored axis). The reducer part has an offset second port; its display is a frustum between the port centres (schematic). `check_piping` reports `RTE_POCKET` (`detail.kind "eccentric-invert-step"`) for a flat-on-top reducer on a leg declared to fall (the bottom steps up by `D_z + e`; steps below 0.05 mm are noise). The bundled `llull-open-piping` has no eccentric rows (B16.9 tabulates one H for both kinds; 01 PSC may add them): the CS150 stub carries 6x4 and 4x3.
- **Trimmed elbows and bends.** A turn no spec angle fits is made, in this order, by a pipe bend when the run gives `bendRadius`, a trimmed elbow when the spec says `trimmedAllowed` (the spec 90 degree butt-weld elbow cut to a turn up to 90 degrees: tangent `R tan(turn / 2)`, `R` = its centre-to-end A), a pipe bend when the spec gives `elbowAngles.bendRadiusD` (radius = D x pipe OD), else `RTE_NO_FITTING_FOR_ANGLE` whose message and `detail` (`trimmedAllowed`, `bendRadiusD`) say what would allow it. Standard angles within tolerance always use the catalogue elbow. A bend is made of butt-weld pipe only, with butt welds at both tangents, and a radius below one OD is refused. Both are flagged `RTE_NONSTANDARD_FITTING` (derivation warning, route data, `check_piping`). Part keys `elbow90LRTrimmed` and `pipeBend`; a bend part lists `radiusMm` and `developedLengthMm` (R x turn), which is not counted in `totalPipeMm` (pipe pieces only). `convert_pipe_run` accepts what the derivation accepts.
- **Valve operators.** Catalogue dimensions on the valve row: `stemHeight` (centre to the top of the operator), `handwheelDiameter` (+ `handwheelThickness`, else 6 % of the diameter: a disc centred at `stemHeight`), `gearboxDiameter` + `gearboxHeight`, `actuatorDiameter` + `actuatorHeight` (cylinders topping at `stemHeight`). The envelope follows the stored stem direction. A row without `stemHeight` has none; nothing is guessed (the plain valve keeps the schematic display). `data.operator = { kind: actuator | gear | handwheel, bodies }` on insert / takeoff.
- **`RTE_VALVE_OPERATOR_CLASH` uses the `check_clashes` boxes.** The circumscribing boxes of the operator bodies against the clash bodies of every run (not the valve's own run or the runs attached to it) and the building solids, deeper than `clashToleranceMm` (default 5, the `check_clashes` default); one issue per (operator body, other body) with ids `[valve, other]`, `detail.depthMm`, `kind` hard / insulation. Reported for the valves of the selected lines only; the rest of the model is obstacle. `ExternalBody.accessoryOf` (generic, in the clash source module) marks operator bodies.
- **Clash bodies.** Pipe pieces and elbows as in M3 (with the insulation envelope); valves (faces, section `bodyDiameter`, else the pipe OD); flanges (plate of `thickness` at the flange OD, then the hub at the pipe OD); tees (header and branch stub); olets (base to outlet, `baseDiameter` else the branch OD); reducers (both ends at the larger OD); operators. Gaskets, bolt sets and stub-ins have none. Insulation envelopes stay on pipe pieces and elbows.
- **Slope-preserving stretch.** The orthogonal walk (§5.7) is exact for axis-parallel legs only; for a leg that is not parallel to what it carries (a sloped leg and a horizontal move) it left a remainder, or dropped one below eps and left the leg slightly off its direction. `walkChain` now checks that its answer keeps every leg direction to rounding and otherwise solves the general problem: the least-squares displacements (Gram-Schmidt on the constraints) that keep every leg direction, honour the pinned ends exactly and leave free ends free. A horizontal move along the heading of a sloped leg changes its plan length and drop together (the slope is its direction) and the leg after it takes the vertical difference; a move across the heading would turn the leg and still fails with `RTE_STRETCH_FAILED` (use `edit_route`). `edit_route` shares the walk; its `move_pi` pins an exact vector, so the gain there is only the exactness.
- **Memo key unchanged.** A derivation reads the run (`bendRadiusMm`, `inline[].flatDirection`), `plant.spec` (`elbowAngles.bendRadiusD`, pipe `ends`), `plant.catalog` (socket / thread / operator dimensions) and the lines / tie-ins / building already in the key. The operator, clash bodies and operator check read the derivation. `derivationMemo.test.ts` covers the flat and the bend radius.

Performance (2026-10-24, development laptop, Windows 11, Node 24, no kernel): loading a document of 100 runs with a valve each re-derives them in 44 ms, `check_piping` with the operator clash on them (20 beams) 47 ms, `check_clashes` 9 ms, routing 100 socket-weld lines with a valve 76 ms, the general stretch solve on a 60-leg chain 16 ms. The "performance budgets" tests bound them at 20 s / 20 s / 20 s / 1 s.

Open after part 1 (supports on runs, heat tracing, `line_heat_loss`, PCF, IFC and exact solids are built in §13.10; the PCF / IFC of the new parts are written from the same derived parts); connection rules and the socket gap in the PSC spec format; sourced B16.11 / B16.34 / MSS SP-97 / B16.9-eccentric rows for the bundled catalogue (the SW, threaded, eccentric and operator rows exist only as declared stub inputs); couplings, unions, caps and swages as inline parts; a horizontal move across the heading of a sloped leg.

### 13.10 RTE-V1 part 2 as built (2026-10-24, plant 02 milestone V1: supports on runs, tracing, heat loss, hand-offs)

Built: pipe supports on spec-driven runs (`add_pipe_support runId`) with one carrier lookup used by every reader of a support's pipe, supports that follow a stretch or `edit_route`, heat tracing data, `line_heat_loss`, the PCF writer (`export_pcf`), IFC output of the runs with distribution ports, and exact STEP solids through the kernel (`export_pipe_step`). New commands: `set_heat_tracing`, `line_heat_loss`, `export_pcf`, `export_pipe_step`. Changed: `add_pipe_support`, `check_pipe_supports`, `delete_pipe_run`, `convert_pipe_run` (texts), `piping_takeoff` (`tracing`, `supports`), `export_ifc`. New codes: `RTE_TRACING_INVALID`, `RTE_HEAT_LOSS_INPUT`, `RTE_NO_RUNS`.

| Part | Where | Notes |
| ---- | ----- | ----- |
| Carrier lookup | `industrial/piping/pipeCarrier.ts` (`carrierOfSupport`, `carrierPipes`, `runPipes`, `isRunCarrier`), `plant/piping/runCarrier.ts` (`runCarrierPipe`) | a support's `pipeId` names a building pipe or a plant run; the lookup returns it as a `PipeElement` in the frame of the support's level |
| Re-attachment | `industrial/piping/pipeSupportAttach.ts` (`reconcilePipeSupports`, `orphaned`), `plant/piping/supportReconcile.ts` (`reconcileRunSupports`), `derive.ts` (`reconcile`) | re-snap to the new centreline, re-attach to steel, notes in the editing command's summary |
| Run supports | `plant/piping/runSupports.ts`, `clashBodies.ts`, `commands/deleteRun.ts`, `validate.ts` (the load check `supportCarrierErrors` was removed in V1c, §13.11) | supports by run, a run never clashes with its supports, delete lists them |
| Tracing, heat loss | `heatLoss.ts`, `commands/heatTracing.ts`, `commands/lineHeatLoss.ts`, `takeoff.ts` (`tracingTakeoff`), `types.ts` (`LineTracing`) | steady radial resistances; `line.tracing` is data |
| PCF | `pcf.ts`, `commands/exportPcf.ts` | goldens `tests/golden/__snapshots__/piping_pcf_small_line.pcf`, `piping_pcf_pump_to_vessel.pcf` |
| IFC | `building/exchange/ifcPipingExport.ts`, `ifcBuild.ts` | extends the one IFC writer; shared with the viewport and STEP geometry (`partEntities`) |
| Exact solids | `commands/exportPipeStep.ts` | `requiresKernel`; composes `export_step_ap242` |
| Tests | `tests/unit/plant/piping/{runSupports,heatLoss,pcf,ifcPiping,exportPipeStep,v1bPerformance}.test.ts`, plans SC-RTE-16 .. 21 (`validation/plans`), goldens `piping_run_supports_tracing`, `piping_run_supports_stretch` (`tests/golden/pipingPlansV1b.ts`), `piping_pcf_small_line.pcf`, `piping_pcf_pump_to_vessel.pcf` | |

Validation numbers (hand calculations, README D19 .. D24, never copied from an output of llull):

- SC-RTE-16 (VC-RTE-37): DN80 hot line over IPE200 (top 2930): pedestal 2955.55 - 2930 = 25.55; beams at 500, 3000, 5500: spans 2.5 m, overhangs 0.5 m, three supports; weight 16.0616 kg/m x 9.80665 = 0.157510 kN/m x 6 m = 0.94506 kN on the beams.
- SC-RTE-17 (VC-RTE-38): the vessel of SC-RTE-01 +500 Y: the +X leg shifts from y 3000 to 3500; the shoe is re-snapped 500 mm and keeps its beam (pedestal 42.85).
- SC-RTE-18 (VC-RTE-39): R_s 3.7437e-4 + R_ins 2.004159 + R_o 0.074241 = 2.078775 K m/W; Q' = 152 / 2.078775 = 73.120 W/m (ht 1.2.0: 73.12000884), surface 33.4285 degC, 6 m = 438.72 W; at 150 degC 58.688 W/m; tracer length 2 x (6 + 3 x 0.25) = 13.5 m.
- SC-RTE-19 / 20 (VC-RTE-40 / 41): DN100 +X 3000, +Z 2000: PIPE to 2848, ELBOW (2848,0,0)-(3000,0,152) centre (3000,0,0), PIPE 152 to 2000; IFC: 3 products, 6 ports, 2 connections, 1 system, elbow circle R 57.15 at 152 revolved 1.570796 rad.
- SC-RTE-21 (VC-RTE-42): the no-kernel contract (`CMD_KERNEL_UNAVAILABLE`); the products of the scripted exact kernel are named by part id and line number.

Decisions (owner delegated: long-term quality over the cheap path; no backward compatibility):

- **One carrier lookup, the support stays a building element.** A `PipeSupportElement` keeps its place in `doc.building` (marks PS1.., steel attachment, geometry on P-SUPP, schedule, takeoff, IFC, plan symbols, the span and load checks all read it) and its `pipeId` may now name a run id (`run-4.1`) as well as a building pipe (`pipe-3`); the two id spaces cannot collide (a building id wins). `carrierOfSupport(doc, building, support)` returns the carrier as a `PipeElement`: a building pipe as stored, a run as { id and mark = run id, line = line number, dn, service, diameter = the OD of the derivation (nominal size in mm when the run does not derive), points = the derived legs (`piping_takeoff.legs`: start of leg 0 and the end of each leg, so an eccentric reducer's offset is in), z relative to the level }. The frame is the support's own level; `pipeRunsOf` (spans, loads) uses the first building level, and a run with no level to hold supports is refused by `add_pipe_support` (`add_level` first). Consumers that now resolve through it: **geometry** (`evaluateElements`), **IFC** (`ifcBuild`), **plan symbols** (`planSupports`, `PlanSource` gained `plant`), **clash boxes** (`clashBoxes`), **support schedule**, **`pipeSupportLayout`** (`pipeRunsOf`, `supportStations` now uses the support's own level; `endCarriers` of a run follow its port references: a nozzle is equipment, a branch or run end a pipe, a tie-in is free), hence **`check_pipe_supports`**, **`steelSupportLoads`** and **`steelLineLoads`** (plant runs are loaded on the steel like building pipes: supported runs through their supports, others as resting / nozzle-carried), **`pipeSupports`** (`add_pipe_support`), **`pipeSupportAttach`** (signature and re-attachment), **`supportReconcile`** (plant side), **`clashBodies`** (a run's bodies are connected to its supports) and the building **validation** (`pipeSupportErrors` accepts an id that is no building element, the piping extension checks it against `plant.piping.runs`). Consumers that do not need the pipe: the takeoff of hangers (`takeoffCompute`), `pipeSupportCopy` (copies a building pipe's supports), `move_building_element` (only moves building pipes), `pipeHydraulics` (reads a pipe, not a support).
- **Supports follow the run.** After any command that changes the plant slice (the piping `reconcile`: stretch on a nozzle move, `edit_route`, `update_pipeline`, a spec edit, an eccentric reducer), the supports of the runs whose centreline or size changed are re-snapped to the nearest point of the new centreline (a stretch that shifts a leg 500 mm across moves the support 500 mm; one along the leg keeps its place), then re-attached with `reconcilePipeSupports` (the current member is kept while in reach, else the nearest in reach, else the support is unattached and the summary says DETACHED), and their entities rebuilt. A broken run keeps its supports where they are. A support whose run is gone is kept and named (`pipe supports: PS1 left in place: its run run-4.1 no longer exists`); nothing is dropped silently. `delete_pipe_run` is the one command that deletes the supports of its runs (as deleting a building pipe does) and lists them in the summary and in `data.deletedSupports`.
- **`convert_pipe_run { replace: true }` refused with `RTE_PIPE_HAS_SUPPORTS` in part 2 (superseded by V1c, §13.11):** the supports now move onto the run.
- **Heat tracing is data.** `line.tracing { type: electric | steam | hot_water | thermal_fluid, tracers 1..6, maintainTempC?, allowances? { valveM, flangeM, supportM } }` (`set_heat_tracing`, validated on load). `piping_takeoff.tracing` gives per traced line the centreline, the valves, flanges and supports (of the line's runs) it counted and `tracerLengthM = tracers x (centreline + valves x valveM + flanges x flangeM + supports x supportM)`; absent allowances count nothing and the row says `allowances: null`.
- **`line_heat_loss` is the §5.10 closed form.** Inside diameter from the spec pipe row at the line DN (OD and wall), D2 = OD + 2 x insulation thickness of the line (bare pipe: D2 = OD, named default), insulation conductivity from the spec table row when not given (refused `RTE_SPEC_NO_COMPONENT` when the row has none), inside film neglected when not given (named default), steel conductivity and outside film required (no default is a claim about the design). It also reports the heat loss at the tracing's `maintainTempC`, the totals over the routed runs of the line and `reviewRequired: true`. No radiation, no temperature-dependent conductivity (V2).
- **PCF follows 05's conventions and never invents a key.** `export_pcf` is the name 05 reserves (ISO-M1): the data shape is its `files[] { name, content, sha256, componentCount, countsByType }`; 05 extends this command (legacy lines, supports, welds, `includeMaterials`) rather than adding another. Header keywords in fixed order, `PIPELINE-REFERENCE` with `PIPING-SPEC`, `INSULATION-SPEC`, `TRACING-SPEC`, `PROJECT-IDENTIFIER`; one record per derived part in run order then route order (a branch run follows its header run), `COMPONENT-IDENTIFIER` 1..n and `UNIQUE-COMPONENT-IDENTIFIER` = the llull part id, `END-POINT x y z bore endType` (0.1 mm), `CENTRE-POINT` of elbows, bends and tees (the point of intersection), `BRANCH1-POINT`, `ITEM-CODE` = catalogue key with `-`, `MATERIALS` last. SKEY only for ELBW, ELSW, TEBW, FLWN, REBW (05 `skey_catalogue.json`); the rest is listed in `missingSkey`. Bolt sets are `BOLT` + `ERECTION-ITEM` (no confirmed coordinate or size keywords: the stud count and diameter are in `data.bolts`). A stub-in has no component (`skipped`). Wafer and lug ends are written `FL`. A line with a run that does not derive is refused whole.
- **IFC reuses the display geometry.** `export_ifc` (the one writer, schema IFC4) now also writes the runs: each part is an IfcPipeSegment, IfcPipeFitting (BEND, JUNCTION, TRANSITION, CONNECTOR for flanges and gaskets, OBSTRUCTION for a cap) or IfcValve (ISOLATING for gate / ball / butterfly / plug, REGULATING for globe, CHECKVALVE) whose body is the revolved profiles of `partEntities` (round bodies become extrusions, an elbow section becomes an exact circle revolved about the bend axis), an IfcDistributionPort per part port (SOURCEANDSINK, PIPE) nested by IfcRelNests, IfcRelConnectsPorts for the ports that meet (coincident and facing; a socket or threaded joint by its joint; a flanged joint through the faces of its gasket; an olet or stub-in has none) and an IfcDistributionSystem per line (IfcRelAssignsToGroup); products are contained in the IfcBuilding (plant coordinates are world mm), so a plant document with no building level exports. Bolt sets have no body. IFC 4.3 specifics (IfcPipeSegment predefined types, IfcFlowController) are not used; the existing writer is IFC4 and the entities above exist there.
- **Exact solids: `requiresKernel`, composed.** `export_pipe_step` selects the entity ids of the runs and calls `export_step_ap242` (the pattern of `export_composite_ap242`), so the kernel builds the revolved parts as exact B-reps; no kernel is refused by `execute` (`CMD_KERNEL_UNAVAILABLE`), a kernel without a writer is `XCH_WRITER_UNAVAILABLE` (named, no faceted fallback); the export gate runs first like every `export_*`.
- **Memo key unchanged.** A derivation still reads the six slices of `derivationMemo.ts`. `doc.building` was already one of them (nozzle ports), so adding or moving a support makes the next derivation re-derive (a new building object); a support never changes a derivation. The carrier lookup and the support reconcile only read derivations (`deriveRun`), they add no input. `line.tracing` is in the `lines` slice (already keyed, not read by a derivation).

Performance (2026-10-24, development laptop, Windows 11, Node 24, no kernel): 100 `add_pipe_support` commands on a 100-run document 1.1 s (11 ms each, the building regenerated every time); then `check_pipe_supports` 8 ms, `building_schedule` 1 ms, `check_steel_members` 32 ms, `check_clashes` 23 ms, `export_pcf` 16 ms, `export_ifc` 14 ms, `set_heat_tracing` (re-checks the supports of the runs it changed) 5 ms, `delete_pipe_run` of a supported run 13 ms. The "V1 part 2 performance budgets" tests bound them at 60 s / 20 s / 10 s.

Open after part 2: IFC 4.3 schema (the writer is IFC4); PCF attributes of BOLT, SPINDLE-DIRECTION and UNIQUE-COMPONENT-IDENTIFIER are not confirmed against the PCF Reference Guide (05 pcf_keywords grade B); PCF welds, supports and spools (05); supports on a run in a document whose units are not mm (plant routing is mm only); radiation and temperature-dependent conductivity in `line_heat_loss` (V2); the UI support tool (`src/ui/panels/building/pipeSupportTool.ts`) still sends `pipeId` only, a `runId` pick is a viewport-lane follow-up.

### 13.11 RTE-V1c as built: V1 follow-ups (2026-10-24, review of parts 1 and 2)

Built: the level of a run from its elevation, one rule for a support whose run is gone (load = live), the exact STEP path measured on the native OCCT kernel, supports that move onto the run in `convert_pipe_run replace`, and the hint of `move_building_element`. No command is new. Changed: `check_pipe_supports` (`data.orphans`, `totals.orphans`, level rule), `convert_pipe_run` (`data.supports`), `add_pipe_support` (level of the run), `move_building_element` (summary). Removed: `RTE_PIPE_HAS_SUPPORTS` (no longer raised). New codes: `RTE_SUPPORT_OFF_RUN`, `RTE_SUPPORT_ORPHAN`.

| Part | Where | Notes |
| ---- | ----- | ----- |
| Level of a run | `plant/piping/runCarrier.ts` (`levelOfElevation`, `runCarrierPipe` default frame), `industrial/piping/pipeCarrier.ts` (`runPipes`, `carrierPipes` take no level) | `pipeSupportLayout.pipeRunsOf`, `steelLineLoads` and `add_pipe_support` read the level from the pipe element, so they all follow the one rule |
| Orphan supports | `pipeCarrier.ts` (`orphanSupports`), `pipeSupportCheck.ts`, `supportReconcile.ts`, `building/validate.ts`, `derive.ts` | the load check `supportCarrierErrors` is removed |
| Supports on convert | `plant/piping/supportReconcile.ts` (`followCarrier`, `supportOffsets`), `commands/convertPipeRun.ts` | the snap-and-attach step of the stretch reconcile, shared |
| Native STEP | `server/tests/nativePipeStep.test.ts` | skipped without the `llull-kernel` binary |
| Tests | `tests/unit/plant/piping/{v1cFollowUps,convertPipeRun,runSupports}.test.ts`, plans SC-RTE-22, 23 (`validation/plans`), golden `piping_convert_replace_supports` | |

Validation numbers (hand calculations, README D25 .. D27, never copied from an output of llull):

- SC-RTE-22 (VC-RTE-43): levels at 0 and 3000; a DN80 run at z 1000 (the highest level at or below 1000 is 0: Ground) and one at z 3000 (3000 <= 3000: Upper); lengths 4000 and 6000 mm, so the `levelId` filter returns 4 m for Ground and 6 m for Upper.
- SC-RTE-23 (VC-RTE-44): DN100 legacy pipe (0,0,1500) - (2000,10,1500) - (4000,0,1500): the vertex bends 2 x atan(10 / 2000) = 0.5729 deg, inside the 1 deg tolerance, so it merges; the straightened line is y = 0, the merged vertex was 10 mm off it; supports at x 1000 / 2000 / 3000 move 5 / 10 / 5 mm; the limit is one outside diameter, 114.3 mm.
- VC-RTE-45: orphan supports (no plan: no command leaves an orphan; unit test only).
- VC-RTE-42 (D24) now has numbers: the small line PIPE 29,222,833.73, PIPE 18,962,007.28 and ELBOW 2,387,402.16 mm3 on the native OCCT kernel (README D24).

Decisions (owner delegated: long-term quality over the cheap path; no backward compatibility):

- **The level belongs to the run, not the leg.** A run is one level: the highest building level whose elevation is at or below the lowest point of its centreline, else the lowest level, else none (`''`, as before when the building has no level). Per leg was considered and refused: a support, a row of `check_pipe_supports`, a schedule line and a `levelId` filter all name one pipe; splitting a run per level would make one line number two rows with two lengths and break the span check across the level change. The lowest point (not the start) makes the rule independent of the run direction: a riser belongs to the level it starts on. A support keeps the level it was placed on (it is data of the support); only the run's own frame changed, and the absolute geometry is the same in every frame. `runCarrierPipe` takes the level of the run when none is asked for (the support's level for `carrierOfSupport`).
- **A support whose run is gone loads.** Rejecting the file made a recoverable state unopenable (the run is lost but the supports, the steel and the rest of the plant are fine). Load accepts it (the building validation only needs a non-empty `pipeId`; `supportCarrierErrors` is removed), live and load keep the support in place, and `check_pipe_supports` is the one place that reports it: `data.orphans[] { id, mark, pipeId, levelId, code: 'RTE_SUPPORT_ORPHAN' }`, `totals.orphans`, `ok: false` and the code in the summary; the span checks never count it. The live note of the editing command names the same code. The two paths produce identical `check_pipe_supports` data (tested). Orphans are filtered by `levelId` with their own level and are not listed under a `line` filter (they have no line).
- **`convert_pipe_run replace` moves the supports.** Each support of the legacy pipe takes the run id as `pipeId`, is snapped to the nearest point of the new centreline (`nearestOnRoute`, as the stretch reconcile does), is re-attached to steel (kept, re-attached, or DETACHED when nothing is in reach) and rebuilt; its mark and id stay. The summary and `data.supports { count, ids, maxOffsetMm, moved [{ id, mark, offsetMm }], reattached, detached, kept }` say what happened. The threshold is **one outside diameter of the run**: the conversion only moves the line where it merges a nearly straight vertex (at most the elbow angle tolerance, a few millimetres on usual lengths); a support farther than the pipe is wide from the new centreline was not on the pipe in the first place, or the pipe moved so much that its bracket geometry no longer holds; that is refused (`RTE_SUPPORT_OFF_RUN`, ids of the pipe and the supports, `detail.offsets`) and nothing changes. `RTE_PIPE_HAS_SUPPORTS` is removed (no backward compatibility): nothing raises it. Without `replace` the pipe keeps its supports and nothing moves. The editing hook of part 2 then re-checks the same supports once more (they are already on the line, so no second move); the summary can carry its generic `pipe supports of <run>: n re-checked`.
- **`move_building_element` names what the support rests on.** A support alone is refused with `<id> rests on pipe <id>` (move the pipe) or `<id> rests on plant run <run>` (a run is no building element: it moves with its equipment, or `edit_route`; delete the support and `add_pipe_support` to put it elsewhere), no longer with the wall / column / rafter text of the openings.
- **Native OCCT test.** `server/tests/nativePipeStep.test.ts` exports the small line with the native kernel: 3 solids, self-check green, no faceted solid, each product volume within 1e-6 (relative) of the closed form, total within 1e-6. The measurement agreed with the hand derivation on the first run (Windows 11, OCCT 7.9.2).

Open after V1c: IFC 4.3; PCF attributes of BOLT, SPINDLE-DIRECTION and UNIQUE-COMPONENT-IDENTIFIER (05 grade B); PCF welds, supports and spools (05); supports on a run in a document whose units are not mm; radiation and temperature-dependent conductivity in `line_heat_loss` (V2); the UI support tool still sends `pipeId` only.
