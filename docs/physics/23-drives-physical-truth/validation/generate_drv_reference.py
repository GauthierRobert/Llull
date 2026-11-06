"""PHY-23 DRV reference values (Python 3 standard library only).

Run from this folder: python3 -I generate_drv_reference.py  ->  writes drv_reference.json (byte-identical on re-run).

Every value is an exact analytic derivation (grade A) from the formula named next to it, or a datasheet value quoted from
sources.md [R1] (maxon RE 40 148877). Numerical quadrature (composite Simpson) is used only on closed-form solutions,
never on a simulated trajectory, and is self-checked against the energy identity it must satisfy.
"""

import json
import math


def g12(value):
    """12 significant digits, stable text (pack convention, physics README §6.3)."""
    return float(f"{value:.12g}")


RPM = 60.0 / (2.0 * math.pi)  # rad/s -> rpm

# ---------------------------------------------------------------------------------------------------------------------
# 1. maxon RE 40, article 148877 (48 V), datasheet [R1]: SI units
# ---------------------------------------------------------------------------------------------------------------------
MAXON = {
    "nominalVoltageV": 48.0,
    "noLoadSpeedRpm": 7590.0,
    "noLoadCurrentA": 0.0686,
    "nominalSpeedRpm": 7000.0,
    "nominalTorqueNm": 0.187,
    "nominalCurrentA": 3.17,
    "stallTorqueNm": 2.56,
    "stallCurrentA": 42.4,
    "terminalResistanceOhm": 1.13,
    "terminalInductanceH": 0.33e-3,
    "torqueConstantNmPerA": 0.0603,
    "speedConstantRpmPerV": 158.0,
    "speedTorqueGradientRpmPerMNm": 2.97,
    "mechanicalTimeConstantS": 4.28e-3,
    "rotorInertiaKgM2": 137e-7,
    "thermalResistanceWindingHousingKPerW": 1.9,
    "thermalResistanceHousingAmbientKPerW": 4.7,
    "thermalTimeConstantWindingS": 41.5,
    "thermalTimeConstantMotorS": 809.0,
    "maxWindingTemperatureC": 155.0,
    "maxSpeedRpm": 12000.0,
}


def maxon_consistency():
    m = MAXON
    v, r, kt = m["nominalVoltageV"], m["terminalResistanceOhm"], m["torqueConstantNmPerA"]
    ke_from_speed_constant = 1.0 / (m["speedConstantRpmPerV"] / RPM)  # V s/rad
    stall_current = v / r
    stall_torque = kt * stall_current
    tau_m = m["rotorInertiaKgM2"] * r / (kt * kt)
    tau_e = m["terminalInductanceH"] / r
    friction_torque = kt * m["noLoadCurrentA"]
    no_load_speed = (v - r * m["noLoadCurrentA"]) / kt  # ke = kt (SI), Coulomb friction kt*I0
    gradient = (no_load_speed * RPM) / (stall_torque * 1000.0)  # rpm per mNm
    checks = [
        ("stallCurrentA", stall_current, m["stallCurrentA"]),
        ("stallTorqueNm", stall_torque, m["stallTorqueNm"]),
        ("keFromSpeedConstantVsPerRad", ke_from_speed_constant, kt),
        ("noLoadSpeedRpm", no_load_speed * RPM, m["noLoadSpeedRpm"]),
        ("mechanicalTimeConstantS", tau_m, m["mechanicalTimeConstantS"]),
        ("speedTorqueGradientRpmPerMNm", gradient, m["speedTorqueGradientRpmPerMNm"]),
    ]
    rows = [{"quantity": q, "derived": g12(d), "datasheet": g12(s), "relError": g12((d - s) / s)} for q, d, s in checks]
    return {
        "datasheet": m,
        "derived": {
            "electricalTimeConstantS": g12(tau_e),
            "frictionTorqueNm": g12(friction_torque),
            "noLoadSpeedRadS": g12(no_load_speed),
        },
        "checks": rows,
        "maxAbsRelError": g12(max(abs(row["relError"]) for row in rows)),
    }


