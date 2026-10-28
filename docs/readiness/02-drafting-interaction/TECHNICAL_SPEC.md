# UXD — Interaction depth for daily drafting and modelling — Technical specification

Gap id: **UXD** · Companion: [FUNCTIONAL_SPEC.md](FUNCTIONAL_SPEC.md) · Validation: [validation/README.md](validation/README.md) ·
Read on origin/main f1351cff, 2026-10-28. Paths are relative to the repo root.

---

## 1. Current state in llull

### 1.1 Interaction code audit

| Area | What exists (file) | Limit against the baseline |
| ---- | ------------------ | -------------------------- |
| Command search | `src/ui/components/commandPalette/{CommandPalette,paletteItems,fuzzyMatch,paramForm,CommandParamForm}.tsx/ts`: Ctrl+K, fuzzy match over app actions + **every** registry command grouped by toolset, generated forms from the tool JSON schema (fields `number`, `numberList`, `textList`, `json`…), previews for numeric fields; `store/paletteStore.ts` keeps 5 persisted recents | modal dialog, not a command line; no aliases, no prompt sequence, no keyword options, no repeat-last, no defaults; points typed as JSON / number lists |
| Keyboard | `src/ui/hooks/shortcuts.ts` (one table: L P W C . draw; R S M V in 2D; G/M R S gizmo in 3D; O F K T X E modify; 2 / 3 views), `useKeyboardShortcuts.ts` (Ctrl Z / Y / Shift Z / D / B, Del, Esc, H / Shift H / Alt H, N, ?, arrows nudge 1, Shift ×10), `useToolKeys.ts`, `ShortcutsDialog.tsx` renders `SHORTCUT_GROUPS` | fixed table (~30 bindings), not customisable, no chords beyond Ctrl, **no F-keys** (grep of `src/ui`: none), no per-context maps |
| 2D draw | `viewport/2d/{drawToolTable,useDrawTool,DrawInteraction,DrawPreview}.ts(x)`: line (2 clicks, ends), polyline / spline / wall (Enter or double-click finishes), rectangle, circle (dispatches `draw_arc`), ellipse, point, move (base → destination); Ctrl+Z mid-tool drops the last point; rubber band per descriptor | header: "Params come from clicks only"; **no typed coordinates / lengths / angles**; no arc tool, no dimension tool; line does not chain; move requires a preselection |
| 2D modify | `viewport/2d/{useModifyTool,ModifyTools,modifyHelpers}.ts(x)`: offset (pick = side, then value), fillet / chamfer (polyline + vertex + value), trim / extend (target, then boundary), explode | trim needs a boundary pick per object; no stretch / break / join / lengthen / copy-multiple / rotate-reference / scale-reference / mirror-by-line flows |
| 2D snaps | `viewport/2d/snapping/{types,candidates,resolveSnap,sharedCandidates,geometry,curveIntersections,segmentSweep}.ts`, `useSnap.ts`, `SnapIndicator.tsx`: endpoint, midpoint, center, intersection (global segment sweep + curve pairs), perpendicular, tangent, extension, nearest, grid; priority table; aperture 12 px constant; candidates cached per document | all modes always on (extension / nearest always off, `useSnap.ts` passes no cursor), **grid snap always on** (`snap()` returns a grid point whenever `gridSize > 0`, and `adaptiveGridStep` is > 0 at every zoom) so no free point; no quadrant, node, insertion, geometric centre, apparent intersection, parallel; no override, tooltip, Tab cycling; no tracking; ortho = held Shift; **polar implemented in `applyOrthoPolar` but unreachable** (`useSnap.ts` uses `ORTHO_ONLY`); full candidate list per document, linear scan per pointer move |
| 3D snaps | `viewport/3d/snap3d.ts`: rotated-AABB corners, edge midpoints, face centres; cylinder disc / rim points; sphere poles; grid | not the solid's real vertices / edges; nothing for B-rep or mesh topology |
| Selection | `viewport/selectClick.ts` (Shift / Ctrl / Meta toggle), `viewport/2d/{SelectPickInteraction,BoxSelectInteraction,boxSelect}.ts(x)` (click: nearest outline else smallest enclosing closed shape; Shift+drag window / crossing by direction, Liang-Barsky), `store/store.ts` dispatches `set_selection {ids, mode}` | 3D: whole-entity click only (sub-elements only in cage / face-edit / NURBS-net modes); no 3D box; no click-click box; no cycling; no Ctrl+A / previous / invert; no select-similar |
| Grips / manipulators | `viewport/3d/TransformGizmo.tsx` + `gizmoCommit.ts` (one command per drag), `manipulators/{FeatureHandle,ValueBox,…}` (extrude / fillet / shell handles with typed value), `cage/*`, `faceEdit/*`, `nurbsNet/*` (pack 04) | **no grips on 2D entities**; no grip command; gizmo has no typed value, pivot fixed |
| Properties / layers | `panels/PropertiesPanel.tsx` (name → `set_entity_name`, position → `move_entities`, rotation → `rotate_entity`), `entityDimensions.tsx` (read-only sizes), `panels/LayersPanel.tsx` (`update_layer` lock / rename, `delete_layer`) | multi-selection shows "N entities selected" only; sizes not editable; no quick properties; no match properties; no current layer; no layer states |
| Feedback | `components/HintBar.tsx` + `hintText.ts` (one line, `role=status`), `StatusBar.tsx` (live state, summary, counts, `units (Ndp)`), `src/ui/preview/*` (pure dry run, debounced 120 ms, `docs/UI.md`) | no prompt line with options / defaults; **no cursor coordinate readout** |
| Navigation | `viewport/3d/Viewport3D.tsx` (drei `OrbitControls` with damping; `GizmoHelper` + `GizmoViewport` axis triad), `ViewPresets.tsx` (Front / Top / Right / Iso, fit all / selection), `NamedViews.tsx`; 2D `cameraControlsPolicy.ts` (MapControls, zoom to cursor, **left-drag pan disabled while a tool is armed**) | one mapping; no view cube with edges / corners; no previous view; no orbit about a picked point; no pan while drawing |
| 3D mouse | `src/ui/input/{useSpaceMouse,spaceMouseDevice,spaceMouseReports,spaceMouseMapping,spaceMouseCamera,SpaceMouseControl}.ts(x)`, `desktop/src/hid.ts`: WebHID, axis mapping + settings in `localStorage` | buttons parsed, unused; no centre-of-rotation display; not verified on hardware (`docs/UI.md`); not the 3Dconnexion navlib |
| Numbers | `components/NumberField.tsx` (`type=number`, keeps partial text, `parseNumber`) | no expressions, units or parameter references |
| Registry facts | core commands: 328 names (grep of `name: '…'` in `packages/core/src/commands`); `set_selection {ids, mode}`; `move_entities {ids, delta}`, `duplicate_entities {ids}`; `rotate_entity {id, delta, pivot}`, `scale_entity {id, factor}`, `mirror_entity {id, axis}`, `set_entity_layer {entityId, layerId}` (single entity); `draw_arc {center, radius, startAngle?, endAngle?}`; `add_dimension {dimensionKind, entityIds, offset…}`; `add_constraint`, `solve_constraints`; `edit_step_params`, `reorder_step`, `set_step_suppressed` | no `match_properties`, layer-state, current-layer, grip, stretch / break / join / lengthen, multi-entity rotate / scale / mirror / copy-with-displacement, rollback or select-similar command |

