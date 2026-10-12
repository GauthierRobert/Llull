import { describe, it, expect } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';

interface GltfJson {
  scenes: { nodes: number[] }[];
  nodes: { name: string; mesh?: number; children?: number[] }[];
  meshes: { name: string; primitives: { material: number }[] }[];
  materials: { name: string; pbrMetallicRoughness: { baseColorFactor: number[] } }[];
  accessors: { count: number }[];
  bufferViews: { byteOffset: number; byteLength: number }[];
  buffers: { byteLength: number; uri?: string }[];
}

interface GltfData {
  format: string;
  triangleCount: number;
  nodeCount: number;
  materialCount: number;
  text?: string;
  base64?: string;
}

function run(doc: CadDocument, name: string, params: Record<string, unknown>): CadDocument {
  return execute(doc, name, params).document;
}

/** A red box named "Frame", a blue box named "Plate", and an unnamed red sphere. */
function coloredDoc(): CadDocument {
  let doc = createEmptyDocument();
  doc = run(doc, 'add_box', { size: [1, 1, 1], color: '#ff0000' });
  doc = run(doc, 'add_box', { size: [2, 2, 2], position: [5, 0, 0], color: '#0000ff' });
  doc = run(doc, 'add_sphere', { radius: 1, position: [0, 5, 0], color: '#ff0000' });
  const [frame, plate] = doc.order;
  doc = run(doc, 'set_entity_name', { id: frame, name: 'Frame' });
  doc = run(doc, 'set_entity_name', { id: plate, name: 'Plate' });
  return doc;
}

const gltfOf = (doc: CadDocument, params: Record<string, unknown> = {}): GltfJson =>
  JSON.parse((execute(doc, 'export_gltf', params).data as GltfData).text as string) as GltfJson;

describe('export_gltf per-entity structure', () => {
  it('writes one named node and mesh per entity with a material per distinct color', () => {
    const doc = coloredDoc();
    const gltf = gltfOf(doc);
    expect(gltf.nodes.map((n) => n.name)).toEqual(['Frame', 'Plate', doc.order[2]]);
    expect(gltf.meshes.map((m) => m.name)).toEqual(['Frame', 'Plate', doc.order[2]]);
    expect(gltf.scenes[0]?.nodes).toEqual([0, 1, 2]);
    expect(gltf.materials).toHaveLength(2);
    const material = (node: number): number | undefined =>
      gltf.meshes[gltf.nodes[node]?.mesh ?? -1]?.primitives[0]?.material;
    expect(material(0)).toBe(material(2));
    expect(material(0)).not.toBe(material(1));
    expect(gltf.materials[material(0) ?? -1]?.pbrMetallicRoughness.baseColorFactor).toEqual([
      1, 0, 0, 1,
    ]);
    expect(gltf.materials[material(1) ?? -1]?.pbrMetallicRoughness.baseColorFactor).toEqual([
      0, 0, 1, 1,
    ]);
  });

  it('reports nodeCount, materialCount and the backward-compatible fields', () => {
    const data = execute(coloredDoc(), 'export_gltf', {}).data as GltfData;
    expect(data).toMatchObject({ format: 'gltf', nodeCount: 3, materialCount: 2 });
    expect(data.triangleCount).toBeGreaterThan(12);
  });

  it('keeps accessors and buffer views inside the single buffer', () => {
    const gltf = gltfOf(coloredDoc());
    const end = Math.max(...gltf.bufferViews.map((v) => v.byteOffset + v.byteLength));
    expect(end).toBe(gltf.buffers[0]?.byteLength);
    expect(gltf.accessors).toHaveLength(gltf.meshes.length * 2);
  });

  it('hangs grouped entities under a node named after the group', () => {
    let doc = coloredDoc();
    const [frame, plate, sphere] = doc.order;
    doc = run(doc, 'group_entities', { ids: [frame, plate], name: 'Assembly A' });
    const gltf = gltfOf(doc);
    const roots = (gltf.scenes[0]?.nodes ?? []).map((i) => gltf.nodes[i]);
    expect(roots.map((n) => n?.name)).toEqual(['Assembly A', sphere]);
    const group = roots[0];
    expect(group?.mesh).toBeUndefined();
    expect((group?.children ?? []).map((i) => gltf.nodes[i]?.name)).toEqual(['Frame', 'Plate']);
    expect((execute(doc, 'export_gltf', {}).data as GltfData).nodeCount).toBe(4);
  });

  it('honours the entityIds filter (a group node only appears for exported members)', () => {
    let doc = coloredDoc();
    const [frame, plate] = doc.order;
    doc = run(doc, 'group_entities', { ids: [frame, plate], name: 'G' });
    const gltf = gltfOf(doc, { entityIds: [plate] });
    expect(gltf.nodes.map((n) => n.name).sort()).toEqual(['G', 'Plate']);
    expect(gltf.materials).toHaveLength(1);
  });

  it('packs a valid GLB with the same node structure', () => {
    const doc = coloredDoc();
    const data = execute(doc, 'export_gltf', { binary: true }).data as GltfData;
    expect(data).toMatchObject({ format: 'glb', nodeCount: 3, materialCount: 2 });
    const bytes = Buffer.from(data.base64 as string, 'base64');
    expect(bytes.readUInt32LE(0)).toBe(0x46546c67);
    expect(bytes.readUInt32LE(8)).toBe(bytes.length);
    const jsonLength = bytes.readUInt32LE(12);
    expect(bytes.readUInt32LE(16)).toBe(0x4e4f534a);
    const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8')) as GltfJson;
    expect(gltf.nodes.map((n) => n.name).slice(0, 2)).toEqual(['Frame', 'Plate']);
    const binHeader = 20 + jsonLength;
    expect(bytes.readUInt32LE(binHeader + 4)).toBe(0x004e4942);
    expect(bytes.readUInt32LE(binHeader)).toBeGreaterThanOrEqual(gltf.buffers[0]?.byteLength ?? 0);
    expect(gltf.buffers[0]?.uri).toBeUndefined();
  });

  it('exports an empty selection as a node-free scene', () => {
    const data = execute(createEmptyDocument(), 'export_gltf', {}).data as GltfData;
    expect(data).toMatchObject({ triangleCount: 0, nodeCount: 0, materialCount: 0 });
    expect(JSON.parse(data.text as string)).toEqual({
      asset: { version: '2.0', generator: 'llull' },
      scene: 0,
      scenes: [{ nodes: [] }],
    });
  });

  it('falls back to a default color for a malformed entity color', () => {
    let doc = createEmptyDocument();
    doc = run(doc, 'add_box', { size: [1, 1, 1] });
    const [id] = doc.order;
    const broken = {
      ...doc,
      entities: {
        ...doc.entities,
        [id as string]: { ...doc.entities[id as string]!, color: 'red' },
      },
    } as CadDocument;
    const gltf = gltfOf(broken);
    expect(gltf.materials[0]?.pbrMetallicRoughness.baseColorFactor[3]).toBe(1);
    expect(gltf.materials[0]?.name).toBe('red');
  });
});
