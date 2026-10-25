# STEP and parametric-code exchange

llull can move a model in and out of three forms:

| Form                                                              | Direction | Fidelity                                                                                        | Needs                                                 |
| ----------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **Parametric code**: CadQuery, build123d, OpenSCAD, FreeCAD macro | export    | Exact and parametric: parameters, expressions and feature order                                 | nothing (pure TypeScript)                             |
| **Parametric code**: CadQuery / build123d                         | import    | Exact and parametric when the script uses the llull runtime; any other script imports as meshes | server Python bridge + `LLULL_ALLOW_CODE_EXECUTION=1` |
| **STEP** (AP214)                                                  | export    | Exact B-rep (OpenCascade), names and colours kept                                               | server Python bridge                                  |
| **STEP**                                                          | import    | Each solid becomes a mesh entity with its STEP name and colour                                  | server Python bridge                                  |

## Why code is the main format

A llull document is a _recipe_: parameters plus a feature history (architecture L8).
`export_code` writes that recipe out as source code:

```python
# ── PARAMETERS ─────────────────────────────
width = param("width", 80)
thickness = param("thickness", width / 10)

# ── MODEL ──────────────────────────────────
# step 1 · add_box
box_1 = box((width, 40, thickness), position=(0, 0, thickness / 2), color="#8899aa")
# step 2 · add_cylinder
cylinder_1 = cylinder(6, thickness * 3, position=(20, 0, 4), color="#6b8f9c")
# step 3 · boolean
box_1 = cut(box_1, cylinder_1)
# step 4 · set_entity_name
label(box_1, "Base plate")

result = finish()
```

A person or an agent can read the exact dimensions, the parameter relations and the build
order from this file, edit it, and send it back. `import_code` rebuilds the model as an
**editable llull feature history**. The `=width` and `=thickness / 2` bindings survive, so
`set_parameter` followed by `replay_history` regenerates the model.

### How the round trip works

The generated CadQuery/build123d file is standalone. Its first block is a small runtime of
helpers (`param`, `box`, `cylinder`, `sphere`, `cone`, `torus`, `wedge`, `pyramid`,
`extrude`, `revolve`, `sweep_profile`, `loft_sections`, `swept`, `mesh`, `union`, `cut`, `intersect`,
`translate`, `remove`, `label`, `custom`, `finish`). Each helper does two things:

1. It builds the real solid with CadQuery or build123d, so `python model.py` writes `model.step`
   and CQ-editor shows the model.
2. It records the llull command it corresponds to in `LLULL_TRACE`. `param()` returns a
   number that remembers its expression, so `thickness * 3` is recorded as the expression
   `thickness * 3`, not as `24`.

On import, the server runs the script and passes `LLULL_TRACE` to the registry command
`apply_code_trace`. That command sets the parameters, then runs each traced feature as its
llull command (`add_box`, `boolean`, …), keeping the `=expr` strings in the feature
history. Only the whitelisted commands the runtime emits can appear in a trace.

Loops, functions and `math` work. Anything computed from parameters with `+ - * /` keeps its
expression, and anything else (for example `math.cos(angle)`) is recorded as its value. Raw
CadQuery/build123d code is welcome: wrap a shape built with the library directly in
`custom(shape)` to include it. It is imported as a mesh, so it is not editable in llull.

A script that does not use the runtime still imports. Its `result` variable or its
`show_object(...)` shapes are tessellated and imported as meshes.

### OpenSCAD and FreeCAD

`export_code` with `language: "openscad"` writes a `.scad` file. Parameters become top-level
variables (Customizer-ready), and each feature version becomes a module so booleans keep
their order. `language: "freecad"` writes a `.FCMacro` that rebuilds the model with the Part
workbench in a new document, with named and coloured objects. Both are export-only.

## Conventions in generated code

- Positions are in document units. The frame is right-handed with +Z up.
- Rotations are XYZ Euler angles **in degrees**, applied about Z, then Y, then X, around the
  solid's origin. This is llull's convention (internally in radians).
- Each primitive's `position` is the point llull stores: the centre for box, cylinder,
  sphere and torus, the base centre for cone and pyramid, the min corner for wedge, and the
  profile origin for extrude and revolve.
