#!/usr/bin/env python3
"""Reference-result generator for llull gap PHY-01 PROP (docs/physics/01-property-models).

Python 3 standard library only. Run from this folder:
    python3 -I generate_prop_reference.py           # writes expected_results.json
    python3 -I generate_prop_reference.py --check   # exit 1 if the committed JSON differs

Inputs: nist_cryogenic_fits.json (NIST curve-fit coefficients, cross-checked transcriptions; see sources.md).
Every expected value is DERIVED here, by a formula written in this file, from a cited input (TEMPLATE rule (b))
or from a synthetic fixture that is labelled as such. Values are stored with 12 significant digits.
"""
from __future__ import annotations

import json
import math
import sys
from fractions import Fraction
from pathlib import Path

HERE = Path(__file__).parent
OUT = HERE / "expected_results.json"
PACK = "01-property-models"
GEN = "generate_prop_reference.py"
# SI 2019 exact constants: R = N_A * k_B (both exact by definition).
N_A = 6.02214076e23
K_B = 1.380649e-23
R_GAS = N_A * K_B


def sig(x: float, digits: int = 12) -> float:
    return float(f"{x:.{digits}g}")


# ---------------------------------------------------------------- forms (TECHNICAL_SPEC §5.1)
def log10_poly(c: list[float], t: float) -> float:
    x = math.log10(t)
    return 10.0 ** sum(ck * x ** k for k, ck in enumerate(c))


def nist_rational(c: list[float], t: float) -> float:
    a, b, cc, d, e, f, g, h, i = c
    num = a + cc * t ** 0.5 + e * t + g * t ** 1.5 + i * t ** 2
    den = 1.0 + b * t ** 0.5 + d * t + f * t ** 1.5 + h * t ** 2
    return 10.0 ** (num / den)


def poly(c: list[float], t: float) -> float:
    return sum(ck * t ** k for k, ck in enumerate(c))


def dpoly(c: list[float], t: float) -> float:
    return sum(k * ck * t ** (k - 1) for k, ck in enumerate(c) if k > 0)


def thermal_strain(fit: dict, t: float) -> float:
    t_low = fit.get("tLowK")
    if t_low is not None and t < t_low:
        return fit["belowValue"]
    return poly(fit["coefficients"], t)


def evaluate(fit: dict, t: float) -> float:
    form = fit["form"]
    if form == "log10Polynomial":
        return log10_poly(fit["coefficients"], t)
    if form == "nistRational":
        return nist_rational(fit["coefficients"], t)
    if form == "polynomial":
        return poly(fit["coefficients"], t)
    if form == "thermalStrainNist":
        return thermal_strain(fit, t)
    if form == "piecewise":
        for seg in fit["segments"]:
            lo, hi = seg["rangeK"]
            if lo <= t <= hi:  # left segment wins at a shared breakpoint (TECHNICAL_SPEC §5.1 rule P2)
                return poly(seg["coefficients"], t)
    raise ValueError(f"{fit['id']}: {form} at {t}")


def range_status(fit: dict, t: float) -> str:
    data = fit.get("dataRangeK")
    eq = fit.get("equationRangeK") or data
    if eq is None:
        return "range_tbd"
    if t < eq[0] or t > eq[1]:
        return "PROP_OUT_OF_RANGE"
    if data is not None and (t < data[0] or t > data[1]):
        return "in_equation_range_only"
    return "in_data_range"


def case(cid: str, quantity: str, value, unit: str, tol: dict, source: str, grade: str, proves: list[str], **extra) -> dict:
    c = {"id": cid, "quantity": quantity, "value": value, "unit": unit, "tolerance": tol, "source": source,
         "grade": grade, "proves": proves}
    c.update(extra)
    return c


