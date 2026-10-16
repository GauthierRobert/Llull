#!/usr/bin/env python3
"""PHY-09 structural dynamics: analytic reference values.

Python 3 standard library only. Run from this folder:  python3 -I generate_dynamics_reference.py
Re-running must give byte-identical files (no time stamps, no randomness, fixed iteration counts).

Writes:
  expected_results.json   cases VC-DYN-xx (PHY README section 6.3 schema)
  sdof_frf.csv            SDOF receptance / transmissibility / relative-displacement FRF, zeta = 0.05
  gevs_profile.csv        GEVS component qualification + acceptance ASD breakpoints, segment slopes and areas
  srs_half_sine.csv       maximax absolute-acceleration SRS of a half-sine pulse, Q = 10, two independent methods

Every value is derived here from a formula named next to it. Inputs that come from a source are tagged with
the source id of sources.md (S-numbers). Nothing is fitted to an expected answer.
"""

import cmath
import csv
import json
import math

SIG = 12


def r12(x):
    """Round to 12 significant digits (PHY README section 6.3)."""
    if isinstance(x, (list, tuple)):
        return [r12(v) for v in x]
    if x == 0:
        return 0.0
    return float('%.12g' % x)


CASES = []


def case(cid, quantity, value, unit, tol, source, grade, proves, **extra):
    entry = {
        'id': cid,
        'quantity': quantity,
        'value': r12(value) if isinstance(value, (int, float, list, tuple)) else value,
        'unit': unit,
        'tolerance': tol,
        'source': source,
        'grade': grade,
        'proves': proves,
    }
    entry.update(extra)
    CASES.append(entry)


# ---------------------------------------------------------------------------------------------------------------
# 1. SDOF frequency response (S10 textbook forms; derivations below)
#    receptance  H(r) = 1 / (k (1 - r^2 + 2 i zeta r)),  r = f / fn
#    base-excitation absolute transmissibility  T(r) = (1 + 2 i zeta r) / (1 - r^2 + 2 i zeta r)
# ---------------------------------------------------------------------------------------------------------------

def receptance_norm(r, zeta):
    """k |H| (dimensionless dynamic amplification)."""
    return 1.0 / abs(complex(1.0 - r * r, 2.0 * zeta * r))


def transmissibility(r, zeta):
    return abs(complex(1.0, 2.0 * zeta * r) / complex(1.0 - r * r, 2.0 * zeta * r))


ZETA = 0.05
Q = 1.0 / (2.0 * ZETA)

amp_at_fn = receptance_norm(1.0, ZETA)
r_peak = math.sqrt(1.0 - 2.0 * ZETA * ZETA)
amp_peak = 1.0 / (2.0 * ZETA * math.sqrt(1.0 - ZETA * ZETA))
case('VC-DYN-01', 'SDOF dynamic amplification k|H| at f = fn, zeta = 0.05 (equals Q = 1/(2 zeta))', amp_at_fn, '-',
     {'rel': 1e-9}, 'derived (S10 receptance)', 'A', ['FR-DYN-04', 'TR-DYN-20', 'FR-DYN-17', 'FR-DYN-19'],
     inputs={'zeta': ZETA}, derivation='k|H(1)| = 1/(2 zeta)')
case('VC-DYN-02', 'SDOF receptance peak: frequency ratio r_peak = sqrt(1 - 2 zeta^2) and peak k|H|max = 1/(2 zeta sqrt(1 - zeta^2))',
     [r_peak, amp_peak], '-', {'rel': 1e-9}, 'derived (S10)', 'A', ['FR-DYN-04', 'TR-DYN-20'],
     inputs={'zeta': ZETA})

# half-power bandwidth: solve |H(r)| = |H|max / sqrt(2) exactly (quadratic in r^2)
# (1 - r^2)^2 + 4 zeta^2 r^2 = 2 * 4 zeta^2 (1 - zeta^2)  ->  r^2 = 1 - 2 zeta^2 -/+ 2 zeta sqrt(1 - zeta^2)
rad = 2.0 * ZETA * math.sqrt(1.0 - ZETA * ZETA)
r1 = math.sqrt(1.0 - 2.0 * ZETA * ZETA - rad)
r2 = math.sqrt(1.0 - 2.0 * ZETA * ZETA + rad)
q_half_power = 1.0 / (r2 - r1)
case('VC-DYN-03', 'half-power points r1, r2 and Q estimate 1/(r2 - r1) for zeta = 0.05 (Q = 10 nominal)', [r1, r2, q_half_power], '-',
     {'rel': 1e-9}, 'derived (S10)', 'A', ['FR-DYN-05', 'TR-DYN-22'],
     note='The half-power estimate differs from 1/(2 zeta) by 0.0625 % at zeta = 0.05; check_dynamics reports Q both ways.')

