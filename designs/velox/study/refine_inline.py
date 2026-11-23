"""Local refinement of VELOX-X around the sweep optimum, with the final airframe (L 760 mm, elevon fins, toe rods)."""

from __future__ import annotations

import itertools
from dataclasses import replace
from multiprocessing import Pool

from sweep_inline import vehicle_for
from velox_inline import inline_static_tw, inline_top_speed

GRID = list(itertools.product([9.0], [4.0, 4.4], [600.0, 675.0, 750.0], [0.36], [(20, 2, "1300")], [0.15, 0.35]))


def run(args):
    d_in, pd, kv, motor_kg, pack, dpd = args
    veh = vehicle_for(d_in, pd, kv, motor_kg, pack)
    veh = replace(veh, airframe=replace(veh.airframe, fuselage_length_mm=760.0), aft_pitch_delta=dpd)
    v, pt, eps, drag = inline_top_speed(veh)
    return (round(v * 3.6, 1), d_in, pd, kv, dpd, round(veh.mass_kg, 3), round(inline_static_tw(veh), 2), round(pt.propulsive_efficiency, 3),
            round(pt.tip_helical_mach, 3), round(pt.electrical_power), round(pt.pack_current), [round(i) for i in pt.motor_current], pt.limited_by)


if __name__ == "__main__":
    with Pool(4) as pool:
        rows = pool.map(run, GRID)
    for r in sorted(rows, reverse=True):
        print(r)
