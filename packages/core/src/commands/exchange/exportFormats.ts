/** export_obj: read-only export of the world-space triangles (document returned unchanged, affected: []). */

import type { CommandResult } from '../types';
import { currentContext } from '../context';
import { exportAssetRefusal } from '../mesh/meshCommon';
import { exportRefusal, report } from '../noop';
import { confirmExportControlled, defineCommand, z } from '../schema';
import { collectExportParts, exportSummary, type ExportPart } from '../../geometry/entityTriangles';
import { facetNormal } from '../../geometry/tessellation';

export const entityIdsField = z
  .array(z.string())
  .optional()
  .describe(
    'Array of entity ids to include in the export. Omit (or pass []) to export ALL ' +
      '3D solid entities in the document. 2D and unknown ids are silently skipped.',
  );

/** Single-token OBJ object name: whitespace and control characters would split or inject records. */
function objObjectName(part: ExportPart): string {
  return (part.name ?? part.id).replace(/[\s\p{Cc}\u2028\u2029]+/gu, '_') || part.id;
}

/** Wavefront OBJ text: one `o <entity name or id>` object per entity, per-facet normals, `f v//vn`. */
function buildObjText(parts: readonly ExportPart[], header: string): string {
  const lines: string[] = [header];
  let vertexBase = 0;
  let normalBase = 0;
  for (const part of parts) {
    const { tris } = part;
    if (tris.length === 0) continue;
    lines.push(`o ${objObjectName(part)}`);
    for (const tri of tris) {
      for (const vertex of tri) lines.push(`v ${vertex.join(' ')}`);
    }
    for (const tri of tris) lines.push(`vn ${facetNormal(...tri).join(' ')}`);
    for (let i = 0; i < tris.length; i++) {
      const vi = vertexBase + i * 3 + 1;
      const ni = normalBase + i + 1;
      lines.push(`f ${vi}//${ni} ${vi + 1}//${ni} ${vi + 2}//${ni}`);
    }
    vertexBase += tris.length * 3;
    normalBase += tris.length;
  }
  return lines.join('\n');
}

/**
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
    'Each entity is one OBJ object (`o <entity name or id>`). ' +
    'entityIds: omit to export all 3D entities; provide an array to export a subset. ' +
    'units: optional units label embedded in the OBJ comment (defaults to doc units). Does NOT modify the document.',
  params: z.object({
    entityIds: entityIdsField,
    confirmExportControlled,
    units: z
      .string()
      .optional()
      .describe(
        'Units label to embed in the OBJ comment header (e.g. "mm", "cm", "in"). ' +
          'Defaults to the document units setting. Informational only — OBJ has no unit standard.',
      ),
  }),
  run: (doc, params, ctx): CommandResult => {
    const { entityIds, units } = params;
    const refused = exportRefusal(doc, 'export_obj', 'obj', params.confirmExportControlled, ctx);
    if (refused !== null) return refused;
    // One comment line only: a newline in the label would inject arbitrary OBJ records.
    const unitLabel = (units ?? doc.units).replace(/[\r\n\u2028\u2029]+/g, ' ').trim() || doc.units;
    const collected = collectExportParts(doc, entityIds, (ctx ?? currentContext()).meshAssets);
    const unreadable = exportAssetRefusal(doc, 'export_obj', collected.unreadable);
    if (unreadable !== null) return unreadable;
    const tris = collected.parts.flatMap((part) => part.tris);
    const triangleCount = tris.length;
    const text = buildObjText(collected.parts, `# llull OBJ export — units: ${unitLabel}`);
    const summary = exportSummary('export_obj', 'obj', { ...collected, tris });
    return report(doc, summary, { format: 'obj', text, triangleCount });
  },
});
