"""
llull FE mesher (bridge op `mesh`): Gmsh tetrahedral meshing of the analysed solids + target resolution.

Request (all lengths in DOCUMENT units; `lengthScale` converts to the analysis unit, the output is in the analysis unit):
  {"op": "mesh", "lengthScale": 1.0,
   "parts": [{"entityId": "box-1", "geometry": {"kind": "step", "stepBase64": "..."} | {"kind": "stl", "stlBase64": "..."},
              "faces": [{"index": 0, "area": 1.0, "centroid": [x,y,z]}]}],          (optional, kernel B-rep faces: TR-FEA-32 face map)
   "targets": [{"key": "C_c1", "entityId": "box-1" | null, "facesNear": [[x,y,z]], "faceIndices": [0], "edgesNear": [...], "pointsNear": [...]}],
   "controls": {"order": 1 | 2, "globalSize": 5.0, "minSize": 1.0, "refinements": [{"key": "R_0", "size": 1.0}]}}
  (`geometry` + `entityId` at the top level is accepted for a single part; `stlBase64` is a binary STL.)
Response: {"ok": true, "mesher", "mesherVersion", "nodes": [[id,x,y,z]], "blocks": [{"type","entityId","elements":[[id,n1..]]}],
  "nodeSets": {key: [ids]}, "faceSets": {key: [[elementId, ccxFaceLabel]]}, "targets": {key: {"residual"}},
  "faceMap": [{"entityId", "faceIndex", "tag", "residual"}]}   (faceMap only for parts given `faces`; STEP geometry, separate bonding)
Errors: {"ok": false, "code": "FEA_*", "error": "..."} (see MeshError).

Every entity is meshed in its own Gmsh model (separate volumes, no shared nodes); ids are global and contiguous (1..n).
Faces: STEP -> OCC faces. STL -> regions grown from the facets with the classification angle (flat / smooth faces stay ONE face
even when Gmsh splits them into patches for reparametrisation). Gmsh tet10 is reordered to CalculiX C3D10 (last two mid-edge nodes swap).
"""

import base64
import math
import os
import tempfile

TET4, TET10, TRI3, TRI6 = 4, 11, 2, 9
CLASSIFY_ANGLE = math.radians(40.0)
AMBIGUOUS_REL = 1e-6
UNRESOLVED_REL = 1e-3
# TR-FEA-32: a kernel face and a Gmsh surface are the same face when area and centroid agree to this fraction (of the area / of the model diagonal)
FACE_MAP_REL = 1e-6
# CalculiX tet face labels over 0-based corner indices: 1 = 1-2-3, 2 = 1-4-2, 3 = 2-4-3, 4 = 3-4-1
CCX_FACES = ((1, (0, 1, 2)), (2, (0, 3, 1)), (3, (1, 3, 2)), (4, (2, 3, 0)))


class MeshError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _gmsh():
    try:
        import gmsh  # noqa: PLC0415
    except ImportError as error:
        raise MeshError("FEA_TOOL_MISSING", "the gmsh Python module is missing (pip install gmsh): %s" % error)
    return gmsh


def _dist(a, b):
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(a, b)))


def _scaled_stl(data, scale, path):
    import numpy as np  # noqa: PLC0415

    count = int(np.frombuffer(data, dtype="<u4", count=1, offset=80)[0])
    record = np.dtype([("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")])
    triangles = np.frombuffer(data, dtype=record, count=count, offset=84).copy()
    triangles["v"] = triangles["v"] * scale
    with open(path, "wb") as handle:
        handle.write(b"\0" * 80 + np.uint32(count).tobytes() + triangles.tobytes())


def _centroid_key(gmsh, element_nodes, coords):
    pts = [coords[n] for n in element_nodes[:3]]
    return tuple(round(sum(p[i] for p in pts) / 3.0, 7) for i in range(3))


def _node_coords(gmsh):
    tags, xyz, _ = gmsh.model.mesh.getNodes()
    return {int(t): (float(xyz[3 * i]), float(xyz[3 * i + 1]), float(xyz[3 * i + 2])) for i, t in enumerate(tags)}


