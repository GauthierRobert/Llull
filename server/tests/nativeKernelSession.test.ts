/** The NDJSON session with the native sidecar, against an in-memory fake process: id matching, noise, death. */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKernelSession, type KernelChild } from '../src/native/kernelSession';

interface FakeChild extends KernelChild {
  readonly written: string[];
  emitLine(line: string): void;
  exit(reason: string): void;
  killed: boolean;
}

function fakeChild(options: { failWrites?: boolean } = {}): FakeChild {
  const lineListeners: ((line: string) => void)[] = [];
  const exitListeners: ((reason: string) => void)[] = [];
  const child: FakeChild = {
    written: [],
    killed: false,
    write: (text) => {
      if (options.failWrites === true) throw new Error('EPIPE');
      child.written.push(text);
    },
    onLine: (listener) => void lineListeners.push(listener),
    onExit: (listener) => void exitListeners.push(listener),
    kill: () => void (child.killed = true),
    emitLine: (line) => lineListeners.forEach((listener) => listener(line)),
    exit: (reason) => exitListeners.forEach((listener) => listener(reason)),
  };
  return child;
}

afterEach(() => vi.restoreAllMocks());

describe('native kernel session', () => {
  it('matches replies to requests by id, in any order', async () => {
    const child = fakeChild();
    const session = createKernelSession(child);
    const first = session.request('evaluate', [{ key: 'a' }]);
    const second = session.request('tessellate', [{ key: 'a' }]);
    expect(child.written.map((line) => JSON.parse(line) as { id: number; op: string })).toMatchObject([
      { id: 1, op: 'evaluate' },
      { id: 2, op: 'tessellate' },
    ]);
    child.emitLine('{"id":2,"result":null,"error":"shape not cached: a"}');
    child.emitLine('{"id":1,"result":{"key":"a"}}');
    expect(await first).toEqual({ result: { key: 'a' } });
    expect(await second).toEqual({ result: null, error: 'shape not cached: a' });
  });

  it('ignores stray output with one warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const child = fakeChild();
    const session = createKernelSession(child);
    const pending = session.request('info', []);
    child.emitLine('Info: STEP translator statistics');
    child.emitLine('{"id":99,"result":1}');
    child.emitLine('{"id":1,"result":"ok"}');
    expect(await pending).toEqual({ result: 'ok' });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('answers NATIVE_DIED for pending and later requests once the process exits', async () => {
    const child = fakeChild();
    const session = createKernelSession(child);
    const pending = session.request('evaluate', []);
    child.exit('killed by SIGSEGV');
    expect(await pending).toEqual({ result: null, error: 'NATIVE_DIED: killed by SIGSEGV' });
    expect(session.alive()).toBe(false);
    expect(await session.request('info', [])).toEqual({ result: null, error: 'NATIVE_DIED: killed by SIGSEGV' });
    session.close();
    expect(child.killed).toBe(true);
  });

  it('answers NATIVE_DIED when the request cannot be written', async () => {
    const session = createKernelSession(fakeChild({ failWrites: true }));
    expect(await session.request('info', [])).toEqual({ result: null, error: 'NATIVE_DIED: EPIPE' });
  });
});
