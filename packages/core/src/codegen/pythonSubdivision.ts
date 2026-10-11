/**
 * Subdivision solids in generated Python: a library-free port of the core Catmull-Clark refinement
 * (geometry/subdivision.ts) and Bézier patch conversion (geometry/subdivisionPatches.ts), plus the
 * OCP builder that turns the patches into exact B-spline faces sewn into a solid (CadQuery and
 * build123d both run on OCP). The FreeCAD macro reuses the pure part with Part.BSplineSurface.
 *
 * @layer core/codegen
 * @invariant SUBDIVISION_PY mirrors the TypeScript rules (edge order, crease / corner rules, patch
 *   pole layout) so code and document describe the same surface
 */

/** Pure Python: `_subdivision_patches(vertices, faces, creases)` → 16-pole patches (local frame). */
export const SUBDIVISION_PY = String.raw`
def _edge_key(a, b):
    return (a, b) if a < b else (b, a)


def _mean(points):
    n = float(len(points))
    return tuple(sum(p[c] for p in points) / n for c in range(3))


def _subdivide_once(vertices, faces, creases):
    sharp = set(_edge_key(a, b) for a, b in creases)
    edges, order = {}, []
    for f, face in enumerate(faces):
        for i, a in enumerate(face):
            b = face[(i + 1) % len(face)]
            key = _edge_key(a, b)
            if key not in edges:
                edges[key] = (a, b, [], key in sharp)
                order.append(key)
            edges[key][2].append(f)
    face_points = [_mean([vertices[v] for v in face]) for face in faces]
    index = {key: i for i, key in enumerate(order)}
    edge_points = []
    for key in order:
        a, b, around, is_sharp = edges[key]
        ends = [vertices[a], vertices[b]]
        edge_points.append(_mean(ends) if is_sharp else _mean(ends + [face_points[f] for f in around]))
    incident = [[] for _ in vertices]
    adjacent = [[] for _ in vertices]
    for key in order:
        incident[edges[key][0]].append(key)
        incident[edges[key][1]].append(key)
    for f, face in enumerate(faces):
        for v in face:
            adjacent[v].append(f)
    vertex_points = []
    for v, p in enumerate(vertices):
        sharp_edges = [key for key in incident[v] if edges[key][3]]
        if len(sharp_edges) > 2:
            vertex_points.append(tuple(p))
        elif len(sharp_edges) == 2:
            a, b = [vertices[edges[k][1] if edges[k][0] == v else edges[k][0]] for k in sharp_edges]
            vertex_points.append(tuple((6 * p[c] + a[c] + b[c]) / 8 for c in range(3)))
        else:
            n = len(incident[v])
            q = _mean([face_points[f] for f in adjacent[v]])
            r = _mean([_mean([vertices[edges[k][0]], vertices[edges[k][1]]]) for k in incident[v]])
            vertex_points.append(tuple((q[c] + 2 * r[c] + (n - 3) * p[c]) / n for c in range(3)))
    edge_base = len(vertices)
    face_base = edge_base + len(order)
    middle = lambda a, b: edge_base + index[_edge_key(a, b)]
    quads = []
    for f, face in enumerate(faces):
        n = len(face)
        for i, v in enumerate(face):
            quads.append((v, middle(v, face[(i + 1) % n]), face_base + f, middle(face[(i - 1) % n], v)))
    new_creases = []
    for key in order:
        a, b, _, is_sharp = edges[key]
        if is_sharp:
            new_creases += [(a, middle(a, b)), (middle(a, b), b)]
    return vertex_points + edge_points + face_points, quads, new_creases


def _subdivision_patches(vertices, faces, creases):
    """Bicubic Bézier patches (16 poles, P(i, j) at i * 4 + j) of the once-refined cage."""
    vertices, faces, creases = _subdivide_once([tuple(map(float, p)) for p in vertices], faces, creases)
    sharp = set(_edge_key(a, b) for a, b in creases)
    valence = [0] * len(vertices)
    crease_ends = [[] for _ in vertices]
    seen = set()
    for face in faces:
        for i, a in enumerate(face):
            b = face[(i + 1) % 4]
            key = _edge_key(a, b)
            if key in seen:
                continue
            seen.add(key)
            valence[a] += 1
            valence[b] += 1
            if key in sharp:
                crease_ends[a].append(b)
                crease_ends[b].append(a)
    interior = []
    around = [[] for _ in vertices]
    beside = {}
    for face in faces:
        points = []
        for k, v in enumerate(face):
            n = valence[v]
            nxt, prv, diag = (vertices[face[(k + s) % 4]] for s in (1, 3, 2))
            p = vertices[v]
            q = tuple((n * p[c] + 2 * (nxt[c] + prv[c]) + diag[c]) / (n + 5) for c in range(3))
            points.append(q)
            around[v].append(q)
            for w in (face[(k + 1) % 4], face[(k + 3) % 4]):
                beside.setdefault((v, w), []).append(q)
        interior.append(points)
    corners = []
    for v, p in enumerate(vertices):
        if len(crease_ends[v]) > 2:
            corners.append(p)
        elif len(crease_ends[v]) == 2:
            a, b = (vertices[w] for w in crease_ends[v])
            corners.append(tuple((a[c] + b[c] + 4 * p[c]) / 6 for c in range(3)))
        else:
            corners.append(_mean(around[v]))

    def edge_point(v, w):
        if _edge_key(v, w) in sharp:
            return tuple((2 * vertices[v][c] + vertices[w][c]) / 3 for c in range(3))
        first, second = beside[(v, w)]
        return tuple((first[c] + second[c]) / 2 for c in range(3))

    patches = []
    for face, q in zip(faces, interior):
        v0, v1, v2, v3 = face
        patches.append([
            corners[v0], edge_point(v0, v3), edge_point(v3, v0), corners[v3],
            edge_point(v0, v1), q[0], q[3], edge_point(v3, v2),
            edge_point(v1, v0), q[1], q[2], edge_point(v2, v3),
            corners[v1], edge_point(v1, v2), edge_point(v2, v1), corners[v2],
        ])
    return patches


def _subdivide(vertices, faces, creases, levels):
    for _ in range(int(levels)):
        vertices, faces, creases = _subdivide_once(vertices, faces, creases)
    return vertices, faces


def _fan_triangles(faces):
    return [(face[0], face[k], face[k + 1]) for face in faces for k in range(1, len(face) - 1)]
`;

