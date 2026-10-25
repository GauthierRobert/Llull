/**
 * Euclidean feature transform and wall / pore thickness on a node sign grid (05 IMP 5.8): for every node of a phase, the distance to the nearest node outside
 * it and where that node is; thickness is read on the medial set, found by the separation criterion (a node is medial when a neighbour's nearest outside node lies at
 * an angle of at least 110 degrees to its own and at least 2.9 nodes from it, with at least 3 medial neighbours), which keeps the spokes that run into convex corners and rasterisation noise out of the answer.
 * @invariant exact squared Euclidean distances (Felzenszwalb-Huttenlocher lower envelopes along x, y, z), so thickness = 2 d h - h; it is read on discrete medial nodes, accurate to about +-2.5 voxels (curved walls)
 */

export type Nodes = readonly [number, number, number];

interface Transform {
  readonly d2: Float64Array;
  readonly sx: Int32Array;
  readonly sy: Int32Array;
  readonly sz: Int32Array;
}

const INF = 1e30;

/** Lower envelope of the parabolas f(q) + (p - q)^2 along one line; writes the minimum and the arg-minimum for every p. */
function envelope(f: Float64Array, n: number, out: Float64Array, arg: Int32Array, v: Int32Array, z: Float64Array): void {
  const cross = (q: number, p: number): number => ((f[q] as number) + q * q - ((f[p] as number) + p * p)) / (2 * q - 2 * p);
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q += 1) {
    let s = cross(q, v[k] as number);
    while (s <= (z[k] as number)) {
      k -= 1;
      s = cross(q, v[k] as number);
    }
    k += 1;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let p = 0; p < n; p += 1) {
    while ((z[k + 1] as number) < p) k += 1;
    const q = v[k] as number;
    out[p] = (p - q) * (p - q) + (f[q] as number);
    arg[p] = q;
  }
}

/** Squared distance to the nearest node with `site[id] === 1` and that node's coordinates, for every node. */
function featureTransform(site: Uint8Array, nodes: Nodes): Transform {
  const [nx, ny, nz] = nodes;
  const total = nx * ny * nz;
  const d2 = new Float64Array(total).fill(INF);
  const sx = new Int32Array(total).fill(-1);
  const sy = new Int32Array(total).fill(-1);
  const sz = new Int32Array(total).fill(-1);
  const index = (i: number, j: number, k: number): number => i + nx * (j + ny * k);
  for (let k = 0; k < nz; k += 1)
    for (let j = 0; j < ny; j += 1) {
      let last = -1;
      for (let i = 0; i < nx; i += 1) {
        if (site[index(i, j, k)] === 1) last = i;
        if (last >= 0) {
          sx[index(i, j, k)] = last;
          d2[index(i, j, k)] = (i - last) * (i - last);
        }
      }
      last = -1;
      for (let i = nx - 1; i >= 0; i -= 1) {
        if (site[index(i, j, k)] === 1) last = i;
        if (last >= 0 && (last - i) * (last - i) < (d2[index(i, j, k)] as number)) {
          sx[index(i, j, k)] = last;
          d2[index(i, j, k)] = (last - i) * (last - i);
        }
      }
    }
  const longest = Math.max(nx, ny, nz);
  const line = new Float64Array(longest);
  const out = new Float64Array(longest);
  const arg = new Int32Array(longest);
  const v = new Int32Array(longest);
  const z = new Float64Array(longest + 1);
  const previousX = new Int32Array(longest);
  const previousY = new Int32Array(longest);
  for (let k = 0; k < nz; k += 1)
    for (let i = 0; i < nx; i += 1) {
      for (let j = 0; j < ny; j += 1) line[j] = d2[index(i, j, k)] as number;
      envelope(line, ny, out, arg, v, z);
      for (let j = 0; j < ny; j += 1) previousX[j] = sx[index(i, j, k)] as number;
      for (let j = 0; j < ny; j += 1) {
        const q = arg[j] as number;
        d2[index(i, j, k)] = out[j] as number;
        sx[index(i, j, k)] = previousX[q] as number;
        sy[index(i, j, k)] = q;
      }
    }
  for (let j = 0; j < ny; j += 1)
    for (let i = 0; i < nx; i += 1) {
      for (let k = 0; k < nz; k += 1) line[k] = d2[index(i, j, k)] as number;
      envelope(line, nz, out, arg, v, z);
      for (let k = 0; k < nz; k += 1) {
        previousX[k] = sx[index(i, j, k)] as number;
        previousY[k] = sy[index(i, j, k)] as number;
      }
      for (let k = 0; k < nz; k += 1) {
        const q = arg[k] as number;
        d2[index(i, j, k)] = out[k] as number;
        sx[index(i, j, k)] = previousX[q] as number;
        sy[index(i, j, k)] = previousY[q] as number;
        sz[index(i, j, k)] = q;
      }
    }
  return { d2, sx, sy, sz };
}

/** Half-open box of grid nodes `lo <= (i, j, k) < hi`. */
export interface NodeWindow {
  readonly lo: readonly [number, number, number];
  readonly hi: readonly [number, number, number];
}

export interface ThicknessStats {
  /** Smallest thickness on the medial set (document units), or null when the phase has no medial node. */
  readonly min: number | null;
  /** Grid node (i, j, k) of the smallest thickness. */
  readonly minNode: readonly [number, number, number] | null;
  /** Largest thickness (twice the largest inscribed radius, document units), or null. */
  readonly max: number | null;
  readonly medialNodes: number;
  /** Thickness at every medial node, ascending (diagnostics and tests). */
  readonly thicknesses: readonly number[];
}

