/** @layer ui/viewport/2d — which camera gestures stay enabled while a draw/modify tool is armed. */

interface CameraGestures {
  /** Left-drag pan. Off while a tool is armed: a drag must not be read as a click-placed point. */
  readonly enablePan: boolean;
  /** Wheel zoom. Always on, so the user can zoom in to place a point precisely mid-operation. */
  readonly enableZoom: boolean;
}

/**
 * Static MapControls configuration of the 2D view: top-down (no rotation), screen-space pan,
 * wheel zoom toward the cursor (CAD behaviour) with a step that crosses large ranges quickly.
 */
export const MAP_CONTROLS_CONFIG = {
  enableRotate: false,
  screenSpacePanning: true,
  zoomToCursor: true,
  zoomSpeed: 1.6,
  panSpeed: 1.0,
} as const;

/** @pure */
export function cameraGestures(toolArmed: boolean): CameraGestures {
  return { enablePan: !toolArmed, enableZoom: true };
}
