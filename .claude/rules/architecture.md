# RULE: architecture (the laws)

Authoritative. Violations are bugs, not style choices. Several are hook-enforced.

## L1 — One command layer, two callers

A command is a pure function `(doc, params) => { document, summary, affected }`.
It is the ONLY unit of change. Two callers route through it:

- UI: `store.dispatch(name, params)` → `execute(...)`
- MCP server: external agent (Claude or any MCP client) → `execute(...)`

Add a command once → both surfaces gain it via the registry. NEVER build a
capability for one surface that bypasses a command.

## L2 — Dependency direction is one-way

`ui → core → lib`. **`core/` must not import from `ui/`.** `core/` must not touch
`react`, `window`, `document`, `fetch`, or the DOM. Side effects that need those
live in `ui/`, the `server/`, or behind an injected interface.

> Hook-enforced: a PreToolUse guard blocks writing a react/DOM/fetch import into
> `src/core/`. If blocked, move the code to the correct layer.

## L3 — Purity

Commands return a NEW document; they never mutate the input. Build new objects with
spreads (`{ ...doc, entities: { ...doc.entities, [id]: e } }`). The `is pure` test
deep-compares the input before/after — it must be untouched. Purity is what makes
undo/redo (snapshot stack), AI replay, and testing trivial.

## L4 — Single source of truth

The `CadDocument` (Zustand store) is the only state. Entities are constructed/edited
ONLY inside `core/commands`. No component or server builds an `Entity` inline.

## L5 — Registry is the contract

`registry.ts` exposes `listCommands()`, `getCommand()`, `execute()`, `toToolSchemas()`.
- UI menus iterate `listCommands()`.
- MCP tool schemas come from `toToolSchemas()` — never hand-write a duplicate schema.
- `execute()` is the single choke point: add logging / undo-push / permission checks there.

## L6 — Backend is optional and thin

The app is fully usable offline in the browser. The Express `server/` exists only to
host the MCP endpoint (`/mcp`) so external agents can drive the document. No business
logic in the server — it forwards to the same registry/commands.

## L7 — 2D and 3D are one model, one command layer

llull is 2D + 3D (AutoCAD-like). Both live in the SAME `CadDocument` entity bag and are
changed by the SAME command layer — there is no separate 2D engine, store, or path.

- 2D shapes (`line`, `polyline`, `arc`, `circle`, `rectangle`, `point`, `text`,
  `dimension`) and 3D solids (`box`, `cylinder`, `sphere`, `extrusion`) are both
  `Entity` kinds, distinguished by `kind` (and an `is2D`/`is3D` helper).
- A 2D shape is planar: its geometry is local 2D (`Vec2`), and `position` places that
  plane in the shared 3D space (default plane z=0, normal +Z).
- The 2D⇄3D bridge is a command: a closed 2D profile feeds `extrude_profile` (later
  `revolve_profile`) to become a solid. Sketch once; build from it. Never duplicate the
  same geometry for the two worlds.
- The viewport offers a 2D drafting view (orthographic top-down) and a 3D view; both
  render the same entities from the same store. View mode is presentation, not a second
  model.

## L8 — Parametric: the document is a recipe, not just geometry

A full CAD stores HOW a model was built, not only its final shapes. llull's command
history is that recipe — an editable, replayable feature tree.

- Commands are pure `(doc, params) => doc`, so the ordered command list regenerates the
  document. Promote the undo snapshot stack into a named, editable history (insert /
  reorder / edit-params / suppress a step → re-evaluate downstream). This IS feature-based
  modeling, almost for free.
- Parameters & constraints are first-class document data: named variables; geometric
  (coincident, tangent, parallel…) + dimensional (driving) constraints. Changing a
  parameter re-runs dependent features. This is the single biggest MCP win — an agent
  edits a parameter and the model updates.
- Distinguish CONSTRUCTIVE geometry (sketches + features + params — the editable
  definition, the source of truth) from EVALUATED geometry (the meshes/B-rep you render
  and export, a derived cache). Store the constructive form; evaluate to the other.
- Keep it incremental — do NOT break the command/`CommandResult` contract to add it.
  See the `parametric` skill and context/model.md.

## L9 — The geometry kernel is an injected interface

three.js renders meshes; it is NOT a CAD kernel. Exact booleans, robust fillets/chamfers,
NURBS surfaces, and STEP/IGES export need a B-rep/solid kernel.

- The kernel lives behind a `core/` interface (e.g. `GeometryKernel`) and is INJECTED
  (DIP / solid S5). `core/commands` calls the interface, never a concrete kernel, so the
  command layer stays kernel-agnostic — start mesh-based (three.js / Manifold) and swap in
  OpenCascade.js later without touching commands.
- Prefer deriving evaluated geometry from the document rather than storing it (L8).

## Decision shortcuts

- "Where does this code go?" → if it changes the document, it's a command in `core/`.
  If it only renders/gathers input, it's `ui/`. If it's a pure helper, it's `lib/`.
- "The AI needs to do X." → add/extend a command. Do not special-case the AI path.
- "I need network/DOM in core." → you don't; inject an interface or move the call to `ui/server`.
- "Is this 2D or 3D code?" → neither has its own engine. It's a command in `core/` plus a
  render branch in the viewport; only the entity `kind` and how it's drawn differ (L7).
- "Make it driven by a parameter / constrained / editable later." → parametric: store it
  in the feature history + parameters/constraints (L8, `parametric` skill).
- "I need exact booleans / fillets / STEP export." → that's the geometry kernel interface
  (L9), not three.js.
- "Measure / how big / how heavy?" → a read-only query command returning `data` (`measure`
  skill); never mutate the document.
