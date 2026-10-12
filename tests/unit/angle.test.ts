import { describe, expect, it } from 'vitest';
import { positiveSweep, wrapAngle, wrapSignedAngle } from '@lib/angle';

const TURN = 2 * Math.PI;

describe('wrapAngle', () => {
  it('wraps into [0, 2π)', () => {
    expect(wrapAngle(0)).toBe(0);
    expect(wrapAngle(TURN)).toBe(0);
    expect(wrapAngle(-Math.PI / 2)).toBeCloseTo((3 * Math.PI) / 2);
    expect(wrapAngle(5 * Math.PI)).toBeCloseTo(Math.PI);
  });
});

describe('wrapSignedAngle', () => {
  it('wraps to the nearest turn, [−π, π)', () => {
    expect(wrapSignedAngle(0.5)).toBe(0.5);
    expect(wrapSignedAngle((3 * Math.PI) / 2)).toBeCloseTo(-Math.PI / 2);
    expect(wrapSignedAngle(Math.PI)).toBeCloseTo(-Math.PI);
    expect(wrapSignedAngle(-TURN - 0.25)).toBeCloseTo(-0.25);
  });
});

describe('positiveSweep', () => {
  it('lifts a non-positive sweep into (0, 2π]; zero is a full turn', () => {
    expect(positiveSweep(0)).toBe(TURN);
    expect(positiveSweep(-TURN)).toBe(TURN);
    expect(positiveSweep(-Math.PI / 2)).toBeCloseTo((3 * Math.PI) / 2);
    expect(positiveSweep(-3 * Math.PI)).toBeCloseTo(Math.PI);
  });

  it('keeps a positive sweep, even beyond a full turn', () => {
    expect(positiveSweep(1)).toBe(1);
    expect(positiveSweep(3 * Math.PI)).toBe(3 * Math.PI);
  });
});
