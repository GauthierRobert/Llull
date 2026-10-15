#!/usr/bin/env python3
"""PHY-10 rigid-body dynamics: reference values.

Python 3 standard library only. Run from this folder:  python3 -I generate_rbd_reference.py
Byte-identical output on re-run (fixed step counts, no randomness, no time stamps).

Writes:
  expected_results.json      VC-RBD-xx cases (PHY README section 6.3 schema)
  andrews_reference.json     Andrews' squeezer: parameters, initial state, Bari test-set reference at t = 0.03 s and
                             this generator's independent index-1 RK4 reproduction
  pendulum_period.csv        large-amplitude pendulum period ratio T/T0 vs amplitude (AGM, quadrature, simulation)
  slider_crank.csv           slider-crank kinematics and crank torque over one revolution
  coulomb_decay.csv          turning points of a spring-mass with Coulomb friction (exact piecewise solution)
"""

import csv
import json
import math


def r12(x):
    if isinstance(x, (list, tuple)):
        return [r12(v) for v in x]
    if isinstance(x, str) or isinstance(x, dict) or x is None:
        return x
    if x == 0:
        return 0.0
    return float('%.12g' % x)


CASES = []


def case(cid, quantity, value, unit, tol, source, grade, proves, **extra):
    entry = {'id': cid, 'quantity': quantity, 'value': r12(value), 'unit': unit, 'tolerance': tol,
             'source': source, 'grade': grade, 'proves': proves}
    entry.update(extra)
    CASES.append(entry)


G0 = 9.80665  # m/s^2 conventional standard gravity (unit definition, S12)


def solve_linear(a, b):
    """Gaussian elimination with partial pivoting (deterministic)."""
    n = len(b)
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    for k in range(n):
        p = max(range(k, n), key=lambda i: abs(m[i][k]))
        m[k], m[p] = m[p], m[k]
        piv = m[k][k]
        for i in range(k + 1, n):
            f = m[i][k] / piv
            if f != 0.0:
                mi, mk = m[i], m[k]
                for j in range(k, n + 1):
                    mi[j] -= f * mk[j]
    x = [0.0] * n
    for i in range(n - 1, -1, -1):
        s = m[i][n]
        for j in range(i + 1, n):
            s -= m[i][j] * x[j]
        x[i] = s / m[i][i]
    return x


# =================================================================================================================
# 1. Andrews' squeezing mechanism (S1 Bari IVP test set, as distributed in S2 deTestSet Ex_andrews.f; S3 Hairer-Wanner)
#    M(q) q'' = f(q, q') - G(q)^T lambda,  g(q) = 0 (6 constraints, 7 angles).
#    Reproduced here in index-1 form: [M G^T; G 0][q''; lambda] = [f; -h(q, q')],  h = d/dt(G) q' (quadratic terms),
#    classical RK4 on (q, q'), fixed step. The reference values are the test set's (PSIDE, tol 1e-14, Cray C90).
# =================================================================================================================
AP = dict(m1=.04325, m2=.00365, m3=.02373, m4=.00706, m5=.07050, m6=.00706, m7=.05498,
          xa=-.06934, ya=-.00227, xb=-.03635, yb=.03273, xc=.014, yc=.072, c0=4530.,
          i1=2.194e-6, i2=4.410e-7, i3=5.255e-6, i4=5.667e-7, i5=1.169e-5, i6=5.667e-7, i7=1.912e-5,
          d=28e-3, da=115e-4, e=2e-2, ea=1421e-5, rr=7e-3, ra=92e-5, l0=7785e-5,
          ss=35e-3, sa=1874e-5, sb=1043e-5, sc=18e-3, sd=2e-2, ta=2308e-5, tb=916e-5,
          u=4e-2, ua=1228e-5, ub=449e-5, zf=2e-2, zt=4e-2, fa=1421e-5, mom=33e-3)
Q0 = [-0.0617138900142764496358948458001, 0.0, 0.455279819163070380255912382449, 0.222668390165885884674473185609,
      0.487364979543842550225598953530, -0.222668390165885884674473185609, 1.23054744454982119249735015568]
