/** /health proves knowledge of the per-launch token (HMAC challenge): a process that took the backend's port first is not accepted by the desktop. */

import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/index';
import { type FetchLike, isHealthy } from '../src/restClient';

const TOKEN = 'per-launch-token';
afterEach(() => {
  delete process.env['LLULL_AUTH_TOKEN'];
});

/** A fetch that answers `body` to every /health. */
const answering =
  (body: (challenge: string) => unknown): FetchLike =>
  (url) => {
    const challenge = new URL(url).searchParams.get('challenge') ?? '';
    return Promise.resolve(new Response(JSON.stringify(body(challenge)), { status: 200 }));
  };

describe('/health challenge', () => {
  it('the real backend answers the HMAC of the challenge only when it holds the token', async () => {
    process.env['LLULL_AUTH_TOKEN'] = TOKEN;
    const proved = await request(app).get('/health').query({ challenge: 'abc' });
    expect(proved.body.proof).toBe(createHmac('sha256', TOKEN).update('abc').digest('hex'));
    expect((await request(app).get('/health')).body.proof).toBeUndefined();
    delete process.env['LLULL_AUTH_TOKEN'];
    expect((await request(app).get('/health').query({ challenge: 'abc' })).body.proof).toBeUndefined();
  });

  it('isHealthy with a token accepts only the process that proves it; an impostor on the port is refused', async () => {
    const honest = answering((challenge) => ({ status: 'ok', proof: createHmac('sha256', TOKEN).update(challenge).digest('hex') }));
    expect(await isHealthy('http://x', honest, 1000, TOKEN)).toBe(true);
    expect(
      await isHealthy(
        'http://x',
        answering(() => ({ status: 'ok' })),
        1000,
        TOKEN,
      ),
    ).toBe(false);
    expect(
      await isHealthy(
        'http://x',
        answering(() => ({ status: 'ok', proof: 'f'.repeat(64) })),
        1000,
        TOKEN,
      ),
    ).toBe(false);
    expect(
      await isHealthy(
        'http://x',
        answering(() => ({ status: 'ok', proof: 5 })),
        1000,
        TOKEN,
      ),
    ).toBe(false);
    expect(
      await isHealthy(
        'http://x',
        answering(() => ({ status: 'ok' })),
        1000,
      ),
    ).toBe(true);
  });
});
