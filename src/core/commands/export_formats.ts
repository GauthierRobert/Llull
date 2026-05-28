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

import type { CadDocument, Vec3 } from '../model/types';
import { is3D } from '../model/types';
import type { CommandDefinition, CommandResult } from './types';
import { entityToTriangles } from './export';
import type { Triangle } from './export';

// ---------------------------------------------------------------------------
// Shared triangle-collection helper
// ---------------------------------------------------------------------------

/**
 * Collect world-space triangles for the given entity ids (or all 3D entities
 * when `requestedIds` is undefined/empty).  Returns triangles + accounting data.
 */
function collectTriangles(
  doc: CadDocument,
  requestedIds: string[] | undefined,
): { tris: Triangle[]; skipped2D: number; unknownIds: string[] } {
  let idsToProcess: string[];
  const unknownIds: string[] = [];

  if (requestedIds && requestedIds.length > 0) {
    idsToProcess = [];
    for (const id of requestedIds) {
      if (doc.entities[id]) {
        idsToProcess.push(id);
      } else {
        unknownIds.push(id);
      }
    }
  } else {
    idsToProcess = doc.order;
  }

  const tris: Triangle[] = [];
  let skipped2D = 0;
  for (const id of idsToProcess) {
    const e = doc.entities[id];
    if (!e) continue;
    if (!is3D(e)) { skipped2D++; continue; }
    const entityTris = entityToTriangles(e, doc);
    for (const t of entityTris) tris.push(t);
  }

  return { tris, skipped2D, unknownIds };
}

// ---------------------------------------------------------------------------
// Math helpers (pure)
// ---------------------------------------------------------------------------

function sub3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross3(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function len3(a: Vec3): number {
  return Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
}

function normalize3(a: Vec3): Vec3 {
  const l = len3(a);
  return l > 1e-10 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1];
}

function facetNormal(v0: Vec3, v1: Vec3, v2: Vec3): Vec3 {
  return normalize3(cross3(sub3(v1, v0), sub3(v2, v0)));
}

// ---------------------------------------------------------------------------
// Pure base64 encoder — no Node Buffer, no DOM (same as export.ts)
// ---------------------------------------------------------------------------

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function uint8ArrayToBase64(bytes: Uint8Array): string {
  const out: string[] = [];
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < len ? bytes[i + 1]! : 0;
    const b2 = i + 2 < len ? bytes[i + 2]! : 0;
    out.push(B64_CHARS[b0 >> 2]!);
    out.push(B64_CHARS[((b0 & 0x03) << 4) | (b1 >> 4)]!);
    out.push(i + 1 < len ? B64_CHARS[((b1 & 0x0f) << 2) | (b2 >> 6)]! : '=');
    out.push(i + 2 < len ? B64_CHARS[b2 & 0x3f]! : '=');
  }
  return out.join('');
}

// ---------------------------------------------------------------------------
// OBJ serialisation
// ---------------------------------------------------------------------------

/**
 * Build a Wavefront OBJ text string from a triangle list.
 * Each triangle becomes 3 vertices + 1 face.  Normals are per-facet.
 * Indices are 1-based (OBJ convention).
 */
