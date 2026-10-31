/**
 * Variable / two-leg chamfers in generated Python (BLD M5, spec 06 §13.29): the OCP construction llull's native kernel uses
 * (solver/crates/llull-kernel-occt/cpp/blend_chamfer.cxx, `make_straight_tool`). OCCT's MakeChamfer takes constant distances, so the chamfer
 * of a straight edge between two planes is the boolean of the solid with the ruled loft of the two end triangles (corner, point at the first leg
 * on one face, point at the second leg on the other): a CUT for a convex edge, a FUSE for a concave one. CadQuery and build123d both run on OCP.
 * @invariant edges between two planar faces (so straight) with flat square ends only; any other edge raises BLD_CODEGEN_UNSUPPORTED at run time (the
 *   exporter lowers only edges the kernel reports as lines)
 * @invariant the FreeCAD macro has no such helper: `chamfer_legs` there raises BLD_CODEGEN_UNSUPPORTED, never a constant chamfer
 */

/** OCP geometry: `_chamfer_legs(shape, edges, near, first, last, second, second_last, lead)` -> (shape, side-1 points). */
export const OCP_CHAMFER_PY = String.raw`
def _v_sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _v_add(a, b):
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def _v_mul(a, k):
    return (a[0] * k, a[1] * k, a[2] * k)


def _v_dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _v_cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _v_unit(a):
    length = math.sqrt(_v_dot(a, a))
    return (a[0] / length, a[1] / length, a[2] / length)


def _chamfer_unique(shapes):
    kept = []
    for shape in shapes:
        if not any(shape.IsSame(known) for known in kept):
            kept.append(shape)
    return kept


def _chamfer_sub_shapes(topods, kind, as_kind):
    from OCP.TopExp import TopExp_Explorer

    found, explorer = [], TopExp_Explorer(topods, kind)
    while explorer.More():
        found.append(as_kind(explorer.Current()))
        explorer.Next()
    return _chamfer_unique(found)


def _chamfer_cast(name):
    from OCP.TopoDS import TopoDS

    return getattr(TopoDS, name + "_s", None) or getattr(TopoDS, name)  # renamed in OCP >= 7.8


def _chamfer_plane_normal(face):
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import GeomAbs_Plane
    from OCP.TopAbs import TopAbs_REVERSED

    surface = BRepAdaptor_Surface(face, True)
    if surface.GetType() != GeomAbs_Plane:
        return None
    direction = surface.Plane().Axis().Direction()
    normal = (direction.X(), direction.Y(), direction.Z())
    return _v_mul(normal, -1.0) if face.Orientation() == TopAbs_REVERSED else normal


def _chamfer_on_face(face, point):
    from OCP.BRepClass import BRepClass_FaceClassifier
    from OCP.TopAbs import TopAbs_IN, TopAbs_ON
    from OCP.gp import gp_Pnt

    return BRepClass_FaceClassifier(face, gp_Pnt(*point), 1e-7).State() in (TopAbs_IN, TopAbs_ON)


def _chamfer_in_solid(topods, point):
    from OCP.BRepClass3d import BRepClass3d_SolidClassifier
    from OCP.TopAbs import TopAbs_IN
    from OCP.gp import gp_Pnt

    return BRepClass3d_SolidClassifier(topods, gp_Pnt(*point), 1e-7).State() == TopAbs_IN


def _chamfer_frame(topods, edge):
    """The edge between two planes (so a straight one): its end points, unit direction, the two faces with outward normals and inward directions, convexity."""
    from OCP.BRepAdaptor import BRepAdaptor_Curve
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE

    curve = BRepAdaptor_Curve(edge)
    ends = [curve.Value(curve.FirstParameter()), curve.Value(curve.LastParameter())]
    start, end = [(p.X(), p.Y(), p.Z()) for p in ends]
    length = math.sqrt(_v_dot(_v_sub(end, start), _v_sub(end, start)))
    direction = _v_unit(_v_sub(end, start))
    middle = _v_add(start, _v_mul(direction, length / 2))
    around = [
        face
        for face in _chamfer_sub_shapes(topods, TopAbs_FACE, _chamfer_cast("Face"))
        if any(sub.IsSame(edge) for sub in _chamfer_sub_shapes(face, TopAbs_EDGE, _chamfer_cast("Edge")))
    ]
    if len(around) != 2:
        raise ValueError("BLD_CODEGEN_UNSUPPORTED: the chamfered edge does not join exactly two faces")
    probe = min(1e-3 * length, 1e-3)
    normals, inward = [], []
    for face in around:
        normal = _chamfer_plane_normal(face)
        if normal is None:
            raise ValueError("BLD_CODEGEN_UNSUPPORTED: a variable or two-leg chamfer is only generated between two planar faces")
        across = _v_unit(_v_cross(normal, direction))
        if _chamfer_on_face(face, _v_add(middle, _v_mul(across, probe))):
            inside = across
        elif _chamfer_on_face(face, _v_sub(middle, _v_mul(across, probe))):
            inside = _v_mul(across, -1.0)
        else:
            raise ValueError("llull: cannot tell which way a face of the chamfered edge runs away from it")
        below = _v_sub(_v_add(middle, _v_mul(inside, probe)), _v_mul(normal, probe))
        normals.append(normal if _chamfer_in_solid(topods, below) else _v_mul(normal, -1.0))
        inward.append(inside)
    fold = math.acos(max(-1.0, min(1.0, _v_dot(normals[0], normals[1]))))
    if fold < 1e-6 or fold > math.pi - 1e-6:
        raise ValueError("llull: the chamfered edge joins tangent or folded-flat faces (no corner to chamfer)")
    return {
        "start": start,
        "end": end,
        "direction": direction,
        "length": length,
        "faces": around,
        "normals": normals,
        "inward": inward,
        "convex": _v_dot(normals[0], inward[1]) < 0,
    }


def _chamfer_square_ends(topods, edge, frame):
    from OCP.TopAbs import TopAbs_FACE, TopAbs_VERTEX
    from OCP.TopExp import TopExp

    for vertex in (TopExp.FirstVertex_s(edge, True), TopExp.LastVertex_s(edge, True)):
        capped = False
        for face in _chamfer_sub_shapes(topods, TopAbs_FACE, _chamfer_cast("Face")):
            if any(face.IsSame(own) for own in frame["faces"]):
                continue
            if not any(sub.IsSame(vertex) for sub in _chamfer_sub_shapes(face, TopAbs_VERTEX, _chamfer_cast("Vertex"))):
                continue
            normal = _chamfer_plane_normal(face)
            if normal is not None and abs(abs(_v_dot(normal, frame["direction"])) - 1.0) < 1e-9:
                capped = True
        if not capped:
            raise ValueError("llull: an end of the chamfered edge is not on a face perpendicular to it (variable chamfers need flat square ends)")


def _chamfer_tool(topods, edge, first, last, second, second_last, lead):
    """(tool solid, convex, a point on the side-1 face): the ruled loft of the two end triangles."""
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakePolygon
    from OCP.BRepOffsetAPI import BRepOffsetAPI_ThruSections
    from OCP.gp import gp_Pnt

    frame = _chamfer_frame(topods, edge)
    _chamfer_square_ends(topods, edge, frame)
    side = 0 if lead is None else max((0, 1), key=lambda k: _v_dot(lead, frame["normals"][k]))
    legs = {side: (first, last), 1 - side: (second, second_last)}
    at = lambda k, s: legs[k][0] + (legs[k][1] - legs[k][0]) * s
    place = lambda s, k: _v_add(
        _v_add(frame["start"], _v_mul(frame["direction"], s * frame["length"])), _v_mul(frame["inward"][k], at(k, s))
    )
    for s in (0.0, 0.25, 0.5, 0.75, 1.0):
        if not all(_chamfer_on_face(frame["faces"][k], place(s, k)) for k in (0, 1)):
            raise ValueError("llull: a chamfer leg reaches past the faces of the edge; use smaller distances")
    wires = []
    for s, corner in ((0.0, frame["start"]), (1.0, frame["end"])):
        points = [gp_Pnt(*corner), gp_Pnt(*place(s, 0)), gp_Pnt(*place(s, 1))]
        wires.append(BRepBuilderAPI_MakePolygon(points[0], points[1], points[2], True).Wire())
    loft = BRepOffsetAPI_ThruSections(True, True)
    for wire in wires:
        loft.AddWire(wire)
    loft.Build()
    if not loft.IsDone():
        raise ValueError("llull: the chamfer tool could not be lofted")
    return loft.Shape(), frame["convex"], place(0.5, side)


def _chamfer_volume(topods):
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps

    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(topods, props)
    return props.Mass()


def _chamfer_legs(shape, edges, near, first, last, second, second_last, lead):
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut, BRepAlgoAPI_Fuse
    from OCP.ShapeUpgrade import ShapeUpgrade_UnifySameDomain

    topods = _shape_of(shape).wrapped
    tools = [
        _chamfer_tool(topods, edge, first, last, second, second_last, lead[position] if lead else None)
        for position, edge in enumerate(_select_edges(topods, edges, near))
    ]
    result = topods
    for convex, operation in ((True, BRepAlgoAPI_Cut), (False, BRepAlgoAPI_Fuse)):
        for tool, tool_convex, _point in tools:
            if tool_convex != convex:
                continue
            builder = operation(result, tool)
            if not builder.IsDone():
                raise ValueError("llull: the boolean of the chamfer tools failed")
            result = builder.Shape()
    if any(not tool_convex for _tool, tool_convex, _point in tools):
        unifier = ShapeUpgrade_UnifySameDomain(result, False, True, False)
        unifier.Build()
        result = unifier.Shape()
    before, after = _chamfer_volume(topods), _chamfer_volume(result)
    convex_only, concave_only = all(t[1] for t in tools), not any(t[1] for t in tools)
    if not after > 0 or (convex_only and not after < before) or (concave_only and not after > before):
        raise ValueError("llull: the variable chamfer changed the volume the wrong way (%s -> %s)" % (before, after))
    return _wrap(result), [point for _tool, _convex, point in tools]
`;

