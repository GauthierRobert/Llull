---
name: llull-modeling
description: Build a 3D part or small assembly in llull (local CAD) through the `llull` CLI — plan the part as numbers first, build it in a few `llull run` plan calls, and verify every stage with llull's measure commands against values you computed yourself. Use when asked to model, design, make or build a part, bracket, housing, plate, shaft, enclosure or fixture in llull.
---

# llull-modeling: build a part from numbers

llull is a local CAD app. Everything you do is a registered command run by the `llull` CLI; the desktop app shows the same
document live. You never edit the document file by hand.

## 0. Pick the target and the kernel

```bash
llull status            # desktop app running? -> use --app (the user watches); else --doc part.llull.json
llull kernel_info       # "occt" = exact B-rep (fillets, chamfers, shells, STEP). "manifold" = mesh only: no fillet/chamfer/shell
llull guide             # units, axes, id conventions
```

Find commands without guessing: `llull search <words>`, `llull list 3d`, `llull describe <command>` (exact params).

## 1. Plan as numbers before any command

Write down, in mm, before touching llull:

- the feature list in build order (base solid, added material, removed material, holes, patterns, edge breaks);
- every driving dimension as a named parameter (`t = 6`, `bolt_circle = 50`, `n = 6`);
- **the expected results you will check**: overall bounding box, volume (closed-form: box `w*d*h`, cylinder `pi*r^2*h`, hole
  `pi*(d/2)^2*depth`), and mass if a density is given (steel 0.00785 g/mm^3, aluminium 0.0027 g/mm^3).

Example: plate 80 x 60 x 10 with four through holes D8 → bbox `[80, 60, 10]`, V = 48000 − 4·π·4²·10 = 45989.4 mm³.

## 2. Build in a few plan calls (one per stage), never a loop of single commands

A plan is a JSON array of `{ "command", "params", "as" }`. `"as": "name"` binds the step's first resulting id; later steps say
`"$name"` (or `"$name[1]"`). Rebinding a name is allowed and usual (`"as": "body"` after every boolean). `=expr` strings use
parameters and loop variables.

```json
[
  { "command": "set_units", "params": { "units": "mm" } },
  { "command": "set_parameter", "params": { "name": "t", "expression": "10" } },
  { "command": "add_box", "params": { "size": [80, 60, "=t"], "anchor": "base-center" }, "as": "body" },
  {
    "repeat": { "count": 4, "as": "i" },
    "actions": [
      { "command": "add_cylinder", "as": "pin", "params": { "radius": 4, "height": 30,
        "position": ["=-30 + 60*(i % 2)", "=-20 + 40*floor(i / 2)", 5] } },
      { "command": "boolean", "params": { "op": "subtract", "a": "$body", "b": "$pin" }, "as": "body" }
    ]
  }
]
```

```bash
llull run stage1.json --validate --doc part.llull.json   # structure, names, params, aliases (no geometry)
llull run stage1.json --doc part.llull.json              # applies; a failing step rolls the whole plan back
```

Stage the work: (1) base + main bodies, (2) cuts and holes, (3) edge breaks (fillet/chamfer last). Verify after each stage.

Prefer the dedicated feature commands when they fit: `add_hole` (simple / counterbore / countersink, through or blind, drilled
INTO the face picked by `face.near`), `add_pocket`, `add_rib`, `shell_solid`, `array_linear` / `array_polar` for patterns,
`extrude_profile` (inline `profile` or a drawn sketch), `revolve_profile` (profile x = radius, y = axial position).

## 3. Verify every stage against your own numbers

```bash
llull measure_bounding_box --doc part.llull.json            # whole model: data.size
llull mass_properties entityId=<id> --doc part.llull.json   # data.volume, data.method ("exact" or "mesh")
llull check_model --doc part.llull.json                     # structural issues, parameter errors
llull check_assembly ids='["<id>"]' thickness=off --doc part.llull.json   # valid closed solid? (FPR_PART_INVALID / EMPTY / SHEET)
```

- Compare to your expectation. Exact kernel: volumes agree to ~1e-6 relative. Mesh kernel (`method: "mesh"`): curved faces
  are faceted, expect up to ~1 % low on cylinders and spheres.
- If a number disagrees, stop and find out why before adding more features (usually a wrong position anchor or a hole that
  missed the material).
- Look at it: `llull render_view view=iso --save view.png --doc part.llull.json`, then open the PNG.

## Known traps

- `add_box` `position` is the CENTRE unless `anchor` is `"min"` or `"base-center"`; `add_cylinder` / `add_sphere` `position` is the
  centre; +Z is up; every rotation is in RADIANS.
- `boolean`, `fillet_edge`, `chamfer_edge`, `shell_solid` and `add_hole` CONSUME their inputs and create a new id: always rebind
  (`"as": "body"`) and never reuse the old id.
- `array_linear` / `array_polar` `count` includes the original; the result binds the NEW copies only (`$copies[0]` is the first copy).
- With the Manifold kernel `fillet_edge`, `chamfer_edge` and `shell_solid` do nothing and the CLI exits 1: check `kernel_info` first.
- `run --validate` does not run geometry: a hole that misses the part or a fillet too large only fails on the real run.
- Exit codes: 0 ok, 1 a command failed or changed nothing (read the summary), 2 usage error.
- `--app` acts on the user's open document: run `llull describe_scene --app` first and ask before building into a non-empty one.

## Done

Bounding box, volume (and mass) match your numbers; `check_model` has no error; `check_assembly` reports no invalid part; a render
looks right. Report the measured values next to the expected ones.
