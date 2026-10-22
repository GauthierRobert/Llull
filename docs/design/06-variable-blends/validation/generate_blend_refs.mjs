// BLD analytic reference generator (Node ESM, no dependencies): node generate_blend_refs.mjs
// Writes validation/data/*.json. Every value is a closed form (derivation in the `derivation` fields) or a numerical
// integration of a closed-form geometry, self-checked against an independent closed form (`check` fields).
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'data');
mkdirSync(out, { recursive: true });
const PI = Math.PI;
const r12 = (x) => Number(x.toPrecision(12));
const write = (name, value) => writeFileSync(join(out, name), `${JSON.stringify(value, null, 1)}\n`);

// ---------- quadrature ----------
// Gauss-Legendre nodes/weights on [-1, 1] by Newton iteration on P_n.
function gaussLegendre(n) {
  const nodes = [];
  const weights = [];
  for (let i = 1; i <= n; i++) {
    let x = Math.cos((PI * (i - 0.25)) / (n + 0.5));
    for (let it = 0; it < 100; it++) {
      let p0 = 1;
      let p1 = x;
      for (let k = 2; k <= n; k++) [p0, p1] = [p1, ((2 * k - 1) * x * p1 - (k - 1) * p0) / k];
      const dp = (n * (x * p1 - p0)) / (x * x - 1);
      const dx = p1 / dp;
      x -= dx;
      if (Math.abs(dx) < 1e-16) break;
    }
    let p0 = 1;
    let p1 = x;
    for (let k = 2; k <= n; k++) [p0, p1] = [p1, ((2 * k - 1) * x * p1 - (k - 1) * p0) / k];
    const dp = (n * (x * p1 - p0)) / (x * x - 1);
    nodes.push(x);
    weights.push(2 / ((1 - x * x) * dp * dp));
  }
  return { nodes, weights };
}
const GL = gaussLegendre(64);
/** Composite Gauss-Legendre (64 nodes per panel). */
function integrate(f, a, b, panels = 8) {
  let sum = 0;
  const h = (b - a) / panels;
  for (let p = 0; p < panels; p++) {
    const lo = a + p * h;
    for (let i = 0; i < GL.nodes.length; i++) sum += GL.weights[i] * f(lo + ((GL.nodes[i] + 1) * h) / 2) * (h / 2);
  }
  return sum;
}

// ---------- 1. constant circular fillet on a straight edge between two planes ----------
// Interior (material) wedge angle alpha. Tangent distance t = r cot(alpha/2); removed section area
// A = r t - (pi - alpha) r^2 / 2 = r^2 [cot(alpha/2) - (pi - alpha)/2]. alpha = pi/2 gives (1 - pi/4) r^2.
const filletSectionArea = (r, alpha) => r * r * (1 / Math.tan(alpha / 2) - (PI - alpha) / 2);
const chordToRadius = (c, alpha) => c / (2 * Math.cos(alpha / 2)); // as packages/core/src/commands/brep/filletSpec.ts
const K_CENTROID = (5 / 6 - PI / 4) / (1 - PI / 4); // centroid of the 90 deg removed sliver, distance from the edge / r

const box10 = (() => {
  const a = 10;
  const r = 1;
  const removed = (1 - PI / 4) * r * r * a;
  const area = 6 * a * a - 2 * r * a + (PI / 2) * r * a - 2 * (1 - PI / 4) * r * r;
  return {
    a,
    r,
    volume: r12(a ** 3 - removed),
    area: r12(area),
    oracle: 'tests/oracle/83-fillet-box-one-edge (997.853981634 / 595.278759595)',
  };
})();

const wedgeTable = [30, 45, 60, 90, 120, 135, 150].map((deg) => {
  const alpha = (deg * PI) / 180;
  return {
    wedgeDeg: deg,
    tangentDistancePerR: r12(1 / Math.tan(alpha / 2)),
    chordPerR: r12(2 * Math.cos(alpha / 2)),
    removedAreaPerR2: r12(filletSectionArea(1, alpha)),
  };
});

// Equilateral prism (side 10, depth 10), chord 2 fillet on one 60 deg vertical edge.
const triPrism = (() => {
  const side = 10;
  const depth = 10;
  const alpha = PI / 3;
  const chord = 2;
  const r = chordToRadius(chord, alpha);
  const removed = filletSectionArea(r, alpha) * depth;
  const v0 = (Math.sqrt(3) / 4) * side * side * depth;
  return {
    side,
    depth,
    wedgeDeg: 60,
    chord,
    radius: r12(r),
    removedVolume: r12(removed),
    volumeBefore: r12(v0),
    volumeAfter: r12(v0 - removed),
  };
})();

