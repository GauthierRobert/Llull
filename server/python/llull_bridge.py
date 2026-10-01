#!/usr/bin/env python3
"""
llull Python bridge — STEP and parametric-code exchange for the llull server.

Reads ONE JSON request on stdin, writes ONE JSON response on stdout. Script output
(print) is redirected to stderr so it can never corrupt the response.

Requests:
  {"op": "probe"}
      -> {"ok": true, "python": "3.x", "cadquery": "2.x" | null, "build123d": "0.x" | null}
  {"op": "run", "language": "cadquery" | "build123d", "source": "<python>",
   "step": bool, "tolerance": float}
      Executes the script. llull-generated (or llull-runtime) scripts yield their
      LLULL_TRACE; any other script yields its `result` / show_object() shapes as
      tessellated bodies wrapped in an import_mesh trace.
      -> {"ok": true, "trace": {...}, "traced": bool, "stepBase64"?: "...", "log": "..."}
  {"op": "import_step", "stepBase64": "...", "tolerance": float}
      -> {"ok": true, "bodies": [{"name", "color", "positions"}], "log": "..."}

Errors -> {"ok": false, "error": "...", "log": "..."} (exit code 0; the caller reads ok).
"""

import base64
import contextlib
import io
import json
import os
import runpy
import sys
import tempfile
import traceback


def _module_version(name):
    try:
        module = __import__(name)
        return str(getattr(module, "__version__", "unknown"))
    except Exception:  # noqa: BLE001 - an absent or broken library just reports null
        return None


# ---------------------------------------------------------------------------
# Tessellation (OCP-level so it serves CadQuery and build123d shapes alike)
# ---------------------------------------------------------------------------


def _topods(obj):
    """Best-effort conversion of a CadQuery/build123d object to a TopoDS_Shape."""
    if obj is None:
        return None
    if hasattr(obj, "toCompound"):  # cq.Assembly
        return obj.toCompound().wrapped
    if hasattr(obj, "vals") and callable(obj.vals):  # cq.Workplane
        shapes = [v.wrapped for v in obj.vals() if hasattr(v, "wrapped")]
        return _compound(shapes)
    if hasattr(obj, "part") and not hasattr(obj, "wrapped"):  # build123d BuildPart
        return _topods(obj.part)
    if hasattr(obj, "wrapped"):
        return obj.wrapped
    if isinstance(obj, (list, tuple)):
        return _compound([s for s in (_topods(o) for o in obj) if s is not None])
    return None


def _compound(shapes):
    from OCP.BRep import BRep_Builder
    from OCP.TopoDS import TopoDS_Compound

    builder = BRep_Builder()
    compound = TopoDS_Compound()
    builder.MakeCompound(compound)
    for shape in shapes:
        builder.Add(compound, shape)
    return compound


def _solids(shape):
    from OCP.TopAbs import TopAbs_SOLID
    from OCP.TopExp import TopExp_Explorer

    found = []
    explorer = TopExp_Explorer(shape, TopAbs_SOLID)
    while explorer.More():
        found.append(explorer.Current())
        explorer.Next()
    return found or [shape]


def _triangles(shape, tolerance):
    """World-space triangle soup [x0,y0,z0, ...] with outward (counter-clockwise) winding."""
    from OCP.BRep import BRep_Tool
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.TopAbs import TopAbs_FACE, TopAbs_REVERSED
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopLoc import TopLoc_Location
    from OCP.TopoDS import TopoDS

    BRepMesh_IncrementalMesh(shape, tolerance, False, 0.3, True)
    positions = []
    explorer = TopExp_Explorer(shape, TopAbs_FACE)
    while explorer.More():
        face = TopoDS.Face_s(explorer.Current())
        location = TopLoc_Location()
        triangulation = BRep_Tool.Triangulation_s(face, location)
        if triangulation is not None:
            transform = location.Transformation()
            reversed_face = face.Orientation() == TopAbs_REVERSED
            for i in range(1, triangulation.NbTriangles() + 1):
                a, b, c = triangulation.Triangle(i).Get()
                corners = (a, c, b) if reversed_face else (a, b, c)
                for index in corners:
                    point = triangulation.Node(index).Transformed(transform)
                    positions.extend((point.X(), point.Y(), point.Z()))
        explorer.Next()
    return positions


def _bodies_from(obj, tolerance, name="solid", color=None):
    shape = _topods(obj)
    if shape is None:
        return []
    solids = _solids(shape)
    bodies = []
    for index, solid in enumerate(solids):
        positions = _triangles(solid, tolerance)
        if not positions:
            continue
        body = {"name": name if len(solids) == 1 else "%s_%d" % (name, index + 1), "positions": positions}
        if color:
            body["color"] = color
        bodies.append(body)
    return bodies


# ---------------------------------------------------------------------------
# op: run
# ---------------------------------------------------------------------------


def _run_script(source, language):
    shown = []

    def show_object(obj, name=None, options=None, **_kwargs):  # CQ-editor compatible collector
        shown.append((obj, name))

    workdir = tempfile.mkdtemp(prefix="llull-run-")
    path = os.path.join(workdir, "model.py")
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(source)
    cwd = os.getcwd()
    try:
        os.chdir(workdir)
        namespace = runpy.run_path(path, init_globals={"show_object": show_object}, run_name="__llull__")
    finally:
        os.chdir(cwd)
    return namespace, shown


