#!/usr/bin/env python3
"""Reference-result generator for llull gap MAT (docs/aerospace/08-materials-standards-libraries).

Pure stdlib, python3 >= 3.8:
    python3 generate_mat_reference.py           # writes expected_results.json next to this file
    python3 generate_mat_reference.py --check   # recomputes and fails (exit 1) if the committed JSON differs

Inputs:
  * materials_dataset.json        (sourced densities; only entries with status "verified" are used)
  * fastener_catalog_sample.json  (sourced fastener sizing rules)

Every expected value is DERIVED here from a cited input by a formula written in this file (TEMPLATE rule (b)).
Exact conversion constants: 1 in = 25.4 mm, 1 lb = 453.59237 g (international yard and pound, 1959).
"""
from __future__ import annotations

import json
import math
import sys
from fractions import Fraction
from pathlib import Path

HERE = Path(__file__).parent
OUT = HERE / "expected_results.json"
IN_PER_MM = 1 / 25.4
G_PER_LB = 453.59237
MM3_PER_IN3 = 25.4 ** 3  # 16387.064


def load(name: str) -> dict:
    return json.loads((HERE / name).read_text(encoding="utf-8"))


def r(value: float, digits: int = 6) -> float:
    return float(f"{value:.{digits}g}")


# ---------------------------------------------------------------- unit conversion (VC-MAT-03)
def lb_in3_to_g_cm3(rho: float) -> float:
    return rho * G_PER_LB / MM3_PER_IN3 * 1000.0


def unit_cases() -> list[dict]:
    cases = []
    for rho in (0.100, 0.101, 0.160):
        g_cm3 = lb_in3_to_g_cm3(rho)
        cases.append({
            "id": f"VC-MAT-03/{rho}lb_in3",
            "input": {"density": rho, "unit": "lb/in^3"},
            "expected": {"g/cm^3": r(g_cm3, 12), "g/mm^3": r(g_cm3 / 1000.0, 12), "kg/m^3": r(g_cm3 * 1000.0, 12)},
            "tolerance": {"relative": 1e-9},
            "derivation": "rho[g/cm^3] = rho[lb/in^3] * 453.59237 / 16.387064 (exact constants)",
        })
    return cases


# ---------------------------------------------------------------- mass properties (VC-MAT-04)
def mass_cases(materials: dict) -> list[dict]:
    def density(material_id: str, property_id: str) -> tuple[float, str, str]:
        mat = next(m for m in materials["materials"] if m["id"] == material_id)
        prop = mat["physical"][property_id]
        assert prop["status"] == "verified", f"{material_id}.{property_id} is not verified"
        unit = prop["unit"]
        value = prop["value"]
        g_mm3 = value / 1000.0 if unit == "g/cm^3" else lb_in3_to_g_cm3(value) / 1000.0
        return g_mm3, f"{material_id}.physical.{property_id} = {value} {unit}", prop["source"]

    geoms = [
        ("box_100x50x10_mm", "mm", 100 * 50 * 10, "V = 100*50*10 mm^3", "aa7075_t6", "density_typical_matweb"),
        ("box_100x50x10_mm", "mm", 100 * 50 * 10, "V = 100*50*10 mm^3", "aa7075_t6", "density_ams4045_supplier"),
        ("cylinder_r10_h50_mm", "mm", math.pi * 10 ** 2 * 50, "V = pi*10^2*50 mm^3", "ti6al4v_annealed", "density_supplier"),
        ("plate_100x100x5_hole_d10_mm", "mm", 100 * 100 * 5 - math.pi * 5 ** 2 * 5,
         "V = 100*100*5 - pi*5^2*5 mm^3 (through hole)", "aa2024_t3", "density_typical_matweb"),
    ]
    cases = []
    for name, units, volume_mm3, vder, mat, prop in geoms:
        g_mm3, dsrc, src = density(mat, prop)
        cases.append({
            "id": f"VC-MAT-04/{name}/{mat}/{prop}",
            "geometry": name, "documentUnits": units, "material": mat,
            "expected": {"volume_mm3": r(volume_mm3, 9), "density_g_mm3": r(g_mm3, 9), "mass_g": r(volume_mm3 * g_mm3, 7)},
            "tolerance": {"relative_exact_kernel": 1e-6, "relative_mesh_kernel": 5e-3},
            "derivation": f"{vder}; {dsrc}; mass = V * rho",
            "densitySource": src,
        })
    # inch document: density stays in lb/in^3, mass reported in lb and g
    g_mm3, dsrc, src = density("aa7075_t6", "density_ams4045_supplier")
    v_in3 = 2.0 * 1.0 * 0.25
    cases.append({
        "id": "VC-MAT-04/box_2x1x0.25_in/aa7075_t6/density_ams4045_supplier",
        "geometry": "box_2x1x0.25_in", "documentUnits": "in", "material": "aa7075_t6",
        "expected": {"volume_in3": v_in3, "mass_lb": r(v_in3 * 0.101, 9), "mass_g": r(v_in3 * 0.101 * G_PER_LB, 7)},
        "tolerance": {"relative_exact_kernel": 1e-6, "relative_mesh_kernel": 1e-6},
        "derivation": f"V = 2*1*0.25 in^3; {dsrc}; mass_lb = V*rho; mass_g = mass_lb*453.59237",
        "densitySource": src,
    })
    return cases


