/** The review part of render_view's `data` (plant 09 VIS-M4): legend, applied profile / box / shading and the bounded visible entity list. Pure. */

import type { ReviewStyle, StyledScene } from './reviewStyle';
import type { RenderViewData } from './types';
import { MAX_LISTED_VISIBLE, renderFrustum, entityIdsInView } from './viewVisibility';

/** Fields of `RenderViewData` this milestone adds; `frustum: false` skips view culling (turntable strips have no single camera). */
export function reviewData(
  styled: StyledScene,
  style: ReviewStyle,
  base: Pick<RenderViewData, 'camera' | 'orthoHalf' | 'width' | 'height'>,
  frustum: boolean,
): Pick<
  RenderViewData,
  | 'visibleEntityIds'
  | 'visibleEntityCount'
  | 'frustumSkipped'
  | 'legend'
  | 'colourProfileId'
  | 'sectionBoxId'
  | 'shading'
  | 'hiddenEntityIds'
> {
  const built = frustum ? renderFrustum(base.camera, base.orthoHalf, base.width, base.height) : null;
  const planes = typeof built === 'string' ? null : built;
  const visible = entityIdsInView(styled.scene, style.box, planes);
  return {
    visibleEntityIds: visible.slice(0, MAX_LISTED_VISIBLE),
    visibleEntityCount: visible.length,
    legend: styled.legend,
    ...(typeof built === 'string' ? { frustumSkipped: built } : {}),
    shading: style.highlight === null ? 'flat' : 'review',
    hiddenEntityIds: styled.hiddenIds.slice(0, MAX_LISTED_VISIBLE),
    ...(style.profile === null ? {} : { colourProfileId: style.profile.id }),
    ...(style.box === null ? {} : { sectionBoxId: style.box.id }),
  };
}
