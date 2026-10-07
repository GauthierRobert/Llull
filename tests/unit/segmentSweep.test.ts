import { describe, it, expect } from 'vitest';
import { segmentIntersection, type Segment } from '../../src/ui/viewport/2d/snapping/geometry';
import { allSegmentIntersections } from '../../src/ui/viewport/2d/snapping/segmentSweep';

const key = (p: [number, number]): string => `${p[0].toFixed(6)},${p[1].toFixed(6)}`;

function bruteForce(segments: ReadonlyArray<Segment>): Array<[number, number]> {
  const found: Array<[number, number]> = [];
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      const point = segmentIntersection(...(segments[i] as Segment), ...(segments[j] as Segment));
      if (point) found.push(point);
    }
  }
  return found;
}

describe('allSegmentIntersections', () => {
  it('finds the crossing of two segments and ignores disjoint ones', () => {
    const points = allSegmentIntersections([
      [0, 0, 10, 10],
      [0, 10, 10, 0],
      [100, 100, 110, 100],
    ]);
    expect(points).toHaveLength(1);
    expect(points[0]?.[0]).toBeCloseTo(5);
    expect(points[0]?.[1]).toBeCloseTo(5);
  });

  it('matches brute force on a pseudo-random scene (including touching endpoints)', () => {
    let seed = 7;
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    const segments: Segment[] = Array.from({ length: 300 }, () => {
      const x = Math.round(random() * 40);
      const y = Math.round(random() * 40);
      return [x, y, x + Math.round(random() * 12 - 6), y + Math.round(random() * 12 - 6)];
    });
    const expected = bruteForce(segments).map(key).sort();
    expect(allSegmentIntersections(segments).map(key).sort()).toEqual(expected);
  });

  it('handles an empty or single-segment input', () => {
    expect(allSegmentIntersections([])).toEqual([]);
    expect(allSegmentIntersections([[0, 0, 1, 1]])).toEqual([]);
  });
});
