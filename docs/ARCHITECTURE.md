# Architecture

## The core idea: one command layer, two callers

The hardest requirement of this project is "everything controllable by AI."
The naive approach — building UI features, then separately building AI
integrations for each — leads to duplicated logic and drift. We avoid that with
a single **command layer**. AI control is delivered through MCP, not a bespoke
in-app integration.

A _command_ is a pure function:

```ts
(document, params, context) => { document, summary, affected, data? }
```

It takes the current document and parameters, and returns a _new_ document plus
metadata. It never mutates its input and never touches React, the DOM, or the
network. Everything it needs from the outside world — the geometry kernel, the id
source, the registry for commands that run other commands — arrives in an injected
`ExecutionContext`.

Each command is declared once with `defineCommand`, from a single zod schema. That one
schema gives the TypeScript type of the parameters, the JSON Schema agents see over MCP,
and the runtime validation `execute` applies before the command runs (invalid params are
rejected with a summary naming the offending field, and the document is left unchanged).

Two callers invoke the same commands:

1. **React UI** — a button or gizmo gathers params and calls `dispatch(...)`, which runs
   the command on the server's live document (or locally when offline).
2. **MCP Server** — tool schemas generated from the command registry are served over
   MCP, so any external agent (Claude or any MCP client) calls the same `execute(...)`.

Because both converge on the registry, **any operation a human can do, an agent
can do, for free.** Add a command once; both surfaces gain it.

## Packages and their rules

The repository is an npm-workspaces monorepo:

```
packages/core            model, command layer, execution context, persistence,
                         geometry kernel interface, plugin host, code generators, pure helpers
packages/mcp             MCP tools, resources, prompts, toolsets, discovery, live-sync protocol
packages/domain-aec      building (AEC/BIM) and industrial-steel plugins
packages/kernel-manifold Manifold mesh kernel (default)
packages/kernel-occt     OpenCascade B-rep kernel
src/app                  composition root: installs the default plugins
src/ui                   React UI: viewport, panels, store
server/                  Express MCP host (optional)
```

**Dependency direction is one-way:** the UI and the server depend on the composition
root, which depends on the plugins, kernels and MCP layer, which all depend on the core.
The core depends on nothing else in the repository. This is what keeps the brain testable
in isolation, reusable by the headless MCP server, and open to new domains without edits.
A Claude Code hook blocks writes that break it.

## Plugins

A domain such as building or industrial design extends the core through a plugin: a
name, the MCP toolset its commands belong to, the commands themselves, optional
_derivation guards_, and an optional document extension. The composition root installs
the default plugins at start-up in the browser, the server and the test setup. The
registry is the core commands plus every installed plugin's commands.

Derivation guards protect generated geometry: the building plugin regenerates walls,
slabs and frames from its constructive model, so editing those generated entities
directly is rejected — the agent or user edits the source element instead. The document
extension validates the plugin's data when a file is loaded and re-derives the omitted
geometry.

## The document is a recipe

Every mutating command run through `execute` is recorded as a step in the document's
feature history. Ids are scoped to the step that created them (`box-7.1` is the first
id minted by step 7), so replaying the history produces the same ids — references
between steps never need rewriting. On top of that:

- **Parameters** are document data; step parameters may be expressions (`=width * 2`).
  Changing a parameter regenerates only the steps that read it.
- **Replay cache.** Replay reuses the cached result of an unchanged history prefix, so
  editing step _k_ re-runs only steps _k_…_n_.
- **History editing** (edit params, reorder, suppress, insert, delete) re-evaluates the
  model, as feature-based CAD tools do.
- **Constructive vs evaluated.** The definition (history, parameters, constraints,
  domain models) is the source of truth; `entities` and `order` are the evaluated cache.
  Saved files (llull-document version 2) omit plugin-derived geometry and re-derive it on
  load. Version 1 files are still read.

## Geometry kernel

three.js renders meshes; it is not a CAD kernel. Booleans, fillets, chamfers and shells go
through a `GeometryKernel` interface with two implementations: Manifold (default, small, mesh
only) and OpenCascade (exact B-rep, large WebAssembly). Commands receive the kernel through
their execution context.

