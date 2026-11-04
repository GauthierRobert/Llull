# Gap 03 EQP — Parametric process equipment: technical specification

Companion of [FUNCTIONAL_SPEC.md](FUNCTIONAL_SPEC.md). Laws: `.claude/rules/architecture.md` (L1–L10). Agent-first
requirements: [`../../aerospace/AGENT_FIRST.md`](../../aerospace/AGENT_FIRST.md). Validation:
[validation/README.md](validation/README.md). Status: M1-M5 built (§13, §13.2, §13.3, §13.4, §13.5); the UI part of M5 is open (§13.5).

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
| `update_equipment_parameters` | mutating | `equipment`, `set{…vessel + common fields}` or `exchanger` / `tank` / `pump` patch | `changed[]`, `movedPorts[]`, `connectedPipes[]` | `EQP_NOT_FOUND`, `EQP_NOT_PARAMETRIC` (legacy box), template codes |
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

### 13.2 As built (M2 vessels and nozzles, 2026-10-23)

Code: `packages/domain-aec/src/plant/equipment/` (same plugin `plant-equipment`, toolset `plant_equipment`); tests `tests/unit/plant/equipment/{vessel,nozzles,column,regeneration,legacyConsumers,headProfile,scenarioPlans}.test.ts`
and the extended `vesselVolume.test.ts`; golden plan `plant_vertical_vessel` (SC-EQP-01 M2 actions, replay-equal); example `packages/design-lang/examples/plant_equipment.lld` (separator, 4 checks).

| Module | Content |
| ------ | ------- |
| `plantData.ts` | `PlantEquipmentData` (`EquipmentElement.plant?`, Q1 / D6), `VesselTemplate`, `BlockTemplate`, resolved `SupportSpec`, `NozzleRecord` (hardware resolved at add time), `VesselDesignData`. Pure types |
| `geometry/vesselFrame.ts` | head shapes in document units, datum (bottom tangent line / axis elevation), `headSurfaceHeight`, knuckle zone, `skirtRadii` |
| `geometry/vesselProfile.ts` | **`headProfileCurves(shape, radius, offset)`** (the one function to switch when the core `ellipse` segment lands, Q3), `vesselBand` (closed wall section of shell + both heads, exact `curves` + tessellated `profile`), `ringSection` |
| `geometry/ports.ts` | **`equipmentPorts(source: BuildingModel \| { building? }, element): ConnectionPort[]`**, `ConnectionPort`, `placeNozzle`, `toWorld` / `directionToWorld` |
| `geometry/nozzleChecks.ts` | `nozzleProblem` (refusals) and `nozzleWarnings` (knuckle, overlap) |
| `geometry/nozzleHardware.ts` | neck OD (EN 10220 series by DN), neck wall (B36.10 schedule 40 row, else 6 % OD, named), weld-neck flange OD / thickness from the 01 PSC catalogues (class: B16.5 incl. facing, PN: EN 1092-1), placeholder flagged otherwise |
| `geometry/legacyFields.ts` | `size` / `shape` / `weight` write-back (closed forms: shell annulus, exact offset heads, skirt, legs, Jones liquid) |
| `evaluate/evaluateVessel.ts`, `evaluate/evaluateNozzles.ts` | body = ONE revolution with exact `curves`, skirt / base ring, legs, saddle blocks, platform clips, one revolution per nozzle; hooked into `industrial/evaluate.ts` |
| `commands/*` | `add_vessel`, `add_process_column`, `add_nozzle`, `update_nozzle`, `delete_nozzle`, `equipment_ports`, `update_equipment_parameters`, `vessel_volume` (equipment form added, inline form kept) |

Differences from the plan above, all deliberate for M2:

- **`add_process_column`, not `add_column`**: `add_column` is the structural column of the building toolset. It composes `add_vessel` through `execute` (one recorded step).
- **Heads are stored `first` / `second`** (bottom / left, top / right) like `vessel_volume`; the commands take `heads { top, bottom }` or `{ left, right }`. `planRotationDeg` is not stored: it is `element.angle` (radians, counter-clockwise), converted with `angleConvention` (`north_cw`: positive turns clockwise; `east_ccw`: counter-clockwise). Stored nozzle angles are always `north_cw`; each result names the convention and reports the angle in it.
- **Skirt**: its inside diameter is the shell OUTSIDE diameter and the wall grows outward (the convention of the validation pack, VC-EQP-09: skirt mass 754.642 kg). `legs.legWidth` (square section, default 5 % of the shell OD) replaces `section`; `weightOverride` is not built.
- **Legacy fields**: vertical -> `vertical_vessel` `[D, D, top]` with D the widest of shell, skirt, base ring, legs; horizontal on the floor -> `horizontal_vessel`, raised on saddles -> `box` of the full height. Nozzles are NOT in the bounding box (they would make the plan circle meaningless); their reach is in the ports. `weight` = shell + heads + skirt + legs + operating liquid (saddle plates excluded, named in `notes`). `update_equipment` refuses a parametric vessel (use `update_equipment_parameters`).
- **Head profiles (Q3 switched)**: the ellipsoidal INSIDE profile is one exact `ellipse` quarter (`[rim, centre, apex]`, core segment merged from `feat/core-ellipse-segment`): the revolved inside head has the closed-form volume pi D^3 / 24 to 1e-9 (core `closedFormVolume` on the exact curves; OCC builds it exactly). The constant-thickness OUTER offset of an ellipse is not an ellipse, so it stays 12 cubic Hermite Béziers per quarter through exact offset points and tangents (error far below 1e-5 R, tested); the body volume matches the closed-form metal volume to 1e-4. Torispherical, spherical and conical profiles are exact arcs / lines; core samples arcs at 32 steps per turn, so arc-headed bodies tessellate 0.1 to 0.3 % light on Manifold. `headApexHeight` reads the outer apex from the profile (a conical offset moves the apex by t / sin(half-angle)).
- **Nozzle hardware** is resolved when the nozzle is added and stored in the record (`neckOutsideDiameter`, `neckWall`, `flange`), so evaluation needs no catalogue. EN 1092-1 PN16 rows have no thickness in the catalogue: the row OD is used, the thickness is 0.1 x neck OD, `unverified`. `EQP_FLANGE_PLACEHOLDER` is returned in `warnings` of `add_nozzle` / `update_nozzle` (the `check_equipment` finding is M3).
- **Load validation**: `building/validate.ts` calls `plantDataErrors` (`plant/equipment/validatePlant.ts`): schema id, template kind, vessel fields, support, nozzles (mark, DN, rating, facing, locations, flange) are checked, so a corrupt `plant` is rejected with a description and never reaches regeneration.
- **Free locations** (`{ on: 'free', position, direction }`) work on `add_equipment` blocks: the block gets `plant { template: { kind: 'block' }, nozzles }`, keeps its legacy geometry and fields, and gains the nozzle solids. Marks are unique per equipment, port id `<tag>:<mark>`.
- **`connectedPipes` / `EQP_PORT_CONNECTED`**: a pipe is "attached" to a port when its `from` or `to` equals the port id (the line-list reference). The 02 RTE `PortRef` kind `nozzle` is not built yet.
- **Trays** are data only (no geometry, internals); platform clips are partial revolutions on the shell (`depth` / `height` default 100 mm).
- **Saddles** are blocks under the shell (tangent at the bottom), not cradles.
- **02 RTE alignment**: the RTE plans (`sc-rte-01`, `-02`, `-05`) call `add_nozzle` with `equipmentId`, `tag`, flat `position` / `direction` and `endType`; D3 fixed `equipment`, `mark` and `location { on: 'free', position, direction }`. The RTE lane has to move its plans to the D3 form.

