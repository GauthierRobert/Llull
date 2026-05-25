# RULE: workflow

## W1 — The loop (every change)

1. Locate the layer (see architecture.md decision shortcuts).
2. Write the change **and its test in the same change**. No code without a test for
   `core/` logic.
3. `npm run check` (typecheck + lint + test) → must be green.
4. For viewport/UI work, verify in the running app (`npm run dev`) — the
   `verify-llull` skill can drive it with Playwright.

## W2 — Branch & commit

- Branch from `main`: `feat/<short>` or `fix/<short>`.
- Conventional Commits, scoped:
  ```
  feat(commands): add fillet_edge command
  fix(viewport): correct orbit polar clamp
  test(commands): cover delete on missing id
  docs(architecture): clarify dependency direction
  chore(claude): tune enforce-architecture hook
  ```
- Keep PRs small and single-purpose. Commit/push only when the user asks.
- This repo is not yet git-initialized; `git init` before the first commit if asked.

## W3 — Testing strategy

- `tests/unit/` — command layer, heavy coverage (the 90/85/90/90 gate lives here).
  Pure functions ⇒ exhaustive and fast.
- `tests/integration/` — `store.dispatch` end-to-end (command → store → undo).
- Component tests (Testing Library) — panels & param-gathering, NOT geometry math.
- Determinism: call `__resetIdCounter()` in `beforeEach` so ids are stable.
- Assert behavior the user/AI observes (entity created, `affected` ids, `summary`),
  not internal structure.

## W4 — Definition of done

- [ ] Works in `npm run dev` (for user-facing changes).
- [ ] New command is registered in `registry.ts` and has happy + failure-path tests.
- [ ] `toToolSchemas()` still maps 1:1 to `listCommands()` (a test guards this).
- [ ] `npm run check` green; coverage gate satisfied.
- [ ] Docs updated **only if** behavior/architecture changed (docs are the human layer).

## W5 — Delegation

- Default to multi-agent. Match the task to an agent (see CLAUDE.md table).
- Launch independent agents in parallel; serialize only on real dependencies.
- Always finish with `cad-reviewer` on a non-trivial diff before declaring done.

## W6 — When unsure

- Re-read the relevant `@.claude/rules/*` and `.claude/context/*` before guessing.
- If a change seems to require breaking an architecture law, STOP and surface the
  tension to the user — do not work around the command layer.
