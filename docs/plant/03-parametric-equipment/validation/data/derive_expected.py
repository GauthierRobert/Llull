"""Derivations of the 03 EQP expected values from cited closed forms.

Independent re-implementation (does not import `fluids` or `ht`). Run: python3 -I derive_expected.py > derived.json
Formulas: Jones 'Calculating Tank Volume' [S1] (as printed in fluids 1.3.1 docstrings [S2]), spheroid area [S3],
ASME VIII-1 UG-27 / UG-32 / UG-99 [S6..S13], API 650 one-foot method [S15, S16].
"""
import json
from math import acos, asin, cos, log, pi, sin, sqrt

GAL_IN3 = 231.0
RHO_STEEL = 7850.0  # kg/m3, stated as an explicit plan input (llull STEEL_DENSITY_KG_PER_M3)
RHO_WATER = 1000.0  # kg/m3, stated as an explicit plan input


# ---- head geometry and volumes (Jones) ----
def tori_geom(D, f, k):
    al = asin((1 - 2 * k) / (2 * (f - k)))
    return al, f * D * (1 - cos(al)), k * D * cos(al)


def v_vert_ellipsoidal(D, a, h):
    if h <= 0:
        return 0.0
    return pi / 4 * (D * h / a) ** 2 * (a - h / 3) if h < a else pi * D * D / 4 * (h - a / 3)


def v_vert_spherical(D, a, h):
    if h <= 0:
        return 0.0
    return pi * h * h / 4 * (2 * a + D * D / (2 * a) - 4 * h / 3) if h < a else pi / 4 * (2 * a**3 / 3 - a * D * D / 2 + h * D * D)


def v_vert_conical(D, a, h):
    if h <= 0:
        return 0.0
    return pi / 4 * (D * h / a) ** 2 * h / 3 if h < a else pi * D * D / 4 * (h - 2 * a / 3)


def v_vert_torispherical(D, f, k, h):
    al, a1, a2 = tori_geom(D, f, k)
    D1, s, t, u = 2 * f * D * sin(al), (k * D * sin(al)) ** 2, 2 * a2, h - f * D * (1 - cos(al))
    if h <= 0:
        return 0.0
    if h <= a1:
        return pi * h * h / 4 * (2 * a1 + D1 * D1 / (2 * a1) - 4 * h / 3)
    base = pi / 4 * (2 * a1**3 / 3 + a1 * D1 * D1 / 2)
    knuckle = (D / 2 - k * D) ** 2 + s
    if h <= a1 + a2:
        return (base + pi * u * knuckle + pi * t * u * u / 2 - pi * u**3 / 3
                + pi * D * (1 - 2 * k) * ((2 * u - t) / 4 * sqrt(s + t * u - u * u) + t * sqrt(s) / 4
                                         + k * k * D * D / 2 * (acos((t - 2 * u) / (2 * k * D)) - al)))
    return (base + pi * t / 2 * knuckle + pi * t**3 / 12 + pi * D * (1 - 2 * k) * (t * sqrt(s) / 4 + k * k * D * D / 2 * asin(cos(al)))
            + pi * D * D / 4 * (h - (a1 + a2)))


def segment_area(R, h):
    h = min(max(h, 0.0), 2 * R)
    return R * R * acos((R - h) / R) - (R - h) * sqrt(2 * R * h - h * h)


def v_horiz_ellipsoidal(D, L, a, h):
    R, h = D / 2, min(h, D)
    return segment_area(R, h) * L + pi * a * h * h * (1 - h / (3 * R))


def v_horiz_conical_numeric(D, L, a, h, n=20000):
    R, total = D / 2, 0.0
    for i in range(n):
        r, y = R * (1 - (i + 0.5) / n), h - R
        if y >= r:
            area = pi * r * r
        elif y > -r:
            area = r * r * acos(-y / r) + y * sqrt(r * r - y * y)
        else:
            area = 0.0
        total += area * a / n
    return segment_area(R, h) * L + 2 * total


def tori_volume_numeric(D, f, k, n=200000):
    R, Rc, rk = D / 2, f * D, k * D
    _, a1, a2 = tori_geom(D, f, k)
    depth, total = a1 + a2, 0.0
    for i in range(n):
        z = (i + 0.5) * depth / n
        r = sqrt(max(0.0, Rc * Rc - (Rc - z) ** 2)) if z <= a1 else (R - rk) + sqrt(max(0.0, rk * rk - (depth - z) ** 2))
        total += pi * r * r * depth / n
    return total


