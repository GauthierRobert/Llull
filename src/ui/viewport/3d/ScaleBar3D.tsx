/**
 * @layer ui/viewport/3d
 *
 * HTML HUD overlay: a scale bar showing the current real-world length of a
 * fixed screen segment, labeled with the document's units.
 *
 * Positioning: bottom-right corner of the 3D viewport wrapper (absolute CSS).
 * Updates whenever camera distance or viewport size changes — the parent
 * passes `distance` and `viewportWidthPx` which are read from OrbitControls /
 * the Canvas size via a narrow ref-based approach (no per-frame setState).
 *
 * Purely presentational: reads document.units + displayPrecision and calls
 * scaleBarLength3D() for the math. No document mutation (R1).
 *
 * Visual language mirrors the 2D ScaleBar so both views feel consistent.
 */

import { useMemo } from 'react';
import type { CadDocument } from '@core/model/types';
import { formatLength } from '@core/commands/units';
import { scaleBarLength3D } from './gridHelpers3D';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ScaleBar3DProps {
  /** Camera orbit distance from target (world units). */
  distance: number;
  /** Current viewport width in pixels — used for scale projection. */
  viewportWidthPx: number;
  /** The live CAD document — used for units + displayPrecision. */
  document: CadDocument;
  /** Camera vertical FOV in degrees (default 45, must match the Canvas camera). */
  fovDeg?: number;
}

// ---------------------------------------------------------------------------
// ScaleBar3D
// ---------------------------------------------------------------------------

/**
 * Renders as an absolutely-positioned HTML element.
 * Must be placed OUTSIDE the r3f <Canvas> (HTML overlay, like ScaleBar in 2D).
 */
export function ScaleBar3D({
  distance,
  viewportWidthPx,
  document,
  fovDeg = 45,
}: ScaleBar3DProps): React.ReactElement {
  const { worldLength, pixelLength } = useMemo(
    () => scaleBarLength3D(distance, viewportWidthPx, fovDeg),
    [distance, viewportWidthPx, fovDeg],
  );

  const label = useMemo(
    () => formatLength(document, worldLength),
    [document, worldLength],
  );

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 16,
        right: 80, // offset left of the GizmoHelper (bottom-right, 72 px margin)
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: 3,
        pointerEvents: 'none',
        userSelect: 'none',
      }}
    >
      {/* Label */}
      <span
        style={{
          fontFamily: 'monospace',
          fontSize: 11,
          color: '#8a9bb5',
          letterSpacing: '0.04em',
        }}
      >
        {label}
      </span>

      {/* Bar */}
      <div
        style={{
          width: Math.round(Math.min(pixelLength, 200)), // cap at 200 px so it never overflows
          height: 3,
          background: 'linear-gradient(to right, #4a6080, #8aaccc)',
          borderRadius: 1,
          position: 'relative',
        }}
      >
        {/* Left tick */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: -3,
            width: 1,
            height: 9,
            background: '#8aaccc',
          }}
        />
        {/* Right tick */}
        <div
          style={{
            position: 'absolute',
            right: 0,
            top: -3,
            width: 1,
            height: 9,
            background: '#8aaccc',
          }}
        />
      </div>
    </div>
  );
}
