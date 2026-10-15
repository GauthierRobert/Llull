#!/usr/bin/env python3
"""
Generate the reference datasets of PHY-06 (nonlinear contact, friction, bolt preload; prefix CNT).

Run:  python3 -I generate_cnt_reference.py      (stdlib only, deterministic, writes next to this script)

Outputs
  expected_results.json        cases in the physics README section 6.3 schema
  hertz_line_ssnp154.csv       Hertz pressure profile p(x) for the code_aster SSNP154 cylinder-on-block case
  hertz_subsurface.csv         stresses on the load axis below a Hertz contact (sphere and line contact)
  bolted_joint_nasa5020.json   worked NASA-STD-5020 (2012 baseline) joint example: every intermediate value

Formulas
  Hertz (frictionless, elastic, small contact):
    1/E* = (1-nu1^2)/E1 + (1-nu2^2)/E2,  1/R = 1/R1 + 1/R2
    line contact, load P' per unit length:   b = sqrt(4 P' R / (pi E*)),  p0 = 2 P' / (pi b)
    point contact (spheres), load P:         a = (3 P R / (4 E*))^(1/3),  p0 = 3 P / (2 pi a^2),  delta = a^2 / R
    displacement-driven spheres:             a = sqrt(R delta),  p0 = (2 E* / pi) sqrt(delta / R),  P = (4/3) E* sqrt(R) delta^1.5
  The two code_aster test files (SSNP154, SSNV104) print their analytic reference values; the generator reproduces them
  from the inputs read in those files (radius of SSNP154 inferred from the reference values, see sources.md S2).
  Subsurface stresses on the axis: Johnson, Contact Mechanics (1985) eqs. 3.45 (sphere) and 2.34-type line-contact
  expressions — NOT fetched in this session, so those cases are grade B.
  Interference fit: Lame thick cylinders in plane stress; contact pressure from radial displacement compatibility,
  solved numerically from the Lame displacement functions (no handbook formula is quoted).
  Bolted joints: NASA-STD-5020 (2012) eqs. 6-2..6-5b, 6-7..6-11, 6-23, A.2-1..3b, A.10-4..6 (fetched).
"""

from __future__ import annotations

import csv
import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))


def out(name: str) -> str:
    return os.path.join(HERE, name)


def r12(x: float) -> float:
    if x == 0 or not math.isfinite(x):
        return x
    return float(f"{x:.12g}")


def estar(E1, nu1, E2, nu2):
    return 1.0 / ((1 - nu1 ** 2) / E1 + (1 - nu2 ** 2) / E2)


def rstar(R1, R2):
    inv = (0.0 if R1 is None else 1.0 / R1) + (0.0 if R2 is None else 1.0 / R2)
    return 1.0 / inv


def hertz_line(P_line, R, Es):
    b = math.sqrt(4 * P_line * R / (math.pi * Es))
    return b, 2 * P_line / (math.pi * b)


def hertz_sphere_force(P, R, Es):
    a = (3 * P * R / (4 * Es)) ** (1.0 / 3.0)
    return a, 3 * P / (2 * math.pi * a * a), a * a / R


def hertz_sphere_disp(delta, R, Es):
    a = math.sqrt(R * delta)
    p0 = 2 * Es / math.pi * math.sqrt(delta / R)
    P = 4.0 / 3.0 * Es * math.sqrt(R) * delta ** 1.5
    return a, p0, P


def sphere_axis(z_over_a, nu):
    """Johnson (1985) eq. 3.45 on the axis, stresses / p0 (compressive negative)."""
    z = z_over_a
    sz = -1.0 / (1 + z * z)
    sr = -((1 + nu) * (1 - z * math.atan(1 / z)) - 0.5 / (1 + z * z)) if z > 0 else -(1 + 2 * nu) / 2
    return sr, sz, 0.5 * abs(sr - sz)


def line_axis(z_over_b):
    """Plane-strain line contact on the axis (McEwen form), stresses / p0."""
    z = z_over_b
    s = math.sqrt(1 + z * z)
    sx = -((1 + 2 * z * z) / s - 2 * z)
    sz = -1.0 / s
    return sx, sz, 0.5 * abs(sx - sz)


