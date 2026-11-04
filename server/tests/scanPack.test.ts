/**
 * `llull pack --with-scans` / `llull unpack` (plant 10 §13.9): a document with the point-cloud assets it references as one archive. Real assets come
 * from `llull-compute cloud import` (native cases are skipped with a logged reason without the binary); the refusals, the hostile archives and the CLI
 * usage need no binary.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deserializeDocument } from '@core/commands/persistence/serialization';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { zipStore, type ZipEntry } from '@lib/zip';
import { canonicalJson } from '@lib/canonicalJson';
import { createComputeRunner } from '../src/native/computeJob';
import { nativeBinaryPath } from '../src/native/nativeBinary';
import { writeDocumentFile } from '../src/documentFile';
import { sha256Hex } from '../src/sha256';
import { packDocument, unpackDocument } from '../src/scan/scanPack';
import { runScanImport } from '../src/scan/scanImport';
import { DEFAULT_IMPORT_OPTIONS, hasAsset } from '../src/scan/scanStore';
import { createPointCloudPort } from '../src/scan/pointCloudPort';
import { EXIT_COMMAND_ERROR, EXIT_OK, EXIT_USAGE, runCli, type CliIo } from '../src/cli/main';

const DATA = path.resolve(__dirname, '../../docs/plant/10-pointcloud-brownfield/validation/data');
const BINARY = nativeBinaryPath('llull-compute');
if (BINARY === null)
  console.warn('scanPack: llull-compute not built (cargo build --profile compute -p llull-compute in solver/): native cases skipped');
const native = BINARY === null ? it.skip : it;

let root = '';
let store = '';
beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'llull-scan-pack-'));
  store = path.join(root, 'store');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function cli(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
      readStdin: () => Promise.resolve(''),
      env: {},
      prepareKernel: () => Promise.resolve(),
    },
    out,
    err,
  };
}

/** A document file that attaches `keys` (as assets the store may or may not hold: attach takes the key, replay needs no port). */
function documentWith(name: string, keys: readonly string[]): string {
  let doc: CadDocument = { ...createEmptyDocument(), units: 'm' };
  for (const assetKey of keys) doc = execute(doc, 'attach_point_cloud', { assetKey }, defaultContext()).document;
  const file = path.join(root, `${name}.llull`);
  writeDocumentFile(file, doc);
  return file;
}

async function importPack(file: string, into: string): Promise<string> {
  const imported = await runScanImport(
    { path: path.join(DATA, file), options: DEFAULT_IMPORT_OPTIONS },
    { runner: createComputeRunner(process.env, BINARY), store: into, env: process.env },
  );
  if (!imported.ok) throw new Error(imported.message);
  return imported.assetKey;
}

const KEY_X = 'a'.repeat(64);

describe('pack refusals', () => {
  it('refuses an unreadable document and names every missing asset (nothing is written)', () => {
    const out = path.join(root, 'none.zip');
    expect(packDocument({ document: path.join(root, 'absent.llull'), out, withScans: true, store })).toMatchObject({
      ok: false,
      code: 'SCN_PACK_DOCUMENT_UNREADABLE',
    });
    const text = path.join(root, 'text.llull');
    writeFileSync(text, 'not a document');
    expect(packDocument({ document: text, out, withScans: false, store })).toMatchObject({
      ok: false,
      code: 'SCN_PACK_DOCUMENT_UNREADABLE',
    });
    const doc = documentWith('missing', [KEY_X, 'b'.repeat(64)]);
    const missing = packDocument({ document: doc, out, withScans: true, store });
    expect(missing).toMatchObject({ ok: false, code: 'SCN_PACK_ASSET_MISSING' });
    expect(missing.ok ? '' : missing.message).toContain(KEY_X);
    expect(missing.ok ? '' : missing.message).toContain('b'.repeat(64));
    expect(existsSync(out)).toBe(false);
  });

  it('packs the document alone (listing the assets it references) without --with-scans', () => {
    const doc = documentWith('alone', [KEY_X]);
    const out = path.join(root, 'alone.zip');
    const packed = packDocument({ document: doc, out, withScans: false, store });
    expect(packed).toMatchObject({ ok: true, assetKeys: [KEY_X], included: [] });
    const installed = unpackDocument({
      archive: out,
      documentOut: path.join(root, 'alone-out.llull'),
      store: path.join(root, 'store-alone'),
    });
    expect(installed).toMatchObject({ ok: true, installed: [], notIncluded: [KEY_X] });
    expect(readFileSync(path.join(root, 'alone-out.llull'))).toEqual(readFileSync(doc));
  });
});