t_at_fn = transmissibility(1.0, ZETA)
t_at_sqrt2 = [transmissibility(math.sqrt(2.0), z) for z in (0.01, 0.05, 0.2)]
case('VC-DYN-04', 'base-excitation transmissibility |T| at r = 1 (sqrt(1 + 4 zeta^2)/(2 zeta)) and at r = sqrt(2) for zeta 0.01, 0.05, 0.2 (always 1)',
     [t_at_fn] + t_at_sqrt2, '-', {'rel': 1e-9}, 'derived (S10)', 'A', ['FR-DYN-06', 'TR-DYN-20'])

with open('sdof_frf.csv', 'w', newline='') as fh:
    w = csv.writer(fh, lineterminator='\n')
    w.writerow(['r', 'k_abs_H', 'phase_H_deg', 'abs_T', 'omega_n2_abs_Hrel'])
    for i in range(0, 301):
        r = i / 100.0
        h = 1.0 / complex(1.0 - r * r, 2.0 * ZETA * r)
        t = complex(1.0, 2.0 * ZETA * r) * h
        # relative displacement per unit base acceleration: z / a_b = -1 / (wn^2 (1 - r^2 + 2 i zeta r)); stored as wn^2 |z/a_b|
        w.writerow(['%.2f' % r, '%.12g' % abs(h), '%.12g' % math.degrees(cmath.phase(h)), '%.12g' % abs(t), '%.12g' % abs(h)])

# ---------------------------------------------------------------------------------------------------------------
# 2. Rayleigh damping coefficients from two target damping ratios (CalculiX *MODAL DAMPING,RAYLEIGH, S1:
#    zeta_j = alpha/(2 w_j) + beta w_j/2)
# ---------------------------------------------------------------------------------------------------------------
f_a, f_b, zeta_t = 10.0, 100.0, 0.02
w_a, w_b = 2 * math.pi * f_a, 2 * math.pi * f_b
alpha = 2.0 * zeta_t * w_a * w_b / (w_a + w_b)
beta = 2.0 * zeta_t / (w_a + w_b)
zeta_mid = alpha / (2 * 2 * math.pi * math.sqrt(f_a * f_b)) + beta * 2 * math.pi * math.sqrt(f_a * f_b) / 2
case('VC-DYN-05', 'Rayleigh alpha (1/s), beta (s) giving zeta = 0.02 at 10 Hz and 100 Hz; zeta at sqrt(10*100) Hz', [alpha, beta, zeta_mid],
     '1/s, s, -', {'rel': 1e-9}, 'derived from S1 (*MODAL DAMPING, RAYLEIGH formula)', 'A', ['FR-DYN-03', 'TR-DYN-11'],
     note='zeta dips to 0.0115 at the geometric mean of the anchors: the agent must report the damping actually applied per mode.')

# ---------------------------------------------------------------------------------------------------------------
# 3. CalculiX beamdy8 cross-check (S2, pinned test deck): mode-1 modal coordinate q1(f) under Rayleigh alpha = 5000.
#    q1(f) = F1 / (w1^2 - w^2 + i alpha w)  (mass-normalised modes, C = alpha M, beta = 0).
#    F1 is derived from the reference value at f = f1 (pure imaginary there); q1 at the 8 other points is predicted.
# ---------------------------------------------------------------------------------------------------------------
W1 = 0.8228479e05  # rad/time, beamdy8.dat.ref EIGENVALUE OUTPUT mode 1 (S2)
F1_HZ = 0.1309603e05
ALPHA_BEAMDY8 = 5000.0
REF_Q1 = [  # (frequency cycles/time, Re q1, Im q1) from beamdy8.dat.ref, PARTICIPATION FACTORS FOR FREQUENCY ..., mode 1
    (0.1200000000000e05, 0.5349862e-03, -0.1857317e-03),
    (0.1211305531535e05, 0.5779606e-03, -0.2248237e-03),
    (0.1254801552883e05, 0.7796817e-03, -0.5539915e-03),
    (0.1298297574231e05, 0.4211571e-03, -0.1475796e-02),
    (0.1309603105766e05, -0.3667531e-17, -0.1582207e-02),
    (0.1318927521633e05, -0.3478933e-03, -0.1489781e-02),
    (0.1354801552883e05, -0.7600527e-03, -0.6804337e-03),
    (0.1390675584133e05, -0.5998997e-03, -0.3032582e-03),
    (0.1400000000000e05, -0.5577889e-03, -0.2537049e-03),
]
f_res, re_res, im_res = REF_Q1[4]
w_res = 2 * math.pi * f_res
modal_force = complex(re_res, im_res) * complex(W1 * W1 - w_res * w_res, ALPHA_BEAMDY8 * w_res)
pred = []
max_rel = 0.0
for f, re_q, im_q in REF_Q1:
    w = 2 * math.pi * f
    q = modal_force / complex(W1 * W1 - w * w, ALPHA_BEAMDY8 * w)
    ref = complex(re_q, im_q)
    rel = abs(q - ref) / abs(ref)
    max_rel = max(max_rel, rel)
    pred.append([f, q.real, q.imag, rel])