# ---------------------------------------------------------------- VC-PROP-01..06: NIST fits evaluated
EVAL_POINTS = {
    "aa6061_t6.k": [4, 10, 20, 77, 100, 200, 300],
    "aa6061_t6.cp": [4, 10, 20, 77, 100, 200, 300],
    "ss304.k": [4, 20, 77, 300],
    "ss304.cp": [4, 20, 77, 300],
    "ti6al4v.k": [23, 77, 300],
    "g10cr.k.normal": [20, 77, 300],
    "cu_ofhc.k.rrr50": [4, 20, 77, 300],
    "cu_ofhc.k.rrr100": [4, 20, 77, 300],
    "aa6061_t6.E": [4, 77, 295],
}
VC_OF = {"aa6061_t6.k": "VC-PROP-01", "aa6061_t6.cp": "VC-PROP-02", "ss304.k": "VC-PROP-03", "ss304.cp": "VC-PROP-03",
         "ti6al4v.k": "VC-PROP-04", "g10cr.k.normal": "VC-PROP-05", "cu_ofhc.k.rrr50": "VC-PROP-06",
         "cu_ofhc.k.rrr100": "VC-PROP-06", "aa6061_t6.E": "VC-PROP-07"}


def nist_cases(fits: dict) -> list[dict]:
    out = []
    for fid, temps in EVAL_POINTS.items():
        fit = fits[fid]
        for t in temps:
            v = evaluate(fit, float(t))
            out.append(case(f"{VC_OF[fid]}/{fid}/T={t}K", f"{fit['property']} of {fit['material']} at {t} K",
                            sig(v), fit["unit"], {"rel": 1e-9}, f"S1 NIST fit via {'+'.join(fit['agreeIn'])}; evaluated here",
                            "A", ["FR-PROP-02", "FR-PROP-03", "TR-PROP-03"], form=fit["form"],
                            rangeStatus=range_status(fit, float(t))))
    return out


def thermal_cases(fits: dict) -> list[dict]:
    fit = fits["aa6061_t6.thermalStrain"]
    out = []
    for t in (4.0, 20.0, 77.0, 293.0):
        s = thermal_strain(fit, t)
        out.append(case(f"VC-PROP-07/aa6061_t6.thermalStrain/T={t:g}K", "(L - L293)/L293 of 6061-T6", sig(s * 1e-5), "1",
                        {"rel": 1e-9}, "S1 NIST fit via T1+T2 (tLow from T2)", "B" if t < 18 else "A",
                        ["FR-PROP-02", "FR-PROP-07"], rangeStatus=range_status(fit, t)))
    for t in (77.0, 200.0, 293.0):
        s = thermal_strain(fit, t) * 1e-5
        ds = dpoly(fit["coefficients"], t) * 1e-5
        out.append(case(f"VC-PROP-07/aa6061_t6.cte/T={t:g}K", "instantaneous CTE alpha = (ds/dT)/(1 + s), llull derivation",
                        sig(ds / (1.0 + s)), "1/K", {"rel": 1e-9}, "derived analytically from the S1 thermal-strain fit",
                        "A", ["FR-PROP-07", "TR-PROP-05"], note="llull derivation, not a NIST-published CTE fit"))
    return out


# ---------------------------------------------------------------- VC-PROP-08: range guard
def range_cases(fits: dict) -> list[dict]:
    out = []
    for fid, t, expect in (("aa6061_t6.k", 0.5, "PROP_OUT_OF_RANGE"), ("aa6061_t6.k", 400.0, "PROP_OUT_OF_RANGE"),
                           ("aa6061_t6.k", 2.0, "in_equation_range_only"), ("ti6al4v.k", 10.0, "PROP_OUT_OF_RANGE"),
                           ("ti6al4v.k", 21.0, "in_equation_range_only"), ("aa6061_t6.cp", 3.0, "PROP_OUT_OF_RANGE")):
        got = range_status(fits[fid], t)
        assert got == expect, (fid, t, got)
        extra = {}
        if got == "in_equation_range_only":
            extra["valueIfWarned"] = sig(evaluate(fits[fid], t))
            extra["unverifiedReason"] = "outside data range"
        out.append(case(f"VC-PROP-08/{fid}/T={t:g}K", f"range status of {fid} at {t:g} K", got, "-", {"exact": True},
                        "ranges in nist_cryogenic_fits.json (S1 search extracts)", "A",
                        ["FR-PROP-04", "TR-PROP-04"], **extra))
    return out


