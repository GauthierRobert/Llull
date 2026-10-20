/** set_part_idealization: declare which solids an analysis meshes, and how (solid tets, shell on the midsurface, plane stress). */

import type { AnalysisCase, Idealization } from '@core/model/analysis';
import { is3D } from '@core/model/types';
import { defineCommand, looseVec3, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { caseOf, withCase } from '../shared/access';
import { refuseCode } from '../shared/codes';
import { analysisIdSchema } from '../shared/schemas';
import { resolvePlaneStress, resolveShell, type ResolvedIdealization } from '../shell/idealize';
import type { MidsurfaceRefusal } from '../shell/types';

const STRUCTURAL_2D: ReadonlySet<string> = new Set(['static', 'modal', 'buckling']);

/**
 * @affects doc.analysis.cases[analysisId].parts (adds or re-sets one part; affected: [analysisId])
 * @invariant shell: thickness stored as a number (given, the laminate's, or the single wall thickness of the midsurface); plane_stress: source faces in
 *   z = 0; shell / plane_stress only in static / modal / buckling cases; setting the same idealization again is a no-change success
 * @failure unknown analysis -> FEA_ANALYSIS_NOT_FOUND; missing / 2D entity, or shell / plane_stress in another case type -> FEA_PART_INVALID;
 *   plane_stress without thickness / sourceFacesNear -> FEA_PARAM_INVALID; midsurface / laminate / plane refusals (FEA_MIDSURFACE_*,
 *   FEA_KERNEL_OCC_REQUIRED, FEA_COMPOSITE_*, FEA_PLANE_STRESS_NOT_XY)
 */
export const setPartIdealization = defineCommand({
  name: 'set_part_idealization',
  description:
    'Add a 3D solid to an analysis as a meshed part. idealization "solid" (default): 3D tetrahedra. "shell": shell elements on the midsurface ' +
    '(sheet-metal parts and box plates need no kernel; other solids are face-paired on the exact OCC kernel: planar walls <= maxThickness), ' +
    'thickness = the wall thickness found (or give it), offset mid | top | bottom, optional compositePartId (06 CMP part: its laminateSectionId section, or its whole-face plies: ' +
    'a composite shell section). "plane_stress": 2D elements on the face near sourceFacesNear, which must lie in z = 0, with thickness. Shell ' +
    'and plane_stress are for static, modal and buckling cases. Constraints and loads still name points on the SOLID: a point on a side face ' +
    'of a plate targets the shell edge there. Preview the midsurface with extract_midsurface. Lengths in document units. The part needs a ' +
    'material (assign_material) before solving, except a composite shell.',
  params: z.object({
    analysisId: analysisIdSchema,
    entityId: z
      .string()
      .describe('Id of the 3D solid entity to analyse (box, cylinder, extrusion, boolean result, sheet-metal part, ...).'),
    idealization: z.enum(['solid', 'plane_stress', 'shell']).optional().describe('solid (default) | shell | plane_stress.'),
    thickness: z
      .number()
      .positive()
      .optional()
      .describe('Shell: section thickness (default: the wall thickness of the midsurface, or the laminate). plane_stress: required.'),
    offset: z
      .enum(['mid', 'top', 'bottom'])
      .optional()
      .describe('Shell: meshed reference surface, the midsurface (default) or the top / bottom wall surface.'),
    maxThickness: z
      .number()
      .positive()
      .optional()
      .describe('Shell: thickest wall that pairs into a midsurface (default 1.01 x thickness; needed for face pairing without thickness).'),
    angularTolDeg: z.number().min(0).max(30).optional().describe('Shell: largest angle between two paired faces, degrees (default 1).'),
    midsurfaceMinCoverage: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('Shell: paired-area fraction the midsurface needs (default 0.98). Lowering it meshes a partial midsurface: justify it.'),
    compositePartId: z.string().optional().describe('Shell: id of the 06 CMP composite part laid up on this entity (composite section).'),
    laminateSectionId: z
      .string()
      .optional()
      .describe(
        'Shell + compositePartId: id of a laminate section of that part (create_laminate_sections, e.g. one per zone); default: its whole-face plies.',
      ),
    sourceFacesNear: z
      .array(looseVec3('Point on (or near) a planar face of the solid in z = 0, document units.'))
      .optional()
      .describe('plane_stress: points picking the face(s) that form the 2D domain.'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const { analysisId, entityId, idealization: kind = 'solid' } = params;
    const fail = (code: string, message: string, ids: readonly string[], paths: readonly string[] = []): CommandResult =>
      refuseCode(doc, 'set_part_idealization', code, message, ids, paths);
    const analysisCase = caseOf(doc, analysisId);
    if (analysisCase === undefined) return fail('FEA_ANALYSIS_NOT_FOUND', `no analysis '${analysisId}'`, [analysisId], ['analysisId']);
    const entity = Object.hasOwn(doc.entities, entityId) ? doc.entities[entityId] : undefined;
    if (entity === undefined) return fail('FEA_PART_INVALID', `entity '${entityId}' does not exist`, [entityId], ['entityId']);
    if (!is3D(entity))
      return fail('FEA_PART_INVALID', `entity '${entityId}' is 2D (${entity.kind}); parts must be solids`, [entityId], ['entityId']);
    if (kind !== 'solid' && !STRUCTURAL_2D.has(analysisCase.type))
      return fail(
        'FEA_PART_INVALID',
        `${kind} parts are built for static, modal and buckling cases, not '${analysisCase.type}'`,
        [entityId],
        ['idealization'],
      );
    const kernel = ctx?.kernel ?? null;
    let resolved: ResolvedIdealization | MidsurfaceRefusal;
    if (kind === 'solid') resolved = { idealization: { kind: 'solid' }, note: 'solid' };
    else if (kind === 'plane_stress') {
      if (params.thickness === undefined || params.sourceFacesNear === undefined || params.sourceFacesNear.length === 0)
        return fail('FEA_PARAM_INVALID', 'plane_stress needs thickness and sourceFacesNear', [entityId], ['thickness']);
      resolved = resolvePlaneStress(doc, entityId, params.thickness, params.sourceFacesNear, kernel);
    } else
      resolved = resolveShell(
        doc,
        entityId,
        {
          ...(params.thickness !== undefined ? { thickness: params.thickness } : {}),
          ...(params.offset !== undefined ? { offset: params.offset } : {}),
          ...(params.maxThickness !== undefined ? { maxThickness: params.maxThickness } : {}),
          ...(params.angularTolDeg !== undefined ? { angularTolDeg: params.angularTolDeg } : {}),
          ...(params.midsurfaceMinCoverage !== undefined ? { minCoverage: params.midsurfaceMinCoverage } : {}),
          ...(params.compositePartId !== undefined ? { compositePartId: params.compositePartId } : {}),
          ...(params.laminateSectionId !== undefined ? { sectionId: params.laminateSectionId } : {}),
        },
        kernel,
      );
    if ('code' in resolved) return fail(resolved.code, resolved.message, [entityId], ['idealization']);
    const idealization: Idealization = resolved.idealization;
    const next: AnalysisCase = { ...analysisCase, parts: { ...analysisCase.parts, [entityId]: idealization } };
    const count = Object.keys(next.parts).length;
    return changed(
      withCase(doc, next),
      `set_part_idealization: '${entityId}' (${entity.kind}) is a ${kind} part of '${analysisId}' (${kind === 'solid' ? '' : `${resolved.note}; `}${count} part${count === 1 ? '' : 's'}).`,
      [analysisId],
    );
  },
});
