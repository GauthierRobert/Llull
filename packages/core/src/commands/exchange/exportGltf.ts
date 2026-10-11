/**
 * export_gltf: read-only glTF 2.0 / GLB export, one named node + mesh per entity, one PBR material
 * per distinct entity color, entity groups as parent nodes (document returned unchanged).
 *
 * @layer core/commands
 */

import type { CommandResult } from '../types';
import { report } from '../noop';
import { defineCommand, z } from '../schema';
import { uint8ArrayToBase64 } from '../../lib/base64';
import { collectExportParts, exportSummary, type ExportPart } from '../../geometry/entityTriangles';
import type { Triangle } from '../../geometry/triangles';
import { facetNormal } from '../../geometry/tessellation';
import type { CadDocument } from '../../model/types';
import { entityIdsField } from './exportFormats';

const FALLBACK_COLOR = '#c8553d';
const FLOAT = 5126;
const ARRAY_BUFFER = 34962;

interface GltfNode {
  name: string;
  mesh?: number;
  children?: number[];
}

/** Per-vertex (triangle-soup) positions and facet normals as flat Float32Arrays. */
function buildMeshBuffers(tris: Triangle[]): { positions: Float32Array; normals: Float32Array } {
  const positions = new Float32Array(tris.length * 9);
  const normals = new Float32Array(tris.length * 9);
  tris.forEach((tri, t) => {
    const n = facetNormal(...tri);
    tri.forEach((v, k) => {
      positions.set(v, t * 9 + k * 3);
      normals.set(n, t * 9 + k * 3);
    });
  });
  return { positions, normals };
}

/** Component-wise min/max of a flat xyz array; all-zero when it holds no finite value. */
function computeAabb(positions: Float32Array): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  positions.forEach((value, i) => {
    const axis = i % 3;
    if (value < (min[axis] as number)) min[axis] = value;
    if (value > (max[axis] as number)) max[axis] = value;
  });
  return Number.isFinite(min[0]) ? { min, max } : { min: [0, 0, 0], max: [0, 0, 0] };
}

/** Align a byte length to a 4-byte boundary (glTF chunk requirement). */
function align4(n: number): number {
  return (n + 3) & ~3;
}

/** `#rrggbb` as [r, g, b, 1] in 0..1 (channel value / 255, as the previous single-material export did); fallback color when malformed. */
function baseColorFactor(hex: string): number[] {
  const valid = /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : FALLBACK_COLOR;
  const channel = (offset: number): number =>
    Math.round((parseInt(valid.slice(offset, offset + 2), 16) / 255) * 1000) / 1000;
  return [channel(1), channel(3), channel(5), 1];
}

interface GltfScene {
  json: Record<string, unknown>;
  bin: Uint8Array;
  nodeCount: number;
  materialCount: number;
}

/** First group (document order) containing each entity id. */
function groupIndex(doc: CadDocument): Map<string, { id: string; name: string }> {
  const owner = new Map<string, { id: string; name: string }>();
  for (const group of Object.values(doc.groups)) {
    for (const memberId of group.memberIds) {
      if (!owner.has(memberId)) owner.set(memberId, { id: group.id, name: group.name });
    }
  }
  return owner;
}

