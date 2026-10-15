#!/usr/bin/env python3
"""Analytic reference datasets for gap SRF (no external input). Run: python3 -I generate_analytic_refs.py

Writes data/:
  curvature_analytic.json   sphere / cylinder / torus principal, Gaussian and mean curvature (closed form, with a
                            finite-difference self-check of the closed form on the parametric surface)
  continuity_cases.json     curve joints with known G-order (G0..G3) and the curvature / curvature-derivative jumps
  conic_cases.json          Liming rho-conics as rational quadratic Beziers (rho -> weight), shoulder points
  wing_planforms.json       trapezoidal wing area / MAC / volume (NACA 0012 section), TR-1208 planform check
  sears_haack.json          Sears-Haack body station radii and volume (fuselage-by-stations loft target)

Conventions: unit normal = Su x Sv / |Su x Sv|; mean curvature H = (k1 + k2) / 2 with the sign of that normal
(a sphere parametrised with outward normal has H = -1/R under the convention H = (eG - 2fF + gE) / (2(EG - F^2))
with e = Suu.n; the JSON states both |H| and the signed value for the stated parametrisation).
"""

from __future__ import annotations

import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")


def sub(a, b):
    return [a[i] - b[i] for i in range(3)]


def cross(a, b):
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]


def dot(a, b):
    return sum(a[i] * b[i] for i in range(3))


def fundamental_forms(S, u, v, h=1e-4):
    """Gaussian and mean curvature of a parametric surface S(u, v) by central differences."""
    p = S(u, v)
    su = [(S(u + h, v)[i] - S(u - h, v)[i]) / (2 * h) for i in range(3)]
    sv = [(S(u, v + h)[i] - S(u, v - h)[i]) / (2 * h) for i in range(3)]
    suu = [(S(u + h, v)[i] - 2 * p[i] + S(u - h, v)[i]) / h ** 2 for i in range(3)]
    svv = [(S(u, v + h)[i] - 2 * p[i] + S(u, v - h)[i]) / h ** 2 for i in range(3)]
    suv = [(S(u + h, v + h)[i] - S(u + h, v - h)[i] - S(u - h, v + h)[i] + S(u - h, v - h)[i]) / (4 * h * h) for i in range(3)]
    n = cross(su, sv)
    ln = math.sqrt(dot(n, n))
    n = [c / ln for c in n]
    E, F, G = dot(su, su), dot(su, sv), dot(sv, sv)
    e, f, g = dot(suu, n), dot(suv, n), dot(svv, n)
    K = (e * g - f * f) / (E * G - F * F)
    H = (e * G - 2 * f * F + g * E) / (2 * (E * G - F * F))
    return K, H


def curvature_cases():
    R, r, Rt = 10.0, 2.0, 5.0  # sphere radius, torus tube radius, torus centre-circle radius
    out = {"units": "1/length (document units)", "cases": []}

    def sphere(u, v):
        return [R * math.cos(v) * math.cos(u), R * math.cos(v) * math.sin(u), R * math.sin(v)]

    for v in (0.0, 0.5, 1.2):
        K, H = fundamental_forms(sphere, 0.3, v)
        out["cases"].append({
            "surface": "sphere", "R": R, "u": 0.3, "v": v,
            "k1": 1 / R, "k2": 1 / R, "K": 1 / R ** 2, "abs_H": 1 / R,
            "fd_check": {"K": K, "H_signed": H}, "tolerance_rel": 1e-6,
            "derivation": "umbilic surface: k1 = k2 = 1/R, K = 1/R^2, |H| = 1/R; integral of K dA = 4*pi (Gauss-Bonnet, chi = 2)",
        })

    def cylinder(u, v):
        return [Rt * math.cos(u), Rt * math.sin(u), v]

    K, H = fundamental_forms(cylinder, 0.7, 1.0)
    out["cases"].append({
        "surface": "cylinder", "R": Rt, "k1": 1 / Rt, "k2": 0.0, "K": 0.0, "abs_H": 1 / (2 * Rt),
        "fd_check": {"K": K, "H_signed": H}, "tolerance_abs_K": 1e-9, "tolerance_rel_H": 1e-6,
        "derivation": "developable: k1 = 1/R around, k2 = 0 along the axis; K = 0, |H| = 1/(2R)",
    })

    def torus(u, v):
        return [(Rt + r * math.cos(v)) * math.cos(u), (Rt + r * math.cos(v)) * math.sin(u), r * math.sin(v)]

    for v in (0.0, math.pi / 2, 2.0, math.pi):
        K_closed = math.cos(v) / (r * (Rt + r * math.cos(v)))
        abs_H = abs((Rt + 2 * r * math.cos(v)) / (2 * r * (Rt + r * math.cos(v))))
        K, H = fundamental_forms(torus, 0.4, v)
        out["cases"].append({
            "surface": "torus", "R_centre": Rt, "r_tube": r, "u": 0.4, "v": v,
            "k_tube": 1 / r, "k_ring": math.cos(v) / (Rt + r * math.cos(v)),
            "K": K_closed, "abs_H": abs_H, "fd_check": {"K": K, "H_signed": H},
            "tolerance_abs_K": 1e-6, "tolerance_rel_H": 1e-5,
            "derivation": "K = cos v / (r (R + r cos v)); outer equator v=0: K = 1/(r(R+r)) > 0; inner equator v=pi: "
                          "K = -1/(r(R-r)) < 0; top v=pi/2: K = 0; integral of K dA = 0 (chi = 0)",
        })
    out["integrals"] = [
        {"surface": "sphere", "integral_K_dA": 4 * math.pi, "area": 4 * math.pi * R ** 2},
        {"surface": "torus", "integral_K_dA": 0.0, "area": 4 * math.pi ** 2 * Rt * r, "volume": 2 * math.pi ** 2 * Rt * r * r},
    ]
    return out


