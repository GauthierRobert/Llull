/**
 * Nearest vertex of a point set (uniform hash grid; cell shells are searched outward from the query, clipped to the occupied cell box, until the best
 * distance is smaller than the next shell). Exact, deterministic (ties go to the lower index). Pure.
 */

import type { Vec3 } from '../../model/vectors';

export class VertexGrid {
  private readonly cell: number;
  private readonly origin: Vec3;
  private readonly cells = new Map<string, number[]>();
  /** Occupied cell index box. */
  private readonly lowCell: [number, number, number] = [Infinity, Infinity, Infinity];
  private readonly highCell: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  /** `positions`: flat xyz of the vertices that may be answers (`indices` lists those used; all when omitted). */
  constructor(
    private readonly positions: ReadonlyArray<number>,
    indices?: ReadonlyArray<number>,
  ) {
    const used =
      indices === undefined ? Array.from({ length: positions.length / 3 }, (_, i) => i) : [...new Set(indices)].sort((a, b) => a - b);
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const v of used)
      for (let a = 0; a < 3; a++) {
        lo[a] = Math.min(lo[a] as number, positions[3 * v + a] as number);
        hi[a] = Math.max(hi[a] as number, positions[3 * v + a] as number);
      }
    this.origin = [lo[0] as number, lo[1] as number, lo[2] as number];
    const extent = Math.max(...[0, 1, 2].map((a) => (hi[a] as number) - (lo[a] as number)), 0);
    this.cell = extent > 0 ? extent / Math.max(1, Math.cbrt(used.length)) : 1;
    for (const v of used) {
      const index = this.indexOf([positions[3 * v] as number, positions[3 * v + 1] as number, positions[3 * v + 2] as number]);
      for (let a = 0; a < 3; a++) {
        this.lowCell[a] = Math.min(this.lowCell[a] as number, index[a] as number);
        this.highCell[a] = Math.max(this.highCell[a] as number, index[a] as number);
      }
      const key = index.join(',');
      const list = this.cells.get(key);
      if (list === undefined) this.cells.set(key, [v]);
      else list.push(v);
    }
  }

  private indexOf(p: Vec3): [number, number, number] {
    return [0, 1, 2].map((a) => Math.floor(((p[a] as number) - (this.origin[a] as number)) / this.cell)) as [number, number, number];
  }

  /** Index of the vertex nearest to `p` and its distance (index -1 for an empty set). */
  nearest(p: Vec3): { index: number; distance: number } {
    if (this.cells.size === 0) return { index: -1, distance: Infinity };
    const home = this.indexOf(p);
    let [best, bestSq] = [-1, Infinity];
    const visit = (x: number, y: number, z: number): void => {
      for (const v of this.cells.get(`${x},${y},${z}`) ?? []) {
        const dSq =
          ((this.positions[3 * v] as number) - p[0]) ** 2 +
          ((this.positions[3 * v + 1] as number) - p[1]) ** 2 +
          ((this.positions[3 * v + 2] as number) - p[2]) ** 2;
        if (dSq < bestSq || (dSq === bestSq && v < best)) [best, bestSq] = [v, dSq];
      }
    };
    // shells nearer than the occupied box are empty; shells beyond its far corner cannot hold anything
    const gap = Math.max(
      ...[0, 1, 2].map((a) =>
        Math.max(0, (this.lowCell[a] as number) - (home[a] as number), (home[a] as number) - (this.highCell[a] as number)),
      ),
    );
    const reach = Math.max(
      ...[0, 1, 2].map((a) =>
        Math.max(Math.abs((home[a] as number) - (this.lowCell[a] as number)), Math.abs((this.highCell[a] as number) - (home[a] as number))),
      ),
    );
    for (let ring = gap; ring <= reach; ring++) {
      if (best >= 0 && (ring - 1) * this.cell > Math.sqrt(bestSq)) break;
      const span = (a: number): number[] => {
        const [from, to] = [
          Math.max((home[a] as number) - ring, this.lowCell[a] as number),
          Math.min((home[a] as number) + ring, this.highCell[a] as number),
        ];
        return Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);
      };
      const [xs, ys, zs] = [span(0), span(1), span(2)];
      const onShell = (a: number, i: number): boolean => Math.abs(i - (home[a] as number)) === ring;
      for (const x of xs)
        for (const y of ys) {
          if (onShell(0, x) || onShell(1, y)) for (const z of zs) visit(x, y, z);
          else
            for (const z of [(home[2] as number) - ring, (home[2] as number) + ring])
              if (z >= (this.lowCell[2] as number) && z <= (this.highCell[2] as number)) visit(x, y, z);
        }
    }
    return { index: best, distance: Math.sqrt(bestSq) };
  }
}
