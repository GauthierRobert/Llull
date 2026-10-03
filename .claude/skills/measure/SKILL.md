---
name: measure
description: Add read-only measurement & inspection tools — distance, angle, area, perimeter, volume, bounding box, mass properties (with material density), interference/clash checks. These are QUERY commands: they don't mutate the document, they return a computed value. They are ideal MCP tools (safe, side-effect-free) and cheap to build with huge AI value. Use for "measure", "how big/far/heavy is", inspection, or analysis.
---

# Skill: measure

Measurement makes the model meaningful and inspectable — and queries are the safest,
highest-value MCP tools (no mutation, an agent can call them freely). Queries are still
commands (one path: UI / AI / MCP), but read-only. Delegate to `command-author`; keep
the math pure in `packages/core/src` (`commands/measure*.ts`, `lib/`) and unit-tested.

## References
- Query result shape: `.claude/context/model.md` (Query results), `.claude/context/command-layer.md`
- Math is pure + tested: `.claude/rules/workflow.md` (W3)

## The query contract (differs from mutating commands)
A query is a `defineCommand` with `annotations: { readOnly: true }` (MCP `readOnlyHint`; no
feature step). It returns the SAME document, `affected: []`, a factual `summary` with units
("distance = 42.0 mm"), and the structured value in `CommandResult.data`. The `summary` is for humans/AI to read; `data` is for an
agent to consume programmatically. NEVER mutate the document in a query.

## Existing queries (extend these; snake_case, read-as-queries)
`measure_distance`, `measure_angle`, `measure_area`, `measure_perimeter`, `measure_volume`,
`measure_bounding_box`, `mass_properties` (material density via `assign_material`),
`describe_scene`, `find_entities`, `check_model`; building plugin: `check_clashes`,
`quantity_takeoff`, `check_*`.

- Pure geometry math lives in `packages/core/src`; the command just gathers params, calls it,
  and packages `summary` + `data`. Unit-test the math exhaustively (it feeds the gate).
- Exact-solid queries need the geometry kernel: read `ctx?.kernel` and declare
  `requiresKernel` (architecture L9); otherwise use bounding-box / mesh math behind the same
  query contract.

## Done checklist
- [ ] Each query returns unchanged doc + `affected: []` + factual `summary` (with units) + `data`
- [ ] Geometry math is pure, in `packages/core/src`, unit-tested
- [ ] Tools named as queries, registered (so AI + MCP get them), `npm run check` green
