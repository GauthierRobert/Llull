/**
 * Drawing graph of a line (plant 05 ISO §5.8, TR-ISO-10): every component becomes straight segments between connection points (an elbow, bend or tee goes through
 * its centre point), the segments are walked depth-first from the line start (run before branch, like the weld numbering) and chained into maximal straight runs.
 * A run is the unit of dimensioning; the walk is the unit of layout. WELD, GASKET, BOLT and SUPPORT are not segments. Pure; iterative.
 */

import type { Vec3 } from '@core/model/vectors';
import { add3, dot3, len3, normalize3, scale3, sub3 } from '@lib/vec3';
import { nodeKey } from '../joints';
import type { NetworkComponent, PcfComponentType, PipingNetwork } from '../model';

/** Direction class of a segment: along a plant axis, a slight fall along a horizontal axis, or skew. */
export type AxisClass = '+E' | '-E' | '+N' | '-N' | '+U' | '-U' | 'slope' | 'skew';

export interface IsoSegment {
  readonly componentId: string;
  readonly componentIndex: number;
  readonly type: PcfComponentType;
  readonly part: 'body' | 'leg1' | 'leg2' | 'branch';
  readonly a: Vec3;
  readonly b: Vec3;
  readonly lengthMm: number;
}

export interface WalkStep {
  readonly segment: IsoSegment;
  /** Start and end of the segment in walking direction. */
  readonly start: Vec3;
  readonly end: Vec3;
  readonly entryKey: string;
  readonly exitKey: string;
  readonly dir: Vec3;
  readonly axis: AxisClass;
  /** Index of the step we came through (-1 for the line start). */
  readonly parent: number;
  /** 1-based run number. */
  readonly run: number;
}

export interface IsoRun {
  readonly id: number;
  readonly axis: AxisClass;
  readonly dir: Vec3;
  readonly steps: readonly number[];
  /** Connection points along the run (start, then the end of every step), 3D mm. */
  readonly points: readonly Vec3[];
}

export interface IsoGraph {
  readonly steps: readonly WalkStep[];
  readonly runs: readonly IsoRun[];
  /** Number of connected groups of segments (more than 1: ISO_DISCONNECTED). */
  readonly groups: number;
  /** Ids of the components that are not in the group of the line start. */
  readonly unreachable: readonly string[];
  /** Node key -> number of segments meeting there. */
  readonly degree: ReadonlyMap<string, number>;
  /** Node key -> 3D point. */
  readonly points: ReadonlyMap<string, Vec3>;
}

const AXIS_TOLERANCE = 2e-4;
const SLOPE_LIMIT = 0.25;
const SKIPPED = new Set<PcfComponentType>(['WELD', 'GASKET', 'BOLT', 'SUPPORT']);
const LETTER = ['E', 'N', 'U'] as const;

/** Axis class of a unit direction. */
export function classifyDirection(dir: Vec3): AxisClass {
  for (let axis = 0; axis < 3; axis++) {
    const along = dir[axis] as number;
    const others = Math.hypot(...dir.filter((_value, at) => at !== axis));
    if (Math.abs(along) > 0 && others <= AXIS_TOLERANCE * Math.abs(along)) return `${along > 0 ? '+' : '-'}${LETTER[axis]}` as AxisClass;
  }
  const horizontal = Math.hypot(dir[0], dir[1]);
  if (
    horizontal > 0 &&
    Math.abs(dir[2]) / horizontal <= SLOPE_LIMIT &&
    Math.min(Math.abs(dir[0]), Math.abs(dir[1])) <= AXIS_TOLERANCE * horizontal
  )
    return 'slope';
  return 'skew';
}

/** The corner of an elbow or bend whose centre point is not given: the L through the first axis the end points differ on. */
const cornerOf = (a: Vec3, b: Vec3): Vec3 => {
  const axis = [0, 1, 2].find((at) => Math.abs((b[at] as number) - (a[at] as number)) > 1e-6) ?? 0;
  const out: [number, number, number] = [a[0], a[1], a[2]];
  out[axis] = b[axis] as number;
  return out;
};

