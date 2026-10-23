/** loft_surface: skinning through section curves, optionally through a guide network (Gordon surface). */

import type { CommandResult } from '../types';
import type { CadDocument } from '../../model/types';
import type { NurbsCurveData } from '../../lib/nurbs/types';
import { defineCommand, z } from '../schema';
import { gordonSurface } from '../../lib/nurbs/gordon';
import { skinCurves } from '../../lib/nurbs/surfaceFit';
import { maxCurveDeviation, sizeOfCurves, worldCurves } from './curveInputs';
import { buildLoft } from '../../geometry/loftSkin/build';
import type { LoftOptions } from '../../geometry/loftSkin/types';
import { loftAdvancedFields, parseEnd } from '../solids/loftAdvanced';
import { refuseSrf } from './shared';
import { refuseSwg } from './swgRefusal';
import { commitSurface, isRefusal, sig, surfaceStyleFields } from './surfaceShared';

const MAX_SECTIONS = 60;

type SheetParams = Parameters<typeof loftSurface.run>[1];

/** Skin through the sections with end conditions, alignment, coupling or a closed ring: one nurbs_surface per face (a coupled loft has several). */
function advancedSheet(doc: CadDocument, params: SheetParams, sections: NurbsCurveData[]): CommandResult {
  const refuse = (code: string, message: string): CommandResult => refuseSwg(doc, 'loft_surface', code, message, [], ['params']);
  const start = parseEnd(doc, params.startCondition, 'startCondition');
  if (start !== undefined && 'code' in start) return refuse(start.code, start.message);
  const end = parseEnd(doc, params.endCondition, 'endCondition');
  if (end !== undefined && 'code' in end) return refuse(end.code, end.message);
  const size = sizeOfCurves(sections);
  const options: LoftOptions = {
    ruled: params.degreeV === 1,
    closed: params.closed === true,
    solid: false,
    alignment: params.seams !== undefined ? 'seams' : (params.alignment ?? 'none'),
    seams: params.seams,
    coupling: params.coupling,
    vertexPairs: params.vertexPairs,
    start,
    end,
    guideTolerance: 1e-4 * size,
    fitTolerance: params.fitTolerance ?? 1e-6 * size,
    endAngleTolerance: params.endAngleRad ?? 0.01,
    faceTolerance: 1e-4 * size,
  };
  const built = buildLoft(sections, options);
  if ('code' in built) return refuse(built.code, built.message);
  let current = doc;
  const ids: string[] = [];
  for (const face of built.faces) {
    const made = commitSurface(current, face, { ...params, position: [0, 0, 0] }, () => '');
    current = made.document;
    ids.push(...made.affected);
  }
  const { report } = built;
  return {
    document: current,
    affected: ids,
    summary: `loft_surface: created ${ids.length} sheet(s) ${ids.map((id) => `"${id}"`).join(', ')} through ${sections.length} sections (section deviation ${sig(report.sectionDeviation)} ${doc.units}${report.startAngleRad === null && report.endAngleRad === null ? '' : `, end angles ${sig(report.startAngleRad ?? 0)} / ${sig(report.endAngleRad ?? 0)} rad`}).`,
    data: {
      faces: report.faceCount,
      sectionDeviation: sig(report.sectionDeviation),
      startAngleRad: report.startAngleRad === null ? null : sig(report.startAngleRad),
      endAngleRad: report.endAngleRad === null ? null : sig(report.endAngleRad),
      fitDeviation: sig(report.fitDeviation),
      unit: doc.units,
    },
  };
}

/**
 * @affects creates 1 nurbs_surface entity (world coordinates, position [0,0,0]) skinned through the sections
 * @invariant every section is reproduced (rational sections stay exact); with guides the patch also contains every guide (Gordon network, fitted)
 * @failure fewer than 2 sections -> SRF_LOFT_SECTIONS_TOO_FEW; unknown id / not a curve -> SRF_ENTITY_NOT_FOUND / SRF_NOT_NURBS; a guide missing a section -> SRF_LOFT_GUIDE_MISSES_SECTION; incompatible curves -> SRF_NURBS_INVALID
 */