/** The glTF document (JSON without `buffers[0].uri`) and its BIN payload for `parts`. */
function buildScene(doc: CadDocument, parts: readonly ExportPart[]): GltfScene {
  const owner = groupIndex(doc);
  const nodes: GltfNode[] = [];
  const roots: number[] = [];
  const groupNodes = new Map<string, number>();
  const meshes: { name: string; primitives: object[] }[] = [];
  const materials: object[] = [];
  const materialOfColor = new Map<string, number>();
  const accessors: object[] = [];
  const bufferViews: object[] = [];
  const binChunks: Uint8Array[] = [];
  let binLength = 0;

  const addView = (data: Float32Array): number => {
    bufferViews.push({
      buffer: 0,
      byteOffset: binLength,
      byteLength: data.byteLength,
      target: ARRAY_BUFFER,
    });
    binChunks.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    binLength += data.byteLength;
    return bufferViews.length - 1;
  };

  for (const part of parts) {
    if (part.tris.length === 0) continue;
    const colorKey = part.color.toLowerCase();
    let material = materialOfColor.get(colorKey);
    if (material === undefined) {
      material = materials.length;
      materialOfColor.set(colorKey, material);
      materials.push({
        name: part.color,
        pbrMetallicRoughness: {
          baseColorFactor: baseColorFactor(part.color),
          metallicFactor: 0,
          roughnessFactor: 0.8,
        },
      });
    }
    const { positions, normals } = buildMeshBuffers(part.tris);
    const aabb = computeAabb(positions);
    const count = positions.length / 3;
    const positionView = addView(positions);
    const normalView = addView(normals);
    accessors.push(
      {
        bufferView: positionView,
        componentType: FLOAT,
        count,
        type: 'VEC3',
        min: aabb.min,
        max: aabb.max,
      },
      { bufferView: normalView, componentType: FLOAT, count, type: 'VEC3' },
    );
    const label = part.name ?? part.id;
    meshes.push({
      name: label,
      primitives: [
        {
          attributes: { POSITION: accessors.length - 2, NORMAL: accessors.length - 1 },
          mode: 4, // TRIANGLES
          material,
        },
      ],
    });
    const nodeIndex = nodes.push({ name: label, mesh: meshes.length - 1 }) - 1;
    const group = owner.get(part.id);
    if (group === undefined) {
      roots.push(nodeIndex);
      continue;
    }
    let groupNode = groupNodes.get(group.id);
    if (groupNode === undefined) {
      groupNode = nodes.push({ name: group.name, children: [] }) - 1;
      groupNodes.set(group.id, groupNode);
      roots.push(groupNode);
    }
    (nodes[groupNode] as GltfNode).children?.push(nodeIndex);
  }

  const bin = new Uint8Array(binLength);
  let offset = 0;
  for (const chunk of binChunks) {
    bin.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const json: Record<string, unknown> = {
    asset: { version: '2.0', generator: 'llull' },
    scene: 0,
    scenes: [{ nodes: roots }],
    // Empty arrays are invalid glTF, so an empty selection omits every list.
    ...(nodes.length > 0 && { nodes, meshes, materials, accessors, bufferViews }),
    ...(binLength > 0 && { buffers: [{ byteLength: binLength }] }),
  };
  return { json, bin, nodeCount: nodes.length, materialCount: materials.length };
}

/** One GLB chunk: u32 length + u32 type + payload padded to 4 bytes with `pad`. */
function glbChunk(type: number, payload: Uint8Array, pad: number): Uint8Array {
  const padded = align4(payload.length);
  const chunk = new Uint8Array(8 + padded).fill(pad);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, padded, true);
  view.setUint32(4, type, true);
  chunk.set(payload, 8);
  return chunk;
}

/** GLB container: 12-byte header + JSON chunk (+ BIN chunk when there is a payload). */
function buildGlb(jsonObj: Record<string, unknown>, binPayload: Uint8Array): Uint8Array {
  const chunks = [glbChunk(0x4e4f534a, new TextEncoder().encode(JSON.stringify(jsonObj)), 0x20)];
  if (binPayload.length > 0) chunks.push(glbChunk(0x004e4942, binPayload, 0));
  const total = 12 + chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const glb = new Uint8Array(total);
  const view = new DataView(glb.buffer);
  view.setUint32(0, 0x46546c67, true); // 'glTF'
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  let offset = 12;
  for (const chunk of chunks) {
    glb.set(chunk, offset);
    offset += chunk.length;
  }
  return glb;
}

