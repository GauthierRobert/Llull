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

## A plugin that stores data in the document (a document slice)

A plugin whose commands keep data in the document declares a `DocumentExtension` (`packages/core/src/plugins/plugin.ts`) whose
`validate(raw)` runs on every load, on data that may be hand-edited or corrupt. **New plugin slices declare a zod schema** and return
`sliceSchemaErrors(schema, raw.<slice>, '<dotted.root>')` (`@core/plugins/sliceSchema`): every issue becomes `<root>.<path inside the slice>:
<what is wrong>`, never throws, and rejects NaN / Infinity. Write only the checks a schema cannot express (a map key equals its record's `id`,
references resolve, ids are unique) as a small function next to it, tolerant of a malformed shape. Do not hand-write `typeof` / `isRecord`
ladders (example: `packages/domain-aec/src/plant/fabrication/validate.ts`).

`tests/unit/contract/pluginSliceFuzz.test.ts` mutates every installed plugin's slice (deleted keys, swapped types, huge / negative numbers,
reserved keys, duplicate ids, dangling references) through `load_document` and fails when a load throws, is refused without a validation
summary, or does not re-save to the same text. It also fails by name for a plugin with a `document` extension and no seed: add one row to
`tests/helpers/pluginSliceSeeds.ts` (a valid document built through real commands, the slice paths, a query and a mutating command).

Where the details live:

- Step-by-step procedure: `.claude/skills/add-command/SKILL.md`
- Skeleton to copy and exact signatures: `.claude/context/command-layer.md`
- The laws a command must satisfy: `.claude/rules/commands.md` and `.claude/rules/architecture.md`
