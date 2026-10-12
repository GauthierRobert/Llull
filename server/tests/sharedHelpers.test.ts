/**
 * The de-duplicated helpers: one command outcome shape, one REST reader, one document file
 * reader/writer, one CLI target resolution, one env parser.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import { failedOutcome, outcomeIsFailure, runCommandOutcome } from '@mcp/commandOutcome';
import { DOCUMENT_ACCEPT, DOCUMENT_FILE_PATTERN } from '@mcp/documentFiles';
import { exportStepFile } from '@mcp/exchangeTools';
import { parseCommandResponse } from '@mcp/restProtocol';
import { cliTarget, parseArgv, type CliTarget } from '../src/cli/argv';
import { readDocumentFile, writeDocumentFile } from '../src/documentFile';
import { exchangeDirOf, isTestRun, positiveInteger } from '../src/env';
import { hashJson } from '../src/audit';
import { isHealthy, requestJson } from '../src/restClient';
import { writeFileAtomic } from '../src/writeFileAtomic';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status });

describe('parseCommandResponse', () => {
  it('reads a command-bus body', () => {
    expect(
      parseCommandResponse(
        { summary: 'ok', affected: ['a', 3], changed: true, data: { x: 1 } },
        200,
      ),
    ).toEqual({ summary: 'ok', affected: ['a'], isError: false, changed: true, data: { x: 1 } });
  });

  it('turns an error body or a non-2xx status into an error outcome', () => {
    expect(parseCommandResponse({ error: 'nope' }, 401)).toMatchObject({
      isError: true,
      summary: 'Server answered HTTP 401: nope.',
    });
    expect(parseCommandResponse({ summary: 's', affected: [] }, 500).isError).toBe(true);
  });
});

describe('runCommandOutcome / outcomeIsFailure', () => {
  it('reports a change, a no-op and a rejection', () => {
    const doc = createEmptyDocument();
    const added = runCommandOutcome(doc, 'add_box', { size: [1, 2, 3] });
    expect(added.outcome.changed).toBe(true);
    expect(added.outcome.affected).toHaveLength(1);
    expect(added.document).not.toBe(doc);
    expect(outcomeIsFailure('add_box', added.outcome)).toBe(false);

    const rejected = runCommandOutcome(doc, 'add_box', { size: 'x' });
    expect(rejected.outcome.isError).toBe(true);
    expect(rejected.document).toBe(doc);
    expect(outcomeIsFailure('add_box', rejected.outcome)).toBe(true);

    const unknown = runCommandOutcome(doc, 'no_such_command', {});
    expect(unknown.outcome.isError).toBe(true);
  });

  it('counts an unchanged mutating command as a failure unless the caller allows it', () => {
    const noop = { summary: 'x', affected: [], isError: false, changed: false };
    expect(outcomeIsFailure('add_box', noop)).toBe(true);
    expect(outcomeIsFailure('add_box', noop, true)).toBe(false);
    expect(outcomeIsFailure('add_box', { ...noop, data: { ok: false } }, true)).toBe(true);
  });
});

describe('document files', () => {
  it('round-trips atomically and reads a missing file as an empty document', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llull-docfile-'));
    try {
      const file = path.join(dir, 'nested', 'part.llull');
      expect(Object.keys(readDocumentFile(file).entities)).toEqual([]);
      const doc = runCommandOutcome(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document;
      writeDocumentFile(file, doc);
      expect(Object.keys(readDocumentFile(file).entities)).toHaveLength(1);
      expect(fs.readdirSync(path.dirname(file))).toEqual(['part.llull']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('removes its temp file when the rename fails', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llull-atomic-'));
    try {
      const target = path.join(dir, 'is-a-directory');
      fs.mkdirSync(target);
      expect(() => writeFileAtomic(target, 'x')).toThrow();
      expect(fs.readdirSync(dir)).toEqual(['is-a-directory']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names .llull and .json documents for the web Open dialog and the desktop', () => {
    expect(DOCUMENT_ACCEPT).toContain('.llull');
    expect(DOCUMENT_FILE_PATTERN.test('a/b.LLULL')).toBe(true);
    expect(DOCUMENT_FILE_PATTERN.test('part.llull.json')).toBe(true);
    expect(DOCUMENT_FILE_PATTERN.test('part.step')).toBe(false);
  });
});

describe('cliTarget', () => {
  const target = (argv: string[], env: Record<string, string> = {}): CliTarget =>
    cliTarget(parseArgv(argv), env);

  it('prefers --app, then --server, then $LLULL_SERVER, else the local document', () => {
    expect(target(['--app', '--server', 'http://x'], { LLULL_SERVER: 'y' }).server).toBe('app');
    expect(target(['--server', 'http://x'], { LLULL_SERVER: 'y' }).server).toBe('http://x');
    expect(target([], { LLULL_SERVER: 'y' }).server).toBe('y');
    expect(target([]).server).toBeUndefined();
  });

  it('resolves the document from --doc, $LLULL_DOC, then the default', () => {
    expect(target(['--doc', 'a.llull'], { LLULL_DOC: 'b' }).doc).toBe('a.llull');
    expect(target([], { LLULL_DOC: 'b' }).doc).toBe('b');
    expect(target([]).doc).toBe('model.llull.json');
  });
});

describe('env helpers', () => {
  it('positiveInteger falls back on anything but a positive number', () => {
    expect(positiveInteger('250', 1)).toBe(250);
    for (const raw of [undefined, '', '0', '-3', 'abc']) expect(positiveInteger(raw, 7)).toBe(7);
    expect(positiveInteger('2.5', 7)).toBe(2);
    expect(positiveInteger('0.5', 7)).toBe(7);
  });

  it('exchangeDirOf resolves LLULL_EXCHANGE_DIR or answers null', () => {
    expect(exchangeDirOf({})).toBeNull();
    expect(exchangeDirOf({ LLULL_EXCHANGE_DIR: '' })).toBeNull();
    expect(exchangeDirOf({ LLULL_EXCHANGE_DIR: 'x' })).toBe(path.resolve('x'));
  });

  it('isTestRun reads VITEST and TEST', () => {
    expect(isTestRun({})).toBe(false);
    expect(isTestRun({ VITEST: 'true' })).toBe(true);
    expect(isTestRun({ TEST: 'true' })).toBe(true);
    expect(isTestRun({ VITEST: '' })).toBe(false);
  });

  it('hashJson is stable and survives unserializable values', () => {
    expect(hashJson({ a: 1 })).toBe(hashJson({ a: 1 }));
    expect(hashJson({ a: 1 })).not.toBe(hashJson({ a: 2 }));
    expect(hashJson(1n)).toBe('');
  });
});

describe('restClient', () => {
  it('sends JSON with the bearer token and parses the reply', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const reply = await requestJson('http://h/command', {
      body: { name: 'x' },
      token: 't',
      fetchImpl: (url, init) => {
        seen = { url, init };
        return Promise.resolve(jsonResponse({ summary: 's' }));
      },
    });
    expect(reply).toMatchObject({ status: 200, ok: true, body: { summary: 's' } });
    expect(seen).toMatchObject({
      url: 'http://h/command',
      init: { method: 'POST', body: '{"name":"x"}' },
    });
    expect(JSON.stringify(seen)).toContain('Bearer t');
  });

  it('wraps a non-JSON answer as { error } and probes /health', async () => {
    const reply = await requestJson('http://h/x', {
      fetchImpl: () => Promise.resolve(new Response('<html>502</html>', { status: 502 })),
    });
    expect(reply).toMatchObject({ status: 502, ok: false, body: { error: '<html>502</html>' } });
    expect(await isHealthy('http://h', () => Promise.resolve(jsonResponse({})))).toBe(true);
    expect(await isHealthy('http://h', () => Promise.reject(new Error('refused')))).toBe(false);
  });
});

describe('export_step without the Python bridge', () => {
  it('falls back to the exact kernel path and explains when none is installed', async () => {
    const doc = runCommandOutcome(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document;
    const file = await exportStepFile(() => doc, null, { name: 'part' });
    expect('error' in file && file.error).toMatch(/Python bridge/);
  });
});

describe('failedOutcome', () => {
  it('reports a thrown command as an error that changed nothing', () => {
    expect(failedOutcome('add_box', new Error('boom'))).toEqual({
      summary: 'Command add_box failed: boom',
      affected: [],
      isError: true,
      changed: false,
    });
  });
});