function buildObjText(tris: Triangle[], objectName: string): string {
  const lines: string[] = [
    `# Exported by llull`,
    `o ${objectName}`,
  ];

  // Write all vertices then all normals then all faces.
  const normals: Vec3[] = [];
  for (const [v0, v1, v2] of tris) {
    normals.push(facetNormal(v0, v1, v2));
  }

  for (const [v0, v1, v2] of tris) {
    lines.push(`v ${v0[0]} ${v0[1]} ${v0[2]}`);
    lines.push(`v ${v1[0]} ${v1[1]} ${v1[2]}`);
    lines.push(`v ${v2[0]} ${v2[1]} ${v2[2]}`);
  }

  for (const n of normals) {
    lines.push(`vn ${n[0]} ${n[1]} ${n[2]}`);
  }

  // f v//vn  v//vn  v//vn  (one face per triangle, 1-based)
  for (let i = 0; i < tris.length; i++) {
    const vi = i * 3 + 1; // first vertex index of this triangle (1-based)
    const ni = i + 1;     // normal index (1-based)
    lines.push(`f ${vi}//${ni} ${vi + 1}//${ni} ${vi + 2}//${ni}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// ExportObj public data shape
// ---------------------------------------------------------------------------

export interface ExportObjData {
  /** Always 'obj'. */
  format: 'obj';
  /** Full Wavefront OBJ text. */
  text: string;
  /** Total triangles exported. */
  triangleCount: number;
}

// ---------------------------------------------------------------------------
// export_obj command
// ---------------------------------------------------------------------------

interface ExportObjParams {
  /** Ids of entities to export. Omit (or pass []) to export all 3D entities. */
  entityIds?: string[];
  /** Units label for the OBJ comment header. Defaults to doc.units. */
  units?: string;
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
export const exportObj: CommandDefinition<ExportObjParams> = {
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
  paramsSchema: {
    type: 'object',
    properties: {
      entityIds: {
        type: 'array',
        description:
          'Array of entity ids to include in the export. Omit (or pass []) to export ALL ' +
          '3D solid entities in the document. 2D and unknown ids are silently skipped.',
        items: { type: 'string' },
      },
      units: {
        type: 'string',
        description:
          'Units label to embed in the OBJ comment header (e.g. "mm", "cm", "in"). ' +
          'Defaults to the document units setting. Informational only — OBJ has no unit standard.',
      },
    },
    required: [],
  },
  run: (doc, params): CommandResult => {
    const { entityIds, units } = params as ExportObjParams;
    const unitLabel = units ?? (doc as CadDocument & { units?: string }).units ?? 'mm';

    const { tris, skipped2D, unknownIds } = collectTriangles(doc, entityIds);
    const triangleCount = tris.length;

    const text = [
      `# llull OBJ export — units: ${unitLabel}`,
      buildObjText(tris, 'llull_export').split('\n').slice(1).join('\n'),
    ].join('\n');

    const parts: string[] = [
      `export_obj: ${triangleCount} triangle${triangleCount !== 1 ? 's' : ''} exported (format=obj).`,
    ];
    if (skipped2D > 0) parts.push(`${skipped2D} 2D entit${skipped2D !== 1 ? 'ies' : 'y'} skipped.`);
    if (unknownIds.length > 0) parts.push(`Unknown ids skipped: ${unknownIds.join(', ')}.`);

    const data: ExportObjData = { format: 'obj', text, triangleCount };
    return { document: doc, summary: parts.join(' '), affected: [], data };
  },
};

// ---------------------------------------------------------------------------
// glTF 2.0 serialisation
// ---------------------------------------------------------------------------

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
function computeAabb(positions: Float32Array): { min: [number, number, number]; max: [number, number, number] } {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!, y = positions[i + 1]!, z = positions[i + 2]!;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  if (!isFinite(minX)) { minX = 0; minY = 0; minZ = 0; maxX = 0; maxY = 0; maxZ = 0; }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

/** Align a byte length to a 4-byte boundary (glTF chunk requirement). */
function align4(n: number): number {
  return (n + 3) & ~3;
}

/**
 * Build a minimal valid glTF 2.0 JSON object from a triangle list.
 * Positions and normals are stored as separate bufferview/accessor pairs.
 * The binary buffer payload is returned as a separate Uint8Array.
 */
function buildGltfJson(
  tris: Triangle[],
  binBuffer: Uint8Array,
): Record<string, unknown> {
  const vertexCount = tris.length * 3;
  // Buffer layout: positions (float32×3 per vertex) then normals (float32×3 per vertex)
  const posByteLength = vertexCount * 3 * 4;
  const normByteLength = vertexCount * 3 * 4;

  const { positions } = buildGltfBuffers(tris);
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
    buffers: [
      { byteLength: binBuffer.byteLength },
    ],
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
  view.setUint32(off, 0x46546C67, true); off += 4; // magic 'glTF'
  view.setUint32(off, 2, true);           off += 4; // version 2
  view.setUint32(off, totalLength, true); off += 4; // total length

  // JSON chunk
  view.setUint32(off, jsonPadded, true);       off += 4;
  view.setUint32(off, 0x4E4F534A, true);       off += 4; // 'JSON'
  buf.set(jsonBytes, off);
  // pad with spaces (0x20)
  for (let i = jsonBytes.length; i < jsonPadded; i++) buf[off + i] = 0x20;
  off += jsonPadded;

  if (binPayload.length > 0) {
    // BIN chunk
    view.setUint32(off, binPadded, true);        off += 4;
    view.setUint32(off, 0x004E4942, true);       off += 4; // 'BIN\0'
    buf.set(binPayload, off);
    // pad with zeros
    for (let i = binPayload.length; i < binPadded; i++) buf[off + i] = 0;
    off += binPadded;
  }

  return buf;
}

/** Build the combined BIN buffer payload (positions then normals, each Float32Array → Uint8Array). */
function buildBinPayload(tris: Triangle[]): Uint8Array {
  if (tris.length === 0) return new Uint8Array(0);
  const { positions, normals } = buildGltfBuffers(tris);
  const posBytes = new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength);
  const normBytes = new Uint8Array(normals.buffer, normals.byteOffset, normals.byteLength);
  const combined = new Uint8Array(posBytes.length + normBytes.length);
  combined.set(posBytes, 0);
  combined.set(normBytes, posBytes.length);
  return combined;
}

