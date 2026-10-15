#!/usr/bin/env python3
"""
Generate the reference values of PHY-18 (probabilistic analysis & sensitivity).

Run:  python3 -I generate_prb_reference.py        (stdlib only, deterministic, about 10 s)

Outputs (next to this script)
  expected_results.json      cases in the docs/physics/README.md section 6.3 schema (12 significant digits)
  beta_pf_table.csv          reliability index beta <-> probability of failure Phi(-beta)
  tolerance_factors.csv      one-sided normal tolerance factors k(n) for 90 % / 99 % coverage at 95 % confidence

Exact references (grade A unless stated)
  * Phi via math.erfc; Phi^-1 by bisection + Newton on erfc (|error| < 1e-15 in the tested range).
  * Linear limit state g = R - S, R ~ N, S ~ N independent: beta = (muR - muS) / sqrt(sR^2 + sS^2), Pf = Phi(-beta)
    (Cornell; equals the Hasofer-Lind index for a linear g in normal variables) [S1, S2].
  * Lognormal R and S: g = ln R - ln S is linear in normal variables -> exact beta; FORM on g = R - S must find the
    same beta because the failure boundary R = S is the same surface [S1].
  * OpenTURNS "axial stressed beam" use case: R ~ LogNormal(mu 3e6, sigma 3e5) Pa, F ~ Normal(750, 50) N,
    g = R - F / (pi / 1e4) [S5]; exact Pf by 1D integration (Simpson, 20 000 panels) and FORM (HL-RF) by this script.
  * Parabolic limit state in standard space g = b0 - u1 + k u2^2: FORM beta = b0; exact Pf by 1D integration;
    Breitung SORM estimate Phi(-b0) / sqrt(1 + b0 * 2k) (principal curvature 2k at the design point) [S3].
  * Ishigami function, X_i ~ U(-pi, pi), a = 7, b = 0.1: mean a/2, variance and Sobol indices in closed form [S6, S7].
  * Box mass m = rho w h d with independent normal w, h, d: E[m] = rho mu_w mu_h mu_d,
    Var[m] = rho^2 (prod(mu^2 + s^2) - prod(mu^2)); local derivatives dm/dw = rho h d etc.
  * One-sided normal tolerance factor: k = t'_{0.95}(n - 1, z_p sqrt(n)) / sqrt(n) (non-central t), computed by
    integrating Phi(t s - delta) over the scaled chi density of s = sqrt(V / nu) [S8 for the A/B-basis definitions].

Seeded Monte Carlo reference runs use Python's random.Random(seed) (Mersenne Twister) as the 03 GDT pack does; a llull
implementation (xoshiro128**, lib/prng.ts) is compared through the stated statistical acceptance bounds, not bit
equality.
"""

from __future__ import annotations

import csv
import json
import math
import os
import random

HERE = os.path.dirname(os.path.abspath(__file__))
SQRT2 = math.sqrt(2.0)


def sig(x: float, n: int = 12) -> float:
    if x == 0 or not math.isfinite(x):
        return x
    return float(f"{x:.{n}g}")


def Phi(x: float) -> float:
    return 0.5 * math.erfc(-x / SQRT2)


def phi(x: float) -> float:
    return math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)


def Phi_inv(p: float) -> float:
    lo, hi = -40.0, 40.0
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        if Phi(mid) < p:
            lo = mid
        else:
            hi = mid
    x = 0.5 * (lo + hi)
    for _ in range(3):  # Newton polish
        x -= (Phi(x) - p) / phi(x)
    return x


def simpson(f, a: float, b: float, n: int) -> float:
    if n % 2:
        n += 1
    h = (b - a) / n
    s = f(a) + f(b)
    for i in range(1, n):
        s += (4 if i % 2 else 2) * f(a + i * h)
    return s * h / 3.0


# ----------------------------------------------------------------------------------------------------------
# Distributions (independent marginals) and the HL-RF FORM algorithm
# ----------------------------------------------------------------------------------------------------------
def lognormal_params(mu: float, sd: float) -> tuple[float, float]:
    zeta2 = math.log(1.0 + (sd / mu) ** 2)
    return math.log(mu) - 0.5 * zeta2, math.sqrt(zeta2)


