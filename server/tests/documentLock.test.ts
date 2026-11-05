/** A-09: the lock file next to a document (DSF_DOC_LOCKED / DSF_LOCK_STALE) and the on-disk check at save (DSF_SAVE_CONFLICT), also through the `llull --doc` CLI. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setGeometryKernel } from '@core/geometry/kernel';
import { createManifoldKernel } from '@kernel-manifold/manifoldKernel';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { acquireDocumentLock, DocumentLockedError, lockPathOf, releaseAllDocumentLocks, type LockInfo } from '../src/documentLock';
import { readDocumentFile, SaveConflictError, stampOf, writeDocumentFile } from '../src/documentFile';
import { EXIT_COMMAND_ERROR, EXIT_OK, runCli, type CliIo } from '../src/cli/main';
import '../src/plugins';

let dir: string;
let file: string;
const children: ChildProcess[] = [];

beforeAll(async () => {
  setGeometryKernel(await createManifoldKernel());
});
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llull-lock-'));
  file = path.join(dir, 'part.llull');
});
afterEach(() => {
  releaseAllDocumentLocks();
  fs.rmSync(dir, { recursive: true, force: true });
});
afterAll(() => {
  for (const child of children) child.kill();
});

/** A live process that is not this one (a stand-in for the desktop app). */
async function liveOtherProcess(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  children.push(child);
  await new Promise((resolve) => child.once('spawn', resolve));
  return child.pid ?? 0;
}

