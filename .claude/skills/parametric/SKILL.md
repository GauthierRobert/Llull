---
name: parametric
description: Add or extend llull's parametric modeling — named parameters/variables, geometric & dimensional constraints (coincident, tangent, parallel, distance, angle...), and the editable feature history (timeline). Use when a task means "drive it by a parameter", "constrain these", a feature tree, edit-and-regenerate, or relations between entities. This is the highest-value MCP capability: an agent edits one parameter and the whole model regenerates.
---

# Skill: parametric

A full CAD stores HOW a model was built, not just final geometry. Commands are pure
`(doc, params, ctx) => doc`, so the recorded command list IS a replayable feature tree
(architecture L8, "as built"). This skill extends it. Delegate command work to `command-author`.

## References
- Model: `.claude/context/model.md` (Parameter, Constraint, FeatureStep, partition)
- Signatures: `.claude/context/command-layer.md` (History & regeneration, IDs)
- Law: `.claude/rules/architecture.md` (L8, L9) + `.claude/rules/commands.md` (as built)

## What exists (extend, don't rebuild)
| Piece | Where (`packages/core/src/commands/`) |
| ----- | ----- |
| Feature history: `execute` appends `FeatureStep { id: 'step-<n>' }` per mutating command | `registry.ts` |
| History edits: `replay_history`, `edit_step_params`, `reorder_step`, `set_step_suppressed`, `insert_step`, `delete_step` (`metaHistory`) | `history.ts`, `history_carry.ts` |
| Step-scoped ids `<prefix>-<n>.<k>` — replay re-mints identical ids (remap kept only for legacy, pre-step-scoped ids) | `@lib/id`, `regenerate.ts` |
| Replay prefix cache (`ctx.replayCache`): unchanged prefixes reused; edit step k ⇒ re-run k..n | `replayCache.ts` |
| Parameters + `=expr` step params (`set_parameter`, `delete_parameter`) | `parameters.ts`, `expression.ts` |
| Parameter → step dependencies: regenerate only when a step reads a changed parameter | `dependents.ts` |
| Configurations (design tables), recipes | `configurations.ts`, `recipes.ts` |
| Constraints + pure solver (`add_constraint`, `solve_constraints`, …) | `constraints.ts`, `constraintSolver.ts` |
| Constructive vs evaluated split | `@core/model/partition` |

## The core distinction (decide before coding)
- **Constructive** = the editable definition: feature history, parameters, constraints, plugin
  definitions (e.g. `building`). Source of truth — stored.
- **Evaluated** = `entities` + `order` (meshes/B-rep you render and export). Derived; never
  hand-edit it. Plugin-generated geometry is read-only (derivation guards) and omitted from v2 files.

## Rules for new parametric work
- A new document-input command (edits a table, not geometry) ⇒ `annotations: { metaHistory: true }`
  and, if geometry depends on it, regenerate via `replayHistory` / `regenerateParameterDependents`.
- Regeneration must be deterministic: no `Date.now()` / `uniqueId()` in ids, kernel only from
  `ctx.kernel`; `requiresKernel` steps make replay refuse rather than drop geometry.
- Keep `affected` order deterministic. Keep the `CommandResult` contract unchanged.
- Prove it: a test that edits a parameter/step and asserts the regenerated doc, plus a golden
  plan (`tests/golden/plans.ts`) whose `replay_history` reproduces the document.

## Done checklist
- [ ] Data lives in the document (model.md shapes); not ad hoc
- [ ] Solver/evaluation is pure, unit-tested; constraints reference entity ids
- [ ] Editing a parameter/step re-evaluates only what depends on it, deterministically
- [ ] Exposed as MCP/AI tools via the registry (`defineCommand`)
- [ ] Purity, golden corpus and the coverage gate hold; `npm run check` green
