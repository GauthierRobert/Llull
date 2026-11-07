"""Builds expected_results.json (pack schema, physics README §6.3) from drv_reference.json.

Run from this folder: python3 -I build_expected_results.py drv_reference.json expected_results.json (byte-identical on re-run).
"""

import json
import sys

ref = json.load(open(sys.argv[1], encoding="utf-8"))
cases = []


def add(vc, quantity, value, unit, tol, source, grade, proves):
    cases.append({"id": vc, "quantity": quantity, "value": value, "unit": unit, "tolerance": tol, "source": source, "grade": grade, "proves": proves})


GEN = "generate_drv_reference.py"
mx = ref["maxon148877"]
add("VC-DRV-01", "largest relative gap between the derived and the datasheet values (6 checks), maxon 148877", mx["maxAbsRelError"], "1", {"max": 0.01}, "R1 datasheet + " + GEN, "A", ["FR-DRV-02", "TR-DRV-04"])
add("VC-DRV-03", "no-load speed, Coulomb friction kt*I0, ke = kt", mx["derived"]["noLoadSpeedRadS"], "rad/s", {"rel": 0.002}, "R1 + " + GEN, "A", ["FR-DRV-01", "TR-DRV-05"])
dc = ref["dcStep"]
for s in dc["samples"]:
    add("VC-DRV-04", f"speed after a 48 V step at t = {s['tS']} s (rotor only, L = 0.33 mH)", s["speedRadS"], "rad/s", {"rel": 0.005}, GEN + " (exact 2x2 ODE)", "A", ["FR-DRV-01", "TR-DRV-05", "TR-DRV-06"])
    add("VC-DRV-04", f"current after a 48 V step at t = {s['tS']} s", s["currentA"], "A", {"rel": 0.005, "abs": 0.05}, GEN + " (exact 2x2 ODE)", "A", ["FR-DRV-01", "TR-DRV-06"])
add("VC-DRV-04", "current peak after a 48 V step", dc["currentPeak"]["currentA"], "A", {"rel": 0.005}, GEN, "A", ["TR-DRV-06"])
e = dc["energyTo30ms"]
add("VC-DRV-05", "electrical input energy 0..30 ms", e["inputJ"], "J", {"rel": 0.005}, GEN + " (Simpson on the exact solution)", "A", ["FR-DRV-20", "TR-DRV-20"])
add("VC-DRV-05", "copper loss 0..30 ms", e["copperLossJ"], "J", {"rel": 0.005}, GEN, "A", ["FR-DRV-20", "TR-DRV-20"])
add("VC-DRV-05", "rotor kinetic energy at 30 ms", e["kineticJ"], "J", {"rel": 0.005}, GEN, "A", ["FR-DRV-20"])
th = ref["thermal"]
add("VC-DRV-06", "steady winding temperature at the nominal current 3.17 A, ambient 25 C, alpha 0.0039", th["steadyAtNominalCurrentC"], "degC", {"abs": 0.5}, GEN, "A", ["FR-DRV-04", "TR-DRV-09"])
for s in th["transient10W"]["samples"]:
    add("VC-DRV-07", f"winding rise above ambient, 10 W step, t = {s['tS']} s (alpha = 0)", s["windingRiseK"], "K", {"rel": 0.01, "abs": 0.05}, GEN + " (exact 2-node solution)", "A", ["FR-DRV-04", "TR-DRV-09"])