### 1.2 Measured facts that shape the design

- The task fixture (`validation/plans/task_fixture.json`, 25 steps) validates and runs on main (sources M1).
- KLM over the 15 tasks (`validation/data/klm_predictions.json`, M3): today's methods exist for T04 T05 T06 T07 T08 T12 T14 T15
  and sum to 73.46 s against 75.58 s for the incumbent methods on the same tasks; the trim flow is the only slower one
  (16.48 s vs 9.82 s: a boundary pick per object). The other 7 tasks have no UI method to spec precision.
- Snap query time, rubber-band frame time, commit-to-paint: not measured (VC-UXD-45, -47, -48 baselines: TBD — measure).

## 2. Target architecture

### 2.1 Layer placement (architecture L2)

| Piece | Layer | Path (new unless noted) | Why there |
| ----- | ----- | ----------------------- | --------- |
| Coordinate / value grammar | core `lib` (pure leaf) | `packages/core/src/lib/coordinateInput.ts`, `lib/valueExpression.ts` | pure, shared by UI fields and (later) CLI string params; testable in the node project |
| Grip model (`gripsOf(entity)`, grip ops) | core `geometry` | `packages/core/src/geometry/grips/{index,polyline,arc,rectangle,ellipse,text,dimension}.ts` | used by `list_grips` / `edit_grip` (commands) and by the UI renderer of grips: one definition |
| New commands | core feature catalogs | `commands/edit/` (`edit_grip`, `copy_entities`, `rotate_entities`, `scale_entities`, `mirror_entities`, `match_properties`), `commands/modify2d/` (`stretch_2d`, `break_2d`, `join_2d`, `lengthen_2d`), `commands/document/` (`set_current_layer`, layer states, `select_similar`, `select_by_filter`), `commands/history/` (`set_rollback`), `commands/inspect/` (`list_grips`) | document changes are commands (L1, L4); grouped by feature catalogs |
| Prompt metadata | core `commands/schema` (additive annotation) | `annotations.prompts` on `defineCommand` | the command line is derived from the registry (L5), never hand-written per command in the UI |
| Tool session, command line, dynamic input, prompt line | UI | `src/ui/interaction/{toolSession,promptDriver,commandLine,dynamicInput,promptLine}.ts(x)` | presentation + param gathering (R1) |
| Snap / track engine | UI, pure modules (no React) | `src/ui/snap/{index,modes,engine,tracking,snap3d}.ts` (replaces `viewport/2d/snapping/*`, `viewport/3d/snap3d.ts`, `nearestSnap.ts`) | runs per pointer move on the renderer's scene; see C7 note below |
| Grip rendering + hot-grip session | UI | `src/ui/viewport/2d/grips/*` | presentation; commits `edit_grip` |
| Keymap, aliases, preferences | UI + desktop | `src/ui/keymap/*`, `src/ui/store/interactionPrefs.ts`; persisted by `desktop/` to `<userData>/llull/interaction.json` (IPC), `localStorage` fallback in dev | user preference, not document (L4, L8) |
| View cube, navigation presets | UI | `src/ui/viewport/3d/ViewCube.tsx`, `src/ui/viewport/navigationPresets.ts` | camera only (camera bridge) |
| 3D mouse native | desktop main + native addon | `desktop/src/navlib/*` (Node-API addon over the 3Dconnexion Navigation Library, C++) → IPC → renderer camera bridge | the SDK is a native C++ library [R23]; Rust is not a fit for a vendor C++ SDK binding (C7: best-suited) |
| UX trace | UI + desktop | `src/ui/trace/uxTrace.ts`, file sink in `desktop/` when `LLULL_UX_TRACE` is set | observability for pack 06 / 03 |