REF_Q = [0.1581077119629904e+2, -0.1575637105984298e+2, 0.4082224013073101e-1, -0.5347301163226948e+0,
         0.5244099658805304e+0, 0.5347301163226948e+0, 0.1048080741042263e+1]
REF_V = [0.1139920302151208e+4, -0.1424379294994111e+4, 0.1103291221937134e+2, 0.1929337464421385e+2,
         0.5735699284790808e+0, -0.1929337464421385e+2, 0.3231791658026955e+0]
REF_INIT_ACC = [14222.4439199541138705911625887, -10666.8329399655854029433719415]
REF_INIT_LAMBDA = [98.5668703962410896057654982170, -6.12268834425566265503114393122]
ANGLE_NAMES = ['beta', 'Theta', 'gamma', 'Phi', 'delta', 'Omega', 'epsilon']


def andrews_acc(q, v):
    p = AP
    be, th, ga, ph, de, om, ep = q
    bp, tp, gp, pp, dp, op, epp = v
    m2, m4, m6 = p['m2'], p['m4'], p['m6']
    da, rr, d, ss, e, ea, zt, zf, fa, u = p['da'], p['rr'], p['d'], p['ss'], p['e'], p['ea'], p['zt'], p['zf'], p['fa'], p['u']
    sith, coth = math.sin(th), math.cos(th)
    siga, coga = math.sin(ga), math.cos(ga)
    siph, coph = math.sin(ph), math.cos(ph)
    side, code = math.sin(de), math.cos(de)
    siom, coom = math.sin(om), math.cos(om)
    siep, coep = math.sin(ep), math.cos(ep)
    sibe, cobe = math.sin(be), math.cos(be)
    sibeth, cobeth = math.sin(be + th), math.cos(be + th)
    siphde, cophde = math.sin(ph + de), math.cos(ph + de)
    siomep, coomep = math.sin(om + ep), math.cos(om + ep)
    mm = [[0.0] * 7 for _ in range(7)]
    mm[0][0] = p['m1'] * p['ra'] ** 2 + m2 * (rr ** 2 - 2 * da * rr * coth + da ** 2) + p['i1'] + p['i2']
    mm[1][0] = mm[0][1] = m2 * (da ** 2 - da * rr * coth) + p['i2']
    mm[1][1] = m2 * da ** 2 + p['i2']
    mm[2][2] = p['m3'] * (p['sa'] ** 2 + p['sb'] ** 2) + p['i3']
    mm[3][3] = m4 * (e - ea) ** 2 + p['i4']
    mm[4][3] = mm[3][4] = m4 * ((e - ea) ** 2 + zt * (e - ea) * siph) + p['i4']
    mm[4][4] = m4 * (zt ** 2 + 2 * zt * (e - ea) * siph + (e - ea) ** 2) + p['m5'] * (p['ta'] ** 2 + p['tb'] ** 2) + p['i4'] + p['i5']
    mm[5][5] = m6 * (zf - fa) ** 2 + p['i6']
    mm[6][5] = mm[5][6] = m6 * ((zf - fa) ** 2 - u * (zf - fa) * siom) + p['i6']
    mm[6][6] = m6 * ((zf - fa) ** 2 - 2 * u * (zf - fa) * siom + u ** 2) + p['m7'] * (p['ua'] ** 2 + p['ub'] ** 2) + p['i6'] + p['i7']
    xd = p['sd'] * coga + p['sc'] * siga + p['xb']
    yd = p['sd'] * siga - p['sc'] * coga + p['yb']
    lang = math.sqrt((xd - p['xc']) ** 2 + (yd - p['yc']) ** 2)
    force = -p['c0'] * (lang - p['l0']) / lang
    fx, fy = force * (xd - p['xc']), force * (yd - p['yc'])
    ff = [p['mom'] - m2 * da * rr * tp * (tp + 2 * bp) * sith,
          m2 * da * rr * bp ** 2 * sith,
          fx * (p['sc'] * coga - p['sd'] * siga) + fy * (p['sd'] * coga + p['sc'] * siga),
          m4 * zt * (e - ea) * dp ** 2 * coph,
          -m4 * zt * (e - ea) * pp * (pp + 2 * dp) * coph,
          -m6 * u * (zf - fa) * epp ** 2 * coom,
          m6 * u * (zf - fa) * op * (op + 2 * epp) * coom]
    gq = [[0.0] * 7 for _ in range(6)]
    gq[0][0] = -rr * sibe + d * sibeth; gq[0][1] = d * sibeth; gq[0][2] = -ss * coga
    gq[1][0] = rr * cobe - d * cobeth; gq[1][1] = -d * cobeth; gq[1][2] = -ss * siga
    gq[2][0] = -rr * sibe + d * sibeth; gq[2][1] = d * sibeth; gq[2][3] = -e * cophde; gq[2][4] = -e * cophde + zt * side
    gq[3][0] = rr * cobe - d * cobeth; gq[3][1] = -d * cobeth; gq[3][3] = -e * siphde; gq[3][4] = -e * siphde - zt * code
    gq[4][0] = -rr * sibe + d * sibeth; gq[4][1] = d * sibeth; gq[4][5] = zf * siomep; gq[4][6] = zf * siomep - u * coep
    gq[5][0] = rr * cobe - d * cobeth; gq[5][1] = -d * cobeth; gq[5][5] = -zf * coomep; gq[5][6] = -zf * coomep - u * siep
    wb, wpd, woe = bp + tp, pp + dp, op + epp
    # each constraint is a sum of terms c*cos(phi) / c*sin(phi), phi linear in q: d2/dt2 adds -term * phidot^2
    h = [-(rr * cobe * bp ** 2 - d * cobeth * wb ** 2 - ss * siga * gp ** 2),
         -(rr * sibe * bp ** 2 - d * sibeth * wb ** 2 + ss * coga * gp ** 2),
         -(rr * cobe * bp ** 2 - d * cobeth * wb ** 2 - e * siphde * wpd ** 2 - zt * code * dp ** 2),
         -(rr * sibe * bp ** 2 - d * sibeth * wb ** 2 + e * cophde * wpd ** 2 - zt * side * dp ** 2),
         -(rr * cobe * bp ** 2 - d * cobeth * wb ** 2 - zf * coomep * woe ** 2 - u * siep * epp ** 2),
         -(rr * sibe * bp ** 2 - d * sibeth * wb ** 2 - zf * siomep * woe ** 2 + u * coep * epp ** 2)]
    a = [mm[i] + [gq[j][i] for j in range(6)] for i in range(7)] + [gq[j] + [0.0] * 6 for j in range(6)]
    x = solve_linear(a, ff + [-hh for hh in h])
    return x[:7], x[7:]


