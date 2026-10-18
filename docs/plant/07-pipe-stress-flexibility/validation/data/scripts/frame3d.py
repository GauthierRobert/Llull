"""Independent linear 3D pipe-frame solver (direct stiffness, 6 DOF/node), written for the PST validation pack.
Straight pipe elements only; Euler-Bernoulli by default, Timoshenko (shear area A/2) optional."""
import numpy as np

def section(od, t):
    di = od - 2*t
    A = np.pi/4*(od**2 - di**2)
    I = np.pi/64*(od**4 - di**4)
    J = 2*I
    Z = I/(od/2)
    return A, I, J, Z

def kloc(E, G, A, I, J, L, shear=False):
    py = pz = 0.0
    if shear:
        As = A/2
        py = pz = 12*E*I/(G*As*L**2)
    k = np.zeros((12, 12))
    k[0,0]=k[6,6]=E*A/L; k[0,6]=k[6,0]=-E*A/L
    k[3,3]=k[9,9]=G*J/L; k[3,9]=k[9,3]=-G*J/L
    for (v, r, s, ph) in ((1, 5, 1, py), (2, 4, -1, pz)):
        c = E*I/(1+ph)
        k[v,v]=k[v+6,v+6]=12*c/L**3; k[v,v+6]=k[v+6,v]=-12*c/L**3
        k[v,r]=k[r,v]=s*6*c/L**2; k[v,r+6]=k[r+6,v]=s*6*c/L**2
        k[v+6,r]=k[r,v+6]=-s*6*c/L**2; k[v+6,r+6]=k[r+6,v+6]=-s*6*c/L**2
        k[r,r]=k[r+6,r+6]=(4+ph)*c/L; k[r,r+6]=k[r+6,r]=(2-ph)*c/L
    return k

def rot(p1, p2):
    x = (p2-p1)/np.linalg.norm(p2-p1)
    ref = np.array([0,0,1.0]) if abs(x[2]) < 0.99 else np.array([1.0,0,0])
    y = np.cross(ref, x); y /= np.linalg.norm(y); z = np.cross(x, y)
    R = np.vstack([x, y, z]); T = np.zeros((12,12))
    for i in range(4): T[3*i:3*i+3, 3*i:3*i+3] = R
    return T, R

def solve(nodes, elems, fixed, E, nu, od, t, alpha_dT=0.0, w=None, shear=False, gdir=2, point=None):
    G = E/(2*(1+nu)); A, I, J, Z = section(od, t)
    n = len(nodes); K = np.zeros((6*n, 6*n)); F = np.zeros(6*n)
    for (a, b) in elems:
        p1, p2 = np.array(nodes[a], float), np.array(nodes[b], float); L = np.linalg.norm(p2-p1)
        T, R = rot(p1, p2); kg = T.T @ kloc(E, G, A, I, J, L, shear) @ T
        idx = list(range(6*a, 6*a+6)) + list(range(6*b, 6*b+6)); K[np.ix_(idx, idx)] += kg
        fe = np.zeros(12)
        if alpha_dT:
            fa = E*A*alpha_dT; fe[0] -= fa; fe[6] += fa   # local fixed-end thermal forces (equivalent loads)
        if w is not None:
            q = np.zeros(3); q[gdir] = -w; ql = R @ q   # local distributed load
            for d, m1, m2, s in ((1, 5, 11, 1), (2, 4, 10, -1)):
                fe[d] += ql[d]*L/2; fe[d+6] += ql[d]*L/2
                fe[m1] += s*ql[d]*L**2/12; fe[m2] -= s*ql[d]*L**2/12
            fe[0] += ql[0]*L/2; fe[6] += ql[0]*L/2
        F[idx] += T.T @ fe
    if point:
        for (nd, dof, val) in point: F[6*nd+dof] += val
    free = [i for i in range(6*n) if i//6 not in fixed]
    u = np.zeros(6*n); u[free] = np.linalg.solve(K[np.ix_(free, free)], F[free])
    solve.reactions = K @ u - F
    return u, (A, I, J, Z)
