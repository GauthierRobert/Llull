"""Derive the closed-form expected values of the 12 CFD pack (stdlib only, deterministic).

Run from this folder: python3 -I derive_references.py  ->  data/analytic_references.json
Every value is a closed form of a cited model (see sources.md); nothing here runs llull.
"""

import json
import math

GAMMA = 1.4


def sig(x: float, digits: int = 10) -> float:
    return float(f"{x:.{digits}g}")


# --- VC-CFD-30: Sod shock tube, exact Riemann solution (Toro, ch. 4) -----------------------------
def sod() -> dict:
    rl, ul, pl = 1.0, 0.0, 1.0
    rr, ur, pr = 0.125, 0.0, 0.1
    g = GAMMA
    al, ar = math.sqrt(g * pl / rl), math.sqrt(g * pr / rr)

    def f(p: float, rk: float, pk: float, ak: float) -> tuple[float, float]:
        if p > pk:  # shock
            a_k, b_k = 2 / ((g + 1) * rk), (g - 1) / (g + 1) * pk
            q = math.sqrt(a_k / (p + b_k))
            return (p - pk) * q, q * (1 - (p - pk) / (2 * (b_k + p)))
        pr_ = p / pk  # rarefaction
        return 2 * ak / (g - 1) * (pr_ ** ((g - 1) / (2 * g)) - 1), pr_ ** (-(g + 1) / (2 * g)) / (rk * ak)

    p = 0.5 * (pl + pr)
    for _ in range(100):
        fl, dl = f(p, rl, pl, al)
        fr, dr = f(p, rr, pr, ar)
        step = (fl + fr + ur - ul) / (dl + dr)
        p -= step
        if abs(step) < 1e-15:
            break
    fl, _ = f(p, rl, pl, al)
    fr, _ = f(p, rr, pr, ar)
    u = 0.5 * (ul + ur) + 0.5 * (fr - fl)
    rho_l = rl * (p / pl) ** (1 / g)
    gm = (g - 1) / (g + 1)
    rho_r = rr * ((p / pr + gm) / (gm * p / pr + 1))
    shock_speed = ur + ar * math.sqrt((g + 1) / (2 * g) * p / pr + (g - 1) / (2 * g))
    a_star_l = al * (p / pl) ** ((g - 1) / (2 * g))
    t, x0 = 0.2, 0.5
    return {
        "id": "VC-CFD-30",
        "model": "Sod (1978) initial data, exact Riemann solution (Toro 2009, ch. 4), gamma 1.4",
        "initial": {"left": {"rho": rl, "u": ul, "p": pl}, "right": {"rho": rr, "u": ur, "p": pr}, "x0": x0},
        "star": {"p": sig(p), "u": sig(u), "rhoLeft": sig(rho_l), "rhoRight": sig(rho_r)},
        "waves": {
            "shockSpeed": sig(shock_speed),
            "rarefactionHeadSpeed": sig(ul - al),
            "rarefactionTailSpeed": sig(u - a_star_l),
            "contactSpeed": sig(u),
        },
        "positionsAtT02": {
            "rarefactionHead": sig(x0 + (ul - al) * t),
            "rarefactionTail": sig(x0 + (u - a_star_l) * t),
            "contact": sig(x0 + u * t),
            "shock": sig(x0 + shock_speed * t),
        },
    }


