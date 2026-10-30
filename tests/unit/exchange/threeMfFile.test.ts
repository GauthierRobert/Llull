/** 3MF written straight to a host file sink (05 IMP 14.12): the same bytes as the in-memory archive, no base64, limits and refusals by name. */
import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { buildThreeMf, writeThreeMf, type ThreeMfBody } from '@core/commands/exchange/threeMf';
import { ThreeMfTooLargeError } from '@core/commands/exchange/threeMfStream';
import { execute } from '@core/commands/registry';
import type { ExecutionContext, ExportFilePort } from '@core/commands/types';
import type { MeshAssetPort } from '@core/geometry/mesh/assets';
import type { CadDocument } from '@core/model/types';
import { DeflateStream } from '@lib/deflateStream';
import { unzip } from '@lib/zipRead';
import { empty, ok } from '../implicit/helpers';

/** A flat grid of 2 * 520 * 300 = 312000 triangles (above the 250000 streaming threshold). */
function gridMesh(): { positions: number[]; indices: number[] } {
  const [columns, rows] = [521, 301];
  const positions: number[] = [];
  for (let r = 0; r < rows; r += 1) for (let c = 0; c < columns; c += 1) positions.push(c * 0.01, r * 0.01, (c + r) % 5 === 0 ? 0.001 : 0);
  const indices: number[] = [];
  for (let r = 0; r + 1 < rows; r += 1)
    for (let c = 0; c + 1 < columns; c += 1) {
      const a = r * columns + c;
      indices.push(a, a + 1, a + columns, a + 1, a + columns + 1, a + columns);
    }
  return { positions, indices };
}

function assetDoc(mesh: { positions: number[]; indices: number[] }): { doc: CadDocument; id: string; port: MeshAssetPort } {
  const sphere = ok(empty(), 'add_field_primitive', { shape: 'sphere', radius: 2 });
  const body = ok(sphere.doc, 'create_implicit_body', { field: sphere.id, voxel: 0.5 });
  const entity = body.doc.entities[body.id];
  if (entity?.kind !== 'mesh') throw new Error('mesh body expected');
  const ref = {
    key: 'k'.repeat(64),
    triangles: mesh.indices.length / 3,
    vertices: mesh.positions.length / 3,
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
  } as const;
  const port: MeshAssetPort = { manifest: () => null, readMesh: () => mesh, writeMesh: () => ref, readFile: () => null };
  return { doc: { ...body.doc, entities: { ...body.doc.entities, [body.id]: { ...entity, asset: ref } } }, id: body.id, port };
}

/** An in-memory file: growing buffer, random-access patch. */
function memoryFile(): {
  sink: { write(c: Uint8Array): void; patch(o: number, b: Uint8Array): void };
  bytes(): Uint8Array;
  chunks: number[];
} {
  let data = new Uint8Array(1 << 20);
  let length = 0;
  const chunks: number[] = [];
  return {
    sink: {
      write(chunk) {
        chunks.push(chunk.length);
        if (length + chunk.length > data.length) {
          const bigger = new Uint8Array(Math.max(data.length * 2, length + chunk.length));
          bigger.set(data.subarray(0, length));
          data = bigger;
        }
        data.set(chunk, length);
        length += chunk.length;
      },
      patch: (offset, bytes) => data.set(bytes, offset),
    },
    bytes: () => data.subarray(0, length),
    chunks,
  };
}

function portOf(files: Array<ReturnType<typeof memoryFile>>, events: string[]): ExportFilePort {
  return {
    open: (name) => {
      const file = memoryFile();
      files.push(file);
      return {
        write: file.sink.write,
        patch: file.sink.patch,
        close: () => {
          events.push('close');
          return { path: `/exports/${name}` };
        },
        abort: () => events.push('abort'),
      };
    },
  };
}

