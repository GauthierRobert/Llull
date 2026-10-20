/** extract_midsurface (read-only preview, 05 §4) and defeature_for_analysis (features removed before meshing, 05 §5.3). */

import type { AnalysisCase, DefeatureSpec } from '@core/model/analysis';
import { defineCommand, looseVec3, z } from '@core/commands/schema';
import { changed, report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { significantNumber } from '@lib/compactNumber';
import { caseOf, withCase } from '../shared/access';
import { refuseCode } from '../shared/codes';
import { analysisIdSchema } from '../shared/schemas';
import { midFaceArea, midsurfaceOf } from '../shell/midsurface';
import { isMidsurfaceRefusal } from '../shell/types';

/**
 * @invariant read-only; faces are planar polygons in document units (world frame), `normal` points to the top of the wall
 * @failure missing / 2D entity -> FEA_PART_INVALID; face pairing without maxThickness -> FEA_PARAM_INVALID; no exact kernel for a solid that is
 *   neither a box nor a sheet-metal part -> FEA_KERNEL_OCC_REQUIRED; no pair -> FEA_MIDSURFACE_NO_PAIRS
 */
export const extractMidsurface = defineCommand({
  name: 'extract_midsurface',
  description:
    'Preview the midsurface a shell idealization would mesh: data { method: sheet_metal | box_plate | face_pairing, faces [{ source, thickness, ' +
    'normal, area, outer, holes }], thicknesses, coverage (paired area fraction, shells need >= 0.98 by default), unpairedFaces (kernel face ' +
    'indices), warnings }. Sheet-metal parts and box plates come straight from their recipe; other solids pair planar faces <= maxThickness ' +
    'apart on the exact OCC kernel (cylindrical walls, extension and sewing of the mid faces are not built). Lengths in document units.',
  annotations: { readOnly: true },
  params: z.object({
    entityId: z.string().describe('Id of the 3D solid.'),
    maxThickness: z.number().positive().optional().describe('Thickest wall that pairs (document units); needed for face pairing.'),
    angularTolDeg: z.number().min(0).max(30).optional().describe('Largest angle between two paired faces, degrees (default 1).'),
  }),
  run: (doc, { entityId, maxThickness, angularTolDeg }, ctx): CommandResult => {
    const mid = midsurfaceOf(
      doc,
      entityId,
      { ...(maxThickness !== undefined ? { maxThickness } : {}), ...(angularTolDeg !== undefined ? { angularTolDeg } : {}) },
      ctx?.kernel ?? null,
    );
    if (isMidsurfaceRefusal(mid)) return refuseCode(doc, 'extract_midsurface', mid.code, mid.message, [entityId]);
    const faces = mid.faces.map((face) => ({ ...face, area: midFaceArea(face) }));
    const area = faces.reduce((sum, face) => sum + face.area, 0);
    return report(
      doc,
      `extract_midsurface: '${entityId}' ${mid.method}, ${faces.length} mid face(s), area ${significantNumber(area, 6)} ${doc.units}^2, ` +
        `thickness ${mid.thicknesses.map((t) => significantNumber(t, 6)).join(' / ')} ${doc.units}, coverage ${significantNumber(mid.coverage * 100, 4)} %` +
        `${mid.warnings.length > 0 ? `. ${mid.warnings.join('; ')}` : ''}.`,
      {
        entityId,
        method: mid.method,
        faces,
        thicknesses: mid.thicknesses,
        coverage: mid.coverage,
        unpairedFaces: mid.unpairedFaces,
        warnings: mid.warnings,
      },
    );
  },
});

/**
 * @affects doc.analysis.cases[analysisId].defeature[entityId] (set, replaced or removed; part of the mesh input hash: the mesh becomes stale)
 * @invariant the design entity is untouched: faces are removed from the mesher's copy only (Gmsh occ.defeature, STEP parts, at fea_mesh)
 * @failure unknown analysis -> FEA_ANALYSIS_NOT_FOUND; entity not a solid part of the case -> FEA_PART_NOT_IN_ANALYSIS; neither maxFeatureSize
 *   nor facesNear (without clear) -> FEA_PARAM_INVALID
 */
export const defeatureForAnalysis = defineCommand({
  name: 'defeature_for_analysis',
  description:
    'Remove small features from the analysed copy of a solid part before meshing (the design entity is untouched): maxFeatureSize removes ' +
    'cylinder / torus faces of radius <= that size (fillets, rounds, small holes), facesNear removes the faces nearest to the points. Runs in ' +
    'the mesher at fea_mesh (Gmsh occ.defeature, exact STEP geometry: OCC kernel); a refusal there names the faces. clear: true removes the ' +
    'setting. Lengths in document units. The mesh becomes stale.',
  params: z.object({
    analysisId: analysisIdSchema,
    entityId: z.string().describe('Id of a solid part of the analysis.'),
    maxFeatureSize: z.number().positive().optional().describe('Remove blends and holes of radius <= this (document units).'),
    facesNear: z.array(looseVec3('Point on a face to remove, document units.')).optional().describe('Faces to remove, picked by points.'),
    clear: z.boolean().optional().describe('true: remove the defeaturing of this part.'),
  }),
  run: (doc, { analysisId, entityId, maxFeatureSize, facesNear, clear }): CommandResult => {
    const fail = (code: string, message: string, paths: readonly string[] = []): CommandResult =>
      refuseCode(doc, 'defeature_for_analysis', code, message, [analysisId, entityId], paths);
    const found = caseOf(doc, analysisId);
    if (found === undefined) return fail('FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`, ['analysisId']);
    if (found.parts[entityId]?.kind !== 'solid')
      return fail('FEA_PART_NOT_IN_ANALYSIS', `'${entityId}' is not a solid part of '${analysisId}'`, ['entityId']);
    const rest = Object.fromEntries(Object.entries(found.defeature ?? {}).filter(([id]) => id !== entityId));
    if (clear === true) {
      const { defeature, ...without } = found;
      void defeature;
      const next: AnalysisCase = Object.keys(rest).length === 0 ? without : { ...without, defeature: rest };
      return changed(withCase(doc, next), `defeature_for_analysis: '${entityId}' of '${analysisId}' is meshed with all its features.`, [
        analysisId,
      ]);
    }
    if (maxFeatureSize === undefined && (facesNear === undefined || facesNear.length === 0))
      return fail('FEA_PARAM_INVALID', 'give maxFeatureSize and / or facesNear (or clear: true)', ['maxFeatureSize']);
    const spec: DefeatureSpec = {
      ...(maxFeatureSize !== undefined ? { maxFeatureSize } : {}),
      ...(facesNear !== undefined && facesNear.length > 0 ? { facesNear } : {}),
    };
    return changed(
      withCase(doc, { ...found, defeature: { ...rest, [entityId]: spec } }),
      `defeature_for_analysis: '${entityId}' of '${analysisId}' loses ${maxFeatureSize === undefined ? '' : `blends / holes of radius <= ${maxFeatureSize} ${doc.units}`}` +
        `${maxFeatureSize !== undefined && spec.facesNear !== undefined ? ' and ' : ''}${spec.facesNear === undefined ? '' : `${spec.facesNear.length} picked face(s)`} at fea_mesh (Gmsh, STEP parts).`,
      [analysisId],
    );
  },
});
