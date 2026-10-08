# RULE: architecture (the laws)

Authoritative. Violations are bugs, not style choices. Several are hook-enforced.

## L1 — One command layer, two callers

A command is a pure function `(doc, params) => { document, summary, affected }`.
It is the ONLY unit of change. Two callers route through it:

- UI: `store.dispatch(name, params)` → `POST /command` (online) or local `execute(...)` (offline)
- MCP server: external agent (Claude or any MCP client) → `execute(...)`

Signature: `execute(doc, name, params, ctx?)` (`@core/commands/registry`). It validates `params`
against the command's zod schema first; invalid ⇒ unchanged doc, summary
`<name> rejected: invalid params — <path>: …`.

Add a command once → both surfaces gain it via the registry. NEVER build a
capability for one surface that bypasses a command.

## L2 — Dependency direction is one-way

`src/ui`, `server/` → `src/app` (composition root), `packages/{mcp, domain-aec, kernel-*}` →
`packages/core` (`@lib` lives inside core). **No package imports `src/ui`; `packages/core`
imports no other package.** No `packages/*/src` touches `react`, `window`, `document`, `fetch`, `localStorage`, or the DOM.
Side effects that need those live in `src/ui/`, `server/`, or behind an injected interface.

> Hook-enforced (`.claude/hooks/enforce-architecture.mjs`, PreToolUse): blocks a react/DOM/fetch
> write into any `packages/<name>/src/`, and an `@aec` / `@mcp` / `@kernel-*` import into
> `packages/core/src/`. If blocked, move the code to the correct layer.

## L3 — Purity

Commands return a NEW document; they never mutate the input. Build new objects with
spreads (`{ ...doc, entities: { ...doc.entities, [id]: e } }`). The `is pure` test
deep-compares the input before/after — it must be untouched. Purity is what makes
undo/redo (snapshot stack), AI replay, and testing trivial.

## L4 — Single source of truth

The `CadDocument` (Zustand store) is the only state. Entities are constructed/edited
ONLY inside commands (`packages/core/src/commands`, or a plugin's commands in
`packages/domain-aec/src`). No component or server builds an `Entity` inline.

## L5 — Registry is the contract

`@core/commands/registry` exposes `listCommands()`, `getCommand()`, `execute()`, `toToolSchemas()`.
The registry = core `definitions` + every installed plugin's `commands` (installation order).
- UI menus iterate `listCommands()`.
- MCP tool schemas come from `toToolSchemas()` — never hand-write a duplicate schema. The
  `paramsSchema` itself is derived from the command's zod `params` by `defineCommand`; never
  hand-write it either.
- `execute()` is the single choke point: params validation, `requiresKernel` refusal, derivation
  guards, feature-step append. Add logging / permission checks there.
- MCP exposure is a VIEW (`@mcp/toolsets`): default = `core` toolset + `search_tools` /
  `enable_toolset`; hidden tools stay callable via `execute` (UI, `build_project` steps).

## L6 — Backend is optional and thin

The app is fully usable offline in the browser. The Express `server/` exists to host the MCP
endpoint (`/mcp`) and the shared live document so external agents and the UI edit one model. No
business logic in the server — it forwards to the same registry/commands.

- Live sync = the command log (`@mcp/liveSync`): `/live` SSE broadcasts `command`
  `{ seq, name, params, stateHash }` and `snapshot` `{ seq, stateHash, document }` events;
  clients re-run each command with `execute` and check `stateHash`; a seq gap or hash mismatch ⇒
  `GET /live/snapshot`. There is no document-diff channel and no UI bridge.
- Offline: the UI queues commands in an outbox (client `commandId` per entry, acked by id) and replays
  them on reconnect, remapping ids the server minted differently; `POST /command` is idempotent per
  `commandId`; events carry a server `epoch` so `(epoch, seq)` orders resyncs across restarts.

## L7 — 2D and 3D are one model, one command layer

llull is 2D + 3D (AutoCAD-like). Both live in the SAME `CadDocument` entity bag and are
changed by the SAME command layer — there is no separate 2D engine, store, or path.

- 2D shapes (`Shape2DKind`: `line`, `polyline`, `arc`, `circle`, `rectangle`, `point`,
  `ellipse`, `spline`, `text`, `dimension`) and 3D solids (`SolidKind`: `box`, `cylinder`,
  `sphere`, `extrusion`, `mesh`, `cone`, `torus`, `wedge`, `pyramid`, `revolution`) are both
  `Entity` kinds, distinguished by `kind` (and the `is2D`/`is3D` helpers).
- A 2D shape is planar: its geometry is local 2D (`Vec2`), and `position` places that
  plane in the shared 3D space (default plane z=0, normal +Z).
- The 2D⇄3D bridge is a command: a closed 2D shape feeds `extrude_sketch` (raw profiles:
  `extrude_profile`, `revolve_profile`) to become a solid. Sketch once; build from it. Never duplicate the
  same geometry for the two worlds.
- The viewport offers a 2D drafting view (orthographic top-down) and a 3D view; both
  render the same entities from the same store. View mode is presentation, not a second
  model.

## L8 — Parametric: the document is a recipe, not just geometry

A full CAD stores HOW a model was built, not only its final shapes. llull's command
history is that recipe — an editable, replayable feature tree.