def sa_ellipsoidal(D, a):
    R = D / 2
    if abs(a - R) < 1e-15:
        return 2 * pi * R * R
    if a < R:
        e = sqrt(1 - a * a / (R * R))
        return pi * R * R + pi * a * a / (2 * e) * log((1 + e) / (1 - e))
    e = sqrt(1 - R * R / (a * a))
    return pi * R * R + pi * a * R / e * asin(e)


# ---- ASME VIII-1 and API 650 ----
def ug27_c1(P, R, S, E, CA=0.0, corroded=True):
    return P * (R + (CA if corroded else 0.0)) / (S * E - 0.6 * P) + CA


def mawp_shell(S, E, t, R):
    return S * E * t / (R + 0.6 * t)


def ug32_ellipsoidal(P, D, S, E):
    return P * D / (2 * S * E - 0.2 * P)


def mawp_ellipsoidal(S, E, t, D):
    return 2 * S * E * t / (D + 0.2 * t)


def ug32_torispherical(P, L, S, E):
    return 0.885 * P * L / (S * E - 0.1 * P)


def api650(D, H, G, Sd, St, CA):
    return 4.9 * D * (H - 0.3) * G / Sd + CA, 4.9 * D * (H - 0.3) / St


def ellipsoidal_head_metal_volume(D, a, t, n=100000):
    """Exact metal volume of a constant-thickness head: solid of revolution between the inside semi-ellipse and its
    outward offset by t, closed by the tangent plane (trapezoid rule in z on both profiles)."""
    R = D / 2

    def revolved(offset):
        total, prev = 0.0, None
        for i in range(n + 1):
            u = pi / 2 * i / n
            x, z = R * cos(u), a * sin(u)
            dx, dz = -R * sin(u), a * cos(u)
            norm = sqrt(dx * dx + dz * dz)
            point = (x + offset * dz / norm, z - offset * dx / norm)
            if prev is not None:
                total += pi * ((point[0] + prev[0]) / 2) ** 2 * abs(point[1] - prev[1])
            prev = point
        return total

    return revolved(t) - revolved(0.0)


def vessel(D, L, t_shell, t_head, CA, S, E_shell, E_head, P, skirt=None):
    """Vertical or horizontal cylinder + two 2:1 heads; head mass = exact offset solid (thin-wall rule reported too)."""
    a = D / 4
    v = pi / 4 * D * D * L + 2 * pi * D**3 / 24
    m_shell = pi / 4 * ((D + 2 * t_shell) ** 2 - D * D) * L * RHO_STEEL
    m_head = ellipsoidal_head_metal_volume(D, a, t_head) * RHO_STEEL
    m_head_thin = sa_ellipsoidal(D, a) * t_head * RHO_STEEL
    m_skirt = 0.0
    if skirt:
        sd, st, sh = skirt
        m_skirt = pi / 4 * ((sd + 2 * st) ** 2 - sd * sd) * sh * RHO_STEEL
    Rc, Dc = D / 2 + CA, D + 2 * CA
    ms, mh = mawp_shell(S, E_shell, t_shell - CA, Rc), mawp_ellipsoidal(S, E_head, t_head - CA, Dc)
    empty = m_shell + 2 * m_head + m_skirt
    return {
        "volume_m3": v, "shellMass_kg": m_shell, "headMassEach_kg": m_head, "headMassEachThinWall_kg": m_head_thin, "skirtMass_kg": m_skirt, "bodyEmpty_kg": empty,
        "trShell_mm": ug27_c1(P, D / 2, S, E_shell, CA) * 1000, "trHead_mm": (ug32_ellipsoidal(P, Dc, S, E_head) + CA) * 1000,
        "mawpShell_MPa": ms, "mawpHead_MPa": mh, "mawp_MPa": min(ms, mh), "hydrotest_MPa": 1.3 * min(ms, mh),
        "bodyTest_kg": empty + v * RHO_WATER,
    }