# ---------------------------------------------------------------- VC-PROP-09: piecewise + conflicting transcriptions
def piecewise_and_conflict_cases(fits: dict) -> list[dict]:
    out = []
    e304 = fits["ss304.E"]
    lo, hi = e304["segments"]
    jump = poly(hi["coefficients"], 57.0) - poly(lo["coefficients"], 57.0)
    out.append(case("VC-PROP-09/ss304.E/jump@57K", "discontinuity at the 57 K breakpoint (high - low segment)", sig(jump), "GPa",
                    {"rel": 1e-9}, "S1 NIST 304 E segments via T1", "B", ["FR-PROP-05", "TR-PROP-06"],
                    expectCheck="PROP_DISCONTINUITY warning when |jump|/value > 1e-3 (named default)",
                    relativeJump=sig(jump / poly(lo["coefficients"], 57.0))))
    for t in (20.0, 57.0, 100.0):
        out.append(case(f"VC-PROP-09/ss304.E/T={t:g}K", "304 E, piecewise (left segment wins at 57 K)", sig(evaluate(e304, t)), "GPa",
                        {"rel": 1e-9}, "S1 via T1/T2", "B", ["FR-PROP-05"]))
    a, b = fits["invar36.thermalStrain.T1"], fits["invar36.thermalStrain.T2"]
    d = thermal_strain(a, 300.0) - thermal_strain(b, 300.0)
    out.append(case("VC-PROP-09/invar36/transcriptionConflict@300K", "difference between two transcriptions of one NIST fit at 300 K",
                    sig(d * 1e-5), "1", {"rel": 1e-9}, "T1 vs T2 (e = 9.794e-11 vs 8.794e-11)", "A",
                    ["FR-PROP-08", "TR-PROP-09"], expectCheck="PROP_SOURCE_CONFLICT warning: same sourceId + locator, different coefficients"))
    return out


