# Gap 03 EQP — Parametric process equipment: technical specification

Companion of [FUNCTIONAL_SPEC.md](FUNCTIONAL_SPEC.md). Laws: `.claude/rules/architecture.md` (L1–L10). Agent-first
requirements: [`../../aerospace/AGENT_FIRST.md`](../../aerospace/AGENT_FIRST.md). Validation:
[validation/README.md](validation/README.md). Status 2026-10-18: specification only, nothing built.

## 1. Current state in llull (before this gap)

| What | Where | Limits for plant use |
| ---- | ----- | -------------------- |
| `EquipmentElement` (`category: 'equipment'`): `name`, `location: Vec2`, `angle` (rad), `size: Vec3` (bounding box), `shape?: 'box' \| 'vertical_vessel' \| 'horizontal_vessel'`, `clearance`, `weight` (operating kg, typed) | `packages/core/src/model/building.ts` (`EquipmentShape` l.231, `EquipmentElement` l.234–248) | no heads, supports, nozzles, design data, provenance; vessels are plain cylinders inscribed in the box |
| `add_equipment`, `add_pipe_run` | `packages/domain-aec/src/industrial/equipment/equipment.ts` | equipment = footprint + height; pipe `from` / `to` are tag strings only (line list), no geometric connection |
| `update_equipment` (keeps element id / GlobalId) | `industrial/equipment/equipmentUpdate.ts` | edits the box, not parameters |
| `add_equipment_openings` (cut floors around equipment) | `industrial/equipment/equipmentOpenings.ts` | reusable as is (bounding box) |
| shapes and size normalisation | `industrial/equipment/equipmentShape.ts` | three shapes, hard-coded `switch` |
| 3D evaluation: oriented box or 40-segment prism mesh on layer `Q-EQPM` | `industrial/evaluate.ts` (`evaluateEquipment`, `VESSEL_SEGMENTS = 40`) | `mesh` entities: no exact geometry for STEP / OCC |
| clash boxes, clearance-zone violations | `industrial/clash/clashBoxes.ts` (case `equipment`), `clash/clash.ts` (`check_clashes`) | bounding box only; a pipe end "inside equipment" is treated as a nozzle (docs/INDUSTRIAL.md) |
| floor loads from `weight` over the footprint | `industrial/steelDesign/steelAreaLoads.ts` | weight is typed, not computed |
| IFC: `IfcBuildingElementProxy` + `Pset_llullEquipment`; vessel body = extruded `IfcCircleProfileDef` | `building/exchange/ifcIndustrialExport.ts`, `building/exchange/ifcVesselExport.ts` | no ports, no typed equipment entity |
| plan drawing of equipment + clearance | `building/drawings/planIndustrial.ts` | — |
| DN → outside diameter table (DN15–400, EN 10220 / ASME B36.10) | `industrial/piping/pipeSizes.ts` | enough for nozzle necks until 01 PSC |
| steel density 7850 kg/m³ | `domain-aec/src/steel/profiles.ts` (`STEEL_DENSITY_KG_PER_M3`) | reused as a named default |
| core solid kind `revolution` (profile + exact `curves`: line / 3-point arc / cubic Bézier), Pappus volume | `packages/core/src/model/types.ts` l.190, `core/src/geometry/closedFormVolume.ts` | no ellipse segment: a 2:1 head profile is a Bézier / polyline approximation |
| material library with allowables (`get_material_allowable`, bases A/B/S) | `packages/core/src/commands/materials/` | aerospace bases; no ASME II-D table (paywalled) |
| recipes (`save_recipe`, `instantiate_recipe`) | `packages/core/src/commands/parametric/` | can carry an equipment plan as a reusable template (FR-EQP-19) |

`grep -ri "UG-27\|ellipsoidal\|torispherical\|nozzle port\|TEMA\|API 650"` over `packages/` finds nothing: heads,
nozzles, ports, vessel codes, tank codes, exchanger and pump templates are all missing. `domain-aero/src/fluids` is gas
dynamics (rocket nozzles), unrelated.

## 2. Target architecture

- **Plugin** `plantEquipment` (`CadPlugin { name: 'plant-equipment', toolset: 'plant', commands, guards }`) in
  `packages/domain-aec/src/plant/equipment/`. Rationale: equipment already lives in the building model and its
  consumers (clash, floor loads, schedules, IFC, plan drawings) are in `domain-aec`; the plant gaps 01 PSC / 02 RTE /
  06 STA / 08 DAT are planned in the same package under `src/plant/`. Installed by `src/app/plugins.ts`
  (`installDefaultPlugins()`); toolset `plant` added to `packages/mcp/src/toolsets.ts` through `pluginToolNames('plant')`
  (shared with 01/02).
- **Elements stay `category: 'equipment'`** in `BuildingModel` (see §3), so every existing consumer keeps working on
  the bounding box while new consumers read the template data. `add_equipment` stays as the "generic box" template.
- **Pure commands** (L1, L3): mutating commands return a new document via the building helpers
  (`withElement`, `commitBuilding`); queries return `data` and never change the document.
- **Geometry**: evaluation emits `revolution` entities (shells, heads, skirts, nozzle necks, flanges), `box` /
  `extrusion` entities (saddles, legs, baseplates, pump bodies), all tagged `element:<id>` and protected by the existing
  building derivation guard (L8: derived geometry is read-only and re-derived on load). No kernel is needed to create
  equipment (L9); the OCC kernel turns the exact profiles into B-rep for STEP. Nozzle openings cut into shells
  (`cutOpenings: true`, V1) use `ctx.kernel` booleans and declare `requiresKernel`.
- **Engineering maths** (head geometry, volumes, weights, ASME, API 650, TEMA parsing, pump envelopes) is pure
  TypeScript in the plugin; tables are JSON data modules with `source` and `grade` per row (AF-30).
- **Ports** are computed, not stored: a pure function `equipmentPorts(building, element)` gives world-space ports.
  02 RTE consumes them through a shared `ConnectionPort` type (§3) so routing never imports equipment internals.
- Laws: no React / DOM / fetch in the plugin (L2); `packages/core` gains only data types (§3), never plugin imports
  (L10); one command = one UI action + one MCP tool (L5).

```
packages/domain-aec/src/plant/equipment/
  plugin.ts, catalog.ts, codes.ts                   plugin, command list, EQP_* codes + remediation text
  model/templates.ts                               zod schemas of templates (vessel, column, exchanger, tank, pump)
  model/params.ts                                  shared param schemas: quantities with units, head, support, design
  geometry/heads.ts                                head depth / profile / volume / area (closed forms, §5.1)
  geometry/headOffset.ts                           constant-thickness head solid volume (§5.3)
  geometry/partialVolume.ts                        Jones vertical + horizontal partial volumes (§5.2)
  geometry/vesselProfile.ts                        revolve profiles of shell + heads + skirt
  geometry/ports.ts                                nozzle placement and port frames (§5.4)
  evaluate/evaluateVessel.ts, evaluateExchanger.ts, evaluateTank.ts, evaluatePump.ts, evaluateNozzle.ts
  codes/asmeDiv1.ts                                UG-27, UG-32, UG-99, limits, MAWP (§5.5)
  codes/api650.ts                                  one-foot method, tables lookup (§5.6)
  data/headStandards.ts, data/api650Tables.ts, data/pumpEnvelopes.ts, data/temaTables.ts   (rows + source + grade)
  commands/addVessel.ts, addColumn.ts, addHeatExchanger.ts, addStorageTank.ts, addPump.ts, nozzles.ts,
           updateEquipmentParameters.ts, vesselVolume.ts, equipmentWeights.ts, vesselThickness.ts,
           tankShellThickness.ts, equipmentPorts.ts, equipmentDatasheet.ts, checkEquipment.ts
```

