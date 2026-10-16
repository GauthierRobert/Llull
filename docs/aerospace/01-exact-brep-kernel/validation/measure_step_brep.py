#!/usr/bin/env python3
"""Exact-B-rep reference measurements of STEP files with plain OCCT (needs OCP, e.g. the CadQuery wheel).

For each STEP file: read with STEPControl_Reader (default ShapeFix shape processing, units -> mm), then report
  solids / shells / faces / edges / vertices, BRepCheck_Analyzer validity BEFORE and AFTER an explicit
  ShapeFix_Shape pass, max sub-shape tolerance (BRep_Tool), BRepGProp volume / area / centroid / inertia
  (inertia: density 1, about the centroid, world axes), optimal bounding box, read time, and a topology
  signature hash (per-face area + centroid in kernel order) of two independent reads (same-process determinism).

This is the ORACLE a llull `import_step_exact` must reproduce (TECHNICAL_SPEC TR-KRN-20..24, VC-KRN-04..06):
volume / area / centroid are compared with the CAD-system-written geometric validation properties (GVP) where
the file has them (NIST AP242 files; values in ../../04-interop-ap242-jt-iges/validation/nist_pmi_gvp_reference.json).

Usage: python3 -I measure_step_brep.py OUT.json FILE.stp [FILE.stp ...]
"""

import hashlib
import json
import os
import sys
import time

from OCP.Bnd import Bnd_Box
from OCP.BRep import BRep_Tool
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepGProp import BRepGProp
from OCP.GProp import GProp_GProps
from OCP.IFSelect import IFSelect_RetDone
from OCP.ShapeFix import ShapeFix_Shape
from OCP.STEPControl import STEPControl_Reader
from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_SHELL, TopAbs_SOLID, TopAbs_VERTEX
from OCP.TopExp import TopExp
from OCP.TopoDS import TopoDS
from OCP.TopTools import TopTools_IndexedMapOfShape


def sub_shapes(shape, kind):
    m = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(shape, kind, m)
    return [m.FindKey(i) for i in range(1, m.Extent() + 1)]


def read(path):
    reader = STEPControl_Reader()
    if reader.ReadFile(path) != IFSelect_RetDone:
        raise ValueError("ReadFile failed")
    reader.TransferRoots()
    return reader.OneShape()


def max_tolerance(shape):
    worst = 0.0
    for v in sub_shapes(shape, TopAbs_VERTEX):
        worst = max(worst, BRep_Tool.Tolerance_s(TopoDS.Vertex_s(v)))
    for e in sub_shapes(shape, TopAbs_EDGE):
        worst = max(worst, BRep_Tool.Tolerance_s(TopoDS.Edge_s(e)))
    for f in sub_shapes(shape, TopAbs_FACE):
        worst = max(worst, BRep_Tool.Tolerance_s(TopoDS.Face_s(f)))
    return worst


def signature(shape):
    parts = []
    for f in sub_shapes(shape, TopAbs_FACE):
        g = GProp_GProps()
        BRepGProp.SurfaceProperties_s(f, g)
        c = g.CentreOfMass()
        parts.append("%.6f,%.6f,%.6f,%.6f" % (g.Mass(), c.X(), c.Y(), c.Z()))
    return hashlib.sha256("|".join(parts).encode()).hexdigest()[:16]


def measure(path):
    started = time.perf_counter()
    shape = read(path)
    read_seconds = time.perf_counter() - started
    valid_raw = BRepCheck_Analyzer(shape).IsValid()
    fixer = ShapeFix_Shape(shape)
    fixer.Perform()
    fixed = fixer.Shape()
    vp = GProp_GProps()
    BRepGProp.VolumeProperties_s(fixed, vp)
    sp = GProp_GProps()
    BRepGProp.SurfaceProperties_s(fixed, sp)
    c = vp.CentreOfMass()
    inertia = vp.MatrixOfInertia()
    box = Bnd_Box()
    BRepBndLib.AddOptimal_s(fixed, box, False, False)
    xmin, ymin, zmin, xmax, ymax, zmax = box.Get()
    return {
        "file": os.path.basename(path),
        "bytes": os.path.getsize(path),
        "sha256": hashlib.sha256(open(path, "rb").read()).hexdigest(),
        "readSeconds": round(read_seconds, 3),
        "solids": len(sub_shapes(fixed, TopAbs_SOLID)),
        "shells": len(sub_shapes(fixed, TopAbs_SHELL)),
        "faces": len(sub_shapes(fixed, TopAbs_FACE)),
        "edges": len(sub_shapes(fixed, TopAbs_EDGE)),
        "vertices": len(sub_shapes(fixed, TopAbs_VERTEX)),
        "validAsRead": valid_raw,
        "validAfterShapeFix": BRepCheck_Analyzer(fixed).IsValid(),
        "maxToleranceMm": max_tolerance(fixed),
        "volumeMm3": vp.Mass(),
        "areaMm2": sp.Mass(),
        "centroidMm": [c.X(), c.Y(), c.Z()],
        "inertiaRho1Mm5": [[inertia.Value(i, j) for j in (1, 2, 3)] for i in (1, 2, 3)],
        "bboxMm": [xmin, ymin, zmin, xmax, ymax, zmax],
        "signature": signature(fixed),
        "signatureSecondRead": signature(read(path)),
    }


def main():
    out_path, files = sys.argv[1], sys.argv[2:]
    rows = []
    for path in files:
        try:
            rows.append(measure(path))
        except Exception as error:  # noqa: BLE001 - one bad file must not hide the others
            rows.append({"file": os.path.basename(path), "error": f"{type(error).__name__}: {error}"})
        print(json.dumps({k: rows[-1].get(k) for k in ("file", "solids", "faces", "validAsRead", "validAfterShapeFix", "volumeMm3")}))
    import OCP

    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump({"$comment": "Measured by measure_step_brep.py (plain OCCT, not llull).", "ocp": getattr(OCP, "__version__", "?"),
                   "files": rows}, handle, indent=1)
        handle.write("\n")


if __name__ == "__main__":
    main()
