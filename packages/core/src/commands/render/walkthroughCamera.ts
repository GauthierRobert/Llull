/** The camera of a walkthrough at a time: shared by render_walkthrough and render_animation (VC-MOV-23: both give the same camera at the same t). */

import type { ViewpointCamera } from '../../model/review';
import { interpolateViewpointCamera, interpolateViewpointCameraSmooth } from '../../geometry/viewpointCamera';
import { clamp } from '../../lib/clamp';

export type CameraPath = 'linear' | 'smooth';

/**
 * Camera at time `t` (seconds) of a walkthrough whose key k lasts `seconds[k]`; `smooth` bends the eye path through the keys.
 * @invariant t ≤ 0 gives the first key, t beyond the total duration the last key
 */
export function walkthroughCameraAt(
  cameras: readonly ViewpointCamera[],
  seconds: readonly number[],
  t: number,
  path: CameraPath,
): ViewpointCamera {
  let start = 0;
  for (let k = 0; k + 1 < cameras.length; k += 1) {
    const span = seconds[k] ?? 0;
    const a = cameras[k];
    const b = cameras[k + 1];
    if (a !== undefined && b !== undefined && (t <= start + span || k + 2 === cameras.length)) {
      const u = clamp((t - start) / span, 0, 1);
      return path === 'smooth'
        ? interpolateViewpointCameraSmooth(cameras[k - 1], a, b, cameras[k + 2], u)
        : interpolateViewpointCamera(a, b, u);
    }
    start += span;
  }
  return cameras[0] as ViewpointCamera;
}
