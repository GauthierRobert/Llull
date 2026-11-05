/** A-09: the lock file next to a document (DSF_DOC_LOCKED / DSF_LOCK_STALE) and the on-disk check at save (DSF_SAVE_CONFLICT), also through the `llull --doc` CLI. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
