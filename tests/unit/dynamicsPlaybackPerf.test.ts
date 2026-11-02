import { beforeEach, describe, expect, it } from 'vitest';
import type { SimulationData } from '@dynamics/index';
import { getPlaybackTime, useDynamicsPlaybackStore } from '@ui/store/dynamicsPlaybackStore';
import { sampleAtInto } from '@ui/viewport/3d/dynamicsPose';

describe('dynamics playback clock (no store write per frame)', () => {
  const result = { duration: 100 } as SimulationData;
  beforeEach(() => {
    useDynamicsPlaybackStore.getState().setResult(null);
    useDynamicsPlaybackStore.setState({ speed: 1, loop: true });
    useDynamicsPlaybackStore.getState().setResult(result);
  });

  it('advances the live clock every frame but notifies subscribers at ~10 Hz', () => {
    let notifications = 0;
    const unsubscribe = useDynamicsPlaybackStore.subscribe(() => (notifications += 1));
    for (let frame = 0; frame < 60; frame += 1) useDynamicsPlaybackStore.getState().advance(1 / 60);
    unsubscribe();
    expect(getPlaybackTime()).toBeCloseTo(1, 9);
    expect(notifications).toBeLessThanOrEqual(10);
    expect(notifications).toBeGreaterThan(0);
  });

  it('publishes the exact time when paused, seeked or finished', () => {
    useDynamicsPlaybackStore.getState().advance(0.03);
    expect(useDynamicsPlaybackStore.getState().time).toBe(0);
    useDynamicsPlaybackStore.getState().setPlaying(false);
    expect(useDynamicsPlaybackStore.getState().cursorTime).toBeCloseTo(0.03, 12);
    useDynamicsPlaybackStore.getState().setTime(5);
    expect(getPlaybackTime()).toBe(5);
    useDynamicsPlaybackStore.setState({ playing: true, loop: false });
    useDynamicsPlaybackStore.getState().advance(500);
    expect(useDynamicsPlaybackStore.getState()).toMatchObject({ time: 100, playing: false });
  });

  it('follows a time written straight into the store while paused, and resumes from it', () => {
    const store = useDynamicsPlaybackStore;
    store.getState().advance(0.5);
    store.getState().setPlaying(false);
    store.setState({ time: 7, cursorTime: 7 });
    expect(getPlaybackTime()).toBe(7);
    store.getState().setPlaying(true);
    expect(store.getState().time).toBe(7);
    store.getState().advance(1);
    expect(getPlaybackTime()).toBeCloseTo(8, 12);
  });

  it('samples into a caller-owned object', () => {
    const out = { index: 0, blend: 0 };
    expect(sampleAtInto([0, 1, 2], 1.5, out)).toBe(out);
    expect(out).toEqual({ index: 1, blend: 0.5 });
  });
});
