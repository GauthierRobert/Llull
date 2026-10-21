/** Local vault (09 PLM M3, VC-PLM-23): content-addressed objects, refs, O_EXCL locks with lease, audited break, check-in / check-out, externalized snapshots. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { EXIT_OK } from '../src/cli/main';
import { runVault } from '../src/cli/vault';
import { serverContext } from '../src/fea/context';
import { verifyAuditChain } from '../src/plm/auditChain';
import { buildReleasePackage } from '../src/plm/releasePackage';
import { acquireLock, readLock } from '../src/plm/vault/locks';
import { createObjectStore } from '../src/plm/vault/objectStore';
import { sha256Hex } from '../src/sha256';
import {
  VaultError,
  breakItemLock,
  checkIn,
  checkOut,
  currentHolder,
  initVault,
  itemStatus,
  openVault,
  readRefs,
  renew,
  verifyVault,
} from '../src/plm/vault/vault';
import { inWork, released } from '../../tests/unit/plm/fixtures';
import { type TestHome, testHome } from './plmTestSupport';
import { parseArgv } from '../src/cli/argv';

let home: TestHome;
let root = '';
beforeEach(() => {
  home = testHome();
  root = path.join(home.dir, 'vault');
});
afterEach(() => home.cleanup());

const NOW = new Date('2026-11-02T09:00:00Z');
const later = (hours: number): Date => new Date(NOW.getTime() + hours * 3600_000);
const sessionA = { ...currentHolder({ LLULL_USER: 'alice' }, 'desk-A') };
const sessionB = { ...currentHolder({ LLULL_USER: 'bob' }, 'desk-B') };

describe('object store', () => {
  it('stores by SHA-256, is idempotent, read-only, and a damaged object reads as absent', () => {
    const store = createObjectStore(root);
    const sha = store.put('{"a":1}');
    expect(sha).toBe(sha256Hex('{"a":1}'));
    expect(store.put('{"a":1}')).toBe(sha);
    expect(store.get(sha)).toBe('{"a":1}');
    expect(store.has(sha)).toBe(true);
    expect(store.verify()).toEqual({ checked: 1, damaged: [] });
    const file = path.join(root, 'objects', sha.slice(0, 2), sha.slice(2));
    chmodSync(file, 0o644);
    writeFileSync(file, '{"a":2}');
    expect(store.get(sha)).toBeNull();
    expect(store.verify().damaged).toEqual([sha]);
    expect(store.put('{"a":1}')).toBe(sha);
    expect(store.get(sha)).toBe('{"a":1}');
  });

  it('refuses names that are not a SHA-256 (no path traversal)', () => {
    const store = createObjectStore(root);
    for (const name of ['../vault.json', 'ab/cd', '', 'A'.repeat(64)]) {
      expect(store.get(name)).toBeNull();
      expect(store.has(name)).toBe(false);
    }
  });
});

describe('locks (VC-PLM-23, AC-15)', () => {
  it('two sessions: B cannot check out what A holds (PLM_VAULT_LOCKED names the holder); A check-in frees it', () => {
    const vault = initVault(root);
    const doc = inWork();
    expect(checkOut(vault, 'LL-2001', sessionA, NOW).document).toBeNull();
    let refused: unknown;
    try {
      checkOut(vault, 'LL-2001', sessionB, later(1));
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(VaultError);
    expect(refused).toMatchObject({ code: 'PLM_VAULT_LOCKED', holder: { userId: 'alice', session: 'desk-A' } });
    expect((refused as Error).message).toContain('alice');
    expect(() => checkIn(vault, doc, sessionB, later(1))).toThrow(/checked out by alice/);
    checkIn(vault, doc, sessionA, later(1));
    expect(readLock(root, 'LL-2001')).toBeNull();
    expect(checkOut(vault, 'LL-2001', sessionB, later(2)).document).not.toBeNull();
  });

  it('the same session renews its lease instead of failing', () => {
    const vault = initVault(root);
    const first = checkOut(vault, 'LL-2001', sessionA, NOW);
    const again = checkOut(vault, 'LL-2001', sessionA, later(4));
    expect(Date.parse(again.lock.leaseUntil)).toBeGreaterThan(Date.parse(first.lock.leaseUntil));
    expect(renew(vault, 'LL-2001', sessionA, later(5)).holder.userId).toBe('alice');
    expect(() => renew(vault, 'LL-2001', sessionB, later(5))).toThrow(/not checked out by you/);
  });

  it('a live lock cannot be broken by another; a stale one (lease expired, process gone) can, and the break is audited', () => {
    const vault = initVault(root);
    const dead = { ...sessionA, pid: 2 ** 22 - 7 };
    expect(acquireLock(root, 'LL-2001', dead, NOW).ok).toBe(true);
    expect(() => breakItemLock(vault, 'LL-2001', sessionB, later(1))).toThrow(/PLM_VAULT_LOCKED|checked out by alice/);
    expect(readLock(root, 'LL-2001')).not.toBeNull();
    expect(itemStatus(vault, 'LL-2001', later(9), dead.host).lock?.stale).toBe(true);
    const broken = breakItemLock(vault, 'LL-2001', sessionB, later(9));
    expect(broken.holder.userId).toBe('alice');
    expect(readLock(root, 'LL-2001')).toBeNull();
    const verdict = verifyAuditChain(path.join(root, 'audit'));
    expect(verdict.ok).toBe(true);
    const log = readFileSync(path.join(root, 'audit', 'audit-000001.jsonl'), 'utf8');
    expect(log).toContain('vault_break_lock');
    expect(log).toContain('"rejected":true');
  });

  it('a lock of another host expires by lease alone; the holder can always break its own', () => {
    const vault = initVault(root);
    const away = { ...sessionA, host: 'other-machine', pid: process.pid };
    acquireLock(root, 'LL-2001', away, NOW);
    expect(breakItemLock(vault, 'LL-2001', sessionB, later(9)).holder.host).toBe('other-machine');
    acquireLock(root, 'LL-2001', sessionA, NOW);
    expect(breakItemLock(vault, 'LL-2001', sessionA, NOW).holder.userId).toBe('alice');
    expect(() => breakItemLock(vault, 'LL-2001', sessionA, NOW)).toThrow(/not locked/);
  });

  it('a corrupt lock file blocks but anyone may break it (audited)', () => {
    const vault = initVault(root);
    mkdirSync(path.join(root, 'locks'), { recursive: true });
    writeFileSync(path.join(root, 'locks', 'LL-2001.lock'), '{not json');
    expect(() => checkOut(vault, 'LL-2001', sessionA, NOW)).toThrow(/unreadable lock/);
    expect(breakItemLock(vault, 'LL-2001', sessionB, NOW).holder.name).toBe('unreadable lock');
  });
});

describe('check-in / check-out and externalized snapshots (M3)', () => {
  it('check-in checkpoints an in_work item, stores the head and records the iteration', () => {
    const vault = initVault(root);
    checkOut(vault, 'LL-2001', sessionA, NOW);
    const done = checkIn(vault, inWork(), sessionA, NOW);
    expect(done.revision).toBe('A');
    expect(readRefs(vault, 'LL-2001')?.head).toBe(done.head);
    expect(vault.objects.get(done.head)).toBe(serializeDocument(done.document));
    const again = checkOut(vault, 'LL-2001', sessionB, later(1));
    expect(again.document).toBe(serializeDocument(done.document));
  });

  it('moves the frozen snapshot into the vault: the document keeps only the reference, every command still works with the vault port', () => {
    const vault = initVault(root);
    const doc = released();
    const inline = doc.plm?.item.revisions['A']?.snapshot;
    expect(inline?.kind).toBe('inline');
    checkOut(vault, 'LL-2001', sessionA, NOW);
    const done = checkIn(vault, doc, sessionA, NOW);
    const frozen = done.document.plm?.item.revisions['A'];
    expect(frozen?.snapshot).toEqual({ kind: 'vault', objectSha256: frozen?.contentHash });
    expect(JSON.stringify(done.document)).not.toContain('"canonicalJson"');
    expect(vault.objects.get(frozen?.contentHash ?? '')).toBe(inline?.kind === 'inline' ? inline.canonicalJson : '');
    expect(readRefs(vault, 'LL-2001')?.revisions['A']).toMatchObject({ state: 'released', contentHash: frozen?.contentHash });
    expect(existsSync(path.join(root, 'items', 'LL-2001', 'A', 'manifest.json'))).toBe(true);
    const ctx = { ...defaultContext(), objects: vault.objects };
    expect(execute(done.document, 'verify_release', { revision: 'A' }, ctx).summary).toContain('verified');
    expect(execute(done.document, 'view_revision', { revision: 'A' }, ctx).rejected).toBeUndefined();
    expect(execute(done.document, 'plm_status', {}, ctx).data).toMatchObject({ integrity: { A: 'ok' } });
    const lost = execute(done.document, 'verify_release', { revision: 'A' }, defaultContext());
    expect(lost.error?.code).toBe('PLM_VAULT_OBJECT_MISSING');
    expect(execute(done.document, 'view_revision', { revision: 'A' }, defaultContext()).error?.code).toBe('PLM_VAULT_OBJECT_MISSING');
    expect(execute(done.document, 'plm_diff', { from: 'A', to: 'WORKING' }, defaultContext()).error?.code).toBe('PLM_NO_SNAPSHOT');
    expect(verifyVault(vault)).toMatchObject({ ok: true });
  });

  it('a package of an externalized revision is built from the vault object, and refused without it', () => {
    const vault = initVault(root);
    checkOut(vault, 'LL-2001', sessionA, NOW);
    const done = checkIn(vault, released(), sessionA, NOW);
    expect(typeof buildReleasePackage(done.document, 'A', 't', null)).toBe('string');
    const pack = buildReleasePackage(done.document, 'A', 't', vault.objects);
    expect(typeof pack).toBe('object');
    expect(typeof pack === 'object' && pack.files[0]?.content.length).toBeGreaterThan(100);
  });

  it('released history cannot change in the vault: a frozen revision with another hash is refused and nothing is written', () => {
    const vault = initVault(root);
    checkOut(vault, 'LL-2001', sessionA, NOW);
    const done = checkIn(vault, released(), sessionA, NOW);
    checkOut(vault, 'LL-2001', sessionA, later(1));
    const forged: CadDocument = {
      ...done.document,
      plm: {
        ...(done.document.plm as NonNullable<CadDocument['plm']>),
        item: {
          ...(done.document.plm as NonNullable<CadDocument['plm']>).item,
          revisions: {
            A: {
              ...(done.document.plm?.item.revisions['A'] as NonNullable<CadDocument['plm']>['item']['revisions'][string]),
              contentHash: 'f'.repeat(64),
            },
          },
        },
      },
    };
    const before = readFileSync(path.join(root, 'items', 'LL-2001', 'refs.json'), 'utf8');
    expect(() => checkIn(vault, forged, sessionA, later(2))).toThrow(/released history cannot change/);
    expect(readFileSync(path.join(root, 'items', 'LL-2001', 'refs.json'), 'utf8')).toBe(before);
    expect(readLock(root, 'LL-2001')).not.toBeNull();
  });

  it('refuses an unmanaged document and a missing lock; a damaged object is found by verify', () => {
    const vault = initVault(root);
    expect(() => checkIn(vault, createEmptyDocument(), sessionA, NOW)).toThrow(/managed item/);
    expect(() => checkIn(vault, inWork(), sessionA, NOW)).toThrow(/not checked out by you/);
    checkOut(vault, 'LL-2001', sessionA, NOW);
    const done = checkIn(vault, inWork(), sessionA, NOW);
    const file = path.join(root, 'objects', done.head.slice(0, 2), done.head.slice(2));
    chmodSync(file, 0o644);
    writeFileSync(file, 'tampered');
    const verdict = verifyVault(vault);
    expect(verdict.ok).toBe(false);
    expect(verdict.findings.join(' ')).toContain('damaged');
  });

  it('part numbers with a slash get a safe folder; init is idempotent; a folder without vault.json is not a vault', () => {
    const vault = initVault(root);
    expect(initVault(root).dir).toBe(vault.dir);
    checkOut(vault, 'LL/2001', sessionA, NOW);
    expect(existsSync(path.join(root, 'locks', 'LL%2F2001.lock'))).toBe(true);
    expect(() => openVault(path.join(home.dir, 'nowhere'))).toThrow(/not an llull vault/);
  });

  it('the server context exposes the vault objects when LLULL_VAULT points at one', () => {
    initVault(root);
    expect(serverContext().objects).toBeNull();
    process.env['LLULL_VAULT'] = root;
    try {
      expect(serverContext().objects).not.toBeNull();
    } finally {
      delete process.env['LLULL_VAULT'];
    }
  });
});

describe('llull vault (CLI)', () => {
  const io = (): { out: string[]; err: string[]; cli: (...argv: string[]) => number } => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      cli: (...argv) =>
        runVault(parseArgv(['vault', ...argv, '--vault', root, '--session', 'desk-A']), {
          stdout: (text) => out.push(text),
          stderr: (text) => err.push(text),
          env: { LLULL_USER: 'alice' },
        }),
    };
  };

  it('init, checkout of a new item, checkin of the document, status, then checkout again into an empty file', () => {
    const { out, err, cli } = io();
    const file = path.join(home.dir, 'part.llull.json');
    expect(cli('init')).toBe(EXIT_OK);
    expect(cli('checkout', 'LL-2001', '--doc', file)).toBe(EXIT_OK);
    expect(out.join('\n')).toContain('new to this vault');
    writeFileSync(file, serializeDocument(released()));
    expect(cli('checkin', '--doc', file)).toBe(EXIT_OK);
    expect(deserializeDocument(readFileSync(file, 'utf8')).plm?.item.revisions['A']?.snapshot?.kind).toBe('vault');
    expect(cli('status', '--json')).toBe(EXIT_OK);
    expect(out.at(-1)).toContain('"LL-2001"');
    expect(cli('checkout', 'LL-2001', '--doc', file)).toBe(2);
    expect(err.join('\n')).toContain('already exists');
    expect(cli('checkout', 'LL-2001', '--doc', file, '--force')).toBe(EXIT_OK);
    expect(cli('verify')).toBe(EXIT_OK);
    expect(cli('renew', 'LL-2001')).toBe(EXIT_OK);
  });

  it('prints the stable refusal code and a usage error for a missing vault or action', () => {
    const { err, cli } = io();
    cli('init');
    expect(cli('checkout', 'LL-9')).toBe(EXIT_OK);
    const other = runVault(parseArgv(['vault', 'checkout', 'LL-9', '--vault', root, '--session', 'desk-B']), {
      stdout: () => undefined,
      stderr: (text) => err.push(text),
      env: { LLULL_USER: 'bob' },
    });
    expect(other).toBe(1);
    expect(err.join('\n')).toContain('PLM_VAULT_LOCKED');
    expect(cli('frobnicate')).toBe(2);
    expect(runVault(parseArgv(['vault', 'status']), { stdout: () => undefined, stderr: (t) => err.push(t), env: {} })).toBe(2);
    expect(cli('break-lock', 'LL-9')).toBe(EXIT_OK);
    expect(cli('checkin', '--doc', path.join(home.dir, 'missing.json'))).toBe(2);
  });
});