C7 note (stack choice): the snap engine stays TypeScript in the renderer. Its inputs (scene geometry, camera) live there and a query
must return inside one frame; a sidecar round trip per pointer move adds IPC latency to a 2 ms budget. If VC-UXD-45 fails with
the TS index, the fallback is the same algorithm in Rust compiled to WASM inside the renderer (no IPC), decided by the bench.

### 2.2 Data flow of one prompted command (TR-UXD-01)

```
key / pick / typed text
  -> ToolSession (UI state machine; one per armed command)
       prompt k of N  (from annotations.prompts, or derived from the zod schema)
       input sources: snapped pick (snap engine) | coordinate grammar | dynamic-input field | keyword | Enter = default
       -> params draft  -> preview (pure dry run, src/ui/preview) -> rubber band / ghost
  -> last prompt answered: store.dispatch(name, params)   <- the ONLY write
  -> command log entry -> history pane, "copy as CLI / plan", repeat buffer
```

Draw tools, modify tools, grip drags, the command line and click flows all use the same `ToolSession`; `drawToolTable.ts` and
`useModifyTool.ts` become session descriptors (no behaviour lost: their existing flows are the default prompt orders).

### 2.3 Laws check

| Law | How this pack keeps it |
| --- | ---------------------- |
| L1 one command layer | every gesture ends in `dispatch`; grips and match / layer states are new commands, callable from the CLI |
| L2 dependency direction | grammar and grips in core (no DOM); engine and sessions in `src/ui`; navlib in `desktop/` |
| L3 purity | new commands return new documents; `is pure` tests (VC-UXD-26, -29, -33) |
| L4 single source of truth | preferences are not document data; no component builds an entity (grips call `edit_grip`) |
| L5 registry is the contract | command line, aliases, keymap targets and prompts derive from `listCommands()` + schema annotations |
| L6 thin backend | no server change beyond forwarding the new commands |
| L8 parametric | every committed gesture is one `FeatureStep`; `set_rollback` is a history meta-command (marker in document data) |
| L9 kernel | 3D true-geometry snaps read tessellation / topology already in the renderer; no new kernel call per pointer move |

## 3. Data model

### 3.1 Document (additive; no migration needed — absent fields mean "none")

```ts
interface CadDocument {
  // …existing
  currentLayerId?: LayerId;                                   // set_current_layer; draw_* default layer
  layerStates?: Record<string, LayerState>;                   // keyed by name
  rollbackStepId?: FeatureStepId | null;                      // set_rollback; null / absent = at end
}
interface LayerState {
  name: string;
  layers: Record<LayerId, Partial<Pick<Layer, 'visible' | 'locked' | 'color'>>>;
}
```

### 3.2 Grips (core `geometry/grips`)

```ts
type GripKind = 'end' | 'mid' | 'vertex' | 'center' | 'quadrant' | 'insertion' | 'dimension-point' | 'segment-mid';
type GripOp = 'move' | 'stretch' | 'lengthen' | 'add_vertex' | 'remove_vertex' | 'to_arc' | 'radius';
interface Grip { gripId: string; kind: GripKind; position: Vec3; ops: readonly GripOp[] } // gripId e.g. "vertex:2", "quadrant:0"
function gripsOf(entity: Entity): readonly Grip[];            // pure; one branch per 2D kind (OCP: new kind = new branch)
function applyGrip(entity: Entity, gripId: string, op: GripOp, target: Vec3): Entity | GripFailure;
```

### 3.3 UI-only state (never in the document, never in undo)

`<userData>/llull/interaction.json` (schema-versioned, zod-validated on read; invalid → defaults + a status-bar notice):

```ts
interface InteractionPrefs {
  version: 1;
  snaps: { on: boolean; modes: Record<SnapMode, boolean>; aperturePx: number; tracking: boolean; gridSnap: boolean;
           ortho: boolean; polar: { on: boolean; incrementDeg: number; extraAnglesDeg: number[] } };
  dynamicInput: { on: boolean; pointerFields: boolean; dimensionFields: boolean };
  keymap: { preset: 'llull' | 'autocad-like' | 'solidworks-like'; overrides: KeyBinding[] };
  aliases: { preset: 'llull' | 'autocad-like'; userFile?: string };      // path of the user .pgp-syntax file
  navigation: { preset: 'llull' | 'solidworks-like' | 'fusion-like' | 'autocad-like'; zoomToCursor: boolean };
  quickProperties: 'off' | 'all' | 'configured';
  spaceMouse: { backend: 'navlib' | 'webhid' | 'off'; /* existing tuning fields */ };
}
interface KeyBinding { chord: string; context: 'global' | '2d' | '3d' | 'sketch' | 'prompt'; action: { kind: 'command'; name: string } | { kind: 'ui'; id: string } }
```

The existing `localStorage` keys (`llull-spacemouse`, palette recents) move into this file; no compatibility shim is kept (owner
rule: no backward compatibility).

## 4. Commands

All pure, `snake_case`, registered in their feature catalog, happy + failure unit tests, `@affects @invariant @failure` tags.
Toolset in brackets.

