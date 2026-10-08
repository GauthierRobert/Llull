---
name: fix-bug
description: Fix a bug or regression in llull test-first — reproduce it as a failing unit test or golden build_project plan, find the root cause, fix minimally, and keep the reproducer as a regression guard. Use whenever the task is "X is broken / wrong / crashes / regressed", a failing test, or a user-reported misbehaviour (not a new feature).
---

# Skill: fix-bug

## 1. Reproduce (before touching source)
- Pick the cheapest layer that shows the bug:
  - Command result wrong → `tests/unit/<domain>.test.ts`: `execute(doc, name, params)`; assert
    `document` / `summary` / `affected`.
  - Multi-step / replay / parametric regeneration wrong → a plan in `tests/golden/plans.ts`
    (plus `golden.kernel.test.ts` if it needs `ctx.kernel`).
  - Store / undo / live sync / outbox → `tests/integration/`.
  - Panel or param-gathering → `tests/component/`. Rendering only → reproduce in `npm run dev`
    (`verify-llull` §4) and unit-test the pure helper behind it.
- Run it: `npx vitest run <file>` — it MUST fail for the reported reason. If it passes, the
  reproduction is wrong; keep digging before fixing anything.

## 2. Root cause
- Trace from the failing assertion to the first wrong value. Name the cause in one sentence
  (file:line). "Flaky" is not a cause; neither is "timing".
- Check siblings: the same pattern elsewhere (`grep`) — same bug, same fix, same change.

## 3. Fix
- Smallest change at the root cause, in the right layer (architecture decision shortcuts).
  Never patch the symptom in the UI when the command is wrong.
- Never weaken an assertion, `-u` a snapshot, `.skip` a test (hook-blocked) or lower coverage
  to get green.

## 4. Verify
- The reproducer now passes; `npx vitest related --run <changed files>`; then `npm run check`.
- Golden snapshots that change beyond the reproducer mean wider behaviour change — explain each.

## Report
Cause (one sentence, file:line) → fix → reproducer test name → check results.
