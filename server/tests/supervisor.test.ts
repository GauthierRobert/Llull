/** The supervisor of a local `--timeout` run: past the deadline plus the grace it ends the child's whole process tree (so its `llull-compute` too), exit code 1. */

import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { DEADLINE_ENV, deadlineFromEnv, withDeadline } from '../src/cli/deadline';
import { CHILD_ENV, supervise, supervisedTimeout } from '../src/cli/supervisor';

const exitCodeBefore = process.exitCode;
afterEach(() => {
  process.exitCode = exitCodeBefore;
});

describe('supervise', () => {
  it('kills the child with the tree kill after seconds + grace, says so, and exits 1', async () => {
    const child = new EventEmitter() as unknown as ChildProcess;
    const killed: ChildProcess[] = [];
    const said: string[] = [];
    supervise(0.05, {
      spawnChild: () => child,
      killTree: (target) => void killed.push(target),
      env: { LLULL_CLI_KILL_GRACE_SECONDS: '0.05' },
      stderr: (text) => void said.push(text),
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(killed).toEqual([child]);
    child.emit('exit', null);
    expect(process.exitCode).toBe(1);
    expect(said.join('')).toContain('timed out after 0.05s (--timeout)');
  });

  it('hands the child one absolute deadline, counted from the supervisor own start', () => {
    const child = new EventEmitter() as unknown as ChildProcess;
    const seen: NodeJS.ProcessEnv[] = [];
    const before = Date.now();
    supervise(30, { spawnChild: (env) => (seen.push(env), child), killTree: () => undefined, env: {}, stderr: () => undefined });
    const deadline = Number(seen[0]?.[DEADLINE_ENV]);
    expect(deadline).toBeGreaterThanOrEqual(before + 30_000);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 30_000);
    expect(seen[0]?.[CHILD_ENV]).toBe('1');
    child.emit('exit', 0);
  });

  it('a child that ends in time is left alone and its exit code is the CLI exit code', async () => {
    const child = new EventEmitter() as unknown as ChildProcess;
    const killed: ChildProcess[] = [];
    supervise(5, { spawnChild: () => child, killTree: (target) => void killed.push(target), env: {}, stderr: () => undefined });
    child.emit('exit', 2);
    expect(process.exitCode).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(killed).toEqual([]);
  });
});

describe('supervisedTimeout', () => {
  it('asks for supervision of a local run with --timeout, not of a server run or of the supervised child', () => {
    expect(supervisedTimeout(['exec', 'add_box', '--timeout', '30'], {})).toBe(30);
    expect(supervisedTimeout(['exec', 'add_box', '--timeout', '30', '--server', 'http://x'], {})).toBeUndefined();
    expect(supervisedTimeout(['exec', 'add_box', '--timeout', '30'], { [CHILD_ENV]: '1' })).toBeUndefined();
    expect(supervisedTimeout(['exec', 'add_box'], {})).toBeUndefined();
  });
});

describe('withDeadline', () => {
  it('aborts at the absolute deadline the supervisor gave, not at start + seconds', async () => {
    const signal = withDeadline(undefined, 60, Date.now() + 80) as AbortSignal;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toMatchObject({ code: 'MESH_TIMEOUT' });
  });

  it('counts the seconds from now without an absolute deadline, and passes the parent through without --timeout', async () => {
    expect(withDeadline(undefined, undefined)).toBeUndefined();
    const signal = withDeadline(undefined, 60) as AbortSignal;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(signal.aborted).toBe(false);
  });

  it('reads the deadline from the environment, ignoring garbage', () => {
    expect(deadlineFromEnv({ [DEADLINE_ENV]: '1234567890123' })).toBe(1234567890123);
    expect(deadlineFromEnv({ [DEADLINE_ENV]: 'soon' })).toBeUndefined();
    expect(deadlineFromEnv({})).toBeUndefined();
  });
});
