/** visible_entity_ids: which entities a viewpoint (or the whole model) shows, without rendering (plant 09 VIS-M4 §4). */

import { defineCommand, z } from '../schema';
import { report } from '../noop';
import { withExplodedPositions } from '../../geometry/explodedOffsets';
import { frustumPlanes, planCameraProblem, viewpointPlanCamera } from '../../geometry/renderPlanCamera';
import { cross3, len3 } from '../../lib/vec3';
import { reviewRejection } from '../review/reviewModel';
import { applyReviewStyle, resolveReviewStyle } from './reviewStyle';
import { entityIdsInView } from './viewVisibility';

/**
 * @affects nothing — read-only; document returned unchanged, affected:[]
 * @invariant stages: viewpoint visibility, profile hidden rules, section box (viewpoint / param / active), view frustum (viewpoint only); ids in document order
 * @failure unknown viewpoint / profile / section box -> VIS_VIEWPOINT_NOT_FOUND / VIS_PROFILE_NOT_FOUND / VIS_SECTION_BOX_NOT_FOUND, no-op
 */
export const visibleEntityIds = defineCommand({
  name: 'visible_entity_ids',
  annotations: { readOnly: true },
  description:
    'List the entities a view shows, without rendering: first viewpoint visibility (BCF default + exceptions) and the hidden rules of the colour profile, then the section box ' +
    '(an entity wholly outside it is dropped), then, when `viewpointId` is given, the view frustum of that camera at width x height. ' +
    'Colour profile and section box come from the parameters, else the viewpoint, else the active ones (same rules as render_view). ' +
    'Without `viewpointId` there is no view frustum (only visibility, hidden rules and the section box apply; data.frustum is false). Exploded views apply like render_view. Returns data { visibleEntityIds (first `limit`, document order), visibleEntityCount, hiddenEntityIds, entityCount, colourProfileId?, sectionBoxId?, frustum: boolean }. Does NOT modify the document.',
  params: z.object({
    viewpointId: z
      .string()
      .optional()
      .describe('Saved viewpoint (list_viewpoints): its camera gives the frustum, its visibility, profile and section box apply.'),
    colourProfileId: z
      .string()
      .optional()
      .describe("Profile whose hidden rules remove entities. Default: the viewpoint's, else the active profile."),
    sectionBoxId: z.string().optional().describe("Section box to test against. Default: the viewpoint's, else the active box."),
    width: z.number().int().min(64).max(2000).optional().describe('Picture width in pixels for the frustum aspect (default 1920).'),
    height: z.number().int().min(64).max(2000).optional().describe('Picture height in pixels for the frustum aspect (default 1080).'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(10000)
      .optional()
      .describe('Most ids listed in visibleEntityIds (default 1000); the count is always complete.'),
  }),
  run: (doc, params, ctx) => {
    const viewpoint = params.viewpointId === undefined ? undefined : doc.review?.viewpoints[params.viewpointId];
    if (params.viewpointId !== undefined && viewpoint === undefined)
      return reviewRejection(
        doc,
        'visible_entity_ids',
        'VIS_VIEWPOINT_NOT_FOUND',
        `no viewpoint '${params.viewpointId}'`,
        [],
        ['viewpointId'],
      );
    const resolved = resolveReviewStyle(doc, params);
    if ('code' in resolved) return reviewRejection(doc, 'visible_entity_ids', resolved.code, resolved.message, [], resolved.paths);
    const { style } = resolved;
    const styled = applyReviewStyle(withExplodedPositions(doc), style, ctx, undefined);
    let planes: ReturnType<typeof frustumPlanes> | null = null;
    if (viewpoint !== undefined) {
      const camera = viewpointPlanCamera(viewpoint.camera, params.width ?? 1920, params.height ?? 1080);
      const problem =
        planCameraProblem(camera) ?? (len3(cross3(camera.direction, camera.up)) < 1e-9 ? 'up is parallel to the viewing direction' : null);
      if (problem !== null)
        return reviewRejection(
          doc,
          'visible_entity_ids',
          'VIS_CAMERA_INVALID',
          `viewpoint '${viewpoint.id}': ${problem}`,
          [],
          ['viewpointId'],
        );
      planes = frustumPlanes(camera);
    }
    const visible = entityIdsInView(styled.scene, style.box, planes);
    const listed = visible.slice(0, params.limit ?? 1000);
    const data = {
      visibleEntityIds: listed,
      visibleEntityCount: visible.length,
      hiddenEntityIds: styled.hiddenIds.slice(0, 1000),
      entityCount: doc.order.length,
      frustum: planes !== null,
      ...(style.profile === null ? {} : { colourProfileId: style.profile.id }),
      ...(style.box === null ? {} : { sectionBoxId: style.box.id }),
    };
    const more = visible.length > listed.length ? ` (first ${listed.length} listed)` : '';
    return report(
      doc,
      `${visible.length} of ${doc.order.length} entities visible${more}; ${styled.hiddenIds.length} hidden by visibility / profile${style.box === null ? '' : `, section box ${style.box.id}`}${planes === null ? '' : ', view frustum applied'}.`,
      data,
    );
  },
});
