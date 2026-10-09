/**
 * @layer server/tests
 * Per-user audit trail: JSONL lines (REST + MCP + undo), params hashed, rotation, admin query.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import path from 'path';
import { app } from '../src/index';
import { _resetLiveDoc } from '../src/liveDocument';
import { _resetHistory, applyCommand } from '../src/commandBus';
import { appendAudit, type AuditEntry } from '../src/audit';
import {
  ADMIN,
  EDITOR,
  VIEWER,
  clearEnv,
  installUsersFile,
  sha256,
  tempDir,
} from './userTestSupport';

const bearer = (token: string): [string, string] => ['Authorization', `Bearer ${token}`];
let dir: string;
let auditFile: string;

const lines = (file = auditFile): AuditEntry[] =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as AuditEntry);

beforeEach(() => {
  dir = tempDir();
  auditFile = path.join(dir, 'audit.jsonl');
  process.env['LLULL_AUDIT_FILE'] = auditFile;
  installUsersFile(dir, [ADMIN, EDITOR, VIEWER]);
  _resetLiveDoc();
  _resetHistory();
});
afterEach(() => {
  clearEnv();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('audit trail', () => {
  it('writes a line per applied REST command with user, hash and log position', async () => {
    const params = { size: [2, 2, 2] };
    const res = await request(app)
      .post('/command')
      .set(...bearer(EDITOR.token))
      .send({ name: 'add_box', params });
    const [entry] = lines();
    expect(lines()).toHaveLength(1);
    expect(entry).toMatchObject({
      userId: 'ed',
      userName: 'Ed Editor',
      source: 'rest',
      command: 'add_box',
      paramsSha256: sha256(JSON.stringify(params)),
      affectedCount: res.body.affected.length,
      summary: res.body.summary,
    });
    expect(typeof entry?.epoch).toBe('string');
    expect(entry?.seq).toBe(1);
    expect(Date.parse(entry?.ts ?? '')).not.toBeNaN();
  });

  it('skips queries, rejected commands and denied requests; records undo', async () => {
    await request(app)
      .post('/command')
      .set(...bearer(VIEWER.token))
      .send({ name: 'add_box', params: { size: [1, 1, 1] } });
    await request(app)
      .post('/command')
      .set(...bearer(EDITOR.token))
      .send({ name: 'add_box', params: { size: 'bad' } });
    expect(fs.existsSync(auditFile)).toBe(false);
    await request(app)
      .post('/command')
      .set(...bearer(EDITOR.token))
      .send({ name: 'add_box', params: { size: [1, 1, 1] } });
    await request(app)
      .post('/undo')
      .set(...bearer(EDITOR.token));
    expect(lines().map((l) => l.command)).toEqual(['add_box', 'undo']);
  });

  it('attributes MCP tool calls with source mcp', async () => {
    const init = await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .set(...bearer(EDITOR.token))
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 't', version: '1' },
        },
      });
    const session = init.headers['mcp-session-id'] as string;
    await request(app)
      .post('/mcp')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json, text/event-stream')
      .set('mcp-session-id', session)
      .set(...bearer(EDITOR.token))
      .send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'add_box', arguments: { size: [1, 1, 1] } },
      });
    expect(lines()[0]).toMatchObject({ userId: 'ed', source: 'mcp', command: 'add_box' });
  });

  it('records anonymous actors outside named-user mode', () => {
    delete process.env['LLULL_USERS_FILE'];
    applyCommand('add_box', { size: [1, 1, 1] });
    expect(lines()[0]).toMatchObject({ userId: 'anonymous', source: 'rest' });
  });

  it('rotates by size and keeps a bounded number of files', () => {
    process.env['LLULL_AUDIT_MAX_BYTES'] = '600';
    process.env['LLULL_AUDIT_KEEP'] = '2';
    for (let i = 0; i < 12; i += 1) {
      appendAudit({
        ts: new Date().toISOString(),
        userId: 'u',
        userName: 'U',
        source: 'rest',
        command: `c${i}`,
        paramsSha256: 'x'.repeat(64),
        summary: 's',
        affectedCount: 0,
        epoch: 'e',
        seq: i,
      });
    }
    expect(fs.existsSync(`${auditFile}.1`)).toBe(true);
    expect(fs.existsSync(`${auditFile}.2`)).toBe(true);
    expect(fs.existsSync(`${auditFile}.3`)).toBe(false);
    expect(fs.statSync(auditFile).size).toBeLessThanOrEqual(600);
    expect(lines().at(-1)?.command).toBe('c11');
  });
});

describe('GET /admin/audit', () => {
  it('is admin-only and filters by user, since and limit', async () => {
    for (const user of [EDITOR, ADMIN, EDITOR]) {
      await request(app)
        .post('/command')
        .set(...bearer(user.token))
        .send({ name: 'add_box', params: { size: [1, 1, 1] } });
    }
    expect(
      (
        await request(app)
          .get('/admin/audit')
          .set(...bearer(EDITOR.token))
      ).status,
    ).toBe(403);
    const all = await request(app)
      .get('/admin/audit')
      .set(...bearer(ADMIN.token));
    expect(all.body.count).toBe(3);
    const byUser = await request(app)
      .get('/admin/audit?user=ed')
      .set(...bearer(ADMIN.token));
    expect(byUser.body.entries.map((e: AuditEntry) => e.userId)).toEqual(['ed', 'ed']);
    const limited = await request(app)
      .get('/admin/audit?limit=1')
      .set(...bearer(ADMIN.token));
    expect(limited.body.entries).toHaveLength(1);
    const future = await request(app)
      .get('/admin/audit?since=2999-01-01T00:00:00Z')
      .set(...bearer(ADMIN.token));
    expect(future.body.count).toBe(0);
    const bad = await request(app)
      .get('/admin/audit?since=garbage')
      .set(...bearer(ADMIN.token));
    expect(bad.status).toBe(400);
  });
});
