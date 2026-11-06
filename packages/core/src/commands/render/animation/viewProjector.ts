/** World -> pixel projector of an explicit render view (the one `viewpointView` builds), orthographic or perspective: the overlays of a moving camera use one per frame. */

import type { Vec3 } from '../../../model/vectors';
import { cameraBasis, makeProjector, projectPoint, type Projector } from '../camera';
import type { viewpointView } from '../viewSetup';

/** Smallest depth a perspective point is projected at: points behind the eye are pinned to it instead of mirrored. */
const NEAR = 1e-6;

/** The projector that places a world point where the raster draws it for `view`. @invariant matches `rasterScene` for orthographic and perspective cameras */
export function viewProjector(view: ReturnType<typeof viewpointView>, width: number, height: number): Projector {
  const { camera } = view;
  if (camera.fovDeg === undefined) return makeProjector(camera, view.orthoHalf, width, height);
  const basis = cameraBasis(camera);
  const focal = height / 2 / Math.tan((camera.fovDeg * Math.PI) / 360);
  return (p: Vec3) => {
    const [u, v, depth] = projectPoint(p, camera, basis);
    const scale = focal / Math.max(depth, NEAR);
    return [width / 2 + u * scale, height / 2 - v * scale];
  };
}
