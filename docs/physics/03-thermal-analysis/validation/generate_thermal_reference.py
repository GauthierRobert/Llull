#!/usr/bin/env python3
"""
Generate the analytic reference values of PHY-03 (thermal analysis).

Run:  python3 -I generate_thermal_reference.py      (stdlib only, deterministic, writes next to this script)

Outputs
  expected_results.json   cases in the docs/physics/README.md section 6.3 schema (12 significant digits)
  t3_history.csv          NAFEMS T3: analytic T(x = 0.08 m, t) for t = 0..32 s (Fourier series)
  t4_edge_profile.csv     NAFEMS T4: analytic T(0.6, y) along the convective right edge
  view_factors.csv        closed-form configuration factors + independent numerical quadrature

Formulas (source ids refer to sources.md):
  Plane wall, convection both sides:   q'' = (Tinf1 - Tinf2) / (1/h1 + L/k + 1/h2)              [S9]
  Plane wall, uniform generation:      T(x) = Ts + q''' (L^2 - x^2) / (2 k),  -L <= x <= L         [S9]
  NAFEMS T3 (1D transient):            u = (x/L) f(t) + sum b_n(t) sin(n pi x / L),
                                       f = 100 sin(w t), w = pi/40, b_n' + a l_n^2 b_n = -c_n f'(t),
                                       c_n = 2 (-1)^(n+1) / (n pi)  (eigenfunction expansion, derived)  [S2, S3, S9]
  NAFEMS T4 (2D, convection):          T = sum C_n cos(b_n x) Y_n(y) / Y_n(0),  b tan(b W) = h/k,
                                       Y_n = cosh(b (H - y)) + (h/(k b)) sinh(b (H - y))  (separation of variables) [S3, S9]
  NAFEMS T2 (1D, radiation):           (T - T0) k / l + eps sigma (T^4 - Tinf^4) = 0                 [S3]
  Semi-infinite solid, step surface T: (T - Ts)/(Ti - Ts) = erf(x / (2 sqrt(alpha t)))             [S9]
  Lumped capacitance:                  (T - Tinf)/(Ti - Tinf) = exp(-h A t / (rho V c)),  Bi = h (V/A) / k < 0.1 [S9]
  Straight fin, adiabatic tip:         eta = tanh(m L) / (m L), m = sqrt(h P / (k Ac))              [S9]
  Infinite parallel grey plates:       q'' = sigma (T1^4 - T2^4) / (1/e1 + 1/e2 - 1)               [S9]
  Interface (gap) conductance:         series resistances L1/k1 + 1/hc + L2/k2                     [S7 (definition), S9]
  One-phase Stefan (Neumann):          lam exp(lam^2) erf(lam) = Ste / sqrt(pi), s = 2 lam sqrt(alpha t) [S9]
  View factors (Hottel / Howell C-11, perpendicular rectangles, coaxial discs)                    [S8, S9]
  Stefan-Boltzmann constant:           sigma = 2 pi^5 k_B^4 / (15 h^3 c^2) with the exact 2019 SI constants [S11]

Inputs labelled "test input" are values chosen for the case; they are not material claims.
Tolerances are llull acceptance choices (validation/README.md), not claims of any source.
"""

from __future__ import annotations

import csv
import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))

# exact 2019 SI defining constants [S11]
H_PLANCK = 6.62607015e-34
K_BOLTZMANN = 1.380649e-23
C_LIGHT = 299792458.0
SIGMA_SB = 2.0 * math.pi**5 * K_BOLTZMANN**4 / (15.0 * H_PLANCK**3 * C_LIGHT**2)


def sig(x: float, n: int = 12) -> float:
    if x == 0 or not math.isfinite(x):
        return x
    return float(f"{x:.{n}g}")


def bisect(f, lo: float, hi: float, it: int = 200) -> float:
    flo = f(lo)
    for _ in range(it):
        mid = 0.5 * (lo + hi)
        fm = f(mid)
        if (fm > 0) == (flo > 0):
            lo, flo = mid, fm
        else:
            hi = mid
    return 0.5 * (lo + hi)


# ----------------------------------------------------------------------------------------------------------
# 1. Plane walls
# ----------------------------------------------------------------------------------------------------------
def wall_convection(L, k, h1, t1, h2, t2):
    R = 1.0 / h1 + L / k + 1.0 / h2
    q = (t1 - t2) / R
    return q, t1 - q / h1, t2 + q / h2


def wall_generation_tmax(L, k, qgen, ts):
    return ts + qgen * L * L / (2.0 * k)


