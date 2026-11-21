import { describe, it, expect } from 'vitest';
import { computeKeyLightRig, BASE_SHADOW_HALF_EXTENT } from '@ui/viewport/3d/keyLightRig';

describe('computeKeyLightRig', () => {
  it('keeps the base rig for an empty scene and hugs a small one, light on the same side', () => {
    const empty = computeKeyLightRig(null, [0, 0, 0]);
    expect(empty).toMatchObject({ target: [0, 0, 0], position: [-4, -9, 14], halfExtent: BASE_SHADOW_HALF_EXTENT, near: 0.5, far: 200 });
    const small = computeKeyLightRig({ min: [-1, -1, 0], max: [1, 1, 2] }, [0, 0, 0]);
    // bounding-sphere radius sqrt(3) × padding: the shadow map covers the part, not 60 units around it
    expect(small.halfExtent).toBeCloseTo(Math.sqrt(3) * 2.2);
    expect(small.target).toEqual([0, 0, 1]);
    const scale = small.halfExtent / BASE_SHADOW_HALF_EXTENT;
    expect(small.position[0]).toBeCloseTo(-4 * scale);
    expect(small.position[2]).toBeCloseTo(1 + 14 * scale);
    expect(small.far).toBeCloseTo(200 * scale);
    expect(computeKeyLightRig({ min: [1, 1, 1], max: [1, 1, 1] }, [0, 0, 0]).halfExtent).toBeGreaterThan(0);
  });
  it('grows the shadow frustum with a large scene and aims at its centre', () => {
    const rig = computeKeyLightRig({ min: [0, 0, 0], max: [20000, 20000, 0] }, [0, 0, 0]);
    expect(rig.target).toEqual([10000, 10000, 0]);
    expect(rig.halfExtent).toBeGreaterThan(10000);
    expect(rig.far).toBeGreaterThan(200 * 100);
    // light stays on the same side of the target as the base rig
    expect(rig.position[0]).toBeLessThan(rig.target[0]);
    expect(rig.position[1]).toBeLessThan(rig.target[1]);
    expect(rig.position[2]).toBeGreaterThan(rig.target[2]);
  });
  it('works in render space: the target is shifted by the floating origin', () => {
    const rig = computeKeyLightRig({ min: [9000, 0, 0], max: [11000, 0, 0] }, [10000, 0, 0]);
    expect(rig.target[0]).toBeCloseTo(0);
  });
});
