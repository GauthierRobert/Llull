import { describe, expect, it } from 'vitest';
import { GTAO_MAX_RADIUS_MM, gtaoParameters, gtaoRadius, gtaoSize, tightDepthRange } from '@ui/viewport/3d/effects/gtaoSettings';

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

describe('tight depth range', () => {
  it('hugs the scene sphere with a little slack, inside the camera range', () => {
    const range = tightDepthRange(10, 2, 0.005, 20000);
    expect(range.near).toBeCloseTo(10 - 2 * 1.05);
    expect(range.far).toBeCloseTo(10 + 2 * 1.05);
  });
  it('never exceeds the camera range and falls back to it when the camera is inside the sphere or the sphere is degenerate', () => {
    expect(tightDepthRange(10, 2, 9, 11).near).toBe(9);
    expect(tightDepthRange(10, 2, 0.005, 11).far).toBe(11);
    expect(tightDepthRange(1, 2, 0.01, 500)).toEqual({ near: 0.01, far: 500 });
    expect(tightDepthRange(10, 0, 0.01, 500)).toEqual({ near: 0.01, far: 500 });
    expect(tightDepthRange(Number.NaN, 2, 0.01, 500)).toEqual({ near: 0.01, far: 500 });
  });
});
