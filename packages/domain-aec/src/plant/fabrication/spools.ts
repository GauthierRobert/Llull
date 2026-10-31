/**
 * Spools (plant 05 ISO §5.5, TR-ISO-05): union-find over the components joined by shop welds (and by other joints); site / field-fit welds end a spool when `field_welds`
 * is a break, bolted pairs when `flanged_joints` is. Spools are named `<spoolPrefix | line>-SP<nn>` in flow order of their first component. Metrics: longest centreline
 * path, axis-aligned envelope (connection points plus the largest outside diameter), weight (sum of the weights the components carry), PIPE count.
 * `suggestSplit` picks the field-weld position that halves a spool's longest path. Pure.
 */

import type { Vec3 } from '@core/model/vectors';
import { distance3, lerp3 } from '@lib/vec3';
import { outsideDiameterMm } from '../../industrial/piping/pipeSizes';
import { nodeKey, type JointClass, type LineGraph } from './joints';
import type { NetworkComponent, PipingNetwork, SpoolBreak, SpoolLimits } from './model';

export interface SpoolInfo {
  readonly name: string;
  readonly componentIds: readonly string[];
  /** Indices into `network.components`. */
  readonly memberIndices: readonly number[];
  /** Longest centreline path, mm. */
  readonly lengthMm: number;
  /** Envelope extents sorted descending (the spool may be turned on the truck), mm. */
  readonly boxMm: readonly [number, number, number];
  readonly weightKg: number;
  /** Every non-WELD member carries a weight (otherwise the weight is a lower bound). */
  readonly weightComplete: boolean;
  readonly pieces: number;
}

export interface SpoolPlan {
  readonly spools: readonly SpoolInfo[];
  /** Member component index -> position in `spools`. */
  readonly spoolOf: ReadonlyMap<number, number>;
}

export const ALL_BREAKS: readonly SpoolBreak[] = ['field_welds', 'flanged_joints', 'line_ends'];

const round1 = (value: number): number => Math.round(value * 10) / 10;

function find(parent: number[], index: number): number {
  let root = index;
  while ((parent[root] as number) !== root) root = parent[root] as number;
  let walk = index;
  while ((parent[walk] as number) !== root) {
    const next = parent[walk] as number;
    parent[walk] = root;
    walk = next;
  }
  return root;
}

interface Edge {
  readonly from: string;
  readonly to: string;
  readonly lengthMm: number;
  readonly member: number;
}

/** Centreline edges of a component: end to end, or through its centre point (elbow, bend, tee), plus centre to branch. */
function edgesOf(component: NetworkComponent, member: number): { edges: Edge[]; coords: Array<[string, Vec3]> } {
  const key = nodeKey;
  const edges: Edge[] = [];
  const coords: Array<[string, Vec3]> = [];
  const [start, end] = component.ends;
  const add = (a: Vec3, b: Vec3): void => {
    edges.push({ from: key(a), to: key(b), lengthMm: distance3(a, b), member });
    coords.push([key(a), a], [key(b), b]);
  };
  const centre = component.centre;
  if (start !== undefined && end !== undefined) {
    if (centre === undefined) add(start.xyz, end.xyz);
    else {
      add(start.xyz, centre);
      add(centre, end.xyz);
    }
  }
  if (component.branch !== undefined && centre !== undefined) add(centre, component.branch.xyz);
  return { edges, coords };
}

interface LongestPath {
  readonly lengthMm: number;
  /** Edges along the path, in order, each with the cumulative length at its start and its direction. */
  readonly steps: ReadonlyArray<{ edge: Edge; start: number; reversed: boolean }>;
  readonly coords: ReadonlyMap<string, Vec3>;
}

