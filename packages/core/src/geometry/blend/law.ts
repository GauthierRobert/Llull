/**
 * Radius laws of edge blends (BLD M1, TECHNICAL_SPEC §5.1): validation with stable codes, deterministic sampling of an expression law,
 * periodic closure on closed edges and chord <-> radius conversion. Pure: no kernel, no document.
 * @invariant a resolved law is an `EdgeRadius` the kernel reads as is: sizes > 0, interior `t` strictly increasing inside (0, 1)
 */

import { evaluateExpression } from '../../lib/expression';
import type { EdgeRadius, Vec3 } from '../../model/types';

/** A radius law as the command parameters give it (`edges[]` entries without their edge selector). */
export interface LawInput {
  readonly size?: number | undefined;
  readonly sizeEnd?: number | undefined;
  readonly sizes?: ReadonlyArray<{ readonly t: number; readonly size: number }> | undefined;
  readonly interpolation?: 'smooth' | 'linear' | undefined;
  readonly law?: { readonly expression: string; readonly samples?: number | undefined } | undefined;
  readonly size2?: number | undefined;
}

type LawProblemCode = 'BLD_LAW_INVALID' | 'BLD_LAW_NOT_PERIODIC';

export interface LawProblem {
  readonly code: LawProblemCode;
  readonly message: string;
  /** Param path below the edge entry (`size`, `sizes[1]`, `law.expression`). */
  readonly path: string;
}

export const DEFAULT_LAW_SAMPLES = 33;
export const MIN_LAW_SAMPLES = 5;
export const MAX_LAW_SAMPLES = 257;
/** Largest relative difference between the first and last radius of a law on a closed chain (named default, TECHNICAL_SPEC §5.10). */
const PERIODIC_CLOSURE = 1e-9;

const positive = (value: number): boolean => Number.isFinite(value) && value > 0;

const invalid = (message: string, path: string): LawProblem => ({ code: 'BLD_LAW_INVALID', message, path });

/** `r(t_k)` of the expression at `t_k = k / (n - 1)`, k = 0..n-1; a problem when it does not parse, uses a name other than `t`, or is not finite and > 0. */
export function sampleExpression(expression: string, samples: number): readonly number[] | LawProblem {
  if (!Number.isInteger(samples) || samples < MIN_LAW_SAMPLES || samples > MAX_LAW_SAMPLES)
    return invalid(`law.samples must be an integer in ${MIN_LAW_SAMPLES}..${MAX_LAW_SAMPLES} (got ${samples})`, 'law.samples');
  const values: number[] = [];
  for (let k = 0; k < samples; k++) {
    const t = k / (samples - 1);
    const result = evaluateExpression(expression, { t });
    if (!result.ok)
      return invalid(
        `law.expression "${expression}" at t = ${t}: ${result.error} (use t in [0, 1], pi, and the built-in functions)`,
        'law.expression',
      );
    if (!positive(result.value))
      return invalid(`law.expression "${expression}" is ${result.value} at t = ${t}; a radius must be > 0`, 'law.expression');
    values.push(result.value);
  }
  return values;
}

/** The explicit law of `input` (size, sizeEnd, sizes), or why it is not usable. */
function explicitLaw(input: LawInput): EdgeRadius | LawProblem {
  const { size, sizeEnd, sizes = [] } = input;
  if (size === undefined || !positive(size)) return invalid(`size must be > 0 (got ${String(size)})`, 'size');
  if (sizeEnd !== undefined && !positive(sizeEnd)) return invalid(`sizeEnd must be > 0 (got ${sizeEnd})`, 'sizeEnd');
  let previous = 0;
  for (const [at, point] of sizes.entries()) {
    if (!(point.t > previous) || !(point.t < 1))
      return invalid(`sizes[${at}].t must be strictly increasing inside (0, 1) (got ${point.t})`, `sizes[${at}].t`);
    if (!positive(point.size)) return invalid(`sizes[${at}].size must be > 0 (got ${point.size})`, `sizes[${at}].size`);
    previous = point.t;
  }
  if (input.size2 !== undefined && !positive(input.size2)) return invalid(`size2 must be > 0 (got ${input.size2})`, 'size2');
  return {
    size,
    ...(sizeEnd === undefined ? {} : { sizeEnd }),
    ...(sizes.length === 0 ? {} : { sizes }),
    ...(input.interpolation === 'linear' ? { interpolation: 'linear' as const } : {}),
    ...(input.size2 === undefined ? {} : { size2: input.size2 }),
  };
}