### Technical requirements

| Id | Pri | Requirement | Proves FR | AF | VC |
| -- | --- | ----------- | --------- | -- | -- |
| TR-EQP-01 | MUST | Plugin `plant-equipment` registered by `installDefaultPlugins()`, toolset `plant` in `@mcp/toolsets`; every capability is a `defineCommand` with a zod `params` object (snake_case names) | all | AF-01, AF-02 | contract snapshot |
| TR-EQP-02 | MUST | `EquipmentElement.plant?: PlantEquipmentData` (types in `@core/model/plantEquipment`); legacy `size` / `shape` / `weight` re-derived inside the same command | FR-EQP-02, 16 | AF-13 | VC-EQP-13, 19 |
| TR-EQP-03 | MUST | Derived geometry = `revolution` (exact `curves`), `box`, `extrusion` entities tagged `element:<id>`, read-only under the building derivation guard, re-derived on load | FR-EQP-02..07 | — | VC-EQP-03, 13 |
| TR-EQP-04 | MUST | OCC builds exact B-rep from the profiles (volume within 1e-6 of the closed form); Manifold uses ≥ 64 segments per revolution | FR-EQP-02 | AF-41 | VC-EQP-03 |
| TR-EQP-05 | MUST | Volumes, areas and depths from closed forms / fixed quadratures, never from meshes | FR-EQP-01, 09 | AF-21 | VC-EQP-01..04 |
| TR-EQP-06 | MUST | Ports computed by a pure `equipmentPorts()`; shared `ConnectionPort` type; ids `<tag>:<mark>` stable across revisions | FR-EQP-08 | AF-14 | VC-EQP-12, 19 |
| TR-EQP-07 | MUST | `codes/asmeDiv1.ts`: UG-27 / UG-32 / UG-99 in the corroded condition, applicability limits, S and E never defaulted | FR-EQP-11 | AF-31, AF-33 | VC-EQP-05..07 |
| TR-EQP-08 | MUST | `codes/api650.ts`: one-foot method, graded Sd / St and minimum-thickness tables, 60 m limit | FR-EQP-12 | AF-30, AF-32 | VC-EQP-08, 17 |
| TR-EQP-09 | MUST | Weights from exact offset solids and annuli; every breakdown line names its method; defaults named | FR-EQP-10 | AF-31, AF-35 | VC-EQP-09 |
| TR-EQP-10 | MUST | `update_equipment_parameters` keeps element id, tag, nozzle marks, port ids; reports moved ports and connected pipes | FR-EQP-16 | AF-13 | VC-EQP-19 |
| TR-EQP-11 | MUST | Standard / catalogue tables are TS data modules with `source` and `grade` per row; grade < A ⇒ `unverified` | FR-EQP-15 | AF-30, AF-32 | VC-EQP-10, 16 |
| TR-EQP-12 | MUST | Every refusal returns `CommandResult.error` (`codedRejection`) with a code of §7, `ids`, `paths`, remediation | FR-EQP-17 | AF-11 | VC-EQP-07, 16 |
| TR-EQP-13 | MUST | Every code result carries `provenance` (formula, inputs, source) and `reviewRequired: true` with a reason; flags propagate into data sheets and checks | FR-EQP-11..14 | AF-32, AF-33, AF-35 | VC-EQP-16 |
| TR-EQP-14 | MUST | Deterministic output and the budgets of §8 | all | AF-12, AF-13, AF-40 | VC-EQP-16 |
| TR-EQP-15 | SHOULD | IFC export of revolved bodies and one `IfcDistributionPort` per nozzle | FR-EQP-18 | — | VC-EQP-20 |

## 3. Data model

New file `packages/core/src/model/plantEquipment.ts` (types only; core may hold domain data types, as
`building.ts` / `civil.ts` do). `EquipmentElement` gains one optional field; no document-version bump, no migration
(absent = legacy footprint equipment).

```ts
/** A physical quantity with its unit and provenance (AF-04, AF-31, AF-32). */
export interface Quantity<U extends string = string> {
  readonly value: number;
  readonly unit: U;
  readonly source?: string;          // 'user input', 'API 650 Table 5-2a A36M', …
  readonly defaulted?: boolean;      // named default, never silent
  readonly unverified?: boolean;     // grade < A, propagates
}
export type PressureUnit = 'MPa' | 'kPa' | 'bar' | 'psi';

export type HeadSpec =
  | { readonly type: 'ellipsoidal'; readonly ratio: number }                       // D / (2 depth); 2 = 2:1
  | { readonly type: 'torispherical'; readonly standard: 'asme_fd' | 'asme_80_10' | 'asme_80_6' | 'din_28011' | 'din_28013' }
  | { readonly type: 'torispherical'; readonly crownRadius: number; readonly knuckleRadius: number }
  | { readonly type: 'hemispherical' }
  | { readonly type: 'flat'; readonly thickness?: number }
  | { readonly type: 'conical'; readonly halfAngleDeg: number; readonly knuckleRadius?: number };

export type SupportSpec =
  | { readonly type: 'skirt'; readonly height: number; readonly thickness?: number; readonly baseRingWidth?: number }
  | { readonly type: 'legs'; readonly count: number; readonly height: number; readonly pitchDiameter?: number; readonly section?: string }
  | { readonly type: 'saddles'; readonly stations: readonly number[]; readonly width: number; readonly axisElevation: number }
  | { readonly type: 'none'; readonly baseElevation: number };

export interface VesselDesignData {
  readonly pressure?: Quantity<PressureUnit>;            // internal design pressure, gauge
  readonly temperatureC?: number;
  readonly material?: string;
  readonly allowableStress?: Quantity<'MPa' | 'psi'>;    // S at design temperature — never defaulted
  readonly allowableStressAtTest?: Quantity<'MPa' | 'psi'>;
  readonly jointEfficiency?: { readonly shell: number; readonly heads: number };
  readonly materialDensityKgM3?: Quantity<'kg/m3'>;
  readonly operatingLiquid?: { readonly specificGravity: number; readonly levelAboveBottomTangent: number };
}

export interface NozzleRecord {
  readonly mark: string;                  // unique per equipment: N1, M1, S1, T1…
  readonly service?: string;
  readonly dn: number;                    // nominal size; NPS converted on input
  readonly rating: string;                // 'CL150' | 'PN16' | … (validated against 01 PSC when present)
  readonly facing: 'RF' | 'FF' | 'RTJ';
  readonly location:
    | { readonly on: 'shell'; readonly elevation: number; readonly orientationDeg: number }   // vertical vessels
    | { readonly on: 'shell'; readonly station: number; readonly orientationDeg: number }     // horizontal (from left / front tangent)
    | { readonly on: 'head'; readonly head: 'top' | 'bottom' | 'left' | 'right'; readonly radialOffset: number; readonly orientationDeg?: number }
    | { readonly on: 'channel'; readonly channel: 'front' | 'rear'; readonly station: number; readonly orientationDeg: number }
    | { readonly on: 'pump'; readonly role: 'suction' | 'discharge' };
  readonly projection: number;            // shell: axis -> face; head: tangent line -> face
  readonly angleOffRadialDeg?: number;    // hillside / tangential nozzles (V1)
  readonly flange?: { readonly catalogRef?: string; readonly unverified?: boolean };  // 01 PSC component id
}

export type EquipmentTemplate =
  | { readonly kind: 'vessel'; readonly orientation: 'vertical' | 'horizontal'; readonly insideDiameter: number; readonly tangentLength: number;
      readonly heads: { readonly first: HeadSpec; readonly second: HeadSpec };       // bottom/top or left/right
      readonly shellThickness: number; readonly headThickness: number; readonly corrosionAllowance: number;
      readonly support: SupportSpec; readonly trays?: { readonly count: number; readonly spacing: number; readonly firstElevation: number; readonly type?: string } }
  | { readonly kind: 'exchanger'; readonly tema: { readonly front: string; readonly shell: string; readonly rear: string };
      readonly shellInsideDiameter: number; readonly shellThickness: number; readonly tubes: TubeBundleSpec;
      readonly tubesheetThickness: number; readonly frontChannelLength: number; readonly rearChannelLength: number; readonly support: SupportSpec }
  | { readonly kind: 'tank'; readonly standard: 'api_650'; readonly diameter: number; readonly shellHeight: number;
      readonly courses: readonly number[]; readonly roof: TankRoofSpec; readonly bottom: TankBottomSpec;
      readonly design: { readonly specificGravity: number; readonly designLiquidLevel: number; readonly material: string; readonly corrosionAllowance: number } }
  | { readonly kind: 'pump'; readonly standard: 'iso_2858' | 'asme_b73_1' | 'custom'; readonly size?: string; readonly api610Type?: string;
      readonly envelope: PumpEnvelope; readonly driver?: { readonly length: number; readonly width: number; readonly height: number } };

export interface PlantEquipmentData {
  readonly schema: 'llull-plant-equipment/1';
  readonly template: EquipmentTemplate;
  readonly design?: VesselDesignData;
  readonly nozzles: readonly NozzleRecord[];
  readonly planRotationDeg: number;
  readonly review?: { readonly status: 'not_reviewed' | 'reviewed'; readonly signatureId?: string };   // 09 PLM signature
}

/** Shared with 02 RTE / 07 PST: a world-space connection point. */
export interface ConnectionPort {
  readonly id: string;                    // '<tag>:<mark>', stable across revisions
  readonly ownerId: string;               // element id
  readonly position: Vec3;                // flange face centre, world
  readonly direction: Vec3;               // unit, pointing away from the equipment
  readonly dn: number;
  readonly rating: string;
  readonly facing: 'RF' | 'FF' | 'RTJ';
}
```

