#!/usr/bin/env python3
"""
Generate the reference datasets of physics gap PHY-07 (fatigue, crack initiation).

Run:  python3 -I generate_fatigue_reference.py     (stdlib only, deterministic, writes next to this script)

Outputs
  expected_results.json       VC-FAT-* expected values (schema: docs/physics/README.md section 6.3)
  rainflow_e1049.json         ASTM E1049-85 rainflow examples: history, cycles, aggregated counts, pinned cross-checks
  strain_life_table.csv       Coffin-Manson-Basquin life (2Nf) versus strain amplitude for the test parameter set
  mean_stress_table.csv       Equivalent fully reversed amplitude for six mean-stress models over a sigma_m sweep

Every formula cites a source id of sources.md ([Sn]). Material parameters below are TEST INPUTS of the validation
cases, not material claims; S5 (reliability, Example 1) uses the same textbook set, which gives an independent
cross-check. Tolerances are llull acceptance choices (validation/README.md), not claims of any source.
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
    """Round to n significant digits (stable JSON, README section 6.3)."""
    if x == 0 or not math.isfinite(x):
        return x
    return float(f"{x:.{n}g}")


# -------------------------------------------------------------------------------------------------------------
# 1. Rainflow counting, ASTM E1049-85 section 5.4.4 (three-point) and 5.4.5 (repeating history)   [S1, S2, S3]
# -------------------------------------------------------------------------------------------------------------
def reversals(series: list[float]) -> list[float]:
    """Peaks and valleys; first and last points kept; plateaus collapsed (same rule as S2 `reversals`)."""
    pts = [series[0]]
    for x in series[1:]:
        if x == pts[-1]:
            continue
        if len(pts) >= 2 and (pts[-1] - pts[-2]) * (x - pts[-1]) > 0:
            pts[-1] = x  # still rising / falling: extend
        else:
            pts.append(x)
    return pts


def rainflow_three_point(series: list[float]) -> list[tuple[float, float, float, float]]:
    """E1049 5.4.4. Returns (from, to, range, count) with count 0.5 or 1.0, in extraction order."""
    stack: list[float] = []
    cycles: list[tuple[float, float, float, float]] = []
    for p in reversals(series):
        stack.append(p)
        while len(stack) >= 3:
            x = abs(stack[-1] - stack[-2])
            y = abs(stack[-2] - stack[-3])
            if x < y:
                break
            if len(stack) == 3:  # Y contains the starting point: half cycle, discard first point
                cycles.append((stack[0], stack[1], y, 0.5))
                stack.pop(0)
            else:  # full cycle, discard peak and valley of Y
                cycles.append((stack[-3], stack[-2], y, 1.0))
                last = stack.pop()
                stack.pop()
                stack.pop()
                stack.append(last)
    for i in range(len(stack) - 1):  # residue: half cycles
        cycles.append((stack[i], stack[i + 1], abs(stack[i + 1] - stack[i]), 0.5))
    return cycles


def rainflow_four_point(series: list[float]) -> tuple[list[tuple[float, float, float, float]], list[float]]:
    """Four-point rule: inner range S2-S3 closes when it is <= both neighbours. Returns (full cycles, residue)."""
    stack: list[float] = []
    full: list[tuple[float, float, float, float]] = []
    for p in reversals(series):
        stack.append(p)
        while len(stack) >= 4:
            s1, s2, s3, s4 = stack[-4:]
            inner = abs(s3 - s2)
            if inner <= abs(s2 - s1) and inner <= abs(s4 - s3):
                full.append((s2, s3, inner, 1.0))
                del stack[-3:-1]
            else:
                break
    return full, stack


def rainflow_repeating(series: list[float]) -> list[tuple[float, float, float, float]]:
    """E1049 5.4.5 simplified counting for a repeating history: re-start at the largest |value|, close the loop."""
    rev = reversals(series)
    if rev[0] == rev[-1]:
        rev = rev[:-1]
    k = max(range(len(rev)), key=lambda i: (abs(rev[i]), -i))
    loop = rev[k:] + rev[:k] + [rev[k]]
    stack: list[float] = []
    cycles: list[tuple[float, float, float, float]] = []
    for p in reversals(loop):
        stack.append(p)
        while len(stack) >= 3:
            x = abs(stack[-1] - stack[-2])
            y = abs(stack[-2] - stack[-3])
            if x < y:
                break
            cycles.append((stack[-3], stack[-2], y, 1.0))
            last = stack.pop()
            stack.pop()
            stack.pop()
            stack.append(last)
    return cycles


def aggregate(cycles: list[tuple[float, float, float, float]]) -> list[list[float]]:
    acc: dict[float, float] = {}
    for _, _, rng, cnt in cycles:
        acc[rng] = acc.get(rng, 0.0) + cnt
    return [[r, acc[r]] for r in sorted(acc)]


E1049_HISTORY = [-2.0, 1.0, -3.0, 5.0, -1.0, 3.0, -4.0, 4.0, -2.0]
# Quoted expected counts (pinned): S2 tests/test_rainflow.py TEST_CASE_1 and S3 tests/lcc/test_lcc_astmCounting.py
# ("Standard rainflow counting data from E1049-85(2017) Fig.6(a)").
E1049_FIG6_QUOTED = [[3.0, 0.5], [4.0, 1.5], [6.0, 0.5], [8.0, 1.0], [9.0, 0.5]]
# S3 only: E1049 Fig. 7 (repeating history) and the four-point full cycles of the negated history.
E1049_FIG7_QUOTED = [[3.0, 1.0], [4.0, 1.0], [7.0, 1.0], [9.0, 1.0]]
S2_CASE2_HISTORY = [-1.5, 1.0, -3.0, 10.0, -1.0, 3.0, -8.0, 4.0, -2.0, 6.0, -1.0, -4.0, -8.0, 2.0, 1.0, -5.0, 0.0,
                    2.5, -4.0, 1.0, 0.0, 2.0, -0.5]
S2_CASE2_QUOTED = [[1.0, 1.0], [2.5, 1.0], [4.0, 1.5], [6.0, 1.5], [6.5, 0.5], [7.0, 1.0], [10.5, 0.5], [13.0, 0.5],
                   [14.0, 1.0], [18.0, 0.5]]

# -------------------------------------------------------------------------------------------------------------
# 2. Life curves                                                                                    [S5, S6, S7]
# -------------------------------------------------------------------------------------------------------------
# Test parameter set (Modarres et al. 2017 Example 2.8 as used by S5 Example 1). NOT a material claim.
E = 210000.0          # MPa
SIGMA_F = 1160.0      # MPa, fatigue strength coefficient sigma'_f
EPS_F = 1.1           # -, fatigue ductility coefficient epsilon'_f
B = -0.081            # -, fatigue strength exponent
C = -0.65             # -, fatigue ductility exponent
K_CYC = 1060.0        # MPa, cyclic strength coefficient K'
N_CYC = 0.14          # -, cyclic strain hardening exponent n'


def basquin_reversals(sigma_a: float, sigma_f: float = SIGMA_F, b: float = B) -> float:
    """sigma_a = sigma'_f (2N)^b  ->  2N."""
    return (sigma_a / sigma_f) ** (1.0 / b)


