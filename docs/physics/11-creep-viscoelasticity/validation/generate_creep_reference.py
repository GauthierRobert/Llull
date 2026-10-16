#!/usr/bin/env python3
"""
Generate the analytic reference datasets of PHY-11 (creep, stress relaxation, viscoelastic time response).

Run:  python3 -I generate_creep_reference.py      (stdlib only, deterministic, writes next to this script)

Outputs
  expected_results.json                 expected values in the docs/physics/README.md section 6.3 schema
  norton_relaxation_curve.csv           sigma(t) of a bar held at fixed total strain (Norton), plus bolt variant
  thick_cylinder_stationary_creep.csv   stationary (steady-state) Norton creep stresses in a thick tube, n = 1, 3, 5, 10
  beam_stationary_creep.csv             stationary creep bending stress profile of a rectangular beam, n = 1, 3, 5, 10
  viscoelastic_sls.csv                  standard linear solid: relaxation modulus E(t) and creep compliance J(t)
  wlf_shift.csv                         WLF shift factor log10(aT) for the "universal" constants, T - Tr = 0..100 K

Every formula is derived in a docstring below; sources are ids of validation/sources.md ([Sx]).
Input numbers marked "test input" are chosen for the validation case only; they are NOT material data.
Tolerances are llull acceptance choices (validation/README.md), not claims of any source.
"""

from __future__ import annotations

import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
PACK = "11-creep-viscoelasticity"


def out(name: str) -> str:
    return os.path.join(HERE, name)


def sig(x: float, n: int = 12) -> float:
    """Round to n significant digits (README section 6.3: 12 significant digits)."""
    if x == 0 or not math.isfinite(x):
        return x
    return float(f"{x:.{n}g}")


def fmt(x: float) -> str:
    return f"{sig(x):.12g}"


CASES: list[dict] = []


def case(cid: str, quantity: str, value: float, unit: str, tol: dict, source: str, grade: str, proves: list[str],
         derivation: str, inputs: dict | None = None, cross_check: dict | None = None) -> None:
    c = {"id": cid, "quantity": quantity, "value": sig(value), "unit": unit, "tolerance": tol, "source": source,
         "grade": grade, "proves": proves, "derivation": derivation}
    if inputs is not None:
        c["inputs"] = inputs
    if cross_check is not None:
        c["cross_check"] = cross_check
    CASES.append(c)


# ---------------------------------------------------------------------------------------------------------
# 1. Uniaxial Norton creep at constant stress  [S1 CalculiX *CREEP: eps_dot = A sigma^n t^m]
#    eps_cr(t) = A sigma^n t^(m+1) / (m+1)        (m > -1; m = 0 gives A sigma^n t)
# ---------------------------------------------------------------------------------------------------------
def norton_strain(A: float, n: float, m: float, s: float, t: float) -> float:
    return A * s**n * t ** (m + 1.0) / (m + 1.0)


A1, N1, S1, T1 = 1.0e-10, 5.0, 20.0, 1000.0  # CalculiX test/beamcr3.inp (unit cube, 20 MPa, 1000 s)
case("VC-CRP-10", "equivalent creep strain, uniaxial Norton, constant stress, t = 1000 s", norton_strain(A1, N1, 0.0, S1, T1),
     "-", {"rel": 0.005}, "S1 (CalculiX manual *CREEP) + S2 (beamcr3.frd.ref)", "A", ["FR-CRP-02", "FR-CRP-05", "TR-CRP-20"],
     "eps = A sigma^n t, A = 1e-10 MPa^-5 s^-1, n = 5, m = 0, sigma = 20 MPa",
     {"A_per_MPa5_s": A1, "n": N1, "m": 0.0, "sigma_MPa": S1, "t_s": T1},
     {"calculix_beamcr3_frd_PE_min": 0.319987, "calculix_beamcr3_frd_PE_max": 0.320016,
      "calculix_beamcr3_frd_Szz_MPa": 19.9992, "note": "block PE (requested as CEEQ) at step time 1000 of test/beamcr3.frd.ref"})

M2 = -0.5  # test input: time-hardening exponent
case("VC-CRP-11", "equivalent creep strain, Norton time hardening m = -0.5, t = 1000 s", norton_strain(A1, N1, M2, S1, T1), "-",
     {"rel": 0.01}, "S1 (law form) + derivation", "A", ["FR-CRP-02", "TR-CRP-20"],
     "eps = A sigma^n t^(m+1) / (m+1)", {"A_per_MPa5_s": A1, "n": N1, "m": M2, "sigma_MPa": S1, "t_s": T1})


