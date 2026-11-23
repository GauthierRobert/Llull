"""Final VELOX-X design point: top speed, drag and power breakdown, launch, motor thermal, rotor tables (run profile: course.py).

Writes final_point.json (README numbers) and rotor_tables.json (Ct, Cp vs J for llull add_rotor). Run: python3 final_point.py
"""

from __future__ import annotations

import json
import math
from dataclasses import replace

from sweep import vehicle_for as xquad_for
from sweep_inline import vehicle_for
from velox_inline import fin_lift, inline_cda, inline_point, inline_static_tw, inline_top_speed
from velox_model import isa, prop_performance, thermal_check, top_speed

DESIGN = dict(d_in=9.0, pd=4.4, kv=750.0, motor_kg=0.36, pack=(20, 3, "1050"), dpd=0.35, esc_phase_limit_a=253.0)


def design_vehicle():
    veh = vehicle_for(DESIGN["d_in"], DESIGN["pd"], DESIGN["kv"], DESIGN["motor_kg"], DESIGN["pack"])
    return replace(
        veh,
        airframe=replace(veh.airframe, fuselage_length_mm=800.0),
        aft_pitch_delta=DESIGN["dpd"],
        motor=replace(veh.motor, i_max=DESIGN["esc_phase_limit_a"]),
    )


def installed_tables(veh, rpms: list[float]) -> dict[str, list[list[float]]]:
    """Ct, Cp vs freestream J = V / (n D) of each rotor installed in its pair, at its design rpm.

    Fore rotors: freestream (tail pair: minus the BLI deficit plus the mixed nose slipstream). Aft rotors: plus the fore
    rotor's slipstream and counter-swirl at that speed. These are what llull add_rotor needs: it feeds J from the body state.
    """
    rho, a, mu = isa(0)
    fore = veh.prop
    aft = replace(veh.prop, pitch_ratio=veh.prop.pitch_ratio + veh.aft_pitch_delta)
    d = fore.diameter_in * 0.0254
    names = ["N1", "N2", "T1", "T2"]
    tables = {k: [] for k in names}
    for j in [0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.4, 4.8, 5.2, 5.6, 6.0]:
        v = j * rpms[0] / 60 * d
        vi_nose = 0.0
        for pair, v_in in ((0, None), (2, None)):
            if pair == 0:
                v_in = v
            else:
                v_in = v * (1 - veh.airframe.bli_deficit) + vi_nose
            f = prop_performance(fore, v_in, rpms[pair], rho, a, mu)
            vi1, vt1 = f.induced_axial[0], f.induced_swirl[0]
            g = prop_performance(aft, v_in, rpms[pair + 1], rho, a, mu, (veh.slipstream_factor - 1) * vi1, 2 * vt1 * veh.swirl_recovery)
            if pair == 0:
                vi_nose = float(vi1.mean())
            for k, res in ((pair, f), (pair + 1, g)):
                n = rpms[k] / 60
                jk = v / (n * d)
                tables[names[k]].append([round(jk, 4), round(res.thrust / (rho * n**2 * d**4), 5), round(max(res.power, 1e-6) / (rho * n**3 * d**5), 5)])
    return tables


def main():
    veh = design_vehicle()
    rho, a, mu = isa(0)
    v, pt, eps, drag = inline_top_speed(veh)
    lift, induced = fin_lift(veh, v)
    cda = inline_cda(veh.airframe, v, rho, a, mu)
    static = inline_point(veh, 0.0)

    class _Op:
        pass

    worst = max(range(4), key=lambda k: pt.motor_current[k])
    op = _Op()
    op.motor_current, op.rpm, op.bus_voltage = pt.motor_current[worst], pt.rpm[worst], pt.bus_voltage
    op.shaft_power_per_rotor, op.pack_current = pt.shaft_power[worst], pt.pack_current
    thermal = thermal_check(veh, op, full_power_s=21.0)  # course.py: 20-21 s at full power

    # same-power X-quad baseline (best feasible point of sweep.py) for the comparison table
    xq = xquad_for(8.0, 3.2, 950.0, 0.32, (18, 2, "1550"))
    v_xq, op_xq, _ = top_speed(xq)

    result = {
        "design": DESIGN,
        "mass_kg": round(veh.mass_kg, 3),
        "fuselage_diameter_mm": round(veh.airframe.fuselage_diameter_mm, 1),
        "top_speed_kmh": round(v * 3.6, 1),
        "top_speed_mps": round(v, 1),
        "mach": round(v / a, 3),
        "drag_n": round(drag, 2),
        "cda_cm2": {k: round(x * 1e4, 2) for k, x in cda.items()},
        "fin_lift_n": round(lift, 1),
        "fin_induced_drag_n": round(induced, 2),
        "thrust_tilt_deg": round(math.degrees(eps), 2),
        "rotors": {
            name: {"rpm": round(pt.rpm[k]), "thrust_n": round(pt.thrust[k], 2), "shaft_w": round(pt.shaft_power[k]), "motor_a": round(pt.motor_current[k], 1)}
            for k, name in enumerate(["N1", "N2", "T1", "T2"])
        },
        "propulsive_efficiency": round(pt.propulsive_efficiency, 3),
        "tip_helical_mach": round(pt.tip_helical_mach, 3),
        "bus_voltage_v": round(pt.bus_voltage, 1),
        "pack_current_a": round(pt.pack_current, 1),
        "electrical_power_kw": round(pt.electrical_power / 1000, 2),
        "limited_by": pt.limited_by,
        "static": {"thrust_to_weight": round(inline_static_tw(veh), 2), "thrust_n": [round(t, 1) for t in static.thrust], "rpm": [round(r) for r in static.rpm],
                   "pack_current_a": round(static.pack_current, 1), "power_kw": round(static.electrical_power / 1000, 2)},
        "pack_energy_wh": round(veh.pack.energy_wh, 1),
        "motor": {k: round(x, 3) for k, x in thermal.items()},
        "baseline_xquad_same_class": {"top_speed_kmh": round(v_xq * 3.6, 1), "mass_kg": round(xq.mass_kg, 3), "power_kw": round(op_xq.electrical_power / 1000, 2)},
    }
    tables = {"rpm": dict(zip(["N1", "N2", "T1", "T2"], pt.rpm)), "installed": installed_tables(veh, pt.rpm)}
    with open("final_point.json", "w") as handle:
        json.dump(result, handle, indent=2)
    with open("rotor_tables.json", "w") as handle:
        json.dump(tables, handle, indent=2)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
