# Contributing

## Workflow

1. Branch from `main`: `feat/<short-name>` or `fix/<short-name>`.
2. Write the command/feature **with a test** in the same change.
3. Run `npm run check` (typecheck + lint + test). It must pass.
4. Open a PR. Keep it small and focused.

## Conventions

### Code

- **TypeScript strict mode is on.** No `any`. Use `unknown` + narrowing.
- **`core/` is framework-agnostic.** No `import ... from 'react'` in `core/`.
  No `fetch`, `window`, or `document` either — those live in `ui/` or behind an
  injected interface.
- **Commands are pure.** Return a new document; never mutate the argument.
  There is a test that enforces this (`is pure` in `commands.test.ts`).
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

- Co-locate intent: command tests in `tests/unit`, store/flow tests in
  `tests/integration`.
- Prefer behavioural assertions (what the user/AI observes) over implementation
  details.
- Reset ids with `__resetIdCounter()` in `beforeEach` for deterministic output.

## Definition of done

- [ ] Feature works in the running app (`npm run dev`).
- [ ] New command (if any) has a test and appears in the registry.
- [ ] `npm run check` is green.
- [ ] Docs updated if behaviour or architecture changed.
