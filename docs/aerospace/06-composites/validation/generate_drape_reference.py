#!/usr/bin/env python3
"""Kinematic (pin-jointed net / fishnet) drape + developable flat-pattern references for llull gap CMP.

    python3 generate_drape_reference.py           # writes drape_reference.json
    python3 generate_drape_reference.py --check   # recompute and compare

Part 1 - hemisphere: Mack & Taylor (1956) style pin-jointed net with inextensible tows of equal step `d`,
seeded at the pole with two orthogonal geodesic generators (great circles in the xz and yz planes). Every
other node is the intersection of the sphere with two spheres of radius d centred on its two known
neighbours (closed form on a sphere, see TECHNICAL_SPEC 5.4). Shear angle gamma = 90 deg - angle between the
two tow directions at the node. A continuum identity is used as an independent check: for a Chebyshev net
whose threads cross at 90 deg along the generators (true here by mirror symmetry), phi_uv + K sin(phi) = 0
integrates to gamma(u, v) = K * Area(net patch [0,u]x[0,v]) with K = 1/R^2 (Gauss-Bonnet / Hazzidakis).
Part 2 - developable surfaces (cylinder, cone frustum): exact flat-pattern dimensions and fibre paths.
Pure stdlib.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

OUT = Path(__file__).with_name("drape_reference.json")
R = 100.0  # mm


def add(a, b): return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
def sub(a, b): return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
def mul(a, s): return [a[0] * s, a[1] * s, a[2] * s]
def dot(a, b): return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
def cross(a, b): return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
def norm(a): return math.sqrt(dot(a, a))


def node_on_sphere(A, B, C, d):
    """Point X with |X| = R, |X - A| = |X - B| = d, on the side away from C (the opposite cell corner)."""
    c = R * R - d * d / 2.0
    ab = dot(A, B)
    alpha = c / (R * R + ab)
    base = mul(add(A, B), alpha)
    n = cross(A, B); nn = dot(n, n)
    rem = R * R - dot(base, base)
    if rem < 0 or nn < 1e-18:
        return None
    g = math.sqrt(rem / nn)
    x1 = add(base, mul(n, g)); x2 = sub(base, mul(n, g))
    return x1 if norm(sub(x1, C)) > norm(sub(x2, C)) else x2


def angle_deg(u, v):
    cosv = dot(u, v) / (norm(u) * norm(v))
    return math.degrees(math.acos(max(-1.0, min(1.0, cosv))))


def sph_tri_excess(a, b, c):
    a, b, c = mul(a, 1 / norm(a)), mul(b, 1 / norm(b)), mul(c, 1 / norm(c))
    num = abs(dot(a, cross(b, c)))
    den = 1 + dot(a, b) + dot(b, c) + dot(c, a)
    return 2 * math.atan2(num, den)


def drape_quadrant(d, nmax):
    """Quadrant (+x, +y) of the net: P[i][j], i along warp (+x generator), j along weft (+y generator)."""
    step = 2 * math.asin(d / (2 * R))
    P = [[None] * (nmax + 1) for _ in range(nmax + 1)]
    for i in range(nmax + 1):
        th = i * step
        if th <= math.pi:
            P[i][0] = [R * math.sin(th), 0.0, R * math.cos(th)]
            P[0][i] = [0.0, R * math.sin(th), R * math.cos(th)]
    for i in range(1, nmax + 1):
        for j in range(1, nmax + 1):
            A, B, C = P[i - 1][j], P[i][j - 1], P[i - 1][j - 1]
            if A is None or B is None or C is None:
                continue
            X = node_on_sphere(A, B, C, d)
            if X is None:
                continue
            # pin-joint locking / fold-over guard: reject a cell that inverted (crossing angle <= 0)
            if angle_deg(sub(A, X), sub(B, X)) < 1.0:
                continue
            P[i][j] = X
    return P


def polar_deg(p): return math.degrees(math.acos(max(-1.0, min(1.0, p[2] / R))))


def shear_at(P, i, j):
    A, B, X = P[i - 1][j], P[i][j - 1], P[i][j]
    return 90.0 - angle_deg(sub(A, X), sub(B, X))


def patch_area(P, i, j):
    s = 0.0
    for a in range(i):
        for b in range(j):
            p00, p10, p01, p11 = P[a][b], P[a + 1][b], P[a][b + 1], P[a + 1][b + 1]
            s += sph_tri_excess(p00, p10, p11) + sph_tri_excess(p00, p11, p01)
    return s  # = area / R^2 (radians)


def hemisphere_case(d):
    nmax = int(math.ceil(math.pi * R / 2 / d)) + 2
    P = drape_quadrant(d, nmax)
    max_shear = (0.0, None); diag = []; checks = []; on_hemi = 0
    over = {30: 0, 40: 0, 50: 0}
    for i in range(1, nmax + 1):
        for j in range(1, nmax + 1):
            X = P[i][j]
            if X is None or X[2] < -1e-9:
                continue
            g = shear_at(P, i, j); on_hemi += 1
            for lim in over:
                if g > lim:
                    over[lim] += 1
            if g > max_shear[0]:
                max_shear = (g, [i, j, round(polar_deg(X), 4)])
    for i in range(1, nmax + 1):
        X = P[i][i]
        if X is None or X[2] < -1e-9:
            break
        diag.append({"i": i, "arc_length_along_tows_mm": round(i * d, 6), "polar_angle_deg": round(polar_deg(X), 4),
                     "shear_deg": round(shear_at(P, i, i), 4)})
    # Gauss-Bonnet check at diagonal nodes at polar angles near 30/45/60 deg
    for target in (30.0, 45.0, 60.0):
        best = min(diag, key=lambda r: abs(r["polar_angle_deg"] - target))
        i = best["i"]
        checks.append({"i": i, "polar_angle_deg": best["polar_angle_deg"], "shear_deg": best["shear_deg"],
                       "K_times_area_deg": round(math.degrees(patch_area(P, i, i)), 4)})
    # generator orthogonality (mirror symmetry): crossing angle at nodes adjacent to the +x generator
    gen = [round(90.0 - angle_deg(sub(P[i + 1][0], P[i - 1][0]), sub(P[i][1], P[i][0])), 4) for i in (5, 10) if P[i + 1][0] and P[i][1]]
    rim = [P[i][j] for i in range(nmax + 1) for j in range(nmax + 1) if P[i][j] is not None]
    return {"d_mm": d, "R_mm": R, "nodes_quadrant": len(rim), "interior_nodes_on_hemisphere": on_hemi,
            "interior_nodes_over_shear_limit": {f"{k}deg": v for k, v in over.items()},
            "max_shear_deg_on_hemisphere": round(max_shear[0], 4), "max_shear_node": max_shear[1],
            "diagonal": diag, "gauss_bonnet_checks": checks, "generator_crossing_shear_deg": gen,
            "diagonal_reaches_equator": bool(diag and diag[-1]["polar_angle_deg"] > 89.0)}


def cylinder_cases():
    out = []
    for (r, L, theta) in ((50.0, 200.0, 0.0), (50.0, 200.0, 45.0), (50.0, 200.0, 30.0)):
        C = 2 * math.pi * r
        t = math.radians(theta)
        rec = {"radius_mm": r, "length_mm": L, "fibre_angle_deg_from_axis": theta,
               "flat_pattern": "rectangle", "flat_width_mm": round(C, 6), "flat_height_mm": L,
               "area_mm2": round(C * L, 4),
               "fibre_in_flat": "straight line at the same angle (cylinder is developable, isometric unrolling)",
               "max_shear_deg": 0.0}
        if theta not in (0.0, 90.0):
            rec["helix_pitch_mm"] = round(C / math.tan(t), 6)
            rec["fibre_length_one_turn_mm"] = round(C / math.sin(t), 6)
        out.append(rec)
    return out


def frustum_cases():
    out = []
    for (r1, r2, H) in ((100.0, 50.0, 150.0), (100.0, 0.0, 100.0)):
        s = math.hypot(r1 - r2, H)              # slant length
        Rout = s * r1 / (r1 - r2)               # outer development radius (apex to large rim)
        Rin = Rout - s
        phi = 2 * math.pi * r1 / Rout           # sector angle (rad) = 2*pi*sin(half cone angle)
        area = 0.5 * phi * (Rout ** 2 - Rin ** 2)
        out.append({"r_large_mm": r1, "r_small_mm": r2, "height_mm": H, "slant_mm": round(s, 6),
                    "flat_pattern": "annular sector" if r2 > 0 else "circular sector",
                    "R_outer_mm": round(Rout, 6), "R_inner_mm": round(Rin, 6), "sector_angle_deg": round(math.degrees(phi), 6),
                    "area_mm2": round(area, 4), "lateral_area_check_mm2": round(math.pi * (r1 + r2) * s, 4),
                    "zero_deg_fibre": "a generator (meridian) maps to a radial line of the sector; a geodesic fibre maps to a straight line",
                    "max_shear_deg": 0.0})
    return out


def build():
    cases = [hemisphere_case(d) for d in (4.0, 2.0, 1.0)]
    return {"generator": "generate_drape_reference.py", "units": {"length": "mm", "angle": "deg"},
            "hemisphere_pin_jointed_net": cases, "cylinder": cylinder_cases(), "cone_frustum": frustum_cases()}


def main():
    text = json.dumps(build(), indent=1) + "\n"
    if "--check" in sys.argv:
        ok = OUT.read_text() == text; print("OK" if ok else "DIFFERS"); sys.exit(0 if ok else 1)
    OUT.write_text(text); print(f"wrote {OUT} ({len(text)} bytes)")


if __name__ == "__main__":
    main()
