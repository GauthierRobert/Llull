/**
 * @layer ui/viewport/2d
 *
 * HTML HUD overlay: a small scale bar that shows the current real-world length
 * of a fixed screen segment, labeled with the document units.
 *
 * Positioning: bottom-right corner of the 2D viewport wrapper (absolute CSS).
 * Updates as the user zooms — `zoom` is the OrthographicCamera.zoom value.
 *
 * Purely presentational: reads document.units + displayPrecision and calls
 * scaleBarLength() for the math. No document mutation (R1).
 */

import { useMemo } from 'react';
import type { CadDocument } from '@core/model/types';
import { formatLength } from '@core/commands/units';
import { scaleBarLength } from './gridHelpers';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ScaleBarProps {
  /** OrthographicCamera.zoom value (pixels per world unit). */
  zoom: number;
  /** The live CAD document — used for units + displayPrecision. */
  document: CadDocument;
}

// ---------------------------------------------------------------------------
// ScaleBar
// ---------------------------------------------------------------------------

/**
 * Renders as an absolutely-positioned HTML element.
 * Must be placed OUTSIDE the r3f <Canvas> (HTML overlay).
 */
export function ScaleBar({ zoom, document }: ScaleBarProps): React.ReactElement {
  const { worldLength, pixelLength } = useMemo(() => scaleBarLength(zoom), [zoom]);

  const label = useMemo(() => formatLength(document, worldLength), [document, worldLength]);

  return (
    <div className="vp-scalebar vp-scalebar--2d">
      <span className="vp-scalebar__label">{label}</span>
      <div className="vp-scalebar__bar" style={{ width: Math.round(pixelLength) }}>
        <div className="vp-scalebar__tick vp-scalebar__tick--start" />
        <div className="vp-scalebar__tick vp-scalebar__tick--end" />
      </div>
    </div>
  );
}
