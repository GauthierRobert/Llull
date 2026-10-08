# RULE: workflow

## W1 — The loop (every change)

1. Locate the layer (architecture.md decision shortcuts).
2. Write the change **and its test in the same change** (`packages/*` logic always). A bug fix
   starts with a failing test or golden plan (`fix-bug` skill).
3. `npm run check` (typecheck + lint + format:check + test) → green. While iterating, run the
   slice: `npx vitest run <file>` or `npx vitest related --run <changed files>`.
4. Viewport/UI work: verify in the running app (`verify-llull` skill).

A Stop hook blocks once if `packages/*/src` changed without a test change, or a snapshot changed —
answer it (add the test, or state why none is needed / why the snapshot diff is intended).

## W2 — Branch & commit

- Branch `feat/<short>` or `fix/<short>` from `main` (unless a session branch is assigned).
- Conventional Commits, scoped: `feat(commands): add fillet_edge command`,
  `fix(viewport): …`, `test(commands): …`, `docs(architecture): …`, `chore(claude): …`.
- Small, single-purpose. Commit/push only when the user asks.

## W3 — Testing strategy

| Dir | Covers |
| --- | ------ |
| `tests/unit/` | command layer + plugins (`building/**`); coverage gate 90/85/90/90 |
| `tests/unit/contract/` | schema derivation, `toToolSchemas()` snapshot, ctx, plugins, guards, persistence, live sync |
| `tests/golden/` | `build_project` plans → id-normalized snapshots + replay equality; one plan per regression |
| `tests/integration/` | `store.dispatch` end-to-end (undo, live sync, outbox) |
| `tests/component/` | panels & param-gathering (Testing Library), never geometry math |
| `tests/e2e/`, `server/tests/` | Playwright (`npm run test:e2e`); server (`npm --prefix server test`) |

`tests/setup.ts` installs default plugins. Ids are deterministic per document; never assert on
`Date.now()`. Assert observed behavior (entities, `affected`, `summary`), not internals.

## W4 — Definition of done

- [ ] Works in `npm run dev` (user-facing changes).
- [ ] New command registered, happy + failure tests; golden corpus green.
- [ ] `npm run check` green; coverage gate satisfied.
- [ ] Docs updated **only if** behavior/architecture changed.
- [ ] Changed `.claude/`? `npm run claude:lint` green.

## W5 — Delegation (speed first)

Work in the main thread by default. Delegate only when it pays:
- **≥ 2 independent lanes** of work that can run in parallel, or
- a change spanning **> ~4 files** in one lane, or a broad search (use `Explore`).

Lanes own disjoint write scopes (`.claude/work/BOARD.md` is the ledger):

| Lane | Agent | Owns |
| ---- | ----- | ---- |
| 1 Core | `command-author` | `packages/core/src/**`, `packages/domain-aec/src/**`, `packages/kernel-*/src/**` |
| 2 3D+Shell | `viewport-engineer` | `src/ui/viewport/3d/**`, `src/ui/{components,panels,store}/**`, `src/app/**` |
| 3 2D | `viewport-engineer` | `src/ui/viewport/2d/**`, snapping/tracking helpers |
| 4 MCP | `mcp-engineer` | `packages/mcp/src/**`, `server/**` |
| 5 Review | `test-verifier` + `cad-reviewer` | `tests/**`; reviews diffs |

`registry.ts` is Lane-1-only. Run `cad-reviewer` when the diff touches `packages/core`, the
registry, a plugin's commands, or `packages/mcp`/`server` — not for docs, tests-only or small UI tweaks.

## W6 — When unsure

Re-read the relevant rule / `.claude/context/*` before guessing. If a change seems to require
breaking an architecture law, STOP and ask the user.