| Command | Params (zod sketch) | Kind | Failure codes |
| ------- | ------------------- | ---- | ------------- |
| `list_grips` [2d] | `{ id }` | query → `data.grips: Grip[]` | `UXD_GRIP_KIND_UNSUPPORTED` |
| `edit_grip` [2d] | `{ id, grip: string, op: GripOp, to?: vec3, value?: number }` | mutating, 1 entity | `UXD_GRIP_UNKNOWN`, `UXD_GRIP_OP_UNSUPPORTED`, `UXD_GRIP_DEGENERATE` (e.g. removing a vertex of a 2-point polyline) |
| `copy_entities` [core] | `{ ids, displacements: vec3[] (1..1000) }` | mutating; one copy set per displacement | `UXD_NO_SELECTION` |
| `rotate_entities` [core] | `{ ids, pivot: vec3, angle: number (rad), axis?: vec3 }` | mutating | `UXD_NO_SELECTION` |
| `scale_entities` [core] | `{ ids, base: vec3, factor: number > 0 }` | mutating | `UXD_NO_SELECTION`, `UXD_SCALE_FACTOR` |
| `mirror_entities` [core] | `{ ids, line: [vec2, vec2], keepSource: boolean }` | mutating | `UXD_NO_SELECTION`, `UXD_MIRROR_LINE_DEGENERATE` |
| `stretch_2d` [2d] | `{ window: [vec2, vec2], ids?, delta: vec2 }` — vertices inside the crossing window move, whole entities inside move | mutating | `UXD_STRETCH_NOTHING_INSIDE` |
| `break_2d` [2d] | `{ id, at: vec2, to?: vec2 }` — split at a point or remove the part between two points | mutating | `UXD_BREAK_POINT_OFF_ENTITY` |
| `join_2d` [2d] | `{ ids, tolerance?: number }` — collinear lines → line; touching chains → polyline; co-circular arcs → arc | mutating | `UXD_JOIN_NOT_CONNECTED` |
| `lengthen_2d` [2d] | `{ id, end: 'start' \| 'end', mode: 'delta' \| 'total' \| 'percent', value }` (lines, arcs, open polylines) | mutating | `UXD_LENGTHEN_KIND`, `UXD_LENGTHEN_NONPOSITIVE` |
| `match_properties` [core] | `{ sourceId, targetIds, properties: ('layer' \| 'color' \| 'linetype' \| 'lineweight' \| 'material' \| 'textStyle' \| 'dimensionStyle')[] }` | mutating | `UXD_MATCH_NO_TARGETS`, `UXD_MATCH_PROPERTY_NA` (reported per target in `data`, others still applied) |
| `set_current_layer` [core] | `{ layerId }` | mutating (document field) | `UXD_LAYER_NOT_FOUND`, `UXD_LAYER_LOCKED` |
| `save_layer_state` / `restore_layer_state` / `delete_layer_state` [core] | `{ name, properties?: ('visible' \| 'locked' \| 'color')[] }` | mutating | `UXD_LAYER_STATE_NOT_FOUND`, `UXD_LAYER_STATE_EXISTS` (save without `overwrite: true`) |
| `select_similar` [core] | `{ id, match: ('kind' \| 'layer' \| 'color' \| 'material' \| 'name')[] }` | session command (`annotations.session`, selection only, like `set_selection`) | `UXD_NO_SELECTION` |
| `select_by_filter` [core] | `{ kind?, layerId?, color?, namePattern?, property?: { name, min?, max? } }` | session command (selection only) | `UXD_FILTER_EMPTY` (no criterion) |
| `set_rollback` [parametric] | `{ stepId } \| { end: true }` | history meta-command | `UXD_STEP_NOT_FOUND` |
| `set_entity_layer` (extend) | add `entityIds?: string[]` (one command for many) | mutating | existing |

Commands that already exist and receive click flows only: `draw_polyline`, `draw_arc`, `draw_rectangle`, `draw_ellipse`,
`add_dimension`, `offset_2d`, `trim`, `extend`, `fillet_2d`, `chamfer_2d`, `move_entities`, `array_linear`, `array_polar`,
`fillet_edge`, `add_constraint`. Trim "quick mode" is a param addition to `trim` (`boundary: 'all-visible'`), not a new command.

Prompt annotation (additive, in `defineCommand`):

```ts
annotations: {
  prompts?: readonly {
    param: string;                                   // dotted path into params
    kind: 'point' | 'points' | 'distance' | 'angle' | 'number' | 'entity' | 'entities' | 'keyword' | 'text';
    label: string;                                   // "Specify next point"
    keywords?: readonly { key: string; label: string; value: unknown }[];  // [Close/Undo]
    default?: 'last' | number | string;              // "last" = last value used in this session
    relativeTo?: string;                             // param whose point is the "last point" for @ / direct distance
  }[];
}
```

Commands without `prompts` get a derived order (required params in schema order; `vec2/vec3` → point; `z.number` → number;
`ids` → entities). The contract test (VC-UXD-50) checks every prompt param exists in the schema.

## 5. Algorithms

### 5.1 Tool session (TR-UXD-01)

