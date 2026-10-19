/**
 * Auth/guard hardening: remote-peer guard, bearer verifier, Host allowlist, bind safety,
 * autosave stop mode, browser mutation guard.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Request, Response } from 'express';
import { app } from '../src/index';
import { guardMutation, hasValidBearer, isLoopbackAddress, isLocalPeer, checkBindSafety } from '../src/security';
import { createAutosaver } from '../src/autosave';
import { createEmptyDocument } from '@core/model/types';

const ENV_KEYS = ['LLULL_AUTH_TOKEN', 'LLULL_REQUIRE_TOKEN_FOR_REST'];
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
    for (const a of ['127.0.0.1', '127.5.6.7', '::1', '::ffff:127.0.0.1', 'localhost']) expect(isLoopbackAddress(a)).toBe(true);
    for (const a of ['10.0.0.5', '::ffff:10.0.0.5', '0.0.0.0', undefined]) expect(isLoopbackAddress(a)).toBe(false);
  });
});

describe('isLocalPeer', () => {
  it('is local for a bare loopback peer and not for any proxy-relay header or a non-loopback address', () => {
    expect(isLocalPeer(fakeReq({}, '127.0.0.1'))).toBe(true);
    for (const header of [
      'x-forwarded-for',
      'forwarded',
      'x-real-ip',
      'cf-connecting-ip',
      'x-forwarded-host',
      'x-forwarded-proto',
      'x-forwarded-port',
    ])
      expect(isLocalPeer(fakeReq({ [header]: 'x' }, '127.0.0.1')), header).toBe(false);
    expect(isLocalPeer(fakeReq({}, '203.0.113.9'))).toBe(false);
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
    process.env['LLULL_AUTH_TOKEN'] = 'secret';
    const result = runGuard(fakeReq({ origin: 'http://localhost:5173' }, '203.0.113.9'));
    expect(result).toEqual({ status: 401, nextCalled: false });
  });

  it('allows a non-loopback peer with a valid bearer', () => {
    process.env['LLULL_AUTH_TOKEN'] = 'secret';
    const result = runGuard(fakeReq({ authorization: 'Bearer secret' }, '203.0.113.9'));
    expect(result.nextCalled).toBe(true);
  });

  it('still allows a loopback browser with an allowed Origin', () => {
    process.env['LLULL_AUTH_TOKEN'] = 'secret';
    const result = runGuard(fakeReq({ origin: 'http://localhost:5173' }, '::ffff:127.0.0.1'));
    expect(result.nextCalled).toBe(true);
  });
});

describe('Host allowlist', () => {
  it('allows localhost with any port, blocks rebinding hosts', async () => {
    expect((await request(app).get('/live/snapshot').set('Host', 'localhost:4444')).status).toBe(200);
    expect((await request(app).get('/live/snapshot').set('Host', '127.0.0.1:3001')).status).toBe(200);
    expect((await request(app).get('/live/snapshot').set('Host', '[::1]:3001')).status).toBe(200);
    expect((await request(app).get('/live/snapshot').set('Host', 'evil.example:3001')).status).toBe(403);
  });

  it('has no host-name allowlist extension (LLULL_ALLOWED_HOSTS is gone)', async () => {
    process.env['LLULL_ALLOWED_HOSTS'] = 'cad.example';
    try {
      expect((await request(app).get('/live/snapshot').set('Host', 'cad.example:9')).status).toBe(403);
    } finally {
      delete process.env['LLULL_ALLOWED_HOSTS'];
    }
  });
});

describe('checkBindSafety', () => {
  it('refuses any non-loopback host, with or without a token (local-only backend)', () => {
    expect(checkBindSafety('0.0.0.0')).toContain('Refusing to start');
    expect(checkBindSafety('192.168.1.20')).toContain('loopback');
    expect(checkBindSafety('127.0.0.1')).toBeNull();
    expect(checkBindSafety('::1')).toBeNull();
  });
});

describe('browser mutation guard (/command)', () => {
  it('blocks a disallowed Origin', async () => {
    const res = await request(app).post('/command').set('Origin', 'http://evil.example').send({ name: 'describe_scene', params: {} });
    expect(res.status).toBe(403);
  });

  it('uses the shared bearer verifier (case-insensitive scheme)', async () => {
    process.env['LLULL_AUTH_TOKEN'] = 'secret';
    const ok = await request(app).post('/command').set('Authorization', 'bearer secret').send({ name: 'describe_scene', params: {} });
    expect(ok.status).toBe(200);
    const bad = await request(app).post('/command').set('Authorization', 'Bearer nope').send({ name: 'describe_scene', params: {} });
    expect(bad.status).toBe(401);
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
