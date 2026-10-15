#!/usr/bin/env python3
"""
Generate the reference datasets of PHY-05 (nonlinear structural analysis, prefix NLS).

Run:  python3 -I generate_nls_reference.py      (stdlib only, deterministic, writes next to this script)

Outputs
  expected_results.json            cases in the README section 6.3 schema (consumed by the PHY-00 harness)
  elastica_cantilever.csv          inextensible cantilever with a vertical tip load (Bisshopp-Drucker elastica)
  lee_frame_path.csv               Lee frame equilibrium path, 20 corotational beam elements per leg (arc-length)
  thick_cylinder_elastic_plastic.csv  internal pressure vs elastic-plastic radius, elastic-perfectly plastic tube
  moment_curvature_rectangle.csv   M/My vs kappa/kappa_y, rectangular section, elastic-perfectly plastic

Method notes (sources in sources.md):
  * Elastica: closed form in elliptic integrals (Bisshopp & Drucker 1945 [S10]); integrals evaluated with
    composite Gauss-Legendre quadrature on the smooth amplitude variable. Cross-checked by the independent
    corotational beam solver below (two methods, one script).
  * Lee frame: 2D corotational Euler-Bernoulli beam (Crisfield's formulation), spherical arc-length with
    Newton iterations. Geometry and section of NAFEMS NL7 as quoted by the Abaqus benchmark [S1]: L = 120,
    E = 720, A = 6, I = 2, load at 24 from the corner, both supports pinned. Load is reported normalised as
    P L^2 / (E I) and displacement as v / L.
  * Thick cylinder: Lame elastic solution; Tresca and von Mises (k = sigma_y / sqrt 3, plane strain,
    incompressible plastic zone) elastic-plastic boundary relation; von Mises first yield with the elastic
    plane-strain axial stress (nu explicit); limit (collapse) pressure from limit analysis.
  * Plastic hinges: M_p = sigma_y b h^2 / 4; virtual-work collapse loads.
  * Imperfect column: small-deflection amplification w = w0 / (1 - P / P_cr) for a sinusoidal imperfection.

Values are stored with 12 significant digits. Tolerances are llull acceptance choices (README).
"""

from __future__ import annotations

import csv
import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))


def out(name: str) -> str:
    return os.path.join(HERE, name)


def r12(x: float) -> float:
    if x == 0 or not math.isfinite(x):
        return x
    return float(f"{x:.12g}")


# -------------------------------------------------------------------------------------------------
# Gauss-Legendre nodes (Newton on P_n), used for elliptic integrals
# -------------------------------------------------------------------------------------------------
def gauss_legendre(n: int) -> list[tuple[float, float]]:
    pts = []
    for i in range(1, n + 1):
        x = math.cos(math.pi * (i - 0.25) / (n + 0.5))
        for _ in range(100):
            p0, p1 = 1.0, x
            for k in range(2, n + 1):
                p0, p1 = p1, ((2 * k - 1) * x * p1 - (k - 1) * p0) / k
            dp = n * (x * p1 - p0) / (x * x - 1.0)
            dx = p1 / dp
            x -= dx
            if abs(dx) < 1e-16:
                break
        pts.append((x, 2.0 / ((1 - x * x) * dp * dp)))
    return pts


GL = gauss_legendre(24)


def integrate(f, a: float, b: float, panels: int = 64) -> float:
    h = (b - a) / panels
    s = 0.0
    for j in range(panels):
        m = a + (j + 0.5) * h
        for x, w in GL:
            s += w * f(m + 0.5 * h * x)
    return s * 0.5 * h


def ell_F(phi: float, k: float) -> float:
    return integrate(lambda t: 1.0 / math.sqrt(1.0 - (k * math.sin(t)) ** 2), 0.0, phi)


def ell_E(phi: float, k: float) -> float:
    return integrate(lambda t: math.sqrt(1.0 - (k * math.sin(t)) ** 2), 0.0, phi)


