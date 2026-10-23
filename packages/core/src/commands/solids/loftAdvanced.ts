/** Advanced `loft_sections` (SWG M5/M7): end conditions, seam alignment, closed lofts, centrelines, guides, vertex / arc-length coupling, rational sections. */

import type { CadDocument, Vec3 } from '../../model/types';
import type { CommandResult } from '../types';
import { z } from '../schema';
import { idOrNext } from '../../lib/explicitId';
import { isVec3, sub3 } from '../../lib/vec3';
import { mapSurfacePoles } from '../../lib/nurbs/surface';
import { isClosedCurve } from '../../lib/nurbs/reseam';
import type { NurbsCurveData } from '../../lib/nurbs/types';
import { sig } from '../surface/surfaceShared';
import { refuseSwg } from '../surface/swgRefusal';
import { placedSurface } from '../../geometry/nurbsSurface';
import { wireCentroid } from '../../lib/nurbs/skinEnds';
import { buildLoft } from '../../geometry/loftSkin/build';
import { displayRings } from '../../geometry/loftSkin/display';
import type { EndRequest, LoftIssue, LoftOptions } from '../../geometry/loftSkin/types';
import { newEntity } from '../entity/newEntity';
import { commitSolid, existingLayerOrDefault } from './shared';
import type { SectionSpec } from './sectionSpecs';
import { anyWorldCurve, sketchSectionCurve, specCurve, worldCurveOf } from './loftSectionCurves';

const conditionShape = {
  type: z
    .enum(['free', 'normal', 'direction', 'tangent_to_face', 'curvature_to_face', 'point'])
    .describe(
      'free: no condition (default); normal: leave perpendicular to the section plane; direction: leave along `direction`; tangent_to_face: tangent to the sheet `faceId` (G1); ' +
        'curvature_to_face: tangent and curvature continuous with the sheet (G2); point: add the single point `at` beyond that end section as a tip (a nose or cone apex); every given section is kept.',
    ),
  magnitude: z
    .number()
    .describe(
      'Speed of the departure, > 0, default 1 = the natural speed (the distance to the next section per unit of parameter). Larger bulges the loft out along the condition.',
    )
    .optional(),
  direction: z.array(z.number()).describe('direction only: [x, y, z] world direction (non-zero).').optional(),
  draftDeg: z
    .number()
    .describe('normal only: tilt of the departure toward the section centre in degrees (positive narrows the loft).')
    .optional(),
  faceId: z.string().describe('tangent_to_face / curvature_to_face: id of the nurbs_surface the end section lies on.').optional(),
  at: z.array(z.number()).describe('point only: [x, y, z] of the tip. Only valid at the first or last section.').optional(),
};

const conditionField = (which: 'startCondition' | 'endCondition'): z.ZodOptional<z.ZodObject<typeof conditionShape>> =>
  z
    .object(conditionShape)
    .describe(
      `${which === 'startCondition' ? 'How the loft leaves the FIRST section' : 'How the loft arrives at the LAST section'}: ` +
        '{ type: free | normal | direction | tangent_to_face | curvature_to_face | point, magnitude, direction, draftDeg, faceId, at }. Needs a smooth loft (not ruled).',
    )
    .optional();

export const loftAdvancedFields = {
  startCondition: conditionField('startCondition'),
  endCondition: conditionField('endCondition'),
  alignment: z
    .enum(['auto', 'none'])
    .describe(
      'Seam alignment of closed sections (exact re-seaming, shapes unchanged): auto moves each section start to the point nearest the previous start so rulings do not twist; none keeps the starts as built (a seam one corner apart twists a square loft to 2/3 of its volume).',
    )
    .optional(),
  seams: z
    .array(z.number())
    .describe('One curve-parameter fraction 0..1 per section where its seam goes (overrides alignment).')
    .optional(),
  coupling: z
    .enum(['arc_length', 'vertices'])
    .describe(
      'How the points of neighbouring sections pair up: arc_length (equal fractions of arc length; the sections are cut at every corner so corners stay edges), vertices (cut at the fractions of `vertexPairs`; one face per segment).',
    )
    .optional(),
  vertexPairs: z
    .array(z.array(z.number()))
    .describe(
      'coupling vertices: per section the ascending curve-parameter fractions 0..1 of its vertices (same count per section; the first is the seam of a closed section).',
    )
    .optional(),
  closed: z
    .boolean()
    .describe('Join the last section back to the first (a ring such as a torus or a duct loop; >= 3 sections, smooth, no end caps).')
    .optional(),
  centerlineId: z
    .string()
    .describe(
      'Two sections only: id of a curve (arc, spline, nurbs_curve) from the first to the last section centre; `sectionCount` blended sections are placed normal to it.',
    )
    .optional(),
  sectionCount: z.number().describe('With centerlineId: number of intermediate sections, integer 1..64 (default 8).').optional(),
  guideIds: z
    .array(z.string())
    .describe('Guide curves (nurbs_curve ids) crossing every section: the loft becomes a Gordon surface that contains them.')
    .optional(),
  guideTolerance: z
    .number()
    .describe('Largest gap (document units) between a guide and a section still counted as meeting. Default 1e-4 x the loft size.')
    .optional(),
  fitTolerance: z
    .number()
    .describe('Largest refit deviation (document units) of arc_length coupling. Default 1e-6 x the loft size.')
    .optional(),
  endAngleRad: z
    .number()
    .describe('Largest allowed angle (radians) between a loft end and its target before the end section is refined. Default 0.01.')
    .optional(),
};