# ---------------------------------------------------------------------------------------------------------
# 2. Stress relaxation at fixed total strain (Norton, m = 0)
#    eps_total = sigma/E + eps_cr = const  ->  sigma_dot = -E A sigma^n
#    -> sigma(t) = [sigma0^(1-n) + (n-1) E A t]^(1/(1-n))
#    time to reach a fraction f of sigma0: t_f = sigma0^(1-n) (f^(1-n) - 1) / ((n-1) E A)
#    Bolt in series with clamped members of stiffness k_m (total length fixed):
#    sigma_dot (L_b/E + A_s/k_m) = -L_b A sigma^n  ->  same law with E' = E k_m / (k_m + k_b), k_b = E A_s / L_b
# ---------------------------------------------------------------------------------------------------------
def relax(s0: float, E: float, A: float, n: float, t: float) -> float:
    return (s0 ** (1.0 - n) + (n - 1.0) * E * A * t) ** (1.0 / (1.0 - n))


def time_to_fraction(s0: float, E: float, A: float, n: float, f: float) -> float:
    return s0 ** (1.0 - n) * (f ** (1.0 - n) - 1.0) / ((n - 1.0) * E * A)


E_R, A_R, N_R, S0_R = 200000.0, 1.0e-18, 5.0, 100.0  # test inputs (MPa, MPa^-5 s^-1, -, MPa)
case("VC-CRP-12.a", "relaxed stress of a bar at fixed strain after 3600 s", relax(S0_R, E_R, A_R, N_R, 3600.0), "MPa",
     {"rel": 0.005}, "derivation (closed form)", "A", ["FR-CRP-03", "TR-CRP-21"],
     "sigma = [sigma0^(1-n) + (n-1) E A t]^(1/(1-n))", {"E_MPa": E_R, "A_per_MPa5_s": A_R, "n": N_R, "sigma0_MPa": S0_R, "t_s": 3600.0})
case("VC-CRP-12.b", "time for the bar stress to relax to 50 % of sigma0", time_to_fraction(S0_R, E_R, A_R, N_R, 0.5), "s",
     {"rel": 0.01}, "derivation (closed form)", "A", ["FR-CRP-03", "TR-CRP-21"],
     "t_f = sigma0^(1-n) (f^(1-n) - 1) / ((n-1) E A), f = 0.5", {"E_MPa": E_R, "A_per_MPa5_s": A_R, "n": N_R, "sigma0_MPa": S0_R})

KB_OVER_KM = 1.0 / 3.0  # test input: bolt stiffness / member stiffness
E_EFF = E_R / (1.0 + KB_OVER_KM)
case("VC-CRP-13.a", "bolt preload remaining after 1e6 s (k_b/k_m = 1/3)", relax(S0_R, E_EFF, A_R, N_R, 1.0e6) / S0_R, "-",
     {"rel": 0.005}, "derivation (closed form, series springs)", "A", ["FR-CRP-04", "TR-CRP-21"],
     "F/F0 = sigma/sigma0 with E' = E k_m / (k_m + k_b)", {"E_MPa": E_R, "A_per_MPa5_s": A_R, "n": N_R, "sigma0_MPa": S0_R,
                                                           "kb_over_km": KB_OVER_KM, "t_s": 1.0e6})
case("VC-CRP-13.b", "same bolt, rigid members (k_m -> infinity), preload remaining after 1e6 s",
     relax(S0_R, E_R, A_R, N_R, 1.0e6) / S0_R, "-", {"rel": 0.005}, "derivation (closed form)", "A", ["FR-CRP-04"],
     "F/F0 with E' = E (rigid members relax fastest)", {"E_MPa": E_R, "A_per_MPa5_s": A_R, "n": N_R, "sigma0_MPa": S0_R, "t_s": 1.0e6})


