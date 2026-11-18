// Camera actions shared by shortcuts and one-click creation: gather params → dispatch `fit_view` (quiet, never its own undo step).

import { useStore } from '@ui/store';
import { isLocalMode } from '@ui/store/localMode';

/** Room left around the model when the app frames it by itself (fit_view's own default is tighter, for renders). */
export const AUTO_FRAME_PADDING = 1.7;

/** F: frames the whole model from the current viewing direction. */
export function zoomToFit(): void {
  useStore.getState().dispatch('fit_view', { direction: 'current', padding: AUTO_FRAME_PADDING }, { quiet: true, coalesce: true });
}

/** After the app itself added geometry: keeps it in view. Local mode only (online the camera is shared with every client). */
export function keepModelInView(): void {
  if (isLocalMode(useStore.getState())) zoomToFit();
}
