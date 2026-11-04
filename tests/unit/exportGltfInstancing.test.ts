import { describe, it, expect } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument, type InstanceEntity, type Vec3 } from '@core/model/types';
import { base64ToUint8Array } from '@lib/base64';
import { applyEulerXYZ } from '@lib/eulerRotation';
import { ORIGIN } from '@lib/vec3';
import { quaternionFromEulerXYZ } from '@core/commands/exchange/gltfInstancing';
import { expandInstance } from '@core/geometry/instanceExpansion';
import { solidTriangles } from '@core/geometry/solidTriangles';
import { applied } from '../helpers/runFixtures';
import { synRackDocument } from '../helpers/synRack';

interface Accessor {
  bufferView: number;
  componentType: number;
  count: number;
  type: string;
}
interface GltfNode {
  name: string;
  mesh?: number;
  extras?: { llullIds?: string[]; instanceCount?: number };
  extensions?: { EXT_mesh_gpu_instancing: { attributes: Record<string, number> } };
}
interface Gltf {
  extensionsUsed?: string[];
  nodes: GltfNode[];
  meshes: Array<{ primitives: Array<{ attributes: Record<string, number> }> }>;
  accessors: Accessor[];
  bufferViews: Array<{ byteOffset: number; byteLength: number }>;
  buffers: Array<{ byteLength: number; uri?: string }>;
}

interface Exported {
  gltf: Gltf;
  bin: Uint8Array;
  data: Record<string, unknown>;
}

function exported(doc: CadDocument, params: Record<string, unknown> = {}): Exported {
  const data = execute(doc, 'export_gltf', params).data as Record<string, unknown>;
  const gltf = JSON.parse(data['text'] as string) as Gltf;
  const uri = gltf.buffers?.[0]?.uri ?? '';
  const bin = base64ToUint8Array(uri.slice(uri.indexOf(',') + 1)) ?? new Uint8Array();
  return { gltf, bin, data };
}

/** Float values of an accessor (checks the buffer view holds exactly count x components floats). */
function floats({ gltf, bin }: Exported, accessor: number): number[] {
  const a = gltf.accessors[accessor] as Accessor;
  expect(a.componentType).toBe(5126);
  const view = gltf.bufferViews[a.bufferView] as { byteOffset: number; byteLength: number };
  const size = { VEC2: 2, VEC3: 3, VEC4: 4, SCALAR: 1 }[a.type] as number;
  expect(view.byteLength).toBe(a.count * size * 4);
  return [...new Float32Array(bin.buffer.slice(bin.byteOffset + view.byteOffset, bin.byteOffset + view.byteOffset + view.byteLength))];
}

/** A component with a rotated box and a sphere, and 4 instances (create_component adds the first): identity, plain, rotated, rotated + non-uniform scale. */
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

const rotate = (q: readonly number[], v: Vec3): Vec3 => {
  const [x, y, z, w] = q as [number, number, number, number];
  const t: Vec3 = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
  return [v[0] + w * t[0] + (y * t[2] - z * t[1]), v[1] + w * t[1] + (z * t[0] - x * t[2]), v[2] + w * t[2] + (x * t[1] - y * t[0])];
};

const key = (v: readonly number[]): string => v.map((c) => c.toFixed(3)).join(',');

describe('quaternionFromEulerXYZ', () => {
  it.each<Vec3>([
    [0.3, -0.7, 1.9],
    [Math.PI, 0.2, -2.5],
    [0, Math.PI / 2, 0],
  ])('rotates like applyEulerXYZ for %j', (...angles) => {
    const euler = angles as Vec3;
    const q = quaternionFromEulerXYZ(euler);
    expect(Math.hypot(...q)).toBeCloseTo(1, 12);
    const v: Vec3 = [1.5, -2, 0.75];
    const expected = applyEulerXYZ(v, ORIGIN, euler);
    rotate(q, v).forEach((c, i) => expect(c).toBeCloseTo(expected[i] as number, 12));
  });
});

