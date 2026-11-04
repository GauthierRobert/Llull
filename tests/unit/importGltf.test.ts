/** import_gltf: reading plain meshes, hierarchies and refusals of hostile files (VIS-M8d). */
import { describe, it, expect } from 'vitest';
import { execute } from '@core/commands/registry';
import { entityToTriangles } from '@core/geometry/entityTriangles';
import type { CommandResult } from '@core/commands/types';
import type { Triangle } from '@core/geometry/triangles';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { uint8ArrayToBase64 } from '@lib/base64';
import { dataUri, glb, triangleBytes, triangleGltf, type JsonObject } from '../helpers/gltfFixtures';

const doc0 = createEmptyDocument();
const importText = (json: JsonObject, extra: Record<string, unknown> = {}, doc: CadDocument = doc0): CommandResult =>
  execute(doc, 'import_gltf', { text: JSON.stringify(json), ...extra });
const worldTriangles = (doc: CadDocument): Triangle[] => doc.order.flatMap((id) => entityToTriangles(doc.entities[id]!, doc));
const refused = (json: JsonObject, code: string, extra: Record<string, unknown> = {}): void => {
  const result = importText(json, extra);
  expect(result.error?.code, result.summary).toBe(code);
  expect(result.rejected).toBe(true);
  expect(result.affected).toEqual([]);
  expect(result.document).toBe(doc0);
};
const accessorsWith = (index: number, accessor: JsonObject): JsonObject => {
  const json = triangleGltf();
  (json['accessors'] as JsonObject[])[index] = accessor;
  return json;
};
const round = (v: readonly number[] | undefined): number[] | undefined => v?.map((c) => Math.round(c * 1e6) / 1e6 + 0);

describe('import_gltf: plain meshes', () => {
  it('imports a one-triangle JSON file as a named mesh entity at its world coordinates', () => {
    const result = importText(triangleGltf());
    expect(result.affected).toHaveLength(1);
    const entity = result.document.entities[result.affected[0]!]!;
    expect(entity).toMatchObject({ kind: 'mesh', name: 'tri', position: [0, 0, 0], color: '#9aa5b1' });
    expect(result.document.order).toEqual(result.affected);
    expect(worldTriangles(result.document)).toEqual([
      [
        [0, 0, 0],
        [1, 0, 0],
        [0, 1, 0],
      ],
    ]);
    expect(result.data).toEqual({ meshEntities: 1, instances: 0, components: 0, triangles: 1, skippedPrimitives: 0, skippedInstances: 0 });
    expect(result.summary).toContain('1 mesh entity');
  });

  it('reads base64 bytes of a GLB (BIN chunk) and of a JSON file alike', () => {
    const json = triangleGltf({ buffers: [{ byteLength: 44 }] });
    const fromGlb = execute(doc0, 'import_gltf', { dataBase64: uint8ArrayToBase64(glb(json, triangleBytes())) });
    const bytes = new TextEncoder().encode(JSON.stringify(triangleGltf()));
    const fromJson = execute(doc0, 'import_gltf', { dataBase64: uint8ArrayToBase64(bytes) });
    expect(fromGlb.affected).toHaveLength(1);
    expect(worldTriangles(fromGlb.document)).toEqual(worldTriangles(fromJson.document));
  });

  it('composes the node hierarchy (parent matrix, child T/R/S) and applies the scale param', () => {
    const json = triangleGltf({
      nodes: [
        { name: 'parent', matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1], children: [1] },
        { name: 'child', mesh: 0, translation: [0, 5, 0], scale: [2, 2, 2], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] },
      ],
    });
    const [tri] = worldTriangles(importText(json).document);
    // child: scale 2, rotate +90 deg about z, then translate (0,5,0), then the parent's (10,0,0).
    expect(round(tri?.[1])).toEqual([10, 7, 0]);
    expect(round(tri?.[2])).toEqual([8, 5, 0]);
    const scaled = worldTriangles(importText(triangleGltf(), { scale: 1000 }).document);
    expect(scaled[0]?.[1]).toEqual([1000, 0, 0]);
  });

  it('flips the winding of a mirrored node so the faces keep pointing outward', () => {
    const json = triangleGltf({ nodes: [{ mesh: 0, scale: [-1, 1, 1] }] });
    const [tri] = worldTriangles(importText(json).document);
    expect(tri?.map(round)).toEqual([
      [0, 0, 0],
      [0, 1, 0],
      [-1, 0, 0],
    ]);
  });

  it('takes the colour of the material baseColorFactor (linear to sRGB) and names several primitives', () => {
    const json = triangleGltf({
      materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 0, 0.2159, 1] } }],
      meshes: [
        {
          primitives: [
            { attributes: { POSITION: 0 }, indices: 1, material: 0 },
            { attributes: { POSITION: 0 }, indices: 1 },
          ],
        },
      ],
    });
    const result = importText(json);
    const entities = result.affected.map((id) => result.document.entities[id]!);
    expect(entities.map((e) => [e.name, e.color])).toEqual([
      ['tri/0', '#ff0080'],
      ['tri/1', '#9aa5b1'],
    ]);
  });

  it('reads strided views, UNSIGNED_BYTE indices and files without a scene list', () => {
    const bytes = new Uint8Array(64);
    const view = new DataView(bytes.buffer);
    const points = [
      [0, 0, 0],
      [2, 0, 0],
      [0, 2, 0],
    ];
    points.forEach((p, i) => p.forEach((v, c) => view.setFloat32(i * 16 + c * 4, v, true)));
    [0, 1, 2].forEach((v, i) => view.setUint8(48 + i, v));
    const json = triangleGltf({
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
        { bufferView: 1, componentType: 5121, count: 3, type: 'SCALAR' },
      ],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 44, byteStride: 16 },
        { buffer: 0, byteOffset: 48, byteLength: 3 },
      ],
      buffers: [{ byteLength: 64, uri: dataUri(bytes) }],
    });
    delete json['scene'];
    delete json['scenes'];
    expect(worldTriangles(importText(json).document)[0]?.[1]).toEqual([2, 0, 0]);
  });

  it('skips non-triangle primitives (counted) and imports a non-indexed triangle list', () => {
    const json = triangleGltf({
      meshes: [
        {
          primitives: [
            { attributes: { POSITION: 0 }, mode: 1 },
            { attributes: { POSITION: 0 }, mode: 4 },
          ],
        },
      ],
    });
    const result = importText(json);
    expect(result.data).toMatchObject({ meshEntities: 1, skippedPrimitives: 1 });
    expect(result.summary).toContain('skipped 1 non-triangle');
  });

  it('is pure: the input document is unchanged and the ids are minted, not taken from the file', () => {
    const before = JSON.stringify(doc0);
    const node = { name: 'tri', mesh: 0, extras: { llullId: 'box-1', llullIds: ['x1', 'x2'] } };
    const result = importText(triangleGltf({ nodes: [node] }));
    expect(JSON.stringify(doc0)).toBe(before);
    expect(result.affected[0]).not.toBe('box-1');
    expect(result.affected[0]).toMatch(/^mesh-/);
  });
});