describe('unpack of hostile archives', () => {
  const documentBytes = Buffer.from(readFileSync(documentWith('hostile-base', [])));
  const manifest = (extra: Record<string, unknown> = {}): ZipEntry => ({
    name: 'pack.json',
    data: Buffer.from(
      canonicalJson({
        version: 1,
        document: { name: 'document.llull', sha256: sha256Hex(documentBytes) },
        assetKeys: [],
        scans: [],
        ...extra,
      }),
    ),
  });
  const archive = (name: string, entries: ZipEntry[]): string => {
    const file = path.join(root, `${name}.zip`);
    writeFileSync(file, zipStore(entries));
    return file;
  };
  const document: ZipEntry = { name: 'document.llull', data: documentBytes };
  const unpack = (file: string, extra: Partial<Parameters<typeof unpackDocument>[0]> = {}): ReturnType<typeof unpackDocument> =>
    unpackDocument({
      archive: file,
      documentOut: path.join(root, `${path.basename(file)}.out.llull`),
      store: path.join(root, 'store-hostile'),
      ...extra,
    });

  it('refuses what is not a pack: bytes that are not a zip, no manifest, an unlisted or traversing entry name', () => {
    const garbage = path.join(root, 'garbage.zip');
    writeFileSync(garbage, 'PK but not really');
    expect(unpack(garbage)).toMatchObject({ ok: false, code: 'SCN_PACK_INVALID' });
    expect(unpack(archive('no-manifest', [document]))).toMatchObject({ ok: false, code: 'SCN_PACK_INVALID' });
    for (const name of [
      '../evil.llull',
      '/abs/evil',
      'scans/../../evil',
      `scans/${KEY_X}/../../x`,
      `scans/${KEY_X}/extra.bin`,
      'scans/short/manifest.json',
    ])
      expect(unpack(archive('names', [manifest(), document, { name, data: Buffer.from('x') }])), name).toMatchObject({
        ok: false,
        code: 'SCN_PACK_INVALID',
      });
    expect(existsSync(path.join(root, '..', 'evil.llull'))).toBe(false);
  });

  it('refuses a malformed pack.json and a manifest whose paths do not belong to the asset', () => {
    const base = (data: unknown): ZipEntry => ({
      name: 'pack.json',
      data: Buffer.from(typeof data === 'string' ? data : JSON.stringify(data)),
    });
    for (const bad of ['{not json', { version: 2 }, { version: 1 }, { version: 1, document: { sha256: 'zz' }, assetKeys: [], scans: [] }])
      expect(unpack(archive('bad-manifest', [base(bad), document])), JSON.stringify(bad)).toMatchObject({
        ok: false,
        code: 'SCN_PACK_INVALID',
      });
    const stray = manifest({
      scans: [
        {
          assetKey: KEY_X,
          sourceName: 's',
          pointCount: 1,
          files: [{ path: `scans/${'b'.repeat(64)}/nodes.bin`, bytes: 1, sha256: 'c'.repeat(64) }],
        },
      ],
    });
    expect(unpack(archive('stray', [stray, document]))).toMatchObject({ ok: false, code: 'SCN_PACK_INVALID' });
  });

  it('refuses a document or file that does not match its sha256, an existing target and a zip over the byte cap', () => {
    const tampered: ZipEntry = { name: 'document.llull', data: Buffer.concat([documentBytes, Buffer.from(' ')]) };
    expect(unpack(archive('tampered', [manifest(), tampered]))).toMatchObject({ ok: false, code: 'SCN_PACK_CHECKSUM' });
    const file = archive('good', [manifest(), document]);
    const target = path.join(root, 'good-target.llull');
    expect(unpack(file, { documentOut: target })).toMatchObject({ ok: true });
    expect(unpack(file, { documentOut: target })).toMatchObject({ ok: false, code: 'SCN_PACK_EXISTS' });
    expect(unpack(file, { documentOut: target, overwrite: true })).toMatchObject({ ok: true });
    expect(unpack(file, { maxBytes: 10 })).toMatchObject({ ok: false, code: 'SCN_PACK_INVALID' });
    const files = [{ path: `scans/${KEY_X}/manifest.json`, bytes: 2, sha256: sha256Hex('{}') }];
    const listed = manifest({ assetKeys: [KEY_X], scans: [{ assetKey: KEY_X, sourceName: 's', pointCount: 1, files }] });
    expect(unpack(archive('lacks', [listed, document]))).toMatchObject({ ok: false, code: 'SCN_PACK_INVALID' });
    const fake: ZipEntry = { name: `scans/${KEY_X}/manifest.json`, data: Buffer.from('{}') };
    expect(
      unpack(
        archive('wrong-size', [
          manifest({
            assetKeys: [KEY_X],
            scans: [{ assetKey: KEY_X, sourceName: 's', pointCount: 1, files: [{ ...files[0], bytes: 3 }] }],
          }),
          document,
          fake,
        ]),
      ),
    ).toMatchObject({ ok: false, code: 'SCN_PACK_CHECKSUM' });
  });

  it('installs nothing when an asset is not a valid asset (sha256 right, content wrong)', () => {
    const names = ['manifest.json', 'hierarchy.bin', 'nodes.bin'];
    const entries: ZipEntry[] = names.map((name) => ({ name: `scans/${KEY_X}/${name}`, data: Buffer.from('{}') }));
    const files = entries.map((e) => ({ path: e.name, bytes: 2, sha256: sha256Hex(e.data) }));
    const target = path.join(root, 'store-invalid-asset');
    const result = unpack(
      archive('invalid-asset', [
        manifest({ assetKeys: [KEY_X], scans: [{ assetKey: KEY_X, sourceName: 's', pointCount: 1, files }] }),
        document,
        ...entries,
      ]),
      { store: target },
    );
    expect(result).toMatchObject({ ok: false, code: 'SCN_PACK_CHECKSUM' });
    expect(existsSync(target) ? readdirSync(target) : []).toEqual([]);
    expect(existsSync(path.join(root, 'invalid-asset.zip.out.llull'))).toBe(false);
  });
});

