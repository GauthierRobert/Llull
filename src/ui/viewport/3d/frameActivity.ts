// Per-frame activity shared by the in-Canvas writers and the render rig (demand frameloop). Writers that move scene objects
// outside React (animation / dynamics playback, live previews) call markSceneMoved(); the render rig reads it to refresh
// shadows only when something moved. Plain module state: written and read inside useFrame, never React state.

let sceneMovedFrame = -1;
let frameCounter = 0;

/** Objects moved this frame (poses written imperatively): shadow maps / contact shadows are stale. */
export function markSceneMoved(): void {
  sceneMovedFrame = frameCounter;
}

/** True when markSceneMoved() was called since the last endFrame(). */
export function sceneMovedThisFrame(): boolean {
  return sceneMovedFrame === frameCounter;
}

/** Called once per rendered frame by the render rig, after it consumed the flags. */
export function endFrame(): void {
  frameCounter += 1;
}
