import { describe, it, expect } from 'vitest';
import { parsedGltf } from '../helpers/gltfExport';
import { run } from '../helpers/runFixtures';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import type { ExportStlData } from '@core/commands/exchange/exportStl';

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

const gltfOf = (doc: CadDocument, params: Record<string, unknown> = {}): GltfJson => parsedGltf<GltfJson>(doc, params);

describe('export_gltf per-entity structure', () => {
  it('writes one named node and mesh per entity with a material per distinct color', () => {
    const doc = coloredDoc();
    const gltf = gltfOf(doc);
    expect(gltf.nodes.map((n) => n.name)).toEqual(['Frame', 'Plate', doc.order[2]]);
    expect(gltf.meshes.map((m) => m.name)).toEqual(['Frame', 'Plate', doc.order[2]]);
    expect(gltf.scenes[0]?.nodes).toEqual([0, 1, 2]);
    expect(gltf.materials).toHaveLength(2);
    const material = (node: number): number | undefined => gltf.meshes[gltf.nodes[node]?.mesh ?? -1]?.primitives[0]?.material;
    expect(material(0)).toBe(material(2));
    expect(material(0)).not.toBe(material(1));
    expect(gltf.materials[material(0) ?? -1]?.pbrMetallicRoughness.baseColorFactor).toEqual([1, 0, 0, 1]);
    expect(gltf.materials[material(1) ?? -1]?.pbrMetallicRoughness.baseColorFactor).toEqual([0, 0, 1, 1]);
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
    expect(gltf.accessors).toHaveLength(gltf.meshes.length * 3); // POSITION, NORMAL, indices
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
    expect(JSON.parse(data.text as string)).toEqual({ asset: { version: '2.0', generator: 'llull' }, scene: 0, scenes: [{ nodes: [] }] });
  });
  it('falls back to a default color for a malformed entity color', () => {
    let doc = createEmptyDocument();
    doc = run(doc, 'add_box', { size: [1, 1, 1] });
    const [id] = doc.order;
    const broken = {
      ...doc,
      entities: { ...doc.entities, [id as string]: { ...doc.entities[id as string]!, color: 'red' } },
    } as CadDocument;
    const gltf = gltfOf(broken);
    expect(gltf.materials[0]?.pbrMetallicRoughness.baseColorFactor[3]).toBe(1);
    expect(gltf.materials[0]?.name).toBe('red');
  });
});

describe('export_obj units label', () => {
  const doc = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document;
  const objText = (units?: string): string =>
    (execute(doc, 'export_obj', units === undefined ? {} : { units }).data as { text: string }).text;
  it('embeds the label in the header comment', () => {
    expect(objText('cm').split('\n')[0]).toBe('# llull OBJ export — units: cm');
  });
  it('cannot inject extra OBJ records through a multi-line label', () => {
    const lines = objText('mm\nv 9 9 9\r\nf 1 2 3').split('\n');
    expect(lines[0]).toBe('# llull OBJ export — units: mm v 9 9 9 f 1 2 3');
    expect(lines).not.toContain('v 9 9 9');
    expect(lines[1]).toBe(`o ${doc.order[0]}`);
  });
  it('falls back to the document units for a blank label', () => {
    expect(objText('  \n ').split('\n')[0]).toBe(`# llull OBJ export — units: ${doc.units}`);
  });
});

describe('export_stl solid name', () => {
  const doc = execute(createEmptyDocument(), 'add_box', { size: [1, 1, 1] }).document;
  const exportData = (params: Record<string, unknown>): ExportStlData => execute(doc, 'export_stl', params).data as ExportStlData;
  it('wraps ASCII output in the requested name', () => {
    const stl = exportData({ name: 'bracket' }).stl!;
    expect(stl.startsWith('solid bracket\n')).toBe(true);
    expect(stl.endsWith('endsolid bracket')).toBe(true);
  });
  it('cannot inject facets or records through a multi-line name', () => {
    const stl = exportData({ name: 'part\nendsolid\nsolid evil' }).stl!;
    const lines = stl.split('\n');
    expect(lines[0]).toBe('solid part endsolid solid evil');
    expect(lines.filter((line) => line.startsWith('solid')).length).toBe(1);
  });
  it('falls back to llull for a blank name', () => {
    expect(exportData({ name: ' \n ' }).stl!.startsWith('solid llull\n')).toBe(true);
  });
  it('binary header never starts with "solid" (ASCII sniffers), even for a name that does', () => {
    const data = exportData({ format: 'binary', name: 'solid thing' });
    const bytes = Buffer.from(data.stlBase64!, 'base64');
    expect(bytes.subarray(0, 5).toString('ascii').toLowerCase()).not.toBe('solid');
    expect(bytes.subarray(0, 17).toString('ascii')).toBe('llull solid thing');
    expect(bytes.readUInt32LE(80)).toBe(data.triangleCount);
  });
});

describe('export_stl entity names', () => {
  type Doc = ReturnType<typeof createEmptyDocument>;
  const named = (): Doc => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
    doc = execute(doc, 'add_box', { size: [2, 2, 2], position: [5, 0, 0] }).document;
    const [first] = doc.order;
    return execute(doc, 'set_entity_name', { id: first, name: 'Bearing 1' }).document;
  };
  const stlOf = (doc: Doc, p: Record<string, unknown>): string => (execute(doc, 'export_stl', p).data as ExportStlData).stl!;
  it('names the solid after a lone exported named entity', () => {
    const doc = named();
    const stl = stlOf(doc, { entityIds: [doc.order[0]] });
    expect(stl.startsWith('solid Bearing 1\n')).toBe(true);
  });
  it('keeps the llull default when several entities are merged', () => {
    expect(stlOf(named(), {}).startsWith('solid llull\n')).toBe(true);
  });
  it('perEntity writes one named solid block per entity (name, else id)', () => {
    const doc = named();
    const lines = stlOf(doc, { perEntity: true }).split('\n');
    expect(lines.filter((line) => line.startsWith('solid '))).toEqual(['solid Bearing 1', `solid ${doc.order[1]}`]);
    expect(lines.filter((line) => line.startsWith('endsolid ')).length).toBe(2);
    expect(lines.filter((line) => line.includes('facet normal')).length).toBe(24);
  });
  it('perEntity on an empty selection is one valid empty solid', () => {
    expect(stlOf(createEmptyDocument(), { perEntity: true })).toBe('solid llull\nendsolid llull');
  });
});

describe('export_obj entity names', () => {
  it('writes one named object per entity with offset face indices', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_box', { size: [1, 1, 1] }).document;
    doc = execute(doc, 'add_box', { size: [2, 2, 2], position: [5, 0, 0] }).document;
    const [first, second] = doc.order;
    doc = execute(doc, 'set_entity_name', { id: first, name: 'Shaft  A' }).document;
    const text = (execute(doc, 'export_obj', {}).data as { text: string }).text;
    const lines = text.split('\n');
    expect(lines.filter((line) => line.startsWith('o '))).toEqual(['o Shaft_A', `o ${second}`]);
    expect(lines.filter((line) => line.startsWith('f ')).at(12)).toBe('f 37//13 38//13 39//13');
  });
});
