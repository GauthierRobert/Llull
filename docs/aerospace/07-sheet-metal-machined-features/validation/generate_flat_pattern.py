#!/usr/bin/env python3
"""Analytic flat-pattern reference data for gap FTR (sheet metal), standard library only.

Run:  python3 -I generate_flat_pattern.py  ->  writes data/flat_pattern_cases.csv and data/expected_flat_pattern.json

Conventions (documented in TECHNICAL_SPEC.md section 5.1):
  theta  bend angle = angle the flange is bent THROUGH (0 = flat, 90 = right angle). AC 43.13-1B calls a
         45-degree closed angle a 135-degree bend.
  R      inside bend radius, T thickness, K  ANSI K-factor (neutral-axis offset / T, 0 < K <= 0.5).
         DIN K-factor = 2 x ANSI K (FreeCAD SheetMetal `_convert_to_ansi_kfactor`, [R7]).
  BA  = theta_rad * (R + K*T)                       bend allowance (neutral arc length)        [R7][R3]
  OSSB = tan(theta/2) * (R + T)                     outside setback (mold point to tangent)   [R2] (AC 43.13-1B: SB = K'(BR+MT), K' = tan(theta/2))
  ISSB = tan(theta/2) * R                           inside setback
  BD  = 2*OSSB - BA                                 bend deduction
  Flat length of a single-bend part with outside mold-line legs A, B:  L = A + B - BD
  FAA empirical bend allowance (AC 43.13-1B / EAA [R3]): BA_faa = (0.01743*R + 0.0078*T) * theta_deg
     -> equivalent K = 0.0078/0.01743 = 0.4475 with pi/180 approximated by 0.01743.
  Joggle (two reverse bends of angle phi, inside radius R each, plate offset h between parallel flats):
     mid-surface radius rm = R + T/2 ; inclined straight s = (h - 2*rm*(1-cos phi)) / sin phi  (s >= 0 required)
     horizontal run  Lrun = 2*rm*sin phi + s*cos phi ; developed length  Ldev = 2*BA(phi) + s
     joggle allowance  dL = Ldev - Lrun  (extra blank length versus the straight run).
"""

import csv
import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'data')


def bend_allowance(theta_deg: float, r: float, t: float, k: float) -> float:
    return math.radians(theta_deg) * (r + k * t)


def outside_setback(theta_deg: float, r: float, t: float) -> float:
    return math.tan(math.radians(theta_deg) / 2.0) * (r + t)


def faa_bend_allowance(theta_deg: float, r: float, t: float) -> float:
    return (0.01743 * r + 0.0078 * t) * theta_deg


def joggle(phi_deg: float, r: float, t: float, k: float, h: float) -> dict:
    phi = math.radians(phi_deg)
    rm = r + t / 2.0
    s = (h - 2.0 * rm * (1.0 - math.cos(phi))) / math.sin(phi)
    if s < -1e-12:
        return {'valid': False, 'reason': 'offset too small for two bends of this radius/angle'}
    s = max(s, 0.0)
    run = 2.0 * rm * math.sin(phi) + s * math.cos(phi)
    developed = 2.0 * bend_allowance(phi_deg, r, t, k) + s
    return {'valid': True, 'inclined_straight': s, 'run': run, 'developed': developed, 'allowance': developed - run}


# (id, units, T, R, theta, K, A, B, note) -- A, B = outside mold-line leg lengths (None = no flat length case)
BEND_CASES = [
    ('FP-01', 'mm', 2.0, 1.64, 90.0, 0.38, None, None, 'FreeCAD SheetMetal tools/calc-unfold.py inputs (ML=50) [R7]'),
    ('FP-02', 'mm', 1.6, 4.8, 90.0, 0.44, 40.0, 30.0, 'L-bracket, R=3T; matches generated ftr_bracket_L.step'),
    ('FP-03', 'mm', 1.6, 4.8, 90.0, 0.33, 40.0, 30.0, 'same, K soft-air-bend lower bound (FreeCAD tools/README table)'),
    ('FP-04', 'mm', 1.6, 4.8, 90.0, 0.50, 40.0, 30.0, 'same, K = 0.5 (mid-plane)'),
    ('FP-05', 'mm', 1.0, 1.0, 45.0, 0.40, 25.0, 25.0, 'open 45 deg bend'),
    ('FP-06', 'mm', 1.0, 1.0, 135.0, 0.40, 25.0, 25.0, 'closed 45 deg angle = 135 deg bend'),
    ('FP-07', 'mm', 3.0, 9.0, 120.0, 0.45, 60.0, 50.0, 'thick plate, 120 deg'),
    ('FP-08', 'in', 0.064, 0.25, 90.0, 0.4475, None, None, 'AC 43.13-1B setback example geometry, 90 deg (K-chart value 1.0) [R2]'),
    ('FP-09', 'in', 0.064, 0.25, 45.0, 0.4475, None, None, 'AC 43.13-1B example, 45 deg bend, K-chart 0.41421 -> SB 0.130 in [R2]'),
    ('FP-10', 'in', 0.064, 0.25, 135.0, 0.4475, None, None, 'AC 43.13-1B example, 135 deg bend, K-chart 2.4142 -> SB 0.758 in [R2]'),
    ('FP-11', 'in', 0.040, 0.250, 60.0, 0.4475, None, None, 'EAA worked example BA = 0.2796 in (rounded intermediates) [R3]'),
    ('FP-12', 'mm', 0.8, 0.0, 90.0, 0.33, 20.0, 20.0, 'sharp bend R=0 (must be rejected by min-radius check, still computable)'),
]

