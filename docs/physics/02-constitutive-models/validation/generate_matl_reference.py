#!/usr/bin/env python3
"""Reference-result generator for llull gap PHY-02 MATL (docs/physics/02-constitutive-models).

Python 3 standard library only. Run from this folder:
    python3 -I generate_matl_reference.py           # writes expected_results.json
    python3 -I generate_matl_reference.py --check   # exit 1 if the committed JSON differs

Inputs: treloar_1944_steinmann2012.csv (pinned Treloar table, grade B). Everything else is a closed-form
derivation or a labelled synthetic fixture. The integrators below are the reference algorithms of
TECHNICAL_SPEC §5 (small-strain J2 radial return, backward Euler), written out so that an implementation can be
compared increment for increment. Values are stored with 12 significant digits.
"""
from __future__ import annotations

import json
import math
import sys
from fractions import Fraction
from pathlib import Path

HERE = Path(__file__).parent
OUT = HERE / "expected_results.json"
R_GAS = 6.02214076e23 * 1.380649e-23  # SI 2019 exact


def sig(x: float, digits: int = 12) -> float:
    return float(f"{x:.{digits}g}")


def case(cid, quantity, value, unit, tol, source, grade, proves, **extra) -> dict:
    c = {"id": cid, "quantity": quantity, "value": value, "unit": unit, "tolerance": tol, "source": source, "grade": grade,
         "proves": proves}
    c.update(extra)
    return c


# ---------------------------------------------------------------- §5.3 J2 radial return, plane strain, strain driven
def nl1_run(E: float, nu: float, sy0: float, h_plastic: float, path: list, nsub: int) -> list[float]:
    """NAFEMS NL1 path: (exx, eyy) in units of 1e-4, ezz = 0, shear = 0; linear isotropic hardening, closed-form return."""
    g, k = E / (2 * (1 + nu)), E / (3 * (1 - 2 * nu))
    sig3, ep, prev, out = [0.0, 0.0, 0.0], 0.0, (0.0, 0.0), []
    for ex, ey in path:
        for _ in range(nsub):
            de = [(ex - prev[0]) / nsub * 1e-4, (ey - prev[1]) / nsub * 1e-4, 0.0]
            tr = sum(de)
            s = [sig3[i] + 2 * g * (de[i] - tr / 3) + k * tr for i in range(3)]
            p = sum(s) / 3
            dev = [x - p for x in s]
            q = math.sqrt(1.5 * sum(d * d for d in dev))
            sy = sy0 + h_plastic * ep
            if q > sy:
                dl = (q - sy) / (3 * g + h_plastic)
                dev = [d * (1 - 3 * g * dl / q) for d in dev]
                ep += dl
                s = [d + p for d in dev]
            sig3 = s
        prev = (ex, ey)
        p = sum(sig3) / 3
        out.append(math.sqrt(1.5 * sum((x - p) ** 2 for x in sig3)))
    return out


NL1_PATH = [(0.25, 0.0), (0.5, 0.0), (0.5, 0.25), (0.5, 0.5), (0.25, 0.5), (0.0, 0.5), (0.0, 0.25), (0.0, 0.0)]
# Quoted (S1/S2 search extracts of the Abaqus Benchmarks Guide 4.6.1, citing NAFEMS NNB 1989): point index -> value.
NL1_TARGET_PERFECT = {3: 5.000, 7: 3.917}
NL1_TARGET_HARD = {3: 5.482, 6: 7.322, 7: 4.230}
NL1_ABAQUS_PERFECT = {7: 3.824}
NL1_ABAQUS_HARD = {3: 5.482, 7: 4.114}


