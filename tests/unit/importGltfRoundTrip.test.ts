/** import_gltf reads export_gltf back (expand and gpu): same world triangles within float32 tolerance, same instance count (VIS-M8d). */
import { describe, it, expect } from 'vitest';
import { execute } from '@core/commands/registry';
import { entityToTriangles } from '@core/geometry/entityTriangles';
import type { Triangle } from '@core/geometry/triangles';
import { createEmptyDocument, DEFAULT_LAYER_ID, type CadDocument, type Entity, type InstanceEntity, type Vec3 } from '@core/model/types';
import { uint8ArrayToBase64 } from '@lib/base64';
import type { CommandResult } from '@core/commands/types';
import { applied } from '../helpers/runFixtures';
import { dataUri, glb, triangleBytes, triangleGltf, type JsonObject } from '../helpers/gltfFixtures';
import { synRackDocument } from '../helpers/synRack';

const worldTriangles = (doc: CadDocument): Triangle[] => doc.order.flatMap((id) => entityToTriangles(doc.entities[id] as Entity, doc));

const cell = (t: Triangle, d = [0, 0, 0]): string =>
  [0, 1, 2].map((c) => Math.floor((t[0][c]! + t[1][c]! + t[2][c]!) / 3) + (d[c] ?? 0)).join(',');

/** Every triangle of `expected` has an unmatched triangle of `actual` with all nine coordinates within `tolerance` (same corner order, so winding counts). */
function expectSameTriangles(actual: readonly Triangle[], expected: readonly Triangle[], tolerance: number): void {
  expect(actual).toHaveLength(expected.length);
  const grid = new Map<string, number[]>();
  actual.forEach((t, i) => grid.set(cell(t), [...(grid.get(cell(t)) ?? []), i]));
  const used = new Set<number>();
  const close = (a: Triangle, b: Triangle): boolean =>
    a.every((v, k) => v.every((c, axis) => Math.abs(c - (b[k]?.[axis] ?? NaN)) <= tolerance));
  let unmatched = 0;
  for (const want of expected) {
    let found = false;
    for (const dx of [-1, 0, 1])
      for (const dy of [-1, 0, 1])
        for (const dz of [-1, 0, 1])
          for (const index of grid.get(cell(want, [dx, dy, dz])) ?? [])
            if (!found && !used.has(index) && close(actual[index] as Triangle, want)) {
              used.add(index);
              found = true;
            }
    if (!found) unmatched++;
  }
  expect(unmatched, 'triangles without a counterpart').toBe(0);
}

function exported(doc: CadDocument, params: Record<string, unknown>): Record<string, unknown> {
  const result = execute(doc, 'export_gltf', params);
  expect(result.rejected).toBeUndefined();
  return result.data as Record<string, unknown>;
}

const importOf = (data: Record<string, unknown>): CommandResult =>
  execute(createEmptyDocument(), 'import_gltf', data['base64'] === undefined ? { text: data['text'] } : { dataBase64: data['base64'] });

/** A component of a rotated box and a sphere, instanced 4 times (identity, translated, rotated, rotated + non-uniformly scaled). */
function instanceDoc(): CadDocument {
  let doc = createEmptyDocument();
  doc = applied(doc, 'add_box', { size: [1, 2, 3], position: [1, 0, 0], rotation: [0.2, 0.1, 0.3], color: '#ff0000' });
  doc = applied(doc, 'add_sphere', { radius: 1, position: [0, 4, 0], color: '#00ff00' });
  doc = applied(doc, 'create_component', { name: 'Comp', entityIds: [...doc.order] });
  const componentId = Object.keys(doc.components)[0] as string;
  doc = applied(doc, 'insert_instance', { componentId, position: [10, 0, 0] });
  doc = applied(doc, 'insert_instance', { componentId, position: [0, 10, 0], rotation: [0.3, -0.4, 0.5] });
  doc = applied(doc, 'insert_instance', { componentId, position: [5, 5, 5], rotation: [0.7, 0.2, -1.1], scale: [2, 0.5, 3] });
  return doc;
}

const base = (
  id: string,
  position: Vec3,
  rotation: Vec3 = [0, 0, 0],
  color = '#808080',
): Pick<Entity, 'id' | 'position' | 'rotation' | 'layerId' | 'color'> => ({ id, position, rotation, layerId: DEFAULT_LAYER_ID, color });

