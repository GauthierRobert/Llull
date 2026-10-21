# How to add a tool

In llull a "tool" is a **command**: one `defineCommand({ name, description, params, run })` in the registry. Adding one gives
the desktop app an action and the `llull` CLI a tool (drivable by Claude Code or any script) at once — no CLI or UI wiring.

The short version:

1. **Write the command** — pure (returns a new document, never mutates the input), one zod `params` schema with a
   `.describe(...)` on every field (agents read it with `llull describe`), `snake_case` name. Core operations live in a feature
   folder of `packages/core/src/commands/`; domain operations (building, analysis, aero, PLM, …) live in their plugin package,
   never in core. Exact-geometry commands read the kernel from `ctx.kernel`.
2. **Register it** — list it in its folder's `catalog.ts` (core: also one toolset in `packages/protocol/src/toolsets.ts`;
   plugin: its catalog joins the plugin's toolset). `registry.ts` is never edited.
3. **Test it** — happy path, failure path, purity; review the tool-schema snapshot diff (`npx vitest run tests/unit/contract -u`):
   it is exactly what agents will read.
4. **(Optional) UI** — a dedicated panel in `src/ui/panels` only when a generic action is not enough.

Then `llull search <words>` finds it, `llull describe <name>` prints its schema and `llull exec <name> …` (or a plan step) runs it.

Where the details live:

- Step-by-step procedure: `.claude/skills/add-command/SKILL.md`
- Skeleton to copy and exact signatures: `.claude/context/command-layer.md`
- The laws a command must satisfy: `.claude/rules/commands.md` and `.claude/rules/architecture.md`
