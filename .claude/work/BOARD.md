# llull build board — single source of truth for "continue working"

This file is **state**. The `continue-working` skill reads it, reconciles it against the
actual repo, launches parallel agents for the next eligible tasks, and writes it back.
The user only ever has to say **"continue working"**. Humans may edit this file directly.

## Status tokens (line-start, machine-parsed)
- `[TODO]` not started · `[WIP]` an agent is on it now · `[REVIEW]` code done, awaiting `cad-reviewer` + `npm run check`
- `[DONE]` merged & green · `[BLOCKED]` needs a decision/dependency (see note) · `[REMOVED]` deliverable deleted by a later decision (see note)

## Conventions
- **Deps** reference other task IDs. A task is *eligible* only when every dep is `[DONE]`.
- **Lanes** own disjoint file sets (below) so parallel agents don't collide. One task per
  lane runs at a time. Default parallelism = **4 lanes** (+ Lane 5 review runs after each).
- The only shared file is `src/core/commands/registry.ts` — **Lane 1 owns it**; no other
  lane edits it.

## How parallel agents coordinate (they don't talk — they don't need to)
Agents are isolated; coordination is structural, run by the orchestrator:
1. Only the orchestrator writes this board; a task is flipped to `[WIP]` **before** its agent
   launches → the board is the live "who's on what" ledger. Agents never edit it.
2. Disjoint lane file-ownership means two agents **cannot** write the same file.
3. A `[WIP]` lane is busy → never re-assigned while in flight.
4. Cross-lane needs wait on `[DONE]` deps and read the result from **committed files** — the
   repo is the only channel between lanes.
5. `[REVIEW]` (cad-reviewer + `npm run check`, + merge if worktrees) is the backstop.

## Lane → agent → file ownership
| Lane | Agent | Owns (write scope) |
| ---- | ----- | ------------------ |
| 1 Core | `command-author` | `src/core/commands/**`, `registry.ts`, `src/core/model/types.ts` |
| 2 3D+Shell | `viewport-engineer` | `src/ui/viewport/3d/**`, `src/ui/components/**`, `src/ui/panels/**`, `src/ui/store/**` |
| 3 2D | `viewport-engineer` | `src/ui/viewport/2d/**`, snapping/tracking helpers |
| 4 MCP | `mcp-engineer` | `src/core/mcp/**`, `server/**` |
| 5 Review | `test-verifier` + `cad-reviewer` | `tests/**`; reviews every diff (not a blocking lane) |

---

## NOW (auto-updated by the skill)
- **Last updated:** 2026-05-25 — **W1, U2, N0, P1 on main (302 tests green).** S4-fix + J3 done in worktrees; P1/S4-fix/J3 under `cad-reviewer` now. **Isolation caveat (this session):** agent worktree isolation did NOT reliably engage — P1 committed directly to main (`46e4d24`, coherent + green); N0 used a real worktree (merged `a4f72ff`); J3 used a worktree but branched from STALE `02bb93d` (pre-W1) so its `dispatch.ts` will CONFLICT on merge (re-adds `data?`) — resolve by keeping W1's registry-command `data` passthrough + J3's describe_scene branch under one `data?` field.
- **REVIEW now:** P1 (`46e4d24`, on main), S4-fix (`worktree-agent-a58eda50ef1f7a913`), J3 (`worktree-agent-abf2804025b910539`).
- **Merged this session:** W1 (`c231eb2`), U2, N0 (`a4f72ff`), P1 (`46e4d24`). **Next up:** merge S4-fix + J3 (after review) → then M1 (measure, uses W1 `data`), Q1 (parameters), T2 (dimensions), N1/VN1 (cone/torus/wedge/pyramid).
- **Wave 1 DONE:** W0-1,W0-2, A1,A2,A3,A6, A4-core, R1, B1,B3, C1,C2,C3, D1,D2,D3, E1,E2, G1,G2,G3, H1, I2,I3. (I1/I4 = continuous gate+review.)
- **REMOVED (3):** F1,F2,F3 — in-app AI bridge (`core/ai`), `/api/ai` proxy, chat panel. MCP is the sole AI path (decision log).
- **Wave 1 carry-over WIP:** `A4-ui` Manifold WASM kernel + `mesh` render branch (Lane 2). _manifold-3d is a dep already; `Entities.tsx` still has no `case 'mesh'` → boolean results invisible until this lands._
- **Reconciliation findings (verified against repo) — fold into Wave 2:**
  - **GAP `N0`:** `add_cylinder`/`add_sphere` commands MISSING although `CylinderEntity`/`SphereEntity` types AND `CylinderMesh`/`SphereMesh` renderers already exist → command-only near-free win.
  - **FOUNDATION `W1`:** `CommandResult` = `{document,summary,affected}` only — **no `data` channel** → read-only measure/query tools can't return values. Also `ParamSpec.type` lacks enum/nested-object. Gates all `M*` and `Q*`.
  - **FOUNDATION `U1/U2`:** `CadDocument` has **no units/scale**; far-from-origin float32 jitter unaddressed → the "infinite scroll, no precision loss, scale present" ask.
