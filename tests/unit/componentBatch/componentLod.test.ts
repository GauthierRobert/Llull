import { describe, expect, it } from 'vitest';
import type { PlanCamera } from '@core/geometry/renderPlanCamera';
import { packBoxes } from '@core/geometry/instanceBvh';
import { assignTiers, packTiers, tierForPixels } from '@ui/viewport/3d/componentBatch/componentLod';

const CAMERA: PlanCamera = {
  projection: 'perspective',
  eye: [0, 0, 0],
  direction: [1, 0, 0],
  up: [0, 0, 1],
  fovDeg: 60,
  viewHeight: 0,
  widthPx: 1600,
  heightPx: 1000,
};

/** A cube of edge `edge` centred `distance` ahead of the camera. */
function cubeAt(distance: number, edge: number): { min: [number, number, number]; max: [number, number, number] } {
  const h = edge / 2;
  return { min: [distance - h, -h, -h], max: [distance + h, h, h] };
}

describe('tierForPixels', () => {
  it('picks the tier from the thresholds 48 / 8 px', () => {
    expect(tierForPixels(100, undefined, true)).toBe(0);
    expect(tierForPixels(47, undefined, true)).toBe(1);
    expect(tierForPixels(7, undefined, true)).toBe(2);
  });
  it('skips tier 1 without a coarse mesh', () => {
    expect(tierForPixels(20, undefined, false)).toBe(0);
    expect(tierForPixels(7, undefined, false)).toBe(2);
  });
  it('holds the coarser tier inside the 15 % band and releases it past it', () => {
    expect(tierForPixels(50, 1, true)).toBe(1);
    expect(tierForPixels(56, 1, true)).toBe(0);
    expect(tierForPixels(50, 0, true)).toBe(0);
    expect(tierForPixels(9, 2, true)).toBe(2);
    expect(tierForPixels(10, 2, true)).toBe(1);
  });
});

describe('assignTiers', () => {
  it('is deterministic and farther instances get coarser tiers', () => {
    const boxes = packBoxes([cubeAt(5, 1), cubeAt(40, 1), cubeAt(400, 1)]);
    const first = assignTiers(boxes, CAMERA, undefined, true);
    expect(Array.from(first)).toEqual([0, 1, 2]);
    expect(Array.from(assignTiers(boxes, CAMERA, undefined, true))).toEqual(Array.from(first));
  });
  it('uses the hysteresis from the previous assignment', () => {
    // unit cube at distance d: 1.732 * 1000 / (2 d tan 30deg) = 1500 / d px (48 px at d 31.25, hold limit 55 px at d 27.2)
    const boxes = packBoxes([cubeAt(30, 1)]);
    expect(assignTiers(boxes, CAMERA, undefined, true)[0]).toBe(0);
    const farther = packBoxes([cubeAt(32, 1)]);
    expect(assignTiers(farther, CAMERA, undefined, true)[0]).toBe(1);
    expect(assignTiers(boxes, CAMERA, Uint8Array.of(1), true)[0]).toBe(1);
  });
  it('works in an orthographic view', () => {
    const ortho: PlanCamera = { ...CAMERA, projection: 'orthographic', viewHeight: 100 };
    const boxes = packBoxes([cubeAt(5, 0.3), cubeAt(5, 10)]);
    expect(Array.from(assignTiers(boxes, ortho, undefined, true))).toEqual([2, 0]);
  });
});

describe('packTiers', () => {
  it('partitions the indices and maps slots back', () => {
    const tiers = Uint8Array.of(0, 2, 1, 0, 2);
    const { members, slot } = packTiers(tiers);
    expect(members).toEqual([[0, 3], [2], [1, 4]]);
    tiers.forEach((tier, index) => expect(members[tier]?.[slot[index] ?? -1]).toBe(index));
  });
});
