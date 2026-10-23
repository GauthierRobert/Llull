/**
 * Marching tetrahedra on a dense node grid (05 IMP TR-IMP-08; the mesher the topology plugin used, moved here). Each cube is split into the six
 * Kuhn tetrahedra along its main diagonal; vertices sit on grid edges by linear interpolation and are welded by an exact edge key.
 * @invariant welded by the edge key `lo * nodeCount + hi`, exact in a double while nodeCount^2 < 2^53 (nodeCount up to 9.4e7); larger grids are refused (null)
 * @invariant orientation is decided on the grid-edge midpoints of each triangle, never on the interpolated corners, so a vertex that lands on a node cannot flip it
 * @invariant output depends on the node values only (cube order x fastest, fixed tetrahedron order): same grid, same mesh
 */

import type { Vec3 } from '../../model/vectors';

/** Structural triangle mesh (assignable to the model `MeshData`; lib stays a leaf). */
export interface IsoMesh {
  readonly positions: number[];
  readonly indices: number[];
}

export interface IsoGrid {
  /** Node counts per axis (cells + 1); at least 2 each to produce anything. */
  readonly nodes: readonly [number, number, number];
  /** Position of node (0, 0, 0). */
  readonly origin: Vec3;
  /** Node spacing, equal on the three axes. */
  readonly voxel: number;
  /** Node values, x fastest: index = i + nodes[0] * (j + nodes[1] * k). */
  readonly values: ArrayLike<number>;
  /** Iso value. */
  readonly threshold: number;
  /** True when material is where value >= threshold (a density); false when value < threshold (a signed distance with threshold 0). */
  readonly insideAbove: boolean;
}

/** Largest node count whose squared edge key is still an exact integer double. */
export const MAX_ISO_NODES = 94_000_000;

/** Corner bit 0 = +x, 1 = +y, 2 = +z; each tetrahedron walks the cube diagonal 0 -> 7 through one axis permutation. */
const KUHN: ReadonlyArray<readonly number[]> = [
  [0, 1, 3, 7],
  [0, 1, 5, 7],
  [0, 2, 3, 7],
  [0, 2, 6, 7],
  [0, 4, 5, 7],
  [0, 4, 6, 7],
];

type Edge = readonly [number, number];

/** Closed, oriented iso-surface of the grid at `threshold`, or null when the grid has more than MAX_ISO_NODES nodes. Normals point out of the material. */
export function marchingTetrahedra(grid: IsoGrid): IsoMesh | null {
  const [sx, sy, sz] = grid.nodes;
  const total = sx * sy * sz;
  const positions: number[] = [];
  const indices: number[] = [];
  if (total > MAX_ISO_NODES) return null;
  if (sx < 2 || sy < 2 || sz < 2) return { positions, indices };
  const { values, threshold, insideAbove, voxel, origin } = grid;
  const slab = sx * sy;
  const vertexOfEdge = new Map<number, number>();
  const valueAt = (id: number): number => values[id] as number;
  const isInside = (id: number): boolean => (insideAbove ? valueAt(id) >= threshold : valueAt(id) < threshold);
  const coordOf = (id: number, axis: 0 | 1 | 2): number =>
    axis === 0 ? id % sx : axis === 1 ? Math.floor(id / sx) % sy : Math.floor(id / slab);
  const vertexOn = ([a, b]: Edge): number => {
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const key = lo * total + hi;
    const known = vertexOfEdge.get(key);
    if (known !== undefined) return known;
    const low = valueAt(lo);
    const high = valueAt(hi);
    const t = (threshold - low) / (high - low);
    const index = positions.length / 3;
    for (const axis of [0, 1, 2] as const) {
      const p = coordOf(lo, axis);
      positions.push(origin[axis] + (p + (coordOf(hi, axis) - p) * t) * voxel);
    }
    vertexOfEdge.set(key, index);
    return index;
  };
  const midpoint = ([a, b]: Edge): Vec3 => [
    (coordOf(a, 0) + coordOf(b, 0)) / 2,
    (coordOf(a, 1) + coordOf(b, 1)) / 2,
    (coordOf(a, 2) + coordOf(b, 2)) / 2,
  ];
  const emit = (ea: Edge, eb: Edge, ec: Edge, outward: Vec3): void => {
    const [ia, ib, ic] = [vertexOn(ea), vertexOn(eb), vertexOn(ec)];
    if (ia === ib || ib === ic || ia === ic) return;
    const [pa, pb, pc] = [midpoint(ea), midpoint(eb), midpoint(ec)];
    const [u0, u1, u2] = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
    const [v0, v1, v2] = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
    const facing = (u1 * v2 - u2 * v1) * outward[0] + (u2 * v0 - u0 * v2) * outward[1] + (u0 * v1 - u1 * v0) * outward[2];
    if (facing >= 0) indices.push(ia, ib, ic);
    else indices.push(ia, ic, ib);
  };
  const centroid = (ids: readonly number[]): Vec3 => [
    ids.reduce((sum, id) => sum + coordOf(id, 0), 0) / ids.length,
    ids.reduce((sum, id) => sum + coordOf(id, 1), 0) / ids.length,
    ids.reduce((sum, id) => sum + coordOf(id, 2), 0) / ids.length,
  ];
  const corner = new Int32Array(8);
  const flags = new Uint8Array(8);
  for (let k = 0; k < sz - 1; k += 1)
    for (let j = 0; j < sy - 1; j += 1)
      for (let i = 0; i < sx - 1; i += 1) {
        const base = i + sx * j + slab * k;
        let inside = 0;
        for (let c = 0; c < 8; c += 1) {
          corner[c] = base + (c & 1) + sx * ((c >> 1) & 1) + slab * ((c >> 2) & 1);
          flags[c] = isInside(corner[c] as number) ? 1 : 0;
          inside += flags[c] as number;
        }
        if (inside === 0 || inside === 8) continue;
        for (const tetrahedron of KUHN) {
          const inIds = tetrahedron.filter((c) => flags[c] === 1).map((c) => corner[c] as number);
          const outIds = tetrahedron.filter((c) => flags[c] === 0).map((c) => corner[c] as number);
          if (inIds.length === 0 || outIds.length === 0) continue;
          const [ci, co] = [centroid(inIds), centroid(outIds)];
          const outward: Vec3 = [(co[0] - ci[0]) * voxel, (co[1] - ci[1]) * voxel, (co[2] - ci[2]) * voxel];
          if (inIds.length === 2) {
            const [a, b, c, d] = [inIds[0] as number, inIds[1] as number, outIds[0] as number, outIds[1] as number];
            emit([a, c], [a, d], [b, d], outward);
            emit([a, c], [b, d], [b, c], outward);
          } else {
            const [apex, ring] = inIds.length === 1 ? [inIds[0] as number, outIds] : [outIds[0] as number, inIds];
            emit([apex, ring[0] as number], [apex, ring[1] as number], [apex, ring[2] as number], outward);
          }
        }
      }
  return { positions, indices };
}