def andrews_constraints(q):
    p = AP
    be, th, ga, ph, de, om, ep = q
    rr, d, ss, e, zt, zf, u = p['rr'], p['d'], p['ss'], p['e'], p['zt'], p['zf'], p['u']
    return [rr * math.cos(be) - d * math.cos(be + th) - ss * math.sin(ga) - p['xb'],
            rr * math.sin(be) - d * math.sin(be + th) + ss * math.cos(ga) - p['yb'],
            rr * math.cos(be) - d * math.cos(be + th) - e * math.sin(ph + de) - zt * math.cos(de) - p['xa'],
            rr * math.sin(be) - d * math.sin(be + th) + e * math.cos(ph + de) - zt * math.sin(de) - p['ya'],
            rr * math.cos(be) - d * math.cos(be + th) - zf * math.cos(om + ep) - u * math.sin(ep) - p['xa'],
            rr * math.sin(be) - d * math.sin(be + th) - zf * math.sin(om + ep) + u * math.cos(ep) - p['ya']]


def rk4_andrews(n_steps, t_end=0.03):
    q, v = Q0[:], [0.0] * 7
    hstep = t_end / n_steps
    for _ in range(n_steps):
        k1v, _ = andrews_acc(q, v)
        k1q = v
        q2 = [q[i] + 0.5 * hstep * k1q[i] for i in range(7)]; v2 = [v[i] + 0.5 * hstep * k1v[i] for i in range(7)]
        k2v, _ = andrews_acc(q2, v2)
        q3 = [q[i] + 0.5 * hstep * v2[i] for i in range(7)]; v3 = [v[i] + 0.5 * hstep * k2v[i] for i in range(7)]
        k3v, _ = andrews_acc(q3, v3)
        q4 = [q[i] + hstep * v3[i] for i in range(7)]; v4 = [v[i] + hstep * k3v[i] for i in range(7)]
        k4v, _ = andrews_acc(q4, v4)
        q = [q[i] + hstep / 6 * (k1q[i] + 2 * v2[i] + 2 * v3[i] + v4[i]) for i in range(7)]
        v = [v[i] + hstep / 6 * (k1v[i] + 2 * k2v[i] + 2 * k3v[i] + k4v[i]) for i in range(7)]
    return q, v


