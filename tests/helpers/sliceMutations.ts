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
  'prototype-key-string',
] as const;
export type MutationKind = (typeof MUTATION_KINDS)[number];

/** Kinds JSON cannot carry: they are applied to the object and checked on the validators only. */
export const NON_JSON_KINDS: ReadonlySet<MutationKind> = new Set(['number-nan', 'number-infinity', 'number-minus-infinity']);

const RESERVED = ['__proto__', 'constructor', 'prototype'] as const;
const PROTOTYPE_KEYS = ['hasOwnProperty', 'toString', 'valueOf', '__proto__', 'constructor'] as const;
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
    for (const proto of PROTOTYPE_KEYS)
      out.push(
        build(
          'prototype-key-string',
          path,
          proto,
          replaceAt(path, () => proto),
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

/** Targeted hostile edits of the drive data of `dynamics` (PHY-23): the segment kind / law / points of a profile and the gains of a drive. */
export function driveMutations(raw: Record<string, unknown>): SliceMutation[] {
  const edit = (label: string, change: (dynamics: Record<string, unknown>) => void): SliceMutation => ({
    kind: 'type-string',
    path: `dynamics.${label}`,
    label: `dynamics | ${label}`,
    apply: (document) => {
      const copy = clone(document);
      const dynamics = copy['dynamics'];
      if (isObject(dynamics)) change(dynamics);
      return copy;
    },
  });
  const firstProfile = (dynamics: Record<string, unknown>): Record<string, unknown> => {
    const profiles = dynamics['profiles'];
    const profile = isObject(profiles) ? Object.values(profiles).find(isObject) : undefined;
    if (profile === undefined) throw new Error('driveMutations: the seed has no profile');
    return profile;
  };
  const setSegment = (segment: unknown) => (dynamics: Record<string, unknown>) => void (firstProfile(dynamics)['segments'] = [segment]);
  const drive = (dynamics: Record<string, unknown>): Record<string, unknown> => {
    const drives = dynamics['drives'];
    const found = isObject(drives) ? Object.values(drives).find(isObject) : undefined;
    if (found === undefined) throw new Error('driveMutations: the seed has no drive');
    return found;
  };
  void raw;
  return [
    edit('segment kind foo', setSegment({ kind: 'foo' })),
    edit('segment null', setSegment(null)),
    edit('segment kind number', setSegment({ kind: 7 })),
    edit('move law bogus', setSegment({ kind: 'move', law: 'bogus', to: 1, duration: 1 })),
    edit('move law __proto__', setSegment({ kind: 'move', law: '__proto__', to: 1, duration: 1 })),
    edit('move law constructor', setSegment({ kind: 'move', law: 'constructor', to: 1, duration: 1 })),
    edit('table points string', setSegment({ kind: 'table', points: 'abc', interpolation: 'linear' })),
    edit('table points nulls', setSegment({ kind: 'table', points: [null, null], interpolation: 'linear' })),
    edit('table points missing', setSegment({ kind: 'table', interpolation: 'linear' })),
    edit(
      'table points triples',
      setSegment({
        kind: 'table',
        points: [
          [0, 1, 2],
          [1, 2, 3],
        ],
        interpolation: 'monotone_cubic',
      }),
    ),
    edit(
      'table interpolation odd',
      setSegment({
        kind: 'table',
        points: [
          [0, 1],
          [1, 2],
        ],
        interpolation: 'spline',
      }),
    ),
    edit('sine amplitude string', setSegment({ kind: 'sine', amplitude: 'a', frequencyHz: 1, cycles: 1 })),
    edit('segments not an array', (dynamics) => void (firstProfile(dynamics)['segments'] = { length: 1 })),
    edit('profile start string', (dynamics) => void (firstProfile(dynamics)['start'] = 'x')),
    edit('profile repeat huge', (dynamics) => void (firstProfile(dynamics)['repeat'] = 1e9)),
    edit('gains kp string', (dynamics) => void (drive(dynamics)['gains'] = { kp: 'x', ki: 0, kpPosition: 0 })),
    edit('gains ki null', (dynamics) => void (drive(dynamics)['gains'] = { kp: 1, ki: null, kpPosition: 0 })),
    edit('gains kpPosition string', (dynamics) => void (drive(dynamics)['gains'] = { kp: 1, ki: 0, kpPosition: 'x' })),
    edit('gains negative kp', (dynamics) => void (drive(dynamics)['gains'] = { kp: -1, ki: 0, kpPosition: 0 })),
    edit('gains array', (dynamics) => void (drive(dynamics)['gains'] = [1, 2, 3])),
    edit('tune bandwidth string', (dynamics) => void (drive(dynamics)['tune'] = { bandwidthHz: 'x', dampingRatio: 1 })),
    edit('target number', (dynamics) => void (drive(dynamics)['target'] = 5)),
    edit('feedforward string', (dynamics) => void (drive(dynamics)['feedforward'] = 'yes')),
    ...mechanismMutations(edit),
  ];
}

type Edit = (label: string, change: (dynamics: Record<string, unknown>) => void) => SliceMutation;

/** Targeted hostile edits of the PHY-23 transmissions, joint physics and load schedules of `dynamics`. */
function mechanismMutations(edit: Edit): SliceMutation[] {
  const record =
    (table: string, id: string) =>
    (dynamics: Record<string, unknown>): Record<string, unknown> => {
      const records = dynamics[table];
      const found = isObject(records) ? records[id] : undefined;
      if (!isObject(found)) throw new Error(`mechanismMutations: the seed has no ${table}.${id}`);
      return found;
    };
  const gear = record('transmissions', 'tg');
  const screw = record('transmissions', 'ts');
  const physics = record('jointPhysics', 'j2');
  const load = record('loadSchedules', 'ls');
  const set =
    (target: (dynamics: Record<string, unknown>) => Record<string, unknown>, key: string, value: unknown) =>
    (dynamics: Record<string, unknown>): void =>
      void (target(dynamics)[key] = value);
  const friction = (dynamics: Record<string, unknown>): Record<string, unknown> => {
    const found = physics(dynamics)['friction'];
    if (!isObject(found)) throw new Error('mechanismMutations: no friction');
    return found;
  };
  return [
    edit('transmission kind foo', set(gear, 'kind', 'foo')),
    edit('transmission kind __proto__', set(gear, 'kind', '__proto__')),
    edit('transmission ratio zero', set(gear, 'ratio', 0)),
    edit('transmission ratio string', set(gear, 'ratio', '2')),
    edit('transmission efficiency 2', set(gear, 'efficiency', 2)),
    edit('transmission efficiencyBack null', set(gear, 'efficiencyBack', null)),
    edit('transmission backlash negative', set(gear, 'backlashDeg', -1)),
    edit('transmission teeth strings', set(gear, 'teeth', ['a', 'b'])),
    edit('transmission driver number', set(gear, 'driver', 7)),
    edit('transmission driven ghost', set(gear, 'driven', 'ghost')),
    edit('transmission driven twice', set(gear, 'driven', 'jn')),
    edit('transmission source grade Z', set(gear, 'source', { name: 's', grade: 'Z' })),
    edit('screw lead zero', set(screw, 'leadMm', 0)),
    edit('screw mu negative', set(screw, 'mu', -1)),
    edit('screw flank 90', set(screw, 'flankAngleDeg', 90)),
    edit('screw nut ghost joint', set(screw, 'nut', 'ghost')),
    edit('joint physics friction model foo', set(friction, 'model', 'foo')),
    edit('joint physics stribeck velocity zero', set(friction, 'stribeckVelocity', 0)),
    edit('joint physics static below coulomb', set(friction, 'static', 0.001)),
    edit('joint physics friction array', set(physics, 'friction', [1, 2])),
    edit('joint physics limits reversed', set(physics, 'limits', { min: 2, max: -2, stiffness: 10 })),
    edit('joint physics limits stiffness zero', set(physics, 'limits', { min: -1, max: 1, stiffness: 0 })),
    edit('joint physics limits restitution 5', set(physics, 'limits', { min: -1, max: 1, stiffness: 1, restitution: 5 })),
    edit('joint physics armature negative', set(physics, 'armatureKgM2', -1)),
    edit('joint physics id mismatch', set(physics, 'id', 'other')),
    edit('load target neither', set(load, 'target', {})),
    edit('load target both', set(load, 'target', { body: 'rotor', joint: 'j' })),
    edit('load target ghost joint', set(load, 'target', { joint: 'ghost' })),
    edit('load kind foo', set(load, 'kind', 'foo')),
    edit('load direction short', set(load, 'direction', [1, 2])),
    edit('load profile number', set(load, 'profile', 3)),
    edit('load profile ghost', set(load, 'profile', 'ghost')),
    edit('load without profile or constant', (dynamics) => void delete load(dynamics)['profile']),
  ];
}
