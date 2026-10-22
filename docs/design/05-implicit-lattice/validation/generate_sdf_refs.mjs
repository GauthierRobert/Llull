// IMP validation — analytic SDF references: primitive exactness, smooth-min bounds, smooth union of two orthogonal half-spaces,
// onion shell. Node ESM, no dependencies. Run: node generate_sdf_refs.mjs  ->  data/sdf_primitives.json, data/smooth_min.json
// Convention (TECHNICAL_SPEC §5.1): signed distance, NEGATIVE inside, positive outside, document length units.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = (name, value) => writeFileSync(path.join(here, 'data', name), JSON.stringify(value, null, 1) + '\n');
const r6 = (x) => Number(x.toPrecision(12));

// Deterministic LCG so the sample points are reproducible (AF-13).
let seed = 20261022;
const rand = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
const len = (v) => Math.hypot(...v);

// ---- primitives (closed-form SDFs) ----
const sdSphere = (p, R) => len(p) - R;
const sdTorus = (p, Rr, r) => Math.hypot(Math.hypot(p[0], p[1]) - Rr, p[2]) - r; // ring in XY, axis Z (llull add_torus)
const sdBox = (p, h) => {
  const q = p.map((c, i) => Math.abs(c) - h[i]);
  return len(q.map((c) => Math.max(c, 0))) + Math.min(Math.max(q[0], q[1], q[2]), 0);
};
const sdCapsule = (p, a, b, r) => {
  const pa = p.map((c, i) => c - a[i]);
  const ba = b.map((c, i) => c - a[i]);
  const h = Math.min(1, Math.max(0, pa.reduce((s, c, i) => s + c * ba[i], 0) / ba.reduce((s, c) => s + c * c, 0)));
  return len(pa.map((c, i) => c - ba[i] * h)) - r;
};

// Brute-force reference: unsigned distance to a dense sample of the boundary surface, then the sign from the closed-form inside test.
// Independent of the closed-form SDF, so agreement proves exactness (to the sampling resolution).
function bruteDistance(p, surfacePoints) {
  let best = Infinity;
  for (const s of surfacePoints) best = Math.min(best, (p[0] - s[0]) ** 2 + (p[1] - s[1]) ** 2 + (p[2] - s[2]) ** 2);
  return Math.sqrt(best);
}
function sphereSurface(R, n) {
  const pts = [];
  for (let i = 0; i < n; i += 1)
    for (let j = 0; j < 2 * n; j += 1) {
      const th = (Math.PI * (i + 0.5)) / n;
      const ph = (Math.PI * j) / n;
      pts.push([R * Math.sin(th) * Math.cos(ph), R * Math.sin(th) * Math.sin(ph), R * Math.cos(th)]);
    }
  return pts;
}
function torusSurface(Rr, r, n) {
  const pts = [];
  for (let i = 0; i < 2 * n; i += 1)
    for (let j = 0; j < n; j += 1) {
      const u = (Math.PI * i) / n;
      const v = (2 * Math.PI * j) / n;
      pts.push([(Rr + r * Math.cos(v)) * Math.cos(u), (Rr + r * Math.cos(v)) * Math.sin(u), r * Math.sin(v)]);
    }
  return pts;
}
function boxSurface(h, n) {
  const pts = [];
  for (let axis = 0; axis < 3; axis += 1)
    for (const sgn of [-1, 1])
      for (let i = 0; i <= n; i += 1)
        for (let j = 0; j <= n; j += 1) {
          const p = [0, 0, 0];
          const [u, w] = [(axis + 1) % 3, (axis + 2) % 3];
          p[axis] = sgn * h[axis];
          p[u] = -h[u] + (2 * h[u] * i) / n;
          p[w] = -h[w] + (2 * h[w] * j) / n;
          pts.push(p);
        }
  return pts;
}

