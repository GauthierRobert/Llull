/** DocumentSession against a recording fake backend: the order of recovery calls around open / save / new (A-08). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createEmptyDocument } from '@core/model/types';
import { serializeDocument } from '@core/commands/persistence/serialization';
import type { FetchLike } from '@server/restClient';
import { DocumentLockedError, lockPathOf, releaseAllDocumentLocks } from '@server/documentLock';
import { SaveConflictError } from '@server/documentFile';
import { createDocumentSession } from '../src/documents';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'llull-session-'));
});
afterEach(() => {
  releaseAllDocumentLocks();
  rmSync(dir, { recursive: true, force: true });
});

interface Fake {
  readonly fetchImpl: FetchLike;
  readonly calls: string[];
}

const baseOf = (text: string): { baseSha256: string; baseSize: number } => ({
  baseSha256: createHash('sha256').update(text, 'utf8').digest('hex'),
  baseSize: Buffer.byteLength(text, 'utf8'),
});

interface FakeSlot {
  readonly meta: { id: string; path: string | null; changedAt: string; baseSha256?: string | null };
  readonly json: string;
}

function fakeBackend(slots: Record<string, FakeSlot> = {}): Fake {
  const calls: string[] = [];
  let hash = 'h0';
  const json = (body: unknown): Promise<Response> =>
    Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  const fetchImpl: FetchLike = (url, init) => {
    const route = new URL(url).pathname;
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (route === '/live/snapshot') return json({ stateHash: hash, document: createEmptyDocument() });
    if (route === '/command') {
      calls.push(`command:${String(body['name'])}`);
      const params = body['params'] as { json?: string } | undefined;
      if (body['name'] === 'load_document' && params?.json !== undefined && !params.json.startsWith('{'))
        return json({ summary: 'load_document rejected: not a document', affected: [], isError: true, changed: false });
      hash = `h-${String(body['name'])}`;
      return json({ summary: 'ok', affected: [], isError: false, changed: true });
    }
    if (route.startsWith('/recovery/') && init.method === 'GET') {
      const slot = slots[decodeURIComponent(route.slice('/recovery/'.length))];
      return slot === undefined ? Promise.resolve(new Response('{}', { status: 404 })) : json(slot);
    }
    calls.push(`${route.slice(1)}:${JSON.stringify(body)}`);
    return json({ ok: true });
  };
  return { fetchImpl, calls };
}

describe('DocumentSession recovery calls', () => {
  it('open holds A slot BEFORE loading (B never lands in it), binds B only after the load succeeded, then marks it saved', async () => {
    const backend = fakeBackend();
    const session = createDocumentSession({ url: 'http://127.0.0.1:1', token: 't', fetchImpl: backend.fetchImpl });
    const file = path.join(dir, 'B.llull');
    const text = serializeDocument(createEmptyDocument());
    writeFileSync(file, text);
    await session.open(file);
    expect(backend.calls).toEqual([
      'recovery/hold:{}',
      'command:load_document',
      `recovery/bind:${JSON.stringify({ path: file, dropPrevious: true, ...baseOf(text) })}`,
      `recovery/saved:${JSON.stringify({ stateHash: 'h-load_document', ...baseOf(text) })}`,
    ]);
  });

  it('new document binds an untitled slot after the clear; Save As moves the binding to the new file and marks it saved', async () => {
    const backend = fakeBackend();
    const session = createDocumentSession({ url: 'http://127.0.0.1:1', token: 't', fetchImpl: backend.fetchImpl });
    await session.newDocument();
    expect(backend.calls).toEqual([
      'recovery/hold:{}',
      'command:clear_document',
      `recovery/bind:${JSON.stringify({ path: null, dropPrevious: true })}`,
    ]);
    backend.calls.length = 0;
    const file = path.join(dir, 'C.llull');
    await session.save(file);
    const written = baseOf(readFileSync(file, 'utf8'));
    expect(backend.calls).toEqual([
      `recovery/bind:${JSON.stringify({ path: file, dropPrevious: true, ...written })}`,
      `recovery/saved:${JSON.stringify({ stateHash: 'h-clear_document', ...written })}`,
    ]);
    backend.calls.length = 0;
    await session.save(); // same file: no rebind
    expect(backend.calls.map((call) => call.split(':')[0])).toEqual(['recovery/saved']);
  });

  it('a recovery call that fails never stops the document operation', async () => {
    const backend = fakeBackend();
    const failing: FetchLike = (url, init) =>
      new URL(url).pathname.startsWith('/recovery') ? Promise.reject(new Error('down')) : backend.fetchImpl(url, init);
    const session = createDocumentSession({ url: 'http://127.0.0.1:1', token: 't', fetchImpl: failing });
    const file = path.join(dir, 'D.llull');
    await expect(session.save(file)).resolves.toBe(file);
  });
});

describe('DocumentSession file lock and save conflict (A-09)', () => {
  it('holds the lock file while a document is open and frees it for New / another document', async () => {
    const session = createDocumentSession({ url: 'http://127.0.0.1:1', token: 't', fetchImpl: fakeBackend().fetchImpl });
    const first = path.join(dir, 'A.llull');
    const second = path.join(dir, 'B.llull');
    writeFileSync(first, serializeDocument(createEmptyDocument()));
    writeFileSync(second, serializeDocument(createEmptyDocument()));
    await session.open(first);
    expect(existsSync(lockPathOf(first))).toBe(true);
    await session.open(second);
    expect(existsSync(lockPathOf(first))).toBe(false);
    expect(existsSync(lockPathOf(second))).toBe(true);
    await session.newDocument();
    expect(existsSync(lockPathOf(second))).toBe(false);
  });

  it('refuses to open a file another process holds (DSF_DOC_LOCKED) and loads nothing', async () => {
    const backend = fakeBackend();
    const session = createDocumentSession({ url: 'http://127.0.0.1:1', token: 't', fetchImpl: backend.fetchImpl });
    const file = path.join(dir, 'A.llull');
    writeFileSync(file, serializeDocument(createEmptyDocument()));
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      await new Promise((resolve) => holder.once('spawn', resolve));
      writeFileSync(
        lockPathOf(file),
        JSON.stringify({ pid: holder.pid, host: hostname(), user: 'u', app: 'cli', since: '2026-11-05T09:00:00.000Z' }),
      );
      await expect(session.open(file)).rejects.toBeInstanceOf(DocumentLockedError);
      expect(backend.calls).toEqual([]);
      expect(session.currentPath()).toBeNull();
    } finally {
      holder.kill();
    }
  });

  it('Save after the file was modified on disk is refused (DSF_SAVE_CONFLICT) until the user chooses to overwrite', async () => {
    const session = createDocumentSession({ url: 'http://127.0.0.1:1', token: 't', fetchImpl: fakeBackend().fetchImpl });
    const file = path.join(dir, 'A.llull');
    writeFileSync(file, serializeDocument(createEmptyDocument()));
    await session.open(file);
    appendFileSync(file, ' '); // an external edit (another tool, a sync client)
    await expect(session.save()).rejects.toBeInstanceOf(SaveConflictError);
    await expect(session.save(undefined, { overwrite: true })).resolves.toBe(file);
    await expect(session.save()).resolves.toBe(file); // the overwrite refreshed what the session knows
  });
});

describe('DocumentSession replacing the open document (review 1, 2)', () => {
  it('a file that is not a document leaves A bound to its own slot: nothing is dropped or rebound, the hold is released', async () => {
    const backend = fakeBackend();
    const session = createDocumentSession({ url: 'http://127.0.0.1:1', token: 't', fetchImpl: backend.fetchImpl });
    const a = path.join(dir, 'A.llull');
    const bad = path.join(dir, 'B.llull');
    writeFileSync(a, serializeDocument(createEmptyDocument()));
    writeFileSync(bad, 'this is not json');
    await session.open(a);
    backend.calls.length = 0;
    await expect(session.open(bad)).rejects.toThrow(/rejected/);
    expect(backend.calls).toEqual(['recovery/hold:{}', 'command:load_document', 'recovery/release:{}']);
    expect(session.currentPath()).toBe(a);
    expect(existsSync(lockPathOf(a))).toBe(true);
    expect(existsSync(lockPathOf(bad))).toBe(false);
  });

  it('restoring a slot of another file: the session leaves A, Save then writes only the slot file, never A', async () => {
    const other = path.join(dir, 'other.llull');
    const original = serializeDocument(createEmptyDocument());
    writeFileSync(other, original);
    const slot: FakeSlot = {
      meta: { id: 'doc-other', path: other, changedAt: '2026-11-05T10:00:00.000Z', baseSha256: baseOf(original).baseSha256 },
      json: serializeDocument(createEmptyDocument()),
    };
    const backend = fakeBackend({ 'doc-other': slot });
    const session = createDocumentSession({ url: 'http://127.0.0.1:1', token: 't', fetchImpl: backend.fetchImpl });
    const a = path.join(dir, 'A.llull');
    writeFileSync(a, original);
    await session.open(a);
    backend.calls.length = 0;
    await session.restore('doc-other');
    expect(backend.calls).toEqual(['recovery/hold:{}', 'command:load_document', 'recovery/adopt:{"id":"doc-other"}']);
    expect(session.currentPath()).toBe(other);
    expect(existsSync(lockPathOf(a))).toBe(false);
    expect(existsSync(lockPathOf(other))).toBe(true);
    expect(await session.hasUnsavedChanges()).toBe(true);
    const aBefore = readFileSync(a, 'utf8');
    await session.save();
    expect(readFileSync(a, 'utf8')).toBe(aBefore);
  });

  it('restoring an untitled slot, or one whose file changed since, is path-less: Save needs Save As and A.llull stays as it was', async () => {
    const a = path.join(dir, 'A.llull');
    const changed = path.join(dir, 'changed.llull');
    writeFileSync(a, serializeDocument(createEmptyDocument()));
    writeFileSync(changed, serializeDocument(createEmptyDocument()));
    const slots: Record<string, FakeSlot> = {
      untitled: { meta: { id: 'untitled', path: null, changedAt: '2026-11-05T10:00:00.000Z' }, json: '{}' },
      stale: { meta: { id: 'stale', path: changed, changedAt: '2026-11-05T10:00:00.000Z', baseSha256: 'f'.repeat(64) }, json: '{}' }, // the file is not the base the slot started from
      nobase: { meta: { id: 'nobase', path: changed, changedAt: '2026-11-05T10:00:00.000Z', baseSha256: null }, json: '{}' },
    };
    const session = createDocumentSession({ url: 'http://127.0.0.1:1', token: 't', fetchImpl: fakeBackend(slots).fetchImpl });
    await session.open(a);
    const before = readFileSync(a, 'utf8');
    for (const id of ['untitled', 'stale', 'nobase']) {
      await session.restore(id);
      expect(session.currentPath()).toBeNull();
      expect(existsSync(lockPathOf(a))).toBe(false);
      await expect(session.save()).rejects.toThrow(/Save As/);
    }
    expect(readFileSync(a, 'utf8')).toBe(before);
    expect(existsSync(lockPathOf(changed))).toBe(false);
  });

  it('a file rewritten outside before the first edit is not the slot base: the restore is untitled and the file untouched', async () => {
    const f = path.join(dir, 'F.llull');
    const original = serializeDocument(createEmptyDocument());
    writeFileSync(f, original);
    const backend = fakeBackend();
    const session = createDocumentSession({ url: 'http://127.0.0.1:1', token: 't', fetchImpl: backend.fetchImpl });
    await session.open(f);
    const bound = backend.calls.find((call) => call.startsWith('recovery/bind:'));
    const base = JSON.parse((bound ?? '').slice('recovery/bind:'.length)) as { baseSha256: string };
    const external = serializeDocument(createEmptyDocument()) + ' ';
    writeFileSync(f, external); // someone else rewrites F before the first edit; the slot is then written "after" it
    const slot: FakeSlot = {
      meta: { id: 'doc-f', path: f, changedAt: new Date(Date.now() + 60_000).toISOString(), baseSha256: base.baseSha256 },
      json: '{}',
    };
    const restoring = createDocumentSession({ url: 'http://127.0.0.1:1', token: 't', fetchImpl: fakeBackend({ 'doc-f': slot }).fetchImpl });
    await restoring.restore('doc-f');
    expect(restoring.currentPath()).toBeNull();
    await expect(restoring.save()).rejects.toThrow(/Save As/);
    expect(readFileSync(f, 'utf8')).toBe(external);
  });

  it('a file that still equals the slot base keeps its path, and Save conflicts if it changes afterwards', async () => {
    const f = path.join(dir, 'K.llull');
    const text = serializeDocument(createEmptyDocument());
    writeFileSync(f, text);
    const slot: FakeSlot = {
      meta: { id: 'doc-k', path: f, changedAt: '2026-11-05T10:00:00.000Z', baseSha256: baseOf(text).baseSha256 },
      json: '{}',
    };
    const session = createDocumentSession({ url: 'http://127.0.0.1:1', token: 't', fetchImpl: fakeBackend({ 'doc-k': slot }).fetchImpl });
    await session.restore('doc-k');
    expect(session.currentPath()).toBe(f);
    appendFileSync(f, ' ');
    await expect(session.save()).rejects.toBeInstanceOf(SaveConflictError);
  });

  it('a slot whose file is locked by another process is restored path-less (never written over it)', async () => {
    const locked = path.join(dir, 'locked.llull');
    const lockedText = serializeDocument(createEmptyDocument());
    writeFileSync(locked, lockedText);
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      await new Promise((resolve) => holder.once('spawn', resolve));
      writeFileSync(
        lockPathOf(locked),
        JSON.stringify({ pid: holder.pid, host: hostname(), user: 'u', app: 'cli', since: '2026-11-05T09:00:00.000Z' }),
      );
      const slot: FakeSlot = {
        meta: { id: 's', path: locked, changedAt: '2026-11-05T10:00:00.000Z', baseSha256: baseOf(lockedText).baseSha256 },
        json: '{}',
      };
      const session = createDocumentSession({ url: 'http://127.0.0.1:1', token: 't', fetchImpl: fakeBackend({ s: slot }).fetchImpl });
      await session.restore('s');
      expect(session.currentPath()).toBeNull();
    } finally {
      holder.kill();
    }
  });

  it('a refused restore (unknown slot / document refused) changes nothing and releases the hold', async () => {
    const backend = fakeBackend({ bad: { meta: { id: 'bad', path: null, changedAt: '2026-11-05T10:00:00.000Z' }, json: 'nope' } });
    const session = createDocumentSession({ url: 'http://127.0.0.1:1', token: 't', fetchImpl: backend.fetchImpl });
    const a = path.join(dir, 'A.llull');
    writeFileSync(a, serializeDocument(createEmptyDocument()));
    await session.open(a);
    backend.calls.length = 0;
    await expect(session.restore('missing')).rejects.toThrow(/cannot be read/);
    await expect(session.restore('bad')).rejects.toThrow(/rejected/);
    expect(backend.calls).toEqual(['recovery/hold:{}', 'command:load_document', 'recovery/release:{}']);
    expect(session.currentPath()).toBe(a);
  });

  it('open reports DSF_LOCK_UNAVAILABLE when the folder takes no lock, and still opens', async () => {
    const session = createDocumentSession({ url: 'http://127.0.0.1:1', token: 't', fetchImpl: fakeBackend().fetchImpl });
    const file = path.join(dir, 'A.llull');
    writeFileSync(file, serializeDocument(createEmptyDocument()));
    const real = fs.writeFileSync.bind(fs);
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((target: fs.PathOrFileDescriptor, data: string, ...rest: unknown[]) => {
      if (String(target).endsWith('.tmp')) throw Object.assign(new Error('read-only'), { code: 'EROFS' });
      return (real as (...args: unknown[]) => void)(target, data, ...rest);
    }) as typeof fs.writeFileSync);
    try {
      await expect(session.open(file)).resolves.toEqual({ warning: 'DSF_LOCK_UNAVAILABLE' });
      expect(session.currentPath()).toBe(file);
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('DocumentSession finishing a replacement (second review 1d)', () => {
  it('a bind that keeps failing is retried once, then the hold is released and the failure is surfaced', async () => {
    const backend = fakeBackend();
    const failing: FetchLike = (url, init) =>
      new URL(url).pathname === '/recovery/bind' ? Promise.reject(new Error('down')) : backend.fetchImpl(url, init);
    const warnings: string[] = [];
    const session = createDocumentSession({
      url: 'http://127.0.0.1:1',
      token: 't',
      fetchImpl: failing,
      onWarning: (text) => warnings.push(text),
    });
    const file = path.join(dir, 'F.llull');
    writeFileSync(file, serializeDocument(createEmptyDocument()));
    await session.open(file);
    expect(backend.calls.map((call) => call.split(':')[0])).toEqual(['recovery/hold', 'command', 'recovery/release', 'recovery/saved']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/recovery bind failed/);
  });

  it('a finishing call that fails once and then succeeds is not a warning', async () => {
    const backend = fakeBackend();
    let failures = 1;
    const flaky: FetchLike = (url, init) => {
      if (new URL(url).pathname === '/recovery/bind' && failures-- > 0) return Promise.resolve(new Response('{}', { status: 500 }));
      return backend.fetchImpl(url, init);
    };
    const warnings: string[] = [];
    const session = createDocumentSession({
      url: 'http://127.0.0.1:1',
      token: 't',
      fetchImpl: flaky,
      onWarning: (text) => warnings.push(text),
    });
    const file = path.join(dir, 'G.llull');
    writeFileSync(file, serializeDocument(createEmptyDocument()));
    await session.open(file);
    expect(backend.calls.filter((call) => call.startsWith('recovery/bind'))).toHaveLength(1);
    expect(warnings).toEqual([]);
  });
});
