/** @layer ui/viewport/2d — which camera gestures stay enabled while a draw/modify tool is armed. */

interface CameraGestures {
  /** Left-drag pan. Off while a tool is armed: a drag must not be read as a click-placed point. */
  readonly enablePan: boolean;
  /** Wheel zoom. Always on, so the user can zoom in to place a point precisely mid-operation. */
  readonly enableZoom: boolean;
}

/** @pure */
export function cameraGestures(toolArmed: boolean): CameraGestures {
  return { enablePan: !toolArmed, enableZoom: true };
}
