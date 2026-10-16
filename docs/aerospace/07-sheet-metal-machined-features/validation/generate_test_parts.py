#!/usr/bin/env python3
"""Generate the gap-FTR synthetic test parts (exact B-rep STEP) and their analytic expectations.

Requires OCP (pip install cadquery-ocp). Run:  python3 -I generate_test_parts.py
Writes (all CC0, authored for llull):
  data/ftr_bracket_L.step       90-degree L bracket  (T=1.6, R=4.8, A=40, B=30 outside mold lines, W=50 mm)
  data/ftr_joggle_strip.step    joggled strip        (T=1.6, R=1.6, phi=20 deg, h=1.6, W=30 mm)
  data/ftr_machined_plate.step  100 x 60 x 10 plate: 4 x 100-deg countersunk through holes, 2 counterbored holes,
                                1 rounded-corner pocket, 1 blind drilled hole with 118-deg point
  data/expected_test_parts.json analytic volume / feature expectations + OCCT-measured volume (cross-check)

Every analytic value is derived from elementary geometry (formulas inline). Hole/countersink sizes are ILLUSTRATIVE
parameters chosen for geometry checks, NOT values from a fastener standard.
"""

import json
import math
import os

from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeEdge, BRepBuilderAPI_MakeFace, BRepBuilderAPI_MakeWire
from OCP.BRepGProp import BRepGProp
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCone, BRepPrimAPI_MakeCylinder, BRepPrimAPI_MakePrism
from OCP.GC import GC_MakeArcOfCircle, GC_MakeSegment
from OCP.GProp import GProp_GProps
from OCP.IFSelect import IFSelect_RetDone
from OCP.Interface import Interface_Static
from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer
from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt, gp_Vec

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'data')


def volume(shape) -> float:
    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape, props)
    return props.Mass()


def write_step(shape, name: str) -> None:
    writer = STEPControl_Writer()
    Interface_Static.SetCVal_s('write.step.schema', 'AP214IS')
    Interface_Static.SetCVal_s('write.step.unit', 'MM')
    writer.Transfer(shape, STEPControl_AsIs)
    assert writer.Write(os.path.join(OUT, name)) == IFSelect_RetDone


# ---------- sheet-metal strips: mid-surface path in XZ, offset +-T/2, prism along +Y ----------

def p3(x: float, z: float) -> gp_Pnt:
    return gp_Pnt(x, 0.0, z)


def line_seg(a, b):
    return ('line', [a, b])


def arc_seg(center, radius, a0, a1):
    am = 0.5 * (a0 + a1)
    pts = [(center[0] + radius * math.cos(a), center[1] + radius * math.sin(a)) for a in (a0, am, a1)]
    return ('arc', pts, center, a1 > a0)


def left_normal(seg, i):
    if seg[0] == 'line':
        (x0, z0), (x1, z1) = seg[1]
        dx, dz = x1 - x0, z1 - z0
        n = math.hypot(dx, dz)
        return (-dz / n, dx / n)
    cx, cz = seg[2]
    x, z = seg[1][i]
    rx, rz = x - cx, z - cz
    n = math.hypot(rx, rz)
    ccw = seg[3]
    return (-rx / n, -rz / n) if ccw else (rx / n, rz / n)


def offset_points(seg, d):
    return [(x + d * left_normal(seg, i)[0], z + d * left_normal(seg, i)[1]) for i, (x, z) in enumerate(seg[1])]


def edge_through(points):
    if len(points) == 2:
        return BRepBuilderAPI_MakeEdge(GC_MakeSegment(p3(*points[0]), p3(*points[1])).Value()).Edge()
    return BRepBuilderAPI_MakeEdge(GC_MakeArcOfCircle(p3(*points[0]), p3(*points[1]), p3(*points[2])).Value()).Edge()


def strip_solid(path, t: float, w: float):
    upper = [offset_points(s, t / 2.0) for s in path]
    lower = [list(reversed(offset_points(s, -t / 2.0))) for s in reversed(path)]
    wire = BRepBuilderAPI_MakeWire()
    for pts in upper:
        wire.Add(edge_through(pts))
    wire.Add(edge_through([upper[-1][-1], lower[0][0]]))
    for pts in lower:
        wire.Add(edge_through(pts))
    wire.Add(edge_through([lower[-1][-1], upper[0][0]]))
    face = BRepBuilderAPI_MakeFace(wire.Wire()).Face()
    return BRepPrimAPI_MakePrism(face, gp_Vec(0.0, w, 0.0)).Shape()


