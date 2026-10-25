/**
 * Python sources for sweeps and lofts (02 SWG): `sweep_profile(build, …)` / `loft_sections(build, …)` build the solid from a build tuple and record
 * the llull command with the given params, so `import_code` rebuilds an editable step; `swept(build, …)` is the untraced form (imported as a mesh).
 * One OCP implementation serves CadQuery and build123d, a Part-workbench port serves FreeCAD.
 * @invariant a build tuple is one of
 *   `("faces", label, key, cap, tolerance)` (fitted faces from `_SWG_FACES[key]`),
 *   `("pipe", label, spine, section, mitre, bore)`, `("helix", label, origin, axis, x_axis, radius, pitch, turns, left, start, section, bore)`,
 *   `("loft", label, sections, ruled)`; a spine segment is 2 points (line), 3 (arc through) or 4 (cubic Bezier); a section is
 *   `("circle", centre, normal, radius)` or `("polygon", [point…])`
 * @failure a build the kernel cannot close or validate -> ValueError "SWG_CODEGEN_UNSUPPORTED: <label>: <why>" (never a different solid)
 */

/**
 * Shared by every backend: the keywords a traced call really reads (a pipe circle's radius and bore) and the stale-edit warning for the rest.
 * @invariant `exported` holds the flattened export-time values of the non-live keywords and None for the live ones; an edited, added or removed
 *   keyword warns SWG_CODEGEN_STALE (it does not raise: import_code runs the script to read its trace)
 */
const SWEPT_LIVE_PY = String.raw`
def _flat(value):
    if isinstance(value, (bool, str)) or value is None:
        return [value]
    if isinstance(value, (int, float)):
        return [float(value)]
    if isinstance(value, (list, tuple)):
        return [flat for item in value for flat in _flat(item)]
    if isinstance(value, dict):
        return [flat for item in value.values() for flat in _flat(item)]
    return [value]


def _same(first, second):
    if len(first) != len(second):
        return False
    for a, b in zip(first, second):
        if isinstance(a, float) and isinstance(b, float):
            if abs(a - b) > 1e-9 * max(1.0, abs(a), abs(b)):
                return False
        elif a != b:
            return False
    return True


def _check_stale(label, exported, params, level):
    """Warn for every keyword edited, added or removed since the export. exported maps a keyword to its export-time values (None = a live keyword)."""
    import warnings

    problems = []
    for key, expected in exported.items():
        if key not in params:
            problems.append((key, "was removed"))
        elif expected is not None and not _same(_flat(expected), _flat(params[key])):
            problems.append((key, "changed"))
    problems.extend((key, "was added") for key in params if key not in exported)
    for key, what in problems:
        warnings.warn("SWG_CODEGEN_STALE: %s: %s %s; the solid here is the exported one - import_code to regenerate" % (label, key, what), stacklevel=level)


def _live(build, exported, params):
    """The build with the keywords this script reads applied: a pipe circle's radius and its bore's innerRadius, when exported as live (None).
    A value sweep_profile would refuse (radius <= 0, bore >= radius, a bend or mitre reach the radius no longer fits) raises, like import_code would (the limit matches sweep_profile to the printed precision, 12 significant digits)."""
    if build[0] != "pipe":
        return build
    items, section = list(build), build[3]
    radius, bore, limit = section[3] if section[0] == "circle" else None, build[5], build[6]
    if section[0] == "circle" and "radius" in params and exported.get("radius", 0) is None:
        radius = float(params["radius"])
        items[3] = (section[0], section[1], section[2], radius)
    if bore is not None and "innerRadius" in params and exported.get("innerRadius", 0) is None:
        bore = float(params["innerRadius"])
        items[5] = bore
    if radius is not None:
        if radius <= 0 or (bore is not None and not 0 < bore < radius):
            _fail(build[1], "radius %s / innerRadius %s are not a valid tube (sweep_profile would refuse: 0 < innerRadius < radius)" % (radius, bore))
        if limit is not None and radius >= limit:
            _fail(build[1], "radius %s reaches %s (sweep_profile would refuse SWG_SELF_INTERSECTION_LOCAL: a bend or mitre reach the section no longer fits)" % (radius, limit))
    return tuple(items)
`;