write('straight_edge_fillets.json', {
  derivation:
    'Circular fillet of radius r between two planes meeting at interior angle alpha along a straight edge: tangent distance t = r cot(alpha/2); removed section = kite r*t minus sector (pi-alpha) r^2/2. Chord between tangent points c = 2 r cos(alpha/2).',
  box10_one_edge_r1: box10,
  wedgeTable,
  triPrism_chord2_60deg: triPrism,
  centroidOffsetPerR_90deg: r12(K_CENTROID),
});

// ---------- 2. variable radius laws ----------
// Section construction (circle of radius r(s) in the plane normal to a straight spine, tangent to both planes): removed volume
// = (1 - pi/4) * integral r(s)^2 ds (Cavalieri). Contact lines lie at distance r(s) from the edge on each planar face in BOTH the
// section construction and the rolling-ball envelope (a sphere of radius r centred at distance r from a plane touches it at the foot
// point), so each planar face loses exactly integral r(s) ds of area: construction-independent.
const linearR2 = (r0, r1, L) => (L * (r0 * r0 + r0 * r1 + r1 * r1)) / 3;
const linearR1 = (r0, r1, L) => (L * (r0 + r1)) / 2;
const piecewiseR2 = (points, L) => {
  let s = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const [t0, a] = points[i];
    const [t1, b] = points[i + 1];
    s += linearR2(a, b, (t1 - t0) * L);
  }
  return s;
};
const piecewiseR1 = (points, L) => {
  let s = 0;
  for (let i = 0; i + 1 < points.length; i++) s += linearR1(points[i][1], points[i + 1][1], (points[i + 1][0] - points[i][0]) * L);
  return s;
};

// Block 20 x 10 x 5 centred at the origin; top long edge (y = +5, z = +2.5) along x, length 20.
const block = { size: [20, 10, 5], volume: 1000, topFaceArea: 200, sideFaceArea: 100, edgeLength: 20 };
const linear = (() => {
  const [r0, r1, L] = [1, 2, block.edgeLength];
  const removed = (1 - PI / 4) * linearR2(r0, r1, L);
  const lost = linearR1(r0, r1, L);
  return {
    r0,
    r1,
    L,
    removedVolume_section: r12(removed),
    volume_section: r12(block.volume - removed),
    topFaceArea: r12(block.topFaceArea - lost),
    sideFaceArea: r12(block.sideFaceArea - lost),
    note: 'face areas are construction-independent (grade A); the volume is exact for the normal-section construction, see envelope_vs_section for the rolling-ball envelope',
  };
})();
const controlPoints = (() => {
  const pts = [
    [0, 1],
    [0.5, 2],
    [1, 1],
  ];
  const L = block.edgeLength;
  return {
    law: pts,
    radiusAtControlPoints: pts.map(([t, r]) => ({ t, radius: r })),
    removedVolume_piecewiseLinear: r12((1 - PI / 4) * piecewiseR2(pts, L)),
    faceAreaLost_piecewiseLinear: r12(piecewiseR1(pts, L)),
    note: 'OCCT Add(TColgp_Array1OfPnt2d) interpolates (smooth); the piecewise-linear figures are the llull `interpolation: "linear"` law only. Radii AT control points are exact for both.',
  };
})();

