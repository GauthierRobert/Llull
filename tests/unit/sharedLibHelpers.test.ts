import { describe, expect, it } from 'vitest';
import { centroid3, isVec3 } from '@lib/vec3';
import { parseHexRgb } from '@lib/isHexColor';
import { arcPolyline, circlePolygon, sampleArc } from '@lib/arc';

describe('isVec3', () => {
  it('accepts exactly three finite numbers', () => {
    expect(isVec3([1, -2, 0.5])).toBe(true);
  });

  it('rejects other lengths, non-finite and non-number components', () => {
    expect(isVec3([1, 2])).toBe(false);
    expect(isVec3([1, 2, 3, 4])).toBe(false);
    expect(isVec3([1, Number.NaN, 3])).toBe(false);
    expect(isVec3([1, '2', 3])).toBe(false);
    expect(isVec3('1,2,3')).toBe(false);
  });
});

describe('centroid3', () => {
  it('averages the points', () => {
    expect(
      centroid3([
        [0, 0, 0],
        [2, 4, 6],
      ]),
    ).toEqual([1, 2, 3]);
  });

  it('is the origin for no points', () => {
    expect(centroid3([])).toEqual([0, 0, 0]);
  });
});

describe('parseHexRgb', () => {
  it('parses #rrggbb and rrggbb in any case, trimmed', () => {
    expect(parseHexRgb('#FF8000')).toEqual([255, 128, 0]);
    expect(parseHexRgb(' 0a0b0c ')).toEqual([10, 11, 12]);
  });

  it('is null for anything else', () => {
    expect(parseHexRgb('#fff')).toBeNull();
    expect(parseHexRgb('red')).toBeNull();
  });
});

describe('arc sampling', () => {
  it('arcPolyline includes both ends', () => {
    const points = arcPolyline([1, 1], 2, 0, Math.PI, 2);
    expect(points).toHaveLength(3);
    expect(points[0]).toEqual([3, 1]);
    expect(points[2]?.[0]).toBeCloseTo(-1);
  });

  it('arcPolyline scales Y by radiusY for an ellipse arc', () => {
    const [, top] = arcPolyline([0, 0], 2, 0, Math.PI / 2, 1, 5);
    expect(top?.[1]).toBeCloseTo(5);
  });

  it('sampleArc omits the start point', () => {
    expect(sampleArc([0, 0], 1, 0, Math.PI, 2)).toEqual(
      arcPolyline([0, 0], 1, 0, Math.PI, 2).slice(1),
    );
  });

  it('circlePolygon is the open full circle', () => {
    const ring = circlePolygon([0, 0], 1, 4);
    expect(ring).toHaveLength(4);
    expect(ring[0]).toEqual([1, 0]);
  });
});
