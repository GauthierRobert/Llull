import type { RenderViewData } from '@core/commands/renderTypes';
import { toScreenCoords } from '@core/commands/renderCamera';
import { cross3, dot3, normalize3, sub3 } from '@lib/vec3';

/**
 * Compute the orthoHalf value used for projection, matching appendDimensionLabels.
 * This is the half-width of the orthographic frustum in world units.
 */
export function computeOrthoHalf(data: RenderViewData): number {
  const bounds = data.bounds;
  if (!bounds) return 1;
  const dx = bounds.max[0] - bounds.min[0];
  const dy = bounds.max[1] - bounds.min[1];
  const dz = bounds.max[2] - bounds.min[2];
  const radius = Math.max(dx, dy, dz) / 2 + 1e-3;
  return (radius < 0.1 ? 1 : radius) * 1.2 * 1.2;
}

/**
 * Extract the inner content of an SVG string (strips outer `<svg ...>` and `</svg>` tags).
 * Returns the raw inner XML string.
 */
export function extractSvgInner(svgString: string): string {
  const openEnd = svgString.indexOf('>');
  if (openEnd === -1) return svgString;
  const closeStart = svgString.lastIndexOf('</svg>');
  if (closeStart === -1) return svgString.substring(openEnd + 1);
  return svgString.substring(openEnd + 1, closeStart);
}

/**
 * World→screen projector for an orthographic render camera (basis re-derived from the camera).
 * @pure
 */
export function makeProjector(
  camera: RenderViewData['camera'],
  orthoHalf: number,
  width: number,
  height: number,
): (p: [number, number, number]) => [number, number] {
  const fwd = normalize3(sub3(camera.target, camera.position));
  const right = normalize3(cross3(fwd, camera.up));
  const up = normalize3(cross3(right, fwd));
  return (p) => {
    const offset = sub3(p, camera.position);
    return toScreenCoords(dot3(offset, right), dot3(offset, up), orthoHalf, width, height);
  };
}
