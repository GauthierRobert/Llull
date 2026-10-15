#!/usr/bin/env python3
"""Survey a STEP part's machining-relevant B-rep content (feature-recognition ground truth helper).

Reads one STEP file with OCP (pip install cadquery-ocp) and prints JSON:
  volume, bounding box, face counts per surface type, distinct cylinder radii (count of faces each),
  distinct cone semi-angles (included angle = 2 x semi-angle -> countersink angle), and for each cone the set of
  adjacent face kinds (cylinder radius or 'plane'): a cone between a plane and one cylinder is a countersink or chamfer
  seed, a cone touching one cylinder only is a drill point. CAD exporters often split one periodic face into two
  halves, so the count of distinct cone apexes (not of cone faces) is the per-feature count.

Usage:  python3 -I survey_step_features.py <file.stp> [<file.stp> ...] > step_feature_survey.json
The output is a MEASURED baseline (category (c) in TEMPLATE.md): it is what OCCT reads from the pinned file,
not an engineering judgement of which faces form which feature. Feature-level expectations
(e.g. "n countersunk holes") are derived from it in expected_feature_recognition.json.
"""

import json
import math
import sys
from collections import Counter

from OCP.BRepAdaptor import BRepAdaptor_Surface
from OCP.BRepBndLib import BRepBndLib
from OCP.Bnd import Bnd_Box
from OCP.BRepGProp import BRepGProp
from OCP.GProp import GProp_GProps
from OCP.GeomAbs import (
    GeomAbs_BSplineSurface,
    GeomAbs_Cone,
    GeomAbs_Cylinder,
    GeomAbs_Plane,
    GeomAbs_Sphere,
    GeomAbs_SurfaceOfExtrusion,
    GeomAbs_SurfaceOfRevolution,
    GeomAbs_Torus,
)
from OCP.IFSelect import IFSelect_RetDone
from OCP.STEPControl import STEPControl_Reader
from OCP.TopAbs import TopAbs_FACE, TopAbs_SOLID
from OCP.TopExp import TopExp_Explorer
from OCP.TopAbs import TopAbs_EDGE
from OCP.TopoDS import TopoDS

NAMES = {
    GeomAbs_Plane: 'plane',
    GeomAbs_Cylinder: 'cylinder',
    GeomAbs_Cone: 'cone',
    GeomAbs_Sphere: 'sphere',
    GeomAbs_Torus: 'torus',
    GeomAbs_BSplineSurface: 'bspline',
    GeomAbs_SurfaceOfRevolution: 'revolution',
    GeomAbs_SurfaceOfExtrusion: 'extrusion',
}


def survey(path: str) -> dict:
    reader = STEPControl_Reader()
    if reader.ReadFile(path) != IFSelect_RetDone:
        return {'file': path, 'error': 'read failed'}
    reader.TransferRoots()
    shape = reader.OneShape()
    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape, props)
    box = Bnd_Box()
    BRepBndLib.Add_s(shape, box)
    lo, hi = box.CornerMin(), box.CornerMax()
    xmin, ymin, zmin, xmax, ymax, zmax = lo.X(), lo.Y(), lo.Z(), hi.X(), hi.Y(), hi.Z()
    types: Counter = Counter()
    radii: Counter = Counter()
    cone_semi: Counter = Counter()
    apexes: set = set()
    explorer = TopExp_Explorer(shape, TopAbs_FACE)
    while explorer.More():
        face = TopoDS.Face(explorer.Current())
        adaptor = BRepAdaptor_Surface(face)
        kind = NAMES.get(adaptor.GetType(), 'other')
        types[kind] += 1
        if kind == 'cylinder':
            radii[round(adaptor.Cylinder().Radius(), 4)] += 1
        elif kind == 'cone':
            semi = round(math.degrees(abs(adaptor.Cone().SemiAngle())), 3)
            cone_semi[semi] += 1
            apex = adaptor.Cone().Apex()
            apexes.add((semi, round(apex.X(), 3), round(apex.Y(), 3), round(apex.Z(), 3)))
        explorer.Next()
    cone_links: Counter = Counter()
    faces = []
    explorer = TopExp_Explorer(shape, TopAbs_FACE)
    while explorer.More():
        face = TopoDS.Face(explorer.Current())
        edges = []
        edge_explorer = TopExp_Explorer(face, TopAbs_EDGE)
        while edge_explorer.More():
            edges.append(edge_explorer.Current())
            edge_explorer.Next()
        faces.append((face, BRepAdaptor_Surface(face), edges))
        explorer.Next()
    for face, adaptor, edges in faces:
        if adaptor.GetType() != GeomAbs_Cone:
            continue
        semi = round(math.degrees(abs(adaptor.Cone().SemiAngle())), 3)
        neighbours = set()
        for other, other_adaptor, other_edges in faces:
            if other.IsSame(face) or not any(e.IsSame(o) for e in edges for o in other_edges):
                continue
            if other_adaptor.GetType() == GeomAbs_Cylinder:
                neighbours.add(str(round(other_adaptor.Cylinder().Radius(), 4)))
            elif other_adaptor.GetType() == GeomAbs_Plane:
                neighbours.add('plane')
            else:
                neighbours.add(NAMES.get(other_adaptor.GetType(), 'other'))
        cone_links[f'semi={semi} neighbours=' + '+'.join(sorted(neighbours))] += 1
    solids = 0
    solid_explorer = TopExp_Explorer(shape, TopAbs_SOLID)
    while solid_explorer.More():
        solids += 1
        solid_explorer.Next()
    return {
        'file': path.split('/')[-1],
        'solids': solids,
        'volume_mm3': round(props.Mass(), 3),
        'bbox_mm': [round(v, 3) for v in (xmin, ymin, zmin, xmax, ymax, zmax)],
        'face_types': dict(sorted(types.items())),
        'cylinder_radii_mm': {str(k): v for k, v in sorted(radii.items())},
        'cone_semi_angles_deg': {str(k): v for k, v in sorted(cone_semi.items())},
        'cone_adjacency': dict(sorted(cone_links.items())),
        'distinct_cone_apexes_by_semi_angle': {str(k): v for k, v in sorted(Counter(a[0] for a in apexes).items())},
    }


if __name__ == '__main__':
    print(json.dumps([survey(p) for p in sys.argv[1:]], indent=1))
