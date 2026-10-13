/** Production hardening: shared limiters, proxy trust, headers, probes, child cleanup, per-client caps, MCP eviction. */
import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'node:child_process';
import { app } from '../src/index';
import { BusyError, concurrencyLimiter, createPythonExchangePort } from '../src/pythonExchange';
import { killAllChildren, liveChildCount, trackChild } from '../src/childProcesses';
import { contentSecurityPolicy, trustProxySetting } from '../src/security';
import { evictForCapacity, sessions } from '../src/mcp/sessions';
import { liveSubscriberCount } from '../src/liveDocument';
import { mcpRequest, INITIALIZE_PARAMS } from './mcpTestSupport';
import { convertDwgLimited } from '../src/dwgConvert';

const ENV_KEYS = [
  'MCP_AUTH_TOKEN',
  'HOST',
  'LLULL_ALLOWED_HOSTS',
  'LLULL_LIVE_MAX_PER_CLIENT',
  'MCP_MAX_SESSIONS',
  'LLULL_PYTHON_QUEUE_MAX',
];
afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  sessions.clear();
});

describe('shared DWG limiter', () => {
  it('exposes one limited converter (the unlimited one is module-private)', async () => {
    await expect(convertDwgLimited(Buffer.from('not a dwg'))).rejects.toMatchObject({ status: 400 });
  });
});

describe('trustProxySetting', () => {
  it('parses env values', () => {
    expect(trustProxySetting(undefined)).toBeUndefined();
    expect(trustProxySetting('')).toBeUndefined();
    expect(trustProxySetting('true')).toBe(true);
    expect(trustProxySetting('2')).toBe(2);
    expect(trustProxySetting('loopback')).toBe('loopback');
    expect(trustProxySetting('10.0.0.0/8, loopback')).toBe('10.0.0.0/8, loopback');
  });

  it('does not let X-Forwarded-For fake a loopback peer for admin endpoints', async () => {
    const res = await request(app).get('/admin/users').set('X-Forwarded-For', '203.0.113.9');
    expect(res.status).not.toBe(200);
  });
});

describe('MCP session eviction', () => {
  it('a session-less non-initialize POST is refused and evicts nothing', async () => {
    process.env['MCP_MAX_SESSIONS'] = '1';
    const close = vi.fn().mockResolvedValue(undefined);
    sessions.set('victim', { transport: { close } as never, lastSeenMs: 1 });
    const res = await mcpRequest(app).send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(res.status).toBe(400);
    expect(sessions.has('victim')).toBe(true);
    expect(close).not.toHaveBeenCalled();
    const init = await mcpRequest(app).send({ jsonrpc: '2.0', id: 2, method: 'initialize', params: INITIALIZE_PARAMS });
    expect(init.status).toBe(200);
    expect(sessions.has('victim')).toBe(false);
  });

  it('evicts the same user first when ownership is known', () => {
    process.env['MCP_MAX_SESSIONS'] = '2';
    const mk = (userId: string | undefined, lastSeenMs: number): never =>
      ({ transport: { close: () => Promise.resolve() }, lastSeenMs, ...(userId ? { userId } : {}) }) as never;
    sessions.set('other-old', mk('bob', 1));
    sessions.set('mine', mk('alice', 5));
    evictForCapacity('alice');
    expect([...sessions.keys()]).toEqual(['other-old']);
  });
});

