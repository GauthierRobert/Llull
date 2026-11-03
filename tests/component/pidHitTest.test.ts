import { describe, expect, it } from 'vitest';
import type { PidGlyph } from '@aec/index';
import type { DrawingPrimitive } from '@core/model/drawing';
import { distanceToPrimitive, hitTestGlyphs } from '@ui/viewport/2d/pidHitTest';

const glyph = (id: string, primitives: PidGlyph['primitives']): PidGlyph => ({ id, kind: 'equipment', layer: 'PID-EQPT', primitives });
const line = (a: [number, number], b: [number, number], layer = 'PID-PIPE'): DrawingPrimitive => ({
  type: 'line',
  layer,
  style: 'visible',
  a,
  b,
});

describe('pidHitTest', () => {
  it('measures the distance to a segment, clamped at its ends', () => {
    expect(distanceToPrimitive([5, 3], line([0, 0], [10, 0]), 1)).toBeCloseTo(3);
    expect(distanceToPrimitive([13, 4], line([0, 0], [10, 0]), 1)).toBeCloseTo(5);
    expect(distanceToPrimitive([1, 1], line([2, 2], [2, 2]), 1)).toBeCloseTo(Math.SQRT2);
  });

  it('treats a polygon / circle interior as a weak hit and outlines as strong', () => {
    const square: DrawingPrimitive = {
      type: 'polygon',
      layer: 'PID-EQPT',
      style: 'visible',
      points: [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
    };
    expect(distanceToPrimitive([5, 5], square, 2)).toBe(1);
    expect(distanceToPrimitive([10.5, 5], square, 2)).toBeCloseTo(0.5);
    expect(distanceToPrimitive([50, 50], square, 2)).toBeGreaterThan(2);
    const circle: DrawingPrimitive = { type: 'circle', layer: 'PID-INST', style: 'visible', center: [0, 0], radius: 5 };
    expect(distanceToPrimitive([0, 0], circle, 2)).toBe(1);
    expect(distanceToPrimitive([5.5, 0], circle, 2)).toBeCloseTo(0.5);
  });

  it('measures an arc along its sweep and ignores text', () => {
    const arc: DrawingPrimitive = {
      type: 'arc',
      layer: 'PID-PIPE',
      style: 'visible',
      center: [0, 0],
      radius: 10,
      startAngle: 0,
      endAngle: Math.PI / 2,
    };
    expect(distanceToPrimitive([10, 0], arc, 1)).toBeCloseTo(0);
    expect(distanceToPrimitive([-10, 0], arc, 1)).toBeGreaterThan(5);
    const text: DrawingPrimitive = { type: 'text', layer: 'PID-TEXT', style: 'annotation', at: [0, 0], height: 3, content: 'x' };
    expect(distanceToPrimitive([0, 0], text, 1)).toBe(Infinity);
  });

  it('picks the nearest glyph within tolerance, skips hidden layers, else null', () => {
    const a = glyph('a', [line([0, 0], [10, 0])]);
    const b = glyph('b', [line([0, 2], [10, 2])]);
    expect(hitTestGlyphs([a, b], [5, 1.8], 1)?.id).toBe('b');
    expect(hitTestGlyphs([a, b], [5, 0.2], 1)?.id).toBe('a');
    expect(hitTestGlyphs([a, b], [5, 20], 1)).toBeNull();
    expect(hitTestGlyphs([a], [5, 0], 1, (layer) => layer !== 'PID-PIPE')).toBeNull();
    expect(hitTestGlyphs([], [0, 0], 1)).toBeNull();
  });
});
