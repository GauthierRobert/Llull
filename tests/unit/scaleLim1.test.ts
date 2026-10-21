/**
 * LIM-1 scale guards (docs/decisions/LIM1-scale.md): structural budgets that stay robust on CI (no wall-clock asserts) — glTF pattern
 * copies share one mesh and every mesh is indexed, patterned cuts are one boolean with a shallow tool tree, dense kernel results commit.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createEmptyDocument, type CadDocument, type MeshData, type MeshSolidEntity, type ShapeRecipe } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { setGeometryKernel } from '@core/geometry/kernel';
import { solidTriangles } from '@core/geometry/solidTriangles';
import { uint8ArrayToBase64 } from '@lib/base64';
import { TETRA, fakeKernel, type FakeKernel } from '../helpers/fakeKernel';
import { expectNoOp, expectPure } from '../helpers/expectNoOp';

interface Accessor {
  bufferView: number;
  componentType: number;
  count: number;
}
interface Gltf {
  nodes: { name: string; mesh: number; matrix?: number[]; extras: { llullId: string } }[];
  meshes: { name: string; primitives: { attributes: Record<string, number>; indices?: number; material: number }[] }[];
  accessors: Accessor[];
  bufferViews: { byteOffset: number; byteLength: number }[];
  buffers: { uri: string }[];
}

function build(actions: unknown[]): CadDocument {
  const result = execute(createEmptyDocument(), 'build_project', { actions });
  expect(result.summary).toContain('Plan complete');
  return result.document;
}

function exportGltf(doc: CadDocument): { gltf: Gltf; bin: Buffer; triangleCount: number } {
  const data = execute(doc, 'export_gltf', {}).data as { text: string; triangleCount: number };
  const gltf = JSON.parse(data.text) as Gltf;
  const bin = Buffer.from(gltf.buffers[0]?.uri.split(',')[1] ?? '', 'base64');
  return { gltf, bin, triangleCount: data.triangleCount };
}

/** The numbers of an accessor (FLOAT / UNSIGNED_SHORT / UNSIGNED_INT). */
function read(gltf: Gltf, bin: Buffer, accessorIndex: number, components: number): number[] {
  const accessor = gltf.accessors[accessorIndex]!;
  const view = gltf.bufferViews[accessor.bufferView]!;
  const bytes = bin.subarray(view.byteOffset, view.byteOffset + view.byteLength);
  const copy = new Uint8Array(bytes).buffer;
  const Array_ = { 5126: Float32Array, 5123: Uint16Array, 5125: Uint32Array }[accessor.componentType]!;
  return Array.from(new Array_(copy)).slice(0, accessor.count * components);
}

/** World AABB of a node: its mesh POSITION placed by the node matrix (identity when absent). */
function nodeBounds(gltf: Gltf, bin: Buffer, node: Gltf['nodes'][number]): number[] {
  const positions = read(gltf, bin, gltf.meshes[node.mesh]!.primitives[0]!.attributes['POSITION']!, 3);
  const m = node.matrix ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    const [x, y, z] = [positions[i]!, positions[i + 1]!, positions[i + 2]!];
    for (let axis = 0; axis < 3; axis++) {
      const value = m[axis]! * x + m[4 + axis]! * y + m[8 + axis]! * z + m[12 + axis]!;
      min[axis] = Math.min(min[axis]!, value);
      max[axis] = Math.max(max[axis]!, value);
    }
  }
  return [...min, ...max];
}

function entityBounds(doc: CadDocument, id: string): number[] {
  const corners = solidTriangles(doc.entities[id]!).flat();
  return [0, 1, 2, 0, 1, 2].map((axis, k) => (k < 3 ? Math.min : Math.max)(...corners.map((v) => v[axis]!)));
}

describe('LIM-1 glTF scale: shared meshes for pattern copies, indexed buffers', () => {
  it('24 polar copies of a rotated cylinder are 1 mesh buffer and 24 placed nodes at the right places', () => {
    const doc = build([
      { command: 'add_cylinder', params: { radius: 2, height: 30, position: [100, 0, 15], rotation: [0, 0.3, 0] }, as: 'bolt' },
      { command: 'array_polar', params: { id: '$bolt', count: 24, center: [0, 0, 0] } },
    ]);
    const { gltf, bin } = exportGltf(doc);
    expect(gltf.meshes).toHaveLength(1);
    expect(gltf.nodes).toHaveLength(24);
    expect(gltf.bufferViews).toHaveLength(3);
    for (const node of gltf.nodes) {
      expect(node.matrix).toHaveLength(16);
      const expected = entityBounds(doc, node.extras.llullId);
      nodeBounds(gltf, bin, node).forEach((value, k) => expect(value).toBeCloseTo(expected[k]!, 3));
    }
  });
  it('identical geometry with a different appearance keeps separate meshes; a unique part stays in world space', () => {
    const doc = build([
      { command: 'add_box', params: { size: [1, 2, 3], color: '#ff0000' } },
      { command: 'add_box', params: { size: [1, 2, 3], position: [5, 0, 0], color: '#0000ff' } },
    ]);
    const { gltf, bin } = exportGltf(doc);
    expect(gltf.meshes).toHaveLength(2);
    expect(gltf.nodes.every((node) => node.matrix === undefined)).toBe(true);
    expect(nodeBounds(gltf, bin, gltf.nodes[1]!)).toEqual([4.5, -1, -1.5, 5.5, 1, 1.5]);
  });
  it('a smooth solid is indexed: fewer vertices than triangles, three indices per triangle', () => {
    const { gltf, triangleCount } = exportGltf(build([{ command: 'add_sphere', params: { radius: 3 } }]));
    const primitive = gltf.meshes[0]!.primitives[0]!;
    const indices = gltf.accessors[primitive.indices!]!;
    expect(indices.componentType).toBe(5123);
    expect(indices.count).toBe(triangleCount * 3);
    expect(gltf.accessors[primitive.attributes['POSITION']!]!.count).toBeLessThan(triangleCount);
  });
  it('base64 of large buffers matches the platform encoder', () => {
    for (const length of [0, 1, 2, 3, 4, 5, 6, 7]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 97 + 13) & 0xff);
      expect(uint8ArrayToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    }
    const big = Uint8Array.from({ length: 300_001 }, (_, i) => (i * 2654435761) >>> 24);
    expect(uint8ArrayToBase64(big)).toBe(Buffer.from(big).toString('base64'));
  });
});