# ----------------------------------------------------------------------------------------------------------
# 2. NAFEMS T3: 1D transient, eigenfunction expansion (derived here; quoted target 36.60 degC)
# ----------------------------------------------------------------------------------------------------------
T3 = {"L_m": 0.1, "k_W_mK": 35.0, "rho_kg_m3": 7200.0, "cp_J_kgK": 440.5, "x_m": 0.08, "t_s": 32.0,
      "T_left_degC": 0.0, "T_right_degC": "100 sin(pi t / 40)", "T_initial_degC": 0.0}


def t3_temperature(x: float, t: float, terms: int = 20000) -> float:
    a = T3["k_W_mK"] / (T3["rho_kg_m3"] * T3["cp_J_kgK"])
    L, w = T3["L_m"], math.pi / 40.0
    u = x / L * 100.0 * math.sin(w * t)
    for n in range(1, terms + 1):
        lam = n * math.pi / L
        kn = a * lam * lam
        cn = 2.0 * (-1) ** (n + 1) / (n * math.pi)
        integral = (kn * math.cos(w * t) + w * math.sin(w * t) - kn * math.exp(-kn * t)) / (kn * kn + w * w)
        u += -cn * 100.0 * w * integral * math.sin(lam * x)
    return u


# ----------------------------------------------------------------------------------------------------------
# 3. NAFEMS T4: 2D steady with convection, separation of variables (derived; quoted target 18.3 degC)
# ----------------------------------------------------------------------------------------------------------
T4 = {"W_m": 0.6, "H_m": 1.0, "k_W_mK": 52.0, "h_W_m2K": 750.0, "T_bottom_degC": 100.0, "T_ambient_degC": 0.0,
      "left": "adiabatic", "right_and_top": "convection", "point_m": [0.6, 0.2]}


def t4_temperature(x: float, y: float, terms: int = 400) -> float:
    W, H, m, t0 = T4["W_m"], T4["H_m"], T4["h_W_m2K"] / T4["k_W_mK"], T4["T_bottom_degC"]
    s = 0.0
    for n in range(1, terms + 1):
        b = bisect(lambda z: z * math.sin(z * W) - m * math.cos(z * W), (n - 1) * math.pi / W + 1e-12, (n - 0.5) * math.pi / W - 1e-12)
        cn = t0 * (math.sin(b * W) / b) / (W / 2.0 + math.sin(2.0 * b * W) / (4.0 * b))

        def yfun(yy: float) -> float:
            z = b * (H - yy)
            return math.exp(z - b * H) * (1 + m / b) / 2 + math.exp(-z - b * H) * (1 - m / b) / 2

        s += cn * math.cos(b * x) * yfun(y) / yfun(0.0)
    return s


# ----------------------------------------------------------------------------------------------------------
# 4. NAFEMS T2 (FeenoX statement): 1D steady conduction + surface radiation
# ----------------------------------------------------------------------------------------------------------
T2 = {"l_m": 0.1, "k_W_mK": 55.6, "eps": 0.98, "T0_K": 1000.0, "Tinf_K": 300.0}


def t2_temperature(sigma: float) -> float:
    k, l, e, t0, ti = T2["k_W_mK"], T2["l_m"], T2["eps"], T2["T0_K"], T2["Tinf_K"]
    return bisect(lambda t: (t - t0) * k / l + sigma * e * (t**4 - ti**4), 0.0, 2000.0)


# ----------------------------------------------------------------------------------------------------------
# 5. Classical closed forms
# ----------------------------------------------------------------------------------------------------------
def semi_infinite(ti, ts, alpha, x, t):
    return ts + (ti - ts) * math.erf(x / (2.0 * math.sqrt(alpha * t)))


def lumped_sphere(d, rho, c, k, h, ti, tinf, t):
    v_over_a = d / 6.0
    bi = h * v_over_a / k
    tau = rho * c * v_over_a / h
    return tinf + (ti - tinf) * math.exp(-t / tau), bi, tau


def fin_efficiency(h, k, d, L):
    m = math.sqrt(4.0 * h / (k * d))  # pin fin: P = pi d, Ac = pi d^2 / 4
    return math.tanh(m * L) / (m * L), m


def parallel_plates(t1, t2, e1, e2):
    return SIGMA_SB * (t1**4 - t2**4) / (1.0 / e1 + 1.0 / e2 - 1.0)


def stefan_neumann(k, rho, cp, latent, dT, t):
    ste = cp * dT / latent
    lam = bisect(lambda z: z * math.exp(z * z) * math.erf(z) - ste / math.sqrt(math.pi), 1e-9, 3.0)
    alpha = k / (rho * cp)
    return lam, 2.0 * lam * math.sqrt(alpha * t), ste