# ---------------------------------------------------------------------------------------------------------------------
# 2. DC motor voltage step, rotor only, with inductance, no friction, no load (exact 2x2 linear ODE solution)
#    L di/dt = V - R i - ke w ;  J dw/dt = kt i ;  i(0) = w(0) = 0
# ---------------------------------------------------------------------------------------------------------------------
def dc_step_solution(v, r, l, kt, j):
    ke = kt
    w_ss = v / ke
    # deviation x = [i - 0, w - w_ss]; x' = A x ; A = [[-R/L, -ke/L], [kt/J, 0]]
    a11, a12, a21 = -r / l, -ke / l, kt / j
    tr, det = a11, -a12 * a21
    disc = tr * tr - 4.0 * det
    assert disc > 0.0, "overdamped case expected for the maxon data"
    l1 = (tr + math.sqrt(disc)) / 2.0
    l2 = (tr - math.sqrt(disc)) / 2.0
    # eigenvectors [ (l - a22)/a21 ... ] use v = [l, a21] since a22 = 0: (A - l I) v = 0 -> a21 * v0 - l * v1 = 0
    v1 = (l1, a21)
    v2 = (l2, a21)
    x0 = (0.0, -w_ss)
    # solve c1 v1 + c2 v2 = x0
    d = v1[0] * v2[1] - v2[0] * v1[1]
    c1 = (x0[0] * v2[1] - v2[0] * x0[1]) / d
    c2 = (v1[0] * x0[1] - x0[0] * v1[1]) / d

    def state(t):
        e1, e2 = math.exp(l1 * t), math.exp(l2 * t)
        i = c1 * v1[0] * e1 + c2 * v2[0] * e2
        w = w_ss + c1 * v1[1] * e1 + c2 * v2[1] * e2
        return i, w

    return state, (l1, l2), w_ss


def simpson(f, a, b, n):
    if n % 2:
        n += 1
    h = (b - a) / n
    total = f(a) + f(b)
    for k in range(1, n):
        total += (4.0 if k % 2 else 2.0) * f(a + k * h)
    return total * h / 3.0


def dc_step():
    m = MAXON
    v, r, l, kt, j = m["nominalVoltageV"], m["terminalResistanceOhm"], m["terminalInductanceH"], m["torqueConstantNmPerA"], m["rotorInertiaKgM2"]
    state, (l1, l2), w_ss = dc_step_solution(v, r, l, kt, j)
    samples = []
    for t in (0.0005, 0.001, 0.002, 0.00428, 0.01, 0.02, 0.03):
        i, w = state(t)
        samples.append({"tS": t, "currentA": g12(i), "speedRadS": g12(w), "speedRpm": g12(w * RPM)})
    # current peak: di/dt = 0 -> c1 v1x l1 e^{l1 t} + c2 v2x l2 e^{l2 t} = 0 (bisection on the closed form)
    def didt(t):
        h = 1e-9
        return (state(t + h)[0] - state(t - h)[0]) / (2 * h)

    lo, hi = 1e-7, 2e-3
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        if didt(mid) > 0:
            lo = mid
        else:
            hi = mid
    t_peak = 0.5 * (lo + hi)
    i_peak = state(t_peak)[0]
    t_end = 0.03
    n = 400000
    e_in = simpson(lambda t: v * state(t)[0], 0.0, t_end, n)
    e_r = simpson(lambda t: r * state(t)[0] ** 2, 0.0, t_end, n)
    i_end, w_end = state(t_end)
    ke_end = 0.5 * j * w_end * w_end
    el_end = 0.5 * l * i_end * i_end
    closure = e_in - e_r - ke_end - el_end
    assert abs(closure) < 1e-9 * e_in, closure
    return {
        "eigenvalues": [g12(l1), g12(l2)],
        "steadySpeedRadS": g12(w_ss),
        "steadySpeedRpm": g12(w_ss * RPM),
        "samples": samples,
        "currentPeak": {"tS": g12(t_peak), "currentA": g12(i_peak)},
        "energyTo30ms": {
            "inputJ": g12(e_in),
            "copperLossJ": g12(e_r),
            "kineticJ": g12(ke_end),
            "magneticJ": g12(el_end),
            "closureJ": g12(closure),
        },
    }


