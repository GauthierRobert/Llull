import { describe, expect, it } from 'vitest';
import { GTAO_MAX_RADIUS_MM, gtaoParameters, gtaoRadius, gtaoSize, viewDepthRange } from '@ui/viewport/3d/effects/gtaoSettings';

describe('gtao settings', () => {
  it('halves the frame, rounding up and never below one pixel', () => {
    expect(gtaoSize(1920, 1080)).toEqual({ width: 960, height: 540 });
    expect(gtaoSize(1001, 7)).toEqual({ width: 501, height: 4 });
    expect(gtaoSize(1, 1)).toEqual({ width: 1, height: 1 });
    expect(gtaoSize(0, 0)).toEqual({ width: 1, height: 1 });
  });
  it('scales the reach with the scene and caps it, so a tiny part is not drowned in a plant-sized radius', () => {
    expect(gtaoRadius(3.4, 1000)).toBeCloseTo(0.204);
    expect(gtaoRadius(200_000, 1000)).toBe(1000);
    expect(gtaoRadius(null, 1000)).toBe(1000);
    expect(gtaoRadius(0, 1000)).toBe(1000);
    expect(gtaoRadius(Number.NaN, 1000)).toBe(1000);
    expect(GTAO_MAX_RADIUS_MM).toBe(1000);
  });
  it('puts the thickness below the radius', () => {
    const parameters = gtaoParameters(0.6);
    expect(parameters.radius).toBe(0.6);
    expect(parameters.thickness).toBeLessThan(parameters.radius);
  });
});

describe('view depth range', () => {
  const forward = [0, 1, 0] as const;
  it('hugs the scene box along the view with a little slack, inside the camera range', () => {
    const range = viewDepthRange([0, -10, 0], forward, [-1, 0, -1], [1, 4, 1], 0.005, 20000);
    expect(range.near).toBeCloseTo(10 / 1.05);
    expect(range.far).toBeCloseTo(14 * 1.05);
  });
  it('from inside the box (the walk case) keeps near at far x 1e-4, not the view camera near', () => {
    const range = viewDepthRange([0, 1, 0], forward, [-5, 0, -5], [5, 50, 5], 0.001, 20000);
    expect(range.far).toBeCloseTo(49 * 1.05);
    expect(range.near).toBeCloseTo(49 * 1.05 * 1e-4);
    expect(range.near).toBeGreaterThan(0.001);
  });
  it('never exceeds the camera range and falls back to it when the box is behind the eye or degenerate', () => {
    expect(viewDepthRange([0, -10, 0], forward, [-1, 0, -1], [1, 4, 1], 12, 13)).toEqual({ near: 12, far: 13 });
    expect(viewDepthRange([0, 100, 0], forward, [-1, 0, -1], [1, 4, 1], 0.01, 500)).toEqual({ near: 0.01, far: 500 });
    expect(viewDepthRange([0, 0, 0], forward, [Number.NaN, 0, 0], [1, 1, 1], 0.01, 500)).toEqual({ near: 0.01, far: 500 });
  });
});