const cases = [];
const sampleCase = (name, params, sdf, surface, spacing, box) => {
  const samples = [];
  let maxErr = 0;
  let maxGradErr = 0;
  for (let k = 0; k < 40; k += 1) {
    const p = box.map((b) => (rand() * 2 - 1) * b);
    const d = sdf(p);
    const ref = Math.sign(d) * bruteDistance(p, surface);
    maxErr = Math.max(maxErr, Math.abs(d - ref));
    // |grad| = 1 almost everywhere for an exact SDF (central difference, step 1e-5)
    const e = 1e-5;
    const g = [0, 1, 2].map((i) => {
      const a = p.slice();
      const b = p.slice();
      a[i] += e;
      b[i] -= e;
      return (sdf(a) - sdf(b)) / (2 * e);
    });
    maxGradErr = Math.max(maxGradErr, Math.abs(len(g) - 1));
    if (k < 12) samples.push({ p: p.map(r6), distance: r6(d) });
  }
  cases.push({
    name,
    params,
    samples,
    bruteForceSurfaceSpacing: r6(spacing),
    maxAbsDeviationFromBruteForce: r6(maxErr),
    note: 'deviation is bounded by the brute-force surface sampling (≈ spacing²/(8·radius of curvature) on curved parts, spacing/2 worst case on flats); closed form is exact',
    maxAbsGradientNormMinusOne: r6(maxGradErr),
  });
};
sampleCase('sphere', { R: 10 }, (p) => sdSphere(p, 10), sphereSurface(10, 400), (Math.PI * 10) / 400, [20, 20, 20]);
sampleCase('torus', { ringRadius: 5, tubeRadius: 2 }, (p) => sdTorus(p, 5, 2), torusSurface(5, 2, 400), (2 * Math.PI * 2) / 400, [9, 9, 4]);
sampleCase('box', { halfSize: [3, 2, 1] }, (p) => sdBox(p, [3, 2, 1]), boxSurface([3, 2, 1], 600), 6 / 600, [6, 5, 4]);
sampleCase(
  'capsule',
  { a: [0, 0, -4], b: [0, 0, 4], radius: 1.5 },
  (p) => sdCapsule(p, [0, 0, -4], [0, 0, 4], 1.5),
  (() => {
    const pts = [];
    const n = 300;
    for (let i = 0; i <= n; i += 1)
      for (let j = 0; j < n; j += 1) {
        const z = -4 + (8 * i) / n;
        const t = (2 * Math.PI * j) / n;
        pts.push([1.5 * Math.cos(t), 1.5 * Math.sin(t), z]);
      }
    for (const s of sphereSurface(1.5, 200)) if (s[2] > 0) pts.push([s[0], s[1], s[2] + 4]);
    for (const s of sphereSurface(1.5, 200)) if (s[2] < 0) pts.push([s[0], s[1], s[2] - 4]);
    return pts;
  })(),
  8 / 300,
  [4, 4, 7],
);

// Analytic volumes of the primitives (used by mesh convergence VC-IMP-20/21).
const volumes = {
  sphere_R10: { value: r6((4 / 3) * Math.PI * 1000), formula: '4/3 π R³' },
  torus_5_2: { value: r6(2 * Math.PI ** 2 * 5 * 4), formula: '2 π² R r²' },
  box_6x4x2: { value: 48, formula: '8 hx hy hz' },
  capsule_r1p5_l8: { value: r6(Math.PI * 1.5 ** 2 * 8 + (4 / 3) * Math.PI * 1.5 ** 3), formula: 'π r² L + 4/3 π r³' },
};
const areas = {
  sphere_R10: { value: r6(4 * Math.PI * 100), formula: '4 π R²' },
  torus_5_2: { value: r6(4 * Math.PI ** 2 * 5 * 2), formula: '4 π² R r' },
  box_6x4x2: { value: 2 * (6 * 4 + 6 * 2 + 4 * 2), formula: '2(ab+ac+bc)' },
};

// Offset / onion: offset of an exact SDF by d is exact (sphere R -> R+d); onion |f| - t/2 gives a shell of thickness t centred on the surface.
const onion = {
  sphere_R10_shell_t2: {
    innerRadius: 9,
    outerRadius: 11,
    volume: r6((4 / 3) * Math.PI * (11 ** 3 - 9 ** 3)),
    formula: 'onion(f, t) = |f| − t/2 ; V = 4/3 π ((R+t/2)³ − (R−t/2)³)',
  },
  sphere_R10_inner_shell_t2: {
    note: 'shell inward (side: inside) = max(f, −f − t) : radii 8..10',
    volume: r6((4 / 3) * Math.PI * (10 ** 3 - 8 ** 3)),
  },
};

out('sdf_primitives.json', {
  generated: 'generate_sdf_refs.mjs',
  convention: 'signed distance, negative inside, document units',
  cases,
  volumes,
  areas,
  onion,
});