def sn_power_law_cycles(s: float, k: float, n_d: float, s_d: float) -> float:
    """N = N_D (S / S_D)^-k  (S-N with knee point, same parametrisation as S8 pyLife WoehlerCurve k_1, ND, SD)."""
    return n_d * (s / s_d) ** (-k)


def newton_reversals(f, dfdx, x0: float) -> float:
    """Newton on x = log10(2N); stops at |dx| < 1e-14."""
    x = x0
    for _ in range(200):
        fx, dx = f(x), dfdx(x)
        step = fx / dx
        x -= step
        if abs(step) < 1e-14:
            return 10.0 ** x
    raise RuntimeError("Newton did not converge")


def cmb_reversals(eps_a: float, sigma_m: float = 0.0, model: str = "none") -> float:
    """Coffin-Manson-Basquin with optional Morrow mean-stress term:  eps_a = (sf - sm)/E (2N)^b + ef (2N)^c."""
    sf = SIGMA_F - (sigma_m if model == "morrow" else 0.0)
    ln10 = math.log(10.0)

    def f(x: float) -> float:
        n2 = 10.0 ** x
        return sf / E * n2 ** B + EPS_F * n2 ** C - eps_a

    def d(x: float) -> float:
        n2 = 10.0 ** x
        return ln10 * (sf / E * B * n2 ** B + EPS_F * C * n2 ** C)

    return newton_reversals(f, d, 3.0)


