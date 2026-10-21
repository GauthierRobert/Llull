#!/usr/bin/env python3
"""HALO first-order sizing: propulsion, control authority, crosswind, endurance.

Mass, CG and inertia come from llull (`mass_properties` of every part instance of the document); the aerodynamic
reference numbers (static margin, CD0) come from llull's VLM and drag build-up runs. Everything else is textbook
first-order theory, with every assumption named in ASSUMPTIONS. Run:

    python3 designs/halo/analysis/halo_sizing.py designs/halo/halo_v3.llull.json designs/halo/analysis/geometry_v3.json [--json out.json] [--extra-mass-kg 0.06]
"""
import json
import math
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
LLULL = ["node", str(REPO / "server/bin/llull.cjs"), "--kernel", "manifold"]
RHO = 1.225  # ISA sea level, kg/m^3 (llull standard_atmosphere)
G = 9.80665

ASSUMPTIONS = {
    "figure_of_merit": 0.60,  # ducted coaxial pair, hover (open small props ~0.5-0.6)
    "motor_esc_efficiency": 0.85,
    "blade_loading_ct_over_sigma": 0.10,  # moderate, well below stall (~0.15)
    "max_thrust_to_weight": 2.0,  # climb + control headroom
    "vane_cl_max": 1.0,  # NACA 0010 vane in the exit jet, before stall
    "vane_cl_alpha_per_rad": 4.5,  # low-AR vane in a jet (2*pi * 0.72)
    "crosswind_moment_coefficient": 0.5,  # M = k * mdot * V_wind * duct_chord (ducted-fan lip moment, typical 0.3-0.7)
    "control_accel_rad_s2": 4.0,  # angular acceleration kept in reserve for stabilisation on top of trim
    "battery_usable_fraction": 0.85,
    "avionics_power_w": 6.0,
    "cruise_propulsive_efficiency": 0.60,  # ducted rotor at cruise J, incl. motor/ESC
    "motor_peak_torque_density_nm_per_kg": 8.0,  # frameless high-pole pancake BLDC, peak (catalogue range 5-10)
}


def llull(*args: str) -> dict:
    out = subprocess.run([*LLULL, *args, "--json"], capture_output=True, text=True, cwd=REPO, check=False).stdout
    return json.loads(out)


def assembly(doc: str) -> dict:
    scene = llull("describe_scene", "--doc", doc)
    parts = [e for e in scene["data"]["entities"] if e["kind"] == "instance"]
    mass = 0.0
    first = [0.0, 0.0, 0.0]
    second = [[0.0] * 3 for _ in range(3)]  # inertia about the document origin, g*mm^2
    rows = []
    for part in parts:
        d = llull("mass_properties", f"entityId={part['id']}", "--doc", doc)["data"]
        m = d["massG"]
        mass += m
        for k in range(3):
            first[k] += m * d["centroid"][k]
        io = d["inertia"]["atOrigin"]
        for i in range(3):
            for j in range(3):
                second[i][j] += io[i][j]
        rows.append((part["id"], m, d["centroid"]))
    cg = [f / mass for f in first]
    # parallel axis: I_cg = I_o - m (|c|^2 delta - c c^T)
    c2 = sum(c * c for c in cg)
    icg = [[second[i][j] - mass * ((c2 if i == j else 0.0) - cg[i] * cg[j]) for j in range(3)] for i in range(3)]
    return {"massKg": mass / 1000, "cgMm": cg, "inertiaKgM2": [[v * 1e-9 for v in row] for row in icg], "parts": len(rows)}


