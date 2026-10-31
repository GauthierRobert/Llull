/**
 * Radius laws of edge blends (BLD M1, TECHNICAL_SPEC §5.1): validation with stable codes, deterministic sampling of an expression law,
 * periodic closure on closed edges and chord <-> radius conversion. Pure: no kernel, no document.
 * @invariant a resolved law is an `EdgeRadius` the kernel reads as is: sizes > 0, interior `t` strictly increasing inside (0, 1)
 */

import { evaluateExpression } from '../../lib/expression';
import type { EdgeRadius, Vec3 } from '../../model/types';
import { type Station, monotoneMaxSlope, monotoneRadius } from './monotone';

/** A radius law as the command parameters give it (`edges[]` entries without their edge selector). */
export interface LawInput {
  readonly size?: number | undefined;
  readonly sizeEnd?: number | undefined;
  readonly sizes?: ReadonlyArray<{ readonly t: number; readonly size: number }> | undefined;
  readonly interpolation?: 'smooth' | 'linear' | 'monotone' | undefined;
  readonly law?: { readonly expression: string; readonly samples?: number | undefined } | undefined;
  readonly size2?: number | undefined;
}

type LawProblemCode = 'BLD_LAW_INVALID' | 'BLD_LAW_NOT_PERIODIC' | 'BLD_LAW_TOO_STEEP';

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

/**
 * The interpolation a law keeps: "linear" (straight pieces), "monotone" (the exact C1 cubic; a constant law has nothing to interpolate and drops it), else the default.
 */
function interpolationOf(value: LawInput['interpolation'], varies: boolean): { interpolation?: 'linear' | 'monotone' } {
  if (value === 'linear') return { interpolation: 'linear' };
  return value === 'monotone' && varies ? { interpolation: 'monotone' } : {};
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
    ...interpolationOf(input.interpolation, sizes.length > 0 || sizeEnd !== undefined),
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
    ...interpolationOf(input.interpolation, true),
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

/** Radius of `law` at relative position `t` in [0, 1]: the exact monotone curve for `monotone`, straight pieces for `linear`, else linear between the ends when there are no control points (smooth interpolation through control points is the kernel's, approximated here by the straight pieces). */
export function radiusAt(law: EdgeRadius, t: number): number {
  const [start, end] = lawEnds(law);
  const points = [{ t: 0, size: start }, ...(law.sizes ?? []), { t: 1, size: end }];
  if (law.interpolation === 'monotone') return monotoneRadius(points, t);
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

/** Distance (document units) of the first node from an end or kink of a straight-piece law in the OCP export (`lawNodes`). */
const STRAIGHT_BLEND = 1e-5;
/** Growth of the node spacing away from an end or kink. */
const STRAIGHT_GROWTH = 1.5;

/** Nodes per piece of a monotone law in the OCP export (the stations plus these, on the exact curve). */
const MONOTONE_EXPORT_NODES = 12;

/** The stations of a monotone law and `MONOTONE_EXPORT_NODES` points of its exact curve inside every piece: OCP's cubic spline through them follows the curve to about 1e-5 relative. */
function monotoneNodes(stations: ReadonlyArray<readonly [number, number]>): Array<readonly [number, number]> {
  const points: Station[] = stations.map(([t, size]) => ({ t, size }));
  const nodes: Array<readonly [number, number]> = [];
  for (let piece = 0; piece + 1 < points.length; piece++) {
    const [from, to] = [points[piece] as Station, points[piece + 1] as Station];
    nodes.push([from.t, from.size]);
    for (let k = 1; k <= MONOTONE_EXPORT_NODES; k++) {
      const t = from.t + ((to.t - from.t) * k) / (MONOTONE_EXPORT_NODES + 1);
      nodes.push([t, monotoneRadius(points, t)]);
    }
  }
  const end = points[points.length - 1] as Station;
  nodes.push([end.t, end.size]);
  return nodes;
}

/**
 * The (relative position, radius) nodes the generated OCP code gives `BRepFilletAPI_MakeFillet.Add` for `law` on an edge of `length`, or null
 * when it takes the law as plain radii (constant, or start -> end). OCP can only interpolate nodes with a cubic spline of zero end slopes, so
 * straight pieces (`interpolation: "linear"`) are sent as graded nodes along the polyline: the radius stays within 1.1e-7 mm of the straight
 * law for a 1 to 2 mm radius (8.6e-7 mm across a kink; measured, 13.15). The native kernel builds the exact straight law itself (TECHNICAL_SPEC 13.15).
 */
export function lawNodes(law: EdgeRadius, length: number): ReadonlyArray<readonly [number, number]> | null {
  const [start, end] = lawEnds(law);
  const points = law.sizes ?? [];
  const exact = law.interpolation === 'linear' || law.interpolation === 'monotone';
  if (points.length === 0 && (!exact || law.sizeEnd === undefined)) return null;
  const corners: Array<readonly [number, number]> = [
    [0, start],
    ...points.map((point): [number, number] => [point.t, point.size]),
    [1, end],
  ];
  if (law.interpolation === 'monotone') return monotoneNodes(corners);
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

/** `law` run from its end to its start: sizes swapped and control points mirrored (t -> 1 - t); the same law seen from the other end of the edge. */
export function reverseLaw(law: EdgeRadius): EdgeRadius {
  const { size, sizeEnd = size, sizes, ...rest } = law;
  return {
    ...rest,
    size: sizeEnd,
    sizeEnd: size,
    ...(sizes === undefined ? {} : { sizes: sizes.map((point) => ({ t: 1 - point.t, size: point.size })).reverse() }),
  };
}

/** Slope (radius per unit length along the edge) a blend law cannot exceed: a ball rolling on a spine whose radius changes as fast as it advances has no solution. */
const MAX_LAW_SLOPE = 1;

/** Largest |dr/ds| of `law` on an edge of `length`: the steepest straight piece, or the steepest point of the monotone curve through the stations (the kernel's smooth law is estimated by it). */
export function lawMaxSlope(law: EdgeRadius, length: number): number {
  const [start, end] = lawEnds(law);
  const stations: Station[] = [{ t: 0, size: start }, ...(law.sizes ?? []), { t: 1, size: end }];
  if (law.interpolation === 'linear') {
    let steepest = 0;
    for (let k = 0; k + 1 < stations.length; k++) {
      const [a, b] = [stations[k] as Station, stations[k + 1] as Station];
      steepest = Math.max(steepest, Math.abs(b.size - a.size) / (b.t - a.t));
    }
    return steepest / length;
  }
  return monotoneMaxSlope(stations) / length;
}

/** The law is too steep for an edge of `length`: the radius would change as fast as the ball advances (BLD_LAW_TOO_STEEP), with the measured slope and the length that would carry it. */
export function steepProblem(law: EdgeRadius, length: number): LawProblem | null {
  if (!(length > 0)) return null;
  const slope = lawMaxSlope(law, length);
  if (slope < MAX_LAW_SLOPE) return null;
  const [start, end] = lawEnds(law);
  const spread =
    Math.max(start, end, ...(law.sizes ?? []).map((point) => point.size)) -
    Math.min(start, end, ...(law.sizes ?? []).map((point) => point.size));
  return {
    code: 'BLD_LAW_TOO_STEEP',
    message: `the radius changes as fast as the ball advances: its steepest slope is ${slope.toFixed(3)} (must stay below ${MAX_LAW_SLOPE}) on an edge of length ${length}; a law that spans ${spread} needs an edge of about ${(spread / (0.5 * MAX_LAW_SLOPE)).toFixed(3)} or more`,
    path: 'sizes',
  };
}
