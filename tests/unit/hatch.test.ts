import { describe, expect, it } from 'vitest';
import { hatchSegments } from '@lib/hatch';

const SQUARE: Array<[number, number]> = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

describe('hatchSegments', () => {
  it('fills a square with horizontal lines', () => {
    const lines = hatchSegments([SQUARE], 0, 2.5);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toEqual([
      [0, 0],
      [10, 0],
    ]);
  });

  it('skips holes (even-odd) and clips diagonal lines to the region', () => {
    const hole: Array<[number, number]> = [
      [3, 3],
      [7, 3],
      [7, 7],
      [3, 7],
    ];
    const lines = hatchSegments([SQUARE, hole], 0, 1);
    const atFive = lines.filter(([a]) => Math.abs(a[1] - 5) < 1e-9);
    expect(atFive).toEqual([
      [
        [0, 5],
        [3, 5],
      ],
      [
        [7, 5],
        [10, 5],
      ],
    ]);
    const diagonal = hatchSegments([SQUARE], Math.PI / 4, 1);
    for (const [a, b] of diagonal) {
      for (const [x, y] of [a, b]) {
        expect(x).toBeGreaterThanOrEqual(-1e-9);
        expect(y).toBeLessThanOrEqual(10 + 1e-9);
      }
      expect(Math.abs(b[0] - a[0] - (b[1] - a[1]))).toBeLessThan(1e-9);
    }
    expect(diagonal.length).toBeGreaterThan(10);
  });

  it('returns nothing for degenerate input', () => {
    expect(hatchSegments([SQUARE], 0, 0)).toEqual([]);
    expect(
      hatchSegments(
        [
          [
            [0, 0],
            [1, 1],
          ],
        ],
        0,
        1,
      ),
    ).toEqual([]);
  });
});
