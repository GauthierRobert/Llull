import { describe, expect, it } from 'vitest';
import {
  BOOST_FACTOR,
  MAX_PITCH,
  NO_INPUT,
  anglesOfDirection,
  applyMouseLook,
  clampPitch,
  inputFromKeys,
  lookDirection,
  navigationSpeed,
  stepNavigation,
} from '@ui/viewport/3d/navigation/navigationMath';

const walk = { mode: 'walk', speed: 2, eyeZ: 1.6 } as const;
const fly = { mode: 'fly', speed: 2, eyeZ: 1.6 } as const;

describe('mouse look', () => {
  it('turns right and looks up with the pointer, and clamps the pitch short of the poles', () => {
    const turned = applyMouseLook({ yaw: 0, pitch: 0 }, 100, -50, 0.01);
    expect(turned.yaw).toBeCloseTo(1);
    expect(turned.pitch).toBeCloseTo(0.5);
    expect(applyMouseLook({ yaw: 0, pitch: 0 }, 0, -1e6).pitch).toBe(MAX_PITCH);
    expect(clampPitch(-10)).toBe(-MAX_PITCH);
  });
  it('wraps the yaw', () => {
    const { yaw } = applyMouseLook({ yaw: 3, pitch: 0 }, 100, 0, 0.01);
    expect(yaw).toBeLessThanOrEqual(Math.PI);
    expect(yaw).toBeCloseTo(4 - Math.PI * 2);
  });
  it('round-trips direction and angles', () => {
    const angles = { yaw: 0.7, pitch: -0.3 };
    const back = anglesOfDirection(lookDirection(angles));
    expect(back.yaw).toBeCloseTo(angles.yaw);
    expect(back.pitch).toBeCloseTo(angles.pitch);
    expect(anglesOfDirection([0, 0, 0])).toEqual({ yaw: 0, pitch: 0 });
    expect(lookDirection({ yaw: 0, pitch: 0 })).toEqual([0, 1, 0]);
  });
});

describe('speed scaling', () => {
  it('scales with the model diagonal, floors it, and falls back when there is no model', () => {
    expect(navigationSpeed(120, 1)).toBeCloseTo(10);
    expect(navigationSpeed(12000, 1)).toBeCloseTo(1000);
    expect(navigationSpeed(0.001, 1)).toBe(0.05);
    expect(navigationSpeed(null, 1.5)).toBe(1.5);
    expect(navigationSpeed(Number.NaN, 1.5)).toBe(1.5);
  });
});

describe('keys', () => {
  it('maps held keys to intent; opposing keys cancel', () => {
    expect(inputFromKeys(new Set(['KeyW', 'KeyD', 'ShiftLeft']))).toEqual({ forward: 1, strafe: 1, rise: 0, boost: true });
    expect(inputFromKeys(new Set(['KeyW', 'KeyS', 'KeyQ']))).toEqual({ forward: 0, strafe: 0, rise: -1, boost: false });
    expect(inputFromKeys(new Set())).toEqual(NO_INPUT);
  });
});

describe('step', () => {
  it('walks level at the eye height whatever the pitch', () => {
    const next = stepNavigation([0, 0, 9], { yaw: 0, pitch: 0.8 }, { ...NO_INPUT, forward: 1 }, 0.5, walk);
    expect(next[0]).toBeCloseTo(0);
    expect(next[1]).toBeCloseTo(1);
    expect(next[2]).toBe(1.6);
  });
  it('strafes to the right of the view', () => {
    const next = stepNavigation([0, 0, 0], { yaw: 0, pitch: 0 }, { ...NO_INPUT, strafe: 1 }, 1, fly);
    expect(next[0]).toBeCloseTo(2);
    expect(next[1]).toBeCloseTo(0);
  });
  it('flies along the view and rises along world Z', () => {
    const up = stepNavigation([0, 0, 0], { yaw: 0, pitch: Math.PI / 4 }, { ...NO_INPUT, forward: 1 }, 1, fly);
    expect(up[1]).toBeCloseTo(Math.SQRT2);
    expect(up[2]).toBeCloseTo(Math.SQRT2);
    expect(stepNavigation([0, 0, 0], { yaw: 0, pitch: 0 }, { ...NO_INPUT, rise: 1 }, 1, fly)[2]).toBeCloseTo(2);
    expect(stepNavigation([0, 0, 5], { yaw: 0, pitch: 0 }, { ...NO_INPUT, rise: 1 }, 1, walk)[2]).toBe(1.6);
  });
  it('does not speed up on diagonals, boosts with shift, and ignores a negative dt', () => {
    const diagonal = stepNavigation([0, 0, 0], { yaw: 0, pitch: 0 }, { ...NO_INPUT, forward: 1, strafe: 1 }, 1, fly);
    expect(Math.hypot(diagonal[0], diagonal[1])).toBeCloseTo(2);
    const boosted = stepNavigation([0, 0, 0], { yaw: 0, pitch: 0 }, { ...NO_INPUT, forward: 1, boost: true }, 1, fly);
    expect(boosted[1]).toBeCloseTo(2 * BOOST_FACTOR);
    expect(stepNavigation([1, 2, 3], { yaw: 0, pitch: 0 }, { ...NO_INPUT, forward: 1 }, -1, fly)).toEqual([1, 2, 3]);
  });
});
