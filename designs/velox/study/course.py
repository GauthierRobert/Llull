"""Speed-course profile for VELOX-X: vertical launch, pitch-over, level run-up, 1 km measured trap.

Prints v(x), the trap-average speed, energy and pack temperature rise for the design pack and an alternative.
"""

from __future__ import annotations

import json
from dataclasses import replace

from final_point import design_vehicle
from velox_inline import inline_excess, inline_point
from velox_model import Pack

RUN_UP_M = 2000.0
TRAP_M = 1000.0


def course(veh, dt: float = 0.05, current_boost: float = 1.0):
    """Integrate the level run from 40 m/s; current_boost scales the ESC phase-current limit (burst mode)."""
    veh = replace(veh, motor=replace(veh.motor, i_max=veh.motor.i_max * current_boost))
    r_cells = veh.pack.series * veh.pack.cell.dcir_ohm / veh.pack.parallel
    cells_kg = veh.pack.series * veh.pack.parallel * veh.pack.cell.mass_kg
    static = inline_point(veh, 0.0)
    # launch: 2.5 s vertical climb at full power to ~40 m, then pitch-over to level at 40 m/s
    t, x, v = 2.5, 0.0, 40.0
    energy = static.electrical_power * 2.5
    heat = static.pack_current**2 * r_cells * 2.5
    trap_t, marks = 0.0, {}
    while x < RUN_UP_M + TRAP_M:
        ex, pt, _, _ = inline_excess(veh, v)
        v += ex / veh.mass_kg * dt
        x += v * dt
        t += dt
        energy += pt.electrical_power * dt
        heat += pt.pack_current**2 * r_cells * dt
        if x > RUN_UP_M:
            trap_t += dt
        for mark in (500, 1000, 1500, 2000, 3000):
            if x >= mark and mark not in marks:
                marks[mark] = round(v * 3.6, 1)
    # recovery: 45 s at ~2.5 kW (deceleration, turn, hover descent)
    energy += 2500 * 45
    return {
        "speed_kmh_at_m": marks,
        "trap_average_kmh": round(TRAP_M / trap_t * 3.6, 1),
        "full_power_time_s": round(t, 1),
        "energy_wh": round(energy / 3600, 1),
        "pack_energy_wh": round(veh.pack.energy_wh, 1),
        "energy_used_pct": round(100 * energy / 3600 / veh.pack.energy_wh, 1),
        "pack_dt_k": round(heat / (cells_kg * 1000), 1),
        "mass_kg": round(veh.mass_kg, 3),
    }


if __name__ == "__main__":
    final = design_vehicle()  # 20S3P-1050, ESC phase limit 253 A (220 A x 1.15 burst)
    nominal = replace(final, motor=replace(final.motor, i_max=220.0))
    out = {
        "20S2P-1300 at 220 A": course(replace(nominal, pack=Pack(series=20, parallel=2, cell_key="1300"))),
        "20S3P-1050 at 220 A": course(nominal),
        "FINAL 20S3P-1050 at 253 A burst": course(final),
    }
    json.dump(out, open("course.json", "w"), indent=2)
    print(json.dumps(out, indent=2))