# -------------------------------------------------------------------------------------------------
# 1. Elastica: cantilever, vertical end load P (direction fixed), inextensible, EI constant
#    theta0 = tip slope; k^2 = (1 + sin theta0) / 2; sin phi1 = 1 / (k sqrt 2)
#    alpha L = K(k) - F(phi1, k)  with alpha^2 = P / EI  ->  lambda = P L^2 / EI = (alpha L)^2
#    delta_v / L = 1 - 2 (E(k) - E(phi1, k)) / (alpha L) ;  x_tip / L = sqrt(2 sin theta0) / (alpha L)
# -------------------------------------------------------------------------------------------------
def elastica_from_theta0(theta0: float) -> tuple[float, float, float]:
    k = math.sqrt((1.0 + math.sin(theta0)) / 2.0)
    phi1 = math.asin(1.0 / (k * math.sqrt(2.0)))
    aL = ell_F(math.pi / 2, k) - ell_F(phi1, k)
    dv = 1.0 - 2.0 * (ell_E(math.pi / 2, k) - ell_E(phi1, k)) / aL
    xt = math.sqrt(2.0 * math.sin(theta0)) / aL
    return aL * aL, dv, 1.0 - xt


def elastica(lam: float) -> dict:
    lo, hi = 1e-9, math.pi / 2 - 1e-12
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        if elastica_from_theta0(mid)[0] < lam:
            lo = mid
        else:
            hi = mid
    th = 0.5 * (lo + hi)
    lam_c, dv, dh = elastica_from_theta0(th)
    return {"lambda": lam, "tipSlopeRad": th, "deltaVOverL": dv, "deltaHOverL": dh, "linearDeltaVOverL": lam / 3.0}


# -------------------------------------------------------------------------------------------------
# 2. Corotational 2D Euler-Bernoulli beam + arc-length (banded LU, no pivoting; DOFs ordered along a chain)
# -------------------------------------------------------------------------------------------------
def wrap(a: float) -> float:
    return math.atan2(math.sin(a), math.cos(a))


def element(X1, X2, u1, u2, E, A, I):
    dx0, dy0 = X2[0] - X1[0], X2[1] - X1[1]
    L0 = math.hypot(dx0, dy0)
    b0 = math.atan2(dy0, dx0)
    dx, dy = dx0 + u2[0] - u1[0], dy0 + u2[1] - u1[1]
    L = math.hypot(dx, dy)
    b = math.atan2(dy, dx)
    c, s = dx / L, dy / L
    t1, t2 = wrap(u1[2] + b0 - b), wrap(u2[2] + b0 - b)
    ul = (L * L - L0 * L0) / (L + L0)
    N = E * A / L0 * ul
    M1 = E * I / L0 * (4 * t1 + 2 * t2)
    M2 = E * I / L0 * (2 * t1 + 4 * t2)
    B = ((-c, -s, 0.0, c, s, 0.0), (-s / L, c / L, 1.0, s / L, -c / L, 0.0), (-s / L, c / L, 0.0, s / L, -c / L, 1.0))
    q = (N, M1, M2)
    f = [B[0][j] * q[0] + B[1][j] * q[1] + B[2][j] * q[2] for j in range(6)]
    D = ((E * A / L0, 0.0, 0.0), (0.0, 4 * E * I / L0, 2 * E * I / L0), (0.0, 2 * E * I / L0, 4 * E * I / L0))
    DB = [[sum(D[i][k] * B[k][j] for k in range(3)) for j in range(6)] for i in range(3)]
    K = [[sum(B[i][a] * DB[i][bb] for i in range(3)) for bb in range(6)] for a in range(6)]
    rr = (s, -c, 0.0, -s, c, 0.0)
    zz = (-c, -s, 0.0, c, s, 0.0)
    for a in range(6):
        for bb in range(6):
            K[a][bb] += N / L * rr[a] * rr[bb] + (M1 + M2) / (L * L) * (rr[a] * zz[bb] + zz[a] * rr[bb])
    return f, K