export const loftSurface = defineCommand({
  name: 'loft_surface',
  description:
    'Skin a NURBS surface sheet through ordered section curves (nurbs_curve ids, e.g. from interpolate_curve, create_conic or airfoil_from_naca): ' +
    'u runs along each section, v across the sections in the order given. The sections are not resampled: they are made compatible ' +
    '(common degree and knots, exact) and the v poles interpolate them, so rational sections such as circles stay exact. Sections must ' +
    'start at corresponding points and run the same way. Optional `guideIds` (curves crossing every section within `guideTolerance`) turn ' +
    'it into a Gordon surface: the result contains the guides as well as the sections (fitted bicubic; the section deviation is reported). ' +
    '`degreeV` is the degree across the sections (1..5, default 3 capped by sections - 1; 1 gives a ruled skin). This is the sheet counterpart of ' +
    'loft_sections (which makes a solid). Next: analyze_surface_curvature, check_continuity, thicken_surface.',
  params: z.object({
    sectionIds: z.array(z.string()).describe('2..60 ordered nurbs_curve ids to skin through.'),
    guideIds: z
      .array(z.string())
      .describe('Optional nurbs_curve ids of guide curves that cross every section, listed across the sections.')
      .optional(),
    degreeV: z.number().describe('Degree across the sections, integer 1..5. Default 3 (capped by the number of sections - 1).').optional(),
    guideTolerance: z
      .number()
      .describe(
        'Largest distance (document units) between a guide and a section still counted as meeting. Default 1e-4 x the size of the curves.',
      )
      .optional(),
    startCondition: loftAdvancedFields.startCondition,
    endCondition: loftAdvancedFields.endCondition,
    alignment: loftAdvancedFields.alignment,
    seams: loftAdvancedFields.seams,
    coupling: loftAdvancedFields.coupling,
    vertexPairs: loftAdvancedFields.vertexPairs,
    closed: loftAdvancedFields.closed,
    fitTolerance: loftAdvancedFields.fitTolerance,
    endAngleRad: loftAdvancedFields.endAngleRad,
    ...surfaceStyleFields(),
  }),
  run: (doc, params): CommandResult => {
    const { sectionIds, guideIds = [] } = params;
    if (sectionIds.length < 2)
      return refuseSrf(
        doc,
        'loft_surface',
        'SRF_LOFT_SECTIONS_TOO_FEW',
        `a loft needs at least 2 sections (got ${sectionIds.length})`,
        [],
        ['params.sectionIds'],
      );
    if (sectionIds.length > MAX_SECTIONS || guideIds.length > MAX_SECTIONS)
      return refuseSrf(doc, 'loft_surface', 'SRF_PARAM_INVALID', `at most ${MAX_SECTIONS} sections and guides`, [], ['params.sectionIds']);
    const sections = worldCurves(doc, 'loft_surface', sectionIds, 'sectionIds');
    if (isRefusal(sections)) return sections;
    const guides = worldCurves(doc, 'loft_surface', guideIds, 'guideIds');
    if (isRefusal(guides)) return guides;
    const degreeV = Math.min(params.degreeV ?? 3, sections.length - 1);
    const advanced =
      [params.startCondition, params.endCondition, params.alignment, params.seams, params.coupling, params.vertexPairs].some(
        (value) => value !== undefined,
      ) || params.closed === true;
    if (advanced && guides.length === 0) return advancedSheet(doc, params, sections);
    if (guides.length === 0) {
      const skin = skinCurves(sections, degreeV);
      if ('code' in skin) return refuseSrf(doc, 'loft_surface', skin.code, skin.message, [], ['params.sectionIds']);
      const deviation = maxCurveDeviation(skin, sections);
      return commitSurface(
        doc,
        skin,
        { ...params, position: [0, 0, 0] },
        (id) =>
          `loft_surface: created ${skin.degreeU}x${skin.degreeV} surface "${id}" through ${sections.length} sections (max section deviation ${sig(deviation)} ${doc.units}).`,
      );
    }
    const tolerance = params.guideTolerance ?? 1e-4 * sizeOfCurves([...sections, ...guides]);
    if (!(tolerance > 0))
      return refuseSrf(doc, 'loft_surface', 'SRF_PARAM_INVALID', 'guideTolerance must be > 0', [], ['params.guideTolerance']);
    const gordon = gordonSurface(sections, guides, tolerance);
    if ('code' in gordon)
      return refuseSrf(
        doc,
        'loft_surface',
        gordon.code,
        gordon.message,
        [...(gordon.guide === undefined ? [] : [guideIds[gordon.guide] as string])],
        ['params.guideIds'],
      );
    return commitSurface(
      doc,
      gordon.surface,
      { ...params, position: [0, 0, 0] },
      (id) =>
        `loft_surface: created Gordon surface "${id}" through ${sections.length} sections and ${guides.length} guide(s) (guide gap ${sig(gordon.gap)}, guides within ${sig(gordon.guideDeviation)} of the surface, seam gap ${sig(gordon.seamGap)}, max section deviation ${sig(gordon.deviation)} ${doc.units}).`,
    );
  },
});
