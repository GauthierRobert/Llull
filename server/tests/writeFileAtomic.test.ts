/** SC-D1 writer: `<file>.bak` keeps the replaced version; transient Windows rename errors are retried; no hard links -> copy. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renameWithRetry, replaceKeepingBackupAsync, writeFileAtomic, writeFileKeepingBackup } from '../src/writeFileAtomic';

let dir = '';
let file = '';

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'llull-atomic-'));
  file = path.join(dir, 'doc.llull.json');
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

describe('writeFileKeepingBackup', () => {
  it('keeps the replaced version as .bak, one level deep, and leaves no temp behind', () => {
    writeFileKeepingBackup(file, 'one');
    expect(readdirSync(dir)).toEqual(['doc.llull.json']);
    writeFileKeepingBackup(file, 'two');
    writeFileKeepingBackup(file, 'three');
    expect(readFileSync(file, 'utf8')).toBe('three');
    expect(readFileSync(`${file}.bak`, 'utf8')).toBe('two');
    expect(readdirSync(dir).sort()).toEqual(['doc.llull.json', 'doc.llull.json.bak']);
  });

  it('falls back to a copy when the file system has no hard links', () => {
    vi.spyOn(fs, 'linkSync').mockImplementation(() => {
      throw errno('EXDEV');
    });
    writeFileKeepingBackup(file, 'one');
    writeFileKeepingBackup(file, 'two');
    expect(readFileSync(`${file}.bak`, 'utf8')).toBe('one');
  });

  it('a failed rename leaves the old version in place and removes its temp', () => {
    writeFileKeepingBackup(file, 'one');
    const realRename = fs.renameSync.bind(fs);
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === file) throw errno('ENOSPC');
      realRename(from, to);
    });
    expect(() => writeFileKeepingBackup(file, 'two')).toThrow('ENOSPC');
    expect(readFileSync(file, 'utf8')).toBe('one');
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('removes temps orphaned by a dead process, keeps those of live ones', () => {
    const orphan = path.join(dir, 'doc.llull.json.999999999.tmp');
    const orphanBackup = path.join(dir, 'doc.llull.json.999999999.bak.tmp');
    const orphanSwap = path.join(dir, 'doc.llull.json.999999998.swap');
    const orphanAsync = path.join(dir, 'doc.llull.json.999999997.async.bak.tmp');
    const live = path.join(dir, `doc.llull.json.${process.ppid}.tmp`);
    for (const name of [orphan, orphanBackup, orphanSwap, orphanAsync, live]) writeFileSync(name, 'partial');
    writeFileKeepingBackup(file, 'one');
    expect(readdirSync(dir).sort()).toEqual(['doc.llull.json', path.basename(live)]);
  });
});

describe('renameWithRetry', () => {
  it('retries a transient EBUSY/EPERM and then succeeds', () => {
    writeFileSync(`${file}.src`, 'x');
    const realRename = fs.renameSync.bind(fs);
    let calls = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      calls++;
      if (calls <= 2) throw errno(calls === 1 ? 'EBUSY' : 'EPERM');
      realRename(from, to);
    });
    renameWithRetry(`${file}.src`, file);
    expect(calls).toBe(3);
    expect(readFileSync(file, 'utf8')).toBe('x');
  });

  it('gives up on a permanent error at once and after the retry budget on a transient one', () => {
    let calls = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      calls++;
      throw errno(calls === 1 ? 'ENOENT' : 'EBUSY');
    });
    expect(() => renameWithRetry('a', 'b')).toThrow('ENOENT');
    expect(calls).toBe(1);
    expect(() => renameWithRetry('a', 'b')).toThrow('EBUSY');
    expect(calls).toBe(9);
  });
});

describe('replaceKeepingBackupAsync', () => {
  it('keeps .bak, and retries a transient rename without blocking the event loop', async () => {
    writeFileKeepingBackup(file, 'one');
    writeFileSync(`${file}.tmp-new`, 'two');
    const realRename = fs.renameSync.bind(fs);
    let failures = 0;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === file && failures < 3) {
        failures++;
        throw errno('EBUSY');
      }
      realRename(from, to);
    });
    const atomicsWait = vi.spyOn(Atomics, 'wait');
    let ticks = 0;
    const ticker = setInterval(() => ticks++, 1);
    expect(await replaceKeepingBackupAsync(`${file}.tmp-new`, file, () => true)).toBe(true);
    clearInterval(ticker);
    expect(failures).toBe(3);
    expect(atomicsWait).not.toHaveBeenCalled();
    expect(ticks).toBeGreaterThan(0);
    expect(readFileSync(file, 'utf8')).toBe('two');
    expect(readFileSync(`${file}.bak`, 'utf8')).toBe('one');
  });

  it('abandons once no longer wanted (a newer synchronous write landed), touching neither file nor .bak', async () => {
    writeFileKeepingBackup(file, 'one');
    writeFileKeepingBackup(file, 'two');
    writeFileSync(`${file}.tmp-old`, 'stale');
    expect(await replaceKeepingBackupAsync(`${file}.tmp-old`, file, () => false)).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('two');
    expect(readFileSync(`${file}.bak`, 'utf8')).toBe('one');
  });
});

describe('writeFileAtomic', () => {
  it('replaces the file without a backup', () => {
    writeFileAtomic(file, 'one');
    writeFileAtomic(file, 'two');
    expect(readFileSync(file, 'utf8')).toBe('two');
    expect(readdirSync(dir)).toEqual(['doc.llull.json']);
  });
});
