"""Aero measurements of the S5 with llull's read-only commands, on the un-welded pass-1 document (one solid per part).

Same method and the same calibration as ../bike/aero.py, so the S5 sits on one scale with the round-tube baseline and the
earlier aero concepts: per-part exposed frontal area (front-to-back accumulation of frontal_area), Hoerner strut / cylinder
drag coefficients at 40 km/h, rider Cd and bike interference factor from Defraeye et al. 2010 (taken from
../bike/aero_results.json), then road_load_power and aero_drag.

Usage: python3 aero.py s5.pass1.llull.json s5.pass1.run.json  -> s5.aero.json"""

import json
import math
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
LLULL = ["node", str(HERE.parents[1] / "server" / "bin" / "llull.cjs")]
RESOLUTION = 1500
RIDER_KG, BIKE_KG = 75.0, 7.6  # S5 Dura-Ace Di2 size 56, claimed ~7.6 kg
YAWS = [0, 5, 10, 15, 20]


def run(actions, doc):
    tmp = HERE / "_measure.json"
    tmp.write_text(json.dumps({"actions": actions}))
    out = subprocess.run(LLULL + ["run", str(tmp), "--doc", doc, "--dry-run", "--json", "--no-fit"], capture_output=True, text=True)
    tmp.unlink()
    report = json.loads(out.stdout)
    if not report.get("ok"):
        raise RuntimeError(report.get("summary"))
    return report["data"]["steps"]


def flow(yaw):
    a = math.radians(yaw)
    return [round(-math.cos(a), 6), round(-math.sin(a), 6), 0]


def main(doc, run_path):
    actions = json.load(open(HERE / "s5.plan.json"))["actions"]
    parts = json.load(open(HERE / "s5.parts.json"))
    report = json.load(open(run_path))["data"]
    bounds = {e["id"]: e["bounds"] for e in report["scene"]["entities"] if "bounds" in e}
    groups = {}
    for action, step in zip(actions, report["steps"]):
        alias = action.get("as")
        if alias not in parts:
            continue
        ids = [i for i in step["affected"] if i in bounds]
        if action["command"] == "array_polar":
            groups[action["params"]["id"].lstrip("$")]["ids"] += ids
            continue
        groups[alias] = {**parts[alias], "ids": ids}
    for g in groups.values():
        g["front_x"] = max(bounds[i]["max"][0] for i in g["ids"])
    bike = sorted((g for g in groups.values() if g["category"] != "rider"), key=lambda g: -g["front_x"])
    rider_ids = [i for g in groups.values() if g["category"] == "rider" for i in g["ids"]]
    bike_ids = [i for g in bike for i in g["ids"]]
    acts, acc = [], []
    for g in bike:
        acc = acc + g["ids"]
        acts.append({"command": "frontal_area", "params": {"entityIds": acc, "flowDirection": flow(0), "resolution": RESOLUTION}})
    for yaw in YAWS:
        acts.append({"command": "frontal_area", "params": {"entityIds": bike_ids, "flowDirection": flow(yaw), "resolution": RESOLUTION}})
        acts.append({"command": "frontal_area", "params": {"entityIds": bike_ids + rider_ids, "flowDirection": flow(yaw), "resolution": RESOLUTION}})
    acts.append({"command": "frontal_area", "params": {"entityIds": rider_ids, "flowDirection": flow(0), "resolution": RESOLUTION}})
    areas = [s["data"]["frontalAreaM2"] for s in run(acts, doc)]
    by_cat, prev = {}, 0.0
    for g, a in zip(bike, areas[: len(bike)]):
        c = by_cat.setdefault(g["category"], {"areaM2": 0.0, "cdaM2": 0.0})
        c["areaM2"] += a - prev
        c["cdaM2"] += (a - prev) * g["cd"]
        prev = a
    calib = json.load(open(HERE.parent / "bike" / "aero_results.json"))["calibration"]
    build_up = sum(c["cdaM2"] for c in by_cat.values())
    rider_area = areas[-1]
    res = {
        "bikeAreaM2": prev, "bikeCdABuildUpM2": build_up, "bikeCdAM2": build_up * calib["bikeInterferenceFactor"],
        "riderAreaM2": rider_area, "riderCdAM2": rider_area * calib["riderCd"], "byCategory": by_cat, "calibration": calib,
        "yaw": [{"yawDeg": y, "bikeAreaM2": areas[len(bike) + 2 * k], "systemAreaM2": areas[len(bike) + 2 * k + 1]} for k, y in enumerate(YAWS)],
    }
    res["systemCdAM2"] = res["riderCdAM2"] + res["bikeCdAM2"]
    mass = RIDER_KG + BIKE_KG
    at40, at250, drag = (s["data"] for s in run([
        {"command": "road_load_power", "params": {"vehicle": "bicycle", "massKg": mass, "cdA": res["systemCdAM2"], "speed": 40, "speedUnit": "km/h"}},
        {"command": "road_load_power", "params": {"vehicle": "bicycle", "massKg": mass, "cdA": res["systemCdAM2"], "powerW": 250}},
        {"command": "aero_drag", "params": {"cdA": res["systemCdAM2"], "speed": 40, "speedUnit": "km/h"}},
    ], doc))
    res.update({"massKg": mass, "powerAt40kmhW": at40["powerW"], "breakdownAt40kmh": at40["breakdown"], "speedAt250WKmh": at250["speedKmh"],
                "dragAt40kmhN": drag["dragN"], "timeFor40kmAt250W": 40 / at250["speedKmh"] * 60})
    # the same S5 bike with the rider in the "+ fit" position of the earlier study is not modelled here; the earlier versions:
    res["earlier"] = {k: {kk: v[kk] for kk in ("systemCdAM2", "bikeCdAM2", "riderCdAM2", "powerAt40kmhW", "speedAt250WKmh", "timeFor40kmAt250W")}
                      for k, v in json.load(open(HERE.parent / "bike" / "aero_results.json")).items() if k != "calibration"}
    json.dump(res, open(HERE / "s5.aero.json", "w"), indent=1)
    print(f"S5: A_bike {prev:.4f} CdA_bike {res['bikeCdAM2']:.4f} A_rider {rider_area:.4f} CdA_rider {res['riderCdAM2']:.4f} "
          f"CdA_sys {res['systemCdAM2']:.4f} P40 {res['powerAt40kmhW']:.1f} W v250 {res['speedAt250WKmh']:.2f} km/h")
    for c, v in sorted(by_cat.items(), key=lambda kv: -kv[1]["cdaM2"]):
        print(f"  {c:12s} A {v['areaM2'] * 1e4:6.1f} cm2  CdA {v['cdaM2'] * calib['bikeInterferenceFactor'] * 1e4:6.1f} cm2")


if __name__ == "__main__":
    main(*sys.argv[1:3])
