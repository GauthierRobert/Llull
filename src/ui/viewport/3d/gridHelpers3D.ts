/**
 * @layer ui/viewport/3d
 *
 * Pure helpers for the adaptive 3D perspective grid and the scale-bar HUD.
 *
 * All functions are deterministic and side-effect free so they can be
 * unit-tested without a DOM, Canvas, or three.js instance.
 *
 * Grid step model
 * ---------------
 * In a perspective viewport the meaningful zoom metric is the camera distance
 * from its orbit target ("distance" in our CameraState / OrbitControls).
 * We want major grid cells that produce a comfortable density — roughly 8–20
 * major lines across the viewport — snapped to a nice 1-2-5 × 10^n value.
 *
 * Reference sizes for a 1000 px wide viewport at 45° FOV:
 *   distance  1  → visible horizon ≈ 1.9 world units → step 0.1
 *   distance  10 → visible horizon ≈ 19  world units → step 1
 *   distance 100 → visible horizon ≈ 190 world units → step 10
 *
 * Screen-space calibration:
 *   One major grid step should span roughly MIN_STEP_FRACTION (4 %) of the
 *   viewport width, producing ~8–25 lines across the view at any zoom.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Target minimum fraction of the viewport width a major cell should span. */
const MIN_STEP_FRACTION = 0.04;   // ~8 major lines across a 100 % view

/** Nice step candidates per decade (the "1-2-5 sequence"). */
const NICE_STEPS = [1, 2, 5] as const;

// ---------------------------------------------------------------------------
// Core 1-2-5 step picker
// ---------------------------------------------------------------------------

/**
 * Snap a raw (non-round) world length up to the nearest value in the
 * 1-2-5 × 10^n sequence (the standard CAD/ruler progression).
 *
 * @param raw  Unrounded world length that represents the minimum desired step.
 * @returns    The smallest nice step ≥ raw.
 *
 * @pure deterministic
 * @invariant raw > 0
 * @invariant result > 0
 */
export function snapToNiceStep(raw: number): number {
  if (raw <= 0) return 1;

  const exp = Math.floor(Math.log10(raw));
  const decade = Math.pow(10, exp);

  for (const nice of NICE_STEPS) {
    const candidate = nice * decade;
    if (candidate >= raw - 1e-12) return candidate;
  }
  // 5 × decade < raw → step up to 10 × decade (= 1 × 10^(exp+1))
  return 10 * decade;
}

// ---------------------------------------------------------------------------
// Adaptive grid step for the 3D perspective viewport
// ---------------------------------------------------------------------------

/**
 * Compute the adaptive major grid cell size (in world units) for the 3D
 * perspective viewport given the camera distance from its orbit target.
 *
 * Algorithm:
 * 1. Estimate the world width visible near the camera target using a 45° FOV
 *    projection: visibleWidth ≈ 2 × distance × tan(fovHalf).
 * 2. Compute the "ideal" step as MIN_STEP_FRACTION × visibleWidth.
 * 3. Round that up with snapToNiceStep() so the label is always a clean number.
 * 4. In practice the 1-2-5 sequence keeps density in the comfortable 8–25 lines
 *    range without a second pass — the quantisation handles the upper bound.
 *
 * @param distance   Camera orbit distance (> 0).
 * @param fovDeg     Camera vertical FOV in degrees (default 45).
 * @returns          Grid major-cell size in world units (always a nice number).
 *
 * @pure deterministic
 * @invariant distance > 0
 * @invariant result > 0
 * @failure distance <= 0 → returns 1
 */
export function adaptiveGridStep3D(distance: number, fovDeg = 45): number {
  if (distance <= 0) return 1;

  const fovHalfRad = (fovDeg / 2) * (Math.PI / 180);
  // Approximate world width visible at the target plane (tan approximation).
  const visibleWidth = 2 * distance * Math.tan(fovHalfRad);

  // Minimum step size so we get at most 1 / MIN_STEP_FRACTION lines across.
  const idealStep = MIN_STEP_FRACTION * visibleWidth;

  return snapToNiceStep(idealStep);
}

// ---------------------------------------------------------------------------
// Grid fade distance
// ---------------------------------------------------------------------------

/**
 * Compute a sensible fade distance for drei's <Grid> so minor lines fade
 * smoothly before they become sub-pixel noise at the current zoom level.
 *
 * We want the grid to fade out at roughly 6 × camera distance — far enough
 * to fill the visible horizon but not so far that the GPU draws millions of
 * invisible lines at extreme zoom-out.
 *
 * @pure deterministic
 */
export function gridFadeDistance3D(distance: number): number {
  if (distance <= 0) return 100;
  return Math.max(distance * 6, 50);
}

// ---------------------------------------------------------------------------
// Scale-bar world length
// ---------------------------------------------------------------------------

/**
 * Choose a "nice" real-world length for the 3D scale-bar overlay.
 *
 * The scale bar should be between `targetFraction × 0.5` and
 * `targetFraction × 2` of the viewport width on screen, labeled with a
 * round number from the 1-2-5 sequence.
 *
 * Because the 3D viewport uses a perspective camera, we project from distance
 * using the same FOV approximation as adaptiveGridStep3D.  The returned
 * pixelLength is the pixel width the bar should be rendered at so it matches
 * the world length in screen space.
 *
 * @param distance       Camera orbit distance (> 0).
 * @param viewportWidthPx  Viewport width in pixels (used for projection).
 * @param fovDeg         Camera FOV in degrees (default 45).
 * @param targetPx       Target pixel width of the scale bar (default 80).
 *
 * @pure deterministic
 * @invariant distance > 0
 * @invariant result.worldLength > 0, result.pixelLength > 0
 */
export function scaleBarLength3D(
  distance: number,
  viewportWidthPx: number,
  fovDeg = 45,
  targetPx = 80,
): { worldLength: number; pixelLength: number } {
  if (distance <= 0 || viewportWidthPx <= 0) {
    return { worldLength: 1, pixelLength: targetPx };
  }

  const fovHalfRad = (fovDeg / 2) * (Math.PI / 180);
  // World width visible at the target plane.
  const visibleWidth = 2 * distance * Math.tan(fovHalfRad);

  // Pixels per world unit at the target plane.
  const pixelsPerWorldUnit = viewportWidthPx / visibleWidth;

  // Ideal world length for targetPx pixels.
  const idealWorld = targetPx / pixelsPerWorldUnit;

  // Snap up to the nearest nice step.
  const worldLength = snapToNiceStep(idealWorld * 0.5); // × 0.5 so we round up from half
  const pixelLength = worldLength * pixelsPerWorldUnit;

  return { worldLength, pixelLength };
}
