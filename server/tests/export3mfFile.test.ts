/**
 * export_3mf toFile on the server host (05 IMP 14.12): the real file port writes the package in chunks, `--save` moves it, and (LLULL_SLOW_TESTS=1) a body above the
 * 8 million triangle ceiling of the in-memory path exports without a single string. The slow test prints its time and memory.
 */

import {
  closeSync,
  copyFileSync,
  mkdirSync,
  renameSync,
  createReadStream,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInflateRaw } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { MeshAssetPort } from '@core/geometry/mesh/assets';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { CRC32_INIT, crc32Final, crc32Update } from '@lib/crc32';
import { unzip } from '@lib/zipRead';
import { saveDataFiles } from '../src/cli/saveFiles';
import { type MoveOps, moveHostedFile } from '../src/hostedFile';
import { EXPORT_FILE_MAX_AGE_MS, exportFilePort, isHostedExport, reapExportFiles } from '../src/exportFiles';

interface GridMesh {
  readonly positions: Float64Array;
  readonly indices: Int32Array;
}

/** A jittered grid of 2 * (n - 1)^2 triangles; the jitter keeps the XML from compressing like a regular grid. */
function gridMesh(n: number): GridMesh {
  const positions = new Float64Array(n * n * 3);
  let seed = 12345;
  const random = (): number => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  for (let r = 0; r < n; r += 1)
    for (let c = 0; c < n; c += 1)
      positions.set([c * 0.01 + random() * 0.004, r * 0.01 + random() * 0.004, random() * 0.01], 3 * (r * n + c));
  const indices = new Int32Array(6 * (n - 1) * (n - 1));
  let at = 0;
  for (let r = 0; r + 1 < n; r += 1)
    for (let c = 0; c + 1 < n; c += 1) {
      const a = r * n + c;
      indices.set([a, a + 1, a + n, a + 1, a + n + 1, a + n], at);
      at += 6;
    }
  return { positions, indices };
}

function assetDoc(mesh: GridMesh): { doc: CadDocument; id: string; port: MeshAssetPort } {
  const sphere = execute(createEmptyDocument(), 'add_field_primitive', { shape: 'sphere', radius: 2 });
  const body = execute(sphere.document, 'create_implicit_body', { field: sphere.affected[0], voxel: 0.5 });
  const id = body.affected[0] as string;
  const entity = body.document.entities[id];
  if (entity?.kind !== 'mesh') throw new Error('mesh body expected');
  const ref = {
    key: 'k'.repeat(64),
    triangles: mesh.indices.length / 3,
    vertices: mesh.positions.length / 3,
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
  } as const;
  const asArrays = { positions: mesh.positions as unknown as number[], indices: mesh.indices as unknown as number[] };
  const port: MeshAssetPort = { manifest: () => null, readMesh: () => asArrays, writeMesh: () => ref, readFile: () => null };
  return { doc: { ...body.document, entities: { ...body.document.entities, [id]: { ...entity, asset: ref } } }, id, port };
}

interface Exported {
  readonly triangleCount: number;
  readonly fileName: string;
  readonly base64?: string;
  readonly file?: { path: string; bytes: number };
}

