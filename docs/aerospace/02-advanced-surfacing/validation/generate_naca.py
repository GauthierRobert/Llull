#!/usr/bin/env python3
"""NACA 4- and 5-digit airfoil generator plus comparison against UIUC coordinate files (gap SRF).

Equations (chord-normalised, x in [0, 1]):
  thickness  yt = 5 t (0.2969 sqrt(x) - 0.1260 x - 0.3516 x^2 + 0.2843 x^3 - 0.1015 x^4)        [NACA Report 460; TM 4741]
             closed trailing edge: last coefficient -0.1036 (sum of coefficients = 0)
  4-digit camber (m = max camber, p = its chord position):
             x <  p : yc = m / p^2 (2 p x - x^2)
             x >= p : yc = m / (1 - p)^2 ((1 - 2 p) + 2 p x - x^2)
  5-digit standard camber (here only the 230 mean line: r = 0.2025, k1 = 15.957, verified):
             x <  r : yc = k1 / 6 (x^3 - 3 r x^2 + r^2 (3 - r) x)
             x >= r : yc = k1 r^3 / 6 (1 - x)
  surface    xu = x - yt sin(theta), yu = yc + yt cos(theta); xl = x + yt sin(theta), yl = yc - yt cos(theta)
             theta = atan(dyc/dx)   (thickness applied perpendicular to the mean line)

Usage:
  python3 -I generate_naca.py                       # writes data/naca_*.csv only
  python3 -I generate_naca.py --uiuc-dir <dir>      # also compares against <dir>/naca0012.dat etc.

The UIUC files are untrusted input: they are parsed as numbers only. Output: data/naca_*.csv and
data/naca_uiuc_comparison.json (max normal deviation of every file point from the analytic surface).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")

A_OPEN = (0.2969, -0.1260, -0.3516, 0.2843, -0.1015)
A_CLOSED = (0.2969, -0.1260, -0.3516, 0.2843, -0.1036)


def thickness(x: float, t: float, closed: bool = False) -> float:
    a = A_CLOSED if closed else A_OPEN
    return 5.0 * t * (a[0] * math.sqrt(x) + a[1] * x + a[2] * x * x + a[3] * x ** 3 + a[4] * x ** 4)


def camber4(x: float, m: float, p: float) -> tuple[float, float]:
    if m == 0.0 or p == 0.0:
        return 0.0, 0.0
    if x < p:
        return m / p ** 2 * (2 * p * x - x * x), 2 * m / p ** 2 * (p - x)
    return m / (1 - p) ** 2 * ((1 - 2 * p) + 2 * p * x - x * x), 2 * m / (1 - p) ** 2 * (p - x)


def camber230(x: float, scale: float = 1.0) -> tuple[float, float]:
    r, k1 = 0.2025, 15.957
    if x < r:
        return scale * k1 / 6 * (x ** 3 - 3 * r * x * x + r * r * (3 - r) * x), scale * k1 / 6 * (3 * x * x - 6 * r * x + r * r * (3 - r))
    return scale * k1 * r ** 3 / 6 * (1 - x), -scale * k1 * r ** 3 / 6


def naca_designation(code: str):
    """Return (t, camber_fn) for '0012', '2412', '23012'. Only the 230 mean line is supported for 5-digit."""
    if len(code) == 4:
        m, p, t = int(code[0]) / 100, int(code[1]) / 10, int(code[2:]) / 100
        return t, lambda x: camber4(x, m, p)
    if len(code) == 5 and code[:3] == "230":
        return int(code[3:]) / 100, camber230
    raise ValueError(f"unsupported designation {code} (4-digit or 230xx only)")


def surface(code: str, x: float, upper: bool, closed: bool = False) -> tuple[float, float]:
    t, cam = naca_designation(code)
    yt = thickness(x, t, closed)
    yc, dyc = cam(x)
    th = math.atan(dyc)
    if upper:
        return x - yt * math.sin(th), yc + yt * math.cos(th)
    return x + yt * math.sin(th), yc - yt * math.cos(th)


def cosine_x(n: int) -> list[float]:
    return [0.5 * (1 - math.cos(math.pi * i / (n - 1))) for i in range(n)]


def selig_loop(code: str, n: int = 81, closed: bool = False) -> list[tuple[float, float]]:
    xs = cosine_x(n)
    up = [surface(code, x, True, closed) for x in reversed(xs)]
    lo = [surface(code, x, False, closed) for x in xs[1:]]
    return up + lo


def polygon_area(pts: list[tuple[float, float]]) -> float:
    s = 0.0
    for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1]):
        s += x0 * y1 - x1 * y0
    return abs(s) / 2


def dense_polyline(code: str, upper: bool, n: int = 20001) -> list[tuple[float, float]]:
    return [surface(code, x, upper) for x in cosine_x(n)]


def point_segment_distance(p, a, b) -> float:
    ax, ay = a
    bx, by = b
    px, py = p
    dx, dy = bx - ax, by - ay
    l2 = dx * dx + dy * dy
    u = 0.0 if l2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / l2))
    return math.hypot(px - (ax + u * dx), py - (ay + u * dy))


def distance_to_polyline(p, poly) -> float:
    # coarse search on the polyline x (monotone in parameter), then refine locally
    best_i, best = 0, float("inf")
    step = 50
    for i in range(0, len(poly) - 1, step):
        d = math.hypot(p[0] - poly[i][0], p[1] - poly[i][1])
        if d < best:
            best, best_i = d, i
    lo, hi = max(0, best_i - 2 * step), min(len(poly) - 1, best_i + 2 * step)
    return min(point_segment_distance(p, poly[i], poly[i + 1]) for i in range(lo, hi))


def parse_dat(path: str):
    """Parse a UIUC .dat (Selig or Lednicer). Returns (format, points) with points as one TE->upper->LE->lower->TE loop."""
    with open(path, "r", encoding="latin-1") as fh:
        lines = [ln.strip() for ln in fh.readlines()]
    rows = []
    for ln in lines[1:]:
        parts = ln.replace(",", " ").split()
        if len(parts) < 2:
            continue
        try:
            rows.append((float(parts[0]), float(parts[1])))
        except ValueError:
            continue
    if rows and (rows[0][0] > 1.5 or rows[0][1] > 1.5):  # Lednicer: counts on line 2
        nu, nl = int(rows[0][0]), int(rows[0][1])
        upper, lower = rows[1 : 1 + nu], rows[1 + nu : 1 + nu + nl]
        return "lednicer", list(reversed(upper)) + lower[1:]
    return "selig", rows


def chord_normalise(poly_up, poly_lo):
    """Similarity map sending the TE midpoint to (1, 0) and the loop point farthest from it (the geometric leading edge) to (0, 0)."""
    te = ((poly_up[-1][0] + poly_lo[-1][0]) / 2, (poly_up[-1][1] + poly_lo[-1][1]) / 2)
    le = max(poly_up + poly_lo, key=lambda p: math.hypot(p[0] - te[0], p[1] - te[1]))
    dx, dy = te[0] - le[0], te[1] - le[1]
    s = 1 / math.hypot(dx, dy)
    c, si = dx * s, dy * s

    def f(p):
        x, y = p[0] - le[0], p[1] - le[1]
        return ((c * x + si * y) * s, (-si * x + c * y) * s)

    return [f(p) for p in poly_up], [f(p) for p in poly_lo]


def compare(code: str, path: str) -> dict:
    fmt, pts = parse_dat(path)
    raw = _deviation(pts, dense_polyline(code, True), dense_polyline(code, False))
    norm = _deviation(pts, *chord_normalise(dense_polyline(code, True), dense_polyline(code, False)))
    with open(path, "rb") as fh:
        blob = fh.read()
    return {
        "designation": code,
        "file": os.path.basename(path),
        "sha256": hashlib.sha256(blob).hexdigest(),
        "bytes": len(blob),
        "format": fmt,
        "points": len(pts),
        "max_deviation_chord": raw[0],
        "rms_deviation_chord": raw[1],
        "worst_point": raw[2],
        "max_deviation_chord_after_chord_normalisation": norm[0],
        "rms_deviation_chord_after_chord_normalisation": norm[1],
    }


def _deviation(pts, up_poly, lo_poly):
    le_index = min(range(len(pts)), key=lambda i: pts[i][0])
    worst, worst_pt, sq = 0.0, None, 0.0
    for i, p in enumerate(pts):
        poly = up_poly if i < le_index else lo_poly if i > le_index else None
        d = 0.0 if poly is None else distance_to_polyline(p, poly)
        if poly is None:
            d = min(distance_to_polyline(p, up_poly), distance_to_polyline(p, lo_poly))
        sq += d * d
        if d > worst:
            worst, worst_pt = d, p
    return round(worst, 7), round(math.sqrt(sq / len(pts)), 7), worst_pt


def write_csv(name: str, pts) -> None:
    with open(os.path.join(DATA, name), "w", encoding="utf-8") as fh:
        fh.write("x,y\n")
        for x, y in pts:
            fh.write(f"{x:.8f},{y:.8f}\n")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--uiuc-dir", help="directory holding naca0012.dat, naca2412.dat, naca23012.dat (pinned UIUC copies)")
    args = ap.parse_args()
    os.makedirs(DATA, exist_ok=True)
    summary = {"generator": "generate_naca.py", "sections": {}}
    for code in ("0012", "2412", "23012"):
        loop = selig_loop(code)
        write_csv(f"naca_{code}_selig_81.csv", loop)
        dense = selig_loop(code, 4001)
        t, _ = naca_designation(code)
        xs = [i / 100000 for i in range(100001)]
        tmax_x = max(xs, key=lambda x: thickness(x, t))
        summary["sections"][code] = {
            "area_unit_chord_open_te": round(polygon_area(dense), 6),
            "max_thickness": round(2 * thickness(tmax_x, t), 6),
            "max_thickness_x": round(tmax_x, 4),
            "te_thickness_open": round(2 * thickness(1.0, t), 6),
            "le_radius_analytic": round(1.1019 * t * t, 6),
        }
    write_csv("naca_0012_closed_te_selig_81.csv", selig_loop("0012", closed=True))
    if args.uiuc_dir:
        results = []
        for code, fname in (("0012", "naca0012.dat"), ("2412", "naca2412.dat"), ("23012", "naca23012.dat"), ("0012", "n0012.dat")):
            path = os.path.join(args.uiuc_dir, fname)
            if os.path.exists(path):
                results.append(compare(code, path))
        summary["uiuc_comparison"] = results
        with open(os.path.join(DATA, "naca_uiuc_comparison.json"), "w", encoding="utf-8") as fh:
            json.dump(results, fh, indent=1)
    json.dump(summary, sys.stdout, indent=1)
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