def _surface_triangles(gmsh, surface):
    types, _, nodes = gmsh.model.mesh.getElements(2, surface)
    out = []
    for etype, enodes in zip(types, nodes):
        width = 3 if etype == TRI3 else 6
        out += [[int(n) for n in enodes[i : i + width]] for i in range(0, len(enodes), width)]
    return out


def _stl_face_regions(gmsh, path):
    """Facet-centroid -> face region id, from a classification without reparametrisation patches."""
    gmsh.merge(path)
    gmsh.model.mesh.classifySurfaces(CLASSIFY_ANGLE, True, False, math.pi)
    coords = _node_coords(gmsh)
    regions = {}
    for _, surface in gmsh.model.getEntities(2):
        for tri in _surface_triangles(gmsh, surface):
            regions[_centroid_key(gmsh, tri, coords)] = surface
    gmsh.clear()
    return regions


def _load_stl(gmsh, path):
    """Discrete geometry from an STL; returns {patch surface tag: face region id}."""
    regions = _stl_face_regions(gmsh, path)
    gmsh.merge(path)
    gmsh.model.mesh.classifySurfaces(CLASSIFY_ANGLE, True, True, math.pi)
    coords = _node_coords(gmsh)
    region_of = {}
    for _, surface in gmsh.model.getEntities(2):
        tris = _surface_triangles(gmsh, surface)
        key = _centroid_key(gmsh, tris[0], coords) if tris else None
        region_of[surface] = regions.get(key, surface)
    gmsh.model.mesh.createGeometry()
    surfaces = [tag for _, tag in gmsh.model.getEntities(2)]
    loop = gmsh.model.geo.addSurfaceLoop(surfaces)
    gmsh.model.geo.addVolume([loop])
    gmsh.model.geo.synchronize()
    return region_of


def _load_step(gmsh, path, scale):
    gmsh.option.setString("Geometry.OCCTargetUnit", "")
    gmsh.model.occ.importShapes(path)
    gmsh.model.occ.synchronize()
    if scale != 1.0:
        gmsh.model.occ.dilate(gmsh.model.occ.getEntities(), 0, 0, 0, scale, scale, scale)
        gmsh.model.occ.synchronize()
    if not gmsh.model.getEntities(3):
        raise MeshError("FEA_MESH_FAILED", "the STEP geometry has no solid")
    return {tag: tag for _, tag in gmsh.model.getEntities(2)}


def _trimmed_distance(gmsh, dim, tag, point):
    """Distance from point to the TRIMMED entity (getClosestPoint alone measures the untrimmed plane/cylinder/line)."""
    closest, parametric = gmsh.model.getClosestPoint(dim, tag, list(point))
    d = _dist(point, [float(c) for c in closest])
    try:
        if gmsh.model.isInside(dim, tag, list(parametric), True) > 0:
            return d
    except Exception:  # discrete (STL) entities: the closest point already lies on the mesh
        return d
    best = math.inf
    for bdim, btag in gmsh.model.getBoundary([(dim, tag)], combined=False, oriented=False):
        best = min(best, _trimmed_distance(gmsh, bdim, abs(btag), point) if bdim >= 1 else _dist(point, gmsh.model.getValue(0, abs(btag), [])))
    return best if best < math.inf else d


def _faces_of(gmsh, region_of, points, key, entity_id):
    """Face regions nearest to each point; residual = the largest point-to-face distance."""
    diag = _dist(gmsh.model.getBoundingBox(-1, -1)[:3], gmsh.model.getBoundingBox(-1, -1)[3:]) or 1.0
    resolved, residual = set(), 0.0
    for point in points:
        per_region = {}
        for surface, region in region_of.items():
            d = _trimmed_distance(gmsh, 2, surface, point)
            per_region[region] = min(d, per_region.get(region, math.inf))
        ranked = sorted(per_region.items(), key=lambda item: (item[1], item[0]))
        best_region, best = ranked[0]
        if best > UNRESOLVED_REL * diag:
            raise MeshError(
                "FEA_TARGET_UNRESOLVED",
                "target %s: no face of '%s' within %.3g of point %s (nearest is %.3g away)" % (key, entity_id, UNRESOLVED_REL * diag, list(point), best),
            )
        if len(ranked) > 1 and ranked[1][1] - best <= AMBIGUOUS_REL * diag:
            raise MeshError(
                "FEA_TARGET_AMBIGUOUS",
                "target %s: point %s lies on the boundary between two faces of '%s'; move it into the face interior" % (key, list(point), entity_id),
            )
        resolved.add(best_region)
        residual = max(residual, best)
    return resolved, residual