case('VC-DYN-06', 'CalculiX beamdy8 *STEADY STATE DYNAMICS: mode-1 modal coordinate predicted by the SDOF FRF at the 9 output frequencies; '
     'value = max relative deviation from the .dat.ref', max_rel, '-', {'abs': 2e-6},
     'S2 (CalculiX test beamdy8.inp / beamdy8.dat.ref, pinned) + derived', 'A', ['FR-DYN-02', 'FR-DYN-03', 'TR-DYN-10', 'TR-DYN-30'],
     inputs={'w1RadPerTime': W1, 'alpha': ALPHA_BEAMDY8, 'modalForceDerived': [r12(modal_force.real), r12(modal_force.imag)]},
     table=[[r12(v) for v in row] for row in pred],
     note='Reference values carry 7 significant digits, so agreement better than ~1e-6 is not expected. '
          'The 9 points also confirm the CalculiX point-placement rule (n m - m + n with n = 5, m = 1).')

# ---------------------------------------------------------------------------------------------------------------
# 4. Random vibration of an SDOF on a moving base
#    Miles (S5, S6):           g_rms = sqrt(pi/2 * fn * Q * W)
#    exact white noise:        sigma_a^2 = W fn * integral_0^inf |T(r)|^2 dr = W fn pi (1 + 4 zeta^2) / (4 zeta)
#    relative displacement:    sigma_z^2 = W g^2 / (8 zeta wn^3)          (W one-sided in g^2/Hz)
# ---------------------------------------------------------------------------------------------------------------
G0 = 9.80665  # m/s^2, standard gravity (BIPM SI brochure value; S11)


def simpson(fun, a, b, n):
    if n % 2:
        n += 1
    h = (b - a) / n
    s = fun(a) + fun(b)
    for i in range(1, n):
        s += (4 if i % 2 else 2) * fun(a + i * h)
    return s * h / 3.0


fn_m, q_m, w_m = 100.0, 10.0, 0.04
zeta_m = 1.0 / (2.0 * q_m)
miles = math.sqrt(math.pi / 2.0 * fn_m * q_m * w_m)
exact_white = math.sqrt(w_m * fn_m * math.pi * (1.0 + 4.0 * zeta_m * zeta_m) / (4.0 * zeta_m))
# numerical cross-check of the closed form: substitution r = tan(theta) maps [0, inf) to [0, pi/2)
num_white = math.sqrt(w_m * fn_m * simpson(lambda th: (transmissibility(math.tan(th), zeta_m) ** 2) / math.cos(th) ** 2
                                                if th < math.pi / 2 else 0.0, 0.0, math.pi / 2, 200000))
wn_m = 2 * math.pi * fn_m
z_rms = math.sqrt(w_m * G0 * G0 / (8.0 * zeta_m * wn_m ** 3))
case('VC-DYN-07', "Miles g_rms for fn = 100 Hz, Q = 10, W = 0.04 g^2/Hz; exact white-noise g_rms (factor 1 + 4 zeta^2); same by quadrature",
     [miles, exact_white, num_white], 'g', {'rel': 1e-6}, 'S5 (Miles 1954, citation) + S6 (NTRS 19900015329, abstract) + derived', 'A',
     ['FR-DYN-08', 'TR-DYN-40', 'TR-DYN-41', 'FR-DYN-17', 'FR-DYN-19'],
     derivation='integral_0^inf |T(r)|^2 dr = pi (1 + 4 zeta^2) / (4 zeta); Miles drops the 4 zeta^2 term')
case('VC-DYN-08', 'relative displacement rms of the same SDOF (white base acceleration 0.04 g^2/Hz)', z_rms * 1000.0, 'mm',
     {'rel': 1e-9}, 'derived (S10)', 'A', ['FR-DYN-08', 'TR-DYN-41'], inputs={'g0': G0})

# 3-sigma Gaussian exceedance (S10): P(|x| > 3 sigma) = erfc(3 / sqrt 2)
case('VC-DYN-09', 'probability that a zero-mean Gaussian response exceeds 3 sigma in magnitude', math.erfc(3.0 / math.sqrt(2.0)), '-',
     {'rel': 1e-9}, 'derived (Gaussian, S10)', 'A', ['FR-DYN-09', 'TR-DYN-42'],
     note='3-sigma peak is a named default (AF-31), not a law: the result states it.')

# ---------------------------------------------------------------------------------------------------------------
# 5. GEVS component random vibration (S3, S4): breakpoints quoted, overall grms derived with log-log segments.
#    segment area (S12 PSD integration rule): W(f) = W1 (f/f1)^n, n = ln(W2/W1)/ln(f2/f1)
#        n != -1:  A = W1 f1/(n+1) ((f2/f1)^(n+1) - 1);   n = -1:  A = W1 f1 ln(f2/f1)
# ---------------------------------------------------------------------------------------------------------------