def _export_step(model, language, path):
    if language == "build123d":
        import build123d as bd

        bd.export_step(model, path)
        return
    import cadquery as cq

    if isinstance(model, cq.Assembly):
        model.save(path, exportType="STEP")
    else:
        cq.exporters.export(model, path, exportType="STEP")


def op_run(request):
    language = request.get("language", "cadquery")
    if language not in ("cadquery", "build123d"):
        raise ValueError("language must be cadquery or build123d")
    tolerance = float(request.get("tolerance", 0.01))
    namespace, shown = _run_script(request["source"], language)

    trace = namespace.get("LLULL_TRACE")
    traced = isinstance(trace, dict) and isinstance(trace.get("features"), list)
    if traced:
        model = namespace["finish"]() if callable(namespace.get("finish")) else namespace.get("result")
    else:
        targets = shown or ([(namespace["result"], "result")] if "result" in namespace else [])
        if not targets:
            raise ValueError("script defines no llull model, no `result` and calls no show_object()")
        bodies = []
        for index, (obj, name) in enumerate(targets):
            bodies.extend(_bodies_from(obj, tolerance, name or "shape_%d" % (index + 1)))
        if not bodies:
            raise ValueError("the script's result contains no solid geometry")
        trace = {"version": 1, "parameters": [], "features": [{"command": "import_mesh", "params": {"bodies": bodies}}]}
        model = targets[0][0] if len(targets) == 1 else [t[0] for t in targets]

    response = {"ok": True, "trace": trace, "traced": traced}
    if request.get("step"):
        if isinstance(model, list):
            import cadquery as cq

            model = cq.Compound.makeCompound([cq.Shape.cast(_topods(m)) for m in model])
        with tempfile.TemporaryDirectory(prefix="llull-step-") as workdir:
            path = os.path.join(workdir, "model.step")
            _export_step(model, language, path)
            with open(path, "rb") as handle:
                response["stepBase64"] = base64.b64encode(handle.read()).decode("ascii")
    return response


# ---------------------------------------------------------------------------
# op: import_step
# ---------------------------------------------------------------------------


def _hex(color):
    try:
        r, g, b, _a = color.toTuple()
    except Exception:  # noqa: BLE001 - colour is optional metadata
        return None
    return "#%02x%02x%02x" % tuple(max(0, min(255, round(c * 255))) for c in (r, g, b))


def _assembly_bodies(path, tolerance):
    import cadquery as cq

    assembly = cq.Assembly.importStep(path)
    bodies = []
    for name, child in assembly.traverse():
        if child.obj is None:
            continue
        shape = child.obj.moved(child.loc) if hasattr(child.obj, "moved") else child.obj
        location = _world_location(assembly, child)
        if location is not None:
            shape = child.obj.moved(location)
        color = _hex(child.color) if child.color is not None else None
        bodies.extend(_bodies_from(shape, tolerance, name.split("/")[-1] or "solid", color))
    return bodies


def _world_location(root, target):
    """Accumulated location of `target` from the assembly root (None if not found)."""

    def walk(node, location):
        current = location * node.loc
        if node is target:
            return current
        for child in node.children:
            found = walk(child, current)
            if found is not None:
                return found
        return None

    import cadquery as cq

    return walk(root, cq.Location())


def op_import_step(request):
    tolerance = float(request.get("tolerance", 0.05))
    data = base64.b64decode(request["stepBase64"])
    with tempfile.TemporaryDirectory(prefix="llull-import-") as workdir:
        path = os.path.join(workdir, "input.step")
        with open(path, "wb") as handle:
            handle.write(data)
        bodies = []
        try:
            bodies = _assembly_bodies(path, tolerance)
        except Exception:  # noqa: BLE001 - fall back to a plain shape import
            bodies = []
        if not bodies:
            try:
                import cadquery as cq

                shape = cq.importers.importStep(path)
            except ImportError:
                import build123d as bd

                shape = bd.import_step(path)
            bodies = _bodies_from(shape, tolerance, "solid")
    if not bodies:
        raise ValueError("the STEP file contains no solid geometry")
    return {"ok": True, "bodies": bodies}


# ---------------------------------------------------------------------------


def main():
    request = json.loads(sys.stdin.read() or "{}")
    log = io.StringIO()
    op = request.get("op")
    try:
        with contextlib.redirect_stdout(log):
            if op == "probe":
                response = {
                    "ok": True,
                    "python": sys.version.split()[0],
                    "cadquery": _module_version("cadquery"),
                    "build123d": _module_version("build123d"),
                }
            elif op == "run":
                response = op_run(request)
            elif op == "import_step":
                response = op_import_step(request)
            else:
                raise ValueError("unknown op %r" % op)
    except Exception as error:  # noqa: BLE001 - every failure becomes a structured error
        response = {"ok": False, "error": "%s: %s" % (type(error).__name__, error), "trace": traceback.format_exc(limit=8)}
    response["log"] = log.getvalue()[-20000:]
    sys.stdout.write(json.dumps(response))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