def _face_map(gmsh, region_of, refs, scale, entity_id):
    """Kernel face index -> (Gmsh surface tag, centroid residual) by area and centroid (TR-FEA-32). A face with no candidate is left out
    (its targets fall back to the nearest-surface resolution); a face with more than one candidate is left out too and listed in the
    returned `ambiguous` dict (index -> candidate tags): only a target that names it fails with AMBIGUOUS_FACE_MAP."""
    box = gmsh.model.getBoundingBox(-1, -1)
    diag = _dist(box[:3], box[3:]) or 1.0
    surfaces = []
    for surface in region_of:
        surfaces.append((surface, gmsh.model.occ.getMass(2, surface), gmsh.model.occ.getCenterOfMass(2, surface)))
    mapped, ambiguous = {}, {}
    for ref in refs:
        area = float(ref["area"]) * scale * scale
        centre = [float(c) * scale for c in ref["centroid"]]
        found = []
        for surface, surface_area, surface_centre in surfaces:
            distance = _dist(centre, surface_centre)
            if abs(surface_area - area) <= FACE_MAP_REL * area and distance <= FACE_MAP_REL * diag:
                found.append((surface, distance))
        if len(found) > 1:
            ambiguous[int(ref["index"])] = [s for s, _ in found]
        elif found:
            mapped[int(ref["index"])] = found[0]
    return mapped, ambiguous


def _edges_of(gmsh, points, key, entity_id, curves=None):
    diag = _dist(gmsh.model.getBoundingBox(-1, -1)[:3], gmsh.model.getBoundingBox(-1, -1)[3:]) or 1.0
    resolved, residual = set(), 0.0
    candidates = [tag for _, tag in gmsh.model.getEntities(1)] if curves is None else sorted(curves)
    for point in points:
        ranked = sorted((_trimmed_distance(gmsh, 1, tag, point), tag) for tag in candidates)
        if not ranked or ranked[0][0] > UNRESOLVED_REL * diag:
            raise MeshError("FEA_TARGET_UNRESOLVED", "target %s: no edge of '%s' near point %s" % (key, entity_id, list(point)))
        if len(ranked) > 1 and ranked[1][0] - ranked[0][0] <= AMBIGUOUS_REL * diag:
            raise MeshError("FEA_TARGET_AMBIGUOUS", "target %s: point %s lies on two edges of '%s'" % (key, list(point), entity_id))
        resolved.add(ranked[0][1])
        residual = max(residual, ranked[0][0])
    return resolved, residual


def _size_fields(gmsh, controls, refinements, scale):
    """Background field: global size, locally reduced near the refinement faces / points."""
    field = gmsh.model.mesh.field
    global_size = float(controls["globalSize"]) * scale
    fields = []
    base = field.add("MathEval")
    field.setString(base, "F", repr(global_size))
    fields.append(base)
    for item in refinements:
        size = float(item["size"]) * scale
        if item["surfaces"] or item.get("curves"):
            distance = field.add("Distance")
            if item["surfaces"]:
                field.setNumbers(distance, "SurfacesList", item["surfaces"])
            if item.get("curves"):
                field.setNumbers(distance, "CurvesList", item["curves"])
            field.setNumber(distance, "Sampling", 24)
            threshold = field.add("Threshold")
            field.setNumber(threshold, "InField", distance)
            field.setNumber(threshold, "SizeMin", size)
            field.setNumber(threshold, "SizeMax", global_size)
            field.setNumber(threshold, "DistMin", size)
            field.setNumber(threshold, "DistMax", max(2.0 * global_size, 2.0 * size))
            fields.append(threshold)
        for x, y, z in item["points"]:
            ball = field.add("Ball")
            field.setNumber(ball, "Radius", 1.5 * global_size)
            field.setNumber(ball, "VIn", size)
            field.setNumber(ball, "VOut", global_size)
            field.setNumber(ball, "XCenter", x)
            field.setNumber(ball, "YCenter", y)
            field.setNumber(ball, "ZCenter", z)
            field.setNumber(ball, "Thickness", global_size)
            fields.append(ball)
    low = field.add("Min")
    field.setNumbers(low, "FieldsList", fields)
    field.setAsBackgroundMesh(low)
    gmsh.option.setNumber("Mesh.MeshSizeMax", global_size)
    if controls.get("minSize") is not None:
        gmsh.option.setNumber("Mesh.MeshSizeMin", float(controls["minSize"]) * scale)