# ---------------------------------------------------------------------------------------------------------------------
# 3. Winding thermal model (2 nodes): Cw = tau_w / Rth1, Cs = tau_s / Rth2 (parameterisation rule TR-DRV-09)
# ---------------------------------------------------------------------------------------------------------------------
ALPHA_CU = 0.0039  # 1/K, copper resistance temperature coefficient used by maxon catalogues [R1] (Simscape uses 3.93e-3 [R6])


def thermal_steady(current, ambient=25.0):
    m = MAXON
    r25 = m["terminalResistanceOhm"]
    rth = m["thermalResistanceWindingHousingKPerW"] + m["thermalResistanceHousingAmbientKPerW"]
    # Tw = Ta + I^2 R25 (1 + a (Tw - 25)) Rth  -> linear in Tw
    k = current * current * r25 * rth
    tw = (ambient + k * (1.0 - ALPHA_CU * 25.0)) / (1.0 - k * ALPHA_CU)
    return tw


def thermal_max_current(tw_max, ambient=25.0):
    m = MAXON
    r_hot = m["terminalResistanceOhm"] * (1.0 + ALPHA_CU * (tw_max - 25.0))
    rth = m["thermalResistanceWindingHousingKPerW"] + m["thermalResistanceHousingAmbientKPerW"]
    return math.sqrt((tw_max - ambient) / (r_hot * rth))


def thermal_transient(power, times):
    """Constant power P into the winding node, alpha = 0, from ambient. Exact 2x2 linear solution."""
    m = MAXON
    r1, r2 = m["thermalResistanceWindingHousingKPerW"], m["thermalResistanceHousingAmbientKPerW"]
    cw, cs = m["thermalTimeConstantWindingS"] / r1, m["thermalTimeConstantMotorS"] / r2
    # states u = Tw - Ta, s = Ts - Ta
    # cw u' = P - (u - s)/r1 ; cs s' = (u - s)/r1 - s/r2
    a = [[-1.0 / (cw * r1), 1.0 / (cw * r1)], [1.0 / (cs * r1), -1.0 / (cs * r1) - 1.0 / (cs * r2)]]
    u_ss, s_ss = power * (r1 + r2), power * r2
    tr = a[0][0] + a[1][1]
    det = a[0][0] * a[1][1] - a[0][1] * a[1][0]
    disc = math.sqrt(tr * tr - 4 * det)
    l1, l2 = (tr + disc) / 2, (tr - disc) / 2
    v1 = (a[0][1], l1 - a[0][0])
    v2 = (a[0][1], l2 - a[0][0])
    x0 = (-u_ss, -s_ss)
    d = v1[0] * v2[1] - v2[0] * v1[1]
    c1 = (x0[0] * v2[1] - v2[0] * x0[1]) / d
    c2 = (v1[0] * x0[1] - x0[0] * v1[1]) / d
    rows = []
    for t in times:
        e1, e2 = math.exp(l1 * t), math.exp(l2 * t)
        u = u_ss + c1 * v1[0] * e1 + c2 * v2[0] * e2
        s = s_ss + c1 * v1[1] * e1 + c2 * v2[1] * e2
        rows.append({"tS": t, "windingRiseK": g12(u), "housingRiseK": g12(s)})
    return {
        "powerW": power,
        "windingCapacityJPerK": g12(cw),
        "housingCapacityJPerK": g12(cs),
        "timeConstantsS": [g12(-1 / l1), g12(-1 / l2)],
        "steadyWindingRiseK": g12(u_ss),
        "samples": rows,
    }


