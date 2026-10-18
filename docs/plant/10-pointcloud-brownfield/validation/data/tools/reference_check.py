"""Reference implementation run for pack 10 SCN: proves each synthetic expectation is reachable within its tolerance by a standard
published algorithm. Not llull code. Usage: venv/bin/python -I reference_check.py DATADIR  (DATADIR holds synthetic_truth.json,
synthetic/, e57/). Algorithms: PCA normals; RANSAC cylinder from 2 oriented points (Schnabel, Wahl, Klein 2007); Levenberg-Marquardt
orthogonal refinement; point-to-point ICP (Besl & McKay 1992) with Horn 1987 closed-form steps; algebraic sphere fit; Horn
registration of target centres."""
import sys, json, os
import numpy as np
from scipy.spatial import cKDTree
from scipy.optimize import least_squares

D = sys.argv[1]; T = json.load(open(os.path.join(D, 'synthetic_truth.json')))['cases']
load = lambda f: np.loadtxt(os.path.join(D, f), delimiter=',', skiprows=1)
unit = lambda v: v / np.linalg.norm(v)
report = {}

def normals(p, k=20):
    _, idx = cKDTree(p).query(p, k); n = np.empty_like(p)
    for i, nb in enumerate(idx):
        q = p[nb] - p[nb].mean(0); n[i] = np.linalg.svd(q, full_matrices=False)[2][2]
    return n

def cyl_from_two(p1, n1, p2, n2):
    a = np.cross(n1, n2)
    if np.linalg.norm(a) < 1e-3: return None
    a = unit(a)
    # project onto plane normal to a; intersect the two normal lines (2D least squares)
    def proj(x): return x - a * (x @ a)
    q1, q2, m1, m2 = proj(p1), proj(p2), unit(proj(n1)), unit(proj(n2))
    A = np.column_stack([m1, -m2]); s = np.linalg.lstsq(A, q2 - q1, rcond=None)[0]
    c = q1 + s[0] * m1; r = np.linalg.norm(q1 - c)
    return c, a, r

def cyl_dist(p, c, a, r): return np.linalg.norm(np.cross(p - c, a), axis=1) - r

def ransac_cylinder(p, n, eps, rng, iters=3000, rmin=0.01, rmax=1.0):
    best = (0, None)
    for _ in range(iters):
        i, j = rng.choice(len(p), 2, replace=False); m = cyl_from_two(p[i], n[i], p[j], n[j])
        if m is None or not (rmin < m[2] < rmax): continue
        d = cyl_dist(p, *m); radial = np.cross(np.cross(m[1], p - m[0]), m[1])
        cosang = np.abs(np.einsum('ij,ij->i', n, radial)) / (np.linalg.norm(radial, axis=1) + 1e-12)
        inl = (np.abs(d) < eps) & (cosang > np.cos(np.radians(20)))
        if inl.sum() > best[0]: best = (inl.sum(), m)
    return best[1]

def refine(p, c, a, r):
    a = unit(a); h = np.array([1.0, 0, 0]) if abs(a[0]) < 0.9 else np.array([0, 1.0, 0]); u = unit(np.cross(a, h)); w = np.cross(a, u)
    f = lambda q: cyl_dist(p, c + q[0] * u + q[1] * w, unit(a + q[2] * u + q[3] * w), r + q[4])
    q = least_squares(f, np.zeros(5), method='lm').x
    return c + q[0] * u + q[1] * w, unit(a + q[2] * u + q[3] * w), r + q[4]

def axis_errors(c, a, r, case):
    at = np.array(case['axisDirection']); pt = np.array(case['axisPoint_m'])
    ang = np.degrees(np.arccos(min(1.0, abs(a @ at))))
    v = c - pt; pos = np.linalg.norm(v - at * (v @ at))
    return {'radiusError_m': float(r - case['radius_m']), 'axisAngleError_deg': float(ang), 'axisPositionError_m': float(pos)}