def _resolve_targets(gmsh, geometry_kind, region_of, curves, targets, controls, scale, entity_id, face_map=None, ambiguous=None):
    """Targets of one entity -> resolved faces / edges / points + the refinement fields they define. With a `face_map` a target that names
    kernel `faceIndices` all of which are mapped takes those surfaces instead of the nearest surface of its `facesNear` points; a target that
    names a face the map found ambiguous fails with AMBIGUOUS_FACE_MAP."""
    resolved = {}
    for target in targets:
        key = target["key"]
        faces, residual, edges = set(), 0.0, set()
        indices = target.get("faceIndices") or []
        clash = [int(i) for i in indices if ambiguous and int(i) in ambiguous]
        if clash:
            raise MeshError(
                "AMBIGUOUS_FACE_MAP",
                "target %s: face %s of '%s' matches Gmsh surfaces %s by area and centroid" % (key, clash[0], entity_id, ambiguous[clash[0]]),
            )
        if target.get("facesNear"):
            # always run the point resolution: it still reports FEA_TARGET_UNRESOLVED / FEA_TARGET_AMBIGUOUS and gives the residual
            faces, residual = _faces_of(gmsh, region_of, [[c * scale for c in p] for p in target["facesNear"]], key, entity_id)
        if face_map and indices and all(int(i) in face_map for i in indices):
            faces = {face_map[int(i)][0] for i in indices}
        if target.get("edgesNear"):
            if geometry_kind != "step":
                raise MeshError("FEA_TARGET_UNRESOLVED", "target %s: edgesNear needs exact STEP geometry (use the OCC kernel)" % key)
            edges, edge_residual = _edges_of(gmsh, [[c * scale for c in p] for p in target["edgesNear"]], key, entity_id, curves)
            residual = max(residual, edge_residual)
        resolved[key] = {"faces": faces, "edges": edges, "residual": residual, "points": [[c * scale for c in p] for p in target.get("pointsNear") or []]}
    refinements = [
        {
            "size": r["size"],
            "surfaces": [s for s, region in region_of.items() if region in resolved.get(r["key"], {}).get("faces", ())],
            "points": resolved.get(r["key"], {}).get("points", []),
        }
        for r in controls.get("refinements", [])
        if r["key"] in resolved
    ]
    return resolved, refinements


def _generate(gmsh, controls, refinements, scale, label):
    _size_fields(gmsh, controls, refinements, scale)
    for option, value in (
        ("Mesh.MeshSizeExtendFromBoundary", 0),
        ("Mesh.MeshSizeFromPoints", 0),
        ("Mesh.MeshSizeFromCurvature", 0),
        ("Mesh.ElementOrder", int(controls["order"])),
        ("Mesh.SecondOrderLinear", 1),
        ("Mesh.Algorithm3D", 1),
        ("Mesh.RandomFactor", 1e-9),
    ):
        gmsh.option.setNumber(option, value)
    try:
        gmsh.model.mesh.generate(3)
    except Exception as error:  # noqa: BLE001 - Gmsh raises a bare Exception on meshing failure
        raise MeshError("FEA_MESH_FAILED", "Gmsh could not mesh '%s': %s" % (label, error))


