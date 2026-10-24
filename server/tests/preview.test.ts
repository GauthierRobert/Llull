import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../src/index';
import { getLiveDoc, _resetLiveDoc, subscribeLive } from '../src/liveDocument';
import { _resetHistory } from '../src/commandBus';
import { makeFakeRes } from './sseTestHelpers';

beforeEach(() => {
  _resetLiveDoc();
  _resetHistory();
});

const command = (name: string, params: object): request.Test => request(app).post('/command').send({ name, params });
const preview = (body: object): request.Test => request(app).post('/preview').send(body);

describe('POST /preview', () => {
  it('shows what a creation would add without touching the live document, history or stream', async () => {
    const stream = makeFakeRes();
    const unsubscribe = subscribeLive(stream);
    const written = stream.written.length;
    const res = await preview({ name: 'add_box', params: { size: [2, 2, 2] } });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.summary).toContain('Added box');
    expect(res.body.entities).toHaveLength(1);
    expect(res.body.entities[0]).toMatchObject({ kind: 'box', triangleCount: 12, truncated: false });
    expect(res.body.entities[0].positions).toHaveLength(12 * 9);
    expect(res.body.replacedIds).toEqual([]);
    expect(Object.keys(getLiveDoc().entities)).toHaveLength(0);
    expect(getLiveDoc().featureHistory).toHaveLength(0);
    expect(stream.written.length).toBe(written);
    expect((await request(app).post('/undo')).body.changed).toBe(false);
    unsubscribe();
  });

  it('names the live entity a command would change and previews its new mesh (VC-DIR-26: the live document stays as it was)', async () => {
    await command('add_subdivision_solid', { box: { size: [2, 2, 2] }, levels: 2, id: 'g' });
    const before = JSON.stringify(getLiveDoc());
    const res = await preview({ name: 'edit_subdivision_cage', params: { id: 'g', vertexIndices: [0], translate: [0, 0, 1] } });
    expect(res.body.ok).toBe(true);
    expect(res.body.replacedIds).toEqual(['g']);
    expect(res.body.entities.map((entity: { id: string }) => entity.id)).toEqual(['g']);
    expect(res.body.entities[0].triangleCount).toBeGreaterThan(100);
    expect(JSON.stringify(getLiveDoc())).toBe(before);
    const again = await preview({ name: 'edit_subdivision_cage', params: { id: 'g', vertexIndices: [0], translate: [0, 0, 1] } });
    expect(again.body.entities[0].positions).toEqual(res.body.entities[0].positions);
  });

  it('reports a consumed entity as replaced and carries command data and coded errors', async () => {
    await command('add_subdivision_solid', { box: { size: [2, 2, 2] }, levels: 1, id: 'g' });
    const converted = await preview({ name: 'subdivision_to_nurbs', params: { id: 'g' } });
    expect(converted.body.ok).toBe(true);
    expect(converted.body.replacedIds).toEqual(['g']);
    expect(converted.body.entities).toHaveLength(24);
    expect(converted.body.data.patchCount).toBe(24);
    const refused = await preview({ name: 'extrude_cage_faces', params: { id: 'g', faces: ['f-9.9'], distance: 1 } });
    expect(refused.body.ok).toBe(false);
    expect(refused.body.error.code).toBe('DIR_REF_LOST');
    expect(refused.body.entities).toEqual([]);
  });

  it('answers a failing or unknown command as ok: false, and a bad body with 400', async () => {
    const unknown = await preview({ name: 'no_such_command' });
    expect(unknown.status).toBe(200);
    expect(unknown.body).toMatchObject({ ok: false, entities: [], replacedIds: [] });
    for (const body of [{}, { name: '' }, { name: 5 }, { params: {} }]) expect((await preview(body)).status).toBe(400);
  });

  it('skips the geometry of an entity that is too big for one preview', async () => {
    await command('add_subdivision_solid', { box: { size: [2, 2, 2], segments: [8, 8, 8] }, levels: 4, id: 'big' });
    const res = await preview({ name: 'edit_subdivision_cage', params: { id: 'big', vertexIndices: [0], translate: [0, 0, 1] } });
    expect(res.body.entities[0]).toMatchObject({ id: 'big', truncated: true, positions: [] });
    expect(res.body.entities[0].triangleCount).toBeGreaterThan(150_000);
  });
});