def loglog_area(f1, w1, f2, w2):
    n = math.log(w2 / w1) / math.log(f2 / f1)
    if abs(n + 1.0) < 1e-12:
        return n, w1 * f1 * math.log(f2 / f1)
    return n, w1 * f1 / (n + 1.0) * ((f2 / f1) ** (n + 1.0) - 1.0)


def profile_grms(points):
    total = 0.0
    rows = []
    for (f1, w1), (f2, w2) in zip(points[:-1], points[1:]):
        n, a = loglog_area(f1, w1, f2, w2)
        total += a
        rows.append((f1, w1, f2, w2, n, 10.0 * n * math.log10(2.0), a))
    return math.sqrt(total), rows


GEVS_QUAL = [(20.0, 0.026), (50.0, 0.16), (800.0, 0.16), (2000.0, 0.026)]
GEVS_ACC = [(20.0, 0.013), (50.0, 0.08), (800.0, 0.08), (2000.0, 0.013)]
g_qual, rows_q = profile_grms(GEVS_QUAL)
g_acc, rows_a = profile_grms(GEVS_ACC)
case('VC-DYN-10', 'overall grms of the GEVS component qualification ASD (20-2000 Hz, log-log segments); acceptance (-3 dB) ASD', [g_qual, g_acc],
     'g', {'rel': 1e-9}, 'breakpoints S3 + S4 (quoted, B); integration derived', 'A',
     ['FR-DYN-07', 'TR-DYN-43'],
     note='Derived 14.14 g rounds to the 14.1 grms the sources print (acceptance 9.995 g -> 10.0); the breakpoints themselves are grade B until GSFC-STD-7000B '
          'Table 2.4-3 is read directly (sources.md). Slopes come out at +/-5.97 dB/oct (not exactly 6) because the tabulated end points are rounded; llull integrates the breakpoints as given.')

with open('gevs_profile.csv', 'w', newline='') as fh:
    w = csv.writer(fh, lineterminator='\n')
    w.writerow(['profile', 'f1_Hz', 'W1_g2_per_Hz', 'f2_Hz', 'W2_g2_per_Hz', 'slope_n', 'slope_dB_per_oct', 'area_g2'])
    for name, rows in (('gevs_component_qual', rows_q), ('gevs_component_accept', rows_a)):
        for f1, w1, f2, w2, n, db, a in rows:
            w.writerow([name, '%g' % f1, '%g' % w1, '%g' % f2, '%g' % w2, '%.12g' % n, '%.12g' % db, '%.12g' % a])

# SDOF on the GEVS qualification profile: exact numeric integral of |T|^2 W(f) vs Miles with W(fn)


def asd_at(points, f):
    for (f1, w1), (f2, w2) in zip(points[:-1], points[1:]):
        if f1 <= f <= f2:
            n = math.log(w2 / w1) / math.log(f2 / f1)
            return w1 * (f / f1) ** n
    return 0.0


fn_g, q_g = 200.0, 10.0
zeta_g = 1.0 / (2.0 * q_g)
miles_g = math.sqrt(math.pi / 2.0 * fn_g * q_g * asd_at(GEVS_QUAL, fn_g))
# integrate in log-frequency for accuracy: f = 20 * 100^u, u in [0, 1]
exact_g = math.sqrt(simpson(lambda u: asd_at(GEVS_QUAL, 20.0 * 100.0 ** u) * transmissibility(20.0 * 100.0 ** u / fn_g, zeta_g) ** 2
                            * 20.0 * 100.0 ** u * math.log(100.0), 0.0, 1.0, 400000))
case('VC-DYN-11', 'SDOF fn = 200 Hz, Q = 10 on GEVS qualification ASD: Miles g_rms (W(fn) = 0.16) and exact band-limited integral 20-2000 Hz',
     [miles_g, exact_g], 'g', {'rel': 1e-6}, 'derived (inputs S3/S4)', 'A', ['FR-DYN-07', 'FR-DYN-08', 'TR-DYN-40', 'TR-DYN-43'],
     note='The exact value includes off-resonance input outside the plateau; Miles is a quick check, never the answer of record (FR-DYN-08).')

# ---------------------------------------------------------------------------------------------------------------
# 6. Modal truncation check: uniform clamped-free beam, tip static compliance from modes
#    sum_n 4 / (beta_n L)^4 = 1/3 exactly (tip static compliance L^3/(3EI)); share of mode 1 = 12/(beta_1 L)^4
# ---------------------------------------------------------------------------------------------------------------

def clamped_free_root(n):
    f = lambda x: math.cos(x) * math.cosh(x) + 1.0
    lo = (n - 0.5) * math.pi - 0.5
    hi = (n - 0.5) * math.pi + 0.5
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        if f(lo) * f(mid) <= 0:
            hi = mid
        else:
            lo = mid
    return 0.5 * (lo + hi)


roots = [clamped_free_root(n) for n in range(1, 7)]
partial = []
acc = 0.0
for b in roots:
    acc += 4.0 / b ** 4
    partial.append(acc * 3.0)
