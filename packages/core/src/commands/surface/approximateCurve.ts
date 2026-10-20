/** approximate_curve: the lightest NURBS curve that stays within a tolerance of measured points. */

import type { CommandResult } from '../types';
import { defineCommand, vec3, z } from '../schema';
import { approximatePoints } from '../../lib/nurbs/approximate';
import { MAX_NURBS_DEGREE } from '../../lib/nurbs/types';
import { distance3 } from '../../lib/vec3';
import { MAX_CURVE_POINTS, commitCurve, curveStyleFields, refuseSrf } from './shared';
import { sig } from './surfaceShared';

/**
 * @affects creates 1 nurbs_curve entity (least-squares B-spline, end points interpolated)
 * @invariant the maximum point-to-curve distance (reported as `maxDeviation`) is <= tolerance
 * @failure fewer than degreeMin + 1 points, coincident points, bad degrees or tolerance -> SRF_PARAM_INVALID / SRF_POINTS_INSUFFICIENT;
 *   tolerance not reachable with the pole budget -> SRF_TOLERANCE_UNREACHABLE
 */
export const approximateCurve = defineCommand({
  name: 'approximate_curve',
  description:
    'Create a 3D NURBS curve that approximates ordered points within `tolerance` using as few poles as possible (least squares; first and last ' +
    'point are interpolated, interior points are fitted). Use it for dense or noisy data (scans, digitised airfoils, 400-point ordinates) where ' +
    'interpolate_curve would give a pole per point and wiggles. Chord-length parameters; the pole count is searched upwards (per degree between ' +
    '`degreeMin` and `degreeMax`, the lowest degree wins ties) until the largest point-to-curve distance is within `tolerance`. Returns the curve ' +
    'id, pole count, degree, and the real max / rms deviation. Refuses (no curve) when `tolerance` cannot be reached with at most `maxPoles` poles. ' +
    'For an exact pass-through use interpolate_curve.',
  params: z.object({
    points: z.array(vec3('Ordered data point [x, y, z] in document units, relative to `position`.')).describe('3..10000 ordered points.'),
    tolerance: z.number().describe('Largest allowed distance from any point to the curve, document units (> 0).'),
    degreeMin: z.number().describe('Lowest degree tried, integer 1..25. Default 3.').optional(),
    degreeMax: z.number().describe('Highest degree tried, integer >= degreeMin and <= 25. Default equal to degreeMin.').optional(),
    maxPoles: z.number().describe('Pole budget, integer 3..10000. Default 10000 (never more than the point count).').optional(),
    ...curveStyleFields(),
  }),
  run: (doc, params): CommandResult => {
    const { points, tolerance, degreeMin = 3, degreeMax = degreeMin, maxPoles = MAX_CURVE_POINTS } = params;
    const refuse = (code: string, message: string, path: string): CommandResult =>
      refuseSrf(doc, 'approximate_curve', code, message, [], [`params.${path}`]);
    if (!(tolerance > 0) || !Number.isFinite(tolerance))
      return refuse('SRF_PARAM_INVALID', 'tolerance must be a finite number > 0', 'tolerance');
    const degreeOk = (value: number): boolean => Number.isInteger(value) && value >= 1 && value <= MAX_NURBS_DEGREE;
    if (!degreeOk(degreeMin)) return refuse('SRF_PARAM_INVALID', `degreeMin must be an integer in 1..${MAX_NURBS_DEGREE}`, 'degreeMin');
    if (!degreeOk(degreeMax) || degreeMax < degreeMin)
      return refuse('SRF_PARAM_INVALID', `degreeMax must be an integer in degreeMin..${MAX_NURBS_DEGREE}`, 'degreeMax');
    if (!(Number.isInteger(maxPoles) && maxPoles >= 3 && maxPoles <= MAX_CURVE_POINTS))
      return refuse('SRF_PARAM_INVALID', `maxPoles must be an integer in 3..${MAX_CURVE_POINTS}`, 'maxPoles');
    if (points.length > MAX_CURVE_POINTS) return refuse('SRF_POINTS_INSUFFICIENT', `at most ${MAX_CURVE_POINTS} points`, 'points');
    if (points.length < degreeMin + 1)
      return refuse(
        'SRF_POINTS_INSUFFICIENT',
        `degree ${degreeMin} needs at least ${degreeMin + 1} points (got ${points.length})`,
        'points',
      );
    const coincident = points.findIndex(
      (point, index) => index > 0 && distance3(point, points[index - 1] as (typeof points)[number]) === 0,
    );
    if (coincident > 0)
      return refuse('SRF_POINTS_COINCIDENT', `points ${coincident - 1} and ${coincident} coincide`, `points.${coincident}`);
    const fit = approximatePoints(points, { tolerance, degreeMin, degreeMax, maxPoles });
    if (fit === null)
      return refuse(
        'SRF_TOLERANCE_UNREACHABLE',
        `tolerance ${tolerance} is not reachable with at most ${maxPoles} poles of degree ${degreeMin}..${degreeMax}`,
        'tolerance',
      );
    const result = commitCurve(
      doc,
      fit.curve,
      params,
      (id) =>
        `approximate_curve: created degree-${fit.curve.degree} curve "${id}" with ${fit.curve.poles.length} poles for ${points.length} points ` +
        `(max deviation ${sig(fit.maxDeviation)}, rms ${sig(fit.rmsDeviation)}, tolerance ${tolerance}).`,
    );
    return {
      ...result,
      data: {
        id: result.affected[0],
        degree: fit.curve.degree,
        poleCount: fit.curve.poles.length,
        pointCount: points.length,
        maxDeviation: sig(fit.maxDeviation),
        rmsDeviation: sig(fit.rmsDeviation),
        tolerance,
        unit: doc.units,
      },
    };
  },
});
