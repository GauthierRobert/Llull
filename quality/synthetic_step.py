"""Synthetic STEP cases for the import quality gate, each aimed at one known CAD failure mode.

Every case writes .cache/quality-corpus/<id>.step and <id>.expected.json with ANALYTIC ground truth
(plain maths / numpy, not OpenCascade), so the gate also catches errors that the llull bridge and
the OCCT reference would share (units, transforms, names):
  {"solids": int, "volume": float, "volumeTolerance": rel, "bbox": [6 floats, mm],
   "bboxTolerance": mm, "partNames": [str]}            (partNames: exact names a reader must keep)

The geometry itself is self-checked: after writing, the file is read back with plain OCCT and must
match the analytic solids / volume / bbox, otherwise the generator fails (a broken case is worse
than no case).

Usage: python3 quality/synthetic_step.py [case-id ...]       (default: every case)
"""

import json
import math
import os
import sys

import numpy as np
import cadquery as cq
from OCP.Interface import Interface_Static
from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, ".cache", "quality-corpus")
INCH = 25.4


def box_bbox(x0, y0, z0, dx, dy, dz):
    return [x0, y0, z0, x0 + dx, y0 + dy, z0 + dz]


def union_bbox(*boxes):
    return [min(b[i] for b in boxes) for i in range(3)] + [max(b[i] for b in boxes) for i in range(3, 6)]


def rotation(axis, degrees):
    """Rodrigues rotation matrix (right-handed, degrees)."""
    a = np.asarray(axis, float) / np.linalg.norm(axis)
    t = math.radians(degrees)
    k = np.array([[0, -a[2], a[1]], [a[2], 0, -a[0]], [-a[1], a[0], 0]])
    return np.eye(3) + math.sin(t) * k + (1 - math.cos(t)) * (k @ k)


def affine(axis, degrees, translation):
    """4x4 for x' = R x + t — the meaning of cq.Location(t, axis, degrees)."""
    m = np.eye(4)
    m[:3, :3] = rotation(axis, degrees)
    m[:3, 3] = translation
    return m


def save_assembly(assembly, path):
    assembly.export(path) if hasattr(assembly, "export") else assembly.save(path)


def write_shape(shape, path, unit="MM"):
    Interface_Static.SetCVal_s("write.step.unit", unit)
    try:
        writer = STEPControl_Writer()
        writer.Transfer(shape, STEPControl_AsIs)
        writer.Write(path)
    finally:
        Interface_Static.SetCVal_s("write.step.unit", "MM")


# --------------------------------------------------------------------------- cases


def chiral_pair(path):
    """A bracket and its MIRRORED copy: mirroring reverses face orientation (winding, volume sign)."""
    bracket = cq.Workplane().box(30, 10, 5, centered=False).cut(
        cq.Workplane().cylinder(5, 2, centered=(True, True, False)).translate((8, 5, 0))
    )
    mirrored = bracket.mirror("YZ")
    assembly = cq.Assembly(name="chiral-pair")
    assembly.add(bracket, name="bracket-right", color=cq.Color("red"))
    assembly.add(mirrored, name="bracket-left", color=cq.Color("blue"))
    save_assembly(assembly, path)
    volume = 30 * 10 * 5 - math.pi * 4 * 5
    return {"solids": 2, "volume": 2 * volume, "bbox": [-30, 0, 0, 30, 10, 5],
            "partNames": ["bracket-right", "bracket-left"]}


def inch_units(path):
    """A 1 x 2 x 3 in block written in INCH: the reader must convert to millimetres."""
    write_shape(cq.Workplane().box(INCH, 2 * INCH, 3 * INCH, centered=False).val().wrapped, path, "INCH")
    return {"solids": 1, "volume": 6 * INCH ** 3, "bbox": box_bbox(0, 0, 0, INCH, 2 * INCH, 3 * INCH)}


def hollow_cavity(path):
    """A cube with a sealed spherical void: two shells in one solid, the inner one inward-facing."""
    solid = cq.Workplane().box(40, 40, 40).cut(cq.Workplane().sphere(10))
    write_shape(solid.val().wrapped, path)
    return {"solids": 1, "volume": 40 ** 3 - 4 / 3 * math.pi * 10 ** 3, "bbox": [-20] * 3 + [20] * 3}


