"""Analytic geometric-validation-property (GVP) ground truth for XCH round-trip cases.

For each reference part this script computes volume, surface area, centroid and axis-aligned bounding
box in closed form (formulas in the 'derivation' field), and writes:
  analytic_gvp_reference.json   expected values + tolerance + derivation (VC-XCH-01..04, 12)
  analytic_gvp_reference.csv    same numbers, one row per part
  plans/<id>.json               llull build_project plan that builds the part (draft, mm document)

Formulas (standard solid geometry):
  box a*b*c:           V = abc, A = 2(ab+bc+ca), centroid = box centre
  cylinder r,h:        V = pi r^2 h, A = 2 pi r^2 + 2 pi r h
  sphere r:            V = 4/3 pi r^3, A = 4 pi r^2
  torus R,r (R>r):     V = 2 pi^2 R r^2, A = 4 pi^2 R r   (Pappus-Guldinus)
  through hole r in plate thickness t: removes pi r^2 t of volume, removes 2 pi r^2 of cap area,
                       adds the bore wall 2 pi r t
  composite centroid:  c = sum(V_i c_i) / sum(V_i) (signed volumes for removed material)

Tolerances: relative 1e-6 on V and A, absolute 1e-6 * bbox diagonal on the centroid, for an exact B-rep
kernel (OCC BRepGProp) evaluating the same analytic surfaces; see validation/README.md for the policy.

Usage: python3 -I generate_analytic_gvp.py <output-dir>
"""

import csv
import json
import math
import os
import sys

PI = math.pi
REL_TOL = 1e-6


def box_part(pid, size, centre, title):
    a, b, c = size
    return {
        "id": pid,
        "title": title,
        "volume": a * b * c,
        "area": 2 * (a * b + b * c + c * a),
        "centroid": list(centre),
        "bbox": [centre[i] - size[i] / 2 for i in range(3)] + [centre[i] + size[i] / 2 for i in range(3)],
        "derivation": f"box {a}x{b}x{c}: V=abc, A=2(ab+bc+ca), centroid=centre",
        "plan": [{"command": "set_units", "params": {"units": "mm"}},
                 {"command": "add_box", "params": {"size": list(size), "position": list(centre)}, "as": "part"},
                 {"command": "set_entity_name", "params": {"id": "$part", "name": pid}}],
    }


def cylinder_part(pid, r, h, centre):
    return {
        "id": pid,
        "title": f"cylinder r={r} h={h}, axis +Z",
        "volume": PI * r * r * h,
        "area": 2 * PI * r * r + 2 * PI * r * h,
        "centroid": list(centre),
        "bbox": [centre[0] - r, centre[1] - r, centre[2] - h / 2, centre[0] + r, centre[1] + r, centre[2] + h / 2],
        "derivation": "V=pi r^2 h, A=2 pi r^2 + 2 pi r h",
        "plan": [{"command": "set_units", "params": {"units": "mm"}},
                 {"command": "add_cylinder", "params": {"radius": r, "height": h, "position": list(centre)}, "as": "part"},
                 {"command": "set_entity_name", "params": {"id": "$part", "name": pid}}],
    }


def sphere_part(pid, r, centre):
    return {
        "id": pid,
        "title": f"sphere r={r} off-origin",
        "volume": 4.0 / 3.0 * PI * r ** 3,
        "area": 4 * PI * r * r,
        "centroid": list(centre),
        "bbox": [c - r for c in centre] + [c + r for c in centre],
        "derivation": "V=4/3 pi r^3, A=4 pi r^2",
        "plan": [{"command": "set_units", "params": {"units": "mm"}},
                 {"command": "add_sphere", "params": {"radius": r, "position": list(centre)}, "as": "part"},
                 {"command": "set_entity_name", "params": {"id": "$part", "name": pid}}],
    }