def bracket():
    t, r, a, b, w = 1.6, 4.8, 40.0, 30.0, 50.0
    rm = r + t / 2.0
    cx, cz = a - (r + t), r + t
    path = [
        line_seg((0.0, t / 2.0), (cx, t / 2.0)),
        arc_seg((cx, cz), rm, -math.pi / 2.0, 0.0),
        line_seg((a - t / 2.0, cz), (a - t / 2.0, b)),
    ]
    shape = strip_solid(path, t, w)
    ossb = r + t
    mid_length = (a - ossb) + (b - ossb) + (math.pi / 2.0) * rm
    return shape, {
        'params': {'T': t, 'R': r, 'theta_deg': 90.0, 'A_mold': a, 'B_mold': b, 'W': w},
        'analytic_volume_mm3': w * t * mid_length,
        'volume_formula': 'W*T*(A+B-2*(R+T)+theta*(R+T/2))  (= W*T*flat length at K=0.5, case FP-04)',
        'expected_bend_count': 1,
        'expected_bend_inside_radius_mm': r,
        'expected_flat_length_by_K': {
            str(k): (a + b - (2.0 * ossb - (math.pi / 2.0) * (r + k * t))) for k in (0.33, 0.44, 0.5)
        },
        'expected_flat_extents_mm_K044': [a + b - (2.0 * ossb - (math.pi / 2.0) * (r + 0.44 * t)), w],
    }


def joggle_strip():
    t, r, phi_deg, h, w, l1, l2 = 1.6, 1.6, 20.0, 1.6, 30.0, 20.0, 20.0
    phi = math.radians(phi_deg)
    rm = r + t / 2.0
    s = (h - 2.0 * rm * (1.0 - math.cos(phi))) / math.sin(phi)
    c1 = (l1, rm)
    e1 = (l1 + rm * math.sin(phi), rm - rm * math.cos(phi))
    e2 = (e1[0] + s * math.cos(phi), e1[1] + s * math.sin(phi))
    c2 = (e2[0] + rm * math.sin(phi), e2[1] - rm * math.cos(phi))
    end2 = (c2[0], c2[1] + rm)
    path = [
        line_seg((0.0, 0.0), (l1, 0.0)),
        arc_seg(c1, rm, -math.pi / 2.0, -math.pi / 2.0 + phi),
        line_seg(e1, e2),
        arc_seg(c2, rm, math.pi / 2.0 + phi, math.pi / 2.0),
        line_seg(end2, (end2[0] + l2, end2[1])),
    ]
    shape = strip_solid(path, t, w)
    run = 2.0 * rm * math.sin(phi) + s * math.cos(phi)
    mid_length = l1 + l2 + s + 2.0 * phi * rm
    return shape, {
        'params': {'T': t, 'R': r, 'phi_deg': phi_deg, 'offset_h': h, 'W': w, 'L1': l1, 'L2': l2},
        'analytic_volume_mm3': w * t * mid_length,
        'volume_formula': 'W*T*(L1+L2+s+2*phi*(R+T/2))',
        'expected_mid_offset_mm': round(end2[1], 9),
        'expected_overall_run_mm': l1 + l2 + run,
        'expected_bend_count': 2,
        'expected_flat_length_K044_mm': l1 + l2 + s + 2.0 * phi * (r + 0.44 * t),
        'note': 'Joggle case JG-01 of expected_flat_pattern.json embedded between two 20 mm flats.',
    }


# ---------- machined plate ----------

def cylinder(x, y, z0, radius, height):
    return BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(x, y, z0), gp_Dir(0, 0, 1)), radius, height).Shape()