/** The traced helper: `chamfer_legs(solid, edges, first, last, second, second_last, lead=None, near=None)`. */
export const CHAMFER_TRACE_PY = String.raw`
def chamfer_legs(solid, edges, first, last, second, second_last, lead=None, near=None):
    """Chamfer straight edges with legs that run linearly from first / second (edge start) to last / second_last (edge end); lead = outward normal of the face carrying first (per edge), None = equal legs."""
    shape, points = _chamfer_legs(solid.shape, [int(e) for e in edges], near, float(first), float(last), float(second), float(second_last), lead)
    params = {"id": {"ref": solid.ref}, "edgeIndices": [int(e) for e in edges], "distance": _term(first), "distanceEnd": float(last)}
    if lead:
        params.update({"distance2": float(second), "distance2End": float(second_last), "side1Near": [float(c) for c in points[0]]})
    feature = _record("chamfer_edge", params)
    rounded = Solid(solid.ref, shape, solid.color, solid.name)
    LLULL_LIVE.pop(solid.ref, None)
    feature["ref"] = rounded.ref = "f%d" % len(LLULL_TRACE["features"])
    LLULL_LIVE[rounded.ref] = rounded
    return rounded
`;

/** FreeCAD has no loft-and-boolean helper here: refuse by name, never a constant chamfer. */
export const FREECAD_CHAMFER_PY = String.raw`
def chamfer_legs(shape, edges, first, last, second, second_last, lead=None, near=None):
    raise ValueError("BLD_CODEGEN_UNSUPPORTED: variable and two-leg chamfers are generated for CadQuery and build123d (OCP); use those exports or the STEP of the model")
`;
