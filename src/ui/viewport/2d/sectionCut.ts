// The 2D plan-section depth from the clip plane (axis z, flipped keeps z <= -offset): drawing, picking, box select and
// snapping all read it, so interaction sees exactly the drawn view.

import { useViewportStore } from '@ui/store';

type ClipPlane = ReturnType<typeof useViewportStore.getState>['clipPlane'];

/** undefined when not a plan section. @pure */
function cutDepthOf({ enabled, axis, flipped, offset }: ClipPlane): number | undefined {
  return enabled && axis === 'z' && flipped ? -offset : undefined;
}

/** Reactive (rendering, memo keys). */
export function useSectionCutDepth(): number | undefined {
  return useViewportStore((s) => cutDepthOf(s.clipPlane));
}

/** Event-time reads (pick, box select). */
export function currentSectionCutDepth(): number | undefined {
  return cutDepthOf(useViewportStore.getState().clipPlane);
}