def form_hlrf(g, to_x, n: int, tol: float = 1e-12, max_iter: int = 200, h: float = 1e-6):
    """Hasofer-Lind / Rackwitz-Fiessler iteration in standard normal space; gradients by central differences."""
    u = [0.0] * n
    for it in range(1, max_iter + 1):
        gu = g(to_x(u))
        grad = []
        for i in range(n):
            up = u[:]
            um = u[:]
            up[i] += h
            um[i] -= h
            grad.append((g(to_x(up)) - g(to_x(um))) / (2 * h))
        norm2 = sum(c * c for c in grad)
        dot = sum(c * ui for c, ui in zip(grad, u))
        u_new = [(dot - gu) / norm2 * c for c in grad]
        if max(abs(a - b) for a, b in zip(u_new, u)) < tol:
            u = u_new
            break
        u = u_new
    beta = math.sqrt(sum(c * c for c in u))
    norm = math.sqrt(norm2)
    alpha = [-c / norm for c in grad]  # importance direction (unit), alpha_i^2 = importance share
    return {"beta": beta, "u": u, "x": to_x(u), "alpha": alpha, "iterations": it}


# ----------------------------------------------------------------------------------------------------------
# Non-central t quantile for one-sided tolerance factors
# ----------------------------------------------------------------------------------------------------------
def nct_cdf(t: float, nu: int, delta: float) -> float:
    c = math.log(2.0) + (nu / 2.0) * math.log(nu / 2.0) - math.lgamma(nu / 2.0)

    def integrand(s: float) -> float:
        if s <= 0.0:
            return 0.0
        return math.exp(c + (nu - 1) * math.log(s) - nu * s * s / 2.0) * Phi(t * s - delta)

    upper = 1.0 + 12.0 / math.sqrt(nu)
    return simpson(integrand, 0.0, upper, 8000)


def tolerance_factor(n: int, coverage: float, confidence: float = 0.95) -> float:
    nu = n - 1
    delta = Phi_inv(coverage) * math.sqrt(n)
    lo, hi = delta, delta * 20.0 + 50.0
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        if nct_cdf(mid, nu, delta) < confidence:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi) / math.sqrt(n)


# ----------------------------------------------------------------------------------------------------------
# Sobol indices (Saltelli 2010 first-order, Jansen total) for the seeded reference run
# ----------------------------------------------------------------------------------------------------------
def ishigami(x, a=7.0, b=0.1):
    return math.sin(x[0]) + a * math.sin(x[1]) ** 2 + b * x[2] ** 4 * math.sin(x[0])


def sobol_estimate(n: int, seed: int):
    rng = random.Random(seed)
    d = 3
    A = [[rng.uniform(-math.pi, math.pi) for _ in range(d)] for _ in range(n)]
    B = [[rng.uniform(-math.pi, math.pi) for _ in range(d)] for _ in range(n)]
    fA = [ishigami(r) for r in A]
    fB = [ishigami(r) for r in B]
    allf = fA + fB
    mean = sum(allf) / len(allf)
    var = sum((v - mean) ** 2 for v in allf) / (len(allf) - 1)
    S, ST = [], []
    for i in range(d):
        fAB = [ishigami([B[k][j] if j == i else A[k][j] for j in range(d)]) for k in range(n)]
        S.append(sum(fB[k] * (fAB[k] - fA[k]) for k in range(n)) / n / var)
        ST.append(0.5 * sum((fA[k] - fAB[k]) ** 2 for k in range(n)) / n / var)
    return S, ST


def case(cid, quantity, value, unit, tol, source, grade, proves, **extra):
    c = {"id": cid, "quantity": quantity,
         "value": [sig(v) for v in value] if isinstance(value, list) and value and isinstance(value[0], float)
         else (sig(value) if isinstance(value, float) else value),
         "unit": unit, "tolerance": tol, "source": source, "grade": grade, "proves": proves}
    c.update(extra)
    return c


