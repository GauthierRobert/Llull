"""PHY-21 (FPR) reference values. Python 3 standard library only.

Run from this folder:  python3 -I generate_fpr_reference.py
Writes expected_results.json (12 significant digits, byte-identical on re-run).
Every value is an exact analytic derivation (grade A) or quoted from a cited datasheet; see README.md for derivations.
"""

import json
import math
from pathlib import Path

HERE = Path(__file__).resolve().parent


def sig(value: float) -> float:
    return float(f"{value:.12g}")


# ---------------------------------------------------------------- test geometry (stated inputs, not engine data)
CRANK_R_M = 3.875 * 0.0254 / 2  # O-320 stroke 3.875 in [C-R20] -> crank radius
ROD_L_M = 0.150                  # test rod length (rod lengths are not public, research note C sec. 3)
FORCE_N = 1000.0
GEAR_TEETH = (51, 21)            # Rotax 912 S/ULS/iS reduction pair [E-R4]
ANGLES_DEG = [30.0, 60.0, 90.0, 120.0, 150.0]


def slider_crank(theta: float, r: float = CRANK_R_M, l: float = ROD_L_M) -> dict:
    lam = r / l
    s = math.sin(theta)
    q = math.sqrt(1.0 - lam * lam * s * s)
    beta = math.asin(lam * s)
    return {
        "x": r * (1.0 - math.cos(theta)) + l * (1.0 - q),
        "dxdtheta": r * (s + lam * math.sin(2.0 * theta) / (2.0 * q)),
        "beta": beta,
    }


def clearance_bar_block(block_x_mm: float) -> dict:
    """Box bar x in [0, 100], y in [-5, 5] mm rotating about z through the origin; block face at x = block_x_mm.
    Max x of the bar at rotation phi = 100 cos(phi) + 5 |sin(phi)| (corners (100, +-5))."""
    def max_x(phi: float) -> float:
        return 100.0 * math.cos(phi) + 5.0 * abs(math.sin(phi))

    peak_phi = math.atan2(5.0, 100.0)  # d/dphi = 0
    peak = max_x(peak_phi)  # = sqrt(100^2 + 5^2)
    result = {"peakPhiDeg": math.degrees(peak_phi), "maxReachMm": peak, "minClearanceMm": block_x_mm - peak}
    if block_x_mm < peak:
        # contact while max_x(phi) >= block_x on phi in [-phi_c, phi_c]; solve 100 cos + 5 sin = block_x for phi > 0
        lo, hi = peak_phi, math.pi / 2
        for _ in range(200):
            mid = 0.5 * (lo + hi)
            if max_x(mid) >= block_x_mm:
                lo = mid
            else:
                hi = mid
        result["contactHalfAngleDeg"] = math.degrees(0.5 * (lo + hi))
    return result


def slider_crank_d2(theta: float, r: float, l: float, h: float = 1e-5) -> float:
    """d2x/dtheta2 by central differences on the exact dx/dtheta (truncation ~1e-10 relative)."""
    return (slider_crank(theta + h, r, l)["dxdtheta"] - slider_crank(theta - h, r, l)["dxdtheta"]) / (2.0 * h)


def case(cid, quantity, value, unit, tol, source, proves, grade="A"):
    if isinstance(value, list):
        value = [sig(v) if isinstance(v, float) else v for v in value]
    elif isinstance(value, float):
        value = sig(value)
    return {"id": cid, "quantity": quantity, "value": value, "unit": unit, "tolerance": tol, "source": source,
            "grade": grade, "proves": proves}


