---
name: llull-cli
description: Drive llull from the shell with the `llull` CLI — the same command registry as the UI and MCP, without a running server or MCP connection. Use when you have a terminal (Claude Code, CI, a cloud session) and need to build, inspect, measure, render or export a model; when the llull MCP server is not connected; when a plan should live in a file (write plan.json, validate, apply); or when an export/render must land on disk (STL, STEP, code, sheets, PNG). Pairs with design-model (what to build) — this skill is how to run it.
---

# Skill: llull-cli

`node server/bin/llull.cjs …` (alias `npm run -s llull -- …`) runs any registry command on a
local document file, or on a running server's live document with `--server`. It is a third
caller of `execute` (L1): no capability of its own, so every command — present and future — is
available with no CLI change. Code: `server/src/cli/` · help: `llull help`.

> First call bundles the CLI (~0.6 s); later calls reuse the bundle (~0.3 s) until a source changes.
> In the snippets `llull` = `node server/bin/llull.cjs` (from the repo root).

## When CLI vs MCP
| Situation | Use |
| --------- | --- |
| Terminal agent, no server / MCP not connected | CLI on a local `--doc` file |
| Many steps | ONE `llull run plan.json` (build_project) — not many single calls |
| Exports / renders you need as files | CLI `--save PATH` |
| The user watches the open app | CLI `--server http://localhost:3001` (or the MCP tools) |
| Client without a shell (Claude Desktop, claude.ai) | MCP only |

## Procedure
1. **Find commands without loading schemas into context.**
   `llull search fillet edge` → `llull describe fillet_edge` (params, required, enums).
   `llull list 3d` for a toolset; `llull toolsets`; `llull guide` for units/axes/id conventions.
2. **Write the plan as a file** (format: `design-model` skill; aliases `$name`, `=expr`):
   ```json
   [ { "command": "set_units", "params": { "units": "mm" } },
     { "command": "add_box", "params": { "size": [80, 60, 10] }, "as": "plate" },
     { "command": "add_cylinder", "params": { "radius": 4, "height": 20 }, "as": "hole" },
     { "command": "boolean_subtract", "params": { "a": "$plate", "b": "$hole" } } ]
   ```
3. **Validate, then apply** (aborts and rolls back on the first failing step):
   `llull run plan.json --validate --doc part.llull.json` → fix issues → `llull run plan.json --doc part.llull.json`.
   The report prints one line per step with the ids it created.
4. **Inspect / measure** (read-only, never written): `llull describe_scene`,
   `llull measure_volume entityId=mesh-4.1`, `llull check_model`.
5. **Look at it**: `llull render_view view=iso --save view.png` then read the PNG.
6. **Export**: `llull export_stl format=binary --save out/part.stl`,
   `llull export_code language=cadquery --save out/`, sheets / `export_nc_files --save out/nc/`.
7. **Small fixes**: one `llull <command> key=value …` per edit; `llull undo` reverts the last
   saved change (one level: the `.bak` copy).

## Params syntax
- `key=value` pairs, each value parsed as JSON when possible: `size=[10,20,5] name=lid count=4`
  (string-typed params stay strings: `name=123` is `"123"`).
  Quote for the shell: `'position=[0,0,5]'`, `"name=top plate"`.
- One JSON object: `'{"size":[1,2,3]}'` · a file: `@params.json` · stdin: `-`.
- `llull <command> …` is shorthand for `llull exec <command> …`.

## Flags
`--doc FILE` (default `$LLULL_DOC` or `model.llull.json`, created on first change) ·
`--server URL` / `--token T` (`$LLULL_SERVER`, `$LLULL_TOKEN`) · `--dry-run` (local, never writes) ·
`--save PATH` (`.png` rasterizes svg; several files → directory) · `--json` (one object: `ok`,
`summary`, `affected`, `changed`, `data`, `saved`) · `--quiet` · `--kernel occt` (exact B-rep:
`export_step_exact`, real fillets).

## Long plans: progress, timing, timeout
- `llull run plan.json --progress` (automatic on a terminal) streams `[12/189] boolean_subtract … 3.2s`
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
- Output is capped like MCP results; for big data use `--json` with `jq`, or narrow the query
  (`find_entities`, ids) instead of dumping `describe_scene` for thousands of entities.
- A missing capability is a new command (`add-command`), never a CLI special case.