type ConditionInput = {
  type: 'free' | 'normal' | 'direction' | 'tangent_to_face' | 'curvature_to_face' | 'point';
  magnitude?: number | undefined;
  direction?: number[] | undefined;
  draftDeg?: number | undefined;
  faceId?: string | undefined;
  at?: number[] | undefined;
};

export interface AdvancedParams {
  readonly startCondition?: ConditionInput | undefined;
  readonly endCondition?: ConditionInput | undefined;
  readonly alignment?: 'auto' | 'none' | undefined;
  readonly seams?: number[] | undefined;
  readonly coupling?: 'arc_length' | 'vertices' | undefined;
  readonly vertexPairs?: number[][] | undefined;
  readonly closed?: boolean | undefined;
  readonly centerlineId?: string | undefined;
  readonly sectionCount?: number | undefined;
  readonly guideIds?: string[] | undefined;
  readonly guideTolerance?: number | undefined;
  readonly fitTolerance?: number | undefined;
  readonly endAngleRad?: number | undefined;
  readonly ruled?: boolean | undefined;
}

/** True when a request needs the TypeScript skin (any advanced field, or rational exact sections). */
export function needsAdvancedLoft(doc: CadDocument, params: AdvancedParams, sectionIds: readonly string[] | undefined): boolean {
  const given = [
    params.startCondition,
    params.endCondition,
    params.alignment,
    params.seams,
    params.coupling,
    params.vertexPairs,
    params.centerlineId,
    params.guideIds,
  ];
  if (params.closed === true || given.some((value) => value !== undefined)) return true;
  if (sectionIds === undefined || sectionIds.length === 0) return false;
  const curves = sectionIds.map((id) => doc.entities[id]);
  // closed rational sections (circles, ellipses) skin exactly; an open one keeps the old refusal
  return (
    curves.every((entity) => entity?.kind === 'nurbs_curve' && isClosedCurve(entity.curve)) &&
    curves.some((entity) => entity?.kind === 'nurbs_curve' && entity.curve.weights !== undefined)
  );
}

/** The request for one loft end, `undefined` for a free end, or the coded refusal. */
export function parseEnd(doc: CadDocument, input: ConditionInput | undefined, path: string): EndRequest | undefined | LoftIssue {
  if (input === undefined || input.type === 'free') return undefined;
  const invalid = (message: string): LoftIssue => ({ code: 'SWG_LOFT_END_CONDITION_INVALID', message: `${path}: ${message}` });
  const magnitude = input.magnitude ?? 1;
  switch (input.type) {
    case 'normal':
      return { type: 'normal', magnitude, ...(input.draftDeg === undefined ? {} : { draftDeg: input.draftDeg }) };
    case 'direction':
      return input.direction !== undefined && isVec3(input.direction)
        ? { type: 'direction', direction: input.direction as Vec3, magnitude }
        : invalid('direction needs a finite [x, y, z]');
    case 'point':
      return input.at !== undefined && isVec3(input.at)
        ? { type: 'point', at: input.at as Vec3 }
        : invalid('point needs a finite [x, y, z] `at`');
    default: {
      const face = input.faceId === undefined ? undefined : doc.entities[input.faceId];
      if (face?.kind !== 'nurbs_surface') return invalid(`${input.type} needs the id of a nurbs_surface in faceId`);
      return { type: 'face', surface: placedSurface(face), magnitude, curvature: input.type === 'curvature_to_face' };
    }
  }
}

/** World curves of the sections (ids, or inline specs), or the reason they are unusable. */
export function sectionCurvesOf(
  doc: CadDocument,
  sectionIds: readonly string[] | undefined,
  sections: ReadonlyArray<SectionSpec & { center: Vec3; rotation?: Vec3 | undefined }> | undefined,
): NurbsCurveData[] | string {
  const curves: NurbsCurveData[] = [];
  const count = (sectionIds ?? sections ?? []).length;
  for (let i = 0; i < count; i++) {
    let made: NurbsCurveData | string;
    if (sectionIds !== undefined) {
      const entity = doc.entities[sectionIds[i] as string];
      made = entity?.kind === 'nurbs_curve' ? worldCurveOf(entity) : sketchSectionCurve(doc, sectionIds[i] as string);
    } else made = specCurve(doc, (sections as NonNullable<typeof sections>)[i] as NonNullable<typeof sections>[number]);
    if (typeof made === 'string') return `section ${i}: ${made}`;
    curves.push(made);
  }
  return curves;
}