- Sweeps and lofts are one `sweep_profile(build, exported, <params>)` / `loft_sections(...)` call each. The keywords
  are the step's own params (numbers keep their `=expr` bindings), so `import_code` rebuilds the editable
  `sweep_profile` / `loft_sections` step. `build` says how the script builds the solid: the library's own pipe shell,
  exact helix, mitre or thru-sections where that is faithful, otherwise fitted B-spline faces kept in a
  `_SWG_FACES = {...}` data section between PARAMETERS and MODEL. Only the `radius` / `innerRadius` of a pipe are
  read by the script (edited, they change the built solid, and a value `sweep_profile` would refuse - radius not above the bore, a bend or a mitre reach the section no longer fits - raises `SWG_CODEGEN_UNSUPPORTED`, as `import_code` would refuse it; a `radius` on a bent points path without an explicit `bendRadius` is not read, the bends were resolved from it); a keyword edited, added or removed any other way makes the script
  warn `SWG_CODEGEN_STALE` at the edited call (the solid is still the exported one) and takes effect through `import_code`. A sweep or loft that names other entities (`pathId`, `guideIds`,
  `sectionIds`, ...) is the untraced `swept(build, ...)` and comes back as a mesh; an explicit `id` / `layerId` travel with
  the params (appending a trace whose `id` the document already holds re-mints it and lists `old → new` in the summary). A solid the code cannot build raises `SWG_CODEGEN_UNSUPPORTED: <subject>: <why>`; `export_step` then falls back
  to the exact OCC kernel when it is available, and says so. Which variants use which construction:
  `docs/design/02-sweep-loft-guides/TECHNICAL_SPEC.md` section 15.
- Geometry with no analytic form (boolean results with no recorded operands, fillets,
  assembly instances, imported STEP bodies) is written as `mesh([...])` triangles. The code
  carries a `Note:` line when this happens.

## Running the Python bridge

The STEP tools and `import_code` run `server/python/llull_bridge.py` in a short-lived Python
process, one per request, with a timeout:

```bash
pip install -r server/python/requirements.txt     # CadQuery (OpenCascade)
LLULL_PYTHON=python3 npm --prefix server run dev   # python3 is the default
```

| Variable                     | Default        | Meaning                                                                                                                              |
| ---------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `LLULL_PYTHON`               | `python3`      | Python that has CadQuery. `off` disables the bridge.                                                                                 |
| `LLULL_PYTHON_BUILD123D`     | `LLULL_PYTHON` | Python that has build123d. build123d and CadQuery pin different OCP versions, so give each its own virtualenv.                       |
| `LLULL_PYTHON_TIMEOUT_MS`    | `120000`       | Per-request timeout. The process is killed after it.                                                                                 |
| `LLULL_EXCHANGE_DIR`         | unset          | Directory that the tools' `path` arguments resolve inside (no `..` or absolute paths). `export_step` also saves `<name>.step` there. |
| `LLULL_ALLOW_CODE_EXECUTION` | unset          | `1` enables `import_code`. **It runs arbitrary Python with server privileges.** Enable it only on a machine you trust.               |
| `LLULL_BODY_LIMIT`           | `2mb`          | Raise it to send large STEP files inline as base64, or use `path` instead.                                                           |

Each bridge process runs with these limits:

- **Environment:** it gets an allow-listed environment (`PATH`, `HOME`, locale, `PYTHON*`,
  virtualenv/conda variables). Server secrets such as the desktop app's token (`LLULL_AUTH_TOKEN`) never reach it.
- **Concurrency:** at most two bridge processes run at once. The rest wait in a queue.
- **Output:** a response may be at most 128 MB.
- **Paths:** `path` arguments are checked again after following symbolic links. A link inside
  the exchange directory cannot read or write outside it, and an existing symbolic link is never
  overwritten.

Generated code never carries raw document text. Names go in string literals, and comments are
stripped of line breaks and `"""`. Numbers are formatted, and expressions are re-tokenised. So
a hostile document loaded with `load_document` cannot inject code into `export_step`.

### Exchange tools

| Tool          | What it does                                                                                                                                               |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `export_code` | Registry command (works offline, also in the UI). Returns `data.text`.                                                                                     |
| `export_step` | `export_code` (CadQuery), evaluated by OpenCascade. Returns `data.stepBase64` (`--save part.step` writes it) and saves into `LLULL_EXCHANGE_DIR` when set. |
| `import_step` | `stepBase64` or `path`, producing `import_mesh` (undoable).                                                                                                |
| `import_code` | `code` or `path`, `language`, `mode: replace / append`. Produces `apply_code_trace` (undoable).                                                            |

HTTP downloads for the browser: `GET /export/code?language=cadquery|build123d|openscad|freecad`
and `GET /export/step` (503 when the bridge is not configured).

