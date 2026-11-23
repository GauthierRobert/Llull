/** GET /cfd/file/:sha256: the stored slice / streamline bytes, guarded like /live/snapshot; malformed hashes, traversal, oversized and non-result files are refused. */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';

const cacheDir = vi.hoisted(() => {
  const dir = `${process.env['TMPDIR'] ?? '/tmp'}/llull-cfd-file-route-${process.pid}`;
  process.env['LLULL_FEA_CACHE'] = dir;
  return dir;
});

import { app } from '../src/index';
import { cfdFileStore } from '../src/cfd/fileStore';
import { MAX_CFD_FILE_BYTES } from '../src/cfdFileRoutes';
import { defaultFeArtifactStore } from '../src/fea/artifactStore';

const TOKEN = 'secret-token';
const auth: [string, string] = ['Authorization', `Bearer ${TOKEN}`];
const store = (): ReturnType<typeof cfdFileStore> => cfdFileStore(defaultFeArtifactStore().directory);
const slice = (...tail: number[]): Buffer => Buffer.from([...Buffer.from('LLSL'), ...tail]);

beforeEach(() => {
  process.env['LLULL_AUTH_TOKEN'] = TOKEN;
});
afterEach(() => {
  delete process.env['LLULL_AUTH_TOKEN'];
});
afterAll(() => rmSync(cacheDir, { recursive: true, force: true }));

describe('GET /cfd/file/:sha256', () => {
  it('serves the stored bytes as application/octet-stream', async () => {
    const bytes = slice(0, 1, 2, 250, 251, 252, 253, 254, 255);
    const hash = store().put(bytes);
    const res = await request(app)
      .get(`/cfd/file/${hash}`)
      .set(...auth)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/octet-stream');
    expect(Buffer.compare(res.body as Buffer, bytes)).toBe(0);
  });

  it('answers 401 without the token', async () => {
    const hash = store().put(slice(7));
    expect((await request(app).get(`/cfd/file/${hash}`)).status).toBe(401);
    expect((await request(app).get(`/cfd/file/${hash}`).set('Authorization', 'Bearer nope')).status).toBe(401);
  });

  it('answers 404 for an absent file', async () => {
    expect(
      (
        await request(app)
          .get(`/cfd/file/${'0'.repeat(64)}`)
          .set(...auth)
      ).status,
    ).toBe(404);
  });

  it('answers 400 for a malformed hash', async () => {
    for (const bad of ['abc', 'A'.repeat(64), 'g'.repeat(64), '0'.repeat(65)]) {
      expect(
        (
          await request(app)
            .get(`/cfd/file/${bad}`)
            .set(...auth)
        ).status,
      ).toBe(400);
    }
  });

  it('refuses a traversal attempt', async () => {
    for (const bad of ['..%2F..%2Fetc%2Fpasswd', '..%2F', '%2e%2e%2f%2e%2e%2fpackage.json', `..%2F${'0'.repeat(60)}`]) {
      const res = await request(app)
        .get(`/cfd/file/${bad}`)
        .set(...auth);
      expect([400, 404]).toContain(res.status);
      expect(res.headers['content-type']).not.toContain('application/octet-stream');
    }
    expect(
      (
        await request(app)
          .get('/cfd/file/..%2F..%2Fx')
          .set(...auth)
      ).status,
    ).toBe(400);
  });

  it('refuses a file that is not a slice or streamline file (a solve field, any other stored bytes)', async () => {
    const hash = store().put(Buffer.from('LLFD field file'));
    const res = await request(app)
      .get(`/cfd/file/${hash}`)
      .set(...auth);
    expect(res.status).toBe(415);
    expect(res.headers['content-type']).not.toContain('application/octet-stream');
  });

  it('refuses a file over the size cap before reading it', async () => {
    const hash = 'c'.repeat(64);
    mkdirSync(store().directory, { recursive: true });
    const file = path.join(store().directory, `${hash}.bin`);
    writeFileSync(file, 'LLSL');
    truncateSync(file, MAX_CFD_FILE_BYTES + 1);
    const res = await request(app)
      .get(`/cfd/file/${hash}`)
      .set(...auth);
    expect(res.status).toBe(413);
  });

  it('answers 404 for a damaged file (content that no longer hashes to its name)', async () => {
    const hash = 'd'.repeat(64);
    mkdirSync(store().directory, { recursive: true });
    writeFileSync(path.join(store().directory, `${hash}.bin`), slice(1, 2, 3));
    const res = await request(app)
      .get(`/cfd/file/${hash}`)
      .set(...auth);
    expect(res.status).toBe(404);
  });
});
