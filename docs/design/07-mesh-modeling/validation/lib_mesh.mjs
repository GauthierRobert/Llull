// Shared mesh helpers for the 07 MSH generators (Node ESM, no dependencies). Indexed meshes: { positions: number[][3], faces: number[][3] }.

export const PHI = (1 + Math.sqrt(5)) / 2;

export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a) => Math.hypot(a[0], a[1], a[2]);

/** Regular icosahedron (0, ±1, ±φ) cyclic permutations, edge 2, faces wound outward. */
export function icosahedron() {
  const p = PHI;
  const positions = [
    [-1, p, 0],
    [1, p, 0],
    [-1, -p, 0],
    [1, -p, 0],
    [0, -1, p],
    [0, 1, p],
    [0, -1, -p],
    [0, 1, -p],
    [p, 0, -1],
    [p, 0, 1],
    [-p, 0, -1],
    [-p, 0, 1],
  ];
  const faces = [
    [0, 11, 5],
    [0, 5, 1],
    [0, 1, 7],
    [0, 7, 10],
    [0, 10, 11],
    [1, 5, 9],
    [5, 11, 4],
    [11, 10, 2],
    [10, 7, 6],
    [7, 1, 8],
    [3, 9, 4],
    [3, 4, 2],
    [3, 2, 6],
    [3, 6, 8],
    [3, 8, 9],
    [4, 9, 5],
    [2, 4, 11],
    [6, 2, 10],
    [8, 6, 7],
    [9, 8, 1],
  ];
  return { positions, faces };
}

/** Icosphere of radius r: icosahedron projected, then `level` 1-to-4 midpoint subdivisions, each re-projected onto the sphere. */
export function icosphere(r, level) {
  const base = icosahedron();
  let positions = base.positions.map((v) => scale(v, r / norm(v)));
  let faces = base.faces;
  for (let l = 0; l < level; l++) {
    const cache = new Map();
    const next = positions.slice();
    const mid = (a, b) => {
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      let m = cache.get(key);
      if (m === undefined) {
        const v = scale(add(positions[a], positions[b]), 0.5);
        m = next.length;
        next.push(scale(v, r / norm(v)));
        cache.set(key, m);
      }
      return m;
    };
    const nf = [];
    for (const [a, b, c] of faces) {
      const ab = mid(a, b);
      const bc = mid(b, c);
      const ca = mid(c, a);
      nf.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    positions = next;
    faces = nf;
  }
  return { positions, faces };
}

/** Torus about +Z: major R, minor r, nu segments around the axis, nv around the tube. */
export function torus(R, r, nu, nv) {
  const positions = [];
  const faces = [];
  for (let i = 0; i < nu; i++) {
    const u = (2 * Math.PI * i) / nu;
    for (let j = 0; j < nv; j++) {
      const v = (2 * Math.PI * j) / nv;
      positions.push([(R + r * Math.cos(v)) * Math.cos(u), (R + r * Math.cos(v)) * Math.sin(u), r * Math.sin(v)]);
    }
  }
  const id = (i, j) => ((i + nu) % nu) * nv + ((j + nv) % nv);
  for (let i = 0; i < nu; i++)
    for (let j = 0; j < nv; j++) {
      faces.push([id(i, j), id(i + 1, j), id(i + 1, j + 1)], [id(i, j), id(i + 1, j + 1), id(i, j + 1)]);
    }
  return { positions, faces };
}

/** Planar grid on [x0, x0+size]^2, n cells per side, z = f(x, y); faces wound +Z. */
export function grid(size, n, z = () => 0, x0 = 0) {
  const h = size / n;
  const positions = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) positions.push([x0 + i * h, x0 + j * h, z(x0 + i * h, x0 + j * h)]);
  const id = (i, j) => j * (n + 1) + i;
  const faces = [];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) faces.push([id(i, j), id(i + 1, j), id(i + 1, j + 1)], [id(i, j), id(i + 1, j + 1), id(i, j + 1)]);
  return { positions, faces, h };
}

export function triArea(a, b, c) {
  return 0.5 * norm(cross(sub(b, a), sub(c, a)));
}

export function area({ positions, faces }) {
  let s = 0;
  for (const [a, b, c] of faces) s += triArea(positions[a], positions[b], positions[c]);
  return s;
}

export function volume({ positions, faces }) {
  let s = 0;
  for (const [a, b, c] of faces) s += dot(positions[a], cross(positions[b], positions[c])) / 6;
  return s;
}

/** Undirected edges with use counts; boundary edges = count 1. */
export function edgeUse({ faces }) {
  const m = new Map();
  for (const f of faces)
    for (let k = 0; k < 3; k++) {
      const a = f[k];
      const b = f[(k + 1) % 3];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      m.set(key, (m.get(key) ?? 0) + 1);
    }
  return m;
}

export function eulerCharacteristic(mesh) {
  const used = new Set(mesh.faces.flat());
  return used.size - edgeUse(mesh).size + mesh.faces.length;
}

/** Deterministic PRNG (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 2D convex hull area (Andrew monotone chain). */
export function hullArea2d(points) {
  const pts = points.map((p) => [p[0], p[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const crossZ = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && crossZ(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper = [];
  for (const p of pts.slice().reverse()) {
    while (upper.length >= 2 && crossZ(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  let s = 0;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(s) / 2;
}

/** Vertex neighbour lists of a closed or open indexed mesh. */
export function neighbours({ positions, faces }) {
  const n = positions.map(() => new Set());
  for (const [a, b, c] of faces) {
    n[a].add(b).add(c);
    n[b].add(a).add(c);
    n[c].add(a).add(b);
  }
  return n.map((s) => [...s].sort((x, y) => x - y));
}

export const round = (x, digits = 12) => Number(x.toPrecision(digits));
