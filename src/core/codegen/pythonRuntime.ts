/**
 * Python runtime embedded at the top of generated CadQuery / build123d scripts.
 *
 * @layer core/codegen
 * @invariant the TRACE half is backend-independent: every helper records the llull command it maps
 *   to (`LLULL_TRACE`), so running the script reproduces the llull feature history exactly.
 * @invariant the BACKEND half only builds geometry (`_make_*`, `_place`, `_boolean`, `_assemble`).
 * @see apply_code_trace (consumes LLULL_TRACE), server/python/llull_bridge.py (runs the script)
 */

export type PythonBackend = 'cadquery' | 'build123d';

const TRACE_RUNTIME = String.raw`
LLULL_TRACE = {"version": 1, "units": LLULL_UNITS, "parameters": [], "features": []}
LLULL_LIVE = {}


def _num(v):
    text = repr(float(v))
    if "e" in text or "E" in text:
        text = ("%.20f" % float(v)).rstrip("0").rstrip(".")
    if text.endswith(".0"):
        text = text[:-2]
    return "0" if text in ("-0", "") else text


class Param(float):
    """A number that remembers the llull parameter expression it was computed from."""

    def __new__(cls, value, expr):
        self = float.__new__(cls, value)
        self.expr = expr
        return self


def _src(v):
    return v.expr if isinstance(v, Param) else _num(v)


def _binary(symbol, a, b):
    if isinstance(b, bool) or not isinstance(b, (int, float)):
        return NotImplemented
    fa, fb = float(a), float(b)
    value = {"+": fa + fb, "-": fa - fb, "*": fa * fb, "/": fa / fb}[symbol]
    return Param(value, "(%s %s %s)" % (_src(a), symbol, _src(b)))


Param.__add__ = lambda a, b: _binary("+", a, b)
Param.__radd__ = lambda a, b: _binary("+", b, a)
Param.__sub__ = lambda a, b: _binary("-", a, b)
Param.__rsub__ = lambda a, b: _binary("-", b, a)
Param.__mul__ = lambda a, b: _binary("*", a, b)
Param.__rmul__ = lambda a, b: _binary("*", b, a)
Param.__truediv__ = lambda a, b: _binary("/", a, b)
Param.__rtruediv__ = lambda a, b: _binary("/", b, a)
Param.__neg__ = lambda a: Param(-float(a), "(-%s)" % _src(a))
Param.__pos__ = lambda a: a


def param(name, value):
    """Declare a named llull parameter. value may be a number or an expression of other parameters."""
    LLULL_TRACE["parameters"].append({"name": name, "expression": _src(value)})
    return Param(float(value), name)


def _term(v):
    term = {"value": float(v)}
    if isinstance(v, Param):
        term["expression"] = v.expr
    return term


def _terms(values):
    return [_term(v) for v in values]


def _radians(degrees):
    return degrees * math.pi / 180


class Solid:
    """A live llull solid: the backend shape plus the trace reference that created it."""

    def __init__(self, ref, shape, color, name):
        self.ref, self.shape, self.color, self.name = ref, shape, color, name


def _record(command, params, name=None):
    feature = {"command": command, "params": params}
    if name:
        feature["name"] = str(name)
    LLULL_TRACE["features"].append(feature)
    return feature


def _new(command, params, shape, color, name, consumes=()):
    feature = _record(command, params, name)
    feature["ref"] = "f%d" % len(LLULL_TRACE["features"])
    for solid in consumes:
        LLULL_LIVE.pop(solid.ref, None)
    solid = Solid(feature["ref"], shape, color or "#c8553d", name)
    LLULL_LIVE[solid.ref] = solid
    return solid


def _primitive(command, params, local, position, rotation, color, name):
    params = dict(params)
    params["position"] = _terms(position)
    params["rotation"] = _terms([_radians(r) for r in rotation])
    if color:
        params["color"] = color
    shape = _place(local, [float(r) for r in rotation], [float(p) for p in position])
    return _new(command, params, shape, color, name)


def _xy(points):
    return [[float(x), float(y)] for x, y in points]


def box(size, position=(0, 0, 0), rotation=(0, 0, 0), color=None, name=None):
    """Box of size (x, y, z) centred on position."""
    w, h, d = size
    return _primitive("add_box", {"size": _terms(size)}, _make_box(float(w), float(h), float(d)),
                      position, rotation, color, name)


def cylinder(radius, height, position=(0, 0, 0), rotation=(0, 0, 0), color=None, name=None):
    """Cylinder along +Z centred on position."""
    return _primitive("add_cylinder", {"radius": _term(radius), "height": _term(height)},
                      _make_cylinder(float(radius), float(height)), position, rotation, color, name)


def sphere(radius, position=(0, 0, 0), rotation=(0, 0, 0), color=None, name=None):
    """Sphere centred on position."""
    return _primitive("add_sphere", {"radius": _term(radius)}, _make_sphere(float(radius)),
                      position, rotation, color, name)


def cone(radius, height, position=(0, 0, 0), rotation=(0, 0, 0), color=None, name=None):
    """Cone with its base centre on position and its apex at +Z height."""
    return _primitive("add_cone", {"radius": _term(radius), "height": _term(height)},
                      _make_cone(float(radius), float(height)), position, rotation, color, name)


def torus(ring_radius, tube_radius, position=(0, 0, 0), rotation=(0, 0, 0), color=None, name=None):
    """Torus around +Z centred on position."""
    return _primitive("add_torus", {"ringRadius": _term(ring_radius), "tubeRadius": _term(tube_radius)},
                      _make_torus(float(ring_radius), float(tube_radius)), position, rotation, color, name)


def wedge(size, position=(0, 0, 0), rotation=(0, 0, 0), color=None, name=None):
    """Ramp of size (x, y, z): full height y at z=0, sloping to 0 at z; min corner on position."""
    w, h, d = size
    return _primitive("add_wedge", {"size": _terms(size)}, _make_wedge(float(w), float(h), float(d)),
                      position, rotation, color, name)


def pyramid(base_width, base_depth, height, position=(0, 0, 0), rotation=(0, 0, 0), color=None, name=None):
    """Rectangular pyramid: base centre on position, apex at +Z height."""
    params = {"baseWidth": _term(base_width), "baseDepth": _term(base_depth), "height": _term(height)}
    return _primitive("add_pyramid", params, _make_pyramid(float(base_width), float(base_depth), float(height)),
                      position, rotation, color, name)


def extrude(profile, depth, position=(0, 0, 0), rotation=(0, 0, 0), color=None, name=None):
    """Closed XY polygon extruded along +Z by depth; profile origin on position."""
    params = {"profile": [_terms(p) for p in profile], "depth": _term(depth)}
    return _primitive("extrude_profile", params, _make_extrusion(_xy(profile), float(depth)),
                      position, rotation, color, name)


def revolve(profile, axis="z", angle=360, segments=32, position=(0, 0, 0), rotation=(0, 0, 0),
            color=None, name=None):
    """Closed (radial, axial) polygon revolved about axis x|y|z by angle degrees."""
    params = {"profile": [_terms(p) for p in profile], "axis": axis, "angle": _term(_radians(angle)),
              "segments": int(segments)}
    return _primitive("revolve_profile", params, _make_revolution(_xy(profile), axis, float(angle)),
                      position, rotation, color, name)


def mesh(positions, color=None, name=None):
    """World-space triangle soup (x0, y0, z0, x1, ...) for geometry with no analytic form."""
    body = {"positions": [float(v) for v in positions]}
    if color:
        body["color"] = color
    return _new("import_mesh", {"bodies": [body]}, _make_mesh(body["positions"]), color, name)


def custom(shape, color=None, name=None):
    """Adopt any backend shape built with raw CadQuery/build123d (imported into llull as a mesh)."""
    body = {"positions": _triangles(shape)}
    if color:
        body["color"] = color
    return _new("import_mesh", {"bodies": [body]}, shape, color, name)


def _combine(command, a, b, kind):
    params = {"a": {"ref": a.ref}, "b": {"ref": b.ref}}
    return _new(command, params, _boolean(kind, a.shape, b.shape), a.color, None, consumes=(a, b))


def union(a, b):
    return _combine("boolean_union", a, b, "union")


def cut(a, b):
    """a minus b."""
    return _combine("boolean_subtract", a, b, "cut")


def intersect(a, b):
    return _combine("boolean_intersect", a, b, "intersect")


def translate(solid, delta):
    _record("move_entity", {"id": {"ref": solid.ref}, "delta": _terms(delta)})
    moved = Solid(solid.ref, _translate(solid.shape, [float(d) for d in delta]), solid.color, solid.name)
    LLULL_LIVE[solid.ref] = moved
    return moved


def remove(solid):
    _record("delete_entity", {"id": {"ref": solid.ref}})
    LLULL_LIVE.pop(solid.ref, None)


def label(solid, name):
    _record("set_entity_name", {"id": {"ref": solid.ref}, "name": str(name)})
    solid.name = str(name)
    return solid


def finish():
    """Collect every live solid (named + coloured) into one exportable model."""
    return _assemble(list(LLULL_LIVE.values()))
`;

