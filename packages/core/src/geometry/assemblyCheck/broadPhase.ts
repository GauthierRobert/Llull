/**
 * Broad phase of `check_assembly` (TECHNICAL_SPEC 5.3 steps 1-2, TR-ASC-07): BVH over the part boxes (sort-and-sweep below `SWEEP_LIMIT`
 * parts), then the OBB separating-axis test.
 * @invariant pairs (i < j) come out in ascending order; a pair is dropped only when its parts are provably further apart than `margin`: boxes and
 *   OBBs come from the display mesh, so every separation test grows by both parts' chord bound (a curved solid sticks out of its tessellation)
 * @invariant the BVH comes from the injected `SpatialIndexPort` (the TypeScript build when absent): same pairs on every port
 */

import type { AssemblyPart } from './partTypes';
import { candidatePairs } from './pairClassify';
import { type Obb, obbOfMesh, obbsSeparated } from './obb';
import { chordBound } from './chordBound';
import { packBoxes } from '../instanceBvh';
import { type SpatialIndexPort, resolveSpatialIndex } from '../spatialIndex';

/** Part count below which sort-and-sweep beats building a tree. */
const SWEEP_LIMIT = 200;

/** The part boxes grown by each part's chord bound: a curved solid sticks out of its tessellation by that much. */
const inflated = (parts: readonly AssemblyPart[]): AssemblyPart[] =>
  parts.map((part) => {
    const grow = chordBound(part);
    return {
      ...part,
      min: [part.min[0] - grow, part.min[1] - grow, part.min[2] - grow],
      max: [part.max[0] + grow, part.max[1] + grow, part.max[2] + grow],
    };
  });

function aabbPairs(parts: readonly AssemblyPart[], margin: number, port: SpatialIndexPort | null | undefined): Array<[number, number]> {
  const grown = inflated(parts);
  if (grown.length < SWEEP_LIMIT) return candidatePairs(grown, margin);
  const bvh = resolveSpatialIndex(port).build(packBoxes(grown));
  const pairs: Array<[number, number]> = [];
  grown.forEach((part, i) => {
    const low: [number, number, number] = [part.min[0] - margin, part.min[1] - margin, part.min[2] - margin];
    const high: [number, number, number] = [part.max[0] + margin, part.max[1] + margin, part.max[2] + margin];
    for (const j of bvh.boxQuery(low, high)) if (j > i) pairs.push([i, j]);
  });
  return pairs;
}

/** Candidate index pairs of `parts` whose boxes meet within `margin` plus both parts' chord bounds, BVH then OBB. */
export function broadPhasePairs(parts: readonly AssemblyPart[], margin: number, port?: SpatialIndexPort | null): Array<[number, number]> {
  const boxes = new Map<number, Obb | null>();
  const boxOf = (index: number): Obb | null => {
    if (!boxes.has(index)) boxes.set(index, obbOfMesh(parts[index]?.mesh ?? null));
    return boxes.get(index) ?? null;
  };
  return aabbPairs(parts, margin, port).filter(([i, j]) => {
    const [a, b, partA, partB] = [boxOf(i), boxOf(j), parts[i], parts[j]];
    if (a === null || b === null || partA === undefined || partB === undefined) return true;
    return !obbsSeparated(a, b, margin + chordBound(partA) + chordBound(partB));
  });
}
