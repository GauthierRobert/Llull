"""Synthetic point clouds with known geometry for VC-SCN (pack 10 SCN). Deterministic: numpy default_rng(seed) per set.
Writes <out>/synthetic/*.csv (x,y,z in metres, 6 decimals) and <out>/synthetic_truth.json (ground truth + CRLB-derived tolerances).
Usage: python -I gen_synthetic.py OUTDIR   (numpy >= 1.17 required; tested with numpy 2.5.4)"""
import sys, os, json
import numpy as np

OUT = sys.argv[1]
os.makedirs(os.path.join(OUT, 'synthetic'), exist_ok=True)

def unit(v):
    v = np.asarray(v, float); return v / np.linalg.norm(v)

def frame(axis):
    a = unit(axis); h = np.array([1.0, 0, 0]) if abs(a[0]) < 0.9 else np.array([0, 1.0, 0])
    u = unit(np.cross(a, h)); w = np.cross(a, u); return a, u, w

def cylinder_points(rng, base, axis, r, length, n, theta_range, sigma, ref_dir=None):
    a, u, w = frame(axis)
    if ref_dir is not None:  # rotate the in-plane frame so theta = 0 faces ref_dir (scanner side)
        d = np.asarray(ref_dir, float); d = d - a * (d @ a); u = unit(d); w = np.cross(a, u)
    t = rng.uniform(0, length, n); th = rng.uniform(theta_range[0], theta_range[1], n)
    rad = r + rng.normal(0, sigma, n)
    return np.asarray(base) + np.outer(t, a) + np.outer(rad * np.cos(th), u) + np.outer(rad * np.sin(th), w)

def cyl_residual_jacobian(pts, base, axis, r):
    """Numerical Jacobian of the orthogonal residual d_i = |(x_i - c) x a| - r at the truth; parameters: 2 axis-point offsets in the
    plane normal to a, 2 axis-direction tilts, radius (5 dof, minimal)."""
    a, u, w = frame(axis)
    def resid(q):
        c = base + q[0] * u + q[1] * w; ax = unit(a + q[2] * u + q[3] * w); rr = r + q[4]
        v = pts - c; return np.linalg.norm(np.cross(v, ax), axis=1) - rr
    q0 = np.zeros(5); f0 = resid(q0); J = np.zeros((len(pts), 5)); h = 1e-7
    for k in range(5):
        dq = q0.copy(); dq[k] = h; J[:, k] = (resid(dq) - f0) / h
    return J

def crlb(J, sigma):
    cov = np.linalg.inv(J.T @ J) * sigma ** 2
    return {'radiusStd_m': float(np.sqrt(cov[4, 4])), 'axisAngleStd_deg': float(np.degrees(np.sqrt(cov[2, 2] + cov[3, 3]))),
            'axisPositionStd_m': float(np.sqrt(cov[0, 0] + cov[1, 1]))}

def save(name, pts):
    path = os.path.join(OUT, 'synthetic', name)
    np.savetxt(path, pts, fmt='%.6f', delimiter=',', header='x_m,y_m,z_m', comments='')
    return 'synthetic/' + name

truth = {'generator': 'gen_synthetic.py', 'numpy': np.__version__, 'units': 'metres, degrees', 'cases': {}}
K = 5.0  # tolerance = max(K * CRLB std, floor); K = 5 makes a false fail of an efficient estimator < 1e-6 per parameter

