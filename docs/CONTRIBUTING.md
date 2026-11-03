# Contributing

## Workflow

1. Branch from `main`: `feat/<short-name>` or `fix/<short-name>`.
2. Write the command/feature **with a test** in the same change.
3. Run `npm run check` (typecheck + arch + deadcode + lint + format check + native check + test). It must pass. If you
   touched `server/` or the CLI layer (`packages/protocol`, `server/src/cli`), also run `npm --prefix server test`.
4. Open a PR. Keep it small and focused.

## Conventions

### Code

- **TypeScript strict mode is on.** No `any`. Use `unknown` + narrowing.
- **`packages/*` are framework-agnostic.** No `import ... from 'react'`, no `fetch`,
  `window`, or `document` — those live in `src/ui/`, `server/`, or behind an injected
  interface. `packages/core` imports no other package; domains are plugins.
- **Commands are pure.** Return a new document; never mutate the argument.
  There is a test that enforces this (`is pure` in `commands.test.ts`).
- **One schema per command.** Declare commands with `defineCommand` and a zod `params`
  object; never hand-write a `paramsSchema` or a separate params interface.
- **Small files.** At most 500 lines of code per file (oxlint `max-lines`); split by concern.
- **Files are kebab or camel per folder convention already present.** Match the
  neighbours.

### Naming

- Command ids are `snake_case` (`add_box`) because they double as `llull` CLI tool
  names, where snake_case is the norm.
- React components are `PascalCase`. Hooks are `useThing`.
- Types/interfaces are `PascalCase`; no `I` prefix.

### Commits

Conventional Commits:

```
feat(commands): add fillet_edge command
fix(viewport): correct orbit polar clamp
test(commands): cover delete on missing id
docs(architecture): clarify dependency direction
```

### Tests

- Co-locate intent: command tests in `tests/unit` (plugins: `tests/unit/building`),
  contract tests in `tests/unit/contract`, store/flow tests in `tests/integration`.
- The golden corpus (`tests/golden`) snapshots whole documents built by `build_project`
  plans. Update a snapshot only for an intended behaviour change, and say so in the PR.
- Prefer behavioural assertions (what the user/AI observes) over implementation
  details.
- Ids are deterministic per document (step-scoped `<prefix>-<step>.<k>`); no reset is needed.

## Definition of done

- [ ] Feature works in the desktop app (`npm --prefix desktop start`, or `llull --app` + `render_view`).
- [ ] New command (if any) has a test and appears in the registry.
- [ ] `npm run check` is green.
- [ ] Docs updated if behaviour or architecture changed.

## Licensing of contributions

llull is licensed under GPL-3.0-or-later ([`LICENSE`](../LICENSE), [LIC1](decisions/LIC1-license.md)). The copyright holder
also offers llull under separate commercial terms, so every contribution needs this grant. By submitting a contribution (a
pull request, patch or any other change) you agree that:

1. You wrote it, or otherwise have the right to submit it under these terms.
2. It is licensed under GPL-3.0-or-later.
3. You grant the copyright holder of llull (Gauthier Robert) a perpetual, worldwide, non-exclusive, royalty-free, irrevocable
   licence to use, modify, sublicense and distribute your contribution under any terms, including commercial licences, plus a
   licence to any of your patents the contribution necessarily infringes.
4. You keep your copyright and may use your own contribution however you like.

Add `Signed-off-by: Your Name <email>` to each commit (`git commit -s`) to confirm.
