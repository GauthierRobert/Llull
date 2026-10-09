/**
 * @layer server/tests
 * Named users and roles: 401 unknown token, 403 insufficient role, viewer read-only (REST + MCP),
 * editor commands, admin endpoints, token hashing, license seat refusal, live event attribution.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import { app } from '../src/index';
import { _resetLiveDoc } from '../src/liveDocument';
import { _resetHistory } from '../src/commandBus';
import { authenticateToken, loadUsers } from '../src/users';
import {
  ADMIN,
  EDITOR,
  VIEWER,
  clearEnv,
  installUsersFile,
  sha256,
  tempDir,
} from './userTestSupport';
import { subscribeLive } from '../src/liveDocument';
import type { Response } from 'express';

const bearer = (token: string): [string, string] => ['Authorization', `Bearer ${token}`];
const addBox = { name: 'add_box', params: { size: [1, 1, 1] } };

let dir: string;
beforeEach(() => {
  dir = tempDir();
  installUsersFile(dir, [ADMIN, EDITOR, VIEWER]);
  _resetLiveDoc();
  _resetHistory();
});
afterEach(() => {
  clearEnv();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('named-user authentication', () => {
  it('rejects a missing or unknown token with 401', async () => {
    expect((await request(app).post('/command').send(addBox)).status).toBe(401);
    const res = await request(app)
      .post('/command')
      .set(...bearer('nope'))
      .send(addBox);
    expect(res.status).toBe(401);
    expect((await request(app).get('/live/snapshot')).status).toBe(401);
  });

  it('stores and compares only SHA-256 hashes', () => {
    const raw = fs.readFileSync(process.env['LLULL_USERS_FILE'] as string, 'utf8');
    expect(raw).not.toContain(EDITOR.token);
    expect(raw).toContain(sha256(EDITOR.token));
    expect(authenticateToken(EDITOR.token)?.id).toBe('ed');
    expect(authenticateToken('tok-edito')).toBeNull();
    expect(loadUsers()).toHaveLength(3);
  });

  it('ignores malformed user entries', () => {
    fs.writeFileSync(
      process.env['LLULL_USERS_FILE'] as string,
      JSON.stringify([{ id: 'x', name: 'x', role: 'boss', tokenSha256: 'abc' }]),
    );
    expect(loadUsers()).toHaveLength(0);
  });

  it('keeps shared-token mode working when no users file is set', async () => {
    delete process.env['LLULL_USERS_FILE'];
    process.env['MCP_AUTH_TOKEN'] = 'shared';
    const ok = await request(app)
      .post('/command')
      .set(...bearer('shared'))
      .send(addBox);
    expect(ok.status).toBe(200);
    expect((await request(app).post('/command').send(addBox)).status).toBe(401);
  });
});

describe('roles over REST', () => {
  it('viewer can read but not change (403 with a clear message)', async () => {
    const snapshot = await request(app)
      .get('/live/snapshot')
      .set(...bearer(VIEWER.token));
    expect(snapshot.status).toBe(200);
    const viaQuery = await request(app).get(`/live/snapshot?access_token=${VIEWER.token}`);
    expect(viaQuery.status).toBe(200);
    const denied = await request(app)
      .post('/command')
      .set(...bearer(VIEWER.token))
      .send(addBox);
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatch(/role "viewer".*"editor"/);
    expect(
      (
        await request(app)
          .post('/undo')
          .set(...bearer(VIEWER.token))
      ).status,
    ).toBe(403);
  });

  it('editor runs commands but not admin endpoints', async () => {
    const ok = await request(app)
      .post('/command')
      .set(...bearer(EDITOR.token))
      .send(addBox);
    expect(ok.status).toBe(200);
    expect(ok.body.isError).toBe(false);
    const denied = await request(app)
      .get('/admin/users')
      .set(...bearer(EDITOR.token));
    expect(denied.status).toBe(403);
    expect(denied.body.error).toMatch(/"admin"/);
  });

  it('admin lists users (no hashes) and the license', async () => {
    const users = await request(app)
      .get('/admin/users')
      .set(...bearer(ADMIN.token));
    expect(users.status).toBe(200);
    expect(users.body.users.map((u: { id: string }) => u.id)).toEqual(['ada', 'ed', 'vera']);
    expect(JSON.stringify(users.body)).not.toContain('tokenSha256');
    const license = await request(app)
      .get('/admin/license')
      .set(...bearer(ADMIN.token));
    expect(license.body).toMatchObject({ mode: 'evaluation', seatsUsed: 3, namedUsers: 3 });
  });

  it('GET /license is public', async () => {
    const res = await request(app).get('/license');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: 'evaluation', seats: 3, evaluation: true });
  });

  it('refuses users beyond the seat count with 402', async () => {
    installUsersFile(dir, [ADMIN, EDITOR, VIEWER, { ...VIEWER, id: 'v2', token: 'tok-v2' }]);
    const refused = await request(app)
      .get('/live/snapshot')
      .set(...bearer('tok-v2'));
    expect(refused.status).toBe(402);
    expect(refused.body.error).toMatch(/seat limit/i);
    const fine = await request(app)
      .get('/live/snapshot')
      .set(...bearer(ADMIN.token));
    expect(fine.status).toBe(200);
  });
});

describe('live attribution', () => {
  it('command events carry the acting user', async () => {
    const frames: string[] = [];
    const res = {
      write: (chunk: string) => frames.push(chunk),
      writableLength: 0,
    } as unknown as Response;
    const unsubscribe = subscribeLive(res);
    await request(app)
      .post('/command')
      .set(...bearer(EDITOR.token))
      .send(addBox);
    unsubscribe();
    const commandFrame = frames.find((f) => f.startsWith('event: command'));
    expect(commandFrame).toBeDefined();
    expect(commandFrame).toContain('"userId":"ed"');
    expect(commandFrame).toContain('"userName":"Ed Editor"');
  });
});

/** Minimal MCP client over supertest (responses are SSE-wrapped JSON-RPC). */
async function mcp(token: string, body: object, session?: string): Promise<request.Response> {
  const req = request(app)
    .post('/mcp')
    .set('Content-Type', 'application/json')
    .set('Accept', 'application/json, text/event-stream')
    .set(...bearer(token));
  if (session !== undefined) req.set('mcp-session-id', session);
  return req.send(body);
}

