/** DocumentSession against a recording fake backend: the order of recovery calls around open / save / new (A-08). */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createEmptyDocument } from '@core/model/types';
import { serializeDocument } from '@core/commands/persistence/serialization';
import type { FetchLike } from '@server/restClient';
import { createDocumentSession } from '../src/documents';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'llull-session-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Fake {
  readonly fetchImpl: FetchLike;
  readonly calls: string[];
}

function fakeBackend(): Fake {
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
      hash = `h-${String(body['name'])}`;
      return json({ summary: 'ok', affected: [], isError: false, changed: true });
    }
    calls.push(`${route.slice(1)}:${JSON.stringify(body)}`);
    return json({ ok: true });
  };
  return { fetchImpl, calls };
}

describe('DocumentSession recovery calls', () => {
  it('open binds the new document BEFORE loading it (so B never lands in A slot), then marks it saved', async () => {
    const backend = fakeBackend();
    const session = createDocumentSession({ url: 'http://127.0.0.1:1', token: 't', fetchImpl: backend.fetchImpl });
    const file = path.join(dir, 'B.llull');
    writeFileSync(file, serializeDocument(createEmptyDocument()));
    await session.open(file);
    expect(backend.calls).toEqual([
      `recovery/bind:${JSON.stringify({ path: file, dropPrevious: true })}`,
      'command:load_document',
      `recovery/saved:${JSON.stringify({ stateHash: 'h-load_document' })}`,
    ]);
  });

  it('new document binds an untitled slot first; Save As moves the binding to the new file and marks it saved', async () => {
    const backend = fakeBackend();
    const session = createDocumentSession({ url: 'http://127.0.0.1:1', token: 't', fetchImpl: backend.fetchImpl });
    await session.newDocument();
    expect(backend.calls[0]).toBe(`recovery/bind:${JSON.stringify({ path: null, dropPrevious: true })}`);
    backend.calls.length = 0;
    const file = path.join(dir, 'C.llull');
    await session.save(file);
    expect(backend.calls).toEqual([
      `recovery/bind:${JSON.stringify({ path: file, dropPrevious: true })}`,
      `recovery/saved:${JSON.stringify({ stateHash: 'h-clear_document' })}`,
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