- **Registered commands (24):** add_box, extrude_profile, move/delete/rotate/scale/mirror_entity, array_linear/polar, draw_line/polyline/arc/circle/rectangle/point, load_document, extrude_sketch, revolve_profile(stub), duplicate_entity, group/ungroup_entities, boolean_union/subtract/intersect.
- **Wave 2 eligible-now (deps already DONE):** W1, N0, N1(+pair VN1), U1, U2, S1, T1, L1, M-prep(after W1), P1, P2, P4, V1, V2, V3, J2, J3.
- **Suggested first parallel batch (4 lanes):** L1=`W1` (foundation, unblocks measure/parametric) · L2=`U2` (floating-origin precision) · L3=`S1` (ellipse/spline 2D) · L4=`J3` (MCP scene-describe). Then L1=`N0`→`N1`, L2=`A4-ui`→`P1`.

---

## Foundation (gates the UI lanes)
- `[DONE]` **W0-1** Zustand store + `dispatch(name, params)` wrapping `execute()`. _Lane 2. Reviewed clean (APPROVE); select() copies the input array. `@ui/store`: document/lastSummary + dispatch/setDocument/select/toggleSelection/clearSelection; 14 integration tests._
- `[DONE]` **W0-2** Undo/redo via snapshot stack (push on each dispatch). _Lane 2. Reviewed clean (APPROVE). undoStack/redoStack + undo()/redo(); no-ops excluded; setDocument clears history; cap 100; 11 tests; dispatch signature unchanged._