/** Depth of nested boolean nodes in a recipe. */
function booleanDepth(recipe: ShapeRecipe): number {
  return recipe.op === 'boolean' ? 1 + Math.max(booleanDepth(recipe.a), booleanDepth(recipe.b)) : 0;
}

function boxes(count: number): { doc: CadDocument; ids: string[] } {
  let doc = createEmptyDocument();
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const result = execute(doc, 'add_box', { size: [1, 1, 1], position: [i * 2, 0, 0] });
    doc = result.document;
    ids.push(result.affected[0]!);
  }
  return { doc, ids };
}

describe('LIM-1 patterned booleans: one boolean with a list of tools', () => {
  let fake: FakeKernel;
  beforeEach(() => {
    fake = fakeKernel({ boolean: TETRA });
    setGeometryKernel(fake);
  });
  afterEach(() => setGeometryKernel(null));

  it('subtracts 400 tools in one step through a balanced union tree (depth 10, not 400)', () => {
    const { doc, ids } = boxes(401);
    const [base, ...tools] = ids as [string, ...string[]];
    const result = execute(doc, 'boolean', { op: 'subtract', a: base, b: tools });
    expect(result.affected).toHaveLength(1);
    expect(result.summary).toContain('400 tools');
    expect(result.document.order).toEqual(result.affected);
    const brep = (result.document.entities[result.affected[0]!] as MeshSolidEntity).brep!;
    expect(brep).toMatchObject({ op: 'boolean', boolean: 'subtract', a: { op: 'solid', entity: doc.entities[base] } });
    expect(booleanDepth(brep)).toBe(1 + Math.ceil(Math.log2(400)));
    expect(fake.calls.filter((call) => call.op === 'boolean')).toHaveLength(400);
    expectPure(doc, () => execute(doc, 'boolean', { op: 'subtract', a: base, b: tools }));
  });
  it('a one-element list is the plain two-operand boolean', () => {
    const { doc, ids } = boxes(2);
    const result = execute(doc, 'boolean', { op: 'union', a: ids[0], b: [ids[1]] });
    expect(result.summary).toContain(`merged '${ids[0]}' and '${ids[1]}'`);
  });
  it.each([
    ['a listed as a tool', (ids: string[]) => ({ op: 'subtract', a: ids[0], b: [ids[1], ids[0]] }), 'different ids'],
    ['a tool listed twice', (ids: string[]) => ({ op: 'subtract', a: ids[0], b: [ids[1], ids[1]] }), 'listed twice'],
    ['intersect with several tools', (ids: string[]) => ({ op: 'intersect', a: ids[0], b: [ids[1], ids[2]] }), 'one tool'],
    ['a missing tool', (ids: string[]) => ({ op: 'subtract', a: ids[0], b: [ids[1], 'ghost'] }), 'ghost'],
  ])('refuses %s', (_label, params, summary) => {
    const { doc, ids } = boxes(3);
    expectNoOp(execute(doc, 'boolean', params(ids)), doc, summary);
  });
  it('a refused cut at the end of a long sequential chain names the listed-tools cure', () => {
    const spec: { boolean: MeshData | null } = { boolean: TETRA };
    setGeometryKernel(fakeKernel(spec));
    const start = boxes(103);
    let doc = start.doc;
    let base = start.ids[0]!;
    for (const tool of start.ids.slice(1, 102)) {
      const result = execute(doc, 'boolean', { op: 'subtract', a: base, b: tool });
      doc = result.document;
      base = result.affected[0]!;
    }
    spec.boolean = null;
    expectNoOp(execute(doc, 'boolean', { op: 'subtract', a: base, b: start.ids[102] }), doc, 'b as a list of ids');
  });
  it('commits a dense kernel result (300k vertices) without overflowing the call stack', () => {
    const dense: MeshData = { positions: [...TETRA.positions, ...Array.from({ length: 900_000 }, () => 0.1)], indices: TETRA.indices };
    fake = fakeKernel({ boolean: dense });
    setGeometryKernel(fake);
    const { doc, ids } = boxes(2);
    const result = execute(doc, 'boolean', { op: 'subtract', a: ids[0], b: ids[1] });
    expect(result.affected).toHaveLength(1);
    expect(result.summary).toContain('merged');
  });
});
