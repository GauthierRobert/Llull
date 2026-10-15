#!/usr/bin/env python3
"""
Generate the analytic reference values of PHY-15 (electrical, magnetic, optical and radiative properties).

Run:  python3 -I generate_eop_reference.py      (stdlib only, deterministic, writes next to this script)

Outputs
  expected_results.json   cases in the docs/physics/README.md section 6.3 schema (12 significant digits)
  skin_depth.csv          skin depth vs frequency for 100 % IACS copper and a 61 % IACS test conductor
  radiator_balance.csv    equilibrium temperature of a sun-facing plate vs alpha/eps

Formulas (source ids refer to sources.md):
  %IACS:                    rho = 1.7241e-8 Ohm m * 100 / %IACS  (100 % IACS = annealed copper, 20 degC)              [S1, S2]
  DC resistance:            R = rho L / A;  rho(T) = rho20 (1 + aR (T - 20))  (linear model, aR a test input)          [S3]
  Skin depth:               delta = sqrt(2 rho / (omega mu)) = sqrt(rho / (pi f mu0 mur))                              [S3]
  Round wire, r >> delta:   R_ac / R_dc ~ r / (2 delta)  (current in an annulus of thickness delta)                  [S3]
  Shield absorption loss:   A = 20 log10(e) t / delta = 8.68589 t / delta  dB  (field decays as exp(-t/delta))       [S3]
  Bond path:                R_path = sum of series elements (joints + strap R = rho L / A)                          [S3]
  Anisotropic laminate:     R = L / (sigma_x t w)                                                                    [S3]
  Sun-facing flat plate:    alpha S = n eps sigma T^4  ->  T = (alpha S / (n eps sigma))^(1/4),  n = 1 or 2 radiating faces [S4]
  Fresnel, normal incidence: R = ((n1 - n2)/(n1 + n2))^2;  lossless slab, incoherent: T = (1 - R)/(1 + R)            [S3]
  sigma_SB from exact 2019 SI constants; mu0 = 4 pi 1e-7 (classical) and the CODATA 2018 value for comparison         [S5]

Inputs labelled "test input" are values chosen for the case; they are not property claims.
"""

from __future__ import annotations

import csv
import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))

H_PLANCK = 6.62607015e-34
K_BOLTZMANN = 1.380649e-23
C_LIGHT = 299792458.0
SIGMA_SB = 2.0 * math.pi**5 * K_BOLTZMANN**4 / (15.0 * H_PLANCK**3 * C_LIGHT**2)
MU0_CLASSICAL = 4.0e-7 * math.pi
MU0_CODATA2018 = 1.25663706212e-6
RHO_IACS = 1.7241e-8  # Ohm m, 100 % IACS at 20 degC [S1, S2]


def sig(x: float, n: int = 12) -> float:
    if x == 0 or not math.isfinite(x):
        return x
    return float(f"{x:.{n}g}")


def rho_from_iacs(pct: float) -> float:
    return RHO_IACS * 100.0 / pct


def skin_depth(rho: float, f: float, mur: float = 1.0, mu0: float = MU0_CLASSICAL) -> float:
    return math.sqrt(rho / (math.pi * f * mu0 * mur))


def plate_temperature(alpha: float, eps: float, flux: float, faces: int) -> float:
    return (alpha * flux / (faces * eps * SIGMA_SB)) ** 0.25


def case(cid, quantity, value, unit, tol, source, grade, proves, **extra):
    c = {"id": cid, "quantity": quantity, "value": value, "unit": unit, "tolerance": tol, "source": source, "grade": grade, "proves": proves}
    c.update(extra)
    return c


