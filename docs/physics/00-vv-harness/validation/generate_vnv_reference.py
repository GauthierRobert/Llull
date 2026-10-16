#!/usr/bin/env python3
"""
Generate the analytic reference values of PHY-00 (physics V&V harness).

Run:  python3 -I generate_vnv_reference.py      (stdlib only, deterministic, writes next to this script)

Outputs
  expected_results.json     cases in the docs/physics/README.md section 6.3 schema (12 significant digits)
  mms_poisson_1d.csv        method-of-manufactured-solutions error table for a 1D linear finite-element solver
  runner_fixtures.json      synthetic measured-vs-expected pairs that pin the benchmark runner's pass/fail rules

Formulas (source ids refer to sources.md):
  Observed order, constant ratio r:      p = ln((f3 - f2) / (f2 - f1)) / ln r                       [S3, S4, S5]
  Observed order, general r21, r32:      p = |ln|e32/e21| + q(p)| / ln r21,
                                         q(p) = ln((r21^p - s) / (r32^p - s)), s = sign(e32/e21)    [S4 (gcat, Celik 2008 form)]
  Richardson extrapolation:              f_ext = (r21^p f1 - f2) / (r21^p - 1)                       [S3, S4, S5]
  Approximate relative error:            e_a = |(f1 - f2) / f1|
  Grid convergence index (fine grid):    GCI = Fs e_a / (r21^p - 1), Fs = 1.25 (three grids)         [S1, S4, S5]
  Asymptotic ratio:                      AR = r21^p GCI21 / GCI32  (approx. 1 in the asymptotic range) [S4, S5]
  Required spacing for a target GCI*:    h* = h1 / (GCI21 / GCI*)^(1/p)                              [S5 (corrected NASA form)]
  Representative spacing:                h = (V / N)^(1/D)                                           [S4 (gcat check), Celik 2008]

Tolerances are llull acceptance choices (validation/README.md), not claims of any source.
"""

from __future__ import annotations

import csv
import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))


def sig(x: float, n: int = 12) -> float:
    """Round to n significant digits so the JSON is stable across platforms."""
    if x == 0 or not math.isfinite(x):
        return x
    return float(f"{x:.{n}g}")


# ----------------------------------------------------------------------------------------------------------
# 1. Grid-convergence arithmetic
# ----------------------------------------------------------------------------------------------------------
def observed_order(h1: float, h2: float, h3: float, f1: float, f2: float, f3: float) -> dict:
    """Return p (fixed-point iteration, relaxation 0.5 as in gcat [S4]) or a classification when undefined."""
    r21, r32 = h2 / h1, h3 / h2
    e21, e32 = f2 - f1, f3 - f2
    if e21 == 0 or e32 == 0:
        return {"status": "converged_exactly"}
    ratio = e32 / e21
    if ratio < 0:
        return {"status": "oscillatory", "ratio": ratio}
    s = 1.0
    p = abs(math.log(abs(ratio))) / math.log(r21)
    if abs(ratio) < 1.0:
        # differences grow under refinement: the solution diverges, p would be negative
        return {"status": "divergent", "ratio": ratio, "p": math.log(abs(ratio)) / math.log(r21)}
    for _ in range(10000):
        q = math.log((r21**p - s) / (r32**p - s))
        p_new = abs(math.log(abs(ratio)) + q) / math.log(r21)
        p_next = 0.5 * p + 0.5 * p_new
        if abs(p_next - p) < 1e-14:
            p = p_next
            break
        p = p_next
    return {"status": "monotone", "ratio": ratio, "p": p, "r21": r21, "r32": r32}


def gci_triplet(h1: float, h2: float, h3: float, f1: float, f2: float, f3: float, fs: float = 1.25) -> dict:
    o = observed_order(h1, h2, h3, f1, f2, f3)
    if o["status"] != "monotone":
        return o
    p, r21, r32 = o["p"], o["r21"], o["r32"]
    f_ext = (r21**p * f1 - f2) / (r21**p - 1.0)
    e_a21 = abs((f1 - f2) / f1)
    e_a32 = abs((f2 - f3) / f2)
    e_ext21 = abs((f_ext - f1) / f_ext)
    gci21 = fs * e_a21 / (r21**p - 1.0)
    gci32 = fs * e_a32 / (r32**p - 1.0)
    ar = r21**p * gci21 / gci32
    return {**o, "f_ext": f_ext, "e_a21": e_a21, "e_ext21": e_ext21, "gci21_fine": gci21,
            "gci21_coarse": gci21 * r21**p, "gci32_fine": gci32, "asymptotic_ratio": ar}


