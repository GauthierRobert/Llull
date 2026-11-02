import { describe, it, expect } from 'vitest';
import {
  DPR_SETTLE_MS,
  INITIAL_ADAPTIVE_DPR,
  INITIAL_CONTACT_BAKE,
  cameraPoseChanged,
  contactBakeOwed,
  interactiveDpr,
  settledDpr,
  shouldRefreshShadows,
  stepAdaptiveDpr,
  stepContactBake,
} from '../../src/ui/viewport/3d/renderActivity';
import {
  consumeShadowsDirty,
  getContactBakeTick,
  markShadowsDirty,
  requestContactBake,
  subscribeContactBake,
} from '../../src/ui/viewport/3d/renderRigState';
import { endFrame, markSceneMoved, sceneMovedThisFrame } from '../../src/ui/viewport/3d/frameActivity';

describe('shouldRefreshShadows', () => {
  it('skips the shadow pass on a pure camera frame', () => {
    expect(shouldRefreshShadows({ dirty: false, sceneMoved: false })).toBe(false);
  });
  it('refreshes on an edit or on a moved scene', () => {
    expect(shouldRefreshShadows({ dirty: true, sceneMoved: false })).toBe(true);
    expect(shouldRefreshShadows({ dirty: false, sceneMoved: true })).toBe(true);
  });
  it('counts shadow renders over a 60-frame orbit with one edit: 1 instead of 60', () => {
    let renders = 0;
    for (let frame = 0; frame < 60; frame += 1) {
      if (shouldRefreshShadows({ dirty: frame === 0, sceneMoved: false })) renders += 1;
    }
    expect(renders).toBe(1);
  });
});

describe('stepContactBake', () => {
  it('bakes at most 15 Hz while moving, then once more on settle', () => {
    let state = INITIAL_CONTACT_BAKE;
    let bakes = 0;
    for (let ms = 0; ms < 1000; ms += 16) {
      const step = stepContactBake(state, true, ms);
      state = step.state;
      if (step.bake) bakes += 1;
    }
    expect(bakes).toBeGreaterThanOrEqual(13);
    expect(bakes).toBeLessThanOrEqual(15);
    expect(contactBakeOwed(state) || bakes > 0).toBe(true);
    const settle = stepContactBake(state, false, 1016);
    expect(settle.bake).toBe(contactBakeOwed(state));
    expect(contactBakeOwed(settle.state)).toBe(false);
  });
  it('never bakes while nothing moves', () => {
    expect(stepContactBake(INITIAL_CONTACT_BAKE, false, 0).bake).toBe(false);
  });
  it('a throttled movement is owed a trailing bake', () => {
    const first = stepContactBake(INITIAL_CONTACT_BAKE, true, 0);
    const skipped = stepContactBake(first.state, true, 10);
    expect(skipped.bake).toBe(false);
    expect(contactBakeOwed(skipped.state)).toBe(true);
    expect(stepContactBake(skipped.state, false, 20).bake).toBe(true);
  });
});

describe('adaptive resolution', () => {
  it('reduces a 2x display, keeps 1x untouched', () => {
    expect(interactiveDpr(2)).toBeCloseTo(1.2);
    expect(interactiveDpr(1.5)).toBe(1);
    expect(interactiveDpr(1)).toBe(1);
  });
  it('settled ratio clamps the device ratio into the Canvas range', () => {
    expect(settledDpr(3, [1, 2])).toBe(2);
    expect(settledDpr(0.5, [1, 2])).toBe(1);
    expect(settledDpr(1.5, [1, 2])).toBe(1.5);
  });
  it('drops on activity and restores after the settle delay', () => {
    const down = stepAdaptiveDpr(INITIAL_ADAPTIVE_DPR, true, 100, true);
    expect(down).toMatchObject({ changed: true, state: { reduced: true } });
    const still = stepAdaptiveDpr(down.state, false, 100 + DPR_SETTLE_MS - 1, true);
    expect(still.changed).toBe(false);
    const up = stepAdaptiveDpr(still.state, false, 100 + DPR_SETTLE_MS, true);
    expect(up).toMatchObject({ changed: true, state: { reduced: false } });
  });
  it('continued activity keeps the reduced ratio without a new change', () => {
    const down = stepAdaptiveDpr(INITIAL_ADAPTIVE_DPR, true, 0, true);
    const again = stepAdaptiveDpr(down.state, true, 500, true);
    expect(again.changed).toBe(false);
    expect(again.state.reduced).toBe(true);
  });
  it('does nothing when the display cannot be reduced (1x)', () => {
    expect(stepAdaptiveDpr(INITIAL_ADAPTIVE_DPR, true, 0, false).changed).toBe(false);
  });
});

describe('cameraPoseChanged', () => {
  it('detects movement and remembers the pose', () => {
    const previous = new Float64Array(7).fill(Number.NaN);
    expect(cameraPoseChanged(previous, [1, 2, 3, 0, 0, 0, 1])).toBe(true);
    expect(cameraPoseChanged(previous, [1, 2, 3, 0, 0, 0, 1])).toBe(false);
    expect(cameraPoseChanged(previous, [1, 2, 4, 0, 0, 0, 1])).toBe(true);
  });
});

describe('render rig state', () => {
  it('dirty flag is consumed once', () => {
    markShadowsDirty();
    expect(consumeShadowsDirty()).toBe(true);
    expect(consumeShadowsDirty()).toBe(false);
  });
  it('contact bake requests notify subscribers and bump the tick', () => {
    let calls = 0;
    const off = subscribeContactBake(() => (calls += 1));
    const before = getContactBakeTick();
    requestContactBake();
    off();
    requestContactBake();
    expect(calls).toBe(1);
    expect(getContactBakeTick()).toBe(before + 2);
  });
  it('frame activity: moved lasts until endFrame', () => {
    endFrame();
    expect(sceneMovedThisFrame()).toBe(false);
    markSceneMoved();
    expect(sceneMovedThisFrame()).toBe(true);
    endFrame();
    expect(sceneMovedThisFrame()).toBe(false);
  });
});
