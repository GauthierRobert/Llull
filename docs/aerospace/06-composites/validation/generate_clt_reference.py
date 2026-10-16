#!/usr/bin/env python3
"""Classical Laminate Theory reference generator for llull gap CMP (docs/aerospace/06-composites).

Pure-stdlib (no numpy) so it runs with the bundled desktop CPython or any python3 >= 3.8:
    python3 generate_clt_reference.py            # writes clt_reference.json next to this file
    python3 generate_clt_reference.py --check    # recomputes and diffs against the committed JSON

Conventions (llull TR-CMP-30..36):
  * Units: N, mm, MPa (= N/mm^2). A in N/mm, B in N, D in N*mm. Strains dimensionless, curvatures 1/mm.
  * Stacking is listed from the BOTTOM (z = -h/2) to the TOP (z = +h/2); +z = laminate normal = tool-surface
    normal side chosen by the ply's `side`. Angles in degrees, positive counter-clockwise about +z, measured
    from the rosette 0-degree axis (laminate x axis).
  * Engineering strain (gamma_xy = 2 eps_xy). Reduced stiffness Q, transformed Qbar after Jones (1999) ch. 2,
    ABD after Jones ch. 4 / NASA RP-1351.
  * Failure: maximum stress, Tsai-Hill (sign-dependent X, Y), Tsai-Wu with F12 = -0.5*sqrt(F11*F22)
    (common default when no biaxial data, see TECHNICAL_SPEC 5.3). Strength ratio R: load multiplier to failure.
Material data provenance is recorded in the JSON (`materials[*].source`).
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

OUT = Path(__file__).with_name("clt_reference.json")

MATERIALS = {
    "T300_5208": {
        "E1": 181000.0, "E2": 10300.0, "G12": 7170.0, "nu12": 0.28,
        "Xt": 1500.0, "Xc": 1500.0, "Yt": 40.0, "Yc": 246.0, "S": 68.0,
        "ply_thickness": 0.125,
        "source": "Tsai & Hahn, Introduction to Composite Materials (Technomic, 1980) T300/5208 data as reproduced in "
                  "Kaw, Mechanics of Composite Materials 2e Table 2.1 and in open course material (see validation/sources.md S10-S12). "
                  "ply_thickness 0.125 mm is a llull test convention, NOT a sourced value.",
    },
    "AS4_3501_6": {
        "E1": 126000.0, "E2": 11000.0, "G12": 6600.0, "nu12": 0.28,
        "Xt": 1950.0, "Xc": 1480.0, "Yt": 48.0, "Yc": 200.0, "S": 79.0,
        "ply_thickness": 0.125,
        "source": "Soden, Hinton & Kaddour, Compos. Sci. Technol. 58 (1998) 1011-1022 (WWFE lamina data) as reproduced in "
                  "NPTEL 101104010 and the LS-DYNA composite property compilation (validation/sources.md S13-S14). "
                  "ply_thickness 0.125 mm is a llull test convention, NOT the WWFE value.",
    },
}

LAMINATES = {
    "UD_0_8": [0] * 8,
    "cross_ply_0_90_s": [0, 90, 90, 0],
    "angle_ply_pm45_s": [45, -45, -45, 45],
    "quasi_iso_0_45_m45_90_s": [0, 45, -45, 90, 90, -45, 45, 0],
    "quasi_iso_0_60_m60_s": [0, 60, -60, -60, 60, 0],
    "unsym_0_90_T": [0, 90],
    "unsym_0_30_m45_T": [0, 30, -45],
}

LOADS = {  # [Nx, Ny, Nxy, Mx, My, Mxy] (N/mm, N*mm/mm)
    "Nx_unit": [1, 0, 0, 0, 0, 0],
    "Ny_unit": [0, 1, 0, 0, 0, 0],
    "Nxy_unit": [0, 0, 1, 0, 0, 0],
    "Mx_unit": [0, 0, 0, 1, 0, 0],
}


def q_matrix(m):
    nu21 = m["nu12"] * m["E2"] / m["E1"]
    den = 1.0 - m["nu12"] * nu21
    return [[m["E1"] / den, m["nu12"] * m["E2"] / den, 0.0],
            [m["nu12"] * m["E2"] / den, m["E2"] / den, 0.0],
            [0.0, 0.0, m["G12"]]]


def qbar(q, theta_deg):
    c = math.cos(math.radians(theta_deg)); s = math.sin(math.radians(theta_deg))
    q11, q12, q22, q66 = q[0][0], q[0][1], q[1][1], q[2][2]
    c2, s2, c4, s4 = c * c, s * s, c ** 4, s ** 4
    b11 = q11 * c4 + 2 * (q12 + 2 * q66) * s2 * c2 + q22 * s4
    b12 = (q11 + q22 - 4 * q66) * s2 * c2 + q12 * (s4 + c4)
    b22 = q11 * s4 + 2 * (q12 + 2 * q66) * s2 * c2 + q22 * c4
    b16 = (q11 - q12 - 2 * q66) * s * c ** 3 + (q12 - q22 + 2 * q66) * s ** 3 * c
    b26 = (q11 - q12 - 2 * q66) * s ** 3 * c + (q12 - q22 + 2 * q66) * s * c ** 3
    b66 = (q11 + q22 - 2 * q12 - 2 * q66) * s2 * c2 + q66 * (s4 + c4)
    return [[b11, b12, b16], [b12, b22, b26], [b16, b26, b66]]


def inv(mat):
    n = len(mat)
    a = [row[:] + [1.0 if i == j else 0.0 for j in range(n)] for i, row in enumerate(mat)]
    for col in range(n):
        piv = max(range(col, n), key=lambda r: abs(a[r][col]))
        a[col], a[piv] = a[piv], a[col]
        p = a[col][col]
        if abs(p) < 1e-300:
            raise ValueError("singular matrix")
        a[col] = [v / p for v in a[col]]
        for r in range(n):
            if r != col and a[r][col] != 0.0:
                f = a[r][col]
                a[r] = [v - f * w for v, w in zip(a[r], a[col])]
    return [row[n:] for row in a]


def matvec(m, v):
    return [sum(mi * vi for mi, vi in zip(row, v)) for row in m]


def abd(material, angles):
    t = material["ply_thickness"]; h = t * len(angles); q = q_matrix(material)
    A = [[0.0] * 3 for _ in range(3)]; B = [[0.0] * 3 for _ in range(3)]; D = [[0.0] * 3 for _ in range(3)]
    z = [-h / 2 + k * t for k in range(len(angles) + 1)]
    for k, ang in enumerate(angles):
        qb = qbar(q, ang); z0, z1 = z[k], z[k + 1]
        for i in range(3):
            for j in range(3):
                A[i][j] += qb[i][j] * (z1 - z0)
                B[i][j] += qb[i][j] * (z1 ** 2 - z0 ** 2) / 2
                D[i][j] += qb[i][j] * (z1 ** 3 - z0 ** 3) / 3
    return A, B, D, z, h


def clean(mat, scale):
    """Zero round-off entries (|x| < 1e-12 * scale) so symmetric/balanced zeros are exact in the JSON."""
    return [[0.0 if abs(v) < 1e-12 * scale else v for v in row] for row in mat]


def full6(A, B, D):
    return [A[i] + B[i] for i in range(3)] + [B[i] + D[i] for i in range(3)]


def stress_material(sig_xy, theta_deg):
    c = math.cos(math.radians(theta_deg)); s = math.sin(math.radians(theta_deg))
    sx, sy, txy = sig_xy
    s1 = c * c * sx + s * s * sy + 2 * s * c * txy
    s2 = s * s * sx + c * c * sy - 2 * s * c * txy
    t12 = -s * c * sx + s * c * sy + (c * c - s * s) * txy
    return [s1, s2, t12]


def ratios(m, s):
    s1, s2, t = s
    X = m["Xt"] if s1 >= 0 else m["Xc"]; Y = m["Yt"] if s2 >= 0 else m["Yc"]
    cand = []
    if s1: cand.append(X / abs(s1))
    if s2: cand.append(Y / abs(s2))
    if t: cand.append(m["S"] / abs(t))
    r_ms = min(cand) if cand else math.inf
    fi_th = (s1 / X) ** 2 - s1 * s2 / X ** 2 + (s2 / Y) ** 2 + (t / m["S"]) ** 2
    r_th = 1 / math.sqrt(fi_th) if fi_th > 0 else math.inf
    F1 = 1 / m["Xt"] - 1 / m["Xc"]; F2 = 1 / m["Yt"] - 1 / m["Yc"]
    F11 = 1 / (m["Xt"] * m["Xc"]); F22 = 1 / (m["Yt"] * m["Yc"]); F66 = 1 / m["S"] ** 2
    F12 = -0.5 * math.sqrt(F11 * F22)
    a = F11 * s1 ** 2 + F22 * s2 ** 2 + F66 * t ** 2 + 2 * F12 * s1 * s2
    b = F1 * s1 + F2 * s2
    if a > 0:
        r_tw = (-b + math.sqrt(b * b + 4 * a)) / (2 * a)
    elif b > 0:
        r_tw = 1 / b
    else:
        r_tw = math.inf
    fi_tw = a + b
    return {"R_max_stress": r_ms, "R_tsai_hill": r_th, "R_tsai_wu": r_tw, "FI_tsai_hill": fi_th, "FI_tsai_wu": fi_tw}


def rnd(x, n=6):
    if isinstance(x, list):
        return [rnd(v, n) for v in x]
    if isinstance(x, float):
        if math.isinf(x):
            return None
        return float(f"{x:.{n}g}")
    return x


def laminate_case(mat_name, lam_name):
    m = MATERIALS[mat_name]; angles = LAMINATES[lam_name]
    A, B, D, z, h = abd(m, angles)
    scale = max(abs(v) for row in A for v in row)
    A, B, D = clean(A, scale), clean(B, scale * h), clean(D, scale * h * h)
    abd6 = full6(A, B, D); inv6 = inv(abd6)
    a = inv(A)
    sym = angles == angles[::-1]
    eng_A = {"Ex": 1 / (h * a[0][0]), "Ey": 1 / (h * a[1][1]), "Gxy": 1 / (h * a[2][2]), "nuxy": -a[0][1] / a[0][0]}
    eng_free = {"Ex": 1 / (h * inv6[0][0]), "Ey": 1 / (h * inv6[1][1]), "Gxy": 1 / (h * inv6[2][2]), "nuxy": -inv6[0][1] / inv6[0][0]}
    loads = {}
    for ln, load in LOADS.items():
        defo = matvec(inv6, load); eps0, kap = defo[:3], defo[3:]
        plies = []; Rmin = {"R_max_stress": math.inf, "R_tsai_hill": math.inf, "R_tsai_wu": math.inf}; crit = {}
        q = q_matrix(m)
        for k, ang in enumerate(angles):
            qb = qbar(q, ang); rec = {"ply": k + 1, "angle": ang, "points": {}}
            for pos, zz in (("bottom", z[k]), ("top", z[k + 1])):
                e = [eps0[i] + zz * kap[i] for i in range(3)]
                sxy = matvec(qb, e); s12 = stress_material(sxy, ang); r = ratios(m, s12)
                rec["points"][pos] = {"z": zz, "sigma_xy": rnd(sxy), "sigma_12": rnd(s12), **{k2: rnd(v) for k2, v in r.items()}}
                for key in Rmin:
                    if r[key] < Rmin[key]:
                        Rmin[key] = r[key]; crit[key] = {"ply": k + 1, "angle": ang, "position": pos}
            plies.append(rec)
        loads[ln] = {"load": load, "midplane_strain": rnd(eps0), "curvature": rnd(kap),
                     "first_ply_failure_multiplier": {k: rnd(v) for k, v in Rmin.items()}, "critical": crit, "plies": plies}
    return {"material": mat_name, "angles_bottom_to_top": angles, "thickness_mm": h, "symmetric": sym,
            "A": rnd(A), "B": rnd(B), "D": rnd(D),
            "engineering_constants_membrane_A_inverse": {k: rnd(v) for k, v in eng_A.items()},
            "engineering_constants_free_bending_ABD_inverse": {k: rnd(v) for k, v in eng_free.items()},
            "loads": loads}


def analytic_checks():
    """Closed-form identities a correct implementation must satisfy (derivations in validation/README.md)."""
    out = {}
    for name, m in MATERIALS.items():
        q = q_matrix(m); q11, q12, q22, q66 = q[0][0], q[0][1], q[1][1], q[2][2]
        U1 = (3 * q11 + 3 * q22 + 2 * q12 + 4 * q66) / 8; U4 = (q11 + q22 + 6 * q12 - 4 * q66) / 8
        U5 = (q11 + q22 - 2 * q12 + 4 * q66) / 8
        E_qi = (U1 ** 2 - U4 ** 2) / U1; nu_qi = U4 / U1
        t = m["ply_thickness"]
        out[name] = {
            "Q11": rnd(q11), "Q12": rnd(q12), "Q22": rnd(q22), "Q66": rnd(q66),
            "invariants": {"U1": rnd(U1), "U4": rnd(U4), "U5": rnd(U5)},
            "quasi_isotropic_Ex": rnd(E_qi), "quasi_isotropic_nuxy": rnd(nu_qi), "quasi_isotropic_Gxy": rnd(U5),
            "UD_0_8_Ex_equals_E1": m["E1"], "UD_0_8_Ey_equals_E2": m["E2"],
            "UD_0_8_FPF_Nx_max_stress": rnd(m["Xt"] * 8 * t),
            "UD_0_8_FPF_Nx_tsai_wu_if_Xt_eq_Xc": rnd(m["Xt"] * 8 * t) if m["Xt"] == m["Xc"] else None,
        }
    return out


def build():
    cases = {f"{mn}/{ln}": laminate_case(mn, ln) for mn in MATERIALS for ln in LAMINATES}
    return {"generator": "generate_clt_reference.py", "units": {"length": "mm", "force": "N", "stress": "MPa"},
            "conventions": __doc__.split("Conventions")[1].split("Material data")[0].strip(),
            "materials": MATERIALS, "analytic_checks": analytic_checks(), "cases": cases}


def main():
    data = build()
    text = json.dumps(data, indent=1, sort_keys=False)
    if "--check" in sys.argv:
        old = OUT.read_text()
        print("OK" if old == text + "\n" else "DIFFERS"); sys.exit(0 if old == text + "\n" else 1)
    OUT.write_text(text + "\n")
    print(f"wrote {OUT} ({len(text)} bytes, {len(data['cases'])} cases)")


if __name__ == "__main__":
    main()
