"""Two-anchor planar L-bend under uniform thermal strain: unit-load (flexibility) integration vs the frame3d stiffness solver.
Run: python3 -I lbend_flexibility.py (from this folder). Inputs are stated in the file; see ../../README.md VC-PST-06."""
import sys, json, numpy as np
sys.path.insert(0, '.')
from frame3d import solve, section
E, nu, od, t, e = 200000.0, 0.3, 168.3, 7.11, 2.25e-3
a, b = 6000.0, 3000.0
A, I, J, Z = section(od, t)
# FE (Euler-Bernoulli, straight legs, sharp corner, k=1)
u, _ = solve([(0,0,0),(a,0,0),(a,b,0)], [(0,1),(1,2)], {0,2}, E, nu, od, t, alpha_dT=e)
# reactions via element end forces: recompute moments at anchors from flexibility method instead
# Flexibility (unit-load) method, planar, redundants at C (X, Y, M), member 1: A->B along x, member 2: B->C along y
def integ(axial):
    # coordinates of points along members, moment at point p from forces at C: M(p) = M + X*(yC - yp)*(-1) ... use M(p) = Mc + Y*(xC-xp)*? derive generally
    n = 20000; F = np.zeros((3,3))
    segs = [((0,0),(a,0)), ((a,0),(a,b))]
    xc, yc = a, b
    for (p0, p1) in segs:
        p0, p1 = np.array(p0), np.array(p1); L = np.linalg.norm(p1-p0); d = (p1-p0)/L
        s = (np.arange(n)+0.5)/n*L; ds = L/n
        P = p0[None,:] + s[:,None]*d[None,:]
        # moment at section due to unit X (force +x at C), unit Y, unit M, acting on the free part beyond section (towards C)
        mX = -(yc - P[:,1]); mY = (xc - P[:,0]); mM = np.ones(n)
        m = np.vstack([mX, mY, mM])
        F += (m @ m.T) * ds / (E*I)
        if axial:
            nX = d[0]*np.ones(n); nY = d[1]*np.ones(n); nn = np.vstack([nX, nY, np.zeros(n)])
            F += (nn @ nn.T) * ds / (E*A)
    return F
res = {}
for axial in (True, False):
    F = integ(axial)
    delta = np.array([e*a, e*b, 0.0])   # free expansion of C relative to A
    R = np.linalg.solve(F, -delta)       # redundant forces at C that close the gap
    X, Y, Mc = R
    MA = Mc + Y*a - X*b                  # moment at A (unit-load sign convention)
    MB = Mc + Y*0 - X*b
    res['axial' if axial else 'bending_only'] = dict(Fx_N=X, Fy_N=Y, Mc_Nmm=Mc, MB_Nmm=MB, MA_Nmm=MA,
        Smax_MPa=max(abs(Mc),abs(MB),abs(MA))/Z)
res['fe_corner_disp_mm'] = dict(ux=u[6], uy=u[7], rz=u[11])
res['section'] = dict(A=A, I=I, Z=Z)
# guided cantilever approximation for each leg
res['guided_cantilever_approx'] = dict(leg_a_absorbs_eb_MPa=3*E*od*(e*b)/a**2, leg_b_absorbs_ea_MPa=3*E*od*(e*a)/b**2)
json.dump(res, sys.stdout, indent=1)
import frame3d
r = frame3d.solve.reactions
print('\nFE reactions at C (node 2): Fx=%.2f Fy=%.2f Mz=%.1f ; at A: Fx=%.2f Fy=%.2f Mz=%.1f' % (r[12], r[13], r[17], r[0], r[1], r[5]))
