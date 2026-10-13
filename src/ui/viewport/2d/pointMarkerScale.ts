// Screen-constant `point` markers: a document-unit cross vanishes in mm drawings, so it is scaled per frame to fixed px.

/** Half-arm, CSS px. */
export const POINT_MARKER_HALF_PIXELS = 5;

type CameraProjection =
  | { readonly kind: 'orthographic'; readonly zoom: number }
  | {
      readonly kind: 'perspective';
      /** Vertical FOV, degrees. */
      readonly fovDegrees: number;
      readonly distance: number;
      /** CSS px. */
      readonly viewportHeight: number;
    };

export function worldUnitsForPixels(pixels: number, projection: CameraProjection): number {
  if (projection.kind === 'orthographic') return projection.zoom > 0 ? pixels / projection.zoom : 1;
  const { fovDegrees, distance, viewportHeight } = projection;
  if (viewportHeight <= 0 || distance <= 0) return 1;
  const worldHeight = 2 * distance * Math.tan((fovDegrees * Math.PI) / 360);
  return (pixels * worldHeight) / viewportHeight;
}