`EquipmentElement.plant?: PlantEquipmentData`. When `plant` is present, the evaluator also writes back the derived
legacy fields inside the same command: `size` = outside bounding box (supports and nozzles included), `shape` =
`vertical_vessel` / `horizontal_vessel` / `box`, `weight` = computed operating weight unless the user fixed
`weightOverride`. This keeps `check_clashes`, floor loads, schedules and plans correct with no change on day one.

## 4. Commands (toolset `plant`)

Every numeric length is in document units (AF-04), pressures are `{ value, unit }`, angles are in degrees with the
name suffix `Deg`. Equipment is addressed by `equipment` = tag (`"V-101"`) or element id.

| Name | Kind | Params (sketch) | `data` | Failure codes |
| ---- | ---- | --------------- | ------ | ------------- |
| `add_vessel` | mutating | `tag`, `name`, `orientation`, `location`, `planRotationDeg`, `levelId`, `insideDiameter`, `tangentLength`, `heads{top,bottom \| left,right}`, `shellThickness`, `headThickness`, `corrosionAllowance`, `support`, `design` | `elementId`, `tag`, `tangentElevations`, `defaulted[]` | `EQP_TAG_DUPLICATE`, `EQP_PARAM_INVALID`, `EQP_HEAD_INVALID`, `EQP_SUPPORT_INVALID`, `CMD_INVALID_PARAMS` |
| `add_column` | mutating (composes `add_vessel` via `execute`) | `add_vessel` params (vertical) + `trays{count, spacing, firstElevation, type}`, `platformClips[{elevation, fromDeg, toDeg}]` | as above + `trays[]`, `clips[]` | + `EQP_TRAYS_DONT_FIT` |
| `add_heat_exchanger` | mutating | `tag`, `temaType` ("BEM"), `orientation`, `location`, `shellInsideDiameter`, `shellThickness`, `tubes{outsideDiameter, wallThickness \| bwg, count, length, passes, pitch, layoutAngleDeg}`, `tubesheetThickness`, `frontChannel`, `rearChannel`, `support`, `design{shellSide, tubeSide}` | `elementId`, `tema{front, shell, rear, fixedTubesheet, removableBundle}`, `bundlePullLength` | `EQP_TEMA_INVALID`, `EQP_TEMA_UNSUPPORTED` (K, X, D in MVP), `EQP_PARAM_INVALID` |
| `add_storage_tank` | mutating | `tag`, `standard: 'api_650'`, `location`, `diameter`, `shellHeight`, `courses[]`, `roof{type: cone \| dome \| flat, slopeRatio \| radius}`, `bottom`, `design{specificGravity, designLiquidLevel, material, corrosionAllowance}` | `elementId`, `courses[]` | `EQP_COURSES_MISMATCH`, `EQP_PARAM_INVALID` |
| `add_pump` | mutating | `tag`, `standard`, `size` \| `envelope{a, f, h1, h2, …}`, `api610Type`, `location`, `planRotationDeg`, `driver`, `baseplate` | `elementId`, `envelope{…, source, grade}`, suction / discharge port ids | `EQP_PUMP_SIZE_UNKNOWN`, `EQP_PARAM_INVALID` |
| `add_nozzle` | mutating | `equipment`, `mark`, `service`, `dn` \| `nps`, `rating`, `facing`, `location`, `projection`, `angleOffRadialDeg`, `flangeRef` | `portId`, `position`, `direction` | `EQP_NOT_FOUND`, `EQP_NOZZLE_MARK_DUPLICATE`, `EQP_NOZZLE_OFF_BODY`, `EQP_NOZZLE_PROJECTION_TOO_SHORT`, `EQP_RATING_UNKNOWN` (when 01 PSC present) |
| `update_nozzle` / `delete_nozzle` | mutating | `equipment`, `mark`, fields | `portId` | `EQP_NOZZLE_NOT_FOUND`, + `add_nozzle` codes; `delete_nozzle` warns `EQP_PORT_CONNECTED` and refuses unless `force` |
| `update_equipment_parameters` | mutating | `equipment`, `set{…template fields}` | `changed[]`, `movedPorts[]`, `connectedPipes[]` | `EQP_NOT_FOUND`, `EQP_NOT_PARAMETRIC` (legacy box), template codes |
| `vessel_volume` | query | `equipment`, `levels[]` (from lowest inside point), `side: shell \| tube` (exchangers) | `totalVolumeM3`, `levels[{level, liquidVolumeM3, percent}]`, `method`, `assumptions[]` | `EQP_NOT_FOUND`, `EQP_LEVEL_OUT_OF_RANGE` |
| `equipment_weights` | query | `equipment`, `include[] (body, nozzles, internals, insulation)` | `body{emptyKg, operatingKg, testKg}`, `breakdown[{part, kg, method}]`, `defaulted[]`, `unverified` | `EQP_NOT_FOUND`, `EQP_DESIGN_DATA_MISSING` |
| `vessel_thickness` | query | `equipment`, `corrodedDimensions` (default true), `pressure?` (override) | `components{shell, headTop…}{requiredThicknessMm, availableThicknessMm, mawpMPa, formula, inputs}`, `mawpMPa`, `hydrotestPressureMPa`, `reviewRequired`, `provenance` | `EQP_ALLOWABLE_MISSING`, `EQP_FORMULA_OUT_OF_RANGE`, `EQP_HEAD_NOT_COVERED`, `EQP_DESIGN_DATA_MISSING` |
| `tank_shell_thickness` | query | `equipment`, `method: 'one_foot'` | `courses[{course, H_m, designThicknessMm, testThicknessMm, minimumThickness{mm, source, unverified}, governingThicknessMm}]`, `allowableStress{Sd, St}` | `EQP_API650_ONE_FOOT_LIMIT`, `EQP_MATERIAL_NOT_IN_TABLE` |
| `equipment_ports` | query | `equipment?` (all when omitted) | `ports{[portId]: ConnectionPort + service}` | `EQP_NOT_FOUND` |
| `equipment_datasheet` | query (+ `--save`) | `equipment`, `format: json \| csv` | the data-sheet record (§6) | `EQP_NOT_FOUND` |
| `check_equipment` | query | `equipment?[]` | `status` = `fail` if any fail, else `warn` if any warning, else `pass_with_review` if any result needs review, else `pass`; `issues` sorted by severity (fail, warning) then code; `issues[{code, severity, ids, paths, message, remediation}]`, `reviewRequired` | — (findings, not refusals) |
| `save_equipment_template` / `insert_equipment_template` (V1) | mutating | `equipment`, `name` / `name`, `tag`, `location`, `overrides` | `templateName` / `elementId` | `EQP_TEMPLATE_NOT_FOUND` |

