# Gap 06 STA — Plant structures and access: technical specification

Companion of [FUNCTIONAL_SPEC.md](FUNCTIONAL_SPEC.md). Laws: `.claude/rules/architecture.md` (L1–L10). Agent-first
requirements: [`../../aerospace/AGENT_FIRST.md`](../../aerospace/AGENT_FIRST.md). Validation:
[`validation/README.md`](validation/README.md).

## 1. Current state in llull (2026-10-18)

The building model lives in core: `packages/core/src/model/building.ts` holds `BimCategory`, `BuildingModel` and the
element interfaces. The `building` plugin (`packages/domain-aec/src/building/`) owns its evaluation (element →
entities), validation, IFC / DXF export, plans and takeoff. The `industrial` plugin (`packages/domain-aec/src/industrial/`,
toolset `building`) adds steel and plant commands to the same element bag.

| Capability | Where | Relevant limits for this gap |
| ---------- | ----- | ---------------------------- |
| Steel catalogue: IPE, HEA, HEB, UPN, C, SHS, RHS, CHS (incl. 48.3 × 3.2 handrail tube), L | `packages/domain-aec/src/steel/profiles.ts` (`findProfile`, `profileOutline`, kg/m, paint perimeter) | no flats (toe plate, stair stringer flat bars), no gratings, no rungs (solid round bar) |
| Steel member `add_steel_member`, `update_steel_member`; roles column, rafter, beam, brace, purlin, rail, crane | `industrial/framing/memberSteelCommands.ts`; `SteelMemberElement` | no roles for stringer, post, rung, strut, bracket; no fireproofing attribute |
| Grid framing `add_grid_columns`, `add_grid_beams` (`topOffset` e.g. minus grating thickness), `add_grid_bracing` | `industrial/framing/gridFramingCommands.ts` | a pipe rack is built by hand from these (docs/INDUSTRIAL.md "pipe-rack bent") |
| Portal-frame hall generator | `industrial/portal/*` | pattern for a one-step generator that composes members (reused for `add_pipe_rack`) |
| Steel verification `check_steel_members` (EN 1993-1-1: sections, buckling, moment frames with rigid joints, bracing, floors with `floorDeadLoad` 0.5 kN/m² "gratings" and `imposedLoad` 5 kN/m² on **slabs**) | `industrial/steelDesign/steelMembersCheck.ts`, `steelAreaLoads.ts` | gratings exist only as `add_slab` floors; no platform live load except via slabs |
| Floors / gratings modelled as slabs; `add_equipment_openings` cuts every floor / grating an equipment passes through | `building/elements/structure.ts` (`add_slab`), `industrial/equipment/equipmentOpenings.ts` | no bearing-bar direction, no span check, no grating mass |
| Concrete stair `add_stair`: waist slab, N risers default level height ÷ 175 mm, tread 280, one landing (straight / quarter / half turn), Blondel 2R + G reported (600–650 "comfortable"), headroom note | `building/elements/structure.ts` lines ≈ 410–520, `building/geometry/stairGeometry.ts`, `building/drawings/planStairs.ts`, `building/exchange/ifcStairExport.ts` (`IFCSTAIR`, `IFCSTAIRFLIGHT`) | climbs exactly one level from its base; no steel stringer stair; no railing; no rule check beyond the summary text |
| Equipment `add_equipment` with `shape: vertical_vessel / horizontal_vessel`, clearance zone, weight | `industrial/equipment/equipment.ts`, `EquipmentElement` | vessel = cylinder inscribed in `size`; no nozzles / manways (03 EQP) |
| Pipes, pipe supports, cable trays | `industrial/piping/*` | no valves (02 RTE), so no operating points |
| Clashes, incl. stairs through floors without a well | `industrial/clash/clash.ts`, `clashSlabs.ts` | new access elements must join the clash sets |
| IFC export of building / industrial elements | `building/exchange/ifcBuild.ts`, `ifcIndustrialExport.ts`, `ifcStairExport.ts` | no `IfcRailing`, no ladder (`IfcStair` LADDER), no grating plate |
| Takeoff, schedules, plan / elevation sheets, DXF | `building/quantities/*`, `building/drawings/*`, `building/exchange/dxfExport.ts` | no access lines |
| Generic sweep (the description mentions handrails) | `packages/core/src/commands/solids/sweep.ts` | a free solid, not a BIM element; not checked |

So llull has **no** grating object, platform, ladder, railing, steel stair, pipe-rack generator, access rule table,
access / reachability check, or fireproofing. Nothing in `packages/` mentions ladders, guardrails or fireproofing (grep,
2026-10-18).

## 2. Target architecture

- **New plugin `plantStructures`** in `packages/domain-aec/src/plantStructures/`, MCP toolset **`plant_structures`**,
  installed by `src/app/plugins.ts` `installDefaultPlugins()` (L10). It uses the shared building model, like
  `industrial` does. Its elements live in `BuildingModel.elements` and are evaluated by the building document
  extension through an evaluator table, so the plugin adds a branch per new category and not a `switch` in every
  caller (C6).
- **Core change, minimal and type-only:** new members of the `BimCategory` union and new element interfaces in
  `packages/core/src/model/building.ts` (the model layer already holds every building element type). There is no new
  core command and no core import of the plugin. This is the same pattern as `pipeSupport` / `tray` / `plate`.
- **Composition (L10):** generators call existing commands through `ctx.registry` / `execute`
  (`add_grid_line`, `add_steel_member`, `add_grid_bracing`, `add_slab_opening`) where an existing element type
  fits. They create new elements only for objects that have no existing type (grating, railing, ladder, steel stair,
  assembly). The whole generator is **one** mutating command, so it is one feature step and one undo (L8).
- **Assemblies and derivation guards (L8):** a platform, circular platform or pipe rack is an `assembly` element that
  stores its parameters and the ids of its parts. Parts carry `assemblyId`. A derivation guard refuses direct edits of
  a part (`CMD_DERIVED_GEOMETRY`); the agent edits the assembly (`update_platform`, `update_pipe_rack`), which
  regenerates its parts with step-scoped ids.
- **Rules as data (AF-30):** `plantStructures/rules/*.ts` are typed tables generated once from
  `validation/data/access_rules.json` (same ids, grade, clause, source). Check commands read rows by id and never use a
  literal limit. Project rulesets are a plugin `DocumentExtension` slice (`plantRules`), validated on load.
- **No kernel needed (L9):** all geometry is prisms, sweeps and annular sectors built with
  `domain-aec/src/shared/mesh.ts` (`prismMesh`, `sweepMesh`), as the industrial evaluators do today. The kernel is
  used only by the existing optional exact export paths.
- **Purity (L3):** every command returns a new document. Check commands are queries (`data`, document unchanged).

```
packages/domain-aec/src/plantStructures/
  plugin.ts                  CadPlugin { name: 'plantStructures', toolset: 'plant_structures', commands, guards, document }
  catalog.ts                 command list
  codes.ts                   STA_* error / finding codes (§7)
  rules/ruleTable.ts         AccessRule type, lookup, grade -> severity policy
  rules/iso14122.ts          rows ISO-* (generated from access_rules.json, source ids kept)
  rules/osha1910.ts          rows OSHA-*
  rules/projectRules.ts      DocumentExtension slice: project rulesets (FR-STA-13)
  grating/gratingTypes.ts    catalogue (NAAMM 19-W-4 family from bar geometry; metric types flagged unverified)
  grating/gratingSpan.ts     U / C / D closed forms, span detection on supports
  grating/gratingCommands.ts add_grating, update_grating, list_grating_types, check_grating
  railing/railingLayout.ts   posts along a polyline, corners, openings, gates, toe plate
  railing/railingCommands.ts add_railing, update_railing
  ladder/ladderLayout.ts     rungs, stiles, cage hoops / bars, landings, exit geometry
  ladder/ladderCommands.ts   add_ladder, update_ladder
  stair/steelStairLayout.ts  riser count, stringers, treads, landings
  stair/steelStairCommands.ts add_steel_stair, update_steel_stair
  platform/platformLayout.ts polygon platform framing + grating segmentation
  platform/circularPlatform.ts annular sector, brackets, segment split
  platform/platformCommands.ts add_platform, add_circular_platform, update_platform, platform_takeoff
  rack/pipeRackLayout.ts     stations, bents, tiers, struts, bracing bays
  rack/pipeRackCommands.ts   add_pipe_rack, update_pipe_rack
  fireproofing/*             set_fireproofing, fireproofing_takeoff (V1)
  access/accessGraph.ts      walking surfaces, connectors, BFS from grade
  access/accessChecks.ts     per-element rule evaluation -> findings
  access/checkAccess.ts      check_access command
  access/reachability.ts     check_reachability command
  evaluate/*.ts              element -> entities (one file per category)
  exchange/ifcAccessExport.ts IfcRailing / IfcStair LADDER / IfcPlate GRATING / IfcMember roles
```

