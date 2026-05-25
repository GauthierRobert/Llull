/**
 * @layer ui/viewport/2d
 *
 * Pure helpers for the adaptive 2D ortho grid and the scale-bar HUD.
 *
 * All functions are deterministic and side-effect free so they can be
 * unit-tested without a DOM or canvas.
 *
 * Grid step model
 * ---------------
 * The ortho camera `zoom` value maps 1 world unit → `zoom` pixels.
 * We want minor grid cells that are always between MIN_CELL_PX and
 * MAX_CELL_PX pixels wide, snapped to a "nice" step (1, 2, 5 × 10^n).
 * We then pick a major-step multiplier (10×) so major lines are always
 * visible and clearly coarser.
 */

// ---------------------------------------------------------------------------
// Adaptive grid step
// ---------------------------------------------------------------------------

/** Minimum target pixel width for a minor grid cell. */
const MIN_CELL_PX = 20;

/** Maximum target pixel width for a minor grid cell (before stepping up). */
const MAX_CELL_PX = 120;

/** Nice step candidates per decade. */
const NICE_STEPS = [1, 2, 5] as const;

/**
 * Compute the adaptive minor grid step (in world units) given the current
 * orthographic camera zoom.
 *
 * `zoom` is the OrthographicCamera.zoom value: world units × zoom = pixels.
 * So 1 world unit = `zoom` pixels; 1 pixel = 1/zoom world units.
 *
 * The algorithm:
 * 1. Start from the "ideal" world step that maps to MIN_CELL_PX pixels.
 * 2. Round UP to the nearest nice step (1/2/5 × 10^n).
 * 3. If that step still fits within MAX_CELL_PX pixels, use it.
 *    Otherwise try the next nice step up.
 *
 * @pure deterministic
 * @invariant zoom > 0
 * @invariant result > 0
 */
export function adaptiveGridStep(zoom: number): number {
  if (zoom <= 0) return 1;

  // World units that correspond to MIN_CELL_PX pixels.
  const idealWorldStep = MIN_CELL_PX / zoom;

  // Express as a × 10^n where a ∈ [1, 10).
  const exp = Math.floor(Math.log10(idealWorldStep));
  const decade = Math.pow(10, exp);

  // Walk through nice steps [1, 2, 5] for this decade.
  for (const nice of NICE_STEPS) {
    const candidate = nice * decade;
    const candidatePx = candidate * zoom;
    if (candidatePx >= MIN_CELL_PX && candidatePx <= MAX_CELL_PX) {
      return candidate;
    }
    // If candidatePx > MAX_CELL_PX after the first that was >= MIN_CELL_PX,
    // take the previous step (one decade up).
    if (candidatePx > MAX_CELL_PX) {
      // The decade step itself was too big; fall back to 5 of the decade below.
      const smallerStep = 5 * Math.pow(10, exp - 1);
      return smallerStep > 0 ? smallerStep : candidate;
    }
  }

  // All nice steps for this decade were below MIN_CELL_PX — step up one decade.
  return 10 * decade;
}

/**
 * Compute the major grid step from a minor step.
 * Major lines are always 10× the minor step so the grid has two visible tiers.
 *
 * @pure deterministic
 */
export function majorGridStep(minorStep: number): number {
  return minorStep * 10;
}

export interface GridPatch {
  /** Total span of the grid patch in world units. */
  readonly extent: number;
  /** Number of cells across the patch — always even and ≥ 2. */
  readonly divisions: number;
}

/**
 * Compute a LOCAL grid patch (extent + cell count) for one grid tier.
 *
 * The grid must be a local mesh that follows the camera, NOT a fixed huge
 * extent. With a fixed extent, the cell count = extent/step explodes toward
 * infinity as you zoom in (step → 0), which is impossible to render. By sizing
 * the patch to `margin` × the visible viewport, the cell count stays BOUNDED at
 * every zoom — because `step` is pixel-bounded (adaptiveGridStep keeps cells
 * 20–120 px), divisions ≈ (viewportPx × margin) / cellPx, a near-constant.
 *
 * Divisions are forced EVEN so grid lines land on integer multiples of `step`
 * (the patch is centered on a step-snapped camera position), keeping lines
 * aligned to the world grid the snapping uses. `maxDivisions` is a hard safety
 * cap that is never reached for realistic viewport/zoom combinations.
 *
 * @param visibleWorld  Largest visible viewport dimension in world units (px / zoom).
 * @param step          Grid cell size in world units (minor or major).
 * @param margin        Patch size as a multiple of the viewport. Default 2.5.
 * @param maxDivisions  Hard cap on cell count (even). Default 1000.
 *
 * @pure deterministic
 * @invariant divisions even, 2 ≤ divisions ≤ maxDivisions
 * @failure step <= 0 or visibleWorld <= 0 -> minimal 2-cell patch
 */