/** OCP (CadQuery / build123d): `_make_subdivision(vertices, faces, creases, levels)` → backend solid. */
export const OCP_SUBDIVISION_PY = String.raw`
def _bspline_face(poles):
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace
    from OCP.Geom import Geom_BSplineSurface
    from OCP.TColgp import TColgp_Array2OfPnt
    from OCP.TColStd import TColStd_Array1OfInteger, TColStd_Array1OfReal
    from OCP.gp import gp_Pnt

    grid = TColgp_Array2OfPnt(1, 4, 1, 4)
    for index, (x, y, z) in enumerate(poles):
        grid.SetValue(index // 4 + 1, index % 4 + 1, gp_Pnt(x, y, z))
    knots = TColStd_Array1OfReal(1, 2)
    knots.SetValue(1, 0.0)
    knots.SetValue(2, 1.0)
    mults = TColStd_Array1OfInteger(1, 2)
    mults.SetValue(1, 4)
    mults.SetValue(2, 4)
    surface = Geom_BSplineSurface(grid, knots, knots, mults, mults, 3, 3)
    return BRepBuilderAPI_MakeFace(surface, 1e-7).Face()


def _make_subdivision(vertices, faces, creases, levels):
    """Exact B-spline solid of a llull subdivision cage (levels 0: the faceted cage)."""
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeSolid, BRepBuilderAPI_Sewing
    from OCP.TopAbs import TopAbs_SHELL
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopoDS import TopoDS

    if int(levels) == 0:
        return _make_polyhedron([tuple(map(float, p)) for p in vertices], _fan_triangles(faces))
    span = max([abs(float(c)) for p in vertices for c in p] + [1.0])
    sewing = BRepBuilderAPI_Sewing(span * 1e-7)
    for poles in _subdivision_patches(vertices, faces, creases):
        sewing.Add(_bspline_face(poles))
    sewing.Perform()
    shells = TopExp_Explorer(sewing.SewedShape(), TopAbs_SHELL)
    maker, count = BRepBuilderAPI_MakeSolid(), 0
    while shells.More():
        maker.Add(TopoDS.Shell_s(shells.Current()))
        count += 1
        shells.Next()
    if count == 1 and sewing.NbFreeEdges() == 0:
        return _wrap(maker.Solid())
    # Same contract as the llull OCC kernel: an exact shell that does not close falls back to the
    # subdivided triangles.
    points, quads = _subdivide([tuple(map(float, p)) for p in vertices], faces, creases, levels)
    return _make_polyhedron(points, _fan_triangles(quads))
`;

/** Traced helper (CadQuery / build123d): records add_subdivision_solid and builds the solid. */
export const SUBDIVISION_TRACE_PY = String.raw`
def subdivision(vertices, faces, creases=(), levels=2, position=(0, 0, 0), rotation=(0, 0, 0),
                color=None, name=None):
    """Catmull-Clark solid over a closed cage (vertices local to position; faces counter-clockwise
    from outside; creases = sharp [a, b] edges); built as exact B-spline faces."""
    params = {"vertices": [[float(c) for c in p] for p in vertices],
              "faces": [[int(i) for i in face] for face in faces],
              "creases": [[int(a), int(b)] for a, b in creases], "levels": int(levels)}
    local = _make_subdivision(params["vertices"], params["faces"], params["creases"], params["levels"])
    return _primitive("add_subdivision_solid", params, local, position, rotation, color, name)
`;

/** FreeCAD macro: `subdivision(...)` with Part.BSplineSurface faces (same pure patch code). */
export const FREECAD_SUBDIVISION_PY = String.raw`
def subdivision(vertices, faces, creases=(), levels=2, **placement):
    if int(levels) == 0:
        return _place(_polyhedron([tuple(map(float, p)) for p in vertices], _fan_triangles(faces)), **placement)
    patches = []
    for poles in _subdivision_patches(vertices, faces, creases):
        surface = Part.BSplineSurface()
        rows = [[_vec(*poles[i * 4 + j]) for j in range(4)] for i in range(4)]
        surface.buildFromPolesMultsKnots(rows, [4, 4], [4, 4], [0.0, 1.0], [0.0, 1.0], False, False, 3, 3)
        patches.append(surface.toShape())
    shell = Part.Shell(patches)
    shell.sewShape()
    solid = Part.Solid(shell)
    if solid.Volume < 0:
        solid.reverse()
    return _place(solid, **placement)
`;
