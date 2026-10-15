#!/usr/bin/env python3
"""Measured OCCT behaviour that the KRN technical spec relies on (needs OCP: the CadQuery wheel, OCCT 7.9.x).

Writes occt_behaviour_probe.json next to this script. Every number in it is MEASURED by this script, not quoted:
  1. inertia_vs_offset   relative error of BRepGProp Iyy for a 100 x 50 x 20 box whose geometry sits at x = X,
                         X = 0 .. 1e6 mm (cancellation when the integration runs far from the geometry);
  2. part_frame          the same box at x = 70 000 mm measured (a) as is, (b) moved back by a TopLoc location only,
                         (c) with geometry copied back to the origin, (d) authored at the origin and placed by TopLoc;
  3. fuzzy_fuse          two 10 mm cubes with a 1e-5 mm gap fused without / with SetFuzzyValue(2e-5);
  4. determinism         the same plate-minus-cylinder cut built twice in one process: face count + a hash of
                         (area, centroid) per face in kernel order (cross-process / cross-version runs are compared
                         by the future regression gate, see TECHNICAL_SPEC section 9);
  5. fillet_history      BRepFilletAPI_MakeFillet on one box edge: faces Generated from the edge, input faces Modified.

Usage: python3 -I probe_occt_behaviour.py
"""

import hashlib
import json
import os

import OCP
from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut, BRepAlgoAPI_Fuse
from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepFilletAPI import BRepFilletAPI_MakeFillet
from OCP.BRepGProp import BRepGProp
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder
from OCP.GProp import GProp_GProps
from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_SOLID
from OCP.TopExp import TopExp
from OCP.TopLoc import TopLoc_Location
from OCP.TopTools import TopTools_IndexedMapOfShape, TopTools_ListOfShape
from OCP.TopoDS import TopoDS
from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt, gp_Trsf, gp_Vec

HERE = os.path.dirname(os.path.abspath(__file__))
A, B, C = 100.0, 50.0, 20.0
IYY_EXACT = A * B * C * (A * A + C * C) / 12  # about the centroid, density 1


def iyy_error(shape):
    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape, props)
    return abs(props.MatrixOfInertia().Value(2, 2) - IYY_EXACT) / IYY_EXACT


def translation(dx):
    t = gp_Trsf()
    t.SetTranslation(gp_Vec(dx, 0, 0))
    return t


def count(shape, kind):
    m = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(shape, kind, m)
    return m


def inertia_vs_offset():
    rows = []
    for x in [0.0, 1e3, 1e4, 7e4, 1e5, 1e6]:
        shape = BRepPrimAPI_MakeBox(gp_Pnt(x, 0, 0), A, B, C).Shape()
        rows.append({"x_mm": x, "iyy_rel_err": iyy_error(shape)})
    return rows


def part_frame():
    x = 70_000.0
    far = BRepPrimAPI_MakeBox(gp_Pnt(x, 0, 0), A, B, C).Shape()
    back = translation(-x)
    at_origin = BRepPrimAPI_MakeBox(A, B, C).Shape()
    return {
        "as_is": iyy_error(far),
        "moved_back_by_location_only": iyy_error(far.Moved(TopLoc_Location(back))),
        "geometry_copied_back_to_origin": iyy_error(BRepBuilderAPI_Transform(far, back, True).Shape()),
        "authored_at_origin_placed_by_location": iyy_error(at_origin.Moved(TopLoc_Location(translation(x)))),
    }


def fuzzy_fuse():
    left = BRepPrimAPI_MakeBox(10.0, 10.0, 10.0).Shape()
    right = BRepPrimAPI_MakeBox(gp_Pnt(10.0 + 1e-5, 0, 0), 10.0, 10.0, 10.0).Shape()

    def run(fuzzy):
        op = BRepAlgoAPI_Fuse()
        args, tools = TopTools_ListOfShape(), TopTools_ListOfShape()
        args.Append(left)
        tools.Append(right)
        op.SetArguments(args)
        op.SetTools(tools)
        if fuzzy:
            op.SetFuzzyValue(fuzzy)
        op.Build()
        shape = op.Shape()
        return {"fuzzy": fuzzy, "solids": count(shape, TopAbs_SOLID).Extent(), "faces": count(shape, TopAbs_FACE).Extent(),
                "valid": BRepCheck_Analyzer(shape).IsValid()}

    return {"gap_mm": 1e-5, "runs": [run(0.0), run(2e-5)]}


def face_signature():
    plate = BRepPrimAPI_MakeBox(80.0, 60.0, 10.0).Shape()
    hole = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(40, 30, -1), gp_Dir(0, 0, 1)), 12.0, 12.0).Shape()
    shape = BRepAlgoAPI_Cut(plate, hole).Shape()
    faces = count(shape, TopAbs_FACE)
    parts = []
    for i in range(1, faces.Extent() + 1):
        g = GProp_GProps()
        BRepGProp.SurfaceProperties_s(faces.FindKey(i), g)
        c = g.CentreOfMass()
        parts.append("%.9f,%.9f,%.9f,%.9f" % (g.Mass(), c.X(), c.Y(), c.Z()))
    return {"faces": faces.Extent(), "sha256_16": hashlib.sha256("|".join(parts).encode()).hexdigest()[:16]}


def fillet_history():
    box = BRepPrimAPI_MakeBox(10.0, 10.0, 10.0).Shape()
    edges, faces = count(box, TopAbs_EDGE), count(box, TopAbs_FACE)
    edge = TopoDS.Edge_s(edges.FindKey(1))
    maker = BRepFilletAPI_MakeFillet(box)
    maker.Add(1.0, edge)
    maker.Build()
    modified = sum(1 for i in range(1, faces.Extent() + 1) if maker.Modified(faces.FindKey(i)).Size() > 0)
    return {"faces_generated_from_edge": maker.Generated(edge).Size(), "input_faces_modified": modified,
            "input_faces": faces.Extent(), "result_valid": BRepCheck_Analyzer(maker.Shape()).IsValid()}


def main():
    first, second = face_signature(), face_signature()
    out = {
        "$comment": "Measured by probe_occt_behaviour.py; see TECHNICAL_SPEC sections 5 and 9.",
        "ocp": getattr(OCP, "__version__", "unknown"),
        "inertia_vs_offset": inertia_vs_offset(),
        "part_frame_at_70m": part_frame(),
        "fuzzy_fuse": fuzzy_fuse(),
        "determinism_same_process": {"run1": first, "run2": second, "identical": first == second},
        "fillet_history": fillet_history(),
    }
    with open(os.path.join(HERE, "occt_behaviour_probe.json"), "w", encoding="utf-8") as handle:
        json.dump(out, handle, indent=2)
        handle.write("\n")
    print(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
