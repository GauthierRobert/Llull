#!/usr/bin/env python3
"""Reference derivation for the 05 ISO validation pack (stdlib only, no network).

Reads a PCF (Piping Component File) and prints, as JSON, the values used as expected results in
expected_results.json: component counts, total pipe length, connectivity, weld list with numbers,
spools split on field welds, cut list and per-iso BOM, plus a write -> re-read round trip and the
isometric projection of the plant axes with llull's `iso` view frame.

It implements only the PCF subset written by `iso-01-L101-dn100.pcf` (see TECHNICAL_SPEC §6.1). It is
a cross-check of the TypeScript implementation, not a product parser.

Usage: python3 -I pcf_reference_parse.py iso-01-L101-dn100.pcf [--weld-gap MM] [--field-fit-allowance MM]
"""

import json
import math
import sys
from collections import OrderedDict

POINT_KEYS = ("END-POINT", "CENTRE-POINT", "BRANCH1-POINT", "CO-ORDS")
FIELD_WELD_SKEYS = {"WS", "WF"}  # site weld, field-fitted weld (AVEVA ISODRAFT weld SKEYs, sources.md S6)


def parse(text):
    header, pipeline, components, materials = OrderedDict(), OrderedDict(), [], OrderedDict()
    section, current, item = "header", None, None
    for raw in text.splitlines():
        if not raw.strip():
            continue
        if "\t" in raw:
            raise ValueError("PCF_TAB_CHARACTER")
        indented = raw.startswith(" ")
        words = raw.split()
        key, rest = words[0], words[1:]
        if not indented:
            if key == "PIPELINE-REFERENCE":
                section, pipeline["PIPELINE-REFERENCE"] = "pipeline", " ".join(rest)
            elif key == "MATERIALS":
                section = "materials"
            elif section == "materials" and key == "ITEM-CODE":
                item = " ".join(rest)
                materials[item] = OrderedDict()
            elif section == "header" and key.startswith(("ISOGEN-FILES", "UNITS-")):
                header[key] = " ".join(rest)
            else:
                section = "components"
                current = {"type": key, "ends": [], "attributes": OrderedDict()}
                components.append(current)
            continue
        if section == "pipeline":
            pipeline[key] = " ".join(rest)
        elif section == "materials":
            materials[item][key] = " ".join(rest)
        elif section == "components":
            if key in POINT_KEYS:
                xyz = [float(v) for v in rest[:3]]
                bore = float(rest[3]) if len(rest) > 3 else None
                end_type = rest[4] if len(rest) > 4 else None
                entry = {"key": key, "xyz": xyz, "bore": bore, "endType": end_type}
                if key == "END-POINT":
                    current["ends"].append(entry)
                else:
                    current[key] = entry
            else:
                current["attributes"][key] = " ".join(rest) if rest else True
    return {"header": header, "pipeline": pipeline, "components": components, "materials": materials}


def fmt(v):
    return f"{v:.1f}"


def write(model):
    lines = [f"{k} {v}" for k, v in model["header"].items()]
    lines.append(f"PIPELINE-REFERENCE {model['pipeline']['PIPELINE-REFERENCE']}")
    lines += [f"    {k} {v}" for k, v in model["pipeline"].items() if k != "PIPELINE-REFERENCE"]
    for c in model["components"]:
        lines.append(c["type"])
        attrs = c["attributes"]
        if "COMPONENT-IDENTIFIER" in attrs:
            lines.append(f"    COMPONENT-IDENTIFIER {attrs['COMPONENT-IDENTIFIER']}")
        for p in c["ends"] + [c[k] for k in ("CENTRE-POINT", "BRANCH1-POINT", "CO-ORDS") if k in c]:
            tail = "".join(f" {x}" for x in ((fmt(p["bore"]).rstrip("0").rstrip(".") if p["bore"] is not None else None), p["endType"]) if x)
            lines.append(f"    {p['key']} {' '.join(fmt(v) for v in p['xyz'])}{tail}")
        for k, v in attrs.items():
            if k != "COMPONENT-IDENTIFIER":
                lines.append(f"    {k}" if v is True else f"    {k} {v}")
    lines.append("MATERIALS")
    for code, fields in model["materials"].items():
        lines.append(f"ITEM-CODE {code}")
        lines += [f"    {k} {v}" for k, v in fields.items()]
    return "\n".join(lines) + "\n"


