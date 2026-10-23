# RULE: architecture (the laws)

Authoritative. Violations are bugs, not style choices. Dependency laws are checked by `npm run arch`
(`.dependency-cruiser.cjs`, part of `npm run check`) and, at edit time, by a hook.
Implementation detail loads on demand: `rules/commands.md` (packages/tests), `rules/sync.md`
(protocol/server/store), `.claude/context/*`.

## L1 — One command layer, two callers

A command is a pure function `(doc, params, ctx?) => { document, summary, affected }` — the ONLY
unit of change. UI: `store.dispatch(name, params)` → `POST /command` (backend connected — the desktop app) or local `execute`
(no backend). CLI: agent (Claude Code, scripts) → `execute` in-process on a file, or the backend's `POST /command`. `execute(doc, name, params, ctx?)`
(`@core/commands/registry`) validates `params` against the zod schema first; invalid ⇒ unchanged
doc, summary `<name> rejected: invalid params — <path>: …`. NEVER build a capability for one
surface that bypasses a command.

## L2 — Dependency direction is one-way

`src/ui`, `server/` → `src/app` → `packages/{protocol, domain-aec, domain-cae, domain-aero, domain-dynamics, domain-implicit, design-lang, plm, kernel-*, physics-*}` → `packages/core`
(`@lib` inside core). No package imports `src/ui`; `packages/core` imports no other package. No
`packages/*/src` touches `react`, `window`, `document`, `fetch`, `localStorage`, or the DOM — put
side effects in `src/ui/`, `server/`, or behind an injected interface. No import cycles (type-only included).
Inside core: `commands`/`codegen`/`plugins` → `geometry` → `model` → `lib`. Enforced by `npm run arch`
and `enforce-architecture.mjs`; if blocked, move the code to the correct layer — never loosen a rule.

## L3 — Purity

Commands return a NEW document (spreads: `{ ...doc, entities: { ...doc.entities, [id]: e } }`),
never mutate the input. The `is pure` test deep-compares the input before/after. Purity is what
makes undo/redo, AI replay and testing trivial.

## L4 — Single source of truth

The `CadDocument` (Zustand store) is the only state. Entities are constructed/edited ONLY inside
commands (`packages/core/src/commands` or a plugin's commands). No component or server builds an
`Entity` inline.

## L5 — Registry is the contract

Registry = every core feature catalog (`commands/<feature>/catalog.ts`) + each installed plugin's
`commands`. It exposes `listCommands()`,
`getCommand()`, `execute()`, `toToolSchemas()`. UI menus iterate `listCommands()`; CLI tool schemas (`llull describe`, plan validation) come
from `toToolSchemas()`; `paramsSchema` is derived from zod `params` — never hand-write either.
`execute()` is the single choke point (validation, `requiresKernel`, derivation guards,
feature-step append). Toolsets are a VIEW (`@protocol/toolsets`: CLI listings, UI palette); every tool stays callable via
`execute`.

## L6 — Backend is optional and thin (desktop + CLI are hosts, not logic)

The app is fully usable offline. `server/` is the local backend (one per machine, loopback only) holding the shared live document; no business
logic — it forwards to the same registry. Live sync = the command log (`@protocol/liveSync`), never a
document diff. `desktop/` (Electron) only starts that server and wires menus/files; the `llull`
CLI (`server/src/cli`) is the agent caller of `execute`. There is no MCP server and no cloud host (LC1).

## L7 — 2D and 3D are one model, one command layer

2D shapes (`Shape2DKind`) and 3D solids (`SolidKind`) are both `Entity` kinds in ONE entity bag,
distinguished by `kind` (`is2D`/`is3D`). A 2D shape is planar: local `Vec2` geometry, `position`
places the plane (default z=0, +Z normal). The 2D⇄3D bridge is a command (`extrude_profile`,
`revolve_profile`, `sweep_profile`, `loft_sections`) — sketch once, never duplicate geometry. The 2D view is
orthographic top-down over the same store: presentation, not a second model.

## L8 — Parametric: the document is a recipe

`execute` appends a `FeatureStep` per mutating command; history meta-commands edit and re-evaluate
it. Ids are step-scoped (`<prefix>-<step>.<k>`) so replay re-mints identical ids. Parameters,
constraints, configurations are document data. Plugin-derived geometry is read-only (derivation
guards) and re-derived on load. Keep it incremental — do NOT break the `CommandResult` contract.

## L9 — The geometry kernel is an injected interface

three.js renders; it is NOT a CAD kernel. `GeometryKernel` (`@core/geometry/kernel`) is
implemented by `packages/kernel-manifold` (in-process mesh kernel) and, for exact B-rep, by the native `llull-kernel` sidecar
(`solver/`, OCCT 7.9, reached through `server/src/nativeKernel.ts`; no TS package, no WASM OCC). Commands read it
ONLY from `ctx.kernel` and declare `annotations: { requiresKernel: true }` (no kernel ⇒ `execute` refuses,
`commands/kernelRefusal.ts`). Kernel-OPTIONAL commands omit the annotation, read `ctx.kernel` when present for the exact
path and fall back cleanly without it (mesh result, or a named refusal for the kernel-only branch); tag them `@invariant
kernel-optional: …` and test both paths (e.g. `set_thread`; `add_rigid_body` via `geometry/resolveMassProperties.ts`: exact mass with a kernel, mesh integration without). The boundary is a SHAPE,
not a mesh: commands pass a `ShapeRecipe` and get an opaque `ShapeHandle`; meshes only come OUT.
Installing a kernel is the composition root's job, never a command's. Rigid-body physics follows the same pattern:
`PhysicsEngine` (`@core/dynamics/physicsEngine`, the only dynamics code kept in core), read from `ctx.physics`, implemented by `packages/physics-mujoco`; the rigid-body commands, model and force laws live in the plugin `packages/domain-dynamics` (`@dynamics/*`).

## L10 — Domains are plugins

A domain extends core through `CadPlugin` (`{ name, toolset, commands, guards?, document? }`),
installed by `src/app/plugins.ts` `installDefaultPlugins()`. `packages/core` NEVER imports a plugin.
A plugin sees core only through its public API (`model`, `lib`, `geometry`, `plugins/plugin`,
`commands/{schema,types,noop,derivation,registry}`) and composes other commands via `execute`.
New domain capability ⇒ a command in its plugin package, not in core.
Hosts (`server/`, `desktop/`, `src/app`, `src/ui`) use a plugin package ONLY through its `src/index.ts` API (`@cae/index`, `@aec/index`, …):
export there exactly what hosts need, never import plugin internals. Enforced by `npm run arch` (`hosts-use-plugins-through-their-index`); `tests/**` are exempt.

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