// Rolling-ball envelope vs section construction, numerically, for the linear law: in the plane z0 the removed region is the part of
// the corner quadrant not covered by the slices of the balls B(c(z), r(z)), c(z) = (-r, -r, z); it is star-shaped from the edge, so
// A(z0) = integral over the quadrant directions of t(theta)^2 / 2, t = first entry distance of the ray into the union of the slices.
function envelopeArea(rOf, z0, zMin, zMax) {
  const ray = (theta) => {
    const u = [Math.cos(theta), Math.sin(theta)];
    let best = Infinity;
    const rMax = Math.max(rOf(zMin), rOf(zMax), rOf(z0)) * 1.01;
    const n = 4000;
    for (let k = 0; k <= n; k++) {
      const z = z0 - rMax + (2 * rMax * k) / n;
      if (z < zMin || z > zMax) continue;
      const r = rOf(z);
      const rho2 = r * r - (z - z0) * (z - z0);
      if (rho2 <= 0) continue;
      const c = [-r, -r];
      const b = u[0] * c[0] + u[1] * c[1];
      const disc = b * b - (c[0] * c[0] + c[1] * c[1]) + rho2;
      if (disc < 0) continue;
      const t = b - Math.sqrt(disc);
      if (t >= 0 && t < best) best = t;
    }
    return best;
  };
  return integrate((theta) => 0.5 * ray(theta) ** 2, PI, 1.5 * PI, 4);
}
const constantCheck = envelopeArea(() => 1, 10, 0, 20);
const rLin = (z) => 1 + 0.05 * z;
const envMid = envelopeArea(rLin, 10, 0, 20);
const secMid = (1 - PI / 4) * rLin(10) ** 2;
write('variable_radius_laws.json', {
  block,
  linear_r1_to_r2: linear,
  controlPoints_1_2_1: controlPoints,
  envelope_vs_section: {
    law: 'r(z) = 1 + 0.05 z on the 20-long edge (slope dr/ds = 0.05)',
    constantRadiusSelfCheck: {
      envelope: r12(constantCheck),
      closedForm: r12(1 - PI / 4),
      relError: r12(Math.abs(constantCheck - (1 - PI / 4)) / (1 - PI / 4)),
    },
    midSpanSectionArea_section: r12(secMid),
    midSpanSectionArea_envelope: r12(envMid),
    relativeDifference: r12((envMid - secMid) / secMid),
    meaning:
      'the two constructions differ by this fraction of removed area at slope 0.05 (grows ~ slope^2); volume VCs on variable fillets use a tolerance that covers it until the native construction is pinned (open question Q2)',
  },
});

// Periodic law around the top rim of a cylinder R = 5 (closed circular edge): r(theta) = r0 + a cos(theta). Meridian sections are
// normal to the circular spine, so V_removed = integral A(theta) * rho_c(theta) d theta exactly (generalised Pappus), A = (1-pi/4) r^2,
// rho_c = R - K r (K = centroid offset / r). Closed form: 2 pi (1-pi/4) [R (r0^2 + a^2/2) - K (r0^3 + 3 r0 a^2 / 2)].
const rim = (() => {
  const [R, h, r0, a] = [5, 10, 1, 0.5];
  const closed = 2 * PI * (1 - PI / 4) * (R * (r0 * r0 + (a * a) / 2) - K_CENTROID * (r0 ** 3 + (3 * r0 * a * a) / 2));
  const numeric = integrate(
    (th) => {
      const r = r0 + a * Math.cos(th);
      return (1 - PI / 4) * r * r * (R - K_CENTROID * r);
    },
    0,
    2 * PI,
    8,
  );
  const constant = 2 * PI * ((R - r0) * (1 - PI / 4) * r0 * r0 + r0 ** 3 / 6);
  const v0 = PI * R * R * h;
  return {
    R,
    h,
    law: 'r(t) = 1 + 0.5 cos(2 pi t), t in [0, 1] along the rim (phase-independent: the volume integrates a full period)',
    removedVolume: r12(closed),
    numericCheck: r12(numeric),
    volumeAfter: r12(v0 - closed),
    constantR1Check: {
      removed: r12(constant),
      volumeAfter: r12(v0 - constant),
      oracle: 'tests/oracle/87-fillet-cylinder-rim 778.95743342',
    },
  };
})();
write('periodic_rim_law.json', rim);

