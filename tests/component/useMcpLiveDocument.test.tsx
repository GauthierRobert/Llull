/**
 * useMcpLiveDocument degrades quietly when the server is down: reconnects with
 * exponential backoff instead of the native fixed-interval retry.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { useStore } from '@ui/store';
import { useMcpLiveDocument } from '@ui/hooks/useMcpLiveDocument';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: MessageEvent<string>) => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  listeners = new Map<string, (e: Event) => void>();
  addEventListener(type: string, listener: (e: Event) => void): void {
    this.listeners.set(type, listener);
  }
  close(): void {
    this.closed = true;
  }
}

function Harness(): null {
  useMcpLiveDocument();
  return null;
}

describe('useMcpLiveDocument', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reconnects with exponential backoff and marks disconnected', () => {
    render(<Harness />);
    expect(FakeEventSource.instances).toHaveLength(1);
    FakeEventSource.instances[0]?.onerror?.();
    expect(useStore.getState().liveStatus).toBe('disconnected');
    expect(FakeEventSource.instances[0]?.closed).toBe(true);

    vi.advanceTimersByTime(999);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(2);

    FakeEventSource.instances[1]?.onerror?.();
    vi.advanceTimersByTime(1999);
    expect(FakeEventSource.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(3);
  });

  it('stops retrying after unmount', () => {
    const { unmount } = render(<Harness />);
    FakeEventSource.instances[0]?.onerror?.();
    unmount();
    vi.advanceTimersByTime(60000);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('coalesces resyncs: one snapshot fetch in flight, one follow-up for failures meanwhile', async () => {
    vi.useRealTimers();
    const resolvers: (() => void)[] = [];
    const snapshot = {
      epoch: 'e',
      seq: 1,
      stateHash: 'h',
      document: useStore.getState().document,
    };
    const fetchSpy = vi.fn(
      () =>
        new Promise((resolve) => {
          resolvers.push(() => resolve({ ok: true, json: () => Promise.resolve(snapshot) }));
        }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    render(<Harness />);
    const listener = FakeEventSource.instances[0]?.listeners.get('command');
    const gapEvent = {
      data: JSON.stringify({ epoch: 'e', seq: 9, name: 'x', params: {}, stateHash: 'h' }),
    };
    act(() => {
      listener?.(gapEvent as MessageEvent);
      listener?.(gapEvent as MessageEvent);
      listener?.(gapEvent as MessageEvent);
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolvers[0]?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