describe('writeThreeMf', () => {
  const mesh = gridMesh();
  const body: ThreeMfBody = {
    name: 'grid',
    color: '#336699',
    tris: [],
    indexed: { positions: mesh.positions, indices: mesh.indices, offset: [0, 0, 0], scale: 1 },
  };

  it('writes exactly the archive the in-memory path builds, in chunks, and the model inflates to the same XML', () => {
    const file = memoryFile();
    const written = writeThreeMf([body], file.sink);
    const memory = buildThreeMf([body]);
    expect(Buffer.compare(Buffer.from(file.bytes()), Buffer.from(memory.bytes))).toBe(0);
    expect(written.bytes).toBe(memory.bytes.length);
    expect(written.objects).toEqual(memory.objects);
    expect(file.chunks.length).toBeGreaterThan(5);
    expect(Math.max(...file.chunks)).toBeLessThanOrEqual(1 << 16);
    const entries = unzip(file.bytes());
    expect(entries.map((entry) => entry.name)).toEqual(['[Content_Types].xml', '_rels/.rels', '3D/3dmodel.model']);
    const model = (bytes: Uint8Array): string => new TextDecoder().decode(unzip(bytes)[2]?.data);
    expect(model(file.bytes())).toBe(model(memory.bytes));
    expect(model(file.bytes())).toContain('<triangle v1=');
  });

  it('refuses past its limit by name and holds no compressed bytes in the stream', () => {
    expect(() => writeThreeMf([body], memoryFile().sink, 20_000)).toThrow(ThreeMfTooLargeError);
    const held = new DeflateStream(() => undefined);
    held.write(new TextEncoder().encode('<triangle/>\n'.repeat(50_000)));
    expect(held.finish().chunks).toHaveLength(0);
  });
});

describe('export_3mf toFile', () => {
  const { doc, id, port } = assetDoc(gridMesh());
  const context = (files: ExportFilePort | null): ExecutionContext => ({ ...defaultContext(), meshAssets: port, exportFiles: files });

  it('writes to the host file and returns its path instead of base64', () => {
    const files: Array<ReturnType<typeof memoryFile>> = [];
    const events: string[] = [];
    const result = execute(doc, 'export_3mf', { entityIds: [id], toFile: true, name: 'big' }, context(portOf(files, events)));
    expect(result.error).toBeUndefined();
    const data = result.data as { triangleCount: number; base64?: string; file: { path: string; bytes: number }; fileName: string };
    expect(data.base64).toBeUndefined();
    expect(data.file).toEqual({ path: '/exports/big.3mf', bytes: files[0]?.bytes().length });
    expect(data.triangleCount).toBe(312_000);
    expect(events).toEqual(['close']);
    expect(result.document).toBe(doc);
  });

  it('refuses by name without a sink, discards a partial file on a refusal, and stays in memory below the automatic threshold', () => {
    const none = execute(doc, 'export_3mf', { entityIds: [id], toFile: true }, context(null));
    expect(none.error?.code).toBe('EXPORT_SINK_UNAVAILABLE');
    expect(none.document).toBe(doc);
    const files: Array<ReturnType<typeof memoryFile>> = [];
    const events: string[] = [];
    const tooBig = execute(doc, 'export_3mf', { entityIds: [id], toFile: true, maxBytes: 1000 }, context(portOf(files, events)));
    expect(tooBig.error?.code).toBe('EXPORT_MESH_TOO_LARGE');
    expect(events).toEqual(['abort']);
    const automatic = execute(doc, 'export_3mf', { entityIds: [id] }, context(portOf([], [])));
    expect(typeof (automatic.data as { base64?: string }).base64).toBe('string');
    const forcedMemory = execute(doc, 'export_3mf', { entityIds: [id], toFile: false }, context(portOf([], [])));
    expect(typeof (forcedMemory.data as { base64?: string }).base64).toBe('string');
  });

  it('answers an I/O error of the host file with EXPORT_SINK_FAILED (document unchanged, partial file discarded), and an open that throws as unavailable', () => {
    const events: string[] = [];
    let writes = 0;
    const failing: ExportFilePort = {
      open: () => ({
        write: () => {
          writes += 1;
          if (writes === 3) throw new Error('ENOSPC: no space left on device');
        },
        patch: () => undefined,
        close: () => ({ path: '/never' }),
        abort: () => events.push('abort'),
      }),
    };
    const failed = execute(doc, 'export_3mf', { entityIds: [id], toFile: true }, context(failing));
    expect(failed.error?.code).toBe('EXPORT_SINK_FAILED');
    expect(failed.summary).toContain('ENOSPC');
    expect(failed.document).toBe(doc);
    expect(events).toEqual(['abort']);
    const throwing: ExportFilePort = {
      open: () => {
        throw new Error('EACCES');
      },
    };
    expect(execute(doc, 'export_3mf', { entityIds: [id], toFile: true }, context(throwing)).error?.code).toBe('EXPORT_SINK_UNAVAILABLE');
  });
});
