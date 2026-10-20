/** Flat pattern of a draped region (06 CMP §5.7): net node (i, j) maps to (i d, j d) in the unsheared tow frame (warp along +x). */

import type { Vec2 } from '@core/model/types';
import { type DrapeNet, type DrapeNode } from './net';

export type FlatLookup = { readonly kind: 'ok'; readonly flat: Vec2 } | { readonly kind: 'locked' } | { readonly kind: 'miss' };

interface Cell {
  readonly i: number;
  readonly j: number;
  readonly corners: readonly [DrapeNode, DrapeNode, DrapeNode, DrapeNode];
  readonly locked: boolean;
}

const EPS = 1e-6;

/** Bilinear coordinates (s, t) of `p` in the chart quad p00 p10 p01 p11, or null when outside it. */
function inverseBilinear(p: Vec2, [p00, p10, p01, p11]: readonly Vec2[] & { 0: Vec2; 1: Vec2; 2: Vec2; 3: Vec2 }): Vec2 | null {
  let s = 0.5;
  let t = 0.5;
  for (let step = 0; step < 12; step++) {
    const x = (1 - s) * (1 - t) * p00[0] + s * (1 - t) * p10[0] + (1 - s) * t * p01[0] + s * t * p11[0] - p[0];
    const y = (1 - s) * (1 - t) * p00[1] + s * (1 - t) * p10[1] + (1 - s) * t * p01[1] + s * t * p11[1] - p[1];
    const xs = (1 - t) * (p10[0] - p00[0]) + t * (p11[0] - p01[0]);
    const ys = (1 - t) * (p10[1] - p00[1]) + t * (p11[1] - p01[1]);
    const xt = (1 - s) * (p01[0] - p00[0]) + s * (p11[0] - p10[0]);
    const yt = (1 - s) * (p01[1] - p00[1]) + s * (p11[1] - p10[1]);
    const det = xs * yt - xt * ys;
    if (Math.abs(det) < 1e-18) return null;
    const [ds, dt] = [(-x * yt + y * xt) / det, (-xs * y + ys * x) / det];
    s += ds;
    t += dt;
    if (Math.abs(ds) + Math.abs(dt) < 1e-12) break;
  }
  return s >= -EPS && s <= 1 + EPS && t >= -EPS && t <= 1 + EPS ? [s, t] : null;
}

/**
 * Maps chart points of the draped region to the flat pattern through the net cells.
 * @invariant a point in a cell with a locked corner answers 'locked'; a point outside every cell answers 'miss'; cells are found through a
 *   uniform bucket grid over the chart so the lookup stays near-constant per point
 */
export function netFlattener(net: DrapeNet): (uv: Vec2) => FlatLookup {
  const cells: Cell[] = [];
  for (const node of net.nodes.values()) {
    const [b, c, e] = [net.get(node.i + 1, node.j), net.get(node.i, node.j + 1), net.get(node.i + 1, node.j + 1)];
    if (b !== undefined && c !== undefined && e !== undefined)
      cells.push({ i: node.i, j: node.j, corners: [node, b, c, e], locked: node.locked || b.locked || c.locked || e.locked });
  }
  const size =
    cells.length === 0
      ? 1
      : (cells.reduce(
          (sum, cell) =>
            sum + Math.hypot(cell.corners[3].hit.uv[0] - cell.corners[0].hit.uv[0], cell.corners[3].hit.uv[1] - cell.corners[0].hit.uv[1]),
          0,
        ) /
          cells.length) *
        2;
  const key = (x: number, y: number): string => `${Math.floor(x / size)},${Math.floor(y / size)}`;
  const buckets = new Map<string, Cell[]>();
  for (const cell of cells) {
    const xs = cell.corners.map((corner) => corner.hit.uv[0]);
    const ys = cell.corners.map((corner) => corner.hit.uv[1]);
    for (let bx = Math.floor(Math.min(...xs) / size); bx <= Math.floor(Math.max(...xs) / size); bx++)
      for (let by = Math.floor(Math.min(...ys) / size); by <= Math.floor(Math.max(...ys) / size); by++) {
        const list = buckets.get(`${bx},${by}`);
        if (list === undefined) buckets.set(`${bx},${by}`, [cell]);
        else list.push(cell);
      }
  }
  return (uv) => {
    let locked = false;
    for (const cell of buckets.get(key(uv[0], uv[1])) ?? []) {
      const [c00, c10, c01, c11] = cell.corners;
      const st = inverseBilinear(uv, [c00.hit.uv, c10.hit.uv, c01.hit.uv, c11.hit.uv]);
      if (st === null) continue;
      if (cell.locked) {
        locked = true;
        continue;
      }
      return { kind: 'ok', flat: [(cell.i + st[0]) * net.d, (cell.j + st[1]) * net.d] };
    }
    return locked ? { kind: 'locked' } : { kind: 'miss' };
  };
}

/** `polygon` with each edge split so no piece is longer than `maxLength` (chart units). */
export function densify(polygon: readonly Vec2[], maxLength: number): Vec2[] {
  return polygon.flatMap((a, k) => {
    const b = polygon[(k + 1) % polygon.length] as Vec2;
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / maxLength));
    return Array.from({ length: n }, (_, m): Vec2 => [a[0] + ((b[0] - a[0]) * m) / n, a[1] + ((b[1] - a[1]) * m) / n]);
  });
}

export type FlatPolygon = { readonly ok: true; readonly polygon: Vec2[] } | { readonly ok: false; readonly reason: 'locked' | 'miss' };

/** The flat pattern of a chart polygon: edges split to the net cell size, each vertex mapped; fails when one lands on a locked cell or off the net. */
export function flattenPolygon(net: DrapeNet, polygon: readonly Vec2[]): FlatPolygon {
  const lookup = netFlattener(net);
  const flat: Vec2[] = [];
  let missed = false;
  for (const point of densify(polygon, net.d)) {
    const hit = lookup(point);
    if (hit.kind === 'locked') return { ok: false, reason: 'locked' };
    if (hit.kind === 'miss') missed = true;
    else flat.push(hit.flat);
  }
  return missed ? { ok: false, reason: 'miss' } : { ok: true, polygon: flat };
}
