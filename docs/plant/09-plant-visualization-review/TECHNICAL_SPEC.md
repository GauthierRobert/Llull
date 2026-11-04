# Gap 09 VIS — Plant visualization and model review: technical specification

Status: proposed (2026-10-18). Functional view: [`FUNCTIONAL_SPEC.md`](FUNCTIONAL_SPEC.md). Validation:
[`validation/README.md`](validation/README.md). Laws: [`.claude/rules/architecture.md`](../../../.claude/rules/architecture.md).

## 1. Current state in llull (before this gap)

### 1.1 Viewport (three.js / r3f, `src/ui/viewport/3d/`)

| Area              | What exists                                                                                                                                                                                                                                                                                                                  | Limit for plant scale                                                                                                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instancing        | `grouping.ts` `entityRenderKey` batches `box` / `cylinder` / `sphere` with identical params (6 significant digits), **colour**, layer and material into one `InstancedMesh` (`InstancedRenderer.tsx`, `instanceWriter.ts`: per-instance matrix + colour, selection tint).                                                    | Every other kind (meshes from `add_pipe_run` sweeps, extrusions, B-rep, instance children) renders per entity: 1 draw call each. Colour in the key splits batches by service.                        |
| Instances         | `Entities.tsx` `InstanceEntityRenderer` expands a component instance (`expandInstance`) and renders each child through the per-entity path.                                                                                                                                                                                  | A catalogue part used 10⁴ times costs 10⁴ × children draw calls.                                                                                                                                     |
| LOD               | `lodSegments.ts`: a static radial segment count from the entity size (8..64). Its header says "no three.js LOD objects / per-frame checks".                                                                                                                                                                                  | No distance LOD, no impostors, no pixel-size culling.                                                                                                                                                |
| Culling / picking | three.js per-object frustum culling; `bvhSetup.ts` patches `Mesh.raycast` with three-mesh-bvh. Its header says "InstancedMesh is not patched … instance counts stay < 10k".                                                                                                                                                  | No instance-level culling or BVH; `InstancedMesh` culls as a whole (fact T1).                                                                                                                        |
| Quality           | `useRenderQuality.ts`: tier high / medium / low from the entity count (≤ 50, ≤ 200, else low); budget "≤ 16 ms median frame at 500 entities". `SceneLighting.tsx`: drei `Environment` + `Lightformer`, `SoftShadows` (PCSS), baked `ContactShadows`, key light sized to the scene. ACES tone mapping (`Viewport3D.tsx`).     | No SSAO, no edges overlay in shaded mode, no material classes beyond `Material` colour / metalness / roughness / procedural `finish`.                                                                |
| Materials         | `useMaterialProps.ts`, `useFinishTextures.ts`, `displayMetalness.ts`; `Material` in `packages/core/src/model/types.ts` (color, metalness, roughness, finish).                                                                                                                                                                | Fine for PBR; no plant material-class library.                                                                                                                                                       |
| Camera            | `PerspectiveCamera` FOV `VIEWPORT_FOV_DEGREES` = 45 (`packages/core/src/model/viewport.ts`), `OrbitControls`, floating origin (`floatingOrigin.ts`), document camera `CameraState {target, azimuth, polar, distance}` written by `set_camera` / `fit_view` (`packages/core/src/commands/document/camera.ts`, `metaHistory`). | Orbit only; no walk / fly.                                                                                                                                                                           |
| Bookmarks         | `NamedViews.tsx` + `src/ui/store/namedViewStore.ts`: "persisted to localStorage; UI-only, never in the CadDocument".                                                                                                                                                                                                         | Not shareable, not reachable by CLI / MCP: violates the "persisted ⇒ command" rule for this gap. **Retired at VIS-M2 (§12.7).**                                                                      |
| Section           | `ClippingPlane.tsx` + `clipPlaneMath.ts`: one axis-aligned plane in UI store (`clipPlane`).                                                                                                                                                                                                                                  | No box, not saved.                                                                                                                                                                                   |
| Colour            | Per-entity `color`; layer colours (`Layer.color`); industrial category layers in `packages/domain-aec/src/building/evaluate/entities.ts` (`P-PIPE` #2f9c8f, `P-SUPP` #c9a227, …); `evaluatePipe` (`packages/domain-aec/src/industrial/evaluate.ts`) colours a pipe by **material** (`colorForMaterial`), not by service.     | No property-driven colour. No command re-colours an existing entity: the edit catalogue (`packages/core/src/commands/edit/`) has none; `assign_material` changes appearance only through a material. |

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

| Area       | What exists                                                                                                                                                                                                                                                                                                                                          |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clash      | `check_clashes` (`packages/domain-aec/src/industrial/clash/clash.ts`): read-only, `data = { clashes: Clash[] }` with `{a, b, kind: 'hard' \| 'clearance', depth}`. The Building panel lists the rows.                                                                                                                                                |
| Review     | `packages/core/src/commands/review/` (`intents.ts`, `grounding.ts`): interference intents (`allow_interference`) in `doc.prototype`, with `declaredBy: 'agent'` because `ExecutionContext` has no caller yet. Viewpoints, issues and comments do not exist.                                                                                          |
| glTF       | `export_gltf` (`packages/core/src/commands/exchange/gltfScene.ts`): one node + mesh per part, one material per appearance; `instancing: "expand"` (default) shares a mesh between identical parts, `instancing: "gpu"` writes one `EXT_mesh_gpu_instancing` node per prototype (VIS-M8a, §12.15). No `import_gltf` exists (import is `import_mesh`). |
| Site       | civil plugin (`packages/domain-aec/src/civil/`): `create_surface`, `surface_report`, `import_survey_points`, `set_coordinate_system`, `design_site`. Surfaces render as entities. No sky or sun.                                                                                                                                                     |
| Perf gates | `docs/QUALITY_GATES.md` lists **proposed** gate 2 "Performance budgets" (median frame time while orbiting, +20 % regression) and gate 4 "Visual regression". Neither is implemented.                                                                                                                                                                 |

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
  `namedViewStore.ts` is retired at VIS-M2 and old bookmarks are not imported (owner rule: no backward compatibility, §12.7).
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

| Item                                                               | Before                                                              | Now                                                                                                                                                                                                |
| ------------------------------------------------------------------ | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Headless `render_view`, `render_walkthrough`, BCF snapshots        | pure-TS software raster (`packages/core/src/commands/render/`) only | the TS raster stays the default and the **hash reference**; `renderer: 'native'` draws the same scene on the GPU with `llull-compute raster` (crate `llull-raster`, wgpu offscreen)                |
| Instance BVH, `render_stats` at 10⁶, model-scale clash broad phase | `geometry/instanceBvh.ts` (TS, worker above 10⁴)                    | `instanceBvh.ts` stays the reference; the shared `llull-bvh` crate is an option: native through `llull-compute geomq` for the CLI, WASM in the viewport worker if the TS build misses 1.5 s at 10⁶ |
| Viewport                                                           | three.js WebGL                                                      | unchanged                                                                                                                                                                                          |
| Gate                                                               | Vitest                                                              | plus `npm run native:check` (`cargo test` + `cargo clippy -D warnings`) for `llull-raster` and `llull-bvh`                                                                                         |

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
  (industrial plugin) use it only above a size threshold fixed at VIS-M7 (measured, §12.13: `render_stats` from 500 000 instances on a repeated call, `check_clashes` from 64 solids). The narrow phase
  (oriented-box SAT) stays TS. No port → the TS path, with the same result.
- **Viewport.** `instanceBvh.ts` runs in a worker. If VIS-M7 measures the 10⁶ build above 1.5 s, `llull-bvh` compiled
  to WASM replaces it in the worker, under the same exact-equality test. The decision is recorded at VIS-M7.

Native vs reference: VC-VIS-60 (validation README).

### 2.1 Technical requirements

| Id        | Pri    | Requirement                                                                                                                                                               | FR            | AF                |
| --------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ----------------- |
| TR-VIS-01 | MUST   | Pure first-match colour-rule engine `geometry/colourRules.ts` (§5.1); a cached result per (profile, entities identity)                                                    | FR-VIS-01     | AF-13             |
| TR-VIS-02 | MUST   | Property port: `CadPlugin.entityProperties` + `ctx.properties`; industrial provider for pipes / equipment (§3.3, §3.4)                                                    | FR-VIS-01     | AF-01             |
| TR-VIS-03 | MUST   | Scheme tables as data with source ids and grades; reports carry category names, `palette` and `approximate: true`; hazard profiles start `reviewRequired`                 | FR-VIS-02, 03 | AF-30, 31, 33, 35 |
| TR-VIS-04 | SHOULD | A13.1 legend band and placement algorithm (§5.7) with a check command                                                                                                     | FR-VIS-04     | AF-20, 33         |
| TR-VIS-10 | MUST   | `review` model; viewpoint commands `metaHistory`, ids from `review.nextNumber` (deterministic)                                                                            | FR-VIS-05     | AF-05, 13         |
| TR-VIS-11 | MUST   | Viewpoint ⇄ `CameraState` ⇄ BCF camera conversion (§5.3)                                                                                                                  | FR-VIS-05     | AF-13             |
| TR-VIS-12 | SHOULD | BCF 3.0 writer / reader (2.1 read), units and GUID mapping, schema-valid output (§6)                                                                                      | FR-VIS-09     | AF-12             |
| TR-VIS-13 | MUST   | Section-box classification and rendering conventions (§5.4)                                                                                                               | FR-VIS-06     | AF-21             |
| TR-VIS-14 | MUST   | Markups, issues and comments as document data; undo / redo; replay-stable ids                                                                                             | FR-VIS-07, 08 | AF-13             |
| TR-VIS-15 | MUST   | Issue workflow with the human gate (§5.5)                                                                                                                                 | FR-VIS-07     | AF-34, 34a        |
| TR-VIS-16 | MUST   | `check_review` / `check_display` with the codes of §7                                                                                                                     | FR-VIS-10     | AF-11, 20         |
| TR-VIS-20 | MUST   | `geometry/renderPlan.ts` R-BATCH-v1 (§5.2), shared by the viewport and `render_stats`                                                                                     | FR-VIS-12, 13 | AF-21             |
| TR-VIS-21 | MUST   | LOD metric, thresholds `lod:llull-v1`, hysteresis (§5.3)                                                                                                                  | FR-VIS-12     | —                 |
| TR-VIS-22 | MUST   | Instance bookkeeping (drawn + culled = N) and GPU byte estimate                                                                                                           | FR-VIS-13     | AF-10             |
| TR-VIS-23 | SHOULD | Static instance BVH (binned SAH) for frustum culling and picking, built in a worker above 10⁴ (`instanceBvh.ts` is the reference)                                         | FR-VIS-14     | AF-40             |
| TR-VIS-26 | SHOULD | Optional `llull-bvh` path (native `llull-compute geomq` through `ctx.spatialIndex`, or WASM in the viewport worker) returning the same id sets as `instanceBvh.ts` (§2.A) | FR-VIS-13, 14 | AF-13             |
| TR-VIS-24 | COULD  | Hi-Z occlusion, tiled streaming, impostors (V2)                                                                                                                           | FR-VIS-14     | —                 |
| TR-VIS-25 | SHOULD | glTF `EXT_mesh_gpu_instancing` export / import                                                                                                                            | FR-VIS-19     | AF-12             |
| TR-VIS-30 | MUST   | `render_view` determinism on the reference (TS) renderer: `svgSha256`, `rendererVersion`                                                                                  | FR-VIS-16     | AF-13, 22         |
| TR-VIS-31 | MUST   | Perspective projector with perspective-correct depth                                                                                                                      | FR-VIS-16     | AF-22             |
| TR-VIS-32 | SHOULD | Review shading: material-class Blinn–Phong, sun shadow, deterministic AO, edges, sky / ground (§5.6)                                                                      | FR-VIS-15, 16 | AF-22             |
| TR-VIS-33 | SHOULD | Viewport quality tiers keyed by drawn instances; material classes (§5.6)                                                                                                  | FR-VIS-15     | —                 |
| TR-VIS-34 | SHOULD | Native GPU raster (`renderer: 'native'`, `llull-compute raster` through `ctx.raster`): non-hash, `deterministic: false`, `device` in `data` (§2.A)                        | FR-VIS-16, 17 | AF-22, 35         |
| TR-VIS-40 | MUST   | `create_clash_issues` with framing (§5.8) and `clashKey` idempotence                                                                                                      | FR-VIS-11     | AF-13             |
| TR-VIS-41 | MUST   | Clash re-run reconciliation: `created`, `unchanged`, `updated` (depth) and `gone` (clash no longer reported) in `data`                                                    | FR-VIS-11     | AF-10             |
| TR-VIS-42 | SHOULD | Walkthrough paths and frame rendering (§5.3)                                                                                                                              | FR-VIS-17     | AF-22, 40         |
| TR-VIS-50 | MUST   | Stable `VIS_*` codes with ids / paths / remediation on every refusal and check (§7)                                                                                       | FR-VIS-20     | AF-11             |

## 3. Data model

### 3.1 Display (core, `model/display.ts`)

```ts
export type PropertyValue = string | number | boolean;

/** Predicate on the entity property bag; all present clauses must hold (AND). `any` = OR of sub-predicates. */
export interface RulePredicate {
  readonly property?: string; // e.g. 'service', 'line', 'dn', 'layerId', 'kind', 'tag', 'materialClass'
  readonly equals?: PropertyValue;
  readonly in?: readonly PropertyValue[];
  readonly matches?: string; // case-insensitive regex, max 200 chars, compiled once, no backrefs
  readonly range?: readonly [number, number]; // inclusive, numbers only
  readonly any?: readonly RulePredicate[];
}

export interface ColourRule {
  readonly id: string; // stable within the profile
  readonly when: RulePredicate;
  readonly appearance: {
    readonly colour: string; // '#rrggbb' or 'scheme:<schemeId>/<category>' resolved through a palette
    readonly transparency?: number; // 0..1
    readonly hidden?: boolean;
  };
  readonly legend: string; // e.g. 'Water (A13.1: white on green)'
  readonly scheme?: { readonly id: 'asme_a13_1' | 'iso_14726' | 'bs_1710' | 'din_2403'; readonly rowId: string };
}

export interface ColourProfile {
  readonly id: string;
  readonly name: string;
  readonly rules: readonly ColourRule[]; // evaluated in order; first match wins (E3D / Navisworks semantics)
  readonly defaultAppearance: { readonly colour: 'entity' | string; readonly transparency?: number };
  readonly palette: string; // 'llull-ral-approx-v1' (named default, approximate: true)
  readonly reviewRequired: boolean; // true when built from a hazard scheme and not yet signed
}

export interface DisplayModel {
  colourProfiles: Record<string, ColourProfile>;
  activeProfileId?: string;
  materialClasses: Record<MaterialClassId, MaterialClass>; // seeded with the named defaults of §5.6
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
  min: Vec3;
  max: Vec3; // document units, min < max per axis
  rotationZ?: number; // radians about the box centre
  planes?: ReadonlyArray<{ normal: Vec3; offset: number }>; // alternative: 1..6 half-spaces, normal points to the removed side (BCF)
}

export interface Viewpoint {
  readonly id: string; // 'vp-<n>.<k>'
  readonly guid: string; // RFC 4122 v5 from (document id, id): stable for BCF
  name: string;
  camera: ViewpointCamera;
  sectionBoxId?: string;
  colourProfileId?: string;
  visibility?: { defaultVisible: boolean; exceptions: readonly EntityId[] }; // BCF Visibility
  selection?: readonly EntityId[];
  realism?: { mode: 'orbit' | 'walk' | 'fly'; eyeHeight?: number; gravity?: boolean; collision?: boolean };
}

export type MarkupShape = 'line' | 'polyline' | 'arrow' | 'cloud' | 'ellipse' | 'text';
export interface Markup {
  readonly id: string; // 'mk-<n>.<k>'
  readonly viewpointId: string;
  shape: MarkupShape;
  space: 'screen' | 'world'; // screen: points in [0,1]² of the viewpoint image; world: Vec3 (BCF Lines)
  points: ReadonlyArray<Vec2 | Vec3>;
  colour: string;
  text?: string;
  lineWidthPx?: number;
  author: 'agent' | 'human';
  createdStep: number;
}

export type IssueStatus = 'open' | 'in_progress' | 'resolved' | 'closed';
export interface ReviewIssue {
  readonly id: string; // 'iss-<n>.<k>'
  readonly guid: string;
  title: string;
  type: string;
  priority: 'low' | 'normal' | 'high' | 'critical';
  status: IssueStatus;
  assignedTo?: string;
  labels: readonly string[];
  dueDate?: string; // ISO 8601 date
  viewpointIds: readonly string[];
  entityIds: readonly EntityId[];
  clashKey?: string; // 'clash:<sorted a>|<sorted b>|<kind>' (idempotence)
  history: ReadonlyArray<{ status: IssueStatus; by: 'agent' | 'human'; reason: string; signatureId?: string }>;
}

export interface ReviewComment {
  readonly id: string;
  readonly issueId: string;
  text: string;
  viewpointId?: string; // BCF agreement: a comment refers to at most one viewpoint
  author: 'agent' | 'human';
}

export interface Walkthrough {
  readonly id: string;
  name: string;
  keys: ReadonlyArray<{ viewpointId: string; seconds: number }>;
}

export interface ReviewModel {
  viewpoints: Record<string, Viewpoint>;
  viewpointOrder: string[];
  sectionBoxes: Record<string, SectionBox>;
  markups: Record<string, Markup>;
  issues: Record<string, ReviewIssue>;
  issueOrder: string[];
  comments: Record<string, ReviewComment>;
  walkthroughs: Record<string, Walkthrough>;
  nextNumber: number; // review id counter (metaHistory ⇒ not the feature-step counter)
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

| Command                                         | Kind                             | Params (zod sketch; lengths in document units unless stated)                                                                                                                                                                                                                                                                         | Result `data`                                                                                                                                                                                     | @affects / @invariant / @failure                                                                                                                               |
| ----------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `define_colour_profile`                         | mutating                         | `id`, `name`, `rules: ColourRule[]` (1..256), `defaultColour?: 'entity' \| hex`, `replace?`                                                                                                                                                                                                                                          | `{profileId, ruleCount}`                                                                                                                                                                          | adds / replaces `display.colourProfiles[id]` · rule ids unique, regex compiles, colours valid · `VIS_RULE_INVALID`, `VIS_COLOUR_INVALID`, `VIS_PROFILE_EXISTS` |
| `set_active_colour_profile`                     | mutating                         | `profileId \| null`                                                                                                                                                                                                                                                                                                                  | `{active}`                                                                                                                                                                                        | sets `display.activeProfileId` · geometry untouched · `VIS_PROFILE_NOT_FOUND`                                                                                  |
| `delete_colour_profile`                         | mutating                         | `profileId`                                                                                                                                                                                                                                                                                                                          | —                                                                                                                                                                                                 | removes; refused while a viewpoint references it (`VIS_PROFILE_IN_USE`)                                                                                        |
| `colour_by_rule_report`                         | query                            | `profileId?` (default active), `entityIds?`, `groupBy?: 'rule' \| 'entity' \| 'property'`, `groupProperty?`, `limit?`                                                                                                                                                                                                                | `{palette, approximate: true, groups: {key: {ruleId, category, fieldColour, letterColour, displayHex, count, ids}}, legend[], unmatched: ids, warnings[]}`                                        | read-only · deterministic order (rule order, then id) · `VIS_COLOUR_UNMATCHED` (warn)                                                                          |
| `check_display`                                 | query                            | —                                                                                                                                                                                                                                                                                                                                    | `{status, issues[{code, ids, remediation}]}`                                                                                                                                                      | read-only · unmatched entities, profiles referencing unknown properties, `reviewRequired` profiles in use                                                      |
| `set_section_box`                               | mutating                         | `min`, `max`, `rotationZ?`, `planes?`, `name`, `id?`                                                                                                                                                                                                                                                                                 | `{id}`                                                                                                                                                                                            | adds `review.sectionBoxes` · min < max · `VIS_SECTION_BOX_INVALID`                                                                                             |
| `delete_section_box`                            | mutating                         | `id`                                                                                                                                                                                                                                                                                                                                 | —                                                                                                                                                                                                 | refused while referenced (`VIS_SECTION_BOX_IN_USE`)                                                                                                            |
| `section_box_report`                            | query                            | `id`                                                                                                                                                                                                                                                                                                                                 | `{inside[], crossing[], outside[], counts}`                                                                                                                                                       | exact AABB (or OBB for rotationZ) classification, §5.4 · `VIS_SECTION_BOX_EMPTY` (warn)                                                                        |
| `save_viewpoint`                                | mutating                         | `name`, `camera?: ViewpointCamera` \| `fromDocumentCamera?: true`, `sectionBoxId?`, `colourProfileId?`, `visibility?`, `selection?`, `realism?`, `id?`                                                                                                                                                                               | `{id, guid, camera}`                                                                                                                                                                              | adds viewpoint · camera orthonormal ± 1e-6 (normalised on save, original kept within tolerance) · `VIS_CAMERA_INVALID`, `VIS_VIEWPOINT_NOT_ORTHONORMAL`        |
| `update_viewpoint` / `delete_viewpoint`         | mutating                         | `id`, fields                                                                                                                                                                                                                                                                                                                         | —                                                                                                                                                                                                 | delete cascades to markups; refused while an issue references it unless `force` (`VIS_VIEWPOINT_IN_USE`)                                                       |
| `apply_viewpoint`                               | mutating (camera + display only) | `id`                                                                                                                                                                                                                                                                                                                                 | `{camera: CameraState, activeProfileId, sectionBoxId}`                                                                                                                                            | writes `doc.camera` (§5.3), active profile, active section box · `VIS_VIEWPOINT_NOT_FOUND`                                                                     |
| `get_viewpoint` / `list_viewpoints`             | query                            | `id` / `limit?`                                                                                                                                                                                                                                                                                                                      | viewpoint(s) with markups count                                                                                                                                                                   | —                                                                                                                                                              |
| `add_markup` / `delete_markup`                  | mutating                         | `viewpointId`, `shape`, `space`, `points` (2..256), `colour`, `text?`, `lineWidthPx?`                                                                                                                                                                                                                                                | `{id}`                                                                                                                                                                                            | screen points in [0,1] · `VIS_MARKUP_INVALID`, `VIS_VIEWPOINT_NOT_FOUND`                                                                                       |
| `create_review_issue`                           | mutating                         | `title`, `type`, `priority`, `viewpointIds?`, `entityIds?`, `labels?`, `assignedTo?`, `dueDate?`                                                                                                                                                                                                                                     | `{id, guid}`                                                                                                                                                                                      | status `open` · ids exist · `VIS_ENTITY_NOT_FOUND`, `VIS_VIEWPOINT_NOT_FOUND`                                                                                  |
| `add_review_comment`                            | mutating                         | `issueId`, `text`, `viewpointId?`                                                                                                                                                                                                                                                                                                    | `{id}`                                                                                                                                                                                            | `VIS_ISSUE_NOT_FOUND`                                                                                                                                          |
| `set_issue_status`                              | mutating                         | `issueId`, `status`, `reason`, `signature?`                                                                                                                                                                                                                                                                                          | `{status, history}`                                                                                                                                                                               | transitions §5.5; `closed` (and re-open from `closed`) needs a human signature or session (AF-34a) · `VIS_ISSUE_STATUS_INVALID`, `VIS_HUMAN_GATE`              |
| `check_review`                                  | query                            | `includeInfo?`                                                                                                                                                                                                                                                                                                                       | `{status: pass\|warn\|fail, issues[{code, ids, paths, remediation}], counts}`                                                                                                                     | read-only (AF-20)                                                                                                                                              |
| `create_clash_issues`                           | mutating                         | `source: 'check_clashes' \| 'check_assembly'`, `sourceParams?`, `margin` (default 500 mm, named), `priority?`                                                                                                                                                                                                                        | `{created, unchanged, issueIds[]}`                                                                                                                                                                | runs the read-only source via `ctx.registry` execute, reads `data.clashes[] {a, b, kind, depth}` · idempotent on `clashKey` · `VIS_CLASH_SOURCE_INVALID`       |
| `create_walkthrough` / `delete_walkthrough`     | mutating                         | `name`, `keys: {viewpointId, seconds > 0}[]` (2..500)                                                                                                                                                                                                                                                                                | `{id, durationS}`                                                                                                                                                                                 | `VIS_WALKTHROUGH_INVALID`                                                                                                                                      |
| `render_walkthrough`                            | query                            | `id`, `fps` (1..30), `width`, `height`, `maxFrames` (≤ 600), `renderer?: 'reference' \| 'native'`                                                                                                                                                                                                                                    | `{frames, svgSha256[]}` (reference; native frames carry no digest); frames written with `--save dir/`                                                                                             | camera slerp between keys (§5.3) · `NATIVE_TOOL_MISSING`                                                                                                       |
| `export_bcf`                                    | query                            | `issueIds?`, `version: '3.0' \| '2.1'`, `snapshots?: boolean`, `snapshotRenderer?: 'reference' \| 'native'`                                                                                                                                                                                                                          | `{bytes, sha256, topics}`; bcfzip via `--save`                                                                                                                                                    | metres + degrees · `VIS_BCF_GUID_UNMAPPED` (warn)                                                                                                              |
| `import_bcf`                                    | mutating                         | `bcf: base64` (CLI `@file`), `mergePolicy: 'skip' \| 'update'`                                                                                                                                                                                                                                                                       | `{topics, viewpoints, comments, warnings}`                                                                                                                                                        | `VIS_BCF_PARSE`, `VIS_BCF_VERSION`                                                                                                                             |
| `export_bcf_viewpoint` / `import_bcf_viewpoint` | query / mutating                 | `id` / `visualizationInfo: string`, `name`                                                                                                                                                                                                                                                                                           | `{visualizationInfo, camera: {cameraViewPointM, …}}` / `{id}`                                                                                                                                     | single-viewpoint form for tests and plans                                                                                                                      |
| `render_stats`                                  | query                            | `viewpointId?` \| `view` / `direction` / `target`, `projection`, `fovDeg?`, `width`, `height`, `quality?`, `multiDraw?: boolean` (default true)                                                                                                                                                                                      | `{componentCount, buckets[{prototypeKey, lod, instances}], opaqueModelCalls, edgeCalls, shadowCalls, culled{frustum, pixel}, instancesDrawnPlusCulled, triangles, gpuBytesEstimate, planVersion}` | read-only; same `renderPlan` as the viewport                                                                                                                   |
| `render_view` (extended)                        | query                            | existing + `projection: 'orthographic' \| 'perspective'`, `fovDeg`, `viewpointId`, `colourProfileId`, `sectionBoxId`, `shading: 'flat' \| 'review'`, `edges`, `shadows`, `ambientOcclusion`, `sun?: {azimuthDeg, elevationDeg}`, `background: 'dark' \| 'light' \| css`, `renderer: 'reference' \| 'native'` (default `'reference'`) | existing + `svgSha256` (reference only), `rendererVersion`, `projection`, `visibleEntityIds` (bounded), `legend`; native adds `renderer`, `device`, `deterministic: false`                        | deterministic per `rendererVersion` (reference) · `VIS_RENDER_BUDGET` when pixels × supersample > 16 M · `NATIVE_TOOL_MISSING`                                 |
| `list_service_colour_schemes` (industrial)      | query                            | `scheme?`                                                                                                                                                                                                                                                                                                                            | rows with `sources[]`, `grade`, `conflict?`                                                                                                                                                       | read-only                                                                                                                                                      |
| `apply_service_colour_scheme` (industrial)      | mutating                         | `scheme`, `profileId`, `serviceMap: Record<serviceText, category>`, `property?: 'service'` (default), `activate?`, `markerLetters?: boolean`                                                                                                                                                                                         | `{profileId, mapped, unmapped[], reviewRequired: true}`                                                                                                                                           | builds a `ColourProfile` (one rule per mapped service, ordered by the map) · `VIS_SCHEME_UNKNOWN`, `VIS_SCHEME_CATEGORY_UNKNOWN`                               |
| `add_pipe_markers` (industrial)                 | mutating                         | `lineIds? \| all`, `scheme: 'asme_a13_1'`, `spacing?` (default 7620 mm, named, grade B), `insulationMm?`                                                                                                                                                                                                                             | `{markers, perLine}`                                                                                                                                                                              | decals on pipe segments; legend from §5.7 · `VIS_MARKER_NO_OD`, `VIS_MARKER_BAND_INTERPOLATED` (warn)                                                          |
| `check_pipe_markers` (industrial)               | query                            | `lineIds?`                                                                                                                                                                                                                                                                                                                           | `{status, rows[{line, odIn, fieldLengthMm, letterHeightMm, bandInterpolated, markers, missingAt[]}]}`                                                                                             | read-only (AF-20)                                                                                                                                              |

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

| From \ to   | open          | in_progress   | resolved      | closed    |
| ----------- | ------------- | ------------- | ------------- | --------- |
| open        | —             | agent / human | agent / human | **human** |
| in_progress | agent / human | —             | agent / human | **human** |
| resolved    | agent / human | agent / human | —             | **human** |
| closed      | **human**     | —             | —             | —         |

Human = a signature with a human-held key, or an authenticated human session (AF-34a). `ctx.caller` alone only
selects the message. Each transition appends to `history` with `by`, `reason` and `signatureId`. Exported BCF
`TopicStatus` uses the same four words. Mapping to Navisworks clash statuses is an open question (§11).

### 5.6 Material classes and realistic display (TR-VIS-30..33)

`MaterialClassId` and its named defaults `matclass:llull-v1` give a base colour, metalness and roughness. They are
llull choices, not standard values, and are editable with `create_material`:

| Class                           | Base colour (display)                   | Metalness | Roughness | Notes                                                             |
| ------------------------------- | --------------------------------------- | --------- | --------- | ----------------------------------------------------------------- |
| `structural_steel_painted`      | per paint system (default from profile) | 0.1       | 0.6       | red portal / grey steel in the reference images is a paint colour |
| `galvanized_steel`              | `#a5a8a6` (RAL 9006 approx)             | 0.8       | 0.45      | grating, handrail                                                 |
| `carbon_steel_pipe_painted`     | service colour (profile)                | 0.1       | 0.5       |                                                                   |
| `stainless_steel`               | `#c0c4c8`                               | 0.9       | 0.3       |                                                                   |
| `insulation_cladding_aluminium` | `#c9ccce`                               | 0.85      | 0.35      | jacketed lines                                                    |
| `concrete`                      | `#9a9a96`                               | 0.0       | 0.9       | foundations, base slab                                            |
| `grating`                       | `#8f999f`                               | 0.7       | 0.5       | alpha-tested pattern (procedural finish)                          |
| `cast_steel_valve`              | profile / `#2f5fa8`                     | 0.3       | 0.5       | blue valves in the reference image are a paint choice             |
| `alloy_bolting`                 | `#3a3a3a`                               | 0.6       | 0.5       |                                                                   |
| `frp`                           | `#6f8f6a`                               | 0.0       | 0.7       |                                                                   |

Viewport by quality tier, extending `useRenderQuality.ts`. The tier is chosen by the **instance count drawn** from
`render_stats`, not by `document.order.length`.

| Tier   | Shadows                                 | Ambient occlusion                             | Edges                                 | Environment |
| ------ | --------------------------------------- | --------------------------------------------- | ------------------------------------- | ----------- |
| high   | 3-cascade CSM (three addon `CSM`) 2048² | GTAO half resolution (three addon `GTAOPass`) | screen-space normal / depth edge pass | IBL         |
| medium | 2 cascades 1024²                        | SSAO quarter resolution                       | LOD0 buckets only                     | IBL         |
| low    | none (contact shadow off)               | off                                           | off                                   | IBL         |

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

| Pipe                     | OD mm | OD in  | Row           | Field mm | Letters mm | Interpolated |
| ------------------------ | ----- | ------ | ------------- | -------- | ---------- | ------------ |
| DN20                     | 26.9  | 1.059  | 0.75–1.25     | 203.2    | 12.7       | no           |
| DN25                     | 33.7  | 1.327  | (gap) → 1.5–2 | 203.2    | 19.05      | yes          |
| DN50                     | 60.3  | 2.374  | (gap) → 2.5–6 | 304.8    | 31.75      | yes          |
| DN100                    | 114.3 | 4.500  | 2.5–6         | 304.8    | 31.75      | no           |
| DN100 + 50 mm insulation | 214.3 | 8.437  | 8–10          | 609.6    | 63.5       | no           |
| DN150                    | 168.3 | 6.626  | (gap) → 8–10  | 609.6    | 63.5       | yes          |
| DN200                    | 219.1 | 8.626  | 8–10          | 609.6    | 63.5       | no           |
| DN300                    | 323.9 | 12.752 | > 10          | 812.8    | 88.9       | no           |

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

| Code                                                 | Raised by                                                                  | Meaning                                                                     | Remediation                                                                          |
| ---------------------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `VIS_PROFILE_NOT_FOUND`                              | profile / report / render commands                                         | unknown profile id                                                          | `list` profiles via `check_display`, or `define_colour_profile`                      |
| `VIS_PROFILE_EXISTS`                                 | `define_colour_profile`                                                    | id taken                                                                    | pass `replace: true`                                                                 |
| `VIS_PROFILE_IN_USE`                                 | `delete_colour_profile`                                                    | a viewpoint references it                                                   | update or delete the viewpoint first                                                 |
| `VIS_RULE_INVALID`                                   | `define_colour_profile`                                                    | bad predicate (unknown operator, regex > 200 chars or invalid, range a > b) | fix the rule at `paths`                                                              |
| `VIS_COLOUR_INVALID`                                 | profile commands, `add_markup`                                             | not `#rrggbb` nor `scheme:<id>/<category>`                                  | use a hex colour or a listed category                                                |
| `VIS_COLOUR_UNMATCHED` (warn)                        | report, `check_display`                                                    | entities fell through to the default                                        | extend `serviceMap` / rules, or accept the default                                   |
| `VIS_SCHEME_UNKNOWN` / `VIS_SCHEME_CATEGORY_UNKNOWN` | `apply_service_colour_scheme`                                              | scheme or category not in the tables                                        | `list_service_colour_schemes`                                                        |
| `VIS_SCHEME_REVIEW_REQUIRED` (warn)                  | `check_display`                                                            | hazard-scheme profile not approved by a human                               | a qualified reviewer approves the mapping                                            |
| `VIS_CAMERA_INVALID`                                 | viewpoint commands                                                         | FOV ∉ (0, 180), viewHeight ≤ 0, zero vector                                 | fix the camera                                                                       |
| `VIS_VIEWPOINT_NOT_ORTHONORMAL`                      | viewpoint commands                                                         | \|dir\| or \|up\| ≠ 1 or dir·up ≠ 0 beyond 1e-6                             | normalise; `up` must be ⟂ `direction`                                                |
| `VIS_VIEWPOINT_NOT_FOUND` / `VIS_VIEWPOINT_IN_USE`   | viewpoint / markup / issue commands                                        | unknown / referenced                                                        | —                                                                                    |
| `VIS_VIEWPOINT_STALE` (warn)                         | `check_review`                                                             | viewpoint selection / visibility names deleted entities                     | update the viewpoint                                                                 |
| `VIS_SECTION_BOX_INVALID` / `VIS_SECTION_BOX_IN_USE` | section commands                                                           | min ≥ max / referenced                                                      | —                                                                                    |
| `VIS_SECTION_BOX_EMPTY` (warn)                       | `section_box_report`                                                       | nothing inside or crossing                                                  | enlarge the box                                                                      |
| `VIS_MARKUP_INVALID`                                 | `add_markup`                                                               | screen point ∉ [0,1]², < 2 points, > 256                                    | —                                                                                    |
| `VIS_ISSUE_NOT_FOUND` / `VIS_ISSUE_STATUS_INVALID`   | issue commands                                                             | unknown issue / transition not in §5.5                                      | —                                                                                    |
| `VIS_ISSUE_OPEN` (info)                              | `check_review`                                                             | issue in `open` / `in_progress`                                             | work on it or mark `resolved`                                                        |
| `VIS_ISSUE_AWAITING_APPROVAL` (warn)                 | `check_review`                                                             | `resolved`, waiting for a human                                             | ask the reviewer                                                                     |
| `VIS_ISSUE_ENTITY_MISSING` (warn)                    | `check_review`                                                             | issue references deleted entities                                           | re-link or resolve                                                                   |
| `VIS_HUMAN_GATE`                                     | `set_issue_status`, `approve_colour_profile`                               | approval act by a non-human caller                                          | a human signs (AF-34a)                                                               |
| `VIS_CLASH_SOURCE_INVALID`                           | `create_clash_issues`                                                      | source command missing or no `data.clashes`                                 | run the clash command; check its params                                              |
| `VIS_BCF_PARSE` / `VIS_BCF_VERSION`                  | `import_bcf*`                                                              | malformed XML or zip / version not 2.1 or 3.0                               | —                                                                                    |
| `VIS_BCF_GUID_UNMAPPED` (warn)                       | `export_bcf`                                                               | entities without IFC GUID                                                   | run 08-DAT IFC export first, or accept `AuthoringToolId`                             |
| `VIS_BCF_COLOURING_LARGE` (warn)                     | `export_bcf`                                                               | > 1000 coloured components ([R7])                                           | — (legend written instead)                                                           |
| `VIS_MARKER_NO_OD`                                   | `add_pipe_markers`                                                         | line has no OD                                                              | set `dn` / `diameter`                                                                |
| `VIS_MARKER_BAND_INTERPOLATED` (warn)                | marker commands                                                            | OD in a gap of the A13.1 rows                                               | reviewer confirms with the edition in force                                          |
| `VIS_RENDER_BUDGET`                                  | `render_view`                                                              | pixels × supersample² > 16 M                                                | lower width / height                                                                 |
| `VIS_WALKTHROUGH_INVALID`                            | walkthrough commands                                                       | < 2 keys, seconds ≤ 0, frames > max                                         | —                                                                                    |
| `VIS_GPU_LIMIT` (UI warn, `render_stats` field)      | renderer                                                                   | batch texture > `MAX_TEXTURE_SIZE` or instance buffer > limit               | batch split automatically                                                            |
| `NATIVE_TOOL_MISSING`                                | `render_view`, `render_walkthrough`, `export_bcf` with the native renderer | no raster port or no `llull-compute` in this host                           | use `renderer: 'reference'`, or install the desktop app (it bundles `llull-compute`) |

## 8. Performance and robustness budgets

| Budget                                          | Value                                                                                                                                                                                                                                                                          | Basis                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| Opaque model draw calls (SYN-RACK-v1)           | ≤ 2P + C + U = 30                                                                                                                                                                                                                                                              | closed form, §5.2                                             |
| Edge-pass calls                                 | ≤ P (LOD0 buckets only) = 13                                                                                                                                                                                                                                                   | §5.6                                                          |
| Shadow calls (high tier)                        | ≤ cascades × shadow-casting buckets = 3 × 30                                                                                                                                                                                                                                   | §5.6                                                          |
| GPU bytes per instance                          | 76 (+4 state) InstancedMesh; BatchedMesh 1e6 ≈ 84 MB of textures                                                                                                                                                                                                               | three facts T1, T2                                            |
| Median frame time at 1920 × 1080, orbit         | targets 16.7 ms (10⁴, 10⁵), 33.3 ms (10⁶): **TBD — measure**                                                                                                                                                                                                                   | 60 / 30 Hz; procedure in `synthetic_pipe_rack_benchmark.json` |
| Colour profile re-apply, 10⁵ entities, 50 rules | TBD — measure (target < 200 ms, worker)                                                                                                                                                                                                                                        | O(N m)                                                        |
| BVH build 10⁶ instances                         | measured at VIS-M7 (§12.13): 1.3 - 3.6 s in TypeScript depending on machine load, target 1.5 s missed or borderline; `llull-bvh` WASM / `geomq` stays the RS-6 option                                                                                                          | binned SAH O(N log N)                                         |
| `render_view` review 1920 × 1080                | TBD — measure with `llull render_view … --json` timing, reference and native; hard cap `VIS_RENDER_BUDGET`                                                                                                                                                                     | 8.3 M samples                                                 |
| `render_stats` 10⁶ instances                    | measured 2026-11-03 (§12.8): 4.1 s total, of which the plan (query + LOD + buckets) is ~0.3 s and `planScene` (bounds + prototype keys) 3.8 s; VIS-M7 (§12.13): scene and BVH cached per document object, a repeated call is ~0.3 s; the first call per document is still ~4 s | BVH query + bucket counting                                   |
| `check_review` 10⁴ issues                       | linear, TBD — measure                                                                                                                                                                                                                                                          | —                                                             |
| Document bytes / instance                       | TBD — measure; target ≤ 200 B with instance entities, ≤ 40 B with V2 instance arrays                                                                                                                                                                                           | QUALITY_GATES gate 2 metric                                   |

Robustness:

- NaN / Inf cameras are refused (`VIS_CAMERA_INVALID`).
- Regexes are bounded (200 chars, no backreferences, evaluated on strings ≤ 1 KB).
- BCF import is size-capped (64 MB zip, 10⁴ topics) and rejects zip entries with `..` (path traversal).
- Every list result is paged (AF-12).

## 9. Test strategy

| Layer                                                                                                                            | Test                                                                                                                                                                   | VCs               |
| -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| unit (`tests/unit/review/`, `tests/unit/display/`)                                                                               | colourRules first-match, unmatched, multi-valued tags; scheme tables load with sources + grades; report ordering                                                       | VC-VIS-01, 02, 03 |
| unit (`tests/unit/aec/industrial/pipeMarkers.test.ts`)                                                                           | §5.7 table rows incl. gaps                                                                                                                                             | VC-VIS-04         |
| unit (`viewpointCamera.test.ts`)                                                                                                 | BCF example round trip (reads `data/bcf_3_0/example_viewpoint_orthogonal.bcfv`), azimuth / polar closed form, metres ↔ mm                                              | VC-VIS-10, 11     |
| unit                                                                                                                             | section box classification, rotated box, empty warning                                                                                                                 | VC-VIS-12         |
| unit + integration (`store.dispatch`)                                                                                            | markups / issues / comments, undo / redo, ids deterministic, human gate (agent caller refused, signed passes)                                                          | VC-VIS-13, 14     |
| contract                                                                                                                         | BCF export validates against `visinfo.xsd` / `markup.xsd` (server test with `xmllint --schema` if present, else structural XPath checks)                               | VC-VIS-15         |
| unit (`renderPlan.test.ts`)                                                                                                      | N(n), bucket count ≤ 30 at four sizes, colour-invariance, LOD thresholds and hysteresis, drawn + culled = N, BVH query = brute-force query on 10⁴ random AABBs         | VC-VIS-20..23     |
| perf (`tests/perf/plantViewport.perf.ts`, Playwright, not in `npm run check`)                                                    | frame-time baselines                                                                                                                                                   | VC-VIS-24         |
| unit (`gltfInstancing.test.ts`)                                                                                                  | SimpleInstancing import / export                                                                                                                                       | VC-VIS-25         |
| golden (`tests/golden/`)                                                                                                         | SC-VIS-05 digests pinned per `rendererVersion` (reference renderer only; native output is never pinned); SC-VIS-03 `render_stats` exact numbers pinned after first run | VC-VIS-30..33     |
| unit (industrial)                                                                                                                | clash issues idempotence and framing                                                                                                                                   | VC-VIS-40, 41     |
| native vs reference (`server/tests/visNativeParity.test.ts`; `llull-raster` / `llull-bvh` cargo tests in `npm run native:check`) | BVH id sets and broad-phase pairs equal to `instanceBvh.ts`; native render is non-hash and matches the reference scene                                                 | VC-VIS-60         |
| scenario replay                                                                                                                  | every `validation/plans/*.json` through `build_project` (`server/tests/packReplay09.test.ts`, like packs 07 / 08)                                                      | all SC-VIS        |
| component                                                                                                                        | Review panel / redline tool dispatch the right commands (no geometry maths)                                                                                            | —                 |

Coverage gate 90/85/90/90 applies to `packages/core/src/{commands,geometry}` and `packages/domain-aec/src`.

## 10. Delivery plan

| Milestone   | Content                                                                                                                                                                                                                                                                                                                                                            | Depends on                               | Effort                                                                                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VIS-M1      | `display` model, colour rules, profiles, report, `check_display`; industrial property provider; `apply_service_colour_scheme` (A13.1, ISO 14726)                                                                                                                                                                                                                   | plugin port review (`cad-reviewer`)      | 6 d. **Built 2026-10-23 without viewport use of profiles (§12.6).**                                                                                                                                                     |
| VIS-M2      | `review` model: viewpoints, section boxes, markups, issues, comments, `check_review`, human gate; retire `namedViewStore`                                                                                                                                                                                                                                          | AF-34a signature (09 PLM aerospace)      | 8 d. **Built 2026-10-25 (§12.7); UI (Review panel, redlines, section-box gizmo and clipping) built 2026-11-03 (§12.11); `render_view` use of markups / section box waits for M4.**                                      |
| VIS-M3      | `renderPlan` + `render_stats` + `PlantBatchRenderer` (R-BATCH-v1, LOD, pixel cull), SYN-RACK fixture, perf script baseline                                                                                                                                                                                                                                         | —                                        | 10 d. **Built 2026-11-03 (§12.8): plan + `render_stats` + fixture + baseline (M3a); `PlantBatchRenderer` + `LodGeometryCache` (M3b). Not verified in the desktop app yet; no live perf HUD.**                           |
| VIS-M4      | `render_view` perspective, viewpoint / profile / section box, review shading (shadow, AO, edges), digests                                                                                                                                                                                                                                                          | M1, M2                                   | 8 d. **Built in two slices: perspective / viewpoint / digests 2026-10-19 (§12.1); profile / section box / highlight shading / `visibleEntityIds` / budget 2026-11-03 (§12.10). Shadows, AO and Blinn-Phong stay open.** |
| VIS-M5      | `create_clash_issues`; BCF 3.0 export / import                                                                                                                                                                                                                                                                                                                     | M2                                       | 6 d. **Built 2026-11-03 (§12.2 export, §12.9 clash issues, import, single viewpoint); xmllint test waits for the vendored XSDs.**                                                                                       |
| VIS-M6      | viewport realism tiers (CSM, GTAO, edges), material classes, walk / fly, walkthroughs                                                                                                                                                                                                                                                                              | M3                                       | 8 d — walk / fly, realism tiers (shadow-based) and the Clip off toggle built (§12.12); CSM / GTAO / edges, material classes, `render_walkthrough` left                                                                  |
| VIS-M7      | **Core part built 2026-11-04 (§12.13): `instanceBvh.ts`, `planSceneCache.ts`, `check_clashes` broad phase; the viewport worker and pipe markers are built in the UI part below; glTF instancing is left.** Instance BVH in a worker, glTF instancing, pipe markers; measure the 10⁶ build; `llull-bvh` WASM / `llull-compute geomq` if the target is missed (RS-6) | M3; RS-0 `llull-bvh` for the native part | 7 d (+ native part inside RS-6)                                                                                                                                                                                         |
| VIS-M8 (V2) | 10⁶: streaming, Hi-Z occlusion, impostors, instance-array storage; terrain / sky / sun                                                                                                                                                                                                                                                                             | 08-DAT storage decision                  | 15 d                                                                                                                                                                                                                    |
| VIS-M9      | native GPU raster (RS-5): `ctx.raster`, `llull-compute raster` for `render_view`, walkthroughs and BCF snapshots; VC-VIS-60                                                                                                                                                                                                                                        | M4; RS-0                                 | inside RS-5 (4 wk in RS1, shared with aerospace 05). **Built 2026-10-19 with the M2 / M4 / M5 / M6 slices it needs (§12).**                                                                                             |

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

| Area                                      | As built                                                                                                                                                                                                                                                                                                                                                            | Files                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Review model (VIS-M2 slice)               | `CadDocument.review` with `viewpoints` / `viewpointOrder`, `walkthroughs`, `issues` / `issueOrder`, `nextNumber`; load validation (`reviewProblems`). Section boxes, markups, comments arrived at VIS-M2 (§12.7).                                                                                                                                                   | `model/review.ts`, `commands/persistence/reviewValidation.ts`     |
| Commands (metaHistory, coded refusals §7) | `save_viewpoint` (camera or `fromDocumentCamera`), `list_viewpoints`, `delete_viewpoint` (refused while used: `VIS_VIEWPOINT_IN_USE`), `create_walkthrough` / `delete_walkthrough`, `create_review_issue` (status `open`)                                                                                                                                           | `commands/review/{viewpoints,walkthroughs,issues,reviewModel}.ts` |
| Camera maths                              | orthonormalisation, document orbit camera → viewpoint (45°), interpolation: eye linear, direction / up slerp, fov or view height linear                                                                                                                                                                                                                             | `geometry/viewpointCamera.ts`                                     |
| `render_view` (VIS-M4 slice)              | `projection: 'perspective'` + `fovDeg`, `viewpointId` (perspective or orthographic BCF camera; ortho `viewHeight` = visible height), `renderer: 'reference' \| 'native'`; data `renderer`, `rendererVersion`, `svgSha256` (reference) or `device` / `version` / `engine` / `deterministic: false` (native), `projection`, `viewpointId`                             | `commands/render/{viewRequest,viewSetup,rendererProvenance}.ts`   |
| Raster seam                               | the old `raster.ts` split, bit-identical (svg sha256 of 7 scenes incl. caps, strokes, turntable, unsupersampled): `prepareRasterScene` (projection, Lambert colour, back-face flip, near-plane clipping) → `RasterScene` → `rasterScenePixels` (reference) or `ctx.raster`                                                                                          | `commands/render/{rasterScene,raster}.ts`, `model/raster.ts`      |
| `ctx.raster`                              | `ExecutionContext.raster?: RasterPort \| null`, default context reads `setRasterPort` (`commands/rasterPort.ts`)                                                                                                                                                                                                                                                    | `commands/types.ts`, `commands/context.ts`                        |
| `render_walkthrough` (VIS-M6 slice)       | PNG frames (`data.files`, `--save dir/`), frames = ⌊duration · fps⌋ + 1, `frameSha256[]` (reference), native frames without digests; `maxFrames` ≤ 600, 100 Mpx budget (`VIS_RENDER_BUDGET`)                                                                                                                                                                        | `commands/render/{renderWalkthrough,frames}.ts`                   |
| `export_bcf` (VIS-M5 slice)               | BCF 3.0 archive: `bcf.version`, `extensions.xml`, per topic `markup.bcf` + `.bcfv` (metres, vertical `FieldOfView`, `ViewToWorldScale`) + PNG snapshot; behind the export gate; `VIS_BCF_GUID_UNMAPPED` warning                                                                                                                                                     | `commands/exchange/bcf/{exportBcf,bcfXml}.ts`, `lib/zip.ts`       |
| Native job                                | `llull-compute raster <folder>` with `"kind": "scene"`: flat f64 buffers → `rgba.bin`. CPU twin bit-identical to `rasterScenePixels`; wgpu fill (convex faces batched as fans, other faces even-odd via stencil INVERT + stencil-tested cover), strokes / outline / resolve on the twin. `llull-compute` `main.rs` unchanged (dispatch inside `llull_raster::run`). | `solver/crates/llull-raster/src/{scene,scene_cpu,scene_gpu}.rs`   |
| Host transport                            | `RasterPort` running the job with `spawnSync` (commands are synchronous), hash-checked output, provenance from the NDJSON warnings; installed by the CLI and the backend only when the binary exists                                                                                                                                                                | `server/src/native/rasterPort.ts`                                 |

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
- The intermittent access violation of the `gpu`-feature scene test under output capture (about 1 run in 3) came from
  the GNU toolchain's temporary `dlltool` stand-in: with MSVC (VS 2022 Build Tools 14.44, 2026-10-21) the same
  `cargo test -p llull-raster --features gpu` passed 3 / 3 with capture; the stand-in is removed.

### 12.5 Not built yet (remaining VIS work)

The rest of VIS-M1 (profile cache, `approve_colour_profile`, `define_palette`, viewport / `render_view` use of a profile; the model, commands and schemes are §12.6), the rest of VIS-M2 (the Review panel, redlines, section-box gizmo and clipping are §12.11; left there: switching a section box off, the BCF snapshot from the canvas), the rest of VIS-M4
(shadow, ambient occlusion and Blinn-Phong review shading; the profile, section box, highlight, `visibleEntityIds` and budget are §12.10), the vendored XSDs for VC-VIS-15 (VIS-M5 itself is §12.9), VIS-M6 viewport tiers
and walk / fly, VIS-M7, VIS-M8. VC-VIS-60 (a) belongs to RS-6 (`llull-bvh`).

### 12.6 As built — VIS-M1 display profiles and service colours, 2026-10-23

Built: the generic display model, first-match colour rules, profiles, the colour report, `check_display`, the plugin property port and the
service colour schemes (ASME A13.1, ISO 14726). No viewport rendering of a profile (VIS-M4 / M6); desktop-app verification does not apply yet.

| Area                              | As built                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Files                                                                                                                  |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Display model                     | `CadDocument.display` (`colourProfiles`, `activeProfileId`), optional, no migration; load validation (`displayProblems`); `replay_history` carries it like `review`                                                                                                                                                                                                                                                                                                                                       | `model/display.ts`, `commands/persistence/displayValidation.ts`, `commands/history/replay.ts`                          |
| Property port (Q1)                | `CadPlugin.entityProperties?: EntityPropertyProvider`; `plugins/host.ts` `entityPropertyProviders()`; `ExecutionContext.properties?: EntityPropertyReader` (default context = core keys merged under the providers'; a provider cannot override a core key). Core keys: `id`, `kind`, `is2D`, `layerId`, `layerName`, `name`, `tag` (multi), `materialId`, `componentId`                                                                                                                                  | `model/entityProperties.ts`, `geometry/entityProperties.ts`, `plugins/{plugin,host}.ts`, `commands/{types,context}.ts` |
| Colour rules                      | §5.1: validation (`profileProblems`: unique ids, predicate has a clause, `range` a <= b, regex <= 200 chars, no back-reference, no repeated quantified group, nesting <= 4, colours `#rrggbb`), compiled once, first match wins; case-insensitive string equality; multi-valued keys match on any value; a missing property never matches                                                                                                                                                                 | `geometry/colourRules.ts`                                                                                              |
| Core commands (metaHistory)       | `define_colour_profile`, `set_active_colour_profile`, `delete_colour_profile`; queries `colour_by_rule_report` (`groupBy` `rule` (default) / `entity` / `property` + `groupProperty`, so core knows no plant key; legend with counts, `unmatched`, `outOfScope`, `warnings`), `check_display` (`VIS_PROFILE_NOT_FOUND` error; `VIS_COLOUR_UNMATCHED`, `VIS_RULE_PROPERTY_UNKNOWN`, `VIS_SCHEME_REVIEW_REQUIRED` warnings)                                                                                 | `commands/display/*` (toolset `review`)                                                                                |
| Plant plugin `plant-display` (D2) | `list_service_colour_schemes`, `apply_service_colour_scheme` (one rule per mapped service in map order, `reviewRequired: true`, `unmapped` services listed, re-applying a `profileId` replaces it); tables with sources, grades and conflicts; palette `llull-ral-approx-v1` (approximate); provider for building pipes (`service`, `line`, `dn`, `odMm`, `material`, `from`, `to`), equipment (`mark`, `equipmentShape`) and plant piping runs (`service`, `line`, `dn`, `spec`, `odMm`, `insulationMm`) | `packages/domain-aec/src/plant/display/*` (toolset `review`)                                                           |

Deviations from §2–§4 (law-driven or scoped to M1):

- **Placement.** The generic model, rules and commands sit in core (`model/display.ts`, `geometry/colourRules.ts`, `commands/display/`), like the
  existing `review` slice; the hazard tables, palette and provider sit in the plant plugin `plant/display/` (Q2 / D2), not in `industrial/display/`.
  Core names no scheme. A rule that came from a scheme carries `scheme { id, rowId, category, names }` so reports show category and named colours.
- **Colours.** A profile stores resolved `#rrggbb` only; `scheme:<id>/<category>` strings are resolved by `apply_service_colour_scheme`, not by core
  (core cannot read scheme tables). `ColourProfile.defaultColour` replaces `defaultAppearance`; `materialClasses` is not in `DisplayModel` yet (VIS-M4 / M6).
- **Toolsets.** No new toolset names: the display commands and `plant-display` are in `review` (`TOOLSETS.review` is now `REVIEW_CORE_TOOLS` + `pluginToolNames('review')`).
- **Report scope.** An entity is "in scope" for a profile when its property bag has at least one key the profile's rules test; only in-scope entities are
  grouped and can be `unmatched` (a box is not reported against a pipe-service profile). `groupBy` is `rule` (default), `entity` or `property` + `groupProperty` (SC-VIS-01 groups by `line`); the report knows no plant key.
- **Not built:** (`delete_colour_profile` refuses a profile a viewpoint references since VIS-M2, `VIS_PROFILE_IN_USE`);
  the profile result cache (`(profile, entities)`) waits for the renderer
  that needs it; `approve_colour_profile` and `define_palette` stay V1; BS 1710 / DIN 2403 stay documentation. Predicates nest one `any` level in
  the tool schema (the stored model nests four). Added code `VIS_RULE_PROPERTY_UNKNOWN` (warn): a rule tests a property no entity has.
- **Ids.** `execute` refuses reserved ids (`CMD_RESERVED_ID`) for any `*Id` / `id` param before the command runs; profile lookups are own-key only (`findProfile`) and `storeProfile` (`geometry/colourRules.ts`) is the single writer of profiles for `define_colour_profile` and `apply_service_colour_scheme` (empty / reserved id, bad rule or colour refused).
- **Pipe markers (data, built 2026-11-04).** `ColourRule.marker { letters, letterHex? }` (core `model/display.ts`, validated by `profileProblems` and load validation); `apply_service_colour_scheme` `markerLetters: true` writes it (service in capitals; A13.1 letterColour in the default palette, ISO 14726 has none) and `scheme.names` stays named colours. `pipe_markers` (plant-display, review toolset, read-only) returns per building pipe and 02 RTE run (centrelines from the shared `plant/common/pipeCentrelines.ts`, also used by the stress model) `markers[{positionMm, tangent, atMm}]`: ceil(length/spacingMm) placements at the middles of equal parts (default 7620 mm, linear walk), tangent along the centreline order (from end to to end; not a verified flow direction), plus line, service and the rule the core evaluator selects from the active / given profile. Cap 5000 placements, checked before any placement is built (`VIS_MARKER_LIMIT`); `VIS_MARKER_NOT_FOUND`, `VIS_PROFILE_NOT_FOUND`. Valve / flange / penetration placement and bidirectional arrows (no line flag exists) are not built; `add_pipe_markers` / `check_pipe_markers` stay V1. The viewport drawing is the UI lane.
- **Load validation.** `displayProblems` checks the predicate shape recursively (field types, depth) before the semantic checks, so a malformed file yields problems, never a throw. Added code `VIS_GROUP_PROPERTY_MISSING` (`groupBy: 'property'` without `groupProperty`).
- **Regex guard.** A quantified group whose body holds a quantifier or an alternation is refused (`(a+)+`, `((a+))+`, `(a|aa)+`, `(a{2,})+`).

Validation cases: VC-VIS-01 / 02 / 03 and SC-VIS-01 in `tests/unit/plant/display/serviceColour.test.ts` and `tests/unit/display/colourProfiles.test.ts`;
the property port contract in `tests/unit/contract/entityPropertiesPort.test.ts`.

### 12.7 As built — VIS-M2 review model, human gate, saved views, 2026-10-25

Built on the VIS-M9 slice (§12.1: viewpoints, walkthroughs, minimal issues, camera maths, `delete_viewpoint` / `delete_review_issue`), which is extended, not duplicated. Pure commands in core (`commands/review/`, all metaHistory, coded refusals through `reviewRejection`); no plugin is involved (the review model is generic, like the display model of §12.6).

| Area                  | As built                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Files                                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Model                 | `ReviewModel` gains `sectionBoxes`, `activeSectionBoxId?`, `markups`, `comments`; `Viewpoint` gains `sectionBoxId?`, `colourProfileId?`, `visibility?`, `selection?`; `ReviewIssue` gains `assignedTo?`, `dueDate?`, `history` (status, `by`, reason, `signatureId`, `signer`). Ids `sb-`, `mk-`, `cm-` from `review.nextNumber`. Load validation checks every section, reference and history entry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `model/review.ts`, `commands/persistence/reviewValidation.ts`                                |
| Section boxes         | `set_section_box` (box `min` / `max` + `rotationZ`, or 1..6 `planes`; `id` replaces; `activate`), `set_active_section_box` (`id` or null: switch clipping off without deleting the box), `delete_section_box` (`VIS_SECTION_BOX_IN_USE`), `section_box_report` (inside / crossing / outside in document order, `VIS_SECTION_BOX_EMPTY`). §5.4 maths: exact for axis-aligned boxes, conservative for `rotationZ`; a box face lying on the section box from inside is inside, one touching it only from outside is crossing; plane normals normalised on save.                                                                                                                                                                                                                                                                                                                                                                              | `commands/review/sectionBoxes.ts`, `geometry/sectionBox.ts`                                  |
| Viewpoints            | `save_viewpoint` also stores section box, profile, visibility and selection (references checked); `get_viewpoint` (fields + `markups[]`), `update_viewpoint` (null clears a field; id and guid kept), `apply_viewpoint` (writes `doc.camera`, activates the carried profile / section box; `resetDisplay` also clears the ones it does not carry). `viewpointDocumentCamera`: azimuth = atan2(o_x, o_y), polar = acos(o_z) clamped to [0.01, π − 0.01], target = eye + direction · distance to the scene centre (else the current distance). VC-VIS-11 holds to 1e-9. `delete_viewpoint` deletes its markups and uncites it from comments. `delete_colour_profile` is refused while a viewpoint uses the profile (`VIS_PROFILE_IN_USE`).                                                                                                                                                                                                  | `commands/review/{viewpoints,viewpointEdit,viewpointRefs}.ts`, `geometry/viewpointCamera.ts` |
| Markups, comments     | `add_markup` / `delete_markup` (point counts: line 2, polyline 2..256, arrow 2, cloud 3..256, ellipse 2 bounding corners, text 1 + `text`; screen points in [0, 1]; colour `#rrggbb`), `add_review_comment` (optional viewpoint), `create_review_issue` takes `assignedTo` and `dueDate` (`YYYY-MM-DD`); deleting an issue deletes its comments.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `commands/review/{markups,comments,issues}.ts`                                               |
| Human gate            | `set_issue_status` follows §5.5. Closing and re-opening a closed issue need `confirmation`: a signature a trusted human key made over `sha256({act: 'review:set_issue_status', ids: [issueId], details: {from, to, reason, historyLength, issueSha256}, nonce})`, where `issueSha256` is the hash of the whole issue (guid, title, entities, viewpoints, history) just before the move, so a signature for one issue cannot be replayed on another `iss-2` in another document. `review_act_payload` returns the bytes. It is the shared `humanGate` of `ctx.humanSignature` (the port 09 PLM installs for releases; also used by 05 FEA dispositions and 08 MAT markings), not a copy; `humanGate` also returns the `signatureId`. A human history entry stores `by: 'human'`, `signatureId`, `signer` and the `proof` (the confirmation). Deleting an issue is a human act too (`review:delete_review_issue`, bound to the issue hash). | `commands/review/{issueStatus,reviewActs,issues}.ts`, `model/humanGate.ts`                   |
| `check_review`        | `{status, issues[{code, severity, ids, paths, message, remediation}], counts}`; one row per code: `VIS_ISSUE_OPEN` (info), `VIS_ISSUE_AWAITING_APPROVAL`, `VIS_ISSUE_ENTITY_MISSING`, `VIS_VIEWPOINT_STALE` (warn), `VIS_SIGNATURE_UNVERIFIED` (warn: human entries exist but this host has no signature verifier), `VIS_HUMAN_GATE` (error: a closed issue whose last history entry is not a human act, or a human entry whose stored proof does not verify against the act rebuilt from the chain with `ctx.humanSignature.verify`, which is pure and spends nothing; i.e. a file edited outside the commands). Load validation requires a legal chain from `open` ending at `status`, a `proof` on every human entry, and `colourProfileId` to name a display profile. `includeInfo: false` leaves the info rows out.                                                                                                                  | `commands/review/checkReview.ts`                                                             |
| Saved views in the UI | `NamedViews.tsx` reads `document.review` and dispatches `save_viewpoint` (live orbit camera: eye = camera, direction = target − eye), `apply_viewpoint` (the `CameraReactor` follows `document.camera`) and `delete_viewpoint`. `namedViewStore.ts` and its localStorage key are gone.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `src/ui/viewport/3d/{NamedViews.tsx,viewpointParams.ts,cameraBridge.ts}`                     |

Decisions (owner delegated, quality first):

- **Human = signature only.** Spec §5.5 allowed "a signature with a human-held key, or an authenticated human session". Only the signature path exists
  (`ctx.humanSignature`: bound to the act, single use where the host has a ledger, trusted key); there is no session concept in `ExecutionContext`, and a session claim
  is exactly what an agent could forge. `ctx.caller` is not used. A valid signature on a non-gated move is recorded as a human act; an invalid one refuses.
- **Deleting an issue is always a human act.** An issue has no verified creator, so no deletion can be told from a deletion that makes an unclosable finding or a signed record vanish. An agent that wants a draft gone hands over; `delete_review_issue` needs a signature bound to the issue hash. Deleting a viewpoint or markup stays ungated (no signed record).
- **Live peers.** `applyLiveCommand` replays commands without `ctx`, so a signed `set_issue_status` / `delete_review_issue` is refused on a peer; the state hash then differs and the peer resyncs from the server snapshot, as for every gated act (05 FEA, 08 MAT, 09 PLM). The host that holds the signing port executes and broadcasts.
- **`apply_viewpoint` is approximate for orthographic viewpoints.** The document camera is a perspective orbit camera: view height and the roll of `up` are not kept; `data.warnings` carries `VIS_VIEWPOINT_APPROXIMATED` for an orthographic viewpoint.
- **Approving a review is closing its issues.** There is no separate "review approval" record. `approve_colour_profile` stays V1 (§12.6) and will use the same `humanGate`.
- **`author` of markups and comments is a label**, not verified (default `agent`, the UI sends `human`). Only `history[].by` is a verified fact.
- **No import of old bookmarks.** The one-time import of §2 and of the functional spec §6.3 is dropped: the owner rule is no backward-compatibility shims.
  Existing localStorage bookmarks (`llull-named-views`) are simply no longer read. The review model has no backward compatibility either: a document saved with
  the VIS-M9 slice (no `sectionBoxes` / `markups` / `comments`, issues without `history`) is refused at load with the reasons.
- **A viewpoint stores eye, direction and up, not an orbit target.** `apply_viewpoint` puts the orbit target on the view axis at the scene centre. A bookmark
  saved from the UI therefore returns to the same eye and view direction with the orbit pivot re-derived, which is what BCF viewpoints mean.
- **`apply_viewpoint` changes the display only when the viewpoint carries it** (`resetDisplay: true` to clear). A plain camera bookmark never resets the user's
  colour profile.
- **`VIS_VIEWPOINT_NOT_ORTHONORMAL` is not emitted.** `save_viewpoint` keeps its VIS-M9 behaviour: direction and up are normalised and made orthogonal (an agent
  rarely types an exactly orthogonal pair); a parallel or zero vector is `VIS_CAMERA_INVALID`. VC-VIS-50 reads accordingly.
- **No `force` on `delete_viewpoint`.** It stays refused while a walkthrough or an issue uses the viewpoint (VIS-M9 rule, stricter than §4); delete those first.
- **Markup `shape` is the param name** (the SC-VIS-04 plan said `kind`; the plan is corrected). A `text` markup takes one point (§4 said 2..256 for all shapes).
- **No `realism` on the data model yet** (walk / fly arrive with VIS-M6); `clashKey` arrived with VIS-M5 (§12.9).
- **`activeSectionBoxId`** is review data written by `set_section_box` (`activate`) and `apply_viewpoint`; the viewport and `render_view` use it at VIS-M4 / M6.

Not built in this section (VIS-M2 UI part, built in §12.11): the Review panel (issues, comments, human sign-off), redline tools, the section-box gizmo and clipping with the active box in the
viewport; still open: the BCF snapshot from the UI canvas (Q7). The commands they dispatch exist and are tested. The Views overlay is covered by component tests and
was not run in the desktop app in this session.

Validation: VC-VIS-11 / 12 / 13 / 14 in `tests/unit/review/` (`sectionBox.test.ts`, `issueWorkflow.test.ts`, `viewpointEdit.test.ts`); SC-VIS-04 is replayed
command by command against its expected values in `tests/unit/review/scVis04.test.ts`; the UI in `tests/component/NamedViews.test.tsx`.

### 12.8 As built — VIS-M3a render plan and `render_stats`, 2026-11-03

VIS-M3 is split: M3a (this section: the pure plan, `render_stats`, the SYN-RACK fixture, the perf baseline) and M3b (`PlantBatchRenderer`, `LodGeometryCache`, UI). Built in the plant display plugin, not in core `commands/render/`
(§2 listed `renderStats.ts` there): a plugin may not import `commands/render`, and the plan only needs `geometry` and `model`.

| Area    | As built                                                                                                                                                                                                                                                                                                                                                                                                                              | Files                                                  |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Plan    | `planScene(doc)` (visible 3D entities -> instances with prototype / material-class indices, AABB, diagonal) and `planRender(scene, camera, { multiDraw, quality, previousLevels?, query? })` -> buckets, unique batches, calls, culling, triangles, bytes, per-instance levels. Pure, deterministic, no three.js. `query` is the injection point of the instance BVH (VIS-M7); the default is a brute-force AABB / plane test (O(N)). | `packages/core/src/geometry/renderPlan.ts`             |
| Camera  | `PlanCamera`, `framedPlanCamera` (named view / custom direction, perspective or orthographic, fitted on the scene sphere), `viewpointPlanCamera`, `frustumPlanes` (near plane through the eye + 4 side planes, no far plane)                                                                                                                                                                                                          | `packages/core/src/geometry/renderPlanCamera.ts`       |
| Command | `render_stats` (read-only; toolset review): params `viewpointId?` / `view`, `direction`, `target`, `projection` (default orthographic), `fovDeg`, `width`, `height` (required), `quality`, `multiDraw`. Data: the §4 fields plus `prototypeCount`, `bucketCount`, `uniqueBatches`, `multiDraw`, `quality`, `projection`. `buckets` lists the 200 largest. Refusals: `VIS_VIEWPOINT_NOT_FOUND`, `VIS_CAMERA_INVALID`.                  | `packages/domain-aec/src/plant/display/renderStats.ts` |
| Fixture | `synRackDocument(bays)` builds SYN-RACK-v1 directly (N(n) = 227 n + 8 floor(n/4), 13 prototypes, 4 material classes as `materialId`)                                                                                                                                                                                                                                                                                                  | `tests/helpers/synRack.ts`                             |
| Tests   | VC-VIS-20..23 in `tests/unit/render/renderPlan.test.ts` (BVH-vs-brute-force parity waits for VIS-M7; the frustum query is checked against the plane-by-plane test on 10⁴ random AABBs); `render_stats` happy / failure / pure and SC-VIS-03 run through `build_project` with its numbers pinned in `tests/unit/plant/display/renderStats.test.ts`                                                                                     |                                                        |

Decisions and limits:

- **Call bound.** `opaqueModelCalls ≤ 2 · (distinct prototype × material-class pairs drawn) + C + U` (U = unique-geometry batches with multi-draw). It equals `2P + C + U` only when each prototype has one material class, as in SYN-RACK-v1 (30). A seeded property test asserts both forms.
- **Camera validation.** `target` / `direction` must be 3 finite numbers and a viewpoint camera must be plannable (finite, non-zero direction, fov in (0, 180), view height > 0): otherwise `VIS_CAMERA_INVALID` at path `target` / `direction` / `viewpointId`. `planRender` throws `RangeError` on an invalid camera (`planCameraProblem`); callers validate first.
- **Determinism.** Buckets sort by code-unit order (never `localeCompare`); mesh prototype keys use sha256; an injected `query` may return unsorted or duplicate indices (deduplicated and sorted once).

- **Material class is `materialId`** (else `unassigned`) until the material-class model of VIS-M4 / M6 exists. The SC-VIS-03 plan assigns none, so its numbers have one class; the four-class bound (30) is tested with the fixture builder.
- **Unique geometry** = a prototype with exactly one instance in the whole scene (stable under camera moves). Such instances are only frustum / size culled and batched per material class at LOD0; `opaqueModelCalls` counts one call per class with `multiDraw`, one per instance without.
- **LOD2 boxes** merge per material class (`prototypeKey: '$box'`). Hysteresis is applied from `previousLevels`: a finer level is taken once `p (1 - h) >= threshold`, a coarser one at the threshold (so LOD1 holds down to `d01 (1 - h)`, 2268.416 mm for the M16 stud).
- **`triangles`** is exact at LOD0 and for boxes (12); LOD1 uses a per-kind cap (cylinder 32, cone 24, sphere 112, torus / revolution 128): an estimate. `gpuBytesEstimate` = 80 B per drawn instance + 72 B per triangle of each distinct drawn (prototype, LOD) geometry.
- **`instance` entities are one plan instance** (their children are not expanded); sweeps / lofts key on their full parameter record (6 significant figures), not the outline hash of §5.2.
- **Pinned (SC-VIS-03, smoke n = 8, iso, 1920 x 1080, 45°, one class):** componentCount 1832, 8 buckets / 8 opaque model calls, 4 edge calls, 24 shadow calls, culled 0 by frustum and 973 by size, 859 drawn, 16484 triangles, 88304 bytes.
- Mesh-reader audit: `render_stats` counts the display triangles of a mesh (by design, listed in `meshAssetProbe` / `meshReaders`).

Measured (2026-11-03, Windows 11, shared machine, TypeScript reference, perspective iso, 1920 x 1080; `VIS_PERF=1 npx vitest run tests/unit/render/renderStatsPerf.test.ts --disableConsoleIntercept`; no gate):

| N         | `planScene` | `render_stats` total |
| --------- | ----------- | -------------------- |
| 1 832     | 12 ms       | 22 ms                |
| 10 076    | 44 ms       | 47 ms                |
| 100 071   | 368 ms      | 371 ms               |
| 1 000 037 | 3 799 ms    | 4 087 ms             |

`render_stats` rebuilds the scene (`planScene`) on every call; the plan itself is ~0.3 s at 10⁶ with the brute-force query. The viewport caches the scene, and the BVH (VIS-M7) replaces the O(N) query.

VIS-M3b (`PlantBatchRenderer`, `LodGeometryCache`) is built, see the table below. Not built (VIS-M7 and later): `BatchedMesh` for unique geometry, transparent bucket sorting, `VIS_GPU_LIMIT`, the `render_view` use of the plan.

### 12.8b As built — VIS-M3b `PlantBatchRenderer` and `LodGeometryCache`, 2026-11-03

| Area            | As built                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Files (`src/ui/viewport/3d/plant/`)                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Hand-over       | `Entities.tsx` asks `usePlantCoverage` for the plan scene (`planScene`, memoized on `order` / `entities` / `layers` / `components`) and the covered ids, and `usePlantPlan` for the plan, computed in the SAME render from the camera published by `PlantCameraProvider` (no effect state, so a plan always belongs to its scene). Active when at least 1500 entities are coverable (`PLANT_BATCH_MIN_INSTANCES`); with no camera view, no scene or an unplannable camera (zero-size canvas) nothing is covered and the per-entity path draws everything. Covered = in the plan, kind box / cylinder / cone / sphere / torus / wedge / pyramid / revolution / mesh without face colours, and not claimed by the per-entity path (hidden, exploded, animated, finished / decaled, mid-transition, ghosted; a tint does NOT claim an entity, the batch colours it); the per-entity and `InstancedRenderer` paths skip them. | `plantBatchPlan.ts`, `usePlantCoverage.ts`, `usePlantPlan.ts`, `Entities.tsx`                                        |
| Buckets         | One `InstancedMesh` per plan bucket (prototype x material class x LOD), one per unique-geometry instance, one box bucket per class at LOD2. The camera provider emits a new view on a throttled leading + trailing 250 ms schedule while the camera moves and once 150 ms after it stops. While moving, the plan uses a frustum widened 1.5x (same pixel density) and size-culled instances stay as boxes (`$culled`), so nothing blinks out while orbiting; the settled plan culls. Hysteresis input = the previous levels of the same scene. Matrices: Euler XYZ placement (LOD2: composed with the prototype local box), checked against three `Object3D`. Materials are per bucket (polygon offset 1 / 1 like `SolidMeshShell`; x-ray selected opacity).                                                                                                                                                              | `PlantBatchRenderer.tsx`, `PlantBucketMesh.tsx`, `PlantCameraProvider.tsx`, `plantPlanCamera.ts`, `plantMatrices.ts` |
| Geometry        | `LodGeometryCache`: LOD0 the per-entity builders, LOD1 8-segment cylinder / cone / sphere / torus (32 / 24 / 112 / 128 triangles, the plan's caps; other kinds keep LOD0), LOD2 one shared unit box. `retain` disposes prototypes that left the scene, `dispose` on unmount (`useDisposable`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `LodGeometryCache.ts`                                                                                                |
| Colour, picking | Instance colour = entity colour (or its material's), selection tinted as the per-entity path; instance colour = tint (merged `tintStore`: overlay over colour-profile) > material > entity colour, then the selection tint; `PlantBucketMesh` subscribes to `tintStore` and a tint change rewrites only the colour buffers (no re-plan, no matrix rewrite). A click maps `instanceId` to the entity id and goes through the same `handleSelect` (locked layers, additive select, click animations).                                                                                                                                                                                                                                                                                                                                                                                                                       | `plantInstanceColours.ts`, `plantBatchPlan.ts`                                                                       |
| Tests           | `tests/unit/plantBatch.test.ts` (coverage, hidden layers, buckets vs the plan, culled boxes while moving, motion camera, tint, picks, matrices vs three, cache caps / dispose); `tests/component/EntitiesPlantExclusion.test.tsx` (real renderer: every entity is on screen exactly once across both paths with a plan, an unplannable camera, no camera view, after an edit, with a tinted entity drawn once, in its batch); colour precedence in `plantBatch.test.ts`)                                                                                                                                                                                                                                                                                                                                                                                                                                                  |                                                                                                                      |

The camera view is an external store (`plantCameraStore.ts`) behind a stable context value; `Entities` subscribes (`useSyncExternalStore`) only while a plant scene is active, and the provider's frame hook is one flag check otherwise, so small documents never re-render on camera bumps (component test). **To check in the desktop app:** the settled plan culls covered instances under 1 px (drawn by neither path, tested), which may read as missing detail at plant scale; and the cost of re-planning (and the re-render of `Entities`) at 10^4 instances every 250 ms while orbiting.

Not built: the dev perf HUD (no existing debug toggle to hang it on), hover highlight (the instanced path has none), `BatchedMesh` for unique geometry (each is a 1-instance mesh), LOD1 decimation of meshes / revolutions (they keep LOD0), edge lines, transparent / x-ray sorting (x-ray uses the shared material), picking through a BVH (three's O(N) instance raycast at click). Desktop-app verification and a measured frame rate on a SYN-RACK scene are open.

### 12.9 As built — VIS-M5b clash issues, BCF import, single-viewpoint BCF, 2026-11-03

| Area                                            | As built                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Files                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `create_clash_issues` (TR-VIS-40)               | runs `source` (`check_clashes` \| `check_assembly`) with `sourceParams` through `execute` on the same context; reads `data.clashes[]` (`check_clashes`) or, for `check_assembly`, its `FPR_PAIR_HARD` / `FPR_PAIR_CONTAINED` pair items (kind `hard` / `contained`, depth = `penetrationEstimateMm`); one issue per clash (type `Clash`, labels `clash` + kind, status `open`, `history: []`) and one viewpoint framed per §5.8; `clashKey` = `clash:` + sorted(a, b) joined by `,` + `\|` + kind, stored on the issue; data `{created, unchanged, updated, skipped, truncated, issueIds}`; ≤ 500 clashes per run; `VIS_CLASH_SOURCE_INVALID` (source unregistered, refused — e.g. no kernel —, or without clashes) | `commands/review/{clashIssues,clashFraming}.ts`                                     |
| `import_bcf`                                    | BCF 2.1 and 3.0 zip from base64 → issues, viewpoints, comments; `mergePolicy` `skip` (default) / `update` on the topic Guid (the Guid is kept as the issue guid); data `{topics, created, updated, skipped, viewpoints, comments, issueIds, version, warnings[{code, message}]}`                                                                                                                                                                                                                                                                                                                                                                                                                                    | `commands/exchange/bcf/{importBcf,bcfRead,bcfVisualizationRead,bcfViewpointMap}.ts` |
| `export_bcf_viewpoint` / `import_bcf_viewpoint` | one viewpoint ↔ a `*.bcfv` (metres; data `camera {cameraViewPointM, cameraDirection, cameraUpVector, fieldOfViewDeg \| viewToWorldScaleM}`); the export is behind the export gate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `commands/exchange/bcf/bcfViewpoint.ts`                                             |
| `export_bcf` additions                          | `DueDate`, `AssignedTo` and `Comments` (with the viewpoint a comment cites) in `markup.bcf`, in schema order, so a round trip keeps them                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `commands/exchange/bcf/{bcfXml,exportBcf}.ts`                                       |
| Model                                           | `ReviewIssue.clashKey?` (validated on load)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `model/review.ts`, `commands/persistence/reviewValidation.ts`                       |
| VC-VIS-15                                       | structural checks of every exported part in schema order (unit test, always runs); `xmllint --schema` test (`server/tests/bcfSchema.test.ts`) runs when `xmllint` and `LLULL_BCF_XSD_DIR` (`markup.xsd`, `visinfo.xsd`) are present, else it logs and skips: the schemas are CC BY-ND and are not vendored yet (§6 `validation/data/bcf_3_0/` does not exist)                                                                                                                                                                                                                                                                                                                                                       | `tests/unit/review/bcfImport.test.ts`, `server/tests/bcfSchema.test.ts`             |

Decisions:

- **An import or a clash run is never a human act.** New issues are always `open` with an empty history, whatever `TopicStatus` the file says (a status other than
  Open / New / Active is warning `VIS_BCF_STATUS_RESET`); `update` and a clash re-run never touch status, history, viewpoints or entities of an existing issue
  (a clash re-run rewrites only the description, which carries the depth). Closing stays the signed act of §12.7.
- **Hostile archives.** The zip goes through `lib/zipRead` (only `bcf.version`, `<topic>/markup.bcf` and `<topic>/*.bcfv` are inflated, 128 MiB cap), the XML through
  `lib/xmlRead` (no DTD, bounded depth / elements / size). An entry name with `..`, a backslash, a leading `/` or a drive is `VIS_BCF_PARSE`; nothing is ever
  written to a path. Limits: 64 MiB archive, 5000 topics, 64 viewpoints and 500 comments per topic, 20 000 components per list, texts clipped at 20 000 characters.
  A topic or viewpoint that cannot be read is skipped with a warning (`VIS_BCF_TOPIC_SKIPPED`, `VIS_BCF_VIEWPOINT_SKIPPED`); an archive with no readable topic
  folder is `VIS_BCF_PARSE`. Both commands are in the hostile-input harness (`tests/helpers/hostile/bcfReaders.ts`).
- **Components.** Only `OriginatingSystem` `llull` + `AuthoringToolId` name an entity; components that are not llull's, or name an unknown entity, are dropped and
  counted in warning `VIS_BCF_GUID_UNMAPPED`.
- **Camera.** Metres × 1000 / mm-per-unit; a camera within 1e-6 of orthonormal is stored as written (the §3.2 invariant, SC-VIS-02 step 7), otherwise normalised.
  `get_viewpoint` now returns `warnings: []` (no `VIS_VIEWPOINT_NOT_ORTHONORMAL` is emitted, §12.7) so the plan row for it holds.
- **Clash ids.** `check_clashes` reports building element ids: the issue selects the entities of the elements (`building.elements[id].entityIds`) and frames their
  AABBs; `check_assembly` ids are entity ids. A clash whose part has no geometry is `skipped`. The framing box is the AABB intersection, or per axis the gap
  between the closest faces when they do not overlap, grown by `margin` (mm).
- **Imported comments are `author: 'agent'`** (a label only); BCF author and date are not kept. A viewpoint of an imported topic is named after the topic.

- **Signed issues are frozen.** `issueSha256` covers the whole issue, so an issue that is not open or has a human history entry is left byte-identical by `import_bcf` `update` (`VIS_BCF_ISSUE_SIGNED`, counted skipped) and by a clash re-run (`VIS_CLASH_ISSUE_SIGNED`, counted unchanged); the contract test `reviewSignedIssue.test.ts` checks every writer of `review.issues`.
- **Imported comments** keep the BCF Author as `importedAuthor` (unverified label, `author` stays `agent`; `export_bcf` writes it back); comments dedupe on author + text. One import creates at most 20 000 records (`VIS_BCF_LIMIT`) and an entry may inflate at most 200 times its size.
- **VC-VIS-15 runs only when `xmllint` and `LLULL_BCF_XSD_DIR` are present**; elsewhere only the structural unit test covers it.

Not built: BCF 2.1 export (`VIS_BCF_VERSION` still refuses it), `VIS_BCF_COLOURING_LARGE`, per-component `IfcGuid` mapping (needs the 08-DAT IFC export), import of
snapshots, section boxes and markups from a BCF viewpoint (`Lines`, `ClippingPlanes` are ignored), the vendored XSDs for the server test, and the UI for any of it.

### 12.10 As built — VIS-M4b profile, section box, review highlight, visible entities, 2026-11-03

`render_view` reads the display and review data that already sit in core `model` (§12.6 / §12.7), so no new port was needed (the plant plugin supplies entity properties through the existing property port). Built in `commands/render/`.

| Area                | As built                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Files                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Params              | `colourProfileId`, `sectionBoxId`, `shading` (`flat` / `review`), `issueId`, `highlightEntityIds`. Profile: param, else the viewpoint's, else the active profile. Section box: param, else the viewpoint's, else the active box (an explicit `cut` ignores the viewpoint / active box; `sectionBoxId` + `cut` is `VIS_RENDER_INVALID`).                                                                                                                                                  | `reviewStyle.ts`                           |
| Profile             | evaluated with `evaluateProfile` (installed property providers); the first rule's colour replaces the entity colour and its material override; `hidden` rules remove the entity; `defaultColour` colours unmatched 3D entities; data `legend` (every rule with its count), `colourProfileId`, `hiddenEntityIds`. Instance children keep their own colours. Rule `transparency` is not drawn.                                                                                             | `reviewStyle.ts`, `reviewData.ts`          |
| Section box         | the box becomes a `cut` of mode union (box: 6 outward planes turned by `rotationZ`; planes as stored), so clipping and hatched caps are those of `cut`; unknown id `VIS_SECTION_BOX_NOT_FOUND`. Framing keeps the whole scene.                                                                                                                                                                                                                                                           | `reviewStyle.ts` `sectionBoxCut`           |
| Review shading      | `shading: 'review'`: the selection (viewpoint `selection`, entities of `issueId`, `highlightEntityIds`) keeps its colour, everything else is blended 70 % toward the background. A colour change of the scene, so it works in perspective and with the native renderer. With nothing to highlight the picture stays flat and the summary says so.                                                                                                                                        | `reviewStyle.ts`                           |
| `visibleEntityIds`  | `data.visibleEntityIds` (first 500) + `visibleEntityCount` on every render_view; the read-only query `visible_entity_ids` (toolset review) answers without rendering. Stages: viewpoint visibility, profile hidden rules, section box (entity AABB wholly outside), view frustum (the render camera; the query uses the viewpoint camera at `width` x `height`, no frustum without a viewpoint; a turntable strip has none). Conservative AABB tests: a listed id may be fully occluded. | `viewVisibility.ts`, `visibleEntityIds.ts` |
| `VIS_RENDER_BUDGET` | pixels x supersample^2 > 16 M is refused before rendering (`supersampleFor` is the raster's own factor). A single picture is clamped to 2000 x 2000 = 4 M samples, so only a turntable strip (frames x width x height pixels, counted once because its frames are drawn one at a time) can reach it: 12 frames at 2000 x 2000 are refused.                                                                                                                                               | `viewVisibility.ts`, `renderView.ts`       |

Limits and rules added by review: `visible_entity_ids` applies a frustum only with `viewpointId` (without one `data.frustum` is false); its camera is checked (`VIS_CAMERA_INVALID`, path `viewpointId`, also for an up vector parallel to the direction) and the active exploded view applies as in render_view. In render_view a degenerate camera gives no frustum and `data.frustumSkipped` names the reason. Framing always uses the whole scene, so a profile that hides entities does not change the camera. A named profile that does not exist is always `VIS_PROFILE_NOT_FOUND`, even when it equals the stale active id. The turntable strip budget counts the strip's pixels (frames x width x height); behaviour change for existing callers: a strip over 16 M pixels (12 frames at 1920 x 1080) is now `VIS_RENDER_BUDGET`; the frames are drawn one at a time and only their PNG strings are held together.

Not built (still VIS-M4 / M6): the sun shadow, ambient occlusion, Blinn-Phong with material classes, sky / ground, the `edges` / `shadows` / `ambientOcclusion` / `sun` params, profile transparency, the `rendererVersion` bump. `renderPlan` counts are not used by `render_view`: `planScene` costs 3.8 s at 10^6 instances (§12.8), more than the render it would guard, so the budget uses the sample count and the frustum cull tests AABBs directly.

Validation: `tests/unit/render/reviewRender.test.ts` (SVG fill colours of a recoloured / dimmed picture, clipping, legend counts, visibility stages, frustum culling, refusals, purity, budget).

### 12.11 As built — VIS-UI Review panel, redlines, section box, colour profile in the viewport, 2026-11-03

Presentation and param gathering only: every change is `store.dispatch(command)` with a command of §12.6 / §12.7 / §12.9; no core, plugin or server file changed.

| Area                 | As built                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Files                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Review panel         | `ModelReview` sits at the top of the Review tab (above the prototype checks). **Issues**: list (status chip, title, priority, assignee, "clash" mark), new issue (title, priority, assignee; attaches the selection and the redline viewpoint) = `create_review_issue`; **Issues from clashes** (`check_clashes` or `check_assembly`) = `create_clash_issues`; **Import BCF** (file picker, bytes as base64) = `import_bcf`; **Export BCF** = read-only `export_bcf` (`snapshots: false`, downloaded from `data.base64`; an export-gate refusal shows as its summary). **Detail**: description, viewpoint buttons (`apply_viewpoint`), comments, `add_review_comment` (`author: 'human'`, cites the active redline viewpoint when the issue owns it), status move. | `src/ui/panels/review/model/{ModelReview,IssuesSection,IssueDetail,BcfActions}.tsx`, `issueModel.ts`                              |
| Signed acts          | Closing, re-opening a closed issue and deleting an issue open `SignActDialog` with `statusPayload` / `deletePayload` of the issue as it is at the click (`reviewActs.ts`: the bytes the command rebuilds); `set_issue_status` / `delete_review_issue` are dispatched only with the returned `confirmation`. Other moves dispatch without one. A signed issue shows "frozen against imports" (§12.9). `isHumanMove` mirrors `ISSUE_TRANSITIONS`.                                                                                                                                                                                                                                                                                                                    | `IssueDetail.tsx`, `issueModel.ts`                                                                                                |
| Viewpoints, redlines | Save the live orbit camera (`save_viewpoint`, `viewpointParams`), go to a view (`apply_viewpoint`, which also makes it the redline viewpoint), tools **Line / Arrow / Cloud / Text** + colour, markup list with `delete_markup`. `MarkupOverlay` is a DOM + SVG layer over the canvas: it takes the pointer only while a tool is armed; a drag is ONE `add_markup` (`space: 'screen'`, points normalised to the viewport, origin top-left, `author: 'human'`; cloud = the four corners of the dragged rectangle, drawn as outward arcs; text = one anchor + an inline field). It draws the markups of the redline viewpoint from the document. `redlineStore` holds only the tool, colour and viewpoint.                                                           | `ViewpointsSection.tsx`, `src/ui/viewport/3d/review/{MarkupOverlay.tsx,markupDraw.ts}`, `src/ui/store/redlineStore.ts`            |
| Section box          | "Section box around selection / model" = `set_section_box` (`activate: true`, 5 % margin from `entityBoundsInDoc`); per box **Clip** (`set_section_box` with `activate`) and **Delete** (`delete_section_box`). `SectionBoxGizmo` draws the active box (outline, turned by `rotationZ`) and a round grip per face; dragging a grip moves that face along its normal (the axis-ray maths of the feature handles; the opposite face stays), live through `sectionBoxDraftStore`, and **release commits one `set_section_box`** (like the transform gizmo). Plane-form boxes have no grips. `resizeSectionFace` is pure (minimum side 1e-3).                                                                                                                          | `src/ui/viewport/3d/review/{SectionBoxGizmo.tsx,sectionBoxMath.ts}`, `src/ui/store/sectionBoxDraftStore.ts`, `DisplaySection.tsx` |
| Clipping             | `ClippingPlane` puts the View-controls section plane and the 1..6 half-spaces of the active section box (the live draft while dragging) into `gl.clippingPlanes`. Global planes cut every material, so the instanced path and a batch renderer clip without touching their materials (reasoned from three.js, not run against a plant batch scene). A model half-space `n·p > offset` becomes the three.js plane `(-n, offset - n·renderOrigin)`. The gizmo is inset by 3e-4 of its size so the global planes do not cut it on the faces.                                                                                                                                                                                                                          | `ClippingPlane.tsx`, `sectionBoxMath.ts`                                                                                          |
| Colour profile       | **Colour profile** select = `set_active_colour_profile` (null = entity colours) with a legend of the active profile's rules. `ProfileTintSync` evaluates the active profile with the same `compileProfile` / `entityPropertyBag` / plugin providers as `colour_by_rule_report` and writes the colours to a new profile layer of `tintStore`; the existing tint consumers (per-entity and instanced solids) read the merged map, and an overlay's own tints (structural utilisation) win over the profile's. `profileTints` is pure (an invalid profile colours nothing; `defaultColour: 'entity'` leaves entities alone).                                                                                                                                          | `src/ui/viewport/3d/review/{ProfileTintSync.tsx,profileTints.ts}`, `src/ui/store/tintStore.ts`                                    |

Decisions and limits:

- **Redlines are screen space.** They are valid for the camera of their viewpoint: the layer draws them over whatever the camera shows, and the panel says to keep the camera where the view was saved. World-space markups (BCF Lines) have no drawing tool yet.
- **Tints colour, they do not hide.** A rule's `hidden` / `transparency` is not applied in the viewport yet, only `appearance.colour` and `defaultColour`. The plant batch renderer reads the merged tints too (§12.8b).
- **Clipping off** is `set_active_section_box { id: null }` (a "Clip off" button in the panel while a box is active; §12.12).
- **BCF snapshots from the UI canvas** (Q7) are not built; the UI export uses `snapshots: false` (the CLI keeps the reference raster default).
- **`author` of comments and markups is an unverified label.** The UI sends `human`, but only signed history entries are acts; an unsigned human comment leaves `check_review` unchanged (test).
- **Stale signatures are refused and told.** The signed payload is built from the issue as it was at the click; if the issue changed before signing, the command rejects and the panel shows the summary (`issue-notice`). Every status / delete dispatch shows a refusal this way.
- **Picking respects the clip.** `ClippingPlane` publishes the active planes (`activeClipPlanes`); `selectOnClick` and the instanced click ignore a hit on the clipped-away side, so the click falls through to what is visible. The implicit GPU preview cap `MAX_CLIP_PLANES` is 8 (view plane + 6 box faces + 1).
- **Gizmo.** The draft box is kept until the document's box equals it (no snap-back while the command is in flight; a refused command clears it); `pointercancel` restores the orbit controls.
- **Not verified in the desktop app in this session**: covered by unit and component tests; the r3f gizmo drag and `gl.clippingPlanes` were not run in a GPU window.

Tests: `tests/component/reviewViewportMath.test.ts` (section-box clip planes incl. render-origin shift and rotation, face resize, `profileTints`, tint layers, markup maths) and `tests/component/ModelReview.test.tsx` (issue list, create, comment, unsigned move; the signed close compares the signed bytes with `statusPayload` and the dispatched `confirmation`; delete dialog; clash and BCF import dispatch; viewpoints; redline drag to `add_markup`; section box; colour profile).

### 12.12 As built — VIS-M6 walk / fly, realism tiers, Clip off, 2026-11-04

- **Clip off.** `DisplaySection` shows a "Clip off" button while `review.activeSectionBoxId` is set; it dispatches `set_active_section_box { id: null }` (the box stays; the per-box "Clip" button switches it back on).
- **Walk / fly** (`src/ui/viewport/3d/navigation/`): Orbit / Walk / Fly in the viewport toolbar (`useNavigationStore`, UI-only, not persisted, no command, no document write). Pure maths in `navigationMath.ts`: mouse look (pitch clamped to ±88.9°, yaw wrapped), `inputFromKeys` (WASD / arrows, Q/E or C/Space down/up, Shift boost x3), `navigationSpeed` (model diagonal in ~12 s, floored; walking pace 1.4 m/s for an empty document), `stepNavigation` (walk stays level at floor z=0 + 1.6 m eye height, no gravity or collision; fly moves along the view, rise along world Z). `NavigationController` (in-Canvas) holds the eye in WORLD space (camera + `renderOrigin`) so the floating origin can rebase underneath, and parks the orbit target ahead of the eye each frame so `RenderOriginSyncer`, `AdaptiveClipping` and the hand-back to orbit keep working. A click on the canvas requests pointer lock (look with movement; a plain drag also looks); Esc or losing the lock returns to Orbit, which continues from the walked pose. Orbit never writes the camera into the document (`CameraReactor` is one-way), so neither does walk / fly: nothing is dispatched on exit. Keys are captured on `window` and stopped, so single-key tool shortcuts do not fire while navigating.
- **Realism tiers** (`useRealismStore`, persisted per user in `localStorage` key `llull-realism`; toolbar select next to Quality). Standard = the existing quality tier by scene size (unchanged). Draft = no key-light shadows, no PCSS, no contact shadows, no plant-batch casting. High = the high settings whatever the scene size, with 24-sample PCSS, 4096² key shadow map, contact shadows, and every plant LOD casting (Standard: LOD 0-1). Plant batch meshes read it (`castShadow` by LOD, `receiveShadow` follows the key light). Mapping in `useRenderQuality.settingsFor`.
- **Deviations from the milestone row.** No CSM (neither drei nor three-stdlib ships a cascaded shadow rig in the installed versions, and the scene-fitted single directional light already covers a plant); no GTAO / SSAO (`postprocessing` is not a dependency and none was added); no feature-edge toggle (solids have no edge-line rendering to toggle).
- **Left.** ~~Material classes; `render_walkthrough` camera paths (core)~~ (built, §12.14); floor following from the active level or terrain, gravity and collision; GTAO and edges; CSM for very large sites.
- **Not verified in the desktop app** (no GPU window in this session); covered by `tests/unit/navigationMath.test.ts` (look, speed, keys, step) and `tests/component/ViewportNavigationRealism.test.tsx` (toggle, tier mapping, persistence) and `ModelReview.test.tsx` (Clip off).

### 12.13 As built — VIS-M7 core part: instance BVH, cached scene, clash broad phase, 2026-11-04

| Area              | As built                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Files                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| BVH               | `buildInstanceBvh(packBoxes(boxes))`: deterministic binned SAH (16 bins, split on the widest centroid axis, leaves of at most 4 boxes, identical-centroid runs halved by index), flat typed arrays. Queries `frustumQuery(planes)`, `rayQuery(origin, direction)`, `boxQuery(min, max)` return ascending indices. The per-box predicates (`boxInsidePlanes`, `rayHitsBox`, `boxOverlapsBox`) are exported: a node box only prunes (all predicates are monotone in containment) so results equal the brute-force scan exactly; a node fully inside the frustum is taken whole. Boxes must be finite. | `packages/core/src/geometry/instanceBvh.ts`                  |
| Scene memo        | `planSceneOf(doc)`: `planScene` memoized in a `WeakMap` keyed on the document object, plus the BVH frustum query for `planRender({ query })` from 500 000 instances on the second call for the same document (never on the first: a one-shot would pay the build for nothing). `planRender` skips its dedupe + sort when the query result is already strictly ascending. `render_stats` uses it.                                                                                                                                                                                                    | `geometry/planSceneCache.ts`, `plant/display/renderStats.ts` |
| Clash broad phase | `check_clashes` visits, per solid, only the later solids whose inflated world extent (`boxExtent`, margin 1e-6) touches its own, and for a clearance zone only the solids touching the zone: same pairs in the same order as the full scan, so the result is bit-identical. From 64 solids; the narrow phase (`boxOverlap`) is unchanged.                                                                                                                                                                                                                                                           | `industrial/clash/clashBroadPhase.ts`, `clash.ts`            |
| Tests             | `tests/unit/geometry/instanceBvh.test.ts` (frustum / ray / box = brute force on 10⁴ random AABBs incl. 300 zero-size boxes, determinism, empty / one / identical boxes, invalid rays); `tests/unit/render/planSceneCache.test.ts` (memo, second-call BVH, `planRender` through the BVH query equals the default plan on SYN-RACK-v1); `tests/unit/building/clashBroadPhase.test.ts` (BVH scan = full scan on randomized buildings of 400 and 900 elements, two tolerances, level filter, empty building; `tests/helpers/clashStress.ts`)                                                            | VC-VIS-20..23, VC-VIS-60 (TS side)                           |

Measured (2026-11-04, Windows 11, shared machine under parallel load, so indicative; `VIS_PERF=1 npx vitest run tests/unit/render/renderStatsPerf.test.ts tests/unit/building/clashBroadPhase.test.ts --disableConsoleIntercept`):

| N         | `planScene`  | BVH build                   | frustum query, narrow view: brute / BVH | `render_stats` before (every call) | after: call 1 / call 2 / call 3                                     |
| --------- | ------------ | --------------------------- | --------------------------------------- | ---------------------------------- | ------------------------------------------------------------------- |
| 1 832     | 7 - 13 ms    | 10 - 18 ms                  | 1.4 / 0.2 ms                            | 12 ms                              | 22 / 5 / 4 ms                                                       |
| 10 076    | 29 - 65 ms   | 22 - 42 ms                  | 1.0 - 4.9 / 0.1 ms                      | 35 ms                              | 67 / 15 / 13 ms                                                     |
| 100 071   | 224 - 418 ms | 125 - 229 ms                | 4 - 8 / 0.1 ms                          | 314 ms                             | 474 / 44 / 36 ms                                                    |
| 1 000 037 | 2.4 - 4.6 s  | 1.3 - 3.6 s (3 axes: 3.7 s) | 49 - 101 / 0.1 ms                       | 3 389 ms                           | 4 837 / 4 064 (builds the BVH) / 290 ms (brute query: 517 - 634 ms) |

- **Decisions.** (1) The 10⁶ TypeScript build misses 1.5 s on a loaded machine (1.3 s at best); it stays a build for a worker, and the RS-6 option (`llull-bvh` WASM or `llull-compute geomq`) is not built here. (2) The brute-force frustum scan is only 50 - 100 ms at 10⁶, so the BVH never pays for one `render_stats`: the win is the cached `planScene` (4.8 s to 0.3 s on a repeated call, target < 500 ms met for call 2 and later), and the BVH threshold is 500 000 instances on the second call for the same document (break-even ~15 calls). (3) Split on the widest centroid axis only: SAH over three axes built 1.5x slower for no measurable query gain. (4) `check_clashes` broad phase: from 64 solids (break-even ~40 elements); 400 elements 585 ms to 111 ms, 3 000 elements 6.3 s to 0.4 s, 6 000 elements 30.6 s to 3.1 s (narrow phase dominates from there), identical results.
- **First call per document** still pays `planScene` (~2.5 - 4.6 s at 10⁶: prototype keys and bounds); only a repeated call on the same document object is fast. The cache lives in one host process; a CLI call on a freshly loaded file does not benefit.
- **UI part built 2026-11-04: picking through the BVH.** `plantRayIndex.ts` builds the scene's instance BVH once per scene object (a later task after the scene changes, or on the first pick; a newer scene drops the old tree) and `rayCandidates` serves one ray query to all buckets of a pick. `plantPick.ts` `bucketRaycast` is the `raycast` of each plant `InstancedMesh`: BVH candidates (scene indices), mapped to bucket `instanceId` by binary search on `DrawBucket.members`, then three's own `Mesh.raycast` per candidate (same hits as `InstancedMesh.raycast`, which tests every instance); a hit on the side the section plane clips away (`activeClipPlanes`) is dropped so the next hit behind it is pickable. Test: `tests/unit/plantPick.test.ts` (identical hit lists and distances on 150 seeded random rays over every SYN-RACK bucket; clip rejection).
- **UI part built 2026-11-04 (VIS-M7c): BVH in a worker, BVH frustum query, pipe markers.** `plantBvh.worker.ts` (protocol `plantBvhProtocol.ts`: request `{ key, boxes }`, answer `{ key, buffers }` of `exportInstanceBvh`, buffers transferred) builds the tree; `plantBvhBuilder.ts` runs it for scenes from 10⁴ instances (`WORKER_MIN_INSTANCES`), else, without `Worker`, after a worker error or an invalid answer, in a deferred main-thread task; one build is current, an answer of an older scene is dropped by key; `plantRayIndex.ts` picks through it (a pick before the tree is ready builds it on the spot). `usePlantBvh` (external store, `useSyncExternalStore`) hands the finished tree to `usePlantPlan`, which then passes `bvh.frustumQuery` as the `query` of `planRender` (results identical by contract, tested on SYN-RACK); scenes under 10⁴ instances never re-render on a tree notification (the brute force is under 5 ms there). **Pipe markers:** `pipeMarkers/PipeMarkerOverlay.tsx` draws the read-only `pipe_markers` query (positions mm absolute, divided by `MM_PER_UNIT`, inside the floating-origin group; recomputed on document change, not selection): one `InstancedMesh` of cones along the tangent coloured with the rule `fieldHex`, and a drei `Billboard` + `Text` with `markerLetters` / `letterHex` on the middle marker of each lettered run (at most 200 labels); runs with no matching rule are not drawn; arrow length is a fixed 320 mm (the answer has no pipe diameter). Toggle `usePipeMarkerStore` in the review Display section ("Show pipe content markers"). Tests: `tests/unit/plantBvhBuilder.test.ts`, `tests/unit/pipeMarkerData.test.ts`, `tests/component/PipeMarkerToggle.test.tsx`. Not measured in the desktop app at 10⁶ instances yet.
- **Left:** (1) the worker build of 10⁶ instances is still 1.3 - 3.6 s of worker time in the renderer; the native tree is built (below) but not wired, and `packBoxes` of the scene runs on the main thread. (2) glTF instancing (`EXT_mesh_gpu_instancing`) is `export_gltf` in core, not UI: built in VIS-M8a (§12.15). (3) `ctx.spatialIndex` (RS-6) and the host transport that feeds the native tree (wiring plan below).
- **Native side built 2026-11-04 (VIS-M8b, VC-VIS-60 native side).** `llull_bvh::instance` (`solver/crates/llull-bvh/src/instance.rs`) ports `instanceBvh.ts`: same binned SAH, same node numbering and floating-point expression order; `InstanceBvh::build` plus `frustum_query` / `ray_query` / `box_query` (ascending indices). It is a new module of the existing `llull-bvh` crate (the name RS-6 reserved; already in the workspace default members, hence in `npm run native:check`; no new dependency), next to the median-split closest-point tree, which is a different algorithm and stays untouched. No job contract or transport yet. **Parity:** `tests/unit/native/nativeReference.test.ts` writes `solver/crates/llull-bvh/tests/fixtures/instance_bvh.json` from the TS build (`LLULL_WRITE_NATIVE_FIXTURES=1`; the suite fails while the committed file is stale) for six seeded sets (700 boxes with 40 zero-size and 25 identical, 3 000, 37 identical, 60 zero-size, 3, empty) with 14 frustum, 20 ray and 22 box queries each; `tests/instance_parity.rs` asserts that the native `order`, `nodeStart`, `nodeEnd`, `nodeChild` and `nodeBox` equal the TS arrays exactly and that every query equals both the TS result and the brute-force scan. Mutation checks: 8 bins instead of 16 fails the tree test; a swapped near / far corner in the fully-inside test fails the query test.
- **Native measurement (same machine and seeded boxes, 3 runs, loaded desktop):** 10⁶ boxes native 1.18 - 1.30 s (release, one thread, `cargo run --release -p llull-bvh --example build_bench -- 1000000`) against 2.8 - 3.0 s for `buildInstanceBvh` in node; 10⁵ boxes 53 - 63 ms against 179 - 226 ms. About 2.4x at 10⁶ and 3.4x at 10⁵: faster, but not the order of magnitude that pays for a transport alone (at 10⁶ the box buffer is 48 MB in and ~55 MB of tree arrays out).
- **Wiring plan (not built; the renderer stays on the TS worker for now).** The consumer of the 10⁶ build is the renderer worker (`plantBvh.worker.ts`), which cannot reach a sidecar and may not use WASM as a primary path (LC1). Within L2/L6/L9 the wiring is: (a) an `llull-compute bvh <job-folder>` subcommand (binary boxes in, tree arrays out, the geomq job pattern) behind a server transport with `NATIVE_TOOL_MISSING` falling back to `buildInstanceBvh`; (b) an injected `ctx.spatialIndex` port in core (`build(boxes) => InstanceBvh`, default the TS build, installed by the server / composition root, never a native call from core) for `planSceneOf` and `check_clashes` on the CLI path; (c) in the renderer, `plantBvhBuilder` asking the backend for the tree (`importInstanceBvh` validates it) with the worker build as fallback and reference. Weigh before (c): ~100 MB over loopback per 10⁶-instance scene change eats most of the ~1.7 s saved; it pays once the boxes already live native-side (a Rust `planScene`) and only the visible set crosses the wire. (a) and (b) alone pay for CLI `render_stats` / clash on very large documents.

### 12.14 As built — VIS-M8c material classes and walkthrough camera paths (core), 2026-11-04

Pure core commands and data; no plugin, no UI. Both parts are display only and metaHistory (no feature step).

| Area                  | As built                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Files                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Material class model  | `DisplayModel.materialClasses?` (document classes and overrides) and `materialClassOf?` (entity id to class id). `MaterialClass` = `{ id, name, colour: #rrggbb                                                                                                                                                                                                                                                                                                             | null, metalness, roughness }`. The ten defaults of §5.6 (`matclass:llull-v1`) are a constant (`DEFAULT_MATERIAL_CLASSES`), not stored in the document, so an old document is unchanged; a document class with a default's id overrides it. `structural_steel_painted`and`carbon_steel_pipe_painted`have colour null (paint system / service colour come from the colour profile);`cast_steel_valve`keeps`#2f5fa8` as its fallback colour. | `model/display.ts`, `geometry/materialClasses.ts`                     |
| Commands              | `define_material_class` (upsert; `VIS_MATERIAL_CLASS_INVALID`), `delete_material_class` (restores a default override; custom class in use: `VIS_MATERIAL_CLASS_IN_USE`; none: `VIS_MATERIAL_CLASS_NOT_FOUND`), `assign_material_class` (`classId` null clears; unknown entity ids skipped and named; `VIS_MATERIAL_CLASS_NOT_FOUND` / `_INVALID`), `list_material_classes` (read-only: classes with source and assigned counts). Toolset `review`.                          | `commands/display/materialClasses.ts`, `toolsets.ts`                                                                                                                                                                                                                                                                                                                                                                                      |
| Appearance in renders | `render_view` (with or without a profile) and `render_walkthrough` draw a 3D entity in its class colour. Precedence: matching profile rule, then class colour, then profile `defaultColour`, then the entity colour. Documents with no assignment render byte-identically (hashes unchanged, `rendererVersion` not bumped). Metalness and roughness are stored and listed for the viewport and the future Blinn-Phong pass (§5.6, still not built in the reference raster). | `commands/render/{reviewStyle,renderWalkthrough}.ts`                                                                                                                                                                                                                                                                                                                                                                                      |
| Properties and plan   | The class id is the entity property `materialClass` (colour-profile rules and `check_display` see it) and the material class of `planScene` / `render_stats` (assigned class, else `materialId`, else `unassigned`; this replaces the §12.8 interim rule only for assigned entities).                                                                                                                                                                                       | `geometry/entityProperties.ts`, `geometry/renderPlan.ts`                                                                                                                                                                                                                                                                                                                                                                                  |
| Persistence           | Load validation checks both maps (record shape, `#rrggbb` or null, numbers in [0, 1], string class ids). `set_active_colour_profile` and `delete_colour_profile` now keep the other `display` keys.                                                                                                                                                                                                                                                                         | `persistence/displayValidation.ts`, `display/colourProfiles.ts`                                                                                                                                                                                                                                                                                                                                                                           |
| Camera paths          | `render_walkthrough` gets `path: 'linear'                                                                                                                                                                                                                                                                                                                                                                                                                                   | 'smooth'`(default linear, so existing digests do not change).`smooth`moves the eye on a uniform Catmull-Rom spline through the key eyes (§5.3; the end tangents are mirrored); direction and up stay spherical, fov and view height linear. Keys are passed through at their times.`data.path`echoes the choice. Frame count,`maxFrames`, `VIS_RENDER_BUDGET`(100 Mpx),`NATIVE_TOOL_MISSING` are unchanged.                               | `geometry/viewpointCamera.ts`, `commands/render/renderWalkthrough.ts` |

Decisions:

- **A path is the walkthrough.** The camera path is the ordered viewpoints of `create_walkthrough`; no separate path entity. `path` is a render choice, not stored, so one walkthrough can be rendered both ways.
- **Frames stay floor(duration x fps) + 1.** §5.3 says ceil; the as-built rule (§12.1, tested, and the last frame lands on the last key when duration x fps is whole) is kept. §5.3 is read as floor.
- **Slerp, not quaternions.** Directions and ups are slerped as vectors (as built since VIS-M9); the Catmull-Rom spline is per segment with uniform parameter, so with unequal key durations the speed jumps at keys (C1 in position only for equal durations).
- **Assignments follow their entity.** `withoutEntities` (the one delete path: `delete_entities`, boolean consumption, ...) drops the `materialClassOf` entries of removed ids, so a reused id never inherits a class. The assignment is keyed by entity id: copies and duplicates (`duplicate_entities`, patterns) do NOT carry it. Deleting an override of a default keeps the assignments, which then resolve to the restored default (tested).
- **3D only.** `assign_material_class` refuses 2D shapes and curves (`VIS_MATERIAL_CLASS_INVALID`, ids listed) because a class is never drawn on them; clearing (`classId` null) is always allowed.
- **Metalness and roughness are stored but not used by any render yet**: `render_view` / `render_walkthrough` use the colour only.
- **Class assignment is by entity id, not by rule.** A plugin (e.g. the plant display plugin) can assign classes from its own data with `assign_material_class` in a later change; a rule-based assignment (`materialClassRules`) was not added to keep the model small.

Left: the viewport reading of `display.materialClasses` (three.js `MeshStandardMaterial` colour / metalness / roughness per class, and the Display panel to define and assign classes) is a UI follow-up; Blinn-Phong with class metalness / roughness in the reference raster; plant-specific default assignments (grating, handrail, valve) from the plant plugins.

Validation: `tests/unit/display/materialClasses.test.ts`, `tests/unit/render/walkthroughPath.test.ts`.

### 12.15 As built — VIS-M8a glTF `EXT_mesh_gpu_instancing` export (TR-VIS-25), 2026-11-04

| Area        | As built                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Files                                                            |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Option      | `export_gltf { instancing?: 'expand' or 'gpu' }`, default `expand`. The default stays byte-identical (golden / snapshot output unchanged) and universal glTF 2.0: not every importer reads the extension, and a reader without it shows one copy. A plant of 10⁵ - 10⁶ copies passes `gpu` explicitly (the agent / CLI decides; nothing is refused). The extension is listed in `extensionsUsed` only, not `extensionsRequired`.                                                                                                                                                 | `exchange/exportGltf.ts`                                         |
| Buckets (a) | A component **instance** entity is not expanded: each child of its component is one prototype (tessellated once, in the component frame, with its appearance) and one node carrying every instance of that component (same material override and entity group). Per-instance TRS = `position` (TRANSLATION), Euler XYZ `rotation` as a unit quaternion (ROTATION, xyzw) and `scale` (SCALE): world = T · R · S · prototype, exact for any non-uniform scale. A zero or negative (mirroring) scale component stays expanded (the extension defines no per-instance winding flip). | `gltfScene.ts` `collectSceneParts` (`sink`), `gltfInstancing.ts` |
| Buckets (b) | Placed solids (SYN-RACK style: identical local geometry and appearance, different `position` / `rotation`) that already share one mesh in `expand` mode become ONE node with TRANSLATION (+ ROTATION when a copy is rotated). Parts in different entity groups stay separate nodes (a node has one parent); a unique part stays a plain node.                                                                                                                                                                                                                                    | `gltfScene.ts` `instancedGroups`                                 |
| Accessors   | TRANSLATION VEC3 FLOAT, ROTATION VEC4 FLOAT (unit quaternion), SCALE VEC3 FLOAT, equal `count`, no buffer-view target; ROTATION / SCALE are omitted when every instance is identity there. Node extras: `llullIds` (instance entity ids, instance order), `kind`, `instanceCount`. Data adds `instanceCount`, `instancedNodeCount`; `triangleCount` is counted per instance (equal to the expanded count) without building the copies' triangles.                                                                                                                                | `gltfBuilder.ts` `instancedNode`, `exportGltf.ts`                |
| Import      | There is no `import_gltf` (`import_mesh` takes raw triangles; no glTF reader exists in core, protocol or server), so nothing reads the extension. A reader is a separate task (one `insert_instance` per bucket entry).                                                                                                                                                                                                                                                                                                                                                          | -                                                                |
| Tests       | `tests/unit/exportGltfInstancing.test.ts`: quaternion vs `applyEulerXYZ`; default = expand without the extension; accessor type / count / component type; T · R · S of a rotated + non-uniform-scaled instance maps the prototype onto the expanded geometry; identity omission; mirrored fallback; placed buckets and group split; triangle count; SYN-RACK node accounting; GLB; invalid value; purity. Opt-in timing: `tests/unit/exportGltfPerf.test.ts`.                                                                                                                    | -                                                                |

Measured (2026-11-04, Windows 11, shared machine, indicative; `VIS_PERF=1 NODE_OPTIONS=--max-old-space-size=6144 npx vitest run tests/unit/exportGltfPerf.test.ts --disableConsoleIntercept`; JSON text mode, BIN inlined as base64):

| Scene                             | expand                          | gpu                                   |
| --------------------------------- | ------------------------------- | ------------------------------------- |
| SYN-RACK 1 832 solids (placed)    | 300 ms, 0.80 MB, 1 832 nodes    | 217 ms, 0.16 MB, 13 nodes             |
| SYN-RACK 10 076 solids (placed)   | 1 841 ms, 4.21 MB, 10 076 nodes | 1 212 ms, 0.61 MB, 13 nodes           |
| SYN-RACK 100 071 solids (placed)  | out of memory (default heap)    | 39.6 s (6 GB heap), 5.66 MB, 13 nodes |
| 1 000 instances of a 2-solid part | 504 ms, 2.46 MB, 2 000 nodes    | 22 ms, 0.15 MB, 2 nodes               |
| 10 000 instances                  | 4 641 ms, 24.6 MB, 20 000 nodes | 74 ms, 1.45 MB, 2 nodes               |
| 100 000 instances                 | out of memory (6 GB heap)       | 689 ms, 14.7 MB, 2 nodes              |
| 1 000 000 instances               | not attempted                   | 8.9 s, 148 MB, 2 nodes                |

- **Decisions.** (1) Component instances scale: the prototype is tessellated once, so the cost is O(instances) in typed floats (10⁶ in 8.9 s, mostly JSON text of the id list and base64; GLB mode skips the base64 text). (2) Placed solids still tessellate every solid before the mesh-sharing pass finds the copies, so SYN-RACK saves size (7x at 10⁴ solids) but little time, and 10⁵ placed solids need a multi-GB heap.
- **Left.** (1) Group placed solids by prototype key (`prototypeKeyOf`) before tessellating, so 10⁵ placed solids export without a multi-GB heap. (2) A glTF reader (`import_gltf`) that turns buckets into instances. (3) `llullIds` of 10⁶ instances is 10 MB+ of JSON (≈ 12 - 15 bytes per id, indented one per line), about 10 % of the 148 MB file; a range form would shrink it.

## 13. References

- [R1]–[R15]: see [`FUNCTIONAL_SPEC.md` §11](FUNCTIONAL_SPEC.md#11-references).
- [R16] three-mesh-bvh 0.9.16 (npm, MIT): README (BatchedMesh BVH, ObjectBVH frustum culling) — https://registry.npmjs.org/three-mesh-bvh/-/three-mesh-bvh-0.9.16.tgz (downloaded 2026-10)
- [R17] @react-three/drei 10.7.9 (npm, MIT): `Detailed`, `Instances`, `PerformanceMonitor`, `AdaptiveDpr`, `Bvh`, `Edges` — https://registry.npmjs.org/@react-three/drei/-/drei-10.7.9.tgz (downloaded 2026-10)
- [R18] ral-colors 1.0.1 (npm, MIT): RAL classic table used only for display approximations — https://registry.npmjs.org/ral-colors/-/ral-colors-1.0.1.tgz (downloaded 2026-10)
- [R19] llull `docs/QUALITY_GATES.md` (proposed gates 2 and 4) and `docs/INDUSTRIAL.md` (clash coordination).
- [R20] RS1 native compute programme — [../../decisions/RS1-native-compute.md](../../decisions/RS1-native-compute.md); wgpu https://crates.io/crates/wgpu (version recorded at RS-0)
