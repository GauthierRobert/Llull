"""Compare a candidate solid (llull STL export) against a reference solid (STL).

Usage: python -I compare_meshes.py CANDIDATE.stl REFERENCE.stl [--out DIR] [--json]

Metrics (after the best of the 24 axis-aligned orientations + bbox-centre alignment, optionally
refined by an exhaustive integer-mm-free translation search on the bbox):
  volume_ratio   candidate / reference volume
  iou            vol(A n B) / vol(A u B)            (exact mesh booleans, manifold3d)
  bbox           per-axis extents of both
  views          2D IoU of the three orthographic silhouettes (top / front / right)
  sections       2D IoU of the three mid-plane sections (catches holes, pockets, wall thickness)
With --out it writes one PNG per view/section: grey = both, red = reference only (missing in
candidate), blue = candidate only (extra material).
"""

from __future__ import annotations

import argparse
import itertools
import json
import pathlib
import sys

import numpy as np
import trimesh
from manifold3d import CrossSection, Manifold, Mesh
from PIL import Image, ImageDraw


def load(path: str) -> Manifold:
    tm = trimesh.load_mesh(path, process=True)
    if isinstance(tm, trimesh.Scene):
        tm = trimesh.util.concatenate(list(tm.geometry.values()))
    tm.merge_vertices(digits_vertex=5)
    tm.remove_unreferenced_vertices()
    man = Manifold(
        Mesh(vert_properties=np.asarray(tm.vertices, np.float32), tri_verts=np.asarray(tm.faces, np.uint32))
    )
    if man.status().name != "NoError" or man.volume() <= 0:
        # Fall back to the union of the connected components (STL soups with shared walls).
        parts = []
        for sub in tm.split(only_watertight=False):
            m = Manifold(
                Mesh(vert_properties=np.asarray(sub.vertices, np.float32), tri_verts=np.asarray(sub.faces, np.uint32))
            )
            if m.status().name == "NoError" and m.volume() > 0:
                parts.append(m)
        if not parts:
            sys.exit(f"{path}: not a closed manifold mesh ({man.status().name})")
        man = Manifold.batch_boolean(parts, manifold3d_op_add())
    return man


def manifold3d_op_add():  # OpType moved between manifold3d releases
    import manifold3d

    return manifold3d.OpType.Add


def bbox(m: Manifold) -> tuple[np.ndarray, np.ndarray]:
    b = m.bounding_box()
    return np.array(b[:3]), np.array(b[3:])


def rotations() -> list[np.ndarray]:
    mats = []
    for perm in itertools.permutations(range(3)):
        for signs in itertools.product((1, -1), repeat=3):
            r = np.zeros((3, 3))
            for i, (p, s) in enumerate(zip(perm, signs)):
                r[i, p] = s
            if np.linalg.det(r) > 0:
                mats.append(r)
    return mats


def transform(m: Manifold, r: np.ndarray, t: np.ndarray) -> Manifold:
    mat = np.hstack([r, t.reshape(3, 1)])
    return m.transform(mat.tolist())


def iou3(a: Manifold, b: Manifold) -> float:
    inter = (a ^ b).volume()
    return inter / (a.volume() + b.volume() - inter)


def centre_on(m: Manifold, ref: Manifold) -> Manifold:
    lo, hi = bbox(m)
    rlo, rhi = bbox(ref)
    return m.translate(((rlo + rhi) / 2 - (lo + hi) / 2).tolist())


def best_alignment(cand: Manifold, ref: Manifold) -> tuple[Manifold, float, list[list[float]]]:
    best = (None, -1.0, None)
    rext = np.sort(np.subtract(*bbox(ref)[::-1]))
    for r in rotations():
        m = transform(cand, r, np.zeros(3))
        m = centre_on(m, ref)
        score = iou3(m, ref)
        if score > best[1]:
            best = (m, score, r.tolist())
    m, score, r = best
    # Local translation refinement (handles bboxes that differ, e.g. a missing boss).
    step = max(rext) / 20
    while step > 0.01:
        improved = False
        for axis in range(3):
            for sgn in (1, -1):
                d = np.zeros(3)
                d[axis] = sgn * step
                trial = m.translate(d.tolist())
                s = iou3(trial, ref)
                if s > score + 1e-9:
                    m, score, improved = trial, s, True
        if not improved:
            step /= 2
    return m, score, r


