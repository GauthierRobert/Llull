/** Hash-chained audit log and the host command runner (09 PLM VC-PLM-21, TR-PLM-05). */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type AuditEvent, appendSafely, auditDir, createAuditLog, paramsHash, verifyAuditChain } from '../src/plm/auditChain';
import { fillHostParams, isoSeconds, runHostCommand } from '../src/plm/hostRun';
import { createEmptyDocument } from '@core/model/types';
import { applyCommand, _resetHistory } from '../src/commandBus';
import { _resetLiveDoc, getLiveDoc } from '../src/liveDocument';
import { type TestHome, testHome } from './plmTestSupport';

let home: TestHome;
let dir = '';
beforeEach(() => {
  home = testHome();
  dir = path.join(home.dir, 'audit');
});
afterEach(() => home.cleanup());

const event = (command: string): AuditEvent => ({
  ts: '2026-11-02T09:00:00.000Z',
  source: 'cli',
  command,
  paramsSha256: paramsHash({ command }),
  summary: 'ok',
  changed: true,
  rejected: false,
  affectedCount: 1,
});

describe('audit chain', () => {
  it('chains entries and verifies an untouched log', () => {
    const log = createAuditLog(dir);
    const first = log.append(event('a'));
    const second = log.append(event('b'));
    expect(first.prevSha256).toBe('0'.repeat(64));
    expect(second.prevSha256).toBe(first.entrySha256);
    expect(verifyAuditChain(dir)).toEqual({ ok: true, entries: 2, repairs: 0 });
    expect(createAuditLog(dir).append(event('c')).seq).toBe(3);
    expect(verifyAuditChain(dir).entries).toBe(3);
    expect(verifyAuditChain(path.join(dir, 'missing'))).toEqual({ ok: true, entries: 0, repairs: 0 });
  });

  it('detects an edited, removed or reordered line at the right place', () => {
    const log = createAuditLog(dir);
    for (const command of ['a', 'b', 'c', 'd']) log.append(event(command));
    const file = path.join(dir, 'audit-000001.jsonl');
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
    writeFileSync(file, `${[lines[0], lines[1]?.replace('"b"', '"x"'), lines[2], lines[3]].join('\n')}\n`);
    expect(verifyAuditChain(dir)).toMatchObject({ ok: false, brokenAt: { line: 2, reason: expect.stringContaining('entrySha256') } });
    writeFileSync(file, `${[lines[0], lines[2], lines[3]].join('\n')}\n`);
    expect(verifyAuditChain(dir)).toMatchObject({ ok: false, brokenAt: { line: 2, reason: expect.stringContaining('prevSha256') } });
    writeFileSync(file, `${[lines[0], lines[1], '{broken', lines[3]].join('\n')}\n`);
    expect(verifyAuditChain(dir).ok).toBe(false);
    const stale = JSON.parse(lines[1] as string) as Record<string, unknown>;
    writeFileSync(file, `${[lines[0], JSON.stringify({ ...stale, seq: 9 })].join('\n')}\n`);
    expect(verifyAuditChain(dir).ok).toBe(false);
  });

  it('rotation starts a new segment, never deletes, and the chain continues across files', () => {
    const log = createAuditLog(dir, 1);
    for (const command of ['a', 'b', 'c']) log.append(event(command));
    expect(readdirSync(dir).sort()).toEqual(['audit-000001.jsonl', 'audit-000002.jsonl', 'audit-000003.jsonl']);
    expect(verifyAuditChain(dir)).toEqual({ ok: true, entries: 3, repairs: 0 });
    rmSync(path.join(dir, 'audit-000002.jsonl'));
    expect(verifyAuditChain(dir).ok).toBe(false);
  });

  it('a torn last line (crash during a write) is closed by a chain-break entry and the log keeps working', () => {
    const log = createAuditLog(dir);
    log.append(event('a'));
    appendFileSync(path.join(dir, 'audit-000001.jsonl'), '{"ts":"torn');
    expect(verifyAuditChain(dir).ok).toBe(true);
    const next = createAuditLog(dir).append(event('b'));
    expect(next.seq).toBe(3);
    expect(verifyAuditChain(dir)).toEqual({ ok: true, entries: 3, repairs: 1 });
    const lines = readFileSync(path.join(dir, 'audit-000001.jsonl'), 'utf8').split('\n');
    expect(lines.some((line) => line.includes('audit_chain_break'))).toBe(true);
    appendFileSync(path.join(dir, 'audit-000001.jsonl'), '{"torn\n{"torn2\n');
    expect(verifyAuditChain(dir).ok).toBe(false);
  });

  it('two writers on one directory (CLI + server) keep one chain: the second sees the first appends', () => {
    const first = createAuditLog(dir);
    const second = createAuditLog(dir);
    first.append(event('a'));
    second.append(event('b'));
    first.append(event('c'));
    second.append(event('d'));
    expect(verifyAuditChain(dir)).toEqual({ ok: true, entries: 4, repairs: 0 });
  });

  it('a stale lock left by a crashed process is broken; a live lock times out without corrupting the log', () => {
    const log = createAuditLog(dir);
    const lock = path.join(dir, 'audit.lock');
    writeFileSync(lock, '');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    expect(log.append(event('a')).seq).toBe(1);
    expect(readdirSync(dir)).not.toContain('audit.lock');
  });

  it('appendSafely never throws into the command being audited', () => {
    const unwritable = path.join(home.dir, 'file-not-dir');
    writeFileSync(unwritable, 'x');
    mkdirSync(dir, { recursive: true });
    const log = createAuditLog(dir);
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(dir, 'a file where the directory was');
    expect(appendSafely(log, event('a'))).toBeNull();
  });

  it('hashes params canonically (key order never matters)', () => {
    expect(paramsHash({ a: 1, b: { c: 2, d: 3 } })).toBe(paramsHash({ b: { d: 3, c: 2 }, a: 1 }));
    expect(paramsHash(undefined)).toBe(paramsHash(null));
  });

  it('is off in test runs unless LLULL_AUDIT_DIR is set', () => {
    expect(auditDir({ VITEST: '1' })).toBeNull();
    expect(auditDir({ LLULL_AUDIT_DIR: dir })).toBe(path.resolve(dir));
    expect(auditDir({})).toContain('.llull');
  });
});

