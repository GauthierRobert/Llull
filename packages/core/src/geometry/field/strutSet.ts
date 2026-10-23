/**
 * Distance to a set of 3MF-style beams (conical frusta between two nodes with linearly interpolated radii and a sphere or butt end cap,
 * 05 IMP §5.5). A periodic set folds the point into its cell and tests only the beams (of the cell and its 26 neighbours) that can reach it.
 * @invariant the value is negative inside a beam, positive outside; it is a distance (1-Lipschitz) up to the radius taper
 */

import type { Vec3 } from '../../model/types';
import type { StrutSet } from './program';

export interface StrutEvaluator {
  /** Signed distance at (x, y, z); `radius` >= 0 replaces every beam radius (spherical caps), -1 keeps the beam radii. */
  distance(x: number, y: number, z: number, radius: number): number;
}

interface Segment {
  readonly ax: number;
  readonly ay: number;
  readonly az: number;
  readonly dx: number;
  readonly dy: number;
  readonly dz: number;
  readonly length: number;
  readonly ra: number;
  readonly rb: number;
  readonly sphere: boolean;
}

function segmentOf(a: Vec3, b: Vec3, ra: number, rb: number, sphere: boolean): Segment {
  const [dx, dy, dz] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  return { ax: a[0], ay: a[1], az: a[2], dx, dy, dz, length: Math.hypot(dx, dy, dz), ra, rb, sphere };
}

/** Distance from (s, rho) to the segment (s1, r1)-(s2, r2) of the half plane. */
function planeSegmentDistance(s: number, rho: number, s1: number, r1: number, s2: number, r2: number): number {
  const [ex, ey] = [s2 - s1, r2 - r1];
  const lengthSq = ex * ex + ey * ey;
  const t = lengthSq === 0 ? 0 : Math.min(1, Math.max(0, ((s - s1) * ex + (rho - r1) * ey) / lengthSq));
  return Math.hypot(s - (s1 + ex * t), rho - (r1 + ey * t));
}

/** Signed distance to the capped frustum of `seg` at a point given by its axial coordinate `s` and radial distance `rho`. */
function frustumDistance(seg: Segment, s: number, rho: number, radius: number): number {
  const [ra, rb] = radius >= 0 ? [radius, radius] : [seg.ra, seg.rb];
  const along = seg.length;
  const ball = (centre: number, r: number): number => Math.hypot(s - centre, rho) - r;
  if (along === 0) return ball(0, Math.max(ra, rb));
  const sphereCaps = seg.sphere || radius >= 0;
  if (sphereCaps && radius >= 0) {
    const t = Math.min(along, Math.max(0, s));
    return Math.hypot(s - t, rho) - ra;
  }
  const inside = s >= 0 && s <= along && rho <= ra + ((rb - ra) * s) / along;
  const edge = Math.min(
    planeSegmentDistance(s, rho, 0, ra, along, rb),
    planeSegmentDistance(s, rho, 0, 0, 0, ra),
    planeSegmentDistance(s, rho, along, 0, along, rb),
  );
  const butt = inside ? -edge : edge;
  return sphereCaps ? Math.min(butt, ball(0, ra), ball(along, rb)) : butt;
}

function distanceToSegments(segments: readonly Segment[], x: number, y: number, z: number, radius: number): number {
  let best = Infinity;
  for (const seg of segments) {
    const [px, py, pz] = [x - seg.ax, y - seg.ay, z - seg.az];
    const s = seg.length === 0 ? 0 : (px * seg.dx + py * seg.dy + pz * seg.dz) / seg.length;
    const rho = Math.sqrt(Math.max(px * px + py * py + pz * pz - s * s, 0));
    const d = frustumDistance(seg, s, rho, radius);
    if (d < best) best = d;
  }
  return best;
}