def continuity_cases():
    """Planar joints at x = 0 between a left and a right branch y(x); kappa = y'' / (1 + y'^2)^1.5."""
    Rarc = 5.0
    return {
        "convention": "joint at the origin; left branch for x <= 0, right branch for x >= 0; curvature signed in the plane",
        "cases": [
            {"id": "corner", "left": "y = 0", "right": "y = x", "expected_order": "G0",
             "tangent_angle_jump_rad": math.pi / 4},
            {"id": "line_arc", "left": "y = 0", "right": f"circle radius {Rarc} tangent at origin (y = R - sqrt(R^2 - x^2))",
             "expected_order": "G1", "tangent_angle_jump_rad": 0.0, "curvature_jump": 1 / Rarc},
            {"id": "line_cubic", "left": "y = 0", "right": "y = x^3", "expected_order": "G2",
             "curvature_jump": 0.0, "dkappa_ds_jump": 6.0,
             "derivation": "kappa = 6x/(1+9x^4)^1.5 -> 0 at x=0; dkappa/ds at 0 = 6 vs 0 on the line"},
            {"id": "line_quartic", "left": "y = 0", "right": "y = x^4", "expected_order": "G3",
             "curvature_jump": 0.0, "dkappa_ds_jump": 0.0, "d2kappa_ds2_jump": 24.0,
             "derivation": "kappa = 12x^2/(...)^1.5; kappa(0) = 0, kappa'(0) = 0, kappa''(0) = 24"},
            {"id": "arc_arc_equal", "left": f"circle radius {Rarc}", "right": f"same circle radius {Rarc}",
             "expected_order": "G3 (constant curvature; any order)", "curvature_jump": 0.0},
            {"id": "arc_arc_ratio2", "left": f"circle radius {Rarc}", "right": f"tangent circle radius {2 * Rarc}",
             "expected_order": "G1", "curvature_jump": 1 / Rarc - 1 / (2 * Rarc)},
        ],
        "bezier_g2_rule": "cubic Beziers P0..P3 | Q0..Q3 with P3 = Q0: G1 iff P2, P3, Q1 collinear with P3 between; "
                          "curvature at an end = (n-1)/n * |d1 x d2| / |d1|^3 with d1 = P3-P2, d2 = P2-P1 (n = 3): "
                          "kappa_end = 2/3 * |(P3-P2) x (P1-P2)| / |P3-P2|^3  (Piegl & Tiller / Farin)",
    }


def rational_quadratic(p0, p1, p2, w, t):
    b0, b1, b2 = (1 - t) ** 2, 2 * t * (1 - t) * w, t * t
    d = b0 + b1 + b2
    return [(b0 * p0[i] + b1 * p1[i] + b2 * p2[i]) / d for i in range(2)]


def conic_cases():
    """Liming rho-conic: chord A-B, tangent intersection T, shoulder S = M + rho (T - M) with M = (A + B)/2.
    As a rational quadratic Bezier (A, T, B; weight w on T): S = B(1/2) gives rho = w / (1 + w), i.e. w = rho / (1 - rho).
    rho < 0.5 ellipse, rho = 0.5 parabola, rho > 0.5 hyperbola."""
    A, T, B = [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]
    cases = []
    for rho, kind in ((math.sqrt(2) - 1, "ellipse (unit-circle quadrant)"), (0.3, "ellipse"), (0.5, "parabola"), (0.7, "hyperbola")):
        w = rho / (1 - rho)
        S = rational_quadratic(A, T, B, w, 0.5)
        M = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2]
        S_def = [M[i] + rho * (T[i] - M[i]) for i in range(2)]
        samples = [rational_quadratic(A, T, B, w, k / 8) for k in range(9)]
        case = {"rho": rho, "type": kind, "weight": w, "A": A, "T": T, "B": B, "shoulder": S,
                "shoulder_from_definition": S_def, "samples_t_k_over_8": samples}
        if abs(rho - (math.sqrt(2) - 1)) < 1e-12:
            case["max_radius_error_vs_unit_circle"] = max(abs(math.hypot(p[0], p[1]) - 1) for p in samples)
            case["note"] = "w = cos(45 deg) = sqrt(2)/2 reproduces the exact quarter circle about the origin"
        cases.append(case)
    return {"definition": conic_cases.__doc__, "cases": cases}