// ---------------------------------------------------------------------------
// ExportGltf public data shape
// ---------------------------------------------------------------------------

export interface ExportGltfData {
  /** 'gltf' for JSON output, 'glb' for binary container. */
  format: 'gltf' | 'glb';
  /** Total triangles exported. */
  triangleCount: number;
  /** Present when format='gltf': the glTF 2.0 JSON text. */
  text?: string;
  /** Present when format='glb': base64-encoded GLB binary blob. */
  base64?: string;
}

// ---------------------------------------------------------------------------
// export_gltf command
// ---------------------------------------------------------------------------

interface ExportGltfParams {
  /** Ids of entities to export. Omit (or pass []) to export all 3D entities. */
  entityIds?: string[];
  /**
   * When true, produce a self-contained GLB binary container (base64-encoded in
   * data.base64).  When false (default), produce a glTF 2.0 JSON text in data.text
   * with the BIN buffer inlined as a data: URI in buffers[0].uri.
   */
  binary?: boolean;
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
export const exportGltf: CommandDefinition<ExportGltfParams> = {
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
  paramsSchema: {
    type: 'object',
    properties: {
      entityIds: {
        type: 'array',
        description:
          'Array of entity ids to include in the export. Omit (or pass []) to export ALL ' +
          '3D solid entities in the document. 2D and unknown ids are silently skipped.',
        items: { type: 'string' },
      },
      binary: {
        type: 'boolean',
        description:
          'Output format selector. false (default): data.text contains a glTF 2.0 JSON string ' +
          'with the binary buffer inlined as a data: URI. ' +
          'true: data.base64 contains a base64-encoded GLB binary container ' +
          '(12-byte header + JSON chunk + BIN chunk per glTF 2.0 spec). ' +
          'Most web viewers accept JSON glTF; most desktop importers accept GLB.',
      },
    },
    required: [],
  },
  run: (doc, params): CommandResult => {
    const { entityIds, binary = false } = params as ExportGltfParams;

    const { tris, skipped2D, unknownIds } = collectTriangles(doc, entityIds);
    const triangleCount = tris.length;

    const binPayload = buildBinPayload(tris);

    const parts: string[] = [
      `export_gltf: ${triangleCount} triangle${triangleCount !== 1 ? 's' : ''} exported (format=${binary ? 'glb' : 'gltf'}).`,
    ];
    if (skipped2D > 0) parts.push(`${skipped2D} 2D entit${skipped2D !== 1 ? 'ies' : 'y'} skipped.`);
    if (unknownIds.length > 0) parts.push(`Unknown ids skipped: ${unknownIds.join(', ')}.`);

    if (binary) {
      const jsonObj = buildGltfJson(tris, binPayload);
      const glbBytes = buildGlb(jsonObj, binPayload);
      const base64 = uint8ArrayToBase64(glbBytes);
      const data: ExportGltfData = { format: 'glb', triangleCount, base64 };
      return { document: doc, summary: parts.join(' '), affected: [], data };
    } else {
      // JSON mode: inline BIN as a data: URI so the JSON is self-contained
      const binBase64 = binPayload.length > 0 ? uint8ArrayToBase64(binPayload) : '';
      const jsonObj = buildGltfJson(tris, binPayload) as Record<string, unknown>;

      // Patch buffers[0] to carry the data URI
      if (binPayload.length > 0) {
        const buffers = jsonObj['buffers'] as Array<Record<string, unknown>>;
        buffers[0]!['uri'] = `data:application/octet-stream;base64,${binBase64}`;
      }

      const text = JSON.stringify(jsonObj, null, 2);
      const data: ExportGltfData = { format: 'gltf', triangleCount, text };
      return { document: doc, summary: parts.join(' '), affected: [], data };
    }
  },
};