# ---------------------------------------------------------------------------------------------------------
# 3. Stationary (steady-state) creep of a thick cylinder, internal pressure p, plane strain, Norton exponent n
#    Incompressible creep, compatibility -> eps_theta_dot ~ r^-2 -> sigma_eq ~ r^(-2/n). Equilibrium
#    d sigma_r/dr = (sigma_t - sigma_r)/r with sigma_r = C1 + C2 r^(-2/n), sigma_r(a) = -p, sigma_r(b) = 0:
#      sigma_r = -p [(b/r)^(2/n) - 1] / [(b/a)^(2/n) - 1]
#      sigma_t =  p [1 + (2/n - 1)(b/r)^(2/n)] / [(b/a)^(2/n) - 1]
#      sigma_z = (sigma_r + sigma_t)/2,  sigma_eq = (sqrt(3)/2)(sigma_t - sigma_r) = (sqrt(3)/n) p (b/r)^(2/n) / [(b/a)^(2/n) - 1]
#    n = 1 recovers Lame. Geometry a = 0.16 m, b = 0.25 m as in the COMSOL / NAFEMS elastoplastic-creep tube [S5, S6].
# ---------------------------------------------------------------------------------------------------------
def tube(p: float, a: float, b: float, n: float, r: float) -> tuple[float, float, float, float]:
    k = 2.0 / n
    den = (b / a) ** k - 1.0
    q = (b / r) ** k
    sr = -p * (q - 1.0) / den
    st = p * (1.0 + (k - 1.0) * q) / den
    sz = 0.5 * (sr + st)
    seq = math.sqrt(3.0) / 2.0 * (st - sr)
    return sr, st, sz, seq


P_T, A_T, B_T = 10.0, 0.16, 0.25  # MPa (test input), m, m
for n_ in (5.0,):
    sr_a, st_a, sz_a, se_a = tube(P_T, A_T, B_T, n_, A_T)
    sr_b, st_b, sz_b, se_b = tube(P_T, A_T, B_T, n_, B_T)
    inp = {"p_MPa": P_T, "a_m": A_T, "b_m": B_T, "n": n_}
    case("VC-CRP-14.a", "stationary creep hoop stress at the bore r = a (n = 5)", st_a, "MPa", {"rel": 0.03},
         "derivation (closed form)", "A", ["FR-CRP-06", "TR-CRP-22"], "sigma_t(a), see generator section 3", inp)
    case("VC-CRP-14.b", "stationary creep hoop stress at the outer surface r = b (n = 5)", st_b, "MPa", {"rel": 0.03},
         "derivation (closed form)", "A", ["FR-CRP-06", "TR-CRP-22"], "sigma_t(b)", inp)
    case("VC-CRP-14.c", "stationary creep von Mises stress at the bore r = a (n = 5)", se_a, "MPa", {"rel": 0.03},
         "derivation (closed form)", "A", ["FR-CRP-06", "TR-CRP-22"], "sigma_eq = (sqrt 3 / n) p (b/r)^(2/n) / ((b/a)^(2/n) - 1)", inp)
sr1, st1, _, _ = tube(P_T, A_T, B_T, 1.0, A_T)
case("VC-CRP-14.d", "n = 1 limit: Lame elastic hoop stress at the bore", st1, "MPa", {"rel": 1e-12},
     "derivation (Lame)", "A", ["TR-CRP-22"], "p (b^2 + a^2) / (b^2 - a^2)", {"p_MPa": P_T, "a_m": A_T, "b_m": B_T, "n": 1.0},
     {"lame_closed_form_MPa": sig(P_T * (B_T**2 + A_T**2) / (B_T**2 - A_T**2))})


# ---------------------------------------------------------------------------------------------------------
# 4. Stationary creep bending of a rectangular beam b x h under moment M (Norton n, same law in tension and compression)
#    plane sections -> eps_dot ~ y -> sigma ~ |y|^(1/n). M = int sigma y dA ->
#      sigma(y) = M |y|^(1/n) sign(y) / I_n,  I_n = 2 b (h/2)^(2 + 1/n) / (2 + 1/n)
#      sigma_max = (2n + 1)/(3n) * 6 M / (b h^2)        (n = 1 -> elastic 6M/(bh^2))
# ---------------------------------------------------------------------------------------------------------
def beam_sigma(M: float, b: float, h: float, n: float, y: float) -> float:
    In = 2.0 * b * (h / 2.0) ** (2.0 + 1.0 / n) / (2.0 + 1.0 / n)
    return math.copysign(M * abs(y) ** (1.0 / n) / In, y)


M_B, B_B, H_B = 1.0e5, 10.0, 20.0  # N mm, mm, mm (test inputs)
case("VC-CRP-15.a", "stationary creep outer-fibre bending stress (n = 5)", beam_sigma(M_B, B_B, H_B, 5.0, H_B / 2.0), "MPa",
     {"rel": 0.03}, "derivation (closed form)", "A", ["FR-CRP-06", "TR-CRP-22"], "sigma_max = (2n+1)/(3n) 6M/(bh^2)",
     {"M_Nmm": M_B, "b_mm": B_B, "h_mm": H_B, "n": 5.0}, {"elastic_outer_fibre_MPa": sig(6 * M_B / (B_B * H_B**2))})