describe('export_3mf toFile with the server file port', () => {
  const folders: string[] = [];
  const freshDirectory = (): string => {
    const directory = mkdtempSync(path.join(tmpdir(), 'llull-export-test-'));
    folders.push(directory);
    return directory;
  };
  const context = (port: MeshAssetPort, directory: string): ExecutionContext => ({
    ...defaultContext(),
    meshAssets: port,
    exportFiles: exportFilePort(directory),
  });
  afterEach(() => {
    delete process.env['LLULL_EXPORT_DIR'];
    for (const directory of folders.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it('writes a package equal to the in-memory one, and --save moves it to its target', () => {
    const directory = freshDirectory();
    process.env['LLULL_EXPORT_DIR'] = directory;
    const { doc, id, port } = assetDoc(gridMesh(401));
    const ctx = context(port, directory);
    const memory = execute(doc, 'export_3mf', { entityIds: [id], toFile: false }, ctx).data as Exported;
    const hosted = execute(doc, 'export_3mf', { entityIds: [id], toFile: true, name: 'plate' }, ctx);
    const data = hosted.data as Exported;
    expect(hosted.error).toBeUndefined();
    expect(data.base64).toBeUndefined();
    expect(data.triangleCount).toBe(memory.triangleCount);
    const written = readFileSync((data.file as { path: string }).path);
    expect(Buffer.compare(written, Buffer.from(memory.base64 as string, 'base64'))).toBe(0);
    expect(data.file?.bytes).toBe(written.length);
    expect(unzip(written).map((entry) => entry.name)).toEqual(['[Content_Types].xml', '_rels/.rels', '3D/3dmodel.model']);
    const target = path.join(freshDirectory(), 'saved', 'plate.3mf');
    expect(saveDataFiles(hosted.data, target)).toEqual([{ path: target, bytes: written.length }]);
    expect(Buffer.compare(readFileSync(target), written)).toBe(0);
    expect(readdirSync(directory)).toEqual([]);
  });

  it('names its refusals: a limit leaves no file behind', () => {
    const directory = freshDirectory();
    const { doc, id, port } = assetDoc(gridMesh(401));
    const refused = execute(doc, 'export_3mf', { entityIds: [id], toFile: true, maxBytes: 5000 }, context(port, directory));
    expect(refused.error?.code).toBe('EXPORT_MESH_TOO_LARGE');
    expect(refused.document).toBe(doc);
    expect(readdirSync(directory)).toEqual([]);
  });

  it('reaps hosted files older than a day when a new one is opened, and --save moves only files of the export folder', () => {
    const directory = freshDirectory();
    const old = path.join(directory, 'old.3mf');
    const fresh = path.join(directory, 'fresh.3mf');
    writeFileSync(old, 'x');
    writeFileSync(fresh, 'y');
    const longAgo = new Date(Date.now() - 3 * EXPORT_FILE_MAX_AGE_MS);
    utimesSync(old, longAgo, longAgo);
    exportFilePort(directory).open('new.3mf')?.abort();
    expect(readdirSync(directory).sort()).toEqual(['fresh.3mf']);
    expect(reapExportFiles(directory, Date.now() + 2 * EXPORT_FILE_MAX_AGE_MS)).toBe(1);
    process.env['LLULL_EXPORT_DIR'] = directory;
    const elsewhere = path.join(freshDirectory(), 'precious.txt');
    writeFileSync(elsewhere, 'do not move me');
    expect(() => saveDataFiles({ file: { path: elsewhere, bytes: 14 } }, path.join(directory, 'target.bin'))).toThrow(/no file payload/);
    expect(readFileSync(elsewhere, 'utf8')).toBe('do not move me');
    expect(isHostedExport(path.join(directory, 'a.3mf'), directory)).toBe(true);
    expect(isHostedExport(path.join(directory, '..', 'a.3mf'), directory)).toBe(false);
  });
});

/** Inflates the model part of the package at `file` as a stream and checks its CRC-32 and size against the central directory (no whole-part buffer). */
async function verifyModelStream(file: string): Promise<{ xmlBytes: number; compressedBytes: number; entries: number }> {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const read = (length: number, position: number): Buffer => {
      const out = Buffer.alloc(length);
      readSync(fd, out, 0, length, position);
      return out;
    };
    const end = read(22, size - 22);
    const [entries, centralSize, centralStart] = [end.readUInt16LE(10), end.readUInt32LE(12), end.readUInt32LE(16)];
    const central = read(centralSize, centralStart);
    let at = 0;
    for (let i = 0; i < entries; i += 1) {
      const [crc, compressed, xml, nameLength, local] = [
        central.readUInt32LE(at + 16),
        central.readUInt32LE(at + 20),
        central.readUInt32LE(at + 24),
        central.readUInt16LE(at + 28),
        central.readUInt32LE(at + 42),
      ];
      const name = central.subarray(at + 46, at + 46 + nameLength).toString('utf8');
      at += 46 + nameLength;
      if (name !== '3D/3dmodel.model') continue;
      const header = read(30, local);
      const dataStart = local + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
      expect([header.readUInt32LE(14), header.readUInt32LE(18), header.readUInt32LE(22)]).toEqual([crc, compressed, xml]);
      let [state, total] = [CRC32_INIT, 0];
      await new Promise<void>((resolve, reject) => {
        const inflate = createInflateRaw();
        inflate.on('data', (chunk: Buffer) => {
          state = crc32Update(state, chunk);
          total += chunk.length;
        });
        inflate.on('end', resolve);
        inflate.on('error', reject);
        createReadStream(file, { start: dataStart, end: dataStart + compressed - 1 })
          .on('error', reject)
          .pipe(inflate);
      });
      expect([crc32Final(state), total]).toEqual([crc, xml]);
      return { xmlBytes: xml, compressedBytes: compressed, entries };
    }
    throw new Error('no model part in the central directory');
  } finally {
    closeSync(fd);
  }
}

const slow = process.env['LLULL_SLOW_TESTS'] === '1' ? it : it.skip;

describe('export_3mf above the in-memory ceiling (LLULL_SLOW_TESTS=1)', () => {
  slow(
    'writes a 22 million triangle body to a file whose model part inflates to the recorded CRC and size',
    async () => {
      const directory = mkdtempSync(path.join(tmpdir(), 'llull-export-big-'));
      const { doc, id, port } = assetDoc(gridMesh(3317));
      const started = performance.now();
      const rssBefore = process.memoryUsage().rss;
      let peak = rssBefore;
      const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 200);
      const result = execute(
        doc,
        'export_3mf',
        { entityIds: [id], toFile: true },
        { ...defaultContext(), meshAssets: port, exportFiles: exportFilePort(directory) },
      );
      clearInterval(sampler);
      peak = Math.max(peak, process.memoryUsage().rss);
      const seconds = (performance.now() - started) / 1000;
      expect(result.error, result.summary).toBeUndefined();
      const data = result.data as Exported;
      const file = (data.file as { path: string; bytes: number }).path;
      const checked = await verifyModelStream(file);
      process.stderr.write(
        `3MF FILE SINK: ${data.triangleCount} triangles, ${data.file?.bytes} bytes (model ${checked.xmlBytes} XML bytes -> ${checked.compressedBytes}), ${seconds.toFixed(1)} s, rss before ${(rssBefore / 1e6).toFixed(0)} MB, peak ${(peak / 1e6).toFixed(0)} MB
`,
      );
      expect(data.triangleCount).toBe(21_991_712);
      expect(data.base64).toBeUndefined();
      rmSync(directory, { recursive: true, force: true });
      // the same body in memory, for the record of the memory the sink saves
      const [memoryStart, rssMemory] = [performance.now(), process.memoryUsage().rss];
      let memoryPeak = rssMemory;
      const memorySampler = setInterval(() => (memoryPeak = Math.max(memoryPeak, process.memoryUsage().rss)), 200);
      const inMemory = execute(doc, 'export_3mf', { entityIds: [id], toFile: false }, { ...defaultContext(), meshAssets: port });
      clearInterval(memorySampler);
      memoryPeak = Math.max(memoryPeak, process.memoryUsage().rss);
      process.stderr.write(
        `3MF IN MEMORY: ${inMemory.error === undefined ? 'ok' : inMemory.error.code}, ${((performance.now() - memoryStart) / 1000).toFixed(1)} s, rss before ${(rssMemory / 1e6).toFixed(0)} MB, peak ${(memoryPeak / 1e6).toFixed(0)} MB
`,
      );
      expect(inMemory.error?.code, 'the in-memory package passes the 375000000 byte ceiling').toBe('EXPORT_MESH_TOO_LARGE');
    },
    1_800_000,
  );
});

describe('moving a hosted export (--save, desktop export)', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'llull-move-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const sameVolumeFails = (to: string, copy?: MoveOps['copyFileSync']): MoveOps => ({
    // a rename onto the final path fails (another volume, a locked target); the rename of the .part file works
    renameSync: (from, destination) => {
      if (destination === to && !from.endsWith('.part')) throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
      renameSync(from, destination);
    },
    copyFileSync: copy ?? copyFileSync,
    rmSync,
  });

  it('copies through a .part file when the rename fails, and leaves only the final file', () => {
    const [from, to] = [path.join(dir, 'hosted.3mf'), path.join(dir, 'out.3mf')];
    writeFileSync(from, 'package');
    moveHostedFile(from, to, sameVolumeFails(to));
    expect(readFileSync(to, 'utf8')).toBe('package');
    expect(readdirSync(dir).sort()).toEqual(['out.3mf']);
  });

  it('a failing copy leaves no partial file at the user path: the .part file and the hosted package are removed and the error is rethrown', () => {
    const [from, to] = [path.join(dir, 'hosted.3mf'), path.join(dir, 'out.3mf')];
    writeFileSync(from, 'package');
    const failing = sameVolumeFails(to, (_source, part) => {
      writeFileSync(part, 'pa');
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    });
    expect(() => moveHostedFile(from, to, failing)).toThrow(/ENOSPC/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('a hosted file outside the given export folder is not a hosted file (saveDataFiles refuses it)', () => {
    const [exports, outside] = [path.join(dir, 'exports'), path.join(dir, 'other.3mf')];
    mkdirSync(exports);
    writeFileSync(outside, 'x');
    expect(() => saveDataFiles({ file: { path: outside, bytes: 1 } }, path.join(dir, 'saved.3mf'), exports)).toThrow(/no file payload/);
    expect(readFileSync(outside, 'utf8')).toBe('x');
  });
});