/** OCP (CadQuery / build123d): `_build_swept(build)` → backend solid. */
export const OCP_SWEPT_PY = String.raw`
${SWEPT_LIVE_PY}


def _fail(label, why):
    raise ValueError("SWG_CODEGEN_UNSUPPORTED: %s: %s" % (label, why))


def _reals(values):
    from OCP.TColStd import TColStd_Array1OfReal

    array = TColStd_Array1OfReal(1, len(values))
    for index, value in enumerate(values):
        array.SetValue(index + 1, float(value))
    return array


def _ints(values):
    from OCP.TColStd import TColStd_Array1OfInteger

    array = TColStd_Array1OfInteger(1, len(values))
    for index, value in enumerate(values):
        array.SetValue(index + 1, int(value))
    return array


def _points(points):
    from OCP.TColgp import TColgp_Array1OfPnt
    from OCP.gp import gp_Pnt

    array = TColgp_Array1OfPnt(1, len(points))
    for index, (x, y, z) in enumerate(points):
        array.SetValue(index + 1, gp_Pnt(float(x), float(y), float(z)))
    return array


def _subshapes(shape, kind):
    from OCP.TopExp import TopExp_Explorer

    found, explorer = [], TopExp_Explorer(shape, kind)
    while explorer.More():
        found.append(explorer.Current())
        explorer.Next()
    return found


def _checked(label, topods):
    """The solid when it is valid with a positive volume (a reversed one is flipped), else the coded failure."""
    from OCP.BRepCheck import BRepCheck_Analyzer
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps

    properties = GProp_GProps()
    BRepGProp.VolumeProperties_s(topods, properties)
    if properties.Mass() < 0:
        topods = topods.Reversed()
    if abs(properties.Mass()) < 1e-12 or not BRepCheck_Analyzer(topods).IsValid():
        _fail(label, "the kernel built an invalid or empty solid")
    return _wrap(topods)


def _chain_edges(segments):
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeEdge
    from OCP.GC import GC_MakeArcOfCircle
    from OCP.Geom import Geom_BezierCurve
    from OCP.gp import gp_Pnt

    edges = []
    for segment in segments:
        if len(segment) == 2:
            edges.append(BRepBuilderAPI_MakeEdge(gp_Pnt(*segment[0]), gp_Pnt(*segment[1])).Edge())
        elif len(segment) == 3:
            arc = GC_MakeArcOfCircle(gp_Pnt(*segment[0]), gp_Pnt(*segment[1]), gp_Pnt(*segment[2])).Value()
            edges.append(BRepBuilderAPI_MakeEdge(arc).Edge())
        else:
            edges.append(BRepBuilderAPI_MakeEdge(Geom_BezierCurve(_points(segment))).Edge())
    return edges


def _wire_of(edges):
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeWire

    wire = BRepBuilderAPI_MakeWire()
    for edge in edges:
        wire.Add(edge)
    return wire.Wire()


def _skin_face(face):
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace
    from OCP.Geom import Geom_BSplineSurface
    from OCP.TColStd import TColStd_Array2OfReal
    from OCP.TColgp import TColgp_Array2OfPnt
    from OCP.gp import gp_Pnt

    degree_u, degree_v, poles, weights, knots_u, mults_u, knots_v, mults_v = face
    rows, columns = len(poles), len(poles[0])
    grid = TColgp_Array2OfPnt(1, rows, 1, columns)
    for i, row in enumerate(poles):
        for j, (x, y, z) in enumerate(row):
            grid.SetValue(i + 1, j + 1, gp_Pnt(x, y, z))
    knots = (_reals(knots_u), _reals(knots_v), _ints(mults_u), _ints(mults_v), int(degree_u), int(degree_v))
    if weights:
        grid_weights = TColStd_Array2OfReal(1, rows, 1, columns)
        for i, row in enumerate(weights):
            for j, weight in enumerate(row):
                grid_weights.SetValue(i + 1, j + 1, float(weight))
        surface = Geom_BSplineSurface(grid, grid_weights, *knots)
    else:
        surface = Geom_BSplineSurface(grid, *knots)
    return BRepBuilderAPI_MakeFace(surface, 1e-7).Face()


def _make_skin(label, faces, tolerance, cap):
    """Exact solid of sewn B-spline faces; cap = close the free boundary loops with planar faces."""
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace, BRepBuilderAPI_Sewing
    from OCP.ShapeAnalysis import ShapeAnalysis_FreeBounds
    from OCP.ShapeFix import ShapeFix_Solid
    from OCP.TopAbs import TopAbs_SHELL, TopAbs_WIRE
    from OCP.TopoDS import TopoDS

    sewing = BRepBuilderAPI_Sewing(tolerance)
    for face in faces:
        sewing.Add(_skin_face(face))
    sewing.Perform()
    shape = sewing.SewedShape()
    if cap:
        closed = ShapeAnalysis_FreeBounds(shape, tolerance, False, False).GetClosedWires()
        sewing = BRepBuilderAPI_Sewing(tolerance)
        sewing.Add(shape)
        for wire in _subshapes(closed, TopAbs_WIRE):
            maker = BRepBuilderAPI_MakeFace((getattr(TopoDS, "Wire_s", None) or TopoDS.Wire)(wire), True)
            if not maker.IsDone():
                _fail(label, "a planar cap could not be made on a free boundary")
            sewing.Add(maker.Face())
        sewing.Perform()
        shape = sewing.SewedShape()
    shells = _subshapes(shape, TopAbs_SHELL)
    if len(shells) != 1 or sewing.NbFreeEdges() != 0:
        _fail(label, "the faces did not sew into one closed shell (%d shell(s), %d free edge(s))" % (len(shells), sewing.NbFreeEdges()))
    return _checked(label, ShapeFix_Solid().SolidFromShell((getattr(TopoDS, "Shell_s", None) or TopoDS.Shell)(shells[0])))


def _profile_wire(section, radius=None):
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeEdge
    from OCP.gp import gp_Ax2, gp_Circ, gp_Dir, gp_Pnt

    if section[0] == "circle":
        _, center, normal, outer = section
        circle = gp_Circ(gp_Ax2(gp_Pnt(*center), gp_Dir(*normal)), float(outer if radius is None else radius))
        return _wire_of([BRepBuilderAPI_MakeEdge(circle).Edge()])
    corners = section[1]
    return _wire_of(_chain_edges([(a, b) for a, b in zip(corners, corners[1:] + corners[:1])]))


def _pipe_shell(label, path, section, bore, frenet, mitre):
    from OCP.BRepBuilderAPI import BRepBuilderAPI_RightCorner, BRepBuilderAPI_Transformed
    from OCP.BRepOffsetAPI import BRepOffsetAPI_MakePipeShell

    def sweep(radius):
        maker = BRepOffsetAPI_MakePipeShell(path)
        maker.SetMode(frenet)
        maker.SetTransitionMode(BRepBuilderAPI_RightCorner if mitre else BRepBuilderAPI_Transformed)
        maker.Add(_profile_wire(section, radius), False, False)
        maker.Build()
        if not maker.IsDone() or not maker.MakeSolid():
            _fail(label, "the kernel refused to sweep this section along its path")
        return _checked(label, maker.Shape())

    solid = sweep(None)
    return solid if bore is None else _boolean("cut", solid, sweep(float(bore)))


def _make_pipe(label, spine, section, mitre, bore, limit=None):
    """Pipe shell of the section along the exact path wire (corrected Frenet frame = isFrenet False); mitre = right-corner joints."""
    return _pipe_shell(label, _wire_of(_chain_edges(spine)), section, bore, False, mitre)


def _make_helix(label, origin, axis, x_axis, radius, pitch, turns, left, start, section, bore):
    """Round section along the exact helix (a 2D line on a cylindrical surface, the library's makeHelix) with a Frenet frame."""
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeEdge
    from OCP.BRepLib import BRepLib
    from OCP.Geom import Geom_CylindricalSurface
    from OCP.Geom2d import Geom2d_Line
    from OCP.GeomAbs import GeomAbs_C1
    from OCP.gp import gp_Ax3, gp_Dir, gp_Dir2d, gp_Pnt, gp_Pnt2d

    surface = Geom_CylindricalSurface(gp_Ax3(gp_Pnt(*origin), gp_Dir(*axis), gp_Dir(*x_axis)), float(radius))
    line = Geom2d_Line(gp_Pnt2d(float(start), 0.0), gp_Dir2d(-2 * math.pi if left else 2 * math.pi, float(pitch)))
    edge = BRepBuilderAPI_MakeEdge(line, surface, 0.0, float(turns) * math.hypot(2 * math.pi, float(pitch))).Edge()
    BRepLib.BuildCurves3d_s(edge, 1e-6, GeomAbs_C1, 14, 2000)
    return _pipe_shell(label, _wire_of([edge]), section, bore, True, False)


def _section_wire(section):
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeEdge
    from OCP.Geom import Geom_BSplineCurve
    from OCP.gp import gp_Pnt

    if section[0] == "chain":
        return _wire_of(_chain_edges(section[1]))
    _, degree, poles, weights, knots, mults, closing = section
    if weights:
        curve = Geom_BSplineCurve(_points(poles), _reals(weights), _reals(knots), _ints(mults), int(degree))
    else:
        curve = Geom_BSplineCurve(_points(poles), _reals(knots), _ints(mults), int(degree))
    edges = [BRepBuilderAPI_MakeEdge(curve).Edge()]
    if closing:
        edges.append(BRepBuilderAPI_MakeEdge(gp_Pnt(*poles[-1]), gp_Pnt(*poles[0])).Edge())
    return _wire_of(edges)


def _make_loft(label, sections, ruled):
    """Thru-sections solid of exact section wires (the native llull kernel builds lofts the same way)."""
    from OCP.BRepOffsetAPI import BRepOffsetAPI_ThruSections

    maker = BRepOffsetAPI_ThruSections(True, bool(ruled), 1e-6)
    maker.CheckCompatibility(False)
    for section in sections:
        maker.AddWire(_section_wire(section))
    maker.Build()
    if not maker.IsDone():
        _fail(label, "the kernel refused to loft these sections")
    return _checked(label, maker.Shape())


def _build_swept(build):
    kind, label = build[0], build[1]
    if kind == "faces":
        faces, bore = _SWG_FACES[build[2]]
        solid = _make_skin(label, faces, float(build[4]), build[3])
        return solid if bore is None else _boolean("cut", solid, _make_skin(label, bore, float(build[4]), build[3]))
    if kind == "pipe":
        return _make_pipe(label, *build[2:])
    if kind == "helix":
        return _make_helix(label, *build[2:])
    return _make_loft(label, *build[2:])
`;

