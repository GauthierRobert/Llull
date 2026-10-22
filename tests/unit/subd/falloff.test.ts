import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FALLOFF_SHAPES, type FalloffShape, falloffCurve, graphDistances, softWeight } from '@lib/falloff';

interface Row {
  readonly dOverR: number;
  readonly [shape: string]: number;
}

const table = (
  JSON.parse(
    readFileSync(new URL('../../../docs/design/04-direct-freeform-editing/validation/data/falloff_curves.json', import.meta.url), 'utf8'),
  ) as { table: Row[] }
).table;

describe('falloff curves (VC-DIR-10)', () => {
  it.each(FALLOFF_SHAPES)('%s matches the Blender table at 21 samples', (shape) => {
    for (const row of table) {
      const weight = softWeight(row.dOverR, 1, shape as FalloffShape);
      expect(weight, `${shape} at d/R ${row.dOverR}`).toBeCloseTo(row[shape] as number, 11);
    }
  });
  it('is 1 on the selection, 0 at and beyond the radius, monotone', () => {
    for (const shape of FALLOFF_SHAPES) {
      expect(softWeight(0, 2, shape)).toBe(1);
      expect(softWeight(2, 2, shape)).toBe(0);
      expect(softWeight(3, 2, shape)).toBe(0);
      expect(softWeight(1, 0, shape)).toBe(0);
      let previous = -Infinity;
      for (let t = 0; t <= 1; t += 0.05) {
        const value = falloffCurve(t, shape);
        expect(value).toBeGreaterThanOrEqual(previous - 1e-12);
        previous = value;
      }
    }
  });
});

describe('graphDistances', () => {
  it('finds shortest paths from the nearest seed and Infinity for unreachable nodes', () => {
    const edges = [
      { a: 0, b: 1, length: 1 },
      { a: 1, b: 2, length: 2 },
      { a: 0, b: 2, length: 5 },
      { a: 2, b: 3, length: 1 },
      { a: 4, b: 5, length: 1 },
    ];
    expect(graphDistances(6, edges, [0])).toEqual([0, 1, 3, 4, Infinity, Infinity]);
    expect(graphDistances(6, edges, [0, 3])).toEqual([0, 1, 1, 0, Infinity, Infinity]);
  });
  it('handles many nodes through the heap', () => {
    const n = 200;
    const edges = Array.from({ length: n - 1 }, (_, i) => ({ a: i, b: i + 1, length: 1 }));
    expect(graphDistances(n, edges, [0])[n - 1]).toBe(n - 1);
    const star = Array.from({ length: n - 1 }, (_, i) => ({ a: 0, b: i + 1, length: (i * 37) % 11 }));
    expect(graphDistances(n, star, [0]).every((d) => Number.isFinite(d))).toBe(true);
  });
});