// ---------- 3. conic fillet cross-sections vs rho ----------
// Rational quadratic Bezier A, T, B with weight w = rho / (1 - rho) (Liming shoulder: S = M + rho (T - M)). The ratio
// f(w) = (area between chord AB and the conic) / (area of triangle ATB) is affine-invariant, so it depends on w only:
//   ellipse w = cos(a) < 1: f = (a - sin a cos a) cos a / sin^3 a      (circular arc of half-angle a)
//   parabola w = 1: f = 2/3
//   hyperbola w = cosh(b) > 1: f = (sinh b cosh b - b) cosh b / sinh^3 b
// Removed corner area = Delta (1 - f), Delta = d1 d2 sin(alpha) / 2. A conic fillet sized by "radius r" keeps the circular tangent
// distances d = r cot(alpha/2) (vendors' conic-with-radius); rho = sqrt(2) - 1 at alpha = 90 deg reproduces the circle exactly.
function conicF(w) {
  if (Math.abs(w - 1) < 1e-12) return 2 / 3;
  if (w < 1) {
    const a = Math.acos(w);
    return ((a - Math.sin(a) * Math.cos(a)) * Math.cos(a)) / Math.sin(a) ** 3;
  }
  const b = Math.acosh(w);
  return ((Math.sinh(b) * Math.cosh(b) - b) * Math.cosh(b)) / Math.sinh(b) ** 3;
}
function conicSegmentNumeric(w) {
  // A = (1, 0), T = (0, 0)... use A = (1,0), T = (1,1), B = (0,1): triangle area 1/2; integrate Green over the arc and close by the chord.
  const A = [1, 0];
  const T = [1, 1];
  const B = [0, 1];
  const P = (t) => {
    const b0 = (1 - t) ** 2;
    const b1 = 2 * t * (1 - t) * w;
    const b2 = t * t;
    const s = b0 + b1 + b2;
    return [(b0 * A[0] + b1 * T[0] + b2 * B[0]) / s, (b0 * A[1] + b1 * T[1] + b2 * B[1]) / s];
  };
  const h = 1e-6;
  const arc = integrate(
    (t) => {
      const p = P(t);
      const pa = P(Math.max(0, t - h));
      const pb = P(Math.min(1, t + h));
      const dt = Math.min(1, t + h) - Math.max(0, t - h);
      return 0.5 * (p[0] * ((pb[1] - pa[1]) / dt) - p[1] * ((pb[0] - pa[0]) / dt));
    },
    0,
    1,
    16,
  );
  const chord = 0.5 * (B[0] * A[1] - B[1] * A[0]); // closing segment B -> A
  return (arc + chord) / 0.5;
}
const rhos = [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, Math.SQRT2 - 1, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95];
const conicTable = rhos.map((rho) => {
  const w = rho / (1 - rho);
  const f = conicF(w);
  return {
    rho: r12(rho),
    weight: r12(w),
    type: rho < 0.5 - 1e-12 ? 'ellipse' : rho > 0.5 + 1e-12 ? 'hyperbola' : 'parabola',
    segmentRatio_f: r12(f),
    numericCheck_f: r12(conicSegmentNumeric(w)),
    removedAreaPerD2_90deg: r12(0.5 * (1 - f)),
    shoulderDistanceFromCornerPerD_90deg: r12((1 - rho) * Math.SQRT1_2),
  };
});
const conicBox = (() => {
  // 20 x 10 x 5 block, top long edge, conic with r = 1 (d = 1 at 90 deg), L = 20.
  const L = 20;
  return [0.25, Math.SQRT2 - 1, 0.5, 0.75].map((rho) => {
    const f = conicF(rho / (1 - rho));
    const removed = 0.5 * (1 - f) * L;
    return { rho: r12(rho), removedVolume: r12(removed), volumeAfter: r12(1000 - removed) };
  });
})();
write('conic_sections.json', {
  derivation:
    'w = rho/(1-rho); f(w) = segment/triangle area ratio (affine invariant); removed = Delta (1 - f). Anchors: rho = sqrt2-1 at 90 deg -> (1-pi/4) d^2; rho = 0.5 -> d^2/6.',
  anchors: {
    circle: { rho: r12(Math.SQRT2 - 1), removedAreaPerD2: r12(0.5 * (1 - conicF(Math.SQRT1_2))), closedForm: r12(1 - PI / 4) },
    parabola: { rho: 0.5, removedAreaPerD2: r12(0.5 * (1 - conicF(1))), closedForm: r12(1 / 6) },
  },
  table90deg: conicTable,
  block20x10x5_topEdge_r1: conicBox,
  vendorRhoRange: { solidworksApi: [0.05, 0.95], creo: [0.05, 0.95], onshapeExamples: { ellipse: 0.25, parabola: 0.5, hyperbola: 0.999 } },
});

