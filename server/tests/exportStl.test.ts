import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/index';
import { _resetLiveDoc } from '../src/liveDocument';
import { _resetHistory, applyCommand } from '../src/commandBus';
import { parseBuffer } from './exchangeTestSupport';

beforeEach(() => {
  _resetLiveDoc();
  _resetHistory();
});

const getBinaryStl = (): Promise<request.Response> =>
  request(app).get('/export/stl').query({ format: 'binary' }).buffer(true).parse(parseBuffer);
const addBox = (): void => void applyCommand('add_box', { size: [2, 2, 2], position: [0, 0, 0] });

describe('GET /export/stl', () => {
  it('ascii (default): attachment llull.stl with facets', async () => {
    addBox();
    const res = await request(app).get('/export/stl');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/model\/stl/);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.headers['content-disposition']).toMatch(/filename="llull\.stl"/);
    expect(res.text.startsWith('solid ')).toBe(true);
    for (const text of ['endsolid', 'facet normal', 'vertex']) expect(res.text).toContain(text);
  });

  it('binary: 84 + 50 * triangleCount bytes', async () => {
    addBox();
    const res = await getBinaryStl();
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/model\/stl/);
    expect(res.headers['content-disposition']).toMatch(/filename="llull\.stl"/);
    const buf = res.body as Buffer;
    expect(Buffer.isBuffer(buf)).toBe(true);
    const triangleCount = buf.readUInt32LE(80);
    expect(triangleCount).toBeGreaterThan(0);
    expect(buf.length).toBe(84 + triangleCount * 50);
  });

  it('an empty document is a valid empty STL (ascii and 84-byte binary)', async () => {
    const res = await request(app).get('/export/stl');
    expect(res.status).toBe(200);
    expect(res.text.startsWith('solid ')).toBe(true);
    expect(res.text).toContain('endsolid');
    expect(res.text).not.toContain('facet normal');
    const binary = await getBinaryStl();
    expect(binary.status).toBe(200);
    expect((binary.body as Buffer).readUInt32LE(80)).toBe(0);
    expect((binary.body as Buffer).length).toBe(84);
  });

  it('name is used in Content-Disposition and the solid name', async () => {
    const res = await request(app).get('/export/stl').query({ name: 'mypart' });
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/filename="mypart\.stl"/);
    expect(res.text).toContain('solid mypart');
    expect(res.text).toContain('endsolid mypart');
  });

  it('an unknown format falls back to ascii', async () => {
    const res = await request(app).get('/export/stl').query({ format: 'svg' });
    expect(res.status).toBe(200);
    expect(res.text.startsWith('solid ')).toBe(true);
  });
});