export function localGridPatch(
  visibleWorld: number,
  step: number,
  margin = 2.5,
  maxDivisions = 1000,
): GridPatch {
  if (step <= 0 || visibleWorld <= 0) {
    const safeStep = step > 0 ? step : 1;
    return { extent: safeStep * 2, divisions: 2 };
  }
  let divisions = Math.ceil((visibleWorld * margin) / step);
  if (divisions % 2 !== 0) divisions += 1; // even → lines on world-step multiples
  if (divisions < 2) divisions = 2;
  if (divisions > maxDivisions) divisions = maxDivisions - (maxDivisions % 2);
  return { extent: divisions * step, divisions };
}

/**
 * Convert a screen-pixel distance into world units at the current ortho zoom.
 *
 * `zoom` is the OrthographicCamera.zoom value (world units × zoom = pixels), so
 * 1 pixel = 1/zoom world units. Used to keep snap tolerance and snap-glyph size
 * CONSTANT on screen across the full zoom range — without this, a fixed
 * world-unit tolerance/size becomes sub-pixel when zoomed out and huge when
 * zoomed in, defeating the infinite-grid snapping.
 *
 * @pure deterministic
 * @invariant zoom > 0
 * @invariant result > 0 for pixels > 0
 * @failure zoom <= 0 -> returns pixels unchanged (1:1 fallback)
 */
export function pixelsToWorld(pixels: number, zoom: number): number {
  if (zoom <= 0) return pixels;
  return pixels / zoom;
}

// ---------------------------------------------------------------------------
// Scale-bar length
// ---------------------------------------------------------------------------

/**
 * Choose a "nice" real-world length for the scale-bar overlay.
 *
 * The scale bar should be between `targetPx` × 0.5 and `targetPx` × 1.5 pixels
 * wide on screen and labeled with a round number. Prefers 1/2/5 × 10^n so the
 * label is always a clean integer or simple decimal.
 *
 * @param zoom         OrthographicCamera.zoom (pixels per world unit).
 * @param targetPx     Target pixel width of the scale bar (default 80).
 * @returns            { worldLength, pixelLength } — world units and the
 *                     corresponding pixel width to render.
 *
 * @pure deterministic
 * @invariant zoom > 0
 * @invariant worldLength > 0, pixelLength > 0
 */
export function scaleBarLength(
  zoom: number,
  targetPx = 80,
): { worldLength: number; pixelLength: number } {
  if (zoom <= 0) return { worldLength: 1, pixelLength: 1 };

  // World units visible across targetPx pixels.
  const idealWorld = targetPx / zoom;

  const exp = Math.floor(Math.log10(idealWorld));
  const decade = Math.pow(10, exp);

  // Find the smallest nice multiple that is ≥ half the ideal width.
  const candidates = [1, 2, 5, 10];
  for (const nice of candidates) {
    const candidate = nice * decade;
    const candidatePx = candidate * zoom;
    if (candidatePx >= targetPx * 0.5) {
      return { worldLength: candidate, pixelLength: candidatePx };
    }
  }

  // Fallback: 10× decade
  const fallback = 10 * decade;
  return { worldLength: fallback, pixelLength: fallback * zoom };
}

// ---------------------------------------------------------------------------
// Floating-origin 2D rebase helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when the 2D camera pan target [x, y] has drifted far enough
 * from the current render origin (stored as [x, y, 0]) to warrant a rebase.
 *
 * Mirrors `shouldRebase` from floatingOrigin.ts but works in 2D XY only
 * (Z is irrelevant for the ortho top-down view).
 *
 * @pure
 */
export function shouldRebase2D(
  cameraX: number,
  cameraY: number,
  originX: number,
  originY: number,
  threshold = 1e4,
): boolean {
  const dx = cameraX - originX;
  const dy = cameraY - originY;
  return dx * dx + dy * dy > threshold * threshold;
}

/**
 * Snap the 2D render origin to the camera XY position, rounded to gridSize
 * to avoid micro-rebases on every pan.
 *
 * Returns a full [x, y, z] triple (z=0) so it is compatible with the shared
 * `renderOrigin` store value.
 *
 * @pure
 */
export function snapOrigin2D(
  cameraX: number,
  cameraY: number,
  gridSize = 1e4,
): [number, number, number] {
  return [
    Math.round(cameraX / gridSize) * gridSize,
    Math.round(cameraY / gridSize) * gridSize,
    0,
  ];
}