function rpcResult(text: string): {
  isError?: boolean;
  content?: { text: string }[];
  tools?: { name: string }[];
} {
  const line = text.split('\n').find((l) => l.startsWith('data: ')) ?? 'data: {}';
  return (JSON.parse(line.slice(6)) as { result: never }).result;
}

async function openSession(token: string): Promise<string> {
  const init = await mcp(token, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 't', version: '1' },
    },
  });
  expect(init.status).toBe(200);
  const session = init.headers['mcp-session-id'] as string;
  await mcp(token, { jsonrpc: '2.0', method: 'notifications/initialized' }, session);
  return session;
}

describe('roles over MCP', () => {
  it('rejects an unknown token on /mcp', async () => {
    expect((await mcp('nope', { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401);
  });

  it('viewer sees and may call read-only tools only', async () => {
    const session = await openSession(VIEWER.token);
    const list = rpcResult(
      (
        await mcp(
          VIEWER.token,
          { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
          session,
        )
      ).text,
    );
    const names = (list.tools ?? []).map((t) => t.name);
    expect(names).not.toContain('add_box');
    expect(names).toContain('search_tools');
    const call = rpcResult(
      (
        await mcp(
          VIEWER.token,
          {
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: { name: 'add_box', arguments: { size: [1, 1, 1] } },
          },
          session,
        )
      ).text,
    );
    expect(call.isError).toBe(true);
    expect(call.content?.[0]?.text).toMatch(/Forbidden.*viewer/);
  });

  it('editor mutates, and another user cannot reuse the session', async () => {
    const session = await openSession(EDITOR.token);
    const call = rpcResult(
      (
        await mcp(
          EDITOR.token,
          {
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: { name: 'add_box', arguments: { size: [1, 1, 1] } },
          },
          session,
        )
      ).text,
    );
    expect(call.isError).toBe(false);
    const stolen = await mcp(
      VIEWER.token,
      { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} },
      session,
    );
    expect(stolen.status).toBe(403);
  });
});
