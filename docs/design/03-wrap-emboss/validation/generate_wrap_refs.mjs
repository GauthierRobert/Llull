#!/usr/bin/env node
// WRP analytic reference data (no npm deps): cylinder wrap isometry, projection-vs-wrap length loss, cone development, sphere
// exponential-map distortion, emboss / deboss volumes on planar, cylindrical and conical faces, knurl tooth count.
// Every closed form is cross-checked by an independent numeric evaluation (dense sampling / quadrature) and the residual is written
// next to it (`check.*`), so the datasets are self-consistent.
//
//   node generate_wrap_refs.mjs            writes data/{cylinder_wrap,projection_vs_wrap,cone_development,sphere_geodesic_wrap,
//                                          emboss_volumes,knurl_cases}.json
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'data');
mkdirSync(out, { recursive: true });

const r12 = (x) => Number(x.toPrecision(12));
const write = (name, value) => writeFileSync(join(out, name), `${JSON.stringify(value, null, 1)}\n`);
const deg = (d) => (d * Math.PI) / 180;

/** Polyline length of a parametric 3D curve sampled at n+1 points. */
function curveLength(f, n = 200000) {
  let length = 0;
  let previous = f(0);
  for (let k = 1; k <= n; k++) {
    const p = f(k / n);
    length += Math.hypot(p[0] - previous[0], p[1] - previous[1], p[2] - previous[2]);
    previous = p;
  }
  return length;
}

