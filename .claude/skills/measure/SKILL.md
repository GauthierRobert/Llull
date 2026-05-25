---
name: measure
description: Add read-only measurement & inspection tools — distance, angle, area, perimeter, volume, bounding box, mass properties (with material density), interference/clash checks. These are QUERY commands: they don't mutate the document, they return a computed value. They are ideal MCP tools (safe, side-effect-free) and cheap to build with huge AI value. Use for "measure", "how big/far/heavy is", inspection, or analysis.
---

# Skill: measure

Measurement makes the model meaningful and inspectable — and queries are the safest,
highest-value MCP tools (no mutation, an agent can call them freely). Queries are still
commands (one path: UI / AI / MCP), but read-only. Delegate to `command-author`; keep
the math pure in `core`/`lib` and unit-tested.

## References
- Query result shape: `.claude/context/model.md` (Query results), `.claude/context/command-layer.md`
- Math is pure + tested: `.claude/rules/workflow.md` (W3)

## The query contract (differs from mutating commands)
A query returns the document UNCHANGED, `affected: []`, a factual `summary` with units
("distance = 42.0 mm"), and the structured value in `result.data` (the planned optional
`CommandResult.data` field). The `summary` is for humans/AI to read; `data` is for an
agent to consume programmatically. NEVER mutate the document in a query.

## Tools to build (snake_case, read-as-queries)
`measure_distance`, `measure_angle`, `area_of`, `perimeter_of`, `volume_of`,
`bounding_box`, `mass_properties`, `check_interference`.

- Pure geometry math lives in `core`/`lib`; the command just gathers params, calls it,
  and packages `summary` + `data`. Unit-test the math exhaustively (it feeds the gate).
- `mass_properties` (mass, center of mass, inertia) needs **material density** — depends
  on the materials axis (roadmap); until then accept density as a parameter.
- `check_interference` may need the geometry kernel for exact solids (architecture L9);
  start with bounding-box / mesh overlap behind the same query contract.

## Done checklist
- [ ] Each query returns unchanged doc + `affected: []` + factual `summary` (with units) + `data`
- [ ] Geometry math is pure, in core/lib, unit-tested
- [ ] Tools named as queries, registered (so AI + MCP get them), `npm run check` green
