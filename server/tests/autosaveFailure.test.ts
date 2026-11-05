/** A-11: a failing autosave is reported with a stable DSF_* code, retried, and reported ok again; the live host exposes it (SSE `status`, `/health`). */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createAutosaver, writeFailureCode, type AutosaveStatus } from '../src/autosave';
import { createEmptyDocument } from '@core/model/types';
import { makeFakeRes, parseSseFrame } from './sseTestHelpers';

const until = async (condition: () => boolean, ms = 4000): Promise<void> => {
  for (let waited = 0; !condition() && waited < ms; waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
};

describe('autosave failure status', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llull-autosave-fail-'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('maps disk-full errors and other file errors to stable codes', () => {
    expect(writeFailureCode(Object.assign(new Error('x'), { code: 'ENOSPC' }))).toBe('DSF_SAVE_DISK_FULL');
    expect(writeFailureCode(Object.assign(new Error('x'), { code: 'EDQUOT' }))).toBe('DSF_SAVE_DISK_FULL');
    expect(writeFailureCode(Object.assign(new Error('x'), { code: 'EACCES' }))).toBe('DSF_SAVE_IO');
    expect(writeFailureCode('boom')).toBe('DSF_SAVE_IO');
  });

  it('reports DSF_SAVE_DISK_FULL, retries with backoff and reports ok once the disk accepts the write', async () => {
    const file = path.join(dir, 'a.json');
    const statuses: AutosaveStatus[] = [];
    const real = fs.promises.writeFile.bind(fs.promises);
    let full = true;
    vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (...args: Parameters<typeof fs.promises.writeFile>) => {
      if (full) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
      return real(...args);
    });
    const saver = createAutosaver({
      filePath: file,
      debounceMs: 1,
      retryBaseMs: 10,
      serialize: () => '{"v":1}',
      onStatus: (status) => statuses.push(status),
    });
    saver.schedule(createEmptyDocument());
    await until(() => statuses.length > 0);
    expect(statuses[0]).toMatchObject({ ok: false, code: 'DSF_SAVE_DISK_FULL' });
    expect(fs.existsSync(file)).toBe(false);
    full = false; // space freed: the retry (no new edit) writes the document
    await until(() => statuses.some((status) => status.ok));
    expect(statuses.at(-1)).toEqual({ ok: true });
    expect(fs.readFileSync(file, 'utf8')).toBe('{"v":1}');
    saver.stop();
  });

  it('reports DSF_AUTOSAVE_FAILED when the document cannot be serialized, then recovers', async () => {
    const statuses: AutosaveStatus[] = [];
    let broken = true;
    const saver = createAutosaver({
      filePath: path.join(dir, 'b.json'),
      debounceMs: 1,
      retryBaseMs: 10,
      serialize: () => {
        if (broken) throw new Error('circular');
        return '{}';
      },
      onStatus: (status) => statuses.push(status),
    });
    saver.schedule(createEmptyDocument());
    await until(() => statuses.length > 0);
    expect(statuses[0]).toMatchObject({ ok: false, code: 'DSF_AUTOSAVE_FAILED', message: 'circular' });
    broken = false;
    await until(() => statuses.some((status) => status.ok));
    expect(statuses.at(-1)).toEqual({ ok: true });
    saver.stop();
  });

  it('reports DSF_SAVE_IO for a synchronous (shutdown) write that fails', () => {
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    const statuses: AutosaveStatus[] = [];
    const saver = createAutosaver({
      filePath: path.join(blocker, 'a.json'), // the parent is a file
      debounceMs: 60_000,
      serialize: () => '{}',
      onStatus: (status) => statuses.push(status),
    });
    saver.schedule(createEmptyDocument());
    saver.flush();
    expect(statuses[0]).toMatchObject({ ok: false, code: 'DSF_SAVE_IO' });
  });
});

describe('live host exposes the autosave status', () => {
  it('broadcasts `status` to subscribers, greets late subscribers with it, and (the /health field is the same value)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llull-autosave-live-'));
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    vi.resetModules();
    vi.stubEnv('LLULL_AUTOSAVE_PATH', path.join(blocker, 'auto.json'));
    vi.stubEnv('VITEST', '');
    vi.stubEnv('TEST', '');
    vi.stubEnv('LLULL_AUTOSAVE_DISABLED', '');
    vi.stubEnv('LLULL_AUTOSAVE_DEBOUNCE_MS', '1');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const live = await import('../src/liveDocument');
      const early = makeFakeRes();
      live.subscribeLive(early);
      live.setLiveDoc(createEmptyDocument());
      await until(() => early.written.some((frame) => parseSseFrame(frame).event === 'status'));
      const status = early.written.map(parseSseFrame).find((frame) => frame.event === 'status');
      expect(status?.data['autosave']).toMatchObject({ ok: false, code: 'DSF_SAVE_IO' });
      expect(live.getAutosaveStatus()).toMatchObject({ ok: false, code: 'DSF_SAVE_IO' });
      const late = makeFakeRes();
      live.subscribeLive(late);
      expect(late.written.map((frame) => parseSseFrame(frame).event)).toEqual(['snapshot', 'status']);
    } finally {
      warn.mockRestore();
      vi.unstubAllEnvs();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
