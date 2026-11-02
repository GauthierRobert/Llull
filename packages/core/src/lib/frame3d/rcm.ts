/** Reverse Cuthill-McKee node ordering; deterministic (ties broken by degree then node index). Returns the old index at each new position. */
export function reverseCuthillMcKee(nodeCount: number, edges: ReadonlyArray<readonly [number, number]>): number[] {
  const neighbours: Set<number>[] = Array.from({ length: nodeCount }, () => new Set<number>());
  for (const [a, b] of edges) {
    if (a === b) continue;
    neighbours[a]?.add(b);
    neighbours[b]?.add(a);
  }
  const lists: number[][] = neighbours.map((set) => [...set]);
  const degree = (n: number): number => lists[n]?.length ?? 0;
  const byDegree = (x: number, y: number): number => degree(x) - degree(y) || x - y;
  for (const list of lists) list.sort(byDegree);

  const visited = new Uint8Array(nodeCount);
  const order: number[] = [];
  const starts = Array.from({ length: nodeCount }, (_, i) => i).sort(byDegree);
  for (const start of starts) {
    if (visited[start]) continue;
    visited[start] = 1;
    const queue: number[] = [start];
    for (let head = 0; head < queue.length; head++) {
      const node = queue[head] as number;
      order.push(node);
      for (const next of lists[node] ?? []) {
        if (visited[next]) continue;
        visited[next] = 1;
        queue.push(next);
      }
    }
  }
  return order.reverse();
}
