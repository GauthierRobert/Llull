#!/usr/bin/env python3
"""Reference-result generator for llull PHY-12 SEL (docs/physics/12-material-selection).

Python 3 standard library only. Run from this folder:
    python3 -I generate_selection_reference.py           # writes expected_results.json
    python3 -I generate_selection_reference.py --check   # exit 1 if the committed JSON is stale

What it derives (TEMPLATE rule (b): every value comes from a formula written here):
  1. Ashby performance indices. For each loading case the minimum-mass design is found NUMERICALLY:
     the constraint (stiffness, strength or buckling) is solved for the free section variable by bisection,
     mass = density x volume is evaluated, and the exponent n in  m ~ rho / P**n  is measured from two
     property values. The measured n must equal the closed-form exponent (Ashby, ASM Handbook vol. 20)
     to 1e-9, so the index table is an exact analytic derivation (grade A), not a quotation.
  2. Index values, constraint filtering, weighted ranking and the Pareto set on SYNTHETIC materials
     (round numbers, labelled synthetic) - the algorithm checks of compare_materials.
  3. substitute_material arithmetic: same-geometry mass/stiffness ratios, equal-stiffness and equal-strength
     mass ratios, and the margin re-scaling rule, plus the proof that the rule needs a single-material model
     (indeterminate two-bar system: member forces are independent of E only when both bars share E).
  4. A worked example on sourced typical values (grades from selection_materials.json; B at best).
Numbers are stored with 12 significant digits (docs/physics/README.md §6.3).
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).parent
OUT = HERE / "expected_results.json"
PSI_PER_KSI = 1000.0
MPA_PER_PSI = 0.0068947572931683613  # 4.4482216152605 N / (25.4 mm)^2, exact definitions
G_PER_LB = 453.59237
CM3_PER_IN3 = 2.54 ** 3


def r12(value: float) -> float:
    return float(f"{value:.12g}")


def bisect(fn, lo: float, hi: float) -> float:
    """Root of a monotone fn on [lo, hi] to full double precision."""
    flo = fn(lo)
    for _ in range(400):
        mid = 0.5 * (lo + hi)
        fmid = fn(mid)
        if fmid == 0.0 or hi - lo <= 1e-15 * max(1.0, abs(mid)):
            return mid
        if (fmid > 0) == (flo > 0):
            lo, flo = mid, fmid
        else:
            hi = mid
    return 0.5 * (lo + hi)


# ------------------------------------------------------------------ 1. performance indices
# Fixed design data (any positive values work; the exponent does not depend on them).
L = 1.0          # length (m)
W = 0.2          # panel width (m), fixed for the panel cases
S_STAR = 1.0e5   # required stiffness (N/m)
F_STAR = 1.0e4   # required load (N)
M_STAR = 1.0e3   # required bending moment (N m)
C_CANT = 3.0     # cantilever tip-load stiffness constant: S = 3 E I / L^3
N_EULER = 1.0    # pinned-pinned Euler column: F_cr = pi^2 E I / L^2


def min_mass(case: str, prop: float, rho: float) -> float:
    """Minimum mass meeting the case constraint; the free variable is solved numerically."""
    if case == "tie_stiffness":       # free area A: S = E A / L
        a = bisect(lambda x: prop * x / L - S_STAR, 1e-12, 1.0)
        return rho * a * L
    if case == "tie_strength":        # free area A: F = sigma A
        a = bisect(lambda x: prop * x - F_STAR, 1e-12, 1.0)
        return rho * a * L
    if case == "beam_stiffness":      # square section side b: S = C E (b^4/12) / L^3
        b = bisect(lambda x: C_CANT * prop * x ** 4 / 12.0 / L ** 3 - S_STAR, 1e-6, 1.0)
        return rho * b * b * L
    if case == "beam_strength":       # square section: M = sigma I / (b/2) = sigma b^3 / 6
        b = bisect(lambda x: prop * x ** 3 / 6.0 - M_STAR, 1e-6, 1.0)
        return rho * b * b * L
    if case == "panel_stiffness":     # width W fixed, thickness t free: S = C E W t^3 / (12 L^3)
        t = bisect(lambda x: C_CANT * prop * W * x ** 3 / 12.0 / L ** 3 - S_STAR, 1e-6, 1.0)
        return rho * W * t * L
    if case == "panel_strength":      # M = sigma W t^2 / 6
        t = bisect(lambda x: prop * W * x ** 2 / 6.0 - M_STAR, 1e-6, 1.0)
        return rho * W * t * L
    if case == "column_buckling":     # square section: F_cr = n pi^2 E (b^4/12) / L^2
        b = bisect(lambda x: N_EULER * math.pi ** 2 * prop * x ** 4 / 12.0 / L ** 2 - F_STAR, 1e-6, 1.0)
        return rho * b * b * L
    raise ValueError(case)


INDEX_CASES = [
    # id, property, closed-form exponent, index text
    ("tie_stiffness", "E", 1.0, "E/rho"),
    ("tie_strength", "strength", 1.0, "sigma_f/rho"),
    ("beam_stiffness", "E", 0.5, "E^(1/2)/rho"),
    ("beam_strength", "strength", 2.0 / 3.0, "sigma_f^(2/3)/rho"),
    ("panel_stiffness", "E", 1.0 / 3.0, "E^(1/3)/rho"),
    ("panel_strength", "strength", 0.5, "sigma_f^(1/2)/rho"),
    ("column_buckling", "E", 0.5, "E^(1/2)/rho"),
]


def derive_indices() -> list[dict]:
    out = []
    for case, prop, n_exact, text in INDEX_CASES:
        p1, p2 = (70e9, 210e9) if prop == "E" else (300e6, 900e6)
        m1, m2 = min_mass(case, p1, 2700.0), min_mass(case, p2, 2700.0)
        n_measured = -math.log(m2 / m1) / math.log(p2 / p1)
        rho_ratio = min_mass(case, p1, 5400.0) / m1  # mass must be linear in rho
        assert abs(n_measured - n_exact) < 1e-9, (case, n_measured)
        assert abs(rho_ratio - 2.0) < 1e-12, (case, rho_ratio)
        out.append({"case": case, "property": prop, "exponent": r12(n_exact),
                    "exponentMeasured": r12(n_measured), "index": text})
    return out


def index_value(case: str, mat: dict) -> float:
    """Index in the units of the inputs (E in GPa, strength in MPa, density in g/cm^3 = Mg/m^3)."""
    exp = {c: n for c, _, n, _ in INDEX_CASES}[case]
    prop = mat["eGPa"] if {c: p for c, p, _, _ in INDEX_CASES}[case] == "E" else mat["strengthMPa"]
    return prop ** exp / mat["densityGcm3"]


# ------------------------------------------------------------------ 2. ranking on synthetic data
def pareto(points: dict[str, tuple[float, float]]) -> list[str]:
    """Non-dominated ids when BOTH coordinates are minimised; deterministic id order."""
    front = []
    for i, (a1, a2) in points.items():
        dominated = any((b1 <= a1 and b2 <= a2) and (b1 < a1 or b2 < a2) for j, (b1, b2) in points.items() if j != i)
        if not dominated:
            front.append(i)
    return sorted(front)


def ranking_cases(syn: list[dict]) -> dict:
    by_id = {m["id"]: m for m in syn}
    beam = {m["id"]: index_value("beam_stiffness", m) for m in syn}
    order_beam = sorted(beam, key=lambda k: (-beam[k], k))
    # constraint: strength >= 550 MPa and service temperature >= 110 C
    passing = [k for k in sorted(by_id) if by_id[k]["strengthMPa"] >= 550 and by_id[k]["maxServiceTempC"] >= 110]
    # relative mass per unit stiffness (beam) and relative material cost of that mass
    rel_mass = {k: 1.0 / beam[k] for k in beam}
    rel_cost = {k: rel_mass[k] * by_id[k]["costPerKg"] for k in beam}
    front = pareto({k: (rel_mass[k], rel_cost[k]) for k in beam})
    # weighted score: w_i * (index_i / best index_i), weights 0.7 beam stiffness, 0.3 beam strength
    strength = {m["id"]: index_value("beam_strength", m) for m in syn}
    best_s, best_b = max(strength.values()), max(beam.values())
    score = {k: 0.7 * beam[k] / best_b + 0.3 * strength[k] / best_s for k in beam}
    order_score = sorted(score, key=lambda k: (-score[k], k))
    return {
        "beamStiffnessIndex": {k: r12(v) for k, v in sorted(beam.items())},
        "beamStiffnessOrder": order_beam,
        "constraintPassing": passing,
        "relMassPerStiffness": {k: r12(v) for k, v in sorted(rel_mass.items())},
        "relCostPerStiffness": {k: r12(v) for k, v in sorted(rel_cost.items())},
        "paretoMassCost": front,
        "weightedScore": {k: r12(v) for k, v in sorted(score.items())},
        "weightedOrder": order_score,
    }


# ------------------------------------------------------------------ 3. substitution arithmetic
def equal_stiffness_beam_mass_ratio(rho1, e1, rho2, e2) -> float:
    return (rho2 / rho1) * (e1 / e2) ** 0.5


def equal_stiffness_panel_mass_ratio(rho1, e1, rho2, e2) -> float:
    return (rho2 / rho1) * (e1 / e2) ** (1.0 / 3.0)


def equal_strength_tie_mass_ratio(rho1, s1, rho2, s2) -> float:
    return (rho2 / rho1) * (s1 / s2)


def margin_rescaled(ms1: float, allow1: float, allow2: float) -> float:
    """Applied stress unchanged (single-material, same nu, force loads, zero prescribed displacements)."""
    return (1.0 + ms1) * allow2 / allow1 - 1.0


def two_bar_forces(p: float, e1: float, e2: float, l1: float, l2: float, area: float) -> tuple[float, float]:
    """Two parallel bars joined by a rigid plate, load p, statically indeterminate: forces share by k = E A / L."""
    k1, k2 = e1 * area / l1, e2 * area / l2
    return p * k1 / (k1 + k2), p * k2 / (k1 + k2)


def substitution_cases() -> dict:
    a = two_bar_forces(1000.0, 70e9, 70e9, 1.0, 2.0, 1e-4)
    b = two_bar_forces(1000.0, 210e9, 210e9, 1.0, 2.0, 1e-4)
    c = two_bar_forces(1000.0, 210e9, 70e9, 1.0, 2.0, 1e-4)  # only bar 1 substituted
    return {
        "syn_a_to_syn_b": {
            "sameGeometryMassRatio": r12(4.0 / 2.0),
            "sameGeometryStiffnessRatio": r12(110.0 / 70.0),
            "sameGeometryDeflectionRatio": r12(70.0 / 110.0),
            "equalStiffnessBeamMassRatio": r12(equal_stiffness_beam_mass_ratio(2.0, 70.0, 4.0, 110.0)),
            "equalStiffnessPanelMassRatio": r12(equal_stiffness_panel_mass_ratio(2.0, 70.0, 4.0, 110.0)),
            "equalStrengthTieMassRatio": r12(equal_strength_tie_mass_ratio(2.0, 500.0, 4.0, 900.0)),
            "marginFrom0p25": r12(margin_rescaled(0.25, 500.0, 900.0)),
            "modalFrequencyRatio": r12(((110.0 / 4.0) / (70.0 / 2.0)) ** 0.5),
            "bucklingFactorRatio": r12(110.0 / 70.0),
        },
        "twoBar": {
            "bothAluminiumN": [r12(a[0]), r12(a[1])],
            "bothSteelN": [r12(b[0]), r12(b[1])],
            "mixedN": [r12(c[0]), r12(c[1])],
        },
    }


# ------------------------------------------------------------------ 4. worked example (typical / secondary data)
def to_si(q: dict) -> float | None:
    """Density -> g/cm^3, stress -> MPa, dimensionless unchanged; None when the value is not sourced."""
    v, u = q.get("value"), q.get("unit")
    if v is None:
        return None
    factor = {"g/cm^3": 1.0, "lb/in^3": G_PER_LB / CM3_PER_IN3, "MPa": 1.0, "ksi": PSI_PER_KSI * MPA_PER_PSI, "-": 1.0}
    return v * factor[u]


def worked_example(data: dict) -> dict:
    part = data["workedPart"]
    volume_cm3 = part["sizeMm"][0] * part["sizeMm"][1] * part["sizeMm"][2] / 1000.0
    applied = part["appliedVonMisesMPa"]
    rows = {}
    for mat in data["workedExample"]:
        rho = to_si(mat["density"])
        e = mat["E"]["value"]
        e_gpa = None if e is None else (e / 1000.0 if mat["E"]["unit"] == "MPa" else e)
        fty = to_si(mat["Fty"])
        grades = [mat[k].get("status") for k in ("density", "E", "Fty")]
        row: dict = {"inputStatus": grades}
        row["densityGcm3"] = None if rho is None else r12(rho)
        row["eGPa"] = None if e_gpa is None else r12(e_gpa)
        row["ftyMPa"] = None if fty is None else r12(fty)
        if rho is None:
            row["code"] = "SEL_PROPERTY_MISSING"
            row["missing"] = ["density"]
        else:
            row["massG"] = r12(volume_cm3 * rho)
            row["beamStiffnessIndex"] = None if e_gpa is None else r12(e_gpa ** 0.5 / rho)
            row["panelStiffnessIndex"] = None if e_gpa is None else r12(e_gpa ** (1.0 / 3.0) / rho)
            row["tieStrengthIndex"] = None if fty is None else r12(fty / rho)
            row["msYield"] = None if fty is None else r12(fty / (applied * part["yieldFactor"]["value"]) - 1.0)
        row["unverified"] = True
        rows[mat["id"]] = row
    al = rows["aa7075_t6"]
    for k in ("ti6al4v_annealed", "aisi4130_normalized"):
        o = rows[k]
        o["vs7075EqualStiffnessBeamMassRatio"] = r12(equal_stiffness_beam_mass_ratio(al["densityGcm3"], al["eGPa"], o["densityGcm3"], o["eGPa"]))
        o["vs7075SameGeometryMassRatio"] = r12(o["densityGcm3"] / al["densityGcm3"])
    return {"volumeCm3": r12(volume_cm3), "appliedMPa": applied, "rows": rows}


# ------------------------------------------------------------------ assemble
def case(cid, quantity, value, unit, tol, source, grade, proves, **extra) -> dict:
    out = {"id": cid, "quantity": quantity, "value": value, "unit": unit, "tolerance": tol,
           "source": source, "grade": grade, "proves": proves}
    out.update(extra)
    return out


def build() -> dict:
    data = json.loads((HERE / "selection_materials.json").read_text(encoding="utf-8"))
    syn = data["synthetic"]
    idx = derive_indices()
    rank = ranking_cases(syn)
    sub = substitution_cases()
    work = worked_example(data)
    exact = {"rel": 1e-9}
    cases = []
    for k, row in enumerate(idx, start=1):
        cases.append(case(f"VC-SEL-01.{k}", f"mass exponent n in m ~ rho/P^n, {row['case']} ({row['index']})",
                          row["exponent"], "-", {"abs": 1e-9}, "derived (numerical min-mass, closed form per Ashby R1/R2)", "A",
                          ["FR-SEL-01", "TR-SEL-03"], measured=row["exponentMeasured"]))
    for mid, v in rank["beamStiffnessIndex"].items():
        cases.append(case(f"VC-SEL-02.{mid}", f"beam stiffness index E^(1/2)/rho of synthetic {mid}", v,
                          "GPa^(1/2)/(Mg/m^3)", exact, "derived (synthetic inputs)", "A", ["FR-SEL-01", "FR-SEL-02"]))
    cases.append(case("VC-SEL-03", "compare_materials order by beam stiffness index (synthetic)", rank["beamStiffnessOrder"],
                      "ids", {"exact": True}, "derived", "A", ["FR-SEL-03", "TR-SEL-05"]))
    cases.append(case("VC-SEL-04", "ids passing strength >= 550 MPa and maxServiceTemp >= 110 C (synthetic)", rank["constraintPassing"],
                      "ids", {"exact": True}, "derived", "A", ["FR-SEL-04"]))
    cases.append(case("VC-SEL-05", "Pareto set, minimise (relative beam mass, relative beam cost) (synthetic)", rank["paretoMassCost"],
                      "ids", {"exact": True}, "derived", "A", ["FR-SEL-05", "FR-SEL-14"],
                      relMass=rank["relMassPerStiffness"], relCost=rank["relCostPerStiffness"]))
    cases.append(case("VC-SEL-06", "weighted order 0.7 beam stiffness + 0.3 beam strength (synthetic)", rank["weightedOrder"],
                      "ids", {"exact": True}, "derived", "A", ["FR-SEL-05"], scores=rank["weightedScore"]))
    s = sub["syn_a_to_syn_b"]
    for key, unit in (("sameGeometryMassRatio", "-"), ("sameGeometryStiffnessRatio", "-"), ("sameGeometryDeflectionRatio", "-"),
                      ("equalStiffnessBeamMassRatio", "-"), ("equalStiffnessPanelMassRatio", "-"), ("equalStrengthTieMassRatio", "-"),
                      ("modalFrequencyRatio", "-"), ("bucklingFactorRatio", "-")):
        cases.append(case(f"VC-SEL-07.{key}", f"syn_a -> syn_b {key}", s[key], unit, exact, "derived", "A", ["FR-SEL-07", "TR-SEL-08"]))
    cases.append(case("VC-SEL-08", "re-scaled yield margin syn_a (MS 0.25) -> syn_b, applied stress unchanged", s["marginFrom0p25"], "-",
                      exact, "derived", "A", ["FR-SEL-08", "TR-SEL-09"]))
    tb = sub["twoBar"]
    cases.append(case("VC-SEL-09", "two-bar indeterminate forces (N): single material Al vs steel equal; mixed differs",
                      {"bothAluminium": tb["bothAluminiumN"], "bothSteel": tb["bothSteelN"], "mixed": tb["mixedN"]}, "N", exact,
                      "derived (k = E A / L load sharing)", "A", ["FR-SEL-09", "TR-SEL-09"]))
    rows = work["rows"]
    cases.append(case("VC-SEL-10", "7075-T6 block mass from the substitution what-if (typical density 2.81)", rows["aa7075_t6"]["massG"], "g",
                      {"rel": 1e-9}, "08 MAT S12 (typical) x analytic volume", "B", ["FR-SEL-07", "FR-SEL-11"],
                      note="typical density: result unverified (AF-32); 140.5 g in 08 VC-MAT-04 uses the same value"))
    cases.append(case("VC-SEL-11", "Ti-6Al-4V block mass (supplier density 0.160 lb/in^3)", rows["ti6al4v_annealed"]["massG"], "g",
                      {"rel": 1e-9}, "08 MAT S15 + exact lb/in^3 conversion", "B", ["FR-SEL-07", "FR-SEL-11"]))
    cases.append(case("VC-SEL-12", "Ti-6Al-4V vs 7075-T6 equal-stiffness beam mass ratio",
                      rows["ti6al4v_annealed"]["vs7075EqualStiffnessBeamMassRatio"], "-", {"rel": 1e-9},
                      "08 S12/S15 + S3 (E Ti secondary)", "B", ["FR-SEL-07"]))
    cases.append(case("VC-SEL-13", "4130 vs 7075-T6 equal-stiffness beam mass ratio",
                      rows["aisi4130_normalized"]["vs7075EqualStiffnessBeamMassRatio"], "-", {"rel": 1e-9},
                      "08 S12 + S4 (secondary)", "B", ["FR-SEL-07"]))
    cases.append(case("VC-SEL-14", "CFRP quasi-iso row refused: density not sourced", "SEL_PROPERTY_MISSING", "code", {"exact": True},
                      "selection_materials.json (density tbd)", "A", ["FR-SEL-10", "TR-SEL-20"]))
    cases.append(case("VC-SEL-15", "yield margins at 300 MPa applied (typical / secondary data)",
                      {k: rows[k].get("msYield") for k in sorted(rows)}, "-", {"rel": 1e-9}, "derived from graded inputs", "B",
                      ["FR-SEL-08", "FR-SEL-11"]))
    work_bases = {m["id"]: sorted({m[k].get("basis", "none") for k in ("density", "E", "Fty") if m[k].get("value") is not None})
                  for m in data["workedExample"]}
    cases.append(case("VC-SEL-16", "check_material_selection warning when a comparison mixes bases (worked example bases)",
                      "SEL_BASIS_MIXED", "code", {"exact": True}, "selection_materials.json basis fields", "A",
                      ["FR-SEL-12", "FR-SEL-17", "FR-SEL-19"], bases=work_bases))
    cases.append(case("VC-SEL-17", "CFRP compared through layup effective Ex: warning code and E used (GPa)", "SEL_ANISOTROPIC", "code",
                      {"exact": True}, "06 CMP clt_reference.json", "A", ["FR-SEL-15"], eUsedGPa=rows["cfrp_t300_5208_quasi_iso"]["eGPa"]))
    slopes = {c: r12(1.0 / n) for c, p, n, _ in INDEX_CASES if p == "E"}
    cases.append(case("VC-SEL-18", "material_chart_data guide-line slope on log(E) vs log(rho) axes (= 1/n)", slopes, "-",
                      {"abs": 1e-12}, "derived: P^n/rho = C  =>  log P = (1/n) log rho + const", "A", ["FR-SEL-18"]))
    cases.append(case("VC-SEL-19", "user-defined index without derivationNote is refused", "SEL_DERIVATION_NOTE_MISSING", "code",
                      {"exact": True}, "TECHNICAL_SPEC TR-SEL-15", "A", ["FR-SEL-06"]))
    cases.append(case("VC-SEL-20", "temperature outside a PHY-01 model range: material excluded with the PHY-01 code forwarded unchanged",
                      {"excludedCode": "PROP_OUT_OF_RANGE", "imputed": False}, "code", {"exact": True}, "TECHNICAL_SPEC TR-SEL-11", "A",
                      ["FR-SEL-13"]))
    cases.append(case("VC-SEL-21", "material differs from the released revision without an open ECO (check)", "SEL_SUBSTITUTION_RELEASED",
                      "code", {"exact": True}, "TECHNICAL_SPEC §7.1; 09 PLM release lock", "A", ["FR-SEL-16", "FR-SEL-17"]))
    cases.append(case("VC-SEL-22", "named defaults in compare/substitute results",
                      {"weights": {"value": [0.5, 0.5], "defaulted": True}, "nuTolerance": {"value": 0, "defaulted": True},
                       "yieldFactor": data["workedPart"]["yieldFactor"]}, "-", {"exact": True}, "AF-31; 05 FEA §5.8", "A", ["FR-SEL-20"]))
    return {
        "pack": "12-material-selection",
        "generatedBy": "generate_selection_reference.py",
        "indexDerivation": idx,
        "synthetic": rank,
        "substitution": sub,
        "workedExample": work,
        "cases": cases,
    }


def main() -> int:
    text = json.dumps(build(), indent=1, ensure_ascii=False, sort_keys=False) + "\n"
    if "--check" in sys.argv:
        if not OUT.exists() or OUT.read_text(encoding="utf-8") != text:
            print("expected_results.json is stale; re-run without --check", file=sys.stderr)
            return 1
        return 0
    OUT.write_text(text, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
