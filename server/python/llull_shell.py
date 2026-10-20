"""
llull FE mesher, 2D parts (FEA-REST part 3, 05 M6): shell / plane-stress parts meshed on their midsurface, and Gmsh defeaturing of STEP parts.

Geometry kind "midsurface" (lengths in DOCUMENT units, scaled by `lengthScale`):
  {"kind": "midsurface", "element": "shell" | "plane_stress", "thickness": t,
   "faces": [{"outer": [[x,y,z]...], "holes": [[[x,y,z]...]], "normal": [nx,ny,nz]}]}
Every face becomes an OCC plane surface; all faces are fragmented together so touching faces share their edges (conformal), then meshed in
2D: triangles (S3 / S6, CPS3 / CPS6) or, with controls.elementFamily == "shell_quad", all quadrilaterals by subdivision (S4 / S8, CPS4 / CPS8).
Elements are oriented so their corner normal follows the face "normal" (the top of the wall).

Targets: a facesNear point resolves to the nearest mid face, or to the nearest boundary curve when that curve is as near as the face (a point
on a side wall of the solid targets the shell edge there); faces get a pressure side label (1 = the point is on the +normal side, 2 = below).
Unresolved within max(1e-3 x model size, 0.75 t). edgesNear -> nearest curve; pointsNear -> nearest node (llull_mesh).
"""

import math

from llull_mesh import AMBIGUOUS_REL, UNRESOLVED_REL, MeshError, _dist, _node_coords, _size_fields, _trimmed_distance

TRI3, QUAD4, TRI6, QUAD8 = 2, 3, 9, 16
WIDTH = {TRI3: 3, QUAD4: 4, TRI6: 6, QUAD8: 8}
SUFFIX = {TRI3: "3", QUAD4: "4", TRI6: "6", QUAD8: "8"}
# reverse the corner order (and the mid-edge nodes with it) of each element shape
FLIP = {
    TRI3: (0, 2, 1),
    QUAD4: (0, 3, 2, 1),
    TRI6: (0, 2, 1, 5, 4, 3),
    QUAD8: (0, 3, 2, 1, 7, 6, 5, 4),
}


def _sub(a, b):
    return [x - y for x, y in zip(a, b)]


def _cross(a, b):
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]


def _dot(a, b):
    return sum(x * y for x, y in zip(a, b))


def _build_faces(gmsh, faces, scale):
    occ = gmsh.model.occ
    inputs = []
    for face in faces:
        loops = []
        for loop in [face["outer"], *(face.get("holes") or [])]:
            points = [occ.addPoint(*(float(c) * scale for c in p)) for p in loop]
            lines = [occ.addLine(points[i], points[(i + 1) % len(points)]) for i in range(len(points))]
            loops.append(occ.addCurveLoop(lines))
        inputs.append(((2, occ.addPlaneSurface(loops)), [float(c) for c in face["normal"]]))
    occ.synchronize()
    if len(inputs) > 1:
        _, mapping = occ.fragment([dim_tag for dim_tag, _ in inputs], [])
        occ.synchronize()
    else:
        mapping = [[dim_tag] for dim_tag, _ in inputs]
    normal_of = {}
    for (_, normal), pieces in zip(inputs, mapping):
        for dim, tag in pieces:
            if dim == 2:
                normal_of.setdefault(tag, normal)
    return normal_of