def torus_part(pid, big, small):
    return {
        "id": pid,
        "title": f"torus R={big} r={small} in XY plane",
        "volume": 2 * PI * PI * big * small * small,
        "area": 4 * PI * PI * big * small,
        "centroid": [0.0, 0.0, 0.0],
        "bbox": [-(big + small), -(big + small), -small, big + small, big + small, small],
        "derivation": "Pappus: V=2 pi^2 R r^2, A=4 pi^2 R r",
        "plan": [{"command": "set_units", "params": {"units": "mm"}},
                 {"command": "add_torus", "params": {"ringRadius": big, "tubeRadius": small}, "as": "part"},
                 {"command": "set_entity_name", "params": {"id": "$part", "name": pid}}],
    }


def drilled_plate(pid, size, r, hole_x):
    a, b, t = size
    v_box, v_hole = a * b * t, PI * r * r * t
    volume = v_box - v_hole
    area = 2 * (a * b + b * t + t * a) - 2 * PI * r * r + 2 * PI * r * t
    cx = (v_box * 0.0 - v_hole * hole_x) / volume
    return {
        "id": pid,
        "title": f"plate {a}x{b}x{t} with through hole r={r} at x={hole_x}",
        "volume": volume,
        "area": area,
        "centroid": [cx, 0.0, 0.0],
        "bbox": [-a / 2, -b / 2, -t / 2, a / 2, b / 2, t / 2],
        "derivation": "V=abt - pi r^2 t; A=2(ab+bt+ta) - 2 pi r^2 + 2 pi r t; cx=-(pi r^2 t * x_hole)/V",
        "plan": [{"command": "set_units", "params": {"units": "mm"}},
                 {"command": "add_box", "params": {"size": [a, b, t]}, "as": "plate"},
                 {"command": "add_cylinder", "params": {"radius": r, "height": 2 * t, "position": [hole_x, 0, 0]}, "as": "tool"},
                 {"command": "boolean", "params": {"op": "subtract", "a": "$plate", "b": "$tool"}, "as": "part"},
                 {"command": "set_entity_name", "params": {"id": "$part", "name": pid}}],
    }


def l_bracket(pid):
    base, upright = (80.0, 40.0, 10.0), (10.0, 40.0, 60.0)
    vb, vu = base[0] * base[1] * base[2], upright[0] * upright[1] * upright[2]
    cb, cu = (40.0, 20.0, 5.0), (5.0, 20.0, 40.0)
    volume = vb + vu
    shared = upright[0] * upright[1]
    area = 2 * (80 * 40 + 80 * 10 + 40 * 10) + 2 * (10 * 40 + 10 * 60 + 40 * 60) - 2 * shared
    centroid = [(vb * cb[i] + vu * cu[i]) / volume for i in range(3)]
    return {
        "id": pid,
        "title": "L-bracket: base 80x40x10 + upright 10x40x60 (union, shared 10x40 face)",
        "volume": volume,
        "area": area,
        "centroid": centroid,
        "bbox": [0.0, 0.0, 0.0, 80.0, 40.0, 70.0],
        "derivation": "V=Vb+Vu; A=Ab+Au-2*(10*40) (shared face disappears); c=(Vb cb + Vu cu)/V",
        "plan": [{"command": "set_units", "params": {"units": "mm"}},
                 {"command": "add_box", "params": {"size": list(base), "anchor": "min", "position": [0, 0, 0]}, "as": "base"},
                 {"command": "add_box", "params": {"size": list(upright), "anchor": "min", "position": [0, 0, 10]}, "as": "up"},
                 {"command": "boolean", "params": {"op": "union", "a": "$base", "b": "$up"}, "as": "part"},
                 {"command": "set_entity_name", "params": {"id": "$part", "name": pid}}],
    }


def inch_box(pid):
    part = box_part(pid, (4.0, 2.0, 1.0), (0.0, 0.0, 0.5), "box 4x2x1 in, inch document (unit-conversion check)")
    part["plan"][0] = {"command": "set_units", "params": {"units": "in"}}
    part["unit"] = "in"
    part["derivation"] += "; in mm: V*25.4^3, A*25.4^2, lengths*25.4 (25.4 mm/in exact by definition)"
    part["mmEquivalent"] = {"volume": part["volume"] * 25.4 ** 3, "area": part["area"] * 25.4 ** 2,
                            "centroid": [c * 25.4 for c in part["centroid"]]}
    return part