def size(geo: dict, asm: dict) -> dict:
    a = ASSUMPTIONS
    m = asm["massKg"]
    weight = m * G
    r_tip = geo["loopTipR"] / 1000
    r_hub = geo["bellR"] / 1000
    disc = math.pi * (r_tip**2 - r_hub**2)
    # --- hover, ideal ducted fan with exit expansion ratio sigma = A_exit / A_disc: P = T^1.5 / sqrt(4 rho A sigma)
    sigma_e = geo["sigma"]
    v_exit = math.sqrt(weight / (RHO * disc * sigma_e))
    p_ideal = weight**1.5 / math.sqrt(4 * RHO * disc * sigma_e)
    rotor_share = 1 / (2 * sigma_e)  # ideal duct: rotor thrust fraction, the lip carries the rest
    p_shaft = p_ideal / a["figure_of_merit"]
    p_elec = p_shaft / a["motor_esc_efficiency"] + a["avionics_power_w"]
    mdot = RHO * disc * v_exit
    # --- rotors: each carries share/2 of the weight; tip speed from blade loading
    rotors = {}
    for name, loops in (("upper", geo["loopsUpper"]), ("lower", geo["loopsLower"])):
        sigma = 2 * loops * geo["loopChord"] / 1000 / (math.pi * r_tip)  # two blade arms per loop
        thrust = weight * rotor_share / 2
        ct = a["blade_loading_ct_over_sigma"] * sigma
        v_tip = math.sqrt(thrust / (RHO * disc * ct))
        omega = v_tip / r_tip
        q_hover = (p_shaft / 2) / omega
        # max thrust T_max = k T: v_tip ~ sqrt(k), shaft power ~ k^1.5 -> torque ~ k
        k = a["max_thrust_to_weight"]
        q_peak = q_hover * k
        rpm_peak = omega * math.sqrt(k) * 60 / (2 * math.pi)
        rotors[name] = {
            "solidity": sigma,
            "thrustHoverN": thrust,
            "tipSpeedHoverMs": v_tip,
            "rpmHover": omega * 60 / (2 * math.pi),
            "inflowAngleTipDeg": math.degrees(math.atan2(v_exit * sigma_e, v_tip)),  # rotor-plane axial velocity = sigma * v_exit
            "torqueHoverNm": q_hover,
            "torquePeakNm": q_peak,
            "rpmPeak": rpm_peak,
            "motorMassRequiredG": 1000 * q_peak / a["motor_peak_torque_density_nm_per_kg"],
        }
    # --- electrical: 4S2P Molicel P50B (5.0 Ah, 3.6 V nominal, 60 A continuous per cell)
    pack_v = 4 * 3.6
    pack_wh = 8 * 5.0 * 3.6
    i_hover = p_elec / pack_v
    p_peak = p_elec * a["max_thrust_to_weight"] ** 1.5
    i_peak = p_peak / pack_v
    # --- control vanes in the exit jet (all-moving), pitch/roll: two vanes per axis
    q_jet = 0.5 * RHO * v_exit**2
    vane_area = geo["vaneChord"] / 1000 * geo["vaneSpan"] / 1000
    f_vane = q_jet * vane_area * geo.get("vaneClMax", a["vane_cl_max"])
    arm = (asm["cgMm"][2] - geo["vaneCpZ"]) / 1000
    m_control = geo["vaneAxisFactor"] * f_vane * arm  # sum of |sin| of the vane angles about the pitch axis
    iyy = asm["inertiaKgM2"][1][1]
    # crosswind lip moment that the vanes must trim, plus a stabilisation reserve
    duct_chord = geo["ringChord"] / 1000

    def wind_limit() -> float:
        reserve = iyy * a["control_accel_rad_s2"]
        spare = m_control - reserve
        return max(0.0, spare / (a["crosswind_moment_coefficient"] * mdot * duct_chord))

    deflection_per_n = 1 / (q_jet * vane_area * a["vane_cl_alpha_per_rad"])
    # --- cruise (ring wing, llull CD0 and VLM span efficiency)
    s_ref = 2 * geo["ringLe"] / 1000 * duct_chord
    span = 2 * geo["ringLe"] / 1000
    ar = span**2 / s_ref
    cruise = {}
    for v in (20, 25, 35, 50):
        q = 0.5 * RHO * v * v
        cl = weight / (q * s_ref)
        cdi = cl * cl / (math.pi * ar * geo["spanEfficiency"])
        drag = q * s_ref * (geo["cd0"] + cdi)
        p = drag * v / a["cruise_propulsive_efficiency"] + a["avionics_power_w"]
        cruise[str(v)] = {"cl": cl, "dragN": drag, "LoverD": weight / drag, "powerW": p, "rangeKm": pack_wh * a["battery_usable_fraction"] / p * v * 3.6}
    usable = pack_wh * a["battery_usable_fraction"]
    return {
        "assumptions": a,
        "massKg": m,
        "cgMm": asm["cgMm"],
        "inertiaKgM2": asm["inertiaKgM2"],
        "hover": {
            "discAreaM2": disc,
            "expansionRatio": sigma_e,
            "rotorThrustShare": rotor_share,
            "exitVelocityMs": v_exit,
            "massFlowKgS": mdot,
            "idealPowerW": p_ideal,
            "shaftPowerW": p_shaft,
            "electricalPowerW": p_elec,
            "enduranceMin": usable / p_elec * 60,
            "packCurrentA": i_hover,
            "peakPackCurrentA": i_peak,
            "peakCurrentPerCellA": i_peak / 2,
        },
        "rotors": rotors,
        "control": {
            "jetDynamicPressurePa": q_jet,
            "vaneForceMaxN": f_vane,
            "armFromCgM": arm,
            "pitchMomentMaxNm": m_control,
            "pitchInertiaKgM2": iyy,
            "maxAngularAccelNoWindRadS2": m_control / iyy,
            "crosswindLimitMs": wind_limit(),
            "vaneDeflectionDegPerN": math.degrees(deflection_per_n),
        },
        "cruise": cruise,
    }


def main() -> None:
    doc = sys.argv[1]
    geo = json.loads(Path(sys.argv[2]).read_text())
    asm = assembly(doc)
    if "--extra-mass-kg" in sys.argv:  # unmodelled harness / fasteners / adhesive, placed at the CG
        extra = float(sys.argv[sys.argv.index("--extra-mass-kg") + 1])
        asm["massKg"] += extra
        asm["inertiaKgM2"] = [[v * asm["massKg"] / (asm["massKg"] - extra) for v in row] for row in asm["inertiaKgM2"]]
    result = size(geo, asm)
    text = json.dumps(result, indent=1)
    if "--json" in sys.argv:
        Path(sys.argv[sys.argv.index("--json") + 1]).write_text(text + "\n")
    print(text)


if __name__ == "__main__":
    main()
