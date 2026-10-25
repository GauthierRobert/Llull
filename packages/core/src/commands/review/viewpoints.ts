/** Saved viewpoints (plant 09 VIS §4, BCF viewpoint camera): save, list, delete. metaHistory: they never add a feature step. */

import type { ReviewComment, ViewpointCamera, Viewpoint } from '../../model/review';
import type { Vec3 } from '../../model/types';
import { VIEWPORT_FOV_DEGREES } from '../../model/viewport';
import { documentCameraViewpoint, normalizeViewpointCamera } from '../../geometry/viewpointCamera';
import { canonicalJson } from '../../lib/canonicalJson';
import { nameUuid } from '../../lib/nameUuid';
import type { CommandResult } from '../types';
import { defineCommand, vec3, z } from '../schema';
import { changed, report } from '../noop';
import { mintReviewId, reviewOf, reviewRejection } from './reviewModel';
import { viewpointStateFields, viewpointStateParams, viewpointStateRejection } from './viewpointRefs';

export const viewpointCameraParam = z
  .object({
    projection: z.enum(['perspective', 'orthographic']).describe('"perspective" (needs fovDeg) or "orthographic" (needs viewHeight).'),
    eye: vec3('Camera position [x, y, z] in document units (Z-up).'),
    direction: vec3('View direction [x, y, z] (any non-zero length; normalised on save).'),
    up: vec3('Up vector [x, y, z]; made orthogonal to direction on save. Default [0, 0, 1].').optional(),
    fovDeg: z.number().optional().describe('Perspective: vertical field of view in degrees, (0, 180). Default 45 (the viewport).'),
    viewHeight: z.number().optional().describe('Orthographic: visible height of the view in document units, > 0.'),
  })
  .describe('Camera of the viewpoint (BCF PerspectiveCamera / OrthogonalCamera).');

export type CameraParam = z.infer<typeof viewpointCameraParam>;

/** The zod camera param as a model camera (a missing viewHeight becomes NaN, which normalisation refuses). */
export function cameraFromParam(param: CameraParam): ViewpointCamera {
  const { eye, direction } = param;
  const up: Vec3 = param.up ?? [0, 0, 1];
  return param.projection === 'perspective'
    ? { projection: 'perspective', eye, direction, up, fovDeg: param.fovDeg ?? VIEWPORT_FOV_DEGREES }
    : { projection: 'orthographic', eye, direction, up, viewHeight: param.viewHeight ?? Number.NaN };
}

/**
 * @affects adds 1 viewpoint to doc.review (affected: [viewpointId], id `vp-<n>`); metaHistory
 * @invariant stored direction / up are unit and orthogonal; guid is a name UUID of the id and the stored camera
 * @failure invalid camera -> VIS_CAMERA_INVALID; unknown section box / profile / entity -> VIS_SECTION_BOX_NOT_FOUND / VIS_PROFILE_NOT_FOUND / VIS_ENTITY_NOT_FOUND
 */
export const saveViewpoint = defineCommand({
  name: 'save_viewpoint',
  description:
    'Save a named review viewpoint (a BCF viewpoint camera, for review issues, walkthroughs and render_view; for a drawing view that also shows chosen PMI items or a section use create_saved_view instead) in the document: give `camera` (perspective eye / direction / up / fovDeg or ' +
    'orthographic eye / direction / up / viewHeight), or omit it to save the current document camera (set_camera / fit_view, 45° perspective). ' +
    'Direction and up are normalised and made orthogonal. Returns the id (vp-<n>) in affected[0] and data { id, guid, camera }. Viewpoints ' +
    'feed render_view (viewpointId), create_walkthrough and export_bcf. Optional sectionBoxId (set_section_box), colourProfileId, visibility and selection are saved with it and ' +
    'restored by apply_viewpoint. Does not add a feature step. Errors: VIS_CAMERA_INVALID, VIS_SECTION_BOX_NOT_FOUND, VIS_PROFILE_NOT_FOUND, VIS_ENTITY_NOT_FOUND.',
  annotations: { metaHistory: true },
  params: z.object({
    name: z.string().describe('Viewpoint name, e.g. "Pump skid from the walkway".'),
    camera: viewpointCameraParam.optional(),
    fromDocumentCamera: z
      .boolean()
      .optional()
      .describe('true: save the current document camera (the same as omitting camera). Not together with camera.'),
    ...viewpointStateParams,
  }),
  run: (doc, { name, camera, fromDocumentCamera, ...state }): CommandResult => {
    if (camera !== undefined && fromDocumentCamera === true)
      return reviewRejection(doc, 'save_viewpoint', 'VIS_CAMERA_INVALID', 'give camera or fromDocumentCamera, not both', [], ['camera']);
    const normalised = normalizeViewpointCamera(camera === undefined ? documentCameraViewpoint(doc.camera) : cameraFromParam(camera));
    if (typeof normalised === 'string') return reviewRejection(doc, 'save_viewpoint', 'VIS_CAMERA_INVALID', normalised, [], ['camera']);
    const refused = viewpointStateRejection(doc, 'save_viewpoint', state);
    if (refused !== null) return refused;
    const [id, review] = mintReviewId(reviewOf(doc), 'vp');
    const viewpoint: Viewpoint = {
      id,
      guid: nameUuid(`llull-viewpoint|${id}|${canonicalJson(normalised)}`),
      name,
      camera: normalised,
      ...viewpointStateFields(state),
    };
    const document = {
      ...doc,
      review: { ...review, viewpoints: { ...review.viewpoints, [id]: viewpoint }, viewpointOrder: [...review.viewpointOrder, id] },
    };
    const result = changed(document, `Saved viewpoint ${id} "${name}" (${normalised.projection}).`, [id]);
    return { ...result, data: { id, guid: viewpoint.guid, camera: normalised } };
  },
});

