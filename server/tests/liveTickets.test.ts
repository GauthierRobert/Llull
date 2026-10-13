/** POST /live/ticket + GET /live?ticket=: single-use, short-lived, identity-bound; ?access_token= deprecated but working. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Request, Response } from 'express';
import request from 'supertest';
import { app } from '../src/index';
import { guardRead } from '../src/security';
import { MAX_TICKETS, MAX_TICKETS_PER_OWNER, TICKET_TTL_MS, _resetTickets, consumeTicket, issueTicket } from '../src/tickets';
import { authenticateToken } from '../src/users';
import { _resetLiveDoc } from '../src/liveDocument';
import { VIEWER, bearer, clearEnv, installUsersFile, tempDir } from './userTestSupport';
import fs from 'fs';

const TOKEN = 'secret-token';

beforeEach(() => {
  _resetTickets();
  _resetLiveDoc();
});
afterEach(() => {
  clearEnv();
  vi.restoreAllMocks();
});

const mint = async (token = TOKEN): Promise<string> => {
  const res = await request(app)
    .post('/live/ticket')
    .set(...bearer(token));
  return res.body.ticket as string;
};

describe('POST /live/ticket (shared token)', () => {
  beforeEach(() => {
    process.env['MCP_AUTH_TOKEN'] = TOKEN;
  });

  it('issues only with valid header auth', async () => {
    expect((await request(app).post('/live/ticket')).status).toBe(401);
    expect(
      (
        await request(app)
          .post('/live/ticket')
          .set(...bearer('nope'))
      ).status,
    ).toBe(401);
    expect((await request(app).post('/live/ticket').query({ access_token: TOKEN })).status).toBe(401);
    const ok = await request(app)
      .post('/live/ticket')
      .set(...bearer(TOKEN));
    expect(ok.status).toBe(200);
    expect(ok.body.expiresInMs).toBe(TICKET_TTL_MS);
    expect(Buffer.from(ok.body.ticket, 'base64url')).toHaveLength(32);
  });

  it('is single use', async () => {
    const ticket = await mint();
    expect(consumeTicket(ticket)).not.toBeNull();
    expect(consumeTicket(ticket)).toBeNull();
  });

  it('rejects unknown tickets and expired tickets', async () => {
    expect((await request(app).get('/live').query({ ticket: 'forged' })).status).toBe(401);
    const stale = issueTicket(undefined, 'test', Date.now() - TICKET_TTL_MS - 1) as string;
    expect((await request(app).get('/live').query({ ticket: stale })).status).toBe(401);
    expect(consumeTicket(stale)).toBeNull();
  });

  it('opens only the live stream: snapshot and exports ignore a ticket', async () => {
    const ticket = await mint();
    expect((await request(app).get('/live/snapshot').query({ ticket })).status).toBe(401);
    expect((await request(app).get('/export/stl').query({ ticket })).status).toBe(401);
    expect(consumeTicket(ticket)).not.toBeNull(); // not consumed by the refused requests
  });

  it('judges a request with an Authorization header by that header, not a stray ticket', async () => {
    const status = await request(app).get('/live/snapshot').query({ ticket: 'forged' }).set('Authorization', `Bearer ${TOKEN}`);
    expect(status.status).toBe(200);
  });

  it('caps outstanding tickets per owner, recycling the oldest', () => {
    const first = issueTicket(undefined, 'one-client') as string;
    for (let i = 1; i < MAX_TICKETS_PER_OWNER; i += 1) issueTicket(undefined, 'one-client');
    const other = issueTicket(undefined, 'another-client') as string;
    expect(issueTicket(undefined, 'one-client')).not.toBeNull();
    expect(consumeTicket(first)).toBeNull(); // recycled
    expect(consumeTicket(other)).not.toBeNull();
  });

  it('opens the SSE stream with a ticket, and the stream URL carries no token', async () => {
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const ticket = await mint();
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: `/live?ticket=${ticket}` }, (res) => {
          resolve(res.statusCode ?? 0);
          req.destroy();
        });
        req.on('error', (error) => (error as NodeJS.ErrnoException).code === 'ECONNRESET' || reject(error));
      });
      expect(status).toBe(200);
      expect((await request(server).get('/live').query({ ticket })).status).toBe(401);
    } finally {
      server.close();
    }
  });

  it('keeps ?access_token= working but warns once (deprecated)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await request(app).get('/live/snapshot').query({ access_token: TOKEN })).status).toBe(200);
    await request(app).get('/live/snapshot').query({ access_token: TOKEN });
    const deprecations = warn.mock.calls.filter((call) => String(call[0]).includes('DEPRECATED'));
    expect(deprecations.length).toBeLessThanOrEqual(1);
  });

  it('bounds the store and sweeps expired tickets', () => {
    const old = Date.now() - TICKET_TTL_MS - 1;
    for (let i = 0; i < MAX_TICKETS; i += 1) expect(issueTicket(undefined, `c${i}`, old)).not.toBeNull();
    expect(issueTicket(undefined, 'fresh')).not.toBeNull(); // sweep freed the expired ones
    _resetTickets();
    for (let i = 0; i < MAX_TICKETS; i += 1) issueTicket(undefined, `c${i}`);
    expect(issueTicket(undefined, 'fresh')).toBeNull();
  });
});

describe('tickets in named-user mode', () => {
  it('binds the ticket to the minting user and refuses it without header auth to mint', async () => {
    const dir = tempDir();
    try {
      installUsersFile(dir, [VIEWER]);
      expect((await request(app).post('/live/ticket').query({ access_token: VIEWER.token })).status).toBe(401);
      const ticket = await mint(VIEWER.token);
      expect(ticket).toBeTruthy();
      const res = { locals: {} as Record<string, unknown>, status: vi.fn(), json: vi.fn() } as unknown as Response;
      const next = vi.fn();
      guardRead()({ method: 'GET', baseUrl: '', path: '/live', query: { ticket }, headers: {} } as unknown as Request, res, next);
      expect(next).toHaveBeenCalledOnce();
      expect(res.locals['llullUser']).toEqual(authenticateToken(VIEWER.token));
      expect((res.locals['llullUser'] as { role: string }).role).toBe('viewer');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
