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
  const { worldLength, pixelLength } = useMemo(
    () => scaleBarLength(zoom),
    [zoom],
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
        right: 16,
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
          width: Math.round(pixelLength),
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