def main() -> None:
    cases = []

    # VC-EOP-01 IACS
    cases.append(case("VC-EOP-01.a", "resistivity of 100 % IACS (annealed copper, 20 degC)", RHO_IACS, "ohm*m", {"rel": 1e-12},
                      "S1 + S2 (definition quoted by >= 2 sources)", "A", ["FR-EOP-01", "TR-EOP-10"], derivation="definition"))
    cases.append(case("VC-EOP-01.b", "conductivity equivalent of 100 % IACS", sig(1.0 / RHO_IACS), "S/m", {"rel": 1e-9}, "generator (1/rho)", "A",
                      ["FR-EOP-01", "TR-EOP-10"],
                      note="1/1.7241e-8 = 5.80012e7 S/m; the 58.108 MS/m some web pages quote is inconsistent with 1.7241 uOhm cm by 0.2 % and is not used"))
    cases.append(case("VC-EOP-01.c", "resistivity of a 61 % IACS conductor (test input)", sig(rho_from_iacs(61.0)), "ohm*m", {"rel": 1e-9}, "generator", "A",
                      ["FR-EOP-01", "TR-EOP-10"], inputs={"pctIACS": 61.0}, derivation="rho = 1.7241e-8 * 100 / %IACS"))

    # VC-EOP-02 DC resistance with temperature (test inputs)
    w = {"pctIACS": 100.0, "L_m": 1.0, "A_mm2": 1.0, "alphaR_per_K": 0.00393, "T_degC": 75.0}
    r20 = RHO_IACS * w["L_m"] / (w["A_mm2"] * 1e-6)
    rT = r20 * (1 + w["alphaR_per_K"] * (w["T_degC"] - 20.0))
    cases.append(case("VC-EOP-02.a", "DC resistance of 1 m of 1 mm^2 100 % IACS copper at 20 degC", sig(r20), "ohm", {"rel": 1e-9}, "generator", "A",
                      ["FR-EOP-02", "TR-EOP-11"], inputs=w, derivation="R = rho L / A"))
    cases.append(case("VC-EOP-02.b", "same conductor at 75 degC (linear temperature coefficient, test input)", sig(rT), "ohm", {"rel": 1e-9}, "generator", "A",
                      ["FR-EOP-02", "TR-EOP-11"], inputs=w, derivation="R(T) = R20 (1 + aR (T - 20)); aR is a test input here, in use it comes from the material record"))

    # VC-EOP-03 skin depth
    d60 = skin_depth(RHO_IACS, 60.0)
    d1m = skin_depth(RHO_IACS, 1.0e6)
    d1m_codata = skin_depth(RHO_IACS, 1.0e6, mu0=MU0_CODATA2018)
    cases.append(case("VC-EOP-03.a", "skin depth, 100 % IACS copper, 60 Hz", sig(d60), "m", {"rel": 1e-6}, "generator (S3 formula)", "A",
                      ["FR-EOP-03", "TR-EOP-12"], inputs={"rho_ohm_m": RHO_IACS, "f_Hz": 60.0, "mur": 1.0, "mu0": "4 pi 1e-7"}))
    cases.append(case("VC-EOP-03.b", "skin depth, 100 % IACS copper, 1 MHz", sig(d1m), "m", {"rel": 1e-6}, "generator (S3 formula)", "A",
                      ["FR-EOP-03", "TR-EOP-12"], inputs={"rho_ohm_m": RHO_IACS, "f_Hz": 1.0e6, "mur": 1.0, "mu0": "4 pi 1e-7"},
                      withCodata2018Mu0=sig(d1m_codata), note="relative difference between mu0 conventions ~2.7e-10, far below the tolerance"))
    cases.append(case("VC-EOP-03.c", "skin depth, test magnetic conductor rho 1e-7 ohm m, mur 100, 400 Hz", sig(skin_depth(1.0e-7, 400.0, 100.0)), "m", {"rel": 1e-6},
                      "generator (S3 formula)", "A", ["FR-EOP-03", "FR-EOP-05", "TR-EOP-12"], inputs={"rho_ohm_m": 1.0e-7, "f_Hz": 400.0, "mur": 100.0}))

    # VC-EOP-04 AC resistance approximation (r >> delta)
    r_wire = 0.001
    ratio = r_wire / (2 * d1m)
    cases.append(case("VC-EOP-04", "R_ac/R_dc of a 2 mm diameter copper wire at 1 MHz (r >> delta approximation)", sig(ratio), "1", {"rel": 0.05},
                      "generator (S3 approximation)", "A", ["FR-EOP-03", "TR-EOP-12"], inputs={"r_m": r_wire, "f_Hz": 1.0e6},
                      validity={"r_over_delta": sig(r_wire / d1m), "rule": "approximation flagged unless r/delta >= 5 (llull rule)"},
                      derivation="R_ac ~ rho / (2 pi r delta) per length; ratio = r / (2 delta)"))

    # VC-EOP-05 shield absorption loss
    t = 1.0e-4
    cases.append(case("VC-EOP-05", "absorption loss of a 0.1 mm copper sheet at 1 MHz", sig(20.0 * math.log10(math.e) * t / d1m), "dB", {"rel": 1e-6},
                      "generator (field decay exp(-t/delta), S3)", "A", ["FR-EOP-04", "TR-EOP-13"], inputs={"t_m": t, "f_Hz": 1.0e6, "pctIACS": 100.0},
                      derivation="A = 20 log10(e) t/delta = 8.68589 t/delta dB; reflection loss not included",
                      note="absorption term only; total shielding effectiveness needs the reflection term and apertures (out of scope)"))

    # VC-EOP-06 bonding path (test inputs; limit is a rule-table value, see sources S6)
    strap = {"pctIACS": 61.0, "L_m": 0.15, "A_mm2": 10.0}
    r_strap = rho_from_iacs(strap["pctIACS"]) * strap["L_m"] / (strap["A_mm2"] * 1e-6)
    joints = [0.0005, 0.0008]
    r_path = r_strap + sum(joints)
    cases.append(case("VC-EOP-06.a", "bond path resistance: strap + two faying-surface joints", sig(r_path), "ohm", {"rel": 1e-9}, "generator", "A",
                      ["FR-EOP-06", "TR-EOP-20"], inputs={"strap": strap, "jointResistances_ohm": joints}, strapResistance_ohm=sig(r_strap),
                      derivation="series sum"))
    cases.append(case("VC-EOP-06.b", "status against a 2.5 mOhm rule value (test rule; source grade B, S6)", "fail" if r_path > 0.0025 else "pass", "-", {"exact": True},
                      "generator + S6 (2.5 mOhm cited as the classic class R/L value, secondary only)", "B", ["FR-EOP-06", "FR-EOP-07", "TR-EOP-20", "TR-EOP-21"],
                      inputs={"limit_ohm": 0.0025, "limitSource": "rule table entry (MIL-STD-464C rationale as quoted by secondary sources; unverified)"},
                      expected={"code": "EOP_BOND_RESISTANCE_EXCEEDED" if r_path > 0.0025 else None, "limit.unverified": True, "reviewRequired": True}))

    joints_bad = [0.0012, 0.0015]
    r_bad = r_strap + sum(joints_bad)
    cases.append(case("VC-EOP-06.c", "second path with degraded joints: resistance and status against the same 2.5 mOhm test rule", sig(r_bad), "ohm", {"rel": 1e-9},
                      "generator + S6 (rule value grade B)", "B", ["FR-EOP-06", "FR-EOP-07", "TR-EOP-20", "TR-EOP-21"],
                      inputs={"strap": strap, "jointResistances_ohm": joints_bad, "limit_ohm": 0.0025},
                      expected={"status": "fail" if r_bad > 0.0025 else "pass", "code": "EOP_BOND_RESISTANCE_EXCEEDED" if r_bad > 0.0025 else None,
                                "reviewRequired": True, "disposition": "pending_human"}))

    # VC-EOP-07 CFRP laminate panel (test inputs)
    cf = {"sigma_x_S_m": 1.0e4, "L_m": 0.5, "t_m": 0.002, "w_m": 0.1}
    cases.append(case("VC-EOP-07", "in-plane resistance of a CFRP strip (anisotropic conductivity, test input)", sig(cf["L_m"] / (cf["sigma_x_S_m"] * cf["t_m"] * cf["w_m"])), "ohm",
                      {"rel": 1e-9}, "generator", "A", ["FR-EOP-01", "FR-EOP-06", "TR-EOP-20"], inputs=cf, derivation="R = L / (sigma_x t w)",
                      note="the value shows why a CFRP part cannot replace a metallic bond path; check_bonding warns EOP_CFRP_IN_PATH"))

    # VC-EOP-08 sun-facing plate (test inputs)
    sp = {"alpha_solar": 0.2, "eps_ir": 0.9, "solarFlux_W_m2": 1361.0}
    t1 = plate_temperature(sp["alpha_solar"], sp["eps_ir"], sp["solarFlux_W_m2"], 1)
    t2 = plate_temperature(sp["alpha_solar"], sp["eps_ir"], sp["solarFlux_W_m2"], 2)
    cases.append(case("VC-EOP-08.a", "equilibrium temperature, sun-normal plate, insulated back (one radiating face)", sig(t1), "K", {"rel": 1e-6},
                      "generator (S4 balance, exact SI sigma)", "A", ["FR-EOP-08", "TR-EOP-30"], inputs=sp,
                      derivation="alpha S = eps sigma T^4", note="solar flux is a test input; llull never defaults it"))
    cases.append(case("VC-EOP-08.b", "equilibrium temperature, thin plate radiating from both faces", sig(t2), "K", {"rel": 1e-6}, "generator (S4)", "A",
                      ["FR-EOP-08", "TR-EOP-30"], inputs=sp, derivation="alpha S = 2 eps sigma T^4"))
    cases.append(case("VC-EOP-08.c", "alpha/eps ratio", sig(sp["alpha_solar"] / sp["eps_ir"]), "1", {"rel": 1e-12}, "generator", "A", ["FR-EOP-08", "TR-EOP-30"], inputs=sp))

    # VC-EOP-09 Fresnel (test input n)
    n = 1.5
    R = ((n - 1.0) / (n + 1.0)) ** 2
    cases.append(case("VC-EOP-09.a", "normal-incidence reflectance, n = 1.5 in air", sig(R), "1", {"rel": 1e-12}, "generator (S3)", "A", ["FR-EOP-09", "TR-EOP-31"], inputs={"n": n}))
    cases.append(case("VC-EOP-09.b", "transmittance of a lossless n = 1.5 slab (incoherent multiple reflections)", sig((1 - R) / (1 + R)), "1", {"rel": 1e-12}, "generator (S3)", "A",
                      ["FR-EOP-09", "TR-EOP-31"], inputs={"n": n}, derivation="T = (1 - R)/(1 + R)"))

    # VC-EOP-10 property validation (codes)
    cases.append(case("VC-EOP-10", "property validation rejects impossible values", None, "-", {"exact": True}, "TECHNICAL_SPEC 7.1", "A", ["FR-EOP-10", "TR-EOP-02"],
                      expected=[{"set": "emissivity_ir = 1.05", "code": "EOP_PROPERTY_RANGE"},
                                {"set": "absorptivity_solar = -0.1", "code": "EOP_PROPERTY_RANGE"},
                                {"set": "resistivity_el = 0", "code": "EOP_PROPERTY_RANGE"},
                                {"set": "permeability_rel = 0.5 without diamagnetic flag", "code": "EOP_PROPERTY_RANGE"},
                                {"set": "refractive_index without wavelength", "code": "EOP_CONDITION_MISSING"},
                                {"set": "emissivity_ir without temperature or 'hemispherical/normal' kind", "code": "EOP_CONDITION_MISSING"},
                                {"set": "resistivity_el given in S/m", "code": "EOP_UNITS_MISMATCH"}]))

    # VC-EOP-11 PHY-03 link and propagation
    cases.append(case("VC-EOP-11", "radiation BC with emissivity 'material' takes the coating value and its flags", None, "-", {"exact": True}, "PHY-03 TR-THM-50", "A",
                      ["FR-EOP-11", "TR-EOP-32"],
                      expected={"deck *RADIATE eps": "coating emissivity_ir at the BC temperature range", "thermal_report.unverified": "true when the coating value is basis 'typical'",
                                "missingCoating.code": "EOP_SURFACE_PROPERTY_MISSING"}))
    cases.append(case("VC-EOP-12", "human gate on accepting a failed bond path", None, "-", {"exact": True}, "AF-34", "A", ["FR-EOP-07", "TR-EOP-22"],
                      expected={"dispose_bond_check(agent).code": "EOP_HUMAN_GATE", "documentHashUnchanged": True}))

    data = {"pack": "15-electro-optical-properties", "generatedBy": "generate_eop_reference.py",
            "constants": {"rho_IACS_ohm_m": RHO_IACS, "sigma_SB_W_m2K4": sig(SIGMA_SB), "mu0_classical": sig(MU0_CLASSICAL), "mu0_CODATA2018": MU0_CODATA2018},
            "cases": cases}
    with open(os.path.join(HERE, "expected_results.json"), "w", encoding="utf-8", newline="\n") as fh:
        json.dump(data, fh, indent=1, ensure_ascii=False)
        fh.write("\n")

    with open(os.path.join(HERE, "skin_depth.csv"), "w", encoding="utf-8", newline="") as fh:
        wr = csv.writer(fh, lineterminator="\n")
        wr.writerow(["f_Hz", "delta_copper_100IACS_m", "delta_61IACS_m"])
        for f in (50.0, 60.0, 400.0, 1.0e3, 1.0e4, 1.0e5, 1.0e6, 1.0e7, 1.0e8, 1.0e9):
            wr.writerow([f, sig(skin_depth(RHO_IACS, f), 9), sig(skin_depth(rho_from_iacs(61.0), f), 9)])

    with open(os.path.join(HERE, "radiator_balance.csv"), "w", encoding="utf-8", newline="") as fh:
        wr = csv.writer(fh, lineterminator="\n")
        wr.writerow(["alpha_over_eps", "T_one_face_K", "T_two_faces_K", "solarFlux_W_m2_test_input"])
        for ratio in (0.1, 0.2, 0.5, 1.0, 2.0, 5.0):
            wr.writerow([ratio, sig(plate_temperature(ratio, 1.0, 1361.0, 1), 9), sig(plate_temperature(ratio, 1.0, 1361.0, 2), 9), 1361.0])


if __name__ == "__main__":
    main()