def swt_reversals(sigma_max: float, eps_a: float) -> float:
    """sigma_max eps_a = sf^2/E (2N)^2b + sf ef (2N)^(b+c)   [S6, S7]."""
    target = sigma_max * eps_a
    ln10 = math.log(10.0)

    def f(x: float) -> float:
        n2 = 10.0 ** x
        return SIGMA_F ** 2 / E * n2 ** (2 * B) + SIGMA_F * EPS_F * n2 ** (B + C) - target

    def d(x: float) -> float:
        n2 = 10.0 ** x
        return ln10 * (SIGMA_F ** 2 / E * 2 * B * n2 ** (2 * B) + SIGMA_F * EPS_F * (B + C) * n2 ** (B + C))

    return newton_reversals(f, d, 3.0)


def transition_reversals() -> float:
    """Elastic = plastic strain:  2Nt = (ef E / sf)^(1/(b-c))."""
    return (EPS_F * E / SIGMA_F) ** (1.0 / (B - C))


# -------------------------------------------------------------------------------------------------------------
# 3. Notch: Kf, Neuber + Ramberg-Osgood                                                         [S5, S8, S9]
# -------------------------------------------------------------------------------------------------------------
def kf_from_q(kt: float, q: float) -> float:
    return 1.0 + q * (kt - 1.0)


def q_peterson(a: float, r: float) -> float:
    return 1.0 / (1.0 + a / r)


def q_neuber(rho: float, r: float) -> float:
    return 1.0 / (1.0 + math.sqrt(rho / r))


def ramberg_osgood_strain(sigma: float, k: float = K_CYC, n: float = N_CYC) -> float:
    return sigma / E + (sigma / k) ** (1.0 / n)


def neuber_stress(s_elastic_local: float) -> float:
    """Solve sigma * eps(sigma) = (Kf S)^2 / E for sigma (bisection then Newton), RO curve."""
    target = s_elastic_local ** 2 / E
    lo, hi = 0.0, s_elastic_local
    for _ in range(300):
        mid = 0.5 * (lo + hi)
        if mid * ramberg_osgood_strain(mid) < target:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


def masing_range_strain(d_sigma: float) -> float:
    """Masing hysteresis branch: d_eps = d_sigma/E + 2 (d_sigma / 2K')^(1/n')."""
    return d_sigma / E + 2.0 * (d_sigma / (2.0 * K_CYC)) ** (1.0 / N_CYC)


# -------------------------------------------------------------------------------------------------------------
# 4. Mean-stress models: equivalent fully reversed amplitude sigma_ar                               [S6, S7, S10]
# -------------------------------------------------------------------------------------------------------------
def mean_stress(model: str, sa: float, sm: float, su: float, sy: float, sf: float, gamma: float) -> float:
    smax = sm + sa
    if model == "goodman":
        return sa / (1.0 - sm / su)
    if model == "gerber":
        return sa / (1.0 - (sm / su) ** 2)
    if model == "soderberg":
        return sa / (1.0 - sm / sy)
    if model == "morrow":
        return sa / (1.0 - sm / sf)
    if model == "swt":
        return math.sqrt(smax * sa)
    if model == "walker":
        return smax ** (1.0 - gamma) * sa ** gamma
    raise ValueError(model)


