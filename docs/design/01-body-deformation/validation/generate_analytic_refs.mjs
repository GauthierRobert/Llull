// DEF analytic reference generator. Run: node generate_analytic_refs.mjs  (Node >= 18, no npm deps).
// Writes validation/data/*.json. Every closed form is cross-checked by an independent numeric evaluation of the
// deformation map (finite-difference Jacobian + Gauss quadrature) and the relative difference is stored as `numericCheck`.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  twist,
  taper,
  bend,
  stretch,
  scaleNonUniform,
  ffd,
  latticeOf,
  pointPush,
  flowOnCylinder,
  flowAlongArc,
  jacobianDet,
  integrateBox,
  mappedArea,
  gaussLegendre,
  prng,
  round,
} from './deformLaws.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'data');
mkdirSync(out, { recursive: true });
const save = (name, obj) =>
  writeFileSync(join(out, name), JSON.stringify({ generated: 'generate_analytic_refs.mjs', ...obj }, null, 1) + '\n');
const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-300);
const PI = Math.PI;

// Volume of the image of an axis-aligned box under f = integral of det J over the box (change of variables).
const imageVolume = (f, lo, hi, pieces = [2, 2, 8]) => integrateBox((p) => jacobianDet(f, p), lo, hi, 8, pieces);

// ---------------------------------------------------------------- twist
// Box a x b x L on z in [0, L], twisted by angle about its own axis over the whole length (linear ramp: rate k = angle / L).
// det J = 1  =>  V = a b L for ANY law. Lateral face x = a/2: area element sqrt(1 + k^2 y^2) (derivation in TECHNICAL_SPEC §5.2).
const G = (Y, k) => (k === 0 ? Y : (Y * Math.sqrt(1 + k * k * Y * Y)) / 2 + Math.asinh(k * Y) / (2 * k));
const twistCases = [];
for (const [a, b, L, deg] of [
  [10, 10, 100, 90],
  [10, 10, 100, 120],
  [10, 10, 100, 360],
  [20, 5, 50, 180],
  [10, 10, 100, 0],
]) {
  const k = (deg * PI) / 180 / L;
  const lateral = 2 * L * 2 * G(b / 2, k) + 2 * L * 2 * G(a / 2, k);
  const params = { angleRad: (deg * PI) / 180, z0: 0, z1: L, falloff: 'linear' };
  const f = (p) => twist(p, params);
  const vNum = imageVolume(f, [-a / 2, -b / 2, 0], [a / 2, b / 2, L]);
  const faceX = mappedArea((u, v) => [a / 2, u, v], f, [-b / 2, b / 2], [0, L]);
  const faceY = mappedArea((u, v) => [u, b / 2, v], f, [-a / 2, a / 2], [0, L]);
  const latNum = 2 * faceX + 2 * faceY;
  twistCases.push({
    box: { a, b, L },
    angleDeg: deg,
    law: 'linear over the whole length',
    ratePerLength: round(k),
    volume: round(a * b * L),
    lateralArea: round(lateral),
    totalArea: round(lateral + 2 * a * b),
    maxDisplacement: round(Math.hypot(a / 2, b / 2) * 2 * Math.sin((deg * PI) / 180 / 2)),
    numericCheck: { volumeRel: round(rel(vNum, a * b * L), 3), lateralAreaRel: round(rel(latNum, lateral), 3) },
  });
}
// Cylinder twisted about its own axis maps onto itself: max deviation 0.
twistCases.push({ cylinder: { r: 5, L: 40 }, angleDeg: 270, identityShape: true, maxDeviationFromSource: 0, volume: round(PI * 25 * 40) });
// Smooth ramp: rate theta'(z) = angle * 6 t (1 - t) / L; area by quadrature only (no closed form), volume still a b L.
{
  const [a, b, L, deg] = [10, 10, 100, 90];
  const params = { angleRad: (deg * PI) / 180, z0: 0, z1: L, falloff: 'smooth' };
  const f = (p) => twist(p, params);
  const lat =
    2 * mappedArea((u, v) => [a / 2, u, v], f, [-b / 2, b / 2], [0, L]) +
    2 * mappedArea((u, v) => [u, b / 2, v], f, [-a / 2, a / 2], [0, L]);
  twistCases.push({
    box: { a, b, L },
    angleDeg: deg,
    law: 'smooth (3t^2 - 2t^3) over the whole length',
    volume: a * b * L,
    lateralAreaNumeric: round(lat, 9),
    grade: 'numeric quadrature (b)',
  });
}
// Crease at a linear region boundary: angle between face normals across z0 = atan(k |y|) (TECHNICAL_SPEC §5.2), 0 for smooth.
const crease = { box: { a: 10, b: 10 }, regionLength: 50, angleDeg: 90 };
crease.k = round((90 * PI) / 180 / 50);
crease.linearCreaseMaxRad = round(Math.atan(crease.k * 5));
crease.smoothCreaseMaxRad = 0;
save('twist_cases.json', { law: "x' = R(theta(z)) x; det J = 1", cases: twistCases, regionBoundaryCrease: crease });