def nl1_cases() -> list[dict]:
    out = []
    E, nu, sy = 250e3, 0.25, 5.0
    c11 = E * (1 - nu) / ((1 + nu) * (1 - 2 * nu))
    sx, syy = c11 * 0.25e-4, c11 * nu / (1 - nu) * 0.25e-4
    out.append(case("VC-MATL-01/firstYield", "von Mises stress at exx = 0.25e-4 (plane strain, elastic)", sig(sx - syy), "MPa", {"rel": 1e-12},
                    "closed form: sigma_x - sigma_y = E/(1+nu) * exx", "A", ["FR-MATL-10", "TR-MATL-05"]))
    for label, h, targets, abaqus, vc in (("perfect", 0.0, NL1_TARGET_PERFECT, NL1_ABAQUS_PERFECT, "VC-MATL-01"),
                                          ("isotropicH62500", 62.5e3, NL1_TARGET_HARD, NL1_ABAQUS_HARD, "VC-MATL-02")):
        n10, n1000, conv = (nl1_run(E, nu, sy, h, NL1_PATH, n) for n in (10, 1000, 100000))
        for i, (ex, ey) in enumerate(NL1_PATH, start=1):
            pid = f"{vc}/{label}/point{i}({ex},{ey})e-4"
            out.append(case(f"{pid}/N10", "effective stress, 10 equal increments per segment (algorithm identity)", sig(n10[i - 1]), "MPa",
                            {"rel": 1e-9}, "reference integrator §5.3", "A", ["FR-MATL-10", "TR-MATL-05"]))
            out.append(case(f"{pid}/N1000", "effective stress, 1000 increments per segment", sig(n1000[i - 1]), "MPa", {"rel": 1e-9},
                            "reference integrator §5.3", "A", ["FR-MATL-10", "TR-MATL-05"]))
            extra = {"convergedN100000": sig(conv[i - 1])}
            if i in targets:
                extra["nafemsTarget"] = targets[i]
                extra["relDiffConvergedVsTarget"] = sig(conv[i - 1] / targets[i] - 1.0, 4)
            if i in abaqus:
                extra["abaqusCPE4R"] = abaqus[i]
            out.append(case(f"{pid}/converged", "effective stress, converged (N = 100000 per segment)", sig(conv[i - 1]), "MPa",
                            {"rel": 2e-4}, "reference integrator; NAFEMS target quoted for comparison only (B)", "A",
                            ["FR-MATL-10", "TR-MATL-05"], **extra))
    et = 62.5e3
    alt = nl1_run(E, nu, sy, E * et / (E - et), NL1_PATH, 1000)
    out.append(case("VC-MATL-02/hardeningKindMatters/point2", "point 2 if 62.5 GPa were read as a TANGENT modulus (H = E Et/(E - Et))", sig(alt[1]), "MPa",
                    {"rel": 1e-9}, "reference integrator", "A", ["FR-MATL-05", "TR-MATL-03"],
                    note="differs from the plastic-modulus reading (point 2 N1000); the param must state its kind (MATL_HARDENING_MODULUS_KIND_MISSING)"))
    return out


# ---------------------------------------------------------------- §5.1 linear elasticity checks
def inv(m: list[list[Fraction]]) -> list[list[Fraction]]:
    n = len(m)
    a = [row[:] + [Fraction(int(i == j)) for j in range(n)] for i, row in enumerate(m)]
    for c in range(n):
        p = next(r for r in range(c, n) if a[r][c] != 0)
        a[c], a[p] = a[p], a[c]
        a[c] = [x / a[c][c] for x in a[c]]
        for r in range(n):
            if r != c and a[r][c] != 0:
                f = a[r][c]
                a[r] = [x - f * y for x, y in zip(a[r], a[c])]
    return [row[n:] for row in a]


def leading_minors_positive(m: list[list[Fraction]]) -> bool:
    n = len(m)
    a = [r[:] for r in m]
    for c in range(n):  # exact LDL^T style elimination: all pivots > 0 <=> positive definite (symmetric)
        if a[c][c] <= 0:
            return False
        for r in range(c + 1, n):
            f = a[r][c] / a[c][c]
            a[r] = [x - f * y for x, y in zip(a[r], a[c])]
    return True


def compliance(e1, e2, e3, n12, n13, n23, g12, g13, g23) -> list[list[Fraction]]:
    e1, e2, e3, n12, n13, n23, g12, g13, g23 = (Fraction(str(x)) for x in (e1, e2, e3, n12, n13, n23, g12, g13, g23))
    s = [[Fraction(0)] * 6 for _ in range(6)]
    s[0][0], s[1][1], s[2][2] = 1 / e1, 1 / e2, 1 / e3
    s[0][1] = s[1][0] = -n12 / e1
    s[0][2] = s[2][0] = -n13 / e1
    s[1][2] = s[2][1] = -n23 / e2
    s[3][3], s[4][4], s[5][5] = 1 / g12, 1 / g13, 1 / g23  # Voigt order 11 22 33 12 13 23, engineering shear
    return s


