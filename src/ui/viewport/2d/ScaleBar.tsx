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

import { useStore } from '@ui/store';
import { scaleBarLength } from './gridHelpers';

interface ScaleBarProps {
  /** OrthographicCamera.zoom value (pixels per world unit). */
  zoom: number;
}

/**
 * Renders as an absolutely-positioned HTML element.
 * Must be placed OUTSIDE the r3f <Canvas> (HTML overlay).
 */
export function ScaleBar({ zoom }: ScaleBarProps): React.ReactElement {
  const units = useStore((s) => s.document.units);
  const displayPrecision = useStore((s) => s.document.displayPrecision);
  const { worldLength, pixelLength } = scaleBarLength(zoom);

  return (
    <div className="vp-scalebar vp-scalebar--2d">
      <span className="vp-scalebar__label">{`${worldLength.toFixed(displayPrecision)} ${units}`}</span>
      <div className="vp-scalebar__bar" style={{ width: Math.round(pixelLength) }}>
        <div className="vp-scalebar__tick vp-scalebar__tick--start" />
        <div className="vp-scalebar__tick vp-scalebar__tick--end" />
      </div>
    </div>
  );
}
