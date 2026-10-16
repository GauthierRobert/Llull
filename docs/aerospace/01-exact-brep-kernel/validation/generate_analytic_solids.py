#!/usr/bin/env python3
"""Analytic reference solids for the exact B-rep kernel gap (KRN).

Writes, next to this script:
  analytic_solids.json   closed-form volume / area / centroid / inertia for every case (pure maths, no CAD kernel)
  analytic_solids.csv    the same, flat (one row per case)

Optional cross-check (only when OCP / CadQuery is importable, e.g. the desktop's bundled CPython):
  python3 generate_analytic_solids.py --occt
builds every case with plain OCCT makers + booleans, measures it with BRepGProp, checks BRepCheck_Analyzer,
and writes occt_crosscheck.json (OCCT value, analytic value, relative error, OCCT version). The analytic file
is the ground truth; the cross-check is evidence that the formulas and the case definitions agree with OCCT.

Conventions
  * units: millimetres; inertia is the mass moment of inertia per unit density (rho = 1), i.e. the
    second moment of volume, in mm^5, about axes through the CENTROID parallel to world X, Y, Z.
    Multiply by a density in g/mm^3 to get g*mm^2.
  * every formula is a textbook closed form (references in validation/README.md, section "Derivations");
    composite cases use superposition (body minus tool, parallel-axis theorem).

Usage: python3 generate_analytic_solids.py [--occt]
"""

import csv
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PI = math.pi

# Body-station offset used by the large-coordinate cases: 70 m aft of the datum, in mm.
STATION_X = 70_000.0


def box(a, b, c, origin=(0.0, 0.0, 0.0)):
    """a x b x c box with its min corner at origin."""
    v = a * b * c
    return {
        "volume": v,
        "area": 2 * (a * b + b * c + c * a),
        "centroid": [origin[0] + a / 2, origin[1] + b / 2, origin[2] + c / 2],
        "inertia": [v * (b * b + c * c) / 12, v * (a * a + c * c) / 12, v * (a * a + b * b) / 12],
    }


def cylinder(r, h, base=(0.0, 0.0, 0.0)):
    """Axis +Z, base centre at `base`."""
    v = PI * r * r * h
    ixx = v * (3 * r * r + h * h) / 12
    return {
        "volume": v,
        "area": 2 * PI * r * r + 2 * PI * r * h,
        "centroid": [base[0], base[1], base[2] + h / 2],
        "inertia": [ixx, ixx, v * r * r / 2],
    }


def tube(ro, ri, h):
    v = PI * (ro * ro - ri * ri) * h
    s = ro * ro + ri * ri
    ixx = v * (3 * s + h * h) / 12
    return {
        "volume": v,
        "area": 2 * PI * (ro * ro - ri * ri) + 2 * PI * (ro + ri) * h,
        "centroid": [0.0, 0.0, h / 2],
        "inertia": [ixx, ixx, v * s / 2],
    }


def sphere(r):
    v = 4 / 3 * PI * r ** 3
    i = 2 / 5 * v * r * r
    return {"volume": v, "area": 4 * PI * r * r, "centroid": [0.0, 0.0, 0.0], "inertia": [i, i, i]}


def cone(r, h):
    """Solid right circular cone, base (radius r) on z = 0, apex at z = h."""
    v = PI * r * r * h / 3
    ixx = v * (3 * r * r / 20 + 3 * h * h / 80)
    return {
        "volume": v,
        "area": PI * r * r + PI * r * math.sqrt(r * r + h * h),
        "centroid": [0.0, 0.0, h / 4],
        "inertia": [ixx, ixx, 3 / 10 * v * r * r],
    }


def torus(big_r, small_r):
    """Ring in the XY plane, axis Z."""
    v = 2 * PI * PI * big_r * small_r * small_r
    ixx = v * (big_r * big_r / 2 + 5 / 8 * small_r * small_r)
    return {
        "volume": v,
        "area": 4 * PI * PI * big_r * small_r,
        "centroid": [0.0, 0.0, 0.0],
        "inertia": [ixx, ixx, v * (big_r * big_r + 3 / 4 * small_r * small_r)],
    }