def elastic_cases() -> list[dict]:
    out = []
    synth = (135000, 10000, 10000, 0.3, 0.3, 0.45, 5000, 5000, 3448)
    s = compliance(*synth)
    c = inv(s)
    d = [c[0][0], c[0][1], c[1][1], c[0][2], c[1][2], c[2][2], c[3][3], c[4][4], c[5][5]]
    out.append(case("VC-MATL-03/orthoSynthetic/calculixORTHO", "engineering constants -> CalculiX *ELASTIC,TYPE=ORTHO D1111 D1122 D2222 D1133 D2233 D3333 D1212 D1313 D2323",
                    [sig(float(x)) for x in d], "MPa", {"rel": 1e-9}, "synthetic CFRP-like set; exact inversion of the compliance matrix", "A",
                    ["FR-MATL-02", "TR-MATL-02"], engineeringConstants=dict(zip(["E1", "E2", "E3", "nu12", "nu13", "nu23", "G12", "G13", "G23"], synth)),
                    note="tensor shear: D1212 = G12 (S_12 = 2 G12 E_12)"))
    out.append(case("VC-MATL-03/orthoSynthetic/positiveDefinite", "positive definiteness of the synthetic set", leading_minors_positive(s), "bool",
                    {"exact": True}, "exact pivots", "A", ["FR-MATL-03", "TR-MATL-02"]))
    bound = math.sqrt(135000 / 10000)
    bad = compliance(135000, 10000, 10000, 3.8, 0.3, 0.45, 5000, 5000, 3448)
    out.append(case("VC-MATL-03/orthoInvalid/nu12=3.8", f"nu12 = 3.8 > sqrt(E1/E2) = {bound:.6f}: positive definite?", leading_minors_positive(bad), "bool",
                    {"exact": True}, "2x2 leading minor of S: nu12^2 < E1/E2 (Lempriere 1968 bound, S6)", "A", ["FR-MATL-03", "TR-MATL-02"],
                    expectCode="MATL_ELASTIC_NOT_POSITIVE_DEFINITE", bound=sig(bound)))
    manual = [500000, 157200, 400000, 157200, 157200, 300000, 126200, 126200, 126200]
    cm = [[Fraction(0)] * 6 for _ in range(6)]
    cm[0][0], cm[0][1], cm[1][1], cm[0][2], cm[1][2], cm[2][2] = (Fraction(v) for v in manual[:6])
    cm[1][0], cm[2][0], cm[2][1] = cm[0][1], cm[0][2], cm[1][2]
    cm[3][3], cm[4][4], cm[5][5] = (Fraction(v) for v in manual[6:])
    sm = inv(cm)
    eng = {"E1": 1 / sm[0][0], "E2": 1 / sm[1][1], "E3": 1 / sm[2][2], "nu12": -sm[0][1] / sm[0][0], "nu13": -sm[0][2] / sm[0][0],
           "nu23": -sm[1][2] / sm[1][1]}
    out.append(case("VC-MATL-03/ccxManualORTHO/engineeringConstants", "CalculiX manual *ELASTIC,TYPE=ORTHO example converted to engineering constants",
                    {k: sig(float(v)) for k, v in eng.items()}, "MPa / -", {"rel": 1e-9}, "D values quoted from the ccx 2.23 manual (S3); exact inversion",
                    "B", ["FR-MATL-02", "TR-MATL-02"], positiveDefinite=leading_minors_positive(cm)))
    for nu in (0.5, -1.0):
        out.append(case(f"VC-MATL-03/isoBound/nu={nu}", "isotropic nu must satisfy -1 < nu < 0.5", "MATL_POISSON_BOUND", "-", {"exact": True},
                        "bulk K = E/(3(1-2nu)) > 0 and G = E/(2(1+nu)) > 0", "A", ["FR-MATL-03", "TR-MATL-02"]))
    return out


# ---------------------------------------------------------------- §5.4 Ramberg-Osgood, §5.5 kinematic hardening
def plasticity_cases() -> list[dict]:
    out = []
    E, s02, n = 72000.0, 400.0, 15.0  # synthetic
    alpha = 0.002 * E / s02
    out.append(case("VC-MATL-04/RO/alpha", "engineering form eps = s/E + 0.002 (s/s02)^n mapped to CalculiX form E eps = s + alpha (|s|/s0)^(n-1) s, s0 = s02",
                    sig(alpha), "1", {"rel": 1e-12}, "algebra (S3 *DEFORMATION PLASTICITY form; NACA TN 902 three-parameter idea, S5)", "A",
                    ["FR-MATL-04", "TR-MATL-04"]))
    eps = lambda s: s / E + 0.002 * (s / s02) ** n
    out.append(case("VC-MATL-04/RO/strainAt_s02", "total strain at s = s02", sig(eps(s02)), "1", {"rel": 1e-12}, "closed form", "A", ["FR-MATL-04"]))
    lo, hi = 0.0, 1000.0
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        lo, hi = (mid, hi) if eps(mid) < 0.01 else (lo, mid)
    out.append(case("VC-MATL-04/RO/stressAt_eps0.01", "stress at total strain 0.01 (inverse by bisection)", sig(0.5 * (lo + hi)), "MPa", {"rel": 1e-9},
                    "closed-form inverse, bisection to machine precision", "A", ["FR-MATL-04", "TR-MATL-04"]))
    sy, cc, gam = 200.0, 20000.0, 100.0  # synthetic Armstrong-Frederick (one back stress)
    for ep in (0.005, 0.01, 0.05):
        out.append(case(f"VC-MATL-05/AF/monotonic/ep={ep}", "uniaxial stress, s = sy + (C/gamma)(1 - exp(-gamma ep))", sig(sy + cc / gam * (1 - math.exp(-gam * ep))),
                        "MPa", {"rel": 1e-3}, "closed form (Armstrong-Frederick); tolerance allows >= 1000 backward-Euler increments", "A",
                        ["FR-MATL-06", "TR-MATL-05"]))
    out.append(case("VC-MATL-05/AF/saturation", "saturated stress sy + C/gamma", sig(sy + cc / gam), "MPa", {"rel": 1e-9}, "closed form", "A", ["FR-MATL-06"]))
    hk = 10000.0  # synthetic linear (Prager) kinematic, uniaxial plastic modulus
    s_max = sy + hk * 0.01
    out.append(case("VC-MATL-05/Prager/reverseYield", "load to ep = 0.01 then reverse: stress at reverse yield = s_max - 2 sy", sig(s_max - 2 * sy), "MPa",
                    {"rel": 1e-9}, "closed form (elastic range 2 sy translates)", "A", ["FR-MATL-06", "TR-MATL-05"], sMax=sig(s_max)))
    return out