const sizeOf = (curves: readonly NurbsCurveData[]): number => {
  const poles = curves.flatMap((curve) => curve.poles);
  const extent = [0, 1, 2].map(
    (axis) => Math.max(...poles.map((p) => p[axis] as number)) - Math.min(...poles.map((p) => p[axis] as number)),
  );
  return Math.max(Math.hypot(...extent), 1e-9);
};

/**
 * @affects creates 1 loft entity (exact faces + dense display rings) positioned at the first section's centre
 * @invariant faces reproduce the sections; the exact kernel sews and caps them (a closed loft is not capped)
 * @failure the coded SWG_LOFT_* / SRF_* refusals of the builder; unknown ids, coincident section centres -> no-op
 */
export function advancedLoft(
  doc: CadDocument,
  params: AdvancedParams,
  curves: readonly NurbsCurveData[],
  style: { layerId?: string | undefined; color: string; id?: string | undefined },
): CommandResult {
  const refuse = (issue: LoftIssue): CommandResult =>
    refuseSwg(
      doc,
      'loft_sections',
      issue.code,
      issue.message,
      [],
      [issue.section === undefined ? 'params' : `params.sections.${issue.section}`],
    );
  const start = parseEnd(doc, params.startCondition, 'startCondition');
  if (start !== undefined && 'code' in start) return refuse(start);
  const end = parseEnd(doc, params.endCondition, 'endCondition');
  if (end !== undefined && 'code' in end) return refuse(end);
  let centerline: NurbsCurveData | undefined;
  if (params.centerlineId !== undefined) {
    const found = anyWorldCurve(doc, params.centerlineId);
    if (typeof found === 'string') return refuse({ code: 'SWG_LOFT_CENTERLINE_MISSES', message: found });
    centerline = found;
  }
  let guides: NurbsCurveData[] | undefined;
  if (params.guideIds !== undefined) {
    guides = [];
    for (const id of params.guideIds) {
      const entity = doc.entities[id];
      if (entity?.kind !== 'nurbs_curve') return refuse({ code: 'SWG_PARAM_INVALID', message: `guide "${id}" is not a nurbs_curve` });
      guides.push(worldCurveOf(entity));
    }
  }
  const size = sizeOf(curves);
  const options: LoftOptions = {
    ruled: params.ruled === true,
    closed: params.closed === true,
    solid: true,
    alignment: params.seams !== undefined ? 'seams' : (params.alignment ?? 'auto'),
    seams: params.seams,
    coupling: params.coupling,
    vertexPairs: params.vertexPairs,
    start,
    end,
    centerline,
    sectionCount: params.sectionCount === undefined ? undefined : Math.round(params.sectionCount),
    guides,
    guideTolerance: params.guideTolerance ?? 1e-4 * size,
    fitTolerance: params.fitTolerance ?? 1e-6 * size,
    endAngleTolerance: params.endAngleRad ?? 0.01,
    faceTolerance: 1e-4 * size,
  };
  if (params.sectionCount !== undefined && !(params.sectionCount >= 1 && params.sectionCount <= 64))
    return refuse({ code: 'SWG_PARAM_INVALID', message: 'sectionCount must be an integer 1..64' });
  const built = buildLoft(curves, options);
  if ('code' in built) return refuse(built);
  const origin = wireCentroid(built.sections[0] as NurbsCurveData);
  const faces = built.faces.map((face) => mapSurfacePoles(face, (pole) => sub3(pole, origin)));
  const rings = displayRings(faces, built.sections.length, options.closed);
  const caps = (options.closed ? 0 : 2 - [start, end].filter((e) => e?.type === 'point').length) as 0 | 1 | 2;
  const id = idOrNext(style.id, 'loft');
  const entity = newEntity(
    'loft',
    id,
    { rings, ruled: true, faces, ...(options.closed ? { closed: true } : {}), ...(caps === 2 ? {} : { caps }) },
    origin,
    style.color,
    { layerId: existingLayerOrDefault(doc, style.layerId) },
  );
  const { report } = built;
  const data = {
    sections: built.sections.length,
    faces: report.faceCount,
    sectionDeviation: sig(report.sectionDeviation),
    startAngleRad: report.startAngleRad === null ? null : sig(report.startAngleRad),
    endAngleRad: report.endAngleRad === null ? null : sig(report.endAngleRad),
    seamTwistMaxRad: sig(report.seamTwistMaxRad),
    fitDeviation: sig(report.fitDeviation),
    guideDeviation: report.guideDeviation === null ? null : sig(report.guideDeviation),
    closureJumpRad: report.closureJumpRad === null ? null : sig(report.closureJumpRad),
    unit: doc.units,
  };
  const result = commitSolid(
    doc,
    entity,
    `loft_sections: created exact ${options.closed ? 'closed ' : ''}loft "${id}" through ${built.sections.length} sections as ${report.faceCount} NURBS face(s) (section deviation ${data.sectionDeviation} ${doc.units}${data.startAngleRad === null && data.endAngleRad === null ? '' : `, end angles ${data.startAngleRad ?? '-'} / ${data.endAngleRad ?? '-'} rad`}).`,
  );
  return { ...result, data };
}
