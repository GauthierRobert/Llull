/**
 * One size law over a tangent chain of edges for fillet_faces (BLD M4 left, TECHNICAL_SPEC 13.27): when the two face sets share several sharp edges that form ONE tangent chain (an open path or a closed loop whose joints
 * are tangent), the law runs along the chain's total arc length and is handed to fillet_edge as one sub-law per edge, continuous at the joints.
 *  - radiusEnd / widthEnd (a straight law in arc length): each edge gets the straight piece between the values at its two ends, so the value AND the slope are those of the one law at every joint (exact in the kernel);
 *  - law (an expression of t in [0, 1] along the chain): each edge gets `samples` stations of the expression at its own arc fractions, joined by straight pieces (`interpolation: "linear"`), so the value at every joint is the expression's
 *    and the slope differs from it by O(h) of the station spacing.
 * @invariant the chain is the seeds exactly (every shared edge, one path or one loop, every joint tangent within JOINT_TANGENT_RAD); t = 0 is the chain end nearest startNear, else the end of the lowest-numbered edge; a loop starts at the start of the lowest-numbered edge and its law is periodic
 * @failure several chains, a branch (3 edges at a vertex), a joint that is not tangent, startNear on a loop, a loop whose law does not close, an edge the kernel cannot sample -> a reason with the param it is about
 */

import { evaluateExpression } from '../../lib/expression';
import { distance3 } from '../../lib/vec3';
import type { Vec3 } from '../../model/types';
import { DEFAULT_LAW_SAMPLES, MAX_LAW_SAMPLES, MIN_LAW_SAMPLES, sampleExpression } from '../../geometry/blend/law';
import type { EdgeLawInput } from './filletSpec';
import type { BlendContext } from './faceBlendRun';

/** Largest angle between the two edges at a joint of the chain (rad): the kernel chains edges that continue each other to about 0.1 rad (13.13.2); a size law over a creased chain is not offered. */
const JOINT_TANGENT_RAD = 0.01;
/** Two chain ends are the same vertex within this fraction of the longest edge. */
const JOINT_GAP = 1e-6;

export interface ChainEdge {
  readonly index: number;
  /** The edge is walked from its own start to its end (else from its end to its start). */
  readonly forward: boolean;
  readonly length: number;
  /** Arc fractions of the chain at the walked start and end of the edge. */
  readonly from: number;
  readonly to: number;
}

export interface ChainPlan {
  readonly edges: readonly ChainEdge[];
  readonly closed: boolean;
  readonly total: number;
}

export interface ChainProblem {
  readonly problem: string;
  readonly path: string;
}