# ---------------------------------------------------------------- VC-PROP-10..12: synthetic forms, interpolation, multi-variable
def synthetic_cases() -> list[dict]:
    out = []
    a_pre, q = 1.0e-3, 150e3  # synthetic Arrhenius fixture: y = A exp(-Q/(R T))
    for t in (600.0, 800.0, 1000.0):
        out.append(case(f"VC-PROP-10/arrhenius/T={t:g}K", "synthetic Arrhenius y = 1e-3 * exp(-150000/(R*T))",
                        sig(a_pre * math.exp(-q / (R_GAS * t))), "1/s", {"rel": 1e-9}, "synthetic; R = N_A*k_B exact (SI 2019)", "A",
                        ["FR-PROP-02", "TR-PROP-03"]))
    pts = [(100.0, 10.0), (200.0, 40.0), (400.0, 160.0)]  # synthetic, exactly y = 10 (T/100)^2

    def lin(x):
        (x0, y0), (x1, y1) = pts[1], pts[2]
        return y0 + (y1 - y0) * (x - x0) / (x1 - x0)

    def loglog(x):
        (x0, y0), (x1, y1) = pts[1], pts[2]
        return math.exp(math.log(y0) + (math.log(y1) - math.log(y0)) * (math.log(x) - math.log(x0)) / (math.log(x1) - math.log(x0)))

    def loglin(x):
        (x0, y0), (x1, y1) = pts[1], pts[2]
        return math.exp(math.log(y0) + (math.log(y1) - math.log(y0)) * (x - x0) / (x1 - x0))

    for mode, v in (("linear", lin(300.0)), ("loglog", loglog(300.0)), ("loglinear", loglin(300.0)), ("step", 40.0)):
        out.append(case(f"VC-PROP-11/table1d/{mode}/T=300K", f"synthetic table (100,10),(200,40),(400,160) at 300 K, mode {mode}",
                        sig(v), "W/(m*K)", {"rel": 1e-12}, "synthetic; interpolation rules TECHNICAL_SPEC §5.2", "A",
                        ["FR-PROP-05", "TR-PROP-06"]))
    # table2d: axes T (linear) and log10(strain rate); values synthetic (MPa)
    ts, rates = (293.0, 473.0), (1e-3, 1e3)
    vals = ((300.0, 360.0), (250.0, 320.0))
    t, rate = 383.0, 1.0
    u = (t - ts[0]) / (ts[1] - ts[0])
    w = (math.log10(rate) - math.log10(rates[0])) / (math.log10(rates[1]) - math.log10(rates[0]))
    v = (1 - u) * (1 - w) * vals[0][0] + (1 - u) * w * vals[0][1] + u * (1 - w) * vals[1][0] + u * w * vals[1][1]
    out.append(case("VC-PROP-12/table2d/T=383K,rate=1/s", "synthetic yield stress table, bilinear in (T, log10 rate)", sig(v), "MPa",
                    {"rel": 1e-12}, "synthetic", "A", ["FR-PROP-06", "TR-PROP-06"]))
    # rel 1e-11 below: values are stored to 12 significant digits, so rounding alone reaches 5e-12 relative
    jc = 1.0 + 0.014 * math.log(1000.0 / 1.0)
    cs = 1.0 + (1000.0 / 40.4) ** (1.0 / 5.0)
    out.append(case("VC-PROP-12/rateFactor/johnsonCook", "synthetic J-C rate factor 1 + C ln(rate/rate0), C = 0.014, rate0 = 1/s, rate = 1000/s",
                    sig(jc), "1", {"rel": 1e-11}, "synthetic; form from Johnson & Cook 1983 (S9)", "A", ["FR-PROP-06"]))
    out.append(case("VC-PROP-12/rateFactor/cowperSymonds", "synthetic Cowper-Symonds 1 + (rate/D)^(1/q), D = 40.4/s, q = 5, rate = 1000/s",
                    sig(cs), "1", {"rel": 1e-11}, "synthetic fixture (constants not attributed)", "A", ["FR-PROP-06"]))
    return out


# ---------------------------------------------------------------- VC-PROP-13..14: fitting (exact rational least squares)
def lstsq_exact(rows: list[list[Fraction]], rhs: list[Fraction]) -> list[Fraction]:
    n = len(rows[0])
    ata = [[sum(r[i] * r[j] for r in rows) for j in range(n)] for i in range(n)]
    atb = [sum(r[i] * y for r, y in zip(rows, rhs)) for i in range(n)]
    for col in range(n):  # Gauss-Jordan, exact
        piv = next(k for k in range(col, n) if ata[k][col] != 0)
        ata[col], ata[piv] = ata[piv], ata[col]
        atb[col], atb[piv] = atb[piv], atb[col]
        for k in range(n):
            if k != col and ata[k][col] != 0:
                f = ata[k][col] / ata[col][col]
                ata[k] = [a - f * b for a, b in zip(ata[k], ata[col])]
                atb[k] -= f * atb[col]
    return [atb[i] / ata[i][i] for i in range(n)]


FIT_TEMPS = [4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60, 70, 80, 90, 100, 120, 140, 160, 180, 200, 220, 240, 260, 280, 300]


