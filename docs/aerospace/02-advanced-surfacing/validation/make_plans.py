#!/usr/bin/env python3
"""Draft build_project plans for gap SRF. Run after generate_naca.py: python3 -I make_plans.py

plans/baseline_trap_wing_loft_sections.json  runs on TODAY's llull (loft_sections + mass_properties) to measure the
                                             current error of a NACA 0012 trapezoidal wing (24-point ring resampling)
plans/target_*.json                          use the commands PROPOSED in TECHNICAL_SPEC.md (they do not exist yet)
"""

from __future__ import annotations

import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.dont_write_bytecode = True
sys.path.insert(0, HERE)
import generate_naca as naca  # noqa: E402

PLANS = os.path.join(HERE, "plans")


def scaled(loop, chord):
    # drop the duplicated trailing-edge point closing the Selig loop is not needed: open TE has distinct points
    return [[round(x * chord, 6), round(y * chord, 6)] for x, y in loop]


def baseline():
    loop = naca.selig_loop("0012", 61)
    rot = [math.pi / 2, 0, 0]  # section plane XY -> XZ: chord along +X, thickness along +Z, span along +Y
    return [
        {"command": "set_units", "params": {"units": "m"}},
        {
            "command": "loft_sections",
            "params": {
                "sections": [
                    {"center": [0, 0, 0], "rotation": rot, "section": scaled(loop, 2.0)},
                    {"center": [0, 5, 0], "rotation": rot, "section": scaled(loop, 1.0)},
                ],
                "ruled": True,
            },
            "as": "wing",
        },
        {"command": "mass_properties", "params": {"entityId": "$wing"}},
    ]


def target_naca_wing():
    return [
        {"command": "set_units", "params": {"units": "m"}},
        {"command": "airfoil_from_naca", "params": {"designation": "0012", "points": 161, "spacing": "cosine", "trailingEdge": "open"}, "as": "af"},
        {
            "command": "create_wing",
            "params": {
                "sections": [
                    {"airfoilId": "$af", "span": 0.0, "chord": 2.0, "twistDeg": 0.0},
                    {"airfoilId": "$af", "span": 5.0, "chord": 1.0, "twistDeg": 0.0},
                ],
                "segments": [{"sweepDeg": 0.0, "sweepLocation": 0.0, "dihedralDeg": 0.0}],
                "twistLocation": 0.25, "loft": "linear", "mirror": False, "tip": "flat",
            },
            "as": "wing",
        },
        {"command": "mass_properties", "params": {"entityId": "$wing"}},
        {"command": "wing_properties", "params": {"id": "$wing"}},
    ]


def target_tr1208():
    return [
        {"command": "set_units", "params": {"units": "in"}},
        {"command": "airfoil_from_naca", "params": {"designation": "0012", "points": 161}, "as": "af"},
        {
            "command": "create_wing",
            "params": {
                # planform resolves chords (TECHNICAL_SPEC 4.2: any 3 independent planform values); sections give airfoil + twist only
                "planform": {"semiSpan": 63.63, "rootChord": 21.941, "taper": 0.45, "sweepDeg": 45.0, "sweepLocation": 0.25, "dihedralDeg": 0.0},
                "sections": [{"airfoilId": "$af", "span": 0.0, "twistDeg": 0.0}, {"airfoilId": "$af", "span": 63.63, "twistDeg": 0.0}],
                "twistLocation": 0.25, "loft": "linear", "mirror": True, "tip": "flat",
            },
            "as": "wing",
        },
        {"command": "wing_properties", "params": {"id": "$wing"}},
    ]


def target_surface_analysis():
    return [
        {"command": "add_torus", "params": {"ringRadius": 5, "tubeRadius": 2}, "as": "t"},
        {"command": "analyze_surface_curvature", "params": {"id": "$t", "faceIndex": 0, "samples": [[0.4, 0.0], [0.4, 1.5707963], [0.4, 3.1415927]]}},
        {"command": "analyze_draft", "params": {"id": "$t", "pullDirection": [0, 0, 1], "minDraftDeg": 1.0}},
    ]


def target_conic_fuselage():
    # BodyStation / BodySection shapes of TECHNICAL_SPEC 3: { fs, section: { type: 'conic', upper, lower, wlMaxBreadth, halfBreadth } },
    # apexes as { type: 'point', wl }. rho = sqrt(2) - 1 makes each conic half an exact semicircle (VC-SRF-14).
    rho = round(math.sqrt(2) - 1, 8)
    stations = [{"fs": 0.0, "section": {"type": "point", "wl": 0.0}}]
    for k in range(1, 20):
        x = k / 20
        r = round(0.5 * (4 * x * (1 - x)) ** 0.75, 6)
        stations.append({"fs": round(10 * x, 4), "section": {"type": "conic", "upper": {"wlExtreme": r, "rho": rho},
                         "lower": {"wlExtreme": -r, "rho": rho}, "wlMaxBreadth": 0.0, "halfBreadth": r}})
    stations.append({"fs": 10.0, "section": {"type": "point", "wl": 0.0}})
    return [
        {"command": "set_units", "params": {"units": "m"}},
        {"command": "set_aircraft_frame", "params": {"datum": [0, 0, 0], "fsAxis": [1, 0, 0], "blAxis": [0, 1, 0], "wlAxis": [0, 0, 1], "units": "m"}},
        {"command": "loft_fuselage", "params": {"stations": stations, "continuity": "G2"}, "as": "fus"},
        {"command": "mass_properties", "params": {"entityId": "$fus"}},
    ]


def main() -> int:
    os.makedirs(PLANS, exist_ok=True)
    plans = {
        "baseline_trap_wing_loft_sections.json": baseline(),
        "target_naca0012_trap_wing.json": target_naca_wing(),
        "target_tr1208_wing.json": target_tr1208(),
        "target_torus_surface_analysis.json": target_surface_analysis(),
        "target_sears_haack_conic_fuselage.json": target_conic_fuselage(),
    }
    for name, plan in plans.items():
        with open(os.path.join(PLANS, name), "w", encoding="utf-8") as fh:
            json.dump(plan, fh, indent=1)
        print("wrote", name)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