class Frame:
    def __init__(self, nodes, elems, fixed, E, A, I):
        self.nodes, self.elems, self.E, self.A, self.I = nodes, elems, E, A, I
        self.n = 3 * len(nodes)
        self.free = [i for i in range(self.n) if i not in fixed]
        self.pos = {d: k for k, d in enumerate(self.free)}
        self.m = len(self.free)
        self.bw = 6

    def assemble(self, u):
        F = [0.0] * self.n
        Kb = [dict() for _ in range(self.m)]
        for a, b in self.elems:
            f, k = element(self.nodes[a], self.nodes[b], u[3 * a:3 * a + 3], u[3 * b:3 * b + 3], self.E, self.A, self.I)
            dofs = (3 * a, 3 * a + 1, 3 * a + 2, 3 * b, 3 * b + 1, 3 * b + 2)
            for i in range(6):
                F[dofs[i]] += f[i]
                pi = self.pos.get(dofs[i])
                if pi is None:
                    continue
                for j in range(6):
                    pj = self.pos.get(dofs[j])
                    if pj is not None:
                        Kb[pi][pj] = Kb[pi].get(pj, 0.0) + k[i][j]
        return F, Kb

    def factor(self, Kb):
        m, bw = self.m, self.bw
        rows = [[Kb[i].get(j, 0.0) for j in range(max(0, i - bw), min(m, i + bw + 1))] for i in range(m)]
        M = [dict(enumerate(r, start=max(0, i - bw))) for i, r in enumerate(rows)]
        L = [dict() for _ in range(m)]
        for c in range(m):
            piv = M[c][c]
            for r in range(c + 1, min(m, c + bw + 1)):
                v = M[r].get(c, 0.0)
                if v == 0.0:
                    continue
                f = v / piv
                L[r][c] = f
                for kcol in range(c, min(m, c + bw + 1)):
                    M[r][kcol] = M[r].get(kcol, 0.0) - f * M[c].get(kcol, 0.0)
        return L, M

    def solve(self, LU, b):
        L, U = LU
        m, bw = self.m, self.bw
        y = list(b)
        for r in range(m):
            for c, f in L[r].items():
                y[r] -= f * y[c]
        x = [0.0] * m
        for r in range(m - 1, -1, -1):
            s = y[r]
            for c in range(r + 1, min(m, r + bw + 1)):
                s -= U[r].get(c, 0.0) * x[c]
            x[r] = s / U[r][r]
        return x


def arclength(fr: Frame, Pref, dl: float, nmax: int, stop):
    n, m, free = fr.n, fr.m, fr.free
    Pf = [Pref[i] for i in free]
    u = [0.0] * n
    lam = 0.0
    path = [(0.0, u[:])]
    du_prev = None
    for _ in range(nmax):
        F, Kb = fr.assemble(u)
        LU = fr.factor(Kb)
        ut = fr.solve(LU, Pf)
        dlam = dl / math.sqrt(sum(x * x for x in ut))
        if du_prev is not None and sum(ut[i] * du_prev[i] for i in range(m)) < 0:
            dlam = -dlam
        Du = [dlam * x for x in ut]
        Dlam = dlam
        ok = False
        for _it in range(60):
            uc = u[:]
            for k, i in enumerate(free):
                uc[i] = u[i] + Du[k]
            F, Kb = fr.assemble(uc)
            R = [(lam + Dlam) * Pref[i] - F[i] for i in free]
            if math.sqrt(sum(x * x for x in R)) < 1e-9 * max(1.0, abs(lam + Dlam)):
                ok = True
                break
            LU = fr.factor(Kb)
            ut = fr.solve(LU, Pf)
            ur = fr.solve(LU, R)
            a = sum(x * x for x in ut)
            bq = 2 * sum(ut[k] * (Du[k] + ur[k]) for k in range(m))
            cq = sum((Du[k] + ur[k]) ** 2 for k in range(m)) - dl * dl
            disc = bq * bq - 4 * a * cq
            if disc < 0:
                break
            r1 = (-bq + math.sqrt(disc)) / (2 * a)
            r2 = (-bq - math.sqrt(disc)) / (2 * a)
            c1 = sum(Du[k] * (Du[k] + ur[k] + r1 * ut[k]) for k in range(m))
            c2 = sum(Du[k] * (Du[k] + ur[k] + r2 * ut[k]) for k in range(m))
            dd = r1 if c1 >= c2 else r2
            Du = [Du[k] + ur[k] + dd * ut[k] for k in range(m)]
            Dlam += dd
        if not ok:
            raise RuntimeError("arc-length step did not converge")
        for k, i in enumerate(free):
            u[i] += Du[k]
        lam += Dlam
        du_prev = Du
        path.append((lam, u[:]))
        if stop(lam, u):
            break
    return path


