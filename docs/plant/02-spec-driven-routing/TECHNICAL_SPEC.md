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
| Gravity pipes                    | Civil drainage `add_drainage_pipe` / `update_drainage_pipe` with inverts, adverse-slope warning                                                                                           | `packages/domain-aec/src/civil/drainage/drainagePipeCommands.ts`               | Network between manholes, not plant piping; slope check idea reused  |
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

| Item | Before | Now |
| ---- | ------ | --- |
| V2 search (3D grid A*) | TS in `autoRoute/`, inside `auto_route_pipe` | `llull-compute route` (crate `llull-route`, Rust CPU): sparse / implicit obstacle grid, ≤ 2·10⁶ expansions in ≤ 5 s, candidate routes searched in parallel (rayon) |
| TS search | the only path | kept as the reference and the small-grid path (expansion cap TBD — measure at V2) |
| Problem and commit | inside one command | `route_problem` (query, TS) builds the canonical problem; `auto_route_pipe` (mutating, TS) validates a supplied solution and commits it as an ordinary run |
| `route_pipe`, derivation, checks, takeoff | TS | unchanged |
| Gate | Vitest | plus `npm run native:check` (`cargo test` + `cargo clippy -D warnings`) for `llull-route` |

Flow (L1, L2, L6). The host transport `auto_route` (CLI `llull route auto lineId=… from=… to=…`) runs `route_problem`,
writes its `data` to a job folder, runs `llull-compute route <job-folder>` (RS1 job folder + NDJSON progress) and
dispatches `auto_route_pipe { …, solution }`. Native code never writes the document. Before it commits,
`auto_route_pipe` checks that:

- `solution.problemHash` equals the hash of the problem rebuilt from the current document (a stale solution is refused);
- every leg is axis-aligned on the grid, clear of every inflated obstacle box and keep-out, and the path starts and
  ends with the required port stubs;
- the reported length, bend count and cost match the PIs.