/** Add the inlined BIN payload (`data:` URI) to buffer 0 of a JSON-mode glTF. */
function withInlineBuffer(scene: GltfScene): Record<string, unknown> {
  if (scene.bin.length === 0) return scene.json;
  const uri = `data:application/octet-stream;base64,${uint8ArrayToBase64(scene.bin)}`;
  return { ...scene.json, buffers: [{ byteLength: scene.bin.length, uri }] };
}

/**
 * @command export_gltf
 * @pure
 * @layer core/commands
 * @affects nothing — read-only; document returned unchanged, affected:[]
 * @invariant data.format matches the binary param; data.triangleCount >= 0
 * @invariant one node + mesh per exported entity (node.name = entity name or id); one material per
 *   distinct entity color; an entity in a group hangs under a node named after the group
 * @invariant glTF JSON is valid 2.0 (asset.version="2.0"); GLB header magic=0x46546C67
 * @failure 2D-only or unknown entities silently skipped; empty → triangleCount:0, nodeCount:0
 * @failure never throws for user error
 */
export const exportGltf = defineCommand({
  name: 'export_gltf',
  annotations: { readOnly: true },
  description:
    'Export the document (or a subset of entities) to glTF 2.0 format. ' +
    'Produces a triangle tessellation in world space for every exportable 3D solid entity. ' +
    '2D shape entities are silently skipped. Revolution and instance entities are fully expanded. ' +
    'Returns the UNCHANGED document, affected:[], and a data object with: ' +
    '  format ("gltf" or "glb"), triangleCount, nodeCount, materialCount, ' +
    '  text (glTF 2.0 JSON string — when binary=false, default), ' +
    '  base64 (GLB binary blob base64-encoded — when binary=true). ' +
    'Structure: one glTF node + mesh per entity (node.name = the entity name from set_entity_name, ' +
    'else its id), one PBR material per distinct entity color (baseColorFactor from the hex color), ' +
    'and entities that belong to a group (group_entities) are children of a node named after the group. ' +
    'Meshes carry POSITION and NORMAL attributes. The BIN buffer is inlined as a data: URI in JSON mode. ' +
    'In GLB mode the 12-byte header + JSON chunk + BIN chunk are packed per the glTF 2.0 spec. ' +
    'entityIds: omit to export all 3D entities; provide an array to export a subset. ' +
    'binary: false (default) → data.text contains JSON; true → data.base64 contains GLB. ' +
    'Does NOT modify the document.',
  params: z.object({
    entityIds: entityIdsField,
    binary: z
      .boolean()
      .optional()
      .describe(
        'Output format selector. false (default): data.text contains a glTF 2.0 JSON string ' +
          'with the binary buffer inlined as a data: URI. ' +
          'true: data.base64 contains a base64-encoded GLB binary container ' +
          '(12-byte header + JSON chunk + BIN chunk per glTF 2.0 spec). ' +
          'Most web viewers accept JSON glTF; most desktop importers accept GLB.',
      ),
  }),
  run: (doc, params): CommandResult => {
    const { entityIds, binary = false } = params;
    const collected = collectExportParts(doc, entityIds);
    const scene = buildScene(doc, collected.parts);
    const tris = collected.parts.flatMap((part) => part.tris);
    const triangleCount = tris.length;
    const counts = {
      triangleCount,
      nodeCount: scene.nodeCount,
      materialCount: scene.materialCount,
    };
    const summary =
      exportSummary('export_gltf', binary ? 'glb' : 'gltf', { ...collected, tris }) +
      ` ${scene.nodeCount} node(s), ${scene.materialCount} material(s).`;
    if (binary) {
      const base64 = uint8ArrayToBase64(buildGlb(scene.json, scene.bin));
      return report(doc, summary, { format: 'glb', ...counts, base64 });
    }
    const text = JSON.stringify(withInlineBuffer(scene), null, 2);
    return report(doc, summary, { format: 'gltf', ...counts, text });
  },
});