# ---------------------------------------------------------------- bolt grip selection (VC-MAT-07)
def bolt_grip_cases(catalog: dict) -> list[dict]:
    fam = next(f for f in catalog["families"] if f["id"] == "NAS6203-6220")
    rules = catalog["installationRules"]
    max_washer = rules["maxCombinedWasherHeight_in"]["value"]
    washer_steps = [w["value"] for w in catalog["families_washers"]["NAS1149"]["thicknessOptions_in"]]
    sizes = {s["dash"]: s for s in fam["sizes"]}
    grip_inc = Fraction(fam["gripIncrement_in"]["value"]).limit_denominator(64)
    stacks = [
        ("3", 0.500), ("3", 0.510), ("3", 0.5625), ("4", 0.250), ("4", 0.300),
        ("5", 0.625), ("5", 0.700), ("6", 1.000), ("6", 0.020), ("4", 3.000),
    ]
    cases = []
    for dash, t in stacks:
        size = sizes[dash]
        lo, hi = fam["fixtureGripDashRange"]
        tf = Fraction(t).limit_denominator(10000)
        grip_dash = max(lo, math.ceil(tf / grip_inc))
        case = {"id": f"VC-MAT-07/NAS620{dash}/t={t}", "input": {"family": "NAS6203-6220", "diameterDash": dash, "stack_in": t}}
        if grip_dash > hi:
            case["expected"] = {"ok": False, "reason": "stack exceeds largest grip in catalogue fixture"}
            cases.append(case)
            continue
        grip = float(grip_dash * grip_inc)
        gap = round(grip - t, 6)
        # washers under the nut fill the gap so the nut clamps on thread, not shank; choose the fewest
        # NAS1149 thicknesses whose sum >= gap (ties -> smallest total), max combined height 1/8 in (AC 43.13-1B 7-37).
        best = None
        if gap > 0:
            for n in (1, 2, 3):
                for combo in _combos(washer_steps, n):
                    total = round(sum(combo), 6)
                    if total + 1e-9 >= gap and total <= max_washer + 1e-9:
                        if best is None or (len(combo), total) < (len(best), round(sum(best), 6)):
                            best = combo
                if best is not None:
                    break
        washers = list(best) if best else []
        length = round(grip + size["threadLength_in"]["value"], 3)
        expected = {
            "ok": gap <= max_washer + 1e-9 and (gap == 0 or best is not None),
            "partNumber": f"NAS620{dash}-{grip_dash}",
            "grip_in": round(grip, 4), "length_in": length, "gap_in": gap,
            "washersUnderNut_in": washers,
        }
        if dash == "3":
            nut_h = catalog["families_nuts"]["MS21042"]["sizes"][0]["height_in"]["max"]
            pitch = 1 / size["threadsPerInch"]
            protrusion = round(length - t - sum(washers) - nut_h, 4)
            expected["nut"] = "MS21042L3"
            expected["protrusionBeyondNutMaxHeight_in"] = protrusion
            expected["atLeastOneThreadProtrudes"] = protrusion >= pitch
        if grip_dash == lo:
            expected["fixtureOnly"] = "grip dash %d is the lower end of the test-fixture range %s; real availability TBD from the NAS sheet" % (grip_dash, [lo, hi])
        case["expected"] = expected
        case["derivation"] = (
            "gripDash = ceil(stack / 0.0625); grip = gripDash*0.0625; length = grip + threadLength(dia); "
            "gap = grip - stack filled by NAS1149 washers (sum >= gap, <= 0.125 in); "
            "protrusion = length - stack - washers - nutHeightMax >= 1 thread pitch (AC 43.13-1B 7-37: 'at least one thread'; one pitch beyond the MAX nut height is a llull choice); length rounded to 0.001 in as distributors list it, protrusion computed from the rounded length"
        )
        cases.append(case)
    return cases