VCs: VC-EQP-12 (SC-EQP-01 N1, N2, N3, M1 and SC-EQP-02 N1, N2, N3, N4 positions 1e-6 / directions 1e-9; conventions; plan rotation; level elevation), VC-EQP-13 and 14 (geometry rows of SC-EQP-01 / 02 through the plan runner: totals, operating liquid, levels, ports; the code-check, weight-breakdown and data-sheet rows wait for M3 / M5), VC-EQP-19 (id, port ids, flange faces and 11.705574 m3 after `insideDiameter` 1800), VC-EQP-21 (20 trays 1500 / 12900, 30 trays refused), VC-EQP-09 body weights as the legacy `weight` (SC-EQP-01 operating 5262.0996 kg at 1e-9, SC-EQP-02 empty 6485.7311 kg). Codes raised: `EQP_NOT_FOUND`, `EQP_TAG_DUPLICATE`, `EQP_NOT_PARAMETRIC`, `EQP_PARAM_INVALID`, `EQP_HEAD_INVALID`, `EQP_SUPPORT_INVALID`, `EQP_TRAYS_DONT_FIT`, `EQP_NOZZLE_MARK_DUPLICATE`, `EQP_NOZZLE_NOT_FOUND`, `EQP_NOZZLE_OFF_BODY`, `EQP_NOZZLE_PROJECTION_TOO_SHORT`, `EQP_RATING_UNKNOWN`, `EQP_PORT_CONNECTED`, `EQP_LEVEL_OUT_OF_RANGE`, `EQP_HEAD_NOT_COVERED`; warnings `EQP_NOZZLE_IN_KNUCKLE`, `EQP_NOZZLE_OVERLAP`, `EQP_FLANGE_PLACEHOLDER`.

### 13.3 As built (M3 code checks, 2026-11-02)

Code: `packages/domain-aec/src/plant/equipment/` (same plugin `plant-equipment`, toolset `plant_equipment`); tests `tests/unit/plant/equipment/{asmeThickness,api650,weights,checkEquipment,guardrails}.test.ts`; the scenario-plan runner now also runs the
`vessel_thickness`, `equipment_weights` and `check_equipment` rows of SC-EQP-01 / 02 (`tests/unit/contract/blockedPlanCommands.json` shrank accordingly).

| Module | Content |
| ------ | ------- |
| `codecheck/units.ts` | pressure (MPa, kPa, bar, psi) and stress (MPa, psi) to MPa; 1 psi = 6894.757293168 Pa |
| `codecheck/asme.ts` | pure UG-27(c)(1) / (c)(2), UG-32 (2:1 ellipsoidal, ASME F&D torispherical, hemispherical), P <= 0.385 S E and t <= R/2 gates, UG-99(b) ratio, static head; one outcome per part (a part outside the formulas refuses only itself) |
| `codecheck/api650.ts`, `data/api650Tables.ts` | one-foot method per course; Table 5-2a rows (A283M Gr C 137/154, A36M 160/171, A516M Gr 485 = A516-70 173/195 MPa, grade A) and the minimum-thickness rows (D < 15 m: 5 mm B, 15..36: 6 mm B, 36..60: 8 mm C) |
| `codecheck/checkVessel.ts` | findings of `check_equipment` for one vessel: thickness / MAWP fails, uncovered parts, nozzle layout, unverified / unsourced inputs, placeholder flanges |
| `geometry/vesselMass.ts`, `geometry/nozzleMass.ts` | the mass parts (shell annulus, exact offset-solid heads, skirt, base ring, legs, nozzle neck + flange); `legacyFields` now reads `vesselMass`, so `body.operatingKg` and the element `weight` are one number |
| `commands/vesselThickness.ts`, `tankShellThickness.ts`, `equipmentWeights.ts`, `checkEquipment.ts` | the four read-only queries (`readOnly`, `idempotent`) |

Decisions (all deliberate for M3):