for cid in ['CYL-A', 'CYL-B', 'CYL-C']:
    case = T[cid]; p = load(case['file']); rng = np.random.default_rng(7)
    n = normals(p); m = ransac_cylinder(p, n, 3 * case['noiseSigma_m'], rng)
    inl = np.abs(cyl_dist(p, *m)) < 3 * case['noiseSigma_m']
    c, a, r = refine(p[inl], *m)
    inl = np.abs(cyl_dist(p, c, a, r)) < 3 * case['noiseSigma_m']; c, a, r = refine(p[inl], c, a, r)
    e = axis_errors(c, a, r, case); tol = case['tolerance']
    e['inliers'] = int(inl.sum()); e['pass'] = bool(abs(e['radiusError_m']) <= tol['radius_m'] and e['axisAngleError_deg'] <= tol['axisAngle_deg'] and e['axisPositionError_m'] <= tol['axisPosition_m'])
    report[cid] = e

# --- ICP on the bunny -------------------------------------------------------------------------------------------------------------
import pye57
case = T['ICP-A']; e = pye57.E57(os.path.join(D, case['sourceFile'])); s = e.read_scan_raw(0)
src = np.column_stack([s['cartesianX'], s['cartesianY'], s['cartesianZ']]).astype(float)
if 'cartesianInvalidState' in s: src = src[np.asarray(s['cartesianInvalidState']) == 0]
rng = np.random.default_rng(case['seed']); Rt = np.array(case['rotationMatrix']); tt = np.array(case['translation_m'])
keep = rng.random(len(src)) < case['targetSubsample']
tgt = (Rt @ src[keep].T).T + tt + rng.normal(0, case['targetNoiseSigma_m'], (keep.sum(), 3))
def horn(a, b):
    ca, cb = a.mean(0), b.mean(0); H = (a - ca).T @ (b - cb); U, _, Vt = np.linalg.svd(H)
    Dm = np.diag([1, 1, np.sign(np.linalg.det(Vt.T @ U.T))]); R = Vt.T @ Dm @ U.T; return R, cb - R @ ca
R = np.eye(3); t = np.zeros(3); tree = cKDTree(tgt); prev = None
for it in range(200):
    moved = (R @ src.T).T + t; d, j = tree.query(moved)
    sel = d < max(3 * np.median(d), 1e-4)
    dR, dt = horn(moved[sel], tgt[j[sel]]); R, t = dR @ R, dR @ t + dt
    rms = float(np.sqrt(np.mean(d[sel] ** 2)))
    if prev is not None and abs(prev - rms) < 1e-10: break
    prev = rms
rot_err = np.degrees(np.arccos(np.clip((np.trace(R.T @ Rt) - 1) / 2, -1, 1)))
dtrue, _ = tree.query((Rt @ src.T).T + tt); seltrue = dtrue < max(3 * np.median(dtrue), 1e-4); rms_true = float(np.sqrt(np.mean(dtrue[seltrue] ** 2)))
report['ICP-A'] = {'sourcePoints': int(len(src)), 'targetPoints': int(len(tgt)), 'iterations': it + 1, 'rotationError_deg': float(rot_err),
    'translationError_m': float(np.linalg.norm(t - tt)), 'rmsResidual_m': rms, 'rmsAtTrueTransform_m': rms_true,
    'pass': bool(rot_err <= case['tolerance']['rotation_deg'] and np.linalg.norm(t - tt) <= case['tolerance']['translation_m'] and rms <= rms_true + 1e-5)}

# --- target spheres ---------------------------------------------------------------------------------------------------------------
case = T['TGT-A']
def sphere_fit(p):
    A = np.column_stack([2 * p, np.ones(len(p))]); b = (p ** 2).sum(1); x = np.linalg.lstsq(A, b, rcond=None)[0]
    c0 = x[:3]; f = lambda q: np.linalg.norm(p - q[:3], axis=1) - q[3]
    q = least_squares(f, np.r_[c0, np.sqrt(x[3] + c0 @ c0)], method='lm').x; return q[:3], q[3]
cents = []
for f, truth_c in zip(case['files'], [case['centresStation1_m'], case['centresStation2_m']]):
    p = load(f); cs = []
    for c in truth_c:  # segmentation: points within 2 r of each approximate centre (a target pick in the UI / a seed in the plan)
        near = p[np.linalg.norm(p - np.array(c), axis=1) < 2 * case['sphereRadius_m']]; cs.append(sphere_fit(near)[0])
    cents.append(np.array(cs))
