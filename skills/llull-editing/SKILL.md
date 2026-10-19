---
name: llull-editing
description: Change an existing llull (local CAD) model through the `llull` CLI without rebuilding it — edit driving parameters, edit / suppress / reorder / delete feature-history steps, move, pattern, rename and organise parts — and prove the change with before/after measurements. Use when asked to modify, resize, adjust, tweak, rename, reorganise or fix a model that already exists in llull.
---

# llull-editing: change the recipe, then measure the difference

A llull document is a recipe: every command that changed it is a feature-history step (`step-1`, `step-2`, …), replayed in order.
Prefer editing the recipe (parameters, step params) over adding corrective geometry on top: the model stays editable and
consistent. Never edit the document file by hand.

## 0. Orient (read-only)

```bash
llull status                                   # --app (the user's open window) or --doc FILE
llull describe_scene --doc part.llull.json     # entity ids, kinds, bounds
llull find_entities kind=mesh --doc part.llull.json   # filter by kind / name / tag / layer / bbox
llull mass_properties entityId=<id> --doc part.llull.json   # record the BEFORE values you will compare against
llull measure_bounding_box --doc part.llull.json
```

Entity ids name their step: `mesh-6.1` was created by `step-6` (`<prefix>-<step>.<k>`). A local document file also lists the steps
in `document.featureHistory` (read it, never write it).

## 1. Parameters first

If the model was built with `set_parameter` and `"=expr"` params, one call regenerates every dependent step:

```bash
llull set_parameter name=t expression=12 --doc part.llull.json
```

Then re-measure. Expected change is yours to compute: a plate `80 x 60 x t` with four D8 through holes changes volume by
`(80·60 − 4·π·4²) · Δt` = 4598.9 mm³ per mm of `t`.

Variants: `create_configuration` (named parameter sets) and `activate_configuration`.

## 2. Edit history steps

```bash
llull edit_step_params stepId=step-3 'params={"size":[90,60,10],"anchor":"base-center"}' --doc part.llull.json
llull set_step_suppressed stepId=step-7 suppressed=true --doc part.llull.json   # hide a feature, keep it
llull reorder_step stepId=step-7 newIndex=4 --doc part.llull.json
llull delete_step stepId=step-7 --doc part.llull.json
llull insert_step --doc part.llull.json        # see: llull describe insert_step
llull replay_history --doc part.llull.json     # recompute everything from the recipe
```

`edit_step_params` replaces the WHOLE params object of that step: copy the old params and change one value. Later steps that
picked faces or edges by location (`edgesNear`, `face.near`, `openFacesNear`) keep their points: after moving geometry, check those
features still found their target (read the summary of the replay, then measure).

## 3. Direct edits (when there is no step to change)

- Placement: `move_entities` (one delta for several ids), `rotate_entity` (radians), `align`, `distribute`, `stack_on`, `mirror_entity`.
- Copies and patterns: `duplicate_entities`, `array_linear`, `array_polar` (count includes the original).
- Organisation: `set_entity_name` (names travel to STEP / glTF exports), `group_entities`, `add_layer` + `set_entity_layer`,
  `assign_material`.
- Removing: `delete_entities`.
- Undo: `llull undo --app` (the app's full history); with `--doc`, one level (the `.bak` copy).

Several edits = one plan file run with `llull run edits.json` (one transaction, one rollback if a step fails).

## 4. Prove the edit

Re-run the same measurements as in step 0 and report BEFORE → AFTER → EXPECTED for the bounding box, volume (and mass). Run
`llull check_model` (parameter errors, dangling references) and, for solids, `llull check_assembly ids='["<id>"]' thickness=off`.
Render if the shape changed: `llull render_view view=iso --save after.png`.

## Known traps

- Ids change when a kernel feature re-runs (boolean, fillet, hole results are new entities): look ids up again after an edit
  instead of reusing old ones.
- `set_parameter` takes `expression` as a STRING (`expression=12` is fine on the CLI: string params are never JSON-parsed).
- A plan that names a loop entity by `$alias` keeps that fixed id even if the loop count shrinks.
- With `--app`, the user can see and undo each step; tell them what you changed. Saving is their File › Save.
- A change command that changes nothing exits 1 with a summary saying why (wrong id, value out of range): read it, do not retry blindly.