- **`tank_shell_thickness` takes the tank inline** (`diameter`, `shellHeight`, `courses`, `designLiquidLevel`, `specificGravity`, `material`, `corrosionAllowance`, optional `allowableStress { design, test, source }`), like `vessel_volume` in M1: `add_storage_tank` is M4. The pure `oneFootCourses` is what M4 reuses for the `equipment` form and for the tank rows of `check_equipment`; `EQP_COURSES_MISMATCH` is raised here already. `overrideDiameterM` of the SC-EQP-04 step 5 is not built (the inline `diameter` does the same job).
- **Q6 (API 650 minimum thickness): the shipped table is the edition target** (5 / 6 / 8 mm by D, rows B / B / C). Every result that falls on one of these rows reports `minimumThickness.unverified: true` and the warning `EQP_TABLE_UNVERIFIED`; the PPNS article's 6 mm at D = 7.7 m is not used (the design thickness 5.44 mm governs in the VC either way). A licensed table replaces the rows through the 01 PSC import path (Q5, later).
- **Refusal versus finding.** The queries refuse (coded, with paths, document unchanged). `check_equipment` never refuses: a part the formulas do not cover (`EQP_HEAD_NOT_COVERED`, `EQP_FORMULA_OUT_OF_RANGE`, `EQP_DESIGN_DATA_MISSING`, `EQP_ALLOWABLE_MISSING`) is a **warning** of that part and the other parts are still judged; an explicitly listed legacy / non-vessel element is a **warning** `EQP_NOT_PARAMETRIC` (not checked, `checked` omits it; the all-equipment scan skips such elements quietly); an unknown reference is a **fail** `EQP_NOT_FOUND` (a check that could not run never reads as a pass). Fails are only computed under-thickness / MAWP below design.
- **Component keys** of `vessel_thickness`: `shell`, then `headBottom` / `headTop` (vertical) or `headLeft` / `headRight` (horizontal), matching `heads.first` / `heads.second`. `requiredThicknessMm` includes the corrosion allowance (§5.5 table); `availableThicknessMm` is nominal minus CA; the pass test is `available >= requiredCorrodedThicknessMm` (corroded, without CA), which is the plan's `t_avail 12 - 3 = 9 < t_req - CA`. Float noise is not a failure (1e-9 relative).
- **Torispherical heads** are covered only for ASME F&D proportions (knuckle = 6 % of the crown radius within 1e-6, crown radius <= D): the 0.885 formula is the M = 1.77 case. DIN 28011 / 28013, ASME 80/10 and 80/6 and free radii are `EQP_HEAD_NOT_COVERED` (the general M = 0.25 (3 + sqrt(L/r)) of Appendix 1-4(d) is V1). 2:1 only for ellipsoidal heads (ratio exactly 2 within 1e-9); flat and conical heads are not covered. Review round 1: UG-32(e) is gated at t/L >= 0.002 (available thickness over the corroded crown radius; below it App. 1-4(f) / UG-33 apply: `EQP_HEAD_NOT_COVERED`). A hemispherical head is `EQP_FORMULA_OUT_OF_RANGE` (path `heads.first` / `heads.second`) when t > 0.356 L and P > 0.665 S E (UG-32(f) valid if either holds, t = required thickness). Heads are not gated by 0.385 S E: beyond the shell limit the shell is the warning and the heads are still judged. UG-27 applicability is judged on the REQUIRED thickness (P <= 0.385 S E, required t <= R/2); a shell whose available thickness exceeds R/2 is not refused: its MAWP is reported with `mawpUnverified: true`, is excluded from the governing MAWP and from `EQP_MAWP_BELOW_DESIGN`.
- **Hydrotest** `1.3 x MAWP x S_test/S_design`, ratio 1 and `stressRatioDefaulted: true` without `design.allowableStressAtTest`. `staticHeadMPa` = SG x 1000 x g x column (liquid level plus the bottom-head depth for a vertical vessel) is reported, never added to the MAWP.
- **`equipment_weights`**: `include` is `body` (default) and/or `nozzles`. `insulation` and `internals` are rejected by the schema (nothing models them; trays are data only), and `notIncluded` lists what is not weighed. Test water 1000 kg/m3 and the steel density default are named in `defaulted`. Nozzles: neck annulus beyond the outside wall (head nozzles use the inside surface height at the radial offset plus the head thickness) plus the flange as a bored disc (catalogue OD and thickness; hub and bolt holes are not deducted); `total` = body + requested parts, `body` never includes nozzles. With no operating liquid, or a horizontal torispherical head at a partial level, `operatingKg` equals `emptyKg` and `warnings` carries `EQP_DESIGN_DATA_MISSING` / `EQP_HEAD_NOT_COVERED`.
- **`EQP_NOZZLE_IN_SUPPORT`** is geometric: a bottom-head nozzle of a skirted vessel whose offset plus flange radius reaches the skirt wall, or a shell nozzle within 60 degrees of the bottom of a horizontal vessel and within half a saddle width plus its flange radius of a saddle station (the 120 degree saddle contact is a named assumption). There are no skirt openings in the model yet (V1).
- `EQP_VALUE_UNSOURCED` is raised for the allowable stress only (the safety value the schema lets the user type without a source); pressures and efficiencies carry no obligation. A head standard below grade A raises `EQP_TABLE_UNVERIFIED` in `check_equipment` (only grade A proportions are covered by the formulas, so this never reaches `vessel_thickness`).

VCs (all against the committed references of `validation/data/`, none produced by llull): VC-EQP-05 (UG27-A 0.16008537886872998 in, UG27-B 0.39899289099526064 in, UG27-C 0.5784005037783375 in with `corrodedDimensions:false`; 1e-9 vs the derivation, published values within their printed rounding), VC-EQP-06 (UG32E-A with the uncorroded diameter, as the checalc source does, 0.5755632040050063 in; UG32E-B 1.4916994145480793 in; UG32T-A 0.05312656328164082 in; UG32T-B 0.017708854427213608 in; 1e-9), VC-EQP-07 (limit 0.385 S E = 53.0915 MPa, 60 MPa refused with `design.pressure`, `EQP_ALLOWABLE_MISSING` with `design.allowableStress`, MAWP round trip 1e-12), VC-EQP-08 (PPNS t_d 5.440194635036496 mm, t_t 2.4255 mm at 1e-9, the three Sd / St rows exact, SC-EQP-04 rows 8.66625 / 6.705263157894736 / 6.21625 / 6.0), VC-EQP-09 (SC-EQP-01 2633.4701290833223 / 5262.099607204157 / 10585.626533482486 kg and SC-EQP-02 6485.731147911467 / 27429.682171843422 kg at 1e-6, measured relative error about 1e-11; legs case 471.0 kg), VC-EQP-16 (reviewRequired with the standard named, unverified propagation, determinism of the M3 queries, the error table of §7 parsed from this file: every code but the three M4 ones has a remediation, the M3 codes are reached with paths), plus the plan rows of SC-EQP-01 / 02 steps 7, 8 and 10 (`status: warn`: flange findings) and SC-EQP-02 step 12 (`fail`).

Open after M3 (the M4 items are closed in §13.4): `equipment_datasheet` and the data-sheet row of the plans (M5); general torispherical M factor, nozzle reinforcement (UG-37), insulation / internals weights, centre of gravity (V1); variable-design-point method for D > 60 m (V2).