/** Double-sweep longest path of the member graph (exact on a tree, a good bound on a loop). */
function longestPath(components: readonly NetworkComponent[], members: readonly number[]): LongestPath {
  const adjacency = new Map<string, Array<{ edge: Edge; other: string }>>();
  const coords = new Map<string, Vec3>();
  for (const member of members) {
    const built = edgesOf(components[member] as NetworkComponent, member);
    for (const [key, xyz] of built.coords) coords.set(key, xyz);
    for (const edge of built.edges) {
      adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), { edge, other: edge.to }]);
      adjacency.set(edge.to, [...(adjacency.get(edge.to) ?? []), { edge, other: edge.from }]);
    }
  }
  const sweep = (origin: string): { far: string; distance: number; via: Map<string, { edge: Edge; from: string }> } => {
    const distance = new Map<string, number>([[origin, 0]]);
    const via = new Map<string, { edge: Edge; from: string }>();
    const stack = [origin];
    let far = origin;
    while (stack.length > 0) {
      const node = stack.pop() as string;
      const here = distance.get(node) as number;
      if (here > (distance.get(far) as number)) far = node;
      for (const next of adjacency.get(node) ?? []) {
        if (distance.has(next.other)) continue;
        distance.set(next.other, here + next.edge.lengthMm);
        via.set(next.other, { edge: next.edge, from: node });
        stack.push(next.other);
      }
    }
    return { far, distance: distance.get(far) as number, via };
  };
  const first = adjacency.keys().next();
  if (first.done === true) return { lengthMm: 0, steps: [], coords };
  const a = sweep(first.value);
  const b = sweep(a.far);
  const reversedSteps: Array<{ edge: Edge; reversed: boolean }> = [];
  for (let node = b.far; node !== a.far; ) {
    const step = b.via.get(node) as { edge: Edge; from: string };
    reversedSteps.push({ edge: step.edge, reversed: step.edge.from === node });
    node = step.from;
  }
  let start = 0;
  const steps = reversedSteps.reverse().map((step) => {
    const placed = { ...step, start };
    start += step.edge.lengthMm;
    return placed;
  });
  return { lengthMm: b.distance, steps, coords };
}

function metrics(network: PipingNetwork, members: readonly number[]): Omit<SpoolInfo, 'name' | 'componentIds' | 'memberIndices'> {
  const components = network.components;
  const points = members.flatMap((index) => {
    const component = components[index] as NetworkComponent;
    return [...component.ends.map((end) => end.xyz), ...(component.branch === undefined ? [] : [component.branch.xyz])];
  });
  const maxOd = Math.max(
    0,
    ...members.flatMap((index) => (components[index] as NetworkComponent).ends.map((end) => outsideDiameterMm(end.boreMm) ?? end.boreMm)),
  );
  const extent = [0, 1, 2].map((axis) => {
    const values = points.map((point) => point[axis] as number);
    return values.length === 0 ? 0 : Math.max(...values) - Math.min(...values) + maxOd;
  });
  const [x = 0, y = 0, z = 0] = extent.sort((a, b) => b - a);
  const weighted = members.filter((index) => (components[index] as NetworkComponent).weight !== undefined);
  return {
    lengthMm: round1(longestPath(components, members).lengthMm),
    boxMm: [round1(x), round1(y), round1(z)],
    weightKg: weighted.reduce((sum, index) => sum + ((components[index] as NetworkComponent).weight ?? 0), 0),
    weightComplete: weighted.length === members.length,
    pieces: members.filter((index) => (components[index] as NetworkComponent).type === 'PIPE').length,
  };
}

export function buildSpools(input: {
  readonly network: PipingNetwork;
  readonly graph: LineGraph;
  /** Effective class of every joint by node key (a `set_weld_type` override included). */
  readonly classes: ReadonlyMap<string, JointClass>;
  readonly breakAt: readonly SpoolBreak[];
  readonly prefix: string;
}): SpoolPlan {
  const members = input.graph.members;
  const parent = members.map((_member, position) => position);
  const position = new Map(members.map((member, at) => [member, at]));
  for (const joint of input.graph.joints) {
    const kind = input.classes.get(joint.key) ?? joint.joint;
    const separates =
      ((kind === 'site' || kind === 'field_fit') && input.breakAt.includes('field_welds')) ||
      (kind === 'bolted' && input.breakAt.includes('flanged_joints'));
    if (separates) continue;
    const [head, ...rest] = joint.members;
    for (const other of rest) {
      const a = find(parent, position.get(head as number) as number);
      const b = find(parent, position.get(other) as number);
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
    }
  }
  const groups = new Map<number, number[]>();
  members.forEach((member, at) => {
    const root = find(parent, at);
    groups.set(root, [...(groups.get(root) ?? []), member]);
  });
  const ordered = [...groups.values()].sort((a, b) => (a[0] as number) - (b[0] as number));
  const spools = ordered.map((memberIndices, k): SpoolInfo => {
    const sorted = [...memberIndices].sort((a, b) => a - b);
    return {
      name: `${input.prefix}-SP${String(k + 1).padStart(2, '0')}`,
      componentIds: sorted.map((index) => (input.network.components[index] as NetworkComponent).id),
      memberIndices: sorted,
      ...metrics(input.network, sorted),
    };
  });
  const spoolOf = new Map<number, number>();
  spools.forEach((spool, at) => spool.memberIndices.forEach((member) => spoolOf.set(member, at)));
  return { spools, spoolOf };
}