def naca00_area(t: float, closed: bool = False) -> float:
    a4 = -0.1036 if closed else -0.1015
    # integral of 2*yt over [0,1]: 10 t (0.2969*2/3 - 0.1260/2 - 0.3516/3 + 0.2843/4 + a4/5)
    return 10 * t * (0.2969 * 2 / 3 - 0.1260 / 2 - 0.3516 / 3 + 0.2843 / 4 + a4 / 5)


def wing_planforms():
    out = []
    # TR-1208 wing as used in the OpenVSP Swept_Wing_API example (NACA TR-1208 model)
    cr, b2, lam = 21.941, 63.63, 0.45
    ct = cr * lam
    s_half = b2 * (cr + ct) / 2
    mac = 2 / 3 * cr * (1 + lam + lam ** 2) / (1 + lam)
    y_mac = b2 / 3 * (1 + 2 * lam) / (1 + lam)
    out.append({
        "id": "tr1208", "units": "in", "root_chord": cr, "semi_span": b2, "taper": lam, "sweep_c4_deg": 45.0,
        "tip_chord": ct, "area_full": 2 * s_half, "aspect_ratio": (2 * b2) ** 2 / (2 * s_half), "mac": mac, "y_mac": y_mac,
        "published": {"area_full": 2024.35, "mac": 16.672, "aspect_ratio": 8.02, "source": "OpenVSP examples/vspaero_ex/Swept_Wing_API/README.md (NACA TR-1208 model)"},
        "derivation": "S = b (cr + ct) / 2 per side; MAC = 2/3 cr (1 + l + l^2) / (1 + l); y_MAC = b/3 (1 + 2 l) / (1 + l)",
    })
    # Simple trapezoidal wing with a constant NACA 0012 section, linear loft (exact for homothetic sections)
    cr, ct, b2, t = 2.0, 1.0, 5.0, 0.12
    a_open, a_closed = naca00_area(t), naca00_area(t, True)
    int_c2 = b2 * (cr * cr + cr * ct + ct * ct) / 3
    out.append({
        "id": "trap_naca0012", "units": "m", "root_chord": cr, "tip_chord": ct, "semi_span": b2, "sweep_le_deg": 0.0,
        "section": "NACA 0012 (open TE, a4 = -0.1015)", "area_planform_half": b2 * (cr + ct) / 2,
        "mac": 2 / 3 * cr * (1 + 0.5 + 0.25) / 1.5,
        "section_area_unit_chord_open": a_open, "section_area_unit_chord_closed": a_closed,
        "volume_half_open_te": a_open * int_c2, "volume_half_closed_te": a_closed * int_c2,
        "derivation": "V = A_unit * integral_0^b c(y)^2 dy = A_unit * b (cr^2 + cr ct + ct^2) / 3; exact for a ruled or "
                      "two-section loft of homothetic sections; A_unit(NACA 00tt) = 10 t (0.2969*2/3 - 0.126/2 - 0.3516/3 + 0.2843/4 + a4/5)",
        "tolerance_rel_volume": 1e-4,
    })
    return out


def sears_haack():
    L, Rmax = 10.0, 0.5
    stations = []
    for k in range(0, 21):
        x = k / 20
        stations.append({"x": x * L, "r": Rmax * (4 * x * (1 - x)) ** 0.75})
    return {
        "L": L, "R_max": Rmax, "r_of_x": "r = R_max (4 x/L (1 - x/L))^(3/4)",
        "volume": 3 * math.pi ** 2 * Rmax ** 2 * L / 16,
        "check_r_at_quarter_length_over_Rmax": 0.75 ** 0.75,
        "stations": stations,
        "derivation": "V = pi R^2 L 8 int_0^1 (u(1-u))^(3/2) du = pi R^2 L 8 (3 pi / 128) = 3 pi^2 R^2 L / 16 (Beta(5/2, 5/2) = 3 pi / 128)",
        "tolerance_rel_volume_21_stations_smooth_loft": "TBD - measure with llull loft_fuselage on OCC; analytic target above",
    }


def main() -> int:
    os.makedirs(DATA, exist_ok=True)
    files = {
        "curvature_analytic.json": curvature_cases(),
        "continuity_cases.json": continuity_cases(),
        "conic_cases.json": conic_cases(),
        "wing_planforms.json": wing_planforms(),
        "sears_haack.json": sears_haack(),
    }
    for name, payload in files.items():
        with open(os.path.join(DATA, name), "w", encoding="utf-8") as fh:
            json.dump(payload, fh, indent=1)
        print("wrote", name)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