def skew_nested_assembly(path):
    """A leaf box three assembly levels deep, each level rotated about a skew axis and moved."""
    levels = [((100, 0, 0), (1, 2, 3), 37.0), ((0, 50, -20), (0, 1, 1), -61.0), ((5, 5, 5), (1, 0, 0), 90.0)]
    leaf = cq.Workplane().box(10, 20, 30, centered=False)
    inner = cq.Assembly(name="level-3").add(leaf, name="leaf", loc=cq.Location(cq.Vector(*levels[2][0]), cq.Vector(*levels[2][1]), levels[2][2]))
    middle = cq.Assembly(name="level-2").add(inner, name="level-3", loc=cq.Location(cq.Vector(*levels[1][0]), cq.Vector(*levels[1][1]), levels[1][2]))
    root = cq.Assembly(name="skew-nested")
    root.add(middle, name="level-2", loc=cq.Location(cq.Vector(*levels[0][0]), cq.Vector(*levels[0][1]), levels[0][2]))
    root.add(cq.Workplane().box(10, 20, 30, centered=False), name="reference-leaf")
    save_assembly(root, path)
    world = np.eye(4)
    for translation, axis, degrees in levels:
        world = world @ affine(axis, degrees, translation)
    corners = np.array([[x, y, z, 1] for x in (0, 10) for y in (0, 20) for z in (0, 30)]) @ world.T
    leaf_box = list(corners[:, :3].min(0)) + list(corners[:, :3].max(0))
    return {"solids": 2, "volume": 2 * 6000, "bbox": union_bbox(leaf_box, box_bbox(0, 0, 0, 10, 20, 30)),
            "partNames": ["leaf", "reference-leaf"]}


def far_from_origin(path):
    """Parts a thousand kilometres from the origin: float32 rendering and floating-origin precision."""
    x, y, z = 1.0e6, -2.0e6, 5.0e5
    cylinder = cq.Workplane().cylinder(40, 10, centered=(True, True, False)).translate((x, y, z))
    block = cq.Workplane().box(20, 20, 20, centered=False).translate((x + 50, y - 10, z))
    assembly = cq.Assembly(name="far-away")
    assembly.add(cylinder, name="far-cylinder")
    assembly.add(block, name="far-block")
    save_assembly(assembly, path)
    return {"solids": 2, "volume": math.pi * 100 * 40 + 8000,
            "bbox": union_bbox([x - 10, y - 10, z, x + 10, y + 10, z + 40], box_bbox(x + 50, y - 10, z, 20, 20, 20))}


def micro_part(path):
    """A 0.5 mm pin: a fixed 0.05 mm chord tolerance is 20 % of its radius."""
    write_shape(cq.Workplane().cylinder(0.5, 0.25, centered=(True, True, False)).val().wrapped, path)
    return {"solids": 1, "volume": math.pi * 0.25 ** 2 * 0.5, "bbox": [-0.25, -0.25, 0, 0.25, 0.25, 0.5]}


def huge_sphere(path):
    """A 10 m radius dome: a fixed 0.05 mm chord tolerance means millions of triangles."""
    write_shape(cq.Workplane().sphere(10000).val().wrapped, path)
    return {"solids": 1, "volume": 4 / 3 * math.pi * 1e12, "bbox": [-1e4] * 3 + [1e4] * 3}


def bolt_grid(path):
    """400 instances of one bolt, each with its own rotation + translation (shared geometry)."""
    head = cq.Workplane().polygon(6, 13).extrude(5)
    bolt = head.union(cq.Workplane().circle(4).extrude(-30))
    prototype_box = bolt.val().BoundingBox()
    assembly = cq.Assembly(name="bolt-grid")
    for i in range(20):
        for j in range(20):
            spin = 60.0 * ((i + j) % 6)  # hexagon symmetry: every instance keeps the same bbox
            assembly.add(bolt, name=f"bolt-{i:02d}-{j:02d}",
                         loc=cq.Location(cq.Vector(30 * i, 30 * j, 0), cq.Vector(0, 0, 1), spin))
    save_assembly(assembly, path)
    side = 13 / 2
    volume = 3 * math.sqrt(3) / 2 * side ** 2 * 5 + math.pi * 16 * 30
    b = prototype_box
    return {"solids": 400, "volume": 400 * volume,
            "bbox": [b.xmin, b.ymin, b.zmin, b.xmax + 570, b.ymax + 570, b.zmax]}


def step_string(text):
    """ISO 10303-21 string encoding: non-ASCII runs as \\X2\\<UCS-2 hex>\\X0\\ (the file stays ASCII)."""
    out, run = [], []
    for char in text + "\0":
        if char != "\0" and ord(char) > 126:
            run.append("%04X" % ord(char))
            continue
        if run:
            out.append("\\X2\\" + "".join(run) + "\\X0\\")
            run = []
        if char != "\0":
            out.append(char)
    return "".join(out)


def unicode_names(path):
    """Non-ASCII product names, correctly \\X2\\-encoded (writers often double-encode UTF-8 instead)."""
    names = ["Ø20 Welle", "支架-01", "pièce éàü"]
    assembly = cq.Assembly(name="unicode-assembly")
    for index in range(len(names)):
        assembly.add(cq.Workplane().box(10, 10, 10, centered=False).translate((15 * index, 0, 0)),
                     name="UNICODE-NAME-%d" % index, color=cq.Color(0.2 + 0.3 * index, 0.5, 0.8 - 0.3 * index))
    save_assembly(assembly, path)
    with open(path, encoding="ascii") as handle:
        text = handle.read()
    for index, name in enumerate(names):
        text = text.replace("UNICODE-NAME-%d" % index, step_string(name))
    with open(path, "w", encoding="ascii") as handle:
        handle.write(text)
    return {"solids": 3, "volume": 3000, "bbox": [0, 0, 0, 40, 10, 10], "partNames": names}


