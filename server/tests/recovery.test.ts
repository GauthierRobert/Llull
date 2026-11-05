/** A-08: one recovery slot per document (and per untitled session); opening B never overwrites A; saving removes the slot; REST + supervised resume. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { serializeDocument } from '@core/commands/persistence/serialization';
import { documentHash } from '@protocol/liveSync';
import { createRecoveryStore, slotIdForPath } from '../src/recovery';
import { createRecoverySession } from '../src/recoverySession';
import '../src/plugins';

const boxDoc = (size: number): CadDocument => execute(createEmptyDocument(), 'add_box', { size: [size, size, size] }).document;

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llull-recovery-'));
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function session(): { store: ReturnType<typeof createRecoveryStore>; session: ReturnType<typeof createRecoverySession> } {
  const store = createRecoveryStore(dir);
  const created = createRecoverySession({
    store,
    debounceMs: 1,
    serialize: serializeDocument,
    onStatus: () => undefined,
    initial: { id: 'untitled-first', path: null },
    now: () => new Date('2026-11-05T10:00:00.000Z'),
  });
  return { store, session: created };
}

describe('per-document recovery slots', () => {
  it('two documents keep two slots after a simulated crash, each with its own content, path and change count', () => {
    const { session: live } = session();
    const fileA = path.join(dir, 'A.llull');
    const fileB = path.join(dir, 'B.llull');
    const docA = boxDoc(1);
    const docB = boxDoc(2);
    live.bind(fileA, true);
    live.schedule(docA);
    live.schedule(docA);
    live.flush();
    live.bind(fileB, false); // opening B while A has unsaved work
    live.schedule(docB);
    live.flush();
    // crash: nothing else runs; a new process reads the folder
    const slots = createRecoveryStore(dir).list();
    expect(slots.map((slot) => slot.path).sort()).toEqual([fileA, fileB].map((p) => path.resolve(p)).sort());
    const slotA = slots.find((slot) => slot.path === path.resolve(fileA));
    expect(slotA).toMatchObject({ id: slotIdForPath(fileA), changeCount: 2, kind: 'document', changedAt: '2026-11-05T10:00:00.000Z' });
    expect(createRecoveryStore(dir).read(slotIdForPath(fileA))?.json).toBe(serializeDocument(docA));
    expect(createRecoveryStore(dir).read(slotIdForPath(fileB))?.json).toBe(serializeDocument(docB));
  });

  it('binding before the load keeps A intact: the load of B lands in the B slot only', () => {
    const { session: live, store } = session();
    const fileA = path.join(dir, 'A.llull');
    live.bind(fileA, true);
    live.schedule(boxDoc(1));
    live.flush();
    const before = fs.readFileSync(store.docFile(slotIdForPath(fileA)), 'utf8');
    live.bind(path.join(dir, 'B.llull'), false);
    live.schedule(boxDoc(7));
    live.flush();
    expect(fs.readFileSync(store.docFile(slotIdForPath(fileA)), 'utf8')).toBe(before);
  });

  it('drops the previous slot when the user discarded it, and an empty session leaves no slot', () => {
    const { session: live, store } = session();
    live.schedule(boxDoc(1));
    live.flush();
    expect(store.list()).toHaveLength(1);
    live.bind(path.join(dir, 'B.llull'), true);
    expect(store.list()).toHaveLength(0);
    live.schedule(createEmptyDocument());
    live.flush();
    expect(store.list()).toHaveLength(0);
  });

  it('a clean save removes the slot, and a pending write cannot bring it back', () => {
    const { session: live, store } = session();
    live.schedule(boxDoc(1));
    live.markSaved();
    live.flush();
    expect(store.list()).toHaveLength(0);
  });

  it('a stale unrecovered slot with the name of a newly opened document is archived, not overwritten', () => {
    const { session: live, store } = session();
    const fileA = path.join(dir, 'A.llull');
    live.bind(fileA, true);
    live.schedule(boxDoc(1));
    live.flush();
    const crashed = serializeDocument(boxDoc(1));
    const { session: next } = session(); // a new process
    next.bind(fileA, true); // opens A from disk: the crash copy must survive
    next.schedule(boxDoc(9));
    next.flush();
    const jsons = store.list().map((slot) => store.read(slot.id)?.json);
    expect(jsons).toContain(crashed);
    expect(store.list()).toHaveLength(2);
  });

  it('adopt re-binds to a restored slot and writes the live document into it at once', () => {
    const { session: live, store } = session();
    const fileA = path.join(dir, 'A.llull');
    live.bind(fileA, true);
    live.schedule(boxDoc(1));
    live.flush();
    const { session: fresh } = session();
    const restored = boxDoc(3);
    const meta = fresh.adopt(slotIdForPath(fileA), restored);
    expect(meta?.path).toBe(path.resolve(fileA));
    expect(store.read(slotIdForPath(fileA))?.json).toBe(serializeDocument(restored));
    expect(fresh.adopt('nope', restored)).toBeNull();
  });
});

describe('recovery REST and supervised resume', () => {
  it('lists, reads, keeps offline edits as a slot, discards, binds and ignores a stale saved hash', async () => {
    vi.resetModules();
    vi.stubEnv('LLULL_RECOVERY_DIR', dir);
    try {
      const { app } = await import('../src/index');
      const json = serializeDocument(boxDoc(4));
      expect((await request(app).get('/recovery')).body).toEqual({ slots: [] });
      const offline = await request(app).post('/recovery/offline').send({ json, path: 'C:/work/A.llull', changeCount: 3 });
      expect(offline.status).toBe(200);
      const id = String((offline.body as { meta: { id: string } }).meta.id);
      const listed = (await request(app).get('/recovery')).body as {
        slots: { id: string; label: string; kind: string; active: boolean }[];
      };
      expect(listed.slots).toMatchObject([{ id, kind: 'offline', label: 'Offline edits of A.llull', active: false }]);
      expect((await request(app).get(`/recovery/${id}`)).body).toMatchObject({ json });
      expect((await request(app).post('/recovery/offline').send({ json: 'nope' })).status).toBe(400);
      expect((await request(app).get('/recovery/missing')).status).toBe(404);
      const fileF = path.join(dir, 'F.llull');
      const bound = await request(app).post('/recovery/bind').send({ path: fileF, dropPrevious: false });
      expect(bound.body).toMatchObject({ slot: slotIdForPath(fileF) });
      expect((await request(app).post('/recovery/bind').send({ path: '' })).status).toBe(400);
      expect((await request(app).post('/recovery/saved').send({ stateHash: 'stale' })).body).toEqual({ ok: true, removed: false });
      const { getLiveDoc } = await import('../src/liveDocument');
      expect(
        (
          await request(app)
            .post('/recovery/saved')
            .send({ stateHash: documentHash(getLiveDoc()) })
        ).body,
      ).toEqual({ ok: true, removed: true });
      expect(
        (
          await request(app)
            .post('/recovery/discard')
            .send({ id: slotIdForPath(fileF) })
        ).status,
      ).toBe(409);
      expect((await request(app).post('/recovery/discard').send({ id })).status).toBe(200);
      expect((await request(app).post('/recovery/discard').send({ id: '../x' })).status).toBe(400);
      expect((await request(app).get('/recovery')).body).toEqual({ slots: [] });
      expect((await request(app).post('/recovery/adopt').send({ id: 'missing' })).status).toBe(404);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('a backend restarted with LLULL_RECOVERY_RESUME resumes the slot it was working on; a fresh one starts empty', async () => {
    const store = createRecoveryStore(dir);
    const doc = boxDoc(5);
    const fileA = path.join(dir, 'A.llull');
    const id = slotIdForPath(fileA);
    fs.writeFileSync(store.docFile(id), serializeDocument(doc));
    store.writeMeta({
      id,
      path: path.resolve(fileA),
      kind: 'document',
      label: 'A.llull',
      changedAt: '2026-11-05T10:00:00.000Z',
      changeCount: 4,
    });
    store.writeActive(id, path.resolve(fileA));
    const load = async (resume: boolean): Promise<{ order: readonly string[]; slot: string }> => {
      vi.resetModules();
      vi.stubEnv('LLULL_RECOVERY_DIR', dir);
      vi.stubEnv('LLULL_RECOVERY_RESUME', resume ? '1' : '');
      vi.stubEnv('VITEST', '');
      vi.stubEnv('TEST', '');
      vi.stubEnv('LLULL_AUTOSAVE_DISABLED', '');
      const live = await import('../src/liveDocument');
      const result = { order: live.getLiveDoc().order, slot: live.recoverySession.current().id };
      live.stopAutosave();
      vi.unstubAllEnvs();
      return result;
    };
    const resumed = await load(true);
    expect(resumed.slot).toBe(id);
    expect(resumed.order).toEqual(doc.order);
    const fresh = await load(false);
    expect(fresh.order).toEqual([]);
    expect(fresh.slot).not.toBe(id);
    expect(store.list().map((slot) => slot.id)).toContain(id); // still offered to the user
  });
});

describe('replacing the open document (review 2, 4)', () => {
  it('a held load stays out of the previous slot; a failed load (release) keeps A bound with its edits', () => {
    const { session: live, store } = session();
    const fileA = path.join(dir, 'A.llull');
    live.bind(fileA, true);
    live.schedule(boxDoc(1));
    live.hold();
    live.schedule(boxDoc(7)); // whatever changes while held is not A's slot content until it is released
    live.flush();
    expect(store.read(slotIdForPath(fileA))?.json).toBe(serializeDocument(boxDoc(1)));
    live.release();
    live.flush();
    expect(live.current().id).toBe(slotIdForPath(fileA));
    expect(store.read(slotIdForPath(fileA))?.json).toBe(serializeDocument(boxDoc(7)));
  });

  it('bind after a held load drops the previous slot only then, and the loaded document goes to the new slot', () => {
    const { session: live, store } = session();
    const fileA = path.join(dir, 'A.llull');
    const fileB = path.join(dir, 'B.llull');
    live.bind(fileA, true);
    live.schedule(boxDoc(1));
    live.hold();
    live.schedule(boxDoc(2)); // B loaded
    expect(store.read(slotIdForPath(fileA))?.json).toBe(serializeDocument(boxDoc(1)));
    live.bind(fileB, true);
    live.flush();
    expect(store.read(slotIdForPath(fileA))).toBeNull();
    expect(store.read(slotIdForPath(fileB))?.json).toBe(serializeDocument(boxDoc(2)));
  });

  it('adopt archives a previous slot that holds different unsaved work instead of removing it', () => {
    const { session: live, store } = session();
    const fileA = path.join(dir, 'A.llull');
    live.bind(fileA, true);
    live.schedule(boxDoc(1)); // unsaved work of A
    live.flush();
    store.writeMeta({
      id: 'doc-other',
      path: path.join(dir, 'other.llull'),
      kind: 'document',
      label: 'other.llull',
      changedAt: '2026-11-05T09:00:00.000Z',
      changeCount: 2,
    });
    fs.writeFileSync(store.docFile('doc-other'), serializeDocument(boxDoc(3)));
    live.hold();
    expect(live.adopt('doc-other', boxDoc(3))?.id).toBe('doc-other');
    const jsons = store.list().map((slot) => store.read(slot.id)?.json);
    expect(jsons).toContain(serializeDocument(boxDoc(1))); // A's work is still offered
    expect(store.list().filter((slot) => slot.path === path.resolve(fileA))).toHaveLength(1);
    expect(store.read(slotIdForPath(fileA))).toBeNull(); // archived under another id: the name is free for A again
  });

  it('adopt removes a previous slot that holds the very document being restored', () => {
    const { session: live, store } = session();
    live.schedule(boxDoc(3));
    live.flush();
    const previous = live.current().id;
    store.writeMeta({ id: 'doc-same', path: null, kind: 'document', label: 'x', changedAt: '2026-11-05T09:00:00.000Z', changeCount: 1 });
    fs.writeFileSync(store.docFile('doc-same'), serializeDocument(boxDoc(3)));
    live.adopt('doc-same', boxDoc(3));
    expect(store.read(previous)).toBeNull();
  });

  it('REST: hold / release / bind announce the path to live subscribers', async () => {
    vi.resetModules();
    vi.stubEnv('LLULL_RECOVERY_DIR', dir);
    try {
      const { app } = await import('../src/index');
      const live = await import('../src/liveDocument');
      const { makeFakeRes, parseSseFrame } = await import('./sseTestHelpers');
      const res = makeFakeRes();
      live.subscribeLive(res);
      const fileA = path.join(dir, 'A.llull');
      expect((await request(app).post('/recovery/hold').send({})).body).toEqual({ ok: true });
      expect((await request(app).post('/recovery/release').send({})).body).toEqual({ ok: true });
      await request(app).post('/recovery/bind').send({ path: fileA, dropPrevious: false });
      const frames = res.written.map(parseSseFrame);
      expect(frames.find((frame) => frame.event === 'document')?.data['path']).toBe(path.resolve(fileA));
      const late = makeFakeRes();
      live.subscribeLive(late);
      expect(late.written.map((frame) => parseSseFrame(frame).event)).toEqual(['snapshot', 'document']);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('a fresh backend announces its slot (review 5)', () => {
  it('writes active.json at start, so a resuming restart before the first edit does not load the previous session slot', async () => {
    const store = createRecoveryStore(dir);
    const previous = slotIdForPath(path.join(dir, 'old.llull'));
    fs.writeFileSync(store.docFile(previous), serializeDocument(boxDoc(5)));
    store.writeMeta({
      id: previous,
      path: path.resolve(dir, 'old.llull'),
      kind: 'document',
      label: 'old.llull',
      changedAt: '2026-11-05T10:00:00.000Z',
      changeCount: 1,
    });
    store.writeActive(previous, path.resolve(dir, 'old.llull'));
    const boot = async (resume: boolean): Promise<{ order: readonly string[]; slot: string }> => {
      vi.resetModules();
      vi.stubEnv('LLULL_RECOVERY_DIR', dir);
      vi.stubEnv('LLULL_RECOVERY_RESUME', resume ? '1' : '');
      vi.stubEnv('VITEST', '');
      vi.stubEnv('TEST', '');
      vi.stubEnv('LLULL_AUTOSAVE_DISABLED', '');
      const live = await import('../src/liveDocument');
      const result = { order: live.getLiveDoc().order, slot: live.recoverySession.current().id };
      live.stopAutosave();
      vi.unstubAllEnvs();
      return result;
    };
    const fresh = await boot(false); // the user's new session: nothing edited yet, then it crashes
    expect(store.readActive()?.id).toBe(fresh.slot);
    const restarted = await boot(true);
    expect(restarted.order).toEqual([]);
    expect(store.list().map((slot) => slot.id)).toContain(previous); // still offered, never loaded behind the user's back
  });
});

describe('autosave status follows the recovery binding (review 9)', () => {
  const failingSession = (
    storeDir: string,
    statuses: { ok: boolean }[],
    broken: { value: boolean },
  ): ReturnType<typeof createRecoverySession> =>
    createRecoverySession({
      store: createRecoveryStore(storeDir),
      debounceMs: 60_000,
      serialize: (doc) => {
        if (broken.value) throw new Error('disk');
        return serializeDocument(doc);
      },
      onStatus: (status) => statuses.push(status),
      initial: { id: 'untitled-first', path: null },
    });

  it('a saved document ends the failure of its own slot', () => {
    const statuses: { ok: boolean }[] = [];
    const live = failingSession(dir, statuses, { value: true });
    live.schedule(boxDoc(1));
    live.flush();
    expect(statuses.at(-1)?.ok).toBe(false);
    live.markSaved(); // the document equals its file: nothing is at risk
    expect(statuses.at(-1)).toEqual({ ok: true });
  });

  it('a rebinding keeps the failure of a slot that is kept, until that slot is dropped', () => {
    const statuses: { ok: boolean }[] = [];
    const broken = { value: true };
    const live = failingSession(dir, statuses, broken);
    live.schedule(boxDoc(1));
    live.flush();
    live.bind(path.join(dir, 'B.llull'), false); // the failing untitled slot is kept
    broken.value = false;
    live.schedule(boxDoc(2));
    live.flush(); // B writes fine, but the untitled slot still failed
    expect(statuses.at(-1)?.ok).toBe(false);
    live.bind(path.join(dir, 'C.llull'), true); // B is dropped: not the failing one
    expect(statuses.at(-1)?.ok).toBe(false);
  });
});