describe('host runner', () => {
  it('fills the time and user a plm command declares, never overrides, and leaves other commands alone', () => {
    const now = new Date('2026-11-02T09:30:00.123Z');
    expect(isoSeconds(now)).toBe('2026-11-02T09:30:00Z');
    expect(fillHostParams('submit_for_review', {}, now, { LLULL_USER: 'alice' })).toEqual({ at: '2026-11-02T09:30:00Z', by: 'alice' });
    expect(fillHostParams('submit_for_review', { by: 'u-1', at: '2026-01-01T00:00:00Z' }, now, {})).toEqual({
      by: 'u-1',
      at: '2026-01-01T00:00:00Z',
    });
    expect(fillHostParams('add_box', { size: [1, 1, 1] }, now)).toEqual({ size: [1, 1, 1] });
    // add_door and edit_nurbs declare their own `at` / `by`: only the plm toolset is host-filled
    expect(fillHostParams('add_door', { wallId: 'w' }, now)).toEqual({ wallId: 'w' });
    expect(fillHostParams('edit_nurbs', { id: 'c' }, now)).toEqual({ id: 'c' });
    expect(fillHostParams('no_such_command', 5, now)).toBe(5);
    expect(fillHostParams('plm_status', {}, now)).toEqual({});
  });

  it('audits mutations and refusals (not successful queries) with the canonical params hash and error code, and never logs a signature', () => {
    const env = { ...home.env };
    const options = { source: 'rest', env, now: () => new Date('2026-11-02T09:30:00Z') };
    process.env['LLULL_USER'] = 'u-cli';
    let doc = createEmptyDocument();
    doc = runHostCommand(doc, 'set_item_identity', { partNumber: 'LL-1', name: 'n', itemType: 'part' }, options).document;
    runHostCommand(doc, 'plm_status', {}, options);
    const refused = runHostCommand(
      doc,
      'record_approval',
      { role: 'checker', confirmation: { alg: 'Ed25519', signature: 'SECRET-SIG', nonce: 'n' } },
      options,
    );
    expect(refused.outcome.error?.code).toBe('PLM_HUMAN_GATE');
    expect(JSON.stringify(refused.params)).not.toContain('SECRET-SIG');
    const submitted = runHostCommand(doc, 'submit_for_review', {}, options);
    expect(submitted.params).toEqual({ at: '2026-11-02T09:30:00Z', by: 'u-cli' });
    const text = readFileSync(path.join(dir, 'audit-000001.jsonl'), 'utf8');
    expect(text).not.toContain('SECRET-SIG');
    const entries = text
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as { command: string; rejected: boolean; errorCode?: string });
    expect(entries.map((entry) => [entry.command, entry.rejected])).toEqual([
      ['set_item_identity', false],
      ['record_approval', true],
      ['submit_for_review', false],
    ]);
    expect(entries[1]?.errorCode).toBe('PLM_HUMAN_GATE');
    expect(verifyAuditChain(dir).ok).toBe(true);
  });

  it('a broken audit directory never fails the command', () => {
    writeFileSync(path.join(home.dir, 'blocker'), 'x');
    const env = { ...home.env, LLULL_AUDIT_DIR: path.join(home.dir, 'blocker', 'nested') };
    const run = runHostCommand(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }, { source: 'rest', env });
    expect(run.outcome.isError).toBe(false);
  });

  it('the command bus replays the filled params to live sync and a request cannot claim to be human', () => {
    home.apply();
    _resetLiveDoc();
    _resetHistory();
    const claimed = applyCommand('record_approval', { role: 'checker', caller: 'human', userId: 'u' });
    expect(claimed.isError).toBe(true);
    const created = applyCommand('set_item_identity', { partNumber: 'LL-2', name: 'n', itemType: 'part' });
    expect(created.isError).toBe(false);
    const submit = applyCommand('submit_for_review', {});
    expect(submit.isError).toBe(false);
    expect(getLiveDoc().plm?.item.revisions['A']?.state).toBe('in_review');
    expect(verifyAuditChain(dir).entries).toBeGreaterThan(0);
  });
});