def plate_with_hole(a, b, t, r):
    """a x b x t plate (min corner at origin) with a centred through hole of radius r along Z."""
    plate = box(a, b, t)
    vh = PI * r * r * t
    ih_xx = vh * (3 * r * r + t * t) / 12  # hole axis passes through the plate centroid: no parallel-axis shift
    v = plate["volume"] - vh
    return {
        "volume": v,
        "area": plate["area"] - 2 * PI * r * r + 2 * PI * r * t,
        "centroid": plate["centroid"],
        "inertia": [plate["inertia"][0] - ih_xx, plate["inertia"][1] - ih_xx, plate["inertia"][2] - vh * r * r / 2],
    }


def rounded_pocket_plate(a, b, t, pw, pl, depth, rc):
    """a x b x t plate (min corner at origin) with one centred pocket pw x pl, depth `depth` from the top face,
    vertical corner radius rc (no floor fillet): the classic machined-rib/frame pocket.
    Pocket plan area = pw*pl - (4 - pi) rc^2.  Volume, area and centroid z only (inertia: see README)."""
    pocket_area = pw * pl - (4 - PI) * rc * rc
    pocket_perimeter = 2 * (pw + pl) - 8 * rc + 2 * PI * rc
    vp = pocket_area * depth
    plate = box(a, b, t)
    v = plate["volume"] - vp
    zc_plate = t / 2
    zc_pocket = t - depth / 2
    zc = (plate["volume"] * zc_plate - vp * zc_pocket) / v
    # the pocket opening removes pocket_area from the top face; the floor adds it back; walls add perimeter*depth
    area = plate["area"] + pocket_perimeter * depth
    return {"volume": v, "area": area, "centroid": [a / 2, b / 2, zc], "inertia": None}


def shifted(props, dx):
    out = dict(props)
    out["centroid"] = [props["centroid"][0] + dx, props["centroid"][1], props["centroid"][2]]
    return out


CASES = [
    # id, description, params, properties, purpose
    ("box-100x50x20", "box 100 x 50 x 20, min corner at origin", {"a": 100, "b": 50, "c": 20}, box(100, 50, 20),
     "planar faces only: volume/area/inertia must match to ~1e-12 relative"),
    ("cyl-r10-h40", "cylinder r 10, h 40, axis Z", {"r": 10, "h": 40}, cylinder(10, 40),
     "cylindrical + planar faces, seam edge"),
    ("tube-ro25-ri20-h100", "thin-wall tube ro 25, ri 20, h 100", {"ro": 25, "ri": 20, "h": 100}, tube(25, 20, 100),
     "inner shell orientation; thin wall"),
    ("sphere-r25", "sphere r 25", {"r": 25}, sphere(25),
     "degenerate pole edges, single spherical face"),
    ("cone-r20-h60", "solid cone r 20, h 60, apex up", {"r": 20, "h": 60}, cone(20, 60),
     "apex singularity; centroid at h/4"),
    ("torus-R40-r8", "torus R 40, r 8, axis Z", {"R": 40, "r": 8}, torus(40, 8),
     "toroidal face (fillet surfaces are toroidal)"),
    ("plate-hole-80x60x10-r12", "plate 80 x 60 x 10 with centred through hole r 12",
     {"a": 80, "b": 60, "t": 10, "r": 12}, plate_with_hole(80, 60, 10, 12),
     "boolean cut: volume and inertia by superposition"),
    ("rib-pocket-300x120x25", "rib blank 300 x 120 x 25, one pocket 260 x 80 x 20 deep, corner radius 10",
     {"a": 300, "b": 120, "t": 25, "pw": 260, "pl": 80, "depth": 20, "rc": 10},
     rounded_pocket_plate(300, 120, 25, 260, 80, 20, 10),
     "machined-from-billet pocket: thin 5 mm floor, rounded corners; buy-to-fly = blank volume / part volume"),
    ("box-station-70m", "box 100 x 50 x 20 with min corner at x = 70 000 mm (body station 70 m)",
     {"a": 100, "b": 50, "c": 20, "x0": STATION_X}, box(100, 50, 20, (STATION_X, 0.0, 0.0)),
     "large coordinates: centroid ulp and Precision::Confusion vs |x|"),
    ("plate-hole-station-70m", "plate-hole-80x60x10-r12 translated by +70 000 mm in X",
     {"a": 80, "b": 60, "t": 10, "r": 12, "x0": STATION_X}, shifted(plate_with_hole(80, 60, 10, 12), STATION_X),
     "boolean far from origin must equal the boolean at the origin, translated"),
]