# --- cylinders ---------------------------------------------------------------------------------------------------------------------
cyl_specs = [
    # id, seed, DN, OD mm (EN 10220 / ASME B36.10M, llull pipeSizes.ts), base, axis, length, n, theta range (deg), sigma, outlier fraction
    ('CYL-A', 101, 100, 114.3, [1.0, 2.0, 3.0], [0.8, 0.6, 0.0], 2.0, 4000, (-90, 90), 0.001, 0.0, [0.0, 0.0, 1.0]),
    ('CYL-B', 102, 200, 219.1, [0.0, 0.0, 0.0], [np.sin(np.radians(2)), 0.0, np.cos(np.radians(2))], 3.0, 6000, (-180, 180), 0.002, 0.25, None),
    ('CYL-C', 103, 50, 60.3, [-0.5, 0.3, 1.2], [1.0, 1.0, 1.0], 1.0, 1500, (-60, 60), 0.001, 0.10, [0.0, 0.0, 1.0]),
]
for cid, seed, dn, od, base, axis, length, n, thr, sigma, outf, ref in cyl_specs:
    rng = np.random.default_rng(seed); r = od / 2000.0
    inl = cylinder_points(rng, base, axis, r, length, n, np.radians(thr), sigma, ref)
    n_out = int(round(n * outf / (1 - outf))) if outf > 0 else 0
    lo, hi = inl.min(0) - 0.3, inl.max(0) + 0.3
    out = rng.uniform(lo, hi, (n_out, 3)) if n_out else np.zeros((0, 3))
    pts = np.vstack([inl, out]); pts = pts[rng.permutation(len(pts))]
    c = crlb(cyl_residual_jacobian(inl, np.asarray(base, float), np.asarray(axis, float), r), sigma)
    truth['cases'][cid] = {'file': save(cid.lower() + '.csv', pts), 'seed': seed, 'dn': dn, 'outsideDiameter_mm': od, 'radius_m': r,
        'axisPoint_m': list(map(float, base)), 'axisDirection': unit(axis).round(12).tolist(), 'length_m': length,
        'inliers': n, 'outliers': n_out, 'arcCoverage_deg': [thr[0], thr[1]], 'noiseSigma_m': sigma, 'crlb': c,
        'tolerance': {'radius_m': max(K * c['radiusStd_m'], 2e-4), 'axisAngle_deg': max(K * c['axisAngleStd_deg'], 0.05),
                      'axisPosition_m': max(K * c['axisPositionStd_m'], 1e-3)},
        'expectedDnSnap': dn}

# --- elbow: DN100 straight + 90 deg long-radius bend (R = 1.5 x NPS 4 in = 152.4 mm) + straight ---------------------------------------
rng = np.random.default_rng(201); r = 0.05715; R = 0.1524; sigma = 0.001
p0 = np.array([0.0, 0.0, 1.0]); L1, L2 = 1.5, 1.0
s1 = cylinder_points(rng, p0, [1, 0, 0], r, L1, 3000, (-np.pi, np.pi), sigma)
ctr = p0 + np.array([L1, R, 0.0])  # bend centre; the bend turns +x into +y in the z = 1 plane
phi = rng.uniform(0, np.pi / 2, 1500); th = rng.uniform(-np.pi, np.pi, 1500); rad = r + rng.normal(0, sigma, 1500)
cl = ctr + np.column_stack([R * np.sin(phi), -R * np.cos(phi), np.zeros_like(phi)])
tang = np.column_stack([np.cos(phi), np.sin(phi), np.zeros_like(phi)]); nrm = (ctr - cl) / R; bz = np.array([0, 0, 1.0])
s2 = cl + (rad * np.cos(th))[:, None] * nrm + (rad * np.sin(th))[:, None] * bz
start2 = p0 + np.array([L1 + R, R, 0.0])
s3 = cylinder_points(rng, start2, [0, 1, 0], r, L2, 2000, (-np.pi, np.pi), sigma)
pts = np.vstack([s1, s2, s3]); pts = pts[rng.permutation(len(pts))]
truth['cases']['ELB-A'] = {'file': save('elb-a.csv', pts), 'seed': 201, 'radius_m': r, 'bendRadius_m': R, 'bendAngle_deg': 90.0,
    'segments': [{'start': p0.tolist(), 'direction': [1, 0, 0], 'length_m': L1}, {'start': start2.tolist(), 'direction': [0, 1, 0], 'length_m': L2}],
    'intersectionPoint_m': (p0 + np.array([L1 + R, 0, 0])).tolist(), 'noiseSigma_m': sigma,
    'tolerance': {'radius_m': 1e-3, 'bendRadius_m': 0.01, 'bendAngle_deg': 1.0, 'intersectionPoint_m': 0.005},
    'note': 'tolerances are engineering choices (TOL-ENG) bounded below by the CYL-A CRLB; the bend radius is observable only from the 1500 bend points'}

# --- steel: IPE 300 (h 300, b 150, tw 7.1, tf 10.7 mm; llull packages/domain-aec/src/steel/profiles.ts), member axis +y, 2 m --------------
rng = np.random.default_rng(301); h, b, tw, tf = 0.300, 0.150, 0.0071, 0.0107; Lm = 2.0; sigma = 0.001
faces = []  # visible faces of a section seen from +x and +z (two scan positions): top flange top, flange tips +x, web +x face, flange inner faces +x
def rect(n, y0, fx, fz):
    y = rng.uniform(0, Lm, n); s = rng.uniform(0, 1, n); x, z = fx(s), fz(s); return np.column_stack([x, y, z])
