---
name: parametric
description: Add or extend llull's parametric modeling — named parameters/variables, geometric & dimensional constraints (coincident, tangent, parallel, distance, angle...), and the editable feature history (timeline). Use when a task means "drive it by a parameter", "constrain these", a feature tree, edit-and-regenerate, or relations between entities. This is the highest-value MCP capability: an agent edits one parameter and the whole model regenerates.
---

# Skill: parametric

A full CAD stores HOW a model was built, not just final geometry. llull has an unfair
advantage here: commands are pure `(doc, params) => doc`, so the ordered command list
already IS a replayable feature tree (architecture L8). This skill promotes that into
real parametric modeling. Delegate command work to `command-author`.

## References
- Model design: `.claude/context/model.md` (Parameter, Constraint, Feature, history)
- Law: `.claude/rules/architecture.md` (L8 parametric, L9 kernel)

## The core distinction (decide before coding)
- **Constructive geometry** = the editable definition: sketches + features + parameters
  + constraints. This is the source of truth — store it.
- **Evaluated geometry** = the resulting meshes/B-rep you render and export. Treat it as
  a DERIVED cache produced by replaying `history`. Don't hand-edit it.

## Three pieces

### 1. Parameters — command-author
Named variables (`Parameter { name, value, expression?, unit? }`) in the document.
Commands read params instead of hardcoding numbers. Add `set_parameter` (changing a
value re-evaluates dependent features) and expose parameters as readable/writable over
MCP — this is the killer agent demo: "set wall_thickness = 200" → model updates.

### 2. Constraints + solver — command-author + core/lib
Geometric (coincident, parallel, perpendicular, tangent, concentric, equal, horizontal,
vertical) and dimensional (distance, angle, radius — driving dimensions). Constraints
reference entities by id. The SOLVER is a PURE function in `core`/`lib` (unit-tested):
`(geometry, constraints) => positioned geometry`. No solver code in components or commands' side effects.

### 3. Feature history / timeline — store + commands
Promote the undo snapshot stack into a named, ordered `Feature[]` history. Support
insert / reorder / edit-params / suppress a feature, then RE-EVALUATE downstream by
replaying. Because commands are pure, replay is deterministic and safe.

## Keep it incremental (don't break the contract)
- Commands stay pure and keep returning `CommandResult`. v1 can be "direct mode"
  (history = undo snapshots, no params/constraints); promote per roadmap without
  rewriting callers.
- `entities` becomes a derived cache once `history` is the source of truth — change that
  in the store/evaluator, not in every command.

## Done checklist
- [ ] Parameters/constraints/features live in the document (model.md shapes); not ad hoc
- [ ] Solver is pure, in core/lib, unit-tested; constraints reference entity ids
- [ ] Editing a parameter/feature re-evaluates downstream deterministically (replay)
- [ ] `set_parameter` (and friends) exposed as MCP/AI tools via the registry
- [ ] Command purity + the coverage gate still hold; `npm run check` green