case('VC-DYN-12', 'clamped-free beam: share of the tip static compliance captured by modes 1..6 (cumulative), from beta_n L roots',
     partial, '-', {'abs': 1e-9}, 'derived (Euler-Bernoulli, same roots as aerospace 05 S20)', 'A', ['FR-DYN-10', 'TR-DYN-31'],
     inputs={'betaL': r12(roots)},
     note='Mode 1 alone gives 97.07 %; the residual-flexibility warning DYN_MODAL_TRUNCATION fires below the user threshold.')

# ---------------------------------------------------------------------------------------------------------------
# 7. Shock response spectrum of a half-sine base acceleration pulse (maximax absolute acceleration, Q = 10)
#    method A: exact piecewise solution of z'' + 2 zeta wn z' + wn^2 z = -a_b(t), abs acc = -(2 zeta wn z' + wn^2 z)
#    method B: Smallwood ramp-invariant recursive filter (S7, S8; coefficients as in pyyeti absacce, S8)
# ---------------------------------------------------------------------------------------------------------------
A_PULSE = 1.0     # pulse peak (unit acceleration: the SRS is reported as a ratio)
T_PULSE = 0.011   # s, test input (11 ms is a common test duration; used here only as an input)


def srs_exact(fn, zeta, a, tp, samples_per_period=4000):
    wn = 2 * math.pi * fn
    wd = wn * math.sqrt(1 - zeta * zeta)
    om = math.pi / tp
    # particular solution z_p = C sin(om t) + D cos(om t)
    det = (wn * wn - om * om) ** 2 + (2 * zeta * wn * om) ** 2
    c = -a * (wn * wn - om * om) / det
    d = a * (2 * zeta * wn * om) / det
    # homogeneous e^{-zeta wn t}(E cos wd t + F sin wd t), z(0) = 0, z'(0) = 0
    e_ = -d
    f_ = (-(c * om) + zeta * wn * e_) / wd

    def state_in(t):
        ex = math.exp(-zeta * wn * t)
        cw, sw = math.cos(wd * t), math.sin(wd * t)
        z = c * math.sin(om * t) + d * math.cos(om * t) + ex * (e_ * cw + f_ * sw)
        zd = c * om * math.cos(om * t) - d * om * math.sin(om * t) + ex * (
            (-zeta * wn) * (e_ * cw + f_ * sw) + (-e_ * wd * sw + f_ * wd * cw))
        return z, zd

    def abs_acc(z, zd):
        return -(2 * zeta * wn * zd + wn * wn * z)

    period = 1.0 / fn
    dt = min(tp, period) / samples_per_period
    peak = 0.0
    n_in = int(math.ceil(tp / dt))
    for i in range(n_in + 1):
        t = min(i * dt, tp)
        z, zd = state_in(t)
        peak = max(peak, abs(abs_acc(z, zd)))
    z0, zd0 = state_in(tp)
    # free vibration after the pulse: z = e^{-zeta wn s}(z0 cos wd s + G sin wd s)
    g_ = (zd0 + zeta * wn * z0) / wd
    n_post = int(math.ceil(1.5 * period / dt))
    for i in range(1, n_post + 1):
        s = i * dt
        ex = math.exp(-zeta * wn * s)
        cw, sw = math.cos(wd * s), math.sin(wd * s)
        z = ex * (z0 * cw + g_ * sw)
        zd = ex * (-zeta * wn * (z0 * cw + g_ * sw) + (-z0 * wd * sw + g_ * wd * cw))
        peak = max(peak, abs(abs_acc(z, zd)))
    return peak


def srs_smallwood(fn, q, a, tp, sr_per_fn=400):
    zeta = 1.0 / (2.0 * q)
    wn = 2 * math.pi * fn
    dt = min(tp / 2000.0, 1.0 / (fn * sr_per_fn))
    wd = wn * math.sqrt(1 - zeta * zeta)
    e = math.exp(-zeta * wn * dt)
    e2 = e * e
    b_ = dt * wd
    c_ = e * math.cos(b_)
    sb = e * math.sin(b_) / b_
    b0, b1, b2 = 1 - sb, 2 * (sb - c_), e2 - sb
    a1, a2 = -2 * c_, e2
    n_total = int(math.ceil((tp + 1.5 / fn) / dt))
    x1 = x2 = 0.0
    y1 = y2 = 0.0
    peak = 0.0
    for i in range(n_total + 1):
        t = i * dt
        x = a * math.sin(math.pi * t / tp) if t <= tp else 0.0
        y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        peak = max(peak, abs(y))
        x2, x1 = x1, x
        y2, y1 = y1, y
    return peak


SRS_FREQS = [10.0, 20.0, 31.5, 50.0, 80.0, 100.0, 160.0, 250.0, 400.0, 630.0, 1000.0, 2000.0]
srs_rows = []
worst = 0.0
for fn in SRS_FREQS:
    ex = srs_exact(fn, 0.05, A_PULSE, T_PULSE)
    sw = srs_smallwood(fn, 10.0, A_PULSE, T_PULSE)
    worst = max(worst, abs(sw - ex) / ex)
    srs_rows.append((fn, fn * T_PULSE, ex, sw))
