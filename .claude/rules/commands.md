---
paths:
  - 'packages/**'
  - 'tests/**'
---

# RULE: commands (command-layer detail — loads when touching packages/ or tests/)

Exact signatures: `.claude/context/command-layer.md`. Entity schema: `.claude/context/model.md`.

## Command shape (copy this skeleton)

```ts
import type { CommandResult } from './types';
import { defineCommand, z, vec3 } from './schema'; // plugins: '@core/commands/schema'

/**
 * @command foo_thing
 * @pure
 * @affects modifies 1 entity
 * @failure missing id -> no-op, affected:[]
 */
export const fooThing = defineCommand({
  name: 'foo_thing',
  description: 'One line, imperative, says what the op does to the document.',
  annotations: { idempotent: true }, // readOnly / destructive / idempotent / metaHistory / requiresKernel
  params: z.object({
    id: z.string().describe('Target entity id'),
    amount: z.number().describe('How much, in document units; must be > 0'),
    offset: vec3('Optional [x, y, z] offset. Defaults to [0, 0, 0].').optional(),
  }),
  run: (doc, { id, amount, offset = [0, 0, 0] }, ctx): CommandResult => {
    const target = doc.entities[id];
    if (!target) return { document: doc, summary: `No entity ${id}.`, affected: [] };
    // build NEW doc; ids via nextId(prefix) from @lib/id; kernel via ctx?.kernel
  },
});
```

- Doc-comment tags (only those that apply): `@command @pure @layer @affects @invariant @failure`.
  No narrative comments; delete any that restate the code.
- Schema helpers (`@core/commands/schema`): `vec2`/`vec3` (exact tuples), `looseVec2`/`looseVec3`
  (`run` checks length), `untypedArray` (`run` validates), `tolerant(schema)` (never rejected).
  Every property needs `.describe(...)` — `defineCommand` throws without it. Descriptions become
  the MCP `paramsSchema`: write them for an agent that cannot see the code.
- `run`: still validate semantics (ids exist, sizes > 0); on bad input return the **unchanged doc**,
  an explanatory `summary`, `affected: []`. Never throw for user error.
- `summary` is the AI's feedback signal: specific and factual (ids, sizes, counts).
- Register: core → `definitions` in `registry.ts`; domain → its plugin's `commands`.
- Tests (`tests/unit/**`): happy path + failure path + `is pure`. Assert `affected`, `summary`,
  observable entities — not internals. Coverage gate 90/85/90/90 on
  `packages/core/src/commands/**` + `packages/domain-aec/src/**`.
- Tool-schema snapshot (`tests/unit/contract/__snapshots__`) and golden corpus
  (`tests/golden/__snapshots__`) diffs must be intended; never `-u` to make red go green.

## Parametric (L8, as built)

- `FeatureStep { id: 'step-<n>', name, params, affected }` appended for every mutating command (not
  `readOnly` / `metaHistory`; nested executes join the running step). Meta-commands:
  `replay_history`, `edit_step_params`, `reorder_step`, `set_step_suppressed`, `insert_step`,
  `delete_step`.
- Ids: step n mints `<prefix>-<n>.<k>` (`doc.nextStepNumber`, never reused; `@lib/id`
  `stepIdSource`). Never `uniqueId()` / `Date.now()` in a command.
- Replay prefix cache (`commands/replayCache.ts`, `ctx.replayCache`): editing step k re-runs k..n.
- Parameters (`set_parameter`, `=expr` strings in step params) regenerate only dependents
  (`commands/dependents.ts`). Constraints + pure solver (`solve_constraints`), configurations, recipes.
- CONSTRUCTIVE vs EVALUATED: `@core/model/partition` (`definitionOf` / `evaluatedOf`). Plugin-derived
  entities are omitted from saved files (llull-document v2) and re-derived on load; v1 still read.

## Kernel (L9, as built)

- Shape boundary: commands pass a `ShapeRecipe` (`@core/geometry/shapeRecipe`) and get an opaque
  `ShapeHandle`; kernels implement `KernelOps<S>` on their native shape and wrap it with
  `kernelFromOps` (`@core/geometry/shapeKernel`: cache by `recipeKey`, rebuild on eviction). Meshes
  only come OUT (`tessellate`). Results store their recipe as `mesh.brep`; never feed a mesh back
  into the kernel when a recipe exists (`kernelShape.ts` `operandRecipe`).
- Kernel only from `ctx.kernel` (it caches its own shapes by recipe key). Never import a concrete
  kernel or call `getGeometryKernel()` in a command.
- Prefer deriving evaluated geometry from the document rather than storing it (L8).
- `requiresKernel` command with `ctx.kernel === null` ⇒ "kernel not available" summary; replay
  refuses rather than silently dropping geometry.
- Kernel choice (`@core/geometry/kernelChoice`): browser `?kernel=occt`, server
  `LLULL_KERNEL=manifold|occt`; installed in `src/main.tsx` / `server/src/geometryKernel.ts`.

## Plugins (L10, as built)

- Installed by `installDefaultPlugins()` (called by `src/main.tsx`, `server/src/plugins.ts`,
  `tests/setup.ts`). Plugins import `@core` / `@lib` only.
- Command name clash ⇒ install throws; `toolset` places commands in an MCP toolset; `guards` are
  derivation guards; `document` (`DocumentExtension`) validates plugin data + restores derived geometry.
