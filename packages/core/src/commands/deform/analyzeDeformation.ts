/** analyze_deformation — read-only report of how a deformation moved a body: law, frame, Jacobian, volume check, creases, fibres (01 DEF M1, FR-DEF-21, AF-21). */

import type { CadDocument } from '../../model/types';
import { maxDeviation, referenceDistance, REFERENCE_FIELDS } from '../../geometry/deform/referenceShape';
import { defineCommand, z } from '../schema';
import { currentContext } from '../context';
import { report } from '../noop';
import type { CommandResult } from '../types';
import { analyzeDeformed } from './analysis';
import { defRejection } from './codes';
import { deformNodeOf } from './sourceMesh';
import { compareToParam, idParam } from './schema';

const FORMULAS: Readonly<Record<string, string>> = {
  affine: "q' = M q + t (frame coordinates); det J = det M",
  twist: 'theta = Theta w(z); (x, y) rotated by theta, z kept; det J = 1',
  taper: "s = 1 + (S - 1) w(z); x' = s x, y' = s y (flat: y kept); det J = s^2 (s when flat)",
  stretch: "z' = start + f (z - start) inside the region, z + (f - 1) (end - start) past it; det J = f inside, 1 outside",
  lattice:
    'X(s, t, u) = sum B_i(s) B_j(t) B_k(u) P_ijk with P_ijk the lattice point displaced by its offset, B Bernstein or (splineDegrees) uniform clamped B-spline functions, (s, t, u) the normalised box coordinates (c = A q for an oriented box); identity outside the box',
  point:
    'p + distance dir phi(|p - c| / r), phi = (1 - s^2)^3 (smooth_c2) or 1 - 3 s^2 + 2 s^3 (cubic); det J = 1 + distance dir . grad phi',
  flowCurve:
    'P(s) + x N(s) + y B(s), s = ratio (z - z0), (P, N, B) a frame along the target curve sampled at uniform arc length; det J = ratio (1 - kappa_N x - kappa_B y)',
  flowSurface:
    'S(a*, b*) + w N(a*, b*) with x, y arc lengths on the target from the target origin and w the offset along the normal; table of P, N, bicubic Catmull-Rom',
  rbf: 'p + a0 + A p + sum w_i |p - c_i|^3 through the displacements of the curve samples (triharmonic spline)',
  bend: "theta = (z - start) / R; y' = R - (R - y) cos theta; z' = start + (R - y) sin theta; det J = (R - y) / R, rigid past the end",
};

/** Formulas of an `infinite` region: the law holds on the whole axis (no clamp, nothing rigid). */
const INFINITE_FORMULAS: Readonly<Record<string, string>> = {
  twist: 'theta = Theta t, t = (z - start) / (end - start) not clamped; (x, y) rotated by theta, z kept; det J = 1',
  taper: "s = 1 + (S - 1) t, t not clamped; x' = s x, y' = s y (flat: y kept); det J = s^2 (s when flat)",
  stretch: "z' = start + f (z - start) at every z; det J = f everywhere",
  bend: "theta = (z - start) / R at every z; y' = R - (R - y) cos theta; z' = start + (R - y) sin theta; det J = (R - y) / R everywhere, nothing rigid",
};

/**
 * @affects none (read-only); data = law, frame, region, path, jacobian, volume check, maxDisplacement, approximation, regionCrease, fibres, unverified, provenance
 * @invariant everything is computed on read from the recipe's outermost deform node, nothing is stored; fields only the exact kernel knows are null
 * @failure unknown id -> DEF_ENTITY_NOT_FOUND; no deform node -> DEF_NOT_DEFORMED; source not rebuildable -> DEF_SOURCE_UNAVAILABLE
 */