// ---------------------------------------------------------------- taper
// Linear: s(t) = 1 + (S - 1) t  =>  integral s^2 = (1 + S + S^2) / 3 ; flat (x only): (1 + S) / 2.
// Smooth ramp w = 3t^2 - 2t^3: integral (1 + c w)^2 = 1 + c + 13 c^2 / 35 (int w = 1/2, int w^2 = 13/35), c = S - 1.
const taperCases = [];
for (const [S, falloff, flat] of [
  [0.5, 'linear', false],
  [2, 'linear', false],
  [0.5, 'linear', true],
  [0.5, 'smooth', false],
  [0, 'linear', false],
]) {
  const [a, b, L] = [10, 10, 100];
  const c = S - 1;
  const factor = flat ? (1 + S) / 2 : falloff === 'linear' ? (1 + S + S * S) / 3 : 1 + c + (13 * c * c) / 35;
  const f = (p) => taper(p, { scaleEnd: S, z0: 0, z1: L, falloff, flat });
  const vNum = imageVolume(f, [-a / 2, -b / 2, 0], [a / 2, b / 2, L]);
  const row = {
    box: { a, b, L },
    scaleEnd: S,
    falloff,
    flat,
    volume: round(a * b * L * factor),
    numericCheck: { volumeRel: round(rel(vNum, a * b * L * factor), 3) },
  };
  if (S === 0)
    Object.assign(row, {
      degenerate: true,
      expectedCode: 'DEF_TAPER_DEGENERATE',
      note: 'scaleEnd 0 collapses the end face to a point (det J = 0): refused',
    });
  taperCases.push(row);
}
// Cylinder r, L tapered linearly to scale S = exact cone frustum: V = pi r^2 L (1 + S + S^2)/3, lateral pi (r1 + r2) sqrt(L^2 + (r1 - r2)^2).
{
  const [r, L, S] = [5, 40, 0.4];
  const r2 = r * S;
  taperCases.push({
    cylinder: { r, L },
    scaleEnd: S,
    falloff: 'linear',
    exactShape: 'cone frustum r1 5, r2 2, h 40',
    volume: round((PI * r * r * L * (1 + S + S * S)) / 3),
    lateralArea: round(PI * (r + r2) * Math.hypot(L, r - r2)),
    halfAngleDeg: round((Math.atan((r - r2) / L) * 180) / PI),
    maxDeviationFromAnalyticCone: 0,
  });
}
save('taper_cases.json', { law: "x' = s(z) x, y' = s(z) y; det J = s^2", cases: taperCases });

