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
- Params interfaces: `<Command>Params` (`AddBoxParams`).
- Be literal and full-word. `selectedEntityIds` > `sel`. Tokens are cheap; ambiguity is not.

## C4 — Imports & paths

Use path aliases, never deep relatives across layers:
`@core/*` → `src/core/*`, `@ui/*` → `src/ui/*`, `@lib/*` → `src/lib/*`.
(`tsconfig.json` paths + `vite.config.ts` alias must stay in sync.)

## C5 — Command shape (copy this skeleton)

```ts
interface FooParams { id: string; amount: number; }

export const foo: CommandDefinition<FooParams> = {
  name: 'foo_thing',
  description: 'One line, imperative, says what the op does to the document.',
  paramsSchema: {
    type: 'object',
    properties: {
      id:     { type: 'string', description: 'Target entity id' },
      amount: { type: 'number', description: 'How much' },
    },
    required: ['id', 'amount'],
  },
  run: (doc, { id, amount }): CommandResult => {
    const target = doc.entities[id];
    if (!target) return { document: doc, summary: `No entity ${id}.`, affected: [] };
    // build NEW doc; return { document, summary, affected }
  },
};
```

Rules for `run`:
- Validate inputs; on bad input return the **unchanged doc** with an explanatory
  `summary` and `affected: []` (graceful no-op, never throw for user error).
- `summary` is read by humans AND fed back to the AI — make it specific and factual
  (include ids, sizes, counts). It is the AI's feedback signal.
- `paramsSchema` `description`s are what Claude/MCP agents see — write them for an
  agent that cannot see the code.

## C6 — Formatting (Prettier-enforced, do not fight it)

semicolons, single quotes, trailing commas (`all`), printWidth 100, tabWidth 2.
Run `npm run format`. Never hand-format.

## C7 — File organization

- One concern per file. Group commands by domain (`geometry.ts`, later `boolean.ts`,
  `transform.ts`). Re-export through `registry.ts`.
- No `console.log` in committed code (eslint warns; `console.warn`/`error` allowed).
  A PostToolUse hook reminds you.
