/**
 * Fill-reducing ordering of the normal matrix of the G1 rows (`g1Factored.ts`, DES-4c): approximate minimum degree on a quotient graph (variables, absorbed elements, the AMD external
 * degree bound; no supervariables). Used when the reverse Cuthill-McKee envelope does not fit.
 * @invariant pure; deterministic: degree buckets with last-in-first-out ties, loops in index order, no hash iteration
 */

/** `order[position] = row`: the elimination order of the symmetric pattern `graph` (sorted adjacency lists, no self loops). */
export function minimumDegree(graph: readonly number[][]): number[] {
  const n = graph.length;
  const variables: number[][] = graph.map((list) => [...list]);
  const elementsOf: number[][] = graph.map(() => []);
  const members: number[][] = graph.map(() => []);
  const alive = new Uint8Array(n).fill(1);
  const elementAlive = new Uint8Array(n);
  const degree = Int32Array.from(graph, (list) => list.length);
  const inPivotList = new Int32Array(n).fill(-1);
  const outside = new Int32Array(n);
  const outsideStamp = new Int32Array(n).fill(-1);
  const head = new Int32Array(n + 1).fill(-1);
  const next = new Int32Array(n).fill(-1);
  const previous = new Int32Array(n).fill(-1);
  let lowest = n;
  const insert = (v: number, d: number): void => {
    degree[v] = d;
    previous[v] = -1;
    next[v] = head[d] as number;
    if (head[d] !== -1) previous[head[d] as number] = v;
    head[d] = v;
    if (d < lowest) lowest = d;
  };
  const remove = (v: number): void => {
    const [before, after] = [previous[v] as number, next[v] as number];
    if (before === -1) head[degree[v] as number] = after;
    else next[before] = after;
    if (after !== -1) previous[after] = before;
  };
  for (let v = 0; v < n; v++) insert(v, degree[v] as number);
  const order: number[] = [];
  for (let step = 0; step < n; step++) {
    while (head[lowest] === -1) lowest++;
    const pivot = head[lowest] as number;
    remove(pivot);
    alive[pivot] = 0;
    order.push(pivot);
    // the new element: the live variables next to the pivot directly or through an element (those elements are absorbed)
    const list: number[] = [];
    inPivotList[pivot] = step;
    for (const v of variables[pivot] as number[])
      if (alive[v] && inPivotList[v] !== step) {
        inPivotList[v] = step;
        list.push(v);
      }
    for (const e of elementsOf[pivot] as number[]) {
      if (!elementAlive[e]) continue;
      for (const v of members[e] as number[])
        if (alive[v] && inPivotList[v] !== step) {
          inPivotList[v] = step;
          list.push(v);
        }
      elementAlive[e] = 0;
      members[e] = [];
    }
    variables[pivot] = [];
    elementsOf[pivot] = [];
    members[pivot] = list;
    elementAlive[pivot] = 1;
    // |L_e \ list| of every element that touches the new one
    for (const i of list)
      for (const e of elementsOf[i] as number[]) {
        if (!elementAlive[e]) continue;
        if (outsideStamp[e] !== step) {
          outsideStamp[e] = step;
          outside[e] = (members[e] as number[]).length;
        }
        outside[e] = (outside[e] as number) - 1;
      }
    const remaining = n - step - 2;
    for (const i of list) {
      // an element inside the new one is absorbed; the variables inside it are covered by it
      const elements = (elementsOf[i] as number[]).filter((e) => {
        if (!elementAlive[e]) return false;
        if ((outside[e] as number) === 0) {
          elementAlive[e] = 0;
          return false;
        }
        return true;
      });
      const direct = (variables[i] as number[]).filter((v) => alive[v] && inPivotList[v] !== step);
      let bound = direct.length + list.length - 1;
      for (const e of elements) bound += outside[e] as number;
      elements.push(pivot);
      elementsOf[i] = elements;
      variables[i] = direct;
      remove(i);
      insert(i, Math.max(0, Math.min(remaining, (degree[i] as number) + list.length - 1, bound)));
    }
  }
  return order;
}
