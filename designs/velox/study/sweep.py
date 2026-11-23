"""Design sweep for VELOX-Q: prop diameter x pitch ratio x motor Kv x pack. Writes sweep_results.csv, prints the top 15."""

from __future__ import annotations

import csv
import itertools
import math
import sys
from dataclasses import replace
from multiprocessing import Pool

from velox_model import G0, Airframe, Motor, Pack, Prop, Vehicle, operating_point, thermal_check, top_speed

DIAMETERS_IN = [6.5, 7.0, 7.5, 8.0, 8.5]
PITCH_RATIOS = [2.4, 2.8, 3.2, 3.6]
KVS = [550.0, 650.0, 750.0, 850.0, 950.0]
MOTOR_MASSES = [0.205, 0.26, 0.32]
PACKS = [(16, 2, "1300"), (18, 2, "1300"), (18, 2, "1550"), (16, 3, "1050")]
LIMITS = {"static_tw": 2.2, "dt_motor_k": 75.0, "dt_pack_k": 30.0}
BATTERY_BAY_LENGTH_MM = 240.0
WALL_AND_COOLING_MM = 6.0  # shell 1.2 mm + cooling gap each side + cell wrap


def fuselage_diameter_mm(pack: Pack) -> float:
    """Outer fuselage diameter that houses the pack in the battery bay at 1.35 x the bare cell volume."""
    volume = pack.series * pack.parallel * pack.cell.volume_cm3 * 1.35 * 1000  # mm3
    inner = math.sqrt(4 * volume / (math.pi * BATTERY_BAY_LENGTH_MM))
    return inner + WALL_AND_COOLING_MM


def vehicle_for(d_in: float, pd: float, kv: float, motor_kg: float, pack_spec: tuple[int, int, str]) -> Vehicle:
    pack = Pack(series=pack_spec[0], parallel=pack_spec[1], cell_key=pack_spec[2])
    airframe = replace(Airframe(), fuselage_diameter_mm=fuselage_diameter_mm(pack))
    # pylon span keeps the X-hub radius at (D + 12 mm) / sqrt(2) so neighbouring disks clear (README section 4)
    hub_radius = (d_in * 25.4 + 12) / math.sqrt(2)
    airframe = replace(airframe, pylon_span_mm=max(hub_radius - airframe.fuselage_diameter_mm / 2 - airframe.pod_diameter_mm / 2, 30.0))
    prop = replace(Prop(), diameter_in=d_in, pitch_ratio=pd)
    return Vehicle(prop=prop, motor=replace(Motor(), kv=kv, mass_kg=motor_kg), pack=pack, airframe=airframe)


def evaluate(args):
    d_in, pd, kv, motor_kg, pack_spec = args
    veh = vehicle_for(d_in, pd, kv, motor_kg, pack_spec)
    v_top, op, eps = top_speed(veh)
    static = operating_point(veh, 0.0)
    thermal = thermal_check(veh, op)
    return {
        "motor_kg": motor_kg,
        "diameter_in": d_in,
        "pitch_ratio": pd,
        "kv": kv,
        "pack": f"{pack_spec[0]}S{pack_spec[1]}P-{pack_spec[2]}",
        "mass_kg": round(veh.mass_kg, 3),
        "fuselage_d_mm": round(veh.airframe.fuselage_diameter_mm, 1),
        "v_top_kmh": round(v_top * 3.6, 1),
        "rpm": round(op.rpm),
        "prop_eff": round(op.prop.efficiency, 3),
        "tip_helical_mach": round(op.prop.tip_helical_mach, 3),
        "p_elec_kw": round(op.electrical_power / 1000, 2),
        "pack_a": round(op.pack_current, 1),
        "motor_a": round(op.motor_current, 1),
        "limited_by": op.limited_by,
        "static_tw": round(4 * static.thrust_per_rotor / (veh.mass_kg * G0), 2),
        "rotor_tilt_deg": round(math.degrees(eps), 1),
        "motor_eff": round(thermal["motor_eff"], 3),
        "dt_motor_k": round(thermal["dt_motor_k"], 1),
        "dt_pack_k": round(thermal["dt_pack_k"], 1),
    }


if __name__ == "__main__":
    grid = list(itertools.product(DIAMETERS_IN, PITCH_RATIOS, KVS, MOTOR_MASSES, PACKS))
    with Pool(4) as pool:
        rows = pool.map(evaluate, grid, chunksize=4)
    with open("sweep_results.csv", "w", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
    feasible = [r for r in rows if r["static_tw"] >= LIMITS["static_tw"] and r["dt_motor_k"] <= LIMITS["dt_motor_k"] and r["dt_pack_k"] <= LIMITS["dt_pack_k"]]
    feasible.sort(key=lambda r: -r["v_top_kmh"])
    for r in feasible[:15]:
        print(r)
    print(f"{len(rows)} designs, {len(feasible)} feasible ({LIMITS})", file=sys.stderr)