def float_spacing(x):
    """Distance between x and the next representable IEEE-754 double (ulp), the floor on any coordinate error."""
    return math.ulp(x)


def analytic_records():
    records = []
    for case_id, description, params, props, purpose in CASES:
        rec = {
            "id": case_id,
            "description": description,
            "params_mm": params,
            "volume_mm3": props["volume"],
            "area_mm2": props["area"],
            "centroid_mm": props["centroid"],
            "inertia_rho1_mm5": props["inertia"],
            "purpose": purpose,
            "derivation": "closed form, see README Derivations",
        }
        if case_id == "rib-pocket-300x120x25":
            rec["buy_to_fly"] = (params["a"] * params["b"] * params["t"]) / props["volume"]
        if "x0" in params:
            rec["coordinate_ulp_mm"] = float_spacing(params["x0"] + params["a"])
        records.append(rec)
    return records


def write_outputs(records):
    meta = {
        "$comment": "Generated by generate_analytic_solids.py (pure maths, no CAD kernel). Units mm; inertia about the centroid, "
        "world-parallel axes, per unit density (mm^5). Tolerances: see expected_results.json.",
        "generator": "generate_analytic_solids.py",
        "cases": records,
    }
    with open(os.path.join(HERE, "analytic_solids.json"), "w", encoding="utf-8") as handle:
        json.dump(meta, handle, indent=2)
        handle.write("\n")
    with open(os.path.join(HERE, "analytic_solids.csv"), "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["id", "volume_mm3", "area_mm2", "cx_mm", "cy_mm", "cz_mm", "ixx_mm5", "iyy_mm5", "izz_mm5"])
        for r in records:
            inertia = r["inertia_rho1_mm5"] or ["", "", ""]
            writer.writerow([r["id"], repr(r["volume_mm3"]), repr(r["area_mm2"]), *map(repr, r["centroid_mm"]), *map(str, inertia)])


# --------------------------------------------------------------------------------------------- OCCT cross-check


def occt_shapes():
    """Build each case with plain OCCT (no llull code). Imported lazily: the analytic part needs no OCP."""
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
    from OCP.BRepPrimAPI import (BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCone, BRepPrimAPI_MakeCylinder,
                                 BRepPrimAPI_MakePrism, BRepPrimAPI_MakeSphere, BRepPrimAPI_MakeTorus)
    from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform, BRepBuilderAPI_MakeFace
    from OCP.BRepFilletAPI import BRepFilletAPI_MakeFillet2d
    from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt, gp_Trsf, gp_Vec

    def cut(a, b):
        op = BRepAlgoAPI_Cut(a, b)
        op.Build()
        assert op.IsDone()
        return op.Shape()

    def moved(shape, dx):
        t = gp_Trsf()
        t.SetTranslation(gp_Vec(dx, 0, 0))
        return BRepBuilderAPI_Transform(shape, t, True).Shape()

    def plate_hole():
        plate = BRepPrimAPI_MakeBox(80.0, 60.0, 10.0).Shape()
        hole = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(40, 30, -1), gp_Dir(0, 0, 1)), 12.0, 12.0).Shape()
        return cut(plate, hole)

    def rib_pocket():
        from OCP.BRepBuilderAPI import BRepBuilderAPI_MakePolygon
        from OCP.TopExp import TopExp_Explorer
        from OCP.TopAbs import TopAbs_VERTEX
        from OCP.TopoDS import TopoDS

        blank = BRepPrimAPI_MakeBox(300.0, 120.0, 25.0).Shape()
        poly = BRepBuilderAPI_MakePolygon(gp_Pnt(20, 20, 5), gp_Pnt(280, 20, 5), gp_Pnt(280, 100, 5), gp_Pnt(20, 100, 5), True)
        face = BRepBuilderAPI_MakeFace(poly.Wire(), True).Face()
        rounded = BRepFilletAPI_MakeFillet2d(face)
        explorer = TopExp_Explorer(face, TopAbs_VERTEX)
        seen = []
        while explorer.More():
            vertex = TopoDS.Vertex_s(explorer.Current())
            if not any(vertex.IsSame(s) for s in seen):
                seen.append(vertex)
                rounded.AddFillet(vertex, 10.0)
            explorer.Next()
        rounded.Build()
        pocket = BRepPrimAPI_MakePrism(rounded.Shape(), gp_Vec(0, 0, 21)).Shape()  # through the top face
        return cut(blank, pocket)

    def tube_shape():
        outer = BRepPrimAPI_MakeCylinder(25.0, 100.0).Shape()
        inner = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(0, 0, -1), gp_Dir(0, 0, 1)), 20.0, 102.0).Shape()
        return cut(outer, inner)

    return {
        "box-100x50x20": lambda: BRepPrimAPI_MakeBox(100.0, 50.0, 20.0).Shape(),
        "cyl-r10-h40": lambda: BRepPrimAPI_MakeCylinder(10.0, 40.0).Shape(),
        "tube-ro25-ri20-h100": tube_shape,
        "sphere-r25": lambda: BRepPrimAPI_MakeSphere(25.0).Shape(),
        "cone-r20-h60": lambda: BRepPrimAPI_MakeCone(20.0, 0.0, 60.0).Shape(),
        "torus-R40-r8": lambda: BRepPrimAPI_MakeTorus(40.0, 8.0).Shape(),
        "plate-hole-80x60x10-r12": plate_hole,
        "rib-pocket-300x120x25": rib_pocket,
        "box-station-70m": lambda: BRepPrimAPI_MakeBox(gp_Pnt(STATION_X, 0, 0), 100.0, 50.0, 20.0).Shape(),
        "plate-hole-station-70m": lambda: moved(plate_hole(), STATION_X),
    }