## Lane 1 — Core commands (`command-author`)
- `[DONE]` **A1** Transform commands: `move` / `rotate` / `scale` / `mirror` (`transform.ts`). _deps: —. Added rotate_entity/scale_entity/mirror_entity; reviewed clean; commands/** coverage 100%._
- `[DONE]` **A2** Array commands: linear + polar (`transform.ts`). _deps: A1. Reviewed clean (APPROVE); array_linear + array_polar; +17 tests; commands/** 100%. NIT applied: count schema docs say "integer >= 2"._
- `[DONE]` **A3** Edit commands: `delete` / `duplicate` / `group` / `ungroup` (`edit.ts`). _deps: —. Reviewed (APPROVE); NITs applied (removed dead DEFAULT_LAYER_ID import + void stmt). duplicate_entity + group_entities + ungroup_entities + EntityGroup/groups model (delete_entity untouched); 18 tests; gate held._
- `[DONE]` **A6** (follow-up, from A3 review) `delete_entity` prunes deleted ids from `doc.groups` + dissolves groups <2 members. _Lane 1. deps: A3. Self-verified (orchestrator): 4 tests, commands/** gate held (99.51/92.05/100/99.51)._
- `[DONE]` **A4-core** GeometryKernel port + `mesh` solid kind + boolean_union/subtract/intersect commands. _deps: —. Reviewed (APPROVE); SHOULD-FIX applied (scale-mesh test) + NITs (moved import, dropped dead ?? fallback). kernel.ts + MeshSolidEntity + 3 commands consume operands (+prune groups); tested vs fake kernel; 270 total; gate 99.57/92.71/100/100._
- `[DONE]` **A4-ui** Manifold WASM kernel impl (tessellate operands → CSG → MeshData) injected at startup + `mesh` render branch in 3D viewport. _deps: A4-core. Lane 2. Reviewed (APPROVE); check green (270). manifoldKernel.ts (per-kind tessellation, transforms, `.delete()` cleanup) + setGeometryKernel in main.tsx (non-blocking) + MeshSolidMesh + Entities `case 'mesh'`. **FOLLOW-UPS (need in-browser verify, A4-ui-fix):** (1) rotation uses Manifold extrinsic-XYZ but three.js renders intrinsic-XYZ → multi-axis-rotated operands mis-orient (single-axis OK) — reverse to extrinsic ZYX; (2) `mesh`-operand branch passes a POJO to `ofMesh` (needs `new mod.Mesh(...)`) → stacked boolean-of-boolean silently no-ops; (NIT) align MeshSolidMesh material to BoxMesh._
- `[DONE]` **R1** Remove AI-bridge code (F1/F2/F3). _Done by user edits; agent-verified: core/ai, ChatPanel/useAiChat/chat.css, anthropicClient + /api/ai all deleted; @anthropic-ai/sdk dropped; /mcp + example agent intact; zero dangling refs; root check green (270), server tsc clean._
- `[TODO]` **A5** More solids: `cone` / `torus` / `wedge` (`geometry.ts` + extend `SolidKind`). _deps: —_
- `[DONE]` **B1** 2D draw commands: line/polyline/arc/circle/rectangle/point (`draw2d.ts` + `Shape2DKind` + `is2D`). _deps: —. Reviewed (APPROVE; 3 minor NITs). 6 commands + Vec2/Shape2DKind/EntityKind/is2D/is3D; scale_entity extended for 2D; 127 tests; commands/** 100/97/100/100. NIT: draw_arc/draw_circle lack the array-shape guard draw_line has on center — robustness follow-up._
- `[TODO]` **B2** `add_text` + `add_dimension` (`annotate.ts`). _deps: B1_
- `[DONE]` **B3** 2D→3D bridge: `extrude_sketch` (+ `revolve_profile` stub) (`profile.ts`). _deps: B1. Reviewed (APPROVE); SHOULD-FIX applied (extrude_profile→extrude_sketch doc ref; removed as-unknown-as cast). extrude_sketch (closed-2D→extrusion, non-destructive) + revolve_profile stub; 16 tests; gate held._
- `[DONE]` **H1** Save/load: serialize/deserialize `CadDocument` (`persistence.ts`). _deps: —. Reviewed (APPROVE); SHOULD-FIX applied (added non-object-root JSON test → 19 tests). serializeDocument/deserializeDocument + load_document; envelope {format,version,document}. NIT (follow-up): import validation is structural only (no finite/range/hex checks)._
- `[TODO]` **H2** Export STL (mesh tessellation). _deps: A5_

## Lane 2 — 3D viewport + UI shell (`viewport-engineer`)
- `[DONE]` **C1** r3f scene + orbit + grid/axes + render branch per solid `kind`. _deps: W0-1. Reviewed (APPROVE); geometry disposal fixed to useEffect; tolerant default added. App shell + Viewport3D + Entities + per-kind meshes._
- `[DONE]` **C2** Selection: raycast, multi-select, highlight → store. _deps: C1. Reviewed clean (APPROVE). onClick raycast → select/toggleSelection; onPointerMissed → clearSelection; highlight from document.selection; single mechanism threaded via Entities onSelect; check green._
- `[DONE]` **C3** Transform gizmo dispatching transform commands. _deps: C2, A1. Reviewed (APPROVE); SHOULD-FIX applied (added transformGizmo.test.ts for the 3 pure delta helpers). drei TransformControls → move/rotate/scale_entity via delta on drag-end; orbit lockout; g/r/s; feedback-loop guarded; undoable._
- `[DONE]` **E1** Toolbar generated from `listCommands()` → dispatch. _deps: W0-1. Reviewed clean (APPROVE); registry-generated buttons → dispatch; mounted in App; 8 tests._
- `[DONE]` **E2** Properties panel + param forms from `paramsSchema`. _deps: W0-1. Reviewed clean (APPROVE). ParamForm (schema→typed inputs→dispatch) + PropertiesPanel (selection + command runner); mounted left dock; 14 tests._
- `[TODO]` **E3** Layers panel (visibility/lock) + undo/redo buttons + shortcuts. _deps: W0-2_

## Lane 3 — 2D viewport (`viewport-engineer`)
- `[DONE]` **D1** Orthographic top-down 2D view + 2D⇄3D toggle + render branch per 2D `kind`. _deps: W0-1, B1. Reviewed (APPROVE); SHOULD-FIX applied (PolylineRenderer memo dep: JSON.stringify→points ref). Viewport2D + Entities2D + 6 renderers; local viewMode toggle; 5 tests._
- `[DONE]` **D2** Snapping (endpoint/midpoint/center/intersection/grid) + ortho/polar tracking. _deps: D1. Reviewed (APPROVE); 2 SHOULD-FIX applied (swept arc midpoint across 0/2π wrap; polarIncrement<=0 → 15° default, +2 tests → 29). pure snapping.ts + useSnap + SnapIndicator._
- `[DONE]` **D3** Interactive draw tools (click-to-place → dispatch B commands). _deps: D2, B1. Reviewed clean (APPROVE; NITs only). useDrawTool + DrawInteraction (snapped clicks) + DrawPreview + DrawTools palette; line/polyline/circle/rectangle/point each via dispatch; Esc cancel; pure drawHelpers + 14 tests._

## Lane 4 — MCP server (`mcp-engineer`)
- `[REMOVED]` **F1** `core/ai` tool-calling bridge. _Removed 2026-05-25 (only MCP for AI control). Deleted `src/core/ai/**` + `tests/unit/ai-bridge.test.ts`._
- `[REMOVED]` **F2** Express `/api/ai` proxy. _Removed 2026-05-25. Deleted the `/api/ai` route + `server/src/anthropicClient.ts`; dropped `@anthropic-ai/sdk`._
- `[REMOVED]` **F3** Chat panel. _Removed 2026-05-25. Deleted `ChatPanel.tsx` + `useAiChat.ts` + `chat.css` + `tests/component/ChatPanel.test.tsx`; unmounted from `App.tsx`._
- `[DONE]` **G1** `core/mcp`: MCP tool defs generated from the registry. _deps: —. Reviewed (APPROVE); buildMcpTools + applyMcpToolCall; unknown-tool detection via getCommand (decoupled from summary text); 14 tests._
- `[DONE]` **G2** Express-hosted MCP endpoint + auth + rate limiting. _deps: G1. Reviewed (APPROVE post-fix); SHOULD-FIX applied: `transport as any` → `transport as Transport` (no any, server tsc clean). /mcp Streamable HTTP → applyMcpToolCall; MCP_AUTH_TOKEN bearer; express-rate-limit._
- `[DONE]` **G3** Example external agent script (end-to-end proof). _deps: G2. Reviewed (APPROVE). server/examples/mcp-agent.ts (MCP client → tools/list + chained add_box/draw_circle/extrude_sketch, id parsed from results); agent:example script; eslint no-console disabled for the CLI demo._

## Lane 5 — Tests & review (`test-verifier`, `cad-reviewer`) — continuous, non-blocking
- `[TODO]` **I1** Hold the `core/commands/**` 90/85/90/90 gate; happy + failure test per new command. _runs with every Lane-1 task_
- `[DONE]` **I2** Integration tests: `store.dispatch` → undo/redo. _deps: W0-2. Satisfied: tests/integration/store.test.ts + undo.test.ts (25 tests)._
- `[DONE]` **I3** Component tests for panels (param-gathering, not geometry). _deps: E2. Satisfied: Toolbar/PropertiesPanel/ViewMode component tests._
- `[TODO]` **I4** `cad-reviewer` pass on every `[REVIEW]` diff before flipping to `[DONE]`.

---

# WAVE 2 — capability expansion (parallelizable backlog)

New work, grouped by theme. Every task carries **Lane**, **deps**, and a one-line acceptance.
`PAIR(x↔y)` = a model/command task (Lane 1) and its viewport render branch (Lane 2/3) that must
land together — schedule them adjacent; the render task deps the command task. Lane file-ownership
is unchanged, so themes interleave freely across the 4 lanes.

## W — Foundations (Lane 1, `command-author`) — gate downstream themes
- `[DONE]` **W1** Extend the command contract for read-only + richer tools: add optional `data?: unknown` to `CommandResult` (query channel; `execute`/MCP pass it through) and add `enum?` + nested-object support to `ParamSpec`. _deps: —. Reviewed APPROVE (`c231eb2`); gate 99.57/92.71/100/99.57. `CommandResult.data` threads through `applyMcpToolCall` (only when present). `ParamSpec` gains `enum`, `type:'object'`+`properties`, recursive `items` via `ParamItemSpec` (optional description → 24 existing commands unchanged). 6 new contract tests. **FOLLOW-UP (M1):** `server/src/mcp.ts` transport drops `result.data` — surface it when the first query command lands._

## N/K — 3D solids & features (Lane 1 cmd + Lane 2 render)
- `[DONE]` **N0** `add_cylinder` + `add_sphere` commands (`geometry.ts`). _deps: —. Merged `a4f72ff` (real worktree). Both mirror `addBox`; graceful no-op on radius/height ≤ 0; registered; 8 tests; commands/** gate 99.6/92.91/100/99.6._
- `[TODO]` **N1** `add_cone` + `add_torus` + `add_wedge` + `add_pyramid`: extend `SolidKind` + entities + commands. _deps: —. PAIR(N1↔VN1)._
- `[TODO]` **VN1** Render branches for cone/torus/wedge/pyramid in `Entities.tsx` (three.js `Cone/Torus/...Geometry`, memoized+disposed). _Lane 2. deps: N1._
- `[TODO]` **N2** Real `revolve_profile`: closed 2D profile + axis + angle → surface of revolution. Store a parametric `revolution` kind (rendered via `LatheGeometry`, no kernel needed). _deps: B3. PAIR(N2↔VN2)._
- `[TODO]` **VN2** `revolution` render branch (`LatheGeometry`). _Lane 2. deps: N2._
- `[TODO]` **K1** `fillet_edge` + `chamfer_edge` via the `GeometryKernel` interface. _deps: A4-ui. **Likely BLOCKED:** Manifold has no robust edge-fillet/chamfer; may require the OpenCascade.js kernel swap (L9). Surface the decision before building._
- `[TODO]` **K2** `shell_solid` (hollow with wall thickness) via kernel. _deps: A4-ui. Same kernel-capability caveat as K1._
- `[TODO]` **K3** `sweep_profile` (profile along a path) + `loft_profiles` (between sections) → `mesh`. _deps: A4-ui, B3._

## U — Infinite precision & units (the "scroll forever, scale present" ask)
- `[TODO]` **U1** Units system: add `units` (`'mm'|'cm'|'m'|'in'|'ft'`, default `mm`) + display precision to `CadDocument`; `set_units` command; thread through persistence + measure summaries. _Lane 1. deps: —. Acceptance: round-trips through save/load; summaries report values with unit suffix._
- `[DONE]` **U2** Floating-origin / camera-relative rendering: rebase the rendered scene origin to a dynamic offset near the camera target so geometry far from (0,0,0) stays float32-stable (no jitter) — pan/zoom effectively infinite. Document keeps true double coords; offset is render-only (store, not document). _Lane 2. deps: —. Acceptance: a box at 1e7 units renders crisp; orbit/pan stable; selection raycast still correct._
- `[TODO]` **U3** Adaptive infinite grid + on-screen **scale bar / ruler HUD** for the 3D view: grid subdivision steps per zoom decade; HUD shows current unit length (reads `U1` units). _Lane 2. deps: U1, U2._
- `[TODO]` **U4** 2D view counterpart: adaptive ortho grid + scale bar + infinite pan/zoom in `Viewport2D`. _Lane 3. deps: U1. (U2 technique applied to the ortho camera.)_

## S — 2D sketch tools (Lane 1 cmd + Lane 3 render/interaction)
- `[TODO]` **S1** New 2D entities `ellipse` + `spline` (Catmull-Rom/Bézier): extend `Shape2DKind` + entities + `draw_ellipse`/`draw_spline` commands. _Lane 1. deps: —. PAIR(S1↔VS1)._
- `[TODO]` **VS1** 2D renderers for ellipse + spline + interactive draw tools. _Lane 3. deps: S1._
- `[TODO]` **S2** 2D modify commands: `offset_2d`, `fillet_2d`, `chamfer_2d`, `trim`, `extend`, `explode_polyline`. _Lane 1. deps: B1. PAIR(S2↔VS2 for the interactive pick-edge UI)._
- `[TODO]` **VS2** Interactive 2D modify tools (pick + preview) wired to S2 commands. _Lane 3. deps: S2._
- `[TODO]` **S3** `hatch_region` (fill a closed loop with a pattern) + `region` entity. _Lane 1+3. deps: B1._
- `[REVIEW]` **S4** Advanced object snaps: perpendicular, tangent, extension, nearest + object-snap tracking. _Lane 3. deps: D2. Fix pass committed (`worktree-agent-a58eda50ef1f7a913`, `355934c`): tangent `acos` fix, modes wired through `useSnap`/callers, fake `parallel` dropped. Under `cad-reviewer` (confirm the 3 blocking issues resolved) → then merge._

## T — Annotation (was B2; Lane 1 cmd + render PAIR)
- `[TODO]` **T1** `add_text` (string + height + plane placement). _Lane 1. deps: —. PAIR(T1↔VT1: drei `<Text>`/troika in both 2D & 3D)._
- `[TODO]` **VT1** Text render branch (2D + 3D). _Lane 2+3. deps: T1._
- `[TODO]` **T2** `add_dimension` (linear/aligned/radial/angular) referencing entity ids. _Lane 1. deps: B1, W1 (carry measured value). PAIR(T2↔VT2)._
- `[TODO]` **VT2** Dimension render branch (extension/dimension lines, arrows, text). _Lane 3. deps: T2._

## M — Measurement / query tools (read-only; ideal MCP tools)
- `[TODO]` **M1** Query commands returning `data` (no mutation): `measure_distance`, `measure_angle`, `measure_area`, `measure_perimeter`, `measure_bounding_box`, `measure_volume`, `mass_properties` (density→mass). _Lane 1. deps: W1, U1. Use the `measure` skill. Acceptance: each returns `{summary, data, affected:[]}`, document untouched; happy+failure tests._
- `[TODO]` **M2** Measurement HUD overlay: render measure results (distance readout, dimension witness lines, bbox) from the last query. _Lane 2 (3D) + Lane 3 (2D). deps: M1._

## L — Layers (Lane 1 cmd + Lane 2 panel)
- `[TODO]` **L1** Layer commands: `add_layer`, `rename_layer`, `set_layer_visibility`, `set_layer_lock`, `set_entity_layer`, `delete_layer` (reassign orphans to default). _Lane 1. deps: —. Acceptance: locked layers reject mutation gracefully; gate held._
- `[TODO]` **L2** Layers panel (visibility/lock/active-layer/color) + undo/redo buttons + keyboard shortcuts. (Supersedes old `E3`.) _Lane 2. deps: L1, W0-2._

## Q — Parametric (highest MCP value; Lane 1 model + Lane 2 panels)
- `[TODO]` **Q1** Named parameters/variables in the document + expression evaluation; command params may reference `=width*2`. _Lane 1. deps: W1. Use the `parametric` skill. Acceptance: `set_parameter`/`delete_parameter`; changing one re-evaluates dependents; pure._
- `[TODO]` **Q2** Constraints: dimensional (distance/angle driving) + geometric (coincident/parallel/perpendicular/tangent) as first-class document data + a solver pass. _Lane 1. deps: Q1._
- `[TODO]` **Q3** Editable feature history (timeline): promote the undo snapshot stack into a named, replayable command list — insert/reorder/edit-params/suppress → re-evaluate downstream. _Lane 1. deps: W0-2._
- `[TODO]` **VQ** Parameters panel + feature-history timeline panel. _Lane 2. deps: Q1, Q3._

## X — Export / Import (Lane 1 serialization + optional Lane 4 endpoints)
- `[TODO]` **X1** Export STL (ASCII+binary) from tessellated solids/meshes. (Was `H2`.) _Lane 1. deps: N0 (cylinder/sphere tess), A4-ui (mesh). Acceptance: valid STL for box/cylinder/sphere/extrusion/mesh._
- `[TODO]` **X2** Export OBJ + glTF/GLB. _Lane 1/2. deps: X1._
- `[TODO]` **X3** 2D export DXF + SVG from 2D entities. _Lane 1/3. deps: B1._
- `[TODO]` **X4** Import: SVG path → 2D profile, STL → `mesh` entity. _Lane 1. deps: X1/X3._
- `[TODO]` **JX** Optional MCP/server download endpoints for exports. _Lane 4. deps: X1._

## P — Performance (Lane 2/3, `viewport-engineer`)
- `[REVIEW]` **P1** On-demand rendering: `frameloop="demand"` + `invalidate()` on store/camera changes — idle scenes stop re-rendering (battery/CPU). _Lane 2. deps: —. Committed to main `46e4d24` (302 green). `StoreInvalidator` subscribes to `document`/`renderOrigin` → `invalidate()`; drei OrbitControls/TransformControls invalidate on `change`; U2 `RenderOriginSyncer` (useFrame) stays live via camera-change invalidations. Under `cad-reviewer` (verify no missed invalidation source / U2 rebase still fires)._
- `[TODO]` **P2** Instanced + merged rendering: `InstancedMesh` for `array_*`/duplicate results and identical primitives; merge static geometry to cut draw calls. _Lane 2. deps: —._
- `[TODO]` **P3** BVH-accelerated raycasting via `three-mesh-bvh` for selection/snap on large scenes (add dep). _Lane 2/3. deps: C2. Acceptance: selection O(log n) on 10k-tri meshes._
- `[TODO]` **P4** LOD + frustum culling + a geometry/material cache & disposal audit (no leaks across re-renders). _Lane 2. deps: —._
- `[TODO]` **P5** (Stretch) WebGPU renderer opt-in behind a flag with WebGL fallback; verify drei helpers (Grid/Gizmo) degrade gracefully. _Lane 2. deps: P1. Re-evaluate only if P1–P4 leave a measured GPU bottleneck._

## V — Design & UX feel (Lane 2/3, `viewport-engineer`)
- `[TODO]` **V1** Material/lighting upgrade: PBR materials, environment map (drei `Environment`), soft contact shadows / AO, tone mapping. _Lane 2. deps: —._
- `[TODO]` **V2** Command palette (Ctrl/Cmd-K over `listCommands()`), global keyboard-shortcut system, and view presets (front/top/right/iso + fit-to-selection). _Lane 2. deps: E1._
- `[TODO]` **V3** Visual design system: refined dark theme + light theme toggle, consistent panel/toolbar styling, iconography, status bar (cursor coords + active units). _Lane 2. deps: U1 (units in status bar)._
- `[TODO]` **V4** First-run empty-state / onboarding hints + MCP "connect an agent" affordance. _Lane 2. deps: —._

## J — MCP enhancements (Lane 4, `mcp-engineer`)
- `[TODO]` **J1** Expose the document as an MCP **resource** (read-only): list entities, read full document / selection. _deps: G2._
- `[TODO]` **J2** Batch/transaction tool: apply an ordered list of commands atomically with a combined summary (one round-trip for multi-step agent edits). _deps: G1._
- `[REVIEW]` **J3** `describe_scene` MCP tool: structured snapshot (entity ids, kinds, bounds, layers) so an agent can orient before editing. _deps: G1. Done in `worktree-agent-abf2804025b910539` (`219d3d7`, green 283): pure `describeScene(doc)→SceneSnapshot` in `core/mcp/scene.ts`, surfaced as a read-only built-in via `buildMcpTools()` (len+1), handled in `applyMcpToolCall` returning snapshot in `data`. **Branched pre-W1 → `dispatch.ts` MERGE CONFLICT expected** (re-adds `data?`); resolve keeping W1 passthrough + describe_scene branch. Under `cad-reviewer` → then merge._

---

## Decision log (resolve `[BLOCKED]` items here)
- **A4 boolean CSG library:** RESOLVED 2026-05-25 → **manifold-3d (Manifold)**. Robust watertight mesh booleans (WASM). Behind a `GeometryKernel` interface (L9) so OpenCascade.js can replace it later for exact B-rep/STEP. Mesh-based results stored as a new `mesh` solid kind.
- **In-app AI bridge:** REMOVED 2026-05-25 (user decision: "only MCP will be used"). Deleted `src/core/ai/**`, the Express `/api/ai` proxy + `anthropicClient.ts`, the chat panel (`ChatPanel`/`useAiChat`/`chat.css`), and the `@anthropic-ai/sdk` dependency. AI control is now delivered solely through the MCP host (`/mcp`). Architecture rules updated: L1 is now "two callers" (UI + MCP). Tasks F1/F2/F3 → `[REMOVED]`.
- **OPEN — kernel capability for K1/K2/K3 (fillet/chamfer/shell):** Manifold (current kernel) does mesh booleans well but has **no robust edge fillet/chamfer or shell**. These need either (a) an OpenCascade.js B-rep kernel swapped in behind the existing `GeometryKernel` interface (L9) — large WASM, slow init, but the "real CAD" path that also unlocks STEP export, or (b) mesh-approximation fillets (lower quality). Decide before scheduling K1/K2. Sweep/loft (K3) are achievable mesh-side. **Default recommendation: defer K1/K2 until an OCC kernel is justified; build N0–N3, sweep/loft, and the rest of Wave 2 first.**
- **OPEN — WebGPU (P5):** stay on WebGL until P1–P4 leave a *measured* GPU bottleneck; the renderer is an isolated `ui/` swap (two `<Canvas>` call sites), so deferring costs nothing.
