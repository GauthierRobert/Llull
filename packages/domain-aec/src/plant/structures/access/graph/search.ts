/** Searches over the access graph (06 STA §5.7): breadth-first routes from grade and the number of edge-disjoint routes. Deterministic, bounded by the graph size. */

import { GRADE_ID, type AccessEdge, type AccessGraph } from './types';

export interface Leg {
  readonly edge: AccessEdge;
  readonly from: string;
  readonly to: string;
}

/** Route tree from grade: for every reachable node, the leg that reached it. */
export interface RouteTree {
  readonly via: ReadonlyMap<string, Leg | null>;
}

/** Edge indices touching each node, in edge order. */
function incidence(graph: AccessGraph): Map<string, number[]> {
  const map = new Map<string, number[]>(graph.nodes.map((node) => [node.id, []]));
  graph.edges.forEach((edge, index) => {
    map.get(edge.from)?.push(index);
    map.get(edge.to)?.push(index);
  });
  return map;
}

/** Breadth-first search from grade (fewest legs; ties by edge order: connectors in model order, then touching pairs). */
export function routeTree(graph: AccessGraph): RouteTree {
  const around = incidence(graph);
  const via = new Map<string, Leg | null>([[GRADE_ID, null]]);
  const queue: string[] = [GRADE_ID];
  for (let head = 0; head < queue.length; head++) {
    const node = queue[head] as string;
    for (const index of around.get(node) ?? []) {
      const edge = graph.edges[index] as AccessEdge;
      const next = edge.from === node ? edge.to : edge.from;
      if (via.has(next)) continue;
      via.set(next, { edge, from: node, to: next });
      queue.push(next);
    }
  }
  return { via };
}

/** Legs from grade to `nodeId` in walking order; null when unreachable. */
export function legsTo(tree: RouteTree, nodeId: string): Leg[] | null {
  if (!tree.via.has(nodeId)) return null;
  const legs: Leg[] = [];
  for (let leg = tree.via.get(nodeId); leg !== null && leg !== undefined; leg = tree.via.get(leg.from)) legs.unshift(leg);
  return legs;
}

/** `["grade", <connector element id>, <surface id>, ...]`: touching surfaces add only the surface id. */
export function routeIds(legs: readonly Leg[]): string[] {
  return [GRADE_ID, ...legs.flatMap((leg) => (leg.edge.kind === 'adjacent' ? [leg.to] : [leg.edge.id, leg.to]))];
}

/**
 * Number of edge-disjoint routes from grade to `nodeId`, at most `limit` (unit-capacity augmenting paths; parallel ladders count separately).
 * Work is limit x (nodes + edges).
 */
export function disjointRoutes(graph: AccessGraph, nodeId: string, limit: number): number {
  if (nodeId === GRADE_ID) return limit;
  const around = incidence(graph);
  // capacity[i] = [forward, backward] residual of edge i.
  const capacity = graph.edges.map((): [number, number] => [1, 1]);
  let routes = 0;
  while (routes < limit) {
    const parent = new Map<string, { index: number; forward: boolean }>();
    const queue: string[] = [GRADE_ID];
    for (let head = 0; head < queue.length && !parent.has(nodeId); head++) {
      const node = queue[head] as string;
      for (const index of around.get(node) ?? []) {
        const edge = graph.edges[index] as AccessEdge;
        const forward = edge.from === node;
        const next = forward ? edge.to : edge.from;
        const residual = (capacity[index] as [number, number])[forward ? 0 : 1];
        if (residual <= 0 || next === GRADE_ID || parent.has(next)) continue;
        parent.set(next, { index, forward });
        queue.push(next);
      }
    }
    if (!parent.has(nodeId)) break;
    for (let at = nodeId; at !== GRADE_ID; ) {
      const step = parent.get(at) as { index: number; forward: boolean };
      const edge = graph.edges[step.index] as AccessEdge;
      const cell = capacity[step.index] as [number, number];
      cell[step.forward ? 0 : 1] -= 1;
      cell[step.forward ? 1 : 0] += 1;
      at = step.forward ? edge.from : edge.to;
    }
    routes += 1;
  }
  return routes;
}