def thermal():
    nominal = MAXON["nominalCurrentA"]
    # duty cycle: 6 A for 1 s, 0 A for 3 s. The period (4 s) is ~1/10 of tau_w (41.5 s), so the winding ripple stays small and
    # the periodic mean temperature equals the steady state at the RMS current (exact for the mean of a linear network,
    # alpha = 0; with alpha the RMS fixed point is the approximation VC-DRV-08 bounds with 3 K)
    i_peak, t_on, t_off = 6.0, 1.0, 3.0
    i_rms = math.sqrt(i_peak * i_peak * t_on / (t_on + t_off))
    r25 = MAXON["terminalResistanceOhm"]
    rth = MAXON["thermalResistanceWindingHousingKPerW"] + MAXON["thermalResistanceHousingAmbientKPerW"]
    mean_rise_alpha0 = i_rms * i_rms * r25 * rth
    return {
        "alphaPerK": ALPHA_CU,
        "steadyAtNominalCurrentC": g12(thermal_steady(nominal)),
        "maxContinuousCurrentAt155CA": g12(thermal_max_current(MAXON["maxWindingTemperatureC"])),
        "runawayCurrentA": g12(math.sqrt(1.0 / (ALPHA_CU * r25 * rth))),
        "transient10W": thermal_transient(10.0, (10.0, 41.5, 300.0, 809.0, 3000.0, 10000.0)),
        "dutyCycle": {
            "currentA": i_peak,
            "onS": t_on,
            "offS": t_off,
            "rmsCurrentA": g12(i_rms),
            "rmsTorqueNm": g12(i_rms * MAXON["torqueConstantNmPerA"]),
            "periodicMeanWindingRiseAlpha0K": g12(mean_rise_alpha0),
            "steadyWindingAtRmsCurrentC": g12(thermal_steady(i_rms)),
        },
    }


# ---------------------------------------------------------------------------------------------------------------------
# 4. Transmissions
# ---------------------------------------------------------------------------------------------------------------------
def gear():
    t_in, n, eta, j_in, j_out = 0.1, 10.0, 0.9, 1.37e-5, 1.37e-3
    alpha_out = t_in / (j_in * n + j_out / (n * eta))
    # gear spin-up: J_i a_i = T - T_c, J_o a_o = N eta T_c, a_i = N a_o  ->  a_o = T / (J_i N + J_o / (N eta))
    # inertia-only load at acceleration a_L through ratio N (lossless): T_m = (J_m N + J_L / N) a_L, minimum at N = sqrt(J_L / J_m)
    alpha_load = 100.0
    ratios = [2, 5, 8, 10, 12, 20, 50]
    sweep = [{"ratio": k, "peakMotorTorqueNm": g12((j_in * k + j_out / k) * alpha_load)} for k in ratios]
    return {
        "spinUp": {
            "inputTorqueNm": t_in,
            "ratio": n,
            "efficiency": eta,
            "inputInertiaKgM2": j_in,
            "outputInertiaKgM2": j_out,
            "outputAccelerationRadS2": g12(alpha_out),
            "couplingTorqueInputNm": g12(t_in - j_in * n * alpha_out),
        },
        "reflectedInertiaKgM2": g12(j_out / n**2),
        "optimalRatio": {
            "motorInertiaKgM2": j_in,
            "loadInertiaKgM2": j_out,
            "loadAccelerationRadS2": alpha_load,
            "ratio": g12(math.sqrt(j_out / j_in)),
            "minPeakMotorTorqueNm": g12(2 * math.sqrt(j_in * j_out) * alpha_load),
            "sweep": sweep,
        },
        "rmsTorque": {"profile": [[2.0, 1.0], [0.0, 3.0]], "rmsNm": g12(math.sqrt((4.0 * 1.0) / 4.0))},
    }


