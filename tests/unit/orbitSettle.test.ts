import { describe, expect, it } from 'vitest';
import { SETTLE_STEP_PIXELS, shouldSettleCoast, viewStepPixels } from '@ui/viewport/3d/orbitSettle';

const FOV = 45;
const HEIGHT = 900;
const radiansPerPixel = (FOV * Math.PI) / 180 / HEIGHT;

describe('viewStepPixels', () => {
  it('converts a world step to screen pixels at the given distance', () => {
    expect(viewStepPixels(10 * radiansPerPixel * 6, 6, FOV, HEIGHT)).toBeCloseTo(10, 9);
  });
  it('is scale-invariant: the same angular step reads the same at 1 and 1e6 units away', () => {
    expect(viewStepPixels(1e-3, 1, FOV, HEIGHT)).toBeCloseTo(viewStepPixels(1e3, 1e6, FOV, HEIGHT), 9);
  });
  it.each([
    ['zero distance', 0, HEIGHT],
    ['zero-height viewport', 6, 0],
  ])('returns 0 for a %s', (_label, distance, height) => {
    expect(viewStepPixels(1, distance, FOV, height)).toBe(0);
  });
});

describe('shouldSettleCoast', () => {
  const stepFor = (pixels: number, distance: number): number => pixels * radiansPerPixel * distance;
  it.each([1, 1e3, 1e6])('settles a sub-pixel coast at distance %d', (distance) => {
    expect(shouldSettleCoast(stepFor(SETTLE_STEP_PIXELS / 2, distance), distance, FOV, HEIGHT)).toBe(true);
  });
  it('keeps a visible coast running', () => {
    expect(shouldSettleCoast(stepFor(2, 1e6), 1e6, FOV, HEIGHT)).toBe(false);
  });
  it('ignores a view that did not move (already idle)', () => {
    expect(shouldSettleCoast(0, 6, FOV, HEIGHT)).toBe(false);
  });
});
