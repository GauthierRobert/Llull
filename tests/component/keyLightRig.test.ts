import { describe, it, expect } from 'vitest';
import { computeKeyLightRig, MIN_SHADOW_HALF_EXTENT } from '@ui/viewport/3d/keyLightRig';

describe('computeKeyLightRig', () => {
  it('keeps the original fixed rig for an empty or small scene', () => {
    const empty = computeKeyLightRig(null, [0, 0, 0]);
    expect(empty).toMatchObject({
      target: [0, 0, 0],
      position: [8, -6, 14],
      halfExtent: MIN_SHADOW_HALF_EXTENT,
      near: 0.5,
      far: 200,
    });
    const small = computeKeyLightRig({ min: [-1, -1, 0], max: [1, 1, 2] }, [0, 0, 0]);
    expect(small.halfExtent).toBe(MIN_SHADOW_HALF_EXTENT);
  });

  it('grows the shadow frustum with a large scene and aims at its centre', () => {
    const rig = computeKeyLightRig({ min: [0, 0, 0], max: [20000, 20000, 0] }, [0, 0, 0]);
    expect(rig.target).toEqual([10000, 10000, 0]);
    expect(rig.halfExtent).toBeGreaterThan(10000);
    expect(rig.far).toBeGreaterThan(200 * 100);
    // light stays on the same side of the target as the original rig
    expect(rig.position[0]).toBeGreaterThan(rig.target[0]);
    expect(rig.position[1]).toBeLessThan(rig.target[1]);
    expect(rig.position[2]).toBeGreaterThan(rig.target[2]);
  });

  it('works in render space: the target is shifted by the floating origin', () => {
    const rig = computeKeyLightRig({ min: [9000, 0, 0], max: [11000, 0, 0] }, [10000, 0, 0]);
    expect(rig.target[0]).toBeCloseTo(0);
  });
});
