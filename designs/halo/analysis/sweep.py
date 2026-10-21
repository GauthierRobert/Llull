#!/usr/bin/env python3
"""HALO design sweep: every variant is rebuilt by llull from halo_v3.lld (apply_design set={...}), all its design
checks must pass, then it is scored with halo_sizing.py (llull mass / CG / inertia) and llull's VLM static margin.

    python3 designs/halo/analysis/sweep.py [out.json]
"""
import itertools
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
LLULL = ["node", str(REPO / "server/bin/llull.cjs"), "--kernel", "manifold"]
WORK = Path("/tmp/halo_sweep")
sys.path.insert(0, str(HERE))
import halo_sizing  # noqa: E402

STRUT_TOP = 22.0  # ringTe + 12
STRUT_CHORD = 24.0
RING_LE = 215.0


def flap_cl_max(cf_c: float) -> float:
    """Plain-flap maximum lift increment on the whole vane (NACA TR-938 / Abbott & von Doenhoff trend, linearised)."""
    return min(0.95, 0.45 + 0.6 * cf_c)


def run(variant: dict) -> dict:
    WORK.mkdir(exist_ok=True)
    doc = WORK / ("v_" + "_".join(f"{k}{v}" for k, v in variant.items()) + ".json")
    doc.unlink(missing_ok=True)
    out = subprocess.run([*LLULL, "apply_design", "source=@text:" + str(HERE.parent / "halo_v3.lld"), "set=" + json.dumps(variant), "--doc", str(doc), "--json"], capture_output=True, text=True, cwd=REPO)
    applied = json.loads(out.stdout)
    checks = applied.get("data", {}).get("checks", [])
    failed = [f"line {c['line']} {c['metric']}" for c in checks if not c["pass"]]
    flap = variant.get("flapChord", 50.0)
    chord = variant.get("ringChord", 170.0)
    throat = RING_LE - 0.098 * chord
    geo = {
        "ringLe": RING_LE, "ringChord": chord, "sigma": 1.2, "loopTipR": throat - 3, "bellR": 32.5, "loopChord": 24, "loopsUpper": 3, "loopsLower": 4,
        "vaneChord": STRUT_CHORD + 1 + flap, "vaneSpan": throat - 3 - 45, "vaneClMax": flap_cl_max(flap / (STRUT_CHORD + 1 + flap)),
        "vaneAxisFactor": 4.83, "vaneCpZ": STRUT_TOP - STRUT_CHORD - 1 - 0.35 * flap, "cd0": 0.052 * (chord / 170) ** 0.1, "spanEfficiency": 2.0,
    }
    sized = halo_sizing.size(geo, halo_sizing.assembly(str(doc)))
    ring_top = 10 + chord
    cg_x = ring_top - sized["cgMm"][2]
    vlm = subprocess.run(["python3", str(HERE / "make_vlm.py"), str(RING_LE), str(chord), str(ring_top - STRUT_TOP), str(geo["vaneChord"]), str(geo["vaneSpan"] + 45), str(cg_x)], capture_output=True, text=True).stdout
    vlm_path = WORK / "vlm.json"
    vlm_path.write_text(vlm)
    vlm_out = json.loads(subprocess.run([*LLULL, "analyze_vortex_lattice", "@" + str(vlm_path), "--json"], capture_output=True, text=True, cwd=REPO).stdout)
    return {
        "variant": variant,
        "checksFailed": failed,
        "massKg": sized["massKg"],
        "staticMargin": vlm_out["data"]["neutralPoint"]["staticMargin"],
        "crosswindLimitMs": sized["control"]["crosswindLimitMs"],
        "pitchAccelRadS2": sized["control"]["maxAngularAccelNoWindRadS2"],
        "hoverPowerW": sized["hover"]["electricalPowerW"],
        "enduranceMin": sized["hover"]["enduranceMin"],
        "cruise25PowerW": sized["cruise"]["25"]["powerW"],
        "range25Km": sized["cruise"]["25"]["rangeKm"],
    }


def main() -> None:
    results = []
    for flap, chord in itertools.product((50, 65, 80), (150, 170)):
        r = run({"flapChord": flap, "ringChord": chord})
        results.append(r)
        print(json.dumps(r), flush=True)
    if len(sys.argv) > 1:
        Path(sys.argv[1]).write_text(json.dumps(results, indent=1) + "\n")


if __name__ == "__main__":
    main()
