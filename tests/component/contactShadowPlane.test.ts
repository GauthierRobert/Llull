import { describe, it, expect } from 'vitest';
import { computeContactShadowPlane } from '@ui/viewport/3d/contactShadowPlane';

describe('computeContactShadowPlane', () => {
  it('keeps the original fixed patch for an empty scene', () => {
    expect(computeContactShadowPlane(null, [0, 0, 0])).toEqual({
      position: [0, 0, -0.001],
      scale: 40,
      far: 20,
    });
  });

  it('shrinks the patch to a tiny part instead of a 40-unit slab', () => {
    const plane = computeContactShadowPlane(
      { min: [0.49, 0.49, 0], max: [0.51, 0.51, 0.02] },
      [0, 0, 0],
    );
    expect(plane.scale).toBeCloseTo(0.04);
    expect(plane.position[0]).toBeCloseTo(0.5);
    expect(plane.far).toBeLessThan(1);
  });

  it('grows with a large off-origin model and follows the floating origin', () => {
    const plane = computeContactShadowPlane(
      { min: [16000, 5000, 0], max: [24000, 11000, 3000] },
      [20000, 8000, 0],
    );
    expect(plane.scale).toBe(16000);
    expect(plane.position[0]).toBeCloseTo(0);
    expect(plane.position[1]).toBeCloseTo(0);
    expect(plane.far).toBeGreaterThanOrEqual(3000);
  });

  it('drops to the lowest point when the scene dips below the ground', () => {
    const plane = computeContactShadowPlane({ min: [0, 0, -5], max: [10, 10, 5] }, [0, 0, 0]);
    expect(plane.position[2]).toBeLessThan(-5);
  });
});