/** Traced helpers (CadQuery / build123d): the solid is built at its placement and records the llull command with its params. */
export const SWEPT_TRACE_PY = String.raw`
def _tree(value):
    if isinstance(value, (bool, str)) or value is None:
        return value
    if isinstance(value, (int, float)):
        return _term(value)
    if isinstance(value, (list, tuple)):
        return [_tree(item) for item in value]
    if isinstance(value, dict):
        return {key: _tree(item) for key, item in value.items()}
    return value


def _swept(command, build, exported, params, position, rotation, color, name):
    build = _live(build, exported, params)
    if command is not None:
        _check_stale(build[1], exported, params, 4)
    shape = _place(_build_swept(build), [float(r) for r in rotation], [float(p) for p in position])
    if command is None:
        return custom(shape, color, name)
    body = {key: _tree(value) for key, value in params.items()}
    if color:
        body["color"] = color
    return _new(command, body, shape, color, name)


def sweep_profile(build, exported, position=(0, 0, 0), rotation=(0, 0, 0), color=None, name=None, **params):
    """Sweep: build = how this script constructs it, the keywords are the sweep_profile params (recorded, so import_code rebuilds the step).
    Only radius / innerRadius of a pipe are read here; editing, adding or removing any other keyword warns SWG_CODEGEN_STALE and takes effect through import_code."""
    return _swept("sweep_profile", build, exported, params, position, rotation, color, name)


def loft_sections(build, exported, position=(0, 0, 0), rotation=(0, 0, 0), color=None, name=None, **params):
    """Loft: build = how this script constructs it, the keywords are the loft_sections params (recorded, so import_code rebuilds the step).
    No keyword is read here: an edit warns SWG_CODEGEN_STALE and takes effect through import_code."""
    return _swept("loft_sections", build, exported, params, position, rotation, color, name)


def swept(build, position=(0, 0, 0), rotation=(0, 0, 0), color=None, name=None):
    """A sweep or loft without a replayable command (it references other entities): adopted like custom(...), imported as a mesh."""
    return _swept(None, build, {}, {}, position, rotation, color, name)
`;

