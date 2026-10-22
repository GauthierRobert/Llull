// Reference Catmull-Clark subdivision (closed 2-manifold cages, any n-gons) with DeRose-style semi-sharp creases, written from the
// OpenSubdiv Sdc rules (catmarkScheme.h masks, crease.cpp rule / fractional-weight logic; see sources.md S3, S4) and checked against
// llull's own rules (packages/core/src/geometry/subdivision.ts: same smooth / crease / corner masks for sharpness 0 and infinity).
// Pure ESM, no dependencies. Imported by the generate_*.mjs scripts of this pack.

export const SHARP_INFINITE = 10; // OpenSubdiv Crease::SHARPNESS_INFINITE

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const centroid = (pts) => mul(pts.reduce(add, [0, 0, 0]), 1 / pts.length);
export const vec = { add, sub, mul, dot, cross, norm, centroid };

export const edgeKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);

/** Child sharpness after one uniform step (OpenSubdiv decrementSharpness). */
const decrement = (s) => (s >= SHARP_INFINITE ? SHARP_INFINITE : s > 1 ? s - 1 : 0);

/** Edge table of a cage: key -> { a, b, faces, sharpness }. `sharpness` maps edgeKey -> value (absent = 0). */
function edgeTable(cage) {
  const edges = new Map();
  cage.faces.forEach((face, f) =>
    face.forEach((a, i) => {
      const b = face[(i + 1) % face.length];
      const key = edgeKey(a, b);
      const e = edges.get(key) ?? { a, b, faces: [], s: cage.sharpness?.get(key) ?? 0 };
      e.faces.push(f);
      edges.set(key, e);
    }),
  );
  return edges;
}

/** Vertex rule from the number of sharp incident edges (OpenSubdiv DetermineVertexVertexRule): 0,1 smooth/dart, 2 crease, >2 corner. */
const ruleOf = (sharpCount) => (sharpCount > 2 ? 'corner' : sharpCount === 2 ? 'crease' : 'smooth');

/** One Catmull-Clark step. Returns the refined cage (quads), with child sharpness. */
export function subdivideOnce(cage) {
  const { vertices, faces } = cage;
  const edges = edgeTable(cage);
  const edgeList = [...edges.values()];
  const edgeIndex = new Map(edgeList.map((e, i) => [edgeKey(e.a, e.b), i]));
  const facePoints = faces.map((face) => centroid(face.map((v) => vertices[v])));
  const edgePoints = edgeList.map((e) => {
    const sharp = centroid([vertices[e.a], vertices[e.b]]);
    const smooth = centroid([vertices[e.a], vertices[e.b], ...e.faces.map((f) => facePoints[f])]);
    if (e.s >= 1) return sharp;
    if (e.s <= 0) return smooth;
    return add(mul(sharp, e.s), mul(smooth, 1 - e.s));
  });
  const incident = vertices.map(() => []);
  const adjacentFaces = vertices.map(() => []);
  for (const e of edgeList) {
    incident[e.a].push(e);
    incident[e.b].push(e);
  }
  faces.forEach((face, f) => face.forEach((v) => adjacentFaces[v].push(f)));
  const position = (v, rule, sharpEdges) => {
    const p = vertices[v];
    if (rule === 'corner') return p;
    if (rule === 'crease') {
      const [x, y] = sharpEdges.map((e) => vertices[e.a === v ? e.b : e.a]);
      return mul(add(add(mul(p, 6), x), y), 1 / 8);
    }
    const around = incident[v];
    const n = around.length;
    const q = centroid(adjacentFaces[v].map((f) => facePoints[f]));
    const r = centroid(around.map((e) => centroid([vertices[e.a], vertices[e.b]])));
    return mul(add(add(q, mul(r, 2)), mul(p, n - 3)), 1 / n);
  };
  const vertexPoints = vertices.map((p, v) => {
    const parentSharp = incident[v].filter((e) => e.s > 0);
    const childSharp = incident[v].filter((e) => decrement(e.s) > 0);
    const parentRule = ruleOf(parentSharp.length);
    const childRule = ruleOf(childSharp.length);
    const parentPos = position(v, parentRule, parentSharp);
    if (parentRule === childRule) return parentPos;
    // Fractional weight: mean parent sharpness of the edges that become smooth (each <= 1), clamped to 1 (crease.cpp).
    const transitions = parentSharp.filter((e) => decrement(e.s) <= 0);
    const w = Math.min(1, transitions.reduce((sum, e) => sum + e.s, 0) / Math.max(1, transitions.length));
    const childPos = position(v, childRule, childSharp);
    return add(mul(parentPos, w), mul(childPos, 1 - w));
  });
  const edgeBase = vertices.length;
  const faceBase = edgeBase + edgeList.length;
  const ev = (a, b) => edgeBase + edgeIndex.get(edgeKey(a, b));
  // Same quad order as llull subdivision.ts: [v, edge(v,next), face, edge(prev,v)].
  const quads = faces.flatMap((face, f) =>
    face.map((v, i) => [v, ev(v, face[(i + 1) % face.length]), faceBase + f, ev(face[(i - 1 + face.length) % face.length], v)]),
  );
  const sharpness = new Map();
  for (const e of edgeList) {
    const child = decrement(e.s);
    if (child <= 0) continue;
    const m = ev(e.a, e.b);
    sharpness.set(edgeKey(e.a, m), child);
    sharpness.set(edgeKey(m, e.b), child);
  }
  return { vertices: [...vertexPoints, ...edgePoints, ...facePoints], faces: quads, sharpness };
}