// ---- smooth minimum ----
// Quadratic polynomial smooth min (Quilez form): h = max(k − |a − b|, 0)/k ; smin = min(a,b) − h² k / 4.
// Exponential: smin = −k ln(e^{−a/k} + e^{−b/k}).  Circular-ish "round" (Quilez/hg_sdf opUnionRound) omitted.
const sminQuad = (a, b, k) => {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - (h * h * k) / 4;
};
const sminExp = (a, b, k) => -k * Math.log(Math.exp(-a / k) + Math.exp(-b / k));
const grid = [];
let maxDevQ = 0;
let maxDevE = 0;
let maxLipQ = 0;
const k = 1;
for (let i = -40; i <= 40; i += 1)
  for (let j = -40; j <= 40; j += 1) {
    const a = i * 0.05;
    const b = j * 0.05;
    maxDevQ = Math.max(maxDevQ, Math.min(a, b) - sminQuad(a, b, k));
    maxDevE = Math.max(maxDevE, Math.min(a, b) - sminExp(a, b, k));
    // gradient wrt (a,b): convex weights => |∂/∂a| + |∂/∂b| = 1 ; check numerically
    const e = 1e-6;
    const da = (sminQuad(a + e, b, k) - sminQuad(a - e, b, k)) / (2 * e);
    const db = (sminQuad(a, b + e, k) - sminQuad(a, b - e, k)) / (2 * e);
    maxLipQ = Math.max(maxLipQ, Math.abs(da) + Math.abs(db));
    if (i % 10 === 0 && j % 10 === 0)
      grid.push({ a: r6(a), b: r6(b), quadratic: r6(sminQuad(a, b, k)), exponential: r6(sminExp(a, b, k)) });
  }

// Smooth union of the two half-spaces x < 0 and y < 0 (f = x, g = y) with the quadratic smin of width k:
// boundary min(x, y) = (k − |x − y|)²/(4k) inside the band |x − y| < k. Closed form:
//   * the blend leaves the faces tangentially at distance k from the edge (h = 0 at |x − y| = k);
//   * on the bisector x = y = d: d − k/4 = 0  ->  d = k/4 ;
//   * profile (x ≤ y, band): x = (k − (y − x))²/(4k)  — a parabolic arc (not circular).
//   An equal-setback circular fillet of radius k passes the bisector at d = k (1 − 1/√2) ≈ 0.292893 k.
const profile = [];
const kk = 2;
for (let s = 0; s <= 20; s += 1) {
  // parametrise by u = y − x in [0, k]; then x = (k − u)²/(4k), y = x + u
  const u = (kk * s) / 20;
  const x = (kk - u) ** 2 / (4 * kk);
  profile.push({ x: r6(x), y: r6(x + u), residual: r6(sminQuad(x, x + u, kk)) });
}
out('smooth_min.json', {
  generated: 'generate_sdf_refs.mjs',
  definitions: {
    quadratic: 'h = max(k − |a − b|, 0)/k ; smin = min(a, b) − h²·k/4',
    exponential: 'smin = −k·ln(exp(−a/k) + exp(−b/k))',
    smoothUnion: 'union(f, g) = smin(f, g, k) ; smoothIntersect(f, g) = −smin(−f, −g, k) ; smoothSubtract(f, g) = −smin(−f, g, k)',
  },
  bounds: {
    quadraticMaxDeviation: { value: k / 4, measured: r6(maxDevQ), k, derivation: 'h ≤ 1 so min − smin = h²k/4 ≤ k/4, equality at a = b' },
    exponentialMaxDeviation: {
      value: r6(k * Math.LN2),
      measured: r6(maxDevE),
      k,
      derivation: 'at a = b: min − smin = k ln 2 (maximum of k ln(1 + e^{−|a−b|/k}))',
    },
    quadraticLipschitzSum: {
      value: 1,
      measured: r6(maxLipQ),
      derivation:
        '∂smin/∂a = 1 − w, ∂smin/∂b = w with w ∈ [0,1] ⇒ smooth union of 1-Lipschitz fields stays 1-Lipschitz (a valid distance BOUND, not exact)',
    },
  },
  orthogonalHalfSpaces: {
    k: kk,
    tangentSetback: kk,
    bisectorDistance: kk / 4,
    circularFilletSameSetbackBisectorDistance: r6(kk * (1 - 1 / Math.SQRT2)),
    addedAreaPerUnitLength: r6((kk * kk) / 6),
    addedAreaDerivation:
      'corner x>0, y>0; by symmetry 2× the half x ≤ y; with u = y − x (unit Jacobian) the region is 0 < x < (k − u)²/(4k), u ∈ [0, k]: A = 2∫₀^k (k − u)²/(4k) du = k²/6',
    profile,
  },
  grid,
});

// Check the added-area closed form numerically: region {x>0, y>0, smin(x,y,k) < 0}.
{
  let count = 0;
  const n = 4000;
  const step = kk / n;
  for (let i = 0; i < n; i += 1) for (let j = 0; j < n; j += 1) if (sminQuad((i + 0.5) * step, (j + 0.5) * step, kk) < 0) count += 1;
  const area = count * step * step;
  const data = JSON.parse(JSON.stringify({ measuredAddedArea: r6(area), closedForm: r6((kk * kk) / 6) }));
  writeFileSync(path.join(here, 'data', 'smooth_union_corner_area.json'), JSON.stringify(data, null, 1) + '\n');
}
process.stdout.write('sdf refs written\n');