# --- VC-CFD-31: oblique shock on a wedge (NACA 1135 eq. 148, weak branch) ------------------------
def oblique(mach: float, theta_deg: float) -> dict:
    th = math.radians(theta_deg)

    def residual(beta: float) -> float:
        return math.tan(th) - 2 / math.tan(beta) * (mach**2 * math.sin(beta) ** 2 - 1) / (
            mach**2 * (GAMMA + math.cos(2 * beta)) + 2
        )

    lo, hi = math.asin(1 / mach) + 1e-12, math.radians(64.0)  # weak branch lies below beta_max (~64.7 deg at M 2)
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        if residual(lo) * residual(mid) <= 0:
            hi = mid
        else:
            lo = mid
    beta = 0.5 * (lo + hi)
    mn1 = mach * math.sin(beta)
    p21 = 1 + 2 * GAMMA / (GAMMA + 1) * (mn1**2 - 1)
    r21 = (GAMMA + 1) * mn1**2 / ((GAMMA - 1) * mn1**2 + 2)
    mn2 = math.sqrt((1 + (GAMMA - 1) / 2 * mn1**2) / (GAMMA * mn1**2 - (GAMMA - 1) / 2))
    m2 = mn2 / math.sin(beta - th)
    cp = (p21 - 1) / (0.5 * GAMMA * mach**2)
    return {
        "mach": mach,
        "wedgeHalfAngleDeg": theta_deg,
        "shockAngleDeg": sig(math.degrees(beta)),
        "pressureRatio": sig(p21),
        "densityRatio": sig(r21),
        "downstreamMach": sig(m2),
        "surfaceCp": sig(cp),
    }


# --- VC-CFD-32: stagnation point behind a normal shock (Rayleigh pitot formula, NACA 1135 eq. 100) -
def pitot(mach: float) -> dict:
    g = GAMMA
    p02_p1 = ((g + 1) ** 2 * mach**2 / (4 * g * mach**2 - 2 * (g - 1))) ** (g / (g - 1)) * (
        1 - g + 2 * g * mach**2
    ) / (g + 1)
    cp_max = (p02_p1 - 1) / (0.5 * g * mach**2)
    return {"mach": mach, "pitotPressureRatio": sig(p02_p1), "stagnationCp": sig(cp_max)}


def subsonic_stagnation(mach: float) -> dict:
    g = GAMMA
    p0_p = (1 + (g - 1) / 2 * mach**2) ** (g / (g - 1))
    return {"mach": mach, "stagnationPressureRatio": sig(p0_p), "stagnationCp": sig((p0_p - 1) / (0.5 * g * mach**2))}


# --- VC-CFD-21: sphere drag, Schiller & Naumann correlation (Re < 800) ----------------------------
def schiller_naumann(re: float) -> float:
    return 24 / re * (1 + 0.15 * re**0.687)


# --- VC-CFD-20: plane Poiseuille flow (exact) ---------------------------------------------------
def poiseuille() -> dict:
    return {
        "id": "VC-CFD-20",
        "model": "u(y) = 4 Umax y (H - y) / H^2, dp/dx = -8 mu Umax / H^2, wall shear 4 mu Umax / H",
        "meanOverMax": sig(2 / 3),
        "pressureGradientCoefficient": 8.0,
        "wallShearCoefficient": 4.0,
    }


# --- VC-CFD-22: 2D Taylor-Green vortex decay (exact Navier-Stokes solution) ---------------------
def taylor_green() -> dict:
    nu, k, t = 0.01, 2 * math.pi, 1.0
    return {
        "id": "VC-CFD-22",
        "model": "u = U0 sin(kx) cos(ky) F(t), v = -U0 cos(kx) sin(ky) F(t), F = exp(-2 nu k^2 t)",
        "case": {"nu": nu, "k": sig(k), "t": t},
        "amplitudeRatio": sig(math.exp(-2 * nu * k * k * t)),
        "kineticEnergyRatio": sig(math.exp(-4 * nu * k * k * t)),
    }