const CADQUERY_BACKEND = String.raw`
import math

import cadquery as cq


def _place(shape, rotation, position):
    rx, ry, rz = rotation
    origin = (0, 0, 0)
    shape = shape.rotate(origin, (0, 0, 1), rz).rotate(origin, (0, 1, 0), ry).rotate(origin, (1, 0, 0), rx)
    return shape.translate(cq.Vector(*position))


def _translate(shape, delta):
    return shape.translate(cq.Vector(*delta))


def _polygon_face(points3d):
    return cq.Face.makeFromWires(cq.Wire.makePolygon([cq.Vector(*p) for p in points3d], close=True))


def _make_box(w, h, d):
    return cq.Solid.makeBox(w, h, d, cq.Vector(-w / 2, -h / 2, -d / 2))


def _make_cylinder(r, h):
    return cq.Solid.makeCylinder(r, h, cq.Vector(0, 0, -h / 2))


def _make_sphere(r):
    return cq.Solid.makeSphere(r, angleDegrees1=-90, angleDegrees2=90)


def _make_cone(r, h):
    return cq.Solid.makeCone(r, 0, h)


def _make_torus(ring, tube):
    return cq.Solid.makeTorus(ring, tube)


def _make_wedge(w, h, d):
    face = _polygon_face([(0, 0, 0), (0, h, 0), (0, 0, d)])
    return cq.Solid.extrudeLinear(face, cq.Vector(w, 0, 0))


def _make_polyhedron(points, faces):
    polygons = [_polygon_face([points[i] for i in face]) for face in faces]
    return cq.Solid.makeSolid(cq.Shell.makeShell(polygons))


def _make_pyramid(w, d, h):
    points = [(-w / 2, -d / 2, 0), (w / 2, -d / 2, 0), (w / 2, d / 2, 0), (-w / 2, d / 2, 0), (0, 0, h)]
    return _make_polyhedron(points, [(0, 3, 2, 1), (0, 1, 4), (1, 2, 4), (2, 3, 4), (3, 0, 4)])


def _make_extrusion(profile, depth):
    return cq.Solid.extrudeLinear(_polygon_face([(x, y, 0) for x, y in profile]), cq.Vector(0, 0, depth))


def _make_revolution(profile, axis, angle):
    if axis == "x":
        points, direction = [(a, r, 0) for r, a in profile], (1, 0, 0)
    elif axis == "y":
        points, direction = [(r, a, 0) for r, a in profile], (0, -1, 0)
    else:
        points, direction = [(r, 0, a) for r, a in profile], (0, 0, 1)
    wire = cq.Wire.makePolygon([cq.Vector(*p) for p in points], close=True)
    return cq.Solid.revolve(wire, [], angle, cq.Vector(0, 0, 0), cq.Vector(*direction))


def _make_mesh(positions):
    points = [tuple(positions[i:i + 3]) for i in range(0, len(positions), 3)]
    return _make_polyhedron(points, [(i, i + 1, i + 2) for i in range(0, len(points), 3)])


def _boolean(kind, a, b):
    result = {"union": a.fuse, "cut": a.cut, "intersect": a.intersect}[kind](b)
    return result.clean()


def _shape_of(shape):
    if isinstance(shape, cq.Workplane):
        return cq.Compound.makeCompound([v for v in shape.vals() if isinstance(v, cq.Shape)])
    return shape


def _triangles(shape, tolerance=0.01):
    vertices, triangles = _shape_of(shape).tessellate(tolerance, 0.1)
    return [c for t in triangles for i in t for c in vertices[i].toTuple()]


def _assemble(solids):
    assembly = cq.Assembly(name="llull")
    for index, solid in enumerate(solids):
        name = solid.name or "solid_%d" % (index + 1)
        assembly.add(_shape_of(solid.shape), name=name, color=cq.Color(solid.color))
    return assembly


def export_step(model, path):
    model.save(path, exportType="STEP")
`;