acc0, lam0 = andrews_acc(Q0, [0.0] * 7)
residual0 = max(abs(c) for c in andrews_constraints(Q0))
q_rk, v_rk = rk4_andrews(12000)
rel_q = [abs(a - b) / abs(b) for a, b in zip(q_rk, REF_Q)]
rel_v = [abs(a - b) / abs(b) for a, b in zip(v_rk, REF_V)]
drift = max(abs(c) for c in andrews_constraints(q_rk))

case('VC-RBD-01', "Andrews' squeezer: the 7 angles beta, Theta, gamma, Phi, delta, Omega, epsilon at t = 0.03 s", REF_Q, 'rad',
     {'abs': 1e-6}, 'S1/S2 (Bari IVP test set reference, PSIDE tol 1e-14) + independent reproduction in this generator (max rel. diff '
     + '%.1e' % max(rel_q) + ')', 'A', ['FR-RBD-01', 'FR-RBD-03', 'FR-RBD-05', 'TR-RBD-20', 'TR-RBD-21'],
     reproduction=r12(q_rk), reproductionMethod='index-1 (acceleration-level) form, classical RK4, 12000 fixed steps',
     note='Tolerance 1e-6 rad is a llull acceptance choice for an index-3 / stabilised integrator at default settings; '
          'the angles beta and Theta reach ~15.8 rad, so this is ~6e-8 relative.')
case('VC-RBD-02', "Andrews' squeezer: angular velocities at t = 0.03 s (same order)", REF_V, 'rad/s', {'rel': 1e-4},
     'S1/S2 reference + reproduction (max rel. diff ' + '%.1e' % max(rel_v) + ')', 'A', ['FR-RBD-03', 'TR-RBD-21'],
     reproduction=r12(v_rk))
case('VC-RBD-03', "Andrews' squeezer at t = 0: consistent accelerations beta'', Theta'' and multipliers lambda1, lambda2 (test-set initial values)",
     REF_INIT_ACC + REF_INIT_LAMBDA, 'rad/s^2, N', {'rel': 1e-9}, 'S1/S2 initial values + this generator (index-1 solve)', 'A',
     ['FR-RBD-07', 'TR-RBD-22', 'TR-RBD-30'],
     reproduction=r12([acc0[0], acc0[1], lam0[0], lam0[1]]), initialConstraintResidualM=r12(residual0),
     note='lambda here are the test set\'s multipliers of g(q) = 0 (sign convention M q\'\' = f - G^T lambda); joint reactions are '
          'derived from them (TR-RBD-30). The constraint units are m, so lambda is a force in N.')
case('VC-RBD-04', "Andrews' squeezer: max |g(q)| (position-constraint residual) at t = 0.03 s of the index-1 reproduction",
     drift, 'm', {'abs': 1e-9}, 'this generator', 'A', ['FR-RBD-06', 'TR-RBD-23'],
     note='The fine-step reproduction stays at ~1e-13 m, but an acceleration-level formulation drifts with coarser steps; llull '
          'must enforce position-level constraints (index-3 generalised-alpha or stabilisation) and report its own max |g(q)| in '
          'data.constraintResidualM, gated at <= 1e-9 m (TR-RBD-23).')

