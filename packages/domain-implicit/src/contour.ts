/**
 * Marching squares on a node grid (05 IMP FR-IMP-32): closed, oriented loops of {f = 0} (material where f < 0 on the left of every edge, so outer loops run counter-clockwise
 * and holes clockwise) with their signed areas. Saddle cells are resolved by the value at the cell centre.
 * @invariant the grid is padded by one ring of far-outside nodes (the contour then runs along the window edge), so every loop closes; vertices are shared by grid-edge key, so loops chain exactly
 */

export type Point2 = readonly [number, number];

export interface Loop {
  readonly points: readonly Point2[];
  /** Signed area (positive: material inside a counter-clockwise loop; negative: a hole). */
  readonly area: number;
  readonly perimeter: number;
}

/** Corner offsets of a cell: a (i, j), b (i + 1, j), c (i + 1, j + 1), d (i, j + 1). */
const CORNERS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
];

/** Edges of a cell by corner pair: bottom a-b, right b-c, top d-c, left a-d. */
const EDGES: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 2],
  [3, 2],
  [0, 3],
];

/** A segment of a cell from edge `from` to edge `to`, oriented so that the material is on its left. */
interface Cut {
  readonly from: number;
  readonly to: number;
}

/** Edge met just before / after each corner when walking the cell boundary counter-clockwise (a, b, c, d). */
const EDGE_BEFORE = [3, 0, 1, 2] as const;
const EDGE_AFTER = [0, 1, 2, 3] as const;

/**
 * Cuts of a cell for its inside mask (bit k = corner k inside) and whether the centre is inside (saddles). The material side of a segment is the arc of the boundary
 * that runs counter-clockwise from its end edge to its start edge, so the orientation follows from the topology of the corners, not from the (possibly zero-length) geometry.
 */
function cuts(mask: number, centreInside: boolean): Cut[] {
  const isInside = (k: number): boolean => ((mask >> (k % 4)) & 1) === 1;
  const isolate = (corner: number, inside: boolean): Cut =>
    inside
      ? { from: EDGE_AFTER[corner] as number, to: EDGE_BEFORE[corner] as number }
      : { from: EDGE_BEFORE[corner] as number, to: EDGE_AFTER[corner] as number };
  const inside = [0, 1, 2, 3].filter(isInside);
  if (inside.length === 0 || inside.length === 4) return [];
  if (inside.length === 1) return [isolate(inside[0] as number, true)];
  if (inside.length === 3) return [isolate([0, 1, 2, 3].find((k) => !isInside(k)) as number, false)];
  if (mask === 5 || mask === 10) {
    const others = [0, 1, 2, 3].filter((k) => !isInside(k));
    return centreInside ? others.map((k) => isolate(k, false)) : inside.map((k) => isolate(k, true));
  }
  const first = inside.find((k) => !isInside(k + 3)) as number;
  const last = (first + 1) % 4;
  return [{ from: EDGE_AFTER[last] as number, to: EDGE_BEFORE[first] as number }];
}

/** Closed loops of {values < 0} on a `columns` x `rows` node grid (x fastest) with node spacing `step` and lower corner `origin`. */
export function contourLoops(values: ArrayLike<number>, columns: number, rows: number, step: number, origin: Point2): Loop[] {
  const W = columns + 2;
  const H = rows + 2;
  const padded = new Float64Array(W * H).fill(1e30);
  for (let j = 0; j < rows; j += 1) for (let i = 0; i < columns; i += 1) padded[i + 1 + W * (j + 1)] = values[i + columns * j] as number;
  const at = (i: number, j: number): number => padded[i + W * j] as number;
  const position = (i: number, j: number): Point2 => [origin[0] + (i - 1) * step, origin[1] + (j - 1) * step];
  const vertexKey = (i: number, j: number, edge: number): string => {
    const [c0, c1] = EDGES[edge] as readonly [number, number];
    const [p, q] = [CORNERS[c0] as readonly [number, number], CORNERS[c1] as readonly [number, number]];
    const [ai, aj, bi, bj] = [i + p[0], j + p[1], i + q[0], j + q[1]];
    return ai + aj * W < bi + bj * W ? `${ai},${aj}|${bi},${bj}` : `${bi},${bj}|${ai},${aj}`;
  };
  const vertexPoint = (i: number, j: number, edge: number): Point2 => {
    const [c0, c1] = EDGES[edge] as readonly [number, number];
    const [p, q] = [CORNERS[c0] as readonly [number, number], CORNERS[c1] as readonly [number, number]];
    const [va, vb] = [at(i + p[0], j + p[1]), at(i + q[0], j + q[1])];
    const t = va / (va - vb);
    const [pa, pb] = [position(i + p[0], j + p[1]), position(i + q[0], j + q[1])];
    return [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t];
  };
  const next = new Map<string, string>();
  const points = new Map<string, Point2>();
  for (let j = 0; j < H - 1; j += 1)
    for (let i = 0; i < W - 1; i += 1) {
      let mask = 0;
      const corner = CORNERS.map(([di, dj]) => at(i + di, j + dj));
      corner.forEach((value, k) => {
        if (value < 0) mask |= 1 << k;
      });
      if (mask === 0 || mask === 15) continue;
      const centre = ((corner[0] as number) + (corner[1] as number) + (corner[2] as number) + (corner[3] as number)) / 4;
      for (const cut of cuts(mask, centre < 0)) {
        const [kf, kt] = [vertexKey(i, j, cut.from), vertexKey(i, j, cut.to)];
        const [pf, pt] = [vertexPoint(i, j, cut.from), vertexPoint(i, j, cut.to)];
        points.set(kf, pf);
        points.set(kt, pt);
        next.set(kf, kt);
      }
    }
  const loops: Loop[] = [];
  const visited = new Set<string>();
  for (const start of next.keys()) {
    if (visited.has(start)) continue;
    const chain: Point2[] = [];
    let key = start;
    while (!visited.has(key)) {
      visited.add(key);
      chain.push(points.get(key) as Point2);
      const following = next.get(key);
      if (following === undefined) break;
      key = following;
    }
    let area = 0;
    let perimeter = 0;
    chain.forEach((p, k) => {
      const q = chain[(k + 1) % chain.length] as Point2;
      area += (p[0] * q[1] - q[0] * p[1]) / 2;
      perimeter += Math.hypot(q[0] - p[0], q[1] - p[1]);
    });
    if (chain.length >= 3) loops.push({ points: chain, area, perimeter });
  }
  return loops;
}