Every file stays under 500 lines (C6). The existing `industrial` and `building` plugins are extended only at their
evaluator / IFC / takeoff dispatch tables (one registration line per category).

## 3. Data model

Additions to `packages/core/src/model/building.ts` (all optional fields, so documents without them need no migration;
the document version is unchanged):

```ts
export type BimCategory = /* existing */ | 'grating' | 'railing' | 'ladder' | 'steelStair' | 'assembly';

export type MemberRole = /* existing */ | 'stringer' | 'post' | 'strut' | 'bracket';

/** Walking surface of open-bar grating, top at level elevation + `topOffset`. */
export interface GratingElement extends LevelElementBase {
  readonly category: 'grating';
  boundary: Vec2[];                 // plan polygon (≥ 3), or an annular sector discretised by the generator
  openings?: Vec2[][];
  topOffset: number;                // document units
  gratingType: string;              // catalogue key, e.g. "19-W-4 1-1/4x3/16"
  bearingBarAngle: number;          // plan radians; bars span between supports in this direction
  supportIds: [string[], string[]]; // members it bears on, one list per side (end-to-end members share a side; resolved by add_grating)
  assemblyId?: string;
}

export interface RailingElement extends LevelElementBase {
  readonly category: 'railing';
  path: Vec3[];                     // top-of-walking-surface line, level-relative z
  height: number;                   // top of handrail above the path
  kneeRails: number;                // intermediate rails, equally spaced
  toePlate: number;                 // toe-plate height, 0 = none
  postProfile: string; railProfile: string;
  postSpacingMax: number;
  openings?: { from: number; to: number; gate: boolean }[];   // distances along the path
  role: 'guardrail' | 'handrail';
  hostId?: string;                  // platform / grating / stair it follows
  assemblyId?: string;
}

export type LadderFallProtection = 'none' | 'cage' | 'ladder_safety_system' | 'pfas';

export interface LadderElement extends LevelElementBase {
  readonly category: 'ladder';
  base: Vec3;                       // middle of the ladder at the departure level, level-relative
  facing: number;                   // plan radians: direction the climber faces
  climbHeight: number;
  clearWidth: number;
  rungPitch: number;                // resolved, uniform
  rungCount: number;
  exit: 'through' | 'side_step';
  fallProtection: LadderFallProtection;
  cage?: { startHeight: number; hoopSpacing: number; diameter: number; bars: number };
  landings?: number[];              // heights of intermediate landings / rest platforms
  railExtension: number;            // stile / grab-bar extension above the arrival level
  backClearance: number;            // rung centreline to nearest object behind (measured at creation)
  installedOn: string;              // ISO date; drives OSHA 1910.28(b)(9)
  arrivalSurfaceId?: string;        // grating / slab / platform reached
}

export interface SteelStairElement extends LevelElementBase {
  readonly category: 'steelStair';
  start: Vec3; angle: number; rise: number; width: number;
  riserCount: number; riserHeight: number; going: number;
  stringerProfile: string;
  tread: { kind: 'grating'; gratingType: string } | { kind: 'checker_plate'; thickness: number };
  landings: { afterRiser: number; length: number }[];
  railingIds: string[];
  fromSurfaceId?: string; toSurfaceId?: string;
}

export type AssemblyKind = 'platform' | 'circular_platform' | 'pipe_rack' | 'table_top';

export interface AssemblyElement extends LevelElementBase {
  readonly category: 'assembly';
  kind: AssemblyKind;
  params: Record<string, unknown>;  // the validated generator params, replayed by update_*
  partIds: string[];
  hostId?: string;                  // equipment id for a circular platform
}

export interface FireproofingSpec {          // V1, on SteelMemberElement.fireproofing?
  type: 'cementitious' | 'intumescent';
  method: 'boxed' | 'contour';
  thickness: number;                         // document units
  rating: string;                            // free label, e.g. "UL 1709 2 h", never defaulted
  fromZ: number; toZ: number;                // level-relative extent along the member
  zoneId?: string; source: string;           // where the extent came from (project document)
}
```

Plugin document slice (`DocumentExtension`, FR-STA-13):
`plantRules?: { version: string; rulesets: Record<string, AccessRuleRow[]> }`. It holds project rulesets only; the
built-in ISO / OSHA tables ship with the code and are pinned by `RULE_TABLE_VERSION` (`2026-10-18`), which every finding
reports.

## 4. Commands

All commands are in toolset `plant_structures`. Geometry params are in document units, and every description states
this (AF-04). Angles in radians carry the suffix `Deg` when the param is in degrees. Query commands return `data` and
leave the document unchanged.