case("VC-CRP-15.b", "stationary creep bending stress at y = h/4 (n = 5)", beam_sigma(M_B, B_B, H_B, 5.0, H_B / 4.0), "MPa",
     {"rel": 0.03}, "derivation (closed form)", "A", ["FR-CRP-06"], "sigma(y) = M y^(1/n) / I_n", {"M_Nmm": M_B, "b_mm": B_B, "h_mm": H_B, "n": 5.0})


# ---------------------------------------------------------------------------------------------------------
# 5. Larson-Miller parameter  [S7 Larson & Miller 1952 via NEML docs; S8 reliability library: C default 20, "20-22 for metals"]
#    LMP = T (C + log10 t_r), T in K, t_r in h. Iso-LMP extrapolation: t_r2 = 10^(LMP / T2 - C)
# ---------------------------------------------------------------------------------------------------------
T_L1, TR_L1, C_L, T_L2 = 800.0, 1000.0, 20.0, 850.0  # test inputs (K, h, -, K)
LMP = T_L1 * (C_L + math.log10(TR_L1))
case("VC-CRP-20.a", "Larson-Miller parameter, T = 800 K, t_r = 1000 h, C = 20", LMP, "K", {"rel": 1e-12},
     "S7 (definition) + S8 (C = 20 convention)", "A", ["FR-CRP-08", "TR-CRP-30"], "LMP = T (C + log10 t_r)",
     {"T_K": T_L1, "tr_h": TR_L1, "C": C_L})
TR2 = 10.0 ** (LMP / T_L2 - C_L)
case("VC-CRP-20.b", "iso-LMP rupture time at 850 K (same stress)", TR2, "h", {"rel": 1e-9},
     "S7 + S8", "A", ["FR-CRP-08", "TR-CRP-30"], "t_r2 = 10^(LMP / T2 - C)", {"T1_K": T_L1, "tr1_h": TR_L1, "T2_K": T_L2, "C": C_L},
     {"reliability_0_9_0_creep_failure_time": "same formula in degF/Rankine (temp_low=980.33 F, temp_high=1070.33 F, time_low=1000); "
      "Rankine = 1.8 K so the ratio, and t_r2, are unchanged"})
LIFE = [(500.0, 1000.0), (200.0, 400.0)]  # (hours spent, rupture hours at that condition): test inputs
case("VC-CRP-21", "time-fraction creep damage sum (linear summation)", sum(h / tr for h, tr in LIFE), "-", {"abs": 1e-12},
     "S9 (ASME III-5 linear damage summation, scope only)", "B", ["FR-CRP-09"], "D = sum t_i / t_r,i",
     {"blocks_hours_and_rupture_hours": LIFE})


# ---------------------------------------------------------------------------------------------------------
# 6. Linear viscoelasticity (Prony / Maxwell / Kelvin / standard linear solid)  [S10 MFront GeneralizedMaxwell; textbook]
#    Generalized Maxwell (Prony): E(t) = E_inf + sum E_i exp(-t/tau_i)
#    Standard linear solid (one term): E0 = E_inf + E1,
#      J(t) = 1/E_inf - (E1 / (E0 E_inf)) exp(-t / tau_c),  tau_c = tau E0 / E_inf   (retardation time)
#    Kelvin-Voigt: J(t) = (1 - exp(-t/tau)) / E
#    Interconversion identity: int_0^t E(t - s) dJ(s) + E(t) J(0) = 1 (checked numerically below).
# ---------------------------------------------------------------------------------------------------------
def prony_E(Einf: float, terms: list[tuple[float, float]], t: float) -> float:
    return Einf + sum(Ei * math.exp(-t / ti) for Ei, ti in terms)


def sls_J(Einf: float, E1: float, tau: float, t: float) -> float:
    E0 = Einf + E1
    return 1.0 / Einf - E1 / (E0 * Einf) * math.exp(-t * Einf / (tau * E0))


EINF, E1V, TAUV = 1000.0, 2000.0, 10.0  # MPa, MPa, s (test inputs, polymer-like magnitudes)
case("VC-CRP-30.a", "SLS relaxation modulus at t = tau", prony_E(EINF, [(E1V, TAUV)], TAUV), "MPa", {"rel": 1e-9},
     "derivation", "A", ["FR-CRP-10", "TR-CRP-40"], "E(t) = E_inf + E1 exp(-t/tau)", {"Einf_MPa": EINF, "E1_MPa": E1V, "tau_s": TAUV})