# ---------------------------------------------------------------- §5.6 hyperelasticity (incompressible, homogeneous modes)
def invariants(mode: str, lam):
    if mode == "UT":
        return lam ** 2 + 2 / lam, 2 * lam + 1 / lam ** 2, (lam - 1 / lam ** 2), 1 / lam
    if mode == "ET":
        return 2 * lam ** 2 + 1 / lam ** 4, lam ** 4 + 2 / lam ** 2, (lam - 1 / lam ** 5), lam ** 2
    return lam ** 2 + 1 + 1 / lam ** 2, lam ** 2 + 1 + 1 / lam ** 2, (lam - 1 / lam ** 3), 1  # PS


def nominal_poly(mode: str, lam, cij: dict) -> object:
    """P = 2 (factor) (W1 + w2mult * W2) for W = sum Cij (I1-3)^i (I2-3)^j."""
    i1, i2, factor, w2mult = invariants(mode, lam)
    w1 = sum(c * i * (i1 - 3) ** (i - 1) * (i2 - 3) ** j for (i, j), c in cij.items() if i > 0)
    w2 = sum(c * j * (i1 - 3) ** i * (i2 - 3) ** (j - 1) for (i, j), c in cij.items() if j > 0)
    return 2 * factor * (w1 + w2mult * w2)


def nominal_ogden1972(mode: str, lam: float, mu: list, al: list) -> float:
    if mode == "UT":
        return sum(m * (lam ** (a - 1) - lam ** (-a / 2 - 1)) for m, a in zip(mu, al))
    if mode == "ET":
        return sum(m * (lam ** (a - 1) - lam ** (-2 * a - 1)) for m, a in zip(mu, al))
    return sum(m * (lam ** (a - 1) - lam ** (-a - 1)) for m, a in zip(mu, al))


AB_C = [Fraction(1, 2), Fraction(1, 20), Fraction(11, 1050), Fraction(19, 7000), Fraction(519, 673750)]


def nominal_ab(mode: str, lam: float, mu: float, lm: float) -> float:
    i1, _, factor, _ = invariants(mode, lam)
    w1 = mu * sum(float(c) * (i + 1) * i1 ** i / lm ** (2 * i) for i, c in enumerate(AB_C))
    return 2 * factor * w1


def load_treloar() -> dict:
    data = {"UT": [], "ET": [], "PS": []}
    for line in (HERE / "treloar_1944_steinmann2012.csv").read_text(encoding="utf-8").splitlines():
        if line.startswith("#") or line.startswith("mode") or not line.strip():
            continue
        m, lam, p = line.split(",")
        data[m].append((Fraction(lam), Fraction(p)))
    return data


def lstsq(rows, rhs):
    n = len(rows[0])
    a = [[sum(r[i] * r[j] for r in rows) for j in range(n)] for i in range(n)]
    b = [sum(r[i] * y for r, y in zip(rows, rhs)) for i in range(n)]
    ai = inv(a)
    return [sum(ai[i][j] * b[j] for j in range(n)) for i in range(n)]