| Command | Kind | Params sketch | `@affects` / `@invariant` / `@failure` |
| ------- | ---- | ------------- | -------------------------------------- |
| `list_grating_types` | query | `{ standard?: 'naamm_mbg_531', query? }` (the metric catalogue is not in the MVP, Q3) | data: rows with bar geometry, kg/m², section values per metre, `verified`, mass source (built, M2) |
| `add_grating` | mutating | `{ boundary? \| bounds?, supportedBy: 'beams' \| memberIds[], gratingType, bearingBarDirection: [x,y], topOffset?, thickness?, levelId? }` (built, M2; `thickness` must equal the bar depth) | @affects 1 grating per support bay; @invariant top = level + topOffset, panels split at supports; @failure unknown type `STA_GRATING_TYPE_UNKNOWN`, no support under an edge `STA_NO_SUPPORT_FOUND`, polygon invalid `STA_INVALID_GEOMETRY` |
| `check_grating` | query | `{ ids?, uniformLoadKPa, concentratedLoadKNPerM?, deflectionLimitMm \| deflectionRatio, spanBasis? }` (no defaults: AF-31; built, M2) | data.panels[]: spanMm, allowableUniformKPa, allowableConcentratedKNPerM, deflectionMm, utilisation, findings |
| `add_railing` | mutating | `{ path? \| hostId + edges (+ opening?), height?, kneeRails?, toePlate?, postProfile?, railProfile?, postSpacingMax?, openings?, role?, rulesets?, levelId? }` (built, M3) | @affects 1 railing + posts / rails / toe plate entities; @invariant posts at ends and corners, equal spacing ≤ max; @failure path < 2 points, opening outside the path |
| `add_ladder` | mutating | `{ base, climbHeight? \| attachTo, facing, clearWidth?, rungPitch? \| rungPitchMax?, exit?, fallProtection?, installedOn?, rulesets? }` | @affects 1 ladder (+ gate in the host railing); @invariant uniform pitch; cage / landings placed per the active rulesets; @failure no arrival surface `STA_NO_ARRIVAL_SURFACE`, pitch infeasible for every ruleset `STA_LADDER_PITCH_INFEASIBLE` |
| `add_steel_stair` | mutating | `{ start, angle, rise \| toSurfaceId, width?, riserMax, going, stringerProfile?, tread?, landingEvery? \| landings?, railings?: 'none' \| 'left' \| 'right' \| 'both', railingHeight?, rulesets? }` | @affects 1 steelStair + 2 stringer members + treads + railings; @invariant equal risers, n = ceil(rise / riserMax); @failure riserMax / going ≤ 0, rise > 30 m |
| `add_platform` | mutating | `{ boundary, elevation, framing?: { profile, maxSpacing } \| 'existing', gratingType, bearingBarDirection, railing?: { edges: 'all' \| number[], height, … }, imposedLoadKPa? }` | @affects 1 assembly + beams + gratings + railings; @failure overlap with another platform at the same elevation `STA_PLATFORM_OVERLAP` |
| `add_circular_platform` | mutating | `{ equipmentId, elevation, startAngleDeg, sweepDeg, gap, width, gratingType?, bracketProfile?, bracketSpacingMax?, railing?: { edges: ('outer' \| 'inner' \| 'ends')[], height, postSpacingMax, kneeRails, toePlate } }` | @affects 1 assembly + brackets (members role bracket) + grating segments + railings; @invariant ri = OD/2 + gap; follows the vessel; @failure equipment not a vertical vessel `STA_EQUIPMENT_NOT_VESSEL`, elevation outside the shell height `STA_OUTSIDE_SHELL` |
| `update_platform` | mutating | `{ assemblyId, …any generator param }` | regenerates parts with step-scoped ids |
| `platform_takeoff` | query | `{ ids? }` | data.platforms[]: areas, radii, arcs, grating mass, railing length, posts, brackets, steel kg |
| `add_pipe_rack` | mutating | `{ origin, direction, length \| stations[], bentSpacing, width \| baysAcross[], tiers[], columnProfile, tierBeamProfile, strutProfile?, struts?: 'every_tier' \| 'top' \| 'none', bracingBays?, bracingProfile?, baseFixity?, walkway?: { tier, side, width, gratingType }, gridPrefix? }` | @affects grid lines + members + 1 assembly; @invariant tier beams have rigid joints to columns (moment frames for `check_steel_members`), struts pinned; @failure bentSpacing ≤ 0 or > length `STA_RACK_SPACING`, tiers not ascending `STA_RACK_TIERS` |
| `update_pipe_rack` | mutating | `{ assemblyId, … }` | regenerate |
| `check_access` | query | `{ ids?, rulesets: ('iso_14122' \| 'osha_1910' \| string)[], edgeDropThresholdMm?, edgeDropSource?, include?: ('ladders' \| 'stairs' \| 'railings' \| 'platforms' \| 'edges')[] }` | data: { verdict, findings[], byId, ruleTableVersion, reviewRequired: true, unverifiedRulesUsed[] } |
| `check_reachability` | query | `{ targets: { tag, kind, point }[] \| targetsFrom?: 'valves' \| 'instruments' (V1), operatingHeightMm: { min, max, source }, maxHorizontalReachMm, gradeIsWalkable? }` | data.targets[]: surfaceId, heightAboveSurfaceMm, reachMm, route[], ok, findings |
| `list_access_rules` | query | `{ ruleset?, grade? }` | the active rows with source and grade |
| `set_fireproofing` (V1) | mutating | `{ memberIds \| zone: { equipmentIds, radiusMm, heightMm, source }, type, method, thicknessMm, rating }` | @affects members' `fireproofing`; @failure zone without `source` refused `STA_FIREPROOF_ZONE_UNDEFINED` |
| `fireproofing_takeoff` (V1) | query | `{ ids? }` | data: per member area m², volume m³, totals |

`update_grating { ids, gratingType }` (M2) and `update_railing { id, … }` (M3) were added because the remediation of the findings names them. `update_platform` and the other `update_*` stay with their milestones.

The existing commands are extended, not duplicated:

