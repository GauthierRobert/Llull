# AR1 — A modular, acyclic command layer with executable architecture rules

Status: accepted (2026-10).

## Problem

After the MG0–MG6 migration the contracts were right, but the structure that holds them did not
scale:

- **161 import cycles.** `types.ts` → `context.ts` → `registry.ts` → every command → `types.ts`.
  The contract modules depended on the module that imports every implementation, so module
  initialisation order mattered and no layer could be understood on its own.
- **One flat folder.** `packages/core/src/commands` held 104 files: commands, the engine, and
  pure geometry that kernels, plugins and the viewport import. `domain-aec` had 45 loose
  building files, a 112-file `industrial/` and a 58-file `civil/`.
- **A registry hotspot.** Every new core command edited `registry.ts` (80 import lines, ~130
  list entries); the build board had to make it "Lane-1-only" so parallel agents would not
  collide.
- **Laws enforced only for agents.** Layering was checked by a Claude Code PreToolUse hook on
  agent edits. Human edits and CI were unchecked, and nothing detected cycles.
- **Leaky plugin boundary.** Plugins could import any core module; two did (a DXF-import
  constant, and calling `fit_view`'s `run` directly instead of composing through `execute`).

## Decision

- **Engine vs features.** The command engine stays at the root of `commands/`: `types.ts`
  (contracts, including `ExecutionContext`), `schema.ts`, `context.ts`, `commandTable.ts` (the
  name → definition table; imports no command), `execute.ts` (the choke point), `guard.ts`, and
  `registry.ts`, which only composes catalogs. `context.ts` reads the table, not the registry,
  so the cycle is gone.
- **Feature folders with catalogs.** Commands live in one folder per feature, each with a
  `catalog.ts` built with `commandCatalog(...)`, the one sanctioned place where params are
  erased to `unknown` (`execute` validates them first). Plugins use the same helper.
  A contract test fails when an exported command is in no catalog.
- **Pure geometry moves down.** Tessellation, triangulation, bounds, instance expansion and
  uniform scaling live in `core/geometry/` (under the coverage gate), so kernels, plugins and
  the viewport no longer import command modules for math.
- **Architecture as code.** `.dependency-cruiser.cjs` encodes the laws; `npm run arch` runs in
  `npm run check`. Rules: no runtime cycles, core imports no package, headless packages,
  plugins/kernels use only core's public API, MCP depends on no plugin or kernel, `lib` is a
  leaf, `model`/`geometry` stay below `commands`, app and server never import each other. The
  hook stays as fast feedback for agents.

## Alternatives considered

- **ESLint `import/no-cycle` + `no-restricted-imports`.** Cycle detection in ESLint re-parses
  the graph per file and is slow on this repo; path restrictions cannot express "plugins may
  import these core modules only". dependency-cruiser checks the whole graph in ~3 s.
- **Package `exports` maps as the public API.** Stronger (enforced by the resolver), but it
  means rewriting ~1 000 imports to entry points and adding barrels, which C6 forbids. The
  dependency rule gives the same boundary with no import churn; `exports` can follow later.
- **Keep one flat registry list.** Simple to read, but a conflict hotspot that grows linearly
  with the command count.
- **Derive MCP toolsets from feature folders.** Rejected: toolsets are an agent-facing view
  (L5) whose groups cut across folders (`core` holds transforms, layers and camera, for
  example). `packages/mcp/src/toolsets.ts` stays the single list, guarded by its own test.

## Consequences

- Zero runtime cycles; the few type-only cycles that remain come from recursive data
  (`Entity` ↔ `ShapeRecipe`, `CadDocument` ↔ `BuildingModel`) and are allowed.
- Adding a core command touches its feature folder (+ the toolset list); parallel lanes in
  different folders do not collide.
- Paths changed (`@core/commands/geometryBasic` → `@core/commands/solids/basic`, …). File names
  inside `domain-aec` were kept; only folders were added.
- Selection still lives in `CadDocument` (shared with MCP resources and `measure_*` on the
  selection). Moving it to per-client UI state is a product decision, not taken here.