with open('andrews_reference.json', 'w') as fh:
    json.dump({'problem': "Andrews' squeezing mechanism (index-3 DAE, 7 bodies, 7 angles, 6 constraints)",
               'source': 'S1 Bari IVP Test Set (andrews.f rev 1.2, 2006) as distributed in S2 deTestSet 1.1.7.4 src/Ex_andrews.f',
               'units': 'SI (m, kg, s, N, N*m, rad)', 'parameters': {k: AP[k] for k in sorted(AP)},
               'q0': Q0, 'v0': [0.0] * 7, 'tEnd': 0.03, 'angleNames': ANGLE_NAMES,
               'reference': {'q': REF_Q, 'v': REF_V, 'initialAcc12': REF_INIT_ACC, 'initialLambda12': REF_INIT_LAMBDA},
               'reproduction': {'method': 'index-1 RK4, 12000 steps', 'q': r12(q_rk), 'v': r12(v_rk),
                                'maxRelDiffQ': r12(max(rel_q)), 'maxRelDiffV': r12(max(rel_v)), 'constraintDriftM': r12(drift)}},
              fh, indent=1)
    fh.write('\n')

# =================================================================================================================
# 2. Simple pendulum, large amplitude (S4 DLMF 22.19(i): period 4K(k), k = sin(theta0/2), in units sqrt(L/g))
#    K by AGM (S5 DLMF 19.8: K(k) = pi / (2 M(1, k'))), by Simpson quadrature, and by direct RK4 simulation.
# =================================================================================================================

def agm(a, b):
    for _ in range(60):
        a, b = 0.5 * (a + b), math.sqrt(a * b)
    return a


def k_agm(k):
    return math.pi / (2.0 * agm(1.0, math.sqrt(1.0 - k * k)))


def k_quad(k, n=20000):
    hq = (math.pi / 2) / n
    s = 0.0
    for i in range(n + 1):
        phi = i * hq
        w = 1 if i in (0, n) else (4 if i % 2 else 2)
        s += w / math.sqrt(1.0 - (k * math.sin(phi)) ** 2)
    return s * hq / 3.0


def pendulum_quarter_period_sim(theta0, length, g, steps_per_unit=20000):
    """Time from release at theta0 (rest) to theta = 0, RK4 with linear interpolation of the crossing."""
    w0 = math.sqrt(g / length)
    dt = 1.0 / (w0 * steps_per_unit)
    th, om, t = theta0, 0.0, 0.0
    f = lambda a: -w0 * w0 * math.sin(a)
    while True:
        k1t, k1o = om, f(th)
        k2t, k2o = om + 0.5 * dt * k1o, f(th + 0.5 * dt * k1t)
        k3t, k3o = om + 0.5 * dt * k2o, f(th + 0.5 * dt * k2t)
        k4t, k4o = om + dt * k3o, f(th + dt * k3t)
        th_n = th + dt / 6 * (k1t + 2 * k2t + 2 * k3t + k4t)
        om_n = om + dt / 6 * (k1o + 2 * k2o + 2 * k3o + k4o)
        if th_n <= 0.0:
            return t + dt * th / (th - th_n)
        th, om, t = th_n, om_n, t + dt


L_P = 1.0
T0 = 2 * math.pi * math.sqrt(L_P / G0)
amps = [10.0, 45.0, 90.0, 135.0, 170.0]
periods, quads, sims = [], [], []
for a_deg in amps:
    k = math.sin(math.radians(a_deg) / 2)
    periods.append(4 * math.sqrt(L_P / G0) * k_agm(k))
    quads.append(4 * math.sqrt(L_P / G0) * k_quad(k))
    sims.append(4 * pendulum_quarter_period_sim(math.radians(a_deg), L_P, G0))
case('VC-RBD-10', 'simple pendulum L = 1 m, g = 9.80665 m/s^2: period at amplitudes 10, 45, 90, 135, 170 deg (4 sqrt(L/g) K(sin(theta0/2)))',
     periods, 's', {'rel': 1e-5}, 'S4/S5 (DLMF 22.19, 19.8) + derived; AGM, quadrature and simulation agree (see crossChecks)', 'A',
     ['FR-RBD-01', 'FR-RBD-03', 'TR-RBD-20'],
     smallAnglePeriodS=r12(T0), crossChecks={'quadrature': r12(quads), 'rk4Simulation': r12(sims)},
     note='1e-5 relative on the period over >= 10 periods is the integrator acceptance (TR-RBD-21).')
