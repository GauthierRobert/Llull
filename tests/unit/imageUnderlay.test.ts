import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@core/model/types';
import { type UnderlayPlacement, calibrateUnderlay, pixelToLocal, pixelToWorld, underlayCorners } from '@core/geometry/imageUnderlay';

/** 200×100 px image at 1 unit/px, lower-left at [10, 20, 0]. */
const BASE: UnderlayPlacement = {
  position: [10, 20, 0],
  rotation: [0, 0, 0],
  width: 200,
  height: 100,
  pixelWidth: 200,
  pixelHeight: 100,
};

const expectClose = (actual: readonly number[], expected: readonly number[]): void => {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((value, i) => expect(value).toBeCloseTo(expected[i] ?? NaN, 9));
};

const distance = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('pixel → local → world', () => {
  it('flips pixel y (top-left origin, +y down) into the work plane (+y up)', () => {
    expectClose(pixelToLocal(BASE, [0, 0]), [0, 100]);
    expectClose(pixelToLocal(BASE, [200, 100]), [200, 0]);
    expectClose(pixelToLocal({ ...BASE, width: 400 }, [50, 25]), [100, 75]);
  });

  it('offsets by position and applies the in-plane rotation about the lower-left corner', () => {
    expectClose(pixelToWorld(BASE, [0, 100]), [10, 20, 0]);
    const turned = { ...BASE, rotation: [0, 0, Math.PI / 2] as Vec3 };
    // local [200, 0] (bottom-right) rotated +90° → [0, 200]
    expectClose(pixelToWorld(turned, [200, 100]), [10, 220, 0]);
  });

  it('lifts a plane rotated about X into Z', () => {
    const vertical = { ...BASE, rotation: [Math.PI / 2, 0, 0] as Vec3 };
    expectClose(pixelToWorld(vertical, [0, 0]), [10, 20, 100]);
  });

  it('lists the corners in pixel order', () => {
    const corners = underlayCorners(BASE);
    expectClose(corners.flat(), [10, 120, 0, 210, 120, 0, 210, 20, 0, 10, 20, 0]);
  });
});

describe('calibrateUnderlay', () => {
  it('scales uniformly so the pixel segment measures `distance`, keeping pixelA fixed', () => {
    const before = pixelToWorld(BASE, [20, 50]);
    const result = calibrateUnderlay(BASE, { pixelA: [20, 50], pixelB: [120, 50], distance: 150 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unitsPerPixel).toBeCloseTo(1.5);
    expect(result.pixelDistance).toBeCloseTo(100);
    expect(result.placement.width).toBeCloseTo(300);
    expect(result.placement.height).toBeCloseTo(150);
    expectClose(pixelToWorld(result.placement, [20, 50]), before);
    const a = pixelToWorld(result.placement, [20, 50]);
    const b = pixelToWorld(result.placement, [120, 50]);
    expect(distance(a, b)).toBeCloseTo(150);
  });

  it('pins an origin pixel to a world point', () => {
    const result = calibrateUnderlay(BASE, {
      pixelA: [0, 0],
      pixelB: [0, 40],
      distance: 20,
      origin: { pixel: [100, 50], world: [0, 0, 0] },
    });
    if (!result.ok) throw new Error(result.error);
    expectClose(pixelToWorld(result.placement, [100, 50]), [0, 0, 0]);
    expectClose(pixelToWorld(result.placement, [140, 50]), [20, 0, 0]);
  });

  it('de-skews a crooked scan: A→B ends up along +x by the smallest turn', () => {
    const skew = (5 * Math.PI) / 180;
    // In pixels (+y down) a segment rising 5° to the right has dy < 0.
    const pixelB: [number, number] = [100 * Math.cos(skew), 50 - 100 * Math.sin(skew)];
    const result = calibrateUnderlay(BASE, {
      pixelA: [0, 50],
      pixelB,
      distance: 10,
      align: 'x',
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.placement.rotation[2]).toBeCloseTo(-skew);
    const a = pixelToWorld(result.placement, [0, 50]);
    const b = pixelToWorld(result.placement, pixelB);
    expect(b[1] - a[1]).toBeCloseTo(0, 9);
    expect(b[0] - a[0]).toBeCloseTo(10, 9);
  });

  it('aligns with y, and treats a reversed segment as the same axis (no half turn)', () => {
    const toY = calibrateUnderlay(BASE, {
      pixelA: [0, 0],
      pixelB: [10, 0],
      distance: 10,
      align: 'y',
    });
    if (!toY.ok) throw new Error(toY.error);
    expect(toY.placement.rotation[2]).toBeCloseTo(Math.PI / 2);
    const reversed = calibrateUnderlay(BASE, {
      pixelA: [10, 0],
      pixelB: [0, 0],
      distance: 10,
      align: 'x',
    });
    if (!reversed.ok) throw new Error(reversed.error);
    expect(reversed.placement.rotation[2]).toBe(0);
  });

  it('keeps rx/ry and the in-plane angle when align is not given', () => {
    const tilted = { ...BASE, rotation: [0.3, 0.2, 0.1] as Vec3 };
    const result = calibrateUnderlay(tilted, { pixelA: [0, 0], pixelB: [3, 4], distance: 10 });
    if (!result.ok) throw new Error(result.error);
    expect(result.placement.rotation).toEqual([0.3, 0.2, 0.1]);
    expect(distance(pixelToWorld(result.placement, [0, 0]), pixelToWorld(result.placement, [3, 4]))).toBeCloseTo(10);
  });

  it.each([
    [{ pixelA: [0, 0], pixelB: [0, 0], distance: 10 }, 'two different pixels'],
    [{ pixelA: [0, 0], pixelB: [1, 0], distance: 0 }, 'distance must be'],
    [{ pixelA: [0, 0], pixelB: [1, 0], distance: Number.NaN }, 'distance must be'],
  ] as const)('fails on %j', (calibration, message) => {
    const result = calibrateUnderlay(BASE, calibration);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(message);
  });
});
