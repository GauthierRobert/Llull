---
name: llull-cli
description: Drive llull from the shell with the `llull` CLI — the agent path (llull has no MCP server). Same command registry as the UI. Use when you have a terminal (Claude Code, CI, a cloud session) and need to build, inspect, measure, render or export a model — in the open llull desktop app (`--app`, the user sees it live) or on a document file; when a plan should live in a file (write plan.json, validate, apply); or when an export/render must land on disk (STL, STEP, code, sheets, PNG). Pairs with design-model (what to build) — this skill is how to run it.
---

# Skill: llull-cli

The CLI is **the agent path** (Claude Code, scripts, CI); there is no MCP server (LC1). It runs
any registry command — a third caller of `execute` (L1), so every command, present and future,
is there with no CLI change. Help: `llull help` · code: `server/src/cli/`.

**Invoke** `llull …` when installed (desktop app: Help › Install Command Line Tool → `~/.llull/bin`),
else from the repo `node server/bin/llull.cjs …` (bundles on first call, ~0.3 s per warm call).

## Pick the target first: `llull status`

| Situation                                              | Target                                                                                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| The llull desktop app is running (status says so)      | `--app` — the open window's document; the user sees each change live and can undo it (Ctrl+Z / `llull undo --app`) |
| No app, work on a file (headless, CI, a cloud session) | `--doc part.llull` (default `model.llull.json`, created on first change)                                           |
| A deployed / dev server                                | `--server URL --token T`                                                                                           |

Always one call per plan (`llull run plan.json`), not a loop of single calls.

## Procedure

1. **Find commands without loading schemas into context.**
   `llull search fillet edge` → `llull describe fillet_edge` (params, required, enums; nested objects, records and `one of:` union branches printed recursively; `--json` = raw schema).
   `llull list 3d` for a toolset; `llull toolsets`; `llull guide` for units/axes/id conventions.
2. **Write the plan as a file** (format: `design-model` skill; aliases `$name`, `=expr`):
   ```json
   [
     { "command": "set_units", "params": { "units": "mm" } },
     { "command": "add_box", "params": { "size": [80, 60, 10] }, "as": "plate" },
     { "command": "add_cylinder", "params": { "radius": 4, "height": 20 }, "as": "hole" },
     { "command": "boolean", "params": { "a": "$plate", "b": "$hole" } }
   ]
   ```
   **Loops / parameters:** don't generate long plans in a script. Use nestable loops and `=expr`
   (functions `sin cos sqrt min max floor round ...`, `pi`, loop var `i`); aliases interpolate:
   ```json
   [
     { "command": "set_parameter", "params": { "name": "n", "expression": "7" } },
     { "command": "set_parameter", "params": { "name": "r", "expression": "50" } },
     {
       "repeat": { "count": "=n", "as": "i" },
       "actions": [
         {
           "command": "add_cylinder",
           "as": "piston{i}",
           "params": {
             "radius": 4,
             "height": 30,
             "position": ["=r*cos(2*pi*i/n)", "=r*sin(2*pi*i/n)", 80]
           }
         }
       ]
     }
   ]
   ```
   (`for: {var, from, to, step}` also works; max 1000 iterations.) Then
   `llull set_parameter name=n expression=9 --doc part.llull.json` regenerates 9 pistons.
   `--validate` reports issues by path (`step 2 › iter 3 › step 0`).
3. **Validate, then apply** (aborts and rolls back on the first failing step):
   `llull run plan.json --validate --app` → fix issues → `llull run plan.json --app`
   (or `--doc part.llull` instead of `--app`).
   The report prints one line per step with the ids it created.
   **Camera:** it is document state; `llull run` frames it after a plan that built geometry
   without setting it (`fit_view direction=current`; `--no-fit` keeps it). Single `llull <cmd>`
   edits do not refit: end those with `llull fit_view --app`. Run `llull describe_scene --app` first:
   if the open document already has entities, ask the user before building into it or clearing it.
4. **Inspect / measure** (read-only, never written): `llull describe_scene`,
   `llull mass_properties entityId=mesh-4.1`, `llull check_model`. FEA / thermal results:
   `llull render_fea_results analysisId=an-… field=von_mises --save plot.png` (read-only contour plot).