centre_err = max(float(np.max(np.linalg.norm(cents[0] - np.array(case['centresStation1_m']), axis=1))),
                 float(np.max(np.linalg.norm(cents[1] - np.array(case['centresStation2_m']), axis=1))))
R2, t2 = horn(cents[1], cents[0]); Rt = np.array(case['rotationMatrix_station2_to_station1'])
rot_err = np.degrees(np.arccos(np.clip((np.trace(R2.T @ Rt) - 1) / 2, -1, 1))); tr_err = float(np.linalg.norm(t2 - np.array(case['translation_m'])))
res = np.linalg.norm((R2 @ cents[1].T).T + t2 - cents[0], axis=1)
report['TGT-A'] = {'maxCentreError_m': centre_err, 'rotationError_deg': float(rot_err), 'translationError_m': tr_err, 'targetResidualRms_m': float(np.sqrt(np.mean(res ** 2))),
    'pass': bool(centre_err <= case['tolerance']['sphereCentre_m'] and rot_err <= case['tolerance']['rotation_deg'] and tr_err <= case['tolerance']['translation_m'])}

# --- deviation / clash / cloud-to-mesh ----------------------------------------------------------------------------------------------
case = T['DEV-A']; p = load(case['file']); dz = case['design']
a = unit(np.array(dz['end'], float) - np.array(dz['start'], float)); d = cyl_dist(p, np.array(dz['start'], float), a, dz['radius_m'])
ex = case['expected']
report['DEV-A'] = {'max_m': float(d.max()), 'min_m': float(d.min()), 'rms_m': float(np.sqrt(np.mean(d ** 2))), 'beyond10mm': float(np.mean(np.abs(d) > 0.010)),
    'pass': bool(abs(d.max() - ex['signedDistanceMax_m']) <= 1e-6 and abs(d.min() - ex['signedDistanceMin_m']) <= 1e-6 and abs(np.sqrt(np.mean(d ** 2)) - ex['rmsDistance_m']) <= 1e-6 and abs(np.mean(np.abs(d) > 0.010) - ex['pointsBeyond10mm_fraction']) < 1e-12)}
case = T['CLH-A']; p = load(case['file']); out = []
for dsg in case['designs']:
    off = np.array(dsg['designAxisOffset_m']); g = cyl_dist(p, off, np.array([1.0, 0, 0]), dsg['designRadius_m']).min()
    status = 'hard' if g < 0 else ('clearance' if g < dsg['requiredClearance_m'] else 'clear')
    out.append({'minGap_m': float(g), 'status': status, 'pass': bool(abs(g - dsg['minGap_m']) <= dsg['tolerance_m'] and status == dsg['status'])})
report['CLH-A'] = out
case = T['C2M-A']
def pt_tri(p, a, b, c):  # Ericson, Real-Time Collision Detection 5.1.5
    ab, ac, ap = b - a, c - a, p - a; d1, d2 = ab @ ap, ac @ ap
    if d1 <= 0 and d2 <= 0: return a
    bp = p - b; d3, d4 = ab @ bp, ac @ bp
    if d3 >= 0 and d4 <= d3: return b
    vc = d1 * d4 - d3 * d2
    if vc <= 0 and d1 >= 0 and d3 <= 0: return a + d1 / (d1 - d3) * ab
    cp = p - c; d5, d6 = ab @ cp, ac @ cp
    if d6 >= 0 and d5 <= d6: return c
    vb = d5 * d2 - d1 * d6
    if vb <= 0 and d2 >= 0 and d6 <= 0: return a + d2 / (d2 - d6) * ac
    va = d3 * d6 - d5 * d4
    if va <= 0 and (d4 - d3) >= 0 and (d5 - d6) >= 0: return b + (d4 - d3) / ((d4 - d3) + (d5 - d6)) * (c - b)
    den = 1 / (va + vb + vc); return a + ab * vb * den + ac * vc * den
V = np.array(case['mesh']['positions'], float)
got = [min(np.linalg.norm(np.array(q) - pt_tri(np.array(q), *V[t])) for t in case['mesh']['triangles']) for q in case['points_m']]
report['C2M-A'] = {'distances_m': got, 'pass': bool(np.allclose(got, case['expectedUnsignedDistance_m'], atol=1e-12, rtol=0))}

print(json.dumps(report, indent=1))
