/**
 * @layer server/tests
 * Hardening: CORS, filename sanitizing, JSON errors, mutation guard, rate limit,
 * thrown-command handling, debounced atomic autosave, shutdown helpers.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { app } from '../src/index';
import {
  _resetLiveDoc,
  subscribeLive,
  _subscriberCount,
  closeAllSubscribers,
} from '../src/liveDocument';
import { _resetHistory, applyCommand } from '../src/commandBus';
import { guardMutation, buildRestRateLimiter, getAllowedOrigins } from '../src/security';
import { safeFileName as sanitizeFilename } from '@lib/safeFileName';
import { createAutosaver } from '../src/autosave';
import { closeAllSessions, sessions } from '../src/mcp/sessions';
import { createEmptyDocument } from '@core/model/types';
import * as registry from '@core/commands/registry';

const ENV_KEYS = [
  'MCP_AUTH_TOKEN',
  'LLULL_ALLOWED_ORIGINS',
  'LLULL_REQUIRE_TOKEN_FOR_REST',
  'LLULL_REST_RATE_LIMIT_MAX',
];
beforeEach(() => {
  _resetLiveDoc();
  _resetHistory();
});
afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  vi.restoreAllMocks();
});

describe('CORS', () => {
  it('echoes an allowed origin', async () => {
    const res = await request(app).get('/health').set('Origin', 'http://localhost:5173');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('omits CORS headers (no 500) for a disallowed origin', async () => {
    const res = await request(app).get('/health').set('Origin', 'http://evil.example');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('reads LLULL_ALLOWED_ORIGINS', async () => {
    process.env['LLULL_ALLOWED_ORIGINS'] = 'https://a.example, https://b.example';
    expect(getAllowedOrigins()).toEqual(['https://a.example', 'https://b.example']);
    const res = await request(app).get('/health').set('Origin', 'https://b.example');
    expect(res.headers['access-control-allow-origin']).toBe('https://b.example');
  });
});

describe('sanitizeFilename / GET /export/stl', () => {
  it('strips unsafe characters and falls back', () => {
    expect(sanitizeFilename('a"b\r\nc/../d')).toBe('a_b_c_.._d');
    expect(sanitizeFilename('..')).toBe('llull');
    expect(sanitizeFilename(['x'])).toBe('llull');
    expect(sanitizeFilename('x'.repeat(200))).toHaveLength(64);
  });

  it('never emits header-injecting characters in Content-Disposition', async () => {
    const res = await request(app).get('/export/stl').query({ name: 'my"part\r\nX-Evil: 1/é' });
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="my_part_X-Evil_1_.stl"');
    expect(res.headers['x-evil']).toBeUndefined();
  });
});

describe('JSON error handling', () => {
  it('returns 400 JSON for malformed JSON', async () => {
    const res = await request(app)
      .post('/command')
      .set('Content-Type', 'application/json')
      .send('{"name": ');
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body.error).toMatch(/Malformed JSON/);
  });

  it('returns 413 JSON for oversized bodies', async () => {
    const res = await request(app)
      .post('/command')
      .send({ name: 'add_box', params: { pad: 'x'.repeat(3 * 1024 * 1024) } });
    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/too large/);
  });

  it('body-parser errors still carry CORS headers for an allowed origin', async () => {
    const malformed = await request(app)
      .post('/command')
      .set('Origin', 'http://localhost:5173')
      .set('Content-Type', 'application/json')
      .send('{"name": ');
    expect(malformed.status).toBe(400);
    expect(malformed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    const oversized = await request(app)
      .post('/command')
      .set('Origin', 'http://localhost:5173')
      .send({ name: 'add_box', params: { pad: 'x'.repeat(3 * 1024 * 1024) } });
    expect(oversized.status).toBe(413);
    expect(oversized.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });
});

describe('mutation guard (/command, /undo, /redo)', () => {
  const body = { name: 'add_box', params: { size: [1, 1, 1], position: [0, 0, 0] } };

  it('rejects a foreign Origin with 403 and does not mutate', async () => {
    const res = await request(app).post('/command').set('Origin', 'http://evil.example').send(body);
    expect(res.status).toBe(403);
    const undoRes = await request(app).post('/undo').set('Origin', 'http://evil.example');
    expect(undoRes.status).toBe(403);
  });

  it('allows an allowed Origin and no-Origin when no token is configured', async () => {
    expect(
      (await request(app).post('/command').set('Origin', 'http://localhost:5173').send(body))
        .status,
    ).toBe(200);
    expect((await request(app).post('/command').send(body)).status).toBe(200);
  });

  it('with a token: allowed Origin passes, bare client gets 401, bearer passes', async () => {
    process.env['MCP_AUTH_TOKEN'] = 's3cret';
    expect(
      (await request(app).post('/command').set('Origin', 'http://localhost:5173').send(body))
        .status,
    ).toBe(200);
    expect((await request(app).post('/command').send(body)).status).toBe(401);
    expect(
      (await request(app).post('/command').set('Authorization', 'Bearer wrong').send(body)).status,
    ).toBe(401);
    expect(
      (await request(app).post('/command').set('Authorization', 'Bearer s3cret').send(body)).status,
    ).toBe(200);
  });

  it('strict mode requires the bearer even from an allowed Origin; foreign Origin + bearer passes', async () => {
    process.env['MCP_AUTH_TOKEN'] = 's3cret';
    process.env['LLULL_REQUIRE_TOKEN_FOR_REST'] = 'true';
    expect(
      (await request(app).post('/command').set('Origin', 'http://localhost:5173').send(body))
        .status,
    ).toBe(401);
    expect((await request(app).post('/undo').set('Authorization', 'Bearer s3cret')).status).toBe(
      200,
    );
  });

  it('does not guard read routes', async () => {
    process.env['MCP_AUTH_TOKEN'] = 's3cret';
    expect((await request(app).get('/health')).status).toBe(200);
  });

  it('guardMutation is usable standalone', async () => {
    const mini = express()
      .use(guardMutation())
      .post('/x', (_req, res) => res.json({ ok: true }));
    expect((await request(mini).post('/x')).status).toBe(200);
  });
});

describe('REST rate limiting', () => {
  it('returns 429 after the configured max', async () => {
    process.env['LLULL_REST_RATE_LIMIT_MAX'] = '2';
    const mini = express()
      .use(buildRestRateLimiter())
      .post('/x', (_req, res) => res.json({ ok: true }));
    expect((await request(mini).post('/x')).status).toBe(200);
    expect((await request(mini).post('/x')).status).toBe(200);
    expect((await request(mini).post('/x')).status).toBe(429);
  });
});

describe('thrown commands become error results', () => {
  it('applyCommand returns isError instead of throwing', () => {
    vi.spyOn(registry, 'execute').mockImplementation(() => {
      throw new Error('boom');
    });
    const result = applyCommand('add_box', {});
    expect(result.isError).toBe(true);
    expect(result.summary).toContain('boom');
    expect(result.affected).toEqual([]);
  });
});

describe('createAutosaver', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llull-autosave-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('debounces bursts into one write of the latest doc', async () => {
    const file = path.join(dir, 'a.json');
    const serialize = vi.fn((doc: unknown) => JSON.stringify(doc));
    const saver = createAutosaver({ filePath: file, debounceMs: 20, serialize });
    const doc = createEmptyDocument();
    saver.schedule(doc);
    saver.schedule(doc);
    saver.schedule(doc);
    expect(fs.existsSync(file)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(serialize).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readdirSync(dir)).toEqual(['a.json']);
  });

  it('flush writes pending doc immediately; flush with nothing pending is a no-op', () => {
    const file = path.join(dir, 'b.json');
    const saver = createAutosaver({
      filePath: file,
      debounceMs: 60_000,
      serialize: () => '{"x":1}',
    });
    saver.flush();
    expect(fs.existsSync(file)).toBe(false);
    saver.schedule(createEmptyDocument());
    saver.flush();
    expect(fs.readFileSync(file, 'utf8')).toBe('{"x":1}');
  });

  it('write failure warns and leaves the previous file intact', () => {
    const file = path.join(dir, 'c.json');
    fs.writeFileSync(file, 'old');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const saver = createAutosaver({
      filePath: file,
      debounceMs: 60_000,
      serialize: () => {
        throw new Error('nope');
      },
    });
    saver.schedule(createEmptyDocument());
    saver.flush();
    expect(warn).toHaveBeenCalled();
    expect(fs.readFileSync(file, 'utf8')).toBe('old');
  });
});

describe('shutdown helpers', () => {
  it('closeAllSubscribers ends streams and empties the registry', () => {
    const end = vi.fn();
    const fakeRes = { write: vi.fn(), end } as unknown as Parameters<typeof subscribeLive>[0];
    subscribeLive(fakeRes);
    expect(_subscriberCount()).toBe(1);
    closeAllSubscribers();
    expect(end).toHaveBeenCalled();
    expect(_subscriberCount()).toBe(0);
  });

  it('closeAllSessions leaves no sessions', async () => {
    await closeAllSessions();
    expect(sessions.size).toBe(0);
  });
});