def main() -> None:
    cases = []

    # VC-PRB-01 linear normal R - S
    muR, sR, muS, sS = 300.0, 30.0, 200.0, 40.0
    beta1 = (muR - muS) / math.sqrt(sR**2 + sS**2)
    inputs1 = {"R": {"dist": "normal", "mean": muR, "sd": sR, "unit": "MPa"}, "S": {"dist": "normal", "mean": muS, "sd": sS, "unit": "MPa"},
               "g": "R - S"}
    cases.append(case("VC-PRB-01.a", "reliability index, g = R - S, normal R, S", beta1, "1", {"rel": 1e-9},
                      "generator: (muR - muS)/sqrt(sR^2 + sS^2) [S1, S2]", "A", ["FR-PRB-04", "TR-PRB-05"], inputs=inputs1))
    cases.append(case("VC-PRB-01.b", "probability of failure Phi(-beta)", Phi(-beta1), "1", {"rel": 1e-9},
                      "generator (erfc)", "A", ["FR-PRB-04", "FR-PRB-05"], inputs=inputs1))
    f1 = form_hlrf(lambda x: x[0] - x[1], lambda u: [muR + sR * u[0], muS + sS * u[1]], 2)
    cases.append(case("VC-PRB-01.c", "FORM importance factors alpha^2 (R, S)", [a * a for a in f1["alpha"]], "1", {"abs": 1e-6},
                      "generator: alpha_R^2 = sR^2/(sR^2+sS^2) = 0.36, alpha_S^2 = 0.64", "A", ["FR-PRB-06"], inputs=inputs1))
    # MC acceptance for N = 1e6 (seeded run with Python random as a sanity check of the bounds)
    N = 200000
    rng = random.Random(20261015)
    fails = sum(1 for _ in range(N) if rng.gauss(muR, sR) - rng.gauss(muS, sS) < 0)
    p = Phi(-beta1)
    bound = max(5.0 * math.sqrt(p * (1 - p) / N), 1e-5)
    cases.append(case("VC-PRB-01.d", "Monte Carlo Pf, N = 200 000, any seed", p, "1", {"abs": sig(bound)},
                      "generator: exact Pf, 5-sigma binomial acceptance (as 03 GDT)", "A", ["FR-PRB-02", "TR-PRB-03"],
                      inputs=inputs1, referenceRun={"prng": "Python random.Random(20261015).gauss", "samples": N,
                                                    "pf": sig(fails / N)}))

    # VC-PRB-02 lognormal R, S: exact beta; FORM on g = R - S must match
    muR2, sR2, muS2, sS2 = 300.0, 30.0, 200.0, 40.0
    lR, zR = lognormal_params(muR2, sR2)
    lS, zS = lognormal_params(muS2, sS2)
    beta2 = (lR - lS) / math.sqrt(zR**2 + zS**2)
    f2 = form_hlrf(lambda x: x[0] - x[1], lambda u: [math.exp(lR + zR * u[0]), math.exp(lS + zS * u[1])], 2)
    inputs2 = {"R": {"dist": "lognormal", "mean": muR2, "sd": sR2, "unit": "MPa"},
               "S": {"dist": "lognormal", "mean": muS2, "sd": sS2, "unit": "MPa"}, "g": "R - S"}
    cases.append(case("VC-PRB-02.a", "exact beta, lognormal R and S (g = ln R - ln S)", beta2, "1", {"rel": 1e-9},
                      "generator: (lambdaR - lambdaS)/sqrt(zetaR^2 + zetaS^2)", "A", ["FR-PRB-04"], inputs=inputs2))
    cases.append(case("VC-PRB-02.b", "FORM (HL-RF) beta on g = R - S, same variables", f2["beta"], "1", {"rel": 1e-6},
                      "generator HL-RF; equals 02.a because the failure surface R = S is linear in u", "A",
                      ["FR-PRB-04", "TR-PRB-05"], inputs=inputs2, iterations=f2["iterations"]))

    # VC-PRB-03 OpenTURNS axial stressed beam
    lRb, zRb = lognormal_params(3.0e6, 3.0e5)
    muF, sF = 750.0, 50.0
    area = math.pi / 1.0e4

    def pf_beam_integrand(f: float) -> float:
        stress = f / area
        return phi((f - muF) / sF) / sF * Phi((math.log(stress) - lRb) / zRb)

    pf3 = simpson(pf_beam_integrand, muF - 12 * sF, muF + 12 * sF, 20000)
    f3 = form_hlrf(lambda x: x[0] - x[1] / area, lambda u: [math.exp(lRb + zRb * u[0]), muF + sF * u[1]], 2)
    inputs3 = {"R": {"dist": "lognormal", "mean": 3.0e6, "sd": 3.0e5, "unit": "Pa"},
               "F": {"dist": "normal", "mean": 750.0, "sd": 50.0, "unit": "N"}, "g": "R - F / (pi / 1e4)"}
    cases.append(case("VC-PRB-03.a", "exact Pf, OpenTURNS axial stressed beam use case", pf3, "1", {"rel": 1e-6},
                      "generator: 1D integration of P(R < F/A) over F [S5 model]", "A", ["FR-PRB-02", "FR-PRB-05"], inputs=inputs3))
    cases.append(case("VC-PRB-03.b", "FORM beta, same problem", f3["beta"], "1", {"rel": 1e-6},
                      "generator HL-RF", "A", ["FR-PRB-04"], inputs=inputs3))
    cases.append(case("VC-PRB-03.c", "FORM Pf = Phi(-beta), same problem", Phi(-f3["beta"]), "1", {"rel": 1e-6},
                      "generator", "A", ["FR-PRB-04"], inputs=inputs3, note="FORM vs exact: relative difference reported, not gated"))
    cases.append(case("VC-PRB-03.d", "FORM design point (R*, F*)", f3["x"], "Pa, N", {"rel": 1e-5},
                      "generator HL-RF", "A", ["FR-PRB-06"], inputs=inputs3))

    # VC-PRB-04 parabolic limit state in standard space
    b0, k = 3.0, 0.1
    pf4 = simpson(lambda u2: phi(u2) * Phi(-(b0 + k * u2 * u2)), -12.0, 12.0, 20000)
    breitung = Phi(-b0) / math.sqrt(1.0 + b0 * 2.0 * k)
    inputs4 = {"u1": "standard normal", "u2": "standard normal", "g": "3 - u1 + 0.1 u2^2"}
    cases.append(case("VC-PRB-04.a", "FORM beta for g = 3 - u1 + 0.1 u2^2", b0, "1", {"rel": 1e-9}, "generator (design point (3, 0))",
                      "A", ["FR-PRB-04"], inputs=inputs4))
    cases.append(case("VC-PRB-04.b", "exact Pf", pf4, "1", {"rel": 1e-8}, "generator: integral of phi(u2) Phi(-(3 + 0.1 u2^2))",
                      "A", ["FR-PRB-07"], inputs=inputs4))
    cases.append(case("VC-PRB-04.c", "Breitung SORM Pf, curvature 2k = 0.2", breitung, "1", {"rel": 1e-6},
                      "generator: Phi(-beta) prod (1 + beta kappa_i)^-1/2 [S3, formula form via search]", "B",
                      ["FR-PRB-07"], inputs=inputs4, exactRatio=sig(breitung / pf4), formPfRatio=sig(Phi(-b0) / pf4)))

    # VC-PRB-05 Ishigami Sobol indices
    a, b = 7.0, 0.1
    V = 0.5 + a * a / 8 + b * math.pi**4 / 5 + b * b * math.pi**8 / 18
    V1 = 0.5 * (1 + b * math.pi**4 / 5) ** 2
    V2 = a * a / 8
    V13 = b * b * math.pi**8 / 2 * (1 / 9 - 1 / 25)
    analytic = {"mean": a / 2, "variance": V, "S1": V1 / V, "S2": V2 / V, "S3": 0.0, "ST1": (V1 + V13) / V, "ST2": V2 / V, "ST3": V13 / V}
    quoted = {"S1": 0.3139, "S2": 0.4424, "S3": 0.0}
    S_est, ST_est = sobol_estimate(8192, 12345)
    est = {"S1": S_est[0], "S2": S_est[1], "S3": S_est[2], "ST1": ST_est[0], "ST2": ST_est[1], "ST3": ST_est[2]}
    for key, unit, tol in [("mean", "1", {"abs": 1e-12}), ("variance", "1", {"rel": 1e-12})]:
        cases.append(case(f"VC-PRB-05.{key}", f"Ishigami {key} (a = 7, b = 0.1, X ~ U(-pi, pi))", analytic[key], unit, tol,
                          "generator closed form; same formula in OpenTURNS usecase [S7]", "A", ["FR-PRB-08"]))
    for key in ("S1", "S2", "S3", "ST1", "ST2", "ST3"):
        cases.append(case(f"VC-PRB-05.{key}", f"Ishigami Sobol index {key}", analytic[key], "1", {"abs": 0.03},
                          "generator closed form; OpenTURNS formula [S7]; SALib quotes S1..S3 [S6]", "A", ["FR-PRB-08", "TR-PRB-07"],
                          estimatorTolerance="abs 0.03 for N = 8192 base samples (Saltelli 2010 first order, Jansen total); "
                                             "exact implementation of the closed form: abs 1e-12",
                          quotedBySource=quoted.get(key), referenceRun={"prng": "Python random.Random(12345)", "N": 8192,
                                                                        "estimate": sig(est[key])}))

    # VC-PRB-06 box mass: local sensitivities and moments
    rho = 0.0027  # g/mm^3 (aluminium-like test input, not a material claim)
    w, h, d = 40.0, 20.0, 10.0
    sw, sh, sd = 0.1, 0.1, 0.05
    m = rho * w * h * d
    cases.append(case("VC-PRB-06.a", "box mass rho w h d (w 40, h 20, d 10 mm; rho 0.0027 g/mm^3)", m, "g", {"rel": 1e-12},
                      "generator", "A", ["FR-PRB-10"]))
    cases.append(case("VC-PRB-06.b", "dm/dw, dm/dh, dm/dd", [rho * h * d, rho * w * d, rho * w * h], "g/mm", {"rel": 1e-6},
                      "generator: central differences are exact for a trilinear response (rounding only)", "A",
                      ["FR-PRB-10", "TR-PRB-09"]))
    cases.append(case("VC-PRB-06.c", "elasticities (x/m) dm/dx for w, h, d", [1.0, 1.0, 1.0], "1", {"abs": 1e-6},
                      "generator", "A", ["FR-PRB-10"]))
    Em = rho * w * h * d
    Vm = rho**2 * ((w * w + sw * sw) * (h * h + sh * sh) * (d * d + sd * sd) - (w * h * d) ** 2)
    cases.append(case("VC-PRB-06.d", "E[m] with independent normal w, h, d (sd 0.1, 0.1, 0.05 mm)", Em, "g", {"rel": 1e-12},
                      "generator (independence)", "A", ["FR-PRB-02", "FR-PRB-03"]))
    cases.append(case("VC-PRB-06.e", "sd[m], same", math.sqrt(Vm), "g", {"rel": 1e-9},
                      "generator: Var = rho^2 (prod(mu^2 + s^2) - prod mu^2)", "A", ["FR-PRB-02", "FR-PRB-03"],
                      mcAcceptance="MC N = 10 000: mean +- 5 sd/sqrt(N), sd +- 5 sd/sqrt(2N)"))

    # VC-PRB-07 LHS structural property
    cases.append(case("VC-PRB-07", "centred LHS, n = 10, 2 variables U(0,1): each of the 10 strata holds exactly one point per "
                                   "variable and each marginal mean is exactly 0.5", 0.5, "1", {"abs": 1e-15},
                      "generator (stratum midpoints (i + 0.5)/n)", "A", ["FR-PRB-02", "TR-PRB-04"]))

    # VC-PRB-08 tolerance factors and basis link
    rows = []
    for n in (5, 10, 15, 20, 30, 50, 100):
        rows.append((n, tolerance_factor(n, 0.90), tolerance_factor(n, 0.99)))
    with open(os.path.join(HERE, "tolerance_factors.csv"), "w", newline="", encoding="utf-8") as fh:
        wr = csv.writer(fh, lineterminator="\n")
        wr.writerow(["n", "k_B_90cov_95conf", "k_A_99cov_95conf"])
        for n, kb, ka in rows:
            wr.writerow([n, repr(sig(kb, 8)), repr(sig(ka, 8))])
        wr.writerow(["inf", repr(sig(Phi_inv(0.90), 8)), repr(sig(Phi_inv(0.99), 8))])
    kb10 = [r for r in rows if r[0] == 10][0]
    cases.append(case("VC-PRB-08.a", "one-sided normal tolerance factor, n = 10, 90 % coverage, 95 % confidence (B-basis form)",
                      kb10[1], "1", {"rel": 1e-6}, "generator: non-central t quantile [S8 definition]", "A",
                      ["FR-PRB-12"], note="published tables quote 2.355 (to confirm against CMH-17 / MMPDS, open question)"))
    cases.append(case("VC-PRB-08.b", "same, 99 % coverage (A-basis form)", kb10[2], "1", {"rel": 1e-6},
                      "generator: non-central t quantile [S8 definition]", "A", ["FR-PRB-12"],
                      note="published tables quote 3.981 (to confirm)"))
    cases.append(case("VC-PRB-08.c", "limits n -> infinity: z_0.90, z_0.99", [Phi_inv(0.90), Phi_inv(0.99)], "1", {"rel": 1e-10},
                      "generator (Phi^-1)", "A", ["FR-PRB-12"]))

    # beta <-> Pf table
    with open(os.path.join(HERE, "beta_pf_table.csv"), "w", newline="", encoding="utf-8") as fh:
        wr = csv.writer(fh, lineterminator="\n")
        wr.writerow(["beta", "Pf"])
        for bt in (1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0, 6.0):
            wr.writerow([bt, repr(sig(Phi(-bt)))])
    cases.append(case("VC-PRB-09.a", "Phi(-3)", Phi(-3.0), "1", {"rel": 1e-10}, "generator (erfc)", "A", ["FR-PRB-05"]))
    cases.append(case("VC-PRB-09.b", "beta for Pf = 1e-6", -Phi_inv(1e-6), "1", {"rel": 1e-10}, "generator (Phi^-1)", "A", ["FR-PRB-05"]))

    # VC-PRB-10..15 behaviour contracts
    contracts = [
        ("VC-PRB-10", "propagate_uncertainty twice with the same seed and samples", "identical data (bit-equal)", ["FR-PRB-13"]),
        ("VC-PRB-11", "random variable bound to an 08 property with basis typical", "PRB_INPUT_UNVERIFIED", ["FR-PRB-15"]),
        ("VC-PRB-12", "distribution sd <= 0 / lognormal mean <= 0 / correlation matrix not positive definite",
         ["PRB_DISTRIBUTION_INVALID", "PRB_DISTRIBUTION_INVALID", "PRB_CORRELATION_INVALID"], ["FR-PRB-17"]),
        ("VC-PRB-13", "FORM on g with zero gradient at the start point", "PRB_FORM_NOT_CONVERGED", ["FR-PRB-04"]),
        ("VC-PRB-14", "Pf result without a target", "PRB_TARGET_UNSET (warning) and reviewRequired true", ["FR-PRB-14", "FR-PRB-16"]),
        ("VC-PRB-15", "agent calls accept_reliability_result without signature", "PRB_HUMAN_GATE", ["FR-PRB-16"]),
    ]
    for cid, q, v, proves in contracts:
        cases.append(case(cid, q, v, "-", {"exact": True}, "TECHNICAL_SPEC 7.1", "A", proves))
    cases.append(case("VC-PRB-16", "05 bracket: Pf of the min margin with E, load and thickness scatter (FE responses)",
                      "TBD", "1", {"rel": None}, "TBD - measure with run_reliability_study once 05 FEA exists", "TBD",
                      ["FR-PRB-11"]))

    doc = {"pack": "18-probabilistic-sensitivity", "generatedBy": "generate_prb_reference.py",
           "units": "dimensionless unless stated", "cases": cases}
    with open(os.path.join(HERE, "expected_results.json"), "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=1, ensure_ascii=False)
        fh.write("\n")


if __name__ == "__main__":
    main()
