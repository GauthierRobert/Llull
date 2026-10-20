/** Hash-chained audit log and the host command runner (09 PLM VC-PLM-21, TR-PLM-05, TR-PLM-16). */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type AuditEvent, auditDir, createAuditLog, paramsHash, verifyAuditChain } from '../src/plm/auditChain';
import { AGENT, HUMAN, callerOf, fillHostParams, isoSeconds, runHostCommand } from '../src/plm/hostRun';
import { createEmptyDocument } from '@core/model/types';
import { applyCommand, _resetHistory } from '../src/commandBus';
import { _resetLiveDoc, getLiveDoc } from '../src/liveDocument';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'llull-audit-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const event = (command: string): AuditEvent => ({
  ts: '2026-11-02T09:00:00.000Z',
  caller: 'agent',
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
    expect(verifyAuditChain(dir)).toEqual({ ok: true, entries: 2 });
    expect(createAuditLog(dir).append(event('c')).seq).toBe(3);
    expect(verifyAuditChain(dir).entries).toBe(3);
    expect(verifyAuditChain(path.join(dir, 'missing'))).toEqual({ ok: true, entries: 0 });
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
    expect(verifyAuditChain(dir)).toMatchObject({ ok: false, brokenAt: { line: 3, reason: 'not valid JSON' } });
    const stale = JSON.parse(lines[1] as string) as Record<string, unknown>;
    writeFileSync(file, `${[lines[0], JSON.stringify({ ...stale, seq: 9 })].join('\n')}\n`);
    expect(verifyAuditChain(dir).ok).toBe(false);
  });

  it('rotation starts a new segment, never deletes, and the chain continues across files', () => {
    const log = createAuditLog(dir, 1);
    for (const command of ['a', 'b', 'c']) log.append(event(command));
    expect(readdirSync(dir).sort()).toEqual(['audit-000001.jsonl', 'audit-000002.jsonl', 'audit-000003.jsonl']);
    expect(verifyAuditChain(dir)).toEqual({ ok: true, entries: 3 });
    rmSync(path.join(dir, 'audit-000002.jsonl'));
    expect(verifyAuditChain(dir).ok).toBe(false);
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
  it('fills the time and user a command declares, never overrides, and reads the caller from the request', () => {
    const now = new Date('2026-11-02T09:30:00.123Z');
    expect(isoSeconds(now)).toBe('2026-11-02T09:30:00Z');
    const human = fillHostParams('submit_for_review', {}, { kind: 'human', userId: 'u-9' }, now);
    expect(human).toEqual({ at: '2026-11-02T09:30:00Z', by: 'u-9' });
    expect(fillHostParams('submit_for_review', { by: 'u-1', at: '2026-01-01T00:00:00Z' }, HUMAN, now, {})).toEqual({
      by: 'u-1',
      at: '2026-01-01T00:00:00Z',
    });
    expect(fillHostParams('submit_for_review', {}, AGENT, now)).toMatchObject({ by: 'agent' });
    expect(fillHostParams('set_item_marking', { regime: 'none' }, { kind: 'human', userId: 'u-3' }, now)).toMatchObject({
      decidedBy: 'u-3',
    });
    expect(fillHostParams('submit_for_review', {}, HUMAN, now, { LLULL_USER: 'alice' })).toMatchObject({ by: 'alice' });
    expect(fillHostParams('add_box', { size: [1, 1, 1] }, HUMAN, now)).toEqual({ size: [1, 1, 1] });
    expect(fillHostParams('no_such_command', 5, HUMAN, now)).toBe(5);
    expect(callerOf('human')).toBe(HUMAN);
    expect(callerOf('agent')).toBe(AGENT);
    expect(callerOf(undefined)).toBe(AGENT);
  });

  it('audits mutations and refusals (not successful queries) with caller kind, canonical params hash and error code', () => {
    const env = { LLULL_AUDIT_DIR: dir };
    const options = { source: 'rest', env, now: () => new Date('2026-11-02T09:30:00Z') };
    let doc = createEmptyDocument();
    doc = runHostCommand(
      doc,
      'set_item_identity',
      { partNumber: 'LL-1', name: 'n', itemType: 'part', policy: { humanSignatureRequired: false } },
      { ...options, caller: HUMAN },
    ).document;
    runHostCommand(doc, 'plm_status', {}, { ...options, caller: AGENT });
    const refused = runHostCommand(doc, 'record_approval', { role: 'checker', userId: 'u-2' }, { ...options, caller: AGENT });
    expect(refused.outcome.error?.code).toBe('PLM_HUMAN_GATE');
    const submitted = runHostCommand(doc, 'submit_for_review', {}, { ...options, caller: AGENT });
    expect(submitted.params).toEqual({ at: '2026-11-02T09:30:00Z', by: 'agent' });
    const entries = readFileSync(path.join(dir, 'audit-000001.jsonl'), 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as { command: string; caller: string; rejected: boolean; errorCode?: string; changed: boolean });
    expect(entries.map((entry) => [entry.command, entry.caller, entry.rejected])).toEqual([
      ['set_item_identity', 'human', false],
      ['record_approval', 'agent', true],
      ['submit_for_review', 'agent', false],
    ]);
    expect(entries[1]?.errorCode).toBe('PLM_HUMAN_GATE');
    expect(verifyAuditChain(dir).ok).toBe(true);
  });

  it('the command bus passes the caller and replays filled params to live sync', () => {
    _resetLiveDoc();
    _resetHistory();
    applyCommand(
      'set_item_identity',
      { partNumber: 'LL-2', name: 'n', itemType: 'part', policy: { humanSignatureRequired: false } },
      undefined,
      'rest',
      HUMAN,
    );
    const agent = applyCommand('record_approval', { role: 'checker', userId: 'u' });
    expect(agent.isError).toBe(true);
    const submit = applyCommand('submit_for_review', {}, undefined, 'rest', HUMAN);
    expect(submit.isError).toBe(false);
    expect(getLiveDoc().plm?.item.revisions['A']?.state).toBe('in_review');
    expect(existsSync(dir)).toBe(true);
  });
});