Structured tags (examples; every command file carries them):

```ts
/**
 * @affects creates 1 equipment element (template 'vessel') + derived solids on layer Q-EQPM
 * @invariant size/shape/weight of the element are re-derived from `plant`; ids are step-scoped (L8)
 * @failure duplicate tag, D or L <= 0, thickness <= CA, head ratio <= 0, support outside body -> coded no-op
 */
export const addVessel = defineCommand({ name: 'add_vessel', … });

/**
 * @affects none (query)
 * @invariant corroded dimensions unless corrodedDimensions:false; S and E never defaulted; reviewRequired always true
 * @failure no allowable stress, P > 0.385 S E, unsupported head type -> coded refusal with param path
 */
export const vesselThickness = defineCommand({ name: 'vessel_thickness', annotations: { readOnlyHint: true }, … });
```

## 5. Algorithms

### 5.1 Formed heads (FR-EQP-01)

D = inside diameter, a = inside depth, t = thickness.

- **Ellipsoidal**, ratio m (2 for 2:1): a = D/(2m). Volume V = πD²a/6 (2:1: πD³/24). Inside area: oblate
  (a < R) A = πR² + πa²/(2e) ln((1+e)/(1−e)), e = √(1 − a²/R²); prolate A = πR² + πaR/e · asin e,
  e = √(1 − R²/a²) [R3 in validation S3].
- **Torispherical**, crown radius fD, knuckle kD: α = asin((1 − 2k)/(2(f − k))), a₁ = fD(1 − cos α),
  a₂ = kD cos α, a = a₁ + a₂; volume by the Jones closed form filled to the tangent line; area per the Honeywell
  formula (B) and by numerical integration of the profile (gate). Standard (f, k): ASME F&D (1, 0.06), 80/10
  (0.8, 0.1), 80/6 (0.8, 0.06), DIN 28011 (1, 0.1), DIN 28013 (0.8, 0.154). Refuse k ≥ 0.5 or f ≤ k
  (`EQP_HEAD_INVALID`).
- **Hemispherical**: a = R, V = πD³/12. **Conical**: a = R / tan(half-angle), V = πR²a/3. **Flat**: a = 0.
- **Revolve profile**: the torispherical profile is exactly two `arc` segments + a line; the hemisphere one arc;
  the ellipse has no exact segment in `CurveSegment` (line / arc / cubic Bézier), so the 2:1 profile is four cubic
  Béziers per quarter (radial error ≤ 1e-5 R) — open question Q3 proposes an `ellipse` segment. Volumes and weights
  never come from the mesh: they use the closed forms.

### 5.2 Volumes and partial volumes (FR-EQP-09)

Level h is measured from the lowest inside point (Jones convention [validation S1]).

- Vertical vessel: V(h) = V_bottomHead(min(h, a_b)) + πD²/4 · clamp(h − a_b, 0, L) + V_topHead(…) where the top head
  is the bottom formula mirrored: V_top(x) = V_full − V_head(a_t − x) for the filled height x inside the top head.
  Ellipsoidal: V(h) = π/4 (Dh/a)² (a − h/3), h < a. Spherical cap and conical: Jones forms. Torispherical: the three
  branches (dish, knuckle, beyond) with α, a₁, a₂, D₁ = 2fD sin α, s = (kD sin α)², t = 2a₂, u = h − a₁.
- Horizontal vessel: V(h) = A_f(h) · L + 2 V_head(h); A_f = R² acos((R − h)/R) − (R − h)√(2Rh − h²);
  ellipsoidal heads V_2heads = πah²(1 − h/(3R)) (hemispherical: a = R); conical heads by the Jones closed form;
  torispherical heads (V1) by adaptive Gauss–Kronrod of the segment area over the head depth (tolerance 1e-10
  relative), matching the reference-code values of VC-EQP-02 within 1e-6.
- Tanks: V(h) = πD²/4 · h (flat bottom); cone-bottom by the conical-head form.
- Exchangers: shell side = πDs²/4 · (Lt − 2 t_ts) − N πdo²/4 (Lt − 2 t_ts); tube side = N π di²/4 Lt + channels +
  bonnet heads; baffles, tie rods and pass partitions listed in `assumptions` (V1 subtracts them).
- `levels` outside [0, total height] → `EQP_LEVEL_OUT_OF_RANGE` with the index path.

### 5.3 Weights (FR-EQP-10)

- Shell: π/4 ((D + 2t)² − D²) L ρ. Skirt / tank courses: same annulus. Legs, saddles, baseplates: prism volumes.
- Formed head metal: exact solid between the inside profile and its outward offset by t, closed by the tangent plane.
  Torispherical and hemispherical offsets are arcs of radius + t (closed form); ellipsoidal offsets are not ellipses:
  64-point Gauss–Legendre on the parameter u ∈ [0, π/2] of V = ∫ π x(u)² z′(u) du for both curves (agrees with the
  1e5-segment trapezoid of `derive_expected.py` to 1e-9; on a hemisphere it equals 2π/3((R + t)³ − R³)). The
  thin-wall rule (area × t) is 1.6 % low for a 2:1 head D 1500 / t 10 and is not used.
- Nozzles: neck annulus × projection beyond the shell + flange mass from 01 PSC (placeholder flagged until then).
- Operating = empty + Σ liquid V(h_op) × SG × 1000; test = empty + V_total × ρ_water (1000 kg/m³ named default,
  `defaulted: true`). ρ steel: plan / design input, else `STEEL_DENSITY_KG_PER_M3` with `defaulted: true` and source.
- Centre of gravity (V1): Σ m_i x_i over the same parts.

### 5.4 Nozzle placement and port frames (FR-EQP-08)

Angle convention (fixed, reported in every result as `angleConvention`): **vertical equipment** — 0° = plant north
(+Y of the equipment frame), angles increase **clockwise seen from above** (90° = east +X), as on vessel orientation
drawings; **horizontal equipment** — the angle is around the axis, 0° = top (+Z), 90° = the +Y side, 180° = bottom.
The equipment frame is the plan rotation `planRotationDeg` about +Z at `location`.

- Vertical, shell nozzle at elevation e above the bottom tangent line (BTL), angle θ, projection p (axis → face):
  local direction d = (sin θ, cos θ, 0); face centre P = (c_x, c_y, z_BTL + e) + p d; port direction d.
  `EQP_NOZZLE_PROJECTION_TOO_SHORT` when p < R + t + flange thickness.
- Head nozzle (top / bottom) with radial offset r at angle θ: base point on the head surface at radius r,
  P = base + (z_TL ± p − z_base) along ±Z for a vertical nozzle (projection from the tangent line);
  r must be inside the crown (dish) region of a torispherical head or inside 0.8 R of an ellipsoidal head, else warning
  `EQP_NOZZLE_IN_KNUCKLE`.
