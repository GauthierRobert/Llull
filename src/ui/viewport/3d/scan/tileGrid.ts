// Spatial tiles of a cloud (document frame): the unit of streaming. The port answers boxes with a budget, so a tile is one box query.

import type { Vec3 } from '@core/model/vectors';

export interface CloudBox {
  readonly min: Vec3;
  readonly max: Vec3;
}

export interface CloudTile extends CloudBox {
  /** `${ix}.${iy}.${iz}`, stable for one cloud box. */
  readonly key: string;
  readonly centre: Vec3;
  /** Bounding-sphere radius. */
  readonly radius: number;
}

const MAX_DIVISIONS_PER_AXIS = 8;

/** Cells per axis: near-cubic cells, at most `maxTiles` in total (a flat cloud gets a 2D grid, a pipe a 1D one). */
export function tileDivisions(box: CloudBox, maxTiles: number): readonly [number, number, number] {
  const extent = [0, 1, 2].map((a) => Math.max(0, (box.max[a] ?? 0) - (box.min[a] ?? 0)));
  const longest = Math.max(...extent);
  if (!(longest > 0) || maxTiles <= 1) return [1, 1, 1];
  // Axes thinner than a tenth of the longest one are not split (a slab stays a slab).
  const active = extent.filter((e) => e > longest * 0.1);
  const cell = Math.pow(active.reduce((volume, e) => volume * e, 1) / maxTiles, 1 / active.length);
  const counts = extent.map((e) => (e > longest * 0.1 ? Math.min(MAX_DIVISIONS_PER_AXIS, Math.max(1, Math.round(e / cell))) : 1));
  const total = (): number => counts.reduce((product, c) => product * c, 1);
  while (total() > maxTiles) {
    const widest = counts.indexOf(Math.max(...counts));
    counts[widest] = Math.max(1, (counts[widest] ?? 1) - 1);
  }
  return [counts[0] ?? 1, counts[1] ?? 1, counts[2] ?? 1];
}

/** The tiles of `box`, x fastest. Deterministic. */
export function buildTileGrid(box: CloudBox, maxTiles: number): readonly CloudTile[] {
  const [nx, ny, nz] = tileDivisions(box, maxTiles);
  const counts = [nx, ny, nz];
  const tiles: CloudTile[] = [];
  for (let iz = 0; iz < nz; iz++)
    for (let iy = 0; iy < ny; iy++)
      for (let ix = 0; ix < nx; ix++) {
        const index = [ix, iy, iz];
        const lo = [0, 1, 2].map((a) => lerp(box, a, (index[a] ?? 0) / (counts[a] ?? 1)));
        const hi = [0, 1, 2].map((a) => lerp(box, a, ((index[a] ?? 0) + 1) / (counts[a] ?? 1)));
        const min: Vec3 = [lo[0] ?? 0, lo[1] ?? 0, lo[2] ?? 0];
        const max: Vec3 = [hi[0] ?? 0, hi[1] ?? 0, hi[2] ?? 0];
        const centre: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
        tiles.push({
          key: `${ix}.${iy}.${iz}`,
          min,
          max,
          centre,
          radius: Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2,
        });
      }
  return tiles;
}

function lerp(box: CloudBox, axis: number, t: number): number {
  const lo = box.min[axis] ?? 0;
  const hi = box.max[axis] ?? 0;
  return lo + (hi - lo) * t;
}
