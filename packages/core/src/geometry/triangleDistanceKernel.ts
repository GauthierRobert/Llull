/**
 * Allocation-free triangle-triangle distance with witness points, on flat scratch arrays. Same arithmetic, same evaluation order and same
 * tie rules as the vector-tuple form it replaced, so every result is bit-identical (`triangleQueries.triangleDistance` wraps it).
 * Not re-entrant: it uses module scratch (every call is synchronous).
 * @invariant a pair of triangles => the same distance and witness points, bit for bit, as the tuple implementation
 */

/** `tri` layout: first triangle at 0..8, second at 9..17, three xyz vertices each. `out` layout: distance, pointA xyz, pointB xyz. */
export const PAIR_FLOATS = 18;
export const RESULT_FLOATS = 7;

const candidate = new Float64Array(RESULT_FLOATS);
const hit = new Float64Array(3);
const onTriangle = new Float64Array(3);

/** dot(cross(edge, w), normal) with the edge `e` and the offset `w` from the edge's start. */
function side(ex: number, ey: number, ez: number, wx: number, wy: number, wz: number, nx: number, ny: number, nz: number): number {
  return (ey * wz - ez * wy) * nx + (ez * wx - ex * wz) * ny + (ex * wy - ey * wx) * nz;
}

/** Whether segment `p`-`q` (offsets in `t`) pierces the interior of the triangle at `base` whose normal is `n`; the point goes to `hit`. */
function segmentPierces(t: Float64Array, p: number, q: number, base: number, nx: number, ny: number, nz: number): boolean {
  const px = t[p] ?? 0;
  const py = t[p + 1] ?? 0;
  const pz = t[p + 2] ?? 0;
  const dx = (t[q] ?? 0) - px;
  const dy = (t[q + 1] ?? 0) - py;
  const dz = (t[q + 2] ?? 0) - pz;
  const denominator = nx * dx + ny * dy + nz * dz;
  if (denominator === 0) return false;
  const ax = t[base] ?? 0;
  const ay = t[base + 1] ?? 0;
  const az = t[base + 2] ?? 0;
  const s = (nx * (ax - px) + ny * (ay - py) + nz * (az - pz)) / denominator;
  if (s < 0 || s > 1) return false;
  const x = px + dx * s;
  const y = py + dy * s;
  const z = pz + dz * s;
  const slack = -1e-12 * (nx * nx + ny * ny + nz * nz);
  const bx = t[base + 3] ?? 0;
  const by = t[base + 4] ?? 0;
  const bz = t[base + 5] ?? 0;
  const cx = t[base + 6] ?? 0;
  const cy = t[base + 7] ?? 0;
  const cz = t[base + 8] ?? 0;
  const inside =
    side(bx - ax, by - ay, bz - az, x - ax, y - ay, z - az, nx, ny, nz) >= slack &&
    side(cx - bx, cy - by, cz - bz, x - bx, y - by, z - bz, nx, ny, nz) >= slack &&
    side(ax - cx, ay - cy, az - cz, x - cx, y - cy, z - cz, nx, ny, nz) >= slack;
  if (!inside) return false;
  hit[0] = x;
  hit[1] = y;
  hit[2] = z;
  return true;
}

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/** Closest points of segments `o1`-`o2` and `o3`-`o4` (offsets in `t`) into `candidate`. */
function segmentPair(t: Float64Array, o1: number, o2: number, o3: number, o4: number): void {
  const p1x = t[o1] ?? 0;
  const p1y = t[o1 + 1] ?? 0;
  const p1z = t[o1 + 2] ?? 0;
  const p2x = t[o3] ?? 0;
  const p2y = t[o3 + 1] ?? 0;
  const p2z = t[o3 + 2] ?? 0;
  const d1x = (t[o2] ?? 0) - p1x;
  const d1y = (t[o2 + 1] ?? 0) - p1y;
  const d1z = (t[o2 + 2] ?? 0) - p1z;
  const d2x = (t[o4] ?? 0) - p2x;
  const d2y = (t[o4 + 1] ?? 0) - p2y;
  const d2z = (t[o4 + 2] ?? 0) - p2z;
  const rx = p1x - p2x;
  const ry = p1y - p2y;
  const rz = p1z - p2z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  let s = 0;
  let u = 0;
  if (a <= 1e-300 && e <= 1e-300) {
    s = 0;
    u = 0;
  } else if (a <= 1e-300) {
    u = clamp01(f / e);
  } else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= 1e-300) {
      s = clamp01(-c / a);
    } else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const denominator = a * e - b * b;
      s = denominator > 1e-300 ? clamp01((b * f - c * e) / denominator) : 0;
      u = (b * s + f) / e;
      if (u < 0) {
        u = 0;
        s = clamp01(-c / a);
      } else if (u > 1) {
        u = 1;
        s = clamp01((b - c) / a);
      }
    }
  }
  const ax = p1x + d1x * s;
  const ay = p1y + d1y * s;
  const az = p1z + d1z * s;
  const bx = p2x + d2x * u;
  const by = p2y + d2y * u;
  const bz = p2z + d2z * u;
  const vx = ax - bx;
  const vy = ay - by;
  const vz = az - bz;
  candidate[0] = Math.sqrt(vx * vx + vy * vy + vz * vz);
  candidate[1] = ax;
  candidate[2] = ay;
  candidate[3] = az;
  candidate[4] = bx;
  candidate[5] = by;
  candidate[6] = bz;
}