// ---------- 4. curvature-continuous (G2) section between two planes ----------
// Quartic Bezier P0 = A, P1 = A + k (T - A), P2 = T, P3 = B + k (T - B), P4 = B (T = edge corner, A, B tangent points at distance d).
// P0, P1, P2 collinear on face 1 (and P2, P3, P4 on face 2) => curvature 0 at both ends = the planes' curvature: G2. k in (0, 1) is
// the one shape parameter. Removed area by Green's theorem (the radial face segments through T contribute 0); exact for polynomials.
function quarticSection(k, alphaDeg = 90, d = 1) {
  const alpha = (alphaDeg * PI) / 180;
  const T = [0, 0];
  const A = [-d, 0];
  const B = [-d * Math.cos(alpha), -d * Math.sin(alpha)];
  const P = [A, [A[0] + k * (T[0] - A[0]), A[1] + k * (T[1] - A[1])], T, [B[0] + k * (T[0] - B[0]), B[1] + k * (T[1] - B[1])], B];
  const bern = (t) => [(1 - t) ** 4, 4 * t * (1 - t) ** 3, 6 * t * t * (1 - t) ** 2, 4 * t ** 3 * (1 - t), t ** 4];
  const pt = (t) => bern(t).reduce((acc, b, i) => [acc[0] + b * P[i][0], acc[1] + b * P[i][1]], [0, 0]);
  const d1 = (t) => {
    const Q = [0, 1, 2, 3].map((i) => [4 * (P[i + 1][0] - P[i][0]), 4 * (P[i + 1][1] - P[i][1])]);
    const b = [(1 - t) ** 3, 3 * t * (1 - t) ** 2, 3 * t * t * (1 - t), t ** 3];
    return b.reduce((acc, bi, i) => [acc[0] + bi * Q[i][0], acc[1] + bi * Q[i][1]], [0, 0]);
  };
  const d2 = (t) => {
    const R = [0, 1, 2].map((i) => [12 * (P[i + 2][0] - 2 * P[i + 1][0] + P[i][0]), 12 * (P[i + 2][1] - 2 * P[i + 1][1] + P[i][1])]);
    const b = [(1 - t) ** 2, 2 * t * (1 - t), t * t];
    return b.reduce((acc, bi, i) => [acc[0] + bi * R[i][0], acc[1] + bi * R[i][1]], [0, 0]);
  };
  const kappa = (t) => {
    const v = d1(t);
    const a = d2(t);
    return Math.abs(v[0] * a[1] - v[1] * a[0]) / Math.hypot(v[0], v[1]) ** 3;
  };
  const area = Math.abs(
    integrate(
      (t) => {
        const p = pt(t);
        const v = d1(t);
        return 0.5 * (p[0] * v[1] - p[1] * v[0]);
      },
      0,
      1,
      2,
    ),
  );
  let kMax = 0;
  for (let i = 0; i <= 2000; i++) kMax = Math.max(kMax, kappa(i / 2000));
  return { area, k0: kappa(0), k1: kappa(1), kMid: kappa(0.5), kMax };
}
const g2Table = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8].map((k) => {
  const s = quarticSection(k);
  return {
    shapeK: k,
    removedAreaPerD2_90deg: r12(s.area),
    endCurvatureTimesD: [r12(s.k0), r12(s.k1)],
    midCurvatureTimesD: r12(s.kMid),
    maxCurvatureTimesD: r12(s.kMax),
  };
});
const circleArea = 1 - PI / 4;
write('g2_sections.json', {
  derivation:
    'Quartic Bezier [A, A+k(T-A), T, B+k(T-B), B] between two planes: curvature 0 at both contacts (G2 to planes). Circular fillet with the same tangent distance d (r = d at 90 deg) has curvature 1/r at contact: a G2 jump of 1/r (relative jump 1) - it is G1 only.',
  circularReference_90deg: { removedAreaPerD2: r12(circleArea), contactCurvatureTimesD: 1, g2RelativeJump: 1 },
  quartic90deg: g2Table,
  block20x10x5_topEdge_d1_k05: {
    removedVolume: r12(quarticSection(0.5).area * 20),
    volumeAfter: r12(1000 - quarticSection(0.5).area * 20),
  },
  wedge60deg_k05: {
    removedAreaPerD2: r12(quarticSection(0.5, 60).area),
    endCurvatureTimesD: [r12(quarticSection(0.5, 60).k0), r12(quarticSection(0.5, 60).k1)],
  },
});

