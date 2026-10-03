# RULE: conventions (machine-first code style)

llull optimizes source for **AI parsing efficiency**, not prose readability. Code
should be unambiguous to a model on first read: explicit types, self-describing
names, structured doc-comments over narrative ones, discovery over documentation.

## C1 — Types are the documentation

- TS strict; `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` are ON.
- NO `any`. Use `unknown` + narrowing. NO non-null `!` except in tests.
- Explicit return types on exported functions (eslint warns otherwise).
- Model facts in the type system, not in comments. A precise type removes the need
  for a sentence. Prefer unions/literals over loose `string`.

## C2 — Structured doc-comments (the tag vocabulary)

Comment to encode machine-checkable facts, not to narrate. Use these tags:

```ts
/**
 * @command add_box                  // the snake_case registry/tool name
 * @pure                             // returns new doc, never mutates input
 * @layer core/commands              // which layer this belongs to
 * @affects creates 1 box entity     // what the result.affected contains
 * @invariant size components > 0    // preconditions / guarantees
 * @failure missing id -> no-op, affected:[]   // documented failure mode
 */
```

Omit tags that don't apply. Do NOT write paragraph explanations of obvious code.
If a comment restates the code, delete it. Reserve prose for the `docs/` folder
(the human layer) — keep it out of source.

## C3 — Naming

- Command / tool `name`: `snake_case` (`add_box`, `extrude_profile`) — it is the
  AI & MCP tool id; snake_case is the cross-agent norm.
- 2D drafting commands read as drafting verbs (`draw_line`, `draw_polyline`,
  `draw_arc`, `add_dimension`); 3D as `add_box`, `extrude_profile`. All snake_case.
- Exported command definition const: `camelCase` (`addBox`, `extrudeProfile`).
- React components: `PascalCase`. Hooks: `useThing`. Types/interfaces: `PascalCase`,
  no `I` prefix.
- Params: one zod `z.object(...)` per command, inline in `defineCommand`; the TS type is
  inferred (`z.output`). No hand-written `<Command>Params` interface.
- Be literal and full-word. `selectedEntityIds` > `sel`. Tokens are cheap; ambiguity is not.

## C4 — Imports & paths

Use path aliases, never deep relatives across packages/layers:

| Alias | Path |
| ----- | ---- |
| `@core/*` | `packages/core/src/*` |
| `@lib/*` | `packages/core/src/lib/*` |
| `@mcp/*` | `packages/mcp/src/*` |
| `@aec/*` | `packages/domain-aec/src/*` |
| `@kernel-manifold/*` | `packages/kernel-manifold/src/*` |
| `@kernel-occt/*` | `packages/kernel-occt/src/*` |
| `@ui/*` | `src/ui/*` |
| `@app/*` | `src/app/*` |

Inside `packages/core/src` use relative imports (it imports no other package).
(`tsconfig.json` paths + `vite.config.ts` alias + `server/` config must stay in sync.)

## C5 — Command shape (copy this skeleton)

```ts
import type { CommandResult } from './types';
import { defineCommand, z, vec3 } from './schema';   // plugins: '@core/commands/schema'

export const fooThing = defineCommand({
  name: 'foo_thing',
  description: 'One line, imperative, says what the op does to the document.',
  annotations: { idempotent: true },                 // optional: readOnly / destructive /
                                                     // idempotent / metaHistory / requiresKernel
  params: z.object({
    id: z.string().describe('Target entity id'),
    amount: z.number().describe('How much, in document units; must be > 0'),
    offset: vec3('Optional [x, y, z] offset. Defaults to [0, 0, 0].').optional(),
  }),
  run: (doc, { id, amount, offset = [0, 0, 0] }, ctx): CommandResult => {
    const target = doc.entities[id];
    if (!target) return { document: doc, summary: `No entity ${id}.`, affected: [] };
    // build NEW doc; ids via nextId(prefix) from @lib/id; kernel via ctx?.kernel
    // return { document, summary, affected }
  },
});
```

Schema helpers (`@core/commands/schema`): `vec2` / `vec3` (exact-length tuples),
`looseVec2` / `looseVec3` (any number array at runtime; `run` checks length), `untypedArray`
(no `items` advertised; `run` validates), `tolerant(schema)` (advertised, never rejected; `run`
keeps its fallback). Every property needs `.describe(...)` — `defineCommand` throws without it.

Rules for `run`:
- `execute` already rejected schema-invalid params (`<name> rejected: invalid params — <path>: …`).
  Still validate semantics (ids exist, sizes > 0); on bad input return the **unchanged doc**
  with an explanatory `summary` and `affected: []` (graceful no-op, never throw for user error).
- `summary` is read by humans AND fed back to the AI — make it specific and factual
  (include ids, sizes, counts). It is the AI's feedback signal.
- `.describe()` texts become the MCP `paramsSchema` — write them for an agent that cannot
  see the code. A change to them shows up in the tool-schema snapshot test; review the diff.

## C6 — Formatting (Prettier-enforced, do not fight it)

semicolons, single quotes, trailing commas (`all`), printWidth 100, tabWidth 2.
Run `npm run format`. Never hand-format.

## C7 — File organization

- One concern per file. Group commands by domain (`boolean.ts`, `transform.ts`); split a domain
  by concern when it grows (`geometryBasic.ts`, `geometryRound.ts`, …) and import from the split
  files directly — no re-export barrel modules (package entry `index.ts` files excepted). Core commands register in `registry.ts`; domain commands in their
  plugin's `commands` list (`packages/domain-aec/src/index.ts` → `plugin.ts`).
- Max **500 code lines** per file (blank/comment lines excluded) — ESLint `max-lines` error on
  `src/**`, `packages/*/src/**`, `server/src/**`, no allowlist. Split by concern; never disable it.
- No `console.log` in committed code (eslint warns; `console.warn`/`error` allowed).
  A PostToolUse hook reminds you.
