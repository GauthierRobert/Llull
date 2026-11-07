/** Even-odd loop sets of a `region` entity: nesting, faces (outer + holes), net area, validity and hatch lines. Pure, no document access. */

import type { RegionEntity, Vec2 } from '../model/types';
import type { RegionHatch } from '../model/regionHatch';
import { pointInPolygon, polygonArea, projectOntoSegment, segmentsIntersect } from '../lib/polygon';
import { cappedHatch } from '../lib/hatch';
import { chainMoments } from './chainMoments';

type Loop = ReadonlyArray<Vec2>;

/** Smallest enclosed area a loop must have to count as a boundary (document units²). */
const MIN_LOOP_AREA = 1e-9;

/** Number of other loops containing each loop (0 = outer boundary, 1 = hole, 2 = island in a hole, …); loops must not cross. */
export function loopDepths(loops: ReadonlyArray<Loop>): number[] {
  return loops.map((loop, i) => {
    const probe = loop[0] as Vec2;
    return loops.reduce((depth, other, j) => (j !== i && pointInPolygon(probe, other) ? depth + 1 : depth), 0);
  });
}

/** Filled faces of an even-odd loop set: every even-depth loop with the odd-depth loops directly inside it as holes. */
export function regionFaces(loops: ReadonlyArray<Loop>): Array<{ outer: Loop; holes: Loop[] }> {
  const depths = loopDepths(loops);
  const areas = loops.map((loop) => polygonArea(loop));
  const parentOf = (index: number): number => {
    let best = -1;
    loops.forEach((other, j) => {
      const contains =
        j !== index && depths[j] === (depths[index] as number) - 1 && pointInPolygon((loops[index] as Loop)[0] as Vec2, other);
      if (contains && (best < 0 || (areas[j] as number) < (areas[best] as number))) best = j;
    });
    return best;
  };
  const parents = loops.map((_, i) => ((depths[i] as number) % 2 === 1 ? parentOf(i) : -1));
  return loops.flatMap((outer, i) => ((depths[i] as number) % 2 === 0 ? [{ outer, holes: loops.filter((_, j) => parents[j] === i) }] : []));
}

/**
 * Net area of a region: outer minus holes plus islands (even-odd), exact over `curves` when the entity carries them.
 * @invariant loops do not cross (a region built by `hatch_region` always satisfies it)
 */
export function regionNetArea(region: Pick<RegionEntity, 'loops' | 'curves'>): number {
  const depths = loopDepths(region.loops);
  return region.loops.reduce((total, loop, i) => {
    const chain = region.curves?.[i];
    const area = chain === undefined ? polygonArea(loop) : Math.abs(chainMoments(chain).area);
    return total + ((depths[i] as number) % 2 === 0 ? area : -area);
  }, 0);
}

/** Gap below which two boundary pieces count as touching: absolute, for straight loops. */
const SELF_TOLERANCE = 1e-6;
/** Tessellation sagitta bound of a curved loop (32 samples a turn), as a fraction of its bounding-box diagonal. */
const CURVE_TOLERANCE_RATIO = 0.002;

