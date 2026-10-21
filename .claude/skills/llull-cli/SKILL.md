---
name: llull-cli
description: Drive llull from the shell with the `llull` CLI — the agent path (llull has no MCP server). Same command registry as the UI. Use when you have a terminal (Claude Code, CI, a cloud session) and need to build, inspect, measure, render or export a model — in the open llull desktop app (`--app`, the user sees it live) or on a document file; when a plan should live in a file (write plan.json, validate, apply); or when an export/render must land on disk (STL, STEP, code, sheets, PNG). Pairs with design-model (what to build) — this skill is how to run it.
---

# Skill: llull-cli

The CLI is **the agent path** (Claude Code, scripts, CI); there is no MCP server (LC1). It runs
any registry command — a third caller of `execute` (L1), so every command, present and future,
is there with no CLI change. Code: `server/src/cli/`.

**Source of truth — read these, this skill does not repeat them:** `llull help` (subcommands, params syntax,
flags, exit codes) · `llull guide` (units, +Z up, anchors, radians, the agent loop, domain workflows) ·
`llull describe <command>` (exact params). This skill is the workflow.

**Invoke** `llull …` when installed (desktop app: Help › Install Command Line Tool → `~/.llull/bin`),
else from the repo `node server/bin/llull.cjs …` (bundles on first call, ~0.3 s per warm call).

## Pick the target first: `llull status`

| Situation                                              | Target                                                                                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| The llull desktop app is running (status says so)      | `--app` — the open window's document; the user sees each change live and can undo it (Ctrl+Z / `llull undo --app`) |
| No app, work on a file (headless, CI, a cloud session) | `--doc part.llull` (default `model.llull.json`, created on first change)                                           |
| A llull backend started separately (CI, scripted host) | `--server URL --token T`                                                                                           |

Always one call per plan (`llull run plan.json`), not a loop of single calls.

## Procedure

1. **Find commands without loading schemas into context.**
   `llull search fillet edge` → `llull describe fillet_edge` (params, required, enums; nested objects, records and `one of:` union branches printed recursively; `--json` = raw schema).
   `llull list 3d` for a toolset; `llull toolsets`; `llull guide` for units/axes/id conventions.
2. **Write the plan as a file** — format, aliases (`as` / `$name`), `=expr` and nestable `repeat` / `for` loops:
   `design-model` skill §2 (prefer a `.lld` design there). Never generate a long plan in a script: loop in the plan, then
   `llull set_parameter name=n expression=9 --doc part.llull.json` regenerates it. `--validate` reports issues by path
   (`step 2 › iter 3 › step 0`).
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
   `run --validate` warns when a plan uses fillet/chamfer/shell and the active kernel is Manifold (the native `llull-kernel` was not found:
   build it in `solver/` or set `LLULL_NATIVE_DIR`; `llull kernel_info` shows the active kernel and why).
6. **Exchange (Python/CadQuery bundled in the desktop app)**: `llull import_step file=supplier.step --app`,
   `llull export_step --save out/part.step --app` (exact B-rep), `llull import_dwg file=site.dwg
target=drawing` (needs a DWG converter). `llull list exchange` shows them all.
   **Export**: `llull export_stl format=binary --save out/part.stl`,
   `llull export_code language=cadquery --save out/`, sheets / `export_nc_files --save out/nc/`.
7. **Small fixes**: one `llull <command> key=value …` per edit. Undo: `--app` → the app's full
   history; `--doc` → one level (the `.bak` copy).
8. **Saving** with `--app` is the user's File › Save; tell them, or work on a `--doc` copy.

## Not in `llull help` (keep in mind)

- A value `@text:part.lld` is read as the file's UTF-8 text: `llull apply_design source=@text:part.lld` (design-model skill;
  `check_design` gates on its checks, `export_design --save part.lld` writes it back). `@img:scan.png` → `add_image_underlay`,
  then `calibrate_underlay` and `image_to_world`.
- `import_code file=part.py` needs `LLULL_ALLOW_CODE_EXECUTION=1` and `LLULL_PYTHON` (a python with CadQuery); a plain script
  imports as frozen meshes — prefer a `.lld` design for an editable model.
- Quote shell values: `'position=[0,0,5]'`, `"name=top plate"`. `LLULL_SERVER=app` = `--app`.
- `--json` prints one object: `ok`, `summary`, `affected`, `changed`, `data`, `saved`; each `run` step carries `durationMs`
  (text mode marks steps over 1 s as `[3.2s]`).
- Exit 1 on "changed nothing" exempts setters and history commands; `--save` failing to write is also exit 1.
- `--progress` announces kernel commands (booleans, fillets) before they start, so a slow OCC step does not look like a hang;
  with `--server` the server runs the plan (no progress, no durations).

## Exports carry names and colors

`export_gltf` writes one node per entity (name from `set_entity_name`, else id), a PBR material per
distinct color and group nodes for `group_entities` groups; `export_obj` one `o` object per entity;
`export_stl perEntity=true` one named solid per entity; `export_step_ap242` (OCC) names each STEP
product after the entity (group name in the description) and colors its solid. Name entities before exporting.

## Rules

- Never edit the `.llull.json` document by hand — every change is a command (PRIME DIRECTIVE).
- Prefer one plan over a loop of single calls: one process, one transaction, one rollback.
- Text output is capped; for big data use `--json` with `jq`, or narrow the query
  (`find_entities`, ids) instead of dumping `describe_scene` for thousands of entities.
- A missing capability is a new command (`add-command`), never a CLI special case.