### CLI (agents, desktop app)

These tools run from the `llull` CLI: in-process on a `--doc` file, or through
`POST /exchange { name, params }` with `--app` / `--server`. `file=<path>` reads a local file
into the content parameter (`stepBase64`, `dwgBase64`, or `code`), and `--save` writes the result:

```bash
llull export_step --save part.step --app
llull import_step file=supplier.step --app
llull import_code file=bracket.py mode=append --doc part.llull   # needs LLULL_ALLOW_CODE_EXECUTION=1
```

The desktop app ships its own Python with CadQuery (`desktop/scripts/prepare-python.mjs`), so
these tools work there with nothing else installed.

## DWG import (optional converter)

DWG is proprietary, so llull converts it to ASCII DXF on the server (core stays pure) and then runs
`import_dxf` / `import_survey_dxf` through the normal command path (live document, undo, live sync).
Install one converter on the server host:

- **LibreDWG** (free, GPL-3.0, run as a separate program): version 0.14 or later provides `dwg2dxf`.
  Build it from the GNU release and put it on the `PATH` (Debian stable does not
  package it, and versions up to 0.13.4 have known CVEs). `LLULL_DWG2DXF=<path>`
  overrides the executable, `off` disables it.
- **ODA File Converter**: set `LLULL_ODA_CONVERTER=<executable>`; run as
  `<exe> in-dir out-dir ACAD2018 DXF 0 1 *.DWG` (used when `dwg2dxf` is missing).

`LLULL_DWG_TIMEOUT_MS` (default 60000) and `LLULL_DWG_MAX_BYTES` (default 50 MB) bound each
conversion; every request uses a private temp dir that is always removed.

- HTTP: `POST /import/dwg?target=drawing|survey&sourceUnit=m&layers=A,B` with the raw bytes
  (`application/octet-stream`) or JSON `{ "base64": "...", "target": "survey", "name": "..." }`.
  400 not a DWG (`AC10xx` header), 413 too large, 503 no converter installed, 504 timeout.
- CLI: `llull exec import_dwg file=plan.dwg target=drawing …` (`dwgBase64 | path`, `target`, `sourceUnit`, `layers`, …; toolset `exchange`).
- UI: Civil / Site panel › DWG file inputs (needs the server).

## 3MF, URDF, AP242 and mesh-to-solid (SC-D4)

Registry commands (work offline, UI and CLI; `--save` writes the file):

| Command                               | Result                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `export_3mf`                          | 3MF package (ZIP: `[Content_Types].xml`, `_rels/.rels`, `3D/3dmodel.model`), one object per body with its name and colour (base material), build items, units millimetre, welded indexed mesh; `data.objects[].manifold` says whether each body is a closed shell. `--save part.3mf`.                                                                                    |
| `export_urdf`                         | URDF tree + one STL per link (`--save DIR` keeps `meshes/`). Bodies and joints come from the dynamics model, else from assembly instances + `add_joint`. Inertial from `mass_properties`; revolute joints are `continuous` (no angle limits are stored), prismatic joints get a `prismaticTravel` limit. Spherical and loop-closing joints are reported in `data.notes`. |
| `export_step_ap242` `schema: "ap242"` | Same exact B-rep, names, colours and assembly structure, with the AP242 `FILE_SCHEMA` / application protocol declarations (text-level; AP214 stays the default).                                                                                                                                                                                                         |
| `mesh_to_solid`                       | Rebuilds a constant-section prism mesh (two parallel cap planes, side faces parallel to the axis) as `extrude_profile`, holes as subtracted extruded tools (needs the kernel). Refuses spheres, tapers and multi-region parts.                                                                                                                                           |

IGES needs the native OCCT sidecar and is not covered here. Limits: 3MF carries identity build transforms (geometry is baked in
world space) and no textures; URDF joint frames are world-aligned; `mesh_to_solid` recovers polygons, not arcs.

## Limits and known gaps

- STEP import gives meshes. Recognising analytic primitives and features in an arbitrary
  STEP file (feature recognition) is not done.
- Sketch-level 2D entities and constraints are not exported. Only 3D solids and the
  parameters that drive them are.
- Booleans replayed from a trace use the Manifold mesh kernel, which both the desktop app and
  the backend / CLI load. Inside llull the boolean result is a mesh. In the code and in STEP export
  it stays an exact `cut`/`union`/`intersect`.
- build123d and CadQuery pin different OCP versions. Install them in separate virtualenvs and
  point `LLULL_PYTHON_BUILD123D` at the build123d one.
