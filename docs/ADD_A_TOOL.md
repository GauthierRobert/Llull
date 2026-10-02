# How to add a tool

Adding a tool gives you a UI button and an MCP tool (drivable by Claude or any
MCP agent) — both at once. Four steps.

## 1. Write the command

CAD operations live in `packages/core/src/commands/` (pick the domain file, or start a
new one). Domain operations — building, industrial — live in their plugin package
(`packages/domain-aec/src/`), never in the core. Declare the command with
`defineCommand` and one zod schema; keep it pure.

```ts
import type { CommandResult } from './types';
import { defineCommand, z } from './schema';

export const scaleUniform = defineCommand({
  name: 'scale_uniform',
  description: 'Scale an entity uniformly about its origin by a positive factor.',
  params: z.object({
    id: z.string().describe('Id of the entity to scale'),
    factor: z.number().describe('Scale factor; must be > 0 (1 = unchanged)'),
  }),
  run: (doc, { id, factor }): CommandResult => {
    const target = doc.entities[id];
    if (!target || factor <= 0) {
      return { document: doc, summary: `scale_uniform: no entity ${id} or factor ≤ 0.`, affected: [] };
    }
    // ...build a NEW document; return { document, summary, affected: [id] }
  },
});
```

The schema is the single source of truth: it types `run`'s parameters, becomes the JSON
Schema that MCP agents see (so every field needs a `.describe(...)` written for someone who
cannot read the code), and is checked by `execute` before `run` is called. Helpers such as
`vec2()` / `vec3()` cover points and vectors. Commands that need the geometry kernel read it
from the execution context (`ctx.kernel`) and declare `annotations: { requiresKernel: true }`;
read-only queries declare `annotations: { readOnly: true }` and return their value in `data`.

## 2. Register it

Core command — import it in `packages/core/src/commands/registry.ts` and append it to the
definitions list, then add its name to one MCP toolset in `packages/mcp/src/toolsets.ts`:

```ts
import { scaleUniform } from './transform';

const rawDefinitions = [
  // ...
  scaleUniform,
] as ReadonlyArray<CommandDefinition<unknown>>;
```

Plugin command — add it to the plugin's command list (for the AEC plugins,
`packages/domain-aec/src/index.ts`); installing the plugin registers it and places it in the
plugin's toolset.

That's it for MCP — the MCP host reads the registry, so `scale_uniform` is now a callable
tool for Claude and any MCP agent automatically (agents find it with `search_tools` and load
its toolset with `enable_toolset`).

## 3. (Optional) surface it in the UI

If you want a dedicated button, add it in `src/ui/panels`. Most tools don't even
need this — the toolbar can iterate `listCommands()` and render generically.

## 4. Test it

Add a test file in `tests/unit/` (plugin commands: `tests/unit/building/`). Cover the happy
path and the missing-id / invalid-input path. Update the tool-schema snapshot
(`npx vitest run tests/unit/contract -u`) and review the diff — it is exactly what agents
will read. The coverage gate will remind you if you skip a branch.