def required_spacing(gci_target: float, gci21: float, p: float, h1: float) -> float:
    return h1 / (gci21 / gci_target) ** (1.0 / p)


# ----------------------------------------------------------------------------------------------------------
# 2. Method of manufactured solutions: -u'' = f on (0, 1), u(0) = u(1) = 0, manufactured u = sin(pi x)
#    -> f = pi^2 sin(pi x). Linear (P1) elements on a uniform mesh, load vector integrated exactly:
#    F_i = integral(u' phi_i') = (2 u(x_i) - u(x_i-1) - u(x_i+1)) / h = 2 sin(pi x_i) (1 - cos(pi h)) / h.
#    With an exact load the 1D P1 nodal values are exact (nodal superconvergence); the L2 error converges
#    at order 2 and the H1-seminorm (energy) error at order 1.  [S6 (MMS procedure), textbook FE theory]
# ----------------------------------------------------------------------------------------------------------
GAUSS5 = [  # 5-point Gauss-Legendre on [-1, 1], exact to degree 9 (nodes and weights in closed form)
    (0.0, 128.0 / 225.0),
    (+math.sqrt(5.0 - 2.0 * math.sqrt(10.0 / 7.0)) / 3.0, (322.0 + 13.0 * math.sqrt(70.0)) / 900.0),
    (-math.sqrt(5.0 - 2.0 * math.sqrt(10.0 / 7.0)) / 3.0, (322.0 + 13.0 * math.sqrt(70.0)) / 900.0),
    (+math.sqrt(5.0 + 2.0 * math.sqrt(10.0 / 7.0)) / 3.0, (322.0 - 13.0 * math.sqrt(70.0)) / 900.0),
    (-math.sqrt(5.0 + 2.0 * math.sqrt(10.0 / 7.0)) / 3.0, (322.0 - 13.0 * math.sqrt(70.0)) / 900.0),
]


def solve_poisson_p1(n: int) -> tuple[list[float], float]:
    h = 1.0 / n
    m = n - 1  # interior unknowns
    diag = [2.0 / h] * m
    off = -1.0 / h
    rhs = [2.0 * math.sin(math.pi * (i + 1) * h) * (1.0 - math.cos(math.pi * h)) / h for i in range(m)]
    # Thomas algorithm (symmetric tridiagonal)
    c = [0.0] * m
    d = [0.0] * m
    c[0] = off / diag[0]
    d[0] = rhs[0] / diag[0]
    for i in range(1, m):
        den = diag[i] - off * c[i - 1]
        c[i] = off / den
        d[i] = (rhs[i] - off * d[i - 1]) / den
    u = [0.0] * m
    u[-1] = d[-1]
    for i in range(m - 2, -1, -1):
        u[i] = d[i] - c[i] * u[i + 1]
    return [0.0] + u + [0.0], h


def mms_errors(n: int) -> dict:
    u, h = solve_poisson_p1(n)
    l2 = 0.0
    h1 = 0.0
    nodal = 0.0
    for i in range(n + 1):
        nodal = max(nodal, abs(u[i] - math.sin(math.pi * i * h)))
    for e in range(n):
        xa, xb = e * h, (e + 1) * h
        slope = (u[e + 1] - u[e]) / h
        for xi, w in GAUSS5:
            x = 0.5 * (xa + xb) + 0.5 * h * xi
            uh = u[e] + slope * (x - xa)
            l2 += 0.5 * h * w * (math.sin(math.pi * x) - uh) ** 2
            h1 += 0.5 * h * w * (math.pi * math.cos(math.pi * x) - slope) ** 2
    return {"n": n, "h": h, "l2": math.sqrt(l2), "h1semi": math.sqrt(h1), "nodalMax": nodal}


