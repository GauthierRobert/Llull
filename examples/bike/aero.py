"""
Aero measurements of the bike variants with llull's read-only aerodynamics commands.

  1. frontal_area (silhouette rasterisation) of every part, accumulated front-to-back so a part hidden behind an earlier
     one only counts with its exposed area (front wheel shields the down tube's lower end, etc.)
  2. drag build-up  CdA_bike = sum(Cd_i * A_exposed_i)  with Cd_i from bike.py (Hoerner strut / cylinder fit at 40 km/h)
  3. calibration against Defraeye et al. 2010 (wind tunnel + CFD, rider 1.83 m): rider-only CdA 0.193 m2 and rider + bike
     0.270 m2 in the upright (hoods) position -> rider Cd = 0.193 / A_rider(baseline) and bike interference factor
     k = (0.270 - 0.193) / CdA_bike(baseline). The same Cd_rider and k are applied to every variant.
  4. road_load_power (Martin et al. 1998 bicycle preset) for watts at 40 km/h, speed at 250 W, 40 km time; aero_drag for N.
  5. yaw sweep of the projected area.

Usage: python3 aero.py   (after the three <variant>.llull.json documents are built)  -> aero_results.json
"""

import json
import math
import subprocess
from pathlib import Path

LLULL = ["node", str(Path(__file__).resolve().parents[2] / "server" / "bin" / "llull.cjs")]
VARIANTS = ["baseline", "aero", "aero_fit"]
RESOLUTION = 1500
DEFRAEYE_RIDER, DEFRAEYE_SYSTEM = 0.193, 0.270
RIDER_KG = 75.0
BIKE_KG = {"baseline": 8.4, "aero": 8.0, "aero_fit": 8.0}
YAWS = [0, 5, 10, 15, 20]


def llull_run(actions, doc):
    with open("_measure.json", "w") as fh:
        json.dump({"actions": actions}, fh)
    out = subprocess.run(LLULL + ["run", "_measure.json", "--doc", doc, "--dry-run", "--json", "--no-fit"], capture_output=True, text=True)
    report = json.loads(out.stdout)
    if not report.get("ok"):
        raise RuntimeError(report.get("summary"))
    return report["data"]["steps"]


def flow(yaw_deg):
    # bike travels +X: the air moves toward -X; a wind from the rider's left front yaws it toward -Y
    a = math.radians(yaw_deg)
    return [round(-math.cos(a), 6), round(-math.sin(a), 6), 0]


def parts_of(variant):
    plan = json.load(open(f"{variant}.plan.json"))["actions"]
    meta = json.load(open(f"{variant}.meta.json"))
    run = json.load(open(f"{variant}.run.json"))["data"]
    bounds = {e["id"]: e["bounds"] for e in run["scene"]["entities"] if "bounds" in e}
    parts = {}
    for action, step in zip(plan, run["steps"]):
        alias = action.get("as")
        if alias not in meta["categories"]:
            continue
        ids = [i for i in step["affected"] if i in bounds]
        if action["command"] == "array_polar":  # copies of the previous spoke: same part
            source = action["params"]["id"].lstrip("$")
            parts[source]["ids"] += ids
            continue
        parts[alias] = {"category": meta["categories"][alias], "cd": meta["drag"][alias], "ids": ids}
    for p in parts.values():
        p["front_x"] = max(bounds[i]["max"][0] for i in p["ids"])
    return parts