def _combos(values: list[float], n: int):
    if n == 0:
        yield ()
        return
    for i, v in enumerate(values):
        for rest in _combos(values[i:], n - 1):
            yield (v, *rest)


# ---------------------------------------------------------------- Hi-Lok grip (VC-MAT-08)
def hilok_cases() -> list[dict]:
    cases = []
    for dia32, t in ((8, 0.600), (8, 0.5625), (8, 0.5626), (6, 0.250), (6, 0.251)):
        n = math.ceil(Fraction(t).limit_denominator(100000) * 16)
        cases.append({
            "id": f"VC-MAT-08/HL19-{dia32}/t={t}",
            "input": {"family": "HL19", "diameterDash32nds": dia32, "stack_in": t},
            "expected": {"partNumber": f"HL19-{dia32}-{n}", "gripRange_in": [round((n - 1) / 16, 4), round(n / 16, 4)],
                         "diameter_in": round(dia32 / 32, 5)},
            "derivation": "gripDash n = ceil(16*stack); pin covers ((n-1)/16, n/16] in (HL19-8-10 -> .5625-.625 in)",
        })
    return cases


# ---------------------------------------------------------------- rivet length (VC-MAT-09)
def rivet_cases(catalog: dict) -> list[dict]:
    fam = next(f for f in catalog["families"] if f["id"] == "MS20470")
    dias = {s["dash"]: s["shankDiameter_in"]["value"] for s in fam["sizes"]}
    cases = []
    for dash, t in (("4", 0.125), ("4", 0.080), ("3", 0.064), ("5", 0.160), ("6", 0.250), ("6", 0.188)):
        d = dias[dash]
        raw = t + 1.5 * d
        length_dash = math.ceil(round(raw * 16, 9))
        cases.append({
            "id": f"VC-MAT-09/MS20470AD{dash}/t={t}",
            "input": {"family": "MS20470", "material": "AD", "diameterDash": dash, "stack_in": t},
            "expected": {
                "partNumber": f"MS20470AD{dash}-{length_dash}", "rawLength_in": round(raw, 5),
                "length_in": round(length_dash / 16, 5),
                "shopHeadMinDiameter_in": round(1.5 * d, 5), "shopHeadMinHeight_in": round(0.5 * d, 5),
                "minEdgeDistance_in": round(2 * d, 5), "minPitch_in": round(3 * d, 5),
            },
            "derivation": "L = stack + 1.5D rounded UP to 1/16 in (open question OQ-MAT-04: nearest vs up); "
                          "shop head >= 1.5D x 0.5D; edge >= 2D, pitch >= 3D (AC 43.13-1B 4-57c)",
        })
    return cases


