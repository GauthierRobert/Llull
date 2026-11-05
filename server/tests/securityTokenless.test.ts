/** VC-INT-20 (TR-INT-11): no token and no explicit insecure switch -> mutating routes refuse; no default allowed origin; /health behind the Host allowlist. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { app } from '../src/index';
import { _resetLiveDoc } from '../src/liveDocument';
import { _resetHistory } from '../src/commandBus';
import { getAllowedOrigins, contentSecurityPolicy } from '../src/security';
import { applyLaunchAuth, launchAuthNotice } from '../src/launchAuth';

const KEYS = ['LLULL_AUTH_TOKEN', 'LLULL_INSECURE_NO_TOKEN', 'LLULL_ALLOWED_ORIGINS', 'LLULL_REQUIRE_TOKEN_FOR_REST'];
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
const body = { name: 'add_box', params: { size: [1, 1, 1], position: [0, 0, 0] } };

beforeEach(() => {
  _resetLiveDoc();
  _resetHistory();
  for (const key of KEYS) delete process.env[key];
});
afterEach(() => {
  for (const key of KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('server started without a token', () => {
  it('refuses every mutating route with 401 SEC_TOKEN_REQUIRED, with or without an Origin', async () => {
    for (const [route, payload] of [
      ['/command', body],
      ['/undo', {}],
      ['/redo', {}],
      ['/exchange', { name: 'export_step', params: {} }],
      ['/import/dwg', {}],
      ['/preview', body],
      ['/signing/sign', {}],
      ['/live/ticket', {}],
    ] as const) {
      const bare = await request(app).post(route).send(payload);
      expect(bare.status, route).toBe(401);
      expect(bare.body, route).toMatchObject({ code: 'SEC_TOKEN_REQUIRED' });
      const withOrigin = await request(app).post(route).set('Origin', 'http://localhost:5173').send(payload);
      expect(withOrigin.status, route).toBe(401);
    }
  });

  it('does not change the document when refused', async () => {
    await request(app).post('/command').send(body);
    expect((await request(app).get('/live/snapshot')).body.document.entities).toEqual({});
  });

  it('serves the command with --insecure-no-token (LLULL_INSECURE_NO_TOKEN=1) and says so in /health', async () => {
    process.env['LLULL_INSECURE_NO_TOKEN'] = '1';
    const res = await request(app).post('/command').send(body);
    expect(res.status).toBe(200);
    expect((await request(app).get('/health')).body).toMatchObject({ status: 'ok', insecure: true });
  });

  it('keeps token auth working and does not report insecure when a token is set', async () => {
    process.env['LLULL_AUTH_TOKEN'] = 's3cret';
    expect((await request(app).post('/command').send(body)).status).toBe(401);
    expect((await request(app).post('/command').set('Authorization', 'Bearer s3cret').send(body)).status).toBe(200);
    expect((await request(app).get('/health')).body.insecure).toBeUndefined();
  });
});

describe('allowed origins', () => {
  it('has no default: the legacy Vite origin is refused and absent from the CSP', async () => {
    process.env['LLULL_INSECURE_NO_TOKEN'] = '1';
    expect(getAllowedOrigins()).toEqual([]);
    expect(contentSecurityPolicy()).not.toContain('5173');
    const res = await request(app).post('/command').set('Origin', 'http://localhost:5173').send(body);
    expect(res.status).toBe(403);
    expect(
      (await request(app).get('/health').set('Origin', 'http://localhost:5173')).headers['access-control-allow-origin'],
    ).toBeUndefined();
  });

  it('names an origin only through LLULL_ALLOWED_ORIGINS', async () => {
    process.env['LLULL_INSECURE_NO_TOKEN'] = '1';
    process.env['LLULL_ALLOWED_ORIGINS'] = 'http://localhost:5173';
    expect((await request(app).post('/command').set('Origin', 'http://localhost:5173').send(body)).status).toBe(200);
  });
});

describe('/health behind the Host allowlist', () => {
  it('answers 403 for a foreign Host and 200 for loopback hosts', async () => {
    expect((await request(app).get('/health').set('Host', 'evil.test')).status).toBe(403);
    expect((await request(app).get('/health').set('Host', '127.0.0.1:3001')).status).toBe(200);
  });

  it('still answers the HMAC challenge probe whatever the Host', async () => {
    process.env['LLULL_AUTH_TOKEN'] = 's3cret';
    const res = await request(app).get('/health').set('Host', 'evil.test').query({ challenge: 'abcd' });
    expect(res.status).toBe(200);
    expect(res.body.proof).toBe(createHmac('sha256', 's3cret').update('abcd').digest('hex'));
  });
});

describe('standalone launch (per-launch token)', () => {
  it('generates a token when none is configured and no insecure flag is given, and prints how to use it', () => {
    const env: NodeJS.ProcessEnv = {};
    const auth = applyLaunchAuth(env, []);
    expect(auth.mode).toBe('generated');
    expect(env['LLULL_AUTH_TOKEN']).toMatch(/^[0-9a-f]{48}$/);
    expect(launchAuthNotice(auth, 'http://127.0.0.1:3001')).toContain(`--token ${env['LLULL_AUTH_TOKEN']}`);
  });

  it('keeps a configured token, and honours --insecure-no-token with a warning and no token', () => {
    const configured: NodeJS.ProcessEnv = { LLULL_AUTH_TOKEN: 'abc' };
    expect(applyLaunchAuth(configured, [])).toEqual({ mode: 'configured' });
    expect(launchAuthNotice({ mode: 'configured' }, 'u')).toBeNull();
    const insecure: NodeJS.ProcessEnv = {};
    const auth = applyLaunchAuth(insecure, ['--insecure-no-token']);
    expect(auth).toEqual({ mode: 'insecure' });
    expect(insecure['LLULL_AUTH_TOKEN']).toBeUndefined();
    expect(insecure['LLULL_INSECURE_NO_TOKEN']).toBe('1');
    expect(launchAuthNotice(auth, 'u')).toContain('WARNING');
  });
});
