# DIR — Direct and freeform editing — Technical specification

Gap id: **DIR** · Companion: [FUNCTIONAL_SPEC.md](FUNCTIONAL_SPEC.md) · Validation: [validation/README.md](validation/README.md) ·
Laws: `.claude/rules/architecture.md` L1–L10, `.claude/rules/react.md` R1–R11 · Decisions: LC1 (local only), C7 (best-suited stack).

---

## 1. Current state in llull

### 1.1 Commands and code

| Capability          | Command                                                                                                                                    | Files                                                                                                                                                                                     | What it really does                                                                                                                                                                                                                                                                                           | Limits for direct editing                                                                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SubD solid          | `add_subdivision_solid`                                                                                                                    | `packages/core/src/commands/solids/subdivision.ts` (178 lines), `geometry/subdivision.ts` (237)                                                                                           | Box / cylinder preset or custom **closed** cage (validated: 2-manifold, consistent winding, no pinch); `creases` = `[a, b]` pairs, infinitely sharp; `levels` 0..`MAX_SUBDIVISION_LEVELS` = 4; ≤ 2000 cage vertices; `data { vertexCount, faceCount, vertices }` (world, rounded 1e-6)                        | No sharpness values, no vertex sharpness, no boundaries, no symmetry, no element ids                                                                                                           |
| Catmull-Clark rules | —                                                                                                                                          | `geometry/subdivision.ts` `subdivideOnce`                                                                                                                                                 | Face point = centroid; edge point = midpoint if sharp else mean of ends + face points; vertex: > 2 sharp edges stays (corner), 2 sharp → (6v + a + b)/8, else (Q + 2R + (n−3)P)/n; each n-gon → n quads `[v, e(v,next), f, e(prev,v)]`; crease halves stay sharp                                              | Same masks as OpenSubdiv for sharpness 0 and ∞ (checked: `validation/ref_catmull_clark.mjs`), no semi-sharp / Chaikin, closed only                                                             |
| Cage edit           | `edit_subdivision_cage`                                                                                                                    | `commands/solids/subdivisionCage.ts` (165)                                                                                                                                                | Select by `vertexIndices` or world `region` box (none = all); `falloff` distance with smoothstep weight `t²(3−2t)`, t = 1 − d/R, d = Euclidean distance to the nearest selected vertex (or to the box); `scale` about `pivot` then `translate`; `crease` on/off for edges between selected vertices; `levels` | No rotate, no edge / face selection, one falloff curve, no topological distance, no symmetry, indices only (shift after topology edits)                                                        |
| SubD → exact        | (implicit)                                                                                                                                 | `geometry/subdivisionPatches.ts` (113) `quadCagePatches`, `server/src/native/kernelLeaves.ts` `subdivisionPayload`, `solver/crates/llull-kernel-occt/src/recipe/nodes.rs` `subdivision()` | Smooth cage (levels ≥ 1): once-refined cage → one bicubic Bézier patch per quad (geometry patches, Loop & Schaefer style), shared boundary poles, sewn into a B-spline solid by OCC; faceted / failed → sewn triangles                                                                                        | Not a user command; no sheets output, no packed option, no EV continuity choice, no deviation report; `levels` ignored by the exact path (volume differs from the no-kernel mesh volume, §5.8) |
| NURBS curve edit    | `edit_nurbs`                                                                                                                               | `commands/surface/editNurbs.ts` (88), `lib/nurbs/edit.ts`                                                                                                                                 | `move_pole` (one, absolute `to`), `set_weight`, `insert_knot`, `elevate_degree`, `reverse`; shape change measured for the preserving ops                                                                                                                                                                      | One pole per call, no delta, no falloff, no point drag                                                                                                                                         |
| NURBS surface       | `create_nurbs_surface`, `surface_from_points`, `loft_surface`, `fill_surface`, `trim_surface`, `sew_surfaces`, `thicken_surface`, analysis | `commands/surface/*`, `lib/nurbs/surfaceEdit.ts` (`elevateSurface`, `insertSurfaceKnot`, `reverseSurface`, `transposeSurface`, `extractSubSurface`)                                       | Library ops exist                                                                                                                                                                                                                                                                                             | **No command edits surface poles / weights / knots**                                                                                                                                           |
| B-rep face ops      | `push_pull_face`, `replace_face`, `draft_faces`, `split_face`                                                                              | `commands/brep/faceOps.ts` (197), `faceOpRun.ts`, `faceReferences.ts`, `model/faceOps.ts`; native `cpp/face_ops.cxx`                                                                      | One `{ op: 'faceOp' }` recipe node; faces by index / point / persistent name (recorded for regeneration); push-pull = `BRepPrimAPI_MakePrism` of the face + boolean fuse / cut; replace = push-pull to a parallel plane; draft = `BRepOffsetAPI_DraftAngle`; split = `BRepFeat_SplitShape`                    | Planar faces only for push / replace; no translate / rotate / offset of curved faces; no delete-face                                                                                           |
| Defeaturing         | `defeature_for_analysis` (plugin `cae`)                                                                                                    | `packages/domain-cae/src/commands/shellCommands.ts`, `solver/crates/llull-netgen/cpp/shape.cxx` (`BRepAlgoAPI_Defeaturing`)                                                               | Removes faces on the **analysis copy** at meshing time                                                                                                                                                                                                                                                        | Proves `BRepAlgoAPI_Defeaturing` works in the native build; no design-side command                                                                                                             |
| Gizmo               | —                                                                                                                                          | `src/ui/viewport/3d/TransformGizmo.tsx` (195), `gizmoCommit.ts`                                                                                                                           | drei `TransformControls` on the sole selected entity; on drag END one `move_entities` / `rotate_entity` / `scale_entity`; 3D snapping in `useFrame`                                                                                                                                                           | Whole entities only                                                                                                                                                                            |
| Feature handles     | —                                                                                                                                          | `src/ui/viewport/3d/manipulators/*` (`useFeatureSession`, `featurePlan`, `handleDrag`, `ValueBox`), `src/ui/preview/*`, `store/previewStore.ts`, `PreviewLayer.tsx`                       | Session: value → pure plan → debounced (120 ms) dry run through `execute` → ghost; release / Enter = one dispatch (join / cut = one `build_project`)                                                                                                                                                          | Extrude / fillet / shell only; 120 ms debounce; renderer has only Manifold, so kernel commands refuse in preview (`docs/UI.md`)                                                                |
| Selection           | `set_selection` (session)                                                                                                                  | `commands/document/setSelection.ts`, `store/selectionHooks.ts`                                                                                                                            | Entity ids only                                                                                                                                                                                                                                                                                               | **No vertex / edge / face / pole picking** anywhere in `src/ui` (no `faceIndex` / pick code in the viewport)                                                                                   |
| Display             | —                                                                                                                                          | `entities/solidMeshes.tsx` `SubdivisionMesh`, `NurbsSurfaceMesh.tsx`, `NurbsCurveLine.tsx`                                                                                                | Draw the subdivided triangles / sampled sheet / curve (+ comb, curvature maps)                                                                                                                                                                                                                                | No cage overlay, no control net / poles drawn                                                                                                                                                  |
| Undo                | store `undo` / `redo`, CLI `llull undo`                                                                                                    | `store/store.ts`, `server/src/cli/backend.ts` (`POST /undo`, local `.bak` swap)                                                                                                           | One step per dispatched command                                                                                                                                                                                                                                                                               | Fine: one gesture = one dispatch = one step                                                                                                                                                    |

Toolset: `packages/protocol/src/toolsets.ts` lists `add_subdivision_solid edit_subdivision_cage … edit_nurbs … push_pull_face
replace_face` in toolset `3d`. No command name of §4 exists today (`git grep -n "name: '<name>'" -- packages` returns nothing for
each, checked 2026-10-22).

### 1.2 Measured facts that shape the design

| Fact                                                                            | Value                                                  | Source                                         |
| ------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------- |
| Reference CC (same rules as llull) on a 386-vertex cage, level 3 (24 576 quads) | 30.4 ms median per subdivision (Node 24, this machine) | `validation/data/latency_probe.json` (grade C) |
| Same cage, level 2 (6 144 quads)                                                | 5.1 ms                                                 | same                                           |
| 98-vertex cage level 3                                                          | 6.4 ms                                                 | same                                           |
| Cube cage: level-3 mesh volume vs limit-surface estimate                        | 2.66462478968 vs ≈ 2.62042 (−1.7 %)                    | `validation/data/subd_cube_cases.json`         |
| Fully regular cage → bicubic B-spline vs CC limit                               | 8.9e-16 max (corners), 1.4e-15 (patch centres)         | `validation/data/subd_regular_torus.json`      |

Consequences: per-frame previews must cap the **preview** level at 2 for cages above ~100 vertices (display-only), and volume
results must say which surface they measured.

## 2. Target architecture

### 2.1 Layer placement

| Piece                                                                                                                                                                                                                                | Layer                                                                                                                                                                 | Why (law)                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Subdivision math: CC with semi-sharp creases (Uniform / Chaikin), boundaries, limit masks, tangent masks, Stam evaluation, topology ops (extrude, inset, loop cut, bridge, bevel, delete, fill, weld, slide), element-id bookkeeping | `packages/core/src/lib/subd/*` (pure leaf) + `packages/core/src/geometry/subdivision*.ts`                                                                             | Pure, shared by renderer preview, export, both kernels, codegen (L2, L9); no kernel needed |
| Falloff curves and distance metrics                                                                                                                                                                                                  | `packages/core/src/lib/falloff.ts` (shared with **01 DEF**)                                                                                                           | One definition (FR-DIR-07); data table tested against Blender's formulas                   |
| SubD commands                                                                                                                                                                                                                        | new core feature catalog `packages/core/src/commands/subdivision/catalog.ts` (moves `add_subdivision_solid`, `edit_subdivision_cage` from `solids/`, names unchanged) | Domain-neutral geometry (L5); keeps `solids/` under its file budget                        |
| NURBS edit commands                                                                                                                                                                                                                  | `commands/surface/` (`edit_nurbs` extended, new `edit_nurbs_surface`)                                                                                                 | Next to the NURBS family                                                                   |
| Face move / delete                                                                                                                                                                                                                   | `commands/brep/faceOps.ts` family + `model/faceOps.ts` new `FaceOpParams` kinds; native `cpp/face_ops.cxx`                                                            | Exact kernel only via `ctx.kernel`, `requiresKernel` (L9)                                  |
| SubD → NURBS                                                                                                                                                                                                                         | `commands/subdivision/toNurbs.ts`; sheets path pure core (patches → `nurbs_surface`), solid path via `ctx.kernel` sew                                                 | Kernel-optional with clean fallback (L9)                                                   |
| Direct-edit interaction                                                                                                                                                                                                              | `src/ui/viewport/3d/direct/*` (picking, overlays, session, gizmo adapter), `src/ui/store/directEditStore.ts`                                                          | Presentation + param gathering only (R1); commits through `dispatch` (L1)                  |
| Kernel preview transport                                                                                                                                                                                                             | `server/` `POST /preview` (dry run on the live document with the native kernel) + `src/ui/preview/remotePreview.ts`                                                   | Host transport, no business logic (L6)                                                     |
| CLI                                                                                                                                                                                                                                  | nothing special: registry → toolset `3d` + new toolset view `freeform`                                                                                                | L5                                                                                         |

No new plugin: subdivision and NURBS editing are general geometry used by every domain (L10 applies to domains, not to core
geometry). No new native crate in MVP (§5.10 decision record).

### 2.2 Data flow of one gesture

```
pointerdown on a cage face ──> pick (BVH on the overlay mesh, element id)            [src/ui/viewport/3d/direct/pick.ts]
  └─ DirectEditSession{ tool, entityId, elementIds, gizmoFrame }                       [directEditStore, UI-only state]
pointermove (each frame) ──> gizmo value ──> plan = { name, params }                   [pure: direct/sessionPlan.ts]
  ├─ local command (no requiresKernel): execute(doc, name, params) in the renderer  ── ghost (preview level ≤ 2), per rAF, latest wins
  └─ kernel command: POST /preview { name, params } (debounced 120 ms, cancellable) ── ghost from returned mesh, "previewing…" badge
pointerup / Enter ──> dispatch(name, params) ONCE  ──> POST /command (online) or local execute ──> FeatureStep appended ──> live event
Esc / right-click ──> session.cancel(): ghost cleared, nothing dispatched
```

