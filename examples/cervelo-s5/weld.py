"""Weld each weld group (frame, fork, stem) into one solid with filleted joints, one piece at a time, on the exact OCC kernel.

Every join tries blend_union with decreasing fillet radii and falls back to a plain boolean union, so the part is always one
solid. Usage: python3 weld.py <doc.llull.json | server URL> <name.run.json> <name.parts.json>  -> name.welds.json {group: {id, joints}}"""

import json
import subprocess
import sys
import time
from pathlib import Path

LLULL = ["node", str(Path(__file__).resolve().parents[2] / "server" / "bin" / "llull.cjs")]
RADII = {"frame": [8, 6, 4.5, 3, 2], "fork": [6, 4.5, 3, 2], "stem": [5, 3.5, 2.5, 1.5]}


def call(doc, command, params):
    """doc: a document file (local OCC run) or an http(s) URL of a llull server running LLULL_KERNEL=occt (warm shape cache)."""
    target = ["--server", doc, "--timeout", "900"] if doc.startswith("http") else ["--doc", doc, "--kernel", "occt"]
    out = subprocess.run(LLULL + [command, json.dumps(params), *target, "--json"], capture_output=True, text=True)
    try:
        report = json.loads(out.stdout)
    except json.JSONDecodeError:
        return {"ok": False, "affected": [], "summary": out.stderr[-400:]}
    return report


def main(doc, run_path, parts_path):
    actions = json.load(open(run_path.replace(".run.json", ".plan.json")))["actions"]
    steps = json.load(open(run_path))["data"]["steps"]
    parts = json.load(open(parts_path))
    ids = {a["as"]: s["affected"][0] for a, s in zip(actions, steps) if s.get("affected")}
    groups = {}
    for alias, info in parts.items():
        if info.get("weld"):
            groups.setdefault(info["weld"], []).append(ids[alias])
    result = {}

    def weld_chain(group, members):
        current, joints = members[0], []
        for nxt in members[1:]:
            t0 = time.time()
            done = None
            for r in RADII[group]:
                rep = call(doc, "blend_union", {"ids": [current, nxt], "radius": r})
                if rep.get("affected"):
                    done = ("blend", r, rep["affected"][0])
                    break
            if done is None:
                rep = call(doc, "boolean", {"op": "union", "a": current, "b": nxt})
                done = ("union", 0, rep["affected"][0]) if rep.get("affected") else ("failed", 0, current)
            if done[0] != "failed":
                current = done[2]
            joints.append({"with": nxt, "kind": done[0], "radius": done[1], "seconds": round(time.time() - t0, 1)})
            print(f"{group}: + {nxt} -> {done[0]} r={done[1]} ({joints[-1]['seconds']} s)", flush=True)
        return current, joints

    # "frame/1", "frame/2", ...: weld each stage on its own (small B-reps), then the stage results into one part
    stages = {}
    for tag, members in groups.items():
        name, _, stage = tag.partition("/")
        stages.setdefault(name, []).append((stage, members))
    for name, parts_of in stages.items():
        heads, all_joints = [], []
        for stage, members in sorted(parts_of):
            head, joints = weld_chain(name, members)
            heads.append(head)
            all_joints += joints
        final, joints = weld_chain(name, heads)
        result[name] = {"id": final, "members": [m for _, ms in parts_of for m in ms], "joints": all_joints + joints}
    json.dump(result, open(run_path.replace(".run.json", ".welds.json"), "w"), indent=1)


if __name__ == "__main__":
    main(*sys.argv[1:4])
