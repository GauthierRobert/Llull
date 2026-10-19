"""PSI (Pipe Stress Infinity) test_loads.py fixture reproduced with the independent frame3d solver (VC-PST-07/08).
Units: in, lbf, psi. Run: python3 -I psi_benchmarks.py ."""
import sys; sys.path.insert(0, sys.argv[1])
from frame3d import solve
nodes = [(0,0,0),(0,0,120),(0,180,120),(0,180,-480),(0,480,-480)]
elems = [(0,1),(1,2),(2,3),(3,4)]
od, t = 10.75, 0.365
for shear in (False, True):
    u, s = solve(nodes, elems, {0,4}, 27.9e6, 0.3, od, t, alpha_dT=7.84e-6*(900-70), shear=shear)
    print('thermal shear=%s pt30 dy=%.4f dz=%.4f rx=%.4f deg' % (shear, u[12+1], u[12+2], u[12+3]*57.29578))
    A = s[0]; w = 0.283*A
    u, s = solve(nodes, elems, {0,4}, 27.9e6, 0.3, od, t, w=w, shear=shear)
    print('weight  shear=%s pt30 dy=%.4f dz=%.4f rx=%.4f deg w=%.4f lb/in' % (shear, u[12+1], u[12+2], u[12+3]*57.29578, w))
