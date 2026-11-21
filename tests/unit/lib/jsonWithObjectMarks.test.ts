/** jsonWithObjectMarks feeds the live state hash: it must equal JSON.stringify with the marking replacer, byte for byte. */
import { describe, expect, it } from 'vitest';
import { jsonWithObjectMarks } from '@lib/jsonWithObjectMarks';
import { seeded } from '../cae/gridMesh';

const isNode = (value: object): boolean => typeof (value as { op?: unknown }).op === 'string';
const mark = (value: object): string | undefined => (isNode(value) ? `mark:${(value as { op: string }).op}` : undefined);

function reference(value: unknown): string {
  return JSON.stringify(value, (key, entry: unknown) =>
    key !== '' && typeof entry === 'object' && entry !== null && mark(entry) !== undefined ? mark(entry) : entry,
  );
}

const LEAVES: readonly unknown[] = [0, -0, 1.5, 1e21, Number.NaN, 'text', 'é"\n', true, null, undefined];
const KEYS = ['b', 'a', '10', '2', '', 'op', 'mesh', 'é'];

function randomValue(next: () => number, depth: number): unknown {
  const roll = next();
  if (depth === 0 || roll < 0.3) return LEAVES[Math.floor(next() * LEAVES.length)];
  if (roll < 0.6) return Array.from({ length: Math.floor(next() * 5) }, () => randomValue(next, depth - 1));
  const record: Record<string, unknown> = {};
  const count = Math.floor(next() * 5);
  for (let index = 0; index < count; index += 1) {
    const key = KEYS[Math.floor(next() * KEYS.length)] ?? 'k';
    record[key] = key === 'op' && next() < 0.7 ? 'union' : randomValue(next, depth - 1);
  }
  return record;
}

describe('jsonWithObjectMarks', () => {
  it('writes a mark for a nested marked object and the root itself in full', () => {
    const node = { op: 'box', size: [1, 2, 3] };
    expect(jsonWithObjectMarks(node, mark)).toBe('{"op":"box","size":[1,2,3]}');
    expect(jsonWithObjectMarks(['id', { brep: node, list: [node] }], mark)).toBe('["id",{"brep":"mark:box","list":["mark:box"]}]');
  });

  it('equals the replacer form on 4000 random trees', () => {
    const next = seeded(4711);
    for (let index = 0; index < 4000; index += 1) {
      const value = randomValue(next, 5);
      expect(jsonWithObjectMarks(value, mark)).toBe(reference(value));
    }
  });

  it('equals the replacer form on the shapes JSON.stringify treats specially', () => {
    const cases: readonly unknown[] = [
      undefined,
      'text',
      [undefined, () => 1],
      { skipped: undefined, kept: 1, '': { op: 'not marked: its key is empty' } },
      { when: new Date(Date.UTC(2026, 0, 2)) },
      new Float32Array([1.5, 2]),
      { positions: new Float32Array([1.5, 2]), nested: [[1, [2, { op: 'x' }]], [3]] },
      { toJSON: () => ({ op: 'made by toJSON' }) },
      { inner: { toJSON: () => ({ op: 'made by toJSON' }) } },
    ];
    for (const value of cases) expect(jsonWithObjectMarks(value, mark)).toBe(reference(value));
  });

  it('offers arrays to the mark too, so a caller can stand a long array for a digest', () => {
    const digest = (value: object): string | undefined =>
      Array.isArray(value) && value.length > 3 ? `array of ${value.length}` : undefined;
    expect(jsonWithObjectMarks({ short: [1, 2], long: [1, 2, 3, 4], nested: [{ long: [5, 6, 7, 8] }] }, digest)).toBe(
      '{"short":[1,2],"long":"array of 4","nested":[{"long":"array of 4"}]}',
    );
  });
});