- `quantity_takeoff`: lines `grating.<type>.m2/kg/ea`, `railing.rail.m`, `railing.post.ea`, `railing.toe-plate.m`, `railing.gate.ea`, `railing.steel.kg` (keys are `<group>.<material>.<unit>`, so the spec's `railing.m` became `railing.rail.m`; built M2 / M3), `ladder.rung.ea`, `ladder.cage.m`,
  `fireproofing.m2/m3`.
- `building_schedule`: kinds `grating`, `railing` (built), `ladder`, `stair_steel`, `platform`.
- `check_steel_members`: gratings contribute `floorDeadLoad` from the type's kg/m², and `platform.imposedLoadKPa`
  replaces the slab-only floor load.
- `check_clashes`: adds the new categories.
- `add_equipment_openings`: also cuts gratings.

Example skeleton (shape only):

```ts
/**
 * @affects creates 1 ladder element (stiles, rungs, cage hoops and bars as entities on layer S-LADR) and a gate in the host railing
 * @invariant rungs equally spaced; spaces = ceil(climbHeight / pitchMax); rungCount = spaces - 1
 * @failure no arrival surface within 50 mm of base z + climbHeight -> STA_NO_ARRIVAL_SURFACE; infeasible pitch -> STA_LADDER_PITCH_INFEASIBLE
 */
export const addLadder = defineCommand({
  name: 'add_ladder',
  description: 'Add a fixed vertical ladder … units: document units; rungPitchMax default = the largest pitch every active ruleset allows (ISO 300 mm) …',
  params: z.object({ base: vec3('…'), climbHeight: z.number().positive().optional(), /* … */ }),
  run: (doc, params, ctx): CommandResult => { /* pure: resolve -> layout -> new element */ },
});
```

## 5. Algorithms

### 5.1 Ladder (VC-STA-01..03)

- Pitch: the set allowed by the active rulesets is `[max(min_i), min(max_i)]`. ISO ∩ OSHA = [254.0, 300] mm.
  `spaces = ceil(H / pMax)`, `pitch = H / spaces`. If `pitch < pMin`, the pitch is infeasible
  (`STA_LADDER_PITCH_INFEASIBLE`) and the agent must change H or a ruleset. The arrival level counts as the last
  step, so `rungs = spaces − 1`. An explicit `rungPitch` is kept and only checked.
- Fall protection, in order:
  1. ISO: `H ≥ 3000` needs `cage` or `ladder_safety_system`.
  2. OSHA: `H > 7315.2` needs `ladder_safety_system` or `pfas` when `installedOn ≥ 2018-11-19`. Before that date a cage
     warns `STA_LADDER_CAGE_RETROFIT` with the 2036-11-18 date, which is under proposed repeal [S6].
  3. A cage starts at `startHeight` (default = ISO min 2200 mm). It runs to `railExtension` above the arrival.
  4. Hoops are at ≤ `hoopSpacing`. The default 1500 mm comes from a B row, so the generator uses it as a named default
     and the check only warns on it.
- Landings: caged sections are offset and landed every ≤ 15 240 mm (OSHA 50 ft, A). Ladders with LSS / PFAS rest every
  ≤ 45 720 mm (B). The ISO flight rule is C and is not applied. Landings are generated only when the ruleset requires
  them.
- Geometry: two flat-bar stiles (new catalogue family `FL`, e.g. FL70x10), solid round rungs (new family `RD`, e.g.
  RD20), cage hoops as flat-bar arcs, and vertical bars. The exit `through` passes between the extended stiles;
  `side_step` offsets the ladder from the edge. Back clearance is measured by ray-casting from each rung centre against
  member / equipment / wall boxes, and the minimum is stored.

### 5.2 Steel stair (VC-STA-04)

- `n = ceil(rise / riserMax)`, `h = rise / n`, `treads = n − 1 − landings`, `run = treads · g + Σ landing lengths`,
  `pitch = atan(h / g)`, `blondel = 2h + g`.
- Landings are inserted after riser `k · ceil(n / (flights))` when `landingEvery` (rise) is given; the ISO 3000 mm
  flight rise is B, so it is a suggestion and a warning only.
- Stringers are members of role `stringer` from the first nosing line to the top, offset by half the width. Treads are
  grating or plate prisms between the stringers. Headroom is checked along the pitch line against slab / grating /
  member boxes above (ISO 2300 mm, B).

### 5.3 Railing (VC-STA-05)

- The path is split into straight segments; corners always get a post. For a segment of length L, posts =
  `ceil(L / sMax) + 1`, at equal spacing. Shared corner posts are counted once.
- Openings remove the rails between two end posts. `gate: true` adds a self-closing gate entity (the ladder exit).
- Knee rails are equally spaced: clear gap = `(height − toePlate − (k + 1) · railDepth) / (k + 1)` (the top rail counts: §13.5), compared with
  ISO-GRD-GAP. OSHA-GRD-MID is checked as the 19 in opening only: the "midway" position has no numeric tolerance in the rows and equal spacing places the midrail within (toe plate − rail depth) / 2 of mid-height (§13.5).
- Comparison: Bonsai centres the remainder (`floor(L / s) + 1`) [S24]. llull keeps end posts, which fabrication needs.

### 5.4 Grating span (VC-STA-06)

- Supports are members whose top flange lies within 10 mm below the grating underside and whose axis is
  perpendicular (± 5°) to the bearing bars. Members on one support line (axes within 5 mm along the bars) carry the edge together; their extents across the bars must cover the panel width within 10 mm, else the panel is refused. The span is the distance between consecutive support axes along the
  bearing-bar direction (clear span option: minus the flange width).
- Per 1 m (or 1 ft) width: `n = width / pitch`, `S = n t d² / 6`, `I = n t d³ / 12`.
  - Uniform: `U = 8 F S / L²` (per width).
  - Concentrated midspan line load: `C = 4 F S / L`.
  - Deflections: `5 w L⁴ / 384 E I` and `C L³ / 48 E I`.
  - F = 18 000 psi (124.1 MPa), E = 29 000 ksi (200 GPa) per the NAAMM steel tables (A via S20 / S21 agreement).
- Self-weight is excluded from the table U (NAAMM convention [S19]). `check_grating` adds it to the demand.
  Serrated bars use the reduced depth from the catalogue row.

### 5.5 Circular platform (VC-STA-07)

- `ri = OD / 2 + gap`, `ro = ri + width`. The sector runs from `startAngle` over `sweep`.
- Area `A = (θ / 2)(ro² − ri²)`. Outer arc `θ ro`, inner arc `θ ri`.
- Brackets: `nb = ceil(θ ro / sMax) + 1` radial cantilevers (role `bracket`) welded to clips on the shell at
  `OD / 2`. Grating segments lie between consecutive brackets. Each segment is a polygon (inner and outer arcs
  discretised at ≤ 5° chord deviation) with the bearing bars along the segment's mid-radius tangent.
- The railing follows the outer arc and, where requested, the ends.
- Associativity: the assembly stores `equipmentId`. A vessel move or resize re-derives ri, ro and the brackets.

### 5.6 Pipe rack (VC-STA-09)

- Stations are `0 … length` every `bentSpacing` (or explicit). Grid lines are `<prefix>1…` along and `<prefix>A/B…`
  across.
- Each bent has 2 (or `baysAcross + 1`) columns to the top tier and tier beams at each tier with `startJoint` /
  `endJoint: 'rigid'`.
- Struts are pinned and run per tier along both column lines. Bracing is `add_grid_bracing` in the column-line planes
  for `bracingBays`.
- Counts: bents `= length / s + 1`, columns `2 × bents`, tier beams `bents × tiers`, struts `2 × bays × tiers`.

### 5.7 Access graph and reachability (VC-STA-11)

- **Nodes.** The walking surfaces:
  - the grade (the lowest level's elevation, unbounded when `gradeIsWalkable`);
  - slabs with role floor;
  - gratings and platform assemblies, each a polygon at its top z.
- **Edges.**
  - A ladder links the surface containing its base (± 50 mm in z, plan distance ≤ 600 mm) to its arrival surface.
  - A stair links its bottom and top surfaces.
  - Two surfaces that touch in plan with |Δz| ≤ 20 mm are merged.
- **Search.** BFS from grade gives the route for every reachable surface.
- **Target.** For each target, the candidate surfaces are those whose polygon, offset by `maxHorizontalReachMm`,
  contains the target's plan point and whose z is at or below the target's z. The highest candidate is chosen, and
  `height = z_target − z_surface`.
- **Findings.** `STA_OPERATING_HEIGHT` when the height is outside `[min, max]`. `STA_REACH` when no surface is in reach.
  `STA_ACCESS_NO_EGRESS` when the surface is not connected to grade.
- **Complexity.** O(S log S + T log S) with an R-tree on the surface boxes.

### 5.8 Open edges

For every walking-surface boundary segment, the drop is the distance to the next surface below (ray at mid-edge and ends,
outward 100 mm). When the drop exceeds `edgeDropThresholdMm` and no railing, wall or adjacent surface covers the
segment (coverage ≥ 99 % of its length), the check reports `STA_EDGE_UNPROTECTED`. The threshold has no grade-A source,
so it must be given; without it the edge check is skipped with the warning `STA_EDGE_RULE_UNSET` (AF-31).

### 5.9 Fireproofing (V1, VC-STA-10)

- Boxed: area `= 2 (h + b) · L`, volume `= ((h + 2t)(b + 2t) − h b) · L`.
- Contour: area `= paint perimeter · L` (catalogue `perimeter`), volume `≈ perimeter · t · L`.
- L is the member length inside the zone. For a zone `{ equipmentIds, radius, height }` (explicit, with `source`),
  members are clipped to the union of vertical cylinders of that radius around each equipment footprint, from grade
  to `height`.

### 5.10 Rule evaluation and severities

`finding.severity = rule.grade === 'A' ? 'fail' : 'warn'` for limit breaches. B rules also add `STA_RULE_UNVERIFIED` with
the rule id, and C rows are never evaluated. A rule with `maxSeverity: 'warn'` (OSHA top rail above 45 in) is capped at
warn. Every finding carries `{ code, ruleId, ruleset, clause, severity, ids, measured: { value, unit }, limit: { min?,
max?, unit }, remediation, source }`. Comparisons use the original-unit limit converted exactly (`1 in = 25.4 mm`), with
a tolerance of 1e-6 mm.

## 6. Interop and persistence

- **Persistence:** new elements are plain JSON in `building.elements`. `validate.ts` gains per-category validators
  (finite numbers, profile known, rulesets known). Derived entities are regenerated on load (`derivedEntityIds`).
- **IFC 4 / 4.3** (`ifcAccessExport.ts`):

  | llull element | IFC entity | Predefined type / notes |
  | ------------- | ---------- | ----------------------- |
  | ladder | `IfcStair` | `.LADDER.`, aggregating `IfcMember` `.STRINGER.` stiles and `.MEMBER.` rungs (ObjectType RUNG) |
  | railing | `IfcRailing` | `.GUARDRAIL.` (platform) / `.HANDRAIL.` (stair side), posts `IfcMember` `.POST.` |
  | grating | `IfcPlate` | `.USERDEFINED.`, ObjectType GRATING, plus `Pset` with type, bearing-bar angle and kg/m² |
  | stair landing | `IfcSlab` | `.LANDING.` |
  | steel stair | `IfcStair` | type by layout, with `IfcStairFlight` `.STRAIGHT.` and stringers `IfcMember` `.STRINGER.` |
  | rack strut | `IfcMember` | `.STRUT.` |
  | platform / rack | `IfcElementAssembly` | aggregates its parts |

  All enum strings are present in `validation/data/ifc4x3_enums/*.md` [S23]. IFC 4.3 process export is shared with
  08 DAT.
- **DXF / sheets:** plan symbols are a ladder (rectangle + rungs), a stair arrow with "UP n R", a grating hatch with the
  bearing-bar direction, and the railing as a line with post ticks. Elevations cut stairs and ladders like members.
  Details (ladder elevation with cage) come in V1.
- **Hand-off:** SDNF / CIS/2 export of access steel (V2), coordinated with 08 DAT.

## 7. CLI / MCP / UI surfaces and stable codes

- CLI and MCP get the same commands (AF-01). `llull guide plant_structures` gives the minimal plan, units and the
  rule-grade policy (AF-03). `--dry-run` works on every generator (AF-42).
- UI: the tool-picker group **Industrial / access** with forms derived from the schemas, a findings list in the review
  panel, and highlighting of the offending ids. Accepting open fall-protection findings is a human gate (AF-34).

| Code | Kind | Meaning | Remediation |
| ---- | ---- | ------- | ----------- |
| `STA_GRATING_TYPE_UNKNOWN` | refusal | grating type not in the catalogue | `list_grating_types` |
| `STA_NO_SUPPORT_FOUND` | refusal | no member under a grating edge / no steel for a bracket | add beams (`add_grid_beams`) or pass `supportedBy` ids |
| `STA_INVALID_GEOMETRY` | refusal | self-intersecting / degenerate polygon or path | fix the boundary / path |
| `STA_EQUIPMENT_NOT_VESSEL` | refusal | `add_circular_platform` on a non-vertical-vessel equipment | use `add_platform` |
| `STA_OUTSIDE_SHELL` | refusal | platform elevation outside the vessel height | change `elevation` |
| `STA_NO_ARRIVAL_SURFACE` | refusal | ladder / stair top reaches no walking surface | give `climbHeight` to an existing surface or `attachTo` |
| `STA_LADDER_PITCH_INFEASIBLE` | refusal | no uniform pitch satisfies every active ruleset for this H | change H, add a landing, or drop a ruleset |
| `STA_RACK_SPACING`, `STA_RACK_TIERS` | refusal | invalid bent spacing / tier order | fix params |
| `STA_PLATFORM_OVERLAP` | refusal | two platforms overlap at the same elevation | merge or move |
| `STA_FIREPROOF_ZONE_UNDEFINED` | refusal | fireproofing zone without explicit radius / height / source | give the project envelope |
| `STA_LADDER_PITCH_OUT_OF_RANGE` | finding | pitch outside a ruleset's range | `update_ladder { rungPitch }` |
| `STA_LADDER_WIDTH` | finding | clear width below the minimum | increase `clearWidth` |
| `STA_LADDER_BACK_CLEARANCE` | finding | object behind the rungs too close | move the ladder or the object |
| `STA_LADDER_RAIL_EXTENSION` | finding | stiles / grab bars not high enough above the arrival | increase `railExtension` |
| `STA_LADDER_FALL_PROTECTION_MISSING` | finding | height requires a cage / LSS and none is set | set `fallProtection` |
| `STA_LADDER_CAGE_NOT_PRIMARY` | finding | OSHA: cage alone on a ladder > 24 ft installed from 2018-11-19 | `ladder_safety_system` or `pfas` |
| `STA_LADDER_CAGE_RETROFIT` | finding (warn) | existing caged ladder > 24 ft; retrofit date 2036-11-18 (proposed repeal) | plan the retrofit; reviewer decides |
| `STA_LADDER_CAGE_START` | finding | first hoop outside the allowed band | `cage.startHeight` |
| `STA_LADDER_LANDING_INTERVAL` | finding | caged section or LSS climb longer than the allowed interval | add landings |
| `STA_STAIR_BLONDEL` | finding | 2h + g outside 600–660 mm | change `riserMax` / `going` |
| `STA_STAIR_RISER`, `STA_STAIR_TREAD`, `STA_STAIR_ANGLE`, `STA_STAIR_WIDTH` | finding | OSHA 1910.25(c) limits | change the param named in the finding |
| `STA_STAIR_HEADROOM`, `STA_STAIR_FLIGHT_RISE`, `STA_STAIR_NONUNIFORM` | finding | headroom, flight rise, unequal risers | add an opening / landing; regenerate |
| `STA_RAIL_HEIGHT_LOW`, `STA_RAIL_HEIGHT_HIGH` | finding | top rail below / above the range (high: warn only) | `update_railing { height }` |
| `STA_RAIL_GAP` | finding | clear space between rails above the limit | add knee rails |
| `STA_TOE_PLATE_MISSING` | finding | toe plate absent or too low | `toePlate` |
| `STA_EDGE_UNPROTECTED` | finding | open edge with a drop above the threshold | `add_railing { hostId, edges }` |
| `STA_EDGE_RULE_UNSET` | finding (warn) | edge check skipped: no threshold given | pass `edgeDropThresholdMm` with its source |
| `STA_PLATFORM_WIDTH`, `STA_PLATFORM_HEADROOM` | finding | walkway narrower than 600 mm / headroom below 2100 mm | widen / raise |
| `STA_GRATING_OVERSTRESS`, `STA_GRATING_DEFLECTION` | finding | demand above the allowable / deflection above the limit | deeper bars, extra beam, other type |
| `STA_GRATING_SPAN_DIRECTION` | finding | bearing bars parallel to the supports | rotate `bearingBarDirection` |
| `STA_OPERATING_HEIGHT`, `STA_REACH`, `STA_ACCESS_NO_EGRESS` | finding | reachability failures | add a platform / ladder / stair or move the target |
| `STA_RULE_UNVERIFIED` | finding (warn) | a grade-B rule was used | reviewer confirms against the standard |
| `STA_RULESET_UNKNOWN` | refusal | ruleset name not loaded | `list_access_rules` |
| `STA_UNKNOWN_ELEMENT` | refusal | an id is not a building element of the right kind (added in M1) | pass ids of the kinds the command takes |
| `STA_RAIL_OPENING` | refusal | a railing gap is outside the path, out of order, overlapping, or removes the whole railing (added in M3) | give `{ from, to, gate }` ascending inside 0..path length |
| `STA_GRATING_TYPE_UNVERIFIED` | finding (warn) | a grating type whose mass is not checked against a manufacturer table (added in M2) | a reviewer confirms mass and load tables with the manufacturer |

## 8. Performance and robustness budgets

| Operation | Budget (desktop, 2026 laptop) |
| --------- | ----------------------------- |
| `add_circular_platform` 360°, 24 brackets | < 30 ms |
| `add_pipe_rack` 300 m, 51 bents, 4 tiers (≈ 1 000 members) | < 300 ms; one feature step |
| `check_access` on 2 000 access elements + 500 surfaces | < 2 s, memory < 200 MB |
| `check_reachability` 5 000 targets, 1 000 surfaces | < 1 s (R-tree) |
| Evaluation: a railing of 100 m | ≤ 2 000 triangles per metre at default LOD; posts instanced (09 VIS) |

Robustness:

- Every generator validates geometry before building. NaN or Infinity is refused by the guard (`CMD_CORRUPT_RESULT`).
- Arcs are discretised to a chord tolerance of ≤ 1 mm or 5°.
- Results are deterministic: sorted ids, no `Date.now()`. `installedOn` defaults to the document's project date when
  absent, and the result names that default (AF-31).

## 9. Test strategy

| Layer | Tests | VCs |
| ----- | ----- | --- |
| Unit (`tests/unit/plantStructures/`) | ladder / stair / railing / grating / circular-platform / rack layouts against `expected_results.json`; rule table: every A row has a passing and a failing case; B rows only warn; C rows not loaded; `is pure` for every mutating command; failure cases per refusal code | VC-STA-01..10, 13 |
| Reachability | graph build, BFS route, no-egress variant | VC-STA-11 |
| IFC | export string contains the entity + predefined type, all present in `validation/data/ifc4x3_enums` | VC-STA-12 |
| Contract | `toToolSchemas()` snapshot gains the new tools; `describe` shows units for every numeric param (VC-AF-01) | VC-STA-13 |
| Golden | plan `plant_access_structures` (vessel + circular platform + ladder + stair + rack) id-normalised snapshot and replay equality | VC-STA-14 |
| Scenario | `scenarioPlans.test.ts` runs `validation/plans/*.json` through `build_project` and compares the `expected` rows | all |
| Server / CLI | `npm --prefix server test`: `llull run sc-sta-05… --json` exits 1 with the codes listed | VC-STA-13 |
| Production gate | extend `desmet-extraction-building` (docs/PRODUCTION_GATE.md) with steel stairs, gratings with span check and railings | — |

Coverage gate 90 / 85 / 90 / 90 applies (`packages/domain-aec/src/**`).

## 10. Delivery plan

| Milestone | Content | Depends on | Effort (engineer-weeks) |
| --------- | ------- | ---------- | ----------------------- |
| M1 | Plugin skeleton, codes, rule tables from `access_rules.json`, `list_access_rules`, `check_access` on the existing `stair` (concrete) and slabs (edges) | — | 1.0 |
| M2 | Catalogue families FL / RD, grating types, `add_grating`, `check_grating`, takeoff lines. **Built 2026-10-25** (§13.4) | M1 | 1.5 |
| M3 | `add_railing` (paths, host edges, openings, gates), evaluation, IFC railing, edge coverage in `check_access`. **Built 2026-10-25** (§13.5) | M1 | 1.5 |
| M4 | `add_ladder` (cage, LSS, landings, exits, back clearance), IFC ladder | M3 | 1.5 |
| M5 | `add_steel_stair` (stringers, treads, landings, railings) | M2, M3 | 1.5 |
| M6 | `add_platform`, `add_circular_platform`, assemblies + derivation guard, `update_platform`, `platform_takeoff` | M2, M3 | 2.0 |
| M7 | `add_pipe_rack`, `update_pipe_rack`, `check_steel_members` integration | M6 | 1.5 |
| M8 | Access graph, `check_reachability`, plan symbols, schedules, golden plan, scenario runner | M4–M6 | 1.5 |
| **MVP total** | | | **≈ 12** |
| V1 | Fireproofing; equipment support structures; platform loads into `check_steel_members`; targets from 02 RTE / 08 DAT; project rulesets; associativity to 03 EQP vessels; ladder / stair details on sheets | 02, 03, 08 | ≈ 8 |
| V2 | API 650 spiral stairs; automatic access proposals; grating cut plans; SDNF / CIS/2 | 03, 08 | ≈ 6 |

Dependencies on sibling gaps:

- 03-parametric-equipment: vessel OD, height and manway / nozzle positions for platform elevation.
- 02-spec-driven-routing: valve handwheel points.
- 08-plant-data-reports-interop: tags, IFC 4.3.
- 09-plant-visualization-review: instancing of posts and rungs.
- 07-pipe-stress-flexibility: none.

## 11. Open questions

1. Buy and read ISO 14122-1..4:2016 (and the revision of part 2 in development) to promote the B rows (hoop spacing,
   flight height, toe-plate gap, post spacing, headroom) to A, and to encode ISO 14122-1 access-type selection by
   angle. Until then these only warn.
2. OSHA 2036 retrofit date: the 2026 proposed repeal may become final. The rule-table version must change when it
   does, and the owner must decide who maintains the table.
3. Grating: is a metric grating catalogue (RAL-GZ 638 / EN-based manufacturers) needed in the MVP for EU projects?
   It needs two manufacturer tables to cross-check. **Decided 2026-10-25 (owner delegated, M2): not in the MVP.** A catalogue row without a cross-checked table would be a guess, and the NAAMM rows already serve the pack's validation; `list_grating_types.standard` keeps one value (`naamm_mbg_531`) and widens when two metric manufacturer tables are in `validation/sources.md`.
4. Should the steel stair reuse `StairElement` (one stair category, a `construction` discriminant) or stay a separate
   `steelStair` category? This spec proposes separate, because plant stairs connect arbitrary elevations and the
   concrete stair is level-bound.
5. Fireproofing envelope: a project-wide default zone (API 2218 practice) or per-equipment zones only? Either way it
   must be explicit with a source.
6. Edge-protection trigger: there is no grade-A extract for the drop height (ISO 14122-3 / OSHA 1910.28(b)(1)). The
   threshold stays a required input until it is read.
7. Do ladder / stair element ids follow the existing building mark scheme (`LD1`, `SS1`), or plant tag conventions
   from 08 DAT?

## 12. References

Full list with grades in [validation/sources.md](validation/sources.md). All accessed 2026-10.

- [R1] 29 CFR 1910.23 Ladders — OSHA — https://www.osha.gov/laws-regs/regulations/standardnumber/1910/1910.23
- [R2] 29 CFR 1910.25 Stairways — eCFR — https://www.ecfr.gov/current/title-29/subtitle-B/chapter-XVII/part-1910/subpart-D/section-1910.25
- [R3] 29 CFR 1910.28 / 1910.29 — OSHA — https://www.osha.gov/laws-regs/regulations/standardnumber/1910/1910.29
- [R4] OSHA standard interpretations on fixed ladders, 2021-09-28 and 2021-09-10 — https://www.osha.gov/laws-regs/standardinterpretations/2021-09-28
- [R5] ISO 14122-2:2016, ISO 14122-3:2016, ISO 14122-4:2016 — ISO catalogue — https://www.iso.org/standard/61282.html , https://www.iso.org/standard/61283.html
- [R6] ANSI/NAAMM MBG 531 / MBG 534 — NAAMM — https://www.naamm.org/division/publications/8
- [R7] Grating Pacific 19-space steel load table; Marco Specialty Steel 19-W-4 table (URLs in sources.md S20, S21)
- [R8] buildingSMART IFC 4.3 — https://github.com/buildingSMART/IFC4.3.x-development
- [R9] IfcOpenShell / Bonsai v0.8.0 railing and stair modules — https://github.com/IfcOpenShell/IfcOpenShell
- [R10] CADMATIC circular platform structural unit — https://docs.cadmatic.com/plant/
- [R11] AVEVA E3D Design, Stairs Ladders and Handrails — https://docs.aveva.com/bundle/e3d-design/page/1041135.html
- [R12] API RP 2218 (catalogue); UL 1709 (UL code-authorities page)
- [R13] AISC Engineering Journal, pipe-rack design article — https://ej.aisc.org/index.php/engj/article/download/991/990
- [R14] Roark's Formulas for Stress and Strain (simply supported beam cases) — closed forms used in §5.4

## 13. As built (M1 2026-10-23, M2 and M3 2026-10-25)

Built: M1 (plugin skeleton, codes, rule table, `list_access_rules`, `check_access` on the concrete `stair` and on slab edges), M2 (§13.4: FL / RD bars, grating catalogue, `add_grating`, `update_grating`, `check_grating`, takeoff) and M3 (§13.5: `add_railing`, `update_railing`, evaluation, IFC for railings and gratings, railing rules and edge coverage in `check_access`). Not built:
ladder, steel stair, platforms, pipe rack, reachability, fireproofing, plan symbols; M4..M8 stay open.

### 13.1 What exists

| Part | Where | Notes |
| ---- | ----- | ----- |
| Plugin `plantStructures`, toolset `plant_structures` | `packages/domain-aec/src/plant/structures/{plugin,catalog}.ts`, installed in `src/app/plugins.ts`, exported by `@aec/index` | D2 layout (`plant/structures/`, not `plantStructures/`). No document slice and no change to `plant/types.ts` or to core: M1 reads the building model only. `TOOLSET_NAMES` gains `plant_structures` (`@protocol/toolsets`) |
| Rule table | `rules/accessRules.json` (copy of `validation/data/access_rules.json`, 38 rows) and `rules/ruleTable.ts` | A test asserts the copy equals the pack file. `RULE_TABLE_VERSION` `2026-10-18`. Grade A and B rows are loaded (`LOADED_RULES`), the 2 grade C rows are listed but never evaluated. Limits are read by row id; `breach()` uses a 1e-6 tolerance. `OSHA-LAD-FALLPROT-HEIGHT` carries a `flag` (2036 retrofit date under proposed repeal, status unknown; plant README D10) in every listing |
| Codes | `codes.ts` | Only the codes M1 emits, each with its one-line remediation: `STA_STAIR_{BLONDEL,RISER,TREAD,ANGLE,WIDTH,FLIGHT_RISE}`, `STA_EDGE_UNPROTECTED`, `STA_EDGE_RULE_UNSET`, `STA_RULE_UNVERIFIED`, `STA_RULESET_UNKNOWN`, plus `STA_UNKNOWN_ELEMENT` (new, not in §7). Add the rest with their milestone |
| `list_access_rules` | `access/listAccessRules.ts` | `{ ruleset?, grade? }`; default A and B rows; `grade: 'C'` lists the unloaded rows; `STA_RULESET_UNKNOWN` for another ruleset name |
| `check_access` | `access/checkAccess.ts`, `stairChecks.ts`, `edgeChecks.ts`, `finding.ts` | Read-only. `{ rulesets (required), ids?, include?: ('stairs'\|'edges')[], edgeDropThresholdMm?, edgeDropSource? }`. Data: `verdict`, `findings[]`, `byId`, `edges[]`, `checked`, `skipped`, `ruleTableVersion`, `reviewRequired: true`, `unverifiedRulesUsed`, `notEvaluated` |

### 13.2 Decisions

- **Rulesets are an enum in `check_access`**: an unknown name is `CMD_INVALID_PARAMS` (VC-STA-13), not `STA_RULESET_UNKNOWN`. That code is used by `list_access_rules`, whose `ruleset` is a free string. V1 project rulesets will widen the enum.
- **Stairs**: measures come from `riserHeight`, `treadDepth`, `width` of `StairElement` (document units to mm). Flight rise = the longest flight (`landingAt` splits the risers). Evaluated: ISO Blondel, width, flight rise (B); OSHA riser, tread, angle, width. Not evaluated, reported in `notEvaluated`: `ISO-STR-HEADROOM`, `OSHA-STR-LANDING`, `OSHA-STR-UNIFORM`.
- **B rules**: a breach is severity `warn` and adds one `STA_RULE_UNVERIFIED` per rule listing every element concerned. `unverifiedRulesUsed` lists the B rows consulted, breached or not.
- **Slab edges** (§5.8): the threshold is required (`STA_EDGE_RULE_UNSET` warn otherwise, edges skipped). Edges of the boundary and of the openings are tested; the drop is the largest of three samples (both ends and mid-edge, 100 mm outward; into the opening for opening edges) from the slab top to the highest other slab top at or below it, else the lowest level elevation. A surface within 1 mm of the slab top counts as a continuation. A drop above the threshold is protected only when walls of the slab level, whose top is at least `ISO-GRD-TOP` (1100 mm, grade A) above the slab top and whose centreline lies on the edge, cover at least 99 % of its length. Railings do not exist before M3; M3 must add them to this coverage test. The finding is `PROJECT-EDGE-DROP` (ruleset `project`, severity `fail`, clause = `edgeDropSource`). Opening edges around a stair well are reported like any other (no stair-footprint protection yet).

### 13.3 Validation cases

| VC | State |
| -- | ----- |
| VC-STA-04 rule part (3 stair cases) | passing, `tests/unit/plant/structures/checkAccess.test.ts` |
| VC-STA-13 (fields, B warn + unverified, `reviewRequired`, invalid ruleset) | passing for stairs, edges, railings and gratings; ladder codes follow M4 |
| VC-STA-02, 03 (rule rows) | the row limits and the 24 ft boundary are tested at the table level (`accessRules.test.ts`: every limit row passes at its limits and breaches just outside); the element checks need M4 |
| VC-STA-05 | passing (M3): post counts 4 / 5 for 4000 / 6000 mm, the five height / knee-rail / toe-plate rows under both rulesets, `railing.test.ts`, `scenarioPlans.test.ts` (SC-STA-05 railing and edge rows) |
| VC-STA-06 | passing (M2): closed form against the published 19-W-4 table at every span of the pack, pedestrian span, 0.5176 mm; SC-STA-06 meets all five rows, `grating.test.ts`, `scenarioPlans.test.ts` |
| VC-STA-12 | railing, grating and the FL / RD profile definitions passing (`ifcAccess.test.ts`, every enum string read from `data/ifc4x3_enums`); ladder, stair, landing and rack strut follow M4..M7 |
| VC-STA-01, 07..11, 14 | not started |

### 13.4 M2 as built (2026-10-25): catalogue families FL / RD, gratings, takeoff

| Part | Where | Notes |
| ---- | ----- | ----- |
| Steel families `FL` (flat bar `FL<width>x<thickness>`, 12 rows 30x5 .. 150x10) and `RD` (solid round bar `RD<diameter>`, 7 rows 10 .. 40) | `steel/profiles.ts` (`ProfileShape` gains `FL`, `RD`; outline = full rectangle / 20-gon disc), `steelProfileList.ts`, `exchange/ifcIndustrialExport.ts` (IfcRectangleProfileDef / IfcCircleProfileDef), `industrial/fabrication/ncMemberPieces.ts` (DSTV codes `B`, `RU`) | Same catalogue, no parallel path: both are ordinary `add_steel_member` profiles, so steel takeoff, schedules, NC1 and IFC treat them like any section. |
| Grating catalogue | `grating/gratingTypes.ts`, `imperial.ts` | 7 NAAMM-basis rows: 19-W-4 at 1, 1-1/4, 1-1/2, 1-3/4, 2 in deep and 15-W-4 at 1-1/4, 1-1/2 in, all 3/16 in plain bars, 4 in cross bars. F = 18 000 psi and E = 29 000 ksi converted exactly (0.006894757293168 MPa/psi). Only `19-W-4 1-1/4x3/16` is `verified` (8.9 psf = 43.4536 kg/m², two manufacturers, S20 + S21); the other rows have a computed mass (bars + cross-bar share calibrated on the verified row, x1.1042) and say so in `massSource`. |
| Closed forms | `grating/gratingSpan.ts` | U = 8FS/L², C = 4FS/L, 5wL⁴/384EI, CL³/48EI per metre of width (§5.4), checked against `data/grating_19w4_load_table.json` at every span of the pack. |
| Element | `building/types.ts` `GratingElement` (category `grating`, mark `GR<n>`, layer `S-GRAT`), `evaluate/evaluateGrating.ts`, `validateAccess.ts` | One element per support bay (a prism of the convex panel polygon, bar depth deep, top at level + `topOffset`). Persisted as plain JSON, entities re-derived on load. |
| `list_grating_types`, `add_grating`, `update_grating`, `check_grating` | `grating/*.ts`, registered in `catalog.ts` | See below. |
| Takeoff / schedule | `quantities/accessTakeoff.ts`, hooked in `takeoffCompute.ts`, `scheduleBuild.ts` | `quantity_takeoff` lines `grating.<type>.m2`, `.kg`, `.ea`; `building_schedule` kind `grating`. |

Decisions (owner delegated, 2026-10-25):

- **Supports (§5.4)**: a support is a horizontal steel member (axis within 1° of horizontal) whose axis is perpendicular to the bars within 5°, whose top of steel is 0..10 mm below the grating underside (1 mm above is tolerated as model rounding; deeper bars that bury the beam top are a finding, not a silent pass), and whose axis overlaps the region across the bars. Members whose axes are within 5 mm along the bars are one support line and carry the edge together: their extents across the bars must cover the width of every panel they bound (10 mm), otherwise the command is refused with `STA_NO_SUPPORT_FOUND` naming the unsupported stretch (a beam covering a third of the width does not support the panel). The element stores every member of each side (`supportIds: [string[], string[]]`), and `check_grating` re-checks all of them: a deleted, turned or shortened member is a finding. The first and last support line must lie under the end edges (10 mm). `supportedBy: "beams"` means the members of role `beam`; named ids must all qualify or the command is refused (`STA_NO_SUPPORT_FOUND` lists them).
- **Regions are convex** (all turns the same way and the turning angles add up to one revolution, so a pentagram is refused too). A concave region is refused (`STA_INVALID_GEOMETRY`: split it into rectangles). Half-plane clipping of a convex polygon at the support lines is exact; a concave one can split into disconnected pieces. Openings in a grating (equipment cut-outs) wait for M6 with `add_equipment_openings`; the element has no `openings` field until then.
- **`thickness` is not a free input.** The catalogue decides the depth; a given value must equal the bar depth or the command is refused.
- **`check_grating` demand includes the self weight, reported apart.** `deflectionMm` is the deflection under the applied load alone (the VC-STA-06 row: 0.5176 mm at 914.4 mm and 4.788 kPa); `totalDeflectionMm`, `stressUtilisation`, `deflectionUtilisation` and the findings use applied + self weight. This refines §5.4's "adds it to the demand" so the reference row stays comparable. The concentrated case is checked alone with the self weight through M/Mcap = P/C + w/U (exact for simply supported spans). The span is re-measured from the members now in the model (centre to centre; `spanBasis: "clear"` subtracts the half top-flange widths), so an edit of a beam shows up as `STA_NO_SUPPORT_FOUND` or `STA_GRATING_SPAN_DIRECTION` findings. A clear span of zero or less (flanges wider than the gap) is a `STA_INVALID_GEOMETRY` finding, not a set of allowables. No default load or limit (AF-31): exactly one of `deflectionLimitMm` / `deflectionRatio`, else a no-op.
- **Findings** reuse the `check_access` finding shape. Strength and bearing findings are grade A (`naamm_mbg_531`), the deflection limit is the caller's (`ruleset: project`), `STA_GRATING_TYPE_UNVERIFIED` is a grade B warn. `reviewRequired` is always true.
- **Not extended in M2** (no consumer yet): `check_clashes` (a grating on its beams clashes with nothing and the new categories have no clash box; M6 / M8), `check_steel_members` floor load from grating kg/m² (V1), plan symbols and DXF hatch (M8), `add_equipment_openings` cutting gratings (M6). Serrated bars are not in the catalogue.

### 13.5 M3 as built (2026-10-25): railings

| Part | Where | Notes |
| ---- | ----- | ----- |
| Element | `building/types.ts` `RailingElement` (category `railing`, mark `RL<n>`, layer `S-RAIL`), `railing/railingLayout.ts`, `evaluate/evaluateRailing.ts` | Posts, top rail, each knee-rail level, toe plate and gates are merged meshes (one entity per part: `<id>:posts`, `:top-rail`, `:knee-rail-<n>`, `:toe-plate`, `:gates`), so a 100 m railing is 5 entities, not 300. |
| `add_railing`, `update_railing` | `railing/addRailing.ts`, `updateRailing.ts`, `railingValidate.ts`, `railingPath.ts`, `railingDefaults.ts`, `railingMeasure.ts` | Path or host (`hostId` of a slab or grating, `edges` "all" or indices, `opening` = slab opening index); gaps with optional gates. |
| Rules | `access/railingChecks.ts`, `edgeChecks.ts` | Guard-rail height (ISO-GRD-TOP, OSHA-GRD-TOP), clear space (ISO-GRD-GAP, OSHA-GRD-MID), toe plate (ISO-TOE-HEIGHT, OSHA-TOE-HEIGHT). |
| IFC | `exchange/ifcAccessExport.ts`, dispatched from `ifcBuild.ts` | `IfcRailing` `.GUARDRAIL.` / `.HANDRAIL.` carrying the rails, toe plate and gate leaves, aggregating one `IfcMember` `.POST.` per post; gratings as `IfcPlate` `.USERDEFINED.` with ObjectType `GRATING` and `Pset_llullGrating`. |
| Takeoff / schedule | `quantities/accessTakeoff.ts` | `railing.rail.m`, `railing.post.ea`, `railing.toe-plate.m`, `railing.gate.ea`, `railing.steel.kg`; `building_schedule` kind `railing`. |

Decisions (owner delegated, 2026-10-25):

- **Defaults come from the rule rows, never from literals, and are named in `data.defaults`.** With both rulesets (the default): height = the highest nominal-or-minimum top-rail row (ISO 1100 mm; OSHA nominal 1066.8), toe plate = the highest minimum (100 mm), knee rails = the fewest that keep the clear space within the smallest limit (ISO-GRD-GAP 500, OSHA-GRD-MID 482.6): one, giving 451.7 mm. `postSpacingMax` defaults to 1500 mm and says that ISO-GRD-POST-SPACING is grade C (a default, not a gate). Posts and rails default to `CHS48.3x3.2`. A `handrail` has no rule rows: its height is required, it gets no knee rails or toe plate unless asked, and `check_access` lists it under `notEvaluated`.
- **Clear space counts the top rail** (deviation from §5.3): gap = (height − toe − (k+1)·d) / (k+1) with d the rail depth, which is the space a person or object actually sees between two rails; §5.3 subtracted only k rails and was 24 mm optimistic. `check_access` compares it with both ISO-GRD-GAP (A) and OSHA-GRD-MID (B, so a warn plus `STA_RULE_UNVERIFIED`). Example: 1200 mm with one knee rail and a 100 mm toe plate is 501.7 mm and fails ISO; VC-STA-05's 1200 mm row needs two knee rails.
- **Severity of OSHA-GRD-TOP is per side.** `maxSeverity: warn` caps only the over-limit side (above 1143 mm, `STA_RAIL_HEIGHT_HIGH` warn); below 990.6 mm is `STA_RAIL_HEIGHT_LOW` fail. `severityOf(rule, side)` takes the breached side; without it the cap applies, as before.
- **Posts** at both ends, every path vertex and both ends of every gap, equal spacing ≤ `postSpacingMax` inside each interval (VC-STA-05: 4000 mm at 1500 → 4 posts at 1333.33; 6000 → 5). A closed path (all edges of a host) has no double post at the start. Path length is the 3D length, so a sloped path spaces its posts along the slope.
- **Hosted railings** store the generated path (a snapshot) and `host { hostId, ring, edges }`. They move with the host (`move_building_element` carries them; moving one alone is refused), are deleted with it, and keep their path when the host is edited: re-deriving from the host is FR-STA-14 (SHOULD), planned with the assemblies of M6. `edges` selects ring edges (edge i = point i → i + 1); one railing per run of consecutive edges (cyclic), one closed railing for "all".
- **Edge coverage (§5.8, completes the M1 note).** A railing protects a slab or grating edge when its role is `guardrail`, its top reaches the strictest top-rail minimum of the requested rulesets (1100 mm for `iso_14122`, 990.6 mm for `osha_1910`), its path stands within 50 mm of the surface top and within 150 mm of the edge line, over the guarded part of the path: gaps without a gate do not count, gates do (self-closing). Coverage still needs 99 % of the edge, summed with walls. The wall rule now uses the same height (it was always the ISO row; for an OSHA-only run a 990.6 mm wall now counts). A railing below the minimum does not protect: the edge is reported together with `STA_RAIL_HEIGHT_LOW`, and the remediation of both names `update_railing { height }`.
- **Gratings are walking surfaces for the edge check** (and lower surfaces for the drop), so a platform of panels is checked like a slab; edges shared by two panels are continuations. `EdgeReport.slabId` became `surfaceId`; `data.checked` gained `gratings` and `railings`; `include` gained `"railings"`.
- **Out of M3**: `role: handrail` is only a stored role until M5 (stair railings), railing posts as instanced geometry (09 VIS), `assemblyId` (M6), `check_clashes` for railings.
- **Outside the lane, one compile fix**: adding categories to `BimCategory` broke the exhaustive label table of the element list (`src/ui/panels/building/describeElement.ts`, 6 lines: `Grating`, `Railing` and their one-line descriptors). No UI behaviour was added; the viewport renders the evaluated mesh entities like any element.

Tests: 71 new (`tests/unit/plant/structures/{grating,railing,ifcAccess,scenarioPlans}.test.ts`, `tests/unit/building/barProfiles.test.ts`) plus the `check_access` expectations of M1 updated for `surfaceId` and the new `checked` fields.
- **Review fixes (M2 / M3)**: load validation of a railing runs the unit-free part of the add_railing validation (path points, integer 0..10 knee rails, non-negative toe plate, ascending gaps inside the path, known profiles); the fit of the rails needs the document unit and stays a command-time check. A guard-rail whose profile left the catalogue is a `STA_INVALID_GEOMETRY` fail finding in `check_access`. OSHA-GRD-MID is evaluated as the 19 in opening only and listed under `notEvaluated` for its position. The IFC grating property `BearingBarAngle` is in radians (the project plane-angle unit); a grating whose type left the catalogue is not exported. The refusal to move a hosted railing names its slab or grating host.
