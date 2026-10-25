/** Reading, editing and applying saved viewpoints (plant 09 VIS §4): get_viewpoint, update_viewpoint, apply_viewpoint. metaHistory for the writers. */

import { boundsCenter } from '../../geometry/bounds';
import { normalizeViewpointCamera, viewpointDocumentCamera } from '../../geometry/viewpointCamera';
import type { DisplayModel } from '../../model/display';
import type { ReviewModel, Viewpoint } from '../../model/review';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { changed, noop, report } from '../noop';
import { displayOf } from '../display/displayModel';
import { computeSceneSnapshot } from '../inspect/scene';
import { reviewOf, reviewRejection } from './reviewModel';
import { cameraFromParam, viewpointCameraParam } from './viewpoints';
import { viewpointStateFields, viewpointStateParams, viewpointStateRejection, type ViewpointState } from './viewpointRefs';

/** @affects nothing — read-only; data = the viewpoint fields plus markups[] */
export const getViewpoint = defineCommand({
  name: 'get_viewpoint',
  description:
    'Read one saved viewpoint (vp-<n>): data { id, guid, name, camera, sectionBoxId?, colourProfileId?, visibility?, selection?, markups[] } ' +
    'with the redlines drawn on it (add_markup). Read-only. Error: VIS_VIEWPOINT_NOT_FOUND.',
  annotations: { readOnly: true },
  params: z.object({ id: z.string().describe('Viewpoint id, e.g. "vp-1".') }),
  run: (doc, { id }): CommandResult => {
    const review = reviewOf(doc);
    const viewpoint = review.viewpoints[id];
    if (viewpoint === undefined) return reviewRejection(doc, 'get_viewpoint', 'VIS_VIEWPOINT_NOT_FOUND', `no viewpoint '${id}'`, [id]);
    const markups = Object.values(review.markups).filter((markup) => markup.viewpointId === id);
    return report(doc, `Viewpoint ${id} "${viewpoint.name}" (${viewpoint.camera.projection}), ${markups.length} markup(s).`, {
      ...viewpoint,
      markups,
    });
  },
});

const clearable = <T extends z.ZodType>(schema: T): z.ZodOptional<z.ZodNullable<T>> => schema.nullable().optional();

/** `params` over `current`: null clears, undefined keeps. */
const patched = <T>(param: T | null | undefined, current: T | undefined): T | undefined =>
  param === null ? undefined : (param ?? current);

/**
 * @affects replaces fields of 1 viewpoint in doc.review (affected: [id]); guid and id are kept; metaHistory
 * @invariant a changed camera is re-normalised; null clears sectionBoxId / colourProfileId / visibility / selection
 * @failure unknown id -> VIS_VIEWPOINT_NOT_FOUND; invalid camera -> VIS_CAMERA_INVALID; dangling reference -> VIS_SECTION_BOX_NOT_FOUND / VIS_PROFILE_NOT_FOUND / VIS_ENTITY_NOT_FOUND; nothing to change -> no-op
 */
export const updateViewpoint = defineCommand({
  name: 'update_viewpoint',
  description:
    'Change a saved viewpoint (vp-<n>): rename it, replace its camera, or set / clear (null) its sectionBoxId, colourProfileId, visibility and selection. ' +
    'Omitted fields stay. The id and guid never change (BCF identity). Errors: VIS_VIEWPOINT_NOT_FOUND, VIS_CAMERA_INVALID, VIS_SECTION_BOX_NOT_FOUND, ' +
    'VIS_PROFILE_NOT_FOUND, VIS_ENTITY_NOT_FOUND. Does not add a feature step.',
  annotations: { metaHistory: true },
  params: z.object({
    id: z.string().describe('Viewpoint id, e.g. "vp-1".'),
    name: z.string().optional().describe('New name.'),
    camera: viewpointCameraParam.optional().describe('New camera (same form as save_viewpoint).'),
    sectionBoxId: clearable(viewpointStateParams.sectionBoxId.unwrap()).describe('Section box id to show, or null to clear.'),
    colourProfileId: clearable(viewpointStateParams.colourProfileId.unwrap()).describe('Colour profile id to show, or null to clear.'),
    visibility: clearable(viewpointStateParams.visibility.unwrap()).describe('BCF visibility, or null to clear.'),
    selection: clearable(viewpointStateParams.selection.unwrap()).describe('Selected entity ids, or null to clear.'),
  }),
  run: (doc, params): CommandResult => {
    const review = reviewOf(doc);
    const viewpoint = review.viewpoints[params.id];
    if (viewpoint === undefined)
      return reviewRejection(doc, 'update_viewpoint', 'VIS_VIEWPOINT_NOT_FOUND', `no viewpoint '${params.id}'`, [params.id], ['id']);
    const camera = params.camera === undefined ? viewpoint.camera : normalizeViewpointCamera(cameraFromParam(params.camera));
    if (typeof camera === 'string') return reviewRejection(doc, 'update_viewpoint', 'VIS_CAMERA_INVALID', camera, [], ['camera']);
    const incoming: ViewpointState = {
      sectionBoxId: params.sectionBoxId ?? undefined,
      colourProfileId: params.colourProfileId ?? undefined,
      visibility: params.visibility ?? undefined,
      selection: params.selection ?? undefined,
    };
    const refused = viewpointStateRejection(doc, 'update_viewpoint', incoming);
    if (refused !== null) return refused;
    const state: ViewpointState = {
      sectionBoxId: patched(params.sectionBoxId, viewpoint.sectionBoxId),
      colourProfileId: patched(params.colourProfileId, viewpoint.colourProfileId),
      visibility: patched(params.visibility, viewpoint.visibility),
      selection: patched(params.selection, viewpoint.selection),
    };
    const next: Viewpoint = {
      id: viewpoint.id,
      guid: viewpoint.guid,
      name: params.name ?? viewpoint.name,
      camera,
      ...viewpointStateFields(state),
    };
    if (JSON.stringify(next) === JSON.stringify(viewpoint))
      return noop(doc, `update_viewpoint: viewpoint '${params.id}' already has these values; no-op.`);
    const document = { ...doc, review: { ...review, viewpoints: { ...review.viewpoints, [next.id]: next } } };
    return changed(document, `Updated viewpoint ${next.id} "${next.name}".`, [next.id]);
  },
});

