/**
 * @layer server/tests
 *
 * Integration tests for GET /export/stl.
 *
 * Covers:
 *   (a) ASCII download — 200, Content-Disposition attachment, body starts with 'solid '.
 *       Seeds the live doc with one box first so there is geometry to export.
 *   (b) Binary download — 200, Buffer body whose length matches 84 + 50*triangleCount.
 *   (c) Empty document — 200 with a valid empty ASCII STL (triangleCount=0).
 *   (d) format=binary query param — triggers binary path.
 *   (e) Custom name param — reflected in Content-Disposition filename.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../src/index';
import { _resetLiveDoc } from '../src/liveDocument';
import { _resetHistory, applyCommand } from '../src/commandBus';

// ---------------------------------------------------------------------------
// Reset shared state before each test.
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetLiveDoc();
  _resetHistory();
});

// ---------------------------------------------------------------------------
// (a) ASCII download with a seeded box
// ---------------------------------------------------------------------------

describe('GET /export/stl — ascii (default)', () => {
  it('returns 200 with Content-Disposition attachment and ASCII STL body', async () => {
    // Seed one box so the STL is non-empty.
    applyCommand('add_box', { size: [2, 2, 2], position: [0, 0, 0] });

    const res = await request(app).get('/export/stl');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/model\/stl/);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    expect(res.headers['content-disposition']).toMatch(/filename="llull\.stl"/);

    // ASCII STL always starts with 'solid '
    const body = res.text;
    expect(body.startsWith('solid ')).toBe(true);
    expect(body).toContain('endsolid');
  });

  it('body contains triangle data when the document has 3D entities', async () => {
    applyCommand('add_box', { size: [1, 1, 1], position: [0, 0, 0] });

    const res = await request(app).get('/export/stl');

    expect(res.status).toBe(200);
    // A box has 12 triangles — verify at least one facet appears.
    expect(res.text).toContain('facet normal');
    expect(res.text).toContain('vertex');
  });
});

// ---------------------------------------------------------------------------
// (b) Binary download
// ---------------------------------------------------------------------------

describe('GET /export/stl — binary', () => {
  it('returns 200 with raw binary body of correct length', async () => {
    applyCommand('add_box', { size: [1, 1, 1], position: [0, 0, 0] });

    const res = await request(app)
      .get('/export/stl')
      .query({ format: 'binary' })
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/model\/stl/);
    expect(res.headers['content-disposition']).toMatch(/filename="llull\.stl"/);

    // A box has 12 triangles → binary size = 84 + 12*50 = 684 bytes.
    const buf = res.body as Buffer;
    expect(Buffer.isBuffer(buf)).toBe(true);

    // Parse triangle count from the binary header (bytes 80–83, little-endian uint32).
    const triangleCount = buf.readUInt32LE(80);
    const expectedLength = 84 + triangleCount * 50;
    expect(buf.length).toBe(expectedLength);
    // A box should produce non-zero triangles.
    expect(triangleCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// (c) Empty document — valid empty STL, not an error
// ---------------------------------------------------------------------------

describe('GET /export/stl — empty document', () => {
  it('returns 200 with a valid empty ASCII STL when the document has no 3D entities', async () => {
    // No applyCommand — document is empty.
    const res = await request(app).get('/export/stl');

    expect(res.status).toBe(200);
    expect(res.text.startsWith('solid ')).toBe(true);
    expect(res.text).toContain('endsolid');
    // No triangles → no 'facet normal' lines.
    expect(res.text).not.toContain('facet normal');
  });

  it('returns 200 with a valid empty binary STL (84 bytes) for an empty document', async () => {
    const res = await request(app)
      .get('/export/stl')
      .query({ format: 'binary' })
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    const buf = res.body as Buffer;
    // Empty solid: 80-byte header + 4-byte zero count = 84 bytes.
    const triangleCount = buf.readUInt32LE(80);
    expect(triangleCount).toBe(0);
    expect(buf.length).toBe(84);
  });
});

// ---------------------------------------------------------------------------
// (d) Custom name param
// ---------------------------------------------------------------------------

describe('GET /export/stl — custom name', () => {
  it('uses the name query param in Content-Disposition and inside the STL body (ascii)', async () => {
    const res = await request(app)
      .get('/export/stl')
      .query({ name: 'mypart' });

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/filename="mypart\.stl"/);
    // Solid name appears in the ASCII STL wrapper.
    expect(res.text).toContain('solid mypart');
    expect(res.text).toContain('endsolid mypart');
  });
});

// ---------------------------------------------------------------------------
// (e) Unrecognised format falls back to ascii (tolerance mirror)
// ---------------------------------------------------------------------------

describe('GET /export/stl — format fallback', () => {
  it('falls back to ascii for an unknown format value', async () => {
    const res = await request(app)
      .get('/export/stl')
      .query({ format: 'svg' }); // not a recognised format

    expect(res.status).toBe(200);
    expect(res.text.startsWith('solid ')).toBe(true);
  });
});
