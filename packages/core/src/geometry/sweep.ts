/**
 * Sweep tessellation shared by export, kernels' mesh path and the viewport: the section is carried along the sampled path by the frames of
 * ./sweepEval (rotation-minimizing by default), scaled / twisted by the sweep's laws. Variable sections (`stations`) blend section rings
 * (./sectionRing) along the arc length and are skinned by ./skin.
 */

import type { SweepSection, Vec2, Vec3 } from '../model/types';
import { add3, cross3, dot3, scale3 } from '../lib/vec3';
import { triangulatePolygon } from '../lib/triangulate';
import { isClosedChain } from './curveSegments';
import { quad, ringWalls as walls, skinTriangles } from './skin';
import type { Triangle } from './triangles';
import { evaluateSweep, type SweepEvaluation, type SweepShape } from './sweepEval/evaluate';
import type { SweepFrame } from './sweepEval/frames';
import { transformPoint } from './sweepEval/laws';
import { sectionLoops, stationLoopAt } from './sweepEval/sections';

export { frameAtFraction, sweepFrames } from './sweepEval/frames';
export { stationRingAt } from './sweepEval/sections';
export type { SweepShape } from './sweepEval/evaluate';

/** Section loop placed at frame `i` (laws applied, `origin` added). */
function placeLoop(evaluation: SweepEvaluation, i: number, loop: readonly Vec2[], origin: Vec3): Vec3[] {
  const frame = evaluation.frames[i] as SweepFrame;
  const transform = evaluation.transforms?.[i];
  return loop.map((p) => {
    const [x, y] = transform === undefined ? p : transformPoint(p, transform);
    return add3(origin, add3(frame.origin ?? frame.point, add3(scale3(frame.normal, x), scale3(frame.binormal, y))));
  });
}

/** Section loop (constant or blended from the stations) of a sweep at frame `i`. */
function loopAt(sweep: SweepShape, outer: Vec2[], fractions: readonly number[], i: number): Vec2[] {
  const { stations } = sweep;
  return stations !== undefined && stations.length >= 2 ? stationLoopAt(stations, fractions[i] as number, sweep.stationBlend) : outer;
}

/**
 * Outer section rings grouped per path segment (each group includes the joint ring it starts from), carried by the same continuous frames
 * as `sweepTriangles`.
 */
export function sweepSegmentRings(sweep: SweepShape): Vec3[][] {
  const evaluation = evaluateSweep(sweep);
  if (!('frames' in evaluation)) return [];
  const { frames, fractions } = evaluation;
  const { outer } = sectionLoops(sweep.section as SweepSection);
  return sweep.path.map((_, index) =>
    frames.flatMap((frame, i) =>
      frame.segment === index || frames[i + 1]?.segment === index
        ? placeLoop(evaluation, i, loopAt(sweep, outer, fractions, i), [0, 0, 0])
        : [],
    ),
  );
}

/** Walls of a sweep round a closed path: consecutive rings joined, the last back to the first. */
function closedWalls(outerRings: Vec3[][], innerRings: Vec3[][] | null, alternate: boolean): Triangle[] {
  const triangles: Triangle[] = [];
  for (let i = 0; i < outerRings.length; i++) {
    const next = (i + 1) % outerRings.length;
    triangles.push(...walls(outerRings[i] as Vec3[], outerRings[next] as Vec3[], false, alternate ? i : undefined));
    if (innerRings !== null) triangles.push(...walls(innerRings[i] as Vec3[], innerRings[next] as Vec3[], true, alternate ? i : undefined));
  }
  return triangles;
}

/** Closed, outward-wound triangles of a sweep; `origin` is added to every vertex.
 * @invariant shared ring vertices are the same Vec3 values, so the soup welds watertight; a frame mode whose section winding opposes the travel is flipped outward
 * @failure a degenerate frame mode or an invalid law -> no triangles
 */
export function sweepTriangles(sweep: SweepShape, origin: Vec3 = [0, 0, 0]): Triangle[] {
  const triangles = ringTriangles(sweep, origin);
  if (sweep.orientation === undefined || sweep.orientation.mode === 'minimal') return triangles;
  const volume = triangles.reduce((sum, [a, b, c]) => sum + dot3(a, cross3(b, c)), 0);
  return volume < 0 ? triangles.map(([a, b, c]): Triangle => [a, c, b]) : triangles;
}

function ringTriangles(sweep: SweepShape, origin: Vec3): Triangle[] {
  const evaluation = evaluateSweep(sweep);
  if (!('frames' in evaluation)) return [];
  const { frames, fractions } = evaluation;
  const { path, section, stations } = sweep;
  if (stations !== undefined && stations.length >= 2)
    return skinTriangles(
      frames.map((_, i) => placeLoop(evaluation, i, stationLoopAt(stations, fractions[i] as number, sweep.stationBlend), origin)),
    );
  const { outer, inner } = sectionLoops(section);
  if (frames.length < 2 || outer.length < 3) return [];
  const outerRings = frames.map((_, i) => placeLoop(evaluation, i, outer, origin));
  const innerRings = inner === null ? null : frames.map((_, i) => placeLoop(evaluation, i, inner, origin));
  const alternate = evaluation.transforms !== null;
  if (isClosedChain(path)) return closedWalls(outerRings, innerRings, alternate);
  const triangles: Triangle[] = [];
  for (let i = 0; i + 1 < frames.length; i++) {
    triangles.push(...walls(outerRings[i] as Vec3[], outerRings[i + 1] as Vec3[], false, alternate ? i : undefined));
    if (innerRings !== null)
      triangles.push(...walls(innerRings[i] as Vec3[], innerRings[i + 1] as Vec3[], true, alternate ? i : undefined));
  }
  const [startOuter, endOuter] = [outerRings[0] as Vec3[], outerRings[frames.length - 1] as Vec3[]];
  if (innerRings !== null) {
    const [startInner, endInner] = [innerRings[0] as Vec3[], innerRings[frames.length - 1] as Vec3[]];
    outer.forEach((_, j) => {
      const k = (j + 1) % outer.length;
      const at = (ring: Vec3[], index: number): Vec3 => ring[index] as Vec3;
      triangles.push(...quad(at(endOuter, j), at(endOuter, k), at(endInner, k), at(endInner, j)));
      triangles.push(...quad(at(startInner, j), at(startInner, k), at(startOuter, k), at(startOuter, j)));
    });
    return triangles;
  }
  for (const [a, b, c] of triangulatePolygon(outer).triangles) {
    const pick = (ring: Vec3[], index: number): Vec3 => ring[index] as Vec3;
    triangles.push([pick(endOuter, a), pick(endOuter, b), pick(endOuter, c)]);
    triangles.push([pick(startOuter, a), pick(startOuter, c), pick(startOuter, b)]);
  }
  return triangles;
}
