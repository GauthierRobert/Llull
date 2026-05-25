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
- Schema: `.claude/context/model.md` · Prose recipe: `docs/ADD_A_TOOL.md`

## Steps

### 1. Define (pure)
In `src/core/commands/geometry.ts` (or a new domain file like `transform.ts`,
`boolean.ts`), add a `CommandDefinition<P>`:
- `name`: snake_case tool id (`array_grid`, `rotate_entity`).
- `description`: one imperative line; written for an agent that can't see the code.
- `paramsSchema`: every property has a clear `description`; list `required`.
- `run`: validate → return a NEW doc + factual `summary` + `affected` ids. Missing/bad
  input ⇒ unchanged doc, `affected: []`, explanatory summary. Never throw, never mutate.
Add structured doc-comment tags (`@command @pure @affects @invariant @failure`).

### 2. New geometry? (only if needed)
For 3D: extend `SolidKind`. For 2D: extend `Shape2DKind` + update `is2D` (see
`.claude/context/model.md`, and the `draw-2d` skill for drafting specifics). Either way:
add the `*Entity` interface, add it to the `Entity`/`EntityKind` union, and note that
the viewport needs a matching render branch (hand to `viewport-engineer`).

### 3. Register
Import the const into `src/core/commands/registry.ts` and append to `definitions`.
That is the entire AI + MCP wiring — `toToolSchemas()` exposes it automatically.

### 4. Test (same change)
In `tests/unit/commands.test.ts`: happy path (assert `affected`, entity `kind`/props,
`document.order`) + failure path (missing id / invalid input ⇒ no-op). Purity check.
`__resetIdCounter()` in `beforeEach`.

### 5. (Optional) UI
Most tools need no bespoke button — a generic toolbar can iterate `listCommands()`.
Add a panel in `src/ui/panels` only for a richer affordance (gizmo, form).

### 6. Verify
`npm run check` green; `core/commands/**` coverage gate (90/85/90/90) holds.

## Done checklist
- [ ] Pure command, registered, snake_case name
- [ ] Happy + failure tests, purity asserted
- [ ] `toToolSchemas()` 1:1 with `listCommands()`
- [ ] `npm run check` green