/** The `EdgeRadius` of `input`: an expression law sampled at `samples` uniform points (first = size, last = sizeEnd, the rest = sizes), else the explicit law. */
export function resolveLaw(input: LawInput): EdgeRadius | LawProblem {
  if (input.law === undefined) return explicitLaw(input);
  if (input.size2 !== undefined) return invalid('size2 is the second leg of a size: give size (not law)', 'size2');
  if (input.size !== undefined || input.sizeEnd !== undefined || (input.sizes?.length ?? 0) > 0)
    return invalid('give either law (an expression of t) or size / sizeEnd / sizes, not both', 'law');
  const sampled = sampleExpression(input.law.expression, input.law.samples ?? DEFAULT_LAW_SAMPLES);
  if (!Array.isArray(sampled)) return sampled as LawProblem;
  const values = sampled as readonly number[];
  const count = values.length;
  return {
    size: values[0] ?? 0,
    sizeEnd: values[count - 1] ?? 0,
    sizes: values.slice(1, -1).map((size, k) => ({ t: (k + 1) / (count - 1), size })),
    ...(input.interpolation === 'linear' ? { interpolation: 'linear' as const } : {}),
  };
}

/** Whether an edge starts where it ends (a rim, a full circle): its law is periodic. */
export function closedEdge(edge: {
  readonly start: Vec3;
  readonly end: Vec3;
  readonly length: number;
  readonly seam: boolean;
  readonly degenerate: boolean;
}): boolean {
  if (edge.seam || edge.degenerate) return false;
  const gap = Math.hypot(edge.start[0] - edge.end[0], edge.start[1] - edge.end[1], edge.start[2] - edge.end[2]);
  return gap <= 1e-9 * Math.max(edge.length, 1);
}

export const isLawProblem = (value: EdgeRadius | LawProblem): value is LawProblem => 'code' in value;

/** Radius at the start and the end of a law (a constant law ends where it starts). */
export const lawEnds = (law: EdgeRadius): readonly [number, number] => [law.size, law.sizeEnd ?? law.size];

/** A law on a closed edge or chain must close on itself: `r(0) = r(1)` within `PERIODIC_CLOSURE` of the size. */
export function periodicProblem(law: EdgeRadius): LawProblem | null {
  const [start, end] = lawEnds(law);
  return Math.abs(start - end) <= PERIODIC_CLOSURE * Math.max(start, end)
    ? null
    : {
        code: 'BLD_LAW_NOT_PERIODIC',
        message: `the edge is closed, so the radius must return to its start: r(0) = ${start} but r(1) = ${end}`,
        path: 'sizeEnd',
      };
}

/** Radius of `law` at relative position `t` in [0, 1]: straight pieces for `linear`, else linear between the ends when there are no control points (smooth interpolation through control points is the kernel's, approximated here by the straight pieces). */
export function radiusAt(law: EdgeRadius, t: number): number {
  const [start, end] = lawEnds(law);
  const points = [{ t: 0, size: start }, ...(law.sizes ?? []), { t: 1, size: end }];
  for (let k = 1; k < points.length; k++) {
    const to = points[k];
    const from = points[k - 1];
    if (to === undefined || from === undefined || t > to.t) continue;
    return to.t === from.t ? to.size : from.size + ((to.size - from.size) * (t - from.t)) / (to.t - from.t);
  }
  return end;
}

