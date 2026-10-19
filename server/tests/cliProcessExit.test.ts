/**
 * The real `llull` process exits cleanly after a remote call (`--server`, the `--app` transport). Regression: the CLI ended
 * with `process.exit` right after `fetch`, which on Windows (Node 24) aborted most runs with
 * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` (src\win\async.c) and a crash exit code.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';

const launcher = path.resolve(__dirname, '..', 'bin', 'llull.cjs');
const RUNS = 10;

let server: Server;
let url = '';

beforeAll(async () => {
  server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.setHeader('Content-Type', 'application/json');
      // As many headers as the real backend sends (security, rate limit, etag): parsing them is what makes fetch's llhttp
      // wasm hot enough for V8 to tier it up on a background thread — the work the old `process.exit` raced.
      for (let header = 0; header < 12; header++) response.setHeader(`x-llull-test-${header}`, 'v'.repeat(40));
      response.end(JSON.stringify({ summary: 'Added box box-1.1.', affected: ['box-1.1'], isError: false, changed: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const runRemote = (): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    execFile(process.execPath, [launcher, 'add_box', 'size=[1,1,1]', '--server', url, '--token', 'test-token'], (error, stdout, stderr) =>
      resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1, stdout, stderr }),
    );
  });

describe('llull process exit after a remote call', () => {
  it(`exits 0 without a libuv assertion, ${RUNS} runs in a row`, async () => {
    for (let run = 0; run < RUNS; run++) {
      const result = await runRemote();
      expect(result.stderr).not.toMatch(/Assertion failed/);
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/Added box/);
    }
  }, 180_000);
});
