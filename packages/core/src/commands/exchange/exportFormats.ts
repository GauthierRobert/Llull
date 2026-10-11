/**
 * export_obj and export_gltf: read-only exports of the world-space triangles shared with
 * `exportTriangulate.ts` (glTF scene layout: ./gltfScene.ts) (document returned unchanged, affected: []).
 *
 * @layer core/commands
 */

import type { CommandResult } from '../types';
import { report } from '../noop';
import { defineCommand, z } from '../schema';
import { uint8ArrayToBase64 } from '../../lib/base64';
import { collectExportTriangles, exportSummary } from '../../geometry/entityTriangles';
import type { Triangle } from '../../geometry/triangles';
import { facetNormal } from '../../geometry/tessellation';
import { buildGltfScene, collectExportParts } from './gltfScene';

const entityIdsField = z
  .array(z.string())
  .optional()
  .describe(
    'Array of entity ids to include in the export. Omit (or pass []) to export ALL ' +
      '3D solid entities in the document. 2D and unknown ids are silently skipped.',
  );

/** Wavefront OBJ text: per-facet normals, 1-based `f v//vn` indices. */
function buildObjText(tris: Triangle[], header: string, objectName: string): string {
  const lines: string[] = [header, `o ${objectName}`];
  for (const tri of tris) {
    for (const vertex of tri) lines.push(`v ${vertex.join(' ')}`);
  }
  for (const tri of tris) lines.push(`vn ${facetNormal(...tri).join(' ')}`);
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
    entityIds: entityIdsField,
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
    // One comment line only: a newline in the label would inject arbitrary OBJ records.
    const unitLabel = (units ?? doc.units).replace(/[\r\n\u2028\u2029]+/g, ' ').trim() || doc.units;

    const collected = collectExportTriangles(doc, entityIds);
    const triangleCount = collected.tris.length;
    const text = buildObjText(
      collected.tris,
      `# llull OBJ export — units: ${unitLabel}`,
      'llull_export',
    );
    const summary = exportSummary('export_obj', 'obj', collected);

    return report(doc, summary, { format: 'obj', text, triangleCount });
  },
});

/** Align a byte length to a 4-byte boundary (glTF chunk requirement). */
function align4(n: number): number {
  return (n + 3) & ~3;
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
    'Each part (entity, or each child of an instance) becomes its own named node + mesh (POSITION and ' +
    'creased smooth NORMAL attributes) with a PBR material: the assigned document material ' +
    '(color, metalness, roughness) or else the entity color, converted to linear glTF factors and ' +
    'shared between parts with the same appearance — ready for Blender / Cycles, three.js or any viewer. ' +
    'Node extras carry the llull entity id and kind. The BIN buffer is inlined as a data: URI in JSON mode. ' +
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

    const collected = collectExportTriangles(doc, entityIds);
    const triangleCount = collected.tris.length;
    const ids =
      entityIds && entityIds.length > 0
        ? entityIds.filter((id) => doc.entities[id] !== undefined)
        : doc.order;
    const parts = collectExportParts(doc, ids);
    const { json, bin } = buildGltfScene(parts);
    const materialCount = (json['materials'] as unknown[]).length;
    const summary = `${exportSummary('export_gltf', binary ? 'glb' : 'gltf', collected)} ${parts.length} part(s), ${materialCount} material(s).`;

    if (binary) {
      const base64 = uint8ArrayToBase64(buildGlb(json, bin));
      return {
        document: doc,
        summary,
        affected: [],
        data: { format: 'glb', triangleCount, partCount: parts.length, materialCount, base64 },
      };
    }
    const withUri =
      bin.length > 0
        ? {
            ...json,
            buffers: [
              {
                byteLength: bin.byteLength,
                uri: `data:application/octet-stream;base64,${uint8ArrayToBase64(bin)}`,
              },
            ],
          }
        : json;
    const text = JSON.stringify(withUri, null, 2);
    return report(doc, summary, {
      format: 'gltf',
      triangleCount,
      partCount: parts.length,
      materialCount,
      text,
    });
  },
});
