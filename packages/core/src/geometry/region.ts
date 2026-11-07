/** Even-odd loop sets of a `region` entity: nesting, faces (outer + holes), net area, validity and hatch lines. Pure, no document access. */

import type { RegionEntity, Vec2 } from '../model/types';
import type { RegionHatch } from '../model/regionHatch';
import { pointInPolygon, polygonArea, segmentsIntersect, selfIntersects } from '../lib/polygon';
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

/** First reason a loop set is not a valid region, or null: a degenerate loop, a self-intersecting loop or two loops that cross. */
export function regionLoopsIssue(
  loops: ReadonlyArray<Loop>,
): { code: 'REGION_DEGENERATE_LOOP' | 'REGION_SELF_INTERSECTING' | 'REGION_LOOPS_CROSS'; index: number } | null {
  for (let i = 0; i < loops.length; i++) {
    const loop = loops[i] as Loop;
    if (loop.length < 3) return { code: 'REGION_DEGENERATE_LOOP', index: i };
    if (selfIntersects(loop)) return { code: 'REGION_SELF_INTERSECTING', index: i };
    if (polygonArea(loop) < MIN_LOOP_AREA) return { code: 'REGION_DEGENERATE_LOOP', index: i };
  }
  for (let i = 0; i < loops.length; i++)
    for (let j = i + 1; j < loops.length; j++)
      if (loopsCross(loops[i] as Loop, loops[j] as Loop)) return { code: 'REGION_LOOPS_CROSS', index: j };
  return null;
}

/** True when an edge of loop `a` properly crosses an edge of loop `b`. */
export function loopsCross(a: Loop, b: Loop): boolean {
  return a.some((p, i) => {
    const q = a[(i + 1) % a.length] as Vec2;
    return b.some((r, j) => segmentsIntersect(p, q, r, b[(j + 1) % b.length] as Vec2));
  });
}

type Segment = [[number, number], [number, number]];

/**
 * Pattern lines of a hatched region in its local plane (even-odd clipped): `lines` at `angle`, `cross` at `angle` and `angle + 90°`;
 * none for `solid` (filled by the renderer) or an unhatched region.
 */
export function regionHatchLines(region: { readonly loops: RegionEntity['loops']; readonly hatch?: RegionHatch | undefined }): Segment[] {
  const { hatch, loops } = region;
  if (hatch === undefined || hatch.pattern === 'solid') return [];
  const lines = cappedHatch(loops, hatch.angle, hatch.spacing);
  return hatch.pattern === 'lines' ? lines : [...lines, ...cappedHatch(loops, hatch.angle + Math.PI / 2, hatch.spacing)];
}