function segmentsOf(component: NetworkComponent, componentIndex: number): IsoSegment[] {
  if (SKIPPED.has(component.type)) return [];
  const make = (part: IsoSegment['part'], a: Vec3, b: Vec3): IsoSegment[] => {
    const lengthMm = len3(sub3(b, a));
    return lengthMm < 1e-6 || nodeKey(a) === nodeKey(b)
      ? []
      : [{ componentId: component.id, componentIndex, type: component.type, part, a, b, lengthMm }];
  };
  const [first, second] = component.ends.map((end) => end.xyz);
  if (component.type === 'ELBOW' || component.type === 'BEND' || component.type === 'TEE') {
    if (first === undefined || second === undefined) return [];
    const centre = component.centre ?? (component.type === 'TEE' ? scale3(add3(first, second), 0.5) : cornerOf(first, second));
    return [
      ...make('leg1', first, centre),
      ...make('leg2', centre, second),
      ...(component.branch === undefined ? [] : make('branch', centre, component.branch.xyz)),
    ];
  }
  if (component.type === 'OLET')
    return component.branch === undefined ? [] : make('branch', component.centre ?? first ?? component.branch.xyz, component.branch.xyz);
  return first === undefined || second === undefined ? [] : make('body', first, second);
}

export function buildIsoGraph(network: PipingNetwork): IsoGraph {
  const segments = network.components.flatMap((component, index) => segmentsOf(component, index));
  const adjacency = new Map<string, number[]>();
  const points = new Map<string, Vec3>();
  segments.forEach((segment, index) => {
    for (const end of [segment.a, segment.b]) {
      const key = nodeKey(end);
      adjacency.set(key, [...(adjacency.get(key) ?? []), index]);
      if (!points.has(key)) points.set(key, end);
    }
  });
  const degree = new Map<string, number>([...adjacency].map(([key, list]) => [key, list.length]));
  const steps: WalkStep[] = [];
  const done = new Set<number>();
  const runDirection: Vec3[] = [];
  let groups = 0;
  let unreachable: string[] = [];
  type Task = { segment: number; entry: string; parent: number };
  for (let root = 0; root < segments.length; root++) {
    if (done.has(root)) continue;
    groups += 1;
    const first = segments[root] as IsoSegment;
    const reachedBefore = steps.length;
    const stack: Task[] = [{ segment: root, entry: nodeKey(first.a), parent: -1 }];
    while (stack.length > 0) {
      const task = stack.pop() as Task;
      if (done.has(task.segment)) continue;
      done.add(task.segment);
      const segment = segments[task.segment] as IsoSegment;
      const forward = nodeKey(segment.a) === task.entry;
      const start = forward ? segment.a : segment.b;
      const end = forward ? segment.b : segment.a;
      const dir = normalize3(sub3(end, start));
      const parent = steps[task.parent];
      const run = parent !== undefined && dot3(parent.dir, dir) > 1 - 1e-9 ? parent.run : runDirection.length + 1;
      if (run > runDirection.length) runDirection.push(dir);
      const exitKey = nodeKey(end);
      steps.push({ segment, start, end, entryKey: task.entry, exitKey, dir, axis: classifyDirection(dir), parent: task.parent, run });
      const here = steps.length - 1;
      const next = (adjacency.get(exitKey) ?? []).filter((candidate) => !done.has(candidate));
      for (let k = next.length - 1; k >= 0; k--) stack.push({ segment: next[k] as number, entry: exitKey, parent: here });
    }
    if (groups > 1) unreachable = [...unreachable, ...new Set(steps.slice(reachedBefore).map((step) => step.segment.componentId))];
  }
  const runs: IsoRun[] = runDirection.map((dir, at) => {
    const members = steps.flatMap((step, index) => (step.run === at + 1 ? [index] : []));
    const firstStep = steps[members[0] as number] as WalkStep;
    return {
      id: at + 1,
      axis: firstStep.axis,
      dir,
      steps: members,
      points: [firstStep.start, ...members.map((index) => (steps[index] as WalkStep).end)],
    };
  });
  return { steps, runs, groups, unreachable, degree, points };
}
