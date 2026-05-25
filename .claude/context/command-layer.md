# CONTEXT: command layer (exact signatures)

Ground-truth reference for `src/core/commands`. Mirror these signatures exactly.
Source: `src/core/commands/types.ts`, `registry.ts`, `geometry.ts`.

## Contracts (`types.ts`)

```ts
interface CommandResult {
  document: CadDocument;   // next state (new object)
  summary: string;         // human + AI feedback; specific & factual
  affected: string[];      // ids created/changed (UI highlights, AI tracks)
}

type Command<P> = (doc: CadDocument, params: P) => CommandResult;

interface CommandDefinition<P> {
  readonly name: string;            // snake_case; == AI/MCP tool name
  readonly description: string;     // one line, shown to humans + AI
  readonly paramsSchema: ParamsSchema;
  readonly run: Command<P>;
}

interface ParamsSchema {
  type: 'object';
  properties: Record<string, ParamSpec>;
  required: string[];
}

interface ParamSpec {
  type: 'number' | 'string' | 'boolean' | 'array';
  description: string;              // written FOR an agent; assume no code access
  items?: { type: string };        // for type:'array'
}
```

## Registry API (`registry.ts`)

```ts
listCommands(): ReadonlyArray<CommandDefinition<unknown>>
getCommand(name: string): CommandDefinition<unknown> | undefined
execute(doc, commandName, params): CommandResult   // unknown command -> safe no-op
toToolSchemas(): Array<{ name; description; input_schema: ParamsSchema }>
```

- `execute` is the single entry point for UI / AI / MCP. Unknown command ⇒
  `{ document: doc, summary: 'Unknown command: X', affected: [] }`.
- To register: import the const into `registry.ts` and append to the `definitions`
  array (typed `as ReadonlyArray<CommandDefinition<unknown>>`). That is the ONLY
  registration step — AI and MCP pick it up automatically.
- `toToolSchemas()` output length MUST equal `listCommands()` length (guarded by a test).

## Purity helper pattern (`geometry.ts`)

```ts
function withEntity(doc: CadDocument, entity: Entity): CadDocument {
  return {
    ...doc,
    entities: { ...doc.entities, [entity.id]: entity },
    order: [...doc.order, entity.id],
  };
}
```

Existing commands to imitate: `add_box` (addBox), `extrude_profile` (extrude),
`move_entity` (move), `delete_entity` (deleteEntity).

Planned 2D drafting commands (same `CommandDefinition` shape, see `draw-2d` skill):
`draw_line`, `draw_polyline`, `draw_arc`, `draw_circle`, `draw_rectangle`,
`add_dimension`. They create 2D `Entity` kinds in the same document (see model.md).

Planned parametric commands (`parametric` skill): `set_parameter`, `add_constraint`,
`suppress_feature`, `reorder_feature` — they edit parameters/constraints/history;
replaying the history rebuilds `entities` (architecture L8).

Planned read-only QUERY commands (`measure` skill): `measure_distance`, `measure_angle`,
`area_of`, `volume_of`, `bounding_box`, `mass_properties`, `check_interference`. A query
returns the UNCHANGED doc, `affected: []`, a factual `summary` (with units), and the value
in the planned optional `CommandResult.data` field (see model.md → Query results).

- Create: build entity with `nextId(prefix)` from `@lib/id`, `layerId: DEFAULT_LAYER_ID`.
- Mutate-in-place semantics: clone the target with a spread, return new `entities` map.
- Delete: clone map, `delete`, also filter `order` and `selection`.
- Missing-id ⇒ return input doc unchanged, `affected: []`, descriptive `summary`.

## ID generation (`@lib/id`)

```ts
nextId(prefix = 'e'): string        // `${prefix}-${base36 time}-${base36 counter}`
__resetIdCounter(): void            // tests only — call in beforeEach
```

## How the two surfaces consume this (do not bypass)

- UI: `store.dispatch(name, params)` → `execute` → swap doc → push undo snapshot.
- MCP host (`core/mcp` + `server`): expose `toToolSchemas()` over MCP; on call,
  run `execute` on the shared document. This is how Claude or any MCP agent drives llull.
