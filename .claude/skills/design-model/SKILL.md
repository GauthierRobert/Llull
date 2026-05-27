---
name: design-model
description: Design a complete CAD model end-to-end with llull — turn a design intent ("a flanged gearbox housing", "an enclosure with a bolt pattern", "a bracket") into a finished parametric model. Use whenever the user describes a thing to BUILD (not a llull feature to code): "design/model/make a ...", "build me a ...", "lay out an assembly of ...". Orchestrates the real command vocabulary as one transactional plan (build_project), parametrizes it, then inspects/measures/checks/renders and optionally exports. This is using llull AS a CAD tool, not extending it.
---

# Skill: design-model

You are the CAD designer driving llull through its command layer. Every change goes
through a command (PRIME DIRECTIVE) — you never invent geometry, you compose existing
commands into a plan. The headline tool is **`build_project`**: an ordered list of
command actions applied as one undoable transaction, with cross-step id aliasing and a
dry-run validator. Design the whole system as one plan, validate it, apply it, then
verify and refine.

> Building a NEW llull capability (a command/viewport/MCP/test change) is a different
> job — use `add-command` / `viewport-feature` / `mcp-server` instead. This skill only
> *uses* the commands that already exist.

## References
- Plan transaction & aliasing: `src/core/commands/project.ts` (`build_project`)
- Full command vocabulary: `registry.ts` · Schema: `.claude/context/model.md`
- 2D drafting: `draw-2d` skill · Parametrics & history: `parametric` skill
- Read-only inspection/sizing: `measure` skill · Drive the live app: `verify-llull`

## The command vocabulary (what you compose)

| Phase | Commands |
| ----- | -------- |
| Setup | `set_units`, `set_parameter`, `add_layer`, `create_material` |
| 2D sketch | `draw_line` `draw_polyline` `draw_arc` `draw_circle` `draw_rectangle` `draw_ellipse` `draw_spline` `draw_point` |
| 2D edit | `offset_2d` `trim` `extend` `fillet_2d` `chamfer_2d` `explode_polyline` |
| 2D→3D | `extrude_sketch` `extrude_profile` `revolve_profile` |
| Primitives | `add_box` `add_cylinder` `add_sphere` `add_cone` `add_torus` `add_wedge` `add_pyramid` |
| Combine | `boolean_union` `boolean_subtract` `boolean_intersect` `make_tube_between` |
| Modify 3D | `fillet_edge` `chamfer_edge` |
| Place/replicate | `move_entity` `rotate_entity` `scale_entity` `mirror_entity` `array_linear` `array_polar` `duplicate_entity` |
| Organize | `group_entities` `ungroup_entities` `set_entity_name` `set_entity_layer` `assign_material` |
| Reuse | `instantiate_template` (`bolt_hole_pattern`, `flange`, `rectangular_plate_with_holes`), `instantiate_recipe`, `create_configuration` |
| Annotate | `add_text` `add_dimension` |
| Inspect (read-only) | `describe_scene` `find_entities` `check_model` |
| Measure (read-only) | `measure_distance` `measure_angle` `measure_area` `measure_perimeter` `measure_bounding_box` `measure_volume` `mass_properties` |
| Output | `render_view` `export_stl` `save_recipe` |
| Orchestrate | **`build_project`** (the plan transaction) · `replay_history` + history edits |

## Procedure

### 1. Decompose the intent → a feature tree
Restate the thing as parts + features + relationships. Identify: base solid(s), cut
features (holes, slots, pockets), edge treatments (fillet/chamfer), patterns
(linear/polar arrays), and how parts relate (concentric, stacked, bolted). Pull the
driving dimensions out as named **parameters** (wall thickness, bore Ø, bolt-circle Ø,
hole count) — these become `set_parameter` calls so the model is editable later (L8).

