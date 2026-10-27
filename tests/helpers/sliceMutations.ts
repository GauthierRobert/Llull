/**
 * Deterministic mutations of a plugin slice inside a raw (JSON) document: the hostile edits a hand-edited or corrupted file can carry.
 * Used by tests/unit/contract/pluginSliceFuzz.test.ts; a fixed seed makes the sampled cases identical on every run.
 */

type Path = ReadonlyArray<string | number>;
type Container = Record<string, unknown> | unknown[];

const MUTATION_KINDS = [
  'delete',
  'type-string',
  'type-number',
  'type-boolean',
  'type-null',
  'type-array',
  'type-object',
  'number-minus-one',
  'number-1e308',
  'number-nan',
  'number-infinity',
  'number-minus-infinity',
  'reserved-key-added',
  'reserved-key-renamed',
  'duplicate-id',
  'dangling-reference',
  'long-string',
  'long-array',
] as const;
export type MutationKind = (typeof MUTATION_KINDS)[number];

/** Kinds JSON cannot carry: they are applied to the object and checked on the validators only. */
export const NON_JSON_KINDS: ReadonlySet<MutationKind> = new Set(['number-nan', 'number-infinity', 'number-minus-infinity']);

const RESERVED = ['__proto__', 'constructor', 'prototype'] as const;
const LONG_STRING = 20_000;
const LONG_ARRAY = 1_500;

export interface SliceMutation {
  readonly kind: MutationKind;
  readonly path: string;
  /** `plugin | kind @ path` style label, stable across runs. */
  readonly label: string;
  /** A mutated deep copy of `raw` (the argument is not touched). */
  readonly apply: (raw: Record<string, unknown>) => Record<string, unknown>;
}

const isContainer = (value: unknown): value is Container => typeof value === 'object' && value !== null;
const isObject = (value: unknown): value is Record<string, unknown> => isContainer(value) && !Array.isArray(value);