### 13.4 As built (M4 exchangers, tanks, pumps, 2026-11-02)

Code: `packages/domain-aec/src/plant/equipment/` (same plugin `plant-equipment`, toolset `plant_equipment`); tests `tests/unit/plant/equipment/{exchanger,tank,pumps,otherTemplates,guardrails,scenarioPlans}.test.ts`; the scenario-plan runner now runs SC-EQP-03 and SC-EQP-04 (their entries left `tests/unit/contract/blockedPlanCommands.json`).

| Module | Content |
| ------ | ------- |
| `plantData.ts` | `ExchangerTemplate`, `TankTemplate`, `PumpTemplate` join the template union; nozzle location `{ on: 'channel', channel, station, orientationDeg }` |
| `data/temaTables.ts`, `codecheck/tema.ts` | TEMA letters (grade A), BWG walls (grade B); `parseTema` (EQP_TEMA_INVALID / EQP_TEMA_UNSUPPORTED with `temaType.<i>` paths; K, X, D parse and then refuse) |
| `data/pumpEnvelopes.ts` | ISO 2858 rows (4 usable grade A rows + the incomplete 50-32-125) and ASME B73.1 rows (grade B) |
| `geometry/exchangerFrame.ts`, `exchangerMass.ts` | axial layout, volumes, placement of shell and channel nozzles, masses |
| `geometry/tankFrame.ts`, `tankMass.ts` | courses, roof rise, liquid volume, shell placement, masses |
| `geometry/pumpLayout.ts` | envelope boxes and the suction / discharge face positions |
| `geometry/legacyOthers.ts` | legacy `size` / `shape` / `weight` of the three kinds (`legacyFields` dispatches) |
| `codecheck/tankShell.ts` | the one-foot computation, shared by `tank_shell_thickness`, `add_storage_tank` (derived thicknesses) and `check_equipment` |
| `codecheck/checkExchanger.ts`, `checkTank.ts`, `checkPump.ts`, `nozzleFindings.ts`, `findings.ts` | the findings of `check_equipment` per kind |
| `evaluate/evaluateExchanger.ts`, `evaluateTank.ts`, `evaluatePump.ts`, `evaluateEquipment.ts`, `revolutionPart.ts` | derived solids (exact head sections through the new `headBand`), dispatch from `industrial/evaluate.ts` |
| `commands/addHeatExchanger.ts`, `addStorageTank.ts`, `addPump.ts` (+ `exchangerParams`, `tankParams`, `pumpParams`, `newEquipment`) | the three mutating commands |
| `commands/otherVolumes.ts`, `otherWeights.ts` | the exchanger / tank forms of `vessel_volume` and the exchanger / tank / pump forms of `equipment_weights` |

Decisions (all deliberate for M4):