faces.append(rect(2500, 0, lambda s: -b / 2 + b * s, lambda s: np.full_like(s, h / 2)))              # top of top flange
faces.append(rect(600, 0, lambda s: np.full_like(s, b / 2), lambda s: h / 2 - tf * s))             # +x tip of top flange
faces.append(rect(600, 0, lambda s: np.full_like(s, b / 2), lambda s: -h / 2 + tf * s))            # +x tip of bottom flange
faces.append(rect(2500, 0, lambda s: np.full_like(s, tw / 2), lambda s: -h / 2 + tf + (h - 2 * tf) * s))  # web +x face
faces.append(rect(900, 0, lambda s: tw / 2 + (b / 2 - tw / 2) * s, lambda s: np.full_like(s, h / 2 - tf)))  # underside of top flange (+x half)
faces.append(rect(900, 0, lambda s: tw / 2 + (b / 2 - tw / 2) * s, lambda s: np.full_like(s, -h / 2 + tf)))  # top of bottom flange (+x half)
pts = np.vstack(faces); pts = pts + rng.normal(0, sigma, pts.shape); origin = np.array([5.0, 1.0, 4.0]); pts = pts + origin
pts = pts[rng.permutation(len(pts))]
truth['cases']['STL-A'] = {'file': save('stl-a.csv', pts), 'seed': 301, 'profile': 'IPE 300', 'h_mm': 300, 'b_mm': 150, 'tw_mm': 7.1, 'tf_mm': 10.7,
    'axisDirection': [0, 1, 0], 'sectionCentre_m': origin.tolist(), 'noiseSigma_m': sigma, 'roll_deg': 0.0,
    'tolerance': {'h_mm': 3.0, 'b_mm': 3.0, 'axisAngle_deg': 0.2, 'sectionCentre_m': 0.003},
    'note': 'h and b are gated; tw / tf are below 10 sigma of the noise and are reported, not gated. Catalogue neighbours: IPE 270 (270 x 135), IPE 330 (330 x 160), HEA 300 (290 x 300)'}

# --- ICP: rigid transform of the bunny (bunnyInt32.e57) - only the transform is stored, the cloud is read from the E57 file -----------
ax = unit([0.3, 0.5, 0.8]); ang = np.radians(10.0)
Kx = np.array([[0, -ax[2], ax[1]], [ax[2], 0, -ax[0]], [-ax[1], ax[0], 0]])
Rm = np.eye(3) + np.sin(ang) * Kx + (1 - np.cos(ang)) * Kx @ Kx; tv = np.array([0.05, -0.03, 0.02])
truth['cases']['ICP-A'] = {'sourceFile': 'e57/bunnyInt32.e57', 'seed': 401, 'targetSubsample': 0.7, 'targetNoiseSigma_m': 0.0002,
    'rotationAxis': ax.round(12).tolist(), 'rotationAngle_deg': 10.0, 'rotationMatrix': Rm.round(12).tolist(), 'translation_m': tv.tolist(),
    'convention': 'target = R * source + t; the registration returns the transform that maps source onto target',
    'tolerance': {'rotation_deg': 0.05, 'translation_m': 0.0005, 'rmsResidual': 'at most the nearest-neighbour RMS of the true transform + 1e-5 m (sampling-limited, not noise-limited)'}}

# --- target-based registration: 4 sphere targets r = 72.5 mm seen from two stations ---------------------------------------------------
rng = np.random.default_rng(501); rs = 0.0725; sigma = 0.0015
centres_world = np.array([[1.5, -2.0, 0.0], [6.0, 0.5, 0.2], [2.0, 7.0, 1.5], [-3.0, 4.0, 0.8]])
ax2 = unit([0.0, 0.0, 1.0]); ang2 = np.radians(37.0)
K2 = np.array([[0, -ax2[2], ax2[1]], [ax2[2], 0, -ax2[0]], [-ax2[1], ax2[0], 0]])
R2 = np.eye(3) + np.sin(ang2) * K2 + (1 - np.cos(ang2)) * K2 @ K2; t2 = np.array([12.0, -4.0, 0.35])
def sphere_cap(c, n):
    v = rng.normal(size=(n, 3)); v /= np.linalg.norm(v, axis=1)[:, None]; v = v[v @ unit(-c) > -0.2]  # side seen from the station origin
    return c + (rs + rng.normal(0, sigma, len(v)))[:, None] * v