The kernel boundary is a shape, not a mesh. A command describes what it wants as a
`ShapeRecipe` — a serializable construction tree (primitive leaves, then boolean, fillet,
chamfer, shell, placement and scale nodes) — and the kernel evaluates it to an opaque,
kernel-owned `ShapeHandle` (a TopoDS_Shape under OpenCascade). The kernel caches its native
shapes by the recipe's content hash, so an unchanged prefix of the feature tree is never
rebuilt; a handle carries its recipe, so a shape evicted from the cache, or lost with a
restarted worker, is simply rebuilt. Meshes only come out of the kernel, for display and mesh
exports. Each boolean/fillet result is stored as a `mesh` entity whose `brep` field is its
recipe: the next operation on it resumes the exact tree (a fillet on a boolean result rounds
a true edge), `inspect_topology` lists its real faces and edges, and `export_step_exact`
writes it as an exact STEP solid. When a kernel cannot rebuild a stored tree (a fillet
document opened under Manifold) the stored triangles are used instead. See
`docs/decisions/KI5-shape-kernel-boundary.md`.

Commands that need a kernel declare it; while none is loaded they refuse with an explicit
message instead of silently doing nothing.

The browser (`?kernel=occt`) and the server (`LLULL_KERNEL=occt`) use the same kernel
choice, so a command produces the same result whichever surface called it.

## State management and sync

The UI keeps the document in a single Zustand store (`src/ui/store`). `dispatch(name, params)`:

- **online** — sends the command to the server, which runs it on the shared live
  document; the result comes back over the `/live` stream;
- **offline** — runs `execute` locally, keeps an undo snapshot, and queues the command
  in an outbox that is replayed to the server on reconnect.

The live stream carries the **command log**, not document diffs: each event is
`{ seq, name, params, stateHash }`. Clients re-run the command with the same `execute`
and compare the resulting state hash; a missed event or a mismatch triggers a full
snapshot fetch (`GET /live/snapshot`). Deterministic ids and the shared kernel choice are
what make this replay exact. Every MCP session and every browser tab therefore edits one
document.

## Why the backend is optional

Everything — model, commands, rendering — runs in the browser. A backend is
only required for:

- **MCP host:** MCP is a running process exposing tools over a transport, so it
  cannot live inside a static site. The Express server serves `/mcp`, forwarding
  every tool call to the same command registry the UI uses.
- **Shared live document:** the server holds the document that agents and browser
  tabs edit together, with autosave.

It is an optional add-on; llull is fully usable offline without it.

## Data flow of an AI edit (via MCP)

```
Agent (Claude or any MCP client) is told to "make a 3-story tower"
        │
        ▼
Agent lists tools: the `core` toolset + search_tools / enable_toolset
        │  (search_tools "box" → enable_toolset "3d" → tools/list_changed)
        ▼
Agent calls tools over MCP: add_box {...} ×3   (or one build_project plan)
        │
        ▼
For each call: execute("add_box", params) on the shared live document
        │  (params validated, step recorded, ids step-scoped)
        ▼
Server broadcasts { seq, name, params, stateHash } on /live
        │
        ▼
Browser re-runs the command, checks the hash → React-Three-Fiber re-renders
```

The agent edits the same document the UI does because it is calling the same
`execute` the buttons call — there is no separate "AI mode."

## Testing strategy

- **Unit tests** target the command layer and the domain plugins heavily (90 %
  statements / 85 % branches / 90 % functions / 90 % lines). These are pure functions,
  so they're fast and exhaustive.
- **Contract tests** pin the cross-cutting guarantees: schema derivation, a snapshot of
  every tool schema agents see, the execution context, plugins, persistence, live sync.
- **Golden corpus** (`tests/golden`) runs representative `build_project` plans — 2D,
  booleans, parametric, assemblies, a building, an industrial portal — and compares the
  resulting documents (ids normalized) with stored snapshots, plus checks that replaying
  the history reproduces them. Any behaviour change shows up here.
- **Integration tests** exercise `store.dispatch` end-to-end (command → store → undo,
  sync, outbox).
- **Component tests** (Testing Library) cover panels and param-gathering, not
  geometry math. **E2E tests** (Playwright) drive the real app.

Files are kept small (at most 500 lines of code each, enforced by ESLint) so that a
change touches, and an agent reads, only what it needs.
