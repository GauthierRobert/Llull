/** GET /cfd/file/:sha256: the stored bytes, guarded like /live/snapshot; malformed hashes and traversal are refused. */

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

const cacheDir = vi_hoistedDir();
function vi_hoistedDir(): string {
  const dir = `${process.env['TMPDIR'] ?? '/tmp'}/llull-cfd-file-route-${process.pid}`;
  process.env['LLULL_FEA_CACHE'] = dir;
  return dir;
}

import { rmSync } from 'node:fs';
import request from 'supertest';
import { app } from '../src/index';
import { cfdFileStore } from '../src/cfd/fileStore';
import { defaultFeArtifactStore } from '../src/fea/artifactStore';

const TOKEN = 'secret-token';
const auth: [string, string] = ['Authorization', `Bearer ${TOKEN}`];

beforeEach(() => {
  process.env['LLULL_AUTH_TOKEN'] = TOKEN;
});
afterEach(() => {
  delete process.env['LLULL_AUTH_TOKEN'];
});
afterAll(() => rmSync(cacheDir, { recursive: true, force: true }));

const binary = (res: request.Response, done: (body: Buffer) => void): void => done(res.body as Buffer);

describe('GET /cfd/file/:sha256', () => {
  it('serves the stored bytes as application/octet-stream', async () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const hash = cfdFileStore(defaultFeArtifactStore().directory).put(bytes);
    let served: Buffer | null = null;
    const res = await request(app)
      .get(`/cfd/file/${hash}`)
      .set(...auth)
      .buffer(true)
      .parse((response, callback) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => callback(null, Buffer.concat(chunks)));
      });
    binary(res, (body) => (served = body));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/octet-stream');
    expect(served).not.toBeNull();
    expect(Buffer.compare(served as unknown as Buffer, bytes)).toBe(0);
  });

  it('answers 401 without the token', async () => {
    const hash = cfdFileStore(defaultFeArtifactStore().directory).put(Buffer.from('guarded'));
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
});