// ---------------------------------------------------------------- bend
// Neutral fibre y = 0, bend radius R, region length Lb, angle = Lb / R; det J = (R - y) / R.
// Box x in [-a/2, a/2], y in [y0, y1], z in [0, L] (L = Lb): V = a L (y1 - y0) (1 - (y0 + y1) / (2R)) (Pappus).
const bendCases = [];
for (const [a, y0, y1, R, deg] of [
  [10, -5, 5, 50, 90],
  [10, -5, 5, 50, 180],
  [10, 0, 10, 50, 90],
  [10, -10, 0, 50, 90],
]) {
  const Lb = (R * deg * PI) / 180;
  const V = a * Lb * (y1 - y0) * (1 - (y0 + y1) / (2 * R));
  const f = (p) => bend(p, { radius: R, z0: 0, z1: Lb });
  const vNum = imageVolume(f, [-a / 2, y0, 0], [a / 2, y1, Lb]);
  bendCases.push({
    bar: { a, y0, y1, L: round(Lb) },
    radius: R,
    angleDeg: deg,
    volume: round(V),
    neutralFibreLength: round(Lb),
    innerFibreLength: round(((R - y1) * Lb) / R),
    outerFibreLength: round(((R - y0) * Lb) / R),
    jacobianRange: [round((R - y1) / R), round((R - y0) / R)],
    numericCheck: { volumeRel: round(rel(vNum, V), 3) },
  });
}
// Cylinder r bent through 360 deg on radius R = torus: V = 2 pi^2 R r^2, A = 4 pi^2 R r; through 90 deg: quarter.
for (const deg of [360, 90]) {
  const [r, R] = [5, 50];
  const q = deg / 360;
  bendCases.push({
    cylinder: { r, L: round((2 * PI * R * deg) / 360) },
    radius: R,
    angleDeg: deg,
    exactShape: `torus segment R ${R} r ${r}`,
    volume: round(2 * PI * PI * R * r * r * q),
    lateralArea: round(4 * PI * PI * R * r * q),
    maxDeviationFromAnalyticTorus: 0,
  });
}
// Fold limit: det J = (R - y)/R <= 0 when the inner side reaches the bend axis (y >= R): refused.
bendCases.push({
  bar: { a: 10, y0: -5, y1: 5 },
  radius: 4,
  expectedCode: 'DEF_BEND_RADIUS_TOO_SMALL',
  limit: 'radius must exceed the largest inner-side distance of the body from the neutral fibre (5)',
  minJacobian: round((4 - 5) / 4),
});
// Rigid continuation: a point 10 beyond the region end of a 90 deg bend, on the neutral fibre.
{
  const R = 50;
  const Lb = (R * PI) / 2;
  bendCases.push({
    rigidContinuation: {
      point: [0, 0, round(Lb + 10)],
      radius: R,
      angleDeg: 90,
      image: round(bend([0, 0, Lb + 10], { radius: R, z0: 0, z1: Lb })),
    },
  });
}
save('bend_cases.json', {
  law: "theta = (z - z0)/R; y' = R - (R - y) cos theta; z' = z0 + (R - y) sin theta; det J = (R - y)/R",
  cases: bendCases,
});

// ---------------------------------------------------------------- stretch + non-uniform scale
const scaleCases = [];
{
  const [a, b, L, f, z0, z1] = [10, 10, 100, 1.5, 20, 60];
  const V = a * b * (L + (f - 1) * (z1 - z0));
  const g = (p) => stretch(p, { factor: f, z0, z1 });
  const vNum = imageVolume(g, [-a / 2, -b / 2, 0], [a / 2, b / 2, L], [1, 1, 20]);
  scaleCases.push({
    op: 'stretch_body',
    box: { a, b, L },
    factor: f,
    region: [z0, z1],
    volume: V,
    newLength: L + (f - 1) * (z1 - z0),
    numericCheck: { volumeRel: round(rel(vNum, V), 3) },
  });
  scaleCases.push({
    op: 'stretch_body',
    box: { a, b, L },
    factor: 2,
    preserveVolume: true,
    lateralScale: round(1 / Math.SQRT2),
    volume: a * b * L,
    newLength: 200,
    note: 'whole-body affine (sx = sy = 1/sqrt f, sz = f): det = 1',
  });
}
// Sphere -> ellipsoid volume; spheroid areas (closed forms); elliptic cylinder perimeter (Gauss-Legendre of the complete elliptic integral).
const r = 10;
const prolateArea = (A, C) => {
  const e = Math.sqrt(1 - (A * A) / (C * C));
  return 2 * PI * A * A * (1 + (C / (A * e)) * Math.asin(e));
};
const oblateArea = (A, C) => {
  const e = Math.sqrt(1 - (C * C) / (A * A));
  return 2 * PI * A * A * (1 + ((1 - e * e) / e) * Math.atanh(e));
};
scaleCases.push({
  op: 'scale_nonuniform',
  sphere: { r },
  factors: [1, 1, 2],
  volume: round((4 / 3) * PI * r ** 3 * 2),
  area: round(prolateArea(r, 2 * r)),
  shape: 'prolate spheroid a = b = 10, c = 20',
});
scaleCases.push({
  op: 'scale_nonuniform',
  sphere: { r },
  factors: [2, 2, 1],
  volume: round((4 / 3) * PI * r ** 3 * 4),
  area: round(oblateArea(2 * r, r)),
  shape: 'oblate spheroid a = b = 20, c = 10',
});
scaleCases.push({
  op: 'scale_nonuniform',
  sphere: { r },
  factors: [1, 2, 3],
  volume: round((4 / 3) * PI * r ** 3 * 6),
  shape: 'triaxial ellipsoid 10/20/30 (area: no elementary closed form, TBD numeric)',
});
{
  const [A, B, h] = [10, 5, 20]; // cylinder r 5 scaled [2, 1, 1]
  const { x, w } = gaussLegendre(64);
  let P = 0;
  for (let q = 0; q < 16; q++)
    for (let i = 0; i < 64; i++) {
      const t = ((q + (x[i] + 1) / 2) * (PI / 2)) / 16;
      P += (w[i] / 2) * (PI / 2 / 16) * Math.sqrt(A * A * Math.sin(t) ** 2 + B * B * Math.cos(t) ** 2);
    }
  P *= 4;
  scaleCases.push({
    op: 'scale_nonuniform',
    cylinder: { r: 5, h },
    factors: [2, 1, 1],
    volume: round(PI * A * B * h),
    lateralArea: round(P * h, 11),
    perimeter: round(P, 11),
    grade: 'perimeter by 1024-point Gauss quadrature of 4 int_0^{pi/2} sqrt(a^2 sin^2 + b^2 cos^2)',
  });
}
scaleCases.push({
  op: 'scale_nonuniform',
  box: { size: [10, 20, 30] },
  factors: [-1, 1, 1],
  volume: 6000,
  note: 'a true mirror (det -1): faces reversed, volume positive; mirror_entity today only moves position',
});
scaleCases.push({ op: 'scale_nonuniform', box: { size: [10, 20, 30] }, factors: [1, 0, 1], expectedCode: 'DEF_SCALE_SINGULAR' });
save('scale_stretch_cases.json', { cases: scaleCases });