JOGGLE_CASES = [
    ('JG-01', 'mm', 1.6, 1.6, 0.44, 20.0, 1.6, 'joggle offset = T'),
    ('JG-02', 'mm', 1.0, 2.0, 0.40, 15.0, 1.2, 'thin sheet, offset 1.2 mm'),
    ('JG-03', 'mm', 2.0, 4.0, 0.44, 30.0, 2.0, 'thick, shallow angle'),
    ('JG-04', 'mm', 1.6, 6.0, 0.44, 45.0, 0.5, 'offset too small for radius -> invalid (failure case)'),
]


def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    rows = []
    expected = {
        'description': 'Analytic sheet-metal flat-pattern references (gap FTR). Values derived from the formulas in the '
        'header of generate_flat_pattern.py; tolerances are for a future llull unfold / flat_pattern command.',
        'generator': 'docs/aerospace/07-sheet-metal-machined-features/validation/generate_flat_pattern.py',
        'tolerance': {'length_abs_mm': 1e-6, 'length_abs_in': 1e-7, 'kernel_unfold_abs_mm': 0.01},
        'bends': [],
        'joggles': [],
        'source_quotes': {
            'FP-09_setback_in': {'value': 0.130, 'source': 'AC 43.13-1B ch.4 K-chart example (search-engine extract, primary PDF blocked) [R2]'},
            'FP-10_setback_in': {'value': 0.758, 'source': 'AC 43.13-1B ch.4 K-chart example (search-engine extract, primary PDF blocked) [R2]'},
            'FP-11_ba_in': {'value': 0.2796, 'source': 'EAA "Making Fittings - Part 2" (search-engine extract) [R3]; exact arithmetic gives 0.28017'},
            'FP-01_flange_length_mm': {'value': 51.755, 'source': 'recomputed from FreeCAD SheetMetal tools/calc-unfold.py [R7]'},
        },
    }
    for cid, units, t, r, theta, k, a, b, note in BEND_CASES:
        ba = bend_allowance(theta, r, t, k)
        ossb = outside_setback(theta, r, t)
        issb = math.tan(math.radians(theta) / 2.0) * r
        bd = 2.0 * ossb - ba
        kchart = math.tan(math.radians(theta) / 2.0)
        faa = faa_bend_allowance(theta, r, t)
        flat = None if a is None else a + b - bd
        row = {
            'id': cid, 'units': units, 'T': t, 'R': r, 'theta_deg': theta, 'K_ansi': k, 'K_din': 2 * k,
            'R_over_T': r / t, 'BA': ba, 'BA_faa_empirical': faa, 'K_chart_tan_half': kchart, 'OSSB': ossb,
            'ISSB': issb, 'BD': bd, 'A_mold': a, 'B_mold': b, 'flat_length': flat, 'note': note,
        }
        rows.append(row)
        expected['bends'].append({k2: (round(v, 9) if isinstance(v, float) else v) for k2, v in row.items()})
    # FreeCAD calc-unfold derived outputs for FP-01 (ML = 50)
    ba01 = bend_allowance(90.0, 1.64, 2.0, 0.38)
    leg = 50.0 - ba01 / 2.0
    expected['freecad_calc_unfold_FP01'] = {
        'bend_allowance_mm': round(ba01, 6), 'leg_length_mm': round(leg, 6),
        'outside_setback_mm': 3.64, 'flange_diff_mm': round(3.64 - ba01 / 2.0, 6), 'flange_length_mm': round(3.64 + leg, 6),
    }
    with open(os.path.join(OUT, 'flat_pattern_cases.csv'), 'w', newline='') as fh:
        writer = csv.DictWriter(fh, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        for row in rows:
            writer.writerow({k2: (f'{v:.9g}' if isinstance(v, float) else ('' if v is None else v)) for k2, v in row.items()})
    for cid, units, t, r, k, phi, h, note in JOGGLE_CASES:
        res = joggle(phi, r, t, k, h)
        entry = {'id': cid, 'units': units, 'T': t, 'R': r, 'K_ansi': k, 'phi_deg': phi, 'offset_h': h, 'note': note}
        entry.update({k2: (round(v, 9) if isinstance(v, float) else v) for k2, v in res.items()})
        expected['joggles'].append(entry)
    with open(os.path.join(OUT, 'expected_flat_pattern.json'), 'w') as fh:
        json.dump(expected, fh, indent=1)
        fh.write('\n')


if __name__ == '__main__':
    main()
