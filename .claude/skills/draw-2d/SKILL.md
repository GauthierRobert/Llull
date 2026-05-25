---
name: draw-2d
description: Add or extend llull's 2D drafting — drawing entities (line, polyline, arc, circle, rectangle, point, text, dimension), 2D snapping/ortho tracking, dimensions, and the 2D→3D sketch bridge (a closed profile → extrude/revolve into a solid). Use whenever a task involves 2D drawing, drafting, sketches, or "draw a ...". Reminder: 2D and 3D share ONE document and ONE command layer.
---

# Skill: draw-2d

llull is AutoCAD-like: 2D drafting AND 3D modeling. There is NO separate 2D engine,
store, or code path — 2D shapes are `Entity` kinds in the same `CadDocument`, changed
by the same commands, rendered by the same viewport (architecture L7). 2D work splits
across the existing agents; this skill is the playbook.

## References
- 2D model design: `.claude/context/model.md` (Shape2DKind, Vec2, work plane, is2D)
- Command shape: `.claude/context/command-layer.md`, conventions C5
- Architecture law: `.claude/rules/architecture.md` (L7)

## The three pieces of any 2D feature

### 1. Model (if a new 2D kind is needed) — command-author
Extend `Shape2DKind` + add the `*Entity` interface (Vec2 geometry in the entity's local
plane; `position` places that plane in 3D) + add to the `Entity`/`EntityKind` union and
the `is2D` helper. See model.md.

### 2. Drawing command(s) — command-author / add-command skill
Each draw op is a pure `CommandDefinition`, snake_case, drafting-verb named:
`draw_line`, `draw_polyline`, `draw_arc`, `draw_circle`, `draw_rectangle`,
`add_dimension`. Same rules as any command: pure, registered, happy + failure tests.
Registering it gives the UI tool and the MCP tool (drivable by Claude or any agent) at once.

### 3. Drafting interaction & rendering — viewport-engineer / viewport-feature skill
- 2D drafting view = orthographic top-down camera over the SAME three.js scene; render
  2D entities as Line/Shape geometry; render every kind by `kind`.
- Snapping (endpoint, midpoint, center, intersection, grid) and ortho/polar tracking:
  compute snap candidates as PURE functions in `core`/`lib` (unit-tested); the component
  only applies the chosen point and calls `dispatch`.
- Dimensions/annotations are entities too (`dimension` kind), created via a command.

## The 2D → 3D bridge (do not duplicate geometry)
A closed `polyline`/profile is the input to `extrude_profile` (and later
`revolve_profile`) to become a solid. Sketch once in 2D, build the solid from it. Never
re-encode the same shape separately for the 2D and 3D worlds.

## Done checklist
- [ ] New 2D kinds added to `Shape2DKind`/`Entity`/`is2D`; viewport has a render branch
- [ ] Draw commands are pure, registered, snake_case, tested (happy + failure)
- [ ] Snap/ortho math is pure + unit-tested in core/lib, applied (not computed) in ui
- [ ] Closed profiles feed `extrude_profile` — no geometry duplicated across 2D/3D
- [ ] Verified in the 2D drafting view (`verify-llull`); `npm run check` green