/** A pid that certainly belonged to a process that has ended. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = child.pid ?? 0;
  await new Promise((resolve) => child.once('exit', resolve));
  return pid;
}

const writeLock = (info: Partial<LockInfo>): void =>
  fs.writeFileSync(
    lockPathOf(file),
    JSON.stringify({ pid: process.pid, host: os.hostname(), user: 'u', app: 'desktop', since: '2026-11-05T09:00:00.000Z', ...info }),
  );

function capture(): { io: CliIo; out: string[] } {
  const out: string[] = [];
  const io: CliIo = {
    stdout: (text) => out.push(text),
    stderr: () => undefined,
    readStdin: () => Promise.resolve(''),
    env: {},
    prepareKernel: () => Promise.resolve(),
  };
  return { io, out };
}

const addBox = (extra: string[] = []): Promise<number> =>
  runCli(['exec', 'add_box', '{"size":[1,1,1]}', '--doc', file, '--json', ...extra], capture().io);

describe('document lock file', () => {
  it('records pid, host, user, app and time next to the document, and release removes it', () => {
    const lock = acquireDocumentLock(file, 'desktop');
    const info = JSON.parse(fs.readFileSync(lockPathOf(file), 'utf8')) as LockInfo;
    expect(info).toMatchObject({ pid: process.pid, host: os.hostname(), app: 'desktop' });
    expect(typeof info.user).toBe('string');
    expect(Number.isNaN(Date.parse(info.since))).toBe(false);
    expect(lock.tookOver).toBeNull();
    expect(acquireDocumentLock(file, 'desktop').documentPath).toBe(path.resolve(file)); // re-entrant for the holder
    lock.release();
    expect(fs.existsSync(lockPathOf(file))).toBe(false);
  });

  it('a live holder on this host refuses a second writer with DSF_DOC_LOCKED and leaves the lock alone', async () => {
    writeLock({ pid: await liveOtherProcess() });
    const before = fs.readFileSync(lockPathOf(file), 'utf8');
    expect(() => acquireDocumentLock(file, 'cli')).toThrow(DocumentLockedError);
    try {
      acquireDocumentLock(file, 'cli');
    } catch (error) {
      expect((error as DocumentLockedError).code).toBe('DSF_DOC_LOCKED');
      expect((error as DocumentLockedError).message).toContain('--app');
    }
    expect(fs.readFileSync(lockPathOf(file), 'utf8')).toBe(before);
  });

  it('takes over a lock whose pid is dead on this host and reports the stale holder (DSF_LOCK_STALE)', async () => {
    const pid = await deadPid();
    writeLock({ pid });
    const lock = acquireDocumentLock(file, 'cli');
    expect(lock.tookOver?.pid).toBe(pid);
    expect((JSON.parse(fs.readFileSync(lockPathOf(file), 'utf8')) as LockInfo).pid).toBe(process.pid);
    expect(fs.readdirSync(dir).filter((name) => name.endsWith('.stale') || name.endsWith('.tmp'))).toEqual([]);
  });

  it('never takes a lock of another host, however dead its pid looks, and never guesses at an unreadable lock', async () => {
    writeLock({ pid: await deadPid(), host: 'some-other-machine' });
    expect(() => acquireDocumentLock(file, 'cli')).toThrow(DocumentLockedError);
    expect((JSON.parse(fs.readFileSync(lockPathOf(file), 'utf8')) as LockInfo).host).toBe('some-other-machine');
    fs.writeFileSync(lockPathOf(file), 'not json');
    expect(() => acquireDocumentLock(file, 'cli')).toThrow(DocumentLockedError);
    expect(fs.readFileSync(lockPathOf(file), 'utf8')).toBe('not json');
  });
});

describe('save conflict', () => {
  it('refuses to overwrite a file changed on disk since it was loaded, and writes nothing', () => {
    writeDocumentFile(file, createEmptyDocument());
    const loaded = stampOf(file);
    fs.appendFileSync(file, ' '); // an external edit
    const external = fs.readFileSync(file);
    const edited = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document;
    expect(() => writeDocumentFile(file, edited, { stamp: loaded })).toThrow(SaveConflictError);
    expect(fs.readFileSync(file).equals(external)).toBe(true);
    expect(writeDocumentFile(file, edited, undefined)).not.toBeNull(); // without a guard (forced) it saves
  });

  it('treats a file that appeared after it was loaded as missing as a conflict', () => {
    const loaded = stampOf(file); // null: no file yet
    writeDocumentFile(file, createEmptyDocument());
    expect(() => writeDocumentFile(file, createEmptyDocument(), { stamp: loaded })).toThrow(SaveConflictError);
  });
});

describe('llull --doc', () => {
  it('is refused with DSF_DOC_LOCKED while the desktop app holds the file, and nothing is written', async () => {
    writeLock({ pid: await liveOtherProcess(), app: 'desktop' });
    const { io, out } = capture();
    expect(await runCli(['exec', 'add_box', '{"size":[1,1,1]}', '--doc', file, '--json'], io)).toBe(EXIT_COMMAND_ERROR);
    const result = JSON.parse(out.join('')) as { ok: boolean; summary: string; error?: { code: string } };
    expect(result).toMatchObject({ ok: false, error: { code: 'DSF_DOC_LOCKED' } });
    expect(result.summary).toContain('--app');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('takes over a dead process lock, says so, and leaves no lock behind', async () => {
    writeLock({ pid: await deadPid() });
    const { io, out } = capture();
    expect(await runCli(['exec', 'add_box', '{"size":[1,1,1]}', '--doc', file, '--json'], io)).toBe(EXIT_OK);
    expect(out.join('')).toContain('DSF_LOCK_STALE');
    expect(Object.keys(readDocumentFile(file).entities)).toHaveLength(1);
    expect(fs.existsSync(lockPathOf(file))).toBe(false);
  });

  it('a save after the file was modified externally is refused with DSF_SAVE_CONFLICT unless --force-overwrite', async () => {
    expect(await addBox()).toBe(EXIT_OK);
    // one process = one load-modify-save: simulate the window between load and save with a backend kept open
    const { createLocalBackend } = await import('../src/cli/backend');
    const backend = createLocalBackend(file, { dryRun: false, exchangeOptions: () => ({}) as never });
    expect((await backend.run('add_box', { size: [2, 2, 2] })).changed).toBe(true);
    // another writer replaces the file behind this backend's back
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), touchedBy: 'someone else' }));
    const external = fs.readFileSync(file);
    const refused = await backend.run('add_box', { size: [3, 3, 3] });
    expect(refused).toMatchObject({ isError: true, changed: false, error: { code: 'DSF_SAVE_CONFLICT' } });
    expect(fs.readFileSync(file).equals(external)).toBe(true);
    const forced = createLocalBackend(file, { dryRun: false, forceOverwrite: true, exchangeOptions: () => ({}) as never });
    expect((await forced.run('add_box', { size: [3, 3, 3] })).changed).toBe(true);
  });
});

describe('lock creation on volumes without hard links, and in folders that take no lock (review 3)', () => {
  const errno = (code: string): Error => Object.assign(new Error(code), { code });
  const realOpen = fs.openSync.bind(fs);

  it.each(['EPERM', 'ENOTSUP', 'EINVAL', 'EXDEV'])('falls back to an exclusive create when link() fails with %s', (code) => {
    vi.spyOn(fs, 'linkSync').mockImplementation(() => {
      throw errno(code);
    });
    try {
      const lock = acquireDocumentLock(file, 'desktop');
      expect(lock.warning).toBeNull();
      expect((JSON.parse(fs.readFileSync(lockPathOf(file), 'utf8')) as LockInfo).pid).toBe(process.pid);
      expect(() => acquireDocumentLock(file, 'cli')).not.toThrow(); // re-entrant for this process
      lock.release();
      expect(fs.existsSync(lockPathOf(file))).toBe(false);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('the fallback still refuses a lock somebody else holds', async () => {
    writeLock({ pid: await liveOtherProcess(), app: 'desktop' });
    vi.spyOn(fs, 'linkSync').mockImplementation(() => {
      throw errno('EPERM');
    });
    try {
      expect(() => acquireDocumentLock(file, 'cli')).toThrow(DocumentLockedError);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it.each(['EACCES', 'EROFS'])('an unwritable folder (%s) opens without a lock and says DSF_LOCK_UNAVAILABLE', (code) => {
    const real = fs.writeFileSync.bind(fs);
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((target: fs.PathOrFileDescriptor, data: string, ...rest: unknown[]) => {
      if (String(target).endsWith('.tmp')) throw errno(code);
      return (real as (...args: unknown[]) => void)(target, data, ...rest);
    }) as typeof fs.writeFileSync);
    try {
      const lock = acquireDocumentLock(file, 'desktop');
      expect(lock.warning).toBe('DSF_LOCK_UNAVAILABLE');
      expect(fs.existsSync(lockPathOf(file))).toBe(false);
      expect(() => lock.release()).not.toThrow();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('EPERM from the exclusive create while a lock file exists is contention (DSF_DOC_LOCKED), never an unlocked open', async () => {
    writeLock({ pid: await liveOtherProcess(), app: 'desktop' });
    vi.spyOn(fs, 'linkSync').mockImplementation(() => {
      throw errno('EPERM');
    });
    vi.spyOn(fs, 'openSync').mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
      if (String(target).endsWith('.llull-lock')) throw errno('EPERM');
      return (realOpen as (...args: unknown[]) => number)(target, ...rest);
    }) as typeof fs.openSync);
    try {
      expect(() => acquireDocumentLock(file, 'cli')).toThrow(DocumentLockedError);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('a delete-pending lock (EPERM, then the create works) is retried and taken', () => {
    let failures = 2;
    vi.spyOn(fs, 'linkSync').mockImplementation(() => {
      throw errno('EPERM');
    });
    vi.spyOn(fs, 'openSync').mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
      if (String(target).endsWith('.llull-lock') && failures-- > 0) throw errno('EPERM');
      return (realOpen as (...args: unknown[]) => number)(target, ...rest);
    }) as typeof fs.openSync);
    try {
      const lock = acquireDocumentLock(file, 'desktop');
      expect(lock.warning).toBeNull();
      expect(fs.existsSync(lockPathOf(file))).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('an EPERM that never clears and shows no lock is still DSF_DOC_LOCKED, not an unlocked open', () => {
    vi.spyOn(fs, 'linkSync').mockImplementation(() => {
      throw errno('EPERM');
    });
    vi.spyOn(fs, 'openSync').mockImplementation(((target: fs.PathLike, ...rest: unknown[]) => {
      if (String(target).endsWith('.llull-lock')) throw errno('EPERM');
      return (realOpen as (...args: unknown[]) => number)(target, ...rest);
    }) as typeof fs.openSync);
    try {
      expect(() => acquireDocumentLock(file, 'desktop')).toThrow(DocumentLockedError);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('a probe write that fails (EROFS / EPERM) while a lock file exists is contention, not an unwritable folder', async () => {
    writeLock({ pid: await liveOtherProcess(), app: 'desktop' });
    const real = fs.writeFileSync.bind(fs);
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((target: fs.PathOrFileDescriptor, data: string, ...rest: unknown[]) => {
      if (String(target).endsWith('.tmp')) throw errno('EPERM');
      return (real as (...args: unknown[]) => void)(target, data, ...rest);
    }) as typeof fs.writeFileSync);
    try {
      expect(() => acquireDocumentLock(file, 'cli')).toThrow(DocumentLockedError);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('the CLI reports DSF_LOCK_UNAVAILABLE next to a successful write', async () => {
    const real = fs.writeFileSync.bind(fs);
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((target: fs.PathOrFileDescriptor, data: string, ...rest: unknown[]) => {
      if (String(target).endsWith('.tmp')) throw errno('EROFS');
      return (real as (...args: unknown[]) => void)(target, data, ...rest);
    }) as typeof fs.writeFileSync);
    try {
      const { io, out } = capture();
      expect(await runCli(['exec', 'add_box', '{"size":[1,1,1]}', '--doc', file, '--json'], io)).toBe(EXIT_OK);
      expect(out.join('')).toContain('DSF_LOCK_UNAVAILABLE');
    } finally {
      vi.restoreAllMocks();
    }
    expect(Object.keys(readDocumentFile(file).entities)).toHaveLength(1);
  });
});

describe('takeover race, unreadable-lock message, leftover temporaries (review 6)', () => {
  it('refuses while another taker holds the takeover mutex, leaving the stale lock where it is', async () => {
    const pid = await deadPid();
    writeLock({ pid });
    fs.writeFileSync(`${lockPathOf(file)}.takeover`, '');
    expect(() => acquireDocumentLock(file, 'cli')).toThrow(DocumentLockedError);
    expect((JSON.parse(fs.readFileSync(lockPathOf(file), 'utf8')) as LockInfo).pid).toBe(pid);
  });

  it('removes a takeover mutex left by a crashed taker (older than 10 s) and takes over', async () => {
    writeLock({ pid: await deadPid() });
    const mutex = `${lockPathOf(file)}.takeover`;
    fs.writeFileSync(mutex, '');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(mutex, old, old);
    expect(acquireDocumentLock(file, 'cli').tookOver).not.toBeNull();
    expect(fs.existsSync(mutex)).toBe(false);
  });

  it('a stale takeover mutex is renamed to a unique name before it is deleted (no remove-by-name race)', async () => {
    writeLock({ pid: await deadPid() });
    const mutex = `${lockPathOf(file)}.takeover`;
    fs.writeFileSync(mutex, '');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(mutex, old, old);
    const renamed: string[] = [];
    const realRename = fs.renameSync.bind(fs);
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from) === mutex) renamed.push(String(to));
      realRename(from, to);
    });
    try {
      expect(acquireDocumentLock(file, 'cli').tookOver).not.toBeNull();
    } finally {
      vi.restoreAllMocks();
    }
    expect(renamed).toHaveLength(1);
    expect(renamed[0]).toMatch(/\.takeover\.\d+\.[0-9a-f]{8}\.stale$/);
    expect(fs.readdirSync(dir).filter((name) => name.endsWith('.stale'))).toEqual([]);
  });

  it('a fresh lock that appears between the check and the rename is put back, never taken (both would hold otherwise)', async () => {
    writeLock({ pid: await deadPid() });
    const live = await liveOtherProcess();
    const real = fs.renameSync.bind(fs);
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from) === lockPathOf(file)) writeLock({ pid: live, since: '2026-11-05T11:00:00.000Z' }); // a live process took it just now
      return real(from, to);
    });
    try {
      expect(() => acquireDocumentLock(file, 'cli')).toThrow(DocumentLockedError);
      expect((JSON.parse(fs.readFileSync(lockPathOf(file), 'utf8')) as LockInfo).pid).toBe(live);
    } finally {
      vi.restoreAllMocks();
    }
    expect(fs.existsSync(`${lockPathOf(file)}.takeover`)).toBe(false);
  });

  it('an unreadable lock names the lock file and says to delete it when no llull is running', () => {
    fs.writeFileSync(lockPathOf(file), 'garbage');
    let message = '';
    try {
      acquireDocumentLock(file, 'cli');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain(lockPathOf(file));
    expect(message).toMatch(/delete that file/);
  });

  it('removes <lock>.<pid>.tmp files of dead pids and keeps those of live ones', async () => {
    const alive = `${lockPathOf(file)}.${await liveOtherProcess()}.tmp`;
    const dead = `${lockPathOf(file)}.${await deadPid()}.tmp`;
    fs.writeFileSync(dead, '{}');
    fs.writeFileSync(alive, '{}');
    acquireDocumentLock(file, 'cli');
    expect(fs.existsSync(dead)).toBe(false);
    expect(fs.existsSync(alive)).toBe(true);
  });
});

describe('save conflict compares content, not only the time stamp (review 8)', () => {
  it('a touched time stamp with the same content is no conflict (cloud sync, antivirus)', () => {
    writeDocumentFile(file, createEmptyDocument());
    const loaded = stampOf(file);
    const later = new Date(Date.now() + 60_000);
    fs.utimesSync(file, later, later);
    expect(() => writeDocumentFile(file, createEmptyDocument(), { stamp: loaded })).not.toThrow();
  });

  it('a same-size rewrite that keeps the time stamp (FAT 2 s granularity) is still a conflict', () => {
    writeDocumentFile(file, createEmptyDocument());
    const loaded = stampOf(file);
    const text = fs.readFileSync(file, 'utf8');
    const changed = text.replace(/a/, 'b');
    expect(changed).not.toBe(text);
    const mtime = fs.statSync(file).mtime;
    fs.writeFileSync(file, changed);
    fs.utimesSync(file, mtime, mtime);
    expect(stampOf(file)?.size).toBe(loaded?.size);
    expect(() => writeDocumentFile(file, createEmptyDocument(), { stamp: loaded })).toThrow(SaveConflictError);
  });
});