# ----------------------------------------------------------------------------------------------------------
# 6. View factors: closed forms + Gauss-Legendre quadrature of the defining double area integral
# ----------------------------------------------------------------------------------------------------------
def vf_parallel(a, b, c):
    X, Y = a / c, b / c
    t = 0.5 * math.log((1 + X * X) * (1 + Y * Y) / (1 + X * X + Y * Y))
    t += X * math.sqrt(1 + Y * Y) * math.atan(X / math.sqrt(1 + Y * Y))
    t += Y * math.sqrt(1 + X * X) * math.atan(Y / math.sqrt(1 + X * X))
    t -= X * math.atan(X) + Y * math.atan(Y)
    return 2.0 / (math.pi * X * Y) * t


def vf_perpendicular(l, w, h):
    """Surface 1 width w, surface 2 height h, common edge length l (F from surface 1 to surface 2)."""
    W, H = w / l, h / l
    a = W * math.atan(1 / W) + H * math.atan(1 / H) - math.sqrt(H * H + W * W) * math.atan(1 / math.sqrt(H * H + W * W))
    g1 = (1 + W * W) * (1 + H * H) / (1 + W * W + H * H)
    g2 = (W * W * (1 + W * W + H * H) / ((1 + W * W) * (W * W + H * H))) ** (W * W)
    g3 = (H * H * (1 + H * H + W * W) / ((1 + H * H) * (H * H + W * W))) ** (H * H)
    return (a + 0.25 * math.log(g1 * g2 * g3)) / (math.pi * W)


def vf_coaxial_discs(r1, r2, L):
    R1, R2 = r1 / L, r2 / L
    S = 1 + (1 + R2 * R2) / (R1 * R1)
    return 0.5 * (S - math.sqrt(S * S - 4 * (R2 / R1) ** 2))


def gauss_legendre(n: int):
    nodes, weights = [], []
    for i in range(1, n + 1):
        x = math.cos(math.pi * (i - 0.25) / (n + 0.5))
        for _ in range(100):
            p0, p1 = 1.0, x
            for k in range(2, n + 1):
                p0, p1 = p1, ((2 * k - 1) * x * p1 - (k - 1) * p0) / k
            dp = n * (x * p1 - p0) / (x * x - 1)
            dx = p1 / dp
            x -= dx
            if abs(dx) < 1e-16:
                break
        nodes.append(x)
        weights.append(2.0 / ((1 - x * x) * dp * dp))
    return nodes, weights


def vf_quadrature(kind: str, n: int) -> float:
    """Independent numerical value of the defining integral F12 = 1/A1 int int cos1 cos2 / (pi s^2) dA2 dA1 (unit squares)."""
    xs, ws = gauss_legendre(n)
    pts = [(0.5 * (x + 1), 0.5 * w) for x, w in zip(xs, ws)]
    total = 0.0
    if kind == "parallel":  # unit squares in z = 0 and z = 1, normals facing: plain 4D tensor Gauss-Legendre
        for x1, w1 in pts:
            for y1, w2 in pts:
                for x2, w3 in pts:
                    for y2, w4 in pts:
                        s2 = (x2 - x1) ** 2 + (y2 - y1) ** 2 + 1.0
                        total += w1 * w2 * w3 * w4 / (math.pi * s2 * s2)
        return total

    # perpendicular unit squares sharing the edge along y: point 1 (x, y1, 0), point 2 (0, y2, z),
    # kernel x z / (pi (x^2 + z^2 + (y2 - y1)^2)^2). The two integrals along the common edge are done in closed form:
    # int_0^1 int_0^1 g(y2 - y1) = 2 int_0^1 (1 - u) g(u) du, g(u) = 1 / (r^2 + u^2)^2, r^2 = x^2 + z^2.
    def edge_integral(r: float) -> float:
        a = 1.0 / (2 * r * r * (r * r + 1)) + math.atan(1.0 / r) / (2 * r**3)
        b = -1.0 / (2 * (r * r + 1)) + 1.0 / (2 * r * r)
        return 2.0 * (a - b)

    # remaining 2D integral over (x, z) in the unit square, symmetric in x <-> z; Duffy map of the triangle z <= x
    # (x = s, z = s t, dA = s ds dt) removes the 1/r corner singularity.
    for s_, ws_ in pts:
        for t_, wt_ in pts:
            x, z = s_, s_ * t_
            r = math.hypot(x, z)
            total += ws_ * wt_ * s_ * x * z * edge_integral(r) / math.pi
    return 2.0 * total


# ----------------------------------------------------------------------------------------------------------
# 7. Assemble
# ----------------------------------------------------------------------------------------------------------
def case(cid, quantity, value, unit, tol, source, grade, proves, **extra):
    c = {"id": cid, "quantity": quantity, "value": value, "unit": unit, "tolerance": tol, "source": source, "grade": grade, "proves": proves}
    c.update(extra)
    return c