dcy = th["dutyCycle"]
add("VC-DRV-08", "RMS current, 6 A for 1 s then 0 A for 3 s", dcy["rmsCurrentA"], "A", {"rel": 1e-9}, GEN, "A", ["FR-DRV-12", "TR-DRV-21"])
add("VC-DRV-08", "steady winding temperature at that RMS current", dcy["steadyWindingAtRmsCurrentC"], "degC", {"abs": 3.0}, GEN + " (periodic mean, cycle 4 s vs tau_w 41.5 s)", "A", ["FR-DRV-12", "TR-DRV-09"])
add("VC-DRV-09", "thermal runaway current (I^2 R25 alpha Rth = 1)", th["runawayCurrentA"], "A", {"rel": 0.001}, GEN, "A", ["FR-DRV-04", "TR-DRV-09"])
g = ref["gear"]
add("VC-DRV-10", "output acceleration, 0.1 N m through N = 10, eta 0.9", g["spinUp"]["outputAccelerationRadS2"], "rad/s^2", {"rel": 0.005}, GEN, "A", ["FR-DRV-06", "TR-DRV-12"])
add("VC-DRV-11", "inertia-matching ratio sqrt(J_load / J_motor)", g["optimalRatio"]["ratio"], "1", {"rel": 1e-9}, GEN, "A", ["FR-DRV-13", "TR-DRV-22"])
add("VC-DRV-11", "peak motor torque at the optimal ratio, alpha_load 100 rad/s^2", g["optimalRatio"]["minPeakMotorTorqueNm"], "N m", {"rel": 0.005}, GEN, "A", ["FR-DRV-13", "TR-DRV-22"])
add("VC-DRV-12", "RMS torque of 2 N m for 1 s then 0 for 3 s", g["rmsTorque"]["rmsNm"], "N m", {"rel": 1e-9}, GEN, "A", ["FR-DRV-12", "TR-DRV-21"])
ls = ref["leadScrew"]
add("VC-DRV-13", "lead screw forward efficiency, square thread, mu 0.1, lead = d_m = 10 mm", ls["free"]["forwardEfficiency"], "1", {"rel": 1e-6}, GEN, "A", ["FR-DRV-07", "TR-DRV-13"])
add("VC-DRV-13", "lead screw back-drive efficiency, mu 0.1", ls["free"]["backDriveEfficiency"], "1", {"rel": 1e-6}, GEN, "A", ["FR-DRV-07", "TR-DRV-13"])
add("VC-DRV-13", "lift acceleration of 10 kg, 0.5 N m on the screw, mu 0.1", ls["free"]["liftAccelerationMS2"], "m/s^2", {"rel": 0.01}, GEN, "A", ["FR-DRV-07", "TR-DRV-13"])
add("VC-DRV-13", "fall acceleration of 10 kg with the motor off, mu 0.1 (back-driven)", ls["free"]["fallAccelerationMotorOffMS2"], "m/s^2", {"rel": 0.01}, GEN, "A", ["FR-DRV-07", "TR-DRV-13"])
add("VC-DRV-14", "fall acceleration with the motor off, mu 0.35 (self-locking)", 0.0, "m/s^2", {"abs": 1e-4}, GEN, "A", ["FR-DRV-07", "TR-DRV-13"])
add("VC-DRV-14", "lift acceleration, mu 0.35", ls["locking"]["liftAccelerationMS2"], "m/s^2", {"rel": 0.01}, GEN, "A", ["FR-DRV-07", "TR-DRV-13"])
add("VC-DRV-15", "axial force from 0.1 N m, lead 5 mm, eta 0.9", ls["forceFromTorque"]["forceN"], "N", {"rel": 1e-6}, GEN, "A", ["FR-DRV-07"])
add("VC-DRV-16", "lost motion on reversal, backlash 0.5 deg", ref["backlash"]["lostMotionOnReversalDeg"], "deg", {"rel": 0.02}, "definition", "A", ["FR-DRV-06", "TR-DRV-14"])
b = ref["breakaway"]
add("VC-DRV-17", "breakaway time, force ramp 1 N/s, Fs 2 N", b["breakawayTimeS"], "s", {"abs": 0.002}, GEN, "A", ["FR-DRV-08", "TR-DRV-15"])
add("VC-DRV-17", "acceleration just after breakaway, Fc 1 N, 1 kg", b["accelerationAfterBreakawayMS2"], "m/s^2", {"rel": 0.02}, GEN, "A", ["FR-DRV-08", "TR-DRV-15"])
ss = ref["stickSlip"]
add("VC-DRV-18", "stick-slip limit-cycle period, mass on a belt", ss["periodS"], "s", {"rel": 0.02}, GEN + " (derivation in the docstring)", "A", ["FR-DRV-08", "TR-DRV-15"])
add("VC-DRV-18", "slip phase duration", ss["slipTimeS"], "s", {"rel": 0.02}, GEN, "A", ["FR-DRV-08", "TR-DRV-15"])
add("VC-DRV-18", "stick phase duration", ss["stickTimeS"], "s", {"rel": 0.02}, GEN, "A", ["FR-DRV-08", "TR-DRV-15"])
pf = ref["pinFriction"]
add("VC-DRV-19", "angular acceleration with load-dependent pin friction mu W r", pf["accelerationRadS2"], "rad/s^2", {"rel": 0.01}, GEN, "A", ["FR-DRV-08", "TR-DRV-16"])
es = ref["endStop"]
add("VC-DRV-20", "restitution of a one-sided spring-damper end stop, zeta 0.2", es["restitution"], "1", {"rel": 0.03}, GEN, "A", ["FR-DRV-09", "TR-DRV-17"])
add("VC-DRV-20", "peak penetration, 1 rad/s into 1000 N m/rad, J 0.01", es["peakPenetrationRad"], "rad", {"rel": 0.05}, GEN, "A", ["FR-DRV-09", "TR-DRV-17"])
add("VC-DRV-20", "contact time of the one-sided stop (release at zero force plus the travel to zero penetration)", es["contactTimeS"], "s", {"rel": 0.05}, GEN, "A", ["FR-DRV-09", "TR-DRV-17"])
p = ref["profiles"]
add("VC-DRV-21", "trapezoid move duration, 0.1 m, vmax 0.5, amax 5", p["trapezoid"]["durationS"], "s", {"rel": 1e-9}, GEN, "A", ["FR-DRV-10", "TR-DRV-18"])
add("VC-DRV-21", "7-segment S-curve duration, jerk 100", p["sCurve"]["durationS"], "s", {"rel": 1e-9}, GEN, "A", ["FR-DRV-10", "TR-DRV-18"])
for law, c in p["camLaws"].items():
    add("VC-DRV-22", f"cam law {law}: peak acceleration coefficient", c["Ca"], "1", {"rel": 1e-6}, GEN, "A", ["FR-DRV-10", "TR-DRV-18"])
    add("VC-DRV-22", f"cam law {law}: peak velocity coefficient", c["Cv"], "1", {"rel": 1e-6}, GEN, "A", ["FR-DRV-10", "TR-DRV-18"])
