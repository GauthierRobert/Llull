/** Streamed 3MF mesh objects: deflate stream parity with zlib, XML equal to the in-memory writer, and an export above the former 2M-triangle limit. */
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { defaultContext } from '@core/commands/context';
import { buildThreeMf } from '@core/commands/exchange/threeMf';
import { execute } from '@core/commands/registry';
import type { MeshAssetPort } from '@core/geometry/mesh/assets';
import { ThreeMfTooLargeError, modelSink } from '@core/commands/exchange/threeMfStream';
import { DeflateStream } from '@lib/deflateStream';
import type { CadDocument } from '@core/model/types';
import { empty, ok } from '../implicit/helpers';

interface ZipRead {
  readonly name: string;
  readonly method: number;
  readonly data: Uint8Array;
}

/** Entries of a ZIP read from its central directory. */
function readZip(bytes: Uint8Array): ZipRead[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(bytes.length - 22 + 10, true);
  let at = view.getUint32(bytes.length - 22 + 16, true);
  const out: ZipRead[] = [];
  for (let i = 0; i < count; i += 1) {
    const method = view.getUint16(at + 10, true);
    const stored = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    out.push({ name, method, data: bytes.subarray(start, start + stored) });
    at += 46 + nameLength;
  }
  return out;
}

const modelOf = (bytes: Uint8Array): { method: number; text: string } => {
  const entry = readZip(bytes).find((e) => e.name === '3D/3dmodel.model');
  if (entry === undefined) throw new Error('no model part');
  return { method: entry.method, text: new TextDecoder().decode(entry.method === 8 ? inflateRawSync(entry.data) : entry.data) };
};

describe('DeflateStream', () => {
  it('produces a raw deflate stream that zlib inflates to the input across blocks and window slides', () => {
    const random = new Uint8Array(200_000);
    let seed = 12345;
    for (let i = 0; i < random.length; i += 1) {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      random[i] = seed >>> 24;
    }
    const text = new TextEncoder().encode('     <triangle v1="123" v2="456" v3="789"/>\n'.repeat(30_000));
    const stream = new DeflateStream();
    for (const part of [random, text, new Uint8Array(0), text.subarray(0, 70_001), random.subarray(5, 100_000)]) stream.write(part);
    const { chunks, size } = stream.finish();
    expect(chunks.reduce((sum, chunk) => sum + chunk.length, 0)).toBe(size);
    const packed = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      packed.set(chunk, at);
      at += chunk.length;
    }
    const expected = Buffer.concat([random, text, text.subarray(0, 70_001), random.subarray(5, 100_000)]);
    expect(Buffer.compare(inflateRawSync(packed), expected)).toBe(0);
    expect(size).toBeLessThan(expected.length);
  });

  it('inflates an empty stream to nothing', () => {
    const { chunks } = new DeflateStream().finish();
    expect(inflateRawSync(chunks[0] as Uint8Array).length).toBe(0);
  });
});

describe('buildThreeMf with an indexed body', () => {
  const raw = [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1];
  const rawIndices = [0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5];
  /** Vertices renumbered in order of first use, as the welding writer and canonical asset meshes do. */
  const order = [...new Set(rawIndices)];
  const positions = order.flatMap((v) => raw.slice(3 * v, 3 * v + 3));
  const indices = rawIndices.map((v) => order.indexOf(v));
  const triangles = Array.from({ length: indices.length / 3 }, (_, t) =>
    [0, 1, 2].map((k) => [0, 1, 2].map((axis) => positions[3 * (indices[3 * t + k] as number) + axis] as number)),
  ) as Array<[[number, number, number], [number, number, number], [number, number, number]]>;

  it('writes the same model XML as the in-memory writer, deflated, and reports the same counts', () => {
    const plain = buildThreeMf([{ name: 'cube', color: '#336699', tris: triangles }]);
    const streamed = buildThreeMf([
      { name: 'cube', color: '#336699', tris: [], indexed: { positions, indices, offset: [0, 0, 0], scale: 1 } },
    ]);
    expect(modelOf(plain.bytes).method).toBe(0);
    expect(modelOf(streamed.bytes).method).toBe(8);
    expect(modelOf(streamed.bytes).text).toBe(modelOf(plain.bytes).text);
    expect(streamed.objects).toEqual(plain.objects);
  });

  it('applies offset and scale, drops degenerate triangles and skips a body without a triangle', () => {
    const built = buildThreeMf([
      {
        name: 'moved',
        color: '#336699',
        tris: [],
        indexed: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2, 0, 0, 1], offset: [1, 0, 0], scale: 2 },
      },
      { name: 'empty', color: '#336699', tris: [], indexed: { positions: [], indices: [], offset: [0, 0, 0], scale: 1 } },
    ]);
    const text = modelOf(built.bytes).text;
    expect(text).toContain('<vertex x="2" y="0" z="0"/>');
    expect(text).toContain('<vertex x="4" y="0" z="0"/>');
    expect(text.match(/<triangle /g)).toHaveLength(1);
    expect(built.objects).toHaveLength(1);
    expect(built.objects[0]).toMatchObject({ name: 'moved', vertices: 3, triangles: 1, manifold: false });
  });
});