/** @affects nothing — read-only; data.viewpoints in creation order */
export const listViewpoints = defineCommand({
  name: 'list_viewpoints',
  description: 'List the saved review viewpoints in creation order: data.viewpoints [{ id, guid, name, camera }]. Read-only.',
  annotations: { readOnly: true },
  params: z.object({ limit: z.number().int().optional().describe('Return at most this many (default all).') }),
  run: (doc, { limit }): CommandResult => {
    const review = reviewOf(doc);
    const ids = review.viewpointOrder.slice(0, limit === undefined ? undefined : Math.max(0, limit));
    const viewpoints = ids.map((id) => review.viewpoints[id]).filter((viewpoint) => viewpoint !== undefined);
    return report(doc, `${review.viewpointOrder.length} viewpoint(s).`, { viewpoints });
  },
});

function withoutViewpoint(comment: ReviewComment): ReviewComment {
  return { id: comment.id, issueId: comment.issueId, text: comment.text, author: comment.author };
}

/**
 * @affects removes 1 viewpoint and its markups from doc.review (affected: [id]); comments that cited it lose the citation; metaHistory
 * @failure unknown id -> VIS_VIEWPOINT_NOT_FOUND; referenced by a walkthrough or an issue -> VIS_VIEWPOINT_IN_USE
 */
export const deleteViewpoint = defineCommand({
  name: 'delete_viewpoint',
  description:
    'Delete a saved viewpoint. Refused while a walkthrough or a review issue references it (VIS_VIEWPOINT_IN_USE: delete those first). ' +
    'Its markups are deleted with it. Unknown id: VIS_VIEWPOINT_NOT_FOUND. Does not add a feature step.',
  annotations: { metaHistory: true, destructive: true },
  params: z.object({ id: z.string().describe('Viewpoint id, e.g. "vp-1".') }),
  run: (doc, { id }): CommandResult => {
    const review = reviewOf(doc);
    if (review.viewpoints[id] === undefined)
      return reviewRejection(doc, 'delete_viewpoint', 'VIS_VIEWPOINT_NOT_FOUND', `no viewpoint '${id}'`, [id]);
    const users = [
      ...Object.values(review.walkthroughs)
        .filter((walkthrough) => walkthrough.keys.some((key) => key.viewpointId === id))
        .map((walkthrough) => walkthrough.id),
      ...Object.values(review.issues)
        .filter((issue) => issue.viewpointIds.includes(id))
        .map((issue) => issue.id),
    ];
    if (users.length > 0)
      return reviewRejection(doc, 'delete_viewpoint', 'VIS_VIEWPOINT_IN_USE', `viewpoint '${id}' is used by ${users.join(', ')}`, users);
    const viewpoints = Object.fromEntries(Object.entries(review.viewpoints).filter(([key]) => key !== id));
    const markups = Object.fromEntries(Object.entries(review.markups).filter(([, markup]) => markup.viewpointId !== id));
    const dropped = Object.keys(review.markups).length - Object.keys(markups).length;
    const comments = Object.fromEntries(
      Object.entries(review.comments).map(([key, comment]) => [key, comment.viewpointId === id ? withoutViewpoint(comment) : comment]),
    );
    const document = {
      ...doc,
      review: { ...review, viewpoints, markups, comments, viewpointOrder: review.viewpointOrder.filter((key) => key !== id) },
    };
    return changed(document, `Deleted viewpoint ${id}${dropped > 0 ? ` and its ${dropped} markup(s)` : ''}.`, [id]);
  },
});