pi = ref["piSpeedLoop"]
for s in pi["samples"]:
    add("VC-DRV-23", f"PI speed loop step response at t = {s['tS']} s (zeta 1, wn 100)", s["response"], "1", {"abs": 0.01}, GEN, "A", ["FR-DRV-11", "TR-DRV-19"])
add("VC-DRV-24", "inverse-dynamics peak torque of a prescribed profile on J = 1e-3", ref["inverseDynamics"]["peakTorqueNm"], "N m", {"rel": 1e-6}, GEN, "A", ["FR-DRV-05", "TR-DRV-11"])
pm = ref["pmsm"]
add("VC-DRV-25", "PMSM maximum torque 1.5 p lambda Imax", pm["maxTorqueNm"], "N m", {"rel": 1e-6}, GEN, "A", ["FR-DRV-03", "TR-DRV-07"])
add("VC-DRV-25", "PMSM base speed (R = 0, id = 0)", pm["baseSpeedRadS"], "rad/s", {"rel": 0.005}, GEN, "A", ["FR-DRV-03", "TR-DRV-07"])
add("VC-DRV-25", "PMSM maximum speed Vmax / (lambda - L Imax) / p", pm["maxSpeedRadS"], "rad/s", {"rel": 0.005}, GEN, "A", ["FR-DRV-03", "TR-DRV-07"])
for r in pm["envelope"]:
    add("VC-DRV-25", f"PMSM envelope torque at {r['mechSpeedRadS']} rad/s", r["torqueNm"], "N m", {"rel": 0.005}, GEN, "A", ["FR-DRV-03", "TR-DRV-07"])
ind = ref["induction"]
for s, t in ind["kloss"]["torqueAtSlip"].items():
    add("VC-DRV-26", f"Kloss torque at slip {s} (Tb 100, sb 0.1)", t, "N m", {"rel": 1e-9}, "Kloss formula R8 + " + GEN, "A", ["FR-DRV-03", "TR-DRV-08"])
add("VC-DRV-26", "breakdown torque of the equivalent circuit", ind["circuit"]["breakdownTorqueNm"], "N m", {"rel": 1e-6}, GEN, "A", ["FR-DRV-03", "TR-DRV-08"])
add("VC-DRV-26", "breakdown slip of the equivalent circuit", ind["circuit"]["breakdownSlip"], "1", {"rel": 1e-6}, GEN, "A", ["FR-DRV-03", "TR-DRV-08"])
add("VC-DRV-26", "starting torque of the equivalent circuit", ind["circuit"]["startingTorqueNm"], "N m", {"rel": 1e-6}, GEN, "A", ["FR-DRV-03", "TR-DRV-08"])
st = ref["stepper"]
add("VC-DRV-27", "stepper small-angle natural frequency sqrt(Th Nr / J) / 2 pi", st["naturalFrequencyHz"], "Hz", {"rel": 0.02}, GEN, "A", ["FR-DRV-03", "TR-DRV-08"])
add("VC-DRV-27", "stepper static deflection at half the holding torque (0.25 N m)", st["staticDeflectionDegAtHalfHoldingTorque"], "deg", {"rel": 0.01}, GEN, "A", ["FR-DRV-03", "TR-DRV-08"])
hy = ref["hydraulic"]
add("VC-DRV-28", "steady extension speed, meter-in orifice, 5 kN load", hy["speedMS"], "m/s", {"rel": 0.01}, GEN, "A", ["FR-DRV-07", "TR-DRV-13"])
sd = ref["spinDown"]
add("VC-DRV-29", "Coulomb torque recovered from synthetic spin-down (J known)", sd["coulombTorqueNm"], "N m", {"rel": 0.005}, GEN + " (synthetic data)", "A", ["FR-DRV-22", "TR-DRV-25"])
add("VC-DRV-29", "viscous coefficient recovered from synthetic spin-down (J known)", sd["viscousNmsPerRad"], "N m s/rad", {"rel": 0.02}, GEN + " (synthetic data)", "A", ["FR-DRV-22", "TR-DRV-25"])

out = {
    "pack": "23-drives-physical-truth",
    "generatedBy": "generate_drv_reference.py (values) via drv_reference.json; behaviour cases (codes, purity, determinism, cross-engine, UI) are in README.md",
    "cases": cases,
}
with open(sys.argv[2], "w", encoding="utf-8", newline="\n") as fh:
    json.dump(out, fh, indent=2, ensure_ascii=False)
    fh.write("\n")
print(len(cases), "cases")