export function subdivide(cage, levels) {
  let c = cage;
  for (let i = 0; i < levels; i++) c = subdivideOnce(c);
  return c;
}

/** Signed volume of a closed outward cage, quads/n-gons fanned from their first vertex (llull subdivisionTriangles). */
export function meshVolume(cage) {
  let v6 = 0;
  for (const face of cage.faces)
    for (let k = 1; k + 1 < face.length; k++) v6 += dot(cage.vertices[face[0]], cross(cage.vertices[face[k]], cage.vertices[face[k + 1]]));
  return v6 / 6;
}

/** 1-ring of vertex v in a quad-only cage: ordered edge neighbours e[i] and diagonal (face-opposite) vertices f[i]. */
export function oneRing(cage, v) {
  const out = new Map(); // next vertex after v in each face -> face
  cage.faces.forEach((face, f) => {
    const k = face.indexOf(v);
    if (k >= 0) out.set(face[(k + 1) % 4], f);
  });
  const e = [];
  const d = [];
  let start = out.keys().next().value;
  let w = start;
  do {
    const face = cage.faces[out.get(w)];
    const k = face.indexOf(v);
    e.push(face[(k + 1) % 4]);
    d.push(face[(k + 2) % 4]);
    w = face[(k + 3) % 4];
  } while (w !== start && e.length <= out.size);
  return { e, d };
}

/** Smooth limit position (catmarkScheme assignSmoothLimitMask): (n^2 v + 4 sum e + sum f) / (n (n + 5)). */
export function smoothLimit(cage, v) {
  const { e, d } = oneRing(cage, v);
  const n = e.length;
  const fw = 1 / (n * (n + 5));
  const ew = 4 * fw;
  const vw = 1 - n * (ew + fw);
  let p = mul(cage.vertices[v], vw);
  for (let i = 0; i < n; i++) p = add(p, add(mul(cage.vertices[e[i]], ew), mul(cage.vertices[d[i]], fw)));
  return { point: p, weights: { vertex: vw, edge: ew, face: fw }, valence: n };
}

/** Subdominant eigenvalue lambda(n) used by the OpenSubdiv smooth limit tangent masks. */
export const lambdaOf = (n) => {
  const t = (2 * Math.PI) / n;
  return 5 / 16 + (Math.cos(t) + Math.cos(t / 2) * Math.sqrt(2 * (9 + Math.cos(t)))) / 16;
};

/** Smooth limit tangents (catmarkScheme assignSmoothLimitTangentMasks) and the limit normal. */
export function smoothLimitTangents(cage, v) {
  const { e, d } = oneRing(cage, v);
  const n = e.length;
  const t = (2 * Math.PI) / n;
  const lam = lambdaOf(n);
  const tangent = (shift) => {
    let s = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      const j = (i + shift) % n;
      const ew = n === 4 ? [4, 0, -4, 0][i] : 4 * Math.cos(i * t);
      const fw = n === 4 ? [1, -1, -1, 1][i] : (Math.cos(i * t) + Math.cos((i + 1) * t)) / (4 * lam - 1);
      s = add(s, add(mul(cage.vertices[e[j]], ew), mul(cage.vertices[d[j]], fw)));
    }
    return s;
  };
  const t1 = tangent(0);
  const t2 = tangent(1);
  const nrm = cross(t1, t2);
  return { t1, t2, normal: mul(nrm, 1 / norm(nrm)), lambda: lam };
}