with open('pendulum_period.csv', 'w', newline='') as fh:
    w = csv.writer(fh, lineterminator='\n')
    w.writerow(['theta0_deg', 'k', 'K_agm', 'T_over_T0_agm', 'T_over_T0_quadrature'])
    for a_deg in range(5, 180, 5):
        k = math.sin(math.radians(a_deg) / 2)
        w.writerow([a_deg, '%.12g' % k, '%.12g' % k_agm(k), '%.12g' % (2 / math.pi * k_agm(k)), '%.12g' % (2 / math.pi * k_quad(k))])

# pivot reaction (rod tension) of a point-mass pendulum: N(theta) = m g (3 cos theta - 2 cos theta0); max at bottom
m_p = 1.0
tension_bottom = [m_p * G0 * (3 - 2 * math.cos(math.radians(a))) for a in (10.0, 90.0, 170.0)]
case('VC-RBD-11', 'point-mass pendulum m = 1 kg released from rest at 10, 90, 170 deg: pivot reaction (rod tension) at the bottom, m g (3 - 2 cos theta0)',
     tension_bottom, 'N', {'rel': 1e-6}, 'derived (energy + radial Newton law, S13)', 'A', ['FR-RBD-07', 'FR-RBD-12', 'TR-RBD-30'],
     note='This is the joint reaction that dynamics_study must report and export to a 05 load case.')

# compound pendulum: uniform box bar L x w x w pivoted on an axis through one end face centre, perpendicular to L.
# I_pivot = m (L^2 + w^2)/12 + m (L/2)^2; small-angle period 2 pi sqrt(I_pivot / (m g L/2)); slender limit 2 pi sqrt(2L/(3g)).
L_bar, W_bar = 0.5, 0.01
i_over_m = (L_bar ** 2 + W_bar ** 2) / 12 + (L_bar / 2) ** 2
l_eq = i_over_m / (L_bar / 2)
t_bar = 2 * math.pi * math.sqrt(l_eq / G0)
t_bar_90 = 4 * math.sqrt(l_eq / G0) * k_agm(math.sin(math.radians(90.0) / 2))
t_slender = 2 * math.pi * math.sqrt(2 * L_bar / (3 * G0))
case('VC-RBD-12', 'compound pendulum: box bar 0.5 x 0.01 x 0.01 m pivoted at the centre of one end face: small-angle period and period at 90 deg',
     [t_bar, t_bar_90], 's', {'rel': 1e-6}, 'derived (parallel-axis theorem, equivalent length I/(m d); S4)', 'A', ['FR-RBD-02', 'TR-RBD-10'],
     slenderLimitS=r12(t_slender),
     note='Exercises the inertia tensor from mass_properties (01 KRN TR-KRN-40): using the slender-rod formula instead of the box '
          'inertia changes the period by 5e-5 relative, which this tolerance detects.')

# =================================================================================================================
# 3. Slider-crank, constant crank speed (S13 kinematics): x = r cos th + sqrt(l^2 - r^2 sin^2 th)
#    crank torque for a piston mass m with massless rod and no gravity / friction: tau = m x'' dx/dth (virtual power)
# =================================================================================================================
R_C, L_C, W_C, M_PISTON = 0.05, 0.2, 100.0, 0.5


def slider(th):
    s, c = math.sin(th), math.cos(th)
    root = math.sqrt(L_C ** 2 - R_C ** 2 * s ** 2)
    x = R_C * c + root
    dx = -R_C * s - R_C ** 2 * s * c / root                       # dx/dth
    d2x = -R_C * c - R_C ** 2 * (c * c - s * s) / root - R_C ** 4 * s * s * c * c / root ** 3
    v = dx * W_C
    a = d2x * W_C ** 2
    tau = M_PISTON * a * dx                                       # N*m, required driving torque
    return x, v, a, tau


def slider_fd(th, hstep=1e-5):
    xm = slider(th - hstep)[0]; x0 = slider(th)[0]; xp = slider(th + hstep)[0]
    return (xp - xm) / (2 * hstep) * W_C, (xp - 2 * x0 + xm) / hstep ** 2 * W_C ** 2