/** Closest point of the triangle at `base` to the vertex at offset `vertex`, into `onTriangle` (Ericson 5.1.5). */
function closestOnTriangle(t: Float64Array, vertex: number, base: number): void {
  const px = t[vertex] ?? 0;
  const py = t[vertex + 1] ?? 0;
  const pz = t[vertex + 2] ?? 0;
  const ax = t[base] ?? 0;
  const ay = t[base + 1] ?? 0;
  const az = t[base + 2] ?? 0;
  const bx = t[base + 3] ?? 0;
  const by = t[base + 4] ?? 0;
  const bz = t[base + 5] ?? 0;
  const cx = t[base + 6] ?? 0;
  const cy = t[base + 7] ?? 0;
  const cz = t[base + 8] ?? 0;
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const acx = cx - ax;
  const acy = cy - ay;
  const acz = cz - az;
  const d1 = abx * (px - ax) + aby * (py - ay) + abz * (pz - az);
  const d2 = acx * (px - ax) + acy * (py - ay) + acz * (pz - az);
  if (d1 <= 0 && d2 <= 0) return setPoint(ax, ay, az);
  const d3 = abx * (px - bx) + aby * (py - by) + abz * (pz - bz);
  const d4 = acx * (px - bx) + acy * (py - by) + acz * (pz - bz);
  if (d3 >= 0 && d4 <= d3) return setPoint(bx, by, bz);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const w = d1 / (d1 - d3);
    return setPoint(ax + abx * w, ay + aby * w, az + abz * w);
  }
  const d5 = abx * (px - cx) + aby * (py - cy) + abz * (pz - cz);
  const d6 = acx * (px - cx) + acy * (py - cy) + acz * (pz - cz);
  if (d6 >= 0 && d5 <= d6) return setPoint(cx, cy, cz);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return setPoint(ax + acx * w, ay + acy * w, az + acz * w);
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return setPoint(bx + (cx - bx) * w, by + (cy - by) * w, bz + (cz - bz) * w);
  }
  const denominator = 1 / (va + vb + vc);
  const v = vb * denominator;
  const w = vc * denominator;
  return setPoint(ax + (abx * v + acx * w), ay + (aby * v + acy * w), az + (abz * v + acz * w));
}

function setPoint(x: number, y: number, z: number): void {
  onTriangle[0] = x;
  onTriangle[1] = y;
  onTriangle[2] = z;
}

/** `candidate` for vertex `vertex` of one triangle against the triangle at `base`; `vertexIsA` says which witness slot the vertex fills. */
function vertexPair(t: Float64Array, vertex: number, base: number, vertexIsA: boolean): void {
  closestOnTriangle(t, vertex, base);
  const px = t[vertex] ?? 0;
  const py = t[vertex + 1] ?? 0;
  const pz = t[vertex + 2] ?? 0;
  const qx = onTriangle[0] ?? 0;
  const qy = onTriangle[1] ?? 0;
  const qz = onTriangle[2] ?? 0;
  const vx = px - qx;
  const vy = py - qy;
  const vz = pz - qz;
  candidate[0] = Math.sqrt(vx * vx + vy * vy + vz * vz);
  const a = vertexIsA ? 1 : 4;
  const b = vertexIsA ? 4 : 1;
  candidate[a] = px;
  candidate[a + 1] = py;
  candidate[a + 2] = pz;
  candidate[b] = qx;
  candidate[b + 1] = qy;
  candidate[b + 2] = qz;
}

function writeHit(out: Float64Array): void {
  out[0] = 0;
  for (let k = 0; k < 3; k++) {
    out[1 + k] = hit[k] ?? 0;
    out[4 + k] = hit[k] ?? 0;
  }
}

/** Whether any edge of the triangle at `from` pierces the triangle at `to` (normal computed here); the crossing goes to `hit`. */
function edgesPierce(t: Float64Array, from: number, to: number): boolean {
  const ax = t[to] ?? 0;
  const ay = t[to + 1] ?? 0;
  const az = t[to + 2] ?? 0;
  const ux = (t[to + 3] ?? 0) - ax;
  const uy = (t[to + 4] ?? 0) - ay;
  const uz = (t[to + 5] ?? 0) - az;
  const vx = (t[to + 6] ?? 0) - ax;
  const vy = (t[to + 7] ?? 0) - ay;
  const vz = (t[to + 8] ?? 0) - az;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  for (let k = 0; k < 3; k++) {
    if (segmentPierces(t, from + k * 3, from + ((k + 1) % 3) * 3, to, nx, ny, nz)) return true;
  }
  return false;
}

/** Keep `candidate` in `out` when it is the first one or strictly closer. */
function consider(out: Float64Array, first: boolean): void {
  if (first || (candidate[0] ?? 0) < (out[0] ?? 0)) {
    for (let k = 0; k < RESULT_FLOATS; k++) out[k] = candidate[k] ?? 0;
  }
}

/**
 * Minimum distance between the triangles of `tri` (see `PAIR_FLOATS`) into `out`: 0 with the crossing point as both witnesses when they
 * intersect. Order: piercing edges of the first, of the second, edge-edge pairs, vertex-triangle pairs; the first strictly smaller wins.
 */
export function triangleDistanceInto(tri: Float64Array, out: Float64Array): void {
  if (edgesPierce(tri, 0, 9) || edgesPierce(tri, 9, 0)) return writeHit(out);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      segmentPair(tri, i * 3, ((i + 1) % 3) * 3, 9 + j * 3, 9 + ((j + 1) % 3) * 3);
      consider(out, i === 0 && j === 0);
    }
  }
  for (let k = 0; k < 3; k++) {
    vertexPair(tri, k * 3, 9, true);
    consider(out, false);
  }
  for (let k = 0; k < 3; k++) {
    vertexPair(tri, 9 + k * 3, 0, false);
    consider(out, false);
  }
}
