/**
 * export_3mf toFile on the server host (05 IMP 14.12): the real file port writes the package in chunks, `--save` moves it, and (LLULL_SLOW_TESTS=1) a body above the
 * 8 million triangle ceiling of the in-memory path exports without a single string. The slow test prints its time and memory.
 */

import { closeSync, createReadStream, fstatSync, mkdtempSync, openSync, readFileSync, readSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInflateRaw } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { MeshAssetPort } from '@core/geometry/mesh/assets';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { CRC32_INIT, crc32Final, crc32Update } from '@lib/crc32';
import { unzip } from '@lib/zipRead';
import { saveDataFiles } from '../src/cli/saveFiles';
import { exportFilePort } from '../src/exportFiles';

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
  const directory = mkdtempSync(path.join(tmpdir(), 'llull-export-test-'));
  const context = (port: MeshAssetPort): ExecutionContext => ({
    ...defaultContext(),
    meshAssets: port,
    exportFiles: exportFilePort(directory),
  });

  it('writes a package equal to the in-memory one, and --save moves it to its target', () => {
    const { doc, id, port } = assetDoc(gridMesh(401));
    const ctx = context(port);
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
    const target = path.join(directory, 'saved', 'plate.3mf');
    expect(saveDataFiles(hosted.data, target)).toEqual([{ path: target, bytes: written.length }]);
    expect(Buffer.compare(readFileSync(target), written)).toBe(0);
    rmSync(directory, { recursive: true, force: true });
  });

  it('names its refusals: a limit leaves no file behind', () => {
    const { doc, id, port } = assetDoc(gridMesh(401));
    const refused = execute(doc, 'export_3mf', { entityIds: [id], toFile: true, maxBytes: 5000 }, context(port));
    expect(refused.error?.code).toBe('EXPORT_MESH_TOO_LARGE');
    expect(refused.document).toBe(doc);
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