def _extract(gmsh, volumes, region_of, controls, entity_id, resolved):
    """Tetrahedra of `volumes`, the face triangles of `region_of` matched to their faces, curve nodes."""
    coords = _node_coords(gmsh)
    tets, wanted = [], TET10 if int(controls["order"]) == 2 else TET4
    for volume in volumes:
        types, _, nodes = gmsh.model.mesh.getElements(3, volume)
        for etype, enodes in zip(types, nodes):
            if etype != wanted:
                raise MeshError("FEA_MESH_FAILED", "unexpected Gmsh element type %d in '%s'" % (etype, entity_id))
            width = 10 if etype == TET10 else 4
            for i in range(0, len(enodes), width):
                row = [int(n) for n in enodes[i : i + width]]
                if width == 10:
                    row[8], row[9] = row[9], row[8]
                tets.append(row)
    if not tets:
        raise MeshError("FEA_MESH_FAILED", "Gmsh produced no tetrahedra for '%s'" % entity_id)

    face_index = {}
    for position, tet in enumerate(tets):
        for label, corners in CCX_FACES:
            face_index.setdefault(tuple(sorted(tet[c] for c in corners)), []).append((position, label))
    region_nodes, region_faces = {}, {}
    for surface, region in region_of.items():
        for tri in _surface_triangles(gmsh, surface):
            region_nodes.setdefault(region, set()).update(tri)
            hit = face_index.get(tuple(sorted(tri[:3])))
            if hit:
                region_faces.setdefault(region, []).append(hit[0])
    curve_nodes = {}
    for _, curve in gmsh.model.getEntities(1):
        curve_nodes[curve] = {int(n) for n in gmsh.model.mesh.getNodes(1, curve, True)[0]}
    element_type = "C3D10" if int(controls["order"]) == 2 else "C3D4"
    return {
        "coords": coords,
        "tets": tets,
        "blocks": [(element_type, tets)],
        "resolved": resolved,
        "region_nodes": region_nodes,
        "region_faces": region_faces,
        "curve_nodes": curve_nodes,
    }


def _mesh_part(gmsh, part, targets, controls, scale, workdir):
    """Mesh one entity in a fresh model; returns its raw mesh + target sets keyed by tags of this model."""
    entity_id = part["entityId"]
    geometry = part["geometry"]
    if geometry.get("kind") == "midsurface":
        import llull_shell  # noqa: PLC0415 - llull_shell imports this module

        return llull_shell.mesh_midsurface_part(gmsh, part, targets, controls, scale)
    gmsh.model.add("part_" + str(entity_id))
    path = os.path.join(workdir, "part_%d" % len(os.listdir(workdir)))
    removed = []
    if geometry["kind"] == "step":
        with open(path + ".step", "wb") as handle:
            handle.write(base64.b64decode(geometry["stepBase64"]))
        region_of = _load_step(gmsh, path + ".step", scale)
        if part.get("defeature"):
            import llull_shell  # noqa: PLC0415

            removed = llull_shell.defeature(gmsh, part["defeature"], scale, entity_id)
            region_of = {tag: tag for _, tag in gmsh.model.getEntities(2)}
    elif part.get("defeature"):
        raise MeshError("FEA_DEFEATURE_FAILED", "defeaturing '%s' needs exact STEP geometry (use the OCC kernel)" % entity_id)
    elif geometry["kind"] == "stl":
        _scaled_stl(base64.b64decode(geometry["stlBase64"]), scale, path + ".stl")
        region_of = _load_stl(gmsh, path + ".stl")
    else:
        raise MeshError("FEA_MESH_FAILED", "unknown geometry kind %r" % geometry.get("kind"))
    refs = [] if removed else (part.get("faces") or [])
    face_map, ambiguous = _face_map(gmsh, region_of, refs, scale, entity_id) if refs and geometry["kind"] == "step" else (None, None)
    resolved, refinements = _resolve_targets(
        gmsh, geometry["kind"], region_of, None, targets, controls, scale, entity_id, face_map, ambiguous
    )
    _generate(gmsh, controls, refinements, scale, entity_id)
    raw = _extract(gmsh, [tag for _, tag in gmsh.model.getEntities(3)], region_of, controls, entity_id, resolved)
    raw["defeatured"] = removed
    raw["face_map"] = [
        {"entityId": entity_id, "faceIndex": index, "tag": tag, "residual": residual} for index, (tag, residual) in sorted((face_map or {}).items())
    ]
    return raw