export const analyzeDeformation = defineCommand({
  name: 'analyze_deformation',
  annotations: { readsMeshTriangles: true, readOnly: true },
  description:
    'Report how a deformation command (twist_body, taper_body, stretch_body, bend_body, scale_nonuniform) moved a body, as numbers instead of a visual judgement. ' +
    'data: law (kind and parameters, angles in radians), frame (origin, axis, reference), region, path ("exact" or "mesh"), jacobian {min, max, minAt, bound} ' +
    '(det J of the map: 1 = volume kept, <= 0 = folded; bound is the closed form over the whole body), volume {source, predicted, driftRel and the result volume} ' +
    '(predicted = integral of det J over the source, independent of the result surface; the result volume is read from the kernel or the mesh; document units^3), maxDisplacement ' +
    '(document units), approximation {maxError, tolerance, facesConverted, facesSplit} (on the exact path the largest deviation of the fitted B-spline faces from the deformed source, SAMPLED at the fit grid and at cell middles, not a proven bound; on the mesh path the largest chordal deviation; document units), topology {before, after} (exact path: faces / edges / vertices of the source and of the result), regionCrease (per region end, the angle ' +
    'in radians between the faces inside and outside a linear ramp; 0 for a smooth ramp), fibres {neutral, inner, outer} (bend: fibre lengths in document units), ' +
    'unverified (an input mesh has no pinned source hash) and provenance; compareTo (optional analytic reference torus / cylinder / cone / spheroid) adds data.compareTo.maxDeviation. Read-only. Refuses an entity that was not deformed (DEF_NOT_DEFORMED).',
  params: z.object({
    id: idParam.describe('Id of the deformed mesh entity to analyse (the id a deformation command returned in affected).'),
    compareTo: compareToParam.optional(),
  }),
  run: (doc: CadDocument, { id, compareTo }, ctx): CommandResult => {
    const entity = doc.entities[id];
    if (entity === undefined)
      return defRejection(doc, 'analyze_deformation', 'DEF_ENTITY_NOT_FOUND', `entity '${id}' not found`, [id], ['params.id']);
    const node = deformNodeOf(entity);
    if (node === null)
      return defRejection(
        doc,
        'analyze_deformation',
        'DEF_NOT_DEFORMED',
        `entity '${id}' (kind '${entity.kind}') has no deform node in its recipe`,
        [id],
        ['params.id'],
      );
    const kernel = (ctx ?? currentContext()).kernel;
    const analysis = analyzeDeformed(doc, entity, node, kernel);
    if ('code' in analysis) return defRejection(doc, 'analyze_deformation', analysis.code, analysis.message, [id], ['params.id']);
    const { law } = node;
    let comparison: Record<string, unknown> | undefined;
    if (compareTo !== undefined) {
      const distance = referenceDistance(compareTo);
      if ('missing' in distance)
        return defRejection(
          doc,
          'analyze_deformation',
          'DEF_COMPARE_INVALID',
          `compareTo.${distance.missing} is missing or invalid for kind '${compareTo.kind}' (needs ${REFERENCE_FIELDS[compareTo.kind].join(', ')})`,
          [id],
          [`params.compareTo.${distance.missing}`],
        );
      const found = entity.kind === 'mesh' ? maxDeviation(distance, entity.mesh.positions) : { max: NaN, samples: 0 };
      comparison = { kind: compareTo.kind, maxDeviation: found.max, samples: found.samples, unit: doc.units };
    }
    const data = {
      id,
      law: { kind: law.kind, params: law },
      frame: { origin: node.frame.origin, axis: node.frame.axis, reference: node.frame.reference },
      ...(node.region === undefined ? {} : { region: node.region }),
      path: analysis.path,
      unit: doc.units,
      angleUnit: 'rad',
      jacobian: {
        min: analysis.sampled.min,
        max: analysis.sampled.max,
        minAt: analysis.sampled.minAt,
        samples: analysis.sampled.count,
        bound: analysis.range.bound ?? { min: analysis.range.min, max: analysis.range.max, method: 'closed form over the body extent' },
      },
      volume: { ...analysis.volume, unit: `${doc.units}^3`, driftRel: analysis.volume.driftRel },
      maxDisplacement: analysis.maxDisplacement,
      approximation:
        analysis.approximationError === null
          ? null
          : {
              maxError: analysis.approximationError,
              tolerance: { name: 'output.tolerance', value: node.output.tolerance, unit: doc.units },
              facesConverted: analysis.built?.faces ?? null,
              facesSplit: analysis.built?.splitFaces ?? null,
              ...(analysis.built === null ? {} : { minDeterminantOnSurface: analysis.built.minDeterminant, ring: analysis.built.ring }),
            },
      topology: analysis.topology,
      ...(comparison === undefined ? {} : { compareTo: comparison }),
      regionCrease: analysis.creases,
      fibres: analysis.fibres,
      unverified: analysis.unverified,
      provenance: {
        method: 'closed-form Jacobian; predicted volume = integral of det J over the source cross-sections',
        formula: (node.region?.infinite === true ? INFINITE_FORMULAS[law.kind] : undefined) ?? FORMULAS[law.kind] ?? law.kind,
        reference: 'Barr 1984, Global and local deformations of solid primitives, SIGGRAPH 18(3)',
        kernel: kernel?.name ?? null,
        inputs: { sourceTriangles: analysis.sourceTriangles },
      },
    };
    return report(
      doc,
      `analyze_deformation: '${id}' ${law.kind} (${analysis.path} path): det J ${analysis.sampled.min.toPrecision(6)}..${analysis.sampled.max.toPrecision(6)}, ` +
        `volume measured ${analysis.volume.measured.toPrecision(8)} vs predicted ${analysis.volume.predicted.toPrecision(8)} ${doc.units}^3 (drift ${analysis.volume.driftRel.toExponential(2)}), ` +
        `max displacement ${analysis.maxDisplacement.toPrecision(5)} ${doc.units}.${comparison === undefined ? '' : ` Deviation from the ${String(comparison['kind'])}: ${Number(comparison['maxDeviation']).toPrecision(4)} ${doc.units}.`}`,
      data,
    );
  },
});
