# Mutation testing (SC-Q4)

Stryker mutates the CAD core (`packages/core/src/commands/{brep,solids,parametric,history}`) and asks one question: **do the behavioural
suites notice?** The judges are only the suites that do not know the code's internals, so the score still means something after a kernel
swap: the oracle reference parts (`tests/oracle`), the golden corpus (`tests/golden`), the fuzz sample (`tests/unit/fuzz/fuzzRun.test.ts`)
and the action-matrix PR sample (`tests/action_matrix`), wired in `vitest.mutation.config.mts`. Unit tests are deliberately left out.
Nightly (`.github/workflows/mutation.yml`, one job per folder, HTML + JSON report as artifacts), never a PR gate (`thresholds.break` null).

## Run

```bash
npm run mutation -- --folder parametric        # one folder; brep | solids | parametric | history
npm run mutation -- --folder brep --file 'packages/core/src/commands/brep/boolean.ts'   # sample one file
node scripts/mutationSurvivors.mjs reports/mutation-parametric.json --lines 3            # survivor clusters for this page
```

**Never run it in a checkout nested inside another checkout** (`.claude/worktrees/*`): on 2026-10-20 the sandbox cleanup of such a run
followed the parent checkout's npm-workspace junctions (`node_modules/@llull/* -> packages/*`) and deleted every tracked file of the
parent's `packages/`. `scripts/mutation.mjs` now refuses to start when an ancestor directory holds `node_modules` or `.git`. Use a
standalone clone, or CI.

## Scores (Windows, Node 24, Manifold kernel in the judges, 2026-10-19/20)

| Folder                                            | Scored mutants | Killed | Timeout | Survived | No coverage | Score               | Wall time                        |
| ------------------------------------------------- | -------------- | ------ | ------- | -------- | ----------- | ------------------- | -------------------------------- |
| `history` (2026-10-20, with the SC-Q4b judges)    | 736            | 267    | 3       | 338      | 128         | 36.7 %              | 11 min (concurrency 16, Node 22) |
| `history` (before SC-Q4b)                         | 726            | 203    | 0       | 320      | 203         | 28.0 %              | not recorded                     |
| `parametric` (2026-10-20, with the SC-Q4b judges) | 3022           | 1647   | 42      | 984      | 349         | 55.9 %              | 131 min (concurrency 6, Node 22) |
| `parametric` (before SC-Q4b)                      | 2772           | 949    | 34      | 848      | 941         | 35.5 %              | 34 min (concurrency 12)          |
| `brep`, `solids`                                  | —              | —      | —       | —        | —           | not run locally yet | nightly                          |

The judges reach these folders through the registry, so Stryker cannot use static "related tests": every mutant runs the whole judge set
selected by per-test coverage (`coverageAnalysis: perTest`; about 2 tests per mutant on average).

## SC-Q4b judges (2026-10-20)

`tests/golden/sketchOracle.ts` (independent constraint residuals + DOF by finite-difference rank), `sketchPlans.ts` / `sketchJudges.test.ts`(one plan per constraint family), `sketchGuards.test.ts` (conflict / redundant / flip refusals, triangle orientation, 40-seed DOF
property) and `historyJudges.test.ts` (replay equality of every history meta-command, a carried material edit, a late parameter edit).
History: `history.ts` 14 -> 43 %, `record.ts` 69 %, `regenerate.ts` 54 %; `carry.ts` (19 %) and `replay.ts` (25 %) remain the weakest.
Parametric: `solver/` 62.6 % (`residuals.ts` 86 %, `residualsDimensional.ts` 76 %, `residualsCurves.ts` 0 -> 61 %, `residualsGeometric.ts`
55 %, `dof.ts` 15 -> 41 %), `constraintGuard.ts` 51 %; `flipGuard.ts` (23 %) remains the weakest.

## What survives, and what would kill it

