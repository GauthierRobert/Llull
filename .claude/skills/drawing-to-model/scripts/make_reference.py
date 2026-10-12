"""Turn a reference CAD script (build123d / CadQuery) into a reference solid for compare_meshes.py.

Usage: python -I make_reference.py SCRIPT.py OUT_BASENAME [VARIABLE]
Runs SCRIPT (viewer calls such as ocp_vscode show()/show_object() are stubbed), picks VARIABLE
(a Part/Shape or a BuildPart) or else the largest solid it defines, and writes OUT_BASENAME.stl
(fine tessellation) + OUT_BASENAME.json (exact volume, bounding box).
Needs: pip install build123d
"""

import contextlib
import io
import json
import pathlib
import runpy
import sys
import types

from build123d import Shape, export_stl
from build123d import BuildPart

viewer = types.ModuleType("ocp_vscode")
for name in ("show", "show_object", "show_all", "set_port", "set_defaults"):
    setattr(viewer, name, lambda *a, **k: None)
viewer.Camera = types.SimpleNamespace(RESET=None, KEEP=None, CENTER=None)
sys.modules["ocp_vscode"] = viewer

src, out = sys.argv[1], pathlib.Path(sys.argv[2])
wanted = sys.argv[3] if len(sys.argv) > 3 else None
with contextlib.redirect_stdout(io.StringIO()) as printed:
    scope = runpy.run_path(src, init_globals={"show_object": lambda *a, **k: None}, run_name="__main__")
solids = []
for key, value in scope.items():
    shape = value.part if isinstance(value, BuildPart) else value
    if not key.startswith("_") and isinstance(shape, Shape) and shape.volume > 1e-6:
        solids.append((shape.volume, key, shape))
if not solids:
    sys.exit(f"{src}: defines no solid")
volume, key, shape = next((s for s in solids if s[1] == wanted), max(solids, key=lambda s: s[0]))
export_stl(shape, str(out.with_suffix(".stl")), tolerance=0.01, angular_tolerance=0.1)
box = shape.bounding_box()
report = {"variable": key, "volume": volume, "bbox_min": list(box.min), "bbox_max": list(box.max),
          "stdout": printed.getvalue().strip()}
out.with_suffix(".json").write_text(json.dumps(report, indent=1))
print(f"{key}: volume {volume:.3f}, extents {[round(b - a, 3) for a, b in zip(box.min, box.max)]}")
