# Contributing

## Workflow

1. Branch from `main`: `feat/<short-name>` or `fix/<short-name>`.
2. Write the command/feature **with a test** in the same change.
3. Run `npm run check` (typecheck + lint + format check + test). It must pass. If you
   touched `server/` or the MCP layer, also run `npm --prefix server test`.
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
- **Small files.** At most 500 lines of code per file (ESLint `max-lines`); split by concern.
- **Files are kebab or camel per folder convention already present.** Match the
  neighbours.

### Naming

- Command ids are `snake_case` (`add_box`) because they double as AI/MCP tool
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

- [ ] Feature works in the running app (`npm run dev`).
- [ ] New command (if any) has a test and appears in the registry.
- [ ] `npm run check` is green.
- [ ] Docs updated if behaviour or architecture changed.