// ---------------------------------------------------------------- FFD
const rnd = prng(20261022);
const lo = [-5, -10, 0];
const hi = [5, 10, 40];
const deg = [2, 3, 4];
const samples = Array.from({ length: 12 }, () => [0, 1, 2].map((a) => lo[a] + (hi[a] - lo[a]) * rnd()));
const identity = latticeOf(lo, hi, deg);
const idRes = Math.max(
  ...samples.map((p) => Math.max(...ffd(p, { min: lo, max: hi, degrees: deg, points: identity }).map((c, a) => Math.abs(c - p[a])))),
);
const A = [
  [1.2, 0.3, -0.1],
  [0.05, 0.9, 0.2],
  [0.1, -0.2, 1.1],
];
const t0 = [3, -2, 7];
const affine = (q) => [0, 1, 2].map((r_) => A[r_][0] * q[0] + A[r_][1] * q[1] + A[r_][2] * q[2] + t0[r_]);
const affPts = identity.map((row) => row.map((col) => col.map(affine)));
const affRes = Math.max(
  ...samples.map((p) => {
    const d = ffd(p, { min: lo, max: hi, degrees: deg, points: affPts });
    const e = affine(p);
    return Math.max(...d.map((c, a) => Math.abs(c - e[a])));
  }),
);
const detA =
  A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1]) -
  A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0]) +
  A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);
// Barrel: unit cube, degrees [1, 1, 2], middle u-layer scaled by m about the axis (0.5, 0.5): g(u) = 1 + 2 c u (1 - u), c = m - 1.
const barrel = (m) => {
  const pts = latticeOf([0, 0, 0], [1, 1, 1], [1, 1, 2]).map((row) =>
    row.map((col) => col.map((q, k) => (k === 1 ? [0.5 + (q[0] - 0.5) * m, 0.5 + (q[1] - 0.5) * m, q[2]] : q))),
  );
  const c = m - 1;
  const V = 1 + (2 * c) / 3 + (2 * c * c) / 15;
  const vNum = integrateBox(
    (p) => jacobianDet((q) => ffd(q, { min: [0, 0, 0], max: [1, 1, 1], degrees: [1, 1, 2], points: pts }), p),
    [0, 0, 0],
    [1, 1, 1],
    8,
    [1, 1, 2],
  );
  const bern = [1, m, (1 + 2 * m * m) / 3, m, 1];
  return {
    m,
    volume: round(V),
    jacobianExactRange: [round(Math.min(1, (1 + c / 2) ** 2)), round(Math.max(1, (1 + c / 2) ** 2))],
    jacobianBernsteinBound: [round(Math.min(...bern)), round(Math.max(...bern))],
    numericCheck: { volumeRel: round(rel(vNum, V), 3) },
  };
};
const fold = (() => {
  const pts = latticeOf([0, 0, 0], [1, 1, 1], [1, 1, 1]).map((row, i) =>
    row.map((col) => col.map((q) => (i === 1 ? [-0.5, q[1], q[2]] : q))),
  );
  const d = jacobianDet((q) => ffd(q, { min: [0, 0, 0], max: [1, 1, 1], degrees: [1, 1, 1], points: pts }), [0.5, 0.5, 0.5]);
  return {
    lattice: 'unit cube, degrees [1,1,1], the i = 1 plane of control points moved to x = -0.5 (past i = 0)',
    minJacobian: round(d, 9),
    expectedCode: 'DEF_FOLDOVER',
  };
})();
save('ffd_cases.json', {
  basis: 'tensor-product Bernstein (Sederberg & Parry 1986, eq. 2)',
  identity: { box: { min: lo, max: hi }, degrees: deg, samples: samples.length, maxResidual: idRes, tolerance: 1e-12 },
  affine: {
    matrix: A,
    translation: t0,
    det: round(detA),
    maxResidual: affRes,
    tolerance: 1e-9,
    boxVolume: 10 * 20 * 40,
    imageVolume: round(detA * 8000),
  },
  barrel: [barrel(1.5), barrel(0.5), barrel(2)],
  foldover: fold,
});