def perforated_plate(path):
    """A 0.5 mm plate with 100 through holes: thin walls and genus 100."""
    plate = cq.Workplane().box(200, 200, 0.5, centered=False)
    holes = cq.Workplane().pushPoints([(10 + 20 * i, 10 + 20 * j) for i in range(10) for j in range(10)]).circle(4).extrude(0.5)
    write_shape(plate.cut(holes).val().wrapped, path)
    return {"solids": 1, "volume": 200 * 200 * 0.5 - 100 * math.pi * 16 * 0.5, "bbox": [0, 0, 0, 200, 200, 0.5]}


def helical_spring(path):
    """A 1 mm wire swept along a 10-turn helix: free-form sweep surfaces, long and thin."""
    helix = cq.Wire.makeHelix(pitch=5, height=50, radius=10)
    start = helix.startPoint()
    tangent = helix.tangentAt(0)
    profile = cq.Workplane(cq.Plane(origin=start, xDir=cq.Vector(0, 0, 1).cross(tangent), normal=tangent)).circle(1)
    spring = profile.sweep(cq.Workplane().add(helix), isFrenet=True)
    write_shape(spring.val().wrapped, path)
    length = 10 * math.hypot(2 * math.pi * 10, 5)
    return {"solids": 1, "volume": math.pi * length, "volumeTolerance": 0.02,
            "bbox": [-11, -11, -1, 11, 11, 51], "bboxTolerance": 1.0}


def face_colors(path):
    """One solid whose six faces each carry their own colour (XDE surface colours, no part colour)."""
    cube = cq.Workplane().box(20, 20, 20)
    assembly = cq.Assembly(name="rainbow")
    assembly.add(cube, name="rainbow-cube")
    node = assembly.objects["rainbow-cube"]
    palette = [(1, 0, 0), (0, 1, 0), (0, 0, 1), (1, 1, 0), (0, 1, 1), (1, 0, 1)]
    for face, rgb in zip(cube.faces().vals(), palette):
        node.addSubshape(face, color=cq.Color(*rgb))
    save_assembly(assembly, path)
    return {"solids": 1, "volume": 8000, "bbox": [-10] * 3 + [10] * 3}


CASES = {
    "syn-chiral-pair": chiral_pair,
    "syn-inch-units": inch_units,
    "syn-hollow-cavity": hollow_cavity,
    "syn-skew-nested": skew_nested_assembly,
    "syn-far-from-origin": far_from_origin,
    "syn-micro-part": micro_part,
    "syn-huge-sphere": huge_sphere,
    "syn-bolt-grid": bolt_grid,
    "syn-unicode-names": unicode_names,
    "syn-perforated-plate": perforated_plate,
    "syn-helical-spring": helical_spring,
    "syn-face-colors": face_colors,
}


def readback(path):
    """Plain-OCCT solids / volume / bbox of the written file (generator self-check)."""
    shape = cq.importers.importStep(path)
    solids = cq.Compound.makeCompound(shape.vals()).Solids()
    box = cq.Compound.makeCompound(solids).BoundingBox()
    return len(solids), sum(s.Volume() for s in solids), [box.xmin, box.ymin, box.zmin, box.xmax, box.ymax, box.zmax]


def generate(case_id):
    path = os.path.join(OUT, case_id + ".step")
    expected = CASES[case_id](path)
    expected.setdefault("volumeTolerance", 0.01)
    expected.setdefault("bboxTolerance", 0.01)
    solids, volume, box = readback(path)
    span = math.dist(expected["bbox"][:3], expected["bbox"][3:])
    problems = []
    if solids != expected["solids"]:
        problems.append("solids %d != %d" % (solids, expected["solids"]))
    if abs(volume - expected["volume"]) > expected["volumeTolerance"] * expected["volume"]:
        problems.append("volume %.6g != %.6g" % (volume, expected["volume"]))
    if max(abs(a - b) for a, b in zip(box, expected["bbox"])) > expected["bboxTolerance"] + 1e-6 * span:
        problems.append("bbox %s != %s" % ([round(v, 4) for v in box], expected["bbox"]))
    if problems:
        raise SystemExit("%s: generated file disagrees with its design: %s" % (case_id, "; ".join(problems)))
    with open(os.path.join(OUT, case_id + ".expected.json"), "w", encoding="utf-8") as handle:
        json.dump(expected, handle, ensure_ascii=False, indent=2)
    return solids, volume


def main():
    os.makedirs(OUT, exist_ok=True)
    wanted = sys.argv[1:] or list(CASES)
    for case_id in wanted:
        solids, volume = generate(case_id)
        sys.stdout.write("generated  %s (%d solid%s, volume %.6g)\n" % (case_id, solids, "" if solids == 1 else "s", volume))


if __name__ == "__main__":
    main()