def hessian_poly(cij: dict, e1: float, e2: float) -> tuple[float, float, float]:
    a, b = math.exp(e1), math.exp(e2)
    p = 1 / (a * a * b * b)
    i1, i2 = a * a + b * b + p, 1 / (a * a) + 1 / (b * b) + a * a * b * b
    d1 = (2 * a * a - 2 * p, 2 * b * b - 2 * p)
    d2 = (-2 / (a * a) + 2 * a * a * b * b, -2 / (b * b) + 2 * a * a * b * b)
    dd1 = (4 * a * a + 4 * p, 4 * p, 4 * b * b + 4 * p)
    dd2 = (4 / (a * a) + 4 * a * a * b * b, 4 * a * a * b * b, 4 / (b * b) + 4 * a * a * b * b)
    x, y = i1 - 3, i2 - 3
    w1 = sum(c * i * x ** (i - 1) * y ** j for (i, j), c in cij.items() if i > 0)
    w2 = sum(c * j * x ** i * y ** (j - 1) for (i, j), c in cij.items() if j > 0)
    w11 = sum(c * i * (i - 1) * x ** (i - 2) * y ** j for (i, j), c in cij.items() if i > 1)
    w22 = sum(c * j * (j - 1) * x ** i * y ** (j - 2) for (i, j), c in cij.items() if j > 1)
    w12 = sum(c * i * j * x ** (i - 1) * y ** (j - 1) for (i, j), c in cij.items() if i > 0 and j > 0)
    h = []
    for k, (p_, q_) in enumerate(((0, 0), (0, 1), (1, 1))):
        h.append(w1 * dd1[k] + w2 * dd2[k] + w11 * d1[p_] * d1[q_] + w12 * (d1[p_] * d2[q_] + d2[p_] * d1[q_]) + w22 * d2[p_] * d2[q_])
    return h[0], h[1], h[2]


def hessian_ogden1972(mu, al, e1, e2):
    h11 = sum(m * a * (math.exp(a * e1) + math.exp(-a * (e1 + e2))) for m, a in zip(mu, al))
    h12 = sum(m * a * math.exp(-a * (e1 + e2)) for m, a in zip(mu, al))
    h22 = sum(m * a * (math.exp(a * e2) + math.exp(-a * (e1 + e2))) for m, a in zip(mu, al))
    return h11, h12, h22


def drucker_scan(hess) -> dict:
    """First unstable stretch per mode on the grid lambda = 1 +/- 0.01 k within [0.10, 10.00] (TECHNICAL_SPEC §5.6)."""
    res = {}
    for mode, strains in (("UT", lambda l: (math.log(l), -0.5 * math.log(l))), ("ET", lambda l: (math.log(l), math.log(l))),
                          ("PS", lambda l: (math.log(l), 0.0))):
        first = {"tension": None, "compression": None}
        for side, grid in (("tension", [1 + 0.01 * k for k in range(1, 901)]), ("compression", [1 - 0.01 * k for k in range(1, 91)])):
            for lam in grid:
                h11, h12, h22 = hess(*strains(lam))
                if not (h11 > 0 and h11 * h22 - h12 * h12 > 0):
                    first[side] = round(lam, 2)
                    break
        res[mode] = first
    return res