rows_sc = []
fd_err = 0.0
for deg in range(0, 361, 15):
    th = math.radians(deg)
    x, v, a, tau = slider(th)
    vf, af = slider_fd(th)
    fd_err = max(fd_err, abs(vf - v) / (R_C * W_C), abs(af - a) / (R_C * W_C ** 2))
    rows_sc.append((deg, x, v, a, tau))
with open('slider_crank.csv', 'w', newline='') as fh:
    w = csv.writer(fh, lineterminator='\n')
    w.writerow(['theta_deg', 'x_m', 'v_m_per_s', 'a_m_per_s2', 'crank_torque_Nm'])
    for row in rows_sc:
        w.writerow([row[0]] + ['%.12g' % val for val in row[1:]])
x0_, v0_, a0_, _ = slider(0.0)
x90, v90, a90, tau90 = slider(math.pi / 2)
tau60 = slider(math.radians(60.0))[3]
case('VC-RBD-20', 'slider-crank r = 0.05 m, l = 0.2 m, omega = 100 rad/s: piston x, a at theta = 0; x, v, a at 90 deg',
     [x0_, a0_, x90, v90, a90], 'm, m/s^2, m, m/s, m/s^2', {'rel': 1e-9}, 'derived (closed form; finite-difference check ' + '%.1e' % fd_err + ')',
     'A', ['FR-RBD-01', 'FR-RBD-04', 'TR-RBD-20'],
     note='a(0) = -r omega^2 (1 + r/l) = -625 m/s^2 exactly. Kinematic values are checked against motion_study as well (existing command).')
case('VC-RBD-21', 'slider-crank with a 0.5 kg piston, massless rod, no gravity: required crank torque at theta = 60 deg and 90 deg',
     [tau60, tau90], 'N*m', {'rel': 1e-6}, 'derived (virtual power tau omega = m a v)', 'A', ['FR-RBD-08', 'FR-RBD-09', 'TR-RBD-31'],
     note='Inverse-dynamics output of dynamics_study with a prescribed crank speed (actuator sizing).')

# =================================================================================================================
# 4. Spring-mass-damper free vibration (S13): m x'' + c x' + k x = 0, x(0) = x0, x'(0) = 0
# =================================================================================================================
M_S, K_S, C_S, X0_S = 1.0, 1000.0, 2.0, 0.01
wn_s = math.sqrt(K_S / M_S)
zeta_s = C_S / (2 * math.sqrt(K_S * M_S))
wd_s = wn_s * math.sqrt(1 - zeta_s ** 2)


def smd_x(t):
    return X0_S * math.exp(-zeta_s * wn_s * t) * (math.cos(wd_s * t) + zeta_s * wn_s / wd_s * math.sin(wd_s * t))


log_dec = 2 * math.pi * zeta_s / math.sqrt(1 - zeta_s ** 2)
case('VC-RBD-30', 'spring-mass-damper m 1 kg, k 1000 N/m, c 2 N s/m, x0 10 mm: x(0.5 s), x(1.0 s), logarithmic decrement',
     [smd_x(0.5) * 1000, smd_x(1.0) * 1000, log_dec], 'mm, mm, -', {'rel': 1e-6}, 'derived (S13 closed form)', 'A',
     ['FR-RBD-08', 'TR-RBD-11', 'TR-RBD-21'], inputs={'zeta': r12(zeta_s), 'wnRadPerS': r12(wn_s)})

# energy conservation: undamped spring-mass over 100 periods, energy drift bound of the integrator
case('VC-RBD-31', 'undamped spring-mass (m 1 kg, k 1000 N/m) over 100 periods with the default integrator: relative total-energy change',
     0.0, '-', {'abs': 1e-3}, 'derived (exact energy conservation)', 'A', ['FR-RBD-06', 'TR-RBD-21'],
     note='Generalised-alpha with rho_inf = 1 conserves energy for linear systems up to round-off; with the default rho_inf < 1 it dissipates '
          'high frequencies only. The 1e-3 bound is the acceptance; the integrator\'s actual value is reported in data.energyDrift.')