def dist(a, b):
    return math.dist(a, b)


def node_key(xyz):
    return tuple(round(v, 1) for v in xyz)


def connection_points(c):
    pts = [e for e in c["ends"]]
    if "BRANCH1-POINT" in c:
        pts.append(c["BRANCH1-POINT"])
    return pts


def analyse(model, weld_gap=0.0, field_fit_allowance=0.0):
    comps = model["components"]
    counts = OrderedDict()
    for c in comps:
        counts[c["type"]] = counts.get(c["type"], 0) + 1
    pipes = [c for c in comps if c["type"] == "PIPE"]
    pipe_lengths = [dist(p["ends"][0]["xyz"], p["ends"][1]["xyz"]) for p in pipes]

    # nodes: coordinate -> list of (component index, point)
    nodes = OrderedDict()
    for i, c in enumerate(comps):
        for p in connection_points(c):
            nodes.setdefault(node_key(p["xyz"]), []).append((i, p))

    # joints
    joints = OrderedDict()
    for key, members in nodes.items():
        idx = sorted({i for i, _ in members})
        welds = [i for i in idx if comps[i]["type"] == "WELD"]
        others = [i for i in idx if comps[i]["type"] != "WELD"]
        if welds:
            skey = comps[welds[0]]["attributes"].get("SKEY")
            joints[key] = {"kind": "field" if skey in FIELD_WELD_SKEYS else "shop", "skey": skey, "components": others}
        elif len(others) >= 2 and all(p["endType"] == "BW" for _, p in members):
            joints[key] = {"kind": "shop", "skey": None, "components": others}
        elif len(others) == 1:
            joints[key] = {"kind": "terminal", "endType": members[0][1]["endType"], "components": others}
        else:
            joints[key] = {"kind": "other", "components": others}

    # traversal order: depth first from component 0, main run (END-POINT 2) before BRANCH1-POINT
    real = [i for i, c in enumerate(comps) if c["type"] != "WELD"]
    adjacency = {i: [] for i in real}
    for key, j in joints.items():
        if j["kind"] in ("shop", "field"):
            for a in j["components"]:
                for b in j["components"]:
                    if a != b:
                        adjacency[a].append((key, b))

    def exits(i):
        return [node_key(p["xyz"]) for p in connection_points(comps[i])]

    order_welds, order_comps, seen = [], [], set()

    def visit(i):
        seen.add(i)
        order_comps.append(i)
        for key in exits(i):
            j = joints[key]
            if j["kind"] in ("shop", "field") and key not in order_welds:
                order_welds.append(key)
            for k2, b in adjacency[i]:
                if k2 == key and b not in seen:
                    visit(b)

    visit(real[0])
    weld_list = []
    for n, key in enumerate(order_welds, start=1):
        j = joints[key]
        weld_list.append({"number": f"W{n}", "kind": j["kind"], "at": list(key), "components": [comps[i]["attributes"]["COMPONENT-IDENTIFIER"] for i in j["components"]]})

    # spools: union over shop joints only
    parent = {i: i for i in real}

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for key, j in joints.items():
        if j["kind"] == "shop":
            first = j["components"][0]
            for other in j["components"][1:]:
                parent[find(other)] = find(first)
    spool_of, spools = {}, []
    for i in order_comps:
        root = find(i)
        if root not in spool_of:
            spool_of[root] = len(spools) + 1
            spools.append([])
        spools[spool_of[root] - 1].append(i)

    ref = model["pipeline"]["PIPELINE-REFERENCE"]
    spool_rows, cut_list = [], []
    for n, members in enumerate(spools, start=1):
        name = f"{ref}-SP{n:02d}"
        spool_rows.append({"spool": name, "components": [comps[i]["attributes"]["COMPONENT-IDENTIFIER"] for i in members]})
        for i in members:
            c = comps[i]
            if c["type"] != "PIPE":
                continue
            length = dist(c["ends"][0]["xyz"], c["ends"][1]["xyz"])
            adjust = 0.0
            for e in c["ends"]:
                j = joints[node_key(e["xyz"])]
                if j["kind"] in ("shop", "field"):
                    adjust -= weld_gap / 2.0
                if j["kind"] == "field" and j.get("skey") == "WF":
                    adjust += field_fit_allowance
            cut_list.append({"piece": f"{name}-P{len([r for r in cut_list if r['piece'].startswith(name)]) + 1}", "componentId": c["attributes"]["COMPONENT-IDENTIFIER"], "centrelineLengthMm": round(length, 3), "cutLengthMm": round(length + adjust, 3)})

    bom = OrderedDict()
    for c in comps:
        code = c["attributes"].get("ITEM-CODE")
        if code is None:
            continue
        row = bom.setdefault(code, {"itemCode": code, "type": c["type"], "quantity": 0.0, "unit": "m" if c["type"] == "PIPE" else "ea", "description": model["materials"].get(code, {}).get("DESCRIPTION")})
        row["quantity"] += dist(c["ends"][0]["xyz"], c["ends"][1]["xyz"]) / 1000.0 if c["type"] == "PIPE" else 1
    for row in bom.values():
        row["quantity"] = round(row["quantity"], 6)

    return {
        "componentCount": len(comps),
        "countsByType": counts,
        "pipePieces": len(pipes),
        "totalPipeLengthMm": round(sum(pipe_lengths), 6),
        "pipeLengthsMm": [round(v, 6) for v in pipe_lengths],
        "welds": weld_list,
        "shopWelds": sum(1 for w in weld_list if w["kind"] == "shop"),
        "fieldWelds": sum(1 for w in weld_list if w["kind"] == "field"),
        "terminals": [{"at": list(k), "endType": j["endType"]} for k, j in joints.items() if j["kind"] == "terminal"],
        "spools": spool_rows,
        "cutList": cut_list,
        "bom": list(bom.values()),
    }