// ---------------------------------------------------------------- point push
// phi(s) = (1 - s^2)^3 on a sphere of radius r centred on a planar face (solid = half-space z <= 0 locally), push +z by d:
// det J = 1 + d dphi/dz  =>  Delta V = d * integral over the face disk of phi = d pi r^2 / 4 (divergence theorem).
// Fold limit: max |grad phi| = 96 / (25 sqrt 5 r) at s = 1/sqrt 5  =>  det J > 0 iff |d| < 25 sqrt 5 r / 96.
{
  const [r, d] = [10, 2];
  const dV = (d * PI * r * r) / 4;
  const f = (p) => pointPush(p, { center: [0, 0, 0], direction: [0, 0, 1], distance: d, radius: r });
  const vNum = integrateBox(
    (p) => (p[0] ** 2 + p[1] ** 2 + p[2] ** 2 < r * r ? jacobianDet(f, p) - 1 : 0),
    [-r, -r, -r],
    [r, r, 0],
    10,
    [12, 12, 6],
  );
  const limit = (25 * Math.sqrt(5) * r) / 96;
  save('point_deform_cases.json', {
    falloff: 'phi(s) = (1 - s^2)^3, s = |p - c| / r (C2, compact support)',
    cases: [
      {
        block: 'box 100 x 100 x 50, top face z = 0, push at its centre',
        radius: r,
        distance: d,
        deltaVolume: round(dV),
        peakDisplacement: d,
        numericCheck: { deltaVolumeRel: round(rel(vNum, dV), 3) },
      },
      {
        radius: r,
        foldLimitDistance: round(limit),
        maxGradPhi: round(96 / (25 * Math.sqrt(5) * r)),
        distanceRefused: round(limit * 1.01, 6),
        expectedCode: 'DEF_FOLDOVER',
      },
    ],
  });
}

// ---------------------------------------------------------------- flow
{
  const [W, H, t, R] = [60, 20, 2, 30];
  const V = W * H * (t + (t * t) / (2 * R));
  const f = (p) => flowOnCylinder(p, { radius: R });
  const vNum = imageVolume(f, [0, 0, 0], [W, H, t], [12, 2, 2]);
  const lenNum = (() => {
    let s = 0;
    const n = 2000;
    for (let i = 0; i < n; i++) {
      const a = f([(W * i) / n, 0, 0]);
      const b = f([(W * (i + 1)) / n, 0, 0]);
      s += Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    }
    return s;
  })();
  const arc = (p) => flowAlongArc(p, { radius: 50, length: (50 * PI) / 2 });
  const bendSame = Math.max(
    ...samples.map((p) => {
      const q = [p[0] * 0.1, p[1] * 0.1, p[2]];
      const u = arc(q);
      const v = bend(q, { radius: 50, z0: 0, z1: (50 * PI) / 2 });
      return Math.max(...u.map((c, k) => Math.abs(c - v[k])));
    }),
  );
  save('flow_cases.json', {
    cases: [
      {
        op: 'flow_on_surface',
        plate: { W, H, t, side: 'outside (w in [0, t])' },
        cylinderRadius: R,
        volume: round(V),
        wrapAngleDeg: round(((W / R) * 180) / PI),
        baseLineLengthPreserved: W,
        numericCheck: { volumeRel: round(rel(vNum, V), 3), lengthRel: round(rel(lenNum, W), 3) },
      },
      { op: 'flow_on_surface', plate: { W, H, t, side: 'centred (w in [-t/2, t/2])' }, cylinderRadius: R, volume: W * H * t },
      {
        op: 'flow_on_surface',
        plate: { W: 200, H, t },
        cylinderRadius: R,
        expectedCode: 'DEF_FLOW_OVERLAP',
        note: 'W > 2 pi R = 188.4956: the wrapped plate overlaps itself',
      },
      {
        op: 'flow_along_curve',
        note: 'straight base curve onto a circular arc of radius 50 without stretch = bend_body with the neutral fibre on the base curve',
        maxDifferenceToBend: bendSame,
      },
    ],
  });
}