/** FreeCAD macro: the same helpers on Part.BSplineSurface faces, Wire.makePipeShell, Part.makeHelix and Part.makeLoft. */
export const FREECAD_SWEPT_PY = String.raw`
${SWEPT_LIVE_PY}


def _fail(label, why):
    raise ValueError("SWG_CODEGEN_UNSUPPORTED: %s: %s" % (label, why))


def _skin_face(face):
    degree_u, degree_v, poles, weights, knots_u, mults_u, knots_v, mults_v = face
    surface = Part.BSplineSurface()
    rows = [[_vec(*p) for p in row] for row in poles]
    if weights:
        surface.buildFromPolesMultsKnots(rows, mults_u, mults_v, knots_u, knots_v, False, False, degree_u, degree_v, weights)
    else:
        surface.buildFromPolesMultsKnots(rows, mults_u, mults_v, knots_u, knots_v, False, False, degree_u, degree_v)
    return surface.toShape()


def _only_solid(shape):
    return shape.Solids[0] if len(shape.Solids) == 1 else shape


def _checked(label, solid):
    if solid.Volume < 0:
        solid.reverse()
    if not solid.isValid() or solid.Volume < 1e-12:
        _fail(label, "the kernel built an invalid or empty solid")
    return solid


def _make_skin(label, faces, tolerance, cap):
    shell = Part.Shell([_skin_face(face) for face in faces])
    shell.sewShape(tolerance)
    if cap:
        closing = [Part.Face(Part.Wire(group)) for group in Part.sortEdges(shell.getFreeEdges().Edges)]
        shell = Part.Shell(list(shell.Faces) + closing)
        shell.sewShape(tolerance)
    if shell.ShapeType != "Shell" or not shell.isClosed() or len(shell.getFreeEdges().Edges) != 0:
        _fail(label, "the faces did not sew into one closed shell")
    return _checked(label, Part.Solid(shell))


def _chain_edges(segments):
    edges = []
    for segment in segments:
        if len(segment) == 2:
            edges.append(Part.makeLine(_vec(*segment[0]), _vec(*segment[1])))
        elif len(segment) == 3:
            edges.append(Part.Arc(_vec(*segment[0]), _vec(*segment[1]), _vec(*segment[2])).toShape())
        else:
            curve = Part.BezierCurve()
            curve.setPoles([_vec(*p) for p in segment])
            edges.append(curve.toShape())
    return edges


def _profile_wire(section, radius=None):
    if section[0] == "circle":
        _, center, normal, outer = section
        return Part.Wire([Part.makeCircle(float(outer if radius is None else radius), _vec(*center), _vec(*normal))])
    corners = section[1]
    return Part.Wire(_chain_edges([(a, b) for a, b in zip(corners, corners[1:] + corners[:1])]))


def _pipe_shell(label, path, section, bore, frenet, mitre):
    def sweep(radius):
        solid = path.makePipeShell([_profile_wire(section, radius)], True, frenet, 1 if mitre else 0)
        return _checked(label, solid)

    solid = sweep(None)
    return solid if bore is None else _only_solid(solid.cut(sweep(float(bore))).removeSplitter())


def _make_helix(label, origin, axis, x_axis, radius, pitch, turns, left, start, section, bore):
    helix = Part.makeHelix(float(pitch), float(pitch) * float(turns), float(radius), 0.0, bool(left))
    helix.rotate(_vec(0, 0, 0), _vec(0, 0, 1), math.degrees(float(start)))
    z, x = _vec(*axis), _vec(*x_axis)
    y = z.cross(x)
    matrix = App.Matrix(x.x, y.x, z.x, origin[0], x.y, y.y, z.y, origin[1], x.z, y.z, z.z, origin[2], 0, 0, 0, 1)
    helix = helix.transformGeometry(matrix)
    return _pipe_shell(label, Part.Wire(helix.Edges), section, bore, True, False)


def _section_wire(section):
    if section[0] == "chain":
        return Part.Wire(_chain_edges(section[1]))
    _, degree, poles, weights, knots, mults, closing = section
    curve = Part.BSplineCurve()
    if weights:
        curve.buildFromPolesMultsKnots([_vec(*p) for p in poles], mults, knots, False, degree, weights)
    else:
        curve.buildFromPolesMultsKnots([_vec(*p) for p in poles], mults, knots, False, degree)
    edges = [curve.toShape()]
    if closing:
        edges.append(Part.makeLine(_vec(*poles[-1]), _vec(*poles[0])))
    return Part.Wire(edges)


def _make_loft(label, sections, ruled):
    return _checked(label, Part.makeLoft([_section_wire(section) for section in sections], True, bool(ruled)))


def _build_swept(build, **placement):
    kind, label = build[0], build[1]
    if kind == "faces":
        faces, bore = _SWG_FACES[build[2]]
        solid = _make_skin(label, faces, float(build[4]), build[3])
        solid = solid if bore is None else _only_solid(solid.cut(_make_skin(label, bore, float(build[4]), build[3])).removeSplitter())
    elif kind == "pipe":
        solid = _pipe_shell(label, Part.Wire(_chain_edges(build[2])), build[3], build[5], False, build[4])
    elif kind == "helix":
        solid = _make_helix(label, *build[2:])
    else:
        solid = _make_loft(label, *build[2:])
    return _place(solid, **placement)


def sweep_profile(build, exported, **keywords):
    placement = {key: keywords.pop(key) for key in ("position", "rotation") if key in keywords}
    live = _live(build, exported, keywords)
    _check_stale(live[1], exported, keywords, 3)
    return _build_swept(live, **placement)


loft_sections = sweep_profile


def swept(build, **placement):
    return _build_swept(build, **placement)
`;
