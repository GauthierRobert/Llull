# RULE: conventions (machine-first code style)

Source is optimized for **AI parsing and local reasoning**: explicit types, self-describing names,
small files, discovery by name/path over prose. Command skeleton + tags: `rules/commands.md`.

## C1 — Types are the documentation

- TS strict; `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` ON.
- NO `any` (use `unknown` + narrowing). NO non-null `!` except in tests. (`any` is hook-blocked.)
- Explicit return types on exported functions. Model facts as unions/literals, not comments.

## C2 — Comments

Structured tags on commands (`@affects @invariant @failure` (path = layer, name = command; all commands are pure)), not narration.
If a comment restates the code, delete it. Prose belongs in `docs/` (the human layer).

## C3 — Naming

- Command / MCP tool `name`: `snake_case` (`add_box`, `draw_polyline`, `extrude_profile`); 2D commands
  read as drafting verbs. Exported definition const: `camelCase` (`addBox`).
- Components `PascalCase`; hooks `useThing`; types `PascalCase`, no `I` prefix.
- Params: one inline zod `z.object(...)` per command; TS type inferred. No `<Command>Params`.
- Literal, full words: `selectedEntityIds` > `sel`.

## C4 — Imports & paths

Aliases, never deep relatives across packages: `@core/*` `@lib/*` `@mcp/*` `@aec/*`
`@kernel-manifold/*` `@kernel-occt/*` `@ui/*` `@app/*`. Inside `packages/core/src` use relative
imports. Aliases are defined once, in `tsconfig.base.json` (extended by `tsconfig.json` and
`server/tsconfig.json`; Vite/Vitest read it through `workspaceAliases.ts`) — add a package there only.

## C5 — Formatting

Prettier: semicolons, single quotes, trailing commas `all`, printWidth 140, objectWrap collapse, tabWidth 2. A
PostToolUse hook formats each edited file; never hand-format or fight it.

## C6 — Files & design

- One concern per file (SRP). Group commands by domain; split by concern when it grows; import
  from defining files — no re-export barrels (package `index.ts` excepted).
- Max **500 code lines** per file (ESLint `max-lines`, no allowlist; disabling it is hook-blocked).
- Open/closed: add a capability with a NEW command file + registration, a new domain with a new
  `CadPlugin`, a new entity kind with a union member + render branch (`add-entity-kind` skill) —
  not by growing a `switch` in every caller.
- Depend on narrow injected ports (`ctx.kernel`, `ctx.ids`, `ctx.registry`), never concretions.
- No dead code, unused exports (`npm run deadcode`, knip), or `console.log` (`console.warn`/`error`
  allowed). Export only what another module imports.
- Minimal, uniform diffs: smallest change that does the job, matching surrounding style.

## C7 — Best-suited stack (owner rule 2026-10-18)

- The stack is **not fixed**. For every task use the language, library or tool best suited to it (performance,
  quality, maintenance), e.g. Rust + wgpu for GPU solvers, native code for heavy numerics. No owner approval is
  needed to add one; record the choice and why in the task's spec or `docs/decisions/`.
- The architecture laws still hold: non-TS code lives in its own workspace (e.g. `solver/<name>/`) or behind an
  injected port / host transport (L2, L6, L9), is bundled for offline desktop use (AF-41), and ships with its
  own tests in `npm run check` or a documented gate.
- Prefer what the repo already uses when it is as good; do not switch a working part only to change technology.
