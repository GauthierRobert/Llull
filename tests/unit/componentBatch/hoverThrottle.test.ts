import { describe, expect, it } from 'vitest';
import { createThrottle, type ThrottleClock } from '@ui/viewport/3d/componentBatch/hoverThrottle';

function fakeClock(): { clock: ThrottleClock; advance: (ms: number) => void } {
  let now = 1000;
  let next = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: ThrottleClock = {
    now: () => now,
    setTimeout: (callback, ms) => {
      const handle = next++;
      timers.set(handle, { at: now + ms, callback });
      return handle;
    },
    clearTimeout: (handle) => void timers.delete(handle),
  };
  const advance = (ms: number): void => {
    now += ms;
    for (const [handle, timer] of [...timers]) {
      if (timer.at <= now) {
        timers.delete(handle);
        timer.callback();
      }
    }
  };
  return { clock, advance };
}

describe('createThrottle', () => {
  it('applies the first value at once and collapses the burst to its last value', () => {
    const { clock, advance } = fakeClock();
    const seen: number[] = [];
    const throttle = createThrottle<number>((v) => void seen.push(v), 33, clock);
    throttle.push(1);
    throttle.push(2);
    throttle.push(3);
    expect(seen).toEqual([1]);
    advance(32);
    expect(seen).toEqual([1]);
    advance(1);
    expect(seen).toEqual([1, 3]);
  });

  it('applies again immediately once the window has passed', () => {
    const { clock, advance } = fakeClock();
    const seen: number[] = [];
    const throttle = createThrottle<number>((v) => void seen.push(v), 33, clock);
    throttle.push(1);
    advance(100);
    throttle.push(2);
    expect(seen).toEqual([1, 2]);
  });

  it('cancel drops the pending value', () => {
    const { clock, advance } = fakeClock();
    const seen: number[] = [];
    const throttle = createThrottle<number>((v) => void seen.push(v), 33, clock);
    throttle.push(1);
    throttle.push(2);
    throttle.cancel();
    advance(100);
    expect(seen).toEqual([1]);
  });
});