/** Uniform cubic B-spline basis at t in [0,1] (the regular Catmull-Clark patch, Stam S5: regular part = bicubic B-spline). */
export const bsplineBasis = (t) => [
  (1 - t) ** 3 / 6,
  (3 * t ** 3 - 6 * t ** 2 + 4) / 6,
  (-3 * t ** 3 + 3 * t ** 2 + 3 * t + 1) / 6,
  t ** 3 / 6,
];

/** Cages used by the cases (local coordinates, faces counter-clockwise seen from outside, like llull boxCage / cylinderCage). */
export function cubeCage(half = 1) {
  const h = half;
  const vertices = [
    [-h, -h, -h],
    [h, -h, -h],
    [h, h, -h],
    [-h, h, -h],
    [-h, -h, h],
    [h, -h, h],
    [h, h, h],
    [-h, h, h],
  ];
  const faces = [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [2, 3, 7, 6],
    [1, 2, 6, 5],
    [0, 4, 7, 3],
  ];
  return { vertices, faces, sharpness: new Map() };
}

export function prismCage(sides, radius = 1, height = 2) {
  const vertices = [];
  for (let k = 0; k <= 1; k++)
    for (let i = 0; i < sides; i++) {
      const a = (2 * Math.PI * i) / sides;
      vertices.push([radius * Math.cos(a), radius * Math.sin(a), (k - 0.5) * height]);
    }
  const at = (k, i) => k * sides + (i % sides);
  const faces = [];
  for (let i = 0; i < sides; i++) faces.push([at(0, i), at(0, i + 1), at(1, i + 1), at(1, i)]);
  faces.push(Array.from({ length: sides }, (_, i) => at(1, i)));
  faces.push(Array.from({ length: sides }, (_, i) => at(0, sides - 1 - i)));
  return { vertices, faces, sharpness: new Map() };
}

/** Fully regular torus cage: nu x nv quads, every vertex valence 4 (major radius R, minor r). */
export function torusCage(nu, nv, R = 3, r = 1) {
  const vertices = [];
  for (let i = 0; i < nu; i++)
    for (let j = 0; j < nv; j++) {
      const u = (2 * Math.PI * i) / nu;
      const w = (2 * Math.PI * j) / nv;
      vertices.push([(R + r * Math.cos(w)) * Math.cos(u), (R + r * Math.cos(w)) * Math.sin(u), r * Math.sin(w)]);
    }
  const at = (i, j) => (((i % nu) + nu) % nu) * nv + (((j % nv) + nv) % nv);
  const faces = [];
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) faces.push([at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)]);
  return { vertices, faces, sharpness: new Map(), at };
}

export function withAllEdgesSharp(cage, s) {
  const sharpness = new Map();
  cage.faces.forEach((face) => face.forEach((a, i) => sharpness.set(edgeKey(a, face[(i + 1) % face.length]), s)));
  return { ...cage, sharpness };
}

/** Exact replica of llull geometry/subdivision.ts boxCage (same vertex and face order): centred box, segments per axis. */
export function boxCage(size, segments) {
  const [nx, ny, nz] = segments;
  const index = new Map();
  const vertices = [];
  const at = (i, j, k) => {
    const key = `${i},${j},${k}`;
    if (index.has(key)) return index.get(key);
    vertices.push([(i / nx - 0.5) * size[0], (j / ny - 0.5) * size[1], (k / nz - 0.5) * size[2]]);
    index.set(key, vertices.length - 1);
    return vertices.length - 1;
  };
  const faces = [];
  const side = (nu, nv, grid, flip) => {
    for (let u = 0; u < nu; u++)
      for (let v = 0; v < nv; v++) {
        const q = [at(...grid(u, v)), at(...grid(u + 1, v)), at(...grid(u + 1, v + 1)), at(...grid(u, v + 1))];
        faces.push(flip ? q.reverse() : q);
      }
  };
  side(nx, ny, (u, v) => [u, v, nz], false);
  side(nx, ny, (u, v) => [u, v, 0], true);
  side(nx, nz, (u, v) => [u, 0, v], false);
  side(nx, nz, (u, v) => [u, ny, v], true);
  side(ny, nz, (u, v) => [nx, u, v], false);
  side(ny, nz, (u, v) => [0, u, v], true);
  return { vertices, faces, sharpness: new Map() };
}