describe('python queue cap', () => {
  it('rejects with BusyError past the queue cap', async () => {
    const limit = concurrencyLimiter(1, 1);
    let release: () => void = () => undefined;
    const running = limit(() => new Promise<void>((resolve) => (release = resolve)));
    const queued = limit(() => Promise.resolve('queued'));
    await expect(limit(() => Promise.resolve('x'))).rejects.toBeInstanceOf(BusyError);
    release();
    await running;
    await expect(queued).resolves.toBe('queued');
  });

  it('createPythonExchangePort honours LLULL_PYTHON_QUEUE_MAX (busy -> BusyError)', async () => {
    process.env['LLULL_PYTHON_QUEUE_MAX'] = '1';
    const script = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'llull-busy-')), 'slow.py');
    fs.writeFileSync(script, 'import time,sys\ntime.sleep(1.5)\nprint("{\\"ok\\": true, \\"bodies\\": []}")\n');
    const port = createPythonExchangePort({
      python: 'python3',
      build123dPython: 'python3',
      timeoutMs: 10_000,
      bridgeScript: script,
      exchangeDir: null,
    });
    const calls = [1, 2, 3, 4].map(() =>
      port.importStep('AA==').then(
        () => 'ok',
        (error: unknown) => error,
      ),
    );
    const results = await Promise.all(calls);
    expect(results.filter((r) => r instanceof BusyError).length).toBeGreaterThanOrEqual(1);
    killAllChildren();
  }, 20_000);
});

describe('CSRF on token-less reads', () => {
  it('refuses cross-site fetches and foreign origins, allows plain and allowlisted requests', async () => {
    expect((await request(app).get('/live/snapshot').set('Sec-Fetch-Site', 'cross-site')).status).toBe(403);
    expect((await request(app).get('/live/snapshot').set('Origin', 'https://evil.example')).status).toBe(403);
    expect((await request(app).get('/live/snapshot').set('Sec-Fetch-Site', 'same-origin')).status).toBe(200);
    expect(
      (await request(app).get('/live/snapshot').set('Origin', 'http://localhost:5173').set('Sec-Fetch-Site', 'cross-site')).status,
    ).toBe(200);
    expect((await request(app).get('/live/snapshot')).status).toBe(200);
  });
});

describe('security headers and probes', () => {
  it('sets baseline headers and hides x-powered-by', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
  });

  it('serves /health to a pod-IP Host while other routes keep the allowlist', async () => {
    process.env['LLULL_ALLOWED_HOSTS'] = 'llull.example';
    expect((await request(app).get('/health').set('Host', '10.1.2.3:3001')).status).toBe(200);
    expect((await request(app).get('/live/snapshot').set('Host', '10.1.2.3:3001')).status).toBe(403);
  });

  it('CSP covers wasm, blob workers/images and forbids framing', () => {
    const csp = contentSecurityPolicy();
    for (const part of [
      "script-src 'self' 'wasm-unsafe-eval'",
      "worker-src 'self' blob:",
      "img-src 'self' data: blob:",
      "frame-ancestors 'none'",
      "object-src 'none'",
    ]) {
      expect(csp).toContain(part);
    }
    expect(csp).toMatch(/connect-src 'self' http:\/\/localhost:5173/);
  });
});

describe('child process registry', () => {
  it('killAllChildren SIGKILLs tracked children', async () => {
    const child = trackChild(spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' }));
    expect(liveChildCount()).toBe(1);
    const closed = new Promise<string | null>((resolve) => child.once('close', (_code, signal) => resolve(signal)));
    expect(killAllChildren()).toBe(1);
    expect(await closed).toBe('SIGKILL');
    expect(liveChildCount()).toBe(0);
  });
});

describe('per-client live stream cap', () => {
  it('answers 429 past LLULL_LIVE_MAX_PER_CLIENT', async () => {
    process.env['LLULL_LIVE_MAX_PER_CLIENT'] = '1';
    const server = app.listen(0);
    const { port } = server.address() as { port: number };
    const before = liveSubscriberCount();
    const controller = new AbortController();
    try {
      const first = await fetch(`http://127.0.0.1:${port}/live`, { signal: controller.signal });
      expect(first.status).toBe(200);
      const second = await fetch(`http://127.0.0.1:${port}/live`);
      expect(second.status).toBe(429);
      expect(liveSubscriberCount()).toBe(before + 1);
    } finally {
      controller.abort();
      server.closeAllConnections();
      server.close();
    }
  });
});
