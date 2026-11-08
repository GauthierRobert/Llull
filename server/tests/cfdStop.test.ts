/**
 * 12 CFD M3a host lifecycle of cfd_solve / cfd_stop (fake runner that holds until released or killed): cfd_stop kills the run (its signal
 * aborts = process-tree kill in the real runner) and commits nothing, even when the run finished in the same tick; identical concurrent
 * solves share one run and each caller keeps its own signal; the run dies with its last waiter; CFD_NOT_RUNNING; tool wiring.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _stopAllCfdSolves, runCfdSolve, runCfdStop } from '../src/cfd/flowSolve';
import { createFeArtifactStore, type FeArtifactCache } from '../src/fea/artifactStore';
import { isNativeTool, runNativeTool } from '../src/native/tools';
import { fakeRunner, hostOf, sphereModel } from './cfdTestSupport';

let dir = '';
let store: FeArtifactCache;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'llull-cfd-stop-'));
  store = createFeArtifactStore(dir);
});
afterEach(() => {
  // a failing test must not leave a running solve behind for the next one (the registry is per process)
  _stopAllCfdSolves();
  rmSync(dir, { recursive: true, force: true });
});

/** Index of the runner call whose case.json asked for `maxSteps` (runs start in any order). */
const callWith = (runner: ReturnType<typeof fakeRunner>, maxSteps: number): number =>
  runner.calls.findIndex(
    (call) =>
      (JSON.parse(call.files['case.json']?.toString('utf8') ?? '{}') as { settings?: { maxSteps?: number } }).settings?.maxSteps ===
      maxSteps,
  );

describe('cfd_stop', () => {
  it('kills the running solve, answers its caller CFD_CANCELLED and records nothing', async () => {
    const model = sphereModel();
    const host = hostOf(model, store);
    const runner = fakeRunner({ hold: true });
    const solving = runCfdSolve('re100', {}, host, { store, runner });
    await vi.waitFor(() => expect(runner.calls).toHaveLength(1));
    const stopped = runCfdStop('re100');
    expect(stopped.isError).toBe(false);
    expect(stopped.summary).toContain('stopped 1 running solve(s) of re100');
    const solved = await solving;
    expect(solved).toMatchObject({ isError: true, data: { code: 'CFD_CANCELLED' } });
    expect(solved.summary).toContain('stopped by cfd_stop');
    expect(runner.signals[0]?.aborted).toBe(true);
    expect(host.current()).toBe(model.doc);
    expect(runCfdStop('re100').data).toMatchObject({ code: 'CFD_NOT_RUNNING' });
  });

  it('commits nothing when the stop lands as the run finishes', async () => {
    const model = sphereModel();
    const host = hostOf(model, store);
    const runner = fakeRunner({ hold: true });
    const solving = runCfdSolve('re100', {}, host, { store, runner });
    await vi.waitFor(() => expect(runner.calls).toHaveLength(1));
    runner.release();
    runCfdStop('re100');
    expect(await solving).toMatchObject({ isError: true, data: { code: 'CFD_CANCELLED' } });
    expect(host.current().cfd?.results['re100']).toBeUndefined();
  });

  it('refuses with CFD_NOT_RUNNING and names the cases that do run', async () => {
    const host = hostOf(sphereModel(), store);
    expect(runCfdStop('re100')).toMatchObject({ isError: true, data: { code: 'CFD_NOT_RUNNING', running: [] } });
    const runner = fakeRunner({ hold: true });
    const solving = runCfdSolve('re100', {}, host, { store, runner });
    await vi.waitFor(() => expect(runner.calls).toHaveLength(1));
    const other = runCfdStop('wing');
    expect(other.summary).toContain('(running: re100)');
    runner.release();
    expect((await solving).isError).toBe(false);
  });
});