- Horizontal, shell nozzle at station s from the left tangent, angle φ: axis point A = (−L/2 + s, 0, z_axis);
  d = (0, sin φ, cos φ); P = A + p d.
- Head nozzle on a horizontal vessel (left / right): P = (± (L/2 + p), r sin φ, z_axis + r cos φ), d = (±1, 0, 0).
- World transform: rotate local by `planRotationDeg` about +Z, translate by `location`, add level elevation.
- Port id = `<tag>:<mark>`; marks unique per equipment (`EQP_NOZZLE_MARK_DUPLICATE`); tags unique per document
  (existing rule of `add_equipment`).
- Overlap check: two nozzles on the same body whose reinforcement circles (diameter 2 × neck OD) intersect →
  `EQP_NOZZLE_OVERLAP` (warning; UG-37 is V2).

### 5.5 ASME VIII-1 (FR-EQP-11)

Corroded condition by default: R_c = R + CA, D_c = D + 2CA, t_av = t_nominal − CA − (mill undertolerance if given).

| Part | Required t | MAWP | Limit (refuse outside) |
| ---- | ---------- | ---- | ---------------------- |
| Shell, circumferential UG-27(c)(1) | P R_c /(S E − 0.6 P) + CA | S E t_av /(R_c + 0.6 t_av) | P ≤ 0.385 S E, t ≤ R/2 |
| Shell, longitudinal UG-27(c)(2) | P R_c /(2 S E + 0.4 P) + CA | 2 S E t_av /(R_c − 0.4 t_av) | reported only |
| 2:1 ellipsoidal UG-32 | P D_c /(2 S E − 0.2 P) + CA | 2 S E t_av /(D_c + 0.2 t_av) | ratio exactly 2 (else `EQP_HEAD_NOT_COVERED`, Appendix 1-4 is V1) |
| Torispherical (L = crown radius, r ≥ 6 % L) UG-32 | 0.885 P L /(S E − 0.1 P) + CA | S E t_av /(0.885 L + 0.1 t_av) | ASME F&D proportions only (others V1) |
| Hemispherical UG-32 | P L /(2 S E − 0.2 P) + CA | 2 S E t_av /(L + 0.2 t_av) | — |

- Vessel MAWP = min over parts (at the top; static head reported separately as `staticHeadMPa` when an operating
  liquid is given). Hydrotest UG-99(b): P_t = 1.3 · MAWP · min(S_test / S_design) (ratio 1 when S_test not given,
  `defaulted: true`).
- Status per part: `fail` when t_av < t_req (`EQP_SHELL_UNDER_THICKNESS`, `EQP_HEAD_UNDER_THICKNESS`) or
  MAWP < P (`EQP_MAWP_BELOW_DESIGN`); otherwise `pass_with_review`. Never plain `pass`: `reviewRequired: true`,
  reason "ASME VIII-1 thickness computed by llull from the cited formulas; not a stamped design".
- `corrodedDimensions: false` reproduces sources that use the uncorroded radius (validation UG27-C).
- S, E are never defaulted (`EQP_ALLOWABLE_MISSING` with path `design.allowableStress`); a user S without `source`
  is accepted but flagged `EQP_VALUE_UNSOURCED` (warning, AF-32).

### 5.6 API 650 one-foot method (FR-EQP-12)

For each course i with bottom at z_i: H_i = designLiquidLevel − z_i (m); t_d = 4.9 D (H_i − 0.3) G / S_d + CA;
t_t = 4.9 D (H_i − 0.3) / S_t; t = max(t_d, t_t, t_min(D)). S_d / S_t from `data/api650Tables.ts` (rows with grade;
material not in the table → `EQP_MATERIAL_NOT_IN_TABLE` unless the user supplies S_d / S_t with a source).
t_min by diameter from the table; grade-B/C rows set `minimumThickness.unverified: true` and `check_equipment` raises
`EQP_TABLE_UNVERIFIED`. D > 60 m → `EQP_API650_ONE_FOOT_LIMIT` (variable-design-point method is V2). Courses whose
heights do not sum to the shell height → `EQP_COURSES_MISMATCH`.

### 5.7 TEMA designation and exchanger envelope (FR-EQP-06)

Parse `temaType` as exactly three letters: front ∈ {A, B, C, N, D}, shell ∈ {E, F, G, H, J, K, X}, rear ∈
{L, M, N, P, S, T, U, W}; anything else → `EQP_TEMA_INVALID` with path `temaType.<index>`. MVP geometry for E, F, G,
H, J shells with fronts A / B / N / C and rears L / M / N (fixed tubesheet), U (U-bundle, no rear tubesheet, rear
head = shell cover), S / T / P / W (floating head: shell cover + floating head cover); K (kettle) and X are V1
(`EQP_TEMA_UNSUPPORTED`). Components along the axis: front head (bonnet: channel cylinder + 2:1 head; A: channel +
flat cover), tubesheet, shell, (tubesheet | shell cover), rear head. `fixedTubesheet` = rear ∈ {L, M, N};
`removableBundle` = not fixed. Bundle-pull clearance zone = tube length + 1 m in front of the stationary head
(named default, `defaulted: true`), exported to `check_clashes` as a clearance zone.

### 5.8 Pump envelopes (FR-EQP-07)

ISO 2858 row (a, f, h1, h2): shaft axis at height h1 above the baseplate top; discharge nozzle vertical on the axis
plane, face at h1 + h2; suction nozzle axial, face at distance a from the discharge centre; bearing frame to f.
B73.1 row (CP, D, X): overall length CP, shaft height D, discharge face X above the shaft. Driver box and baseplate
from `driver` / `baseplate` params (vendor data; flagged when defaulted). Only grade-A rows are used silently; grade-B
rows warn `EQP_TABLE_UNVERIFIED`; an unknown size with no `envelope` → `EQP_PUMP_SIZE_UNKNOWN`.

### 5.9 Numerical tolerances

Closed forms: double precision, gated at 1e-9 relative. Quadratures: 1e-10 relative target. Geometry: positions
rounded to 1e-9 document units before storage (determinism, AF-13). Tessellation of revolutions: default 64 segments
per revolution for equipment (≤ 0.16 % volume loss on a circle), LOD from 09 VIS.

## 6. Interop and persistence

- **Document**: `EquipmentElement.plant` is plain JSON in the existing `llull-document` format; replay re-derives
  geometry (L8). Schema id `llull-plant-equipment/1` allows future migrations.
- **Data sheet** (`equipment_datasheet`): JSON `llull-equipment-datasheet/1` = { identification (tag, name, service,
  template), design (P, T, material, S, E, CA with sources), geometry (D, L, heads, supports), nozzles (schedule rows:
  mark, service, DN, rating, facing, location, projection, port position / direction), volumes, weights (breakdown +
  method), code results, provenance, review status }. CSV = one sheet per section. A sheet table via the existing
  sheet commands (`create_sheet` + table, V1).
- **IFC** (FR-EQP-18): MVP extends `ifcIndustrialExport.ts`: body = `IfcRevolvedAreaSolid` per shell / head part
  (exact profile) instead of the extruded circle; one `IfcDistributionPort` per nozzle (FlowDirection SOURCE /
  SINK / SOURCEANDSINK from `service`, placement = port frame), nested to the element; `Pset_llullEquipment` gains
  template, design and weights. V1: typed `IfcTank` / `IfcPump` / `IfcHeatExchanger` (entity names to confirm, S30);
  IFC 4.3 and property-set mapping are owned by 08 DAT.
- **DXF / plan**: vertical vessels already draw as circles; nozzles add a stub line + mark text (`planIndustrial.ts`).
  Nozzle orientation view (FR-EQP-22, V1) = a 2D drawing view of the equipment from +Z with angle labels.
