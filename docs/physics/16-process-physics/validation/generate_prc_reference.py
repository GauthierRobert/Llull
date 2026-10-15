#!/usr/bin/env python3
"""
Generate the reference datasets of PHY-16 (manufacturing process physics, prefix PRC).

Run:  python3 -I generate_prc_reference.py      (stdlib only, deterministic, writes next to this script)

Outputs
  expected_results.json        cases in the physics README section 6.3 schema
  springback_ratio.csv         Ri/Rf and angle ratio vs u = Ri*Y/(E*T), elastic-perfectly plastic pure bending
  springback_compensation.csv  tool radius and tool angle that give a target formed radius / angle (test material)
  layered_eigenstrain.csv      curvature of a layer-by-layer built beam with uniform inherent strain, per layer,
                               and after removing the substrate

1. Springback (pure bending, rectangular section, elastic-perfectly plastic, no Bauschinger, no thinning).
   Loading to curvature k_i = 1/R_i (neutral fibre at mid-thickness): M = M_y * 1.5 * (1 - (k_y/k_i)^2 / 3),
   k_y = 2Y/(E T). Elastic unloading: dk = M / (E I). Hence with u = R_i Y / (E T):
       R_i / R_f = 1 - 3u + 4u^3        (valid for u <= 1/2; u >= 1/2 means the bend stayed elastic)
   This is the form attributed to Gardiner (1957) in secondary sources (not fetched); the script derives it from the
   moment-curvature relation and checks both forms agree. Bend angle: the mid-surface arc length is unchanged, so
   theta_f (R_f + T/2) = theta_i (R_i + T/2). Plane-strain option: E' = E/(1 - nu^2), Y' = 2Y/sqrt(3).
2. Compensation: solve R_i for a target R_f by bisection on the monotone map R_i -> R_f; tool angle from (1).
3. Inherent strain, layered beam (Euler-Bernoulli, plane sections, linear elastic, width b): each new layer is added
   stress free (CalculiX *MODEL CHANGE, ADD=STRAIN FREE) on the current stack and then receives a uniform eigenstrain
   e*; the increment (de0, dk) solves N = 0, M = 0 over the current stack. Superposition gives the build-up. Substrate
   removal releases the substrate's force and moment resultants onto the remaining layers. Cross-check: two-layer case
   against the Timoshenko (1925) bimetal formula (formula from secondary knowledge, not fetched: grade of the
   cross-check only).
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


# ------------------------------------------------------------------------------------------- 1. springback
def springback_direct(Ri: float, T: float, E: float, Y: float) -> float:
    """R_f from moment-curvature + elastic unloading (returns inf if the bend is elastic)."""
    ki = 1.0 / Ri
    ky = 2.0 * Y / (E * T)
    if ki <= ky:
        return math.inf
    My = Y * T * T / 6.0             # per unit width
    M = My * 1.5 * (1.0 - (ky / ki) ** 2 / 3.0)
    dk = M / (E * T ** 3 / 12.0)
    kf = ki - dk
    return math.inf if kf <= 0 else 1.0 / kf


def gardiner_ratio(u: float) -> float:
    return 4.0 * u ** 3 - 3.0 * u + 1.0


def compensate(Rf_target: float, T: float, E: float, Y: float) -> float:
    lo, hi = 1e-6 * T, Rf_target
    for _ in range(300):
        mid = 0.5 * (lo + hi)
        if springback_direct(mid, T, E, Y) < Rf_target:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


# ------------------------------------------------------------------------------------------- 2. layered beam
def section_props(layers):
    """layers: list of (z_bottom, z_top, E). Returns A=sum E t, B=sum E S, D=sum E I about z = 0 (per unit width)."""
    A = B = D = 0.0
    for z0, z1, E in layers:
        A += E * (z1 - z0)
        B += E * (z1 ** 2 - z0 ** 2) / 2.0
        D += E * (z1 ** 3 - z0 ** 3) / 3.0
    return A, B, D


def eigen_increment(layers, idx, estar):
    """Uniform eigenstrain estar in layer idx: solve [A B; B D] [e0; k] = [N*; M*]."""
    A, B, D = section_props(layers)
    z0, z1, E = layers[idx]
    Ns = E * estar * (z1 - z0)
    Ms = E * estar * (z1 ** 2 - z0 ** 2) / 2.0
    det = A * D - B * B
    return (Ns * D - B * Ms) / det, (A * Ms - B * Ns) / det


def build_layers(ts, Es, n_layers, tl, El, estar):
    """Substrate thickness ts (z in [-ts, 0]), n layers of thickness tl on top. Returns history and stress resultants."""
    layers = [(-ts, 0.0, Es)]
    strain_state = {0: (0.0, 0.0)}           # per layer: accumulated (e0, k) since its activation
    eig = {0: 0.0}
    hist = []
    k_total = 0.0
    for i in range(n_layers):
        layers.append((i * tl, (i + 1) * tl, El))
        idx = len(layers) - 1
        strain_state[idx] = (0.0, 0.0)
        eig[idx] = estar
        de0, dk = eigen_increment(layers, idx, estar)
        for j in strain_state:
            e0, k = strain_state[j]
            strain_state[j] = (e0 + de0, k + dk)
        k_total += dk
        hist.append((i + 1, dk, k_total))
    return layers, strain_state, eig, hist


def release_substrate(layers, strain_state, eig):
    """Stress in layer j: E (e0_j + k_j z - eig_j). Remove layer 0: apply -(N0, M0) to the remaining stack."""
    z0, z1, E = layers[0]
    e0, k = strain_state[0]
    N0 = E * (e0 * (z1 - z0) + k * (z1 ** 2 - z0 ** 2) / 2.0)
    M0 = E * (e0 * (z1 ** 2 - z0 ** 2) / 2.0 + k * (z1 ** 3 - z0 ** 3) / 3.0)
    rest = layers[1:]
    A, B, D = section_props(rest)
    det = A * D - B * B
    # the remaining stack carried -N0, -M0 (equilibrium); releasing it means applying +N0, +M0 ... sign: total N = 0 =>
    # N_rest = -N0. After removal N_rest must vanish: increment = solve [A B;B D][de0;dk] = [N0; M0]
    de0 = (N0 * D - B * M0) / det
    dk = (A * M0 - B * N0) / det
    return dk


def timoshenko_bimetal(estar, t1, E1, t2, E2):
    """Curvature of a bimetal strip with mismatch strain estar (layer 1 relative to 2), Timoshenko 1925 form."""
    m, n, h = t1 / t2, E1 / E2, t1 + t2
    return 6.0 * estar * (1 + m) ** 2 / (h * (3 * (1 + m) ** 2 + (1 + m * n) * (m * m + 1.0 / (m * n))))


def main() -> None:
    cases = []

    def case(cid, quantity, value, unit, tol, source, grade, proves, **extra):
        c = {"id": cid, "quantity": quantity, "value": r12(value) if isinstance(value, float) else value, "unit": unit,
             "tolerance": tol, "source": source, "grade": grade, "proves": proves}
        c.update(extra)
        cases.append(c)

    # ---- springback table (dimensionless)
    with open(out("springback_ratio.csv"), "w", newline="") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["u_RiY_over_ET", "Ri_over_Rf", "regime"])
        for i in range(0, 51):
            u = 0.01 * i
            w.writerow([repr(r12(u)), repr(r12(gardiner_ratio(u))), "plastic" if u < 0.5 else "elastic_limit"])
    # test material (inputs only, not a material claim)
    E, Y, nu, T = 72000.0, 300.0, 0.33, 1.6
    inp = {"E_MPa": E, "Y_MPa": Y, "nu": nu, "T_mm": T, "note": "test inputs, not an alloy claim"}
    Ri = 4.8
    Rf = springback_direct(Ri, T, E, Y)
    u = Ri * Y / (E * T)
    case("VC-PRC-10.a", "formed radius after springback, R_i = 4.8 mm (3T), uniaxial E and Y", Rf, "mm", {"rel": 1e-9},
         "generator (moment-curvature + elastic unloading)", "A", ["FR-PRC-01", "TR-PRC-10"], inputs=inp,
         crossCheck={"gardinerForm_Ri_over_Rf": r12(gardiner_ratio(u)), "direct_Ri_over_Rf": r12(Ri / Rf), "u": r12(u)})
    th_i = 90.0
    th_f = th_i * (Ri + T / 2) / (Rf + T / 2)
    case("VC-PRC-10.b", "bend angle after springback for a 90 deg bend at R_i = 4.8 mm", th_f, "deg", {"rel": 1e-9}, "generator", "A",
         ["FR-PRC-01"], inputs=inp, derivation="theta_f = theta_i (R_i + T/2)/(R_f + T/2)")
    Ep, Yp = E / (1 - nu * nu), 2 * Y / math.sqrt(3)
    Rf_ps = springback_direct(Ri, T, Ep, Yp)
    case("VC-PRC-10.c", "formed radius, plane-strain option (E' = E/(1-nu^2), Y' = 2Y/sqrt3)", Rf_ps, "mm", {"rel": 1e-9},
         "generator", "A", ["FR-PRC-01", "FR-PRC-02"], inputs=inp)
    Ri_el = 0.5 * E * T / Y
    case("VC-PRC-10.d", "largest inside radius that still yields the outer fibre (u = 1/2)", Ri_el, "mm", {"rel": 1e-9},
         "generator", "A", ["FR-PRC-01", "FR-PRC-14"], inputs=inp, note="R_i >= this => PRC_BEND_ELASTIC (full springback)")
    case("VC-PRC-11", "FE plane-strain bend-and-release of the 1.6 mm strip (CalculiX, J2 perfect, NLGEOM) at R_i = 4.8 mm",
         Rf_ps, "mm", {"rel": 0.05}, "generator (plane-strain closed form); FE TBD", "A", ["FR-PRC-01", "FR-PRC-05"],
         note="FE uses pure bending by rotation of the strip ends (no tool contact) so the closed form applies; tool-contact variant is VC-PRC-12 (TBD)")
    case("VC-PRC-12", "tool (punch / die) bending with contact, then tool removal", "TBD", "mm", {"rel": None},
         "TBD — measure with PHY-06 contact + *MODEL CHANGE", "TBD", ["FR-PRC-05", "FR-PRC-06"])

    # ---- compensation
    targets = [(3.2, 90.0), (4.8, 90.0), (6.4, 90.0), (4.8, 45.0), (8.0, 120.0)]
    with open(out("springback_compensation.csv"), "w", newline="") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["target_Rf_mm", "target_angle_deg", "tool_Ri_mm", "tool_angle_deg", "overbend_deg"])
        for Rft, tht in targets:
            Rit = compensate(Rft, T, E, Y)
            Rfc = springback_direct(Rit, T, E, Y)
            tht_i = tht * (Rfc + T / 2) / (Rit + T / 2)
            w.writerow([repr(Rft), repr(tht), repr(r12(Rit)), repr(r12(tht_i)), repr(r12(tht_i - tht))])
    Rit = compensate(4.8, T, E, Y)
    case("VC-PRC-20.a", "tool radius that gives a formed R_f = 4.8 mm (test material)", Rit, "mm", {"rel": 1e-9}, "generator", "A",
         ["FR-PRC-03"], inputs=inp)
    tht_i = 90.0 * (springback_direct(Rit, T, E, Y) + T / 2) / (Rit + T / 2)
    case("VC-PRC-20.b", "tool angle that gives a formed 90 deg bend at R_f = 4.8 mm", tht_i, "deg", {"rel": 1e-9}, "generator", "A",
         ["FR-PRC-03", "FR-PRC-04"], inputs=inp)

    # ---- layered inherent strain
    ts, Es, nl, tl, El, es = 4.0, 200000.0, 10, 0.2, 200000.0, -0.002
    layers, state, eig, hist = build_layers(ts, Es, nl, tl, El, es)
    k_release = release_substrate(layers, state, eig)
    with open(out("layered_eigenstrain.csv"), "w", newline="") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["layer", "curvature_increment_per_mm", "curvature_total_per_mm"])
        for i, dk, kt in hist:
            w.writerow([i, repr(r12(dk)), repr(r12(kt))])
        w.writerow(["release_substrate", repr(r12(k_release)), repr(r12(hist[-1][2] + k_release))])
    linp = {"substrate_mm": ts, "E_substrate_MPa": Es, "layers": nl, "layer_mm": tl, "E_layer_MPa": El, "inherent_strain": es,
            "nu_FE": 0.0, "note": "test inputs; uniform isotropic inherent strain along the beam axis only"}
    k_one = timoshenko_bimetal(-es, tl, El, ts, Es)
    _, dk1 = eigen_increment([(-ts, 0.0, Es), (0.0, tl, El)], 1, es)
    case("VC-PRC-30.a", "curvature after the first deposited layer (two-layer check)", dk1, "1/mm", {"rel": 1e-9},
         "generator (equilibrium) + Timoshenko bimetal form", "A", ["FR-PRC-07", "TR-PRC-20"], inputs=linp,
         crossCheck={"timoshenko1925": r12(-k_one)}, note="sign: negative curvature = concave up for z up")
    L = 100.0
    k_tot = hist[-1][2]
    case("VC-PRC-30.b", "curvature after 10 layers built on the substrate (layer-by-layer, stress-free activation)", k_tot, "1/mm",
         {"rel": 0.03}, "generator (superposition)", "A", ["FR-PRC-07", "FR-PRC-08"], inputs=linp,
         note="FE: CalculiX *MODEL CHANGE ADD=STRAIN FREE per layer + *EXPANSION (alpha = inherent strain) with unit temperature step; beam 100 mm long, nu = 0")
    case("VC-PRC-30.c", "mid-span deflection of a 100 mm long beam after 10 layers (k L^2 / 8)", k_tot * L * L / 8.0, "mm",
         {"rel": 0.03}, "generator", "A", ["FR-PRC-08"], inputs=linp)
    case("VC-PRC-30.d", "additional curvature when the substrate is removed after the build", k_release, "1/mm", {"rel": 0.03},
         "generator (release of substrate resultants)", "A", ["FR-PRC-09", "FR-PRC-12"], inputs=linp,
         note="same mechanics as machining distortion by layer removal (FR-PRC-12)")
    # superposition sanity: all layers deposited at once on the substrate (not layer-by-layer) for comparison
    at_once = [(-ts, 0.0, Es), (0.0, nl * tl, El)]
    _, k_once = eigen_increment(at_once, 1, es)
    case("VC-PRC-30.e", "curvature if the 2 mm deposit received its inherent strain at once (no layering)", k_once, "1/mm",
         {"rel": 1e-9}, "generator", "A", ["FR-PRC-08"], inputs=linp,
         note="differs from 30.b: shows why stress-free layer activation matters", ratioLayeredToOnce=r12(k_tot / k_once))

    # ---- quoted AM-Bench (grade B) and contract cases
    case("VC-PRC-40", "NIST AM-Bench 2018 AMB2018-01 IN625 bridge, deflection at ridge 1 after EDM separation of the legs", 1.276, "mm",
         {"rel": 0.1}, "S5 (NIST AM-Bench page, search extract); 15-5 PH part 1.168 mm", "B", ["FR-PRC-10"],
         note="reported, not a pass/fail gate until the data release is read (geometry, process, per-ridge values)")
    case("VC-PRC-50", "check_process on a bend with R_i below the 07 minimum-bend-radius row (code relayed from 07 check_sheet_metal)", "FTR_BEND_RADIUS_BELOW_MIN", "code",
         {"exact": True}, "07 FTR TECHNICAL_SPEC 7.2 (relayed)", "A", ["FR-PRC-14"])
    case("VC-PRC-51", "springback_calc without yield stress or with an unverified material record", "PRC_MATERIAL_INPUT_MISSING / unverified=true",
         "code", {"exact": True}, "TECHNICAL_SPEC 7.1 (AF-31/32)", "A", ["FR-PRC-15", "FR-PRC-16"])
    case("VC-PRC-52", "AM overhang check without a threshold angle", "PRC_OVERHANG_THRESHOLD_UNSET", "code", {"exact": True},
         "TECHNICAL_SPEC 7.1 (AF-31: no default)", "A", ["FR-PRC-11", "FR-PRC-15"])
    case("VC-PRC-53", "every process result", "reviewRequired=true", "flag", {"exact": True}, "AF-33", "A", ["FR-PRC-17"])
    case("VC-PRC-54", "downskin angles of a test part's downward faces inclined 45 deg and 30 deg to the plate, and a horizontal ceiling (build +Z)",
         "45 / 30 / 0", "deg", {"abs": 1e-6}, "geometry: downskin angle = 90 deg - angle(face normal, -Z)", "A", ["FR-PRC-11"],
         note="llull convention: angle between a downward-facing face and the build plate; 0 = horizontal ceiling, 90 = vertical wall")

    doc = {"pack": "16-process-physics", "generatedBy": "generate_prc_reference.py", "units": "mm, MPa, deg unless stated",
           "cases": cases}
    with open(out("expected_results.json"), "w") as fh:
        json.dump(doc, fh, indent=1)
        fh.write("\n")


if __name__ == "__main__":
    main()