5. **Look at it**: `llull render_view view=iso --save view.png --app` then read the PNG. FEA contour:
   `llull render_fea_results analysisId=an-… field=von_mises --save plot.png`. Saved SVG/PNG, DXF
   (`export_flat_pattern_dxf --save part.dxf`), IFC and `.glb` (binary chosen from the extension) all work.
   `run --validate` warns when a plan uses fillet/chamfer/shell: run those with `--kernel occt`.
6. **Exchange (Python/CadQuery bundled in the desktop app)**: `llull import_step file=supplier.step --app`,
   `llull export_step --save out/part.step --app` (exact B-rep), `llull import_dwg file=site.dwg
target=drawing` (needs a DWG converter). `llull list exchange` shows them all.
   **Export**: `llull export_stl format=binary --save out/part.stl`,
   `llull export_code language=cadquery --save out/`, sheets / `export_nc_files --save out/nc/`.
7. **Small fixes**: one `llull <command> key=value …` per edit. Undo: `--app` → the app's full
   history; `--doc` → one level (the `.bak` copy).
8. **Saving** with `--app` is the user's File › Save; tell them, or work on a `--doc` copy.

## Params syntax

- `key=value` pairs, each value parsed as JSON when possible: `size=[10,20,5] name=lid count=4`
  (string-typed params stay strings: `name=123` is `"123"`).
  Quote for the shell: `'position=[0,0,5]'`, `"name=top plate"`.
- One JSON object: `'{"size":[1,2,3]}'` · a file: `@params.json` · stdin: `-`.
- A value `@img:scan.png` is read as a PNG/JPEG data URL: trace a drawing with
  `llull add_image_underlay dataUrl=@img:scan.png`, then `calibrate_underlay` and `image_to_world`.
- `llull <command> …` is shorthand for `llull exec <command> …`.

## Flags

`--app` (desktop window; `LLULL_SERVER=app`) · `--doc FILE` (default `$LLULL_DOC` or
`model.llull.json`, created on first change) ·
`--server URL` / `--token T` (`$LLULL_SERVER`, `$LLULL_TOKEN`) · `--dry-run` (local, never writes) ·
`--save PATH` (`.png` rasterizes svg; several files → directory) · `--json` (one object: `ok`,
`summary`, `affected`, `changed`, `data`, `saved`) · `--quiet` · `--kernel occt` (exact B-rep:
`export_step_exact`, real fillets).

## Long plans: progress, timing, timeout

- `llull run plan.json --progress` (automatic on a terminal) streams `[12/189] boolean … 3.2s`
  per step to stderr, announcing kernel commands (booleans, fillets) before they start so a slow OCC
  boolean does not look like a hang. Steps over 10 s always print a `warning: slow step` line.
- Every step of the `--json` report carries `durationMs` (text mode shows steps over 1 s as `[3.2s]`).
  Local runs only: with `--server` the server runs the plan (progress/durations are not streamed).
- `--timeout SEC` bounds a whole run: exit `1`, "timed out after SEC s (--timeout) before step n/N",
  nothing saved. Local: checked before each plan step, plus a hard kill 5 s after the deadline for a
  single step that never ends (the CLI supervises itself in a child process); `--server`: per-request
  limit (default 120 s; the server may still finish the command).

## Exports carry names and colors

`export_gltf` writes one node per entity (name from `set_entity_name`, else id), a PBR material per
distinct color and group nodes for `group_entities` groups; `export_obj` one `o` object per entity;
`export_stl perEntity=true` one named solid per entity; `export_step_exact` (OCC) names each STEP
product after the entity (group name in the description) and colors its solid. Name entities before exporting.

## Exit codes (script on them)

`0` ok · `1` the command failed, a plan step failed, a change command changed nothing (read the
summary; setters and history commands are exempt), or `--save` could not write · `2` usage
error (unknown command — the message suggests close names; bad JSON; unreadable file; a value
flag such as `--save` given without its value).

## Rules

- Never edit the `.llull.json` document by hand — every change is a command (PRIME DIRECTIVE).
- Prefer one plan over a loop of single calls: one process, one transaction, one rollback.
- Text output is capped; for big data use `--json` with `jq`, or narrow the query
  (`find_entities`, ids) instead of dumping `describe_scene` for thousands of entities.
- A missing capability is a new command (`add-command`), never a CLI special case.