def argmax(f, lo, hi, n=4000):
    best = None
    for i in range(1, n + 1):
        x = lo + (hi - lo) * i / n
        v = f(x)
        if best is None or v > best[1]:
            best = (x, v)
    # golden refinement
    a, b = best[0] - (hi - lo) / n, best[0] + (hi - lo) / n
    g = (math.sqrt(5) - 1) / 2
    for _ in range(200):
        c, d = b - g * (b - a), a + g * (b - a)
        if f(c) > f(d):
            b = d
        else:
            a = c
    x = 0.5 * (a + b)
    return x, f(x)


# Lame plane stress: u(r) = A r + B / r ; sigma_r = E/(1-nu^2) [(1+nu) A - (1-nu) B / r^2]
def lame_u(ri, ro, p_in, p_out, E, nu, r):
    # sigma_r(ri) = -p_in, sigma_r(ro) = -p_out
    k = E / (1 - nu * nu)
    # unknowns A, B: k[(1+nu)A - (1-nu)B/ri^2] = -p_in ; same at ro
    a11, a12, b1 = k * (1 + nu), -k * (1 - nu) / ri ** 2, -p_in
    a21, a22, b2 = k * (1 + nu), -k * (1 - nu) / ro ** 2, -p_out
    det = a11 * a22 - a12 * a21
    A = (b1 * a22 - a12 * b2) / det
    B = (a11 * b2 - b1 * a21) / det
    return A * r + B / r


def interference_pressure(a, b, c, delta_r, Ei, nui, Eo, nuo):
    """Shaft/inner ring a..b (a = 0 allowed via tiny bore), hub b..c; radial interference delta_r at r = b."""
    f = lambda p: lame_u(b, c, p, 0.0, Eo, nuo, b) - lame_u(max(a, 1e-9 * b), b, 0.0, p, Ei, nui, b) - delta_r  # noqa: E731
    lo, hi = 0.0, 1.0
    while f(hi) < 0:
        hi *= 2
    for _ in range(300):
        mid = 0.5 * (lo + hi)
        if f(mid) < 0:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