# =================================================================================================================
# 5. Coulomb friction (S13): m x'' + k x = -F sign(x'), F = mu m g, released from x0 at rest.
#    Exact piecewise solution: each half cycle (duration pi sqrt(m/k)) the turning point moves by 2F/k toward 0;
#    motion stops at the first turning point with |x| <= mu_s m g / k (mu_s = mu here).
# =================================================================================================================
M_F, K_F, MU_F, X0_F = 1.0, 100.0, 0.1, 0.1
F_F = MU_F * M_F * G0
xs = [X0_F]
while True:
    x_last = xs[-1]
    if abs(x_last) <= F_F / K_F:
        break
    nxt = -(abs(x_last) - 2 * F_F / K_F) * math.copysign(1.0, x_last)
    xs.append(nxt)
half_cycles = len(xs) - 1
t_stop = half_cycles * math.pi * math.sqrt(M_F / K_F)
with open('coulomb_decay.csv', 'w', newline='') as fh:
    w = csv.writer(fh, lineterminator='\n')
    w.writerow(['half_cycle', 't_s', 'turning_point_m'])
    for i, x in enumerate(xs):
        w.writerow([i, '%.12g' % (i * math.pi * math.sqrt(M_F / K_F)), '%.12g' % x])
case('VC-RBD-40', 'spring-mass with Coulomb friction (m 1 kg, k 100 N/m, mu 0.1, x0 0.1 m): number of half cycles, stop time, rest position',
     [half_cycles, t_stop, xs[-1]], '-, s, m', {'rel': 1e-6}, 'derived (exact piecewise solution, S13)', 'A',
     ['FR-RBD-10', 'TR-RBD-40', 'TR-RBD-41'], turningPointsM=r12(xs),
     note='Stick detection must happen at the 5th turning point (|x| = 1.93 mm < F/k = 9.81 mm); a smoothed friction law that '
          'creeps afterwards fails this case (TR-RBD-41).')

# block on an incline: sticks while tan(theta) <= mu_s
case('VC-RBD-41', 'block on an incline with mu_s = 0.3: largest angle that still sticks (atan mu_s)', math.degrees(math.atan(0.3)), 'deg',
     {'abs': 0.01}, 'derived (statics, S13)', 'A', ['FR-RBD-10', 'TR-RBD-40'],
     note='dynamics_study at 16.6 deg must report state "stick" for all t; at 16.8 deg "slip" from t = 0.')

# =================================================================================================================
# 6. Agent-first behaviour cases (exact)
# =================================================================================================================
for cid, what, expect, proves in (
        ('VC-RBD-50', 'dynamics_study on an instance with no mass (no material density, no explicit mass)',
         {'exit': 1, 'code': 'RBD_MASS_MISSING'}, ['FR-RBD-02', 'FR-RBD-16']),
        ('VC-RBD-51', 'same plan twice on the same kernel', {'identicalDataHash': True}, ['FR-RBD-17', 'TR-RBD-24']),
        ('VC-RBD-52', 'deliberately wrong set-ups', {'codes': ['RBD_JOINT_UNKNOWN', 'RBD_STEP_INVALID', 'RBD_SPRING_INVALID',
                                                              'RBD_FRICTION_INVALID', 'RBD_CONSTRAINTS_INCONSISTENT', 'RBD_INITIAL_INCONSISTENT',
                                                              'RBD_GRAVITY_UNSET']}, ['FR-RBD-16']),
        ('VC-RBD-53', 'export_joint_loads into a 05 static case', {'loadCategory': 'limit', 'reviewRequired': True,
                                                                  'provenance.studyHash': 'present'}, ['FR-RBD-12', 'TR-RBD-60']),
        ('VC-RBD-54', 'masses from a material with unverified density', {'unverified': True, 'warning': 'RBD_MASS_UNVERIFIED'},
         ['FR-RBD-18'])):
    case(cid, what, expect, '-', {'abs': 0}, 'TECHNICAL_SPEC section 7.1', 'A', proves, note='behaviour case')

with open('expected_results.json', 'w') as fh:
    json.dump({'pack': '10-rigid-body-dynamics', 'generatedBy': 'generate_rbd_reference.py (+ quoted: Andrews reference values S1/S2)',
               'cases': CASES}, fh, indent=1, ensure_ascii=False)
    fh.write('\n')