- **STEP**: through the existing kernel export of the derived solids (OCC: exact revolutions).
- **Templates** (FR-EQP-19): V1 JSON file `llull-equipment-template/1` = template + nozzles without tag / location;
  stored in the document like recipes and exportable with `--save`.
- **Hand-off V2**: PV Elite / COMPRESS neutral input (vessel components list) and import of their thickness / MAWP
  results as a `review` attachment.

## 7. CLI / MCP / UI surfaces

- CLI: all commands through `llull <command> '<json>' --json`; plans through `llull run`; `--save` for data sheets.
  `llull guide` gains a "Plant equipment" section (AF-03): units, angle convention, port ids, the SC-EQP-01 plan.
- MCP: toolset `plant`; tool descriptions written for agents (AF-02), e.g. `add_nozzle`: "Add a flanged nozzle to an
  equipment … projection = distance from the vessel axis to the flange face (shell nozzles) or from the tangent line
  (head nozzles), in document units … returns the port id `<tag>:<mark>` that `route_pipe` (02) connects to …
  refuses EQP_NOZZLE_OFF_BODY …".
- UI: palette entries generated from the registry; viewport render branch for the new derived parts (no new entity
  kind needed: `revolution`, `box`, `extrusion` already render); a port glyph (arrow at the flange face) in
  `src/ui/viewport/3d`; properties panel shows the data sheet and `reviewRequired` badge (review surface only).

### Stable error codes (AF-11)

| Code | Kind | Raised by | Meaning | Remediation (one line) |
| ---- | ---- | --------- | ------- | ---------------------- |
| `EQP_NOT_FOUND` | refusal | all `equipment` params | no equipment with that tag / id | list tags with `equipment_ports` or `building_schedule kind equipment` |
| `EQP_TAG_DUPLICATE` | refusal | `add_*` | tag already used | choose another `tag` |
| `EQP_NOT_PARAMETRIC` | refusal | `update_equipment_parameters`, `add_nozzle` | legacy footprint equipment | recreate it with `add_vessel` / `add_pump` … |
| `EQP_PARAM_INVALID` | refusal | templates | non-positive size, thickness ≤ CA, etc.; `paths` names the param | fix the value at the given path |
| `EQP_HEAD_INVALID` | refusal | heads | ratio ≤ 0, k ≥ 0.5, f ≤ k, half-angle ∉ (0, 90) | use a named standard or valid radii |
| `EQP_SUPPORT_INVALID` | refusal | supports | saddle station outside the tangent length, legs < 3, skirt height ≤ 0 | move the saddles inside 0..L |
| `EQP_TRAYS_DONT_FIT` | refusal | `add_column` | tray stack exceeds the tangent length | reduce `count` or `spacing` |
| `EQP_TEMA_INVALID` | refusal | `add_heat_exchanger` | letter not in the TEMA table; `paths` = `temaType.<i>` | use e.g. BEM, AES, AEU |
| `EQP_TEMA_UNSUPPORTED` | refusal | `add_heat_exchanger` | valid letter not modelled yet (K, X, D) | use an E-shell type or a generic `add_vessel` |
| `EQP_COURSES_MISMATCH` | refusal | `add_storage_tank` | course heights ≠ shell height | make the courses sum to `shellHeight` |
| `EQP_PUMP_SIZE_UNKNOWN` | refusal | `add_pump` | size not in the shipped table and no `envelope` | give `envelope` dimensions from the vendor datasheet |
| `EQP_NOZZLE_MARK_DUPLICATE` | refusal | nozzles | mark already used on this equipment | choose another `mark` |
| `EQP_NOZZLE_NOT_FOUND` | refusal | nozzles | no nozzle with that mark | list marks with `equipment_ports` |
| `EQP_NOZZLE_OFF_BODY` | refusal | nozzles | elevation / station / radial offset outside the body | keep 0 ≤ elevation ≤ L, offset < R |
| `EQP_NOZZLE_PROJECTION_TOO_SHORT` | refusal | nozzles | face inside the shell + flange | increase `projection` |
| `EQP_RATING_UNKNOWN` | refusal | nozzles (with 01 PSC) | rating not in the spec / catalogue | use a rating of the line's pipe class |
| `EQP_LEVEL_OUT_OF_RANGE` | refusal | `vessel_volume` | level < 0 or above the top | give levels inside 0..height |
| `EQP_ALLOWABLE_MISSING` | refusal | `vessel_thickness` | no S (or E) | set `design.allowableStress` with its source |
| `EQP_FORMULA_OUT_OF_RANGE` | refusal | `vessel_thickness` | P > 0.385 S E or t > R/2 | thick-wall (Appendix 1-2) is out of MVP scope — needs an engineer |
| `EQP_HEAD_NOT_COVERED` | refusal | `vessel_thickness` | head type / proportions without an MVP formula | use 2:1, ASME F&D or hemispherical, or review manually |
| `EQP_API650_ONE_FOOT_LIMIT` | refusal | `tank_shell_thickness` | D > 60 m | variable-design-point method (V2) |
| `EQP_MATERIAL_NOT_IN_TABLE` | refusal | `tank_shell_thickness` | material without Sd / St row | give `Sd`, `St` with a source |
| `EQP_DESIGN_DATA_MISSING` | warning | queries, check | P, T, SG or level missing for a requested result | add `design` data with `update_equipment_parameters` |
| `EQP_SHELL_UNDER_THICKNESS` | fail | `check_equipment` | t_av < t_req (shell) | increase `shellThickness` or lower P |
| `EQP_HEAD_UNDER_THICKNESS` | fail | `check_equipment` | t_av < t_req (head) | increase `headThickness` |
| `EQP_MAWP_BELOW_DESIGN` | fail | `check_equipment` | MAWP < design P | as above |
| `EQP_NOZZLE_OVERLAP` | warning | `check_equipment` | reinforcement zones intersect | move one nozzle |
| `EQP_NOZZLE_IN_KNUCKLE` | warning | `check_equipment` | head nozzle in the knuckle / outside 0.8 R | move it toward the centre |
| `EQP_NOZZLE_IN_SUPPORT` | warning | `check_equipment` | nozzle crosses a saddle / skirt without opening | move it or add a skirt opening (V1) |
| `EQP_PORT_CONNECTED` | warning / refusal | `delete_nozzle`, `update_*` | a pipe (02) is attached to the port | re-route the pipe first or pass `force` |
| `EQP_TABLE_UNVERIFIED` | warning | queries, check | a grade-B/C table row was used | confirm the value from the licensed standard or a vendor |
| `EQP_VALUE_UNSOURCED` | warning | check | a safety-relevant input has no `source` | add the source (standard, datasheet) |
| `EQP_FLANGE_PLACEHOLDER` | warning | check | nozzle flange not from 01 PSC | assign a pipe class / catalogue flange |

## 8. Performance and robustness budgets

- `add_vessel` / `add_nozzle` evaluation: ≤ 5 ms per equipment (≤ 40 derived entities); a 200-equipment unit
  with 1 000 nozzles regenerates in ≤ 2 s on the reference desktop (no kernel), ≤ 10 s with OCC B-rep build.
- Queries: `vessel_volume`, `vessel_thickness`, `equipment_weights` ≤ 1 ms each (closed forms); horizontal
  torispherical quadrature ≤ 5 ms; `check_equipment` on 200 items ≤ 200 ms.
- Determinism (AF-13): identical plans give byte-identical `--json`; quadratures use fixed node counts.
- Robustness: every numeric input validated by zod (finite, ranges) before maths; NaN in a result →
  `CMD_CORRUPT_RESULT` by the existing guard; no thrown exceptions for user errors (coded no-ops).
- Output bounded (AF-12): `equipment_ports` without `equipment` pages at 500 ports; data sheets go to `--save`.