The ghost stays drawn until the committed document arrives (no flicker), at most 2 s; then the session ends.

### 2.3 Laws check

- **L1 / PRIME DIRECTIVE**: the session never edits `document`; it only computes params. The commit is one `dispatch`. A
  multi-command gesture (extrude-while-dragging then move) is committed as one `build_project` (precedent: join / cut extrusion).
- **L3 purity**: every new command returns a new document; `is pure` tests per command.
- **L4**: entities change only in commands; overlays build display geometry only.
- **L8**: params are intent — element ids, deltas, angles, radii, falloff shape — never resulting vertex arrays (a custom cage at
  creation is the one exception, as today). Element ids are step-scoped and replay-stable (§3.2).
- **L9**: `move_faces`, `delete_faces`, `subdivision_to_nurbs output:"solid"` declare `requiresKernel`; everything else is core.
- **R1–R11**: picking / overlays are r3f components with memoised, disposed geometry; per-frame work in `useFrame` with refs (R9);
  no store mirroring (R3); component tests assert "one dispatch with these params" (R11).

## 3. Data model

### 3.1 SubdivisionEntity v2 (additive)

```ts
// packages/core/src/model/types.ts
export interface SubdivisionEntity extends BaseEntity {
  readonly kind: 'subdivision';
  vertices: ReadonlyArray<Vec3>; // local to position / rotation (unchanged)
  faces: ReadonlyArray<ReadonlyArray<number>>; // CCW from outside (unchanged); open cages allowed when `boundary` is set
  creases: ReadonlyArray<readonly [number, number]>; // legacy: infinitely sharp edges (still read and written)
  levels: number; // 0..4 (unchanged)
  // v2 — all optional, absent = today's behaviour
  edgeSharpness?: ReadonlyArray<{ readonly a: number; readonly b: number; readonly s: number }>; // 0 < s <= 10 (10 = infinite)
  vertexSharpness?: ReadonlyArray<{ readonly v: number; readonly s: number }>; // corner sharpness
  creaseMethod?: 'uniform' | 'chaikin'; // default uniform (OpenSubdiv CREASE_UNIFORM)
  boundary?: 'edge_and_corner' | 'edge_only'; // present => open cage accepted (boundary edges allowed)
  symmetry?: CageSymmetry;
  elementIds?: CageElementIds; // persistent ids (§3.2); minted when first needed
}
export interface CageSymmetry {
  readonly planes: ReadonlyArray<'x' | 'y' | 'z'>; // entity-local planes through the entity origin
  readonly radial?: { readonly axis: 'x' | 'y' | 'z'; readonly count: number }; // COULD
  readonly pairs: ReadonlyArray<readonly [number, number]>; // vertex v <-> mirror(v) per plane combination, computed by set_cage_symmetry
  readonly onPlane: ReadonlyArray<number>; // vertices constrained to a plane
  readonly isolated?: ReadonlyArray<string>; // element ids excluded (COULD)
  readonly tolerance: number; // document units used to pair vertices
}
export interface CageElementIds {
  readonly vertices: ReadonlyArray<string>; // parallel to `vertices`, e.g. "v-3.12"
  readonly faces: ReadonlyArray<string>; // parallel to `faces`, e.g. "f-3.4"
} // edge id = "e:" + sorted vertex ids pair (derived, never stored)
```

Migration: none required. A v1 entity (`creases` only) is read as `edgeSharpness = creases × 10`. Writers keep `creases` in sync
for s ≥ 10 so older readers still see sharp edges. Persistence guard (`commands/persistence/guards.ts`) validates the new fields
(ranges, indices, parallel lengths).

### 3.2 Element identity (FR-DIR-20)

- Ids are minted by the step that creates the element: `v-<step>.<k>`, `f-<step>.<k>` (same scheme as entity ids, L8), so a replay
  re-mints identical ids. `add_subdivision_solid` mints ids for its initial cage lazily: absent `elementIds` ⇒ implicit ids
  `v-<creatingStep>.<index>`.
- Topology commands keep the ids of surviving elements, mint new ones for new elements and drop deleted ones. The vertex **array
  order** may change; ids never do.
- Every cage command accepts elements as ids (`"v-3.12"`) or indices (`12`); indices are resolved against the current cage and
  **recorded as ids** in the FeatureStep params at first execution (precedent: `faceNames` recorded by face ops, SC-N1). On replay
  ids are authoritative; a missing id refuses with `DIR_REF_LOST` (no nearest-element guess).
- Edges are addressed by their two vertex ids (`"e:v-1.2|v-1.7"`) or by index pairs; faces by id or index.

### 3.3 NURBS and B-rep

No model change for NURBS (poles / weights / knots already in `NurbsCurveData` / `NurbsSurfaceData`). B-rep: two new
`FaceOpParams` kinds:

```ts
// packages/core/src/model/faceOps.ts (additions)
| { readonly kind: 'moveFaces'; readonly faces: readonly number[];
    readonly move: { readonly type: 'translate'; readonly vector: Vec3 }
                 | { readonly type: 'rotate'; readonly axis: { origin: Vec3; direction: Vec3 }; readonly angle: number }  // radians
                 | { readonly type: 'offset'; readonly distance: number } }
| { readonly kind: 'deleteFaces'; readonly faces: readonly number[] }
```

### 3.4 UI-only state (never in the document)

```ts
// src/ui/store/directEditStore.ts
interface DirectEditState {
  mode: 'object' | 'vertex' | 'edge' | 'face' | 'pole';
  entityId: EntityId | null;
  picked: ReadonlyArray<string>; // element ids or pole keys "i" / "i,j" or B-rep face names
  hovered: string | null;
  soft: { enabled: boolean; radius: number; shape: FalloffShape; metric: 'euclidean' | 'topological' };
  session: DirectEditSession | null; // tool, gizmo frame, live value; cleared on commit / cancel
}
```

## 4. Commands

Notation: Q = query (`readOnly`, returns `data`), M = mutating (FeatureStep). K = `requiresKernel`. Element refs (`ElementRef`) =
id string or index. All lengths in document units; angles in degrees (`angleDeg`) at the API, radians inside recipes.

### 4.1 Core — `commands/subdivision/catalog.ts` (toolsets `3d`, `freeform`)