def lead_screw():
    """Square-thread power screw, mean diameter d_m, lead l, tan(lambda) = l / (pi d_m), tan(phi) = mu, k = 2 pi / l.
    Power through the thread: forward (screw drives nut) T_c * w * eta_f = F_t * v; back-drive (nut drives screw)
    T_c * w = eta_b * F_t * v, eta_f = tan(lambda) / tan(lambda + phi), eta_b = tan(lambda - phi) / tan(lambda), locking iff mu >= tan(lambda).
    Lift with motor torque T_m on a screw of inertia J:  J alpha = T_m - T_c, m a = F_t - m g, a = alpha / k  ->
        a = (T_m k eta_f - m g) / (m + J k^2 eta_f)
    Fall with the motor off (back-driven):  m a = m g - F_t, J alpha = eta_b F_t / k  ->  a = m g / (m + J k^2 / eta_b)
    """
    g = 9.81
    d_m, lead, m, j = 0.010, 0.010, 10.0, 1e-5
    tan_l = lead / (math.pi * d_m)
    lam = math.atan(tan_l)
    k = 2 * math.pi / lead

    def case(mu, motor_torque):
        phi = math.atan(mu)
        eta_f = tan_l / math.tan(lam + phi)
        locking = mu >= tan_l
        eta_b = math.tan(lam - phi) / tan_l if not locking else 0.0
        lift_acc = (motor_torque * k * eta_f - m * g) / (m + j * k * k * eta_f)
        fall_acc = m * g / (m + j * k * k / eta_b) if not locking else 0.0
        holding = m * g * d_m / 2 * math.tan(lam - phi)  # torque needed to hold; <= 0 when self-locking
        return {
            "mu": mu,
            "frictionAngleDeg": g12(math.degrees(phi)),
            "forwardEfficiency": g12(eta_f),
            "backDriveEfficiency": g12(eta_b),
            "selfLocking": locking,
            "liftAccelerationMS2": g12(lift_acc),
            "liftTorqueStaticNm": g12(m * g / (k * eta_f)),
            "fallAccelerationMotorOffMS2": g12(fall_acc),
            "holdingTorqueNm": g12(holding),
        }

    return {
        "meanDiameterM": d_m,
        "leadM": lead,
        "massKg": m,
        "screwInertiaKgM2": j,
        "g": g,
        "leadAngleDeg": g12(math.degrees(lam)),
        "motorTorqueNm": 0.5,
        "free": case(0.10, 0.5),
        "locking": case(0.35, 0.5),
        "forceFromTorque": {"torqueNm": 0.1, "leadM": 0.005, "efficiency": 0.9, "forceN": g12(2 * math.pi * 0.9 * 0.1 / 0.005)},
    }


def backlash():
    gap_deg = 0.5
    return {"halfGapDeg": gap_deg / 2, "totalGapDeg": gap_deg, "lostMotionOnReversalDeg": gap_deg}


# ---------------------------------------------------------------------------------------------------------------------
# 5. Friction
# ---------------------------------------------------------------------------------------------------------------------
def stick_slip():
    """Mass m, spring k to ground, on a belt at vb; static Fs, kinetic Fk (Coulomb with stiction). Derivation:
    stick: x rises at vb until k x = Fs  -> x_s = Fs / k
    slip : m x'' = -k x + Fk, x(0) = x_s, x'(0) = vb  -> x - x_e = (x_s - x_e) cos(w t) + (vb / w) sin(w t), x_e = Fk / k
           slip ends when x' = vb again: tan(u / 2) = -a / vb with a = (x_s - x_e) w  ->  u = 2 pi - 2 atan(a / vb)
           there x = 2 x_e - x_s (symmetry), then stick again: t_stick = 2 (x_s - x_e) / vb
    """
    m, k, vb, fs, fk = 1.0, 100.0, 0.1, 2.0, 1.0
    w = math.sqrt(k / m)
    xs, xe = fs / k, fk / k
    a = (xs - xe) * w
    u = 2 * math.pi - 2 * math.atan(a / vb)
    t_slip = u / w
    t_stick = 2 * (xs - xe) / vb
    x_end = xe + (xs - xe) * math.cos(u) + (vb / w) * math.sin(u)
    return {
        "massKg": m,
        "stiffnessNPerM": k,
        "beltSpeedMS": vb,
        "staticN": fs,
        "kineticN": fk,
        "stickReleaseXM": g12(xs),
        "slipEndXM": g12(x_end),
        "slipTimeS": g12(t_slip),
        "stickTimeS": g12(t_stick),
        "periodS": g12(t_slip + t_stick),
        "minVelocityMS": g12(-math.hypot(a, vb)),
    }


