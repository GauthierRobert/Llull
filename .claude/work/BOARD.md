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
- **Last updated:** 2026-05-25 (22 DONE; check green @ 244 tests; in-app AI bridge removed — MCP is the sole AI path)
- **DONE (22):** W0-1,W0-2, A1,A2,A3,A6, B1,B3, C1,C2,C3, D1,D2,D3, E1,E2, G1,G2,G3, H1, I2,I3. (I1/I4 = continuous gate+review, satisfied throughout.)
- **REMOVED (3):** F1,F2,F3 — the in-app AI bridge (`core/ai`), `/api/ai` proxy, and chat panel. Decision 2026-05-25: only MCP will be used for AI control. See decision log.
- **Lanes 1–4 main deliverables COMPLETE.** App is a working MCP-first 2D+3D CAD: registry-driven 3D+2D viewports, toolbar, properties/param panel, hosted MCP endpoint + example agent, undo/redo, save/load, selection, gizmo, snapping, interactive draw.
- **REMAINING — needs direction/decision:**
  - `A4` boolean ops — **BLOCKED on CSG-lib choice (asking user now).**
  - `A5` cone/torus/wedge + `B2` add_text/add_dimension — grow the entity union; need PAIRED viewport render branches (command-author + viewport-engineer together).
  - `H2` STL export — deps A5.
  - `E3` layers panel — needs NEW layer-mutation commands first (set_layer_visibility/lock, add_layer); the undo/redo-buttons + shortcuts sub-part is ready now.
- **DONE & reviewed:** `A1`,`A2` (transforms+arrays), `W0-1` (store), `C1` (3D viewport+shell; disposal bug fixed to useEffect), `E1` (registry toolbar), `G1` (MCP defs; unknown-tool detection hardened to getCommand).
- **Orchestrator glue:** `Entities.tsx` tolerant `default: return null` (union growth).
- **WIP:**
  - `B1` 2D draw + Entity-union 2D kinds (Lane 1) — code done & green; in `[REVIEW]`.
  - `H1` save/load persistence (Lane 1, `command-author`)
  - `E2` properties panel + param forms (Lane 2, `viewport-engineer`)
  - `G2` MCP HTTP endpoint (Lane 4, `mcp-engineer`)
- **Next up:**
  - Lane 3 `D1` 2D view: launch once `B1` `[DONE]` AND `E2` frees `App.tsx` (avoid shell contention).
  - Lane 1 after H1/B1: `B3` 2D→3D bridge (showcase), `B2` annotate, `A5` solids (pair with viewport branches), `A3` edit cmds.
  - Lane 2 after E2: `C2` selection (raycast), `W0-2` undo + `E3`.
  - Lane 4 after G2: `G3` example agent script.

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
- `[WIP]` **A4-ui** Manifold WASM kernel impl (tessellate operands → CSG → MeshData) injected at startup + `mesh` render branch in 3D viewport. _deps: A4-core. Lane 2._
- `[WIP]` **R1** Remove AI-bridge code per F1/F2/F3 [REMOVED] (delete core/ai, /api/ai+anthropicClient, ChatPanel/useAiChat/chat.css, tests; unmount in App; drop @anthropic-ai/sdk). _Lane 4+shell. deps: —._
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

## Decision log (resolve `[BLOCKED]` items here)
- **A4 boolean CSG library:** RESOLVED 2026-05-25 → **manifold-3d (Manifold)**. Robust watertight mesh booleans (WASM). Behind a `GeometryKernel` interface (L9) so OpenCascade.js can replace it later for exact B-rep/STEP. Mesh-based results stored as a new `mesh` solid kind.
- **In-app AI bridge:** REMOVED 2026-05-25 (user decision: "only MCP will be used"). Deleted `src/core/ai/**`, the Express `/api/ai` proxy + `anthropicClient.ts`, the chat panel (`ChatPanel`/`useAiChat`/`chat.css`), and the `@anthropic-ai/sdk` dependency. AI control is now delivered solely through the MCP host (`/mcp`). Architecture rules updated: L1 is now "two callers" (UI + MCP). Tasks F1/F2/F3 → `[REMOVED]`.
