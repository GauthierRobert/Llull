/**
 * Fuzz contract: every registered command, given garbage params, must never throw,
 * never mutate the input document, and never emit non-finite numbers into the document.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { CadDocument } from '@core/model/types';
import { execute, listCommands } from '@core/commands/registry';
import { __resetIdCounter } from '@lib/id';

// The guard warns (with stack) when a command throws on garbage input; silence the expected noise.
beforeAll(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterAll(() => {
  vi.restoreAllMocks();
});

const GARBAGE: unknown[] = [
  undefined,
  null,
  NaN,
  Infinity,
  -Infinity,
  -1,
  0,
  1e12,
  '',
  'abc',
  '5',
  [],
  {},
  true,
  [NaN, 1, 2],
  ['x'],
  [{}],
];

function seeded(): CadDocument {
  let doc = createEmptyDocument();
  doc = execute(doc, 'add_box', { size: [10, 10, 10] }).document;
  doc = execute(doc, 'draw_line', { start: [0, 0], end: [10, 0] }).document;
  doc = execute(doc, 'draw_circle', { center: [0, 0], radius: 5 }).document;
  return doc;
}

function findNonFinite(value: unknown, path: string, seen: Set<unknown>): string | null {
  if (typeof value === 'number') return Number.isFinite(value) ? null : path;
  if (typeof value !== 'object' || value === null || seen.has(value)) return null;
  seen.add(value);
  for (const [k, v] of Object.entries(value)) {
    const hit = findNonFinite(v, `${path}.${k}`, seen);
    if (hit) return hit;
  }
  return null;
}

describe('fuzz: every command tolerates garbage params', () => {
  beforeEach(() => __resetIdCounter());
  for (const def of listCommands()) {
    it(def.name, () => {
      const doc = seeded();
      const ids = Object.keys(doc.entities);
      const snapshot = JSON.stringify(doc);
      const props = Object.keys(def.paramsSchema.properties);
      const variants: unknown[] = [undefined, null, 5, 'x', [], {}];
      for (const g of GARBAGE) {
        const o: Record<string, unknown> = {};
        for (const p of props) o[p] = g;
        variants.push(o);
        const withIds: Record<string, unknown> = {};
        for (const p of props) withIds[p] = /id|target|source|profile/i.test(p) ? ids[0] : g;
        variants.push(withIds);
        const idsArr: Record<string, unknown> = {};
        for (const p of props) idsArr[p] = /ids|entities/i.test(p) ? ids : g;
        variants.push(idsArr);
      }
      for (const params of variants) {
        let result;
        try {
          result = execute(doc, def.name, params);
        } catch (e) {
          throw new Error(`${def.name} threw on ${JSON.stringify(params)}: ${String(e)}`);
        }
        expect(JSON.stringify(doc), `${def.name} mutated input`).toBe(snapshot);
        expect(typeof result.summary).toBe('string');
        if (result.document !== doc) {
          const bad = findNonFinite(result.document.entities, 'entities', new Set());
          expect(bad, `${def.name} non-finite at ${bad} for ${JSON.stringify(params)}`).toBeNull();
        }
      }
    });
  }
});

describe('resource caps: huge counts are rejected, not allocated', () => {
  beforeEach(() => __resetIdCounter());
  const base = (): { doc: CadDocument; id: string } => {
    const doc = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document;
    return { doc, id: Object.keys(doc.entities)[0]! };
  };
  const cases: Array<[string, (id: string) => unknown]> = [
    ['array_linear', (id) => ({ id, count: 5e6, offset: [1, 0, 0] })],
    ['array_polar', (id) => ({ id, count: 5e6, center: [0, 0] })],
    [
      'array_along_path',
      (id) => ({
        sourceId: id,
        path: [
          [0, 0, 0],
          [1, 0, 0],
        ],
        count: 5e6,
      }),
    ],
    [
      'distribute_on_arc',
      (id) => ({
        sourceId: id,
        center: [0, 0, 0],
        normal: [0, 0, 1],
        radius: 1,
        startAngle: 0,
        endAngle: 3,
        count: 5e6,
      }),
    ],
    ['draw_involute', () => ({ baseRadius: 1, startAngle: 0, endAngle: 1, samples: 5e6 })],
    ['add_spur_gear', () => ({ module: 1, teeth: 5e6, faceWidth: 1 })],
  ];
  for (const [name, make] of cases) {
    it(`${name} rejects count 5e6 as a no-op`, () => {
      const { doc, id } = base();
      const r = execute(doc, name, make(id));
      expect(r.document).toBe(doc);
      expect(r.affected).toEqual([]);
    });
  }
});

describe('registry guard: prototype keys and short vectors', () => {
  beforeEach(() => __resetIdCounter());
  it('does not treat Object.prototype keys as entity ids', () => {
    const doc = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document;
    for (const id of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      for (const [name, params] of [
        ['delete_entity', { id }],
        ['set_entity_name', { id, name: 'x' }],
      ] as const) {
        const r = execute(doc, name, params);
        expect(r.document, `${name} ${id}`).toBe(doc);
        expect(r.affected).toEqual([]);
      }
    }
  });

  it('rejects a 1-component position instead of storing an undefined y/z', () => {
    const doc = createEmptyDocument();
    const r = execute(doc, 'add_box', { size: [1, 1, 1], position: [1] });
    expect(r.document).toBe(doc);
    expect(r.affected).toEqual([]);
  });
});

describe('registry guard: planar position shorthand', () => {
  beforeEach(() => __resetIdCounter());
  it('pads a 2-element position to [x, y, 0] for draw_rectangle', () => {
    const r = execute(createEmptyDocument(), 'draw_rectangle', {
      position: [5, 6],
      width: 4,
      height: 3,
    });
    expect(r.affected).toHaveLength(1);
    expect(r.document.entities[r.affected[0]!]!.position).toEqual([5, 6, 0]);
  });
});
