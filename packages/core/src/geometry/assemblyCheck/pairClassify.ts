/**
 * Pairwise classes (FR-FPR-03): broad phase (sweep and prune on x, then y, z) and narrow phase (kernel distance, overlap volume through the
 * recipe path `intersect`, TR-FPR-03).
 * @invariant pairs come out in (i < j) order of the part list: deterministic
 * @invariant touch (zero volume) is never reported as hard, on either kernel
 */

import type { CheckItem } from '../../model/checkResult';
import type { Vec3 } from '../../model/types';
import type { GeometryKernel, ShapeDistance } from '../kernel';
import { type AssemblyPart, type CheckTolerances } from './partTypes';
import { makeItem } from './partValidity';
import { scale3 } from '../../lib/vec3';

type PairKind = 'hard' | 'containment' | 'touch' | 'clearance';

export interface PairClass {
  readonly kind: PairKind;
  /** Overlap volume (document units cubed). */
  readonly volume: number;
  /** Surface distance (document units); 0 when touching or overlapping. */
  readonly distance: number;
  /** Estimated penetration depth (document units); 0 unless hard. */
  readonly penetration: number;
  readonly pointA: Vec3;
  readonly pointB: Vec3;
}

/** Index pairs (i < j) of parts whose bounds, grown by `margin` once (gap between boxes), overlap. */
export function candidatePairs(parts: readonly AssemblyPart[], margin: number): Array<[number, number]> {
  const order = parts.map((_, index) => index).sort((p, q) => (parts[p]?.min[0] ?? 0) - (parts[q]?.min[0] ?? 0) || p - q);
  const pairs: Array<[number, number]> = [];
  for (let a = 0; a < order.length; a++) {
    const first = parts[order[a] ?? 0];
    if (first === undefined) continue;
    for (let b = a + 1; b < order.length; b++) {
      const second = parts[order[b] ?? 0];
      if (second === undefined || second.min[0] > first.max[0] + margin) break;
      const overlaps = ([1, 2] as const).every(
        (axis) => second.min[axis] <= first.max[axis] + margin && first.min[axis] <= second.max[axis] + margin,
      );
      if (overlaps) {
        const [i, j] = [order[a] ?? 0, order[b] ?? 0];
        pairs.push(i < j ? [i, j] : [j, i]);
      }
    }
  }
  return pairs.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
}

const ZERO_DISTANCE = 1e-12;

export function overlapOf(kernel: GeometryKernel, a: AssemblyPart, b: AssemblyPart): { volume: number; depth: number } | null {
  const analyze = kernel.analyze?.bind(kernel);
  if (analyze === undefined) return null;
  const shape = kernel.evaluate({ op: 'boolean', boolean: 'intersect', a: a.recipe, b: b.recipe });
  if (shape === null) return null;
  const analysis = analyze(shape);
  if (analysis === null || !analysis.valid) return null;
  const mins = analysis.lumps.reduce<Vec3>(
    (acc, lump) => [Math.min(acc[0], lump.bounds.min[0]), Math.min(acc[1], lump.bounds.min[1]), Math.min(acc[2], lump.bounds.min[2])],
    [Infinity, Infinity, Infinity],
  );
  const maxs = analysis.lumps.reduce<Vec3>(
    (acc, lump) => [Math.max(acc[0], lump.bounds.max[0]), Math.max(acc[1], lump.bounds.max[1]), Math.max(acc[2], lump.bounds.max[2])],
    [-Infinity, -Infinity, -Infinity],
  );
  const extent = [0, 1, 2].map((k) => Math.max((maxs[k] ?? 0) - (mins[k] ?? 0), 0));
  const depths = [0, 1, 2].map((k) => {
    const cross = (extent[(k + 1) % 3] ?? 0) * (extent[(k + 2) % 3] ?? 0);
    return cross > 0 ? analysis.volume / cross : Infinity;
  });
  return { volume: analysis.volume, depth: Math.min(...depths) };
}

/**
 * Classify one pair; undefined = no relation within the tolerances; null = the kernel cannot tell (distance / analyze missing or failed).
 */
