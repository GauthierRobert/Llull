#!/usr/bin/env python3
"""
Generate the analytic reference datasets of PHY-19 (high strain rate, impact and explicit dynamics hand-off).

Run:  python3 -I generate_explicit_reference.py      (stdlib only, deterministic, writes next to this script)

Outputs
  expected_results.json      expected values in the docs/physics/README.md section 6.3 schema
  wave_speed_cfl.csv         bar and dilatational wave speeds and critical time steps for test materials and element sizes
  bar_impact_history.csv     1D elastic bar on a rigid wall: stress at the wall and at mid-length versus time
  johnson_cook_curves.csv    Johnson-Cook flow stress versus plastic strain at three strain rates (Ti-6Al-4V set, grade B)
  energy_balance_sample.csv  synthetic energy time history (test fixture for the energy-balance checker; NOT physics data)

Units: SI unless the column or key says otherwise. Every number that is not derived here is either a "test input"
(chosen for the case, not a material claim) or quoted with its source id from validation/sources.md ([Sx]).
Tolerances are llull acceptance choices (validation/README.md), not claims of any source.
"""

from __future__ import annotations

import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
PACK = "19-explicit-impact"
LB_KG = 0.45359237      # international avoirdupois pound, exact by definition (1959)
G0 = 9.80665            # standard acceleration of gravity, m/s^2, exact by definition


def out(name: str) -> str:
    return os.path.join(HERE, name)


def sig(x: float, n: int = 12) -> float:
    if x == 0 or not math.isfinite(x):
        return x
    return float(f"{x:.{n}g}")


def fmt(x: float) -> str:
    return f"{sig(x):.12g}"


CASES: list[dict] = []


def case(cid: str, quantity: str, value: float, unit: str, tol: dict, source: str, grade: str, proves: list[str],
         derivation: str, inputs: dict | None = None, extra: dict | None = None) -> None:
    c = {"id": cid, "quantity": quantity, "value": sig(value), "unit": unit, "tolerance": tol, "source": source,
         "grade": grade, "proves": proves, "derivation": derivation}
    if inputs is not None:
        c["inputs"] = inputs
    if extra is not None:
        c.update(extra)
    CASES.append(c)


# ---------------------------------------------------------------------------------------------------------
# 1. Elastic wave speeds and the explicit critical time step
#    bar (1D):             c0 = sqrt(E / rho)
#    dilatational (3D):    cd = sqrt(E (1 - nu) / ((1 + nu)(1 - 2 nu) rho))
#    CFL estimate:         dt_crit = L_e / c   (L_e = characteristic element length; solver-specific factors excluded)
#    mass scaling to reach dt_target: rho' = E_eff dt_target^2 / L_e^2, added-mass ratio = rho'/rho - 1
# ---------------------------------------------------------------------------------------------------------
TEST_MATERIALS = {  # test inputs (round numbers), NOT material claims: E [Pa], nu, rho [kg/m^3]
    "steel_like": (200.0e9, 0.3, 7850.0),
    "aluminium_like": (70.0e9, 0.33, 2700.0),
    "titanium_like": (110.0e9, 0.31, 4430.0),
}


def c_bar(E: float, rho: float) -> float:
    return math.sqrt(E / rho)


def c_dil(E: float, nu: float, rho: float) -> float:
    return math.sqrt(E * (1.0 - nu) / ((1.0 + nu) * (1.0 - 2.0 * nu) * rho))


E_S, NU_S, RHO_S = TEST_MATERIALS["steel_like"]
case("VC-EXP-10.a", "1D bar wave speed, steel-like test material", c_bar(E_S, RHO_S), "m/s", {"rel": 1e-9},
     "derivation (1D wave equation)", "A", ["FR-EXP-11", "TR-EXP-30"], "c0 = sqrt(E / rho)", {"E_Pa": E_S, "rho_kg_m3": RHO_S})