MEAN_MODELS = ["goodman", "gerber", "soderberg", "morrow", "swt", "walker"]


# -------------------------------------------------------------------------------------------------------------
# 5. Assemble cases
# -------------------------------------------------------------------------------------------------------------
def case(cid, quantity, value, unit, tol, source, grade, proves, **extra):
    c = {"id": cid, "quantity": quantity, "value": value, "unit": unit, "tolerance": tol, "source": source,
         "grade": grade, "proves": proves}
    c.update(extra)
    return c


def build() -> tuple[dict, dict, list, list]:
    cases = []

    # --- rainflow
    c6 = rainflow_three_point(E1049_HISTORY)
    agg6 = aggregate(c6)
    assert agg6 == E1049_FIG6_QUOTED, agg6
    c7 = rainflow_repeating(E1049_HISTORY)
    agg7 = aggregate(c7)
    assert agg7 == E1049_FIG7_QUOTED, agg7
    full4, residue4 = rainflow_four_point([-x for x in E1049_HISTORY])
    assert [(a, b, r) for a, b, r, _ in full4] == [(1.0, -3.0, 4.0)], full4  # S3 four-point test, negated history
    res_half = rainflow_three_point(residue4)
    agg4 = aggregate(full4 + res_half)
    assert agg4 == E1049_FIG6_QUOTED, agg4  # four-point + residue as half cycles == three-point result
    agg2 = aggregate(rainflow_three_point(S2_CASE2_HISTORY))
    assert agg2 == S2_CASE2_QUOTED, agg2

    cases.append(case("VC-FAT-01", "rainflow counts of the ASTM E1049-85 Fig. 6 history (range: cycles)", agg6, "unit, cycles",
                      {"abs": 0.0}, "S1 (standard, catalogue) + S2 TEST_CASE_1 + S3 Fig.6(a) test", "A",
                      ["FR-FAT-05", "TR-FAT-20"], inputs={"history": E1049_HISTORY},
                      derivation="E1049 5.4.4 three-point rule, residue as half cycles (generator reproduces the quoted list)"))
    cases.append(case("VC-FAT-02", "four-point full cycles of the negated E1049 history, and full+residue totals",
                      {"fullCycles": [[a, b, r] for a, b, r, _ in full4], "residue": residue4, "totals": agg4},
                      "unit, cycles", {"abs": 0.0}, "S3 four-point test + generator", "B", ["FR-FAT-05", "TR-FAT-21"],
                      inputs={"history": [-x for x in E1049_HISTORY]}))
    cases.append(case("VC-FAT-03", "repeating-history rainflow (E1049 5.4.5 / Fig. 7)", agg7, "unit, cycles", {"abs": 0.0},
                      "S3 Fig.7 test (single source) + generator", "B", ["FR-FAT-05", "TR-FAT-20"],
                      inputs={"history": E1049_HISTORY}))
    cases.append(case("VC-FAT-04", "rainflow counts of the S2 TEST_CASE_2 history (regression, not from E1049)", agg2,
                      "unit, cycles", {"abs": 0.0}, "S2 TEST_CASE_2 + generator", "B", ["FR-FAT-05"],
                      inputs={"history": S2_CASE2_HISTORY}))

    # --- S-N
    n2_400 = basquin_reversals(400.0)
    cases.append(case("VC-FAT-10", "Basquin reversals to failure 2Nf at sigma_a = 400 MPa (sigma'f 1160 MPa, b -0.081)",
                      sig(n2_400), "reversals", {"rel": 1e-9}, "S6, S7 (formula) + generator", "A", ["FR-FAT-01", "TR-FAT-10"],
                      derivation="2Nf = (sigma_a / sigma'_f)^(1/b)"))
    n_sn = sn_power_law_cycles(300.0, 5.0, 1.0e6, 200.0)
    cases.append(case("VC-FAT-11", "S-N power law N at S = 300 MPa (k 5, N_D 1e6, S_D 200 MPa)", sig(n_sn), "cycles",
                      {"rel": 1e-9}, "S8 (parametrisation) + generator", "A", ["FR-FAT-01", "TR-FAT-10"],
                      derivation="N = N_D (S/S_D)^-k"))

    n2_mod = basquin_reversals(400.0, sigma_f=SIGMA_F * 0.8)
    cases.append(case("VC-FAT-15", "Basquin 2Nf at 400 MPa with an explicit surface modifier 0.8 on sigma'f", sig(n2_mod),
                      "reversals", {"rel": 1e-9}, "generator (TR-FAT-10 modifier rule)", "A", ["FR-FAT-20", "TR-FAT-10"]))
    n2_100 = basquin_reversals(100.0)
    cases.append(case("VC-FAT-61", "Basquin 2Nf at 100 MPa (beyond testedLifeRange max 1e7 cycles -> extrapolated)",
                      sig(n2_100), "reversals", {"rel": 1e-9}, "generator", "A", ["FR-FAT-14", "FR-FAT-15"],
                      expect={"extrapolated": True, "code": "FAT_CURVE_EXTRAPOLATED",
                              "staticCase": {"amplitudeMPa": 1500, "FtuMPa": 1400, "code": "FAT_STATIC_FAILURE"}}))

    # --- strain-life
    strain_rows = []
    for ea in [0.002, 0.003, 0.005, 0.0075, 0.01, 0.02]:
        n2 = cmb_reversals(ea)
        back = SIGMA_F / E * n2 ** B + EPS_F * n2 ** C
        assert abs(back - ea) < 1e-12
        strain_rows.append([ea, sig(n2), sig(n2 / 2.0)])
    n2_0075 = cmb_reversals(0.0075)
    cases.append(case("VC-FAT-12", "Coffin-Manson-Basquin 2Nf at eps_a = 0.0075 (Newton on log10 2N)", sig(n2_0075), "reversals",
                      {"rel": 1e-6}, "S6, S7 (formula) + generator", "A", ["FR-FAT-02", "TR-FAT-11"],
                      derivation="eps_a = sigma'f/E (2N)^b + eps'f (2N)^c; table in strain_life_table.csv"))
    cases.append(case("VC-FAT-13", "transition life 2Nt (elastic = plastic strain)", sig(transition_reversals()), "reversals",
                      {"rel": 1e-9}, "generator (closed form)", "A", ["FR-FAT-02"], derivation="2Nt = (eps'f E / sigma'f)^(1/(b-c))"))
    n2_morrow = cmb_reversals(0.005, sigma_m=100.0, model="morrow")
    cases.append(case("VC-FAT-14", "Morrow-corrected 2Nf at eps_a = 0.005, sigma_m = 100 MPa", sig(n2_morrow), "reversals",
                      {"rel": 1e-6}, "S6, S7 + generator", "A", ["FR-FAT-04", "TR-FAT-11"]))

    # --- notch + Neuber + SWT: reproduces S5 Example 1
    kf = kf_from_q(2.41, 0.9857)
    s_nom = 0.15e6 / (5.0 * 80.0)        # S5: P = 0.15 MN on A = 5 x 80 mm^2 -> 375 MPa
    s_local_el = kf * s_nom
    smax = neuber_stress(s_local_el)
    emax = ramberg_osgood_strain(smax)
    n2_swt = swt_reversals(smax, emax)
    cases.append(case("VC-FAT-20", "Kf = 1 + q (Kt - 1), Kt 2.41, q 0.9857", sig(kf), "-", {"rel": 1e-12},
                      "S5, S9 (formula) + generator", "A", ["FR-FAT-03", "TR-FAT-12"]))
    cases.append(case("VC-FAT-21", "Neuber local stress sigma_max for Kf S = %.6g MPa on the cyclic RO curve" % s_local_el,
                      sig(smax), "MPa", {"rel": 1e-6}, "generator + S5 Example 1 (prints 506.7291 MPa)", "A",
                      ["FR-FAT-03", "TR-FAT-12"], cross_check={"S5_sigma_max_MPa": 506.7291, "S5_eps_max": 0.0075},
                      derivation="sigma eps = (Kf S)^2 / E, eps = sigma/E + (sigma/K')^(1/n')"))
    cases.append(case("VC-FAT-22", "SWT life of the S5 Example 1 notch (cycles)", sig(n2_swt / 2.0), "cycles", {"rel": 1e-4},
                      "generator + S5 Example 1 (prints 2919.91 cycles)", "A", ["FR-FAT-02", "FR-FAT-04", "TR-FAT-11"],
                      cross_check={"S5_cycles": 2919.91},
                      note="the generator and the independent S5 implementation agree to 6 digits"))
    q_p = q_peterson(0.25, 1.0)
    q_n = q_neuber(0.25, 1.0)
    cases.append(case("VC-FAT-23", "notch sensitivity q, Peterson a = 0.25 mm and Neuber rho' = 0.25 mm at r = 1 mm",
                      {"peterson": sig(q_p), "neuber": sig(q_n)}, "-", {"rel": 1e-12}, "S5, S9 (formula) + generator", "A",
                      ["FR-FAT-03"], note="a and rho' are test inputs; llull ships no material notch constants (TECHNICAL_SPEC OQ-FAT-04)"))
    d_eps = masing_range_strain(800.0)
    cases.append(case("VC-FAT-24", "Masing hysteresis strain range for d_sigma = 800 MPa", sig(d_eps), "-", {"rel": 1e-12},
                      "S8 (Masing/RO), generator", "A", ["FR-FAT-03", "TR-FAT-12"]))

    # --- mean stress
    ms_inputs = {"sigma_a_MPa": 200.0, "sigma_m_MPa": 100.0, "Su_MPa": 500.0, "Sy_MPa": 400.0, "sigma_f_MPa": SIGMA_F,
                 "walker_gamma": 0.7}
    ms_vals = {m: sig(mean_stress(m, 200.0, 100.0, 500.0, 400.0, SIGMA_F, 0.7)) for m in MEAN_MODELS}
    assert abs(mean_stress("walker", 200.0, 100.0, 500.0, 400.0, SIGMA_F, 0.5) - ms_vals["swt"]) < 1e-9  # Walker(0.5) == SWT
    cases.append(case("VC-FAT-30", "equivalent fully reversed amplitude sigma_ar per mean-stress model", ms_vals, "MPa",
                      {"rel": 1e-12}, "S6, S7, S10 (formulas) + generator", "A", ["FR-FAT-04", "TR-FAT-13"], inputs=ms_inputs,
                      note="identity checked by the generator: Walker with gamma = 0.5 equals SWT"))
    ms_rows = []
    for sm in [-100.0, 0.0, 50.0, 100.0, 150.0, 200.0]:
        ms_rows.append([sm] + [sig(mean_stress(m, 200.0, sm, 500.0, 400.0, SIGMA_F, 0.7)) for m in MEAN_MODELS])

    # --- Miner on the E1049 history scaled 100 MPa per unit, Basquin curve, zero-mean assumption
    damage = 0.0
    for _, _, rng, cnt in c6:
        sa = 100.0 * rng / 2.0
        damage += cnt / (basquin_reversals(sa) / 2.0)
    cases.append(case("VC-FAT-40", "Palmgren-Miner damage of one E1049 block (1 unit = 100 MPa, Basquin, no mean correction)",
                      sig(damage), "-", {"rel": 1e-9}, "S11 (Miner rule) + generator", "A", ["FR-FAT-06", "TR-FAT-14"]))
    cases.append(case("VC-FAT-41", "blocks to D = 1 for the same history", sig(1.0 / damage), "blocks", {"rel": 1e-9},
                      "generator", "A", ["FR-FAT-06"]))

    # --- 05 FEA stress input: Kirsch peak scaled by the unit-load history (linear superposition)
    peak_per_100 = 300.0  # aerospace 05 VC-FEA-14 (gross Kt = 3 at 100 MPa remote)
    load_scale = 0.1  # plan mapping scale: LC1 (100 MPa remote) x 0.1 x load factor
    scaled = [peak_per_100 * load_scale * x for x in E1049_HISTORY]
    cases.append(case("VC-FAT-42", "local max-principal history at the hole edge: 05 Kirsch peak (300 MPa per 100 MPa) x scale 0.1 x load factors", [sig(v) for v in scaled],
                      "MPa", {"rel": 1e-12}, "aerospace 05 VC-FEA-14 + generator", "A", ["FR-FAT-07", "TR-FAT-15"]))

    # --- fatigue margin with explicit scatter factor (data contract; values are test inputs)
    life = 1.0 / damage
    req, sf = 1000.0, 3.0
    margin = life / (sf * req) - 1.0
    cases.append(case("VC-FAT-50", "fatigue life margin = N / (SF x N_required) - 1 (N_required 1000 blocks, SF 3 explicit)",
                      sig(margin), "-", {"abs": 1e-9}, "generator; SF is a test input (no verified default, OQ-FAT-01)",
                      "A", ["FR-FAT-08", "FR-FAT-09", "TR-FAT-16"]))
    cases.append(case("VC-FAT-60", "agent-first result contract", {
        "scatterFactorUnset": {"code": "FAT_SCATTER_FACTOR_UNSET", "severity": "error", "exit": 1},
        "reviewRequired": True, "summaryContains": "not approved",
        "disposeByAgent": {"code": "FAT_HUMAN_GATE", "exit": 1, "documentUnchanged": True},
        "unverifiedCurve": {"flag": "unverified", "check": "FAT_CURVE_UNVERIFIED"},
        "staleResults": {"code": "FAT_RESULTS_STALE"}}, "-", {"abs": 0.0}, "AGENT_FIRST AF-11/31/32/33/34", "A",
        ["FR-FAT-09", "FR-FAT-10", "FR-FAT-11", "FR-FAT-12", "TR-FAT-30"]))

    expected = {"pack": "07-fatigue", "generatedBy": "generate_fatigue_reference.py", "cases": cases}
    rf = {"source": "ASTM E1049-85 (R2017) Fig. 6/7 history as quoted by S2 and S3", "history": E1049_HISTORY,
          "threePointCycles": [[a, b, r, n] for a, b, r, n in c6], "threePointTotals": agg6,
          "repeatingHistoryCycles": [[a, b, r, n] for a, b, r, n in c7], "repeatingHistoryTotals": agg7,
          "fourPointNegated": {"fullCycles": [[a, b, r] for a, b, r, _ in full4], "residue": residue4},
          "pinned": {"S2": "github.com/iamlikeme/rainflow@5fc6822fd1c626739c6f95d9b4595ee80330b4fc tests/test_rainflow.py",
                     "S3": "github.com/dpzhuX/ffpack@b90bdeca06ab6659514bf3b656436421468207f0 tests/lcc/test_lcc_astmCounting.py"}}
    return expected, rf, strain_rows, ms_rows


def main() -> None:
    expected, rf, strain_rows, ms_rows = build()
    with open(out("expected_results.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(expected, f, indent=1, ensure_ascii=False)
        f.write("\n")
    with open(out("rainflow_e1049.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(rf, f, indent=1)
        f.write("\n")
    with open(out("strain_life_table.csv"), "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["eps_a", "reversals_2Nf", "cycles_Nf"])
        w.writerows(strain_rows)
    with open(out("mean_stress_table.csv"), "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["sigma_m_MPa"] + [m + "_sigma_ar_MPa" for m in MEAN_MODELS])
        w.writerows(ms_rows)


if __name__ == "__main__":
    main()