def machined_plate():
    lx, ly, lz = 100.0, 60.0, 10.0
    shape = BRepPrimAPI_MakeBox(lx, ly, lz).Shape()
    expected_removed = 0.0
    features = []
    # 4 x countersunk through holes: d=4.8, D=9.0 at the top face, included angle 100 deg (illustrative sizes)
    d, dk, alpha = 4.8, 9.0, 100.0
    c = (dk - d) / (2.0 * math.tan(math.radians(alpha / 2.0)))
    r1, r2 = dk / 2.0, d / 2.0
    for x, y in ((10.0, 10.0), (90.0, 10.0), (10.0, 50.0), (90.0, 50.0)):
        shape = BRepAlgoAPI_Cut(shape, cylinder(x, y, -1.0, r2, lz + 2.0)).Shape()
        cone = BRepPrimAPI_MakeCone(gp_Ax2(gp_Pnt(x, y, lz - c), gp_Dir(0, 0, 1)), r2, r1, c).Shape()
        shape = BRepAlgoAPI_Cut(shape, cone).Shape()
        expected_removed += math.pi * r2 * r2 * lz + math.pi * c / 3.0 * (r1 * r1 + r1 * r2 + r2 * r2) - math.pi * r2 * r2 * c
        features.append({'type': 'hole', 'subtype': 'countersink', 'axis_point': [x, y, lz], 'axis': [0, 0, -1],
                         'diameter': d, 'csk_diameter': dk, 'csk_angle_deg': alpha, 'csk_depth': c, 'through': True})
    # 2 x counterbored through holes: d=5.5, cbore 10.0 x 5.5 deep (illustrative)
    dcb, dc, hc = 5.5, 10.0, 5.5
    for x, y in ((30.0, 30.0), (70.0, 30.0)):
        shape = BRepAlgoAPI_Cut(shape, cylinder(x, y, -1.0, dcb / 2.0, lz + 2.0)).Shape()
        shape = BRepAlgoAPI_Cut(shape, cylinder(x, y, lz - hc, dc / 2.0, hc + 1.0)).Shape()
        expected_removed += math.pi * (dcb / 2.0) ** 2 * (lz - hc) + math.pi * (dc / 2.0) ** 2 * hc
        features.append({'type': 'hole', 'subtype': 'counterbore', 'axis_point': [x, y, lz], 'axis': [0, 0, -1],
                         'diameter': dcb, 'cbore_diameter': dc, 'cbore_depth': hc, 'through': True})
    # 1 x pocket 40 x 12, depth 4, vertical corner radius 3, flat floor, centred at (50, 45) -> x 30..70, y 39..51
    pw, pl, pd, rc = 40.0, 12.0, 4.0, 3.0
    x0, y0 = 30.0, 39.0
    pocket = BRepPrimAPI_MakeBox(gp_Pnt(x0 + rc, y0, lz - pd), pw - 2 * rc, pl, pd + 1.0).Shape()
    pocket2 = BRepPrimAPI_MakeBox(gp_Pnt(x0, y0 + rc, lz - pd), pw, pl - 2 * rc, pd + 1.0).Shape()
    shape = BRepAlgoAPI_Cut(shape, pocket).Shape()
    shape = BRepAlgoAPI_Cut(shape, pocket2).Shape()
    for cx, cy in ((x0 + rc, y0 + rc), (x0 + pw - rc, y0 + rc), (x0 + rc, y0 + pl - rc), (x0 + pw - rc, y0 + pl - rc)):
        shape = BRepAlgoAPI_Cut(shape, cylinder(cx, cy, lz - pd, rc, pd + 1.0)).Shape()
    expected_removed += (pw * pl - (4.0 - math.pi) * rc * rc) * pd
    features.append({'type': 'pocket', 'floor_z': lz - pd, 'depth': pd, 'outline': 'rounded_rectangle', 'size': [pw, pl],
                     'corner_radius': rc, 'floor_fillet': 0.0, 'max_tool_diameter': 2 * rc})
    # 1 x blind drilled hole d=6, cylindrical depth 6, 118-deg point, at (50, 15) from the top
    dd, depth, point = 6.0, 6.0, 118.0
    tip = (dd / 2.0) / math.tan(math.radians(point / 2.0))
    shape = BRepAlgoAPI_Cut(shape, cylinder(50.0, 15.0, lz - depth, dd / 2.0, depth + 1.0)).Shape()
    tip_cone = BRepPrimAPI_MakeCone(gp_Ax2(gp_Pnt(50.0, 15.0, lz - depth), gp_Dir(0, 0, -1)), dd / 2.0, 0.0, tip).Shape()
    shape = BRepAlgoAPI_Cut(shape, tip_cone).Shape()
    expected_removed += math.pi * (dd / 2.0) ** 2 * depth + math.pi * (dd / 2.0) ** 2 * tip / 3.0
    features.append({'type': 'hole', 'subtype': 'simple', 'axis_point': [50.0, 15.0, lz], 'axis': [0, 0, -1],
                     'diameter': dd, 'depth': depth, 'through': False, 'drill_point_angle_deg': point, 'tip_height': tip})
    return shape, {
        'params': {'block': [lx, ly, lz]},
        'analytic_volume_mm3': lx * ly * lz - expected_removed,
        'volume_formula': 'block - sum(hole cylinders + countersink frustum excess + counterbores + pocket prism + drill tip cone)',
        'countersink_depth_formula': 'c = (D - d) / (2 tan(alpha/2))',
        'expected_features': features,
        'expected_counts': {'holes': 7, 'countersink': 4, 'counterbore': 2, 'blind': 1, 'pockets': 1},
    }


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    result = {'generator': 'docs/aerospace/07-sheet-metal-machined-features/validation/generate_test_parts.py',
              'units': 'mm', 'licence': 'CC0-1.0 (authored for llull)', 'tolerance': {'volume_rel': 1e-6}, 'parts': {}}
    for name, builder in (('ftr_bracket_L.step', bracket), ('ftr_joggle_strip.step', joggle_strip), ('ftr_machined_plate.step', machined_plate)):
        shape, info = builder()
        write_step(shape, name)
        info['occt_volume_mm3'] = volume(shape)
        info['volume_rel_error'] = abs(info['occt_volume_mm3'] - info['analytic_volume_mm3']) / info['analytic_volume_mm3']
        result['parts'][name] = info
    with open(os.path.join(OUT, 'expected_test_parts.json'), 'w') as fh:
        json.dump(result, fh, indent=1, default=float)
        fh.write('\n')
    for name, info in result['parts'].items():
        print(name, round(info['analytic_volume_mm3'], 4), round(info['occt_volume_mm3'], 4), f"{info['volume_rel_error']:.2e}")


if __name__ == '__main__':
    main()