case("VC-EXP-10.b", "3D dilatational wave speed, steel-like test material", c_dil(E_S, NU_S, RHO_S), "m/s", {"rel": 1e-9},
     "derivation (elastodynamics)", "A", ["FR-EXP-11", "TR-EXP-30"], "cd = sqrt(E(1-nu)/((1+nu)(1-2nu)rho))",
     {"E_Pa": E_S, "nu": NU_S, "rho_kg_m3": RHO_S})
LE = 0.002  # 2 mm element (test input)
case("VC-EXP-11.a", "CFL critical time step, 2 mm solid element, steel-like (dilatational)", LE / c_dil(E_S, NU_S, RHO_S), "s",
     {"rel": 1e-9}, "derivation (Courant condition)", "A", ["FR-EXP-11", "TR-EXP-30"], "dt = L_e / cd",
     {"L_e_m": LE, "E_Pa": E_S, "nu": NU_S, "rho_kg_m3": RHO_S})
DT_TARGET = 1.0e-6  # test input
rho_needed = (E_S * (1.0 - NU_S) / ((1.0 + NU_S) * (1.0 - 2.0 * NU_S))) * DT_TARGET**2 / LE**2
case("VC-EXP-11.b", "added-mass ratio to raise dt to 1e-6 s for the same element", rho_needed / RHO_S - 1.0, "-", {"rel": 1e-9},
     "derivation", "A", ["FR-EXP-12", "TR-EXP-31"], "rho' = M dt^2 / L_e^2 with M = E(1-nu)/((1+nu)(1-2nu)); ratio = rho'/rho - 1",
     {"L_e_m": LE, "dt_target_s": DT_TARGET})


# ---------------------------------------------------------------------------------------------------------
# 2. Elastic bar impact (1D, linear elastic, no dispersion)
#    bar at speed v onto a rigid wall:   sigma = rho c0 v  (compressive), contact duration 2 L / c0
#    two identical bars, relative speed v: sigma = rho c0 v / 2
#    largest elastic impact speed for yield sigma_y:  v_y = sigma_y / (rho c0)
# ---------------------------------------------------------------------------------------------------------
V_I, L_BAR, SY = 10.0, 0.2, 500.0e6  # m/s, m, Pa (test inputs)
c0 = c_bar(E_S, RHO_S)
case("VC-EXP-12.a", "bar-on-rigid-wall impact stress, v = 10 m/s", RHO_S * c0 * V_I, "Pa", {"rel": 0.02},
     "derivation (1D elastic waves)", "A", ["FR-EXP-11", "FR-EXP-15", "TR-EXP-32"], "sigma = rho c0 v",
     {"E_Pa": E_S, "rho_kg_m3": RHO_S, "v_m_s": V_I})
case("VC-EXP-12.b", "contact duration of the bar on the rigid wall", 2.0 * L_BAR / c0, "s", {"rel": 0.03},
     "derivation", "A", ["FR-EXP-15", "TR-EXP-32"], "t_c = 2 L / c0", {"L_m": L_BAR})
case("VC-EXP-12.c", "stress for two identical bars at relative speed 10 m/s", RHO_S * c0 * V_I / 2.0, "Pa", {"rel": 0.02},
     "derivation", "A", ["FR-EXP-11"], "sigma = rho c0 v / 2", {"v_rel_m_s": V_I})
case("VC-EXP-12.d", "largest elastic impact speed for yield 500 MPa (rigid wall)", SY / (RHO_S * c0), "m/s", {"rel": 1e-9},
     "derivation", "A", ["FR-EXP-11"], "v_y = sigma_y / (rho c0)", {"sigma_y_Pa": SY})


