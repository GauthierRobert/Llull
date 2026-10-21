/** The shared tracked-child runner: tree kill on timeout, resolution on 'exit' while a grandchild holds the pipes, normal completion. */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { runProcess, runProcessSync, runTrackedProcess, type ProcessRunnerHooks } from '../src/processRunner';

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

/** True when `pid` is still a live process. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const GRANDCHILD_PARENT =
  "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});" +
  'console.log(c.pid);setInterval(()=>{},1000)';

describe('tree kill with real processes', () => {
  it('runProcess: a timeout kills the grandchild too', async () => {
    const run = await runProcess({ executable: process.execPath, args: ['-e', GRANDCHILD_PARENT], env: process.env, timeoutMs: 1500 });
    expect(run.timedOut).toBe(true);
    const grandchild = Number(run.stdout.trim().split('\n')[0]);
    expect(grandchild).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(alive(grandchild)).toBe(false);
  }, 20_000);

  it('runProcessSync: a timeout kills the grandchild too, and stdin / stdout bytes round-trip', () => {
    const run = runProcessSync({ executable: process.execPath, args: ['-e', GRANDCHILD_PARENT], env: process.env, timeoutMs: 1500 });
    expect(run.timedOut).toBe(true);
    const grandchild = Number(run.stdout.trim().split('\n')[0]);
    expect(grandchild).toBeGreaterThan(0);
    expect(alive(grandchild)).toBe(false);
    const echo = runProcessSync({
      executable: process.execPath,
      args: ['-e', 'process.stdin.pipe(process.stdout)'],
      env: process.env,
      timeoutMs: 10_000,
      input: 'héllo',
    });
    expect(echo).toMatchObject({ exitCode: 0, timedOut: false, aborted: false, stdout: 'héllo' });
    const missing = runProcessSync({ executable: 'llull-no-such-tool', args: [], env: process.env, timeoutMs: 5000 });
    expect(missing.startErrorCode).toBe('ENOENT');
    const capped = runProcessSync({
      executable: process.execPath,
      args: ['-e', "process.stdout.write('x'.repeat(5000));setInterval(()=>{},1000)"],
      env: process.env,
      timeoutMs: 10_000,
      maxBuffer: 1000,
    });
    expect(capped.aborted).toBe(true);
  }, 40_000);

  it('runProcess: stdin input, onStdout abort and start errors', async () => {
    const chunks: string[] = [];
    const echo = await runProcess({
      executable: process.execPath,
      args: ['-e', 'process.stdin.pipe(process.stdout)'],
      env: process.env,
      timeoutMs: 10_000,
      input: 'abc',
      onStdout: (chunk) => void chunks.push(chunk.toString()),
    });
    expect(echo.exitCode).toBe(0);
    expect(chunks.join('')).toBe('abc');
    const aborted = await runProcess({
      executable: process.execPath,
      args: ['-e', "process.stdout.write('x');setInterval(()=>{},1000)"],
      env: process.env,
      timeoutMs: 10_000,
      onStdout: () => false,
    });
    expect(aborted.aborted).toBe(true);
    expect((await runProcess({ executable: 'llull-no-such-tool', args: [], env: process.env, timeoutMs: 5000 })).startErrorCode).toBe(
      'ENOENT',
    );
  }, 30_000);
});
