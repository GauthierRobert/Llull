/** export_bcf_viewpoint / import_bcf_viewpoint (plant 09 VIS §6): one review viewpoint as a BCF VisualizationInfo (*.bcfv) and back; for tests and plans. */

import { toMetres } from '../../../model/units';
import type { CommandResult } from '../../types';
import { confirmExportControlled, defineCommand, z } from '../../schema';
import { changed, exportRefusal, report } from '../../noop';
import { mintReviewId, reviewOf, reviewRejection } from '../../review/reviewModel';
import { bcfVisualizationXml } from './bcfXml';
import { parseVisualizationInfo } from './bcfVisualizationRead';
import { mapVisualization, viewpointOf } from './bcfViewpointMap';

/**
 * @affects nothing — read-only; data.visualizationInfo is the *.bcfv XML (metres, degrees)
 * @failure unknown viewpoint -> VIS_VIEWPOINT_NOT_FOUND
 */
export const exportBcfViewpoint = defineCommand({
  name: 'export_bcf_viewpoint',
  description:
    'Export one saved viewpoint (vp-<n>) as a BCF VisualizationInfo XML (*.bcfv: camera in metres, vertical field of view in degrees, the selected entities as ' +
    'Components with OriginatingSystem "llull" and AuthoringToolId, plus the IfcGuid of each product export_ifc writes for the entity, same derivation; ifcSchema picks the schema). data { visualizationInfo, camera { projection, cameraViewPointM, cameraDirection, ' +
    'cameraUpVector, fieldOfViewDeg | viewToWorldScaleM } }. Read-only. Errors: VIS_VIEWPOINT_NOT_FOUND, MAT_EXPORT_CONTROLLED. import_bcf_viewpoint reads it back.',
  annotations: { readOnly: true },
  params: z.object({
    id: z.string().describe('Viewpoint id, e.g. "vp-2" (list_viewpoints).'),
    ifcSchema: z
      .enum(['IFC4', 'IFC4X3_ADD2'])
      .optional()
      .describe(
        'The export_ifc schema the IfcGuid values refer to (default IFC4); a pipe has one product per straight and bend in IFC4X3_ADD2.',
      ),
    confirmExportControlled,
  }),
  run: (doc, { id, ifcSchema, confirmExportControlled: confirmation }, ctx): CommandResult => {
    const refused = exportRefusal(doc, 'export_bcf_viewpoint', 'share', confirmation, ctx);
    if (refused !== null) return refused;
    const viewpoint = reviewOf(doc).viewpoints[id];
    if (viewpoint === undefined)
      return reviewRejection(doc, 'export_bcf_viewpoint', 'VIS_VIEWPOINT_NOT_FOUND', `no viewpoint '${id}'`, [id], ['id']);
    const { camera } = viewpoint;
    const selection = (viewpoint.selection ?? []).filter((entityId) => doc.entities[entityId] !== undefined);
    const xml = bcfVisualizationXml(doc, viewpoint.guid, camera, 4 / 3, selection, '3.0', [], ifcSchema ?? 'IFC4');
    const eyeM = camera.eye.map((value) => toMetres(doc, value));
    const data = {
      visualizationInfo: xml,
      camera: {
        projection: camera.projection,
        cameraViewPointM: eyeM,
        cameraDirection: camera.direction,
        cameraUpVector: camera.up,
        ...(camera.projection === 'perspective'
          ? { fieldOfViewDeg: camera.fovDeg }
          : { viewToWorldScaleM: toMetres(doc, camera.viewHeight) }),
      },
    };
    return report(doc, `Exported viewpoint ${id} as BCF VisualizationInfo (${camera.projection}, ${selection.length} selected).`, data);
  },
});

/**
 * @affects adds 1 viewpoint to doc.review (affected: [viewpointId], id `vp-<n>`); metaHistory
 * @invariant untrusted XML through readXml (no DTD / entities, bounded); components naming no entity of the document are dropped and counted
 * @failure bad XML / no camera / invalid camera -> VIS_BCF_PARSE
 */
export const importBcfViewpoint = defineCommand({
  name: 'import_bcf_viewpoint',
  description:
    'Import one BCF VisualizationInfo XML (*.bcfv, BCF 2.1 or 3.0) as a saved viewpoint: perspective or orthogonal camera (metres -> document units), the ' +
    'selected components (AuthoringToolId = entity id when OriginatingSystem is "llull", else the IfcGuid resolved through the export_ifc GlobalId derivation; unresolved ones dropped and their IfcGuid listed), and the visibility exceptions. Returns the id ' +
    '(vp-<n>) in affected[0] and data { id, unmapped, unresolvedGuids (max 100), unresolvedCount }. Errors: VIS_BCF_PARSE.',
  annotations: { metaHistory: true },
  params: z.object({
    visualizationInfo: z.string().describe('The *.bcfv XML text.'),
    name: z.string().describe('Name of the new viewpoint.'),
  }),
  run: (doc, { visualizationInfo, name }): CommandResult => {
    const fail = (message: string): CommandResult =>
      reviewRejection(doc, 'import_bcf_viewpoint', 'VIS_BCF_PARSE', message, [], ['visualizationInfo']);
    const parsed = parseVisualizationInfo(visualizationInfo);
    if (typeof parsed === 'string') return fail(parsed);
    const mapped = mapVisualization(doc, parsed);
    if (typeof mapped === 'string') return fail(mapped);
    const [id, review] = mintReviewId(reviewOf(doc), 'vp');
    const document = {
      ...doc,
      review: {
        ...review,
        viewpoints: { ...review.viewpoints, [id]: viewpointOf(id, name, mapped) },
        viewpointOrder: [...review.viewpointOrder, id],
      },
    };
    const result = changed(
      document,
      `Imported BCF viewpoint ${id} "${name}" (${mapped.camera.projection}, ${mapped.selection.length} selected, ${mapped.unmapped} unmapped${mapped.unresolvedCount > 0 ? `; ${mapped.unresolvedCount} unresolved IfcGuid, first ${Math.min(mapped.unresolvedGuids.length, 5)}: ${mapped.unresolvedGuids.slice(0, 5).join(', ')}` : ''}).`,
      [id],
    );
    return {
      ...result,
      data: { id, unmapped: mapped.unmapped, unresolvedGuids: mapped.unresolvedGuids, unresolvedCount: mapped.unresolvedCount },
    };
  },
});
