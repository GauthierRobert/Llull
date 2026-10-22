// IMP validation — reference iso-surface extraction shared by the generators (no dependencies).
// Marching tetrahedra on a regular grid, each cube split into the 6 Kuhn tetrahedra along the main diagonal (the scheme of
// packages/domain-cae/src/topology/derive.ts), vertices on grid edges by linear interpolation, welded per grid edge.
// Convention: f < 0 inside. Triangles are oriented with outward normals (from f < 0 to f > 0).

// Kuhn decomposition of the unit cube [0,1]^3 along the diagonal (0,0,0)-(1,1,1): one tetrahedron per permutation of the axes.
const PERMS = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];
const KUHN = PERMS.map((perm) => {
  const corners = [[0, 0, 0]];
  const c = [0, 0, 0];
  for (const axis of perm) {
    c[axis] = 1;
    corners.push(c.slice());
  }
  return corners;
});

/**
 * Samples `f` on the nodes of a grid over [min, max] with n[i] cells per axis and extracts the f = 0 surface.
 * Returns { positions: Float64Array, triangles: Uint32Array, h: [hx,hy,hz], evaluations }.
 */
export function marchingTetrahedra(f, min, max, n) {
  const [nx, ny, nz] = n;
  const h = [0, 1, 2].map((i) => (max[i] - min[i]) / n[i]);
  const sx = nx + 1;
  const sy = ny + 1;
  const values = new Float64Array(sx * sy * (nz + 1));
  for (let k = 0; k <= nz; k += 1)
    for (let j = 0; j <= ny; j += 1)
      for (let i = 0; i <= nx; i += 1) values[i + sx * (j + sy * k)] = f([min[0] + i * h[0], min[1] + j * h[1], min[2] + k * h[2]]);
  const node = (i, j, k) => i + sx * (j + sy * k);
  const pos = [];
  const tris = [];
  const edgeVertex = new Map();
  const vertexOn = (a, b) => {
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const key = lo * values.length + hi; // exact while nodes² < 2^53 (grids up to ~ 9.4e7 nodes)
    let index = edgeVertex.get(key);
    if (index !== undefined) return index;
    const fa = values[lo];
    const fb = values[hi];
    const t = fa / (fa - fb);
    const coord = (id) => {
      const i = id % sx;
      const j = Math.floor(id / sx) % sy;
      const k = Math.floor(id / (sx * sy));
      return [min[0] + i * h[0], min[1] + j * h[1], min[2] + k * h[2]];
    };
    const pa = coord(lo);
    const pb = coord(hi);
    index = pos.length / 3;
    pos.push(pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t);
    edgeVertex.set(key, index);
    return index;
  };
  const gridPoint = (id) => [id % sx, Math.floor(id / sx) % sy, Math.floor(id / (sx * sy))];
  // Orientation is decided on the grid-edge MIDPOINTS (never degenerate), so a vertex that lands on a node (f = 0 there) cannot flip a triangle.
  const mid = ([x, y]) => gridPoint(x).map((c, i) => ((c + gridPoint(y)[i]) / 2) * h[i]);
  const emit = (ea, eb, ec, outward) => {
    const [a, b, c] = [vertexOn(...ea), vertexOn(...eb), vertexOn(...ec)];
    const [pa, pb, pc] = [mid(ea), mid(eb), mid(ec)];
    const u = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
    const v = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
    const nrm = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    if (nrm[0] * outward[0] + nrm[1] * outward[1] + nrm[2] * outward[2] >= 0) tris.push(a, b, c);
    else tris.push(a, c, b);
  };
  for (let k = 0; k < nz; k += 1)
    for (let j = 0; j < ny; j += 1)
      for (let i = 0; i < nx; i += 1)
        for (const tet of KUHN) {
          const ids = tet.map(([di, dj, dk]) => node(i + di, j + dj, k + dk));
          const inside = ids.filter((id) => values[id] < 0);
          const outside = ids.filter((id) => values[id] >= 0);
          if (inside.length === 0 || outside.length === 0) continue;
          const centroid = (list) => {
            const c = [0, 0, 0];
            for (const id of list) {
              c[0] += id % sx;
              c[1] += Math.floor(id / sx) % sy;
              c[2] += Math.floor(id / (sx * sy));
            }
            return c.map((x) => x / list.length);
          };
          const ci = centroid(inside);
          const co = centroid(outside);
          const outward = [(co[0] - ci[0]) * h[0], (co[1] - ci[1]) * h[1], (co[2] - ci[2]) * h[2]];
          if (inside.length === 2) {
            const [a, b] = inside;
            const [c, d] = outside;
            emit([a, c], [a, d], [b, d], outward);
            emit([a, c], [b, d], [b, c], outward);
          } else {
            const [apex, base] = inside.length === 1 ? [inside[0], outside] : [outside[0], inside];
            emit([apex, base[0]], [apex, base[1]], [apex, base[2]], outward);
          }
        }
  return { positions: Float64Array.from(pos), triangles: Uint32Array.from(tris), h, evaluations: values.length };
}

/** Signed volume (divergence theorem; valid for a closed, outward-oriented mesh) and total area. */
export function meshMeasures(mesh) {
  const { positions: p, triangles: t } = mesh;
  let volume = 0;
  let area = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = 3 * t[i];
    const b = 3 * t[i + 1];
    const c = 3 * t[i + 2];
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = [p[a], p[a + 1], p[a + 2], p[b], p[b + 1], p[b + 2], p[c], p[c + 1], p[c + 2]];
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    const u = [bx - ax, by - ay, bz - az];
    const v = [cx - ax, cy - ay, cz - az];
    area += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
  }
  return { volume, area, triangles: t.length / 3, vertices: p.length / 3 };
}

/** Edge-manifold check: every undirected edge used by exactly two triangles, once in each direction. */
export function isClosedManifold(mesh) {
  const t = mesh.triangles;
  const V = mesh.positions.length / 3;
  const count = new Map();
  for (let i = 0; i < t.length; i += 3)
    for (let e = 0; e < 3; e += 1) {
      const a = t[i + e];
      const b = t[i + ((e + 1) % 3)];
      const key = a * V + b;
      count.set(key, (count.get(key) ?? 0) + 1);
    }
  for (const [key, c] of count) {
    if (c !== 1) return false;
    const a = Math.floor(key / V);
    const b = key % V;
    if (count.get(b * V + a) !== 1) return false;
  }
  return true;
}
