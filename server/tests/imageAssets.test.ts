/**
 * RV1 RV-M1 host side: the content-addressed image asset store, `GET /assets/image/:key` (guarded like /live/snapshot, 400 for a bad key, 404 for an
 * unknown one, content type from the header), `file=PATH` of `import_texture` through the CLI and the server execution context.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';

const CACHE = mkdtempSync(path.join(tmpdir(), 'llull-image-cache-'));
process.env['LLULL_IMAGE_CACHE'] = CACHE;

import { app } from '../src/index';
import { EXIT_COMMAND_ERROR, EXIT_OK, runCli, type CliIo } from '../src/cli/main';
import { withFileContent } from '../src/cli/exchange';
import { serverContext } from '../src/fea/context';
import { createImageAssetStore, defaultImageAssetStore, imageCacheDir, isImageAssetKey } from '../src/imageAssets/store';

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const u32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const png = (width: number, height: number): Buffer =>
  Buffer.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...u32(13),
    0x49,
    0x48,
    0x44,
    0x52,
    ...u32(width),
    ...u32(height),
    8,
    6,
    0,
    0,
    0,
  ]);
const hdr = (width: number, height: number): Buffer => Buffer.from(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`);

const TOKEN = 'secret-token';
const auth: [string, string] = ['Authorization', `Bearer ${TOKEN}`];
const dir = mkdtempSync(path.join(tmpdir(), 'llull-image-files-'));

beforeEach(() => {
  process.env['LLULL_AUTH_TOKEN'] = TOKEN;
});
afterEach(() => {
  delete process.env['LLULL_AUTH_TOKEN'];
});
afterAll(() => {
  rmSync(CACHE, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

const bodyOf = (response: request.Response): Buffer => response.body as Buffer;
const binary = (response: request.Response, callback: (error: Error | null, body: Buffer) => void): void => {
  const chunks: Buffer[] = [];
  response.on('data', (chunk: Buffer) => chunks.push(chunk));
  response.on('end', () => callback(null, Buffer.concat(chunks)));
};

describe('image asset store', () => {
  it('writes content-addressed files once and reads them back by key; damaged files and bad keys read as missing', () => {
    const store = createImageAssetStore(path.join(CACHE, 'unit'));
    const bytes = png(8, 4);
    const key = store.writeImage(bytes);
    expect(key).toBe(sha(bytes));
    expect(store.writeImage(bytes)).toBe(key);
    expect(Buffer.from(store.readImage(key) as Uint8Array)).toEqual(bytes);
    expect(store.readImage('f'.repeat(64))).toBeNull();
    expect(store.readImage('../escape')).toBeNull();
    writeFileSync(path.join(CACHE, 'unit', key), 'tampered');
    expect(store.readImage(key)).toBeNull();
    expect(isImageAssetKey(key)).toBe(true);
    expect(isImageAssetKey(key.toUpperCase())).toBe(false);
  });

  it('honours LLULL_IMAGE_CACHE and defaults to ~/.llull/cache/image', () => {
    expect(imageCacheDir({ LLULL_IMAGE_CACHE: '/tmp/x-images' })).toBe(path.resolve('/tmp/x-images'));
    expect(imageCacheDir({})).toMatch(/\.llull[\\/]cache[\\/]image$/);
    expect(defaultImageAssetStore().dir).toBe(CACHE);
  });
});

describe('GET /assets/image/:key', () => {
  it('serves PNG, JPEG-less HDR and unknown bytes with the right content type and an immutable cache header', async () => {
    const png1 = png(16, 16);
    const key = defaultImageAssetStore().writeImage(png1);
    const res = await request(app)
      .get(`/assets/image/${key}`)
      .set(...auth)
      .buffer(true)
      .parse(binary);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['cache-control']).toContain('immutable');
    expect(bodyOf(res)).toEqual(png1);
    const hdrKey = defaultImageAssetStore().writeImage(hdr(8, 4));
    const hdrRes = await request(app)
      .get(`/assets/image/${hdrKey}`)
      .set(...auth);
    expect(hdrRes.headers['content-type']).toBe('image/vnd.radiance');
    const rawKey = defaultImageAssetStore().writeImage(Buffer.from('not an image'));
    const rawRes = await request(app)
      .get(`/assets/image/${rawKey}`)
      .set(...auth);
    expect(rawRes.headers['content-type']).toContain('application/octet-stream');
  });

  it('answers 400 for a malformed key, 404 for an unknown one and refuses a request without the token', async () => {
    const bad = await request(app)
      .get('/assets/image/not-a-key')
      .set(...auth);
    expect(bad.status).toBe(400);
    const traversal = await request(app)
      .get('/assets/image/..%2F..%2Fetc%2Fpasswd')
      .set(...auth);
    expect(traversal.status).toBeGreaterThanOrEqual(400);
    const missing = await request(app)
      .get(`/assets/image/${'e'.repeat(64)}`)
      .set(...auth);
    expect(missing.status).toBe(404);
    const key = defaultImageAssetStore().writeImage(png(2, 2));
    const anonymous = await request(app).get(`/assets/image/${key}`);
    expect([401, 403]).toContain(anonymous.status);
  });
});

describe('import_texture through the CLI and the server context', () => {
  const file = path.join(dir, 'albedo.png');
  const bytes = png(256, 128);
  writeFileSync(file, bytes);

  const capture = (): { io: CliIo; out: string[] } => {
    const out: string[] = [];
    return {
      io: {
        stdout: (t) => out.push(t),
        stderr: () => undefined,
        readStdin: () => Promise.resolve(''),
        env: {},
        prepareKernel: async () => undefined,
      },
      out,
    };
  };

  it('file=PATH stores the image in the image asset store and the document keeps only the 64 hex key', async () => {
    const doc = path.join(dir, 'tex.llull');
    const { io, out } = capture();
    const code = await runCli(['import_texture', 'name=albedo', `file=${file}`, '--doc', doc, '--json'], io);
    expect(code).toBe(EXIT_OK);
    const saved = readFileSync(doc, 'utf8');
    const key = /"key":"([0-9a-f]{64})"/.exec(saved)?.[1] as string;
    expect(key).toBe(sha(bytes));
    expect(existsSync(path.join(CACHE, key))).toBe(true);
    expect(saved).not.toContain('base64');
    expect(out.join('')).toContain('256 x 128');
  });

  it('a missing texture file is a command error and writes nothing', async () => {
    const { io } = capture();
    const code = await runCli(
      ['import_texture', 'name=x', `file=${path.join(dir, 'missing.png')}`, '--doc', path.join(dir, 'none.llull'), '--json'],
      io,
    );
    expect(code).not.toBe(EXIT_OK);
  });

  it('withFileContent maps file to fileKey for import_texture', () => {
    const params = withFileContent('import_texture', { name: 'albedo', file }) as Record<string, unknown>;
    expect(params['fileKey']).toBe(sha(bytes));
    expect(params['file']).toBeUndefined();
  });

  it('the server context lets import_texture read a fileKey and refuses an unknown one with TEXTURE_ASSET_UNAVAILABLE', () => {
    const key = defaultImageAssetStore().writeImage(bytes);
    const imported = execute(createEmptyDocument(), 'import_texture', { name: 'albedo', fileKey: key }, serverContext());
    expect(imported.affected).toHaveLength(1);
    const refused = execute(createEmptyDocument(), 'import_texture', { name: 'albedo', fileKey: '0'.repeat(64) }, serverContext());
    expect(refused.error?.code).toBe('TEXTURE_ASSET_UNAVAILABLE');
    expect(EXIT_COMMAND_ERROR).toBeGreaterThan(0);
  });
});