/** Placed copies of boxes / cylinders (rotated, coloured differently) and a unique sphere. */
function placedDoc(): CadDocument {
  const entities: Entity[] = [
    { ...base('b1', [0, 0, 0]), kind: 'box', size: [10, 20, 30] },
    { ...base('b2', [50, 0, 0], [0.3, 0.1, 0.2]), kind: 'box', size: [10, 20, 30] },
    { ...base('b3', [100, 0, 0], [0, 0, 0], '#ff0000'), kind: 'box', size: [10, 20, 30] },
    { ...base('c1', [0, 50, 0], [0, Math.PI / 2, 0]), kind: 'cylinder', radius: 4, height: 20 },
    { ...base('c2', [50, 50, 0], [0, Math.PI / 2, 0]), kind: 'cylinder', radius: 4, height: 20 },
    { ...base('c3', [100, 50, 0], [1, 0.5, -2]), kind: 'cylinder', radius: 4, height: 20 },
    { ...base('s1', [0, 100, 0]), kind: 'sphere', radius: 7 },
  ];
  return { ...createEmptyDocument(), entities: Object.fromEntries(entities.map((e) => [e.id, e])), order: entities.map((e) => e.id) };
}

const kinds = (doc: CadDocument): Record<string, number> =>
  doc.order.reduce<Record<string, number>>(
    (count, id) => ({ ...count, [(doc.entities[id] as Entity).kind]: (count[(doc.entities[id] as Entity).kind] ?? 0) + 1 }),
    {},
  );

describe.each([
  ['text', false],
  ['glb', true],
])('round trip (%s)', (_label, binary) => {
  it('expand: component instances read back as mesh entities with the same world triangles', () => {
    for (const doc of [instanceDoc(), placedDoc()]) {
      const data = exported(doc, { binary });
      const result = importOf(data);
      expect(result.rejected).toBeUndefined();
      expect(kinds(result.document)).toEqual({ mesh: data['nodeCount'] });
      expectSameTriangles(worldTriangles(result.document), worldTriangles(doc), 1e-3);
    }
  });

  it('gpu: instances read back as instances of one component per prototype, same world triangles, same instance count', () => {
    const doc = instanceDoc();
    const data = exported(doc, { binary, instancing: 'gpu' });
    const result = importOf(data);
    expect(data).toMatchObject({ instanceCount: 8, instancedNodeCount: 2 });
    expect(kinds(result.document)).toEqual({ instance: 8 });
    expect(result.data).toMatchObject({ instances: 8, components: 2, meshEntities: 0 });
    expect(Object.keys(result.document.components)).toHaveLength(2);
    expectSameTriangles(worldTriangles(result.document), worldTriangles(doc), 1e-3);
  });

  it('gpu: placed solids come back as instances (colour kept), unique solids (and a differently coloured copy) as meshes', () => {
    const doc = placedDoc();
    const data = exported(doc, { binary, instancing: 'gpu' });
    const result = importOf(data);
    expect(data['instanceCount']).toBe(5);
    expect(kinds(result.document)).toEqual({ instance: 5, mesh: 2 });
    expectSameTriangles(worldTriangles(result.document), worldTriangles(doc), 1e-3);
    const colours = Object.values(result.document.components).flatMap((component) => Object.values(component.entities).map((e) => e.color));
    expect(colours).toEqual(['#808080', '#808080']);
    const meshColours = result.document.order.flatMap((id) =>
      result.document.entities[id]?.kind === 'mesh' ? [result.document.entities[id]?.color] : [],
    );
    expect(meshColours.sort()).toEqual(['#808080', '#ff0000']);
  });
});

describe('round trip: SYN-RACK', () => {
  const doc = synRackDocument(8);
  it('gpu export of 1 832 placed solids imports as 1 832 instances of 13 components, no loose meshes', () => {
    const data = exported(doc, { instancing: 'gpu' });
    const result = importOf(data);
    expect(data['instanceCount']).toBe(1832);
    expect(result.data).toMatchObject({ instances: 1832, components: 13, meshEntities: 0 });
    expectSameTriangles(worldTriangles(result.document), worldTriangles(doc), 0.05);
  });

  it('expand export of the same scene imports as 1 832 meshes with the same world triangles', () => {
    const result = importOf(exported(doc, {}));
    expect(kinds(result.document)).toEqual({ mesh: 1832 });
    expectSameTriangles(worldTriangles(result.document), worldTriangles(doc), 0.05);
  });
});

