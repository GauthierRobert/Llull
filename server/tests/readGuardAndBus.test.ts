/**
 * @layer server/tests
 * guardRead (token / loopback / proxy), SSE backpressure + subscriber cap, idempotency cache rules,
 * MCP session cap, unreadable-autosave quarantine.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { app } from '../src/index';
import {
  _resetLiveDoc,
  subscribeLive,
  _subscriberCount,
  MAX_LIVE_SUBSCRIBERS,
} from '../src/liveDocument';
import { _resetHistory, applyCommand, canUndo, undo } from '../src/commandBus';
import { evictForCapacity, sessions } from '../src/mcp/sessions';
import type { Response } from 'express';

const TOKEN = 'secret-token';
const ENV_KEYS = ['MCP_AUTH_TOKEN', 'LLULL_REQUIRE_TOKEN_FOR_REST', 'MCP_MAX_SESSIONS'];

beforeEach(() => {
  _resetLiveDoc();
  _resetHistory();
});
afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  sessions.clear();
});

describe('guardRead', () => {
  it('is open without a token', async () => {
    expect((await request(app).get('/live/snapshot')).status).toBe(200);
    expect((await request(app).get('/export/stl')).status).toBe(200);
  });

  it('with a token: rejects bare loopback requests, accepts bearer and ?access_token=', async () => {
    process.env['MCP_AUTH_TOKEN'] = TOKEN;
    expect((await request(app).get('/live/snapshot')).status).toBe(401);
    expect((await request(app).get('/export/stl')).status).toBe(401);
    expect((await request(app).get('/live')).status).toBe(401);
    const bearer = await request(app).get('/live/snapshot').set('Authorization', `Bearer ${TOKEN}`);
    expect(bearer.status).toBe(200);
    const query = await request(app).get('/live/snapshot').query({ access_token: TOKEN });
    expect(query.status).toBe(200);
    const wrong = await request(app).get('/live/snapshot').query({ access_token: 'nope' });
    expect(wrong.status).toBe(401);
  });

  it('with a token: the local UI (allowed Origin, loopback) still reads', async () => {
    process.env['MCP_AUTH_TOKEN'] = TOKEN;
    const res = await request(app).get('/live/snapshot').set('Origin', 'http://localhost:5173');
    expect(res.status).toBe(200);
    const foreign = await request(app).get('/live/snapshot').set('Origin', 'https://evil.example');
    expect(foreign.status).toBe(403);
  });

  it('with a token: a proxied request (X-Forwarded-For / Forwarded) is not trusted as loopback', async () => {
    process.env['MCP_AUTH_TOKEN'] = TOKEN;
    const origin = 'http://localhost:5173';
    const xff = await request(app)
      .get('/live/snapshot')
      .set('Origin', origin)
      .set('X-Forwarded-For', '203.0.113.9');
    expect(xff.status).toBe(401);
    const fwd = await request(app)
      .post('/command')
      .set('Origin', origin)
      .set('Forwarded', 'for=203.0.113.9')
      .send({ name: 'add_box' });
    expect(fwd.status).toBe(401);
  });
});

describe('SSE backpressure and cap', () => {
  const fakeResponse = (writableLength: number): Response =>
    ({ write: vi.fn(), destroy: vi.fn(), writableLength }) as unknown as Response;

  it('drops and destroys a subscriber whose backlog exceeds 8 MB', () => {
    const slow = fakeResponse(9 * 1024 * 1024);
    const before = _subscriberCount();
    subscribeLive(slow);
    expect(slow.destroy).toHaveBeenCalled();
    expect(_subscriberCount()).toBe(before);
  });

  it('GET /live answers 503 at the subscriber cap', async () => {
    const unsubscribers = Array.from({ length: MAX_LIVE_SUBSCRIBERS }, () =>
      subscribeLive(fakeResponse(0)),
    );
    const res = await request(app).get('/live');
    expect(res.status).toBe(503);
    for (const unsubscribe of unsubscribers) unsubscribe();
  });
});

describe('idempotency cache', () => {
  it('does not cache read-only results (a later call sees fresh state)', () => {
    const first = applyCommand('export_stl', {}, 'q1');
    applyCommand('add_box', { size: [1, 1, 1] });
    const second = applyCommand('export_stl', {}, 'q1');
    expect(second).not.toBe(first);
    expect(second.summary).not.toBe(first.summary);
  });

  it('rejects a reused commandId with different params', () => {
    const first = applyCommand('add_box', { size: [1, 1, 1] }, 'dup');
    const second = applyCommand('add_box', { size: [2, 2, 2] }, 'dup');
    expect(first.isError).toBe(false);
    expect(second.isError).toBe(true);
    expect(second.summary).toMatch(/already used/);
  });

  it('recomputes canUndo/canRedo when serving a cached result', () => {
    const first = applyCommand('add_box', { size: [1, 1, 1] }, 'c1');
    expect(first.canUndo).toBe(true);
    undo();
    const replay = applyCommand('add_box', { size: [1, 1, 1] }, 'c1');
    expect(canUndo()).toBe(false);
    expect(replay.canUndo).toBe(false);
    expect(replay.summary).toBe(first.summary);
  });
});

describe('MCP session cap', () => {
  it('evicts the oldest idle session when full', () => {
    process.env['MCP_MAX_SESSIONS'] = '2';
    const close = vi.fn().mockResolvedValue(undefined);
    const entry = (lastSeenMs: number): never => ({ transport: { close }, lastSeenMs }) as never;
    sessions.set('old', entry(1));
    sessions.set('new', entry(2));
    evictForCapacity();
    expect([...sessions.keys()]).toEqual(['new']);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('unreadable autosave', () => {
  it('is renamed aside before starting empty', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llull-autosave-'));
    const file = path.join(dir, 'auto.json');
    fs.writeFileSync(file, '{ not json');
    vi.resetModules();
    vi.stubEnv('LLULL_AUTOSAVE_PATH', file);
    vi.stubEnv('VITEST', '');
    vi.stubEnv('TEST', '');
    vi.stubEnv('LLULL_AUTOSAVE_DISABLED', '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const live = await import('../src/liveDocument');
      expect(live.getLiveDoc().order).toEqual([]);
      const names = fs.readdirSync(dir);
      expect(names.some((name) => name.startsWith('auto.json.unreadable-'))).toBe(true);
      expect(fs.existsSync(file)).toBe(false);
      expect(String(warn.mock.calls[0]?.[0])).toContain('unreadable-');
    } finally {
      warn.mockRestore();
      vi.unstubAllEnvs();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
