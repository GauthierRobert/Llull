# How to add a tool

Adding a tool gives you a UI button and an MCP tool (drivable by Claude or any
MCP agent) — both at once. Three steps.

## 1. Write the command

In `src/core/commands/geometry.ts` (or a new file in `commands/`), add a
`CommandDefinition`. Keep it pure.

```ts
interface FilletParams {
  id: string;
  radius: number;
}

export const fillet: CommandDefinition<FilletParams> = {
  name: 'fillet_edge',
  description: 'Round the edges of a solid by a radius.',
  paramsSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Target entity id' },
      radius: { type: 'number', description: 'Fillet radius' },
    },
    required: ['id', 'radius'],
  },
  run: (doc, { id, radius }) => {
    // ...return { document, summary, affected }
  },
};
```

## 2. Register it

In `src/core/commands/registry.ts`, import and add to the `definitions` array:

```ts
import { addBox, extrude, move, deleteEntity, fillet } from './geometry';

const definitions = [addBox, extrude, move, deleteEntity, fillet] as ...;
```

That's it for MCP — the MCP host reads the registry, so `fillet_edge` is now
a callable tool for Claude and any MCP agent automatically.

## 3. (Optional) surface it in the UI

If you want a dedicated button, add it in `src/ui/panels`. Most tools don't even
need this — the toolbar can iterate `listCommands()` and render generically.

## 4. Test it

Add a case in `tests/unit/commands.test.ts`. Cover the happy path and the
missing-id / invalid-input path. The coverage gate will remind you if you skip.