st1 = np.vstack([sphere_cap(c, 800) for c in centres_world])
centres_st2 = (R2.T @ (centres_world - t2).T).T  # station-2 coordinates: world = R2 * st2 + t2
st2 = np.vstack([sphere_cap(c, 800) for c in centres_st2])
truth['cases']['TGT-A'] = {'files': [save('tgt-a-station1.csv', st1), save('tgt-a-station2.csv', st2)], 'seed': 501, 'sphereRadius_m': rs,
    'noiseSigma_m': sigma, 'centresStation1_m': centres_world.tolist(), 'centresStation2_m': centres_st2.round(9).tolist(),
    'rotationMatrix_station2_to_station1': R2.round(12).tolist(), 'rotationAngle_deg': 37.0, 'translation_m': t2.tolist(),
    'tolerance': {'sphereCentre_m': 0.002, 'rotation_deg': 0.05, 'translation_m': 0.003}}

# --- deviation and clash: scanned DN200 run (noise-free, 2 deg x 20 mm grid) against design cylinders ---------------------------------
r1 = 0.10955; L = 2.0
th = np.radians(np.arange(0.0, 360.0, 2.0)); xs = np.arange(0.0, L + 1e-9, 0.02)
TH, X = np.meshgrid(th, xs); grid = np.column_stack([X.ravel(), r1 * np.cos(TH.ravel()), r1 * np.sin(TH.ravel())])
delta = 0.025
truth['cases']['DEV-A'] = {'file': 'synthetic/clh-a.csv', 'design': {'kind': 'cylinder', 'start': [0, -delta, 0], 'end': [L, -delta, 0], 'radius_m': r1},
    'asBuiltOffsetFromDesign_m': [0.0, delta, 0.0], 'expected': {'signedDistanceMax_m': delta, 'signedDistanceMin_m': -delta,
    'fittedAxisOffset_m': delta, 'pointsBeyond10mm_fraction': None},
    'formula': 'd(theta) = sqrt(r^2 + D^2 + 2 r D cos(theta)) - r for a point at angle theta on a cylinder of radius r whose axis is offset by D',
    'tolerance': {'distance_m': 1e-6, 'note': 'CSV stores 6 decimals (1 um)', 'meshSagitta_m_at_64_segments': r1 * (1 - np.cos(np.pi / 64))}}
dd = np.sqrt(r1 ** 2 + delta ** 2 + 2 * r1 * delta * np.cos(th)) - r1
truth['cases']['DEV-A']['expected']['pointsBeyond10mm_fraction'] = float(np.mean(np.abs(dd) > 0.010))
assert np.min(np.abs(np.abs(dd) - 0.010)) > 5e-5  # no grid angle sits on the threshold
truth['cases']['DEV-A']['expected']['rmsDistance_m'] = float(np.sqrt(np.mean(dd ** 2)))
r2 = 0.08415; clash = []
for spacing, req in [(0.15, 0.075), (0.25, 0.075), (0.5, 0.075)]:
    gap = spacing - r1 - r2
    clash.append({'designAxisOffset_m': [0.0, 0.0, spacing], 'designRadius_m': r2, 'requiredClearance_m': req, 'minGap_m': gap,
                  'status': 'hard' if gap < 0 else ('clearance' if gap < req else 'clear'),
                  'tolerance_m': r1 * (1 - np.cos(np.radians(1.0))) + 1e-6})
truth['cases']['CLH-A'] = {'file': save('clh-a.csv', grid), 'scanned': {'radius_m': r1, 'axis': [[0, 0, 0], [L, 0, 0]]}, 'designs': clash,
    'formula': 'gap = D - r_scan - r_design (parallel cylinders, axis spacing D); sampling error <= r_scan (1 - cos(half angular step))'}

# --- plane / mesh analytic distance (cloud-to-mesh): points above a 1 x 1 m square of 2 triangles ------------------------------------------
pl = np.array([[0.25, 0.25, 0.04], [0.5, 0.5, 0.04], [0.75, 0.1, 0.04], [1.3, 0.5, 0.04], [0.5, -0.2, -0.03], [1.3, 1.4, 0.0]])
exp = [0.04, 0.04, 0.04, float(np.hypot(0.3, 0.04)), float(np.hypot(0.2, 0.03)), float(np.hypot(0.3, 0.4))]
truth['cases']['C2M-A'] = {'mesh': {'positions': [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], 'triangles': [[0, 1, 2], [0, 2, 3]]},
    'points_m': pl.tolist(), 'expectedUnsignedDistance_m': exp, 'tolerance_m': 1e-12,
    'formula': 'inside the footprint d = |z|; outside, d = distance to the nearest edge or vertex (Pythagoras)'}

json.dump(truth, open(os.path.join(OUT, 'synthetic_truth.json'), 'w'), indent=1)
print('ok', {k: v.get('file', v.get('files', v.get('sourceFile'))) for k, v in truth['cases'].items()})
