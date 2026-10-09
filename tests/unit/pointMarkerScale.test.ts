import { describe, it, expect } from 'vitest';
import { worldUnitsForPixels } from '@ui/viewport/2d/pointMarkerScale';

describe('worldUnitsForPixels', () => {
  it('orthographic: pixels / zoom, so a zoomed-out mm drawing still gets a visible marker', () => {
    expect(worldUnitsForPixels(5, { kind: 'orthographic', zoom: 0.005 })).toBeCloseTo(1000);
    expect(worldUnitsForPixels(5, { kind: 'orthographic', zoom: 0 })).toBe(1);
  });

  it('perspective: pixels scale with distance (90deg fov, 1000px => 2*d/1000 per px)', () => {
    const units = worldUnitsForPixels(10, {
      kind: 'perspective',
      fovDegrees: 90,
      distance: 500,
      viewportHeight: 1000,
    });
    expect(units).toBeCloseTo(10);
    expect(
      worldUnitsForPixels(10, {
        kind: 'perspective',
        fovDegrees: 90,
        distance: 0,
        viewportHeight: 1000,
      }),
    ).toBe(1);
  });
});
