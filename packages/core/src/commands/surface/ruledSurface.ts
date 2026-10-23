/** ruled_surface: the sheet of straight lines joining two curves (parameter, arc-length or developable pairing), or a curve and a point. */

import type { CommandResult } from '../types';
import { defineCommand, looseVec3, z } from '../schema';
import { isVec3 } from '../../lib/vec3';
import { reverseCurve } from '../../lib/nurbs/edit';
import { developableSurface } from '../../lib/nurbs/developable';
import { arcLengthPair, maxAbsGaussian, ruledPatch, rulingTwistMax, sheetDiagonal, surfaceArea } from '../../lib/nurbs/ruled';
import type { NurbsCurveData } from '../../lib/nurbs/types';
import type { NurbsSurfaceData } from '../../lib/nurbs/surfaceTypes';
import { sizeOfCurves, worldCurves } from './curveInputs';
import { commitSurface, isRefusal, sig, surfaceStyleFields } from './surfaceShared';
import { refuseSwg } from './swgRefusal';

/** Dimensionless Gaussian curvature K L^2 (L = sheet diagonal) below which a ruled surface counts as developable: independent of the document units. */
const DEVELOPABLE_KL2 = 1e-6;

/** The surface between `a` and `b` for a pairing, or a coded refusal fields. */
function buildRuled(
  a: NurbsCurveData,
  b: NurbsCurveData,
  coupling: 'parameter' | 'arc_length' | 'developable',
  fitTolerance: number,
): { surface: NurbsSurfaceData; fitDeviation: number | null } | { code: string; message: string } {
  if (coupling === 'arc_length') {
    const pair = arcLengthPair(a, b, fitTolerance);
    if ('code' in pair) return pair;
    const surface = ruledPatch(pair.a, pair.b);
    return typeof surface === 'string' ? { code: 'SWG_RULED_CURVES', message: surface } : { surface, fitDeviation: pair.deviation };
  }
  if (coupling === 'developable') {
    const made = developableSurface(a, b);
    return 'code' in made ? made : { surface: made.surface, fitDeviation: made.exact ? 0 : null };
  }
  const surface = ruledPatch(a, b);
  return typeof surface === 'string' ? { code: 'SWG_RULED_CURVES', message: surface } : { surface, fitDeviation: 0 };
}

/**
 * @affects creates 1 nurbs_surface (world coordinates) of degree 1 across, one isoline per input curve
 * @invariant data = { area, maxAbsGaussianCurvature, scaledGaussianCurvature, developable, rulingTwistMaxRad, coupling, fitDeviation }; the curves are reproduced exactly (parameter / developable pairing of equal-basis curves)
 * @failure not exactly two curves (or curve + point), unknown id -> SWG_RULED_CURVES / SRF_ENTITY_NOT_FOUND; no developable ruling -> SWG_NOT_DEVELOPABLE; arc-length refit out of tolerance -> SWG_FIT_TOLERANCE
 */
export const ruledSurface = defineCommand({
  name: 'ruled_surface',
  description:
    'Ruled sheet: straight lines joining two curves (nurbs_curve ids; hypar from two skew lines, frustum sheet from two circles, hull strakes) or a curve and a point (a cone). ' +
    'u runs along the curves, v from the first curve (0) to the second (1). `coupling` decides which points are joined: ' +
    'parameter (default; curves are made compatible, exact), arc_length (equal fractions of arc length, curves refitted within fitTolerance), ' +
    'developable (rulings whose tangent planes coincide so the sheet can be unrolled flat: Gaussian curvature 0; exact for coaxial circles of equal basis, else paired by Newton and refitted). ' +
    '`reverse` flips the second curve. Returns data { area (units squared), maxAbsGaussianCurvature (1/units squared), scaledGaussianCurvature (K x diagonal^2, dimensionless), developable (boolean: scaled K <= 1e-6, unit independent), rulingTwistMaxRad, coupling, fitDeviation }. ' +
    'Next: measure_area, analyze_surface_curvature, thicken_surface, check_sweep_loft.',
  params: z.object({
    curveIds: z.array(z.string()).describe('Exactly two nurbs_curve ids to join. Alternative to curveId + point.').optional(),
    curveId: z.string().describe('One nurbs_curve id, joined to `point` (a cone over the curve).').optional(),
    point: looseVec3('World [x, y, z] apex for curveId (a cone).').optional(),
    coupling: z
      .enum(['parameter', 'arc_length', 'developable'])
      .describe(
        'Pairing of the two curves: parameter (default), arc_length (equal arc-length fractions) or developable (rulings with a common tangent plane; refused with SWG_NOT_DEVELOPABLE if none exists).',
      )
      .optional(),
    reverse: z.boolean().describe('Run the second curve backwards before pairing (default false).').optional(),
    fitTolerance: z
      .number()
      .describe('Largest allowed refit deviation in document units for arc_length pairing (> 0). Default 1e-6 x the size of the curves.')
      .optional(),
    ...surfaceStyleFields(),
  }),
  run: (doc, params): CommandResult => {
    const { curveIds, curveId, point, coupling = 'parameter', reverse = false } = params;
    const twoCurves = curveIds !== undefined && curveId === undefined && point === undefined && curveIds.length === 2;
    const cone = curveIds === undefined && curveId !== undefined && point !== undefined && isVec3(point);
    if (!twoCurves && !cone)
      return refuseSwg(
        doc,
        'ruled_surface',
        'SWG_RULED_CURVES',
        'give exactly two curveIds, or one curveId with a point',
        [],
        ['curveIds'],
      );
    const curves = worldCurves(doc, 'ruled_surface', twoCurves ? curveIds : [curveId as string], twoCurves ? 'curveIds' : 'curveId');
    if (isRefusal(curves)) return curves;
    const first = curves[0] as NurbsCurveData;
    const second = twoCurves
      ? (curves[1] as NurbsCurveData)
      : { ...first, poles: first.poles.map(() => point as NonNullable<typeof point>) };
    const other = reverse ? reverseCurve(second) : second;
    const fitTolerance = params.fitTolerance ?? 1e-6 * sizeOfCurves([first, other]);
    if (!(fitTolerance > 0)) return refuseSwg(doc, 'ruled_surface', 'SWG_PARAM_INVALID', 'fitTolerance must be > 0', [], ['fitTolerance']);
    const built = buildRuled(first, other, coupling, fitTolerance);
    if ('code' in built) return refuseSwg(doc, 'ruled_surface', built.code, built.message, [], ['coupling']);
    const { surface, fitDeviation } = built;
    const area = surfaceArea(surface);
    const maxK = maxAbsGaussian(surface);
    const scaledK = maxK * sheetDiagonal(surface) ** 2;
    const twist = rulingTwistMax(surface);
    const data = {
      area: sig(area),
      maxAbsGaussianCurvature: sig(maxK),
      scaledGaussianCurvature: sig(scaledK),
      developable: scaledK <= DEVELOPABLE_KL2,
      rulingTwistMaxRad: sig(twist),
      coupling,
      fitDeviation: fitDeviation === null ? null : sig(fitDeviation),
      unit: doc.units,
    };
    const result = commitSurface(
      doc,
      surface,
      { ...params, position: [0, 0, 0] },
      (id) =>
        `ruled_surface: created ${coupling} ruled sheet "${id}" (area ${data.area} ${doc.units}^2, max |K| ${data.maxAbsGaussianCurvature}, ${data.developable ? 'developable' : 'not developable'}).`,
    );
    return { ...result, data };
  },
});