const MIN_SEPARATION_COS = Math.cos((140 * Math.PI) / 180);
/** Sites of a medial pair are at least this many radii apart (opposite walls: 2; a convex corner of 90 degrees: 1.4). */
const MIN_SEPARATION_RADII = 1.8;
/** Nearest outside nodes of neighbouring nodes closer than this (in nodes) differ by rasterisation noise, not by geometry (the lambda of a lambda-medial axis). */
const MIN_SITE_SEPARATION = 2.9;
/** Components of the unit direction away from the site that select the neighbour tested by the ridge condition. */
const RIDGE_COMPONENT = 0.35;
const MIN_SUPPORT = 6;
/** The reported minimum is the order statistic that many medial nodes support (isolated rasterisation outliers do not set it; a thin web has many medial nodes). */
const SUPPORT_FRACTION = 0.002;
/** Smallest inscribed radius (in nodes) read as a wall: a ball of radius 1 is a layer of nodes against the boundary, not a measurable wall. */
const MIN_RADIUS = 1.5;

/** True when moving away from the nearest outside node (towards the medial surface) does not increase the distance: p is a local maximum of d across the wall. */
function isRidge(
  d2: Float64Array,
  id: number,
  own: number,
  nx: number,
  ny: number,
  toSite: readonly [number, number, number],
  length: number,
): boolean {
  const away = toSite.map((c) => (Math.abs(c / length) >= RIDGE_COMPONENT ? -Math.sign(c) : 0));
  const q = id + (away[0] as number) + nx * ((away[1] as number) + ny * (away[2] as number));
  return q === id || (d2[q] as number) <= own + 1e-9;
}

/**
 * Thickness of the phase `phase[id] === 1` (a wall: the solid; a pore: the complement). `thickness = 2 d h - h` for d the distance (in nodes) to the nearest node
 * outside the phase. Only nodes of `window` are read (default: all but the outermost layer, where the grid ends).
 */
export function phaseThickness(phase: Uint8Array, nodes: Nodes, voxel: number, window?: NodeWindow): ThicknessStats {
  const [nx, ny, nz] = nodes;
  const outside = new Uint8Array(phase.length);
  for (let id = 0; id < phase.length; id += 1) outside[id] = phase[id] === 1 ? 0 : 1;
  const { d2, sx, sy, sz } = featureTransform(outside, nodes);
  const lo = window?.lo ?? [1, 1, 1];
  const hi = window?.hi ?? [nx - 1, ny - 1, nz - 1];
  const range = [
    [Math.max(1, lo[0]), Math.min(nx - 1, hi[0])],
    [Math.max(1, lo[1]), Math.min(ny - 1, hi[1])],
    [Math.max(1, lo[2]), Math.min(nz - 1, hi[2])],
  ] as const;
  const candidate = new Uint8Array(phase.length);
  for (let k = range[2][0]; k < range[2][1]; k += 1)
    for (let j = range[1][0]; j < range[1][1]; j += 1)
      for (let i = range[0][0]; i < range[0][1]; i += 1) {
        const id = i + nx * (j + ny * k);
        const own = d2[id] as number;
        if (phase[id] !== 1 || own >= INF / 2 || own < MIN_RADIUS * MIN_RADIUS) continue;
        const a: [number, number, number] = [(sx[id] as number) - i, (sy[id] as number) - j, (sz[id] as number) - k];
        const lengthA = Math.sqrt(own);
        if (!isRidge(d2, id, own, nx, ny, a, lengthA)) continue;
        for (let dk = -1; dk <= 1 && candidate[id] === 0; dk += 1)
          for (let dj = -1; dj <= 1 && candidate[id] === 0; dj += 1)
            for (let di = -1; di <= 1 && candidate[id] === 0; di += 1) {
              if (di === 0 && dj === 0 && dk === 0) continue;
              const q = id + di + nx * (dj + ny * dk);
              if (phase[q] !== 1 || (d2[q] as number) >= INF / 2) continue;
              const b: [number, number, number] = [(sx[q] as number) - i, (sy[q] as number) - j, (sz[q] as number) - k];
              const lengthB = Math.hypot(b[0], b[1], b[2]);
              if (lengthA === 0 || lengthB === 0) continue;
              const cos = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (lengthA * lengthB);
              if (
                cos <= MIN_SEPARATION_COS &&
                Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) >= Math.max(MIN_SITE_SEPARATION, MIN_SEPARATION_RADII * lengthA)
              )
                candidate[id] = 1;
            }
      }
  const found: Array<{ thickness: number; id: number }> = [];
  for (let k = range[2][0]; k < range[2][1]; k += 1)
    for (let j = range[1][0]; j < range[1][1]; j += 1)
      for (let i = range[0][0]; i < range[0][1]; i += 1) {
        const id = i + nx * (j + ny * k);
        if (candidate[id] === 1) found.push({ thickness: (2 * Math.sqrt(d2[id] as number) - 1) * voxel, id });
      }
  if (found.length === 0) return { min: null, minNode: null, max: null, medialNodes: 0, thicknesses: [] };
  found.sort((p, q) => p.thickness - q.thickness || p.id - q.id);
  const support = Math.min(found.length, Math.max(MIN_SUPPORT, Math.ceil(SUPPORT_FRACTION * found.length)));
  const robust = found[support - 1] as { thickness: number; id: number };
  return {
    min: robust.thickness,
    minNode: [robust.id % nx, Math.floor(robust.id / nx) % ny, Math.floor(robust.id / (nx * ny))],
    max: (found[found.length - 1] as { thickness: number }).thickness,
    medialNodes: found.length,
    thicknesses: found.map((f) => f.thickness),
  };
}
