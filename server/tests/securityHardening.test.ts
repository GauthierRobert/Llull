/**
 * @layer server/tests
 * Auth/guard hardening: remote-peer guard, bearer verifier, Host allowlist, bind safety,
 * autosave stop mode, /ui-bridge mutation guard.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Request, Response } from 'express';
import { app } from '../src/index';
import {
  guardMutation,
  hasValidBearer,
  isLoopbackAddress,
  checkBindSafety,
} from '../src/security';
import { createAutosaver } from '../src/autosave';
import { createEmptyDocument } from '@core/model/types';

const ENV_KEYS = [
  'MCP_AUTH_TOKEN',
  'HOST',
  'LLULL_ALLOWED_HOSTS',
  'LLULL_REQUIRE_TOKEN_FOR_REST',
];
afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

function fakeReq(headers: Record<string, string>, remoteAddress: string): Request {
  return { headers, socket: { remoteAddress } } as unknown as Request;
}

function runGuard(req: Request): { status: number | null; nextCalled: boolean } {
  let status: number | null = null;
  let nextCalled = false;
  const res = {
    status(code: number) {
      status = code;
      return { json: () => undefined };
    },
  } as unknown as Response;
  guardMutation()(req, res, () => {
    nextCalled = true;
  });
  return { status, nextCalled };
}

describe('isLoopbackAddress', () => {
  it('classifies addresses', () => {
    for (const a of ['127.0.0.1', '127.5.6.7', '::1', '::ffff:127.0.0.1', 'localhost'])
      expect(isLoopbackAddress(a)).toBe(true);
    for (const a of ['10.0.0.5', '::ffff:10.0.0.5', '0.0.0.0', undefined])
      expect(isLoopbackAddress(a)).toBe(false);
  });
});

describe('hasValidBearer', () => {
  it('accepts case-insensitive scheme, rejects wrong/length-differing/missing tokens', () => {
    expect(hasValidBearer(fakeReq({ authorization: 'bearer tok' }, '1.1.1.1'), 'tok')).toBe(true);
    expect(hasValidBearer(fakeReq({ authorization: 'BEARER tok' }, '1.1.1.1'), 'tok')).toBe(true);
    expect(hasValidBearer(fakeReq({ authorization: 'Bearer tokk' }, '1.1.1.1'), 'tok')).toBe(false);
    expect(hasValidBearer(fakeReq({ authorization: 'Basic tok' }, '1.1.1.1'), 'tok')).toBe(false);
    expect(hasValidBearer(fakeReq({}, '1.1.1.1'), 'tok')).toBe(false);
  });
});

describe('guardMutation vs remote peers', () => {
  it('rejects a forged allowed Origin from a non-loopback peer without a token', () => {
    process.env['MCP_AUTH_TOKEN'] = 'secret';
    const result = runGuard(fakeReq({ origin: 'http://localhost:5173' }, '203.0.113.9'));
    expect(result).toEqual({ status: 401, nextCalled: false });
  });

  it('allows a non-loopback peer with a valid bearer', () => {
    process.env['MCP_AUTH_TOKEN'] = 'secret';
    const result = runGuard(fakeReq({ authorization: 'Bearer secret' }, '203.0.113.9'));
    expect(result.nextCalled).toBe(true);
  });

  it('still allows a loopback browser with an allowed Origin', () => {
    process.env['MCP_AUTH_TOKEN'] = 'secret';
    const result = runGuard(fakeReq({ origin: 'http://localhost:5173' }, '::ffff:127.0.0.1'));
    expect(result.nextCalled).toBe(true);
  });
});

describe('Host allowlist', () => {
  it('allows localhost with any port, blocks rebinding hosts', async () => {
    expect((await request(app).get('/health').set('Host', 'localhost:4444')).status).toBe(200);
    expect((await request(app).get('/health').set('Host', '127.0.0.1:3001')).status).toBe(200);
    expect((await request(app).get('/health').set('Host', '[::1]:3001')).status).toBe(200);
    expect((await request(app).get('/health').set('Host', 'evil.example:3001')).status).toBe(403);
  });

  it('honours LLULL_ALLOWED_HOSTS (name = any port, name:port = exact)', async () => {
    process.env['LLULL_ALLOWED_HOSTS'] = 'cad.example, other.example:8080';
    expect((await request(app).get('/health').set('Host', 'cad.example:9')).status).toBe(200);
    expect((await request(app).get('/health').set('Host', 'other.example:8080')).status).toBe(200);
    expect((await request(app).get('/health').set('Host', 'other.example:1')).status).toBe(403);
  });

  it('accepts any Host when HOST is non-loopback and no allowlist is set', async () => {
    process.env['HOST'] = '0.0.0.0';
    expect((await request(app).get('/health').set('Host', 'anything.example')).status).toBe(200);
  });
});

describe('checkBindSafety', () => {
  it('refuses non-loopback without token unless explicitly allowed', () => {
    expect(checkBindSafety('0.0.0.0', {})).toContain('Refusing to start');
    expect(checkBindSafety('0.0.0.0', { MCP_AUTH_TOKEN: 't' })).toBeNull();
    expect(checkBindSafety('0.0.0.0', { LLULL_ALLOW_UNAUTHENTICATED: 'true' })).toBeNull();
    expect(checkBindSafety('127.0.0.1', {})).toBeNull();
  });
});

describe('/ui-bridge guard', () => {
  it('blocks a disallowed Origin on push and pull', async () => {
    const push = await request(app)
      .post('/ui-bridge/push')
      .set('Origin', 'http://evil.example')
      .send({ entities: {}, order: [] });
    expect(push.status).toBe(403);
    expect((await request(app).post('/ui-bridge/pull').set('Origin', 'http://evil.example')).status).toBe(403);
  });

  it('uses the shared bearer verifier (case-insensitive scheme)', async () => {
    process.env['MCP_AUTH_TOKEN'] = 'secret';
    const res = await request(app)
      .post('/ui-bridge/pull')
      .set('Authorization', 'bearer secret');
    expect(res.status).toBe(200);
    expect((await request(app).post('/ui-bridge/pull').set('Authorization', 'Bearer nope')).status).toBe(401);
  });
});

describe('autosaver stop mode', () => {
  it('writes synchronously after stop(), so a late edit is not lost', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llull-stop-'));
    try {
      const file = path.join(dir, 's.json');
      const saver = createAutosaver({ filePath: file, debounceMs: 60_000, serialize: () => '{"late":1}' });
      saver.stop();
      expect(fs.existsSync(file)).toBe(false);
      saver.schedule(createEmptyDocument());
      expect(fs.readFileSync(file, 'utf8')).toBe('{"late":1}');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stop() flushes a pending debounced write', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llull-stop-'));
    try {
      const file = path.join(dir, 't.json');
      const saver = createAutosaver({ filePath: file, debounceMs: 60_000, serialize: () => '{"p":1}' });
      saver.schedule(createEmptyDocument());
      saver.stop();
      expect(fs.readFileSync(file, 'utf8')).toBe('{"p":1}');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  });
});
