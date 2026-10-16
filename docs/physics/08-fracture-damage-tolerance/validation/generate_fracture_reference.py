#!/usr/bin/env python3
"""
Generate the reference datasets of physics gap PHY-08 (fracture mechanics & damage tolerance).

Run:  python3 -I generate_fracture_reference.py     (stdlib only, deterministic, writes next to this script)

Outputs
  expected_results.json          VC-FRC-* expected values (schema: docs/physics/README.md section 6.3)
  k_solutions_table.csv          beta(a/W) for the center crack (secant) and edge crack (Tada, polynomial)
  newman_raju_table.csv          Newman-Raju surface-crack F at phi = 0 and 90 deg (GRADE C until TM-83200 is checked)
  crack_growth_center_paris.csv  a(N) for the Paris center-crack case, analytic and cycle-by-cycle

Material constants (C, m, Kc, Fty) are TEST INPUTS of the validation cases, not material claims. Formulas cite the
register ids of sources.md ([Sn]). Lengths in m, stresses in MPa, K in MPa*sqrt(m), da/dN in m/cycle.
"""

from __future__ import annotations

import csv
import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))


def out(name: str) -> str:
    return os.path.join(HERE, name)


def sig(x: float, n: int = 12) -> float:
    if x == 0 or not math.isfinite(x):
        return x
    return float(f"{x:.{n}g}")


# -------------------------------------------------------------------------------------------------------------
# 1. K solutions                                                                                 [S1, S2, S3, S4]
# -------------------------------------------------------------------------------------------------------------
def beta_center_secant(a: float, w: float) -> float:
    """Center crack, half-length a, full width W: beta = sqrt(sec(pi a / W))  (Feddersen form)."""
    return math.sqrt(1.0 / math.cos(math.pi * a / w))


def beta_edge_tada(a: float, b: float) -> float:
    """Single edge crack in tension, width b: Tada form (0.5 % for any a/b per S2)."""
    x = math.pi * a / (2.0 * b)
    return math.sqrt(2.0 * b / (math.pi * a) * math.tan(x)) * (0.752 + 2.02 * a / b + 0.37 * (1.0 - math.sin(x)) ** 3) / math.cos(x)


def beta_edge_poly(a: float, b: float) -> float:
    """Single edge crack polynomial (0.5 % for a/b <= 0.6 per S2)."""
    r = a / b
    return 1.122 - 0.231 * r + 10.550 * r ** 2 - 21.710 * r ** 3 + 30.382 * r ** 4


def newman_raju_F(a_c: float, a_t: float, c_b: float, phi: float) -> float:
    """Newman-Raju 1981 surface crack in tension, a/c <= 1. Returns F; K = S sqrt(pi a / Q) F.  [S5] GRADE C."""
    m1 = 1.13 - 0.09 * a_c
    m2 = -0.54 + 0.89 / (0.2 + a_c)
    m3 = 0.5 - 1.0 / (0.65 + a_c) + 14.0 * (1.0 - a_c) ** 24
    g = 1.0 + (0.1 + 0.35 * a_t ** 2) * (1.0 - math.sin(phi)) ** 2
    f_phi = (a_c ** 2 * math.cos(phi) ** 2 + math.sin(phi) ** 2) ** 0.25
    f_w = math.sqrt(1.0 / math.cos(math.pi * c_b * math.sqrt(a_t) / 2.0))  # c/b with b = half-width -> pi c/(2b) sqrt(a/t)
    return (m1 + m2 * a_t ** 2 + m3 * a_t ** 4) * g * f_phi * f_w


def newman_raju_Q(a_c: float) -> float:
    return 1.0 + 1.464 * a_c ** 1.65


# -------------------------------------------------------------------------------------------------------------
# 2. Crack-growth laws                                                                          [S6, S7, S8]
# -------------------------------------------------------------------------------------------------------------
C_PARIS = 1.0e-11   # m/cycle per (MPa sqrt m)^m  -- test input
M_PARIS = 3.0       # test input
KC = 60.0           # MPa sqrt m                  -- test input
FTY = 300.0         # MPa                         -- test input


def paris(dk: float) -> float:
    return C_PARIS * dk ** M_PARIS


def walker(dk: float, r: float, gamma: float) -> float:
    return C_PARIS * (dk / (1.0 - r) ** (1.0 - gamma)) ** M_PARIS


def forman(dk: float, r: float, kc: float) -> float:
    return C_PARIS * dk ** M_PARIS / ((1.0 - r) * kc - dk)