# ----------------------------------------------------------------------------------------------------------
# 3. Build cases
# ----------------------------------------------------------------------------------------------------------
def case(cid, quantity, value, unit, tol, source, grade, proves, **extra):
    c = {"id": cid, "quantity": quantity, "value": sig(value) if isinstance(value, float) else value, "unit": unit,
         "tolerance": tol, "source": source, "grade": grade, "proves": proves}
    c.update(extra)
    return c


def main() -> None:
    cases = []

    # VC-VNV-01: NASA GRC tutorial example as reproduced by the `convergence` package README [S5]
    nasa = gci_triplet(1.0, 2.0, 4.0, 0.970500, 0.968540, 0.961780)
    inputs_nasa = {"h": [1.0, 2.0, 4.0], "f": [0.9705, 0.96854, 0.96178], "Fs": 1.25}
    for suffix, key, q, quoted in [
        ("a", "p", "observed order of convergence p", 1.786170),
        ("b", "f_ext", "Richardson-extrapolated value f_ext", 0.971300),
        ("c", "gci21_fine", "GCI21 (fine grid, fraction)", 0.001031),
        ("d", "gci32_fine", "GCI32 (fraction)", 0.003562),
        ("e", "asymptotic_ratio", "asymptotic ratio r^p GCI21 / GCI32", 0.997980),
    ]:
        cases.append(case(f"VC-VNV-01.{suffix}", q, nasa[key], "1", {"rel": 1e-9}, "generator + S5 (quoted to 6 digits)", "A",
                          ["FR-VNV-01", "FR-VNV-02", "TR-VNV-03"], inputs=inputs_nasa,
                          quotedBySource=quoted, derivation="p = ln((f3-f2)/(f2-f1))/ln r; GCI = 1.25 e_a/(r^p - 1)"))

    # VC-VNV-02: exact power law, constant ratio -> p = 2, f_ext = 10 exactly
    f = lambda h: 10.0 + 0.5 * h * h  # noqa: E731
    syn = gci_triplet(0.1, 0.2, 0.4, f(0.1), f(0.2), f(0.4))
    cases.append(case("VC-VNV-02.a", "observed order, f = 10 + 0.5 h^2, h = 0.1/0.2/0.4", syn["p"], "1", {"abs": 1e-9},
                      "generator (exact)", "A", ["FR-VNV-01", "TR-VNV-03"]))
    cases.append(case("VC-VNV-02.b", "extrapolated value, same data", syn["f_ext"], "1", {"abs": 1e-9},
                      "generator (exact)", "A", ["FR-VNV-02", "TR-VNV-03"]))
    cases.append(case("VC-VNV-02.c", "GCI21 fine, same data", syn["gci21_fine"], "1", {"rel": 1e-9},
                      "generator (exact)", "A", ["FR-VNV-02", "TR-VNV-03"]))

    # VC-VNV-03: same law, non-constant refinement ratio (r21 = 1.5, r32 = 2) -> iteration must still give p = 2
    syn2 = gci_triplet(0.1, 0.15, 0.3, f(0.1), f(0.15), f(0.3))
    cases.append(case("VC-VNV-03.a", "observed order, h = 0.1/0.15/0.3 (r21 = 1.5, r32 = 2)", syn2["p"], "1", {"abs": 1e-9},
                      "generator (exact)", "A", ["FR-VNV-01", "TR-VNV-03"]))
    cases.append(case("VC-VNV-03.b", "extrapolated value, same data", syn2["f_ext"], "1", {"abs": 1e-9},
                      "generator (exact)", "A", ["FR-VNV-02", "TR-VNV-03"]))

    # VC-VNV-04: oscillatory, VC-VNV-05: divergent -> classification + stable codes, no p reported
    osc = observed_order(1.0, 2.0, 4.0, 1.00, 1.02, 0.99)
    cases.append(case("VC-VNV-04", "classification of f = 1.00 / 1.02 / 0.99 (h = 1/2/4)", osc["status"], "-", {"exact": True},
                      "generator (sign of e32/e21)", "A", ["FR-VNV-03", "TR-VNV-04"], code="VNV_OSCILLATORY",
                      ratio=sig(osc["ratio"])))
    div = observed_order(1.0, 2.0, 4.0, 1.00, 1.10, 1.15)
    cases.append(case("VC-VNV-05", "classification of f = 1.00 / 1.10 / 1.15 (h = 1/2/4)", div["status"], "-", {"exact": True},
                      "generator (|e32/e21| < 1)", "A", ["FR-VNV-03", "TR-VNV-04"], code="VNV_DIVERGENT",
                      ratio=sig(div["ratio"]), pIfForced=sig(div["p"])))

    # VC-VNV-06: gcat README example (independent MIT implementation) [S4]
    g = gci_triplet(8.30, 10.84, 14.14, 1.0, 1.02, 1.08)
    quoted_g = {"p": 4.143231, "gci21_fine": 1.235897e-02, "gci21_coarse": 3.735897e-02, "gci32_fine": 3.662651e-02,
                "asymptotic_ratio": 1.019998}
    for suffix, key in [("a", "p"), ("b", "gci21_fine"), ("c", "gci21_coarse"), ("d", "gci32_fine"), ("e", "asymptotic_ratio")]:
        cases.append(case(f"VC-VNV-06.{suffix}", f"gcat README example: {key}", g[key], "1", {"rel": 1e-5},
                          "generator + S4 (quoted to 7 digits)", "A", ["FR-VNV-01", "FR-VNV-02", "FR-VNV-04", "TR-VNV-03"],
                          inputs={"h": [8.30, 10.84, 14.14], "f": [1.0, 1.02, 1.08], "Fs": 1.25}, quotedBySource=quoted_g[key],
                          note="p = 4.14 is far above a formal order of 2: check_convergence must warn VNV_ORDER_MISMATCH"))

    # VC-VNV-07: MMS, 1D P1 finite elements
    rows = [mms_errors(n) for n in (4, 8, 16, 32, 64)]
    with open(os.path.join(HERE, "mms_poisson_1d.csv"), "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["n_elements", "h", "L2_error", "H1_seminorm_error", "nodal_max_error", "order_L2", "order_H1"])
        prev = None
        for row in rows:
            oL2 = "" if prev is None else repr(sig(math.log(prev["l2"] / row["l2"]) / math.log(2.0)))
            oH1 = "" if prev is None else repr(sig(math.log(prev["h1semi"] / row["h1semi"]) / math.log(2.0)))
            w.writerow([row["n"], repr(sig(row["h"])), repr(sig(row["l2"])), repr(sig(row["h1semi"])),
                        f"{row['nodalMax']:.3e}", oL2, oH1])
            prev = row
    r32, r64 = rows[-2], rows[-1]
    cases.append(case("VC-VNV-07.a", "MMS 1D P1: L2 error at n = 64", r64["l2"], "1", {"rel": 1e-6},
                      "generator (exact load, 5-point Gauss error integration)", "A", ["FR-VNV-05", "TR-VNV-06"]))
    cases.append(case("VC-VNV-07.b", "MMS 1D P1: observed L2 order between n = 32 and 64",
                      math.log(r32["l2"] / r64["l2"]) / math.log(2.0), "1", {"abs": 0.01},
                      "generator; formal order 2", "A", ["FR-VNV-05", "TR-VNV-06"]))
    cases.append(case("VC-VNV-07.c", "MMS 1D P1: observed H1-seminorm order between n = 32 and 64",
                      math.log(r32["h1semi"] / r64["h1semi"]) / math.log(2.0), "1", {"abs": 0.01},
                      "generator; formal order 1", "A", ["FR-VNV-05", "TR-VNV-06"]))
    cases.append(case("VC-VNV-07.d", "MMS 1D P1: max nodal error (nodal superconvergence)", 0.0, "1", {"abs": 1e-12},
                      "generator; exact load gives exact nodal values in 1D", "A", ["FR-VNV-05"],
                      measuredByGenerator=f"{max(r['nodalMax'] for r in rows):.3e}"))

    # VC-VNV-08: required spacing (corrected NASA formula, convergence package unit test values) [S5]
    cases.append(case("VC-VNV-08", "required spacing h* for GCI* = 0.1 given GCI21 = 0.4, p = 2, h1 = 4",
                      required_spacing(0.1, 0.4, 2.0, 4.0), "length unit of h", {"abs": 1e-10},
                      "generator + S5 (test_required_resolution expects 2)", "A", ["FR-VNV-06"]))

    # VC-VNV-09: representative spacing h = (V/N)^(1/D)
    cases.append(case("VC-VNV-09.a", "representative spacing, 3D, N = 1000 elements, V = 1", (1.0 / 1000.0) ** (1.0 / 3.0), "1",
                      {"rel": 1e-12}, "generator", "A", ["TR-VNV-02"]))
    cases.append(case("VC-VNV-09.b", "representative spacing, 2D, N = 2900, A = 0.2 m^2 (gcat README 'check')",
                      math.sqrt(0.2 / 2900.0) * 1000.0, "mm", {"rel": 1e-6}, "generator + S4 (h1 = 8.304548 mm)", "A",
                      ["TR-VNV-02"], quotedBySource=8.304548))

    # VC-VNV-10/11: discretisation studies run through gap 05 FEA (values measured once the solver exists)
    cases.append(case("VC-VNV-10", "05 FEA beamp cantilever tip u_y: GCI21 with tet10 at h = 1, 0.5, 0.25 mm",
                      "TBD", "1", {"rel": None}, "TBD - measure with check_convergence on 05 FEA plan fea_cantilever_static_beamp",
                      "TBD", ["FR-VNV-07", "FR-VNV-09"],
                      note="extrapolated u_y must fall within 2 % of 0.0888411 mm (05 VC-FEA-10.b, EB + Timoshenko) once measured"))
    cases.append(case("VC-VNV-11", "NAFEMS LE10 sigma_yy(D): observed order and GCI with tet10 refinement",
                      "TBD", "1", {"rel": None}, "TBD - measure (05 VC-FEA-31 target -5.38 MPa)", "TBD", ["FR-VNV-07", "FR-VNV-09"]))

    # VC-VNV-12..18: behaviour contracts (exact, no physics value)
    cases.append(case("VC-VNV-12", "judge verdicts for runner_fixtures.json RF-01..RF-08",
                      ["pass", "fail", "pass", "warn", "skip", "pass", "error", "error"], "-", {"exact": True},
                      "generator (TECHNICAL_SPEC 5.3 rules)", "A", ["FR-VNV-10", "FR-VNV-11"]))
    cases.append(case("VC-VNV-13", "check_verification after set_parameter on a studied case", "VNV_STUDY_STALE", "-",
                      {"exact": True}, "TECHNICAL_SPEC 7.1", "A", ["FR-VNV-13"]))
    cases.append(case("VC-VNV-14", "accept_verification_exception by an agent without signature", "VNV_HUMAN_GATE", "-",
                      {"exact": True}, "AGENT_FIRST AF-34", "A", ["FR-VNV-14", "TR-VNV-12"], documentUnchanged=True))
    cases.append(case("VC-VNV-15", "study over an unverified material result", "VNV_INPUT_UNVERIFIED", "-", {"exact": True},
                      "AGENT_FIRST AF-32", "A", ["FR-VNV-14"], expectFields={"unverified": True, "reviewRequired": True}))
    cases.append(case("VC-VNV-16", "record_convergence_study: absent hash / edited value / genuine",
                      ["VNV_ARTIFACT_NOT_FOUND", "VNV_SUMMARY_MISMATCH", "accepted"], "-", {"exact": True},
                      "TECHNICAL_SPEC 4 (validated record)", "A", ["TR-VNV-09"]))
    cases.append(case("VC-VNV-17", "two identical study runs", "identical study JSON", "-", {"exact": True},
                      "TECHNICAL_SPEC TR-VNV-10", "A", ["TR-VNV-10"]))
    cases.append(case("VC-VNV-18", "deliberately wrong check_convergence / compare_to_expected inputs",
                      [{"input": "1 sample", "code": "VNV_SAMPLES_INVALID", "path": "samples"},
                       {"input": "duplicate h", "code": "VNV_SAMPLES_INVALID", "path": "samples[1].h"},
                       {"input": "h = 0", "code": "VNV_SAMPLES_INVALID", "path": "samples[0].h"},
                       {"input": "value NaN", "code": "VNV_SAMPLES_INVALID", "path": "samples[2].value"},
                       {"input": "2 samples, no assumedOrder", "code": "VNV_SAMPLES_INVALID", "path": "assumedOrder"},
                       {"input": "expected case without unit", "code": "VNV_EXPECTED_INVALID", "path": "expected.unit"},
                       {"input": "MPa expected, mm measured", "code": "VNV_UNIT_MISMATCH", "path": "measured.unit"}],
                      "-", {"exact": True}, "TECHNICAL_SPEC 7.1", "A", ["FR-VNV-16"]))

    doc = {
        "pack": "00-vv-harness",
        "generatedBy": "generate_vnv_reference.py",
        "units": "dimensionless unless stated",
        "cases": cases,
    }
    with open(os.path.join(HERE, "expected_results.json"), "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=1, ensure_ascii=False, sort_keys=False)
        fh.write("\n")

    # Runner fixtures: how the benchmark runner judges a measured value (README section 6.3 semantics)
    fixtures = {
        "pack": "00-vv-harness",
        "generatedBy": "generate_vnv_reference.py",
        "rule": "pass iff |measured - value| <= abs, or |measured - value| <= rel * |value|; grade B, C, TBD never fail the gate",
        "fixtures": [
            {"id": "RF-01", "expected": {"value": 36.6, "unit": "degC", "tolerance": {"rel": 0.01}, "grade": "A"},
             "measured": {"value": 36.9, "unit": "degC"}, "verdict": "pass", "relError": sig(0.3 / 36.6)},
            {"id": "RF-02", "expected": {"value": 36.6, "unit": "degC", "tolerance": {"rel": 0.01}, "grade": "A"},
             "measured": {"value": 37.0, "unit": "degC"}, "verdict": "fail", "relError": sig(0.4 / 36.6), "code": "VNV_BENCHMARK_FAILED"},
            {"id": "RF-03", "expected": {"value": 0.0, "unit": "1", "tolerance": {"abs": 1e-12}, "grade": "A"},
             "measured": {"value": 3e-13, "unit": "1"}, "verdict": "pass"},
            {"id": "RF-04", "expected": {"value": 92.7, "unit": "MPa", "tolerance": {"rel": 0.02}, "grade": "B"},
             "measured": {"value": 85.0, "unit": "MPa"}, "verdict": "warn", "code": "VNV_BENCHMARK_UNCONFIRMED",
             "note": "grade B is reported, never gating"},
            {"id": "RF-05", "expected": {"value": "TBD", "unit": "MPa", "grade": "TBD"},
             "measured": {"value": -5.4, "unit": "MPa"}, "verdict": "skip", "code": "VNV_EXPECTED_TBD"},
            {"id": "RF-06", "expected": {"value": 92.7, "unit": "MPa", "tolerance": {"rel": 0.02}, "grade": "A"},
             "measured": {"value": 92700000.0, "unit": "Pa"}, "verdict": "pass", "note": "units converted with lib/quantity before comparison"},
            {"id": "RF-07", "expected": {"value": 92.7, "unit": "MPa", "tolerance": {"rel": 0.02}, "grade": "A"},
             "measured": {"value": 92.7, "unit": "mm"}, "verdict": "error", "code": "VNV_UNIT_MISMATCH"},
            {"id": "RF-08", "expected": {"value": 92.7, "unit": "MPa", "tolerance": {"rel": 0.02}, "grade": "A"},
             "measured": None, "verdict": "error", "code": "VNV_RESULT_MISSING"},
        ],
    }
    with open(os.path.join(HERE, "runner_fixtures.json"), "w", encoding="utf-8") as fh:
        json.dump(fixtures, fh, indent=1, ensure_ascii=False)
        fh.write("\n")


if __name__ == "__main__":
    main()
