/**
 * export_obj and export_gltf — Wavefront OBJ and glTF 2.0 / GLB export commands.
 *
 * Both are read-only: the document is returned unchanged, affected:[].
 * Triangle tessellation is shared via `entityToTriangles` from export.ts — no
 * duplication of geometry code.  Instance entities are expanded recursively via
 * expandInstance (assemblies.ts).  Revolution entities are fully tessellated.
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

interface ExportObjData {
  /** Always 'obj'. */
  format: 'obj';
  /** Full Wavefront OBJ text. */
  text: string;
  /** Total triangles exported. */
  triangleCount: number;
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

    const data: ExportObjData = { format: 'obj', text, triangleCount };
    return { document: doc, summary, affected: [], data };
  },
});

/**
 * Build a Float32Array of interleaved position+normal data for all triangles.
 * Layout per vertex: [px, py, pz, nx, ny, nz] — 6 floats, 24 bytes.
 * Returns separate position and normal arrays for glTF separate accessors.
 */
function buildGltfBuffers(tris: Triangle[]): {
  positions: Float32Array;
  normals: Float32Array;
} {
  const count = tris.length * 3; // total vertices
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);

  let vi = 0;
  for (const [v0, v1, v2] of tris) {
    const n = facetNormal(v0, v1, v2);
    for (const v of [v0, v1, v2]) {
      positions[vi * 3 + 0] = v[0];
      positions[vi * 3 + 1] = v[1];
      positions[vi * 3 + 2] = v[2];
      normals[vi * 3 + 0] = n[0];
      normals[vi * 3 + 1] = n[1];
      normals[vi * 3 + 2] = n[2];
      vi++;
    }
  }

  return { positions, normals };
}

/** Compute axis-aligned bounding box [minX,minY,minZ] / [maxX,maxY,maxZ]. */
function computeAabb(positions: Float32Array): {
  min: [number, number, number];
  max: [number, number, number];
} {
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!,
      y = positions[i + 1]!,
      z = positions[i + 2]!;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  if (!isFinite(minX)) {
    minX = 0;
    minY = 0;
    minZ = 0;
    maxX = 0;
    maxY = 0;
    maxZ = 0;
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
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
  // Buffer layout: positions (float32×3 per vertex) then normals (float32×3 per vertex)
  const posByteLength = vertexCount * 3 * 4;
  const normByteLength = vertexCount * 3 * 4;

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

/**
 * Pack JSON chunk + BIN chunk into a GLB binary container.
 * GLB format: 12-byte file header + JSON chunk + BIN chunk.
 *   - Each chunk: 4-byte length (LE) + 4-byte type + payload (padded to 4 bytes).
 *   - JSON chunk type: 0x4E4F534A ('JSON')
 *   - BIN  chunk type: 0x004E4942 ('BIN\0')
 */
function buildGlb(jsonObj: Record<string, unknown>, binPayload: Uint8Array): Uint8Array {
  const jsonStr = JSON.stringify(jsonObj);
  const jsonBytes = new TextEncoder().encode(jsonStr);
  const jsonPadded = align4(jsonBytes.length);
  const binPadded = align4(binPayload.length);

  const totalLength = 12 + 8 + jsonPadded + (binPayload.length > 0 ? 8 + binPadded : 0);
  const buf = new Uint8Array(totalLength);
  const view = new DataView(buf.buffer);

  let off = 0;
  // File header
  view.setUint32(off, 0x46546c67, true);
  off += 4; // magic 'glTF'
  view.setUint32(off, 2, true);
  off += 4; // version 2
  view.setUint32(off, totalLength, true);
  off += 4; // total length

  // JSON chunk
  view.setUint32(off, jsonPadded, true);
  off += 4;
  view.setUint32(off, 0x4e4f534a, true);
  off += 4; // 'JSON'
  buf.set(jsonBytes, off);
  // pad with spaces (0x20)
  for (let i = jsonBytes.length; i < jsonPadded; i++) buf[off + i] = 0x20;
  off += jsonPadded;

  if (binPayload.length > 0) {
    // BIN chunk
    view.setUint32(off, binPadded, true);
    off += 4;
    view.setUint32(off, 0x004e4942, true);
    off += 4; // 'BIN\0'
    buf.set(binPayload, off);
    // pad with zeros
    for (let i = binPayload.length; i < binPadded; i++) buf[off + i] = 0;
    off += binPadded;
  }

  return buf;
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

interface ExportGltfData {
  /** 'gltf' for JSON output, 'glb' for binary container. */
  format: 'gltf' | 'glb';
  /** Total triangles exported. */
  triangleCount: number;
  /** Present when format='gltf': the glTF 2.0 JSON text. */
  text?: string;
  /** Present when format='glb': base64-encoded GLB binary blob. */
  base64?: string;
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
      const data: ExportGltfData = { format: 'glb', triangleCount, base64 };
      return { document: doc, summary, affected: [], data };
    }
    if (binPayload.length > 0) {
      const buffers = jsonObj['buffers'] as Array<Record<string, unknown>>;
      buffers[0]!['uri'] = `data:application/octet-stream;base64,${uint8ArrayToBase64(binPayload)}`;
    }
    const data: ExportGltfData = {
      format: 'gltf',
      triangleCount,
      text: JSON.stringify(jsonObj, null, 2),
    };
    return { document: doc, summary, affected: [], data };
  },
});