describe('import_gltf: refusals (named codes, document unchanged)', () => {
  it('needs exactly one of dataBase64 or text', () => {
    const none = execute(doc0, 'import_gltf', {});
    expect(none.error?.code).toBe('CMD_INVALID_PARAMS');
    const both = execute(doc0, 'import_gltf', { text: '{}', dataBase64: 'AAAA' });
    expect(both.error?.code).toBe('CMD_INVALID_PARAMS');
    expect(none.document).toBe(doc0);
  });

  it('refuses invalid base64, broken JSON, a non-2.0 asset and a non-object root', () => {
    expect(execute(doc0, 'import_gltf', { dataBase64: '!!!' }).error?.code).toBe('GLTF_MALFORMED');
    expect(execute(doc0, 'import_gltf', { text: '{not json' }).error?.code).toBe('GLTF_MALFORMED');
    expect(execute(doc0, 'import_gltf', { text: '[1,2]' }).error?.code).toBe('GLTF_MALFORMED');
    refused(triangleGltf({ asset: { version: '1.0' } }), 'GLTF_MALFORMED');
  });

  it('never reads an external buffer: a file name, a URL or a data URI that is not base64 is GLTF_EXTERNAL_URI', () => {
    for (const uri of ['mesh.bin', 'https://example.com/mesh.bin', 'file:///etc/passwd', 'data:text/plain,hello'])
      refused(triangleGltf({ buffers: [{ byteLength: 44, uri }] }), 'GLTF_EXTERNAL_URI');
  });

  it('refuses a required extension it cannot read (Draco), but accepts EXT_mesh_gpu_instancing as required', () => {
    refused(triangleGltf({ extensionsRequired: ['KHR_draco_mesh_compression'] }), 'GLTF_EXTENSION_REQUIRED');
    expect(importText(triangleGltf({ extensionsRequired: ['EXT_mesh_gpu_instancing'] })).affected).toHaveLength(1);
  });

  it('refuses an index outside the vertex range, an accessor past its view and a view past its buffer', () => {
    const bytes = triangleBytes();
    new DataView(bytes.buffer).setUint16(40, 3, true);
    refused(triangleGltf({ buffers: [{ byteLength: 44, uri: dataUri(bytes) }] }), 'GLTF_BAD_ACCESSOR');
    refused(accessorsWith(0, { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3' }), 'GLTF_BAD_ACCESSOR');
    const longView = [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 600 },
    ];
    refused(triangleGltf({ bufferViews: longView }), 'GLTF_BAD_ACCESSOR');
    refused(triangleGltf({ buffers: [{ byteLength: 4096, uri: dataUri(triangleBytes()) }] }), 'GLTF_BAD_ACCESSOR');
  });

  it('refuses a non-finite position, indices that are not whole triangles and sparse / normalized / quantized accessors', () => {
    const nan = triangleBytes();
    new DataView(nan.buffer).setFloat32(8, NaN, true);
    refused(triangleGltf({ buffers: [{ byteLength: 44, uri: dataUri(nan) }] }), 'GLTF_BAD_ACCESSOR');
    refused(accessorsWith(1, { bufferView: 1, componentType: 5123, count: 2, type: 'SCALAR' }), 'GLTF_BAD_ACCESSOR');
    refused(accessorsWith(0, { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', sparse: {} }), 'GLTF_UNSUPPORTED');
    refused(accessorsWith(0, { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', normalized: true }), 'GLTF_UNSUPPORTED');
    refused(accessorsWith(0, { bufferView: 0, componentType: 5123, count: 3, type: 'VEC3' }), 'GLTF_UNSUPPORTED');
    refused(accessorsWith(0, { componentType: 5126, count: 3, type: 'VEC3' }), 'GLTF_BAD_ACCESSOR');
    refused(accessorsWith(0, { bufferView: 0, componentType: 5126, count: 3, type: 'VEC4' }), 'GLTF_BAD_ACCESSOR');
  });

  it('refuses dangling indices and wrong types with GLTF_MALFORMED', () => {
    refused(triangleGltf({ nodes: [{ mesh: 7 }] }), 'GLTF_MALFORMED');
    refused(triangleGltf({ nodes: [{ mesh: 0, translation: [1, 2] }] }), 'GLTF_MALFORMED');
    refused(triangleGltf({ nodes: [{ mesh: 0, children: [9] }] }), 'GLTF_MALFORMED');
    refused(triangleGltf({ meshes: [{ primitives: [{ attributes: {} }] }] }), 'GLTF_MALFORMED');
    refused(triangleGltf({ nodes: 'x' }), 'GLTF_MALFORMED');
    refused(triangleGltf({ scene: 3 }), 'GLTF_MALFORMED');
    refused(triangleGltf({ buffers: [{ byteLength: 44 }] }), 'GLTF_MALFORMED');
  });

  it('refuses a node cycle and a scene that expands past the node budget (GLTF_LIMIT)', () => {
    refused(triangleGltf({ nodes: [{ mesh: 0, children: [0] }] }), 'GLTF_LIMIT');
    // 20 levels, each listing the next one twice: 2^20 expansions
    const nodes: JsonObject[] = Array.from({ length: 20 }, (_, i) => ({ children: [i + 1, i + 1] }));
    nodes.push({ mesh: 0 });
    refused(triangleGltf({ nodes }), 'GLTF_LIMIT');
  });

  it('refuses a scene without triangles (GLTF_NO_GEOMETRY)', () => {
    refused(triangleGltf({ nodes: [{ name: 'empty' }] }), 'GLTF_NO_GEOMETRY');
    refused(triangleGltf({ meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 0 }] }] }), 'GLTF_NO_GEOMETRY');
  });

  it('refuses a truncated GLB, a bad GLB version and a GLB without a JSON chunk', () => {
    const whole = glb(triangleGltf({ buffers: [{ byteLength: 44 }] }), triangleBytes());
    const run = (bytes: Uint8Array): CommandResult => execute(doc0, 'import_gltf', { dataBase64: uint8ArrayToBase64(bytes) });
    expect(run(whole.subarray(0, whole.length - 10)).error?.code).toBe('GLTF_MALFORMED');
    expect(run(whole.subarray(0, 14)).error?.code).toBe('GLTF_MALFORMED');
    const wrongVersion = whole.slice();
    new DataView(wrongVersion.buffer).setUint32(4, 1, true);
    expect(run(wrongVersion).error?.code).toBe('GLTF_MALFORMED');
    const noJson = whole.slice();
    new DataView(noJson.buffer).setUint32(16, 0x004e4942, true);
    expect(run(noJson).error?.code).toBe('GLTF_MALFORMED');
    const hugeChunk = whole.slice();
    new DataView(hugeChunk.buffer).setUint32(12, 0xfffffff0, true);
    expect(run(hugeChunk).error?.code).toBe('GLTF_MALFORMED');
  });

  it('never throws on mutated GLBs: every outcome is a result (imported, or refused with a GLTF_ / CMD_ code)', () => {
    const whole = glb(triangleGltf({ buffers: [{ byteLength: 44 }] }), triangleBytes());
    let seed = 12345;
    const next = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    let refusals = 0;
    for (let round = 0; round < 300; round++) {
      const bytes = whole.slice();
      for (let k = 0; k < 1 + (next() % 4); k++) bytes[next() % bytes.length] = next() & 0xff;
      const cut = next() % 4 === 0 ? bytes.subarray(0, next() % bytes.length) : bytes;
      const result = execute(doc0, 'import_gltf', { dataBase64: uint8ArrayToBase64(cut) });
      if (result.affected.length === 0) {
        refusals++;
        expect(result.error?.code, result.summary).toMatch(/^(GLTF_|CMD_)/);
        expect(result.document).toBe(doc0);
      }
    }
    expect(refusals).toBeGreaterThan(10);
  });
});
