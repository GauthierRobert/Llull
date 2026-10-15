#!/usr/bin/env python3
"""
Generate the analytic reference datasets of gap 05 (FEA / CAE hand-off).

Run:  python3 -I generate_fea_analytic.py        (writes next to this script, stdlib only, deterministic)

Outputs
  fea_analytic_expected.json     closed-form expected values (value, tolerance, unit, derivation, source ids)
  cantilever_modes.csv           Euler-Bernoulli clamped-free roots beta_n*L and frequency ratios
  kirsch_hole_profile.csv        Kirsch stress along the transverse axis of a hole in an infinite plate
  plate_buckling_k.csv           simply supported plate, uniaxial compression: k(a/b) curve
  mesh_quality_reference.json    Verdict-definition quality metrics of hand-computable reference elements

Every formula cites the source id used in ../FUNCTIONAL_SPEC.md / sources.md ([Sx]). Tolerances are llull
acceptance choices (documented in validation/README.md), not claims of any source.
"""

from __future__ import annotations

import csv
import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))


def out(name: str) -> str:
    return os.path.join(HERE, name)


def r(x: float, n: int = 6) -> float:
    """Round to n significant digits (stable JSON)."""
    if x == 0 or not math.isfinite(x):
        return x
    return float(f"{x:.{n}g}")


# ---------------------------------------------------------------------------------------------------------
# 1. Clamped-free Euler-Bernoulli beam: roots of cos(x) cosh(x) + 1 = 0  [S20] (characteristic equation)
# ---------------------------------------------------------------------------------------------------------
def cantilever_root(n: int) -> float:
    f = lambda x: math.cos(x) * math.cosh(x) + 1.0  # noqa: E731
    lo, hi = (n - 0.5) * math.pi - 0.6, (n - 0.5) * math.pi + 0.6
    if n == 1:
        lo, hi = 1.0, 2.5
    flo = f(lo)
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        fm = f(mid)
        if (fm > 0) == (flo > 0):
            lo, flo = mid, fm
        else:
            hi = mid
    return 0.5 * (lo + hi)


BETA = [cantilever_root(n) for n in range(1, 7)]


def cantilever_frequency(n: int, E: float, I: float, rho: float, A: float, L: float) -> float:
    """f_n = (beta_n L)^2 / (2 pi L^2) * sqrt(E I / (rho A))  [S20]; consistent units -> Hz."""
    return BETA[n - 1] ** 2 / (2 * math.pi * L**2) * math.sqrt(E * I / (rho * A))


# ---------------------------------------------------------------------------------------------------------
# 2. Kirsch (1898) infinite plate, circular hole radius a, remote uniaxial stress S along x  [S21]
#    sigma_xx on the y axis (theta = 90 deg):  S * (1 + a^2/(2 y^2) + 3 a^4/(2 y^4))   -> 3 S at y = a
#    hoop stress on the hole edge: sigma_tt = S (1 - 2 cos 2 theta), theta from the load axis
# ---------------------------------------------------------------------------------------------------------
def kirsch_sxx_on_transverse_axis(y_over_a: float) -> float:
    q = 1.0 / y_over_a
    return 1.0 + 0.5 * q**2 + 1.5 * q**4


def kirsch_hoop_on_edge(theta: float) -> float:
    return 1.0 - 2.0 * math.cos(2.0 * theta)


# ---------------------------------------------------------------------------------------------------------
# 3. Simply supported rectangular plate, uniaxial compression on the edges of width b  [S22] (classical)
#    sigma_cr = k pi^2 E / (12 (1 - nu^2)) (t / b)^2,  k = min_m (m b / a + a / (m b))^2, min k = 4
# ---------------------------------------------------------------------------------------------------------
def plate_k(aspect: float) -> tuple[float, int]:
    best = (math.inf, 0)
    for m in range(1, 60):
        k = (m / aspect + aspect / m) ** 2
        if k < best[0]:
            best = (k, m)
    return best


def plate_sigma_cr(k: float, E: float, nu: float, t: float, b: float) -> float:
    return k * math.pi**2 * E / (12 * (1 - nu**2)) * (t / b) ** 2