def lee_frame(ne: int, dl: float):
    Lm, E, A, I = 120.0, 720.0, 6.0, 2.0
    nodes = [(0.0, Lm * i / ne) for i in range(ne + 1)] + [(Lm * i / ne, Lm) for i in range(1, ne + 1)]
    elems = [(i, i + 1) for i in range(len(nodes) - 1)]
    ln = [i for i, p in enumerate(nodes) if abs(p[0] - 24.0) < 1e-9 and abs(p[1] - Lm) < 1e-9][0]
    last = len(nodes) - 1
    fr = Frame(nodes, elems, {0, 1, 3 * last, 3 * last + 1}, E, A, I)
    Pref = [0.0] * fr.n
    Pref[3 * ln + 1] = -1.0
    norm = Lm * Lm / (E * I)
    path = arclength(fr, Pref, dl, 100000, lambda lam, u: lam * norm > 35.0)
    pts = [(lam * norm, -u[3 * ln + 1] / Lm, u[3 * ln] / Lm) for lam, u in path]
    # first limit point: parabola through the three samples around the first load maximum
    i = 1
    while pts[i + 1][0] > pts[i][0]:
        i += 1
    (x0, y0), (x1, y1), (x2, y2) = [(pts[k][1], pts[k][0]) for k in (i - 1, i, i + 1)]
    d = (x0 - x1) * (x0 - x2) * (x1 - x2)
    a = (x2 * (y1 - y0) + x1 * (y0 - y2) + x0 * (y2 - y1)) / d
    b = (x2 * x2 * (y0 - y1) + x1 * x1 * (y2 - y0) + x0 * x0 * (y1 - y2)) / d
    c = y0 - a * x0 * x0 - b * x0
    v_peak, p_peak = -b / (2 * a), c - b * b / (4 * a)
    v3189 = None
    for k in range(len(pts) - 1):
        if pts[k][1] > 0.6 and pts[k][0] < 31.89 <= pts[k + 1][0]:
            t = (31.89 - pts[k][0]) / (pts[k + 1][0] - pts[k][0])
            v3189 = pts[k][1] + t * (pts[k + 1][1] - pts[k][1])
    p_min = min(p[0] for p in pts)
    return {"elementsPerLeg": ne, "arcLength": dl, "steps": len(path) - 1, "peakLoadNorm": p_peak, "peakVOverL": v_peak,
            "vOverLAtLoad31_89": v3189, "minLoadNorm": p_min}, pts


def corotational_cantilever(lam_targets, ne: int = 20):
    """Cantilever along +x, tip load -y; load control Newton, 200 equal increments up to max lambda."""
    Lm, E, A, I = 1.0, 1.0, 1.0e6, 1.0   # axial rigidity >> bending: inextensible limit
    nodes = [(Lm * i / ne, 0.0) for i in range(ne + 1)]
    fr = Frame(nodes, [(i, i + 1) for i in range(ne)], {0, 1, 2}, E, A, I)
    tip = 3 * ne
    u = [0.0] * fr.n
    res = {}
    lam_max = max(lam_targets)
    steps = 400
    for s in range(1, steps + 1):
        lam = lam_max * s / steps
        for _ in range(60):
            F, Kb = fr.assemble(u)
            R = [0.0] * fr.n
            R[tip + 1] = -lam
            Rf = [R[i] - F[i] for i in fr.free]
            if math.sqrt(sum(x * x for x in Rf)) < 1e-11 * max(1.0, lam):
                break
            du = fr.solve(fr.factor(Kb), Rf)
            for k, i in enumerate(fr.free):
                u[i] += du[k]
        for t in lam_targets:
            if abs(lam - t) < 1e-12:
                res[t] = {"deltaVOverL": -u[tip + 1] / Lm, "deltaHOverL": -u[tip] / Lm, "tipSlopeRad": -u[tip + 2]}
    return res


# -------------------------------------------------------------------------------------------------
# 3. Thick cylinder, internal pressure p, radii a < b, elastic-perfectly plastic, yield stress sy
# -------------------------------------------------------------------------------------------------
def cyl_first_yield_mises_plane_strain(a, b, sy, nu):
    """Lame stresses at r = a per unit p; sigma_z = nu (sigma_r + sigma_theta) (plane strain)."""
    q = a * a / (b * b - a * a)
    sr, st = -1.0, q * (b * b / (a * a) + 1.0)
    sz = nu * (sr + st)
    vm = math.sqrt(0.5 * ((sr - st) ** 2 + (st - sz) ** 2 + (sz - sr) ** 2))
    return sy / vm


