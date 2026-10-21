---
name: add-command
description: Add a new CAD operation to llull. Use whenever a task means a new way to change the document — "add a cylinder/boolean/array tool", "let the AI rotate things", "support filleting". One command added to the registry instantly becomes a UI button and a CLI tool (drivable by Claude Code or any script through `llull`). Covers the command definition, registration, tests, and optional UI surfacing.
---

# Skill: add-command

Adding a command is the highest-leverage change in llull: define once → UI + CLI
both gain it (the CLI being how Claude Code or any script drives llull). Delegate the implementation
to the `command-author` agent unless the change is trivial.

## References
- Skeleton to copy + signatures: `.claude/context/command-layer.md` · Laws: `.claude/rules/commands.md`
- Schema: `.claude/context/model.md` · Plugins: `.claude/rules/commands.md` (Plugins)

## Steps

### 0. Pick the home
- CAD core op (geometry, 2D, transform, measure, parametric, assembly…) ⇒ its feature folder
  `packages/core/src/commands/<feature>/` (new file if the concern is new or the file nears 500 code lines).
- Domain op ⇒ that plugin's package: `packages/domain-aec/src/…` (building, industrial, civil, piping, scan),
  `domain-cae` (analysis), `domain-aero` (aerodynamics, surfacing, sheetmetal, composites, fasteners, fluids, cfd), `domain-dynamics` (rigid-body dynamics),
  `design-lang`, `plm`. Never put domain commands in `packages/core`.

### 1. Define (pure) with `defineCommand`
Copy the skeleton in `.claude/context/command-layer.md` (Command skeleton).
- Import `defineCommand, z, vec2, vec3, looseVec3, untypedArray, tolerant` from `./schema`
  (plugins: `@core/commands/schema`). Every property `.describe(...)`d; optional ⇒ `.optional()`.
- No `<X>Params` interface, no `paramsSchema` literal — both are derived from `params`.
- `execute` rejects schema-invalid params for you. `run` still checks semantics → unchanged doc,
  `affected: []`, explanatory summary. Never throw, never mutate.
- Ids: `nextId(prefix)` from `@lib/id` (step-scoped automatically). Kernel: `ctx?.kernel` only,
  plus `annotations: { requiresKernel: true }` — or kernel-optional (architecture L9: exact path with a
  kernel, clean fallback without, both tested). Queries: `annotations: { readOnly: true }`, value in `data`.
- Structured doc-comment tags (`@affects @invariant @failure` only).

### 2. New geometry? (only if needed)
For 3D: add the literal to `SOLID_KINDS`. For 2D: add it to `SHAPE2D_KINDS` (the
`SolidKind` / `Shape2DKind` unions derive from these arrays; see
`.claude/context/model.md`, and the `draw-2d` skill for drafting specifics). Either way:
add the `*Entity` interface to `packages/core/src/model/types.ts`, add it to the `Entity`
union, and note that the viewport needs a matching render branch (hand to `viewport-engineer`).

### 3. Register
- Core: define it in its feature folder (`packages/core/src/commands/<feature>/`) and list the
  const in that folder's `catalog.ts` (never `registry.ts`), then list its name in exactly one toolset in `packages/protocol/src/toolsets.ts`
  (`core` only if every agent needs it up front; a test asserts one toolset per tool).
- Plugin: list it in its domain's `catalog.ts` (e.g. `packages/domain-aec/src/<building|industrial|civil>/catalog.ts`,
  `packages/plm/src/catalog.ts`; consumed by that domain's `plugin.ts`); it joins the plugin's `toolset` automatically
  (`pluginToolNames`).
That is the entire AI + CLI wiring — `toToolSchemas()` exposes it automatically.

### 4. Test (same change)
`tests/unit/<domain>.test.ts` (plugin commands: the plugin's folder under `tests/unit/`, e.g. `tests/unit/building/`): happy path (assert `affected`,
entity `kind`/props, `document.order`) + failure path (missing id / invalid input ⇒ no-op,
incl. a schema-rejected param). Purity check. No id reset (ids are step-scoped and deterministic).
Then update the tool-schema snapshot (`npx vitest run tests/unit/contract -u`) and review the
diff; add a golden plan to `tests/golden/plans.ts` if the command is a new modelling primitive.

### 5. (Optional) UI
Most tools need no bespoke button — a generic toolbar can iterate `listCommands()`.
Add a panel in `src/ui/panels` only for a richer affordance (gizmo, form).

### 6. Verify
`npm run check` green; `npm run test:coverage` gate (90/85/90/90, scope in CLAUDE.md non-negotiable 3) holds.

## Done checklist
- [ ] Pure `defineCommand`, registered (core or plugin), snake_case name
- [ ] Happy + failure tests, purity asserted; schema snapshot reviewed
- [ ] `toToolSchemas()` 1:1 with `listCommands()`
- [ ] `npm run check` green
