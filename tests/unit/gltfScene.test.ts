import { describe, it, expect } from 'vitest';
import { parsedGltf } from '../helpers/gltfExport';
import { type CadDocument, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { creasedNormals, linearColorFactor } from '@core/commands/exchange/gltfScene';
import { solidTriangles } from '@core/geometry/solidTriangles';

interface GltfJson {
  nodes: Array<{ name: string; mesh: number; extras: { llullId: string; kind: string } }>;
  meshes: Array<{ name: string; primitives: Array<{ material: number }> }>;
  materials: Array<{ name: string; pbrMetallicRoughness: { baseColorFactor: number[]; metallicFactor: number; roughnessFactor: number } }>;
  scenes: Array<{ nodes: number[] }>;
  accessors: Array<{ count: number }>;
}

function build(steps: Array<{ command: string; params: Record<string, unknown>; as?: string }>): CadDocument {
  const result = execute(createEmptyDocument(), 'build_project', { actions: steps });
  expect(result.summary).toContain('Plan complete');
  return result.document;
}

const gltfOf = (doc: CadDocument, params: Record<string, unknown> = {}): GltfJson => parsedGltf<GltfJson>(doc, params);

const scene = (): CadDocument =>
  build([
    { command: 'add_box', params: { size: [1, 1, 1], color: '#ffffff' }, as: 'white' },
    { command: 'set_entity_name', params: { id: '$white', name: 'White block' } },
    { command: 'add_box', params: { size: [1, 1, 1], position: [3, 0, 0], color: '#ffffff' } },
    { command: 'create_material', params: { name: 'steel', density: 0.00785, color: '#808080', metalness: 0.9, roughness: 0.3 } },
    { command: 'add_sphere', params: { radius: 1, position: [6, 0, 0] }, as: 'ball' },
    { command: 'assign_material', params: { materialName: 'steel', entityIds: ['$ball'] } },
  ]);

describe('export_gltf scene layout', () => {
  it('writes one named node + mesh per part with extras pointing back to llull', () => {
    const gltf = gltfOf(scene());
    expect(gltf.nodes).toHaveLength(3);
    expect(gltf.scenes[0]?.nodes).toEqual([0, 1, 2]);
    expect(gltf.nodes[0]?.name).toBe('White block');
    expect(gltf.nodes[0]?.extras.kind).toBe('box');
    expect(gltf.meshes.map((m) => m.name)).toEqual(gltf.nodes.map((n) => n.name));
  });
  it('shares one material per appearance and uses assigned PBR materials', () => {
    const gltf = gltfOf(scene());
    expect(gltf.materials).toHaveLength(2);
    const [paint, steel] = gltf.materials;
    expect(paint?.name).toBe('#ffffff');
    expect(paint?.pbrMetallicRoughness.baseColorFactor).toEqual([1, 1, 1, 1]);
    expect(paint?.pbrMetallicRoughness.metallicFactor).toBeCloseTo(0.08);
    expect(steel?.name).toBe('steel');
    expect(steel?.pbrMetallicRoughness.metallicFactor).toBe(0.9);
    expect(steel?.pbrMetallicRoughness.roughnessFactor).toBe(0.3);
    expect(gltf.meshes.map((m) => m.primitives[0]?.material)).toEqual([0, 0, 1]);
  });
  it('summary and GLB data report the node and material counts', () => {
    const result = execute(scene(), 'export_gltf', { binary: true });
    expect(result.summary).toContain('3 node(s), 2 material(s)');
    expect(result.data).toMatchObject({ format: 'glb', nodeCount: 3, materialCount: 2 });
  });
  it('exports a subset and expands instances into one part per child', () => {
    const doc = build([
      { command: 'add_box', params: { size: [1, 1, 1], color: '#ff0000' }, as: 'a' },
      { command: 'add_cylinder', params: { radius: 0.5, height: 1, color: '#0000ff' }, as: 'b' },
      { command: 'create_component', params: { name: 'Pair', componentId: 'pair', entityIds: ['$a', '$b'] } },
      { command: 'insert_instance', params: { componentId: 'pair', position: [5, 0, 0] }, as: 'inst' },
    ]);
    const instanceId = Object.values(doc.entities).find((e) => e.kind === 'instance')?.id ?? '';
    const gltf = gltfOf(doc, { entityIds: [instanceId] });
    expect(gltf.nodes).toHaveLength(2);
    expect(gltf.nodes.every((n) => n.name.startsWith(`${instanceId}/`))).toBe(true);
    expect(gltf.materials).toHaveLength(2);
  });
  it('an empty document is still a valid scene', () => {
    const gltf = gltfOf(createEmptyDocument());
    expect(gltf.scenes).toEqual([{ nodes: [] }]);
    expect(gltf.nodes).toBeUndefined();
  });
  it('hangs grouped entities under the group node', () => {
    const doc = build([
      { command: 'add_box', params: { size: [1, 1, 1] }, as: 'a' },
      { command: 'add_box', params: { size: [1, 1, 1], position: [4, 0, 0] }, as: 'b' },
      { command: 'group_entities', params: { ids: ['$a', '$b'], name: 'Pair' } },
    ]);
    const gltf = gltfOf(doc);
    const root = gltf.nodes[gltf.scenes[0]?.nodes[0] ?? -1] as unknown as { name: string; children: number[] };
    expect(gltf.scenes[0]?.nodes).toHaveLength(1);
    expect(root.name).toBe('Pair');
    expect(root.children).toHaveLength(2);
  });
});

describe('glTF helpers', () => {
  it('converts sRGB hex to linear factors and falls back on malformed colours', () => {
    expect(linearColorFactor('#000000')).toEqual([0, 0, 0, 1]);
    expect(linearColorFactor('#808080')[0]).toBeCloseTo(0.2159, 3);
    expect(linearColorFactor('#050505')[0]).toBeCloseTo(0.0015, 3);
    expect(linearColorFactor('not a colour')).toEqual([0.214, 0.214, 0.214, 1]);
  });
  it('keeps hard edges hard and smooths curved surfaces', () => {
    const box = execute(createEmptyDocument(), 'add_box', { size: [2, 2, 2] });
    const cube = solidTriangles(box.document.entities[box.affected[0] as string]!);
    const cubeNormals = creasedNormals(cube);
    for (let i = 0; i < cubeNormals.length; i += 3) {
      const n = [cubeNormals[i], cubeNormals[i + 1], cubeNormals[i + 2]].map((v) => Math.abs(v ?? 0));
      expect(n.filter((v) => v > 0.999)).toHaveLength(1);
    }
    const sphere = execute(createEmptyDocument(), 'add_sphere', { radius: 1 });
    const tris = solidTriangles(sphere.document.entities[sphere.affected[0] as string]!);
    const normals = creasedNormals(tris);
    const [x, y, z] = tris[40]![0];
    expect(normals[40 * 9]! * x + normals[40 * 9 + 1]! * y + normals[40 * 9 + 2]! * z).toBeGreaterThan(0.995);
  });
});
