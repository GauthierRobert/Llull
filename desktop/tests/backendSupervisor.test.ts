/** The backend supervisor (A-10): restart after a crash, bounded by attempts within a window, never after stop(). Injected starts, no process. */
import { describe, expect, it } from 'vitest';
import type { RunningBackend } from '../src/backend';
import { superviseBackend, type BackendState } from '../src/backendSupervisor';

interface FakeBackend extends RunningBackend {
  readonly env: Record<string, string>;
  crash(code?: number): void;
  readonly stopped: () => boolean;
}

interface Harness {
  readonly base: Parameters<typeof superviseBackend>[0];
  readonly started: FakeBackend[];
  readonly states: BackendState[];
  advance(ms: number): void;
}

function harness(options: { failStartsAfterFirst?: number } = {}): Harness {
  const started: FakeBackend[] = [];
  const states: BackendState[] = [];
  let clock = 0;
  let starts = 0;
  const start = (_fork: unknown, _entry: string, env: Record<string, string>): Promise<RunningBackend> => {
    starts += 1;
    if (options.failStartsAfterFirst !== undefined && starts > 1 && starts <= 1 + options.failStartsAfterFirst)
      return Promise.reject(new Error('port busy'));
    const listeners: ((code: number | null) => void)[] = [];
    let stopped = false;
    const backend: FakeBackend = {
      url: 'http://127.0.0.1:1',
      pid: 1000 + starts,
      env,
      onUnexpectedExit: (listener) => void listeners.push(listener),
      stop: () => {
        stopped = true;
        return Promise.resolve();
      },
      crash: (code = 1) => {
        for (const listener of listeners) listener(code);
      },
      stopped: () => stopped,
    };
    started.push(backend);
    return Promise.resolve(backend);
  };
  const base = {
    fork: () => {
      throw new Error('unused');
    },
    entry: 'server.js',
    env: { PORT: '1' },
    url: 'http://127.0.0.1:1',
    start: start as never,
    backoffMs: () => 0,
    now: () => clock,
    onState: (state: BackendState) => void states.push(state),
  };
  return { base, started, states, advance: (ms: number) => void (clock += ms) };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 40));

describe('backend supervisor', () => {
  it('restarts a crashed backend with LLULL_RECOVERY_RESUME so its document comes back, then reports running', async () => {
    const { base, started, states } = harness();
    const supervised = await superviseBackend(base);
    expect(started[0]?.env['LLULL_RECOVERY_RESUME']).toBeUndefined(); // a fresh launch never auto-loads old work
    started[0]?.crash(1);
    await settle();
    expect(started).toHaveLength(2);
    expect(started[1]?.env).toMatchObject({ PORT: '1', LLULL_RECOVERY_RESUME: '1' });
    expect(states.map((state) => state.state)).toEqual(['restarting', 'running']);
    expect(supervised.pid).toBe(started[1]?.pid); // the pid is the current process's
    started[1]?.crash(1); // a second crash is supervised too
    await settle();
    expect(started).toHaveLength(3);
  });

  it('gives up with a visible failed state after 3 restarts inside the window', async () => {
    const { base, started, states } = harness();
    await superviseBackend(base);
    for (let crash = 0; crash < 3; crash += 1) {
      started.at(-1)?.crash();
      await settle();
    }
    expect(started).toHaveLength(4); // the first start + 3 restarts
    started.at(-1)?.crash(); // the 4th crash inside the window
    await settle();
    expect(started).toHaveLength(4);
    expect(states.at(-1)).toMatchObject({ state: 'failed' });
    expect((states.at(-1) as { reason: string }).reason).toContain('3 restarts in 60 s');
  });

  it('the bound is attempts within a window, not a lifetime count: crashes far apart are restarted every time', async () => {
    const { base, started, states, advance } = harness();
    await superviseBackend(base);
    for (let crash = 0; crash < 8; crash += 1) {
      advance(61_000);
      started.at(-1)?.crash();
      await settle();
    }
    expect(started).toHaveLength(9);
    expect(states.some((state) => state.state === 'failed')).toBe(false);
  });

  it('failed restart attempts count against the bound too (a port that stays busy ends in failed)', async () => {
    const { base, started, states } = harness({ failStartsAfterFirst: 99 });
    await superviseBackend(base);
    started[0]?.crash();
    await settle();
    await settle();
    expect(states.map((state) => state.state)).toEqual(['restarting', 'restarting', 'restarting', 'failed']);
    expect((states.at(-1) as { reason: string }).reason).toContain('port busy');
  });

  it('stop() ends the current process, restarts nothing, and cancels a restart that is waiting', async () => {
    const { base, started } = harness();
    const supervised = await superviseBackend({ ...base, backoffMs: () => 60_000 });
    started[0]?.crash();
    await settle(); // now waiting out the backoff
    await supervised.stop();
    await settle();
    expect(started).toHaveLength(1);
    expect(started[0]?.stopped()).toBe(true);
  });

  it('stop() waits for a restart that is starting and stops the process it started (no orphan, no restart after stop)', async () => {
    const { base, started } = harness();
    const first = await superviseBackend(base); // only used to get a running backend through the harness
    await first.stop();
    started.length = 0;
    const listeners: ((code: number | null) => void)[] = [];
    const stops: string[] = [];
    let finishStart: (backend: RunningBackend) => void = () => undefined;
    let startCount = 0;
    const slowStart = (): Promise<RunningBackend> => {
      startCount += 1;
      const name = `child${startCount}`;
      const backend: RunningBackend = {
        url: 'http://127.0.0.1:1',
        pid: 2000 + startCount,
        onUnexpectedExit: (listener) => void listeners.push(listener),
        stop: () => {
          stops.push(name);
          return Promise.resolve();
        },
      };
      if (startCount === 1) return Promise.resolve(backend);
      return new Promise((resolve) => {
        finishStart = () => resolve(backend);
      });
    };
    const supervised = await superviseBackend({ ...base, start: slowStart as never });
    listeners[0]?.(1); // the first child crashes: the restart begins and its start is pending
    await settle();
    expect(startCount).toBe(2);
    let stopped = false;
    const stopping = supervised.stop().then(() => void (stopped = true));
    await settle();
    expect(stopped).toBe(false); // stop() is still waiting for the start in flight
    finishStart({} as RunningBackend);
    await stopping;
    expect(stops).toContain('child2'); // the child that was starting is stopped too
    expect(stops).toContain('child1');
  });

  it('a stop() is not a crash: no restart', async () => {
    const { base, started, states } = harness();
    const supervised = await superviseBackend(base);
    await supervised.stop();
    await settle();
    expect(started).toHaveLength(1);
    expect(states).toEqual([]);
  });
});