def main() -> None:
    cases = []
    analytic = "exact analytic derivation in this generator (README §3)"

    # ---- A: buildability gate
    cases.append(case("VC-FPR-01", "overlap volume, two 20 mm cubes offset 10 mm along x", 10.0 * 20.0 * 20.0, "mm3",
                      {"rel": 1e-3}, analytic, ["FR-FPR-03", "TR-FPR-01", "TR-FPR-03"]))
    cases.append(case("VC-FPR-02", "two 20 mm cubes sharing a face: class touch, overlap volume", 0.0, "mm3",
                      {"abs": 1e-6}, analytic, ["FR-FPR-03", "FR-FPR-04"]))
    cases.append(case("VC-FPR-03", "min distance, cubes 0.5 mm apart (required clearance 1 mm)", 0.5, "mm",
                      {"abs": 1e-6}, analytic, ["FR-FPR-03", "FR-FPR-04"]))
    cases.append(case("VC-FPR-04", "containment volume, 10 mm cube centred in a 30 mm cube", 1000.0, "mm3",
                      {"rel": 1e-3}, analytic, ["FR-FPR-03"]))
    cases.append(case("VC-FPR-05", "lump count of one part made of two disjoint 10 mm boxes", 2, "count",
                      {"abs": 0}, analytic, ["FR-FPR-02", "TR-FPR-01"]))
    cases.append(case("VC-FPR-06", "floating components: one free box beside a grounded jointed pair", 1, "count",
                      {"abs": 0}, analytic, ["FR-FPR-06"]))
    cases.append(case("VC-FPR-07", "min wall thickness of a 100 x 100 x 2 mm plate (ray method)", 2.0, "mm",
                      {"abs": 0.02}, analytic + "; threshold cnc_metal 0.794 mm quoted from [B-R14]",
                      ["FR-FPR-07", "TR-FPR-04"]))
    cases.append(case("VC-FPR-08", "min wall thickness of a 100 x 100 x 0.5 mm plate -> FPR_WALL_THIN", 0.5, "mm",
                      {"abs": 0.01}, analytic, ["FR-FPR-07"]))
    cases.append(case("VC-FPR-09", "diametral clearance, pin D10.00 in bore D10.02 coaxial with a revolute joint", 0.02,
                      "mm", {"abs": 1e-6}, analytic, ["FR-FPR-08", "TR-FPR-02"]))

    # ---- B: slider-crank (r = 49.2125 mm, l = 150 mm)
    xs = [slider_crank(math.radians(a))["x"] for a in ANGLES_DEG]
    cases.append(case("VC-FPR-10", "piston travel from TDC at crank 30/60/90/120/150 deg (r 49.2125 mm, l 150 mm)", xs,
                      "m", {"abs": 1e-6}, analytic + "; formula [C-R12]", ["FR-FPR-10", "FR-FPR-12", "TR-FPR-05",
                                                                           "TR-FPR-07"]))
    torques = [FORCE_N * slider_crank(math.radians(a))["dxdtheta"] for a in ANGLES_DEG]
    cases.append(case("VC-FPR-11", "crank torque from a constant 1000 N gas force at 30/60/90/120/150 deg", torques,
                      "N*m", {"rel": 5e-3}, analytic + "; T = F dx/dtheta = F r sin(theta+beta)/cos(beta) [C-R12][C-R14]",
                      ["FR-FPR-13", "TR-FPR-08"]))
    rod = [FORCE_N / math.cos(slider_crank(math.radians(a))["beta"]) for a in ANGLES_DEG]
    side = [FORCE_N * math.tan(slider_crank(math.radians(a))["beta"]) for a in ANGLES_DEG]
    cases.append(case("VC-FPR-12a", "rod force F/cos(beta), static, 1000 N, at 30/60/90/120/150 deg", rod, "N",
                      {"rel": 5e-3}, analytic + " [C-R12]", ["FR-FPR-14", "TR-FPR-07"]))
    cases.append(case("VC-FPR-12b", "cylinder side thrust F tan(beta), static, 1000 N, at 30/60/90/120/150 deg", side,
                      "N", {"rel": 5e-3}, analytic + " [C-R12]", ["FR-FPR-14", "TR-FPR-07"]))
    cases.append(case("VC-FPR-13", "max loop-closure residual in the verification runs of this pack (pass tier)", 1e-6,
                      "m", {"max": 1e-6}, "pass tier of VC-FPR-35; derived estimate 1e-8 m with the stiff settings "
                      "[C sec. 1.2][C-R3]",
                      ["FR-FPR-15", "TR-FPR-07"]))
    cases.append(case("VC-FPR-14", "cycle-energy closure |oint T dtheta - sum oint p dV| / sum oint p dV (gate)", 0.005,
                      "ratio", {"max": 0.005}, "identity T = F dx/dtheta (virtual work) [C-R12]; gate named",
                      ["FR-FPR-16"]))

    # ---- Rotax 912 iS class: datasheet 73.5 kW at 5800 rpm, 1352 cm3, 121 N*m, gearbox 2.43 [C-R23]
    vd = 1352e-6
    power = 73.5e3
    rpm = 5800.0
    mep = power * 2.0 * 60.0 / (vd * rpm)  # P = MEP Vd N/2, N in rev/s [C-R18]
    cases.append(case("VC-FPR-15a", "MEP for 73.5 kW at 5800 rpm, 1352 cm3, four-stroke", mep / 1e5, "bar",
                      {"rel": 1e-9}, "derived from datasheet [C-R23] with P = MEP Vd N / 2 [C-R18]", ["FR-FPR-17"]))
    cases.append(case("VC-FPR-15b", "mean BRAKE torque with the heat release calibrated so BMEP = VC-FPR-15a "
                      "(origin: calibrated, not validation evidence)", mep * vd / (4.0 * math.pi), "N*m", {"rel": 0.005},
                      "derived [C-R18]; datasheet quotes 121 N*m at 5800 rpm [C-R23]", ["FR-FPR-16", "FR-FPR-17",
                                                                                         "FR-FPR-72", "FR-FPR-78"]))
    cases.append(case("VC-FPR-16", "propeller speed through the 51/21 reduction (i = 2.4286) at 5800 rpm crank",
                      rpm * GEAR_TEETH[1] / GEAR_TEETH[0], "rpm", {"rel": 1e-3},
                      "tooth counts 51/21 quoted from [E-R4] (datasheet rounds to 2.43 [C-R23])", ["FR-FPR-14", "FR-FPR-74"]))
    cases.append(case("VC-FPR-17", "speed-ripple coefficient vs Delta E / (I omega0^2) from the simulated torque curve",
                      0.05, "relative difference", {"max": 0.05},
                      "formula [C-R25]; value computed at test time from the run's own torque curve (method b)",
                      ["FR-FPR-16"]))

    # ---- C: motion clearance, rotating bar vs block
    free = clearance_bar_block(105.0)
    cases.append(case("VC-FPR-18", "min clearance, bar (100 x 10 mm) rotating about z vs block face at x = 105 mm",
                      free["minClearanceMm"], "mm", {"abs": 1e-3}, analytic, ["FR-FPR-20", "FR-FPR-21", "TR-FPR-10"]))
    cases.append(case("VC-FPR-18b", "rotation angle of closest approach (+-)", free["peakPhiDeg"], "deg",
                      {"abs": 0.05}, analytic, ["FR-FPR-20"]))
    hit = clearance_bar_block(95.0)
    cases.append(case("VC-FPR-19", "contact half-interval, same bar vs block face at x = 95 mm (contact on [-a, a])",
                      hit["contactHalfAngleDeg"], "deg", {"abs": 0.05}, analytic + " (bisection to 1e-15)",
                      ["FR-FPR-20", "FR-FPR-21"]))

    # ---- mobility of a planar slider-crank (crank R to ground, rod R to crank, piston P to ground, wrist loop)
    cases.append(case("VC-FPR-20a", "slider-crank, wrist revolute: [Gruebler DOF, rank DOF, redundant rows]",
                      [6 * 3 - (5 + 5 + 5 + 5), 1, 5 - 2], "count", {"abs": 0},
                      "Gruebler [A-R59]; rank: 3 tree coords, 5 loop rows of rank 2 (planar)", ["FR-FPR-11",
                                                                                                "TR-FPR-09"]))
    cases.append(case("VC-FPR-20b", "slider-crank, wrist spherical: [Gruebler DOF, rank DOF, redundant rows]",
                      [6 * 3 - (5 + 5 + 5 + 3), 1, 3 - 2], "count", {"abs": 0},
                      "Gruebler [A-R59] (0 although the mechanism moves: Gruebler cannot prove redundancy [A-R60])",
                      ["FR-FPR-11", "TR-FPR-09"]))
    cases.append(case("VC-FPR-21", "start-pose loop gap reported by FPR_LOOP_OPEN, wrist pin moved 1 mm", 0.001, "m",
                      {"abs": 1e-9}, analytic, ["FR-FPR-12"]))


    # ---- E: realism (verification of the realism laws, and reference data for validation)
    gear_torque = 121.0 * GEAR_TEETH[0] / GEAR_TEETH[1] * 0.99
    cases.append(case("VC-FPR-27", "propeller-shaft torque from 121 N*m crank torque through 51/21 at mesh efficiency 0.99",
                      gear_torque, "N*m", {"rel": 1e-3}, "teeth [E-R4]; efficiency default 0.99 per mesh [E-R21]",
                      ["FR-FPR-74"]))
    r_ref, l_ref, m_rec, rpm_ref = 0.0305, 0.130, 0.40, 5800.0
    omega = rpm_ref * 2.0 * math.pi / 60.0
    inertia = [m_rec * omega ** 2 * slider_crank(math.radians(a), r_ref, l_ref)["dxdtheta"]
               * slider_crank_d2(math.radians(a), r_ref, l_ref) for a in ANGLES_DEG]
    cases.append(case("VC-FPR-28", "motored inertia torque at 30/60/90/120/150 deg: 0.40 kg piston (test value), "
                      "r 30.5 mm, l 130 mm, governed 5800 rpm, no gas force, no friction", inertia, "N*m",
                      {"rel": 0.01}, analytic + "; T = m w^2 x'(theta) x''(theta); r, l from [E-R8] (low confidence)",
                      ["FR-FPR-73", "FR-FPR-79"]))
    bore_mm, stroke_mm, cr, n = 84.0, 61.0, 10.8, 5800.0
    sp = 2.0 * stroke_mm / 1000.0 * n / 60.0
    skirt = 2.94e2 * sp / bore_mm
    rings = 4.06e4 * (1.0 + 1000.0 / n) / bore_mm ** 2
    gas = 6.89 * 1.0 * (0.088 * cr + 0.182 * cr ** (1.33 - 2.38e-2 * sp))
    aux = 6.23 + 5.22e-3 * n - 1.79e-7 * n ** 2
    cases.append(case("VC-FPR-29", "PNH friction terms, Rotax 912 geometry at 5800 rpm WOT: "
                      "[piston skirt, rings, ring gas load, auxiliaries]", [skirt, rings, gas, aux], "kPa",
                      {"rel": 1e-3}, "equations of [E-R9] as reconstructed in note E sec. 1.3; bore/stroke [C-R23], "
                      "CR [E-R2]. Grade C until checked against SAE 890836 / 2003-01-0725", ["FR-FPR-71"], grade="C"))
    cases.append(case("VC-FPR-30", "mass of a 50 mm cube of aluminium 4032 (SG 2.68)", 0.05 ** 3 * 2680.0, "kg",
                      {"rel": 1e-6}, "density [E-R32]", ["FR-FPR-73"]))
    curve = [(2500, 99.0), (3000, 107.0), (3500, 114.5), (4000, 119.0), (4500, 124.0), (5000, 127.5), (5100, 128.0),
             (5500, 124.5), (5800, 121.0)]
    cases.append(case("VC-FPR-31", "reference BMEP of the Rotax 912 ULS full-throttle torque curve at 2500/3000/3500/"
                      "4000/4500/5000/5100/5500/5800 rpm (BMEP = 4 pi T / Vd)",
                      [4.0 * math.pi * tq / vd / 1e5 for _, tq in curve], "bar", {"abs": 0.1},
                      "torque digitised from OM-912 Fig. 4 [E-R2] (+-1 N*m reading); peak 128 N*m at 5100 rpm "
                      "quoted [E-R1]", ["FR-FPR-77", "FR-FPR-78"], grade="B"))
    cases.append(case("VC-FPR-32", "fixed-pitch static full-throttle rpm window, Rotax 912 + 1.70-1.80 m propeller "
                      "(V1, four-cylinder reference)", [5100, 5800], "rpm", {"window": True},
                      "propeller maker's setting rule [F-R22]; >= 5200 rpm WOT [E-R5]", ["FR-FPR-75", "FR-FPR-77"],
                      grade="B"))
    cases.append(case("VC-FPR-33", "timestep-halving change of mean brake torque and peak wrist-pin force (gate)", 0.01,
                      "ratio", {"max": 0.01}, "named gate (solution verification)", ["FR-FPR-79"]))
    cases.append(case("VC-FPR-35", "loop-residual tiers: pass <= 1e-6 m, warn <= 1e-5 m, fail above",
                      [1e-6, 1e-5], "m", {"abs": 0}, "5 % of the 0.020 mm minimum rod-pin diametral clearance [F-R19]; "
                      "named", ["FR-FPR-15"]))

    out = {"pack": "21-functional-prototype", "generatedBy": "generate_fpr_reference.py", "cases": cases}
    (HERE / "expected_results.json").write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
