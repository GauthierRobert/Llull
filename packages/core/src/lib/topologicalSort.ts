/**
 * Kahn's algorithm: `nodes` ordered so every `[before, after]` edge points forward. Nodes on or
 * behind a cycle never reach in-degree 0; they are returned in `cyclic` (in `nodes` order).
 * @pure
 */
export function topologicalSort(
  nodes: Iterable<string>,
  edges: ReadonlyArray<readonly [before: string, after: string]>,
): { sorted: string[]; cyclic: string[] } {
  const all = [...nodes];
  const inDegree = new Map(all.map((node) => [node, 0]));
  const successors = new Map<string, string[]>(all.map((node) => [node, []]));
  for (const [before, after] of edges) {
    inDegree.set(after, (inDegree.get(after) ?? 0) + 1);
    successors.get(before)?.push(after);
  }
  const queue = all.filter((node) => inDegree.get(node) === 0);
  const sorted: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift() as string;
    sorted.push(node);
    for (const next of successors.get(node) ?? []) {
      const remaining = (inDegree.get(next) ?? 1) - 1;
      inDegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  const done = new Set(sorted);
  return { sorted, cyclic: all.filter((node) => !done.has(node)) };
}
