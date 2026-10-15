#!/usr/bin/env python3
"""Reference-result generator for llull PHY-14 ENV (docs/physics/14-moisture-outgassing).

Python 3 standard library only. Run from this folder:
    python3 -I generate_environment_reference.py           # writes expected_results.json
    python3 -I generate_environment_reference.py --check   # exit 1 if the committed JSON is stale

Derives (TEMPLATE rule (b)):
  1. Fickian moisture uptake of a plate of thickness h exposed on both faces (Crank plane-sheet solution, used by
     Shen & Springer 1976):
         G(t) = (M - Mi)/(Mm - Mi) = 1 - (8/pi^2) * sum_{j>=0} exp(-(2j+1)^2 pi^2 D t / h^2) / (2j+1)^2
     evaluated to 1e-15 truncation; the dimensionless times tau = D t / h^2 for G = 0.5, 0.9, 0.99 by bisection;
     the short-time limit G ~ (4/sqrt(pi)) sqrt(tau) checked numerically; a synthetic worked case.
  2. Hygroscopic strain eps = beta * dM and the equivalent-temperature analogy dT_eq = beta * dM / alpha used
     to hand moisture to a thermal-strain solver (exact when beta_i/alpha_i is the same in every direction).
  3. Outgassing screening on SYNTHETIC materials against the two limit profiles of environment_rules.json
     (shows that TML-based and RML-based profiles can disagree), RML = TML - WVR, and a part-level mass-loss
     budget = TML x part mass (screening quantity, not a contamination prediction).
  4. Atomic-oxygen recession depth = Ey x F and mass loss = rho x A x Ey x F (Kapton H Ey, grade A; fluences
     synthetic or B).
Numbers are stored with 12 significant digits (docs/physics/README.md §6.3).
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).parent
OUT = HERE / "expected_results.json"


def r12(value: float) -> float:
    return float(f"{value:.12g}")


# ------------------------------------------------------------------ 1. Fick plane sheet
def fick_g(tau: float) -> float:
    """Fractional uptake G(tau), tau = D t / h^2, plate of thickness h exposed on both faces."""
    if tau <= 0.0:
        return 0.0
    total, j = 0.0, 0
    while True:
        n = 2 * j + 1
        term = math.exp(-(n * n) * math.pi ** 2 * tau) / (n * n)
        total += term
        if term < 1e-17:
            break
        j += 1
        if j > 200000:
            raise RuntimeError("series did not converge")
    return 1.0 - 8.0 / math.pi ** 2 * total


def tau_for(g_target: float) -> float:
    lo, hi = 1e-12, 10.0
    for _ in range(300):
        mid = 0.5 * (lo + hi)
        if fick_g(mid) < g_target:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


def short_time_ratio(tau: float) -> float:
    """G(tau) / ((4/sqrt(pi)) sqrt(tau)); tends to 1 as tau -> 0 (Crank short-time solution, two faces)."""
    return fick_g(tau) / (4.0 / math.sqrt(math.pi) * math.sqrt(tau))


# ------------------------------------------------------------------ 2. hygro strain
def hygro_strain(beta: float, d_m_percent: float) -> float:
    """beta in strain per % moisture weight gain (1/%), dM in %."""
    return beta * d_m_percent


# ------------------------------------------------------------------ 3. outgassing
SYNTHETIC_OUTGASSING = [
    # id, TML %, CVCM %, WVR %
    ("syn_low", 0.95, 0.05, 0.30),
    ("syn_water", 1.20, 0.02, 0.40),
    ("syn_cvcm", 0.60, 0.12, 0.10),
    ("syn_edge", 1.00, 0.10, 0.00),
]


def passes(op: str, value: float, limit: float) -> bool:
    return value <= limit + 1e-12 if op == "<=" else value < limit - 1e-12


def screen(profile: dict, tml: float, cvcm: float, wvr: float) -> dict:
    values = {"TML": tml, "CVCM": cvcm, "RML": tml - wvr}
    fails = [lim["quantity"] for lim in profile["limits"] if not passes(lim["op"], values[lim["quantity"]], lim["value"])]
    return {"pass": not fails, "failed": fails}


# ------------------------------------------------------------------ assemble
def case(cid, quantity, value, unit, tol, source, grade, proves, **extra) -> dict:
    out = {"id": cid, "quantity": quantity, "value": value, "unit": unit, "tolerance": tol,
           "source": source, "grade": grade, "proves": proves}
    out.update(extra)
    return out


def build() -> dict:
    rules = json.loads((HERE / "environment_rules.json").read_text(encoding="utf-8"))
    profiles = {p["id"]: p for p in rules["profiles"]}
    cases = []
    exact = {"rel": 1e-9}

    taus = {f"G{int(g * 100)}": r12(tau_for(g)) for g in (0.5, 0.9, 0.99)}
    for k, (key, val) in enumerate(taus.items(), start=1):
        cases.append(case(f"VC-ENV-01.{k}", f"dimensionless time D t / h^2 for {key[1:]} % of saturation (plate, two faces)", val, "-",
                          {"rel": 1e-9}, "derived (Crank plane-sheet series, S14/S15)", "A", ["FR-ENV-06", "TR-ENV-05"]))
    g_values = {str(t): r12(fick_g(t)) for t in (0.001, 0.01, 0.05, 0.1, 0.2, 0.5, 1.0)}
    cases.append(case("VC-ENV-02", "fractional uptake G at selected tau", g_values, "-", {"rel": 1e-9},
                      "derived (series to 1e-17 per term)", "A", ["FR-ENV-06"]))
    st = {str(t): r12(short_time_ratio(t)) for t in (1e-6, 1e-4, 1e-3)}
    cases.append(case("VC-ENV-03", "short-time check G / ((4/sqrt(pi)) sqrt(tau)) -> 1", st, "-", {"abs": 1e-6},
                      "derived", "A", ["TR-ENV-05"]))
    # synthetic worked case: h = 2 mm, D = 1e-6 mm^2/s, Mm = 1.5 %, Mi = 0, 7 days
    h_mm, d_mm2s, mm_pct, days = 2.0, 1.0e-6, 1.5, 7.0
    t_s = days * 86400.0
    tau = d_mm2s * t_s / h_mm ** 2
    m_t = mm_pct * fick_g(tau)
    t50_days = taus["G50"] * h_mm ** 2 / d_mm2s / 86400.0
    cases.append(case("VC-ENV-04", "synthetic plate h 2 mm, D 1e-6 mm^2/s, Mm 1.5 %: moisture after 7 days and time to 50 %",
                      {"tau": r12(tau), "moisturePercent": r12(m_t), "t50Days": r12(t50_days)}, "-, %, d", exact,
                      "derived (synthetic inputs, not a material)", "A", ["FR-ENV-06", "FR-ENV-07"]))
    beta, alpha = 1.0e-3, 30e-6  # synthetic: beta 0.001 strain per % moisture (0.1 per unit mass fraction), alpha 30e-6 /K
    eps = hygro_strain(beta, m_t)
    cases.append(case("VC-ENV-05", "hygro strain and equivalent temperature (synthetic beta 0.001 /%, alpha 30e-6 /K) at the VC-ENV-04 moisture",
                      {"strain": r12(eps), "equivalentDeltaTK": r12(eps / alpha)}, "-, K", exact, "derived (eps = beta dM; dT_eq = eps/alpha)", "A",
                      ["FR-ENV-08", "TR-ENV-07"]))
    outg = {}
    for mid, tml, cvcm, wvr in SYNTHETIC_OUTGASSING:
        outg[mid] = {"RML": r12(tml - wvr),
                     "nasa_gsfc_screening": screen(profiles["nasa_gsfc_screening"], tml, cvcm, wvr),
                     "ecss_q_st_70_02": screen(profiles["ecss_q_st_70_02"], tml, cvcm, wvr)}
    for k, (mid, res) in enumerate(outg.items(), start=1):
        cases.append(case(f"VC-ENV-06.{k}", f"outgassing screening of synthetic {mid} under both profiles", res, "%",
                          {"exact": True}, "environment_rules.json profiles (NASA A, ECSS B)", "A" if mid != "syn_water" else "B",
                          ["FR-ENV-01", "FR-ENV-02", "FR-ENV-03"]))
    part_mass_g = 200.0
    budget = {"maxMassLossG": r12(part_mass_g * 0.95 / 100.0), "maxCondensableG": r12(part_mass_g * 0.05 / 100.0)}
    cases.append(case("VC-ENV-07", "screening mass-loss budget of a 200 g part in syn_low (TML 0.95 %, CVCM 0.05 %)", budget, "g", exact,
                      "derived (percent x mass_properties mass)", "A", ["FR-ENV-04"]))
    ey = rules["atomicOxygen"]["kaptonH"]["erosionYield"]["value"]
    f_syn = 1.0e21
    f_misse = rules["atomicOxygen"]["misse2Fluence"]["value"]
    cases.append(case("VC-ENV-08", "Kapton H recession at a synthetic fluence 1e21 atoms/cm^2", r12(ey * f_syn * 1e4), "um", exact,
                      "S9 + S10 (Ey 3.0e-24 cm^3/atom) x fluence", "A", ["FR-ENV-10"]))
    cases.append(case("VC-ENV-09", "Kapton H recession at the MISSE 2 fluence 8.43e21 atoms/cm^2", r12(ey * f_misse * 1e4), "um", exact,
                      "Ey (A) x fluence S12 (B)", "B", ["FR-ENV-10"]))
    rho_syn, area_cm2 = 1.0, 10.0
    cases.append(case("VC-ENV-10", "AO mass loss with synthetic density 1.0 g/cm^3, area 10 cm^2, fluence 1e21", r12(rho_syn * area_cm2 * ey * f_syn), "g",
                      exact, "derived (dM = rho A Ey F)", "A", ["FR-ENV-10"], note="Kapton density not sourced (tbd)"))
    cases.append(case("VC-ENV-11", "material without TML/CVCM used on a part under an outgassing profile", "ENV_OUTGASSING_DATA_MISSING", "code",
                      {"exact": True}, "TECHNICAL_SPEC §7.1", "A", ["FR-ENV-05", "FR-ENV-14"]))
    cases.append(case("VC-ENV-12", "no mission profile set", "ENV_PROFILE_UNSET", "code", {"exact": True}, "AF-31", "A", ["FR-ENV-09", "FR-ENV-14"]))
    cases.append(case("VC-ENV-13", "orthotropic lamina with beta1/alpha1 != beta2/alpha2: equivalent-temperature hand-off refused",
                      "ENV_EQUIVALENT_TEMPERATURE_INVALID", "code", {"exact": True}, "TECHNICAL_SPEC §5.3", "A", ["FR-ENV-08", "TR-ENV-07"]))
    cases.append(case("VC-ENV-14", "flags: synthetic inputs => unverified; deviation approval by an agent refused",
                      {"unverified": True, "approveCode": "ENV_HUMAN_GATE", "reviewRequired": True}, "flags", {"exact": True},
                      "AGENT_FIRST AF-32/33/34", "A", ["FR-ENV-13"]))
    cases.append(case("VC-ENV-15", "NASA outgassing CSV import: one 08 record per sample row, provenance keeps sample id + dataset version",
                      {"recordsPerRow": 1, "properties": ["TML", "CVCM", "WVR"], "provenanceFields": ["sampleId", "datasetVersion"]}, "-",
                      {"exact": True}, "TECHNICAL_SPEC §6", "A", ["FR-ENV-15"]))
    one_face_tau = d_mm2s * t_s / (2.0 * h_mm) ** 2
    cases.append(case("VC-ENV-16", "one face exposed (other sealed), h 2 mm, 7 days == both faces of a 4 mm plate",
                      {"tauEquivalent": r12(one_face_tau), "moisturePercent": r12(mm_pct * fick_g(one_face_tau))}, "-, %", exact,
                      "derived (symmetry: sealed face = mid-plane of a 2h plate)", "A", ["FR-ENV-06", "TR-ENV-05"]))
    return {
        "pack": "14-moisture-outgassing",
        "generatedBy": "generate_environment_reference.py",
        "fickTau": taus,
        "outgassing": outg,
        "cases": cases,
    }


def main() -> int:
    text = json.dumps(build(), indent=1, ensure_ascii=False) + "\n"
    if "--check" in sys.argv:
        if not OUT.exists() or OUT.read_text(encoding="utf-8") != text:
            print("expected_results.json is stale; re-run without --check", file=sys.stderr)
            return 1
        return 0
    OUT.write_text(text, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