describe('import_gltf: EXT_mesh_gpu_instancing details', () => {
  const floats = (...values: number[]): Uint8Array => {
    const bytes = new Uint8Array(values.length * 4);
    values.forEach((v, i) => new DataView(bytes.buffer).setFloat32(i * 4, v, true));
    return bytes;
  };
  /** The unit triangle plus TRANSLATION (VEC3), ROTATION (VEC4) and SCALE (VEC3) accessors for the instances; `bin` is the buffer (also embedded unless `glb`). */
  function instancedParts(
    t: number[],
    r: number[] | null,
    s: number[] | null,
    node: JsonObject = {},
    embed = true,
  ): { json: JsonObject; bin: Uint8Array } {
    const attributeData: Array<[string, 'VEC3' | 'VEC4', number[]]> = [
      ['TRANSLATION', 'VEC3', t],
      ...(r ? [['ROTATION', 'VEC4', r] as [string, 'VEC4', number[]]] : []),
      ...(s ? [['SCALE', 'VEC3', s] as [string, 'VEC3', number[]]] : []),
    ];
    const chunks = [triangleBytes(), ...attributeData.map(([, , values]) => floats(...values))];
    const bin = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    const views: JsonObject[] = [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 6 },
    ];
    const accessors: JsonObject[] = [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
    ];
    const attributes: Record<string, number> = {};
    let offset = 0;
    chunks.forEach((chunk, k) => {
      bin.set(chunk, offset);
      if (k > 0) {
        const [name, type, values] = attributeData[k - 1] as [string, string, number[]];
        attributes[name] = accessors.length;
        accessors.push({ bufferView: views.length, componentType: 5126, count: values.length / (type === 'VEC4' ? 4 : 3), type });
        views.push({ buffer: 0, byteOffset: offset, byteLength: chunk.length });
      }
      offset += chunk.length;
    });
    const json = triangleGltf({
      nodes: [{ name: 'inst', mesh: 0, extensions: { EXT_mesh_gpu_instancing: { attributes } }, ...node }],
      accessors,
      bufferViews: views,
      buffers: [embed ? { byteLength: bin.length, uri: dataUri(bin) } : { byteLength: bin.length }],
    });
    return { json, bin };
  }
  const instancedGltf = (t: number[], r: number[] | null, s: number[] | null, node: JsonObject = {}): JsonObject =>
    instancedParts(t, r, s, node).json;
  const run = (json: JsonObject): CommandResult => execute(createEmptyDocument(), 'import_gltf', { text: JSON.stringify(json) });
  const half = Math.SQRT1_2;

  it('turns TRANSLATION / ROTATION / SCALE into instance position / Euler rotation / scale of one component', () => {
    const result = run(instancedGltf([1, 2, 3, 4, 5, 6], [0, 0, half, half, 0, 0, 0, 1], [2, 3, 4, 1, 1, 1]));
    expect(result.data).toMatchObject({ instances: 2, components: 1, meshEntities: 0 });
    const [first, second] = result.affected.map((id) => result.document.entities[id] as InstanceEntity);
    expect(first?.position).toEqual([1, 2, 3]);
    expect(first?.rotation[2]).toBeCloseTo(Math.PI / 2, 6);
    expect(first?.scale?.map((c) => Math.round(c * 1e6) / 1e6)).toEqual([2, 3, 4]);
    expect(second?.rotation.map((c) => Math.abs(c))).toEqual([0, 0, 0]);
    expect(first?.componentId).toBe(second?.componentId);
  });

  it('keeps gimbal-lock rotations (ry = +-90 degrees) exact', () => {
    const q = [0, half, 0, half]; // 90 degrees about y
    const result = run(instancedGltf([0, 0, 0], q, null));
    const instance = result.document.entities[result.affected[0] as string] as InstanceEntity;
    expect(instance.rotation[1]).toBeCloseTo(Math.PI / 2, 6);
    expect(entityToTriangles(instance, result.document)[0]?.[1]?.map((c) => Math.round(c * 1e6) / 1e6 + 0)).toEqual([0, 0, -1]);
  });

  it('composes the parent transform into every instance; a mirroring parent bakes meshes instead (winding flipped)', () => {
    const moved = run({
      ...instancedGltf([1, 0, 0], null, null),
      nodes: [
        { children: [1], translation: [0, 10, 0] },
        { mesh: 0, ...instancedExt() },
      ],
    });
    const instance = moved.document.entities[moved.affected[0] as string] as InstanceEntity;
    expect(instance.position).toEqual([1, 10, 0]);
    const mirrored = run({
      ...instancedGltf([1, 0, 0], null, null),
      nodes: [
        { children: [1], scale: [-1, 1, 1] },
        { mesh: 0, ...instancedExt() },
      ],
    });
    expect(mirrored.data).toMatchObject({ instances: 0, meshEntities: 1, components: 1 });
    expect(worldTriangles(mirrored.document)[0]?.map((v) => v.map((c) => Math.round(c * 1e6) / 1e6 + 0))).toEqual([
      [-1, 0, 0],
      [-1, 1, 0],
      [-2, 0, 0],
    ]);
    const sheared = run({
      ...instancedGltf([0, 0, 0], [0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)], null),
      nodes: [
        { children: [1], scale: [1, 3, 1] },
        { mesh: 0, ...instancedExt({ TRANSLATION: 2, ROTATION: 3 }) },
      ],
    });
    expect(sheared.data).toMatchObject({ instances: 0, meshEntities: 1 });
  });

  it('refuses instance transforms whose product overflows (finite parent scale times finite instance scale)', () => {
    const product = run({
      ...instancedGltf([0, 0, 0], null, [1e30, 1, 1]),
      nodes: [
        { children: [1], scale: [1e300, 1, 1] },
        { mesh: 0, ...instancedExt({ TRANSLATION: 2, SCALE: 3 }) },
      ],
    });
    expect(product.error?.code).toBe('GLTF_LIMIT');
    expect(product.affected).toEqual([]);
  });

  it('skips a zero-scale instance and counts it', () => {
    const result = run(instancedGltf([0, 0, 0, 1, 1, 1], null, [1, 1, 1, 0, 1, 1]));
    expect(result.data).toMatchObject({ instances: 1, skippedInstances: 1 });
    expect(result.summary).toContain('1 zero-scale');
  });

  it('refuses instancing accessors of different counts, without attributes, and non-float instance data', () => {
    const counts = instancedGltf([0, 0, 0, 1, 1, 1], null, [1, 1, 1]);
    expect(run(counts).error?.code).toBe('GLTF_MALFORMED');
    const none = instancedGltf([0, 0, 0], null, null);
    (none['nodes'] as JsonObject[])[0] = { mesh: 0, extensions: { EXT_mesh_gpu_instancing: { attributes: {} } } };
    expect(run(none).error?.code).toBe('GLTF_MALFORMED');
  });

  it('ignores llullIds / llullIdRuns extras in both forms (ids are minted)', () => {
    const extras = { llullIds: ['a1', 'a2'], instanceCount: 2 };
    const list = run(instancedGltf([0, 0, 0, 1, 0, 0], null, null, { extras }));
    const runs = run(instancedGltf([0, 0, 0, 1, 0, 0], null, null, { extras: { llullIdRuns: [['a', 1, 2]], instanceCount: 2 } }));
    for (const result of [list, runs]) {
      expect(result.affected).toHaveLength(2);
      expect(result.affected.every((id) => id.startsWith('instance-'))).toBe(true);
    }
  });

  it('reads the instancing accessors from a GLB BIN chunk', () => {
    const { json, bin } = instancedParts([0, 0, 0, 2, 0, 0], null, null, {}, false);
    const result = execute(createEmptyDocument(), 'import_gltf', { dataBase64: uint8ArrayToBase64(glb(json, bin)) });
    expect(result.data).toMatchObject({ instances: 2, components: 1 });
  });

  /** The node extension of `instancedGltf([1, 0, 0], null, null)` (TRANSLATION is accessor 2). */
  function instancedExt(attributes: Record<string, number> = { TRANSLATION: 2 }): JsonObject {
    return { extensions: { EXT_mesh_gpu_instancing: { attributes } } };
  }
});