/** Control `t` values worth reading back for a law (0, interior points, 1). */
export const controlParameters = (law: EdgeRadius): readonly number[] => [0, ...(law.sizes ?? []).map((point) => point.t), 1];

/** `law` with every size multiplied by `factor`. */
export function scaleLaw(law: EdgeRadius, factor: number): EdgeRadius {
  return {
    ...law,
    size: law.size * factor,
    ...(law.size2 === undefined ? {} : { size2: law.size2 * factor }),
    ...(law.sizeEnd === undefined ? {} : { sizeEnd: law.sizeEnd * factor }),
    ...(law.sizes === undefined ? {} : { sizes: law.sizes.map((point) => ({ t: point.t, size: point.size * factor })) }),
  };
}

/** Number of samples of a chord law on curved faces (TECHNICAL_SPEC §5.2: at least 17). */
export const CHORD_SAMPLES = 17;

/**
 * `law` multiplied by a factor that varies along the edge: `factors[k]` at `t_k = k / (n - 1)`. The result samples the law at the same points
 * (smooth interpolation through them); a constant factor keeps the shape of the law (scaleLaw).
 */
export function lawTimesFactors(law: EdgeRadius, factors: readonly number[]): EdgeRadius {
  const [first] = factors;
  if (first !== undefined && factors.every((factor) => Math.abs(factor - first) <= 1e-9 * Math.abs(first))) return scaleLaw(law, first);
  const count = factors.length;
  const at = (k: number): number => radiusAt(law, k / (count - 1)) * (factors[k] ?? 1);
  return {
    size: at(0),
    sizeEnd: at(count - 1),
    sizes: Array.from({ length: count - 2 }, (_, k) => ({ t: (k + 1) / (count - 1), size: at(k + 1) })),
  };
}

/** Distance (document units) of the first node from an end or kink of a straight-piece law; mirrors `kStraightBlend` of the native kernel. */
const STRAIGHT_BLEND = 1e-5;
/** Growth of the node spacing away from an end or kink; mirrors `kStraightGrowth`. */
const STRAIGHT_GROWTH = 1.5;

/**
 * The (relative position, radius) nodes a kernel interpolates for `law` on an edge of `length`, or null when it takes the law as plain radii
 * (constant, or start -> end). Straight pieces (`interpolation: "linear"`) are sent as graded nodes along the polyline because OCCT's
 * interpolation is a cubic spline with zero end slopes; mirrors `straight_law` of `solver/crates/llull-kernel-occt/cpp/blends.cxx`.
 */
export function lawNodes(law: EdgeRadius, length: number): ReadonlyArray<readonly [number, number]> | null {
  const [start, end] = lawEnds(law);
  const points = law.sizes ?? [];
  if (points.length === 0 && (law.interpolation !== 'linear' || law.sizeEnd === undefined)) return null;
  const corners: Array<readonly [number, number]> = [
    [0, start],
    ...points.map((point): [number, number] => [point.t, point.size]),
    [1, end],
  ];
  if (law.interpolation !== 'linear') return corners;
  const blend = Math.min(STRAIGHT_BLEND / Math.max(length, 1e-9), 0.25 / corners.length);
  const nodes: Array<readonly [number, number]> = [corners[0] ?? [0, start]];
  for (let piece = 0; piece + 1 < corners.length; piece++) {
    const from = corners[piece];
    const to = corners[piece + 1];
    if (from === undefined || to === undefined) continue;
    const at = (t: number): readonly [number, number] => [t, from[1] + ((to[1] - from[1]) * (t - from[0])) / (to[0] - from[0])];
    const inside = new Set<number>();
    for (let offset = blend; offset < (to[0] - from[0]) / 2; offset *= STRAIGHT_GROWTH) {
      inside.add(from[0] + offset);
      inside.add(to[0] - offset);
    }
    inside.add((from[0] + to[0]) / 2);
    for (const t of [...inside].sort((a, b) => a - b)) nodes.push(at(t));
    nodes.push(to);
  }
  return nodes;
}
