/** Pairing of P&ID items with 3D objects (plant 04 PID §5.6 steps 1 and 2): explicit links first, then a hash join on the normalised key. */

export interface ModelObject {
  /** Building element ids the object stands for (a line: every run carrying the line number). */
  readonly ids: readonly string[];
}

export interface Ambiguity<P, M> {
  readonly key: string;
  readonly pids: readonly P[];
  readonly models: readonly M[];
}

export interface Pairing<P, M> {
  readonly pairs: ReadonlyArray<readonly [P, M]>;
  /** P&ID items whose explicit link names no 3D object any more. */
  readonly stale: readonly P[];
  readonly ambiguous: ReadonlyArray<Ambiguity<P, M>>;
  /** Keyed P&ID items with no 3D candidate. */
  readonly unplaced: readonly P[];
  /** Keyed 3D objects with no P&ID candidate. */
  readonly notInPid: readonly M[];
}

function bucket<T>(items: readonly T[], keyOf: (item: T) => string | undefined): Map<string, T[]> {
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    if (key === undefined) continue;
    const list = buckets.get(key);
    if (list === undefined) buckets.set(key, [item]);
    else list.push(item);
  }
  return buckets;
}

/** Linear in both sides. An item without a key (no tag, no line number) joins only through a link. */
export function pairUp<P extends { readonly id: string }, M extends ModelObject>(
  pids: readonly P[],
  models: readonly M[],
  pidKey: (item: P) => string | undefined,
  modelKey: (object: M) => string | undefined,
  links: Readonly<Record<string, string>>,
): Pairing<P, M> {
  const pairs: Array<readonly [P, M]> = [];
  const stale: P[] = [];
  const ambiguous: Array<Ambiguity<P, M>> = [];
  const unplaced: P[] = [];
  const notInPid: M[] = [];
  const byElement = new Map<string, M>();
  for (const object of models) for (const id of object.ids) byElement.set(id, object);
  const claimedPids = new Set<string>();
  const claimedModels = new Set<M>();
  for (const item of pids) {
    if (!Object.hasOwn(links, item.id)) continue;
    claimedPids.add(item.id);
    const object = byElement.get(links[item.id] as string);
    if (object === undefined || claimedModels.has(object)) stale.push(item);
    else {
      claimedModels.add(object);
      pairs.push([item, object]);
    }
  }
  const pidBuckets = bucket(
    pids.filter((item) => !claimedPids.has(item.id)),
    pidKey,
  );
  const modelBuckets = bucket(
    models.filter((object) => !claimedModels.has(object)),
    modelKey,
  );
  const keys = new Set([...pidBuckets.keys(), ...modelBuckets.keys()]);
  for (const key of keys) {
    const left = pidBuckets.get(key) ?? [];
    const right = modelBuckets.get(key) ?? [];
    const [onlyLeft, onlyRight] = [left[0], right[0]];
    if (left.length === 1 && right.length === 1 && onlyLeft !== undefined && onlyRight !== undefined) pairs.push([onlyLeft, onlyRight]);
    else if (left.length > 0 && right.length > 0) ambiguous.push({ key, pids: left, models: right });
    else if (left.length > 0) unplaced.push(...left);
    else notInPid.push(...right);
  }
  return { pairs, stale, ambiguous, unplaced, notInPid };
}
