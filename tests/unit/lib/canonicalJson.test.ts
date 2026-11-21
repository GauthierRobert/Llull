/** canonicalJson is the text of every content hash: the fast writer must equal the replacer-based reference byte for byte. */
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@lib/canonicalJson';
import { gridMesh, seeded } from '../cae/gridMesh';
import { timeBudgetMs } from '../../helpers/timeBudget';

/** The definition the hashes were first computed with. */
function referenceCanonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry !== null && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : entry,
  );
}

const KEYS = ['b', 'a', '10', '9', '2', '01', '-1', '4294967294', '4294967295', 'é', 'Z', '', 'a b', '"q"', '__proto__', '1.5', '1e3'];
const LEAVES: readonly unknown[] = [0, -0, 1.5, 1e21, 1e-7, Number.NaN, Infinity, 'text', 'é"\n ', '', true, false, null, undefined];

function randomValue(next: () => number, depth: number): unknown {
  const roll = next();
  if (depth === 0 || roll < 0.35) return LEAVES[Math.floor(next() * LEAVES.length)];
  if (roll < 0.65) return Array.from({ length: Math.floor(next() * 5) }, () => randomValue(next, depth - 1));
  const record: Record<string, unknown> = {};
  const count = Math.floor(next() * 6);
  for (let index = 0; index < count; index += 1) {
    const key = KEYS[Math.floor(next() * KEYS.length)] ?? 'k';
    Object.defineProperty(record, key, { value: randomValue(next, depth - 1), enumerable: true, writable: true, configurable: true });
  }
  return record;
}

describe('canonicalJson', () => {
  it('sorts keys at every depth, integer-like keys first in numeric order', () => {
    expect(canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: null }, 10: 'x', 9: 'y' })).toBe(
      '{"9":"y","10":"x","a":{"c":null,"d":[{"y":2,"z":1}]},"b":1}',
    );
  });

  it('equals the reference on 4000 random trees', () => {
    const next = seeded(20261118);
    for (let index = 0; index < 4000; index += 1) {
      const value = randomValue(next, 5);
      expect(canonicalJson(value)).toBe(referenceCanonicalJson(value));
    }
  });

  it('equals the reference on the shapes JSON.stringify treats specially', () => {
    const cases: readonly unknown[] = [
      undefined,
      null,
      'text',
      3,
      [undefined, () => 1, Symbol('s')],
      { skipped: undefined, fn: () => 1, kept: 1 },
      new Date(Date.UTC(2026, 0, 2)),
      { when: new Date(Date.UTC(2026, 0, 2)), list: [new Date(0)] },
      new Float64Array([1.5, 2]),
      [new Float64Array([1])],
      new Map([[1, 2]]),
      { nested: [[1, [2, { b: 1, a: 2 }]], [3]] },
      Object.assign([1, 2], { extra: 1 }),
      { toJSON: () => ({ z: 1, a: 2 }) },
      { toJSON: (key: string) => `key:${key}` },
      { inner: { toJSON: (key: string) => `key:${key}` }, list: [{ toJSON: (key: string) => `key:${key}` }] },
    ];
    for (const value of cases) expect(canonicalJson(value)).toBe(referenceCanonicalJson(value));
  });

  it('refuses a bigint like JSON.stringify', () => {
    expect(() => canonicalJson({ n: 1n })).toThrow(TypeError);
  });

  it('equals the reference on a mesh-sized artifact and writes it in one native pass', () => {
    const grid = gridMesh({ cells: [24, 10, 10], size: [100, 20, 20], quadratic: true });
    const values: Record<string, number[]> = {};
    for (const node of grid.nodes) values[String(node[0])] = [node[1] * 1e-3, node[2] / 7, -node[3]];
    const artifact = { kind: 'fe_results', nodes: grid.nodes, elements: grid.elements, steps: [{ time: 1, fields: { DISP: { values } } }] };
    const expected = referenceCanonicalJson(artifact);
    const started = performance.now();
    const text = canonicalJson(artifact);
    const elapsed = performance.now() - started;
    expect(text).toBe(expected);
    expect(elapsed).toBeLessThan(timeBudgetMs(150));
  });
});
