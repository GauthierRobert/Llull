/**
 * Classification of a part pair with symmetry reduction and the pair cache (TECHNICAL_SPEC 5.3 steps 3 and 7, TR-ASC-09 / 10).
 * Unit-scale instances of one component are keyed by (local recipe, local recipe, relative placement), oriented so (a, b) and (b, a) share a key:
 * for N rigid copies of a pattern every pair (i, j) then maps to the class of j - i (mod N, folded), i.e. master vs copy d = 1..N/2, and the
 * result is reported for every concrete pair (witness points are mapped back through the instance frames). Other parts are keyed by recipe hashes.
 * @invariant a reused result equals a recompute up to the key quantization (translation 1e-6, rotation 1e-9 document units)
 * @invariant `symmetry: false` keys every pair by its world recipes, so equal placements never share (audit mode)
 */

import type { GeometryKernel } from '../kernel';
import { hashText } from '../../lib/hash';
import { canonicalJson } from '../../lib/canonicalJson';
import { recipeKey } from '../shapeRecipe';
import type { AssemblyPart, CheckTolerances } from './partTypes';
import { type PairClass, classifyPair } from './pairClassify';
import type { PairCache, PairEntry } from './pairCache';
import { frameApply, frameInvert, relativeKey, type RigidFrame } from './rigidFrame';

interface PairStats {
  /** Pairs the kernel classified in this run. */
  evaluated: number;
  /** Pairs served by an earlier pair of the same run (symmetry reduction). */
  reused: number;
  /** Pairs served by the persistent cache. */
  cacheHits: number;
}

export interface PairEvaluator {
  readonly stats: PairStats;
  /** Class of the pair; undefined = no relation; null = the kernel cannot tell. */
  evaluate(a: AssemblyPart, b: AssemblyPart, volumeA: number, volumeB: number): PairClass | null | undefined;
}

interface EvaluatorInput {
  readonly kernel: GeometryKernel;
  readonly tolerances: CheckTolerances;
  readonly symmetry: boolean;
  /** Persistent store; null = the run's own map only. */
  readonly cache: PairCache | null;
  /** Anything else that changes a classification (narrow-phase mode). */
  readonly salt: string;
}

const mapPoints = (pair: PairClass, map: (point: PairClass['pointA']) => PairClass['pointA'], swap: boolean): PairClass => {
  const [pointA, pointB] = [map(pair.pointA), map(pair.pointB)];
  return swap ? { ...pair, pointA: pointB, pointB: pointA } : { ...pair, pointA, pointB };
};

export function createPairEvaluator(input: EvaluatorInput): PairEvaluator {
  const { kernel, tolerances, symmetry, cache } = input;
  const scope = hashText(canonicalJson({ tolerances, kernel: kernel.name ?? null, salt: input.salt }));
  const run = new Map<string, PairEntry>();
  const hashes = new Map<string, string>();
  const stats: PairStats = { evaluated: 0, reused: 0, cacheHits: 0 };
  const hashOf = (part: AssemblyPart): string => {
    let known = hashes.get(part.id);
    if (known === undefined) {
      known = hashText(recipeKey(part.recipe));
      hashes.set(part.id, known);
    }
    return known;
  };
  return {
    stats,
    evaluate(a, b, volumeA, volumeB) {
      const framed = symmetry && a.frame !== undefined && b.frame !== undefined && a.localKey !== undefined && b.localKey !== undefined;
      let swapped = false;
      let key = `${scope}|w|${hashOf(a)}|${hashOf(b)}`;
      if (framed) {
        const forward = `${a.localKey}|${b.localKey}|${relativeKey(a.frame as RigidFrame, b.frame as RigidFrame)}`;
        const backward = `${b.localKey}|${a.localKey}|${relativeKey(b.frame as RigidFrame, a.frame as RigidFrame)}`;
        swapped = backward < forward;
        key = `${scope}|i|${swapped ? backward : forward}`;
      }
      const [first, second] = swapped ? [b, a] : [a, b];
      const [volumeFirst, volumeSecond] = swapped ? [volumeB, volumeA] : [volumeA, volumeB];
      const frame = framed ? (first.frame ?? null) : null;
      const compute = (): PairEntry => {
        stats.evaluated++;
        const pair = classifyPair(kernel, first, second, volumeFirst, volumeSecond, tolerances);
        return {
          pair: pair === null || pair === undefined || frame === null ? pair : mapPoints(pair, (p) => frameInvert(frame, p), false),
        };
      };
      let entry = run.get(key);
      if (entry !== undefined) stats.reused++;
      else {
        const stored = cache === null ? { entry: compute(), hit: false } : cache.getOrCompute(key, compute);
        if (stored.hit) stats.cacheHits++;
        entry = stored.entry;
        run.set(key, entry);
      }
      const { pair } = entry;
      if (pair === null || pair === undefined) return pair;
      return mapPoints(pair, frame === null ? (p) => p : (p) => frameApply(frame, p), swapped);
    },
  };
}