### 2. Author the plan (compose, don't mutate)
Build an ordered `actions` list for `build_project`. Use **aliases** to chain steps
without knowing generated ids: bind a step's result with `as: "base"`, then reference
its first affected id later as `$base` (or `$base[N]` for the Nth). Typical shape:

```jsonc
{ "actions": [
  { "command": "set_units",     "params": { "units": "mm" } },
  { "command": "set_parameter", "params": { "name": "bore", "value": 20 } },
  { "command": "add_cylinder",  "params": { "radius": 40, "height": 30 }, "as": "body" },
  { "command": "add_cylinder",  "params": { "radius": 10, "height": 40 }, "as": "hole" },
  { "command": "boolean_subtract", "params": { "a": "$body", "b": "$hole" }, "as": "part" },
  { "command": "fillet_edge",   "params": { "id": "$part", "radius": 2 } }
] }
```

Reuse beats hand-drafting: prefer `instantiate_template` for bolt patterns/flanges/plates
and `instantiate_recipe`/`array_*` for repetition before drawing primitives one by one.

### 3. Validate (dry run) before applying
Call `build_project` with `validate: true` first — it checks every step (command exists,
required params present, alias refs defined) WITHOUT mutating. Fix reported issues, then
re-run with `validate` off. Keep `onError: "abort"` (default) so a bad step rolls the
whole document back (commands are pure → original doc returned); use `"continue"` only
when partial application is genuinely wanted.

### 4. Apply, then inspect
Apply the plan. Read the result `data` (per-step report + final `SceneSnapshot`). Then
`describe_scene` for the entity/bounds overview and `find_entities` to locate parts by
kind/name/layer for follow-up steps.

### 5. Measure & check (does it meet intent?)
- `check_model` — geometry defects, structural issues, parameter errors. Resolve all.
- Verify the driving dims with `measure_bounding_box`, `measure_distance`,
  `measure_volume`; `mass_properties` for mass/CoM if a material is assigned.
- Compare against the intent's requirements; if off, go to step 6.

### 6. Refine parametrically (edit the recipe, not the geometry)
The plan you applied is now feature history. To change the design, prefer editing
parameters/steps over redrawing: `set_parameter` (re-runs dependents), or the history
edits `edit_step_params` / `reorder_step` / `set_step_suppressed` / `insert_step` /
`delete_step` then `replay_history`. Capture proven sub-assemblies with `save_recipe`
and design variants with `create_configuration` / `activate_configuration`.

### 7. Present & export
- `render_view` to show the result (and to visually confirm). For live, interactive
  confirmation drive the app with the `verify-llull` skill.
- `add_dimension` / `add_text` for a documented drawing.
- `export_stl` when the user wants a file.

## Scaling up: complex / multi-part systems
- One `build_project` per coherent sub-assembly; alias its top entity, then `group_entities`
  and `set_entity_name` so later plans reference it by name via `find_entities`.
- Place sub-assemblies with `move_entity`/`rotate_entity`; replicate with `array_linear`/
  `array_polar` rather than re-authoring identical parts.
- Use `add_layer` + `set_entity_layer` to keep large models navigable; `assign_material`
  per part so `mass_properties` and `render_view` are meaningful.
- For genuinely large builds, hand the design tree to `continue-working` (board-driven
  parallel lanes) — but the geometry is still produced by these commands.

## Guardrails
- Compose existing commands; if the intent needs an operation no command provides, that's
  an `add-command` task — STOP and surface it, don't fake the geometry.
- Always `validate` a plan before applying, and always `check_model` after.
- Keep designs parametric (named params + history) so the user/AI can edit later (L8).
- Inspection/measurement commands are read-only — they never change the model.

## Done checklist
- [ ] Intent decomposed into parts/features + named driving parameters
- [ ] Plan validated (dry run) then applied via `build_project` with no errored steps
- [ ] `check_model` clean; key dimensions measured and matching intent
- [ ] Model is parametric (params + feature history), not hand-placed geometry
- [ ] Rendered/confirmed; exported or recipe-saved if the user asked