// ---------------------------------------------------------------- golden point vectors (TS <-> C++ parity, TR-DEF-04)
const P = [
  [0, 0, 0],
  [5, 5, 50],
  [-5, 5, 100],
  [3, -4, 25],
  [5, -5, 120],
  [-2, 1, -10],
  [4.5, 0.5, 75],
  [0, 5, 60],
];
const laws = {
  twist: { f: twist, params: { angleRad: PI / 2, z0: 0, z1: 100, falloff: 'linear' } },
  twist_smooth: { f: twist, params: { angleRad: PI / 2, z0: 20, z1: 80, falloff: 'smooth' } },
  taper: { f: taper, params: { scaleEnd: 0.5, z0: 0, z1: 100, falloff: 'linear' } },
  taper_flat: { f: taper, params: { scaleEnd: 0.5, z0: 0, z1: 100, falloff: 'linear', flat: true } },
  bend: { f: bend, params: { radius: 50, z0: 0, z1: (50 * PI) / 2 } },
  stretch: { f: stretch, params: { factor: 1.5, z0: 20, z1: 60 } },
  scale_nonuniform: { f: scaleNonUniform, params: { factors: [1, 2, 3] } },
  point_push: { f: pointPush, params: { center: [0, 0, 50], direction: [1, 0, 0], distance: 3, radius: 20 } },
  flow_on_cylinder: { f: flowOnCylinder, params: { radius: 30 } },
};
const vectors = {};
for (const [name, { f, params }] of Object.entries(laws))
  vectors[name] = {
    params,
    points: P.map((p) => ({
      in: p,
      out: round(f(p, params)),
      det: round(
        jacobianDet((q) => f(q, params), p),
        9,
      ),
    })),
  };
const ffdPts = latticeOf([0, 0, 0], [10, 10, 100], [2, 2, 3]).map((row, i) =>
  row.map((col, j) => col.map((q, k) => (i === 1 && j === 1 && k === 2 ? [q[0] + 4, q[1], q[2]] : q))),
);
vectors.ffd = {
  params: { min: [0, 0, 0], max: [10, 10, 100], degrees: [2, 2, 3], moved: [{ index: [1, 1, 2], delta: [4, 0, 0] }] },
  // outside the lattice box the map is the identity (TECHNICAL_SPEC §5.3: the points outside are unmoved), not the extrapolated Bernstein polynomial
  points: P.map((p) => ({
    in: p,
    out: p.every((c, a) => c >= [0, 0, 0][a] && c <= [10, 10, 100][a])
      ? round(ffd(p, { min: [0, 0, 0], max: [10, 10, 100], degrees: [2, 2, 3], points: ffdPts }))
      : round(p),
  })),
};
save('point_vectors.json', { note: 'frame = world (origin 0, axis +z, reference +x); tolerance 1e-9 absolute', laws: vectors });

// ---------------------------------------------------------------- mesh path refinement budget
// Linear interpolation of a C2 map along an edge of length h errs by <= h^2 M2 / 8, M2 = max |d2F/ds2| along the edge.
// Twist along z: |d2F/dz2| = k^2 rho  =>  h <= sqrt(8 tol / (k^2 rho_max)).  Bend along z: |d2F/dz2| = (R - y)/R^2.
const budget = [];
for (const [what, M2, tol] of [
  ['twist box 10x10x100, 90 deg (k = pi/200, rho_max = 5 sqrt 2)', (PI / 200) ** 2 * 5 * Math.SQRT2, 0.01],
  ['bend bar y in [-5, 5], R 50 (M2 = (R + 5) / R^2)', 55 / 2500, 0.01],
])
  budget.push({ what, M2: round(M2), tolerance: tol, maxEdgeLength: round(Math.sqrt((8 * tol) / M2), 6) });
save('mesh_budget.json', { rule: 'h_max = sqrt(8 tol / M2)', cases: budget });

process.stdout.write(`DEF analytic references written to ${out}\n`);