def nasgro(dk: float, r: float, f: float, dk_th: float, kc: float, p: float, q: float) -> float:
    kmax = dk / (1.0 - r)
    if dk <= dk_th or kmax >= kc:
        return 0.0 if dk <= dk_th else math.inf
    return C_PARIS * ((1.0 - f) / (1.0 - r) * dk) ** M_PARIS * (1.0 - dk_th / dk) ** p / (1.0 - kmax / kc) ** q


def newman_closure_f(r: float, alpha: float, smax_s0: float) -> float:
    """Newman (1984) crack-opening function as used in the NASGRO equation (form: GRADE C, see sources.md S7)."""
    a0 = (0.825 - 0.34 * alpha + 0.05 * alpha ** 2) * math.cos(math.pi * smax_s0 / 2.0) ** (1.0 / alpha)
    a1 = (0.415 - 0.071 * alpha) * smax_s0
    a3 = 2.0 * a0 + a1 - 1.0
    a2 = 1.0 - a0 - a1 - a3
    if r >= 0.0:
        return max(r, a0 + a1 * r + a2 * r ** 2 + a3 * r ** 3)
    return a0 + a1 * r


# -------------------------------------------------------------------------------------------------------------
# 3. Life integration
# -------------------------------------------------------------------------------------------------------------
def paris_center_analytic(a0: float, af: float, ds: float) -> float:
    """Infinite plate, Y = 1: N = (a0^(1-m/2) - af^(1-m/2)) / (C (m/2 - 1) (ds sqrt(pi))^m), m != 2."""
    e = 1.0 - M_PARIS / 2.0
    return (a0 ** e - af ** e) / (C_PARIS * (M_PARIS / 2.0 - 1.0) * (ds * math.sqrt(math.pi)) ** M_PARIS)


def paris_center_cycle_by_cycle(a0: float, af: float, ds: float, record_every: int = 0):
    """Explicit cycle-by-cycle sum a_{n+1} = a_n + C dK(a_n)^m; returns cycles to reach af and optional samples."""
    a, n, rows = a0, 0, []
    while a < af:
        a += paris(ds * math.sqrt(math.pi * a))
        n += 1
        if record_every and n % record_every == 0:
            rows.append((n, a))
    return n, rows


def simpson_life(a0: float, af: float, rate, intervals: int = 20000) -> float:
    """N = integral_a0^af da / rate(a), composite Simpson in u = ln a (smooth for power laws)."""
    u0, u1 = math.log(a0), math.log(af)
    h = (u1 - u0) / intervals
    s = 0.0
    for i in range(intervals + 1):
        u = u0 + i * h
        a = math.exp(u)
        w = 1 if i in (0, intervals) else (4 if i % 2 else 2)
        s += w * a / rate(a)
    return s * h / 3.0


def bisect(f, lo: float, hi: float) -> float:
    flo = f(lo)
    for _ in range(300):
        mid = 0.5 * (lo + hi)
        fm = f(mid)
        if (fm > 0) == (flo > 0):
            lo, flo = mid, fm
        else:
            hi = mid
    return 0.5 * (lo + hi)


# -------------------------------------------------------------------------------------------------------------
# 4. CalculiX *CRACK PROPAGATION conventions                                                          [S9]
# -------------------------------------------------------------------------------------------------------------
def ccx_shape_edge(s: float) -> float:
    return 1.12 * (1.0 - 0.02 * s ** 2)


def ccx_shape_surface_pi(s: float) -> float:
    return 2.0 / math.pi * (1.04 + 1.1 * s ** 2)


def ccx_keq(k1: float, k2: float, k3: float) -> float:
    return math.copysign(1.0, k1) * (abs(k1) + math.sqrt(k1 ** 2 + 5.3361 * k2 ** 2 + 4.0 * k3 ** 2)) / 2.0


# -------------------------------------------------------------------------------------------------------------
# 5. Assemble
# -------------------------------------------------------------------------------------------------------------
def case(cid, quantity, value, unit, tol, source, grade, proves, **extra):
    c = {"id": cid, "quantity": quantity, "value": value, "unit": unit, "tolerance": tol, "source": source,
         "grade": grade, "proves": proves}
    c.update(extra)
    return c