def main():
    out = {}
    out["jones_gal"] = {
        "VE": [v_vert_ellipsoidal(132, 33, h) / GAL_IN3 for h in (24, 60, 132)],
        "VS": [v_vert_spherical(132, 33, h) / GAL_IN3 for h in (24, 60, 132)],
        "VC": [v_vert_conical(132, 33, h) / GAL_IN3 for h in (24, 60, 132)],
        "VT": [v_vert_torispherical(132, 1, 0.06, h) / GAL_IN3 for h in (24, 60, 1, 22, 132)],
        "HE": [v_horiz_ellipsoidal(108, 156, 42, h) / GAL_IN3 for h in (36, 84, 54, 108)],
        "HC_numeric": [v_horiz_conical_numeric(108, 156, 42, h) / GAL_IN3 for h in (36, 84, 108)],
    }
    out["torisphericalDepth"] = [sum(tori_geom(96, 0.9, 0.2)[1:]), sum(tori_geom(108, 1, 0.06)[1:])]
    out["headVolumeD1"] = {name: {"depth": sum(tori_geom(1, f, k)[1:]), "closed": v_vert_torispherical(1, f, k, sum(tori_geom(1, f, k)[1:])),
                                  "numeric": tori_volume_numeric(1, f, k)}
                           for name, f, k in (("ASME_FD", 1, 0.06), ("ASME_80_10", 0.8, 0.1), ("DIN28011", 1, 0.1), ("DIN28013", 0.8, 0.154))}
    out["ellipsoidalArea"] = [sa_ellipsoidal(2, 1), sa_ellipsoidal(2, 0.999), sa_ellipsoidal(2, 1.5)]
    out["asme"] = {
        "UG27-A": ug27_c1(100, 30, 18800, 1.0), "UG27-B": ug27_c1(200, 23, 20000, 0.85, 0.125),
        "UG27-C": [ug27_c1(250, 36, 20000, 1.0, 0.125, False), ug27_c1(250, 36, 20000, 1.0, 0.125, True)],
        "UG32E-A": ug32_ellipsoidal(250, 72, 20000, 1.0), "UG32E-B": ug32_ellipsoidal(434, 120, 17500, 1.0),
        "UG32T": [ug32_torispherical(100, 12, 20000, 1.0), ug32_torispherical(100, 4, 20000, 1.0)],
    }
    out["api650_ppns"] = api650(7.7, 10.2, 0.895, 137, 154, 3)
    # SC-EQP-01: vertical vessel, ID 1500, T/T 4000, 2:1 heads, t 10/10, CA 3, P 1.0 MPa, S 137.9, E 1, skirt 2000 x 10
    sc1 = vessel(1.5, 4.0, 0.010, 0.010, 0.003, 137.9, 1.0, 1.0, 1.0, skirt=(1.52, 0.010, 2.0))
    level = 0.375 + 1.5
    sc1["operatingLiquid_m3"] = v_vert_ellipsoidal(1.5, 0.375, level)
    sc1["bodyOperating_kg"] = sc1["bodyEmpty_kg"] + 850.0 * sc1["operatingLiquid_m3"]
    out["SC-EQP-01"] = sc1
    # SC-EQP-02: horizontal drum, ID 2000, T/T 6000, shell 18 (E 0.85), heads 16 (seamless E 1), CA 3, P 1.5 MPa
    sc2 = vessel(2.0, 6.0, 0.018, 0.016, 0.003, 137.9, 0.85, 1.0, 1.5)
    sc2["liquid_h1000_m3"] = v_horiz_ellipsoidal(2.0, 6.0, 0.5, 1.0)
    sc2["liquid_h500_m3"] = v_horiz_ellipsoidal(2.0, 6.0, 0.5, 0.5)
    sc2["undersized12mm_trShell_mm"] = ug27_c1(1.5, 1.0, 137.9, 0.85, 0.003) * 1000
    out["SC-EQP-02"] = sc2
    # SC-EQP-03: BEM exchanger, shell ID 600, tubes 19.05 x 1.651 (3/4 in BWG 16), 300 tubes, tube length 4877, tubesheets 50, channels 300
    Ds, Lt, ts, n, do = 0.6, 4.877, 0.05, 300, 0.01905
    di = do - 2 * 0.001651
    between = Lt - 2 * ts
    bonnet = pi / 4 * Ds * Ds * 0.3 + pi * Ds**3 / 24
    out["SC-EQP-03"] = {
        "tubeId_m": di, "shellSide_m3": pi / 4 * Ds * Ds * between - n * pi / 4 * do * do * between,
        "tubeBore_m3": n * pi / 4 * di * di * Lt, "bonnetEach_m3": bonnet, "tubeSide_m3": n * pi / 4 * di * di * Lt + 2 * bonnet,
        "insideOverallLength_m": Lt + 2 * (0.3 + Ds / 4),
    }
    # SC-EQP-04: API 650 tank D 20 m, H 12 m, six 2 m courses, G 1.0, A36M Sd 160 St 171, CA 1.5 mm
    courses = []
    for i in range(6):
        H = 12.0 - 2.0 * i
        td, tt = api650(20.0, H, 1.0, 160.0, 171.0, 1.5)
        courses.append({"course": i + 1, "H_m": H, "td_mm": td, "tt_mm": tt, "governing_mm": max(td, tt, 6.0)})
    out["SC-EQP-04"] = {"courses": courses, "volumeToH_m3": pi / 4 * 400 * 12.0}
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
