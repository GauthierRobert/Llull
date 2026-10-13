// Adaptive 2D ortho grid + scale bar, pure. `zoom` = OrthographicCamera.zoom: 1 world unit = `zoom` px.
// Minor cells stay MIN_CELL_PX..MAX_CELL_PX wide on a nice 1/2/5×10^n step; major = 10× minor.

import { clamp } from '@lib/clamp';

const MIN_CELL_PX = 20;
const MAX_CELL_PX = 120;
const NICE_STEPS = [1, 2, 5] as const;

/** @invariant result > 0 */
export function adaptiveGridStep(zoom: number): number {
  if (zoom <= 0) return 1;
  const exp = Math.floor(Math.log10(MIN_CELL_PX / zoom));
  const decade = Math.pow(10, exp);
  for (const nice of NICE_STEPS) {
    const candidate = nice * decade;
    const candidatePx = candidate * zoom;
    if (candidatePx >= MIN_CELL_PX && candidatePx <= MAX_CELL_PX) return candidate;
    if (candidatePx > MAX_CELL_PX) {
      const smallerStep = 5 * Math.pow(10, exp - 1);
      return smallerStep > 0 ? smallerStep : candidate;
    }
  }
  return 10 * decade;
}

export function majorGridStep(minorStep: number): number {
  return minorStep * 10;
}

interface GridPatch {
  readonly extent: number;
  /** Always even and ≥ 2. */
  readonly divisions: number;
}

/**
 * Camera-following LOCAL grid patch of `margin` × the viewport: a fixed huge extent would explode the cell
 * count as step → 0, while a pixel-bounded step keeps divisions ≈ viewportPx × margin / cellPx bounded.
 * Even divisions keep lines on world-step multiples (the patch centers on a step-snapped camera), matching snapping.
 * @failure step <= 0 or visibleWorld <= 0 -> minimal 2-cell patch
 */
export function localGridPatch(visibleWorld: number, step: number, margin = 2.5, maxDivisions = 1000): GridPatch {
  if (step <= 0 || visibleWorld <= 0) {
    const safeStep = step > 0 ? step : 1;
    return { extent: safeStep * 2, divisions: 2 };
  }
  let divisions = Math.ceil((visibleWorld * margin) / step);
  if (divisions % 2 !== 0) divisions += 1;
  if (divisions < 2) divisions = 2;
  if (divisions > maxDivisions) divisions = maxDivisions - (maxDivisions % 2);
  return { extent: divisions * step, divisions };
}

/** Screen px → world units, so snap tolerance and glyph sizes stay constant on screen at any zoom. @failure zoom <= 0 -> pixels */
export function pixelsToWorld(pixels: number, zoom: number): number {
  return zoom <= 0 ? pixels : pixels / zoom;
}

/** As many decimals as the length needs (0.005 → "0.005", 20 → "20"); a fixed precision would show "0.00" zoomed in. */
export function formatScaleBarLength(worldLength: number): string {
  if (!Number.isFinite(worldLength) || worldLength <= 0) return '0';
  return worldLength.toFixed(clamp(-Math.floor(Math.log10(worldLength)), 0, 12));
}

/** Smallest 1/2/5/10×10^n length at least half `targetPx` wide on screen. */
export function scaleBarLength(zoom: number, targetPx = 80): { worldLength: number; pixelLength: number } {
  if (zoom <= 0) return { worldLength: 1, pixelLength: 1 };
  const decade = Math.pow(10, Math.floor(Math.log10(targetPx / zoom)));
  for (const nice of [1, 2, 5, 10]) {
    const candidatePx = nice * decade * zoom;
    if (candidatePx >= targetPx * 0.5) return { worldLength: nice * decade, pixelLength: candidatePx };
  }
  return { worldLength: 10 * decade, pixelLength: 10 * decade * zoom };
}
