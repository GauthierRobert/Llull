/**
 * @layer server
 *
 * Pure helpers shared by the render_view enrichments: world→screen projection math,
 * orthographic frustum sizing, and SVG composition utilities.
 */

import type { RenderViewData } from '@core/commands/render';

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

// ---------------------------------------------------------------------------
// SVG composition utilities
// ---------------------------------------------------------------------------

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

/** Escape XML special characters for safe text embedding. */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Pure math helpers (duplicated from render.ts — server layer cannot import
// unexported internal helpers; these are short and exact copies)
// ---------------------------------------------------------------------------

type Vec3Mutable = [number, number, number];

export function sub3(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): Vec3Mutable {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function dot3(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross3(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): Vec3Mutable {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function len3(a: readonly [number, number, number]): number {
  return Math.sqrt(dot3(a, a));
}

export function normalize3(a: readonly [number, number, number]): Vec3Mutable {
  const l = len3(a);
  return l > 1e-10 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1];
}

export function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function toScreenCoords(
  u: number,
  v: number,
  orthoHalf: number,
  width: number,
  height: number,
): [number, number] {
  const margin = 0.9;
  const scaleX = ((width / 2) * margin) / orthoHalf;
  const scaleY = ((height / 2) * margin) / orthoHalf;
  const scale = Math.min(scaleX, scaleY);
  const sx = width / 2 + u * scale;
  const sy = height / 2 - v * scale;
  return [sx, sy];
}