def fit_cases(fits: dict) -> list[dict]:
    out = []
    fit = fits["aa6061_t6.k"]
    coeff = fit["coefficients"][:8]  # i = 0 for this fit: degree 7
    xs = [Fraction(math.log10(t)) for t in FIT_TEMPS]
    ys = [Fraction(math.log10(log10_poly(fit["coefficients"], float(t)))) for t in FIT_TEMPS]
    sol = lstsq_exact([[x ** k for k in range(8)] for x in xs], ys)
    max_rel = 0.0
    for t in FIT_TEMPS:
        x = math.log10(t)
        refit = 10.0 ** sum(float(c) * x ** k for k, c in enumerate(sol))
        max_rel = max(max_rel, abs(refit / log10_poly(fit["coefficients"], float(t)) - 1.0))
    out.append(case("VC-PROP-13/refit6061k/maxRelError", "max relative error of a degree-7 log10-polynomial refit of 27 samples of the 6061-T6 k fit",
                    0.0, "1", {"abs": 1e-8}, "S1 fit sampled at 27 temperatures 4-300 K; exact rational least squares here", "A",
                    ["FR-PROP-09", "TR-PROP-08"], generatorObserved=sig(max_rel, 3)))
    out.append(case("VC-PROP-13/refit6061k/coefficients", "refit coefficients a..h (should reproduce the NIST coefficients)",
                    [sig(float(c)) for c in sol], "-", {"abs": 1e-5}, "same", "A", ["FR-PROP-09", "TR-PROP-08"],
                    reference=coeff, generatorMaxAbsDiff=sig(max(abs(float(c) - r) for c, r in zip(sol, coeff)), 3)))
    a_pre, q = 1.0e-3, 150e3
    temps = [500, 600, 700, 800, 900, 1000]
    rows = [[Fraction(1), Fraction(-1.0 / (R_GAS * t))] for t in temps]
    rhs = [Fraction(math.log(a_pre * math.exp(-q / (R_GAS * t)))) for t in temps]
    ln_a, q_fit = lstsq_exact(rows, rhs)
    out.append(case("VC-PROP-14/arrheniusFit/Q", "Arrhenius fit (ln y vs 1/T) of the synthetic VC-PROP-10 data: activation energy", sig(float(q_fit)),
                    "J/mol", {"rel": 1e-9}, "synthetic; exact rational least squares", "A", ["FR-PROP-09", "TR-PROP-08"]))
    out.append(case("VC-PROP-14/arrheniusFit/A", "same: pre-exponential factor", sig(math.exp(float(ln_a))), "1/s", {"rel": 1e-9},
                    "synthetic", "A", ["FR-PROP-09"]))
    return out


# ---------------------------------------------------------------- VC-PROP-15..17: uncertainty, units, legacy 08 tables
def misc_cases(fits: dict) -> list[dict]:
    out = []
    k77 = evaluate(fits["aa6061_t6.k"], 77.0)
    out.append(case("VC-PROP-15/aa6061_t6.k/band@77K", "fit-error band k(77 K) * (1 -/+ 0.005), kind fitErrorVsData (not a confidence bound)",
                    [sig(k77 * 0.995), sig(k77 * 1.005)], "W/(m*K)", {"rel": 1e-9}, "S1 coefficients (A) + 0.5 % fit error (search extract)",
                    "B", ["FR-PROP-10", "TR-PROP-10"]))
    t_c = -196.0 + 273.15
    out.append(case("VC-PROP-16/aa6061_t6.k/T=-196degC", "k at -196 degC (= 77.15 K) requested in degC", sig(evaluate(fits["aa6061_t6.k"], t_c)),
                    "W/(m*K)", {"rel": 1e-9}, "S1 + affine conversion K = degC + 273.15", "A", ["FR-PROP-11", "TR-PROP-02"]))
    t_f = (-320.0 + 459.67) * 5.0 / 9.0
    out.append(case("VC-PROP-16/aa6061_t6.k/T=-320degF", f"k at -320 degF (= {t_f:.6f} K)", sig(evaluate(fits["aa6061_t6.k"], t_f)),
                    "W/(m*K)", {"rel": 1e-9}, "S1 + K = (degF + 459.67) * 5/9", "A", ["FR-PROP-11", "TR-PROP-02"]))
    out.append(case("VC-PROP-16/aa6061_t6.k/T=77K/in_W_per_mm_K", "k at 77 K in W/(mm*K)", sig(k77 * 1e-3), "W/(mm*K)", {"rel": 1e-12},
                    "S1; 1 m = 1000 mm", "A", ["FR-PROP-11"]))
    rt, pct = 60.0, [(70.0, 100.0), (300.0, 80.0), (500.0, 50.0)]
    p400 = pct[1][1] + (pct[2][1] - pct[1][1]) * (400.0 - 300.0) / (500.0 - 300.0)
    out.append(case("VC-PROP-17/legacy08PercentOfRT/T=400degF", "08 MAT percentOfRT table evaluated through evaluate_property", sig(rt * p400 / 100.0),
                    "ksi", {"rel": 1e-12}, "08 VC-MAT-16 synthetic table", "A", ["FR-PROP-12", "TR-PROP-07"], sameAs="08 VC-MAT-16 (39 ksi)"))
    return out