def hyper_cases() -> list[dict]:
    out = []
    tre = load_treloar()
    mu72, al72 = [0.63, 0.0012, -0.01], [1.3, 5.0, -2.0]
    models = {"neoHooke C10=0.2": {(1, 0): 0.2}, "mooneyRivlin C10=0.16 C01=0.02": {(1, 0): 0.16, (0, 1): 0.02},
              "yeoh C10=0.18 C20=-0.002 C30=0.0001": {(1, 0): 0.18, (2, 0): -0.002, (3, 0): 0.0001}}
    for name, cij in models.items():
        for mode in ("UT", "ET", "PS"):
            out.append(case(f"VC-MATL-06/{name.split()[0]}/{mode}/lambda=2", f"nominal stress, synthetic {name}, {mode}, stretch 2",
                            sig(nominal_poly(mode, 2.0, cij)), "MPa", {"rel": 1e-12}, "closed form, incompressible", "A", ["FR-MATL-07", "TR-MATL-06"]))
    for mode in ("UT", "ET", "PS"):
        out.append(case(f"VC-MATL-06/arrudaBoyce/{mode}/lambda=2", "nominal stress, synthetic Arruda-Boyce mu = 0.27 MPa, lambda_m = 2.8, 5-term series",
                        sig(nominal_ab(mode, 2.0, 0.27, 2.8)), "MPa", {"rel": 1e-12}, "series coefficients S3 (ccx manual) + S12", "A", ["FR-MATL-07"]))
        out.append(case(f"VC-MATL-06/ogden1972set/{mode}/lambda=2", "nominal stress, Ogden 1972 convention W = sum mu_p/alpha_p (...)",
                        sig(nominal_ogden1972(mode, 2.0, mu72, al72)), "MPa", {"rel": 1e-12}, "closed form; parameter set S11 (B)", "A", ["FR-MATL-07"]))
    out.append(case("VC-MATL-07/ogden1972set/initialShearModulus", "mu0 = 1/2 sum mu_p alpha_p", sig(0.5 * sum(m * a for m, a in zip(mu72, al72))), "MPa",
                    {"rel": 1e-12}, "closed form", "A", ["FR-MATL-07", "TR-MATL-06"]))
    out.append(case("VC-MATL-07/ogden1972set/calculixMu", "CalculiX/Abaqus convention W = sum 2 mu_i/alpha_i^2 (...): mu_i = mu_p alpha_p / 2",
                    [sig(m * a / 2) for m, a in zip(mu72, al72)], "MPa", {"rel": 1e-12}, "ccx 2.23 manual Ogden form (S3)", "A",
                    ["FR-MATL-07", "FR-MATL-15", "TR-MATL-10"]))
    rms72 = {}
    for mode, pts in tre.items():
        r = [nominal_ogden1972(mode, float(l), mu72, al72) - float(p) for l, p in pts]
        rms72[mode] = sig(math.sqrt(sum(x * x for x in r) / len(r)), 6)
    out.append(case("VC-MATL-08/ogden1972set/rmsVsTreloar", "RMS residual of the Ogden 1972 set against the pinned Treloar table, per mode", rms72, "MPa",
                    {"rel": 1e-6}, "S10 table (B) + S11 parameters (B)", "B", ["FR-MATL-08"], note="reported, not a gate"))
    fits = {"neoHooke_UT": ([(1, 0)], ["UT"]), "neoHooke_all": ([(1, 0)], ["UT", "ET", "PS"]),
            "mooneyRivlin_all": ([(1, 0), (0, 1)], ["UT", "ET", "PS"]), "yeoh_all": ([(1, 0), (2, 0), (3, 0)], ["UT", "ET", "PS"])}
    for name, (terms, modes) in fits.items():
        rows, rhs = [], []
        for mode in modes:
            for lam, p in tre[mode]:
                rows.append([nominal_poly(mode, lam, {t: Fraction(1)}) for t in terms])
                rhs.append(p)
        sol = lstsq(rows, rhs)
        cij = {t: float(c) for t, c in zip(terms, sol)}
        rms = {}
        for mode in ("UT", "ET", "PS"):
            r = [nominal_poly(mode, float(l), cij) - float(p) for l, p in tre[mode]]
            rms[mode] = sig(math.sqrt(sum(x * x for x in r) / len(r)), 6)
        out.append(case(f"VC-MATL-08/treloarFit/{name}", f"linear least squares (absolute nominal-stress residual) on modes {modes}",
                        {f"C{i}{j}": sig(float(c)) for (i, j), c in zip(terms, sol)}, "MPa", {"rel": 1e-6},
                        "S10 table (B); exact rational normal equations here", "A (given the table)", ["FR-MATL-08", "TR-MATL-07"],
                        rmsPerModeMPa=rms, stability=drucker_scan(lambda e1, e2, c=cij: hessian_poly(c, e1, e2))))
    out.append(case("VC-MATL-09/ogden1972set/drucker", "Drucker scan of the Ogden 1972 set (all mu_p alpha_p > 0 => stable everywhere)",
                    drucker_scan(lambda e1, e2: hessian_ogden1972(mu72, al72, e1, e2)), "stretch", {"exact": True}, "closed form Hessian §5.6", "A",
                    ["FR-MATL-09", "TR-MATL-08"]))
    bad = {(1, 0): 0.2, (0, 1): -0.15}
    out.append(case("VC-MATL-09/mooneyRivlinNegativeC01/drucker", "Drucker scan, synthetic C10 = 0.2, C01 = -0.15 MPa", drucker_scan(lambda e1, e2: hessian_poly(bad, e1, e2)),
                    "stretch", {"exact": True}, "closed form Hessian §5.6", "A", ["FR-MATL-09", "TR-MATL-08"], expectCode="MATL_HYPERELASTIC_UNSTABLE"))
    return out


