"""Kv refinement at the final airframe: lower Kv = more torque per phase amp (ESC current), same copper loss (Km fixed)."""

from __future__ import annotations

from dataclasses import replace
from multiprocessing import Pool

from final_point import design_vehicle
from velox_inline import inline_point, inline_static_tw, inline_top_speed


def run(args):
    kv, i_max = args
    base = design_vehicle()
    veh = replace(base, motor=replace(base.motor, kv=kv, i_max=i_max))
    v, pt, _, drag = inline_top_speed(veh)
    st = inline_point(veh, 0.0)
    return (kv, i_max, round(v * 3.6, 1), round(inline_static_tw(veh), 2), round(pt.electrical_power / 1000, 2), round(pt.pack_current),
            [round(i) for i in pt.motor_current], pt.limited_by, round(st.pack_current), [round(r) for r in st.rpm], st.limited_by)


if __name__ == "__main__":
    grid = [(kv, i) for kv in (350.0, 400.0, 450.0, 550.0, 750.0) for i in (220.0, 253.0)]
    with Pool(4) as pool:
        for row in pool.map(run, grid):
            print(row)
