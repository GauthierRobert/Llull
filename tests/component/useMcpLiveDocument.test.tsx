/**
 * useMcpLiveDocument degrades quietly when the server is down: reconnects with
 * exponential backoff instead of the native fixed-interval retry.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from '@testing-library/react';
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
  addEventListener(): void {}
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
});
