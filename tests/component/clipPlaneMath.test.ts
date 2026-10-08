import { describe, it, expect } from 'vitest';
import { renderClipPlane } from '@ui/viewport/3d/clipPlaneMath';

/** Signed distance of a RENDER-space point from the plane. */
function side(plane: ReturnType<typeof renderClipPlane>, p: [number, number, number]): number {
  return plane.normal[0] * p[0] + plane.normal[1] * p[1] + plane.normal[2] * p[2] + plane.constant;
}

describe('renderClipPlane', () => {
  it('matches the world plane when the render origin is zero', () => {
    const plane = renderClipPlane('z', false, 5, [0, 0, 0]);
    expect(plane.normal).toEqual([0, 0, 1]);
    expect(plane.constant).toBe(-5);
  });

  it('passes through the world cut point after the floating origin shifts', () => {
    const plane = renderClipPlane('x', false, 10042, [10000, 2000, 300]);
    // world x=10042 is render x=42
    expect(side(plane, [42, 7, 7])).toBeCloseTo(0);
    expect(side(plane, [50, 0, 0])).toBeGreaterThan(0);
  });

  it('flipped planes cut at the mirrored world position', () => {
    const plane = renderClipPlane('y', true, 3, [0, 400, 0]);
    expect(plane.normal).toEqual([0, -1, 0]);
    // world y=-3 is render y=-403
    expect(side(plane, [0, -403, 0])).toBeCloseTo(0);
  });
});
