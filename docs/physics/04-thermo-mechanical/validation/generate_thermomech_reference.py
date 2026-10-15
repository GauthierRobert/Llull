#!/usr/bin/env python3
"""
Generate the analytic reference values of PHY-04 (thermo-mechanical coupling and thermal fits).

Run:  python3 -I generate_thermomech_reference.py      (stdlib only, deterministic, writes next to this script)

Outputs
  expected_results.json        cases in the docs/physics/README.md section 6.3 schema (12 significant digits)
  fit_at_temperature.csv       hole/shaft clearance vs temperature for the material pairs of VC-TMC-06
  thick_cylinder_profile.csv   radial profiles of the VC-TMC-05 thermal stresses (closed form + quadrature)
  cte_conversion.csv           instantaneous vs secant CTE for the VC-TMC-07 test law

Formulas (source ids refer to sources.md):
  Restrained thermal stress:   uniaxial  s = -E a dT;  biaxial  s = -E a dT / (1 - nu);  triaxial  s = -E a dT / (1 - 2 nu)   [S9]
  Hot circular inclusion (same E, nu) in an infinite plate, plane stress: inside sr = st = -E a dT / 2;
                               outside sr = -E a dT a^2 / (2 r^2), st = +E a dT a^2 / (2 r^2)                            [S9, S3 (T1 set-up)]
  Bimetal strip (Timoshenko 1925):
      1/rho = 6 (a2 - a1) dT (1 + m)^2 / ( h [ 3 (1 + m)^2 + (1 + m n) (m^2 + 1/(m n)) ] ),  m = t1/t2, n = E1/E2, h = t1 + t2   [S4]
      cross-checked by solving axial-force and moment equilibrium of the two layers (2x2 linear system)
  Thick cylinder, steady log temperature T(r) = Ta ln(b/r)/ln(b/a), Tb = 0, free ends (Timoshenko & Goodier form):          [S9]
      st = E a / (1 - nu) / r^2 [ (r^2 + a^2)/(b^2 - a^2) I(b) + I(r) - T r^2 ],  sr = E a / (1 - nu) / r^2 [ (r^2 - a^2)/(b^2 - a^2) I(b) - I(r) ],
      sz = E a / (1 - nu) [ 2 I(b)/(b^2 - a^2) - T ],  I(r) = int_a^r T r' dr'   -> also evaluated in closed form
  Fit at temperature:          D(T) = D_spec (1 + a_sec(T) (T - T_spec)),  clearance = D_hole(T) - D_shaft(T)                 [S5 (limits), S9]
  Secant CTE from an instantaneous law:   a_sec(T; Tref) = (1/(T - Tref)) int_Tref^T a_inst dT'   (CalculiX *EXPANSION, ZERO=Tref) [S7]
  Through-thickness gradient:  kappa = a dT / h;  simply supported mid-span w = kappa L^2 / 8;  cantilever tip w = kappa L^2 / 2  [S9]
  Shrink fit (Lame), solid shaft radius b in hub outer radius c:
      p = d_r / ( b [ ((c^2 + b^2)/(c^2 - b^2) + nu_h) / E_h + (1 - nu_s) / E_s ] ),  d_r = radial interference              [S9]

Inputs labelled "test input" are chosen for the case; they are not material claims.
"""

from __future__ import annotations

import csv
import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))


def sig(x: float, n: int = 12) -> float:
    if x == 0 or not math.isfinite(x):
        return x
    return float(f"{x:.{n}g}")


def simpson(f, a: float, b: float, n: int = 2000) -> float:
    if n % 2:
        n += 1
    h = (b - a) / n
    s = f(a) + f(b)
    for i in range(1, n):
        s += (4 if i % 2 else 2) * f(a + i * h)
    return s * h / 3.0


# ----------------------------------------------------------------------------------------------------------
# Closed forms
# ----------------------------------------------------------------------------------------------------------
def restrained(E, a, dT, nu):
    return -E * a * dT, -E * a * dT / (1 - nu), -E * a * dT / (1 - 2 * nu)