def iso_axes():
    def unit(v):
        n = math.sqrt(sum(a * a for a in v))
        return [a / n for a in v]

    def cross(a, b):
        return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

    right = unit([1, 1, 0])
    up = unit(cross(unit([1, -1, 1]), right))  # packages/core/src/geometry/viewDirections.ts AXES.iso
    out = OrderedDict()
    for name, v in (("east+X", [1, 0, 0]), ("north+Y", [0, 1, 0]), ("up+Z", [0, 0, 1])):
        p = [sum(a * b for a, b in zip(v, right)), sum(a * b for a, b in zip(v, up))]
        out[name] = {"angleDeg": round(math.degrees(math.atan2(p[1], p[0])), 9), "scale": round(math.hypot(*p), 12)}
    return out


def main(argv):
    path = argv[1]
    gap = float(argv[argv.index("--weld-gap") + 1]) if "--weld-gap" in argv else 0.0
    ffa = float(argv[argv.index("--field-fit-allowance") + 1]) if "--field-fit-allowance" in argv else 0.0
    with open(path, encoding="ascii") as handle:
        text = handle.read()
    model = parse(text)
    result = analyse(model, gap, ffa)
    rewritten = write(model)
    again = parse(rewritten)
    result["roundTrip"] = {"modelEqual": again == model, "analysisEqual": analyse(again, gap, ffa) == result, "rewrittenEqualsSource": rewritten == text}
    result["isoAxes"] = iso_axes()
    json.dump(result, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main(sys.argv)