# ---------------------------------------------------------------------------------------------------------
# 4. Margin of safety  MS = allowable / (limit * FoS) - 1   [S2] NASA-STD-5001B ; FoS = 1.5  [S1] 14 CFR 25.303
# ---------------------------------------------------------------------------------------------------------
def margin(allowable: float, limit: float, fos: float) -> float:
    return allowable / (limit * fos) - 1.0


# ---------------------------------------------------------------------------------------------------------
# 5. von Mises equivalent stress (distortion energy)
# ---------------------------------------------------------------------------------------------------------
def von_mises(sxx, syy, szz, sxy, syz, szx) -> float:
    return math.sqrt(0.5 * ((sxx - syy) ** 2 + (syy - szz) ** 2 + (szz - sxx) ** 2) + 3 * (sxy**2 + syz**2 + szx**2))


# ---------------------------------------------------------------------------------------------------------
# 6. Verdict metrics (definitions from the Verdict manual [S12]) on reference elements
# ---------------------------------------------------------------------------------------------------------
def sub(a, b):
    return [a[i] - b[i] for i in range(3)]


def cross(a, b):
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]


def dot(a, b):
    return sum(a[i] * b[i] for i in range(3))


def norm(a):
    return math.sqrt(dot(a, a))


def tet_metrics(p):
    """Verdict: aspect ratio = Lmax / (2 sqrt(6) r_in); scaled Jacobian = J sqrt(2) / lambda_max."""
    p0, p1, p2, p3 = p
    L0, L1, L2 = sub(p1, p0), sub(p2, p1), sub(p0, p2)
    L3, L4, L5 = sub(p3, p0), sub(p3, p1), sub(p3, p2)
    J = dot(cross(L2, L0), L3)
    lam = [
        norm(L0) * norm(L2) * norm(L3),
        norm(L0) * norm(L1) * norm(L4),
        norm(L1) * norm(L2) * norm(L5),
        norm(L3) * norm(L4) * norm(L5),
        J,
    ]
    sj = J * math.sqrt(2) / max(lam)
    vol = abs(J) / 6.0
    faces = [(p0, p1, p2), (p0, p1, p3), (p1, p2, p3), (p0, p2, p3)]
    area = sum(0.5 * norm(cross(sub(b, a), sub(c, a))) for a, b, c in faces)
    rin = 3 * vol / area
    lmax = max(norm(v) for v in (L0, L1, L2, L3, L4, L5))
    ar = lmax / (2 * math.sqrt(6) * rin)
    return {"scaled_jacobian": r(sj), "aspect_ratio": r(ar), "volume": r(vol)}


def quad_aspect_ratio(p):
    """Verdict quad aspect ratio = Lmax (L0+L1+L2+L3) / (4 A) (planar quad)."""
    Ls = [norm(sub(p[(i + 1) % 4], p[i])) for i in range(4)]
    A = 0.5 * norm(cross(sub(p[2], p[0]), sub(p[3], p[1])))
    return r(max(Ls) * sum(Ls) / (4 * A))