with open('srs_half_sine.csv', 'w', newline='') as fh:
    w = csv.writer(fh, lineterminator='\n')
    w.writerow(['fn_Hz', 'fn_times_T', 'srs_over_A_exact', 'srs_over_A_smallwood'])
    for fn, ft, ex, sw in srs_rows:
        w.writerow(['%g' % fn, '%.12g' % ft, '%.12g' % ex, '%.12g' % sw])
case('VC-DYN-13', 'maximax absolute-acceleration SRS / A of a half-sine (T = 11 ms), Q = 10, at fn = '
     + ', '.join('%g' % f for f in SRS_FREQS) + ' Hz (exact piecewise solution)',
     [row[2] for row in srs_rows], '-', {'rel': 0.005}, 'derived (method A); method B = S7/S8 Smallwood filter', 'A',
     ['FR-DYN-11', 'TR-DYN-50', 'TR-DYN-51', 'FR-DYN-17', 'FR-DYN-19'],
     crossCheckMaxRelDiff=r12(worst),
     note='Tolerance 0.5 % applies to the llull implementation (Smallwood at >= 10 samples per period of the highest fn is the TR); '
          'methods A and B agree to crossCheckMaxRelDiff here.')
lowfreq = srs_exact(1.0, 0.05, A_PULSE, T_PULSE)
dv = 2.0 * A_PULSE * T_PULSE / math.pi
case('VC-DYN-14', 'SRS low-frequency asymptote: SRS(1 Hz)/(wn dV), dV = 2 A T / pi (velocity change of the pulse)',
     lowfreq / (2 * math.pi * 1.0 * dv), '-', {'rel': 0.02}, 'derived (impulse limit, S10)', 'A', ['FR-DYN-11', 'TR-DYN-51'],
     note='Ratio tends to 1 as fn T -> 0 (impulse); at fn T = 0.011 with zeta = 0.05 it is slightly below 1.')

# ---------------------------------------------------------------------------------------------------------------
# 8. Quoted benchmark: NAFEMS FV32 (frequencies feed a modal pre-step; grade A = two vendor manuals)
# ---------------------------------------------------------------------------------------------------------------
case('VC-DYN-15', 'NAFEMS FV32 cantilevered tapered membrane, modes 1-6', [44.623, 130.03, 162.70, 246.05, 379.90, 391.44], 'Hz',
     {'rel': 0.01}, 'S13 (Abaqus Benchmarks FV32) + S14 (Altair OS-V:0440, 2021/2022 releases), both citing NAFEMS TNSB Rev. 3', 'A',
     ['FR-DYN-01', 'FR-DYN-16'],
     note='Altair 2023.1 prints a different closed-form set (44.61, 131.12, ...): do not mix. Geometry vertex coordinates are TBD '
          '(read from the Abaqus input nfv32f4f.inp before the plan is frozen).')
case('VC-DYN-16', 'NAFEMS FV52 mode 7', 'excluded', '-', {'abs': 0}, 'S14 (two Altair releases disagree: 167.89 vs 265.81 Hz)', 'C', ['FR-DYN-16'],
     note='Not a threshold. Listed so nobody adds it back without a primary source.')

# ---------------------------------------------------------------------------------------------------------------
# 9. CalculiX beamdy8 tip displacement (node 100, x) quoted from the pinned .dat.ref (S2): real/imag pairs at the 9 points
# ---------------------------------------------------------------------------------------------------------------
BEAMDY8_U = [(3.502565, -1.209064), (3.782318, -1.463537), (5.095470, -3.606281), (2.761660, -9.606843),
             (2.011439e-02, -1.029953e+01), (-2.244517, -9.697878), (-4.927470, -4.429369), (-3.884912, -1.974117),
             (-3.610781, -1.651546)]
case('VC-DYN-20', 'beamdy8 tip node 100 |u_x| at the 9 output frequencies (12000 ... 14000 cycles/time), 100 N tip force, Rayleigh alpha 5000',
     [math.hypot(a, b) for a, b in BEAMDY8_U], 'mm', {'rel': 1e-4},
     'S2 (beamdy8.dat.ref, pinned sha256 in calculix_dynamics_cases.json)', 'B', ['FR-DYN-02', 'FR-DYN-03', 'TR-DYN-30', 'TR-DYN-60'],
     frequenciesHz=[r12(row[0]) for row in REF_Q1],
     note='Gate 1e-4 applies to re-running the pinned deck with the bundled ccx and parsing it with the llull reader; '
          'the native llull model of the same beam (plan dyn_beamdy8_ssd) is held to 2 % (different mesh).')