// ---------- 5. corners: rolling ball vs setback ----------
// Cube a, all 12 edges r: removed = 12 (1-pi/4) r^2 (a-2r) + 8 (1 - pi/6) r^3 (each corner: cube r^3 minus a sphere octant).
const cube = (() => {
  const [a, r] = [10, 1];
  const edges = 12 * (1 - PI / 4) * r * r * (a - 2 * r);
  const corners = 8 * (1 - PI / 6) * r ** 3;
  const steiner = (a - 2 * r) ** 3 + 2 * r * 3 * (a - 2 * r) ** 2 + PI * r * r * 3 * (a - 2 * r) + (4 / 3) * PI * r ** 3;
  return {
    a,
    r,
    removedEdges: r12(edges),
    removedCorners_rollingBall: r12(corners),
    volume_rollingBall: r12(a ** 3 - edges - corners),
    steinerCheck: r12(steiner),
    oracle: 'tests/oracle/85-fillet-cube-all-edges 975.587013891',
  };
})();
const setback = (() => {
  const [a, r, s] = [10, 1, 2];
  return {
    a,
    r,
    setback: s,
    cylinderFaceSpanPerEdge: a - 2 * s,
    rollingBallSpanPerEdge: a - 2 * r,
    edgeBlendVolumeOutsideCorners: r12(12 * (1 - PI / 4) * r * r * (a - 2 * s)),
    cornerVolume: 'TBD - measure with check_blends + mass_properties (N-sided fill has no closed form)',
    bound:
      'the corner patch replaces material only inside the cube of side s at each vertex: volume_after in [a^3 - edgesOutside - 8 s^3, a^3 - edgesOutside]',
    volumeBounds: [
      r12(a ** 3 - 12 * (1 - PI / 4) * r * r * (a - 2 * s) - 8 * s ** 3),
      r12(a ** 3 - 12 * (1 - PI / 4) * r * r * (a - 2 * s)),
    ],
  };
})();
write('corner_blends.json', {
  derivation: 'Steiner decomposition of the all-edge fillet; setback span is exact by definition',
  cube_all_edges_r1: cube,
  cube_setback_s2: setback,
});

// ---------- 6. face-face fillet across a chamfer, full round, hold line ----------
// Chamfer of leg c on a 90 deg edge, then a face-face fillet r between the two original planes consuming the chamfer face. The arc
// stays inside the chamfered material iff r (sqrt2 - 1) >= c / sqrt2  <=>  r >= c / (2 - sqrt2).
const faceFace = (() => {
  const [c, r, L] = [1, 2, 10];
  const v0 = 1000;
  const chamfered = v0 - (c * c * L) / 2;
  const after = v0 - (1 - PI / 4) * r * r * L;
  return {
    part: 'extrude_profile square 10 x 10 (centred) with the (+5, +5) corner chamfered by c = 1, depth 10',
    chamferLeg: c,
    radius: r,
    depth: L,
    volumeChamfered: r12(chamfered),
    volumeAfterFaceFillet: r12(after),
    removedFromChamfered: r12(chamfered - after),
    minimumRadius: r12(c / (2 - Math.SQRT2)),
    refusalExample: { radius: 1.5, expected: 'refused: arc would cut the chamfer face (r < c/(2-sqrt2) = 1.70711)' },
  };
})();
const fullRound = (() => {
  const [t, H, L] = [4, 10, 20];
  const removed = ((t * t) / 2) * (1 - PI / 4) * L;
  return {
    part: 'extrude_profile rectangle x in [-2, 2], y in [0, 10], depth 20: full round of the top face y = 10 between the faces x = -2 and x = +2',
    thickness: t,
    height: H,
    length: L,
    radius: t / 2,
    volumeBefore: t * H * L,
    removedVolume: r12(removed),
    volumeAfter: r12(t * H * L - removed),
    topFaceAfter: 'consumed (0 faces named <rib>:top remain)',
    cylinderFace: { radius: t / 2, area: r12(PI * (t / 2) * L) },
  };
})();
const holdLine = [30, 60, 90, 120].map((deg) => ({
  wedgeDeg: deg,
  radiusPerHoldDistance: r12(Math.tan((deg * PI) / 180 / 2)),
  derivation: 'hold line at distance h from the edge on one face = tangent distance t = r cot(alpha/2) => r = h tan(alpha/2)',
}));
write('face_fillets.json', { faceFaceAcrossChamfer: faceFace, fullRoundRib: fullRound, holdLineRadius: holdLine });