The numbers say the behavioural suites prove much less about the parametric layer than its unit tests suggest (unit coverage there is
~97 %). Biggest clusters, with the kind of new judge that would kill them (not written yet; each is a new oracle part, golden plan or
fuzz property):

- **Sketch solver** (`parametric/solver/*`, `constraintGuard.ts`, `flipGuard.ts`, 4–64 %): no golden plan solves the new constraint kinds
  (`residualsCurves.ts` 0 %: tangent / point_on_curve / curvature are never exercised by a judge; `residualsDimensional.ts` 14 %).
  Kill with a golden plan per constraint family (fully constrained slot, symmetric bracket, tangent arc chain) asserting the solved
  coordinates and `data.dof`, and a fuzz property "a solved sketch satisfies every constraint to 1e-9 and DOF = unknowns − rank".
  `dof.ts` 15 %: no judge checks DOF at all.
  `flipGuard.ts` 4 %: no judge edits a dimensioned triangle across its flip.
- **History** (`history/history.ts` 14 %, `carry.ts` 11 %, `replay.ts` 24 %): judges replay plans but never delete / reorder / insert /
  suppress steps, and never edit a material or component that later steps carry. Kill with golden plans that run each history
  meta-command on a non-trivial plan and compare to the plan rebuilt from scratch (replay equality).
- **Configurations / parameters / recipes** (26–40 %): add an oracle part whose volume depends on a parameter edited after the fact.

## Second SC-Q4b judge set (merged 2026-10-21; not in the scores above)

The scores above were measured with `sketchJudges` / `sketchGuards` / `historyJudges`. These judges were written in parallel and add the
DOF property and the per-family plans; all live in `tests/golden/`, so `vitest.mutation.config.mts` picks them up. Re-run `parametric` and
`history` from a standalone clone to measure them.

| Judge                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Targets                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `golden.constraints.test.ts` + `plansConstraints.ts`: 10 `build_project` plans (one per family: coincident/fix/H/V, parallel/perpendicular/collinear/equal, tangent/point_on_curve/concentric, midpoint/symmetric, distance/angle/point_to_line, horizontal/vertical distance, radius/diameter/arc dimensions, curvature chain, parameter-driven dimension, update/delete/re-solve) with id-normalized snapshots, replay equality, `converged`, residual and the exact `dof` of each finished sketch | `solver/residuals*.ts`, `dof.ts`, `constraints.ts`, `constraintGuard.ts`, `flipGuard.ts`, `reference.ts` |
| same file: flip / conflict / redundancy refusals on a dimensioned triangle and a signed angle                                                                                                                                                                                                                                                                                                                                                                                                        | `flipGuard.ts`, `constraintGuard.ts`                                                                     |
| `golden.dof.test.ts`: seeded random sketches; accepted constraint lowers `dof` by its rows, refusal leaves the doc identical, deleting restores earlier `dof`, `dof` independent of insertion order, converged + idempotent solution                                                                                                                                                                                                                                                                 | `solver/dof.ts`, `rowSpace.ts`, `solve.ts`, `constraintGuard.ts`                                         |
| `golden.history.test.ts` + `historyRecipe.ts`: `delete_step`, `set_step_suppressed`, `reorder_step`, `edit_step_params`, `insert_step`, `replay_history` on a 6-step recipe (material + assignment + move depending on earlier entities, `=expr` parameter) compared with the edited recipe rebuilt from scratch                                                                                                                                                                                     | `history/history.ts`, `carry.ts`, `replay.ts`, `replayStep.ts`, `replayParameters.ts`, `dependents.ts`   |
| `golden.history.sketch.test.ts`: the same meta-commands on a constrained sketch (constraint and solve steps)                                                                                                                                                                                                                                                                                                                                                                                         | `history/replay.ts`, `constraints.ts`, `solve.ts`                                                        |

Reports land in `reports/` (gitignored); the incremental cache (`reports/stryker-incremental-<folder>.json`) is a CI cache entry.