def cyl_pressure_at_plastic_radius(a, b, c, k):
    """Boundary pressure with plastic zone a <= r <= c (Tresca: k = sy/2; von Mises incompressible: k = sy/sqrt3)."""
    return k * (1.0 - c * c / (b * b) + 2.0 * math.log(c / a))


# -------------------------------------------------------------------------------------------------
# main
# -------------------------------------------------------------------------------------------------
def main() -> None:
    cases = []

    def case(cid, quantity, value, unit, tol, source, grade, proves, **extra):
        c = {"id": cid, "quantity": quantity, "value": r12(value) if isinstance(value, float) else value, "unit": unit,
             "tolerance": tol, "source": source, "grade": grade, "proves": proves}
        for kk, vv in extra.items():
            c[kk] = vv
        cases.append(c)

    # ---- 1. elastica
    lam_list = [0.25, 0.5, 1.0, 2.0, 3.0, 5.0, 10.0]
    ela = {lam: elastica(lam) for lam in lam_list}
    coro = corotational_cantilever([1.0, 2.0, 5.0, 10.0])
    with open(out("elastica_cantilever.csv"), "w", newline="") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["lambda_PL2_over_EI", "tip_slope_rad", "deltaV_over_L", "deltaH_over_L", "linear_deltaV_over_L",
                    "corotational20_deltaV_over_L", "corotational20_deltaH_over_L"])
        for lam in lam_list:
            e = ela[lam]
            cr = coro.get(lam)
            w.writerow([repr(lam), repr(r12(e["tipSlopeRad"])), repr(r12(e["deltaVOverL"])), repr(r12(e["deltaHOverL"])),
                        repr(r12(e["linearDeltaVOverL"])), repr(r12(cr["deltaVOverL"])) if cr else "",
                        repr(r12(cr["deltaHOverL"])) if cr else ""])
    for tag, lam in (("a", 1.0), ("b", 2.0), ("c", 10.0)):
        e = ela[lam]
        case(f"VC-NLS-10.{tag}", f"elastica cantilever tip vertical deflection / L at PL^2/EI = {lam:g}", e["deltaVOverL"], "1",
             {"rel": 0.01}, "generator (elliptic closed form, S10) + corotational cross-check", "A",
             ["FR-NLS-01", "FR-NLS-08", "TR-NLS-20"],
             inputs={"lambda": lam}, crossCheck={"corotational20": r12(coro[lam]["deltaVOverL"]),
                                                 "linearTheory": r12(lam / 3.0)},
             derivation="alpha L = K(k) - F(phi1,k); dv/L = 1 - 2(E(k) - E(phi1,k))/(alpha L)")
    case("VC-NLS-10.d", "elastica tip horizontal shortening / L at PL^2/EI = 2", ela[2.0]["deltaHOverL"], "1", {"rel": 0.02},
         "generator (S10)", "A", ["FR-NLS-01", "FR-NLS-08"], crossCheck={"corotational20": r12(coro[2.0]["deltaHOverL"])})

    # ---- 2. Lee frame
    lee = {}
    lee_pts = None
    for ne, dl in ((10, 1.0), (20, 1.0), (40, 1.0)):
        info, pts = lee_frame(ne, dl)
        lee[ne] = info
        if ne == 20:
            lee_pts = pts
    with open(out("lee_frame_path.csv"), "w", newline="") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["step", "load_norm_PL2_over_EI", "v_over_L_down", "u_over_L"])
        for k, (p, v, uu) in enumerate(lee_pts):
            if k % 5 == 0 or k == len(lee_pts) - 1:
                w.writerow([k, repr(r12(p)), repr(r12(v)), repr(r12(uu))])
    f40 = lee[40]
    case("VC-NLS-20.a", "Lee frame first limit load P L^2/(E I)", 18.55, "1", {"rel": 0.01},
         "S1 (Abaqus NL7 quoting NAFEMS NNB 1989) + generator corotational arc-length", "A",
         ["FR-NLS-05", "FR-NLS-08", "TR-NLS-20"], generatorValue=r12(f40["peakLoadNorm"]),
         meshStudy={str(k): {"peak": r12(v["peakLoadNorm"]), "vAtPeak": r12(v["peakVOverL"])} for k, v in lee.items()})
    case("VC-NLS-20.b", "Lee frame vertical displacement / L at the first limit load", 0.407, "1", {"abs": 0.004},
         "S1 + generator", "A", ["FR-NLS-05", "FR-NLS-08"], generatorValue=r12(f40["peakVOverL"]))
    case("VC-NLS-20.c", "Lee frame vertical displacement / L where the loaded path reaches P L^2/(E I) = 31.89", 0.781, "1",
         {"abs": 0.004}, "S1 (Abaqus 0.781; NAFEMS reference 0.784) + generator", "A", ["FR-NLS-05", "FR-NLS-08"],
         generatorValue=r12(f40["vOverLAtLoad31_89"]), note="NAFEMS quotes 0.784; Abaqus and this generator give 0.781")
    case("VC-NLS-20.d", "Lee frame minimum (most negative) load on the snap-back branch P L^2/(E I)", f40["minLoadNorm"], "1",
         {"rel": 0.03}, "generator only (single method)", "B", ["FR-NLS-05"],
         meshStudy={str(k): r12(v["minLoadNorm"]) for k, v in lee.items()})

    # ---- 3. thick cylinder (llull test geometry a = 100 mm, b = 200 mm; NL2 material as quoted by S1)
    a, b, sy, nu = 100.0, 200.0, 207.9, 0.3
    k_t, k_m = sy / 2.0, sy / math.sqrt(3.0)
    py_tresca = k_t * (1.0 - a * a / (b * b))
    py_mises_inc = k_m * (1.0 - a * a / (b * b))
    py_mises_nu = cyl_first_yield_mises_plane_strain(a, b, sy, nu)
    pc_tresca = 2.0 * k_t * math.log(b / a)
    pc_mises = 2.0 * k_m * math.log(b / a)
    with open(out("thick_cylinder_elastic_plastic.csv"), "w", newline="") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["c_mm", "c_over_a", "p_tresca_MPa", "p_mises_incompressible_MPa"])
        for i in range(0, 21):
            c = a + (b - a) * i / 20
            w.writerow([repr(r12(c)), repr(r12(c / a)), repr(r12(cyl_pressure_at_plastic_radius(a, b, c, k_t))),
                        repr(r12(cyl_pressure_at_plastic_radius(a, b, c, k_m)))])
    inp = {"a_mm": a, "b_mm": b, "sigma_y_MPa": sy, "nu": nu, "E_MPa": 207000.0}
    case("VC-NLS-30.a", "thick cylinder first-yield pressure, von Mises, plane strain, nu = 0.3", py_mises_nu, "MPa",
         {"rel": 0.02}, "generator (Lame + plane strain + von Mises)", "A", ["FR-NLS-02", "FR-NLS-06", "TR-NLS-21"], inputs=inp)
    case("VC-NLS-30.b", "thick cylinder collapse (limit) pressure, von Mises plane strain", pc_mises, "MPa",
         {"rel": 0.02}, "generator (limit analysis, k = sy/sqrt3)", "A", ["FR-NLS-02", "FR-NLS-05", "FR-NLS-06"], inputs=inp,
         derivation="p_c = (2/sqrt3) sy ln(b/a)")
    case("VC-NLS-30.c", "thick cylinder collapse pressure, Tresca", pc_tresca, "MPa", {"rel": 1e-9}, "generator", "A",
         ["FR-NLS-06"], inputs=inp, derivation="p_c = sy ln(b/a)")
    case("VC-NLS-30.d", "thick cylinder first-yield pressure, Tresca", py_tresca, "MPa", {"rel": 1e-9}, "generator", "A",
         ["FR-NLS-06"], inputs=inp, derivation="p_y = (sy/2)(1 - a^2/b^2)")
    case("VC-NLS-30.e", "pressure for plastic radius c = 150 mm, von Mises incompressible", cyl_pressure_at_plastic_radius(a, b, 150.0, k_m),
         "MPa", {"rel": 0.03}, "generator (S11 form)", "A", ["FR-NLS-02", "FR-NLS-06"], inputs=inp,
         note="FE gate uses nu = 0.49 so the incompressible closed form applies; see README")
    case("VC-NLS-31", "NAFEMS NL2 stress tables (radial and hoop stress at 8 radii, 80-160 MPa)", "TBD", "MPa", {"rel": None},
         "S1 search extract: material quoted, tables and radii not obtained", "C", ["FR-NLS-02"],
         consistency={"generator_pc_mises_if_a100_b200_MPa": r12(pc_mises), "nl2_max_pressure_MPa": 160.0,
                      "generator_py_mises_nu03_MPa": r12(py_mises_nu)})

    # ---- 4. plastic hinges (rectangle b x h, sy) and moment-curvature
    bb, hh, syb, Lb = 10.0, 20.0, 250.0, 500.0
    My = syb * bb * hh * hh / 6.0
    Mp = syb * bb * hh * hh / 4.0
    hinge = {"cantilever_tip": Mp / Lb, "simply_supported_central": 4 * Mp / Lb, "propped_cantilever_central": 6 * Mp / Lb,
             "fixed_fixed_central": 8 * Mp / Lb}
    with open(out("moment_curvature_rectangle.csv"), "w", newline="") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["kappa_over_kappa_y", "M_over_My"])
        for i in range(0, 41):
            x = 0.25 * i
            m = x if x <= 1.0 else 1.5 * (1.0 - 1.0 / (3.0 * x * x))
            w.writerow([repr(r12(x)), repr(r12(m))])
    pin = {"b_mm": bb, "h_mm": hh, "sigma_y_MPa": syb, "L_mm": Lb}
    case("VC-NLS-40.a", "plastic moment M_p of a 10 x 20 mm rectangle, sy = 250 MPa", Mp, "N*mm", {"rel": 1e-9}, "generator", "A",
         ["FR-NLS-07"], inputs=pin, derivation="M_p = sy b h^2 / 4; shape factor 1.5")
    case("VC-NLS-40.b", "collapse tip load of a cantilever (L = 500 mm)", hinge["cantilever_tip"], "N", {"rel": 0.03},
         "generator (S12 virtual work)", "A", ["FR-NLS-05", "FR-NLS-07"], inputs=pin, derivation="P_c = M_p / L",
         note="FE: solid C3D20R, perfectly plastic, small strain; limit_load reads the plateau of the load-displacement curve")
    case("VC-NLS-40.c", "collapse central load, propped cantilever", hinge["propped_cantilever_central"], "N", {"rel": 0.03},
         "generator (S12)", "A", ["FR-NLS-05", "FR-NLS-07"], inputs=pin, derivation="P_c = 6 M_p / L")
    case("VC-NLS-40.d", "collapse central load, fixed-fixed beam (small deflection)", hinge["fixed_fixed_central"], "N", {"rel": 0.03},
         "generator (S12)", "A", ["FR-NLS-07"], inputs=pin, derivation="P_c = 8 M_p / L (NLGEOM off: membrane action excluded)")
    case("VC-NLS-40.e", "elastic-plastic moment at kappa = 2 kappa_y, M / M_y", 1.5 * (1 - 1 / 12.0), "1", {"rel": 1e-9},
         "generator", "A", ["FR-NLS-07"], derivation="M/My = 1.5 (1 - (kappa_y/kappa)^2 / 3)")

    # ---- 5. imperfect pinned column, sinusoidal imperfection w0 (small deflection)
    E, I_c, Lc, w0 = 70000.0, 20.0 * 10.0 ** 3 / 12.0, 500.0, 0.5
    Pcr = math.pi ** 2 * E * I_c / Lc ** 2
    case("VC-NLS-50.a", "pinned column Euler load (20 x 10 mm, L = 500 mm, E = 70 GPa)", Pcr, "N", {"rel": 0.02}, "generator", "A",
         ["FR-NLS-09"], derivation="P_cr = pi^2 E I / L^2 (weak axis)")
    for tag, ratio in (("b", 0.5), ("c", 0.8)):
        case(f"VC-NLS-50.{tag}", f"mid-span lateral deflection at P = {ratio} P_cr, w0 = 0.5 mm (first-mode shape)",
             w0 / (1 - ratio) - w0, "mm", {"rel": 0.05}, "generator (amplification w0/(1-P/Pcr))", "A", ["FR-NLS-09", "FR-NLS-10"],
             inputs={"E_MPa": E, "L_mm": Lc, "w0_mm": w0, "PoverPcr": ratio},
             note="additional deflection w - w0 = w0 (P/Pcr)/(1 - P/Pcr); FE with NLGEOM and the imperfection from the buckling mode")

    # ---- 6. agent-first contract (no numbers invented: structure only)
    case("VC-NLS-60", "nonlinear_report on a load-controlled run that passes a limit point", "NLS_LIMIT_POINT_REACHED", "code",
         {"exact": True}, "TECHNICAL_SPEC 7.1", "A", ["FR-NLS-05", "FR-NLS-13"])
    case("VC-NLS-61", "snap-back detected on a displacement-controlled run", "NLS_SNAP_BACK_DETECTED", "code", {"exact": True},
         "TECHNICAL_SPEC 7.1", "A", ["FR-NLS-04", "FR-NLS-13"])
    case("VC-NLS-62", "add_imperfection without amplitude", "NLS_IMPERFECTION_AMPLITUDE_UNSET", "code", {"exact": True},
         "TECHNICAL_SPEC 7.1 (AF-31)", "A", ["FR-NLS-10", "FR-NLS-15"])
    case("VC-NLS-63", "request arc-length control on the bundled CalculiX", "NLS_ARC_LENGTH_UNSUPPORTED", "code", {"exact": True},
         "S2 (CalculiX manual: no RIKS on *STATIC)", "A", ["FR-NLS-04", "FR-NLS-13"])

    case("VC-NLS-64", "every nonlinear_report / limit_load / check_nonlinear result", "reviewRequired=true", "flag", {"exact": True},
         "AGENT_FIRST AF-33", "A", ["FR-NLS-17"])
    case("VC-NLS-65", "every control value, threshold and amplitude in data is {value, source, defaulted}", "named", "shape",
         {"exact": True}, "AGENT_FIRST AF-31", "A", ["FR-NLS-03", "FR-NLS-15"])
    case("VC-NLS-66", "limit_load on a PHY-02 model marked unverified", "unverified=true + NLS_MATERIAL_MODEL_UNVERIFIED", "flag",
         {"exact": True}, "AGENT_FIRST AF-32", "A", ["FR-NLS-16"])
    case("VC-NLS-67", "agent calls dispose_margin on a FAIL row with criterion limit_load", "FEA_HUMAN_GATE", "code", {"exact": True},
         "aerospace 05 FR-FEA-33 (AF-34)", "A", ["FR-NLS-14"])
    case("VC-NLS-68", "limit-load margin row without a PHY-00 convergence study", "VNV_NO_CONVERGENCE_STUDY", "code", {"exact": True},
         "PHY-00 TECHNICAL_SPEC 7.1", "A", ["FR-NLS-19"])
    case("VC-NLS-69", "Code_Aster export of the cantilever case re-run in a user-installed code_aster (V2)", "TBD", "N",
         {"rel": None}, "TBD — needs a code_aster install", "TBD", ["FR-NLS-20"])
    case("VC-NLS-71", "check_nonlinear guardrails on deliberately wrong set-ups", "NLS_IMPERFECTION_MISSING, NLS_NLGEOM_RECOMMENDED, "
         "NLS_STRAIN_BEYOND_CURVE, NLS_MESH_PLASTIC_ADEQUACY, NLS_PERMANENT_SET_THRESHOLD_UNSET", "codes", {"exact": True},
         "TECHNICAL_SPEC 7.1", "A", ["FR-NLS-10", "FR-NLS-07"])
    case("VC-NLS-41", "pinned CalculiX decks beampiso / beampkin / beampd: displacements per increment equal the .dat.ref files",
         "TBD", "mm", {"rel": 1e-4}, "S2 test suite (values to be extracted by the M2 reader and frozen)", "TBD",
         ["FR-NLS-02", "FR-NLS-06", "TR-NLS-04"])
    case("VC-NLS-70", "wall time, 20k-node C3D20R cantilever collapse, 50 increments", "TBD", "s", {"rel": None},
         "TBD — measure on the reference desktop", "TBD", ["FR-NLS-18"])

    doc = {"pack": "05-nonlinear-structural", "generatedBy": "generate_nls_reference.py",
           "units": "N, mm, MPa unless stated; normalised quantities have unit 1", "cases": cases}
    with open(out("expected_results.json"), "w") as fh:
        json.dump(doc, fh, indent=1, sort_keys=False)
        fh.write("\n")


if __name__ == "__main__":
    main()