def assembly_two_boxes(pid):
    size, offsets = (20.0, 10.0, 5.0), [(0.0, 0.0, 0.0), (100.0, 0.0, 0.0)]
    v = size[0] * size[1] * size[2]
    return {
        "id": pid,
        "title": "assembly: one component (box 20x10x5) instanced twice at x=0 and x=100",
        "volume": 2 * v,
        "area": 2 * 2 * (20 * 10 + 10 * 5 + 5 * 20),
        "centroid": [50.0, 0.0, 0.0],
        "bbox": [-10.0, -5.0, -2.5, 110.0, 5.0, 2.5],
        "derivation": "assembly GVP (CAx-IF assembly validation properties): sum of instance volumes/areas, volume-weighted centroid; "
                      "instance count = 2 (one PRODUCT, two NEXT_ASSEMBLY_USAGE_OCCURRENCE)",
        "instanceCount": 2,
        "plan": [{"command": "set_units", "params": {"units": "mm"}},
                 {"command": "add_box", "params": {"size": list(size)}, "as": "b"},
                 {"command": "create_component", "params": {"name": "Block", "entityIds": ["$b"], "componentId": "comp-block"}, "as": "stray"},
                 {"command": "delete_entities", "params": {"ids": ["$stray"]}},
                 {"command": "insert_instance", "params": {"componentId": "comp-block", "position": list(offsets[0])}, "as": "i1"},
                 {"command": "insert_instance", "params": {"componentId": "comp-block", "position": list(offsets[1])}, "as": "i2"}],
    }


def parts():
    return [
        box_part("xch-box", (100.0, 60.0, 20.0), (0.0, 0.0, 0.0), "box 100x60x20 centred"),
        cylinder_part("xch-cylinder", 10.0, 40.0, (0.0, 0.0, 0.0)),
        sphere_part("xch-sphere-offset", 25.0, (10.0, 20.0, 30.0)),
        torus_part("xch-torus", 30.0, 5.0),
        drilled_plate("xch-plate-centre-hole", (100.0, 60.0, 20.0), 10.0, 0.0),
        drilled_plate("xch-plate-offset-hole", (100.0, 60.0, 20.0), 10.0, 25.0),
        l_bracket("xch-l-bracket"),
        inch_box("xch-inch-box"),
        assembly_two_boxes("xch-assembly-2x"),
    ]


def main(out_dir):
    os.makedirs(os.path.join(out_dir, "plans"), exist_ok=True)
    rows, cases = [], []
    for p in parts():
        diag = math.dist(p["bbox"][:3], p["bbox"][3:])
        case = {k: v for k, v in p.items() if k != "plan"}
        case.setdefault("unit", "mm")
        case["tolerance"] = {"volumeRel": REL_TOL, "areaRel": REL_TOL, "centroidAbs": REL_TOL * diag, "bboxAbs": REL_TOL * diag}
        case["plan"] = f"plans/{p['id']}.json"
        cases.append(case)
        with open(os.path.join(out_dir, "plans", f"{p['id']}.json"), "w") as fh:
            json.dump(p["plan"], fh, indent=1)
            fh.write("\n")
        rows.append([p["id"], case["unit"], repr(p["volume"]), repr(p["area"])] + [repr(c) for c in p["centroid"]])
    doc = {
        "$comment": "Generated by generate_analytic_gvp.py — do not edit by hand. Values are closed-form (see derivation).",
        "source": "analytic (derivation per case)",
        "cases": cases,
    }
    with open(os.path.join(out_dir, "analytic_gvp_reference.json"), "w") as fh:
        json.dump(doc, fh, indent=1)
        fh.write("\n")
    with open(os.path.join(out_dir, "analytic_gvp_reference.csv"), "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["id", "unit", "volume", "area", "cx", "cy", "cz"])
        w.writerows(rows)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__)))
