/**
 * export_obj and export_gltf: read-only exports of the world-space triangles shared with
 * `exportTriangulate.ts` (document returned unchanged, affected: []).
 *
 * @layer core/commands
 */

import type { CommandResult } from './types';
import { defineCommand, z } from './schema';
import { uint8ArrayToBase64 } from '../lib/base64';
import { collectExportTriangles, exportSummary } from './exportTriangulate';
import { facetNormal, type Triangle } from './exportMath';

/** Wavefront OBJ text: per-facet normals, 1-based `f v//vn` indices. */
function buildObjText(tris: Triangle[], header: string, objectName: string): string {
  const lines: string[] = [header, `o ${objectName}`];
  for (const [v0, v1, v2] of tris) {
    lines.push(`v ${v0[0]} ${v0[1]} ${v0[2]}`, `v ${v1[0]} ${v1[1]} ${v1[2]}`);
    lines.push(`v ${v2[0]} ${v2[1]} ${v2[2]}`);
  }
  for (const [v0, v1, v2] of tris) {
    const n = facetNormal(v0, v1, v2);
    lines.push(`vn ${n[0]} ${n[1]} ${n[2]}`);
  }
  for (let i = 0; i < tris.length; i++) {
    const vi = i * 3 + 1;
    const ni = i + 1;
    lines.push(`f ${vi}//${ni} ${vi + 1}//${ni} ${vi + 2}//${ni}`);
  }
  return lines.join('\n');
}

/**
 * @command export_obj
 * @pure
 * @layer core/commands
 * @affects nothing — read-only; document returned unchanged, affected:[]
 * @invariant data.format === 'obj'; data.triangleCount >= 0
 * @invariant data.text is valid Wavefront OBJ with v/vn/f records
 * @failure 2D-only or unknown entities silently skipped; empty → triangleCount:0
 * @failure never throws for user error
 */
export const exportObj = defineCommand({
  name: 'export_obj',
  annotations: { readOnly: true },
  description:
    'Export the document (or a subset of entities) to Wavefront OBJ text format. ' +
    'Produces a triangle tessellation in world space for every exportable 3D solid entity. ' +
    '2D shape entities are silently skipped. Revolution and instance entities are fully expanded. ' +
    'Returns the UNCHANGED document, affected:[], and a data object with: ' +
    '  format ("obj"), triangleCount, text (the full OBJ string with v/vn/f records). ' +
    'entityIds: omit to export all 3D entities; provide an array to export a subset. ' +
    'units: optional units label embedded in the OBJ comment (defaults to doc units). ' +
    'Does NOT modify the document.',
  params: z.object({
    entityIds: z
      .array(z.string())
      .optional()
      .describe(
        'Array of entity ids to include in the export. Omit (or pass []) to export ALL ' +
          '3D solid entities in the document. 2D and unknown ids are silently skipped.',
      ),
    units: z
      .string()
      .optional()
      .describe(
        'Units label to embed in the OBJ comment header (e.g. "mm", "cm", "in"). ' +
          'Defaults to the document units setting. Informational only — OBJ has no unit standard.',
      ),
  }),
  run: (doc, params): CommandResult => {
    const { entityIds, units } = params;
    const unitLabel = units ?? doc.units;

    const collected = collectExportTriangles(doc, entityIds);
    const triangleCount = collected.tris.length;
    const text = buildObjText(
      collected.tris,
      `# llull OBJ export — units: ${unitLabel}`,
      'llull_export',
    );
    const summary = exportSummary('export_obj', 'obj', collected);

    return { document: doc, summary, affected: [], data: { format: 'obj', text, triangleCount } };
  },
});