def main() -> None:
    cases = []

    # VC-THM-01 plane wall with convection on both sides (test inputs)
    w = {"L_m": 0.05, "k_W_mK": 15.0, "h1_W_m2K": 50.0, "Tinf1_degC": 200.0, "h2_W_m2K": 10.0, "Tinf2_degC": 20.0}
    q, ts1, ts2 = wall_convection(w["L_m"], w["k_W_mK"], w["h1_W_m2K"], w["Tinf1_degC"], w["h2_W_m2K"], w["Tinf2_degC"])
    deriv = "q = (Tinf1 - Tinf2)/(1/h1 + L/k + 1/h2); Ts1 = Tinf1 - q/h1; Ts2 = Tinf2 + q/h2"
    cases.append(case("VC-THM-01.a", "plane wall heat flux", sig(q), "W/m^2", {"rel": 0.005}, "generator (S9 formula)", "A",
                      ["FR-THM-01", "FR-THM-03", "TR-THM-10"], inputs=w, derivation=deriv))
    cases.append(case("VC-THM-01.b", "plane wall hot-side surface temperature", sig(ts1), "degC", {"abs": 0.05}, "generator (S9 formula)", "A",
                      ["FR-THM-01", "FR-THM-03"], inputs=w, derivation=deriv))
    cases.append(case("VC-THM-01.c", "plane wall cold-side surface temperature", sig(ts2), "degC", {"abs": 0.05}, "generator (S9 formula)", "A",
                      ["FR-THM-01", "FR-THM-03"], inputs=w, derivation=deriv))
    cases.append(case("VC-THM-01.d", "heat balance residual |Q_in - Q_out| / Q_in (steady state)", 0.0, "1", {"abs": 0.001},
                      "definition (energy conservation)", "A", ["FR-THM-12", "TR-THM-31"],
                      derivation="steady state: heat entering on face 1 equals heat leaving on face 2; llull reports the residual from reaction fluxes (RFL) and film fluxes"))

    # VC-THM-02 slab with uniform volumetric heat generation (test inputs)
    g = {"half_thickness_m": 0.01, "k_W_mK": 20.0, "qgen_W_m3": 1.0e7, "Ts_degC": 50.0}
    cases.append(case("VC-THM-02", "slab with uniform generation, centre temperature", sig(wall_generation_tmax(g["half_thickness_m"], g["k_W_mK"], g["qgen_W_m3"], g["Ts_degC"])),
                      "degC", {"rel": 0.005}, "generator (S9 formula)", "A", ["FR-THM-04", "TR-THM-12"], inputs=g,
                      derivation="Tmax = Ts + q''' L^2 / (2 k), L = half thickness"))

    # VC-THM-03 NAFEMS T3
    t3 = t3_temperature(T3["x_m"], T3["t_s"])
    cases.append(case("VC-THM-03", "NAFEMS T3: temperature at x = 0.08 m, t = 32 s", 36.6, "degC", {"rel": 0.02},
                      "S1 (Abaqus T3) + S2 (MOOSE, git) + S3 (FeenoX test 36.6 +/- 0.05) + S4 (FEATool T_ref 36.6)", "A",
                      ["FR-THM-02", "FR-THM-07", "TR-THM-13"], inputs=T3, analytic=sig(t3),
                      derivation="eigenfunction expansion (20000 terms) of u_t = a u_xx with u(0)=0, u(L)=100 sin(pi t/40), u(x,0)=0; a = k/(rho cp)",
                      note="the analytic series gives 36.6031 degC, so the quoted 36.60 is confirmed to 4 digits; MOOSE coarse linear meshes are 10 % high"))

    # VC-THM-04 NAFEMS T4
    t4 = t4_temperature(*T4["point_m"])
    cases.append(case("VC-THM-04", "NAFEMS T4: steady temperature at (0.6, 0.2) m", sig(t4), "degC", {"rel": 0.01},
                      "generator (separation of variables) + S3 (FeenoX 18.3) + S4 (FEATool 18.3) + S6 (COMSOL 18.25, search)", "A",
                      ["FR-THM-01", "FR-THM-03", "TR-THM-10"], inputs=T4, quotedBySource=18.3,
                      derivation="T = sum C_n cos(b_n x) Y_n(y)/Y_n(0); b tan(b W) = h/k; C_n = T0 (sin(bW)/b)/(W/2 + sin(2bW)/(4b)); 400 terms",
                      note="settles the rounding question of the gap list: 18.2538 rounds to 18.3 (NAFEMS) and 18.25 (COMSOL)"))

    # VC-THM-05 NAFEMS T2 (radiation boundary), FeenoX statement
    t2_problem = t2_temperature(5.67e-8)
    t2_codata = t2_temperature(SIGMA_SB)
    cases.append(case("VC-THM-05", "NAFEMS T2 (FeenoX statement): temperature of the radiating face", sig(t2_problem), "K", {"rel": 0.001},
                      "generator + S3 (FeenoX nafems-t2-1d.fee, analytic root)", "A", ["FR-THM-05", "TR-THM-14"], inputs=dict(T2, sigma_W_m2K4=5.67e-8),
                      derivation="(T - T0) k / l + eps sigma (T^4 - Tinf^4) = 0, bisection", value_with_exact_sigma=sig(t2_codata),
                      note="sigma = 5.67e-8 as in the problem statement; the exact SI value 5.670374419e-8 shifts T by the amount shown"))

    # VC-THM-06 semi-infinite solid (test inputs)
    si = {"Ti_degC": 20.0, "Ts_degC": 200.0, "alpha_m2_s": 1.0e-5, "x_m": 0.01, "t_s": 10.0}
    cases.append(case("VC-THM-06", "semi-infinite solid after a step in surface temperature", sig(semi_infinite(si["Ti_degC"], si["Ts_degC"], si["alpha_m2_s"], si["x_m"], si["t_s"])),
                      "degC", {"rel": 0.01}, "generator (S9 formula)", "A", ["FR-THM-02", "TR-THM-13"], inputs=si,
                      derivation="T = Ts + (Ti - Ts) erf(x / (2 sqrt(alpha t)))"))

    # VC-THM-07 lumped capacitance sphere (test inputs)
    lc = {"d_m": 0.01, "rho_kg_m3": 2700.0, "c_J_kgK": 900.0, "k_W_mK": 200.0, "h_W_m2K": 50.0, "Ti_degC": 300.0, "Tinf_degC": 20.0, "t_s": 60.0}
    tl, bi, tau = lumped_sphere(lc["d_m"], lc["rho_kg_m3"], lc["c_J_kgK"], lc["k_W_mK"], lc["h_W_m2K"], lc["Ti_degC"], lc["Tinf_degC"], lc["t_s"])
    cases.append(case("VC-THM-07.a", "lumped-capacitance sphere temperature at t", sig(tl), "degC", {"rel": 0.01}, "generator (S9 formula)", "A",
                      ["FR-THM-02", "FR-THM-14", "TR-THM-40"], inputs=lc, derivation="T = Tinf + (Ti - Tinf) exp(-t/tau), tau = rho c (d/6) / h"))
    cases.append(case("VC-THM-07.b", "Biot number of the lumped sphere (validity Bi < 0.1)", sig(bi), "1", {"rel": 1e-9}, "generator (S9 formula)", "A",
                      ["FR-THM-14", "TR-THM-40"], inputs=lc, derivation="Bi = h (V/A) / k, V/A = d/6", time_constant_s=sig(tau)))

    # VC-THM-08 pin fin efficiency (test inputs)
    fin = {"h_W_m2K": 100.0, "k_W_mK": 200.0, "d_m": 0.005, "L_m": 0.05}
    eta, m = fin_efficiency(fin["h_W_m2K"], fin["k_W_mK"], fin["d_m"], fin["L_m"])
    cases.append(case("VC-THM-08", "pin fin efficiency, adiabatic tip", sig(eta), "1", {"rel": 0.01}, "generator (S9 formula)", "A",
                      ["FR-THM-03", "FR-THM-14", "TR-THM-40"], inputs=fin, derivation="eta = tanh(mL)/(mL), m = sqrt(4h/(k d))", m_per_m=sig(m)))

    # VC-THM-09 view factors
    f_par = vf_parallel(1.0, 1.0, 1.0)
    f_perp = vf_perpendicular(1.0, 1.0, 1.0)
    q_par = vf_quadrature("parallel", 16)
    q_perp = vf_quadrature("perpendicular", 48)
    cases.append(case("VC-THM-09.a", "view factor, identical parallel directly opposed unit squares, spacing 1", sig(f_par), "1", {"abs": 0.002},
                      "generator (closed form, S8 C-11 configuration) + Gauss-Legendre 16^4 check", "A", ["FR-THM-06", "TR-THM-20"],
                      quadrature=sig(q_par), derivation="F = 2/(pi X Y) {ln sqrt((1+X^2)(1+Y^2)/(1+X^2+Y^2)) + X sqrt(1+Y^2) atan(X/sqrt(1+Y^2)) + Y sqrt(1+X^2) atan(Y/sqrt(1+X^2)) - X atan X - Y atan Y}"))
    cases.append(case("VC-THM-09.b", "view factor, perpendicular unit squares with a common edge", sig(f_perp), "1", {"abs": 0.002},
                      "generator (closed form, S8 C-14 configuration) + edge-integrated Duffy/Gauss-Legendre check", "A", ["FR-THM-06", "TR-THM-20"],
                      quadrature=sig(q_perp), derivation="Hottel closed form, W = H = 1 (see vf_perpendicular)",
                      note="the kernel is singular on the shared edge: the check integrates along the edge in closed form and uses a Duffy map for the corner"))
    cases.append(case("VC-THM-09.c", "summation rule inside a unit cube: F(opposite) + 4 F(adjacent)", sig(f_par + 4 * f_perp), "1", {"abs": 1e-9},
                      "generator (summation rule)", "A", ["FR-THM-06", "TR-THM-20"], derivation="sum of view factors from one face of a closed cube = 1"))
    cases.append(case("VC-THM-09.d", "view factor, coaxial parallel discs r1 = r2 = L", sig(vf_coaxial_discs(1.0, 1.0, 1.0)), "1", {"abs": 0.002},
                      "generator (closed form, S8 C-41 configuration)", "A", ["FR-THM-06", "TR-THM-20"],
                      derivation="F = (S - sqrt(S^2 - 4 (R2/R1)^2))/2, S = 1 + (1 + R2^2)/R1^2"))

    # VC-THM-10 grey parallel plates (test inputs)
    pp = {"T1_K": 400.0, "T2_K": 300.0, "eps1": 0.8, "eps2": 0.5}
    cases.append(case("VC-THM-10", "net radiative flux between infinite grey parallel plates", sig(parallel_plates(pp["T1_K"], pp["T2_K"], pp["eps1"], pp["eps2"])),
                      "W/m^2", {"rel": 0.01}, "generator (S9 formula, exact SI sigma)", "A", ["FR-THM-05", "FR-THM-06", "TR-THM-21"], inputs=pp,
                      derivation="q = sigma (T1^4 - T2^4)/(1/e1 + 1/e2 - 1)", sigma_W_m2K4=sig(SIGMA_SB)))

    # VC-THM-11 interface conductance in series (test inputs)
    ic = {"L1_m": 0.01, "k1_W_mK": 150.0, "hc_W_m2K": 2000.0, "L2_m": 0.01, "k2_W_mK": 15.0, "T_hot_degC": 100.0, "T_cold_degC": 20.0}
    r_tot = ic["L1_m"] / ic["k1_W_mK"] + 1.0 / ic["hc_W_m2K"] + ic["L2_m"] / ic["k2_W_mK"]
    qi = (ic["T_hot_degC"] - ic["T_cold_degC"]) / r_tot
    cases.append(case("VC-THM-11.a", "flux through two slabs with an interface conductance", sig(qi), "W/m^2", {"rel": 0.005}, "generator (S7 definition, S9)", "A",
                      ["FR-THM-08", "TR-THM-15"], inputs=ic, derivation="q = dT / (L1/k1 + 1/hc + L2/k2)"))
    cases.append(case("VC-THM-11.b", "temperature jump across the interface", sig(qi / ic["hc_W_m2K"]), "K", {"rel": 0.01}, "generator (S7 definition)", "A",
                      ["FR-THM-08", "TR-THM-15"], inputs=ic, derivation="dT_interface = q / hc"))

    # VC-THM-12 one-phase Stefan problem (test inputs, water-like but not a property claim)
    st = {"k_W_mK": 0.6, "rho_kg_m3": 1000.0, "cp_J_kgK": 4200.0, "latent_J_kg": 334000.0, "Twall_minus_Tmelt_K": 10.0, "t_s": 3600.0}
    lam, front, ste = stefan_neumann(st["k_W_mK"], st["rho_kg_m3"], st["cp_J_kgK"], st["latent_J_kg"], st["Twall_minus_Tmelt_K"], st["t_s"])
    cases.append(case("VC-THM-12.a", "Neumann one-phase melting: root lambda", sig(lam), "1", {"rel": 1e-9}, "generator (S9 formula)", "A",
                      ["FR-THM-09", "TR-THM-16"], inputs=st, stefanNumber=sig(ste), derivation="lam exp(lam^2) erf(lam) = Ste/sqrt(pi)"))
    cases.append(case("VC-THM-12.b", "Neumann one-phase melting: front position at t", sig(front), "m", {"rel": 0.03}, "generator (S9 formula)", "A",
                      ["FR-THM-09", "TR-THM-16"], inputs=st, derivation="s = 2 lam sqrt(alpha t); FE uses the apparent-heat-capacity table of TR-THM-16"))

    # VC-THM-13 Stefan-Boltzmann constant written to *PHYSICAL CONSTANTS
    cases.append(case("VC-THM-13", "Stefan-Boltzmann constant written to *PHYSICAL CONSTANTS (SI)", sig(SIGMA_SB), "W/(m^2 K^4)", {"rel": 1e-9},
                      "generator (exact 2019 SI constants, S11) + S7 (keyword syntax)", "A", ["FR-THM-05", "TR-THM-14"],
                      derivation="sigma = 2 pi^5 kB^4 / (15 h^3 c^2)", inMmTonneSecond=sig(SIGMA_SB * 1e-3),
                      note="N-mm-t-s: 1 W/(m^2 K^4) = 1000 N mm s^-1 / (1e6 mm^2 K^4), so the deck value is sigma_SI x 1e-3"))

    # VC-THM-14 CalculiX test deck oneel8ra: unit cube, x = 0 face at 0 degC, x = 1 face radiates (eps 1) to -12 degC
    o8 = {"L_m": 1.0, "k_W_mK": 50.0, "eps": 1.0, "T_fixed_degC": 0.0, "T_sink_degC": -12.0, "absoluteZero_degC": -273.15, "sigma_W_m2K4": 5.669e-8}
    tz = o8["absoluteZero_degC"]
    t_rad = bisect(lambda t: o8["k_W_mK"] * (o8["T_fixed_degC"] - t) / o8["L_m"] - o8["eps"] * o8["sigma_W_m2K4"] * ((t - tz) ** 4 - (o8["T_sink_degC"] - tz) ** 4), -12.0, 0.0)
    cases.append(case("VC-THM-14.a", "CalculiX oneel8ra: temperature of the radiating face", sig(t_rad), "degC", {"rel": 1e-4},
                      "generator (1D conduction + radiation balance) + S7 (test/oneel8ra.dat.ref: -9.507386E-01)", "A", ["FR-THM-05", "TR-THM-14", "TR-THM-30"],
                      inputs=o8, calculixReference=-0.9507386, deckSha256="3cd84490cb97f4d06dba2d8c273149c29099840db950d90530e46af4f130bc06",
                      derivation="k (T0 - T)/L = eps sigma ((T - Tz)^4 - (Tsink - Tz)^4); a linear C3D8 element is exact for this 1D field"))
    cases.append(case("VC-THM-14.b", "CalculiX oneel8ra: heat flow through the cube (sum of RFL on the fixed face)", sig(o8["k_W_mK"] * (o8["T_fixed_degC"] - t_rad) / o8["L_m"]), "W", {"rel": 1e-4},
                      "generator + S7 (4 x 1.188423E+01 = 47.53692)", "A", ["FR-THM-11", "FR-THM-12", "TR-THM-31"], inputs=o8,
                      derivation="Q = k A (T0 - T)/L with A = 1 m^2; equals the radiated power (heat balance)"))

    # Agent-first cases (codes from TECHNICAL_SPEC section 7.1)
    cases.append(case("VC-THM-60", "named defaults: absolute zero and sigma are reported with source and defaulted flag", None, "-", {"exact": True},
                      "TECHNICAL_SPEC 5.4 / AF-31", "A", ["FR-THM-20", "TR-THM-50"],
                      expected={"physicalConstants": {"stefanBoltzmann": {"value": sig(SIGMA_SB), "unit": "W/(m^2 K^4)", "source": "2019 SI exact constants", "defaulted": True},
                                                      "absoluteZero": {"value": -273.15, "unit": "degC", "source": "SI definition of degC", "defaulted": True}}}))
    cases.append(case("VC-THM-61", "deliberately wrong set-ups return stable codes", None, "-", {"exact": True}, "TECHNICAL_SPEC 7.1 / AF-11", "A",
                      ["FR-THM-21", "TR-THM-51"],
                      expected=[
                          {"setup": "heat_transient case, material record has k but no cp", "code": "THM_MATERIAL_NO_CP"},
                          {"setup": "radiation BC with emissivity 1.2", "code": "THM_EMISSIVITY_INVALID"},
                          {"setup": "radiation BC with sink temperature given in degC without absoluteZero handling", "code": "THM_UNITS_MISMATCH"},
                          {"setup": "transient case without initial temperature", "code": "THM_INITIAL_TEMPERATURE_MISSING"},
                          {"setup": "no temperature BC, film or radiation anywhere (steady)", "code": "THM_NO_HEAT_PATH"},
                          {"setup": "k(T) table evaluated outside its valid range at a solved temperature", "code": "THM_PROPERTY_OUT_OF_RANGE"},
                          {"setup": "heat balance residual 5 % after solve", "code": "THM_HEAT_BALANCE"},
                          {"setup": "agent calls dispose_thermal_limit", "code": "THM_HUMAN_GATE"},
                          {"setup": "add_temperature_limit without source", "code": "THM_LIMIT_SOURCE_REQUIRED"},
                          {"setup": "film BC with numeric h and no source", "code": "THM_SOURCE_REQUIRED"},
                      ]))

    cases.append(case("VC-THM-30", "CalculiX cavity view factor vs compute_view_factors for VC-THM-09.a geometry", None, "1", {"abs": 0.002},
                      "TBD - measure with bundled ccx (*VIEWFACTOR, WRITE) and llull TS factors", "TBD", ["FR-THM-06", "TR-THM-20", "TR-THM-21"],
                      note="not a gate until measured; the manual calls CalculiX view factors approximate (S7)"))
    cases.append(case("VC-THM-50", "stale thermal results are refused", None, "-", {"exact": True}, "05 TR-FEA-06 + TR-THM-32", "A",
                      ["FR-THM-15", "FR-THM-18", "TR-THM-32"],
                      expected={"thermal_report.state": "stale", "check_temperature_limits.code": "FEA_RESULTS_STALE", "dependentThermoStatic.state": "stale"}))
    cases.append(case("VC-THM-62", "limit exceedance needs a human disposition", None, "-", {"exact": True}, "AF-33, AF-34", "A",
                      ["FR-THM-13", "FR-THM-22", "FR-THM-23", "TR-THM-52"],
                      inputs={"limit_max_degC": 150.0, "limit_source": "test input of this validation case", "case": "VC-THM-01 wall (max T 170.81 degC)"},
                      expected={"row.status": "FAIL", "row.code": "THM_LIMIT_EXCEEDED", "row.marginK": sig(150.0 - ts1), "row.reviewRequired": True,
                                "row.disposition": "pending_human", "dispose_thermal_limit(agent).code": "THM_HUMAN_GATE", "documentHashUnchanged": True}))
    cases.append(case("VC-THM-63", "unverified conductivity propagates", None, "-", {"exact": True}, "AF-32", "A", ["FR-THM-22", "TR-THM-50"],
                      inputs={"k": "08 record value with basis 'typical'"},
                      expected={"thermal_report.unverified": True, "limitRows[*].unverified": True, "check_thermal.items": ["THM_MATERIAL_UNVERIFIED"]}))

    data = {"pack": "03-thermal-analysis", "generatedBy": "generate_thermal_reference.py", "cases": cases}
    with open(os.path.join(HERE, "expected_results.json"), "w", encoding="utf-8", newline="\n") as fh:
        json.dump(data, fh, indent=1, ensure_ascii=False)
        fh.write("\n")

    with open(os.path.join(HERE, "t3_history.csv"), "w", encoding="utf-8", newline="") as fh:
        wr = csv.writer(fh, lineterminator="\n")
        wr.writerow(["t_s", "T_x0p08_degC", "T_x0p05_degC", "T_boundary_degC"])
        for t in range(0, 33, 2):
            wr.writerow([t, sig(t3_temperature(0.08, float(t), 4000), 9), sig(t3_temperature(0.05, float(t), 4000), 9), sig(100 * math.sin(math.pi * t / 40), 9)])

    with open(os.path.join(HERE, "t4_edge_profile.csv"), "w", encoding="utf-8", newline="") as fh:
        wr = csv.writer(fh, lineterminator="\n")
        wr.writerow(["x_m", "y_m", "T_degC"])
        for i in range(1, 11):
            y = i / 10.0
            wr.writerow([0.6, y, sig(t4_temperature(0.6, y), 9)])
        for i in range(0, 7):
            x = i / 10.0
            wr.writerow([x, 0.2, sig(t4_temperature(x, 0.2), 9)])

    with open(os.path.join(HERE, "view_factors.csv"), "w", encoding="utf-8", newline="") as fh:
        wr = csv.writer(fh, lineterminator="\n")
        wr.writerow(["configuration", "parameter", "F_closed_form"])
        for r in (0.1, 0.5, 1.0, 2.0, 5.0, 10.0):
            wr.writerow(["parallel_squares_side_over_spacing", r, sig(vf_parallel(r, r, 1.0), 9)])
        for r in (0.1, 0.5, 1.0, 2.0, 5.0):
            wr.writerow(["perpendicular_squares_common_edge_h_over_l", r, sig(vf_perpendicular(1.0, 1.0, r), 9)])
        for r in (0.25, 0.5, 1.0, 2.0, 4.0):
            wr.writerow(["coaxial_equal_discs_radius_over_spacing", r, sig(vf_coaxial_discs(r, r, 1.0), 9)])


if __name__ == "__main__":
    main()