def breakaway():
    fs, fc, m, rate = 2.0, 1.0, 1.0, 1.0
    return {"staticN": fs, "coulombN": fc, "massKg": m, "forceRateNPerS": rate, "breakawayTimeS": g12(fs / rate), "accelerationAfterBreakawayMS2": g12((fs - fc) / m)}


def pin_friction():
    j, m, g, r, mu, t = 0.01, 5.0, 9.81, 0.01, 0.2, 0.2
    tf = mu * m * g * r
    return {"inertiaKgM2": j, "radialLoadKg": m, "g": g, "pinRadiusM": r, "mu": mu, "torqueNm": t, "frictionTorqueNm": g12(tf), "accelerationRadS2": g12((t - tf) / j)}


def spin_down():
    """J w' = -Tf - b w ; w(t) = (w0 + Tf/b) e^{-b t / J} - Tf/b until w = 0 (calibration oracle, synthetic data)."""
    j, tf, b, w0 = MAXON["rotorInertiaKgM2"], 4.14e-3, 1e-6, 800.0
    stop = (j / b) * math.log((w0 + tf / b) / (tf / b))
    rows = []
    for t in (0.0, 0.5, 1.0, 1.5, 2.0, 2.5):
        if t < stop:
            w = (w0 + tf / b) * math.exp(-b * t / j) - tf / b
        else:
            w = 0.0
        rows.append({"tS": t, "speedRadS": g12(w)})
    return {"inertiaKgM2": j, "coulombTorqueNm": tf, "viscousNmsPerRad": b, "initialSpeedRadS": w0, "stopTimeS": g12(stop), "samples": rows}


def end_stop():
    """Linear spring-damper stop, damping ratio z: restitution e = exp(-z pi / sqrt(1 - z^2)); peak penetration of a body
    arriving at speed v: x_max = (v / wd) exp(-z wn t*) sin(wd t*), t* = atan(sqrt(1 - z^2) / z) / wd."""
    j, k, z, v = 0.01, 1000.0, 0.2, 1.0  # kg m^2, N m/rad, -, rad/s
    wn = math.sqrt(k / j)
    wd = wn * math.sqrt(1 - z * z)
    e = math.exp(-z * math.pi / math.sqrt(1 - z * z))
    t_star = math.atan(math.sqrt(1 - z * z) / z) / wd
    x_max = (v / wd) * math.exp(-z * wn * t_star) * math.sin(wd * t_star)
    return {"inertiaKgM2": j, "stopStiffnessNmPerRad": k, "dampingRatio": z, "impactSpeedRadS": v, "restitution": g12(e), "contactTimeS": g12(math.pi / wd), "peakPenetrationRad": g12(x_max), "peakPenetrationTimeS": g12(t_star)}


# ---------------------------------------------------------------------------------------------------------------------
# 6. Motion profiles and cam laws (normalised rise h = 1 over beta = 1 at unit speed)
# ---------------------------------------------------------------------------------------------------------------------
def accel_modified_trapezoid(x):
    if x < 1 / 8:
        return math.sin(4 * math.pi * x)
    if x < 3 / 8:
        return 1.0
    if x < 5 / 8:
        return math.cos(4 * math.pi * (x - 3 / 8))
    if x < 7 / 8:
        return -1.0
    return -math.cos(4 * math.pi * (x - 7 / 8))


def accel_modified_sine(x):
    if x < 1 / 8:
        return math.sin(4 * math.pi * x)
    if x < 7 / 8:
        return math.cos((4 * math.pi / 3) * (x - 1 / 8))
    return -math.cos(4 * math.pi * (x - 7 / 8))


def cam_coefficients(shape, n=200000):
    """Integrate the unnormalised acceleration shape twice (trapezoid rule on a fine grid), normalise so s(1) = 1."""
    h = 1.0 / n
    v = s = 0.0
    a_prev = shape(0.0)
    v_peak = 0.0
    for k in range(1, n + 1):
        a_k = shape(k * h)
        v_new = v + 0.5 * (a_prev + a_k) * h
        s += 0.5 * (v + v_new) * h
        v = v_new
        a_prev = a_k
        v_peak = max(v_peak, v)
    scale = 1.0 / s
    a_peak = max(abs(shape(k / 1000.0)) for k in range(1001)) * scale
    return {"Cv": g12(v_peak * scale), "Ca": g12(a_peak), "endVelocity": g12(v * scale)}


