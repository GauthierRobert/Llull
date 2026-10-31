/** split_at_silhouette — divide the faces of a solid along its silhouette seen from a direction: the parting line of a mould (03 WRP M5, FR-WRP-12 silhouette split). */

import type { BaseEntity, CadDocument, NurbsCurveEntity } from '../../model/types';
import { len3 } from '../../lib/vec3';
import { nextId } from '../../lib/id';
import { withEntity } from '../entity/entityOps';
import { newEntity } from '../entity/newEntity';
import { defineCommand, vec3, z } from '../schema';
import type { CommandResult } from '../types';
import { wrapRejection } from './codes';
import { isRejection, openSolid } from './faceSession';
import { silhouettes } from './silhouette';
import { splitFaceByCurves } from './splitFaceByCurves';

/**
 * @affects creates one \`nurbs_curve\` (with \`onFace\`) per silhouette piece, then replaces the solid by the split result (a new mesh entity with the exact recipe) like split_face_by_curves; the curves stay
 * @invariant the silhouette is where the face normal is perpendicular to \`direction\`: closed form on cylinder (two generatrices), cone (two generatrices through the apex) and sphere (a great circle), none on
 *   a plane; the volume and the total face area do not change; a silhouette that already is an edge of the solid is not split again (data.silhouette.onEdge)
 * @failure zero direction, no exact kernel, a solid with no silhouette inside a face (a box seen along an axis), a freeform face with a cusp, branch point, pole, periodic B-spline or tangential view, a torus seen along its equatorial plane, a sphere or torus patch the contour leaves, the split refused by the kernel -> coded no-op
 */