def bimetal_timoshenko(t1, t2, E1, E2, a1, a2, dT):
    m, n, h = t1 / t2, E1 / E2, t1 + t2
    return 6 * (a2 - a1) * dT * (1 + m) ** 2 / (h * (3 * (1 + m) ** 2 + (1 + m * n) * (m * m + 1 / (m * n))))


def bimetal_equilibrium(t1, t2, E1, E2, a1, a2, dT):
    """Layer 1 on top of layer 2? Here layer 1 occupies z in [0, t1], layer 2 z in [-t2, 0] (unit width, beam theory).
    Strain e(z) = e0 + k z; stress_i = E_i (e0 + k z - a_i dT). Solve N = 0, M = 0 for (e0, k). Positive k bends
    towards layer 1 (layer 2 longer when a2 > a1 and dT > 0)."""
    A1, A2 = E1 * t1, E2 * t2
    S1, S2 = E1 * t1 * t1 / 2.0, -E2 * t2 * t2 / 2.0          # int E z dz
    I1, I2 = E1 * t1**3 / 3.0, E2 * t2**3 / 3.0                # int E z^2 dz
    # N: (A1 + A2) e0 + (S1 + S2) k = (A1 a1 + A2 a2) dT ; M: (S1 + S2) e0 + (I1 + I2) k = (S1 a1 + S2 a2) dT
    a11, a12, b1 = A1 + A2, S1 + S2, (A1 * a1 + A2 * a2) * dT
    a21, a22, b2 = S1 + S2, I1 + I2, (S1 * a1 + S2 * a2) * dT
    det = a11 * a22 - a12 * a21
    k = (a11 * b2 - a21 * b1) / det
    return -k  # sign convention: curvature with the high-expansion layer (2, below) on the convex side reported positive


def thick_cylinder(E, nu, alpha, a, b, Ta, r):
    L = math.log(b / a)
    T = lambda x: Ta * math.log(b / x) / L  # noqa: E731

    def I(x: float) -> float:  # closed form of int_a^x T r dr
        return Ta / L * ((x * x / 2) * math.log(b / x) + x * x / 4 - (a * a / 2) * math.log(b / a) - a * a / 4)

    c = E * alpha / (1 - nu)
    Ib = I(b)
    st = c / (r * r) * ((r * r + a * a) / (b * b - a * a) * Ib + I(r) - T(r) * r * r)
    sr = c / (r * r) * ((r * r - a * a) / (b * b - a * a) * Ib - I(r))
    sz = c * (2 * Ib / (b * b - a * a) - T(r))
    Iq = simpson(lambda x: T(x) * x, a, r) if r > a else 0.0
    st_q = c / (r * r) * ((r * r + a * a) / (b * b - a * a) * simpson(lambda x: T(x) * x, a, b) + Iq - T(r) * r * r)
    return st, sr, sz, st_q


def thick_cylinder_classic(E, nu, alpha, a, b, Ta, r):
    """Timoshenko & Goodier explicit log form (independent algebra, for the cross-check)."""
    L = math.log(b / a)
    k = E * alpha * Ta / (2 * (1 - nu) * L)
    q = a * a / (b * b - a * a)
    st = k * (1 - math.log(b / r) - q * (1 + b * b / (r * r)) * L)
    sr = k * (-math.log(b / r) - q * (1 - b * b / (r * r)) * L)
    sz = k * (1 - 2 * math.log(b / r) - 2 * q * L)
    return st, sr, sz


def diameter_at(D, alpha_sec, T, Tspec):
    return D * (1 + alpha_sec * (T - Tspec))


def shrink_pressure(dr, b, c, Eh, nuh, Es, nus):
    return dr / (b * (((c * c + b * b) / (c * c - b * b) + nuh) / Eh + (1 - nus) / Es))