def main() -> None:
    cases = []

    # --- VC-FEA-10: cantilever tip deflection, CalculiX beamp.inp geometry (1 x 1 x 8, E 210000, P 9 N) ------
    E, nu, b, h, L, P = 210000.0, 0.3, 1.0, 1.0, 8.0, 9.0
    I = b * h**3 / 12
    G = E / (2 * (1 + nu))
    d_eb = P * L**3 / (3 * E * I)
    d_sh = P * L / ((5.0 / 6.0) * G * b * h)  # Timoshenko shear term, rectangular k = 5/6
    cases.append({
        "id": "VC-FEA-10.a", "quantity": "cantilever tip deflection (Euler-Bernoulli)", "value": r(d_eb), "unit": "mm",
        "tolerance_rel": 0.02,
        "inputs": {"E_MPa": E, "nu": nu, "b_mm": b, "h_mm": h, "L_mm": L, "P_N": P},
        "derivation": "delta = P L^3 / (3 E I), I = b h^3 / 12", "sources": ["S20", "S30"],
        "cross_check": {"calculix_beamp_frd_mean_tip_uy_mm": 0.0876111, "note": "mean U2 over the 21 nodes at z = 8 of test/beamp.frd.ref"},
    })
    cases.append({
        "id": "VC-FEA-10.b", "quantity": "cantilever tip deflection incl. Timoshenko shear term", "value": r(d_eb + d_sh), "unit": "mm",
        "tolerance_rel": 0.02, "derivation": "delta = P L^3/(3 E I) + P L / (k G A), k = 5/6, G = E / (2 (1 + nu))",
        "sources": ["S20"],
    })
    M_root = P * L
    cases.append({
        "id": "VC-FEA-10.c", "quantity": "cantilever root bending stress (outer fibre)", "value": r(M_root * (h / 2) / I), "unit": "MPa",
        "tolerance_rel": 0.05, "derivation": "sigma = M c / I, M = P L, c = h / 2 (FE value extrapolated to the root surface; St-Venant zone excluded)",
        "sources": ["S20"],
    })
    cases.append({
        "id": "VC-FEA-10.d", "quantity": "section moment at z = 6 (beamp SECTION PRINT S1)", "value": r(P * (L - 6.0)), "unit": "N.mm",
        "tolerance_rel": 0.001, "derivation": "M(z) = P (L - z)", "sources": ["S20", "S30"],
        "cross_check": {"calculix_beamp_dat_bending_moment": 17.99943, "calculix_beamp_dat_shear": 8.99964},
    })

    # --- VC-FEA-11: cantilever natural frequencies, CalculiX beamf.inp (1 x 1.5 x 8 mm, steel N-mm-t) --------
    E, rho, bx, by, L = 210000.0, 7.8e-9, 1.0, 1.5, 8.0
    A = bx * by
    I_weak = by * bx**3 / 12  # bending in x (thickness 1.0)
    I_strong = bx * by**3 / 12
    f_w = [cantilever_frequency(n, E, I_weak, rho, A, L) for n in (1, 2)]
    f_s = [cantilever_frequency(n, E, I_strong, rho, A, L) for n in (1,)]
    ccx = {"mode1_Hz": 13096.03, "mode2_Hz": 19319.52, "mode3_Hz": 76839.71}
    cases.append({
        "id": "VC-FEA-11.a", "quantity": "1st bending frequency, weak axis", "value": r(f_w[0]), "unit": "Hz", "tolerance_rel": 0.01,
        "inputs": {"E_MPa": E, "rho_t_per_mm3": rho, "section_mm": [bx, by], "L_mm": L},
        "derivation": "f1 = (beta1 L)^2/(2 pi L^2) sqrt(E I/(rho A)), beta1 L = %.10f" % BETA[0], "sources": ["S20", "S30"],
        "cross_check": {"calculix_beamf_mode1_Hz": ccx["mode1_Hz"]},
    })
    cases.append({
        "id": "VC-FEA-11.b", "quantity": "1st bending frequency, strong axis", "value": r(f_s[0]), "unit": "Hz", "tolerance_rel": 0.03,
        "derivation": "as 11.a with I = b h^3/12, h = 1.5; Euler-Bernoulli over-predicts (no shear / rotary inertia), L/h = 5.3",
        "sources": ["S20", "S30"], "cross_check": {"calculix_beamf_mode2_Hz": ccx["mode2_Hz"]},
    })
    cases.append({
        "id": "VC-FEA-11.c", "quantity": "2nd bending frequency, weak axis", "value": r(f_w[1]), "unit": "Hz", "tolerance_rel": 0.08,
        "derivation": "beta2 L = %.10f; Timoshenko effects grow with mode number - use only as an upper bound" % BETA[1],
        "sources": ["S20", "S30"], "cross_check": {"calculix_beamf_mode3_Hz": ccx["mode3_Hz"],
            "mode_identification": "TBD - confirm from the beamf.frd.ref mode shape that CalculiX mode 3 is the 2nd weak-axis bending mode (torsion estimate ~85 kHz is close); not a gate until confirmed"},
    })

    # --- VC-FEA-12: Euler buckling of a cantilever (fixed-free), slender case for llull-native test ----------
    E, b, h, L = 70000.0, 20.0, 10.0, 500.0
    I = b * h**3 / 12
    cases.append({
        "id": "VC-FEA-12", "quantity": "Euler critical load, fixed-free column", "value": r(math.pi**2 * E * I / (4 * L**2)), "unit": "N",
        "tolerance_rel": 0.02, "inputs": {"E_MPa": E, "b_mm": b, "h_mm": h, "L_mm": L, "note": "E is a test input, not a material claim"},
        "derivation": "P_cr = pi^2 E I / (2 L)^2 (effective length 2L), I_min = b h^3/12", "sources": ["S20"],
    })

    # --- VC-FEA-13: SS plate buckling (aluminium-like inputs) ------------------------------------------------
    E, nu, t, a, b = 70000.0, 0.33, 2.0, 600.0, 200.0
    k, m = plate_k(a / b)
    cases.append({
        "id": "VC-FEA-13", "quantity": "SS plate uniaxial compressive buckling stress", "value": r(plate_sigma_cr(k, E, nu, t, b)), "unit": "MPa",
        "tolerance_rel": 0.03, "inputs": {"E_MPa": E, "nu": nu, "t_mm": t, "a_mm": a, "b_mm": b, "k": r(k), "half_waves_m": m},
        "derivation": "sigma_cr = k pi^2 E/(12(1-nu^2)) (t/b)^2, k = min_m (m b/a + a/(m b))^2 = 4 at a/b = 3", "sources": ["S22"],
    })

    # --- VC-FEA-14: Kirsch Kt = 3 ----------------------------------------------------------------------------
    cases.append({
        "id": "VC-FEA-14", "quantity": "Kt (gross) circular hole, infinite plate, uniaxial", "value": 3.0, "unit": "1",
        "tolerance_rel": 0.05,
        "derivation": "sigma_tt(a, 90 deg) = S (1 - 2 cos 180 deg) = 3 S; FE model W/d >= 10 so finite-width effect stays inside tolerance (llull choice)",
        "sources": ["S21"],
    })

    # --- VC-FEA-20: margins of safety --------------------------------------------------------------------------
    ms_rows = []
    for allow, limit in [(450.0, 300.0), (450.0, 200.0), (300.0, 200.0), (280.0, 200.0)]:
        ms_rows.append({"allowable_MPa": allow, "limit_MPa": limit, "FoS": 1.5, "MS": r(margin(allow, limit, 1.5), 12)})
    cases.append({
        "id": "VC-FEA-20", "quantity": "margin of safety table", "value": ms_rows, "unit": "1", "tolerance_abs": 1e-9,
        "derivation": "MS = allowable / (limit x FoS) - 1, FoS = 1.5 (14 CFR 25.303); MS < 0 => FAIL", "sources": ["S1", "S2"],
    })

    # --- VC-FEA-21: von Mises -----------------------------------------------------------------------------------
    vm = [
        {"tensor": [100, 0, 0, 0, 0, 0], "vm": r(von_mises(100, 0, 0, 0, 0, 0), 12), "note": "uniaxial -> sigma"},
        {"tensor": [0, 0, 0, 50, 0, 0], "vm": r(von_mises(0, 0, 0, 50, 0, 0), 12), "note": "pure shear -> sqrt(3) tau"},
        {"tensor": [80, 80, 80, 0, 0, 0], "vm": r(von_mises(80, 80, 80, 0, 0, 0), 12), "note": "hydrostatic -> 0"},
        {"tensor": [120, -40, 10, 30, -20, 15], "vm": r(von_mises(120, -40, 10, 30, -20, 15), 12), "note": "general"},
    ]
    cases.append({
        "id": "VC-FEA-21", "quantity": "von Mises from Cauchy tensor (sxx, syy, szz, sxy, syz, szx)", "value": vm, "unit": "MPa",
        "tolerance_rel": 1e-9, "derivation": "sqrt(((sxx-syy)^2+(syy-szz)^2+(szz-sxx)^2)/2 + 3(sxy^2+syz^2+szx^2))", "sources": ["S20"],
    })

    # --- VC-FEA-22: units (llull mm document, g/mm3 density -> CalculiX/Nastran N-mm-t) -------------------------
    cases.append({
        "id": "VC-FEA-22", "quantity": "density conversion steel g/mm3 -> t/mm3 (N, mm, s)", "value": r(0.0078 * 1e-6), "unit": "t/mm3",
        "tolerance_rel": 1e-12, "derivation": "1 g = 1e-6 t; CalculiX manual quotes 7.8e-9 N s^2/mm^4 for steel", "sources": ["S30"],
    })

    # --- VC-FEA-60..65: agent-first result contract (AGENT_FIRST.md AF-11, AF-31..35) ----------------------------
    # Same four rows as VC-FEA-20; adds the fields an agent asserts on. Statuses follow TECHNICAL_SPEC 5.8.
    factors = {
        "ultimate": {"value": 1.5, "source": "14 CFR 25.303", "defaulted": True},
        "yield": {"value": 1.0, "source": "derived from 14 CFR 25.305(a) (limit load, no detrimental permanent deformation)", "defaulted": True},
        "extra": [],
    }
    af_rows = []
    for i, row in enumerate(ms_rows, 1):
        ms = row["MS"]
        status = "FAIL" if ms < 0 else "PASS"
        af_rows.append({
            "rowId": f"r{i}", "appliedMPa": row["limit_MPa"], "allowableMPa": row["allowable_MPa"], "ms": ms, "status": status,
            "code": "FEA_MS_NEGATIVE" if status == "FAIL" else None,
            "reviewRequired": True, "reviewReason": "margin of safety supports a structural substantiation decision",
            "disposition": "pending_human" if status == "FAIL" else "none",
        })
    cases.append({
        "id": "VC-FEA-60", "quantity": "named safety factors when none are given (AF-31)", "value": {"factors": factors}, "unit": "1",
        "assert": "data.factors deep-equals value; no factor without source", "derivation": "TECHNICAL_SPEC 5.8 / FR-FEA-31", "sources": ["S1", "S1a"],
    })
    cases.append({
        "id": "VC-FEA-61", "quantity": "every margin row flagged for review (AF-33)", "value": af_rows, "unit": "1",
        "assert": "for every row: reviewRequired == true and reviewReason non-empty; data.reviewRequired == true; summary contains 'not approved'",
        "derivation": "rows of VC-FEA-20 with FR-FEA-32/33 fields; marginalBand unset -> no MARGINAL rows and warning FEA_MARGINAL_BAND_UNSET",
        "sources": ["S1", "S2"],
    })
    cases.append({
        "id": "VC-FEA-62", "quantity": "check_analysis after VC-FEA-61 (AF-20)",
        "value": {"status": "fail", "codes": ["FEA_DISPOSITION_PENDING", "FEA_MARGINAL_BAND_UNSET", "FEA_MS_NEGATIVE"]}, "unit": "1",
        "assert": "data.status == value.status and sorted(set(item.code)) == value.codes", "derivation": "FR-FEA-33/35", "sources": [],
    })
    cases.append({
        "id": "VC-FEA-63", "quantity": "agent attempts dispose_margin on r4 (AF-34)",
        "value": {"exitCode": 1, "code": "FEA_HUMAN_GATE", "documentChanged": False, "rowDisposition": "pending_human"}, "unit": "1",
        "assert": "CLI exit code, data.code, document hash unchanged, compute_margins row r4 disposition", "derivation": "FR-FEA-33, TR-FEA-91", "sources": [],
    })
    cases.append({
        "id": "VC-FEA-64", "quantity": "unverified gap 08 input propagates (AF-32)",
        "value": {"input": {"property": "E", "basis": "typical", "unverified": True},
                  "expect": {"rows[*].unverified": True, "rows[*].unverifiedReasons contains": "E basis typical",
                             "meshSummary.unverified": False, "resultsSummary.unverified": True,
                             "check_analysis.items contains": {"code": "FEA_MATERIAL_UNVERIFIED", "severity": "warning"}}},
        "unit": "1", "assert": "as listed", "derivation": "FR-FEA-34 (the mesh does not depend on material, results and margins do)", "sources": [],
    })
    cases.append({
        "id": "VC-FEA-65", "quantity": "stable error codes for deliberately wrong set-ups (AF-11)",
        "value": [
            {"setup": "add_fea_constraint facesNear on a point 5 mm off the part", "code": "FEA_TARGET_UNRESOLVED"},
            {"setup": "facesNear exactly on the edge shared by two faces", "code": "FEA_TARGET_AMBIGUOUS"},
            {"setup": "material record without E", "command": "fea_export", "code": "FEA_MATERIAL_NO_ELASTIC"},
            {"setup": "set_material_property property=nu value=0.5", "code": "FEA_PROPERTY_INVALID"},
            {"setup": "mesh artifact with one inverted tet", "command": "fea_export", "code": "FEA_MESH_INVERTED"},
            {"setup": "set_parameter after solve", "command": "compute_margins", "code": "FEA_RESULTS_STALE"},
            {"setup": "record_fe_mesh with a hash absent from the store", "code": "FEA_ARTIFACT_NOT_FOUND"},
            {"setup": "LLULL_CCX pointing to a missing file", "command": "fea_solve", "code": "FEA_TOOL_MISSING"},
            {"setup": "set_analysis_factors ultimate=0.9", "code": "FEA_FACTOR_INVALID"},
        ],
        "unit": "1", "assert": "exit code 1; data.code == code; data.remediation non-empty; data.ids or data.path set",
        "derivation": "TECHNICAL_SPEC 7.1", "sources": [],
    })

    doc = {
        "generator": "generate_fea_analytic.py", "gap": "05-fea-cae-handoff",
        "beta_n_L_clamped_free": [r(x, 11) for x in BETA],
        "cases": cases,
    }
    with open(out("fea_analytic_expected.json"), "w") as f:
        json.dump(doc, f, indent=1)
        f.write("\n")

    with open(out("cantilever_modes.csv"), "w", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["mode", "beta_n_L", "(beta_n_L)^2", "f_n/f_1"])
        for i, x in enumerate(BETA, 1):
            w.writerow([i, f"{x:.10f}", f"{x * x:.8f}", f"{(x / BETA[0]) ** 2:.6f}"])

    with open(out("kirsch_hole_profile.csv"), "w", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["y_over_a", "sigma_xx_over_S (theta=90deg)", "theta_deg", "sigma_tt_edge_over_S"])
        ys = [1.0, 1.05, 1.1, 1.2, 1.3, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0, 7.5, 10.0]
        thetas = [0, 15, 30, 45, 60, 75, 90, 105, 120, 135, 150, 165, 180, 180]
        for y, th in zip(ys, thetas):
            w.writerow([y, f"{kirsch_sxx_on_transverse_axis(y):.6f}", th, f"{round(kirsch_hoop_on_edge(math.radians(th)), 9) + 0.0:.6f}"])

    with open(out("plate_buckling_k.csv"), "w", newline="") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(["a_over_b", "k_min", "half_waves_m"])
        for i in range(2, 51):
            ab = i / 10
            k, m = plate_k(ab)
            w.writerow([f"{ab:.1f}", f"{k:.6f}", m])

    s3 = math.sqrt(3)
    regular = [[0, 0, 0], [1, 0, 0], [0.5, s3 / 2, 0], [0.5, s3 / 6, math.sqrt(2.0 / 3.0)]]
    corner = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]]
    flat = [[0, 0, 0], [1, 0, 0], [0.5, s3 / 2, 0], [0.5, s3 / 6, 0.05]]
    inverted = [regular[0], regular[2], regular[1], regular[3]]
    mq = {
        "definitions": "Verdict manual (Stimpson et al., SAND2007-2853) [S12]; acceptable ranges quoted from the same manual",
        "acceptable_ranges": {
            "tet_aspect_ratio": [1, 3], "tet_scaled_jacobian": [0.5, 1], "quad_aspect_ratio": [1, 1.3],
            "quad_scaled_jacobian": [0.3, 1], "quad_skew": [0, 0.5], "quad_warpage": [0.3, 1], "tri_minimum_angle_deg": [30, 60],
        },
        "elements": {
            "tet_regular_unit": tet_metrics(regular),
            "tet_trirectangular_corner": tet_metrics(corner),
            "tet_sliver_h0.05": tet_metrics(flat),
            "tet_inverted_regular": tet_metrics(inverted),
            "quad_unit_square": {"aspect_ratio": quad_aspect_ratio([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]])},
            "quad_rect_2x1": {"aspect_ratio": quad_aspect_ratio([[0, 0, 0], [2, 0, 0], [2, 1, 0], [0, 1, 0]])},
            "quad_rect_10x1": {"aspect_ratio": quad_aspect_ratio([[0, 0, 0], [10, 0, 0], [10, 1, 0], [0, 1, 0]])},
        },
        "tolerance_abs": 1e-6,
    }
    with open(out("mesh_quality_reference.json"), "w") as f:
        json.dump(mq, f, indent=1)
        f.write("\n")


if __name__ == "__main__":
    main()