export function classifyPair(
  kernel: GeometryKernel,
  a: AssemblyPart,
  b: AssemblyPart,
  volumeA: number,
  volumeB: number,
  tolerances: CheckTolerances,
): PairClass | null | undefined {
  const distance: ShapeDistance | null = kernel.distance?.(a.shape, b.shape, tolerances.clearance + tolerances.epsTouch) ?? null;
  if (distance === null) return null;
  const base = { pointA: distance.pointA, pointB: distance.pointB };
  if (distance.inside || distance.distance <= ZERO_DISTANCE) {
    const overlap = overlapOf(kernel, a, b);
    if (overlap === null) return null;
    const smaller = Math.min(volumeA, volumeB);
    if (overlap.volume >= tolerances.containmentRatio * smaller)
      return { kind: 'containment', volume: overlap.volume, distance: 0, penetration: 0, ...base };
    if (overlap.volume > tolerances.volumeRelative * smaller)
      return { kind: 'hard', volume: overlap.volume, distance: 0, penetration: overlap.depth, ...base };
    return { kind: 'touch', volume: 0, distance: 0, penetration: 0, ...base };
  }
  if (distance.distance <= tolerances.epsTouch) return { kind: 'touch', volume: 0, distance: distance.distance, penetration: 0, ...base };
  if (distance.distance < tolerances.clearance)
    return { kind: 'clearance', volume: 0, distance: distance.distance, penetration: 0, ...base };
  return undefined;
}

export interface PairIntent {
  readonly id: string;
  readonly kind: string;
  readonly reason: string;
  readonly declaredBy: string;
}

const CODES: Readonly<Record<PairKind, string>> = {
  hard: 'FPR_PAIR_HARD',
  containment: 'FPR_PAIR_CONTAINED',
  touch: 'FPR_PAIR_TOUCH',
  clearance: 'FPR_PAIR_CLEARANCE',
};

/** The item of a classified pair; a declared intent turns hard / containment into `FPR_PAIR_ALLOWED` (pass). */
export function pairItem(pair: PairClass, ids: readonly [string, string], tolerances: CheckTolerances, intent?: PairIntent): CheckItem {
  const { mmPerUnit } = tolerances;
  const values: Record<string, number> = { overlapVolumeMm3: pair.volume * mmPerUnit ** 3, minDistanceMm: pair.distance * mmPerUnit };
  if (pair.kind === 'hard') values['penetrationEstimateMm'] = pair.penetration * mmPerUnit;
  const witness = { pointsMm: [scale3(pair.pointA, mmPerUnit), scale3(pair.pointB, mmPerUnit)] };
  if (intent !== undefined && (pair.kind === 'hard' || pair.kind === 'containment'))
    return makeItem(
      'FPR_PAIR_ALLOWED',
      'pass',
      ids,
      `Declared ${intent.kind}: ${intent.reason}. Remove with delete_interference_intent when it no longer applies.`,
      { values, witness, intent },
    );
  const code = CODES[pair.kind];
  switch (pair.kind) {
    case 'hard':
      return makeItem(
        code,
        'fail',
        ids,
        'Move or resize one part, or declare the overlap with allow_interference (press fit, thread, weld) and a reason.',
        { values, witness, note: 'penetration depth is an estimate (volume over the projected overlap area)' },
      );
    case 'containment':
      return makeItem(
        code,
        'fail',
        ids,
        'One part sits inside the other: remove the duplicate, subtract it, or declare it with allow_interference.',
        { values, witness },
      );
    case 'touch':
      return makeItem(code, 'info', ids, 'Parts touch with zero overlap volume; add a joint or fastener if they must stay together.', {
        values,
        witness,
      });
    case 'clearance':
      return makeItem(code, 'warn', ids, 'Increase the gap above the required clearance, or lower clearanceMm.', {
        values,
        witness,
        threshold: { value: tolerances.clearance * mmPerUnit, unit: 'mm', source: 'clearanceMm parameter', grade: 'A', defaulted: false },
      });
  }
}