interface End {
  readonly edge: number;
  /** 0 = the start of the edge, 1 = its end. */
  readonly side: 0 | 1;
  readonly point: Vec3;
  /** Unit tangent pointing into the edge from this end. */
  readonly into: Vec3;
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** The two ends of each seed with the direction they leave along the edge, or null when the kernel cannot sample one. */
function endsOf(context: BlendContext, seeds: readonly number[]): End[] | null {
  const ends: End[] = [];
  for (const edge of seeds) {
    const samples = context.kernel.faceQuery?.edgeSamples(context.shape, edge, 2) ?? null;
    const first = samples?.[0];
    const last = samples?.[samples.length - 1];
    if (first === undefined || last === undefined) return null;
    ends.push({ edge, side: 0, point: first.point, into: first.tangent });
    ends.push({ edge, side: 1, point: last.point, into: [-last.tangent[0], -last.tangent[1], -last.tangent[2]] });
  }
  return ends;
}

/** The chain of `seeds` in walking order with the arc fractions, or why it is not one chain. */
export function planChain(
  context: BlendContext,
  seeds: readonly number[],
  startNear: Vec3 | undefined,
  startPath: string,
): ChainPlan | ChainProblem {
  const lengthOf = (edge: number): number => context.topology?.edges[edge]?.length ?? 0;
  const ends = endsOf(context, seeds);
  if (ends === null)
    return { problem: 'the kernel cannot sample the shared edges, so a size over their chain cannot be laid out', path: startPath };
  const tolerance = JOINT_GAP * Math.max(1, ...seeds.map(lengthOf));
  // partners of every end: the other ends at the same point
  const partners = (end: End): End[] => ends.filter((other) => other !== end && distance3(other.point, end.point) <= tolerance);
  for (const end of ends)
    if (partners(end).length > 1)
      return {
        problem: `more than two of the shared edges (${seeds.join(', ')}) meet at ${end.point.map((c) => c.toFixed(4)).join(', ')}: a size over a chain needs one path or one loop`,
        path: startPath,
      };
  for (const end of ends) {
    const other = partners(end)[0];
    if (other === undefined) continue;
    if (other.edge === end.edge)
      return {
        problem: `edge ${end.edge} is closed: a size over a chain needs the blend to be one edge or a chain of several`,
        path: startPath,
      };
    const angle = Math.acos(Math.max(-1, Math.min(1, -dot(end.into, other.into))));
    if (angle > JOINT_TANGENT_RAD)
      return {
        problem: `edges ${end.edge} and ${other.edge} meet at ${end.point.map((c) => c.toFixed(4)).join(', ')} with a bend of ${angle.toPrecision(3)} rad (more than ${JOINT_TANGENT_RAD}): they are not one tangent chain, so one law cannot run over them`,
        path: startPath,
      };
  }
  const open = ends.filter((end) => partners(end).length === 0);
  const closed = open.length === 0;
  if (!closed && open.length !== 2)
    return {
      problem: `the shared edges ${seeds.join(', ')} are not one chain (${open.length / 2} separate pieces): one law needs one path or one loop`,
      path: startPath,
    };
  if (closed && startNear !== undefined)
    return {
      problem: `the shared edges ${seeds.join(', ')} form a closed loop, which has no start end: leave startNear out (t = 0 is the start of edge ${Math.min(...seeds)})`,
      path: 'startNear',
    };
  const lowest = Math.min(...seeds);
  let begin: End | undefined;
  if (closed) begin = ends.find((end) => end.edge === lowest && end.side === 0);
  else if (startNear !== undefined) begin = [...open].sort((a, b) => distance3(a.point, startNear) - distance3(b.point, startNear))[0];
  else begin = [...open].sort((a, b) => a.edge - b.edge)[0];
  if (begin === undefined) return { problem: 'the chain has no start', path: startPath };
  const walked: Array<{ edge: number; forward: boolean }> = [];
  let at: End = begin;
  for (let step = 0; step < seeds.length; step++) {
    walked.push({ edge: at.edge, forward: at.side === 0 });
    const leaving = ends.find((end) => end.edge === at.edge && end.side !== at.side) as End;
    const next = partners(leaving)[0];
    if (next === undefined) break;
    at = next;
  }
  if (walked.length !== seeds.length) return { problem: `the shared edges ${seeds.join(', ')} are not one chain`, path: startPath };
  const total = walked.reduce((sum, entry) => sum + lengthOf(entry.edge), 0);
  let run = 0;
  const edges = walked.map((entry): ChainEdge => {
    const length = lengthOf(entry.edge);
    const from = run / total;
    run += length;
    return { ...entry, index: entry.edge, length, from, to: run / total };
  });
  return { edges, closed, total };
}

export interface ChainSize {
  readonly start: number;
  readonly end: number | undefined;
  readonly law: NonNullable<EdgeLawInput['law']> | undefined;
}

export interface ChainLawProblem {
  readonly code: 'BLD_LAW_INVALID' | 'BLD_LAW_NOT_PERIODIC';
  readonly message: string;
  readonly path: string;
}

const PERIODIC = 1e-9;

/** The sub-law of every edge of `plan` for `size`, in the edge's own direction (the kernel reads a law along the edge, whichever way its contour walks it: law_fillet.cxx); or why the law does not hold over the chain. */
export function chainLaws(plan: ChainPlan, size: ChainSize, endPath: string): EdgeLawInput[] | ChainLawProblem {
  let at: (tau: number) => number;
  let stations = 2;
  if (size.law === undefined) {
    const [a, b] = [size.start, size.end ?? size.start];
    if (plan.closed && Math.abs(a - b) > PERIODIC * Math.max(a, b))
      return {
        code: 'BLD_LAW_NOT_PERIODIC',
        message: `the shared edges form a closed loop, so the size must return to its start: ${a} at the start but ${b} at the end`,
        path: endPath,
      };
    at = (tau) => a + (b - a) * tau;
  } else {
    const samples = size.law.samples ?? DEFAULT_LAW_SAMPLES;
    const checked = sampleExpression(size.law.expression, samples);
    if (!Array.isArray(checked)) return checked as ChainLawProblem;
    const values = checked as readonly number[];
    if (
      plan.closed &&
      Math.abs((values[0] ?? 0) - (values[values.length - 1] ?? 0)) > PERIODIC * Math.max(values[0] ?? 0, values[values.length - 1] ?? 0)
    )
      return {
        code: 'BLD_LAW_NOT_PERIODIC',
        message: `the shared edges form a closed loop, so the law must return to its start: r(0) = ${values[0]} but r(1) = ${values[values.length - 1]}`,
        path: 'law.expression',
      };
    stations = Math.max(MIN_LAW_SAMPLES, Math.min(MAX_LAW_SAMPLES, samples));
    const expression = size.law.expression;
    at = (tau) => {
      const result = evaluateExpression(expression, { t: tau });
      return result.ok ? result.value : Number.NaN;
    };
  }
  const entries = plan.edges.map((edge): EdgeLawInput => {
    const [from, to] = edge.forward ? [edge.from, edge.to] : [edge.to, edge.from];
    const tau = (u: number): number => from + (to - from) * u;
    if (size.law === undefined) return { index: edge.index, size: at(tau(0)), sizeEnd: at(tau(1)), interpolation: 'linear' };
    const points = Array.from({ length: stations }, (_, k) => at(tau(k / (stations - 1))));
    return {
      index: edge.index,
      size: points[0] as number,
      sizeEnd: points[stations - 1] as number,
      sizes: points.slice(1, -1).map((value, k) => ({ t: (k + 1) / (stations - 1), size: value })),
      interpolation: 'linear',
    };
  });
  const bad = entries.find((entry) => !(entry.size !== undefined && entry.size > 0 && (entry.sizeEnd ?? entry.size) > 0));
  return bad === undefined
    ? entries
    : {
        code: 'BLD_LAW_INVALID',
        message: `the size is not > 0 along the chain (edge ${bad.index ?? '?'} starts at ${bad.size})`,
        path: size.law === undefined ? endPath : 'law.expression',
      };
}
