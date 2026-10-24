/** create_curve_on_face — a geodesic, isoparametric or (u, v) curve lying on a face of a solid (03 WRP M4). */

import type { BaseEntity, NurbsCurveEntity } from '../../model/types';
import { nextId } from '../../lib/id';
import { withEntity } from '../entity/entityOps';
import { newEntity } from '../entity/newEntity';
import { defineCommand, looseVec2, looseVec3, z } from '../schema';
import type { CommandResult } from '../types';
import { wrapRejection } from './codes';
import { namedDefault, wrapData } from './conventions';
import { curveOnFaceDescription } from './curveOnFaceText';
import { geodesicCurve, isBuildFailure, isoCurve, uvCurve, type BuildFailure, type BuiltCurve } from './curveOnFaceBuild';
import { defaultFitTolerance, isRejection, openFace } from './faceSession';
import { faceRefField } from './schemas';

const MAX_UV_POINTS = 500;

/**
 * @affects creates one nurbs_curve with onFace (its pcurve: the chart frame for a geodesic, the kernel's own (u, v) otherwise)
 * @invariant geodesic on a plane, cylinder or cone is the straight line of the development (exact length); on a sphere a great-circle arc; on a torus the geodesic found by
 *   shooting nearest the straight (u, v) line (a geodesic, not necessarily the shortest); the 3D curve is a fit whose measured deviation is reported
 * @failure unknown id / not a solid / no or several faces / points off the face / no geodesic / curve leaving the face / freeform face with geodesic / missing mode parameters ->
 *   coded no-op
 */
export const createCurveOnFace = defineCommand({
  name: 'create_curve_on_face',
  description: curveOnFaceDescription,
  params: z.object({
    id: z.string().describe('Id of the solid whose face carries the curve.'),
    face: faceRefField,
    mode: z
      .enum(['geodesic', 'isoparametric', 'uv'])
      .describe(
        'geodesic: shortest-path curve between `from` and `to` (plane, cylinder, cone, sphere, torus faces). isoparametric: u or v constant through `through` (`direction` names the varying parameter), trimmed to the face. uv: cubic through the (u, v) points `uv` in the kernel parameters of the face.',
      ),
    from: looseVec3('geodesic: start point [x, y, z] on the face (world document units).').optional(),
    to: looseVec3('geodesic: end point [x, y, z] on the face (world document units).').optional(),
    through: looseVec3('isoparametric: a point [x, y, z] on the face the curve passes through.').optional(),
    direction: z
      .enum(['u', 'v'])
      .optional()
      .describe('isoparametric: which parameter varies along the curve: u (v stays constant) or v (u stays constant).'),
    uv: z
      .array(looseVec2('A point [u, v] in the face parameters (inspect_faces reports the ranges; the kernel numbering of the face).'))
      .min(2)
      .max(MAX_UV_POINTS)
      .optional()
      .describe('uv: at least two [u, v] points the curve passes through, in order.'),
    fitTolerance: z
      .number()
      .positive()
      .optional()
      .describe(
        'Largest deviation of the fitted 3D curve from its exact image, document units. Default: 1e-6 x the solid diagonal (named default).',
      ),
  }),
  annotations: { requiresKernel: true },
  run: (doc, params, ctx): CommandResult => {
    const session = openFace(doc, ctx, 'create_curve_on_face', params.id, params.face);
    if (isRejection(session)) return session;
    const missing = (field: string): CommandResult =>
      wrapRejection(
        doc,
        'create_curve_on_face',
        'WRP_PARAM_INVALID',
        `mode ${params.mode} needs ${field}`,
        [params.id],
        [field.split(' ')[0] as string],
      );
    const tolerance = params.fitTolerance ?? defaultFitTolerance(session.diagonal);
    let built: BuiltCurve | BuildFailure;
    if (params.mode === 'geodesic') {
      if (params.from === undefined || params.to === undefined) return missing('from and to');
      built = geodesicCurve(session, params.from, params.to, tolerance);
    } else if (params.mode === 'isoparametric') {
      if (params.through === undefined || params.direction === undefined) return missing('through and direction');
      built = isoCurve(session, params.through, params.direction, tolerance);
    } else {
      if (params.uv === undefined) return missing('uv');
      built = uvCurve(session, params.uv, tolerance);
    }
    if (isBuildFailure(built)) return wrapRejection(doc, 'create_curve_on_face', built.code, built.message, [params.id], [built.path]);
    const id = nextId('curve');
    const entity = newEntity(
      'nurbs_curve',
      id,
      {
        curve: built.curve,
        onFace: {
          entityId: params.id,
          faceIndex: session.face,
          ...(session.faceName !== undefined ? { faceName: session.faceName } : {}),
          pcurve: built.pcurve,
          ...(built.frame === 'native' ? { frame: 'native' as const } : {}),
          fitTolerance: built.fitTolerance,
          chartLength: built.chartLength,
        },
      } satisfies Omit<NurbsCurveEntity, keyof BaseEntity>,
      [0, 0, 0],
      session.entity.color,
      { layerId: session.entity.layerId },
    );
    const data = wrapData(
      doc,
      {
        curve: {
          id,
          mode: params.mode,
          length3d: built.length3d,
          chartLength: built.chartLength,
          fitTolerance: built.fitTolerance,
          exact: built.exact,
        },
        faceKind: session.surface.type,
        face: session.face,
        ...(session.faceName !== undefined ? { faceName: session.faceName } : {}),
      },
      {
        unverified: false,
        provenance: { method: built.method, inputs: { id: params.id, face: session.face, mode: params.mode } },
        defaults:
          params.fitTolerance === undefined
            ? [namedDefault('fitTolerance', tolerance, doc.units, 'llull WRP default (D-WRP-4): 1e-6 x the solid diagonal')]
            : [],
      },
    );
    return {
      document: withEntity(doc, entity),
      affected: [id],
      summary: `create_curve_on_face: ${params.mode} curve '${id}' on ${session.surface.type} face ${session.face} of '${params.id}', length ${built.length3d.toPrecision(9)} ${doc.units} (fit deviation ${built.fitTolerance.toExponential(2)} ${doc.units}).${session.note}`,
      data,
      ...(session.faceName !== undefined ? { recordExtras: { face: { faceName: session.faceName } } } : {}),
    };
  },
});
