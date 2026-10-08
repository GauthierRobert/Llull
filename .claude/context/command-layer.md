# CONTEXT: command layer (exact signatures)

Ground-truth reference for `packages/core/src/commands` (`@core/commands/*`). Mirror these
signatures exactly. Source: `types.ts`, `schema.ts`, `context.ts`, `registry.ts`,
`entityOps.ts`, `commitEntity.ts`; ids in `packages/core/src/lib/id.ts`; plugins in `packages/core/src/plugins/`.

## Contracts (`types.ts`)

```ts
interface CommandResult {
  document: CadDocument;   // next state (new object; SAME reference for queries/no-ops)
  summary: string;         // human + AI feedback; specific & factual
  affected: string[];      // ids created/changed, deterministic order
  data?: unknown;          // structured value for read-only/query commands
}

interface CommandDefinition<P> {
  readonly name: string;              // snake_case; == AI/MCP tool name
  readonly description: string;       // shown to humans + AI
  readonly paramsSchema: ParamsSchema; // DERIVED by defineCommand — never hand-written
  readonly paramsValidator?: ZodType;  // set by defineCommand; execute validates with it
  readonly run: (doc: CadDocument, params: P, ctx?: ExecutionContext) => CommandResult;
  readonly annotations?: CommandAnnotations;
}

interface CommandAnnotations {
  readonly readOnly?: boolean;        // MCP readOnlyHint; same doc back, affected [], data
  readonly destructive?: boolean;     // MCP destructiveHint
  readonly idempotent?: boolean;      // MCP idempotentHint
  readonly metaHistory?: boolean;     // execute appends no FeatureStep (history edits,
                                      // load_document, set_parameter/delete_parameter)
  readonly requiresKernel?: boolean;  // execute/replay refuse while ctx.kernel is null
}

interface ParamsSchema { type: 'object'; properties: Record<string, ParamSpec>; required: string[] }
type ParamType = 'number' | 'string' | 'boolean' | 'array' | 'object';
interface ParamSpec {                 // description written FOR an agent; assume no code access
  type: ParamType; description: string;
  enum?: readonly (string | number)[]; items?: ParamItemSpec;
  properties?: Record<string, ParamSpec>; required?: readonly string[];
}
```

## Defining a command (`schema.ts`)

```ts
defineCommand<S extends z.ZodObject>(spec: {
  name: string; description: string; params: S; annotations?: CommandAnnotations;
  run: (doc: CadDocument, params: z.output<S>, ctx?: ExecutionContext) => CommandResult;
}): CommandDefinition<z.output<S>>
// paramsSchema = toParamsSchema(params); paramsValidator = z.looseObject(params.shape)
// (unknown keys preserved so recorded/legacy params still run).
// Throws at definition time if any property lacks .describe().

vec2(desc) / vec3(desc)               // exact [x, y] / [x, y, z] tuples
looseVec2(desc) / looseVec3(desc)     // typed Vec2/Vec3, any number[] at runtime
untypedArray(desc)                    // z.array(z.any()), no `items` advertised
tolerant(schema)                      // advertised, never rejects (schema.catch); run keeps fallback
toParamsSchema(schema): ParamsSchema; formatIssues(error: z.ZodError): string
export { z }                          // import z from './schema' (plugins: '@core/commands/schema')
```

## Execution context (`context.ts`)

```ts
interface ExecutionContext {
  readonly kernel: GeometryKernel | null;   // installed kernel (caches shapes by recipe key itself)
  readonly ids: IdSource;                   // mints every id the command creates
  readonly registry: CommandLookup;         // (name) => CommandDefinition | undefined
  readonly projectDepth: number;            // build_project nesting guard
  readonly recipeDepth: number;             // instantiate_recipe nesting guard
  readonly stepKey?: string;                // feature step currently running
  readonly replayCache: ReplayCache | null; // replay prefix cache; null disables
}
defaultContext(): ExecutionContext    // installed kernel + counter ids + getCommand + cache
currentContext(): ExecutionContext    // innermost running execute's ctx, else defaultContext()
runInContext<T>(ctx, fn: () => T): T
```

- Commands read the kernel from `ctx?.kernel` only; never `getGeometryKernel()` or a concrete
  kernel. A command that runs other commands uses `ctx.registry` / `execute(..., ctx)`.
- `setGeometryKernel(k)` (`@core/geometry/kernel`) is called ONLY by composition roots
  (`src/main.tsx`, `server/src/geometryKernel.ts`) and tests.

## Registry API (`registry.ts`)

```ts
listCommands(): ReadonlyArray<CommandDefinition<unknown>>   // core + installed plugins
getCommand(name: string): CommandDefinition<unknown> | undefined
execute(doc, commandName, params, ctx = currentContext()): CommandResult
toToolSchemas(): Array<{ name; description; input_schema: ParamsSchema;
                         annotations?: { readOnlyHint?; destructiveHint?; idempotentHint? } }>
```

