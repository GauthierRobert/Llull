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
# step 3 · boolean_subtract
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
`extrude`, `revolve`, `mesh`, `union`, `cut`, `intersect`, `translate`, `remove`, `label`,
`custom`, `finish`). Each helper does two things:

1. It builds the real solid with CadQuery or build123d, so `python model.py` writes `model.step`
   and CQ-editor shows the model.
2. It records the llull command it corresponds to in `LLULL_TRACE`. `param()` returns a
   number that remembers its expression, so `thickness * 3` is recorded as the expression
   `thickness * 3`, not as `24`.

On import, the server runs the script and passes `LLULL_TRACE` to the registry command
`apply_code_trace`. That command sets the parameters, then runs each traced feature as its
llull command (`add_box`, `boolean_subtract`, …), keeping the `=expr` strings in the feature
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

| Variable                     | Default        | Meaning                                                                                                                                  |
| ---------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `LLULL_PYTHON`               | `python3`      | Python that has CadQuery. `off` disables the bridge.                                                                                     |
| `LLULL_PYTHON_BUILD123D`     | `LLULL_PYTHON` | Python that has build123d. build123d and CadQuery pin different OCP versions, so give each its own virtualenv.                           |
| `LLULL_PYTHON_TIMEOUT_MS`    | `120000`       | Per-request timeout. The process is killed after it.                                                                                     |
| `LLULL_EXCHANGE_DIR`         | unset          | Directory that the tools' `path` arguments resolve inside (no `..` or absolute paths). `export_step` also saves `<name>.step` there.     |
| `LLULL_ALLOW_CODE_EXECUTION` | unset          | `1` enables `import_code`. **It runs arbitrary Python with server privileges.** Enable it only on a machine whose MCP clients you trust. |
| `LLULL_BODY_LIMIT`           | `2mb`          | Raise it to send large STEP files inline as base64, or use `path` instead.                                                               |

Each bridge process runs with these limits:

- **Environment:** it gets an allow-listed environment (`PATH`, `HOME`, locale, `PYTHON*`,
  virtualenv/conda variables). Server secrets such as `MCP_AUTH_TOKEN` never reach it.
- **Concurrency:** at most two bridge processes run at once. The rest wait in a queue.
- **Output:** a response may be at most 128 MB.
- **Paths:** `path` arguments are checked again after following symbolic links. A link inside
  the exchange directory cannot read or write outside it, and an existing symbolic link is never
  overwritten.

Generated code never carries raw document text. Names go in string literals, and comments are
stripped of line breaks and `"""`. Numbers are formatted, and expressions are re-tokenised. So
a hostile document loaded with `load_document` cannot inject code into `export_step`.

### MCP tools

| Tool          | What it does                                                                                                                             |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `export_code` | Registry command (works offline, also in the UI). Returns `data.text`.                                                                   |
| `export_step` | `export_code` (CadQuery), evaluated by OpenCascade. Returns `structuredContent.stepBase64` and saves into `LLULL_EXCHANGE_DIR` when set. |
| `import_step` | `stepBase64` or `path`, producing `import_mesh` (undoable).                                                                              |
| `import_code` | `code` or `path`, `language`, `mode: replace / append`. Produces `apply_code_trace` (undoable).                                          |

HTTP downloads for the browser: `GET /export/code?language=cadquery|build123d|openscad|freecad`
and `GET /export/step` (503 when the bridge is not configured).

## DWG import (optional converter)

DWG is proprietary, so llull converts it to ASCII DXF on the server (core stays pure) and then runs
`import_dxf` / `import_survey_dxf` through the normal command path (live document, undo, live sync).
Install one converter on the server host:

- **LibreDWG** (free): `apt install libredwg-tools` (provides `dwg2dxf`). `LLULL_DWG2DXF=<path>`
  overrides the executable, `off` disables it.
- **ODA File Converter**: set `LLULL_ODA_CONVERTER=<executable>`; run as
  `<exe> in-dir out-dir ACAD2018 DXF 0 1 *.DWG` (used when `dwg2dxf` is missing).

`LLULL_DWG_TIMEOUT_MS` (default 60000) and `LLULL_DWG_MAX_BYTES` (default 50 MB) bound each
conversion; every request uses a private temp dir that is always removed.

- HTTP: `POST /import/dwg?target=drawing|survey&sourceUnit=m&layers=A,B` with the raw bytes
  (`application/octet-stream`) or JSON `{ "base64": "...", "target": "survey", "name": "..." }`.
  400 not a DWG (`AC10xx` header), 413 too large, 503 no converter installed, 504 timeout.
- MCP: `import_dwg { dwgBase64 | path, target, sourceUnit, layers, ... }` (toolset `exchange`).
- UI: Civil / Site panel › DWG file inputs (needs the server).

## Limits and known gaps

- STEP import gives meshes. Recognising analytic primitives and features in an arbitrary
  STEP file (feature recognition) is not done.
- Sketch-level 2D entities and constraints are not exported. Only 3D solids and the
  parameters that drive them are.
- Booleans replayed from a trace use the Manifold mesh kernel, which both the browser app and
  the MCP server load. Inside llull the boolean result is a mesh. In the code and in STEP export
  it stays an exact `cut`/`union`/`intersect`.
- build123d and CadQuery pin different OCP versions. Install them in separate virtualenvs and
  point `LLULL_PYTHON_BUILD123D` at the build123d one.
