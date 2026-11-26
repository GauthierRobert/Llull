/** The CLI's requests to a llull server: one connection per request, and a network failure that names its cause. */

import { describe, expect, it } from 'vitest';
import { createRemoteBackend } from '../src/cli/backend';
import { requestCommandStream, requestJson } from '../src/restClient';

type Init = { readonly headers?: Record<string, string> };

function recorder(): {
  readonly headers: Array<Record<string, string>>;
  readonly fetchImpl: (url: string, init?: Init) => Promise<Response>;
} {
  const headers: Array<Record<string, string>> = [];
  return {
    headers,
    fetchImpl: (_url, init) => {
      headers.push({ ...init?.headers });
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
    },
  };
}

describe('restClient', () => {
  it('closes the connection of every request (a paused caller must not reuse a socket the server closed)', async () => {
    const seen = recorder();
    await requestJson('http://h/health', { fetchImpl: seen.fetchImpl as never });
    await requestJson('http://h/undo', { body: {}, token: 't', fetchImpl: seen.fetchImpl as never });
    await requestCommandStream('http://h/command', {
      body: { name: 'add_box' },
      token: 't',
      idleTimeoutMs: 1000,
      fetchImpl: seen.fetchImpl as never,
    });
    expect(seen.headers).toHaveLength(3);
    for (const sent of seen.headers) expect(sent['Connection']).toBe('close');
  });
});

describe('remote backend, server unreachable', () => {
  const failing = (cause: unknown) => (): Promise<Response> => Promise.reject(new TypeError('fetch failed', { cause }));

  it('names the network cause behind "fetch failed"', async () => {
    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    const backend = createRemoteBackend('http://cad.local:3001', { token: undefined, fetchImpl: failing(reset) as never });
    const outcome = await backend.undo();
    expect(outcome.isError).toBe(true);
    expect(outcome.summary).toMatch(
      /Cannot reach the llull server at http:\/\/cad\.local:3001: fetch failed \(ECONNRESET: read ECONNRESET\)/,
    );
  });

  it('keeps the plain message when the failure has no cause', async () => {
    const backend = createRemoteBackend('http://cad.local:3001', { token: undefined, fetchImpl: failing(undefined) as never });
    expect((await backend.undo()).summary).toMatch(/: fetch failed \(start it with/);
  });
});