/** Per-vertex (triangle-soup) positions and facet normals as flat Float32Arrays. */
function buildGltfBuffers(tris: Triangle[]): { positions: Float32Array; normals: Float32Array } {
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

/** Component-wise min/max of a flat xyz array; NaN values are skipped, all-zero when no finite x. */
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

/**
 * Build a minimal valid glTF 2.0 JSON object from flat vertex positions.
 * Positions and normals are stored as separate bufferview/accessor pairs.
 * The binary buffer payload is returned as a separate Uint8Array.
 */
function buildGltfJson(positions: Float32Array, binBuffer: Uint8Array): Record<string, unknown> {
  const vertexCount = positions.length / 3;
  const posByteLength = positions.byteLength;
  const normByteLength = positions.byteLength;

  const aabb = computeAabb(positions);

  return {
    asset: { version: '2.0', generator: 'llull' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [
      {
        primitives: [
          {
            attributes: { POSITION: 0, NORMAL: 1 },
            mode: 4, // TRIANGLES
            material: 0,
          },
        ],
      },
    ],
    materials: [
      {
        pbrMetallicRoughness: {
          baseColorFactor: [0.784, 0.333, 0.239, 1.0], // #c8553d
          metallicFactor: 0,
          roughnessFactor: 0.8,
        },
      },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126, // FLOAT
        count: vertexCount,
        type: 'VEC3',
        min: aabb.min,
        max: aabb.max,
      },
      {
        bufferView: 1,
        componentType: 5126, // FLOAT
        count: vertexCount,
        type: 'VEC3',
      },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posByteLength, target: 34962 }, // ARRAY_BUFFER
      { buffer: 0, byteOffset: posByteLength, byteLength: normByteLength, target: 34962 },
    ],
    buffers: [{ byteLength: binBuffer.byteLength }],
  };
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

/** Combined BIN payload: positions then normals as raw bytes. */
function buildBinPayload(positions: Float32Array, normals: Float32Array): Uint8Array {
  const combined = new Uint8Array(positions.byteLength + normals.byteLength);
  combined.set(new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength), 0);
  combined.set(
    new Uint8Array(normals.buffer, normals.byteOffset, normals.byteLength),
    positions.byteLength,
  );
  return combined;
}

/**
 * @command export_gltf
 * @pure
 * @layer core/commands
 * @affects nothing — read-only; document returned unchanged, affected:[]
 * @invariant data.format matches the binary param; data.triangleCount >= 0
 * @invariant glTF JSON is valid 2.0 (asset.version="2.0"); GLB header magic=0x46546C67
 * @failure 2D-only or unknown entities silently skipped; empty → triangleCount:0
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
    '  format ("gltf" or "glb"), triangleCount, ' +
    '  text (glTF 2.0 JSON string — when binary=false, default), ' +
    '  base64 (GLB binary blob base64-encoded — when binary=true). ' +
    'The glTF contains a single mesh with POSITION and NORMAL attributes, a default PBR material, ' +
    'and a minimal scene/node graph. The BIN buffer is inlined as a data: URI in JSON mode. ' +
    'In GLB mode the 12-byte header + JSON chunk + BIN chunk are packed per the glTF 2.0 spec. ' +
    'entityIds: omit to export all 3D entities; provide an array to export a subset. ' +
    'binary: false (default) → data.text contains JSON; true → data.base64 contains GLB. ' +
    'Does NOT modify the document.',
  params: z.object({
    entityIds: z
      .array(z.string())
      .optional()
      .describe(
        'Array of entity ids to include in the export. Omit (or pass []) to export ALL ' +
          '3D solid entities in the document. 2D and unknown ids are silently skipped.',
      ),
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

    const collected = collectExportTriangles(doc, entityIds);
    const triangleCount = collected.tris.length;
    const { positions, normals } = buildGltfBuffers(collected.tris);
    const binPayload = buildBinPayload(positions, normals);
    const summary = exportSummary('export_gltf', binary ? 'glb' : 'gltf', collected);
    const jsonObj = buildGltfJson(positions, binPayload);

    if (binary) {
      const base64 = uint8ArrayToBase64(buildGlb(jsonObj, binPayload));
      return {
        document: doc,
        summary,
        affected: [],
        data: { format: 'glb', triangleCount, base64 },
      };
    }
    if (binPayload.length > 0) {
      const buffers = jsonObj['buffers'] as Array<Record<string, unknown>>;
      buffers[0]!['uri'] = `data:application/octet-stream;base64,${uint8ArrayToBase64(binPayload)}`;
    }
    const text = JSON.stringify(jsonObj, null, 2);
    return { document: doc, summary, affected: [], data: { format: 'gltf', triangleCount, text } };
  },
});