export const splitAtSilhouette = defineCommand({
  name: 'split_at_silhouette',
  description:
    'Split the faces of a solid along its silhouette seen along `direction` (parallel view; the pull direction of a mould, so the cut is its parting line). The silhouette is where the face normal is ' +
    'perpendicular to the direction, found in closed form on the exact faces: a cylinder gives its two generatrices at +-(axis x direction), a cone the generatrices through its apex, a sphere the great circle ' +
    'perpendicular to the direction, a torus its two contour curves (n . d = 0 solved per meridian angle, fitted B-splines reported with their deviation), a freeform (B-spline) face its contour n . d = 0 traced on the exact surface (sign changes on a 48 x 48 grid of the face, refined by Newton, fitted B-spline reported with its deviation; closed or open, cut at a trimmed boundary); a plane has none (it is parallel to the direction or turned toward / away from it: data.silhouette.edgeOn lists the parallel ones, whose boundary is the parting line). ' +
    'Each piece is made a curve on its face (a nurbs_curve with onFace, kept in the document) and the faces are divided along them with split_face_by_curves (the divided faces get new persistent names). The curves are a record of the cut: ' +
    'they reference the solid as it was before the split. A face whose silhouette is not built (a freeform face with a cusp, a branch point, a pole or a tangential view; a torus seen along its equatorial plane, a sphere or torus patch the contour leaves) is left unsplit and named in the summary and in data.silhouette.unsupported: the parting line is then partial. A silhouette that already is an edge of the solid (a cylinder seen along a seam) is reported in data.silhouette.onEdge and not split again. ' +
    'Returns data { facesBefore, facesAfter, faces[], volumeBefore, volumeAfter, silhouette { direction, curves[{ id, face, kind, length }], edgeOn, onEdge, unsupported } }. Refuses with WRP_SILHOUETTE_NONE ' +
    '(nothing to split for this direction), WRP_SILHOUETTE_UNSUPPORTED (a freeform face with a cusp / branch point / pole / tangential view or a periodic B-spline, a torus seen along its equatorial plane, or a sphere / torus patch the contour leaves: the reason is named), WRP_PARAM_INVALID (zero direction) and the ' +
    'split_face_by_curves codes. Needs the exact (native) kernel. Next: inspect_faces, draft_faces, emboss_on_face.',
  params: z.object({
    id: z.string().describe('Id of the solid to divide.'),
    direction: vec3(
      'Viewing / pull direction [x, y, z] (world, not necessarily unit; its sign does not matter). The solid is cut along its outline seen along this direction.',
    ),
    tolerance: z
      .number()
      .positive()
      .optional()
      .describe('Fit tolerance of the split, document units. Default: 1e-5 x the solid diagonal (named default of split_face_by_curves).'),
  }),
  annotations: { readsMeshTriangles: true, requiresKernel: true },
  run: (doc, params, ctx): CommandResult => {
    const fail = (code: string, message: string, paths: string[] = ['direction']): CommandResult =>
      wrapRejection(doc, 'split_at_silhouette', code, message, [params.id], paths);
    if (!(len3(params.direction) > 1e-12)) return fail('WRP_PARAM_INVALID', 'direction must be a non-zero vector');
    const session = openSolid(doc, ctx, 'split_at_silhouette', params.id);
    if (isRejection(session)) return session;
    const report = silhouettes(session, params.direction, (params.tolerance ?? 1e-5 * session.diagonal) / 10);
    const block = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      direction: params.direction,
      edgeOn: report.edgeOn,
      onEdge: report.onEdge,
      unsupported: report.unsupported,
      ...extra,
    });
    if (report.curves.length === 0) {
      const unsupported = report.unsupported[0];
      const refused =
        unsupported !== undefined
          ? fail('WRP_SILHOUETTE_UNSUPPORTED', `face ${unsupported.face} (${unsupported.surface}): ${unsupported.reason}`, ['id'])
          : fail(
              'WRP_SILHOUETTE_NONE',
              `'${params.id}' has no silhouette inside a face for this direction (${report.onEdge.length} on an edge already, ${report.edgeOn.length} faces parallel to it)`,
            );
      return { ...refused, data: { silhouette: block() } };
    }
    let working: CadDocument = doc;
    const ids: string[] = [];
    const pieces: Array<{ id: string; face: number; kind: string; length: number; deviation: number }> = [];
    for (const piece of report.curves) {
      const id = nextId('curve');
      const faceName = session.topology?.faces[piece.face]?.name;
      working = withEntity(
        working,
        newEntity(
          'nurbs_curve',
          id,
          {
            curve: piece.curve,
            onFace: {
              entityId: params.id,
              faceIndex: piece.face,
              ...(faceName !== undefined ? { faceName } : {}),
              pcurve: piece.pcurve,
              frame: 'native' as const,
              fitTolerance: piece.deviation,
              chartLength: piece.length,
            },
          } satisfies Omit<NurbsCurveEntity, keyof BaseEntity>,
          [0, 0, 0],
          session.entity.color,
          { layerId: session.entity.layerId },
        ),
      );
      ids.push(id);
      pieces.push({ id, face: piece.face, kind: piece.kind, length: piece.length, deviation: piece.deviation });
    }
    const split = splitFaceByCurves.run(
      working,
      { id: params.id, curveIds: ids, ...(params.tolerance === undefined ? {} : { tolerance: params.tolerance }) },
      ctx,
    );
    if (split.rejected === true) return { ...split, document: doc, affected: [], summary: `split_at_silhouette: ${split.summary}` };
    return {
      ...split,
      affected: [...split.affected, ...ids],
      summary: `split_at_silhouette: silhouette of '${params.id}' along [${params.direction.join(', ')}] = ${pieces.length} curve(s) (${pieces.map((p) => `${p.kind} on face ${p.face}`).join(', ')}); ${split.summary}${report.unsupported.length === 0 ? '' : ` PARTIAL parting line: not split ${report.unsupported.map((u) => `face ${u.face} (${u.surface}: ${u.reason})`).join('; ')}.`}`,
      data: { ...(split.data ?? {}), silhouette: block({ curves: pieces }) },
    };
  },
});