describe('concurrent cfd_solve callers', () => {
  it('share one run; a caller that cancels stops waiting alone and the other records the result', async () => {
    const model = sphereModel();
    const host = hostOf(model, store);
    const runner = fakeRunner({ hold: true });
    const first = new AbortController();
    const a = runCfdSolve('re100', { signal: first.signal }, host, { store, runner });
    const b = runCfdSolve('re100', {}, host, { store, runner });
    await vi.waitFor(() => expect(runner.calls).toHaveLength(1));
    first.abort();
    const cancelled = await a;
    expect(cancelled).toMatchObject({ isError: true, data: { code: 'CFD_CANCELLED' } });
    expect(cancelled.summary).toContain('this caller stopped waiting');
    expect(runner.signals[0]?.aborted).toBe(false);
    runner.release();
    const solved = await b;
    expect(solved.isError, solved.summary).toBe(false);
    expect(runner.calls).toHaveLength(1);
    expect(host.current().cfd?.results['re100']?.verified).toBe(true);
  });

  it('records a shared run once: the second caller finds it recorded', async () => {
    const model = sphereModel();
    const host = hostOf(model, store);
    const runner = fakeRunner({ hold: true });
    const a = runCfdSolve('re100', {}, host, { store, runner });
    const b = runCfdSolve('re100', {}, host, { store, runner });
    await vi.waitFor(() => expect(runner.calls).toHaveLength(1));
    runner.release();
    const [first, second] = await Promise.all([a, b]);
    expect([first.isError, second.isError]).toEqual([false, false]);
    expect(second.summary).toContain('already recorded (a concurrent caller of the same run)');
    expect(runner.calls).toHaveLength(1);
  });

  it('kills the run when its last caller cancels, and runs different settings separately', async () => {
    const model = sphereModel();
    const host = hostOf(model, store);
    const runner = fakeRunner({ hold: true });
    const [x, y] = [new AbortController(), new AbortController()];
    const a = runCfdSolve('re100', { signal: x.signal, maxSteps: 55 }, host, { store, runner });
    const b = runCfdSolve('re100', { signal: y.signal, maxSteps: 55 }, host, { store, runner });
    await vi.waitFor(() => expect(runner.calls).toHaveLength(1));
    const c = runCfdSolve('re100', { maxSteps: 77 }, host, { store, runner });
    await vi.waitFor(() => expect(runner.calls).toHaveLength(2));
    const [shared, separate] = [callWith(runner, 55), callWith(runner, 77)];
    expect([shared, separate].sort()).toEqual([0, 1]);
    x.abort();
    expect(runner.signals[shared]?.aborted).toBe(false);
    y.abort();
    expect(runner.signals[shared]?.aborted).toBe(true);
    expect((await a).data).toMatchObject({ code: 'CFD_CANCELLED' });
    expect((await b).data).toMatchObject({ code: 'CFD_CANCELLED' });
    expect(runner.signals[separate]?.aborted).toBe(false);
    expect(runCfdStop('re100').summary).toContain('stopped 1 running solve(s)');
    expect((await c).data).toMatchObject({ code: 'CFD_CANCELLED' });
    expect(host.current()).toBe(model.doc);
  });

  it('starts fresh after a stop and refuses an already-aborted caller without running', async () => {
    const host = hostOf(sphereModel(), store);
    const gone = new AbortController();
    gone.abort();
    const runner = fakeRunner();
    expect(await runCfdSolve('re100', { signal: gone.signal }, host, { store, runner })).toMatchObject({ data: { code: 'CFD_CANCELLED' } });
    expect(runner.calls).toHaveLength(0);
    expect((await runCfdSolve('re100', {}, host, { store, runner })).isError).toBe(false);
  });
});

describe('a run that fails in the host', () => {
  it('answers CFD_SOLVER_FAILED with the reason, not CFD_CANCELLED, when the field cannot be stored', async () => {
    const model = sphereModel();
    const host = hostOf(model, store);
    mkdirSync(store.directory, { recursive: true });
    writeFileSync(path.join(store.directory, 'cfd-files'), 'a file where the store directory should be');
    const solved = await runCfdSolve('re100', {}, host, { store, runner: fakeRunner() });
    expect(solved).toMatchObject({ isError: true, data: { code: 'CFD_SOLVER_FAILED' } });
    expect(host.current()).toBe(model.doc);
  });

  it('answers CFD_SOLVER_FAILED with the reason when the run itself rejects (the version probe)', async () => {
    const model = sphereModel();
    const host = hostOf(model, store);
    const solved = await runCfdSolve('re100', {}, host, { store, runner: fakeRunner({ versionFails: true }) });
    expect(solved).toMatchObject({ isError: true, data: { code: 'CFD_SOLVER_FAILED' } });
    expect(solved.summary).toContain('version probe: EPERM');
    expect(host.current()).toBe(model.doc);
  });

  it('answers CFD_SOLVER_FAILED when the bundle cannot be stored', async () => {
    const model = sphereModel();
    const host = hostOf(model, store);
    const broken = {
      ...store,
      put: (): string => {
        throw new Error('ENOSPC: no space left on device');
      },
    };
    const solved = await runCfdSolve('re100', {}, host, { store: broken, runner: fakeRunner() });
    expect(solved).toMatchObject({ isError: true, data: { code: 'CFD_SOLVER_FAILED' } });
    expect(solved.summary).toContain('ENOSPC');
    expect(host.current()).toBe(model.doc);
  });
});

describe('cfd_stop tool wiring', () => {
  it('is a native tool that needs a caseId and passes the host signal to cfd_solve', async () => {
    expect(isNativeTool('cfd_stop')).toBe(true);
    const host = hostOf(sphereModel(), store);
    expect(await runNativeTool('cfd_stop', {}, host, { store, runner: fakeRunner() })).toMatchObject({ isError: true, changed: false });
    const runner = fakeRunner({ hold: true });
    const cancel = new AbortController();
    const solving = runNativeTool('cfd_solve', { caseId: 're100' }, { ...host, signal: cancel.signal }, { store, runner });
    await vi.waitFor(() => expect(runner.calls).toHaveLength(1));
    cancel.abort();
    expect(await solving).toMatchObject({ isError: true, changed: false, data: { code: 'CFD_CANCELLED' } });
    expect(runner.signals[0]?.aborted).toBe(true);
    expect(await runNativeTool('cfd_stop', { caseId: 're100' }, host, { store, runner })).toMatchObject({
      isError: true,
      data: { code: 'CFD_NOT_RUNNING' },
    });
  });
});