def cam_laws():
    return {
        "cycloidal": {"Cv": 2.0, "Ca": g12(2 * math.pi), "Cj": g12(4 * math.pi**2), "formula": "s = x - sin(2 pi x) / (2 pi)"},
        "poly345": {"Cv": 1.875, "Ca": g12(10 * math.sqrt(3) / 3), "Cj": 60.0, "formula": "s = 10x^3 - 15x^4 + 6x^5"},
        "harmonic": {"Cv": g12(math.pi / 2), "Ca": g12(math.pi**2 / 2), "formula": "s = (1 - cos(pi x)) / 2"},
        "modifiedTrapezoid": {**cam_coefficients(accel_modified_trapezoid), "definition": "sine ramps on 1/8, flat on 2/8 (Neklutin)"},
        "modifiedSine": {**cam_coefficients(accel_modified_sine), "definition": "sine of period 1/2 on [0, 1/8] and [7/8, 1], period 3/2 between"},
    }


def profiles():
    d, vmax, amax, jerk = 0.1, 0.5, 5.0, 100.0
    t_trap = d / vmax + vmax / amax
    t_s = d / vmax + vmax / amax + amax / jerk
    return {
        "trapezoid": {"distanceM": d, "vmax": vmax, "amax": amax, "durationS": g12(t_trap), "accelTimeS": g12(vmax / amax)},
        "triangle": {"distanceM": 1.0, "durationS": 1.0, "peakVelocityMS": 2.0, "peakAccelerationMS2": 4.0},
        "sCurve": {"distanceM": d, "vmax": vmax, "amax": amax, "jerk": jerk, "durationS": g12(t_s), "jerkTimeS": g12(amax / jerk)},
        "camLaws": cam_laws(),
    }


# ---------------------------------------------------------------------------------------------------------------------
# 7. Controllers
# ---------------------------------------------------------------------------------------------------------------------
def pi_speed_loop():
    """J s w = T, PI: T = Kp e + Ki int e, zeta = 1, wn = 100: y = 1 - e^{-wn t} + wn t e^{-wn t}; peak at t = 2 / wn."""
    j, wn = 1e-3, 100.0
    kp, ki = 2 * wn * j, wn * wn * j
    rows = []
    for t in (0.005, 0.01, 0.02, 0.05):
        rows.append({"tS": t, "response": g12(1 - math.exp(-wn * t) + wn * t * math.exp(-wn * t))})
    return {"inertiaKgM2": j, "kp": g12(kp), "ki": g12(ki), "peakTimeS": g12(2 / wn), "peakResponse": g12(1 + math.exp(-2.0)), "samples": rows}


def prescribed_inverse_dynamics():
    j, amax = 1e-3, 100.0
    return {"inertiaKgM2": j, "peakAccelerationRadS2": amax, "peakTorqueNm": g12(j * amax)}


# ---------------------------------------------------------------------------------------------------------------------
# 8. Other machines
# ---------------------------------------------------------------------------------------------------------------------
def pmsm():
    lam, p, l, imax, vdc = 0.01, 4, 0.2e-3, 20.0, 24.0
    vmax = vdc / math.sqrt(3)
    t_max = 1.5 * p * lam * imax
    we_base = vmax / math.sqrt(lam**2 + (l * imax) ** 2)
    we_max = vmax / (lam - l * imax)
    rows = []
    for wm in (100.0, 300.0, 400.0, 500.0, 550.0):
        we = p * wm
        if we <= we_base:
            torque, i_d = t_max, 0.0
        else:
            i_d = ((vmax / we) ** 2 - lam**2 - (l * imax) ** 2) / (2 * lam * l)
            i_q = math.sqrt(max(imax**2 - i_d**2, 0.0))
            torque = 1.5 * p * lam * i_q
        rows.append({"mechSpeedRadS": wm, "torqueNm": g12(torque), "idA": g12(i_d)})
    return {
        "fluxLinkageWb": lam,
        "polePairs": p,
        "inductanceH": l,
        "currentLimitA": imax,
        "busVoltageV": vdc,
        "phaseVoltageLimitV": g12(vmax),
        "maxTorqueNm": g12(t_max),
        "baseSpeedRadS": g12(we_base / p),
        "maxSpeedRadS": g12(we_max / p),
        "envelope": rows,
    }


