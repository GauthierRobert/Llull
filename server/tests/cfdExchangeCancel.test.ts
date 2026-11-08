/**
 * 12 CFD M3a: `POST /exchange cfd_solve` (the CLI's `--app` path) ties the run to the request. A client that goes away (its socket destroyed,
 * as on Ctrl-C) aborts its own wait: the held fake run's signal aborts (the real runner kills the process tree) and the live document is
 * unchanged; a request that completes never aborts its run.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ComputeRunner } from '../src/native/computeJob';
import { fakeRunner, sphereModel } from './cfdTestSupport';

const shared = vi.hoisted(() => ({ runner: null as ComputeRunner | null }));

vi.mock('../src/native/computeJob', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/native/computeJob')>();
  return {
    ...actual,
    createComputeRunner: (...args: Parameters<typeof actual.createComputeRunner>) => shared.runner ?? actual.createComputeRunner(...args),
  };
});

let cache = '';
let server: http.Server;
let port = 0;
let live: typeof import('../src/liveDocument');
let stopAll: () => number;

beforeAll(async () => {
  cache = mkdtempSync(path.join(tmpdir(), 'llull-cfd-exchange-'));
  vi.stubEnv('LLULL_FEA_CACHE', cache);
  const { app } = await import('../src/index');
  live = await import('../src/liveDocument');
  stopAll = (await import('../src/cfd/flowSolve'))._stopAllCfdSolves;
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  port = (server.address() as AddressInfo).port;
}, 120_000);

afterEach(() => {
  stopAll();
  shared.runner = null;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
  rmSync(cache, { recursive: true, force: true });
});

/** Starts `POST /exchange cfd_solve`; resolves with the response body, or 'closed' when the request is destroyed first. */
function postSolve(): { readonly request: http.ClientRequest; readonly done: Promise<unknown> } {
  const body = JSON.stringify({ name: 'cfd_solve', params: { caseId: 're100' }, client: 'cli' });
  let request: http.ClientRequest | null = null;
  const done = new Promise<unknown>((resolve) => {
    request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/exchange',
        method: 'POST',
        headers: { 'content-type': 'application/json', host: `localhost:${port}` },
      },
      (response) => {
        let text = '';
        response.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
        response.on('end', () => resolve(JSON.parse(text) as unknown));
      },
    );
    request.on('error', () => resolve('closed'));
    request.end(body);
  });
  return { request: request as unknown as http.ClientRequest, done };
}

describe('POST /exchange cfd_solve and the request lifetime', () => {
  it('aborts the run when the client goes away and leaves the live document unchanged', async () => {
    live.setLiveDoc(sphereModel().doc);
    const before = live.getLiveDoc();
    const runner = fakeRunner({ hold: true });
    shared.runner = runner;
    const { request, done } = postSolve();
    await vi.waitFor(() => expect(runner.calls).toHaveLength(1), { timeout: 30_000 });
    expect(runner.signals[0]?.aborted).toBe(false);
    request.destroy();
    expect(await done).toBe('closed');
    await vi.waitFor(() => expect(runner.signals[0]?.aborted).toBe(true));
    expect(live.getLiveDoc()).toBe(before);
    expect(live.getLiveDoc().cfd?.results['re100']).toBeUndefined();
  });

  it('never aborts a run whose request completes', async () => {
    live.setLiveDoc(sphereModel().doc);
    const runner = fakeRunner();
    shared.runner = runner;
    const answer = (await postSolve().done) as { isError: boolean; summary: string };
    expect(answer).toMatchObject({ isError: false });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runner.signals[0]?.aborted).toBe(false);
    expect(live.getLiveDoc().cfd?.results['re100']?.verified).toBe(true);
  });
});