export interface LoopBox {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** Bounding box of a loop. */
export function loopBounds(loop: Loop): LoopBox {
  const xs = loop.map(([x]) => x);
  const ys = loop.map(([, y]) => y);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

/** True when the boxes, each grown by `margin`, overlap. */
export const boxesTouch = (a: LoopBox, b: LoopBox, margin: number): boolean =>
  a.minX - margin <= b.maxX && a.maxX + margin >= b.minX && a.minY - margin <= b.maxY && a.maxY + margin >= b.minY;

/** Gap under which `loop` counts as touching something: 1e-6, or the tessellation error of an exact curved loop. */
export function contactTolerance(loop: Loop, curved: boolean): number {
  const { minX, minY, maxX, maxY } = loopBounds(loop);
  return curved ? Math.max(SELF_TOLERANCE, CURVE_TOLERANCE_RATIO * Math.hypot(maxX - minX, maxY - minY)) : SELF_TOLERANCE;
}

/** Distance between segments p-q and r-s (0 when they cross or touch). */
function segmentDistance(p: Vec2, q: Vec2, r: Vec2, s: Vec2): number {
  if (segmentsIntersect(p, q, r, s)) return 0;
  return Math.min(
    projectOntoSegment(p, r, s).distance,
    projectOntoSegment(q, r, s).distance,
    projectOntoSegment(r, p, q).distance,
    projectOntoSegment(s, p, q).distance,
  );
}

/** Closed-loop edge `index` as [start, end]. */
const edgeOf = (loop: Loop, index: number): [Vec2, Vec2] => [loop[index] as Vec2, loop[(index + 1) % loop.length] as Vec2];

const edgeBox = ([a, b]: [Vec2, Vec2]): LoopBox => ({
  minX: Math.min(a[0], b[0]),
  minY: Math.min(a[1], b[1]),
  maxX: Math.max(a[0], b[0]),
  maxY: Math.max(a[1], b[1]),
});

/**
 * How loop `a` meets loop `b`: `cross` when edges properly cross, `touch` when they come within `tolerance` (T-touch, shared vertex,
 * collinear overlap, tangency, coincident edges), null when apart.
 */
export function loopContact(a: Loop, b: Loop, tolerance: number): 'cross' | 'touch' | null {
  if (!boxesTouch(loopBounds(a), loopBounds(b), tolerance)) return null;
  let touch = false;
  const edgesB = b.map((_, j) => edgeOf(b, j));
  const boxesB = edgesB.map(edgeBox);
  for (let i = 0; i < a.length; i++) {
    const edge = edgeOf(a, i);
    const box = edgeBox(edge);
    for (let j = 0; j < edgesB.length; j++) {
      if (!boxesTouch(box, boxesB[j] as LoopBox, tolerance)) continue;
      const [r, t] = edgesB[j] as [Vec2, Vec2];
      if (segmentsIntersect(edge[0], edge[1], r, t)) return 'cross';
      if (segmentDistance(edge[0], edge[1], r, t) <= tolerance) touch = true;
    }
  }
  return touch ? 'touch' : null;
}

/** Distance from `point` to the boundary of `loop`. */
export function distanceToLoop(point: Vec2, loop: Loop): number {
  return Math.min(...loop.map((_, i) => projectOntoSegment(point, ...edgeOf(loop, i)).distance));
}

/** Two edges sharing a vertex that fold back onto each other (a spike): collinear and leaving the vertex in the same direction. */
function foldsBack(v: Vec2, u: Vec2, w: Vec2): boolean {
  const [ax, ay, bx, by] = [u[0] - v[0], u[1] - v[1], w[0] - v[0], w[1] - v[1]];
  const [la, lb] = [Math.hypot(ax, ay), Math.hypot(bx, by)];
  if (la <= SELF_TOLERANCE || lb <= SELF_TOLERANCE) return false;
  return Math.abs(ax * by - ay * bx) <= SELF_TOLERANCE * Math.max(la, lb) && ax * bx + ay * by > 0;
}

/** True when the loop crosses or touches itself: crossing edges, a vertex on another edge, collinear overlap, a spike. */
function selfContact(loop: Loop): boolean {
  const n = loop.length;
  const edges = loop.map((_, i) => edgeOf(loop, i));
  const boxes = edges.map(edgeBox);
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const [e, f] = [edges[i] as [Vec2, Vec2], edges[j] as [Vec2, Vec2]];
      if (j === i + 1) {
        if (foldsBack(e[1], e[0], f[1])) return true;
      } else if (i === 0 && j === n - 1) {
        if (foldsBack(e[0], e[1], f[0])) return true;
      } else if (
        boxesTouch(boxes[i] as LoopBox, boxes[j] as LoopBox, SELF_TOLERANCE) &&
        segmentDistance(e[0], e[1], f[0], f[1]) <= SELF_TOLERANCE
      )
        return true;
    }
  return false;
}

export type RegionLoopsIssueCode = 'REGION_DEGENERATE_LOOP' | 'REGION_SELF_INTERSECTING' | 'REGION_LOOPS_CROSS' | 'REGION_LOOPS_TOUCH';

/**
 * First reason a loop set is not a valid region, or null: a degenerate loop, a loop crossing or touching itself, two loops that cross, or two
 * loops that touch (within `contactTolerance`; `curved[i]` marks loops tessellated from exact curves).
 */
export function regionLoopsIssue(
  loops: ReadonlyArray<Loop>,
  curved: ReadonlyArray<boolean> = [],
): { code: RegionLoopsIssueCode; index: number } | null {
  for (let i = 0; i < loops.length; i++) {
    const loop = loops[i] as Loop;
    if (loop.length < 3) return { code: 'REGION_DEGENERATE_LOOP', index: i };
    if (selfContact(loop)) return { code: 'REGION_SELF_INTERSECTING', index: i };
    if (polygonArea(loop) < MIN_LOOP_AREA) return { code: 'REGION_DEGENERATE_LOOP', index: i };
  }
  for (let i = 0; i < loops.length; i++)
    for (let j = i + 1; j < loops.length; j++) {
      const [a, b] = [loops[i] as Loop, loops[j] as Loop];
      const contact = loopContact(a, b, Math.max(contactTolerance(a, curved[i] === true), contactTolerance(b, curved[j] === true)));
      if (contact !== null) return { code: contact === 'cross' ? 'REGION_LOOPS_CROSS' : 'REGION_LOOPS_TOUCH', index: j };
    }
  return null;
}

type Segment = [[number, number], [number, number]];

/**
 * Pattern lines of a hatched region in its local plane (even-odd clipped): `lines` at `angle`, `cross` at `angle` and `angle + 90°`;
 * none for `solid` (filled by the renderer) or an unhatched region.
 */
export function regionHatchLines(region: { readonly loops: RegionEntity['loops']; readonly hatch?: RegionHatch | undefined }): Segment[] {
  const { hatch, loops } = region;
  if (hatch === undefined || hatch.pattern === 'solid') return [];
  const lines = cappedHatch(loops, hatch.angle, hatch.spacing, true);
  return hatch.pattern === 'lines' ? lines : [...lines, ...cappedHatch(loops, hatch.angle + Math.PI / 2, hatch.spacing, true)];
}