## 9. Test strategy

| Layer | Files | VCs |
| ----- | ----- | --- |
| Unit: head geometry, volumes, areas | `tests/unit/plant/equipment/headGeometry.test.ts`, `headVolumes.test.ts` (read `validation/data/*.json`) | VC-EQP-01..04 |
| Unit: codes | `asmeThickness.test.ts`, `api650.test.ts` | VC-EQP-05..08 |
| Unit: weights, pumps, TEMA, nozzles | `weights.test.ts`, `pumps.test.ts`, `exchanger.test.ts`, `nozzles.test.ts` | VC-EQP-09..12 |
| Unit: guardrails | `guardrails.test.ts`: every code of §7 reached with its paths; `reviewRequired`; unverified propagation; determinism | VC-EQP-16 |
| Unit: regeneration | `regeneration.test.ts` (`update_equipment_parameters`, ids stable, "is pure" test) | VC-EQP-19 |
| Scenario plans | `scenarioPlans.test.ts` replays `docs/plant/03-parametric-equipment/validation/plans/*.json` through `build_project` | VC-EQP-13..15, 17 |
| Golden | one `tests/golden/plans.ts` entry `plant_vertical_vessel` (SC-EQP-01 actions) → id-normalised snapshot + replay equality | VC-EQP-13 |
| Contract | `toToolSchemas()` snapshot gains the `plant` commands; toolset contract | AF-01 |
| Kernel | `golden.kernel.test.ts` variant on OCC: revolved head solid volume vs closed form (1e-6) | VC-EQP-03 |
| IFC | `ifcEquipment.test.ts`: port count, placements | VC-EQP-20 |
| Server / CLI | `server/tests`: `llull run` of SC-EQP-01 with `--json`, exit codes; production-gate agent driver runs the four plans | AF-23 |

Coverage gate 90/85/90/90 applies to `packages/domain-aec/src/**` (CLAUDE.md).

## 10. Delivery plan

| Milestone | Content | Depends on | Effort |
| --------- | ------- | ---------- | ------ |
| M1 — geometry core | `plantEquipment.ts` types, head library, partial volumes, offset weights, data tables with grades, `vessel_volume`; VC-01..04 | — | 6 d |
| M2 — vessels and nozzles | `add_vessel` (skirt, legs, saddles), `add_column`, `add_nozzle` / `update_nozzle` / `delete_nozzle`, ports, `equipment_ports`, `update_equipment_parameters`, evaluation as revolutions, legacy fields write-back, clash / loads unchanged; VC-12, 13, 14 (geometry rows), 19 | M1 | 8 d |
| M3 — code checks | `vessel_thickness`, `tank_shell_thickness`, `equipment_weights`, `check_equipment`, error table, guardrails; VC-05..09, 16 | M1 | 5 d |
| M4 — exchangers, tanks, pumps | `add_heat_exchanger` (TEMA), `add_storage_tank`, `add_pump`; VC-10, 11, 15, 17 | M2 | 7 d |
| M5 — interop and review | data sheet JSON / CSV, IFC ports and revolved bodies, plan nozzle stubs, UI port glyph and data-sheet panel, `llull guide` section; VC-20 | M2–M4, 08 DAT (IFC conventions) | 5 d |
| V1 | air coolers, compressors, tube layout + span check (VC-18), strapping tables, horizontal torispherical volumes, templates, orientation drawing, lugs, CoG, typed IFC | M5, 01 PSC flanges, 06 STA platforms | 15 d |
| V2 | saddle / skirt / wind / seismic, UG-37, EN 13445, PV Elite / COMPRESS hand-off | V1, 07 PST nozzle loads | 20 d+ |

Cross-gap contracts: 01 PSC provides flange / rating geometry (`catalogRef`); 02 RTE consumes `ConnectionPort` and
reports connected pipes back for `EQP_PORT_CONNECTED`; 04 PID maps P&ID equipment tags and nozzle marks to these tags
and port ids; 06 STA reads `platformClips` and column geometry; 07 PST reads ports for nozzle load points; 08 DAT owns
the tag registry and equipment list; 09 VIS adds LOD for the revolution bodies.

## 11. Open questions / decisions needed

- **Q1 Data placement.** Extend `EquipmentElement` (proposed; keeps every consumer working, ties equipment to a level)
  or a separate plugin `DocumentExtension` `plantModel` with its own elements (cleaner for plant-wide coordinates,
  needs new clash / load / IFC adapters)? To decide together with 02 RTE and 08 DAT.
- **Q2 Angle convention.** North-clockwise (proposed, orientation-drawing practice) vs east-counter-clockwise (CAD
  math). Plant 3D's "A" field origin could not be confirmed from its help extract. Owner decision; both can be
  supported with `angleConvention` but one must be the default.
- **Q3 Exact ellipse in core.** Add an `ellipse` arc `CurveSegment` (core model change, cad-reviewer) so OCC builds
  exact 2:1 heads, or accept the Bézier approximation for the B-rep.
- **Q4 ISO 2858 / B73.1 dimension meaning.** The a / f and CP / D / X column meanings are inferred from catalogue
  drawings; confirm from the licensed standards before treating rows as anything but envelopes.
- **Q5 Licensed tables.** Should a company be able to import its licensed ASME II-D / API 650 / TEMA tables as a
  signed library (09 PLM), replacing the public grade-B rows?
- **Q6 API 650 minimum thickness for D < 15 m** (5 mm vs 6 mm by edition) — which edition does llull target?
- **Q7 Nozzle flange before 01 PSC lands**: ship a minimal ASME B16.5 / EN 1092-1 flange OD table here, or only
  placeholders? (Proposal: placeholders only, to keep one catalogue owner.)

### 11.1 Decisions (2026-10-23, owner delegated: "better for the app even if it takes more time")

- **Q1 / README D6: extend `EquipmentElement`.** One equipment model: the building element gains `plant?: PlantEquipmentData`
  (types in `plant/equipment/`, not core, D2). Its level is the support datum and load path; the plant hierarchy and tags are
  08 DAT's overlay. A separate `doc.plant.equipment` model would need a second copy of clash, loads, schedules, IFC, plans,
  openings and support layout (13 modules) and two equipment kinds; rejected.
- **Q2 / README D3: both conventions, `north_cw` default.** `angleConvention: 'north_cw' | 'east_ccw'` on every command that
  takes an angle (default `north_cw` as in §5.4); every result names the convention used. `add_nozzle` also takes a free
  `{ position, direction }` location in the equipment frame (pumps, `add_equipment` blocks, D3), resolved to the same
  `ConnectionPort`.
- **Q3: exact ellipse in core.** Add an `ellipse` arc to `CurveSegment` (core model, Manifold tessellation, closed-form
  volume, native OCC kernel `GC_MakeArcOfEllipse`), so 2:1 heads are exact B-rep. Own lane; heads use the Bézier profile
  behind one function until it lands, then switch.
  Built: `CurveSegment` `{ type: 'ellipse', points: [start, centre, end] }` is an exact quarter ellipse (start - centre and end - centre are
  conjugate semi-diameters); a 2:1 head of diameter D is `quarter [(D/2, 0), (0, 0), (0, D/4)]` (Pappus pi D^3 / 24 to 1e-12 in core, OCC
  `GC_MakeArcOfEllipse` chain code 3 to 1e-15 measured); the head profile is switched by the 03 EQP integrator.
- **Q7: flanges from 01 PSC.** PSC M1 is built: nozzle flanges come from `lookup_piping_component`; `EQP_FLANGE_PLACEHOLDER`
  only when the catalogue has no row for the DN / rating / facing.
- **Q5: yes, later** (M3 / V1): licensed tables enter through the 01 PSC import path, private, replacing grade-B rows.
- Q4 and Q6 stay open (M4 pumps, M3 API 650).

