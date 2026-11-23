"""VELOX-X mass budget: component masses at their stations -> total, CG, inertia about the CG (body axes, x forward).

Areas / volumes of shell, spinner, fins and blades are measured on the llull model (mass_properties on velox_x.lld).
Writes mass_budget.json. Run: python3 mass_budget.py
"""

from __future__ import annotations

import json
import math

L = 800.0
# (name, group, mass g, x mm, kind, size): kind "shell" (thin tube radius r, length l), "rod" (length l along x),
# "disk" (rotor, radius r), "point"
ITEMS = [
    ("Fuselage shell CFRP 0.8 mm (0.1752 m2 measured)", "structure", 217, 451, "shell", (40, 700)),
    ("Nose spinner GFRP 0.6 mm (0.0193 m2 measured)", "structure", 22, 766, "shell", (30, 55)),
    ("Fins x4 CFRP over Rohacell (4 x 10.4 cm3 measured)", "structure", 40, 40, "point", None),
    ("Landing toes x4 CFRP + TPU pads", "structure", 10, 9, "point", None),
    ("Frames x5 + battery rails", "structure", 70, 420, "rod", 240),
    ("Bearing cartridges x2 (nose, tail)", "structure", 50, 410, "rod", 560),
    ("Motor bulkheads x4 + mounts", "structure", 48, 420, "rod", 480),
    ("Battery hatch, latches, fasteners", "structure", 40, 420, "rod", 240),
    ("Structure contingency (10 %)", "structure", 45, 420, "rod", 400),
    ("Motor MN2 (inrunner 36 x 68, 360 g)", "propulsion", 360, 648, "point", None),
    ("Motor MN1", "propulsion", 360, 574, "point", None),
    ("Motor MT1", "propulsion", 360, 194, "point", None),
    ("Motor MT2", "propulsion", 360, 268, "point", None),
    ("Rotor N1 (2 CFRP blades + split hub)", "propulsion", 34, 730, "disk", 114),
    ("Rotor N2", "propulsion", 34, 690, "disk", 114),
    ("Rotor T1", "propulsion", 34, 140, "disk", 114),
    ("Rotor T2", "propulsion", 34, 100, "disk", 114),
    ("Coaxial shafts: 2 x Ti-6Al-4V inner tube 10/7, 2 x CFRP outer tube 16/13", "propulsion", 90, 420, "rod", 560),
    ("Battery 20S3P 1050 mAh LiPo (60 cells + bus bars)", "energy", 1647, 420, "rod", 240),
    ("ESC x4 (150 V FETs, 253 A phase burst)", "avionics", 140, 434, "rod", 330),
    ("FC + RX + telemetry stack", "avionics", 60, 270, "point", None),
    ("GNSS + antennas in GFRP boom cap", "avionics", 10, 10, "point", None),
    ("Elevon servos x4", "avionics", 48, 45, "point", None),
    ("Wiring, bus bars, connectors, BMS taps", "avionics", 122, 420, "rod", 500),
]


def main() -> None:
    total = sum(m for _, _, m, *_ in ITEMS)
    xcg = sum(m * x for _, _, m, x, *_ in ITEMS) / total
    ixx = iyy = 0.0
    for _, _, m, x, kind, size in ITEMS:
        kg = m / 1000
        dx = (x - xcg) / 1000
        if kind == "shell":
            r, l = size[0] / 1000, size[1] / 1000
            ixx += kg * r * r
            iyy += kg * (r * r / 2 + l * l / 12)
        elif kind == "rod":
            l = size / 1000
            ixx += kg * (0.035**2) / 2
            iyy += kg * l * l / 12
        elif kind == "disk":
            r = size / 1000
            ixx += kg * r * r / 3  # two slender blades: m r^2 / 3 about the shaft
            iyy += kg * r * r / 6
        iyy += kg * dx * dx
    groups: dict[str, float] = {}
    for _, group, m, *_ in ITEMS:
        groups[group] = groups.get(group, 0) + m
    out = {
        "total_kg": round(total / 1000, 3),
        "cg_x_mm": round(xcg, 1),
        "inertia_kgm2": {"Ixx_roll": round(ixx, 5), "Iyy_Izz_pitch_yaw": round(iyy, 4)},
        "groups_g": groups,
        "items": [{"item": n, "group": g, "mass_g": m, "x_mm": x} for n, g, m, x, *_ in ITEMS],
    }
    json.dump(out, open("mass_budget.json", "w"), indent=2)
    print(json.dumps({k: v for k, v in out.items() if k != "items"}, indent=2))


if __name__ == "__main__":
    main()