# --- VC-CFD-40: streamlines in potential flow about a sphere (Stokes stream function) ------------
def sphere_stream() -> dict:
    r_sphere, u_inf = 1.0, 1.0
    seeds = []
    for y0 in (0.25, 0.5, 1.0, 1.5):
        x0 = -10.0
        r = math.hypot(x0, y0)
        sin_t = y0 / r
        psi = 0.5 * u_inf * r * r * sin_t * sin_t * (1 - r_sphere**3 / r**3)
        # far-downstream radius where psi(r, theta) equals psi0 at x = +10
        x1 = 10.0
        lo, hi = 0.0, 5.0
        for _ in range(200):
            mid = 0.5 * (lo + hi)
            rr = math.hypot(x1, mid)
            val = 0.5 * u_inf * rr * rr * (mid / rr) ** 2 * (1 - r_sphere**3 / rr**3)
            lo, hi = (mid, hi) if val < psi else (lo, mid)
        # minimum radial distance from the axis at x = 0 (theta = 90 deg): psi = 1/2 U y^2 (1 - R^3/y^3)
        lo2, hi2 = r_sphere, 5.0
        for _ in range(200):
            mid = 0.5 * (lo2 + hi2)
            val = 0.5 * u_inf * mid * mid * (1 - r_sphere**3 / mid**3)
            lo2, hi2 = (mid, hi2) if val < psi else (lo2, mid)
        seeds.append({"seed": [x0, sig(y0), 0.0], "psi": sig(psi), "yAtXPlus10": sig(0.5 * (lo + hi)), "yAtX0": sig(0.5 * (lo2 + hi2))})
    return {
        "id": "VC-CFD-40",
        "model": "psi = 1/2 U r^2 sin^2(theta) (1 - R^3/r^3), axisymmetric potential flow, R = 1, U = 1",
        "seeds": seeds,
    }


# --- VC-CFD-10: voxelised sphere volume bound ---------------------------------------------------
def voxel_bound() -> dict:
    rows = []
    for n in (16, 32, 64):
        h_over_r = 1 / n
        # every cut cell lies within h*sqrt(3)/2 of the surface: |V_vox - V| <= A * h*sqrt(3)/2
        rel = 4 * math.pi * 1 * (math.sqrt(3) / 2 * h_over_r) / (4 / 3 * math.pi)
        rows.append({"cellsPerRadius": n, "relativeVolumeBound": sig(rel, 6)})
    return {"id": "VC-CFD-10", "model": "|V_vox - V| <= A_surface * (sqrt(3)/2) h", "rows": rows}


def blockage() -> dict:
    # AIJ / COST 732 sized tunnel around a 1:1:2 block (B = D = H/2): width B + 2*5H, height H + 5H
    h, b = 2.0, 1.0
    width, height = b + 2 * 5 * h, h + 5 * h
    return {
        "id": "VC-CFD-12",
        "model": "blockage = frontal area / tunnel cross-section; domain 5H lateral, 5H above, 5H upstream, 15H downstream",
        "case": {"buildingB": b, "buildingH": h, "tunnelWidth": width, "tunnelHeight": height},
        "blockageRatio": sig(b * h / (width * height)),
        "limit": 0.03,
    }


def main() -> None:
    out = {
        "pack": "12 CFD",
        "generatedBy": "derive_references.py (closed forms only)",
        "gamma": GAMMA,
        "sod": sod(),
        "obliqueShock": {"id": "VC-CFD-31", "model": "theta-beta-M relation, weak branch (NACA 1135)", "cases": [oblique(2.0, 10.0), oblique(3.0, 15.0)]},
        "stagnation": {
            "id": "VC-CFD-32",
            "model": "Rayleigh pitot formula (supersonic) / isentropic stagnation (subsonic), NACA 1135",
            "supersonic": [pitot(2.0), pitot(2.5)],
            "subsonic": [subsonic_stagnation(0.3), subsonic_stagnation(0.8)],
        },
        "sphereDrag": {
            "id": "VC-CFD-21",
            "model": "Cd = 24/Re (1 + 0.15 Re^0.687), Schiller & Naumann (1933), Re < 800",
            "rows": [{"re": re, "cd": sig(schiller_naumann(re), 6)} for re in (20, 50, 100, 200)],
        },
        "poiseuille": poiseuille(),
        "taylorGreen": taylor_green(),
        "sphereStreamlines": sphere_stream(),
        "voxelSphere": voxel_bound(),
        "blockage": blockage(),
        "shockStandoff": {
            "id": "VC-CFD-33",
            "model": "Billig (1967) sphere: delta/R = 0.143 exp(3.24/M^2), gamma 1.4 (grade B: documentation band, not a gate)",
            "rows": [{"mach": m, "deltaOverR": sig(0.143 * math.exp(3.24 / m**2), 6)} for m in (2.0, 2.5, 3.0)],
        },
    }
    with open("data/analytic_references.json", "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2)
        fh.write("\n")


if __name__ == "__main__":
    main()
