/**
 * @layer ui/viewport/2d
 *
 * Screen-constant sizing for `point` markers. A document-unit cross is invisible in mm drawings
 * (0.1 mm in a 100 m survey), so the marker is scaled each frame to a fixed pixel half-extent.
 */

/** Marker half-arm length on screen, in CSS pixels. */
export const POINT_MARKER_HALF_PIXELS = 5;

type CameraProjection =
  | { readonly kind: 'orthographic'; readonly zoom: number }
  | {
      readonly kind: 'perspective';
      /** Vertical field of view in degrees. */
      readonly fovDegrees: number;
      /** Camera-to-marker distance in world units. */
      readonly distance: number;
      /** Canvas height in CSS pixels. */
      readonly viewportHeight: number;
    };

/** @pure World units spanned by `pixels` screen pixels at the marker; 1 when degenerate. */
export function worldUnitsForPixels(pixels: number, projection: CameraProjection): number {
  if (projection.kind === 'orthographic') {
    return projection.zoom > 0 ? pixels / projection.zoom : 1;
  }
  const { fovDegrees, distance, viewportHeight } = projection;
  if (viewportHeight <= 0 || distance <= 0) return 1;
  const worldHeight = 2 * distance * Math.tan((fovDegrees * Math.PI) / 360);
  return (pixels * worldHeight) / viewportHeight;
}