| Command                              | Q/M | K                           | Params (sketch)                                                                                                                                                                                                                                                                                                                                                                | @affects                                                          | @invariant                                                                                                                                          | @failure (code)                                                                       |
| ------------------------------------ | --- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `add_subdivision_solid` (exists)     | M   | –                           | today's + `edgeSharpness?`, `vertexSharpness?`, `creaseMethod?`, `boundary?`                                                                                                                                                                                                                                                                                                   | 1 subdivision                                                     | cage valid (closed unless `boundary`)                                                                                                               | as today + `DIR_SHARPNESS_RANGE`, `DIR_CAGE_OPEN`                                     |
| `edit_subdivision_cage` (exists, v2) | M   | –                           | `id`; selection: `vertexIndices?` (legacy), `vertices?: ElementRef[]`, `edges?`, `faces?`, `region?`; `translate?`, `rotate?: { axis: Vec3, angleDeg, pivot? }`, `scale?`, `pivot?`; `falloff?: number \| { radius, shape?, metric? }` (number = today's smoothstep radius); `symmetry?: 'keep' \| 'ignore'` (default keep when the entity has symmetry); `crease?`, `levels?` | modifies 1 entity (positions, legacy crease flags)                | topology unchanged; order scale → rotate → translate; symmetric cage stays symmetric (≤ 1e-12)                                                      | `DIR_REF_LOST`, `DIR_SELECTION_EMPTY`, `DIR_SCALE_NONPOSITIVE`, existing messages     |
| `set_cage_crease`                    | M   | –                           | `id`, `edges?` (ElementRef list, `{ loopFrom }` or `"all"`), `vertices?`, `sharpness` (0..10; 0 removes), `method?`                                                                                                                                                                                                                                                            | modifies 1 entity                                                 | sharpness stored exactly; mirrored edges too when symmetric                                                                                         | `DIR_SHARPNESS_RANGE`, `DIR_ELEMENT_KIND`                                             |
| `set_cage_symmetry`                  | M   | –                           | `id`, `planes: ('x'\|'y'\|'z')[]` (empty clears), `tolerance?` (default 1e-6 × cage size), `snap?: boolean` (move near-mirror vertices onto exact mirror positions)                                                                                                                                                                                                            | modifies 1 entity (`symmetry`, optionally positions)              | every paired vertex mirrors within tolerance                                                                                                        | `DIR_SYMMETRY_UNPAIRED` (lists vertices), `DIR_SYMMETRY_TOPOLOGY`                     |
| `extrude_cage_faces`                 | M   | –                           | `id`, `faces`, `distance`, `direction?` (default each region's average normal), `individual?`                                                                                                                                                                                                                                                                                  | +k vertices, faces replaced by side quads + caps                  | closed stays closed; new ids minted                                                                                                                 | `DIR_ELEMENT_KIND`, `DIR_DISTANCE_ZERO`                                               |
| `inset_cage_faces`                   | M   | –                           | `id`, `faces`, `thickness` (> 0), `depth?` (signed, + outward), `individual?`, `evenOffset?` (default true)                                                                                                                                                                                                                                                                    | +ring of quads                                                    | inner faces parallel-offset in their plane for planar faces                                                                                         | `DIR_INSET_TOO_THICK`                                                                 |
| `loop_cut_cage`                      | M   | –                           | `id`, `edge` (one edge crossing the face loop), `cuts?` (1..32, default 1), `factor?` (0..1, single cut), `preserveShape?` (SHOULD)                                                                                                                                                                                                                                            | +1 edge loop per cut                                              | loop follows quads; stops at n-gons / boundaries (reported)                                                                                         | `DIR_LOOP_NOT_QUAD`                                                                   |
| `bridge_cage_faces` (V1)             | M   | –                           | `id`, `facesA`, `facesB` (or `loopA`, `loopB` boundaries), `otherId?` (merge two entities), `twist?`, `segments?`                                                                                                                                                                                                                                                              | removes 2 regions, adds tube quads                                | equal boundary vertex counts; genus updated                                                                                                         | `DIR_BRIDGE_COUNT_MISMATCH`                                                           |
| `bevel_cage_edges` (V1)              | M   | –                           | `id`, `edges`, `width` (fraction 0..0.5 of adjacent edge), `segments?`, `sharp?`                                                                                                                                                                                                                                                                                               | edge → strip of faces                                             |                                                                                                                                                     | `DIR_BEVEL_TOO_WIDE`                                                                  |
| `delete_cage_faces` (V1)             | M   | –                           | `id`, `faces`, `boundary?` (sets `boundary`)                                                                                                                                                                                                                                                                                                                                   | removes faces / orphan vertices                                   | result is a valid open cage                                                                                                                         | `DIR_CAGE_EMPTY`                                                                      |
| `fill_cage_hole` (V1)                | M   | –                           | `id`, `edge` (on the boundary loop), `mode: 'ngon' \| 'quads'`                                                                                                                                                                                                                                                                                                                 | adds faces                                                        | closes the loop                                                                                                                                     | `DIR_NOT_BOUNDARY`                                                                    |
| `weld_cage_vertices` (V1)            | M   | –                           | `id`, `vertices`, `tolerance?` or `toCentre`                                                                                                                                                                                                                                                                                                                                   | merges vertices                                                   | stays manifold                                                                                                                                      | `DIR_WELD_NONMANIFOLD`                                                                |
| `slide_cage_edges` (V1)              | M   | –                           | `id`, `edges` (a loop), `factor` (−1..1 along the adjacent edges)                                                                                                                                                                                                                                                                                                              | moves vertices                                                    | topology unchanged                                                                                                                                  | `DIR_SLIDE_RANGE`                                                                     |
| `fit_cage_vertices` (COULD)          | M   | K for `pull` to a B-rep     | `id`, `vertices`, `to: { plane } \| { line } \| { bodyId }`                                                                                                                                                                                                                                                                                                                    | moves vertices                                                    |                                                                                                                                                     | `DIR_FIT_TARGET`                                                                      |
| `select_cage_elements`               | Q   | –                           | `id`, one of `nearest: Vec3`, `loopFrom: ElementRef` (edge loop / face loop), `ringFrom`, `region: {min,max}`, `within: { point, radius }`, `faces: { normal, within }` (normal cone, cos tolerance), plus `grow?: n`, `kind?`                                                                                                                                                 | —                                                                 | `data { vertices[], edges[], faces[] }` ids, ordered for loops                                                                                      | `DIR_REF_LOST`                                                                        |
| `evaluate_subdivision`               | Q   | –                           | `id`, `vertices?` (limit points), `samples?: {face, u, v}[]`, `curvature?`                                                                                                                                                                                                                                                                                                     | —                                                                 | `data.points[] { id, limit, normal, k1?, k2?, rule, valence }`, `data.extraordinary[]`                                                              | `DIR_EVAL_DEGENERATE` (flagged sample)                                                |
| `check_subdivision`                  | Q   | –                           | `id`, `tolerances?` (`symmetry`, `selfIntersectionSamples`, `meshVsLimitRel`)                                                                                                                                                                                                                                                                                                  | —                                                                 | `data { status, findings[], extraordinaryHistogram, creases, symmetry: {maxDeviation}, euler, genus, meshVolume, limitVolumeEstimate, provenance }` | —                                                                                     |
| `subdivision_to_nurbs` (V1)          | M   | K only for `output:"solid"` | `id`, `output: 'sheets' \| 'solid'`, `faces: 'unpacked' \| 'packed'`, `extraordinary: 'G0' \| 'G1'`, `keep?: boolean` (keep the SubD, default false), `samples?`                                                                                                                                                                                                               | sheets: n `nurbs_surface`; solid: 1 mesh entity with B-rep recipe | regular quads exact; `data { patchCount, maxDeviation, evEdges[] {g0, g1Deg}, starPoints[] }`                                                       | `DIR_CONVERT_NONMANIFOLD`, `DIR_CONVERT_DEGENERATE`, `CMD_KERNEL_UNAVAILABLE` (solid) |
| `face_to_subdivision` (COULD)        | M   | K                           | `id`, `faceIndex/faceName`, `density`                                                                                                                                                                                                                                                                                                                                          | 1 subdivision                                                     |                                                                                                                                                     | `DIR_FACE_NOT_SUPPORTED`                                                              |

### 4.2 Core — `commands/surface/`

| Command                      | Q/M | K   | Params (sketch)                                                                                                                                                                                                                                                                                     | @invariant                                                                                                            | @failure                                                      |
| ---------------------------- | --- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `edit_nurbs` (exists, + ops) | M   | –   | new operations: `move_poles` (`indices[]`, `delta`, `falloff? { radius (poles), shape }`), `drag_point` (`u`, `displacement`)                                                                                                                                                                       | `drag_point`: C(u) moves by exactly `displacement` (≤ 1e-12), least-norm pole change, poles with N_i(u) = 0 untouched | `SRF_NURBS_INVALID` (existing), `DIR_POINT_OUTSIDE_DOMAIN`    |
| `edit_nurbs_surface`         | M   | –   | `id`, `operation`: `move_poles` (`poles: [i,j][]` or `rows`/`cols`/`rect`, `delta`, `falloff? { radiusU, radiusV, shape }`), `set_weight` (`i, j, weight`), `drag_point` (`u, v, displacement`), `insert_knot` (`direction, u, times`), `elevate_degree` (`direction, by`), `reverse` / `transpose` | shape-preserving ops report shape change (≤ 1e-12); drag_point exact                                                  | `SRF_ENTITY_NOT_FOUND`, `SRF_NURBS_INVALID`, `DIR_POLE_RANGE` |

### 4.3 Core — `commands/brep/faceOps.ts` family (OCC)

| Command                                                 | Q/M | K   | Params                                                                                                                                                        | @invariant                                                                             | @failure                                                                                                                      |
| ------------------------------------------------------- | --- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `move_faces` (V1)                                       | M   | K   | `id`, `faceIndices? / facesNear? / faceNames?`, `mode: 'translate' \| 'rotate' \| 'offset'`, `vector?`, `axis? {origin, direction}`, `angleDeg?`, `distance?` | result is one valid closed solid (`BRepCheck_Analyzer`); picked faces recorded by name | `DIR_FACE_MOVE_FAILED` (with OCC reason), `DIR_FACE_MOVE_TOPOLOGY` (a face would vanish), `REF_LOST` / `REF_SPLIT` (existing) |
| `delete_faces` (V1)                                     | M   | K   | `id`, face pick                                                                                                                                               | one closed solid; volume reported                                                      | `DIR_DEFEATURE_FAILED`                                                                                                        |
| `push_pull_face`, `replace_face`, `draft_faces` (exist) | M   | K   | unchanged                                                                                                                                                     |                                                                                        |                                                                                                                               |

Descriptions follow AF-02 ("what, when, units, refusals, next command"), e.g. `extrude_cage_faces`: "Extrude faces of a subdivision
cage along their average normal (or `direction`) by `distance` in document units, creating side quads; the smooth surface grows a
handle or boss. Faces are ids from `select_cage_elements` or indices from `add_subdivision_solid` data. Refuses edges / vertices
(`DIR_ELEMENT_KIND`). Next: `edit_subdivision_cage` to shape the new faces, `check_subdivision`."

### 4.4 Toolset view

`packages/protocol/src/toolsets.ts`: add toolset `freeform` = the commands of §4.1–4.3 plus `add_subdivision_solid`,
`edit_subdivision_cage`, `edit_nurbs`, `inspect_nurbs`, `check_surface_quality`; keep them in `3d` too (toolsets are a view, L5).

## 5. Algorithms

### 5.1 Catmull-Clark with semi-sharp creases (core `lib/subd/refine.ts`)

Masks (OpenSubdiv `catmarkScheme.h` [R21], identical to today's code for s ∈ {0, ∞}):

| Point                                               | Rule                                                                                                                                                                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Face                                                | centroid of the face vertices                                                                                                                                                                                      |
| Edge, s = 0                                         | (v₀ + v₁ + f₀ + f₁)/4 (interior)                                                                                                                                                                                   |
| Edge, s ≥ 1                                         | (v₀ + v₁)/2                                                                                                                                                                                                        |
| Edge, 0 < s < 1                                     | s · sharp + (1 − s) · smooth                                                                                                                                                                                       |
| Vertex smooth / dart (0–1 sharp edges)              | ((n − 2)/n) v + (1/n²) Σ eᵢ + (1/n²) Σ fᵢ (eᵢ edge-neighbour vertices, fᵢ face points)                                                                                                                             |
| Vertex crease (2 sharp edges)                       | (6 v + a + b)/8                                                                                                                                                                                                    |
| Vertex corner (> 2 sharp edges or vertex sharpness) | v                                                                                                                                                                                                                  |
| Child sharpness (uniform)                           | s > 1 → s − 1; s ≤ 1 → 0; s ≥ 10 stays 10 [R21 crease.h]                                                                                                                                                           |
| Child sharpness (Chaikin)                           | ((0.75 s + 0.25 · mean of the other sharp edges at the vertex) − 1), single sharp edge → s − 1 [R21 crease.cpp]                                                                                                    |
| Rule transition                                     | if the parent rule ≠ child rule: blend parent-rule and child-rule positions with weight w = mean parent sharpness of the edges that become smooth, clamped to 1 [R21 crease.cpp `ComputeFractionalWeightAtVertex`] |
| Boundary (V1)                                       | boundary edges are infinitely sharp; `edge_and_corner` makes valence-2 boundary vertices corners, `edge_only` keeps them smooth crease points [R20]                                                                |

Reference implementation: `validation/ref_catmull_clark.mjs` (used to produce every expected value). Topology bookkeeping
(element ids, child-of map for previews) lives beside it. Cost: O(faces × 4^L); preview level cap §8.

### 5.2 Limit evaluation (core `lib/subd/limit.ts`)

- **At cage vertices** (any level ≥ 1, all quads): smooth limit `(n² v + 4 Σ eᵢ + Σ dᵢ)/(n(n + 5))` (eᵢ edge neighbours, dᵢ
  diagonal vertices of the incident quads); crease `(4 v + a + b)/6` (2/3, 1/6, 1/6); corner `v` [R21]. Tangents: smooth
  `t₁ = Σ 4 cos(iθ) eᵢ + Σ (cos iθ + cos (i+1)θ)/(4λ − 1) dᵢ`, `t₂` = same weights shifted by one, θ = 2π/n,
  λ = 5/16 + (cos θ + cos(θ/2) √(2(9 + cos θ)))/16 (subdominant eigenvalue; valence 4 uses the integer stencil); normal =
  t₁ × t₂ normalised; crease / corner tangent masks per [R21].
- **At (face, u, v)**: regular quads (all four corners valence 4, no sharp edge within one ring) → bicubic uniform B-spline of the
  4 × 4 neighbourhood (exact [R23]). Irregular quads: refine locally until the sample's sub-quad is regular or `depth = 8`, then
  evaluate the B-spline (residual ≤ λ^depth × ring size, reported); Stam's eigenbasis evaluation [R23] is the V2 exact path near
  EVs (needs the eigenstructure tables per valence; Stam computes them analytically because numerical solvers "do not always return
  the correct eigenstructure").
- **Curvature**: from B-spline derivatives of the evaluated patch; at an EV itself it is not defined ("the curvature at the
  extraordinary vertex is in fact infinite" in Stam's plotted case [R23]) → sample flagged `degenerate`.

Validation: λ(n) formula vs ring-contraction ratio measured on perturbed n-gon prisms, n = 3..12 (agree ≤ 0.15 %); cube corner,
face, edge limits exact rationals (VC-DIR-01..03).

### 5.3 Topology operations (core `lib/subd/topology/*.ts`, one file each)

| Op                               | Algorithm                                                                                                                                                                                                                                                                                      | Result check                                                                        |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Extrude (region)                 | Boundary edges of the face region (edges with one selected face) get new vertices offset by `distance × n̂` (region average of face normals, area-weighted) or `direction`; selected faces move to the new vertices; one side quad per boundary edge with winding from the old face orientation | Euler characteristic unchanged; creased unit cube extrude 1 → volume 12 (VC-DIR-19) |
| Extrude (individual)             | Same per face                                                                                                                                                                                                                                                                                  |                                                                                     |
| Inset                            | For each boundary vertex of the region: offset inward in the face plane along the angle bisector by `thickness / sin(half-angle)` (`evenOffset`) then along the normal by `depth`; ring quads between old and new loop                                                                         | creased cube, thickness 0.5, depth −0.5 → 8 − 7/6 (VC-DIR-20)                       |
| Loop cut                         | Walk the quad strip across the picked edge (opposite edge of each quad) until it closes or hits a non-quad / boundary; insert `cuts` vertices per crossed edge at `k/(cuts+1)` (or `factor`); split each quad; sharpness of crossed sharp edges is inherited by both halves                    | creased cube cut → volume 8, V 12, F 10 (VC-DIR-21)                                 |
| Preserve-shape loop cut (SHOULD) | After the cut, solve least squares for the new cage so its limit surface matches the old one at sample points (Fusion "Exact" behaviour [R2]); report the residual                                                                                                                             | residual reported                                                                   |
| Bridge                           | Remove the two face regions; match the two boundary loops (equal count) by rotation `twist` minimising Σ distance; insert `segments` intermediate loops (linear) and quads                                                                                                                     | genus +1 for one entity (VC-DIR-22)                                                 |
| Bevel edges                      | Split each picked edge into two parallel edges at `width` along the adjacent edges (vertex patches at ends), optional sharpness on the new edges                                                                                                                                               |                                                                                     |
| Delete / fill                    | Delete faces, drop orphan vertices, set `boundary`; fill: one n-gon on the loop or a quad patch (Coons-like grid)                                                                                                                                                                              | open-cage validity (`cageProblem` v2)                                               |
| Weld / slide                     | Merge vertices and rewire faces (refuse if non-manifold); slide along adjacent edges by `factor`                                                                                                                                                                                               |                                                                                     |

All ops keep element ids (§3.2), mirror themselves under symmetry (§5.5) and are pure.

### 5.4 Soft selection (core `lib/falloff.ts`)

Weight w(d) = 1 for selected elements; for others t = (R − d)/R clamped to [0, 1] and w = f(t) with f from Blender's
`calculatePropRatio` [R15]: constant 1, linear t, sharp t², root √t, sphere √(2t − t²), smooth min(1, 3t² − 2t³) (= today's
smoothstep), inverse_square t(2 − t); d ≥ R → 0. Distance metric: `euclidean` = distance to the nearest selected vertex (today);
`topological` = Dijkstra over cage edges with edge lengths (Blender "Connected Only" [R9]). NURBS: d = max(|Δi|/Rᵤ, |Δj|/Rᵥ) in pole
index space (Plasticity U / V falloff [R16]). The transform of a weighted vertex is the weighted interpolation used today (scale
factor 1 + (s − 1) w, translation w · Δ, rotation angle w · α about the pivot).

### 5.5 Symmetry (core `lib/subd/symmetry.ts`)

`set_cage_symmetry` pairs each vertex with its mirror within `tolerance` (k-d tree), lists unpaired vertices
(`DIR_SYMMETRY_UNPAIRED`) and checks that faces map to faces (`DIR_SYMMETRY_TOPOLOGY`), like Blender's position mirror [R14]
(topology mirror is a COULD). Every cage edit with `symmetry: 'keep'` applies the mirrored transform to `pairs[v]` (reflect the
delta / rotation axis / scale pivot) and projects `onPlane` vertices back onto the plane; topology ops apply to the mirrored element
set too (the union is processed once). `check_subdivision` reports `maxDeviation` = max over pairs of |p(v) − M p(pair(v))|.

### 5.6 NURBS point drag (core `lib/nurbs/pointDrag.ts`)

Minimise Σ |ΔPᵢ|² subject to Σ Nᵢ(u) ΔPᵢ = D (non-rational) → ΔPᵢ = Nᵢ(u) D / Σ Nⱼ(u)² (Lagrange multiplier). Surface:
ΔPᵢⱼ = Nᵢ(u) Mⱼ(v) D / Σ (Nₖ(u) Mₗ(v))². Rational: apply in homogeneous space with Rᵢ(u) = wᵢNᵢ/Σwⱼ Nⱼ replacing Nᵢ (exact for the
displacement because the weights are unchanged). Verified: residual 5.6e-16 (curve), 0 (surface), untouched poles = those with
Nᵢ(u) = 0 (`validation/data/point_drag_cases.json`).

### 5.7 B-rep face moves and deletion (native OCC sidecar, `cpp/face_ops.cxx`)

| Mode                                       | OCC path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Notes                                                                                                       |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `offset`                                   | `BRepOffset_MakeOffset` on the solid with offset 0 and `SetOffsetOnFace(face, d)` for each picked face, mode skin, `Intersection` on, join arc [R30]                                                                                                                                                                                                                                                                                                                                                                 | Bore radius change, wall thickening; refuse when a face collapses (`DIR_FACE_MOVE_TOPOLOGY`)                |
| `translate` along the face normal (planar) | today's `push_pull` path (prism + boolean)                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | keep for parity with `push_pull_face`                                                                       |
| `translate` / `rotate` (general)           | (1) copy the picked faces' surfaces and transform them; (2) `BRepAlgoAPI_Defeaturing` removes the picked faces so neighbours extend [R29]; (3) build a half-space tool bounded by the transformed surfaces (`BRepBuilderAPI_MakeFace` on the untrimmed transformed surface, then `BRepPrimAPI_MakeHalfSpace` with the outside reference point); (4) intersect / cut the defeatured solid with it (`BRepAlgoAPI_Common`); (5) `ShapeFix_Shape`, `BRepCheck_Analyzer`; naming: moved faces keep their persistent names | R&D (risk §10 FUNCTIONAL); ships behind an integration test per face type (plane, cylinder, cone, B-spline) |
| `delete_faces`                             | `BRepAlgoAPI_Defeaturing` (`SetShape`, `AddFacesToRemove`, `SetToFillHistory(true)`, `Build`, `IsDone`, `HasWarnings`) [R29]; same class already used by `llull-netgen` (`solver/crates/llull-netgen/cpp/shape.cxx`)                                                                                                                                                                                                                                                                                                 | Inputs must be solids (OCCT restriction [R29])                                                              |

### 5.8 SubD → NURBS (core `lib/subd/toNurbs.ts` + kernel sew)

- Refine once (all quads). **Unpacked**: one bicubic patch per quad. Regular quads: the uniform bicubic B-spline of its 4 × 4 ring
  converted to Bézier (exact limit [R23]). Quads touching an EV or a crease: today's `quadCagePatches` geometry patches (C0 along
  EV edges, Loop & Schaefer [R24]) = `extraordinary: 'G0'`; `'G1'` adjusts the EV-adjacent interior poles so neighbouring patches
  share tangent planes along EV edges (Peters-style G1 construction near EVs [R25]; the exact construction is a TBD of M4 with its
  own deviation report).
- **Packed**: merge maximal rectangular grids of regular patches into one B-spline surface per grid (knot insertion of C2 joints
  into one knot vector), like Rhino's face packs [R5].
- Output `sheets` → `nurbs_surface` entities (no kernel); `solid` → existing kernel leaf path (`subdivisionPayload` → OCC sew),
  `requiresKernel`.
- Report: `patchCount`, `maxDeviation` from the limit surface at `samples` per patch (§5.2), per EV edge G0 gap and G1 angle
  (core NURBS continuity math from `check_continuity`), `starPoints` (EV list, Fusion splits there [R4]).
- Kernel-dependent volume (FR-DIR-35): `mass_properties` on a subdivision entity reports `surfaceModel` =
  `level_mesh` (no kernel / Manifold: the `levels` mesh) or `limit_patches` (OCC: the patches above); `check_subdivision` gives both.

### 5.9 Interaction mechanics (UI)

| Piece             | Design                                                                                                                                                                                                                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overlay meshes    | Cage: `LineSegments` (edges) + `Points` (vertices) + a pick mesh (faces, fan-triangulated, invisible) built with `useMemo` from the entity; NURBS net: poles + hull lines; disposed on change (R9)                                                                                                                                                 |
| Picking           | three-mesh-bvh (`bvhSetup.ts` exists) raycast on the pick mesh → face; nearest vertex / edge in screen space within 8 px; loop / ring = the same pure functions as `select_cage_elements` (imported from core, no duplication)                                                                                                                     |
| Gizmo             | Reuse drei `TransformControls` on a proxy group placed at the selection pivot, oriented per FR-DIR-04; delta read in `useFrame` into a ref; React state only when the displayed value changes (as `TransformGizmo.tsx` does)                                                                                                                       |
| Session plan      | `direct/sessionPlan.ts` (pure): `(doc, session) → { preview: {name, params}, commit: {name, params} }` — one function per tool, unit tested like `featurePlan.ts`                                                                                                                                                                                  |
| Preview scheduler | Local commands: run on `requestAnimationFrame`, drop stale frames, `levels` override for display = min(entity levels, 2) when the cage has > 100 vertices (display only; the committed command is unchanged). Kernel commands: `remotePreview` POST `/preview`, debounce 120 ms, abort the previous request (AbortController), show the last ghost |
| Commit            | `controller.commit(name, params)` once; keyboard nudges commit one command per key press                                                                                                                                                                                                                                                           |
| Value entry       | `ValueBox` (exists) during the drag; Tab cycles fields (distance, angle, radius)                                                                                                                                                                                                                                                                   |
| Copy as CLI       | Status-bar action builds `llull <name> '<json params>'` from the committed call                                                                                                                                                                                                                                                                    |

## 6. Interop & persistence

| Item        | Format                                                                                                                                                                   | Notes                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| Document    | `SubdivisionEntity` v2 fields (§3.1)                                                                                                                                     | additive; persistence guard validates |
| STEP        | converted B-spline faces through `export_step_ap242`                                                                                                                     | SubD cages are not exported as cages  |
| OBJ (COULD) | export the cage as an OBJ quad mesh with crease data as comments, import back (07 MSH owns mesh import)                                                                  | interop with Blender / Rhino cages    |
| Code export | `export_code` (CadQuery / build123d) lowers subdivision through its patches today (`codegen/pythonSubdivision.ts`); new ops are recipe history, lowered after conversion | no CadQuery SubD                      |

## 7. CLI / UI surfaces and error codes

- **CLI**: no special case. `llull search cage` / `crease` / `symmetry` / `drag` find the commands; `llull describe` shows units;
  `llull run plan.json --validate` resolves element ids against the simulated cage (ids minted by earlier plan steps are known by
  their step-scoped form); `--dry-run` works for every mutating DIR command (AF-42); `render_view … overlay=cage|net` (FR-DIR-40).
- **Backend**: `POST /preview { name, params }` → `{ ok, summary, entities (meshes), replacedIds, error? }`, executed on a copy of the
  live document with the native kernel, never logged, never synced, cancellable; rate-limited to one in flight per client.
- **UI**: §5.9; mode switch Tab; tool shortcuts (Alt-drag extrude, I inset, Ctrl-R loop cut, Shift-E crease); the cage toolbar shows
  symmetry state and soft radius.

### 7.1 Stable error codes (AF-11)

| Code                                                 | Raised by                                         | When                                                                                                                                                                                                                                                                                                                   | Offending ids / path                           | Remediation                                                                         |
| ---------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------- |
| `DIR_REF_LOST`                                       | every cage command, `select_cage_elements`        | an element id no longer exists (deleted or merged by an earlier step)                                                                                                                                                                                                                                                  | `params.vertices[i]` / `faces[i]` / `edges[i]` | re-select with `select_cage_elements` (nearest / loopFrom) and edit the step params |
| `DIR_ELEMENT_KIND`                                   | cage commands                                     | an edge id given where faces are expected, etc.                                                                                                                                                                                                                                                                        | param path                                     | pass the element kind the command names                                             |
| `DIR_SELECTION_EMPTY`                                | `edit_subdivision_cage`                           | selection resolves to nothing                                                                                                                                                                                                                                                                                          | `params.region` / ids                          | widen the region or give ids                                                        |
| `DIR_SCALE_NONPOSITIVE`                              | `edit_subdivision_cage`                           | a scale factor ≤ 0                                                                                                                                                                                                                                                                                                     | `params.scale`                                 | use factors > 0; mirror with symmetry instead                                       |
| `DIR_SHARPNESS_RANGE`                                | `set_cage_crease`, `add_subdivision_solid`        | sharpness < 0 or > 10 or not finite                                                                                                                                                                                                                                                                                    | `params.sharpness`                             | 0 (smooth) .. 10 (infinitely sharp)                                                 |
| `DIR_CAGE_OPEN`                                      | `add_subdivision_solid`, topology ops             | a boundary edge on a cage without `boundary`                                                                                                                                                                                                                                                                           | edge vertices                                  | pass `boundary` or `fill_cage_hole`                                                 |
| `DIR_DISTANCE_ZERO`                                  | `extrude_cage_faces`                              | distance 0                                                                                                                                                                                                                                                                                                             | `params.distance`                              | give a non-zero distance                                                            |
| `DIR_INSET_TOO_THICK`                                | `inset_cage_faces`                                | inner loop would self-overlap                                                                                                                                                                                                                                                                                          | face ids, max thickness                        | reduce `thickness` below the reported limit                                         |
| `DIR_LOOP_NOT_QUAD`                                  | `loop_cut_cage`                                   | the strip meets a non-quad face before closing                                                                                                                                                                                                                                                                         | face id                                        | cut from another edge or split the n-gon first                                      |
| `DIR_BRIDGE_COUNT_MISMATCH`                          | `bridge_cage_faces`                               | boundary loops differ in vertex count                                                                                                                                                                                                                                                                                  | both counts                                    | select regions with equal boundary counts or loop-cut one side                      |
| `DIR_BEVEL_TOO_WIDE`                                 | `bevel_cage_edges`                                | width ≥ 0.5 of an adjacent edge                                                                                                                                                                                                                                                                                        | edge ids                                       | reduce `width`                                                                      |
| `DIR_NOT_BOUNDARY`                                   | `fill_cage_hole`                                  | edge is not on a boundary                                                                                                                                                                                                                                                                                              | edge id                                        | pick a boundary edge (`check_subdivision` lists loops)                              |
| `DIR_WELD_NONMANIFOLD`                               | `weld_cage_vertices`                              | merge would create a non-manifold edge                                                                                                                                                                                                                                                                                 | vertex ids                                     | weld fewer vertices                                                                 |
| `DIR_SLIDE_RANGE`                                    | `slide_cage_edges`                                | factor outside −1..1                                                                                                                                                                                                                                                                                                   | `params.factor`                                | stay within the adjacent edges                                                      |
| `DIR_CAGE_EMPTY`                                     | `delete_cage_faces`                               | all faces deleted                                                                                                                                                                                                                                                                                                      | —                                              | delete the entity instead                                                           |
| `DIR_SYMMETRY_UNPAIRED`                              | `set_cage_symmetry`                               | vertices with no mirror within tolerance                                                                                                                                                                                                                                                                               | vertex ids, distance                           | `snap: true` or raise `tolerance`                                                   |
| `DIR_SYMMETRY_TOPOLOGY`                              | `set_cage_symmetry`                               | mirrored faces are not faces of the cage                                                                                                                                                                                                                                                                               | face ids                                       | make the topology symmetric first                                                   |
| `DIR_POINT_OUTSIDE_DOMAIN`                           | `edit_nurbs`, `edit_nurbs_surface` (`drag_point`) | u / v outside the knot domain                                                                                                                                                                                                                                                                                          | `params.u` / `params.v`                        | use `inspect_nurbs` for the domain                                                  |
| `DIR_POLE_RANGE`                                     | `edit_nurbs_surface`                              | pole index outside the net                                                                                                                                                                                                                                                                                             | `params.poles[k]`                              | indices 0..nU−1 / 0..nV−1                                                           |
| `DIR_EVAL_DEGENERATE`                                | `evaluate_subdivision`                            | sample at an EV asked for curvature, zero-area face                                                                                                                                                                                                                                                                    | sample index                                   | read `limit` / `normal` only, or sample off the EV                                  |
| `DIR_CONVERT_NONMANIFOLD` / `DIR_CONVERT_DEGENERATE` | `subdivision_to_nurbs`                            | invalid cage / zero-area quads                                                                                                                                                                                                                                                                                         | element ids                                    | `check_subdivision`, fix, retry                                                     |
| `DIR_FACE_MOVE_FAILED`                               | `move_faces`                                      | OCC could not rebuild a closed solid                                                                                                                                                                                                                                                                                   | face indices, OCC status                       | smaller move, or move adjacent faces together                                       |
| `DIR_FACE_MOVE_TOPOLOGY`                             | `move_faces`                                      | a face would vanish / invert                                                                                                                                                                                                                                                                                           | face indices                                   | reduce the distance / angle                                                         |
| `DIR_DEFEATURE_FAILED`                               | `delete_faces`                                    | `BRepAlgoAPI_Defeaturing` not done                                                                                                                                                                                                                                                                                     | faces, warnings                                | delete the whole feature (all its faces) together                                   |
| `DIR_CHECK_*` findings                               | `check_subdivision`                               | `DIR_CHECK_SELF_INTERSECTION` (fail), `DIR_CHECK_SYMMETRY_DEVIATION` (warn), `DIR_CHECK_LEVEL_MESH_DEVIATION` (warn: level mesh vs limit volume > `meshVsLimitRel`, default 0.5 %), `DIR_CHECK_EXTRAORDINARY` (info: EV list), `DIR_CHECK_DEGENERATE_FACE` (fail), `DIR_CHECK_UNVERIFIED_SOURCE` (warn, imported cage) | ids, values, limit                             | per finding                                                                         |

Defaults used by checks are named in `data.tolerances` with `defaulted: true` and their source (AF-31): symmetry 1e-9 × size
(llull choice), `meshVsLimitRel` 0.5 % (llull choice).

### 7.2 Agent-first compliance

| AF                  | Where satisfied                                                       |
| ------------------- | --------------------------------------------------------------------- |
| AF-01, AF-02        | §4 commands with agent descriptions                                   |
| AF-03               | FR-DIR-43 guide section                                               |
| AF-04               | FR-DIR-38; `angleDeg`, lengths in document units, sharpness 0..10     |
| AF-05               | plans in `validation/plans/`, `--validate` resolves element ids       |
| AF-10, AF-12        | `data` shapes in §4; `evaluate_subdivision` bounded to 10 000 samples |
| AF-11               | §7.1                                                                  |
| AF-13               | FR-DIR-36, element ids step-scoped                                    |
| AF-20, AF-21        | `check_subdivision`, `evaluate_subdivision`, `select_cage_elements`   |
| AF-22               | `render_view overlay=cage`                                            |
| AF-23               | `expected_results.json` `cli` per VC                                  |
| AF-31, AF-32, AF-35 | named check defaults, `unverified` imported cages, `provenance`       |
| AF-33, AF-34        | not applicable (no safety / release decision)                         |
| AF-40, AF-41, AF-42 | kernel commands honour `--timeout`; all local; `--dry-run`            |

## 8. Performance & robustness budgets (desktop reference machine)

| Operation                                           | Budget                                                                                                                                                                          | Basis                                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Preview frame, cage ≤ 400 vertices, preview level 2 | ≤ 16 ms p95 (aim 10 ms) incl. ghost upload                                                                                                                                      | RAIL [R28]; reference CC level 2 on 386 vertices = 5.1 ms (`latency_probe.json`) |
| Preview frame, cage ≤ 100 vertices, full level 3    | ≤ 16 ms p95                                                                                                                                                                     | 98 vertices level 3 = 6.4 ms                                                     |
| Pick (hover)                                        | ≤ 2 ms on 50 k triangles                                                                                                                                                        | BVH                                                                              |
| Commit → screen, local                              | ≤ 100 ms                                                                                                                                                                        | RAIL response                                                                    |
| Commit → screen, backend (`--app`)                  | ≤ 300 ms                                                                                                                                                                        | local loopback + live event                                                      |
| Kernel preview (`move_faces`, `delete_faces`)       | first ghost ≤ 500 ms for a 200-face solid, then ≥ 5 Hz                                                                                                                          | OCC; TBD — measure with the bench                                                |
| `subdivision_to_nurbs` sheets, 400-vertex cage      | ≤ 300 ms                                                                                                                                                                        | core                                                                             |
| `check_subdivision` 2 000-vertex cage               | ≤ 1 s                                                                                                                                                                           |                                                                                  |
| Memory                                              | overlay buffers reused across frames; ghost geometry disposed                                                                                                                   | R9                                                                               |
| Robustness                                          | every refusal leaves the document unchanged with a code; drags that end on the start value commit nothing; NaN guard of `execute` (`CMD_CORRUPT_RESULT`) covers bad gizmo input |                                                                                  |

The bench (`tests/bench/directEdit.bench.ts`, vitest bench) measures llull's own core code on the reference cages and records p50 /
p95; budgets above are re-baselined from its first run (the probe numbers are a JS reference, grade C).

## 9. Test strategy

| Level           | Location                                                             | Content                                                                                                                                                                                    | VC                       |
| --------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| Unit (math)     | `tests/unit/subd/*.test.ts`                                          | refine vs `validation/data/*` (semi-sharp volumes, crease cube 8, cage edit vertices), limit masks, tangents, λ(n), regular B-spline equality, falloff table, symmetry pairing, point drag | 01–07, 10–13             |
| Unit (commands) | `tests/unit/subd/*`, `tests/unit/surface/editNurbsSurface.test.ts`   | happy + failure per command, `is pure`, element-id recording and `DIR_REF_LOST`, codes of §7.1                                                                                             | 19–22, 27, 30, 33–36, 40 |
| Contract        | `tests/unit/contract/`                                               | `toToolSchemas()` snapshot, units audit of descriptions, toolset `freeform`                                                                                                                | 32                       |
| Golden          | `tests/golden/plans.ts` + `validation/plans/target_*.json`           | id-normalised snapshots, replay equality, `edit_step_params` on an earlier topology step                                                                                                   | 16, 30                   |
| Integration     | `tests/integration/directEdit.test.ts`                               | `store.dispatch` of a gesture's commit, undo / redo deep equality, local and online modes                                                                                                  | 17                       |
| Component       | `tests/component/direct/*.test.tsx`                                  | a simulated drag (N pointer moves) dispatches exactly once with the expected params; Esc dispatches nothing; keyboard nudge = one dispatch; Copy as CLI text, net overlay counts           | 15, 37                   |
| Server          | `server/tests/occtFaceMoves.test.ts`, `server/tests/preview.test.ts` | `move_faces` offset / translate / rotate per surface type, `delete_faces`, `/preview` never mutates the live document                                                                      | 23–26                    |
| Bench           | `tests/bench/directEdit.bench.ts`                                    | preview frame time on the reference cages                                                                                                                                                  | 18                       |
| Desktop         | `desktop/tests/`                                                     | `--app` round trip: CLI edit appears in the app document; UI-dispatched command appears in `describe_scene`                                                                                | 16                       |

### 9.1 Technical requirements

| Id        | Requirement                                                                                                                                                          | Spec       | VCs                            |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------ |
| TR-DIR-01 | Core `lib/subd` CC refinement with OpenSubdiv semi-sharp rules (uniform, Chaikin), backward compatible with today's rules for s ∈ {0, ∞}                             | §5.1       | 04, 05, 07                     |
| TR-DIR-02 | Limit position / tangent masks and (face, u, v) evaluation, EV flagging                                                                                              | §5.2       | 01, 02, 03                     |
| TR-DIR-03 | SubdivisionEntity v2 fields, migration-free reading of v1, persistence guard                                                                                         | §3.1       | 07, 28                         |
| TR-DIR-04 | Persistent cage element ids, step-scoped, recorded at first pick, `DIR_REF_LOST`                                                                                     | §3.2       | 30                             |
| TR-DIR-05 | Topology ops (extrude, inset, loop cut; bridge, bevel, delete, fill, weld, slide) pure, id-preserving, symmetric                                                     | §5.3       | 19, 20, 21, 22, 33, 34, 35, 36 |
| TR-DIR-06 | Shared falloff library (7 curves, Euclidean / topological / index metric)                                                                                            | §5.4       | 06, 10                         |
| TR-DIR-07 | Symmetry pairing, mirrored edits and ops, deviation measure                                                                                                          | §5.5       | 11                             |
| TR-DIR-08 | `edit_nurbs` move_poles / drag_point and `edit_nurbs_surface`                                                                                                        | §4.2, §5.6 | 12, 13, 14                     |
| TR-DIR-09 | `move_faces` / `delete_faces` native paths (`BRepOffset_MakeOffset`, `BRepAlgoAPI_Defeaturing`, defeature + half-space rebuild), each with a server integration test | §5.7       | 23, 24, 25                     |
| TR-DIR-10 | `subdivision_to_nurbs` sheets (core) and solid (kernel), packed / unpacked, G0 / G1, deviation + EV report; `surfaceModel` in volume results                         | §5.8       | 08, 09, 29                     |
| TR-DIR-11 | Direct-edit UI: sub-element picking, overlays, session plan, rAF preview scheduler, single commit, cancel, value entry, Copy as CLI                                  | §5.9       | 15, 17, 26, 37                 |
| TR-DIR-12 | Backend `POST /preview` dry run with the native kernel, non-mutating, cancellable                                                                                    | §7         | 26                             |
| TR-DIR-13 | `select_cage_elements`, `evaluate_subdivision`, `check_subdivision` queries with bounded `data` and units                                                            | §4.1       | 28, 31, 40                     |
| TR-DIR-14 | Stable codes of §7.1 with paths and remediation; `--validate` resolves element ids                                                                                   | §7.1       | 27, 32                         |
| TR-DIR-15 | Determinism and performance budgets with a bench                                                                                                                     | §8         | 16, 18                         |

## 10. Delivery plan

| Milestone | Content                                                                                                                                                                                                                | Depends on        | Effort (eng-weeks) |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------ |
| M0        | Decisions D1–D4; `lib/falloff.ts`; `commands/subdivision/` catalog (move existing two commands, names unchanged); SubdivisionEntity v2 types + guard                                                                   | —                 | 1                  |
| M1        | UI foundation: sub-element picking (cage, poles, B-rep faces), overlays, `directEditStore`, session plan + rAF preview, gizmo adapter, Copy as CLI; drag handles for `push_pull_face` / `replace_face` / `draft_faces` | M0                | 4                  |
| M2        | `edit_subdivision_cage` v2 (rotate, edges / faces, ids, falloff shapes, topological metric), `set_cage_crease` (semi-sharp), `set_cage_symmetry`, `select_cage_elements`, `evaluate_subdivision`, `check_subdivision`  | M0                | 4                  |
| M3        | `extrude_cage_faces`, `inset_cage_faces`, `loop_cut_cage` + UI tools (Alt-drag, I, Ctrl-R)                                                                                                                             | M1, M2            | 3                  |
| M4        | NURBS: `edit_nurbs` ops, `edit_nurbs_surface`, net overlay drags; `subdivision_to_nurbs` (sheets, unpacked G0 first, then packed, G1)                                                                                  | M1                | 4                  |
| M5        | Open cages + `delete_cage_faces`, `fill_cage_hole`, `bridge_cage_faces`, `bevel_cage_edges`, `weld_cage_vertices`, `slide_cage_edges`                                                                                  | M3                | 4                  |
| M6        | OCC: `/preview`, `move_faces` (offset first, then translate / rotate R&D), `delete_faces`                                                                                                                              | M1, native kernel | 4                  |
| M7        | V2: radial symmetry, isolate, `fit_cage_vertices`, preserve-shape loop cut, Stam exact evaluation near EVs, reapply fillets (with 06 BLD), `face_to_subdivision`                                                       | M5, M6            | 5                  |

Total MVP (M0–M3) ≈ 12 eng-weeks; V1 (M4–M6) ≈ 12; V2 ≈ 5.

## 11. Open questions / decisions needed

| #   | Question                                                                                                                                                               | Recommendation                                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Element identity: step-scoped ids stored on the entity (§3.2) vs index-only with replay guards                                                                         | Ids (as proposed); indices accepted and recorded                                                                                         |
| D2  | Open cages in MVP or V1                                                                                                                                                | V1 (closed-cage tools first; most product shapes start from closed boxes)                                                                |
| D3  | Volume of a subdivision entity: should OCC also measure the `levels` mesh to stay consistent with the no-kernel path, or should the no-kernel path estimate the limit? | Keep both, report `surfaceModel`, default to the limit patches whenever a kernel is present (FR-DIR-35)                                  |
| D4  | OpenSubdiv in the native sidecar for exact evaluation (TOST 1.0 = Apache 2.0 + trademark clause [R22], redistributable) vs TypeScript core                             | TS core for MVP (renderer preview needs the same code); revisit OpenSubdiv in `solver/` when cages exceed 10 k vertices (C7 record here) |
| D5  | T-splines                                                                                                                                                              | Out of scope (patent expired 2024 [R27], SubD covers the use)                                                                            |
| D6  | History growth: one FeatureStep per drag                                                                                                                               | Accept; add `squash_steps` (merge consecutive edits of one entity into one step) as a COULD meta-command                                 |
| D7  | Symmetry as entity data vs an edit-time option                                                                                                                         | Entity data (persisted, checked) plus `symmetry: 'ignore'` per edit                                                                      |

## 12. References

See [FUNCTIONAL_SPEC.md §11](FUNCTIONAL_SPEC.md#11-references) ([R1]–[R30]); validation sources and grades in
[validation/sources.md](validation/sources.md).

## 13. As built (core part: M0, M2, M3 commands, DES-4, 2026-10-22)

Owner decisions applied: stable step-scoped element ids instead of indices (D1), one history step per drag (`squash_steps` not built), T-splines out of scope (D5), Catmull-Clark in the
TypeScript core (D4), and no compatibility with old documents: `SubdivisionEntity.elementIds` is **required** (a saved cage without it is refused on load). Not built here (UI agent / later
milestones): M1 (picking overlays, drag sessions, `directEditStore`), the M3 UI tools, M4 and beyond (`edit_nurbs` ops, `subdivision_to_nurbs`, `bridge_cage_faces`, bevel, delete, fill, weld, slide,
open cages, `move_faces`, `delete_faces`, `/preview`, bench), and the `freeform` toolset (every tool belongs to exactly one toolset, so the new commands are in `3d`).

- M0 data: `SubdivisionEntity` v2 (`model/types.ts`; helper types in `model/subdivisionCage.ts`): `edgeSharpness`, `vertexSharpness`, `creaseMethod`, `symmetry`, `elementIds`. `creases` stays the list of
  infinitely sharp edges; a semi-sharp edge (0 < s < 10) lives in `edgeSharpness`, never in both (`partitionSharpness`). Guard: `geometry/subd/validate.ts` (called from `commands/persistence/guards.ts`)
  plus `cageProblem` (semi-sharp edges must be cage edges, s in (0, 10]).
- M0 code: `lib/falloff.ts` (the 7 curves of Blender `calculatePropRatio`, `softWeight`, Dijkstra `graphDistances`; the deform pack keeps its own two-curve ramp); `commands/subdivision/` catalog (the two
  commands moved from `solids/`, names unchanged, `solids/subdivision*.ts` deleted); `surface_from_curves` mints element ids too.
- Subdivision math lives in `geometry/subd/` (not `lib/subd/`: `lib` may only depend on the vector types): `sharpness.ts` (OpenSubdiv rules: edge s >= 1 midpoint, 0 < s < 1 blend, vertex rule smooth / crease /
  corner, Uniform and Chaikin child sharpness, fractional rule blend with w = mean parent sharpness of the edges that become smooth); the refinement itself stays in `geometry/subdivision.ts`
  (`subdivideOnce`); `limit.ts` (vertex masks, Halstead tangent masks, 4 x 4 B-spline patches, local refinement to depth 4), `topology.ts`, `elements.ts` (ids, references, `DIR_REF_LOST` /
  `DIR_ELEMENT_KIND`), `symmetry.ts`, `regionOps.ts` (extrude / inset), `loops.ts` (rings, edge loops, loop cut), `volume.ts`, `pick.ts`.
- M2 commands: `edit_subdivision_cage` v2, `set_cage_crease`, `set_cage_symmetry`, `select_cage_elements`, `evaluate_subdivision`, `check_subdivision`. M3 commands: `extrude_cage_faces`,
  `inset_cage_faces`, `loop_cut_cage`.

### 13.1 Deviations from the spec text

- Element ids: minted eagerly at creation as `v-<step>.<index>` / `f-<step>.<index>` (the step key is shared by the commands of one `build_project`); new elements get `v-<step>.<n>` from the step's id source,
  skipping ids already in the entity. Index references are resolved and recorded as ids in the FeatureStep (`recordExtras`; `vertexIndices` is replaced by `vertices`). Edge id: `e:<idA>|<idB>` (sorted).
  Plans written with `f-1.2` assume the creating step is step 1 and that the element index equals the id suffix.
- `CageSymmetry` is `{ planes, partners, tolerance }`: `partners[k][v]` = mirror of `v` through `planes[k]` (itself on the plane); `pairs` / `onPlane` / `radial` / `isolated` are not stored. Edits are
  symmetrised generically: each mirror orbit follows its lowest-index driven vertex (reflected delta), on-plane vertices are projected back; `symmetry: 'ignore'` skips it. Topology commands process the
  mirror closure of the selection once and re-pair afterwards; a result that is not symmetric within the stored tolerance is refused (`DIR_SYMMETRY_BROKEN`).
- `edit_subdivision_cage`: selection by `vertexIndices` (kept), `vertices`, `edges`, `faces` or `region`; `falloff` is a radius or `{ radius, shape, metric }`; `rotate { axis (world), angleDeg, pivot? }`;
  order scale, rotate, translate. Distances and the default pivot are measured on world vertices rounded to 1e-6 (as before, so legacy edits are bit-identical).
- `select_cage_elements`: `nearest`, `loopFrom`, `ringFrom`, `region`, `within`, `faces { normal, within }` (`within` = 1 - cos of the cone), `grow`, `kind`; lists are capped at 5000.
- `evaluate_subdivision`: limits are returned in world coordinates rounded to 1e-12; samples `{ face, u, v }` need a quad face (otherwise flagged `degenerate` / `DIR_EVAL_DEGENERATE`); curvature is the
  principal k1 >= k2, positive when convex; at an extraordinary vertex the sample falls back to the vertex limit point (`approximate: true`, no derivatives).
- `check_subdivision`: the limit volume is the ratio-1/4 extrapolation of the two finest level meshes (<= 40 000 quads, level <= 5). Kernel-optional: with a kernel that has `faceQuery`, `data.limitPatches`
  reports the exact patch solid volume and the worst seam gap and tangent angle from `edgeContinuity` over the face-graph edges (tested with a scripted kernel; not run against the native sidecar). The
  self-intersection test runs on the finest level with <= 20 000 triangles.
- Extrude / inset: boundary vertices of each edge-connected region are duplicated, the region faces keep their ids and move; side quads are `[a, b, b', a']`. Sharpness of region-boundary edges is copied onto
  the new rim, interior edges follow their moved endpoints, corner sharpness is copied. Inset uses the even offset t (m1 + m2) / (1 + m1 . m2) (each new edge exactly `thickness` from its old edge on planar
  faces); a collapsing loop (an inset edge turning against its old direction) is refused, with the largest valid thickness found by bisection.
- Loop cut: `edge` crosses the loop; consecutive strip quads are `[s_j, t_j, t_(j+1), s_(j+1)]`; `factor` is measured from the first vertex of the picked pair; a strip that reaches an n-gon is `DIR_LOOP_NOT_QUAD`.
- Semi-sharp creases are exact in the level mesh, `check_subdivision`, `evaluate_subdivision` (vertex masks after `settleLevels`, samples by descent) and the exact patches / Python export, which refine
  `ceil(max finite sharpness)` steps (cap 3, `geometry/subd/settle.ts`) before applying the infinite-crease rules; a larger sharpness keeps a residual that is treated as smooth there. Review fixes: loop-cut
  records the edge in the caller's order; `symmetrize` follows the strongest-weighted image; an `ignore` edit that breaks the mirror clears `symmetry`; `check_subdivision` also reports
  `DIR_CHECK_SELF_INTERSECTION_PARTIAL`, `DIR_CHECK_LIMIT_VOLUME_UNAVAILABLE`, `DIR_CHECK_VOLUME_NON_FINITE`, `DIR_CHECK_PATCH_SEAM_GAP` / `_ANGLE`; `cageProblem` rejects duplicate / conflicting sharpness; codes
  `DIR_REGION_PINCH`, `DIR_LOOP_SELF_CROSS`. `previewCageCommand().triangles` are world space with the full placement; `pickCage` vertex / edge hits carry `t`.
- Codes added to section 7.1: `DIR_ENTITY_NOT_FOUND`, `DIR_SELECTION_CONFLICT`, `DIR_NOTHING_TO_DO`, `DIR_FALLOFF_INVALID`, `DIR_LEVELS_RANGE`, `DIR_CAGE_TOO_LARGE` (2000 vertices; 50 000 since 07 MSH M6), `DIR_DIRECTION_ZERO`,
  `DIR_REGION_DEGENERATE`, `DIR_LOOP_CUTS_RANGE`, `DIR_SYMMETRY_BROKEN`, `DIR_CAGE_INVALID`, `DIR_EVAL_BUDGET`, `DIR_SELECTOR_INVALID`. `DIR_INSET_TOO_THICK` also covers thickness <= 0.

### 13.2 Measured (VC results)

| VC           | Result                                                                                                                                                                              |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01           | lambda(n), n = 3..12, equals the table to 1e-11; valence-5 limit point within 3e-3 and normal within cos > 1 - 3e-3 of the level-6 mesh on an asymmetric bipyramid                    |
| 02 / 03      | corner (0.5, 0.5, 0.5) error 0, face centre (0, 0, 68/81) 4.9e-13, edge midpoint (0, 395/648, 395/648) 4.3e-13, corner normal 3.7e-13 (through `evaluate_subdivision`, 1e-12 rounding) |
| 04 / 05      | CLI `run baseline_subd_cage_today.json` (native kernel installed, mass from the display mesh): 2.6646247896794573, 8, 6.318191422352206, 6.878201798351067; 9/9 steps ok            |
| 06           | the 26 world vertices of `cage_edit_cases.json` within 1e-6; volume 6.31819142235 to 6.87820179835 (1e-9 rel)                                                                       |
| 07           | every edge at s = 1 / 2 / 0.5, level 4: 6.318191422352203 / 7.5641986705638535 / 4.233575762418375 (match the reference to 1e-9 rel)                                                 |
| 10           | 7 shapes x 21 samples equal `falloff_curves.json` to 1e-11                                                                                                                          |
| 11           | mirror vertex delta (-0.3, 0.2, 0.4), `check_subdivision` maxDeviation < 1e-12                                                                                                      |
| 19 / 20 / 21 | V 12 / E 20 / F 10 / Euler 2 each; creased volumes 12, 6.833333333333333, 8 (same through the CLI plan)                                                                             |
| 27           | codes `DIR_REF_LOST`, `DIR_SHARPNESS_RANGE`, `DIR_ELEMENT_KIND`, `DIR_LOOP_NOT_QUAD` raised with the expected paths                                                                 |
| 28           | histogram {3: 8}, Euler 2, genus 0, mesh volume 2.6646247896794573, limit estimate 2.6204138 (reference 2.62041911579, 5e-6), `DIR_CHECK_LEVEL_MESH_DEVIATION` warn                  |
| 30           | `edit_step_params` on the extrude distance keeps the later steps on the same ids; a missing id answers `DIR_REF_LOST` and leaves the history unchanged (deleting a face needs M5)   |
| 40           | 4 top faces of the seg [2,2,2] box by normal cone; the equator loop has 8 edges                                                                                                     |

Plans on the native CLI: `target_creased_cube_topology.json` steps 0-11 and 14-16 ok (`bridge_cage_faces` is M5); `target_grip_cage_tools.json` runs to the end except step 6: `set_cage_crease { loopFrom:
[0, 15] }` is refused with `DIR_REF_LOST` because the loop cut just split edge [0, 15] (use a vertex id from `data.newVertices`). Its extrude selects four of the eight top faces (`select_cage_elements`
returns all eight) and the mirror closure adds their images. Timing (386-vertex cage, level 3): edit 10 ms, extrude / inset 9-10 ms, loop cut 7 ms, evaluate all vertices 10 ms, `check_subdivision`
372 ms (1946-vertex cage: 364 ms at level 3).

### 13.3 For the UI agent

All commands are pure `execute(doc, name, params)` calls, so a drag preview is `previewCageCommand(doc, name, params, maxLevels)` (`commands/subdivision/preview.ts`): it never keeps the result, mints the ids
the commit will mint, and returns `{ ok, summary, error, entity, displayLevels, triangles }` (large cages are shown at <= 2 levels). Picking helpers in `geometry/subd/pick.ts`: `localRay` (world ray to
entity frame), `pickCage(entity, ray, tolerance)` (face under the ray, vertex / edge within the tolerance, with ids), `nearestCageElements(entity, point)`; loops and rings use `select_cage_elements`
(`loopFrom` / `ringFrom`) or `edgeLoop` / `walkRing` from `geometry/subd/loops.ts`. Send element ids in commit params (indices are accepted and recorded). `data` of every cage command carries `vertexIds` /
`faceIds` parallel to `vertices` / faces.

## 14. As built (core and native part of M4, M5, M6, DES-4b, 2026-10-24)

Scope: M4 (`edit_nurbs` `move_poles` / `drag_point`, `edit_nurbs_surface`, `subdivision_to_nurbs`), M5 (open cages, `delete_cage_faces`, `fill_cage_hole`, `bridge_cage_faces`,
`bevel_cage_edges`, `weld_cage_vertices`, `slide_cage_edges`), M6 (`POST /preview`, `move_faces`, `delete_faces`, `squash_steps`, toolset `freeform`). Not built: every UI piece (drag handles,
net overlays, loop-cut drag, pointer capture: the next agent), the bench of section 8, and the V2 items of M7 (radial symmetry, `fit_cage_vertices`, preserve-shape loop cut, Stam evaluation,
`face_to_subdivision`).

### 14.1 Decisions where the text left a choice

- **Open cages** (`SubdivisionEntity.boundary?: 'edge_and_corner' | 'edge_only'`, present only while the cage is open). A boundary edge (one face) is infinitely sharp; `edge_and_corner`
  (also the behaviour of any open cage that reaches `subdivide` without the field, e.g. the viewport) pins the boundary vertices of a single face, `edge_only` leaves them as crease points
  (limit (4v + a + b) / 6: 1/6, 1/6 at the corner of a unit square). Refinement (`subdivideOnce`), the limit masks (`prepare`), the Bézier patches and `cageProblem` handle it; `pinchedVertex` walks an
  open fan in both directions. An open cage has no volume (`mass_properties` answers "no solid volume", `check_subdivision` reports `open`, `boundaryLoops`, genus (2c - chi - b) / 2 and
  `meshVolume: null`). Every topology command that ends closed drops `boundary` again (`finishedCage`). Persisted data is checked on load (`geometry/subd/validate.ts`, `cageProblem` with `boundary`).
  The viewport mesh (`src/ui/.../solidMeshes.tsx`) does not pass `boundary`, which is fine for `edge_and_corner`; `edge_only` needs the field passed (UI agent).
- **Bevel** supports a set of edges that share no vertex (`DIR_BEVEL_ADJACENT` otherwise); both ends may have any valence (valence 3: the old vertex is replaced by the two strip ends; valence >= 4 or
  an open end: a patch polygon keeps it). `segments` lays straight intermediate loops (flat chamfer, not an arc); `sharp` is the sharpness of the two long strip edges. A bevel across a vertex chain
  (rim loops) is a later extension.
- **Bridge** takes side A / B as `facesA` / `facesB` (one edge-connected region with one boundary loop, removed) or `loopA` / `loopB` (an edge of a hole). The pairing rotation minimises the summed
  distance, B walked against A, `twist` shifts it; `otherId` merges a second cage (placed by its own transform; its element ids are renamed on a clash, its symmetry is dropped) and removes that entity.
- **Slide** takes `edges` (`{ loopFrom }` or a list: the loop through the first edge); positive `factor` moves to the LEFT of the first edge's direction seen from outside. Plane symmetry is kept by
  `symmetrize`. **Weld** merges into the lowest index (optionally the cluster centre), with `tolerance` clusters (single linkage) or one cluster. **Fill** `quads` adds a centre vertex (even loops).
- **`subdivision_to_nurbs`**: sheets from the once-refined cage (`quadCagePatches`: exact limit surface around regular vertices, Loop-Schaefer geometry patches next to extraordinary vertices and creases; seams
  are gap free, every patch of an extraordinary star already shares the exact limit tangent plane AT the vertex). `faces: "packed"` merges maximal rectangles of regular quads (`geometry/subd/packedGrids.ts`:
  greedy growth along i then j over the 4x4 rings, uniform cubic converted to a clamped NURBS by Boehm insertion at both ends). **`extraordinary: "G1"` is not Peters' construction**: the tangent
  break along the edges next to an extraordinary vertex shrinks by about 0.43 per refinement level, so G1 refines further until the measured break is below `tangentToleranceDeg` (default 0.5 degrees, at most
  4096 patches); the report says what was reached (`data.g1ToleranceMet`, and warning `DIR_CONVERT_G1_TOLERANCE_NOT_MET` in `data.warnings` and the summary when the 4096-patch budget ends first). `output: "solid"` is kernel-optional (refused without an exact kernel with face queries: `DIR_CONVERT_KERNEL`, and for an open cage: `DIR_CAGE_OPEN`) and always the G0 patches the native
  `subdivision` leaf sews (a request for G1 is reported as `extraordinary: "G0"`); `data.evEdges[] { patches, valence, g0, g1Deg }`, `maxEvG0`, `maxEvG1Deg`, `starPoints[]`, `maxDeviation` (same (u, v)
  distance to the limit surface at `samples x samples` cell centres per patch, default 2; samples the evaluator can only approximate are skipped and counted).
- **`mass_properties` `surfaceModel`** (decision: D3's "limit patches by default" is NOT taken). `level_mesh` stays the default, so a mass is the same with and without the native kernel (VC-04..06 hold
  on the CLI and in the app); `limit_patches` is opt-in and measures the exact patch solid: volume, centroid, inertia, `method: "exact"` and `surfaceModel` all come from that one solid (the entity is
  measured as its kernel result), and without an exact kernel the answer falls back to the level mesh and says `level_mesh`.
- **`move_faces` semantics.** `offset`: a plane moves along its outward normal (positive adds material); a cylinder, cone, sphere or torus face moves AWAY from its axis / centre, so +1 on a bore widens
  it (VC-23 asks for radius 3 -> 4) and +1 on a boss thickens it. It is `BRepOffset_MakeOffset` of the whole solid with a zero global offset, `SetOffsetOnFace` for each picked face and the INTERSECTION join (`GeomAbs_Intersection`),
  so drafted and obtuse neighbours, adjacent picked faces (two box faces +1 give 11 x 11 x 10, no notch) and a sphere work; OCC answers a shell that is made a solid and checked. (With the arc join, or
  with every other face pinned at 0, OCC threw or answered a null shape; the intersection join is the one that works.) `translate` / `rotate`: ONE planar face goes through push-pull (the normal component of the vector; an in-plane
  vector alone is refused) or, for rotation, `BRepOffsetAPI_DraftAngle` about the line where the old and the rotated plane meet (the draft sign is the one whose result has a face on the new plane; dihedral
  below about 86 degrees); any other pick is a FEATURE: `BRepAlgoAPI_Defeaturing` removes it, the volume removed / added (defeatured minus original, original minus defeatured) is moved rigidly by the
  motion and cut / fused back (a hole, a boss; pick all faces of the feature). The spec's half-space construction was not used: defeaturing a planar face of a box fails (parallel neighbours never meet).
  Names: surviving faces keep their persistent names, a moved feature keeps the names of its faces (the removed / added tool is transformed with its history, then cut / fused), so a later step can address the moved
  hole wall by name and the history replays (test `occtFaceMoves`).
- **`delete_faces`**: `BRepAlgoAPI_Defeaturing`; a picked face that OCC reports as not deleted is a refusal (it used to succeed silently with the box unchanged). Both commands report the exact
  `volumeBefore` / `volumeAfter` and record the picked face names. `DIR_FACE_MOVE_TOPOLOGY` is checked before the kernel call for a cylinder / sphere whose radius + distance <= 0; the OCC reason of
  `DIR_FACE_MOVE_FAILED` / `DIR_DEFEATURE_FAILED` was not carried over the kernel port (the answer was "refused"); carried since DES-4c (below).
- **`squash_steps { fromStepId, toStepId, label? }`** (metaHistory): the range becomes ONE `build_project` step (id of the first step) holding the same commands. It is accepted only when replaying the new
  history reproduces the current document exactly (entities, order, every definition: canonical JSON of the document without history), so replay equality and step-scoped ids are guaranteed by
  construction; a range that creates entities or cage elements (their ids come from the step number) is refused with the history unchanged, as is a suppressed step in the range, a failing replay or a
  kernel step without a kernel.
- **`POST /preview { name, params }`** (`server/src/previewRoutes.ts`, answer built by `@protocol/preview` `previewOf`): runs the command through `runCommandOutcome` on the live document value (commands are pure;
  nothing is written, logged, broadcast or audited) and answers `{ ok, summary, entities[] { id, kind, color, positions (unindexed world triangles, 1e-6), triangleCount, truncated }, replacedIds
  (consumed or changed live ids), data?, error? }`; more than 150 000 triangles in total are listed without geometry. The command runs synchronously on the one backend thread, so previews cannot overlap and
  the "one in flight per client" rule needs no code; the shared REST limiter bounds the rate. Cancellation is the client dropping the connection. It uses the mutation guard (same auth as `/command`).
- **Toolsets**: `freeform` is a real toolset (every tool stays in exactly one): the whole cage family, `edit_nurbs`, `edit_nurbs_surface`, `inspect_nurbs`, `check_surface_quality`, `move_faces`,
  `delete_faces` left `3d` for it; `3d` points to it (`TOOLSET_SEE_ALSO` is now a list). `squash_steps` is in `parametric`. The palette group label for `freeform` is the one line added under `src/ui`
  (`paletteItems.ts`: the exhaustive `Record<ToolsetName, string>` would not compile without it).
- New codes: `DIR_CAGE_EMPTY`, `DIR_NOT_BOUNDARY`, `DIR_FILL_ODD`, `DIR_WELD_NONMANIFOLD`, `DIR_SLIDE_RANGE`, `DIR_SLIDE_LOOP_INVALID`, `DIR_BEVEL_TOO_WIDE`, `DIR_BEVEL_WIDTH_RANGE`, `DIR_BEVEL_ADJACENT`,
  `DIR_BEVEL_BOUNDARY`, `DIR_BRIDGE_COUNT_MISMATCH`, `DIR_BRIDGE_REGION`, `DIR_BRIDGE_SAME`, `DIR_CONVERT_DEGENERATE`, `DIR_CONVERT_KERNEL`, `DIR_CONVERT_FAILED`, `DIR_POINT_OUTSIDE_DOMAIN`,
  `DIR_POLE_RANGE`, `DIR_OPERATION_PARAMS`, `DIR_TRIMS_BLOCK`, `DIR_FACE_MOVE_PARAMS`, `DIR_FACE_MOVE_FAILED`, `DIR_FACE_MOVE_TOPOLOGY`, `DIR_DEFEATURE_FAILED`.

### 14.2 Measured (VC results, tolerance in brackets)

| VC | Result |
| -- | ------ |
| 08 | regular 8 x 6 torus -> 192 bicubic patches: max deviation 1.8e-15 [1e-9], 3072 samples; packed: ONE B-spline surface for all 192 quads; a block equals the limit point of every lattice vertex to 1e-12 |
| 09 | cube: 24 unpacked patches [24]; EV seam gap 0 [0]; tangent break at the 8 valence-3 stars 2.616 deg; max deviation 5.87e-3 (2 x 2 samples; 6.24e-3 with 3 x 3) on a cage of edge 2; G1 with tolerance 2 / 1 / 0.5 / 0.25 deg gives 96 / 384 / 384 / 1536 patches, break 1.149 / 0.496 / 0.496 / 0.211 deg, deviation 2.3e-3 / 9.4e-4 / 9.4e-4 / 3.9e-4 |
| 12 | curve drag at u = 0.4 by (0, 1, 0): residual 3.3e-16 [1e-12]; poles 0, 5, 6 untouched; rational curve (weight 3 on pole 2): exact to 1e-12 |
| 13 | surface drag at (0.3, 0.6) by (0, 0, 1): residual 0 [1e-12]; rational patch exact to 1e-12 |
| 14 | `insert_knot` shape change 1.0e-15 [1e-12 expected 0]; `elevate_degree` is reported the same way; linear U / V falloff weight 0.5 at half the radius |
| 22 | 3 x 3 x 1 box, centre faces bridged: V 32 E 64 F 32 Euler 0 genus 1; creased volume 8 (1e-12) |
| 23 | plate with a bore, offset +1: 3717.256661 -> 3497.345175 [3497.34517543, rel 1e-6]; -1 narrows it to radius 2 (volume 4000 - 40 pi) |
| 24 | translate the top face +2: 1200 [1200]; rotate the +x face 10 deg about its bottom edge: 1088.16349 [1088.16349035, rel 1e-6]; -10 deg: 911.8365 |
| 25 | fillet r 1 deleted: 997.8539816 -> 1000 [rel 1e-6]; a bore wall deleted: 4000; a boss wall + top deleted: 4037.699 -> 4000 |
| 26 | `/preview`: the live document (JSON) is identical after the call, no stream frame, no undo entry; the committed `push_pull_face` handle is the UI part (open) |
| 29 | cube, native kernel: default (`level_mesh`) 2.6646247897 [2.66462478968, 1e-9 rel]; opt-in `limit_patches` 2.6176023467 (0.11 % below the extrapolated limit volume 2.62041: the geometry patches cut the 8 corners slightly) |
| 33 | slide the mid loop by 0.5: loop at z = +-0.5, creased volume 8 [1e-12]; non-manifold weld of opposite corners: `DIR_WELD_NONMANIFOLD` |
| 34 | bevel top-front edge, width 0.25: V 10 E 15 F 7, creased volume 7.75 [1e-12] |
| 35 | delete the top face: 1 boundary loop, Euler 1, no volume; fill n-gon: Euler 2, creased volume 8 [1e-12] |

Plans on the native CLI (`node server/bin/llull.cjs --doc <scratch> run validation/plans/<p>.json --continue`, run from the pack folder), all steps ok: `target_creased_cube_topology` 17/17,
`target_grip_cage_tools` 11/11, `target_nurbs_point_drag` 7/7, `target_subd_to_nurbs` 7/7 (a `limit_patches` mass step was added for VC-29), `target_brep_face_moves` 17/17.
`target_grip_cage_tools` step 6 uses `loopFrom [0, 1]` (the generator now says so). Timing: `subdivision_to_nurbs` sheets take 83 ms for a 218-vertex cage (2 x 2 samples; 336 ms at 3 x 3, the
evaluator refines deeply near extraordinary vertices) against the 300 ms budget for 400 vertices (a 602-vertex cage took 630 ms at 3 x 3 and was not re-measured at 2 x 2); `check_subdivision` on the
70-vertex grip cage took 5.6 s with the native kernel because it sewed the exact patch solid and measured every seam (budget 1 s). Decision: that exact seam check is opt-in (`exactSeams: true`; sewing the
~1500 patch faces and 8 continuity samples per seam is not cacheable below seconds), the default check stays on the cage and the level meshes. Re-measured through the CLI process (start-up included): default
0.81 s, `exactSeams: true` 6.3 s; the cost stays visible in the parameter description; the face moves on the 7-face plate take a few tens of ms each (the server
test of 7 cases runs in 0.6 s). Not benchmarked: the 200-face kernel preview, `tests/bench`.

### 14.3 Left

UI (next agent): drag handles for `push_pull_face` / `replace_face` / `draft_faces`, net overlays for poles (VC-37), loop-cut drag, pointer capture, the remote preview client (`/preview`, debounce, abort),
the `edge_only` boundary in the viewport mesh, palette entries for the new commands. Overall: the bench (VC-18), `fit_cage_vertices`, preserve-shape loop cut, Stam evaluation, `face_to_subdivision`,
a true G1 patch construction, a multi-edge bevel across a vertex chain, the OCC reason in `DIR_FACE_MOVE_FAILED`, a faster exact seam check, `move_faces` of closed spherical faces, `render_view overlay=cage|net`.

### DES-4c (2026-10-30): the OCC reason of a refused face move

`GeometryKernel.lastRefusal()` (optional) answers why the latest `evaluate` returned null, in the kernel's words; the native host records the sidecar's
error text of that call (`server/src/isolatedKernel.ts`), the scan guard of `execute` answers its own reason when it refused (01 DEF §16). The C++ face
moves (`cpp/face_moves.cxx`: offset, feature move) now throw with the OCC reason instead of returning a silent null (`BRepOffset_MakeOffset failed`, the
shell count, an invalid or empty result, the defeature or boolean step of a feature move); the refusal itself is unchanged (cached null, same codes).
`runFaceOp` puts the reason in the summary: `... (refused: NATIVE_OCC_FAILURE: BRepOffset_MakeOffset failed: the moved faces do not meet their
neighbours)`. Tests: `tests/unit/faceMoves.test.ts` (a stub reason reaches the summary), `tests/unit/brep/kernelMeshGuard.test.ts` (the guard's own
reason, then the kernel's), `server/tests/faceMoveReason.test.ts` (native: an offset through a 10 mm box).

#### DES-4c (2026-10-30): tangent-plane fit for `extraordinary: "G1"` (`geometry/subd/g1Fit.ts`)

What "true G1" was blocked on: an exactly G1 patch set around a valence-n vertex with ONE bicubic patch per quad does not exist for n != 4 (the vertex
enclosure problem); Peters (2000) needs about 3n patches per star, which would change the patch count and the packed/solid contracts. This step does not
claim exactness. Decision: keep one bicubic patch per quad and fit the free poles.

- Only the four interior poles (1,1), (2,1), (1,2), (2,2) of each quad that touches an extraordinary vertex move; boundary poles are shared with the
  neighbours and never move, so G0 stays exactly 0 (tested bit-identical). Quads of one connected star group are one Levenberg-Marquardt problem: residual =
  difference of the unit normals of the two patches of every seam at seven stations (analytic derivatives, central-difference Jacobian per quad, sparse J^T J),
  plus a pull (weight 0.1 of the document extent) towards the geometry patch so the surface stays near the limit. 20 iterations at most, fixed order: deterministic.
- `extraordinary: "G1"` (sheets) fits first, then keeps the old behaviour: refines until `tangentToleranceDeg` is met or 4096 patches. `fitTangents` is the option of
  `cageToNurbs`; `output: "solid"` is unchanged (G0).
- Measured (max normal angle along EV edges, before -> after, same patch count): cube corner stars (24 patches) 2.616 -> 0.050 deg; box 2x2x2 (96) 2.616 -> 0.019;
  box 3x2x1 (88) 2.616 -> 0.042; max deviation from the limit surface 6.2e-3 -> 5.7e-3, 3.1e-3 (3x2x1) -> 2.9e-3. With weight 1e-3 the break reaches 1e-4 deg but the
  deviation grows to 1.95e-2 (3x): the weight 0.1 is the chosen trade. Cost 0.2 - 0.5 s for these cages. Default tolerance 0.5 deg is now met without refining.
- Still not exact: residual break is above 0; skewed cage and valence-5 star are tested to a looser bound (break < 0.2 deg / a tenth of the plain value).
- Tests: `tests/unit/subd/g1Fit.test.ts` (boundary poles bit-identical, regular quads untouched, pure, cube/box/skewed/valence-5 numbers), `toNurbs.test.ts`.
  Red-proof: fit disabled -> 6 tests fail.
- Left: Peters-style exact G1 (needs 3n patches per star), STEP of the fitted sheets needs no change (poles only).
