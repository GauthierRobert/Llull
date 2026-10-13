/**
 * The one place the 2D view's plan-section depth is derived from the viewport clip plane: a
 * downward-kept horizontal plane (axis z, flipped keeps z <= -offset) is a plan section. Drawing,
 * picking, box selection and snapping all read it, so interaction sees exactly the drawn view.
 */

import { useViewportStore } from '@ui/store';

type ClipPlane = ReturnType<typeof useViewportStore.getState>['clipPlane'];

/** Cut depth of `clipPlane` for `technicalView`, or undefined when it is not a plan section. @pure */
function cutDepthOf({ enabled, axis, flipped, offset }: ClipPlane): number | undefined {
  return enabled && axis === 'z' && flipped ? -offset : undefined;
}

/** Reactive cut depth (rendering, memo keys). */
export function useSectionCutDepth(): number | undefined {
  return useViewportStore((s) => cutDepthOf(s.clipPlane));
}

/** Cut depth right now, for event-time reads (pick, box select). */
export function currentSectionCutDepth(): number | undefined {
  return cutDepthOf(useViewportStore.getState().clipPlane);
}