def occt_measure(shape):
    from OCP.BRepCheck import BRepCheck_Analyzer
    from OCP.BRepGProp import BRepGProp
    from OCP.GProp import GProp_GProps

    vp = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape, vp)
    sp = GProp_GProps()
    BRepGProp.SurfaceProperties_s(shape, sp)
    c = vp.CentreOfMass()
    m = vp.MatrixOfInertia()  # about the centre of mass, density 1
    return {
        "volume_mm3": vp.Mass(),
        "area_mm2": sp.Mass(),
        "centroid_mm": [c.X(), c.Y(), c.Z()],
        "inertia_rho1_mm5": [m.Value(1, 1), m.Value(2, 2), m.Value(3, 3)],
        "valid": BRepCheck_Analyzer(shape).IsValid(),
    }


def rel(a, b):
    return abs(a - b) / max(abs(b), 1e-300)


def occt_crosscheck(records):
    import OCP

    builders = occt_shapes()
    rows = []
    for r in records:
        measured = occt_measure(builders[r["id"]]())
        row = {"id": r["id"], "valid": measured["valid"], "occt": measured, "relErr": {}}
        row["relErr"]["volume"] = rel(measured["volume_mm3"], r["volume_mm3"])
        row["relErr"]["area"] = rel(measured["area_mm2"], r["area_mm2"])
        row["absErr_centroid_mm"] = max(abs(a - b) for a, b in zip(measured["centroid_mm"], r["centroid_mm"]))
        if r["inertia_rho1_mm5"] is not None:
            row["relErr"]["inertia"] = max(rel(a, b) for a, b in zip(measured["inertia_rho1_mm5"], r["inertia_rho1_mm5"]))
        rows.append(row)
    version = getattr(OCP, "__version__", "unknown")
    out = {"$comment": "BRepGProp (default, exact-geometry integration) vs closed form; generated by --occt.", "ocp": version, "cases": rows}
    with open(os.path.join(HERE, "occt_crosscheck.json"), "w", encoding="utf-8") as handle:
        json.dump(out, handle, indent=2)
        handle.write("\n")
    worst = max(max(row["relErr"].values()) for row in rows)
    print(f"OCCT cross-check: {len(rows)} cases, worst relative error {worst:.3e}, all valid: {all(r['valid'] for r in rows)}")


def main():
    records = analytic_records()
    write_outputs(records)
    print(f"wrote {len(records)} analytic cases")
    if "--occt" in sys.argv:
        occt_crosscheck(records)


if __name__ == "__main__":
    main()