VIEWS = {  # name -> (rotation that maps the view direction onto -Z / the section normal onto Z)
    "top": np.eye(3),
    "front": np.array([[1, 0, 0], [0, 0, 1], [0, -1, 0]], float),  # look along +Y
    "right": np.array([[0, 1, 0], [0, 0, 1], [1, 0, 0]], float),  # look along -X
}


def raster(cs: CrossSection, lo: np.ndarray, scale: float, size: tuple[int, int]) -> np.ndarray:
    img = Image.new("1", size, 0)
    draw = ImageDraw.Draw(img)
    # Even-odd fill of every contour reproduces holes.
    acc = np.zeros(size[::-1], bool)
    for poly in cs.to_polygons():
        if len(poly) < 3:
            continue
        layer = Image.new("1", size, 0)
        ImageDraw.Draw(layer).polygon(
            [((x - lo[0]) * scale, size[1] - (y - lo[1]) * scale) for x, y in poly], fill=1
        )
        acc ^= np.array(layer, bool)
    del draw
    return acc


def compare_2d(a: CrossSection, b: CrossSection, name: str, out: pathlib.Path | None) -> float:
    ba, bb_ = a.bounds(), b.bounds()
    lo = np.minimum(ba[:2], bb_[:2]) - 1
    hi = np.maximum(ba[2:], bb_[2:]) + 1
    span = hi - lo
    scale = 800 / max(span)
    size = (max(int(span[0] * scale), 1), max(int(span[1] * scale), 1))
    ra, rb = raster(a, lo, scale, size), raster(b, lo, scale, size)
    union = (ra | rb).sum()
    score = float((ra & rb).sum() / union) if union else 1.0
    if out is not None:
        rgb = np.full(size[::-1] + (3,), 255, np.uint8)
        rgb[ra & rb] = (150, 150, 150)
        rgb[rb & ~ra] = (220, 40, 40)  # reference only = missing material in candidate
        rgb[ra & ~rb] = (40, 90, 230)  # candidate only = extra material
        Image.fromarray(rgb).save(out / f"{name}.png")
    return score


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("candidate")
    ap.add_argument("reference")
    ap.add_argument("--out")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--no-rotate", action="store_true", help="keep the candidate orientation")
    args = ap.parse_args()
    cand, ref = load(args.candidate), load(args.reference)
    if args.no_rotate:
        aligned = centre_on(cand, ref)
        score, r = iou3(aligned, ref), np.eye(3).tolist()
    else:
        aligned, score, r = best_alignment(cand, ref)
    out = pathlib.Path(args.out) if args.out else None
    if out:
        out.mkdir(parents=True, exist_ok=True)
    rlo, rhi = bbox(ref)
    mid = (rlo + rhi) / 2
    views, sections = {}, {}
    for name, rot in VIEWS.items():
        a = transform(aligned, rot, np.zeros(3))
        b = transform(ref, rot, np.zeros(3))
        views[name] = round(compare_2d(a.project(), b.project(), f"view_{name}", out), 4)
        z = float((rot @ mid)[2])
        sections[name] = round(compare_2d(a.slice(z), b.slice(z), f"section_{name}", out), 4)
    alo, ahi = bbox(aligned)
    report = {
        "candidate_volume": round(cand.volume(), 3),
        "reference_volume": round(ref.volume(), 3),
        "volume_ratio": round(cand.volume() / ref.volume(), 5),
        "iou": round(score, 5),
        "rotation": r,
        "candidate_extent": np.round(ahi - alo, 3).tolist(),
        "reference_extent": np.round(rhi - rlo, 3).tolist(),
        "view_iou": views,
        "section_iou": sections,
        "candidate_genus": cand.genus(),
        "reference_genus": ref.genus(),
    }
    if args.json:
        print(json.dumps(report))
    else:
        for k, v in report.items():
            print(f"{k:18} {v}")


if __name__ == "__main__":
    main()