# ---------------------------------------------------------------- catalogue self-consistency (VC-MAT-06)
def checkpoint_cases(catalog: dict) -> list[dict]:
    fam = next(f for f in catalog["families"] if f["id"] == "NAS6203-6220")
    cases = []
    for size in fam["sizes"]:
        for cp in size["checkpoints"]:
            grip_dash = int(cp["pn"].split("-")[1])
            grip = grip_dash * fam["gripIncrement_in"]["value"]
            length = grip + size["threadLength_in"]["value"]
            cases.append({
                "id": f"VC-MAT-06/{cp['pn']}",
                "expected": {"grip_in": round(grip, 4), "length_in": round(length, 3)},
                "published": {"grip_in": cp["grip_in"], "length_in": cp["length_in"]},
                "tolerance": {"absolute_in": 0.001},
                "consistent": abs(round(grip, 3) - cp["grip_in"]) <= 0.001 and abs(length - cp["length_in"]) <= 0.001,
                "derivation": "grip = dash*0.0625; length = grip + threadLength (distributor rule S22)",
            })
    return cases


# ---------------------------------------------------------------- agent-first contract (VC-MAT-22..26, AGENT_FIRST.md)
UNVERIFIED_BASES = ("typical", "supplier_unstated", "unspecified")


def agent_first_cases(materials: dict, catalog: dict) -> list[dict]:
    mat = next(m for m in materials["materials"] if m["id"] == "aa7075_t6")
    typ = mat["physical"]["density_typical_matweb"]
    sup = mat["physical"]["density_ams4045_supplier"]
    rho_typ = typ["value"] / 1000.0
    rho_sup = lb_in3_to_g_cm3(sup["value"]) / 1000.0
    volume = 100 * 50 * 10
    def mass_case(prop_id, prop, rho):
        reasons = [f"basis {prop['basis']}"] if prop["basis"] in UNVERIFIED_BASES else []
        m = volume * rho
        return {"densitySource": f"aa7075_t6.physical.{prop_id}", "basis": prop["basis"], "source": prop["source"],
                "massG": r(m, 7), "massKg": r(m / 1000.0, 7), "massLb": r(m / G_PER_LB, 7),
                "unverified": bool(reasons), "unverifiedReasons": reasons}
    rules = catalog["installationRules"]
    return [
        {"id": "VC-MAT-22", "quantity": "unverified flag propagates into mass_properties (AF-32)",
         "geometry": "box_100x50x10_mm",
         "expected": [mass_case("density_typical_matweb", typ, rho_typ), mass_case("density_ams4045_supplier", sup, rho_sup),
                      {"densitySource": "legacy Material.density 0.00785 g/mm^3 (10 mm cube)", "massG": 7.85,
                       "unverified": True, "unverifiedReasons": ["density given without a source (unverified)"]}],
         "check_materials": {"code": "MAT_VALUE_UNVERIFIED", "severity": "warning"},
         "tolerance": {"relative": 1e-6},
         "derivation": "mass = V * rho (as VC-MAT-04); unverified iff basis in typical/supplier_unstated/unspecified or provenance legacy (TR-MAT-50)"},
        {"id": "VC-MAT-23", "quantity": "unverified + reviewRequired on allowables and downstream FEA (AF-32, AF-33)",
         "expected": [
             {"call": "get_material_allowable material=aa7075_t6 property=Ftu basis=typical", "valueMPa": 572, "basis": "typical",
              "unverified": True, "unverifiedReasons": ["basis typical"], "reviewRequired": True},
             {"call": "get_material_allowable material=aa7075_t6 property=Ftu basis=typical forCertification=true",
              "exitCode": 1, "code": "MAT_VALUE_UNVERIFIED", "available": False},
             {"call": "gap 05 compute_margins with E and Ftu from this record", "rows[*].unverified": True,
              "rows[*].reviewRequired": True, "check_analysis contains": "FEA_MATERIAL_UNVERIFIED"}],
         "derivation": "FR-MAT-25/29; value 572 MPa quoted from S12 (typical)"},
        {"id": "VC-MAT-24", "quantity": "stable error codes for deliberately wrong inputs (AF-11)",
         "expected": [
             {"call": "set_material_property property=density value=2.81 unit=MPa", "code": "MAT_UNIT_DIMENSION"},
             {"call": "set_material_property property=Ftu value=83 unit=ksi (no basis)", "code": "MAT_BASIS_MISSING"},
             {"call": "second preferred density on the same key", "code": "MAT_PREFERRED_CONFLICT"},
             {"call": "get_material_allowable basis=A where only S exists", "code": "MAT_ALLOWABLE_NOT_AVAILABLE"},
             {"call": "temperature 600 degF on the VC-MAT-16 table", "code": "MAT_TEMPERATURE_OUT_OF_RANGE"},
             {"call": "import licensed-no-redistribution library with storage=embedded", "code": "MAT_LICENCE_EMBED_FORBIDDEN"},
             {"call": "select_fastener NAS6204 stack 3.000 in", "code": "FAST_STACK_OUT_OF_RANGE"},
             {"call": "insert_fastener_row MS20470AD4 pitch 0.30 in", "code": "FAST_PITCH"},
             {"call": "decode_part_number partNumber=XYZ123", "code": "FAST_PART_NUMBER_UNKNOWN"}],
         "assert": "exit code 1; data.code; non-empty data.remediation; data.ids or data.path",
         "derivation": "TECHNICAL_SPEC 7.1"},
        {"id": "VC-MAT-25", "quantity": "human gates refuse an agent caller (AF-34)",
         "expected": [
             {"call": "export_step_exact on an ITAR-marked document", "exitCode": 1, "code": "MAT_EXPORT_CONTROLLED", "saved": []},
             {"call": "export_step_exact confirmExportControlled=true (agent, no human token)", "exitCode": 1, "code": "MAT_HUMAN_GATE", "saved": []},
             {"call": "lower marking ITAR -> none (agent)", "exitCode": 1, "code": "MAT_HUMAN_GATE", "documentChanged": False},
             {"call": "raise marking none -> EAR99 (agent)", "exitCode": 0, "documentChanged": True}],
         "derivation": "FR-MAT-30, TR-MAT-51"},
        {"id": "VC-MAT-26", "quantity": "named defaults in select_fastener results (AF-31)",
         "expected": {
             "maxWasherTotal": {"value": rules["maxCombinedWasherHeight_in"]["value"], "unit": "in", "source": "AC 43.13-1B 7-37", "defaulted": True},
             "minProtrusion": {"value": "1 thread pitch beyond nut max height", "source": "AC 43.13-1B 7-37 ('at least one thread'); llull reading", "defaulted": True},
             "rivetLengthRounding": {"value": "up", "step": {"value": 0.0625, "unit": "in"}, "source": "llull choice (OQ-MAT-04)", "defaulted": True},
             "rivetMinEdgeDistance": {"value": "2 D", "source": "AC 43.13-1B 4-57(c)", "defaulted": True},
             "rivetMinPitch": {"value": "3 D", "source": "AC 43.13-1B 4-57(c)", "defaulted": True}},
         "derivation": "FR-MAT-28; values from fastener_catalog_sample.json installationRules / rivet selectionRule"},
    ]


def build() -> dict:
    materials = load("materials_dataset.json")
    catalog = load("fastener_catalog_sample.json")
    return {
        "generator": "generate_mat_reference.py",
        "constants": {"mm_per_in": 25.4, "g_per_lb": G_PER_LB},
        "unitConversion": unit_cases(),
        "massProperties": mass_cases(materials),
        "catalogCheckpoints": checkpoint_cases(catalog),
        "boltGripSelection": bolt_grip_cases(catalog),
        "hiLokGripSelection": hilok_cases(),
        "rivetSelection": rivet_cases(catalog),
        "agentFirst": agent_first_cases(materials, catalog),
    }


def main() -> int:
    data = build()
    text = json.dumps(data, indent=1) + "\n"
    if "--check" in sys.argv:
        if not OUT.exists() or OUT.read_text(encoding="utf-8") != text:
            print("expected_results.json is stale — rerun generate_mat_reference.py", file=sys.stderr)
            return 1
        print("expected_results.json up to date")
        return 0
    OUT.write_text(text, encoding="utf-8")
    print(f"wrote {OUT.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