As built:
- `execute` appends a `FeatureStep { id: 'step-<n>', name, params, affected }` to
  `doc.featureHistory` for every mutating command (not `readOnly` / `metaHistory`; nested
  executes join the running step). History meta-commands (`replay_history`, `edit_step_params`,
  `reorder_step`, `set_step_suppressed`, `insert_step`, `delete_step`) edit it and re-evaluate.
- Ids are step-scoped: step n mints `<prefix>-<n>.<k>` (`doc.nextStepNumber`, never reused), so
  replay re-mints identical ids — no id remapping (`@lib/id` `stepIdSource`).
- Replay prefix cache (`commands/replayCache.ts`, carried in `ctx.replayCache`): unchanged history
  prefixes are reused; editing step k re-runs k..n only.
- Parameters (`set_parameter`, `=expr` strings in step params) are document input: changing one
  regenerates only the steps that read it (`commands/dependents.ts`). Constraints + a pure solver
  (`solve_constraints`), configurations (design tables) and recipes are document data too.
- CONSTRUCTIVE vs EVALUATED: `@core/model/partition` (`definitionOf` / `evaluatedOf`;
  evaluated = `entities` + `order`). Plugin-derived entities (building) are omitted from saved
  files (llull-document v2) and re-derived on load; v1 files are still read.
- Derivation guards: geometry generated by a definition (plugin `guards`) is read-only —
  `execute` rejects edits to it; edit the source element instead.
- Keep it incremental — do NOT break the command/`CommandResult` contract.
  See the `parametric` skill and context/model.md.

## L9 — The geometry kernel is an injected interface

three.js renders meshes; it is NOT a CAD kernel. Exact booleans, robust fillets/chamfers,
NURBS surfaces, and STEP/IGES export need a B-rep/solid kernel.

As built:
- Interface `GeometryKernel` in `@core/geometry/kernel`; implementations in
  `packages/kernel-manifold` (default) and `packages/kernel-occt` (B-rep, `fillet_edge`).
- The boundary is a SHAPE, not a mesh: commands pass a `ShapeRecipe` (`@core/geometry/shapeRecipe`)
  and get an opaque `ShapeHandle`; kernels implement `KernelOps<S>` on their native shape and wrap it
  with `kernelFromOps` (`@core/geometry/shapeKernel`: cache by `recipeKey`, rebuild on eviction).
  Meshes only come OUT (`tessellate`). Results store their recipe as `mesh.brep`; never feed a mesh
  back into the kernel when a recipe exists (`kernelShape.ts` `operandRecipe`).
- Commands read the kernel ONLY from `ctx.kernel` (`ExecutionContext`, `@core/commands/context`),
  which caches its own shapes by recipe key (`shapeKernel.ts`). Never import a concrete kernel or call
  `getGeometryKernel()` in a command.
- A kernel-dependent command declares `annotations: { requiresKernel: true }`; `execute` refuses
  it with a "kernel not available" summary while `ctx.kernel` is null, and replay refuses rather
  than silently dropping geometry.
- One kernel choice for both surfaces (`@core/geometry/kernelChoice`): browser `?kernel=occt`,
  server `LLULL_KERNEL=manifold|occt`. Installing a kernel is the composition root's job
  (`src/main.tsx`, `server/src/geometryKernel.ts`), never a command's.
- Prefer deriving evaluated geometry from the document rather than storing it (L8).

## L10 — Domains are plugins

A domain (building, industrial, …) extends the CAD core through `CadPlugin`
(`@core/plugins/plugin`): `{ name, toolset, commands, guards?, document? }`, installed with
`installPlugin` (`@core/plugins/host`) by the composition root `src/app/plugins.ts`
(`installDefaultPlugins()`, called by `src/main.tsx`, `server/src/plugins.ts`, `tests/setup.ts`).

- `packages/core` NEVER imports a plugin (hook-enforced). Plugins import `@core` / `@lib` only.
- `commands` join the registry (name clash ⇒ install throws); `toolset` places them in an MCP
  toolset; `guards` are derivation guards; `document` (`DocumentExtension`) validates the
  plugin's document data and restores derived geometry on load.
- New domain capability ⇒ a command in its plugin package, not in `packages/core`.

## Decision shortcuts

- "Where does this code go?" → if it changes the document, it's a command
  (`packages/core/src/commands`, or a domain plugin). If it only renders/gathers input, it's
  `src/ui/`. If it's a pure helper, it's `packages/core/src/lib/`. Wiring/installation is `src/app/`.
- "The AI needs to do X." → add/extend a command. Do not special-case the AI path.
- "I need network/DOM in core." → you don't; inject an interface or move the call to `ui/server`.
- "Building/industrial/other domain feature?" → a command in that plugin (L10), never in core.
- "Is this 2D or 3D code?" → neither has its own engine. It's a command plus a
  render branch in the viewport; only the entity `kind` and how it's drawn differ (L7).
- "Make it driven by a parameter / constrained / editable later." → parametric: store it
  in the feature history + parameters/constraints (L8, `parametric` skill).
- "I need exact booleans / fillets / STEP export." → that's the geometry kernel interface
  (L9, `ctx.kernel` + `requiresKernel`), not three.js.
- "Measure / how big / how heavy?" → a read-only query command returning `data` (`measure`
  skill); never mutate the document.
