#!/usr/bin/env python3
"""Reference-result generator for llull PHY-13 COR (docs/physics/13-corrosion-compatibility).

Python 3 standard library only. Run from this folder:
    python3 -I generate_corrosion_reference.py           # writes expected_results.json
    python3 -I generate_corrosion_reference.py --check   # exit 1 if the committed JSON is stale

Derives (TEMPLATE rule (b)):
  1. Contact detection on axis-aligned boxes (closed form): face contact area, interference volume, gap,
     edge-only contact. This is the reference for find_contacts' closed-form path and for the exact kernel
     path on the same solids (both must agree to 1e-9 relative).
  2. Anodic-index screening verdicts for test couples (rule COR-R-02, inputs galvanic_anodic_index.csv and
     anodic_index_limits.csv). Index values are grade B, limits grade A: verdicts are B.
  3. Area ratio (COR-R-03) from closed-form box surface areas.
  4. Unit conversions used by the rules (889D threshold mil/yr -> um/yr, HE threshold ksi -> MPa) and the HE
     flag on test steels.
Numbers are stored with 12 significant digits (docs/physics/README.md §6.3).
"""
from __future__ import annotations

import csv
import json
import sys
from pathlib import Path

HERE = Path(__file__).parent
OUT = HERE / "expected_results.json"
UM_PER_MIL = 25.4          # 1 mil = 0.001 in = 25.4 um (exact)
MPA_PER_KSI = 6.8947572931683613


def r12(value: float) -> float:
    return float(f"{value:.12g}")


# ------------------------------------------------------------------ 1. contact detection (boxes)
Box = tuple[tuple[float, float, float], tuple[float, float, float]]  # (min, max)


def overlap_1d(a0: float, a1: float, b0: float, b1: float) -> float:
    """Signed overlap length: > 0 overlap, 0 touching, < 0 gap."""
    return min(a1, b1) - max(a0, b0)


def box_contact(a: Box, b: Box, tol: float) -> dict:
    """Classify two axis-aligned boxes: interference / face / edge / vertex / none, with area, volume, gap."""
    o = [overlap_1d(a[0][k], a[1][k], b[0][k], b[1][k]) for k in range(3)]
    if all(v > tol for v in o):
        return {"kind": "interference", "volume": r12(o[0] * o[1] * o[2]), "gap": 0.0, "area": None}
    gap = max(0.0, -min(o))
    if gap > tol:
        return {"kind": "none", "gap": r12(gap), "area": None, "volume": 0.0}
    # within tolerance: count the axes that are "touching" (|o| <= tol) vs overlapping
    touching = [k for k in range(3) if o[k] <= tol]
    if len(touching) == 1:
        k = touching[0]
        i, j = [m for m in range(3) if m != k]
        return {"kind": "face", "area": r12(o[i] * o[j]), "gap": r12(gap), "volume": 0.0, "normalAxis": "xyz"[k]}
    if len(touching) == 2:
        return {"kind": "edge", "area": 0.0, "gap": r12(gap), "volume": 0.0}
    return {"kind": "vertex", "area": 0.0, "gap": r12(gap), "volume": 0.0}


def box_area(b: Box) -> float:
    dx, dy, dz = (b[1][k] - b[0][k] for k in range(3))
    return 2.0 * (dx * dy + dy * dz + dz * dx)


PLATE: Box = ((0.0, 0.0, 0.0), (100.0, 50.0, 10.0))
CONTACT_CASES = {
    "face_on_top": ((20.0, 10.0, 10.0), (80.0, 40.0, 15.0)),
    "interference_0p5": ((20.0, 10.0, 9.5), (80.0, 40.0, 14.5)),
    "gap_0p05_within_tol": ((20.0, 10.0, 10.05), (80.0, 40.0, 15.05)),
    "gap_0p2_outside_tol": ((20.0, 10.0, 10.2), (80.0, 40.0, 15.2)),
    "edge_only": ((100.0, 50.0, 0.0), (120.0, 70.0, 10.0)),
    "side_face_partial": ((100.0, 30.0, 5.0), (130.0, 70.0, 20.0)),
}
TOL_MM = 0.1