/** Gauss-Legendre 1D on [a,b] with m panels of 5 points. */
const GL5 = [
  [0, 0.5688888888888889],
  [-0.5384693101056831, 0.47862867049936647],
  [0.5384693101056831, 0.47862867049936647],
  [-0.906179845938664, 0.23692688505618908],
  [0.906179845938664, 0.23692688505618908],
];
function integrate(f, a, b, m = 200) {
  let sum = 0;
  const h = (b - a) / m;
  for (let i = 0; i < m; i++) {
    const c = a + (i + 0.5) * h;
    for (const [x, w] of GL5) sum += w * f(c + (x * h) / 2);
  }
  return (sum * h) / 2;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 1. Cylinder wrap = isometry of the developed plane (chart x = arc length r*theta, chart y = axial z).
// Wrap of a chart point (x, y): P = (r cos(x/r), r sin(x/r), y). Every chart length is preserved (Gaussian curvature 0).
const R_CYL = 20;
const wrapCyl = (r, [x, y]) => [r * Math.cos(x / r), r * Math.sin(x / r), y];
const cylinderLines = [0, 30, 45, 60, 90].map((betaDeg) => {
  const L = 30;
  const b = deg(betaDeg);
  const end = [L * Math.cos(b), L * Math.sin(b)];
  const numeric = curveLength((t) => wrapCyl(R_CYL, [end[0] * t, end[1] * t]));
  const dTheta = (L * Math.cos(b)) / R_CYL;
  return {
    case: `line L=30 at ${betaDeg} deg to the circumferential direction`,
    chartLength: L,
    betaDeg,
    expectedLength3d: L,
    angularSpanRad: r12(dTheta),
    axialSpan: r12(L * Math.sin(b)),
    helixPitchPerTurn: betaDeg === 0 || betaDeg === 90 ? null : r12(2 * Math.PI * R_CYL * Math.tan(b)),
    curveType3d: betaDeg === 0 ? 'circular arc' : betaDeg === 90 ? 'line (axial)' : 'helix',
    check: { numericLength3d: r12(numeric), residual: r12(numeric - L) },
  };
});
const circleCases = [4, 8, 15].map((a) => {
  const numeric = curveLength((t) => wrapCyl(R_CYL, [a * Math.cos(2 * Math.PI * t), a * Math.sin(2 * Math.PI * t)]));
  return {
    case: `chart circle radius ${a} centred on the anchor`,
    chartRadius: a,
    expectedLength3d: r12(2 * Math.PI * a),
    expectedEnclosedSurfaceArea: r12(Math.PI * a * a),
    angularSpanRad: r12((2 * a) / R_CYL),
    check: { numericLength3d: r12(numeric), residual: r12(numeric - 2 * Math.PI * a) },
  };
});
write('cylinder_wrap.json', {
  generated: 'generate_wrap_refs.mjs',
  derivation:
    'Developable surface: the chart (x = r*theta arc length, y = axial) is an isometry, so every chart length and area is preserved exactly. ' +
    'A chart line at angle beta to the circumferential direction becomes a helix with pitch 2*pi*r*tan(beta) (circle for beta=0, axial line for 90).',
  radius: R_CYL,
  fullWrapChartWidth: r12(2 * Math.PI * R_CYL),
  lines: cylinderLines,
  circles: circleCases,
  overlap: {
    case: 'chart width larger than the circumference overlaps itself',
    chartWidth: 130,
    circumference: r12(2 * Math.PI * R_CYL),
    expectedCode: 'WRP_WRAP_OVERLAP',
  },
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 2. Projection along a direction is NOT length-preserving: a circumferential chart segment of width w centred on the anchor and
// projected along -normal (anchor normal) onto the cylinder lands on an arc of length 2 r asin(w / 2r); w > 2r misses the face.
const projection = [5, 10, 20, 30, 38, 40, 45].map((w) => {
  if (w > 2 * R_CYL)
    return { chartWidth: w, wrapLength: w, projectedArcLength: null, expectedCode: 'WRP_PROJECTION_MISSES_FACE', lossPercent: null };
  const arc = 2 * R_CYL * Math.asin(w / (2 * R_CYL));
  const numeric = curveLength((t) => {
    const x = -w / 2 + w * t;
    return [x, Math.sqrt(R_CYL * R_CYL - x * x), 0];
  });
  return {
    chartWidth: w,
    wrapLength: w,
    projectedArcLength: r12(arc),
    lengthGainPercent: r12((100 * (arc - w)) / w),
    check: { numericArc: r12(numeric), residual: r12(numeric - arc) },
  };
});
write('projection_vs_wrap.json', {
  generated: 'generate_wrap_refs.mjs',
  derivation:
    'Projection along the anchor normal maps chart x to the cylinder point with the same x coordinate: arc = 2 r asin(w/2r) > w; wrap keeps w. ' +
    'Projected text is stretched toward the silhouette and cannot reach beyond it (w > 2r).',
  radius: R_CYL,
  cases: projection,
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 3. Cone development. Semi-angle alpha (axis to surface). A surface point at slant distance s from the apex and azimuth theta maps
// to chart polar coordinates (rho = s, phi = theta sin(alpha)); the full development is a sector of angle 2 pi sin(alpha).
function coneCase(name, rBase, height, rTop = 0) {
  const slant = Math.hypot(height, rBase - rTop);
  const sinA = (rBase - rTop) / slant;
  const alpha = Math.asin(sinA);
  const s2 = rBase / sinA;
  const s1 = rTop / sinA;
  const sector = 2 * Math.PI * sinA;
  const lateralArea = Math.PI * (rBase + rTop) * slant;
  const chartArea = (sector * (s2 * s2 - s1 * s1)) / 2;
  // isometry check: a chart circle of radius a around the chart point (rho0, 0) mapped to 3D keeps its length
  const a = Math.min(4, 0.2 * (s2 - s1));
  const rho0 = (s1 + s2) / 2;
  const map = ([u, v]) => {
    const rho = Math.hypot(u, v);
    const theta = Math.atan2(v, u) / sinA;
    const radius = rho * sinA;
    return [radius * Math.cos(theta), radius * Math.sin(theta), (s2 - rho) * Math.cos(alpha)];
  };
  const numeric = curveLength((t) => map([rho0 + a * Math.cos(2 * Math.PI * t), a * Math.sin(2 * Math.PI * t)]));
  return {
    case: name,
    baseRadius: rBase,
    topRadius: rTop,
    height,
    slantLength: r12(slant),
    semiAngleDeg: r12((alpha * 180) / Math.PI),
    developedSectorAngleRad: r12(sector),
    developedSectorAngleDeg: r12((sector * 180) / Math.PI),
    developedInnerRadius: r12(s1),
    developedOuterRadius: r12(s2),
    lateralArea: r12(lateralArea),
    check: {
      chartArea: r12(chartArea),
      areaResidual: r12(chartArea - lateralArea),
      chartCircleRadius: a,
      chartCircleCentreRho: r12(rho0),
      numericCircleLength3d: r12(numeric),
      circleLengthResidual: r12(numeric - 2 * Math.PI * a),
    },
  };
}
write('cone_development.json', {
  generated: 'generate_wrap_refs.mjs',
  derivation:
    'Cone / frustum lateral face, semi-angle alpha = asin((r_base - r_top)/slant). Development = annular sector, angle 2 pi sin(alpha), radii ' +
    's1 = r_top/sin(alpha), s2 = r_base/sin(alpha); area = pi (r_base + r_top) slant. Chart (rho, phi) <-> surface (slant s = rho, azimuth = phi/sin(alpha)).',
  cases: [
    coneCase('cone r 20 h 40 (add_cone)', 20, 40),
    coneCase('frustum r 30 -> 15, h 40', 30, 40, 15),
    coneCase('45 deg cone r 10 h 10', 10, 10),
  ],
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 4. Doubly curved face: geodesic polar (exponential) map at an anchor on a sphere of radius R. Chart radius a -> polar angle a/R.
// Radial (geodesic) lengths are exact; circumferential lengths scale by sin(a/R)/(a/R); areas by 2R^2(1-cos(a/R)) / (pi a^2).
const R_SPH = 25;
const sphere = [2, 5, 10, 20, 30].map((a) => {
  const t = a / R_SPH;
  const boundary = 2 * Math.PI * R_SPH * Math.sin(t);
  const cap = 2 * Math.PI * R_SPH * R_SPH * (1 - Math.cos(t));
  const numeric = curveLength((s) => {
    const phi = 2 * Math.PI * s;
    return [R_SPH * Math.sin(t) * Math.cos(phi), R_SPH * Math.sin(t) * Math.sin(phi), R_SPH * Math.cos(t)];
  });
  return {
    chartRadius: a,
    polarAngleRad: r12(t),
    radialLengthExact: a,
    boundaryLength3d: r12(boundary),
    boundaryLengthChart: r12(2 * Math.PI * a),
    circumferentialStrain: r12(Math.sin(t) / t - 1),
    capArea3d: r12(cap),
    chartArea: r12(Math.PI * a * a),
    areaRatio: r12(cap / (Math.PI * a * a)),
    check: { numericBoundary: r12(numeric), residual: r12(numeric - boundary) },
  };
});
write('sphere_geodesic_wrap.json', {
  generated: 'generate_wrap_refs.mjs',
  derivation:
    'Sphere radius R, exponential map at the anchor: chart polar (a, phi) -> point at geodesic distance a, polar angle a/R. Radial strain 0; ' +
    'circumferential strain sin(a/R)/(a/R) - 1 (the maximum length strain of the map inside the disk); area ratio 2R^2(1-cos(a/R))/(pi a^2). ' +
    'No length-preserving map of a disk onto a sphere exists (Gauss Theorema Egregium), so the strain is the honest distortion report.',
  radius: R_SPH,
  cases: sphere,
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 5. Emboss / deboss volumes with walls normal to the face (the faceSlab construction).
// Volume between the face (offset 0) and its offset n in [n0, n1] over a region of face area A: dV = (1 + 2H n + K n^2) dA dn.
// Plane: V = A d. Cylinder (radius r, outward +n): V = A d (1 + d / 2r) for emboss [0, d], A d (1 - d / 2r) for deboss [-d, 0].
// Cone: K = 0, 2H = cos(alpha) / (s sin(alpha)); over an annular chart sector s1..s2, chart angle P: V = A d + (d^2/2) cot(alpha) P (s2 - s1).
const r = R_CYL;
const rect = { w: 30, h: 10 };
const A = rect.w * rect.h;
const cylEmboss = (d) => A * d * (1 + d / (2 * r));
const cylDeboss = (d) => A * d * (1 - d / (2 * r));
const span = rect.w / r;
const directEmboss = (d) => (span / 2) * ((r + d) ** 2 - r * r) * rect.h;
const directDeboss = (d) => (span / 2) * (r * r - (r - d) ** 2) * rect.h;
const band = { h: 10, d: 1 };
const bandFormula = 2 * Math.PI * r * band.h * band.d * (1 + band.d / (2 * r));
const bandAnnulus = Math.PI * ((r + band.d) ** 2 - r * r) * band.h;
// cone band by Pappus (meridian rectangle (s2-s1) x d, centroid radius) as the independent check
function coneBand(rBase, height, s1, s2, d, chartAngle) {
  const slant = Math.hypot(rBase, height);
  const sinA = rBase / slant;
  const cosA = height / slant;
  const area = (chartAngle * (s2 * s2 - s1 * s1)) / 2;
  const formula = area * d + ((d * d) / 2) * (cosA / sinA) * chartAngle * (s2 - s1);
  const full = 2 * Math.PI * sinA;
  const pappus = (chartAngle / full) * 2 * Math.PI * (s2 - s1) * d * (((s1 + s2) / 2) * sinA + (d / 2) * cosA);
  const quadrature = integrate((n) => integrate((s) => chartAngle * s * (1 + (n * cosA) / (s * sinA)), s1, s2, 50), 0, d, 50);
  return { area, formula, pappus, quadrature };
}
const coneFull = coneBand(20, 40, 15, 35, 1, 2 * Math.PI * (20 / Math.hypot(20, 40)));
const conePart = coneBand(20, 40, 15, 35, 1, 0.5);
write('emboss_volumes.json', {
  generated: 'generate_wrap_refs.mjs',
  derivation:
    'Steiner formula for a normal offset: dV = (1 + 2 H n + K n^2) dA dn (H mean, K Gaussian curvature, n along the emboss normal). ' +
    'Walls are ruled along the face normal (the faceSlab construction), so the region on the offset face is the normal image of the region.',
  planar: { case: 'rectangle 30 x 10, depth 1 on a box face', area: A, depth: 1, volume: A },
  cylinder: {
    radius: r,
    region: 'chart rectangle 30 (circumferential) x 10 (axial)',
    chartArea: A,
    cases: [0.5, 1, 2].flatMap((d) => [
      {
        mode: 'emboss',
        depth: d,
        volume: r12(cylEmboss(d)),
        check: { direct: r12(directEmboss(d)), residual: r12(cylEmboss(d) - directEmboss(d)) },
      },
      {
        mode: 'deboss',
        depth: d,
        volume: r12(cylDeboss(d)),
        check: { direct: r12(directDeboss(d)), residual: r12(cylDeboss(d) - directDeboss(d)) },
      },
    ]),
    fullBand: {
      case: 'full-circumference band, axial height 10, emboss depth 1 (baseline plan: union of cylinders r 20 and r 21)',
      volume: r12(bandFormula),
      volumeOverPi: r12(bandFormula / Math.PI),
      check: { annulus: r12(bandAnnulus), residual: r12(bandFormula - bandAnnulus) },
    },
  },
  cone: {
    cone: 'add_cone radius 20 height 40 (semi-angle atan(1/2))',
    cases: [
      {
        region: 'full band, slant 15..35 from the apex, emboss depth 1',
        chartArea: r12(coneFull.area),
        volume: r12(coneFull.formula),
        check: { pappus: r12(coneFull.pappus), quadrature: r12(coneFull.quadrature), residual: r12(coneFull.formula - coneFull.pappus) },
      },
      {
        region: 'chart sector 0.5 rad, slant 15..35, emboss depth 1',
        chartArea: r12(conePart.area),
        volume: r12(conePart.formula),
        check: { pappus: r12(conePart.pappus), quadrature: r12(conePart.quadrature), residual: r12(conePart.formula - conePart.pappus) },
      },
    ],
  },
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 6. Knurl on a cylinder: a closed straight or diagonal knurl needs an integer number of teeth N = pi d / p (circular pitch p). Geometry only;
// the standard pitch series and diameter corrections (DIN 82, ISO 13444) are NOT reproduced here (paywalled; see sources.md).
const knurl = [
  [20, 1.0],
  [12, 0.8],
  [25.4, 1.2],
].map(([d, p]) => {
  const n = (Math.PI * d) / p;
  const nRound = Math.round(n);
  return {
    diameter: d,
    pitch: p,
    teethExact: r12(n),
    teethRounded: nRound,
    diameterForIntegerTeeth: r12((nRound * p) / Math.PI),
    expectedWarning: 'WRP_KNURL_PITCH_ADJUSTED',
  };
});
write('knurl_cases.json', {
  generated: 'generate_wrap_refs.mjs',
  derivation:
    'Circumferential closure: N p = pi d. llull keeps d and adjusts the pitch to pi d / round(pi d / p), or reports the diameter that closes.',
  cases: knurl.map((k) => ({ ...k, pitchForIntegerTeeth: r12((Math.PI * k.diameter) / k.teethRounded) })),
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 7. Walls along a pull direction instead of the face normal (mould-friendly emboss): chart rectangle 30 x 10 on the cylinder r 20,
// centred on the anchor (azimuth 0), pull = +x (the anchor normal). The two circumferential walls become the planes y = +-y0 with
// y0 = r sin(w / 2r); the axial walls stay planes z = 0, 10. Cross-section area between the circles r and r+d for |y| <= y0:
// integral of sqrt(R^2 - y^2) dy = (y sqrt(R^2 - y^2) + R^2 asin(y / R)) / 2.
const F = (R, y) => (y * Math.sqrt(R * R - y * y) + R * R * Math.asin(y / R)) / 2;
const pullCases = [0.5, 1, 2].map((d) => {
  const y0 = r * Math.sin(rect.w / (2 * r));
  const section = 2 * (F(r + d, y0) - F(r, y0));
  const numeric = integrate((y) => Math.sqrt((r + d) ** 2 - y * y) - Math.sqrt(r * r - y * y), -y0, y0, 400);
  return {
    depth: d,
    halfWidthY0: r12(y0),
    volume: r12(section * rect.h),
    normalWallVolume: r12(cylEmboss(d)),
    check: { numericSection: r12(numeric), residual: r12(numeric - section) },
  };
});
// 8. Geodesic on a cylinder between two surface points = straight chart segment: length sqrt((r dtheta)^2 + dz^2).
const geodesics = [
  [1, 10],
  [0.5, 0],
  [2, 5],
].map(([dTheta, dz]) => {
  const L = Math.hypot(r * dTheta, dz);
  const numeric = curveLength((t) => wrapCyl(r, [r * dTheta * t, dz * t]));
  return {
    from: { thetaRad: 0, z: 0 },
    to: { thetaRad: r12(dTheta), z: dz },
    length: r12(L),
    check: { numeric: r12(numeric), residual: r12(numeric - L) },
  };
});
write('pull_and_geodesic.json', {
  generated: 'generate_wrap_refs.mjs',
  radius: r,
  pullDirectionEmboss: { region: 'chart rectangle 30 x 10 centred on azimuth 0, pull +x', cases: pullCases },
  cylinderGeodesics: geodesics,
});

console.warn(
  'wrote data/pull_and_geodesic.json, data/{cylinder_wrap,projection_vs_wrap,cone_development,sphere_geodesic_wrap,emboss_volumes,knurl_cases}.json',
);