case('VC-DYN-22', 'beamdy8 frequency step: fraction of total effective mass captured by 10 modes, X / Y / Z translation',
     [0.9374014, 0.9087642, 0.8287773], '-', {'rel': 1e-4}, 'S2 (beamdy8.dat.ref, FRACTION OF TOTALS)', 'B', ['FR-DYN-10', 'TR-DYN-31'])

# ---------------------------------------------------------------------------------------------------------------
# 10. Euler-Bernoulli cantilever on a random base (GEVS qualification ASD), modal superposition, explicit zeta
#     abs tip acceleration  T(w) = 1 + sum_n phi_n(L) G_n w^2 / (wn^2 - w^2 + 2 i zeta wn w)
#     relative tip disp     z(w)/a_b = - sum_n phi_n(L) G_n / (wn^2 - w^2 + 2 i zeta wn w)
#     root bending stress   s(w)/a_b = - E (h/2) sum_n phi_n''(0) G_n / (...)
#     phi_n normalised with integral_0^L phi^2 dx = L; G_n = integral phi_n dx / integral phi_n^2 dx
# ---------------------------------------------------------------------------------------------------------------
E_B, RHO_B, L_B, B_B, H_B, ZETA_B = 210000.0, 7.8e-9, 100.0, 20.0, 3.0, 0.02   # N-mm-t-s test inputs (05 steel test material)
I_B = B_B * H_B ** 3 / 12.0
A_B = B_B * H_B
C_B = math.sqrt(E_B * I_B / (RHO_B * A_B))
NMODES_B = 6


def mode_shape(beta_l, x_over_l):
    s = (math.cosh(beta_l) + math.cos(beta_l)) / (math.sinh(beta_l) + math.sin(beta_l))
    bx = beta_l * x_over_l
    return math.cosh(bx) - math.cos(bx) - s * (math.sinh(bx) - math.sin(bx))


beam_modes = []
for b in roots[:NMODES_B]:
    norm2 = simpson(lambda u: mode_shape(b, u) ** 2, 0.0, 1.0, 4000)        # integral phi^2 d(x/L)
    scale = 1.0 / math.sqrt(norm2)
    integ = simpson(lambda u: mode_shape(b, u), 0.0, 1.0, 4000) * scale
    gamma = integ                                                            # since integral (scaled phi)^2 d(x/L) = 1
    tip = mode_shape(b, 1.0) * scale
    curv0 = 2.0 * (b / L_B) ** 2 * scale                                     # phi''(0) = 2 beta^2 (unscaled)
    wn = (b / L_B) ** 2 * C_B
    beam_modes.append((wn / (2 * math.pi), wn, gamma, tip, curv0))


def beam_tf(f, kept):
    w = 2 * math.pi * f
    acc = complex(1.0, 0.0)
    disp = complex(0.0, 0.0)
    strs = complex(0.0, 0.0)
    for fnb, wn, gam, tip, curv in beam_modes[:kept]:
        h = 1.0 / complex(wn * wn - w * w, 2 * ZETA_B * wn * w)
        acc += tip * gam * w * w * h
        disp += -tip * gam * h
        strs += -E_B * (H_B / 2.0) * curv * gam * h
    return acc, disp, strs


def beam_rms(kept):
    def integrand(u, which):
        f = 20.0 * 100.0 ** u
        acc, disp, strs = beam_tf(f, kept)
        val = (acc, disp * G0 * 1000.0, strs * G0 * 1000.0)[which]   # base ASD in g^2/Hz -> mm/s^2 per g = 9806.65
        return asd_at(GEVS_QUAL, f) * abs(val) ** 2 * f * math.log(100.0)
    return [math.sqrt(simpson(lambda u: integrand(u, k), 0.0, 1.0, 200000)) for k in range(3)]


rms3 = beam_rms(3)
rms6 = beam_rms(6)
case('VC-DYN-21', 'EB cantilever 100 x 20 x 3 mm (E 210000 MPa, rho 7.8e-9 t/mm^3, zeta 0.02 all modes) on GEVS qual ASD in its thickness '
     'direction: tip absolute acceleration rms (g), tip relative displacement rms (mm), root bending stress rms (MPa); 6 modes',
     rms6, 'g, mm, MPa', {'rel': 0.05}, 'derived (Euler-Bernoulli modal superposition; spectrum S3/S4)', 'A',
     ['FR-DYN-06', 'FR-DYN-08', 'FR-DYN-10', 'TR-DYN-40', 'TR-DYN-41'],
     modesHz=r12([m[0] for m in beam_modes]), rmsWith3Modes=r12(rms3),
     effectiveMassFraction=r12([m[2] ** 2 for m in beam_modes]),
     note='5 % covers shear deformation and rotary inertia that a solid FE model has and Euler-Bernoulli does not (L/h = 33), '
          'and the FE mesh; the spectrum is grade B, so the case is a solver check, not a qualification value.')

