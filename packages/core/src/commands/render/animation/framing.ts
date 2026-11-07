/** The fixed camera of render_animation (FR-MOV-06, TR-MOV-06): framed once on the union of every frame's bounds and every trace point, identical in all frames. */

import type { Vec3 } from '../../../model/vectors';
import type { ViewpointCamera } from '../../../model/review';
import { boundsCenter, boundsCorners, boundsDiagonalRadius, boundsRadius, type Bounds } from '../../../geometry/bounds';
import { add3, dot3, normalize3, scale3, sub3 } from '../../../lib/vec3';
import { cameraBasis, cameraForView, type ViewName } from '../camera';

/** Share of the image the framed scene fills along its tighter axis. */
const FILL = 0.9;

/**
 * Orthographic camera looking at `bounds` along a named view (or `direction`, from the scene toward the camera), centred on the projected extent and scaled so
 * the whole of `bounds` fits `FILL` of the `width` × `height` image.
 * @invariant every corner of `bounds` projects inside the image
 */
export function framedCamera(view: ViewName, direction: Vec3 | undefined, bounds: Bounds, width: number, height: number): ViewpointCamera {
  const radius = boundsRadius(bounds);
  const framed = cameraForView(view, boundsCenter(bounds), radius, direction);
  const basis = cameraBasis(framed);
  const corners = boundsCorners(bounds);
  const spans = (axis: Vec3): [number, number] => {
    const along = corners.map((corner) => dot3(corner, axis));
    return [Math.min(...along), Math.max(...along)];
  };
  const [u0, u1] = spans(basis.right);
  const [v0, v1] = spans(basis.up);
  const centre = boundsCenter(bounds);
  const target = add3(
    centre,
    add3(scale3(basis.right, (u0 + u1) / 2 - dot3(centre, basis.right)), scale3(basis.up, (v0 + v1) / 2 - dot3(centre, basis.up))),
  );
  const pixelsPerUnit = Math.min((FILL * width) / Math.max(u1 - u0, 1e-9), (FILL * height) / Math.max(v1 - v0, 1e-9));
  const forward = normalize3(sub3(framed.target, framed.position));
  return {
    projection: 'orthographic',
    eye: sub3(target, scale3(forward, radius * 2.5)),
    direction: forward,
    up: basis.up,
    viewHeight: height / pixelsPerUnit,
  };
}

/**
 * Orthographic camera for an orbit: looks at the centre of `bounds` along a named view (or `direction`) and is scaled so the sphere around `bounds` fits `FILL`
 * of the tighter image axis, so the scene stays inside the picture whatever the turn angle.
 * @invariant every corner of `bounds` projects inside the image for every rotation of the camera about an axis through the centre of `bounds`
 */
export function orbitFramedCamera(
  view: ViewName,
  direction: Vec3 | undefined,
  bounds: Bounds,
  width: number,
  height: number,
): ViewpointCamera {
  const centre = boundsCenter(bounds);
  const sphere = Math.max(boundsDiagonalRadius(bounds), 1e-9);
  const framed = cameraForView(view, centre, boundsRadius(bounds), direction);
  const basis = cameraBasis(framed);
  const pixelsPerUnit = (FILL * Math.min(width, height)) / (2 * sphere);
  return {
    projection: 'orthographic',
    eye: sub3(centre, scale3(basis.fwd, sphere * 2.5)),
    direction: basis.fwd,
    up: basis.up,
    viewHeight: height / pixelsPerUnit,
  };
}