def main() -> None:
    cases = []

    def case(cid, quantity, value, unit, tol, source, grade, proves, **extra):
        c = {"id": cid, "quantity": quantity, "value": r12(value) if isinstance(value, float) else value, "unit": unit,
             "tolerance": tol, "source": source, "grade": grade, "proves": proves}
        c.update(extra)
        cases.append(c)

    # ---- 1. SSNP154 / NAFEMS cylinder roller (plane strain, half model with FY = -17500 per unit thickness)
    E_cy, E_bl, nu = 210000.0, 70000.0, 0.3
    Es = estar(E_cy, nu, E_bl, nu)
    P_line = 2 * 17500.0                              # N per mm of length (symmetric half model carries 17 500)
    a_ref, p0_ref = 6.21, 3585.37                      # printed in ssnp154a.comm as the analytic solution
    R_inferred = a_ref ** 2 * math.pi * Es / (4 * P_line)
    R = 50.0
    b, p0 = hertz_line(P_line, R, Es)
    with open(out("hertz_line_ssnp154.csv"), "w", newline="") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["x_mm", "p_MPa"])
        for i in range(0, 41):
            x = b * i / 40
            w.writerow([repr(r12(x)), repr(r12(p0 * math.sqrt(max(0.0, 1 - (x / b) ** 2))))])
    inp = {"E_cylinder_MPa": E_cy, "E_block_MPa": E_bl, "nu": nu, "R_mm": R, "P_per_length_N_per_mm": P_line}
    case("VC-CNT-10.a", "Hertz line contact half-width b, cylinder R = 50 mm on block, 35 000 N/mm", b, "mm", {"rel": 0.02},
         "generator + S2 (code_aster SSNP154 analytic a = 6.21) ", "A", ["FR-CNT-01", "FR-CNT-08", "TR-CNT-20"], inputs=inp,
         quotedBySource=a_ref, R_inferred_from_reference_mm=r12(R_inferred),
         note="load is per unit length (plane strain): resolves '35 kN vs 35 kN/mm' as 35 kN per mm of roller length")
    case("VC-CNT-10.b", "Hertz line contact peak pressure p0", p0, "MPa", {"rel": 0.02},
         "generator + S2 (SSNP154 p0 = 3585.37; code_aster's own FE check tolerance 0.4 %)", "A",
         ["FR-CNT-01", "FR-CNT-08", "TR-CNT-20"], inputs=inp, quotedBySource=p0_ref,
         relDiffToQuoted=r12(p0 / p0_ref - 1))

    # ---- 2. SSNV104 two spheres, displacement driven
    E, nu = 20000.0, 0.3
    Es2 = estar(E, nu, E, nu)
    R2 = rstar(50.0, 50.0)
    delta = 4.0                                        # total approach h = 2 x 2 mm (DY = -2 on the half model)
    a2, p02, P2 = hertz_sphere_disp(delta, R2, Es2)
    inp2 = {"E_MPa": E, "nu": nu, "R1_mm": 50.0, "R2_mm": 50.0, "approach_mm": delta}
    case("VC-CNT-11.a", "Hertz sphere-sphere peak pressure p0 (SSNV104)", p02, "MPa", {"rel": 0.02},
         "generator + S3 (code_aster SSNV104 VALE_REFE -2798.3)", "A", ["FR-CNT-01", "FR-CNT-08"], inputs=inp2,
         quotedBySource=2798.3, relDiffToQuoted=r12(p02 / 2798.3 - 1),
         note="FE gate: sigma_yy at the contact centre; code_aster's own linear-element run is 13.5 % off (PRECISION 0.14), so the FE gate uses quadratic elements and 5 %")
    case("VC-CNT-11.b", "Hertz sphere-sphere contact radius a (SSNV104)", a2, "mm", {"rel": 0.05}, "generator", "A",
         ["FR-CNT-01", "FR-CNT-08"], inputs=inp2)
    case("VC-CNT-11.c", "Hertz sphere-sphere total force for 4 mm approach (SSNV104 geometry)", P2, "N", {"rel": 0.03}, "generator", "A",
         ["FR-CNT-01", "FR-CNT-08"], inputs=inp2, derivation="P = (4/3) E* sqrt(R*) delta^1.5")
    a3, p03, d3 = hertz_sphere_force(1000.0, 10.0, estar(210000.0, 0.3, 210000.0, 0.3))
    case("VC-CNT-12", "Hertz steel ball R = 10 mm on a steel flat, P = 1000 N: contact radius", a3, "mm", {"rel": 1e-9},
         "generator (formula check for hertz_contact)", "A", ["FR-CNT-08"],
         inputs={"E_MPa": 210000.0, "nu": 0.3, "R_mm": 10.0, "P_N": 1000.0},
         extra={"p0_MPa": r12(p03), "approach_mm": r12(d3)})

    # ---- 3. subsurface maxima (grade B: formulas from Johnson 1985, not fetched)
    zs, ts = argmax(lambda z: sphere_axis(z, 0.3)[2], 0.01, 3.0)
    zl, tl = argmax(lambda z: line_axis(z)[2], 0.01, 3.0)
    with open(out("hertz_subsurface.csv"), "w", newline="") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["z_over_a", "sphere_sr_over_p0", "sphere_sz_over_p0", "sphere_tau_over_p0", "line_sx_over_p0", "line_sz_over_p0",
                    "line_tau_over_p0"])
        for i in range(1, 31):
            z = 0.1 * i
            s1 = sphere_axis(z, 0.3)
            s2 = line_axis(z)
            w.writerow([repr(r12(z))] + [repr(r12(v)) for v in s1 + s2])
    case("VC-CNT-13.a", "sphere contact: max shear stress on axis / p0 (nu = 0.3)", ts, "1", {"rel": 0.01},
         "generator from Johnson 1985 eq. 3.45 (formula not fetched)", "B", ["FR-CNT-08"], depthOverA=r12(zs))
    case("VC-CNT-13.b", "line contact: max shear stress on axis / p0", tl, "1", {"rel": 0.01},
         "generator from the plane-strain axis stresses (formula not fetched)", "B", ["FR-CNT-08"], depthOverB=r12(zl))

    # ---- 4. interference fit (plane stress Lame), steel hub on steel shaft
    a_i, b_i, c_i, dr = 0.0, 20.0, 40.0, 0.01
    pfit = interference_pressure(a_i, b_i, c_i, dr, 210000.0, 0.3, 210000.0, 0.3)
    hoop_hub_bore = pfit * (c_i ** 2 + b_i ** 2) / (c_i ** 2 - b_i ** 2)
    finp = {"shaft_radius_mm": b_i, "hub_outer_radius_mm": c_i, "radial_interference_mm": dr, "E_MPa": 210000.0, "nu": 0.3,
            "plane": "stress"}
    case("VC-CNT-20.a", "interference-fit contact pressure, solid steel shaft r = 20 mm in steel hub r_o = 40 mm, radial interference 0.01 mm",
         pfit, "MPa", {"rel": 0.02}, "generator (Lame compatibility)", "A", ["FR-CNT-01", "FR-CNT-09"], inputs=finp)
    case("VC-CNT-20.b", "hub hoop stress at the bore", hoop_hub_bore, "MPa", {"rel": 0.03}, "generator (Lame)", "A",
         ["FR-CNT-09"], inputs=finp, derivation="sigma_theta = p (c^2 + b^2)/(c^2 - b^2)")

    # ---- 5. friction block (sticking vs sliding) — Coulomb
    N, mu = 1000.0, 0.2
    case("VC-CNT-30.a", "Coulomb slip threshold of a block pressed with 1000 N, mu = 0.2", mu * N, "N", {"rel": 0.02},
         "generator (Coulomb)", "A", ["FR-CNT-02"], inputs={"N_N": N, "mu": mu},
         note="FE: tangential reaction plateau under tangential displacement control; ccx stick slope makes the pre-slip branch elastic")

    # ---- 6. NASA-STD-5020 (2012) bolted joint worked example (inputs are test inputs, not hardware data)
    j = {"inputs": {"T_nom_Nm": 10.0, "T_tol_Nm": 0.5, "K_nom": 0.2, "D_mm": 6.35, "Gamma_lubricated": 0.25, "n_f": 4,
                    "relaxation_fraction": 0.05, "creep_N": 0.0, "dT_max_N": 0.0, "dT_min_N": 0.0, "k_b_N_per_mm": 200000.0,
                    "k_c_N_per_mm": 600000.0, "n_loading_plane": 0.5, "P_tu_allow_N": 20000.0, "PtL_N": 2000.0, "PsL_joint_N": 3000.0,
                    "PtL_joint_N": 4000.0, "FS_sep": 1.2, "FS_u": 1.4, "FS_slip": 1.2, "FF": 1.0, "mu": 0.2},
         "note": "test inputs chosen for arithmetic only; FS values are illustrative inputs, NOT the standard's (its Figure 1 "
                 "values were not readable from the text extract)"}
    I = j["inputs"]
    T_max, T_min = I["T_nom_Nm"] + I["T_tol_Nm"], I["T_nom_Nm"] - I["T_tol_Nm"]
    KD = I["K_nom"] * I["D_mm"] / 1000.0               # m
    Ppi_nom = I["T_nom_Nm"] / KD
    Ppi_max = (1 + I["Gamma_lubricated"]) * T_max / KD
    Ppi_min_sepcrit = (1 - I["Gamma_lubricated"]) * T_min / KD
    Ppi_min_slip = (1 - I["Gamma_lubricated"] / I["n_f"]) * T_min / KD
    def pmin(ppi):
        return ppi - I["relaxation_fraction"] * ppi - I["creep_N"] - I["dT_min_N"]
    Pp_max = Ppi_max + I["dT_max_N"]
    Pp_min_sep = pmin(Ppi_min_sepcrit)
    Pp_min_slip = pmin(Ppi_min_slip)
    phi = I["k_b_N_per_mm"] / (I["k_b_N_per_mm"] + I["k_c_N_per_mm"])
    nphi = I["n_loading_plane"] * phi
    P_tu_prime = (I["P_tu_allow_N"] - Pp_max) / nphi
    P_sep_prime = Pp_max / (1 - nphi)
    MS_sep = Pp_min_sep / (I["FF"] * I["FS_sep"] * I["PtL_N"]) - 1
    MS_u_rupture_first = P_tu_prime / (I["FF"] * I["FS_u"] * I["PtL_N"]) - 1
    MS_slip_joint = I["n_f"] * I["mu"] * Pp_min_slip / (I["FS_slip"] * (I["PsL_joint_N"] + I["mu"] * I["PtL_joint_N"])) - 1
    MS_slip_noTension = I["n_f"] * I["mu"] * Pp_min_slip / (I["FS_slip"] * I["PsL_joint_N"]) - 1
    j["results"] = {k: r12(v) for k, v in {
        "Ppi_nom_N": Ppi_nom, "Ppi_max_N": Ppi_max, "Ppi_min_separation_critical_N": Ppi_min_sepcrit,
        "Ppi_min_slip_and_non_critical_N": Ppi_min_slip, "Pp_max_N": Pp_max, "Pp_min_separation_N": Pp_min_sep,
        "Pp_min_slip_N": Pp_min_slip, "phi": phi, "n_phi": nphi, "P_tu_prime_N": P_tu_prime, "P_sep_prime_N": P_sep_prime,
        "MS_sep": MS_sep, "MS_u_if_rupture_before_separation": MS_u_rupture_first, "MS_slip_joint_A10_4": MS_slip_joint,
        "MS_slip_no_tension_A10_5": MS_slip_noTension}.items()}
    j["results"]["separation_before_rupture"] = P_sep_prime < P_tu_prime
    j["equations"] = {"Ppi_nom": "A.2-1 T/(K D)", "Ppi_max": "A.2-2 (1+G) Tmax/(K D)", "Ppi_min_sepcrit": "A.2-3a (1-G) Tmin/(K D)",
                      "Ppi_min_slip": "A.2-3b (1-G/nf) Tmin/(K D)", "Pp_max": "6-2", "Pp_min": "6-3 with Table 1 (5 % relaxation, all-metal)",
                      "phi": "6-8", "P_tu_prime": "6-9", "P_sep_prime": "6-10", "MS_sep": "6-23", "MS_u": "6-11",
                      "MS_slip": "A.10-4 / A.10-5"}
    with open(out("bolted_joint_nasa5020.json"), "w") as fh:
        json.dump(j, fh, indent=1)
        fh.write("\n")
    src5020 = "S5 NASA-STD-5020 (2012 baseline, fetched) equations; generator arithmetic"
    case("VC-CNT-40.a", "minimum preload for separation of a separation-critical joint, Pp-min", Pp_min_sep, "N", {"rel": 1e-9},
         src5020, "A", ["FR-CNT-05", "FR-CNT-06"], inputs=I)
    case("VC-CNT-40.b", "minimum preload for joint slip, Pp-min (Gamma / n_f)", Pp_min_slip, "N", {"rel": 1e-9}, src5020, "A",
         ["FR-CNT-05", "FR-CNT-06"])
    case("VC-CNT-40.c", "maximum preload Pp-max", Pp_max, "N", {"rel": 1e-9}, src5020, "A", ["FR-CNT-05"])
    case("VC-CNT-40.d", "margin of safety for separation MS_sep (eq. 6-23)", MS_sep, "1", {"abs": 1e-9}, src5020, "A",
         ["FR-CNT-06", "FR-CNT-12"])
    case("VC-CNT-40.e", "margin of safety for joint slip MS_slip (eq. A.10-4)", MS_slip_joint, "1", {"abs": 1e-9}, src5020, "A",
         ["FR-CNT-06"])
    case("VC-CNT-40.f", "linear-theory separation load at max preload P'sep (eq. 6-10)", P_sep_prime, "N", {"rel": 1e-9}, src5020,
         "A", ["FR-CNT-06"])
    case("VC-CNT-40.g", "bolt_joint_check with mu = 0.3 on uncoated metal and no test substantiation", "CNT_FRICTION_ABOVE_CAP", "code",
         {"exact": True}, "S5 section 6.4 (mu <= 0.2 uncoated clean metal, 0.1 otherwise, unless test-substantiated)", "A",
         ["FR-CNT-06", "FR-CNT-14"])
    case("VC-CNT-40.h", "torque-controlled preload variation used when no test data is given (lubricated / dry)", "0.25 / 0.35", "1",
         {"exact": True}, "S5 section 6.1.d(1)A (named default, defaulted: true)", "A", ["FR-CNT-05", "FR-CNT-14"])

    case("VC-CNT-40.i", "bolted_joint_check on a separation-critical joint without test-derived Gamma", "CNT_GAMMA_TEST_DATA_REQUIRED",
         "code", {"exact": True}, "S5 section 6.1.c", "A", ["FR-CNT-05"])

    # ---- 7. pretension FE (pinned ccx deck) and contact contract
    case("VC-CNT-50", "pinned ccx decks pret1 / pret2 / bolt / contact1 / friction1 / hueeber1_mortar reproduce their .dat.ref",
         "TBD", "mixed", {"rel": 1e-4}, "S1 test suite (extract with the M2 reader, then freeze)", "TBD", ["FR-CNT-01", "FR-CNT-03", "TR-CNT-10"])
    case("VC-CNT-51", "bolt pretension section with 10 kN force: summed axial section force in the bolt after the preload step", 10000.0,
         "N", {"rel": 0.005}, "S1 manual *PRE-TENSION SECTION (mean force equals the applied force by MPC construction)", "A",
         ["FR-CNT-03"], note="exact by construction; checks the deck writer and the RF read-back")
    case("VC-CNT-52", "V1 bolted flange FE: separation load and n*phi vs bolted_joint_check", "TBD", "N", {"rel": None},
         "TBD - measure", "TBD", ["FR-CNT-04", "FR-CNT-07"])
    case("VC-CNT-64", "V1 joint_from_fastener_stack and pin-in-hole template", "TBD", "mixed", {"rel": None}, "TBD - measure", "TBD",
         ["FR-CNT-10", "FR-CNT-11"])
    case("VC-CNT-65", "check_contact on wrong set-ups", "CNT_INITIAL_OVERCLOSURE, CNT_RIGID_BODY_BY_CONTACT_ONLY, "
         "CNT_BEHAVIOUR_FORMULATION_MISMATCH", "codes", {"exact": True}, "TECHNICAL_SPEC 7.1", "A", ["FR-CNT-17", "FR-CNT-18"])
    case("VC-CNT-60", "contact pairs of different TYPE in one analysis", "CNT_MIXED_CONTACT_TYPES", "code", {"exact": True},
         "S1 manual *CONTACT PAIR (all pairs in a deck must be of the same type)", "A", ["FR-CNT-01", "FR-CNT-13"])
    case("VC-CNT-61", "add_contact_pair with friction and no stick slope", "named default lambda = E1/2 reported", "shape",
         {"exact": True}, "S1 manual *FRICTION default (first elastic constant / 2)", "A", ["FR-CNT-02", "FR-CNT-14"])
    case("VC-CNT-62", "contact_report / check_contact / bolted_joint_check result", "reviewRequired=true", "flag", {"exact": True},
         "AF-33", "A", ["FR-CNT-15"])
    case("VC-CNT-63", "bolted_joint_check from a nut factor flagged unverified", "unverified=true", "flag", {"exact": True}, "AF-32", "A",
         ["FR-CNT-16"])

    doc = {"pack": "06-contact-joints", "generatedBy": "generate_cnt_reference.py",
           "units": "N, mm, MPa unless stated", "cases": cases}
    with open(out("expected_results.json"), "w") as fh:
        json.dump(doc, fh, indent=1)
        fh.write("\n")


if __name__ == "__main__":
    main()