A failure gives `RTE_AUTOROUTE_SOLUTION_INVALID` with the failing leg in `paths`. A solution from any source (native,
TS or hand-written) is held to the same rule. Without `solution`, `auto_route_pipe` runs the TS A* under its small cap
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
| `set_heat_tracing`        | mutating      | `{ lineId, type, tracers, maintainTempC?, allowances?: { valveM, flangeM, supportM } }`                                                                                                                          | V1; data only                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `piping_connectivity`     | query         | `{ lineIds?, from?: portId, to?: portId }`                                                                                                                                                                       | `data = { nodes, edges, openEnds, path? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `check_piping`            | query         | `{ lineIds?, maxHandwheelCentreHeight?, minWeldSpacing?, include?: string[] }`                                                                                                                                   | `data = { status, issues: [{ code, severity, ids, paths, detail, remediation }], counts, unverified, reviewRequired }`                                                                                                                                                                                                                                                                                                                                                                      |
| `piping_takeoff`          | query         | `{ runId? , lineId? }`                                                                                                                                                                                           | `data = { counts, parts[], pipePieces[{ id, dn, cutLengthMm, leg }], joints[], totalPipeMm, centrelineLengthMm, legs[], turns[], studs, unverified }`                                                                                                                                                                                                                                                                                                                                       |
| `line_heat_loss`          | query (V1)    | `{ lineId, fluidTempC, ambientTempC, outsideFilmWm2K, insideFilmWm2K?, steelConductivityWmK, insulationConductivityWmK? }`                                                                                       | `data = { heatLossWPerM, surfaceTempC, provenance, reviewRequired: true }`; every defaulted input named                                                                                                                                                                                                                                                                                                                                                                                     |
| `route_problem`           | query (V2)    | `{ lineId, from, to, grid?, bendCost?, clearance?, preferElevations?, keepOut?: ids[] }` | `data = { problem, problemHash }`: grid box, cell size, inflated obstacle boxes, keep-outs, port stubs, integer-µm costs (input of `llull-compute route`, §2.A) |
| `auto_route_pipe`         | mutating (V2) | `{ lineId, from, to, grid?, bendCost?, clearance?, preferElevations?, keepOut?: ids[], maxExpansions?, solution?: { problemHash, pis, lengthMm, bends, cost, optimal, expansions, provenance } }`                                                                                                         | @affects creates 1 ordinary run · @invariant a supplied `solution` is validated against the current problem (§2.A) · @failure `RTE_AUTOROUTE_NO_PATH`, `RTE_AUTOROUTE_BUDGET`, `RTE_AUTOROUTE_SOLUTION_INVALID`                                                                                                                                                                                                                                                                                                                                                                                                  |

Descriptions follow AF-02: what, when, units, refusals, next command (e.g. `route_pipe` → "then run
`check_piping`; add valves with `insert_inline_component`").

Equipment nozzles: `add_nozzle` / `update_nozzle` belong to 03-parametric-equipment and only have to expose
`PortSpec` through `PortSource`. Supports: `add_pipe_support` gains `runId` (V1) using the run centreline
(`piping_takeoff.legs`), so `check_pipe_supports` keeps working on both pipe kinds.

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
| PCF (Alias, licensed spec [S26][S35]) | write (V1), read (V2) | from `piping_takeoff.parts` + graph: PIPE / ELBOW / TEE / FLANGE / GASKET / BOLT / VALVE records with END-POINT (+ size), CENTRE-POINT (elbows, tees), BRANCH1-POINT; pipeline header with line number                                      | 05-isometrics-fabrication     |
| IFC 4.3                               | write                 | `IfcPipeSegment`, `IfcPipeFitting` (BEND, JUNCTION, TRANSITION, CONNECTOR), `IfcValve`, `IfcDistributionPort` + `IfcRelNests` / `IfcRelConnectsPorts`, `IfcDistributionSystem` per line; extends `building/exchange/ifcIndustrialExport.ts` | 08-plant-data-reports-interop |
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

| Code                                                                                          | Severity                   | Raised by                                      | Meaning                                                     | Remediation                                                |
| --------------------------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------- |
| `RTE_UNKNOWN_LINE`                                                                            | error                      | all run commands                               | `lineId` not found                                          | `create_pipeline` first                                    |
| `RTE_UNKNOWN_PORT`                                                                            | error                      | `route_pipe`, `add_branch`                     | port id not found                                           | list ports with `piping_connectivity` / `add_tie_in_point` |
| `RTE_PORT_IN_USE`                                                                             | error                      | `route_pipe`                                   | port already connected                                      | route from the run end, or `add_branch`                    |
| `RTE_INVALID_PORT`                                                                            | error                      | `add_tie_in_point`                             | zero direction, DN ≤ 0                                      | give a unit direction toward the pipe and a DN             |
| `RTE_DUPLICATE_TAG` / `RTE_DUPLICATE_LINE_NUMBER`                                             | error                      | create commands, check                         | not unique                                                  | choose another tag / sequence                              |
| `RTE_SPEC_UNKNOWN`                                                                            | error                      | `create_pipeline`                              | spec not loaded                                             | `import_pipe_spec` (01)                                    |
| `RTE_SPEC_NO_COMPONENT`                                                                       | error                      | derivation                                     | no catalogue row for (type, DN, rating…)                    | add the row to the spec or change size / rating            |
| `RTE_SPEC_AMBIGUOUS`                                                                          | error                      | derivation                                     | several rows match, no preference                           | set a preference in the spec                               |
| `RTE_NO_CONNECTION_RULE`                                                                      | error                      | derivation                                     | end-type pair without a rule (e.g. BW–SW)                   | add the rule in the spec or change the end type            |
| `RTE_NO_FITTING_FOR_ANGLE`                                                                    | error                      | `route_pipe`, `add_branch`, `convert_pipe_run` | turn angle not in spec ± tolerance                          | use 90 / 45 legs, or allow trimmed elbows in the spec      |
| `RTE_SEGMENT_TOO_SHORT`                                                                       | error                      | derivation                                     | negative cut length (`detail.cutLengthMm`)                  | lengthen the leg to ≥ sum of centre-to-ends                |
| `RTE_ZERO_LEG`                                                                                | error                      | `route_pipe`                                   | leg length 0                                                | remove the leg                                             |
| `RTE_PORT_DIRECTION`                                                                          | error                      | `route_pipe`                                   | first / last leg not along the port direction               | start with a leg along the port direction                  |
| `RTE_CLOSING_LEG_IMPOSSIBLE`                                                                  | error                      | `route_pipe`                                   | target port not reachable by one straight leg               | add legs; `detail.offset` gives the remaining vector       |
| `RTE_SIZE_MISMATCH` / `RTE_RATING_MISMATCH` / `RTE_FACING_MISMATCH` / `RTE_END_TYPE_MISMATCH` | error                      | `route_pipe`, check                            | ports disagree and the spec has no transition               | add a reducer / change spec / fix the nozzle               |
| `RTE_INLINE_DOES_NOT_FIT`                                                                     | error                      | inline commands                                | component overlaps a fitting                                | move it (`centreDistance`) or lengthen the leg             |
| `RTE_BRANCH_ON_FITTING` / `RTE_BRANCH_NO_TABLE_ROW`                                           | error                      | `add_branch`                                   | branch point inside a fitting / no branch-table cell        | move the point / extend the branch table                   |
| `RTE_HAS_BRANCHES`                                                                            | error                      | `delete_pipe_run`                              | branch runs depend on it                                    | `cascade: true`                                            |
| `RTE_STRETCH_FAILED`                                                                          | error (run marked broken)  | regeneration after an edit                     | displacement not absorbable orthogonally                    | re-route the run (`edit_route`)                            |
| `RTE_OPEN_END`                                                                                | warning                    | `check_piping`                                 | part port connected to nothing                              | route to a port, add a cap / blind, or a tie-in            |
| `RTE_DISCONNECTED_PORT`                                                                       | info                       | `check_piping`                                 | nozzle / tie-in without a run                               | route it or mark it spare                                  |
| `RTE_FITTING_TO_FITTING`                                                                      | warning                    | check                                          | zero cut length                                             | accept or lengthen                                         |
| `RTE_WELD_SPACING`                                                                            | warning                    | check                                          | pipe piece shorter than the weld-spacing rule (named)       | lengthen or accept per project spec                        |
| `RTE_ADVERSE_SLOPE` / `RTE_POCKET`                                                            | warning                    | check                                          | sloped line rises along flow / low or high point            | fix the slope / add drain or vent                          |
| `RTE_FROM_TO_MISMATCH`                                                                        | warning                    | check                                          | line from / to text ≠ connected equipment                   | update the line or the route                               |
| `RTE_VALVE_OPERATOR_HEIGHT` / `RTE_VALVE_OPERATOR_CLASH`                                      | warning                    | check                                          | handwheel above the given limit / operator envelope clashes | rotate the stem, add a platform (06 STA), chain wheel      |
| `RTE_NONSTANDARD_FITTING`                                                                     | warning                    | check                                          | trimmed elbow, pulled bend                                  | reviewer accepts                                           |
| `RTE_STUB_IN_REVIEW`                                                                          | warning + `reviewRequired` | check                                          | stub-in needs reinforcement check                           | 07 PST                                                     |
| `RTE_SPEC_UNVERIFIED`                                                                         | warning (cannot be hidden) | check                                          | spec not approved / rows unverified                         | reviewer approves the spec (01)                            |
| `RTE_AUTOROUTE_NO_PATH` / `RTE_AUTOROUTE_BUDGET`                                              | error                      | `auto_route_pipe`                              | no path / expansion budget hit                              | widen the grid box, lower clearance, add via points; above the TS cap run `llull route auto` |
| `RTE_AUTOROUTE_SOLUTION_INVALID` | error | `auto_route_pipe` with `solution` | stale `problemHash`, leg off-grid / through an obstacle or keep-out, or length / bends / cost do not match the PIs | re-run `llull route auto` on the current document |
| `NATIVE_TOOL_MISSING` | error | `auto_route` transport | `llull-compute` not installed | install the desktop app, or route without `solution` under the TS cap |

## 8. Performance and robustness budgets

| Operation                                                 | Budget (desktop, Node 22, no kernel)                                |
| --------------------------------------------------------- | ------------------------------------------------------------------- |
| `route_pipe` 10 legs, derivation + geometry               | ≤ 50 ms                                                             |
| Regeneration of 1 000 runs (load)                         | ≤ 1.5 s                                                             |
| `check_piping` 1 000 lines / 20 000 parts                 | ≤ 2 s (graph O(n α(n)); clash via existing boxes)                   |
| `piping_takeoff` one line                                 | ≤ 10 ms                                                             |
| `auto_route_pipe` (V2) 100 m × 100 m × 30 m at 50 mm grid | native `llull-compute route`: ≤ 5 s, `maxExpansions` default 2·10⁶, `--timeout` respected (AF-40); TS reference path: cap and time TBD — measure |
| Document size                                             | stored intent ≤ 1 kB per run; derived parts never stored            |

Robustness: inputs with NaN / Infinity refused by the guard (`CMD_CORRUPT_RESULT` exists); all comparisons use
`ε`; ids depend only on route order (AF-13); a spec change that would invalidate a run is refused atomically.

## 9. Test strategy

| Level                                             | Content                                                                                         | VC                    |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------- |
| Unit `tests/unit/plant/piping/legs.test.ts`       | compass legs, closing leg, collinear merge, port direction                                      | VC-RTE-01, 09         |
| Unit `fittings.test.ts`                           | turn angles, tolerance accept / refuse, catalogue centre-to-end, arc length                     | VC-RTE-03, 08, 11, 15 |
| Unit `jointStack.test.ts`                         | cut lengths (flanged, BW, inline valve), fitting-to-fitting, weld spacing                       | VC-RTE-01, 04, 10     |
| Unit `branches.test.ts`                           | branch table, tee / olet cuts                                                                   | VC-RTE-06             |
| Unit `stretch.test.ts`                            | +X / +Y moves, failure case                                                                     | VC-RTE-12             |
| Unit `graph.test.ts` / `checks.test.ts`           | open ends, mismatches, from / to, operator height, unverified                                   | VC-RTE-05, 07, 09     |
| Unit `heatLoss.test.ts`                           | ht example                                                                                      | VC-RTE-14             |
| Data test `catalogueConsistency.test.ts`          | reads `validation/data/*.json`: OD / wall agree with `PIPE_SIZES`; 90 LR A ≈ 1.5 NPS (≤ 0.4 mm) | VC-RTE-15, 16         |
| Golden `tests/golden/plans.ts`                    | SC-RTE-01, 02, 03, 06 as plans (id-normalised snapshots + replay equality)                      | VC-RTE-17             |
| Scenario `tests/unit/plant/scenarioPlans.test.ts` | runs every `validation/plans/*.json` through `build_project` and compares `expected`            | all                   |
| Contract                                          | toolset `piping` membership, schema snapshot, plugin document extension (validate / restore)    | AF-01                 |
| Integration `tests/integration/`                  | `update_equipment` → run stretched; undo restores                                               | VC-RTE-12             |
| Server / CLI `server/tests/`                      | `llull run` on SC-RTE-01 with `--json` assertions                                               | VC-AF-02              |
| Native vs reference (`server/tests/routeNativeParity.test.ts`; `llull-route` cargo tests in `npm run native:check`) | TS and native searches give identical PIs, bends and cost; tampered solutions refused | VC-RTE-18, 25 |

Coverage gate 90/85/90/90 applies to `packages/domain-aec/src/plant/**`.

## 10. Delivery plan

| Milestone | Content                                                                                                                                                                                                    | Depends on                          | Effort |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------ |
| M0        | `@core/model/plant` types, `piping` plugin skeleton, document extension, `SpecLookup` + test stub                                                                                                          | —                                   | 2 d    |
| M1        | tie-in points, `create_pipeline`, `route_pipe` (legs, closing leg), elbows, BW joints, cut-back, `piping_takeoff`, display geometry                                                                        | M0                                  | 6 d    |
| M2        | flange sets + connection rules, inline components, reducers, branches (tee / olet), `check_piping` core codes, `piping_connectivity`, `convert_pipe_run`                                                   | M1; 01 PSC lookup (stub until then) | 7 d    |
| M3        | stretch on equipment / nozzle edits, `edit_route`, slope + adverse slope, insulation envelope in `check_clashes`, line-number template, supports on runs                                                   | M2; 03 EQP nozzles (`PortSource`)   | 6 d    |
| V1        | socket / threaded engagement, eccentric reducers, trimmed elbows / bends, pockets, valve operators, heat tracing data, `line_heat_loss`, PCF writer hand-off (05), IFC ports (08), exact solids via kernel | M3                                  | 12 d   |
| V2        | `route_problem`, `auto_route_pipe` (TS grid A\* + solution validation), `llull-compute route` (RS-7), rack preference, keep-outs, multi-line ordering                                                                                                                              | V1; RS-0 (`solver/` workspace)      | 15 d (+ `llull-route` inside RS-7) |

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

## 13. As built (RS1 RS-7 plant slice 2026-10-19; RTE-M1, RTE-M2 2026-10-24)

Built: the V2 auto-router (§2.A, §5.12) end to end (2026-10-19), and **M1 (2026-10-24, §13.6)**: spec-driven `route_pipe`
(compass legs, closing leg, spec elbows with deviation, joint stack and cut-back, flange sets at flanged ports), `piping_takeoff`,
one derivation of parts and joints for every run (auto-routed runs included), per-part display geometry, `SpecLookup` over
01 PSC and `PortSource` over tie-ins, equipment nozzles and run ends. **M2 (2026-10-24, §13.7)** added inline valves and reducers, branches (tee / olet / stub-in), `check_piping`, `piping_connectivity`, `convert_pipe_run` and `update_pipeline`. Not built: stretch, slope, insulation clashes, heat loss, `edit_route` (M3–V1 stay open).

### 13.1 What exists

| Part | Where | Notes |
| ---- | ----- | ----- |
| `CadDocument.plant` (`PlantModel { piping? }`) | `packages/core/src/model/plant.ts` | Types only. `PipingModel` = tie-ins, lines, runs (+ order lists); `clear_document` removes the slice |
| Plugin `piping`, toolset `piping` | `packages/domain-aec/src/plant/piping/` (installed in `src/app/plugins.ts`) | Toolset getter = legacy `PIPING_TOOLS` + plugin commands + the `auto_route` transport |
| `add_tie_in_point`, `create_pipeline` | `commands/tieIn.ts`, `commands/pipeline.ts` | §4 params subset; `RTE_INVALID_PORT`, `RTE_DUPLICATE_TAG`, `RTE_DUPLICATE_LINE_NUMBER`; `create_pipeline` resolves the spec through `SpecLookup` (`RTE_SPEC_UNKNOWN`, `RTE_SPEC_NO_COMPONENT` for a DN without a pipe row); line number from the §5.9 template (named in `data.template`) |
| `route_problem` (query) | `commands/autoRoute.ts`, `autoRoute/problem.ts` | `data = { problem, problemHash, defaults, elbowCentreToEnd, flangeSetLengths, portOwners, unverified, unverifiedReasons, tsMaxExpansions }` (since M1 the elbow A and flange sets come from the line spec); `problemHash` = sha256 of the canonical problem JSON |
| `auto_route_pipe` (mutating) | `commands/autoRoute.ts`, `autoRoute/search.ts`, `autoRoute/solution.ts` | TS A* under `TS_MAX_EXPANSIONS` = 200 000, or `solution` checked by `checkSolution` (§2.A list) and committed; `data` per SC-RTE-08 (`centrelineToPiLengthMm`, `bends`, `cost`, `optimal`, `expansions`, `engine`, `problemHash`) plus `parts`, `totalPipeMm`, `unverified`, `unverifiedReasons`; since M1 the committed run must derive (else refused with the derivation code) and the elbow A and flange sets come from the spec |
| Run geometry | `derive.ts`, `routeParts.ts`, `geometry.ts` | One derived read-only revolution entity per drawable part of every run (id `<runId>/<kind>-<k>`, §13.6); omitted from saved files, re-derived on load; derivation guard (replaces the single mitred mesh per run of the V2 slice) |
| Native search | `solver/crates/llull-route` (`llull-compute route <folder>`) | Contract in `llull_route::job` (job.json `{ problemHash, problem, maxExpansions }` → result.json `{ status, pisUm, lengthUm, bends, cost, optimal, expansions, engine, version }`) |
| Transport `auto_route` (CLI `llull auto_route lineId=… from=… to=…`) | `server/src/native/autoRoute.ts`, `tools.ts` | `route_problem` → job → `auto_route_pipe { …, solution }`; `NATIVE_TOOL_MISSING` without the binary |
| Tests | `tests/unit/plant/piping/*.test.ts`, `server/tests/routeNativeParity.test.ts`, cargo tests of `llull-route` | VC-RTE-18 (SC-RTE-08 data), VC-RTE-25 (parity, validation, budget) |

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

| Case | Expansions | Time |
| ---- | ---------- | ---- |
| SC-RTE-08 free space (TS and native) | 110 | < 1 s incl. process start |
| 200 × 100 × 100 m box at 50 mm (1.6·10¹⁰ cells), wall at x = 50 m with a window 1 m off the port line | 1 761 410 | native 3.65–3.98 s; TS refuses `RTE_AUTOROUTE_BUDGET` at 200 000 (≈ 1.7 s) |

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

| Part | Where (`packages/domain-aec/src/plant/piping/`) | Notes |
| ---- | ----------------------------------------------- | ----- |
| `SpecLookup` | `specLookup.ts` | In-process adapter over 01 PSC `resolveComponent` over `doc.plant.spec` and the catalogues the spec names (`specCatalogs`). `pipe(dn)`, `component({ types, dn, rating?, facing? })`, `elbowAngles()`, `connection(a, b)`, `status()`. PSC `PSC_AMBIGUOUS_COMPONENT` → `RTE_SPEC_AMBIGUOUS`, every other miss → `RTE_SPEC_NO_COMPONENT`, no spec → `RTE_SPEC_UNKNOWN` (the PSC code stays in `detail`). Rows carry `unverified` (not every dimension grade A) |
| `PortSource` | `ports.ts` | `resolvePortId(doc, id)` → `PortSpec` + `PortRef`: tie-in id, equipment nozzle `<tag>:<mark>` (through `equipmentPorts`, end type FL), run end `<runId>:start|end` (a BW pipe end that continues the pipe). `portOccupant` gives `RTE_PORT_IN_USE` for all three |
| `route_pipe` | `commands/routePipe.ts`, `legs.ts` | §4 params without `dn`, `planLength`, `slope` (M2, M3). Compass or vector legs, `via` points, straight closing leg to a port on its axis, collinear merge, port direction within the tolerance (deviation reported) |
| Elbows | `fittings.ts` | Nearest spec angle within the tolerance, catalogue centre-to-end, `deviationDeg` reported, 60° or a reversal → `RTE_NO_FITTING_FOR_ANGLE` (`error.detail.anglesDeg`) |
| Joint stack | `jointStack.ts`, `routeParts.ts` | Occupied intervals per leg → pipe pieces with cut lengths; `RTE_SEGMENT_TOO_SHORT` (`error.detail.cutLengthMm`), fitting-to-fitting (no piece, warning), weld spacing warning with the named default `max(4 t, 50 mm)`. `Interval.kind: 'inline'` and `RTE_INLINE_DOES_NOT_FIT` exist for M2 and are unit-tested with the SC-RTE-02 numbers (527.5 / 354.5) |
| Flange set | `flangeSet.ts` | At an FL port: weld-neck flange + gasket + bolt set from the spec; `RTE_RATING_MISMATCH`, `RTE_FACING_MISMATCH`, `RTE_SPEC_NO_COMPONENT` naming the missing dimension |
| Derivation | `routeParts.ts` | `deriveRun(doc, run)` → `RoutedPart[]`, `Joint[]`, legs, turns, warnings, totals; ids `<runId>/<kind>-<k>` (k per kind, route order; the start flange set is numbered before the end one) and `<runId>/joint-<k>`. One derivation for `route_pipe` and `auto_route_pipe` runs |
| Display | `geometry.ts`, `derive.ts` | One `revolution` entity per pipe piece, elbow, flange and gasket (bolt sets have none); layers `P-PIPE`, `P-FITT`, `P-FLNG`; ids kept in `plant.piping.entityIds`; guard, load-time re-derivation |
| `piping_takeoff` | `takeoff.ts`, `commands/pipingTakeoff.ts` | `runId` / `lineId` / neither; counts by `typeKey` + `pipePieces`, `studs`, joint kinds; `parts`, `pipePieces` (cut lengths), `joints`, `totalPipeMm`, `centrelineLengthMm`, `legs`, `turns`, `warnings`, `unverified` + reasons |
| Validation data | `docs/plant/02-spec-driven-routing/validation/data/catalog_stub_cs150.json`, `spec_cs150.json` | The PSC-format stand-in of `spec_stub_cs150.json`: catalogue `rte-validation-stub` (the plans' input dimensions) searched before `llull-open-piping`, and spec CS150 (draft). Plans SC-RTE-01, 02, 03, 04, 05, 07, 08 import both first |
| Tests | `tests/unit/plant/piping/{legs,fittings,jointStack,specLookup,ports,routeParts,routePipe,takeoff,geometry,rteScenarioPlans}.test.ts`, golden `piping_pump_to_vessel` | SC-RTE-01: cuts 1269 / 2696 / 2696 / 1196 / 2769, total 10 626, centreline 11 739.044, 4 elbows, 2 weld-neck flanges, 2 gaskets, 2 bolt sets (16 studs), 10 butt welds, 2 flanged joints (VC-RTE-01..03, 17, 23) |

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

| Part | Where (`packages/domain-aec/src/plant/piping/`) | Notes |
| ---- | ----------------------------------------------- | ----- |
| Run state | `routeEnv.ts`, `routeEnds.ts`, `routeInline.ts`, `routeBranch.ts`, `routeParts.ts`, `deriveTypes.ts`, `runSizes.ts` | `deriveRun` splits each leg into slots (end sets, elbows, valves, reducers, tees) sorted along the leg and cuts the pipe between them with the M1 joint stack; olets and stub-ins sit on a pipe piece afterwards. `PipeRun` gains `dn?`, `inline?`, `branches?`; `PortRef` gains `branch` |
| Valves | `routeInline.ts` | Catalogue `faceToFace`; `FL` ends give a weld-neck flange + gasket + bolt set per face (the same `resolveFlangeSet` as a nozzle, with the valve row's rating and facing), `BW` ends none; any other end type is `RTE_NO_CONNECTION_RULE`. Occupies `F + 2 (g + Y)` (flanged) or `F` |
| Reducers | `routeInline.ts`, `runSizes.ts` | Concentric, row `length` (`H`), occupies it centred; the run continues at `dn2` |
| Branches | `routeBranch.ts`, `commands/addBranch.ts` | Fitting = branch-table cell of the HEADER line's spec for (header size at the point, branch size): `SpecLookup.branch()` over PSC `resolveBranch` (`PSC_BRANCH_UNDEFINED` -> `RTE_BRANCH_NO_TABLE_ROW`) |
| Checks, graph | `checks.ts`, `graph.ts`, `commands/checkPiping.ts`, `commands/pipingConnectivity.ts` | See the rules below |
| Conversion, line update | `commands/convertPipeRun.ts`, `commands/updatePipeline.ts` | |
| Run commands | `commands/inlineComponents.ts` (`insert_inline_component`, `move_inline_component`, `remove_inline_component`), `commands/addBranch.ts`, `commands/deleteRun.ts` (`cascade`), `commands/routePipe.ts` (`inline`), `runUpdate.ts` (`rederive`: derive the changed runs and every run attached to them and rebuild their entities, or fail whole) | |
| Display | `geometryInline.ts` | Valve = body + stem + handwheel disc on layer `P-VALV` (ids `<valve>`, `<valve>/stem`, `<valve>/wheel`), reducer frustum, tee = header cylinder + `<tee>/branch` stub, olet cylinder, stub-in none. Schematic: the proportions are named display constants, a catalogue `stemHeight` sets the stem length |
| Tests | `tests/unit/plant/piping/{inlineComponents,inlineVariants,branches,branchPorts,checks,convertPipeRun,updatePipeline,rteScenarioPlans}.test.ts`, golden `piping_gate_valve`, `piping_header_branches`, `piping_reducer_run`, `piping_legacy_conversion` | Coverage of `plant/piping/**`: 97.96 % statements, 92.57 % branches, 99.11 % functions, 99.36 % lines (measured 2026-10-24 with `tests/unit/plant`) |

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

Open for M3 / V1: orthogonal stretch for branches and inline components (their leg indices and distances move with the PIs), `edit_route`, slope legs and adverse slope, insulation envelope in `check_clashes`, line-number settings, supports on runs,
eccentric reducers, trimmed elbows, valve operator clash, PCF / IFC output of valves and branches (05 / 08).