def _resolve(gmsh, normal_of, targets, scale, thickness, entity_id):
    box = gmsh.model.getBoundingBox(-1, -1)
    diag = _dist(box[:3], box[3:]) or 1.0
    tolerance = max(UNRESOLVED_REL * diag, 0.75 * thickness)
    surfaces = sorted(normal_of)
    curves = sorted(tag for _, tag in gmsh.model.getEntities(1))
    resolved = {}
    for target in targets:
        key = target["key"]
        faces, edges, residual = {}, set(), 0.0
        for point in [[float(c) * scale for c in p] for p in target.get("facesNear") or []]:
            ranked_s = sorted((_trimmed_distance(gmsh, 2, s, point), s) for s in surfaces)
            ranked_c = sorted((_trimmed_distance(gmsh, 1, c, point), c) for c in curves)
            on_edge = ranked_c and ranked_c[0][0] <= ranked_s[0][0] + AMBIGUOUS_REL * diag
            ranked = ranked_c if on_edge else ranked_s
            best, tag = ranked[0]
            if best > tolerance:
                raise MeshError("FEA_TARGET_UNRESOLVED", "target %s: no mid face or edge of '%s' near point %s" % (key, entity_id, point))
            if len(ranked) > 1 and ranked[1][0] - best <= AMBIGUOUS_REL * diag:
                raise MeshError("FEA_TARGET_AMBIGUOUS", "target %s: point %s is as near to two %s of '%s'" % (key, point, "edges" if on_edge else "faces", entity_id))
            residual = max(residual, best)
            if on_edge:
                edges.add(tag)
            else:
                closest = [float(c) for c in gmsh.model.getClosestPoint(2, tag, point)[0]]
                faces.setdefault(tag, 1 if _dot(_sub(point, closest), normal_of[tag]) >= 0 else 2)
        for point in [[float(c) * scale for c in p] for p in target.get("edgesNear") or []]:
            ranked = sorted((_trimmed_distance(gmsh, 1, c, point), c) for c in curves)
            if not ranked or ranked[0][0] > tolerance:
                raise MeshError("FEA_TARGET_UNRESOLVED", "target %s: no edge of '%s' near point %s" % (key, entity_id, point))
            if len(ranked) > 1 and ranked[1][0] - ranked[0][0] <= AMBIGUOUS_REL * diag:
                raise MeshError("FEA_TARGET_AMBIGUOUS", "target %s: point %s lies on two edges of '%s'" % (key, point, entity_id))
            edges.add(ranked[0][1])
            residual = max(residual, ranked[0][0])
        resolved[key] = {
            "faces": set(faces),
            "labels": faces,
            "edges": edges,
            "residual": residual,
            "points": [[float(c) * scale for c in p] for p in target.get("pointsNear") or []],
        }
    return resolved


def _generate(gmsh, controls, refinements, scale, entity_id):
    _size_fields(gmsh, controls, refinements, scale)
    quads = controls.get("elementFamily") == "shell_quad"
    for option, value in (
        ("Mesh.MeshSizeExtendFromBoundary", 0),
        ("Mesh.MeshSizeFromPoints", 0),
        ("Mesh.MeshSizeFromCurvature", 0),
        ("Mesh.ElementOrder", int(controls["order"])),
        ("Mesh.SecondOrderIncomplete", 1),
        ("Mesh.SecondOrderLinear", 1),
        ("Mesh.RandomFactor", 1e-9),
        ("Mesh.Algorithm", 8 if quads else 6),
        ("Mesh.RecombineAll", 1 if quads else 0),
        ("Mesh.RecombinationAlgorithm", 1),
        ("Mesh.SubdivisionAlgorithm", 1 if quads else 0),
    ):
        gmsh.option.setNumber(option, value)
    try:
        gmsh.model.mesh.generate(2)
    except Exception as error:  # noqa: BLE001 - Gmsh raises a bare Exception on meshing failure
        raise MeshError("FEA_MESH_FAILED", "Gmsh could not mesh the midsurface of '%s': %s" % (entity_id, error))