# ---------------------------------------------------------------------------------------------------------
# 3. Johnson-Cook strength and failure (law definitions owned by PHY-02; [S6] form, [S7] Radioss / [S8] LS-DYNA fields)
#    sigma = (A + B eps_p^n)(1 + C ln(eps_dot / eps_dot0))(1 - T*^m),  T* = (T - Tr)/(Tm - Tr)
#    eps_f = (D1 + D2 exp(D3 sigma*))(1 + D4 ln(eps_dot / eps_dot0))(1 + D5 T*), sigma* = p/sigma_eq (triaxiality, sign per solver)
#    damage D = sum d eps_p / eps_f  -> at constant conditions failure at eps_p = eps_f
# ---------------------------------------------------------------------------------------------------------
JC_TI = {"A_MPa": 1098.0, "B_MPa": 1092.0, "n": 0.93, "C": 0.014, "m": 1.1}  # [S9] grade B: Lesuer / Kay FAA reports, via secondary papers


def jc_flow(A: float, B: float, n: float, C: float, m: float, eps: float, rate: float, rate0: float, Tstar: float) -> float:
    rate_term = 1.0 + C * math.log(max(rate / rate0, 1.0))
    return (A + B * eps**n) * rate_term * (1.0 - (Tstar**m if Tstar > 0 else 0.0))


s1 = jc_flow(JC_TI["A_MPa"], JC_TI["B_MPa"], JC_TI["n"], JC_TI["C"], JC_TI["m"], 0.1, 1000.0, 1.0, 0.0)
case("VC-EXP-20.a", "Johnson-Cook flow stress, eps_p = 0.1, rate 1000/s (eps_dot0 = 1/s), T = Tr", s1, "MPa", {"rel": 1e-9},
     "derivation with S9 constants", "B", ["FR-EXP-05", "TR-EXP-20"], "(A + B eps^n)(1 + C ln(rate/rate0))", JC_TI,
     {"note": "constants are reported in secondary literature as Lesuer (DOT/FAA/AR-00/25) or Kay (DOT/FAA/AR-03/57); primary PDF not reached"})
TM_TI, TR_TI = 1900.0, 293.0  # K, test inputs (NOT a melting-point claim)
s2 = jc_flow(JC_TI["A_MPa"], JC_TI["B_MPa"], JC_TI["n"], JC_TI["C"], JC_TI["m"], 0.1, 1000.0, 1.0, (600.0 - TR_TI) / (TM_TI - TR_TI))
case("VC-EXP-20.b", "same, T = 600 K with test-input Tm = 1900 K, Tr = 293 K", s2, "MPa", {"rel": 1e-9},
     "derivation", "B", ["FR-EXP-05", "TR-EXP-20"], "thermal term (1 - T*^m)", dict(JC_TI, T_K=600.0, Tm_K=TM_TI, Tr_K=TR_TI))
case("VC-EXP-20.c", "rate below eps_dot0 is clamped (no softening below the reference rate)",
     jc_flow(1.0, 0.0, 1.0, 0.014, 1.0, 0.0, 0.001, 1.0, 0.0), "-", {"abs": 1e-12}, "solver convention (TR-EXP-20)", "B",
     ["TR-EXP-20"], "rate term = 1 + C ln(max(rate/rate0, 1))", {"A": 1.0, "B": 0.0, "C": 0.014, "rate_per_s": 0.001})

D_TEST = (0.05, 3.44, -2.12, 0.002, 0.61)  # test inputs (Johnson-Cook form), NOT material claims


def jc_fail(D: tuple, triax: float, rate: float, rate0: float, Tstar: float) -> float:
    D1, D2, D3, D4, D5 = D
    return (D1 + D2 * math.exp(D3 * triax)) * (1.0 + D4 * math.log(max(rate / rate0, 1.0))) * (1.0 + D5 * Tstar)


EF = jc_fail(D_TEST, 1.0 / 3.0, 1.0, 1.0, 0.0)
case("VC-EXP-21.a", "Johnson-Cook failure strain, uniaxial tension (triaxiality 1/3), quasi-static, T = Tr", EF, "-", {"rel": 1e-9},
     "derivation", "A", ["FR-EXP-06", "TR-EXP-21"], "eps_f = D1 + D2 exp(D3 eta)", {"D1_D5": list(D_TEST), "triaxiality": 1.0 / 3.0})