- **Exchangers are horizontal only** (`orientation` is the literal `horizontal`; vertical exchangers are V1). The frame origin is the middle of the OUTSIDE overall length on the tube axis, so the legacy plan box is centred on `location`. Shell stations count from the front end of the shell; channel stations from the tubesheet face outward (`channel: 'rear'` exists for the fixed-tubesheet rears L, M, N only). `tubes.length` is measured between the OUTER tubesheet faces (the oracle: shell length 4777 = 4877 - 2 x 50), so the shell is `length - 2 x tubesheet` (fixed) or `length - tubesheet` (U / floating).
- **TEMA support.** Fronts A, B, C, N (B = bonnet = channel + 2:1 head, the others = channel + flat cover), shells E, F, G, H, J (geometry of E: the longitudinal baffle and the nozzle counts of F / G / H / J are not modelled), rears L, M, N (second tubesheet + rear channel, M = bonnet), U, P, S, T, W (the shell is closed by a 2:1 shell cover; the floating head, floating tubesheet and U-bend are not modelled and are listed in `assumptions` / `notIncluded`). D, K, X are valid letters that refuse with EQP_TEMA_UNSUPPORTED (the parse of AKT still returns the designation, VC-EQP-11). `rearChannel` for a non-fixed rear is EQP_PARAM_INVALID; for a fixed rear it defaults to the front channel (named). A call with a wrong TEMA type AND missing required fields is stopped by the schema first (`CMD_INVALID_PARAMS`): step 9 of SC-EQP-03 was completed with `shellThickness`, `tubesheetThickness` and `frontChannel` so the plan tests the TEMA refusal alone (the oracle code and path are unchanged).
- **Channel thickness default.** Not given -> the shell thickness, named in `defaulted`, and `check_equipment` warns EQP_DESIGN_DATA_MISSING at `frontChannel.thickness` (the plan row "warnings: channel thickness").
- **Tube wall.** `wallThickness` or `bwg` (12, 14, 16, 18 for 3/4 in and 1 in tubes; grade B table, so `unverified` everywhere the exchanger reports). Tubes must fit: `count x cell <= pi/4 Ds^2` with cell = 0.866 pitch^2 (30 / 60 deg) or pitch^2 (45 / 90 deg), pitch > OD; both refuse as EQP_PARAM_INVALID.
- **Volumes** (`vessel_volume { equipment }`): shell side = (pi/4 Ds^2 - N pi/4 do^2) Ls (+ the 2:1 shell cover of a U / floating rear), tube side = N pi/4 di^2 Lt + the channels and bonnets; both are always returned, `side` selects `totalVolumeM3`, `levels` are refused for exchangers (the bundle displaces the shell side). Also `insideOverallLength` (and `insideOverallLengthMm`, the plan row).
- **Exchanger weights.** Shell, channel annuli, exact offset bonnets / shell cover, flat covers (disc of the OUTSIDE radius, as drawn: pi (R + t)^2 t), tubesheets as gross discs minus the tube holes, tube metal; operating = empty + each side full at its `specificGravity` (a side without one adds nothing and warns EQP_DESIGN_DATA_MISSING); test = empty + both sides of water.
- **Exchanger checks.** The shell (and the shell cover) is judged against `design.shellSide`, each channel and bonnet against `design.tubeSide`, by running `asmeThickness` on an equivalent horizontal cylinder; a side without design data, without S / E, or out of range (P > 0.385 S E ...) is a WARNING of that side (never a pass); flat covers are EQP_HEAD_NOT_COVERED; fails only for computed under-thickness / MAWP. `reviewRequired` is ALWAYS true for exchangers and tanks (the plan row, AF-33): their tubesheets, tubes, covers, roof and supports are never judged, and each `checked[]` row lists that in `notChecked` (pumps too: `reviewRequired` true with the reason "hydraulics, casing pressure rating and nozzle loads are not judged", so a clean pump is `pass_with_review`, never `pass`). A nozzle over a saddle is not checked for exchangers (listed in `notChecked`; the vessel finding EQP_NOZZLE_IN_SUPPORT is not extended). The bundle-pull length (`tubes.length + 1 m`, named default) is returned by `add_heat_exchanger` but NOT yet exported as a directional clearance zone to `check_clashes` (the model has only a scalar clearance).
- **Tanks.** `diameter` is the nominal INSIDE diameter, the wall grows outward by the course thickness; levels (and nozzle elevations) count from the top of the bottom plate. Without `courseThicknesses` each course takes its one-foot governing thickness (`thicknessSource` `one_foot`, or `minimum` when every course is on the minimum row), which needs a Table 5-2a material or `design.allowableStress` and D <= 60 m (EQP_MATERIAL_NOT_IN_TABLE / EQP_API650_ONE_FOOT_LIMIT, with a hint to give the thicknesses). With given thicknesses a tank above 60 m or outside the table is built and `check_equipment` warns instead of judging. `check_equipment` fails EQP_SHELL_UNDER_THICKNESS (path `courseThicknesses.<i>`) only for USER thicknesses below the governing value; derived thicknesses warn EQP_DESIGN_DATA_MISSING ("not an input"), and the grade B minimum row warns EQP_TABLE_UNVERIFIED (SC-EQP-04 step 4). Roof 5 mm and bottom 6 mm (API 650 minimum plate thicknesses, public extracts) are named defaults; cone `slopeRatio` is "rise:run" or a number in (0, 1], a dome needs `radius > eave + thickness`; `bottom.annularPlate` is stored only; only a flat bottom exists; the roof is a thin plate (area x thickness). Liquid mass uses the design level; the test case fills the shell with water.
- **`tank_shell_thickness`** takes `equipment` OR the inline tank (all inline fields are optional in the schema and required together in the command; EQP_PARAM_INVALID names the first missing one). `overrideDiameterM` (SC-EQP-04 step 5) is a what-if diameter in METRES whatever the document unit, equipment form only; the document is unchanged. The pure `tankShellResult` replaced the body of the M3 command (same numbers; the refusal messages lost the duplicated command prefix).
- **Pumps.** ISO 2858 rows 50-32-160, 50-32-200, 65-40-250, 80-50-200 (grade A) are used silently; 50-32-125 is in the table but incomplete (a, f not legible) and refuses EQP_PUMP_SIZE_UNKNOWN like any other size; B73.1 rows AA, AB, A05, A60 are grade B (`unverified`), their CP is split `a = f = CP / 2` because the row carries no suction offset (a named default, Q4 stays open), suction / discharge DN come from the inch sizes (1.5 in -> DN40). A vendor `envelope { a, f, h1, h2, suctionDn, dischargeDn, source }` replaces the table: with a `source` it is grade A (the user's own sourced number), without one it is grade B, `source` is "user input" (named default), the pump is `unverified` and `check_equipment` warns EQP_VALUE_UNSOURCED at `envelope.source`. Ports are two ordinary nozzle records with free locations: `<tag>:SUC` (axial toward -X) and `<tag>:DIS` (vertical), rating default PN16 (ISO) / CL150 (B73.1) / required for custom. The body is an ENVELOPE box (width h2, top = shaft + h2 / 2), the driver follows after `couplingGap` (default 100 mm), the baseplate is centred under both (default machine span + 100 mm each side, 150 mm high); the `driver` / `baseplate` defaults and the missing `weightKg` (the standards give none: weight 0, `equipment_weights` refuses EQP_DESIGN_DATA_MISSING at `weightKg`) are checked as warnings. `api610Type` (OH1..OH6, BB1..BB5, VS1..VS7) is stored for the data sheet.
- **Generic commands.** `add_nozzle` / `update_nozzle` / `delete_nozzle` / `equipment_ports` / `equipment_weights include nozzles` / `vessel_volume` / `check_equipment` work on the three kinds (exchanger: shell by station or channel; tank: shell by elevation, roof as a free location; pump: free). `update_equipment` refuses the new kinds with EQP_NOT_PARAMETRIC (`update_equipment_parameters` revises them in place since EQP-FU, §13.6) and a message naming the kind: they are recreated (in-place revision of exchangers, tanks and pumps is not built). `industrial/evaluate.ts` and `industrial/equipment/equipmentUpdate.ts` (outside `plant/equipment/`, same package) dispatch on `template.kind !== 'block'`. Load-time validation (`validatePlant`, `validateTemplates`) knows the three kinds and the channel location and checks every field the checks and masses read (`defaulted`, TEMA letters, tube layout / wall source, both exchanger sides' design data, tank design with corrosion allowance, allowable stress and `thicknessSource`, pump envelope rating / grade / source, weight); the template kind is looked up in a Map, so keys such as `constructor` or `__proto__` are refused, not dispatched. `tankShellResult` also refuses (EQP_PARAM_INVALID) a missing or non-finite dimension, gravity, corrosion allowance or stress instead of computing with it. `temaType` is limited to 16 characters and `slopeRatio` to 32. A nozzle location that does not suit its equipment (head on an exchanger / tank, channel on a vessel, shell on a pump) is EQP_PARAM_INVALID at `location.on`.

VCs (references from `validation/data/` or closed forms re-derived in the test, none produced by llull): VC-EQP-10 (every shipped ISO row against `pump_envelopes.json`, the B73.1 rows converted, unverified / unknown / incomplete sizes, port positions), VC-EQP-11 (the six designation cases of `tema_designations.json`, AKT parses and refuses as unsupported), VC-EQP-15 (SC-EQP-03: shell side 0.9421985298921338 and tube side 0.5111748822078709 m3 at 1e-9, inside overall length 5777 mm, T1 direction [0, 0, -1], `warn` with no fail, `reviewRequired`, BXZ refused at `temaType.2`), VC-EQP-17 and VC-EQP-08 (SC-EQP-04: course thicknesses 8.66625 / 6.705263157894736 / 6.21625 / 6.0, unverified minimum row, level volume 3769.9111843077517 m3, `overrideDiameterM` 65 refused), VC-EQP-16 (every code of the error table has a remediation and is reached with its paths; unverified and `notChecked` propagation; determinism of the M4 queries).

Open after M4 (`equipment_datasheet` and the data-sheet rows are closed in §13.5, the in-place revision of exchangers, tanks and pumps in §13.6): vertical exchangers, kettle / cross-flow shells, front D, tube layout drawing and span check (VC-EQP-18), tubesheet / cover design (TEMA RCB, UG-34), floating head and U-bend geometry, a bundle-pull clearance zone in `check_clashes`; tank roof / bottom / annular plate checks, cone-up / cone-down bottoms, variable-design-point method for D > 60 m (V2), wind / seismic (V2); pump weights, casing model, the B73.1 suction offset and the ISO a / f meanings (Q4), nozzle loads (07 PST).

### 13.5 As built (M5 interop and review, the non-UI part, 2026-11-02)

Code: `packages/domain-aec/src/plant/equipment/` (same plugin `plant-equipment`, toolset `plant_equipment`) plus the IFC and plan hooks in `packages/domain-aec/src/building/{exchange,drawings}/`, and the guide section in `packages/protocol/src/conventions.ts`; tests `tests/unit/plant/equipment/{datasheet,ifcEquipment,planStubs,scenarioPlans}.test.ts` and `tests/unit/conventions.test.ts`; the SC-EQP-01 data-sheet row left `tests/unit/contract/blockedPlanCommands.json` and runs in `scenarioPlans.test.ts` (step 11: 4 nozzles, `weights.body.emptyKg` = the `equipment_weights` number, `review.reviewRequired`).

| Module | Content |
| ------ | ------- |
| `commands/equipmentDatasheet.ts` | query `equipment_datasheet` (`equipment`, `format` json / csv, `table` items / nozzles for csv, `angleConvention`) |
| `datasheet/record.ts` | `buildDatasheet`: the record `llull-equipment-datasheet/1`, every number from the registered queries composed through `execute` |
| `datasheet/designGeometry.ts`, `nozzleSchedule.ts`, `millimetres.ts` | design and geometry sections, the nozzle rows, the document-unit to millimetre key conversion |
| `datasheet/csv.ts` | `items` (section, item, value, unit, source) and `nozzles` tables, guarded with the 01 PSC `csvGuard` |
| `geometry/planStubs.ts` | plan stubs of the nozzles (hooked in `building/drawings/planIndustrial.ts`) |
| `building/exchange/ifcEquipmentExport.ts` | revolved bodies, ports, `Pset_llullEquipment` additions (hooked in `ifcBuild.ts`, `ifcIndustrialExport.ts`, `ifcPorts.ts`, `ifcPipingExport.ts`) |

Decisions (all deliberate for M5):

- **The data sheet composes the queries** (`vessel_volume`, `equipment_weights`, `vessel_thickness` / `tank_shell_thickness`, `check_equipment`, `equipment_ports`) instead of recomputing: the sheet cannot disagree with the model. `data` carries the sections at its top level (`identification`, `design`, `geometry`, `nozzles[]`, `volumes`, `weights`, `codeResults{check, thickness}`, `provenance`, `review`, `warnings`) plus `format`, `fileName`, `text` (the file, for `--save`), `sha256` (over the UTF-8 bytes), `bytes` (UTF-8 length). For json `text` repeats the record (it is the file for `--save`).
- **Lengths in millimetres** whatever the document unit (key suffix `Mm`), volumes m3, masses kg, stresses and pressures MPa, angles degrees (`provenance.units`, `provenance.documentUnits`); a sheet goes to a vendor, not back into a document. The conversion is a key list (`datasheet/millimetres.ts`), so a new length field must be added there. Two contract tests guard it (review round 1): `datasheetUnits.test.ts` builds every template kind (skirt separator, saddle drum, legs vessel, column with trays and clips, exchanger, tank, pump with driver) in mm, m and in with scaled inputs and requires the whole sheet to be equal within 1e-6 relative (text compared with its numbers masked: messages quote document units), and a structural test requires every numeric leaf of the stored template and nozzles to be a converted length key or a declared non-length key.
- **A section never disappears.** A query that refuses (thickness without design data, weights of a pump without `weightKg`) is `{ available: false, reason: 'refused', code, message, paths }`; a section that does not apply (a pump volume, the thickness of an exchanger or pump, judged inside `check_equipment`) is `{ available: false, reason: 'not_applicable', message }`; a nozzle with no placeable port keeps its row (null position and direction) and adds a `warnings` entry `EQP_PARAM_INVALID` at `nozzles.<mark>`. `design.missing` lists the design inputs that were not given (never defaulted).
- **Review.** `review` = `{ status: 'not_reviewed', reviewRequired: true (always), reasons, unverified (a weight, thickness, flange row or pump envelope below grade A), defaulted (named defaults of the template and of the weights) }`. `status` stays `not_reviewed`: the approval is a 09 PLM signature, not built here. Per-value grade is not a column: the grade-bearing facts are `geometry.envelope.grade`, the flange `unverified` / `placeholder` columns of the nozzle table, `review.unverified` and `review.defaulted`.
- **Only parametric equipment has a sheet.** Legacy footprint equipment and nozzle-only blocks are `EQP_NOT_PARAMETRIC` (no template to describe). Columns are vessels.
- **CSV** has two tables because one CSV cannot hold both shapes: `items` (default) flattens every value of every section except the nozzle schedule (`section,item,value,unit,source`; the unit comes from anchored camelCase key suffixes Mm, Kg, KgM3, M3, M2, MPa, Deg and a short list of exact keys, never from a text value, `source` from the stored quantity), `nozzles` is the schedule with one column per position / direction component and the flange columns. Text cells starting with `= + - @`, a tab or a carriage return get a leading apostrophe (the 01 PSC guard); numbers are never touched. Output is canonical JSON (sorted keys) or fixed-order CSV: byte-identical for the same document.
- **IFC bodies** (VC-EQP-20, FR-EQP-18): the derived entities of the template (the same ones the viewport and STEP use) are written as one `IfcRevolvedAreaSolid` per revolution (shell + heads wall section, skirt, base ring, nozzle neck + flange, platform clips) and one `IfcExtrudedAreaSolid` over a centred rectangle per box (legs, saddles, pump envelope boxes) in the frame of the product placement (plan location, plan angle), replacing the extruded circle of the footprint solid. The profile is an `IfcIndexedPolyCurve`: lines and circular arcs are exact (`IfcLineIndex`, `IfcArcIndex`, so torispherical and hemispherical heads are exact); the ellipsoidal head offset and the Bézier pieces are **sampled polylines** (64 chords per ellipse quarter, 4 per Bézier piece) because the IFC indexed poly curve has no elliptic arc. Tolerance: chord sagitta <= 7.7e-5 x the larger semi-axis on an ellipse quarter (64 chords: 0.06 mm on a 750 mm head) and <= 1.4e-4 x the local radius on a Bézier offset piece (4 chords per 7.5 degrees); the chords lie inside the inside surface, so the wall volume reads slightly high/low by about sagitta / wall x the head share. It is stated in the `BodyRepresentation` property of every equipment, and measured on SC-EQP-01 (the profile Pappus volume is within 1e-3 of the metal volume of `equipment_weights`). IFC4 and IFC4X3_ADD2 differ only in the `IfcCartesianPointList2D` attribute count. An entity with no IFC solid is the export warning `EQP_IFC_PART_SKIPPED` (none today), never omitted silently. Legacy equipment and blocks keep the footprint solid.
- **IFC ports**: one `IfcDistributionPort` per nozzle (name = mark, description `<tag>:<mark> DN<dn> <rating> <facing> <service>`, placement Z = the outward direction at the flange face centre, `Pset_DistributionPortTypePipe.NominalDiameter`, `Pset_llullNozzle` with port id, rating, facing, service), nested in the product with `IfcRelNests`. FlowDirection is read from the service text (inlet / feed / suction / charge / make-up = SINK; outlet / discharge / product / draw / bottoms / overhead / drain / vent / take-off = SOURCE; both or neither = SOURCEANDSINK); a pump's `SUC` is SINK and `DIS` SOURCE. Ports are written for every equipment with nozzles (blocks included), in IFC4 and IFC4X3_ADD2; `plant.ports: false` removes the equipment ports in both schemas. Port placements are storey-relative like the pipe ports. Equipment with its own nozzles keeps getting no line-end inferred ports of 08 DAT (unchanged rule).
- **Piping connections**: a spec-driven run whose start or end is a `PortRef` of kind `nozzle` gets one `IfcRelConnectsPorts` (RelatingPort = the nozzle port) to the port of its part that meets the flange face (within 0.5 mm; none found = the nozzle port stays open and counts in `openPorts`). The relation is counted in `piping.connectionCount`. Legacy pipes (`from` / `to` tags) are connected by the 08 DAT inference as before.
- `Pset_llullEquipment` gains `Template`, `Orientation`, `DesignPressure` (Pa), `DesignTemperature` (K), `Material`, `EmptyWeight`, `TestWeight` (the `equipment_weights` body numbers) and `BodyRepresentation`. The typed class stays the 08 DAT mapping (PressureVessel = IfcTank PRESSUREVESSEL, spelling confirmed by the mapping module and the export test); unclassified equipment is an `IfcBuildingElementProxy`, as before.
- **Plan stubs**: each nozzle draws its neck line (wall to flange face), a flange line across the face and the mark text; a nozzle that points up or down (head nozzles, top nozzles of a horizontal vessel) is the flange circle and the neck circle at its plan position with the mark beside it. Same `placeNozzle` positions as the 3D ports, turned by the plan rotation; layer Q-EQPM; all nozzles are drawn (no cut-plane filter); every plan consumer (`render_view` plan, DXF, sheets) shows them. The nozzle orientation view (FR-EQP-22) stays V1.
- **`llull guide`** section 17 "Plant equipment" (units, angle convention, port ids, the SC-EQP-01 plan, data sheet, IFC, review); a unit test checks that it names only registered commands.

VCs: VC-EQP-20 (SC-EQP-01 classified PressureVessel: 1 IfcTank PRESSUREVESSEL, 4 IfcDistributionPort named N1 N2 N3 M1 at the 3D face centres [5000, 6000, 5200], [5000, 5000, 1400], [5000, 5000, 6700], [5000, 4000, 3000] with Z along the direction, FlowDirection SINK / SOURCE / SOURCE / SOURCEANDSINK, nested in the tank; 6 revolved solids; the SC-RTE-01 pipes meet the nozzle ports of the pump block and the vessel), VC-EQP-13 data-sheet row (SC-EQP-01 step 11 through the plan runner), VC-EQP-16 (determinism, unverified and review flags of the sheet), VC-EQP-04 inside areas (SC-EQP-01 23.727489942 m2).

**As built (EQP-M5-UI).** The **port glyph** is `src/ui/viewport/3d/ports/PortGlyphOverlay.tsx`: one arrow per nozzle at the flange face centre pointing away from the equipment, from the read-only query `equipment_ports` (run through `runQuery`, recomputed on document change, not on selection; no axis swap, the scene is Z-up like the document); the pure helper `portGlyphs.ts` parses the answer, sizes the arrow from the DN (min 120 mm) and gives the +Y to direction quaternion (`tests/unit/portGlyphs.test.ts`). The **data-sheet section** is `src/ui/panels/building/EquipmentDatasheetSection.tsx` in the building-element inspector of a selected equipment: it runs `equipment_datasheet` and shows the `reviewRequired` badge with the reasons, review status, check status and issues, MAWP, unavailable sections and the nozzle schedule (`datasheetView.ts` parses `data.review`, `data.codeResults`, `data.nozzles`); its checkbox drives the overlay through `usePortGlyphStore` (UI-only, like the other overlay switches). Read-only, no new command (`tests/component/EquipmentDatasheetSection.test.tsx`). Open after M5: the 09 PLM signature behind `review.status`; the `.sheet` table of the data sheet (`create_sheet`, V1); typed IFC beyond the 08 DAT class mapping and IFC 4.3 property-set mapping (08 DAT); per-value grade columns; the nozzle orientation view (FR-EQP-22); outside-surface take-off areas (the offset head areas have no closed form here).

### 13.6 As built (EQP-FU follow-up, 2026-11-04)

**EQP-FU-1: `update_equipment_parameters` for exchangers, tanks and pumps.** Code: `commands/updateEquipmentParameters.ts` (dispatch, shared tail), `commands/reviseEquipment.ts` (patch schemas and the three merge functions); tests `tests/unit/plant/equipment/reviseEquipment.test.ts` (plus the golden plan `plant_equipment_revise_exchanger_tank_pump`).

- **Shape.** `set` (now optional) keeps the vessel fields and the common ones (`name`, `location`, `planRotationDeg`, `clearance`); an exchanger, tank or pump takes a sibling patch object `exchanger` / `tank` / `pump` holding the fields of its `add_*` command, all optional, nested objects merging field by field (`tubes`, `frontChannel`, `design.shellSide`, `roof`, `bottom`, `envelope`, `driver`, `baseplate`). A patch of another kind, or a vessel field in `set` for a non-vessel, is EQP_PARAM_INVALID (paths `exchanger`, `set.<field>`); a legacy block stays EQP_NOT_PARAMETRIC.
- **One validation path.** The merged input goes through the creation builder of the kind (`buildExchangerTemplate`, `buildTankTemplate`, `buildPumpTemplate`), so every creation refusal applies with its path prefixed by the kind (`exchanger.tubes.count`, `tank.courses`, `pump.size`). Every nozzle is then re-validated (`nozzleProblem`: off body, projection too short): one failure refuses the whole edit.
- **What is kept.** Element id, tag, nozzle marks and port ids; the resolved support; the BWG wall provenance (`wallSource`, `wallUnverified`) unless the patch sets OD, wall or gauge; thicknesses the user gave (`thicknessSource: user`) while the one-foot thicknesses are derived again from the new shape (`one_foot` / `minimum`); a vendor envelope with its source and grade; named defaults stay in `defaulted` unless the patch sets that field.
- **Nozzles.** Shell nozzles of exchangers and tanks keep their projection from the axis (faces do not move when the diameter changes); exchanger stations count from the front end of the shell, so a longer tube bundle moves every port by half the change (the origin is the middle of the overall length). A pump re-places its SUC / DIS records on the new envelope (record, facing, service and hardware kept when DN and rating are unchanged, rebuilt otherwise); extra free nozzles stay in place. `driver: null` removes the pump driver; a default baseplate is derived again when the machine length changes.
- **Routes.** `movedPorts` and `connectedPipes` are reported as for vessels, and the piping reconcile stretches the connected runs exactly as for a moved vessel (checked on a custom pump routed to a vessel: the run start follows the moved DIS port).
- **Left.** Roof nozzles (free location) do not follow a changed roof; `temaType` can change but the nozzle layout is only re-validated, not re-proposed.

**EQP-FU-2: code-check depth (vessels).** Code: `codecheck/reinforcement.ts`, `commands/nozzleReinforcement.ts`, `geometry/headCentroid.ts`, `geometry/vesselCog.ts`, `commands/equipmentCog.ts`, the insulation / internals parts of `geometry/vesselMass.ts`, the general torispherical branch of `codecheck/asme.ts`; tests `tests/unit/plant/equipment/{nozzleReinforcement,vesselCog,asmeThickness}.test.ts`.

| Command / field | Content |
| --------------- | ------- |
| `nozzle_reinforcement` (query) | UG-37 area replacement per shell / head nozzle: A = d t_r F + 2 t_n t_r F (1 - f_r1) against A1 + A2, status `fail` / `pass_with_review` / `exempt` (UG-36(c)(3): d <= 89 mm for t <= 10 mm, 60 mm above). Corroded d and walls, E1 = 1, F = 1; head t_r from the sphere of radius K1 D = 0.9 D (2:1), the inside radius (hemispherical) or the crown radius (torispherical crown); free nozzles and openings outside the central 80 % (or in the knuckle) are listed under `notCovered`, never silently passed |
| `equipment_cog` (query) | centre of gravity of the empty / operating / test states of a vessel, equipment frame and world, with the mass lines of `equipment_weights` (empty.kg = total.emptyKg for the same `include`) |
| `design.insulation { thickness, densityKgM3 }`, `design.internals[{ label, kg, position? }]` | new vessel design fields (`add_vessel`, `add_process_column`, `update_equipment_parameters set.design`); their mass joins every weight state, the legacy `weight` and the centre of gravity; density is never defaulted, an internal without `position` sits at mid-shell and is listed in `defaulted` |
| torispherical M factor | UG-32(e) general form t = P L M / (2 S E - 0.2 P), M = (3 + sqrt(L / r)) / 4, for any torispherical head with t/L >= 0.002, L <= D, r >= 6 % of the skirt outside diameter and r >= 3 t; the F&D proportions (r = 0.06 L) keep the printed 0.885 form; DIN 28011 / 28013 and ASME 80/10 are now covered (80/6 is refused: its knuckle is below 6 % of the skirt diameter) |

Decisions: (1) `nozzle_reinforcement` is a query, NOT part of `check_equipment`: the validation scenarios of the pack (SC-EQP-01 / 02) fix the findings of `check_equipment`, and the model has no reinforcing pad, so an area `fail` here means "pad or thicker wall, reviewed", not a failed design. (2) The neck material is the vessel's unless `nozzleAllowableStress` is given (f_r = min(1, S_n / S_v)); the neck is seamless (E = 1); weld metal (A41) and pads (A5) are not modelled, so the available area is conservative. (3) Heads: exact centroid of the offset metal solid (first moment as the integral of the cumulative volume, closed forms of the hemispherical shell and the half-ellipsoid as oracles). (4) Nozzles are lumped at the middle of wall point -> flange face; the liquid of a horizontal head at a partial level is lumped at the full head-cavity centroid at the shell-liquid height (named in `approximations`); a torispherical head at a partial level has no closed-form volume, so `operating` is null (as for `equipment_weights`). (5) Exchangers, tanks and pumps are not covered by `equipment_cog` (EQP_NOT_PARAMETRIC naming the vessel-only scope).

Left after EQP-FU-2: CoG of exchangers / tanks / pumps; reinforcement of exchanger and tank nozzles, pads (A5), weld loads (UG-41), UG-36 spacing between openings; external pressure (UG-28); the operating liquid of a horizontal torispherical head at a partial level.
