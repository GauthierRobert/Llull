#!/usr/bin/env python3
"""Analytic countersink / counterbore / drill-point geometry references for gap FTR (standard library only).

Run:  python3 -I generate_countersink.py  ->  writes data/expected_countersink.json

Formulas (elementary cone geometry, TECHNICAL_SPEC.md section 5.3):
  countersink depth (surface to cone/hole intersection)  c  = (D - d) / (2 tan(alpha/2))
  depth to the theoretical sharp apex                     c0 = D / (2 tan(alpha/2))
  head-diameter from a depth (inverse, used when the user gives depth)  D = d + 2 c tan(alpha/2)
  material removed by the countersink beyond the hole cylinder  V = pi c/3 (R1^2 + R1 R2 + R2^2) - pi R2^2 c   (R1 = D/2, R2 = d/2)
  conical face area                                       A = pi (R1 + R2) * sqrt((R1 - R2)^2 + c^2)
  knife edge (countersink cuts through the sheet)         c >= T   -> cylindrical land  T - c <= 0
  drill tip height for point angle beta                   h = (d/2) / tan(beta/2)
Inputs are ILLUSTRATIVE (not taken from a fastener standard); alpha = 100 is the aerospace flush-head convention to be
confirmed against the fastener catalogue of gap 08, 82 and 90 are the ASME / ISO screw conventions seen in
FreeCAD Fasteners (82) and FreeCAD PartDesign ISO 10642 (90) [R9][R8].
"""

import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))

CASES = [
    # id, d, D, alpha_deg, T (sheet/plate thickness at the hole)
    ('CS-01', 4.8, 9.0, 100.0, 10.0),
    ('CS-02', 4.8, 9.0, 100.0, 1.6),
    ('CS-03', 4.8, 9.0, 100.0, 1.2),
    ('CS-04', 4.8, 9.0, 90.0, 10.0),
    ('CS-05', 4.8, 9.0, 82.0, 10.0),
    ('CS-06', 3.3, 6.0, 100.0, 1.0),
    ('CS-07', 6.4, 12.0, 100.0, 3.0),
]
DRILL = [('DP-01', 6.0, 118.0), ('DP-02', 6.0, 135.0), ('DP-03', 3.3, 118.0)]


def main() -> None:
    out = {
        'description': 'Analytic countersink / drill-point expectations (mm). Tolerance applies to a future add_hole '
        'command measured with inspect_topology / mass_properties under OCC.',
        'generator': 'docs/aerospace/07-sheet-metal-machined-features/validation/generate_countersink.py',
        'tolerance': {'length_abs_mm': 1e-6, 'volume_rel': 1e-6, 'angle_abs_deg': 1e-6},
        'countersinks': [],
        'drill_points': [],
    }
    for cid, d, big_d, alpha, t in CASES:
        half = math.radians(alpha / 2.0)
        c = (big_d - d) / (2.0 * math.tan(half))
        r1, r2 = big_d / 2.0, d / 2.0
        vol = math.pi * c / 3.0 * (r1 * r1 + r1 * r2 + r2 * r2) - math.pi * r2 * r2 * c
        area = math.pi * (r1 + r2) * math.sqrt((r1 - r2) ** 2 + c * c)
        out['countersinks'].append({
            'id': cid, 'd': d, 'D': big_d, 'alpha_deg': alpha, 'T': t,
            'csk_depth_c': round(c, 9), 'apex_depth_c0': round(big_d / (2.0 * math.tan(half)), 9),
            'cone_semi_angle_deg': alpha / 2.0, 'removed_volume_beyond_hole': round(vol, 9), 'cone_face_area': round(area, 9),
            'cylindrical_land': round(t - c, 9), 'knife_edge': c >= t,
        })
    for did, d, beta in DRILL:
        out['drill_points'].append({'id': did, 'd': d, 'point_angle_deg': beta,
                                    'tip_height': round((d / 2.0) / math.tan(math.radians(beta / 2.0)), 9),
                                    'cone_semi_angle_deg': beta / 2.0})
    os.makedirs(os.path.join(HERE, 'data'), exist_ok=True)
    with open(os.path.join(HERE, 'data', 'expected_countersink.json'), 'w') as fh:
        json.dump(out, fh, indent=1)
        fh.write('\n')


if __name__ == '__main__':
    main()