N_INC = 1000
dmg, eps_at_fail = 0.0, None
for k in range(1, 4 * N_INC + 1):
    deps = EF / N_INC
    dmg += deps / EF
    if dmg >= 1.0 - 1e-12 and eps_at_fail is None:
        eps_at_fail = k * deps
case("VC-EXP-21.b", "plastic strain at D = 1 under constant conditions (linear accumulation)", eps_at_fail or 0.0, "-", {"rel": 1e-6},
     "derivation", "A", ["FR-EXP-06", "TR-EXP-21"], "D = sum d eps / eps_f reaches 1 at eps = eps_f", {"increments": N_INC})


# ---------------------------------------------------------------------------------------------------------
# 4. Taylor impact (flat-ended rod on a rigid anvil), Taylor 1948 one-dimensional estimate  [S10, grade B form]
#    sigma_d = rho v^2 (L0 - X) / (2 (L0 - L1) ln(L0 / X)),  L0 initial, L1 final length, X undeformed length
# ---------------------------------------------------------------------------------------------------------
def taylor_sigma(rho: float, v: float, L0: float, L1: float, X: float) -> float:
    return rho * v**2 * (L0 - X) / (2.0 * (L0 - L1) * math.log(L0 / X))


TB = {"rho_kg_m3": 4430.0, "v_m_s": 200.0, "L0_m": 0.0254, "L1_m": 0.0220, "X_m": 0.0180}  # test inputs (measured-like)
case("VC-EXP-22", "Taylor dynamic yield estimate from rod lengths", taylor_sigma(TB["rho_kg_m3"], TB["v_m_s"], TB["L0_m"], TB["L1_m"], TB["X_m"]),
     "Pa", {"rel": 1e-9}, "S10 (form as quoted in secondary literature)", "B", ["FR-EXP-15", "TR-EXP-33"],
     "sigma_d = rho v^2 (L0 - X) / (2 (L0 - L1) ln(L0/X))", TB)


# ---------------------------------------------------------------------------------------------------------
# 5. Impact scenarios: energy and momentum checks (rigid target)
#    projectile kinetic energy KE = m v^2 / 2; normal soft-body impact with no rebound: impulse on target = m v
#    free drop from height h: v = sqrt(2 g h), time to impact t = sqrt(2 h / g)
# ---------------------------------------------------------------------------------------------------------
M4, M8 = 4.0 * LB_KG, 8.0 * LB_KG
case("VC-EXP-30.a", "bird mass for 14 CFR 25.571(e)(1) (4 lb)", M4, "kg", {"rel": 1e-12}, "S11 (4 lb) + exact lb definition", "A",
     ["FR-EXP-16"], "m = 4 x 0.45359237")
case("VC-EXP-30.b", "bird mass for 14 CFR 25.631 (8 lb)", M8, "kg", {"rel": 1e-12}, "S11 (8 lb) + exact lb definition", "A",
     ["FR-EXP-16"], "m = 8 x 0.45359237")
V_B = 150.0  # m/s test input (the regulatory speed is aircraft-specific: VC at sea level / 0.85 VC at 8000 ft)
case("VC-EXP-31.a", "kinetic energy of a 4 lb bird at 150 m/s (test speed)", 0.5 * M4 * V_B**2, "J", {"rel": 1e-12},
     "derivation", "A", ["FR-EXP-16", "TR-EXP-34"], "KE = m v^2 / 2", {"m_kg": sig(M4), "v_m_s": V_B})
case("VC-EXP-31.b", "impulse delivered to a rigid plate by a 4 lb soft body at 150 m/s, normal, no rebound", M4 * V_B, "N s",
     {"rel": 0.05}, "derivation (momentum conservation)", "A", ["FR-EXP-16", "FR-EXP-09", "TR-EXP-34"],
     "J = m v (5 % allows residual splash velocity along the normal)", {"m_kg": sig(M4), "v_m_s": V_B})
