---
name: add-command
description: Add a new CAD operation to llull. Use whenever a task means a new way to change the document — "add a cylinder/boolean/array tool", "let the AI rotate things", "support filleting". One command added to the registry instantly becomes a UI button and an MCP tool (drivable by Claude or any MCP agent). Covers the command definition, registration, tests, and optional UI surfacing.
---

# Skill: add-command

Adding a command is the highest-leverage change in llull: define once → UI + MCP
both gain it (MCP being drivable by Claude or any agent). Delegate the implementation
to the `command-author` agent unless the change is trivial.

## References
- Skeleton & rules: `.claude/rules/conventions.md` (C5), `.claude/context/command-layer.md`
- Schema: `.claude/context/model.md` · Plugins: `.claude/rules/architecture.md` (L10)
- Prose recipe: `docs/ADD_A_TOOL.md`

## Steps

### 0. Pick the home
- CAD core op (geometry, 2D, transform, measure, parametric, assembly…) ⇒
  `packages/core/src/commands/<domain>.ts` (new file if the domain is new or the file nears
  500 code lines).
- Domain op (building, industrial, …) ⇒ that plugin's package (`packages/domain-aec/src/…`).
  Never put domain commands in `packages/core`.

### 1. Define (pure) with `defineCommand`
```ts
export const arrayGrid = defineCommand({
  name: 'array_grid',
  description: 'One imperative line, written for an agent that cannot see the code.',
  params: z.object({ id: z.string().describe('Source entity id'), /* … */ }),
  run: (doc, params, ctx): CommandResult => { /* … */ },
});
```
- Import `defineCommand, z, vec2, vec3, looseVec3, untypedArray, tolerant` from `./schema`
  (plugins: `@core/commands/schema`). Every property `.describe(...)`d; optional ⇒ `.optional()`.
- No `<X>Params` interface, no `paramsSchema` literal — both are derived from `params`.
- `execute` rejects schema-invalid params for you. `run` still checks semantics → unchanged doc,
  `affected: []`, explanatory summary. Never throw, never mutate.
- Ids: `nextId(prefix)` from `@lib/id` (step-scoped automatically). Kernel: `ctx?.kernel` only,
  plus `annotations: { requiresKernel: true }`. Queries: `annotations: { readOnly: true }`, value in `data`.
- Structured doc-comment tags (`@command @pure @affects @invariant @failure`).

### 2. New geometry? (only if needed)
For 3D: extend `SolidKind`. For 2D: extend `Shape2DKind` + `SHAPE2D_KINDS` (see
`.claude/context/model.md`, and the `draw-2d` skill for drafting specifics). Either way:
add the `*Entity` interface to `packages/core/src/model/types.ts`, add it to the `Entity`
union, and note that the viewport needs a matching render branch (hand to `viewport-engineer`).

### 3. Register
- Core: import the const into `packages/core/src/commands/registry.ts` and append to
  `rawDefinitions`, then list its name in exactly one toolset in `packages/mcp/src/toolsets.ts`
  (`core` only if every agent needs it up front; a test asserts one toolset per tool).
- Plugin: add it to the plugin's command list (`buildingCommands` / `industrialCommands` in
  `packages/domain-aec/src/index.ts`, consumed by `plugin.ts`); it joins the plugin's `toolset`
  automatically (`pluginToolNames`).
That is the entire AI + MCP wiring — `toToolSchemas()` exposes it automatically.

### 4. Test (same change)
`tests/unit/<domain>.test.ts` (plugins: `tests/unit/building/`): happy path (assert `affected`,
entity `kind`/props, `document.order`) + failure path (missing id / invalid input ⇒ no-op,
incl. a schema-rejected param). Purity check. No id reset (ids are step-scoped and deterministic).
Then update the tool-schema snapshot (`npx vitest run tests/unit/contract -u`) and review the
diff; add a golden plan to `tests/golden/plans.ts` if the command is a new modelling primitive.

### 5. (Optional) UI
Most tools need no bespoke button — a generic toolbar can iterate `listCommands()`.
Add a panel in `src/ui/panels` only for a richer affordance (gizmo, form).

### 6. Verify
`npm run check` green; coverage gate (90/85/90/90 on `packages/core/src/commands/**` and
`packages/domain-aec/src/**`) holds.

## Done checklist
- [ ] Pure `defineCommand`, registered (core or plugin), snake_case name
- [ ] Happy + failure tests, purity asserted; schema snapshot reviewed
- [ ] `toToolSchemas()` 1:1 with `listCommands()`
- [ ] `npm run check` green