/** Own-property write that also works for `__proto__` (a plain assignment would change the prototype instead). */
function setOwn(target: Container, key: string | number, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function at(raw: unknown, path: Path): unknown {
  let current = raw;
  for (const key of path) current = isContainer(current) ? (current as Record<string | number, unknown>)[key] : undefined;
  return current;
}

function parentOf(raw: unknown, path: Path): Container | undefined {
  const parent = at(raw, path.slice(0, -1));
  return isContainer(parent) ? parent : undefined;
}

interface Node {
  readonly path: Path;
  readonly value: unknown;
}

function collect(value: unknown, path: Path, out: Node[], depth: number): void {
  out.push({ path, value });
  if (!isContainer(value) || depth > 12) return;
  const entries = Array.isArray(value) ? value.map((entry, index) => [index, entry] as const) : Object.entries(value);
  for (const [key, child] of entries) collect(child, [...path, key], out, depth + 1);
}

/** Every id the slice and the document use as a key or an `id` value: the targets of a dangling-reference edit. */
function knownIds(nodes: readonly Node[], raw: Record<string, unknown>): Set<string> {
  const ids = new Set<string>(isObject(raw['entities']) ? Object.keys(raw['entities']) : []);
  for (const { path, value } of nodes) {
    const last = path[path.length - 1];
    if (typeof last === 'string' && isObject(value)) ids.add(last);
    if (last === 'id' && typeof value === 'string') ids.add(value);
  }
  ids.delete('');
  return ids;
}

const show = (path: Path): string => path.join('.');

function build(kind: MutationKind, path: Path, variant: string, edit: (copy: Record<string, unknown>) => void): SliceMutation {
  const where = show(path);
  return {
    kind,
    path: where,
    label: `${kind}${variant === '' ? '' : `:${variant}`} @ ${where}`,
    apply: (raw) => {
      const copy = clone(raw);
      edit(copy);
      return copy;
    },
  };
}

function replaceAt(path: Path, make: (old: unknown) => unknown): (copy: Record<string, unknown>) => void {
  return (copy) => {
    const parent = parentOf(copy, path);
    const key = path[path.length - 1];
    if (parent !== undefined && key !== undefined) setOwn(parent, key, make((parent as Record<string | number, unknown>)[key]));
  };
}

const TYPE_SWAPS: ReadonlyArray<readonly [MutationKind, () => unknown]> = [
  ['type-string', () => 'fuzz'],
  ['type-number', () => 7],
  ['type-boolean', () => true],
  ['type-null', () => null],
  ['type-array', () => []],
  ['type-object', () => ({})],
];

function candidatesFor(node: Node, ids: ReadonlySet<string>): SliceMutation[] {
  const { path, value } = node;
  const key = path[path.length - 1];
  const out: SliceMutation[] = [];
  if (key !== undefined) {
    out.push(
      build('delete', path, '', (copy) => {
        const parent = parentOf(copy, path);
        if (Array.isArray(parent)) parent.splice(Number(key), 1);
        else if (parent !== undefined) delete (parent as Record<string, unknown>)[String(key)];
      }),
    );
    for (const [kind, make] of TYPE_SWAPS) out.push(build(kind, path, '', replaceAt(path, make)));
  }
  if (typeof value === 'number' && key !== undefined) {
    out.push(
      build(
        'number-minus-one',
        path,
        '',
        replaceAt(path, () => -1),
      ),
    );
    out.push(
      build(
        'number-1e308',
        path,
        '',
        replaceAt(path, () => 1e308),
      ),
    );
    out.push(
      build(
        'number-nan',
        path,
        '',
        replaceAt(path, () => Number.NaN),
      ),
    );
    out.push(
      build(
        'number-infinity',
        path,
        '',
        replaceAt(path, () => Number.POSITIVE_INFINITY),
      ),
    );
    out.push(
      build(
        'number-minus-infinity',
        path,
        '',
        replaceAt(path, () => Number.NEGATIVE_INFINITY),
      ),
    );
  }
  if (typeof value === 'string' && key !== undefined) {
    out.push(
      build(
        'long-string',
        path,
        '',
        replaceAt(path, () => 'x'.repeat(LONG_STRING)),
      ),
    );
    if (ids.has(value) && key !== 'id')
      out.push(
        build(
          'dangling-reference',
          path,
          value,
          replaceAt(path, () => 'missing-ref'),
        ),
      );
  }
  if (isObject(value)) addObjectMutations(node, value, out);
  if (Array.isArray(value)) addArrayMutations(path, value, out);
  return out;
}

function addObjectMutations(node: Node, value: Record<string, unknown>, out: SliceMutation[]): void {
  const { path } = node;
  const keys = Object.keys(value);
  const firstKey = keys[0];
  if (firstKey === undefined) return;
  const sample = value[firstKey];
  for (const reserved of RESERVED)
    out.push(
      build('reserved-key-added', path, reserved, (copy) => {
        const target = at(copy, path);
        if (isObject(target)) setOwn(target, reserved, clone(sample));
      }),
    );
  const reserved = RESERVED[path.length % RESERVED.length] as string;
  out.push(
    build('reserved-key-renamed', path, `${firstKey}->${reserved}`, (copy) => {
      const target = at(copy, path);
      if (!isObject(target)) return;
      const entries = Object.entries(target).map(([k, v]) =>
        k === firstKey ? ([reserved, renamedId(v, firstKey, reserved)] as const) : ([k, v] as const),
      );
      for (const k of Object.keys(target)) delete target[k];
      for (const [k, v] of entries) setOwn(target, k, v);
    }),
  );
  if (isObject(sample) && typeof sample['id'] === 'string')
    out.push(
      build('duplicate-id', path, firstKey, (copy) => {
        const target = at(copy, path);
        if (isObject(target)) setOwn(target, 'dup-fuzz', clone(sample));
      }),
    );
}

const renamedId = (child: unknown, oldKey: string, newKey: string): unknown =>
  isObject(child) && child['id'] === oldKey ? { ...child, id: newKey } : child;

function addArrayMutations(path: Path, value: unknown[], out: SliceMutation[]): void {
  const sample = value[0];
  out.push(
    build('long-array', path, '', (copy) => {
      const target = at(copy, path);
      if (Array.isArray(target)) for (let i = 0; i < LONG_ARRAY; i++) target.push(clone(sample ?? 0));
    }),
  );
  if (value.length > 0)
    out.push(
      build('duplicate-id', path, 'element', (copy) => {
        const target = at(copy, path);
        if (Array.isArray(target)) target.push(clone(sample));
      }),
    );
}

/** mulberry32 over a string seed. */
function prng(seed: string): () => number {
  let h = 1779033703;
  for (let i = 0; i < seed.length; i++) h = (Math.imul(h ^ seed.charCodeAt(i), 3432918353) << 13) | (h >>> 19);
  let state = h >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Up to `limit` mutations of the values under `roots` (dotted paths into `raw`), drawn round-robin over the mutation kinds so every kind that
 * applies is exercised before any repeats. Same `seed` and `raw` give the same list.
 */
export function sampleMutations(raw: Record<string, unknown>, roots: readonly string[], seed: string, limit: number): SliceMutation[] {
  const nodes: Node[] = [];
  for (const root of roots) {
    const path = root.split('.');
    if (at(raw, path) !== undefined) collect(at(raw, path), path, nodes, 0);
  }
  const ids = knownIds(nodes, raw);
  const random = prng(seed);
  const byKind = new Map<MutationKind, SliceMutation[]>();
  for (const node of nodes)
    for (const mutation of candidatesFor(node, ids)) byKind.set(mutation.kind, [...(byKind.get(mutation.kind) ?? []), mutation]);
  const picks: SliceMutation[] = [];
  const pools = MUTATION_KINDS.flatMap((kind) => {
    const pool = [...(byKind.get(kind) ?? [])];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [pool[i], pool[j]] = [pool[j] as SliceMutation, pool[i] as SliceMutation];
    }
    return pool.length > 0 ? [pool] : [];
  });
  while (picks.length < limit && pools.some((pool) => pool.length > 0))
    for (const pool of pools) {
      const next = pool.pop();
      if (next !== undefined && picks.length < limit) picks.push(next);
    }
  return picks;
}

/** True when the value at a dotted root exists in the raw document. */
export function hasRoot(raw: Record<string, unknown>, root: string): boolean {
  return at(raw, root.split('.')) !== undefined;
}
