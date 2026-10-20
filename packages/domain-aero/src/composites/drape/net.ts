/** Kinematic drape net (06 CMP §5.4): inextensible tows of step d seeded at a point with two geodesic generators, filled outward by quadrant. */

import type { Vec3 } from '@core/model/types';
import { cross3, dot3, len3, normalize3, scale3, sub3 } from '@lib/vec3';
import { geodesic, solveNode } from './node';
import type { DrapeHit, DrapeSurface } from './surfaceQuery';

export interface DrapeNode {
  readonly i: number;
  readonly j: number;
  readonly hit: DrapeHit;
  /** Absolute shear of the cell ending at the node, degrees (0 on the generators). */
  readonly shear: number;
  /** Shear above the locking angle with over-lock not allowed: kept for reporting, never propagated. */
  readonly locked: boolean;
}

export interface DrapeNet {
  readonly d: number;
  readonly warp: Vec3;
  readonly weft: Vec3;
  readonly nodes: ReadonlyMap<number, DrapeNode>;
  readonly get: (i: number, j: number) => DrapeNode | undefined;
  readonly stats: { readonly outside: number; readonly inverted: number; readonly truncated: boolean };
}

export interface NetOptions {
  /** Tow step, document length units. */
  readonly d: number;
  readonly seed: DrapeHit;
  /** Warp direction at the seed; projected on the tangent plane. */
  readonly warp: Vec3;
  /** Shear (degrees) above which a node locks; absent = never. */
  readonly lockingAngle?: number | undefined;
  readonly allowOverLock: boolean;
  /** Chart extent (diagonal of the outline) bounding the number of rows. */
  readonly extent: number;
  /** Chart distance beyond the outline still draped (default 2 d). */
  readonly margin?: number;
  /** Node budget (default 400 000). */
  readonly maxNodes?: number;
}

const OFFSET = 20000;
const STRIDE = 2 * OFFSET + 1;
export const nodeKey = (i: number, j: number): number => (i + OFFSET) * STRIDE + (j + OFFSET);
const QUADRANTS: ReadonlyArray<readonly [number, number]> = [
  [1, 1],
  [-1, 1],
  [-1, -1],
  [1, -1],
];
export const DEFAULT_MAX_NODES = 400_000;

const angleDeg = (u: Vec3, v: Vec3): number => (Math.acos(Math.max(-1, Math.min(1, dot3(u, v) / (len3(u) * len3(v))))) * 180) / Math.PI;

/**
 * The fishnet drape of a face from a seed.
 * @invariant deterministic (fixed quadrant and row order); a node needs its two predecessors and the diagonal one; a locked, outside or inverted
 *   node has no successors; the generators are the geodesics through the seed along the warp and the weft (n x warp)
 */
export function buildNet(surface: DrapeSurface, options: NetOptions): DrapeNet {
  const { d, seed, lockingAngle, allowOverLock } = options;
  const margin = options.margin ?? 2 * d;
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const rows = Math.min(OFFSET - 1, Math.ceil(options.extent / d) + 3);
  const warp = normalize3(sub3(options.warp, scale3(seed.normal, dot3(options.warp, seed.normal))));
  const weft = cross3(seed.normal, warp);
  const nodes = new Map<number, DrapeNode>();
  const put = (i: number, j: number, hit: DrapeHit, shear: number): DrapeNode => {
    const node: DrapeNode = { i, j, hit, shear, locked: false };
    nodes.set(nodeKey(i, j), node);
    return node;
  };
  put(0, 0, seed, 0);
  for (const [sign, direction] of [
    [1, warp],
    [-1, scale3(warp, -1)],
  ] as const)
    geodesic(surface, seed, direction, d, rows, margin).forEach((hit, k) => put(sign * (k + 1), 0, hit, 0));
  for (const [sign, direction] of [
    [1, weft],
    [-1, scale3(weft, -1)],
  ] as const)
    geodesic(surface, seed, direction, d, rows, margin).forEach((hit, k) => put(0, sign * (k + 1), hit, 0));
  let outside = 0;
  let inverted = 0;
  let truncated = false;
  const get = (i: number, j: number): DrapeNode | undefined => nodes.get(nodeKey(i, j));
  for (const [sx, sy] of QUADRANTS) {
    for (let a = 1; a <= rows && !truncated; a++) {
      for (let b = 1; b <= rows; b++) {
        const [i, j] = [sx * a, sy * b];
        const [nodeA, nodeB, nodeC] = [get(i - sx, j), get(i, j - sy), get(i - sx, j - sy)];
        if (nodeA === undefined || nodeB === undefined || nodeC === undefined || nodeA.locked || nodeB.locked || nodeC.locked) {
          if (b === 1) a = rows + 1;
          break;
        }
        const outcome = solveNode(surface, nodeA.hit, nodeB.hit, nodeC.hit, d, margin);
        if (outcome.kind !== 'node') {
          if (outcome.kind === 'outside') outside++;
          else inverted++;
          if (b === 1) a = rows + 1;
          break;
        }
        const x = outcome.hit.point;
        const shear = Math.abs(90 - angleDeg(sub3(nodeA.hit.point, x), sub3(nodeB.hit.point, x)));
        const locked = !allowOverLock && lockingAngle !== undefined && shear > lockingAngle;
        nodes.set(nodeKey(i, j), { i, j, hit: outcome.hit, shear, locked });
        if (nodes.size > maxNodes) {
          truncated = true;
          break;
        }
      }
    }
  }
  return { d, warp, weft, nodes, get, stats: { outside, inverted, truncated } };
}