def mesh_midsurface_part(gmsh, part, targets, controls, scale):
    """Mesh one 2D part in a fresh model; returns the raw mesh dict op_mesh assembles (blocks, sets, target faces)."""
    entity_id = part["entityId"]
    geometry = part["geometry"]
    prefix = "S" if geometry.get("element") == "shell" else "CPS"
    thickness = float(geometry["thickness"]) * scale
    gmsh.model.add("mid_" + str(entity_id))
    points = [p for face in geometry["faces"] for p in face["outer"]]
    span = max((_dist(a, b) for a in points[:64] for b in points[:64]), default=1.0) * scale
    gmsh.option.setNumber("Geometry.ToleranceBoolean", max(1e-9, 1e-7 * span))
    normal_of = _build_faces(gmsh, geometry["faces"], scale)
    if not normal_of:
        raise MeshError("FEA_MESH_FAILED", "the midsurface of '%s' has no face" % entity_id)
    resolved = _resolve(gmsh, normal_of, targets, scale, thickness, entity_id)
    refinements = [
        {
            "size": r["size"],
            "surfaces": sorted(resolved.get(r["key"], {}).get("faces", ())),
            "curves": sorted(resolved.get(r["key"], {}).get("edges", ())),
            "points": resolved.get(r["key"], {}).get("points", []),
        }
        for r in controls.get("refinements", [])
        if r["key"] in resolved
    ]
    _generate(gmsh, controls, refinements, scale, entity_id)
    coords = _node_coords(gmsh)
    per_type, surface_of = {}, {}
    for surface in sorted(normal_of):
        normal = normal_of[surface]
        types, _, nodes = gmsh.model.mesh.getElements(2, surface)
        for etype, enodes in zip(types, nodes):
            if etype not in WIDTH:
                raise MeshError("FEA_MESH_FAILED", "unexpected Gmsh element type %d in '%s'" % (etype, entity_id))
            width = WIDTH[etype]
            for i in range(0, len(enodes), width):
                row = [int(n) for n in enodes[i : i + width]]
                a, b, c = (coords[n] for n in row[:3])
                if _dot(_cross(_sub(b, a), _sub(c, a)), normal) < 0:
                    row = [row[k] for k in FLIP[etype]]
                per_type.setdefault(etype, []).append((row, surface))
    blocks, positions = [], {}
    for etype in sorted(per_type):
        rows = []
        for row, surface in per_type[etype]:
            positions.setdefault(surface, []).append(sum(len(r) for _, r in blocks) + len(rows))
            rows.append(row)
        blocks.append((prefix + SUFFIX[etype], rows))
    if not blocks:
        raise MeshError("FEA_MESH_FAILED", "Gmsh produced no 2D elements for '%s'" % entity_id)
    region_nodes = {}
    for etype in per_type:
        for row, surface in per_type[etype]:
            region_nodes.setdefault(surface, set()).update(row)
    curve_nodes = {curve: {int(n) for n in gmsh.model.mesh.getNodes(1, curve, True)[0]} for _, curve in gmsh.model.getEntities(1)}
    target_faces = {
        key: sorted((position, label) for surface, label in item["labels"].items() for position in positions.get(surface, []))
        for key, item in resolved.items()
        if item["labels"]
    }
    return {
        "coords": coords,
        "blocks": blocks,
        "resolved": resolved,
        "region_nodes": region_nodes,
        "region_faces": {},
        "curve_nodes": curve_nodes,
        "target_faces": target_faces,
        "face_map": [],
    }


def defeature(gmsh, spec, scale, entity_id):
    """Remove cylinder / torus faces of radius <= maxFeatureSize and the faces nearest to facesNear (Gmsh occ.defeature); returns the tags."""
    chosen = set()
    size = spec.get("maxFeatureSize")
    if size is not None:
        limit = float(size) * scale
        for _, tag in gmsh.model.getEntities(2):
            if gmsh.model.getType(2, tag) not in ("Cylinder", "Torus"):
                continue
            low, high = gmsh.model.getParametrizationBounds(2, tag)
            uv = [(low[0] + high[0]) / 2.0, (low[1] + high[1]) / 2.0]
            kmax, kmin, _, _ = gmsh.model.getPrincipalCurvatures(tag, uv)
            curvature = max(abs(float(kmax[0])), abs(float(kmin[0])))
            if curvature > 0 and 1.0 / curvature <= limit:
                chosen.add(tag)
    surfaces = [tag for _, tag in gmsh.model.getEntities(2)]
    for point in spec.get("facesNear") or []:
        scaled = [float(c) * scale for c in point]
        chosen.add(min(surfaces, key=lambda s: (_trimmed_distance(gmsh, 2, s, scaled), s)))
    if not chosen:
        return []
    volumes = [tag for _, tag in gmsh.model.getEntities(3)]
    try:
        gmsh.model.occ.defeature(volumes, sorted(chosen))
        gmsh.model.occ.synchronize()
    except Exception as error:  # noqa: BLE001
        raise MeshError("FEA_DEFEATURE_FAILED", "Gmsh could not remove faces %s of '%s': %s" % (sorted(chosen), entity_id, error))
    if math.isnan(sum(gmsh.model.getBoundingBox(-1, -1))):
        raise MeshError("FEA_DEFEATURE_FAILED", "defeaturing '%s' left no geometry" % entity_id)
    return sorted(chosen)