State `{ command, promptIndex, params, lastPoint, locked: Partial<Record<field, number>>, preview }`. Transitions: input →
validate against the prompt kind → write the param → `promptIndex++`; Enter on an empty prompt = default or finish (chains);
Esc = previous level (cancel the current input, then the session, then clear the selection — today's Esc semantics kept);
Ctrl+Z inside a session = drop the last input (today's behaviour for points kept). Commit = the last required prompt answered →
`dispatch`; for chains (`points`) Enter commits. Preview: after every param change, a pure dry run through `src/ui/preview`
(debounce removed for click tools — the rubber band is computed locally from the draft; the dry run stays for modify ghosts).

### 5.2 Coordinate grammar (TR-UXD-02)

```
entry      = [ "#" | "@" ] , ( cartesian | polar ) | distance | modecode
cartesian  = value , "," , value , [ "," , value ]
polar      = value , "<" , value                      (* distance < angle, degrees CCW from +X *)
distance   = value                                    (* direct distance along the tracking / cursor direction *)
value      = expr , [ unit ]
expr       = term , { ("+" | "-") , term } ;  term = factor , { ("*" | "/") , factor }
factor     = number | "(" , expr , ")" | "=" , identifier | "-" , factor
unit       = "mm" | "cm" | "m" | "in" | "ft" | "\"" | "'"        (* in = 25.4 mm exactly [R31] *)
modecode   = "end" | "mid" | "cen" | "gce" | "nod" | "qua" | "int" | "ext" | "ins" | "per" | "tan" | "nea" | "app" | "par"
```

Resolution: first point → absolute. Later points: `@` → relative; `#` → absolute; neither → relative when dynamic input is on,
absolute when off (AutoCAD rule [R5]). A bare `value` at a point prompt after the first point → direct distance along the
current direction (ortho / polar / tracking path if active, else the cursor direction). Errors: `UXD_COORD_PARSE` (with
1-based column), `UXD_COORD_RANGE` (non-finite), `UXD_COORD_UNKNOWN_PARAMETER`. Reference cases: `validation/data/
coordinate_grammar_cases.json` (closed forms by `generate_refs.mjs`).

### 5.3 Snap engine and spatial index (TR-UXD-03)

- **Features**: segments (lines, polyline edges, rectangle / solid-section edges), circular curves (circles, arcs), elliptic and
  spline curves as their existing polyline samples for nearest / intersection, and **point features** (endpoints, midpoints,
  centres, quadrants, geometric centres of closed shapes, nodes, insertion points, dimension points).
- **Index**: a static packed R-tree (Hilbert-sorted, node size 16) over feature boxes, built per document revision off the pointer
  path (idle callback); entities in the `affected` set of commands since the last build go to a **dirty overlay** scanned
  linearly and are excluded from the stale tree; rebuild when the overlay exceeds 1 % of features (spec choice).
- **Query**: aperture box (cursor ± `aperturePx / zoom`) → features in the box → per enabled mode, candidate points; **pairwise
  intersections only among the segments / curves returned by the box query**. Exactness: an intersection point inside the
  aperture lies on both curves, so both curves meet the aperture box and are returned; the same holds for perpendicular foot,
  tangent and nearest points (the snap point must be inside the aperture and lies on the curve). Extension and parallel come from
  acquired points (tracking, §5.4), not from the index.
- **Choice**: nearest by screen distance; ties by mode priority (endpoint, intersection, midpoint, centre, quadrant, node,
  insertion, geometric centre, perpendicular, tangent, extension, parallel, nearest); Tab cycles the sorted list; grid only when
  grid snap is on; else raw cursor.
- **Oracle**: a reference implementation without index (the same feature definitions, brute force) is kept in the tests;
  VC-UXD-46 requires identical results.

### 5.4 Tracking (TR-UXD-04)

Acquired set: up to N points (N a preference, default 7 — spec choice), a point is acquired after the cursor rests on its snap
for ≥ 300 ms (spec choice, cf. the 500 ms BricsCAD Quad delay [R14]) or by pressing the acquire key. Paths: for each acquired
point, rays at 0 / 90 / 180 / 270° and, with polar on, at every polar angle and extra angle; extension paths along acquired
segment directions; parallel path through the last point parallel to an acquired segment. Cursor snaps to a path within the
aperture and to the intersection of two paths (closed form `trackingTwoPaths` in `generate_refs.mjs`). Ortho / polar are the
paths of the "last point".

### 5.5 3D snaps (TR-UXD-05)

Per mesh-backed entity the renderer already holds geometry and a BVH (`viewport/3d/bvhSetup.ts`). Add per entity a **feature
set** built once per tessellation: vertices (welded mesh vertices of B-rep vertices when the kernel's tessellation carries
vertex / edge ids, else feature edges by dihedral angle > 30° — spec choice), edge polylines, circular edges (fit centre when
the edge is tagged circular by the kernel), face centroids. Query: ray from the cursor → BVH hit (face) → features of that
entity within the screen aperture, projected; same choice / Tab / tooltip as 2D. Apparent intersection: two edge polylines whose
screen projections cross inside the aperture → the point on the nearer edge.

### 5.6 Selection

- 3D box: project each visible entity's feature vertices (or its bounds for > 10k vertices) to screen; window = all projected
  points inside; crossing = any edge segment intersecting or any point inside (screen-space Liang-Barsky, as in `boxSelect.ts`).
- Click-click box: a click on empty space starts a box when the "box on click" preference is on (default on, as the drag
  alternative of SC 2.5.7); the second click closes it.
- Cycling: the pick returns all candidates within the pick radius sorted by distance; Shift+Space advances.
- Sub-element references (edges / faces) follow pack 04 DIR element identity (DIR TECHNICAL_SPEC §3.2); `set_selection` gains
  `elements?: { entityId, kind: 'edge' | 'face' | 'vertex', ref: string }[]` (additive).

### 5.7 Grips (TR-UXD-08)

`gripsOf` per kind: line (end ×2, mid), polyline (vertex ×n, segment-mid ×n−1 or n), rectangle (corners ×4, edge mids ×4,
centre), circle (centre, quadrant ×4), arc (ends, mid, centre), ellipse (centre, axis ends ×4), spline (fit points), text
(insertion), dimension (definition points, text). `applyGrip` ops: `move` vertex / end → new position; `stretch` = move with
attached segments; `lengthen` along the tangent; `add_vertex` at a segment mid (the new vertex moves to `to`); `remove_vertex`;
`radius` (circle quadrant → distance to centre); `to_arc` (segment → arc through `to`). Hot grip: the session prompt is
"Specify stretch point or [Base point/Copy/Undo]"; Space cycles to move / rotate / scale / mirror sessions on the selection,
committing `move_entities` / `rotate_entities` / `scale_entities` / `mirror_entities`.

### 5.8 Keymap and aliases (TR-UXD-06, TR-UXD-07)

Resolution order for a key event: open text field → prompt context → active-tool context → view context (2d / 3d / sketch) →
global. Chord grammar `Ctrl+Shift+K`, `F8`, `G G` (sequence, ≤ 1 s between keys — spec choice). Conflict = same chord, same or
overlapping context. Presets are data files (`src/ui/keymap/presets/*.json`); the current `hooks/shortcuts.ts` table becomes the
`llull` preset (same keys; F-keys added). Alias file parser: lines `abbr, *command` (whitespace-tolerant, `;` comments, last wins
[R2]); targets resolved against `listCommands()` names and an AutoCAD-name map (`LINE → draw_polyline (2-point chain)`,
`CIRCLE → draw_arc`, `RECTANG → draw_rectangle`, `OFFSET → offset_2d`, `TRIM → trim`, `FILLET → fillet_2d`, `MOVE →
move_entities`, `COPY → copy_entities`, `MATCHPROP → match_properties`, `DIMLINEAR → add_dimension{linear}`, `STRETCH →
stretch_2d`, `LENGTHEN → lengthen_2d`, `BREAK → break_2d`, `JOIN → join_2d`, …); unknown → `UXD_ALIAS_UNKNOWN_COMMAND`
listed in Settings, never fatal.

### 5.9 Navigation presets

| Preset | Orbit | Pan | Zoom | Source |
| ------ | ----- | --- | ---- | ------ |
| llull (today's 3D) | left-drag on empty space | right-drag | wheel | `ShortcutsDialog` text (M2) |
| Fusion-like | Shift + middle-drag | middle-drag | wheel | [R20] |
| SOLIDWORKS-like | middle-drag | Ctrl + middle-drag | Shift + middle-drag, wheel | [R20] (grade B; verify on an install) |
| AutoCAD-like | Shift + middle-drag | middle-drag | wheel (to cursor) | spec choice; verify (grade C) |

2D in every preset: middle-drag pans and wheel zooms to the cursor, also while a tool is armed (left-drag stays reserved for
picks). Orbit centre: picked point under the cursor at button-down (BVH hit), else the selection centre, else the view target.
Previous / next view: a camera history of 20 (spec choice), view-state only.

### 5.10 3D mouse (TR-UXD-11)

Native: a Node-API addon in `desktop/` wraps the 3Dconnexion Navigation Library (navlib, SDK ≥ 4.0 [R23]); the main process
answers navlib's camera / pivot / model-extents queries from a state the renderer posts over IPC, and forwards motion to the
renderer's camera bridge. Exported commands: every registered command + view commands (Fit, Front, Top, Iso, named views)
through the action interface [R23]; the pivot (centre of rotation) is drawn while moving. WebHID (today) stays as the fallback
when navlib is absent (Linux, no driver). Licence / redistribution of the SDK: open question Q3.

### 5.11 Sketch inference (FR-UXD-17)

While a draft segment is drawn on a sketch plane (or in 2D with inference on): horizontal / vertical when the segment angle is
within the inference band (equal to the polar snap tolerance) of 0 / 90°; coincident when the endpoint came from an endpoint /
nearest snap; tangent / perpendicular / parallel from the matching snap or tracking path. The inferred list is shown as glyphs;
commit dispatches one `build_project` with the `draw_*` step then one `add_constraint` per inference (one undo step, since a
plan is one history step today, `docs/UI.md`). Ctrl held suppresses inference for that pick [R18].

## 6. Interop and persistence

- Documents: three optional fields (§3.1), saved and loaded by the existing persistence; absent = none. `layerStates` and
  `currentLayerId` export to DXF / DWG layer-state and CLAYER equivalents only when pack 08 XCH decides to map them (open, not
  required here).
- Alias file: plain text, `abbreviation, *command`; an AutoCAD `acad.pgp` / `acaduser.pgp` can be imported (the `*` targets
  mapped by §5.8; external-command lines `NAME, cmd, flags, prompt` ignored with a notice).
- Keymap and preferences: `interaction.json` (§3.3), export / import from Settings.

## 7. CLI / UI surfaces and error codes

- CLI: every command of §4 is a CLI tool (`llull describe edit_grip`, `llull edit_grip '{…}' --app`). The command line text and
  the CLI call are the same command + params; "Copy as CLI" (FR-UXD-05) emits `llull <name> '<json>'`.
- UI surfaces: command line + prompt line (bottom), dynamic-input fields (cursor), status-bar toggles (F3 … F12) and readout,
  Settings ▸ Drafting / Keyboard / Navigation / 3D mouse, view cube (top right of the 3D view), grips (2D), quick properties.

### 7.1 Stable codes (AF-11)

| Code | Where | Meaning |
| ---- | ----- | ------- |
| `UXD_COORD_PARSE` | grammar | text not in the grammar; column given |
| `UXD_COORD_RANGE` | grammar | value not finite |
| `UXD_COORD_UNKNOWN_PARAMETER` | grammar | `=name` not a document parameter |
| `UXD_ALIAS_UNKNOWN_COMMAND` | alias loader | alias target not a registered command |
| `UXD_KEYMAP_CONFLICT` | keymap editor | chord already bound in an overlapping context |
| `UXD_GRIP_UNKNOWN` | `edit_grip` | grip id not among `list_grips` |
| `UXD_GRIP_OP_UNSUPPORTED` | `edit_grip` | op not valid for that grip / kind |
| `UXD_GRIP_DEGENERATE` | `edit_grip` | result would be degenerate (zero-length, < 2 vertices) |
| `UXD_GRIP_KIND_UNSUPPORTED` | `list_grips` | entity kind has no grips (3D solids: use the gizmo) |
| `UXD_NO_SELECTION` | batch transforms, `select_similar` | no ids |
| `UXD_SCALE_FACTOR` | `scale_entities` | factor ≤ 0 or not finite |
| `UXD_MIRROR_LINE_DEGENERATE` | `mirror_entities` | the two points coincide |
| `UXD_STRETCH_NOTHING_INSIDE` | `stretch_2d` | no vertex in the window |
| `UXD_BREAK_POINT_OFF_ENTITY` | `break_2d` | point farther than tolerance from the entity |
| `UXD_JOIN_NOT_CONNECTED` | `join_2d` | entities neither touch nor are collinear / co-circular |
| `UXD_LENGTHEN_KIND` / `UXD_LENGTHEN_NONPOSITIVE` | `lengthen_2d` | kind not supported / resulting length ≤ 0 |
| `UXD_MATCH_NO_TARGETS` / `UXD_MATCH_PROPERTY_NA` | `match_properties` | empty targets / property not applicable to a target |
| `UXD_LAYER_NOT_FOUND` / `UXD_LAYER_LOCKED` | `set_current_layer` | unknown / locked layer |
| `UXD_LAYER_STATE_NOT_FOUND` / `UXD_LAYER_STATE_EXISTS` | layer-state commands | unknown name / name taken |
| `UXD_FILTER_EMPTY` | `select_by_filter` | no criterion given |
| `UXD_STEP_NOT_FOUND` | `set_rollback` | unknown step id |

Refusals follow the existing convention (unchanged document, summary `<name> refused: <CODE> …`, code in `data.code`).

## 8. Performance and robustness budgets

Machine profiles from [`../readiness_gate.json`](../readiness_gate.json): budgets gate on `office-min`, baselines on `ref-win11`.

| Budget | Value | Derivation / source | VC |
| ------ | ----- | ------------------- | -- |
| Snap query p95, all modes, 1k / 10k / 100k segments | ≤ 2 ms | spec: 12 % of a 16.7 ms frame (1000 / 60) | VC-UXD-45 |
| Index rebuild, 100k segments | off the pointer path; TBD — measure (reported, not gating) | — | VC-UXD-45 report |
| Rubber-band frame time p95, 10k entities | ≤ 16.7 ms | 1000 / 60 Hz | VC-UXD-47 |
| Hover highlight latency p95 | ≤ 16.7 ms (1 frame) | same | VC-UXD-24 |
| Commit-to-paint and key-to-armed p95 (local) | ≤ 100 ms | "0.1 second … reacting instantaneously" [R29] | VC-UXD-48 |
| Command-line suggestions per keystroke p95 | ≤ 50 ms | spec: half of 0.1 s | VC-UXD-57 |
| Shortcut bar open p95 | ≤ 100 ms | [R29] | VC-UXD-37 |
| 3D-mouse navigation frame rate / 2D-mouse frame rate | ≥ 0.9 | "similar to … a 2D mouse" [R23]; 0.9 is the spec's reading of "similar" | VC-UXD-41 |
| Robustness | a preference file that fails validation never blocks start-up (defaults + notice); a broken alias line never blocks the others | — | VC-UXD-06, -55 |

## 9. Test strategy

| Level | What | VC |
| ----- | ---- | -- |
| unit (`tests/unit/`, node) | grammar cases, snap closed forms, ortho / polar / tracking, grid toggle, index = oracle, grips, every new command happy + failure + `is pure`, keymap / alias parsers, preferences not in the document, registry contract | 01, 02, 04, 06, 10, 11, 13–15, 18, 26, 35, 38, 46, 50, 51, 55 |
| cli (`llull` on the fixture) | `list_grips`, new modify / layer / match / selection / rollback commands | 22, 25, 29, 33, 34, 44 |
| electron (pack 06 harness) | task flows with declared commands (`act.*` + `expect`), counts from `observe.commands`, UX trace, axe | 03, 05, 07–09, 12, 16, 17, 19–21, 23, 24, 27, 28, 30–32, 36, 37, 39, 40, 42, 43, 48, 52, 54, 57 |
| perf (pack 03 runner) | snap query and frame-time benches on generated 1k / 10k / 100k drawings | 45, 47 |
| review | 3D mouse on hardware, WCAG audit, parity checklist | 41, 49, 56 |
| field (pack 01) | human task times, llull vs incumbent | 53 |

### 9.1 Technical requirements

| Id | Requirement | VC |
| -- | ----------- | -- |
| TR-UXD-01 | One `ToolSession` state machine (§2.2, §5.1) drives draw, modify, grip, click flows and the command line; every session ends in exactly one `dispatch` or none | 03, 07, 23, 52 |
| TR-UXD-02 | Coordinate / value grammar in `packages/core/src/lib/coordinateInput.ts` + `valueExpression.ts`, pure, with stable codes (§5.2) | 01, 02 |
| TR-UXD-03 | Snap engine with packed R-tree + dirty overlay, box-local intersections, brute-force oracle (§5.3) | 10, 45, 46 |
| TR-UXD-04 | Tracking engine: acquired points, paths, path intersections (§5.4) | 15 |
| TR-UXD-05 | 3D feature sets per tessellation + BVH query for true-geometry snaps (§5.5) | 16 |
| TR-UXD-06 | Command line over `listCommands()` + aliases + synonyms; prompt driver from `annotations.prompts` or the derived order (§4, §5.8) | 06, 07, 43 |
| TR-UXD-07 | Keymap resolver with contexts, conflicts, presets as data, live shortcut sheet (§5.8) | 35 |
| TR-UXD-08 | `gripsOf` / `applyGrip` in core `geometry/grips`, `list_grips` / `edit_grip` commands, 2D grip renderer (§3.2, §5.7) | 25, 26, 27 |
| TR-UXD-09 | New commands of §4 with the codes of §7.1 | 22, 26, 29, 33, 34, 44 |
| TR-UXD-10 | `interaction.json` preferences (§3.3) persisted by `desktop/`, never in the document or undo | 55 |
| TR-UXD-11 | navlib Node-API addon + IPC camera bridge; WebHID fallback (§5.10) | 41 |
| TR-UXD-12 | UX trace: `LLULL_UX_TRACE=<path>` writes JSONL `{t, kind: key \| pointer \| prompt \| dispatch \| paint, …}` with `performance.now()` + epoch offset; off by default; no network | 54 |
| TR-UXD-13 | Latency probes: `performance.mark` around snap query, preview, dispatch → first `requestAnimationFrame` after the store update; read by pack 06 `perf.measure` | 45, 47, 48 |
| TR-UXD-14 | Accessibility: command line `role="combobox"` with `aria-activedescendant`, prompt line `aria-live="polite"`, dynamic-input fields labelled, focus never moved under a popup | 43, 49 |
| TR-UXD-15 | Error codes of §7.1, each asserted by at least one case | 02, 26, 33, 34, 35 |

## 10. Delivery plan

| Milestone | Content | Depends on | Effort (agent-days, estimate) |
| --------- | ------- | ---------- | ----------------------------- |
| M0 | UX trace + latency probes (TR-UXD-12, -13) | 06 E2E harness M1 | 2 |
| M1 Precision input | grammar, dynamic input, readout, F-keys, grid / ortho / polar toggles, `interaction.json` | M0 | 6 |
| M2 Command line | ToolSession refactor, command line, aliases, prompts, repeat, transparent view, arc + dimension tools, LINE chain, history / copy as plan | M1 | 10 |
| M3 Snap engine | index, 14 modes, override, tooltip / Tab, tracking, 3D feature snaps | M1; 03 PRF corpus generator | 9 |
| M4 Selection and grips | 3D box, click-click, cycling, select ops, verb-noun, grips + commands, pick filters | M2, M3; 04 DIR element identity | 9 |
| M5 Modify and properties | click flows, 9 new modify / transform commands, Properties multi-edit, quick properties, match, layers | M2, M4 | 8 |
| M6 Keyboard and navigation | keymap editor + presets, view cube, navigation presets, shortcut bar, navlib addon | M2; owner Q3 for navlib | 9 |
| M7 Benchmark | harness tasks T01–T15, perf runs, parity review; pilot timing in 01 PIL | all above; 01 PIL | 4 + pilot |

Cross-pack: 06 E2E (harness, `act.*`, `observe.commands`, `perf.measure`, axe) must reach its M1 first; 03 PRF supplies the
`office-min` profile and the perf runner; 04 DSF guarantees one-gesture-one-undo-step under recovery; 01 PIL runs VC-UXD-53.

## 11. Open questions / decisions needed

| # | Question | Proposed decision |
| - | -------- | ----------------- |
| Q1 | Ship "AutoCAD-like" / "SOLIDWORKS-like" key and alias presets? (key assignments are not protected text, but naming vendors in the UI may be) | ship them as "Classic drafting" and "Feature modelling" presets; mention vendors only in the docs |
| Q2 | Command line always visible (AutoCAD) or shown on first keystroke (palette-like)? | docked, one line, expands on focus; Ctrl+K palette kept as its search view |
| Q3 | 3Dconnexion SDK: accept the SDK licence (redistributing navlib bindings, credits) and seek formal certification? | accept the SDK licence for the native path; certification optional after VC-UXD-41 passes |
| Q4 | Default 2D selection gesture: plain drag = box (AutoCAD) instead of today's left-drag pan? | yes: drag = window / crossing, middle-drag = pan (llull preset changes; documented in the release notes) |
| Q5 | `select_similar` / `select_by_filter` as mutating selection commands (history steps) or UI-only? | commands (agents need them), annotated `session: true` like `set_selection` today (`commands/document/setSelection.ts`: "not part of the feature history and not undoable") |
| Q6 | Benchmark ratio target 1.2 and the pilot sample size | keep 1.2 (inside the KLM 21 % RMS band [R26]); sample size set by 01 PIL |

## 12. References

[validation/sources.md](validation/sources.md) (R1–R37 external, M1–M3 llull measurements).
