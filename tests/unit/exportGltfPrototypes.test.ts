/** VIS-M8d: gpu export tessellates one solid per prototype and writes exactly what the tessellate-everything path wrote. */
import { describe, it, expect } from 'vitest';
import { execute } from '@core/commands/registry';
import { buildGltfScene, collectDecalParts, collectSceneParts, type InstanceBucket } from '@core/commands/exchange/gltfScene';
import { createEmptyDocument, DEFAULT_LAYER_ID, type CadDocument, type Entity, type Vec3 } from '@core/model/types';
import { base64ToUint8Array } from '@lib/base64';
import { synRackDocument } from '../helpers/synRack';

const common = (
  id: string,
  position: Vec3,
  rotation: Vec3 = [0, 0, 0],
  color = '#808080',
): Pick<Entity, 'id' | 'position' | 'rotation' | 'layerId' | 'color'> => ({ id, position, rotation, layerId: DEFAULT_LAYER_ID, color });

const TETRA = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], indices: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3] };

/** Placed copies of several shapes, a near-identical (6-figure) size, rotated and coloured copies, mesh copies, face colours and an entity group. */
function mixedDocument(): CadDocument {
  const entities: Entity[] = [
    { ...common('b1', [0, 0, 0]), kind: 'box', size: [10, 20, 30] },
    { ...common('b2', [50, 0, 0], [0.3, 0.1, 0.2]), kind: 'box', size: [10, 20, 30] },
    { ...common('b3', [100, 0, 0]), kind: 'box', size: [10, 20, 30], color: '#ff0000' },
    { ...common('b4', [150, 0, 0]), kind: 'box', size: [10.0000000001, 20, 30] },
    { ...common('b5', [200, 0, 0]), kind: 'box', size: [10, 20, 30] },
    { ...common('c1', [0, 50, 0], [0, Math.PI / 2, 0]), kind: 'cylinder', radius: 4, height: 20 },
    { ...common('c2', [50, 50, 0], [0, Math.PI / 2, 0]), kind: 'cylinder', radius: 4, height: 20 },
    { ...common('c3', [100, 50, 0]), kind: 'cylinder', radius: 4, height: 20 },
    { ...common('s1', [0, 100, 0]), kind: 'sphere', radius: 7 },
    { ...common('m1', [0, 150, 0]), kind: 'mesh', mesh: TETRA },
    { ...common('m2', [30, 150, 0], [0.5, 0, 0]), kind: 'mesh', mesh: TETRA },
    { ...common('f1', [0, 200, 0]), kind: 'mesh', mesh: TETRA, faceColors: [{ near: [0.2, 0.2, 0.2], color: '#00ff00' }] },
    { ...common('f2', [30, 200, 0]), kind: 'mesh', mesh: TETRA, faceColors: [{ near: [0.2, 0.2, 0.2], color: '#00ff00' }] },
  ];
  const base = createEmptyDocument();
  return {
    ...base,
    entities: Object.fromEntries(entities.map((e) => [e.id, e])),
    order: entities.map((e) => e.id),
    groups: { g1: { id: 'g1', name: 'Row', memberIds: ['b1', 'b2', 'c1', 'c2'] } },
  };
}

const groupOf = (doc: CadDocument) => (entityId: string) => {
  const group = Object.values(doc.groups).find((g) => g.memberIds.includes(entityId));
  return group === undefined ? undefined : { id: group.id, name: group.name };
};

/** The pre-VIS-M8d gpu output: every solid tessellated, then the mesh-sharing pass finds the copies. */
function referenceScene(doc: CadDocument): { json: Record<string, unknown>; bin: Uint8Array } {
  const ids = doc.order;
  const parts = collectSceneParts(doc, ids);
  return buildGltfScene(parts, collectDecalParts(doc, ids), groupOf(doc), { buckets: [] as InstanceBucket[] });
}

function exportedGpu(doc: CadDocument): { json: Record<string, unknown>; bin: Uint8Array; data: Record<string, unknown> } {
  const data = execute(doc, 'export_gltf', { instancing: 'gpu' }).data as Record<string, unknown>;
  const json = JSON.parse(data['text'] as string) as { buffers?: Array<{ uri?: string; byteLength: number }> } & Record<string, unknown>;
  const uri = json.buffers?.[0]?.uri ?? '';
  const bin = base64ToUint8Array(uri.slice(uri.indexOf(',') + 1)) ?? new Uint8Array();
  const { buffers: _buffers, ...rest } = json;
  return { json: rest, bin, data };
}

function expectSameAsReference(doc: CadDocument): void {
  const reference = referenceScene(doc);
  const actual = exportedGpu(doc);
  const { buffers: _buffers, ...expectedJson } = reference.json as { buffers?: unknown } & Record<string, unknown>;
  expect(actual.json).toEqual(JSON.parse(JSON.stringify(expectedJson)));
  expect(Buffer.from(actual.bin).equals(Buffer.from(reference.bin))).toBe(true);
}

describe('gpu export groups placed solids by prototype before tessellating', () => {
  it('a mixed scene writes the same nodes, meshes and accessors as the tessellate-everything path', () => {
    const doc = mixedDocument();
    expectSameAsReference(doc);
    const { json } = exportedGpu(doc);
    expect(JSON.stringify(json)).toContain('EXT_mesh_gpu_instancing');
  });

  it('SYN-RACK (8 bays) writes the same scene as the tessellate-everything path', () => {
    expectSameAsReference(synRackDocument(8));
  });

  it('tessellates each prototype once: identical placed solids share the local triangles of the first', () => {
    const doc = mixedDocument();
    const sink = { buckets: [] as InstanceBucket[], groupOf: groupOf(doc) };
    const parts = collectSceneParts(doc, doc.order, sink);
    const byId = new Map(parts.map((part) => [part.entityId, part]));
    const [b1, b2, b3, b4, b5] = ['b1', 'b2', 'b3', 'b4', 'b5'].map((id) => byId.get(id));
    expect(b2?.localTris).toBe(b1?.localTris);
    expect(b5?.localTris).toBe(b1?.localTris);
    expect(b3?.localTris).not.toBe(b1?.localTris); // another appearance
    expect(b4?.localTris).not.toBe(b1?.localTris); // a size that only a 6-figure key would merge
    expect(b2?.placement).toEqual({ position: [50, 0, 0], rotation: [0.3, 0.1, 0.2] });
    expect(b2?.name).toBe('b2');
    expect(b2?.tris.length).toBe(b1?.tris.length);
    expect(byId.get('f2')?.localTris).not.toBe(byId.get('f1')?.localTris); // face colours: each solid on its own
  });

  it('expand mode still tessellates every solid', () => {
    const doc = mixedDocument();
    const parts = collectSceneParts(doc, doc.order);
    const byId = new Map(parts.map((part) => [part.entityId, part]));
    expect(byId.get('b2')?.localTris).not.toBe(byId.get('b1')?.localTris);
  });

  it('an unknown or empty selection exports nothing and counts triangles per instance', () => {
    const doc = mixedDocument();
    const full = execute(doc, 'export_gltf', { instancing: 'gpu' }).data as { triangleCount: number };
    const expanded = execute(doc, 'export_gltf', {}).data as { triangleCount: number };
    expect(full.triangleCount).toBe(expanded.triangleCount);
    const none = execute(doc, 'export_gltf', { instancing: 'gpu', entityIds: ['nope'] });
    expect(none.document).toBe(doc);
    expect(none.data).toMatchObject({ triangleCount: 0, nodeCount: 0 });
  });
});