/**
 * @affects writes doc.camera; sets display.activeProfileId and review.activeSectionBoxId from the viewpoint (affected: []); metaHistory
 * @invariant the camera looks the way the viewpoint does (target = eye + direction · distance to the scene centre, else the current distance); the polar angle stays inside set_camera's limits
 * @failure unknown id -> VIS_VIEWPOINT_NOT_FOUND
 */
export const applyViewpoint = defineCommand({
  name: 'apply_viewpoint',
  description:
    'Go to a saved viewpoint (vp-<n>): sets the document camera (orbit target, azimuth, polar, distance) so the view looks the way the viewpoint does, makes its ' +
    'colour profile and section box the active ones when it has them, and with resetDisplay clears the active profile / section box it does not carry. The orbit ' +
    'target is the point on the view axis at the scene centre (else at the current distance). data { camera, activeProfileId, activeSectionBoxId }. ' +
    'The document camera is a perspective orbit camera: an orthographic viewpoint keeps its direction but loses its view height, and the roll of up is not kept (data.warnings VIS_VIEWPOINT_APPROXIMATED says so). ' +
    'Does not add a feature step. Error: VIS_VIEWPOINT_NOT_FOUND.',
  annotations: { metaHistory: true, idempotent: true },
  params: z.object({
    id: z.string().describe('Viewpoint id, e.g. "vp-1".'),
    resetDisplay: z
      .boolean()
      .optional()
      .describe('true: also clear the active colour profile / section box when the viewpoint carries none. Default false (camera only).'),
  }),
  run: (doc, { id, resetDisplay }): CommandResult => {
    const review = reviewOf(doc);
    const viewpoint = review.viewpoints[id];
    if (viewpoint === undefined) return reviewRejection(doc, 'apply_viewpoint', 'VIS_VIEWPOINT_NOT_FOUND', `no viewpoint '${id}'`, [id]);
    const bounds = computeSceneSnapshot(doc).bounds;
    const camera = viewpointDocumentCamera(viewpoint.camera, bounds === null ? null : boundsCenter(bounds), doc.camera.distance);
    const reset = resetDisplay === true;
    const sectionBoxId = viewpoint.sectionBoxId ?? (reset ? undefined : review.activeSectionBoxId);
    const nextReview: ReviewModel = { ...review };
    if (sectionBoxId === undefined) delete nextReview.activeSectionBoxId;
    else nextReview.activeSectionBoxId = sectionBoxId;
    const display = displayOf(doc);
    const profileId = viewpoint.colourProfileId ?? (reset ? undefined : display.activeProfileId);
    const nextDisplay: DisplayModel = { ...display };
    if (profileId === undefined) delete nextDisplay.activeProfileId;
    else nextDisplay.activeProfileId = profileId;
    const document = {
      ...doc,
      camera,
      review: nextReview,
      ...(doc.display === undefined && profileId === undefined ? {} : { display: nextDisplay }),
    };
    const result = changed(document, `Applied viewpoint ${id} "${viewpoint.name}" to the document camera.`, []);
    const warnings =
      viewpoint.camera.projection === 'orthographic'
        ? [
            {
              code: 'VIS_VIEWPOINT_APPROXIMATED',
              message: 'orthographic viewpoint applied as a perspective orbit camera (view height and roll are not kept)',
            },
          ]
        : [];
    return { ...result, data: { camera, activeProfileId: profileId ?? null, activeSectionBoxId: sectionBoxId ?? null, warnings } };
  },
});