export interface Violation {
  readonly code: 'ISO_SPOOL_TOO_LARGE' | 'ISO_SPOOL_TOO_HEAVY';
  readonly message: string;
}

/** The limits a spool exceeds (the envelope is compared after sorting both triples; a missing envelope side is unlimited). */
export function violationsOf(spool: SpoolInfo, limits: SpoolLimits | undefined): Violation[] {
  if (limits === undefined) return [];
  const out: Violation[] = [];
  const envelope = [limits.lengthMm, limits.widthMm, limits.heightMm]
    .map((value) => value ?? Number.POSITIVE_INFINITY)
    .sort((a, b) => b - a);
  const over = spool.boxMm.findIndex((size, at) => size > (envelope[at] as number) + 1e-9);
  if (over >= 0)
    out.push({
      code: 'ISO_SPOOL_TOO_LARGE',
      message: `${spool.name} envelope ${spool.boxMm.join(' x ')} mm exceeds the limit ${envelope.map((v) => (Number.isFinite(v) ? v : '-')).join(' x ')} mm`,
    });
  if (limits.pieces !== undefined && spool.pieces > limits.pieces)
    out.push({ code: 'ISO_SPOOL_TOO_LARGE', message: `${spool.name} has ${spool.pieces} pipe pieces, the limit is ${limits.pieces}` });
  if (limits.weightKg !== undefined && spool.weightKg > limits.weightKg)
    out.push({ code: 'ISO_SPOOL_TOO_HEAVY', message: `${spool.name} weighs ${spool.weightKg} kg, the limit is ${limits.weightKg} kg` });
  return out;
}

/** Where to put a site weld to split `spool`: on the pipe nearest the middle of its longest path with both pieces at least `minPieceMm`, else on its longest pipe. */
export function suggestSplit(network: PipingNetwork, spool: SpoolInfo, minPieceMm: number): Vec3 | null {
  const components = network.components;
  const path = longestPath(components, spool.memberIndices);
  const target = path.lengthMm / 2;
  let best: { point: Vec3; cost: number } | null = null;
  for (const step of path.steps) {
    const component = components[step.edge.member] as NetworkComponent;
    if (component.type !== 'PIPE' || step.edge.lengthMm < 2 * minPieceMm) continue;
    const position = Math.min(Math.max(target, step.start + minPieceMm), step.start + step.edge.lengthMm - minPieceMm);
    const cost = Math.abs(position - target);
    if (best !== null && cost >= best.cost) continue;
    const from = path.coords.get(step.reversed ? step.edge.to : step.edge.from) as Vec3;
    const to = path.coords.get(step.reversed ? step.edge.from : step.edge.to) as Vec3;
    best = { point: lerp3(from, to, (position - step.start) / step.edge.lengthMm), cost };
  }
  if (best !== null) return best.point;
  const longest = spool.memberIndices
    .map((index) => components[index] as NetworkComponent)
    .filter((component) => component.type === 'PIPE' && component.ends.length === 2)
    .map((component) => ({
      component,
      length: distance3((component.ends[0] as { xyz: Vec3 }).xyz, (component.ends[1] as { xyz: Vec3 }).xyz),
    }))
    .filter((entry) => entry.length >= 2 * minPieceMm)
    .sort((a, b) => b.length - a.length)[0];
  return longest === undefined
    ? null
    : lerp3((longest.component.ends[0] as { xyz: Vec3 }).xyz, (longest.component.ends[1] as { xyz: Vec3 }).xyz, 0.5);
}