// ---------- 7. chamfers ----------
const chamfer = (() => {
  const area = (d1, d2, alpha) => 0.5 * d1 * d2 * Math.sin(alpha);
  const distAngleLeg2 = (d, phi, alpha) => (d * Math.sin(phi)) / Math.sin(PI - alpha - phi);
  const alpha = PI / 2;
  return {
    symmetric_d1_box10: { d: 1, volumeAfter: r12(1000 - area(1, 1, alpha) * 10), oracle: 'tests/oracle/88-chamfer-box-one-edge 995' },
    asymmetric_1x2_box10: { d1: 1, d2: 2, removed: r12(area(1, 2, alpha) * 10), volumeAfter: r12(1000 - area(1, 2, alpha) * 10) },
    distanceAngle_1_30deg_box10: {
      d: 1,
      angleDeg: 30,
      angleMeasured: 'on the face carrying d, between that face and the chamfer face',
      leg2: r12(distAngleLeg2(1, PI / 6, alpha)),
      volumeAfter: r12(1000 - area(1, distAngleLeg2(1, PI / 6, alpha), alpha) * 10),
    },
    variableLinear_1to2_block20: {
      edgeLength: 20,
      d0: 1,
      d1: 2,
      removed: r12(0.5 * linearR2(1, 2, 20)),
      volumeAfter: r12(1000 - 0.5 * linearR2(1, 2, 20)),
      note: 'section construction, as for fillets',
    },
  };
})();
write('chamfers.json', chamfer);

// ---------- 8. probe limits ----------
write('probe_limits.json', {
  block20x10x5_topLongEdge: {
    geometricUpperBound: 5,
    why: 'the tangent line on the 5-high side face sits r below the top; r >= 5 leaves no side face (and r >= 10 none of the top face)',
    kernelLimit: 'TBD - measure with probe_fillet (bisection, tolerance 1e-3)',
  },
  fullRoundRib_t4: {
    twoEdgeFilletUpperBound: 2,
    why: 'two fillets r on both top edges of a 4-wide face meet at r = 2 (the top face vanishes)',
  },
});

// ---------- 9. extra cases: asymmetric conic (ellipse quarter) and a steeper law for the construction probe ----------
// D1 x D2 conic with rho = sqrt2 - 1 is the affine image of the circular quarter: an elliptic quarter with semi-axes d1, d2.
// Removed = Delta (1 - f(sqrt2/2)) = (d1 d2 / 2)(2 - pi/2) = (1 - pi/4) d1 d2 at 90 deg.
const asymConic = (() => {
  const [d1, d2, L] = [1, 2, 20];
  const removed = 0.5 * d1 * d2 * (1 - conicF(Math.SQRT1_2)) * L;
  return {
    d1,
    d2,
    rho: r12(Math.SQRT2 - 1),
    removedVolume: r12(removed),
    closedForm: r12((1 - PI / 4) * d1 * d2 * L),
    volumeAfter: r12(1000 - removed),
  };
})();
// Construction probe: r(z) = 1 + 0.1 z on the 20-long edge (1 -> 3). Section construction vs the rolling-ball envelope (law extended
// linearly beyond the ends so the end sections are not starved of balls).
const probe = (() => {
  const rOf = (z) => 1 + 0.1 * z;
  const section = (1 - PI / 4) * linearR2(1, 3, 20);
  let env = 0;
  const n = 40;
  for (let i = 0; i <= n; i++) {
    const z0 = (20 * i) / n;
    const w = i === 0 || i === n ? 1 : i % 2 === 1 ? 4 : 2;
    env += w * envelopeArea(rOf, z0, -10, 30);
  }
  env *= 20 / n / 3;
  return {
    law: 'r(z) = 1 + 0.1 z, z in [0, 20] (block 20 x 10 x 5, top long edge)',
    removed_section: r12(section),
    removed_envelope: r12(env),
    volume_section: r12(1000 - section),
    volume_envelope: r12(1000 - env),
    relativeDifferenceOfRemoved: r12((env - section) / section),
    faceAreasExact: { top: r12(200 - linearR1(1, 3, 20)), side: r12(100 - linearR1(1, 3, 20)) },
  };
})();
write('extra_cases.json', { asymmetricConic_1x2_block20: asymConic, constructionProbe_r1to3: probe });

const say = (...parts) => process.stdout.write(`${parts.join(' ')}\n`);
say('wrote data/*.json');
say(
  'envelope self-check rel error',
  Math.abs(constantCheck - (1 - PI / 4)) / (1 - PI / 4),
  '| envelope vs section at mid-span',
  (envMid - secMid) / secMid,
);