# ---------------------------------------------------------------- §5.7 viscoelastic, §5.8 creep, §5.9 Johnson-Cook
def rate_time_cases() -> list[dict]:
    out = []
    g0, gi, ti = 1.0, [0.3, 0.2], [0.1, 10.0]  # synthetic Prony (shear, normalised)
    for t in (0.0, 0.1, 1.0, 10.0, 100.0):
        out.append(case(f"VC-MATL-10/prony/t={t:g}s", "G(t) = G0 (1 - sum g_i (1 - exp(-t/tau_i)))", sig(g0 * (1 - sum(g * (1 - math.exp(-t / tau)) for g, tau in zip(gi, ti)))),
                        "MPa", {"rel": 1e-12}, "synthetic; closed form", "A", ["FR-MATL-11", "TR-MATL-09"]))
    c1, c2, tr = 17.44, 51.6, 373.0
    for t in (373.0, 383.0, 423.0):
        out.append(case(f"VC-MATL-10/wlf/T={t:g}K", "log10 aT = -C1 (T - Tr)/(C2 + T - Tr), C1 = 17.44, C2 = 51.6 K, Tr = Tg = 373 K (synthetic Tg)",
                        sig(-c1 * (t - tr) / (c2 + t - tr)) + 0.0, "1", {"rel": 1e-12}, "WLF form; 'universal' constants S13 (B)", "A", ["FR-MATL-11"]))
    out.append(case("VC-MATL-10/wlf/T=360K", "below Tr = Tg: refused", "MATL_SHIFT_OUT_OF_RANGE", "-", {"exact": True},
                    "WLF valid at or above Tg (S13, secondary)", "B", ["FR-MATL-11", "TR-MATL-09"]))
    a, n = 1e-10, 5.0
    for m in (0.0, -0.5):
        s, t = 50.0, 10.0
        out.append(case(f"VC-MATL-11/norton/m={m}/creepStrain", "Norton (CalculiX form) eps_dot = A s^n t^m, constant s = 50 MPa, t = 10 h: eps = A s^n t^(m+1)/(m+1)",
                        sig(a * s ** n * t ** (m + 1) / (m + 1)), "1", {"rel": 1e-12}, "closed form; A = 1e-10, n = 5 from the ccx manual example (S3), m synthetic",
                        "A", ["FR-MATL-12", "TR-MATL-09"]))
    ag, alp, ng, q, temp = 1.0e6, 0.01, 4.0, 300e3, 900.0  # synthetic Garofalo
    out.append(case("VC-MATL-11/garofalo/rate", "eps_dot = A sinh(alpha s)^n exp(-Q/(R T)), synthetic, s = 100 MPa, T = 900 K",
                    sig(ag * math.sinh(alp * 100.0) ** ng * math.exp(-q / (R_GAS * temp))), "1/s", {"rel": 1e-12}, "synthetic; closed form", "A", ["FR-MATL-12"]))
    A, B, nn, C, e0, mm, t_room, tm = 500.0, 300.0, 0.3, 0.015, 1.0, 1.0, 293.0, 1800.0  # synthetic J-C
    ts = (600.0 - t_room) / (tm - t_room)
    out.append(case("VC-MATL-12/johnsonCook/flowStress", "(A + B ep^n)(1 + C ln(rate/rate0))(1 - T*^m), ep = 0.1, rate = 100/s, T = 600 K",
                    sig((A + B * 0.1 ** nn) * (1 + C * math.log(100.0 / e0)) * (1 - ts ** mm)), "MPa", {"rel": 1e-12},
                    "synthetic; Johnson & Cook 1983 form (S9)", "A", ["FR-MATL-13", "TR-MATL-09"]))
    return out


# ---------------------------------------------------------------- §6 deck snippets (exact text)
def num(x: float) -> str:
    s = repr(float(x))
    if "e" in s or "E" in s:
        return s
    return s[:-1] if s.endswith(".0") else s  # "72000.0" -> "72000." ; "0.33" stays


def nas8(x: float) -> str:
    s = num(x)
    if len(s) > 8:
        raise ValueError(s)
    return s.ljust(8)