case("VC-CRP-30.b", "SLS creep compliance at t = 10 tau", sls_J(EINF, E1V, TAUV, 10 * TAUV), "1/MPa", {"rel": 1e-9},
     "derivation", "A", ["FR-CRP-10", "TR-CRP-40"], "J(t) = 1/E_inf - E1/(E0 E_inf) exp(-t E_inf/(tau E0))",
     {"Einf_MPa": EINF, "E1_MPa": E1V, "tau_s": TAUV, "t_s": 10 * TAUV})


def interconversion_residual(Einf: float, E1: float, tau: float, t: float, steps: int = 200000) -> float:
    """1 - [E(t) J(0) + int_0^t E(t-s) J'(s) ds], composite Simpson; should be ~0."""
    E0 = Einf + E1
    tc = tau * E0 / Einf

    def dJ(s: float) -> float:
        return E1 / (E0 * Einf) / tc * math.exp(-s / tc)

    h = t / steps
    acc = 0.0
    for i in range(steps + 1):
        s = i * h
        w = 1 if i in (0, steps) else (4 if i % 2 else 2)
        acc += w * prony_E(Einf, [(E1, tau)], t - s) * dJ(s)
    integral = acc * h / 3.0
    return 1.0 - (prony_E(Einf, [(E1, tau)], t) * (1.0 / E0) + integral)


RES = interconversion_residual(EINF, E1V, TAUV, 25.0)
case("VC-CRP-30.c", "SLS interconversion identity residual at t = 25 s", 0.0, "-", {"abs": 1e-9}, "derivation", "A",
     ["TR-CRP-40"], "1 - [E(t) J(0) + int E(t-s) dJ(s)]; generator value below", None, {"generator_residual": float(f"{RES:.3e}")})
case("VC-CRP-31", "Kelvin-Voigt creep compliance at t = tau", (1.0 - math.exp(-1.0)) / 1000.0, "1/MPa", {"rel": 1e-9},
     "derivation", "A", ["FR-CRP-10"], "J = (1 - exp(-t/tau)) / E", {"E_MPa": 1000.0, "tau_s": 10.0, "t_s": 10.0})
PRONY2 = [(1500.0, 1.0), (500.0, 100.0)]  # test inputs (MPa, s)
case("VC-CRP-32", "two-term Prony relaxation modulus at t = 10 s", prony_E(EINF, PRONY2, 10.0), "MPa", {"rel": 1e-9},
     "derivation", "A", ["FR-CRP-10", "TR-CRP-40"], "E(t) = E_inf + sum E_i exp(-t/tau_i)", {"Einf_MPa": EINF, "terms_MPa_s": PRONY2, "t_s": 10.0})


# ---------------------------------------------------------------------------------------------------------
# 7. WLF time-temperature shift  [S11: log10 aT = -C1 (T - Tr)/(C2 + T - Tr); "universal" C1 = 17.44, C2 = 51.6 K at Tr = Tg]
#    Time-temperature superposition: E(t, T) = E_ref(t / aT)
# ---------------------------------------------------------------------------------------------------------
C1U, C2U = 17.44, 51.6


def wlf(dT: float, c1: float = C1U, c2: float = C2U) -> float:
    return -c1 * dT / (c2 + dT)


for sfx, dT in (("a", 10.0), ("b", 50.0)):
    case(f"VC-CRP-33.{sfx}", f"WLF log10 aT at T - Tg = {dT:g} K, universal constants", wlf(dT), "-", {"abs": 1e-9},
         "S11 (constants, search-verified)", "B", ["FR-CRP-11", "TR-CRP-41"], "log10 aT = -C1 dT / (C2 + dT)",
         {"C1": C1U, "C2_K": C2U, "T_minus_Tr_K": dT})
AT = 10.0 ** wlf(10.0)
case("VC-CRP-34", "SLS modulus at T = Tg + 10 K, t = 0.01 s (shifted)", prony_E(EINF, [(E1V, TAUV)], 0.01 / AT), "MPa",
     {"rel": 1e-9}, "derivation + S11", "B", ["FR-CRP-11", "TR-CRP-41"], "E(t, T) = E_ref(t / aT)",
     {"Einf_MPa": EINF, "E1_MPa": E1V, "tau_s": TAUV, "t_s": 0.01, "T_minus_Tr_K": 10.0})