describe('export_gltf instancing', () => {
  it('omitted and "expand" give identical output without the extension', () => {
    const doc = instanceDoc();
    const a = execute(doc, 'export_gltf', {}).data as { text: string; nodeCount: number };
    const b = execute(doc, 'export_gltf', { instancing: 'expand' }).data as { text: string };
    expect(b.text).toBe(a.text);
    expect(a.text).not.toContain('EXT_mesh_gpu_instancing');
    expect(a.nodeCount).toBe(8);
  });

  it('gpu writes one instanced node per child prototype with float TRS accessors of the right shape', () => {
    const out = exported(instanceDoc(), { instancing: 'gpu' });
    const { gltf, data } = out;
    expect(gltf.extensionsUsed).toEqual(['EXT_mesh_gpu_instancing']);
    expect(gltf.nodes).toHaveLength(2);
    expect(gltf.meshes).toHaveLength(2);
    expect(data).toMatchObject({ nodeCount: 2, instanceCount: 8, instancedNodeCount: 2 });
    for (const node of gltf.nodes) {
      const attributes = node.extensions?.EXT_mesh_gpu_instancing.attributes ?? {};
      expect(Object.keys(attributes).sort()).toEqual(['ROTATION', 'SCALE', 'TRANSLATION']);
      const shapes = { TRANSLATION: 'VEC3', ROTATION: 'VEC4', SCALE: 'VEC3' } as const;
      for (const [name, type] of Object.entries(shapes)) {
        const accessor = gltf.accessors[attributes[name] as number] as Accessor;
        expect({ name, type: accessor.type, count: accessor.count, componentType: accessor.componentType }).toEqual({
          name,
          type,
          count: 4,
          componentType: 5126,
        });
      }
      expect(node.extras?.instanceCount).toBe(4);
      expect(node.extras?.llullIds).toHaveLength(4);
      const rotations = floats(out, attributes['ROTATION'] as number);
      for (let i = 0; i < rotations.length; i += 4) expect(Math.hypot(...rotations.slice(i, i + 4))).toBeCloseTo(1, 6);
    }
  });

  it('T . R . S of every instance maps the prototype onto the expanded geometry (rotated + non-uniform scale included)', () => {
    const doc = instanceDoc();
    const out = exported(doc, { instancing: 'gpu' });
    const boxNode = out.gltf.nodes[0] as GltfNode;
    const attributes = boxNode.extensions?.EXT_mesh_gpu_instancing.attributes ?? {};
    const t = floats(out, attributes['TRANSLATION'] as number);
    const r = floats(out, attributes['ROTATION'] as number);
    const s = floats(out, attributes['SCALE'] as number);
    const positions = floats(out, out.gltf.meshes[boxNode.mesh as number]?.primitives[0]?.attributes['POSITION'] as number);
    const instances = Object.values(doc.entities).filter((e): e is InstanceEntity => e.kind === 'instance');
    const component = Object.values(doc.components)[0]!;
    instances.forEach((instance, i) => {
      const expandedBox = expandInstance(instance, component)[0]!;
      const world = new Set(solidTriangles(expandedBox).flatMap((tri) => tri.map((v) => key(v))));
      for (let p = 0; p < positions.length; p += 3) {
        const scaled: Vec3 = [
          (positions[p] as number) * (s[i * 3] as number),
          (positions[p + 1] as number) * (s[i * 3 + 1] as number),
          (positions[p + 2] as number) * (s[i * 3 + 2] as number),
        ];
        const placed = rotate(r.slice(i * 4, i * 4 + 4), scaled).map((c, k) => c + (t[i * 3 + k] as number));
        expect(world.has(key(placed)), `instance ${i} vertex ${p / 3}`).toBe(true);
      }
    });
    expect(s.slice(9, 12)).toEqual([2, 0.5, 3]);
  });

  it('reports the same triangle count as expand mode, counted per instance', () => {
    for (const doc of [instanceDoc(), synRackDocument(8)]) {
      const expand = execute(doc, 'export_gltf', { instancing: 'expand' }).data as { triangleCount: number };
      const gpu = execute(doc, 'export_gltf', { instancing: 'gpu' });
      expect((gpu.data as { triangleCount: number }).triangleCount).toBe(expand.triangleCount);
      expect(gpu.summary).toContain(`${expand.triangleCount} triangles exported`);
    }
  });

  it('omits ROTATION / SCALE when every instance is identity there', () => {
    let doc = createEmptyDocument();
    doc = applied(doc, 'add_box', { size: [1, 1, 1] });
    doc = applied(doc, 'create_component', { name: 'C', entityIds: [...doc.order] });
    const componentId = Object.keys(doc.components)[0] as string;
    doc = applied(doc, 'insert_instance', { componentId, position: [1, 0, 0] });
    doc = applied(doc, 'insert_instance', { componentId, position: [2, 0, 0] });
    const attributes = exported(doc, { instancing: 'gpu' }).gltf.nodes[0]?.extensions?.EXT_mesh_gpu_instancing.attributes;
    expect(Object.keys(attributes ?? {})).toEqual(['TRANSLATION']);
  });

  it('still expands a mirrored instance (the extension defines no per-instance winding)', () => {
    let doc = instanceDoc();
    const componentId = Object.keys(doc.components)[0] as string;
    doc = applied(doc, 'insert_instance', { componentId, position: [0, 0, 9], scale: [-1, 1, 1] });
    const { gltf } = exported(doc, { instancing: 'gpu' });
    expect(gltf.nodes.filter((n) => n.extensions !== undefined)).toHaveLength(2);
    expect(gltf.nodes.filter((n) => n.extensions === undefined)).toHaveLength(2);
  });

  it('turns identical placed solids into one instanced node and keeps a unique solid a plain node', () => {
    let doc = createEmptyDocument();
    for (const x of [0, 5, 10]) doc = applied(doc, 'add_box', { size: [1, 2, 3], position: [x, x, 0], rotation: [0, 0, x / 10] });
    doc = applied(doc, 'add_sphere', { radius: 2, position: [0, 9, 0] });
    const expanded = exported(doc, { instancing: 'expand' });
    const gpu = exported(doc, { instancing: 'gpu' });
    expect(expanded.gltf.nodes).toHaveLength(4);
    expect(gpu.gltf.nodes).toHaveLength(2);
    expect(gpu.gltf.nodes[0]?.extras?.llullIds).toEqual(doc.order.slice(0, 3));
    expect(gpu.gltf.nodes[1]?.extensions).toBeUndefined();
    const attributes = gpu.gltf.nodes[0]?.extensions?.EXT_mesh_gpu_instancing.attributes ?? {};
    expect(floats(gpu, attributes['TRANSLATION'] as number)).toEqual([0, 0, 0, 5, 5, 0, 10, 10, 0]);
    expect(Object.keys(attributes)).toEqual(['TRANSLATION', 'ROTATION']);
  });

  it('keeps instanced nodes of different entity groups apart', () => {
    let doc = createEmptyDocument();
    for (const x of [0, 5, 10, 15]) doc = applied(doc, 'add_box', { size: [1, 1, 1], position: [x, 0, 0] });
    doc = applied(doc, 'group_entities', { ids: doc.order.slice(0, 2), name: 'Left' });
    const instanced = exported(doc, { instancing: 'gpu' }).gltf.nodes.filter((n) => n.extensions !== undefined);
    expect(instanced.map((n) => n.extras?.instanceCount)).toEqual([2, 2]);
  });

  it('SYN-RACK: gpu plain nodes + instances equal the expanded node count, with far fewer nodes', () => {
    const doc = synRackDocument(8);
    const expanded = exported(doc, { instancing: 'expand' });
    const gpu = exported(doc, { instancing: 'gpu' });
    const plain = gpu.gltf.nodes.filter((n) => n.extensions === undefined).length;
    expect(plain + (gpu.data['instanceCount'] as number)).toBe(expanded.gltf.nodes.length);
    expect(gpu.gltf.nodes.length).toBeLessThan(expanded.gltf.nodes.length / 10);
    expect(gpu.gltf.meshes.length).toBe(expanded.gltf.meshes.length);
  });

  it('exports nothing for an instance whose component is gone, and skips a component child that is missing', () => {
    const doc = instanceDoc();
    const [componentId, component] = Object.entries(doc.components)[0]!;
    const orphaned = { ...doc, components: {} };
    expect(exported(orphaned, { instancing: 'gpu' }).data).toMatchObject({ nodeCount: 0, instanceCount: 0 });
    const holey = { ...doc, components: { [componentId]: { ...component, order: [...component.order, 'ghost'] } } };
    expect(exported(holey, { instancing: 'gpu' }).data).toMatchObject({ nodeCount: 2, instanceCount: 8 });
  });

  it('GLB output carries the extension in its JSON chunk', () => {
    const base64 = (execute(instanceDoc(), 'export_gltf', { instancing: 'gpu', binary: true }).data as { base64: string }).base64;
    const glb = base64ToUint8Array(base64) as Uint8Array;
    const jsonLength = new DataView(glb.buffer, glb.byteOffset).getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(glb.slice(20, 20 + jsonLength))) as Gltf;
    expect(json.extensionsUsed).toEqual(['EXT_mesh_gpu_instancing']);
    expect(json.nodes[0]?.extensions).toBeDefined();
  });

  it('rejects an unknown instancing value and exports nothing instanced for an empty selection', () => {
    const doc = instanceDoc();
    const bad = execute(doc, 'export_gltf', { instancing: 'gpuu' });
    expect(bad.summary).toContain('rejected: invalid params');
    expect(bad.document).toBe(doc);
    const none = exported(doc, { instancing: 'gpu', entityIds: ['nope'] });
    expect(none.gltf.extensionsUsed).toBeUndefined();
    expect(none.data).toMatchObject({ nodeCount: 0, instanceCount: 0, instancedNodeCount: 0 });
  });

  it('is pure', () => {
    const doc = instanceDoc();
    const before = JSON.stringify(doc);
    expect(execute(doc, 'export_gltf', { instancing: 'gpu' }).document).toBe(doc);
    expect(JSON.stringify(doc)).toBe(before);
  });
});
