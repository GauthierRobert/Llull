/**
 * @layer ui/viewport/3d
 *
 * HTML HUD overlay: a scale bar showing the current real-world length of a
 * fixed screen segment, labeled with the document's units.
 *
 * Positioning: bottom-right, left of the orientation gizmo (viewport.css).
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

  const label = useMemo(() => formatLength(document, worldLength), [document, worldLength]);

  return (
    <div className="vp-scalebar vp-scalebar--3d">
      <span className="vp-scalebar__label">{label}</span>
      <div className="vp-scalebar__bar" style={{ width: Math.round(Math.min(pixelLength, 200)) }}>
        <div className="vp-scalebar__tick vp-scalebar__tick--start" />
        <div className="vp-scalebar__tick vp-scalebar__tick--end" />
      </div>
    </div>
  );
}
