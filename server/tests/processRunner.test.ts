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

  it('kills the tree when the signal aborts, and says it was cancelled, not timed out', async () => {
    const child = new FakeChild();
    const killed: ChildProcess[] = [];
    const controller = new AbortController();
    const run = runProcess({ executable: 'x', args: [], env: {}, timeoutMs: 60_000, signal: controller.signal }, hooks(child, killed));
    controller.abort();
    expect(killed).toHaveLength(1);
    child.emit('exit', null);
    expect(await run).toMatchObject({ exitCode: null, timedOut: false, cancelled: true });
  });

  it('a console-style kill of the child (Ctrl-C exit code) after the abort is a cancellation, not a crash', async () => {
    const child = new FakeChild();
    const controller = new AbortController();
    const run = runProcess({ executable: 'x', args: [], env: {}, timeoutMs: 60_000, signal: controller.signal }, hooks(child, []));
    controller.abort();
    child.emit('exit', 0xc000013a);
    expect(await run).toMatchObject({ exitCode: 0xc000013a, timedOut: false, cancelled: true });
  });

  it('ownProcessGroup starts the child detached on Windows too (no console: a Ctrl-C reaches only the parent); the default keeps the console there', async () => {
    const own = new FakeChild();
    const ownHooks = hooks(own, [], 'win32');
    const withGroup = runProcess({ executable: 'x', args: [], env: {}, timeoutMs: 60_000, ownProcessGroup: true }, ownHooks);
    own.emit('close', 0);
    await withGroup;
    expect(ownHooks.options).toMatchObject([{ detached: true }]);
    const plain = new FakeChild();
    const plainHooks = hooks(plain, [], 'win32');
    const without = runProcess({ executable: 'x', args: [], env: {}, timeoutMs: 60_000 }, plainHooks);
    plain.emit('close', 0);
    await without;
    expect(plainHooks.options).toMatchObject([{ detached: false }]);
  });

  it('holdStdin gives the child a stdin pipe nobody writes to or closes while it runs; without it stdin is null', async () => {
    const held = new FakeChild();
    const heldHooks = hooks(held);
    const run = runProcess({ executable: 'x', args: [], env: {}, timeoutMs: 60_000, holdStdin: true }, heldHooks);
    held.emit('close', 0);
    await run;
    expect(heldHooks.options).toMatchObject([{ pipeInput: true }]);
    const plain = new FakeChild();
    const plainHooks = hooks(plain);
    const other = runProcess({ executable: 'x', args: [], env: {}, timeoutMs: 60_000 }, plainHooks);
    plain.emit('close', 0);
    await other;
    expect(plainHooks.options).toMatchObject([{ pipeInput: false }]);
  });

  it('holdStdin and input cannot be combined: input closes the pipe holdStdin keeps open', () => {
    const spec = { executable: 'x', args: [], env: {}, timeoutMs: 1000, holdStdin: true, input: 'abc' };
    expect(() => runProcess(spec, hooks(new FakeChild()))).toThrow(/holdStdin and input/);
    expect(() => runProcessSync(spec)).toThrow(/holdStdin and input/);
  });

  it('a signal that is already aborted never lets the child run on', async () => {
    const child = new FakeChild();
    const killed: ChildProcess[] = [];
    const run = runProcess({ executable: 'x', args: [], env: {}, timeoutMs: 60_000, signal: AbortSignal.abort() }, hooks(child, killed));
    expect(killed).toHaveLength(1);
    child.emit('exit', null);
    expect((await run).cancelled).toBe(true);
  });

  it('a child that ends on its own is not cancelled by a later abort', async () => {
    const child = new FakeChild();
    const killed: ChildProcess[] = [];
    const controller = new AbortController();
    const run = runProcess({ executable: 'x', args: [], env: {}, timeoutMs: 60_000, signal: controller.signal }, hooks(child, killed));
    child.emit('close', 0);
    const outcome = await run;
    controller.abort();
    expect(killed).toHaveLength(0);
    expect(outcome).toMatchObject({ exitCode: 0, cancelled: false });
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
    const slow = new AbortController();
    const cancelled = runProcess({
      executable: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000)'],
      env: process.env,
      timeoutMs: 20_000,
      signal: slow.signal,
    });
    setTimeout(() => slow.abort(), 300);
    expect(await cancelled).toMatchObject({ cancelled: true, timedOut: false });
    expect((await runProcess({ executable: 'llull-no-such-tool', args: [], env: process.env, timeoutMs: 5000 })).startErrorCode).toBe(
      'ENOENT',
    );
  }, 30_000);
});
