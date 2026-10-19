/** The shared tracked-child runner: tree kill on timeout, resolution on 'exit' while a grandchild holds the pipes, normal completion. */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { runTrackedProcess, type ProcessRunnerHooks } from '../src/processRunner';

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4242;
  kill = (): boolean => true;
}

function hooks(
  child: FakeChild,
  killed: ChildProcess[] = [],
  platform: NodeJS.Platform = 'linux',
): ProcessRunnerHooks & { options: unknown[] } {
  const options: unknown[] = [];
  return {
    options,
    platform,
    spawnProcess: (_exe, _args, opts) => {
      options.push(opts);
      return child as unknown as ReturnType<ProcessRunnerHooks['spawnProcess']>;
    },
    killTree: (c) => void killed.push(c),
  };
}

describe('runTrackedProcess', () => {
  it('returns the exit code and the log tail on a normal exit', async () => {
    const child = new FakeChild();
    const run = runTrackedProcess('x', [], '.', 5000, {}, hooks(child));
    child.stdout.write('hello ');
    child.stderr.write('world');
    child.emit('close', 0);
    expect(await run).toEqual({ exitCode: 0, log: 'hello world', timedOut: false });
  });

  it('kills the whole tree on timeout and resolves on exit although the pipes stay open', async () => {
    const child = new FakeChild();
    const killed: ChildProcess[] = [];
    const run = runTrackedProcess('x', [], '.', 20, {}, hooks(child, killed));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(killed).toHaveLength(1);
    child.emit('exit', null); // no 'close': a grandchild still holds stdout / stderr
    expect(await run).toMatchObject({ exitCode: null, timedOut: true });
  });

  it('reports a start error', async () => {
    const child = new FakeChild();
    const run = runTrackedProcess('x', [], '.', 5000, {}, hooks(child));
    child.emit('error', new Error('spawn ENOENT'));
    expect(await run).toMatchObject({ exitCode: null, timedOut: false, startError: 'spawn ENOENT' });
  });

  it('spawns detached (own process group) except on Windows', async () => {
    for (const [platform, detached] of [
      ['linux', true],
      ['win32', false],
    ] as const) {
      const child = new FakeChild();
      const h = hooks(child, [], platform);
      const run = runTrackedProcess('x', [], '.', 5000, {}, h);
      child.emit('close', 0);
      await run;
      expect(h.options[0]).toMatchObject({ detached });
    }
  });
});
