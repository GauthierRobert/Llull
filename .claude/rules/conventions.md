# RULE: conventions (machine-first code style)

Source is optimized for **AI parsing and local reasoning**: explicit types, self-describing names,
small files, discovery by name/path over prose. Command skeleton + tags: `rules/commands.md`.

## C1 — Types are the documentation

- TS strict; `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` ON.
- NO `any` (use `unknown` + narrowing). NO non-null `!` except in tests. (`any` is hook-blocked.)
- Explicit return types on exported functions. Model facts as unions/literals, not comments.

## C2 — Comments

Structured tags on commands (`@command @pure @layer @affects @invariant @failure`), not narration.
If a comment restates the code, delete it. Prose belongs in `docs/` (the human layer).

## C3 — Naming

- Command / MCP tool `name`: `snake_case` (`add_box`, `draw_line`, `extrude_profile`); 2D commands
  read as drafting verbs. Exported definition const: `camelCase` (`addBox`).
- Components `PascalCase`; hooks `useThing`; types `PascalCase`, no `I` prefix.
- Params: one inline zod `z.object(...)` per command; TS type inferred. No `<Command>Params`.
- Literal, full words: `selectedEntityIds` > `sel`.

## C4 — Imports & paths

Aliases, never deep relatives across packages: `@core/*` `@lib/*` `@mcp/*` `@aec/*`
`@kernel-manifold/*` `@kernel-occt/*` `@ui/*` `@app/*`. Inside `packages/core/src` use relative
imports. `tsconfig.json` paths, `vite.config.ts` alias and `server/` config stay in sync.

## C5 — Formatting

Prettier: semicolons, single quotes, trailing commas `all`, printWidth 100, tabWidth 2. A
PostToolUse hook formats each edited file; never hand-format or fight it.

## C6 — Files & design

- One concern per file (SRP). Group commands by domain; split by concern when it grows; import
  from defining files — no re-export barrels (package `index.ts` excepted).
- Max **500 code lines** per file (ESLint `max-lines`, no allowlist; disabling it is hook-blocked).
- Open/closed: add a capability with a NEW command file + registration, a new domain with a new
  `CadPlugin`, a new entity kind with a union member + render branch (`add-entity-kind` skill) —
  not by growing a `switch` in every caller.
- Depend on narrow injected ports (`ctx.kernel`, `ctx.ids`, `ctx.registry`), never concretions.
- No dead code, unused exports, or `console.log` (`console.warn`/`error` allowed).
- Minimal, uniform diffs: smallest change that does the job, matching surrounding style.