/** Evaluator of one strut set (periodic sets prefilter the beams reaching the cell once). */
export function prepareStrutSet(set: StrutSet): StrutEvaluator {
  const own = set.beams.map((beam) => ({
    a: set.nodes[beam.a] ?? ([0, 0, 0] as Vec3),
    b: set.nodes[beam.b] ?? ([0, 0, 0] as Vec3),
    ra: beam.ra,
    rb: beam.rb,
    sphere: beam.cap === 'sphere',
  }));
  const periodic = set.periodic;
  if (periodic === null) {
    const segments = own.map((beam) => segmentOf(beam.a, beam.b, beam.ra, beam.rb, beam.sphere));
    return { distance: (x, y, z, radius) => distanceToSegments(segments, x, y, z, radius) };
  }
  const { cell, origin } = periodic;
  const reach = Math.max(0, ...own.flatMap((beam) => [beam.ra, beam.rb]));
  const segments: Segment[] = [];
  for (let i = -1; i <= 1; i += 1)
    for (let j = -1; j <= 1; j += 1)
      for (let k = -1; k <= 1; k += 1) {
        const shift: Vec3 = [i * cell[0], j * cell[1], k * cell[2]];
        for (const beam of own) {
          const a: Vec3 = [beam.a[0] + shift[0], beam.a[1] + shift[1], beam.a[2] + shift[2]];
          const b: Vec3 = [beam.b[0] + shift[0], beam.b[1] + shift[1], beam.b[2] + shift[2]];
          if (segmentTouchesCell(a, b, cell, reach)) segments.push(segmentOf(a, b, beam.ra, beam.rb, beam.sphere));
        }
      }
  const buckets = bucketLists(segments, cell);
  return {
    distance(x, y, z, radius) {
      const [u, v, w] = [x - origin[0], y - origin[1], z - origin[2]];
      const [qx, qy, qz] = [
        u - Math.floor(u / cell[0]) * cell[0],
        v - Math.floor(v / cell[1]) * cell[1],
        w - Math.floor(w / cell[2]) * cell[2],
      ];
      const at = (q: number, size: number): number => Math.min(BUCKETS - 1, Math.floor((q / size) * BUCKETS));
      const list = buckets[at(qx, cell[0]) + BUCKETS * (at(qy, cell[1]) + BUCKETS * at(qz, cell[2]))] ?? segments;
      return distanceToSegments(list, qx, qy, qz, radius);
    },
  };
}

const BUCKETS = 4;

/** Distance from (x, y, z) to the segment of seg. */
function pointSegmentDistance(seg: Segment, x: number, y: number, z: number): number {
  const [px, py, pz] = [x - seg.ax, y - seg.ay, z - seg.az];
  const t = seg.length === 0 ? 0 : Math.min(1, Math.max(0, (px * seg.dx + py * seg.dy + pz * seg.dz) / (seg.length * seg.length)));
  return Math.hypot(px - t * seg.dx, py - t * seg.dy, pz - t * seg.dz);
}

/** Gap between the bounding box of seg and the box [lo, hi] (0 when they overlap): a lower bound of the segment-box distance. */
function boxGap(seg: Segment, lo: Vec3, hi: Vec3): number {
  const ends: ReadonlyArray<readonly [number, number]> = [
    [seg.ax, seg.ax + seg.dx],
    [seg.ay, seg.ay + seg.dy],
    [seg.az, seg.az + seg.dz],
  ];
  return Math.hypot(
    ...ends.map(([a, b], axis) => Math.max(Math.min(a, b) - (hi[axis] as number), (lo[axis] as number) - Math.max(a, b), 0)),
  );
}

/**
 * Per sub-box of the cell, the segments that can hold the nearest beam of any point in it: U = min over segments of the farthest corner
 * distance bounds every nearest distance in the box, so a segment whose bounding box is farther than U (plus the radius spread) is dropped.
 */
function bucketLists(segments: readonly Segment[], cell: Vec3): Segment[][] {
  const lists: Segment[][] = [];
  const size: Vec3 = [cell[0] / BUCKETS, cell[1] / BUCKETS, cell[2] / BUCKETS];
  const radii = segments.flatMap((seg) => [seg.ra, seg.rb]);
  const spread = radii.length === 0 ? 0 : Math.max(...radii) - Math.min(...radii);
  for (let k = 0; k < BUCKETS; k += 1)
    for (let j = 0; j < BUCKETS; j += 1)
      for (let i = 0; i < BUCKETS; i += 1) {
        const lo: Vec3 = [i * size[0], j * size[1], k * size[2]];
        const hi: Vec3 = [lo[0] + size[0], lo[1] + size[1], lo[2] + size[2]];
        const corners = [lo[0], hi[0]].flatMap((x) => [lo[1], hi[1]].flatMap((y) => [lo[2], hi[2]].map((z): Vec3 => [x, y, z])));
        const bound = Math.min(
          Infinity,
          ...segments.map((seg) => Math.max(...corners.map((c) => pointSegmentDistance(seg, c[0], c[1], c[2])))),
        );
        lists.push(segments.filter((seg) => boxGap(seg, lo, hi) <= bound + spread + 1e-9));
      }
  return lists;
}

/** Whether the segment a-b can come within `reach` of the box [0, cell] (conservative: tests the segment's own bounding box grown by `reach`). */
function segmentTouchesCell(a: Vec3, b: Vec3, cell: Vec3, reach: number): boolean {
  const slack = reach + Math.max(cell[0], cell[1], cell[2]) * 1e-9;
  for (const axis of [0, 1, 2] as const) {
    if (Math.max(a[axis], b[axis]) < -slack || Math.min(a[axis], b[axis]) > cell[axis] + slack) return false;
  }
  return true;
}
