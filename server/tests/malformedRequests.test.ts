/**
 * Malformed HTTP and JSON input on /command and /exchange: every case gets a clean, JSON, bounded
 * error (no crash, no HTML, no stack trace) and leaves the document untouched.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/index';
import { _resetHistory } from '../src/commandBus';
import { _resetLiveDoc, getLiveSnapshot } from '../src/liveDocument';

const post = (path: string): request.Test => request(app).post(path);

function expectCleanError(res: request.Response, status: number): void {
  expect(res.status).toBe(status);
  expect(String(res.headers['content-type'])).toContain('json');
  expect(res.text).not.toMatch(/\n\s+at .*\.(?:ts|js):\d+/); // no stack frames
  expect(res.text).not.toContain('<html');
}

describe('POST /command with malformed input', () => {
  beforeEach(() => {
    _resetLiveDoc();
    _resetHistory();
  });

  it.each([
    ['null body', 'null'],
    ['truncated JSON', '{"name": '],
    ['a bare string', '"add_box"'],
  ])('%s is a 400 Malformed JSON / body error', async (_label, body) => {
    const res = await post('/command').set('Content-Type', 'application/json').send(body);
    expectCleanError(res, 400);
  });

  it.each([
    ['an array', [1, 2]],
    ['an empty object', {}],
    ['a numeric name', { name: 5 }],
    ['an empty name', { name: '' }],
    ['a numeric commandId', { name: 'add_box', commandId: 5 }],
    ['an empty commandId', { name: 'add_box', commandId: '' }],
  ])('%s is a 400 with an explanatory error', async (_label, body) => {
    const res = await post('/command').send(body);
    expectCleanError(res, 400);
    expect(typeof res.body.error).toBe('string');
  });

  it.each([
    ['empty body', undefined],
    ['text/plain', 'hello'],
  ])('%s is a 400', async (_label, body) => {
    const req = post('/command');
    if (body !== undefined) req.set('Content-Type', 'text/plain').send(body);
    expectCleanError(await req, 400);
  });

  it.each([
    ['a string', 'x'],
    ['an array', [1]],
    ['null', null],
    ['a number', 7],
  ])('params as %s is an isError result, not a failure', async (_label, params) => {
    const before = getLiveSnapshot();
    const res = await post('/command').send({ name: 'add_box', params });
    expectCleanError(res, 200);
    expect(res.body.isError).toBe(true);
    expect(res.body.summary).toContain('rejected');
    expect(getLiveSnapshot().stateHash).toBe(before.stateHash);
  });

  it('an unknown command is an isError result listing nothing sensitive', async () => {
    const res = await post('/command').send({ name: 'no_such_command', params: {} });
    expectCleanError(res, 200);
    expect(res.body).toMatchObject({ isError: true, changed: false });
  });

  it('a __proto__ key in params cannot pollute Object.prototype', async () => {
    await post('/command')
      .set('Content-Type', 'application/json')
      .send('{"name":"add_box","params":{"__proto__":{"polluted":1},"size":[1,1,1]}}');
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('an oversized body is a 413 JSON error', async () => {
    const res = await post('/command').send({ name: 'add_box', params: { pad: 'x'.repeat(3e6) } });
    expectCleanError(res, 413);
  });
});

describe('/exchange with malformed input', () => {
  it('a body without a tool name is a 400 JSON error', async () => {
    expectCleanError(await post('/exchange').send({ params: {} }), 400);
  });

  it('a registry command name is a 404 JSON error pointing at /command', async () => {
    const res = await post('/exchange').send({ name: 'add_box', params: {} });
    expectCleanError(res, 404);
    expect(res.body.error).toMatch(/POST \/command/);
  });
});

describe('unknown routes', () => {
  it.each([
    ['GET', '/nope'],
    ['POST', '/live'],
    ['DELETE', '/command'],
    ['POST', '/mcp'],
  ])('%s %s is a JSON 404 (never the framework HTML page)', async (method, path) => {
    const res = await request(app)[method.toLowerCase() as 'get' | 'post' | 'delete'](path);
    expectCleanError(res, 404);
    expect(res.body.error).toContain(`${method} ${path}`);
  });
});