describe('llull pack / unpack (CLI)', () => {
  it('needs an archive, a file target and a sane --max-bytes', async () => {
    for (const argv of [
      ['pack'],
      ['unpack'],
      ['pack', '--with-scans'],
      ['pack', 'x.zip', '--app'],
      ['pack', 'x.zip', '--max-bytes', '0'],
    ]) {
      const c = cli();
      expect(await runCli(argv, c.io), argv.join(' ')).toBe(EXIT_USAGE);
      expect(c.err.join()).not.toBe('');
    }
  });

  it('refuses with the code on stderr and exit 1', async () => {
    const c = cli();
    expect(
      await runCli(
        ['pack', path.join(root, 'cli-none.zip'), '--doc', path.join(root, 'absent.llull'), '--with-scans', '--store', store],
        c.io,
      ),
    ).toBe(EXIT_COMMAND_ERROR);
    expect(c.err.join()).toContain('SCN_PACK_DOCUMENT_UNREADABLE');
  });

  native('packs a document with two real clouds byte-reproducibly and unpacks it into an empty store (VC pack and go)', async () => {
    const keys = [await importPack('synthetic/cyl-a.csv', store), await importPack('synthetic/clh-a.csv', store)];
    const doc = documentWith('two-clouds', keys);
    const out = path.join(root, 'two.zip');
    const packed = cli();
    expect(await runCli(['pack', out, '--doc', doc, '--with-scans', '--store', store, '--json'], packed.io)).toBe(EXIT_OK);
    expect(JSON.parse(packed.out.join())).toMatchObject({ ok: true, included: [...keys].sort() });
    const again = path.join(root, 'two-again.zip');
    expect(await runCli(['pack', again, '--doc', doc, '--with-scans', '--store', store], cli().io)).toBe(EXIT_OK);
    expect(readFileSync(again)).toEqual(readFileSync(out));
    const without = path.join(root, 'two-doc-only.zip');
    expect(await runCli(['pack', without, '--doc', doc, '--store', store], cli().io)).toBe(EXIT_OK);
    expect(readFileSync(without).length).toBeLessThan(readFileSync(out).length);

    const other = path.join(root, 'store-other');
    const target = path.join(root, 'moved.llull');
    const unpacked = cli();
    expect(await runCli(['unpack', out, '--to', target, '--store', other], unpacked.io)).toBe(EXIT_OK);
    expect(unpacked.out.join()).toContain('installed 2 scan asset(s)');
    expect(readFileSync(target)).toEqual(readFileSync(doc));
    for (const key of keys) {
      expect(hasAsset(other, key)).toBe(true);
      for (const file of ['manifest.json', 'hierarchy.bin', 'nodes.bin', 'source.sha256'])
        expect(readFileSync(path.join(other, key, file))).toEqual(readFileSync(path.join(store, key, file)));
    }
    expect(readdirSync(other).filter((name) => name.startsWith('.tmp-'))).toEqual([]);
    // The moved document answers on the other machine's store (the asset reads back through the port).
    const ctx = { ...defaultContext(), pointClouds: createPointCloudPort({ store: other, env: process.env, binary: BINARY }) };
    expect(deserializeDocument(readFileSync(target, 'utf8')).scan?.cloudOrder).toHaveLength(2);
    const again2 = cli();
    expect(await runCli(['unpack', out, '--to', path.join(root, 'moved2.llull'), '--store', other], again2.io)).toBe(EXIT_OK);
    expect(again2.out.join()).toContain('2 already there');
    expect(ctx.pointClouds?.manifest(keys[0] ?? '')?.pointCount).toBeGreaterThan(0);
  });

  native('refuses a corrupted asset block at pack time and a bit flip inside the archive at unpack time', async () => {
    const own = path.join(root, 'store-corrupt');
    const key = await importPack('synthetic/cyl-a.csv', own);
    const doc = documentWith('corrupt', [key]);
    const out = path.join(root, 'corrupt.zip');
    expect(packDocument({ document: doc, out, withScans: true, store: own })).toMatchObject({ ok: true });
    const bytes = readFileSync(out);
    const flipped = Buffer.from(bytes);
    flipped.writeUInt8(~flipped.readUInt8(Math.floor(flipped.length / 2)) & 0xff, Math.floor(flipped.length / 2));
    const damaged = path.join(root, 'flipped.zip');
    writeFileSync(damaged, flipped);
    const result = unpackDocument({
      archive: damaged,
      documentOut: path.join(root, 'flipped.llull'),
      store: path.join(root, 'store-flipped'),
    });
    expect(result.ok).toBe(false);
    expect(existsSync(path.join(root, 'flipped.llull'))).toBe(false);
    const nodes = path.join(own, key, 'nodes.bin');
    const block = readFileSync(nodes);
    block.writeUInt8(~block.readUInt8(Math.floor(block.length / 2)) & 0xff, Math.floor(block.length / 2));
    writeFileSync(nodes, block);
    const refused = packDocument({ document: doc, out: path.join(root, 'bad-block.zip'), withScans: true, store: own });
    expect(refused).toMatchObject({ ok: false, code: 'SCN_PACK_ASSET_CORRUPT' });
    expect(existsSync(path.join(root, 'bad-block.zip'))).toBe(false);
  });
});