def _boundary_tags(gmsh, dim_tags):
    seen = []
    for _, tag in gmsh.model.getBoundary(dim_tags, combined=False, oriented=False):
        if tag not in seen:
            seen.append(tag)
    return seen


def _mesh_conformal(gmsh, parts, targets, controls, scale, workdir):
    """All parts in ONE model, fragmented so touching parts share their interface (nodes + faces); one raw mesh per part, same order."""
    gmsh.model.add("conformal")
    gmsh.option.setString("Geometry.OCCTargetUnit", "")
    imported = []
    for index, part in enumerate(parts):
        geometry = part["geometry"]
        if geometry["kind"] != "step":
            raise MeshError(
                "FEA_BONDING_UNSUPPORTED",
                "conformal bonding needs exact STEP geometry (use the OCC kernel): '%s' is %s" % (part["entityId"], geometry.get("kind")),
            )
        path = os.path.join(workdir, "conformal_%d.step" % index)
        with open(path, "wb") as handle:
            handle.write(base64.b64decode(geometry["stepBase64"]))
        volumes = [(dim, tag) for dim, tag in gmsh.model.occ.importShapes(path) if dim == 3]
        if not volumes:
            raise MeshError("FEA_MESH_FAILED", "the STEP geometry of '%s' has no solid" % part["entityId"])
        imported.append(volumes)
    gmsh.model.occ.synchronize()
    if scale != 1.0:
        gmsh.model.occ.dilate(gmsh.model.occ.getEntities(), 0, 0, 0, scale, scale, scale)
        gmsh.model.occ.synchronize()
    flat = [item for volumes in imported for item in volumes]
    try:
        _, mapping = gmsh.model.occ.fragment(flat, [])
        gmsh.model.occ.synchronize()
    except Exception as error:  # noqa: BLE001
        raise MeshError("FEA_MESH_FAILED", "Gmsh could not fragment the parts for conformal bonding: %s" % error)
    owner, volumes_of, cursor = {}, [], 0
    for part, volumes in zip(parts, imported):
        own = []
        for pieces in mapping[cursor : cursor + len(volumes)]:
            for dim, tag in pieces:
                if dim != 3:
                    continue
                if owner.setdefault(tag, part["entityId"]) != part["entityId"]:
                    raise MeshError(
                        "FEA_BONDING_OVERLAP",
                        "conformal bonding: '%s' and '%s' overlap in volume; parts may only touch (subtract one from the other)"
                        % (owner[tag], part["entityId"]),
                    )
                own.append(tag)
        cursor += len(volumes)
        volumes_of.append(own)
    scopes, resolved_all, refinements = [], [], []
    for part, own in zip(parts, volumes_of):
        surfaces = _boundary_tags(gmsh, [(3, v) for v in own])
        curves = set(_boundary_tags(gmsh, [(2, s) for s in surfaces]))
        region_of = {s: s for s in surfaces}
        mine = [t for t in targets if t.get("entityId") == part["entityId"]]
        resolved, local = _resolve_targets(gmsh, "step", region_of, curves, mine, controls, scale, part["entityId"])
        scopes.append(region_of)
        resolved_all.append(resolved)
        refinements += local
    _generate(gmsh, controls, refinements, scale, "conformal parts")
    return [
        _extract(gmsh, own, region_of, controls, part["entityId"], resolved)
        for part, own, region_of, resolved in zip(parts, volumes_of, scopes, resolved_all)
    ]


def _nearest_node(nodes, coords, point):
    best = min(nodes, key=lambda n: (_dist(coords[n], point), n))
    return best, _dist(coords[best], point)