# ---------------------------------------------------------------------------------------------------------
# 8. Unit conversion of the Norton coefficient (TR-CRP-12)
#    eps_dot [1/time] = A sigma^n t^m. Stress unit change sigma_new = c_s sigma_old -> A_new = A_old c_s^-n.
#    Time unit change t_old = c_t t_new (e.g. c_t = 3600 s per h) -> A_new = A_old c_t^(m+1).
# ---------------------------------------------------------------------------------------------------------
case("VC-CRP-16.a", "Norton A converted from MPa^-5 s^-1 to Pa^-5 s^-1", A1 * (1.0e6) ** (-5.0), "Pa^-5 s^-1", {"rel": 1e-12},
     "derivation", "A", ["FR-CRP-23", "TR-CRP-12"], "A_Pa = A_MPa (1e6)^-n", {"A_per_MPa5_s": A1, "n": 5.0})
case("VC-CRP-16.b", "Norton A converted from MPa^-5 s^-1 to MPa^-5 h^-1 (m = 0)", A1 * 3600.0, "MPa^-5 h^-1", {"rel": 1e-12},
     "derivation", "A", ["FR-CRP-23", "TR-CRP-12"], "A_h = A_s 3600^(m+1)", {"A_per_MPa5_s": A1, "m": 0.0})
case("VC-CRP-16.c", "Norton A converted from MPa^-5 s^-1.5 (m = -0.5) to MPa^-5 h^-0.5", A1 * 3600.0**0.5, "MPa^-5 h^-(m+1)",
     {"rel": 1e-12}, "derivation", "A", ["FR-CRP-23", "TR-CRP-12"], "A_h = A_s 3600^(m+1)", {"A": A1, "m": -0.5})


# ---------------------------------------------------------------------------------------------------------
# CSV writers
# ---------------------------------------------------------------------------------------------------------
def write_csv(name: str, header: list[str], rows: list[list[float]]) -> None:
    with open(out(name), "w", encoding="utf-8", newline="\n") as f:
        f.write(",".join(header) + "\n")
        for row in rows:
            f.write(",".join(fmt(v) for v in row) + "\n")


times = [0.0] + [10.0 ** (k / 4.0) for k in range(0, 33)]  # 1 s .. 1e8 s
write_csv("norton_relaxation_curve.csv", ["t_s", "sigma_bar_MPa", "bolt_preload_ratio_kb_km_1_3"],
          [[t, relax(S0_R, E_R, A_R, N_R, t), relax(S0_R, E_EFF, A_R, N_R, t) / S0_R] for t in times])

rows = []
for i in range(0, 19):
    r = A_T + (B_T - A_T) * i / 18.0
    row = [r]
    for n_ in (1.0, 3.0, 5.0, 10.0):
        sr, st, sz, se = tube(P_T, A_T, B_T, n_, r)
        row += [sr, st, sz, se]
    rows.append(row)
hdr = ["r_m"] + [f"{q}_n{int(n_)}_MPa" for n_ in (1, 3, 5, 10) for q in ("sr", "st", "sz", "seq")]
write_csv("thick_cylinder_stationary_creep.csv", hdr, rows)

write_csv("beam_stationary_creep.csv", ["y_over_half_h"] + [f"sigma_over_elastic_max_n{n_}" for n_ in (1, 3, 5, 10)],
          [[k / 10.0] + [beam_sigma(M_B, B_B, H_B, float(n_), k / 10.0 * H_B / 2.0) / (6 * M_B / (B_B * H_B**2))
                         for n_ in (1, 3, 5, 10)] for k in range(0, 11)])

write_csv("viscoelastic_sls.csv", ["t_s", "E_relax_MPa", "J_creep_per_MPa", "E_times_J"],
          [[t, prony_E(EINF, [(E1V, TAUV)], t), sls_J(EINF, E1V, TAUV, t), prony_E(EINF, [(E1V, TAUV)], t) * sls_J(EINF, E1V, TAUV, t)]
           for t in [0.0] + [10.0 ** (k / 4.0) for k in range(-8, 13)]])

write_csv("wlf_shift.csv", ["T_minus_Tr_K", "log10_aT", "aT"], [[float(d), wlf(float(d)), 10.0 ** wlf(float(d))] for d in range(0, 101, 5)])

doc = {"pack": PACK, "generatedBy": "generate_creep_reference.py", "units_note": "every value carries its unit; '-' = dimensionless",
       "cases": CASES}
with open(out("expected_results.json"), "w", encoding="utf-8", newline="\n") as f:
    json.dump(doc, f, indent=1, sort_keys=False, ensure_ascii=False)
    f.write("\n")
