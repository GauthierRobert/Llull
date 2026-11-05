/** VC-INT-21 (scan pack): a ~1 kB archive declaring a 900 MB deflated entry is refused as SCN_PACK_INVALID before anything is inflated. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { deflateRaw } from '@lib/deflate';
import { zipStore } from '@lib/zip';
import { unpackDocument } from '../src/scan/scanPack';

const dir = mkdtempSync(path.join(tmpdir(), 'llull-caps-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('scan pack importer', () => {
  it('refuses a deflated entry that declares 900 MB without allocating it', () => {
    const bytes = zipStore([{ name: 'document.llull', data: deflateRaw(new Uint8Array(100_000)) }]);
    const view = new DataView(bytes.buffer);
    const central = view.getUint32(bytes.length - 22 + 16, true);
    view.setUint16(8, 8, true);
    view.setUint32(22, 900_000_000, true);
    view.setUint16(central + 10, 8, true);
    view.setUint32(central + 24, 900_000_000, true);
    const archive = path.join(dir, 'hostile.llullpack');
    writeFileSync(archive, bytes);
    const before = process.memoryUsage().rss;
    const result = unpackDocument({ archive, documentOut: path.join(dir, 'document.llull'), store: path.join(dir, 'store') });
    expect(result).toMatchObject({ ok: false, code: 'SCN_PACK_INVALID' });
    expect(JSON.stringify(result)).toMatch(/not stored|lies about its size/);
    expect(process.memoryUsage().rss - before).toBeLessThan(800 * 2 ** 20);
  });
});