## 12. References

- [R1] Jones D., "Calculating Tank Volume" (2015) — http://www.webcalc.com.br/blog/Tank_Volume.PDF (via fluids; accessed 2026-10).
- [R2] Bell C., fluids 1.3.1 (MIT) — https://pypi.org/project/fluids/ — `fluids/geometry.py`, `tests/test_geometry.py` (accessed 2026-10).
- [R3] Weisstein E. W., "Spheroid" — MathWorld — https://mathworld.wolfram.com/Spheroid.html (accessed 2026-10).
- [R4] ASME BPVC Section VIII Division 1 — ASME — catalogue page https://www.asme.org/codes-standards/find-codes-standards/bpvc-viii-1-bpvc-section-viii-rules-construction-pressure-vessels-division-1 (accessed 2026-10).
- [R5] Hexagon CodeCalc Help, "Example Shell Analysis" — https://docs.hexagonppm.com/r/en-US/CodeCalc-Help/25/303400 (extract, accessed 2026-10).
- [R6] Codeware INSPECT API-510 sample report — https://www.codeware.com/inspect/docs/INSPECT-API510-Sample-Report.pdf (extract, accessed 2026-10).
- [R7] checalc.com vessel guide — https://checalc.com/vessel_guide.html (extract, accessed 2026-10).
- [R8] API Std 650 — American Petroleum Institute — https://www.api.org (catalogue / errata, accessed 2026-10).
- [R9] API 650 one-foot method summaries: epcland.com (https://epcland.com/?p=49206), midstreamcalculator.com, industrialmonitordirect.com (extracts, accessed 2026-10).
- [R10] API 650 Table 5-2a extracts — Scribd 370515298, 750142418 (extracts, accessed 2026-10).
- [R11] ISO 2858:1975 — https://www.iso.org/standard/7862.html; ASME B73.1 — https://webstore.ansi.org/standards/asme/asmeb732020 (catalogue pages, accessed 2026-10).
- [R12] Autodesk AutoCAD Plant 3D User Guide (equipment, nozzles) — https://help.autodesk.com/cloudhelp/2026/ENU/Plant3D-UserGuide/files/create_equipment_to.htm (accessed 2026-10).
- [R13] AVEVA E3D Design, Design Templates / nozzles — https://help.aveva.com/AVEVA_Everything3D/2.1/DTI/DTI4.4.6.html (accessed 2026-10).
- [R14] CADMATIC Component Modeller — https://docs.cadmatic.com/plant/Content/Component%20Modeller/componentmodeller.htm (accessed 2026-10).
- [R15] Hexagon CADWorx Equipment palette — https://docs.hexagonppm.com/r/en-US/CADWorx-Equipment/22/357265 (accessed 2026-10).
- [R16] TEMA Standards — https://tema.org; ht 1.2.0 (MIT) — https://pypi.org/project/ht/ (accessed 2026-10).
- [R17] buildingSMART IFC4 ADD2 TC1 — https://standards.buildingsmart.org/IFC/RELEASE/IFC4/ADD2_TC1/HTML/ (not fetched).
- [R18] Zick L. P., Welding Journal Research Supplement, 1951 (cited only).
- Full source grading: [validation/sources.md](validation/sources.md).

## 13. As built (M1 geometry core, 2026-10-23)

Code: `packages/domain-aec/src/plant/equipment/` (plugin `plant-equipment`, toolset `plant_equipment` — renamed from the spec's `plant` at the wave-1 merge to sit beside 06 STA's `plant_structures`; read `plant` as `plant_equipment` in §2–§7 — installed by `installDefaultPlugins()`); tests
`tests/unit/plant/equipment/{headVolumes,headGeometry,vesselVolume}.test.ts` (read `validation/data/*.json` directly).

| Module | Content |
| ------ | ------- |
| `model.ts` | `headSpecSchema` / `HeadSpec` (zod, one flat object: `type` + `ratio` / `standard` / `crownRadius` + `knuckleRadius` / `halfAngleDeg` / `thickness`), `SourceGrade`, refusal table (`EQP_PARAM_INVALID`, `EQP_HEAD_INVALID`, `EQP_HEAD_NOT_COVERED`, `EQP_LEVEL_OUT_OF_RANGE`) |
| `data/headStandards.ts` | five torispherical rows (f, k) with sources and grade; asme_80_10 and asme_80_6 are grade B, so they report `unverified` |
| `geometry/heads.ts` | `resolveHead` (EQP_HEAD_INVALID reasons with param paths), depth, Jones filled volume (ellipsoidal, spherical cap, conical, torispherical dish / knuckle / full), inside area (spheroid, cap, cone, crown + knuckle torus) |
| `geometry/partialVolume.ts` | vertical (bottom head + cylinder + mirrored top head) and horizontal (circular segment x L + head volumes; conical heads by closed form) |
| `geometry/headOffset.ts` | constant-thickness head metal volume: ellipsoidal by 64-point Gauss-Legendre of both curves; spherical and torispherical by closed forms of the offset arcs (same centres); conical by the offset cone; flat = disc |
| `geometry/gaussLegendre.ts` | fixed-node quadrature (deterministic) |
| `commands/vesselVolume.ts` | query `vessel_volume` |

Differences from the plan above, all deliberate for M1:

- `vessel_volume` takes the vessel geometry inline (`orientation`, `insideDiameter`, `tangentLength`, `heads{first, second}`, `levels?`) instead of
  `equipment`: no equipment record exists before M2 (Q1 is open). M2 adds the `equipment` form and reuses these functions. Lengths are document
  units, volumes are m3 (`toMetres`), `side: shell | tube` comes with exchangers (M4).
- Types live in this package (`model.ts`), not in `@core/model/plantEquipment.ts` (plant README D2: core declares no domain data). No `doc.plant`
  member was added; `EquipmentElement` is untouched. `NozzleRecord`, `SupportSpec`, `EquipmentTemplate` arrive with the commands that use them (knip).
- `HeadSpec` torispherical is one object (`standard` or both radii), not two union members, so the JSON Schema stays a flat object for agents.
  A named standard is applied to the inside diameter you give (ASME F&D proportions refer to the outside diameter in the standard).
- Hemispherical resolves to a spherical cap of depth R; a conical head ignores `knuckleRadius` (not in `HeadSpec` yet); a flat head has depth 0.
- Horizontal torispherical heads have no closed form (V1): totals work, a partial level is refused `EQP_HEAD_NOT_COVERED` (levels.<i>). Vertical
  torispherical is complete (Jones, VC-EQP-01 rows J-VT-1..5).
- The conical-head metal volume (offset cone, plate thickness normal to the surface) is a named method, not gated by a published value.
- `headMetalVolume` is the "offset weights" building block (VC-EQP-09 head rows: 194.637 kg for SC-EQP-01 at rho 7850, thin-wall 191.459 kg is
  reproduced as the documented bias); `equipment_weights` itself is M3.

VCs: VC-EQP-01 (14 vertical Jones rows, 1e-9), VC-EQP-02 (7 MVP horizontal rows 1e-9; J-HT partial rows asserted refused, J-HT-3 full 1e-9),
VC-EQP-03 (depths, six D = 1 m full volumes, scaling), VC-EQP-04 (H-SA-1..3 at 1e-9, H-SA-4 grade B at 1e-6, torispherical area vs numerical
profile integral), VC-EQP-09 head rows (offset solid vs 1e5-segment trapezoid 1e-8, hemisphere closed form 1e-12). The scenario plans'
`vessel_volume` calls use the `equipment` form and stay blocked until M2 (entry removed from `blockedPlanCommands.json` only because the
command name now exists; the plans' `equipment` param is M2).