# CalculiX test-suite point count rule for *STEADY STATE DYNAMICS (S1): (m + 1)(n - 2) + m + 2
case('VC-DYN-17', 'number of frequency points written by *STEADY STATE DYNAMICS for n = 5 and m = 1 eigenfrequency in range', 5 * 1 - 1 + 5,
     'points', {'abs': 0}, 'S1 (manual formula nm - m + n) + S2 (beamdy8.dat.ref has 9 points)', 'A', ['TR-DYN-30'])

# ---------------------------------------------------------------------------------------------------------------
# 11. Pending solver extractions (TBD) and agent-first behaviour cases (exact, no physics number)
# ---------------------------------------------------------------------------------------------------------------
for cid, deck, what in (('VC-DYN-30', 'beamdy1 / beamdy3', 'modal transient tip u_y history, undamped and Rayleigh alpha 5000'),
                        ('VC-DYN-31', 'beamdy10bm', 'SSD with acceleration base motion: tip u_x real/imag at the output points'),
                        ('VC-DYN-32', 'beamdynamic', 'direct *DYNAMIC after NLGEOM static: tip u_y history')):
    case(cid, what + ' (' + deck + ')', 'TBD', 'mm', {'rel': 1e-4}, 'S2 (pinned deck; extract with the M2/M5 parser and freeze)', 'TBD',
         ['FR-DYN-06', 'FR-DYN-12', 'TR-DYN-60', 'TR-DYN-61'], note='TBD - measure with the bundled ccx and the llull DAT reader.')

AGENT_CASES = [
    ('VC-DYN-40', 'fea_solve on a random_response case with no damping', {'exit': 1, 'code': 'DYN_DAMPING_UNSET'}, ['FR-DYN-03', 'FR-DYN-18']),
    ('VC-DYN-41', 'equivalent_static_load_case without peakFactor', {'peakFactor': {'value': 3, 'source': 'llull named default',
                                                                     'defaulted': True, 'rationale': 'Gaussian 3-sigma (P(|x| > 3 sigma) = 0.27 %)'}},
     ['FR-DYN-09', 'FR-DYN-14', 'TR-DYN-42']),
    ('VC-DYN-42', 'deliberately wrong set-ups', {'codes': ['DYN_BASIS_MISSING', 'DYN_SWEEP_INVALID', 'DYN_SPECTRUM_INVALID', 'DYN_BASE_ACCEL_TRANSIENT',
                                                          'DYN_DAMPING_INVALID', 'DYN_SAMPLING_TOO_COARSE', 'DYN_MILES_NOT_ANSWER']},
     ['FR-DYN-18', 'TR-DYN-80']),
    ('VC-DYN-43', 'random case driven by the GEVS library spectrum (grade B)', {'unverified': True, 'warning': 'DYN_SPECTRUM_UNVERIFIED'},
     ['FR-DYN-07', 'FR-DYN-20']),
    ('VC-DYN-44', 'agent calls dispose_margin on a row created from an equivalent static load case', {'exit': 1, 'code': 'DYN_HUMAN_GATE',
                                                                                                    'documentUnchanged': True},
     ['FR-DYN-21']),
]
AGENT_CASES += [
    ('VC-DYN-45', 'plugin contract: create_analysis accepts the three dynamic types only with the plugin installed; toolSchemas snapshot; '
     'validate/restore round trip; any change of damping, sweep, base or spectrum marks results stale; same data from CLI, MCP, UI',
     {'staleAfterDampingChange': True, 'roundTripDeepEqual': True, 'identicalAcrossSurfaces': True},
     ['FR-DYN-01', 'FR-DYN-22', 'TR-DYN-01', 'TR-DYN-02', 'TR-DYN-03', 'TR-DYN-70']),
    ('VC-DYN-46', 'V1: PHY-10 reaction history assigned to a transient case; stress ASD export CSV for PHY-07 (TBD values)',
     {'historySource': 'fromPhy10', 'csvColumns': ['f_Hz', 'asd', 'unit']}, ['FR-DYN-13', 'FR-DYN-15', 'TR-DYN-61']),
    ('VC-DYN-47', 'structural_material damping: record without structuralLossFactor -> refusal; record with eta = 0.02 -> deck card and '
     'reported equivalent zeta at resonance', {'missing': 'DYN_MATERIAL_NO_DAMPING', 'deckLine': '*DAMPING,STRUCTURAL=0.02', 'zetaEq': 0.01},
     ['FR-DYN-03', 'TR-DYN-11', 'TR-DYN-12']),
]
for cid, what, expect, proves in AGENT_CASES:
    case(cid, what, expect, '-', {'abs': 0}, 'TECHNICAL_SPEC section 7.1', 'A', proves, note='behaviour case (exact match of codes / flags)')

doc = {
    'pack': '09-structural-dynamics',
    'generatedBy': 'generate_dynamics_reference.py (+ quoted: VC-DYN-15, 16)',
    'cases': CASES,
}
with open('expected_results.json', 'w') as fh:
    json.dump(doc, fh, indent=1, ensure_ascii=False)
    fh.write('\n')