def case(cid, quantity, value, unit, tol, source, grade, proves, **extra):
    c = {"id": cid, "quantity": quantity, "value": value, "unit": unit, "tolerance": tol, "source": source, "grade": grade, "proves": proves}
    c.update(extra)
    return c


def main() -> None:
    cases = []

    # VC-TMC-01 restrained bar / plate / block (test inputs)
    r_in = {"E_MPa": 210000.0, "nu": 0.3, "alpha_per_K": 1.2e-5, "dT_K": 100.0}
    s1, s2, s3 = restrained(r_in["E_MPa"], r_in["alpha_per_K"], r_in["dT_K"], r_in["nu"])
    cases.append(case("VC-TMC-01.a", "fully restrained bar (uniaxial), axial stress", sig(s1), "MPa", {"rel": 0.005}, "generator (S9 formula)", "A",
                      ["FR-TMC-01", "FR-TMC-03", "TR-TMC-11"], inputs=r_in, derivation="s = -E alpha dT"))
    cases.append(case("VC-TMC-01.b", "edge-restrained plate (biaxial), in-plane stress", sig(s2), "MPa", {"rel": 0.005}, "generator (S9 formula)", "A",
                      ["FR-TMC-01", "TR-TMC-11"], inputs=r_in, derivation="s = -E alpha dT / (1 - nu)"))
    cases.append(case("VC-TMC-01.c", "fully restrained block (triaxial), hydrostatic stress", sig(s3), "MPa", {"rel": 0.005}, "generator (S9 formula)", "A",
                      ["FR-TMC-01", "TR-TMC-11"], inputs=r_in, derivation="s = -E alpha dT / (1 - 2 nu)"))

    # VC-TMC-02 NAFEMS LE11
    cases.append(case("VC-TMC-02", "NAFEMS LE11: sigma_zz at point A", -105.0, "MPa", {"rel": 0.03},
                      "S1 (Abaqus LE11) + S2 (Altair OS-V:0070) + S3 (FeenoX -105.041, git)", "A", ["FR-TMC-01", "FR-TMC-02", "TR-TMC-10", "TR-TMC-12"],
                      inputs={"E_MPa": 210000.0, "nu": 0.3, "alpha_per_degC": 2.3e-4, "temperature": "T(x, y, z) = sqrt(x^2 + y^2) + z  [degC, x y z in m]",
                              "pointA_m": [1.0, 0.0, 0.0], "geometry": "FeenoX examples/nafems-le11.geo (pinned in sources.md)", "referenceTemperature_degC": 0.0},
                      quotedBySource={"FeenoX_hex27": -104.8, "FeenoX_tet10": -105.9, "FeenoX_doc": -105.041, "Abaqus_C3D20_fine": -103.3},
                      note="the temperature field is prescribed analytically (thermo_static with a field expression or a PHY-03 result); stress-free reference 0 degC"))

    # VC-TMC-03 NAFEMS T1 (FeenoX statement): hot disc inclusion, plane stress
    t1 = {"E_MPa": 100000.0, "nu": 0.3, "alpha_hot_per_K": 1.0e-3, "alpha_bulk_per_K": 0.0, "dT_K": 1.0, "a_mm": 1.0, "plate_halfwidth_mm": 10.0, "probe_mm": [1.005, 0.0]}
    eadt = t1["E_MPa"] * t1["alpha_hot_per_K"] * t1["dT_K"]
    cases.append(case("VC-TMC-03.a", "NAFEMS T1: hoop stress just outside the hot disc (r -> a+)", sig(eadt / 2), "MPa", {"rel": 0.02},
                      "generator (inclusion closed form, S9) + S3 (FeenoX test answer 50)", "A", ["FR-TMC-01", "FR-TMC-04", "TR-TMC-11"], inputs=t1,
                      derivation="st(a+) = E alpha dT / 2 (same E and nu inside and outside; infinite plate)"))
    cases.append(case("VC-TMC-03.b", "NAFEMS T1: sigma_y at the FeenoX probe (1.005, 0) mm", sig(eadt / 2 / 1.005**2), "MPa", {"rel": 0.02},
                      "generator", "A", ["FR-TMC-04"], inputs=t1, derivation="st(r) = E alpha dT a^2 / (2 r^2)",
                      note="finite 20 x 20 mm plate: the (a/W)^2 correction is below 1 %; FeenoX accepts 50 +/- 0.1"))
    cases.append(case("VC-TMC-03.c", "NAFEMS T1: stress inside the hot disc", sig(-eadt / 2), "MPa", {"rel": 0.02}, "generator", "A", ["FR-TMC-04"], inputs=t1,
                      derivation="sr = st = -E alpha dT / 2"))

    # VC-TMC-04 bimetal strip (test inputs)
    bm = {"t1_mm": 0.5, "t2_mm": 0.5, "E1_MPa": 200000.0, "E2_MPa": 100000.0, "alpha1_per_K": 1.2e-5, "alpha2_per_K": 1.9e-5, "dT_K": 100.0, "L_mm": 50.0}
    kt = bimetal_timoshenko(bm["t1_mm"], bm["t2_mm"], bm["E1_MPa"], bm["E2_MPa"], bm["alpha1_per_K"], bm["alpha2_per_K"], bm["dT_K"])
    ke = bimetal_equilibrium(bm["t1_mm"], bm["t2_mm"], bm["E1_MPa"], bm["E2_MPa"], bm["alpha1_per_K"], bm["alpha2_per_K"], bm["dT_K"])
    cases.append(case("VC-TMC-04.a", "bimetal strip curvature (Timoshenko 1925)", sig(kt), "1/mm", {"rel": 0.02},
                      "generator (S4 closed form) + independent equilibrium solve", "A", ["FR-TMC-05", "TR-TMC-13"], inputs=bm,
                      equilibriumSolve=sig(ke), derivation="1/rho = 6 (a2 - a1) dT (1+m)^2 / (h [3 (1+m)^2 + (1+mn)(m^2 + 1/(mn))])"))
    cases.append(case("VC-TMC-04.b", "bimetal cantilever tip deflection", sig(kt * bm["L_mm"] ** 2 / 2), "mm", {"rel": 0.03}, "generator", "A",
                      ["FR-TMC-05", "FR-TMC-08"], inputs=bm, derivation="w = kappa L^2 / 2 (small deflection)"))

    # VC-TMC-05 thick cylinder (test inputs)
    tc = {"a_mm": 10.0, "b_mm": 20.0, "Ta_minus_Tb_K": 100.0, "E_MPa": 200000.0, "nu": 0.3, "alpha_per_K": 1.2e-5, "ends": "free (generalised plane strain)"}
    args = (tc["E_MPa"], tc["nu"], tc["alpha_per_K"], tc["a_mm"], tc["b_mm"], tc["Ta_minus_Tb_K"])
    st_a, sr_a, sz_a, stq_a = thick_cylinder(*args, tc["a_mm"])
    st_b, sr_b, sz_b, stq_b = thick_cylinder(*args, tc["b_mm"])
    cl_a = thick_cylinder_classic(*args, tc["a_mm"])
    cl_b = thick_cylinder_classic(*args, tc["b_mm"])
    cases.append(case("VC-TMC-05.a", "thick cylinder, radial gradient: hoop stress at the bore", sig(st_a), "MPa", {"rel": 0.02},
                      "generator (integral form + T&G log form + Simpson quadrature, S9)", "A", ["FR-TMC-06", "TR-TMC-14"], inputs=tc,
                      crossChecks={"classicLogForm": sig(cl_a[0]), "quadrature": sig(stq_a)}))
    cases.append(case("VC-TMC-05.b", "thick cylinder, radial gradient: hoop stress at the outer surface", sig(st_b), "MPa", {"rel": 0.02}, "generator", "A",
                      ["FR-TMC-06", "TR-TMC-14"], inputs=tc, crossChecks={"classicLogForm": sig(cl_b[0]), "quadrature": sig(stq_b)}))
    cases.append(case("VC-TMC-05.c", "thick cylinder, radial gradient: axial stress at the bore (free ends)", sig(sz_a), "MPa", {"rel": 0.02}, "generator", "A",
                      ["FR-TMC-06", "TR-TMC-14"], inputs=tc, crossChecks={"classicLogForm": sig(cl_a[2])},
                      note="sz = sr + st holds for this field; the FE model uses free ends with a uniform axial strain (generalised plane strain) or a long solid with the mid-length section probed"))

    # VC-TMC-06 fit at temperature (limits are explicit test inputs matching ISO 286 20 H7/g6 as quoted by S5)
    fit = {"nominal_mm": 20.0, "hole_limits_mm": [0.0, 0.021], "shaft_limits_mm": [-0.020, -0.007], "fitCode": "H7/g6 (code text only)", "specTemperature_degC": 20.0}
    pairs = [("aluminium_housing_steel_shaft", 23.0e-6, 11.5e-6), ("titanium_housing_steel_shaft", 8.6e-6, 11.5e-6),
             ("steel_housing_aluminium_shaft", 11.5e-6, 23.0e-6), ("cfrp_housing_steel_shaft", 2.0e-6, 11.5e-6)]
    temps = [-55.0, 20.0, 85.0]
    rows = []
    for name, ah, as_ in pairs:
        for T in temps:
            hmin = diameter_at(fit["nominal_mm"] + fit["hole_limits_mm"][0], ah, T, 20.0)
            hmax = diameter_at(fit["nominal_mm"] + fit["hole_limits_mm"][1], ah, T, 20.0)
            smin = diameter_at(fit["nominal_mm"] + fit["shaft_limits_mm"][0], as_, T, 20.0)
            smax = diameter_at(fit["nominal_mm"] + fit["shaft_limits_mm"][1], as_, T, 20.0)
            rows.append((name, ah, as_, T, hmin - smax, hmax - smin))
    def pick(name, T):
        return next(r for r in rows if r[0] == name and r[3] == T)
    al_cold = pick("aluminium_housing_steel_shaft", -55.0)
    al_hot = pick("aluminium_housing_steel_shaft", 85.0)
    st_hot = pick("steel_housing_aluminium_shaft", 85.0)
    common = dict(fit, alpha_note="secant CTEs relative to 20 degC are test inputs (Al 23e-6, steel 11.5e-6, Ti 8.6e-6, CFRP 2e-6 /K), not material claims")
    cases.append(case("VC-TMC-06.a", "Al housing / steel shaft, H7/g6 20 mm, minimum clearance at -55 degC", sig(al_cold[4]), "mm", {"abs": 1e-7},
                      "generator (S9 linear expansion) with S5 limits", "A", ["FR-TMC-07", "TR-TMC-20"], inputs=dict(common, pair=al_cold[0], T_degC=-55.0),
                      expectedStatus="interference_possible", code="TMC_FIT_INTERFERENCE"))
    cases.append(case("VC-TMC-06.b", "Al housing / steel shaft, H7/g6 20 mm, maximum clearance at +85 degC", sig(al_hot[5]), "mm", {"abs": 1e-7},
                      "generator", "A", ["FR-TMC-07", "TR-TMC-20"], inputs=dict(common, pair=al_hot[0], T_degC=85.0), expectedStatus="clearance"))
    cases.append(case("VC-TMC-06.c", "steel housing / Al shaft, H7/g6 20 mm, minimum clearance at +85 degC", sig(st_hot[4]), "mm", {"abs": 1e-7},
                      "generator", "A", ["FR-TMC-07", "TR-TMC-20"], inputs=dict(common, pair=st_hot[0], T_degC=85.0),
                      expectedStatus="interference_possible", code="TMC_FIT_INTERFERENCE"))
    cases.append(case("VC-TMC-06.d", "20 degC limits reproduce the ISO 286 H7/g6 clearance range 7-41 um", [sig(pick("aluminium_housing_steel_shaft", 20.0)[4]), sig(pick("aluminium_housing_steel_shaft", 20.0)[5])],
                      "mm", {"abs": 1e-9}, "S5 (H7 +21/0 and the 7-41 um range quoted; g6 -7/-20 um consistent)", "B", ["FR-TMC-07", "TR-TMC-20"], inputs=common,
                      note="grade B: g6 deviations for 18-30 mm were not quoted directly by any reached source; they are test inputs here"))

    # VC-TMC-07 secant vs instantaneous CTE (test law)
    law = {"alpha0_per_K": 2.2e-5, "alpha1_per_K2": 1.0e-8, "law": "alpha_inst(T) = alpha0 + alpha1 (T - 20)", "Tref_degC": 20.0, "T_degC": 120.0}
    a_inst = lambda T: law["alpha0_per_K"] + law["alpha1_per_K2"] * (T - 20.0)  # noqa: E731
    sec_20 = simpson(a_inst, 20.0, 120.0) / (120.0 - 20.0)
    sec_0 = simpson(a_inst, 0.0, 120.0) / 120.0
    cases.append(case("VC-TMC-07.a", "secant CTE at 120 degC, reference 20 degC (CalculiX ZERO=20)", sig(sec_20), "1/K", {"rel": 1e-9}, "generator (S7 definition)", "A",
                      ["FR-TMC-09", "TR-TMC-15"], inputs=law, derivation="a_sec = (1/(T - Tref)) int_Tref^T a_inst; closed form a0 + a1 (T - 20)/2"))
    cases.append(case("VC-TMC-07.b", "secant CTE at 120 degC re-referenced to 0 degC (CalculiX ZERO=0)", sig(sec_0), "1/K", {"rel": 1e-9}, "generator (S7 definition)", "A",
                      ["FR-TMC-09", "TR-TMC-15"], inputs=law, derivation="a_sec(T; 0) = (1/T) int_0^T a_inst"))
    cases.append(case("VC-TMC-07.c", "thermal strain from 20 to 120 degC (identical for both references)", sig(sec_20 * 100.0), "1", {"rel": 1e-9}, "generator (S7 strain formula)", "A",
                      ["FR-TMC-09", "TR-TMC-15"], inputs=law,
                      derivation="e_th = a(T)(T - Tref) - a(T0)(T0 - Tref) with T0 = 20; with ZERO=0: a_sec(120;0) 120 - a_sec(20;0) 20", check_ref0=sig(sec_0 * 120.0 - (simpson(a_inst, 0.0, 20.0) / 20.0) * 20.0)))

    # VC-TMC-08 thermal distortion from a through-thickness gradient (test inputs)
    tg = {"alpha_per_K": 2.3e-5, "dT_through_thickness_K": 20.0, "h_mm": 5.0, "L_mm": 500.0}
    kap = tg["alpha_per_K"] * tg["dT_through_thickness_K"] / tg["h_mm"]
    cases.append(case("VC-TMC-08.a", "beam with a linear through-thickness gradient: curvature", sig(kap), "1/mm", {"rel": 0.01}, "generator (S9)", "A",
                      ["FR-TMC-08", "TR-TMC-16"], inputs=tg, derivation="kappa = alpha dT / h"))
    cases.append(case("VC-TMC-08.b", "simply supported span: mid-span thermal bow", sig(kap * tg["L_mm"] ** 2 / 8), "mm", {"rel": 0.02}, "generator (S9)", "A",
                      ["FR-TMC-08", "TR-TMC-16"], inputs=tg, derivation="w = kappa L^2 / 8"))
    cases.append(case("VC-TMC-08.c", "cantilever: tip thermal deflection", sig(kap * tg["L_mm"] ** 2 / 2), "mm", {"rel": 0.02}, "generator (S9)", "A",
                      ["FR-TMC-08", "TR-TMC-16"], inputs=tg, derivation="w = kappa L^2 / 2"))
    cases.append(case("VC-TMC-08.d", "statically determinate beam with a linear gradient: thermal stress", 0.0, "MPa", {"abs": 0.5}, "generator (S9)", "A",
                      ["FR-TMC-08"], inputs=tg, derivation="a linear temperature through the depth of an unrestrained beam produces curvature and no stress"))

    # VC-TMC-09 shrink fit at temperature (test inputs, H7/p6 20 mm limits per S5)
    sf = {"b_mm": 10.0, "c_mm": 20.0, "hole_limits_mm": [0.0, 0.021], "shaft_limits_mm": [0.022, 0.035], "E_hub_MPa": 70000.0, "nu_hub": 0.33,
          "E_shaft_MPa": 200000.0, "nu_shaft": 0.3, "alpha_hub_per_K": 23.0e-6, "alpha_shaft_per_K": 11.5e-6, "specTemperature_degC": 20.0}
    max_int_20 = sf["shaft_limits_mm"][1] - sf["hole_limits_mm"][0]
    p20 = shrink_pressure(max_int_20 / 2, sf["b_mm"], sf["c_mm"], sf["E_hub_MPa"], sf["nu_hub"], sf["E_shaft_MPa"], sf["nu_shaft"])
    dT = 85.0 - 20.0
    max_int_85 = max_int_20 - 2 * sf["b_mm"] * (sf["alpha_hub_per_K"] - sf["alpha_shaft_per_K"]) * dT
    min_int_85 = (sf["shaft_limits_mm"][0] - sf["hole_limits_mm"][1]) - 2 * sf["b_mm"] * (sf["alpha_hub_per_K"] - sf["alpha_shaft_per_K"]) * dT
    cases.append(case("VC-TMC-09.a", "Al hub on steel shaft, 20 H7/p6, contact pressure at maximum interference, 20 degC", sig(p20), "MPa", {"rel": 0.01},
                      "generator (Lame, S9) with S5 limits", "A", ["FR-TMC-10", "TR-TMC-21"], inputs=sf,
                      derivation="p = d_r / (b [((c^2+b^2)/(c^2-b^2) + nu_h)/E_h + (1 - nu_s)/E_s]), d_r = 0.035/2 mm"))
    cases.append(case("VC-TMC-09.b", "same fit at +85 degC: maximum diametral interference", sig(max_int_85), "mm", {"abs": 1e-7}, "generator", "A",
                      ["FR-TMC-07", "FR-TMC-10", "TR-TMC-20"], inputs=sf, derivation="i(T) = i(20) - D (a_hub - a_shaft)(T - 20)"))
    cases.append(case("VC-TMC-09.c", "same fit at +85 degC: minimum diametral interference (negative = clearance, joint loose)", sig(min_int_85), "mm", {"abs": 1e-7}, "generator", "A",
                      ["FR-TMC-07", "FR-TMC-10", "TR-TMC-20"], inputs=sf, expectedStatus="clearance_possible", code="TMC_FIT_LOOSE"))

    # agent-first
    cases.append(case("VC-TMC-60", "no silent reference temperature", None, "-", {"exact": True}, "AF-31", "A", ["FR-TMC-11", "TR-TMC-30"],
                      expected={"thermo_static without referenceTemperature": "TMC_REFERENCE_TEMPERATURE_MISSING",
                                "fit_at_temperature without specTemperature": "TMC_SPEC_TEMPERATURE_MISSING"}))
    cases.append(case("VC-TMC-61", "deliberately wrong set-ups return stable codes", None, "-", {"exact": True}, "TECHNICAL_SPEC 7.1", "A", ["FR-TMC-12", "TR-TMC-31"],
                      expected=[{"setup": "thermo_static referencing a stale heat_steady result", "code": "TMC_THERMAL_RESULT_STALE"},
                                {"setup": "thermo_static referencing a result whose mesh differs and no mapping allowed", "code": "TMC_MESH_MISMATCH"},
                                {"setup": "part material has no cte", "code": "TMC_MATERIAL_NO_CTE"},
                                {"setup": "cte table given as instantaneous but no reference temperature", "code": "TMC_CTE_BASIS_UNKNOWN"},
                                {"setup": "fit_at_temperature on a size dimension without limits", "code": "TMC_FIT_LIMITS_MISSING"},
                                {"setup": "fit_at_temperature temperature outside the cte table range", "code": "TMC_PROPERTY_OUT_OF_RANGE"},
                                {"setup": "agent calls dispose_fit_result", "code": "TMC_HUMAN_GATE"}]))
    cases.append(case("VC-TMC-62", "fit result flags", None, "-", {"exact": True}, "AF-32, AF-33, AF-35", "A", ["FR-TMC-07", "FR-TMC-13", "TR-TMC-20"],
                      expected={"rows[*].reviewRequired": True, "rows[*].provenance.formula": "D(T) = D_spec (1 + a_sec (T - T_spec))",
                                "rows[*].unverified": "OR of the cte inputs' flags", "status of VC-TMC-06.a": "interference_possible"}))

    data = {"pack": "04-thermo-mechanical", "generatedBy": "generate_thermomech_reference.py", "cases": cases}
    with open(os.path.join(HERE, "expected_results.json"), "w", encoding="utf-8", newline="\n") as fh:
        json.dump(data, fh, indent=1, ensure_ascii=False)
        fh.write("\n")

    with open(os.path.join(HERE, "fit_at_temperature.csv"), "w", encoding="utf-8", newline="") as fh:
        wr = csv.writer(fh, lineterminator="\n")
        wr.writerow(["pair", "alpha_hole_per_K", "alpha_shaft_per_K", "T_degC", "min_clearance_mm", "max_clearance_mm", "status"])
        for name, ah, as_, T, cmin, cmax in rows:
            status = "clearance" if cmin >= 0 else ("interference" if cmax < 0 else "interference_possible")
            wr.writerow([name, ah, as_, T, sig(cmin, 9), sig(cmax, 9), status])

    with open(os.path.join(HERE, "thick_cylinder_profile.csv"), "w", encoding="utf-8", newline="") as fh:
        wr = csv.writer(fh, lineterminator="\n")
        wr.writerow(["r_mm", "T_K_above_outer", "sigma_r_MPa", "sigma_theta_MPa", "sigma_z_MPa", "sigma_theta_quadrature_MPa"])
        for i in range(0, 11):
            r = tc["a_mm"] + i * (tc["b_mm"] - tc["a_mm"]) / 10
            st, sr, sz, stq = thick_cylinder(*args, r)
            T = tc["Ta_minus_Tb_K"] * math.log(tc["b_mm"] / r) / math.log(tc["b_mm"] / tc["a_mm"])
            wr.writerow([sig(r, 9), sig(T, 9), sig(sr, 9), sig(st, 9), sig(sz, 9), sig(stq, 9)])

    with open(os.path.join(HERE, "cte_conversion.csv"), "w", encoding="utf-8", newline="") as fh:
        wr = csv.writer(fh, lineterminator="\n")
        wr.writerow(["T_degC", "alpha_instantaneous_per_K", "alpha_secant_ref20_per_K", "alpha_secant_ref0_per_K", "thermal_strain_from_20"])
        for T in (-55.0, 0.0, 50.0, 85.0, 120.0, 200.0):
            s20 = (law["alpha0_per_K"] + law["alpha1_per_K2"] * (T - 20.0) / 2.0) if T != 20.0 else law["alpha0_per_K"]
            s0 = simpson(a_inst, 0.0, T) / T if T != 0.0 else a_inst(0.0)
            wr.writerow([T, sig(a_inst(T), 9), sig(s20, 9), sig(s0, 9), sig(s20 * (T - 20.0), 9)])


if __name__ == "__main__":
    main()
