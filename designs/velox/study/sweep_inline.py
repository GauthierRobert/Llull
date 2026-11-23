"""Design sweep for the inline contra-rotating concept (VELOX-X). Writes sweep_inline_results.csv, prints the top 12."""

from __future__ import annotations

import csv
import itertools
import math
import sys
from dataclasses import replace
from multiprocessing import Pool

from sweep import fuselage_diameter_mm
from velox_inline import InlineAirframe, InlineVehicle, inline_static_tw, inline_top_speed
from velox_model import Motor, Pack, Prop, isa, thermal_check

DIAMETERS_IN = [8.5, 9.0, 9.5, 10.0]
PITCH_RATIOS = [3.6, 4.0, 4.4, 4.8]
KVS = [750.0, 900.0, 1050.0]
MOTOR_MASSES = [0.32, 0.40]
PACKS = [(18, 2, "1550"), (20, 2, "1300"), (18, 3, "1050")]
LIMITS = {"static_tw": 2.0, "dt_motor_k": 75.0, "dt_pack_k": 30.0}


def vehicle_for(d_in, pd, kv, motor_kg, pack_spec) -> InlineVehicle:
    pack = Pack(series=pack_spec[0], parallel=pack_spec[1], cell_key=pack_spec[2])
    df = max(fuselage_diameter_mm(pack), 74.0)
    hub_ratio = (df / 2 - 3) / (d_in * 25.4 / 2)  # blade root just outside the spinner skin
    prop = replace(Prop(), diameter_in=d_in, pitch_ratio=pd, hub_ratio=hub_ratio, chord_75_over_r=0.13)
    prop_kg = 0.034 * (d_in / 9.0) ** 3
    return InlineVehicle(
        prop=prop, motor=replace(Motor(), kv=kv, mass_kg=motor_kg), pack=pack, airframe=replace(InlineAirframe(), fuselage_diameter_mm=df), prop_mass_kg=prop_kg
    )


class _Op:  # adapter so thermal_check (written for the X-quad) reads the worst rotor of the inline point
    def __init__(self, pt, k):
        self.motor_current = pt.motor_current[k]
        self.rpm = pt.rpm[k]
        self.bus_voltage = pt.bus_voltage
        self.shaft_power_per_rotor = pt.shaft_power[k]
        self.pack_current = pt.pack_current


def evaluate(args):
    d_in, pd, kv, motor_kg, pack_spec = args
    veh = vehicle_for(d_in, pd, kv, motor_kg, pack_spec)
    v_top, pt, eps, drag = inline_top_speed(veh)
    k = max(range(4), key=lambda j: pt.motor_current[j])
    thermal = thermal_check(veh, _Op(pt, k))
    _, a, _ = isa(0)
    return {
        "diameter_in": d_in, "pitch_ratio": pd, "kv": kv, "motor_kg": motor_kg, "pack": f"{pack_spec[0]}S{pack_spec[1]}P-{pack_spec[2]}",
        "mass_kg": round(veh.mass_kg, 3), "fuselage_d_mm": round(veh.airframe.fuselage_diameter_mm, 1),
        "v_top_kmh": round(v_top * 3.6, 1), "mach": round(v_top / a, 3), "drag_n": round(drag, 1),
        "rpm": "/".join(str(round(r)) for r in pt.rpm), "thrust_n": "/".join(f"{t:.1f}" for t in pt.thrust),
        "prop_eff": round(pt.propulsive_efficiency, 3), "tip_helical_mach": round(pt.tip_helical_mach, 3),
        "p_elec_kw": round(pt.electrical_power / 1000, 2), "pack_a": round(pt.pack_current, 1), "limited_by": pt.limited_by,
        "static_tw": round(inline_static_tw(veh), 2), "motor_eff": round(thermal["motor_eff"], 3),
        "dt_motor_k": round(thermal["dt_motor_k"], 1), "dt_pack_k": round(thermal["dt_pack_k"], 1),
    }


if __name__ == "__main__":
    grid = list(itertools.product(DIAMETERS_IN, PITCH_RATIOS, KVS, MOTOR_MASSES, PACKS))
    with Pool(4) as pool:
        rows = pool.map(evaluate, grid, chunksize=2)
    with open("sweep_inline_results.csv", "w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
    ok = [r for r in rows if r["static_tw"] >= LIMITS["static_tw"] and r["dt_motor_k"] <= LIMITS["dt_motor_k"] and r["dt_pack_k"] <= LIMITS["dt_pack_k"]]
    ok.sort(key=lambda r: -r["v_top_kmh"])
    for r in ok[:12]:
        print(r)
    print(f"{len(rows)} designs, {len(ok)} feasible ({LIMITS})")
