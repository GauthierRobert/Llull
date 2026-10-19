/** inspect_nurbs and analyze_curve_curvature: read-only queries of a nurbs_curve. */

import type { Vec3 } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { report } from '../noop';
import { curveDomain } from '../../lib/nurbs/evaluate';
import { curvatureAt, curveLength, planeNormalOf } from '../../lib/nurbs/curvature';
import { poleExtent } from '../../geometry/nurbsCurve';
import { distance3, scale3, sub3 } from '../../lib/vec3';
import { roundSignificant } from '../../lib/significant';
import { curveEntityOf, refuseSrf } from './shared';

const sig = (value: number): number => roundSignificant(value, 10);
const sigVec = (v: Vec3): Vec3 => [sig(v[0]), sig(v[1]), sig(v[2])];

/** Poles are listed in `inspect_nurbs` up to this count. */
const MAX_LISTED_POLES = 200;
const MAX_SAMPLES = 1_000;

/**
 * @affects none; data = { id, type, degree, poleCount, rational, domain, knots, multiplicities, weights?, poles?, interiorContinuity, closed, length, bounds, unit, unverified, provenance }
 * @failure unknown id -> SRF_ENTITY_NOT_FOUND; not a nurbs_curve -> SRF_NOT_NURBS
 */
export const inspectNurbs = defineCommand({
  name: 'inspect_nurbs',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Read-only: report the exact NURBS definition of a nurbs_curve: degree, pole count, rational or not, knots with multiplicities, parameter ' +
    'domain, weights, the poles (when at most 200), the continuity class at each interior knot (C0 = corner, C1, C2 ...), whether it is ' +
    'closed, its arc length and the pole bounding box (all lengths in document units). Use it to check what create_nurbs_curve, ' +
    'interpolate_curve or create_conic produced, or before edit_nurbs.',
  params: z.object({ id: z.string().describe('Id of a nurbs_curve entity.') }),
  run: (doc, { id }): CommandResult => {
    const entity = curveEntityOf(doc, 'inspect_nurbs', id);
    if (!('curve' in entity)) return entity;
    const { curve } = entity;
    const [first, last] = curveDomain(curve);
    const length = curveLength(curve, first, last);
    const extent = poleExtent(curve);
    const interior = curve.knots.slice(1, -1).map((knot, index) => {
      const multiplicity = curve.multiplicities[index + 1] as number;
      return { knot, multiplicity, continuity: `C${curve.degree - multiplicity}` };
    });
    const closed = distance3(curve.poles[0] as Vec3, curve.poles[curve.poles.length - 1] as Vec3) <= 1e-9 * Math.max(length, 1e-300);
    const data = {
      id,
      type: 'nurbs_curve',
      degree: curve.degree,
      poleCount: curve.poles.length,
      rational: curve.weights !== undefined,
      domain: [first, last],
      knots: curve.knots,
      multiplicities: curve.multiplicities,
      ...(curve.weights === undefined ? {} : { weights: curve.weights }),
      ...(curve.poles.length <= MAX_LISTED_POLES ? { poles: curve.poles } : {}),
      interiorContinuity: interior,
      closed,
      length: sig(length),
      bounds: { min: sigVec(extent.min), max: sigVec(extent.max), frame: 'entity-local (add the entity position)' },
      unit: doc.units,
      unverified: false,
      provenance: { method: 'exact definition read from the entity', reference: 'Piegl & Tiller, The NURBS Book', inputs: { id } },
    };
    return report(
      doc,
      `inspect_nurbs ${id}: degree ${curve.degree}, ${curve.poles.length} poles, ${curve.weights === undefined ? 'non-rational' : 'rational'}, ` +
        `${curve.knots.length} distinct knots, ${closed ? 'closed' : 'open'}, length ${sig(length)} ${doc.units}.`,
      data,
    );
  },
});

/**
 * @affects none; data = { id, samples [{ t, s, point, tangent, curvature, radius, signedCurvature?, dCurvatureDs, torsion, comb, degenerate }], summary stats, unit, provenance }
 * @invariant curvature = |C' x C''| / |C'|^3 >= 0; planar curves also get the signed curvature (+ about planeNormal) and an exact dkappa/ds
 * @failure unknown id -> SRF_ENTITY_NOT_FOUND; not a nurbs_curve -> SRF_NOT_NURBS; samples outside 2..1000 or a parameter outside the domain -> SRF_PARAM_INVALID
 */