const BUILD123D_BACKEND = String.raw`
import math

import build123d as bd


def _place(shape, rotation, position):
    rx, ry, rz = rotation
    shape = shape.rotate(bd.Axis.Z, rz).rotate(bd.Axis.Y, ry).rotate(bd.Axis.X, rx)
    return shape.moved(bd.Location(tuple(position)))


def _translate(shape, delta):
    return shape.moved(bd.Location(tuple(delta)))


def _polygon_face(points3d):
    return bd.Face(bd.Wire.make_polygon([bd.Vector(*p) for p in points3d], close=True))


def _make_box(w, h, d):
    return bd.Solid.make_box(w, h, d).moved(bd.Location((-w / 2, -h / 2, -d / 2)))


def _make_cylinder(r, h):
    return bd.Solid.make_cylinder(r, h).moved(bd.Location((0, 0, -h / 2)))


def _make_sphere(r):
    return bd.Solid.make_sphere(r)


def _make_cone(r, h):
    return bd.Solid.make_cone(r, 0, h)


def _make_torus(ring, tube):
    return bd.Solid.make_torus(ring, tube)


def _make_wedge(w, h, d):
    return bd.Solid.extrude(_polygon_face([(0, 0, 0), (0, h, 0), (0, 0, d)]), bd.Vector(w, 0, 0))


def _make_polyhedron(points, faces):
    polygons = [_polygon_face([points[i] for i in face]) for face in faces]
    return bd.Solid(bd.Shell(polygons))


def _make_pyramid(w, d, h):
    points = [(-w / 2, -d / 2, 0), (w / 2, -d / 2, 0), (w / 2, d / 2, 0), (-w / 2, d / 2, 0), (0, 0, h)]
    return _make_polyhedron(points, [(0, 3, 2, 1), (0, 1, 4), (1, 2, 4), (2, 3, 4), (3, 0, 4)])


def _make_extrusion(profile, depth):
    return bd.Solid.extrude(_polygon_face([(x, y, 0) for x, y in profile]), bd.Vector(0, 0, depth))


def _make_revolution(profile, axis, angle):
    if axis == "x":
        points, direction = [(a, r, 0) for r, a in profile], (1, 0, 0)
    elif axis == "y":
        points, direction = [(r, a, 0) for r, a in profile], (0, -1, 0)
    else:
        points, direction = [(r, 0, a) for r, a in profile], (0, 0, 1)
    return bd.Solid.revolve(_polygon_face(points), angle, bd.Axis((0, 0, 0), direction))


def _make_mesh(positions):
    points = [tuple(positions[i:i + 3]) for i in range(0, len(positions), 3)]
    return _make_polyhedron(points, [(i, i + 1, i + 2) for i in range(0, len(points), 3)])


def _boolean(kind, a, b):
    result = {"union": a.fuse, "cut": a.cut, "intersect": a.intersect}[kind](b)
    return result.clean()


def _triangles(shape, tolerance=0.01):
    vertices, triangles = shape.tessellate(tolerance, 0.1)
    return [c for t in triangles for i in t for c in tuple(vertices[i])]


def _assemble(solids):
    children = []
    for index, solid in enumerate(solids):
        shape = solid.shape
        shape.label = solid.name or "solid_%d" % (index + 1)
        shape.color = bd.Color(solid.color)
        children.append(shape)
    return bd.Compound(label="llull", children=children)


def export_step(model, path):
    bd.export_step(model, path)
`;

/** Full runtime block for a backend: geometry builders first, then the traced helpers. */
export function pythonRuntime(backend: PythonBackend): string {
  const builders = backend === 'cadquery' ? CADQUERY_BACKEND : BUILD123D_BACKEND;
  return `${builders.trim()}\n\n${TRACE_RUNTIME.trim()}\n`;
}
