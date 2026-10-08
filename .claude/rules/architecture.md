# RULE: architecture (the laws)

Authoritative. Violations are bugs, not style choices. Several are hook-enforced.
Implementation detail loads on demand: `rules/commands.md` (packages/tests), `rules/sync.md`
(MCP/server/store), `.claude/context/*`.

## L1 — One command layer, two callers

A command is a pure function `(doc, params, ctx?) => { document, summary, affected }` — the ONLY
unit of change. UI: `store.dispatch(name, params)` → `POST /command` (online) or local `execute`
(offline). MCP: external agent → `execute`. `execute(doc, name, params, ctx?)`
(`@core/commands/registry`) validates `params` against the zod schema first; invalid ⇒ unchanged
doc, summary `<name> rejected: invalid params — <path>: …`. NEVER build a capability for one
surface that bypasses a command.

## L2 — Dependency direction is one-way

`src/ui`, `server/` → `src/app` → `packages/{mcp, domain-aec, kernel-*}` → `packages/core`
(`@lib` inside core). No package imports `src/ui`; `packages/core` imports no other package. No
`packages/*/src` touches `react`, `window`, `document`, `fetch`, `localStorage`, or the DOM — put
side effects in `src/ui/`, `server/`, or behind an injected interface. Hook-enforced
(`enforce-architecture.mjs`); if blocked, move the code to the correct layer.

## L3 — Purity

Commands return a NEW document (spreads: `{ ...doc, entities: { ...doc.entities, [id]: e } }`),
never mutate the input. The `is pure` test deep-compares the input before/after. Purity is what
makes undo/redo, AI replay and testing trivial.

## L4 — Single source of truth

The `CadDocument` (Zustand store) is the only state. Entities are constructed/edited ONLY inside
commands (`packages/core/src/commands` or a plugin's commands). No component or server builds an
`Entity` inline.

## L5 — Registry is the contract

Registry = core `definitions` + each installed plugin's `commands`. It exposes `listCommands()`,
`getCommand()`, `execute()`, `toToolSchemas()`. UI menus iterate `listCommands()`; MCP schemas come
from `toToolSchemas()`; `paramsSchema` is derived from zod `params` — never hand-write either.
`execute()` is the single choke point (validation, `requiresKernel`, derivation guards,
feature-step append). MCP exposure is a VIEW (`@mcp/toolsets`); hidden tools stay callable via
`execute`.

## L6 — Backend is optional and thin

The app is fully usable offline. `server/` hosts `/mcp` and the shared live document; no business
logic — it forwards to the same registry. Live sync = the command log (`@mcp/liveSync`), never a
document diff.

## L7 — 2D and 3D are one model, one command layer

2D shapes (`Shape2DKind`) and 3D solids (`SolidKind`) are both `Entity` kinds in ONE entity bag,
distinguished by `kind` (`is2D`/`is3D`). A 2D shape is planar: local `Vec2` geometry, `position`
places the plane (default z=0, +Z normal). The 2D⇄3D bridge is a command (`extrude_sketch`,
`extrude_profile`, `revolve_profile`) — sketch once, never duplicate geometry. The 2D view is
orthographic top-down over the same store: presentation, not a second model.

## L8 — Parametric: the document is a recipe

`execute` appends a `FeatureStep` per mutating command; history meta-commands edit and re-evaluate
it. Ids are step-scoped (`<prefix>-<step>.<k>`) so replay re-mints identical ids. Parameters,
constraints, configurations are document data. Plugin-derived geometry is read-only (derivation
guards) and re-derived on load. Keep it incremental — do NOT break the `CommandResult` contract.

## L9 — The geometry kernel is an injected interface

three.js renders; it is NOT a CAD kernel. `GeometryKernel` (`@core/geometry/kernel`) is
implemented by `packages/kernel-manifold` (default) and `packages/kernel-occt`. Commands read it
ONLY from `ctx.kernel` and declare `annotations: { requiresKernel: true }`. Installing a kernel is
the composition root's job, never a command's.

## L10 — Domains are plugins

A domain extends core through `CadPlugin` (`{ name, toolset, commands, guards?, document? }`),
installed by `src/app/plugins.ts` `installDefaultPlugins()`. `packages/core` NEVER imports a plugin
(hook-enforced). New domain capability ⇒ a command in its plugin package, not in core.

## Decision shortcuts

- Changes the document → a command (core or plugin). Only renders/gathers input → `src/ui/`. Pure
  helper → `packages/core/src/lib/`. Wiring/installation → `src/app/`.
- "The AI needs to do X" → add/extend a command; never special-case the AI path.
- "I need network/DOM in core" → inject an interface or move the call to ui/server.
- 2D or 3D? → neither has its own engine: a command + a render branch per `kind` (L7).
- Parameter-driven / constrained / editable later → feature history + parameters (`parametric` skill).
- Exact booleans / fillets / STEP → `ctx.kernel` + `requiresKernel` (L9).
- Measure / how big / how heavy → read-only query command returning `data` (`measure` skill).
- A change seems to require breaking a law → STOP and surface the tension to the user.