RHO_BIRD = 1000.0  # kg/m^3 test input for the substitute-bird geometry (NOT a bird-density claim)
D_BIRD = (2.0 * (M4 / RHO_BIRD) / math.pi) ** (1.0 / 3.0)  # cylinder with L = 2 D: V = pi D^3 / 2
case("VC-EXP-31.c", "diameter of a 4 lb cylinder with L = 2 D at the test density 1000 kg/m^3 (plan geometry)", D_BIRD, "m",
     {"rel": 1e-9}, "derivation", "A", ["FR-EXP-16"], "D = (2 V / pi)^(1/3), V = m / rho", {"m_kg": sig(M4), "rho_kg_m3": RHO_BIRD},
     {"length_m": sig(2.0 * D_BIRD)})
H_D = 1.2  # m, drop height test input
case("VC-EXP-32.a", "impact speed after a free drop of 1.2 m", math.sqrt(2.0 * G0 * H_D), "m/s", {"rel": 0.005},
     "derivation (free fall)", "A", ["FR-EXP-17", "TR-EXP-34"], "v = sqrt(2 g h), g = 9.80665", {"h_m": H_D})
case("VC-EXP-32.b", "time to impact after a free drop of 1.2 m", math.sqrt(2.0 * H_D / G0), "s", {"rel": 0.005},
     "derivation", "A", ["FR-EXP-17"], "t = sqrt(2 h / g)", {"h_m": H_D})


# ---------------------------------------------------------------------------------------------------------
# 6. Energy-balance checker on a synthetic history (fixture; checks the arithmetic of TR-EXP-40, not physics)
#    energy error = (E_kin + E_int + E_hg + E_contact - E_kin0 - W_ext) / max(E_kin0 + W_ext, eps)
#    hourglass ratio = E_hg / E_int; contact ratio = E_contact / E_int; added mass ratio = M_added / M_0
# ---------------------------------------------------------------------------------------------------------
E0 = 20000.0  # J initial kinetic energy (fixture)
rows = []
for k in range(0, 21):
    t = k * 1.0e-4
    f = k / 20.0
    eint = 0.8 * E0 * f
    ehg = 0.05 * eint
    econ = 0.03 * eint
    ekin = E0 - eint - ehg - econ - 0.002 * E0 * f  # 0.2 % numerical loss at the end
    rows.append([t, ekin, eint, ehg, econ, 0.0, 0.0])
last = rows[-1]
err = (last[1] + last[2] + last[3] + last[4] - E0 - last[5]) / E0
case("VC-EXP-40.a", "energy error at the end of the synthetic history", err, "-", {"abs": 1e-12}, "fixture", "A",
     ["FR-EXP-09", "TR-EXP-40"], "(Ekin + Eint + Ehg + Econ - Ekin0 - Wext) / (Ekin0 + Wext)")
case("VC-EXP-40.b", "hourglass / internal energy ratio at the end", last[3] / last[2], "-", {"abs": 1e-12}, "fixture", "A",
     ["FR-EXP-09", "TR-EXP-40"], "Ehg / Eint")
case("VC-EXP-40.c", "contact / internal energy ratio at the end", last[4] / last[2], "-", {"abs": 1e-12}, "fixture", "A",
     ["FR-EXP-09", "TR-EXP-40"], "Econ / Eint")


# ---------------------------------------------------------------------------------------------------------
# CSV writers
# ---------------------------------------------------------------------------------------------------------
def write_csv(name: str, header: list[str], data: list[list[float]], labels: list[str] | None = None) -> None:
    with open(out(name), "w", encoding="utf-8", newline="\n") as f:
        f.write(",".join(header) + "\n")
        for i, row in enumerate(data):
            cells = ([labels[i]] if labels else []) + [fmt(v) for v in row]
            f.write(",".join(cells) + "\n")