# ------------------------------------------------------------------ 2. anodic index screening
def load_csv(name: str) -> list[dict]:
    with (HERE / name).open(encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def screen(ai: dict, limits: dict, g1: str, g2: str) -> dict:
    v1, v2 = ai[g1], ai[g2]
    anode, cathode = (g1, g2) if v1 > v2 else (g2, g1)
    diff = abs(v1 - v2)
    verdict = {env: ("compatible" if diff <= lim + 1e-12 else "incompatible") for env, lim in sorted(limits.items())}
    return {"anode": anode, "cathode": cathode, "differenceV": r12(diff), "verdict": verdict}


COUPLES = [
    ("aluminium_wrought_other", "cadmium_plate"),       # 7075 with a cadmium-plated steel fastener
    ("aluminium_wrought_other", "nickel_titanium_group"),  # 7075 with titanium
    ("aluminium_wrought_2000", "nickel_titanium_group"),   # 2024 with titanium
    ("magnesium", "aluminium_wrought_other"),
    ("zinc", "cadmium_plate"),
    ("aluminium_wrought_2000", "gold"),
]


# ------------------------------------------------------------------ assemble
def case(cid, quantity, value, unit, tol, source, grade, proves, **extra) -> dict:
    out = {"id": cid, "quantity": quantity, "value": value, "unit": unit, "tolerance": tol,
           "source": source, "grade": grade, "proves": proves}
    out.update(extra)
    return out


def build() -> dict:
    ai = {row["group_id"]: float(row["anodic_index_V"]) for row in load_csv("galvanic_anodic_index.csv")
          if row["anodic_index_V"] not in ("tbd", "")}
    limits = {row["environment"]: float(row["max_anodic_index_difference_V"]) for row in load_csv("anodic_index_limits.csv")}
    contacts = {name: box_contact(PLATE, b, TOL_MM) for name, b in CONTACT_CASES.items()}
    screens = {f"{a}|{b}": screen(ai, limits, a, b) for a, b in COUPLES}
    area_plate = box_area(PLATE)
    area_top = box_area(CONTACT_CASES["face_on_top"])
    he_threshold_mpa = 180.0 * MPA_PER_KSI
    steels = {"aisi4340_260ksi_cd_plated": (260.0 * MPA_PER_KSI, True),
              "aisi4130_normalized_670MPa_cd_plated": (670.0, True),
              "aisi4340_260ksi_unplated": (260.0 * MPA_PER_KSI, False)}
    he = {k: (ftu >= he_threshold_mpa and plated) for k, (ftu, plated) in steels.items()}
    exact = {"rel": 1e-9}
    cases = []
    k = 0
    for name, res in contacts.items():
        k += 1
        cases.append(case(f"VC-COR-01.{k}", f"find_contacts plate vs block '{name}' (tol {TOL_MM} mm)", res, "mm, mm^2, mm^3",
                          exact, "derived (closed-form AABB overlap)", "A", ["FR-COR-01", "FR-COR-02", "TR-COR-03"]))
    k = 0
    for pair, res in screens.items():
        k += 1
        cases.append(case(f"VC-COR-02.{k}", f"anodic-index screening {pair}", res, "V", {"abs": 1e-12},
                          "galvanic_anodic_index.csv (B) + anodic_index_limits.csv (A)", "B", ["FR-COR-05", "FR-COR-06"]))
    cases.append(case("VC-COR-03", "area ratio Aa/Ac: cadmium-plated block (anode) on the 7075 plate (cathode)",
                      r12(area_top / area_plate), "-", exact, "derived (box surface areas 4500 / 13000 mm^2)", "A",
                      ["FR-COR-07"], anodeAreaMm2=r12(area_top), cathodeAreaMm2=r12(area_plate), code="COR_SMALL_ANODE"))
    cases.append(case("VC-COR-04", "889D compatible threshold converted to um/yr", r12(0.009 * UM_PER_MIL), "um/yr", exact,
                      "S2 (0.009 mil/yr, secondary) x exact mil", "B", ["FR-COR-04"]))
    cases.append(case("VC-COR-05", "hydrogen-embrittlement default threshold 180 ksi in MPa", r12(he_threshold_mpa), "MPa", exact,
                      "S13 (NAS672 scope) x exact psi", "B", ["FR-COR-10", "FR-COR-14"]))
    cases.append(case("VC-COR-06", "HE flag per test steel (threshold 180 ksi, electroplated surface)", he, "bool", {"exact": True},
                      "derived", "A", ["FR-COR-10"], code="COR_HE_RISK"))
    cases.append(case("VC-COR-07", "CFRP part face-contacting a 7075 part without declared isolation", "COR_CFRP_ALUMINIUM", "code",
                      {"exact": True}, "compatibility_rules.json COR-R-04 (S10)", "B", ["FR-COR-08"]))
    cases.append(case("VC-COR-08", "same pair after declare_isolation method=glass_isolation_ply", "pass (isolated)", "status",
                      {"exact": True}, "COR-R-04/07", "A", ["FR-COR-09", "FR-COR-12"]))
    cases.append(case("VC-COR-09", "graphite has no anodic index: anodic screening refuses, 889 or rule COR-R-04 used",
                      "COR_GROUP_VALUE_MISSING", "code", {"exact": True}, "galvanic_anodic_index.csv graphite = tbd", "A",
                      ["FR-COR-05", "FR-COR-13"]))
    cases.append(case("VC-COR-10", "889D matrix lookup while the matrix is not transcribed", "COR_889_TABLE_MISSING", "code",
                      {"exact": True}, "compatibility_rules.json COR-R-01 matrix tbd", "A", ["FR-COR-04", "FR-COR-13"]))
    cases.append(case("VC-COR-11", "SCC check on a 7075-T6 part loaded in ST, table row not transcribed", "COR_SCC_UNCLASSIFIED", "code",
                      {"exact": True}, "scc_classes.json", "A", ["FR-COR-11", "FR-COR-13"]))
    cases.append(case("VC-COR-12", "fastener stack contacts from 08 FastenerStack (2 plates + bolt + washer + nut)",
                      {"pairs": [["bolt", "plate1"], ["bolt", "plate2"], ["nut", "washer"], ["plate1", "plate2"], ["plate2", "washer"]],
                       "source": "stack"}, "ids", {"exact": True}, "08 MAT TECHNICAL_SPEC §3.4 FastenerStack (layers, washers side nut)", "A",
                      ["FR-COR-03"]))
    override = screen({**ai, "aluminium_7075_override": 0.80}, limits, "aluminium_7075_override", "cadmium_plate")
    cases.append(case("VC-COR-13", "Cd-plated steel part: galvanic group resolved from the outer plating layer, not the steel",
                      "cadmium_plate", "group", {"exact": True}, "TECHNICAL_SPEC TR-COR-05", "A", ["FR-COR-15"]))
    cases.append(case("VC-COR-14", "material anodicIndex override 0.80 V vs cadmium plate: tie at the harsh limit is compatible (<=)",
                      override, "V", {"abs": 1e-12}, "derived (override is a test value, not a material property)", "A",
                      ["FR-COR-16", "TR-COR-06"]))
    cases.append(case("VC-COR-15", "every item carries reviewRequired; agent acceptance refused",
                      {"reviewRequired": True, "acceptCode": "COR_HUMAN_GATE", "unverifiedWhenRuleGradeB": True}, "flags",
                      {"exact": True}, "AGENT_FIRST AF-32/33/34", "A", ["FR-COR-17", "FR-COR-18"]))
    cases.append(case("VC-COR-16", "compatibility report CSV header (--save)",
                      ["key", "status", "code", "a", "b", "materials", "surfaceSystems", "rule", "grade", "delta", "remedies", "acceptance"],
                      "columns", {"exact": True}, "TECHNICAL_SPEC §6", "A", ["FR-COR-19"]))
    return {
        "pack": "13-corrosion-compatibility",
        "generatedBy": "generate_corrosion_reference.py",
        "toleranceMm": TOL_MM,
        "plate": PLATE,
        "contacts": contacts,
        "anodicScreening": screens,
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
