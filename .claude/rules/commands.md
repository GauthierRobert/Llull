---
paths:
  - 'packages/**'
  - 'tests/**'
---

# RULE: commands (command-layer detail — loads when touching packages/ or tests/)

Laws only. Exact signatures + skeleton to copy: `.claude/context/command-layer.md`. Entity schema: `.claude/context/model.md`.
Procedure: `add-command` skill. Human intro: `docs/ADD_A_TOOL.md`.

## Command laws

- Annotations: `readOnly` / `destructive` / `idempotent` / `metaHistory` / `requiresKernel` (L9; kernel-optional commands omit it).
- Doc-comment tags (only those that apply): `@affects @invariant @failure` (path = layer, name = command; all commands are pure).
  No narrative comments; delete any that restate the code.
- Schema helpers (`@core/commands/schema`): `vec2`/`vec3` (exact tuples), `looseVec2`/`looseVec3`
  (`run` checks length), `untypedArray` (`run` validates), `tolerant(schema)` (never rejected).
  Every property needs `.describe(...)` — `defineCommand` throws without it. Descriptions become
  the tool `paramsSchema` (`llull describe`): write them for an agent that cannot see the code.
- `run`: still validate semantics (ids exist, sizes > 0); on bad input return the **unchanged doc**,
  an explanatory `summary`, `affected: []`. Never throw for user error.
- `summary` is the AI's feedback signal: specific and factual (ids, sizes, counts).
- Register: core → its feature folder's `catalog.ts` (`commandCatalog(...)`); domain → its plugin's
  `commands`. Never edit `registry.ts` for a new command.
- Tests (`tests/unit/**`): happy path + failure path + `is pure`. Assert `affected`, `summary`,
  observable entities — not internals. Coverage gate 90/85/90/90 on
  `packages/core/src/{commands,geometry,dynamics}/**` + `packages/{domain-aec,domain-cae,domain-aero,domain-dynamics,design-lang,plm}/src/**`.
- Tool-schema snapshot (`tests/unit/contract/__snapshots__`) and golden corpus
  (`tests/golden/__snapshots__`) diffs must be intended; never `-u` to make red go green.

## Parametric (L8, as built)

- `FeatureStep { id: 'step-<n>', name, params, affected }` appended for every mutating command (not
  `readOnly` / `metaHistory`; nested executes join the running step). Meta-commands:
  `replay_history`, `edit_step_params`, `reorder_step`, `set_step_suppressed`, `insert_step`,
  `delete_step`.
- Ids: step n mints `<prefix>-<n>.<k>` (`doc.nextStepNumber`, never reused; `@lib/id`
  `stepIdSource`). Never `uniqueId()` / `Date.now()` in a command.
- Replay prefix cache (`commands/history/replayCache.ts`, `ctx.replayCache`): editing step k re-runs k..n.
- Parameters (`set_parameter`, `=expr` strings in step params) regenerate only dependents
  (`commands/history/dependents.ts`). Constraints + pure solver (`solve_constraints`), configurations, recipes.
- CONSTRUCTIVE vs EVALUATED: `entities`/`order` are evaluated, the rest is definition. Plugin-derived
  entities (`derivedEntityIds`, `@core/plugins/host`) are omitted from saved files (llull-document v3) and re-derived on load; v1/v2 still read.

## Kernel (L9, as built)

- Shape boundary: commands pass a `ShapeRecipe` (type: `@core/model/types`; helpers: `@core/geometry/shapeRecipe`) and get an opaque
  `ShapeHandle`; kernels implement `KernelOps<S>` on their native shape and wrap it with
  `kernelFromOps` (`@core/geometry/shapeKernel`: cache by `recipeKey`, rebuild on eviction). Meshes
  only come OUT (`tessellate`). Results store their recipe as `mesh.brep`; never feed a mesh back
  into the kernel when a recipe exists (`kernelShape.ts` `operandRecipe`).
- Kernel only from `ctx.kernel` (it caches its own shapes by recipe key). Never import a concrete
  kernel or call `getGeometryKernel()` in a command.
- Prefer deriving evaluated geometry from the document rather than storing it (L8).
- `requiresKernel` command with `ctx.kernel === null` ⇒ "kernel not available" summary; replay
  refuses rather than silently dropping geometry.
- Kernel choice: backend + CLI `LLULL_KERNEL` (unset / `occt-native` = the native `llull-kernel`, else Manifold with a warning;
  `manifold` = diagnostic override), installed in `server/src/geometryKernel.ts`; the desktop renderer installs Manifold in `src/main.tsx` (no URL switch, LC1).

## Plugins (L10, as built)

- Installed by `installDefaultPlugins()` (called by `src/main.tsx`, `server/src/plugins.ts`,
  `tests/setup.ts`). Plugins import `@core` / `@lib` only.
- Command name clash ⇒ install throws; `toolset` places commands in a toolset (CLI listings, UI palette); `guards` are
  derivation guards; `document` (`DocumentExtension`) validates plugin data + restores derived geometry.