export const analyzeCurveCurvature = defineCommand({
  name: 'analyze_curve_curvature',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Read-only curvature analysis of a nurbs_curve: at `samples` equally spaced parameters (default 21, 2..1000) or at explicit `parameters`, ' +
    'return the point (entity-local), unit tangent, curvature (1/document unit), radius of curvature, rate of change of curvature d(curvature)/ds, ' +
    'torsion, arc length from the start and the curvature-comb tip (`comb` = point - normal * curvature * combScale, pointing away from the ' +
    'centre of curvature). Planar curves also report the signed curvature (positive counter-clockwise about planeNormal) and the number of ' +
    'inflections. Summary: min / max curvature, max |d(curvature)/ds|, curve length. Samples where the speed is zero are flagged `degenerate`.',
  params: z.object({
    id: z.string().describe('Id of a nurbs_curve entity.'),
    samples: z
      .number()
      .describe('Number of equally spaced sample parameters, integer 2..1000. Default 21. Ignored when `parameters` is given.')
      .optional(),
    parameters: z
      .array(z.number())
      .describe('Explicit curve parameters to sample (each inside the knot domain, see inspect_nurbs `domain`), at most 1000.')
      .optional(),
    combScale: z.number().describe('Length of a comb tooth per unit curvature, in document units. Default 1.').optional(),
  }),
  run: (doc, { id, samples = 21, parameters, combScale = 1 }): CommandResult => {
    const entity = curveEntityOf(doc, 'analyze_curve_curvature', id);
    if (!('curve' in entity)) return entity;
    const { curve } = entity;
    const [first, last] = curveDomain(curve);
    const invalid = (message: string, path: string): CommandResult =>
      refuseSrf(doc, 'analyze_curve_curvature', 'SRF_PARAM_INVALID', message, [id], [`params.${path}`]);
    if (parameters === undefined && !(Number.isInteger(samples) && samples >= 2 && samples <= MAX_SAMPLES))
      return invalid(`samples must be an integer in 2..${MAX_SAMPLES} (got ${samples})`, 'samples');
    if (
      parameters !== undefined &&
      (parameters.length === 0 || parameters.length > MAX_SAMPLES || parameters.some((u) => !(u >= first && u <= last)))
    )
      return invalid(`parameters needs 1..${MAX_SAMPLES} values inside the domain [${first}, ${last}]`, 'parameters');
    const us = parameters ?? Array.from({ length: samples }, (_, i) => first + ((last - first) * i) / (samples - 1));
    const normal = planeNormalOf(curve);
    let previousU = us[0] as number;
    let arc = curveLength(curve, first, previousU);
    const rows = us.map((u) => {
      arc += u >= previousU ? curveLength(curve, previousU, u) : -curveLength(curve, u, previousU);
      previousU = u;
      const c = curvatureAt(curve, u, normal);
      return {
        t: sig(u),
        s: sig(arc),
        point: sigVec(c.point),
        tangent: sigVec(c.tangent),
        curvature: sig(c.curvature),
        radius: c.curvature > 0 ? sig(1 / c.curvature) : null,
        ...(c.signedCurvature === null ? {} : { signedCurvature: sig(c.signedCurvature) }),
        dCurvatureDs: sig(c.dCurvatureDs),
        torsion: sig(c.torsion),
        comb: sigVec(sub3(c.point, scale3(c.normal, c.curvature * combScale))),
        degenerate: c.degenerate,
      };
    });
    const live = rows.filter((row) => !row.degenerate);
    const curvatures = live.map((row) => row.curvature);
    const inflections =
      normal === null
        ? undefined
        : live.filter((row, i) => i > 0 && Math.sign(row.signedCurvature ?? 0) * Math.sign(live[i - 1]?.signedCurvature ?? 0) < 0).length;
    const length = curveLength(curve, first, last);
    const maxCurvature = curvatures.length === 0 ? 0 : Math.max(...curvatures);
    const data = {
      id,
      planar: normal !== null,
      ...(normal === null ? {} : { planeNormal: sigVec(normal) }),
      samples: rows,
      minCurvature: curvatures.length === 0 ? 0 : Math.min(...curvatures),
      maxCurvature,
      maxAbsDCurvatureDs: live.length === 0 ? 0 : Math.max(...live.map((row) => Math.abs(row.dCurvatureDs))),
      ...(inflections === undefined ? {} : { inflections }),
      degenerateSamples: rows.length - live.length,
      length: sig(length),
      unit: doc.units,
      curvatureUnit: `1/${doc.units}`,
      unverified: false,
      provenance: {
        method: "kappa = |C' x C''| / |C'|^3 from rational B-spline derivatives (quotient rule)",
        reference: 'Piegl & Tiller, The NURBS Book, A4.2; Farin, Curves and Surfaces for CAGD',
        inputs: { id, samples: rows.length },
      },
    };
    return report(
      doc,
      `analyze_curve_curvature ${id}: ${rows.length} samples, curvature ${data.minCurvature}..${data.maxCurvature} 1/${doc.units}, ` +
        `max |dk/ds| ${sig(data.maxAbsDCurvatureDs)}, length ${sig(length)} ${doc.units}${inflections === undefined ? '' : `, ${inflections} inflection(s)`}.`,
      data,
    );
  },
});