`execute` pipeline (every command is wrapped by `guardCommand` at registration):
1. Unknown name ⇒ `{ document: doc, summary: 'Unknown command: X', affected: [] }`.
2. `requiresKernel` && `ctx.kernel === null` ⇒ no-op, "geometry kernel not available" summary.
3. Non-object params ⇒ `{}`; 2-number `position` padded to `[x, y, 0]`; prototype-key ids rejected.
4. `paramsValidator.safeParse` fails ⇒ no-op, `<name> rejected: invalid params — <path>: <msg> (got …)`.
5. `run` throws ⇒ no-op, `<name> failed: <reason>; document unchanged.`
6. Derivation guards (plugin `guards`) / corrupt entities (NaN, bad position) ⇒ no-op rejection.
7. Mutating (not `readOnly`/`metaHistory`, not nested in a step) and doc changed ⇒ append
   `FeatureStep { id: 'step-<n>', name, params, suppressed: false, affected }`, bump `nextStepNumber`.

Registration: core — import the const into `registry.ts` and append to `rawDefinitions`.
Domain — add it to the plugin's `commands` (`packages/domain-aec/src/index.ts` lists feed
`buildingPlugin` / `industrialPlugin` in `plugin.ts`); `installPlugin` appends them (name clash
throws). `toToolSchemas()` length MUST equal `listCommands()` length (test-guarded), and its
output is snapshotted (`tests/unit/contract/__snapshots__`).

## Plugins (`plugins/plugin.ts`, `plugins/host.ts`)

```ts
interface CadPlugin {
  readonly name: string; readonly toolset: string;
  readonly commands: ReadonlyArray<CommandDefinition<unknown>>;
  readonly guards?: ReadonlyArray<DerivationGuard>;   // commands/derivation.ts
  readonly document?: DocumentExtension;               // validate / derivedEntityIds / restore
}
installPlugin(plugin): void   // idempotent per name; src/app/plugins.ts installDefaultPlugins()
installedPlugins(); onPluginInstalled(listener); pluginGuards(); documentExtensions();
pluginToolNames(toolset): string[]
interface DerivationGuard { readonly domain: string; check(previous, next): string | null }
```

## Purity helper pattern (`entityOps.ts`, `commitEntity.ts`)

```ts
function withEntity(doc: CadDocument, entity: Entity): CadDocument {
  return { ...doc, entities: { ...doc.entities, [entity.id]: entity }, order: [...doc.order, entity.id] };
}
// The usual create-command tail: append one entity and report it as the created id.
function commitEntity(doc: CadDocument, entity: Entity, summary: string): CommandResult;
```

Commands to imitate: `add_box` (`geometryBasic.ts`), `set_units` (`units.ts`),
`extrude_sketch` / `revolve_profile` (`profile.ts`), `boolean_subtract` (`boolean.ts`, kernel),
`measure_distance` (`measureDistanceAngle.ts`, query), a building command in `packages/domain-aec/src`.

- Create: build entity with `nextId(prefix)` from `@lib/id` (scoped to the step's id source),
  `layerId: DEFAULT_LAYER_ID`.
- Mutate-in-place semantics: clone the target with a spread, return new `entities` map.
- Delete: clone map, `delete`, also filter `order` and `selection`.
- Missing-id ⇒ return input doc unchanged, `affected: []`, descriptive `summary`.
- Query: `annotations: { readOnly: true }`, same doc reference, `affected: []`, value in `data`.

## IDs (`@lib/id`)

```ts
interface IdSource { next(prefix: string): string }
nextId(prefix = 'e'): string            // mints from the active source (the running step's)
stepIdSource(stepKey): IdSource         // `${prefix}-${stepKey}.${k}` — replay re-mints identical ids
counterIdSource: IdSource               // outside a step: `${prefix}-${base36 time}-${base36 counter}`
withIdSource(source, fn); stepKeyOf('step-12') === '12'
uniqueId(prefix): string                // NOT replay-stable; only cross-document identities (IFC salt)
```

No id-counter reset exists; tests rely on step-scoped determinism.

## History & regeneration

- `replayHistory(base, history, getCommand, warnings?, onStep?)` (`history.ts`): replays live steps
  from an empty doc keeping document-level state; reuses `ctx.replayCache` prefixes
  (`replayCache.ts`); refuses when a live step `requiresKernel` and no kernel is installed.
- `set_parameter` / `delete_parameter` (`metaHistory`) → `regenerateParameterDependents`
  (`dependents.ts`): replays only when a step's `=expr` params read a changed parameter.

## How the surfaces consume this (do not bypass)

- UI: `store.dispatch(name, params)` → online `POST /command` (server `execute`, result arrives on
  `/live`) or offline local `execute` + outbox → swap doc → undo snapshot.
- MCP host (`packages/mcp` + `server`): `buildMcpTools()` from `toToolSchemas()`, filtered by
  toolset; a call runs `execute` on the shared live document and broadcasts a `command` event.