def induction():
    tb, sb = 100.0, 0.1
    kloss = {s: g12(2 * tb / (s / sb + sb / s)) for s in (0.05, 0.1, 0.5, 1.0)}
    x = 2 - math.sqrt(3)  # s / sb for T = Tb / 2
    v, f, p, r1, r2, x12 = 230.0, 50.0, 2, 0.5, 0.4, 2.0
    ws = 2 * math.pi * f / p
    s_b = r2 / math.sqrt(r1**2 + x12**2)
    t_b = 3 * v * v / (2 * ws * (r1 + math.sqrt(r1**2 + x12**2)))

    def t_circuit(s):
        return 3 * v * v * (r2 / s) / (ws * ((r1 + r2 / s) ** 2 + x12**2))

    return {
        "kloss": {"breakdownTorqueNm": tb, "breakdownSlip": sb, "torqueAtSlip": {str(k): val for k, val in kloss.items()}, "slipAtHalfBreakdown": g12(x * sb)},
        "circuit": {
            "phaseVoltageV": v,
            "frequencyHz": f,
            "polePairs": p,
            "r1Ohm": r1,
            "r2Ohm": r2,
            "x1PlusX2Ohm": x12,
            "syncSpeedRadS": g12(ws),
            "breakdownSlip": g12(s_b),
            "breakdownTorqueNm": g12(t_b),
            "torqueAtBreakdownSlipNm": g12(t_circuit(s_b)),
            "startingTorqueNm": g12(t_circuit(1.0)),
        },
    }


def stepper():
    th, nr, j = 0.5, 50, 1e-5
    wn = math.sqrt(th * nr / j)
    t_ext = 0.25
    return {
        "holdingTorqueNm": th,
        "rotorTeeth": nr,
        "stepsPerRev": 4 * nr,
        "rotorInertiaKgM2": j,
        "naturalFrequencyHz": g12(wn / (2 * math.pi)),
        "staticDeflectionDegAtHalfHoldingTorque": g12(math.degrees(math.asin(t_ext / th) / nr)),
    }


def hydraulic():
    ps, bore, cd, av, rho, f = 10e6, 0.050, 0.62, 2e-6, 850.0, 5000.0
    a = math.pi * (bore / 2) ** 2
    p_cap = f / a
    q = cd * av * math.sqrt(2 * (ps - p_cap) / rho)
    return {"supplyPa": ps, "boreM": bore, "cd": cd, "valveAreaM2": av, "densityKgM3": rho, "loadN": f, "capPressurePa": g12(p_cap), "flowM3S": g12(q), "speedMS": g12(q / a)}


def main():
    reference = {
        "pack": "23-drives-physical-truth",
        "generatedBy": "generate_drv_reference.py",
        "maxon148877": maxon_consistency(),
        "dcStep": dc_step(),
        "thermal": thermal(),
        "gear": gear(),
        "leadScrew": lead_screw(),
        "backlash": backlash(),
        "stickSlip": stick_slip(),
        "breakaway": breakaway(),
        "pinFriction": pin_friction(),
        "spinDown": spin_down(),
        "endStop": end_stop(),
        "profiles": profiles(),
        "piSpeedLoop": pi_speed_loop(),
        "inverseDynamics": prescribed_inverse_dynamics(),
        "pmsm": pmsm(),
        "induction": induction(),
        "stepper": stepper(),
        "hydraulic": hydraulic(),
    }
    with open("drv_reference.json", "w", encoding="utf-8", newline="\n") as handle:
        json.dump(reference, handle, indent=1, sort_keys=False)
        handle.write("\n")


if __name__ == "__main__":
    main()
