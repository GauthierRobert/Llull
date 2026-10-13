// HTML HUD (outside the Canvas, bottom-right): real length of a fixed screen segment in document units.

import { useStore } from '@ui/store';
import { formatScaleBarLength, scaleBarLength } from './gridHelpers';

interface ScaleBarProps {
  /** Pixels per world unit. */
  zoom: number;
}

export function ScaleBar({ zoom }: ScaleBarProps): React.ReactElement {
  const units = useStore((s) => s.document.units);
  const { worldLength, pixelLength } = scaleBarLength(zoom);

  return (
    <div className="vp-scalebar vp-scalebar--2d">
      <span className="vp-scalebar__label">{`${formatScaleBarLength(worldLength)} ${units}`}</span>
      <div className="vp-scalebar__bar" style={{ width: Math.round(pixelLength) }}>
        <div className="vp-scalebar__tick vp-scalebar__tick--start" />
        <div className="vp-scalebar__tick vp-scalebar__tick--end" />
      </div>
    </div>
  );
}