describe('export_3mf of a mesh above the former 2 million triangle limit', () => {
  it('streams a 2.2 million triangle asset mesh into a deflated model part', () => {
    const sphere = ok(empty(), 'add_field_primitive', { shape: 'sphere', radius: 2 });
    const body = ok(sphere.doc, 'create_implicit_body', { field: sphere.id, voxel: 0.5 });
    const entity = body.doc.entities[body.id];
    if (entity?.kind !== 'mesh') throw new Error('mesh body expected');
    const [columns, rows] = [1101, 1001];
    const positions: number[] = [];
    for (let r = 0; r < rows; r += 1)
      for (let c = 0; c < columns; c += 1) positions.push(c * 0.01, r * 0.01, (c + r) % 7 === 0 ? 0.001 : 0);
    const indices: number[] = [];
    for (let r = 0; r + 1 < rows; r += 1)
      for (let c = 0; c + 1 < columns; c += 1) {
        const a = r * columns + c;
        indices.push(a, a + 1, a + columns, a + 1, a + columns + 1, a + columns);
      }
    const triangleCount = indices.length / 3;
    const data = (result: { data?: unknown }): Record<string, unknown> => (result.data ?? {}) as Record<string, unknown>;
    expect(triangleCount).toBeGreaterThan(2_000_000);
    const ref = {
      key: 'k'.repeat(64),
      triangles: triangleCount,
      vertices: positions.length / 3,
      bounds: { min: [0, 0, 0], max: [11, 10, 1] },
    } as const;
    const port: MeshAssetPort = {
      manifest: () => null,
      readMesh: () => ({ positions, indices }),
      writeMesh: () => ref,
      readFile: () => null,
    };
    const doc: CadDocument = { ...body.doc, entities: { ...body.doc.entities, [body.id]: { ...entity, asset: ref } } };
    const result = execute(doc, 'export_3mf', { entityIds: [body.id] }, { ...defaultContext(), meshAssets: port });
    expect(result.error).toBeUndefined();
    expect(result.document).toBe(doc);
    expect(data(result)['triangleCount']).toBe(triangleCount);
    const bytes = Buffer.from(data(result)['base64'] as string, 'base64');
    const model = readZip(bytes).find((e) => e.name === '3D/3dmodel.model');
    expect(model?.method).toBe(8);
    expect(bytes.length).toBeLessThan(250_000_000);
    const text = inflateRawSync(model?.data as Uint8Array).toString('latin1');
    expect(text.split('<triangle ').length - 1).toBe(triangleCount);
    expect(text.split('<vertex ').length - 1).toBe(positions.length / 3);
  }, 240_000);
});

describe('limits', () => {
  it('modelSink stops past its deflated-size limit', () => {
    const sink = modelSink(1000);
    const noisy = Array.from({ length: 4000 }, (_, i) => String((i * 7919) % 100003)).join(',');
    expect(() => {
      sink.push(noisy);
      sink.push(noisy);
      sink.done();
    }).toThrow(ThreeMfTooLargeError);
    expect(() => modelSink().done()).not.toThrow();
  });

  it('refuses a rotated (non-indexed) mesh above 2 million triangles with EXPORT_MESH_TOO_LARGE and leaves the document unchanged', () => {
    const box = ok(empty(), 'add_box', { size: [2, 2, 2] });
    const entity = box.doc.entities[box.id];
    if (entity === undefined) throw new Error('box expected');
    const ref = { key: 'k'.repeat(64), triangles: 2_000_001, vertices: 3, bounds: { min: [0, 0, 0], max: [1, 1, 1] } } as const;
    const mesh = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: new Array<number>(6_000_003).fill(0) };
    const port: MeshAssetPort = { manifest: () => null, readMesh: () => mesh, writeMesh: () => ref, readFile: () => null };
    const asMesh = {
      ...entity,
      kind: 'mesh',
      mesh: { positions: [], indices: [] },
      asset: ref,
      rotation: [0.1, 0, 0],
    } as unknown as CadDocument['entities'][string];
    const doc: CadDocument = { ...box.doc, entities: { ...box.doc.entities, [box.id]: asMesh } };
    const result = execute(doc, 'export_3mf', { entityIds: [box.id] }, { ...defaultContext(), meshAssets: port });
    expect(result.error?.code).toBe('EXPORT_MESH_TOO_LARGE');
    expect(result.document).toBe(doc);
  });
});
