# RULE: workflow

## W1 — The loop (every change)

1. Locate the layer (see architecture.md decision shortcuts).
2. Write the change **and its test in the same change**. No code without a test for
   `packages/*` logic.
3. `npm run check` (typecheck + lint + format:check + test) → must be green.
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

## W3 — Testing strategy

- `tests/unit/` — command layer + plugins (`tests/unit/building/**`), heavy coverage. The
  90/85/90/90 gate covers `packages/core/src/commands/**` and `packages/domain-aec/src/**`.
  Pure functions ⇒ exhaustive and fast.
- `tests/unit/contract/` — cross-cutting contracts: zod schema derivation + conformance,
  `toToolSchemas()` snapshot (`__snapshots__`; review every diff — agents read these texts),
  ExecutionContext, plugins, derivation guards, partition, persistence v2, live sync, regeneration.
- `tests/golden/` — golden corpus: `build_project` plans (`plans.ts`) run from an empty doc,
  id-normalized document snapshots (`__snapshots__/<plan>.json`) + `replay_history` reproduces
  them; `golden.kernel.test.ts` covers kernel-dependent plans. A behaviour change shows up here —
  update a snapshot only when the change is intended. Add a plan for every regression found.
- `tests/integration/` — `store.dispatch` end-to-end (command → store → undo, live sync, outbox).
- `tests/component/` (Testing Library) — panels & param-gathering, NOT geometry math.
- `tests/e2e/` (Playwright, `npm run test:e2e`) and `server/tests/` (`npm --prefix server test`).
- `tests/setup.ts` installs the default plugins — every test sees the full registry.
- Determinism: ids are step-scoped (`<prefix>-<step>.<k>`) and deterministic per document; no
  id-counter reset exists or is needed. Don't assert on `Date.now()`-derived values.
- Assert behavior the user/AI observes (entity created, `affected` ids, `summary`),
  not internal structure.

## W4 — Definition of done

- [ ] Works in `npm run dev` (for user-facing changes).
- [ ] New command is registered (core `registry.ts` or its plugin's `commands`) and has
      happy + failure-path tests; golden corpus green.
- [ ] `toToolSchemas()` still maps 1:1 to `listCommands()` (a test guards this).
- [ ] `npm run check` green; coverage gate satisfied.
- [ ] Docs updated **only if** behavior/architecture changed (docs are the human layer).

## W5 — Delegation

- Default to multi-agent. Match the task to an agent (see CLAUDE.md table).
- Launch independent agents in parallel; serialize only on real dependencies.
- Lanes own disjoint write scopes (`.claude/work/BOARD.md` lane table is the ledger):

  | Lane | Agent | Owns |
  | ---- | ----- | ---- |
  | 1 Core | `command-author` | `packages/core/src/**` (incl. `commands/registry.ts`, `model/types.ts`), `packages/domain-aec/src/**`, `packages/kernel-*/src/**` |
  | 2 3D+Shell | `viewport-engineer` | `src/ui/viewport/3d/**`, `src/ui/components/**`, `src/ui/panels/**`, `src/ui/store/**`, `src/app/**` |
  | 3 2D | `viewport-engineer` | `src/ui/viewport/2d/**`, snapping/tracking helpers |
  | 4 MCP | `mcp-engineer` | `packages/mcp/src/**`, `server/**` |
  | 5 Review | `test-verifier` + `cad-reviewer` | `tests/**`; reviews every diff |

  `registry.ts` is Lane-1-only; a domain plugin's command list is owned by the lane editing that plugin.
- Always finish with `cad-reviewer` on a non-trivial diff before declaring done.

## W6 — When unsure

- Re-read the relevant `@.claude/rules/*` and `.claude/context/*` before guessing.
- If a change seems to require breaking an architecture law, STOP and surface the
  tension to the user — do not work around the command layer.