cfl_rows, cfl_labels = [], []
for name, (E, nu, rho) in TEST_MATERIALS.items():
    for le_mm in (0.5, 1.0, 2.0, 5.0, 10.0):
        cfl_labels.append(name)
        cfl_rows.append([E, nu, rho, c_bar(E, rho), c_dil(E, nu, rho), le_mm, le_mm / 1000.0 / c_dil(E, nu, rho)])
write_csv("wave_speed_cfl.csv", ["material_test_input", "E_Pa", "nu", "rho_kg_m3", "c_bar_m_s", "c_dil_m_s", "L_e_mm", "dt_crit_s"],
          cfl_rows, cfl_labels)

# 1D bar on rigid wall: stress at the wall (x = 0) and at mid-length (x = L/2), ideal square waves
tc = 2.0 * L_BAR / c0
hist = []
for k in range(0, 41):
    t = k * tc / 30.0
    wall = RHO_S * c0 * V_I if 0.0 <= t < tc else 0.0
    t_mid_on, t_mid_off = (L_BAR / 2.0) / c0, tc - (L_BAR / 2.0) / c0
    mid = RHO_S * c0 * V_I if t_mid_on <= t < t_mid_off else 0.0
    hist.append([t, wall, mid])
write_csv("bar_impact_history.csv", ["t_s", "sigma_wall_Pa", "sigma_mid_Pa"], hist)

jc_rows = []
for k in range(0, 21):
    e = k * 0.025
    jc_rows.append([e] + [jc_flow(JC_TI["A_MPa"], JC_TI["B_MPa"], JC_TI["n"], JC_TI["C"], JC_TI["m"], e, r, 1.0, 0.0) for r in (1.0, 1.0e3, 1.0e5)])
write_csv("johnson_cook_curves.csv", ["eps_p", "sigma_MPa_rate_1", "sigma_MPa_rate_1e3", "sigma_MPa_rate_1e5"], jc_rows)

write_csv("energy_balance_sample.csv", ["t_s", "E_kin_J", "E_int_J", "E_hourglass_J", "E_contact_J", "W_ext_J", "M_added_kg"], rows)

# Synthetic Engine listing (column layout as in [S1] engine_listing_columns; values = the fixture above, NOT a solver run)
with open(out("engine_listing_sample.txt"), "w", encoding="utf-8", newline="\n") as f:
    f.write("SYNTHETIC FIXTURE written by generate_explicit_reference.py (not solver output)\n")
    f.write("   CYCLE    TIME      TIME-STEP  ELEMENT          ERROR  I-ENERGY    K-ENERGY T  K-ENERGY R  EXT-WORK     MAS.ERR     TOTAL MASS  MASS ADDED\n")
    for k, r in enumerate(rows):
        e_err = (r[1] + r[2] + r[3] + r[4] - E0 - r[5]) / E0 * 100.0
        f.write(f"{k * 100:8d}  {r[0]:.4E}  {1.0e-6:.4E} BRICK          1 {e_err:5.1f}%  {r[2]:.4E}  {r[1]:.4E}  {0.0:.4E}  {r[5]:.4E}  {0.0:.4E}  {1.814:.4E}  {0.0:.4E}\n")
    f.write("     NORMAL TERMINATION\n")
case("VC-EXP-42", "energy error read from the last cycle line of engine_listing_sample.txt", -0.2, "%", {"abs": 0.05},
     "fixture", "A", ["FR-EXP-09", "TR-EXP-41"], "ERROR column of the last CYCLE line; NORMAL TERMINATION present",
     None, {"expect": {"normalTermination": True, "cycles": 21, "maxAddedMassKg": 0.0}})

doc = {"pack": PACK, "generatedBy": "generate_explicit_reference.py",
       "units_note": "SI unless the unit field says otherwise; '-' = dimensionless", "cases": CASES}
with open(out("expected_results.json"), "w", encoding="utf-8", newline="\n") as f:
    json.dump(doc, f, indent=1, ensure_ascii=False)
    f.write("\n")