def build():
    cases = []
    k_rows = []
    for i in range(1, 7):
        r = i / 10.0
        bc = beta_center_secant(r, 1.0) if r < 0.5 else float("nan")
        bt, bp = beta_edge_tada(r, 1.0), beta_edge_poly(r, 1.0)
        assert abs(bt - bp) / bt < 0.01, (r, bt, bp)  # both forms claim 0.5 % up to a/b = 0.6
        k_rows.append([r, sig(bc) if math.isfinite(bc) else "", sig(bt), sig(bp)])

    k_center = 100.0 * math.sqrt(math.pi * 0.010) * beta_center_secant(0.010, 0.100)
    cases.append(case("VC-FRC-01", "K_I center crack, sigma 100 MPa, a 10 mm (half-length), W 100 mm, secant correction",
                      sig(k_center), "MPa*m^0.5", {"rel": 1e-12}, "S1 (secant form), S3 + generator", "A",
                      ["FR-FRC-01", "TR-FRC-10"], derivation="K = sigma sqrt(pi a) sqrt(sec(pi a / W))"))
    cases.append(case("VC-FRC-02", "edge crack beta at a/b = 0.5: Tada form and polynomial",
                      {"tada": sig(beta_edge_tada(0.5, 1.0)), "polynomial": sig(beta_edge_poly(0.5, 1.0))}, "-",
                      {"rel": 1e-12}, "S2 (both forms) + generator", "A", ["FR-FRC-01", "TR-FRC-10"],
                      note="long-plate solutions; table k_solutions_table.csv"))
    cases.append(case("VC-FRC-03", "NAFEMS R0020 test 2.1 single-edge-cracked plate (a/b 0.5, h/b 0.5): K_I / (sigma sqrt(pi a))",
                      3.0, "-", {"rel": 0.03}, "S4 Ansys VM-R020-t2a target (ref. Rooke & Cartwright 1976); Ansys 2.966 (interaction integral), 2.965 (J)",
                      "B", ["FR-FRC-03", "TR-FRC-20"], cross_check={"ansys_interaction": 2.966, "ansys_J": 2.965},
                      inputs={"E_MPa": 207000, "nu": 0.3, "sigma_MPa": 100, "b_mm": 20, "a_over_b": 0.5, "h_over_b": 0.5,
                              "state": "plane strain"},
                      note="short plate (h/b 0.5): differs from the long-plate Tada value of VC-FRC-02 by design"))

    nr_rows = []
    nr_case = {}
    for a_c in (0.2, 0.4, 1.0):
        for a_t in (0.2, 0.5, 0.8):
            q = newman_raju_Q(a_c)
            f90 = newman_raju_F(a_c, a_t, 0.1, math.pi / 2.0)
            f0 = newman_raju_F(a_c, a_t, 0.1, 0.0)
            nr_rows.append([a_c, a_t, 0.1, sig(q), sig(f90), sig(f0), sig(f90 / math.sqrt(q)), sig(f0 / math.sqrt(q))])
            if a_t == 0.5:
                nr_case[f"a_c={a_c}"] = {"Q": sig(q), "F_deepest": sig(f90), "F_surface": sig(f0)}
    cases.append(case("VC-FRC-04", "Newman-Raju surface crack F (a/t 0.5, c/b 0.1) at deepest (90 deg) and surface (0 deg) points",
                      nr_case, "-", {"rel": 1e-9}, "S5 (Q, M1, M2 seen in search extracts; M3, g, f_phi, f_w transcription unconfirmed)",
                      "C", ["FR-FRC-02", "TR-FRC-11"], note="not a gate until TM-83200 equations are checked by a human (OQ-FRC-01)"))

    a0, af, ds = 0.001, 0.010, 100.0
    n_an = paris_center_analytic(a0, af, ds)
    n_cb, rows = paris_center_cycle_by_cycle(a0, af, ds, record_every=50000)
    assert abs(n_cb - n_an) / n_an < 1e-3, (n_cb, n_an)
    n_simp = simpson_life(a0, af, lambda a: paris(ds * math.sqrt(math.pi * a)))
    assert abs(n_simp - n_an) / n_an < 1e-10, (n_simp, n_an)
    cases.append(case("VC-FRC-05", "Paris life, center crack Y = 1, 1 -> 10 mm, d_sigma 100 MPa, C 1e-11, m 3 (closed form)",
                      sig(n_an), "cycles", {"rel": 1e-9}, "S6 (Paris law) + generator closed form", "A",
                      ["FR-FRC-05", "FR-FRC-06", "TR-FRC-30"], derivation="N = (a0^(1-m/2) - af^(1-m/2)) / (C (m/2-1) (ds sqrt(pi))^m)"))
    cases.append(case("VC-FRC-06", "same, explicit cycle-by-cycle summation (cycles to exceed 10 mm)", n_cb, "cycles",
                      {"rel": 1e-3}, "generator", "A", ["FR-FRC-06", "TR-FRC-31"],
                      note="integrator acceptance: block / adaptive integration within 0.1 % of VC-FRC-05"))

    w = 0.200
    n_sec = simpson_life(0.005, 0.040, lambda a: paris(150.0 * math.sqrt(math.pi * a) * beta_center_secant(a, w)))
    cases.append(case("VC-FRC-07", "Paris life with secant width correction, W 200 mm, 5 -> 40 mm, d_sigma 150 MPa (Simpson, 20000 intervals in ln a)",
                      sig(n_sec), "cycles", {"rel": 1e-6}, "generator (converged quadrature)", "A", ["FR-FRC-06", "TR-FRC-31"]))

    rates = {
        "paris": sig(paris(10.0)),
        "walker_R0.5_g0.5": sig(walker(10.0, 0.5, 0.5)),
        "forman_R0.1": sig(forman(10.0, 0.1, KC)),
        "nasgro_R0.1_f0.1_dKth2_p0.25_q0.25": sig(nasgro(10.0, 0.1, 0.1, 2.0, KC, 0.25, 0.25)),
    }
    cases.append(case("VC-FRC-08", "crack-growth rates at dK = 10 MPa sqrt m (test constants)", rates, "m/cycle", {"rel": 1e-12},
                      "S6 (Paris), S7 (NASGRO form, 2 search sources), S8 (Walker / Forman forms)", "B",
                      ["FR-FRC-04", "TR-FRC-32"], note="grade B until the Walker / Forman forms are confirmed in a primary source"))
    fvals = {f"R={r}": sig(newman_closure_f(r, 2.0, 0.3)) for r in (-1.0, 0.0, 0.1, 0.5, 0.8)}
    cases.append(case("VC-FRC-09", "Newman crack-opening function f(R), alpha 2, Smax/sigma0 0.3", fvals, "-", {"rel": 1e-12},
                      "S7 (structure only)", "C", ["FR-FRC-04"], note="coefficient expressions not confirmed (OQ-FRC-02)"))

    sigma = 150.0
    a_c = bisect(lambda a: sigma * math.sqrt(math.pi * a) * beta_center_secant(a, w) - KC, 1e-5, 0.0999)
    a_ny = w / 2.0 * (1.0 - sigma / FTY)
    rs = {}
    for a in (0.010, 0.020, 0.040):
        s_k = KC / (math.sqrt(math.pi * a) * beta_center_secant(a, w))
        s_ny = FTY * (1.0 - 2.0 * a / w)
        rs[f"a={a}"] = {"sigma_K_MPa": sig(s_k), "sigma_netyield_MPa": sig(s_ny), "residualStrength_MPa": sig(min(s_k, s_ny)),
                        "governing": "fracture" if s_k < s_ny else "net_section_yield"}
    cases.append(case("VC-FRC-10", "critical half-length at sigma 150 MPa (Kc 60, W 200 mm, secant)", sig(a_c), "m",
                      {"rel": 1e-9}, "generator", "A", ["FR-FRC-07", "TR-FRC-40"]))
    cases.append(case("VC-FRC-11", "net-section-yield half-length at sigma 150 MPa (Fty 300 MPa)", sig(a_ny), "m", {"rel": 1e-12},
                      "generator", "A", ["FR-FRC-07", "TR-FRC-40"], derivation="sigma W / (W - 2a) = Fty"))
    cases.append(case("VC-FRC-12", "residual strength min(Kc criterion, net-section yield) at a = 10, 20, 40 mm", rs, "MPa",
                      {"rel": 1e-9}, "generator", "A", ["FR-FRC-07", "TR-FRC-40"]))

    a_det, sf = 0.005, 2.0
    n_det = simpson_life(a_det, a_c, lambda a: paris(sigma * math.sqrt(math.pi * a) * beta_center_secant(a, w)))
    cases.append(case("VC-FRC-13", "crack-growth life from detectable 5 mm to critical (VC-FRC-10), d_sigma = sigma (R 0)",
                      sig(n_det), "cycles", {"rel": 1e-6}, "generator", "A", ["FR-FRC-08", "TR-FRC-41"]))
    cases.append(case("VC-FRC-14", "inspection interval = life / scatter factor 2 (explicit test value)", sig(n_det / sf), "cycles",
                      {"rel": 1e-6}, "generator; factor is a test input (no verified default, OQ-FRC-03)", "A",
                      ["FR-FRC-08", "FR-FRC-09", "TR-FRC-41"]))

    ccx = {"edge_s0": sig(ccx_shape_edge(0.0)), "edge_s1": sig(ccx_shape_edge(1.0)), "subsurface": sig(2.0 / math.pi),
           "surface_pi_s0": sig(ccx_shape_surface_pi(0.0)), "surface_pi_s1": sig(ccx_shape_surface_pi(1.0)),
           "Keq_10_5_0": sig(ccx_keq(10.0, 5.0, 0.0))}
    cases.append(case("VC-FRC-15", "CalculiX *CRACK PROPAGATION shape factors and Richard K_eq (manual definitions)", ccx, "-",
                      {"rel": 1e-12}, "S9 CalculiX manual (git) + generator", "B", ["FR-FRC-10", "TR-FRC-21"]))
    ccx_c = 1.0e-11
    ccx_ref = {"dadN_ref_m": 1.0e-8, "dK_ref": (1.0e-8 / ccx_c) ** (1.0 / M_PARIS)}
    cases.append(case("VC-FRC-16", "CalculiX Paris-constant mapping: C = (da/dN)_ref / dK_ref^m -> dK_ref for (da/dN)_ref 1e-8 m",
                      sig(ccx_ref["dK_ref"]), "MPa*m^0.5", {"rel": 1e-12}, "S9 + generator", "A", ["FR-FRC-10", "TR-FRC-21"]))
    k_fe = 100.0 * math.sqrt(math.pi * 0.020) * beta_center_secant(0.020, 0.200)
    cases.append(case("VC-FRC-17", "interaction-integral K_I on a centre-crack plate model (a 20 mm, W 200 mm, 100 MPa; plan drafted in M4)",
                      sig(k_fe), "MPa*m^0.5", {"rel": 0.02}, "secant closed form (VC-FRC-01 formula)", "A",
                      ["FR-FRC-03", "TR-FRC-20"], note="FE value TBD — measure with the M3 interaction-integral post-processor"))
    cases.append(case("VC-FRC-20", "agent-first result contract", {
        "scatterUnset": {"code": "FRC_SCATTER_FACTOR_UNSET", "exit": 1},
        "kcUnverified": {"flag": "unverified", "check": "FRC_DATA_UNVERIFIED"},
        "reviewRequired": True, "summaryContains": "not approved",
        "acceptIntervalByAgent": {"code": "FRC_HUMAN_GATE", "exit": 1, "documentUnchanged": True},
        "outsideValidity": {"code": "FRC_K_SOLUTION_OUT_OF_RANGE"},
        "stale": {"code": "FRC_RESULTS_STALE"}}, "-", {"abs": 0.0}, "AGENT_FIRST AF-11/31/32/33/34", "A",
        ["FR-FRC-09", "FR-FRC-11", "FR-FRC-12", "FR-FRC-13", "TR-FRC-50"]))

    expected = {"pack": "08-fracture-damage-tolerance", "generatedBy": "generate_fracture_reference.py", "cases": cases}
    growth = [[0, a0, a0]]
    for n, a in rows:
        e = 1.0 - M_PARIS / 2.0
        a_an = (a0 ** e - n * C_PARIS * (M_PARIS / 2.0 - 1.0) * (ds * math.sqrt(math.pi)) ** M_PARIS) ** (1.0 / e)
        growth.append([n, sig(a), sig(a_an)])
    return expected, k_rows, nr_rows, growth


def main() -> None:
    expected, k_rows, nr_rows, growth = build()
    with open(out("expected_results.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(expected, f, indent=1, ensure_ascii=False)
        f.write("\n")
    with open(out("k_solutions_table.csv"), "w", encoding="utf-8", newline="") as f:
        wr = csv.writer(f, lineterminator="\n")
        wr.writerow(["a_over_W_or_b", "beta_center_secant", "beta_edge_tada", "beta_edge_polynomial"])
        wr.writerows(k_rows)
    with open(out("newman_raju_table.csv"), "w", encoding="utf-8", newline="") as f:
        wr = csv.writer(f, lineterminator="\n")
        wr.writerow(["a_over_c", "a_over_t", "c_over_b", "Q", "F_phi90", "F_phi0", "F_over_sqrtQ_phi90", "F_over_sqrtQ_phi0"])
        wr.writerows(nr_rows)
    with open(out("crack_growth_center_paris.csv"), "w", encoding="utf-8", newline="") as f:
        wr = csv.writer(f, lineterminator="\n")
        wr.writerow(["cycles", "a_cycle_by_cycle_m", "a_analytic_m"])
        wr.writerows(growth)


if __name__ == "__main__":
    main()