def deck_cases() -> list[dict]:
    out = []
    ro = ["*MATERIAL,NAME=AL_RO", "*DEFORMATION PLASTICITY",
          f"{num(72000)},{num(0.33)},{num(400)},{num(15)},{num(0.002 * 72000 / 400)}"]
    out.append(case("VC-MATL-13/ccx/rambergOsgood", "CalculiX deck lines for the VC-MATL-04 Ramberg-Osgood model (E and nu live on the card; no *ELASTIC)", ro, "text", {"exact": True},
                    "ccx 2.23 manual *DEFORMATION PLASTICITY (S3) + parser deformationplasticitys.f (S4)", "A", ["FR-MATL-15", "TR-MATL-10"]))
    synth = (135000, 10000, 10000, 0.3, 0.3, 0.45, 5000, 5000, 3448)
    ortho = ["*MATERIAL,NAME=CFRP_UD", "*ELASTIC,TYPE=ENGINEERING CONSTANTS", ",".join(num(v) for v in synth[:8]), f"{num(synth[8])},{num(293)}"]
    out.append(case("VC-MATL-13/ccx/engineeringConstants", "CalculiX lines, engineering constants E1 E2 E3 nu12 nu13 nu23 G12 G13 / G23 T", ortho, "text",
                    {"exact": True}, "S3 *ELASTIC + S4 elastics.f", "A", ["FR-MATL-15", "TR-MATL-10"]))
    pl = ["*MATERIAL,NAME=NL1_ISO", "*ELASTIC", f"{num(250000)},{num(0.25)}", "*PLASTIC,HARDENING=ISOTROPIC",
          f"{num(5)},{num(0)}", f"{num(5 + 62500 * 0.001)},{num(0.001)}"]
    out.append(case("VC-MATL-13/ccx/plasticLinearIsotropic", "NL1 linear hardening (H = 62.5 GPa plastic modulus) as a 2-point *PLASTIC curve", pl, "text",
                    {"exact": True}, "S3 *PLASTIC (von Mises stress, equivalent plastic strain) + S4 plastics.f", "A", ["FR-MATL-15", "TR-MATL-10"],
                    note="writer extends a linear law to the model's declared strain range (here 0.001)"))
    mu72, al72 = [0.63, 0.0012, -0.01], [1.3, 5.0, -2.0]
    mc = [m * a / 2 for m, a in zip(mu72, al72)]
    og = ["*MATERIAL,NAME=TRELOAR_OGDEN", "*HYPERELASTIC,OGDEN,N=3",
          ",".join(num(round(v, 12)) for v in (mc[0], al72[0], mc[1], al72[1], mc[2], al72[2])) + f",{num(0)},{num(0)}", f"{num(0)}"]
    out.append(case("VC-MATL-13/ccx/ogdenN3", "Ogden N=3 pair lines mu1 a1 mu2 a2 mu3 a3 D1 D2 / D3 (incompressible: D = 0, ccx substitutes a small value)",
                    og, "text", {"exact": True}, "S3 *HYPERELASTIC + S4 hyperelastics.f", "A", ["FR-MATL-15", "TR-MATL-10"],
                    namedDefault="D = 0 means incompressible; CalculiX replaces 0 by a small compressibility (S3) -> MATL_INCOMPRESSIBLE_DEFAULT warning"))
    cr = ["*MATERIAL,NAME=CREEP_N5", "*ELASTIC", f"{num(200000)},{num(0.3)},{num(100)}", "*CREEP,LAW=NORTON", f"{num(1e-10)},{num(5)},{num(0)},{num(100)}"]
    out.append(case("VC-MATL-13/ccx/norton", "Norton creep lines A, n, m, T", cr, "text", {"exact": True}, "S3 *CREEP + S4 creeps.f", "A",
                    ["FR-MATL-15", "TR-MATL-10"]))
    mat1 = "MAT1    " + nas8_str("1") + nas8(250000) + " " * 8 + nas8(0.25)
    mats1 = "MATS1   " + nas8_str("1") + " " * 8 + nas8_str("PLASTIC") + nas8(62500) + nas8_str("1") + nas8_str("1") + nas8(5)
    out.append(case("VC-MATL-14/nastran/NL1", "Nastran small-field MAT1 + MATS1 (TYPE PLASTIC, H, YF = 1 von Mises, HR = 1 isotropic, LIMIT1 = yield)",
                    [mat1.rstrip(), mats1.rstrip()], "text", {"exact": True}, "pyNastran MAT1/MATS1 docstrings (S7); integer fields MID, YF, HR without decimal point", "B", ["FR-MATL-15", "TR-MATL-11"],
                    note="G left blank so Nastran derives it (05 FEA convention); field layout verified by pyNastran read_bdf in the implementation test"))
    return out


def nas8_str(s: str) -> str:
    return s.ljust(8)


def build() -> dict:
    cases = nl1_cases() + elastic_cases() + plasticity_cases() + hyper_cases() + rate_time_cases() + deck_cases()
    return {"pack": "02-constitutive-models", "generatedBy": "generate_matl_reference.py", "constants": {"R_J_per_mol_K": R_GAS}, "cases": cases}


def main() -> int:
    text = json.dumps(build(), indent=1, ensure_ascii=False) + "\n"
    if "--check" in sys.argv:
        if not OUT.exists() or OUT.read_text(encoding="utf-8") != text:
            print("expected_results.json is stale - rerun generate_matl_reference.py", file=sys.stderr)
            return 1
        print("expected_results.json up to date")
        return 0
    OUT.write_text(text, encoding="utf-8")
    print(f"wrote {OUT.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
