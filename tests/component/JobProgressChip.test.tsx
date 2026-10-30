/** The progress chip of native jobs over /live (TECHNICAL_SPEC 13.25): status-bar rendering, Cancel on the existing request-abort path, the /live hook wiring. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { LiveProgressEvent } from '@protocol/liveSync';
import { StatusBar } from '@ui/components/StatusBar';
import { useLiveDocument } from '@ui/hooks/useLiveDocument';
import { useStore } from '@ui/store';
import { cancelCommand, registerCommandCancel } from '@ui/store/commandCancel';
import { useJobProgressStore } from '@ui/store/jobProgressStore';

const running = (extra: Partial<Extract<LiveProgressEvent, { state: 'running' }>> = {}): LiveProgressEvent => ({
  epoch: 'e1',
  command: 'quad_remesh',
  commandId: 'c1',
  state: 'running',
  op: 'quad_remesh',
  stage: 'field',
  message: 'solving the orientation field',
  fraction: 0.4,
  elapsedMs: 4000,
  etaMs: 6000,
  heartbeat: false,
  ...extra,
});

describe('the progress chip', () => {
  it('shows the job, the share done and the time left, and goes away on ended', () => {
    render(<StatusBar />);
    expect(screen.queryByRole('status', { name: /native job/i })).toBeNull();
    act(() => useJobProgressStore.getState().apply(running()));
    const chip = screen.getByRole('status', { name: /native job/i });
    expect(chip.textContent).toContain('quad_remesh: solving the orientation field 40% · 6 s left');
    expect((screen.getByLabelText('quad_remesh progress') as HTMLProgressElement).value).toBe(0.4);
    act(() => useJobProgressStore.getState().apply(running({ fraction: 0.8, etaMs: 2000 })));
    expect(screen.getAllByRole('status', { name: /native job/i })).toHaveLength(1);
    expect(screen.getByRole('status', { name: /native job/i }).textContent).toContain('80% · 2 s left');
    act(() => useJobProgressStore.getState().apply({ epoch: 'e1', command: 'quad_remesh', commandId: 'c1', state: 'ended' }));
    expect(screen.queryByRole('status', { name: /native job/i })).toBeNull();
  });

  it('a job without a share yet shows no bar; a job of another sender has no Cancel', () => {
    render(<StatusBar />);
    act(() => useJobProgressStore.getState().apply(running({ fraction: null, etaMs: null })));
    expect(screen.queryByLabelText('quad_remesh progress')).toBeNull();
    expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull();
  });

  it("Cancel on this client's own command aborts its request (the one cancel path) and only then", () => {
    const abort = vi.fn();
    const forget = registerCommandCancel('c1', abort);
    render(<StatusBar />);
    act(() => useJobProgressStore.getState().apply(running()));
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(abort).toHaveBeenCalledTimes(1);
    forget();
    expect(cancelCommand('c1')).toBe(false);
  });
});

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, (e: Event) => void>();
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (e: Event) => void): void {
    this.listeners.set(type, listener);
  }
  close(): void {}
  emit(type: string, data: unknown): void {
    this.listeners.get(type)?.({ data: typeof data === 'string' ? data : JSON.stringify(data) } as MessageEvent<string>);
  }
}

function Harness(): null {
  useLiveDocument();
  return null;
}

describe('/live wiring', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('a progress event fills the store; the command event of the same command id clears it; malformed data and unknown event types change nothing', () => {
    render(<Harness />);
    const source = FakeEventSource.instances[0] as FakeEventSource;
    source.emit('progress', running());
    expect(useJobProgressStore.getState().jobs.map((job) => job.key)).toEqual(['c1']);
    source.emit('progress', 'not json');
    source.emit('future-event', { anything: true });
    expect(useJobProgressStore.getState().jobs).toHaveLength(1);
    expect(source.listeners.has('future-event')).toBe(false);
    source.emit('command', { epoch: 'e1', seq: 1, name: 'quad_remesh', params: {}, stateHash: 'x', commandId: 'c1' });
    expect(useJobProgressStore.getState().jobs).toHaveLength(0);
  });

  it('a dropped connection clears the chips (the job state is unknown until the stream is back)', () => {
    vi.useFakeTimers();
    try {
      render(<Harness />);
      const source = FakeEventSource.instances[0] as FakeEventSource;
      source.emit('progress', running());
      source.onerror?.();
      expect(useJobProgressStore.getState().jobs).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a cancelled dispatch', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('aborts its POST /command, says so in the status line and does not fall back to a local run', async () => {
    useStore.setState({ liveStatus: 'connected' });
    let sent: { commandId: string } | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        sent = JSON.parse(init.body as string) as { commandId: string };
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        });
      }),
    );
    useStore.getState().dispatch('add_box', { size: [1, 1, 1] });
    await act(async () => {
      await Promise.resolve();
    });
    expect(sent).not.toBeNull();
    act(() => void cancelCommand((sent as unknown as { commandId: string }).commandId));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(useStore.getState().lastSummary).toBe("Command 'add_box' cancelled.");
    expect(Object.keys(useStore.getState().document.entities)).toHaveLength(0);
  });
});
