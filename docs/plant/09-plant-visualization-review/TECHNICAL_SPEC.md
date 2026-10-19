# Gap 09 VIS — Plant visualization and model review: technical specification

Status: proposed (2026-10-18). Functional view: [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md). Validation:
[`validation/README.md`](validation/README.md). Laws: [`.claude/rules/architecture.md`](../../../.claude/rules/architecture.md).

## 1. Current state in llull (before this gap)

### 1.1 Viewport (three.js / r3f, `src/ui/viewport/3d/`)

| Area | What exists | Limit for plant scale |
| ---- | ----------- | --------------------- |
| Instancing | `grouping.ts` `entityRenderKey` batches `box` / `cylinder` / `sphere` with identical params (6 significant digits), **colour**, layer and material into one `InstancedMesh` (`InstancedRenderer.tsx`, `instanceWriter.ts`: per-instance matrix + colour, selection tint). | Every other kind (meshes from `add_pipe_run` sweeps, extrusions, B-rep, instance children) renders per entity: 1 draw call each. Colour in the key splits batches by service. |
| Instances | `Entities.tsx` `InstanceEntityRenderer` expands a component instance (`expandInstance`) and renders each child through the per-entity path. | A catalogue part used 10⁴ times costs 10⁴ × children draw calls. |
| LOD | `lodSegments.ts`: a static radial segment count from the entity size (8..64). Its header says "no three.js LOD objects / per-frame checks". | No distance LOD, no impostors, no pixel-size culling. |
| Culling / picking | three.js per-object frustum culling; `bvhSetup.ts` patches `Mesh.raycast` with three-mesh-bvh. Its header says "InstancedMesh is not patched … instance counts stay < 10k". | No instance-level culling or BVH; `InstancedMesh` culls as a whole (fact T1). |
| Quality | `useRenderQuality.ts`: tier high / medium / low from the entity count (≤ 50, ≤ 200, else low); budget "≤ 16 ms median frame at 500 entities". `SceneLighting.tsx`: drei `Environment` + `Lightformer`, `SoftShadows` (PCSS), baked `ContactShadows`, key light sized to the scene. ACES tone mapping (`Viewport3D.tsx`). | No SSAO, no edges overlay in shaded mode, no material classes beyond `Material` colour / metalness / roughness / procedural `finish`. |
| Materials | `useMaterialProps.ts`, `useFinishTextures.ts`, `displayMetalness.ts`; `Material` in `packages/core/src/model/types.ts` (color, metalness, roughness, finish). | Fine for PBR; no plant material-class library. |
| Camera | `PerspectiveCamera` FOV `VIEWPORT_FOV_DEGREES` = 45 (`packages/core/src/model/viewport.ts`), `OrbitControls`, floating origin (`floatingOrigin.ts`), document camera `CameraState {target, azimuth, polar, distance}` written by `set_camera` / `fit_view` (`packages/core/src/commands/document/camera.ts`, `metaHistory`). | Orbit only; no walk / fly. |
| Bookmarks | `NamedViews.tsx` + `src/ui/store/namedViewStore.ts`: "persisted to localStorage; UI-only, never in the CadDocument". | Not shareable, not reachable by CLI / MCP: violates the "persisted ⇒ command" rule for this gap. |
| Section | `ClippingPlane.tsx` + `clipPlaneMath.ts`: one axis-aligned plane in UI store (`clipPlane`). | No box, not saved. |
| Colour | Per-entity `color`; layer colours (`Layer.color`); industrial category layers in `packages/domain-aec/src/building/evaluate/entities.ts` (`P-PIPE` #2f9c8f, `P-SUPP` #c9a227, …); `evaluatePipe` (`packages/domain-aec/src/industrial/evaluate.ts`) colours a pipe by **material** (`colorForMaterial`), not by service. | No property-driven colour. No command re-colours an existing entity: the edit catalogue (`packages/core/src/commands/edit/`) has none; `assign_material` changes appearance only through a material. |

### 1.2 Server raster renderer (`packages/core/src/commands/render/`)

`render_view` (`renderView.ts`, 237 lines) is pure: no three.js, no DOM.

- Views: `top` … `iso` or a `direction`, all **orthographic** (`camera.ts`).
- `raster.ts`: z-buffer, 2× supersampling, flat Lambert, light (0.6, −0.8, 1.0), ambient 0.35. Outlines at a normal
  change > 25°, a depth change or an entity change. The image is embedded as PNG (`lib/png`) in the SVG.
- `budget.ts`: a fair polygon budget (vector mode: default 20 000; raster mode ≥ 400 000), with
  `simplifiedEntityIds` / `skippedEntityIds`.
- Options: `cut` (1–6 planes, intersection / union, hatched caps), `isolate`, `section`, `turntable`, labels, grid,
  axes.
- Missing: perspective, shadows, ambient occlusion, per-material shading, colour profiles, viewpoints. There is no
  digest in `data`.

### 1.3 Review, clash, interop

| Area | What exists |
| ---- | ----------- |
| Clash | `check_clashes` (`packages/domain-aec/src/industrial/clash/clash.ts`): read-only, `data = { clashes: Clash[] }` with `{a, b, kind: 'hard' \| 'clearance', depth}`. The Building panel lists the rows. |
| Review | `packages/core/src/commands/review/` (`intents.ts`, `grounding.ts`): interference intents (`allow_interference`) in `doc.prototype`, with `declaredBy: 'agent'` because `ExecutionContext` has no caller yet. Viewpoints, issues and comments do not exist. |
| glTF | `export_gltf` (`packages/core/src/commands/exchange/gltfScene.ts`): one node + mesh per part, one material per appearance, instances expanded. No `EXT_mesh_gpu_instancing`. |
| Site | civil plugin (`packages/domain-aec/src/civil/`): `create_surface`, `surface_report`, `import_survey_points`, `set_coordinate_system`, `design_site`. Surfaces render as entities. No sky or sun. |
| Perf gates | `docs/QUALITY_GATES.md` lists **proposed** gate 2 "Performance budgets" (median frame time while orbiting, +20 % regression) and gate 4 "Visual regression". Neither is implemented. |

**Gap** = sections 3–8 below.

## 2. Target architecture

```
packages/core/src/
  model/review.ts            ReviewModel: viewpoints, sectionBoxes, markups, issues, comments, walkthroughs
  model/display.ts           DisplayModel: colourProfiles, activeProfileId, materialClasses
  model/raster.ts            RasterPort + RasterScene (optional native GPU raster, §2.A)
  model/spatialIndex.ts      SpatialIndexPort (optional native / WASM BVH queries, §2.A)
  geometry/entityProperties.ts  core property bag (kind, layer, tags, material, name, componentId) + provider port
  geometry/colourRules.ts    pure first-match evaluation (profile × properties → appearance)
  geometry/renderPlan.ts     pure batching / LOD / culling plan (prototype keys, buckets, counts) — used by UI AND render_stats
  geometry/instanceBvh.ts    pure static BVH over instance AABBs (frustum query, ray query) — the reference
  geometry/viewpointCamera.ts  viewpoint ⇄ CameraState ⇄ BCF camera conversions
  commands/review/           viewpoints.ts markups.ts issues.ts checkReview.ts clashIssues.ts walkthrough.ts (+ existing intents.ts)
  commands/display/          colourProfiles.ts sectionBoxes.ts colourReport.ts checkDisplay.ts
  commands/exchange/         bcf/ (zip, markup.xml, visinfo.xml writers/readers), gltf instancing in gltfScene.ts
  commands/render/           renderView.ts (+ perspective, viewpoint, profile, review shading), renderStats.ts, shade.ts, shadow.ts, ambientOcclusion.ts
packages/domain-aec/src/industrial/display/     (plugin `industrial`, toolset `plant-display`)
  serviceSchemes.ts          ASME A13.1 / ISO 14726 / BS 1710 / DIN 2403 tables (from validation/data, with source ids + grades)
  serviceColour.ts           list_service_colour_schemes, apply_service_colour_scheme
  pipeMarkers.ts             add_pipe_markers, check_pipe_markers (A13.1 legend size + placement)
  properties.ts              entityProperties provider: service, line, dn, odMm, insulationMm, category, mark
src/ui/viewport/3d/plant/    PlantBatchRenderer.tsx (renderPlan → InstancedMesh buckets), LodGeometryCache.ts,
                             SectionBox.tsx, MarkupLayer.tsx, WalkControls.tsx, ReviewPostFx.tsx (SSAO/edges by tier)
src/ui/panels/review/        ReviewPanel (issues, comments, viewpoints), RedlineTools (param gathering only)
```

How the laws are respected:

- **L1 / L4.** Every persisted thing is document data written by a command. The UI dispatches `save_viewpoint`,
  `add_markup`, `set_section_box`, `set_active_colour_profile` and the other commands. Navigation state (walk / fly
  mode, current camera while moving) is presentation and stays in the viewport store, like today's orbit.
  `namedViewStore.ts` is retired after a one-time import that dispatches `save_viewpoint`.
- **L2.** `renderPlan.ts`, `colourRules.ts` and `instanceBvh.ts` are pure maths in core `geometry/`, with no three.js.
  The UI turns buckets into `THREE.InstancedMesh`. `render_stats` and `render_view` call the same plan, so the CLI
  numbers are the viewport's numbers.
- **L3.** Commands return new documents. `review` and `display` are optional document sections, created on first
  use, like `prototype` and `drawings`.
- **L5.** The new commands register in core feature catalogues (`review`, `display`, `render`, `exchange`) and in
  the industrial plugin `commands`. MCP schemas come from zod.
- **L8.** Review and display commands are `metaHistory: true`: they append no `FeatureStep`, like `set_camera`. So
  replay of the design recipe never re-creates issues. Ids are still step-scoped and deterministic
  (`vp-<n>.<k>`, `iss-<n>.<k>`), taken from a dedicated review counter (`review.nextNumber`). Undo / redo covers
  them through the store's document history (`metaHistory` commands are undoable today).
- **L9.** No kernel is needed. Section boxes and clash framing use AABBs. `render_view` stays kernel-free.
- **L10.** Core never imports `industrial`. The plugin contributes (a) commands, (b) an `entityProperties`
  provider registered through `plugins/host.ts`. This adds one optional `CadPlugin` field (§3.4). The change touches
  `packages/core/src/plugins/plugin.ts`, so `cad-reviewer` must approve it.

### 2.A Stack amendment (RS1, 2026-10-18)

Decided by the owner in [RS1](../../decisions/RS1-native-compute.md) (programme steps **RS-5** and **RS-6**). It adds
two optional native paths. The pure-TS code stays the default and the reference.

| Item | Before | Now |
| ---- | ------ | --- |
| Headless `render_view`, `render_walkthrough`, BCF snapshots | pure-TS software raster (`packages/core/src/commands/render/`) only | the TS raster stays the default and the **hash reference**; `renderer: 'native'` draws the same scene on the GPU with `llull-compute raster` (crate `llull-raster`, wgpu offscreen) |
| Instance BVH, `render_stats` at 10⁶, model-scale clash broad phase | `geometry/instanceBvh.ts` (TS, worker above 10⁴) | `instanceBvh.ts` stays the reference; the shared `llull-bvh` crate is an option: native through `llull-compute geomq` for the CLI, WASM in the viewport worker if the TS build misses 1.5 s at 10⁶ |
| Viewport | three.js WebGL | unchanged |
| Gate | Vitest | plus `npm run native:check` (`cargo test` + `cargo clippy -D warnings`) for `llull-raster` and `llull-bvh` |

**Hash rule (TR-VIS-30, RS1 §2 rule 3).** Only the reference renderer produces `svgSha256`. The digest must stay
identical across runs and machines (per `rendererVersion`, Q6), so it is never computed from GPU pixels. Native mode
is explicitly **non-hash**: `data` has no `svgSha256`, and carries `renderer: 'native'`, `device`, the binary version
and `deterministic: false`. Golden tests and SC-VIS-05 use the reference renderer only. An agent that needs a
reproducible picture (AF-13, AF-22) leaves `renderer` at its default.

**Seams (L2, L9).** Native code is reached only through two optional injected ports. Core declares them; the server
host installs them.

- `ctx.raster?: RasterPort | null` (`model/raster.ts`): `render(scene: RasterScene): RasterImage | null`. The TS
  pipeline builds the `RasterScene` (camera, `renderPlan` buckets, colour profile, section box, material classes,
  sun, edge options); the server runs `llull-compute raster` on it. No port or no binary → `NATIVE_TOOL_MISSING`.
  There is no silent fallback, so the caller always knows which renderer drew the picture.
- `ctx.spatialIndex?: SpatialIndexPort | null` (`model/spatialIndex.ts`): frustum queries and broad-phase pairs over
  instance AABBs. The server runs `llull-compute geomq` (crate `llull-geomq` on `llull-bvh`). Results are id sets
  sorted ascending, so they must equal `instanceBvh.ts` exactly. `render_stats` and the `check_clashes` broad phase
  (industrial plugin) use it only above a size threshold fixed at VIS-M7 (TBD — measure). The narrow phase
  (oriented-box SAT) stays TS. No port → the TS path, with the same result.
- **Viewport.** `instanceBvh.ts` runs in a worker. If VIS-M7 measures the 10⁶ build above 1.5 s, `llull-bvh` compiled
  to WASM replaces it in the worker, under the same exact-equality test. The decision is recorded at VIS-M7.

Native vs reference: VC-VIS-60 (validation README).

### 2.1 Technical requirements

| Id | Pri | Requirement | FR | AF |
| -- | --- | ----------- | -- | -- |
| TR-VIS-01 | MUST | Pure first-match colour-rule engine `geometry/colourRules.ts` (§5.1); a cached result per (profile, entities identity) | FR-VIS-01 | AF-13 |
| TR-VIS-02 | MUST | Property port: `CadPlugin.entityProperties` + `ctx.properties`; industrial provider for pipes / equipment (§3.3, §3.4) | FR-VIS-01 | AF-01 |
| TR-VIS-03 | MUST | Scheme tables as data with source ids and grades; reports carry category names, `palette` and `approximate: true`; hazard profiles start `reviewRequired` | FR-VIS-02, 03 | AF-30, 31, 33, 35 |
| TR-VIS-04 | SHOULD | A13.1 legend band and placement algorithm (§5.7) with a check command | FR-VIS-04 | AF-20, 33 |
| TR-VIS-10 | MUST | `review` model; viewpoint commands `metaHistory`, ids from `review.nextNumber` (deterministic) | FR-VIS-05 | AF-05, 13 |
| TR-VIS-11 | MUST | Viewpoint ⇄ `CameraState` ⇄ BCF camera conversion (§5.3) | FR-VIS-05 | AF-13 |
| TR-VIS-12 | SHOULD | BCF 3.0 writer / reader (2.1 read), units and GUID mapping, schema-valid output (§6) | FR-VIS-09 | AF-12 |
| TR-VIS-13 | MUST | Section-box classification and rendering conventions (§5.4) | FR-VIS-06 | AF-21 |
| TR-VIS-14 | MUST | Markups, issues and comments as document data; undo / redo; replay-stable ids | FR-VIS-07, 08 | AF-13 |
| TR-VIS-15 | MUST | Issue workflow with the human gate (§5.5) | FR-VIS-07 | AF-34, 34a |
| TR-VIS-16 | MUST | `check_review` / `check_display` with the codes of §7 | FR-VIS-10 | AF-11, 20 |
| TR-VIS-20 | MUST | `geometry/renderPlan.ts` R-BATCH-v1 (§5.2), shared by the viewport and `render_stats` | FR-VIS-12, 13 | AF-21 |
| TR-VIS-21 | MUST | LOD metric, thresholds `lod:llull-v1`, hysteresis (§5.3) | FR-VIS-12 | — |
| TR-VIS-22 | MUST | Instance bookkeeping (drawn + culled = N) and GPU byte estimate | FR-VIS-13 | AF-10 |
| TR-VIS-23 | SHOULD | Static instance BVH (binned SAH) for frustum culling and picking, built in a worker above 10⁴ (`instanceBvh.ts` is the reference) | FR-VIS-14 | AF-40 |
| TR-VIS-26 | SHOULD | Optional `llull-bvh` path (native `llull-compute geomq` through `ctx.spatialIndex`, or WASM in the viewport worker) returning the same id sets as `instanceBvh.ts` (§2.A) | FR-VIS-13, 14 | AF-13 |
| TR-VIS-24 | COULD | Hi-Z occlusion, tiled streaming, impostors (V2) | FR-VIS-14 | — |
| TR-VIS-25 | SHOULD | glTF `EXT_mesh_gpu_instancing` export / import | FR-VIS-19 | AF-12 |
| TR-VIS-30 | MUST | `render_view` determinism on the reference (TS) renderer: `svgSha256`, `rendererVersion` | FR-VIS-16 | AF-13, 22 |
| TR-VIS-31 | MUST | Perspective projector with perspective-correct depth | FR-VIS-16 | AF-22 |
| TR-VIS-32 | SHOULD | Review shading: material-class Blinn–Phong, sun shadow, deterministic AO, edges, sky / ground (§5.6) | FR-VIS-15, 16 | AF-22 |
| TR-VIS-33 | SHOULD | Viewport quality tiers keyed by drawn instances; material classes (§5.6) | FR-VIS-15 | — |
| TR-VIS-34 | SHOULD | Native GPU raster (`renderer: 'native'`, `llull-compute raster` through `ctx.raster`): non-hash, `deterministic: false`, `device` in `data` (§2.A) | FR-VIS-16, 17 | AF-22, 35 |
| TR-VIS-40 | MUST | `create_clash_issues` with framing (§5.8) and `clashKey` idempotence | FR-VIS-11 | AF-13 |
| TR-VIS-41 | MUST | Clash re-run reconciliation: `created`, `unchanged`, `updated` (depth) and `gone` (clash no longer reported) in `data` | FR-VIS-11 | AF-10 |
| TR-VIS-42 | SHOULD | Walkthrough paths and frame rendering (§5.3) | FR-VIS-17 | AF-22, 40 |
| TR-VIS-50 | MUST | Stable `VIS_*` codes with ids / paths / remediation on every refusal and check (§7) | FR-VIS-20 | AF-11 |

## 3. Data model

### 3.1 Display (core, `model/display.ts`)

```ts
export type PropertyValue = string | number | boolean;

/** Predicate on the entity property bag; all present clauses must hold (AND). `any` = OR of sub-predicates. */
export interface RulePredicate {
  readonly property?: string;                 // e.g. 'service', 'line', 'dn', 'layerId', 'kind', 'tag', 'materialClass'
  readonly equals?: PropertyValue;
  readonly in?: readonly PropertyValue[];
  readonly matches?: string;                  // case-insensitive regex, max 200 chars, compiled once, no backrefs
  readonly range?: readonly [number, number]; // inclusive, numbers only
  readonly any?: readonly RulePredicate[];
}

export interface ColourRule {
  readonly id: string;                        // stable within the profile
  readonly when: RulePredicate;
  readonly appearance: {
    readonly colour: string;                  // '#rrggbb' or 'scheme:<schemeId>/<category>' resolved through a palette
    readonly transparency?: number;           // 0..1
    readonly hidden?: boolean;
  };
  readonly legend: string;                    // e.g. 'Water (A13.1: white on green)'
  readonly scheme?: { readonly id: 'asme_a13_1' | 'iso_14726' | 'bs_1710' | 'din_2403'; readonly rowId: string };
}

export interface ColourProfile {
  readonly id: string;
  readonly name: string;
  readonly rules: readonly ColourRule[];      // evaluated in order; first match wins (E3D / Navisworks semantics)
  readonly defaultAppearance: { readonly colour: 'entity' | string; readonly transparency?: number };
  readonly palette: string;                   // 'llull-ral-approx-v1' (named default, approximate: true)
  readonly reviewRequired: boolean;           // true when built from a hazard scheme and not yet signed
}

export interface DisplayModel {
  colourProfiles: Record<string, ColourProfile>;
  activeProfileId?: string;
  materialClasses: Record<MaterialClassId, MaterialClass>;   // seeded with the named defaults of §5.6
}
```

### 3.2 Review (core, `model/review.ts`), BCF-aligned

```ts
export type ViewpointCamera =
  | { readonly projection: 'perspective'; eye: Vec3; direction: Vec3; up: Vec3; fovDeg: number; aspectRatio?: number }
  | { readonly projection: 'orthographic'; eye: Vec3; direction: Vec3; up: Vec3; viewHeight: number; aspectRatio?: number };
/** @invariant |direction| = |up| = 1 ± 1e-6, |direction·up| ≤ 1e-6; fovDeg ∈ (0, 180); viewHeight > 0 (document units) */

export interface SectionBox {
  readonly id: string;
  name: string;
  min: Vec3; max: Vec3;                       // document units, min < max per axis
  rotationZ?: number;                         // radians about the box centre
  planes?: ReadonlyArray<{ normal: Vec3; offset: number }>;   // alternative: 1..6 half-spaces, normal points to the removed side (BCF)
}

export interface Viewpoint {
  readonly id: string;                        // 'vp-<n>.<k>'
  readonly guid: string;                      // RFC 4122 v5 from (document id, id): stable for BCF
  name: string;
  camera: ViewpointCamera;
  sectionBoxId?: string;
  colourProfileId?: string;
  visibility?: { defaultVisible: boolean; exceptions: readonly EntityId[] };   // BCF Visibility
  selection?: readonly EntityId[];
  realism?: { mode: 'orbit' | 'walk' | 'fly'; eyeHeight?: number; gravity?: boolean; collision?: boolean };
}

export type MarkupShape = 'line' | 'polyline' | 'arrow' | 'cloud' | 'ellipse' | 'text';
export interface Markup {
  readonly id: string;                        // 'mk-<n>.<k>'
  readonly viewpointId: string;
  shape: MarkupShape;
  space: 'screen' | 'world';                  // screen: points in [0,1]² of the viewpoint image; world: Vec3 (BCF Lines)
  points: ReadonlyArray<Vec2 | Vec3>;
  colour: string; text?: string; lineWidthPx?: number;
  author: 'agent' | 'human'; createdStep: number;
}

export type IssueStatus = 'open' | 'in_progress' | 'resolved' | 'closed';
export interface ReviewIssue {
  readonly id: string;                        // 'iss-<n>.<k>'
  readonly guid: string;
  title: string; type: string; priority: 'low' | 'normal' | 'high' | 'critical';
  status: IssueStatus; assignedTo?: string; labels: readonly string[]; dueDate?: string;  // ISO 8601 date
  viewpointIds: readonly string[]; entityIds: readonly EntityId[];
  clashKey?: string;                          // 'clash:<sorted a>|<sorted b>|<kind>' (idempotence)
  history: ReadonlyArray<{ status: IssueStatus; by: 'agent' | 'human'; reason: string; signatureId?: string }>;
}

export interface ReviewComment {
  readonly id: string; readonly issueId: string; text: string;
  viewpointId?: string;                       // BCF agreement: a comment refers to at most one viewpoint
  author: 'agent' | 'human';
}

export interface Walkthrough { readonly id: string; name: string; keys: ReadonlyArray<{ viewpointId: string; seconds: number }> }

export interface ReviewModel {
  viewpoints: Record<string, Viewpoint>; viewpointOrder: string[];
  sectionBoxes: Record<string, SectionBox>;
  markups: Record<string, Markup>;
  issues: Record<string, ReviewIssue>; issueOrder: string[];
  comments: Record<string, ReviewComment>;
  walkthroughs: Record<string, Walkthrough>;
  nextNumber: number;                          // review id counter (metaHistory ⇒ not the feature-step counter)
}
```

`CadDocument` gains `review?: ReviewModel` and `display?: DisplayModel`. Both are absent until first use, so the
document version is unchanged and no migration is needed. The persistence schema
(`packages/core/src/commands/persistence`) gains validation for both, and load ignores unknown keys under them.

### 3.3 Entity properties

`entityProperties(doc, id)` returns a flat bag: core keys `kind`, `layerId`, `layerName`, `tag` (multi-valued),
`materialId`, `materialClass`, `name`, `componentId`, `is2D`, plus provider keys. The industrial provider resolves a
derived entity through its `elementId` to the building element. For pipes it returns `service`, `line`, `dn`,
`odMm`, `material`, `from` and `to`. For equipment it returns `mark`, `category` and `equipmentShape`. 02-RTE and
08-DAT providers add `spec`, `insulationMm`, `tag` and `status`. Multi-valued keys (`tag`) match when any value
matches.

### 3.4 Plugin port (one optional field)

```ts
// packages/core/src/plugins/plugin.ts
export interface CadPlugin {
  /* existing: name, toolset, commands, guards?, document? */
  readonly entityProperties?: (doc: CadDocument, entityId: EntityId) => Readonly<Record<string, PropertyValue | readonly PropertyValue[]>>;
}
```

`installPlugin` registers the provider in an injected `PropertyProviders` list. Commands read it from
`ctx.properties` (new `ExecutionContext` field, default = core-only). This follows `ctx.kernel` / `ctx.registry` (C6:
narrow injected ports).

## 4. Commands

Toolsets: `review` (core), `display` (core), `render` (core), `exchange` (core), `plant-display` (industrial). All
are `metaHistory: true` unless marked query. Every command carries `@affects / @invariant / @failure` tags (C2), and
every refusal sets `CommandResult.error` with a code from §7.

| Command | Kind | Params (zod sketch; lengths in document units unless stated) | Result `data` | @affects / @invariant / @failure |
| ------- | ---- | ------------------------------------------------------------ | ------------- | -------------------------------- |
| `define_colour_profile` | mutating | `id`, `name`, `rules: ColourRule[]` (1..256), `defaultColour?: 'entity' \| hex`, `replace?` | `{profileId, ruleCount}` | adds / replaces `display.colourProfiles[id]` · rule ids unique, regex compiles, colours valid · `VIS_RULE_INVALID`, `VIS_COLOUR_INVALID`, `VIS_PROFILE_EXISTS` |
| `set_active_colour_profile` | mutating | `profileId \| null` | `{active}` | sets `display.activeProfileId` · geometry untouched · `VIS_PROFILE_NOT_FOUND` |
| `delete_colour_profile` | mutating | `profileId` | — | removes; refused while a viewpoint references it (`VIS_PROFILE_IN_USE`) |
| `colour_by_rule_report` | query | `profileId?` (default active), `entityIds?`, `groupBy?: 'entity' \| 'line' \| 'rule'`, `limit?` | `{palette, approximate: true, groups: {key: {ruleId, category, fieldColour, letterColour, displayHex, count, ids}}, legend[], unmatched: ids, warnings[]}` | read-only · deterministic order (rule order, then id) · `VIS_COLOUR_UNMATCHED` (warn) |
| `check_display` | query | — | `{status, issues[{code, ids, remediation}]}` | read-only · unmatched entities, profiles referencing unknown properties, `reviewRequired` profiles in use |
| `set_section_box` | mutating | `min`, `max`, `rotationZ?`, `planes?`, `name`, `id?` | `{id}` | adds `review.sectionBoxes` · min < max · `VIS_SECTION_BOX_INVALID` |
| `delete_section_box` | mutating | `id` | — | refused while referenced (`VIS_SECTION_BOX_IN_USE`) |
| `section_box_report` | query | `id` | `{inside[], crossing[], outside[], counts}` | exact AABB (or OBB for rotationZ) classification, §5.4 · `VIS_SECTION_BOX_EMPTY` (warn) |
| `save_viewpoint` | mutating | `name`, `camera?: ViewpointCamera` \| `fromDocumentCamera?: true`, `sectionBoxId?`, `colourProfileId?`, `visibility?`, `selection?`, `realism?`, `id?` | `{id, guid, camera}` | adds viewpoint · camera orthonormal ± 1e-6 (normalised on save, original kept within tolerance) · `VIS_CAMERA_INVALID`, `VIS_VIEWPOINT_NOT_ORTHONORMAL` |
| `update_viewpoint` / `delete_viewpoint` | mutating | `id`, fields | — | delete cascades to markups; refused while an issue references it unless `force` (`VIS_VIEWPOINT_IN_USE`) |
| `apply_viewpoint` | mutating (camera + display only) | `id` | `{camera: CameraState, activeProfileId, sectionBoxId}` | writes `doc.camera` (§5.3), active profile, active section box · `VIS_VIEWPOINT_NOT_FOUND` |
| `get_viewpoint` / `list_viewpoints` | query | `id` / `limit?` | viewpoint(s) with markups count | — |
| `add_markup` / `delete_markup` | mutating | `viewpointId`, `shape`, `space`, `points` (2..256), `colour`, `text?`, `lineWidthPx?` | `{id}` | screen points in [0,1] · `VIS_MARKUP_INVALID`, `VIS_VIEWPOINT_NOT_FOUND` |
| `create_review_issue` | mutating | `title`, `type`, `priority`, `viewpointIds?`, `entityIds?`, `labels?`, `assignedTo?`, `dueDate?` | `{id, guid}` | status `open` · ids exist · `VIS_ENTITY_NOT_FOUND`, `VIS_VIEWPOINT_NOT_FOUND` |
| `add_review_comment` | mutating | `issueId`, `text`, `viewpointId?` | `{id}` | `VIS_ISSUE_NOT_FOUND` |
| `set_issue_status` | mutating | `issueId`, `status`, `reason`, `signature?` | `{status, history}` | transitions §5.5; `closed` (and re-open from `closed`) needs a human signature or session (AF-34a) · `VIS_ISSUE_STATUS_INVALID`, `VIS_HUMAN_GATE` |
| `check_review` | query | `includeInfo?` | `{status: pass\|warn\|fail, issues[{code, ids, paths, remediation}], counts}` | read-only (AF-20) |
| `create_clash_issues` | mutating | `source: 'check_clashes' \| 'check_assembly'`, `sourceParams?`, `margin` (default 500 mm, named), `priority?` | `{created, unchanged, issueIds[]}` | runs the read-only source via `ctx.registry` execute, reads `data.clashes[] {a, b, kind, depth}` · idempotent on `clashKey` · `VIS_CLASH_SOURCE_INVALID` |
| `create_walkthrough` / `delete_walkthrough` | mutating | `name`, `keys: {viewpointId, seconds > 0}[]` (2..500) | `{id, durationS}` | `VIS_WALKTHROUGH_INVALID` |
| `render_walkthrough` | query | `id`, `fps` (1..30), `width`, `height`, `maxFrames` (≤ 600), `renderer?: 'reference' \| 'native'` | `{frames, svgSha256[]}` (reference; native frames carry no digest); frames written with `--save dir/` | camera slerp between keys (§5.3) · `NATIVE_TOOL_MISSING` |
| `export_bcf` | query | `issueIds?`, `version: '3.0' \| '2.1'`, `snapshots?: boolean`, `snapshotRenderer?: 'reference' \| 'native'` | `{bytes, sha256, topics}`; bcfzip via `--save` | metres + degrees · `VIS_BCF_GUID_UNMAPPED` (warn) |
| `import_bcf` | mutating | `bcf: base64` (CLI `@file`), `mergePolicy: 'skip' \| 'update'` | `{topics, viewpoints, comments, warnings}` | `VIS_BCF_PARSE`, `VIS_BCF_VERSION` |
| `export_bcf_viewpoint` / `import_bcf_viewpoint` | query / mutating | `id` / `visualizationInfo: string`, `name` | `{visualizationInfo, camera: {cameraViewPointM, …}}` / `{id}` | single-viewpoint form for tests and plans |
| `render_stats` | query | `viewpointId?` \| `view` / `direction` / `target`, `projection`, `fovDeg?`, `width`, `height`, `quality?`, `multiDraw?: boolean` (default true) | `{componentCount, buckets[{prototypeKey, lod, instances}], opaqueModelCalls, edgeCalls, shadowCalls, culled{frustum, pixel}, instancesDrawnPlusCulled, triangles, gpuBytesEstimate, planVersion}` | read-only; same `renderPlan` as the viewport |
| `render_view` (extended) | query | existing + `projection: 'orthographic' \| 'perspective'`, `fovDeg`, `viewpointId`, `colourProfileId`, `sectionBoxId`, `shading: 'flat' \| 'review'`, `edges`, `shadows`, `ambientOcclusion`, `sun?: {azimuthDeg, elevationDeg}`, `background: 'dark' \| 'light' \| css`, `renderer: 'reference' \| 'native'` (default `'reference'`) | existing + `svgSha256` (reference only), `rendererVersion`, `projection`, `visibleEntityIds` (bounded), `legend`; native adds `renderer`, `device`, `deterministic: false` | deterministic per `rendererVersion` (reference) · `VIS_RENDER_BUDGET` when pixels × supersample > 16 M · `NATIVE_TOOL_MISSING` |
| `list_service_colour_schemes` (industrial) | query | `scheme?` | rows with `sources[]`, `grade`, `conflict?` | read-only |
| `apply_service_colour_scheme` (industrial) | mutating | `scheme`, `profileId`, `serviceMap: Record<serviceText, category>`, `property?: 'service'` (default), `activate?`, `markerLetters?: boolean` | `{profileId, mapped, unmapped[], reviewRequired: true}` | builds a `ColourProfile` (one rule per mapped service, ordered by the map) · `VIS_SCHEME_UNKNOWN`, `VIS_SCHEME_CATEGORY_UNKNOWN` |
| `add_pipe_markers` (industrial) | mutating | `lineIds? \| all`, `scheme: 'asme_a13_1'`, `spacing?` (default 7620 mm, named, grade B), `insulationMm?` | `{markers, perLine}` | decals on pipe segments; legend from §5.7 · `VIS_MARKER_NO_OD`, `VIS_MARKER_BAND_INTERPOLATED` (warn) |
| `check_pipe_markers` (industrial) | query | `lineIds?` | `{status, rows[{line, odIn, fieldLengthMm, letterHeightMm, bandInterpolated, markers, missingAt[]}]}` | read-only (AF-20) |

Out of the command layer, UI only: walk / fly controllers, transient section-box dragging (dispatches
`set_section_box` on release), redline drawing (dispatches `add_markup` on finish), and the LOD / culling evaluation
per frame (the same pure plan, run in a worker).

## 5. Algorithms

### 5.1 Colour rules (TR-VIS-01..03)

For entity e with property bag P(e), profile R = (r₁ … r_m, default d):

```
appearance(e) = r_i.appearance for the smallest i with match(r_i.when, P(e)), else d
match(p, P) = all of: equals → P[k] == v (string compare case-insensitive, numbers exact);
              in → P[k] ∈ set; matches → regex.test(String(P[k])); range → a ≤ P[k] ≤ b;
              any → ∃ q ∈ any : match(q, P)
```

A missing property never matches. Cost is O(N · m) per profile change. The result is cached by
(profileId, document entity identity), and the per-instance colour buffer is rewritten only for changed ids.
`scheme:<id>/<category>` resolves through `palette` to `displayHex` (`validation/data/llull_display_palette.json`).
Reports always carry the category **name** and the `palette` id with `approximate: true`. Hazard-scheme profiles
start with `reviewRequired: true`, cleared only by a human-signed `set_issue_status`-style act on the profile
(`approve_colour_profile`, V1, human gate).

### 5.2 Batching rule R-BATCH-v1 (TR-VIS-20)

- **Prototype key.**
  - Primitive kinds: `kind | params(6 s.f.)` (today's key without colour and layer).
  - Meshes: `mesh | sha256(positions, indices)`.
  - Instance children: `component:<componentId>/<childIndex>`.
  - Swept pipe segments: `sweep | outline hash | length(0.1 mm)`. Routed pipe from 02-RTE is prototype-based by
    construction.
- **Material class key.** The material class of the entity (§5.6), not its colour.
- **Bucket.** (prototype key, material class, LOD level) → one `InstancedMesh`. LOD2 (box) buckets merge across
  prototypes: one unit-box `InstancedMesh` per material class, scaled per instance to the prototype bbox.
- **Per-instance attributes.** Matrix (64 B), colour (12 B), plus a packed state byte (selected / highlighted /
  transparent / isolated) in a second attribute, 4 B.
- **Unique geometry.** One `BatchedMesh` per material class. With `WEBGL_multi_draw` this is one call; without it,
  one call per visible instance (fact T3). `render_stats` reports both via `multiDraw`.
- **Transparency.** Transparent instances (xray, isolate dimming) go to a parallel transparent bucket set, sorted per
  bucket.
- **Bound.** For P prototypes, C material classes and U unique-geometry classes:
  `opaqueModelCalls ≤ 2P + C + U` (with multi-draw). SYN-RACK-v1: 2·13 + 4 + 0 = **30**, for any n
  (`validation/data/synthetic_pipe_rack_benchmark.json`).

### 5.3 LOD, culling and cameras (TR-VIS-21..23)

**Projected size** of an instance with bounding-box diagonal D at camera distance d (perspective, vertical FOV φ,
viewport height H px):

```
p = D · H / (2 · d · tan(φ/2))          LOD0 if p ≥ 48 px, LOD1 if 8 ≤ p < 48, LOD2 if 1 ≤ p < 8, culled if p < 1
```

- Thresholds are the named default `lod:llull-v1`. The 1 px cull mirrors the Navisworks default ([R2]).
- Hysteresis h = 0.1 has the semantics of three r186 `LOD.update` (fact T4): a visible level i stays until
  d < dᵢ (1 − h).
- Orthographic: replace 2 d tan(φ/2) by the view height.
- Example (stud M16, D = 92.8009 mm, H = 1080, φ = 45°): d₀₁ = 2520.462 mm, d₁₂ = 15122.774 mm,
  d_cull = 120982.194 mm.
- LOD meshes:
  - LOD0 is today's tessellation (`radialSegmentsForDiag`).
  - LOD1 caps radial segments at 8 and drops fillets, chamfers and threads (prototype simplification by
    `SimplifyModifier` only for meshes).
  - LOD2 is the oriented box.

**Frustum culling.** `instanceBvh.ts` builds a static BVH over instance world AABBs:

- Binned SAH, 16 bins, leaf ≤ 8 instances.
- Built once per document change in a worker for N > 10⁴; refit on transform-only edits.
- Native option (RS-6, §2.A): the same queries through `llull-bvh` (CLI: `llull-compute geomq`; viewport: WASM if
  the TS build misses its target). The id sets must be identical (VC-VIS-60).
- Query: the 6 frustum planes, then AABB–plane tests top-down. Fully-inside nodes emit their whole range without
  further tests.
- Cost O(log N + k).
- Picking uses the same BVH for instance AABBs, then three-mesh-bvh on the LOD0 prototype geometry in instance space.

**Occlusion (V2).** A hierarchical-Z pyramid from the previous frame's depth. Large occluders (equipment, slabs)
are drawn first; buckets are split into BVH-node chunks of ≤ 4096 instances, and a chunk is drawn only if its AABB
passes the Hi-Z test. Chunks are not queried every frame: they are tested with a one-frame latency to avoid stalls.

**Streaming (V2).** The document loads geometry-free first (prototype table + instance arrays). Prototype LOD2 boxes
show first. LOD0 / LOD1 prototype meshes load by projected-size priority (the same p). Spatial tiles are octree
cells of ≤ 50 000 instances.

**Viewpoint ⇄ CameraState** (`viewpointCamera.ts`). With the `set_camera` convention
(eye = target + r (sin p sin a, sin p cos a, cos p)), for a unit view direction v:

```
o = −v ;   polar p = acos(o_z) ;   azimuth a = atan2(o_x, o_y)
target = eye + v · r,   r = distance from eye to the scene-bounds centre projected on the view axis (≥ near)
```

The BCF example gives p = 1.2728948190113956 and a = 2.1402772048541396 (VC-VIS-11). BCF ⇄ document:

- Lengths are multiplied by the document unit factor (m → mm × 1000).
- `FieldOfView` is the vertical angle in degrees.
- `ViewToWorldScale` is the vertical view extent in metres.
- `AspectRatio` defaults to 1.0 for older files ([R7]).

Walkthrough interpolation: eye positions are Catmull–Rom splines through the key eyes. Orientations are quaternion
slerp. Frames = ⌈Σ seconds · fps⌉ + 1.

### 5.4 Section box (TR-VIS-13)

For an axis-aligned box B = [min, max] and an entity world AABB A:

- `inside` if A ⊆ B.
- `outside` if A ∩ B = ∅.
- `crossing` otherwise.

For `rotationZ` θ, test the 8 corners of A in the box frame (rotate by −θ about the box centre): this is a
conservative OBB test, exact for axis-aligned A when θ = 0. Rendering:

- Viewport: 6 local clipping planes (`material.clippingPlanes`, `clipIntersection = false`), each normal pointing
  outward, so outside is removed. Section caps use the existing hatched-cap approach of `render_view` (`clip.ts`) in
  the server renderer, and a stencil cap pass in the viewport.
- BCF clipping planes: `Direction` points to the invisible side, which is the same convention as `render_view` `cut`
  planes.

### 5.5 Issue workflow (TR-VIS-15)

| From \ to | open | in_progress | resolved | closed |
| --------- | ---- | ----------- | -------- | ------ |
| open | — | agent / human | agent / human | **human** |
| in_progress | agent / human | — | agent / human | **human** |
| resolved | agent / human | agent / human | — | **human** |
| closed | **human** | — | — | — |

Human = a signature with a human-held key, or an authenticated human session (AF-34a). `ctx.caller` alone only
selects the message. Each transition appends to `history` with `by`, `reason` and `signatureId`. Exported BCF
`TopicStatus` uses the same four words. Mapping to Navisworks clash statuses is an open question (§11).

### 5.6 Material classes and realistic display (TR-VIS-30..33)

`MaterialClassId` and its named defaults `matclass:llull-v1` give a base colour, metalness and roughness. They are
llull choices, not standard values, and are editable with `create_material`:

| Class | Base colour (display) | Metalness | Roughness | Notes |
| ----- | --------------------- | --------- | --------- | ----- |
| `structural_steel_painted` | per paint system (default from profile) | 0.1 | 0.6 | red portal / grey steel in the reference images is a paint colour |
| `galvanized_steel` | `#a5a8a6` (RAL 9006 approx) | 0.8 | 0.45 | grating, handrail |
| `carbon_steel_pipe_painted` | service colour (profile) | 0.1 | 0.5 | |
| `stainless_steel` | `#c0c4c8` | 0.9 | 0.3 | |
| `insulation_cladding_aluminium` | `#c9ccce` | 0.85 | 0.35 | jacketed lines |
| `concrete` | `#9a9a96` | 0.0 | 0.9 | foundations, base slab |
| `grating` | `#8f999f` | 0.7 | 0.5 | alpha-tested pattern (procedural finish) |
| `cast_steel_valve` | profile / `#2f5fa8` | 0.3 | 0.5 | blue valves in the reference image are a paint choice |
| `alloy_bolting` | `#3a3a3a` | 0.6 | 0.5 | |
| `frp` | `#6f8f6a` | 0.0 | 0.7 | |

Viewport by quality tier, extending `useRenderQuality.ts`. The tier is chosen by the **instance count drawn** from
`render_stats`, not by `document.order.length`.

| Tier | Shadows | Ambient occlusion | Edges | Environment |
| ---- | ------- | ----------------- | ----- | ----------- |
| high | 3-cascade CSM (three addon `CSM`) 2048² | GTAO half resolution (three addon `GTAOPass`) | screen-space normal / depth edge pass | IBL |
| medium | 2 cascades 1024² | SSAO quarter resolution | LOD0 buckets only | IBL |
| low | none (contact shadow off) | off | off | IBL |

While the camera moves, drop to the next lower tier and refine after 200 ms idle. This mirrors "guarantee frame rate /
fill in detail" ([R2]).

Server `render_view` with `shading: 'review'`:

1. Perspective or orthographic projector. Perspective-correct depth: interpolate 1/w per scanline.
2. Blinn–Phong per pixel: `c = albedo · (ambient · ao + (1 − ambient) · max(0, n·l) · shadow) + k_s (n·h)^s`, with
   ambient 0.35 (today's value), k_s and s from the material class (k_s = 0.04 + 0.5 · metalness,
   s = 2 / roughness² − 2, clamped to [1, 256]).
3. Sun shadow: a second orthographic z-buffer from the sun direction (default azimuth 135°, elevation 50°, named),
   resolution 2048², bias = 2 texels × slope, 3 × 3 PCF.
4. Ambient occlusion: horizon-based on the supersampled depth buffer. 8 fixed directions × 4 steps, radius 0.5 m in
   world units projected to pixels, and no random numbers, so the output is deterministic.
5. Edges: today's crease / depth / entity outlines.
6. Sky gradient + ground plane at the scene min z (`background: 'dark'` = `#1a1a2e` as today).
7. Colour profile and section box from the viewpoint or params.
8. `svgSha256` = sha256 of the final SVG string. `rendererVersion` is bumped on any pixel-affecting change.

Budget: pixels × supersample² ≤ 16 M (1920 × 1080 × 4 = 8.3 M). The cap applies to both renderers.

Steps 1–8 are the reference renderer (pure TS). With `renderer: 'native'` the TS pipeline still builds the scene
(camera, buckets, colour profile, section box, material classes, sun); `llull-raster` draws it offscreen on the GPU
(wgpu) with the same shading model. The result is a picture, not a digest: no `svgSha256`, `deterministic: false`,
`device` and the binary version in `data` (§2.A).

### 5.7 ASME A13.1 marker legend (TR-VIS-04)

OD_in = (pipe OD + 2 · insulation) / 25.4. The row is the first with odMin ≤ OD_in ≤ odMax
(`validation/data/service_colour_schemes.json`). An OD in a gap between rows (1.25–1.5, 2–2.5, 6–8 in) takes the
next larger row and sets `bandInterpolated: true` (`VIS_MARKER_BAND_INTERPOLATED`). The result gives field length
and letter height in mm (× 25.4).

Placement (grade B, named defaults):

- 1 marker within 600 mm of each valve, flange pair and direction change.
- 2 markers at each wall / floor penetration (02-RTE supplies penetrations).
- Straight-run interval `spacing`, default 7620 mm (25 ft).
- Flow arrow in the run direction from `from` to `to`; a both-ways arrow when the line is flagged bidirectional.

Examples (pipe ODs from `packages/domain-aec/src/industrial/piping/pipeSizes.ts`):

| Pipe | OD mm | OD in | Row | Field mm | Letters mm | Interpolated |
| ---- | ----- | ----- | --- | -------- | ---------- | ------------ |
| DN20 | 26.9 | 1.059 | 0.75–1.25 | 203.2 | 12.7 | no |
| DN25 | 33.7 | 1.327 | (gap) → 1.5–2 | 203.2 | 19.05 | yes |
| DN50 | 60.3 | 2.374 | (gap) → 2.5–6 | 304.8 | 31.75 | yes |
| DN100 | 114.3 | 4.500 | 2.5–6 | 304.8 | 31.75 | no |
| DN100 + 50 mm insulation | 214.3 | 8.437 | 8–10 | 609.6 | 63.5 | no |
| DN150 | 168.3 | 6.626 | (gap) → 8–10 | 609.6 | 63.5 | yes |
| DN200 | 219.1 | 8.626 | 8–10 | 609.6 | 63.5 | no |
| DN300 | 323.9 | 12.752 | > 10 | 812.8 | 88.9 | no |

### 5.8 Clash framing (TR-VIS-40)

For clash (a, b): the box is the AABB(a) ∩ AABB(b) when it is non-empty, otherwise the union of the two closest
faces; it is then expanded by `margin` on every side. The viewpoint is:

- camera: iso direction (1, −1, 1)/√3, perspective 45°, distance fitting the box (`fitFraming`);
- `selection` = [a, b];
- `visibility` = all.

`clashKey` = `clash:` + sorted(a, b) + `|` + kind. A re-run updates `depth` in the issue description and skips
creation.

## 6. Interop and persistence

- **Document**: `review` and `display` sections in the `.llull` JSON. Absent = empty, so no version bump is needed.
  Large plant documents: see open question Q3.
- **BCF 3.0** (and read-only 2.1):
  - zip with `bcf.version`, `extensions.xml`, one folder per topic (`markup.bcf`, `viewpoint.bcfv`,
    `snapshot.png`).
  - Units: metres and degrees. Colours are 6 or 8 hex digits (ARGB).
  - Components by `IfcGuid` when 08-DAT assigned one; otherwise llull ids go in `AuthoringToolId` with
    `OriginatingSystem = "llull"`.
  - The schemas are kept verbatim in `validation/data/bcf_3_0/` (CC BY-ND 4.0, unmodified).
  - The BCF optimisation rule (alert above 1000 coloured components, [R7]) maps to `VIS_BCF_COLOURING_LARGE`: the
    export then writes the profile as a legend label instead of per-component colouring.
- **glTF**: `export_gltf` writes one mesh per prototype and one node per bucket with `EXT_mesh_gpu_instancing`
  (`TRANSLATION`, `ROTATION`, `SCALE`, plus a custom `_COLOR_0` attribute for service colour). The extension is
  declared in `extensionsUsed`, and in `extensionsRequired` only when `instancing: 'required'`. Without the
  extension the export expands instances as today. `import_gltf` reads the extension
  (`validation/data/gltf_simple_instancing/`).
- **Snapshots**: `render_view` PNG embedded in the SVG; BCF snapshots use the reference raster as PNG by default (deterministic); `snapshotRenderer: 'native'` uses the GPU
  path (non-hash, §2.A).
- **Navisworks**: no NWD / NWF writer (proprietary). Interop goes through BCF (issues, viewpoints) and IFC / glTF
  (geometry).

## 7. Surfaces and error codes

- **CLI**: every command above. `render_view` / `render_walkthrough` / `export_bcf` write files with `--save`, and
  stdout carries only `data` without bytes. `llull guide` gets a "plant review" section covering units (mm, BCF in
  metres), the id conventions (`vp-`, `iss-`, `mk-`, `sb-`) and the minimal plan (SC-VIS-04).
- **MCP**: toolsets `review`, `display`, `plant-display`. `render` and `exchange` are existing toolsets.
- **UI**: Review panel, redline tools, section-box gizmo, profile picker with legend, walk / fly toggle and a
  performance HUD showing `render_stats` numbers live.

| Code | Raised by | Meaning | Remediation |
| ---- | --------- | ------- | ----------- |
| `VIS_PROFILE_NOT_FOUND` | profile / report / render commands | unknown profile id | `list` profiles via `check_display`, or `define_colour_profile` |
| `VIS_PROFILE_EXISTS` | `define_colour_profile` | id taken | pass `replace: true` |
| `VIS_PROFILE_IN_USE` | `delete_colour_profile` | a viewpoint references it | update or delete the viewpoint first |
| `VIS_RULE_INVALID` | `define_colour_profile` | bad predicate (unknown operator, regex > 200 chars or invalid, range a > b) | fix the rule at `paths` |
| `VIS_COLOUR_INVALID` | profile commands, `add_markup` | not `#rrggbb` nor `scheme:<id>/<category>` | use a hex colour or a listed category |
| `VIS_COLOUR_UNMATCHED` (warn) | report, `check_display` | entities fell through to the default | extend `serviceMap` / rules, or accept the default |
| `VIS_SCHEME_UNKNOWN` / `VIS_SCHEME_CATEGORY_UNKNOWN` | `apply_service_colour_scheme` | scheme or category not in the tables | `list_service_colour_schemes` |
| `VIS_SCHEME_REVIEW_REQUIRED` (warn) | `check_display` | hazard-scheme profile not approved by a human | a qualified reviewer approves the mapping |
| `VIS_CAMERA_INVALID` | viewpoint commands | FOV ∉ (0, 180), viewHeight ≤ 0, zero vector | fix the camera |
| `VIS_VIEWPOINT_NOT_ORTHONORMAL` | viewpoint commands | \|dir\| or \|up\| ≠ 1 or dir·up ≠ 0 beyond 1e-6 | normalise; `up` must be ⟂ `direction` |
| `VIS_VIEWPOINT_NOT_FOUND` / `VIS_VIEWPOINT_IN_USE` | viewpoint / markup / issue commands | unknown / referenced | — |
| `VIS_VIEWPOINT_STALE` (warn) | `check_review` | viewpoint selection / visibility names deleted entities | update the viewpoint |
| `VIS_SECTION_BOX_INVALID` / `VIS_SECTION_BOX_IN_USE` | section commands | min ≥ max / referenced | — |
| `VIS_SECTION_BOX_EMPTY` (warn) | `section_box_report` | nothing inside or crossing | enlarge the box |
| `VIS_MARKUP_INVALID` | `add_markup` | screen point ∉ [0,1]², < 2 points, > 256 | — |
| `VIS_ISSUE_NOT_FOUND` / `VIS_ISSUE_STATUS_INVALID` | issue commands | unknown issue / transition not in §5.5 | — |
| `VIS_ISSUE_OPEN` (info) | `check_review` | issue in `open` / `in_progress` | work on it or mark `resolved` |
| `VIS_ISSUE_AWAITING_APPROVAL` (warn) | `check_review` | `resolved`, waiting for a human | ask the reviewer |
| `VIS_ISSUE_ENTITY_MISSING` (warn) | `check_review` | issue references deleted entities | re-link or resolve |
| `VIS_HUMAN_GATE` | `set_issue_status`, `approve_colour_profile` | approval act by a non-human caller | a human signs (AF-34a) |
| `VIS_CLASH_SOURCE_INVALID` | `create_clash_issues` | source command missing or no `data.clashes` | run the clash command; check its params |
| `VIS_BCF_PARSE` / `VIS_BCF_VERSION` | `import_bcf*` | malformed XML or zip / version not 2.1 or 3.0 | — |
| `VIS_BCF_GUID_UNMAPPED` (warn) | `export_bcf` | entities without IFC GUID | run 08-DAT IFC export first, or accept `AuthoringToolId` |
| `VIS_BCF_COLOURING_LARGE` (warn) | `export_bcf` | > 1000 coloured components ([R7]) | — (legend written instead) |
| `VIS_MARKER_NO_OD` | `add_pipe_markers` | line has no OD | set `dn` / `diameter` |
| `VIS_MARKER_BAND_INTERPOLATED` (warn) | marker commands | OD in a gap of the A13.1 rows | reviewer confirms with the edition in force |
| `VIS_RENDER_BUDGET` | `render_view` | pixels × supersample² > 16 M | lower width / height |
| `VIS_WALKTHROUGH_INVALID` | walkthrough commands | < 2 keys, seconds ≤ 0, frames > max | — |
| `VIS_GPU_LIMIT` (UI warn, `render_stats` field) | renderer | batch texture > `MAX_TEXTURE_SIZE` or instance buffer > limit | batch split automatically |
| `NATIVE_TOOL_MISSING` | `render_view`, `render_walkthrough`, `export_bcf` with the native renderer | no raster port or no `llull-compute` in this host | use `renderer: 'reference'`, or install the desktop app (it bundles `llull-compute`) |

## 8. Performance and robustness budgets

| Budget | Value | Basis |
| ------ | ----- | ----- |
| Opaque model draw calls (SYN-RACK-v1) | ≤ 2P + C + U = 30 | closed form, §5.2 |
| Edge-pass calls | ≤ P (LOD0 buckets only) = 13 | §5.6 |
| Shadow calls (high tier) | ≤ cascades × shadow-casting buckets = 3 × 30 | §5.6 |
| GPU bytes per instance | 76 (+4 state) InstancedMesh; BatchedMesh 1e6 ≈ 84 MB of textures | three facts T1, T2 |
| Median frame time at 1920 × 1080, orbit | targets 16.7 ms (10⁴, 10⁵), 33.3 ms (10⁶): **TBD — measure** | 60 / 30 Hz; procedure in `synthetic_pipe_rack_benchmark.json` |
| Colour profile re-apply, 10⁵ entities, 50 rules | TBD — measure (target < 200 ms, worker) | O(N m) |
| BVH build 10⁶ instances | TBD — measure (target < 1.5 s in a worker; if missed, `llull-bvh` WASM, §2.A) | binned SAH O(N log N) |
| `render_view` review 1920 × 1080 | TBD — measure with `llull render_view … --json` timing, reference and native; hard cap `VIS_RENDER_BUDGET` | 8.3 M samples |
| `render_stats` 10⁶ instances | TBD — measure (target < 500 ms; TS and `llull-compute geomq`) | BVH query + bucket counting |
| `check_review` 10⁴ issues | linear, TBD — measure | — |
| Document bytes / instance | TBD — measure; target ≤ 200 B with instance entities, ≤ 40 B with V2 instance arrays | QUALITY_GATES gate 2 metric |

Robustness:

- NaN / Inf cameras are refused (`VIS_CAMERA_INVALID`).
- Regexes are bounded (200 chars, no backreferences, evaluated on strings ≤ 1 KB).
- BCF import is size-capped (64 MB zip, 10⁴ topics) and rejects zip entries with `..` (path traversal).
- Every list result is paged (AF-12).

## 9. Test strategy

| Layer | Test | VCs |
| ----- | ---- | --- |
| unit (`tests/unit/review/`, `tests/unit/display/`) | colourRules first-match, unmatched, multi-valued tags; scheme tables load with sources + grades; report ordering | VC-VIS-01, 02, 03 |
| unit (`tests/unit/aec/industrial/pipeMarkers.test.ts`) | §5.7 table rows incl. gaps | VC-VIS-04 |
| unit (`viewpointCamera.test.ts`) | BCF example round trip (reads `data/bcf_3_0/example_viewpoint_orthogonal.bcfv`), azimuth / polar closed form, metres ↔ mm | VC-VIS-10, 11 |
| unit | section box classification, rotated box, empty warning | VC-VIS-12 |
| unit + integration (`store.dispatch`) | markups / issues / comments, undo / redo, ids deterministic, human gate (agent caller refused, signed passes) | VC-VIS-13, 14 |
| contract | BCF export validates against `visinfo.xsd` / `markup.xsd` (server test with `xmllint --schema` if present, else structural XPath checks) | VC-VIS-15 |
| unit (`renderPlan.test.ts`) | N(n), bucket count ≤ 30 at four sizes, colour-invariance, LOD thresholds and hysteresis, drawn + culled = N, BVH query = brute-force query on 10⁴ random AABBs | VC-VIS-20..23 |
| perf (`tests/perf/plantViewport.perf.ts`, Playwright, not in `npm run check`) | frame-time baselines | VC-VIS-24 |
| unit (`gltfInstancing.test.ts`) | SimpleInstancing import / export | VC-VIS-25 |
| golden (`tests/golden/`) | SC-VIS-05 digests pinned per `rendererVersion` (reference renderer only; native output is never pinned); SC-VIS-03 `render_stats` exact numbers pinned after first run | VC-VIS-30..33 |
| unit (industrial) | clash issues idempotence and framing | VC-VIS-40, 41 |
| native vs reference (`server/tests/visNativeParity.test.ts`; `llull-raster` / `llull-bvh` cargo tests in `npm run native:check`) | BVH id sets and broad-phase pairs equal to `instanceBvh.ts`; native render is non-hash and matches the reference scene | VC-VIS-60 |
| scenario replay | every `validation/plans/*.json` through `build_project` (`server/tests/packReplay09.test.ts`, like packs 07 / 08) | all SC-VIS |
| component | Review panel / redline tool dispatch the right commands (no geometry maths) | — |

Coverage gate 90/85/90/90 applies to `packages/core/src/{commands,geometry}` and `packages/domain-aec/src`.

## 10. Delivery plan

| Milestone | Content | Depends on | Effort |
| --------- | ------- | ---------- | ------ |
| VIS-M1 | `display` model, colour rules, profiles, report, `check_display`; industrial property provider; `apply_service_colour_scheme` (A13.1, ISO 14726) | plugin port review (`cad-reviewer`) | 6 d |
| VIS-M2 | `review` model: viewpoints, section boxes, markups, issues, comments, `check_review`, human gate; retire `namedViewStore` | AF-34a signature (09 PLM aerospace) | 8 d |
| VIS-M3 | `renderPlan` + `render_stats` + `PlantBatchRenderer` (R-BATCH-v1, LOD, pixel cull), SYN-RACK fixture, perf script baseline | — | 10 d |
| VIS-M4 | `render_view` perspective, viewpoint / profile / section box, review shading (shadow, AO, edges), digests | M1, M2 | 8 d |
| VIS-M5 | `create_clash_issues`; BCF 3.0 export / import | M2 | 6 d |
| VIS-M6 | viewport realism tiers (CSM, GTAO, edges), material classes, walk / fly, walkthroughs | M3 | 8 d |
| VIS-M7 | instance BVH in a worker, glTF instancing, pipe markers; measure the 10⁶ build; `llull-bvh` WASM / `llull-compute geomq` if the target is missed (RS-6) | M3; RS-0 `llull-bvh` for the native part | 7 d (+ native part inside RS-6) |
| VIS-M8 (V2) | 10⁶: streaming, Hi-Z occlusion, impostors, instance-array storage; terrain / sky / sun | 08-DAT storage decision | 15 d |
| VIS-M9 | native GPU raster (RS-5): `ctx.raster`, `llull-compute raster` for `render_view`, walkthroughs and BCF snapshots; VC-VIS-60 | M4; RS-0 | inside RS-5 (4 wk in RS1, shared with aerospace 05). **Built 2026-10-19 with the M2 / M4 / M5 / M6 slices it needs (§12).** |

Sibling dependencies:

- 01-piping-specs-catalog and 02-spec-driven-routing deliver prototype-based components and the properties `spec`,
  `insulationMm` and penetrations.
- 06-plant-structures-access delivers grating / handrail material classes.
- 08-plant-data-reports-interop delivers IFC GUIDs and the compact storage.
- 10-pointcloud-brownfield reuses viewpoints and issues for as-built review.

## 11. Open questions

1. **Q1. Plugin property port.** Add `CadPlugin.entityProperties` plus `ctx.properties` (preferred), or have each plugin
   write properties onto derived entities as `tags`? Tags duplicate data and go stale. The port is cleaner but
   touches `plugins/plugin.ts`, so `cad-reviewer` must approve.
2. **Q2. Where hazard schemes live.** In the industrial plugin (proposed), or in a new `plant` plugin shared with
   01 / 02 / 08? The decision should be taken with 01-piping-specs-catalog.
3. **Q3. Document size at 10⁶ components.** The proposal is an `instance_array` entity kind (structure-of-arrays
   positions / rotations / prototype refs), owned with 08-DAT. It is a new entity kind, so the `add-entity-kind`
   checklist applies.
4. **Q4. Clash statuses.** The Navisworks statuses (New / Active / Reviewed / Approved / Resolved) were not verified
   from a fetched source (search budget exhausted). Map them onto BCF `TopicStatus` on export only after a
   confirmed source.
5. **Q5. Display hex.** Should the owner be able to pin a corporate palette (e.g. a paint-system RAL list)? This is
   a `define_palette` command (V1) whose palette is named in every report.
6. **Q6. Determinism scope of `render_view` digests.** Per Node major version, or with an own sin / cos
   implementation for full portability? Only the reference renderer is concerned; the native renderer is non-hash
   (§2.A). **Decided at VIS-M9 (2026-10-19):** digests are pinned per `rendererVersion` (`llull-ts-raster/1`) on the
   supported Node major; an own sin / cos is not added until a digest is seen to differ across machines. The native
   CPU twin reproduces the reference RGBA bit for bit (it uses the JS rounding and V8 `hypot` of `llull-jsmath`), so
   the reference is portable to Rust already.
7. **Q7. Snapshot in BCF.** Use the `render_view` raster (deterministic), or the viewport canvas (what the human
   saw)? Proposal: reference raster by default, canvas when the export runs from the UI; the native GPU raster
   only on request (`snapshotRenderer: 'native'`, non-hash). **Decided at VIS-M9:** as proposed for the CLI: the
   reference raster by default (the `.bcf` bytes are reproducible), `snapshotRenderer: 'native'` on request. The UI
   canvas snapshot waits for the Review panel (VIS-M2 UI).

## 12. As built — VIS-M9 native raster (RS-5), 2026-10-19

VIS-M9 is built, with the minimal slices of VIS-M2 / M4 / M5 / M6 it needs (pure commands and the TypeScript
reference, CLI first; no viewport UI). Everything else in §3–§8 is still proposed.

### 12.1 What exists

| Area | As built | Files |
| ---- | -------- | ----- |
| Review model (VIS-M2 slice) | `CadDocument.review` with `viewpoints` / `viewpointOrder`, `walkthroughs`, `issues` / `issueOrder`, `nextNumber`; load validation (`reviewProblems`). Section boxes, markups, comments arrive later as optional fields (no migration). | `model/review.ts`, `commands/persistence/reviewValidation.ts` |
| Commands (metaHistory, coded refusals §7) | `save_viewpoint` (camera or `fromDocumentCamera`), `list_viewpoints`, `delete_viewpoint` (refused while used: `VIS_VIEWPOINT_IN_USE`), `create_walkthrough` / `delete_walkthrough`, `create_review_issue` (status `open`) | `commands/review/{viewpoints,walkthroughs,issues,reviewModel}.ts` |
| Camera maths | orthonormalisation, document orbit camera → viewpoint (45°), interpolation: eye linear, direction / up slerp, fov or view height linear | `geometry/viewpointCamera.ts` |
| `render_view` (VIS-M4 slice) | `projection: 'perspective'` + `fovDeg`, `viewpointId` (perspective or orthographic BCF camera; ortho `viewHeight` = visible height), `renderer: 'reference' \| 'native'`; data `renderer`, `rendererVersion`, `svgSha256` (reference) or `device` / `version` / `engine` / `deterministic: false` (native), `projection`, `viewpointId` | `commands/render/{viewRequest,viewSetup,rendererProvenance}.ts` |
| Raster seam | the old `raster.ts` split, bit-identical (svg sha256 of 7 scenes incl. caps, strokes, turntable, unsupersampled): `prepareRasterScene` (projection, Lambert colour, back-face flip, near-plane clipping) → `RasterScene` → `rasterScenePixels` (reference) or `ctx.raster` | `commands/render/{rasterScene,raster}.ts`, `model/raster.ts` |
| `ctx.raster` | `ExecutionContext.raster?: RasterPort \| null`, default context reads `setRasterPort` (`commands/rasterPort.ts`) | `commands/types.ts`, `commands/context.ts` |
| `render_walkthrough` (VIS-M6 slice) | PNG frames (`data.files`, `--save dir/`), frames = ⌊duration · fps⌋ + 1, `frameSha256[]` (reference), native frames without digests; `maxFrames` ≤ 600, 100 Mpx budget (`VIS_RENDER_BUDGET`) | `commands/render/{renderWalkthrough,frames}.ts` |
| `export_bcf` (VIS-M5 slice) | BCF 3.0 archive: `bcf.version`, `extensions.xml`, per topic `markup.bcf` + `.bcfv` (metres, vertical `FieldOfView`, `ViewToWorldScale`) + PNG snapshot; behind the export gate; `VIS_BCF_GUID_UNMAPPED` warning | `commands/exchange/bcf/{exportBcf,bcfXml}.ts`, `lib/zip.ts` |
| Native job | `llull-compute raster <folder>` with `"kind": "scene"`: flat f64 buffers → `rgba.bin`. CPU twin bit-identical to `rasterScenePixels`; wgpu fill (convex faces batched as fans, other faces even-odd via stencil INVERT + stencil-tested cover), strokes / outline / resolve on the twin. `llull-compute` `main.rs` unchanged (dispatch inside `llull_raster::run`). | `solver/crates/llull-raster/src/{scene,scene_cpu,scene_gpu}.rs` |
| Host transport | `RasterPort` running the job with `spawnSync` (commands are synchronous), hash-checked output, provenance from the NDJSON warnings; installed by the CLI and the backend only when the binary exists | `server/src/native/rasterPort.ts` |

### 12.2 Decisions

- **RasterScene is post-projection.** The TypeScript prepares screen-space polygons with their flat colour, normal,
  owner and flags; the native side only fills, depth-tests, outlines and resolves. Colour profiles, material classes,
  section boxes and review shading (VIS-M1 / M4) will extend the prepare stage, so both renderers stay one scene.
  `renderPlan` buckets / instancing in the scene wait for VIS-M3 / M7.
- **Perspective is raster-only.** Depth is z = −1/d (affine in screen space), near plane = 10⁻³ · scene radius in
  camera space (polygons and strokes clipped there); outlines compare linear depth. Grid, axes, labels, dimensions,
  image underlays and annotation text are orthographic overlays and are not drawn in perspective; turntable /
  isolate / section with perspective is `VIS_RENDER_INVALID`.
- **No silent fallback.** No port → `NATIVE_TOOL_MISSING`; a failed frame fails the command with the job's code
  (`NATIVE_TIMEOUT`, `NATIVE_PROTOCOL`, …). A GPU request that the binary drew on its CPU twin is reported
  (`engine: 'native-cpu'`, `reason`), still `deterministic: false` and without a digest.
- **Ids and GUIDs.** Review ids are `vp-<n>`, `wt-<n>`, `iss-<n>` from `review.nextNumber` (one id per command, so no
  `.<k>`). GUIDs are name-based UUIDs version 8 (sha256 of the id and content at creation, `lib/nameUuid.ts`), not v5:
  core has no SHA-1 and the GUID only needs to be stable and unique per document. BCF viewpoint GUIDs are derived
  per topic (issue GUID × viewpoint GUID).
- **Walkthrough frames are PNG** (the scene composited over the background), so their digest is `frameSha256` of
  the PNG bytes rather than `svgSha256`.
- **BCF.** 3.0 export only (`version: '2.1'` → `VIS_BCF_VERSION`); `CreationDate` is a param (default
  `1970-01-01T00:00:00Z`) because commands never read the clock. Entities have no IFC GUID yet: components are
  written with `OriginatingSystem` `llull` + `AuthoringToolId` (entity id) and the export warns.
- **Synchronous port.** The CLI and the backend block for one native frame. A walkthrough is one process per frame.

### 12.3 Measured (RTX 4080 Laptop GPU, Vulkan; shared machine with parallel jobs, so wall times are indicative)

- VC-VIS-60 (b): render_view, walkthrough frames and BCF snapshots drawn by the GPU agree with the reference at
  coverage IoU 1.0000 and mean |ΔRGB| ≤ 0.01 levels on the 5 crate fixtures and the server scenes (tolerance
  IoU ≥ 0.97, mean ≤ 8). The CPU twin is byte-identical on every case. (c) holds: reference digests are unchanged with
  a raster port installed.
- Fixed cost of one native frame: process start ≈ 0.1 s, GPU instance / device / pipelines ≈ 0.7 s. A 1600 × 1200
  scene of 8 720 polygons: GPU job ≈ 1.5 s, CPU twin job ≈ 2.0 s (both include writing `rgba.bin`), reference
  `render_view` ≈ 1.1 s in process; 2000 × 2000: reference 1.3 s, native 2.0 s. **So the native path is not faster for
  single renders today**; its value is the GPU seam for the review shading of VIS-M4 / M6 (shadows, AO) and large
  batches. Follow-up: a multi-frame job (one process and one device per walkthrough or BCF export).

### 12.4 Known limits and follow-ups (from the VIS-M9 review)

- `delete_review_issue` exists, so a viewpoint used by an issue can be freed. Ids are de-duplicated on create and
  export; entities deleted after an issue was opened are left out of the BCF selection.
- GUIDs are unique per document, not across documents: two documents whose first issue has the same title share a
  topic GUID. A document identity salt (or a `namespace` param) is a follow-up before BCF round trips (`import_bcf`).
- The synchronous port blocks the backend's event loop for each native frame. A native walkthrough through
  `POST /command` can stall live sync for its whole duration. Follow-up: a total native-time budget, or one batched
  job per walkthrough / export.
- Perspective strokes are clipped at the near plane only. A stroke ending next to the eye can project far
  off-screen, and `strokeSegment` then walks every pixel step of it. Follow-up: clip to the buffer rectangle in the
  prepare stage (both twins read the same buffers, so parity holds).
- Windows build of `--features gpu` on a machine without MSVC: `solver/scripts/dlltool-shim` (GNU toolchain) makes
  wgpu link. With it, the `gpu`-feature scene test intermittently ended with an access violation when run with
  output capture: about 1 run in 3, 0 of 6 with `--nocapture`, 0 of 4 full workspace runs. The production binary was
  stable: 12 / 12 renders, the server suite and the CLI. This still has to be reproduced on an MSVC toolchain to rule
  out the stand-in.

### 12.5 Not built yet (remaining VIS work)

VIS-M1 (display / colour profiles), the rest of VIS-M2 (section boxes, markups, comments, status workflow,
`check_review`, `apply_viewpoint`, `get_viewpoint`, UI), VIS-M3 (`renderPlan`, `render_stats`), the rest of VIS-M4
(profile / section-box / review shading, `visibleEntityIds`, `VIS_RENDER_BUDGET` on render_view), the rest of VIS-M5
(`create_clash_issues`, `import_bcf`, single-viewpoint BCF commands, XSD validation VC-VIS-15), VIS-M6 viewport tiers
and walk / fly, VIS-M7, VIS-M8. VC-VIS-60 (a) belongs to RS-6 (`llull-bvh`).

## 13. References

- [R1]–[R15]: see [`FUNCTIONAL_SPEC.md` §11](FUNCTIONAL_SPEC.md#11-references).
- [R16] three-mesh-bvh 0.9.16 (npm, MIT): README (BatchedMesh BVH, ObjectBVH frustum culling) — https://registry.npmjs.org/three-mesh-bvh/-/three-mesh-bvh-0.9.16.tgz (downloaded 2026-10)
- [R17] @react-three/drei 10.7.9 (npm, MIT): `Detailed`, `Instances`, `PerformanceMonitor`, `AdaptiveDpr`, `Bvh`, `Edges` — https://registry.npmjs.org/@react-three/drei/-/drei-10.7.9.tgz (downloaded 2026-10)
- [R18] ral-colors 1.0.1 (npm, MIT): RAL classic table used only for display approximations — https://registry.npmjs.org/ral-colors/-/ral-colors-1.0.1.tgz (downloaded 2026-10)
- [R19] llull `docs/QUALITY_GATES.md` (proposed gates 2 and 4) and `docs/INDUSTRIAL.md` (clash coordination).
- [R20] RS1 native compute programme — [../../decisions/RS1-native-compute.md](../../decisions/RS1-native-compute.md); wgpu https://crates.io/crates/wgpu (version recorded at RS-0)