def simpson(f, a: float, b: float, n: int) -> float:
    h = (b - a) / n
    return h / 3 * (f(a) + f(b) + sum((4 if i % 2 else 2) * f(a + i * h) for i in range(1, n)))


def integral_cases(fits: dict) -> list[dict]:
    out = []
    for fid in ("ss304.k", "aa6061_t6.k"):
        f = lambda t, fit=fits[fid]: log10_poly(fit["coefficients"], t)
        v, v2 = simpson(f, 4.0, 300.0, 20000), simpson(f, 4.0, 300.0, 40000)
        assert abs(v / v2 - 1) < 1e-11
        out.append(case(f"VC-PROP-20/{fid}/integral4to300K", "thermal conductivity integral from 4 K to 300 K (heat per unit A/L)", sig(v2), "W/m",
                        {"rel": 1e-8}, "S1 fit; composite Simpson, 40000 intervals (converged to < 1e-11)", "A", ["FR-PROP-18", "TR-PROP-13"]))
    return out


def agent_first_cases() -> list[dict]:
    return [
        case("VC-PROP-18/unverified", "evaluate_property on a model with basis 'typical'", True, "bool", {"exact": True}, "AF-32", "A",
             ["FR-PROP-13", "TR-PROP-11"], expect={"data.unverified": True, "data.unverifiedReasons": ["basis typical"]}),
        case("VC-PROP-18/outsideDataRange", "evaluate_property ti6al4v.k at 21 K", True, "bool", {"exact": True}, "AF-31/32", "A",
             ["FR-PROP-04", "FR-PROP-13"], expect={"data.rangeStatus": "in_equation_range_only", "data.unverified": True,
                                                   "warnings[0].code": "PROP_OUTSIDE_DATA_RANGE"}),
        case("VC-PROP-19/errorCodes", "deliberately wrong inputs return stable codes", ["PROP_OUT_OF_RANGE", "PROP_VARIABLE_MISSING",
             "MAT_UNIT_DIMENSION", "PROP_FORM_INVALID", "PROP_TABLE_NOT_MONOTONIC", "PROP_NO_MODEL_FOR_PROPERTY", "PROP_CONSTANT_ONLY",
             "PROP_FIT_INSUFFICIENT_DATA"], "-", {"exact": True}, "TECHNICAL_SPEC §7.1", "A", ["FR-PROP-14", "TR-PROP-12"]),
    ]


def build() -> dict:
    data = json.loads((HERE / "nist_cryogenic_fits.json").read_text(encoding="utf-8"))
    fits = {f["id"]: f for f in data["fits"]}
    cases = (nist_cases(fits) + thermal_cases(fits) + range_cases(fits) + piecewise_and_conflict_cases(fits) + synthetic_cases()
             + fit_cases(fits) + misc_cases(fits) + integral_cases(fits) + agent_first_cases())
    return {"pack": PACK, "generatedBy": GEN, "constants": {"R_J_per_mol_K": R_GAS}, "cases": cases}


def main() -> int:
    text = json.dumps(build(), indent=1, ensure_ascii=False) + "\n"
    if "--check" in sys.argv:
        if not OUT.exists() or OUT.read_text(encoding="utf-8") != text:
            print("expected_results.json is stale - rerun generate_prop_reference.py", file=sys.stderr)
            return 1
        print("expected_results.json up to date")
        return 0
    OUT.write_text(text, encoding="utf-8")
    print(f"wrote {OUT.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