def op_mesh(request):
    gmsh = _gmsh()
    parts = request.get("parts")
    if parts is None:
        parts = [{"entityId": request.get("entityId", "part"), "geometry": request["geometry"]}]
    scale = float(request.get("lengthScale", 1.0))
    controls = request["controls"]
    targets = request.get("targets", [])
    gmsh.initialize()
    try:
        gmsh.option.setNumber("General.Terminal", 0)
        gmsh.option.setNumber("General.NumThreads", 1)
        gmsh.option.setNumber("Mesh.MaxNumThreads1D", 1)
        gmsh.option.setNumber("Mesh.MaxNumThreads2D", 1)
        gmsh.option.setNumber("Mesh.MaxNumThreads3D", 1)
        version = gmsh.__version__
        nodes_out, blocks, node_sets, face_sets, residuals = [], [], {}, {}, {}
        node_counter = element_counter = 0
        defeatured = []
        part_nodes = {}
        conformal = controls.get("bonding") == "conformal"
        with tempfile.TemporaryDirectory(prefix="llull-mesh-") as workdir:
            raws = []
            if conformal:
                raws = _mesh_conformal(gmsh, parts, targets, controls, scale, workdir)
            else:
                for part in parts:
                    own = [t for t in targets if t.get("entityId") == part["entityId"]]
                    gmsh.clear()
                    raws.append(_mesh_part(gmsh, part, own, controls, scale, workdir))
            shared = None
            if conformal:
                shared = {}
                for tag in sorted({n for raw in raws for tet in raw["tets"] for n in tet}):
                    node_counter += 1
                    shared[tag] = node_counter
                    nodes_out.append([node_counter, *raws[0]["coords"][tag]])
            for part, raw in zip(parts, raws):
                used = sorted({n for _, rows in raw["blocks"] for row in rows for n in row})
                renumber = shared
                if renumber is None:
                    renumber = {}
                    for tag in used:
                        node_counter += 1
                        renumber[tag] = node_counter
                        nodes_out.append([node_counter, *raw["coords"][tag]])
                part_nodes[part["entityId"]] = (used, renumber, raw["coords"])
                element_ids = []
                for block_type, rows in raw["blocks"]:
                    elements = []
                    for row in rows:
                        element_counter += 1
                        element_ids.append(element_counter)
                        elements.append([element_counter, *(renumber[n] for n in row)])
                    blocks.append({"type": block_type, "entityId": part["entityId"], "elements": elements})
                if raw.get("defeatured"):
                    defeatured.append({"entityId": part["entityId"], "faces": raw["defeatured"]})
                for key, item in raw["resolved"].items():
                    nodes = set()
                    faces = []
                    for region in item["faces"]:
                        nodes |= raw["region_nodes"].get(region, set())
                        faces += [[element_ids[position], label] for position, label in raw["region_faces"].get(region, [])]
                    if "target_faces" in raw:
                        faces = [[element_ids[position], label] for position, label in raw["target_faces"].get(key, [])]
                    for curve in item["edges"]:
                        nodes |= raw["curve_nodes"].get(curve, set())
                    residual = item["residual"]
                    for point in item["points"]:
                        node, d = _nearest_node(used, raw["coords"], point)
                        nodes.add(node)
                        residual = max(residual, d)
                    node_sets[key] = sorted(renumber[n] for n in nodes if n in renumber)
                    if item["faces"]:
                        face_sets[key] = sorted(faces)
                    residuals[key] = {"residual": residual}
        for target in targets:
            key = target["key"]
            if target.get("entityId") is None:
                best, residual = None, math.inf
                for entity_id, (used, renumber, coords) in part_nodes.items():
                    for point in target.get("pointsNear") or []:
                        node, d = _nearest_node(used, coords, [c * scale for c in point])
                        if d < residual:
                            best, residual = renumber[node], d
                if best is None:
                    raise MeshError("FEA_TARGET_UNRESOLVED", "target %s: no mesh node found" % key)
                node_sets[key] = [best]
                residuals[key] = {"residual": residual}
            elif key not in residuals:
                raise MeshError("FEA_TARGET_UNRESOLVED", "target %s: entity '%s' is not a meshed part" % (key, target.get("entityId")))
            elif not node_sets.get(key):
                raise MeshError("FEA_TARGET_UNRESOLVED", "target %s resolved to no mesh node" % key)
        return {
            "ok": True,
            "mesher": "gmsh",
            "mesherVersion": version,
            "nodes": nodes_out,
            "blocks": blocks,
            "nodeSets": node_sets,
            "faceSets": face_sets,
            "targets": residuals,
            "faceMap": [entry for raw in raws for entry in raw.get("face_map", [])],
            "defeatured": defeatured,
        }
    finally:
        gmsh.finalize()
