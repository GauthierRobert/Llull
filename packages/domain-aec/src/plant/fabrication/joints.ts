/**
 * Connectivity of a line network (plant 05 ISO §5.4): connection points are keyed by coordinates rounded to 0.1 mm; a node with two or more components is a joint
 * (shop / site / field-fit weld, bolted flange pair, other), a node with one component is a terminal. Welds are visited depth-first from the line start, the run
 * (END-POINT 2) before the branch (BRANCH1), and numbered in the order their node is first reached. WELD, GASKET, BOLT and SUPPORT records are not graph members:
 * a WELD marks the kind of the joint at its position. Pure; iterative (a long line cannot overflow the stack).
 */

import type { Vec3 } from '@core/model/vectors';
import type { NetworkComponent, PipingNetwork, WeldKind } from './model';

export type JointClass = WeldKind | 'bolted' | 'other';

export interface JointNode {
  /** Rounded coordinates "x,y,z" (0.1 mm). */
  readonly key: string;
  readonly xyz: Vec3;
  /** Indices into `network.components`, in component order. */
  readonly members: readonly number[];
  readonly boreMm: number;
  readonly endType: string;
  /** A WELD component sits here. */
  readonly explicit: boolean;
  readonly joint: JointClass;
}

export interface Terminal {
  readonly xyz: Vec3;
  readonly componentIndex: number;
  readonly endType: string | undefined;
  readonly boreMm: number;
}

export interface LineGraph {
  /** Joints in numbering order (first reached depth-first). */
  readonly joints: readonly JointNode[];
  readonly terminals: readonly Terminal[];
  /** Graph members (not WELD / GASKET / BOLT / SUPPORT) as indices into the component list, in component order. */
  readonly members: readonly number[];
  /** Node key -> joint, for every joint. */
  readonly byKey: ReadonlyMap<string, JointNode>;
}

const r1 = (value: number): number => Math.round(value * 10) / 10 + 0;
export const nodeKey = (xyz: Vec3): string => `${r1(xyz[0])},${r1(xyz[1])},${r1(xyz[2])}`;

const TRANSPARENT = new Set(['WELD', 'GASKET', 'BOLT', 'SUPPORT']);
const WELDABLE = new Set(['BW', 'SW']);

interface Entry {
  readonly index: number;
  readonly endType: string | undefined;
  readonly boreMm: number;
  readonly xyz: Vec3;
}

/** Connection points of a member in exit order: END-POINTs then BRANCH1-POINT. */
const pointsOf = (component: NetworkComponent): Array<{ xyz: Vec3; endType: string | undefined; boreMm: number }> =>
  [...component.ends, ...(component.branch === undefined ? [] : [component.branch])].map((point) => ({
    xyz: point.xyz,
    endType: point.endType,
    boreMm: point.boreMm,
  }));

const weldKindOf = (component: NetworkComponent): WeldKind => component.weldKind ?? (component.category === 'erection' ? 'site' : 'shop');

function classify(entries: readonly Entry[], weld: NetworkComponent | undefined): JointClass {
  if (weld !== undefined) return weldKindOf(weld);
  const types = entries.map((entry) => entry.endType);
  if (types.every((type) => type === undefined || WELDABLE.has(type))) return 'shop';
  if (types.every((type) => type === 'FL')) return 'bolted';
  return 'other';
}

export function buildLineGraph(network: PipingNetwork): LineGraph {
  const components = network.components;
  const members = components.flatMap((component, index) => (TRANSPARENT.has(component.type) ? [] : [index]));
  const nodes = new Map<string, Entry[]>();
  for (const index of members)
    for (const point of pointsOf(components[index] as NetworkComponent)) {
      const key = nodeKey(point.xyz);
      const list = nodes.get(key) ?? [];
      if (!list.some((entry) => entry.index === index)) list.push({ index, endType: point.endType, boreMm: point.boreMm, xyz: point.xyz });
      nodes.set(key, list);
    }
  const welds = new Map<string, NetworkComponent>();
  for (const component of components)
    if (component.type === 'WELD' && component.ends[0] !== undefined) welds.set(nodeKey(component.ends[0].xyz), component);

  const visitedNodes = new Set<string>();
  const visitedMembers = new Set<number>();
  const order: string[] = [];
  type Task = { node: string } | { member: number; entry: string };
  for (const start of members) {
    if (visitedMembers.has(start)) continue;
    const first = pointsOf(components[start] as NetworkComponent)[0];
    const stack: Task[] = [{ member: start, entry: first === undefined ? '' : nodeKey(first.xyz) }];
    while (stack.length > 0) {
      const task = stack.pop() as Task;
      if ('node' in task) {
        if (visitedNodes.has(task.node)) continue;
        visitedNodes.add(task.node);
        order.push(task.node);
        const next = (nodes.get(task.node) ?? []).filter((entry) => !visitedMembers.has(entry.index));
        for (let k = next.length - 1; k >= 0; k--) stack.push({ member: (next[k] as Entry).index, entry: task.node });
      } else {
        if (visitedMembers.has(task.member)) continue;
        visitedMembers.add(task.member);
        const keys = pointsOf(components[task.member] as NetworkComponent).map((point) => nodeKey(point.xyz));
        const skip = keys.indexOf(task.entry);
        if (!visitedNodes.has(task.entry) && task.entry !== '') {
          visitedNodes.add(task.entry);
          order.push(task.entry);
        }
        const exits = keys.filter((_key, position) => position !== skip);
        for (let k = exits.length - 1; k >= 0; k--) stack.push({ node: exits[k] as string });
      }
    }
  }

  const joints: JointNode[] = [];
  const terminals: Terminal[] = [];
  const byKey = new Map<string, JointNode>();
  for (const key of order) {
    const entries = [...(nodes.get(key) ?? [])].sort((a, b) => a.index - b.index);
    const first = entries[0];
    if (first === undefined) continue;
    const weld = welds.get(key);
    if (entries.length >= 2) {
      const node: JointNode = {
        key,
        xyz: first.xyz,
        members: entries.map((entry) => entry.index),
        boreMm: first.boreMm,
        endType: first.endType ?? 'BW',
        explicit: weld !== undefined,
        joint: classify(entries, weld),
      };
      joints.push(node);
      byKey.set(key, node);
    } else terminals.push({ xyz: first.xyz, componentIndex: first.index, endType: first.endType, boreMm: first.boreMm });
  }
  return { joints, terminals, members, byKey };
}

/** A joint that is a weld (shop, site or field-fit), not a bolted pair. */
export const isWeldJoint = (joint: JointClass): joint is WeldKind => joint === 'shop' || joint === 'site' || joint === 'field_fit';