def analyse(variant):
    parts = parts_of(variant)
    bike = sorted((p for p in parts.values() if p["category"] != "rider"), key=lambda p: -p["front_x"])
    rider_ids = [i for p in parts.values() if p["category"] == "rider" for i in p["ids"]]
    bike_ids = [i for p in bike for i in p["ids"]]
    actions, cumulative = [], []
    for p in bike:
        cumulative = cumulative + p["ids"]
        actions.append({"command": "frontal_area", "params": {"entityIds": cumulative, "flowDirection": flow(0), "resolution": RESOLUTION}})
    for yaw in YAWS:
        actions.append({"command": "frontal_area", "params": {"entityIds": bike_ids, "flowDirection": flow(yaw), "resolution": RESOLUTION}})
        actions.append({"command": "frontal_area", "params": {"entityIds": bike_ids + rider_ids, "flowDirection": flow(yaw), "resolution": RESOLUTION}})
    actions.append({"command": "frontal_area", "params": {"entityIds": rider_ids, "flowDirection": flow(0), "resolution": RESOLUTION}})
    steps = llull_run(actions, f"{variant}.llull.json")
    areas = [s["data"]["frontalAreaM2"] for s in steps]
    exposed, previous = [], 0.0
    for p, a in zip(bike, areas[: len(bike)]):
        exposed.append(a - previous)
        previous = a
    by_category = {}
    for p, a in zip(bike, exposed):
        c = by_category.setdefault(p["category"], {"areaM2": 0.0, "cdaM2": 0.0})
        c["areaM2"] += a
        c["cdaM2"] += a * p["cd"]
    yaw_rows = areas[len(bike) : len(bike) + 2 * len(YAWS)]
    return {
        "bikeAreaM2": previous,
        "bikeCdABuildUpM2": sum(c["cdaM2"] for c in by_category.values()),
        "byCategory": by_category,
        "riderAreaM2": areas[-1],
        "yaw": [{"yawDeg": y, "bikeAreaM2": yaw_rows[2 * k], "systemAreaM2": yaw_rows[2 * k + 1]} for k, y in enumerate(YAWS)],
        "parts": len(bike),
    }


def road(variant, cda):
    mass = RIDER_KG + BIKE_KG[variant]
    actions = [
        {"command": "road_load_power", "params": {"vehicle": "bicycle", "massKg": mass, "cdA": cda, "speed": 40, "speedUnit": "km/h"}},
        {"command": "road_load_power", "params": {"vehicle": "bicycle", "massKg": mass, "cdA": cda, "powerW": 250}},
        {"command": "aero_drag", "params": {"cdA": cda, "speed": 40, "speedUnit": "km/h"}},
    ]
    steps = llull_run(actions, f"{variant}.llull.json")
    at40, at250, drag = (s["data"] for s in steps)
    return {"powerAt40kmhW": at40["powerW"], "breakdownAt40kmh": at40.get("breakdown"), "speedAt250WKmh": at250["speedKmh"] if "speedKmh" in at250 else at250["speedMS"] * 3.6,
            "dragAt40kmhN": drag["dragN"], "massKg": mass}


results = {v: analyse(v) for v in VARIANTS}
base = results["baseline"]
cd_rider = DEFRAEYE_RIDER / base["riderAreaM2"]
k_bike = (DEFRAEYE_SYSTEM - DEFRAEYE_RIDER) / base["bikeCdABuildUpM2"]
for v, r in results.items():
    r["riderCdAM2"] = cd_rider * r["riderAreaM2"]
    r["bikeCdAM2"] = k_bike * r["bikeCdABuildUpM2"]
    r["systemCdAM2"] = r["riderCdAM2"] + r["bikeCdAM2"]
    r.update(road(v, r["systemCdAM2"]))
    r["timeFor40kmAt250W"] = 40 / r["speedAt250WKmh"] * 60
results["calibration"] = {"riderCd": cd_rider, "bikeInterferenceFactor": k_bike, "source": "Defraeye et al. 2010, J Biomech 43:1262"}
json.dump(results, open("aero_results.json", "w"), indent=1)
for v in VARIANTS:
    r = results[v]
    print(f"{v:9s} A_bike {r['bikeAreaM2']:.4f}  CdA_bike {r['bikeCdAM2']:.4f}  A_rider {r['riderAreaM2']:.4f}  CdA_sys {r['systemCdAM2']:.4f}"
          f"  P40 {r['powerAt40kmhW']:.1f} W  v250 {r['speedAt250WKmh']:.2f} km/h  40km {r['timeFor40kmAt250W']:.2f} min")
print("calibration", results["calibration"])
