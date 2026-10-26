# DL1 — Dev-loop speed and review rework (2026-10-26)

**Status:** decided and built. **Owner:** asked to "improve all" after the measurement below.

## Measurement (255 session + sub-agent transcripts, 2026-10-19..26; git 2026-10-12..26)

Tool waits took about 164 h against 79 h of model turns; 81 % of the tool time was in sub-agents.

| Step | Calls | Total | Mean | Cause |
| --- | --- | --- | --- | --- |
| vitest | 4,067 | 47 h | 42 s | a 7-test file is 20 s cold (84 % transform: `tests/setup.ts` loads every plugin), 4.5 s warm; worktree agents start cold |
| typecheck | 544 | 9.7 h | 64 s | bare `npx tsc --noEmit` (no incremental), TypeScript 6 |
| server suite | 864 | 18.7 h | 78 s | whole suite where one file was meant |
| trivial shell (`sed`, `git status`) | — | — | p90 35–121 s | parallel heavy runs on one machine |

Rework: 141 of 1,094 commits were review fixes; most milestones needed 1–3 `cad-reviewer` rounds, in a few recurring classes
(slice load validation, untrusted-input readers, replay / delete / clear lifecycle, ids and units).

## Decisions

1. **Persistent lane worktrees** (`scripts/lane.mjs`, `npm run lane -- <n> <branch>`), not fresh `isolation: "worktree"` checkouts.
   Vitest's fs module cache keys on the absolute module path (`vitest` `generateCachePath`: `id + fileContent + …`), so a cache cannot
   be shared across worktree paths; a stable path per lane keeps it, plus node_modules (reinstalled only when a lockfile changes),
   tsc build info, the eslint cache and `solver/target`.
2. **TypeScript 7 for type checking** (`typescript-native` = `npm:typescript@~7.0.2`; every `typecheck*` script, `build`, server
   build). Cold app check 3.3 s vs 28 s, warm 0.6 s; the four root projects together ~10 s under load; identical diagnostics on the
   strict flags (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnused*`). TypeScript 6 stays as `typescript`:
   TS 7 ships no JS compiler API, which typescript-eslint, knip and dependency-cruiser need. Scripts call each compiler by path,
   since both packages publish a `tsc` bin.
3. **Machine-wide heavy-run slot** (`scripts/heavyLock.mjs`, `~/.cache/llull/heavy-locks`): `check`, `check:coverage`, `test`,
   `test:coverage`, `native:check`, the server and desktop suites queue for one slot (`LLULL_HEAVY_SLOTS`); runs narrowed to test
   files, nested heavy scripts and CI bypass it.
4. **Shell guard hook** (`.claude/hooks/pre-shell.mjs`): blocks non-incremental `tsc --noEmit`, `git stash` and killing processes by
   name (both broke parallel lanes before).
5. **Contract suites for the recurring review classes**, so they fail before review: plugin slice load fuzzing
   (`tests/unit/contract/pluginSliceFuzz.test.ts`, every plugin with a document extension needs a seed), a hostile-input harness
   for every reader (`tests/unit/contract/hostileInput.test.ts`, `tests/helpers/hostileReaders.ts`, every `import_*` / `load_*` /
   `read_*` command registered), and lifecycle properties over the action-matrix corpus (round trip, replay, undo, delete, clear,
   id hygiene). New slices declare a zod schema through `packages/core/src/plugins/sliceSchema.ts`.
6. **Self-review checklist** (`.claude/context/review-checklist.md`) run by `command-author` before `cad-reviewer`, which checks the
   same list and says how a contract suite should grow when it missed a finding.

## Not done

- Lazy plugin installation in tests (the cold transform is the whole plugin graph): a deeper change to the registry; persistent
  lanes remove most of the cold starts instead.
