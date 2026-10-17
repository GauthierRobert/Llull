#!/usr/bin/env python3
"""VC-FTR-33 cross-check: 3 x 80 x 20 mm rib on the 100 x 60 x 10 plate used by server/tests/occtFeatureOptions.test.ts,
built in pure OCP two ways (plain prism fuse, BRepFeat_MakeLinearForm) and measured with GProp.

Requires OCP (pip install cadquery-ocp==8.0.1.1.0). Run:  python3 -I crosscheck_rib_ocp.py
Writes data/expected_rib_ocp.json. Analytic value: 100*60*10 + 3*80*20 = 64800 mm^3.
Rib footprint: x 10..90, y 28.5..31.5 on the plate top face z=10 (path (10,30)-(90,30), thickness 3, symmetric), height 20 up.
"""

import json
import os
from importlib.metadata import version

from OCP.BRepAlgoAPI import BRepAlgoAPI_Fuse
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeEdge, BRepBuilderAPI_MakeFace, BRepBuilderAPI_MakeWire
from OCP.BRepFeat import BRepFeat_MakeLinearForm
from OCP.BRepGProp import BRepGProp
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakePrism
from OCP.Geom import Geom_Plane
from OCP.GProp import GProp_GProps
from OCP.gp import gp_Dir, gp_Pln, gp_Pnt, gp_Vec

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'data', 'expected_rib_ocp.json')

PLATE = (100.0, 60.0, 10.0)
RIB_T, RIB_LEN, RIB_H = 3.0, 80.0, 20.0
X0, X1, YC = 10.0, 90.0, 30.0


def volume(shape) -> float:
    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape, props)
    return props.Mass()


def footprint_wire():
    pts = [(X0, YC - RIB_T / 2), (X1, YC - RIB_T / 2), (X1, YC + RIB_T / 2), (X0, YC + RIB_T / 2)]
    wire = BRepBuilderAPI_MakeWire()
    for i, a in enumerate(pts):
        b = pts[(i + 1) % 4]
        wire.Add(BRepBuilderAPI_MakeEdge(gp_Pnt(a[0], a[1], PLATE[2]), gp_Pnt(b[0], b[1], PLATE[2])).Edge())
    return wire.Wire()


plate = BRepPrimAPI_MakeBox(*PLATE).Shape()
wire = footprint_wire()

prism = BRepPrimAPI_MakePrism(BRepBuilderAPI_MakeFace(wire).Face(), gp_Vec(0, 0, RIB_H)).Shape()
fused = BRepAlgoAPI_Fuse(plate, prism).Shape()

linear = BRepFeat_MakeLinearForm()
y_lo = YC - RIB_T / 2
plane = Geom_Plane(gp_Pln(gp_Pnt(0, y_lo, 0), gp_Dir(0, 1, 0)))
silhouette = BRepBuilderAPI_MakeWire()
corners = [(X0, PLATE[2]), (X1, PLATE[2]), (X1, PLATE[2] + RIB_H), (X0, PLATE[2] + RIB_H)]
for i, a in enumerate(corners):
    b = corners[(i + 1) % 4]
    silhouette.Add(BRepBuilderAPI_MakeEdge(gp_Pnt(a[0], y_lo, a[1]), gp_Pnt(b[0], y_lo, b[1])).Edge())
linear.Init(plate, silhouette.Wire(), plane, gp_Vec(0, RIB_T, 0), gp_Vec(0, 0, 0), 1, True)
linear.Perform()
linear_shape = linear.Shape()

analytic = PLATE[0] * PLATE[1] * PLATE[2] + RIB_T * RIB_LEN * RIB_H
result = {
    'generator': 'docs/aerospace/07-sheet-metal-machined-features/validation/crosscheck_rib_ocp.py',
    'ocp_version': version('cadquery-ocp'),
    'units': 'mm',
    'case': 'VC-FTR-33: 3 x 80 x 20 rib on 100 x 60 x 10 plate (add_rib path (10,30)-(90,30), symmetric, plane z=10)',
    'tolerance': {'volume_rel': 1e-6},
    'analytic_volume_mm3': analytic,
    'prism_fuse_volume_mm3': volume(fused),
    'linear_form_volume_mm3': volume(linear_shape),
    'linear_form_agrees': abs(volume(linear_shape) - analytic) / analytic < 1e-6,
    'linear_form_note': 'BRepFeat_MakeLinearForm (silhouette on the mid plane, Direction=(0,3,0), Direction1=(0,0,0)) returns a body that is not '
    'the rib (it sweeps a boundary-sliding form and needs a profile lying on a face of the base); the prism fuse is the reference. '
    'Not used as an assertion.',
}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, 'w') as handle:
    json.dump(result, handle, indent=1)
    handle.write('\n')
print(json.dumps(result, indent=1))
